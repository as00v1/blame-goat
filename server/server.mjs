/**
 * BlameGoat 本地服务 —— 零 npm 依赖，只用 node: 内置模块
 *
 * 作用：
 *   1. 托管界面（web/）
 *   2. 暴露 REST API，把 LCU + 数据整理 + DeepSeek 判定串起来
 *   3. SSE 推送：客户端阶段变化 / 战报生成
 *
 * 启动：node server/server.mjs   或双击 start.bat
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ROOT 从 service.mjs 拿（它转出的是 env 里同一个），这里别重复引入 —— 重复声明会直接编译失败
import {
  IS_SEA, CODE_ROOT, WEB_DIR, DATA_DIR, DATA_DIR_NOTE, readWebAsset, bootstrapDataDir,
} from '../src/env.mjs';
import {
  ROOT, loadConfig, saveConfig, analyzeFromEog, analyzeLive, analyzeLatestMatch, analyzeMatch,
  listMatches, saveReport,
  listReports, loadReport, createWatcher, loadSampleBundle, GAMEDATA_FILE,
  setViewing, resolveViewing, accountList, accountName, loadAccounts, clearCurrent, accountCounts,
  readMatchView, searchSummoner, summonerMatches, rosterState,
  rememberSearch, listSearchHistory, clearSearchHistory,
} from './service.mjs';
import { selfTest, readConnection, lcuRequestBinary } from '../src/lcu/client.mjs';
import { loadGameData } from '../src/lcu/gamedata.mjs';

// 打包态首次运行：把 exe 里带的种子数据解到 exe 同级的 data/ 下
// （英雄表 / 出装符文表 —— 客户端没开时靠它兜底）。开发态直接返回空数组。
const seeded = bootstrapDataDir();
let cfg = loadConfig();

/* ────────────────── 本机可信边界 ──────────────────
   这个服务是给**本机界面**用的，但浏览器里的任意网页都能往 127.0.0.1 发请求：
   原先响应一律带 `Access-Control-Allow-Origin: *`，于是随便一个页面就能跨域读走
   战绩 / 名录（含还原后的真实昵称），还能 POST 改配置、关监视器、反复触发判定 ——
   那是一次真金白银的模型调用。再叠上 DNS rebinding（攻击者域名解析到 127.0.0.1，
   Host 就变成他的域名），同源策略等于没有。

   三道闸，缺一不可：
     ① Host 必须是本机回环      —— 挡 DNS rebinding
     ② Origin 只回显白名单      —— 挡普通跨域页面（拿不到 CORS 许可，浏览器自己拦）
     ③ /api/* 要会话令牌        —— 即便前两道被绕过（比如 file:// 的 null origin），
                                   没有令牌也读不到东西。令牌随首屏 HTML 下发，
                                   跨域页面读不到同源 HTML，也就拿不到令牌。
   令牌每次启动随机 —— 服务重启后旧令牌立刻失效，且不会有任何一份配置文件里存着它。 */

const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');

/** 只认回环地址（含 IPv6），端口任意 */
const TRUSTED_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * 内容安全策略。
 * 界面大量使用内联 style 与 onerror 之类的内联属性（见 web/app.js 的图标占位），
 * 所以样式与脚本都得开 'unsafe-inline' —— 这一条拦的是**外链注入**与数据外送，
 * 不是内联写法。
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data:",
].join('; ');

/** 定长比较，别让令牌比对时间随猜对的长度变化（本地服务也按规矩来） */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); } catch { return false; }
}

function hostTrusted(req) {
  return TRUSTED_HOST_RE.test(String(req.headers.host || '').trim());
}

/**
 * 该不该给这个请求回 CORS 许可。
 * @returns {string|null} 要回显的 origin；null = 不回显（浏览器会拦下响应）
 */
function corsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const port = String(req.headers.host || '').split(':').pop();
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  return allowed.includes(origin) ? origin : null;
}

/**
 * 只有这两个端点允许「令牌走查询串」—— 它们是界面上唯二改不了请求头的地方：
 * SSE 由 EventSource 发起、英雄图标是 `<img src>`，两者都只能把参数拼进 URL。
 * 其余端点一律只认请求头。
 *
 * 为什么要收窄：URL 里的凭据会进浏览器历史与缓存键，还会顺着 Referer 往外飘。
 * 能放在头里就不该出现在地址栏能看见的地方 —— 白名单之外留这个口子没有收益。
 */
const QUERY_TOKEN_PATHS = new Set(['/api/events', '/api/asset']);

function tokenOk(req, url) {
  if (tokenEquals(req.headers['x-bbx-token'], SESSION_TOKEN)) return true;
  if (!QUERY_TOKEN_PATHS.has(url?.pathname)) return false;
  return tokenEquals(url?.searchParams?.get('token'), SESSION_TOKEN);
}

/**
 * 两个通用安全响应头。
 * - nosniff：不让浏览器按内容瞎猜 MIME（把 .png 猜成 HTML 就能执行脚本）
 * - no-referrer：界面地址里可能带着令牌（?token= 那两个端点），别让它顺着 Referer 出去
 */
const SAFE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/* ────────────────── SSE 广播 ────────────────── */

const sseClients = new Set();

function broadcast(obj) {
  const chunk = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(chunk); } catch { sseClients.delete(res); }
  }
}

/**
 * 判定过程 → SSE（type: 'judging'）。
 *
 * 判定是十几秒起步的长活，界面那边只有一个「等请求回来」的 Promise ——
 * 不推过程，用户看到的就是一段假动画，分不清「模型在写」和「已经卡死」。
 * 流式之后这里每 250ms 左右来一条：阶段 / 已用毫秒 / 已输出字数。
 *
 * 没带 gameId：读取上一局、演示一局这些场景在调用时还不知道是哪一局，
 * 界面也不按局过滤（同一时刻只会有一个判定在跑）。
 */
function judgeProgress(p) {
  broadcast({ type: 'judging', ...p, at: Date.now() });
}

const watcher = createWatcher({
  intervalMs: 5000,
  // 自动判定那条路也要推过程（赛后自动分析打开时才走得到）
  getOptions: () => ({ apiKey: cfg.apiKey, tone: cfg.tone, params: cfg.params, onProgress: judgeProgress }),
  // 赛后是否自动判定 —— 默认关，设置页可开（见 service.mjs 的 noticeNewGame 注释）
  shouldAutoAnalyze: () => cfg.autoAnalyze === true,
  onEvent: (ev) => {
    if (ev.type === 'phase') console.log(`[watch] 阶段变化 → ${ev.phase}`);
    if (ev.type === 'client') {
      console.log(`[watch] 客户端${ev.online ? '已连接' : '已断开'}`);
      // 断开时把「当前登录」清掉、只留 last —— 界面据此退回「最后一次登录的账号」
      if (!ev.online) clearCurrent();
    }
    if (ev.type === 'analyzing') console.log(`[watch] 检测到对局结束，开始判定…`);
    if (ev.type === 'newgame') console.log(`[watch] 检测到新对局 ${ev.gameId} —— 已登记，等你在界面上点开`);
    if (ev.type === 'report') console.log(`[watch] 战报已生成（来源 ${ev.report.meta.source}）`);
    if (ev.type === 'error') console.log(`[watch] 判定失败：${ev.message}`);
    broadcast({ ...ev, at: Date.now() });
  },
});

/* ────────────────── 工具 ────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(req, res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SAFE_HEADERS,
  };
  // 跨域许可只回显可信 origin。原来的 `*` 等于把本机接口向整个互联网开放 ——
  // 不给（null）时浏览器自己会把响应挡下来，这正是我们要的。
  const acao = corsOrigin(req);
  if (acao) headers['Access-Control-Allow-Origin'] = acao;
  headers.Vary = 'Origin';
  res.writeHead(code, headers);
  res.end(body);
}

/**
 * 读请求体 —— 必须显式声明 `Content-Type: application/json`。
 *
 * 为什么卡这一条：浏览器能把 POST 伪装成「简单请求」（表单的
 * text/plain / application/x-www-form-urlencoded），那种请求**不触发预检**，
 * 于是跨域页面可以直接打到 /api/config、/api/watch、/api/analyze 这些写入口。
 * 强制 JSON 之后，非 JSON 的写请求都必须先过预检，而预检不带令牌，也就进不来。
 */
function readBody(req, limit = 1024 * 1024) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    return Promise.reject(Object.assign(new Error('Content-Type 必须是 application/json'), { status: 415 }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  // 界面文件在打包态藏于 exe 内、开发态躺在磁盘上，由 readWebAsset 一处兜住。
  // 防目录穿越也顺带简化了：不合法 / 不存在一律读不到 → 404，
  // 不存在「拼出去读到别处」的路径。
  if (rel.includes('..')) return sendJson(req, res, 403, { error: 'forbidden' });

  let buf = readWebAsset(rel);
  if (!buf) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 ' + rel);
  }
  // 首页直接把版本号写进页脚：JS 那边还会去 /api/status 拿一次（顺带取升级记录），
  // 这里先垫一份，脚本没跑完时页脚也不至于空着。离线 file:// 直开时保持占位 v—。
  if (rel === 'index.html') {
    let html = buf.toString('utf8');
    if (APP_VERSION) html = html.replace('id="verText">v—<', `id="verText">v${APP_VERSION}<`);
    // 会话令牌随首屏下发 —— 同源页面才读得到，跨域页面读不到这行 HTML，
    // 于是它即便能发请求也过不了 /api/* 那道令牌检查。
    html = html.replace('<head>', `<head>\n<meta name="bbx-token" content="${SESSION_TOKEN}">`);
    buf = Buffer.from(html, 'utf8');
  }
  const isHtml = path.extname(rel).toLowerCase() === '.html';
  const headers = {
    'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
    ...SAFE_HEADERS,
  };
  // 页面自己带一份 CSP（index.html 里有等价的 meta）——
  // 服务端这份是兜底：万一哪天页面被改成从别处拼出来，约束还在。
  if (isHtml) headers['Content-Security-Policy'] = CSP;
  res.writeHead(200, headers);
  res.end(buf);
}

/* ────────────────── 版本与升级记录 ────────────────── */

/**
 * 客户端版本：读随包的那份 package.json。
 * 桌面客户端里它在 resources/app/package.json，开发态就是仓库根那份 ——
 * 包一升级它就跟着变，界面页脚显示的正是这个，升级完一眼能看出版本号换了。
 */
const APP_VERSION = (() => {
  try {
    const file = path.join(CODE_ROOT || ROOT, 'package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || null;
  } catch {
    return null;
  }
})();

/**
 * 最近一次升级：读 data/update.log 的最后一条「升级完成」。
 * 这是升级器对 data 唯一的写操作（一行文本），所以拿它当升级凭证最合适 ——
 * 界面据此在页脚提示「刚刚升级到 vX」，用户不必自己翻日志去找有没有升成功。
 */
function lastUpdate() {
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, 'update.log'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(\S+)\s+升级完成\D*([\d.]+)/);
      if (m) return { version: m[2], at: m[1] };
    }
  } catch { /* 没日志 = 还没升过级，正常 */ }
  return null;
}

/* ────────────────── 路由 ────────────────── */

async function handleApi(req, res, url) {
  const p = url.pathname;

  // 状态：客户端 + Key + 监视器
  if (p === '/api/status' && req.method === 'GET') {
    const acc = loadAccounts();
    return sendJson(req, res, 200, {
      server: { ok: true, node: process.version, uptimeSec: Math.round(process.uptime()) },
      // 页脚要显示的版本号与最近一次升级记录
      app: { version: APP_VERSION, channel: 'desktop', lastUpdate: lastUpdate() },
      ai: { hasKey: !!cfg.apiKey, keySource: cfg.keySource, tone: cfg.tone, autoAnalyze: cfg.autoAnalyze === true, configFile: cfg.configFile },
      watcher: watcher.state,
      account: {
        current: acc.current,
        last: acc.last,
        viewing: resolveViewing(null),
        currentName: accountName(acc.current),
        lastName: accountName(acc.last),
      },
      // 排障用：界面从哪来、数据落在哪 —— 打包之后这两处最容易让人找不着北
      webDir: WEB_DIR || '（内嵌在 exe 内，磁盘上没有 web/ 目录）',
      dataDir: DATA_DIR,
    });
  }

  // 本机账号清单 / 切换查看哪个账号
  if (p === '/api/accounts' && req.method === 'GET') {
    const { list, current, last } = accountList({ includeAll: true });
    const { counts, analyzed, unowned } = accountCounts();
    const withCount = list.map((a) => (a.virtual
      ? { ...a, count: null, analyzedCount: null }
      : { ...a, count: counts[a.key] || 0, analyzedCount: analyzed[a.key] || 0 }));
    // 认不出主人的局（早期抓的数据）单独给一档 —— 别让它们凭空消失
    if (unowned > 0) withCount.push({ key: 'unowned', name: '未归属', virtual: true, count: unowned, analyzedCount: 0 });
    return sendJson(req, res, 200, {
      ok: true,
      accounts: withCount,
      current,
      last,
      viewing: resolveViewing(null),
      currentName: accountName(current),
      lastName: accountName(last),
    });
  }

  if (p === '/api/accounts' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.key) return sendJson(req, res, 400, { ok: false, error: '缺少 key' });
    setViewing(body.key);
    const v = resolveViewing(null);
    return sendJson(req, res, 200, { ok: true, viewing: v, viewingName: accountName(v) });
  }

  // LCU 自检
  if (p === '/api/selftest' && req.method === 'GET') {
    return sendJson(req, res, 200, await selfTest());
  }

  // 英雄图标等 LCU 资源代理 —— 让界面直接用上本地客户端的真实素材
  // 白名单前缀，防止被用来读客户端任意文件
  if (p === '/api/asset' && req.method === 'GET') {
    const target = url.searchParams.get('p') || '';
    if (!target.startsWith('/lol-game-data/assets/')) {
      return sendJson(req, res, 403, { ok: false, error: '仅允许 /lol-game-data/assets/ 下的资源' });
    }
    const { conn } = readConnection();
    if (!conn) return sendJson(req, res, 503, { ok: false, error: '客户端未运行' });
    try {
      const { buffer, contentType } = await lcuRequestBinary(conn, target);
      const headers = {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        // private：这份资源是「本机客户端缓存里的素材」，只该落在**当前用户**的缓存里。
        // 写成 public 等于允许共享缓存（公司代理、同一台机器的别的上下文）也留一份。
        'Cache-Control': 'private, max-age=86400',
        ...SAFE_HEADERS,
      };
      const acao = corsOrigin(req);
      if (acao) headers['Access-Control-Allow-Origin'] = acao;
      res.writeHead(200, headers);
      return res.end(buffer);
    } catch (e) {
      return sendJson(req, res, 404, { ok: false, error: e.message });
    }
  }

  // 判定
  if (p === '/api/analyze' && req.method === 'POST') {
    const body = await readBody(req);
    const tone = body.tone || cfg.tone;
    const source = body.source || 'mock';

    // mock：用真机抓取的脱敏样例跑全链路（无需客户端、无需 Key）
    // 样例含 eog + match-detail + timeline，所以时间轴与 participantId 桥接都走真路径
    if (source === 'mock') {
      const sample = loadSampleBundle();
      if (!sample.eog) return sendJson(req, res, 500, { ok: false, error: '离线样例缺失，请先跑 tools/capture-to-sample.mjs' });
      const report = await analyzeFromEog(sample.eog, {
        tone, apiKey: cfg.apiKey, params: cfg.params,
        source: 'mock',
        matchDetail: sample.matchDetail, timeline: sample.timeline, session: sample.session,
        championMap: sample.champions,
        // 样例包里没有装备 / 符文原始表 —— 直接用本地播种的那份（tools/seed-gamedata.mjs 产出）
        gameData: await loadGameData(null, { cacheFile: GAMEDATA_FILE }).catch(() => null),
        logger: (m) => console.log('[judge] ' + m),
        onProgress: judgeProgress,
      });
      return sendJson(req, res, 200, { ok: true, report });
    }

    // live：从本机客户端拉真实数据（EOG 优先，拿不到自动退到最近一局对局记录）
    try {
      const report = await analyzeLive({
        tone, apiKey: cfg.apiKey, params: cfg.params,
        force: !!body.force,
        logger: (m) => console.log('[judge] ' + m),
        onProgress: judgeProgress,
      });
      // 缓存命中时盘里已有这份战报，不再重复写盘（也不重复烧 token）
      const file = report?.meta?.savedFile
        ? path.join(ROOT, 'data', 'reports', report.meta.savedFile)
        : (report?.meta?.fromCache ? null : saveReport(report));
      return sendJson(req, res, 200, {
        ok: true, report,
        fromCache: !!report?.meta?.fromCache,
        saved: file ? path.basename(file) : null,
      });
    } catch (e) {
      return sendJson(req, res, 200, { ok: false, code: e.code || 'ANALYZE_FAILED', error: e.message });
    }
  }

  // 显式走「最近一局对局记录」——打完永久可查的那条路
  if (p === '/api/analyze-latest' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const report = await analyzeLatestMatch({
        tone: body.tone || cfg.tone, apiKey: cfg.apiKey, params: cfg.params,
        force: !!body.force,
        logger: (m) => console.log('[judge] ' + m),
        onProgress: judgeProgress,
      });
      const file = report?.meta?.savedFile
        ? path.join(ROOT, 'data', 'reports', report.meta.savedFile)
        : (report?.meta?.fromCache ? null : saveReport(report));
      return sendJson(req, res, 200, {
        ok: true, report,
        fromCache: !!report?.meta?.fromCache,
        saved: file ? path.basename(file) : null,
      });
    } catch (e) {
      return sendJson(req, res, 200, { ok: false, code: e.code || 'ANALYZE_FAILED', error: e.message });
    }
  }

  // 战绩列表 —— 所有已知对局（LCU 窗口 ∪ 已落盘战报 ∪ 本地累积索引）
  // ?account=<puuid|all|unowned> 不传 = 看当前查看的账号
  if (p === '/api/matches' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const refresh = url.searchParams.get('refresh') !== '0';
    const account = url.searchParams.get('account') || null;
    try {
      const data = await listMatches({ limit, refresh, account });
      return sendJson(req, res, 200, { ok: true, ...data });
    } catch (e) {
      return sendJson(req, res, 200, { ok: false, code: e.code || 'LIST_FAILED', error: e.message });
    }
  }

  // 分析指定的某一局（战绩列表点进来的）
  if (p === '/api/analyze-match' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const report = await analyzeMatch(body.gameId, {
        tone: body.tone || cfg.tone, apiKey: cfg.apiKey, params: cfg.params,
        force: !!body.force,
        // v1.2.7：判「别人的局」时以谁为视角（查某人 → 判定他的某一局）。
        // 不给的话我不在局里 → 10 人会全归敌方，报告没法看。
        perspectivePuuid: body.perspective || null,
        logger: (m) => console.log('[judge] ' + m),
        onProgress: judgeProgress,
      });
      return sendJson(req, res, 200, {
        ok: true, report,
        fromCache: !!report?.meta?.fromCache,
        saved: report?.meta?.savedFile || null,
      });
    } catch (e) {
      return sendJson(req, res, 200, { ok: false, code: e.code || 'ANALYZE_FAILED', error: e.message });
    }
  }

  // 对局详情 —— 点列表行的第一站：只读数据，**不调模型**
  // 盘里已有战报就直接回放，没有才去客户端拉原始数据（result 留空，等用户决定要不要判）
  if (p === '/api/match-detail' && req.method === 'GET') {
    const gameId = url.searchParams.get('gameId');
    const perspective = url.searchParams.get('perspective') || null;
    try {
      const view = await readMatchView(gameId, { perspectivePuuid: perspective });
      // 老战报少了「我方阵营」，读的时候顺手补正了 —— 值得留一行，方便日后查
      if (view.perspectiveHealed) console.log(`[视角] ${view.gameId} 原本没认出我方阵营，已按归属账号补正`);
      return sendJson(req, res, 200, { ok: true, ...view });
    } catch (e) {
      return sendJson(req, res, 200, { ok: false, code: e.code || 'DETAIL_FAILED', error: e.message });
    }
  }

  // 召唤师名录概况 —— 界面用它说明「本机认识多少人」
  if (p === '/api/roster' && req.method === 'GET') {
    try { return sendJson(req, res, 200, { ok: true, ...rosterState() }); }
    catch (e) { return sendJson(req, res, 200, { ok: false, error: e.message }); }
  }

  // 按昵称找人 —— 只在本机名录里找（客户端本身不支持按名字查人，见 service.mjs 注释）
  if (p === '/api/summoner/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    try {
      return sendJson(req, res, 200, {
        ok: true, query: q,
        hits: searchSummoner(q),
        roster: rosterState(),
        // 最近搜过谁 —— 界面在搜索框下面列出来，下次直接点
        history: listSearchHistory(Number(url.searchParams.get('historyLimit')) || 8),
      });
    } catch (e) {
      return sendJson(req, res, 200, { ok: false, code: 'SEARCH_FAILED', error: e.message });
    }
  }

  // 搜索历史：只读一份供界面渲染 / 清空；POST = 记一笔（进查询视图时前端调）
  if (p === '/api/search-history' && req.method === 'GET') {
    return sendJson(req, res, 200, { ok: true, items: listSearchHistory(30) });
  }
  if (p === '/api/search-history' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return sendJson(req, res, 200, { ok: true, items: rememberSearch(body) });
  }
  if (p === '/api/search-history' && req.method === 'DELETE') {
    return sendJson(req, res, 200, { ok: true, items: clearSearchHistory() });
  }

  // 某人的战绩 —— 结果缓存在 data/searched/，与「我的战绩」互不干扰
  if (p === '/api/summoner/matches' && req.method === 'GET') {
    const puuid = url.searchParams.get('puuid') || '';
    const refresh = url.searchParams.get('refresh') === '1';
    try {
      return sendJson(req, res, 200, { ok: true, ...(await summonerMatches(puuid, { refresh })) });
    } catch (e) {
      return sendJson(req, res, 200, { ok: false, code: e.code || 'SEARCH_FAILED', error: e.message });
    }
  }

  // 历史
  if (p === '/api/reports' && req.method === 'GET') {
    const account = url.searchParams.get('account');
    return sendJson(req, res, 200, {
      ok: true,
      reports: account === 'all' ? listReports(50, { account: 'all' }) : listReports(50, { account }),
      account: account || resolveViewing(null),
    });
  }
  if (p.startsWith('/api/reports/') && req.method === 'GET') {
    try {
      return sendJson(req, res, 200, { ok: true, report: loadReport(p.slice('/api/reports/'.length)) });
    } catch (e) {
      return sendJson(req, res, 404, { ok: false, error: e.message });
    }
  }

  // 本机配置（Key / 语气）。写入 data/config.json，仅本机
  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.dryRun) {
      return sendJson(req, res, 200, {
        ok: true,
        ai: { hasKey: !!cfg.apiKey, keySource: cfg.keySource, autoAnalyze: cfg.autoAnalyze === true, configFile: cfg.configFile },
        tone: cfg.tone,
      });
    }
    try {
      saveConfig(body);
      cfg = loadConfig();     // 热重载，无需重启
      return sendJson(req, res, 200, {
        ok: true,
        ai: { hasKey: !!cfg.apiKey, keySource: cfg.keySource, autoAnalyze: cfg.autoAnalyze === true, configFile: cfg.configFile },
        tone: cfg.tone,
      });
    } catch (e) {
      return sendJson(req, res, 500, { ok: false, error: e.message });
    }
  }

  // 监视器开关
  if (p === '/api/watch' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.on === false) watcher.stop();
    else { watcher.start(); await watcher.poke(); }
    return sendJson(req, res, 200, { ok: true, watcher: watcher.state });
  }

  // SSE
  if (p === '/api/events' && req.method === 'GET') {
    const sseHeaders = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...SAFE_HEADERS,
    };
    // SSE 由 EventSource 发起，改不了请求头 —— 令牌只能走查询串（见 api.js）
    const sseAcao = corsOrigin(req);
    if (sseAcao) sseHeaders['Access-Control-Allow-Origin'] = sseAcao;
    res.writeHead(200, sseHeaders);
    res.write(`data: ${JSON.stringify({ type: 'hello', watcher: watcher.state, at: Date.now() })}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* */ } }, 25_000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return undefined;
  }

  return sendJson(req, res, 404, { ok: false, error: 'unknown endpoint ' + p });
}

/* ────────────────── 启动 ────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);

  // ① 只认本机回环 —— 挡 DNS rebinding：攻击者让域名解析到 127.0.0.1 之后，
  //    请求能发到本机，但 Host 是他的域名，这一步就被挡下。
  if (!hostTrusted(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 只允许本机访问');
  }

  // ② 预检：只给可信 origin 回许可。预检本身不带令牌（浏览器不会把自定义头放进
  //    预检），所以这里只描述「允许什么」，真正的放行由下面的令牌检查决定。
  if (req.method === 'OPTIONS') {
    const acao = corsOrigin(req);
    const headers = {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-BBX-Token',
      'Access-Control-Max-Age': '600',
    };
    if (acao) headers['Access-Control-Allow-Origin'] = acao;
    res.writeHead(acao ? 204 : 403, headers);
    return res.end();
  }

  // ③ /api/*（含 SSE）一律要令牌。静态资源不要 —— 首屏 HTML 里就带着令牌，
  //    要是对 HTML 也要令牌，界面自己就打不开了（先有页面才拿得到令牌）。
  if (url.pathname.startsWith('/api/') && !tokenOk(req, url)) {
    return sendJson(req, res, 401, { ok: false, code: 'NO_TOKEN', error: '缺少会话令牌（只允许本机界面调用）' });
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    // 415 / 401 这类是「请求不合规格」，不是服务出错 —— 别按 500 兜住，
    // 否则调用方（界面）看不出到底是自己写错了还是服务挂了
    if (e && e.status) return sendJson(req, res, e.status, { ok: false, error: e.message });
    console.error('[server] 未捕获异常：', e);
    if (!res.headersSent) return sendJson(req, res, 500, { ok: false, error: e.message });
    res.end();
  }
});

/* ────────────────── 启动 ────────────────── */

/**
 * 启动本地服务 —— 唯一入口，三种跑法共用它：
 *   `node server/server.mjs`   本文件末尾自动调用（开发态）
 *   双击 exe（SEA）            同上，只是宿主换成了 exe 内嵌的 node
 *   桌面客户端（Electron）     主进程 import 之后显式调用，端口传 0 让它自己挑一个空的
 *
 * 返回实际监听地址 —— 客户端要拿这个地址去 loadURL，所以这里不能只有副作用。
 * 启动失败一律 reject：退不退、怎么退交给调用方（命令行要退出码，客户端要弹框）。
 */
export function startServer({ port = cfg.port, open = true, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const url = `http://127.0.0.1:${actual}`;
      if (!quiet) printBanner(url);
      watcher.start();

      // 建名录（首次从历史抓取导入一次）—— 查询召唤师功能的地基，失败不影响主流程
      try {
        const r = rosterState();
        console.log(r.seeded
          ? `   [名录] 首次建立，导入历史 ${r.seeded} 局的参与者`
          : `   [名录] 本机认识 ${r.players} 人 / ${r.games} 局`);
      } catch { /* 名录坏了也不该拦着服务起不来 */ }

      if (open) setTimeout(() => openBrowser(url), 400);
      resolve({ port: actual, url });
    });
  });
}

function printBanner(url) {
  console.log('');
  console.log('  ============================================');
  console.log('   BlameGoat · LOL背锅侠 — 赛后战报');
  console.log('  ============================================');
  console.log(`   界面      ${url}`);
  console.log(`   Node      ${process.version}`);
  console.log(`   AI Key    ${cfg.apiKey ? `已配置（来源 ${cfg.keySource}）` : '未配置 → 走本地兜底判定'}`);
  console.log(`   自动监视  已开启（每 5s 检查一次客户端）`);
  if (DATA_DIR_NOTE) console.log(`   数据      ${DATA_DIR_NOTE}`);
  if (seeded.length) console.log(`   首次解包  ${seeded.join(' / ')} → data/`);
  console.log('  ============================================');
  console.log('   Ctrl+C 退出');
  console.log('');
}

/**
 * 端口占用要说得像人话，别甩一坨栈。
 * 单文件 exe 上最常见的是「第二下双击」—— 那就把已经在跑的那个界面叫到面前来。
 */
function reportListenFailure(e) {
  if (e.code === 'EADDRINUSE') {
    if (IS_SEA) {
      console.log(`\n[!] 本工具已经在跑了，直接打开界面：http://127.0.0.1:${cfg.port}\n`);
      openBrowser(`http://127.0.0.1:${cfg.port}`);
      return;
    }
    console.error(`\n[!] 端口 ${cfg.port} 已被占用。`);
    console.error(`[!] 换端口：set PORT=7711 && node server/server.mjs\n`);
    return;
  }
  console.error('[!] 服务启动失败：', e.message);
}

/** 用系统默认浏览器打开界面（加 --no-open 可跳过）。桌面客户端用不到这条 —— 它自己就是界面。 */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.log(`[server] 自动打开浏览器失败，请手动访问 ${url}`); });
}

/**
 * 本文件是「被直接运行」还是「被别人 import」？
 *
 * 桌面客户端会 import 它拿 startServer，那时绝不能抢着 listen、更不能弹浏览器出来。
 * SEA 单文件里 import.meta 是空的，fileURLToPath 必然抛 —— 那恰好说明「就是入口」，
 * 于是这个 catch 不是兜底，是正路。
 */
function isDirectRun() {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (isDirectRun()) {
  startServer({ open: !process.argv.includes('--no-open') }).catch((e) => {
    reportListenFailure(e);
    process.exit(1);
  });
}

process.on('SIGINT', () => {
  console.log('\n[server] 正在退出…');
  watcher.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
