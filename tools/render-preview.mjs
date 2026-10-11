/**
 * 战报页静态渲染器 —— 把真实渲染结果落成一份自包含 HTML，用来「眼见为实」。
 *
 * 为什么需要：这台机器 npm 不通装不了无头浏览器；更麻烦的是页面挂着 SSE 长连接，
 * Edge --headless 永远等不到 idle，截图两次都超时。既然 web/app.js 是纯 DOM 操作，
 * 那就用和 ui-smoke 同一套 DOM 桩把它真跑一遍，再把渲染出来的 innerHTML
 * 灌回 index.html 的对应容器 —— 出来的就是浏览器里那份 DOM，只是没有 JS 而已。
 *
 * 两种数据来源：
 *   --mode=sample（默认）真实数据 + 真实判定，但不调模型：
 *        样例包（prototype/sample）里有完好的 playerAugment1-6，
 *        落盘战报 401141430317.json 里有这一局模型已经判好的结果。
 *        两者是同一局，pid 也逐一对得上 —— 拼起来就是「新格式界面」的真面貌。
 *   --mode=live  直接读盘里那份战报，看到的是当前真实状态（老战报这两列是「—」）。
 *
 * 用法：node tools/render-preview.mjs [--mode=sample|live] [--out=preview/report-preview.html]
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSampleBundle } from '../server/service.mjs';
import { loadGameData } from '../src/lcu/gamedata.mjs';
import { normalize } from '../src/lcu/normalize.mjs';
import { restoreResultText } from '../src/deepseek/judge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const BASE = process.env.BBX_BASE || 'http://127.0.0.1:7712';

/* ── 会话令牌 ──
   服务只认「本机界面」：/api/* 一律要随首屏 HTML 下发的令牌（见 server.mjs）。
   本工具跑的是真服务，所以先取一次首页拿令牌；POST 还要显式声明 JSON（415 校验）。 */
const TOKEN = await (async () => {
  try {
    const html = await (await globalThis.fetch(`${BASE}/`)).text();
    const m = html.match(/name="bbx-token" content="([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
})();
const fetch = (url, opts = {}) => globalThis.fetch(url, {
  ...opts,
  headers: {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(TOKEN ? { 'X-BBX-Token': TOKEN } : {}),
    ...(opts.headers || {}),
  },
});

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const MODE = arg('mode', 'sample');
const PAGE = arg('page', 'report');       // report | home
/**
 * 战报页要摆哪一种状态 —— 现在「看」和「判」是两条路，值得各出一张：
 *   report（默认）点开一局已判定过的：有评分结论、按钮是「重新判定」
 *   detail        点开一局还没判定的：只有客观数据，按钮是「开始分析」
 * 两条都走界面自己的真实路径（BBX.matchDetail → applyReport / applyDetail），
 * 不是把渲染结果拼出来——所以快照能当回归证据用。
 */
const STATE = arg('state', 'report');     // report | detail
/**
 * 评分表的分类方式 —— 与界面「分类」那排切换钮一一对应：
 *   side（默认）按阵营：谁是我的队友
 *   label       按结论：谁该背锅
 *   role        按定位：这阵容缺了什么
 * 同一批数据换个排法，三张图摆一起才看得出分类到底改了什么。
 */
const GROUP = arg('group', 'side');       // side | label | role
const GROUP_CN = { side: '按阵营', label: '按结论', role: '按定位' };
// 已判定态沿用老文件名（README 里引的就是它）；另两种状态各加后缀，免得互相覆盖
const OUT = path.resolve(ROOT, arg('out', `preview/${PAGE}-preview.${MODE}`
  + (STATE === 'report' ? '' : `.${STATE}`)
  + (GROUP === 'side' ? '' : `.${GROUP}`)
  + '.html'));

/* ── 最小 DOM（与 tools/ui-smoke.mjs 同构） ── */

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
const TAB_SEL = /^#tabs \.tab\[data-tab="([^"]+)"\]$/;
const CFG_TAB_SEL = /^#cfgTabs \.tab\[data-ctab="([^"]+)"\]$/;
const REPORT_TABS = ['report', 'cast', 'history'];
const CFG_TABS = ['settings', 'prompt'];
const tabEls = REPORT_TABS.map((t) => { const e = makeEl('#tabs .tab'); e.dataset.tab = t; return e; });
const cfgTabEls = CFG_TABS.map((t) => { const e = makeEl('#cfgTabs .tab'); e.dataset.ctab = t; return e; });
const paneEls = REPORT_TABS.map((t) => { const e = makeEl('#page-report .pane'); e.dataset.pane = t; return e; });
const cfgPaneEls = CFG_TABS.map((t) => { const e = makeEl('#page-config .pane'); e.dataset.pane = t; return e; });

// 分类切换钮 —— 界面用 `$$('#groupBy .seg-btn')` 一次绑三颗，桩得照单全收
const GROUP_BTNS = ['side', 'label', 'role'];
const groupBtns = GROUP_BTNS.map((g) => {
  const e = makeEl('#groupBy .seg-btn');
  e.dataset.group = g;
  return e;
});

const get = (sel) => {
  let m = TAB_SEL.exec(sel);
  if (m) { const hit = tabEls.find((e) => e.dataset.tab === m[1]); if (hit) return hit; }
  m = CFG_TAB_SEL.exec(sel);
  if (m) { const hit = cfgTabEls.find((e) => e.dataset.ctab === m[1]); if (hit) return hit; }
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

/* ── 组装要给界面渲染的那份战报 ── */

const realMatches = await fetch(`${BASE}/api/matches?limit=500`).then((r) => r.json()).catch(() => null);
if (!realMatches?.ok) {
  console.error('[skip] 本地服务未就绪或 /api/matches 失败，先启动 start.bat');
  process.exit(2);
}

let report;
let pick;

if (MODE === 'sample') {
  const sample = loadSampleBundle();
  if (!sample?.eog) { console.error('[fatal] 样例包缺失，先跑 tools/capture-to-sample.mjs'); process.exit(1); }

  const gamedata = await loadGameData(null, { cacheFile: path.join(ROOT, 'data', 'gamedata.json') });
  const dataset = normalize(sample.eog, {
    championMap: sample.champions,
    gameData: gamedata,
    matchDetail: sample.matchDetail,
    timeline: sample.timeline,
    session: sample.session,
  });

  const gid = dataset.match.gameId;
  const savedFile = path.join(ROOT, 'data', 'reports', `${gid}.json`);
  if (!fs.existsSync(savedFile)) {
    console.error(`[fatal] 样例这局（${gid}）没有落盘战报，没有判定文本可配`);
    process.exit(1);
  }
  const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
  const namesIdx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'names.json'), 'utf8'));
  const names = namesIdx.entries?.[gid] || saved.names || {};

  report = {
    meta: { ...saved.meta, gameDataFrom: gamedata?.from || null, usage: saved.meta?.usage || null, source: 'mock+preview' },
    dataset,
    result: restoreResultText(saved.result, names),   // 落盘的是 pid，展示前还原昵称
    names,
  };
  pick = { gameId: gid, label: `样例包 + 落盘判定（同一局 ${gid}）` };
  console.log('数据来源    : 样例包 normalize + 播种表（不调模型，不烧 token）');
} else {
  const analyzed = realMatches.matches.filter((m) => m.analyzedAt);
  if (!analyzed.length) { console.error('[skip] 盘里没有已分析过的战报'); process.exit(2); }
  const chosen = analyzed.find((m) => String(m.gameId) === arg('game', '')) || analyzed[0];
  const r = await fetch(`${BASE}/api/analyze-match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: chosen.gameId, force: false }),
  }).then((x) => x.json());
  if (!r.ok) { console.error('[fatal] 读盘失败：', r.error); process.exit(1); }
  report = r.report;
  pick = { gameId: chosen.gameId, label: `盘里现成战报 ${chosen.gameId}（fromCache=${r.fromCache}）` };
  console.log('数据来源    : 盘里现成战报（老战报没有符文 / 出装名字，这两列会是「—」）');
}

/* ── 环境 ── */

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  Promise, Map, Set, URLSearchParams, encodeURIComponent, decodeURIComponent,
  document,
  location: { protocol: 'http:', origin: BASE, search: '?nostream=1', hash: '#report' },
  EventSource: undefined,
  fetch: (...a) => fetch(...a),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
for (const f of ['data.js', 'prompt.js', 'api.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), ctx, { filename: f });
}

sandbox.BBX = {
  state: { online: true, status: { ai: { hasKey: true, tone: 'normal' } } },
  available: true,
  origin: BASE,
  probe: async () => true,
  subscribe: () => null,
  status: async () => ({ ai: { hasKey: true, tone: 'normal' } }),
  selftest: async () => ({ installed: true, running: true, phase: 'InProgress', port: 12533 }),
  matches: async () => realMatches,
  // 点行 → 详情。这条是「看/判」分开之后的主链路，快照必须走它而不是直接塞结果。
  matchDetail: async (gameId) => {
    if (!report || (gameId && String(gameId) !== String(pick.gameId))) {
      return { ok: false, error: `渲染器只备了 ${pick?.gameId} 这一局` };
    }
    if (STATE === 'detail') {
      // 详情态：只给客观数据，故意不带 result —— 界面该显示「开始分析」
      return {
        ok: true,
        gameId: pick.gameId,
        hasReport: false,
        dataset: report.dataset,
        names: report.names || {},
        perspective: { puuid: null, teamId: null, resolved: false, name: null },
      };
    }
    return { ok: true, gameId: pick.gameId, hasReport: true, report };
  },
  // 页顶那颗「开始分析 / 重新判定」会调它，渲染器里直接回这份现成战报
  analyzeMatch: async () => ({ ok: true, report, fromCache: false, saved: null }),
  analyze: async () => ({ ok: false, error: 'render-preview 不走这条' }),
  asset: (p) => `${BASE}/api/asset?p=${encodeURIComponent(p)}`,
  config: async () => ({ ai: { hasKey: true } }),
  accounts: async () => fetch(`${BASE}/api/accounts`).then((r) => r.json()),
  selectAccount: async () => ({ ok: true }),
  reports: async () => ({ ok: true, reports: [] }),
  report: async () => ({}),
  watch: async () => ({ ok: true }),
  analyzeLatest: async () => ({ ok: false }),
};

const inner = (sel) => get(sel).innerHTML;
const text = (sel) => get(sel).textContent;

let bootError = null;
try {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
} catch (e) { bootError = e; }
if (bootError) { console.error('[fatal] app.js 启动抛错：', bootError.message); process.exit(1); }

await new Promise((r) => setTimeout(r, 900));
get('#btnHomeRefresh').click();
await new Promise((r) => setTimeout(r, 1500));

// 首页模式到这就够了：战绩列表已经铺好，账号下拉也填好了
if (PAGE === 'home') {
  const listHtml = inner('#homeMatchList');
  if (!listHtml) { console.error('[fatal] 首页战绩列表是空的'); process.exit(1); }
  const frags = {
    '@@ACCT_OPTS@@': get('#acctSelect').innerHTML,
    '@@ACCT_NOTE@@': get('#acctNote').textContent,
    '@@HOME_SUM@@': inner('#homeSum'),
    '@@HOME_LIST@@': listHtml,
    '@@META_CLIENT@@': text('#metaClient'),
    '@@META_PORT@@': text('#metaPort'),
    '@@META_PHASE@@': text('#metaPhase'),
    '@@META_MODE@@': text('#metaMode'),
  };
  let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  html = html.replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${css}\n</style>`);
  html = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const slot = (pattern, token) => {
    const re = new RegExp(pattern);
    if (!re.test(html)) { console.error(`[warn] 没找到 ${pattern}`); return; }
    html = html.replace(re, (m, a, _b, c) => a + token + c);
  };
  slot('(<select id="acctSelect"[^>]*>)([\\s\\S]*?)(</select>)', '@@ACCT_OPTS@@');
  slot('(<span class="acct-note hidden" id="acctNote">)([\\s\\S]*?)(</span>)', '@@ACCT_NOTE@@');
  slot('(<span class="mh-sum" id="homeSum">)([\\s\\S]*?)(</span>)', '@@HOME_SUM@@');
  slot('(<div id="homeMatchList" class="scroll-y mh-list home-list">)([\\s\\S]*?)(</div>)', '@@HOME_LIST@@');
  slot('(<b id="metaClient">)([\\s\\S]*?)(</b>)', '@@META_CLIENT@@');
  slot('(<b id="metaPort">)([\\s\\S]*?)(</b>)', '@@META_PORT@@');
  slot('(<b id="metaPhase">)([\\s\\S]*?)(</b>)', '@@META_PHASE@@');
  slot('(<b id="metaMode">)([\\s\\S]*?)(</b>)', '@@META_MODE@@');
  // acct-note 有内容时要把 hidden 摘掉，否则看不到
  if (frags['@@ACCT_NOTE@@']) html = html.replace('class="acct-note hidden"', 'class="acct-note"');
  html = html.replace('class="dot off" id="homeDot"', 'class="dot" id="homeDot"');
  html = html.replace('class="btn sm ghost hidden" id="btnBack"', 'class="btn sm ghost" id="btnBack"');

  for (const [token, value] of Object.entries(frags)) html = html.split(token).join(value);

  const note = `<div style="margin:0 0 14px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;font-size:12.5px;color:var(--dim);line-height:1.7">
<b style="color:var(--fg)">静态快照（首页）</b> · <code>tools/render-preview.mjs --page=home --mode=${esc(MODE)}</code>。
图标从本地服务 ${esc(BASE)} 实时取；本页无 JS，下拉切不动、行点不开。
</div>`;
  html = html.replace('<main class="stage">', `<main class="stage">\n${note}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');

  const days = (listHtml.match(/class="mh-day"/g) || []).length;
  const rows = (listHtml.match(/class="mh-row"/g) || []).length;
  console.log('数据来源    :', MODE === 'sample' ? '样例包' : '盘里现成');
  console.log('账号下拉    :', (frags['@@ACCT_OPTS@@'].match(/<option /g) || []).length, '项 | 提示:', frags['@@ACCT_NOTE@@'] || '（无）');
  console.log('战绩列表    :', rows, '行 /', days, '个日期分组');
  console.log('输出        :', path.relative(ROOT, OUT), `（${fs.statSync(OUT).size} 字节）`);
  process.exit(0);
}

// 点行之前先清空 —— 启动时 app.js 已经用内置样例渲染过一遍评分表，
// 不清空的话「点行没生效」会被那层兜底内容盖住，看着像成功（踩过一次）。
// 评分表现在是 #sbGroups 一整块动态生成（分组多少由分类方式决定），
// 不再是固定的 rowsAlly / rowsEnemy 两个容器。
for (const sel of ['#sbGroups', '#timeline']) get(sel).innerHTML = '';

const row = makeEl('.mh-row');
row.dataset.gameId = String(pick.gameId);
row.closest = (sel) => (sel === '.mh-row' ? row : null);
get('#homeMatchList')._handlers.click[0]({ target: row, stopPropagation() {} });
await new Promise((r) => setTimeout(r, 2500));

/* ── 取渲染结果 ── */

// 换分类：模拟点那颗切换钮 —— 走界面自己的绑定，不是伸手去改内部变量
if (GROUP !== 'side') {
  const btn = groupBtns.find((b) => b.dataset.group === GROUP);
  if (!btn) { console.error(`[fatal] 不认识的分类：${GROUP}（可选 side / label / role）`); process.exit(1); }
  btn.click();
  await new Promise((r) => setTimeout(r, 60));
}

const sbGroups = inner('#sbGroups');
const timeline = inner('#timeline');
// 判空用「有没有行」，不能用「这块 HTML 是不是空的」——
// 分类标题本身也会渲染出来，光看非空会把「一行都没有」放过。
if (!/class="sb-item"/.test(sbGroups)) {
  console.error('[fatal] 评分表是空的 —— 「点行 → /api/match-detail」这条链路断了');
  process.exit(1);
}
// 状态自检：详情态没判定就该是「开始分析」，已判定态就该是「重新判定」。对不上说明桩和界面走岔了。
const abBtn = text('#btnDoAnalyze');
const wantBtn = STATE === 'detail' ? '开始分析' : '重新判定';
if (abBtn !== wantBtn) {
  console.error(`[fatal] 状态对不上：--state=${STATE} 期望「${wantBtn}」，实际「${abBtn}」`);
  process.exit(1);
}

// 首行展开一份：把「点行看详细」的状态也一起呈现出来
const sbGroupsOpen = sbGroups.replace('class="sb-item"', 'class="sb-item open"');

const frags = {
  '@@SRC_TEXT@@': inner('#srcText'),
  // 结论与长文里点名的昵称带阵营色 —— 取 innerHTML 才能把颜色带进快照（text() 会把 span 抹掉）
  '@@VERDICT@@': inner('#verdict'),
  '@@INSIGHT@@': inner('#insight'),
  // 我方胜负徽标：整枚重写（class 决定绿/红，文案是「我方胜 / 我方负」）。
  // 桩里没有 outerHTML，只能拿 className + textContent 自己拼一枚。
  '@@RES_BADGE@@': `<span class="${get('#resBadge').className}" id="resBadge">${get('#resBadge').textContent}</span>`,
  // 分类展示整块（分组标题 + 表头 + 行）一起换 —— 组数随分类方式变，没法按旧的两个容器切
  '@@SB_GROUPS@@': sbGroupsOpen,
  '@@TIMELINE@@': timeline,
  '@@TL_COUNT@@': text('#tlCount'),
  '@@META_MODE@@': text('#metaMode'),
  // 「看 / 判」分界线那条 —— 未判定态下这是页面上最该被看见的东西
  '@@AB_HINT@@': text('#analyzeHint'),
  '@@AB_BTN@@': text('#btnDoAnalyze'),
  '@@AB_DOT@@': /(^|\s)ok(\s|$)/.test(get('#abDot').className || '')
    ? '<span class="ab-dot ok" id="abDot"></span>'
    : '<span class="ab-dot" id="abDot"></span>',
  '@@TI_COMP@@': inner('#tiComp'),
  '@@TI_AUG@@': inner('#tiAug'),
  '@@TI_ITEM@@': inner('#tiItem'),
};

/* ── 拼装：index.html 骨架 + 内联 CSS + 渲染结果 ── */

let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

html = html.replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${css}\n</style>`);
html = html.replace(/<script[\s\S]*?<\/script>/g, '');

// 先占位再填充，避免后插内容里出现同名锚点导致误替换
const slot = (pattern, token) => {
  const re = new RegExp(pattern);
  if (!re.test(html)) { console.error(`[warn] index.html 里没找到 ${pattern}`); return; }
  html = html.replace(re, (m, a, _b, c) => a + token + c);
};
slot('(<span id="srcText">)([\\s\\S]*?)(</span>)', '@@SRC_TEXT@@');
html = html.replace(/<span class="res-badge hidden" id="resBadge"><\/span>/, '@@RES_BADGE@@');
slot('(<h2 id="verdict">)([\\s\\S]*?)(</h2>)', '@@VERDICT@@');
slot('(<p id="insight"[^>]*>)([\\s\\S]*?)(</p>)', '@@INSIGHT@@');
slot('(<div id="sbGroups">)([\\s\\S]*?)(</div>)', '@@SB_GROUPS@@');
slot('(<div id="timeline" class="tl-list">)([\\s\\S]*?)(</div>)', '@@TIMELINE@@');
slot('(<span class="count" id="tlCount">)([\\s\\S]*?)(</span>)', '@@TL_COUNT@@');
slot('(<b id="metaMode">)([\\s\\S]*?)(</b>)', '@@META_MODE@@');
slot('(<span class="ab-text" id="analyzeHint">)([\\s\\S]*?)(</span>)', '@@AB_HINT@@');
slot('(<button class="btn sm primary" id="btnDoAnalyze">)([\\s\\S]*?)(</button>)', '@@AB_BTN@@');
slot('(<span class="ab-dot" id="abDot">)([\\s\\S]*?)(</span>)', '@@AB_DOT@@');

// 团队视角三块（v3.0）：阵容 / 海克斯 / 出装。
// 界面按「有内容就亮、没有就连壳子收掉」处理，快照必须跟着走 ——
// 直接在 HTML 上把 hidden 写对，不然快照里会多出两个空壳子。
const TI_ITEMS = [
  ['tiCompWrap', 'tiComp', '@@TI_COMP@@', '阵容'],
  ['tiAugWrap', 'tiAug', '@@TI_AUG@@', '海克斯'],
  ['tiItemWrap', 'tiItem', '@@TI_ITEM@@', '出装'],
];
let tiShown = 0;
for (const [wrapId, pId, token] of TI_ITEMS) {
  const isHidden = get('#' + wrapId).classList.contains('hidden');
  if (!isHidden) tiShown += 1;
  // ti-item 上带 data-tone（v3.1 分类卡色条），class 只是 hidden 与否的差异
  html = html.replace(new RegExp(`<div class="ti-item" id="${wrapId}"([^>]*)>`),
    `<div class="ti-item${isHidden ? ' hidden' : ''}" id="${wrapId}"$1>`);
  slot(`(<p id="${pId}">)([\\s\\S]*?)(</p>)`, token);
}
if (tiShown > 0) html = html.replace('class="team-box hidden" id="teamBox"', 'class="team-box" id="teamBox"');
// 局势总览（v3.1 挪出 verdict-box 单独成区）：判定态亮、详情态保持隐藏
if (STATE === 'report') html = html.replace('id="insightWrap" class="hidden"', 'id="insightWrap"');

// 落到战报页：首页让位，返回键现身
html = html.replace('class="page page-idle active"', 'class="page page-idle"');
html = html.replace('class="page page-report"', 'class="page page-report active"');
html = html.replace('class="btn sm ghost hidden" id="btnBack"', 'class="btn sm ghost" id="btnBack"');
html = html.replace(/<span id="clientText">[^<]*<\/span>/, '<span id="clientText">客户端运行中</span>');
html = html.replace('class="dot off" id="clientDot"', 'class="dot" id="clientDot"');
// 骨架上的分类钮高亮必须跟实际渲染的排法一致，
// 否则快照会出现「高亮着『按阵营』、内容却是按结论分」这种自相矛盾。
html = html.replace(/<button class="seg-btn active" data-group="(\w+)">/g, '<button class="seg-btn" data-group="$1">');
html = html.replace(`<button class="seg-btn" data-group="${GROUP}">`, `<button class="seg-btn active" data-group="${GROUP}">`);

for (const [token, value] of Object.entries(frags)) html = html.split(token).join(value);

const note = `<div style="margin:0 0 14px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;font-size:12.5px;color:var(--dim);line-height:1.7">
<b style="color:var(--fg)">静态快照${STATE === 'detail' ? '（未判定态）' : '（已判定态）'}</b> · <code>tools/render-preview.mjs --mode=${esc(MODE)} --state=${esc(STATE)}${GROUP === 'side' ? '' : ` --group=${esc(GROUP)}`}</code> 用真实渲染结果生成；数据：${esc(pick.label)}；分类：${esc(GROUP_CN[GROUP] || GROUP)}。
图标仍从本地服务 ${esc(BASE)} 实时取；本页无 JS，页签切换 / 点行展开都是死的（第一行已预置展开态）。
</div>`;
html = html.replace('<main class="stage">', `<main class="stage">\n${note}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

console.log('对局        :', pick.gameId, '|', report.dataset.match.mode, '|', report.dataset.match.durationText);
console.log('状态        :', STATE === 'detail'
  ? `详情态（未判定）· 按钮「${abBtn}」`
  : `已判定态 · 按钮「${abBtn}」`);
const groupTitles = [...sbGroups.matchAll(/class="gt-name">([^<]*)</g)].map((m) => m[1]);
console.log('评分表      :', GROUP_CN[GROUP] || GROUP,
  `| ${(sbGroups.match(/class="sb-block"/g) || []).length} 组`,
  `| ${(sbGroups.match(/class="sb-item"/g) || []).length} 人`);
console.log('分组        :', groupTitles.map((t, i) => `${t}(${(sbGroups.split('class="sb-block"')[i + 1] || '').split('class="sb-item"').length - 1})`).join(' · '));
console.log('符文格      :', (sbGroups.match(/class="slot aug/g) || []).length, '| 出装格:', (sbGroups.match(/class="slot item"/g) || []).length, '| 空占位:', (sbGroups.match(/sb-slots empty/g) || []).length);
console.log('时间轴      :', (timeline.match(/class="tl-row"/g) || []).length, '行');
// 判据用「DOM 里这块有没有被隐藏」，不能用快照文本非空 ——
// 未判定态下 p 里还留着 index.html 的占位「—」，那是非空的，会误报成「有」。
console.log('团队视角    :', `${tiShown}/3 条（`
  + TI_ITEMS.map(([wrapId, , , label]) => `${label} ` + (get('#' + wrapId).classList.contains('hidden') ? '无' : '有')).join(' / ')
  + '）');
// 只数「结论」那一列 —— 分组标题里现在也会出现「大腿 / 背锅侠」，
// 按整块文本数会把组名一起算进来，凭空多出几条。
const tagHits = [...sbGroups.matchAll(/class="sb-tag"[^>]*>([^<]*)</g)].map((m) => m[1]);
console.log('头衔分布    :', ['大腿', '背锅侠', '不粘锅', '混子', '普通']
  .map((t) => `${t}×${tagHits.filter((x) => x === t).length}`).join(' '));
console.log('输出        :', path.relative(ROOT, OUT), `（${fs.statSync(OUT).size} 字节）`);
