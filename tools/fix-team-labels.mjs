/**
 * 历史战报清洗：把报告文字里的阵营编号翻成「我方 / 敌方」。
 *
 * v1.1.1 之前，dataset 会把 LCU 的 teamId（100 / 200）原样喂给模型，
 * 于是它照抄出「100队…200队…」这种句子 —— 系统内部编号，人看着莫名其妙。
 * 现在送模型前已经换成了 side（我方 / 敌方），但**盘里的老战报还是旧文案**，
 * 得洗一遍。判定结果本身（标签 / 分数 / 证据）一个字不动，只改叙述文字。
 *
 * 用法：
 *   node tools/fix-team-labels.mjs          真跑
 *   node tools/fix-team-labels.mjs --dry    只看会改哪些，不落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../src/env.mjs';

const DRY = process.argv.includes('--dry');
const DIR = path.join(DATA_DIR, 'reports');

/** 只认「三位数字 + 队」：伤害 100、金币 200 这类数值不动 */
function fix(text, myTeamId) {
  if (typeof text !== 'string' || !text || myTeamId == null) return text;
  return text.replace(/(\d{3})\s*队/g, (whole, num) => {
    const n = Number(num);
    if (n !== 100 && n !== 200) return whole;
    return n === Number(myTeamId) ? '我方' : '敌方';
  });
}

if (!fs.existsSync(DIR)) {
  console.log(`没有 ${DIR}，跳过`);
  process.exit(0);
}

let scanned = 0;
let changed = 0;
let hits = 0;

for (const name of fs.readdirSync(DIR)) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(DIR, name);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.log(`  [跳过] ${name} 解析失败`);
    continue;
  }
  scanned++;
  const myTeamId = j?.dataset?.match?.myTeamId;
  const res = j?.result;
  if (myTeamId == null || !res) continue;

  let n = 0;
  const count = (a, b) => {
    if (a !== b) n++;
  };
  const touched = { ...res };

  if (typeof res.verdict === 'string') {
    const v = fix(res.verdict, myTeamId);
    count(v, res.verdict);
    touched.verdict = v;
  }
  if (typeof res.insight === 'string') {
    const v = fix(res.insight, myTeamId);
    count(v, res.insight);
    touched.insight = v;
  }
  if (res.teamInsight && typeof res.teamInsight === 'object') {
    touched.teamInsight = Object.fromEntries(
      Object.entries(res.teamInsight).map(([k, v]) => {
        const nv = fix(v, myTeamId);
        count(nv, v);
        return [k, nv];
      })
    );
  }
  if (Array.isArray(res.players)) {
    touched.players = res.players.map((p) => {
      const out = { ...p };
      if (typeof p.reason === 'string') {
        const v = fix(p.reason, myTeamId);
        count(v, p.reason);
        out.reason = v;
      }
      if (Array.isArray(p.evidence)) {
        out.evidence = p.evidence.map((e) => {
          const v = fix(e, myTeamId);
          count(v, e);
          return v;
        });
      }
      return out;
    });
  }

  if (!n) continue;
  changed++;
  hits += n;
  console.log(`  ${name}  改 ${n} 处（myTeamId=${myTeamId}）`);
  if (!DRY) {
    const bak = `${file}.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    fs.writeFileSync(file, `${JSON.stringify({ ...j, result: touched }, null, 2)}\n`, 'utf8');
  }
}

console.log(`\n扫描 ${scanned} 份，命中 ${changed} 份，共 ${hits} 处${DRY ? '（--dry，未落盘）' : ''}`);
