/**
 * GarbageMaster — 审计记录读取与清理。
 *
 * 审计是 append-only 的 JSONL（每次运行一个 `<planId>.jsonl`，含 intent / delete / result）。
 * 这里只做两件事：
 *  - `listAuditRuns`：把历史运行汇总成界面能直接展示的结构（谁、何时、删了什么、多少字节、成败）。
 *  - `pruneAudit`：按"保留最近 N 次"或"早于 N 天"清理文件，避免日志无限增长。
 *
 * 只读 + 删除自己的审计文件，不碰用户数据。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行/损坏行跳过 */ }
  }
  return out;
}

/**
 * 列出历史运行（新的在前）。
 * @param {object} params
 * @param {string} params.auditDir 审计目录
 * @param {number} [params.limit] 最多返回多少次运行
 */
export async function listAuditRuns({ auditDir, limit = 50 }) {
  let names = [];
  try {
    names = (await fsp.readdir(auditDir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    try {
      const st = await fsp.stat(path.join(auditDir, name));
      files.push({ name, mtime: st.mtimeMs, bytes: st.size });
    } catch { /* 读不到就跳过 */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const runs = [];
  for (const file of files.slice(0, Math.max(1, Math.min(500, limit)))) {
    let text = '';
    try { text = await fsp.readFile(path.join(auditDir, file.name), 'utf8'); } catch { continue; }
    const records = parseLines(text);
    const intent = records.find((r) => r.kind === 'intent') || null;
    const result = records.find((r) => r.kind === 'result') || null;
    const deletes = records.filter((r) => r.kind === 'delete');
    const packs = records.filter((r) => r.kind === 'pack');
    const tidies = records.filter((r) => r.kind === 'tidy');
    const report = (result && result.report) || {};
    runs.push({
      planId: file.name.replace(/\.jsonl$/, ''),
      at: intent && intent.createdAt ? intent.createdAt : new Date(file.mtime).toISOString(),
      sizeBytes: file.bytes,
      dryRun: Boolean(intent && intent.dryRun),
      targetId: intent ? intent.targetId || null : null,
      totals: (intent && intent.totals) || null,
      status: report.status || 'unknown',
      expectedBytes: typeof report.expectedBytes === 'number' ? report.expectedBytes : null,
      actualBytes: typeof report.actualBytes === 'number' ? report.actualBytes : null,
      diskFreeDelta: typeof report.diskFreeDelta === 'number' ? report.diskFreeDelta : null,
      failed: Array.isArray(report.failed) ? report.failed.length : (typeof report.failed === 'number' ? report.failed : 0),
      skipped: Array.isArray(report.skipped) ? report.skipped.length : (typeof report.skipped === 'number' ? report.skipped : 0),
      deletedCount: deletes.length,
      deleted: deletes.slice(0, 300).map((d) => ({
        path: d.path,
        bytes: d.bytes,
        actor: d.actor || null,
        ruleId: d.ruleId === undefined ? null : d.ruleId,
        at: d.at || null
      })),
      packs: packs.slice(0, 20).map((p) => ({ archive: (p.result && p.result.archive) || null, bytes: (p.result && p.result.bytes) || 0, ok: Boolean(p.result && p.result.ok) })),
      tidies: tidies.slice(0, 20).map((t) => ({ path: t.path, stats: t.stats || null }))
    });
  }
  return runs;
}

/**
 * 清理审计文件。
 * @param {object} params
 * @param {string} params.auditDir
 * @param {number} [params.keep] 保留最近多少次运行（<=0 表示不按次数保留）
 * @param {number} [params.olderThanDays] 删除早于多少天的运行（<=0 表示不按时间）
 * @returns {{removed:number, kept:number, removedFiles:string[]}}
 */
export async function pruneAudit({ auditDir, keep = 0, olderThanDays = 0 }) {
  let names = [];
  try {
    names = (await fsp.readdir(auditDir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { removed: 0, kept: 0, removedFiles: [] };
  }
  const files = [];
  for (const name of names) {
    try {
      const st = await fsp.stat(path.join(auditDir, name));
      files.push({ name, mtime: st.mtimeMs });
    } catch { /* 跳过 */ }
  }
  files.sort((a, b) => b.mtime - a.mtime); // 新 → 旧
  const keepCount = Number(keep) > 0 ? Math.floor(Number(keep)) : 0;
  const maxAgeMs = Number(olderThanDays) > 0 ? Number(olderThanDays) * 86400000 : 0;
  const now = Date.now();
  const removedFiles = [];
  files.forEach((file, index) => {
    const tooMany = keepCount > 0 && index >= keepCount;
    const tooOld = maxAgeMs > 0 && now - file.mtime > maxAgeMs;
    if (tooMany || tooOld) removedFiles.push(file.name);
  });
  for (const name of removedFiles) {
    try { await fsp.unlink(path.join(auditDir, name)); } catch { /* 已不存在 */ }
  }
  return { removed: removedFiles.length, kept: files.length - removedFiles.length, removedFiles };
}
