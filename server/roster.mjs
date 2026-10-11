/**
 * 召唤师名录 —— 「本机见过谁」的索引（gameId → 那一局的 10 名参与者）。
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ 为什么不能直接问客户端：                                          │
 * │   · 「按昵称查人」—— /lol-summoner/v1/summoners?name= 只吃         │
 * │     gameName#tagLine，中文名直接 422；v2 连 name 参数都不收。       │
 * │   · 「查别人的战绩」—— 这条**实测被推翻了**（2026-10-11）：            │
 * │     `/lol-match-history/v1/products/lol/{puuid}/matches` 对任意已知    │
 * │     puuid 是**按人返回**的（四个人的 accountId、gameId 集合都不同）。 │
 * │     真正的上限是：只有近 50 局、begIndex 翻页无效、条数随客户端缓存   │
 * │     浮动；而且**列表元素只含被查的那 1 个人**，要判定还得逐局拉详情。 │
 * │     → 已在 service.mjs 的 summonerMatches 里并进查询，见 readMatchListFor。│
 * │   仍然成立的结论：puuid 的**来源**只有名录（他出现在我见过的局里）。 │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 所以名录是本功能的地基：每读一局对局详情，就把 10 名参与者攒进来。
 * 之后「查某人」= 在名录里认出 puuid → 列出他参与过的局 → 逐局拉详情。
 *
 * ★ 数据隔离：名录只记「谁出现在哪一局」，**不参与**归属判定、
 *   也**不会**把别人的局写进 matches.json（那是「我的战绩」）。
 *   两边互不污染，查别人的数据永远只在查询视图里出现。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/env.mjs';

export const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
/** 查询结果缓存目录 —— 一人才一份，跟「我的战绩」物理隔开 */
export const SEARCHED_DIR = path.join(DATA_DIR, 'searched');
/** 早期抓的参与者数据（tools/probe-accounts.mjs 产出），首次建名录时当种子 */
const PROBE_FILE = path.join(DATA_DIR, 'account-probe.json');

/** 查询结果缓存的有效期：10 分钟内重复查同一个人直接读盘 */
export const SEARCH_TTL_MS = 10 * 60 * 1000;

const EMPTY = () => ({ updatedAt: null, games: {} });

/* ────────────────── 名录读写 ────────────────── */

export function loadRoster() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')); } catch { j = null; }
  const games = j?.games && typeof j.games === 'object' ? j.games : {};
  return { updatedAt: j?.updatedAt || null, games };
}

export function saveRoster(roster) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  roster.updatedAt = new Date().toISOString();
  fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster), 'utf8');
  return roster;
}

/** 一局对局详情 → 名录条目（{pid,puuid,name} 列表） */
function pickPlayers(detail) {
  return (detail?.participantIdentities || [])
    .map((x) => ({
      pid: x?.participantId ?? null,
      puuid: x?.player?.puuid || null,
      name: x?.player?.gameName || x?.player?.summonerName || null,
    }))
    .filter((x) => x.puuid);
}

/**
 * 批量记名录 —— 一次写盘。
 * 逐局调 rememberPlayers 时每局都要把整个 json 读一遍写一遍，
 * 200 局就是 400 次 IO；批量版只在最后写一次。
 *
 * @param {Array<{gameId: string|number, detail: object}>} items
 * @returns {number} 新增的参与者条数
 */
export function rememberPlayersBatch(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const roster = loadRoster();
  let added = 0;
  for (const { gameId, detail } of items) {
    const gid = String(gameId || detail?.gameId || '');
    const list = pickPlayers(detail);
    if (!gid || !list.length) continue;
    if (!roster.games[gid]) added += list.length;
    roster.games[gid] = list;
  }
  saveRoster(roster);
  return added;
}

/**
 * 把一局的参与者记进名录。
 * @returns {number} 新增的参与者条数（已存在的不重复计数）
 */
export function rememberPlayers(gameId, detail) {
  const list = pickPlayers(detail);
  if (!list.length) return 0;
  return rememberPlayersBatch([{ gameId: gameId || detail?.gameId, detail }]);
}

/** 初始化名录：没有就从历史抓取里导入一次（不覆盖已有内容） */
export function seedRoster() {
  const roster = loadRoster();
  if (Object.keys(roster.games).length) return { seeded: 0, games: Object.keys(roster.games).length };

  let probe = null;
  try { probe = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')); } catch { probe = null; }
  const games = probe?.games && typeof probe.games === 'object' ? probe.games : {};
  const n = Object.keys(games).length;
  if (!n) return { seeded: 0, games: 0 };

  roster.games = { ...games };
  saveRoster(roster);
  return { seeded: n, games: n };
}

/* ────────────────── 查人 ────────────────── */

/**
 * 名录拍平成「一个人一条」，按最近出现排序。
 * @returns {Array<{puuid,name,gameIds:string[]}>}
 */
export function listPlayers(roster = null) {
  const r = roster || loadRoster();
  const byPuuid = new Map();

  // games 的键顺序不保证时间序，所以先按 gameId 倒序走一遍 ——
  // gameId 是递增的（国服），越大越新，于是「后写进去的名字」自然是新名字
  const gids = Object.keys(r.games).sort();
  for (const gid of gids) {
    for (const p of r.games[gid] || []) {
      let rec = byPuuid.get(p.puuid);
      if (!rec) { rec = { puuid: p.puuid, name: null, gameIds: [] }; byPuuid.set(p.puuid, rec); }
      if (p.name) rec.name = p.name;              // 倒序遍历 → 最后留下的就是最新昵称
      rec.gameIds.push(gid);
    }
  }
  // 展示时按局数多的在前
  return [...byPuuid.values()].sort((a, b) => b.gameIds.length - a.gameIds.length);
}

/**
 * 按昵称找人在名录里匹配（不区分大小写，包含匹配）。
 *
 * 精确命中排最前 —— 输入「路人甲」时，不该让「路人甲的小号」抢在前面。
 */
export function findPlayers(query, { limit = 20, roster = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const all = listPlayers(roster);
  const exact = [];
  const fuzzy = [];
  for (const p of all) {
    const name = String(p.name || '').toLowerCase();
    const puuid = String(p.puuid || '').toLowerCase();
    if (name === q || puuid === q) exact.push(p);
    else if (name.includes(q) || puuid.startsWith(q)) fuzzy.push(p);
  }
  return [...exact, ...fuzzy].slice(0, limit);
}

/** 单人详情（含参与的局） */
export function getPlayer(puuid) {
  if (!puuid) return null;
  return listPlayers().find((p) => p.puuid === puuid) || null;
}

/* ────────────────── 查询结果缓存 ────────────────── */

const safeName = (puuid) => String(puuid).replace(/[^a-zA-Z0-9-]/g, '') || 'unknown';

export function searchCacheFile(puuid) {
  return path.join(SEARCHED_DIR, `${safeName(puuid)}.json`);
}

export function loadSearchCache(puuid) {
  try {
    return JSON.parse(fs.readFileSync(searchCacheFile(puuid), 'utf8'));
  } catch { return null; }
}

export function saveSearchCache(puuid, payload) {
  fs.mkdirSync(SEARCHED_DIR, { recursive: true });
  fs.writeFileSync(searchCacheFile(puuid), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export function isFresh(cache, ttlMs = SEARCH_TTL_MS) {
  if (!cache?.fetchedAt) return false;
  const at = Date.parse(cache.fetchedAt);
  return Number.isFinite(at) && Date.now() - at < ttlMs;
}

export default {
  ROSTER_FILE, SEARCHED_DIR, SEARCH_TTL_MS,
  loadRoster, saveRoster, rememberPlayers, rememberPlayersBatch, seedRoster,
  listPlayers, findPlayers, getPlayer,
  searchCacheFile, loadSearchCache, saveSearchCache, isFresh,
};
