/**
 * GarbageMaster — 「整理」执行器：找出重复文件并报告。
 *
 * 语义（用户明确定义）：**不删除当前路径下的任何文件，只整理。**
 * 因此这里只做只读分析，产出"哪些文件内容重复、一共浪费了多少空间"，
 * 交由用户/后续阶段决定怎么处理（保留哪一份）。
 *
 * 算法：先按文件大小分桶（不同大小必然不重复，省掉绝大部分哈希），
 * 只对同尺寸且 ≥ 阈值的文件做 sha256 流式哈希，再按哈希分组。
 *
 * 全部有界：条目数、耗时都可配置，超限即停并标 truncated。
 */

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

function childPath(dir, name) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

async function hashFile(file) {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 在一个或多个目录里找重复文件。
 * @param {object} params
 * @param {string[]} params.roots 绝对路径（目录）
 * @param {number} [params.minBytes] 只考虑不小于该体积的文件（默认 1 MiB）
 * @param {number} [params.maxFiles] 最多统计多少个文件
 * @param {number} [params.maxMs] 时间上限
 * @param {AbortSignal} [params.signal]
 * @param {(p:object)=>void} [params.onProgress]
 */
export async function findDuplicates({ roots, minBytes = 1024 * 1024, maxFiles = 20000, maxMs = 60000, signal, onProgress }) {
  const started = Date.now();
  const list = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r.startsWith('/')) : [];
  const bySize = new Map();
  let files = 0;
  let bytes = 0;
  let denied = 0;
  let truncated = false;
  const stack = [...list];

  while (stack.length > 0) {
    if (signal && signal.aborted) { truncated = true; break; }
    if (files >= maxFiles || Date.now() - started > maxMs) { truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      denied += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = childPath(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      let st;
      try { st = await fsp.lstat(full); } catch { denied += 1; continue; }
      const size = Number(st.size) || 0;
      if (size < minBytes) continue;
      files += 1;
      bytes += size;
      if (!bySize.has(size)) bySize.set(size, []);
      bySize.get(size).push({ path: full, size, mtime: Math.floor(Number(st.mtimeMs) / 1000) });
      if (files % 200 === 0 && typeof onProgress === 'function') {
        onProgress({ files, bytes, dir, ms: Date.now() - started });
      }
    }
  }

  // 只对"同尺寸且不止一个"的文件做哈希
  const hashGroups = new Map();
  let hashed = 0;
  for (const [size, group] of bySize) {
    if (group.length < 2) continue;
    for (const item of group) {
      if (signal && signal.aborted) { truncated = true; break; }
      if (Date.now() - started > maxMs * 3) { truncated = true; break; }
      const digest = await hashFile(item.path);
      hashed += 1;
      if (!digest) continue;
      const key = `${size}:${digest}`;
      if (!hashGroups.has(key)) hashGroups.set(key, { size, digest, files: [] });
      hashGroups.get(key).files.push(item);
    }
  }

  const groups = [];
  for (const group of hashGroups.values()) {
    if (group.files.length < 2) continue;
    const wastedBytes = group.size * (group.files.length - 1);
    groups.push({
      hash: group.digest,
      size: group.size,
      count: group.files.length,
      wastedBytes,
      files: group.files.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime }))
    });
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes);

  return {
    roots: list,
    groups,
    stats: {
      files,
      bytes,
      hashed,
      denied,
      truncated,
      ms: Date.now() - started,
      groupCount: groups.length,
      wastedBytes: groups.reduce((sum, g) => sum + g.wastedBytes, 0)
    }
  };
}
