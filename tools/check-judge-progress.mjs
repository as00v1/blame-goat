/**
 * 判定过程回调自检 —— 对应「界面要显示模型思考过程」这件事。
 *
 * 为什么单列一条：判定十几秒起步，界面那段「正在生成战报」原本是纯假动画，
 * 用户分不清「模型在写」和「已经卡死」，也不知道最后为什么走了本地兜底。
 * 现在 judge() 通过 onProgress 把阶段推出来（服务端转 SSE，界面显示真进度）。
 * 这条链路**只有跑起来才验得到** —— 看代码看不出阶段有没有真的发出去。
 *
 * 只跑**不花钱**的那几条路：
 *   ① 没 Key      → prepare → fallback（reason = 未提供 API Key）
 *   ② Key 无效    → prepare → submit → fallback（reason = HTTP 401…）
 * 流式那条（wait → stream → done）要真调模型，每次几厘钱，不放在常规自检里 ——
 * 真机验过即可（见 docs/DEVNOTES.md）。
 *
 * 用法：node tools/check-judge-progress.mjs
 */
import { judge, JUDGE_PHASES } from '../src/deepseek/judge.mjs';

const fail = [];
const ok = (cond, label, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail.push(label);
};

/** 最小可用数据集 —— 只要能走完 fallbackJudge，字段给到它读的那几个就够 */
const dataset = {
  match: { myResult: 'LOSE', myTeamId: 100, mode: '海克斯大乱斗' },
  players: [1, 2].map((i) => ({
    pid: 'p' + i,
    champion: '测试英雄' + i,
    championType: i === 1 ? 'TANK' : 'MAGE',
    kills: 3 * i, deaths: 8 + i, assists: 4 * i,
    killParticipation: 0.6,
    perMinute: { damageDealt: 1500 + i * 300 },
    isMyTeam: i === 1,
    augments: [], items: [],
  })),
};

const PHASE_SET = new Set(JUDGE_PHASES);
const checkShape = (list, label) => {
  ok(list.every((p) => PHASE_SET.has(p.phase)),
    `${label}：阶段字面量都在 JUDGE_PHASES 里`,
    `（${[...new Set(list.map((p) => p.phase))].join(' → ')}）`);
  ok(list.every((p) => typeof p.elapsedMs === 'number'),
    `${label}：每条都带 elapsedMs（界面靠它走秒）`);
};

console.log('');
console.log('  ============================================');
console.log('   判定过程回调自检（onProgress）');
console.log('  ============================================');
console.log('');

/* ── ① 没 Key ── */
const noKey = [];
const r1 = await judge(dataset, { apiKey: null, onProgress: (p) => noKey.push(p) });
ok(r1.source === 'fallback', '没 Key → 走本地兜底', `（source=${r1.source}）`);
ok(noKey[0]?.phase === 'prepare', '没 Key：第一条是 prepare', `（${noKey[0]?.phase}）`);
ok(noKey.some((p) => p.phase === 'fallback' && !!p.reason),
  '没 Key：收尾是 fallback 且带原因', `（${noKey.at(-1)?.reason || '—'}）`);
checkShape(noKey, '没 Key');

/* ── ② Key 无效 —— 网关会直接拒，不产生费用 ── */
const badKey = [];
const r2 = await judge(dataset, { apiKey: 'sk-selftest-invalid-key', onProgress: (p) => badKey.push(p) });
ok(r2.source === 'fallback', 'Key 无效 → 走本地兜底', `（source=${r2.source}）`);
ok(badKey.some((p) => p.phase === 'submit'), 'Key 无效：提交前会报 submit（界面据此显示「已提交」）');
ok(badKey.some((p) => p.phase === 'fallback' && /HTTP \d+/.test(p.reason || '')),
  'Key 无效：兜底原因写清了 HTTP 状态码', `（${badKey.at(-1)?.reason?.slice(0, 40) || '—'}…）`);
checkShape(badKey, 'Key 无效');

/* ── ③ 回调可选 —— 老调用方不传也不能炸 ── */
const r3 = await judge(dataset, { apiKey: null });
ok(r3.ok === true, '不传 onProgress 也能正常判定（向后兼容）');

console.log('');
if (fail.length) {
  console.log(`  结果：✗ ${fail.length} 项未通过 —— ${fail.join(' / ')}`);
  console.log('');
  process.exit(1);
}
console.log('  结果：✓ 判定过程会按阶段外抛，兜底也带原因');
console.log('');
process.exit(0);
