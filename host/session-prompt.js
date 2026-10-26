/**
 * GarbageMaster — 交给 DSH 会话的提示词模板。
 *
 * 重要：这里的文字**全部由程序拼接**（没有第二次 LLM 生成），
 * 会话里的大模型只负责"读这份材料 → 产出/执行计划"。
 */

const MODE_TEXT = { clean: '清理（直接删除）', pack: '打包（压缩成一个归档）', tidy: '整理（只统计重复，不删）' };
const RISK_TEXT = { safe: '可安全删除', caution: '需你确认', keep: '建议保留', blocked: '不可删除' };

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function cell(text, max = 60) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return s.length > max ? `${s.slice(0, max)}…` : (s || '-');
}

/**
 * 计划阶段的提示词（只读、只规划）。
 */
export function buildPlanPrompt({
  workspace = null, target = null, items = [], totals = null, planPath, planId,
  explainDigest = null, maxItems = 60
} = {}) {
  const sorted = items.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  const picked = sorted.slice(0, maxItems);
  const omitted = sorted.length - picked.length;
  const lines = [];
  lines.push('# GarbageMaster 清理计划请求');
  lines.push('');
  lines.push('你现在在为用户生成一份**清理计划**。当前是**只读的计划阶段**：');
  lines.push('不要删除/打包/整理任何东西，也不要调用会改动文件系统的工具；为了判断内容，你可以只读地列目录或读文件。');
  lines.push('');
  lines.push('## 绑定工作区');
  lines.push(workspace ? `- ${workspace.title || '(未命名)'}：\`${workspace.path}\`` : '- （未绑定，按当前会话工作目录处理）');
  lines.push('');
  lines.push('## 本次目标');
  lines.push(`- 计划 id：\`${planId || '-'}\``);
  lines.push(target ? `- 目标分区：\`${target.path}\`${target.usage ? `（已用 ${usageText(target.usage)}）` : ''}` : '- 目标分区：-');
  lines.push(`- 勾选条目：${totals && totals.count != null ? totals.count : items.length} 项，合计 ${fmtBytes(totals && totals.bytes != null ? totals.bytes : sorted.reduce((s, x) => s + (Number(x.size) || 0), 0))}`);
  if (omitted > 0) lines.push(`- （另有 ${omitted} 个较小条目未列出，不必提及）`);
  lines.push('');
  lines.push('## 待处理条目');
  lines.push('| # | 路径 | 体积 | 风险档 | 用户选择的模式 | 规则说明 | 用户特殊要求 |');
  lines.push('|---|------|------|--------|----------------|----------|--------------|');
  picked.forEach((item, index) => {
    lines.push(`| ${index + 1} | \`${cell(item.path, 90)}\` | ${fmtBytes(item.size)} | ${RISK_TEXT[item.risk] || item.risk || '-'} | ${MODE_TEXT[item.mode] || item.mode || '清理（直接删除）'} | ${cell(item.note, 60)} | ${cell(item.special, 50)} |`);
  });
  if (explainDigest) {
    lines.push('');
    lines.push('## 已生成的路径解释（程序汇总，供你参考）');
    lines.push(explainDigest);
  }
  lines.push('');
  lines.push('## 约束（必须遵守）');
  lines.push('1. **只规划，不执行**；不要真的删除、打包或改动任何文件；');
  lines.push('2. **不得引入清单以外的路径**，也不要承诺删除清单外的东西；');
  lines.push('3. 不可逆或影响系统的处置必须显式标注：应用/运行时应"卸载"而不是删目录、需要重启或重新登录的项要写明；');
  lines.push('4. 给出**执行顺序**：哪些可以并行、哪些必须串行、需要重启的项放最后；');
  lines.push('5. 每一项都要说明**为什么可以这样处置**（依据规则说明，或你自己读到的目录内容）；');
  lines.push('6. 给出**预计可释放空间**（按条目体积汇总，标出哪些是"打包后才会释放"）。');
  lines.push('');
  lines.push('## 输出要求');
  if (planPath) {
    lines.push(`1. 把**完整计划**写入文件：\`${planPath}\`（Markdown；目录不存在就创建）；`);
    lines.push('2. 在回复正文里**同样输出完整计划**（不要只说"已写入文件"）；');
  } else {
    lines.push('1. 在回复正文里输出**完整计划**（Markdown）。');
  }
  lines.push('3. 计划结构固定为：');
  lines.push('   - `## 摘要`：这次要做什么、预计释放多少、有没有风险点；');
  lines.push('   - `## 分组与顺序`：按执行顺序列出分组（清理/打包/整理/需要重启），注明并行还是串行；');
  lines.push('   - `## 逐项处置`：表格（路径 / 处置 / 理由 / 风险）；');
  lines.push('   - `## 需要你确认的点`：不确定或影响较大的地方；');
  lines.push('   - `## 预计释放空间`：合计与分项。');
  return lines.join('\n');
}

/** 二次确认后的执行提示词（同一个会话继续）。 */
export function buildExecutePrompt({ planPath, planId, workspace = null } = {}) {
  const lines = [];
  lines.push('# 按计划执行');
  lines.push('');
  lines.push(`用户已确认计划 \`${planId || '-'}\`${planPath ? `（文件：\`${planPath}\`）` : ''}，现在可以执行。`);
  if (workspace) lines.push(`当前工作区：\`${workspace.path}\``);
  lines.push('');
  lines.push('## 执行要求');
  lines.push('1. **严格只处理计划内的路径**；发现清单外的东西一律不动；');
  lines.push('2. 与计划不符的情况（文件已变化、权限不足、路径不存在、正在被占用）**先停下来说明**，不要自行扩大范围或换方案；');
  lines.push('3. 不可逆操作（删除）开始前，先在会话里说明你要做什么、为什么；');
  lines.push('4. 需要重启/重新登录的项**放到最后**，并在开始时先说明；');
  lines.push('5. 结束后逐项汇报：处理了什么、释放或归档了多少空间、哪些失败及原因；');
  lines.push('6. 干完活给出一个简短总结（成功/失败/释放空间），便于用户核对。');
  return lines.join('\n');
}

/** 写进会话的"解释已完成"通知（一行摘要 + 明细）。 */
export function buildExplainNotice({ entries = [], used = null, target = null, explainPath = null } = {}) {
  const bySource = {};
  for (const item of entries) bySource[item.source || 'llm'] = (bySource[item.source || 'llm'] || 0) + 1;
  const sourceText = Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join('、');
  const summary = `路径解释：${entries.length} 条（${sourceText || '无'}）`;
  const lines = [summary];
  for (const item of entries.slice(0, 40)) {
    lines.push(`- \`${item.path}\` → ${item.text}`);
  }
  if (entries.length > 40) lines.push(`- …另有 ${entries.length - 40} 条`);
  if (used) lines.push(`（模型调用 ${used.llm || 0} 次、联网 ${used.web || 0} 次${target ? `；目标 ${target}` : ''}）`);
  if (explainPath) lines.push(`（完整记录：${explainPath}）`);
  return { summary, text: lines.join('\n') };
}

function usageText(usage) {
  const total = Number(usage && usage.total) || 0;
  const used = Number(usage && usage.used) || 0;
  if (!total) return '容量未知';
  return `已用 ${Math.round((used / total) * 100)}%，剩余 ${fmtBytes(total - used)}`;
}
