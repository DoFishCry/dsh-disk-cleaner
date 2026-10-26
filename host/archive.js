/**
 * GarbageMaster — 「打包」执行器：把用户选中的路径压缩成一个归档文件。
 *
 * 语义（用户定义）：**默认不删除原文件**，只生成一个压缩包。
 * 因此这里只做三件事：调 tar 打包 → 校验归档能列出内容 → 返回体积与条目数。
 *
 * 安全要点：
 *  - 用 `spawn(command, args[])`，**不经 shell**，路径里的空格/引号/`$()` 都不会被解释。
 *  - 用 `tar -C /` + 相对路径，避免归档里出现绝对路径（恢复时不会被写到系统目录）。
 *  - 显式 `--exclude` 掉状态目录与本归档自身，否则打包家目录时会把归档自己打进去。
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

function run(command, args, { timeoutMs = 600000, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, Math.max(1000, timeoutMs));
    const onAbort = () => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); if (stdout.length > 1_000_000) stdout = stdout.slice(-200_000); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把若干路径打包成一个 .tar.gz。
 * @param {object} params
 * @param {string[]} params.paths 绝对路径（可以多个，也可以是同一目录的不同子项）
 * @param {string} params.destDir 归档输出目录
 * @param {string} [params.label] 文件名里的标签
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @param {string} [params.excludeDir] 额外排除的目录（一般是插件的状态目录）
 */
export async function packPaths({ paths, destDir, label = 'pack', timeoutMs = 600000, signal, excludeDir }) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.startsWith('/')) : [];
  if (list.length === 0) return { ok: false, error: '没有可打包的路径' };

  await fsp.mkdir(destDir, { recursive: true });
  const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'pack';
  const archive = path.join(destDir, `${safeLabel}-${stamp()}.tar.gz`);

  const args = ['-czf', archive, '-C', '/'];
  if (excludeDir && excludeDir.startsWith('/')) args.push(`--exclude=${excludeDir.slice(1)}`);
  args.push(`--exclude=${archive.replace(/^\//, '')}`);
  // 用相对路径进归档：恢复时不会往绝对位置铺开
  for (const p of list) args.push(p.replace(/^\//, '').replace(/\/+$/, ''));

  const started = Date.now();
  const result = await run('tar', args, { timeoutMs, signal });
  const ms = Date.now() - started;

  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      error: result.timedOut ? '打包超时（已中止）' : `tar 失败（退出码 ${result.code}）`,
      stderr: result.stderr.slice(-2000),
      ms
    };
  }

  let bytes = 0;
  try {
    const st = await fsp.stat(archive);
    bytes = Number(st.size) || 0;
  } catch { /* 下面会按失败处理 */ }
  if (bytes <= 0) return { ok: false, error: '归档文件没有生成或为空', archive, ms };

  const listed = await run('tar', ['-tzf', archive], { timeoutMs: Math.min(120000, timeoutMs) });
  const entries = listed.code === 0 ? listed.stdout.split('\n').filter(Boolean).length : 0;

  return { ok: true, archive, bytes, entries, ms, sourceCount: list.length };
}

/** 列出归档内容（用于事后核对）。 */
export async function listArchive(archive, { limit = 200 } = {}) {
  if (typeof archive !== 'string' || !archive.startsWith('/')) return { ok: false, error: '归档路径不合法' };
  const listed = await run('tar', ['-tzf', archive], { timeoutMs: 120000 });
  if (listed.code !== 0) return { ok: false, error: '无法读取归档', stderr: listed.stderr.slice(-1000) };
  const all = listed.stdout.split('\n').filter(Boolean);
  return { ok: true, total: all.length, entries: all.slice(0, limit) };
}
