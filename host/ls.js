/**
 * GarbageMaster — 实时列目录与按需量体积。
 *
 * 为什么需要它：扫描树是**剪枝**过的（低于体积阈值的子目录会被折进 `others`），
 * 所以点进很深的目录时树里可能已经没有子项了。这时用这里的实时读取顶上，
 * 保证"当前位置"面板在任何深度都有内容，不用去开文件管理器。
 *
 * 关于目录体积的诚实处理：
 *   `lstat` 对目录只返回 inode 大小（通常 4096），**不是递归体积**。
 *   所以：
 *     - 能从上一步的扫描结果里查到的，就用查到的真实体积；
 *     - 查不到的目录，体积报 `null`（界面显示 `—`），需要时由用户点「量体积」
 *       触发 `measureDirectory()` —— 有界遍历，超限就标注 `truncated`，
 *       绝不让一次点击变成一个不知要跑多久的全盘遍历。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isUnder } from '../core/model.js';

const AUTO_ACTIONS = new Set(['unlink', 'archive']);

function childPath(dir, name) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/**
 * 从扫描树里收集"已知体积"表：保留节点的体积 + 被折进 others 的子目录体积。
 * 结果按 treeVersion 缓存在 scan 上，避免每次列目录都重走一遍。
 */
export function knownSizesOf(scan) {
  if (!scan || !scan.tree) return new Map();
  if (scan.__knownSizes && scan.__knownSizesVersion === scan.treeVersion) return scan.__knownSizes;
  const sizes = new Map();
  const walk = (node) => {
    sizes.set(node.path, node.size);
    for (const child of node.children || []) walk(child);
    for (const file of node.files || []) if (file && file.path) sizes.set(file.path, file.size);
    if (node.others && Array.isArray(node.others.items)) {
      for (const item of node.others.items) if (item && item.path) sizes.set(item.path, item.size);
    }
  };
  walk(scan.tree);
  scan.__knownSizes = sizes;
  scan.__knownSizesVersion = scan.treeVersion;
  return sizes;
}

function candidateSetOf(scan) {
  if (!scan || !Array.isArray(scan.candidates)) return new Set();
  if (scan.__candidateSet && scan.__candidateSetVersion === scan.treeVersion) return scan.__candidateSet;
  const set = new Set(scan.candidates.map((c) => c.path));
  scan.__candidateSet = set;
  scan.__candidateSetVersion = scan.treeVersion;
  return set;
}

/**
 * 列出目录内容。
 * @param {object} params
 * @param {string} params.dirPath 绝对路径
 * @param {number} [params.limit] 最大返回条数（超出标 truncated）
 * @param {(p:string, rules:Array)=>object} params.annotate 规则判定
 * @param {Array} params.rules 已编译规则包
 * @param {object} [params.scan] 该目标当前的扫描结果（用于补体积与标注"已是候选"）
 */
export async function listDirectory({ dirPath, limit = 300, annotate, rules, scan, context = null, explainLookup = null }) {
  // explainLookup(path) -> 已缓存的解释文本（或 null）；有它前端就不必为已解释过的路径再发请求
  let stat;
  try {
    stat = await fsp.lstat(dirPath);
  } catch (error) {
    return { path: dirPath, error: error.code === 'ENOENT' ? 'not-found' : (error.code || error.message), children: [], total: 0, truncated: false };
  }

  const self = annotate(dirPath, rules);
  const selfExplanation = typeof explainLookup === 'function' ? explainLookup(dirPath) : null;
  const base = {
    path: dirPath,
    isDir: stat.isDirectory(),
    risk: self.risk,
    action: self.action,
    note: self.note,
    remedy: self.remedy || null,
    ruleId: self.ruleId
  };

  if (!stat.isDirectory()) {
    return {
      ...base,
      size: Number(stat.size) || 0,
      sizeApprox: false,
      mtime: Math.floor(Number(stat.mtimeMs) / 1000),
      children: [],
      total: 0,
      truncated: false
    };
  }

  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    return { ...base, children: [], total: 0, truncated: false, error: error.code === 'EACCES' ? 'denied' : (error.code || error.message) };
  }

  const knownSizes = knownSizesOf(scan);
  const candidates = candidateSetOf(scan);

  const dirs = [];
  const files = [];
  let skippedSpecial = 0;

  for (const entry of entries) {
    const full = childPath(dirPath, entry.name);
    if (entry.isDirectory()) dirs.push({ name: entry.name, path: full, isDir: true, kind: 'dir' });
    else if (entry.isFile()) files.push({ name: entry.name, path: full, isDir: false, kind: 'file' });
    else skippedSpecial += 1; // 符号链接/设备/socket：不跟进
  }

  // 文件：批量 lstat 拿精确体积与时间
  for (let i = 0; i < files.length; i += 64) {
    const batch = files.slice(i, i + 64);
    const stats = await Promise.all(batch.map((f) => fsp.lstat(f.path).catch(() => null)));
    batch.forEach((file, index) => {
      const st = stats[index];
      if (st) {
        file.size = Number(st.size) || 0;
        file.mtime = Math.floor(Number(st.mtimeMs) / 1000);
        file.sizeApprox = false;
      } else {
        file.size = null;
        file.sizeApprox = false;
      }
    });
  }

  // 目录：优先用扫描时已经量好的真实体积；量不到就诚实报 null
  for (const dir of dirs) {
    const known = knownSizes.get(dir.path);
    if (typeof known === 'number') {
      dir.size = known;
      dir.sizeApprox = false;
      dir.sizeSource = 'scan';
    } else {
      dir.size = null;
      dir.sizeApprox = true;
      dir.sizeSource = 'unknown';
    }
  }

  const decorate = (item) => {
    const verdict = annotate(item.path, rules);
    // 未命中规则的子项不给说明：每条都重复同一句"未识别"只会变成噪音
    // （当前目录自身的说明另有上下文生成，见下方 note/noteKind）。
    const executable = AUTO_ACTIONS.has(verdict.action) && (verdict.risk === 'safe' || verdict.risk === 'caution');
    return {
      ...item,
      risk: verdict.risk,
      action: verdict.action,
      note: verdict.ruleId === null || verdict.ruleId === undefined ? '' : verdict.note,
      remedy: verdict.remedy || null,
      ruleId: verdict.ruleId,
      recursive: Boolean(verdict.recursive),
      executable,
      candidate: candidates.has(item.path),
      // 已解释过的直接带回来：前端不必再为空路径发请求，也就不会有"转圈"
      explanation: typeof explainLookup === 'function' ? explainLookup(item.path) : null
    };
  };

  const known = (v) => (typeof v === 'number' ? v : -1);
  dirs.sort((a, b) => known(b.size) - known(a.size) || a.name.localeCompare(b.name));
  files.sort((a, b) => known(b.size) - known(a.size) || a.name.localeCompare(b.name));

  const total = dirs.length + files.length;
  const merged = [...dirs, ...files];
  const limited = merged.slice(0, Math.max(1, Math.min(2000, limit)));

  const knownSelf = knownSizes.get(dirPath);
  const listedBytes = merged.reduce((sum, item) => sum + (typeof item.size === 'number' ? item.size : 0), 0);
  const selfSize = typeof knownSelf === 'number' ? knownSelf : (limited.length === total ? listedBytes : null);

  // 说明修正：没命中规则时，默认那条"未识别"会显得像出错。
  // 这里按上下文生成更有用的说明 —— 分区根讲清这是什么盘、本层讲清里面有什么。
  let note = base.note;
  let noteKind = 'rule';
  if (base.ruleId === null || base.ruleId === undefined) {
    noteKind = 'fallback';
    if (context && context.isTargetRoot) {
      noteKind = 'target-root';
      const usage = context.usage || null;
      const usedPct = usage && usage.total ? Math.round((usage.used / usage.total) * 100) : null;
      const freeText = usage && usage.free ? `${(usage.free / 1024 ** 3).toFixed(1)} G` : '未知';
      note = `这里是「${context.targetLabel || dirPath}」这个分区的根目录`
        + `${usage ? `，已用 ${usedPct}%，剩余 ${freeText}` : ''}。`
        + '下面列出的是它的各个顶级目录；点进具体目录（比如各类缓存、日志、软件数据）才能判断哪些可以清理。';
    } else if (dirs.length + files.length > 0) {
      note = `没有命中清理规则：可能是你自己放的文件，或者规则库还没收录的目录。`
        + `这一层有 ${dirs.length} 个目录、${files.length} 个文件`
        + `${selfSize ? `（合计 ${(selfSize / 1024 ** 2).toFixed(1)} MB）` : ''}。`
        + '展开看看内容再决定，不要整目录删除。';
    }
  }

  return {
    ...base,
    note,
    noteKind,
    explanation: typeof explainLookup === 'function' ? explainLookup(dirPath) : null,
    size: selfSize,
    sizeApprox: typeof knownSelf !== 'number',
    sizeSource: typeof knownSelf === 'number' ? 'scan' : 'listed',
    mtime: Math.floor(Number(stat.mtimeMs) / 1000),
    dirCount: dirs.length,
    fileCount: files.length,
    skippedSpecial,
    total,
    truncated: limited.length < total,
    children: limited.map(decorate)
  };
}

/**
 * 有界遍历量体积：给"体积未知"的目录用。
 * 超时或超条目即停并标 truncated —— 宁可给一个下限，也不让界面卡住。
 */
export async function measureDirectory({ dirPath, maxEntries = 40000, maxMs = 3000 }) {
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  let denied = 0;
  let truncated = false;
  const stack = [dirPath];

  while (stack.length > 0) {
    if (entries > maxEntries || Date.now() - started > maxMs) { truncated = true; break; }
    const dir = stack.pop();
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      denied += 1;
      continue;
    }
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const full = childPath(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) {
        try {
          const st = await fsp.lstat(full);
          bytes += Number(st.size) || 0;
          entries += 1;
        } catch { denied += 1; }
      }
    }
  }

  return { path: dirPath, bytes, entries, denied, truncated, ms: Date.now() - started };
}

export { isUnder, AUTO_ACTIONS };
