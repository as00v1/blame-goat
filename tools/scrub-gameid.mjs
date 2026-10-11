/**
 * 发布前脱敏 —— 把仓库里出现的**真实对局 ID**换成同格式的假 ID
 *
 * 用法：
 *   node tools/scrub-gameid.mjs          # 真改
 *   node tools/scrub-gameid.mjs --dry    # 只报告不改
 *
 * 为什么需要它：
 *   昵称有 `capture-to-sample.mjs` 兜着，但 **gameId 没有**。而 gameId 比昵称更危险 ——
 *   op.gg / gol.gg 这类战绩站支持按 gameId 反查召唤师名、段位和整局战绩。
 *   也就是说，公开仓库里留着本机打过的真实 gameId，等于递过去一条
 *   「去第三方网站查这个人」的直达链接。昵称查不到人，gameId 能。
 *
 *   （下面举的例子一律写成 `401141xxxxxx`，不写真值 —— 否则这个脚本会把自己
 *     注释里的例子也换掉，下次读代码就莫名其妙了。）
 *
 * 怎么决定「哪些是真的」：
 *   **data/ 是唯一权威来源** —— 只把「本机数据里真实出现过、且源码里确实引用了」的
 *   gameId 列为待替换。这样自检脚本里的测试占位 ID（401100000001 / 401199999999）
 *   不会被误伤，也不用维护一张手写黑名单。
 *
 * 替换规则（确定性，无映射表）：
 *   fake('401141xxxxxx') → '4011999' + md5 前 8 位十六进制转十进制 % 100000（补足 5 位）
 *   同一个原值在任何文件里都映射到同一个假值，所以 sample 包、web/data.js、
 *   本机 data/ 三边改完仍然对得上。
 *
 * 会连带处理的：
 *   · data/ 下的同名 gameId（保证离线 demo 与 render-preview 仍能对上）
 *   · data/reports/{gameId}.json 的**文件名**（不改名就找不到战报）
 *
 * 不碰：data/ 里跟源码引用无关的其他 gameId、preview/、_ref/、dist/、node_modules/。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

/** 源码目录：进仓库、会给人看的 */
const REPO_DIRS = ['server', 'src', 'web', 'tools', 'desktop', 'docs', 'prototype'];
const REPO_FILES = ['README.md', 'LICENSE', 'package.json', 'package-lock.json', 'start.bat', 'check.bat', '.gitignore'];
/** 本机数据：跟着一起改，否则源码与盘上就对不上了 */
const DATA_DIRS = ['data'];
/** 只扫不改（原始抓取 / 渲染快照，保留原貌当证据） */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.workbuddy', '_ref', 'preview', '.seatest', '.tmp-gamedata', '.tmp-shots', '.tmp-bat']);

/** 国服真实 gameId 段：4011 + 8 位。测试占位（401100000001）也是这形状，靠 data/ 比对排除 */
const GAME_ID_RE = /\b4011\d{8}\b/g;

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
};

/** 确定性假 ID：同一个原值永远得到同一个假值，且明显不是真实段 */
const fakeGameId = (real) =>
  '4011999' + String(parseInt(crypto.createHash('md5').update(`bbx:${real}`).digest('hex').slice(0, 8), 16) % 100000).padStart(5, '0');

/* ── 1. 本机真实 gameId 全集（权威来源）───────────────── */
function collectRealGameIds() {
  const ids = new Set();
  const addText = (s) => { if (typeof s === 'string') for (const m of s.match(GAME_ID_RE) || []) ids.add(m); };
  const addJson = (rel) => {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) return;
    addText(fs.readFileSync(f, 'utf8'));
  };
  addJson('data/roster.json');
  addJson('data/matches.json');
  addJson('data/account-probe.json');
  addJson('data/names.json');
  const searched = path.join(ROOT, 'data', 'searched');
  if (fs.existsSync(searched)) for (const f of fs.readdirSync(searched)) addJson(path.join('data', 'searched', f));
  const reports = path.join(ROOT, 'data', 'reports');
  if (fs.existsSync(reports)) for (const f of fs.readdirSync(reports)) for (const m of f.match(GAME_ID_RE) || []) ids.add(m);
  return ids;
}

/* ── 2. 源码里引用到的 gameId ──────────────────────────── */
function collectRepoFiles() {
  const files = [];
  for (const d of REPO_DIRS) walk(path.join(ROOT, d), files);
  for (const f of REPO_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) files.push(p); }
  return files;
}

const readText = (f) => {
  let b;
  try { b = fs.readFileSync(f); } catch { return null; }
  if (b.includes(0)) return null;            // 二进制（png / ico / exe）
  return b.toString('utf8');
};

const realIds = collectRealGameIds();
const repoFiles = collectRepoFiles();

const usedInRepo = new Set();
for (const f of repoFiles) {
  const s = readText(f);
  if (!s) continue;
  for (const m of s.match(GAME_ID_RE) || []) if (realIds.has(m)) usedInRepo.add(m);
}

if (!usedInRepo.size) {
  console.log('✓ 源码里没有引用任何本机真实 gameId，无需处理');
  process.exit(0);
}

/* ── 3. 建映射并替换 ────────────────────────────────────── */
// 先算出所有假值，确认不会和真实 ID / 已有占位撞车
const map = new Map();
for (const id of [...usedInRepo].sort()) map.set(id, fakeGameId(id));
for (const [real, fake] of map) {
  if (realIds.has(fake)) throw new Error(`假 ID ${fake} 与本机真实 gameId 撞车，换个 salt`);
}
const applyReplace = (s) => {
  let n = 0;
  for (const [real, fake] of map) {
    const c = s.split(real).length - 1;
    if (c) { n += c; s = s.split(real).join(fake); }
  }
  return [s, n];
};

console.log(`\n本机真实 gameId 全集：${realIds.size} 个`);
console.log(`源码里引用到的：${usedInRepo.size} 个 →\n`);
for (const [real, fake] of map) console.log(`  ${real}  →  ${fake}`);

// 3.1 源码
let touched = 0, hits = 0;
for (const f of repoFiles) {
  const s = readText(f);
  if (!s) continue;
  const [out, n] = applyReplace(s);
  if (!n) continue;
  touched++; hits += n;
  if (!DRY) fs.writeFileSync(f, out, 'utf8');
}

// 3.2 本机数据（只改源码引用过的那几个，其余保持原样）
let dataTouched = 0, dataHits = 0;
for (const d of DATA_DIRS) {
  for (const f of walk(path.join(ROOT, d))) {
    const s = readText(f);
    if (!s) continue;
    const [out, n] = applyReplace(s);
    if (!n) continue;
    dataTouched++; dataHits += n;
    if (!DRY) fs.writeFileSync(f, out, 'utf8');
  }
}

// 3.3 战报文件名
const reportsDir = path.join(ROOT, 'data', 'reports');
const renames = [];
if (fs.existsSync(reportsDir)) {
  for (const f of fs.readdirSync(reportsDir)) {
    const m = f.match(GAME_ID_RE);
    if (m && map.has(m[0])) renames.push([f, f.split(m[0]).join(map.get(m[0]))]);
  }
  if (!DRY) for (const [from, to] of renames) {
    fs.renameSync(path.join(reportsDir, from), path.join(reportsDir, to));
  }
}

console.log(`\n源码：${touched} 个文件 / ${hits} 处`);
console.log(`本机数据：${dataTouched} 个文件 / ${dataHits} 处`);
console.log(`战报改名：${renames.length} 个${renames.length ? ' → ' + renames.map(([a, b]) => `${a} ⇒ ${b}`).join(', ') : ''}`);
console.log(DRY ? '\n[dry] 未改动，加 --dry 之外再跑一次才会真改' : '\n✓ 已替换（真实 gameId 与假 ID 一一对应，可逆：把映射反过来再跑一遍即可还原）\n');
