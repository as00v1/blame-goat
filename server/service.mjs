/**
 * 业务编排层 —— 把 LCU / 数据整理 / DeepSeek 判定串成一条完整链路
 *
 * 链路：lockfile → EOG → normalize（四不原则）→ anonymize → DeepSeek → 校验 → 兜底 → 落盘
 *
 * 另外负责「打完自动出报」的轮询监视器：轮询 gameflow-phase，
 * 一旦进入 EndOfGame 就自动拉数据判定，并向界面广播。
 * （刻意不用 WebSocket —— LCU 的 wss 是自签证书，Node 内置 WebSocket
 *   不支持配置 rejectUnauthorized，轮询零依赖且足够。）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, DATA_DIR } from '../src/env.mjs';
import {
  readConnection, readConnectionAsync, readEog, readPhase, readCurrentSummoner, pingClient,
  readMatchDetail, readTimeline, readSession, readRecentMatches, readMatchListFor, extractGames,
  pickLatestGame,
  readLiveBundle,
} from '../src/lcu/client.mjs';
import { normalize } from '../src/lcu/normalize.mjs';
import { loadChampionMap } from '../src/lcu/champions.mjs';
import { loadGameData } from '../src/lcu/gamedata.mjs';
import { synthesizeEogFromMatchDetail, teamOfPuuid, buildDetailDataset } from '../src/lcu/detail.mjs';
import {
  ROSTER_FILE, SEARCHED_DIR, SEARCH_TTL_MS,
  seedRoster, rememberPlayers, rememberPlayersBatch, listPlayers, loadRoster,
  findPlayers as findRosterPlayers, getPlayer as getRosterPlayer,
  loadSearchCache, saveSearchCache, isFresh as isSearchFresh,
} from './roster.mjs';
import { judge, buildNameMap, anonymize, assertNoRealNames, restoreResultText } from '../src/deepseek/judge.mjs';
import { buildIdentityIndex } from '../src/lcu/participants.mjs';
import { DEFAULT_PARAMS } from '../src/deepseek/prompt.mjs';
import { summarizeGame, summarizeReport, mergeEntry, sortEntries, belongsTo } from '../src/lcu/matches.mjs';
import {
  ACCOUNTS_FILE, ALL as ACCOUNT_ALL, UNOWNED as ACCOUNT_UNOWNED,
  loadAccounts, saveAccounts, rememberAccount, clearCurrent, setCurrent,
  setViewing, resolveViewing, accountList, accountName,
} from './accounts.mjs';

// 目录只在 src/env.mjs 里判一次「开发态 / 打包态」，这里原样转出去 ——
// server.mjs 等老调用方仍旧从 service.mjs 拿 ROOT，不必全项目改一遍。
export { ROOT, DATA_DIR };
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const CHAMPIONS_FILE = path.join(DATA_DIR, 'champions.json');
/** 出装 / 强化符文表。区别于上游（LCU）—— 这份是本地缓存，客户端没开时也读得到 */
export const GAMEDATA_FILE = path.join(DATA_DIR, 'gamedata.json');
export const MATCH_INDEX_FILE = path.join(DATA_DIR, 'matches.json');
// 昵称索引：gameId → { p1: 昵称, … }。**独立于战报文件**存放。
// 战报是要能拿出去分享的，所以它里面永远只有 pid；真名留在本机这一份索引里，
// 界面读盘时再还原回去。这样「对外匿名」和「自己看着方便」就不打架了。
export const NAMES_FILE = path.join(DATA_DIR, 'names.json');
export const SAMPLE_DIR = path.join(ROOT, 'prototype', 'sample');

/** 账号相关（登记表 / 当前账号 / 切换查看）一律从 accounts.mjs 出，这里只做转发 */
export {
  ACCOUNTS_FILE, ACCOUNT_ALL, ACCOUNT_UNOWNED,
  loadAccounts, rememberAccount, clearCurrent, setCurrent, setViewing, resolveViewing, accountList, accountName,
};


fs.mkdirSync(REPORTS_DIR, { recursive: true });

/**
 * 离线样例数据包 —— 来自真机抓取（tools/capture-to-sample.mjs 生成），
 * 数值全真、玩家身份换成「路人甲…路人癸」。
 *
 * 不再是手写的想象数据：手写版是峡谷尺度（13 分钟 / 死亡 1–12），
 * 跟真实海克斯大乱斗（29 分钟 / 死亡 12–22 / 191 条事件）差一个量级，
 * 用它调阈值一到真机就饱和。
 */
export function loadSampleBundle() {
  const read = (n) => {
    try { return JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, n), 'utf8')); } catch { return null; }
  };
  const bundle = {
    eog: read('eog.json'),
    matchDetail: read('match-detail.json'),
    timeline: read('timeline.json'),
    session: read('session.json'),
    champions: read('champions.json'),
    meta: read('meta.json'),
  };

  // 兼容旧的手写样例
  if (!bundle.eog) {
    try {
      bundle.eog = JSON.parse(fs.readFileSync(path.join(ROOT, 'prototype', 'sample-eog.json'), 'utf8'));
    } catch { /* 都没有就只能报错了 */ }
  }
  return bundle;
}

/* ────────────────── 配置 ────────────────── */

/**
 * 用户级配置目录 —— 与 data/ **物理隔离**。
 *
 * 背景：Key 原先明文写在 data/config.json 里，而 README 教的是「整个目录拷走即可运行」，
 * data/ 又装着要能分享出去的战报 —— 一个手滑把目录打包发给别人，Key 就跟着走了。
 * 所以 Key 只落在这里（Windows：%LOCALAPPDATA%\LOL背锅侠\config.json），
 * data/ 从此只留「可以拿出去的东西」。
 */
export const USER_CONFIG_DIR = (() => {
  if (process.env.BBX_CONFIG_DIR) return process.env.BBX_CONFIG_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LOL背锅侠');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'LOL背锅侠');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'LOL背锅侠');
})();
export const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'config.json');

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || null; } catch { return null; }
}

function writeUserConfig(obj) {
  try {
    fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 把旧配置里的 Key 搬出 data/。
 *
 * 为什么要「搬」而不是「另存一份就不管」：data/config.json 里留着的就是明文 Key，
 * 迟早被拷走。搬完把那一字段删掉，其余字段（语气 / 端口 / 参数）原样留着 ——
 * 那些是本机偏好，不涉及凭据。幂等：搬过一次之后旧文件里没有 Key，再跑什么也不做。
 */
function migrateKeyOutOfData(legacy) {
  if (!legacy || !legacy.deepseekApiKey) return;
  const user = readJsonFile(USER_CONFIG_FILE) || {};
  if (!user.deepseekApiKey) {
    user.deepseekApiKey = legacy.deepseekApiKey;
    writeUserConfig(user);
    console.log(`[配置] 已把 API Key 从 data/config.json 搬到用户配置目录：${USER_CONFIG_FILE}`);
  }
  try {
    const rest = { ...legacy };
    delete rest.deepseekApiKey;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(rest, null, 2), 'utf8');
  } catch { /* 旧文件写不回也无妨 —— 新位置已经存好了 */ }
}

/** Key 优先取环境变量（不落盘），其次用户配置目录，最后兼容旧位置 data/config.json */
export function loadConfig() {
  const fileCfg = readJsonFile(CONFIG_FILE);
  migrateKeyOutOfData(fileCfg);
  const userCfg = readJsonFile(USER_CONFIG_FILE) || {};
  // 新旧两份合并：老机器上的语气 / 端口偏好还在旧文件里，别因为换地方就丢了
  const merged = { ...(fileCfg || {}), ...userCfg };
  const apiKey = process.env.DEEPSEEK_API_KEY || userCfg.deepseekApiKey || fileCfg?.deepseekApiKey || null;
  return {
    apiKey,
    keySource: process.env.DEEPSEEK_API_KEY ? 'env' : (apiKey ? 'file' : null),
    // 界面保存 Key 时要明确告诉用户「明文写在这儿，别外发」—— 路径由服务端给，不让前端猜
    configFile: USER_CONFIG_FILE,
    tone: merged.tone || 'normal',
    // 赛后自动判定 —— **默认关**。判定要调模型花钱，不该由「打完一局」替人决定；
    // 默认只登记并提示，用户点进去想判再判。
    autoAnalyze: merged.autoAnalyze === true,
    params: { ...DEFAULT_PARAMS, ...(merged.params || {}) },
    port: Number(process.env.PORT || merged.port || 7710),
    fileCfg: merged,
  };
}

/**
 * 写本机配置 —— **只写用户配置目录**（%LOCALAPPDATA%\LOL背锅侠\config.json）。
 *
 * 为什么不写 data/config.json：那份要跟着目录一起能被分享，里面不该有凭据
 * （见 USER_CONFIG_DIR 的注释）。只允许白名单字段，Key 不进日志、不随包分发。
 */
export function saveConfig(patch = {}) {
  // 旧位置的底子照旧读一份 —— 老机器第一次保存时，语气 / 端口别凭空丢掉
  const cur = readJsonFile(USER_CONFIG_FILE) || readJsonFile(CONFIG_FILE) || {};

  const next = { ...cur };
  if (typeof patch.deepseekApiKey === 'string') {
    const v = patch.deepseekApiKey.trim();
    if (v) next.deepseekApiKey = v;
    else delete next.deepseekApiKey;          // 传空串 = 清除
  }
  if (patch.tone && ['mild', 'normal', 'savage'].includes(patch.tone)) next.tone = patch.tone;
  if (typeof patch.autoAnalyze === 'boolean') next.autoAnalyze = patch.autoAnalyze;
  if (patch.port != null) next.port = Number(patch.port);

  writeUserConfig(next);
  return next;
}

/* ────────────────── 判定链路 ────────────────── */

/**
 * 跑完整条链路。
 *
 * @param {object} eog   /lol-end-of-game/v1/eog-stats-block 原样返回（主数据源）
 * @param {object} opts
 *   matchDetail  对局详情 —— ★ 真机必需：EOG 玩家没有 participantId，
 *                不桥接的话十个人会塌成同一个 pid
 *   timeline     对局时间轴 —— EOG 的 events 恒为空，事件全在这里
 *   session      gameflow 会话（模式中文名 / gameId）
 *   myTeamId     显式指定视角（mock / 离线场景用）
 *   championMap  预热好的英雄表
 *   gameData     预热好的出装 / 符文表
 */
export async function analyzeFromEog(eog, {
  tone = 'normal', apiKey = null, params = DEFAULT_PARAMS, conn = null,
  source = 'lcu', myTeamId: myTeamIdOverride = null, championMap = null, gameData = null,
  matchDetail = null, timeline = null, session = null, logger = () => {},
  ownerPuuid = null,
  // v1.2.7：判「别人的局」时指定以谁为视角（查某人 → 判定他的某一局）。
  // 不给的话我不在局里 → normalize 认不出我方 → 10 人全归敌方。
  perspectivePuuid = null,
  // 判定过程回调（{phase, elapsedMs, chars, tokens, reason}）—— 判定动辄十几秒，
  // 有它界面才能显示「模型正在写」的真进度，而不是干转一段假动画
  onProgress = null,
} = {}) {
  const t0 = Date.now();

  // 1. 定视角 —— 三级兜底，缺一不可：
  //    ① 显式指定（mock / 离线样例）
  //    ② EOG 自带标记（真机有 localPlayer.teamId / teams[].isPlayerTeam）
  //    ③ ★ 按「这一局的主人」从 match-detail 里反查阵营
  //
  //    第 ③ 级是给「重判别人的局」补的：从 match-detail 合成的 EOG 既没有 localPlayer，
  //    teams 里也没有 isPlayerTeam / isMyTeam 标记，于是只能靠「当前登录账号是否在这局里」比对；
  //    换账号后重判老战报时当前账号根本不在局里 —— ②返回 null，
  //    normalize 里 `p.teamId === null` 恒为 false，10 个人**全被算成「敌方」**，
  //    界面上就是「没有敌我区分」。而 analyzeMatch 早就把 ownerPuuid 算出来了，这里用上即可。
  const myTeamId = myTeamIdOverride
    ?? teamOfPuuid(matchDetail, perspectivePuuid)
    ?? await resolveMyTeamId(eog, conn)
    ?? teamOfPuuid(matchDetail, ownerPuuid);
  if (myTeamId == null) {
    logger('⚠ 认不出这一局「我方」是哪边 —— 界面上会全归到敌方，检查视角来源');
  }

  // 2. 英雄表（用于把 championId / 英文 alias 转成国服中文英雄名）
  const champs = championMap || await loadChampionMap(conn, { cacheFile: CHAMPIONS_FILE }).catch(() => null);

  // 2.1 出装 / 符文表（id → 人话）。客户端没开时读本地缓存，所以这一步不会因为断连而失败
  const gdata = gameData || await loadGameData(conn, { cacheFile: GAMEDATA_FILE }).catch(() => null);

  // 3. 身份索引只建一次，normalize 与 buildNameMap 共用 —— 保证 pid 一致
  const identityIndex = buildIdentityIndex(matchDetail);

  // 4. 数据整理（四不原则在此落实）
  const dataset = normalize(eog, { myTeamId, championMap: champs, gameData: gdata, matchDetail, timeline, session, identityIndex });

  // 5. 隐私校验：去模型的数据里不能残留真实昵称
  const nameMap = buildNameMap(eog, matchDetail);
  const leaks = assertNoRealNames(dataset, nameMap);
  if (leaks.length) logger(`⚠ 隐私校验：dataset 中残留 ${leaks.length} 个真实昵称，已强制匿名`);
  const safeDataset = anonymize(dataset, nameMap);

  // 6. 判定（有 Key 走模型，没 Key / 失败自动兜底）
  const judged = await judge(safeDataset, { apiKey, tone, params, logger, onProgress });

  // 7. 名字还原仅在本机内存里做，不落盘
  const pidToName = Object.fromEntries(Object.entries(nameMap).map(([n, p]) => [p, n]));
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: judged.source,
      model: judged.model || null,
      tone,
      elapsedMs: judged.elapsedMs,
      totalMs: Date.now() - t0,
      usage: judged.usage,
      errors: judged.errors,
      dataFrom: source,
      privacyLeaks: leaks.length,
      championMapFrom: champs?.from || null,
      gameDataFrom: gdata?.from || null,
      // 归属账号：界面按它分账号显示；重判别人的局时也照旧记在原主人头上
      ownerPuuid: ownerPuuid || null,
      hasMatchDetail: !!matchDetail,
      hasTimeline: !!timeline,
      identityIndexSize: identityIndex.size,
    },
    dataset,
    result: judged.result,
    names: pidToName,     // pid → 昵称，界面展示用
  };
  // 模型（和兜底）写文案时手里只有 pid，这里换成昵称 —— 仅内存，落盘时再抹掉
  return restoreNames(report);
}

/** 判断这一局「我」在哪边：先看 EOG 自带标记，再用当前登录召唤师比对 */
async function resolveMyTeamId(eog, conn) {
  // 1. EOG 会直接给本机玩家的阵营（真机 localPlayer.teamId 最直接）
  if (eog?.localPlayer?.teamId != null) return eog.localPlayer.teamId;

  const teams = eog?.teams || [];
  const flagged = teams.find((t) => t.isPlayerTeam || t.isMyTeam);
  if (flagged) return flagged.teamId;

  // 2. 退到当前登录召唤师比对
  if (!conn) return null;
  let me = null;
  try {
    me = await readCurrentSummoner(conn);
  } catch { return null; }
  if (!me) return null;

  // EOG 里的本地标记（部分版本只有这个）
  if (eog?.localPlayer?.summonerId != null) {
    for (const t of teams) {
      for (const p of t.players || []) {
        if (String(p.summonerId) === String(eog.localPlayer.summonerId)) return t.teamId;
      }
    }
  }

  for (const t of teams) {
    for (const p of t.players || []) {
      if ((me.puuid && p.puuid && p.puuid === me.puuid)
        || (me.summonerId != null && p.summonerId != null && String(p.summonerId) === String(me.summonerId))) {
        return t.teamId;
      }
    }
  }
  return null;
}

/** 已有连接时跑一局：能拿到 EOG 就用 EOG，拿不到退到对局记录 */
export async function analyzeWithConn(conn, opts = {}) {
  const bundle = await readLiveBundle(conn).catch(() => null);

  if (bundle?.eog) {
    // ★ 同一局不重复判定。
    //   对局数据是不可变的，重跑只会再烧一次模型调用（大哥在意 token）。
    //   早先只在「按 gameId 分析」那条路上做了缓存，这条路（EOG / 读取上一局 /
    //   打完自动出报）每次都会重新调模型 —— 这里补齐，两条路一致。
    const gid = bundle.eog.gameId;
    if (!opts.force && gid != null) {
      const cached = tryLoadReport(gid);
      if (cached) {
        await ensureNamesFor(gid, conn).catch(() => null);
        return restoreNames({ ...cached, meta: { ...cached.meta, fromCache: true } });
      }
    }
    // 这条路（EOG / 读取上一局 / 打完自动出报）走的是「当前登录账号的一局」，
    // 所以主人就是当前登录账号。
    const owner = (await readCurrentSummoner(conn).catch(() => null))?.puuid || null;
    const report = await analyzeFromEog(bundle.eog, {
      ...opts, conn, source: opts.source || 'lcu-live',
      matchDetail: bundle.matchDetail, timeline: bundle.timeline, session: bundle.session,
      ownerPuuid: owner,
    });
    return report;
  }
  return analyzeLatestMatch({ ...opts, conn });
}

/** 从本机客户端拉一局并判定 */
export async function analyzeLive(opts = {}) {
  const { conn, lockfile, running } = readConnection();
  if (!running) {
    const err = new Error(lockfile ? '客户端未运行（lockfile 为空）' : '未找到 LOL 客户端（无 lockfile）');
    err.code = 'CLIENT_DOWN';
    throw err;
  }
  return analyzeWithConn(conn, opts);
}

/**
 * 判定「指定的某一局」（按 gameId）。
 *
 * 为什么需要它：EOG 接口只在 WaitingForStats / PreEndOfGame / EndOfGame
 * 三个阶段可用，窗口经常只有几秒，5s 轮询很容易整段错过。
 * 而 /lol-match-history/v1/games/{gameId} 打完之后随时都能拉，
 * 且数据比 EOG 更全（自带 participantId、queueId、mapId）。
 *
 * ★ 防串局：这个端点**对任意 gameId 都返回数据** —— 实测随手编一个
 *   401141430000，回的是别人的对局（10 人里没有当前账号）。
 *   所以必须先确认这局里有当前登录账号，否则就是「点了 A 局、分析了 B 局」。
 *
 * @param {number|string} gameId
 * @param {object} opts  force=true 时忽略已落盘战报，重新判定
 */
export async function analyzeMatch(gameId, opts = {}) {
  const { perspectivePuuid = null } = opts;
  const conn = opts.conn || readConnection().conn;
  if (!conn) {
    const err = new Error('客户端未运行');
    err.code = 'CLIENT_DOWN';
    throw err;
  }

  const gid = Number(gameId);
  if (!Number.isFinite(gid) || gid <= 0) {
    const err = new Error('缺少有效的 gameId');
    err.code = 'BAD_GAME_ID';
    throw err;
  }

  // 已经判定过、且没要求强制重跑 → 直接回放盘里的战报。
  // 对局数据是不可变的，重跑只会再烧一次模型调用（大哥在意 token），没必要。
  const cached = tryLoadReport(gid);
  const cachedOwner = cached?.meta?.ownerPuuid || null;
  if (!opts.force && cached) {
    // 老战报没记昵称 → 借客户端重建一次（成功后就永久缓存在本机昵称索引里）
    await ensureNamesFor(gid, conn).catch(() => null);
    return restoreNames({ ...cached, meta: { ...cached.meta, fromCache: true } });
  }

  const matchDetail = await readMatchDetail(conn, gid);
  if (!matchDetail?.participants?.length) {
    const err = new Error('对局详情为空 —— 可能已超出客户端可查询范围');
    err.code = 'MATCH_DETAIL_EMPTY';
    throw err;
  }

  const me = await readCurrentSummoner(conn).catch(() => null);

  const indexOwner = (loadMatchIndex().entries?.[gid]?.ownerPuuid) || null;
  const meInGame = !!me?.puuid
    && (matchDetail.participantIdentities || []).some((x) => x?.player?.puuid === me.puuid);
  // ★ v1.2.7：不再要求「这局必须属于本机某个账号」。
  //   大哥的原话：「别人的对局也要支持判定，你的判定结果按对局 ID 缓存即可，
  //   跟是否是我的对局无关。」
  //   于是 ownerPuuid 允许为 null —— 它现在只决定「判完算不算进「我的战绩」」：
  //     · 有主人（我在这局里 / 索引已登记）→ 正常进 matches.json，归属写它；
  //     · 没有主人（查别人的局）→ 战报照样按 gameId 落盘、照样能回放，
  //       但**不写 matches.json**，那一局的战绩不混进「我的战绩」列表。
  //   「按对局 ID 缓存」本来就是既成事实：data/reports/<gameId>.json，
  //   同一局重判是覆盖、不是新增，与它归谁无关。
  const ownerPuuid = cachedOwner || indexOwner || (meInGame ? me.puuid : null);
  // 主人是本机登记过的账号，但此刻登录的不是它 —— 只说一声，不拦。
  // ★ ownerPuuid 允许为 null（v1.2.7：别人的局也能判），这里必须判空再 slice。
  if (ownerPuuid && ownerPuuid !== me?.puuid) {
    const who = me?.displayName || accountName(me?.puuid) || '未知';
    opts.logger?.(`这局归属 ${accountName(ownerPuuid) || ownerPuuid.slice(0, 8)}，当前登录 ${who} —— 按原主人重判`);
  }

  const [timeline, session] = await Promise.all([
    readTimeline(conn, gid),
    readSession(conn),
  ]);

  // 用 match-detail 直接拼一份 EOG 等价结构：字段名对齐 normalize 的读取路径
  const eog = synthesizeEogFromMatchDetail(matchDetail, session);
  if (!eog) {
    const err = new Error('对局详情为空，无法判定');
    err.code = 'MATCH_DETAIL_EMPTY';
    throw err;
  }

  const report = await analyzeFromEog(eog, {
    ...opts, conn, source: 'match-history',
    matchDetail, timeline, session,
    ownerPuuid,
  });

  const file = saveReport(report);
  report.meta.savedFile = path.basename(file);

  // ★ v1.2.7：**有主人才写战绩索引**。
  //   查别人的局判定后，战报照样按 gameId 落在 data/reports/ 里（可回放、可重判），
  //   但**不写 matches.json** —— 「我的战绩」只装我的局。
  //   ownerPuuid 显式传，不能拿「当前登录」当主人，否则重判别人的局会把它判走。
  if (ownerPuuid) {
    rememberGame(matchDetail, { myPuuid: me?.puuid, ownerPuuid, report });
  }

  // 登录着的账号顺手登个记（换账号后自动多一条）
  if (me?.puuid) rememberAccount(me, { source: 'login', markCurrent: true, makeLast: true });

  return report;
}

/** 最近一局（打完就能查的那一局） */
export async function analyzeLatestMatch(opts = {}) {
  const conn = opts.conn || readConnection().conn;
  if (!conn) {
    const err = new Error('客户端未运行');
    err.code = 'CLIENT_DOWN';
    throw err;
  }

  const list = await readRecentMatches(conn, { begIndex: 0, endIndex: 1 });
  // 取「真正最新」那一局：gameId 与时间不同序，不能拿数组第一项当最近（见 client.mjs pickLatestGame）
  const gameId = pickLatestGame(list)?.gameId;
  if (!gameId) {
    const err = new Error('最近对局记录为空 —— 这一局可能还没结算完');
    err.code = 'NO_RECENT_MATCH';
    throw err;
  }

  return analyzeMatch(gameId, { ...opts, conn });
}

/** 读盘里的战报，不存在 / 损坏都返回 null（不当异常） */
function tryLoadReport(gameId) {
  const full = path.join(REPORTS_DIR, `${gameId}.json`);
  try {
    if (!fs.existsSync(full)) return null;
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (!j?.dataset?.match?.gameId) return null;
    migrateLegacyScores(j);          // 老战报是 0-100 制，读出来先换算成 0-10（只读，不改盘）
    return j;
  } catch { return null; }
}

/**
 * 老战报分数换算：0-100 制 → 0-10 制。
 *
 * v1.2.5 起模型给的是 0-10 分，而盘上已有十几份 100 制的战报。
 * 判据用「> 10 就是旧制」：新制最高才 10，不会误伤；
 * 100 → 92 这样刚好折成 9.2，30 → 35 折成 3.5。
 *
 * ★ **只改读出来的副本，不回写文件** ——
 *   老战报的分数是历史记录，模型重判才会变；偷偷改盘会让「同一局两次读出不同分数」。
 */
function migrateLegacyScores(report) {
  const players = report?.result?.players;
  if (!Array.isArray(players)) return report;
  for (const p of players) {
    if (typeof p.score === 'number' && p.score > 10) p.score = Math.round(p.score / 10 * 10) / 10;
  }
  return report;
}

/* ────────────────── 昵称索引（本机） ────────────────── */

/**
 * 昵称索引：gameId → { p1: '昵称', … }
 *
 * 为什么不直接写进战报：战报是要能拿出去给人看的，里面永远只留 pid；
 * 真名留在本机这一份索引里，界面读盘时再还原。
 * 于是「对外匿名」和「自己看着方便」就不冲突了。
 */
// 内存缓存：列表页会逐份战报调 restoreNames，不加缓存就是几百次同步读盘
let _namesCache = null;

function loadNamesIndex() {
  if (_namesCache) return _namesCache;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); } catch { j = null; }
  _namesCache = j?.entries && typeof j.entries === 'object' ? j.entries : {};
  return _namesCache;
}

/** 昵称索引的磁盘真相 —— 与内存缓存（loadNamesIndex）区分开，落盘前要用它 */
function readNamesFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
    return j?.entries && typeof j.entries === 'object' ? j.entries : {};
  } catch { return {}; }
}

/**
 * 写昵称索引。
 *
 * ★ 落盘前重读一次磁盘：调用方手里的 entries 可能是几秒前的快照
 *   （ensureNamesFor 中间要 await 一次 LCU 详情），这期间别人记的昵称就在这份快照之外。
 *   直接写快照会把它抹掉。函数体是同步的 —— 读-合并-写这段不会被打断，不必额外加锁。
 */
function saveNamesIndex(entries) {
  const onDisk = readNamesFromDisk();
  const merged = { ...onDisk };
  for (const [gid, map] of Object.entries(entries || {})) {
    merged[gid] = { ...(onDisk[gid] || {}), ...(map || {}) };
  }
  _namesCache = merged;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      NAMES_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), entries: merged }, null, 2),
      'utf8',
    );
    return true;
  } catch { return false; }
}

/** 记一局的昵称映射（落盘战报时顺手记一笔） */
export function rememberNames(gameId, pidToName) {
  if (!gameId || !pidToName) return false;
  if (!Object.keys(pidToName).length) return false;
  const idx = loadNamesIndex();
  const prev = idx[gameId] || {};
  const merged = { ...prev, ...pidToName };
  if (JSON.stringify(prev) === JSON.stringify(merged)) return false;   // 没变化就别写盘
  idx[gameId] = merged;
  return saveNamesIndex(idx);
}

/**
 * 给一份战报补上昵称：先用自带的，其次查本机索引。
 * 落盘时 names 被抹掉了（防分享泄露），所以所有从盘里读回来的都要过这一道。
 */
export function restoreNames(report) {
  if (!report) return report;
  const gid = report?.dataset?.match?.gameId;
  const pidToName = (report.names && Object.keys(report.names).length)
    ? report.names
    : (gid ? loadNamesIndex()[gid] : null);
  if (!pidToName || !Object.keys(pidToName).length) return report;
  return {
    ...report,
    names: pidToName,
    result: restoreResultText(report.result, pidToName),
  };
}

/**
 * 老战报没有昵称记录时的补救：回客户端拉一次 matchDetail 重建。
 *
 * pid 分配走的是同一套（synthesizeEogFromMatchDetail → buildNameMap → assignPids），
 * 同一局数据不变，所以重建出的 pid 与当初落盘时逐个对得上。
 * 拿不到（客户端没开 / 超出缓存窗口）就返回 null —— 界面继续显示 pid，不报错。
 */
async function ensureNamesFor(gameId, conn) {
  const gid = Number(gameId);
  if (!Number.isFinite(gid) || !conn) return null;
  const idx = loadNamesIndex();
  if (idx[gid]) return idx[gid];

  const detail = await readMatchDetail(conn, gid).catch(() => null);
  if (!detail?.participants?.length) return null;

  const eog = synthesizeEogFromMatchDetail(detail, null);
  const byName = eog ? buildNameMap(eog, detail) : null;    // 真名 → pid
  if (!byName || !Object.keys(byName).length) return null;

  const pidToName = Object.fromEntries(Object.entries(byName).map(([n, p]) => [p, n]));
  idx[gid] = pidToName;
  saveNamesIndex(idx);
  return pidToName;
}

/* ────────────────── 战绩索引 ────────────────── */

/**
 * 战绩索引 —— 「所有战绩」靠它累积。
 *
 * 为什么还要本地攒：客户端只留本地缓存里的那约 100 局（近一个月），
 * 再往前就列不出来了（虽然按 gameId 还能查到详情）。
 * 所以每见到一局就记一笔，客户端缓存被清空也还在。
 *
 * 三源合并：
 *   ① data/reports/*.json   已判定过的（有结论，但不知道我玩了谁）
 *   ② LCU 对局列表           客户端缓存的全部历史（能精确到「我」的英雄 / KDA / 胜负）
 *   ③ data/matches.json     历史累积（客户端缓存之外的、之前见过并记下的局）
 * 同一局按 gameId 去重，LCU 来源优先级最高。
 */
export function loadMatchIndex() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(MATCH_INDEX_FILE, 'utf8')); } catch { j = null; }
  const entries = j?.entries && typeof j.entries === 'object' ? j.entries : {};
  return { updatedAt: j?.updatedAt || null, entries };
}

/**
 * 每个账号各有多少局 —— 只读本地索引，不碰客户端。
 * 界面把它显示在账号下拉里，这样「换个账号看」之前就知道那边有多少东西。
 */
export function accountCounts() {
  const { entries } = loadMatchIndex();
  const counts = {};
  let unowned = 0;
  let analyzed = {};
  for (const e of Object.values(entries)) {
    if (e.ownerPuuid) {
      counts[e.ownerPuuid] = (counts[e.ownerPuuid] || 0) + 1;
      if (e.analyzedAt) analyzed[e.ownerPuuid] = (analyzed[e.ownerPuuid] || 0) + 1;
    } else {
      unowned += 1;
    }
  }
  return { counts, analyzed, unowned, total: Object.keys(entries).length };
}

/**
 * 写战绩索引。
 *
 * ★ 落盘前**重新读一次盘**：调用方手里的 entries 常常是几秒前的快照 ——
 *   listMatches 中间要拉 LCU（几百局详情，动辄几秒），这期间别人（判定完成、
 *   监视器扫到新局）已经写过盘了。直接把旧快照写回去，等于把人家刚加的条目抹掉 ——
 *   表现就是「刚重判完 / 刚打完，列表那行的结论又变回去了」。
 *
 *   函数体是同步的，Node 单线程 —— 「读 → 合并 → 写」这一段不会被打断，
 *   所以不需要再加队列；真正的问题从来是跨 await 的旧快照，那靠重读就解决了。
 */
function saveMatchIndex(entries) {
  const fresh = loadMatchIndex().entries;
  const merged = { ...fresh };
  for (const [gid, e] of Object.entries(entries || {})) {
    merged[gid] = mergeEntry(fresh[gid], e);
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      MATCH_INDEX_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), entries: merged }, null, 2),
      'utf8',
    );
    return true;
  } catch { return false; }
}

/**
 * 把一局合并进索引并存盘（单独一局的轻量入口，判定完成后顺手调用）。
 *
 * @param {object} report 刚判完的战报。带上它，是为了把**新的判定文案与判定时间**
 *   立刻写进索引 —— 否则索引里留着的还是上一次（可能是兜底）的文案，
 *   列表那一行就一直是旧结论，看着像「重判了但本地没更新」。
 */
function rememberGame(game, { myPuuid = null, ownerPuuid = undefined, championMap = null, report = null } = {}) {
  const entry = summarizeGame(game, { myPuuid, ownerPuuid, championMap });
  if (!entry?.gameId) return null;
  if (report) {
    if (report?.result?.verdict) entry.verdict = report.result.verdict;
    entry.analyzedAt = report?.meta?.generatedAt || new Date().toISOString();
  }
  const { entries } = loadMatchIndex();
  entries[entry.gameId] = mergeEntry(entries[entry.gameId], entry);
  saveMatchIndex(entries);
  return entries[entry.gameId];
}

/**
 * 列出所有已知战绩（时间倒序）。
 *
 * @param {object} opts
 *   limit      最多返回多少条
 *   refresh    false = 只读本地索引，不碰客户端（离线可用）
 *   backfill   尝试给「只有战报、没有英雄」的老条目补全英雄 / KDA
 *   account    按归属账号过滤：puuid | 'all' | 'unowned' | 空（取当前查看的账号）
 */
export async function listMatches({ limit = 500, refresh = true, backfill = true, conn = null, account = null } = {}) {
  const viewing = resolveViewing(account);
  const { entries } = loadMatchIndex();
  const stats = { fromIndex: Object.keys(entries).length, fromReports: 0, fromLcu: 0, backfilled: 0, viewing };

  // ── ① 已落盘战报 ──
  for (const rep of listReports(500)) {
    if (!rep.gameId) continue;
    const full = (() => { try { return loadReport(rep.file); } catch { return null; } })();
    const summary = full
      ? summarizeReport(full)
      : summarizeReport({
        dataset: { match: { gameId: rep.gameId, mode: rep.mode, durationText: rep.duration, myResult: rep.result } },
        result: { verdict: rep.verdict },
        meta: { generatedAt: new Date(rep.mtime).toISOString(), ownerPuuid: rep.ownerPuuid },
      });
    if (!summary) continue;
    entries[summary.gameId] = mergeEntry(entries[summary.gameId], summary);
    stats.fromReports += 1;
  }

  // ── ② LCU 当前窗口（唯一能精确到「我」的来源）──
  let c = conn;
  if (refresh) {
    c = c || readConnection().conn;
  } else {
    c = null;
  }

  let myPuuid = null;
  let championMap = null;
  if (c) {
    // 客户端本地缓存的全部历史（实测 100 → 200+ 局，随缓存积累变化），
    // 且忽略 begIndex/endIndex —— 所以这里传 300 只是「尽可能多」，不是真的分页。
    // ★ 每局只回「我」这一名参与者，但那一名带全套 stats，列表的输出 / 承伤就从这里来。
    const listResp = await readRecentMatches(c, { begIndex: 0, endIndex: 300 }).catch(() => null);
    const games = extractGames(listResp);
    if (games.length) {
      const me = await readCurrentSummoner(c).catch(() => null);
      myPuuid = me?.puuid || null;
      if (me?.puuid) rememberAccount(me, { source: 'login', markCurrent: true, makeLast: true });
      championMap = await loadChampionMap(c, { cacheFile: CHAMPIONS_FILE }).catch(() => null);
      for (const g of games) {
        // 不再无条件写 ownerPuuid = 当前登录：客户端缓存里可能还留着**上一个号**的局，
        // 此刻登录的账号根本不在那些局里（换号后最容易出现）。
        // 归属交给 summarizeGame 判 —— 它按这一局自己的 participantIdentities 找人，
        // 找不到就留空归入 unowned，绝不张冠李戴。
        const entry = summarizeGame(g, { myPuuid, championMap });
        if (!entry?.gameId) continue;
        entries[entry.gameId] = mergeEntry(entries[entry.gameId], entry);
        stats.fromLcu += 1;
      }
    }
  }

  // ── ③ 补录：老条目只有战报、没有英雄 → 按 gameId 拉详情补上 ──
  //   match-detail 端点对任意 gameId 都返回数据，所以补录时必须校验
  //   这局里有「这一局的主人」（summarizeGame 找不到本人就不会产出英雄，等于自动拒绝）。
  //   ★ 这里要用**条目自己的主人**去认本人，不能用当前登录 —— 否则换账号后
  //     另一个账号的老条目永远补不上英雄。
  if (backfill && c) {
    if (!championMap) championMap = await loadChampionMap(c, { cacheFile: CHAMPIONS_FILE }).catch(() => null);
    // 两类要补：①没有英雄的老条目；②有英雄但没关键数据（输出 / 承伤）的 ——
    // 列表行要在 KDA 后面显示这些，缺了就空着，所以顺手一起补。
    const need = Object.values(entries)
      .filter((e) => !e.hasMe || e.damageDealt == null)
      .slice(0, 20);
    for (const e of need) {
      const detail = await readMatchDetail(c, e.gameId).catch(() => null);
      if (!detail?.participants?.length) continue;
      const asOwner = e.ownerPuuid || myPuuid;
      const filled = summarizeGame(detail, { myPuuid: asOwner, ownerPuuid: e.ownerPuuid || null, championMap });
      if (!filled?.hasMe) continue;        // 不是主人的局 / 拿不到英雄 → 保持原样
      entries[e.gameId] = mergeEntry(entries[e.gameId], filled);
      stats.backfilled += 1;
    }
  }

  saveMatchIndex(entries);

  const mine = sortEntries(Object.values(entries).filter((e) => belongsTo(e, viewing)));
  const all = sortEntries(Object.values(entries));
  return {
    matches: mine.slice(0, limit),
    total: mine.length,
    allTotal: all.length,
    stats,
    viewing,
    indexUpdatedAt: new Date().toISOString(),
    // 客户端给的是本地缓存的全量历史（实测约 100 局），再往前没有 —— 界面据此提示
    lcuCacheLimited: true,
  };
}

/* 索引扫描用的记忆：英雄表 / 本人 puuid 不必每 30s 重取一次 */
const _sweepMemo = { at: 0, championMap: null, myPuuid: null };

/**
 * 把 LCU 当前窗口里的每一局都记进索引。
 *
 * 为什么要主动扫：客户端缓存有上限（约 100 局），如果只有「用户打开战绩页」时才写入索引，
 * 那打一段时间的局而不看页面，被挤出去的那些就再也列不出来了。
 * 监视器每 30s 顺手扫一次，等于给每局都留了档。
 */
export async function sweepIntoIndex(conn, listResp = null) {
  const c = conn || readConnection().conn;
  if (!c) return { scanned: 0, added: 0 };

  // 客户端实测缓存约 100 局且忽略 begIndex/endIndex，给大一点保险
  const resp = listResp || await readRecentMatches(c, { begIndex: 0, endIndex: 300 }).catch(() => null);
  const games = extractGames(resp);
  if (!games.length) return { scanned: 0, added: 0 };

  const now = Date.now();
  if (!_sweepMemo.championMap || now - _sweepMemo.at > 10 * 60 * 1000) {
    _sweepMemo.championMap = await loadChampionMap(c, { cacheFile: CHAMPIONS_FILE }).catch(() => null);
    const me = await readCurrentSummoner(c).catch(() => null);
    _sweepMemo.myPuuid = me?.puuid || null;
    // 换账号时顺手登记 —— 40 天没登录过的账号也能被记起来
    if (me?.puuid) rememberAccount(me, { source: 'login', markCurrent: true, makeLast: true });
    _sweepMemo.at = now;
  }

  const { entries } = loadMatchIndex();
  let added = 0;
  for (const g of games) {
    // 与 listMatches 同一条规矩：归属由「本人是否在这一局里」决定，
    // 不拿此刻登录的账号去套（换号窗口期里那会把旧号的对局记到新号名下）
    const entry = summarizeGame(g, {
      myPuuid: _sweepMemo.myPuuid,
      championMap: _sweepMemo.championMap,
    });
    if (!entry?.gameId) continue;
    const prev = entries[entry.gameId];
    // 只有「没见过 / 之前没拿到本人英雄 / 关键字段变了」才重写，避免每 30s 白写盘
    const worth = !prev || !prev.hasMe
      || prev.champion !== entry.champion
      || prev.createdAt !== entry.createdAt
      || prev.kills !== entry.kills;
    if (!worth) continue;
    entries[entry.gameId] = mergeEntry(prev, entry);
    added += 1;
  }

  if (added) saveMatchIndex(entries);
  return { scanned: games.length, added };
}

/* ────────────────── 对局详情（只读，不调模型） ────────────────── */

/** 从对局详情里取某人的昵称 */
function nameInDetail(detail, puuid) {
  if (!detail || !puuid) return null;
  const hit = (detail.participantIdentities || []).find((x) => x?.player?.puuid === puuid);
  return hit?.player?.gameName || hit?.player?.summonerName || null;
}

/**
 * 读一局的详情 —— 界面点列表行的第一站。
 *
 * 两条分支：
 *   ① 盘里已有战报 → 直接回放（含判定结论），**不调模型、不烧 token**
 *   ② 没有战报 → 拉 LCU 详情 + 时间轴，归一化成 dataset，result 留空
 *
 * 与 analyzeMatch 的分工：那个负责「判」，这个负责「看」。
 * 早先点一行就直接进判定流程，等于「只想看一眼」也要付费 —— 现在拆开了。
 *
 * @param {object} opts
 *   conn            已有连接（省一次 lockfile 解析）
 *   perspectivePuuid 以谁的视角分我方 / 敌方。默认：本机账号 → 索引里的归属
 */
/**
 * 把老战报丢掉的「我方视角」补回来。
 *
 * 背景：从 match-detail 合成的 EOG 没有 localPlayer，teams 里也没有阵营标记，
 * 于是视角只能靠「当前登录账号在不在这局里」比对。**换账号后重判别人的老战报**时，
 * 当前登录的账号压根不在这一局里 → resolveMyTeamId 返回 null，
 * normalize 里 `p.teamId === null` 恒为 false → 10 个人全被算成「敌方」，
 * 界面上看起来就是「没有敌我区分」。
 *
 * 这里按战报自己记的归属账号反查阵营补上。**只碰视角这一维**：
 * myTeamId / myResult / teams[].isMyTeam / players[].isMyTeam ——
 * 判定结果（标签 / 分数 / 结论 / 理由）与所有客观数据一个字不动。战报是证据，不能借着修视角改结论。
 *
 * @returns {boolean} 是否真的修了
 */
function healPerspective(report, detail) {
  const ds = report?.dataset;
  if (!ds?.match || ds.match.myTeamId != null) return false;

  const teamId = teamOfPuuid(detail, report?.meta?.ownerPuuid || null);
  if (teamId == null) return false;

  ds.match.myTeamId = teamId;
  const mine = (ds.teams || []).find((t) => t.teamId === teamId);
  if (mine) ds.match.myResult = mine.isWinningTeam ? 'WIN' : 'LOSE';
  for (const t of ds.teams || []) t.isMyTeam = t.teamId === teamId;
  for (const p of ds.players || []) p.isMyTeam = p.teamId === teamId;

  // 修完写回盘 —— 下次打开就不必再补。写完把 mtime 还原，
  // 否则「历史」页按文件时间排序时会把这几个老文件顶到最前面。
  const file = path.join(REPORTS_DIR, `${ds.match.gameId}.json`);
  let mtime = null;
  try { mtime = fs.statSync(file).mtime; } catch { /* 文件不在就算了，下面照样写 */ }
  saveReport(report);
  if (mtime) { try { fs.utimesSync(file, mtime, mtime); } catch { /* 还原不了不影响数据正确性 */ } }
  return true;
}

/**
 * 「这一局属不属于本机账号」的判据 —— **只用于算 owned 标志（能看不能判），
 * v1.2.4 起不再用于拦截只读详情**（大哥要求去掉那道闸，理由见 readMatchView 里的注释）。
 *
 * 留成纯函数是为了让自检能直接喂输入，不依赖真机上凑不出的样本。
 */
export function ownsLocally({ owner = null, meInGame = false } = {}) {
  return !!owner || !!meInGame;
}

export async function readMatchView(gameId, { conn = null, perspectivePuuid = null } = {}) {
  const gid = Number(gameId);
  if (!Number.isFinite(gid)) {
    const err = new Error('gameId 不合法');
    err.code = 'BAD_GAME_ID';
    throw err;
  }

  const c = conn || readConnection().conn;

  // ① 已有战报 —— 读盘就够。顺带把这一局的参与者补进名录（老战报也能补人）
  const cached = tryLoadReport(gid);
  if (cached) {
    await ensureNamesFor(gid, c).catch(() => null);
    let healed = false;
    if (c) {
      const d = await readMatchDetail(c, gid).catch(() => null);
      rememberPlayers(gid, d);
      // 老战报若丢了视角（见 healPerspective 注释），趁 detail 已经在手上顺手补掉。
      // 这里不自己打日志 —— 本模块的约定是日志由调用方注入。
      healed = healPerspective(cached, d);
    }
    return {
      gameId: gid,
      hasReport: true,
      perspectiveHealed: healed,
      report: restoreNames({ ...cached, meta: { ...cached.meta, fromCache: true } }),
    };
  }

  // ② 没有战报 —— 只读原始对局数据
  if (!c) {
    const err = new Error('客户端未运行 —— 离线时只能看已判定过的战报');
    err.code = 'CLIENT_DOWN';
    throw err;
  }

  const detail = await readMatchDetail(c, gid).catch(() => null);
  if (!detail?.participants?.length) {
    const err = new Error('拿不到这一局的对局详情 —— 可能已超出客户端缓存范围');
    err.code = 'MATCH_DETAIL_EMPTY';
    throw err;
  }

  /**
   * ★ v1.2.4：这里的归属闸已经**按大哥要求去掉了**。
   *
   * 原本有这道闸（NOT_MY_MATCH），理由是「随便编个 gameId 也能翻别人的对局」。
   * 但它带来两个实际代价，而收益在本工具形态下并不成立：
   *   ① 它拦不住真正想查的人 —— LCU 就在本机、界面就在本机，
   *      他直接看客户端也一样；这道闸挡的只是「界面上少一个入口」。
   *   ② 它会误伤正当路径：界面点列表行看详情时**没带 perspective**，
   *      归属闸认不出「这是在查谁」，于是「查某人 → 点开某一局」经常被拒。
   *   真正的边界在别处，已经守住了：
   *     · 本地 API 要会话令牌，跨域页面与伪装 Host 进不来（P1）；
   *     · 判定这条路（analyzeMatch）仍有归属闸，**别人的局不会写进「我的战绩」**；
   *     · 查询结果只落 data/searched/，与 matches.json 物理隔开。
   * 所以这里只保留归属**记录**（下面仍然算 owner / meInGame，供 owned 与视角用），
   * 不再做归属**拒绝**。
   *
   * owner / meInGame 仍要算：owned 标志（能看不能判）与视角反查都依赖它们。
   */
  const me = await readCurrentSummoner(c).catch(() => null);
  const { entries } = loadMatchIndex();
  const owner = entries[String(gid)]?.ownerPuuid || null;
  const meInGame = teamOfPuuid(detail, me?.puuid) != null;
  const perspInGame = !!perspectivePuuid && teamOfPuuid(detail, perspectivePuuid) != null;
  // perspective 指向的人在不在局里：不在就别拿他当视角（否则会退化成「没认出我方」）
  const who = (perspInGame ? perspectivePuuid : null) || (meInGame ? me.puuid : null) || owner || null;

  // 顺手攒名录 —— 详情里正好有全部 10 名参与者，是名录最完整的来源
  rememberPlayers(gid, detail);

  const [timeline, championMap, gameData] = await Promise.all([
    readTimeline(c, gid).catch(() => null),
    loadChampionMap(c, { cacheFile: CHAMPIONS_FILE }).catch(() => null),
    loadGameData(c, { cacheFile: GAMEDATA_FILE }).catch(() => null),
  ]);

  // 视角：显式指定（且他确实在局里）→ 本机登录账号在这局里 → 索引里记的归属 → 空
  const { dataset, perspective } = buildDetailDataset(detail, {
    timeline, championMap, gameData, perspectivePuuid: who,
  });

  // pid → 昵称：走与判定链路同一套 pid 分配，同一局两边对得上
  const byName = buildNameMap(synthesizeEogFromMatchDetail(detail), detail);
  const pidToName = Object.fromEntries(Object.entries(byName).map(([n, p]) => [p, n]));

  return {
    gameId: gid,
    hasReport: false,
    dataset,
    // owned = 这局属于本机某个账号（已登记归属，或我本人就在局里）。
    // 查别人拉到的陌生局 owned 为假：**能看**（v1.2.4 已去掉只读归属闸），
    // 但**不能判定** —— 判定会写战报并把这一局记进「我的战绩」，那是别人的局，不该进我的库。
    owned: ownsLocally({ owner, meInGame }),
    names: pidToName,
    perspective: {
      ...perspective,
      puuid: who,
      name: nameInDetail(detail, who) || accountName(who),
    },
  };
}

/* ────────────────── 查询召唤师 ────────────────── */

/**
 * 名录概况 —— 首次调用会把历史抓取（data/account-probe.json）导入一次。
 * 界面用它提示「本机认识多少人」，查不到时也有个明白的说法。
 */
export function rosterState() {
  const seeded = seedRoster();
  const players = listPlayers();
  return {
    players: players.length,
    games: Object.keys(loadRoster().games).length,
    seeded: seeded.seeded,
    file: path.basename(ROSTER_FILE),
  };
}

/**
 * 按昵称（或 puuid 前缀）在名录里找人。
 *
 * ★ 只能查「本机客户端见过的人」—— 不是实现偷懒，是客户端本身不提供按名字查人
 *   （v1 只吃 gameName#tagLine 且中文名 422，v2 连 name 参数都不收）。
 *   查不到就明确说「本机没见过这个人」，不假装能查到。
 */
export function searchSummoner(query, { limit = 20 } = {}) {
  seedRoster();
  const hits = findRosterPlayers(query, { limit });
  return hits.map((h) => ({
    puuid: h.puuid,
    name: h.name,
    gameCount: h.gameIds.length,
  }));
}

/* ────────────────── 搜索历史 ──────────────────
   需求（v1.2.7）：「支持查看历史搜索记录，下次直接选择即可」。
   为什么记在服务端而不是 localStorage：升级包不碰 data/，本机行为数据跟着机器走；
   而且多个入口（界面 / 自己写脚本调 API）记到同一份。
   ⚠️ 这里存的是**别人**的昵称 —— 属于 data/ 那类「不外发」的内容，见 README 隐私章节。
*/

export const SEARCH_HISTORY_FILE = path.join(DATA_DIR, 'search-history.json');
const SEARCH_HISTORY_MAX = 20;

function loadSearchHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(SEARCH_HISTORY_FILE, 'utf8'));
    return Array.isArray(j?.items) ? j.items.filter((x) => x && x.puuid) : [];
  } catch { return []; }
}

/** 记一笔：同一个 puuid 只保留最近的一条，按最近使用排序 */
export function rememberSearch(item) {
  if (!item?.puuid) return loadSearchHistory();
  const name = String(item.name || '').slice(0, 40);
  const rest = loadSearchHistory().filter((x) => x.puuid !== item.puuid);
  const next = [{ puuid: item.puuid, name, at: new Date().toISOString(), hits: item.hits || 0 }, ...rest]
    .slice(0, SEARCH_HISTORY_MAX);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SEARCH_HISTORY_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items: next }, null, 2), 'utf8');
  } catch { /* 记不下来不能连累查询本身 */ }
  return next;
}

/** 清空搜索历史（设置里给个按钮，用不上就抹掉） */
export function clearSearchHistory() {
  try { fs.writeFileSync(SEARCH_HISTORY_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items: [] }, null, 2), 'utf8'); } catch { /* 无所谓 */ }
  return [];
}

/** 最近搜过的人，按最近使用倒序 */
export function listSearchHistory(limit = 8) {
  return loadSearchHistory().slice(0, Math.max(1, Math.min(limit, SEARCH_HISTORY_MAX)))
    .map((x) => ({ puuid: x.puuid, name: x.name, at: x.at }));
}

/**
 * 某人的战绩 —— 从名录拿到他参与过的局，逐局拉详情组装。
 *
 * 结果缓存到 data/searched/<puuid>.json（TTL 10 分钟）：
 *   · 同一个名字连点几次不再重复拉 200 局详情
 *   · **与「我的战绩」物理隔开** —— 不写 data/matches.json，不碰归属判定，
 *     查别人的数据永远只在查询视图里出现
 */
export async function summonerMatches(puuid, { conn = null, refresh = false, limit = 300 } = {}) {
  const player = getRosterPlayer(puuid);
  if (!player) {
    const err = new Error('本机名录里没有这个召唤师 —— 只认识客户端缓存里出现过的人');
    err.code = 'NOT_IN_ROSTER';
    throw err;
  }

  const cache = loadSearchCache(puuid);
  if (!refresh && cache && isSearchFresh(cache) && Array.isArray(cache.matches) && cache.matches.length) {
    return { ...cache, fromCache: true };
  }

  const c = conn || readConnection().conn;
  if (!c) {
    if (cache) return { ...cache, fromCache: true, stale: true };   // 离线时给上次的结果
    const err = new Error('客户端未运行 —— 查询战绩需要读本机客户端的对局缓存');
    err.code = 'CLIENT_DOWN';
    throw err;
  }

  // 对局清单 = 两个来源的并集，谁多听谁的：
  //   ① 名录 —— 他出现在我读过的对局里（可能攒了几百局，但都是「我也在场」的局）
  //   ② LCU —— 直接问客户端「这个人打过哪些局」（近 50 局左右，不看我在不在场）
  // ② 才是「拉到他所有对局」的正解：实测对名录里只见过 1 局的人，
  //   客户端能给 51 局，其中 50 局是我从没见过的。
  const rosterIds = player.gameIds.slice();
  const clientIds = await readMatchListFor(c, puuid).catch(() => []);
  const merged = new Map();
  for (const g of rosterIds) merged.set(String(g), 'roster');
  for (const g of clientIds) if (!merged.has(String(g))) merged.set(String(g), 'client');
  const fromClient = [...merged.values()].filter((v) => v === 'client').length;

  const gameIds = [...merged.keys()].sort((a, b) => Number(b) - Number(a)).slice(0, limit);
  const championMap = await loadChampionMap(c, { cacheFile: CHAMPIONS_FILE }).catch(() => null);

  const rows = [];
  const seen = [];
  // 并发拉详情。LCU 是本地 HTTPS，单局往返约 40–50ms ——
  // 并发 6 时 195 局要 9 秒多，太快不了；提到 12 后降到 4 秒上下。
  // 再往上收益递减（本地 loopback + 客户端自身处理是瓶颈），也容易让客户端变慢。
  const CONC = 12;
  for (let i = 0; i < gameIds.length; i += CONC) {
    const batch = gameIds.slice(i, i + CONC);
    const res = await Promise.all(batch.map((g) => readMatchDetail(c, g).catch(() => null)));
    for (const d of res) {
      if (!d?.participants?.length) continue;
      seen.push({ gameId: d.gameId, detail: d });
      // ★ myPuuid = 被查的人 → 出来的就是「他玩什么英雄、KDA 多少」
      const row = summarizeGame(d, { myPuuid: puuid, ownerPuuid: puuid, championMap });
      if (row?.gameId) rows.push({ ...row, isTarget: true });
    }
  }

  // 顺带把抓到的参与者并进名录（查一个人，认识更多人）
  rememberPlayersBatch(seen);
  sortEntries(rows);

  const payload = {
    puuid,
    name: player.name,
    fetchedAt: new Date().toISOString(),
    scanned: gameIds.length,
    // 拆开记：界面要能说清「这 N 局里有几局是客户端额外给的」——
    // 客户端缓存不稳定（实测同一人 11～51 局浮动），不说明白会让人以为漏了
    scannedFromRoster: rosterIds.length,
    scannedFromClient: fromClient,
    total: rows.length,
    matches: rows,
  };
  saveSearchCache(puuid, payload);
  return { ...payload, fromCache: false };
}

/* ────────────────── 落盘 ────────────────── */

/** 战报落盘。文件名用 gameId，一局一份，重复判定则覆盖 */
export function saveReport(report) {
  const gameId = report?.dataset?.match?.gameId;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = gameId ? `${gameId}.json` : `report-${stamp}.json`;
  const file = path.join(REPORTS_DIR, name);

  // 战报文件里只留 pid —— 它是要能拿出去分享的；
  // 真名另存本机昵称索引（data/names.json），界面读盘时再还原回去
  rememberNames(gameId, report?.names);

  // 归属账号兜底：写的时候没带上，就沿用盘里那份 —— 别把归属弄丢
  let owner = report?.meta?.ownerPuuid || null;
  if (!owner) {
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8'))?.meta?.ownerPuuid || null; } catch { /* 新文件，没有就没有 */ }
  }
  const onDisk = {
    ...report,
    meta: { ...(report.meta || {}), ownerPuuid: owner },
    names: undefined,
    _namesOmitted: true,
  };
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8');
  return file;
}

/** 最近 N 份战报（按文件时间倒序），供「历史」页 */
export function listReports(limit = 30, { account = null } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
  } catch { return []; }

  const viewing = account === undefined ? null : resolveViewing(account);

  return files
    .map((f) => {
      const full = path.join(REPORTS_DIR, f);
      return { file: full, name: f, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ file, name, mtime }) => {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        migrateLegacyScores(j);      // 老战报（0-100 制）读出来折成 0-10，不改盘
        return {
          file: name,
          mtime,
          gameId: j?.dataset?.match?.gameId ?? null,
          mode: j?.dataset?.match?.mode ?? null,
          duration: j?.dataset?.match?.durationText ?? null,
          result: j?.dataset?.match?.myResult ?? null,
          source: j?.meta?.source ?? null,
          tone: j?.meta?.tone ?? null,
          ownerPuuid: j?.meta?.ownerPuuid ?? null,
          verdict: j?.result?.verdict ?? null,
          players: (j?.result?.players || []).map((p) => ({ pid: p.pid, label: p.label, score: p.score })),
        };
      } catch {
        return { file: name, mtime, broken: true };
      }
    })
    // 历史页也要分账号 —— 不然翻历史翻出一堆别人打的局
    .filter((r) => !viewing || belongsTo({ ownerPuuid: r.ownerPuuid }, viewing))
    .slice(0, limit);
}

export function loadReport(fileName) {
  const safe = path.basename(String(fileName || ''));
  const full = path.join(REPORTS_DIR, safe);
  if (!full.startsWith(REPORTS_DIR)) throw new Error('非法文件名');
  return restoreNames(JSON.parse(fs.readFileSync(full, 'utf8')));
}

/* ────────────────── 自动监视器 ────────────────── */

/**
 * 打完自动出报。
 *
 * 两条路并行，谁先发现算谁：
 *   1. 阶段进入结束态（WaitingForStats / PreEndOfGame / EndOfGame）
 *      —— 快，但 EOG 接口窗口常只有几秒，5s 轮询可能整段错过
 *   2. 每 30s 查一次「最近一局 gameId」
 *      —— 慢一点，但对局记录打完永久可查，是漏网的最后一道保险
 *
 * 之前只靠 EOG 拉数据，现在改成拿不到 EOG 就退到 match-history，
 * 判定结果等价（对局记录字段更全）。
 */
const END_PHASES = new Set(['WaitingForStats', 'PreEndOfGame', 'EndOfGame']);

export function createWatcher({
  intervalMs = 5000, onEvent = () => {}, getOptions = () => ({}),
  shouldAutoAnalyze = () => false,
} = {}) {
  let timer = null;
  let lastPhase = null;
  let handledGameId = null;
  let baselineGameId = null;      // 开监视时「最近一局」，用来识别新对局
  let listChecks = 0;
  let busy = false;
  const state = { active: false, phase: null, clientOnline: false, lastError: null, lastReportAt: null, lastGameId: null };

  /** 判定一局并广播（只有显式开了「赛后自动分析」才会走到） */
  async function runAnalysis(conn, gid, via) {
    onEvent({ type: 'analyzing', gameId: gid, via });
    try {
      const report = await analyzeWithConn(conn, { ...getOptions(), source: via === 'phase' ? 'lcu-auto' : 'match-history-auto' });
      // analyzeMatch 内部已落盘（meta.savedFile），EOG 那条路没有 → 这里补上，避免重复写；
      // 缓存命中（fromCache）说明盘里已经有这份战报，同样不必再写
      if (!report?.meta?.savedFile && !report?.meta?.fromCache) saveReport(report);
      handledGameId = gid;
      state.lastReportAt = Date.now();
      state.lastError = null;
      state.lastGameId = gid;
      onEvent({ type: 'report', report, gameId: gid });
    } catch (e) {
      state.lastError = e.message;
      onEvent({ type: 'error', message: e.message, gameId: gid });
      if (handledGameId === gid) handledGameId = null;   // 失败不占坑，下一轮重试
    }
  }

  /**
   * 发现新对局 —— 默认**只登记、只广播，不判定**。
   *
   * 判定是要花钱的（一次 DeepSeek 调用），不该由「打完一局」这件事替人决定。
   * 所以这里只挂个信号出去，界面上提示「有新对局」，用户点进去看详情、
   * 想判再点「开始分析」。要恢复旧行为，把「赛后自动分析」打开即可。
   */
  async function noticeNewGame(conn, gid, via) {
    if (gid == null || gid === handledGameId) return;
    if (shouldAutoAnalyze()) return runAnalysis(conn, gid, via);
    handledGameId = gid;
    state.lastGameId = gid;
    state.lastNewGameAt = Date.now();
    onEvent({ type: 'newgame', gameId: gid, via });
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      // 常驻循环走异步版：同步全盘扫 24 个盘符会把单线程服务卡住（见 client.mjs 的缓存注释）
      const { conn, running } = await readConnectionAsync();
      if (!running) {
        if (state.clientOnline !== false) {
          state.clientOnline = false;
          state.phase = null;
          onEvent({ type: 'client', online: false });
        }
        return;
      }
      if (!state.clientOnline) {
        state.clientOnline = true;
        onEvent({ type: 'client', online: true, port: conn.port });
      }

      const phase = await readPhase(conn);
      if (phase !== lastPhase) {
        lastPhase = phase;
        state.phase = phase;
        onEvent({ type: 'phase', phase });
      }

      // 路径 1：阶段进入结束态
      if (END_PHASES.has(phase)) {
        const eog = await readEog(conn).catch(() => null);
        const gid = eog?.gameId ?? null;
        if (gid != null) return noticeNewGame(conn, gid, 'phase');
        // EOG 还没就绪 —— 先记下基线，交给路径 2
      }

      // 路径 2：每 30s（6 次轮询）查一次最近对局列表
      if (++listChecks >= 6) {
        listChecks = 0;
        const list = await readRecentMatches(conn, { begIndex: 0, endIndex: 300 }).catch(() => null);

        // 顺手把列表里的每一局都记进战绩索引 —— 不依赖用户是否打开过战绩页，
        // 否则客户端缓存滑动时，那些局就再也列不出来了
        await sweepIntoIndex(conn, list).catch(() => null);

        // 取「真正最新」那一局（gameId 与时间不同序，不能拿数组第一项）
        const gid = pickLatestGame(list)?.gameId ?? null;

        if (gid != null) {
          if (baselineGameId === null) {
            baselineGameId = gid;    // 第一次拿到，只记基线，不判定历史对局
          } else if (gid !== baselineGameId && gid !== handledGameId) {
            baselineGameId = gid;
            await noticeNewGame(conn, gid, 'match-history');
          }
        }
      }
    } catch (e) {
      state.lastError = e.message;
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      state.active = true;
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      state.active = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
    get state() { return { ...state, lastPhase, baselineGameId }; },
    /** 手动触发一次检测 */
    poke: tick,
  };
}
