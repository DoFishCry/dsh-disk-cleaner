/**
 * GarbageMaster — 会话复用策略（纯逻辑，可单测）。
 *
 * 规则（用户定稿）：
 *  - 没有会话                     → 新建
 *  - 跨天（本地日期变化）          → 新建
 *  - 上一轮**动过文件**（清理/打包/整理真的执行了）→ 新建
 *  - 否则（当天、且只是解释）      → 复用今天的会话
 */

/** 本地日期键，例如 2026-10-19。 */
export function dayKeyOf(date, timeZoneOffsetMinutes = null) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = timeZoneOffsetMinutes == null
    ? d
    : new Date(d.getTime() + (timeZoneOffsetMinutes - d.getTimezoneOffset()) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${shifted.getFullYear()}-${p(shifted.getMonth() + 1)}-${p(shifted.getDate())}`;
}

/** 空策略。 */
export function emptyPolicy() {
  return { sessionId: null, workspaceId: null, dayKey: null, lastKind: null, createdAt: null, lastAt: null };
}

/**
 * 决定这次该复用还是新建会话。
 * @returns {{action:'reuse'|'create', reason:string, sessionId:string|null}}
 */
export function decideSession({ policy, today, kind = 'explain' } = {}) {
  const p = policy || emptyPolicy();
  if (!p.sessionId) return { action: 'create', reason: 'no-session', sessionId: null };
  if (!p.dayKey || !today || p.dayKey !== today) return { action: 'create', reason: 'day-changed', sessionId: p.sessionId };
  if (p.lastKind === 'write') return { action: 'create', reason: 'after-write', sessionId: p.sessionId };
  return { action: 'reuse', reason: kind === 'write' ? 'same-day-write' : 'same-day-explain', sessionId: p.sessionId };
}

/** 记录一次活动。kind: 'explain' | 'write' */
export function applyEvent(policy, { kind, at, sessionId, workspaceId, today } = {}) {
  const p = Object.assign(emptyPolicy(), policy || {});
  if (sessionId) {
    if (p.sessionId !== sessionId) {
      p.sessionId = sessionId;
      p.createdAt = at || new Date().toISOString();
    }
  }
  if (workspaceId) p.workspaceId = workspaceId;
  if (today) p.dayKey = today;
  p.lastKind = kind === 'write' ? 'write' : 'explain';
  p.lastAt = at || new Date().toISOString();
  return p;
}
