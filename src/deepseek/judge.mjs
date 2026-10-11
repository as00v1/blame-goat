/**
 * DeepSeek 判定模块
 *
 * 链路：anonymize() → 组装提示词 → 调 DeepSeek → 结构化校验 → 失败则本地兜底 → deanonymize()
 *
 * 四道防线：
 *  1. 规则前置        —— 判定标准全部写进 System Prompt
 *  2. 领域常识注入    —— 显式声明大乱斗 ≠ 峡谷
 *  3. 结构化输出+校验 —— 强制 JSON，本地校验标签合法性/分数范围/人数完整
 *  4. 证据约束        —— 每条判定必须附 evidence 引用具体数值或时间点
 */

import { DEFAULT_PARAMS, buildMessages, TONES } from './prompt.mjs';
import { buildIdentityIndex, assignPids, flattenPlayers, playerKey } from '../lcu/participants.mjs';

export const MODEL = 'deepseek-v4-flash';
export const BASE_URL = 'https://api.deepseek.com';
export const REQUEST_CONFIG = {
  temperature: 0.7,      // 判定稳定 + 文案有文采的折中
  // ★ v3.0 提示词把 insight 扩到 300-400 字、个人 reason 扩到 150 字、teamInsight 三条共 450 字，
  //   输出量约翻倍。2600 一定会把 JSON 截在中间 —— 截断即解析失败即兜底，
  //   白烧一次调用还看不到模型写的长文。所以放到 4000。
  max_tokens: 4000,
  thinking: false,       // 开启后延迟 3s → 8s，赛后战报要快
  response_format: { type: 'json_object' },

  // 超时改成三段（原来只有「整包 60s」一个）：
  //   firstByteMs  等首字节 —— 排队 / 网络不通属于这一类，等太久没有意义
  //   timeoutMs    ★ 语义变了：流式下它是「两次数据之间的静默上限」。
  //                模型在持续输出就不该被打断，卡住不动才是真出问题。
  //                一刀切卡总时长会把「写得慢但正常」的局误杀成兜底 —— 这正是
  //                「判定老走兜底」的主因：报告变长之后，60s 经常不够。
  //   maxMs        总时长硬顶。给个上限，免得一个卡住的流把界面挂死。
  firstByteMs: 30_000,
  timeoutMs: 60_000,
  maxMs: 150_000,
  /** 流式进度回调的节流间隔 —— chunk 很密，回调太勤会把 SSE 打满 */
  progressEveryMs: 250,
};

export const LABELS = ['CARRY', 'BLAME', 'TEFLON', 'FREELOADER', 'NORMAL'];
export const LABEL_CN = {
  CARRY: '大腿', BLAME: '背锅侠', TEFLON: '不粘锅', FREELOADER: '混子', NORMAL: '普通',
};
/**
 * 某个标签的分数线（0-10 制）—— reconcileLabels 钳位用。
 * 只收「有明确上下界」的两个：其余标签的区间是参考线，不是硬边界。
 * 阈值一律从参数取（不写死 8 / 4）—— 界面调参后这里必须跟着走，否则会错钳。
 */
function labelLine(label, p) {
  if (label === 'CARRY') return [p.carry_score_min, 10];
  if (label === 'BLAME') return [0, p.blame_score_max];
  return null;
}
/** 英雄类型中文名（兜底判定拼阵容结论用） */
const TYPE_CN = {
  FIGHTER: '战士', MAGE: '法师', ASSASSIN: '刺客', TANK: '坦克',
  MARKSMAN: '射手', SUPPORT: '辅助', UNKNOWN: '未知',
};

/* ────────────────── 隐私层 ────────────────── */

/** 取玩家显示名。真机 EOG 的 summonerName 有值，match-detail 那边 summonerName 反而是空的 */
export function playerDisplayName(p) {
  return p?.summonerName || p?.riotIdGameName || p?.gameName || null;
}

/**
 * 从原始 EOG 建立「昵称 → pid」映射。
 *
 * ★ pid 必须与 normalize 完全一致：两处都走 participants.mjs 的 assignPids。
 *   对不上的后果不是显示错乱，而是 anonymize 把 A 的昵称换成 B 的 pid —— 
 *   等于把真名喂给模型，隐私层失效。真机踩过这个坑（十人塌成 p10）。
 *
 * @param {object} eog
 * @param {object|null} matchDetail 提供 participantId 桥接（真机必需）
 */
export function buildNameMap(eog, matchDetail = null) {
  const players = flattenPlayers(eog);
  const pids = assignPids(players, buildIdentityIndex(matchDetail));

  const map = {};
  players.forEach((p, i) => {
    const name = playerDisplayName(p);
    const pid = pids.byKey.get(playerKey(p, i));
    if (name && pid) map[name] = pid;
  });
  return map;
}

/** 深度替换：任何字符串里出现真实昵称 → 换成 pid。真实昵称不出本机、不落盘 */
export function anonymize(obj, nameMap) {
  const names = Object.keys(nameMap);
  if (!names.length) return obj;
  const walk = (v) => {
    if (typeof v === 'string') {
      let out = v;
      for (const n of names) out = out.split(n).join(nameMap[n]);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return walk(obj);
}

/** 校验：dataset 中不应残留任何真实昵称 */
export function assertNoRealNames(dataset, nameMap) {
  const dump = JSON.stringify(dataset);
  return Object.keys(nameMap).filter((n) => dump.includes(n));
}

/** 返回后本地还原：把 pid 换回真实昵称（仅用于本机界面展示） */
export function deanonymizeText(text, pidToName) {
  let out = text;
  // 长 pid 优先，避免 p1 命中 p10 的前缀
  Object.keys(pidToName)
    .sort((a, b) => b.length - a.length)
    .forEach((pid) => { out = out.split(pid).join(pidToName[pid]); });
  return out;
}

/**
 * 把 result 里「给人看」的文本从 pid 还原成昵称。
 *
 * ★ 绝不能对 result 做无差别深度替换：result.players[].pid 是前端用来和
 *   dataset.players[].pid 对齐的键，换成昵称之后卡片就找不到自己的判定了。
 *   所以这里逐个点名，只动文本字段。
 *
 * 放在 judge.mjs 而不是各处各写一份 —— 服务端与离线原型都要用，
 * 早先原型漏了这一步，落盘的样例里就出现了「红方p8卡尔萨斯」这种半截文本。
 */
export function restoreResultText(result, pidToName) {
  if (!result || !pidToName) return result;
  const fix = (s) => (typeof s === 'string' ? deanonymizeText(s, pidToName) : s);
  return {
    ...result,
    verdict: fix(result.verdict),
    insight: fix(result.insight),
    // 播报稿里也可能有 pid / p1 写法，一并还原成昵称
    cast: result.cast?.lines
      ? { ...result.cast, lines: result.cast.lines.map((s) => fix(String(s))) }
      : result.cast,
    // v2.4 / v3.0 的团队结论同样可能写到 pid，需要一并还原（但只动文本，不动结构）
    teamInsight: result.teamInsight
      ? {
        ...result.teamInsight,
        compositionNote: fix(result.teamInsight.compositionNote),
        augmentNote: fix(result.teamInsight.augmentNote),
        itemNote: fix(result.teamInsight.itemNote),
      }
      : result.teamInsight,
    players: (result.players || []).map((p) => ({
      ...p,
      reason: fix(p.reason),
      evidence: (p.evidence || []).map(fix),
    })),
  };
}

/* ────────────────── 结构化校验 ────────────────── */

export function validateResult(raw, dataset, params = DEFAULT_PARAMS) {
  const errors = [];
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, errors: ['JSON 无法解析: ' + e.message], data: null };
  }
  if (!data || typeof data !== 'object') return { ok: false, errors: ['结果不是对象'], data: null };

  if (typeof data.verdict !== 'string' || !data.verdict.trim()) errors.push('verdict 缺失或非字符串');
  if (typeof data.insight !== 'string' || !data.insight.trim()) errors.push('insight 缺失或非字符串');

  // ★ teamInsight（v3.0：compositionNote / augmentNote / itemNote 三条团队结论）。
  //   刻意只做「类型对不上就报错」，缺字段不判失败 —— 为了几个可选文本字段
  //   把整局打回本地兜底，等于白烧一次模型调用，不划算。
  //   界面那边按「有就显示、没有就连壳子一起收掉」处理，所以这里必须宽容。
  if (data.teamInsight != null) {
    if (typeof data.teamInsight !== 'object' || Array.isArray(data.teamInsight)) {
      errors.push('teamInsight 不是对象');
    } else {
      for (const k of ['compositionNote', 'augmentNote', 'itemNote']) {
        const v = data.teamInsight[k];
        if (v != null && typeof v !== 'string') errors.push(`teamInsight.${k} 不是字符串`);
      }
    }
  }

  const expectPids = dataset.players.map((p) => p.pid);
  if (!Array.isArray(data.players)) {
    errors.push('players 不是数组');
  } else {
    const got = new Set();
    for (const p of data.players) {
      if (!expectPids.includes(p.pid)) { errors.push(`出现未知 pid: ${p.pid}`); continue; }
      got.add(p.pid);
      if (!LABELS.includes(p.label)) errors.push(`${p.pid} label 非法: ${p.label}`);
      // 0-10 制，允许一位小数（10 档整数太粗，10 个人挤在 11 个格子里分不出梯度）
      if (typeof p.score !== 'number' || !Number.isFinite(p.score) || p.score < 0 || p.score > 10) {
        errors.push(`${p.pid} score 越界（应为 0-10）: ${p.score}`);
      }
      if (typeof p.reason !== 'string' || !p.reason.trim()) errors.push(`${p.pid} reason 缺失`);
      if (!Array.isArray(p.evidence) || p.evidence.length < 2) errors.push(`${p.pid} evidence 少于 2 条`);
    }
    const missing = expectPids.filter((id) => !got.has(id));
    if (missing.length) errors.push(`人数不完整，缺少: ${missing.join(', ')}`);
    if (data.players.length !== expectPids.length) errors.push(`人数不符：期望 ${expectPids.length}，实际 ${data.players.length}`);
  }

  // 自洽性：标签与分数必须对得上。
  // ★ 阈值从参数层取（此前硬编码 80 / 40 —— 界面一旦调参，校验就会和
  //   模型收到的提示词对不上，出现「模型按 45 判 BLAME 却被 40 的旧线打回兜底」的错杀）。
  // ★ v1.2.5：0-10 制的档位更密，**轻微越界不再直接打回兜底** ——
  //   真机实测模型给「BLAME 但 4.2 分」（线是 ≤4），只差 0.2 就被毙掉，
  //   白烧一次调用还让用户看到兜底结论。这种交给 reconcileLabels 钳到线上即可。
  //   差得太多（>1 分）仍然算输出质量不合格，照旧打回。
  const SLACK = 1;
  for (const p of data.players || []) {
    const off = p.label === 'CARRY' ? params.carry_score_min - p.score
      : p.label === 'BLAME' ? p.score - params.blame_score_max
      : 0;
    if (off > SLACK) {
      errors.push(`${p.pid} 标 ${p.label} 但分数 ${p.score} 偏离 ${params.carry_score_min}/${params.blame_score_max} 超过 ${SLACK} 分`);
    }
  }
  // 胜方免责 —— 双向：BLAME 只能挂在输的那一方。
  // 早先只判了「本局赢了 → 我方不得 BLAME」，漏了「本局输了 → 敌方不得 BLAME」，
  // 真机就出现过「败方是我方，模型却给赢家崔斯特判了 BLAME」这种自相矛盾的结论。
  const myWin = dataset.match.myResult === 'WIN';
  for (const p of data.players || []) {
    if (p.label !== 'BLAME') continue;
    const src = dataset.players.find((x) => x.pid === p.pid);
    if (!src) continue;
    const isWinner = src.isMyTeam === myWin;
    if (isWinner) errors.push(`${p.pid} 属胜方却被判 BLAME`);
  }

  return { ok: errors.length === 0, errors, data };
}

/* ────────────────── 标签校准 ────────────────── */

/**
 * 提示词里那些「客观门槛」由代码兜底兑现。
 *
 * 为什么要这一层：把「死亡 ≥ X 且参团率 ≤ Y 即判混子」写进提示词之后，模型仍然会
 * 用自己的裁量把它判成「普通」—— 真机实测有一局薇恩 19 死 / 参团 49%，模型照样给
 * NORMAL。那是模型的自由度与工具的确定性在打架，不能每次都指望它自觉。
 *
 * 三条规则都带整改痕迹（写进 reason，并在 result._overrides 里留档）：
 *   ① 混子 / 不粘锅 —— 客观门槛命中而模型没判：**必须**改判，否则阈值形同虚设；
 *   ② 背锅侠 —— 败方一个都没有时，把败方最低分者改判并压到 ° blame_score_max 线内。
 *      这是本工具的立身之本（都叫背锅侠了，输了总得有人扛）。
 *      唯一的例外：模型如果在 verdict 里明写了「败因在团队而非个人」，尊重它的判断。
 *
 * 不改.model 的其余成果 —— insight / teamInsight / evidence 一字不动，
 * 改的只是「标签 ↔ 分数 ↔ 给这门牌」的对应关系，且每次改动都在 reason 里说清楚。
 */
export function reconcileLabels(result, dataset, params = DEFAULT_PARAMS) {
  if (!result?.players || !dataset?.players) return { ...result, _overrides: [] };
  const p = { ...DEFAULT_PARAMS, ...params };
  const src = new Map(dataset.players.map((pl) => [pl.pid, pl]));
  const honestVerdict = /败因在团队|团队而非个人|无个人失误/.test(result.verdict || '');

  const myWin = dataset.match?.myResult === 'WIN';
  const lostSide = (pl) => pl.isMyTeam !== myWin;   // 输了的那一边

  const overrides = [];
  const out = result.players.map((pl) => {
    const s = src.get(pl.pid);
    if (!s) return pl;
    const deaths = Number(s.deaths ?? 0);
    const dmg = Number(s.perMinute?.damageDealt ?? 0);
    const kp = Number(s.killParticipation ?? 0);

    // ⓪ 标签 ↔ 分数自洽钳位（0-10 制）。
    //    模型偶尔会给「BLAME 但 4.2 分」这种轻微越界（真机实测）。
    //    标签是它深思熟虑的结论，分数只是个刻度 —— **以标签为准把分数拽回线上**，
    //    宁可动刻度也不动结论。真越线超过 1 分的，validateResult 已经先打回兜底了。
    const line = labelLine(pl.label, p);
    if (line && typeof pl.score === 'number') {
      const fixed = pl.label === 'CARRY' ? Math.max(pl.score, line[0])
        : pl.label === 'BLAME' ? Math.min(pl.score, line[1])
        : null;
      if (fixed != null && fixed !== pl.score) {
        const why = `按 ${LABEL_CN[pl.label]} 的分数带把 ${pl.score} 校正到 ${fixed}`;
        overrides.push({ pid: pl.pid, from: pl.label, to: pl.label, why });
        return { ...pl, score: fixed, reason: `${pl.reason}（${why}）` };
      }
    }

    // ① 客观门槛：命中就把标签按阈值扣上（分数同步钳进该标签的区间，
    //    否则会出现「混子 60 分、背锅侠 38 分」这种自相矛盾的行。）
    if (deaths <= p.teflon_death_max && dmg >= p.teflon_damage_min && pl.label !== 'TEFLON') {
      const why = `死亡 ${deaths} ≤ ${p.teflon_death_max} 且每分钟伤害 ${Math.round(dmg)} ≥ ${p.teflon_damage_min}`;
      // 钳到不粘锅下限（0-10 制的 6 分线）
      const score = Math.max(Number(pl.score) || 0, 6);
      overrides.push({ pid: pl.pid, from: pl.label, to: 'TEFLON', why });
      return { ...pl, label: 'TEFLON', score, reason: `${pl.reason}（按客观门槛改判不粘锅：${why}）` };
    }
    if (deaths >= p.freeloader_death_min && kp <= p.freeloader_kp_max && pl.label !== 'FREELOADER') {
      const why = `死亡 ${deaths} ≥ ${p.freeloader_death_min} 且参团率 ${(kp * 100).toFixed(0)}% ≤ ${(p.freeloader_kp_max * 100).toFixed(0)}%`;
      // 钳到混子区间上沿（低于不粘锅的 6 分线）
      const score = Math.min(Number(pl.score) || 0, 5.9);
      overrides.push({ pid: pl.pid, from: pl.label, to: 'FREELOADER', why });
      return { ...pl, label: 'FREELOADER', score, reason: `${pl.reason}（按客观门槛改判混子：${why}）` };
    }
    return pl;
  });

  // ② 败方必须有背锅侠（模型明写「团队败因」的除外）
  const losers = dataset.players.filter(lostSide);
  const loserPids = new Set(losers.map((pl) => pl.pid));
  const hasBlame = out.some((pl) => loserPids.has(pl.pid) && pl.label === 'BLAME');
  if (!hasBlame && !honestVerdict && losers.length) {
    // 已经按客观门槛判成混子的不再改判背锅侠 —— 定义更具体的标签优先
    const candidates = out.filter((pl) => loserPids.has(pl.pid) && pl.label !== 'FREELOADER');
    const worst = candidates.slice().sort((a, b) => a.score - b.score)[0];
    if (worst) {
      const at = out.findIndex((pl) => pl.pid === worst.pid);
      overrides.push({ pid: worst.pid, from: worst.label, to: 'BLAME', why: '败方无人被判背锅侠，按本工具口径由最低分者承担' });
      out.splice(at, 1, {
        ...worst,
        label: 'BLAME',
        score: Math.min(worst.score, p.blame_score_max),
        reason: `${worst.reason}（败方原本无人被判背锅侠，按本工具口径由最低分者承担。）`,
      });
    }
  }

  if (!overrides.length) return result;
  return { ...result, players: out, _overrides: overrides };
}

/* ────────────────── DeepSeek 调用 ────────────────── */

/**
 * 判定过程对外说的「阶段」。界面拿它显示实时进度，别改字面量（前端有对照表）。
 *   prepare → submit → wait → stream → parse → done / fallback
 */
export const JUDGE_PHASES = ['prepare', 'submit', 'wait', 'stream', 'parse', 'done', 'fallback'];

/**
 * 调 DeepSeek —— **流式**。
 *
 * 为什么要流式：判定动辄十几秒，原来整包等到底，界面只能干转假动画，
 * 用户看不出「模型在写」还是「已经卡死」。流式之后每来一段就能把
 * 「已输出多少字 / 已等多久」推给界面，慢也能看出在动。
 *
 * 顺带修掉一个真问题：原来 timeoutMs 是**整包**上限，输出一变长就被掐断 →
 * 解析失败 → 兜底。现在它只管「两次数据之间的静默」，模型一直在写就不打断。
 *
 * @param {object} opts.onProgress ({phase, elapsedMs, chars, tokens}) => void
 */
export async function callDeepSeek(messages, apiKey, opts = {}) {
  const cfg = { ...REQUEST_CONFIG, ...opts };
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const started = Date.now();
  const emit = (phase, extra = {}) => {
    if (onProgress) onProgress({ phase, elapsedMs: Date.now() - started, ...extra });
  };

  const controller = new AbortController();
  // 三个计时器各管一件事，谁先响就记下理由 —— 兜底时界面要原样告诉用户「为什么」
  let stopReason = null;
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stopReason = `模型输出中断超过 ${Math.round(cfg.timeoutMs / 1000)} 秒`;
      controller.abort();
    }, cfg.timeoutMs);
  };
  const firstTimer = setTimeout(() => {
    stopReason = `模型 ${Math.round(cfg.firstByteMs / 1000)} 秒内没有开始输出`;
    controller.abort();
  }, cfg.firstByteMs);
  const maxTimer = setTimeout(() => {
    stopReason = `模型总耗时超过 ${Math.round(cfg.maxMs / 1000)} 秒`;
    controller.abort();
  }, cfg.maxMs);

  try {
    const body = {
      model: opts.model || MODEL,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
      response_format: cfg.response_format,
      stream: true,
      // 用量统计在流结束后单独来一个 chunk（choices 为空），带上它才能记 tokens
      stream_options: { include_usage: true },
    };
    // 关闭思考模式（部分兼容层用该字段）
    if (!cfg.thinking) body.thinking = { type: 'disabled' };

    emit('submit', { model: body.model });
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    // 兼容：个别网关不认 stream 参数，直接回整包 JSON —— 那就按老路子解析，
    // 只是界面上拿不到「输出中」的进度（只有 wait / parse 两个阶段）
    const isStream = !!res.body && /event-stream/i.test(String(res.headers.get('content-type') || ''));
    if (!isStream) {
      emit('wait');
      const text = await res.text();
      emit('parse', { chars: text.length });
      const json = JSON.parse(text);
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error('响应中没有 content');
      return { content, usage: json.usage || null, model: json.model || body.model };
    }

    emit('wait');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf8');
    let buf = '';
    let content = '';
    let usage = null;
    let model = body.model;
    let firstByte = false;
    let lastEmit = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE 按行切：一行一个 `data: {...}`，可能一次到半行，所以要留着 buffer 尾巴
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let js;
        try { js = JSON.parse(payload); } catch { continue; }
        if (js.model) model = js.model;
        if (js.usage) usage = js.usage;
        const delta = js.choices?.[0]?.delta?.content;
        if (delta) content += delta;
      }

      if (!firstByte && content) {
        firstByte = true;
        clearTimeout(firstTimer);   // 已经开始写，就不用再盯「首字节」了
      }
      armIdle();                    // 收到数据就续命 —— 卡住不动才会走到 timeoutMs

      const now = Date.now();
      if (now - lastEmit >= (cfg.progressEveryMs || 250)) {
        lastEmit = now;
        emit('stream', { chars: content.length, tokens: usage?.completion_tokens || null });
      }
    }

    if (!content) throw new Error('响应中没有 content');
    emit('stream', { chars: content.length, tokens: usage?.completion_tokens || null });
    return { content, usage, model };
  } catch (e) {
    // 自己掐断的（三个计时器之一）说人话；其余按原样抛
    if (stopReason) throw new Error(stopReason);
    throw e;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(maxTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

/* ────────────────── 本地兜底 ────────────────── */

/**
 * 断网 / 无 Key / 模型返回不合法时的降级链路。
 * 刻意保守：拿不准的一律 NORMAL，只标最明显的几类。
 * 分数按标签区间钳制，保证「标签 ↔ 分数」自洽。
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 尺度标定（真机实测 2026-10-09 · 29 分钟海克斯大乱斗）：            │
 * │   参团率    0.51 – 0.87                                         │
 * │   死亡      12 – 22                                             │
 * │   伤害/分   1100 – 5900                                         │
 * │                                                                │
 * │ 早先按峡谷尺度写的公式（伤害除 120、死亡项用 20-死亡×1.8）在       │
 * │ 这局上**两项同时饱和**：伤害项两人顶格、死亡项全员归零，十个人       │
 * │ 全挤在 42–80 之间 → 一个标签都判不出来，全员「普通」。            │
 * │ 所以伤害锚点放到 250/分、死亡锚点改 12 起罚。                     │
 * └────────────────────────────────────────────────────────────────┘
 */
export function fallbackJudge(dataset, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const win = dataset.match.myResult === 'WIN';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 1. 先算底分（只用于排序与展示，最终分数按标签区间钳制）
  const scored = dataset.players.map((pl) => {
    const kp = pl.killParticipation ?? 0;
    const dmg = pl.perMinute?.damageDealt ?? 0;
    // 胜负加成按「该玩家所在阵营」判定，不能拿本机视角套给对面
    const teamAdj = (pl.isMyTeam === win) ? 5 : -3;
    const base = 12
      + kp * 40
      + clamp(dmg / 250, 0, 24)
      - clamp((pl.deaths - 12) * 0.8, 0, 12)
      + teamAdj;
    return { pl, kp, dmg, base, lost: pl.isMyTeam !== win };
  });

  // 2. 定标签
  const labels = new Map();

  // 2.1 绝对规则 —— 与提示词里给模型的标准同源（不粘锅 / 混子）
  for (const r of scored) {
    if (r.pl.deaths <= p.teflon_death_max && r.dmg >= p.teflon_damage_min) labels.set(r.pl.pid, 'TEFLON');
    else if (r.pl.deaths >= p.freeloader_death_min && r.kp <= p.freeloader_kp_max) labels.set(r.pl.pid, 'FREELOADER');
  }

  // 2.2 相对规则 —— 大腿 = 全场分最高；背锅侠 = 败方分最低
  //
  // 为什么用相对而不是绝对分数线：大乱斗一局 10–30 分钟跨度太大，
  // 同一套绝对分数在短局和长局之间不可移植。
  // 判定层允许比较玩家 —— 四不原则约束的是**数据层**（不给模型参照系），
  // 不是判断层（模型本来就要判谁是大腿谁该背锅）。
  const rest = scored.filter((r) => !labels.has(r.pl.pid));
  const byDesc = rest.slice().sort((a, b) => b.base - a.base);
  const byAsc = rest.slice().sort((a, b) => a.base - b.base);

  const carry = byDesc[0];
  if (carry) labels.set(carry.pl.pid, 'CARRY');

  // 背锅侠只在败方里选（胜方免责）
  const blame = byAsc.find((r) => r.lost && !labels.has(r.pl.pid));
  if (blame) labels.set(blame.pl.pid, 'BLAME');

  // 3. 组装
  const players = scored.map(({ pl, kp, dmg, base }) => {
    const label = labels.get(pl.pid) || 'NORMAL';
    // 0-10 制：底分先从 100 制等比折算（base 大致落在 0-90），再按标签区间钳制。
    // 折算只发生在兜底这条路上（没有 Key / 调用失败）—— 正常判定的分数一律来自模型。
    const range = { CARRY: [8, 10], BLAME: [0, 4], TEFLON: [6, 10], FREELOADER: [4, 5.9], NORMAL: [4.5, 7.9] }[label];
    const score = Math.round(clamp(base * 0.1, range[0], range[1]) * 10) / 10;

    const reason = `${pl.champion}（${pl.championType}）${pl.kills}/${pl.deaths}/${pl.assists}，参团率 ${(kp * 100).toFixed(0)}%，每分钟伤害 ${Math.round(dmg)}。本地兜底判定，仅供参考。`;
    return {
      pid: pl.pid,
      label,
      score,
      reason,
      evidence: [
        `KDA ${pl.kills}/${pl.deaths}/${pl.assists}`,
        `参团率 ${(kp * 100).toFixed(0)}%`,
        `每分钟伤害 ${Math.round(dmg)}`,
      ],
    };
  });

  const best = players.slice().sort((a, b) => b.score - a.score)[0];
  const worst = players.slice().sort((a, b) => a.score - b.score)[0];

  // 阵容结论（兜底版）：只统计英雄类型构成，不做适配判断 ——
  // 「适配」是模型该干的事（约束第 10 条限定它只能进 teamInsight）
  const typeCount = (list) => {
    const m = {};
    for (const pl of list) {
      const t = pl.championType || 'UNKNOWN';
      m[t] = (m[t] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${TYPE_CN[t] || t}${n}`)
      .join('/');
  };
  const mine = dataset.players.filter((pl) => pl.isMyTeam);
  const theirs = dataset.players.filter((pl) => !pl.isMyTeam);
  const compositionNote = `我方 ${typeCount(mine) || '类型未知'}；对方 ${typeCount(theirs) || '类型未知'}。本地兜底仅统计类型构成，未做适配判断。`;
  // v3.0 的 teamInsight 有三个字段，兜底也得把形状凑齐，否则界面三块里会缺两块。
  // 但兜底绝不假装自己分析过 —— 它只确认「这个维度有没有数据」。
  const all = [...mine, ...theirs];
  const augmentNote = all.some((pl) => (pl.augments || []).length)
    ? '本地兜底不解读强化符文，仅确认本局有符文数据，请以模型判定为准。'
    : '本局无该维度数据。';
  const itemNote = all.some((pl) => (pl.items || []).length)
    ? '本地兜底不解读出装，仅确认本局有出装数据，请以模型判定为准。'
    : '本局无该维度数据。';

  return {
    verdict: win ? '本局拿下，团战节奏由前排与核心输出共同拉满。' : '本局失利，关键节点连续丢塔导致节奏崩塌。',
    insight: `全场分差最大的是 ${best.pid} 与 ${worst.pid}。本结果为本地兜底判定，未经过大模型复核，仅作链路验证。`,
    teamInsight: { compositionNote, augmentNote, itemNote },
    players,
    _source: 'fallback',
  };
}

/* ────────────────── 编排 ────────────────── */

/**
 * 报告文字里的「阵营编号」兜底清理。
 *
 * 送进模型的 dataset 已经不含 100 / 200（modelDataset 里换成了「我方 / 敌方」），
 * 但模型仍可能从自己的旧习里冒出「100队…200队…」——这种句子人看不懂。
 * 所以这里按本局视角把编号翻回阵营词：**只认「数字 + 队」的组合**，
 * 不去动伤害 100、金币 200 这类数值，避免误伤。
 *
 * 映射要按本局 myTeamId 来：100 在某一局是我方，在另一局可能就是敌方。
 */
export function sanitizeTeamNumbers(text, myTeamId) {
  if (typeof text !== 'string' || !text) return text;
  if (myTeamId == null) return text;
  return text.replace(/(\d{3})\s*队/g, (whole, num) => {
    const n = Number(num);
    if (n !== 100 && n !== 200) return whole;
    return n === Number(myTeamId) ? '我方' : '敌方';
  });
}

/** 对整个判定结果做一次阵营编号清理（文本字段全过一遍，结构与数值一个字不动） */
export function sanitizeResult(result, dataset) {
  if (!result) return result;
  const myTeamId = dataset?.match?.myTeamId ?? null;
  if (myTeamId == null) return result;
  const fix = (s) => sanitizeTeamNumbers(s, myTeamId);

  return {
    ...result,
    verdict: fix(result.verdict),
    insight: fix(result.insight),
    // 播报稿同样要过阵营编号清洗（模型可能写出「100 队」，播报里更致命 —— 是要念出来的）
    cast: result.cast?.lines
      ? { ...result.cast, lines: result.cast.lines.map((s) => fix(String(s))) }
      : result.cast,
    teamInsight: result.teamInsight
      ? Object.fromEntries(Object.entries(result.teamInsight).map(([k, v]) => [k, fix(v)]))
      : result.teamInsight,
    players: (result.players || []).map((p) => ({
      ...p,
      reason: fix(p.reason),
      evidence: Array.isArray(p.evidence) ? p.evidence.map(fix) : p.evidence,
    })),
  };
}

/**
 * @param {object} opts.onProgress 判定过程回调（{phase, elapsedMs, chars, tokens, reason}）
 *                 —— 服务端拿它广播 SSE，界面据此显示「模型正在写」而不是干转动画
 * @returns { ok, result, source: 'deepseek'|'fallback', errors, usage, elapsedMs }
 */
export async function judge(dataset, {
  apiKey, tone = 'normal', params = DEFAULT_PARAMS, logger = () => {}, onProgress = null,
} = {}) {
  const started = Date.now();
  const emit = (phase, extra = {}) => {
    if (onProgress) onProgress({ phase, elapsedMs: Date.now() - started, ...extra });
  };

  emit('prepare');
  const messages = buildMessages(dataset, tone, params);

  if (!apiKey) {
    logger('未提供 API Key → 走本地兜底');
    emit('fallback', { reason: '未提供 API Key' });
    return { ok: true, result: fallbackJudge(dataset, params), source: 'fallback', errors: ['未提供 API Key'], usage: null, elapsedMs: Date.now() - started };
  }

  try {
    logger(`调用 ${MODEL} …`);
    // 里头报的 elapsedMs 从「发起调用」算起，这里统一成「从进入判定」算起
    const { content, usage, model } = await callDeepSeek(messages, apiKey, {
      onProgress: (p) => emit(p.phase, p),
    });
    const check = validateResult(content, dataset, params);
    if (check.ok) {
      const reconciled = reconcileLabels(check.data, dataset, params);
      if (reconciled._overrides?.length) {
        logger(`标签校准 ${reconciled._overrides.length} 处：`
          + reconciled._overrides.map((o) => `${o.pid} ${o.from}→${o.to}`).join('，'));
      }
      emit('done', { chars: content.length, tokens: usage?.completion_tokens || null });
      return { ok: true, result: sanitizeResult(reconciled, dataset), source: 'deepseek', model, usage, errors: [], elapsedMs: Date.now() - started };
    }
    const reason = '结构化校验未通过：' + check.errors.slice(0, 2).join('；');
    logger('结构化校验未通过 → 兜底。问题：' + check.errors.join('; '));
    emit('fallback', { reason });
    return { ok: true, result: fallbackJudge(dataset, params), source: 'fallback', errors: check.errors, usage, elapsedMs: Date.now() - started };
  } catch (e) {
    logger('调用异常 → 兜底：' + e.message);
    emit('fallback', { reason: e.message });
    return { ok: true, result: fallbackJudge(dataset, params), source: 'fallback', errors: [e.message], usage: null, elapsedMs: Date.now() - started };
  }
}

