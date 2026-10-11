/**
 * 运行期目录 —— 开发态 / 打包态（单文件 exe）/ 桌面客户端（Electron）的唯一来源。
 *
 * 三种形态下「根目录」不是一回事：
 *   开发态     `node server/server.mjs`   → 仓库根目录（src/ 的上一层）
 *   打包态     `LOL背锅侠.exe`（SEA）      → exe 自己的所在目录，界面内嵌在 exe 里
 *   桌面客户端 `LOL背锅侠/LOL背锅侠.exe`   → exe 所在目录，界面随包放在 resources/app
 * 其余目录（data）都相对「可写根」挂，于是三态自动一致 ——
 * 这就是为什么全项目只留这一处形态判断，而不是到处写 isSea() 分支。
 *
 * 静态资源有两条路：SEA 把 web/ 整个塞进 exe、运行时 `sea.getAsset` 读；
 * Electron 客户端则直接躺在 resources/app/web 下，走普通磁盘读。
 * 对上层一律用 `readWebAsset`，不必关心走的是哪条。
 *
 * ⚠️ 往包里塞的只有「公共查表数据」（英雄表 / 出装符文表）。
 *    战报、账号、名录、查询缓存这些是本机隐私，从设计上就不进包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';

/** 跑在 Node SEA 单文件 exe 里？ */
export const IS_SEA = sea.isSea();

/** 跑在 Electron 里？（`electron .` 开发态与装好的客户端都算） */
export const IS_ELECTRON = !!process.versions.electron;

/** Electron 开发态为 true，装成客户端后为 undefined —— 这是官方给的判别开关 */
const ELECTRON_DEV = IS_ELECTRON && process.defaultApp === true;

/** 桌面客户端（Electron 打包态）：有界面外壳，但不是单文件 */
const IS_ELECTRON_APP = IS_ELECTRON && !ELECTRON_DEV;

/** 「没有仓库目录可依赖」的形态 —— 数据必须落在 exe 旁边，而不是源码旁边 */
export const IS_PACKED = IS_SEA || IS_ELECTRON_APP;

/**
 * 代码根目录（web/ 这类随包资源的位置）。
 *   开发态 / Electron 开发态 → 仓库根
 *   Electron 客户端          → resources/app
 *   SEA                     → 没有（资源内嵌在 exe 里，磁盘上不存在这个目录）
 *
 * ⚠️ 这条三元不能拆成 if：SEA 下 import.meta.url 是空的，fileURLToPath 会直接抛，
 *    全靠三元短路才躲得过去。之前踩过一次，别手滑「优化」它。
 */
export const CODE_ROOT = IS_SEA
  ? null
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可写数据根：打包态认 exe 所在目录，开发态认仓库根 */
export const ROOT = IS_PACKED ? path.dirname(process.execPath) : CODE_ROOT;

export const WEB_DIR = IS_SEA ? null : path.join(CODE_ROOT, 'web');

/**
 * 数据目录：默认就是 exe / 仓库旁边的 `data/`（绿色软件，看得见摸得着）。
 *
 * 但客户端被丢进 `C:\Program Files` 这类只读位置时，往那儿写会直接失败，
 * 于是退到用户自己的目录（`%LOCALAPPDATA%`）——不用管理员权限也照样能跑。
 * 走了退路会记在 `DATA_DIR_NOTE` 里，启动日志会明说数据落在哪，
 * 免得用户找不到自己的战绩。
 */
function pickDataDir() {
  const preferred = path.join(ROOT, 'data');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return { dir: preferred, fallback: false };
  } catch {
    const base = process.env.LOCALAPPDATA || process.env.HOME || process.env.USERPROFILE || ROOT;
    const dir = path.join(base, 'LOL背锅侠', 'data');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 再不行就只能让它报错了 */ }
    return { dir, fallback: true };
  }
}

const picked = pickDataDir();
export const DATA_DIR = picked.dir;
export const DATA_DIR_NOTE = picked.fallback
  ? `客户端所在目录不可写，数据改放 ${DATA_DIR}`
  : null;

/** exe 内嵌资源的 key —— 打包脚本按同样的规则放，两边必须一致 */
const webKey = (rel) => `web/${rel.replace(/\\/g, '/')}`;
const SEED_PREFIX = 'seed/';

/** 随包携带的种子目录（Electron 客户端）；SEA 下为空，因为它内嵌在 exe 里 */
const SEED_DIR = IS_SEA ? null : path.join(CODE_ROOT, SEED_PREFIX);

/**
 * 读一个界面静态文件，返回 Buffer；读不到给 null。
 * 打包态走 exe 内嵌资源 / 随包目录，开发态走磁盘 —— 对调用方完全一样。
 */
export function readWebAsset(rel) {
  if (IS_SEA) {
    try { return Buffer.from(sea.getAsset(webKey(rel))); } catch { return null; }
  }
  try { return fs.readFileSync(path.join(WEB_DIR, rel)); } catch { return null; }
}

/** 界面文件清单：SEA 态由 exe 自报，其余直接读目录 */
export function listWebAssets() {
  if (IS_SEA) {
    return sea.getAssetKeys()
      .filter((k) => k.startsWith('web/'))
      .map((k) => k.slice(4));
  }
  try {
    return fs.readdirSync(WEB_DIR, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch { return []; }
}

/**
 * 打包态首次运行：把包里带的种子数据解到 data/ 下。
 *
 * 只解公共查表数据（英雄表 / 出装符文表）—— 客户端没开时靠它们兜底，
 * 少了这两份，第一次启动就是「英雄名全是英文 id」。已存在的文件不覆盖，
 * 免得把用户跑出来的新缓存打回去。返回这次写了哪几个文件。
 */
export function bootstrapDataDir() {
  if (!IS_PACKED) return [];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const written = [];
  for (const [name, buf] of seedEntries()) {
    const target = path.join(DATA_DIR, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.writeFileSync(target, buf);
      written.push(name);
    } catch { /* 解不出来也不该拦着服务起不来 */ }
  }
  return written;
}

/** 种子文件清单：[文件名, 内容] —— SEA 读内嵌资源，客户端读随包目录 */
function seedEntries() {
  const out = [];
  if (IS_SEA) {
    let keys = [];
    try { keys = sea.getAssetKeys(); } catch { return out; }
    for (const key of keys) {
      if (!key.startsWith(SEED_PREFIX)) continue;
      try { out.push([key.slice(SEED_PREFIX.length), Buffer.from(sea.getAsset(key))]); } catch { /* 跳过坏条目 */ }
    }
    return out;
  }
  try {
    for (const f of fs.readdirSync(SEED_DIR, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      out.push([f.name, fs.readFileSync(path.join(SEED_DIR, f.name))]);
    }
  } catch { /* 客户端包里没带种子也不该拦着启动 */ }
  return out;
}
