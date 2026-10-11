#!/usr/bin/env node
/**
 * BlameGoat 核心原型 —— 数据整理 + 调 DeepSeek + 本地兜底
 *
 * 用法：
 *   export DEEPSEEK_API_KEY=sk-xxxx        # 不设则自动走本地兜底
 *   node prototype/deepseek-judge.mjs
 *   node prototype/deepseek-judge.mjs --tone savage
 *
 * 产出：prototype/output/judge-report.json（完整 dataset + result，可直接喂给界面）
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize, toClock } from '../src/lcu/normalize.mjs';
import {
  judge, buildNameMap, anonymize, assertNoRealNames, deanonymizeText, restoreResultText,
  LABEL_CN, promptStatsSafe,
} from '../src/deepseek/index.mjs';
import { buildMessages, DEFAULT_PARAMS } from '../src/deepseek/prompt.mjs';
import { loadGameData } from '../src/lcu/gamedata.mjs';
import { loadSampleBundle, GAMEDATA_FILE } from '../server/service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const tone = (args.includes('--tone') ? args[args.indexOf('--tone') + 1] : null) || 'normal';
const OUT_DIR = resolve(ROOT, 'prototype/output');
const OUT_FILE = resolve(OUT_DIR, 'judge-report.json');

const log = (m) => console.log('[blamebox] ' + m);
const line = (c = '─') => console.log(c.repeat(64));

async function main() {
  line('═');
  console.log(`  BlameGoat 原型链路 · 语气=${tone}`);
  line('═');

  // ── 1. 读原始数据（真机抓取脱敏样例，含 eog / match-detail / timeline）──
  const sample = loadSampleBundle();
  const eog = sample.eog;
  if (!eog) {
    console.error('离线样例缺失。先跑：node tools/capture-to-sample.mjs');
    process.exit(1);
  }
  const playerCount = (eog.teams || []).flatMap((t) => t.players || []).length;
  log(`读取离线样例：${playerCount} 名玩家 / EOG 事件 ${(eog.events || []).length} 条 / 时长 ${toClock(eog.gameLength)}`);
  log(`补充数据：match-detail ${sample.matchDetail ? '✓' : '✗'}　timeline ${sample.timeline ? '✓' : '✗'}　session ${sample.session ? '✓' : '✗'}`);

  // ── 2. 整理层（四不原则） ──
  // 样例包里没有装备 / 符文原始表，用本地播种的那份（tools/seed-gamedata.mjs 产出）
  const gameData = await loadGameData(null, { cacheFile: GAMEDATA_FILE }).catch(() => null);
  log(`出装 / 符文表：${gameData?.from || 'none'}（出装 ${gameData?.count?.items ?? 0} / 符文 ${gameData?.count?.augments ?? 0}）`);
  const dataset = normalize(eog, {
    matchDetail: sample.matchDetail, timeline: sample.timeline,
    session: sample.session, championMap: sample.champions, gameData,
  });
  const t = dataset.timeline.length;
  log(`整理完成：${dataset.players.length} 人 / 时间轴 ${t} 条 / 模式 ${dataset.match.mode}(${dataset.match.queueId})`);
  log(`数据层约束：无排名 / 无均值 / 无因果 / 无关联窗口`);
  if (dataset.integrity.distinctPids !== dataset.players.length) {
    log(`⚠ pid 塌陷：${dataset.players.length} 人却只有 ${dataset.integrity.distinctPids} 个互异 pid`);
  }

  // ── 3. 隐私校验 ──
  const nameMap = buildNameMap(eog, sample.matchDetail);
  const safe = anonymize(dataset, nameMap);
  const leaked = assertNoRealNames(safe, nameMap);
  log(leaked.length ? `⚠ 检测到残留昵称：${leaked.join(', ')}` : `隐私校验通过：${Object.keys(nameMap).length} 个昵称未进入 dataset`);

  // ── 4. 提示词概览 ──
  const st = promptStatsSafe(DEFAULT_PARAMS);
  log(`提示词：${st.blocks} 个区块 / ${st.params} 个参数 / ${st.chars} 字 ≈ ${st.estTokens} tokens`);

  // ── 5. 判定 ──
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  const { result, source, errors, usage, elapsedMs } = await judge(safe, { apiKey, tone, logger: log });

  // ── 6. 还原昵称（仅本机展示） ──
  const pidToName = Object.fromEntries(Object.entries(nameMap).map(([n, pid]) => [pid, n]));
  const byPid = new Map(dataset.players.map((p) => [p.pid, p]));

  line();
  console.log(`  ${result.verdict}`);
  line();
  console.log(`  ${result.insight}`);
  line();

  console.log('\n  标签  分数  玩家                英雄         KDA         参团   每分钟伤害');
  line('-');
  for (const r of result.players) {
    const src = byPid.get(r.pid);
    const name = (deanonymizeText(r.pid, pidToName) || r.pid);
    const kda = `${src.kills}/${src.deaths}/${src.assists}`;
    console.log(
      `  ${LABEL_CN[r.label].padEnd(4, '　')} ${String(r.score).padStart(3)}   ` +
      `${name.padEnd(20, ' ')} ${src.champion.padEnd(10, '　')} ${kda.padEnd(12)} ` +
      `${String(Math.round((src.killParticipation ?? 0) * 100)).padStart(3)}%   ${String(Math.round(src.perMinute.damageDealt)).padStart(6)}`
    );
  }

  line();
  log(`判定来源：${source === 'deepseek' ? 'DeepSeek' : '本地兜底'}｜耗时 ${elapsedMs}ms｜token ${usage ? usage.total_tokens : '—'}`);
  if (errors.length) log('提示：' + errors.join(' | '));

  // ── 7. 落盘 ──
  // 文本字段先还原成昵称再写盘 —— 样例是界面离线演示直接消费的，
  // 不还原就会露出「红方p8卡尔萨斯」这种半截 pid（服务端那条路早就在还原了）
  const shownResult = restoreResultText(result, pidToName);
  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    tone,
    source,
    model: source === 'deepseek' ? 'deepseek-v4-flash' : null,
    usage,
    errors,
    elapsedMs,
    dataset,
    result: shownResult,
    names: pidToName, // 仅本机调试用，正式版不落盘
  };
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');
  log(`已写入 ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
