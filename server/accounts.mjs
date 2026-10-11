/**
 * 本机账号登记表 —— 谁在这台机器上打过。
 *
 * 为什么需要：一台机器同时只能登一个账号，但换着登就会出现
 * 「A 的战报和 B 的战绩混在一张列表里」。所以每一局、每份战报都要记下**归属账号**，
 * 界面只显示当前账号的那一份。
 *
 * 账号用什么标识：**puuid**。昵称可以改、召唤师名可以改，puuid 不变。
 * 昵称只用于显示，随时会被下次登录刷新。
 *
 * 三种「当前」要分清：
 *   current  客户端此刻登录的账号（客户端没开时为 null）
 *   last     最后一次登录过的账号 —— 没登录时界面默认看它
 *   viewing  界面正在看哪个账号（用户在下拉里选的）
 *
 * ★ viewing 故意**只存在内存里、不落盘**：
 *   大哥要的是「打开就默认看当前登录账号」。如果把它持久化，上次切到别的账号看一眼、
 *   关掉再打开，默认就跑到那个账号去了 —— 跟「默认当前登录」冲突。
 *   所以每次启动都回到默认：当前登录 → 没登录就最后登录过的那个。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/env.mjs';

export const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

/** 未归属这个「账号」不是账号，只是个桶：早期抓的数据认不出主人时都落这里 */
export const UNOWNED = 'unowned';
/** 「全部」—— 看所有人的数据，排查用 */
export const ALL = 'all';

/** 界面正在看哪个（内存态，重启即回到默认） */
let viewingKey = null;

const EMPTY = () => ({ updatedAt: null, current: null, last: null, accounts: {} });

export function loadAccounts() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { j = null; }
  const o = { ...EMPTY(), ...(j || {}) };
  if (!o.accounts || typeof o.accounts !== 'object') o.accounts = {};
  delete o.viewing;      // 早期版本把它落过盘，现在只走内存 —— 读出来直接丢掉
  return o;
}

export function saveAccounts(o) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ ...o, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/** 从 current-summoner 的响应里挑出要留的字段（其余会变、也占地方） */
function pick(me) {
  if (!me?.puuid) return null;
  return {
    puuid: me.puuid,
    displayName: me.displayName || me.gameName || me.name || null,
    gameName: me.gameName || null,
    tagLine: me.tagLine || null,
    summonerId: me.summonerId ?? null,
    accountId: me.accountId ?? null,
    profileIconId: me.profileIconId ?? null,
  };
}

/**
 * 记一个账号（登录时 / 迁移时调用）。
 * @param {object} me   current-summoner 响应
 * @param {object} opts
 *   source  'login'（客户端探测到）| 'inferred'（迁移推断出）
 *   markCurrent 是否同时置为 current（客户端此刻登录着）
 *   makeLast    是否同时置为 last
 */
export function rememberAccount(me, { source = 'login', markCurrent = true, makeLast = true } = {}) {
  const p = pick(me);
  if (!p) return null;
  const o = loadAccounts();
  const now = new Date().toISOString();
  const prev = o.accounts[p.puuid] || {};
  o.accounts[p.puuid] = {
    ...prev,
    ...p,
    // 昵称可能是空的（拿不到就别把已有的抹掉）
    displayName: p.displayName || prev.displayName || null,
    firstSeenAt: prev.firstSeenAt || now,
    lastSeenAt: now,
    source: prev.source === 'login' ? 'login' : source,
  };
  if (markCurrent) {
    // 换了登录账号 → 界面默认跟着切过去（正在看老账号的话，说明用户只是想瞄一眼）
    if (o.current && o.current !== p.puuid) viewingKey = null;
    o.current = p.puuid;
  }
  if (makeLast) o.last = p.puuid;
  saveAccounts(o);
  return o.accounts[p.puuid];
}

/** 直接登记一个 puuid（迁移时用，手头没有完整的 current-summoner 响应） */
export function registerAccount({ puuid, displayName = null, source = 'inferred', makeLast = false }) {
  if (!puuid) return null;
  return rememberAccount({ puuid, displayName }, { source, markCurrent: false, makeLast });
}

/** 客户端下线后调用：current 清空，last 保留 */
export function clearCurrent() {
  const o = loadAccounts();
  if (!o.current) return false;
  o.current = null;
  saveAccounts(o);
  return true;
}

export function setCurrent(puuid) {
  const o = loadAccounts();
  if (o.current === puuid) return;
  viewingKey = null;                       // 换账号 → 视图回到默认
  o.current = puuid || null;
  if (puuid) o.last = puuid;
  saveAccounts(o);
}

/** 界面选看哪个账号（只存内存，重启回默认） */
export function setViewing(key) {
  viewingKey = key || null;
}

/**
 * 把界面给的 key 翻译成「过滤条件」。
 * @returns {string} puuid | ALL | UNOWNED
 */
export function resolveViewing(key) {
  const o = loadAccounts();
  // key 传 undefined / null = 用界面当前的选择；都没选 → 当前登录 → 最后一次登录
  const k = key || viewingKey || o.current || o.last;
  if (k === ALL) return ALL;
  if (k === UNOWNED) return UNOWNED;
  if (k === 'current') return o.current || o.last || UNOWNED;
  if (k === 'last') return o.last || o.current || UNOWNED;
  if (k && o.accounts[k]) return k;
  return o.current || o.last || UNOWNED;
}

/** 界面用的账号清单：已知账号 + 两个虚拟项（按数据量决定要不要给） */
export function accountList({ includeAll = false } = {}) {
  const o = loadAccounts();
  const list = Object.values(o.accounts)
    .map((a) => ({
      key: a.puuid,
      puuid: a.puuid,
      name: a.displayName || a.gameName || a.puuid.slice(0, 8),
      isCurrent: a.puuid === o.current,
      isLast: a.puuid === o.last,
      source: a.source || null,
      lastSeenAt: a.lastSeenAt || null,
    }))
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  if (includeAll) list.push({ key: ALL, name: '全部账号', virtual: true });
  return { list, current: o.current, last: o.last, viewing: viewingKey };
}

/** 展示名（界面上不想只看到一串 puuid） */
export function accountName(puuid) {
  if (!puuid) return null;
  if (puuid === UNOWNED) return '未归属';
  if (puuid === ALL) return '全部账号';
  const o = loadAccounts();
  return o.accounts[puuid]?.displayName || o.accounts[puuid]?.gameName || puuid.slice(0, 8);
}
