/**
 * GarbageMaster — 「在界面里直接打开」能力。
 *
 * 两件事，都用系统既有程序完成，本插件不实现任何查看器：
 *   reveal(path) —— 在文件管理器里定位并选中（优先 org.freedesktop.FileManager1.ShowItems）
 *   open(path)   —— 交给系统默认程序打开（JPG 就用系统看图器，视频就用系统播放器）
 *
 * 安全注意：这里用 `spawn` + 参数数组调用，**不经过 shell**，因此路径里的
 * 空格、引号、`$()`、`;` 都不会被解释执行。调用方还必须先用扫描根做白名单校验
 * （见 host/http.js 的 assertInsideTargets），避免这个接口变成"任意路径打开"。
 */

import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

function run(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (error) => {
      if (!settled) { settled = true; resolve({ ok: false, error: error.code || error.message }); }
    });
    child.once('spawn', () => {
      if (!settled) { settled = true; resolve({ ok: true }); }
      child.unref();
    });
  });
}

/** 规范化并做基本形态校验（不做白名单，白名单由调用方负责）。 */
export function normalizeTarget(input) {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, error: 'empty' };
  if (input.includes('\0')) return { ok: false, error: 'nul-byte' };
  if (!input.startsWith('/')) return { ok: false, error: 'not-absolute' };
  const normalized = path.normalize(input);
  if (normalized.includes('/../')) return { ok: false, error: 'traversal' };
  return { ok: true, path: normalized };
}

/** 文件 URI：逐段做百分号编码，保留 / 分隔符。 */
export function toFileUri(target) {
  const encoded = target.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `file://${encoded}`;
}

async function statOrError(target) {
  try {
    return { ok: true, stat: await fsp.lstat(target) };
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? 'not-found' : (error.code || error.message) };
  }
}

/**
 * 在文件管理器中定位并选中该路径。
 * @param {string} input 绝对路径
 */
export async function reveal(input) {
  const normalized = normalizeTarget(input);
  if (!normalized.ok) return normalized;
  const target = normalized.path;

  const probed = await statOrError(target);
  if (!probed.ok) return probed;

  const dir = probed.stat.isDirectory() ? target : path.dirname(target);
  const uri = toFileUri(target);

  // 首选：桌面规范的文件管理器接口（能"选中"而不只是"打开目录"）
  const dbus = await run('dbus-send', [
    '--session',
    '--dest=org.freedesktop.FileManager1',
    '--type=method_call',
    '/org/freedesktop/FileManager1',
    'org.freedesktop.FileManager1.ShowItems',
    `array:string:${uri}`,
    'string:'
  ]);
  if (dbus.ok) return { ok: true, via: 'FileManager1', dir, target };

  // 退路：直接打开所在目录
  const xdg = await run('xdg-open', [dir]);
  if (xdg.ok) return { ok: true, via: 'xdg-open', dir, target };
  return { ok: false, error: `无法打开文件管理器（dbus: ${dbus.error}，xdg-open: ${xdg.error}）` };
}

/**
 * 用系统默认程序打开该路径（文件或目录）。
 * @param {string} input 绝对路径
 */
export async function openWithDefault(input) {
  const normalized = normalizeTarget(input);
  if (!normalized.ok) return normalized;
  const target = normalized.path;

  const probed = await statOrError(target);
  if (!probed.ok) return probed;

  const xdg = await run('xdg-open', [target]);
  if (xdg.ok) return { ok: true, via: 'xdg-open', target };
  return { ok: false, error: `无法用默认程序打开（xdg-open: ${xdg.error}）。请确认系统已安装 xdg-utils 且有图形会话。` };
}
