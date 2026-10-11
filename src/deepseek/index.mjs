/** DeepSeek 模块统一出口 */
export * from './prompt.mjs';
export * from './judge.mjs';

import { DEFAULT_PARAMS, promptStats } from './prompt.mjs';

/** 兜底版统计（参数不合法时也不抛错） */
export function promptStatsSafe(params = DEFAULT_PARAMS) {
  try {
    return promptStats(params);
  } catch {
    return { chars: 0, estTokens: 0, blocks: 9, params: Object.keys(DEFAULT_PARAMS).length };
  }
}
