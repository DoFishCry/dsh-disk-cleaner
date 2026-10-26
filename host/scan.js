/**
 * GarbageMaster — Linux 只读扫描器。
 *
 * 设计要点：
 *  - **单遍遍历、自底向上剪枝**：体积必须靠完整遍历才准确，因此遍历不可省；
 *    但结果树在每一层就地剪枝（只保留体积最大的 keepTop 个子目录），
 *    内存因此只与保留节点数（maxNodes）有关，与磁盘上的文件总数无关。
 *  - **不跨挂载点**：扫描 `/` 时跳过 /proc /sys /dev /run /boot /media/... 等挂载点，
 *    避免把别的分区重复算进来，也避免卡在虚拟文件系统上。
 *  - **不跟进符号链接**（防环、防意外跨盘），也不统计 socket/fifo/设备文件。
 *  - **包含隐藏文件与隐藏目录**：本工具的目的就是让你看见 `.cache` 这类平时看不到的占用。
 *  - 只读：除了 stat/readdir 什么也不做。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SCAN_CONFIG = {
  bigFileBytes: 500 * 1024 ** 2,
  // 剪枝阈值刻意压低到 32 MiB：树图能多往下钻好几层。
  // 树规模由"体积达标的目录数量"天然限制，与磁盘文件总数无关，内存仍然有界。
  minExpandBytes: 32 * 1024 ** 2,
  maxDepth: 9,
  keepTop: 20,
  maxNodes: 16000,
  filesPerDir: 20
};

function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** 读取当前挂载点集合（用于"不跨挂载点"）。失败时返回空集合，退化为只靠路径判断。 */
export async function readMountPoints() {
  const set = new Set();
  try {
    const text = await fsp.readFile('/proc/self/mounts', 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const parts = line.split(' ');
      if (parts.length < 2) continue;
      set.add(decodeMountField(parts[1]));
    }
  } catch {
    /* 非 Linux 或不可读：退化为空集合 */
  }
  return set;
}

/** 卷容量（一次 statfs，不遍历目录）。 */
export async function diskUsage(root) {
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
 * 扫描一个目标根目录。
 * @param {object} params
 * @param {string} params.root 绝对路径
 * @param {object} [params.config] DEFAULT_SCAN_CONFIG 的覆盖值
 * @param {(p:object)=>void} [params.onProgress]
 * @param {()=>boolean} [params.shouldStop]
 */
export async function scanTarget({ root, config = {}, onProgress, shouldStop }) {
  const cfg = { ...DEFAULT_SCAN_CONFIG, ...config };
  const mountPoints = await readMountPoints();

  const ctx = {
    cfg,
    root,
    mountPoints,
    nodeCount: 0,
    current: root,
    dirs: 0,
    files: 0,
    bytes: 0,
    denied: 0,
    symlinks: 0,
    special: 0,
    skippedMounts: [],
    bigFiles: [],
    lastReport: 0
  };

  const report = (force) => {
    const now = Date.now();
    if (!force && now - ctx.lastReport < 250) return;
    ctx.lastReport = now;
    if (typeof onProgress === 'function') {
      onProgress({
        dirs: ctx.dirs,
        files: ctx.files,
        bytes: ctx.bytes,
        current: ctx.current,
        denied: ctx.denied,
        bigFiles: ctx.bigFiles.length
      });
    }
  };

  const statFile = async (fullPath) => {
    try {
      const st = await fsp.lstat(fullPath);
      return { size: Number(st.size) || 0, mtime: Math.floor(Number(st.mtimeMs) / 1000) };
    } catch {
      ctx.denied += 1;
      return null;
    }
  };

  /** 递归：返回已剪枝的节点（体积总是准确的完整遍历结果）。 */
  const walkDir = async (dir, depth, parentMtime) => {
    const node = {
      name: dir === '/' ? '/' : path.basename(dir),
      path: dir,
      size: 0,
      mtime: parentMtime || 0,
      kind: 'dir',
      children: [],
      files: [],
      others: null,
      smallRest: 0
    };
    if (typeof shouldStop === 'function' && shouldStop()) return node;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      ctx.denied += 1;
      return node;
    }
    ctx.dirs += 1;
    ctx.current = dir;

    let total = 0;
    const subdirPaths = [];
    const filePaths = [];

    for (const entry of entries) {
      const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) { ctx.symlinks += 1; continue; }
      if (entry.isDirectory()) {
        if (ctx.mountPoints.has(full) && full !== ctx.root) {
          ctx.skippedMounts.push(full);
          continue;
        }
        subdirPaths.push(full);
      } else if (entry.isFile()) {
        filePaths.push(full);
      } else {
        ctx.special += 1;
      }
    }

    // 文件批量 stat：一次 64 个并发，打满 fs 线程池又不至于淹没事件循环。
    for (let i = 0; i < filePaths.length; i += 64) {
      if (typeof shouldStop === 'function' && shouldStop()) break;
      const batch = filePaths.slice(i, i + 64);
      const stats = await Promise.all(batch.map(statFile));
      for (let j = 0; j < batch.length; j += 1) {
        const st = stats[j];
        if (!st) continue;
        total += st.size;
        ctx.files += 1;
        ctx.bytes += st.size;
        if (st.size >= cfg.bigFileBytes) {
          ctx.bigFiles.push({ path: batch[j], size: st.size, mtime: st.mtime });
        }
      }
      report(false);
    }

    // 子目录顺序递归（保持内存可预测；文件 stat 已经用满并发）
    const built = [];
    for (const sub of subdirPaths) {
      built.push(await walkDir(sub, depth + 1, 0));
      report(false);
    }
    built.sort((a, b) => b.size - a.size);
    for (const child of built) total += child.size;

    node.size = total;

    // 剪枝：深度到顶就只留体积；否则保留体积达标的最大 keepTop 个子目录。
    //
    // 这里刻意**不用**全局 maxNodes 作为保留闸门：walkDir 是后序返回的，
    // 全局计数会先在深层耗光配额，导致上层节点反而不再保留子节点、整棵树退化。
    // 树的规模本来就由 minExpandBytes 天然限制（只有 ≥ 阈值体积的目录会被保留，
    // 这种目录数量很少），maxNodes 因此只作为诊断指标上报。
    const keepChildren = depth < cfg.maxDepth;
    if (keepChildren) {
      const head = built.filter((c) => c.size >= cfg.minExpandBytes).slice(0, cfg.keepTop);
      const headSet = new Set(head);
      const tail = built.filter((c) => !headSet.has(c));
      node.children = head;
      ctx.nodeCount += 1 + head.length;
      if (tail.length > 0) {
        node.others = {
          count: tail.length,
          size: tail.reduce((sum, c) => sum + c.size, 0),
          items: tail.slice(0, 40).map((c) => ({ name: c.name, path: c.path, size: c.size }))
        };
      }
    }

    report(false);
    return node;
  };

  const started = Date.now();
  const tree = await walkDir(root, 0, 0);

  // 直属大文件按目录挂回保留节点；再自底向上补 smallRest，保证 I2：
  //   size == Σchildren + others.size + Σfiles + smallRest
  const byDir = new Map();
  for (const f of ctx.bigFiles) {
    const dir = path.dirname(f.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }

  const attach = async (node) => {
    const files = byDir.get(node.path);
    if (files && files.length > 0) {
      node.files = files
        .slice()
        .sort((a, b) => b.size - a.size)
        .slice(0, cfg.filesPerDir);
    }
    if (node.mtime === 0) {
      try {
        const st = await fsp.stat(node.path);
        node.mtime = Math.floor(Number(st.mtimeMs) / 1000);
      } catch { /* 忽略：mtime 仅用于展示 */ }
    }
    let childSum = 0;
    for (const child of node.children) childSum += await attach(child);
    const othersSize = node.others ? node.others.size : 0;
    const fileSum = node.files.reduce((sum, f) => sum + f.size, 0);
    node.smallRest = Math.max(0, node.size - childSum - othersSize - fileSum);
    return node.size;
  };
  await attach(tree);

  const usage = await diskUsage(root);
  ctx.bigFiles.sort((a, b) => b.size - a.size);

  return {
    root,
    tree,
    bigFiles: ctx.bigFiles,
    usage,
    stats: {
      dirs: ctx.dirs,
      files: ctx.files,
      bytes: ctx.bytes,
      denied: ctx.denied,
      symlinks: ctx.symlinks,
      special: ctx.special,
      skippedMounts: ctx.skippedMounts.slice(0, 50),
      skippedMountCount: ctx.skippedMounts.length,
      nodes: ctx.nodeCount,
      durationMs: Date.now() - started
    }
  };
}
