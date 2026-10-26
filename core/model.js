/**
 * GarbageMaster — 核心域模型运算（纯逻辑，零 IO、零宿主 import）。
 *
 * 这里放三件事：
 *  1) 路径与签名归一化（未来接 LLM 时按签名计费的基础）；
 *  2) 从扫描树推导候选清理项（顶层命中优先，避免重复计数）；
 *  3) 删除后的增量更新 —— 维护不变式 I2（子项面积之和 == 父节点），复杂度 O(树深)。
 */

/** 人类可读体积。 */
export function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
}

/**
 * 路径包含判定（按路径分段，避免 `/foo` 误匹配 `/foobar`）。
 * @param {string} child 待判定的路径
 * @param {string} parent 祖先路径
 */
export function isUnder(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !parent) return false;
  if (child === parent) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}

/**
 * 签名归一化：抹掉个体差异（用户名、版本号、GUID、日期、哈希文件名），
 * 保留类别特征。同一类候选（例如每个 Chrome Profile 的 Cache）会得到同一个签名。
 * @param {string} path 绝对路径
 * @param {string} [home] 家目录，用于折叠成 %H%
 */
export function normalizeSignature(path, home) {
  if (typeof path !== 'string') return '';
  let s = path;
  if (home && home !== '/' && isUnder(s, home)) s = `%H%${s.slice(home.length)}`;
  s = s.replace(/^\/(home|Users)\/[^/]+/, '/%H%');
  s = s.replace(/\{[0-9a-fA-F-]{8,}\}/g, '{*}');          // GUID
  s = s.replace(/\b\d{1,2}\.\d{1,2}(\.\d{1,3}){1,3}\b/g, '*'); // 1.2.3 / 26100.8457
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, '*');               // 长十六进制哈希
  s = s.replace(/\b(18|19|20)\d{6,}\b/g, '*');             // 日期 20260906
  // 形如 f_0000a1 / data0001.tmp / cache-3f2b 的碎文件名 → 通配
  s = s.replace(/\/[^/]*(?:^|[-_.])(?:f|data|cache|tmp|part)[-_.]?[0-9a-z]{3,}[^/]*$/i, '/*');
  return s;
}

const RISK_RANK = { safe: 0, caution: 1, keep: 2, blocked: 3 };
const AUTO_ACTIONS = new Set(['unlink', 'archive']);

/**
 * 从扫描树推导候选清理项。
 *
 * 核心规则（"具体优先于笼统，且不被更危险的内容冒充"）：
 *
 *  1. 只有**命中规则**的节点才会成为候选；没命中的节点不进清单（但仍在树图里可见，
 *     用户可以手动把它加进清理清单）。
 *  2. 一个命中节点，若其内部存在**风险更高**的命中项，则**不提供整体删除**，
 *     改而提供那些更具体的子项。
 *     例：`~/.cache` 本身是 safe，但里面有 `~/.cache/huggingface`（caution，重下代价高）——
 *     那么界面就不会建议"整体删除 ~/.cache"，而是列出 huggingface 与其他具体子项。
 *     这一条直接防止"用一条笼统的安全规则把需要谨慎的内容一起带走"。
 *  3. 一个命中节点若吸收了内部命中项（内部风险不高于它），则只产出它自己一个候选，
 *     内部不再重复产出 —— 避免父子重复计数。
 *
 * @param {object} params
 * @param {object} params.tree 扫描树根节点
 * @param {Array} params.compiledRules 已编译规则包
 * @param {(path:string, rules:Array)=>object} params.annotate 判定函数
 * @param {string} [params.home] 家目录
 * @param {number} [params.minBytes] 候选体积下限
 */
export function deriveCandidates({ tree, compiledRules, annotate, home, minBytes = 1024 * 1024 }) {
  const candidates = [];
  const byRisk = { safe: 0, caution: 0, keep: 0, blocked: 0 };
  const rule = (p) => annotate(p, compiledRules);

  const makeCandidate = (nodeish, verdict, kind, isFile) => {
    const size = Number(nodeish.size) || 0;
    byRisk[verdict.risk] = (byRisk[verdict.risk] || 0) + size;
    return {
      id: nodeish.path,
      path: nodeish.path,
      name: nodeish.name || String(nodeish.path).split('/').filter(Boolean).pop() || nodeish.path,
      kind,
      size,
      signature: normalizeSignature(nodeish.path, home),
      risk: verdict.risk,
      action: verdict.action,
      note: verdict.note,
      remedy: verdict.remedy || null,
      ruleId: verdict.ruleId,
      recursive: Boolean(verdict.recursive),
      source: 'rule',
      executable: AUTO_ACTIONS.has(verdict.action) && size > 0
    };
  };

  /** @returns {{list: object[], maxRank: number}} */
  const collect = (node, isRoot = false) => {
    const verdict = rule(node.path);
    // 扫描根永远是"容器"，不是候选项：
    // 根路径往往本身命中 blocked 规则（例如 /home/<user>、/usr、/media/<user>），
    // 若按"命中即吸收"处理，整棵子树会被压缩成一个不可删除的候选，
    // 界面就会一个候选都列不出来（真实数据上已复现过）。
    const matchedSelf = !isRoot && verdict.ruleId !== null && (Number(node.size) || 0) >= minBytes;

    // 注意：必须显式包一层箭头函数 —— 直接写 .map(collect) 会把数组索引
    // 当成 isRoot 的第二参数传进去，索引 ≥1 的子节点会被误判为"扫描根"。
    const childResults = (node.children || []).map((child) => collect(child));
    const descendantList = [];
    let descendantMaxRank = -1;
    for (const result of childResults) {
      descendantList.push(...result.list);
      if (result.maxRank > descendantMaxRank) descendantMaxRank = result.maxRank;
    }

    if (matchedSelf) {
      const selfRank = RISK_RANK[verdict.risk] ?? 1;
      if (descendantMaxRank > selfRank) {
        // 内部有更危险的东西：拒绝整体删除，交出更具体的子项
        return { list: descendantList, maxRank: descendantMaxRank };
      }
      return { list: [makeCandidate(node, verdict, 'dir', false)], maxRank: selfRank };
    }

    const list = [];
    let maxRank = -1;
    const considerEntry = (entry, kind, isFile) => {
      if (!entry || typeof entry.path !== 'string') return;
      const v = rule(entry.path);
      if (v.ruleId === null) return;
      if (!AUTO_ACTIONS.has(v.action)) return;
      if ((Number(entry.size) || 0) < minBytes) return;
      list.push(makeCandidate(entry, v, kind, isFile));
      const rank = RISK_RANK[v.risk] ?? 1;
      if (rank > maxRank) maxRank = rank;
    };
    for (const file of node.files || []) considerEntry(file, 'file', true);
    if (node.others && Array.isArray(node.others.items)) {
      for (const item of node.others.items) considerEntry(item, 'dir', false);
    }
    for (const result of childResults) if (result.maxRank > maxRank) maxRank = result.maxRank;

    return { list: [...list, ...descendantList], maxRank };
  };

  const collected = collect(tree, true);
  candidates.push(...collected.list);
  candidates.sort((a, b) => b.size - a.size);

  const executable = candidates.filter((c) => c.executable && (c.risk === 'safe' || c.risk === 'caution'));
  const totals = {
    executableBytes: executable.reduce((sum, c) => sum + c.size, 0),
    executableCount: executable.length,
    byRisk
  };
  return { candidates, totals };
}


/**
 * 建立路径索引：path → {kind, parent, node}，供删除后 O(1) 定位。
 * kind: 'child' 在 parent.children 里 | 'file' 在 parent.files 里 | 'other' 被折叠进 parent.others
 */
export function buildIndex(tree) {
  const index = new Map();
  const walk = (node) => {
    // 只有树根是 'root'；其余节点由父节点在递归前登记为 child/file/other。
    // （早期版本在这里无条件写 'root'，把刚登记的 'child' 覆盖掉，
    //   导致 applyDeletion 对任何子节点都报 refuse-root —— 已由回归测试覆盖。）
    if (!index.has(node.path)) index.set(node.path, { kind: 'root', parent: null, node });
    for (const child of node.children || []) {
      index.set(child.path, { kind: 'child', parent: node, node: child });
      walk(child);
    }
    for (const file of node.files || []) {
      if (file && typeof file.path === 'string') {
        index.set(file.path, { kind: 'file', parent: node, node: file });
      }
    }
    if (node.others && Array.isArray(node.others.items)) {
      for (const item of node.others.items) {
        if (item && typeof item.path === 'string' && !index.has(item.path)) {
          index.set(item.path, { kind: 'other', parent: node, node: item });
        }
      }
    }
  };
  walk(tree);
  return index;
}

/**
 * 删除后的增量更新（就地修改 tree）。
 *
 * 不变式 I2 的维护在这里非常便宜：从父节点到根，每级 `size -= removed`。
 * 因为被删项同时从父节点的 children/files/others 中移除，等式
 *   size == Σchildren + others.size + Σfiles + smallRest
 * 在每级依然成立 —— 无需重算 smallRest，也无需遍历兄弟。
 *
 * @returns {{ok:boolean, removedBytes:number, reason?:string}}
 */
export function applyDeletion(tree, index, path) {
  const entry = index.get(path);
  if (!entry) return { ok: false, removedBytes: 0, reason: 'not-in-model' };
  if (entry.kind === 'root') return { ok: false, removedBytes: 0, reason: 'refuse-root' };

  const size = Number(entry.node && entry.node.size) || 0;
  const parent = entry.parent;

  if (entry.kind === 'child') {
    const list = parent.children || [];
    const at = list.findIndex((c) => c.path === path);
    if (at >= 0) list.splice(at, 1);
  } else if (entry.kind === 'file') {
    const list = parent.files || [];
    const at = list.findIndex((f) => f.path === path);
    if (at >= 0) list.splice(at, 1);
  } else if (entry.kind === 'other') {
    if (parent.others) {
      parent.others.size = Math.max(0, (parent.others.size || 0) - size);
      parent.others.count = Math.max(0, (parent.others.count || 0) - 1);
      const items = parent.others.items || [];
      const at = items.findIndex((i) => i.path === path);
      if (at >= 0) items.splice(at, 1);
    }
  }

  // 父节点到根：逐级减去已释放的体积（I2 自动保持）
  let cursor = parent;
  while (cursor) {
    cursor.size = Math.max(0, (Number(cursor.size) || 0) - size);
    const up = index.get(cursor.path);
    cursor = up && up.parent ? up.parent : null;
  }

  index.delete(path);
  return { ok: true, removedBytes: size };
}

/** 该路径是否落在受保护集合内（扫描根、挂载点、状态目录、家目录本身）。 */
export function isProtected(path, protectedPaths) {
  for (const p of protectedPaths || []) {
    if (!p) continue;
    if (path === p) return p;
  }
  return null;
}
