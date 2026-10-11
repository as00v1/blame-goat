/**
 * BlameGoat 桌面客户端 —— Electron 外壳
 *
 * 这一层只干三件事，业务逻辑一行都不碰：
 *   1. 把 server/server.mjs 当库拉起来（端口给 0，让它自己挑一个空的，
 *      永远不会和「命令行那份服务」打架）；
 *   2. 开一个窗口，把页面装进去 —— 桌面客户端该有的样子，不再弹浏览器；
 *   3. 收尾：单实例、外链走系统浏览器、日志落到 data/desktop.log。
 *
 * 为什么真的套了 Electron 而不是继续用 exe + 浏览器：需求就是「页面要在客户端里」。
 * 代价是体积从 84MB 涨到 ~250MB（自带 Chromium，目标机器依旧什么都不用装）。
 * 单文件 exe 那条路没有删，`npm run pack` 还在，适合当后台服务用。
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const APP_NAME = 'BlameGoat · LOL背锅侠';
/** 桌面客户端里这个文件在 resources/app/desktop/ 下，上一级就是随包的应用根 */
const APP_DIR = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'icon.ico');

/** 纯自检模式：截一张图就退出（打包脚本与排障用，不抢单实例锁）
 *
 * ⚠️ 这里为什么读环境变量而不是 `--shot=路径`：Electron 会把不认识的 `--xxx`
 *    原样丢给 Chromium，而 Chromium 碰到未知开关直接 `bad option` 退出 ——
 *    实测退出码 9，截图一张都拿不到。环境变量没这个毛病。
 */
const SHOT = process.env.BBX_SHOT || null;

let win = null;
let serverInfo = null;

/* ────────────────── 日志 ────────────────── */

/**
 * 打包后的客户端没有控制台，报错不能只往 stdout 一扔就完事。
 * 把 console 分流一份到 data/desktop.log —— 出问题时让用户直接把文件发过来就行。
 * 超过 1.5MB 轮转一次，只留一代，别把人家硬盘当日志坟场。
 */
function teeLog(file) {
  let stream;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 1.5 * 1024 * 1024) {
        fs.rmSync(`${file}.old`, { force: true });
        fs.renameSync(file, `${file}.old`);
      }
    } catch { /* 第一次跑没有旧文件 */ }
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch { return; }

  const fmt = (a) => a.map((v) => (v instanceof Error ? (v.stack || v.message) : String(v))).join(' ');
  for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => {
      orig(...a);
      try { stream.write(`[${new Date().toISOString()}] ${m.toUpperCase()} ${fmt(a)}\n`); } catch { /* 写不进去也不能反过来拖垮程序 */ }
    };
  }
  const stamp = () => `\n===== ${new Date().toLocaleString('zh-CN')} 启动 v${app.getVersion()}（Electron ${process.versions.electron}）=====\n`;
  try { stream.write(stamp()); } catch { /* 同上 */ }
}

/* ────────────────── 窗口 ────────────────── */

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    // 页面本身就是深色，先铺底色再显示 —— 否则开窗瞬间会闪一下白
    backgroundColor: '#0e1116',
    title: APP_NAME,
    icon: ICON,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 页面只装本地服务的内容，没有 preload、也不需要 node —— 那就把渲染进程
      // 关进沙箱里。多一层隔离不影响现有功能（已随打包冒烟验证过）。
      sandbox: true,
      spellcheck: false,
      // 页面靠 SSE + 5 秒轮询盯着客户端；窗口最小化时若被节流，
      // 「打完一局自动登记」就会迟到 —— 这个后台工作不能被浏览器那套省电逻辑掐掉。
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // 页面自己的 title 带副标题，任务栏上太长；固定成应用名更利落
  win.on('page-title-updated', (e) => e.preventDefault());

  // 页面里的外链（文档、API 控制台之类）交给系统浏览器，客户端窗口只干正事
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith(origin)) return;
    e.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  win.loadURL(url);
  win.on('closed', () => { win = null; });
}

/**
 * 菜单栏干脆去掉 —— 那套英文 File/Edit/View 对用户没有意义。
 * 但有三个键是真有用，用 before-input-event 自己接住：
 *   F5 / Ctrl+R   刷新    F11  全屏    F12  开发者工具（排障时告诉用户按这个）
 */
function installShortcuts(w) {
  Menu.setApplicationMenu(null);
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = String(input.key || '');
    if (input.key === 'F12' || (ctrl && input.shift && key.toLowerCase() === 'i')) {
      w.webContents.toggleDevTools();
    } else if (input.key === 'F11') {
      w.setFullScreen(!w.isFullScreen());
    } else if (input.key === 'F5' || (ctrl && key.toLowerCase() === 'r')) {
      w.webContents.reload();
    } else {
      return;
    }
    e.preventDefault();
  });
}

/* ────────────────── 启动 ────────────────── */

async function loadServer() {
  const mod = await import(pathToFileURL(path.join(APP_DIR, 'server', 'server.mjs')).href);
  return mod.startServer;
}

/**
 * Chromium 有一份「不安全端口」名单，选中了它就直接 ERR_UNSAFE_PORT 拒绝加载 ——
 * 页面白屏，而服务其实好好活着，最难查的一种。名单来自 Chromium 的 net/base/port_util.cc。
 *
 * 我们的候选区间（18000-28999）其实整体在名单之上，这里还是老老实实过一遍：
 * 这份名单是 Chromium 定的，它明天加几个端口，不该变成我们「随机挑端口随机起不来」。
 */
const UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/**
 * 挑个能用的端口把服务拉起来。
 *
 * 为什么不让系统随机（listen 传 0）：那挑出来的端口不受 Chromium 管，撞上黑名单就白屏。
 * 为什么不用固定 7710：会和「命令行/单文件 exe 那份服务」抢 —— 人家默认就是 7710。
 */
async function startServerOnFreePort(startServer) {
  for (let i = 0; i < 12; i += 1) {
    const port = 18000 + Math.floor(Math.random() * 11000);
    if (UNSAFE_PORTS.has(port)) continue;
    try {
      return await startServer({ port, open: false, quiet: true });
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;   // 被别人占了就再挑一个，别的错不该咽
      console.warn(`[desktop] 端口 ${port} 被占用，换一个`);
    }
  }
  throw new Error('连挑 12 个端口都被占用 —— 这台机器上的端口有点挤');
}

async function boot() {
  // 日志要落在数据目录里 —— 数据目录由 env.mjs 一处裁定（客户端旁边，或退到 LOCALAPPDATA）
  try {
    const env = await import(pathToFileURL(path.join(APP_DIR, 'src', 'env.mjs')).href);
    teeLog(path.join(env.DATA_DIR, 'desktop.log'));
    if (env.DATA_DIR_NOTE) console.warn(`[desktop] ${env.DATA_DIR_NOTE}`);
  } catch (e) {
    console.error('[desktop] 日志初始化失败：', e);
  }

  console.log(`[desktop] 应用目录 ${APP_DIR}`);

  const startServer = await loadServer();
  try {
    serverInfo = await startServerOnFreePort(startServer);
    console.log(`[desktop] 本地服务已就绪 ${serverInfo.url}`);
  } catch (e) {
    console.error('[desktop] 服务启动失败：', e);
    dialog.showErrorBox(`${APP_NAME} 启动失败`, `本地服务没能起来：\n${e.message}\n\n详细信息见 data/desktop.log`);
    app.exit(1);
    return;
  }

  if (SHOT) return shoot(SHOT, serverInfo.url);

  createWindow(serverInfo.url);
  installShortcuts(win);
}

/** 截图自检：渲染完等页面把首屏数据拉回来，存图就退 —— 用来证明「页面真的在客户端里」 */
async function shoot(outPath, url) {
  const w = new BrowserWindow({
    width: 1440, height: 920, show: false, icon: ICON,
    backgroundColor: '#0e1116',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
  });
  try {
    await w.loadURL(url);
    await new Promise((r) => setTimeout(r, Number(process.env.SHOT_WAIT_MS || 2500)));
    const img = await w.webContents.capturePage();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, img.toPNG());
    console.log(`[desktop] 截图已保存 ${outPath}`);
  } catch (e) {
    console.error('[desktop] 截图失败：', e);
    app.exit(1);
    return;
  }
  app.exit(0);
}

/* ────────────────── 生命周期 ────────────────── */

// 让 Windows 任务栏把窗口归到「LOL背锅侠」名下，而不是显示成 electron.exe
app.setAppUserModelId('com.blamegoat.lol');

// 双击第二下不该再开一个进程 —— 那是「客户端」和「命令行脚本」的分水岭。
// 自检模式例外：它只是来截图的，不该被正在跑的实例顶掉。
if (!SHOT && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(boot).catch((e) => {
    console.error('[desktop] 启动异常：', e);
    app.exit(1);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!win && serverInfo) createWindow(serverInfo.url); });
}
