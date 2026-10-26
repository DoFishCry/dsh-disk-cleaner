/**
 * GarbageMaster — 计划构建与执行（分片 + 路径租约 + 审计 + dry-run）。
 *
 * 与设计文档的对应关系：
 *  - §9.2 分片装箱；§9.3 租约强制；§11 L1–L4 四层护栏；§10 删除后增量更新。
 *  - 本版本用**进程内 worker 池**充当执行者（actor = pool-worker-N）；
 *    若调用来自派发的 teammate，则记为 `<teammate>/pool-worker-N`，这样审计里既能看出
 *    "哪个工号落的盘"，也能看出"哪个执行者被授权做的"。
 *    团队版（Agent Teams）在 M4 接入时会复用**同一套** lease 校验与审计代码路径，
 *    因为"谁在执行"不该改变"能不能删"的判定。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyDeletion, isProtected, isUnder } from '../core/model.js';
import { detectUninstall } from '../core/uninstall.js';

const AUTO_ACTIONS = new Set(['unlink', 'archive']);
const CONFIRM_TTL_MS = 5 * 60 * 1000;

function newId(prefix) {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

/** 有限并发映射。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 租约互斥断言（不变式 I1）：任意两个租约路径不得互为前缀。
 * 排序后只需比较相邻项即可覆盖全部包含关系。
 */
export function assertDisjointLeases(leasePaths) {
  const sorted = leasePaths.slice().sort();
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur === prev || isUnder(cur, prev)) return { ok: false, conflict: [prev, cur] };
  }
  return { ok: true, conflict: null };
}

/** 三种操作模式；UI 与执行器共用。 */
export const MODES = {
  clean: { id: 'clean', label: '清理', deletesFiles: true },
  pack: { id: 'pack', label: '打包', deletesFiles: false },
  tidy: { id: 'tidy', label: '整理', deletesFiles: false }
};

function normalizeMode(mode) {
  return mode === 'pack' || mode === 'tidy' ? mode : 'clean';
}

/**
 * 判断一条处置是否会要求"重启/重登"之类的中断。
 * 依据：规则里显式的 requiresRestart，或官方命令/说明里出现重启类关键词。
 * 这类任务在计划里**一律排到最后**，并且必须在界面上提前说明。
 */
export function requiresRestart(item) {
  if (item && item.requiresRestart === true) return true;
  const haystack = `${(item && item.remedy && item.remedy.command) || ''} ${(item && item.remedy && item.remedy.why) || ''} ${(item && item.note) || ''}`;
  return /(reboot|restart|重启|重新登录|重新登陆|注销|log ?out|wsl --shutdown|systemctl restart)/i.test(haystack);
}

/**
 * 构建计划。所有 totals 由服务端重算，绝不相信页面传来的体积。
 * @returns {{ok:boolean, plan?:object, error?:string}}
 */
export function buildPlan(store, {
  targetId,
  selection = [],
  extraPaths = [],
  items: requestedItems,
  includeRecursive = false,
  protectedPaths = [],
  annotate,
  compiledRules
}) {
  const scan = store.scans.get(targetId);
  if (!scan || scan.status !== 'complete') return { ok: false, error: '该目标尚未完成扫描' };

  // 每种"用户选择"的元信息：操作模式（清除/打包/整理）与该条的特殊要求
  const META = new Map();
  const requested = [];
  if (Array.isArray(requestedItems)) {
    for (const entry of requestedItems) {
      if (!entry || typeof entry.path !== 'string') continue;
      META.set(entry.path, { mode: normalizeMode(entry.mode), special: String(entry.special || '').slice(0, 2000) });
      requested.push(entry.path);
    }
  }
  const selectionList = requested.length > 0 ? requested : [...selection, ...extraPaths];

  const byPath = new Map((scan.candidates || []).map((c) => [c.path, c]));
  const skipped = [];
  const accepted = [];
  const uninstallHints = [];

  const consider = (rawPath, source) => {
    if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) {
      skipped.push({ path: String(rawPath), reason: 'not-absolute' });
      return;
    }
    if (!isUnder(rawPath, scan.root)) {
      skipped.push({ path: rawPath, reason: 'outside-target' });
      return;
    }
    const hit = isProtected(rawPath, protectedPaths);
    if (hit) {
      skipped.push({ path: rawPath, reason: 'protected' });
      return;
    }
    const meta = META.get(rawPath) || { mode: 'clean', special: '' };
    const candidate = byPath.get(rawPath);
    const verdict = candidate || { ...annotate(rawPath, compiledRules), size: 0 };
    const risk = verdict.risk;
    const action = verdict.action;

    // 打包与整理都**不删除**文件，因此不要求"可执行删除"的规则授权；
    // 但系统禁区（blocked）永远不参与任何自动操作。
    if (risk === 'blocked') { skipped.push({ path: rawPath, reason: 'blocked' }); return; }
    if (meta.mode === 'clean') {
      if (risk === 'keep') { skipped.push({ path: rawPath, reason: 'keep' }); return; }
      // 应用 / 运行时环境优先判：删目录会留下坏状态，正确做法是卸载。
      // 这一步必须排在"规则是否允许直接删"之前 —— 很多应用目录根本没命中规则（默认 manual），
      // 如果先按 manual 拒绝，就永远走不到卸载建议。
      const uninstall = detectUninstall(rawPath);
      if (uninstall) {
        uninstallHints.push({ path: rawPath, size: Number(candidate ? candidate.size : 0) || 0, ...uninstall });
        return;
      }
      if (!AUTO_ACTIONS.has(action)) { skipped.push({ path: rawPath, reason: `manual-action:${action}` }); return; }
    }

    const size = Number(candidate ? candidate.size : 0) || 0;
    accepted.push({
      path: rawPath,
      size,
      risk,
      action,
      mode: meta.mode,
      special: meta.special,
      note: verdict.note || '',
      remedy: verdict.remedy || null,
      ruleId: verdict.ruleId === undefined ? null : verdict.ruleId,
      source,
      candidateId: candidate ? candidate.id : null,
      kind: candidate ? candidate.kind : 'unknown'
    });
  };

  for (const p of selectionList) consider(p, byPath.has(p) ? 'rule' : 'user');

  // 去重
  const unique = new Map();
  for (const item of accepted) if (!unique.has(item.path)) unique.set(item.path, item);
  let items = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));

  // 移除被祖先覆盖的子项：既避免重复计数，也保证租约前缀互斥（I1）
  const covered = new Set();
  for (let i = 0; i < items.length; i += 1) {
    for (let j = 0; j < items.length; j += 1) {
      if (i === j) continue;
      if (isUnder(items[i].path, items[j].path) && items[i].path !== items[j].path) {
        covered.add(i);
        break;
      }
    }
  }
  if (covered.size > 0) {
    items.forEach((item, i) => {
      if (covered.has(i)) skipped.push({ path: item.path, reason: 'covered-by-parent' });
    });
    items = items.filter((_, i) => !covered.has(i));
  }

  // 目录项的处理：
  //   清除 —— 必须由用户显式确认"包含子项"，否则跳过（递归删除不可逆）
  //   打包 —— 本来就是对整棵子树打包，直接 recursive
  //   整理 —— 只读扫描 + 去重，不删任何文件，直接 recursive
  const planItems = [];
  for (const item of items) {
    // kind='dir' 是明确的目录候选；'unknown' 表示用户手动加的路径、当时不知道类型，
    // 保守当成文件处理，由执行器 lstat 后再决定（目录且未授权递归时会跳过并记原因）。
    const isDir = item.kind === 'dir';
    if (item.mode === 'clean') {
      if (isDir && !includeRecursive) {
        skipped.push({ path: item.path, reason: 'need-recursive' });
        continue;
      }
      planItems.push({ ...item, recursive: Boolean(isDir && includeRecursive) });
    } else {
      planItems.push({ ...item, recursive: item.kind !== 'file' });
    }
  }

  const leases = planItems.map((i) => i.path);
  const disjoint = assertDisjointLeases(leases);
  if (!disjoint.ok) {
    return { ok: false, error: `内部错误：租约互斥断言失败（${disjoint.conflict.join(' ⊂ ')}）` };
  }

  // 三种操作分开编组：同一类操作放一起，不逐个路径分别进行。
  // 需要重启/重登的任务一律挑出来排到最后，并在计划里显式标注。
  const restartItems = planItems.filter((item) => requiresRestart(item));
  const normalItems = planItems.filter((item) => !requiresRestart(item));
  const groups = ['clean', 'pack', 'tidy'].map((mode) => {
    const groupItems = normalItems.filter((item) => item.mode === mode);
    return {
      mode,
      label: MODES[mode].label,
      deletesFiles: MODES[mode].deletesFiles,
      itemCount: groupItems.length,
      bytes: groupItems.reduce((sum, i) => sum + i.size, 0),
      items: groupItems
    };
  }).filter((group) => group.itemCount > 0);
  if (restartItems.length > 0) {
    groups.push({
      mode: 'restart',
      label: '需要重启 / 重新登录后再做',
      deletesFiles: restartItems.some((i) => i.mode === 'clean'),
      itemCount: restartItems.length,
      bytes: restartItems.reduce((sum, i) => sum + i.size, 0),
      items: restartItems,
      note: '这些操作会影响正在运行的服务或需要重启才生效，因此排在最后执行。执行前请先保存工作。'
    });
  }

  // 三种模式都已接入执行器；唯一留待后续的是"需要重启"的条目
  // （它们要用户先保存工作，且必须排到最后，绝不与其它操作混在一批里）。
  const executableNow = planItems.filter((item) => !requiresRestart(item));
  const pending = planItems.filter((item) => requiresRestart(item))
    .map((item) => ({ path: item.path, mode: item.mode, size: item.size, reason: 'needs-restart' }));

  const plan = {
    id: newId('plan'),
    targetId,
    createdAt: Date.now(),
    confirmToken: randomBytes(16).toString('hex'),
    expiresAt: Date.now() + CONFIRM_TTL_MS,
    status: 'planned',
    includeRecursive: Boolean(includeRecursive),
    items: planItems,
    executableItems: executableNow,
    groups,
    pending,
    uninstall: uninstallHints,
    restartCount: restartItems.length,
    skipped,
    totals: {
      count: planItems.length,
      bytes: planItems.reduce((sum, i) => sum + i.size, 0),
      cleanCount: planItems.filter((i) => i.mode === 'clean').length,
      packCount: planItems.filter((i) => i.mode === 'pack').length,
      tidyCount: planItems.filter((i) => i.mode === 'tidy').length,
      restartCount: restartItems.length,
      dirCount: planItems.filter((i) => i.recursive).length,
      fileCount: planItems.filter((i) => !i.recursive).length,
      userPicked: planItems.filter((i) => i.source === 'user').length,
      uninstallCount: uninstallHints.length
    }
  };
  store.plans.set(plan.id, plan);
  store.emit('plan-created', { planId: plan.id, targetId, totals: plan.totals, skippedCount: skipped.length });
  return { ok: true, plan };
}

async function auditAppend(auditFile, record) {
  const line = `${JSON.stringify(record)}\n`;
  const handle = await fsp.open(auditFile, 'a');
  try {
    await handle.write(line);
    await handle.sync(); // 删除前先落盘：崩在中途也能知道原计划删什么
  } finally {
    await handle.close();
  }
}

/**
 * 执行计划。
 * @returns {Promise<object>} RunReport
 */
/** 审计里的执行者名字：派发来的时候带上 teammate 名，方便事后追责。 */
export function actorName(actorLabel, workerId) {
  return actorLabel ? `${actorLabel}/${workerId}` : workerId;
}

export async function executePlan({ store, plan, protectedPaths = [], auditDir, config, modes = null, actorLabel = null }) {
  if (store.run && store.run.status === 'running') {
    return { ok: false, error: '已有一次清理正在运行' };
  }
  if (Date.now() > plan.expiresAt) return { ok: false, error: '确认已过期，请重新提交' };
  // modes 用于"按操作类别分批执行"：派发给智能体时，一个执行者只跑一类。
  const allRunnable = Array.isArray(plan.executableItems) ? plan.executableItems : plan.items;
  const runItems = Array.isArray(modes) && modes.length > 0
    ? allRunnable.filter((item) => modes.includes(item.mode))
    : allRunnable;
  if (runItems.length === 0) {
    const pendingCount = (plan.pending || []).length;
    return { ok: false, error: pendingCount > 0 ? '这个计划里只剩需要重启的任务，请先保存工作，稍后单独执行' : '计划里没有可执行的条目' };
  }
  const cleanItems = runItems.filter((item) => item.mode === 'clean');
  const packItems = runItems.filter((item) => item.mode === 'pack');
  const tidyItems = runItems.filter((item) => item.mode === 'tidy');

  const scan = store.scans.get(plan.targetId);
  const dryRun = Boolean(config.dryRun);
  const workers = Math.max(1, Math.min(6, Number(config.workers) || 3));

  // 分片：按"目标根之下的一级目录"聚合（同盘、同热点的项尽量同片），再按体积均衡装箱
  const groups = new Map();
  for (const item of cleanItems) {
    const rel = item.path.slice(scan.root.length).replace(/^\//, '');
    const topKey = rel.split('/')[0] || item.path;
    if (!groups.has(topKey)) groups.set(topKey, []);
    groups.get(topKey).push(item);
  }
  const groupList = [...groups.entries()].map(([key, groupItems]) => ({
    key,
    items: groupItems,
    bytes: groupItems.reduce((sum, i) => sum + i.size, 0)
  })).sort((a, b) => b.bytes - a.bytes);

  const shardCount = Math.max(1, Math.min(workers, groupList.length));
  const shards = new Array(shardCount).fill(null).map((_, i) => ({
    shardId: `shard-${i + 1}`,
    items: [],
    bytes: 0,
    lease: [],
    status: 'pending',
    freedBytes: 0
  }));
  for (const group of groupList) {
    let target = shards[0];
    for (const shard of shards) if (shard.bytes < target.bytes) target = shard;
    target.items.push(...group.items);
    target.bytes += group.bytes;
    target.lease.push(...group.items.map((i) => i.path));
  }
  const activeShards = shards.filter((s) => s.items.length > 0);

  const leaseCheck = assertDisjointLeases(activeShards.flatMap((s) => s.lease));
  if (!leaseCheck.ok) return { ok: false, error: `内部错误：分片租约冲突（${leaseCheck.conflict.join(' ⊂ ')}）` };
  // 每个分片自身的租约也必须互斥
  for (const shard of activeShards) {
    const own = assertDisjointLeases(shard.lease);
    if (!own.ok) return { ok: false, error: `内部错误：分片 ${shard.shardId} 内部租约冲突` };
  }

  const auditFile = path.join(auditDir, `${plan.id}.jsonl`);
  const run = {
    planId: plan.id,
    status: 'running',
    dryRun,
    startedAt: Date.now(),
    endedAt: null,
    cancelRequested: false,
    freedBytes: 0,
    totals: plan.totals,
    shards: activeShards,
    deleted: [],
    failed: [],
    pack: null,
    tidy: null,
    skipped: [...plan.skipped],
    diskFreeBefore: scan.usage ? scan.usage.free : 0,
    diskFreeAfter: null,
    report: null
  };
  store.run = run;

  await auditAppend(auditFile, {
    kind: 'intent',
    planId: plan.id,
    targetId: plan.targetId,
    dryRun,
    createdAt: new Date().toISOString(),
    totals: plan.totals,
    shards: activeShards.map((s) => ({ shardId: s.shardId, lease: s.lease, itemCount: s.items.length, bytes: s.bytes }))
  });

  store.emit('run-started', {
    planId: plan.id,
    dryRun,
    totals: plan.totals,
    shards: activeShards.map((s) => ({ shardId: s.shardId, lease: s.lease, itemCount: s.items.length, estBytes: s.bytes }))
  });

  const leaseCovers = (shard, itemPath) => shard.lease.some((p) => isUnder(itemPath, p));

  // ── 打包：把所有 pack 条目压进**一个**归档（用户定义：默认不删原文件）
  if (packItems.length > 0) {
    store.emit('pack-started', { planId: plan.id, itemCount: packItems.length, bytes: packItems.reduce((sum, i) => sum + i.size, 0) });
    const { packPaths } = await import('./archive.js');
    const archivesDir = config.archivesDir || `${auditDir.replace(/\/audit$/, '')}/archives`;
    const result = await packPaths({
      paths: packItems.map((i) => i.path),
      destDir: archivesDir,
      label: 'garbage-master',
      excludeDir: config.stateDir || null,
      timeoutMs: Math.max(60000, Number(config.packTimeoutMs) || 600000)
    });
    run.pack = result;
    try {
      await auditAppend(auditFile, {
        kind: 'pack', planId: plan.id, at: new Date().toISOString(),
        paths: packItems.map((i) => i.path),
        result: { ok: result.ok, archive: result.archive || null, bytes: result.bytes || 0, entries: result.entries || 0, error: result.error || null }
      });
    } catch { /* 审计失败不阻断：结果仍会进报告 */ }
    store.emit('pack-done', {
      planId: plan.id, ok: result.ok, archive: result.archive || null,
      bytes: result.bytes || 0, entries: result.entries || 0, error: result.error || null
    });
  }

  await mapLimit(activeShards, workers, async (shard, index) => {
    const workerId = `pool-worker-${index + 1}`;
    const actor = actorName(actorLabel, workerId);
    shard.status = 'running';
    store.emit('shard-started', { planId: plan.id, shardId: shard.shardId, actor, itemCount: shard.items.length, estBytes: shard.bytes });

    for (const item of shard.items) {
      if (run.cancelRequested) { shard.status = 'cancelled'; break; }

      // ── 租约强制：这一层与提示词无关，越界即拒绝 ──────────────────
      if (!leaseCovers(shard, item.path)) {
        const reason = 'lease-violation';
        run.failed.push({ path: item.path, reason, shardId: shard.shardId });
        store.emit('item-failed', { planId: plan.id, shardId: shard.shardId, path: item.path, reason });
        continue;
      }
      if (isProtected(item.path, protectedPaths)) {
        run.skipped.push({ path: item.path, reason: 'protected' });
        store.emit('item-skipped', { planId: plan.id, shardId: shard.shardId, path: item.path, reason: 'protected' });
        continue;
      }

      let st;
      try {
        st = await fsp.lstat(item.path);
      } catch {
        run.skipped.push({ path: item.path, reason: 'gone' });
        store.emit('item-skipped', { planId: plan.id, shardId: shard.shardId, path: item.path, reason: 'gone' });
        continue;
      }
      if (st.isSymbolicLink()) {
        // 只删链接本身，绝不跟进目标
      } else if (st.isDirectory()) {
        if (!item.recursive) {
          run.skipped.push({ path: item.path, reason: 'need-recursive' });
          store.emit('item-skipped', { planId: plan.id, shardId: shard.shardId, path: item.path, reason: 'need-recursive' });
          continue;
        }
      } else if (Math.abs((Number(st.size) || 0) - item.size) > 0) {
        // 计划制定后体积变了：保守跳过，让你重新审视
        run.skipped.push({ path: item.path, reason: 'changed' });
        store.emit('item-skipped', { planId: plan.id, shardId: shard.shardId, path: item.path, reason: 'changed' });
        continue;
      }

      const record = {
        kind: 'delete',
        planId: plan.id,
        shardId: shard.shardId,
        actor,
        at: new Date().toISOString(),
        path: item.path,
        bytes: item.size,
        risk: item.risk,
        action: item.action,
        ruleId: item.ruleId,
        source: item.source,
        dryRun
      };
      try {
        await auditAppend(auditFile, record);
      } catch (error) {
        run.failed.push({ path: item.path, reason: `audit-failed:${error.message}`, shardId: shard.shardId });
        store.emit('item-failed', { planId: plan.id, shardId: shard.shardId, path: item.path, reason: 'audit-failed' });
        continue;
      }

      if (dryRun) {
        shard.freedBytes += item.size;
        run.freedBytes += item.size;
        run.deleted.push({ path: item.path, bytes: item.size, shardId: shard.shardId, dryRun: true });
        store.emit('item-deleted', { planId: plan.id, shardId: shard.shardId, path: item.path, bytes: item.size, freedTotal: run.freedBytes, dryRun: true });
        continue;
      }

      try {
        if (st.isDirectory()) await fsp.rm(item.path, { recursive: true, force: false });
        else await fsp.unlink(item.path);

        shard.freedBytes += item.size;
        run.freedBytes += item.size;
        run.deleted.push({ path: item.path, bytes: item.size, shardId: shard.shardId, dryRun: false });

        // §10.2：删除后做增量更新（O(树深)），界面据此实时减树
        if (scan && scan.tree && scan.index) {
          applyDeletion(scan.tree, scan.index, item.path);
          if (scan.candidates) {
            const at = scan.candidates.findIndex((c) => c.path === item.path);
            if (at >= 0) scan.candidates.splice(at, 1);
          }
          scan.treeVersion = (scan.treeVersion || 0) + 1;
        }
        store.emit('item-deleted', { planId: plan.id, shardId: shard.shardId, path: item.path, bytes: item.size, freedTotal: run.freedBytes, dryRun: false });
      } catch (error) {
        run.failed.push({ path: item.path, reason: error.code || error.message, shardId: shard.shardId });
        store.emit('item-failed', { planId: plan.id, shardId: shard.shardId, path: item.path, reason: error.code || error.message });
      }
    }

    if (shard.status === 'running') shard.status = 'done';
    // §10.3：每个分片结束时只做一次廉价容量查询（一次 statfs，不遍历目录）
    const { diskUsage } = await import('./scan.js');
    const usage = scan ? await diskUsage(scan.root) : { free: 0 };
    store.emit('shard-done', {
      planId: plan.id,
      shardId: shard.shardId,
      verifiedBytes: shard.freedBytes,
      diskFree: usage.free
    });
  });

  // ── 整理：只读扫描重复文件，**不删除任何文件**
  if (tidyItems.length > 0) {
    const { findDuplicates } = await import('./tidy.js');
    const results = [];
    for (const item of tidyItems) {
      if (run.cancelRequested) break;
      store.emit('tidy-started', { planId: plan.id, path: item.path });
      const out = await findDuplicates({
        roots: [item.path],
        minBytes: Number(config.tidyMinBytes) || 1024 * 1024,
        maxFiles: Number(config.tidyMaxFiles) || 20000,
        maxMs: Number(config.tidyMaxMs) || 60000,
        onProgress: (progress) => store.emit('tidy-progress', { planId: plan.id, path: item.path, files: progress.files })
      });
      results.push({ path: item.path, stats: out.stats, groups: out.groups.slice(0, 100) });
      try {
        await auditAppend(auditFile, { kind: 'tidy', planId: plan.id, at: new Date().toISOString(), path: item.path, stats: out.stats });
      } catch { /* 同上 */ }
      store.emit('tidy-done', { planId: plan.id, path: item.path, stats: out.stats });
    }
    run.tidy = results;
  }

  run.status = run.cancelRequested ? 'cancelled' : 'complete';
  run.endedAt = Date.now();
  try {
    const { diskUsage } = await import('./scan.js');
    const usage = scan ? await diskUsage(scan.root) : { free: 0 };
    run.diskFreeAfter = usage.free;
  } catch { run.diskFreeAfter = null; }

  const report = {
    planId: plan.id,
    dryRun,
    status: run.status,
    expectedBytes: cleanItems.reduce((sum, i) => sum + i.size, 0),
    actualBytes: run.freedBytes,
    diskFreeBefore: run.diskFreeBefore,
    diskFreeAfter: run.diskFreeAfter,
    diskFreeDelta: run.diskFreeAfter != null ? run.diskFreeAfter - run.diskFreeBefore : null,
    deleted: run.deleted,
    failed: run.failed,
    skipped: run.skipped,
    pack: run.pack || null,
    tidy: run.tidy || null,
    shards: activeShards.map((s) => ({ shardId: s.shardId, status: s.status, itemCount: s.items.length, freedBytes: s.freedBytes, lease: s.lease })),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.endedAt - run.startedAt,
    auditFile
  };
  run.report = report;
  plan.status = run.status;

  await auditAppend(auditFile, { kind: 'result', planId: plan.id, at: new Date().toISOString(), report: {
    status: report.status, expectedBytes: report.expectedBytes, actualBytes: report.actualBytes,
    diskFreeDelta: report.diskFreeDelta, failed: report.failed.length, skipped: report.skipped.length
  } });

  store.emit('run-done', { planId: plan.id, report });
  return { ok: true, report };
}
