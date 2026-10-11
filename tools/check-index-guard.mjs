/**
 * 战绩索引的两条回归线 —— 对应 P6（并发写覆盖）与 P7（换号张冠李戴）。
 *
 * P6：matches.json 是「读-改-写」。listMatches 中间要拉几百局 LCU 详情（跨 await），
 *     而判定完成 / 监视器扫描会在同一时间也写这个文件 —— 后写者若拿着旧快照写，
 *     别人刚加的条目就没了（表现为「刚重判完，列表那行又变回旧结论」）。
 *     这里并发打真接口，断言条目只增不减、老条目一条不少。
 *
 * P7：归属只能由「本人是否在这一局里」决定，不能拿「此刻登录的是谁」去套 ——
 *     否则换号窗口期里，客户端缓存中上一个号的对局会被记到新号名下。
 *     这里直接喂一份「我在局里 / 我不在局里」的对局，断言 ownerPuuid 的取值。
 *
 * 用法：node tools/check-index-guard.mjs [服务地址]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeGame, mergeEntry } from '../src/lcu/matches.mjs';
import { ownsLocally } from '../server/service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || process.env.BBX_BASE || 'http://127.0.0.1:7710').replace(/\/+$/, '');

const fail = [];
const ok = (cond, label, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail.push(label);
};

/* ── 拿令牌（/api/* 现在要它） ── */
const TOKEN = await (async () => {
  try {
    const html = await (await fetch(`${BASE}/`)).text();
    return (html.match(/name="bbx-token" content="([^"]+)"/) || [])[1] || null;
  } catch { return null; }
})();
if (!TOKEN) {
  console.error(`\n  [X] 连不上服务 ${BASE} —— 先跑 node server/server.mjs\n`);
  process.exit(1);
}
const api = (path, opts = {}) => fetch(BASE + path, {
  ...opts,
  headers: {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    'X-BBX-Token': TOKEN,
    ...(opts.headers || {}),
  },
}).then((r) => r.json());

console.log('');
console.log('  ============================================');
console.log('   战绩索引自检（P6 并发写 / P7 归属）');
console.log('  ============================================');
console.log('');

/* ─────────── P6：并发写不丢条目 ─────────── */
const first = await api('/api/matches?limit=500&refresh=0');
const before = first?.matches || [];
const beforeIds = new Set(before.map((m) => String(m.gameId)));
console.log(`  基线：索引里 ${before.length} 局`);

// 并发打：列表刷新（会写索引） + 详情（会写名录 / 昵称）交错着来，
// 谁先谁后由事件循环决定 —— 这正是出问题的那种时序
const detailIds = before.slice(0, 3).map((m) => m.gameId);
const jobs = [
  api('/api/matches?limit=500&refresh=1'),
  api('/api/matches?limit=500&refresh=1'),
  ...detailIds.map((g) => api(`/api/match-detail?gameId=${encodeURIComponent(g)}`).catch(() => null)),
  api('/api/matches?limit=500&refresh=1'),
];
await Promise.all(jobs);

const after = await api('/api/matches?limit=500&refresh=0');
const afterIds = new Set((after?.matches || []).map((m) => String(m.gameId)));
const lost = [...beforeIds].filter((g) => !afterIds.has(g));

ok(afterIds.size >= beforeIds.size, '并发写之后条目数没有变少', `（${beforeIds.size} → ${afterIds.size}）`);
ok(lost.length === 0, '原有条目一条没丢', lost.length ? `丢了 ${lost.slice(0, 3).join(', ')}` : '');

/* ─────────── P7：归属只认「本人在这局里」 ─────────── */
const ME = 'puuid-me';
const OTHER = 'puuid-other';
const game = (ids) => ({
  gameId: 401100000001,
  gameCreation: 1_700_000_000_000,
  gameDuration: 900,
  queueId: 2400,
  mapId: 12,
  participants: ids.map((puuid, i) => ({ participantId: i + 1, championId: 1, stats: { kills: 1, deaths: 2, assists: 3, win: true } })),
  participantIdentities: ids.map((puuid, i) => ({ participantId: i + 1, player: { puuid } })),
});

const inGame = summarizeGame(game([ME, OTHER]), { myPuuid: ME });
ok(inGame.ownerPuuid === ME, '本人在局里 → 归属就是他', `（${inGame.ownerPuuid}）`);

const notInGame = summarizeGame(game([OTHER, 'puuid-x']), { myPuuid: ME });
ok(!notInGame.ownerPuuid, '本人不在局里 → 归属留空（归入 unowned）', `（${JSON.stringify(notInGame.ownerPuuid)}）`);
ok(notInGame.hasMe === false, '本人不在局里 → hasMe 为假（不会被当成他的战绩）');

// 换号场景的收口：旧号那局已经登记过主人，后来换到新号再扫一遍，主人不能被改掉
const oldEntry = { gameId: 401100000001, ownerPuuid: 'puuid-old-account', champion: '某英雄', kills: 1 };
const rescanned = mergeEntry(oldEntry, summarizeGame(game(['puuid-old-account']), { myPuuid: ME }));
ok(rescanned.ownerPuuid === 'puuid-old-account', '换号后重扫：已登记的归属不被改写', `（${rescanned.ownerPuuid}）`);

/* ─────────── 附：只读详情不再设归属闸（v1.2.4） ─────────── */
const bogus = await api('/api/match-detail?gameId=401199999999');
ok(!bogus.ok, '编造的 gameId 打不开详情', `（${bogus.code || bogus.error}）`);

// 只读详情现在**任何真实 gameId 都能打开**（大哥要求去掉那道闸）。
// 真正还守着边界的是判定那条路 —— 别人的局不许进「我的战绩」。
// owned 只描述「能不能判」，不描述「能不能看」，这两件事分开断言。
ok(ownsLocally({ owner: 'puuid-x' }) === true, 'owned：已登记归属 → 属本机');
ok(ownsLocally({ meInGame: true }) === true, 'owned：本人在这一局里 → 属本机');
ok(ownsLocally({}) === false, 'owned：两条都不成立 → 不属本机（能看不能判）');

/* ─────────── 「查某人 → 点开他的对局」必须真的跑一遍 ─────────── */
// 这条路径正是归属闸第 ③ 条判据要保护的，也是最容易误伤的地方。
// 之前用空查询取样本，而 findPlayers 对空串直接返回 []，
// 整块被跳过 —— 等于这条路径一直没有人守着。现在从名录里取一个真人来查。
//
// 挑「局数最少」的那个：后面要逐局读详情，人挑小一点的跑得快。
// 输出里只打 puuid 前 8 位 —— 名录里是真实昵称，自检日志不落真名。
function pickProbeTerm() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/roster.json'), 'utf8'));
    const count = new Map();
    const nameOf = new Map();
    for (const gid of Object.keys(r.games || {})) {
      for (const p of r.games[gid] || []) {
        if (!p?.puuid) continue;
        count.set(p.puuid, (count.get(p.puuid) || 0) + 1);
        if (p.name) nameOf.set(p.puuid, p.name);
      }
    }
    let best = null;
    for (const [puuid, n] of count) if (!best || n < best.n) best = { puuid, n };
    return best ? (nameOf.get(best.puuid) || best.puuid) : null;
  } catch {
    return null;
  }
}

// 名录是懒播种的（第一次调 /api/roster 才从历史抓取里导进来），先叫一次再读盘
await api('/api/roster').catch(() => null);
const term = pickProbeTerm();
ok(!!term, '名录里取到了一个查询词', term ? '' : '（名录是空的 —— 先开着客户端跑一次 /api/matches 攒名录）');

if (term) {
  const hits = await api(`/api/summoner/search?q=${encodeURIComponent(term)}`).catch(() => null);
  const who = (hits?.hits || [])[0];
  ok(!!who, '按名录里取到的人 → 搜得到', who ? `（puuid ${String(who.puuid).slice(0, 8)}…）` : `（search 没命中：${hits?.error || '空结果'}）`);

  if (who) {
    const sm = await api(`/api/summoner/matches?puuid=${encodeURIComponent(who.puuid)}&refresh=0`).catch(() => null);
    const g = (sm?.matches || [])[0]?.gameId;
    ok(!!g, '查到他的对局列表', g ? `（${sm.matches.length} 局）` : `（${sm?.error || '空列表'}）`);

    // 「查某人」的清单 = 名录 ∪ 客户端战绩。名录那份是「他跟我同过场」的局，
    // 客户端那份是他自己打过的局（我不在场也能拿到）——后者是这次新增的来源。
    const fromRoster = Number(sm?.scannedFromRoster);
    const fromClient = Number(sm?.scannedFromClient);
    ok(Number.isFinite(fromRoster) && Number.isFinite(fromClient),
      '查询响应带两个来源的计数', `（名录 ${sm?.scannedFromRoster} / 客户端 ${sm?.scannedFromClient}）`);
    ok(Number(sm?.scanned) >= fromRoster,
      '并集不丢名录里的局', `（合计 ${sm?.scanned} ≥ 名录 ${fromRoster}）`);

    if (g) {
      const fine = await api(`/api/match-detail?gameId=${g}&perspective=${encodeURIComponent(who.puuid)}`);
      ok(!!fine.ok, '查某人 → 点开他的对局：合法路径没被误伤', fine.ok ? '' : `（${fine.code || fine.error}）`);

      // owned=false = 这局不属于本机账号：**能看**（归属闸 v1.2.4 已去掉），也能判
      // （v1.2.7：判定开放给别人的局，按 gameId 缓存），但**不写 matches.json**。
      ok(fine.owned !== undefined, '详情返回带 owned 标志', `（owned=${fine.owned}）`);
      if (fine.owned === false) {
        ok(true, '陌生对局标记 owned=false（界面据此说明「不会进我的战绩」）');

        // ★ v1.2.4 的核心行为：**不带 perspective 也能打开**。
        //   这类局过去必被 NOT_MY_MATCH 挡掉；有人把归属闸加回来时这里立刻变红。
        const bare = await api(`/api/match-detail?gameId=${g}`);
        ok(bare.ok === true, '陌生对局不带 perspective 也能打开（归属闸已去掉）',
          bare.ok ? `（owned=${bare.owned}）` : `（被拒：${bare.code || bare.error}）`);
        ok((bare.dataset?.players || []).length === 10,
          '陌生对局能读到完整 10 人', `（实到 ${(bare.dataset?.players || []).length} 人）`);
      } else if (fine.owned === true) {
        ok(true, '这局属于本机账号（owned 为真，可判定）');
      }
    }
  }
}

console.log('');
/* ─────────── 搜索历史（v1.2.7） ─────────── */
// 「下次直接选择即可」：记一笔 → 能读回来 → 清得掉。
{
  const puuid = 'puuid-history-probe-0001';
  const put = await api('/api/search-history', {
    method: 'POST',
    body: JSON.stringify({ puuid, name: '历史测试', hits: 3 }),
  });
  ok(put.ok === true, '搜索历史：能记一笔');
  ok((put.items || []).some((x) => x.puuid === puuid), '记完能在返回里看到');
  const got = await api('/api/search-history');
  ok((got.items || []).some((x) => x.puuid === puuid), '重新读还在（落盘了）');
  const cleared = await api('/api/search-history', { method: 'DELETE' });
  ok(cleared.ok === true && !(cleared.items || []).some((x) => x.puuid === puuid), '能清空');
}

if (fail.length) {
  console.log(`  结果：✗ ${fail.length} 项未通过 —— ${fail.join(' / ')}`);
  console.log('');
  process.exit(1);
}
console.log('  结果：✓ 并发写不丢条目；对局归属只认「本人是否在局里」');
console.log('');
process.exit(0);
