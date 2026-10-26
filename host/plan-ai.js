/**
 * GarbageMaster — AI 计划环节。
 *
 * 职责边界（与设计文档一致）：
 *  - **模型不决定"删什么"**。允许删的集合永远来自用户在界面上的勾选 + 规则判定。
 *  - 模型只做三件事：**解释**（为什么这条该这么处理）、**建议**（是不是应该卸载而不是删目录、
 *    是不是重复文件该保留哪一份）、**排序/告警**。
 *  - 因此 `parseAiPlan()` 会把模型返回里**任何不在选择清单内的路径直接丢弃**并记录，
 *    建议（suggestion）只作为提示展示，不会自动改变用户选定的操作模式。
 *
 * 调用的是宿主已有的模型配置（ctx.agentDefaultModel 的选择），插件不新建凭据。
 */

const ALLOWED_SUGGESTIONS = new Set(['clean', 'pack', 'tidy', 'uninstall', 'keep']);

export const AI_SYSTEM_PROMPT = [
  '你是 Linux 磁盘清理助手。你的任务是对用户已勾选的条目做解释与建议，不决定删除范围。',
  '严格只输出一个 JSON 对象，不要输出 Markdown 代码块或任何多余文字。',
  'JSON 结构：',
  '{"summary":"一句话总体判断（≤120字）",',
  ' "items":[{"path":"输入里出现过的路径","reason":"为什么这样处理（≤50字）","suggestion":"clean|pack|tidy|uninstall|keep"}],',
  ' "order":["按执行先后排列的路径"],',
  ' "warnings":["需要用户注意的点，例如需要重启、可能影响正在运行的服务（≤3条）"]}',
  '规则：',
  '1) 只能使用输入中出现的 path，绝对不能新增路径；',
  '2) 不要承诺删除任何未列入清单的内容；',
  '3) 对"应用/运行时/代码仓库"类目录，建议 uninstall 而不是直接删；',
  '4) 会要求重启/重新登录的处置，必须写进 warnings；',
  '5) reason 用中文，简洁具体。'
].join('\n');

/** 拼一个紧凑的用户提示：每条一行，避免把巨大的规则说明整段塞进去。 */
export function buildAiPrompt({ target, items = [], totals = null, maxItems = 80 }) {
  const sorted = items.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  const picked = sorted.slice(0, maxItems);
  const omitted = sorted.length - picked.length;
  const lines = [];
  lines.push(`目标分区：${target && target.path ? target.path : '/'}`);
  if (totals) lines.push(`本次共 ${totals.count || 0} 项，合计 ${totals.bytes || 0} 字节`);
  if (omitted > 0) lines.push(`（另有 ${omitted} 个较小的条目未列出，不必提及）`);
  lines.push('条目（路径 | 字节 | 风险档 | 用户选择的模式 | 规则说明 | 用户特殊要求）：');
  for (const item of picked) {
    const note = String(item.note || '').replace(/\s+/g, ' ').slice(0, 70);
    const special = String(item.special || '').replace(/\s+/g, ' ').slice(0, 50);
    lines.push(`${item.path} | ${Number(item.size) || 0} | ${item.risk || 'caution'} | ${item.mode || 'clean'} | ${note || '-'} | ${special || '-'}`);
  }
  return lines.join('\n');
}

/** 从可能带代码围栏的文本里抠出 JSON。 */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let body = text.trim();
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = body.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

/**
 * 校验并收敛模型输出。
 * @param {string} text 模型返回的原文
 * @param {Set<string>|string[]} allowedPaths 只允许这些路径出现
 * @returns {{ok:boolean, reason?:string, summary?:string, notes?:Record<string,{reason:string,suggestion:string|null}>, order?:string[], warnings?:string[], dropped?:string[]}}
 */
export function parseAiPlan(text, allowedPaths) {
  const allowed = allowedPaths instanceof Set ? allowedPaths : new Set(allowedPaths || []);
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-json' };

  const dropped = [];
  const notes = {};
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items.slice(0, 200)) {
      if (!entry || typeof entry.path !== 'string') continue;
      if (!allowed.has(entry.path)) { dropped.push(entry.path); continue; }
      const suggestion = typeof entry.suggestion === 'string' && ALLOWED_SUGGESTIONS.has(entry.suggestion.trim()) ? entry.suggestion.trim() : null;
      notes[entry.path] = {
        reason: typeof entry.reason === 'string' ? entry.reason.replace(/\s+/g, ' ').slice(0, 200) : '',
        suggestion
      };
    }
  }

  const order = [];
  if (Array.isArray(raw.order)) {
    for (const p of raw.order) if (typeof p === 'string' && allowed.has(p) && !order.includes(p)) order.push(p);
  }

  const warnings = [];
  if (Array.isArray(raw.warnings)) {
    for (const w of raw.warnings.slice(0, 5)) {
      if (typeof w === 'string' && w.trim()) warnings.push(w.replace(/\s+/g, ' ').slice(0, 200));
    }
  }

  const summary = typeof raw.summary === 'string' ? raw.summary.replace(/\s+/g, ' ').slice(0, 300) : '';

  return { ok: true, summary, notes, order, warnings, dropped };
}

/**
 * 请求一次 AI 计划。
 * @param {object} params
 * @param {object} params.llm 宿主的 ctx.llm
 * @param {{provider?:string,model?:string}} params.selection 宿主当前模型选择
 */
export async function requestAiPlan({ llm, selection, target, items, totals, signal: rawSignal, timeoutMs = 30000, maxTokens = 1400 }) {
  const signal = optSignal(rawSignal);
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'llm-unavailable' };
  const provider = selection && selection.provider;
  const model = selection && selection.model;
  if (!provider || !model) return { ok: false, reason: 'no-model-selected' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const userPrompt = buildAiPrompt({ target, items, totals });
    let text = '';
    const stream = llm.stream({
      provider,
      model,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
      maxTokens,
      signal: controller.signal
    });
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      if (text.length > 200_000) break;
    }
    return { ok: true, text, provider, model };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : 'llm-error' };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 把 AI 的解释/建议/顺序挂到**服务端已确定**的计划上。
 * 注意：不改 groups 的模式归属、不改任何体积、不允许新增或删除条目。
 */
export function applyAiPlan(plan, ai) {
  if (!plan || !ai || ai.ok !== true) return plan;
  const notes = ai.notes || {};
  const order = ai.order || [];
  const rank = new Map(order.map((p, i) => [p, i]));

  for (const item of plan.items) {
    const note = notes[item.path];
    if (note) {
      item.aiReason = note.reason || '';
      item.aiSuggestion = note.suggestion || null;
    }
  }
  for (const group of plan.groups) {
    group.items = group.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const ra = rank.has(a.item.path) ? rank.get(a.item.path) : 1e9;
        const rb = rank.has(b.item.path) ? rank.get(b.item.path) : 1e9;
        return ra - rb || a.index - b.index;
      })
      .map((x) => x.item);
  }
  plan.ai = {
    used: true,
    summary: ai.summary || '',
    warnings: ai.warnings || [],
    dropped: ai.dropped || [],
    provider: ai.provider || null,
    model: ai.model || null
  };
  return plan;
}
