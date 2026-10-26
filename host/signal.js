/**
 * GarbageMaster — 传给宿主服务的 signal 规范化。
 *
 * 踩过的坑：宿主 seam 对 `signal` **严格校验**——要么是真正的 AbortSignal，要么**整个省略**。
 * 传 `signal: null` 会直接抛：
 *   `llm-error: signals[0] is not of type AbortSignal. code=UNKNOWN`
 * 而假 LLM 在做单测时会忽略 signal，所以这类错误在单测里根本暴露不出来（真实踩过一次）。
 *
 * 因此：所有跨 seam 的调用都经过这里——非法值一律**删掉这个键**，而不是传 null/undefined。
 */

/** 只接受"看起来就是 AbortSignal"的对象（duck-typing，避免跨 realm instanceof 失效）。 */
export function optSignal(signal) {
  if (!signal || typeof signal !== 'object') return undefined;
  if (typeof signal.aborted !== 'boolean') return undefined;
  if (typeof signal.addEventListener !== 'function') return undefined;
  return signal;
}

/**
 * 合法时补上 `signal` / `reasoningEffort` 键；非法/空值**不出现该键**。
 * `reasoningEffort` 是宿主 seam 的"思考强度"（adapter 自有取值），空字符串视为"继承默认"。
 */
export function withSignal(options, signal, reasoningEffort) {
  const next = Object.assign({}, options);
  const valid = optSignal(signal);
  if (valid) next.signal = valid;
  if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) next.reasoningEffort = reasoningEffort;
  return next;
}
