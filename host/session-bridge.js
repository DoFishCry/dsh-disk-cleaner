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
      // 宿主明确要求：workspaceId 与 cwd 二选一（都传会直接报错）
      const request = {};
      if (workspace && workspace.id) request.workspaceId = workspace.id;
      else if (workspace && workspace.path) request.cwd = workspace.path;
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

  /**
   * 会话是否"可继续"：必须是**本进程内有 agent** 的会话。
   * 只查 sessions.get / inspect 会把上一个进程遗留的持久化会话误判为可用 ——
   * 结果就是 prompt 发进一个没人驱动的会话：不报错、也不产出（真机踩过，等了 4 分钟）。
   */
  async function sessionAlive(sessionId) {
    if (!sessionId) return false;
    return Boolean(await resolveAgent(sessionId));
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
  /**
   * 把一段文本送进会话。
   * 1) 先走官方 RPC `sessionController.prompt`；
   * 2) 失败（跨进程/信任门禁等原因）时，直接驱动**本进程内的 agent**：`agent.followup(...)`。
   *   真机踩过：RPC 静默失败，会话里既没有 user message 也没有报错。
   */
  async function prompt(sessionId, text) {
    const s = services();
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty-prompt' };
    let rpcError = null;
    if (s.sessionController && typeof s.sessionController.prompt === 'function') {
      try {
        // prompt(request, signal)：宿主内部第一行就 signal.throwIfAborted()，不传会直接抛
        const out = await s.sessionController.prompt({
          requestId: `gm-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }]
        }, new AbortController().signal);
        if (out && out.accepted) return { ok: true, via: 'rpc' };
        rpcError = 'not-accepted';
      } catch (error) {
        rpcError = error && error.message ? error.message : 'rpc-failed';
      }
    }
    const agent = await resolveAgent(sessionId);
    if (!agent) return { ok: false, reason: `no-agent:${rpcError || 'unknown'}` };
    if (typeof agent.followup !== 'function') return { ok: false, reason: `no-followup:${rpcError || 'unknown'}` };
    try {
      // 插件包内无法 import '@deepseek-ai/dsh-llm'（裸标识符解析不到），直接按消息形状构造
      const message = {
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' }
      };
      agent.followup(message);
      return { ok: true, via: 'agent-followup', rpcError };
    } catch (error) {
      return { ok: false, reason: `followup-failed:${error && error.message ? error.message : 'unknown'}; rpc=${rpcError || 'unknown'}` };
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
      const message = {
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: NOTICE_KIND, form: 'notice', summary: String(summary || '').slice(0, 200) }
      };
      session.append('user/message', message, { surfaceOp: 'append' });
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

  /** 查某档权限预设实际会写入的 sandbox/approval（用于展示与核对）。 */
  function resolvePreset(presetName) {
    const s = services();
    if (!presetName || !s.permissions || typeof s.permissions.resolve !== 'function') return null;
    try {
      const spec = s.permissions.resolve(presetName);
      return spec ? { sandbox: spec.sandbox, approval: spec.approval, name: spec.name || presetName } : null;
    } catch { return null; }
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

  /**
   * 等"计划真的产出"：文件出现 → 直接成功；否则轮询会话状态，
   * 看到过 running 之后转 idle 再去读最后一条 assistant 文本。
   * （早先只等 idle：prompt 刚入队时 agent 还没启动，会被误判成"已空闲"。）
   */
  async function waitForPlan({ sessionId, planPath, timeoutMs = 240000, pollMs = 800, minChars = 40 } = {}) {
    const started = Date.now();
    let sawRunning = false;
    let lastLen = -1;
    let stableIdle = 0;
    const inspect = (() => {
      const s = services();
      return s.sessionController && typeof s.sessionController.inspect === 'function'
        ? s.sessionController.inspect.bind(s.sessionController) : null;
    })();

    while (Date.now() - started < timeoutMs) {
      if (planPath) {
        try {
          const text = await fsp.readFile(planPath, 'utf8');
          if (text.trim().length >= minChars) return { ok: true, via: 'file', waitedMs: Date.now() - started };
        } catch { /* 还没写 */ }
      }
      let busy = false;
      if (inspect) {
        try {
          const info = await inspect(sessionId);
          busy = Boolean(info && (info.running || info.busy || info.status === 'running'));
        } catch { busy = false; }
      }
      if (busy) { sawRunning = true; stableIdle = 0; }
      if (sawRunning && !busy) {
        const read = await readLastAssistantText(sessionId, { limit: 60 });
        if (read.ok && read.text.length >= minChars) {
          if (read.text.length === lastLen) stableIdle += 1;
          else { stableIdle = 0; lastLen = read.text.length; }
          if (stableIdle >= 1) return { ok: true, via: 'session', text: read.text, waitedMs: Date.now() - started };
        }
      }
      // 活跃度判定：能读到任何 assistant 文本/计划文件就算在干活（inspect 的 running 字段并不总是给）
      if (!sawRunning && Date.now() - started > 20000) {
        const probe = await readLastAssistantText(sessionId, { limit: 20 });
        if (probe.ok && probe.text.length > 0) sawRunning = true;
      }
      if (!sawRunning && Date.now() - started > 90000) {
        return { ok: false, reason: 'session-not-started', sawRunning: false, waitedMs: Date.now() - started };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    // 超时也把能拿到的文本带回去，便于排障
    const last = await readLastAssistantText(sessionId, { limit: 60 });
    return { ok: false, reason: 'timeout', sawRunning, waitedMs: Date.now() - started, text: last.ok ? last.text : '' };
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
    resolvePreset,
    listModels,
    waitForIdle,
    waitForPlan,
    readLastAssistantText,
    resolveAgent
  };
}
