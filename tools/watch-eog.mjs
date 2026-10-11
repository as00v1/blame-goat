/**
 * 真机 EOG 蹲守器 —— 轮询 gameflow-phase，对局一结束立刻把所有原始数据抓下来
 *
 * 用法：node tools/watch-eog.mjs [分钟数]
 *   默认蹲守 90 分钟。抓到的原始响应全部落盘到 _ref/eog-captures/<时间戳>/，
 *   不做任何加工 —— 目的是拿到国服真实字段名，回头校准 normalize.mjs。
 *
 * 为什么要多管齐下：EOG 接口只在特定阶段可用（EndOfGame / PreEndOfGame），
 * 而 match-history 是打完就能查。两条路都抓，哪条通用走哪条。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readConnection, lcuRequest, readPhase, readCurrentSummoner,
} from '../src/lcu/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES = path.join(ROOT, '_ref', 'eog-captures');
fs.mkdirSync(CAPTURES, { recursive: true });

const MINUTES = Number(process.argv[2] || 90);
const INTERVAL_MS = 5000;
const DEADLINE = Date.now() + MINUTES * 60 * 1000;

/** 判定「打完了」的阶段 */
const END_PHASES = new Set(['WaitingForStats', 'PreEndOfGame', 'EndOfGame']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const log = (...a) => console.log(`[${clock()}]`, ...a);

/** match-history 的两三种嵌套形状都兜住，抠出最近一局的 gameId */
function extractGameId(listResp) {
  if (!listResp) return null;
  const arr = listResp.games?.games || listResp.games || listResp.matches || [];
  const first = Array.isArray(arr) ? arr[0] : null;
  return first?.gameId ?? null;
}

/** 查最近一局的 gameId（用于识别「新一局打完了」） */
async function latestGameId(conn) {
  const r = await tryGet(conn, '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=1');
  return r.ok ? extractGameId(r.data) : null;
}

function save(dir, name, data) {
  const file = path.join(dir, name);
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(file, text, 'utf8');
  log(`  💾 ${name}  (${(text.length / 1024).toFixed(1)} KB)`);
  return file;
}

async function tryGet(conn, endpoint) {
  try {
    return { ok: true, data: await lcuRequest(conn, { endpoint, timeoutMs: 20000 }) };
  } catch (e) {
    return { ok: false, status: e.statusCode || 0, msg: e.message };
  }
}

/** 抓一轮：把所有可能有用的原始数据都存下来 */
async function captureAll(conn) {
  const dir = path.join(CAPTURES, stamp());
  fs.mkdirSync(dir, { recursive: true });
  const index = { at: new Date().toISOString(), port: conn.port, by: 'watch-eog' };

  // 1. 主目标：EOG 统计块（含 10 人完整 stats + events）
  const eog = await tryGet(conn, '/lol-end-of-game/v1/eog-stats-block');
  index.eogStatsBlock = eog.ok ? 'ok' : `${eog.status} ${eog.msg}`;
  if (eog.ok) save(dir, '01-eog-stats-block.json', eog.data);

  // 2. 会话信息（含 gameId）
  const session = await tryGet(conn, '/lol-gameflow/v1/session');
  index.session = session.ok ? 'ok' : `${session.status} ${session.msg}`;
  if (session.ok) save(dir, '02-gameflow-session.json', session.data);

  // 3. 定视角用
  const me = await tryGet(conn, '/lol-summoner/v1/current-summoner');
  if (me.ok) save(dir, '03-current-summoner.json', me.data);

  // 4. 从会话里抠 gameId，再拉对局详情与时间轴
  const gameId = session.ok
    ? (session.data?.gameData?.gameId ?? session.data?.gameId ?? eog.data?.gameId ?? null)
    : (eog.ok ? eog.data?.gameId : null);
  index.gameId = gameId;

  if (gameId) {
    const detail = await tryGet(conn, `/lol-match-history/v1/games/${gameId}`);
    index.matchDetail = detail.ok ? 'ok' : `${detail.status} ${detail.msg}`;
    if (detail.ok) save(dir, '04-match-detail.json', detail.data);

    const tl = await tryGet(conn, `/lol-match-history/v1/game-timelines/${gameId}`);
    index.timeline = tl.ok ? 'ok' : `${tl.status} ${tl.msg}`;
    if (tl.ok) save(dir, '05-game-timeline.json', tl.data);
  }

  // 5. 兜底：最近一局列表（gameId 拿不到时用）
  const list = await tryGet(conn, '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=3');
  if (list.ok) save(dir, '06-recent-matches.json', list.data);

  index.phase = await readPhase(conn);
  save(dir, '00-index.json', index);

  // 6. 英雄对照表（国服中文名来源，供 normalize 层用）
  //    存 LCU 原样返回的 summary 数组 —— 不要在这里改字段名。
  //    踩过的坑：上一版存成 { name: c.name, title: c.description }，
  //    而国服 c.name 是**称号**、c.description 才是英雄名，存完语义就反了，
  //    离线样例里「普朗克」直接显示成「海洋之灾」。
  const champs = await tryGet(conn, '/lol-game-data/assets/v1/champion-summary.json');
  if (champs.ok && Array.isArray(champs.data)) {
    save(dir, '07-champion-summary.json', champs.data);
  }

  log(`\n>>> 抓取完成，目录：${dir}\n`);
  return dir;
}

/* ─────────── 主循环 ─────────── */

log(`蹲守中… 最长 ${MINUTES} 分钟，每 ${INTERVAL_MS / 1000}s 探一次阶段`);
log(`落盘目录：${CAPTURES}\n`);

let lastPhase;
let done = false;
let baselineGameId = null;     // 开蹲时的「最近一局」id，用来识别新对局
let listChecks = 0;

// 记基线：本次蹲守开始前，最近一局是哪个 gameId
{
  const { conn } = readConnection();
  if (conn) {
    baselineGameId = await latestGameId(conn);
    log(`基线：开蹲前最近一局 gameId = ${baselineGameId ?? '(查不到)'}`);
  }
}

while (Date.now() < DEADLINE && !done) {
  const { conn, source } = readConnection();

  if (!conn) {
    if (lastPhase !== '(无连接)') { log('客户端连接不可用，等待中…'); lastPhase = '(无连接)'; }
    await sleep(INTERVAL_MS);
    continue;
  }

  const phase = await readPhase(conn);
  if (phase !== lastPhase) {
    const me = await readCurrentSummoner(conn);
    const who = me ? ` · ${me.displayName || me.gameName}` : '';
    log(`phase → ${String(phase).padEnd(16)} (via ${source}, port ${conn.port})${who}`);
    lastPhase = phase;
  }

  // 双保险 1：阶段进入结束态
  if (END_PHASES.has(phase)) {
    log('🎯 阶段进入结束态，开始抓取完整数据…');
    await captureAll(conn);
    done = true;
    break;
  }

  // 双保险 2：每 6 次轮询查一次 match-history。
  // EndOfGame 阶段窗口可能只有几秒，5s 轮询容易整段错过；
  // 而 match-history 是打完就永久可查的，用它兜住漏网。
  if (++listChecks >= 6) {
    listChecks = 0;
    const gid = await latestGameId(conn);
    if (gid && gid !== baselineGameId) {
      log(`🔔 match-history 出现新对局 gameId=${gid}（基线 ${baselineGameId ?? '无'}），开始抓取…`);
      await captureAll(conn);
      done = true;
      break;
    }
  }

  await sleep(INTERVAL_MS);
}

if (!done) log(`蹲守时间到（${MINUTES} 分钟），未捕获到对局结束。`);
