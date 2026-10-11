/**
 * 账号归属探测 —— 把「这一局是谁打的」从客户端数据里挖出来。
 *
 * 为什么要这么做：一台机器同时只能登一个账号，所以
 *   「注册过的本机账号 u 出现在某局的参与者里」⟹「这一局出自 u 的战绩」
 * 是可靠的（不会出现两个本机账号同局的情况）。反过来说，
 * 光看一局里的 10 个人，认不出哪个是「我」—— 对局详情里没有本机标记。
 *
 * 所以做法是：把每局的参与者 puuid 全抓下来，先扣掉已知账号的局，
 * 再看剩下那些局里「谁场场都在」—— 那个就是另一个本机账号。
 * 好友也会场场都在（开黑），所以本工具只**报候选**，不擅自认定。
 *
 * 用法：
 *   node tools/probe-accounts.mjs            # 抓取 + 打印归属分析（不写任何东西）
 *   node tools/probe-accounts.mjs --refresh  # 忽略缓存重新抓
 *
 * 缓存：data/account-probe.json（gameId → [{pid, puuid, name}]），只为省一次抓取
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConnection, readMatchDetail, readCurrentSummoner } from '../src/lcu/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'account-probe.json');
const MATCH_INDEX = path.join(DATA, 'matches.json');

const refresh = process.argv.includes('--refresh');

const { conn } = readConnection();
if (!conn) { console.error('[skip] 客户端没在运行，抓不到对局详情'); process.exit(2); }

const entries = JSON.parse(fs.readFileSync(MATCH_INDEX, 'utf8')).entries || {};
const gameIds = Object.values(entries)
  .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  .map((e) => String(e.gameId))
  .filter(Boolean);

console.log(`索引里 ${gameIds.length} 局，开始抓参与者…`);

let cache = {};
if (!refresh && fs.existsSync(CACHE)) {
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')).games || {}; } catch { cache = {}; }
}

const todo = gameIds.filter((g) => !cache[g]);
console.log(`缓存命中 ${gameIds.length - todo.length} 局，需抓 ${todo.length} 局`);

const CONC = 6;
let done = 0;
for (let i = 0; i < todo.length; i += CONC) {
  const batch = todo.slice(i, i + CONC);
  const res = await Promise.all(batch.map((g) => readMatchDetail(conn, g).catch(() => null)));
  batch.forEach((g, k) => {
    const d = res[k];
    if (!d?.participantIdentities?.length) return;
    cache[g] = d.participantIdentities.map((x) => ({
      pid: x.participantId,
      puuid: x?.player?.puuid || null,
      name: x?.player?.gameName || x?.player?.summonerName || null,
    })).filter((x) => x.puuid);
  });
  done += batch.length;
  if (done % 60 === 0) process.stdout.write(`  …已抓 ${done}/${todo.length}\n`);
}

fs.writeFileSync(CACHE, JSON.stringify({
  updatedAt: new Date().toISOString(),
  source: 'tools/probe-accounts.mjs',
  games: cache,
}, null, 2), 'utf8');
console.log(`抓取完成，缓存写入 ${path.relative(ROOT, CACHE)}`);

/* ── 归属分析 ── */

const me = await readCurrentSummoner(conn).catch(() => null);
const mine = me?.puuid || null;

// 每个 puuid 出现在哪些局
const byPuuid = new Map();
for (const [g, list] of Object.entries(cache)) {
  for (const p of list) {
    if (!byPuuid.has(p.puuid)) byPuuid.set(p.puuid, { puuid: p.puuid, name: p.name, games: new Set() });
    byPuuid.get(p.puuid).games.add(g);
  }
}
const total = Object.keys(cache).length;

// 名次表：按覆盖局数排序
const rank = [...byPuuid.values()].sort((a, b) => b.games.size - a.games.size);

console.log('');
console.log(`当前登录：${me?.displayName || '—'}（${mine ? mine.slice(0, 8) + '…' : '?'}）`);
console.log(`可分析局数：${total}`);
console.log('');
console.log('puuid 覆盖度 Top12（覆盖局数 / 总局数）：');
for (const r of rank.slice(0, 12)) {
  const pct = ((r.games.size / total) * 100).toFixed(0);
  console.log(`  ${r.puuid.slice(0, 8)}…  ${String(r.games.size).padStart(4)} 局  ${pct.padStart(3)}%  ${r.name}`);
}

// 扣掉当前账号的局，再看剩下的人里谁「场场都在」
if (mine && byPuuid.has(mine)) {
  const mineGames = byPuuid.get(mine).games;
  const rest = new Set(Object.keys(cache).filter((g) => !mineGames.has(g)));
  console.log('');
  console.log(`当前账号占 ${mineGames.size} 局；剩余未归属 ${rest.size} 局。`);
  if (rest.size) {
    const cand = rank
      .filter((r) => r.puuid !== mine)
      .map((r) => ({ ...r, cover: [...r.games].filter((g) => rest.has(g)).length }))
      .filter((r) => r.cover > 0)
      .sort((a, b) => b.cover - a.cover);
    console.log('剩余局里的覆盖度 Top8 —— 覆盖 100% 的那个最像「另一个本机账号」：');
    for (const c of cand.slice(0, 8)) {
      const pct = ((c.cover / rest.size) * 100).toFixed(0);
      console.log(`  ${c.puuid.slice(0, 8)}…  ${String(c.cover).padStart(4)}/${rest.size}  ${pct.padStart(3)}%  ${c.name}`);
    }
  }
} else if (mine) {
  console.log('');
  console.log('⚠ 当前账号不在任何一局里 —— 索引里没有它打的局');
}
