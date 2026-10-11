#!/usr/bin/env node
/**
 * 提示词「源文件 ↔ 界面副本」同步自检
 *
 * 背景：提示词只有一份事实来源 —— `src/deepseek/prompt.mjs`。
 * `web/prompt.js` 是 `prototype/build-mock-data.mjs` 从它生成的副本，只给
 * 界面「提示词」页做离线预览用。**改了源文件忘了跑生成脚本**，页面就会
 * 一直展示旧提示词 —— 而这事儿没有任何报错，改的人还以为生效了。
 * （本项目已经栽过一次同类的坑：render-preview 拿着内置样例兜底，
 *   链路断了却显示成功。见 .workbuddy/memory。）
 *
 * 这个脚本就是把「忘了跑生成脚本」这件事变成一个会红的东西。
 * 零依赖，只读文件。
 *
 * 用法：node tools/check-prompt-sync.mjs     （一致 exit 0；不一致 exit 1）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { BLOCKS, BLOCK_ORDER, DEFAULT_PARAMS, TONES, promptStats } from '../src/deepseek/prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = path.join(ROOT, 'web', 'prompt.js');

if (!fs.existsSync(COPY)) {
  console.error('[fail] 找不到 web/prompt.js —— 先跑：node prototype/build-mock-data.mjs');
  process.exit(1);
}

/* 在沙箱里跑一遍副本，把 window.BB_PROMPT 取出来（它是给浏览器用的） */
const ctx = { window: {} };
vm.createContext(ctx);
try {
  vm.runInContext(fs.readFileSync(COPY, 'utf8'), ctx, { filename: 'web/prompt.js' });
} catch (e) {
  console.error('[fail] web/prompt.js 执行不了：' + e.message);
  process.exit(1);
}
const copy = ctx.window.BB_PROMPT;
if (!copy) {
  console.error('[fail] web/prompt.js 里没有 window.BB_PROMPT');
  process.exit(1);
}

/** 逐项比对，报出第一处不一致就够定位了 */
const problems = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cmp = (name, expect, got, hint) => {
  if (same(expect, got)) { console.log(`[ok]   ${name}`); return; }
  problems.push(name);
  console.error(`[diff] ${name} 不一致${hint ? `（${hint}）` : ''}`);
};

cmp('区块内容 blocks', BLOCKS, copy.blocks);
cmp('区块顺序 order', BLOCK_ORDER, copy.order);
cmp('参数 params', DEFAULT_PARAMS, copy.params);
cmp('语气 tones', TONES, copy.tones);
cmp('统计 stats', promptStats(DEFAULT_PARAMS), copy.stats);

if (problems.length) {
  console.error('');
  console.error(`提示词副本已过期（${problems.join(' / ')}）。`);
  console.error('跑一下生成脚本即可：node prototype/build-mock-data.mjs');
  process.exit(1);
}
// 参数个数从源里数，不写死 —— 加一个 DEFAULT_PARAMS 条目时这条不该跟着改
console.log(`[ok] web/prompt.js 与 src/deepseek/prompt.mjs 一致（${BLOCK_ORDER.length} 个 system 区块 / ${Object.keys(DEFAULT_PARAMS).length} 参数）`);
