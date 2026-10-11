/**
 * 战绩列表 —— 把「一局对局」压成列表里的一行。
 *
 * 两个来源要压成同一种形状：
 *   ① LCU 对局列表里的一局（含完整 participants / participantIdentities）
 *   ② 已落盘的战报 data/reports/{gameId}.json（含整理好的 dataset）
 *
 * 为什么要有这个模块：LCU 只肯给最近 2 局（真机实测 gameCount=2，begIndex 随便传
 * 都只回这两局，也没有 refresh 端点）。所以「所有战绩」靠本地累积 —— 见过的每一局
 * 都记进索引，窗口滑走了也还在。本模块负责把两种来源归一化，合并逻辑在 service.mjs。
 */

import { resolveChampion } from './champions.mjs';
import { queueLabel, MAP_CN, toClock } from './normalize.mjs';

/** 空条目在列表里的占位 —— 界面据此显示「—」 */
const UNKNOWN = null;

/**
 * 从 stats 里取一个数值字段。
 *
 * 兼容两种拼写：LCU 接口给的是 camelCase（totalDamageDealtToChampions），
 * EOG / 历史格式给的是 UPPER_SNAKE（TOTAL_DAMAGE_DEALT_TO_CHAMPIONS）——
 * 与 normalize.mjs 的处理口径一致。取不到就是 UNKNOWN（界面显示「—」），
 * 不拿 0 冒充 —— 0 和「不知道」在列表里是两种意思。
 */
function statNum(stats, camel, snake) {
  const raw = stats?.[camel] ?? (snake ? stats?.[snake] : undefined);
  if (raw === null || raw === undefined) return UNKNOWN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : UNKNOWN;
}

/**
 * 从 match-detail 里找出「我」是哪个 participantId。
 *
 * ★ 必须按 puuid 精确匹配，不能按队伍推 —— 我方 5 个人，只按队伍只能知道阵营。
 * 匹配不上就返回 null（宁可显示未知，也不要随便指一个人当自己）。
 */
function findMyParticipantId(matchDetail, myPuuid) {
  if (!matchDetail || !myPuuid) return null;
  const hit = (matchDetail.participantIdentities || [])
    .find((x) => x?.player?.puuid && x.player.puuid === myPuuid);
  return hit?.participantId ?? null;
}

/**
 * 一局 LCU 对局（对局列表里的条目 / match-detail 响应）→ 列表行。
 *
 * @param {object} game   /lol-match-history/v1/games/{gameId} 或列表里的 games[i]
 * @param {object} opts
 *   myPuuid      本人 puuid —— 用来确定「我用的哪个英雄」
 *   ownerPuuid   归属账号。默认就是 myPuuid；重判别人的局时显式传原主人，
 *                否则会把一局「判给了另一个账号」
 *   championMap  英雄表（把 championId 转成国服中文名）
 */
export function summarizeGame(game, { myPuuid = null, ownerPuuid = undefined, championMap = null } = {}) {
  if (!game) return null;

  const myPid = findMyParticipantId(game, myPuuid);
  const mine = (game.participants || []).find((p) => p.participantId === myPid) || null;

  const queueId = game.queueId ?? null;
  const mapId = game.mapId ?? null;
  const durationSec = Number(game.gameDuration ?? 0);
  const champ = mine
    ? resolveChampion(championMap, { championId: mine.championId })
    : null;

  return {
    gameId: game.gameId ?? null,
    createdAt: game.gameCreation ?? null,
    createdText: game.gameCreationDate || null,
    durationSec,
    durationText: toClock(durationSec),
    queueId,
    mapId,
    mapName: MAP_CN[mapId] || null,
    mode: queueLabel(queueId, mapId, game.gameMode),
    champion: champ?.name || UNKNOWN,
    championTitle: champ?.title || UNKNOWN,
    championIcon: champ?.icon || UNKNOWN,
    kills: mine?.stats?.kills ?? UNKNOWN,
    deaths: mine?.stats?.deaths ?? UNKNOWN,
    assists: mine?.stats?.assists ?? UNKNOWN,
    win: typeof mine?.stats?.win === 'boolean' ? mine.stats.win : UNKNOWN,
    // ── 关键数据（v2.5）：列表行 KDA 后面要直接显示，不必点进去 ──
    // 实测 LCU 的对局列表本身就带全套 stats（每局只回"我"这一名参与者），
    // 所以最近 200 局都能直接拿到；更老的条目靠 listMatches 的补录步骤补。
    damageDealt: statNum(mine?.stats, 'totalDamageDealtToChampions', 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS'),
    damageTaken: statNum(mine?.stats, 'totalDamageTaken', 'TOTAL_DAMAGE_TAKEN'),
    healing: statNum(mine?.stats, 'totalHeal', 'TOTAL_HEAL'),
    goldEarned: statNum(mine?.stats, 'goldEarned', 'GOLD_EARNED'),
    cs: statNum(mine?.stats, 'totalMinionsKilled', 'MINIONS_KILLED'),
    // 有英雄没英雄，决定这行能不能直接显示「我玩了谁」
    hasMe: !!mine && !!champ,
    // 归属账号：**本人确实在这一局里**才算他打的。
    // 早先这里写的是 `myPuuid || null` —— 于是换号窗口期里，客户端缓存中
    // 上一个号的对局全部被记到新号名下（那会儿还没登记过，mergeEntry 保不住）。
    // 认不出主人就留空（归入 unowned），不要拿「此刻登录的是谁」去猜。
    ownerPuuid: ownerPuuid !== undefined ? ownerPuuid : (myPid != null ? myPuuid : null),
    from: 'lcu',
    analyzedAt: null,
  };
}

/**
 * 已落盘战报 → 列表行。
 *
 * 战报里没有「我是哪个 pid」—— 只标了 isMyTeam（阵营）。
 * 所以从战报只能拿到 模式 / 时长 / 胜负；英雄留空，等 LCU 能拉到详情时补录。
 * 落盘时 names 已被剔除，这里也不去碰。
 */
export function summarizeReport(report) {
  const m = report?.dataset?.match;
  if (!m?.gameId) return null;

  return {
    gameId: m.gameId,
    // ★ 故意留空：战报里只有「生成时间」，不是「对局时间」，拿它当对局时间会错位
    //   （实测差 26 分钟）。对局时间只有 LCU 能给，等补录时填上。
    createdAt: null,
    createdText: null,
    durationSec: Number(m.durationSec ?? 0),
    durationText: m.durationText || toClock(Number(m.durationSec ?? 0)),
    queueId: m.queueId ?? null,
    mapId: m.mapId ?? null,
    mapName: m.mapName || MAP_CN[m.mapId] || null,
    mode: m.mode || queueLabel(m.queueId, m.mapId),
    champion: UNKNOWN,
    championTitle: UNKNOWN,
    championIcon: UNKNOWN,
    kills: UNKNOWN,
    deaths: UNKNOWN,
    assists: UNKNOWN,
    win: m.myResult ? m.myResult === 'WIN' : UNKNOWN,
    // 关键数据留空：战报里只有 isMyTeam（阵营），没有「我是哪一名参与者」，
    // 拿不准是谁的伤害就不写 —— 由 listMatches 的补录步骤按归属账号从对局详情补。
    damageDealt: UNKNOWN,
    damageTaken: UNKNOWN,
    healing: UNKNOWN,
    goldEarned: UNKNOWN,
    cs: UNKNOWN,
    hasMe: false,
    ownerPuuid: report?.meta?.ownerPuuid || null,
    from: 'report',
    analyzedAt: report?.meta?.generatedAt || null,
    // 战报里的判定结论，列表可以直接给一行摘要
    verdict: report?.result?.verdict || null,
  };
}

/**
 * LCU 来源权威的字段 —— 这些一律以 LCU 的新值为准。
 *
 * 为什么单独列出来：战报和 LCU 是同一局的两份记录，但**语义不同** ——
 * 战报里的 meta.generatedAt 是「我什么时候判的」，不是「这一局什么时候打的」。
 * 不区分的话，战报的生成时间会把真实对局时间盖掉（实测差 26 分钟）。
 */
const LCU_WINS = new Set([
  'createdAt', 'createdText', 'durationSec', 'durationText', 'queueId', 'mapId', 'mapName',
  'mode', 'champion', 'championTitle', 'championIcon', 'kills', 'deaths', 'assists', 'win',
  // 关键数据同理：只有 LCU 能精确到「我」，故一律以它的值为准
  'damageDealt', 'damageTaken', 'healing', 'goldEarned', 'cs',
]);

/**
 * 合并两条同一局的记录。
 *
 * 规则：
 *   · LCU 来的条目 —— 上述字段直接覆盖（英雄 / KDA / 胜负 / 对局时间都是真值）
 *   · 战报来的条目 —— 只补它独有的（analyzedAt / verdict），不碰已有真值
 *   · 任何空值都不参与覆盖，避免把已拿到的真实英雄名抹成 null
 */
export function mergeEntry(oldEntry, newEntry) {
  if (!oldEntry) return { ...newEntry };
  if (!newEntry) return { ...oldEntry };

  const fromLcu = newEntry.from === 'lcu';
  const merged = { ...oldEntry };

  for (const [k, v] of Object.entries(newEntry)) {
    if (v === null || v === undefined) continue;          // 空值不覆盖
    if (fromLcu && LCU_WINS.has(k)) { merged[k] = v; continue; }
    if (merged[k] === null || merged[k] === undefined) merged[k] = v;
  }

  merged.from = oldEntry.from === 'lcu' || newEntry.from === 'lcu' ? 'lcu' : 'report';
  merged.hasMe = !!(merged.champion && merged.kills !== null && merged.kills !== undefined);
  merged.analyzedAt = newEntry.analyzedAt || oldEntry.analyzedAt || null;
  merged.verdict = newEntry.verdict || oldEntry.verdict || null;
  // 归属一旦定下就不再改：重判别人的局时调用方传的是原主人，
  // 万一哪天传错了，这里也不让「把一局判给另一个账号」这种事发生。
  merged.ownerPuuid = oldEntry.ownerPuuid || newEntry.ownerPuuid || null;

  return merged;
}

/** 列表排序：时间倒序（没有时间戳的排最后） */
export function sortEntries(entries) {
  return entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * 这一局算不算「某个账号的」。
 *
 * @param {object} entry  战绩条目
 * @param {string} owner  过滤条件：puuid | 'all'（全部）| 'unowned'（未归属）| 空（不过滤）
 */
export function belongsTo(entry, owner) {
  if (!owner || owner === 'all') return true;
  if (owner === 'unowned') return !entry?.ownerPuuid;
  return entry?.ownerPuuid === owner;
}
