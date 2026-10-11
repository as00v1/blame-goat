/* ──────────────────────────────────────────────────────────
   BlameGoat 界面原型 · 流程控制
   零依赖，不连任何接口。数据来自 data.js（离线 mock）
   ────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const BB = window.BB || {};
  const PR = window.BB_PROMPT || {};
  const BBX = window.BBX || { available: false, state: { online: false } };

  // 当前展示的数据集。默认是内置样例（离线也能看），
  // 联机后由 applyReport() 换成真实判定结果
  let dataset = BB.dataset;
  // 这一局是不是「本机账号的局」。查别人拉到的陌生局为假 —— 能看不能判，
  // 判定会写战报并把这一局记进「我的战绩」，别人的局不能进我的库。
  let detailOwned = true;
  let result = BB.result;   // 上屏前会过一遍 sanitizeResultText（老战报里的阵营编号要翻成人话）
  let pidToName = Object.assign({}, BB.names || {});   // 已是 pid → 昵称
  let meta = Object.assign({}, BB.meta || {});
  result = sanitizeResultText(result, dataset);   // 页面注入的快照同样可能是老文案
  // 当前正在看的这一局 —— 详情与战报共用。页顶那颗「开始分析 / 重新判定」按它去调接口
  let currentGameId = null;

  const LABEL_CN = { CARRY: '大腿', BLAME: '背锅侠', TEFLON: '不粘锅', FREELOADER: '混子', NORMAL: '普通' };
  const TYPE_CN = {
    FIGHTER: '战士', MAGE: '法师', ASSASSIN: '刺客', TANK: '坦克',
    MARKSMAN: '射手', SUPPORT: '辅助',
  };
  const roleCn = (t) => TYPE_CN[t] || t || '';   // 职业中文名（与事件类型 typeCn 区分）
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let byPid = {};
  let resByPid = {};
  function indexData() {
    // result 可能为空 —— 「详情」态就是这样：有客观数据、还没判定。
    // 这里不能假设它一定在，否则一进详情页就整页崩。
    byPid = Object.fromEntries((dataset?.players || []).map((p) => [p.pid, p]));
    resByPid = Object.fromEntries(((result && result.players) || []).map((r) => [r.pid, r]));
  }
  indexData();

  const nameOf = (pid) => pidToName[pid] || pid;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ─────────── 敌我着色 ───────────
     界面上一出现召唤师名字就得能分清敌友，所以「取阵营」只有这一处实现。
     视角丢失（myTeamId 为 null）时一律返回空 —— 那一刻 10 个人全落在「敌方」里，
     照着 isMyTeam 上色会把整张表染红，等于骗人；全灰才是对的。 */
  const sideOf = (p) => {
    if (!p || dataset?.match?.myTeamId == null) return '';
    return p.isMyTeam ? 'my' : 'enemy';
  };
  const sideOfPid = (pid) => sideOf(byPid[pid]);

  /** 一个带阵营色的昵称（结构化列表用） */
  const nameSpan = (pid) => `<span class="nm" data-side="${sideOfPid(pid)}">${esc(nameOf(pid))}</span>`;

  /** 正则转义 —— 昵称里出现 . * ( ) [ ] 之类时不能把它当元字符 */
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * 长文里点到的昵称也上色 —— 判定理由、局势总览、播报稿都是模型写的一整段，
   * 里面点名最频繁，只给列表上色等于漏掉一半。
   *
   * 入参必须是**已 esc 的文本**（先转义再替换，插入的标签不会被当成文本）。
   */
  function colorizeNames(safeText) {
    if (typeof safeText !== 'string' || !safeText) return safeText;
    if (dataset?.match?.myTeamId == null) return safeText;
    const map = new Map();
    for (const p of dataset.players || []) {
      const side = sideOf(p);
      if (!side) continue;
      const nm = esc(nameOf(p.pid));
      // 单字昵称不参与：一个汉字太容易跟正文撞上，宁可漏也别错
      if (nm && nm.length >= 2) map.set(nm, side);
    }
    const names = [...map.keys()].sort((a, b) => b.length - a.length);
    if (!names.length) return safeText;
    // 一次扫描、长名优先：既不会把「影流」切成「影」+「流」，
    // 也不会二次命中刚插进去的 span —— replace 只扫原始串
    const re = new RegExp(names.map(escapeRe).join('|'), 'g');
    return safeText.replace(re, (m) => `<span class="nm" data-side="${map.get(m)}">${m}</span>`);
  }

  /* ─────────── 轻提示 ─────────── */
  let toastTimer = null;
  function toast(msg, isErr) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = (isErr ? 'err ' : '') + 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = isErr ? 'err' : ''; }, 4600);
  }

  /* ─────────── 页面切换 + 返回栈 ─────────── */
  const PAGES = ['idle', 'analyzing', 'report', 'config'];

  // 两套页签各有自己的页签栏与页签名：战报页 4 个（本局相关）/ 配置页 2 个（全局配置）
  const TAB_GROUPS = {
    report: { bar: '#tabs', attr: 'data-tab' },
    config: { bar: '#cfgTabs', attr: 'data-ctab' },
  };

  // 返回栈：记「离开某处前所在的位置」。
  // 只记页面级（等待页 / 战报页 / 配置页及其页签），且同位置去重 ——
  // 否则连点几局同页签的行情，栈里会堆一摞一模一样的东西，返回一次才退一格。
  const navStack = [];

  /** 当前位置：等待页，或 战报页 / 配置页 + 当前页签 */
  function currentLoc() {
    if ($('#page-idle').classList.contains('active')) return { page: 'idle', tab: null };
    if ($('#page-config').classList.contains('active')) {
      const t = $('#cfgTabs .tab.active');
      return { page: 'config', tab: t ? t.dataset.ctab : 'settings' };
    }
    const t = $('#tabs .tab.active');
    return { page: 'report', tab: t ? t.dataset.tab : 'report' };
  }

  /** 进新页面前调用：把当前位置压栈 */
  function pushNav() {
    const loc = currentLoc();
    const top = navStack[navStack.length - 1];
    if (top && top.page === loc.page && top.tab === loc.tab) return;
    navStack.push(loc);
    if (navStack.length > 20) navStack.shift();
  }

  /** 回到某个位置（页 + 页签） */
  function gotoLoc(loc) {
    if (!loc || !loc.page || loc.page === 'idle') { show('idle'); return; }
    show(loc.page);
    const g = TAB_GROUPS[loc.page];
    if (!g) return;
    const tab = $(`${g.bar} .tab[${g.attr}="${loc.tab}"]`);
    if (tab) tab.click();
  }

  /** 返回上一层：栈空或上一层是等待页 → 回等待页 */
  function goBack() {
    gotoLoc(navStack.pop());
  }

  function show(page) {
    PAGES.forEach((p) => $('#page-' + p).classList.toggle('active', p === page));
    // 离开判定页就把秒表停掉 —— 没人再看那一行，没必要每 200ms 刷一次 DOM
    if (page !== 'analyzing') stopJudgeTick();
    // 返回按钮挂在「战报 / 配置」两个非首页上：判定过程中不给返回，
    // 免得点了以后旧流程又把页面顶回去
    const back = $('#btnBack');
    if (back) back.classList.toggle('hidden', page !== 'report' && page !== 'config');
  }

  /* ─────────── IDLE ─────────── */
  const ANALYZE_STEPS = [
    '读取对局数据',
    '整理客观数据',
    '按当前提示词判定',
    '校验输出',
  ];

  const PHASE_CN = {
    None: 'Idle', Lobby: '大厅', Matchmaking: '匹配中', ReadyCheck: '确认对局',
    ChampSelect: '选人中', GameStart: '进入对局', InProgress: '对局进行中',
    WaitingForStats: '结算中', PreEndOfGame: '即将结束', EndOfGame: '对局已结束',
    TerminatedInError: '异常结束',
  };

  $('#btnSimulate').addEventListener('click', runSimulation);
  $('#btnLive').addEventListener('click', runLive);
  $('#btnScan').addEventListener('click', runScan);
  $('#btnBack').addEventListener('click', goBack);

  /**
   * 从主页进配置页（设置 / 提示词）。
   *
   * 配置是全局的、跟具体哪一局无关 —— 所以它不挂在战报页的页签里：
   * 否则每翻一局战报，上面都顶着「设置 / 提示词」两个跟本局无关的入口。
   */
  function openConfig(ctab) {
    pushNav();
    show('config');
    const tab = $(`#cfgTabs .tab[data-ctab="${ctab}"]`);
    if (tab) tab.click();
  }
  $('#btnSettings').addEventListener('click', () => openConfig('settings'));
  $('#btnPrompt').addEventListener('click', () => openConfig('prompt'));

  /** 探测客户端（走真实 LCU 自检） */
  async function runScan() {
    if (!BBX.available) { toast('当前是离线打开，请用 start.bat 启动后再探测', true); return; }
    if (!BBX.state.online) { toast('未连接本地服务', true); return; }

    $('#clientDot').className = 'dot warn';
    $('#clientText').textContent = '探测中…';
    try {
      const st = await BBX.selftest();
      applyClientState(st);
      toast(st.error ? st.error : `客户端就绪 · 阶段 ${PHASE_CN[st.phase] || st.phase || '-'}`, !!st.error);
    } catch (e) {
      toast('探测失败：' + e.message, true);
    }
  }

  /** 把自检结果铺到顶部芯片与首页状态条 */
  function applyClientState(st) {
    const dot = $('#clientDot');
    const home = $('#homeDot');
    // 顶部芯片与首页状态条是同一份状态的两处呈现，一起改，免得显示打架
    const setDot = (cls) => { dot.className = cls; if (home) home.className = cls; };

    if (!st || !st.installed) {
      setDot('dot off');
      $('#clientText').textContent = '未检测到客户端';
      $('#clientPort').textContent = '—';
      $('#metaClient').textContent = '未安装';
      $('#metaPort').textContent = '—';
      $('#metaPhase').textContent = '—';
      return;
    }
    if (!st.running || !st.responsive) {
      setDot('dot warn');
      $('#clientText').textContent = st.running ? '客户端启动中' : '客户端未运行';
      $('#clientPort').textContent = '—';
      $('#metaClient').textContent = st.running ? '启动中' : '未运行';
      $('#metaPort').textContent = '—';
      $('#metaPhase').textContent = 'Idle';
      return;
    }
    setDot('dot');
    $('#clientText').textContent = '客户端已连接';
    $('#clientPort').textContent = st.port ? String(st.port) : '—';
    // 首页状态条显示「当前登录账号」比显示「已连接」有用
    $('#metaClient').textContent = st.summoner?.displayName || '已连接';
    $('#metaPort').textContent = st.port ? String(st.port) : '—';
    $('#metaPhase').textContent = PHASE_CN[st.phase] || st.phase || 'Idle';
    $('#metaMode').textContent = dataset?.match?.mode || '—';
  }

  /* ─────────── 判定真进度（服务端 SSE 的 judging 事件） ─────────── */

  /**
   * 判定阶段的中文名。字面量与 src/deepseek/judge.mjs 的 JUDGE_PHASES 对应 ——
   * 那边加阶段，这里要跟着加，否则会显示成原始英文。
   */
  const JUDGE_PHASE_CN = {
    prepare: '整理客观数据',
    submit: '已提交给模型',
    wait: '模型思考中',
    stream: '模型输出中',
    parse: '校验输出',
    done: '判定完成',
    fallback: '已改用本地兜底判定',
  };
  /** 阶段 → 落在四步动画的第几步（0 起） */
  const PHASE_STEP = { prepare: 1, submit: 1, wait: 2, stream: 2, parse: 3, done: 3, fallback: 3 };

  let judging = null;      // 最近一条推进度
  let judgingAt = 0;       // 收到它的本地时刻 —— 用来在两次事件之间自己接着走秒
  let judgeTick = null;

  const judgeOver = () => !!judging && (judging.phase === 'done' || judging.phase === 'fallback');

  /** 把四步动画摆到某个阶段该有的样子（真进度接管后，假动画的定时器会被清掉） */
  function syncStepsToPhase(phase) {
    const box = $('#steps');
    const bar = $('#progressBar');
    if (!box || !bar) return;
    const idx = PHASE_STEP[phase] ?? 2;
    box.querySelectorAll('.step').forEach((el) => {
      const i = Number(el.dataset.i);
      // 判定那一步（第 3 步）在「模型输出中」时是进行中，不能提前打勾
      el.className = 'step' + (i < idx ? ' is-done' : (i === idx ? ' is-active' : ''));
    });
    bar.style.width = ((idx + 1) / ANALYZE_STEPS.length) * 100 + '%';
  }

  function fmtSec(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + 's'; }
  function fmtChars(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k 字' : n + ' 字'; }

  function renderJudgeStatus() {
    const box = $('#judgeStatus');
    if (!box || !judging) return;
    const elapsed = judging.elapsedMs + (Date.now() - judgingAt);
    const text = JUDGE_PHASE_CN[judging.phase] || judging.phase || '判定中';
    let meta = fmtSec(elapsed);

    if (judging.phase === 'stream') meta = `${fmtSec(elapsed)} · 已输出 ${fmtChars(judging.chars || 0)}`;
    else if (judging.phase === 'wait') meta = `${fmtSec(elapsed)} · 还没开始输出`;
    else if (judging.phase === 'parse') meta = `${fmtSec(elapsed)} · ${fmtChars(judging.chars || 0)}`;
    else if (judging.phase === 'done') meta = `用时 ${fmtSec(judging.elapsedMs)}`;

    const isFallback = judging.phase === 'fallback';
    box.classList.toggle('is-fallback', isFallback);
    box.classList.remove('hidden');
    $('#judgeText').textContent = text;
    $('#judgeMeta').textContent = isFallback
      ? (judging.reason ? `原因：${judging.reason}` : '')
      : meta;
  }

  function stopJudgeTick() {
    if (judgeTick) { clearInterval(judgeTick); judgeTick = null; }
  }

  /** 收到一条推进度：真进度接管假动画，并起一个 200ms 的秒表让「已用 Xs」自己走 */
  function onJudgeProgress(ev) {
    if (!ev || !ev.phase) return;
    // prepare = 新的一局开始判定 —— 上一轮的残留状态必须清掉，否则会显示上一局的字数
    if (ev.phase === 'prepare') {
      judging = null;
      stopJudgeTick();
      const box = $('#judgeStatus');
      if (box) { box.classList.add('hidden'); box.classList.remove('is-fallback'); }
    }
    judging = ev;
    judgingAt = Date.now();
    stopFakeSteps();
    if ($('#page-analyzing')?.classList.contains('active')) {
      syncStepsToPhase(ev.phase);
      renderJudgeStatus();
    }
    // 收尾阶段（done / fallback）必须把秒表停掉 —— 否则那 200ms 的 tick 会一直转下去，
    // 页面早就切走了还在刷 DOM（浏览器里是泄漏，无头自检里是进程不退出）
    if (judgeOver()) { stopJudgeTick(); renderJudgeStatus(); return; }
    if (!judgeTick) judgeTick = setInterval(renderJudgeStatus, 200);
  }

  /** 兜底原因 —— 判完弹提示时用，让用户知道「这次为什么不是模型写的」 */
  function fallbackWhy() {
    return judging && judging.phase === 'fallback' ? (judging.reason || '未知原因') : '';
  }

  /**
   * 等动画，但最多等 ms。
   *
   * 为什么要上限：动画是一个「观感」，而它挡在「取到结果 → 切战报页」这条主链路上。
   * 一旦它因为任何原因不 resolve，判定明明已经完成、状态行也写了「判定完成」，
   * 页面却会永远停在「正在生成战报」上，而且那一页**没有任何出口**（v1.2.1 事故）。
   * 所以宁可多演 0.1 秒，也绝不能让它有机会把用户困住。
   */
  function capWait(p, ms = 6000) {
    if (!p) return Promise.resolve();
    return Promise.race([p, new Promise((res) => setTimeout(res, ms))]);
  }

  let fakeStepTimers = [];
  // 真进度接管过 → 假动画不再碰 DOM（但它仍然要 resolve，见 animateSteps 里的收尾定时器）
  let fakeStepsHandedOver = false;
  function stopFakeSteps() {
    fakeStepTimers.forEach(clearTimeout);
    fakeStepTimers = [];
    fakeStepsHandedOver = true;
  }

  /**
   * 跑一遍 4 步进度动画，返回 Promise。
   * 真实判定时与网络请求并行，保证「动画不短于请求」的观感：
   * 请求快 → 动画跑完再进；请求慢 → 动画停在最后一步等结果。
   *
   * ★ 服务端已经在推真进度时（判定往往十几秒），假动画会让位 ——
   *   用户要看的是「模型写了多少字」，不是「我们演到第三步了」。
   */
  function animateSteps({ minMs = 1300 } = {}) {
    return new Promise((resolve) => {
      show('analyzing');
      fakeStepsHandedOver = false;      // 每次重演都重新允许自己改 DOM
      const box = $('#steps');
      box.innerHTML = ANALYZE_STEPS
        .map((t, i) => `<div class="step" data-i="${i}"><span class="mark"></span><span>${t}</span><span class="time"></span></div>`)
        .join('');
      const bar = $('#progressBar');
      bar.style.width = '0%';

      // 真进度已经在跑 → 不演了，摆到它当前的阶段，补一个极短进场就交还控制权
      if (judging && !judgeOver()) {
        stopFakeSteps();
        syncStepsToPhase(judging.phase);
        renderJudgeStatus();
        if (!judgeTick) judgeTick = setInterval(renderJudgeStatus, 200);
        setTimeout(resolve, 120);
        return;
      }
      stopFakeSteps();

      const t0 = Date.now();
      const stepMs = 420;
      // 定时器收进数组：真进度一到（onJudgeProgress）就把这一整套假动画掐掉，
      // 否则两边会抢着改同一批 .step，界面上就是步骤来回跳
      const later = (fn, ms) => { fakeStepTimers.push(setTimeout(fn, ms)); };
      ANALYZE_STEPS.forEach((_, i) => {
        later(() => {
          if (fakeStepsHandedOver) return;      // 真进度已接管，别再改 DOM
          const el = box.querySelector(`.step[data-i="${i}"]`);
          if (i > 0) {
            const prev = box.querySelector(`.step[data-i="${i - 1}"]`);
            prev.className = 'step is-done';
            prev.querySelector('.time').textContent = 'done';
          }
          el.className = 'step is-active';
          bar.style.width = ((i + 1) / ANALYZE_STEPS.length) * 100 + '%';
        }, stepMs * i);
      });

      /* 收尾定时器**故意绕开 later()**。
         ★ v1.2.1 事故：第一版把它写在「最后一步」的回调里 ——
           而那一步的回调会被 stopFakeSteps() 清掉，收尾压根没被创建过，
           animateSteps 的 Promise 永不 resolve → `await anim` 挂死 →
           判定早已完成、状态行写着「判定完成」，页面却不往下走，
           而「正在生成战报」那一页没有任何出口。
           真判定动辄十几秒，几乎必然落进这个窗口。
           现在它独立排队：假动画被掐断也照样 resolve（只是不再改 DOM）。 */
      const lastIdx = ANALYZE_STEPS.length - 1;
      // 最后一步的时刻，与「至少演满 minMs」取较大者
      const tailAt = Math.max(stepMs * lastIdx, minMs);
      setTimeout(() => {
        const el = box.querySelector(`.step[data-i="${lastIdx}"]`);
        if (!fakeStepsHandedOver && el) {
          el.className = 'step is-done';
          el.querySelector('.time').textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
        }
        setTimeout(resolve, 320);
      }, tailAt);
    });
  }

  /** 演示一局：默认用内置样例数据；联机时改走服务端，能套上真实英雄头像与称号 */
  async function runSimulation() {
    pushNav();
    // 联机时这一步会真调模型（可能十几秒）—— 进度页必须和请求并行，
    // 不能像原来那样先干等请求回来、再补演 1.7 秒假动画。
    let served = null;
    let animated = false;
    if (BBX.available && BBX.state.online) {
      const anim = animateSteps({ minMs: 900 });
      try { served = await BBX.analyze('mock', tone); } catch { served = null; }
      await capWait(anim);
      animated = true;
    }
    if (served && served.ok && served.report) {
      applyReport(served.report);
      show('report');
      return;
    }
    // 离线 / 服务端不可用 → 退回纯前端演示动画 + 内置样例。
    // 刚才已经跑过一遍动画就不必再来一次（避免连演两轮）。
    if (!animated) await capWait(animateSteps({ minMs: 1700 }), 8000);
    renderReport();
    show('report');
  }

  /** 读取上一局：走本机服务 → LCU → 真实判定 */
  async function runLive() {
    if (!BBX.available) {
      toast('当前是离线打开，请用 start.bat 启动后再读取真实对局', true);
      return;
    }
    if (!BBX.state.online) {
      const ok = await BBX.probe();
      if (!ok) { toast('未连接本地服务', true); return; }
    }

    pushNav();
    // 同 analyzeOne：不同步亮进度页，先看请求能不能很快收工。
    // 命中缓存 / 秒失败都直接出结果，只有真判定（慢）才把进度页摆出来。
    // 按钮先自己进忙碌态，免得那 900ms 里看着像没点动。
    setBtnBusy('#btnLive', true, '读取中…');

    let anim = null;
    let res;
    try {
      const req = BBX.analyze('live', tone);
      if (!(await settledWithin(req, 900))) anim = animateSteps({ minMs: 900 });
      res = await req;
      if (anim) await capWait(anim);
    } catch (e) {
      if (anim) await capWait(anim);
      setBtnBusy('#btnLive', false);
      toast('请求失败：' + e.message, true);
      show('idle');
      return;
    }
    setBtnBusy('#btnLive', false);

    if (!res || !res.ok) {
      toast(res?.error || '读取失败', true);
      show('idle');
      return;
    }
    applyReport(res.report);
    show('report');
    // 这一局可能早就算过了（服务端直接回放盘里的战报）—— 说清楚，免得以为又烧了一次模型
    // 同上：兜底时把原因讲明白（超时 / 校验不过 / 没 Key 是三件不同的事）
    const why = res.report.meta?.source === 'fallback' ? fallbackWhy() : '';
    toast(res.fromCache
      ? '这局之前判定过，直接读盘里的战报'
      : (why ? `模型没给出可用结果（${why}）—— 已用本地兜底，可点「重新判定」再试一次`
        : '战报已生成（DeepSeek 判定）'));
  }

  /**
   * 报告文字里的阵营编号兜底清理。
   *
   * v1.1.1 起 dataset 里已经没有 100 / 200 了（送模型前换成了「我方 / 敌方」），
   * 但**盘里的老战报**还写着「100队…200队…」——那是系统内部编号，人看不懂。
   * 这里在渲染前翻回阵营词。只认「三位数字 + 队」，伤害 100、金币 200 都不动。
   */
  function sanitizeResultText(res, ds) {
    if (!res) return res;
    const my = ds?.match?.myTeamId;
    if (my == null) return res;
    const fix = (s) => (typeof s === 'string'
      ? s.replace(/(\d{3})\s*队/g, (w, n) => {
        const v = Number(n);
        if (v !== 100 && v !== 200) return w;
        return v === Number(my) ? '我方' : '敌方';
      })
      : s);
    return {
      ...res,
      verdict: fix(res.verdict),
      insight: fix(res.insight),
      teamInsight: res.teamInsight
        ? Object.fromEntries(Object.entries(res.teamInsight).map(([k, v]) => [k, fix(v)]))
        : res.teamInsight,
      players: (res.players || []).map((p) => ({
        ...p,
        reason: fix(p.reason),
        evidence: Array.isArray(p.evidence) ? p.evidence.map(fix) : p.evidence,
      })),
    };
  }

  /** 把一份战报切成当前展示的数据集 */
  function applyReport(report) {
    if (!report || !report.dataset || !report.result) return;
    detailOwned = true;      // 战报都是自己判过的局，不存在「别人的局」
    dataset = report.dataset;
    result = sanitizeResultText(report.result, report.dataset);
    pidToName = Object.assign({}, report.names || {});
    meta = Object.assign({}, report.meta || {});
    currentGameId = String(report.dataset?.match?.gameId || '');
    indexData();
    renderPreview();   // 提示词预览里的 dataset 同步换成新数据
    renderReport();
    refreshMatchFlags();   // 刚判定完 → 列表里的「已分析」标记要跟着变
  }

  /**
   * 把一局「详情」切成当前展示的数据集 —— 有客观数据，没有判定。
   *
   * 跟 applyReport 走同一套渲染，只是 result 留空：评分 / 结论两列显示「待分析」，
   * 页顶那颗「开始分析」才是唯一真正花钱的地方。
   * 这是「点一行不再自动烧 token」的落点。
   */
  function applyDetail(view) {
    if (!view || !view.dataset) return;
    // owned=false = 查别人拉到的陌生局：能看，不能判（renderAnalyzeBar 据此收起按钮）
    detailOwned = view.owned !== false;
    dataset = view.dataset;
    result = null;
    pidToName = Object.assign({}, view.names || {});
    meta = { source: null, fromCache: false };
    currentGameId = String(view.gameId || view.dataset?.match?.gameId || '');
    indexData();
    renderPreview();
    renderReport();
  }

  /* ─────────── 战报 ─────────── */
  function sourceLabel() {
    const src = meta.source;
    if (src === 'deepseek') return `DeepSeek ${meta.model || 'v4-flash'} 判定`;
    if (src === 'fallback') return '本地兜底判定（未过模型）';
    return src || '内置样例数据';
  }

  /* ─────────────── 分类展示 ───────────────
     同一批 10 个人，三种看法：
       按阵营 —— 谁是我的队友（不可替代的一维，也是默认）
       按结论 —— 谁该背锅，一眼看完
       按定位 —— 这个阵容缺了什么
     数据与判定一个字都不改，只是换个排法。组内一律按分数降序；
     没判定的局分数缺失，排序退化成原序 —— 不影响任何显示。 */

  let groupBy = 'side';

  /** 结论的展示顺序：先功臣，再锅，最后是不功不过的 */
  const LABEL_ORDER = ['CARRY', 'BLAME', 'FREELOADER', 'TEFLON', 'NORMAL'];
  /** 定位的展示顺序：从前排到后排，跟看阵容表一个读法 */
  const ROLE_ORDER = ['坦克', '战士', '刺客', '法师', '射手', '辅助'];

  /** 未判定时分数记 -1 —— 只是排序哨兵，不会显示到界面上 */
  const scoreOf = (p) => {
    const r = resByPid[p.pid];
    return r && typeof r.score === 'number' ? r.score : -1;
  };
  const byScoreDesc = (a, b) => scoreOf(b) - scoreOf(a);

  /* 分数显示：v1.2.5 起模型给的是 0-10 分（可带一位小数）。
     兜底成整数才不显示 "8.0000000001" 这种浮点尾巴；
     服务端已经把老战报的 0-100 折成 0-10，这里不再二次换算。 */
  const fmtScore = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const r = Math.round(n * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  /** 分数条宽度：0-10 分要乘 10 才是百分比 */
  const clampPct = (v) => Math.max(0, Math.min(100, Number(v) * 10));

  /** 「我方 3 · 敌方 2」—— 结论 / 定位视图里，光看组名认不出谁是哪边的 */
  function sideMix(ps) {
    const my = ps.filter((p) => p.isMyTeam).length;
    if (!ps.length) return '';
    if (!my) return `全在敌方 ${ps.length}`;
    if (my === ps.length) return `全在我方 ${ps.length}`;
    return `我方 ${my} · 敌方 ${ps.length - my}`;
  }

  /** 「大腿×2 · 混子×1」—— 阵营视图的组标题摘要，替用户先数一遍 */
  function labelMix(ps, judged) {
    if (!judged) return '未判定 · 只有客观数据';
    const n = {};
    for (const p of ps) {
      const l = (resByPid[p.pid] || {}).label || 'NORMAL';
      n[l] = (n[l] || 0) + 1;
    }
    return LABEL_ORDER.filter((l) => n[l]).map((l) => `${LABEL_CN[l]}×${n[l]}`).join(' · ');
  }

  function buildRoleGroups(ps) {
    const order = [];
    for (const p of ps) {
      const r = roleCn(p.championType) || '其他';
      if (!order.includes(r)) order.push(r);
    }
    const rank = (r) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? 99 : i; };
    order.sort((a, b) => rank(a) - rank(b));
    return order.map((r, i) => {
      const members = ps.filter((p) => (roleCn(p.championType) || '其他') === r).sort(byScoreDesc);
      return { id: `R${i}`, title: r, tone: 'role', players: members, note: sideMix(members) };
    });
  }

  function buildGroups() {
    const ps = [...(dataset.players || [])];
    const judged = !!result;

    if (groupBy === 'label') {
      // 没判定就没有「结论」可分类 —— 退回按定位，总比 10 个人全挤进「待分析」一组强
      if (!judged) return buildRoleGroups(ps);
      return LABEL_ORDER
        .map((lab, i) => {
          const members = ps.filter((p) => ((resByPid[p.pid] || {}).label || 'NORMAL') === lab);
          if (!members.length) return null;
          return {
            id: `L${i}`, title: LABEL_CN[lab], tone: lab,
            players: members.sort(byScoreDesc), note: sideMix(members),
          };
        })
        .filter(Boolean);
    }

    if (groupBy === 'role') return buildRoleGroups(ps);

    // 按阵营（默认）—— id 固定成 Ally / Enemy，于是 DOM 里仍是 #rowsAlly / #rowsEnemy，
    // 老工具（快照渲染器、冒烟测试）不必改就还认得。
    const ally = ps.filter((p) => p.isMyTeam).sort(byScoreDesc);
    const enemy = ps.filter((p) => !p.isMyTeam).sort(byScoreDesc);
    return [
      { id: 'Ally', title: judged ? '我方判定' : '我方', tone: 'my', players: ally, note: labelMix(ally, judged) },
      { id: 'Enemy', title: judged ? '敌方判定' : '敌方', tone: 'enemy', players: enemy, note: labelMix(enemy, judged) },
    ].filter((g) => g.players.length);
  }

  /** 一段 = 色标 + 组名 + 人数 + 摘要，然后表头 + 行 */
  function groupBlock(g) {
    return `
    <div class="sb-block" data-group="${esc(g.id)}">
      <div class="section-title">
        <span class="gt-mark" data-tone="${esc(g.tone)}"></span>
        <span class="gt-name">${esc(g.title)}</span>
        <span class="count" id="cnt${esc(g.id)}">（${g.players.length} 人）</span>
        <span class="gt-note">${esc(g.note)}</span>
      </div>
      <div class="sb-head">
        <span>玩家 / 英雄</span><span>K / D / A</span><span>输出 / 承伤 / 治疗</span><span>海克斯</span><span>出装</span><span>评分</span><span>结论</span>
      </div>
      <div class="sb-list" id="rows${esc(g.id)}">${g.players.map(playerRow).join('')}</div>
    </div>`;
  }

  function renderGroups() {
    const box = $('#sbGroups');
    if (!box) return;
    const groups = buildGroups();
    box.innerHTML = groups.map(groupBlock).join('');

    const hint = $('#groupHint');
    if (hint) {
      const total = groups.reduce((n, g) => n + g.players.length, 0);
      hint.textContent = `${groups.length} 组 · ${total} 人`;
    }
    $$('.sb-item').forEach((el) => el.addEventListener('click', () => el.classList.toggle('open')));
  }

  /**
   * 我方胜负 —— 详情页（未判定）也要看得见，因为胜负是客观数据，不依赖模型。
   *
   * 优先取 match.myResult（落盘时 normalize 定的）；老战报没这个字段就从时间轴的
   * GameEnd 反推。两边都没有（= 认不出我方是哪一边）就把整枚徽标收起来：
   * 不知道我方是谁，就谈不上「我方胜负」，猜一个出来比不显示更糟。
   */
  function renderMyResult() {
    const el = $('#resBadge');
    if (!el) return;
    let r = dataset?.match?.myResult;
    if (r !== 'WIN' && r !== 'LOSE') {
      const myTeamId = dataset?.match?.myTeamId;
      const ge = (dataset?.timeline || []).find((t) => t.type === 'GameEnd' && t.winningTeam != null);
      r = ge && myTeamId != null
        ? (String(ge.winningTeam) === String(myTeamId) ? 'WIN' : 'LOSE')
        : null;
    }
    if (!r) { el.className = 'res-badge hidden'; el.textContent = ''; return; }
    el.className = `res-badge ${r === 'WIN' ? 'win' : 'lose'}`;
    el.textContent = r === 'WIN' ? '我方胜' : '我方负';
  }

  /**
   * 页顶右缘的对局 ID —— 点一下复制。
   *
   * 为什么放在这里、还做成可点的：判定前后显示的是同一个号，
   * 对一下 `data/reports/<gameId>.json` 就知道「刚才判的到底是哪一局」；
   * 查别人时更要用 —— 一屏十个人，只有这个号能唯一指认。
   * 复制优先走 Clipboard API，但 Electron 的 file:// 与老浏览器可能不给，
   * 降级用临时 textarea + execCommand（那条在 file:// 下也能用）。
   */
  function renderGidChip() {
    const chip = $('#gidChip');
    if (!chip) return;
    const gid = String(currentGameId || dataset?.match?.gameId || '');
    if (!gid) { chip.classList.add('hidden'); chip.textContent = ''; return; }
    chip.classList.remove('hidden');
    chip.textContent = '#' + gid;
    chip.dataset.gid = gid;
  }

  async function copyGid() {
    const chip = $('#gidChip');
    const gid = chip?.dataset?.gid || '';
    if (!gid) return;
    let ok = false;
    try { await navigator.clipboard.writeText(gid); ok = true; } catch { /* 降级 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = gid;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { /* 两条路都不行就只提示一下 */ }
    }
    const say = ok ? '已复制' : '复制失败，手动选中吧';
    chip.textContent = ok ? '已复制 ✓' : say;
    chip.classList.toggle('copied', ok);
    setTimeout(() => {
      chip.textContent = '#' + gid;          // 还原成 ID 本身
      chip.classList.remove('copied');
    }, 1400);
    toast(say);
  }

  function renderReport() {
    const judged = !!result;
    const bits = [
      judged ? `判定来源：<b>${esc(sourceLabel())}</b>` : '<b>对局详情</b>',
      `对局 ${esc(dataset.match.durationText)}`,
      esc(dataset.match.mode),
      `队列 ${esc(dataset.match.queueId)}`,
    ];
    if (meta.totalMs != null) bits.push(`耗时 ${(meta.totalMs / 1000).toFixed(1)}s`);
    if (meta.usage && meta.usage.total_tokens) bits.push(`${meta.usage.total_tokens} tokens`);
    $('#srcText').innerHTML = bits.join('　');
    // 未判定时用黄点：一眼看出「这份数据还没被模型读过」
    $('#srcDot').className = judged ? 'dot' : 'dot warn';
    renderGidChip();
    // 客户端 / 端口 / 阶段由 applyClientState 与 SSE 维护，这里不写死 ——
    // 只有「模式」是这份战报自带的，可以覆盖
    $('#metaMode').textContent = dataset.match.mode;

    // 结论与长文里都点名，所以走 innerHTML（先 esc 再按阵营上色）——
    // 这两段都是模型原文，绝不能把未转义的内容塞进 HTML
    $('#verdict').innerHTML = colorizeNames(esc(judged ? result.verdict : '这一局还没有判定'));
    // 局势总览只在判定后亮 —— 未判定时分析栏已经把「点右边按钮」说清楚了，
    // 这里再挂一段引导文就重复了。
    const insightWrap = $('#insightWrap');
    if (insightWrap) insightWrap.classList.toggle('hidden', !judged);
    $('#insight').innerHTML = colorizeNames(esc(judged ? result.insight : ''));

    renderMyResult();
    renderTeamInsight(judged ? result.teamInsight : null);
    renderAnalyzeBar();

    renderGroups();

    $('#timeline').innerHTML = (dataset.timeline || []).map(tlCard).join('');
    // 真机一局 190+ 条事件，靠滚动区兜住，不能把整页撑长
    $('#tlCount').textContent = (dataset.timeline || []).length ? `（${dataset.timeline.length} 条）` : '';

    renderCast();
    renderHistory();
  }

  /**
   * 团队视角三块：阵容 / 海克斯 / 出装。
   *
   * 这三条来自 `teamInsight`（提示词 v3.0 起每个维度各一条），刻意与个人判定分开
   * —— 随机英雄、随机符文是系统给的，不该记在某个人头上，所以它们只搬事实与团队结论。
   * 老战报只有 compositionNote 一条，那就只亮一条，其余两块连壳子一起收掉。
   */
  function renderTeamInsight(ti) {
    const box = $('#teamBox');
    if (!box) return;
    const pairs = [
      ['#tiCompWrap', '#tiComp', ti?.compositionNote],
      ['#tiAugWrap', '#tiAug', ti?.augmentNote],
      ['#tiItemWrap', '#tiItem', ti?.itemNote],
    ];
    let shown = 0;
    for (const [wrapSel, pSel, text] of pairs) {
      const wrap = $(wrapSel);
      const p = $(pSel);
      if (!wrap || !p) continue;
      const has = typeof text === 'string' && text.trim() !== '';
      wrap.classList.toggle('hidden', !has);
      if (has) { p.innerHTML = colorizeNames(esc(text.trim())); shown += 1; }
    }
    box.classList.toggle('hidden', shown === 0);
  }

  /**
   * 页顶那条「看 / 判」分界线。
   *
   * 同一个位置两种状态：没判定就是入口（会花钱），判过了就是结果摘要 + 重判入口。
   * 放在这儿而不是藏进菜单 —— 用户看到一屏数据时，最需要知道的就是
   * 「这些是谁给的、还要不要再判一次」。
   */
  function renderAnalyzeBar() {
    const bar = $('#analyzeBar');
    const hint = $('#analyzeHint');
    const btn = $('#btnDoAnalyze');
    const dot = $('#abDot');
    if (!bar || !hint || !btn) return;

    if (!dataset?.match?.gameId) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');

    // 视角丢了 —— 认不出「我方」是哪一边。这种局 10 个人会全挤进「敌方」列，
    // 看着像「没有敌我区分」。不猜、也不装作没事，明说一句 + 指个解法。
    // （真正的修复在后端：analyzeFromEog 会按这局的主人反查阵营。这条只兜历史战报。）
    const blindTip = dataset.match.myTeamId == null
      ? '　·　⚠ 没认出我方阵营，敌我按默认排的 —— 点「重新判定」可修正'
      : '';

    // 查别人拉到的陌生局：能看，不能判。
    // 判定会写战报并把这一局记进「我的战绩」——那是别人的局，不能进我的库。
    // 与其让人点了才弹 NOT_MY_MATCH，不如在入口就把按钮收掉并说清原因。
    if (detailOwned === false) {
      // v1.2.7：**别人的对局也能判**（按 gameId 缓存，与归属无关）。
      // 但要说清后果 —— 判完战报落在 data/reports/<gameId>.json，
      // **不会**进「我的战绩」列表，列表里看不到它。
      hint.textContent = '这是别人打的局 —— 可以判定，战报按对局 ID 存在本机，但不会进你的「我的战绩」';
      if (dot) dot.className = 'ab-dot';
      btn.textContent = '判定这局';
      btn.disabled = false;
      return;
    }

    if (result) {
      const tk = meta.usage?.total_tokens;
      hint.textContent = `${sourceLabel()}${tk ? `　·　${tk} tokens` : ''}　—　重新判定会再调用一次模型${blindTip}`;
      if (dot) dot.className = 'ab-dot ok';
      btn.textContent = '重新判定';
    } else {
      hint.textContent = `这一局还没判定 —— 上面是原始数据，点右边才会调用 DeepSeek${blindTip}`;
      if (dot) dot.className = 'ab-dot';
      btn.textContent = '开始分析';
    }
    btn.disabled = false;
  }

  // 英雄图标占位：拿不到官方头像时用英雄首字做色块
  function champGlyph(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    return /[\u4e00-\u9fa5]/.test(s[0]) ? s[0] : s[0].toUpperCase();
  }

  /** LCU 资源地址（仅联机时可用）；离线返回 null */
  function assetUrl(p) {
    if (!p || !BBX.available) return null;
    try { return BBX.asset(p); } catch { return null; }
  }

  /** 头像内容：有真图标就盖上去，加载失败自动 remove 露出首字占位 */
  function badgeInner(p) {
    const glyph = `<i>${esc(champGlyph(p.champion))}</i>`;
    const url = assetUrl(p.championIcon);
    if (!url) return glyph;
    return `${glyph}<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">`;
  }

  /**
   * 一格强化符文 / 一件装备。
   *
   * 图标走 LCU 资源代理（客户端在跑才拿得到）；拿不到就退到首字占位 ——
   * 离线演示时整列都是首字，也仍然能看出「带了什么」，比一串 id 强。
   * 名字始终进 title，鼠标停一下就能看到全称。
   */
  function slotIcon(x, kind) {
    const url = assetUrl(x.icon);
    const glyph = esc(champGlyph(x.name));
    const title = kind === 'aug'
      ? `${x.name}${x.rarityCn ? ' · ' + x.rarityCn : ''}`
      : x.name;
    const img = url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    const cls = kind === 'aug' ? `slot aug aug-${x.rarity || 'none'}` : 'slot item';
    return `<i class="${cls}" title="${esc(title)}">${glyph}${img}</i>`;
  }

  /**
   * 一列格子（海克斯 / 出装）。
   * 只认「有名字的对象」—— 早先落盘的老战报里 items 是裸 id 数组、且没有符文，
   * 那些局显示一个「—」就好，不要排一排问号假装有数据。重判一次即可补齐。
   */
  function slotRow(list, kind) {
    const named = (list || []).filter((x) => x && typeof x === 'object' && x.name);
    if (!named.length) return '<span class="sb-slots empty">—</span>';
    return `<span class="sb-slots" data-kind="${kind}">${named.map((x) => slotIcon(x, kind)).join('')}</span>`;
  }

  /**
   * 详情页主行的关键数据小格（输出 / 承伤 / 治疗）。
   * 主值是绝对值（跨行可比），每分钟速率进 tooltip —— 与列表页同一套口径：
   * 「一眼比大小，想知道快慢再停留」。
   */
  function kvStat(p, key, name) {
    const rate = (p.perMinute || {})[key];
    const full = numFull(p[key]);
    const title = full
      ? `${name} ${full}${rate ? `　·　每分钟 ${Math.round(rate)}` : ''}`
      : `${name} 无数据`;
    return `<span class="kv" title="${esc(title)}"><em>${name}</em><b>${esc(numShort(p[key]))}</b></span>`;
  }

  /** 展开区的关键数据行：绝对值 + 每分钟速率成对出现，补齐治疗量 */
  function statlineHtml(p) {
    const pm = p.perMinute || {};
    const cell = (name, abs, rate) => `<span>${name} <b>${esc(numShort(abs))}</b>`
      + (rate ? ` <i>${esc(String(Math.round(rate)))}/分</i>` : '') + '</span>';
    return `<div class="statline">
      <span>参团率 <b>${Math.round((p.killParticipation ?? 0) * 100)}%</b></span>
      ${cell('输出', p.damageDealt, pm.damageDealt)}
      ${cell('承伤', p.damageTaken, pm.damageTaken)}
      ${cell('治疗', p.healing, pm.healing)}
      ${cell('经济', p.gold, pm.gold)}
    </div>`;
  }

  /**
   * 评分表的一行（一个人）。
   *
   * 左半是客观数据（K/D/A、输出/承伤/治疗、海克斯、出装），右半是判定结果（评分、头衔）——
   * 「他带了什么」和「我们怎么判」摆在同一行，才好对照着看。
   * 详细的理由与证据收在展开区里，默认不占地方。
   */
  function playerRow(p) {
    // 没判定（详情态）时 r 为空 —— 客观数据照给，评分 / 结论两列留白，
    // 显示「待分析」而不是「0 分 · 普通」。0 分是个判定结果，不能拿来冒充「还没判」。
    const r = resByPid[p.pid] || null;
    const label = r ? r.label : '';
    const kda = `${p.kills}/${p.deaths}/${p.assists}`;
    const detail = r
      ? `${statlineHtml(p)}
        <p class="reason">${colorizeNames(esc(r.reason))}</p>
        <div class="evidences">
          ${(r.evidence || []).map((e) => `<span class="evidence">${colorizeNames(esc(e))}</span>`).join('')}
        </div>`
      : `${statlineHtml(p)}
        <p class="reason muted">这一局还没判定，因此没有评分与结论。</p>`;
    return `
    <div class="sb-item" data-label="${label}">
      <div class="sb-row">
        <span class="sb-who">
          <span class="champ-badge sm" title="${esc(p.champion)}${p.championTitle ? ' · ' + esc(p.championTitle) : ''}">${badgeInner(p)}</span>
          <span class="sb-names">
            <b>${esc(p.champion)}</b>
            <em>${nameSpan(p.pid)} · ${esc(roleCn(p.championType))}</em>
          </span>
        </span>
        <span class="sb-kda"><b>${esc(kda)}</b></span>
        <span class="sb-stats">
          ${kvStat(p, 'damageDealt', '输出')}
          ${kvStat(p, 'damageTaken', '承伤')}
          ${kvStat(p, 'healing', '治疗')}
        </span>
        ${slotRow(p.augments, 'aug')}
        ${slotRow(p.items, 'item')}
        <span class="sb-score" data-label="${label}">${r ? fmtScore(r.score) : '—'}<i class="sb-bar" style="--w:${r && typeof r.score === 'number' ? clampPct(r.score) : 0}%"></i></span>
        <span class="sb-tag" data-label="${label}">${r ? LABEL_CN[r.label] : '待分析'}</span>
      </div>
      <div class="sb-detail"><div class="sb-detail-inner">${detail}</div></div>
    </div>`;
  }

  // 时间轴只做原样搬运：有啥字段显示啥，不做「因为 / 所以」
  // 每个当事人后面挂上所用英雄，方便不认识昵称的人对上号
  /**
   * 时间轴里的一次点名：昵称 + 英雄名。
   *
   * 时间轴是全篇唯一把 10 个人混排在一起的地方 —— 同一行可能「我方杀敌方」，
   * 也可能「敌方杀我方」，光看名字分不出谁是自己人。所以带上 data-side，
   * 由样式按阵营上色（我方钢蓝 / 敌方陶土红）。
   * 攻方、阵亡方、助攻名单走的是同一个函数，所以三处一起着色。
   */
  function tlName(pid) {
    const p = byPid[pid];
    const side = sideOf(p);
    const champ = p && p.champion
      ? `<em class="tl-champ" data-side="${side}">${esc(p.champion)}</em>`
      : '';
    return `<span class="tl-name" data-side="${side}">${esc(nameOf(pid))}</span>${champ}`;
  }

  /**
   * 时间轴一行 = 一个时间点。
   *
   * 三列固定宽度：时间（等宽字体，纵向能对齐好扫） / 类型标签 / 详情。
   * 原来是多列卡片网格 —— 一行塞好几个时间点，看不出先后顺序；列表一行一条才读得出节奏。
   */
  function tlCard(t) {
    const parts = [];
    if (t.actor) parts.push(tlName(t.actor));
    if (t.victim) parts.push('<span class="tl-arrow">→</span> ' + tlName(t.victim));
    else if (t.object) parts.push('<span class="tl-arrow">→</span> ' + esc(t.object));
    if (t.assisters && t.assisters.length) {
      parts.push(`<span class="tl-as">助攻 ${t.assisters.map(tlName).join('、')}</span>`);
    }
    if (t.type === 'GameEnd') parts.push(`胜方 ${t.winningTeam === dataset.match.myTeamId ? '我方' : '对方'}`);

    return `<div class="tl-row" data-kind="${esc(t.type)}">`
      + `<span class="tl-time">${esc(t.time)}</span>`
      + `<span class="tl-kind">${esc(typeCn(t.type))}</span>`
      + `<span class="tl-body">${parts.join(' ')}</span>`
      + '</div>';
  }

  // 事件类型翻译。真机只给 CHAMPION_KILL / BUILDING_KILL 两种，
  // 其余是早期样例数据的类型，一并留着兼容
  function typeCn(t) {
    return {
      CHAMPION_KILL: '击杀', BUILDING_KILL: '拆建筑',
      FirstBlood: '一血', ChampionKill: '击杀', TurretKilled: '推塔',
      InhibKilled: '破兵营', Ace: '团灭', GameEnd: '结束',
    }[t] || t;
  }

  /* ─────────── 播报 ─────────── */
  /* ── 播报稿 ──────────────────────────────────────────────────────────
     ★ v1.2.6 重写。原来每个标签只有**一句**固定模板，结果一局里三个混子
       就把同一句「全程隐身，伤害呢？」念三遍，而且句子里**没有任何本局数据** ——
       念出来谁都一样，像复读机。
       现在两条规矩：
         ① 同一标签给一个**句式池**，按该标签内的出场序号轮换 → 同局不重样；
         ② 每个句子填进**这个人本局真正突出的那一件事**（输出/承伤/治疗/控制/
            阵亡最多/输出垫底…），是「他干了什么」而不是「他这个标签」。
       ⚠ 这里的「全场排名」只用于**给人听的播报稿**，不喂模型 ——
         四不原则约束的是送进 dataset 的那份数据，两者别混。
  */

  /** 这个人本局的客观数据 + 他在全场里的相对位置 */
  function castFacts(pid) {
    const p = byPid[pid] || {};
    const all = dataset.players || [];
    const v = (x) => Number(x) || 0;
    const kda = (x) => v(x.kills) + v(x.deaths) + v(x.assists);
    const kil = (x) => v(x.kills);
    const dmg = (x) => v(x.perMinute?.damageDealt);
    const tak = (x) => v(x.perMinute?.damageTaken);
    const hea = (x) => v(x.perMinute?.healing);
    const cc = (x) => v(x.ccTime);
    const dead = (x) => v(x.deaths);

    const rank = (fn) => {
      const sorted = all.slice().sort((a, b) => fn(b) - fn(a)).map((p2) => p2.pid);
      return sorted.indexOf(pid);            // 0 = 第一
    };
    const me = byPid[pid] || {};
    return {
      p,
      champion: me.champion || '英雄',
      kills: v(me.kills), deaths: v(me.deaths), assists: v(me.assists),
      kp: v(me.killParticipation),
      deathTimes: Array.isArray(me.deathTimes) ? me.deathTimes : [],
      kdaText: `${v(me.kills)} 杀 ${v(me.deaths)} 死 ${v(me.assists)} 助攻`,
      dmg, tak, hea, cc, deaths: v(me.deaths),
      rDmg: rank(dmg), rTak: rank(tak), rHea: rank(hea), rCc: rank(cc), rDead: rank(dead),
      rKda: rank((x) => kda(x)),
      rKill: rank(kil),
      lastDeath: (Array.isArray(me.deathTimes) && me.deathTimes.length)
        ? me.deathTimes[me.deathTimes.length - 1] : null,
    };
  }

  /** 这个人本局「最值得念的一件事」—— 一次只说一件，说他最有代表性的那个 */
  function castHighlight(f, label) {
    const N = (dataset.players || []).length || 10;
    const out = [];
    if (f.rDmg <= 1 && f.dmg > 0) out.push('输出全场第一');
    else if (f.rKill <= 1 && f.kills >= 6) out.push(`全场击杀最多，${f.kills} 杀`);
    if (f.rHea <= 1 && f.hea > 0) out.push('治疗全场第一');
    if (f.rCc <= 1 && f.cc > 0) out.push('控制时长全场第一');
    if (f.rDead === 0 && f.deaths >= 8) out.push(`全场死得最多，${f.deaths} 次`);
    if (f.rDmg === N - 1 && f.dmg > 0) out.push('输出全场垫底');

    // 阵亡时刻是这一版新加的重点，但要短 —— 播报是给人听的，句子越长越难念
    if (label === 'BLAME') {
      if (f.rTak <= 1 && f.deaths >= 6) out.push('扛伤最多，人却没了');
      else if (f.lastDeath) out.push(`最后一次阵亡在 ${f.lastDeath}`);
      else if (f.deaths >= 5) out.push(`全场死得最多，${f.deaths} 次`);
    }
    if (label === 'CARRY' && f.deaths === 0) out.push('一局没死');
    if (label === 'FREELOADER' && f.kp > 0 && f.kp < 0.4) out.push('参团不到四成');
    return out;
  }

  /** 语气句式池：同一标签内按序号轮换，同一局不会念出两句一样的 */
  const CAST_LINES = {
    mild: {
      carry: [
        '{h}，{d}，节奏带得不错。',
        '{h}这局稳，{d}。',
        '{n}发挥正常，{d}。',
      ],
      teflon: [
        '{h}这局很干净，{d}。',
        '{h}全程没掉链子，{d}。',
        '{n}打得很克制，{d}。',
      ],
      blame: [
        '{h}有点吃力，{d}，下把注意。',
        '{n}这几个节点没跟上，{d}。',
        '{h}还能再稳一点，{d}。',
      ],
      freeloader: [
        '{h}跟团偏少，{d}。',
        '{n}可以多参与一下团战，{d}。',
        '{h}存在感低了点，{d}。',
      ],
    },
    normal: {
      carry: [
        '{h}是本局胜负手 —— {d}。',
        '{h}扛起了输出：{d}。',
        '{n}是这局能赢的原因，{d}。',
        '{h}把节奏撑住了，{d}。',
      ],
      teflon: [
        '{h}全程干净，{d}。',
        '{h}没给机会，{d}。',
        '{n}该做的都做了，{d}。',
      ],
      blame: [
        '{h}这几波代价不小：{d}。节奏就是这么丢的。',
        '{n}问题出在关键节点：{d}。',
        '{h}死在不该死的时候：{d}。',
        '{n}这几波一送团就没了：{d}。',
      ],
      freeloader: [
        '{h}既送又不参团，{d}。',
        '{n}打了酱油，{d}。',
        '{h}一直在边缘，{d}。',
        '{n}该跟的团没跟，{d}。',
      ],
    },
    savage: {
      carry: [
        '{h}是爹，{d}，没他早没了。',
        '{n}carry 全场，{d}。',
        '{h}一个人把局面扛住了，{d}。',
      ],
      teflon: [
        '{h}干净得像没上过场，{d}。',
        '{n}一次没死，{d}，羡慕吗。',
        '{h}全身上下挑不出毛病，{d}。',
      ],
      blame: [
        '{h}死得跟送快递一样，{d}。',
        '{n}又把节奏送走了，{d}。',
        '{h}每次都是他先倒，{d}。',
        '{n}这波团白给了，{d}。',
      ],
      freeloader: [
        '{h}全程隐身，伤害还在读条吗？',
        '{n}在干嘛呢，团战看不见人影。',
        '{h}打了个寂寞，{d}。',
        '{n}是来旅游的吧，{d}。',
      ],
    },
  };

  let tone = 'normal';

  /** 组一句：套模板 + 填本局数据 */
  function castLine(tpl, f, name) {
    const hi = castHighlight(f, f._label);
    // 事实最多两条：播报是念给人听的，一口气报三串数字反而听不进去。
    // 没有高光就退回 KDA —— 宁可朴素也别空着。
    const d = hi.length ? hi.slice(0, 2).join('，') : f.kdaText;
    return tpl
      .replace(/\{n\}/g, name)
      .replace(/\{h\}/g, `${name}的${f.champion}`)
      .replace(/\{d\}/g, d)
      .trim();
  }

  function buildCast() {
    // 没判定就没有可播的东西 —— 播报稿是按 头衔 + 结论文案 拼的，凭空编不出来
    if (!result) return '这一局还没判定。播报稿由判定结果生成，先点上面的「开始分析」。';

    // ★ v1.2.7：**播报稿优先用 DeepSeek 写的**（result.cast.lines）。
    //   它能引用具体时间点与数值，本地模板写不出来 —— 那些模板只剩两种用处：
    //     ① 老战报（判定的比现在早，没有 cast 字段）
    //     ② 走本地兜底判定时（压根没有模型输出）
    const modelLines = result?.cast?.lines;
    if (Array.isArray(modelLines) && modelLines.filter((s) => typeof s === 'string' && s.trim()).length >= 2) {
      return modelLines.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).join('\n');
    }

    const scope = $('#setScope') ? $('#setScope').value : 'ally';
    const pool = result.players.filter((r) => {
      if (scope === 'all') return true;
      const p = byPid[r.pid];
      return p && p.isMyTeam;
    });
    // ★ 换行连接，不是空串 —— 空串会让 verdict 和第一句黏成一句
    //   （实测出现过「…无力回天路人辛的卡尔萨斯是本局胜负手」这种读都读不顺的句子），
    //   顺带让 TTS 在句间自然停顿。
    const verdict = String(result.verdict || '').trim();
    const open = verdict && /[。！？!?）)]$/.test(verdict) ? verdict : verdict + '。';
    const lines = [open];
    const used = new Set();          // 已经念过的句子，避免同一局出现两遍一样的话
    const seq = {};                  // 每个标签念到第几个人了 → 决定用池里第几句

    ['CARRY', 'TEFLON', 'FREELOADER', 'BLAME'].forEach((label) => {
      const bank = CAST_LINES[tone][label.toLowerCase()] || [];
      const people = pool.filter((r) => r.label === label)
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      people.forEach((r) => {
        const f = castFacts(r.pid);
        f._label = label;
        const i = (seq[label] = (seq[label] || 0) + 1) - 1;
        // 轮换取句；万一凑巧撞上已念过的，就往后挪一句
        let tpl = bank[i % bank.length];
        for (let k = 0; k < bank.length && used.has(tpl); k++) tpl = bank[(i + k + 1) % bank.length];
        used.add(tpl);
        lines.push(castLine(tpl, f, nameOf(r.pid)));
      });
    });
    lines.push({ mild: '这局就到这，下一把继续。', normal: '数据摆在这，自己看。', savage: '下一把别再让我写这种战报了。' }[tone]);
    return lines.filter(Boolean).join('\n');
  }

  function renderCast() {
    // 播报稿里每个被点名的人都带上阵营色 —— 一口气念十个人时，这是唯一能分清敌友的线索
    $('#castText').innerHTML = colorizeNames(esc(buildCast()));
    $('#tones').innerHTML = Object.entries(PR.tones || {}).map(([k, v]) =>
      `<button class="tone-btn ${k === tone ? 'active' : ''}" data-tone="${k}">
         <b>${({ mild: '温和', normal: '标准', savage: '毒舌' })[k] || k}</b><br>
         <span style="font-size:11.5px;color:var(--text-3)">${esc(v.split('——')[1] || v)}</span>
       </button>`).join('');
    $$('#tones .tone-btn').forEach((b) => b.addEventListener('click', () => {
      tone = b.dataset.tone;
      const sel = $('#setTone'); if (sel) sel.value = tone;
      renderCast();
    }));

    $('#wave').innerHTML = Array.from({ length: 48 }, (_, i) => `<i style="height:${18 + ((i * 17) % 62)}%"></i>`).join('');

    $('#chan').innerHTML = [
      ['合成', 'Edge TTS'],
      ['播放', 'HTMLAudioElement.setSinkId()'],
      ['输出', 'VB-Audio Virtual Cable'],
      ['频道', 'YY 麦克风 ← CABLE Output'],
      ['降级', '虚拟声卡不可用 → 弹窗文字<br>断网 → Windows SAPI'],
    ].map(([k, v]) => `<div><b>${k}</b>　${v}</div>`).join('');
  }

  /* ─────────── 历史（黑历史榜） ─────────── */
  function mockHistory() {
    return dataset.players.map((p, idx) => {
      const seed = (idx * 37 + 13) % 100;
      const games = 9 + (seed % 23);
      const r = resByPid[p.pid] || { label: 'NORMAL' };
      const main = Math.round(games * (0.30 + (seed % 25) / 100));
      const rest = games - main;
      const dist = { CARRY: 0, BLAME: 0, TEFLON: 0, FREELOADER: 0, NORMAL: 0 };
      dist[r.label] += main;
      const spare = ['NORMAL', 'NORMAL', r.label === 'NORMAL' ? 'CARRY' : 'NORMAL'];
      for (let i = 0; i < rest; i++) dist[spare[i % spare.length]] += 1;
      return { pid: p.pid, games, dist, recent: r.label, hours: 1 + (seed % 9) };
    }).sort((a, b) => b.games - a.games);
  }

  function renderHistory() {
    $('#historyList').innerHTML = mockHistory().map((h) => {
      const total = Object.values(h.dist).reduce((a, b) => a + b, 0) || 1;
      const bars = Object.entries(h.dist).filter(([, v]) => v > 0)
        .map(([k, v]) => `<i data-label="${k}" style="width:${(v / total) * 100}%" title="${LABEL_CN[k]} ${v}"></i>`).join('');
      const champ = (byPid[h.pid] || {}).champion || '';
      return `<div class="hist-row">
        <span class="who">${nameSpan(h.pid)}${champ ? `<em>${esc(champ)}</em>` : ''}</span>
        <span class="games">${h.games} 场</span>
        <span class="bars">${bars}</span>
        <span class="recent">${LABEL_CN[h.recent]} · ${h.hours} 小时前</span>
      </div>`;
    }).join('');
  }

  /* ─────────── 账号（在看谁的战绩） ─────────── */
  // 一台机器换账号登录很常见，战绩混在一张表里就分不清哪些是自己打的。
  // 服务端按 ownerPuuid 过滤，这里只负责「显示 / 切换」。
  let acctState = { accounts: [], current: null, last: null, viewing: null };

  function acctOptionLabel(a) {
    const bits = [a.name || a.key];
    if (a.count != null) bits.push(`${a.count} 局`);
    if (a.isCurrent) bits.push('当前登录');
    else if (a.isLast) bits.push('最后登录');
    return bits.join(' · ');
  }

  function renderAccountUI() {
    const sel = $('#acctSelect');
    const list = acctState.accounts || [];
    if (sel) {
      sel.innerHTML = list.map((a) => `<option value="${esc(a.key)}"${a.key === acctState.viewing ? ' selected' : ''}>`
        + `${esc(acctOptionLabel(a))}</option>`).join('');
      sel.disabled = list.length <= 1;
    }
    // 看别人的数据时说清楚，免得以为「我的战绩怎么不见了」
    const note = $('#acctNote');
    if (!note) return;
    const v = list.find((a) => a.key === acctState.viewing);
    const isForeign = !!v && !v.isCurrent && !v.virtual && !!acctState.current;
    note.textContent = isForeign
      ? (acctState.currentName ? `不是当前登录（${acctState.currentName}）` : '不是当前登录账号')
      : '';
    note.classList.toggle('hidden', !note.textContent);
  }

  async function loadAccounts() {
    if (!BBX.available || !BBX.state.online) return;
    try {
      const r = await BBX.accounts();
      if (!r.ok) return;
      acctState = {
        accounts: r.accounts || [],
        current: r.current || null,
        last: r.last || null,
        viewing: r.viewing || null,
        currentName: r.currentName || null,
      };
      renderAccountUI();
    } catch { /* 拿不到就沿用上次的 */ }
  }

  function wireAccountSelect() {
    const sel = $('#acctSelect');
    if (!sel) return;
    sel.addEventListener('change', async () => {
      const key = sel.value;
      sel.disabled = true;
      try {
        const r = await BBX.selectAccount(key);
        if (!r.ok) throw new Error(r.error || '切换失败');
        acctState.viewing = r.viewing;
        renderAccountUI();
        await loadMatches({ refresh: false, silent: true });
        loadSaved();
        toast(`已切到「${r.viewingName || key}」的战绩`);
      } catch (e) {
        toast('切换账号失败：' + e.message, true);
      } finally {
        sel.disabled = (acctState.accounts || []).length <= 1;
      }
    });
  }

  /* ─────────── 战绩 ─────────── */
  let matchCache = [];

  /**
   * 查询模式 —— 正在看某个召唤师的战绩。
   *
   * 刻意跟 matchCache 分开：查询是**旁路**，退出查询后「我的战绩」原样回来；
   * 服务端那边也把它写在 data/searched/ 而不是 matches.json ——
   * 查别人的数据不能污染自己的库（数据隔离）。
   */
  let searchState = {
    active: false, puuid: null, name: null,
    matches: [], total: 0, fetchedAt: null, fromCache: false, fromClient: 0,
  };

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
  function agoText(ts) {
    if (!ts) return '—';
    const diff = Date.now() - Number(ts);
    if (!Number.isFinite(diff) || diff < 0) return '—';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    return `${Math.floor(hr / 24)} 天前`;
  }

  /** 日期时间：MM-DD HH:mm */
  function dateText(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function kdaText(m) {
    if (m.kills == null || m.deaths == null || m.assists == null) return '—';
    return `${m.kills} / ${m.deaths} / ${m.assists}`;
  }

  /**
   * 大数字压缩：55683 → 55.7k。
   *
   * 列表要一眼可读，铺满五位数会把行撑花。阈值取 10000 —— 一万以下原样显示
   * （四位数还算好认），一万以上才缩写。取不到值给「—」，不用 0 冒充。
   */
  function numShort(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
  }

  /** 完整数字（千分位）—— 进 tooltip 用，那里不怕长 */
  function numFull(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n.toLocaleString('zh-CN');
  }

  /** 每分钟速率 —— 对局时长跨度大，绝对值之间不可比，副行给速率 */
  function perMin(v, durationSec) {
    const n = Number(v);
    const d = Number(durationSec);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(d) || d <= 0) return null;
    return n / (d / 60);
  }

  /**
   * KDA 后面那一组关键数据格（v2.5）。
   *
   * 主行是绝对值（对局客户端口径），副行是每分钟速率（可比口径）。
   * 两个都拿不到就给一个合并的「—」，不留两个空格子。
   */
  function statCell(m, key, tipName) {
    const v = m[key];
    const rate = perMin(v, m.durationSec);
    const main = numShort(v);
    const sub = rate == null ? '' : `${numShort(rate)}/分`;
    const full = numFull(v);
    const title = full ? `${tipName} ${full}${sub ? `　·　每分钟 ${Math.round(rate)}` : ''}` : tipName;
    return `<span class="mh-stat" title="${esc(title)}"><b>${esc(main)}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</span>`;
  }

  /** 列表行 tooltip 里的一整串关键数据 */
  function statTip(m) {
    const bits = [
      numFull(m.damageDealt) ? `输出 ${numFull(m.damageDealt)}` : null,
      numFull(m.damageTaken) ? `承伤 ${numFull(m.damageTaken)}` : null,
      numFull(m.healing) ? `治疗 ${numFull(m.healing)}` : null,
      numFull(m.goldEarned) ? `金币 ${numFull(m.goldEarned)}` : null,
      m.cs == null ? null : `补兵 ${m.cs}`,
    ].filter(Boolean);
    return bits.join(' · ');
  }

  /** 时间主格：优先对局开始时间；老条目拿不到就用战报生成时间兜底（会标出来） */
  function timeText(m) {
    if (m.createdAt) return dateText(m.createdAt);
    if (m.analyzedAt) return `${dateText(Date.parse(m.analyzedAt))}*`;
    return '—';
  }

  function matchRow(m) {
    const win = m.win === true ? 'win' : m.win === false ? 'lose' : 'unknown';
    const winText = m.win === true ? '胜' : m.win === false ? '负' : '—';
    // 「已分析」以本机战报为准：查询模式下这些行来自另一位召唤师的数据，
    // 但它可能同时是本机账号打过的局（本机缓存里只有本机账号的局）
    const analyzed = !!m.analyzedAt || !!analysisOf(m.gameId);
    const icon = assetUrl(m.championIcon);
    const badge = m.champion
      ? `<span class="champ-badge sm" title="${esc(m.champion)}${m.championTitle ? ' · ' + esc(m.championTitle) : ''}">`
        + `<i>${esc(champGlyph(m.champion))}</i>`
        + (icon ? `<img src="${esc(icon)}" alt="" loading="lazy" onerror="this.remove()">` : '')
        + `</span>`
      : '<span class="champ-badge sm empty"><i>?</i></span>';

    const tip = [`点击查看这一局的详情`, statTip(m), m.verdict || null].filter(Boolean).join('　·　');
    return `<div class="mh-row" data-game-id="${esc(m.gameId)}" data-analyzed="${analyzed ? 1 : 0}" title="${esc(tip)}">
      <span class="mh-time">
        <b>${esc(timeText(m))}</b>
        <em>${esc(agoText(m.createdAt || (m.analyzedAt ? Date.parse(m.analyzedAt) : null)))} · ${esc(m.durationText || '—')}</em>
      </span>
      <span class="mh-mode">${esc(m.mode || '—')}</span>
      <span class="mh-champ">${badge}<b>${esc(m.champion || '未知英雄')}</b></span>
      <span class="mh-kda">${esc(kdaText(m))}</span>
      ${statCell(m, 'damageDealt', '对英雄输出')}
      ${statCell(m, 'damageTaken', '承受伤害')}
      <span class="mh-win ${win}">${winText}</span>
      <span class="mh-state ${analyzed ? 'done' : 'todo'}">${analyzed ? '已分析' : '未分析'}</span>
      <span class="mh-act">
        <button class="btn sm ghost mh-again" data-game-id="${esc(m.gameId)}" title="忽略已有战报，重新判定一局">重判</button>
      </span>
    </div>`;
  }

  /** 这一局在本机有没有落盘战报（查询模式下用来标「已分析」） */
  function analysisOf(gameId) {
    if (!gameId) return null;
    const hit = (matchCache || []).find((m) => String(m.gameId) === String(gameId));
    return hit ? hit.analyzedAt : null;
  }

  /** 一天的开头（本地时区）—— 分组的键 */
  function dayStart(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  /** 日期分割条的主文案 */
  function dayLabel(dayTs) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - dayTs) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    const d = new Date(dayTs);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function daySub(dayTs) {
    const d = new Date(dayTs);
    return `${d.getMonth() + 1}-${d.getDate()} 周${WEEK_CN[d.getDay()]}`;
  }

  /**
   * 列表当前该显示哪一份数据。
   *
   * 两份数据源刻意分开存：matchCache 是「我的战绩」，searchState.matches 是
   * 「某个召唤师的战绩」。查询只是**切换显示**，不会覆盖、也不会写进我的列表 ——
   * 退出查询就还是原来那份，一行不少。
   */
  function visibleMatches() {
    return searchState.active ? searchState.matches : matchCache;
  }

  function renderMatches() {
    const el = $('#homeMatchList');
    if (!el) return;
    const list = visibleMatches();

    if (!list.length) {
      el.innerHTML = searchState.active
        ? `<div class="mh-empty">${esc(searchState.name || '这位召唤师')} 在本机缓存里没有对局记录。</div>`
        : '<div class="mh-empty">还没有战绩。连上客户端后打一局，或点「刷新」。</div>';
      return;
    }

    // 按「天」分组。一铺就是几百行，没有日期分割根本找不到「那天那局」。
    // 取对局开始时间；老条目只有战报生成时间，退而用那个（行的主格会带 * 标出来）。
    const groups = [];
    for (const m of list) {
      const day = dayStart(m.createdAt || (m.analyzedAt ? Date.parse(m.analyzedAt) : null));
      const last = groups[groups.length - 1];
      if (!last || last.day !== day) groups.push({ day, rows: [m] });
      else last.rows.push(m);
    }

    el.innerHTML = groups.map((g) => {
      const head = g.day == null
        ? '<span class="day-name">日期未知</span><em>这局没留下对局时间</em>'
        : `<span class="day-name">${esc(dayLabel(g.day))}</span><em>${esc(daySub(g.day))}</em>`;
      return `<div class="mh-day">${head}<span class="day-line"></span>`
        + `<span class="day-count">${g.rows.length} 局</span></div>`
        + g.rows.map(matchRow).join('');
    }).join('');
  }

  /** 汇总行（首页唯一一处） */
  function setMatchesSum(html) {
    const el = $('#homeSum');
    if (el) el.innerHTML = html;
  }

  /** 拉战绩列表；refresh=false 时只读本地索引，不碰客户端 */
  async function loadMatches({ refresh = true, silent = false } = {}) {
    if (!BBX.available) {
      setMatchesSum('离线打开 · 无法读取战绩');
      matchCache = [];
      renderMatches();
      return;
    }
    if (!BBX.state.online) {
      const ok = await BBX.probe();
      if (!ok) {
        setMatchesSum('未连接本地服务 · 请先运行 start.bat');
        matchCache = [];
        renderMatches();
        return;
      }
    }

    const btns = [$('#btnHomeRefresh')].filter(Boolean);
    const setBusy = (busy) => btns.forEach((b) => {
      b.disabled = busy;
      b.textContent = busy ? '读取中…' : '刷新';
    });
    setBusy(true);
    try {
      const r = await BBX.matches({ refresh });
      if (!r.ok) throw new Error(r.error || '读取失败');
      matchCache = r.matches || [];
      // 服务端可能把 viewing 落到了别的账号（比如首次打开时默认当前登录）—— 以它为准
      if (r.viewing && r.viewing !== acctState.viewing) {
        acctState.viewing = r.viewing;
        renderAccountUI();
      }
      const s = r.stats || {};
      const v = (acctState.accounts || []).find((a) => a.key === acctState.viewing);
      const who = v ? v.name : '';
      // 查询模式下不动汇总行 —— 那行正显示着「某某的战绩」，不该被我的统计盖掉
      if (!searchState.active) {
        setMatchesSum(`共 <b>${r.total}</b> 局`
          + (who ? `　·　账号 <b>${esc(who)}</b>` : '')
          + `　·　本轮新增 ${s.fromLcu || 0} 局（客户端窗口）`
          + `　·　已分析 ${(matchCache || []).filter((m) => m.analyzedAt).length} 局`);
      }
      renderMatches();
      if (!silent) toast(`战绩已更新 · ${r.total} 局`);
    } catch (e) {
      // 服务端报错文案会原样回到这里 —— 它是唯一一处把外部字符串当 HTML 写的地方，必须转义
      setMatchesSum('读取失败：' + esc(e.message));
      if (!silent) toast('读取战绩失败：' + e.message, true);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 判定完一局后把列表里的「已分析」标记刷新一遍。
   * refresh=false —— 只读本地索引与落盘战报，不碰客户端（判定刚结束，不必再打一次 LCU）。
   */
  function refreshMatchFlags() {
    if (!BBX.available || !BBX.state.online) return;
    loadMatches({ refresh: false, silent: true });
    // 各账号的「已分析 N 局」也变了 —— 下拉里的数字跟着更新
    loadAccounts();
  }

  /**
   * 请求是否能在 ms 内收工 —— 决定「要不要亮进度页」。超时不打断请求，
   * 只是让调用方先把进度页摆出来，请求照旧在后面跑。
   */
  function settledWithin(promise, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      const done = () => { clearTimeout(t); resolve(true); };
      promise.then(done, done);
    });
  }

  /** 按钮级忙碌态：改文案 + 禁用；复原时用第一次记下的原文，不受中间改动影响 */
  function setBtnBusy(sel, on, text) {
    const b = $(sel);
    if (!b) return;
    if (on) {
      if (!b.dataset.idleText) b.dataset.idleText = b.textContent;
      b.disabled = true;
      b.textContent = text;
    } else {
      b.disabled = false;
      if (b.dataset.idleText) b.textContent = b.dataset.idleText;
    }
  }

  /** 行级忙碌态：不切页，只把被点的那一行压暗、状态格改成「读取中…」 */
  function markRowBusy(el, on) {
    if (!el) return;
    const cell = el.querySelector('.mh-state');
    if (on) {
      el.classList.add('is-busy');
      if (cell) { el.dataset.stateText = cell.textContent; cell.textContent = '读取中…'; }
    } else {
      el.classList.remove('is-busy');
      if (cell && el.dataset.stateText) cell.textContent = el.dataset.stateText;
    }
  }

  /** 分析指定的一局（点行 / 点重判） */
  async function analyzeOne(gameId, { force = false, el = null } = {}) {
    if (!gameId) return;
    if (!BBX.available || !BBX.state.online) { toast('未连接本地服务', true); return; }

    // 盘里已经有一份战报（且不是「重判」）→ 先给 900ms 等读盘直接返回：
    // 命中就全程不切「正在生成战报」页，只压暗那一行；超时才认为要真跑模型，亮进度页。
    // 900ms 是对本机 LCU 往返（最坏要补读一次对局详情）留的余量；实测命中只要 ~14ms。
    const hadReport = !force
      && !!(matchCache.find((m) => String(m.gameId) === String(gameId)) || {}).analyzedAt;

    pushNav();
    markRowBusy(el, true);
    setBtnBusy('#btnDoAnalyze', true, '判定中…');

    let anim = null;
    let res;
    try {
      // 查询模式下这一局本机账号可能不在场 → 必须带上视角，
      // 否则判出来的报告 10 人全归敌方，等于没判
      const req = BBX.analyzeMatch(gameId, {
        tone, force,
        perspective: searchState.active ? searchState.puuid : null,
      });
      // hadReport 为假 = 确定要真判定，不必白等那 900ms，直接亮进度页
      if (!hadReport || !(await settledWithin(req, 900))) {
        anim = animateSteps({ minMs: 900 });
      }
      res = await req;
      if (anim) await capWait(anim);
    } catch (e) {
      if (anim) await capWait(anim);
      markRowBusy(el, false);
      setBtnBusy('#btnDoAnalyze', false);
      toast('请求失败：' + e.message, true);
      return;
    }
    markRowBusy(el, false);

    if (!res || !res.ok) {
      setBtnBusy('#btnDoAnalyze', false);
      toast(res?.error || '分析失败', true);
      // 失败也必须离开「正在生成战报」—— 那一页没有任何出口，
      // 留在这儿就是死胡同（v1.2.1 事故的另一半：只有两种 code 会跳出去）。
      show('report');
      return;
    }

    try {
      applyReport(res.report);
    } catch (e) {
      // 渲染战报出问题不能连带把用户困在进度页：先把页面切走，再把异常报出来
      show('report');
      markRowBusy(el, false);
      setBtnBusy('#btnDoAnalyze', false);
      toast('战报渲染出错：' + e.message, true);
      return;
    }
    show('report');
    const tab = $('#tabs .tab[data-tab="report"]');
    if (tab) tab.click();
    // 判完立刻把列表那一行的「已分析 / 结论摘要」刷成新的 ——
    // 不然刚重判完，列表上还挂着上一版（可能是兜底）的结论，看着像没生效
    refreshMatchFlags();
    // 先按 setBtnBusy 的约定复原，再用最新状态覆盖文案（已判定 → 「重新判定」）
    setBtnBusy('#btnDoAnalyze', false);
    renderAnalyzeBar();
    // 兜底要说清原因 —— 不然用户只看到「结论变了」，不知道是模型超时还是压根没 Key
    const why = res.report.meta?.source === 'fallback' ? fallbackWhy() : '';
    toast(res.fromCache
      ? '这局之前判定过，直接读盘里的战报'
      : (why ? `模型没给出可用结果（${why}）—— 已用本地兜底，可点「重新判定」再试一次`
        : '战报已生成（DeepSeek 判定）'));
  }

  /**
   * 点一行 → **先看详情**。
   *
   * 详情是只读的：盘里已有战报就直接回放，没有就去客户端拉原始数据，
   * 两条路都**不调模型**。想判定，在详情页点「开始分析」。
   * 这是「打完不要自动烧 token」在界面上的落点 —— 看与判彻底分开。
   */
  async function openMatch(gameId, { el = null } = {}) {
    if (!gameId) return;
    if (!BBX.available || !BBX.state.online) { toast('未连接本地服务', true); return; }

    pushNav();
    markRowBusy(el, true);
    // 详情链路很快（盘里命中 ~10ms / LCU 直读 ~25ms），不亮进度页，只压暗那一行；
    // 真慢过了 1.2 秒才吱一声，免得看起来像卡死
    const slow = setTimeout(() => toast('正在读取对局详情…'), 1200);
    try {
      // ★ 查询模式必须带上 perspective —— 那一局本机账号可能根本不在场，
      //   不指定视角的话服务端认不出「我方是谁」，敌我两列会退化成同一阵营，
      //   颜色和胜负徽标也就全都不对。
      const r = await BBX.matchDetail(gameId, { perspective: searchState.active ? searchState.puuid : null });
      if (!r.ok) {
        toast(r.error || '读取详情失败', true);
        return;
      }
      if (r.hasReport) applyReport(r.report);
      else applyDetail(r);
      show('report');
      const tab = $('#tabs .tab[data-tab="report"]');
      if (tab) tab.click();
      if (r.hasReport) toast('这一局之前判定过，直接读盘里的战报');
    } catch (e) {
      toast('读取详情失败：' + e.message, true);
    } finally {
      clearTimeout(slow);
      markRowBusy(el, false);
    }
  }

  /* ─────────── 查询召唤师 ─────────── */

  /**
   * 查一个人 —— 只能查到「本机客户端见过的人」。
   *
   * 这是客户端的边界，不是实现偷懒：LCU 按名字查人的接口只吃 gameName#tagLine
   * （中文名直接 422），matchlist 更是忽略 puuid、只回本机缓存那几局。
   * 所以服务端维护了一份名录（data/roster.json），查的是它。
   */
  async function doSearch(query) {
    const q = String(query || '').trim();
    if (!q) return;
    if (!BBX.available || !BBX.state.online) { toast('未连接本地服务', true); return; }

    setBtnBusy('#btnSearch', true, '查询中…');
    try {
      const r = await BBX.searchSummoner(q);
      if (!r.ok) throw new Error(r.error || '查询失败');
      const hits = r.hits || [];
      if (!hits.length) {
        toast(`本机没见过「${q}」—— 名录现有 ${r.roster?.players ?? 0} 人，只认识客户端缓存里出现过的召唤师`, true);
        return;
      }
      if (hits.length === 1) { await enterSearchMode(hits[0]); return; }
      showSearchHits(hits, q);
    } catch (e) {
      toast('查询失败：' + e.message, true);
    } finally {
      setBtnBusy('#btnSearch', false);
    }
  }

  /** 命中多个人 —— 把列表区临时改成候选名单，点一个进去 */
  function showSearchHits(hits, q) {
    searchState = {
      active: true, puuid: null, name: null, hits,
      matches: [], total: 0, fetchedAt: null, fromCache: false,
    };
    renderSearchUI();
    const el = $('#homeMatchList');
    if (el) {
      el.innerHTML = `<div class="mh-day"><span class="day-name">候选</span>`
        + `<em>「${esc(q)}」在本机见过的人里命中 ${hits.length} 个</em><span class="day-line"></span></div>`
        + hits.map((h) => `<div class="mh-row hit-row" data-puuid="${esc(h.puuid)}" data-name="${esc(h.name || '')}" title="点击查看 TA 的战绩">
            <span class="mh-time"><b>${esc(h.name || '(未记名)')}</b><em>${esc(String(h.puuid).slice(0, 8))}…</em></span>
            <span class="mh-mode">本机见过</span>
            <span class="mh-champ"><b>${h.gameCount} 局</b></span>
            <span class="mh-kda">—</span>
            <span class="mh-stat"><b>—</b></span>
            <span class="mh-stat"><b>—</b></span>
            <span class="mh-win unknown">—</span>
            <span class="mh-state todo">点击查看</span>
            <span class="mh-act"></span>
          </div>`).join('');
    }
    setMatchesSum(`查询「${esc(q)}」—— 命中 <b>${hits.length}</b> 个召唤师，点一行查看其战绩`);
  }

  /** 列表加载占位 —— 拉一个人的战绩要逐局读详情，几百局得等几秒，不能干瞪眼 */
  function showListLoading(text) {
    const el = $('#homeMatchList');
    if (el) el.innerHTML = `<div class="mh-loading"><i class="spin"></i>${esc(text)}</div>`;
  }

  /** 进入某人的战绩视图（数据来自服务端缓存或现拉，与「我的战绩」互不干扰） */
  async function enterSearchMode(hit) {
    if (!hit?.puuid) return;
    pushNav();
    setBtnBusy('#btnSearch', true, '读取中…');
    showListLoading(`正在读取「${hit.name || 'TA'}」的战绩 —— 逐局翻客户端缓存，首次要等几秒`);
    try {
      const r = await BBX.summonerMatches(hit.puuid);
      if (!r.ok) throw new Error(r.error || '读取失败');
      searchState = {
        active: true,
        puuid: hit.puuid,
        name: r.name || hit.name || null,
        hits: null,
        matches: r.matches || [],
        total: r.total || (r.matches || []).length,
        fetchedAt: r.fetchedAt || null,
        fromCache: !!r.fromCache,
        fromClient: Number(r.scannedFromClient) || 0,
      };
      renderSearchUI();
      renderMatches();
      // 记一笔「最近搜过谁」—— 失败无所谓，别连累看战绩
      BBX.rememberSearch({ puuid: searchState.puuid, name: searchState.name, hits: searchState.total })
        .then((h) => renderSearchHistory(h?.items || []))
        .catch(() => {});
      // 客户端那份是「他不跟你同场也打过」的局，数量随客户端缓存浮动，
      // 说明来源免得人家以为是漏了 / 是重复
      const extra = searchState.fromClient
        ? `<span class="sum-extra">　·　其中 ${searchState.fromClient} 局来自客户端战绩（你不在场）</span>`
        : '';
      setMatchesSum(`<b>${esc(searchState.name || '这位召唤师')}</b>　·　共 <b>${searchState.total}</b> 局`
        + `　·　${searchState.fromCache ? '来自本机缓存' : '刚从客户端读取'}`
        + extra
        + (searchState.fetchedAt ? `（${esc(agoText(Date.parse(searchState.fetchedAt)))}）` : ''));
      toast(`已切到「${searchState.name || 'TA'}」的战绩 · ${searchState.total} 局`);
    } catch (e) {
      toast('读取战绩失败：' + e.message, true);
      renderMatches();
    } finally {
      setBtnBusy('#btnSearch', false);
    }
  }

  /** 退出查询，回到「我的战绩」（内存里那份原样还在，一行不少） */
  async function exitSearchMode() {
    searchState = {
      active: false, puuid: null, name: null, hits: null,
      matches: [], total: 0, fetchedAt: null, fromCache: false, fromClient: 0,
    };
    renderSearchUI();
    await loadMatches({ refresh: false, silent: true });
    toast('已退出查询');
  }

  /** 查询模式的界面开关：标题、账号下拉、退出按钮，一起切 */
  function renderSearchUI() {
    const on = searchState.active;
    const title = $('#homeTitle');
    const box = $('#acctBox');
    const exit = $('#btnExitSearch');
    const note = $('#searchNote');
    const input = $('#searchInput');

    if (title) title.textContent = on ? `${searchState.name || '召唤师'} 的战绩` : '战绩';
    if (box) box.classList.toggle('hidden', on);
    if (exit) exit.classList.toggle('hidden', !on);
    if (note) {
      note.classList.toggle('hidden', !on);
      if (on) note.textContent = searchState.name ? `查询中：${searchState.name}` : '查询中';
    }
    if (input) input.value = on ? (searchState.name || '') : '';
  }

  /**
   * 「最近搜过」那一排胶囊。
   *
   * 为什么放服务端而不是 localStorage：升级包不碰 data/，本机行为数据跟着机器走；
   * 而且界面上其他入口（比如点候选行进去）也能共用同一份。
   * 渲染失败一律静默 —— 这只是个便利功能，不该在首页报错。
   */
  function renderSearchHistory(items) {
    const box = $('#searchHist');
    if (!box) return;
    const list = (items || []).filter((x) => x && x.puuid).slice(0, 8);
    if (!list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<span class="sh-label">最近搜过</span>'
      + list.map((x) => `<button class="hist-chip" data-puuid="${esc(x.puuid)}" data-name="${esc(x.name || '')}">`
        + `${esc(x.name || '（无名）')}<span class="sh-ago">${esc(agoText(Date.parse(x.at)))}</span></button>`).join('')
      + '<button class="sh-clear" id="btnClearSearchHist" title="清空搜索历史">清空</button>';
    $$('#searchHist .hist-chip').forEach((b) => b.addEventListener('click', () => {
      enterSearchMode({ puuid: b.dataset.puuid, name: b.dataset.name });
    }));
    const clr = $('#btnClearSearchHist');
    if (clr) clr.addEventListener('click', async () => {
      try { await BBX.clearSearchHistory(); } catch { /* 无所谓 */ }
      renderSearchHistory([]);
      toast('已清空搜索历史');
    });
  }

  /** 启动时把最近搜过的人拉出来一次 */
  async function loadSearchHistory() {
    if (!BBX.available) return;
    try {
      const r = await BBX.searchHistory();
      if (r?.ok) renderSearchHistory(r.items || []);
    } catch { /* 这条路径挂掉不影响主功能 */ }
  }

  function wireSearch() {
    const input = $('#searchInput');
    const btn = $('#btnSearch');
    if (btn) btn.addEventListener('click', () => doSearch(input ? input.value : ''));
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(input.value); }
      });
    }
    const exit = $('#btnExitSearch');
    if (exit) exit.addEventListener('click', exitSearchMode);
  }

  // 行点击 → 详情；「重判」按钮 → 忽略缓存直接判定；候选行 → 进那个人的战绩
  // 只在首页那份战绩列表上（战报页的「战绩」页签已去掉）。
  function onMatchListClick(e) {
    const hit = e.target.closest('.hit-row');
    if (hit) {
      enterSearchMode({ puuid: hit.dataset.puuid, name: hit.dataset.name });
      return;
    }
    const again = e.target.closest('.mh-again');
    if (again) {
      e.stopPropagation();
      analyzeOne(again.dataset.gameId, { force: true, el: again.closest('.mh-row') });
      return;
    }
    const row = e.target.closest('.mh-row');
    if (row) openMatch(row.dataset.gameId, { el: row });
  }
  $('#homeMatchList').addEventListener('click', onMatchListClick);

  $('#btnHomeRefresh').addEventListener('click', () => loadMatches({ refresh: true }));
  $('#gidChip').addEventListener('click', copyGid);
  wireAccountSelect();
  wireSearch();
  loadSearchHistory();

  // 页顶「开始分析 / 重新判定」—— 全站唯一一处会花钱的按钮
  $('#btnDoAnalyze').addEventListener('click', () => {
    const gid = currentGameId || dataset?.match?.gameId;
    if (!gid) return;
    analyzeOne(gid, { force: !!result });
  });

  /* 分类切换 —— 纯前端重排，不动数据、不碰接口，点了立刻出结果 */
  $$('#groupBy .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    const next = btn.dataset.group;
    if (next === groupBy) return;
    groupBy = next;
    $$('#groupBy .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderGroups();
  }));

  /* ─────────── 页签（两套，各管各的容器） ─────────── */
  /**
   * 接管一组页签：点击时只切换「同一个容器内」的 pane。
   * 必须按容器限定 —— 否则两个页面的页签会互相把对方的 pane 也切掉。
   */
  function wireTabs(barSel, paneSel, key) {
    const tabs = $$(`${barSel} .tab`);
    const panes = $$(`${paneSel} .pane`);
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      const want = tab.dataset[key];
      panes.forEach((p) => p.classList.toggle('active', p.dataset.pane === want));
    }));
  }
  wireTabs('#tabs', '#page-report', 'tab');
  wireTabs('#cfgTabs', '#page-config', 'ctab');

  /* ─────────── 设置 ─────────── */
  $('#btnToggleKey').addEventListener('click', () => {
    const el = $('#setKey');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('#btnToggleKey').textContent = show ? '隐藏' : '显示';
  });
  // Key 只写到**用户配置目录**（%LOCALAPPDATA%\LOL背锅侠\config.json），
  // 不写 data/ —— 后者装着要能分享出去的战报，里面不该有凭据。
  $('#btnSaveKey').addEventListener('click', async () => {
    if (!BBX.available || !BBX.state.online) { toast('未连接本地服务，无法保存', true); return; }
    const val = $('#setKey').value.trim();
    try {
      const r = await BBX.config({ deepseekApiKey: val });
      const where = r.ai.configFile || '本机用户配置目录';
      $('#keyDesc').textContent = r.ai.hasKey
        ? `已配置（来源 ${r.ai.keySource === 'env' ? '环境变量，优先级更高' : '本机配置文件'}）\n明文保存在 ${where} —— 请勿把该文件外发`
        : '未配置 · 将走本地兜底判定';
      // 保存到哪儿必须说清楚：这个文件是明文，且**不在** data/ 里 ——
      // 用户按「分享 data/」的习惯操作时不会误发它，但也别让他以为没落盘
      toast(r.ai.hasKey ? `已明文保存到 ${where}（请勿外发）` : '已清除本机 Key');
      $('#setKey').value = '';
    } catch (e) {
      toast('保存失败：' + e.message, true);
    }
  });

  $('#setTone').addEventListener('change', (e) => {
    tone = e.target.value;
    renderCast();
    // 同步给服务端，让自动判定也用这个语气
    if (BBX.available && BBX.state.online) BBX.config({ tone }).catch(() => {});
  });
  $('#setScope').addEventListener('change', renderCast);

  // 赛后自动分析 —— 默认关：打完只登记，判定由人点。
  // 打开就回到旧行为（打完自动判定，会调用模型、消耗额度），所以要说清后果。
  const autoChk = $('#setAutoAnalyze');
  if (autoChk) {
    autoChk.addEventListener('change', async () => {
      if (!BBX.available || !BBX.state.online) {
        autoChk.checked = !autoChk.checked;
        toast('未连接本地服务，无法保存', true);
        return;
      }
      try {
        await BBX.config({ autoAnalyze: autoChk.checked });
        toast(autoChk.checked
          ? '已开启：打完一局自动判定（会调用模型）'
          : '已关闭：打完只登记，要判定时点「开始分析」');
      } catch (e) {
        autoChk.checked = !autoChk.checked;
        toast('保存失败：' + e.message, true);
      }
    });
  }

  /* ─────────── 提示词编辑器 ─────────── */
  const LS_KEY = 'blamebox.prompt.v1';
  const DEFAULTS = { params: { ...(PR.params || {}) }, blocks: { ...(PR.blocks || {}) } };

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }
  // 按 key 合并：旧存档里没有的新默认参数不会被丢失
  const saved = loadSaved();
  const state = {
    params: { ...DEFAULTS.params, ...(saved.params || {}) },
    blocks: { ...DEFAULTS.blocks, ...(saved.blocks || {}) },
  };

  const render = (text, params) =>
    String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])));

  function buildSystem() {
    return (PR.order || []).map((k) => render(state.blocks[k], state.params)).join('\n\n');
  }

  function renderPromptEditor() {
    // 参数层
    const groups = {};
    (PR.paramMeta || []).forEach((m) => { (groups[m.group] = groups[m.group] || []).push(m); });
    $('#paramGrid').innerHTML = (PR.paramMeta || []).map((m) => `
      <div class="param-item">
        <label>${esc(m.label)}<small>${esc(m.hint || '')}</small></label>
        <input type="number" step="any" data-key="${m.key}" value="${state.params[m.key]}">
      </div>`).join('');
    $$('#paramGrid input').forEach((inp) => inp.addEventListener('input', () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      state.params[inp.dataset.key] = v;
      renderPreview();
    }));

    // 区块层
    $('#blockList').innerHTML = (PR.blockMeta || []).map((m) => `
      <div class="block-item" data-key="${m.key}">
        <div class="block-head"><b>${m.name}</b><span>${esc(m.note || '')}</span></div>
        <textarea rows="7" data-key="${m.key}">${esc(state.blocks[m.key])}</textarea>
      </div>`).join('');
    $$('#blockList .block-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
    $$('#blockList textarea').forEach((ta) => ta.addEventListener('input', () => {
      state.blocks[ta.dataset.key] = ta.value;
      renderPreview();
    }));

    renderPreview();
  }

  /**
   * 预览里喂给模型的 dataset —— 与 src/deepseek/prompt.mjs 的 modelDataset() 保持一致：
   * 图标路径只给界面用，进 model 消息纯属噪音（一次约 5000 tokens），预览也必须剔掉，
   * 否则预览显示的和真正发出去的不是同一份。
   */
  function modelDatasetPreview(ds) {
    if (!ds?.players) return ds;
    return {
      ...ds,
      players: ds.players.map((p) => ({
        ...p,
        items: (p.items || []).map((x) => (x && typeof x === 'object' ? { id: x.id, name: x.name } : x)),
        augments: (p.augments || []).map((x) => (x && typeof x === 'object'
          ? { id: x.id, name: x.name, rarity: x.rarity, rarityCn: x.rarityCn } : x)),
      })),
    };
  }

  function renderPreview() {
    const sys = buildSystem();
    const preview = render(state.blocks.user_template || '', state.params)
      .replace('{{tone}}', '标准')
      .replace('{{dataset}}', JSON.stringify(modelDatasetPreview(dataset), null, 2));
    $('#previewText').textContent = sys + '\n\n──────── user ────────\n\n' + preview;
    $('#previewMeta').textContent = `${(PR.blockMeta || []).length} 区块 · ${(PR.paramMeta || []).length} 参数 · ${sys.length} 字`;
  }

  $('#btnSavePrompt').addEventListener('click', () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ params: state.params, blocks: state.blocks }));
      $('#saveHint').textContent = '已保存到本机';
      setTimeout(() => ($('#saveHint').textContent = ''), 1800);
    } catch { $('#saveHint').textContent = '保存失败'; }
  });

  $('#btnResetPrompt').addEventListener('click', () => {
    // 恢复默认只重置草稿，需再点保存才固化
    state.params = { ...DEFAULTS.params };
    state.blocks = { ...DEFAULTS.blocks };
    renderPromptEditor();
    $('#saveHint').textContent = '已重置草稿，点「保存」才固化';
  });

  /* ─────────── 后端接入 ─────────── */

  function setServerHint(text, isErr) {
    const el = $('#serverHint');
    if (!el) return;
    el.textContent = text;
    el.className = 'idle-hint' + (isErr ? ' err' : '');
  }

  /** 服务端推送：阶段变化 / 自动判定 / 战报生成 */
  function onServerEvent(ev) {
    switch (ev.type) {
      case 'client':
        if (ev.online) {
          $('#clientDot').className = 'dot';
          if ($('#homeDot')) $('#homeDot').className = 'dot';
          $('#clientText').textContent = '客户端已连接';
          $('#metaClient').textContent = '已连接';
          if (ev.port) { $('#clientPort').textContent = String(ev.port); $('#metaPort').textContent = String(ev.port); }
        } else {
          applyClientState({ installed: true, running: false });
        }
        // 登录 / 下线会改变「当前账号」—— 账号清单与列表都要跟着重算
        loadAccounts().then(() => loadMatches({ refresh: false, silent: true }));
        break;

      case 'phase':
        $('#metaPhase').textContent = PHASE_CN[ev.phase] || ev.phase || 'Idle';
        break;

      case 'newgame':
        // 默认不再自动判定 —— 服务端只登记了新对局，这里提示一声即可。
        // 想自动判就把设置里的「赛后自动分析」打开（那时服务端推的会是 report）。
        toast('检测到新对局 · 已记入战绩，点开可看详情');
        loadMatches({ refresh: false, silent: true });
        break;

      case 'judging':
        // 判定过程的实时状态（阶段 / 已用秒 / 已输出字数）—— 判定十几秒起步，
        // 不推过程的话用户分不清「模型在写」和「已经卡死」
        onJudgeProgress(ev);
        break;

      case 'analyzing':
        // 回放中途突然弹动画会打断用户，只在等待页时播放
        if ($('#page-idle').classList.contains('active')) {
          toast('对局已结束，正在判定…');
          animateSteps({ minMs: 800 }).then(() => show('idle'));
        } else {
          toast('对局已结束，正在判定…');
        }
        break;

      case 'report':
        // 只有真的发生了页面切换才记返回点；已经在战报页就只是换数据
        if (!$('#page-report').classList.contains('active')) pushNav();
        applyReport(ev.report);
        show('report');
        toast('战报已生成 · ' + (ev.report.meta.source === 'deepseek' ? 'DeepSeek 判定' : '本地兜底'));
        break;

      case 'error':
        toast('自动判定失败：' + ev.message, true);
        break;

      default:
        break;
    }
  }

  async function initBackend() {
    if (!BBX.available) {
      setServerHint('离线模式 · 当前展示内置样例数据。用 start.bat 启动可读真实对局', true);
      return;
    }
    const online = await BBX.probe();
    if (!online) {
      setServerHint('未连接本地服务 · 请先运行 start.bat', true);
      return;
    }

    const st = BBX.state.status || {};
    const ai = st.ai || {};
    setServerHint(ai.hasKey
      ? `本地服务已连接 · DeepSeek 已配置（${ai.keySource === 'env' ? '环境变量' : '本机配置'}）`
        + (ai.autoAnalyze ? ' · 已开启赛后自动分析' : ' · 打完只登记，要判定时点「开始分析」')
      : '本地服务已连接 · 未配置 API Key，判定时会走本地兜底');

    const kd = $('#keyDesc');
    if (kd) {
      kd.textContent = ai.hasKey
        ? `已配置（来源 ${ai.keySource === 'env' ? '环境变量' : '本机配置文件'}）`
          + (ai.keySource !== 'env' && ai.configFile ? `\n明文保存在 ${ai.configFile} —— 请勿把该文件外发` : '')
        : '未配置 · 将走本地兜底判定';
    }
    const stTone = $('#setTone');
    if (stTone && ai.tone) { stTone.value = ai.tone; tone = ai.tone; renderCast(); }

    const autoBox = $('#setAutoAnalyze');
    if (autoBox) autoBox.checked = ai.autoAnalyze === true;

    try {
      applyClientState(await BBX.selftest());
    } catch { /* 探测失败不影响使用 */ }

    // 账号清单要在铺战绩之前拿到 —— 否则下拉是空的，用户看到的也是「还没选账号」
    await loadAccounts();

    // 推流可用性：默认开。加 ?nostream=1 关闭（受限环境 / 无头截图时用）
    let stream = true;
    try { stream = !new URLSearchParams(location.search).has('nostream'); } catch { /* 保持默认 */ }
    if (stream) BBX.subscribe(onServerEvent);
  }

  /* ─────────── 页脚：版本号 + 升级提示 ─────────── */

  /** ISO 时间 → 「10-11 11:20」 */
  function shortTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return String(iso || '').slice(0, 10);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * 页脚版本号。升级包只换 resources/app 里的代码、不碰数据，界面上几乎没有别的痕迹，
   * 所以「这次升级到底成了没有」全靠这行字 —— 版本号一变就说明装上了。
   * 升级记录来自 data/update.log（升级器对 data 唯一的写操作），没升过级就只显示版本号。
   */
  async function refreshVersion() {
    const ver = $('#verText');
    if (!ver) return;
    let app;
    try {
      // 走 BBX 而不是裸 fetch —— /api/* 现在要会话令牌，裸请求会被 401 挡下
      app = (await BBX.status())?.app || {};
    } catch {
      return;   // 离线打开（file://）或服务端没起 —— 页脚保持 v—
    }
    ver.textContent = app.version ? `v${app.version}` : 'v—';

    const note = $('#updNote');
    const up = app.lastUpdate;
    if (!note || !up?.version) return;

    let seen = null;
    try { seen = localStorage.getItem('bbx.seenUpdate'); } catch { /* 隐私模式，记不住就算了 */ }
    const fresh = seen !== String(up.version);
    note.textContent = `${fresh ? '刚刚升级到' : '上次升级'} v${up.version}（${shortTime(up.at)}）`;
    note.classList.remove('hidden');
    note.addEventListener('click', () => {
      note.classList.add('hidden');
      try { localStorage.setItem('bbx.seenUpdate', String(up.version)); } catch { /* 同上 */ }
    });
  }

  /* ─────────── 初始化 ─────────── */
  renderPromptEditor();
  renderCast();
  refreshVersion();
  $('#clientDot').className = 'dot off';

  // 等后端探测完成再决定走联机还是离线 —— 否则 #sim 会误判成离线
  initBackend().then(() => {
    // 开发用直达：index.html#report / #matches / #cast / #history / #settings / #prompt / #sim
    const hash = (location.hash || '').replace('#', '');
    if (hash === 'sim') {
      runSimulation();
    } else if (['settings', 'prompt'].includes(hash)) {
      // 配置页独立于战报页：直达时不用先铺一份战报
      show('config');
      const tab = $(`#cfgTabs .tab[data-ctab="${hash}"]`);
      if (tab) tab.click();
    } else if (['report', 'cast', 'history'].includes(hash)) {
      renderReport();
      show('report');
      const tab = $(`#tabs .tab[data-tab="${hash}"]`);
      if (tab) tab.click();
    } else {
      // 首页默认动作：把当前登录账号的战绩铺出来（不再需要先点按钮）
      loadMatches({ refresh: true, silent: true });
    }
  });
})();
