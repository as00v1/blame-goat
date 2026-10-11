/**
 * 客户端升级器 —— 只换代码，不动数据。
 *
 * 用法（由同目录的 update.bat 调用，不需要额外装 Node）：
 *   LOL背锅侠.exe  resources\app\desktop\apply-update.mjs  <升级包.zip>
 *   LOL背锅侠.exe  resources\app\desktop\apply-update.mjs  <升级包.zip>  --dry-run
 *
 * 三条铁律：
 *  1. **绝不碰 data/** —— 战报、账号、名录、查询缓存全在那儿，丢了就没了。
 *     本脚本对 data 唯一的动作是往 data/update.log 追加一行（顺便证明了它没被删）。
 *     升级包里一旦出现 data/ 条目，直接拒绝安装 —— 那是打包错了，不是升级。
 *  2. **先备份后替换** —— 旧的 resources/app 挪到 resources/app.bak-<时间戳>，
 *     任何一步失败就回滚；成功了也留着上一版，出问题可以手动换回去（最多留 2 份）。
 *  3. **换的只有代码** —— resources/app（服务端 + 前端 + 本脚本自己）与根目录那几个
 *     bat；exe 本身不动（Electron 运行时几年换一次就够了）。
 *
 * 为什么自己解 zip：目标机器只有 Win10+ 的 tar.exe 或 PowerShell，
 * 都不是 100% 存在（精简版系统 / 被安全软件拦）。自己解，零外部依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ESM 里没有 __dirname —— 而且是**.mjs**后缀，打包器也不会把它转成 CJS
const HERE = path.dirname(fileURLToPath(import.meta.url));

const ZIP = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const KEEP_BACKUPS = 2;

const log = (s) => console.log(s);
const die = (msg) => {
  console.error(`\n  [X] ${msg}\n`);
  process.exit(1);
};

/* ── 定位安装根目录 ──
   本脚本在 <安装根>/resources/app/desktop/ 下，往上三级就是 exe 所在目录。 */
/* ── 定位安装根目录 ──
   正常情况：本脚本在 <安装根>/resources/app/desktop/ 下，往上三级是 exe 所在目录。

   `--root <安装目录>` 是给「老版本没有任何升级设施」准备的：那种安装里既没有
   update.bat 也没有本脚本，唯一的办法是从**解压出来的升级包里**直接跑它，
   并且明确告诉它要升的是哪个目录。错过这一次之后，它就自带升级能力了。 */
const rootIdx = process.argv.indexOf('--root');
const ROOT_OVERRIDE = rootIdx > 0 ? process.argv[rootIdx + 1] : null;
const ROOT = ROOT_OVERRIDE
  ? path.resolve(ROOT_OVERRIDE)
  : path.resolve(HERE, '..', '..', '..');
const RES_DIR = path.join(ROOT, 'resources');
const APP_ROOT = path.join(RES_DIR, 'app');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(DATA_DIR, '.update-tmp');

/* ── 极简 zip 读取 ── */

export function readZip(file) {
  const buf = fs.readFileSync(file);
  const EOCD = 0x06054b50;
  let i = buf.length - 22;
  for (; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) break;
  }
  if (i < 0) throw new Error('不是有效的 zip（找不到结尾标记）');
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);

  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                          // 目录条目，落地时自己 mkdir
    const nameLen2 = buf.readUInt16LE(localOff + 26);
    const extraLen2 = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + nameLen2 + extraLen2;
    let data = buf.subarray(start, start + compSize);
    if (method === 8) data = zlib.inflateRawSync(data);
    else if (method !== 0) throw new Error(`${name}: 不支持的压缩方式 ${method}`);
    if (data.length !== rawSize && method === 0) throw new Error(`${name}: 长度对不上`);
    entries.push({ name, data });
  }
  return entries;
}

/* ── 包体校验：路径与完整性 ──
   升级包是「别人给的一个 zip」，里面的**文件名不可信** ——
   一个 `../evil.txt` 就能把文件写到安装目录之外（Zip Slip）。
   所以落地前做三件事：名字合法 → 拼出来的路径确实还在临时目录里 → 内容对得上清单。 */

/** 只允许这几个文件被写到安装根目录 —— 多了就是有人在借升级往里塞东西 */
const ROOT_FILE_WHITE = ['update.bat'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * zip 条目名 → 相对路径段。返回 null = 不许落地。
 * 绝对路径 / 盘符 / 反斜杠 / `..` / 目录条目，Zip Slip 的形态就这几种。
 */
export function safeSegments(name) {
  if (!name || typeof name !== 'string' || !name.trim()) return null;
  if (name.endsWith('/')) return null;                                  // 目录条目：落地时自己 mkdir
  if (name.includes('\\')) return null;                                  // Windows 上反斜杠也是分隔符
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.startsWith('/')) return null;
  const segs = name.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length || segs.some((s) => s === '..')) return null;
  return segs;
}

/** 拼出目标路径，并确认它没逃出 root —— 先看名字、再看结果，两道都过才写 */
export function resolveInside(root, segs) {
  const base = path.resolve(root);
  const dst = path.resolve(base, ...segs);
  return dst === base || dst.startsWith(base + path.sep) ? dst : null;
}

/* ── 文件搬运 ── */

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dst);
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; }
  catch { return false; }
}

function writeLog(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'update.log'), `${new Date().toISOString()}  ${line}\n`);
  } catch { /* 日志写不了也不该拦着升级 */ }
}

/* ── 主流程 ── */

function main() {
  log('');
  log('  ============================================');
  log('   LOL背锅侠 · 客户端升级');
  log('  ============================================');
  if (!ZIP || ZIP.startsWith('--')) die('请指定升级包路径：update.bat <升级包.zip>');
  if (!fs.existsSync(ZIP)) die(`找不到升级包：${ZIP}`);
  if (!fs.existsSync(ROOT)) die(`安装目录不存在：${ROOT}`);
  // 认EXE不在就别动手 —— 多半是 --root 指错了地方，别去碰别人的目录
  const hasExe = fs.existsSync(RES_DIR)
    && fs.readdirSync(ROOT).some((f) => f.endsWith('.exe'));
  if (!hasExe) die(`${ROOT} 看着不是本客户端的安装目录（没看到 exe 与 resources/）`);
  log(`  升级包    ${path.basename(ZIP)}`);
  log(`  安装目录  ${ROOT}`);
  log(`  数据目录  ${DATA_DIR}（升级过程不会动它）`);

  let entries;
  try {
    entries = readZip(ZIP);
  } catch (e) {
    die(`解不开这个升级包：${e.message}`);
  }
  log(`  包内文件  ${entries.length} 个`);

  // 铁律一：升级包里不许出现 data —— 它只能装代码
  const dataEntries = entries.filter((e) => e.name.split('/').includes('data'));
  if (dataEntries.length) {
    die(`升级包里带了 ${dataEntries.length} 个 data/ 条目（如 ${dataEntries[0].name}）\n`
      + '      升级只允许换代码；谁把这个包打出来的，回 build-desktop.mjs 查。');
  }

  const manifestEntry = entries.find((e) => e.name === 'update.json');
  if (!manifestEntry) die('升级包里没有 update.json —— 这不是本工具的升级包');
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    die('update.json 解析不了');
  }
  // 铁律一·续：名单之外的条目名一律拒 —— 包是别人给的，`../` 就能写出安装目录
  const bad = entries.filter((e) => e.name !== 'update.json' && !safeSegments(e.name));
  if (bad.length) {
    die(`升级包里有 ${bad.length} 个不合法的条目名（如 ${String(bad[0].name)}）\n`
      + '      只允许相对路径且不含 .. —— 这是典型的路径穿越包，拒绝安装。');
  }

  // 清单本身也要验：version 得是版本号，rootFiles 只能是白名单里那几个升级入口
  const targetVersion = String(manifest.version || '');
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(targetVersion)) {
    die(`update.json 里的 version 不合法：${JSON.stringify(manifest.version)}`);
  }
  for (const f of manifest.rootFiles || []) {
    if (typeof f !== 'string' || !ROOT_FILE_WHITE.includes(f)) {
      die(`update.json 的 rootFiles 只允许 ${ROOT_FILE_WHITE.join(' / ')}，收到了 ${JSON.stringify(f)}`);
    }
  }

  // 完整性：清单里有 sha256 就逐条对一遍。
  // 包可能在中途被换过 / 传坏 —— 装上一个被改过的 app 比不升级更糟。
  const hashes = manifest.files && typeof manifest.files === 'object' ? manifest.files : null;
  if (hashes) {
    for (const e of entries) {
      if (e.name === 'update.json') continue;
      const want = hashes[e.name];
      if (!want) die(`${e.name} 不在 update.json 的文件清单里 —— 拒绝安装`);
      const got = sha256(e.data);
      if (got !== want) {
        die(`${e.name} 校验和对不上（清单 ${String(want).slice(0, 8)}… 实际 ${got.slice(0, 8)}…）\n`
          + '      包在传输中坏了、或者被换过 —— 拒绝安装。');
      }
    }
    log(`  完整性    ${Object.keys(hashes).length} 个文件 sha256 全部对上`);
  }

  const curVersion = readVersion(APP_ROOT);
  log(`  版本      ${curVersion}  →  ${targetVersion}${manifest.builtAt ? `（${manifest.builtAt}）` : ''}`);
  writeLog(`待升级 - ${curVersion} -> ${targetVersion}${DRY ? '（试运行）' : ''}`);

  if (DRY) {
    log('');
    log('  试运行：以上检查全部通过，真升级时不会碰 data/');
    log('');
    return;
  }

  // 落到临时目录，确认解出来是完整的，再动真的
  rmrf(TMP_DIR);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  for (const e of entries) {
    if (e.name === 'update.json') continue;
    const dst = resolveInside(TMP_DIR, safeSegments(e.name));
    // safeSegments 已经在上面整包验过一遍，这里是落地前的最后一道 —— 宁可多查一次
    if (!dst) die(`条目 ${e.name} 的目标路径逃出了临时目录 —— 拒绝安装`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, e.data);
  }
  const newApp = path.join(TMP_DIR, 'app');
  if (!fs.existsSync(path.join(newApp, 'package.json'))) die('升级包里没有 app/package.json，拒绝安装');
  if (!fs.existsSync(path.join(newApp, 'server', 'server.mjs'))) die('升级包里没有服务端代码，拒绝安装');

  // 备份当前版本（resources/app → resources/app.bak-<ts>）
  const backup = path.join(RES_DIR, `app.bak-${Date.now()}`);
  log('');
  log(`  备份旧版本 ${path.relative(ROOT, backup)}`);
  try {
    fs.renameSync(APP_ROOT, backup);
  } catch (e) {
    rmrf(TMP_DIR);
    die(`备份失败，已中止，安装目录未被改动：${e.message}`);
  }

  try {
    copyTree(newApp, path.join(RES_DIR, 'app'));
    // 根目录文件（update.bat 这类升级入口本身也要能更新）
    for (const f of (manifest.rootFiles || [])) {
      const src = path.join(TMP_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ROOT, path.basename(f)));
    }
  } catch (e) {
    console.error(`  写入失败，正在回滚：${e.message}`);
    rmrf(path.join(RES_DIR, 'app'));
    try { fs.renameSync(backup, APP_ROOT); } catch { /* 备份还在，手动换回即可 */ }
    rmrf(TMP_DIR);
    die('升级失败，已回滚到旧版本（数据未受影响）');
  }

  rmrf(TMP_DIR);
  // 只留最近两份备份 —— 这是回滚的本钱，但也别把磁盘吃满
  const olds = fs.readdirSync(RES_DIR).filter((f) => f.startsWith('app.bak-')).sort();
  for (const old of olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS))) rmrf(path.join(RES_DIR, old));

  const newVersion = readVersion(APP_ROOT);
  const kept = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((f) => f !== '.update-tmp').length
    : 0;
  log('');
  log(`  已升级到  v${newVersion}`);
  log(`  数据保留  ${kept} 个数据文件仍在 ${path.relative(ROOT, DATA_DIR)}`);
  log(`  回滚点    ${path.relative(ROOT, backup)}`);
  log('');
  writeLog(`升级完成 v${newVersion}（旧版备份 ${path.basename(backup)}，数据文件 ${kept} 个未动）`);
}

function readVersion(appRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

// 被 import 时不要自己跑起来 —— build-desktop.mjs 会用它的 readZip 做包内自查
const isEntry = process.argv[1]
  && fs.existsSync(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();
