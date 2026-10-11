/**
 * 本地 API 可信边界自检 —— 对应 P1（鉴权 / CORS / Content-Type）。
 *
 * 为什么单列一个脚本：这类问题**看代码看不出来**，只能发真请求验。
 * 它起一个临时服务（随机端口），然后扮演三种角色去打：
 *   ① 本机界面（有令牌、Host 是 127.0.0.1）  —— 必须通
 *   ② 浏览器里的恶意页面（带 Origin: http://evil.com） —— 必须被拦
 *   ③ DNS rebinding（域名解析到 127.0.0.1，Host 是它的域名） —— 必须被拦
 * 以及一个「简单请求」通道：把 POST 伪装成 text/plain 表单 —— 必须 415。
 *
 * 用法：node tools/check-api-guard.mjs
 */
import net from 'node:net';

const { startServer } = await import('../server/server.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (cond, label, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail.push(label);
};

/** 原始 HTTP 请求 —— fetch 会按 URL 自己写 Host，改不了，所以要手搓 */
function rawRequest(port, lines, body = '') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(lines.join('\r\n') + '\r\n\r\n' + body);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(buf); }, 3000);
  });
}

const parse = (raw) => {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const status = Number((head.match(/^HTTP\/[\d.]+ (\d+)/) || [])[1] || 0);
  return { status, head, body: rest.join('\r\n\r\n') };
};

const { port, url } = await startServer({ port: 0, open: false, quiet: true });
console.log('');
console.log('  ============================================');
console.log('   本地 API 可信边界自检');
console.log('  ============================================');
console.log(`   临时服务 ${url}`);
console.log('');

/* ── ① 本机界面：先取首页拿令牌 ── */
const home = await fetch(`${url}/`);
const homeHtml = await home.text();
const token = (homeHtml.match(/name="bbx-token" content="([^"]+)"/) || [])[1] || null;
ok(!!token, '首屏 HTML 里带会话令牌');
const homeCsp = home.headers.get('content-security-policy') || '';
ok(/default-src 'self'/.test(homeCsp), '首页带 CSP 响应头', `（${homeCsp.slice(0, 40)}…）`);

const withToken = (opts = {}) => ({
  ...opts,
  headers: { ...(opts.headers || {}), 'X-BBX-Token': token || '' },
});

/* ── ② 无令牌一律 401（GET 与 POST 都要挡） ── */
const noTokenGet = await fetch(`${url}/api/status`);
ok(noTokenGet.status === 401, 'GET /api/status 无令牌 → 401', `（实际 ${noTokenGet.status}）`);

const noTokenPost = await fetch(`${url}/api/config`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tone: 'savage' }),
});
ok(noTokenPost.status === 401, 'POST /api/config 无令牌 → 401', `（实际 ${noTokenPost.status}）`);

const noTokenSse = await fetch(`${url}/api/events`);
ok(noTokenSse.status === 401, 'GET /api/events（SSE）无令牌 → 401', `（实际 ${noTokenSse.status}）`);

/* ── ③ 有令牌就通 ── */
const okGet = await fetch(`${url}/api/status`, withToken());
ok(okGet.status === 200, 'GET /api/status 带令牌 → 200', `（实际 ${okGet.status}）`);

const okSseToken = await fetch(`${url}/api/events?token=${encodeURIComponent(token || '')}`);
ok(okSseToken.status === 200, 'SSE 令牌走查询串 → 200', `（实际 ${okSseToken.status}）`);
okSseToken.body?.cancel?.();

/* ── ③b 查询串令牌只认 SSE 与 /api/asset 两个端点 ── */
// 这两个是界面上唯一改不了请求头的地方（EventSource / <img src>），
// 其余端点的令牌只准待在头里 —— URL 会被浏览器存进历史、也会被当成缓存键。
const qsStatus = await fetch(`${url}/api/status?token=${encodeURIComponent(token || '')}`);
ok(qsStatus.status === 401, 'GET /api/status 令牌放在查询串 → 401', `（实际 ${qsStatus.status}）`);

const qsAsset = await fetch(`${url}/api/asset?p=%2Flol-game-data%2Fassets%2Fv1%2Fchampion-icons%2F1.png&token=${encodeURIComponent(token || '')}`);
// 客户端未必开着（503）、路径未必存在（403/404）—— 这些都不重要，
// 要验的是它**过了令牌那一关**：返回 401 就说明查询串入口被收窄过头了
ok(qsAsset.status !== 401, 'GET /api/asset 令牌走查询串 → 不被令牌闸拦下', `（实际 ${qsAsset.status}）`);

// 客户端开着才拿得到真资源 —— 那时顺手验缓存头：这份素材只该落在本机当前用户的缓存里，
// 写成 public 会被共享缓存（公司代理之类）也留一份
const assetCc = qsAsset.headers.get('cache-control') || '';
if (qsAsset.status === 200) {
  ok(/private/.test(assetCc) && !/public/.test(assetCc),
    '/api/asset 缓存标为 private（不进共享缓存）', `（${assetCc}）`);
} else {
  console.log(`  · 客户端未运行（${qsAsset.status}），/api/asset 的 private 缓存头未在此验证`);
}
qsAsset.body?.cancel?.();

/* ── ③c 通用安全响应头 ── */
const nosniffApi = okGet.headers.get('x-content-type-options');
ok(nosniffApi === 'nosniff', 'API 响应带 X-Content-Type-Options: nosniff', `（实际 ${nosniffApi}）`);
const refApi = okGet.headers.get('referrer-policy');
ok(refApi === 'no-referrer', 'API 响应带 Referrer-Policy: no-referrer', `（实际 ${refApi}）`);

const cssHead = await fetch(`${url}/styles.css`);
const nosniffStatic = cssHead.headers.get('x-content-type-options');
const refStatic = cssHead.headers.get('referrer-policy');
ok(nosniffStatic === 'nosniff', '静态资源带 X-Content-Type-Options: nosniff', `（实际 ${nosniffStatic}）`);
ok(refStatic === 'no-referrer', '静态资源带 Referrer-Policy: no-referrer', `（实际 ${refStatic}）`);

/* ── ④ Content-Type：非 JSON 的写请求一律 415 ── */
const plainPost = await fetch(`${url}/api/watch`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'X-BBX-Token': token || '' },
  body: 'on=false',
});
ok(plainPost.status === 415, 'POST /api/watch 用 text/plain → 415', `（实际 ${plainPost.status}）`);

const formPost = await fetch(`${url}/api/watch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-BBX-Token': token || '' },
  body: 'on=false',
});
ok(formPost.status === 415, 'POST /api/watch 用表单类型 → 415', `（实际 ${formPost.status}）`);

const jsonPost = await fetch(`${url}/api/watch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-BBX-Token': token || '' },
  body: JSON.stringify({ on: true }),
});
ok(jsonPost.status === 200, 'POST 用 application/json; charset=utf-8 → 200', `（实际 ${jsonPost.status}）`);

/* ── ⑤ 跨域页面：Origin 不在白名单 → 不给 CORS 许可 ── */
const evil = await fetch(`${url}/api/status`, {
  headers: { Origin: 'http://evil.example.com', 'X-BBX-Token': token || '' },
});
ok(!evil.headers.get('access-control-allow-origin'),
  '带 Origin: evil.com → 不回显 CORS 许可', `（实际 ${evil.headers.get('access-control-allow-origin')}）`);

const selfOrigin = await fetch(`${url}/api/status`, {
  headers: { Origin: `http://127.0.0.1:${port}`, 'X-BBX-Token': token || '' },
});
ok(selfOrigin.headers.get('access-control-allow-origin') === `http://127.0.0.1:${port}`,
  '带同源 Origin → 只回显这一个', `（实际 ${selfOrigin.headers.get('access-control-allow-origin')}）`);

const preflightOk = await fetch(`${url}/api/status`, {
  method: 'OPTIONS', headers: { Origin: `http://127.0.0.1:${port}`, 'Access-Control-Request-Method': 'POST' },
});
ok(preflightOk.status === 204 && /X-BBX-Token/i.test(preflightOk.headers.get('access-control-allow-headers') || ''),
  '同源预检 → 204 且允许令牌头');

const preflightEvil = await fetch(`${url}/api/status`, {
  method: 'OPTIONS', headers: { Origin: 'http://evil.example.com', 'Access-Control-Request-Method': 'POST' },
});
ok(preflightEvil.status === 403, '跨域预检 → 403', `（实际 ${preflightEvil.status}）`);

/* ── ⑥ DNS rebinding：Host 不是回环 → 403 ── */
const rebound = parse(await rawRequest(port, [
  `GET /api/status HTTP/1.1`,
  `Host: attacker.example.com`,
  `X-BBX-Token: ${token}`,
  `Connection: close`,
]));
ok(rebound.status === 403, 'Host 为攻击者域名 → 403', `（实际 ${rebound.status || '无响应'}）`);

const localhost = parse(await rawRequest(port, [
  `GET / HTTP/1.1`,
  `Host: localhost:${port}`,
  `Connection: close`,
]));
ok(localhost.status === 200, 'Host 为 localhost → 200', `（实际 ${localhost.status}）`);

/* ── ⑦ 静态资源不需要令牌（先有页面才拿得到令牌） ── */
const css = await fetch(`${url}/styles.css`);
ok(css.status === 200, '静态资源免令牌 → 200', `（实际 ${css.status}）`);

console.log('');
if (fail.length) {
  console.log(`  结果：✗ ${fail.length} 项未通过 —— ${fail.join(' / ')}`);
  console.log('');
  process.exit(1);
}
console.log('  结果：✓ 本机界面可正常调用；跨域页面、伪装 Host、伪装 Content-Type 全部被挡');
console.log('');
process.exit(0);
