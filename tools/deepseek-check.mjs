/**
 * DeepSeek 连通性自检 —— check.bat 调用
 * 无 Key 时返回 401 也说明网络是通的，据此区分「连不上」和「没配 Key」。
 *
 * 除连通性之外还验一件事：**默认模型 id 还在不在模型清单里**。
 * 模型名一改（下架 / 改名），判定会静默降级成本地兜底 —— 界面上看着照样出战报，
 * 只是不再是模型写的。那种失败最不容易被发现，所以在这里明说。
 */
import { loadConfig } from '../server/service.mjs';
import { MODEL } from '../src/deepseek/judge.mjs';

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', end: '\x1b[0m' };
const cfg = loadConfig();

console.log(`  Key 来源     ${cfg.keySource ? cfg.keySource : `${C.warn}未配置${C.end}（将走本地兜底判定）`}`);
console.log(`  默认语气     ${cfg.tone}`);
console.log(`  默认模型     ${MODEL}`);

const t0 = Date.now();
try {
  const res = await fetch('https://api.deepseek.com/v1/models', {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  const ms = Date.now() - t0;

  if (res.ok) {
    console.log(`  接口连通     ${C.ok}是${C.end}（${ms}ms）· Key 有效`);
    // 模型清单：确认默认 id 还能用
    // ★ 清单里没有 ≠ 不能用：别名（如 deepseek-v4-flash 实为 deepseek-flash）不会出现在
    //   /v1/models 里，但照样能跑。所以不在清单时再发一个最小请求实测，别凭清单就判死刑 ——
    //   判错了会让人白改一遍模型 id。
    const ids = ((await res.json())?.data || []).map((m) => m.id);
    if (ids.includes(MODEL)) {
      console.log(`  模型可用     ${C.ok}是${C.end}（${MODEL} 在 ${ids.length} 个模型里）`);
      process.exit(0);
    }
    const probe = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '回复：收到' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (probe?.ok) {
      console.log(`  模型可用     ${C.ok}是${C.end}（${MODEL} 不在清单里，但实测可调用 —— 是别名）`);
      process.exit(0);
    }
    const why = probe ? `HTTP ${probe.status}` : '请求失败';
    console.log(`  模型可用     ${C.bad}否${C.end} —— ${MODEL} 不在清单（${ids.join(' / ')}）且实测 ${why}`);
    console.log(`  ${C.dim}模型 id 失效会让判定静默降级成本地兜底 —— 界面照样出战报，请改 src/deepseek/judge.mjs 的 MODEL${C.end}`);
    process.exit(1);
  }
  if (res.status === 401) {
    console.log(`  接口连通     ${C.ok}是${C.end}（${ms}ms）· 但 Key 无效或未配置`);
    process.exit(1);
  }
  console.log(`  接口连通     ${C.bad}异常 HTTP ${res.status}${C.end}（${ms}ms）`);
  process.exit(1);
} catch (e) {
  console.log(`  接口连通     ${C.bad}失败${C.end}：${e.message}`);
  console.log(`  ${C.dim}检查网络 / 代理设置；本工具在无外网时仍可走本地兜底判定${C.end}`);
  process.exit(1);
}
