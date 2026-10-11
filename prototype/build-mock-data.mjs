#!/usr/bin/env node
/**
 * 从管线产出生成界面离线兜底数据
 *   prototype/output/judge-report.json  →  web/data.js
 *   src/deepseek/prompt.mjs             →  web/prompt.js
 *
 * 界面联机时数据来自 /api/*；这两个文件只用于「直接双击 index.html」的离线演示。
 *
 * ★ dataset 与 result 都直接取管线真实产出，不做任何美化替换。
 *   早先这里挂过一份手写的「演示 result」—— 它是按峡谷剧本编的
 *   （引用布里茨 / 莫甘娜 / 00:42 一血 / 13:42 收尾），
 *   而 dataset 早已换成真机大乱斗数据（29:10 / 191 条事件 / 完全不同的英雄），
 *   两者自相矛盾：界面上写着「10:50 团灭」，时间轴里根本没有这一条。
 *   宁可演示效果朴素，也不要假数据。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLOCKS, BLOCK_ORDER, DEFAULT_PARAMS, TONES, promptStats } from '../src/deepseek/prompt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const report = JSON.parse(readFileSync(resolve(ROOT, 'prototype/output/judge-report.json'), 'utf8'));

const payload = {
  meta: {
    generatedAt: report.generatedAt,
    source: '真机样例 · 离线演示',
    datasetFrom: 'prototype/sample/（eog + match-detail + timeline，来自真机抓取脱敏）',
    resultFrom: report.source === 'deepseek' ? 'DeepSeek 判定' : '本地兜底判定',
    note: 'dataset 与 result 均为管线真实产出；玩家身份已替换为「路人甲…路人癸」。',
  },
  dataset: report.dataset,
  result: report.result,
  names: report.names,
};

const out = `/* 自动生成，请勿手改 —— 由 prototype/build-mock-data.mjs 产出 */
/* dataset 与 result 均来自管线真实输出（离线样例） */
window.BB = ${JSON.stringify(payload, null, 2)};
`;

writeFileSync(resolve(ROOT, 'web/data.js'), out, 'utf8');
console.log('[mock-data] 已生成 web/data.js');
console.log(`[mock-data] 玩家 ${payload.dataset.players.length} 名 / 时间轴 ${payload.dataset.timeline.length} 条 / 判定来源 ${report.source} / 标签覆盖 ${[...new Set(payload.result.players.map((p) => p.label))].join(', ')}`);

/* ── 提示词模板同步到界面（单一事实来源：src/deepseek/prompt.mjs） ── */

const PARAM_META = [
  { key: 'death_base', group: '评分骨架', label: '死亡基础分', hint: '单次死亡的扣分基数（峡谷是 6）' },
  { key: 'kp_weight', group: '评分骨架', label: '参团率权重', hint: '大乱斗全程团战，是主导维度' },
  { key: 'teflon_death_max', group: '标签阈值', label: '不粘锅·死亡上限', hint: '死亡数不超过该值才有资格' },
  { key: 'teflon_damage_min', group: '标签阈值', label: '不粘锅·伤害下限', hint: '每分钟伤害下限，按辅助线取值' },
  { key: 'carry_score_min', group: '标签阈值', label: '大腿·分数下限', hint: '低于此分不得判 CARRY（0-10 制）' },
  { key: 'blame_score_max', group: '标签阈值', label: '背锅侠·分数上限', hint: '高于此分不得判 BLAME（0-10 制）' },
  { key: 'blame_score_min', group: '标签阈值', label: '崩盘·分数上限', hint: '低于此分算崩盘，比背锅侠更差' },
  { key: 'freeloader_death_min', group: '标签阈值', label: '混子·死亡下限', hint: '既送又不参团的死亡门槛' },
  { key: 'freeloader_kp_max', group: '标签阈值', label: '混子·参团上限', hint: '参团率低于此值才算不参团' },
  { key: 'turret_outer_penalty', group: '死亡归因', label: '丢外塔罚分', hint: '大乱斗无史诗野怪，归因对象改为建筑' },
  { key: 'turret_inner_penalty', group: '死亡归因', label: '丢内塔罚分', hint: '' },
  { key: 'inhibitor_penalty', group: '死亡归因', label: '丢兵营罚分', hint: '' },
  { key: 'ace_penalty', group: '死亡归因', label: '团灭罚分', hint: '' },
  { key: 'duration_min_minutes', group: '模式常识', label: '对局时长下限', hint: '用于模式常识声明，避免跨模式误判' },
  { key: 'duration_max_minutes', group: '模式常识', label: '对局时长上限', hint: '' },
];

const BLOCK_META = [
  { key: 'data_note', name: '数据说明', note: '置首位，声明无排名 / 无均值 / 无因果' },
  { key: 'mode_context', name: '模式常识', note: '10 条大乱斗常识，防跨模式误判（含随机海克斯、阵亡时刻）' },
  { key: 'scoring', name: '评分维度', note: 'PART / SURV / CONTRIB / RISK 四维' },
  { key: 'evaluation', name: '多维分析要求', note: '阵容 / 海克斯 / 出装 / 三者联动，各成一团队结论（v3.0）' },
  { key: 'labels', name: '标签定义', note: 'CARRY / BLAME / TEFLON / FREELOADER / NORMAL' },
  { key: 'constraints', name: '硬性约束', note: '11 条：不得编造 / 不得排名 / 随机结果不计 risk / 阵容只进团队层' },
  { key: 'output_format', name: '输出格式', note: 'JSON schema（insight 四层 300-400 字 + teamInsight 三条）' },
  { key: 'insight_rule', name: '局势分析要求', note: '阵容 → 海克斯 → 出装 → 节奏四层；因果落到具体时间点' },
  { key: 'cast_rule', name: '播报稿要求', note: 'cast.lines：给 TTS 念的口播稿，句句不同、只讲本局真事' },
  { key: 'user_template', name: 'user 消息模板', note: '{{tone}} / {{dataset}} 运行时变量' },
];

const promptJs = `/* 自动生成，请勿手改 —— 由 prototype/build-mock-data.mjs 从 src/deepseek/prompt.mjs 同步 */
window.BB_PROMPT = {
  blocks: ${JSON.stringify(BLOCKS, null, 2)},
  params: ${JSON.stringify(DEFAULT_PARAMS, null, 2)},
  paramMeta: ${JSON.stringify(PARAM_META, null, 2)},
  blockMeta: ${JSON.stringify(BLOCK_META, null, 2)},
  tones: ${JSON.stringify(TONES, null, 2)},
  order: ${JSON.stringify(BLOCK_ORDER)},
  stats: ${JSON.stringify(promptStats(DEFAULT_PARAMS), null, 2)}
};
`;
writeFileSync(resolve(ROOT, 'web/prompt.js'), promptJs, 'utf8');
console.log(`[mock-data] 已生成 web/prompt.js（${PARAM_META.length} 参数 / ${BLOCK_META.length} 区块）`);
