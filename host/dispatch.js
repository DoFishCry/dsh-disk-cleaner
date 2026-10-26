/**
 * GarbageMaster — 派发给智能体（Agent Teams）。
 *
 * 设计（对应设计文档 §9 / J1）：
 *  - **一个子代理只负责一类任务**：clean / pack / tidy 各一个 teammate，互不越界。
 *  - 子代理不直接动文件系统，它**只能调用一个受限工具** `garbage_run_group`；
 *    真正的删除/打包/去重仍由插件里那套带**路径租约 + 审计**的执行器完成。
 *    这样"谁能删什么"由资源层强制，而不是靠提示词自觉。
 *  - 同类操作合并成批（一次工具调用处理该组全部条目），不逐个路径派发。
 *  - 需要重启的任务（plan.groups 里的 'restart' 组）**不派发**，留待用户单独处理。
 *  - 派发顺序固定：先 pack → 再 clean → 最后 tidy（整理在删除之后，避免重复项被重复计算）；
 *    每一组的完成由工具回报触发，然后才派下一组。
 *  - 团队不可用（没有 agentTeams / 解析不到 Lead / spawn 失败）时**降级为进程内执行器**，
 *    用同一份计划、同一套租约与审计，并明确告知界面。
 */

export const EXECUTOR_TOOL = 'garbage_run_group';

const MODE_TEXT = {
  clean: '清除（删除）',
  pack: '打包（压缩成一个归档，不删原文件）',
  tidy: '整理（只统计重复文件，不删任何文件）'
};

/** 该组是否可派发（需要重启的组不派发）。 */
export function dispatchableGroups(plan) {
  return (plan.groups || []).filter((group) => group.mode !== 'restart' && group.itemCount > 0);
}

/**
 * 把计划翻译成"派发清单"（纯函数，可测试）。
 * @returns {Array<{mode:string,label:string,teammateName:string,itemCount:number,bytes:number,writeScopes:string[],task:{subject:string,description:string},prompt:{type:'text',text:string}[],order:number}>}
 */
export function buildDispatchPlan(plan, { toolName = EXECUTOR_TOOL } = {}) {
  return dispatchableGroups(plan).map((group, index) => {
    const paths = (group.items || []).map((item) => item.path);
    const teammateName = `gc-${group.mode}`;
    const label = MODE_TEXT[group.mode] || group.mode;
    const promptText = [
      `你是清理计划的「${label}」类执行者，只负责这一类任务。`,
      `计划 id：${plan.id}；本组 ${group.itemCount} 项、共 ${group.bytes} 字节。`,
      `唯一要做的事：调用工具 ${toolName}，参数 {"planId":"${plan.id}","mode":"${group.mode}"}，**恰好调用一次**。`,
      '不要使用 bash / write / edit / 任何其它工具；不要触碰清单以外的任何路径；不要自行判断该删什么。',
      '工具返回后，用一两句话汇报：处理了多少项、成功/失败各多少、释放或归档了多少空间。'
    ].join('\n');
    return {
      mode: group.mode,
      label,
      teammateName,
      itemCount: group.itemCount,
      bytes: group.bytes,
      writeScopes: paths.slice(0, 200),
      task: {
        subject: `[${plan.id}] ${label} ${group.itemCount} 项`,
        description: [
          `计划 ${plan.id} 的 ${label} 分组。`,
          `涉及条目 ${group.itemCount} 个，合计 ${group.bytes} 字节。`,
          `执行方式：调用 ${toolName}(${plan.id}, ${group.mode})，只能调用一次。`,
          `范围（前 20 条）：`,
          ...paths.slice(0, 20)
        ].join('\n')
      },
      prompt: [{ type: 'text', text: promptText }],
      order: index
    };
  });
}

/** 每组一个"完成闸门"：派发方 await，工具执行完 resolve。 */
export function createGroupWaiters({ timeoutMs = 15 * 60 * 1000 } = {}) {
  const waiters = new Map();
  const results = new Map();
  return {
    results,
    /** 等待某组完成；已完成的组立即返回。 */
    wait(mode) {
      if (results.has(mode)) return Promise.resolve(results.get(mode));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(mode);
          resolve({ ok: false, reason: 'timeout' });
        }, Math.max(10, timeoutMs));
        waiters.set(mode, (value) => { clearTimeout(timer); resolve(value); });
      });
    },
    /** 工具侧调用：标记该组完成并唤醒等待者。 */
    resolve(mode, value) {
      if (results.has(mode)) return;
      results.set(mode, value);
      const waiter = waiters.get(mode);
      if (waiter) { waiters.delete(mode); waiter(value); }
    }
  };
}

/** 判断某个调用方是否是本计划该组的指定执行者（工具侧鉴权）。 */
export function authorizeCaller(plan, { mode, callerName }) {
  if (!plan) return { ok: false, error: 'no-such-plan' };
  const assigned = ((plan.dispatch && plan.dispatch.groups) || []).find((g) => g.mode === mode);
  if (!assigned) return { ok: false, error: 'group-not-dispatched' };
  if (!callerName || callerName !== assigned.teammate) return { ok: false, error: 'not-assigned-executor' };
  return { ok: true, assigned };
}

/**
 * 逐类派发给团队。每一组：spawn teammate → 建任务 → 发指派 → 等该组完成 → 完成任务。
 * @param {object} params
 * @param {object} params.plan 计划
 * @param {Function} params.spawnTeammate (req) => Promise<{member}>
 * @param {Function} params.createTask (req) => Promise<object>
 * @param {Function} params.sendMessage (req) => Promise<object>
 * @param {Function} params.completeTask (req) => Promise<object>
 * @param {Function} params.waitForGroup (mode) => Promise<{ok, reason?}>
 */
export async function dispatchSequentially({
  plan, entries, spawnTeammate, createTask, sendMessage, completeTask, waitForGroup, onEvent
}) {
  const assigned = [];
  const errors = [];
  plan.dispatch = { planId: plan.id, groups: [], results: {}, startedAt: Date.now() };
  let previousTaskId = null;

  for (const entry of entries) {
    try {
      if (typeof onEvent === 'function') onEvent({ type: 'dispatch-group-start', mode: entry.mode, teammate: entry.teammateName });
      const spawned = await spawnTeammate({
        name: entry.teammateName,
        description: `执行 ${plan.id} 的 ${entry.label} 分组（仅此一类任务）`,
        prompt: entry.prompt,
        context: 'fresh'
      });
      const task = await createTask({
        subject: entry.task.subject,
        description: entry.task.description,
        blockedBy: previousTaskId ? [previousTaskId] : undefined,
        writeScopes: entry.writeScopes
      });
      await sendMessage({
        target: entry.teammateName,
        content: [{ type: 'text', text: `任务已下派：${entry.task.subject}\n用 ${EXECUTOR_TOOL} 参数 {"planId":"${plan.id}","mode":"${entry.mode}"} 执行，恰好一次。` }]
      });
      plan.dispatch.groups.push({ mode: entry.mode, teammate: entry.teammateName, taskId: task && (task.id || task.taskId) || null, status: 'assigned' });
      if (typeof onEvent === 'function') onEvent({ type: 'dispatch-assigned', mode: entry.mode, teammate: entry.teammateName, taskId: task && (task.id || task.taskId) });

      const outcome = await waitForGroup(entry.mode);
      const group = plan.dispatch.groups[plan.dispatch.groups.length - 1];
      if (outcome && outcome.ok) {
        group.status = 'done';
        plan.dispatch.results[entry.mode] = outcome;
      } else {
        group.status = 'failed';
        group.reason = (outcome && outcome.reason) || 'unknown';
        errors.push({ mode: entry.mode, reason: group.reason });
      }
      try {
        await completeTask({ taskId: group.taskId, expectedRevision: task && task.revision, ok: Boolean(outcome && outcome.ok) });
      } catch { /* 任务板收尾失败不影响执行结果 */ }
      previousTaskId = group.taskId;
      if (typeof onEvent === 'function') onEvent({ type: 'dispatch-group-done', mode: entry.mode, status: group.status, reason: group.reason || null });
    } catch (error) {
      errors.push({ mode: entry.mode, reason: error && error.message ? error.message : String(error) });
      plan.dispatch.groups.push({ mode: entry.mode, teammate: entry.teammateName, status: 'failed', reason: error && error.message });
      if (typeof onEvent === 'function') onEvent({ type: 'dispatch-group-done', mode: entry.mode, status: 'failed', reason: error && error.message });
    }
  }

  plan.dispatch.endedAt = Date.now();
  plan.dispatch.errors = errors;
  plan.dispatch.ok = errors.length === 0;
  return { ok: errors.length === 0, assigned, errors, groups: plan.dispatch.groups };
}
