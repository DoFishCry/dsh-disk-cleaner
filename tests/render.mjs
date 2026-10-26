/**
 * 客户端渲染冒烟测试：用极简 React 替身真正跑一遍组件渲染，
 * 用来抓"打开面板一片空白"这类渲染期异常（语法检查抓不到）。
 *
 * 不依赖浏览器：把 client.js 在 vm 沙箱里求值，取出 __ModuleLoader__ 注册的工厂，
 * 用假 React（useState/useMemo/useEffect/useRef/Fragment/createElement）渲染一次。
 * 首次渲染时 snapshot 为 null（还没拉到状态），这是最容易空指针的时机。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');

let failures = 0;
let checks = 0;
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n      ') : error}`);
  }
}

// ── 极简 React 替身
function createReactMock() {
  let hookIndex = 0;
  const hookStates = [];
  const setters = [];
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial;
      const setter = (next) => { hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next; };
      setters[index] = setter;
      return [hookStates[index], setter];
    },
    useMemo(factory) {
      hookIndex += 1;
      return factory();
    },
    useCallback(fn) {
      hookIndex += 1;
      return fn;
    },
    useEffect() {
      hookIndex += 1;
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!(index in hookStates)) hookStates[index] = { current: initial };
      return hookStates[index];
    }
  };
  return {
    React,
    setters,
    reset() { hookIndex = 0; },
    /** 重放：保留已累积的状态，只把游标拨回 0，模拟一次 setState 后的重渲染。 */
    replay() { hookIndex = 0; }
  };
}

/** 从源码里按声明顺序取出 useState 的名字，用来按语义给状态播种。 */
function useStateNames(source) {
  const names = [];
  const re = /const \[(\w+), (set\w+)\] = useState\(/g;
  let m;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

/** 深度收集带某个 className 的元素。 */
function collectByClass(node, cls, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.props && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(cls)) out.push(node);
  const kids = node.children || [];
  for (const kid of kids) {
    if (Array.isArray(kid)) { for (const k of kid) collectByClass(k, cls, out); } else collectByClass(kid, cls, out);
  }
  return out;
}

const noop = () => {};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  JSON,
  Math,
  Date,
  Number,
  String,
  Object,
  Array,
  Map,
  Set,
  Promise,
  RegExp,
  Symbol,
  Error,
  navigator: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
  fetch: async () => { throw new Error('fetch disabled in render smoke test'); },
  EventSource: class { constructor() { this.onmessage = null; } close() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  document: { createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }), body: { appendChild: noop } },
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const source = await fsp.readFile(clientPath, 'utf8');

let registered = null;
sandbox.window.__GARBAGE_MASTER__ = { token: 'render-test-token', prefix: '/garbage-master', version: 1 };
sandbox.window.__ModuleLoader__ = {
  load(module) { registered = module; }
};

check('client.js 能在沙箱里求值并注册模块', () => {
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  if (!registered || typeof registered.factory !== 'function') throw new Error('没有注册 factory');
  if (registered.id !== '@local/dsh-garbage-master') throw new Error(`模块 id 不对：${registered.id}`);
});

const mock = createReactMock();
const runtime = registered.factory((name) => {
  if (name === 'react') return mock.React;
  throw new Error(`未知依赖：${name}`);
});

check('工厂返回 apply 且声明注入 slots', () => {
  if (!runtime || typeof runtime.apply !== 'function') throw new Error('apply 缺失');
  if (!Array.isArray(runtime.inject) || !runtime.inject.includes('slots')) throw new Error('inject 不含 slots');
});

const registrations = [];
const fakeCtx = {
  slots: {
    inject(name, factory) { registrations.push({ name, entries: factory() }); },
    register(options, component) { return { options, component }; }
  }
};

check('apply 注册了 main 与侧栏图标', () => {
  runtime.apply(fakeCtx);
  const names = registrations.map((r) => r.name).sort();
  if (names.join(',') !== 'main,sidebar.panellist') throw new Error(`注册的插槽：${names.join(',')}`);
});

check('面板组件存在且是函数', () => {
  const main = registrations.find((r) => r.name === 'main');
  if (!main || typeof main.entries.component !== 'function') throw new Error('main 组件缺失');
});

check('首屏渲染不抛异常（snapshot 为 null 的最早时机）', () => {
  const main = registrations.find((r) => r.name === 'main');
  mock.reset();
  const tree = main.entries.component({});
  if (!tree || tree.type !== 'div') throw new Error('渲染结果不是根 div');
  if (!tree.props || tree.props.className !== 'gm-root') throw new Error(`根节点 class 异常：${tree.props && tree.props.className}`);
});

// ── 场景 2：灌入一份真实形状的数据后重渲染（覆盖树块 / 清单表 / 底部栏等深层分支）
const stateNames = useStateNames(source);
const mainEntry = registrations.find((r) => r.name === 'main');
const mock2 = createReactMock();
const runtimeMain = mainEntry.entries.component;

function seed(name, value) {
  const index = stateNames.indexOf(name);
  if (index < 0) throw new Error(`没有这个状态：${name}`);
  const setter = mock.setters[index];
  if (typeof setter !== 'function') throw new Error(`状态 ${name} 没有 setter（渲染未跑到？）`);
  setter(value);
}

check('灌入数据后重渲染不抛异常', () => {
  // 先空渲染一次，建立 hooks 与 setter
  mock.reset();
  runtimeMain({});
  const tree = {
    path: '/root', name: '/', size: 1000, mtime: 1700000000, kind: 'dir', files: [], others: null, smallRest: 0,
    children: [{ path: '/root/a', name: 'a', size: 600, mtime: 1700000000, kind: 'dir', children: [], files: [], others: null, smallRest: 0 }]
  };
  const usage = { total: 2000, used: 1000, free: 1000 };
  seed('snapshot', {
    config: { workers: 3 }, quickPaths: [],
    targets: [{ id: 't1', label: '系统根分区 /', path: '/root', usage }],
    scans: { t1: { status: 'complete', stats: { denied: 1, symlinks: 2 }, generated: '2026-10-19 00:00', usage, candidateCount: 1, candidateBytes: 600, treeVersion: 1 } },
    run: null
  });
  seed('targetId', 't1');
  seed('treeData', { root: '/root', tree, usage, treeVersion: 1 });
  seed('currentPath', '/root');
  seed('cand', { candidates: [{ path: '/root/a', name: 'a', size: 600, risk: 'safe', action: 'unlink', note: '可再生', executable: true, kind: 'dir' }], totals: { executableBytes: 600, executableCount: 1 } });
  seed('listing', {
    path: '/root', risk: 'caution', note: '这里是分区根目录', dirCount: 1, fileCount: 0, truncated: false, total: 1,
    children: [{ name: 'a', path: '/root/a', isDir: true, size: 600, risk: 'safe', note: '可再生', executable: true, candidate: true, mtime: 1700000000 }]
  });
  seed('cart', new Map([['/root/a', { path: '/root/a', name: 'a', size: 600, risk: 'safe', isDir: true, note: '可再生', mode: 'clean', special: '@/root/a 保留 30 天' }]]));
  seed('footOpen', true);
  seed('report', { status: 'complete', expectedBytes: 600, actualBytes: 580, diskFreeDelta: 1024, skipped: [], failed: [], auditFile: '/tmp/audit.jsonl', pack: null, tidy: null });
  seed('dispatch', { mode: 'in-process', lead: null, reason: 'agent-teams-unavailable', groups: [{ mode: 'clean', status: 'done' }], errors: [] });

  mock.replay();
  const rendered = runtimeMain({});
  const tiles = collectByClass(rendered, 'gm-tile');
  if (tiles.length === 0) throw new Error('树块没有渲染出来（0 个 gm-tile）');
  const rows = collectByClass(rendered, 'gm-row');
  if (rows.length === 0) throw new Error('本层条目没有渲染出来（0 个 gm-row）');
  const table = collectByClass(rendered, 'gm-table');
  if (table.length === 0) throw new Error('清单表格没有渲染出来');
});

check('扫描中会渲染动画条', () => {
  mock.reset();
  runtimeMain({});
  seed('snapshot', {
    config: { workers: 3 }, quickPaths: [],
    targets: [{ id: 't1', label: '/', path: '/root', usage: { total: 2000, used: 1000, free: 1000 } }],
    scans: { t1: { status: 'scanning', progress: { dirs: 10, files: 20, bytes: 100 }, stats: null, usage: null } },
    run: null
  });
  seed('targetId', 't1');
  mock.replay();
  const rendered = runtimeMain({});
  if (collectByClass(rendered, 'gm-scanbar').length === 0) throw new Error('扫描中没有动画条');
});

check('计划 / 二次确认 / 特殊要求 / 设置 四个弹窗都能渲染', () => {
  mock.reset();
  runtimeMain({});
  seed('snapshot', { config: { workers: 3 }, quickPaths: [], targets: [{ id: 't1', label: '/', path: '/root', usage: null }], scans: {}, run: null });
  seed('targetId', 't1');
  seed('plan', {
    planId: 'plan-1', confirmToken: 'tk', totals: { count: 2, bytes: 600 }, skipped: [{ path: '/root/z', reason: 'blocked' }],
    groups: [
      { mode: 'clean', label: '清除', itemCount: 1, bytes: 600, deletesFiles: true, items: [{ path: '/root/a', size: 600, mode: 'clean', special: '保留 30 天', aiReason: '可再生', aiSuggestion: 'clean' }] },
      { mode: 'restart', label: '需要重启', itemCount: 1, bytes: 1, deletesFiles: false, items: [{ path: '/root/svc', size: 1, mode: 'clean' }], note: '需要重启' }
    ],
    pending: [{ path: '/root/svc', mode: 'clean', reason: 'needs-restart' }],
    uninstall: [{ path: '/root/app', size: 10, command: 'flatpak uninstall x', why: '应卸载', kind: 'flatpak', name: 'x' }],
    ai: { used: true, summary: '主要是缓存', warnings: ['有需要重启的任务'], dropped: ['/etc/passwd'] },
    items: [{ path: '/root/a', size: 600, recursive: true }, { path: '/root/svc', size: 1, recursive: false }],
    executableItems: [{ path: '/root/a', size: 600, recursive: true }]
  });
  seed('finalOpen', true);
  seed('ackDelete', true);
  seed('ackDir', true);
  seed('specialFor', '/root/a');
  seed('specialDraft', '@/root/a 只保留最近 30 天');
  seed('specialListing', { children: [{ name: 'a', path: '/root/a', isDir: true }] });
  seed('settingsOpen', true);
  seed('settingsDraft', { bigFileBytes: 500, minExpandBytes: 32, minCandidateBytes: 1024, maxDepth: 9, keepTop: 20, filesPerDir: 20, workers: 3 });
  mock.replay();
  const rendered = runtimeMain({});
  const modals = collectByClass(rendered, 'gm-modal');
  if (modals.length < 4) throw new Error(`弹窗数量不足：${modals.length}（期望 4）`);
  if (collectByClass(rendered, 'gm-at').length === 0) throw new Error('@ 引用没有被着色渲染');
});

check('正在解释的条目显示加载中图标', () => {
  mock.reset();
  runtimeMain({});
  const tree = {
    path: '/root', name: '/', size: 1000, mtime: 1700000000, kind: 'dir', files: [], others: null, smallRest: 0,
    children: [{ path: '/root/a', name: 'a', size: 600, mtime: 1700000000, kind: 'dir', children: [], files: [], others: null, smallRest: 0 }]
  };
  const usage = { total: 2000, used: 1000, free: 1000 };
  seed('snapshot', {
    config: { workers: 3 }, quickPaths: [],
    targets: [{ id: 't1', label: '/', path: '/root', usage }],
    scans: { t1: { status: 'complete', stats: { denied: 0, symlinks: 0 }, generated: '2026-10-19 00:00', usage, candidateCount: 1, candidateBytes: 600, treeVersion: 1 } },
    run: null
  });
  seed('targetId', 't1');
  seed('treeData', { root: '/root', tree, usage, treeVersion: 1 });
  seed('currentPath', '/root');
  seed('listing', {
    path: '/root', risk: 'caution', note: '这里是分区根目录', dirCount: 1, fileCount: 0, truncated: false, total: 1,
    children: [{ name: 'a', path: '/root/a', isDir: true, size: 600, risk: 'safe', note: '', executable: true, candidate: true, mtime: 1700000000 }]
  });
  seed('explainPending', ['/root/a']); // 这一条正在被解释
  mock.replay();
  const rendered = runtimeMain({});
  if (collectByClass(rendered, 'gm-spin-sm').length === 0) throw new Error('没有渲染"解释中"转圈');
  if (collectByClass(rendered, 'gm-rex-wait').length === 0) throw new Error('没有渲染"正在解释…"占位');
  const tiles = collectByClass(rendered, 'gm-tile');
  if (!tiles.some((t) => String(t.props.className).includes('pending'))) throw new Error('树块没有解释中状态');
});

check('令牌过期时渲染顶部横幅（含刷新按钮）', () => {
  mock.reset();
  runtimeMain({});
  seed('snapshot', { config: { workers: 3 }, quickPaths: [], targets: [{ id: 't1', label: '/', path: '/root', usage: null }], scans: {}, run: null });
  seed('staleToken', true);
  mock.replay();
  const rendered = runtimeMain({});
  const banner = collectByClass(rendered, 'gm-stale');
  if (banner.length === 0) throw new Error('没有渲染令牌过期横幅');
  const text = JSON.stringify(rendered);
  if (!text.includes('页面令牌已过期')) throw new Error('横幅文案缺失');
  if (!text.includes('立即刷新页面')) throw new Error('横幅缺少刷新按钮');
});

check('审计弹窗能渲染历史删除记录', () => {
  mock.reset();
  runtimeMain({});
  seed('snapshot', { config: { workers: 3 }, quickPaths: [], targets: [{ id: 't1', label: '/', path: '/root', usage: null }], scans: {}, run: null });
  seed('targetId', 't1');
  seed('auditOpen', true);
  seed('auditRuns', [{
    planId: 'plan-x', at: '2026-10-19T03:59:31.065Z', dryRun: false, deletedCount: 1,
    actualBytes: 33720693, status: 'complete', failed: 0, skipped: 0, totals: { bytes: 33720693 },
    deleted: [{ path: '/root/gone/__pycache__', bytes: 33720693, actor: 'gc-clean/pool-worker-1', ruleId: 73 }],
    packs: [], tidies: []
  }]);
  seed('auditExpanded', 'plan-x');
  mock.replay();
  const rendered = runtimeMain({});
  if (collectByClass(rendered, 'gm-auditrow').length === 0) throw new Error('审计运行列表没有渲染');
  const text = JSON.stringify(rendered);
  if (!text.includes('gc-clean/pool-worker-1')) throw new Error('审计详情没有渲染执行者身份');
  if (!text.includes('__pycache__')) throw new Error('审计详情没有渲染被删路径');
});

check('侧栏图标能按 size 渲染', () => {
  const icon = registrations.find((r) => r.name === 'sidebar.panellist');
  mock.reset();
  const tree = icon.entries.component({ size: 18, active: false });
  if (!tree || tree.type !== 'svg') throw new Error('图标不是 svg');
  const width = tree.props && tree.props.width;
  if (width !== 18) throw new Error(`图标宽度没有跟随 size：${width}`);
});

console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ''}\n`);
process.exit(failures === 0 ? 0 : 1);
