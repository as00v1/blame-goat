/**
 * 把真机抓取转成离线样例 —— 数据是真的，身份是假的
 *
 * 用法：node tools/capture-to-sample.mjs [_ref/eog-captures/<时间戳>]
 *
 * 为什么需要它：
 *   手写的 sample-eog.json 是「峡谷尺度」的想象数据（13 分钟、死亡 1–12），
 *   和真实海克斯大乱斗（29 分钟、死亡 12–22、191 条事件）差得太远 ——
 *   用假尺度调出来的阈值，一到真机就全饱和。拿真数据的形状 + 假身份，
 *   离线 demo 才有参考价值。
 *
 * 脱敏范围（只换身份，不动任何数值）：
 *   · 昵称 summonerName / riotIdGameName / gameName → 路人甲…路人癸
 *   · summonerId / puuid / accountId → 假值
 *   · 会话里的 password / spectatorKey / 聊天 JWT → 直接删
 *
 * 产出 prototype/sample/ 下的四个文件 + 一份说明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMapsFromSummary } from '../src/lcu/champions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES = path.join(ROOT, '_ref', 'eog-captures');
const OUT_DIR = path.join(ROOT, 'prototype', 'sample');
const CHAMP_CACHE = path.join(ROOT, 'data', 'champions.json');

/** 天干 —— 十个字，正好十名玩家。一眼看得出是假名 */
const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const fakeName = (participantId) => `路人${STEMS[(Number(participantId) - 1) % 10]}`;
const fakeSummonerId = (participantId) => 90000000000 + Number(participantId);
const fakePuuid = (participantId) => `00000000-0000-4000-8000-${String(participantId).padStart(12, '0')}`;

function latestCaptureDir() {
  const argv = process.argv[2];
  if (argv) return path.resolve(argv);
  const dirs = fs.readdirSync(CAPTURES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ p: path.join(CAPTURES, e.name), t: fs.statSync(path.join(CAPTURES, e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return dirs[0]?.p || null;
}

/** 给一个「身份对象」换上假身份 */
function anonymizeIdentity(obj, participantId) {
  if (!obj || participantId == null) return obj;
  const name = fakeName(participantId);
  const out = { ...obj };
  for (const k of ['summonerName', 'riotIdGameName', 'gameName', 'displayName', 'summonerInternalName']) {
    if (k in out) out[k] = name;
  }
  if ('summonerId' in out) out.summonerId = fakeSummonerId(participantId);
  if ('accountId' in out) out.accountId = fakeSummonerId(participantId);
  if ('currentAccountId' in out) out.currentAccountId = fakeSummonerId(participantId);
  if ('puuid' in out) out.puuid = fakePuuid(participantId);
  if ('matchHistoryUri' in out) out.matchHistoryUri = '';
  if ('tagLine' in out) out.tagLine = String(10000 + Number(participantId));
  return out;
}

/** 删掉不该进样例的令牌类字段 */
function stripSecrets(obj) {
  const SECRET_KEYS = new Set([
    'multiUserChatPassword', 'mucJwtDto', 'password', 'spectatorKey',
    'multiUserChatId', 'remotingAuthToken',
  ]);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEYS.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(obj);
}

const dir = latestCaptureDir();
if (!dir || !fs.existsSync(dir)) {
  console.error('没找到抓取目录。先跑 tools/watch-eog.mjs 蹲一局。');
  process.exit(1);
}

const readJson = (n) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; }
};

const eogRaw = readJson('01-eog-stats-block.json');
const detailRaw = readJson('04-match-detail.json');
const timelineRaw = readJson('05-game-timeline.json');
const sessionRaw = readJson('02-gameflow-session.json');

if (!eogRaw || !detailRaw) {
  console.error('抓取目录里缺 EOG 或 match-detail，无法转换。');
  process.exit(1);
}

/* ── 1. EOG：玩家身份换假名 ── */
const eog = structuredClone(eogRaw);
for (const t of eog.teams || []) {
  t.players = (t.players || []).map((p) => {
    // EOG 玩家没有 participantId，用 (teamId, championId) 去 match-detail 反查
    const match = (detailRaw.participants || []).find(
      (x) => x.teamId === p.teamId && x.championId === p.championId,
    );
    return anonymizeIdentity(p, match?.participantId);
  });
}
if (eog.localPlayer) {
  const match = (detailRaw.participants || []).find(
    (x) => x.teamId === eog.localPlayer.teamId && x.championId === eog.localPlayer.championId,
  );
  eog.localPlayer = anonymizeIdentity(eog.localPlayer, match?.participantId);
}

/* ── 2. match-detail：identities 换假名 ── */
const detail = structuredClone(detailRaw);
detail.participantIdentities = (detail.participantIdentities || []).map((id) => ({
  participantId: id.participantId,
  player: anonymizeIdentity(id.player || {}, id.participantId),
}));
// 部分版本 participants 里也带身份字段
detail.participants = (detail.participants || []).map((p) =>
  anonymizeIdentity(p, p.participantId));

/* ── 3. session：身份 + 令牌 ── */
let session = sessionRaw ? structuredClone(sessionRaw) : null;
if (session?.gameData) {
  const gd = session.gameData;
  gd.playerChampionSelections = (gd.playerChampionSelections || []).map((s) => {
    const match = (detailRaw.participants || []).find((x) => x.championId === s.championId);
    return { ...s, puuid: fakePuuid(match?.participantId ?? 1) };
  });
  for (const key of ['teamOne', 'teamTwo']) {
    gd[key] = (gd[key] || []).map((s) => anonymizeIdentity(s, s.teamParticipantId ?? 1));
  }
}

/* ── 4. timeline：纯数值，无需脱敏，原样保留 ── */
const timeline = timelineRaw ? structuredClone(timelineRaw) : null;

/* ── 5. 统一清掉令牌类字段 ── */
const out = {
  eog: stripSecrets(eog),
  detail: stripSecrets(detail),
  timeline: stripSecrets(timeline),
  session: stripSecrets(session),
};

/* ── 6. 英雄表 —— 离线链路没有 LCU 可查，必须随样例一起带上 ──
 * 不带的话 resolveChampion 拿不到 championId 的映射，会退回 EOG 的
 * championName —— 而真机那里给的**是称号**，「普朗克」就变成「海洋之灾」了。
 */
function loadChampionMapForSample() {
  // 6.1 运行时缓存（由 LCU 正确构建，最可靠）
  try {
    const c = JSON.parse(fs.readFileSync(CHAMP_CACHE, 'utf8'));
    if (c?.byId && Object.keys(c.byId).length) {
      return { at: c.at, byId: c.byId, byAlias: c.byAlias, byName: c.byName, count: c.count, from: 'cache' };
    }
  } catch { /* 没缓存就往下走 */ }

  // 6.2 新抓取文件：LCU 原样返回的 summary 数组
  const rawList = readJson('07-champion-summary.json');
  if (Array.isArray(rawList) && rawList.length) {
    return { ...buildMapsFromSummary(rawList), from: 'capture-summary' };
  }

  // 6.3 旧抓取文件：当时把 name/title 存反了，这里反转回来
  //     { name: 称号, title: 英雄名 }  →  { name: 称号, description: 英雄名 }
  const legacy = readJson('07-champion-map.json');
  if (legacy && typeof legacy === 'object') {
    const list = Object.entries(legacy).map(([id, e]) => ({
      id: Number(id), name: e.name, description: e.title, alias: e.alias, roles: e.roles,
    }));
    return { ...buildMapsFromSummary(list), from: 'capture-legacy' };
  }
  return null;
}

const champions = loadChampionMapForSample();

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (name, data) => {
  if (!data) return null;
  const f = path.join(OUT_DIR, name);
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  💾 ${name}  (${(fs.statSync(f).size / 1024).toFixed(1)} KB)`);
  return f;
};

console.log(`\n源目录：${dir}\n`);
write('eog.json', out.eog);
write('match-detail.json', out.detail);
write('timeline.json', out.timeline);
write('session.json', out.session);
write('champions.json', champions);
write('meta.json', {
  source: path.basename(dir),
  convertedAt: new Date().toISOString(),
  gameId: out.detail.gameId,
  queueId: out.detail.queueId,
  mapId: out.detail.mapId,
  gameDuration: out.detail.gameDuration,
  championMapFrom: champions?.from || null,
  championMapCount: champions?.count || 0,
  anonymized: true,
  note: '数值全部来自真机抓取，仅玩家身份被替换为「路人甲…路人癸」。',
});

// 自检：确认没有真实昵称残留
const realNames = new Set();
for (const t of eogRaw.teams || []) {
  for (const p of t.players || []) {
    if (p.summonerName) realNames.add(p.summonerName);
    if (p.riotIdGameName) realNames.add(p.riotIdGameName);
  }
}
const dump = JSON.stringify(out);
const leaked = [...realNames].filter((n) => dump.includes(n));
console.log(`\n脱敏自检：原 ${realNames.size} 个昵称 → 残留 ${leaked.length} 个${leaked.length ? ' ⚠ ' + leaked.join(', ') : ' ✓'}`);
console.log(`产出目录：${OUT_DIR}\n`);

if (leaked.length) process.exitCode = 2;
