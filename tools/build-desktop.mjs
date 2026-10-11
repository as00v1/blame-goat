/**
 * 打包桌面客户端 —— Electron 便携版
 *
 * **这是唯一的打包路线。** 曾经还有一条 `build-exe.mjs`（SEA 单文件 exe，起服务 +
 * 喊系统浏览器当界面），v1.1.1 起应大哥要求下线：只发客户端版 ——
 * 页面装在自己窗口里才是「客户端」，那条路留着只会让发版时多一个要解释的选择。
 *
 * 为什么不去装 electron-builder / @electron/packager：
 *   本工具运行期零依赖，构建期也不想被一串 npm 依赖绑住 —— 那套东西最终也就是
 *   「下个官方 zip → 解开 → 放 app 进去 → 改图标」，四步我这儿写清楚，还省得
 *   为了装它们去解决 npm 的老毛病。
 *
 * 用法：
 *   node tools/build-desktop.mjs            完整打包（含 zip 压缩包）
 *   node tools/build-desktop.mjs --no-zip   不生成压缩包，出包更快
 *   node tools/build-desktop.mjs --dev      不打包，直接用缓存里的 Electron 跑仓库
 *   node tools/build-desktop.mjs --update   只打「升级包」（见下）
 *
 * 产物：dist/LOL背锅侠/  （整个目录拷走即可，目标机器不用装任何东西）
 *
 * ── 升级 ──
 * 客户端升级是「换代码、留数据」：`--update` 产出的 zip 里只有 resources/app 那套代码
 * 加根目录的 update.bat，**不含任何 data**。用户把它拖到 update.bat 上就完成升级，
 * 年由 desktop/apply-update.mjs 执行：先备份旧代码到 resources/app.bak-<时间戳>，
 * 失败自动回滚，data/ 全程不被读取以外的任何方式触碰。
 * 240MB 的运行时（Electron）不跟着每次升级走 —— 那是几年才需要更新一次的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { readZip } from '../desktop/apply-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.cache');
const APP_NAME = 'LOL背锅侠';
/** 交付目录（中文名，用户看得懂） */
const OUT_DIR = path.join(DIST, APP_NAME);
/**
 * 组装用的工作目录 —— 刻意用纯 ASCII 名。
 *
 * 中文路径在这条链路上踩过两次：`fs.cpSync` 会静默不复制（见 copyTree 注释），
 * bsdtar 拿 Windows 命令行里的中文也会闹出乱码目录（实测在 dist/ 下留过一个
 * `LOL鑳岄攨渚燶resources`）。构建全程待在 `.build/` 里，最后一步改名归位 ——
 * 改名走的是 Node 自己的 UTF-16 路径，不吃这些亏。顺带好处：中间产物不叫交付名，
 * 不会让人在构建到一半时以为包已经好了。
 */
const BUILD_DIR = path.join(DIST, '.build');
/** 挪走旧产物的中转站：改名是 O(1)，而这台机器上真删会中途被拦（见 setAside） */
const TRASH_DIR = path.join(DIST, '.trash');

const ELECTRON_VERSION = '44.7.0';
const ELECTRON_ZIP = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const ELECTRON_URL = `https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VERSION}/${ELECTRON_ZIP}`;
const ELECTRON_SHASUMS_URL = `https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VERSION}/SHASUMS256.txt`;
const RCEDIT_URL = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';

const args = process.argv.slice(2);
const DEV = args.includes('--dev');
const ZIP = !args.includes('--no-zip');
/** 只打升级包（不重打 240MB 运行时） */
const UPDATE_ONLY = args.includes('--update');

const log = (...a) => console.log('  ', ...a);
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 拉起 Electron 时用的环境变量。
 *
 * 两个必须摘掉，都是这台开发机的环境带进来的：
 *   ELECTRON_RUN_AS_NODE=1 —— Electron 一见它就把自己当纯 Node 跑，连 resources/app 都不加载，
 *     直接挂在那儿等 stdin。现象极具误导性：进程活着（不崩、不退）、没有窗口、一行日志都没有，
 *     截图永远拿不到。**必须 delete，设成空串没用**（Electron 只看这个键在不在）。
 *   NODE_OPTIONS —— packaged app 不支持其中大部分选项，只会让 Electron 每天打一行 ERROR。
 * 用户机器上不会有这俩，但自检得能在任何环境跑通。
 */
function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

/** Windows 自带的 curl / tar —— 用绝对路径，免得被 Git Bash 里那套 GNU 工具抢了先 */
const SYS = process.env.SystemRoot || 'C:\\Windows';
const CURL = path.join(SYS, 'System32', 'curl.exe');
const TAR = path.join(SYS, 'System32', 'tar.exe');

/* ── 文件操作的两个替代实现：都不用 fs.cpSync / fs.rmSync 的便利版 ── */

/**
 * 递归复制目录 —— 故意不用 `fs.cpSync`。
 *
 * 踩过的坑：这台开发机上注入的 node-language-shim 会接管 `fs.cpSync`，
 * 一旦目标路径带非 ASCII（我们的产物偏偏叫 `dist/LOL背锅侠/`）就**静默什么都不做**：
 * 不抛错、不复制、脚本照常往下跑，最后打出一个只有 package.json 的空客户端，
 * 而且冒烟步骤还查不出原因（Electron 找不到 main 直接退出，连日志都不留）。
 * 换成 mkdir / readdir / copyFile 三个基础调用，实测在受限环境和普通环境都稳。
 */
function copyTree(src, dest, opts = {}) {
  const { skip = () => false } = opts;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d, opts);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * 把目录挪进垃圾站。**不做原地递归删除。**
 *
 * 为什么：这台环境对「一个回合里删太多文件」有保护，删到第 50 个就抛错 ——
 * 而构建目录动辄几千个文件，注定删不完。半删状态比不删更糟：剩下的文件会让下一轮
 * 打包拿到一半旧一半新的目录。改名是 O(1)，新目录照常建，旧的整体挪走。
 * 实测教训：第一版用「删不掉就改名」兜底，结果每打一次包就在 dist/ 里留一个
 * 322MB 的 `LOL背锅侠.old-*`，连打四次堆了 1.3GB。
 */
function setAside(dir) {
  if (!fs.existsSync(dir)) return null;
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const trash = path.join(TRASH_DIR, `${path.basename(dir)}.${Date.now()}`);
  try {
    fs.renameSync(dir, trash);
  } catch (e) {
    console.error(`  [!] ${dir} 挪不走：${e.message}`);
    process.exit(1);
  }
  return trash;
}

/** 清空构建目录：挪走旧的，建个新的 —— 不碰删除 */
function resetDir(dir) {
  setAside(dir);
  fs.mkdirSync(dir, { recursive: true });
}

/** 顺手清垃圾：删得掉就删，删不掉留给下一轮（每轮配额是新的，通常能清干净） */
function sweepTrash() {
  if (!fs.existsSync(TRASH_DIR)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(TRASH_DIR, { withFileTypes: true })) {
    try {
      fs.rmSync(path.join(TRASH_DIR, e.name), { recursive: true, force: true });
      n += 1;
    } catch { /* 下一轮再说 */ }
  }
  // 腾空的垃圾站本身也别留着 —— 交付目录里不该有个叫 .trash 的空壳让人多想
  try {
    if (fs.readdirSync(TRASH_DIR).length === 0) fs.rmSync(TRASH_DIR, { force: true });
  } catch { /* 无所谓 */ }
  return n;
}

/* ── 下载（带缓存；curl 会自己认系统代理，这点比我手写 https 靠谱） ── */

function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    log(`缓存命中 ${label}（${mb(fs.statSync(dest).size)}）`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  log(`下载 ${label} … 大文件，慢的话泡杯茶`);
  const curl = fs.existsSync(CURL) ? CURL : 'curl';
  execFileSync(curl, ['-L', '--fail', '--progress-bar', '-o', part, url], {
    stdio: ['ignore', 'inherit', 'inherit'], timeout: 30 * 60 * 1000,
  });
  fs.renameSync(part, dest);
}

/* ── 1. 运行时就位 ── */

/**
 * 运行时是 240MB 的第三方二进制，下载环节被替换是最不容易察觉的一类问题
 * （包能解、能跑，只是里面多了一点东西）。镜像站提供 SHASUMS256.txt，能拿到就对一遍；
 * 拿不到（断网 / 镜像没同步）就明说没验，不假装验过。
 */
function verifyElectronZip(zip) {
  const txt = path.join(CACHE, `SHASUMS256-${ELECTRON_VERSION}.txt`);
  try {
    const curlBin = fs.existsSync(CURL) ? CURL : 'curl';
    if (!fs.existsSync(txt)) {
      execFileSync(curlBin, ['-L', '--fail', '-s', '-o', txt, ELECTRON_SHASUMS_URL], {
        stdio: ['ignore', 'ignore', 'ignore'], timeout: 60 * 1000,
      });
    }
    const line = fs.readFileSync(txt, 'utf8').split(/\r?\n/).find((l) => l.trim().endsWith(ELECTRON_ZIP));
    if (!line) { log('（镜像没给到本版本的校验和，跳过校验）'); return; }
    const want = line.trim().split(/\s+/)[0];
    const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    if (want !== got) {
      fs.rmSync(zip, { force: true });
      console.error(`  [!] Electron 运行时校验和对不上（要 ${want.slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`);
      console.error('      已删掉这份缓存 —— 请重新打包；若反复不符，别用这个镜像。');
      process.exit(1);
    }
    log(`校验和匹配 ${ELECTRON_ZIP}`);
  } catch {
    log('（拿不到官方校验和文件，本次未校验 —— 仅影响构建机自身）');
  }
}

function ensureRuntime() {
  step(1, `准备 Electron ${ELECTRON_VERSION} 运行时`);
  const zip = path.join(CACHE, ELECTRON_ZIP);
  download(ELECTRON_URL, zip, `Electron 运行时（${ELECTRON_ZIP}）`);
  verifyElectronZip(zip);
  if (!DEV) resetDir(BUILD_DIR);
  return zip;
}

/** 语言包只带这两个：界面全中文，留一份英文给系统默认语言兜底 */
const KEEP_LOCALES = ['locales/zh-CN.pak', 'locales/en-US.pak'];

/**
 * 解压运行时。
 *
 * 这里刻意用「解压时就排除」，而不是「先全解开再删掉不要的」——
 * 后者在 Windows 上很难做干净：刚解出来的上千个文件会被 Defender 实时扫描摸一遍，
 * 那期间删除会 EPERM。第一版就是这么漏下 27 个语言包（3.5MB）静静躺在包里的。
 * 不让它们落盘，也就没有「删不掉」这回事。
 */
function extractRuntime(zip) {
  step(2, '解压运行时（语言包只留 zh-CN / en-US，不带 Electron 示例应用）');
  execFileSync(TAR, [
    '-xf', zip, '-C', BUILD_DIR,
    '--exclude', 'locales/*',
    '--exclude', 'resources/default_app.asar',
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  execFileSync(TAR, ['-xf', zip, '-C', BUILD_DIR, ...KEEP_LOCALES], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const locales = fs.readdirSync(path.join(BUILD_DIR, 'locales'));
  log(`已解压到 .build/，语言包 ${locales.join(' / ')}`);
}

/* ── 3. 组装应用 ──
   产什么由入参定，内容只有一份来源 —— 完整包里的 resources/app 和升级包里的 app/
   必须是同一套东西，否则「新装」与「升级」会跑出两个版本。 */

function stageApp(appDir) {
  fs.mkdirSync(appDir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 只带运行期真正要的东西：devDependencies / scripts 进了包只会让人误以为能改
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify({
    name: 'blamebox',
    productName: 'BlameGoat',
    version: pkg.version,
    private: true,
    description: pkg.description,
    main: 'desktop/main.cjs',
    type: 'module',
  }, null, 2)}\n`, 'utf8');

  for (const d of ['desktop', 'server', 'src', 'web']) {
    copyTree(path.join(ROOT, d), path.join(appDir, d), {
      // 开发工具与加固脚本不进成品包；update.bat 另有去处（安装根目录）
      skip: (name) => name === 'make-icon.mjs' || name.endsWith('.bat'),
    });
  }
  log('desktop / server / src / web 已复制');

  // 升级器必须在包里 —— 升级包换的就是它所在的 resources/app，
  // 而 update.bat 是靠 exe 把自己当 Node 跑起来调用它的。
  if (!fs.existsSync(path.join(appDir, 'desktop', 'apply-update.mjs'))) {
    console.error('  [!] 缺 desktop/apply-update.mjs —— 升级功能会失灵');
    process.exitCode = 1;
  }

  // 种子数据：客户端没开时靠这两份兜底，让英雄名不至于显示成英文 id
  const seedDir = path.join(appDir, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  let seedN = 0;
  for (const f of ['champions.json', 'gamedata.json']) {
    const src = path.join(ROOT, 'data', f);
    if (!fs.existsSync(src)) { log(`（跳过 seed/${f} —— 本机还没有，客户端开一次就会生成）`); continue; }
    fs.copyFileSync(src, path.join(seedDir, f));
    seedN += 1;
  }
  log(`seed/ ${seedN} 个文件`);

  const size = sizeOf(appDir);
  log(`应用本体 ${(size / 1024).toFixed(0)} KB（源码 + 界面 + 种子数据）`);
}

function buildApp() {
  step(3, '组装 resources/app（服务端 + 界面 + 种子数据）');
  const appDir = path.join(BUILD_DIR, 'resources', 'app');
  resetDir(appDir);
  stageApp(appDir);
  // 升级入口放在 exe 旁边（而不是藏进 resources/app）——
  // 用户第一眼能看到它，才是真正会被用到的功能。
  const bat = path.join(ROOT, 'desktop', 'update.bat');
  if (fs.existsSync(bat)) {
    fs.copyFileSync(bat, path.join(BUILD_DIR, 'update.bat'));
    log('根目录 update.bat（升级入口）已就位');
  }
  // 安装器随包走：用户解压后双击 install.bat 就能装到正式位置（建桌面快捷方式）。
  // 放客户端目录里，是因为分发 zip 解出来的就是这个目录 —— 入口得在第一眼能看到的地方。
  for (const f of ['install.mjs', 'install.bat']) {
    const src = path.join(ROOT, 'tools', f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(BUILD_DIR, f));
    fs.copyFileSync(src, path.join(DIST, f));
  }
  log('根目录 install.bat（安装入口）已就位');
}

/* ── 升级包：只换代码，不动 data ── */

/**
 * 为什么升级要走单独的包：完整包 240MB 里绝大部分是 Electron 运行时，
 * 那是几年才动一次的东西；日常改动只有 resources/app 里那几百 KB 代码。
 * 让用户每次升级都拷 240MB，既慢又容易把 data 一起覆盖掉 —— 而 data 一旦覆盖就没了。
 */
function buildUpdateZip() {
  step('升级包', '打升级包');
  const stage = path.join(DIST, '.update-stage');
  resetDir(stage);
  stageApp(path.join(stage, 'app'));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // ★ update.bat 必须先落进 stage 再算清单。
  //   升级器的规则是「清单外的条目一律拒装」—— 顺序反了，包里明明有 update.bat，
  //   清单里却没有，用户一升级就被 `不在 update.json 的文件清单里` 挡回去，
  //   而打包脚本这边一点提示都没有（曾经就这么发出去过一版）。
  const bat = path.join(ROOT, 'desktop', 'update.bat');
  if (fs.existsSync(bat)) fs.copyFileSync(bat, path.join(stage, 'update.bat'));

  // 逐文件 sha256：升级器装之前会逐条对一遍，包在中途被换过 / 传坏了能立刻发现。
  // 键名必须等于 zip 里的条目名（相对 stage，正斜杠）。
  const files = {};
  const hashWalk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { hashWalk(path.join(dir, e.name), key); continue; }
      if (key === 'update.json') continue;
      files[key] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex');
    }
  };
  hashWalk(stage);

  const manifest = {
    app: APP_NAME,
    version: pkg.version,
    builtAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    target: 'resources/app',
    // 除了 app 之外还要覆盖到安装根目录的文件（升级入口自身也要能更新）
    rootFiles: ['update.bat'],
    // 完整性清单 —— 见 apply-update.mjs 的同名校验
    files,
    note: '本包只含应用代码；用户数据（data/）由客户端自行维护，不在此包内，也不会被覆盖。',
  };
  fs.writeFileSync(path.join(stage, 'update.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const out = path.join(DIST, `${APP_NAME}-升级包-v${pkg.version}.zip`);
  execFileSync(TAR, ['-a', '-cf', out, '-C', stage, 'update.json', 'update.bat', 'app'],
    { stdio: ['ignore', 'inherit', 'inherit'] });

  // 打包这一步最容易犯的错，就是把旁边 data/ 一起卷进来（tar 的通配符/路径写错一次就够）。
  // 与其靠自觉，不如每次打包后自查一遍 —— apply-update 那边还有第二道防线。
  // 用客户机同款 zip 读取器，不用 tar 列表：全角文件名的包会让 bsdtar 解错。
  const list = readZip(out).map((e) => e.name);
  const leaked = list.filter((n) => n.replace(/\\/g, '/').split('/').includes('data'));
  log(`${path.relative(ROOT, out)}（${mb(fs.statSync(out).size)}，${list.length} 个文件）`);
  if (leaked.length) {
    console.error(`  [!] 升级包里混进了 ${leaked.length} 个 data 条目：${leaked.slice(0, 3).join(' ')}`);
    console.error('      这会让用户的数据被覆盖 —— 必须查清楚再发出去。');
    process.exit(1);
  }
  log(`自查通过：包内 0 个 data 条目（账号 / 战报 / 名录都不会被碰）`);
  setAside(stage);
  return out;
}

/* ── 4. 改名 + 图标 ── */

function rebrand() {
  step(4, '改名 + 换图标');
  const from = path.join(BUILD_DIR, 'electron.exe');
  const to = path.join(BUILD_DIR, `${APP_NAME}.exe`);
  fs.renameSync(from, to);

  const ico = path.join(ROOT, 'desktop', 'icon.ico');
  if (!fs.existsSync(ico)) {
    log('（desktop/icon.ico 不存在 —— 先跑 node tools/make-icon.mjs）');
    return to;
  }

  let rcedit = path.join(CACHE, 'rcedit-x64.exe');
  try {
    download(RCEDIT_URL, rcedit, 'rcedit（改 exe 图标用）');
  } catch (e) {
    log(`（rcedit 下载失败，exe 文件图标保持 Electron 默认：${e.message}）`);
    return to;
  }

  const args = [
    to,
    '--set-icon', ico,
    '--set-version-string', 'FileDescription', 'LOL背锅侠 · 极地大乱斗赛后战报',
    '--set-version-string', 'ProductName', APP_NAME,
    '--set-version-string', 'CompanyName', 'BlameGoat',
    '--set-version-string', 'LegalCopyright', 'MIT License',
    '--set-file-version', version4(),
    '--set-product-version', version4(),
  ];
  // rcedit 得把这 234MB 的 exe 整个重写一遍资源段，而它刚落地就被 Defender 摸上了，
  // 写回时会直接 "Unable to commit changes"。等它扫完再来，两三次就好 ——
  // 图标只影响资源管理器里那个文件长什么样，实在改不上也不该让打包失败。
  for (let i = 0; i < 3; i += 1) {
    try {
      execFileSync(rcedit, args, { stdio: ['ignore', 'inherit', 'inherit'] });
      log('exe 图标与版本信息已写入');
      break;
    } catch (e) {
      if (i === 2) log(`（改图标失败，不影响功能：${String(e.message).split('\n')[0]}）`);
      else sleep(1200);
    }
  }
  return to;
}

/** exe 版本号要 X.X.X.X 四段，包里的 version 可能只有三段 */
function version4() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const p = String(pkg.version).split('.').slice(0, 4);
  while (p.length < 4) p.push('0');
  return p.join('.');
}

/* ── 5. 冒烟：让客户端自己截一张图 ── */

function smoke(exe) {
  step(5, '冒烟：启动客户端并截图（证明页面确实装在自己的窗口里）');
  const shot = path.join(ROOT, 'preview', 'desktop-client.png');
  // 把旧截图挪开而不是删掉：留着旧图会让「这次到底截成功没有」变成一个假命题。
  try { fs.renameSync(shot, `${shot}.old`); } catch { /* 没有旧图 */ }
  let exitNote = '';
  try {
    execFileSync(exe, [], {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 120000,
      // 等久一点：全新数据目录首次启动要从客户端拉 200 局，3.5 秒只能截到一张空列表
      env: electronEnv({ BBX_SHOT: shot, SHOT_WAIT_MS: '7000' }),
    });
  } catch (e) {
    // 截图存下来之后主动退出，退出形态不一定干净 —— 这不代表失败，别急着喊出错
    exitNote = e.status === null ? '（进程被信号结束）' : `（退出码 ${e.status}）`;
  }
  if (fs.existsSync(shot)) {
    const kb = (fs.statSync(shot).size / 1024).toFixed(0);
    log(`截图 ${path.relative(ROOT, shot)} ${kb} KB ${exitNote}`);
    return true;
  }
  const logFile = path.join(BUILD_DIR, 'data', 'desktop.log');
  log('没拿到截图 —— 客户端多半没起来。');
  if (fs.existsSync(logFile)) log(`客户端日志尾部：\n${tail(logFile, 12)}`);
  else log('连 data/desktop.log 都没有 —— 进程根本没跑到应用代码（先确认没有 ELECTRON_RUN_AS_NODE 之类的环境变量）。');
  return false;
}

/** 读文件末尾几行 —— 出问题时把现场直接摆在报告里，别让人再去翻目录 */
function tail(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).map((l) => `      ${l}`).join('\n');
  } catch { return '      （读不出来）'; }
}

/* ── 6. 压缩包 ── */

/**
 * 压成分发用的 zip（此时产物已经归位到 `dist/LOL背锅侠/`）。
 *
 * 再清一次 `data/`：冒烟那一步是以真实客户端跑起来的，会在 exe 旁边写下账号 puuid、
 * 昵称、战报、名录 —— 全是本机隐私。「进包的只有公共查表数据」是这个项目的红线
 * （和单文件 exe 那条一模一样），分发包里夹带一份 accounts.json 就等于把人的账号发出去了。
 * 这一版之前就漏过一次。
 */
function makeZip() {
  step(6, '压成分发用的 zip');
  setAside(path.join(OUT_DIR, 'data'));
  const zip = path.join(DIST, `${APP_NAME}-win-x64.zip`);
  // 不预先删除：bsdtar 直接截断覆盖同名文件。
  // 那一下 `rmSync` 看着无害，但这台环境对「一个回合里删太多文件」有保护，
  // 会在收尾这一步突然把整条打包链打断（第一次就栽在这儿）。
  execFileSync(TAR, ['-a', '-cf', zip, '-C', DIST, APP_NAME], { stdio: ['ignore', 'inherit', 'inherit'] });
  log(`${path.relative(ROOT, zip)} ${mb(fs.statSync(zip).size)}`);
  return zip;
}

function sizeOf(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    total += sizeOf(path.join(p, e.name));
  }
  return total;
}

/**
 * 分发前的隐私自查：产物里不得出现 API Key。
 *
 * 为什么单列一步：Key 是明文，而 README 教的是「整个目录拷走即可运行」——
 * 只要哪天有人手动把 dist 打个包分享，夹在里面的 config.json 就等于把 Key 交出去。
 * Key 现在只落在用户配置目录（见 service.mjs 的 USER_CONFIG_DIR），
 * 这里是把「没有夹带」变成红灯，而不是靠人记着。
 *
 * 只扫文本形态的产物（源码 / 界面 / 升级包里的条目）——
 * exe、dll、pak 这类二进制里随机出现 `sk-` 字节是家常便饭，扫了只会全是假警报。
 */
const KEY_RE = /sk-[A-Za-z0-9]{16,}/;
function scanForSecrets() {
  const hits = [];
  const dirs = [
    path.join(OUT_DIR, 'resources', 'app'),
    path.join(DIST, '.update-stage', 'app'),
  ];
  const textExt = /\.(js|mjs|cjs|json|html|css|bat|md|txt)$/i;
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!textExt.test(e.name)) continue;
      const m = fs.readFileSync(p, 'utf8').match(KEY_RE);
      if (m) hits.push(`${path.relative(ROOT, p)}（${m[0].slice(0, 8)}…）`);
    }
  };
  dirs.forEach(walk);
  // 分发 zip 里同样不许有 —— 它是真正会被拷走的那份
  for (const z of [path.join(DIST, `${APP_NAME}-win-x64.zip`), path.join(DIST, `${APP_NAME}-升级包-v${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}.zip`)]) {
    if (!fs.existsSync(z)) continue;
    try {
      for (const e of readZip(z)) {
        if (!textExt.test(e.name)) continue;
        const m = e.data.toString('utf8').match(KEY_RE);
        if (m) hits.push(`${path.basename(z)}:${e.name}（${m[0].slice(0, 8)}…）`);
      }
    } catch { /* 读不出来的包另有别的检查兜着 */ }
  }
  if (hits.length) {
    console.error(`  [!] 产物里发现疑似 API Key：${hits.slice(0, 3).join(' / ')}`);
    console.error('      Key 只该存在于用户配置目录，不该出现在这里 —— 必须查清楚再发出去。');
    process.exit(1);
  }
  log('隐私自查通过：产物里没有 API Key');
}

/* ── main ── */

const pkg0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (UPDATE_ONLY) {
  // 只出升级包：不需要 240MB 运行时，也不需要重下 Electron
  sweepTrash();
  console.log(`\n  ============================================`);
  console.log(`   打升级包 ${APP_NAME} v${pkg0.version}`);
  console.log(`  ============================================\n`);
  const zip = buildUpdateZip();
  scanForSecrets();
  sweepTrash();
  console.log('\n  ============================================');
  console.log(`   升级包    ${path.relative(ROOT, zip)}`);
  console.log(`   用法      把 zip 拖到安装目录里的 update.bat 上`);
  console.log('            或命令行：update.bat <升级包.zip>');
  console.log('   范围      只替换 resources/app（代码），不动 data/ 里的任何东西');
  console.log('  ============================================\n');
} else if (DEV) {
  const zip = ensureRuntime();
  const runtime = path.join(CACHE, 'runtime');
  const exe = path.join(runtime, 'electron.exe');
  if (!fs.existsSync(exe)) {
    resetDir(runtime);
    execFileSync(TAR, ['-xf', zip, '-C', runtime], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
  console.log(`\n  开发态启动：${exe}\n  应用目录：  ${ROOT}\n`);
  spawn(exe, [ROOT], { stdio: 'inherit', env: electronEnv() }).on('exit', (c) => process.exit(c ?? 0));
} else {
  const sweptStart = sweepTrash();
  const zip = ensureRuntime();
  extractRuntime(zip);
  buildApp();
  const exe = rebrand();
  const ok = smoke(exe);

  // 冒烟那一步是以真实客户端跑起来的，会在 exe 旁边写下账号 puuid、昵称、战报。
  // 这些是本机隐私，绝不能跟着包走 —— 与「进包/进 exe 的只有公共查表数据」是同一条红线。
  setAside(path.join(BUILD_DIR, 'data'));

  // 归位：旧产物整体挪走（不原地删，见 setAside），新产物改名到交付路径
  setAside(OUT_DIR);
  fs.renameSync(BUILD_DIR, OUT_DIR);

  const zipOut = ZIP ? makeZip() : null;
  scanForSecrets();
  // 顺手把这一版的升级包也做出来：装过旧版的用户拷这一个 zip 就够了，
  // 不用再搬一次 240MB。里面只有代码 —— 数据留在用户自己的 data/ 里。
  const updateZip = buildUpdateZip();
  // 收尾再扫一次：刚挪走的那份旧产物这会儿多半已经能删掉了（不然它会以 .trash 身份
  // 在 dist/ 里躺到下一轮，虽然正确的名字叫「中转站」，但看着还是像垃圾）
  const swept = sweptStart + sweepTrash();
  const total = sizeOf(OUT_DIR);

  console.log('\n  ============================================');
  console.log(`   打包完成：dist/${APP_NAME}/`);
  console.log(`   体积      ${mb(total)}（解开后）${zipOut ? ` / 压缩包 ${mb(fs.statSync(zipOut).size)}` : ''}`);
  console.log(`   客户端    ${APP_NAME}/${APP_NAME}.exe`);
  console.log('   目标机器  不用装 Node、不用装浏览器，整个目录拷走即可');
  console.log('   数据      **产物里不含任何本机数据**，首次运行会自己在 exe 旁边建 data/');
  console.log(`   升级      旧版用户拷 ${path.basename(updateZip)}，拖到安装目录里的 update.bat 上即可`);
  console.log('            （只换代码，data/ 里的战报与账号原样保留，旧版自动备份可回滚）');
  console.log(`   自检      ${ok ? '已截图 preview/desktop-client.png' : '⚠ 截图未生成，请手动双击试试'}`);
  if (swept) console.log(`   清理      顺手清掉了上一轮的 ${swept} 份中间产物`);
  console.log('  ============================================');
  console.log('   注意：未做代码签名，首次运行 Windows 可能提示');
  console.log('   「已保护你的电脑」→ 点「更多信息」→「仍要运行」');
  console.log('');
}
