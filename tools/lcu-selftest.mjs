/**
 * LCU 环境自检 CLI —— check.bat 调用
 * 用法：node tools/lcu-selftest.mjs
 */
import { selfTest, candidateLockfiles } from '../src/lcu/client.mjs';

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', end: '\x1b[0m' };
const line = (k, v) => console.log(`  ${k.padEnd(14)} ${v}`);

console.log('\n========= LCU 环境自检 =========\n');

const candidates = candidateLockfiles();
console.log(`[候选 lockfile] 共 ${candidates.length} 个`);
for (const p of candidates) console.log(`  ${C.dim}${p}${C.end}`);
if (!candidates.length) {
  console.log(`  ${C.bad}（无）${C.end}`);
}

const r = await selfTest();
console.log('\n[自检结果]');
line('系统', r.platform);
line('Node', r.node);
line('已安装', r.installed ? `${C.ok}是${C.end}` : `${C.bad}否${C.end}`);
line('客户端在跑', r.running ? `${C.ok}是${C.end}` : `${C.warn}否${C.end}`);
line('接口可应答', r.responsive ? `${C.ok}是${C.end}` : `${C.warn}否${C.end}`);
line('当前阶段', r.phase ?? '-');
line('登录账号', r.summoner ? `${r.summoner.displayName} (Lv.${r.summoner.summonerLevel})` : '-');

if (r.error) console.log(`\n${C.warn}[提示] ${r.error}${C.end}`);
console.log(`\n完成时间：${new Date().toLocaleString('zh-CN')}\n`);
process.exit(r.error ? 1 : 0);
