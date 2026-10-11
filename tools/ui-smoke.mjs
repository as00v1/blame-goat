/**
 * 界面冒烟测试 —— 在没有浏览器的环境里把 web/ 那套脚本真跑一遍。
 *
 * 为什么需要：这台机器 npm 不通，装不了无头浏览器，没法截图验证。
 * 但 web/app.js 是纯 DOM 操作，用一套最小 DOM 桩 + node:vm 就能把
 * data.js → prompt.js → api.js → app.js 按 <script> 顺序执行，然后检查：
 *   ① 渲染有没有抛错
 *   ② #matchList 里到底有没有生成行
 *   ③ 点击某一行会不会真的去调 /api/analyze-match
 *
 * 用法：node tools/ui-smoke.mjs   （需要本地服务在 7710 起着）
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const BASE = process.env.BBX_BASE || 'http://127.0.0.1:7710';

/* ── 会话令牌 ──
   服务现在只认「本机界面」：/api/* 一律要求随首屏 HTML 下发的令牌（见 server.mjs）。
   冒烟跑的是真服务，所以照浏览器那样先取首页拿令牌，之后的请求都带上；
   POST 还要显式声明 JSON —— 服务端强制校验 Content-Type（415）。 */
const TOKEN = await (async () => {
  try {
    const html = await (await globalThis.fetch(`${BASE}/`)).text();
    const m = html.match(/name="bbx-token" content="([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
})();
if (!TOKEN) console.log('[warn] 没拿到会话令牌 —— 后面的接口调用会全部 401');

const fetch = (url, opts = {}) => globalThis.fetch(url, {
  ...opts,
  headers: {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(TOKEN ? { 'X-BBX-Token': TOKEN } : {}),
    ...(opts.headers || {}),
  },
});

/* ── 最小 DOM ── */

const makeEl = (sel) => {
  const el = {
    _sel: sel,
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    type: 'text',
    disabled: false,
    dataset: {},
    style: {},
    _handlers: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) {
        if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); return this._s.has(c); }
        f ? this._s.add(c) : this._s.delete(c);
        return !!f;
      },
    },
    addEventListener(t, h) { (this._handlers[t] ||= []).push(h); },
    removeEventListener() {},
    appendChild() {},
    remove() {},
    closest() { return null; },
    click() { (this._handlers.click || []).forEach((h) => h({ target: this, stopPropagation() {} })); },
    querySelector(s) { return get(s); },
    querySelectorAll() { return []; },
  };
  return el;
};

const els = new Map();

// 真实 DOM 里 $('#tabs .tab[data-tab="cast"]') 拿到的就是 $$('#tabs .tab') 里的那一个；
// 桩若各给一个独立对象，页签切换就永远不会生效，断言会假通过/假失败。这里做等价映射。
// 页签有两套，各管各的容器（和真实 DOM 一致）：
//   #tabs    → #page-report   战报 / 战绩 / 播报 / 历史
//   #cfgTabs → #page-config   设置 / 提示词
// 桩若把两者混成一组，就验不出「两套页签互不串扰」这件事。
const TAB_SEL = /^#tabs \.tab\[data-tab="([^"]+)"\]$/;
const CFG_TAB_SEL = /^#cfgTabs \.tab\[data-ctab="([^"]+)"\]$/;

// 战报页页签：战报 / 播报 / 历史。
// 「战绩」页签已按需求去掉（首页已经有一份，点进来看到的一模一样 = 重复展示）——
// 这里与 index.html 保持一致，否则桩里的页签和真实 DOM 就不是一回事了。
const REPORT_TABS = ['report', 'cast', 'history'];
const CFG_TABS = ['settings', 'prompt'];
const tabEls = REPORT_TABS.map((t) => { const e = makeEl('#tabs .tab'); e.dataset.tab = t; return e; });
const cfgTabEls = CFG_TABS.map((t) => { const e = makeEl('#cfgTabs .tab'); e.dataset.ctab = t; return e; });
const paneEls = REPORT_TABS.map((t) => { const e = makeEl('#page-report .pane'); e.dataset.pane = t; return e; });
const cfgPaneEls = CFG_TABS.map((t) => { const e = makeEl('#page-config .pane'); e.dataset.pane = t; return e; });
// 分类切换钮（按阵营 / 按结论 / 按定位）—— 界面一次绑三颗，桩得照单全收
const GROUP_BTNS = ['side', 'label', 'role'];
const groupBtns = GROUP_BTNS.map((g) => { const e = makeEl('#groupBy .seg-btn'); e.dataset.group = g; return e; });

const get = (sel) => {
  let m = TAB_SEL.exec(sel);
  if (m) {
    const hit = tabEls.find((e) => e.dataset.tab === m[1]);
    if (hit) return hit;
  }
  m = CFG_TAB_SEL.exec(sel);
  if (m) {
    const hit = cfgTabEls.find((e) => e.dataset.ctab === m[1]);
    if (hit) return hit;
  }
  if (!els.has(sel)) els.set(sel, makeEl(sel));
  return els.get(sel);
};

const document = {
  querySelector: get,
  querySelectorAll: (sel) => {
    if (sel === '#tabs .tab') return tabEls;
    if (sel === '#cfgTabs .tab') return cfgTabEls;
    if (sel === '#page-report .pane') return paneEls;
    if (sel === '#page-config .pane') return cfgPaneEls;
    if (sel === '#groupBy .seg-btn') return groupBtns;
    return [];
  },
  createElement: () => makeEl('created'),
  body: makeEl('body'),
};

/* ── 环境 ── */

/** 界面订阅服务端事件时把回调收在这里，测试自己投喂（见文末「判定过程」那节） */
const sseHandlers = [];
/** 假 EventSource：真机由浏览器提供；这里给个空壳，只为让 api.js 那条分支不至于报错 */
const sse = [];
class FakeEventSource {
  constructor(url) { this.url = url; sse.push(this); }
  close() { this.closed = true; }
}

const calls = [];
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  Promise, Map, Set, URLSearchParams, encodeURIComponent, decodeURIComponent,
  document,
  // 落点用 #report —— 战报页（评分表 + 时间轴都在这一页）。
  // 原来写的是 #matches，那个页签已经去掉了，hash 会落到首页分支、不渲染战报。
  // 不加 nostream：判定过程（judging）那条路正是靠 SSE 推的，关掉就验不到。
  location: { protocol: 'http:', origin: BASE, search: '', hash: '#report' },
  // SSE 桩：真 EventSource 由浏览器提供，这里给一个能手动投喂事件的假货，
  // 否则「收到 judging 之后进度页显示什么」这条只能靠肉眼在真机上看。
  EventSource: FakeEventSource,
  fetch: (...a) => fetch(...a),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

/* api.js 里的 BASE 取自 location.origin —— 这里直接指向本地服务 */
for (const f of ['data.js', 'prompt.js', 'api.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), ctx, { filename: f });
}

/* 在 app.js 之前把 BBX 的网络出口换掉，记录调用并返回可控数据 */

/**
 * 「正在看谁」是**服务端内存状态** —— 界面里手动切过账号，它就会停在那个账号上，
 * 于是「默认 = 当前登录」这条断言第二次跑必然失败（不是产品缺陷，是测试不幂等）。
 * 先拨回当前登录，**再**读数据 —— 后面所有断言都得基于同一个视角，否则时点对不上。
 */
const bootAcct = await fetch(`${BASE}/api/accounts`).then((r) => r.json()).catch(() => null);
if (bootAcct?.ok && bootAcct.current && String(bootAcct.viewing) !== String(bootAcct.current)) {
  await fetch(`${BASE}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: bootAcct.current }),
  }).catch(() => null);
  console.log('账号视角   : 原先停在别的账号上，已拨回当前登录再验「默认」');
}

const realMatches = await fetch(`${BASE}/api/matches?limit=500`).then((r) => r.json()).catch(() => null);
if (!realMatches?.ok) {
  console.error('[skip] 本地服务未就绪或 /api/matches 失败，先启动 start.bat');
  process.exit(2);
}

let analyzeHit = null;
let detailHit = null;
let searchHit = null;
let searchPuuidHit = null;

/** 冒烟用的假判定结果 —— 形状与真战报一致，好让界面照常渲染 */
function stubResult(ds) {
  return {
    verdict: '【冒烟桩】这份判定是测试构造的，不来自模型',
    insight: '冒烟测试不该烧模型额度，所以这里不真发请求。',
    // v3.1 分类卡：三条团队结论都要有，否则界面三块里会缺壳
    teamInsight: {
      compositionNote: '【桩】阵容对比结论，冒烟占位。',
      augmentNote: '【桩】海克斯对比结论，冒烟占位。',
      itemNote: '【桩】出装对比结论，冒烟占位。',
    },
    players: (ds.players || []).map((p) => ({
      pid: p.pid, label: 'NORMAL', score: 50, reason: '桩数据', evidence: [],
    })),
  };
}

sandbox.BBX = {
  state: { online: true, status: { ai: { hasKey: false, tone: 'normal', autoAnalyze: false } } },
  available: true,
  origin: BASE,
  probe: async () => true,
  // 把订阅到的回调收下来 —— 判定过程（judging）那条路只能靠投喂事件来验，
  // 真机调一次模型要几厘钱，不能每次冒烟都花
  subscribe: (onEvent) => { if (typeof onEvent === 'function') sseHandlers.push(onEvent); return null; },
  status: async () => ({ ai: { hasKey: false, tone: 'normal', autoAnalyze: false } }),
  selftest: async () => ({ installed: true, running: true, phase: 'InProgress', port: 12533 }),
  matches: async () => realMatches,
  /** 点一行走的那条路 —— 详情（只读，不调模型） */
  matchDetail: async (gameId) => {
    detailHit = String(gameId);
    return fetch(`${BASE}/api/match-detail?gameId=${encodeURIComponent(gameId)}`).then((r) => r.json());
  },
  /**
   * ★ 真的请求一次分析会花钱（调 DeepSeek），冒烟测试不该这么干。
   * 这里只记录「被调了、带没带 force」，然后用详情数据自己拼一份报告交差 ——
   * 界面该渲染的都渲染了，额度一分没动。
   */
  analyzeMatch: async (gameId, o) => {
    calls.push({ gameId: String(gameId), force: !!o?.force });
    analyzeHit = { gameId: String(gameId) };
    const v = await fetch(`${BASE}/api/match-detail?gameId=${encodeURIComponent(gameId)}`).then((r) => r.json());
    if (v?.hasReport) return { ok: true, report: v.report, fromCache: true };
    if (!v?.dataset) return { ok: false, error: '详情不可用' };
    return {
      ok: true,
      fromCache: false,
      report: { dataset: v.dataset, names: v.names, meta: { source: 'deepseek', model: 'smoke-stub' }, result: stubResult(v.dataset) },
    };
  },
  analyze: async () => ({ ok: false, error: 'smoke 不走这条' }),
  asset: (p) => `${BASE}/api/asset?p=${encodeURIComponent(p)}`,
  config: async () => ({ ai: { hasKey: false } }),
  accounts: async () => fetch(`${BASE}/api/accounts`).then((r) => r.json()),
  selectAccount: async (key) => fetch(`${BASE}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  }).then((r) => r.json()),
  reports: async () => ({ ok: true, reports: [] }),
  report: async () => ({}),
  watch: async () => ({ ok: true }),
  analyzeLatest: async () => ({ ok: false }),
  roster: async () => fetch(`${BASE}/api/roster`).then((r) => r.json()),
  searchSummoner: async (q) => {
    searchHit = String(q);
    return fetch(`${BASE}/api/summoner/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
  },
  summonerMatches: async (puuid) => {
    searchPuuidHit = String(puuid);
    return fetch(`${BASE}/api/summoner/matches?puuid=${encodeURIComponent(puuid)}`).then((r) => r.json());
  },
};

/* ── 跑 app.js ── */
let bootError = null;
try {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
} catch (e) {
  bootError = e;
}

await new Promise((r) => setTimeout(r, 900));

// 首页战绩列表是「打开时无 hash」的默认动作；本桩把 hash 定在 #report 上，
// 所以要手动点一次刷新，把首页榜单拉出来（走的是同一条 loadMatches）
get('#btnHomeRefresh').click();
await new Promise((r) => setTimeout(r, 900));

/* ── 断言 ── */
const fail = [];
// 战绩列表现在只有首页这一份（战报页的「战绩」页签已按需求去掉）
const homeHtml = get('#homeMatchList').innerHTML;
const homeRows = (homeHtml.match(/class="mh-row"/g) || []).length;

console.log('启动异常   :', bootError ? '✗ ' + bootError.message : '✓ 无');
if (bootError) fail.push('app.js 启动抛错');
console.log('战绩条数   :', realMatches.total, '| 首页渲染出的行数:', homeRows, homeRows === realMatches.matches.length ? '✓' : '✗');
if (homeRows !== realMatches.matches.length) fail.push('首页战绩行数与数据不符');
console.log('含英雄名   :', /辛德拉|弗拉基米尔|霞|锤石|卡尔萨斯/.test(homeHtml) ? '✓' : '✗');
if (!/辛德拉|弗拉基米尔|霞|锤石|卡尔萨斯/.test(homeHtml)) fail.push('列表里没有英雄名');
console.log('含胜/负    :', /mh-win (win|lose)/.test(homeHtml) ? '✓' : '✗');
console.log('含重判按钮 :', /mh-again/.test(homeHtml) ? '✓' : '✗');
if (!/mh-again/.test(homeHtml)) fail.push('列表缺重判按钮');

/* ── KDA 后面的关键数据（输出 / 承伤）──
   行内固定 9 个格子，其中数据格必须每行两个、且真出了数字（不是一行「—」糊过去）。 */
const statCells = (homeHtml.match(/class="mh-stat"/g) || []).length;
const statWithNum = (homeHtml.match(/class="mh-stat" title="[^"]*">\s*<b>\d/g) || []).length;
// 表头直接读 index.html（DOM 桩只认真 id，类选择器拿不到 .mh-head）
const headBlock = (fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').match(/<div class="mh-head">[\s\S]*?<\/div>/) || [''])[0];
const headCells = (headBlock.match(/<span>/g) || []).length;
console.log('关键数据列 :', `格子 ${statCells}（应=${realMatches.matches.length * 2}）`, statCells === realMatches.matches.length * 2 ? '✓' : '✗',
  `| 有数字 ${statWithNum} 格`, `| 表头 ${headCells} 列`, headCells === 9 ? '✓' : '✗');
if (statCells !== realMatches.matches.length * 2) fail.push('列表关键数据格数不对（应每行 2 格：输出 / 承伤）');
if (headCells !== 9) fail.push(`列表表头列数应为 9，实际 ${headCells}`);
if (statWithNum === 0) fail.push('关键数据格全是空的 —— 输出 / 承伤没接上数据');


const homeSumText = get('#homeSum').innerHTML.replace(/<[^>]+>/g, '').trim();
console.log('首页汇总   :', homeSumText || '(空)');
if (!/局/.test(homeSumText)) fail.push('首页汇总行没写入');

/* ── 账号：默认只看当前登录那个，能切换 ──
   一台机器换账号登录很常见，战绩混在一起就分不清哪些是自己打的。 */
const acctApi = await fetch(`${BASE}/api/accounts`).then((r) => r.json()).catch(() => null);
if (!acctApi?.ok) {
  console.log('账号接口   : ✗ /api/accounts 失败');
  fail.push('/api/accounts 不可用');
} else {
  const sel = get('#acctSelect');
  const opts = (sel.innerHTML.match(/<option /g) || []).length;
  const viewingName = (acctApi.accounts.find((a) => a.key === acctApi.viewing) || {}).name;
  const isCurrent = String(acctApi.viewing) === String(acctApi.current);
  console.log('账号下拉   :', opts, '项 |', viewingName || acctApi.viewing, isCurrent ? '✓ 默认=当前登录' : '（看的是非当前账号）');
  if (opts < 2) fail.push('账号下拉没渲染出选项');
  if (!isCurrent) fail.push('默认没有落在当前登录账号上');
  if (acctApi.current && !viewingName) fail.push('账号下拉里的名字是空的');

  // 列表条数必须等于「这个账号的局数」，不能把别人的混进来
  const owned = realMatches.matches.filter((m) => String(m.ownerPuuid) === String(acctApi.viewing)).length;
  console.log('账号隔离   :', `列表 ${realMatches.matches.length} 局 / 该账号 ${owned} 局`,
    realMatches.matches.length === owned ? '✓ 没有别人的局' : '✗ 混进了其他账号');
  if (realMatches.matches.length !== owned) fail.push('列表里混进了其他账号的对局');
  if (realMatches.allTotal && realMatches.allTotal === realMatches.total && acctApi.accounts.length > 2) {
    fail.push('账号过滤没生效（总数与全部相同）');
  }
}

/* ── 日期分割：一铺几百行，没有它就是一团 ── */
const dayHeads = (homeHtml.match(/class="mh-day"/g) || []).length;
const dayHasLabel = /class="day-name">[^<]+</.test(homeHtml);
const dayHasCount = /class="day-count">\d+ 局</.test(homeHtml);
console.log('日期分割   :', dayHeads, '个分组', dayHeads ? '✓' : '✗',
  '| 分组名:', dayHasLabel ? '✓' : '✗', '| 局数:', dayHasCount ? '✓' : '✗');
if (!dayHeads) fail.push('列表没有日期分割');
if (!dayHasLabel) fail.push('日期分割没有标题');
if (!dayHasCount) fail.push('日期分割没有局数');
// 分组数必须小于行数（否则等于每行一个分组，等于没分）
if (dayHeads && dayHeads >= homeRows) fail.push('日期分组数 >= 行数，等于没分组');

const homeRefreshWired = (get('#btnHomeRefresh')._handlers.click || []).length > 0;
const searchWired = (get('#btnSearch')._handlers.click || []).length > 0;
console.log('首页刷新   :', homeRefreshWired ? '✓ 已绑定' : '✗ 未绑定',
  '| 搜索按钮:', searchWired ? '✓ 已绑定（查本机名录）' : '✗ 未绑定');
if (!homeRefreshWired) fail.push('#btnHomeRefresh 未绑定');
if (!searchWired) fail.push('#btnSearch 未绑定');

// 时间轴：必须是一行一个时间点的列表（三列齐全），不能退回多列卡片网格
const tlHtml = get('#timeline').innerHTML;
const tlRows = (tlHtml.match(/class="tl-row"/g) || []).length;
const tlCols = ['tl-time', 'tl-kind', 'tl-body'].every((c) => tlHtml.includes(`class="${c}"`));
console.log('时间轴行数 :', tlRows, tlRows > 0 ? '✓ 列表' : '✗ 空',
  '| 三列:', tlCols ? '✓ 时间 / 类型 / 详情' : '✗ 缺列');
if (!tlRows) fail.push('时间轴没渲染出列表行');
if (!tlCols) fail.push('时间轴缺列');
if (/class="evidence"/.test(tlHtml)) fail.push('时间轴还在用旧的卡片结构');

// 敌我着色：时间轴是 10 人混排的唯一场所，名字必须带阵营标记才分得清谁是自己人
const sideMy = (tlHtml.match(/class="tl-name" data-side="my"/g) || []).length;
const sideEnemy = (tlHtml.match(/class="tl-name" data-side="enemy"/g) || []).length;
const sideUnknown = (tlHtml.match(/class="tl-name" data-side=""/g) || []).length;
console.log('敌我着色   :', `我方 ${sideMy} / 敌方 ${sideEnemy}`, sideMy && sideEnemy ? '✓ 可区分' : '✗ 缺失',
  sideUnknown ? `| ⚠ ${sideUnknown} 处认不出阵营` : '');
if (!sideMy || !sideEnemy) fail.push('时间轴没按敌我区分颜色');
if (sideUnknown) fail.push(`时间轴有 ${sideUnknown} 处名字认不出阵营`);

/* ── 评分表：分类展示 ──
   容器不再是固定的 rowsAlly / rowsEnemy —— 分组块由 app.js 按当前分类方式动态生成，
   所以按 data-group 从整块 HTML 里切出某一组，而不是去取一个写死的 id。 */
const groupHtmlOf = (id) => {
  const all = get('#sbGroups').innerHTML;
  return all.split('class="sb-block"').find((s) => s.startsWith(` data-group="${id}"`)) || '';
};
const sbGroupsHtml = get('#sbGroups').innerHTML;
const allyHtml = groupHtmlOf('Ally');
const enemyHtml = groupHtmlOf('Enemy');
const nAlly = (allyHtml.match(/class="sb-item"/g) || []).length;
const nEnemy = (enemyHtml.match(/class="sb-item"/g) || []).length;
console.log('评分表分组 :', `我方 ${nAlly} 人 / 敌方 ${nEnemy} 人`,
  nAlly === 5 && nEnemy === 5 ? '✓ 5v5' : '✗ 人数不对');
if (nAlly !== 5 || nEnemy !== 5) fail.push('评分表不是 5 人一组');

const allyAug = (allyHtml.match(/class="slot aug/g) || []).length;
const allyItems = (allyHtml.match(/class="slot item"/g) || []).length;
const bothCols = /class="sb-kda"/.test(allyHtml) && /class="sb-score"/.test(allyHtml) && /class="sb-tag"/.test(allyHtml);
console.log('行内六列   :', `KDA${/class="sb-kda"/.test(allyHtml) ? '✓' : '✗'}`,
  `海克斯${allyAug ? '✓' + allyAug : '✗'}`, `出装${allyItems ? '✓' + allyItems : '✗'}`,
  `评分${/class="sb-score"/.test(allyHtml) ? '✓' : '✗'}`, `头衔${/class="sb-tag"/.test(allyHtml) ? '✓' : '✗'}`);
if (!bothCols) fail.push('评分表行里缺 KDA / 评分 / 头衔');
// 样例是海克斯大乱斗：每人 4 个符文、6 件成装（守卫 / 饰品已滤掉）
if (allyAug !== 5 * 4) fail.push(`我方符文格子数为 ${allyAug}，期望 ${5 * 4}`);
if (allyItems !== 5 * 6) fail.push(`我方出装格子数为 ${allyItems}，期望 ${5 * 6}`);
if (!/title="暴击飞弹/.test(allyHtml)) fail.push('符文格子上没有中文名 tooltip');
if (!/title="莫雷洛秘典/.test(allyHtml)) fail.push('出装格子上没有中文名 tooltip');

// 详情行关键数据（v3.1）：KDA 之后是 输出 / 承伤 / 治疗 三小格，绝值为主、速率进 tooltip
const kvCells = (allyHtml.match(/class="kv"/g) || []).length;
const kvWithNum = (allyHtml.match(/class="kv" title="[^"]*">\s*<em>[^<]*<\/em>\s*<b>[\d.]/g) || []).length;
console.log('行内数据格 :', `输出/承伤/治疗 ${kvCells} 格`, kvCells === 5 * 3 ? '✓' : '✗',
  `| 有数字 ${kvWithNum} 格`);
if (kvCells !== 5 * 3) fail.push(`详情行关键数据格 ${kvCells}，期望 ${5 * 3}（5 人 × 输出/承伤/治疗）`);

// 名字按阵营着色（v1.1.2）：我方绿 / 敌方红 —— 评分表每行那个 <em> 里的昵称
const nmAlly = (allyHtml.match(/<em><span class="nm" data-side="my"/g) || []).length;
const nmEnemy = (enemyHtml.match(/<em><span class="nm" data-side="enemy"/g) || []).length;
console.log('名字阵营色 :', `我方绿 ${nmAlly} / 敌方红 ${nmEnemy}`,
  nmAlly === 5 && nmEnemy === 5 ? '✓' : '✗');
if (nmAlly !== 5) fail.push(`我方名字着色 ${nmAlly} 处，期望 5`);
if (nmEnemy !== 5) fail.push(`敌方名字着色 ${nmEnemy} 处，期望 5`);

// 我方胜负：客观数据，所以详情态（未判定）也要亮 —— 判定与否都不该影响它
const resCls = get('#resBadge').className;
const resText = get('#resBadge').textContent;
console.log('我方胜负   :', `"${resText}"（${resCls}）`,
  /res-badge (win|lose)/.test(resCls) ? '✓' : '✗');
if (!/res-badge (win|lose)/.test(resCls)) fail.push('对局详情没有显示我方胜负');

// 标签文案：BLAME 的中文名必须是「背锅侠」，不能再是「战犯」
const allSb = allyHtml + enemyHtml;
console.log('标签文案   :', /背锅侠/.test(allSb) ? '✓ 含「背锅侠」' : '✗ 没有背锅侠',
  /战犯/.test(allSb) ? '✗ 仍有「战犯」' : '✓ 无「战犯」');
if (!/背锅侠/.test(allSb)) fail.push('评分表里没有「背锅侠」标签');
if (/战犯/.test(allSb)) fail.push('评分表里仍出现「战犯」');

// 提示词里也不能再出现「战犯」（模型看到的词要跟界面一致）
const promptJs = fs.readFileSync(path.join(WEB, 'prompt.js'), 'utf8');
if (/战犯/.test(promptJs)) fail.push('web/prompt.js 里仍有「战犯」');

/* ── 分类切换：同一批数据换三种排法，人数必须守恒 ──
   这是纯前端重排 —— 不碰接口、不动数据；切完再切回来，跟没切过一样。 */
{
  const totalRows = (html) => (html.match(/class="sb-item"/g) || []).length;
  const groupNames = (html) => [...html.matchAll(/class="gt-name">([^<]*)</g)].map((m) => m[1]);
  const sideRows = totalRows(sbGroupsHtml);

  groupBtns.find((b) => b.dataset.group === 'label').click();
  const byLabel = get('#sbGroups').innerHTML;
  groupBtns.find((b) => b.dataset.group === 'role').click();
  const byRole = get('#sbGroups').innerHTML;
  // 切回「按阵营」—— 后面详情态 / 回放的断言都是按默认视图写的
  groupBtns.find((b) => b.dataset.group === 'side').click();
  const backHtml = get('#sbGroups').innerHTML;

  const labelNames = groupNames(byLabel);
  const roleNames = groupNames(byRole);
  const conserved = totalRows(byLabel) === sideRows && totalRows(byRole) === sideRows
    && totalRows(backHtml) === sideRows;
  console.log('分类切换   :',
    `阵营 ${sideRows} 人 / 结论 ${totalRows(byLabel)} 人（${labelNames.join('·') || '无'}）`
    + ` / 定位 ${totalRows(byRole)} 人（${roleNames.join('·') || '无'}）`,
    conserved ? '✓ 人数守恒' : '✗ 换分类后人数对不上');
  if (!sideRows) fail.push('评分表一行都没有，分类切换无从验起');
  if (!conserved) fail.push('分类切换后人数不守恒');
  if (labelNames.length < 2) fail.push('「按结论」没有分出组来');
  if (roleNames.length < 2) fail.push('「按定位」没有分出组来');
  if (!groupNames(backHtml).length) fail.push('切回「按阵营」后分组名丢了');
}

/* ── 静态检查 index.html：桩 DOM 看不到真实 HTML，这几条只能读文件 ──
     恰好是这次改版的落点：去掉重复的战绩页签、去掉重复的入口。 */
const pageHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const reportTabs = [...pageHtml.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const tabsOk = reportTabs.length === 3 && REPORT_TABS.every((t) => reportTabs.includes(t));
console.log('战报页页签 :', reportTabs.join(' / '), tabsOk ? '✓ 已无「战绩」页签' : '✗ 与预期不符');
if (!tabsOk) fail.push('战报页页签不是 战报/播报/历史');
const leftovers = [['战绩 pane', /data-pane="matches"/], ['战绩列表', /id="matchList"/], ['完整战绩页入口', /id="btnMatches"/]];
leftovers.forEach(([what, re]) => { if (re.test(pageHtml)) fail.push(`index.html 里还留着${what}`); });

/* ── 播报稿：同一局里不能出现两句一模一样的话 ──
     v1.2.6 之前每个标签只有一句模板，三个混子就把「全程隐身，伤害呢？」念三遍。
     修法是「句式池按标签内出场序号轮换 + 每句填进这个人本局实际做的事」，
     这里两条都盯：① 逐句去重；② 句子里必须带本局事实（不是空模板）。 */
{
  const castBox = get('#castText');
  const castText = (castBox?.innerHTML || '')
    .replace(/<[^>]+>/g, ' ')      // 去掉着色 span，只留文字
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);
  const dup = new Map();
  for (const s of castText) dup.set(s, (dup.get(s) || 0) + 1);
  const repeated = [...dup.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  console.log('播报去重   :', castText.length, '句 |', repeated.length ? `✗ 重复 ${repeated.length} 句（${repeated[0]}）` : '✓ 无重复句');
  if (repeated.length) fail.push('播报稿里有重复句：' + repeated.join(' / '));
  // 至少要有一句带**本局事实**（数字或「全场第一 / 扛伤最多 / 治疗」这类定位），
  // 证明白板模板没退回去。只数数字会误报 —— 高光也可能是定性的说法。
  const FACT = /\d|全场第一|全场垫底|全场最多|扛伤最多|治疗全场|控制时长全场|参团不到/;
  const withFacts = castText.filter((s) => FACT.test(s));
  console.log('播报带事实 :', withFacts.length, '句带本局事实', withFacts.length >= 1 ? '✓' : '✗ 太少（像空模板）');
  if (withFacts.length < 1) fail.push('播报稿几乎没有本局事实，退化成模板了');
  if (process.env.BBX_SHOW_CAST) {
    console.log('  ── 播报稿全文（调试用，设 BBX_SHOW_CAST=1 才打）──');
    castText.forEach((s) => console.log('    · ' + s));
  }
}

/* ── 点一行 → 先看详情，**不调模型** ──
   这次改版的核心：看与判分开。点行只读数据，判定要另外点一次，免得「看一眼」也花钱。 */
const rowHandler = get('#homeMatchList')._handlers.click || [];
const noRepMatch = realMatches.matches.find((m) => !m.analyzedAt);
const firstId = (noRepMatch || realMatches.matches[0])?.gameId;

if (!rowHandler.length) {
  fail.push('#homeMatchList 没绑 click');
  console.log('点行看详情 : ✗ 未绑定');
} else {
  calls.length = 0; analyzeHit = null; detailHit = null;
  const fakeRow = makeEl('.mh-row');
  fakeRow.dataset.gameId = String(firstId);
  // 真实 DOM 里 e.target.closest('.mh-row') 会返回这一行本身，桩必须照做
  fakeRow.closest = (sel) => (sel === '.mh-row' ? fakeRow : null);

  const w = watchPages(Date.now());
  rowHandler[0]({ target: fakeRow, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 1500));
  w.stop();

  const onReport = get('#page-report').classList.contains('active');
  console.log('点行看详情 :', detailHit === String(firstId) ? `✓ 已拉详情 ${firstId}` : '✗ 没拉详情',
    '| 没调模型:', calls.length === 0 ? '✓' : `✗ 竟然调了 ${calls.length} 次`,
    '| 进战报页:', onReport ? '✓' : '✗',
    '| 没闪进度页:', w.seen ? '✗' : '✓');
  if (detailHit !== String(firstId)) fail.push('点行没去拉对局详情');
  if (calls.length) fail.push('点行竟然直接调了模型（应当只读详情）');
  if (!onReport) fail.push('点行后没进战报页');
  if (w.seen) fail.push('只读详情却闪了「正在生成战报」页');
}

/* ── 详情态：客观数据照给，评分 / 结论两列留白，页顶给一颗「开始分析」 ── */
if (noRepMatch && !noRepMatch.analyzedAt) {
  const hintText = get('#analyzeHint').textContent || '';
  const btnText = get('#btnDoAnalyze').textContent || '';
  const allyDetail = groupHtmlOf('Ally');
  const tlRowsD = (get('#timeline').innerHTML.match(/class="tl-row"/g) || []).length;
  // 胜负来自客观数据，未判定也得亮 —— 这里正是需求点名的「对局详情」
  const resClsD = get('#resBadge').className;
  console.log('详情态     :', /还没判定/.test(hintText) ? '✓ 提示未判定' : '✗ 提示不对',
    '| 按钮:', btnText, btnText === '开始分析' ? '✓' : '✗',
    '| 评分列留白:', /待分析/.test(allyDetail) ? '✓' : '✗',
    '| 时间轴:', tlRowsD, '行',
    '| 我方胜负:', /res-badge (win|lose)/.test(resClsD) ? '✓ ' + get('#resBadge').textContent : '✗ 未显示');
  if (!/还没判定/.test(hintText)) fail.push('详情态没提示「还没判定」');

  /* 对局 ID 徽标：页顶右缘，判定前后都要显示同一个号（方便核对是不是同一局） */
  const chip = get('#gidChip');
  const chipText = chip?.textContent || '';
  const shownGid = get('#resBadge') && noRepMatch ? String(noRepMatch.gameId) : '';
  const gidOk = chip && !chip.classList.contains('hidden') && /^#\d{6,}$/.test(chipText);
  console.log('  └ 对局ID:', gidOk ? `✓ 显示「${chipText}」` : `✗ 没显示（textContent="${chipText}"）`);
  if (!gidOk) fail.push('页顶没显示对局 ID');
  if (gidOk && shownGid && chipText.slice(1) !== shownGid) {
    console.log(`    ✗ 与列表里的 gameId 对不上：页面 ${chipText} / 列表 ${shownGid}`);
    fail.push('对局 ID 与当前这局不一致');
  }
  if (btnText !== '开始分析') fail.push(`详情态按钮文案是「${btnText}」，期望「开始分析」`);
  if (!/待分析/.test(allyDetail)) fail.push('详情态的评分/结论列没写「待分析」');
  if (!tlRowsD) fail.push('详情态没有时间轴');
  if (!/res-badge (win|lose)/.test(resClsD)) fail.push('详情态没显示我方胜负');
} else {
  console.log('详情态     : ⚠ 没有未判定过的局，跳过');
}

/* ── 点「开始分析」→ 这时候才真的调模型 ── */
calls.length = 0; analyzeHit = null;
const wBtn = watchPages(Date.now());
get('#btnDoAnalyze').click();
await new Promise((r) => setTimeout(r, 2500));
wBtn.stop();
console.log('开始分析   :', calls.length ? `✓ 已请求（force=${calls[0].force}）` : '✗ 没请求',
  '| 进度页:', wBtn.seen ? '✓ 有亮（真判定）' : '✗ 没亮');
if (!calls.length) fail.push('点「开始分析」没触发分析');
if (calls.length && calls[0].force) fail.push('详情态的「开始分析」不该带 force');

/**
 * 采样器：判定过程中「正在生成战报」页有没有被亮起来过。
 * 终态会被 show('report') 覆盖，只看结束时的状态什么都验不出来 —— 只能边跑边采。
 * 顺带记下「进战报页」的真实耗时。
 */
function watchPages(t0) {
  const box = { seen: false, reportMs: null };
  box.timer = setInterval(() => {
    if (get('#page-analyzing').classList.contains('active')) box.seen = true;
    if (box.reportMs === null && get('#page-report').classList.contains('active')) {
      box.reportMs = Date.now() - t0;
    }
  }, 10);
  box.stop = () => clearInterval(box.timer);
  return box;
}

// 模拟点击「重判」→ force 应为 true（同时作为反向对照：真判定必须亮进度页）
calls.length = 0;
analyzeHit = null;
const fakeBtn = makeEl('.mh-again');
fakeBtn.closest = (sel) => (sel === '.mh-again' ? fakeBtn : null);
fakeBtn.dataset.gameId = String(firstId);
const ctl = watchPages(Date.now());
get('#homeMatchList')._handlers.click[0]({ target: fakeBtn, stopPropagation() {} });
await new Promise((r) => setTimeout(r, 2500));
ctl.stop();
console.log('重判按钮   : ', calls[0]?.force ? '✓ force=true' : '✗ 未带 force',
  '| 进度页:', ctl.seen ? '✓ 有亮（对照成立）' : '✗ 没亮（下面那条断言不可信）');
if (!calls[0]?.force) fail.push('重判未带 force');
if (!ctl.seen) fail.push('重判没亮进度页 —— 对照失效，缓存那条断言会假通过');

/* ── 已判定过的局：点它直接回放盘里的战报，同样不调模型、不闪进度页 ── */
const analyzedOne = realMatches.matches.find((m) => m.analyzedAt);
if (!analyzedOne) {
  console.log('已判定回放 : ⚠ 没有已分析过的局，跳过');
} else {
  calls.length = 0; detailHit = null;
  const row = makeEl('.mh-row');
  row.dataset.gameId = String(analyzedOne.gameId);
  row.closest = (sel) => (sel === '.mh-row' ? row : null);

  const t0 = Date.now();
  const w = watchPages(t0);
  get('#homeMatchList')._handlers.click[0]({ target: row, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 1200));
  w.stop();

  const onReport = get('#page-report').classList.contains('active');
  const gotVerdict = !/还没判定/.test(get('#analyzeHint').textContent || '');
  // 敌我分组形状：回放的战报也该是 5v5，不该全挤在一边。
  // 这条守的是一个真实踩过的坑 —— 换账号后重判别人的局时视角认不出「我方」是哪边，
  // normalize 里 `teamId === null` 恒为 false，10 个人全被算成「敌方」。
  // 人数直接从分组块里数行 —— #cntAlly 这个 id 现在由分类方式决定，
  // 不再是个恒定的锚点（按结论时压根没有「我方」这一组）
  const cntGroup = (id) => (groupHtmlOf(id).match(/class="sb-item"/g) || []).length;
  const allyN = cntGroup('Ally');
  const enemyN = cntGroup('Enemy');
  console.log('已判定回放 :', w.seen ? '✗ 闪了进度页' : '✓ 没闪进度页',
    `| 落点:${onReport ? '✓ 战报页' : '✗ 没进'}`,
    `| 带判定:${gotVerdict ? '✓' : '✗'}`,
    `| 未调模型:${calls.length ? '✗' : '✓'}`,
    `| 敌我:${allyN} v ${enemyN}`,
    `| 耗时 ${w.reportMs ?? '—'}ms`);
  if (w.seen) fail.push('已判定的局点开时仍闪了「正在生成战报」页');
  if (!onReport) fail.push('已判定的局点开后没进战报页');
  if (!gotVerdict) fail.push('已判定的局打开后没带出判定（回放失败）');
  if (calls.length) fail.push('回放已判定的局不该再调模型');
  if (allyN === 0 || enemyN === 0) fail.push(`回放的战报敌我分组塌了（我方 ${allyN} 人 / 敌方 ${enemyN} 人）`);
}

/* ── 返回按钮：首页 → 点一行进战报页 → 返回 ──
     「完整战绩页」那个入口已随战绩页签一起去掉，所以进战报页的路径改成点战绩行。 */
const backHandlers = get('#btnBack')._handlers.click || [];
console.log('返回按钮   :', backHandlers.length ? '✓ 已绑定' : '✗ 未绑定');
if (!backHandlers.length) fail.push('#btnBack 未绑定 click');

if (backHandlers.length) {
  // 摆回首页
  get('#page-idle').classList.add('active');
  get('#page-report').classList.remove('active');

  // 点一条已分析过的记录：读盘即出，稳定落在战报页
  const enterRow = makeEl('.mh-row');
  enterRow.dataset.gameId = String((realMatches.matches.find((m) => m.analyzedAt) || realMatches.matches[0]).gameId);
  enterRow.closest = (sel) => (sel === '.mh-row' ? enterRow : null);
  get('#homeMatchList')._handlers.click[0]({ target: enterRow, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 1500));

  const onReport = get('#page-report').classList.contains('active');
  const backShown = !get('#btnBack').classList.contains('hidden');
  const reportTabActive = tabEls.some((t) => t.dataset.tab === 'report' && t.classList.contains('active'));
  console.log('点战绩行进 :', onReport ? '✓ 进入战报页' : '✗ 没进战报页',
    '| 返回按钮可见:', backShown ? '✓' : '✗', '| 落在战报页签:', reportTabActive ? '✓' : '✗');
  if (!onReport) fail.push('点战绩行没进战报页');
  if (!backShown) fail.push('战报页里返回按钮没出现');
  if (!reportTabActive) fail.push('没落在战报页签');

  // 点返回 → 应回首页，且返回按钮消失
  backHandlers[0]({ target: get('#btnBack') });
  await new Promise((r) => setTimeout(r, 300));
  const backToIdle = get('#page-idle').classList.contains('active');
  const backHidden = get('#btnBack').classList.contains('hidden');
  console.log('点返回     :', backToIdle ? '✓ 回到首页' : '✗ 没回到首页',
    '| 返回按钮隐去:', backHidden ? '✓' : '✗');
  if (!backToIdle) fail.push('点返回没回首页');
  if (!backHidden) fail.push('首页里返回按钮没隐藏');
}

/* ── 查询召唤师：只能查到本机见过的人；结果与「我的战绩」互不覆盖 ──
   数据隔离是重点：查询只切换显示，不写索引、不动账号归属。 */
const searchName = acctApi?.currentName || null;
const searchHandlers = get('#btnSearch')._handlers.click || [];
if (!searchName || !searchHandlers.length) {
  console.log('查询召唤师 : ⚠ 拿不到可查的名字或按钮未绑定，跳过');
  if (!searchHandlers.length) fail.push('#btnSearch 未绑定 click');
} else {
  const input = get('#searchInput');
  input.value = searchName;
  calls.length = 0; searchHit = null; searchPuuidHit = null;

  // 摆回首页再搜
  get('#page-idle').classList.add('active');
  get('#page-report').classList.remove('active');

  searchHandlers[0]({ target: get('#btnSearch'), stopPropagation() {} });

  // 首次查询要逐局读详情（几百局就是好几秒），固定 sleep 会误判成「没切标题」——
  // 改成轮询等它真落到查询态，再留一点时间让 renderMatches 把行铺完。
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 300));
    if (/的战绩/.test(get('#homeTitle').textContent || '')) break;
  }
  await new Promise((r) => setTimeout(r, 800));

  const title = get('#homeTitle').textContent || '';
  const exitShown = !get('#btnExitSearch').classList.contains('hidden');
  const acctBoxHidden = get('#acctBox').classList.contains('hidden');
  const rowsHtml = get('#homeMatchList').innerHTML;
  const sRows = (rowsHtml.match(/class="mh-row"/g) || []).length;
  const api = await fetch(`${BASE}/api/summoner/matches?puuid=${encodeURIComponent(searchPuuidHit || '')}`)
    .then((r) => r.json()).catch(() => null);

  console.log('查询召唤师 :', searchHit === searchName ? `✓ 已查「${searchHit}」` : `✗ 查询参数是「${searchHit}」`,
    '| 局数:', sRows, api?.total != null ? `（接口 ${api.total}）` : '',
    '| 标题:', title);
  console.log('  └ 查询态  :', /的战绩/.test(title) ? '✓ 标题已切' : '✗ 标题没切',
    '| 退出按钮:', exitShown ? '✓ 可见' : '✗ 隐藏',
    '| 账号下拉让位:', acctBoxHidden ? '✓' : '✗');
  if (searchHit !== searchName) fail.push('搜索没有把关键词传出去');
  if (!searchPuuidHit) fail.push('搜索后没有去拉某人的战绩');
  if (!/的战绩/.test(title)) fail.push('查询态没有切换列表标题');
  if (!exitShown) fail.push('查询态没有「退出查询」按钮');
  if (!acctBoxHidden) fail.push('查询态没有把账号下拉藏起来（两个入口会打架）');
  if (api?.total != null && sRows !== api.total) fail.push(`查询列表 ${sRows} 行，与接口的 ${api.total} 局不符`);

  // 数据隔离：查询不该往「我的战绩」索引里写东西
  const idxAfterSearch = await fetch(`${BASE}/api/matches?limit=500&refresh=0`).then((r) => r.json()).catch(() => null);
  if (idxAfterSearch?.ok && realMatches?.ok && idxAfterSearch.total !== realMatches.total) {
    fail.push(`查询改动了「我的战绩」条数：${realMatches.total} → ${idxAfterSearch.total}`);
  }

  // 退出查询 → 回到自己的战绩
  get('#btnExitSearch').click();
  await new Promise((r) => setTimeout(r, 1500));
  const titleBack = get('#homeTitle').textContent || '';
  const exitHidden = get('#btnExitSearch').classList.contains('hidden');
  const backRows = (get('#homeMatchList').innerHTML.match(/class="mh-row"/g) || []).length;
  console.log('  └ 退出查询:', titleBack === '战绩' ? '✓ 标题还原' : `✗ 标题是「${titleBack}」`,
    '| 退出按钮:', exitHidden ? '✓ 已隐去' : '✗ 还在',
    '| 列表回到:', backRows, '行');
  if (titleBack !== '战绩') fail.push('退出查询后标题没还原');
  if (!exitHidden) fail.push('退出查询后按钮没隐去');
  if (backRows !== realMatches.matches.length) fail.push('退出查询后「我的战绩」行数不对（被覆盖了）');
}

/* ── 配置页：主页进入 / 页签作用域 / 返回主页 ──
   配置（设置 / 提示词）不该挂在战报详情里，只能从主页进 —— 这段就是守这条线。 */
const cfgBtnSettings = get('#btnSettings')._handlers.click || [];
const cfgBtnPrompt = get('#btnPrompt')._handlers.click || [];
const cfgWired = cfgBtnSettings.length > 0 && cfgBtnPrompt.length > 0;
console.log('配置入口   :', cfgWired ? '✓ 主页已挂 设置 / 提示词' : '✗ 未绑定');
if (!cfgWired) fail.push('主页配置入口未绑定');

if (cfgWired && backHandlers.length) {
  // 摆回主页
  get('#page-idle').classList.add('active');
  get('#page-report').classList.remove('active');
  get('#page-config').classList.remove('active');

  cfgBtnSettings[0]({ target: get('#btnSettings') });
  await new Promise((r) => setTimeout(r, 200));

  const onConfig = get('#page-config').classList.contains('active');
  const cfgBackShown = !get('#btnBack').classList.contains('hidden');
  const setTabOn = cfgTabEls.some((t) => t.dataset.ctab === 'settings' && t.classList.contains('active'));
  const setPaneOn = cfgPaneEls.some((p) => p.dataset.pane === 'settings' && p.classList.contains('active'));
  console.log('主页→设置  :', onConfig ? '✓ 进入配置页' : '✗ 没进配置页',
    '| 返回按钮:', cfgBackShown ? '✓ 可见' : '✗ 隐藏',
    '| 设置面板:', (setTabOn && setPaneOn) ? '✓ 激活' : '✗ 未激活');
  if (!onConfig) fail.push('点设置没进配置页');
  if (!cfgBackShown) fail.push('配置页里返回按钮没出现');
  if (!setTabOn || !setPaneOn) fail.push('设置页签/面板没被激活');

  // 配置页内切页签：只该动配置页的 pane，战报页的 pane 一个都不能变
  const reportPaneBefore = paneEls.filter((p) => p.classList.contains('active')).map((p) => p.dataset.pane).join(',');
  cfgTabEls.find((t) => t.dataset.ctab === 'prompt').click();
  await new Promise((r) => setTimeout(r, 150));
  const promptPaneOn = cfgPaneEls.some((p) => p.dataset.pane === 'prompt' && p.classList.contains('active'));
  const reportPaneAfter = paneEls.filter((p) => p.classList.contains('active')).map((p) => p.dataset.pane).join(',');
  const isolated = reportPaneBefore === reportPaneAfter;
  console.log('配置页切签 :', promptPaneOn ? '✓ 提示词面板激活' : '✗ 没切换',
    '| 未串扰战报页:', isolated ? '✓' : '✗');
  if (!promptPaneOn) fail.push('配置页切提示词无效');
  if (!isolated) fail.push('配置页页签串改了战报页的 pane');

  // 点返回 → 回主页
  backHandlers[0]({ target: get('#btnBack') });
  await new Promise((r) => setTimeout(r, 250));
  const cfgHome = get('#page-idle').classList.contains('active');
  const cfgBackHidden = get('#btnBack').classList.contains('hidden');
  console.log('配置页返回 :', cfgHome ? '✓ 回到主页' : '✗ 没回主页', '| 返回隐去:', cfgBackHidden ? '✓' : '✗');
  if (!cfgHome) fail.push('配置页返回没回主页');
  if (!cfgBackHidden) fail.push('主页里返回按钮没隐藏');
}

/* ── 判定过程：服务端推 judging → 进度页显示**真**状态，而不是干转假动画 ──
   判定十几秒起步，界面要能说出「模型在写、写了多少字」，兜底时还要给原因。
   真机调一次模型要几厘钱，所以这里用投喂的方式验渲染契约。 */
{
  const inst = sseHandlers[0];
  const hasSse = typeof inst === 'function';
  console.log('判定过程   :', hasSse ? `✓ 已订阅 SSE（${sseHandlers.length} 个回调）` : '✗ 没订阅上（judging 收不到）');
  if (!hasSse) fail.push('SSE 没订阅，判定过程推不到界面');

  if (hasSse) {
    const push = (ev) => inst(ev);
    // 判定页要在前面 —— 真机上只有等判定才会停在这一页
    get('#page-analyzing').classList.add('active');

    push({ type: 'judging', phase: 'stream', elapsedMs: 3200, chars: 1204 });
    await new Promise((r) => setTimeout(r, 60));
    const stBox = get('#judgeStatus');
    const shown = !stBox.classList.contains('hidden');
    const txt = get('#judgeText').textContent || '';
    const meta = get('#judgeMeta').textContent || '';
    console.log('  └ 输出中  :', shown ? '✓ 状态行已显示' : '✗ 还藏着',
      `| 文案「${txt}」`, `| 细节「${meta}」`);
    if (!shown) fail.push('收到 stream 进度后状态行没显示');
    if (!/模型输出中/.test(txt)) fail.push('stream 阶段没显示「模型输出中」');
    if (!/已输出/.test(meta)) fail.push('stream 阶段没显示已输出字数');

    push({ type: 'judging', phase: 'fallback', reason: '模型输出中断超过 60 秒' });
    await new Promise((r) => setTimeout(r, 60));
    const fbCls = get('#judgeStatus').classList.contains('is-fallback');
    const fbTxt = get('#judgeText').textContent || '';
    const fbMeta = get('#judgeMeta').textContent || '';
    console.log('  └ 兜底    :', fbCls ? '✓ 标成警示色' : '✗ 没标',
      `| 文案「${fbTxt}」`, `| 原因「${fbMeta}」`);
    if (!fbCls) fail.push('兜底时状态行没标警示');
    if (!/兜底/.test(fbTxt)) fail.push('兜底时没说清已改用本地兜底');
    if (!/60 秒/.test(fbMeta)) fail.push('兜底时没显示原因');

    /* ── 回归（v1.2.1 事故）：真进度在动画收尾前到达，也不能把界面困在进度页 ──
       当年那版 stopFakeSteps() 会把「最后一步里带 resolve 的那个定时器」一起清掉，
       animateSteps 的 Promise 永远不 resolve → `await anim` 挂死 →
       判定早就完成、状态行写着「判定完成」，页面却不往下走，而且那一页没有任何出口。
       真判定动辄十几秒，必然落在这个窗口里。所以这里必须复现「动画 + 中途让位」的时序。 */
    const reportPage = get('#page-report');
    const analyzingPage = get('#page-analyzing');
    analyzingPage.classList.add('active');
    reportPage.classList.remove('active');
    get('#btnDoAnalyze').click();                       // → animateSteps() 开工
    await new Promise((r) => setTimeout(r, 150));      // 让它跑起来
    push({ type: 'judging', phase: 'stream', elapsedMs: 150, chars: 300 });  // 真进度抢戏
    await new Promise((r) => setTimeout(r, 2400));     // 越过动画收尾窗口（minMs 900 + 320ms）
    const stuck = analyzingPage.classList.contains('active');
    console.log('  └ 不卡进度页:', stuck ? '✗ 仍停在「正在生成战报」' : '✓ 已离开');
    if (stuck) fail.push('真进度中途接管后界面卡在进度页（await anim 挂死）');
    get('#page-report').classList.add('active');
    get('#page-analyzing').classList.remove('active');
  }
}

console.log('');
if (fail.length) { console.log('结果：✗ ' + fail.join(' / ')); process.exit(1); }
console.log('结果：✓ 账号隔离与切换、日期分割、首页战绩、列表关键数据列（输出/承伤）、评分表分类展示与列、'
  + '分类切换（阵营 / 结论 / 定位）、标签文案、页签去重、点行看详情、开始分析、重判、已判定回放、返回、'
  + '查询召唤师与数据隔离、配置页入口与页签隔离 全部通过');
