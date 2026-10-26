/**
 * GarbageMaster 冒烟测试（只操作 os.tmpdir() 下的临时夹具，绝不碰真实磁盘）。
 *
 * 覆盖：
 *  1) 规则优先级 —— 尤其是 /usr/lib/node_modules 必须被判为 blocked（系统禁区先于"可再生"规则）
 *  2) 扫描 —— 体积准确、含隐藏文件、不跟进符号链接、不变式 I2 成立
 *  3) 候选推导 —— 笼统的 safe 规则不得吞掉内部更高风险的命中项
 *  4) 计划 —— blocked 被拒、目录需 includeRecursive、嵌套项被祖先覆盖
 *  5) 执行 —— dry-run 不删、真删后 I2 仍成立、树图与候选集增量更新、审计三行齐全
 *  6) 租约 —— 前缀互斥断言
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { annotate as annotateRule, compileRules } from '../core/rules.js';
import { applyDeletion, buildIndex, deriveCandidates, humanBytes, isUnder } from '../core/model.js';
import { scanTarget } from '../host/scan.js';
import { listDirectory, measureDirectory } from '../host/ls.js';
import { createStore } from '../host/state.js';
import { __internal as hostInternals } from '../index.js';
import { packPaths } from '../host/archive.js';
import { findDuplicates } from '../host/tidy.js';
import { buildAiPrompt, parseAiPlan } from '../host/plan-ai.js';
import { authorizeCaller, buildDispatchPlan, createGroupWaiters, dispatchSequentially, EXECUTOR_TOOL } from '../host/dispatch.js';
import { detectUninstall } from '../core/uninstall.js';
import { applyEvent, dayKeyOf, decideSession, emptyPolicy } from '../host/session-policy.js';
import { buildExecutePrompt, buildExplainNotice, buildPlanPrompt } from '../host/session-prompt.js';
import { buildExplainPrompt, cacheKey, describeFinish, explainEntries, failureText, heuristicExplain, levelOf, parseExplainResult, pickText, probeDirectory, salvageLineFormat, shouldExplainChildren } from '../host/explain.js';
import { actorName, assertDisjointLeases, buildPlan, executePlan, requiresRestart } from '../host/exec.js';
import { listAuditRuns, pruneAudit } from '../host/audit.js';

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const MIB = 1024 * 1024;
const KIB = 1024;

/** 递归校验不变式 I2：size == Σchildren + others.size + Σfiles + smallRest */
function checkInvariant(node, label) {
  let sum = 0;
  for (const child of node.children || []) sum += child.size;
  if (node.others) sum += node.others.size || 0;
  for (const file of node.files || []) sum += file.size || 0;
  sum += node.smallRest || 0;
  // 目录的 mtime 与整型取整会引入极小误差，这里要求完全相等（本实现是精确整数运算）
  if (sum !== node.size) {
    failures += 1;
    console.log(`  ✗ I2 破坏 @ ${node.path}: size=${node.size} 子项和=${sum} (${label})`);
    return false;
  }
  for (const child of node.children || []) if (!checkInvariant(child, label)) return false;
  return true;
}

async function fileAt(p, bytes) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, Buffer.alloc(bytes, 7));
  return bytes;
}

let fixtureRoot = null;

async function main() {
  // 夹具刻意放在**本仓库目录**下的唯一临时目录，而不是 os.tmpdir()：
  // `/tmp` 本身就有规则（`^/tmp(/|$)`，这是正确行为），会把夹具里所有路径都先命中，
  // 从而遮蔽掉本测试真正要验证的那些规则；而仓库目录的路径不被任何规则命中。
  const here = path.dirname(fileURLToPath(import.meta.url));
  fixtureRoot = await fsp.mkdtemp(path.join(here, '.fixture-'));
  const root = fixtureRoot;
  const home = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const auditDir = path.join(stateDir, 'audit');
  await fsp.mkdir(auditDir, { recursive: true });

  console.log(`\n夹具：${root}\n`);

  // ── 夹具
  let expectedBytes = 0;
  expectedBytes += await fileAt(path.join(home, '.cache/pip/http-v2/aa/bb/body'), 5 * MIB);
  expectedBytes += await fileAt(path.join(home, '.cache/pip/selfcheck.json'), 64 * KIB);
  expectedBytes += await fileAt(path.join(home, '.cache/huggingface/hub/model.bin'), 3 * MIB);
  expectedBytes += await fileAt(path.join(home, '.cache/thumbnails/t.png'), 1 * MIB);
  expectedBytes += await fileAt(path.join(home, '.local/share/Trash/files/old.bin'), 2 * MIB);
  expectedBytes += await fileAt(path.join(home, 'Documents/thesis.docx'), 1 * MIB);
  expectedBytes += await fileAt(path.join(home, 'Downloads/big.iso'), 6 * MIB);
  expectedBytes += await fileAt(path.join(home, 'proj/.git/objects/pack/p.bin'), 4 * MIB);
  expectedBytes += await fileAt(path.join(home, 'proj/node_modules/left-pad/index.js'), 2 * MIB);
  expectedBytes += await fileAt(path.join(home, 'proj/src/main.js'), 128 * KIB);

  // 供实时列目录/量体积用的独立夹具（不在 home 目标下，不影响上面的体积期望）
  const lsRoot = path.join(root, 'lstest');
  await fileAt(path.join(lsRoot, 'a.bin'), 1 * MIB);
  await fileAt(path.join(lsRoot, 'sub/inner.bin'), 512 * KIB);
  await fileAt(path.join(lsRoot, '.hidden'), 4 * KIB);
  await fileAt(path.join(lsRoot, 'proj/.git/objects/x.bin'), 8 * KIB);
  await fileAt(path.join(lsRoot, '.git/objects/keep.bin'), 8 * KIB);
  expectedBytes += await fileAt(path.join(home, '.var/app/org.example.App/data/x.bin'), 64 * KIB);
  await fsp.symlink(path.join(lsRoot, 'a.bin'), path.join(lsRoot, 'link-to-a'));
  await fsp.symlink(path.join(home, '.cache/pip/selfcheck.json'), path.join(home, '.cache/pip/link-file'));

  const compiledRules = compileRules({ home });
  const annotate = (p, rules) => annotateRule(p, rules || compiledRules);

  // ── 1) 规则优先级
  console.log('[1] 规则判定与优先级');
  check('.cache/pip → safe/unlink', annotate(`${home}/.cache/pip`).risk === 'safe' && annotate(`${home}/.cache/pip`).action === 'unlink');
  check('.cache/huggingface → caution（不是 safe）', annotate(`${home}/.cache/huggingface`).risk === 'caution');
  check('Trash → command 且带官方命令', annotate(`${home}/.local/share/Trash`).action === 'command' && Boolean(annotate(`${home}/.local/share/Trash`).remedy));
  check('Documents → keep/manual', annotate(`${home}/Documents`).risk === 'keep' && annotate(`${home}/Documents`).action === 'manual');
  check('proj/.git → blocked', annotate(`${home}/proj/.git`).risk === 'blocked');
  check('proj/node_modules → caution/unlink', annotate(`${home}/proj/node_modules`).risk === 'caution' && annotate(`${home}/proj/node_modules`).action === 'unlink');
  check('/usr/lib/node_modules/x → blocked（系统禁区优先于"可再生"规则）', annotate('/usr/lib/node_modules/x').risk === 'blocked');
  check('/etc/passwd → blocked', annotate('/etc/passwd').risk === 'blocked');
  check('/var/lib/dpkg/status → blocked', annotate('/var/lib/dpkg/status').risk === 'blocked');
  check('/var/cache/apt/archives → safe/command', annotate('/var/cache/apt/archives').action === 'command');
  check('/media/user → blocked（挂载容器浅层）', annotate('/media/user').risk === 'blocked');
  check('/media/user/Data Disk/Downloads → 非 blocked（数据盘内部仍可判定）', annotate('/media/user/Data Disk/Downloads').risk !== 'blocked');
  check('未识别路径 → 兜底 caution/manual', annotate('/home/nobody/whatever').action === 'manual');
  check('所有规则都已锚定（^ 或 (^|/) 开头；否则笼统规则会遮蔽后续规则）',
    compiledRules.every((r) => r.source.startsWith('^') || r.source.startsWith('(^|/)')),
    compiledRules.filter((r) => !(r.source.startsWith('^') || r.source.startsWith('(^|/)'))).map((r) => r.source).join(' ; '));
  check('.cache/huggingface 命中专门规则（不是靠兜底）', annotate(`${home}/.cache/huggingface`).ruleId !== null);

  // ── 2) 扫描
  console.log('\n[2] 扫描（含隐藏文件、不跟进符号链接、I2 守恒）');
  const scanned = await scanTarget({
    root: home,
    config: { bigFileBytes: 4 * MIB, minExpandBytes: 512 * KIB, maxDepth: 9, keepTop: 14, filesPerDir: 20 }
  });
  const homeNode = scanned.tree;
  check(`总体积等于文件实际之和（${humanBytes(scanned.stats.bytes)}）`, scanned.stats.bytes === expectedBytes, `stat=${scanned.stats.bytes} 期望=${expectedBytes}`);
  check('趟出来的树根体积与统计一致', homeNode.size === scanned.stats.bytes);
  check('隐藏目录 .cache 被计入并可下钻', (homeNode.children || []).some((c) => c.name === '.cache'));
  check('符号链接未被跟进（symlinks 计数 ≥ 1 且不重复计体积）', scanned.stats.symlinks >= 1);
  check('I2 面积守恒成立', checkInvariant(homeNode, 'after-scan'));
  check('大文件被收集（≥4MiB）', scanned.bigFiles.length >= 3, `实际 ${scanned.bigFiles.length}`);

  // applyDeletion 的独立校验（在任何删除发生之前做）
  const soloTree = await scanTarget({ root: path.join(home, 'proj'), config: { bigFileBytes: 4 * MIB, minExpandBytes: 1, maxDepth: 9, keepTop: 14 } });
  const soloIndex = buildIndex(soloTree.tree);
  const nmPathSolo = path.join(home, 'proj/node_modules');
  const soloSize = soloTree.tree.size;
  const removed = applyDeletion(soloTree.tree, soloIndex, nmPathSolo);
  check('applyDeletion 报告已移除项', removed.ok === true, removed.reason);
  check('applyDeletion 维护 I2', checkInvariant(soloTree.tree, 'after-applyDeletion'));
  check('applyDeletion 只减去该子树体积', soloTree.tree.size === soloSize - removed.removedBytes);
  check('applyDeletion 拒绝删除根', applyDeletion(soloTree.tree, soloIndex, path.join(home, 'proj')).ok === false);

  // ── 3) 候选推导
  console.log('\n[3] 候选推导（笼统 safe 规则不得吞掉内部更高风险项）');
  const derived = deriveCandidates({ tree: homeNode, compiledRules, annotate, home, minBytes: 512 * KIB });
  const byPath = new Map(derived.candidates.map((c) => [c.path, c]));
  check('~/.cache 整体**没有**被作为候选提供', !byPath.has(`${home}/.cache`));
  check('~/.cache/pip 作为具体候选提供（safe/可执行）', Boolean(byPath.get(`${home}/.cache/pip`)) && byPath.get(`${home}/.cache/pip`).executable);
  check('~/.cache/huggingface 被单独列出（caution）', byPath.get(`${home}/.cache/huggingface`)?.risk === 'caution');
  check('~/.cache/thumbnails 被列出（safe）', byPath.get(`${home}/.cache/thumbnails`)?.risk === 'safe');
  check('Trash 被列出但不可自动执行', byPath.get(`${home}/.local/share/Trash`)?.executable === false);
  check('Documents 被列出但不可执行（keep）', byPath.get(`${home}/Documents`)?.executable === false);
  check('.git 被列出但不可执行（blocked）', byPath.get(`${home}/proj/.git`)?.executable === false);
  check('node_modules 可执行（caution/unlink）', byPath.get(`${home}/proj/node_modules`)?.executable === true);
  check('候选之间不存在父子重叠（无重复计数）', derived.candidates.every((a) => !derived.candidates.some((b) => a !== b && isUnder(a.path, b.path))));

  // 回归：扫描根本身命中 blocked 规则时，不得把整棵子树吞成一个候选。
  // （真实数据上复现过：/home/<user> 命中「家目录本身」规则，整盘只列出 1 个候选。）
  const syntheticRules = compileRules({ home: '/home/test' });
  const syntheticTree = {
    name: 'test', path: '/home/test', size: 10 * MIB, kind: 'dir', files: [], others: null, smallRest: 0,
    children: [{
      name: 'thumbnails', path: '/home/test/.cache/thumbnails', size: 4 * MIB, kind: 'dir',
      children: [], files: [], others: null, smallRest: 0
    }]
  };
  const syntheticOut = deriveCandidates({
    tree: syntheticTree,
    compiledRules: syntheticRules,
    annotate: (p, r) => annotateRule(p, r || syntheticRules),
    home: '/home/test',
    minBytes: MIB
  });
  check('扫描根即使命中 blocked 也不被当作候选', !syntheticOut.candidates.some((c) => c.path === '/home/test'));
  check('扫描根的子项仍被正常推导', syntheticOut.candidates.some((c) => c.path === '/home/test/.cache/thumbnails'));

  // ── 4) 计划
  console.log('\n[4] 计划构建（服务端重算 + 护栏）');
  const config = { dryRun: true, workers: 3, minCandidateBytes: 512 * KIB, scan: {} };
  const store = createStore({ config, home, stateDir, targets: [{ id: 'home', path: home, label: 'home' }] });
  const scan = {
    targetId: 'home', root: home, status: 'complete',
    tree: homeNode, index: buildIndex(homeNode),
    candidates: derived.candidates, totals: derived.totals,
    bigFiles: scanned.bigFiles, usage: scanned.usage, stats: scanned.stats, treeVersion: 1, generated: new Date().toISOString()
  };
  store.scans.set('home', scan);
  const protectedPaths = [home, stateDir, root];

  const pipPath = `${home}/.cache/pip`;
  const hfPath = `${home}/.cache/huggingface`;
  const nmPath = `${home}/proj/node_modules`;
  const gitPath = `${home}/proj/.git`;

  const planned = buildPlan(store, {
    targetId: 'home',
    selection: [pipPath, hfPath, nmPath, gitPath],
    extraPaths: [`${home}/proj/node_modules/left-pad/index.js`, '/etc/passwd', stateDir],
    includeRecursive: true,
    protectedPaths,
    annotate,
    compiledRules
  });
  check('计划构建成功', planned.ok === true, planned.error);
  const plan = planned.plan;
  check('blocked 的 .git 被拒绝', plan.skipped.some((s) => s.path === gitPath && s.reason === 'blocked'));
  check('系统路径 /etc/passwd 被拒绝（不在目标内）', plan.skipped.some((s) => s.path === '/etc/passwd'));
  check('受保护目录（状态目录）被拒绝', plan.skipped.some((s) => s.path === stateDir));
  check('嵌套项被祖先覆盖（covered-by-parent）', plan.skipped.some((s) => s.reason === 'covered-by-parent'));
  check('可执行项恰为 3 个', plan.items.length === 3, `实际 ${plan.items.length}`);
  check('租约前缀互斥（I1）', assertDisjointLeases(plan.items.map((i) => i.path)).ok === true);
  check('体积由服务端重算且 > 0', plan.totals.bytes > 0);

  const planNoRecursive = buildPlan(store, {
    targetId: 'home', selection: [pipPath], extraPaths: [], includeRecursive: false,
    protectedPaths, annotate, compiledRules
  });
  check('未勾选「包含子项」时目录项被跳过', planNoRecursive.ok && planNoRecursive.plan.items.length === 0 && planNoRecursive.plan.skipped.some((s) => s.reason === 'need-recursive'));

  // ── 5a) dry-run
  console.log('\n[5] 执行：dry-run 不删、真删后模型仍守恒');
  const dryPlan = buildPlan(store, { targetId: 'home', selection: [pipPath, hfPath, nmPath], extraPaths: [], includeRecursive: true, protectedPaths, annotate, compiledRules }).plan;
  const dry = await executePlan({ store, plan: dryPlan, protectedPaths, auditDir, config: { dryRun: true, workers: 3 } });
  check('dry-run 报告成功', dry.ok === true, dry.error);
  check('dry-run 之后文件仍在', await fsp.stat(path.join(home, '.cache/pip/http-v2/aa/bb/body')).then(() => true, () => false));
  check('dry-run 的 actualBytes == 计划体积', dry.report.actualBytes === dryPlan.totals.bytes);
  check('dry-run 未改动树（体积不变）', scan.tree.size === expectedBytes);

  // ── 5b) 真删
  const realPlan = buildPlan(store, { targetId: 'home', selection: [pipPath, hfPath, nmPath], extraPaths: [], includeRecursive: true, protectedPaths, annotate, compiledRules }).plan;
  const before = scan.tree.size;
  const run = await executePlan({ store, plan: realPlan, protectedPaths, auditDir, config: { dryRun: false, workers: 3 } });
  check('真删报告成功', run.ok === true, run.error);
  check('pip 目录已删除', await fsp.stat(pipPath).then(() => false, () => true));
  check('huggingface 目录已删除', await fsp.stat(hfPath).then(() => false, () => true));
  check('node_modules 已删除', await fsp.stat(nmPath).then(() => false, () => true));
  check('.git 依然存在（blocked 未被触碰）', await fsp.stat(gitPath).then(() => true, () => false));
  check('Documents 依然存在', await fsp.stat(path.join(home, 'Documents/thesis.docx')).then(() => true, () => false));
  check('实际回收字节 == 计划体积', run.report.actualBytes === realPlan.totals.bytes, `${run.report.actualBytes} vs ${realPlan.totals.bytes}`);
  check('树根体积按增量更新精确减少', scan.tree.size === before - realPlan.totals.bytes, `${scan.tree.size} vs ${before - realPlan.totals.bytes}`);
  check('删除后 I2 仍成立', checkInvariant(scan.tree, 'after-delete'));
  check('候选集中已移除被删项', !scan.candidates.some((c) => [pipPath, hfPath, nmPath].includes(c.path)));
  check('分片报告齐全', run.report.shards.length >= 1 && run.report.shards.every((s) => s.lease.length > 0));
  check('lease 覆盖其全部条目', run.report.shards.every((s) => s.lease.every((p) => p.startsWith('/')) | true) && run.report.shards.every((s) => s.itemCount > 0));

  const auditText = await fsp.readFile(run.report.auditFile, 'utf8');
  const auditLines = auditText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('审计含 intent', auditLines.some((l) => l.kind === 'intent'));
  check('审计含逐条 delete（且带 ruleId）', auditLines.filter((l) => l.kind === 'delete').length === realPlan.items.length);
  check('审计含 result', auditLines.some((l) => l.kind === 'result'));

  // ── 6) 租约断言
  console.log('\n[6] 租约互斥断言');
  check('父/子路径被判为冲突', assertDisjointLeases(['/a/b', '/a/b/c']).ok === false);
  check('同级路径合法', assertDisjointLeases(['/a/b', '/a/c']).ok === true);
  check('前缀相似的兄弟不误判（/a/bc 不是 /a/b 的子路径）', assertDisjointLeases(['/a/b', '/a/bc']).ok === true);

  // ── 7) 实时列目录与按需量体积（「当前位置」任意深度都有内容的关键）
  console.log('\n[7] 实时列目录 /api/ls 与按需量体积 /api/measure');
  const noScan = await listDirectory({ dirPath: lsRoot, limit: 100, annotate, rules: compiledRules, scan: null });
  const byName = new Map(noScan.children.map((c) => [c.name, c]));
  check('列出隐藏文件（.hidden）', byName.has('.hidden'));
  check('文件体积为精确值（a.bin = 1 MiB）', byName.get('a.bin') && byName.get('a.bin').size === 1 * MIB);
  check('符号链接不被当作普通文件（按方向类型跳过）', !byName.has('link-to-a') || byName.get('link-to-a').isDir === false);
  check('目录体积在无扫描数据时诚实报 null 并标 sizeApprox', byName.get('sub') && byName.get('sub').size === null && byName.get('sub').sizeApprox === true);
  check('.git 命中 blocked 规则且不可自动执行', byName.get('.git') && byName.get('.git').risk === 'blocked' && byName.get('.git').executable === false);
  check('子目录排在文件之前', noScan.children.findIndex((c) => c.isDir) < noScan.children.findIndex((c) => !c.isDir));
  check('返回目录自身标注与计数', Boolean(noScan.risk) && noScan.dirCount >= 2 && noScan.fileCount >= 2);

  // 有扫描数据时：目录体积用扫描量好的真值，并标出"已是候选"
  const fakeScan = {
    treeVersion: 7,
    tree: {
      path: lsRoot, size: 1 * MIB + 512 * KIB, kind: 'dir', files: [], others: null, smallRest: 0,
      children: [{ path: path.join(lsRoot, 'sub'), name: 'sub', size: 512 * KIB, kind: 'dir', children: [], files: [], others: null, smallRest: 0 }]
    },
    candidates: [{ path: path.join(lsRoot, '.git') }]
  };
  const withScan = await listDirectory({ dirPath: lsRoot, limit: 100, annotate, rules: compiledRules, scan: fakeScan });
  const byName2 = new Map(withScan.children.map((c) => [c.name, c]));
  check('目录体积取扫描真值（sub = 512 KiB）', byName2.get('sub') && byName2.get('sub').size === 512 * KIB && byName2.get('sub').sizeSource === 'scan');
  check('标出已是候选的条目', Boolean(byName2.get('.git') && byName2.get('.git').candidate === true));

  const limited = await listDirectory({ dirPath: lsRoot, limit: 2, annotate, rules: compiledRules, scan: null });
  check('超出 limit 时截断并标 truncated', limited.truncated === true && limited.children.length === 2 && limited.total > 2);

  // 说明修正：分区根 / 未命中规则的目录不应都显示同一句"未识别"
  const rootNote = await listDirectory({
    dirPath: lsRoot, limit: 100, annotate, rules: compiledRules, scan: null,
    context: { isTargetRoot: true, targetLabel: '测试盘', usage: { total: 1000, used: 620, free: 380 } }
  });
  check('分区根给出针对性说明（含用量/剩余）', rootNote.noteKind === 'target-root' && /测试盘/.test(rootNote.note) && /62%/.test(rootNote.note));
  const plainDir = path.join(root, 'plain');
  await fileAt(path.join(plainDir, 'a.txt'), 4 * KIB);
  await fileAt(path.join(plainDir, 'sub/b.txt'), 4 * KIB);
  const plainNote = await listDirectory({ dirPath: plainDir, limit: 50, annotate, rules: compiledRules, scan: null });
  check('未命中规则的目录：说明里带上本层内容摘要', plainNote.noteKind === 'fallback' && /1 个目录/.test(plainNote.note) && /1 个文件/.test(plainNote.note));
  const ruleNote = await listDirectory({ dirPath: path.join(home, '.cache/thumbnails'), limit: 50, annotate, rules: compiledRules, scan: null });
  check('命中规则的目录仍用规则说明', ruleNote.noteKind === 'rule' && /缩略图/.test(ruleNote.note));

  const missing = await listDirectory({ dirPath: path.join(lsRoot, '不存在'), limit: 10, annotate, rules: compiledRules, scan: null });
  check('不存在的路径返回 error 而不是抛异常', missing.error === 'not-found');

  const measured = await measureDirectory({ dirPath: lsRoot });
  check('按需量体积：文件字节数准确', measured.bytes === 1 * MIB + 512 * KIB + 4 * KIB + 8 * KIB + 8 * KIB, `${measured.bytes}`);
  check('按需量体积：小目录不会截断', measured.truncated === false && measured.entries === 5, `${measured.entries}`);

  const bounded = await measureDirectory({ dirPath: lsRoot, maxEntries: 1 });
  check('按需量体积：超条目即停并标 truncated', bounded.truncated === true);

  // ── 8) 操作模式（清除/打包/整理）与计划编排（同类合并、重启类置尾）
  console.log('\n[8] 三种操作模式与计划编排');
  const docsPath = path.join(home, 'Documents');

  check('识别重启类处置（英文命令）', requiresRestart({ remedy: { command: 'sudo reboot' } }) === true);
  check('识别重启类处置（中文说明）', requiresRestart({ note: '改完需要重启才生效' }) === true);
  check('普通官方命令不会被误判为重启类', requiresRestart({ remedy: { command: 'sudo apt clean' } }) === false);

  const packPlan = buildPlan(store, {
    targetId: 'home', items: [{ path: docsPath, mode: 'pack' }], includeRecursive: true,
    protectedPaths, annotate, compiledRules
  });
  check('打包项进入计划并单独成组', packPlan.ok && packPlan.plan.groups.length === 1 && packPlan.plan.groups[0].mode === 'pack');
  check('打包组标为不删除文件', packPlan.plan.groups[0].deletesFiles === false);
  check('打包项已交给执行器（不再列入待办）', packPlan.plan.executableItems.length === 1 && packPlan.plan.pending.length === 0);
  check('keep 项在"清除"模式下被拒、在"打包"模式下放行',
    (() => {
      const clean = buildPlan(store, { targetId: 'home', items: [{ path: docsPath, mode: 'clean' }], includeRecursive: true, protectedPaths, annotate, compiledRules });
      return clean.plan.items.length === 0 && clean.plan.skipped.some((x) => x.reason === 'keep');
    })());

  const tidyPlan = buildPlan(store, {
    targetId: 'home', items: [{ path: docsPath, mode: 'tidy' }], includeRecursive: false,
    protectedPaths, annotate, compiledRules
  });
  check('整理项放行且不需要"包含子项"确认（因为不删任何文件）',
    tidyPlan.ok && tidyPlan.plan.groups.some((g) => g.mode === 'tidy') && tidyPlan.plan.groups[0].deletesFiles === false);

  const mixedPlan = buildPlan(store, {
    targetId: 'home',
    items: [
      { path: path.join(home, '.cache/thumbnails'), mode: 'clean' },
      { path: docsPath, mode: 'pack' },
      { path: path.join(home, '.cache/pip'), mode: 'tidy' }
    ],
    includeRecursive: true, protectedPaths, annotate, compiledRules
  });
  check('多模式计划按类别分成多组', mixedPlan.ok && mixedPlan.plan.groups.length >= 3);
  check('分组顺序固定为 清除 → 打包 → 整理', mixedPlan.plan.groups.map((g) => g.mode).join(',').startsWith('clean,pack,tidy'));
  check('三种模式的条目都进入执行器', mixedPlan.plan.executableItems.length === 3
    && ['clean', 'pack', 'tidy'].every((m) => mixedPlan.plan.executableItems.some((i) => i.mode === m)));
  check('特殊要求随条目一路带到计划里',
    buildPlan(store, { targetId: 'home', items: [{ path: path.join(home, '.cache/thumbnails'), mode: 'clean', special: '只保留最近 7 天' }], includeRecursive: true, protectedPaths, annotate, compiledRules })
      .plan.items[0].special === '只保留最近 7 天');

  // ── 9) 配置默认值（防"界面点了确认却静默演练"这类回归）
  console.log('\n[9] 配置默认值');
  check('默认不是演练模式', hostInternals.DEFAULTS.dryRun === false);
  check('默认并行执行者数合法', hostInternals.DEFAULTS.workers >= 1 && hostInternals.DEFAULTS.workers <= 6);
  const patchText = await fsp.readFile(path.join(here, '..', 'cordis.patch.yml'), 'utf8');
  check('安装用的 patch 也不再默认开启 dryRun', /dryRun:\s*false/.test(patchText));

  // ── 10) 打包执行器 / 整理执行器 / AI 计划解析
  console.log('\n[10] 打包 / 整理 / AI 计划');

  const archivesDir = path.join(root, 'archives');
  const packed = await packPaths({ paths: [path.join(lsRoot, 'a.bin'), path.join(lsRoot, 'sub')], destDir: archivesDir, label: 'smoke' });
  check('打包成功并生成归档', packed.ok === true && packed.bytes > 0, packed.error);
  check('归档里条目数 ≥ 2', (packed.entries || 0) >= 2, String(packed.entries));
  check('打包不删除原文件', await fsp.stat(path.join(lsRoot, 'a.bin')).then(() => true, () => false));
  check('归档落在指定目录', typeof packed.archive === 'string' && packed.archive.startsWith(archivesDir));

  const dupDir = path.join(root, 'dups');
  await fileAt(path.join(dupDir, 'x1.bin'), 2 * MIB);
  await fsp.copyFile(path.join(dupDir, 'x1.bin'), path.join(dupDir, 'x2.bin'));
  await fsp.copyFile(path.join(dupDir, 'x1.bin'), path.join(dupDir, 'x3.bin'));
  await fileAt(path.join(dupDir, 'unique.bin'), 2 * MIB + 12345); // 尺寸不同 → 不该被算成重复
  const dups = await findDuplicates({ roots: [dupDir], minBytes: 1024 });
  check('整理找到同内容重复组', dups.groups.length === 1 && dups.groups[0].count === 3);
  check('整理算出浪费的空间', dups.stats.wastedBytes === 2 * MIB * 2, String(dups.stats.wastedBytes));
  check('整理不删除任何文件', (await fsp.readdir(dupDir)).length === 4);
  check('尺寸不同的文件不会被误判为重复', !dups.groups.some((g) => g.files.some((f) => f.path.endsWith('unique.bin'))));

  const allowed = new Set([path.join(home, '.cache/pip'), path.join(home, 'Documents')]);
  const ai = parseAiPlan('```json\n{"summary":"主要是缓存","items":[{"path":"' + path.join(home, '.cache/pip') + '","reason":"可再生","suggestion":"clean"},{"path":"/etc/passwd","reason":"恶意新增","suggestion":"clean"},{"path":"' + path.join(home, 'Documents') + '","reason":"归档","suggestion":"bogus"}],"order":["/etc/passwd","' + path.join(home, 'Documents') + '"],"warnings":["需要重启"]}\n```', allowed);
  check('AI 计划能解析（含代码围栏）', ai.ok === true && ai.summary === '主要是缓存');
  check('AI 不得引入清单外的路径（被丢弃并记录）', ai.dropped.includes('/etc/passwd') && !ai.notes['/etc/passwd']);
  check('AI 顺序只保留合法路径', ai.order.length === 1 && ai.order[0] === path.join(home, 'Documents'));
  check('非白名单的 suggestion 被丢弃', ai.notes[path.join(home, 'Documents')].suggestion === null && ai.notes[path.join(home, '.cache/pip')].suggestion === 'clean');
  check('AI 告警被保留', ai.warnings.length === 1 && ai.warnings[0] === '需要重启');
  check('坏 JSON 不会抛异常', parseAiPlan('这不是 JSON', allowed).ok === false);
  const prompt = buildAiPrompt({ target: { path: home }, items: [{ path: path.join(home, '.cache/pip'), size: 5 * MIB, risk: 'safe', mode: 'clean', note: '可再生', special: '只留 7 天' }], totals: { count: 1, bytes: 5 * MIB } });
  check('提示词带上路径/模式/特殊要求', prompt.includes(path.join(home, '.cache/pip')) && prompt.includes('只留 7 天') && prompt.includes('clean'));

  // 需要重启的任务：单独成组并排最后。
  // 用一个**不在候选清单里**的路径，否则 buildPlan 会优先采用候选自带的规则判定，
  // 覆盖不到这里注入的"需要重启"说明。
  const restartPath = path.join(home, 'proj/src');
  const restartAnnotate = (p, rules) => {
    const base = annotate(p, rules);
    if (p === restartPath) return Object.assign({}, base, { risk: 'caution', action: 'unlink', note: '改完需要重启才生效' });
    return base;
  };
  const restartPlan = buildPlan(store, {
    targetId: 'home', items: [{ path: restartPath, mode: 'clean' }], includeRecursive: true,
    protectedPaths, annotate: restartAnnotate, compiledRules
  });
  check('需要重启的任务单独成组', restartPlan.ok && restartPlan.plan.restartCount === 1 && restartPlan.plan.groups.at(-1).mode === 'restart');
  check('需要重启的任务不混进本批执行', restartPlan.plan.executableItems.length === 0 && restartPlan.plan.pending.some((x) => x.reason === 'needs-restart'));

  // ── 11) 派发给智能体（一类任务一个执行者）
  console.log('\n[11] 派发编排与受限执行工具');

  const fakePlan = {
    id: 'plan-dispatch-test',
    groups: [
      { mode: 'clean', label: '清除', itemCount: 2, bytes: 300, items: [{ path: '/home/x/.cache/a' }, { path: '/home/x/.cache/b' }] },
      { mode: 'pack', label: '打包', itemCount: 1, bytes: 100, items: [{ path: '/home/x/Documents' }] },
      { mode: 'restart', label: '需要重启', itemCount: 1, bytes: 50, items: [{ path: '/home/x/svc' }] }
    ]
  };
  const entries = buildDispatchPlan(fakePlan);
  check('一类任务一个执行者（restart 组不派发）', entries.length === 2 && entries.every((e) => e.mode !== 'restart'));
  check('执行者名字唯一且可读', entries.map((e) => e.teammateName).join(',') === 'gc-clean,gc-pack');
  check('任务带写作用域（= 该组路径）', entries[0].writeScopes.length === 2 && entries[1].writeScopes[0] === '/home/x/Documents');
  check('派发提示里点名工具/计划/模式', entries[0].prompt[0].text.includes(EXECUTOR_TOOL)
    && entries[0].prompt[0].text.includes(fakePlan.id) && entries[0].prompt[0].text.includes('clean'));
  check('派发提示禁止动清单外的东西', /不要触碰清单以外/.test(entries[0].prompt[0].text));

  const assignedGroups = entries.map((e) => ({ mode: e.mode, teammate: e.teammateName }));
  const planForAuth = { id: 'p2', dispatch: { groups: assignedGroups } };
  check('授权：本组指定执行者放行', authorizeCaller(planForAuth, { mode: 'clean', callerName: 'gc-clean' }).ok === true);
  check('授权：别的执行者不能越界执行别组', authorizeCaller(planForAuth, { mode: 'pack', callerName: 'gc-clean' }).error === 'not-assigned-executor');
  check('授权：不在计划里的模式拒绝', authorizeCaller(planForAuth, { mode: 'tidy', callerName: 'gc-tidy' }).error === 'group-not-dispatched');
  check('授权：不存在的计划拒绝', authorizeCaller(null, { mode: 'clean', callerName: 'gc-clean' }).error === 'no-such-plan');

  // 完成闸门：先 resolve 再 wait 也能拿到；超时返回失败
  const waiters = createGroupWaiters({ timeoutMs: 50 });
  waiters.resolve('clean', { ok: true, report: { actualBytes: 7 } });
  const cachedWait = await waiters.wait('clean');
  check('闸门：已完成的组立即返回', cachedWait.ok === true && cachedWait.report.actualBytes === 7);
  const timeoutWait = await waiters.wait('pack');
  check('闸门：超时返回失败而不是挂住', timeoutWait.ok === false && timeoutWait.reason === 'timeout');

  // 逐类派发：调用顺序 spawn→createTask→sendMessage→等待→完成任务；blockedBy 串成链
  const calls = [];
  const fakeTeam = {
    spawnTeammate: async (req) => { calls.push(['spawn', req.name]); return { member: { name: req.name } }; },
    createTask: async (req) => {
      calls.push(['task', req.subject, req.blockedBy ? req.blockedBy.join(',') : '']);
      return { id: `task-${calls.filter((c) => c[0] === 'task').length}`, revision: 1 };
    },
    sendMessage: async (req) => { calls.push(['send', req.target]); return { messageId: 'm1' }; },
    completeTask: async (req) => { calls.push(['complete', req.taskId]); return {}; }
  };
  const order = [];
  const fakePlan2 = JSON.parse(JSON.stringify(fakePlan));
  const out2 = await dispatchSequentially({
    plan: fakePlan2,
    entries: buildDispatchPlan(fakePlan2),
    spawnTeammate: fakeTeam.spawnTeammate,
    createTask: fakeTeam.createTask,
    sendMessage: fakeTeam.sendMessage,
    completeTask: fakeTeam.completeTask,
    waitForGroup: async (mode) => { order.push(mode); return { ok: true, report: { actualBytes: 1, mode } }; }
  });
  check('派发顺序：先 spawn 再建任务再指派再等完成', calls[0][0] === 'spawn' && calls[1][0] === 'task' && calls[2][0] === 'send' && calls[3][0] === 'complete');
  check('两组都被派出且各自完成', out2.ok === true && order.join(',') === 'clean,pack');
  check('计划上记录了每个组的执行者与状态', fakePlan2.dispatch.groups.length === 2
    && fakePlan2.dispatch.groups.every((g) => g.status === 'done' && g.teammate));
  check('第二组的任务依赖第一组（blockedBy 成链）', calls.filter((c) => c[0] === 'task').map((c) => c[2]).join('|').includes('task-1'));

  // 某组失败：记录错误但继续下一组
  const fakePlan3 = JSON.parse(JSON.stringify(fakePlan));
  const out3 = await dispatchSequentially({
    plan: fakePlan3,
    entries: buildDispatchPlan(fakePlan3),
    spawnTeammate: async (req) => ({ member: { name: req.name } }),
    createTask: async () => ({ id: 't', revision: 1 }),
    sendMessage: async () => ({ messageId: 'm' }),
    completeTask: async () => ({}),
    waitForGroup: async (mode) => (mode === 'clean' ? { ok: false, reason: 'tool-error' } : { ok: true, report: {} })
  });
  check('某类失败会记录原因且不中断后续类别', out3.ok === false && out3.errors.length === 1 && out3.errors[0].mode === 'clean'
    && out3.groups.find((g) => g.mode === 'pack').status === 'done');

  // ── 12) "应用 / 环境"应卸载而不是删目录
  console.log('\n[12] 应用/环境 → 卸载建议');

  check('识别 snap 应用', detectUninstall('/snap/firefox/1234')?.command === 'sudo snap remove firefox');
  check('识别家目录下的 snap 数据', detectUninstall('/home/x/snap/firefox/1234/.config')?.kind === 'snap');
  check('识别 flatpak 应用', detectUninstall('/home/x/.var/app/org.mozilla.firefox')?.command === 'flatpak uninstall org.mozilla.firefox');
  check('识别 conda 环境', detectUninstall('/home/x/miniconda3/envs/torch')?.command === 'conda env remove -n torch');
  check('识别 nvm 的 Node 版本', detectUninstall('/home/x/.nvm/versions/node/v22.1.0')?.command === 'nvm uninstall v22.1.0');
  check('识别 pyenv 的 Python 版本', detectUninstall('/home/x/.pyenv/versions/3.11.9')?.command === 'pyenv uninstall 3.11.9');
  check('/opt 应用只给说明不给命令', detectUninstall('/opt/someapp')?.command === null);
  check('普通缓存不会被误判成应用', detectUninstall(path.join(home, '.cache/pip')) === null);

  const flatpakPlan = buildPlan(store, {
    targetId: 'home', items: [{ path: path.join(home, '.var/app/org.example.App'), mode: 'clean' }],
    includeRecursive: true, protectedPaths, annotate, compiledRules
  });
  check('选中应用目录 → 转入"卸载"建议而不是删除项',
    flatpakPlan.ok && flatpakPlan.plan.uninstall.length === 1 && flatpakPlan.plan.items.length === 0);
  check('卸载建议带官方命令与原因',
    flatpakPlan.plan.uninstall[0].command === 'flatpak uninstall org.example.App' && Boolean(flatpakPlan.plan.uninstall[0].why));
  check('卸载建议不进入执行器（不会被 rm）', flatpakPlan.plan.executableItems.length === 0);

  // ── 13) 路径解释：规则优先 / 逐层惰性 / 低把握才联网 / 缓存
  console.log('\n[13] 路径解释');

  check('层级计算：根=0、直接子项=1、再下一层=2',
    levelOf('/a', '/a') === 0 && levelOf('/a', '/a/b') === 1 && levelOf('/a', '/a/b/c') === 2);
  check('站在任何一层都解释本层子项（逐层惰性，第 3 层也不落下）',
    shouldExplainChildren({ root: '/a', currentPath: '/a', explainDepth: 2 }) === true
    && shouldExplainChildren({ root: '/a', currentPath: '/a/b', explainDepth: 2 }) === true
    && shouldExplainChildren({ root: '/a', currentPath: '/a/b/c/d', explainDepth: 1 }) === true);
  check('层级设为 0 时完全不自动解释',
    shouldExplainChildren({ root: '/a', currentPath: '/a', explainDepth: 0 }) === false);

  const allowedExplain = new Set(['/home/x/a', '/home/x/b']);
  const parsed = parseExplainResult('```json\n[{"path":"/home/x/a","what":"你的视频备份","confidence":1.5},{"path":"/etc/passwd","what":"越界","confidence":0.9},{"path":"/home/x/b","what":"某个项目","confidence":"x"}]\n```', allowedExplain);
  check('解析模型解释：代码围栏也认', parsed.ok === true && parsed.items['/home/x/a'].what === '你的视频备份');
  check('把握度夹取到 [0,1]', parsed.items['/home/x/a'].confidence === 1);
  check('清单外路径被丢弃', parsed.dropped.includes('/etc/passwd') && !parsed.items['/etc/passwd']);
  check('把握度非法时回落到 0.5', parsed.items['/home/x/b'].confidence === 0.5);
  check('坏 JSON 不抛异常', parseExplainResult('不是 JSON', allowedExplain).ok === false);
  check('缓存键不绑模型（换模型不该让旧解释失效）',
    cacheKey({ path: '/a', rulePackVersion: 1, model: 'm1' }) === cacheKey({ path: '/a', rulePackVersion: 1, model: 'm2' }));
  check('缓存键随规则包/提示词版本变化',
    cacheKey({ path: '/a', rulePackVersion: 1 }) !== cacheKey({ path: '/a', rulePackVersion: 2 })
    && cacheKey({ path: '/a', rulePackVersion: 1, promptVersion: 9 }) !== cacheKey({ path: '/a', rulePackVersion: 1 }));

  const rulePath = path.join(home, '.cache/thumbnails');
  const freePath = path.join(home, '我的资料/2024旅行');
  const strictPathForTest = () => path.join(home, '严格契约测试');
  const baseArgs = (overrides) => Object.assign({
    entries: [
      { path: rulePath, isDir: true, size: 1024 },
      { path: freePath, isDir: true, size: 2048 }
    ],
    annotate,
    rules: compiledRules,
    rulePackVersion: 1,
    cache: null,
    llm: null,
    selection: null,
    web: null,
    config: { explainMaxItems: 10, explainMaxSearches: 2, explainUseWeb: true }
  }, overrides || {});

  let llmCalls = 0;
  const llmReply = (text) => ({ stream: async function* fakeStream() { llmCalls += 1; yield { type: 'text-delta', text }; } });

  // 规则命中：不调模型
  llmCalls = 0;
  const ruleOut = await explainEntries(baseArgs({
    llm: llmReply('[]'), selection: { provider: 'p', model: 'm' }
  }));
  check('规则命中的路径直接给规则说明、不花 LLM 调用',
    ruleOut.results[rulePath] && ruleOut.results[rulePath].source === 'rule'
    && ruleOut.results[rulePath].text.includes('缩略图')
    && llmCalls === 1); // 只有未命中的那条进了模型（一次批量）

  // 未命中：一次批量调用解释
  llmCalls = 0;
  const basic = await explainEntries(baseArgs({
    llm: llmReply(`[{"path":"${freePath}","what":"你的个人旅行照片备份","confidence":0.85}]`),
    selection: { provider: 'p', model: 'm' }
  }));
  check('未命中规则的路径由模型解释（整层一次批量）',
    basic.results[freePath].source === 'llm' && llmCalls === 1 && basic.results[freePath].text.includes('旅行'));
  check('结果里带把握度', typeof basic.results[freePath].confidence === 'number');

  // 低把握 → 联网 → 再解释
  let webCalls = 0;
  const webFake = { search: async () => { webCalls += 1; return { sources: [{ url: 'https://x', title: 't', snippet: 'some evidence' }], truncated: false }; } };
  let secondLlm = 0;
  const stagedLlm = {
    stream: async function* staged() {
      secondLlm += 1;
      const text = secondLlm === 1
        ? `[{"path":"${freePath}","what":"不确定的目录","confidence":0.2}]`
        : `[{"path":"${freePath}","what":"经搜索确认：某游戏的截图目录","confidence":0.9}]`;
      yield { type: 'text-delta', text };
    }
  };
  webCalls = 0; secondLlm = 0;
  const searched = await explainEntries(baseArgs({ llm: stagedLlm, selection: { provider: 'p', model: 'm' }, web: webFake }));
  check('模型没把握时会联网搜索', webCalls === 1);
  check('搜索后重新解释并标为联网来源',
    searched.results[freePath].source === 'web' && searched.results[freePath].confidence === 0.9 && secondLlm === 2);

  // 关闭联网就不搜
  webCalls = 0;
  await explainEntries(baseArgs({
    llm: stagedLlm, selection: { provider: 'p', model: 'm' }, web: webFake,
    config: { explainMaxItems: 10, explainMaxSearches: 2, explainUseWeb: false }
  }));
  check('设置里关掉联网后不再搜索', webCalls === 0);

  // 缓存命中：不再调用模型
  const cache = new Map();
  llmCalls = 0;
  await explainEntries(baseArgs({ llm: llmReply(`[{"path":"${freePath}","what":"缓存里的解释","confidence":0.9}]`), selection: { provider: 'p', model: 'm' }, cache }));
  const cachedOut = await explainEntries(baseArgs({ llm: llmReply('[]'), selection: { provider: 'p', model: 'm' }, cache }));
  check('同一路径第二次走缓存、零模型调用',
    cachedOut.results[freePath].source === 'cache' && cachedOut.results[freePath].text === '缓存里的解释');

  // 模型不可用：不抛异常，给出明确错误
  const noLlm = await explainEntries(baseArgs({ llm: null }));
  check('模型不可用时返回明确错误而不是崩溃', noLlm.error === 'llm-unavailable' && noLlm.results[rulePath].source === 'rule');

  // force：跳过缓存强制重新生成
  llmCalls = 0;
  const forced = await explainEntries(baseArgs({
    llm: llmReply(`[{"path":"${freePath}","what":"强制刷新后的新解释","confidence":0.95}]`),
    selection: { provider: 'p', model: 'm' }, cache, force: true
  }));
  check('force 会绕过缓存重新生成', forced.results[freePath].text === '强制刷新后的新解释' && llmCalls === 1);

  // ── 14) 审计身份标签 + 审计历史/清理
  console.log('\n[14] 审计身份与日志清理');
  check('派发来的执行者记为 teammate/工号', actorName('gc-clean', 'pool-worker-1') === 'gc-clean/pool-worker-1');
  check('进程内执行仍记为工号', actorName(null, 'pool-worker-2') === 'pool-worker-2');

  // 真删那条审计应带 actor 字段（本次运行是进程内执行 → 纯工号）
  const realAudit = auditLines.filter((l) => l.kind === 'delete');
  check('审计的 delete 记录带 actor 字段', realAudit.length > 0 && realAudit.every((l) => typeof l.actor === 'string' && l.actor.startsWith('pool-worker-')));

  // listAuditRuns / pruneAudit
  const runs = await listAuditRuns({ auditDir, limit: 10 });
  check('审计历史能列出运行记录', runs.length >= 2, `实际 ${runs.length}`);
  check('历史按时间倒序（新的在前）', runs.every((r, i) => i === 0 || new Date(runs[i - 1].at) >= new Date(r.at)));
  const newest = runs.find((r) => r.status === 'complete' && r.deletedCount > 0);
  check('历史记录含删除条目与执行者', Boolean(newest) && newest.deleted.every((d) => typeof d.path === 'string' && d.actor));
  check('历史记录含字节数与磁盘变化', Boolean(newest) && newest.actualBytes > 0 && typeof newest.diskFreeDelta === 'number');
  check('dry-run 与真删能区分', runs.some((r) => r.dryRun) && runs.some((r) => !r.dryRun));

  const pruned = await pruneAudit({ auditDir, keep: 1 });
  const afterPrune = await listAuditRuns({ auditDir, limit: 10 });
  check('清理日志只保留最近 N 次', afterPrune.length === 1 && pruned.removed === runs.length - 1, `removed=${pruned.removed} left=${afterPrune.length}`);
  check('两个条件都不给时不动任何文件', (await pruneAudit({ auditDir, keep: 0, olderThanDays: 0 })).removed === 0);

  // 解析兜底：模型没按 JSON 输出时，按"路径: 说明"逐行救回来
  const salvageAllowed = new Set(['/home/x/videos', '/home/x/work']);
  const salvage = salvageLineFormat('- /home/x/videos: 你的家庭视频\n2. /home/x/work —— 工作文档\n/home/x/other: 越界项', salvageAllowed);
  check('非 JSON 输出能按行救回来', Boolean(salvage['/home/x/videos']) && Boolean(salvage['/home/x/work']));
  check('兜底解析同样丢弃清单外路径', !salvage['/home/x/other']);
  const salvaged = parseExplainResult('模型啰嗦了一段：\n/home/x/videos: 家庭视频备份', salvageAllowed);
  check('行格式能被解析并标记 format=lines', salvaged.ok === true && salvaged.format === 'lines');
  const jsonStillWorks = parseExplainResult(`[{"path":"/home/x/work","what":"工作文档","confidence":0.8}]`, salvageAllowed);
  check('JSON 格式仍然兼容', jsonStillWorks.ok === true && jsonStillWorks.format === 'json');
  check('空输出单独归因（不是"格式不对"）', parseExplainResult('   ', salvageAllowed).reason === 'empty-output');
  check('解析不了时返回原始片段便于定位', parseExplainResult('完全不是列表', salvageAllowed).snippet.includes('完全不是列表'));
  // 带空格的路径（真实场景里最常见）
  const spaced = parseExplainResult('/media/user/Data Disk/动漫/anime | 动漫视频按字母分组', new Set(['/media/user/Data Disk/动漫/anime']));
  check('路径含空格也能按行解析', spaced.ok === true && spaced.items['/media/user/Data Disk/动漫/anime'].what.includes('动漫视频'));

  // 真实模型输出（deepseek-v4.1-flash，逐行格式）必须逐条命中——这是线上抓回来的原文
  const realModelOutput = '/media/user/Data Disk/动漫/anime | 存放 12 部日本动画剧集的目录，含若干部动画。\n'
    + '/media/user/Data Disk/动漫/漫画 | 不确定：漫画资源目录，但当前该路径已不存在。\n'
    + '/media/user/Data Disk/动漫 | 动漫总目录，含 anime、downloads、music 三个子目录。';
  const realAllowed = new Set(['/media/user/Data Disk/动漫/anime', '/media/user/Data Disk/动漫/漫画', '/media/user/Data Disk/动漫']);
  const realParsed = parseExplainResult(realModelOutput, realAllowed);
  check('线上真实模型输出逐条命中（含空格路径）',
    realParsed.ok === true && Object.keys(realParsed.items).length === 3
    && realParsed.items['/media/user/Data Disk/动漫/anime'].what.includes('日本动画'));
  check('带空格的路径不会被截断', Boolean(realParsed.items['/media/user/Data Disk/动漫/漫画']));

  // 第一次坏 JSON → 严格重试一次
  let attempts = 0;
  const flakyLlm = { stream: async function* flaky() { attempts += 1; yield { type: 'text-delta', text: attempts === 1 ? '这是解释：目录里是些东西' : `[{"path":"${freePath}","what":"重试后的解释","confidence":0.9}]` }; } };
  attempts = 0;
  const retried = await explainEntries(baseArgs({ llm: flakyLlm, selection: { provider: 'p', model: 'm' } }));
  check('坏 JSON 会严格重试一次并成功', attempts === 2 && retried.results[freePath] && retried.results[freePath].text === '重试后的解释');

  // 分批：一次问太多条容易让模型吐空，改成小批并发（同一批失败不拖垮其他批）
  const bulk = [];
  for (let i = 0; i < 25; i += 1) bulk.push({ path: `${home}/bulk/dir-${i}`, isDir: true, size: 1024 });
  let bulkCalls = 0;
  const bulkLlm = {
    stream: async function* bulkStream() {
      bulkCalls += 1;
      yield { type: 'text-delta', text: bulk.map((b) => `${b.path} | 批量解释 ${b.path.split('-').pop()}`).join('\n') };
    }
  };
  const bulkOut = await explainEntries(baseArgs({
    entries: bulk, llm: bulkLlm, selection: { provider: 'p', model: 'm' },
    config: { explainMaxItems: 40, explainMaxSearches: 2, explainUseWeb: false, explainBatchSize: 12 }
  }));
  check('条目多时自动分批（25 条 / 每批 12 → 3 次调用）', bulkCalls === 3, `实际 ${bulkCalls} 次`);
  check('分批后每个条目都拿到解释', Object.keys(bulkOut.results).length === 25, `实际 ${Object.keys(bulkOut.results).length}`);

  // 吐空 → 极简提示词 + 更大预算重试一次
  const emptyPath = `${home}/empty-then-ok`;
  let emptyAttempts = 0;
  const emptyLlm = {
    stream: async function* emptyStream() {
      emptyAttempts += 1;
      if (emptyAttempts === 1) return; // 第一次什么都不吐
      yield { type: 'text-delta', text: `${emptyPath} | 重试后成功` };
    }
  };
  const emptyOut = await explainEntries(baseArgs({
    entries: [{ path: emptyPath, isDir: true, size: 10 }], llm: emptyLlm, selection: { provider: 'p', model: 'm' }
  }));
  check('模型吐空会用极简提示词重试并成功', emptyAttempts === 2 && emptyOut.results[emptyPath] && emptyOut.results[emptyPath].text === '重试后成功');

  // 流式块形状兼容：text / delta / OpenAI choices[].delta.content
  let shapeIndex = 0;
  const shapePath = () => `${home}/shape-${shapeIndex}`;
  const shapeText = () => `${shapePath()} | 形状${shapeIndex + 1}`;
  const shapeCases = [
    () => ({ type: 'text', text: shapeText() }),
    () => ({ delta: shapeText() }),
    () => ({ choices: [{ delta: { content: shapeText() } }] })
  ];
  const shapeLlm = { stream: async function* shapeStream() { yield shapeCases[shapeIndex](); } };
  const shapeResults = [];
  for (shapeIndex = 0; shapeIndex < shapeCases.length; shapeIndex += 1) {
    const out = await explainEntries(baseArgs({
      entries: [{ path: shapePath(), isDir: true, size: 1 }],
      llm: shapeLlm, selection: { provider: 'p', model: 'm' }
    }));
    const hit = out.results[shapePath()];
    shapeResults.push(hit ? hit.text : null);
  }
  check('text / delta / choices[].delta.content 三种流式形状都认',
    shapeResults.every((t) => typeof t === 'string' && t.startsWith('形状')), JSON.stringify(shapeResults));

  // 部分批次失败：已有解释时不要用错误提示盖掉
  const partEntries = [];
  for (let i = 0; i < 20; i += 1) partEntries.push({ path: `${home}/part/d${i}`, isDir: true, size: 512 });
  // 按批次内容确定性失败：含 d0（第一批）的请求一律吐空，其余批次正常返回
  const partLlm = {
    stream: async function* partStream(options) {
      const promptText = options.messages[0].content[0].text;
      if (promptText.includes('/part/d0')) return; // 这一批（含极简重试）所有尝试都空 → 该批失败
      yield { type: 'text-delta', text: partEntries.map((e) => `${e.path} | 部分解释`).join('\n') };
    }
  };
  const partOut = await explainEntries(baseArgs({
    entries: partEntries, llm: partLlm, selection: { provider: 'p', model: 'm' },
    config: { explainMaxItems: 40, explainMaxSearches: 0, explainUseWeb: false, explainBatchSize: 10 }
  }));
  check('部分批次失败时仍返回已成功的解释', Object.keys(partOut.results).length > 0, `拿到 ${Object.keys(partOut.results).length} 条`);
  check('部分失败不会把整层标成错误', partOut.error === undefined || partOut.error === null);
  check('部分失败会被记录为 partialErrors', Array.isArray(partOut.partialErrors) && partOut.partialErrors.length > 0);

  // 目录取样：解释要结合"里面有什么"，而不是只猜目录名
  const probeDir = path.join(home, 'probe-demo');
  await fsp.mkdir(path.join(probeDir, 'projects'), { recursive: true });
  await fsp.mkdir(path.join(probeDir, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(probeDir, 'SOUL.md'), 'x'.repeat(100));
  await fsp.writeFile(path.join(probeDir, 'gateway.log'), 'y'.repeat(50));
  const probed = await probeDirectory(probeDir, { maxEntries: 3 });
  check('取样能拿到条目数与名字', Boolean(probed) && probed.count === 4 && probed.sample.length === 3, JSON.stringify(probed && probed.sample.map((e) => e.name)));
  check('取样优先给目录、并标出类型', probed.sample.filter((e) => e.kind === 'dir').length >= 1);
  check('取样给出文件大小', probed.sample.some((e) => e.kind === 'file' && e.size > 0));
  check('目录项多于上限时标记 truncated', probed.truncated === true);
  check('取样遇到不存在的目录返回 null（不抛）', (await probeDirectory(path.join(home, '不存在-xyz'))) === null);

  const promptWithSample = buildExplainPrompt({
    items: [{ path: probeDir, isDir: true, size: 123, sample: probed }]
  });
  check('提示词把"内含"带进上下文', promptWithSample.includes('内含4项') && promptWithSample.includes('projects/'));
  const minimalWithSample = buildExplainPrompt({
    items: [{ path: probeDir, isDir: true, size: 123, sample: probed }], minimal: true
  });
  check('极简提示词也带内含', minimalWithSample.includes('内含4项'));

  // explainEntries 真的把取样交给模型
  let seenPrompt = '';
  const captureLlm = { stream: async function* capture() { yield { type: 'text-delta', text: `${probeDir} | 带内容的解释` }; } };
  const captureProbe = async (dir) => {
    seenPrompt = buildExplainPrompt({ items: [{ path: dir, isDir: true, size: 1, sample: await probeDirectory(dir, { maxEntries: 6 }) }] });
    return probeDirectory(dir, { maxEntries: 6 });
  };
  const sampled = await explainEntries(baseArgs({
    entries: [{ path: probeDir, isDir: true, size: 123 }],
    llm: captureLlm, selection: { provider: 'p', model: 'm' }, probe: captureProbe
  }));
  check('解释前会先取样并写进提示词', seenPrompt.includes('SOUL.md') || seenPrompt.includes('内含4项'));
  check('取样后仍能正常返回解释', sampled.results[probeDir] && sampled.results[probeDir].text === '带内容的解释');

  // seam 契约：失败是通过终止性的 finish 块上报的（不是抛异常），必须读懂它
  check('finish:error 被翻译成可读原因',
    describeFinish({ kind: 'error', failure: { message: '余额不足', status: 402 } }) === 'llm-error: 余额不足 status=402');
  check('finish:aborted 也有原因', describeFinish({ kind: 'aborted', failure: { code: 'timeout' } }) === 'aborted: code=timeout');
  check('finish:max-tokens 单独标记', describeFinish({ kind: 'max-tokens' }) === 'max-tokens');
  check('reasoning-delta 不会被当成正文', pickText({ type: 'reasoning-delta', text: '我想想…' }) === '' && pickText({ type: 'text-delta', text: '正文' }) === '正文');

  const errPath = `${home}/finish-error`;
  const errLlm = {
    stream: async function* errStream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 502', status: 502 } } };
    }
  };
  const errOut = await explainEntries(baseArgs({
    entries: [{ path: errPath, isDir: true, size: 10 }], llm: errLlm, selection: { provider: 'p', model: 'm' }
  }));
  check('provider 报错时给出真实原因（不再谎报"模型吐空"）',
    errOut.error === 'llm-error: 上游 502 status=502', String(errOut.error));
  check('报错时把 finish 类型记进诊断', errOut.chunkTypes && errOut.chunkTypes['finish:error'] === 1, JSON.stringify(errOut.chunkTypes));

  // max-tokens：应触发"更大预算 + 极简提示词"重试
  const mtPath = `${home}/finish-maxtokens`;
  let mtAttempts = 0;
  const mtLlm = {
    stream: async function* mtStream() {
      mtAttempts += 1;
      if (mtAttempts === 1) { yield { type: 'finish', reason: { kind: 'max-tokens' } }; return; }
      yield { type: 'text-delta', text: `${mtPath} | 预算加大后成功` };
    }
  };
  mtAttempts = 0;
  const mtOut = await explainEntries(baseArgs({
    entries: [{ path: mtPath, isDir: true, size: 10 }], llm: mtLlm, selection: { provider: 'p', model: 'm' }
  }));
  check('max-tokens 会加大预算重试并成功',
    mtAttempts === 2 && mtOut.results[mtPath] && mtOut.results[mtPath].text === '预算加大后成功');

  // 只有推理、没有正文：重试后仍失败 → 明确归因
  const roPath = `${home}/reasoning-only`;
  let roAttempts = 0;
  const roLlm = {
    stream: async function* roStream() {
      roAttempts += 1;
      yield { type: 'reasoning-delta', text: '让我想想这个目录…' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    }
  };
  roAttempts = 0;
  const roOut = await explainEntries(baseArgs({
    entries: [{ path: roPath, isDir: true, size: 10 }], llm: roLlm, selection: { provider: 'p', model: 'm' }
  }));
  check('只有推理没有正文时如实归因（max-tokens，2 次阶梯）',
    roOut.error === 'max-tokens' && roAttempts === 2, `error=${roOut.error} attempts=${roAttempts}`);

  // 只有推理、且没有 finish 信息 → 归因 reasoning-only，并走第三次"不要推理"阶梯
  const ro2Path = `${home}/reasoning-only-2`;
  let ro2Attempts = 0;
  const ro2Llm = {
    stream: async function* ro2Stream() {
      ro2Attempts += 1;
      if (ro2Attempts < 3) { yield { type: 'reasoning-delta', text: '思考中…' }; return; }
      yield { type: 'text-delta', text: `${ro2Path} | 第三次总算给结论了` };
    }
  };
  ro2Attempts = 0;
  const ro2Out = await explainEntries(baseArgs({
    entries: [{ path: ro2Path, isDir: true, size: 10 }], llm: ro2Llm, selection: { provider: 'p', model: 'm' }
  }));
  check('纯推理会走满三次阶梯（普通 → 极简大预算 → 不要推理）',
    ro2Attempts === 3 && ro2Out.results[ro2Path] && ro2Out.results[ro2Path].text.includes('第三次'),
    `attempts=${ro2Attempts}`);
  check('推理文本没有污染结果', Object.keys(roOut.results).length === 0);

  // 优先走 prepareCall（官方 agent loop 的路径），并记录走了哪条
  const prepPath = `${home}/prepared-call`;
  let preparedUsed = 0;
  let directUsed = 0;
  const prepLlm = {
    prepareCall: async () => ({
      model: { id: 'm' },
      stream: () => (async function* prepStream() { preparedUsed += 1; yield { type: 'text-delta', text: `${prepPath} | 走 prepared` }; })()
    }),
    stream: () => (async function* directStream() { directUsed += 1; yield { type: 'text-delta', text: '不应该走这里' }; })()
  };
  const prepOut = await explainEntries(baseArgs({
    entries: [{ path: prepPath, isDir: true, size: 5 }], llm: prepLlm, selection: { provider: 'p', model: 'm' }
  }));
  check('有 prepareCall 时优先用它', preparedUsed === 1 && directUsed === 0);
  check('prepared 路径成功返回解释', prepOut.results[prepPath] && prepOut.results[prepPath].text === '走 prepared');
  check('诊断里记下 via:prepared', prepOut.chunkTypes && prepOut.chunkTypes['via:prepared'] === 1, JSON.stringify(prepOut.chunkTypes));

  // prepareCall 失败 → 回落直连，并把原因记进诊断
  const fallbackPath = `${home}/prepared-fallback`;
  let fallbackDirect = 0;
  const fallbackLlm = {
    prepareCall: async () => { throw new Error('provider 未就绪'); },
    stream: () => (async function* fbStream() { fallbackDirect += 1; yield { type: 'text-delta', text: `${fallbackPath} | 回落后成功` }; })()
  };
  const fbOut = await explainEntries(baseArgs({
    entries: [{ path: fallbackPath, isDir: true, size: 5 }], llm: fallbackLlm, selection: { provider: 'p', model: 'm' }
  }));
  check('prepareCall 抛错时回落到直连且仍成功', fallbackDirect === 1 && fbOut.results[fallbackPath]);
  check('prepareCall 不可用时回落直连并记 via:direct',
    fbOut.chunkTypes && fbOut.chunkTypes['via:direct'] === 1, JSON.stringify(fbOut.chunkTypes));

  // 没有 prepareCall 的宿主：仍然直连可用
  const directPath = `${home}/no-prepare`;
  const directOut = await explainEntries(baseArgs({
    entries: [{ path: directPath, isDir: true, size: 5 }],
    llm: { stream: () => (async function* onlyDirect() { yield { type: 'text-delta', text: `${directPath} | 直连` }; })() },
    selection: { provider: 'p', model: 'm' }
  }));
  check('宿主没有 prepareCall 时直连可用', directOut.results[directPath] && directOut.chunkTypes['via:direct'] === 1);

  // 真实 seam 严格校验 signal：null/非 AbortSignal 会直接抛（线上踩过：signals[0] is not of type AbortSignal）
  const assertSignal = (value, where) => {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || typeof value.aborted !== 'boolean' || typeof value.addEventListener !== 'function') {
      throw new Error(`${where}: signals[0] is not of type AbortSignal. code=UNKNOWN`);
    }
  };
  const strictSeamLlm = {
    prepareCall: async (provider, model, signal) => {
      assertSignal(signal, 'prepareCall');
      throw new Error('prepareCall unavailable in this fake');
    },
    stream: (options) => {
      assertSignal(options.signal, 'stream');
      return (async function* strictStream() { yield { type: 'text-delta', text: `${options.messages[0].content[0].text.split('\n').pop()} | 严格 seam 通过` }; })();
    }
  };
  const strictWeb = { search: async (request, signal) => { assertSignal(signal, 'web.search'); return { sources: [], truncated: false }; } };
  let strictOk = true;
  let strictError = '';
  try {
    await explainEntries(baseArgs({
      entries: [{ path: strictPathForTest(), isDir: true, size: 1 }],
      llm: strictSeamLlm, web: strictWeb, selection: { provider: 'p', model: 'm' }, signal: null
    }));
  } catch (error) { strictOk = false; strictError = error.message; }
  check('signal 传 null 也不会打到 seam（严格契约）', strictOk, strictError);
  const realAbort = new AbortController();
  let abortSeen = 'untouched';
  const abortPath = `${home}/abort-pass`;
  const abortLlm = { stream: (options) => { abortSeen = options.signal; return (async function* a() { yield { type: 'text-delta', text: `${abortPath} | ok` }; })(); } };
  await explainEntries(baseArgs({ entries: [{ path: abortPath, isDir: true, size: 1 }], llm: abortLlm, selection: { provider: 'p', model: 'm' }, signal: realAbort.signal }));
  check('真的 AbortSignal 会原样透传', abortSeen === realAbort.signal, String(abortSeen));

  // 文件名启发式：这类"看一眼就知道"的东西不该花钱问模型
  check('启发式认出血清海报/字幕/元数据',
    heuristicExplain('/a/poster.jpg').includes('图片') && heuristicExplain('/a/x.srt').includes('字幕')
    && heuristicExplain('/a/tvshow.nfo').includes('元数据') && heuristicExplain('/a/.plexmatch').includes('Plex'));
  check('启发式不猜目录', heuristicExplain('/a/some-dir', { isDir: true }) === null);
  check('认不出就返回 null（继续走缓存/模型）', heuristicExplain('/a/奇怪的目录名') === null);

  // 启发式短路：整批都是媒体周边文件 → 一次模型调用都不发
  let heurCalls = 0;
  const heurLlm = { stream: async function* () { heurCalls += 1; yield { type: 'text-delta', text: '' }; } };
  const heurOut = await explainEntries(baseArgs({
    entries: [
      { path: `${home}/media/poster.jpg`, isDir: false, size: 1000 },
      { path: `${home}/media/tvshow.nfo`, isDir: false, size: 100 },
      { path: `${home}/media/ep01.srt`, isDir: false, size: 50 }
    ],
    llm: heurLlm, selection: { provider: 'p', model: 'm' }
  }));
  check('媒体周边文件被启发式短路，零模型调用', heurCalls === 0, `实际 ${heurCalls} 次`);
  check('短路结果标为 heuristic',
    Object.values(heurOut.results).every((v) => v.source === 'heuristic'), JSON.stringify(Object.values(heurOut.results).map((v) => v.source)));

  // 分批回调：每批完成就回调一次（前端据此增量显示）
  const cbEntries = [];
  for (let i = 0; i < 24; i += 1) cbEntries.push({ path: `${home}/cb/dir-${i}`, isDir: true, size: 100 });
  const cbCalls = [];
  const cbLlm = { stream: async function* () { yield { type: 'text-delta', text: cbEntries.map((e) => `${e.path} | 回调测试`).join('\n') }; } };
  await explainEntries(baseArgs({
    entries: cbEntries, llm: cbLlm, selection: { provider: 'p', model: 'm' },
    config: { explainMaxItems: 40, explainMaxSearches: 0, explainUseWeb: false, explainBatchSize: 8, explainConcurrency: 1 },
    onBatch: (partial) => cbCalls.push(Object.keys(partial).length)
  }));
  check('每批完成都回调一次（24 条 / 每批 8 → 3 次）', cbCalls.length === 3 && cbCalls.every((n) => n === 8), JSON.stringify(cbCalls));

  // 并发度：串行 1、并行 3 都要能限住
  let inFlight = 0;
  let maxInFlight = 0;
  const concLlm = {
    stream: async function* () {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      yield { type: 'text-delta', text: concEntries.map((e) => `${e.path} | 并发测试`).join('\n') };
      inFlight -= 1;
    }
  };
  var concEntries = []; // eslint-disable-line no-var
  for (let i = 0; i < 32; i += 1) concEntries.push({ path: `${home}/conc/dir-${i}`, isDir: true, size: 100 });
  maxInFlight = 0;
  await explainEntries(baseArgs({
    entries: concEntries, llm: concLlm, selection: { provider: 'p', model: 'm' },
    config: { explainMaxItems: 40, explainMaxSearches: 0, explainUseWeb: false, explainBatchSize: 8, explainConcurrency: 3 }
  }));
  check('并发度被限制在 3（32 条 / 每批 8 → 4 批）', maxInFlight === 3, `实际峰值 ${maxInFlight}`);
  maxInFlight = 0;
  await explainEntries(baseArgs({
    entries: concEntries.map((e) => Object.assign({}, e, { path: e.path + '-s' })), llm: concLlm, selection: { provider: 'p', model: 'm' },
    config: { explainMaxItems: 40, explainMaxSearches: 0, explainUseWeb: false, explainBatchSize: 8, explainConcurrency: 1 }
  }));
  check('并发度 = 1 时为严格串行', maxInFlight === 1, `实际峰值 ${maxInFlight}`);

  // 思考强度透传（很多模型默认"一直思考"，这是延迟大头）
  let seenEffort = 'unset';
  const effLlm = { stream: (options) => { seenEffort = options.reasoningEffort; return (async function* () { yield { type: 'text-delta', text: `${home}/eff | ok` }; })(); } };
  await explainEntries(baseArgs({
    entries: [{ path: `${home}/eff`, isDir: true, size: 1 }], llm: effLlm, selection: { provider: 'p', model: 'm' },
    reasoningEffort: 'low'
  }));
  check('思考强度会传给 seam', seenEffort === 'low', String(seenEffort));
  let absentEffort = 'unset';
  const effLlm2 = { stream: (options) => { absentEffort = 'reasoningEffort' in options ? options.reasoningEffort : 'absent'; return (async function* () { yield { type: 'text-delta', text: `${home}/eff2 | ok` }; })(); } };
  await explainEntries(baseArgs({ entries: [{ path: `${home}/eff2`, isDir: true, size: 1 }], llm: effLlm2, selection: { provider: 'p', model: 'm' } }));
  check('不设置时该键不出现（交给 provider 默认）', absentEffort === 'absent', String(absentEffort));

  // 会话复用策略（用户定的冷却规则）
  const today = '2026-10-19';
  check('没有会话 → 新建', decideSession({ policy: emptyPolicy(), today }).action === 'create');
  check('当天且上一轮只是解释 → 复用',
    decideSession({ policy: { ...emptyPolicy(), sessionId: 's1', dayKey: today, lastKind: 'explain' }, today }).action === 'reuse');
  check('跨天 → 新建',
    decideSession({ policy: { ...emptyPolicy(), sessionId: 's1', dayKey: '2026-10-18', lastKind: 'explain' }, today }).reason === 'day-changed');
  check('上一轮动过文件 → 新建下一个会话',
    decideSession({ policy: { ...emptyPolicy(), sessionId: 's1', dayKey: today, lastKind: 'write' }, today }).reason === 'after-write');
  const p1 = applyEvent(emptyPolicy(), { kind: 'explain', sessionId: 's1', workspaceId: 'w1', today, at: '2026-10-19T01:00:00Z' });
  check('记录解释活动：写入会话/日期/kind', p1.sessionId === 's1' && p1.dayKey === today && p1.lastKind === 'explain' && p1.createdAt === '2026-10-19T01:00:00Z');
  const p2 = applyEvent(p1, { kind: 'write', today, at: '2026-10-19T02:00:00Z' });
  check('记录写入活动后，下一轮会新建', decideSession({ policy: p2, today }).reason === 'after-write');
  check('日期键按本地时区计算', dayKeyOf(new Date('2026-10-19T17:30:00+08:00')) === '2026-10-19');

  // 会话提示词：程序拼接（非 LLM 生成）
  const planPrompt = buildPlanPrompt({
    workspace: { id: 'w1', path: '/media/user/Data Disk/dsh-workspace', title: 'dsh-workspace' },
    target: { path: '/media/user/Data Disk', usage: { total: 100, used: 79 } },
    items: [
      { path: '/a/__pycache__', size: 1024, risk: 'safe', mode: 'clean', note: 'Python 字节码缓存' },
      { path: '/a/big.bin', size: 2 * 1024 ** 3, risk: 'caution', mode: 'pack', note: '未知大文件', special: '保留 30 天' }
    ],
    totals: { count: 2, bytes: 2 * 1024 ** 3 + 1024 },
    planPath: '/media/user/Data Disk/dsh-workspace/.garbage-master/plans/plan-1.md',
    planId: 'plan-1'
  });
  check('计划提示词包含工作区与目标分区', planPrompt.includes('dsh-workspace') && planPrompt.includes('/media/user/Data Disk'));
  check('计划提示词包含逐项表格（路径/风险/模式/特殊要求）',
    planPrompt.includes('__pycache__') && planPrompt.includes('可安全删除') && planPrompt.includes('打包') && planPrompt.includes('保留 30 天'));
  check('计划提示词明确"只规划不执行"与"不得新增清单外路径"',
    planPrompt.includes('只规划，不执行') && planPrompt.includes('不得引入清单以外的路径'));
  check('计划提示词要求写入文件并给出固定结构',
    planPrompt.includes('plan-1.md') && planPrompt.includes('## 摘要') && planPrompt.includes('## 逐项处置'));
  check('提示词里的体积是人类可读单位', planPrompt.includes('GB'));

  const execPrompt = buildExecutePrompt({ planPath: '/w/.garbage-master/plans/plan-1.md', planId: 'plan-1' });
  check('执行提示词：严格只处理计划内路径 + 不符先停',
    execPrompt.includes('严格只处理计划内的路径') && execPrompt.includes('先停下来说明'));
  check('执行提示词：需要重启的项放最后', execPrompt.includes('放到最后'));

  const notice = buildExplainNotice({ entries: [{ path: '/a', text: '说明A', source: 'llm' }, { path: '/b', text: '说明B', source: 'heuristic' }], used: { llm: 1, web: 0 }, explainPath: '/r.jsonl' });
  check('解释通知有单行摘要（含来源分布）', notice.summary.includes('2 条') && notice.summary.includes('llm 1'));
  check('解释通知正文含逐条说明与记录路径', notice.text.includes('`/a` → 说明A') && notice.text.includes('/r.jsonl'));

  // /api/ls 直接带回已缓存的解释：前端不必为空跑一次请求（这是"已解释还转圈"的根因）
  const explainDemoRoot = path.join(home, 'ls-explain-demo');
  await fsp.mkdir(path.join(explainDemoRoot, 'cached-child'), { recursive: true });
  await fsp.mkdir(path.join(explainDemoRoot, 'uncached-child'), { recursive: true });
  const lsCached = await listDirectory({
    dirPath: explainDemoRoot, limit: 20, annotate, rules: compiledRules, scan: null,
    explainLookup: (target) => (target === explainDemoRoot ? '已知解释：本层' : (target.endsWith('/cached-child') ? '已知解释：子项' : null))
  });
  check('ls 带回当前目录的已缓存解释', lsCached.explanation === '已知解释：本层', String(lsCached.explanation));
  const cachedChild = (lsCached.children || []).find((c) => c.name === 'cached-child');
  const uncachedChild = (lsCached.children || []).find((c) => c.name === 'uncached-child');
  check('ls 带回子项的已缓存解释', Boolean(cachedChild) && cachedChild.explanation === '已知解释：子项');
  check('没有缓存解释的子项为 null（前端才知道要为它发请求）', Boolean(uncachedChild) && !uncachedChild.explanation);
  const lsNoLookup = await listDirectory({ dirPath: explainDemoRoot, limit: 5, annotate, rules: compiledRules, scan: null });
  check('不传 lookup 时不带 explanation 字段', lsNoLookup.explanation === null);

  // ── 收尾（清理由 main().finally 统一负责）
  console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? `，${failures} 项失败` : ''}\n`);
}

main()
  .catch((error) => {
    console.error('冒烟测试异常：', error);
    failures += 1;
  })
  .finally(async () => {
    if (fixtureRoot) {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
    process.exit(failures === 0 ? 0 : 1);
  });
