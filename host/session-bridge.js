/**
 * GarbageMaster — 与 DSH 会话交互的桥。
 *
 * 职责（都用宿主现成 Service，不自己造）：
 *  - 工作区：`workspaceRegistry.list()/resolveByPath()/get()`
 *  - 会话：`sessionController.create()/prompt()/inspect()/page()/cancel()`、`sessions.get()`
 *  - 计划模式：`planMode.get(agent)/set(agent,active)`
 *  - 权限：`permissionPresets.catalog()/set(session,name)`（PresetSpec = {sandbox, approval}）
 *  - 可见通知：`createUserMessage({source:{kind,form:'notice',summary}})` + `session.append('user/message', …)`
 *  - 原始记录：`session.append('plugin:garbage-master/…', …)`
 *
 * 所有调用都做能力探测 + try/catch：缺能力时返回 {ok:false, reason}，绝不把插件整体拖崩。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NOTICE_KIND = 'garbage-master';

function safeGet(ctx, name) {
  try { return ctx.get(name) || null; } catch { return null; }
}

export function createSessionBridge({ ctx, stateDir, logger = null }) {
  const policyFile = path.join(stateDir, 'session-policy.json');
  const recordDir = path.join(stateDir, 'explain-records');
  let policy = null;

  const warn = (message) => { if (logger && typeof logger.warn === 'function') logger.warn(`garbage-master/session: ${message}`); };

  function services() {
    return {
      workspaces: safeGet(ctx, 'workspaceRegistry'),
      sessions: safeGet(ctx, 'sessions'),
      sessionController: safeGet(ctx, 'sessionController'),
      planMode: safeGet(ctx, 'planMode'),
      permissions: safeGet(ctx, 'permissionPresets'),
      agents: safeGet(ctx, 'agents')
    };
  }

  function capabilities() {
    const s = services();
    return {
      workspaces: Boolean(s.workspaces && typeof s.workspaces.list === 'function'),
      sessionController: Boolean(s.sessionController && typeof s.sessionController.create === 'function'),
      prompt: Boolean(s.sessionController && typeof s.sessionController.prompt === 'function'),
      planMode: Boolean(s.planMode && typeof s.planMode.set === 'function'),
      permissions: Boolean(s.permissions && typeof s.permissions.catalog === 'function'),
      sessions: Boolean(s.sessions && typeof s.sessions.get === 'function')
    };
  }

  // ── 工作区 ──────────────────────────────────────────────
  async function listWorkspaces() {
    const s = services();
    if (!s.workspaces || typeof s.workspaces.list !== 'function') return { ok: false, reason: 'no-workspace-service', workspaces: [] };
    try {
      const list = await s.workspaces.list();
      return {
        ok: true,
        workspaces: (list || []).map((w) => ({ id: String(w.id), path: String(w.path || ''), title: String(w.title || w.path || '') }))
      };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'list-failed', workspaces: [] };
    }
  }

  /** 解析绑定工作区：优先 id → 路径 → 第一个。 */
  async function resolveWorkspace({ workspaceId = null, workspacePath = null } = {}) {
    const listed = await listWorkspaces();
    if (!listed.ok) return { ok: false, reason: listed.reason };
    const all = listed.workspaces;
    if (workspaceId) {
      const hit = all.find((w) => w.id === workspaceId);
      if (hit) return { ok: true, workspace: hit };
    }
    if (workspacePath) {
      const hit = all.find((w) => w.path === workspacePath);
      if (hit) return { ok: true, workspace: hit };
      const s = services();
      if (s.workspaces && typeof s.workspaces.resolveByPath === 'function') {
        try {
          const w = await s.workspaces.resolveByPath(workspacePath);
          if (w) return { ok: true, workspace: { id: String(w.id), path: String(w.path || ''), title: String(w.title || w.path || '') } };
        } catch { /* 落到下一个分支 */ }
      }
    }
    if (all.length > 0) return { ok: true, workspace: all[0], fallback: true };
    return { ok: false, reason: 'no-workspace' };
  }

  // ── 会话策略 ────────────────────────────────────────────
  async function loadPolicy() {
    if (policy) return policy;
    try { policy = JSON.parse(await fsp.readFile(policyFile, 'utf8')) || null; } catch { policy = null; }
    return policy;
  }

  async function savePolicy(next) {
    policy = next;
    try {
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(policyFile, JSON.stringify(next, null, 2), 'utf8');
    } catch (error) { warn(`savePolicy failed: ${error && error.message}`); }
    return next;
  }

  // ── 会话创建/复用 ───────────────────────────────────────
  async function createSession({ workspace, title } = {}) {
    const s = services();
    if (!s.sessionController || typeof s.sessionController.create !== 'function') return { ok: false, reason: 'no-session-controller' };
    try {
      const request = {};
      if (workspace && workspace.id) request.workspaceId = workspace.id;
      if (workspace && workspace.path) request.cwd = workspace.path;
      const created = await s.sessionController.create(request);
      const sessionId = created && created.sessionId ? String(created.sessionId) : null;
      if (!sessionId) return { ok: false, reason: 'no-session-id-returned' };
      if (title && typeof s.sessionController.rename === 'function') {
        try { await s.sessionController.rename({ sessionId, title }); } catch { /* 命名失败不影响 */ }
      }
      return { ok: true, sessionId };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'create-failed' };
    }
  }

  async function sessionAlive(sessionId) {
    const s = services();
    if (!sessionId) return false;
    if (s.sessions && typeof s.sessions.get === 'function') {
      try { if (s.sessions.get(sessionId)) return true; } catch { /* 继续探测 */ }
    }
    if (s.sessionController && typeof s.sessionController.inspect === 'function') {
      try { await s.sessionController.inspect(sessionId); return true; } catch { return false; }
    }
    return false;
  }

  /**
   * 按策略取会话：复用今天的 / 新建。
   * @param {{kind:'explain'|'write', workspace:object, today:string}} args
   */
  async function ensureSession({ kind = 'explain', workspace = null, today, title } = {}) {
    const current = await loadPolicy();
    const { decideSession } = await import('./session-policy.js');
    const decision = decideSession({ policy: current, today, kind });
    if (decision.action === 'reuse') {
      if (await sessionAlive(decision.sessionId)) return { ok: true, sessionId: decision.sessionId, action: 'reuse', reason: decision.reason };
      warn(`复用失败（会话不存在）：${decision.sessionId}，改为新建`);
      decision.action = 'create';
      decision.reason = 'stale-session';
    }
    const created = await createSession({ workspace, title });
    if (!created.ok) return created;
    return { ok: true, sessionId: created.sessionId, action: 'create', reason: decision.reason };
  }

  /** 记录一次活动（explain / write），并落盘策略。 */
  async function noteActivity({ kind, sessionId, workspaceId, today, at } = {}) {
    const { applyEvent } = await import('./session-policy.js');
    const next = applyEvent(await loadPolicy(), { kind, sessionId, workspaceId, today, at });
    await savePolicy(next);
    return next;
  }

  // ── 会话读写 ────────────────────────────────────────────
  async function prompt(sessionId, text) {
    const s = services();
    if (!s.sessionController || typeof s.sessionController.prompt !== 'function') return { ok: false, reason: 'no-prompt-api' };
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty-prompt' };
    try {
      // 注意：宿主 seam 的 signal 只接受真正的 AbortSignal 或省略
      await s.sessionController.prompt({
        requestId: `gm-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }]
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'prompt-failed' };
    }
  }

  /** 往会话写一条"可见通知"（不发起 LLM 回合）。 */
  async function appendNotice(sessionId, { summary, text, raw = null, recordType = 'plugin:garbage-master/explain' } = {}) {
    const s = services();
    if (!s.sessions || typeof s.sessions.get !== 'function') return { ok: false, reason: 'no-session-store' };
    let session = null;
    try { session = s.sessions.get(sessionId); } catch { session = null; }
    if (!session || typeof session.append !== 'function') return { ok: false, reason: 'session-not-found' };
    const body = String(text || summary || '').slice(0, 8000);
    let noticeError = null;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      const createUserMessage = mod && mod.createUserMessage;
      if (typeof createUserMessage === 'function') {
        const message = createUserMessage({
          content: [{ type: 'text', text: body }],
          source: { kind: NOTICE_KIND, form: 'notice', summary: String(summary || '').slice(0, 200) }
        });
        session.append('user/message', message, { surfaceOp: 'append' });
      } else {
        noticeError = 'createUserMessage-not-exported';
      }
    } catch (error) {
      noticeError = error && error.message ? error.message : 'notice-failed';
    }
    // 原始记录：log-only（不进模型上下文），便于事后查看完整问答
    try {
      session.append(recordType, { at: new Date().toISOString(), summary: String(summary || ''), raw: raw || body });
    } catch (error) {
      if (!noticeError) noticeError = error && error.message ? error.message : 'record-failed';
    }
    return noticeError ? { ok: false, reason: noticeError } : { ok: true };
  }

  /** 把完整解释记录另存一份 JSON（不依赖会话能力，永远可用）。 */
  async function writeExplainRecord({ planKey, entries, used, target }) {
    try {
      await fsp.mkdir(recordDir, { recursive: true });
      const file = path.join(recordDir, `${planKey || new Date().toISOString().slice(0, 10)}.jsonl`);
      const line = JSON.stringify({ at: new Date().toISOString(), target: target || null, used: used || null, entries }) + '\n';
      await fsp.appendFile(file, line, 'utf8');
      return { ok: true, file };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'record-write-failed' };
    }
  }

  // ── 计划模式 / 权限 ─────────────────────────────────────
  async function resolveAgent(sessionId) {
    const s = services();
    if (s.sessionController && typeof s.sessionController.resolveAgent === 'function') {
      try {
        const out = await s.sessionController.resolveAgent(sessionId);
        if (out && out.agent) return out.agent;
        if (out && typeof out === 'object' && typeof out.sessionId === 'string' && out.agent) return out.agent;
      } catch { /* 落到 agents.get */ }
    }
    if (s.agents && typeof s.agents.get === 'function') {
      try { return s.agents.get(sessionId) || null; } catch { return null; }
    }
    return null;
  }

  async function setPlanMode(sessionId, active) {
    const s = services();
    if (!s.planMode || typeof s.planMode.set !== 'function') return { ok: false, reason: 'no-plan-mode' };
    const agent = await resolveAgent(sessionId);
    if (!agent) return { ok: false, reason: 'agent-not-found' };
    try {
      const result = s.planMode.set(agent, Boolean(active));
      let state = null;
      try { state = s.planMode.get(agent); } catch { state = null; }
      return { ok: result !== 'cancelled', result, state };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'plan-mode-failed' };
    }
  }

  function listPermissions() {
    const s = services();
    if (!s.permissions || typeof s.permissions.catalog !== 'function') return { ok: false, reason: 'no-permission-service', options: [], defaultPreset: null };
    try {
      const catalog = s.permissions.catalog();
      return {
        ok: true,
        options: (catalog && catalog.options ? catalog.options : []).map((o) => ({ value: String(o.value), name: String(o.name || o.value), description: o.description || '' })),
        defaultPreset: catalog && catalog.defaultPreset ? String(catalog.defaultPreset) : null
      };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'catalog-failed', options: [], defaultPreset: null };
    }
  }

  async function setPermission(sessionId, presetName) {
    const s = services();
    if (!presetName) return { ok: false, reason: 'no-preset' };
    if (!s.permissions || typeof s.permissions.set !== 'function' || !s.sessions || typeof s.sessions.get !== 'function') {
      return { ok: false, reason: 'no-permission-service' };
    }
    let session = null;
    try { session = s.sessions.get(sessionId); } catch { session = null; }
    if (!session) return { ok: false, reason: 'session-not-found' };
    try {
      s.permissions.set(session, presetName);
      let spec = null;
      try { spec = s.permissions.resolve(presetName); } catch { spec = null; }
      return { ok: true, preset: presetName, spec };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'set-permission-failed' };
    }
  }

  /** 模型列表（设置里选"解释/计划用哪个模型"）。 */
  async function listModels() {
    const s = services();
    if (!s.sessionController || typeof s.sessionController.modelCatalog !== 'function') return { ok: false, reason: 'no-model-catalog', providers: [] };
    try {
      const catalog = await s.sessionController.modelCatalog();
      const providers = (catalog && catalog.providers ? catalog.providers : []).map((p) => ({
        id: String(p.id),
        name: String(p.name || p.id),
        models: (p.models || []).map((m) => ({ id: String(m.id), name: String(m.name || m.id), reasoning: m.reasoning || null }))
      }));
      return { ok: true, providers, failures: catalog && catalog.failures ? catalog.failures : [] };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'catalog-failed', providers: [] };
    }
  }

  /** 等会话跑完：优先 inspect 轮询，退化到固定静默期。 */
  async function waitForIdle(sessionId, { timeoutMs = 180000, pollMs = 700, quietMs = 2500 } = {}) {
    const s = services();
    const started = Date.now();
    const inspect = s.sessionController && typeof s.sessionController.inspect === 'function' ? s.sessionController.inspect.bind(s.sessionController) : null;
    let lastChange = Date.now();
    let lastSignature = null;
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (inspect) {
        try {
          const info = await inspect(sessionId);
          const busy = Boolean(info && (info.running || info.busy || (info.status && info.status === 'running')));
          const signature = info ? JSON.stringify(info.status || info.running || null) + ':' + String(info.lastSeq || info.seq || '') : null;
          if (signature !== lastSignature) { lastSignature = signature; lastChange = Date.now(); }
          if (!busy && Date.now() - lastChange >= quietMs) return { ok: true, idle: true, waitedMs: Date.now() - started };
        } catch { /* inspect 不可用就退化 */ }
      } else if (Date.now() - started > quietMs) {
        return { ok: true, idle: true, degraded: true, waitedMs: Date.now() - started };
      }
    }
    return { ok: false, reason: 'timeout', waitedMs: Date.now() - started };
  }

  /** 读会话最近一条 assistant 文本（计划正文）。 */
  async function readLastAssistantText(sessionId, { limit = 40 } = {}) {
    const s = services();
    if (!s.sessionController || typeof s.sessionController.page !== 'function') return { ok: false, reason: 'no-page-api' };
    try {
      const page = await s.sessionController.page({ sessionId, limit });
      const records = (page && (page.records || page.messages || page.entries)) || [];
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const rec = records[i];
        const type = rec && (rec.type || (rec.data && rec.data.type));
        if (type !== 'assistant/message') continue;
        const data = rec.data && rec.data.message ? rec.data.message : rec.message || rec.data;
        const content = (data && data.content) || [];
        const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) return { ok: true, text };
      }
      return { ok: false, reason: 'no-assistant-text' };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'page-failed' };
    }
  }

  return {
    capabilities,
    listWorkspaces,
    resolveWorkspace,
    ensureSession,
    noteActivity,
    loadPolicy,
    savePolicy,
    prompt,
    appendNotice,
    writeExplainRecord,
    setPlanMode,
    listPermissions,
    setPermission,
    listModels,
    waitForIdle,
    readLastAssistantText,
    resolveAgent
  };
}
