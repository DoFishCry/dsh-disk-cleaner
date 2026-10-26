/**
 * GarbageMaster — 面板与 Host 之间的通道（同源 HTTP + SSE）。
 *
 * 为什么不用 typert 的 ctx.remote：那条路要求编译期生成的 Remote 反射，
 * 对手写纯 JS 插件不可靠。这里用 ctx.webServer.register 注册自己的路由，
 * 纯 JS 两端都能落地，而且 SSE 天然适合"删除后实时更新"（§10）。
 *
 * 鉴权：插件启动时生成一次性 token，经 ctx.webServer.tapIndex 注入到 index.html，
 * 页面从 window.__GARBAGE_MASTER__ 读取后随每次请求发送。外部主机即使能访问
 * 本机端口，也拿不到这个 token（它只出现在本 Host 渲染的页面里）。
 */

import { promises as fsp } from 'node:fs';
import { isUnder } from '../core/model.js';
import { buildPlan, executePlan } from './exec.js';
import { listDirectory, measureDirectory } from './ls.js';
import { applyAiPlan, parseAiPlan, requestAiPlan } from './plan-ai.js';
import { openWithDefault, reveal } from './open.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ROUTE_PREFIX = '/garbage-master';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve({ ok: false, error: 'body-too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({ ok: true, value: {} }); return; }
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, error: 'invalid-json' });
      }
    });
    req.on('error', () => resolve({ ok: false, error: 'request-error' }));
  });
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./state.js').createStore>} deps.store
 * @param {object} deps.config 可变配置对象（dryRun / workers 由面板可改）
 * @param {Array} deps.compiledRules
 * @param {(path:string, rules:Array)=>object} deps.annotate
 * @param {string[]} deps.protectedPaths
 * @param {(targetId:string)=>Promise<object>} deps.startScan
 * @param {(targetId:string)=>void} deps.cancelScan
 * @param {(path:string)=>void} deps.addTarget
 * @param {string} deps.auditDir
 */
export function createApi(deps) {
  const { store, config, compiledRules, annotate, protectedPaths, startScan, cancelScan, addTarget, auditDir, getLlm, getModelSelection, dispatchPlan, getSettings, applySettings, explainPaths, clearExplainCache, lookupExplanation, listAuditRuns, pruneAudit, explainModelInfo, sessionInfo, sessionPlan, sessionExecute } = deps;

  const insideTargets = (p) => store.targets.some((t) => isUnder(p, t.path));

  const routes = {
    'GET /api/state': async () => ({ body: store.snapshot() }),

    'GET /api/tree': async ({ query }) => {
      const scan = store.scans.get(query.get('target'));
      if (!scan) return { status: 404, body: { error: 'no-such-target' } };
      return {
        body: {
          targetId: query.get('target'),
          root: scan.root,
          treeVersion: scan.treeVersion || 0,
          tree: scan.tree,
          usage: scan.usage,
          stats: scan.stats,
          generated: scan.generated
        }
      };
    },

    'GET /api/candidates': async ({ query }) => {
      const scan = store.scans.get(query.get('target'));
      if (!scan) return { status: 404, body: { error: 'no-such-target' } };
      return { body: { targetId: query.get('target'), totals: scan.totals, candidates: scan.candidates || [], treeVersion: scan.treeVersion || 0 } };
    },

    'GET /api/bigfiles': async ({ query }) => {
      const scan = store.scans.get(query.get('target'));
      if (!scan) return { status: 404, body: { error: 'no-such-target' } };
      const limit = Math.min(1000, Math.max(1, Number(query.get('limit')) || 200));
      return { body: { targetId: query.get('target'), total: (scan.bigFiles || []).length, files: (scan.bigFiles || []).slice(0, limit) } };
    },

    'POST /api/scan': async ({ body }) => {
      const targetId = body && body.targetId;
      if (!store.targets.some((t) => t.id === targetId)) return { status: 400, body: { error: 'no-such-target' } };
      startScan(targetId).catch(() => { /* 失败已经通过事件上报 */ });
      return { body: { ok: true, started: targetId } };
    },

    'POST /api/cancel-scan': async ({ body }) => {
      cancelScan(body && body.targetId);
      return { body: { ok: true } };
    },

    // 实时列目录：让「当前位置」面板在任意深度都有内容（扫描树是剪枝过的）
    'GET /api/ls': async ({ query }) => {
      const dirPath = query.get('path');
      if (typeof dirPath !== 'string' || !dirPath.startsWith('/')) return { status: 400, body: { error: 'not-absolute' } };
      const target = store.targets.find((t) => isUnder(dirPath, t.path));
      if (!target) return { status: 403, body: { error: 'outside-targets' } };
      const limit = Math.max(1, Math.min(2000, Number(query.get('limit')) || 300));
      const scan = store.scans.get(target.id);
      const result = await listDirectory({
        dirPath, limit, annotate, rules: compiledRules, scan,
        explainLookup: typeof lookupExplanation === 'function' ? lookupExplanation : null,
        context: { isTargetRoot: dirPath.replace(/\/+$/, '') === target.path.replace(/\/+$/, ''), targetLabel: target.label, usage: target.usage || (scan && scan.usage) || null }
      });
      return { status: result.error === 'not-found' ? 404 : 200, body: result };
    },

    // 按需量体积：只给"体积未知"的目录用，有界遍历，超限即停并标 truncated
    'POST /api/measure': async ({ body }) => {
      const dirPath = body && body.path;
      if (typeof dirPath !== 'string' || !dirPath.startsWith('/')) return { status: 400, body: { error: 'not-absolute' } };
      if (!store.targets.some((t) => isUnder(dirPath, t.path))) return { status: 403, body: { error: 'outside-targets' } };
      try {
        const st = await fsp.lstat(dirPath);
        if (!st.isDirectory()) return { status: 400, body: { error: 'not-a-directory' } };
      } catch {
        return { status: 404, body: { error: 'not-found' } };
      }
      const maxEntries = Math.max(1000, Math.min(200000, Number(body.maxEntries) || 40000));
      const maxMs = Math.max(300, Math.min(10000, Number(body.maxMs) || 3000));
      const result = await measureDirectory({ dirPath, maxEntries, maxMs });
      return { body: result };
    },

    'POST /api/target-add': async ({ body }) => {
      const p = body && body.path;
      if (typeof p !== 'string' || !p.startsWith('/')) return { status: 400, body: { error: 'not-absolute' } };
      try {
        const st = await fsp.lstat(p);
        if (!st.isDirectory()) return { status: 400, body: { error: 'not-a-directory' } };
      } catch {
        return { status: 400, body: { error: 'not-found' } };
      }
      const target = addTarget(p, body && body.label);
      return { body: { ok: true, target } };
    },

    'POST /api/plan': async ({ body }) => {
      const result = buildPlan(store, {
        targetId: body && body.targetId,
        selection: Array.isArray(body && body.selection) ? body.selection : [],
        extraPaths: Array.isArray(body && body.extraPaths) ? body.extraPaths : [],
        items: Array.isArray(body && body.items) ? body.items : undefined,
        includeRecursive: Boolean(body && body.includeRecursive),
        protectedPaths,
        annotate,
        compiledRules
      });
      if (!result.ok) return { status: 400, body: { error: result.error } };

      // ── AI 计划：只补解释/建议/顺序/告警，**不改变删除范围**（范围永远由服务端决定）
      let ai = { used: false, reason: 'skipped' };
      const plan = result.plan;
      if (body && body.useAi !== false && plan.items.length > 0) {
        const target = store.targets.find((t) => t.id === plan.targetId) || null;
        const requested = await requestAiPlan({
          llm: typeof getLlm === 'function' ? getLlm() : null,
          selection: typeof getModelSelection === 'function' ? getModelSelection() : null,
          target,
          items: plan.items,
          totals: plan.totals,
          timeoutMs: Number(config.aiTimeoutMs) || 30000
        });
        if (!requested.ok) {
          ai = { used: false, reason: requested.reason || 'llm-failed' };
        } else {
          const parsed = parseAiPlan(requested.text, new Set(plan.items.map((i) => i.path)));
          if (!parsed.ok) {
            ai = { used: false, reason: parsed.reason || 'bad-json' };
          } else {
            applyAiPlan(plan, Object.assign({}, parsed, { provider: requested.provider, model: requested.model }));
            ai = {
              used: true,
              summary: parsed.summary,
              warnings: parsed.warnings,
              dropped: parsed.dropped,
              provider: requested.provider,
              model: requested.model
            };
          }
        }
        store.emit('plan-ai', { planId: plan.id, used: ai.used, reason: ai.reason || null });
      }

      return {
        body: {
          ok: true,
          planId: plan.id,
          confirmToken: plan.confirmToken,
          expiresAt: plan.expiresAt,
          totals: plan.totals,
          skipped: plan.skipped,
          // 计划按操作类别分组：同类操作放一起、需要重启的排最后
          groups: plan.groups,
          pending: plan.pending,
          uninstall: plan.uninstall || [],
          restartCount: plan.restartCount,
          ai,
          items: plan.items.map((i) => ({
            path: i.path, size: i.size, risk: i.risk, mode: i.mode, recursive: i.recursive,
            source: i.source, note: i.note, special: i.special, remedy: i.remedy,
            aiReason: i.aiReason || null, aiSuggestion: i.aiSuggestion || null
          }))
        }
      };
    },

    'POST /api/submit': async ({ body }) => {
      const planId = body && body.planId;
      const token = body && body.confirmToken;
      const plan = store.plans.get(planId);
      if (!plan) return { status: 404, body: { error: 'no-such-plan' } };
      if (plan.confirmToken !== token) return { status: 403, body: { error: 'bad-confirm-token' } };
      plan.confirmToken = null; // 一次性
      const result = await executePlan({ store, plan, protectedPaths, auditDir, config });
      if (!result.ok) return { status: 409, body: { error: result.error } };
      return { body: { ok: true, report: result.report } };
    },

    // 派发执行：二次确认之后走这里。优先派给智能体团队（一类任务一个执行者），
    // 团队不可用时降级为本进程内执行器 —— 两者用的是同一份计划、同一套租约与审计。
    'POST /api/dispatch': async ({ body }) => {
      const planId = body && body.planId;
      const token = body && body.confirmToken;
      const plan = store.plans.get(planId);
      if (!plan) return { status: 404, body: { error: 'no-such-plan' } };
      if (plan.confirmToken !== token) return { status: 403, body: { error: 'bad-confirm-token' } };
      plan.confirmToken = null; // 一次性
      if (typeof dispatchPlan !== 'function') return { status: 500, body: { error: 'dispatch-unavailable' } };
      const result = await dispatchPlan(plan);
      if (!result.ok) return { status: 409, body: { error: result.error || 'dispatch-failed', detail: result } };
      plan.status = 'complete';
      return { body: result };
    },

    'POST /api/cancel': async () => {
      if (!store.run || store.run.status !== 'running') return { status: 409, body: { error: 'nothing-running' } };
      store.run.cancelRequested = true;
      store.emit('run-cancelling', { planId: store.run.planId });
      return { body: { ok: true } };
    },

    'GET /api/report': async ({ query }) => {
      const plan = store.plans.get(query.get('planId'));
      if (!plan) return { status: 404, body: { error: 'no-such-plan' } };
      return { body: { planId: plan.id, status: plan.status, report: store.run && store.run.planId === plan.id ? store.run.report : null } };
    },

    'GET /api/audit': async ({ query }) => {
      const planId = query.get('planId');
      if (!planId || !/^plan-[0-9a-f]+$/.test(planId)) return { status: 400, body: { error: 'bad-plan-id' } };
      try {
        const text = await fsp.readFile(`${auditDir}/${planId}.jsonl`, 'utf8');
        const lines = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
        return { body: { planId, lines } };
      } catch {
        return { status: 404, body: { error: 'no-audit' } };
      }
    },

    'POST /api/reveal': async ({ body }) => {
      const p = body && body.path;
      if (typeof p !== 'string' || !insideTargets(p)) return { status: 403, body: { error: 'outside-targets' } };
      const result = await reveal(p);
      return { status: result.ok ? 200 : 400, body: result };
    },

    'POST /api/open': async ({ body }) => {
      const p = body && body.path;
      if (typeof p !== 'string' || !insideTargets(p)) return { status: 403, body: { error: 'outside-targets' } };
      const result = await openWithDefault(p);
      return { status: result.ok ? 200 : 400, body: result };
    },

    // 扫描/判定参数：界面右上角设置弹窗读写这里（持久化在状态目录，不写 profile）
    'GET /api/settings': async () => ({
      body: { ok: true, settings: typeof getSettings === 'function' ? getSettings() : null }
    }),

    'POST /api/settings': async ({ body }) => {
      if (typeof applySettings !== 'function') return { status: 500, body: { error: 'settings-unavailable' } };
      const settings = applySettings(body || {});
      return { body: { ok: true, settings } };
    },

    // 会话计划：绑定工作区 / 能力探测 / 权限预设 / 模型列表 / 当前会话策略
    'GET /api/session-info': async () => {
      if (typeof sessionInfo !== 'function') return { status: 500, body: { error: 'unavailable' } };
      const info = await sessionInfo();
      return { body: { ok: true, ...info } };
    },

    // 生成执行计划（替换原来的快速计划）：程序拼提示词 → 计划模式会话 → Markdown
    'POST /api/session-plan': async ({ body }) => {
      if (typeof sessionPlan !== 'function') return { status: 500, body: { error: 'unavailable' } };
      const targetId = body && typeof body.targetId === 'string' ? body.targetId : null;
      if (!targetId) return { status: 400, body: { error: 'target-required' } };
      const out = await sessionPlan({
        targetId,
        selection: Array.isArray(body.selection) ? body.selection : [],
        items: Array.isArray(body.items) ? body.items : null,
        extraPaths: Array.isArray(body.extraPaths) ? body.extraPaths : [],
        includeRecursive: Boolean(body.includeRecursive)
      });
      return { status: out.ok ? 200 : 502, body: out };
    },

    // 二次确认后：同一会话里按计划执行（退出 plan 模式 + 放宽权限）
    'POST /api/session-execute': async ({ body }) => {
      if (typeof sessionExecute !== 'function') return { status: 500, body: { error: 'unavailable' } };
      const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : null;
      if (!sessionId) return { status: 400, body: { error: 'session-required' } };
      const out = await sessionExecute({
        sessionId,
        planId: body.planId || null,
        planPath: body.planPath || null
      });
      return { status: out.ok ? 200 : 502, body: out };
    },

    // 解释用的模型 + 该模型声明的可选思考强度（设置界面用它渲染下拉）
    'GET /api/explain-model': async () => {
      if (typeof explainModelInfo !== 'function') return { status: 500, body: { error: 'unavailable' } };
      const info = await explainModelInfo();
      return { body: { ok: !info.error, ...info } };
    },

    // 审计历史：新增的在前，含每次运行删了哪些路径、多少字节、成败
    'GET /api/audit/list': async ({ query }) => {
      if (typeof listAuditRuns !== 'function') return { status: 500, body: { error: 'audit-unavailable' } };
      const limit = Math.max(1, Math.min(200, Number(query && query.limit) || 50));
      const runs = await listAuditRuns({ limit });
      return { body: { ok: true, runs } };
    },

    // 清理审计日志（保留最近 N 次 / 早于 N 天），避免无限增长
    'POST /api/audit/prune': async ({ body }) => {
      if (typeof pruneAudit !== 'function') return { status: 500, body: { error: 'audit-unavailable' } };
      const keep = Math.max(0, Math.min(10000, Number(body && body.keep) || 0));
      const olderThanDays = Math.max(0, Math.min(3650, Number(body && body.olderThanDays) || 0));
      if (keep === 0 && olderThanDays === 0) return { status: 400, body: { error: 'nothing-to-prune' } };
      const out = await pruneAudit({ keep, olderThanDays });
      if (body && body.clearExplainCache && typeof clearExplainCache === 'function') await clearExplainCache();
      return { body: { ok: true, removed: out.removed, kept: out.kept, clearExplain: Boolean(body && body.clearExplainCache) } };
    },

    // 路径解释：规则优先 → LLM → 低把握项才联网。逐层惰性调用，结果按路径缓存。
    'POST /api/explain': async ({ body }) => {
      if (typeof explainPaths !== 'function') return { status: 500, body: { error: 'explain-unavailable' } };
      const raw = Array.isArray(body && body.entries) ? body.entries.slice(0, 200) : [];
      const entries = raw
        .filter((e) => e && typeof e.path === 'string' && e.path.startsWith('/') && store.targets.some((t) => isUnder(e.path, t.path)))
        .map((e) => ({ path: e.path, isDir: e.isDir !== false, size: typeof e.size === 'number' ? e.size : null }));
      if (entries.length === 0) return { status: 400, body: { error: 'no-valid-paths' } };
      // 注意：不要传 null——宿主 seam 只接受真正的 AbortSignal 或省略
      const result = await explainPaths(entries, undefined, Boolean(body && body.force));
      return { body: { ok: true, results: result.results || {}, error: result.error || null, used: result.used || null } };
    },

    'POST /api/config': async ({ body }) => {
      // 演练模式已按用户要求移除：界面不再提供开关，这里也不再接受 dryRun。
      if (body && Number.isFinite(Number(body.workers))) {
        config.workers = Math.max(1, Math.min(6, Number(body.workers)));
      }
      store.emit('config-changed', { workers: config.workers });
      return { body: { ok: true, config: { workers: config.workers } } };
    }
  };

  /** SSE：先订阅再补历史，用 seq 去重，断线重连不会重复计数。 */
  function handleEvents(req, res, query) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 3000\n\n');

    let lastSent = Math.max(0, Number(query.get('seq')) || 0);
    const send = (event) => {
      if (!event || event.seq <= lastSent) return;
      lastSent = event.seq;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const pending = [];
    let live = false;
    const unsubscribe = store.subscribe((event) => { if (live) send(event); else pending.push(event); });
    for (const event of store.recent(lastSent)) send(event);
    live = true;
    for (const event of pending) send(event);

    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已断开 */ } }, 20000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  /**
   * 处理一次请求；返回 true 表示这个请求归本插件所有。
   */
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith(ROUTE_PREFIX)) return false;

    const token = req.headers['x-garbage-master-token'] || url.searchParams.get('token');
    if (!token || token !== api.token) {
      sendJson(res, 403, { error: 'bad-token' });
      return true;
    }

    const rel = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    if (rel === '/api/events') { handleEvents(req, res, url.searchParams); return true; }

    const key = `${req.method} ${rel}`;
    const handler = routes[key];
    if (!handler) { sendJson(res, 404, { error: 'no-such-route', route: key }); return true; }

    let body = {};
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return true; }
      body = parsed.value;
    }

    try {
      const result = await handler({ query: url.searchParams, body, req });
      sendJson(res, result.status || 200, result.body);
    } catch (error) {
      sendJson(res, 500, { error: error && error.message ? error.message : 'handler-failed' });
    }
    return true;
  }

  const api = { handle, token: null, routes };
  return api;
}
