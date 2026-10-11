/**
 * 战报视角自检 —— 扫一遍 `data/reports/*.json`，揪出「敌我分组塌了」的战报。
 *
 * 为什么要单独守这条：战报里的「我方 / 敌方」是从 `dataset.match.myTeamId` 派生的
 * （`players[].isMyTeam = teamId === myTeamId`）。一旦 myTeamId 是 null，
 * `teamId === null` 恒为 false —— **10 个人会全部落进「敌方」列**，
 * 界面上看着就是「这一局没有敌我区分」。
 *
 * 真实触发场景：换账号之后重判**别人的老战报**。从 match-detail 合成的 EOG 没有
 * localPlayer、teams 也没有阵营标记，视角只能靠「当前登录账号在不在这局里」比对；
 * 当前账号不在局里 → 认不出 → null。
 *
 * 现在后端有两处兜底（analyzeFromEog 按归属账号反查 + 读盘时 healPerspective 自愈），
 * 这个脚本用来独立验证「盘里确实没有再塌的」。零依赖，改完数据跑一下即可。
 *
 * 用法：node tools/check-perspective.mjs
 * 退出码：0 全部正常；1 有战报分组塌了
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'reports');

let files = [];
try {
  files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
} catch {
  console.log('[skip] 还没有 data/reports/ —— 先判一局再说');
  process.exit(0);
}

const bad = [];
let checked = 0;

for (const name of files) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
  } catch {
    continue;   // 坏文件不归这里管
  }
  const ds = report?.dataset;
  if (!ds?.players?.length) continue;
  checked += 1;

  const mid = ds.match?.myTeamId ?? null;
  const ally = ds.players.filter((p) => p.isMyTeam).length;
  const enemy = ds.players.length - ally;
  const teamIds = new Set(ds.players.map((p) => p.teamId));

  // 只要「我方」是空集就说明视角没解析出来（全员归敌方）；
  // 全员都算我方通常意味着两边 teamId 一样（数据本身有问题），一并报出来。
  if (mid == null || ally === 0 || enemy === 0 || teamIds.size < 2) {
    bad.push({
      name,
      gameId: ds.match?.gameId ?? null,
      mid,
      ally,
      enemy,
      owner: report?.meta?.ownerPuuid || null,
    });
  }
}

console.log(`扫描战报    : ${checked} 份（目录共 ${files.length} 个文件）`);

if (!bad.length) {
  console.log('[ok] 每一份战报的「我方 / 敌方」都分得开');
  process.exit(0);
}

console.log(`[fail] ${bad.length} 份战报的敌我分组塌了 —— 界面上会全都显示在「敌方」列：`);
for (const b of bad) {
  console.log(`  ✗ ${b.name}  gameId=${b.gameId}  myTeamId=${b.mid}  我方 ${b.ally} 人 / 敌方 ${b.enemy} 人`
    + `  归属=${b.owner ? String(b.owner).slice(0, 8) : '未记'}`);
}
console.log('\n说明：这类战报多是「换账号后重判别人的局」时生成的。');
console.log('现在点开它就会自动补正（readMatchView → healPerspective），也可以直接「重新判定」。');
process.exit(1);
