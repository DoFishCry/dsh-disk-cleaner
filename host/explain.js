/**
 * GarbageMaster — 路径解释引擎（"这个目录里是什么"）。
 *
 * 用户定义的两种来源：
 *  1) **系统类路径**：规则命中就够了 —— 直接告诉用户"这是系统目录/不能动"或"这是 temp，可以删"。
 *     零成本、可离线、结论稳定，绝不让模型去猜系统目录。
 *  2) **其余路径**（个人文件、项目、软件数据）：调用 LLM 解释；**模型自评把握**，
 *     把握不足时再联网搜一次再解释。
 *
 * 成本控制（用户明确要求）：
 *  - **逐层惰性**：只解释"当前这一层"，不预先把整棵树都解释掉。
 *  - 默认只自动解释**前两层**（根 + 直接子项），深度可配。
 *  - 每层一次批量调用（N 项一个请求），**按路径缓存**，回看不重复付费。
 *  - 联网搜索有次数预算（每层默认 2 次），只给低把握项用。
 */

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { optSignal, withSignal } from './signal.js';

export const PROMPT_VERSION = 1;

/** 低于这个把握度才考虑联网。 */
export const LOW_CONFIDENCE = 0.6;

// ─────────────────────────────────────── 纯函数（可测试）

/** 相对 root 的层级：root 自己 = 0，它的直接子项 = 1 … */
export function levelOf(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return 0;
  const rel = target.startsWith(root) ? target.slice(root.length) : '';
  return rel.split('/').filter(Boolean).length;
}

/**
 * 是否解释"当前这一层的子项"。
 *
 * 语义修正（用户明确要求）：**站在哪一层就解释那一层的子项**——逐层惰性、进入才解释，
 * 这样既不会一次性解释整棵树（成本可控），也不会出现"到了第三层就没解释了"。
 * `explainDepth` 因此是开关（0=关闭，>0=开启），层级深浅不再卡住当前层。
 */
export function shouldExplainChildren({ root, currentPath, explainDepth }) {
  const depth = Number(explainDepth);
  return Number.isFinite(depth) && depth > 0;
}

/**
 * 文件名启发式：媒体的周边文件（海报/字幕/元数据/压缩包…）形态极其固定，
 * 内置词典直接给答案——零延迟、零成本，也避免模型对这些无聊条目"想半天"。
 * 只覆盖"看一眼文件名就能确定"的类型；目录一律交给规则或模型。
 */
const FILE_HEURISTICS = [
  [/(^|\/)\.plexmatch$/i, 'Plex 媒体库匹配规则文件（纯文本，记录剧集如何匹配）'],
  [/\.nfo$/i, '媒体库元数据文件（Kodi/Plex 读取的影片或剧集信息）'],
  [/\.(srt|ass|ssa|vtt|sub)$/i, '字幕文件'],
  [/\.(jpg|jpeg|png|webp|gif|bmp|tiff?)$/i, '图片文件（多为海报、剧照或缩略图）'],
  [/\.(mkv|mp4|avi|mov|wmv|flv|ts|m2ts|rmvb)$/i, '视频文件'],
  [/\.(mp3|flac|m4a|aac|wav|ape|ogg)$/i, '音频文件'],
  [/\.(zip|7z|rar|tar|tgz|gz|bz2|xz|zst)$/i, '压缩包'],
  [/\.(pyc|pyo)$/i, 'Python 字节码文件（可重新生成）'],
  [/\.(log|log\.\d+|\.log\.gz)$/i, '日志文件'],
  [/(^|\/)Thumbs\.db$/i, 'Windows 缩略图缓存'],
  [/(^|\/)\.DS_Store$/i, 'macOS 目录索引文件'],
  [/(^|\/)desktop\.ini$/i, 'Windows 文件夹显示设置文件'],
  [/\.(tmp|temp|part|partial|crdownload)$/i, '未完成的临时文件'],
  [/\.(bak|old|orig|swp|swo)$/i, '备份或编辑器临时文件'],
  [/\.(iso|img|dmg)$/i, '磁盘镜像文件'],
  [/\.(ttf|otf|woff2?)$/i, '字体文件']
];

/** 返回一句说明；命中不了返回 null（继续走缓存/模型）。 */
export function heuristicExplain(target, { isDir = false } = {}) {
  if (isDir) return null;
  const name = String(target || '').split('/').pop() || '';
  for (const [pattern, text] of FILE_HEURISTICS) {
    if (pattern.test(target)) return `${text}（${name}）`;
  }
  return null;
}

/**
 * 目录取样：单层 readdir（不递归、不跟符号链接），拿最多 N 个孩子的名字/类型/大小。
 * 用来让模型"看着里面的文件"解释，而不是只猜目录名。
 * 只读、失败就放弃这一项，绝不影响解释主流程。
 */
export async function probeDirectory(dirPath, { maxEntries = 12, withSize = true } = {}) {
  let dirents = [];
  try {
    dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const count = dirents.length;
  // 目录优先、名字短优先，取前 N 个（避免一堆哈希名把提示词塞满）
  const picked = dirents
    .slice()
    .sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.length - b.name.length || a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(1, maxEntries));

  const sample = [];
  for (const dirent of picked) {
    const entry = {
      name: dirent.name.slice(0, 60),
      kind: dirent.isDirectory() ? 'dir' : dirent.isSymbolicLink() ? 'link' : 'file',
      size: null
    };
    if (withSize && entry.kind === 'file') {
      try {
        const st = await fsp.stat(path.join(dirPath, dirent.name));
        if (st.isFile()) entry.size = st.size;
      } catch { /* 读不到大小就算了 */ }
    }
    sample.push(entry);
  }
  return { count, sample, truncated: count > picked.length };
}

/**
 * 一次批量解释的提示词。
 * 输出格式故意**不用 JSON**：模型偶尔会返回空文本或带前言，逐行 `路径 | 说明` 更容易服从、
 * 也更容易兜底解析（JSON 仍然作为兼容格式被接受）。
 */
export function buildExplainPrompt({ items = [], maxItems = 40, minimal = false }) {
  const picked = items.slice(0, maxItems);
  if (minimal) {
    return '逐个说明下面这些路径里是什么（每行一条：路径 | 一句中文说明，≤40字，路径原样照抄，不要 JSON、不要多余文字）。'
      + '括号里是该目录内含的文件/子目录，请结合它判断：\n'
      + picked.map((item) => {
        const inner = item.sample && Array.isArray(item.sample.sample) && item.sample.sample.length > 0
          ? `（内含${item.sample.count}项: ${item.sample.sample.map((e) => e.name + (e.kind === 'dir' ? '/' : '')).join(', ')}${item.sample.truncated ? ', …' : ''}）`
          : '';
        return `${item.path}${inner}`;
      }).join('\n');
  }
  const lines = [
    '请说明下面每个路径里大概是什么内容。',
    '',
    '输出要求（必须严格遵守）：',
    '1. **一行一条**，格式固定为：路径 | 一句中文说明（≤40字）',
    '2. 路径必须**原样照抄**输入里的路径，不要改写、不要加引号、不要加序号',
    '3. 不要输出 JSON、不要 Markdown 代码块、不要任何前言或总结',
    '4. 不确定就写"不确定：<你猜的内容>"，不要编造具体软件版本',
    '5. 只说它是什么，不要给删除建议',
    '',
    '如果某条给了"内含"，请**结合里面的文件名/类型**判断这是什么，不要只看目录名。',
    '',
    '输入（路径 | 类型 | 字节 | 父目录 | 内含）：'
  ];
  for (const item of picked) {
    const parts = [item.path, item.isDir ? 'dir' : 'file', item.size == null ? '?' : item.size, path.dirname(item.path)];
    if (item.sample && Array.isArray(item.sample.sample) && item.sample.sample.length > 0) {
      const names = item.sample.sample
        .map((e) => `${e.name}${e.kind === 'dir' ? '/' : e.kind === 'link' ? '@' : ''}${e.size ? `(${e.size})` : ''}`)
        .join(', ');
      parts.push(`内含${item.sample.count}项：${names}${item.sample.truncated ? ', …' : ''}`);
    }
    lines.push(parts.join(' | '));
  }
  lines.push('', '请开始输出（每行一条，不要多余文字）：');
  return lines.join('\n');
}

function extractJsonArray(text) {
  if (typeof text !== 'string') return null;
  let body = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/**
 * 校验模型输出：只接受输入里出现过的路径；文本限长；把握度夹取到 [0,1]。
 */
/** 模型没按 JSON 输出时的兜底：按 "路径<分隔符>说明" 逐行解析。 */
export function salvageLineFormat(text, allowedPaths) {
  const allowed = allowedPaths instanceof Set ? allowedPaths : new Set(allowedPaths || []);
  const out = {};
  for (const line of String(text || '').split('\n')) {
    // 去掉行首序号/项目符号/引号/Markdown 包裹
    const trimmed = line.trim()
      .replace(/^```[a-z]*$/i, '')
      .replace(/^[-*•\d.、)\s]+/, '')
      .replace(/^[`'"]+|[`'"]+$/g, '')
      .trim();
    if (!trimmed.startsWith('/')) continue;
    // 路径里可能有空格（如 "/media/user/Data Disk/动漫"）：先抓"已知路径"前缀，最稳
    let target = null;
    for (const candidate of allowed) {
      if (trimmed === candidate) { target = candidate; break; }
      if (trimmed.startsWith(candidate) && /^[\s:：|,、\-–—]/.test(trimmed.slice(candidate.length))) { target = candidate; break; }
    }
    let rest = '';
    if (target) {
      rest = trimmed.slice(target.length).replace(/^[\s:：|,、\-–—]+/, '');
    } else {
      // 退路：按分隔符切（路径里没空格的老情况）
      const match = /^(\/[^\s:：|,]+)[\s:：|,、-]+(.+)$/.exec(trimmed);
      if (!match) continue;
      target = match[1].replace(/[\s"'`]+$/, '');
      rest = match[2];
    }
    if (!allowed.has(target)) continue;
    const what = String(rest || '').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 160);
    if (what) out[target] = { what, confidence: 0.5 };
  }
  return out;
}

export function parseExplainResult(text, allowedPaths) {
  const allowed = allowedPaths instanceof Set ? allowedPaths : new Set(allowedPaths || []);
  // 先按约定的"逐行 路径 | 说明"解析（模型最容易服从的格式）
  const lineParsed = salvageLineFormat(text, allowed);
  if (Object.keys(lineParsed).length > 0) return { ok: true, items: lineParsed, dropped: [], format: 'lines' };
  const raw = extractJsonArray(text);
  if (!raw) {
    const body = String(text || '').trim();
    return {
      ok: false,
      reason: body ? 'unparseable' : 'empty-output',
      snippet: body.slice(0, 400)
    };
  }
  const out = {};
  const dropped = [];
  for (const entry of raw.slice(0, 200)) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (!allowed.has(entry.path)) { dropped.push(entry.path); continue; }
    const what = typeof entry.what === 'string' ? entry.what.replace(/\s+/g, ' ').slice(0, 160) : '';
    if (!what) continue;
    const confidence = Number.isFinite(Number(entry.confidence)) ? Math.min(1, Math.max(0, Number(entry.confidence))) : 0.5;
    out[entry.path] = { what, confidence };
  }
  return { ok: true, items: out, dropped, format: 'json' };
}

/** 缓存键：路径 + 规则包版本 + 模型 + 提示词版本。 */
export function cacheKey({ path: target, rulePackVersion, model, promptVersion = PROMPT_VERSION }) {
  // 注意：**不把 model 放进键**——换模型不该让已经生成过的解释失效（用户要求"上次有解释就不再生成"）
  void model;
  return createHash('sha1').update(`${target}|${rulePackVersion || 0}|${promptVersion}`).digest('hex');
}

// ─────────────────────────────────────── 带 IO 的执行

/**
 * 从流式块里取**正文**片段。
 * 注意两点（都是踩过的坑）：
 *  1) `reasoning-delta` 是思考过程，不能当正文拼进来；
 *  2) 不同 provider 形状不一，这里兼容常见的几种。
 */
export function pickText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (chunk.type === 'reasoning-delta') return '';
  if (typeof chunk.text === 'string' && chunk.text) return chunk.text;
  // block-end 兜底：整块文本
  if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') return chunk.block.text;
  for (const key of ['delta', 'content', 'output_text']) {
    if (typeof chunk[key] === 'string' && chunk[key]) return chunk[key];
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (choice && choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  return '';
}

/** 把失败响应里的 chunk 类型/原因合并进总账（之前漏了这步，导致诊断永远是空的）。 */
function collectChunks(acc, response) {
  if (!response) return;
  if (response.chunkTypes) for (const [k, n] of Object.entries(response.chunkTypes)) acc[k] = (acc[k] || 0) + n;
  if (response.reason) acc[`reason:${String(response.reason).slice(0, 40)}`] = (acc[`reason:${String(response.reason).slice(0, 40)}`] || 0) + 1;
  if (response.finish && response.finish.kind) acc[`finish:${response.finish.kind}`] = (acc[`finish:${response.finish.kind}`] || 0) + 1;
  if (response.via) acc[`via:${String(response.via).slice(0, 60)}`] = (acc[`via:${String(response.via).slice(0, 60)}`] || 0) + 1;
}

/** 把 seam 的 failure 对象转成一句人能读的原因。 */
export function failureText(failure) {
  if (!failure) return '';
  if (typeof failure === 'string') return failure;
  const parts = [];
  if (failure.message) parts.push(String(failure.message));
  if (failure.code) parts.push(`code=${failure.code}`);
  if (failure.status) parts.push(`status=${failure.status}`);
  if (failure.provider) parts.push(`provider=${failure.provider}`);
  if (parts.length === 0) {
    try { return JSON.stringify(failure).slice(0, 240); } catch { return 'unknown-failure'; }
  }
  return parts.join(' ');
}

/**
 * seam 的契约：adapter 抛错不会抛给调用方，而是被规范化成**终止性的 finish 块**
 * （`{ type:'finish', reason:{ kind:'error'|'aborted'|'max-tokens'|…, failure? } }`）。
 * 忽略它就会把"provider 报错"误判成"模型吐空"——这正是之前一直查不到原因的地方。
 */
export function describeFinish(reason) {
  if (!reason || typeof reason !== 'object') return null;
  if (reason.kind === 'error') return `llm-error: ${failureText(reason.failure) || 'unknown'}`;
  if (reason.kind === 'aborted') return `aborted: ${failureText(reason.failure) || 'unknown'}`;
  if (reason.kind === 'max-tokens') return 'max-tokens';
  return null;
}

/** 组一次请求（prepared 路径与直连路径共用同一份 options）。 */
function buildStreamOptions({ selection, items, minimal, maxTokens, signal, reasoningEffort }) {
  // signal 必须省略或为真正的 AbortSignal：传 null 会被 seam 直接拒绝
  return withSignal({
    provider: selection.provider,
    model: selection.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildExplainPrompt({ items, minimal }) }] }],
    maxTokens,
    purpose: 'garbage-master/explain'
  }, signal, reasoningEffort);
}

/**
 * 取一次流式调用。
 *
 * 优先走 `llm.prepareCall(provider, model)` —— 官方 agent loop / compaction 都是这条路径，
 * 它锁定 adapter 代际与**已解析的模型元数据**（连接事实、调用默认值）。直接 `llm.stream()`
 * 在某些 provider 上会因为动态连接事实未解析而以 `finish:error` 结束（表现出来就是"流里没正文"）。
 * prepared 不可用时回落到直连，并在诊断里记下走了哪条。
 */
/** prepareCall 在个别 provider 上会抛（实测 commandcode：signal?.throwIfAborted is not a function）。
 *  失败一次就记住，后续直接走直连，避免每次调用都白试一遍。 */
let prepareCallBroken = false;

async function openStream({ llm, selection, options, signal }) {
  if (!prepareCallBroken && typeof llm.prepareCall === 'function') {
    try {
      const prepared = await llm.prepareCall(selection.provider, selection.model, optSignal(signal));
      if (prepared && typeof prepared.stream === 'function') {
        return { iterable: prepared.stream(options), via: 'prepared' };
      }
    } catch {
      prepareCallBroken = true; // 不记录具体报错：直连已验证可用，避免诊断里刷噪声
    }
  }
  return { iterable: llm.stream(options), via: 'direct' };
}

async function requestExplain({ llm, selection, items, signal, maxTokens = 1600, strict = false, minimal = false, noReasoning = false, reasoningEffort = undefined }) {
  if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'llm-unavailable' };
  const provider = selection && selection.provider;
  const model = selection && selection.model;
  if (!provider || !model) return { ok: false, reason: 'no-model-selected' };

  const options = buildStreamOptions({ selection: { provider, model }, items, minimal, maxTokens, signal, reasoningEffort });
  options.system = noReasoning
    ? '你是 Linux 文件系统解释助手。不要分析过程、不要推理，直接按要求逐行输出结果。'
    : strict
      ? '你是 Linux 文件系统解释助手。只输出"路径 | 说明"的行，不要任何解释文字、不要代码块。'
      : '你是 Linux 文件系统解释助手。严格按要求逐行输出结果。';

  try {
    let text = '';
    let reasoningChars = 0;
    let finish = null;
    const chunkTypes = {};
    const opened = await openStream({ llm, selection: { provider, model }, options, signal });
    const via = opened.via;
    for await (const chunk of opened.iterable) {
      const kind = (chunk && chunk.type) || (chunk === null ? 'null' : typeof chunk);
      chunkTypes[kind] = (chunkTypes[kind] || 0) + 1;
      // seam 契约：失败不是抛异常，而是终止性的 finish 块（reason.kind = error/aborted/max-tokens）
      if (chunk && chunk.type === 'finish') { finish = chunk.reason || null; continue; }
      if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length;
      const piece = pickText(chunk);
      if (piece) text += piece;
      if (text.length > 200_000) break;
    }
    if (text.trim() === '') {
      const fromFinish = describeFinish(finish);
      const reason = fromFinish
        || (reasoningChars > 0 ? 'reasoning-only' : Object.keys(chunkTypes).length > 0 ? 'no-text-in-stream' : 'empty-stream');
      return { ok: false, reason, chunkTypes, finish: finish || null, reasoningChars, provider, model, via, calledWith: { maxTokens, minimal, strict } };
    }
    return { ok: true, text, chunkTypes, finish: finish || null, reasoningChars, provider, model, via, calledWith: { maxTokens, minimal, strict } };
  } catch (error) {
    return { ok: false, reason: `thrown: ${error && error.message ? error.message : 'llm-error'}`, provider, model };
  }
}

/** 用搜索结果补一次解释（低把握项）。 */
async function searchAndReexplain({ web, llm, selection, items, signal }) {
  if (!web || typeof web.search !== 'function' || items.length === 0) return null;
  // 并行搜索：串行时每一项都要多等一个网络往返（实测两项就多几秒）
  const searched = await Promise.all(items.map(async (item) => {
    try {
      const result = await web.search({ query: `${path.basename(item.path)} 目录 是什么 Linux`, maxResults: 3 }, optSignal(signal));
      const text = [
        result && result.content ? result.content : '',
        ...((result && result.sources) || []).slice(0, 3).map((s) => `${s.title || s.url} ${s.snippet || ''}`)
      ].filter(Boolean).join('\n').slice(0, 1200);
      return text ? { path: item.path, text } : null;
    } catch { return null; }
  }));
  const snippets = searched.filter(Boolean);
  if (snippets.length === 0) return null;
  // 把搜索结果交给模型，让它基于证据再写一遍
  if (!llm || !selection || !selection.provider || !selection.model) return null;
  try {
    const prompt = snippets.map((s) => `${s.path}\n参考资料：${s.text}`).join('\n\n')
      + '\n\n请逐行输出：路径 | 一句中文说明（≤40字，路径原样照抄，不要 JSON、不要多余文字）';
    let text = '';
    for await (const chunk of llm.stream(withSignal({
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: undefined,
      system: '你是 Linux 文件系统解释助手。只基于给出的参考资料回答，逐行输出"路径 | 说明"。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 900
    }, signal))) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    }
    const parsed = parseExplainResult(text, new Set(snippets.map((s) => s.path)));
    return parsed.ok ? parsed.items : null;
  } catch { return null; }
}

/**
 * 解释一层（当前路径 + 若干子项）。
 * @param {object} params
 * @param {object} params.store 状态存储（只用于发事件）
 * @param {Array} params.entries [{path, isDir, size}]
 * @param {Function} params.annotate 规则判定
 * @param {Array} params.rules 已编译规则
 * @param {number} params.rulePackVersion
 * @param {object} params.cache 解释缓存（Map 或普通对象）
 * @param {Function} params.saveCache 持久化回调
 * @param {object} params.llm
 * @param {object} params.selection 宿主当前模型选择
 * @param {object} params.web
 * @param {object} params.config
 */
export async function explainEntries({
  entries = [], annotate, rules, rulePackVersion = 0, cache, saveCache, llm, selection, web, config = {}, signal: rawSignal, force = false, probe = probeDirectory, onBatch = null, reasoningEffort = undefined
}) {
  const signal = optSignal(rawSignal); // null/非法值统一丢掉
  const results = {};
  const maxItems = Math.max(1, Number(config.explainMaxItems) || 40);
  const maxSearches = Math.max(0, Number(config.explainMaxSearches) || 2);
  const useWeb = config.explainUseWeb !== false;
  const model = (selection && selection.model) || '';
  const pending = [];

  for (const entry of entries.slice(0, maxItems)) {
    if (!entry || typeof entry.path !== 'string') continue;
    const verdict = annotate ? annotate(entry.path, rules) : { ruleId: null, note: '' };
    if (verdict && verdict.ruleId !== null && verdict.ruleId !== undefined && verdict.note) {
      results[entry.path] = { text: verdict.note, source: 'rule', confidence: 1 };
      continue;
    }
    // 看一眼文件名就能确定的，直接给答案，不进模型
    const guess = heuristicExplain(entry.path, { isDir: entry.isDir });
    if (guess && !force) {
      results[entry.path] = { text: guess, source: 'heuristic', confidence: 0.9 };
      continue;
    }
    const key = cacheKey({ path: entry.path, rulePackVersion, model });
    const hit = !force && cache && (cache instanceof Map ? cache.get(key) : cache[key]);
    if (hit && typeof hit.text === 'string') {
      results[entry.path] = { text: hit.text, source: 'cache', confidence: hit.confidence || 0.7 };
      continue;
    }
    pending.push({ path: entry.path, isDir: entry.isDir !== false, size: entry.size });
  }

  if (pending.length === 0) return { results, used: { llm: 0, web: 0 } };

  // 一次问太多条容易让模型"想爆预算"后吐空：分批（默认 12 条/批），坏一批不影响其他批
  // 解释前先"看一眼里面有什么"：单层取样，让模型结合文件判断（不递归、不跟符号链接）
  const sampleEntries = Math.max(0, Math.min(40, config.explainSampleEntries == null ? 12 : Number(config.explainSampleEntries)));
  if (sampleEntries > 0 && typeof probe === 'function') {
    for (const item of pending) {
      if (!item.isDir) continue;
      const probed = await probe(item.path, { maxEntries: sampleEntries });
      if (probed) item.sample = probed;
    }
  }

  const batchSize = Math.max(1, Math.min(40, Number(config.explainBatchSize) || 12));
  const batches = [];
  for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));

  const chunkTypes = {};
  const errors = [];
  let llmUsed = 0;
  let llmSucceeded = 0;
  let lastSnippet = '';
  const concurrency = Math.max(1, Math.min(6, Number(config.explainConcurrency) || 3));
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, batches.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= batches.length) return;
      const batch = batches[index];
    const allowedBatch = new Set(batch.map((p) => p.path));
    let response = await requestExplain({ llm, selection, items: batch, signal, maxTokens: 1600, reasoningEffort });
    llmUsed += 1;
    collectChunks(chunkTypes, response);
    // 没吐正文（预算耗尽 / 只有推理 / 空流）：换极简提示词 + 更大预算重试
    const retryable = !response.ok && /^(max-tokens|reasoning-only|no-text-in-stream|empty-stream)$/.test(response.reason || '');
    if (retryable) {
      response = await requestExplain({ llm, selection, items: batch, signal, maxTokens: 4000, strict: true, minimal: true, reasoningEffort });
      llmUsed += 1;
      collectChunks(chunkTypes, response);
      if (!response.ok && response.reason === 'reasoning-only') {
        // 模型就是想讲过程：明确要求"只给结论，不要推理"
        response = await requestExplain({ llm, selection, items: batch, signal, maxTokens: 4000, strict: true, minimal: true, noReasoning: true, reasoningEffort });
        llmUsed += 1;
        collectChunks(chunkTypes, response);
      }
    }
    if (!response.ok) { errors.push(response.reason); lastSnippet = response.snippet || lastSnippet; continue; }
    let parsed = parseExplainResult(response.text, allowedBatch);
    if (!parsed.ok) {
      const retry = await requestExplain({ llm, selection, items: batch, signal, maxTokens: 2000, strict: true, reasoningEffort });
      llmUsed += 1;
      if (retry.ok) {
        collectChunks(chunkTypes, retry);
        parsed = parseExplainResult(retry.text, allowedBatch);
      } else {
        collectChunks(chunkTypes, retry);
      }
    }
    if (!parsed.ok) { errors.push(parsed.reason); lastSnippet = parsed.snippet || lastSnippet; continue; }
    llmSucceeded += 1;
    const batchResults = {};
    for (const [target, item] of Object.entries(parsed.items)) {
      results[target] = { text: item.what, source: 'llm', confidence: item.confidence };
      batchResults[target] = results[target];
    }
    // 每批完成就回调一次：前端能把解释"逐批"显示出来，而不是整层等完
    if (typeof onBatch === 'function' && Object.keys(batchResults).length > 0) {
      try { onBatch(batchResults); } catch { /* 回调失败不影响主流程 */ }
    }
  }
  });
  await Promise.all(workers);
  // 一批都没成功才算整层失败（有成功批次时不要用错误提示盖住已经拿到的解释）
  if (llmSucceeded === 0 && errors.length > 0) {
    return { results, error: errors[0], snippet: lastSnippet, chunkTypes, used: { llm: llmUsed, web: 0 } };
  }

  // 低把握 + 允许联网 + 还有预算 → 搜一次再解释
  const low = pending.filter((p) => {
    const got = results[p.path];
    return !got || got.confidence < LOW_CONFIDENCE;
  });
  let searches = 0;
  if (useWeb && searches < maxSearches && low.length > 0) {
    const slice = low.slice(0, Math.min(maxSearches, low.length));
    const better = await searchAndReexplain({ web, llm, selection, items: slice, signal });
    if (better) {
      searches = slice.length;
      for (const [target, item] of Object.entries(better)) {
        const current = results[target];
        // 实测踩到过：联网重写会把原本更具体的解释改笼统；只有更确定时才覆盖
        const prev = current ? current.confidence || 0 : -1;
        if (item.confidence > prev + 0.05) {
          results[target] = { text: item.what, source: 'web', confidence: item.confidence };
        }
      }
    }
  }

  // 写缓存（只缓存有结论的）
  if (cache) {
    for (const [target, value] of Object.entries(results)) {
      if (value.source === 'rule') continue;
      const key = cacheKey({ path: target, rulePackVersion, model });
      const record = { text: value.text, confidence: value.confidence, source: value.source, at: Date.now() };
      if (cache instanceof Map) cache.set(key, record); else cache[key] = record;
    }
    if (typeof saveCache === 'function') saveCache();
  }
  return { results, used: { llm: llmUsed, web: searches }, chunkTypes, partialErrors: errors.length ? errors : null };
}
