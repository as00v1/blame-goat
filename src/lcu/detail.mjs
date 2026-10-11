/**
 * 对局详情 —— 「这一局长什么样」的只读装配。
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ 为什么要跟战报分开：                                              │
 * │   点一行就自动调模型，等于把人只想「看一眼」的动作也变成一次付费调用。 │
 * │   把「看」和「判」拆开 —— 详情不花 token，判定才花，由人决定。      │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 两者共用同一套归一化（normalize），所以同一局的详情与战报，
 * 玩家顺序、pid、字段形状完全一致 —— 界面不需要两套渲染。
 * 差别只有一个：详情的 result 是空的。
 *
 * ★ 真机实测：match-detail 的玩家在 participants[]，身份在 participantIdentities[]，
 *   而 normalize 认的是 EOG 的 teams[].players[]。所以要一层翻译（synthesizeEogFromMatchDetail）。
 *   这份翻译是**全项目唯一实现** —— 判定链路（analyzeMatch）与详情链路都走这里，
 *   否则 pid 分配可能对不上，同一局在两条路上显示成两个人。
 */

import { normalize } from './normalize.mjs';
import { buildIdentityIndex } from './participants.mjs';

/**
 * 把 match-detail 翻译成 EOG 结构。
 *
 * 两个接口的 stats 字段名基本同套（都有小驼峰 kills / deaths /
 * totalDamageDealtToChampions），所以直接搬运即可；
 * teams[].win 是 "Win"/"Fail" 字符串，转成 isWinningTeam 布尔。
 */
export function synthesizeEogFromMatchDetail(matchDetail, session = null) {
  void session;
  if (!matchDetail?.participants?.length) return null;

  const identityOf = new Map(
    (matchDetail.participantIdentities || []).map((id) => [id.participantId, id.player || {}]),
  );

  return {
    gameId: matchDetail.gameId,
    gameLength: matchDetail.gameDuration,
    gameMode: matchDetail.gameMode,
    gameType: matchDetail.gameType,
    queueId: matchDetail.queueId,
    mapId: matchDetail.mapId,
    teams: (matchDetail.teams || []).map((t) => ({
      teamId: t.teamId,
      isWinningTeam: String(t.win).toLowerCase() === 'win',
      players: (matchDetail.participants || [])
        .filter((p) => p.teamId === t.teamId)
        .map((p) => {
          const idn = identityOf.get(p.participantId) || {};
          return {
            participantId: p.participantId,
            teamId: p.teamId,
            championId: p.championId,
            championName: p.championName,
            summonerId: idn.summonerId,
            puuid: idn.puuid,
            summonerName: idn.summonerName || idn.gameName || '',
            riotIdGameName: idn.gameName || idn.summonerName || '',
            items: [0, 1, 2, 3, 4, 5, 6].map((i) => p.stats?.[`item${i}`]).filter((x) => x),
            level: p.stats?.champLevel ?? null,
            stats: p.stats || {},
          };
        }),
    })),
    events: [],           // 事件在 timeline 里，不在这里
    _synthesized: true,   // 标记：这份 EOG 是从 match-detail 翻译来的
  };
}

/**
 * 某人在这一局的 teamId —— 决定界面把「我方 / 敌方」怎么分。
 * 认不出返回 null（调用方再退到别的判据）。
 */
export function teamOfPuuid(matchDetail, puuid) {
  if (!matchDetail || !puuid) return null;
  const hit = (matchDetail.participantIdentities || []).find((x) => x?.player?.puuid === puuid);
  if (!hit) return null;
  const p = (matchDetail.participants || []).find((x) => x.participantId === hit.participantId);
  return p?.teamId ?? null;
}

/**
 * 把一局 match-detail 装配成「界面能直接渲染的数据集」（不含模型判定）。
 *
 * @param {object} matchDetail      /lol-match-history/v1/games/{gameId}
 * @param {object} opts
 *   timeline         时间轴（可空 —— 没有就没有事件，不编）
 *   championMap      英雄表（预热好传入，批量查询时避免每局重读）
 *   gameData         出装 / 符文表（同上）
 *   perspectivePuuid 以谁的视角分我方 / 敌方。查某人时传「被查的人」，
 *                    这样列表按他的阵营排，比按「当前登录账号」有意义
 *   fallbackTeamId   视角认不出时的兜底阵营
 * @returns {{ dataset: object|null, perspective: { puuid: string|null, teamId: number|null, resolved: boolean } }}
 */
export function buildDetailDataset(matchDetail, {
  timeline = null, championMap = null, gameData = null,
  perspectivePuuid = null, fallbackTeamId = null,
} = {}) {
  const eog = synthesizeEogFromMatchDetail(matchDetail);
  if (!eog) return { dataset: null, perspective: { puuid: null, teamId: null, resolved: false } };

  const identityIndex = buildIdentityIndex(matchDetail);
  const fromPuuid = teamOfPuuid(matchDetail, perspectivePuuid);
  const myTeamId = fromPuuid ?? fallbackTeamId ?? eog.teams[0]?.teamId ?? null;

  const dataset = normalize(eog, {
    myTeamId,
    championMap,
    gameData,
    matchDetail,
    timeline,
    identityIndex,
  });

  return {
    dataset,
    perspective: { puuid: perspectivePuuid || null, teamId: myTeamId, resolved: fromPuuid != null },
  };
}

export default { synthesizeEogFromMatchDetail, teamOfPuuid, buildDetailDataset };
