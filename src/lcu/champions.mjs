/**
 * 英雄数据层 —— 提供 championId / 英文 alias → 中文英雄名
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 国服字段语义（2026-10-09 真机实测 /lol-game-data/assets/v1/     │
 * │ champion-summary.json）：                                       │
 * │                                                                 │
 * │   { "id": 1,                                                     │
 * │     "name": "黑暗之女",      ← 称号（国际服这里才是名字）         │
 * │     "description": "安妮",   ← ★ 英雄名，国服玩家真正在叫的       │
 * │     "alias": "Annie",        ← 英文名，EOG 里可能返这个           │
 * │     "roles": ["mage","support"],                                │
 * │     "squarePortraitPath": "/lol-game-data/assets/v1/             │
 * │                            champion-icons/1.png" }              │
 * │                                                                 │
 * │ 所以「取英雄名」要读 description，不是 name。两者反着填是国服      │
 * │ 特有的，国际服语义会反过来 —— 本模块用 looksLikeName() 做自适应。 │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 缓存策略：拉一次写 data/champions.json，24 小时内不重复拉。
 * 客户端没开时回退到缓存文件；两者都没有则映射为空（界面显示 id 原值）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { lcuRequest } from './client.mjs';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SUMMARY_ENDPOINT = '/lol-game-data/assets/v1/champion-summary.json';

/** 英雄类型（LCU roles）→ 中文，与界面展示保持一致 */
export const ROLE_CN = {
  mage: '法师',
  fighter: '战士',
  assassin: '刺客',
  tank: '坦克',
  marksman: '射手',
  support: '辅助',
};

/** 界面用的大类名（normalize 层输出的 championType 值） */
export const TYPE_CN = {
  MAGE: '法师',
  FIGHTER: '战士',
  ASSASSIN: '刺客',
  TANK: '坦克',
  MARKSMAN: '射手',
  SUPPORT: '辅助',
  UNKNOWN: '未知',
};

/**
 * 判断一段文本像不像「英雄名」。
 * 注意：国服 name 与 description 都可能是 2-5 个汉字（「黑暗之女」vs「安妮」），
 * 长度无法区分，所以这个函数只用来挡掉空值 / 长描述文本。
 */
function looksLikeName(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t.length > 10) return false;
  return /^[\u4e00-\u9fa5·]+$/.test(t) || /^[A-Za-z' ]+$/.test(t);
}

/**
 * 从一条 summary 记录里取「英雄名」。
 *
 * 真机实测（国服 TJ101 / 16.20）：
 *   { id: 1,   name: "黑暗之女", description: "安妮",  alias: "Annie" }
 *   { id: 157, name: "疾风剑豪", description: "亚索",  alias: "Yasuo" }
 *   { id: 64,  name: "盲僧",    description: "盲僧",  alias: "LeeSin" }
 *
 * 即：**国服 description 才是英雄名，name 是称号**（国际服语义相反）。
 * 玩家口语说的是英雄名（「亚索」而不是「疾风剑豪」），所以优先 description。
 * 国际服 description 若是长描述文本，looksLikeName 会挡掉，自然退回 name。
 */
export function pickName(record) {
  if (!record) return null;
  const { name, description, alias } = record;
  const d = looksLikeName(description) ? description.trim() : null;
  const n = looksLikeName(name) ? name.trim() : null;
  return d || n || (alias ? String(alias) : null);
}

/** 规范化成 { byId, byAlias, byName } 三张表 */
export function buildMapsFromSummary(list) {
  const byId = {};
  const byAlias = {};
  const byName = {};
  for (const c of list || []) {
    if (!c || c.id <= 0) continue;                 // id=-1 是「无」，跳过
    const name = pickName(c);
    const entry = {
      id: c.id,
      name,
      title: c.name,                               // 称号，界面可作副标题
      alias: c.alias || null,
      roles: (c.roles || []).filter(Boolean),
      rolesCn: (c.roles || []).map((r) => ROLE_CN[r] || r),
      icon: c.squarePortraitPath || null,
    };
    byId[c.id] = entry;
    if (c.alias) byAlias[String(c.alias).toLowerCase()] = entry;
    if (name) byName[name] = entry;
    // 称号也进索引，玩家偶尔会说称号
    if (c.name && c.name !== name) byName[c.name] = byName[c.name] || entry;
  }
  return { byId, byAlias, byName, count: Object.keys(byId).length };
}

/**
 * 载入英雄表。
 * @param {object|null} conn LCU 连接；为 null 时只读缓存
 * @param {object} opts { cacheFile, force }
 * @returns {Promise<{ byId: object, byAlias: object, count: number, from: string }>}
 */
export async function loadChampionMap(conn = null, { cacheFile = null, force = false } = {}) {
  const empty = { byId: {}, byAlias: {}, byName: {}, count: 0, from: 'none' };

  // 1. 缓存有效就直接用
  if (cacheFile && !force) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.at && Date.now() - cached.at < CACHE_TTL_MS && cached.byId) {
        return { ...cached, from: 'cache' };
      }
    } catch { /* 缓存坏了就重拉 */ }
  }

  // 2. 从 LCU 拉
  if (conn) {
    try {
      const list = await lcuRequest(conn, { endpoint: SUMMARY_ENDPOINT, timeoutMs: 15000 });
      const maps = buildMapsFromSummary(list);
      if (maps.count > 0) {
        if (cacheFile) {
          try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), ...maps }), 'utf8');
          } catch { /* 写不了缓存不影响运行 */ }
        }
        return { ...maps, from: 'lcu' };
      }
    } catch { /* 客户端没开就走缓存 */ }
  }

  // 3. 回退到过期缓存
  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.byId) return { ...cached, from: 'stale-cache' };
    } catch { /* 没有就没有 */ }
  }

  return empty;
}

/**
 * 解析一个玩家的英雄名。
 * EOG 给的可能是中文名（国服）、英文 alias，或只有 championId —— 三种都兜住。
 * @param {{byId:object, byAlias:object}} map
 * @param {{championId?:number, championName?:string}} p
 */
export function resolveChampion(map, p = {}) {
  const raw = p.championName;

  // ★ 1. championId 优先 —— 真机 EOG 的 championName 是**称号**不是英雄名
  //    实测：championId=41 → championName="海洋之灾"（Gangplank 的称号），
  //    玩家口中的英雄名是「普朗克」。只有查表才能拿到真名。
  //    mock 样例数据没有 championId，会自然落到下面的分支。
  if (p.championId != null && map?.byId?.[p.championId]) {
    const e = map.byId[p.championId];
    return { name: e.name, title: e.title, roles: e.roles, icon: e.icon };
  }

  // 2. 已是中文名（mock / 无表场景）→ 用索引补称号 / 职业 / 图标
  if (raw && /[\u4e00-\u9fa5]/.test(raw)) {
    const hit = map?.byName?.[raw];
    return { name: raw, title: hit?.title || null, roles: hit?.roles || [], icon: hit?.icon || null };
  }
  // 英文 alias → 查表
  if (raw && map?.byAlias?.[String(raw).toLowerCase()]) {
    const e = map.byAlias[String(raw).toLowerCase()];
    return { name: e.name, title: e.title, roles: e.roles, icon: e.icon };
  }
  return { name: raw || `英雄${p.championId ?? '?'}`, title: null, roles: [], icon: null };
}

export default { loadChampionMap, resolveChampion, pickName, buildMapsFromSummary, ROLE_CN, TYPE_CN };
