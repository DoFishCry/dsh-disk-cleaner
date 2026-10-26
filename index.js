/**
 * GarbageMaster — DSH Host 插件入口。
 *
 * 这一层只做装配：探测目标 → 编译规则 → 建状态 → 注册路由 → 注入 token。
 * 真正的逻辑都在 core/（纯函数）与 host/ 的各个能力模块里。
 *
 * 依赖的服务只有 webServer（面板与 Host 的通道）。agentTeams / llm 等
 * 可选能力在后续里程碑接入时会放进可选 inject，缺失时降级而不是报错。
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { buildIndex, deriveCandidates } from './core/model.js';
import { annotate as annotateWith, compileRules } from './core/rules.js';
import { createApi } from './host/http.js';
import { DEFAULT_SCAN_CONFIG, readMountPoints, scanTarget } from './host/scan.js';
import { createStore } from './host/state.js';
import {
  EXECUTOR_TOOL, authorizeCaller, buildDispatchPlan, createGroupWaiters, dispatchSequentially
} from './host/dispatch.js';
import { executePlan } from './host/exec.js';
import { cacheKey, explainEntries } from './host/explain.js';
import { listAuditRuns, pruneAudit } from './host/audit.js';
import { optSignal } from './host/signal.js';
import { createSessionBridge } from './host/session-bridge.js';
import { buildExecutePrompt, buildExplainNotice, buildPlanPrompt } from './host/session-prompt.js';

/** Cordis 插件名（与 patch 行 id 对应，便于在配置目录里定位）。 */
export const name = 'garbage-master';

/** 本插件依赖的服务。 */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/garbage-master';
const REAL_FILESYSTEMS = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'iso9660', 'udf'
]);
const PSEUDO_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap'];

const DEFAULTS = {
  // 演练模式已按用户要求移除。执行器内部仍保留 dryRun 能力（供测试与排障），
  // 但界面不再暴露开关，默认一律走"先出计划、二次确认后执行"。
  dryRun: false,
  workers: 3,
  minCandidateBytes: 1024 * 1024,
  targets: null,
  // 路径解释：默认只自动解释前两层，逐层惰性；联网只给低把握项用
  explainDepth: 2,
  explainMaxItems: 40,
  explainMaxSearches: 2,
  explainUseWeb: true,
  explainConcurrency: 3,   // 分批并行度（1=串行）
  workspaceId: '',         // 绑定工作区 id（空=自动取第一个）
  workspacePath: '',       // 也接受按路径绑定
  planSession: true,       // 是否启用"会话计划"（替换原有快速计划）
  explainModel: '',        // 'provider/model' 覆盖；空=跟随会话/默认模型
  explainReasoningEffort: '', // '' = 继承当前模型选择的思考强度
  scan: {}
};

function slug(text) {
  return text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'target';
}

/** 解析 /proc/self/mounts，挑出"真实文件系统的挂载点"。 */
async function detectMountTargets() {
  const mountPoints = await readMountPoints();
  const found = [];
  let text = '';
  try {
    text = await fsp.readFile('/proc/self/mounts', 'utf8');
  } catch {
    text = '';
  }
  const types = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const point = parts[1].replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    types.set(point, parts[2]);
  }
  for (const point of mountPoints) {
    if (PSEUDO_MOUNT_PREFIXES.some((prefix) => point === prefix || point.startsWith(`${prefix}/`))) continue;
    if (point !== '/' && !point.startsWith('/media/') && !point.startsWith('/mnt/')) continue;
    const fsType = types.get(point);
    if (fsType && !REAL_FILESYSTEMS.has(fsType)) continue;
    found.push(point);
  }
  found.sort();
  return found;
}

/**
 * 组装扫描目标列表。
 *
 * **按文件系统去重**：一台机器上"家目录"和"/"经常在同一个分区（本机就是这样：
 * 两者都在 /dev/mapper/ubuntu--vg-ubuntu--lv）。把它们当成两个盘会同时显示同一个
 * 分区的容量，还会让人以为有两块盘。所以这里按 `stat().dev` 归并：
 * 每个真实文件系统一个目标，家目录只在**独立分区**时才单独出现。
 */
async function buildTargets(config) {
  if (Array.isArray(config.targets) && config.targets.length > 0) {
    return config.targets.map((t) => ({
      id: t.id || slug(t.path),
      path: t.path,
      label: t.label || t.path
    }));
  }
  const home = os.homedir();
  const mounts = await detectMountTargets();
  const byDevice = new Map();
  const targets = [];

  for (const point of mounts) {
    let device = null;
    try {
      const st = await fsp.stat(point);
      device = `${st.dev}`;
    } catch { /* 读不到就按路径独立处理 */ }
    const key = device || `path:${point}`;
    if (byDevice.has(key)) continue;
    byDevice.set(key, point);
    targets.push({
      id: point === '/' ? 'root' : slug(point.replace(/^\/(media|mnt)\//, '')),
      path: point,
      label: point === '/' ? '系统根分区 /' : `数据盘 ${point}`,
      device: key
    });
  }

  // 家目录只有落在独立分区时才是一个"盘"；同分区时它只需要一个快捷入口。
  let homeTarget = null;
  try {
    const homeDev = `${(await fsp.stat(home)).dev}`;
    if (!byDevice.has(homeDev)) {
      homeTarget = { id: 'home', path: home, label: `家目录 ${home}`, device: homeDev };
      targets.unshift(homeTarget);
    }
  } catch { /* 家目录不可读就跳过 */ }

  // 按剩余空间从紧到松排序，最该清理的排最前
  const withFree = [];
  for (const target of targets) {
    const usage = await diskUsageOf(target.path);
    withFree.push({ ...target, usage });
  }
  withFree.sort((a, b) => (a.usage.free / (a.usage.total || 1)) - (b.usage.free / (b.usage.total || 1)));

  const seen = new Set();
  return withFree.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

/** 一次 statfs 取容量（不遍历目录）。 */
async function diskUsageOf(root) {
  try {
    const st = await fsp.statfs(root);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return { total, free, used: Math.max(0, total - free) };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig patch 行里的 config（本插件不声明 Config schema，这里手工合并默认值）
 */
export async function apply(ctx, rawConfig = {}) {
  const config = {
    ...DEFAULTS,
    ...rawConfig,
    scan: { ...DEFAULT_SCAN_CONFIG, ...(rawConfig.scan || {}) }
  };

  const home = os.homedir();
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
  const stateDir = config.stateDir || path.join(dshHome, 'garbage-master');
  const auditDir = path.join(stateDir, 'audit');
  const archivesDir = path.join(stateDir, 'archives');
  await fsp.mkdir(auditDir, { recursive: true });
  await fsp.mkdir(archivesDir, { recursive: true });
  // 打包/整理/审计都要知道这些位置；一处定义，执行器直接用
  config.stateDir = stateDir;
  config.archivesDir = archivesDir;

  const compiledRules = compileRules({ home });
  const annotate = (p, rules) => annotateWith(p, rules || compiledRules);
  const targets = await buildTargets(config);
  const mountPoints = await readMountPoints();
  const protectedPaths = [...new Set(['/', home, stateDir, ...targets.map((t) => t.path), ...mountPoints])];

  const store = createStore({
    config,
    home,
    stateDir,
    targets,
    quickPaths: [
      { id: 'home', label: '家目录', path: home },
      { id: 'downloads', label: '下载', path: path.join(home, 'Downloads') },
      { id: 'cache', label: '.cache', path: path.join(home, '.cache') }
    ]
  });
  const cancelFlags = new Map();
  const scanProgressAt = new Map();

  /** 刷新每个目标的容量（一次 statfs/目标，不遍历目录）。 */
  async function refreshUsage() {
    for (const target of store.targets) {
      const usage = await diskUsageOf(target.path);
      if (usage.total > 0) target.usage = usage;
    }
    store.emit('usage-refreshed', { at: Date.now() });
  }

  // ── 可在界面里调整的扫描/判定参数（持久化到状态目录，不写 profile） ────────
  const SETTINGS_FILE = path.join(stateDir, 'settings.json');
  const SETTINGS_LIMITS = {
    bigFileBytes: [1 * 1024 ** 2, 100 * 1024 ** 3],
    minExpandBytes: [1 * 1024 ** 2, 50 * 1024 ** 3],
    minCandidateBytes: [64 * 1024, 1 * 1024 ** 3],
    maxDepth: [3, 20],
    keepTop: [5, 60],
    filesPerDir: [5, 50],
    workers: [1, 6],
    explainDepth: [0, 6],
    explainMaxItems: [1, 200],
    explainMaxSearches: [0, 20],
    explainConcurrency: [1, 6]
  };

  function clampSetting(key, value) {
    const limits = SETTINGS_LIMITS[key];
    const num = Number(value);
    if (!limits || !Number.isFinite(num)) return null;
    return Math.min(limits[1], Math.max(limits[0], Math.round(num)));
  }

  function currentSettings() {
    return {
      bigFileBytes: config.scan.bigFileBytes,
      minExpandBytes: config.scan.minExpandBytes,
      minCandidateBytes: config.minCandidateBytes,
      maxDepth: config.scan.maxDepth,
      keepTop: config.scan.keepTop,
      filesPerDir: config.scan.filesPerDir,
      workers: config.workers,
      explainDepth: config.explainDepth,
      explainMaxItems: config.explainMaxItems,
      explainMaxSearches: config.explainMaxSearches,
      explainUseWeb: config.explainUseWeb,
      explainConcurrency: config.explainConcurrency,
      explainReasoningEffort: config.explainReasoningEffort,
      workspaceId: config.workspaceId,
      workspacePath: config.workspacePath,
      planSession: config.planSession,
      explainModel: config.explainModel
    };
  }

  function applySettings(patch) {
    const next = currentSettings();
    const applied = {};
    for (const key of Object.keys(SETTINGS_LIMITS)) {
      if (!patch || patch[key] === undefined) continue;
      const value = clampSetting(key, patch[key]);
      if (value === null) continue;
      applied[key] = value;
    }
    if (applied.bigFileBytes !== undefined) config.scan.bigFileBytes = applied.bigFileBytes;
    if (applied.minExpandBytes !== undefined) config.scan.minExpandBytes = applied.minExpandBytes;
    if (applied.maxDepth !== undefined) config.scan.maxDepth = applied.maxDepth;
    if (applied.keepTop !== undefined) config.scan.keepTop = applied.keepTop;
    if (applied.filesPerDir !== undefined) config.scan.filesPerDir = applied.filesPerDir;
    if (applied.minCandidateBytes !== undefined) config.minCandidateBytes = applied.minCandidateBytes;
    if (applied.workers !== undefined) config.workers = applied.workers;
    if (applied.explainDepth !== undefined) config.explainDepth = applied.explainDepth;
    if (applied.explainMaxItems !== undefined) config.explainMaxItems = applied.explainMaxItems;
    if (applied.explainMaxSearches !== undefined) config.explainMaxSearches = applied.explainMaxSearches;
    if (patch && typeof patch.explainUseWeb === 'boolean') {
      config.explainUseWeb = patch.explainUseWeb;
      applied.explainUseWeb = patch.explainUseWeb;
    }
    if (applied.explainConcurrency !== undefined) config.explainConcurrency = applied.explainConcurrency;
    if (patch && typeof patch.workspaceId === 'string') { config.workspaceId = patch.workspaceId.slice(0, 120); applied.workspaceId = config.workspaceId; }
    if (patch && typeof patch.workspacePath === 'string') { config.workspacePath = patch.workspacePath.slice(0, 500); applied.workspacePath = config.workspacePath; }
    if (patch && typeof patch.planSession === 'boolean') { config.planSession = patch.planSession; applied.planSession = patch.planSession; }
    if (patch && typeof patch.explainModel === 'string') { config.explainModel = patch.explainModel.slice(0, 200); applied.explainModel = config.explainModel; }
    if (patch && typeof patch.explainReasoningEffort === 'string') {
      config.explainReasoningEffort = patch.explainReasoningEffort.slice(0, 40);
      applied.explainReasoningEffort = config.explainReasoningEffort;
    }
    fsp.writeFile(SETTINGS_FILE, JSON.stringify(currentSettings(), null, 2), 'utf8').catch(() => {});
    store.emit('config-changed', { settings: currentSettings() });
    return currentSettings();
  }

  // 启动时读回上次保存的设置（损坏就当没有）
  try {
    const saved = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
    applySettings(saved);
  } catch { /* 首次运行或文件损坏：用默认值 */ }


  function addTarget(targetPath, label) {
    const id = slug(label || targetPath) + '-' + randomBytes(2).toString('hex');
    const target = { id, path: targetPath, label: label || targetPath };
    store.targets.push(target);
    protectedPaths.push(targetPath);
    store.emit('target-added', { target });
    return target;
  }

  async function startScan(targetId) {
    const target = store.targets.find((t) => t.id === targetId);
    if (!target) throw new Error(`未知目标：${targetId}`);
    const existing = store.scans.get(targetId);
    if (existing && existing.status === 'scanning') return existing;

    cancelFlags.set(targetId, false);
    const scan = {
      targetId,
      root: target.path,
      label: target.label,
      status: 'scanning',
      progress: null,
      tree: null,
      index: null,
      candidates: [],
      totals: null,
      bigFiles: [],
      usage: null,
      stats: null,
      treeVersion: 0,
      generated: null,
      error: null
    };
    store.scans.set(targetId, scan);
    store.emit('scan-started', { targetId, root: target.path, label: target.label });

    try {
      const result = await scanTarget({
        root: target.path,
        config: config.scan,
        shouldStop: () => cancelFlags.get(targetId) === true,
        onProgress: (progress) => {
          const now = Date.now();
          const last = scanProgressAt.get(targetId) || 0;
          scan.progress = progress;
          if (now - last < 500) return;
          scanProgressAt.set(targetId, now);
          store.emit('scan-progress', { targetId, ...progress });
        }
      });

      if (cancelFlags.get(targetId) === true) {
        scan.status = 'cancelled';
        scan.progress = null;
        store.emit('scan-cancelled', { targetId });
        return scan;
      }

      scan.tree = result.tree;
      scan.index = buildIndex(result.tree);
      scan.bigFiles = result.bigFiles;
      scan.usage = result.usage;
      scan.stats = result.stats;
      // 顺手把目标容量刷新掉，界面上的"剩余 XX G"立刻是新的
      if (result.usage && result.usage.total > 0) target.usage = result.usage;

      const derived = deriveCandidates({
        tree: result.tree,
        compiledRules,
        annotate,
        home,
        minBytes: config.minCandidateBytes
      });
      scan.candidates = derived.candidates;
      scan.totals = derived.totals;
      scan.generated = new Date().toISOString();
      scan.progress = null;
      scan.status = 'complete';
      scan.treeVersion += 1;

      store.emit('scan-done', {
        targetId,
        generated: scan.generated,
        stats: scan.stats,
        usage: scan.usage,
        totals: derived.totals,
        candidateCount: derived.candidates.length,
        treeVersion: scan.treeVersion
      });
      return scan;
    } catch (error) {
      scan.status = 'failed';
      scan.error = error && error.message ? error.message : String(error);
      scan.progress = null;
      store.emit('scan-failed', { targetId, error: scan.error });
      return scan;
    }
  }

  function cancelScan(targetId) {
    if (targetId) cancelFlags.set(targetId, true);
    else for (const id of store.scans.keys()) cancelFlags.set(id, true);
  }

  // ── 派发给智能体（Agent Teams）与受限执行工具 ─────────────────────────
  //
  // 子代理**不直接动文件系统**：它只能调用 garbage_run_group，由插件这边带
  // 路径租约与审计的执行器干活。工具本身会校验"调用者是不是本计划该组的指定执行者"，
  // 因此即使主智能体看到了这个工具，也无法越权触发执行。

  const groupWaiters = new Map();
  let toolDisposer = null;
  let toolRegistered = false;

  /** 解析可用的团队：需要 agentTeams + agents，且能找到 Lead。 */
  function resolveTeam() {
    let teams = null;
    let agents = null;
    try { teams = ctx.get('agentTeams'); } catch { teams = null; }
    try { agents = ctx.get('agents'); } catch { agents = null; }
    if (!teams || !agents || typeof teams.spawnTeammate !== 'function') {
      return { ok: false, reason: 'agent-teams-unavailable（组合里没有挂载 Agent Teams）' };
    }
    let roots = [];
    try { roots = agents.roots() || []; } catch { roots = []; }
    for (const agent of roots) {
      try {
        const membership = typeof teams.tryMembership === 'function' ? teams.tryMembership(agent) : null;
        if (membership && membership.role === 'lead') return { ok: true, teams, lead: agent, leadName: membership.name };
      } catch { /* 换下一个 */ }
    }
    return { ok: false, reason: '找不到可作为 Lead 的根会话（no-lead）' };
  }

  /** 注册受限执行工具（幂等；工具服务晚就绪时下次调用再试）。 */
  function ensureExecutorTool() {
    if (toolRegistered) return true;
    let tools = null;
    try { tools = ctx.get('tools'); } catch { tools = null; }
    if (!tools || typeof tools.register !== 'function') return false;
    try {
      toolDisposer = tools.register({
        name: EXECUTOR_TOOL,
        description: '执行一个已确认清理计划中**某一类**任务（clean=删除 / pack=打包 / tidy=去重整理）。只允许被派发的执行者调用，且每组只能执行一次。',
        parameters: {
          type: 'object',
          properties: {
            planId: { type: 'string', description: '计划 id（来自派发消息）' },
            mode: { type: 'string', enum: ['clean', 'pack', 'tidy'], description: '只执行这一类' }
          },
          required: ['planId', 'mode'],
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              mode: { type: 'string' },
              summary: { type: 'string' },
              bytes: { type: 'number' },
              items: { type: 'number' }
            },
            required: ['ok', 'mode', 'summary'],
            additionalProperties: true
          },
          render(args, value) {
            return [{ type: 'text', text: (value && value.summary) || JSON.stringify(value) }];
          }
        },
        execute: async (args, exec) => {
          const planId = args && args.planId;
          const mode = args && args.mode;
          const plan = store.plans.get(planId);
          if (!plan) throw new Error('拒绝执行：没有这个计划');
          let callerName = null;
          try {
            const teams = ctx.get('agentTeams');
            const membership = teams && typeof teams.tryMembership === 'function' ? teams.tryMembership(exec.agent) : null;
            callerName = membership ? membership.name : null;
          } catch { callerName = null; }
          const auth = authorizeCaller(plan, { mode, callerName });
          if (!auth.ok) throw new Error(`拒绝执行：${auth.error}`);

          const cached = plan.dispatch && plan.dispatch.results ? plan.dispatch.results[mode] : null;
          if (cached && cached.report) {
            return { ok: true, mode, summary: `${mode} 已执行过（幂等返回）`, bytes: cached.report.actualBytes || 0, items: (cached.report.deleted || []).length };
          }

          store.emit('group-run-started', { planId: plan.id, mode, teammate: callerName });
          const result = await executePlan({ store, plan, protectedPaths, auditDir, config, modes: [mode], actorLabel: callerName });
          const report = result.ok ? result.report : null;
          const summary = result.ok
            ? `${mode} 完成：处理 ${(report.deleted || []).length} 项，回收 ${report.actualBytes || 0} 字节${report.pack ? `，归档 ${report.pack.bytes || 0} 字节` : ''}`
            : `${mode} 失败：${result.error}`;
          store.emit('group-run-done', { planId: plan.id, mode, ok: result.ok, summary });

          const waiters = groupWaiters.get(plan.id);
          if (waiters) waiters.resolve(mode, { ok: result.ok, report, error: result.error || null });
          return { ok: result.ok, mode, summary, bytes: report ? report.actualBytes || 0 : 0, items: report ? (report.deleted || []).length : 0 };
        }
      });
      toolRegistered = true;
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`[garbage-master] 执行工具注册失败：${error && error.message}`);
      return false;
    }
  }

  // ── 会话桥：工作区绑定、会话复用策略、计划模式、权限、可见通知 ─────────
  const sessionBridge = createSessionBridge({ ctx, stateDir, logger: ctx.logger || null });

  /** 解释用模型：设置覆盖 → 计划会话的模型 → 默认选择。 */
  async function explainSelection() {
    try {
      if (config.explainModel && config.explainModel.includes('/')) {
        const idx = config.explainModel.indexOf('/');
        return { provider: config.explainModel.slice(0, idx), model: config.explainModel.slice(idx + 1), reasoningEffort: config.explainReasoningEffort || undefined };
      }
    } catch { /* 落到默认 */ }
    let selection = null;
    try {
      const service = ctx.get('agentDefaultModel');
      selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null;
    } catch { selection = null; }
    if (selection && config.explainReasoningEffort) {
      return { provider: selection.provider, model: selection.model, reasoningEffort: config.explainReasoningEffort };
    }
    return selection;
  }

  /** 权限预设挑选：执行阶段要"最宽"，计划阶段交给 planMode 约束。 */
  function pickWidestPreset() {
    const listed = sessionBridge.listPermissions();
    if (!listed.ok || listed.options.length === 0) return null;
    const loose = /(full|all|bypass|unrestricted|yolo|完全|不受限|最大)/i;
    const hit = listed.options.find((o) => loose.test(o.value) || loose.test(o.name) || loose.description && loose.test(o.description));
    return (hit || listed.options[listed.options.length - 1]).value;
  }

  // ── 路径解释：规则优先 → LLM → 低把握才联网；按路径缓存 ──────────────
  const EXPLAIN_CACHE_FILE = path.join(stateDir, 'explain-cache.json');
  let explainCache = {};
  try { explainCache = JSON.parse(await fsp.readFile(EXPLAIN_CACHE_FILE, 'utf8')) || {}; } catch { explainCache = {}; }
  let explainSaveTimer = null;
  function saveExplainCache() {
    // 立即落盘：解释是花钱换来的，不能因为进程重启丢掉最近几条
    fsp.writeFile(EXPLAIN_CACHE_FILE, JSON.stringify(explainCache), 'utf8').catch(() => {});
  }

  /** 查询解释将使用的模型，以及该模型声明的可选思考强度（给设置界面用）。 */
  async function explainModelInfo() {
    let llm = null;
    let selection = null;
    try { llm = ctx.get('llm') || null; } catch { llm = null; }
    try {
      const service = ctx.get('agentDefaultModel');
      selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null;
    } catch { selection = null; }
    if (selection && selection.reasoningEffort === undefined && config.explainReasoningEffort) {
      // 只是展示用，不改变 selection 本身
    }
    const base = {
      selection: selection ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort ? String(selection.reasoningEffort) : null } : null,
      configured: config.explainReasoningEffort || '',
      efforts: [],
      defaultEffort: null,
      error: null
    };
    if (!llm || !selection) return Object.assign(base, { error: 'llm-unavailable' });
    try {
      let info = null;
      if (typeof llm.resolveModelInfo === 'function') {
        info = await llm.resolveModelInfo(selection.provider, selection.model);
      } else if (typeof llm.listModels === 'function') {
        const models = await llm.listModels(selection.provider);
        info = Array.isArray(models) ? models.find((m) => m && m.id === selection.model) || null : null;
      } else {
        return Object.assign(base, { error: 'no-model-info-api' });
      }
      const reasoning = info && info.reasoning;
      if (reasoning && Array.isArray(reasoning.efforts)) {
        base.efforts = reasoning.efforts.map((e) => ({ id: String(e.id), name: e.name || String(e.id), description: e.description || '' }));
      }
      base.defaultEffort = reasoning && reasoning.defaultEffort ? String(reasoning.defaultEffort) : null;
    } catch (error) {
      base.error = error && error.message ? error.message : 'resolve-failed';
    }
    return base;
  }

  /** 查某路径已缓存的解释文本（供 /api/ls 直接带回，避免前端空跑一次请求）。 */
  function lookupExplanation(target) {
    try {
      const key = cacheKey({ path: target, rulePackVersion: compiledRules.length });
      const hit = explainCache[key];
      return hit && typeof hit.text === 'string' && hit.text ? hit.text : null;
    } catch { return null; }
  }

  async function clearExplainCache() {
    explainCache = {};
    try { await fsp.unlink(EXPLAIN_CACHE_FILE); } catch { /* 文件不存在就算了 */ }
    store.emit('explain-cache-cleared', {});
    return { ok: true };
  }

  async function explainPaths(entries, signal, force = false) {
    signal = optSignal(signal); // 传 null 会被 seam 拒绝
    let llm = null;
    let selection = null;
    let web = null;
    try { llm = ctx.get('llm') || null; } catch { llm = null; }
    try { selection = await explainSelection(); } catch { selection = null; }
    try { web = ctx.get('web') || null; } catch { web = null; }
    // 每批完成立刻通过 SSE 推给页面：前端能"逐批"显示，而不是整层等完
    const onBatch = (batchResults) => store.emit('explain-partial', { results: batchResults });
    const effort = typeof config.explainReasoningEffort === 'string' && config.explainReasoningEffort.length > 0
      ? config.explainReasoningEffort
      : (selection && selection.reasoningEffort ? String(selection.reasoningEffort) : undefined);
    const result = await explainEntries({
      entries,
      annotate,
      rules: compiledRules,
      rulePackVersion: compiledRules.length,
      cache: explainCache,
      saveCache: saveExplainCache,
      llm,
      selection,
      web,
      config,
      signal,
      force,
      onBatch,
      reasoningEffort: effort
    });
    store.emit('explain-done', { count: Object.keys(result.results || {}).length, used: result.used, error: result.error || null });
    // 便于事后定位：把最后一次解释的结果/失败原因写下来（含模型原始输出片段）
    try {
      await fsp.writeFile(path.join(stateDir, 'explain-last.json'), JSON.stringify({
        at: new Date().toISOString(),
        paths: entries.map((e) => e.path).slice(0, 20),
        ok: !result.error,
        error: result.error || null,
        snippet: result.snippet || null,
        chunkTypes: result.chunkTypes || null,
        used: result.used || null,
        got: Object.keys(result.results || {}).length,
        selection: selection ? { provider: selection.provider, model: selection.model } : null
      }, null, 2), 'utf8');
    } catch { /* 诊断文件写不了不影响主流程 */ }
    // B+C：解释结果写进会话（可见通知）+ 另存完整记录（log-only）
    if (config.planSession && entries.length > 0) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const resolved = await sessionBridge.resolveWorkspace({ workspaceId: config.workspaceId, workspacePath: config.workspacePath });
        if (resolved.ok) {
          const ensured = await sessionBridge.ensureSession({ kind: 'explain', workspace: resolved.workspace, today });
          if (ensured.ok) {
            const detail = Object.entries(result.results || {}).map(([p, v]) => ({ path: p, text: v.text, source: v.source }));
            const record = await sessionBridge.writeExplainRecord({ planKey: today, entries: detail, used: result.used, target: null });
            const notice = buildExplainNotice({ entries: detail, used: result.used, explainPath: record.ok ? record.file : null });
            await sessionBridge.appendNotice(ensured.sessionId, { summary: notice.summary, text: notice.text, raw: detail, recordType: 'plugin:garbage-master/explain' });
            await sessionBridge.noteActivity({ kind: 'explain', sessionId: ensured.sessionId, workspaceId: resolved.workspace.id, today });
            result.session = { sessionId: ensured.sessionId, notice: notice.summary };
          } else {
            result.session = { error: ensured.reason };
          }
        } else {
          result.session = { error: resolved.reason };
        }
      } catch (error) {
        result.session = { error: error && error.message ? error.message : 'session-notice-failed' };
      }
    }
    return result;
  }

  // ── 会话计划：程序拼提示词 → 计划模式会话 → Markdown 计划 ──────────────
  async function sessionInfo() {
    const resolved = await sessionBridge.resolveWorkspace({ workspaceId: config.workspaceId, workspacePath: config.workspacePath });
    const listed = await sessionBridge.listWorkspaces();
    const permissions = sessionBridge.listPermissions();
    const models = await sessionBridge.listModels();
    const policy = await sessionBridge.loadPolicy();
    return {
      capabilities: sessionBridge.capabilities(),
      workspaces: listed.ok ? listed.workspaces : [],
      workspace: resolved.ok ? resolved.workspace : null,
      workspaceError: resolved.ok ? null : resolved.reason,
      permissions,
      models: models.ok ? models.providers : [],
      modelsError: models.ok ? null : models.reason,
      policy,
      planSession: config.planSession
    };
  }

  /**
   * 生成执行计划：确定性校验（buildPlan）→ 程序拼 Markdown 提示词 →
   * 绑定工作区的会话（plan 模式）→ 等它产出 → 读回 Markdown。
   */
  async function sessionPlan({ targetId, selection = [], items = null, extraPaths = [], includeRecursive = false, timeoutMs = 240000 } = {}) {
    const resolved = await sessionBridge.resolveWorkspace({ workspaceId: config.workspaceId, workspacePath: config.workspacePath });
    if (!resolved.ok) return { ok: false, error: `工作区不可用：${resolved.reason}` };
    const caps = sessionBridge.capabilities();
    if (!caps.sessionController || !caps.prompt) return { ok: false, error: '宿主没有提供会话接口（sessionController）' };

    const built = buildPlan(store, { targetId, selection, items, extraPaths, includeRecursive, protectedPaths, annotate, compiledRules });
    if (!built.ok) return { ok: false, error: built.error, detail: built };
    const plan = built.plan;
    const target = store.targets.find((t) => t.id === targetId) || null;
    const today = new Date().toISOString().slice(0, 10);
    const ensured = await sessionBridge.ensureSession({ kind: 'explain', workspace: resolved.workspace, today, title: `GarbageMaster · ${today}` });
    if (!ensured.ok) return { ok: false, error: `会话不可用：${ensured.reason}` };

    const planPath = path.join(resolved.workspace.path || stateDir, '.garbage-master', 'plans', `${plan.id}.md`);
    const promptText = buildPlanPrompt({
      workspace: resolved.workspace, target, items: plan.items, totals: plan.totals,
      planPath, planId: plan.id, maxItems: 60
    });
    const planMode = await sessionBridge.setPlanMode(ensured.sessionId, true);
    await sessionBridge.prompt(ensured.sessionId, promptText);
    const waited = await sessionBridge.waitForIdle(ensured.sessionId, { timeoutMs });

    let markdown = '';
    let source = null;
    try { markdown = await fsp.readFile(planPath, 'utf8'); source = 'file'; } catch { markdown = ''; }
    if (!markdown) {
      const read = await sessionBridge.readLastAssistantText(ensured.sessionId, { limit: 60 });
      if (read.ok) { markdown = read.text; source = 'session'; }
    }
    // 计划落一份到审计目录，便于事后核对"计划了什么"
    try {
      await fsp.mkdir(auditDir, { recursive: true });
      await fsp.writeFile(path.join(auditDir, `session-plan-${plan.id}.json`), JSON.stringify({
        at: new Date().toISOString(), sessionId: ensured.sessionId, workspace: resolved.workspace,
        targetId, planId: plan.id, totals: plan.totals, markdown, source
      }, null, 2), 'utf8');
    } catch { /* 记账失败不影响返回 */ }

    await sessionBridge.noteActivity({ kind: 'explain', sessionId: ensured.sessionId, workspaceId: resolved.workspace.id, today });
    return {
      ok: true,
      planId: plan.id,
      sessionId: ensured.sessionId,
      sessionAction: ensured.action,
      planPath,
      markdown,
      planSource: source,
      sessionIdle: waited.ok,
      planMode,
      totals: plan.totals,
      skipped: plan.skipped,
      workspace: resolved.workspace
    };
  }

  /** 用户二次确认后：退出计划模式 → 放宽权限 → 在同一会话里按计划执行。 */
  async function sessionExecute({ sessionId, planId, planPath: planPathIn } = {}) {
    if (!sessionId) return { ok: false, error: '缺少 sessionId' };
    const preset = pickWidestPreset();
    const permission = preset ? await sessionBridge.setPermission(sessionId, preset) : { ok: false, reason: 'no-preset-available' };
    const planMode = await sessionBridge.setPlanMode(sessionId, false);
    const text = buildExecutePrompt({ planPath: planPathIn, planId });
    const prompted = await sessionBridge.prompt(sessionId, text);
    if (!prompted.ok) return { ok: false, error: `发送执行指令失败：${prompted.reason}` };
    const today = new Date().toISOString().slice(0, 10);
    await sessionBridge.noteActivity({ kind: 'write', sessionId, today });
    return { ok: true, sessionId, permission, planMode, preset };
  }

  /** 派发：优先团队，逐类下发；团队不可用则降级为进程内执行（同一套租约与审计）。 */
  async function dispatchPlan(plan) {
    ensureExecutorTool();
    const entries = buildDispatchPlan(plan);
    if (entries.length === 0) return { ok: false, error: '计划里没有可派发的分组（需要重启的任务不派发）' };

    const team = resolveTeam();
    if (team.ok) {
      const waiters = createGroupWaiters({ timeoutMs: Number(config.dispatchTimeoutMs) || 15 * 60 * 1000 });
      groupWaiters.set(plan.id, waiters);
      store.emit('dispatch-started', { planId: plan.id, mode: 'team', groups: entries.map((e) => ({ mode: e.mode, teammate: e.teammateName, itemCount: e.itemCount })) });
      try {
        const signal = new AbortController().signal;
        const out = await dispatchSequentially({
          plan,
          entries,
          spawnTeammate: (req) => team.teams.spawnTeammate(team.lead, Object.assign({}, req, {
            provider: config.teamProvider || 'spawn',
            signal
          })),
          createTask: (req) => team.teams.createTask(team.lead, req),
          sendMessage: (req) => team.teams.sendMessage(team.lead, Object.assign({}, req, { signal })),
          completeTask: (req) => team.teams.updateTask(team.lead, {
            taskId: req.taskId,
            expectedRevision: Number(req.expectedRevision) || 1,
            action: 'complete'
          }),
          waitForGroup: (mode) => waiters.wait(mode),
          onEvent: (event) => store.emit(event.type, Object.assign({}, event, { planId: plan.id }))
        });
        const reports = entries.map((entry) => {
          const done = plan.dispatch && plan.dispatch.results ? plan.dispatch.results[entry.mode] : null;
          return done && done.report ? done.report : { mode: entry.mode, error: done ? done.error : 'no-report' };
        });
        store.emit('dispatch-done', { planId: plan.id, mode: 'team', ok: out.ok, errors: out.errors });
        return { ok: out.ok, mode: 'team', lead: team.leadName, dispatch: { groups: out.groups, errors: out.errors }, reports };
      } finally {
        groupWaiters.delete(plan.id);
      }
    }

    // 降级：进程内按组顺序执行
    store.emit('dispatch-started', { planId: plan.id, mode: 'in-process', reason: team.reason, groups: entries.map((e) => ({ mode: e.mode, itemCount: e.itemCount })) });
    const reports = [];
    for (const entry of entries) {
      const result = await executePlan({ store, plan, protectedPaths, auditDir, config, modes: [entry.mode] });
      reports.push(result.ok ? result.report : { mode: entry.mode, error: result.error });
      if (!result.ok) break;
    }
    store.emit('dispatch-done', { planId: plan.id, mode: 'in-process', ok: reports.every((r) => !r.error) });
    return {
      ok: true,
      mode: 'in-process',
      reason: team.reason,
      dispatch: { groups: entries.map((e) => ({ mode: e.mode, status: 'done' })), errors: [] },
      reports
    };
  }

  const api = createApi({
    store,
    config,
    compiledRules,
    annotate,
    protectedPaths,
    startScan,
    cancelScan,
    addTarget,
    refreshUsage,
    auditDir,
    // 可选能力：这两个服务不在组合里时，AI 计划自动降级为规则计划，而不是报错
    dispatchPlan,
    explainPaths,
    clearExplainCache,
    lookupExplanation,
    explainModelInfo,
    sessionInfo,
    sessionPlan,
    sessionExecute,
    listAuditRuns: (options) => listAuditRuns(Object.assign({ auditDir }, options || {})),
    pruneAudit: (options) => pruneAudit(Object.assign({ auditDir }, options || {})),
    getSettings: () => currentSettings(),
    applySettings,
    getLlm: () => { try { return ctx.get('llm') || null; } catch { return null; } },
    getModelSelection: () => {
      try {
        const service = ctx.get('agentDefaultModel');
        return service && typeof service.currentSelection === 'function' ? service.currentSelection() : null;
      } catch { return null; }
    }
  });
  api.token = randomBytes(24).toString('hex');

  // 一次清理跑完就把各盘容量刷新一遍（每个目标一次 statfs）
  store.subscribe((event) => {
    if (event && event.type === 'run-done') refreshUsage().catch(() => {});
  });

  let disposed = false;

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        api.handle(req, res).then((owned) => {
          if (!owned) { res.writeHead(404); res.end(); }
        }).catch((error) => {
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: error && error.message ? error.message : 'handler-failed' }));
          } catch { /* 响应已结束 */ }
        });
      }
    });

    // 一次性 token 注入到 index.html：只有本 Host 渲染出的页面才拿得到它
    const payload = JSON.stringify({ token: api.token, prefix: ROUTE_PREFIX, version: 1 });
    const disposeTap = ctx.webServer.tapIndex((html) => {
      const snippet = `<script>window.__GARBAGE_MASTER__=${payload};</script>`;
      if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${snippet}</head>`);
      return `${snippet}${html}`;
    });

    return () => {
      disposed = true;
      try { if (typeof toolDisposer === 'function') toolDisposer(); } catch { /* 已释放 */ }
      toolDisposer = null;
      toolRegistered = false;
      disposeRoute();
      disposeTap();
      cancelScan();
    };
  });

  ctx.logger?.info?.(
    `[garbage-master] 就绪：目标 ${targets.map((t) => t.path).join(', ')}；规则 ${compiledRules.length} 条；状态目录 ${stateDir}；dryRun=${config.dryRun}`
  );
}

export { ROUTE_PREFIX };
export const __internal = { detectMountTargets, buildTargets, DEFAULTS };
