/**
 * participantId 解析 + 匿名 pid 分配 —— 全项目唯一实现
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ 为什么必须只有一份：                                              │
 * │   normalize 产物里的 pid，与 buildNameMap 的「昵称 → pid」必须      │
 * │   严格一致。对不上，anonymize 就会把 A 的昵称换成 B 的 pid，         │
 * │   等于把真实姓名喂给模型（隐私层直接失效）。                        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 真机实测（2026-10-09 · 国服 TJ101 · 16.20.824.8524）：
 *
 *   /lol-end-of-game/v1/eog-stats-block
 *     teams[].players[]  ★ 没有 participantId
 *     只有 summonerId / puuid / summonerName / riotIdGameName
 *
 *   /lol-match-history/v1/games/{gameId}
 *     participantIdentities[].participantId + .player.summonerId   ← 桥接靠这里
 *     participants[].participantId + .teamId + .championId
 *
 *   /lol-match-history/v1/game-timelines/{gameId}
 *     frames[].events[].killerId / victimId / assistingParticipantIds
 *     ★ 用的是 1..10 的 participantId
 *
 * 后果：不桥接的话 EOG 十名玩家的 participantId 全是 undefined，
 *       排序失效、Map 键全一样，最终**十个人塌成同一个 pid**
 *       （实测全部变成 p10，界面十张卡名字一模一样）。
 */

/** 从 match-detail 建索引：把「玩家身份」映射到 participantId */
export function buildIdentityIndex(matchDetail) {
  const bySummonerId = new Map();
  const byPuuid = new Map();
  const byTeamChampion = new Map();

  for (const id of matchDetail?.participantIdentities || []) {
    const pl = id?.player || {};
    if (pl.summonerId != null && pl.summonerId !== 0) bySummonerId.set(String(pl.summonerId), id.participantId);
    if (pl.puuid) byPuuid.set(String(pl.puuid), id.participantId);
  }
  // 兜底：同队内英雄不重复，所以 (teamId, championId) 能唯一定位
  for (const p of matchDetail?.participants || []) {
    if (p?.teamId != null && p?.championId != null) {
      byTeamChampion.set(`${p.teamId}:${p.championId}`, p.participantId);
    }
  }

  return { bySummonerId, byPuuid, byTeamChampion, size: bySummonerId.size };
}

/** 单个玩家 → participantId，四条路依次兜。找不到返回 null */
export function resolveParticipantId(player, index) {
  if (!player) return null;
  // 1. EOG 自带（部分版本 / mock 数据有）
  if (player.participantId != null) return player.participantId;
  if (!index) return null;
  // 2. summonerId —— 真机最稳的一条
  if (player.summonerId != null && index.bySummonerId.has(String(player.summonerId))) {
    return index.bySummonerId.get(String(player.summonerId));
  }
  // 3. puuid
  if (player.puuid && index.byPuuid.has(String(player.puuid))) {
    return index.byPuuid.get(String(player.puuid));
  }
  // 4. (teamId, championId) 组合
  if (player.teamId != null && player.championId != null) {
    const k = `${player.teamId}:${player.championId}`;
    if (index.byTeamChampion.has(k)) return index.byTeamChampion.get(k);
  }
  return null;
}

/**
 * 玩家的稳定键 —— 用来在「分配 pid」与「查 pid」两侧对齐。
 * 不用对象引用，因为两次调用可能来自不同解析过程的副本。
 */
export function playerKey(p, i = 0) {
  if (p?.summonerId != null && p.summonerId !== 0) return `sid:${p.summonerId}`;
  if (p?.puuid) return `puuid:${p.puuid}`;
  if (p?.participantId != null) return `pid:${p.participantId}`;
  if (p?.teamId != null && p?.championId != null) return `tc:${p.teamId}:${p.championId}`;
  return `idx:${i}`;
}

/**
 * 给一批玩家分配匿名 pid。
 *
 * 有 participantId 的**按 participantId 升序**编号（顺序不代表强弱，
 * 只是为了稳定 —— 同一局重复判定得到同样的 pid），
 * 认不出身份的排在后面，用出现顺序兜底。
 *
 * @param {Array} players EOG teams 拍平后的玩家数组
 * @param {object|null} index buildIdentityIndex 的产物
 * @returns {{ byKey: Map<string,string>, byParticipantId: Map<number,string>, order: Array, unresolvedCount: number }}
 */
export function assignPids(players, index = null) {
  const rows = (players || []).map((p, i) => ({
    p,
    i,
    key: playerKey(p, i),
    participantId: resolveParticipantId(p, index),
  }));

  const known = rows.filter((r) => r.participantId != null).sort((a, b) => a.participantId - b.participantId);
  const unknown = rows.filter((r) => r.participantId == null);
  const ordered = [...known, ...unknown];

  const byKey = new Map();
  const byParticipantId = new Map();
  ordered.forEach((r, i) => {
    const pid = `p${i + 1}`;
    if (!byKey.has(r.key)) byKey.set(r.key, pid);
    if (r.participantId != null && !byParticipantId.has(r.participantId)) {
      byParticipantId.set(r.participantId, pid);
    }
  });

  return { byKey, byParticipantId, order: ordered, unresolvedCount: unknown.length };
}

/** 从 EOG 拍平所有玩家（normalize 与 buildNameMap 必须用同样的方式取） */
export function flattenPlayers(eog) {
  return (eog?.teams || []).flatMap((t) => t.players || []);
}

export default { buildIdentityIndex, resolveParticipantId, playerKey, assignPids, flattenPlayers };
