/**
 * LCU（League Client Update）对接层 —— 零 npm 依赖，只用 node: 内置模块
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ 国服三个坑的处理方式（实测环境：G:\WeGameApps\英雄联盟\）          │
 * │                                                                  │
 * │ 坑 1  路径不固定                                                   │
 * │       国服可能装在任意盘的 WeGameApps 下，目录名是中文「英雄联盟」。 │
 * │       解法：不猜路径，按盘符 × 候选前缀枚举目录，只要                 │
 * │             <dir>\LeagueClient\lockfile 存在就认。                 │
 * │                                                                  │
 * │ 坑 2  GBK 编码                                                    │
 * │       从 cmd/tasklist 拿到的路径是 GBK 字节，当 UTF-8 解会变成       │
 * │       「鑻遍泟鑱旂洘」。本模块**完全不依赖外部命令取路径**，          │
 * │       改用 fs.readdir 由 Node 直接拿 Unicode 目录名，从源头绕开。    │
 * │       若目录名确实已被 GBK 写坏，用 looksLikeLolDir() 做模糊匹配。   │
 * │                                                                  │
 * │ 坑 3  端口每局都变                                                 │
 * │       端口写在 lockfile 里，且每次启动都换。                       │
 * │       解法：watch **目录**而非文件（文件可能被整体替换），          │
 * │             且每次调用都重新读 lockfile 拿最新端口。               │
 * │                                                                  │
 * │ 坑 4  lockfile 是空的（真机实测，2026-10-09）                      │
 * │       国服 WeGame 版哪怕是客户端正在运行，lockfile 也可能是        │
 * │       0 字节（实测 PID 33076 在跑，文件 size=0）。                  │
 * │       解法：lockfile 解析失败时，回退到客户端启动日志              │
 * │             <clientDir>\*_LeagueClientUx.log 的开头命令行，        │
 * │             用正则取 --app-port / --remoting-auth-token。          │
 * │             日志命令行在文件第 0 行，只读前 64KB 即可。             │
 * └──────────────────────────────────────────────────────────────────┘
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

/* ────────────────── 路径探测 ────────────────── */

const DRIVES = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 相对候选路径（按常见度排序），\* 表示需要遍历一层 */
const REL_CANDIDATES = [
  'WeGameApps\\*\\LeagueClient\\lockfile',
  'Program Files\\WeGameApps\\*\\LeagueClient\\lockfile',
  'Program Files (x86)\\WeGameApps\\*\\LeagueClient\\lockfile',
  '腾讯游戏\\*\\LeagueClient\\lockfile',
  'Games\\*\\LeagueClient\\lockfile',
  'Games\\英雄联盟\\LeagueClient\\lockfile',
  'Program Files\\*\\LeagueClient\\lockfile',
  'Program Files (x86)\\*\\LeagueClient\\lockfile',
];

/** 目录名疑似 LOL —— 兼容正常中文名与 GBK 乱码名 */
function looksLikeLolDir(name) {
  if (!name) return false;
  if (name === '英雄联盟') return true;
  if (name.includes('League')) return true;
  // GBK 字节被当 UTF-8 解出来的典型乱码：鑻遍泟鑱旂洘
  if (name.includes('鑻遍泟') || name.includes('鑱旂洘')) return true;
  return false;
}

/** 判断这个 lockfile 路径是否可信：文件存在即可（内容可能为空 = 客户端没在跑） */
function acceptLockfile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ── 探测缓存 ──
   监视器每 5 秒要确认一次客户端在不在。原先每次都把 24 个盘符 × 8 条候选路径
   同步扫一遍 —— 接了休眠网络盘、空光驱、离线 U 盘的机器上，单个 stat/readdir
   可能阻塞好几秒，而服务是单线程的：卡的是服务端 + 界面一起。
   两条对策：
     ① 结果缓存 15 秒（客户端不会每 5 秒换个安装位置）
     ② 连着的时候直接复用上次那条 lockfile 路径，一次都不扫 */

const PROBE_TTL_MS = 15_000;
const DRIVE_CONCURRENCY = 4;
let _probe = { at: 0, files: [] };
let _lastGood = null;      // 上次真正连上的 lockfile 路径

const probeFresh = () => Date.now() - _probe.at < PROBE_TTL_MS;
const rememberProbe = (files) => { _probe = { at: Date.now(), files }; return files; };

/**
 * 枚举所有候选 lockfile 路径（同步版）。
 * 不猜具体路径，逐盘 × 逐候选前缀展开；带 * 的展开一层目录。
 * @returns {string[]} 存在的 lockfile 绝对路径（可能为空数组）
 */
export function candidateLockfiles() {
  if (probeFresh()) return _probe.files;
  const found = [];
  const seen = new Set();

  const push = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (acceptLockfile(p)) found.push(p);
  };

  for (const drive of DRIVES) {
    const root = `${drive}:\\`;
    if (!fs.existsSync(root)) continue;

    for (const rel of REL_CANDIDATES) {
      const parts = rel.split('\\');
      // 逐步展开 * 通配（只支持一层）
      let bases = [root];
      for (const part of parts) {
        const next = [];
        for (const base of bases) {
          const candidate = path.join(base, part);
          if (part === '*') {
            try {
              const entries = fs.readdirSync(base, { withFileTypes: true });
              for (const e of entries) {
                if (e.isDirectory()) next.push(path.join(base, e.name));
              }
            } catch { /* 权限 / 不存在，跳过 */ }
          } else if (part.includes('.') || part.endsWith('lockfile')) {
            // 末段是文件，直接推入
            next.push(candidate);
          } else {
            try {
              if (fs.statSync(candidate).isDirectory()) next.push(candidate);
            } catch { /* 不存在，跳过 */ }
          }
        }
        bases = next;
      }
      bases.forEach(push);
    }
  }

  // 兜底：直接找 WeGameApps 下名字像 LOL 的目录
  for (const drive of DRIVES) {
    const wegame = `${drive}:\\WeGameApps`;
    if (!fs.existsSync(wegame)) continue;
    try {
      for (const e of fs.readdirSync(wegame, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (!looksLikeLolDir(e.name)) continue;
        push(path.join(wegame, e.name, 'LeagueClient', 'lockfile'));
      }
    } catch { /* 跳过 */ }
  }

  return rememberProbe(found);
}

/**
 * 异步版探测 —— 给监视器那种「每 5 秒一次」的常驻循环用。
 *
 * 同步版在挂了休眠网络盘的机器上会把主线程卡住几秒（见 PROBE_TTL_MS 的注释）；
 * 这里把 stat / readdir 全换成 fs.promises，并把盘符并发压到 4 ——
 * 一次放 24 个盘出去，光是等各自超时就够久了，排队反而更快收工。
 */
export async function candidateLockfilesAsync() {
  if (probeFresh()) return _probe.files;

  const fsp = fs.promises;
  const found = [];
  const seen = new Set();
  const push = async (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) found.push(p);
    } catch { /* 不存在 / 无权限 */ }
  };
  const isDir = async (p) => {
    try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
  };

  const scanDrive = async (drive) => {
    const root = `${drive}:\\`;
    if (!await isDir(root)) return;
    for (const rel of REL_CANDIDATES) {
      let bases = [root];
      for (const part of rel.split('\\')) {
        const next = [];
        for (const base of bases) {
          const candidate = path.join(base, part);
          if (part === '*') {
            try {
              const entries = await fsp.readdir(base, { withFileTypes: true });
              for (const e of entries) if (e.isDirectory()) next.push(path.join(base, e.name));
            } catch { /* 权限 / 不存在 */ }
          } else if (part.includes('.') || part.endsWith('lockfile')) {
            next.push(candidate);
          } else if (await isDir(candidate)) {
            next.push(candidate);
          }
        }
        bases = next;
      }
      for (const p of bases) await push(p);
    }
    // 兜底：WeGameApps 下名字像 LOL 的目录
    const wegame = `${drive}:\\WeGameApps`;
    if (!await isDir(wegame)) return;
    try {
      for (const e of await fsp.readdir(wegame, { withFileTypes: true })) {
        if (!e.isDirectory() || !looksLikeLolDir(e.name)) continue;
        await push(path.join(wegame, e.name, 'LeagueClient', 'lockfile'));
      }
    } catch { /* 跳过 */ }
  };

  const queue = [...DRIVES];
  const worker = async () => {
    while (queue.length) await scanDrive(queue.shift());
  };
  await Promise.all(Array.from({ length: DRIVE_CONCURRENCY }, worker));
  return rememberProbe(found);
}

/** 返回第一个可用的 lockfile 路径；客户端没装时返回 null */
export function findLockfile() {
  // 已经连着就复用上次那条路 —— 客户端不会在 5 秒内换个盘装着
  if (_lastGood && acceptLockfile(_lastGood)) return _lastGood;
  const all = candidateLockfiles();
  return all.length ? all[0] : null;
}

/** 异步版 findLockfile（给常驻循环用，避免同步 stat 卡住主线程） */
export async function findLockfileAsync() {
  if (_lastGood && acceptLockfile(_lastGood)) return _lastGood;
  const all = await candidateLockfilesAsync();
  return all.length ? all[0] : null;
}

/* ────────────────── lockfile 解析 ────────────────── */

/**
 * lockfile 格式：进程名:pid:端口:密码:协议
 * 客户端未运行时文件可能为 0 字节 → 返回 null
 */
export function parseLockfile(text) {
  if (!text) return null;
  const line = String(text).trim();
  if (!line) return null;
  const [name, pid, port, password, protocol] = line.split(':');
  if (!port || !password) return null;
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0) return null;
  return {
    name: name || 'LeagueClient',
    pid: Number(pid) || null,
    port: p,
    password,
    protocol: protocol || 'https',
  };
}

/* ────────────────── 日志兜底（国服 lockfile 常为空） ────────────────── */

/**
 * 取 64KB 日志头部（命令行在文件第 0 行，不需要读全文件）
 */
function readLogHead(file, bytes = 65536) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 从 LeagueClient 目录的最新启动日志里解析端口与令牌。
 * 客户端每次启动都会新建一个 <时间戳>_<pid>_<uxpid>_LeagueClientUx.log，
 * 取 mtime 最新的那个即可。
 * @param {string} clientDir 形如 G:\WeGameApps\英雄联盟\LeagueClient
 * @returns {object|null} 与 parseLockfile 同构的 conn
 */
export function probeConnFromLog(clientDir) {
  let entries;
  try {
    entries = fs.readdirSync(clientDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best = null;
  let bestMtime = 0;
  for (const e of entries) {
    if (!e.isFile() || !/_LeagueClientUx\.log$/i.test(e.name)) continue;
    try {
      const full = path.join(clientDir, e.name);
      const st = fs.statSync(full);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    } catch { /* 跳过读不到的 */ }
  }
  if (!best) return null;

  const head = readLogHead(best);
  if (!head) return null;

  const port = (head.match(/--app-port=(\d+)/) || [])[1];
  const token = (head.match(/--remoting-auth-token=([A-Za-z0-9_-]+)/) || [])[1];
  const pid = (head.match(/--app-pid=(\d+)/) || [])[1];
  if (!port || !token) return null;

  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0) return null;

  return {
    name: 'LeagueClient',
    pid: pid ? Number(pid) : null,
    port: p,
    password: token,
    protocol: 'https',
    via: 'log',
    logFile: best,
    logAgeMs: Date.now() - bestMtime,
  };
}

/**
 * 读取并解析连接信息。
 * 每次调用都重新读 —— 端口每局都变，不能缓存。
 *
 * 先后顺序：lockfile 内容 → 启动日志。前者是标准途径，
 * 但国服 WeGame 版实测经常是 0 字节（坑 4），此时只能靠日志。
 * @returns {{ conn: object|null, lockfile: string|null, exists: boolean, running: boolean, source: string|null }}
 */
/** 从一个 lockfile 路径读出连接信息（解析失败时退到启动日志，见坑 4） */
function readFrom(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch { /* 读不到就当空 */ }

  let conn = parseLockfile(raw);
  let source = conn ? 'lockfile' : null;

  if (!conn) {
    conn = probeConnFromLog(path.dirname(file));
    if (conn) source = 'log';
  }
  return { conn, lockfile: file, exists: true, running: !!conn, source };
}

export function readConnection(lockfilePath = null) {
  // 已经连着就别再找了：每 5 秒全盘扫一遍，在挂着休眠网络盘的机器上会卡住界面
  if (!lockfilePath && _lastGood) {
    const st = readFrom(_lastGood);
    if (st.running) return st;
    _lastGood = null;                    // 这条路上的客户端没了，下一轮重新找
  }

  const file = lockfilePath || findLockfile();
  if (!file) return { conn: null, lockfile: null, exists: false, running: false, source: null };

  const st = readFrom(file);
  if (st.running) _lastGood = file;      // 记住这条路，下次直接复用
  return st;
}

/**
 * 异步版 readConnection —— 监视器那种每 5 秒一次的循环用它。
 * 探测走 fs.promises（不阻塞主线程），其余与同步版一致。
 */
export async function readConnectionAsync(lockfilePath = null) {
  if (!lockfilePath && _lastGood) {
    const st = readFrom(_lastGood);
    if (st.running) return st;
    _lastGood = null;
  }

  const file = lockfilePath || await findLockfileAsync();
  if (!file) return { conn: null, lockfile: null, exists: false, running: false, source: null };

  const st = readFrom(file);
  if (st.running) _lastGood = file;
  return st;
}

/* ────────────────── HTTPS 调用 ────────────────── */

/**
 * 对局详情的内存缓存 —— 同一局只向客户端要一次。
 *
 * 为什么值得：一次「查某人」要读上百局详情，而这些局在几次查询之间高度重叠
 * （同一批人开黑，大家打的是同一批局）。实测 195 局要 5–9 秒，
 * 客户端在对局中时更慢；缓存命中后重复查询直接是毫秒级。
 *
 * 只放内存、不落盘：对局数据是不可变的，但要落盘就是 400 个文件，
 * 而且磁盘版的失效策略（窗口滑走？版本更新？）远比收益复杂。
 * 进程重启后重新拉一次即可。
 *
 * ⚠ 试过用 https.Agent keepAlive 复用连接，实测**更慢**（LCU 在长连接下
 *   响应波动很大，16.6s vs 5.5s），所以连接层面保持「一次请求一条连接」。
 */
const DETAIL_TTL_MS = 10 * 60 * 1000;
const DETAIL_CACHE_MAX = 600;
const _detailCache = new Map();      // gameId → { at, detail }

/** 当前缓存了多少局（自检 / 排查用） */
export function detailCacheSize() { return _detailCache.size; }

/**
 * 调 LCU 本地 REST 接口。
 * LCU 用自签证书 + HTTP Basic（用户名固定 riot，密码取 lockfile）。
 */
export function lcuRequest(conn, { method = 'GET', endpoint, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request(
      {
        host: '127.0.0.1',
        port: conn.port,
        path: endpoint,
        method,
        rejectUnauthorized: false,          // 自签证书
        headers: {
          Authorization: 'Basic ' + Buffer.from(`riot:${conn.password}`).toString('base64'),
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const err = new Error(`LCU ${res.statusCode} ${endpoint}`);
            err.statusCode = res.statusCode;
            err.body = text.slice(0, 300);
            return reject(err);
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(text); // 少数接口返回纯文本
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`LCU 请求超时 ${endpoint}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 当前游戏阶段：None / Lobby / Matchmaking / InProgress / EndOfGame … */
export async function readPhase(conn) {
  try {
    return await lcuRequest(conn, { endpoint: '/lol-gameflow/v1/gameflow-phase' });
  } catch {
    return null;
  }
}

/**
 * 调 LCU 并原样返回二进制（英雄图标等资源文件）。
 * 与 lcuRequest 的区别：不做 JSON 解析、不因 4xx 抛错以外的处理。
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export function lcuRequestBinary(conn, endpoint, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: conn.port,
      path: endpoint,
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`riot:${conn.password}`).toString('base64'),
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        const err = new Error(`LCU ${res.statusCode} ${endpoint}`);
        err.statusCode = res.statusCode;
        return reject(err);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || 'application/octet-stream',
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`LCU 二进制请求超时 ${endpoint}`)));
    req.on('error', reject);
    req.end();
  });
}

/** 当前登录召唤师（用于确认「我在哪边」） */
export async function readCurrentSummoner(conn) {
  try {
    return await lcuRequest(conn, { endpoint: '/lol-summoner/v1/current-summoner' });
  } catch {
    return null;
  }
}

/**
 * 上一局 EOG 数据块。
 * 注意：客户端不在结束态时该接口会 404，属正常情况。
 * ★ 真机实测：返回体里**没有 queueId / mapId**，玩家也**没有 participantId**，
 *   且 `events` 恒为空数组 —— 这三样都要靠下面几个接口补。
 */
export async function readEog(conn) {
  return lcuRequest(conn, { endpoint: '/lol-end-of-game/v1/eog-stats-block', timeoutMs: 15000 });
}

/**
 * 对局详情 —— participantId 桥接的唯一来源。
 * 提供 participantIdentities[].participantId ←→ player.summonerId，
 * 以及 queueId / mapId / gameDuration / gameVersion。
 */
export async function readMatchDetail(conn, gameId) {
  if (gameId == null) return null;
  const gid = Number(gameId);
  if (!Number.isFinite(gid)) return null;

  const hit = _detailCache.get(gid);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.detail;

  try {
    const detail = await lcuRequest(conn, { endpoint: `/lol-match-history/v1/games/${gid}`, timeoutMs: 20000 });
    if (detail?.participants?.length) {
      // 满了先丢最旧的四分之一（Map 保持插入序，从头删就是最旧的）
      if (_detailCache.size >= DETAIL_CACHE_MAX) {
        const drop = Math.ceil(DETAIL_CACHE_MAX / 4);
        let n = 0;
        for (const k of _detailCache.keys()) {
          _detailCache.delete(k);
          if (++n >= drop) break;
        }
      }
      _detailCache.set(gid, { at: Date.now(), detail });
    }
    return detail;
  } catch {
    return null;
  }
}

/**
 * 对局时间轴 —— 事件的真实所在。
 * 形状 { frames: [{ events, participantFrames, timestamp }] }，
 * 事件字段 killerId / victimId / assistingParticipantIds / timestamp(毫秒)。
 */
export async function readTimeline(conn, gameId) {
  if (gameId == null) return null;
  try {
    return await lcuRequest(conn, { endpoint: `/lol-match-history/v1/game-timelines/${gameId}`, timeoutMs: 20000 });
  } catch {
    return null;
  }
}

/** 当前 gameflow 会话（提供模式中文名 / gameId） */
export async function readSession(conn) {
  try {
    return await lcuRequest(conn, { endpoint: '/lol-gameflow/v1/session', timeoutMs: 10000 });
  } catch {
    return null;
  }
}

/** 最近对局列表 —— 打完永久可查，是「这局结束了没」最可靠的信号 */
export async function readRecentMatches(conn, { begIndex = 0, endIndex = 3 } = {}) {
  try {
    return await lcuRequest(conn, {
      endpoint: `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=${begIndex}&endIndex=${endIndex}`,
      timeoutMs: 15000,
    });
  } catch {
    return null;
  }
}

/**
 * 拉**指定 puuid** 的战绩列表（不只是当前登录的号）。
 *
 * ★ 实测（2026-10-11）：这个端点对**任意已知 puuid** 都按人返回各自的战绩
 *   （四个人的 accountId 各不相同、gameId 集合也各不相同），不是「忽略入参回同一份缓存」。
 *   所以「查某人」能突破「他只在我见过的局里出现过」的限制。
 *
 * ★ 三个实测出来的上限，别再踩：
 *   1. `endIndex` **超过 50 反而变少** —— 实测 50 给 51 局，100 / 300 只回 11～21 局。
 *      所以固定用 50，这是能拿到最多的档位。
 *   2. `begIndex` 翻页**无效**（0/20/40/100/190 返回的都是同一批），其它参数名直接 400。
 *      没有第二页，别做分页。
 *   3. 能拿到的量**不稳定**（同一人不同时刻 11 / 21 / 51 局），取决于客户端本地缓存。
 *      只能「有多少拿多少」，界面别承诺固定条数。
 *
 * ★ 列表里的元素**只含被查的那一个人**（participants 长度为 1），
 *   要判定得再逐局拉 `/lol-match-history/v1/games/{gameId}`（那里才是 10 人 + teams）。
 *   所以这个函数只用来**扩充对局清单**，不能拿来直接出结论。
 *
 * @returns {number[]} gameId 列表；拉不到就是空数组，不抛
 */
export async function readMatchListFor(conn, puuid, { begIndex = 0, endIndex = 50 } = {}) {
  if (!conn || !puuid) return [];
  try {
    const r = await lcuRequest(conn, {
      endpoint: `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=${begIndex}&endIndex=${endIndex}`,
      timeoutMs: 20_000,
    });
    return extractGameIds(r);
  } catch {
    return [];      // 客户端不认这个 puuid / 缓存里没有 → 当作没这份来源，不打断主流程
  }
}

/** 从 recent-matches 的几种嵌套形状里抠出 gameId 列表 */
export function extractGameIds(listResp) {
  if (!listResp) return [];
  const arr = listResp.games?.games || listResp.games || listResp.matches || [];
  return (Array.isArray(arr) ? arr : []).map((g) => g?.gameId).filter((x) => x != null);
}

/**
 * 从 recent-matches 响应里取出**完整对局对象**数组。
 *
 * ★ 真机实测：列表里的每个元素不是摘要，而是完整的 match-detail
 *   （自带 participants / participantIdentities / teams / gameDuration / queueId / mapId）。
 *   所以「战绩列表」一次请求就能拿到英雄、KDA、胜负，不必逐局再查。
 *
 * 代价：`games.gameCount` 真机恒为 2 —— 客户端只缓存最近两局，
 * begIndex 传多少都只回这两局，也没有 refresh 端点。这是数据源上限，不是 bug。
 * 所以「所有战绩」靠本地累积索引（见 src/lcu/matches.mjs 与 service.mjs）。
 */
export function extractGames(listResp) {
  if (!listResp) return [];
  const g = listResp.games;
  if (Array.isArray(g)) return g;
  const arr = g?.games || listResp.matches || [];
  return Array.isArray(arr) ? arr : [];
}

/**
 * 从列表里挑出**真正最新**的那一局。
 *
 * ★ 不能直接取数组第 0 项：真机实测 gameId 与开局时间**不同序** ——
 *   401199932187 比 401199968596 编号大，开局时间却早 20 分钟
 *   （不同对局服各自发号，id 不可跨服比较）。
 *   所以按 gameCreation 取最大，取不到时间戳时才退回「数组第一项」。
 */
export function pickLatestGame(listResp) {
  const games = extractGames(listResp);
  if (!games.length) return null;
  const withTime = games.filter((g) => g?.gameCreation != null);
  if (withTime.length) {
    return withTime.reduce((a, b) => (Number(b.gameCreation) > Number(a.gameCreation) ? b : a));
  }
  return games[0];
}

/**
 * 拉齐一局的全部原始数据。
 *
 * 为什么必须拉齐：EOG 单独一份是**不够**的 ——
 *   · 玩家没有 participantId（要靠 matchDetail 桥接，否则十人塌成一个 pid）
 *   · 没有 queueId / mapId（模式判断失效）
 *   · events 恒为空（时间轴直接是 0 条）
 * gameId 优先取 session，其次 EOG。
 *
 * @returns {{ eog, matchDetail, timeline, session, gameId }}
 */
export async function readLiveBundle(conn, { gameId = null, needTimeline = true } = {}) {
  const eog = await readEog(conn).catch(() => null);
  const session = await readSession(conn);
  const gid = gameId
    ?? session?.gameData?.gameId
    ?? session?.gameId
    ?? eog?.gameId
    ?? null;

  const [matchDetail, timeline] = await Promise.all([
    readMatchDetail(conn, gid),
    needTimeline ? readTimeline(conn, gid) : Promise.resolve(null),
  ]);

  return { eog, matchDetail, timeline, session, gameId: gid };
}

/** 探测客户端是否活着（比 lockfile 更可靠 —— 能应答才算活） */
export async function pingClient(conn) {
  try {
    await lcuRequest(conn, { endpoint: '/lol-gameflow/v1/gameflow-phase', timeoutMs: 4000 });
    return true;
  } catch {
    return false;
  }
}

/* ────────────────── 等待客户端就绪 ────────────────── */

/**
 * 轮询等待 lockfile 出现且可解析（= 客户端启动完成）。
 * 客户端启动要几十秒，启动期 lockfile 可能刚建立还没写入。
 */
export async function waitForClient({ timeoutMs = 180_000, intervalMs = 2000, onTick = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = readConnection(last);
    last = state.lockfile;
    if (state.running) return state;
    onTick(state);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const state = readConnection(last);
  state.timedOut = true;
  return state;
}

/* ────────────────── 自检 ────────────────── */

/**
 * 环境自检：客户端装没装 / 跑没跑 / 能不能应答 / 当前什么阶段。
 * 供 check.bat 和界面「扫描客户端」按钮共用。
 */
export async function selfTest() {
  const report = {
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    lockfiles: [],
    lockfile: null,
    installed: false,
    running: false,
    responsive: false,
    phase: null,
    summoner: null,
    error: null,
  };

  report.lockfiles = candidateLockfiles();
  report.installed = report.lockfiles.length > 0;
  if (!report.installed) {
    report.error = '未找到 LeagueClient\\lockfile，可能未安装国服客户端';
    return report;
  }

  const state = readConnection(report.lockfiles[0]);
  report.lockfile = state.lockfile;
  report.connSource = state.source;   // 'lockfile' | 'log'
  if (!state.conn) {
    report.error = 'lockfile 为空且日志中无端口信息 —— 客户端未运行';
    return report;
  }

  report.port = state.conn.port;
  report.pid = state.conn.pid;

  // 端口是否真的活着只能靠 ping —— 日志兜底拿到的可能是上一次启动的残留
  report.responsive = await pingClient(state.conn);
  report.running = report.responsive;
  if (!report.responsive) {
    report.error = state.source === 'log'
      ? '从启动日志取到端口但接口无应答 —— 客户端可能正在启动或已退出'
      : 'lockfile 有端口但接口无应答 —— 客户端可能正在启动或已卡死';
    return report;
  }

  report.phase = await readPhase(state.conn);
  const me = await readCurrentSummoner(state.conn);
  if (me) {
    report.summoner = {
      displayName: me.displayName || me.gameName || null,
      tagLine: me.tagLine || null,
      summonerLevel: me.summonerLevel ?? null,
    };
  }
  return report;
}

export default {
  candidateLockfiles, candidateLockfilesAsync, findLockfile, findLockfileAsync,
  parseLockfile, readConnection, readConnectionAsync, probeConnFromLog,
  lcuRequest, lcuRequestBinary, readPhase, readCurrentSummoner, readEog, pingClient,
  readMatchDetail, readTimeline, readSession, readRecentMatches, readMatchListFor,
  extractGameIds, extractGames, pickLatestGame,
  readLiveBundle,
  waitForClient, selfTest,
};
