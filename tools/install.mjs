/**
 * 桌面客户端安装器 —— 把 dist/LOL背锅侠 拷到正式位置，并建桌面快捷方式。
 *
 * 这是个「便携安装」：不写注册表、不申请管理员、不装运行时。
 *   装 = 复制整个客户端目录（exe 自带 Node + Chromium）
 *   卸 = 删掉那个目录 + 桌面快捷方式
 *
 * 用法：
 *   node tools/install.mjs                      装到 %LOCALAPPDATA%\Programs\LOL背锅侠
 *   node tools/install.mjs --dir=D:\LOL背锅侠    指定位置
 *   node tools/install.mjs --no-shortcut        不建快捷方式
 *   node tools/install.mjs --no-data            不迁移现有战报数据
 *   node tools/install.mjs --src=<客户端目录>    手动指定源
 *   node tools/install.mjs --start              装完直接拉起来
 *
 * 注意：Windows 上别用 fs.cpSync 拷带中文的目录（实测静默失败，不报错也不复制），
 * 所以这里走 robocopy，失败再回退到手写 copyTree。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const arg = (k) => {
  const hit = args.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};
const flag = (k) => args.includes(`--${k}`);

const log = (s) => console.log(s);

/* ---------- 定位：源客户端目录 ---------- */
function isClientDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    const files = fs.readdirSync(dir);
    return files.some((f) => f.endsWith('.exe')) && fs.existsSync(path.join(dir, 'resources', 'app'));
  } catch {
    return false;
  }
}

function findClientDir() {
  const manual = arg('src');
  if (typeof manual === 'string') {
    if (!isClientDir(manual)) throw new Error(`--src 不是客户端目录：${manual}`);
    return path.resolve(manual);
  }
  // 从脚本所在位置向外找：tools/ -> 项目根 -> dist/LOL背锅侠
  let dir = HERE;
  for (let up = 0; up < 4; up++) {
    const dist = path.join(dir, 'dist');
    if (fs.existsSync(dist)) {
      for (const name of fs.readdirSync(dist)) {
        const cand = path.join(dist, name);
        if (isClientDir(cand)) return cand;
      }
    }
    if (isClientDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('没找到打包好的客户端目录（dist/LOL背锅侠）。先跑 npm run pack:desktop');
}

/* ---------- 定位：现有战报数据 ---------- */
function looksLikeDataDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    return files.includes('config.json') || files.includes('matches.json') || files.includes('accounts.json');
  } catch {
    return false;
  }
}

function findDataDir() {
  const manual = arg('data-src');
  if (typeof manual === 'string') return path.resolve(manual);
  let dir = HERE;
  for (let up = 0; up < 4; up++) {
    const cand = path.join(dir, 'data');
    if (looksLikeDataDir(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/* ---------- 复制 ---------- */
// 这两个都在 System32 里，但 Git Bash 的 PATH 不一定带它 —— 直接拼绝对路径，
// 别指望 spawn 能在 PATH 里找到（实测 robocopy / powershell 都栽在这上面）。
const SYS = process.env.SystemRoot || 'C:\\Windows';
const ROBOCOPY = path.join(SYS, 'System32', 'robocopy.exe');
const POWERSHELL = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function robocopy(src, dst, extra = []) {
  const bin = fs.existsSync(ROBOCOPY) ? ROBOCOPY : 'robocopy';
  const r = spawnSync(
    bin,
    [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1', ...extra],
    { windowsHide: true, encoding: 'utf8' }
  );
  if (r.error) return { skipped: true, out: String(r.error) };
  // robocopy: 0-7 成功，8+ 失败
  return { ok: r.status < 8, skipped: false, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), code: r.status };
}

function copyTree(src, dst, skipTop = []) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipTop.includes(e.name.toLowerCase())) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 复制一个目录。客户端目录里的 data/ 一律不跟过去 —— 那要么是打包前的测试残留，
 * 要么是旧安装的数据；真正的迁移走下面的 copyData()，免得旧数据把新数据盖了。
 */
function copyDir(src, dst, label, extra = []) {
  log(`  复制 ${label} …`);
  const r = robocopy(src, dst, extra);
  if (r.skipped) {
    copyTree(src, dst, ['data']);
    log(`  ${label} 复制完成（回退模式）`);
    return;
  }
  if (!r.ok) throw new Error(`${label} 复制失败（robocopy ${r.code}）：\n${r.out}`);
  log(`  ${label} 复制完成`);
}

/* ---------- 快捷方式 ---------- *
 * 两条路：
 *  ① 让 PowerShell 用 WScript.Shell 建 —— 最正统，Windows 自己写的 lnk 就是这个。
 *  ② spawn 被环境挡住时（受限终端里 spawn 外部进程会 EBUSY），自己按 MS-SHLLINK
 *     拼一个 lnk 出来。中文路径必须走 Unicode 变体（LocalBasePathOffsetUnicode），
 *     否则 ANSI 字段里存不下「LOL背锅侠」这几个字。
 */
function buildLnk({ target, workDir, icon, args = '', name = '' }) {
  const u16 = (s) => {
    const b = Buffer.from(s || '', 'utf16le');
    return b;
  };
  const strData = (s) => {
    const b = u16(s);
    const head = Buffer.alloc(2);
    head.writeUInt16LE(s ? s.length : 0); // 字符数，不含结尾 null
    return Buffer.concat([head, b]);
  };

  // ── LinkInfo ──
  const volId = Buffer.alloc(0x17);
  volId.writeUInt32LE(0x17, 0); // VolumeIDSize
  volId.writeUInt32LE(3, 4); // DriveType = DRIVE_FIXED
  volId.writeUInt32LE(0, 8); // DriveSerialNumber（不校验，填 0）
  volId.writeUInt32LE(0x14, 12); // VolumeLabelOffset（ANSI）
  volId.writeUInt32LE(0x15, 16); // VolumeLabelOffsetUnicode
  // 20: ANSI label 空串，21-22: Unicode label 空串，已由 alloc 补零

  const ansiPath = Buffer.concat([Buffer.from(target, 'latin1'), Buffer.from([0])]);
  const uniPath = Buffer.concat([u16(target), Buffer.from([0, 0])]);
  const ansiSuffix = Buffer.from([0]);
  const uniSuffix = Buffer.from([0, 0]);

  const HEAD = 0x24; // 带 Unicode 偏移字段的 LinkInfo 头
  const offVol = HEAD;
  const offPath = offVol + volId.length;
  const offSuffix = offPath + ansiPath.length;
  const offPathU = offSuffix + ansiSuffix.length;
  const offSuffixU = offPathU + uniPath.length;
  const linkInfoSize = offSuffixU + uniSuffix.length;

  const li = Buffer.alloc(linkInfoSize);
  li.writeUInt32LE(linkInfoSize, 0);
  li.writeUInt32LE(HEAD, 4);
  li.writeUInt32LE(0x00000001, 8); // VolumeIDAndLocalBasePath
  li.writeUInt32LE(offVol, 12);
  li.writeUInt32LE(offPath, 16);
  li.writeUInt32LE(0, 20); // CommonNetworkRelativeLinkOffset（无）
  li.writeUInt32LE(offSuffix, 24);
  li.writeUInt32LE(offPathU, 28); // LocalBasePathOffsetUnicode
  li.writeUInt32LE(offSuffixU, 32); // CommonPathSuffixOffsetUnicode
  volId.copy(li, offVol);
  ansiPath.copy(li, offPath);
  ansiSuffix.copy(li, offSuffix);
  uniPath.copy(li, offPathU);
  uniSuffix.copy(li, offSuffixU);

  // ── StringData ──
  const strings = Buffer.concat([
    strData(name || 'LOL背锅侠'), // NAME
    strData(workDir), // WORKING_DIR
    strData(args), // COMMAND_LINE_ARGUMENTS
    strData(icon ? `${icon},0` : `${target},0`), // ICON_LOCATION
  ]);

  // ── ShellLinkHeader ──
  const FLAGS = 0x00000002 /* HasLinkInfo */ |
    0x00000004 /* HasName */ |
    0x00000010 /* HasWorkingDir */ |
    0x00000020 /* HasArguments */ |
    0x00000040 /* HasIconLocation */ |
    0x00000080; /* IsUnicode */
  const h = Buffer.alloc(0x4c);
  h.writeUInt32LE(0x4c, 0);
  Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]).copy(h, 4);
  h.writeUInt32LE(FLAGS, 0x14);
  h.writeUInt32LE(0x00000020, 0x18); // FILE_ATTRIBUTE_ARCHIVE
  h.writeUInt32LE(0, 0x38); // IconIndex
  h.writeUInt32LE(1, 0x3c); // ShowCommand = SW_SHOWNORMAL

  return Buffer.concat([h, li, strings]);
}

function writeLnkFile(lnkPath, opts) {
  fs.writeFileSync(lnkPath, buildLnk(opts));
  return lnkPath;
}

function desktopDir() {
  const home = os.homedir();
  const cands = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : null,
  ].filter(Boolean);
  return cands.find((c) => fs.existsSync(c)) || path.join(home, 'Desktop');
}

/** ① 系统方式：PowerShell + WScript.Shell */
function comShortcut(lnkPath, exePath, workDir, iconPath) {
  const ps = `$ws = New-Object -ComObject WScript.Shell
$dt = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut([IO.Path]::Combine($dt, 'LOL背锅侠.lnk'))
$lnk.TargetPath = '${exePath.replace(/'/g, "''")}'
$lnk.WorkingDirectory = '${workDir.replace(/'/g, "''")}'
$lnk.IconLocation = '${(iconPath || exePath).replace(/'/g, "''")},0'
$lnk.Description = 'LOL背锅侠 - 极地大乱斗赛后分析'
$lnk.Save()
Write-Output "OK:$([IO.Path]::Combine($dt, 'LOL背锅侠.lnk'))"`;
  const tmp = path.join(os.tmpdir(), `bbx-shortcut-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8'); // BOM：PowerShell 5.1 靠它认 UTF-8
  const bin = fs.existsSync(POWERSHELL) ? POWERSHELL : 'powershell';
  const r = spawnSync(bin, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
    windowsHide: true,
    encoding: 'utf8',
  });
  try {
    fs.unlinkSync(tmp);
  } catch {}
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const m = out.match(/OK:(.+)/);
  if (r.status !== 0 || !m) throw new Error(`建快捷方式失败：${out || r.status}`);
  return m[1].trim();
}

/** 建桌面快捷方式：系统方式不行就自己拼一个 lnk */
function makeShortcut(exePath, workDir, iconPath) {
  const opts = { target: exePath, workDir, icon: iconPath || null };
  const dt = desktopDir();
  const lnkPath = path.join(dt, 'LOL背锅侠.lnk');
  try {
    return { path: comShortcut(lnkPath, exePath, workDir, iconPath), via: '系统' };
  } catch {
    writeLnkFile(lnkPath, opts);
    return { path: lnkPath, via: '内置' };
  }
}

/* ---------- 主流程 ---------- */
const srcDir = findClientDir();
const exeName =
  fs.readdirSync(srcDir).find((f) => f.endsWith('.exe')) || 'LOL背锅侠.exe';
const defaultDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'LOL背锅侠');
const target = typeof arg('dir') === 'string' ? path.resolve(arg('dir')) : defaultDir;

if (path.resolve(srcDir) === path.resolve(target)) {
  throw new Error('源目录和目标目录是同一个，换个 --dir');
}

const dstData = path.join(target, 'data');
const shortcutOnly = flag('shortcut-only');

log('');
log('  LOL背锅侠 · 安装');
log('  ──────────────────────────────');
log(`  源   ${srcDir}`);
log(`  目标 ${target}`);
log('');

if (!shortcutOnly) {
  copyDir(srcDir, target, '客户端', ['/XD', 'data']);

  // 数据迁移：目标已有 data 就不动它（升级/重装保护）
  if (!flag('no-data')) {
    const srcData = findDataDir();
    if (srcData && path.resolve(srcData) !== path.resolve(dstData)) {
      if (fs.existsSync(dstData) && looksLikeDataDir(dstData)) {
        log(`  目标已有 data/，跳过迁移（不动已有战报）`);
      } else {
        copyDir(srcData, dstData, '战报数据');
      }
    } else {
      log('  没找到可迁移的现有数据，跳过');
    }
  } else {
    log('  跳过数据迁移（--no-data）');
  }
}

let shortcut = null;
if (!flag('no-shortcut')) {
  try {
    const ico = path.join(target, 'resources', 'app', 'icon.ico');
    shortcut = makeShortcut(path.join(target, exeName), target, fs.existsSync(ico) ? ico : null);
    log(`  桌面快捷方式 ${shortcut.path}（${shortcut.via}方式）`);
    if (shortcut.via !== '系统') {
      log('         这个 lnk 是脚本自己拼的；万一双击没反应，在资源管理器里');
      log('         重跑一次 install.bat（那次会走系统方式重建），或右键 exe → 发送到 → 桌面快捷方式');
    }
  } catch (e) {
    log(`  [警告] 快捷方式没建成：${e.message}`);
    log('         手动办法：打开程序目录，右键 LOL背锅侠.exe → 发送到 → 桌面快捷方式');
  }
}

log('');
log('  装好了。双击桌面「LOL背锅侠」即可运行。');
log(`  程序目录：${target}`);
log(`  数据目录：${dstData}（战报、账号、设置都在这，卸载前记得备份）`);
log('  以后升级：把升级包 zip 拖到程序目录里的 update.bat 上');
log('');

if (flag('start')) {
  log('  正在启动…');
  spawn(path.join(target, exeName), [], { detached: true, stdio: 'ignore', cwd: target }).unref();
}
