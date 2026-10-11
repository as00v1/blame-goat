/**
 * 真机抓取回放器 —— 把 watch-eog.mjs 抓到的原始数据喂进链路
 *
 * 用法：node tools/replay-capture.mjs [_ref/eog-captures/<时间戳>]
 *   不带参数时取最新一个抓取目录。
 *
 * 它做两件事：
 *   1. 打印原始 EOG 的字段结构 —— 用来核对国服真实字段名与 mock 的差异
 *   2. 跑 normalize + 判定全链路 —— 验证真机数据能被正确解析
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConnection } from '../src/lcu/client.mjs';
import { loadChampionMap } from '../src/lcu/champions.mjs';
import { normalize } from '../src/lcu/normalize.mjs';
import { analyzeFromEog, CHAMPIONS_FILE, loadConfig } from '../server/service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES = path.join(ROOT, '_ref', 'eog-captures');

/** 取最新抓取目录 */
function latestDir() {
  const args = process.argv[2];
  if (args) return path.resolve(args);
  const dirs = fs.readdirSync(CAPTURES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ p: path.join(CAPTURES, e.name), t: fs.statSync(path.join(CAPTURES, e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return dirs[0]?.p || null;
}

const pick = (obj, keys) => keys.map((k) => {
  const v = obj?.[k];
  const t = Array.isArray(v) ? `array(${v.length})` : typeof v;
  const pv = (v == null) ? String(v) : (typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60));
  return `${k}: ${t} = ${pv}`;
}).join('\n    ');

const dir = latestDir();
if (!dir || !fs.existsSync(dir)) {
  console.error('没找到抓取目录。先跑 tools/watch-eog.mjs 蹲一局。');
  process.exit(1);
}
console.log(`\n读取抓取目录：${dir}\n`);

const readJson = (n) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; }
};

const eog = readJson('01-eog-stats-block.json');
const session = readJson('02-gameflow-session.json');
const me = readJson('03-current-summoner.json');
const detail = readJson('04-match-detail.json');
const timeline = readJson('05-game-timeline.json');

/* ───── 1. 原始结构 ───── */
console.log('═'.repeat(66));
console.log('  原始数据清单');
console.log('═'.repeat(66));
for (const [n, v] of [['01-eog-stats-block', eog], ['02-gameflow-session', session], ['03-current-summoner', me], ['04-match-detail', detail], ['05-game-timeline', timeline]]) {
  console.log(`  ${n.padEnd(22)} ${v ? '✓ ' + (JSON.stringify(v).length / 1024).toFixed(1) + ' KB' : '✗ 无'}`);
}
console.log('');

if (eog) {
  console.log('─── EOG 顶层字段 ───');
  console.log('    ' + pick(eog, Object.keys(eog)).replace(/\n/g, '\n    '));
  console.log('');

  const t0 = (eog.teams || [])[0];
  if (t0) {
    console.log('─── teams[0] 字段 ───');
    console.log('    ' + pick(t0, Object.keys(t0)).replace(/\n/g, '\n    '));
    const p0 = (t0.players || [])[0];
    if (p0) {
      console.log('\n─── teams[0].players[0] 字段 ───');
      console.log('    ' + pick(p0, Object.keys(p0)).replace(/\n/g, '\n    '));
      if (p0.stats) {
        console.log('\n─── ...players[0].stats 字段 ───');
        console.log('    ' + pick(p0.stats, Object.keys(p0.stats)).replace(/\n/g, '\n    '));
      }
    }
  }
  // 事件类型分布 —— 看国服实际给哪些 type
  const types = {};
  for (const e of eog.events || []) types[e.type] = (types[e.type] || 0) + 1;
  console.log('\n─── eog.events 条数与类型 ───');
  console.log(`    条数 ${(eog.events || []).length}　${JSON.stringify(types)}`);
  console.log('');
}

// 真机的事件其实在 timeline 里，EOG 的 events 恒为空
if (timeline?.frames) {
  let n = 0;
  const types = {};
  for (const f of timeline.frames) {
    for (const e of f.events || []) { n++; types[e.type] = (types[e.type] || 0) + 1; }
  }
  console.log('─── timeline.frames[].events（真机事件真身）───');
  console.log(`    frames ${timeline.frames.length} 个 / 事件 ${n} 条　${JSON.stringify(types)}`);
  const sample = timeline.frames.flatMap((f) => f.events || [])[0];
  if (sample) console.log('    样例 ' + JSON.stringify(sample).slice(0, 220));
  console.log('');
}

if (detail) {
  console.log('─── match-detail 关键字段 ───');
  console.log('    ' + pick(detail, ['gameId', 'queueId', 'mapId', 'gameMode', 'gameDuration', 'gameVersion']).replace(/\n/g, '\n    '));
  console.log(`    teams: ${JSON.stringify((detail.teams || []).map((t) => ({ teamId: t.teamId, win: t.win })))}`);
  console.log(`    玩家 participantId: ${(detail.participants || []).length} 人 / identities: ${(detail.participantIdentities || []).length} 条`);
  console.log('');
}

if (session) {
  const gd = session.gameData || {};
  console.log('─── gameflow session.gameData 关键字段 ───');
  console.log('    ' + pick(gd, ['gameId', 'gameName', 'isCustomGame', 'queue', 'teamOne', 'teamTwo']).replace(/\n/g, '\n    '));
  console.log('');
}

/* ───── 2. 跑链路 ───── */
const target = eog || detail;
if (!target) {
  console.error('既没有 EOG 也没有 match-detail，无法回放。');
  process.exit(2);
}

console.log('═'.repeat(66));
console.log(eog ? '  跑 normalize（基于 EOG + match-detail + timeline）' : '  跑 normalize（基于 match-detail）');
console.log('═'.repeat(66));

const { conn } = readConnection();
const champMap = await loadChampionMap(conn, { cacheFile: CHAMPIONS_FILE });
console.log(`  英雄表：${champMap.from} / ${champMap.count} 条\n`);

const cfg = loadConfig();
const report = await analyzeFromEog(eog || detail, {
  conn, apiKey: cfg.apiKey, tone: cfg.tone, params: cfg.params, source: 'replay',
  championMap: champMap, matchDetail: detail, timeline, session,
});

const ds = report.dataset;
console.log(`  对局   gameId=${ds.match.gameId}  模式=${ds.match.mode}  queueId=${ds.match.queueId}  mapId=${ds.match.mapId}  时长=${ds.match.durationText}`);
console.log(`  我的视角 myTeamId=${ds.match.myTeamId}  结果=${ds.match.myResult}`);
console.log(`  玩家 ${ds.players.length} 人（互异 pid ${ds.integrity.distinctPids}） / 时间轴 ${ds.timeline.length} 条 / 判定来源 ${report.meta.source}`);
console.log(`  数据源 match-detail=${report.meta.hasMatchDetail} timeline=${report.meta.hasTimeline} 身份索引=${report.meta.identityIndexSize}\n`);

console.log('  玩家：');
for (const p of ds.players) {
  const r = report.result.players.find((x) => x.pid === p.pid) || {};
  const nm = report.names[p.pid] || p.pid;
  console.log(`    ${String(p.pid).padEnd(4)} ${String(nm).padEnd(16)} ${String(p.champion).padEnd(7)} ${String(p.championTitle || '').padEnd(7)} ${String(p.championType).padEnd(9)} ${String(r.label || '?').padEnd(11)} KDA ${p.kills}/${p.deaths}/${p.assists}  参团 ${p.killParticipation ?? '-'}`);
}

if (ds.timeline.length) {
  console.log('\n  时间轴（前 8 条）：');
  for (const t of ds.timeline.slice(0, 8)) {
    const parts = [];
    if (t.actor) parts.push(t.actor);
    if (t.victim) parts.push('→ ' + t.victim);
    if (t.assisters) parts.push('(助 ' + t.assisters.join('/') + ')');
    if (t.object) parts.push('[' + t.object + ']');
    console.log(`    ${t.time}  ${String(t.type).padEnd(16)} ${parts.join(' ')}`);
  }
}

console.log(`\n  结论：${report.result.verdict}`);
if (report.result.insight) console.log(`  洞察：${report.result.insight}`);
console.log(`\n  耗时 ${report.meta.totalMs}ms  错误 ${JSON.stringify(report.meta.errors)}`);
console.log('');
