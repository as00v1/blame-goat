/**
 * 账号归属迁移 —— 给已有的战绩 / 战报补上「这一局是谁打的」。
 *
 * 判据（可靠，因为一台机器同时只能登一个账号）：
 *   「本机账号 u 出现在某局的参与者里」⟹「这一局出自 u 的战绩」
 * 不会误判成别人，因为两个本机账号不可能同局。
 *
 * 但反过来，「一局里的 10 个人谁是本机账号」是认不出来的（对局详情没有本机标记）。
 * 所以第二个账号靠**排除法**找：扣掉已知账号的局之后，剩下的局里
 * 「场场都在」的那个 puuid 就是它 —— 好友是做不到场场都在的
 * （实测：第二个账号覆盖 195/195 = 100%，最高的好友只有 66%）。
 *
 * 用法：
 *   node tools/migrate-accounts.mjs            # 干跑，只打印计划
 *   node tools/migrate-accounts.mjs --write    # 落盘（先备份到 data/backup-accounts-<时间戳>/）
 *   node tools/migrate-accounts.mjs --write --force   # 覆盖已有的 ownerPuuid
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConnection, readMatchDetail, readCurrentSummoner } from '../src/lcu/client.mjs';
import { ACCOUNTS_FILE, registerAccount, loadAccounts, saveAccounts, rememberAccount } from '../server/accounts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const PROBE = path.join(DATA, 'account-probe.json');
const MATCH_INDEX = path.join(DATA, 'matches.json');
const REPORTS_DIR = path.join(DATA, 'reports');

const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

if (!fs.existsSync(PROBE)) {
  console.error('[skip] 缺 data/account-probe.json —— 先跑 node tools/probe-accounts.mjs');
  process.exit(2);
}

const probe = JSON.parse(fs.readFileSync(PROBE, 'utf8')).games || {};
const index = JSON.parse(fs.readFileSync(MATCH_INDEX, 'utf8'));
const entries = index.entries || {};
const gameIds = Object.keys(entries).map(String);

console.log(`索引 ${gameIds.length} 局，其中 ${Object.keys(probe).length} 局有参与者数据`);

/* ── 补抓：之前没拿到的局再试一次（多半是瞬时失败） ── */
const missing = gameIds.filter((g) => !probe[g]);
if (missing.length) {
  const { conn } = readConnection();
  if (conn) {
    console.log(`补抓 ${missing.length} 局…`);
    for (const g of missing) {
      const d = await readMatchDetail(conn, g).catch(() => null);
      if (!d?.participantIdentities?.length) continue;
      probe[g] = d.participantIdentities
        .map((x) => ({ pid: x.participantId, puuid: x?.player?.puuid || null, name: x?.player?.gameName || x?.player?.summonerName || null }))
        .filter((x) => x.puuid);
    }
    fs.writeFileSync(PROBE, JSON.stringify({ updatedAt: new Date().toISOString(), source: 'tools/migrate-accounts.mjs', games: probe }, null, 2), 'utf8');
  }
}

/* ── 参与者索引 ── */
const byPuuid = new Map();     // puuid → { name, games:Set }
for (const [g, list] of Object.entries(probe)) {
  for (const p of list) {
    if (!byPuuid.has(p.puuid)) byPuuid.set(p.puuid, { puuid: p.puuid, name: p.name, games: new Set() });
    byPuuid.get(p.puuid).games.add(String(g));
  }
}

/* ── 已知账号：登记表 + 当前登录 ── */
const known = new Set(Object.keys(loadAccounts().accounts));

const { conn } = readConnection();
let me = null;
if (conn) {
  me = await readCurrentSummoner(conn).catch(() => null);
  if (me?.puuid) {
    known.add(me.puuid);
    console.log(`客户端当前登录：${me.displayName || me.gameName || '?'}（${me.puuid.slice(0, 8)}…）→ 登记为本机账号`);
  }
} else {
  console.log('客户端没在运行 —— 只能沿用登记表里已有的账号');
}
if (!known.size) { console.error('[fatal] 一个已知账号都没有，先把客户端打开登录一次'); process.exit(1); }

/* ── 迭代排除法找其余账号 ── */
const ownerOf = new Map();     // gameId → puuid

function assign() {
  ownerOf.clear();
  let assignedNow = 0;
  for (const g of Object.keys(probe)) {
    const hit = (probe[g] || []).find((p) => known.has(p.puuid));
    if (hit) { ownerOf.set(g, hit.puuid); assignedNow += 1; }
  }
  return assignedNow;
}

const found = [...known];
for (let round = 0; round < 4; round += 1) {
  const assigned = assign();
  const unassigned = Object.keys(probe).filter((g) => !ownerOf.has(g));
  console.log(`第 ${round + 1} 轮：已归属 ${assigned} 局，未归属 ${unassigned.length} 局`);
  if (!unassigned.length) break;

  const cand = [...byPuuid.values()]
    .filter((r) => !known.has(r.puuid))
    .map((r) => ({ ...r, cover: [...r.games].filter((g) => unassigned.includes(g)).length }))
    .sort((a, b) => b.cover - a.cover);

  const top = cand[0];
  if (!top || top.cover !== unassigned.length || unassigned.length < 3) {
    console.log(`  → 没有「场场都在」的候选（最高 ${top ? `${top.cover}/${unassigned.length} ${top.name}` : '无'}），停止推断`);
    break;
  }
  const runnerUp = cand[1];
  if (runnerUp && runnerUp.cover === top.cover) {
    console.log(`  → ⚠ 有并列候选（${top.name} / ${runnerUp.name}），无法自动认定，停止推断`);
    break;
  }
  console.log(`  → 认定 ${top.name}（${top.puuid.slice(0, 8)}…）覆盖 ${top.cover}/${unassigned.length} = 100%`);
  known.add(top.puuid);
  found.push(top.puuid);
}

assign();

/* ── 报表 ── */
const tally = new Map();
for (const [, u] of ownerOf) tally.set(u, (tally.get(u) || 0) + 1);
const unowned = Object.keys(probe).filter((g) => !ownerOf.has(g));
const noData = gameIds.filter((g) => !probe[g]);

console.log('');
console.log('归属结果：');
for (const u of found) {
  const r = byPuuid.get(u);
  const n = tally.get(u) || 0;
  console.log(`  ${(r?.name || u.slice(0, 8)).padEnd(16)} ${String(n).padStart(4)} 局   ${u.slice(0, 8)}…`);
}
console.log(`  ${'未归属'.padEnd(16)} ${String(unowned.length + noData.length).padStart(4)} 局   （其中 ${noData.length} 局拿不到对局详情）`);

/* ── 战报归属 ── */
const reportFiles = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
const reportPlan = [];
for (const f of reportFiles) {
  const full = path.join(REPORTS_DIR, f);
  let j;
  try { j = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
  const gid = String(j?.dataset?.match?.gameId || f.replace('.json', ''));
  const existing = j?.meta?.ownerPuuid || null;
  if (existing && !FORCE) { reportPlan.push({ f, gid, owner: existing, skip: true }); continue; }
  const owner = ownerOf.get(gid) || (j?.meta?.ownerPuuid ?? null);
  reportPlan.push({ f, gid, owner: owner || null });
}
console.log('');
console.log('战报归属（共 ' + reportPlan.length + ' 份）：');
for (const r of reportPlan) {
  const nm = r.owner ? (byPuuid.get(r.owner)?.name || r.owner.slice(0, 8) + '…') : '未归属';
  console.log(`  ${r.gid}  ${r.skip ? '（已标注，跳过）' : ''} ${nm}`);
}

if (!WRITE) {
  console.log('');
  console.log('（干跑，未写盘。加 --write 落盘）');
  process.exit(0);
}

/* ── 落盘：先备份 ── */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(DATA, `backup-accounts-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(MATCH_INDEX, path.join(backup, 'matches.json'));
fs.mkdirSync(path.join(backup, 'reports'), { recursive: true });
for (const f of reportFiles) fs.copyFileSync(path.join(REPORTS_DIR, f), path.join(backup, 'reports', f));
console.log('');
console.log(`备份 → ${path.relative(ROOT, backup)}/`);

/* 账号登记 */
for (const u of found) {
  const r = byPuuid.get(u);
  if (u === me?.puuid) rememberAccount(me, { source: 'login', markCurrent: true, makeLast: true });
  else registerAccount({ puuid: u, displayName: r?.name || null, source: 'inferred', makeLast: false });
}
// 没登录时，把登记表里最后一个账号当作 last
{
  const o = loadAccounts();
  if (!o.last) {
    const first = Object.keys(o.accounts)[0];
    if (first) { o.last = first; saveAccounts(o); }
  }
}

/* 索引标注 */
let tagged = 0;
for (const g of gameIds) {
  const e = entries[g];
  if (!e) continue;
  if (e.ownerPuuid && !FORCE) continue;
  const owner = ownerOf.get(g) || null;
  if (owner) { e.ownerPuuid = owner; tagged += 1; }
}
fs.writeFileSync(MATCH_INDEX, JSON.stringify({ ...index, updatedAt: new Date().toISOString(), entries }, null, 2), 'utf8');
console.log(`索引标注：${tagged} 局`);

/* 战报标注 */
let rtagged = 0;
for (const r of reportPlan) {
  if (r.skip || !r.owner) continue;
  const full = path.join(REPORTS_DIR, r.f);
  const j = JSON.parse(fs.readFileSync(full, 'utf8'));
  j.meta = { ...(j.meta || {}), ownerPuuid: r.owner };
  fs.writeFileSync(full, JSON.stringify(j, null, 2), 'utf8');
  rtagged += 1;
}
console.log(`战报标注：${rtagged} 份`);
console.log('');
console.log('完成。');
