/**
 * 静态自检：揪出「调用了但没导入 / 没定义」的标识符。
 *
 * 为什么需要它：项目零 npm 依赖，用不了 ESLint；而 Node 只在**真正执行到那一行**
 * 时才抛 ReferenceError —— 上一版 `readLiveBundle is not defined` 就属于这种：
 * 平时不报错，等真的打完一局自动出报时整条链路才炸。
 *
 * 做法是启发式扫描（不是完整 parser）：
 *   收集 导入名 / 函数名 / 变量名 / 类名 / 解构名 / 形参名 / catch 参数 / 内建全局
 *   再找形如 `name(` 的调用点，不在上面集合里的就报出来。
 * 会有少量误报（比如参数解构、模板里拼出来的名字），报出来人工过一眼即可。
 *
 * 用法：node tools/check-identifiers.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  'server/server.mjs',
  'server/service.mjs',
  'server/accounts.mjs',
  'server/roster.mjs',
  'src/env.mjs',
  'src/lcu/client.mjs',
  'src/lcu/champions.mjs',
  'src/lcu/participants.mjs',
  'src/lcu/normalize.mjs',
  'src/lcu/gamedata.mjs',
  'src/lcu/matches.mjs',
  'src/lcu/detail.mjs',
  'src/deepseek/judge.mjs',
  'src/deepseek/prompt.mjs',
  'src/deepseek/index.mjs',
  'web/app.js',
  'web/api.js',
  'web/data.js',
  'web/prompt.js',
  // 桌面外壳：全项目唯一的 CommonJS（Electron 主进程用 CJS 最省事），
  // 但它同样会「调用一个没定义的名字」，所以一样得扫
  'desktop/main.cjs',
  // 升级器：跑在客户端自带的 Electron 上（ELECTRON_RUN_AS_NODE），
  // 同样会因为手滑写出一个没定义的名字而在用户机器上才炸 —— 一起扫
  'desktop/apply-update.mjs',
  // 两个安全自检：一个验本地 API 的可信边界，一个验索引并发写与归属。
  // 它们跑在真机上（起服务 / 打真接口），手滑的代价比普通脚本大，也一起扫
  'tools/check-api-guard.mjs',
  'tools/check-index-guard.mjs',
  'tools/check-judge-progress.mjs',
  'tools/check-update-pack.mjs',
];

/** JS 内建 + 运行环境全局，不算未定义 */
const GLOBALS = new Set([
  'console', 'process', 'globalThis',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'Date', 'JSON', 'RegExp', 'Promise', 'Proxy', 'Reflect',
  'Set', 'Map', 'WeakMap', 'WeakSet', 'Intl', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
  'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Blob', 'FormData', 'Headers',
  'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'CustomEvent', 'MessageChannel',
  'fetch', 'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'crypto', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape',
  'require', 'module', 'exports', '__dirname', '__filename', 'import',
  'undefined', 'NaN', 'Infinity', 'arguments',
  'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'EventSource', 'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm', 'prompt',
  'DOMParser', 'XMLHttpRequest', 'Image', 'Audio', 'FileReader', 'MutationObserver',
  'ResizeObserver', 'IntersectionObserver', 'getComputedStyle', 'matchMedia', 'Notification',
  'WebSocket', 'Worker', 'CSS', 'HTMLElement', 'Node', 'Element', 'File', 'FileList',
  // 语句关键字（正则挡不住全）
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'function',
  'do', 'else', 'try', 'delete', 'void', 'in', 'of', 'case', 'yield', 'super', 'throw',
  // async (…) => 里的 async 会被当成函数调用，排除掉
  'async',
]);

/** 去掉注释与字符串字面量，避免把注释里的名字当成代码（保留换行数，否则行号会漂） */
function stripNoise(src) {
  const keepLines = (s) => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** 从 `(` 所在位置截出配平括号里的内容 —— 形参可能跨多行、含嵌套括号 */
function balancedParens(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

function collectDeclared(code) {
  const names = new Set();

  const addList = (raw) => {
    raw.split(',').forEach((part) => {
      let s = part.trim();
      if (!s) return;
      s = s.replace(/^\.\.\./, '');
      // {a: b} / {a = 1} → 取**本地名**。
      //   解构 {a: b} 是「取 a 赋给 b」，本地名在冒号右边；
      //   import {A as B} 同理（调用方已把 as 换成冒号）。
      // 早先取的是冒号左边，于是 `import { x as y }` 会把 x 记成已声明、
      // 把真正在用的 y 报成未定义 —— 整条 import 重命名都成了误报。
      const colon = s.indexOf(':');
      if (colon > -1) s = s.slice(colon + 1).trim();
      const eq = s.indexOf('=');
      if (eq > -1) s = s.slice(0, eq).trim();
      s = s.replace(/[{[\]}()]/g, ' ').trim();
      const m = s.match(/^[A-Za-z_$][\w$]*/);
      if (m) names.add(m[0]);
    });
  };

  // import 语句
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s*['"]/g)) {
    let spec = m[1];
    const braces = spec.match(/\{([\s\S]*)\}/);
    if (braces) addList(braces[1].replace(/\bas\b/g, ':'));
    const defaultPart = spec.replace(/\{[\s\S]*\}/g, '').replace(/^\s*,|,\s*$/g, '').trim();
    if (defaultPart && !defaultPart.startsWith('*')) {
      defaultPart.split(',').forEach((d) => {
        const n = d.trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
      });
    }
    const star = spec.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (star) names.add(star[1]);
  }
  for (const m of code.matchAll(/import\s+['"][^'"]+['"]/g)) void m;

  // 函数 / 类
  for (const m of code.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // 变量声明
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)) addList(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([\s\S]*?)\]\s*=/g)) addList(m[1]);

  // 形参：function f(a, b) / (a, b) => / a => / catch (e)
  for (const m of code.matchAll(/\b(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) addList(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addList(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // 解构形参（多行 + 默认值里带括号的情况）：`function f({ a = 1, b = () => ({}) } = {})`
  // 正则在这里靠不住 —— `() => ({})` 里的 `})` 会让非贪婪匹配提前收工，
  // 后面的参数（如 shouldAutoAnalyze）就漏了。改用配平括号截出形参区再解析。
  for (const m of code.matchAll(/\bfunction\b[^(]*\(/g)) {
    const inner = balancedParens(code, m.index + m[0].length - 1);
    if (inner) addList(inner);
  }
  for (const m of code.matchAll(/\(\s*\{([\s\S]*?)\}\s*(?:=\s*\{[^}]*\})?\s*\)\s*=>/g)) addList(m[1]);

  // 类方法名 / 对象字面量方法：name(...) {  —— 视为已定义
  for (const m of code.matchAll(/^\s*(?:async\s+)?(?:get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) names.add(m[1]);
  // 对象键简写 / 属性定义 name:
  for (const m of code.matchAll(/(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1]);

  return names;
}

/** 找出被当成函数调用、但没在任何地方定义的名字 */
function findUndeclared(code, declared) {
  const hits = new Map();
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    const re = /(?<![\w$.'"`])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(line))) {
      const name = m[1];
      if (declared.has(name) || GLOBALS.has(name)) continue;
      if (!hits.has(name)) hits.set(name, []);
      hits.get(name).push(i + 1);
    }
  });
  return hits;
}

let total = 0;
const report = [];

for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripNoise(raw);
  const declared = collectDeclared(code);
  const hits = findUndeclared(code, declared);
  if (hits.size) {
    total += hits.size;
    report.push({ rel, hits });
  }
}

if (!total) {
  console.log('[ok] 未发现「调用了但没定义」的标识符（%d 个文件）', TARGETS.length);
  process.exit(0);
}

console.log('[warn] 发现 %d 个疑似未定义的调用：\n', total);
for (const { rel, hits } of report) {
  console.log('  ' + rel);
  for (const [name, lns] of hits) console.log(`    - ${name}()  行 ${lns.join(', ')}`);
  console.log('');
}
console.log('※ 启发式扫描，可能有误报（解构参数等），人工确认后再改。');
process.exit(1);
