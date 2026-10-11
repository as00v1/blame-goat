/* ──────────────────────────────────────────────────────────
   BlameGoat 后端接入层
   经 start.bat / server.mjs 打开时连本地服务；直接用 file:// 双击
   打开时自动降级为纯离线演示（用 data.js 里的内置样例）。
   ────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // 后端地址：优先取 ?api= 参数（便于 file:// 直开时也能连本地服务），
  // 否则同源；file:// 且未指定则判定为离线演示模式
  const BASE = (() => {
    let q = null;
    try { q = new URLSearchParams(location.search).get('api'); } catch { /* 忽略 */ }
    if (q) return q.replace(/\/+$/, '');
    return location.protocol === 'file:' ? null : location.origin;
  })();

  /**
   * 会话令牌 —— 服务端每次启动随机生成，随首屏 HTML 下发（见 server.mjs）。
   *
   * 跨域页面读不到同源 HTML，也就拿不到它：这才是「只有本机界面能调 API」的凭据。
   * file:// 直开时页面上没有这一行 meta，但那时也不连接服务（离线演示），
   * 要用 ?api= 手动连，就得把令牌一起带上（?token=）。
   */
  const TOKEN = (() => {
    try {
      const meta = typeof document !== 'undefined' && document.querySelector
        ? document.querySelector('meta[name="bbx-token"]')
        : null;
      if (meta && meta.content) return meta.content;
      const t = new URLSearchParams(location.search).get('token');
      return t || null;
    } catch { return null; }
  })();

  const state = { online: false, status: null, lastError: null };

  async function req(path, opts) {
    if (!BASE) throw new Error('离线打开（file://），未连接本地服务');
    const res = await fetch(BASE + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { 'X-BBX-Token': TOKEN } : {}),
        ...((opts && opts.headers) || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return res.json();
  }

  /** 探活 + 拉一次全局状态；返回是否在线 */
  async function probe() {
    try {
      state.status = await req('/api/status');
      state.online = true;
      state.lastError = null;
    } catch (e) {
      state.online = false;
      state.lastError = e.message;
    }
    return state.online;
  }

  /** 订阅服务端事件（阶段变化 / 战报生成 / 客户端上下线） */
  function subscribe(onEvent, onOpen) {
    if (!BASE || typeof EventSource === 'undefined') return null;
    // EventSource 改不了请求头 —— 令牌只能挂在查询串上（服务端对 SSE 特别放行）
    const url = BASE + '/api/events' + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
    const es = new EventSource(url);
    let opened = false;
    es.onopen = () => { opened = true; if (onOpen) onOpen(); };
    es.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ }
    };
    es.onerror = () => {
      if (!opened) state.online = false;   // 连不上就维持离线判定
      // EventSource 自带重连，不手动关
    };
    return es;
  }

  window.BBX = {
    state,
    probe,
    subscribe,
    status: () => req('/api/status'),
    selftest: () => req('/api/selftest'),
    analyze: (source, tone) => req('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ source, tone }),
    }),
    config: (patch) => req('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
    /** 历史战报（默认只看当前查看的账号） */
    reports: (account = null) => req('/api/reports' + (account ? `?account=${encodeURIComponent(account)}` : '')),
    report: (file) => req('/api/reports/' + encodeURIComponent(file)),
    /** 本机账号清单（含当前登录 / 最后一次登录 / 正在查看的） */
    accounts: () => req('/api/accounts'),
    /** 切换查看哪个账号：puuid | 'all' | 'unowned' */
    selectAccount: (key) => req('/api/accounts', { method: 'POST', body: JSON.stringify({ key }) }),
    /** 战绩列表：LCU 窗口 ∪ 已落盘战报 ∪ 本地累积索引；account 不传 = 当前查看的账号 */
    matches: ({ limit = 500, refresh = true, account = null } = {}) =>
      req(`/api/matches?limit=${limit}&refresh=${refresh ? 1 : 0}`
        + (account ? `&account=${encodeURIComponent(account)}` : '')),
    /** 分析指定的某一局（战绩列表点进来的） */
    analyzeMatch: (gameId, { tone = null, force = false, perspective = null } = {}) => req('/api/analyze-match', {
      method: 'POST',
      body: JSON.stringify({ gameId, tone, force, perspective }),
    }),
    /**
     * 对局详情 —— 点列表行的第一站。只读原始数据，**不调模型**。
     * 盘里已有战报就直接回放；没有就只给客观数据，判定留到用户点「开始分析」。
     */
    matchDetail: (gameId, { perspective = null } = {}) =>      req(`/api/match-detail?gameId=${encodeURIComponent(gameId)}`
        + (perspective ? `&perspective=${encodeURIComponent(perspective)}` : '')),
    /** 本机名录概况（认识多少人 / 见过多少局） */
    roster: () => req('/api/roster'),
    /** 按昵称找本机见过的召唤师 —— 客户端不支持按名字查人，只能查名录 */
    searchSummoner: (q) => req('/api/summoner/search?q=' + encodeURIComponent(q)),
    /** 搜索历史：进查询视图时记一笔；界面上直接渲染成「最近搜过」 */
    rememberSearch: (item) => req('/api/search-history', {
      method: 'POST',
      body: JSON.stringify(item),
    }),
    searchHistory: () => req('/api/search-history'),
    clearSearchHistory: () => req('/api/search-history', { method: 'DELETE' }),
    /** 某人的战绩；服务端缓存 10 分钟，refresh=1 强制重拉 */
    summonerMatches: (puuid, { refresh = false } = {}) =>
      req(`/api/summoner/matches?puuid=${encodeURIComponent(puuid)}&refresh=${refresh ? 1 : 0}`),
    /** 分析最近一局 */
    analyzeLatest: ({ tone = null, force = false } = {}) => req('/api/analyze-latest', {
      method: 'POST',
      body: JSON.stringify({ tone, force }),
    }),
    watch: (on) => req('/api/watch', { method: 'POST', body: JSON.stringify({ on: !!on }) }),
    /**
     * LCU 资源（英雄图标）转成浏览器可直接访问的地址；离线时返回 null。
     * <img src> 发不出自定义请求头，所以令牌跟 SSE 一样走查询串。
     */
    asset: (p) => (BASE && p
      ? `${BASE}/api/asset?p=${encodeURIComponent(p)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`
      : null),
    get available() { return !!BASE; },
    get origin() { return BASE; },
  };
})();
