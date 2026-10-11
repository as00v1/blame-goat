/**
 * 离线播种 data/gamedata.json —— 出装 / 强化符文的 id → 名称 + 图标
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 为什么要这个脚本：                                               │
 * │                                                                │
 * │   运行时的 gamedata.mjs 只认两条路：LCU 直读、本地缓存。          │
 * │   但「客户端没开」是常态 —— 那时候连一张符文表都建不出来，        │
 * │   界面上就只能显示一串 id。所以这里提供一个离线播种入口。         │
 * │                                                                │
 * │   数据源是 CommunityDragon 的 `rcp-be-lol-game-data` 镜像 ——     │
 * │   它镜的就是 LCU 那几个 assets 目录，路径结构逐级对应：           │
 * │     CDN  /plugins/rcp-be-lol-game-data/global/zh_cn/v1/x.json   │
 * │     LCU  /lol-game-data/assets/v1/x.json                        │
 * │   取 zh_cn 而非 default，否则拿到的是英文名。                    │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 用法：
 *   node tools/seed-gamedata.mjs                    # 从 CDN 拉
 *   node tools/seed-gamedata.mjs --dir=.tmp-gamedata # 用已下好的原始 json（离线重跑）
 *
 * ⚠️ 这是一次性 / 偶尔才跑的工具，不在服务启动链路上 ——
 *    运行时永远优先读 LCU，其次读本脚本产出的缓存。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameData } from '../src/lcu/gamedata.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'gamedata.json');

const BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_cn/v1';
const SOURCES = {
  items: { url: `${BASE}/items.json`, file: 'items.json' },
  augments: { url: `${BASE}/cherry-augments.json`, file: 'cherry-augments.json' },
};

const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const localDir = dirArg ? path.resolve(ROOT, dirArg.slice('--dir='.length)) : null;

async function readOne(key) {
  const spec = SOURCES[key];
  // 1. 指定了本地目录 → 直接读盘（网络差时重跑用）
  if (localDir) {
    const p = path.join(localDir, spec.file);
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log(`  ${key.padEnd(8)} ← 本地 ${path.relative(ROOT, p)}（${raw.length} 条）`);
      return raw;
    } catch (e) {
      console.log(`  ${key.padEnd(8)} ← 本地读取失败（${e.message}），改走网络`);
    }
  }
  // 2. 从 CDN 拉。本机国际带宽差，实测单文件 20~90s，故给足超时
  const t0 = Date.now();
  const r = await fetch(spec.url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${spec.url} → HTTP ${r.status}`);
  const raw = await r.json();
  console.log(`  ${key.padEnd(8)} ← CDN（${raw.length} 条，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return raw;
}

console.log('播种出装 / 强化符文表…');
const [itemsRaw, augmentsRaw] = await Promise.all([readOne('items'), readOne('augments')]);

const built = buildGameData(itemsRaw, augmentsRaw);
console.log(`  出装 ${built.count.items} 条 / 符文 ${built.count.augments} 条`);

// 抽样自检：这几条是 2026-10-10 真机那一局里出现的符文，名字对不上说明取错了语言
const PROBE = [1356, 1336, 1062, 1333];
const probe = PROBE.map((id) => `${id}=${built.augments[id]?.name || '(缺)'}`);
console.log('  抽样自检：', probe.join('  '));
if (PROBE.some((id) => !built.augments[id])) {
  console.error('✗ 抽样符文缺失 —— 数据源可能不是 zh_cn 或版本不匹配');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  at: Date.now(),
  source: localDir ? `local:${path.basename(localDir)}` : 'communitydragon zh_cn',
  ...built,
}), 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`✓ 已写入 ${path.relative(ROOT, OUT)}（${kb} KB）`);
