/**
 * 数据整理层 —— LCU 原始响应 → 去关联化 dataset
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 四不原则（改这里之前先想清楚，这是项目灵魂）                  │
 * │  1. 不排名        —— 不输出任何「第几名 / 最高 / 最低」        │
 * │  2. 不算均值      —— 不输出队内平均值、中位数等参照系         │
 * │  3. 不做因果关联  —— 不标注事件之间「谁导致谁」               │
 * │  4. 不预设关联窗口 —— 不给「X 秒内算关联」这类判定条件        │
 * │                                                             │
 * │ 边界一句话：字段是「描述单个玩家 / 单个事件自身」→ 留；       │
 * │            是「描述它们之间关系」→ 删。                      │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 本模块允许做：单玩家自身的派生（每分钟速率、参团率）
 * 本模块禁止做：跨玩家聚合比较（均值 / 排名 / 分位 / 差值）
 * 本模块对 timeline 只做三件事：排序 / 毫秒转 mm:ss / 原样搬运字段
 *
 * ───────────────────────────────────────────────────────────────
 * 数据源（真机实测 2026-10-09 · 国服 TJ101 · 16.20.824.8524）：
 *
 *   eog          /lol-end-of-game/v1/eog-stats-block     ← 主数据源，10 人 stats
 *   matchDetail  /lol-match-history/v1/games/{gameId}    ← participantId 桥接
 *                                                           + queueId/mapId
 *   timeline     /lol-match-history/v1/game-timelines/.. ← 事件时间轴
 *   session      /lol-gameflow/v1/session                ← 模式中文名
 *
 * ★ 三个字段陷阱（都已实测确认，别按直觉改回去）：
 *   1. EOG 玩家**没有 participantId** → 必须靠 matchDetail 桥接（见 participants.mjs）
 *   2. EOG 顶层**没有 queueId / mapId** → 在 matchDetail 里（大乱斗 queueId=2400）
 *   3. EOG `championName` 是**称号**（「海洋之灾」），英雄名要靠 championId 查表（普朗克）
 *   4. EOG `events` 是**空数组** → 事件在 timeline 的 frames[].events
 * ───────────────────────────────────────────────────────────────
 */

import { resolveChampion } from './champions.mjs';
import { extractRawIds, resolveAugments, resolveItems } from './gamedata.mjs';
import { buildIdentityIndex, assignPids, flattenPlayers, playerKey } from './participants.mjs';

/** 英雄类型归一化 —— 大乱斗随机英雄无分路，改用英雄类型 */
const CHAMPION_TYPES = ['TANK', 'FIGHTER', 'ASSASSIN', 'MAGE', 'MARKSMAN', 'SUPPORT'];

/** 队列号 → 中文模式名（真机实测：海克斯大乱斗 = 2400，不是老文档写的 450） */
export const QUEUE_CN = {
  2400: '海克斯大乱斗',
  450: '极地大乱斗',
  420: '单双排位',
  440: '灵活排位',
  400: '普通匹配',
  430: '普通匹配',
  1700: '斗魂竞技场',
};

/** 地图号 → 中文名 */
export const MAP_CN = {
  12: '嚎哭深渊',
  11: '召唤师峡谷',
  30: '斗魂竞技场',
};

/**
 * 队列号 → 中文模式名（战绩列表与战报共用同一套判定，避免两处各写一份而对不上）。
 * 优先级：队列号表 → 会话里的队列名 → 按地图兜底 → gameMode。
 */
export function queueLabel(queueId, mapId, gameMode = null, queueName = null) {
  return QUEUE_CN[queueId]
    || (String(queueName || '').trim() || null)
    || (mapId === 12 ? '海克斯大乱斗' : null)
    || gameMode
    || '未知模式';
}

/** 秒 → mm:ss */
export function toClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 取 Data Dragon tags 的第一个作为主类型 */
function primaryType(tags = []) {
  const first = String(tags[0] || '').toUpperCase();
  return CHAMPION_TYPES.includes(first) ? first : 'UNKNOWN';
}

/** 防御塔 / 兵营的中文名（仅用于可读性，不做归因） */
function objectName(raw) {
  if (!raw) return null;
  const map = {
    TURRET_ORDER_1: '蓝色方外塔', TURRET_ORDER_2: '蓝色方内塔', TURRET_ORDER_3: '蓝色方高地塔',
    TURRET_CHAOS_1: '红色方外塔', TURRET_CHAOS_2: '红色方内塔', TURRET_CHAOS_3: '红色方高地塔',
    INHIBITOR_ORDER_1: '蓝色方兵营', INHIBITOR_CHAOS_1: '红色方兵营',
  };
  return map[raw] || raw;
}

/**
 * 真机 BUILDING_KILL 的目标描述。
 * 字段是 towerType / buildingType / laneType 三个分开的枚举，
 * 不像老文档写的是一个字符串 —— 拆开拼成一句人话。
 */
const TOWER_CN = {
  OUTER_TURRET: '外塔', INNER_TURRET: '内塔',
  BASE_TURRET: '高地塔', NEXUS_TURRET: '门牙塔',
};
const LANE_CN = { TOP_LANE: '上路', MID_LANE: '中路', BOT_LANE: '下路' };
const BUILDING_CN = { INHIBITOR_BUILDING: '兵营', TOWER_BUILDING: '防御塔', NEXUS_BUILDING: '水晶' };

function buildingTarget(e) {
  const bt = BUILDING_CN[e.buildingType] || null;
  if (e.buildingType === 'TOWER_BUILDING' || e.towerType) {
    const tower = TOWER_CN[e.towerType] || e.towerType || '防御塔';
    const lane = LANE_CN[e.laneType] || null;
    return lane ? `${lane}${tower}` : tower;
  }
  return bt || (e.towerType ? (TOWER_CN[e.towerType] || e.towerType) : null);
}

/**
 * 把两个来源的事件拍平成统一形状。
 *   真机：timeline.frames[].events  → timestamp(毫秒) / killerId / victimId / assistingParticipantIds
 *   旧版：eog.events                → eventTime(秒)  / killer   / victim   / assisters
 * 两边字段名完全不同，不能靠猜，只能按来源分别取。
 */
function flattenEvents(eog, timeline) {
  const out = [];

  for (const f of timeline?.frames || []) {
    for (const e of f.events || []) out.push({ src: 'live', e });
  }
  // 兼容 mock / 早期格式（真机上 eog.events 恒为空数组）
  for (const e of eog?.events || []) out.push({ src: 'legacy', e });

  return out;
}

/**
 * 主入口：把 LCU 原始数据整理成 dataset
 *
 * @param {object} eog  /lol-end-of-game/v1/eog-stats-block 原样返回
 * @param {object} opts
 *   myTeamId     本方阵营（不传则取 EOG 的 isPlayerTeam / localPlayer.teamId）
 *   championMap  英雄表（loadChampionMap 产出）
 *   gameData     出装 / 符文表（loadGameData 产出）；不传则两者留空数组
 *   matchDetail  /lol-match-history/v1/games/{gameId}（提供 participantId 桥接）
 *   timeline     /lol-match-history/v1/game-timelines/{gameId}（提供事件）
 *   session      /lol-gameflow/v1/session（提供模式中文名）
 *   identityIndex 已建好的身份索引（幂等，省一次重复构建）
 */
export function normalize(eog, opts = {}) {
  const championMap = opts.championMap || null;
  const gameData = opts.gameData || null;
  const matchDetail = opts.matchDetail || null;
  const session = opts.session || null;
  const identityIndex = opts.identityIndex ?? buildIdentityIndex(matchDetail);

  const durationSec = Number(eog?.gameLength ?? matchDetail?.gameDuration ?? 0);
  const minutes = Math.max(durationSec / 60, 1);   // 防除零
  const players = flattenPlayers(eog);

  // ── 匿名 pid：靠 matchDetail 桥接出 participantId，再按 id 升序编号 ──
  const pids = assignPids(players, identityIndex);
  const pidFor = (p, i) => pids.byKey.get(playerKey(p, i)) || null;

  // ── 视角：EOG 自带标记最可靠（真机 isPlayerTeam / isPlayerWin 均在 teams[] 上）──
  const myTeamId = opts.myTeamId
    ?? eog?.localPlayer?.teamId
    ?? (eog?.teams || []).find((t) => t.isPlayerTeam)?.teamId
    ?? null;

  const isWinner = (t) => {
    if (!t) return false;
    if (typeof t.isWinningTeam === 'boolean') return t.isWinningTeam;
    if (t.win != null) return String(t.win).toLowerCase() === 'win';   // match-detail: "Win"/"Fail"
    return false;
  };

  // ── 队伍层：只保留「客观总量」，不作为跨玩家比较的参照系 ──
  // 队伍总击杀是事实本身（用于推导单人参团率），不是均值 / 排名 / 分位
  const teams = (eog?.teams || []).map((t) => ({
    teamId: t.teamId,
    isWinningTeam: isWinner(t),
    isMyTeam: t.teamId === myTeamId,
    teamKills: (t.players || []).reduce((sum, p) => sum + Number(p.stats?.kills ?? p.stats?.CHAMPIONS_KILLED ?? 0), 0),
  }));
  const killsByTeam = new Map(teams.map((t) => [t.teamId, t.teamKills]));

  // ── 玩家层：只描述单个玩家自身 ──
  const outPlayers = players.map((p, i) => {
    const s = p.stats || {};
    const teamKills = killsByTeam.get(p.teamId) || 0;

    const kills = Number(s.kills ?? s.CHAMPIONS_KILLED ?? 0);
    const deaths = Number(s.deaths ?? s.NUM_DEATHS ?? 0);
    const assists = Number(s.assists ?? s.ASSISTS ?? 0);

    const kp = teamKills > 0 ? Math.round(((kills + assists) / teamKills) * 100) / 100 : null;

    // 英雄：★ 真机 championName 是称号，必须优先用 championId 查表拿英雄名
    const champ = resolveChampion(championMap, {
      championId: p.championId,
      championName: p.championName,
    });
    // 类型优先用 EOG 自带 tags（真机没有这个字段），缺失时退到英雄表的 roles
    const tagType = primaryType(p.championTags);
    const mapType = champ.roles?.[0] ? String(champ.roles[0]).toUpperCase() : 'UNKNOWN';
    const championType = tagType !== 'UNKNOWN' ? tagType : (CHAMPION_TYPES.includes(mapType) ? mapType : 'UNKNOWN');

    const dmgDealt = Number(s.totalDamageDealtToChampions ?? s.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS ?? 0);
    const dmgTaken = Number(s.totalDamageTaken ?? s.TOTAL_DAMAGE_TAKEN ?? 0);
    const gold = Number(s.goldEarned ?? s.GOLD_EARNED ?? 0);
    const cs = Number(s.totalMinionsKilled ?? s.MINIONS_KILLED ?? 0);
    const healing = Number(s.totalHeal ?? s.TOTAL_HEAL ?? 0);
    const shielding = Number(s.totalDamageShieldedOnTeammates ?? s.TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES ?? 0);
    const mitigated = Number(s.damageSelfMitigated ?? s.TOTAL_DAMAGE_SELF_MITIGATED ?? 0);
    const turretDamage = Number(s.damageDealtToTurrets ?? s.TOTAL_DAMAGE_DEALT_TO_TURRETS ?? 0);
    const ccTime = Number(s.totalTimeCCDealt ?? s.TOTAL_TIME_CC_DEALT ?? 0);
    const timeDead = Number(s.totalTimeSpentDead ?? 0);

    // 出装 / 强化符文：原始 id 来自两个位置不同的字段，由 extractRawIds 统一后查表翻名。
    // 提示词 v2.4 的【多维评估要求】要模型读这两项 —— 喂裸 id 等于没喂。
    // 顺序原样保留：符文的顺序就是选择顺序（第 1 个是先选的），出装顺序就是物品栏顺序。
    const rawIds = extractRawIds(p);
    const items = resolveItems(rawIds.itemIds, gameData);
    const augments = resolveAugments(rawIds.augmentIds, gameData);

    return {
      pid: pidFor(p, i),
      participantId: pids.order.find((r) => r.key === playerKey(p, i))?.participantId ?? null,
      teamId: p.teamId,
      isMyTeam: p.teamId === myTeamId,
      champion: champ.name,
      championTitle: champ.title || null,          // 称号（如「疾风剑豪」），界面作副标题
      // 真机 EOG 直接给图标路径；查表兜底
      championIcon: p.championSquarePortraitPath || champ.icon || null,
      championType,
      championTags: p.championTags || champ.roles || [],
      level: p.level ?? s.champLevel ?? null,
      runes: p.runes || [],
      // 【出装】已过滤守卫 / 饰品，剩的是真正的成装；查不到名字的保留 id 兜底
      items,
      // 【强化符文】海克斯大乱斗 / 斗魂竞技场才有，其他模式恒为空数组。
      // 空数组 ≠ 数据缺失：模型据此跳过该角度（提示词第 4 条说得很清楚）
      augments,

      // 绝值
      kills, deaths, assists,
      cs, gold, damageDealt: dmgDealt, damageTaken: dmgTaken,
      damageMitigated: mitigated, healing, shielding, turretDamage, ccTime, timeDead,
      largestMultiKill: Number(s.largestMultiKill ?? 0),

      // 单玩家自身属性（参团率 = (击杀+助攻) / 队伍总击杀，分母是客观事实）
      killParticipation: kp,

      // 对局 8-20 分钟 → 绝对值改每分钟速率，避免短局被系统性低估
      perMinute: {
        damageDealt: rate(dmgDealt, minutes),
        damageTaken: rate(dmgTaken, minutes),
        gold: rate(gold, minutes),
        cs: rate(cs, minutes),
        healing: rate(healing, minutes),
        shielding: rate(shielding, minutes),
        mitigated: rate(mitigated, minutes),
        turretDamage: rate(turretDamage, minutes),
        timeDead: rate(timeDead, minutes),
      },
    };
  });

  // ── 时间轴：只做排序 + 毫秒转 mm:ss + 原样搬运字段 ──
  // 不编号、不做间隔标注、不做 event→consequence 映射
  const rawEvents = flattenEvents(eog, opts.timeline)
    .map(({ src, e }) => {
      const tSec = src === 'live' ? Number(e.timestamp || 0) / 1000 : Number(e.eventTime || 0);
      return { src, e, tSec };
    })
    .sort((a, b) => a.tSec - b.tSec);

  const pidOfParticipant = (id) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return null;   // ★ 真机用 0 表示「无」
    return pids.byParticipantId.get(n) || null;
  };

  const timeline = rawEvents.map(({ src, e, tSec }) => {
    const base = { time: toClock(tSec), type: e.type };

    const actorRaw = src === 'live' ? e.killerId : e.killer;
    const victimRaw = src === 'live' ? e.victimId : e.victim;
    const assistRaw = src === 'live' ? e.assistingParticipantIds : e.assisters;

    const actor = pidOfParticipant(actorRaw);
    if (actor) base.actor = actor;                    // 0 = 小兵 / 防御塔击杀，不记 actor
    const victim = pidOfParticipant(victimRaw);
    if (victim) base.victim = victim;
    if (Array.isArray(assistRaw) && assistRaw.length) {
      const list = assistRaw.map(pidOfParticipant).filter(Boolean);
      if (list.length) base.assisters = list;
    }

    // 目标物：真机是三个枚举字段拼出来的，旧格式是单个字符串
    if (src === 'live') {
      if (e.type === 'BUILDING_KILL') {
        const target = buildingTarget(e);
        if (target) base.object = target;
      }
    } else if (e.turret) {
      base.object = objectName(e.turret);
    }

    if (e.winningTeam != null) base.winningTeam = e.winningTeam;
    return base;
  });

  const myTeam = teams.find((t) => t.isMyTeam) || null;

  /* ── 阵亡时间点：按人聚合，**只搬运事实、不做任何加工** ──
     为什么单独拎出来：时间轴里 CHAMPION_KILL 混在两百多条事件中，
     模型要自己从「谁在 03:12 死了」里挑出某一个人的全部死亡时刻，
     既费 token 又容易看漏。这里把它显式写进 player，
     它仍然是客观事实（哪一刻死的），**不涉及四不原则禁止的窗口/均值/排名**。

     `timeDead` 是死亡总时长（合计），
     `deathTimes` 是**发生在什么时候** —— 前者只说「死了多久」，
     后者才看得出「开局就送 / 每次团战都第一个死 / 后期才崩」。
  */
  const deathsByPid = new Map();
  for (const ev of timeline) {
    if (ev.victim) {
      if (!deathsByPid.has(ev.victim)) deathsByPid.set(ev.victim, []);
      deathsByPid.get(ev.victim).push(ev.time);
    }
  }
  for (const pl of players) {
    pl.deathTimes = deathsByPid.get(pl.pid) || [];
  }

  // 队列 / 地图：真机这两个都在 match-detail，EOG 顶层没有
  const queueId = matchDetail?.queueId ?? eog?.queueId ?? session?.gameData?.queue?.id ?? null;
  const mapId = matchDetail?.mapId ?? eog?.mapId ?? session?.gameData?.queue?.mapId ?? null;
  const gameMode = matchDetail?.gameMode ?? eog?.gameMode ?? null;
  const queueName = String(session?.gameData?.queue?.name || '').trim() || null;

  return {
    match: {
      gameId: eog?.gameId ?? matchDetail?.gameId ?? null,
      mapId,
      mapName: MAP_CN[mapId] || null,
      queueId,
      queueName,
      mode: queueLabel(queueId, mapId, gameMode, queueName),
      gameMode,
      gameVersion: matchDetail?.gameVersion || null,
      durationSec,
      durationText: toClock(durationSec),
      myTeamId,
      myResult: myTeam ? (myTeam.isWinningTeam ? 'WIN' : 'LOSE') : null,
    },
    teams,
    players: outPlayers,
    timeline,
    // 供隐私层校验用：pid 分配是否完整（塌成一个 pid 会在这里暴露）
    integrity: {
      playerCount: outPlayers.length,
      distinctPids: new Set(outPlayers.map((p) => p.pid)).size,
      unresolvedIdentity: pids.unresolvedCount,
    },
  };
}

/** 每秒速率保留 1 位小数 */
function rate(value, minutes) {
  return Math.round((Number(value || 0) / minutes) * 10) / 10;
}

export default normalize;
