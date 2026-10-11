/**
 * 游戏静态数据层 —— 出装 / 强化符文（海克斯）的 id → 名称 + 图标
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 为什么单开一个模块，而不是塞进 champions.mjs：                    │
 * │                                                                │
 * │   英雄表是「对局必需」—— 没有它连英雄名都显示不出来；             │
 * │   出装 / 符文是「评估增强」—— 提示词 v2.4 的【多维评估要求】      │
 * │   要模型读 playerAugment1-6 与 item0-6，但模型拿到一串裸 id      │
 * │   等于没给。所以这里把 id 翻成人话，喂给模型的是「暴击飞弹 /       │
 * │   升级：无尽之刃」，模型才谈得上评估。                            │
 * │                                                                │
 * │   两者数据量差一个量级（英雄 ~170 条 vs 装备 800+ / 符文 500+）， │
 * │   缓存文件也分开，避免英雄表被撑肥。                             │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 数据来源两条路，优先级从高到低：
 *   1. LCU `/lol-game-data/assets/v1/items.json`、`.../cherry-augments.json`
 *      —— 与客户端版本完全一致，但要客户端在跑；
 *   2. 本地缓存 `data/gamedata.json` —— 客户端没开时用它；
 *      `tools/seed-gamedata.mjs` 可从公共镜像离线播种这一份。
 *
 * 缓存策略与 champions.mjs 一致：TTL 24h，过期后先试 LCU，失败继续用旧缓存。
 */

import fs from 'node:fs';
import path from 'node:path';
import { lcuRequest } from './client.mjs';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ITEMS_ENDPOINT = '/lol-game-data/assets/v1/items.json';
const AUGMENTS_ENDPOINT = '/lol-game-data/assets/v1/cherry-augments.json';

/** 符文稀有度 → 中文。LCU 给的是 kGold / kPrismatic / kSilver / kEventChoice */
export const RARITY_CN = {
  kSilver: '银',
  kGold: '金',
  kPrismatic: '棱彩',
  kEventChoice: '事件',
};

/**
 * 不该进「出装」格子的一次性消耗品 / 饰品 / 守卫。
 *
 * 只按 categories 白名单过滤不行 —— 真机 items 数组里混着 2052（控制守卫）、
 * 3340（监视守卫）这类，占了格子却跟「出装」没关系。故用黑名单剔除。
 * 注意 2052 在样例里是第 7 格，界面按顺序展示，滤掉后正好剩 6 件正装。
 */
const NON_BUILD_ITEM_IDS = new Set([
  2051, 2052, 2053, 2054, 2055,       // 守卫 / 眼石系
  3340, 3341, 3361, 3362, 3363, 3364, // 饰品
  3301, 3302, 3303, 3304,             // 打野蛋 / 宠物
]);

/** 判断一个 id 是不是我们要展示的「成装」 */
export function isBuildItem(id) {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 && !NON_BUILD_ITEM_IDS.has(n);
}

/** 只保留 id / name / icon —— 870 条装备的完整描述有 680KB，界面与模型都用不上 */
function trimItems(raw) {
  const byId = {};
  for (const it of Array.isArray(raw) ? raw : []) {
    const id = Number(it?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId[id] = {
      id,
      name: String(it.name || '').trim() || `装备${id}`,
      icon: it.iconPath || null,
    };
  }
  return byId;
}

/**
 * 符文表。
 * ★ 国服字段实测（2026-10-10，communitydragon zh_cn 镜像与 LCU 同源）：
 *   中文名在 `nameTRA`，不是 `name` —— 这个接口压根没有 name 字段。
 *   小图标在 `augmentSmallIconPath`（海克斯大乱斗用 _small，Arena 用大图）。
 */
function trimAugments(raw) {
  const byId = {};
  for (const a of Array.isArray(raw) ? raw : []) {
    const id = Number(a?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const name = String(a.nameTRA || a.simpleNameTRA || '').trim();
    byId[id] = {
      id,
      name: name || `符文${id}`,
      icon: a.augmentSmallIconPath || a.augmentLargeIconPath || null,
      rarity: a.rarity || null,
      rarityCn: RARITY_CN[a.rarity] || null,
    };
  }
  return byId;
}

export function buildGameData(itemRaw, augmentRaw) {
  const items = trimItems(itemRaw);
  const augments = trimAugments(augmentRaw);
  return { items, augments, count: { items: Object.keys(items).length, augments: Object.keys(augments).length } };
}

const emptyGameData = () => ({ items: {}, augments: {}, count: { items: 0, augments: 0 }, from: 'none' });

/**
 * 载入出装 / 符文表。
 * @param {object|null} conn LCU 连接；为 null 时只读缓存
 * @param {object} opts { cacheFile, force }
 */
export async function loadGameData(conn = null, { cacheFile = null, force = false } = {}) {
  const readCache = (allowStale) => {
    if (!cacheFile) return null;
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!c?.items || !c?.augments) return null;
      if (!allowStale && c.at && Date.now() - c.at >= CACHE_TTL_MS) return null;
      return c;
    } catch { return null; }
  };

  // 1. 缓存新鲜 → 直接用
  if (!force) {
    const fresh = readCache(false);
    if (fresh) return { ...fresh, from: 'cache' };
  }

  // 2. 从 LCU 拉（两个接口独立失败，任一成功也能更新对应那张表）
  if (conn) {
    try {
      const [itemsRaw, augmentsRaw] = await Promise.all([
        lcuRequest(conn, { endpoint: ITEMS_ENDPOINT, timeoutMs: 20000 }).catch(() => null),
        lcuRequest(conn, { endpoint: AUGMENTS_ENDPOINT, timeoutMs: 20000 }).catch(() => null),
      ]);
      const built = buildGameData(itemsRaw, augmentsRaw);
      if (built.count.items > 0 || built.count.augments > 0) {
        // 某一侧拉失败时，用它自己那份旧缓存补上，别让整表倒退
        const old = readCache(true);
        if (built.count.items === 0 && old?.items) built.items = old.items;
        if (built.count.augments === 0 && old?.augments) built.augments = old.augments;
        built.count = { items: Object.keys(built.items).length, augments: Object.keys(built.augments).length };
        const payload = { at: Date.now(), source: 'lcu', ...built };
        if (cacheFile) {
          try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify(payload), 'utf8');
          } catch { /* 写不了缓存不影响运行 */ }
        }
        return { ...payload, from: 'lcu' };
      }
    } catch { /* 客户端没开就走缓存 */ }
  }

  // 3. 回退到过期缓存
  const stale = readCache(true);
  if (stale) return { ...stale, from: 'stale-cache' };

  return emptyGameData();
}

/**
 * 出装 id 列表 → 可展示对象数组。
 * 查不到名字的保留原始 id（显示成「装备1234」），不丢格子 ——
 * 新装备总是先出现在客户端，晚一步才有中文名。
 */
export function resolveItems(ids, gameData) {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter(isBuildItem)
    .map((raw) => {
      const id = Number(raw);
      const hit = gameData?.items?.[id];
      return { id, name: hit?.name || `装备${id}`, icon: hit?.icon || null };
    });
}

/** 强化符文 id 列表 → 可展示对象数组（顺序保留 = 模型看到的仍是选择顺序） */
export function resolveAugments(ids, gameData) {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((x) => Number(x) > 0)
    .map((raw) => {
      const id = Number(raw);
      const hit = gameData?.augments?.[id];
      return {
        id,
        name: hit?.name || `符文${id}`,
        icon: hit?.icon || null,
        rarity: hit?.rarity || null,
        rarityCn: hit?.rarityCn || null,
      };
    });
}

/**
 * 从 EOG / match-detail 的玩家对象里抠出「出装 + 符文」的原始 id。
 *
 * ★ 两个来源字段位置不同，这里统一：
 *   EOG          → player.items = [3165, 3118, …, 2052]（数组）
 *   match-detail → player.stats.item0 … item6（散字段，数组里可能压根没有 items）
 *   符文两边都在 stats.playerAugment1 … playerAugment6，0 表示空槽。
 */
export function extractRawIds(p = {}) {
  const s = p.stats || {};
  let itemIds = Array.isArray(p.items) ? p.items.slice() : null;
  if (!itemIds) itemIds = [0, 1, 2, 3, 4, 5, 6].map((i) => s[`item${i}`]);
  const augmentIds = [1, 2, 3, 4, 5, 6].map((i) => s[`playerAugment${i}`]);
  return { itemIds, augmentIds };
}

export default {
  loadGameData, buildGameData, resolveItems, resolveAugments, extractRawIds,
  isBuildItem, RARITY_CN,
};
