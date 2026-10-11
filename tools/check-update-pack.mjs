/**
 * 升级链路自检 —— 守住三类「发出去才发现」的事故。
 *
 *  1. **bat 解析错误**：cmd 对 `(` `)` 极其敏感。一个写在 `if (...)` 块里的
 *     字面括号（哪怕只是 `set /p` 提示语里的 `(the one with LOL exe)`）会提前闭合块，
 *     于是 cmd 在**解析阶段**就把整个批处理作废 —— 屏幕上啥也没有，窗口一闪而过，
 *     退出码 255。源码里看不出来，只有真跑一次 cmd 才会暴露。
 *
 *  2. **升级装不进去**：升级器规则是「清单外的条目一律拒装」。打包时若某个文件
 *     在算清单之后才落盘（update.bat 就出过这事），用户一升级就被
 *     `不在 update.json 的文件清单里` 挡回去，而打包脚本这边全绿。
 *
 *  3. **升完版本没变**：上面都过了，也得真装一遍看 package.json 是不是新版本号。
 *
 * 前两条都是「本机开发看着正常、到了用户机器上才炸」。
 *
 * ★ 关键：第 1 条必须在**像安装目录一样的地方**跑。在仓库根目录跑的话，
 *   update.bat 早在「找不到 apply-update.mjs」那条分支就退出了，
 *   根本走不到有问题的那段 —— 那就是一条永远绿的假断言。
 *
 * 用法：node tools/check-update-pack.mjs [升级包.zip]
 *      不给参数就自己找 dist/ 里版本号最大的那个升级包。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1'));
const ROOT = path.resolve(HERE, '..');
const TMP = path.join(ROOT, '.tmp', 'check-update-pack');

const fails = [];
const ok = (cond, name, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  （${extra}）` : ''}`);
  if (!cond) fails.push(name);
};

/* cmd 的报错是本机代码页（GBK），本文件是 UTF-8 —— 直接当 utf8 读是乱码，
   判断关键字前先按 GBK 解一遍。没有完整 ICU 时退回 utf8，宁可漏报也不假报。 */
function decodeCmd(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}

/** 跑一次 cmd，返回结果。stdin 设 'ignore'（= NUL）让 pause 立刻返回，不会卡住。 */
function runCmd(args, cwd, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const p = spawn('cmd.exe', ['/c', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => err.push(Buffer.from(String(e.message))));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: decodeCmd(Buffer.concat(out)), err: decodeCmd(Buffer.concat(err)) });
    });
  });
}

const CMD_BROKEN = /unexpected at this time|此时不应有|不是内部或外部命令|is not recognized/i;

/** 造一个「像安装目录」的沙盘：有 exe、有 resources/app，但都是副本，炸了也不心疼 */
function makeFakeInstall() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const app = path.join(TMP, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const d of ['server', 'src', 'web', 'desktop']) {
    fs.cpSync(path.join(ROOT, d), path.join(app, d), { recursive: true });
  }
  // 故意把版本号压低：断言「升到了清单里的版本」才不会是恒真
  const pkgPath = path.join(app, 'package.json');
  fs.copyFileSync(path.join(ROOT, 'package.json'), pkgPath);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = '0.0.0-sandbox';
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  // bat 自己也要在（它就在安装根目录，升级时会被覆盖成新版）
  fs.copyFileSync(path.join(ROOT, 'desktop', 'update.bat'), path.join(TMP, 'update.bat'));
  // 假的 exe：bat 只要「目录里有 .exe」就会往下走；它当然跑不起来，
  // 但我们验的是**解析阶段**，跑不起来反而更安全（不会真的改动什么）。
  fs.writeFileSync(path.join(TMP, 'LOL背锅侠.exe'), '');
  return TMP;
}

/* ─────────── 找升级包 ─────────── */

function latestUpdateZip() {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) return null;
  const zips = fs.readdirSync(dist)
    .filter((f) => f.includes('升级包') && f.endsWith('.zip'))
    .map((f) => ({ f, v: (/v(\d+)\.(\d+)\.(\d+)/.exec(f) || []).slice(1).map(Number) }))
    .filter((x) => x.v.length === 3)
    .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return zips.length ? path.join(dist, zips[zips.length - 1].f) : null;
}

const ZIP = process.argv[2] && fs.existsSync(process.argv[2]) ? process.argv[2] : latestUpdateZip();

/* ─────────── 一、bat 能被 cmd 解析 ─────────── */

console.log('\n── bat 解析 ──');

// 根目录的 start.bat / check.bat 会真的起服务 / 跑全套自检，不在自检里执行它们；
// 只做静态检查（注释行之外必须全 ASCII —— cmd 的代码页会啃中文）。
for (const rel of ['start.bat', 'check.bat', 'desktop/update.bat']) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { ok(false, `${rel} 存在`, '文件不见了'); continue; }
  const bad = [];
  fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(@?\s*(rem\b|::))/.test(l.trim().toLowerCase())) return;
    if (/[^\x00-\x7F]/.test(l)) bad.push(`${i + 1} 行`);
  });
  ok(bad.length === 0, `${rel} 可执行行全 ASCII`, bad.join('、'));
}

if (!ZIP) {
  ok(false, '找到升级包', 'dist/ 里没有升级包，先跑 node tools/build-desktop.mjs');
} else {
  // ★ 必须在假安装目录里跑，否则 update.bat 会提前退出，等于没验。
  //   传一个**真实存在**的升级包路径，脚本才会越过「zip 不存在」那条分支，
  //   一路走到后面那些 if 块。
  const r2 = await runCmd(['update.bat', ZIP], makeFakeInstall());
  const both = r2.out + r2.err;
  ok(!CMD_BROKEN.test(both), 'update.bat 被 cmd 完整解析（无括号陷阱）',
    CMD_BROKEN.test(both) ? both.trim().split(/\r?\n/)[0] : `exit=${r2.code}`);
  // 解析炸了的表现就是「一行输出都没有、直接退出 255」—— 用户看到的就是窗口一闪而过
  ok(r2.out.trim().length > 0, 'update.bat 有输出（不是静默失败）', `exit=${r2.code}`);
  ok(r2.code !== 255, 'update.bat 不是被 cmd 整批作废（255）', `exit=${r2.code}`);
}

/* ─────────── 二、升级包清单 ─────────── */

console.log('\n── 升级包清单 ──');

if (!ZIP) {
  ok(false, '升级包清单', '没有升级包可验');
} else {
  // 复用升级器自己的 zip 读取器 —— 用户机器上解的就是这份代码，别用另一套逻辑验
  const { readZip } = await import('../desktop/apply-update.mjs');
  const entries = readZip(ZIP);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  ok(true, `读得开 ${path.basename(ZIP)}`, `${entries.length} 个条目`);

  const manifestEntry = entries.find((e) => e.name === 'update.json');
  ok(!!manifestEntry, '包里有 update.json');
  const m = manifestEntry ? JSON.parse(manifestEntry.data.toString('utf8')) : null;

  if (m) {
    ok(/^\d+\.\d+\.\d+/.test(String(m.version || '')), '清单 version 是版本号', String(m.version));

    const white = ['update.bat'];
    const badRoot = (m.rootFiles || []).filter((f) => !white.includes(f));
    ok(badRoot.length === 0, 'rootFiles 都在白名单内', badRoot.join(','));

    // 核心：每个条目都得在清单里且哈希对得上。
    // 「打包顺序错了」和「包被换过」就体现在这两条上。
    const missing = [];
    const mismatch = [];
    for (const e of entries) {
      if (e.name === 'update.json') continue;
      const want = (m.files || {})[e.name];
      if (!want) { missing.push(e.name); continue; }
      if (sha(e.data) !== want) mismatch.push(e.name);
    }
    ok(missing.length === 0, '每个条目都在 sha256 清单里', missing.length ? `缺 ${missing.join(' / ')}` : `${entries.length - 1} 个全覆盖`);
    ok(mismatch.length === 0, '每个条目哈希都对得上', mismatch.join(' / '));

    // rootFiles 声明的文件必须真的在包里 —— 否则升级完旧 bat 还在，升级器自己没升成
    const missRoot = (m.rootFiles || []).filter((f) => !entries.some((e) => e.name === f));
    ok(missRoot.length === 0, 'rootFiles 声明的文件都在包里', missRoot.join(','));

    const leaked = entries.filter((e) => e.name.split('/').includes('data'));
    ok(leaked.length === 0, '包里 0 个 data 条目', leaked.slice(0, 3).join(' '));

    /* ─────────── 三、真装一遍 ─────────── */

    console.log('\n── 端到端装一次（沙盘目录）──');

    const fake = makeFakeInstall();
    const before = JSON.parse(fs.readFileSync(path.join(fake, 'resources', 'app', 'package.json'), 'utf8')).version;
    // 放一份「用户数据」，升级完必须还在 —— 这是升级器的第一铁律
    const dataDir = path.join(fake, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), '{"keep":"me"}');

    // node 路径别自己加引号 —— spawn 已经在必要时加了一层，再加一层 cmd 就认不出来了
    const run = await runCmd(
      [process.execPath, '.\\resources\\app\\desktop\\apply-update.mjs', ZIP, '--root', '.'],
      fake, 60_000,
    );

    ok(run.code === 0, '升级器退出码 0', `exit=${run.code}${run.err.trim() ? ' / ' + run.err.trim().split(/\r?\n/)[0] : ''}`);
    const after = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(fake, 'resources', 'app', 'package.json'), 'utf8')).version; }
      catch { return '?'; }
    })();
    ok(after === m.version, `版本从 ${before} 升到 ${m.version}`, `实际 ${after}`);
    ok(fs.existsSync(path.join(dataDir, 'accounts.json'))
      && fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8') === '{"keep":"me"}',
    'data/ 一个字节都没动');
    const backups = fs.readdirSync(path.join(fake, 'resources')).filter((f) => f.startsWith('app.bak-'));
    ok(backups.length >= 1, '留了回滚点 app.bak-*', backups.join(','));
    ok(fs.existsSync(path.join(fake, 'update.bat')), 'update.bat 已更新到新版本');
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
if (fails.length) {
  console.log(`结果：✗ ${fails.join(' / ')}\n`);
  process.exit(1);
}
console.log('结果：✓ 升级链路自检通过\n');
