/**
 * GarbageMaster — Client 半：侧栏图标 + 整页清理控制台（r4）。
 *
 * r4 按用户反馈重做（对应 11 条要求）：
 *  1) 目标按**文件系统**显示，页签上直接写「剩余 XX G」与已用百分比（家目录与 / 同分区时不再算两个盘）
 *  2) 移除演练模式
 *  3) "无权限/符号链接"改成普通人能读懂的说明
 *  4) 修树图不可点击的 bug：单击目录进入下一层；块上显示占当前目录百分比；文件块加图标与目录区分
 *  5) 文字层级做色彩/字重区分（标题/体积/路径/说明/元信息各不同）
 *  6) 「当前位置」面板：位置、路径、体积+占上级百分比、修改时间、解释 + 三个按钮
 *     （复制路径 / 在资源管理器中打开 / 对当前路径的操作下拉：加入清理清单[默认]/打包/整理）
 *  7) 右下方两个页签：「本层条目」（描述/大小/占比条形图/逐项操作模式）与「规则建议」
 *  8) 底部栏默认收起；展开是完整选择清单（大小/风险/修改时间/路径说明/操作/特殊要求）+ 搜索 + 提交
 *  9) 流程：选择 → 浏览清单 → 提交 → 计划（按操作分组、重启类排最后）→ 展示 → 确认 → 二次确认 → 执行/派发
 * 10) 三种操作：清除 / 打包 / 整理
 * 11) 计划编排：同类合并、重启类置尾并在界面提前说明
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-garbage-master',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const ROUTE_PREFIX = (window.__GARBAGE_MASTER__ && window.__GARBAGE_MASTER__.prefix) || '/garbage-master';
    const TOKEN = (window.__GARBAGE_MASTER__ && window.__GARBAGE_MASTER__.token) || '';

    const DICT = {
      zh: {
        panel: '垃圾清理台',
        scan: '开始扫描', rescan: '重新扫描', cancelScan: '中断扫描', cancelRun: '中断执行',
        scanning: '扫描中', free: '剩余', used: '已用',
        noPermission: '{n} 个目录没有读取权限，已跳过', symlinks: '跳过 {n} 个符号链接',
        candidates: '候选清理项', suggestions: '规则建议', level: '本层条目',
        noCandidates: '这个目标下暂时没有命中规则的候选',
        size: '体积', risk: '风险', modified: '修改时间', note: '说明', path: '路径',
        shareOfParentLabel: '占上级', shareOfCurrent: '占当前 {p}%',
        operation: '操作', modeClean: '清理', modePack: '打包', modeTidy: '整理',
        special: '特殊要求', specialHint: '给 LLM 的补充说明，例如"只保留最近 30 天"',
        searchPlaceholder: '按路径或文件名搜索…',
        cart: '选择清单', cartEmpty: '还没选任何条目：在左侧点目录块进入，或在右侧勾选',
        submit: '提交（生成计划）',
        planTitle: '执行计划', planIntro: '以下计划按操作类别分组编排；同类操作合并进行，需要重启的任务排在最后。',
        planGroupClean: '清除', planGroupPack: '打包', planGroupTidy: '整理', planGroupRestart: '需要重启 / 重新登录后再做',
        planRestartNote: '这些操作会影响正在运行的服务或需要重启才生效，所以放在最后，执行前请先保存工作。',
        planPending: '以下条目需要智能体执行（本版本先出计划与清单）：',
        planDeletes: '会删除文件', planNoDelete: '不删除文件',
        planConfirm: '确认计划', planBack: '返回修改',
        finalTitle: '最后确认', finalLine: '将按计划执行：{groups}',
        finalCheck: '我确认要永久删除上面这些内容（不进回收站、无法撤销）',
        finalCheckDir: '我确认选中的目录要连同里面的文件一起删除',
        finalRun: '确认执行', finalCancel: '取消',
        executing: '执行中', progress: '进度', report: '报告',
        expected: '预期回收', actual: '实际回收', diskDelta: '磁盘可用变化',
        skipped: '跳过', failedCount: '失败', audit: '审计文件',
        reveal: '在文件管理器中打开', copyPath: '复制路径', addToList: '加入清理清单',
        removeFromCart: '移出清单', measure: '量体积', measuring: '正在量…',
        showHidden: '显示隐藏文件', up: '返回上级',
        current: '当前位置', focusFile: '焦点文件',
        dirs: '目录', files: '文件', unknown: '—', approx: '约',
        sizeUnknown: '体积未知', emptyDir: '这个目录是空的',
        noTree: '还没有扫描结果：先选一个盘，点右上角「开始扫描」',
        outsideTree: '这一层在扫描树之外，右侧显示的是实时读取的内容',
        truncated: '只显示前 {n} 项（共 {total} 项）',
        remedy: '官方处置', copyCmd: '复制命令', expand: '展开', collapse: '收起',
        riskSafe: '可安全删除', riskCaution: '需你确认', riskKeep: '建议保留', riskBlocked: '不可删除',
        actionUnlink: '删除', actionArchive: '打包', actionCommand: '官方命令', actionManual: '手动',
        blockedHint: '规则标记为不可删除', keepHint: '规则建议保留', manualHint: '需要你手动处理',
        copied: '已复制', copiedCmd: '命令已复制', loadFailed: '读取失败', openFailed: '打开失败',
        otherDirs: '其他 {n} 个小目录', restFiles: '其余小文件',
        candidateTag: '候选', inCart: '已选', log: '日志', quickJump: '快捷',
        shard: '分片', actors: '并行执行者', selected: '已选',
        shardStatus: { pending: '等待', running: '进行中', done: '完成', cancelled: '已取消' },
        legend: '图例', foldedItems: '其他 {n} 项', mapLimitHint: '较大目录按体积铺开，其余合并为「其他 N 项」', mapLimitOld: '树图只画 ≥{mb} MB 的目录（共 {n} 项）；更小的在右侧列表里',
        ruleHints: '含 {n} 条规则建议', scannedAt: '扫描于', settingsNeedsRestart: '设置路由还没生效：请重启 dsh 后再改（当前按默认值显示）',
        cancelBtn: '取消', save: '保存', saved: '已保存', preview: '预览：', insertAt: '插入 @',
        scanAnim: '正在统计目录…', settings: '设置', settingsTitle: '扫描与判定参数',
        settingsHint: '保存后需要重新扫描才会生效（当前结果不会变）。',
        setBigFile: '大文件阈值（MB）', setMinExpand: '目录展开阈值（MB）', setMinCandidate: '候选下限（KB）',
        setMaxDepth: '扫描深度上限', setKeepTop: '每层保留子目录数', setFilesPerDir: '每目录展示大文件数',
        setWorkers: '并行执行者数', specialTitle: '特殊要求',
        specialIntro: '写给 LLM 的补充说明。可用 @ 引用文件/目录，引用会用颜色标出。',
        cartHint: '在左侧点目录进入，右侧勾选条目', cartSearch: '搜索清单…',
        explaining: '正在解释', explainFailed: '解释失败', explainFailedShort: '解释失败', explainSource: '来源',
        sessionPlanTitle: '执行计划（由会话生成）', sessionPlanButton: '生成执行计划', sessionPlanning: '会话正在生成计划…',
        sessionPlanSession: '会话', sessionPlanPlan: '计划', sessionPlanWorkspace: '工作区',
        sessionPlanFromFile: '（已写入计划文件）', sessionPlanFromSession: '（来自会话回复）',
        sessionPlanEmpty: '会话没有返回计划内容', sessionPlanConfirm: '确认并执行',
        sessionExecuteConfirmTitle: '确认执行这份计划？', sessionExecuteConfirmBody: '确认后会在同一个会话里退出计划模式、放宽权限并按计划执行（可能包含不可逆的删除）。请先读完上面的计划。',
        sessionExecuteGo: '确认执行', sessionExecuted: '已把执行指令发给会话，进度请在该会话里查看。',
        sessionPlanPreset: '权限', planModeDegraded: '（计划模式不可用，已用只读权限约束）', sessionPlanFailed: '生成计划失败', sessionExecuteFailed: '执行失败',
        setWorkspace: '绑定工作区（计划/执行会话所在）', setPlanSession: '用会话生成执行计划（替换快速计划）',
        setExplainModel: '解释/计划使用的模型', modelFollowSession: '跟随默认模型',
        auditTitle: '审计：历史清理记录', auditIntro: '每次运行一条记录（谁授权、哪个执行者、删了哪些路径、多少字节、成败）。文件在 ~/.dsh/garbage-master/audit/。',
        auditEmpty: '还没有清理记录', dryRunTag: '演练', realRunTag: '真实', auditOpen: '审计',
        loading: '加载中…', auditLoadFailed: '读取审计记录失败',
        setAuditKeep: '日志保留最近几次', auditPurge: '清理日志', auditPurgeHint: '只删除本插件的审计文件，不碰任何用户数据。',
        auditClearExplain: '同时清空解释缓存', auditPruned: '已清理 {n} 个审计文件（保留 {keep} 个）', auditNothingToPrune: '请设置一个保留次数',
        auditRefresh: '刷新', auditItems: '{n} 项',
        staleTokenError: '页面令牌已过期（dsh 重启过），刷新即可恢复',
        staleTokenTitle: '页面令牌已过期', staleTokenReload: '立即刷新页面',
        staleTokenHint: 'dsh 重启过：已打开的页面还带着旧令牌，刷新后一切恢复正常。',
        staleTokenAuto: '（已自动刷新…若没反应请点右侧按钮）', auditMovedHint: '运行报告与日志已移到右上角「审计」里，不再挤占界面。',
        reexplain: '重新解释当前这一层', reexplainStarted: '正在重新生成解释…', reexplainHint: '忽略缓存重新生成', explainUnavailable: '解释服务未就绪（重启 dsh 后可用）',
        explainCacheHint: '解释会按路径缓存，内容变化不会自动重新生成；需要时点下面的按钮强制刷新当前层。',
        setExplainDepth: '自动解释本层子项（0=关闭）', workspaceAuto: '自动（第一个工作区）', setExplainItems: '每层最多解释几条',
        setExplainSearches: '每层联网搜索次数', setExplainWeb: '把握不足时联网搜索',
        setExplainConcurrency: '解释并发批次数（越大越快）', setExplainEffort: '解释的思考强度',
        effortInherit: '继承当前模型选择', effortDefaultTag: '（默认）',
        effortNotDeclared: '当前模型没有暴露可调的思考强度（设置会保留，换模型后自动生效）', effortLoading: '读取模型信息…',
        sourceRule: '规则', sourceLlm: 'AI 推测', sourceWeb: '联网', sourceCache: '缓存',
        executorsPending: '打包 / 整理 的执行器在下一阶段接入（当前先把计划与清单做对）',
        aiUsed: 'AI 判断', aiUnavailable: 'AI 不可用（{reason}），已按规则生成计划',
        aiSuggestion: 'AI 建议', aiDropped: 'AI 返回的 {n} 条清单外路径已被丢弃',
        packResult: '归档', tidyResult: '重复文件',
        duplicates: '{n} 组重复', wasted: '可省 {size}', savedAs: '已保存为',
        packHint: '打成一个压缩包，不删原文件', tidyHint: '只统计重复，不删任何文件',
        uninstallTitle: '应用 / 环境：应卸载而不是删目录', uninstallHint: '这些不会被执行器删除，请用官方命令卸载',
        dispatchTitle: '派发', dispatchTeam: '已派给智能体', dispatchInProcess: '团队不可用，使用进程内执行器',
        dispatchReason: '原因', dispatchLead: 'Lead', dispatchAssigned: '已指派', dispatchDone: '完成',
        dispatchFailed: '失败', dispatchExecutedBy: '执行者'
      },
      en: {
        panel: 'Cleanup Console',
        scan: 'Scan', rescan: 'Rescan', cancelScan: 'Cancel scan', cancelRun: 'Cancel run',
        scanning: 'Scanning', free: 'Free', used: 'Used',
        noPermission: '{n} directories unreadable, skipped', symlinks: 'skipped {n} symlinks',
        candidates: 'Candidates', suggestions: 'Rule suggestions', level: 'This level',
        noCandidates: 'No rule-matched candidates under this target yet',
        size: 'Size', risk: 'Risk', modified: 'Modified', note: 'Note', path: 'Path',
        shareOfParentLabel: 'of parent', shareOfCurrent: '{p}% of here',
        operation: 'Action', modeClean: 'Clean', modePack: 'Pack', modeTidy: 'Tidy',
        special: 'Special request', specialHint: 'Extra instruction for the LLM, e.g. "keep the last 30 days"',
        searchPlaceholder: 'Search by path or file name…',
        cart: 'Selection', cartEmpty: 'Nothing selected yet: click directory tiles on the left, or tick items on the right',
        submit: 'Submit (build plan)',
        planTitle: 'Execution plan', planIntro: 'The plan is grouped by action; same-kind work runs together, and restart-requiring tasks come last.',
        planGroupClean: 'Clean', planGroupPack: 'Pack', planGroupTidy: 'Tidy', planGroupRestart: 'Needs restart / re-login afterwards',
        planRestartNote: 'These affect running services or need a restart, so they run last. Save your work first.',
        planPending: 'These items need the agent (this version produces the plan and list first):',
        planDeletes: 'deletes files', planNoDelete: 'deletes nothing',
        planConfirm: 'Confirm plan', planBack: 'Back',
        finalTitle: 'Final confirmation', finalLine: 'Will execute: {groups}',
        finalCheck: 'I confirm these are permanently deleted (no recycle bin, no undo)',
        finalCheckDir: 'I confirm directories are deleted together with their contents',
        finalRun: 'Execute', finalCancel: 'Cancel',
        executing: 'Running', progress: 'Progress', report: 'Report',
        expected: 'Expected', actual: 'Reclaimed', diskDelta: 'Disk free change',
        skipped: 'Skipped', failedCount: 'Failed', audit: 'Audit file',
        reveal: 'Show in file manager', copyPath: 'Copy path', addToList: 'Add to list',
        removeFromCart: 'Remove', measure: 'Measure', measuring: 'Measuring…',
        showHidden: 'Show hidden', up: 'Up',
        current: 'Current location', focusFile: 'Focused file',
        dirs: 'dirs', files: 'files', unknown: '—', approx: '~',
        sizeUnknown: 'size unknown', emptyDir: 'This directory is empty',
        noTree: 'No scan yet: pick a disk and click Scan in the top right',
        outsideTree: 'Below the scanned tree — the list on the right is read live',
        truncated: 'Showing {n} of {total}',
        remedy: 'Official remedy', copyCmd: 'Copy command', expand: 'More', collapse: 'Less',
        riskSafe: 'Safe to delete', riskCaution: 'Needs review', riskKeep: 'Better kept', riskBlocked: 'Never delete',
        actionUnlink: 'Delete', actionArchive: 'Archive', actionCommand: 'Command', actionManual: 'Manual',
        blockedHint: 'Rule marks this never-deletable', keepHint: 'Rule says keep it', manualHint: 'Needs manual handling',
        copied: 'Copied', copiedCmd: 'Command copied', loadFailed: 'Read failed', openFailed: 'Open failed',
        otherDirs: '{n} more small dirs', restFiles: 'Other small files',
        candidateTag: 'candidate', inCart: 'selected', log: 'Log', quickJump: 'Quick',
        shard: 'Shard', actors: 'Workers', selected: 'selected',
        shardStatus: { pending: 'pending', running: 'running', done: 'done', cancelled: 'cancelled' },
        legend: 'Legend', foldedItems: '{n} more items', mapLimitHint: 'Larger directories fill the map; the rest collapse into "N more"', mapLimitOld: 'Map shows dirs ≥{mb} MB ({n} items); smaller ones are in the list',
        ruleHints: '{n} rule suggestions', scannedAt: 'Scanned', settingsNeedsRestart: 'Settings route not live yet: restart dsh first (showing defaults)',
        cancelBtn: 'Cancel', save: 'Save', saved: 'Saved', preview: 'Preview: ', insertAt: 'Insert @',
        scanAnim: 'Measuring directories…', settings: 'Settings', settingsTitle: 'Scan and detection settings',
        settingsHint: 'A rescan is needed for changes to take effect.',
        setBigFile: 'Large-file threshold (MB)', setMinExpand: 'Directory expand threshold (MB)', setMinCandidate: 'Candidate minimum (KB)',
        setMaxDepth: 'Max scan depth', setKeepTop: 'Children kept per level', setFilesPerDir: 'Large files per directory',
        setWorkers: 'Parallel workers', specialTitle: 'Special request',
        specialIntro: 'Extra instruction for the LLM. Use @ to reference files; references are colored.',
        cartHint: 'Open a directory on the left, then tick items on the right', cartSearch: 'Search list…',
        explaining: 'Explaining', explainFailed: 'Explanation failed', explainFailedShort: 'Explanation failed', explainSource: 'source',
        sessionPlanTitle: 'Execution plan (generated by a session)', sessionPlanButton: 'Generate plan', sessionPlanning: 'Session is drafting the plan…',
        sessionPlanSession: 'session', sessionPlanPlan: 'plan', sessionPlanWorkspace: 'workspace',
        sessionPlanFromFile: '(written to plan file)', sessionPlanFromSession: '(from the session reply)',
        sessionPlanEmpty: 'The session returned no plan', sessionPlanConfirm: 'Confirm and run',
        sessionExecuteConfirmTitle: 'Run this plan?', sessionExecuteConfirmBody: 'The same session will exit plan mode, widen permissions and execute the plan (may include irreversible deletes). Read the plan above first.',
        sessionExecuteGo: 'Run it', sessionExecuted: 'Execution instruction sent to the session; watch progress there.',
        sessionPlanPreset: 'permissions', planModeDegraded: ' (plan mode unavailable; read-only enforced)', sessionPlanFailed: 'Failed to generate plan', sessionExecuteFailed: 'Execution failed',
        setWorkspace: 'Bound workspace (plan/execute session)', setPlanSession: 'Use a session to plan (replaces quick plan)',
        setExplainModel: 'Model for explain/plan', modelFollowSession: 'Follow default model',
        auditTitle: 'Audit: cleanup history', auditIntro: 'One record per run (who authorized, which executor, which paths, bytes, outcome). Files live in ~/.dsh/garbage-master/audit/.',
        auditEmpty: 'No cleanup runs yet', dryRunTag: 'dry-run', realRunTag: 'real', auditOpen: 'Audit',
        loading: 'Loading…', auditLoadFailed: 'Failed to read audit records',
        setAuditKeep: 'Keep the last N runs', auditPurge: 'Prune logs', auditPurgeHint: 'Deletes only this plugin\'s audit files, never user data.',
        auditClearExplain: 'Also clear the explanation cache', auditPruned: 'Removed {n} audit files (kept {keep})', auditNothingToPrune: 'Set a keep count first',
        auditRefresh: 'Refresh', auditItems: '{n} items',
        staleTokenError: 'Page token expired (dsh restarted) — refresh to recover',
        staleTokenTitle: 'Page token expired', staleTokenReload: 'Reload now',
        staleTokenHint: 'dsh restarted: this open page still holds the old token. Refresh to recover.',
        staleTokenAuto: '(auto-reloading… click the button if nothing happens)', auditMovedHint: 'Reports and logs moved into Audit (top right).',
        reexplain: 'Re-explain this level', reexplainStarted: 'Regenerating explanations…', reexplainHint: 'Ignore cache and regenerate', explainUnavailable: 'Explanation service not live (restart dsh)',
        explainCacheHint: 'Explanations are cached per path and are not regenerated when contents change; use the button below to force this level.',
        setExplainDepth: 'Auto-explain this level\'s children (0=off)', workspaceAuto: 'Auto (first workspace)', setExplainItems: 'Max items explained per level',
        setExplainSearches: 'Web searches per level', setExplainWeb: 'Search the web when unsure',
        setExplainConcurrency: 'Concurrent explain batches', setExplainEffort: 'Reasoning effort for explanations',
        effortInherit: 'Inherit from model selection', effortDefaultTag: ' (default)',
        effortNotDeclared: 'This model exposes no selectable reasoning effort (setting is kept for other models)', effortLoading: 'Reading model info…',
        sourceRule: 'rule', sourceLlm: 'AI guess', sourceWeb: 'web', sourceCache: 'cache',
        executorsPending: 'Pack / tidy executors arrive in the next stage (this one gets the plan and list right)',
        aiUsed: 'AI read', aiUnavailable: 'AI unavailable ({reason}); plan built from rules',
        aiSuggestion: 'AI suggests', aiDropped: '{n} out-of-list paths from the model were dropped',
        packResult: 'Archive', tidyResult: 'Duplicates',
        duplicates: '{n} duplicate groups', wasted: 'saves {size}', savedAs: 'saved as',
        packHint: 'Archive into one file; originals kept', tidyHint: 'Reports duplicates only; deletes nothing',
        uninstallTitle: 'Apps / environments: uninstall instead of deleting', uninstallHint: 'These are not deleted by the executor; use the official command',
        dispatchTitle: 'Dispatch', dispatchTeam: 'Dispatched to agents', dispatchInProcess: 'Teams unavailable — in-process executor',
        dispatchReason: 'reason', dispatchLead: 'Lead', dispatchAssigned: 'assigned', dispatchDone: 'done',
        dispatchFailed: 'failed', dispatchExecutedBy: 'executor'
      }
    };
    const LANG = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    const t = (key, vars) => {
      const text = (DICT[LANG] && DICT[LANG][key]) || DICT.zh[key] || key;
      if (typeof text !== 'string') return text; // shardStatus 之类是映射表，不强转
      if (!vars) return text;
      let out = text;
      for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
      return out;
    };

    const MODE_LABEL = { clean: () => t('modeClean'), pack: () => t('modePack'), tidy: () => t('modeTidy') };

    function fmtBytes(n) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return t('unknown');
      if (n === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = n;
      let i = 0;
      while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
      const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
      return `${value.toFixed(digits)} ${units[i]}`;
    }
    /** 页签上的剩余空间：GB 一位小数，空间紧张时更醒目。 */
    function fmtFree(n) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return t('unknown');
      return `${(n / 1024 ** 3).toFixed(1)} GB`;
    }
    function pct(part, whole) {
      if (!whole || typeof part !== 'number' || !Number.isFinite(part)) return null;
      return Math.min(100, Math.max(0, (part / whole) * 100));
    }
    function fmtDate(seconds) {
      if (!seconds) return t('unknown');
      const d = new Date(seconds * 1000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // 令牌是插件启动时生成、注入到页面里的：Host 一重启，已打开的页面就拿着旧令牌，
    // 于是所有请求都 403 bad-token。这里统一识别并交给组件层提示 + 自动刷新。
    let staleTokenSink = null;
    let dictSink = null;

    async function api(route, options) {
      const opts = options || {};
      const res = await fetch(`${ROUTE_PREFIX}${route}`, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'x-garbage-master-token': TOKEN }, opts.body ? { 'content-type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      let payload = null;
      try { payload = await res.json(); } catch { payload = null; }
      if (!res.ok) {
        const code = (payload && (payload.error || payload.message)) || `HTTP ${res.status}`;
        if (res.status === 403 && code === 'bad-token') {
          if (typeof staleTokenSink === 'function') staleTokenSink();
          const error = new Error(dictSink ? dictSink('staleTokenError') : 'bad-token');
          error.code = 'bad-token';
          throw error;
        }
        throw new Error(code);
      }
      return payload;
    }

    /**
     * 迷你 Markdown 渲染：标题 / 无序·有序列表 / 表格 / 围栏代码块 / 引用 / 水平线 /
     * 行内 **粗体**、`代码`、[链接](url)。够显示计划文档，不引额外依赖。
     */
    function renderInline(text, keyPrefix) {
      const nodes = [];
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      let match;
      let index = 0;
      while ((match = re.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        const key = `${keyPrefix}-i${index}`;
        index += 1;
        if (token.startsWith('**')) nodes.push(h('b', { key }, token.slice(2, -2)));
        else if (token.startsWith('`')) nodes.push(h('code', { key, className: 'gm-md-code' }, token.slice(1, -1)));
        else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]));
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    function renderMarkdown(source) {
      const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
      const out = [];
      let i = 0;
      let key = 0;
      while (i < lines.length) {
        const line = lines[i];
        key += 1;
        if (/^```/.test(line.trim())) {
          const lang = line.trim().slice(3).trim();
          const body = [];
          i += 1;
          while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i += 1; }
          i += 1;
          out.push(h('pre', { key: `md-${key}`, className: 'gm-md-pre' }, h('code', null, body.join('\n'))));
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          out.push(h(`h${Math.min(6, level + 2)}`, { key: `md-${key}`, className: 'gm-md-h' }, renderInline(heading[2], `md-${key}`)));
          i += 1;
          continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
          const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          const head = cells(line);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
          out.push(h('table', { key: `md-${key}`, className: 'gm-md-table' },
            h('thead', null, h('tr', null, head.map((c, ci) => h('th', { key: ci }, renderInline(c, `md-${key}-h${ci}`))))),
            h('tbody', null, rows.map((row, ri) => h('tr', { key: ri }, row.map((c, ci) => h('td', { key: ci }, renderInline(c, `md-${key}-r${ri}c${ci}`))))))));
          continue;
        }
        if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
          const ordered = /^\s*\d+[.)]\s+/.test(line);
          const items = [];
          while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
            i += 1;
          }
          const Tag = ordered ? 'ol' : 'ul';
          out.push(h(Tag, { key: `md-${key}`, className: 'gm-md-list' },
            items.map((item, ii) => h('li', { key: ii }, renderInline(item, `md-${key}-l${ii}`)))));
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          const body = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
          out.push(h('blockquote', { key: `md-${key}`, className: 'gm-md-quote' }, renderInline(body.join(' '), `md-${key}-q`)));
          continue;
        }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push(h('hr', { key: `md-${key}` })); i += 1; continue; }
        if (line.trim() === '') { i += 1; continue; }
        const para = [];
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>)/.test(lines[i])) {
          para.push(lines[i]); i += 1;
        }
        out.push(h('p', { key: `md-${key}`, className: 'gm-md-p' }, renderInline(para.join(' '), `md-${key}-p`)));
      }
      return out;
    }

    function squarify(items, x, y, w, hh) {
      const out = [];
      if (!items.length || w <= 0 || hh <= 0) return out;
      let list = items.slice();
      let rx = x; let ry = y; let rw = w; let rh = hh;
      while (list.length && rw > 0.5 && rh > 0.5) {
        const remaining = list.reduce((sum, i) => sum + i.size, 0) || 1;
        const scale = (rw * rh) / remaining;
        const L = Math.min(rw, rh);
        let row = [];
        let rowSum = 0;
        let best = Infinity;
        for (const it of list) {
          const ns = rowSum + it.size;
          const thickness = (ns * scale) / L;
          if (thickness <= 0) break;
          let worst = 0;
          for (const cand of row.concat([it])) {
            const area = Math.max(cand.size * scale, 1e-6);
            const ratio = Math.max(area / (thickness * thickness), (thickness * thickness) / area);
            if (ratio > worst) worst = ratio;
          }
          if (row.length && worst > best) break;
          best = worst; row = row.concat([it]); rowSum = ns;
        }
        if (!row.length) { row = [list[0]]; rowSum = list[0].size; }
        list = list.slice(row.length);
        const T = Math.max((rowSum * scale) / L, 0.01);
        let off = 0;
        if (rw >= rh) {
          for (const it of row) { const height = (it.size * scale) / T; out.push({ it, x: rx, y: ry + off, w: T, h: height }); off += height; }
          rx += T; rw -= T;
        } else {
          for (const it of row) { const width = (it.size * scale) / T; out.push({ it, x: rx + off, y: ry, w: width, h: T }); off += width; }
          ry += T; rh -= T;
        }
      }
      return out;
    }

    const SHADES = {
      safe: ['--gm-safe', '--gm-safe2', '--gm-safe3'],
      caution: ['--gm-caution', '--gm-caution2', '--gm-caution3'],
      keep: ['--gm-keep', '--gm-keep2', '--gm-keep3'],
      blocked: ['--gm-blocked', '--gm-blocked2', '--gm-blocked3']
    };
    const riskVar = (risk) => {
      const shades = SHADES[risk] || SHADES.keep;
      return `var(${shades[0]})`;
    };
    /** 图例圆点/百分比条这类"图形"用主题感知色：深色下要更亮才够 3:1。 */
    const dotVar = (risk) => `var(--gm-dot-${String(risk || 'keep')})`;
    const riskLabel = (risk) => {
      const key = String(risk || 'caution');
      return t(`risk${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    };
    const actionLabel = (action) => {
      const key = String(action || 'manual');
      return t(`action${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    };

    const STYLE = `
.gm-root{--gm-safe:#15803d;--gm-safe2:#166534;--gm-safe3:#14532d;
  --gm-caution:#b45309;--gm-caution2:#92400e;--gm-caution3:#78350f;
  --gm-keep:#475569;--gm-keep2:#334155;--gm-keep3:#1e293b;
  --gm-blocked:#b91c1c;--gm-blocked2:#991b1b;--gm-blocked3:#7f1d1d;
  /* 强调色：宿主 brand-primary 在深色下等于文字色（近白），拿它做填充+白字会白字压白底，
     所以这里用一对自有的 accent/on-accent，明暗两套都过对比度 */
  --gm-accent:#2563eb;--gm-on-accent:#ffffff;--gm-danger:#b91c1c;
  /* 图例圆点与占比条是"图形"，深色下需要更亮才够 3:1（色块填充仍用 --gm-safe 等） */
  --gm-dot-safe:#16a34a;--gm-dot-caution:#d97706;--gm-dot-keep:#64748b;--gm-dot-blocked:#dc2626;
  --gm-track:#c9ced6;
  --gm-shadow:0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.05);
  box-sizing:border-box;height:100%;display:flex;flex-direction:column;overflow:hidden;
  /* 不要自己铺一层底色：宿主面板已经给了，铺了会在四周露出一圈更暗的内框 */
  background:transparent;color:var(--dsw-alias-label-primary);
  font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
body[data-ds-dark-theme] .gm-root{--gm-shadow:0 1px 3px rgba(0,0,0,.4),0 4px 16px rgba(0,0,0,.3);--gm-accent:#60a5fa;--gm-on-accent:#0b1220;
  --gm-dot-safe:#4ade80;--gm-dot-caution:#fbbf24;--gm-dot-keep:#94a3b8;--gm-dot-blocked:#f87171;--gm-track:#7a7a80}
/* 文字层级：主标题最重、体积次之、路径为等宽弱色、元信息最弱 —— 不都用同一种颜色 */
.gm-t1{color:var(--dsw-alias-label-primary)}
.gm-t2{color:var(--dsw-alias-label-secondary)}
.gm-t3{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.gm-root *{box-sizing:border-box}
.gm-stale{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 16px;font-size:12.5px;
  background:var(--gm-caution3);color:#fff;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gm-stale .gm-btn{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.4);color:#fff}
.gm-header{background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);padding:12px 16px}
.gm-h1{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.gm-h1 h1{font-size:17px;margin:0;font-weight:680;letter-spacing:.2px}
.gm-spacer{flex:1}
.gm-btn{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:0 11px;height:28px;
  display:inline-flex;align-items:center;gap:5px;cursor:pointer;transition:.15s}
.gm-btn:hover{border-color:var(--gm-accent);color:var(--gm-accent)}
.gm-btn[disabled]{opacity:.45;cursor:not-allowed}
.gm-btn.gm-primary[disabled]{opacity:1;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.gm-btn.gm-primary{background:var(--gm-accent);color:var(--gm-on-accent);border-color:transparent;font-weight:600}
.gm-btn.gm-primary:hover{color:var(--gm-on-accent);filter:brightness(1.06)}
.gm-btn.gm-danger{background:var(--gm-danger);color:#fff;border-color:transparent;font-weight:600}
.gm-btn.gm-danger[disabled]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.gm-tabs{display:flex;gap:6px;flex-wrap:wrap}
.gm-tab{display:inline-flex;flex-direction:row;align-items:center;gap:8px;font:inherit;height:28px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:999px;padding:0 12px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap}
.gm-tab b{font-size:12.5px;font-weight:600}
.gm-tab span{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.gm-tab.on{background:var(--gm-accent);border-color:transparent}
.gm-tab.on b,.gm-tab.on span{color:var(--gm-on-accent)}
.gm-diskbar{height:9px;border-radius:5px;overflow:hidden;margin-top:10px;background:var(--gm-track)}
.gm-diskbar i{display:block;height:100%;background:var(--gm-accent)}
.gm-meta{font-size:12px;margin-top:7px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.gm-meta b{font-weight:600}
.gm-chips{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.gm-legend-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-right:2px}
.gm-chip{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;padding:0 8px;height:28px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;user-select:none;
  color:var(--dsw-alias-label-primary)}
.gm-chip.off{opacity:1;border-color:var(--gm-track);color:var(--dsw-alias-label-secondary);background:transparent}
.gm-chip.on{border-color:var(--gm-accent);box-shadow:inset 0 0 0 1px var(--gm-accent)}
.gm-chip i{width:8px;height:8px;border-radius:50%;display:block;flex:none}
.gm-main{flex:1;display:grid;grid-template-columns:1fr 430px;gap:14px;padding:14px;min-height:0;overflow:hidden}
@media(max-width:1200px){.gm-main{grid-template-columns:1fr;grid-template-rows:minmax(220px,1fr) minmax(320px,1.4fr)}}
.gm-col{display:flex;flex-direction:column;gap:14px;min-height:0}
.gm-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  box-shadow:var(--gm-shadow);display:flex;flex-direction:column;min-height:0;overflow:hidden}
.gm-cardhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 12px;min-height:42px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gm-card--current{flex:0 0 auto;max-height:52%}
.gm-col-inner{display:flex;flex-direction:column;gap:12px;min-height:0;height:100%}
.gm-card--plan{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.gm-plan-body{overflow:auto;flex:1 1 auto;min-height:0}
.gm-cardfoot{flex:0 0 auto;display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.gm-cardhead b{font-size:13px;font-weight:650}
.gm-cardbody{flex:1;min-height:0;overflow:auto;padding:10px 12px}
.gm-crumb{display:flex;align-items:center;gap:3px;flex-wrap:wrap;font-size:12.5px;min-width:0}
.gm-crumb button{background:none;border:none;font:inherit;color:var(--gm-accent);cursor:pointer;padding:3px 7px;border-radius:6px}
.gm-crumb button:hover{background:var(--dsw-alias-bg-layer-2)}
.gm-crumb .cur{color:var(--dsw-alias-label-primary);font-weight:600}
.gm-crumb .sep{color:var(--dsw-alias-label-secondary);opacity:.7}
.gm-map{position:relative;flex:1;min-height:200px;margin:10px;overflow:hidden;border-radius:8px}
.gm-tile{position:absolute;overflow:hidden;border-radius:4px;cursor:pointer;padding:5px 6px;line-height:1.3;
  color:#fff;border:1px solid rgba(0,0,0,.22);transition:filter .12s,transform .12s;display:flex;flex-direction:column;gap:1px}
.gm-tile.kdir{cursor:pointer}
.gm-tile.kfile{cursor:pointer}
.gm-tile.kfile{background-image:linear-gradient(180deg,rgba(255,255,255,.10),rgba(0,0,0,.06))}
.gm-tile:hover{filter:brightness(1.16);z-index:5;transform:translateY(-1px)}
.gm-tile.focus{outline:2px solid #fff;outline-offset:-2px}
.gm-tile:focus-visible{outline:2px solid #fff;outline-offset:-2px}
.gm-tile.muted{opacity:.14}
.gm-tile .row{display:flex;align-items:center;gap:4px;min-width:0}
.gm-tile .tn{font-weight:600;word-break:break-all;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.gm-tile .ts{font-size:11px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.gm-tile .pct{font-size:11px;color:#fff;font-weight:500}
.gm-tile .ficon{flex:none;opacity:.92}
.gm-tile.agg{background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.16),rgba(0,0,0,.16) 6px,rgba(255,255,255,.06) 6px,rgba(255,255,255,.06) 12px)}
.gm-badge{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:6px;color:#fff;font-weight:600;white-space:nowrap}
.gm-note{margin:8px 0 0;font-size:12.5px;background:var(--dsw-alias-bg-layer-2);
  border-left:3px solid var(--gm-accent);padding:8px 10px;border-radius:0 8px 8px 0;line-height:1.6}
.gm-note.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gm-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12.5px;margin-top:8px}
.gm-kv b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.gm-kv span{color:var(--dsw-alias-label-primary)}
.gm-path{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.gm-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;align-items:center}
.gm-mini{font:inherit;font-size:11.5px;display:inline-flex;align-items:center;min-height:26px;padding:2px 9px;border-radius:6px;cursor:pointer;opacity:0;transition:opacity .12s;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);white-space:nowrap}
.gm-row:hover .gm-mini,.gm-item:hover .gm-mini,.gm-mini.always{opacity:1}
.gm-mini:hover{border-color:var(--gm-accent);color:var(--gm-accent)}
.gm-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1);cursor:pointer}
.gm-row:first-child{border-top:none}
.gm-row:hover .gm-rn{color:var(--gm-accent)}
.gm-rdot{width:7px;height:7px;border-radius:50%;flex:none}
.gm-rn{flex:1;font-size:12.5px;min-width:0;color:var(--dsw-alias-label-primary);display:grid;grid-template-columns:1fr auto auto;gap:2px 8px;align-items:baseline}
.gm-rn .grow{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-rn .nm{font-weight:500}
.gm-rn .gm-rbar{grid-column:1 / -1}
.gm-rex{grid-column:1 / -1;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-rn .sub{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.gm-rs{font-size:12px;color:var(--dsw-alias-label-primary);font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.gm-rbar{height:4px;border-radius:3px;background:var(--gm-track);overflow:hidden;margin-top:4px}
.gm-rbar i{display:block;height:100%;border-radius:3px}
.gm-item{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:start;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.gm-item:first-child{border-top:none}
.gm-item .nt{font-size:12px;margin-top:3px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.gm-item .nt.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gm-item .r{text-align:right;white-space:nowrap}
select.gm-select,input.gm-input{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);height:28px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:0 8px}
input.gm-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}
.gm-foot{background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1)}
.gm-footbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 16px}
.gm-footbody{max-height:42vh;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1);padding:10px 16px}
table.gm-table{width:100%;border-collapse:collapse;font-size:12px}
table.gm-table th,table.gm-table td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
table.gm-table th{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:600;position:sticky;top:0;background:var(--dsw-alias-bg-layer-1)}
table.gm-table td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
.gm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000}
.gm-overlay-top{z-index:1100}
.gm-modal-wide{width:920px;max-width:94vw}
.gm-ok{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--gm-safe);border-left:4px solid var(--gm-safe);border-radius:8px;padding:8px 10px;font-size:12.5px}
.gm-md{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
.gm-md-h{margin:10px 0 6px;font-weight:600}
.gm-md-p{margin:6px 0}
.gm-md-list{margin:6px 0 6px 20px;padding:0}
.gm-md-list li{margin:2px 0}
.gm-md-table{border-collapse:collapse;margin:8px 0;font-size:12.5px}
.gm-md-table th,.gm-md-table td{border:1px solid var(--dsw-alias-border-l1);padding:4px 8px;text-align:left;vertical-align:top}
.gm-md-table th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.gm-md-pre{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;overflow:auto;margin:8px 0;font-size:12px}
.gm-md-code{background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px;font-size:12px}
.gm-md-quote{border-left:3px solid var(--gm-accent);margin:8px 0;padding:2px 10px;color:var(--dsw-alias-label-secondary)}
.gm-audit{margin-top:10px;max-height:52vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.gm-auditrun{border-bottom:1px solid var(--dsw-alias-border-l1)}
.gm-auditrun:last-child{border-bottom:none}
.gm-auditrow{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;flex-wrap:wrap}
.gm-auditrow:hover{background:var(--dsw-alias-bg-layer-2)}
.gm-auditbody{padding:4px 12px 10px;background:var(--dsw-alias-bg-layer-1)}
.gm-audititem{display:flex;align-items:baseline;gap:10px;padding:3px 0;flex-wrap:wrap}
.gm-modal{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;
  box-shadow:var(--gm-shadow);padding:18px 20px;width:min(820px,94vw);max-height:86vh;overflow:auto}
.gm-modal h2{margin:0 0 6px;font-size:15px}
.gm-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin:10px 0;overflow:hidden}
.gm-grouphead{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2)}
.gm-grouphead b{font-size:13px}
.gm-groupbody{max-height:24vh;overflow:auto;padding:6px 12px}
.gm-warn{margin-top:8px;font-weight:600;color:var(--gm-blocked2)}
.gm-check{display:flex;align-items:flex-start;gap:8px;margin-top:10px;font-size:12.5px;line-height:1.5}
.gm-log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.gm-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:1100;max-width:70vw;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);
  padding:9px 16px;border-radius:9px;font-size:12.5px;box-shadow:var(--gm-shadow)}
.gm-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.gm-empty{padding:16px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.gm-scanbar{height:3px;border-radius:3px;overflow:hidden;background:var(--gm-track);margin-top:6px;position:relative}
.gm-scanbar i{position:absolute;top:0;bottom:0;width:35%;border-radius:3px;background:var(--gm-accent);animation:gm-indet 1.1s ease-in-out infinite}
@keyframes gm-indet{0%{left:-35%}100%{left:100%}}
.gm-form{display:grid;grid-template-columns:1fr 140px;gap:8px 14px;align-items:center;margin-top:10px}
.gm-form label{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.gm-form input{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:4px 8px;width:100%}
.gm-textarea{width:100%;min-height:120px;font:inherit;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;resize:vertical}
.gm-at{color:var(--gm-accent);font-weight:600}
.gm-preview{white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;max-height:120px;overflow:auto}
@media (hover: none), (pointer: coarse){.gm-mini{opacity:1}}
input[type=checkbox]{accent-color:var(--gm-accent);width:14px;height:14px;margin:2px 0 0}
.gm-cardbody{padding-bottom:14px}
.gm-cardbody::-webkit-scrollbar{width:8px;height:8px}
.gm-cardbody::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.gm-cardbody::-webkit-scrollbar-button{display:none}
.gm-cardbody::-webkit-scrollbar-track{background:transparent}
.gm-list{max-height:32vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;margin:10px 0;font-size:12px}
.gm-spin-sm{width:10px;height:10px;border-width:1.5px;flex:none;vertical-align:-1px}
.gm-tsp{position:absolute;right:4px;top:4px}
.gm-tile.pending{box-shadow:inset 0 0 0 2px rgba(255,255,255,.55);animation:gm-pulse 1.6s ease-in-out infinite}
@keyframes gm-pulse{0%,100%{opacity:1}50%{opacity:.72}}
.gm-rex-wait{color:var(--dsw-alias-label-tertiary)}
.gm-note-wait{display:flex;align-items:center;gap:6px}
.gm-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--gm-accent);
  border-radius:50%;animation:gm-spin .7s linear infinite;vertical-align:-1px}
@keyframes gm-spin{to{transform:rotate(360deg)}}
`;

    function SidebarIcon(props) {
      const edge = (props && Number(props.size)) || 20;
      return h('svg', { viewBox: '0 0 24 24', width: edge, height: edge, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('ellipse', { cx: 10, cy: 5.6, rx: 6.5, ry: 2.8 }),
        h('path', { d: 'M3.5 5.6v5.9c0 1.55 2.91 2.8 6.5 2.8s6.5-1.25 6.5-2.8V5.6' }),
        h('path', { d: 'M3.5 11.5v5.9c0 1.55 2.91 2.8 6.5 2.8' }),
        h('path', { d: 'M18.7 13.1l1.08 2.37 2.37 1.08-2.37 1.08-1.08 2.37-1.08-2.37-2.37-1.08 2.37-1.08z', fill: 'currentColor', stroke: 'none' })
      );
    }

    /** 文件用小图标，和纯色的目录块区分开。 */
    function FileGlyph({ size }) {
      const edge = size || 11;
      return h('svg', { className: 'ficon', viewBox: '0 0 12 14', width: edge, height: edge * 14 / 12, 'aria-hidden': true },
        h('path', { d: 'M1.2 1.6c0-.6.4-1 1-1h5l3.6 3.6v8.2c0 .6-.4 1-1 1H2.2c-.6 0-1-.4-1-1z', fill: 'rgba(255,255,255,.92)' }),
        h('path', { d: 'M7.4 1v3.4h3.4', fill: 'rgba(0,0,0,.28)' })
      );
    }

    function Badge({ risk }) {
      return h('span', { className: 'gm-badge', style: { background: riskVar(risk) } }, riskLabel(risk));
    }

    // ─────────────────────────────────────── 主页面

    function GarbageMasterPage() {
      const [snapshot, setSnapshot] = useState(null);
      const [targetId, setTargetId] = useState(null);
      const [treeData, setTreeData] = useState(null);
      const [cand, setCand] = useState(null);
      const [cart, setCart] = useState(() => new Map()); // path → {path,size,risk,kind,mode,special,note}
      const [currentPath, setCurrentPath] = useState(null);
      const [focus, setFocus] = useState(null);
      const [listing, setListing] = useState(null);
      const [listingLoading, setListingLoading] = useState(false);
      const [measured, setMeasured] = useState({});
      const [expanded, setExpanded] = useState(() => new Set());
      const [footOpen, setFootOpen] = useState(false);
      const [filter, setFilter] = useState('');
      const [plan, setPlan] = useState(null);
      const [finalOpen, setFinalOpen] = useState(false);
      const [ackDelete, setAckDelete] = useState(false);
      const [ackDir, setAckDir] = useState(false);
      const [running, setRunning] = useState(null);
      const [dispatch, setDispatch] = useState(null);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [settingsDraft, setSettingsDraft] = useState(null);
      const [specialFor, setSpecialFor] = useState(null);
      const [specialDraft, setSpecialDraft] = useState('');
      const [specialListing, setSpecialListing] = useState(null);
      const [levelTag, setLevelTag] = useState('all');
      const [explanations, setExplanations] = useState({});
      const [explainBusy, setExplainBusy] = useState(false);
      const [explainError, setExplainError] = useState(null);
      const [explainNonce, setExplainNonce] = useState(0);
      const [explainForce, setExplainForce] = useState(false);
      const [auditOpen, setAuditOpen] = useState(false);
      const [auditRuns, setAuditRuns] = useState(null);
      const [auditBusy, setAuditBusy] = useState(false);
      const [auditError, setAuditError] = useState(null);
      const [auditExpanded, setAuditExpanded] = useState(null);
      const [auditKeep, setAuditKeep] = useState(50);
      const [auditClearExplain, setAuditClearExplain] = useState(false);
      const [modelInfo, setModelInfo] = useState(null); // 解释用模型 + 可选思考强度
      const [sessionInfoState, setSessionInfoState] = useState(null); // 工作区绑定/权限/模型列表
      const [sessionPlanState, setSessionPlanState] = useState(null);  // 会话计划结果
      const [sessionPlanning, setSessionPlanning] = useState(false);
      const [sessionNotice, setSessionNotice] = useState(null);       // 会话侧提示（错误/进度）
      const [sessionConfirm, setSessionConfirm] = useState(false);
      const [staleToken, setStaleToken] = useState(false);
      const [explainPending, setExplainPending] = useState([]);
      const explainPendingSet = new Set(explainPending); // 树块与条目行都要用，必须在使用点之前
      const [cartFilter, setCartFilter] = useState('');
      const [report, setReport] = useState(null);
      const [showHidden, setShowHidden] = useState(true);
      const [riskFilter, setRiskFilter] = useState({ safe: true, caution: true, keep: true, blocked: true });
      const [showLog, setShowLog] = useState(false);
      const [toast, setToast] = useState(null);
      const [log, setLog] = useState([]);
      const [version, setVersion] = useState(0);
      const [size, setSize] = useState({ w: 900, h: 420 });

      const mapRef = useRef(null);
      const lastSeqRef = useRef(0);
      const handlerRef = useRef(() => {});
      const stateRef = useRef({});
      const nodesRef = useRef(new Map());
      const parentsRef = useRef(new Map());
      const lsSeqRef = useRef(0);
      const explainSeqRef = useRef(0);
      const explainedRef = useRef(new Set());

      stateRef.current = { targetId, running, treeData, currentPath };

      const showToast = useCallback((message) => {
        setToast(message);
        window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 2400);
      }, []);

      const indexTree = useCallback((root) => {
        const nodes = new Map();
        const parents = new Map();
        const walk = (node, parent) => {
          nodes.set(node.path, node);
          if (parent) parents.set(node.path, parent);
          for (const c of node.children || []) walk(c, node);
          for (const f of node.files || []) { nodes.set(f.path, f); parents.set(f.path, node); }
        };
        walk(root, null);
        nodesRef.current = nodes;
        parentsRef.current = parents;
      }, []);

      const loadSnapshot = useCallback(async () => {
        const data = await api('/api/state');
        setSnapshot(data);
        setTargetId((cur) => cur || (data.targets[0] && data.targets[0].id) || null);
        return data;
      }, []);
      const loadTree = useCallback(async (id) => {
        const data = await api(`/api/tree?target=${encodeURIComponent(id)}`);
        setTreeData(data);
        indexTree(data.tree);
        setCurrentPath((cur) => cur || data.root);
        setVersion((v) => v + 1);
        return data;
      }, [indexTree]);
      const loadCandidates = useCallback(async (id) => {
        const data = await api(`/api/candidates?target=${encodeURIComponent(id)}`);
        setCand(data);
        return data;
      }, []);
      const loadListing = useCallback(async (pathToRead) => {
        if (!pathToRead) return;
        const seq = lsSeqRef.current + 1;
        lsSeqRef.current = seq;
        setListingLoading(true);
        try {
          const data = await api(`/api/ls?path=${encodeURIComponent(pathToRead)}&limit=400`);
          if (lsSeqRef.current === seq) setListing(data);
        } catch (error) {
          if (lsSeqRef.current === seq) setListing({ path: pathToRead, children: [], error: error.message });
        } finally {
          if (lsSeqRef.current === seq) setListingLoading(false);
        }
      }, []);

      useEffect(() => { loadSnapshot().catch((e) => showToast(e.message)); }, [loadSnapshot, showToast]);

      useEffect(() => {
        if (!targetId) return;
        const summary = snapshot && snapshot.scans && snapshot.scans[targetId];
        if (summary && summary.status === 'complete') {
          loadTree(targetId).catch(() => {});
          loadCandidates(targetId).catch(() => {});
        } else {
          setTreeData(null);
          setCand(null);
          setCurrentPath(null);
          setListing(null);
        }
      }, [targetId, loadTree, loadCandidates]); // eslint-disable-line react-hooks/exhaustive-deps

      useEffect(() => { if (currentPath) loadListing(currentPath); }, [currentPath, loadListing]);

      const handleEvent = useCallback((event) => {
        setSnapshot((cur) => {
          if (!cur) return cur;
          const scans = Object.assign({}, cur.scans);
          let s = scans[event.targetId];
          if (event.type === 'scan-started' && !s) {
            // 首次扫描时 snapshot 里还没有这个目标，先建一条，界面才能立刻显示"扫描中"
            s = { status: 'scanning', progress: null, stats: null, usage: null, candidateCount: 0, candidateBytes: 0, treeVersion: 0 };
            scans[event.targetId] = s;
          }
          if (event.type === 'scan-progress' && s) scans[event.targetId] = Object.assign({}, s, { status: 'scanning', progress: event });
          else if (event.type === 'scan-started' && s) scans[event.targetId] = Object.assign({}, s, { status: 'scanning', progress: null });
          else if (event.type === 'scan-done' && s) scans[event.targetId] = Object.assign({}, s, {
            status: 'complete', progress: null, generated: event.generated, stats: event.stats,
            usage: event.usage, candidateCount: event.candidateCount,
            candidateBytes: event.totals ? event.totals.executableBytes : 0
          });
          else if (event.type === 'scan-failed' && s) scans[event.targetId] = Object.assign({}, s, { status: 'failed', error: event.error, progress: null });
          else if (event.type === 'scan-cancelled' && s) scans[event.targetId] = Object.assign({}, s, { status: 'cancelled', progress: null });
          else if (event.type === 'usage-refreshed' || event.type === 'run-done') {
            for (const key of Object.keys(scans)) {
              const run = event.type === 'run-done' && s && key === event.targetId ? s : scans[key];
              if (!run) continue;
            }
          }
          return Object.assign({}, cur, { scans });
        });

        setRunning((cur) => {
          if (event.type === 'run-started') {
            return {
              planId: event.planId, totals: event.totals, freedBytes: 0, status: 'running',
              shards: (event.shards || []).map((x) => Object.assign({}, x, { status: 'pending', freedBytes: 0 }))
            };
          }
          if (!cur) return cur;
          if (event.type === 'shard-started') {
            return Object.assign({}, cur, {
              shards: cur.shards.map((x) => (x.shardId === event.shardId ? Object.assign({}, x, { status: 'running' }) : x))
            });
          }
          if (event.type === 'shard-done') {
            const shards = cur.shards.map((x) => (x.shardId === event.shardId ? Object.assign({}, x, { status: 'done', freedBytes: event.verifiedBytes }) : x));
            if (event.diskFree != null) {
              setSnapshot((snap) => {
                if (!snap) return snap;
                const scans = Object.assign({}, snap.scans);
                const key = stateRef.current.targetId;
                if (scans[key] && scans[key].usage) scans[key] = Object.assign({}, scans[key], { usage: Object.assign({}, scans[key].usage, { free: event.diskFree }) });
                return Object.assign({}, snap, { scans });
              });
            }
            return Object.assign({}, cur, { shards });
          }
          if (event.type === 'run-done') {
            setReport(event.report);
            return Object.assign({}, cur, { status: event.report.status, freedBytes: event.report.actualBytes, endedAt: event.report.endedAt });
          }
          return cur;
        });

        if (event.type === 'explain-partial') {
          // 每一批解释完成就推过来：边解释边显示，不用等整层跑完
          const partial = event.results || {};
          const keys = Object.keys(partial);
          if (keys.length > 0) {
            for (const key of keys) explainedRef.current.add(key);
            setExplanations((cur) => Object.assign({}, cur, partial));
            setExplainPending((cur) => cur.filter((p) => !(p in partial)));
          }
        }

        if (event.type === 'item-deleted') {
          setCand((cur) => {
            if (!cur) return cur;
            const candidates = cur.candidates.filter((c) => c.path !== event.path);
            return Object.assign({}, cur, {
              candidates,
              totals: Object.assign({}, cur.totals, {
                executableCount: candidates.filter((c) => c.executable).length,
                executableBytes: candidates.filter((c) => c.executable).reduce((sum, c) => sum + c.size, 0)
              })
            });
          });
          setCart((cur) => { if (!cur.has(event.path)) return cur; const next = new Map(cur); next.delete(event.path); return next; });
          const node = nodesRef.current.get(event.path);
          const parent = parentsRef.current.get(event.path);
          if (node && parent && !event.dryRun) {
            const bytes = Number(node.size) || event.bytes || 0;
            parent.children = (parent.children || []).filter((c) => c.path !== event.path);
            parent.files = (parent.files || []).filter((f) => f.path !== event.path);
            if (parent.others && Array.isArray(parent.others.items)) parent.others.items = parent.others.items.filter((i) => i.path !== event.path);
            let cursor = parent;
            while (cursor) {
              cursor.size = Math.max(0, (Number(cursor.size) || 0) - bytes);
              cursor = parentsRef.current.get(cursor.path);
            }
            nodesRef.current.delete(event.path);
            setVersion((v) => v + 1);
          }
          setLog((cur) => [{ at: event.at, text: `已删除 ${fmtBytes(event.bytes)}  ${event.path}` }, ...cur].slice(0, 200));
        } else if (event.type === 'dispatch-started') {
          setDispatch({ mode: event.mode, lead: null, reason: event.reason || null, groups: (event.groups || []).map((g) => Object.assign({ status: 'pending' }, g)), errors: [] });
        } else if (event.type === 'dispatch-assigned') {
          setDispatch((cur) => (cur ? Object.assign({}, cur, { groups: cur.groups.map((g) => (g.mode === event.mode ? Object.assign({}, g, { teammate: event.teammate, taskId: event.taskId, status: 'assigned' }) : g)) }) : cur));
        } else if (event.type === 'dispatch-group-start' || event.type === 'group-run-started') {
          setDispatch((cur) => (cur ? Object.assign({}, cur, { groups: cur.groups.map((g) => (g.mode === event.mode ? Object.assign({}, g, { status: 'running' }) : g)) }) : cur));
        } else if (event.type === 'dispatch-group-done' || event.type === 'group-run-done') {
          setDispatch((cur) => (cur ? Object.assign({}, cur, { groups: cur.groups.map((g) => (g.mode === event.mode ? Object.assign({}, g, { status: event.ok === false || event.status === 'failed' ? 'failed' : 'done', reason: event.reason || null }) : g)) }) : cur));
        } else if (event.type === 'item-failed') {
          setLog((cur) => [{ at: event.at, text: `失败(${event.reason})  ${event.path}` }, ...cur].slice(0, 200));
        } else if (event.type === 'item-skipped') {
          setLog((cur) => [{ at: event.at, text: `跳过(${event.reason})  ${event.path}` }, ...cur].slice(0, 200));
        }

        if (event.type === 'scan-done' || event.type === 'run-done') {
          const id = stateRef.current.targetId;
          if (id) { loadTree(id).catch(() => {}); loadCandidates(id).catch(() => {}); loadSnapshot().catch(() => {}); }
          const here = stateRef.current.currentPath;
          if (here) setTimeout(() => loadListing(here), 400);
        }
      }, [loadTree, loadCandidates, loadListing, loadSnapshot]);

      handlerRef.current = handleEvent;

      useEffect(() => {
        const es = new EventSource(`${ROUTE_PREFIX}/api/events?token=${encodeURIComponent(TOKEN)}&seq=0`);
        es.onmessage = (message) => {
          try {
            const event = JSON.parse(message.data);
            if (event.seq && event.seq <= lastSeqRef.current) return;
            lastSeqRef.current = event.seq || lastSeqRef.current;
            handlerRef.current(event);
          } catch { /* 心跳 */ }
        };
        return () => es.close();
      }, []);

      useEffect(() => {
        const element = mapRef.current;
        if (!element) return undefined;
        const measure = () => setSize({ w: element.clientWidth, h: element.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }, [treeData]);

      // ── 派生
      const config = (snapshot && snapshot.config) || { workers: 3 };
      const scanSummary = snapshot && snapshot.scans && targetId ? snapshot.scans[targetId] : null;
      const target = snapshot && snapshot.targets ? snapshot.targets.find((x) => x.id === targetId) : null;
      const tree = treeData && treeData.tree;
      const rootPath = treeData ? treeData.root : '/';
      const current = currentPath || rootPath;
      const currentNode = nodesRef.current.get(current) || (tree && tree.path === current ? tree : null);
      const currentParent = currentNode ? parentsRef.current.get(currentNode.path) : null;
      const usage = (target && target.usage) || (scanSummary && scanSummary.usage) || (treeData && treeData.usage);
      const usedPercent = usage && usage.total ? Math.min(100, (usage.used / usage.total) * 100) : 0;
      const scanning = scanSummary && scanSummary.status === 'scanning';
      const visible = (name) => showHidden || !String(name).startsWith('.');
      // 注意区分两个"父级"概念：
      //   parentSize = 当前目录自己的体积（给子项算占比用）
      //   parentNodeSize = 当前目录的**父目录**体积（给"占上级"用）
      const parentSize = currentNode ? currentNode.size : 0;
      const parentNode = currentNode ? parentsRef.current.get(currentNode.path) : null;
      const parentNodeSize = parentNode ? parentNode.size : 0;

      /** 相对扫描根的层级：根=0，直接子项=1… */
      const levelOfPath = (rootPath, targetPath) => {
        if (!rootPath || !targetPath || !targetPath.startsWith(rootPath)) return 0;
        return targetPath.slice(rootPath.length).split('/').filter(Boolean).length;
      };

      // 逐层惰性解释：只解释"当前这一层"，深度超限就不解释子项（成本控制）
      useEffect(() => {
        if (!targetId || !currentPath || !listing || listing.path !== currentPath) return;
        // Host 尚未提供该字段时用默认 2（不要把"旧 Host"误当成"关闭解释"）
        const depth = config.explainDepth == null ? 2 : (Number(config.explainDepth) || 0);
        if (depth <= 0) return;
        const root = treeData && treeData.root ? treeData.root : null;
        const levelNow = root ? levelOfPath(root, currentPath) : 0;
        const children = (listing.children || []).slice(0, Math.max(1, Number(config.explainMaxItems) || 40));
        // 站在哪一层就解释哪一层的子项（逐层惰性）；深度只当开关用
        const allowChildren = depth > 0;
        const entries = [{ path: currentPath, isDir: true, size: currentNode ? currentNode.size : null }];
        if (allowChildren) {
          for (const child of children) entries.push({ path: child.path, isDir: child.isDir, size: child.size });
        }

        // Host 已经把"解释过的"随 /api/ls 一起带回来了（self.explanation / child.explanation）：
        // 直接采用，既不再发请求，也就不该出现转圈。
        const preloaded = {};
        if (listing.explanation && typeof listing.explanation === 'string') preloaded[currentPath] = listing.explanation;
        if (allowChildren) {
          for (const child of children) {
            if (child && typeof child.explanation === 'string' && child.explanation) preloaded[child.path] = child.explanation;
          }
        }
        const preloadedKeys = Object.keys(preloaded);
        if (preloadedKeys.length > 0) {
          let changed = false;
          for (const key of preloadedKeys) {
            if (!explainedRef.current.has(key)) { explainedRef.current.add(key); changed = true; }
          }
          if (changed) {
            setExplanations((cur) => {
              let next = cur;
              for (const key of preloadedKeys) {
                if (!next[key] || next[key].text !== preloaded[key]) {
                  if (next === cur) next = Object.assign({}, cur);
                  next[key] = { text: preloaded[key], source: 'cache', confidence: 0.9 };
                }
              }
              return next;
            });
          }
        }

        const wanted = entries.filter((e) => {
          if (explainForce) return true;
          if (explainedRef.current.has(e.path)) return false;
          return !preloaded[e.path];
        });
        if (wanted.length === 0) { setExplainPending([]); return; }
        const seq = explainSeqRef.current + 1;
        explainSeqRef.current = seq;
        setExplainBusy(true);
        setExplainPending(wanted.map((e) => e.path)); // 逐条告诉用户"这条正在解释"

        api('/api/explain', { method: 'POST', body: { entries: wanted, force: explainForce } })
          .then((out) => {
            if (explainSeqRef.current !== seq) return;
            const results = out.results || {};
            for (const key of Object.keys(results)) explainedRef.current.add(key);
            setExplanations((cur) => Object.assign({}, cur, results));
            setExplainError(out.error || null);
          })
          .catch((error) => {
            // 不再静默：Host 还没重启时 /api/explain 不存在，要让用户知道为什么没有解释
            if (explainSeqRef.current === seq) setExplainError(error && error.message ? error.message : 'explain-failed');
          })
          .finally(() => {
            if (explainSeqRef.current !== seq) return;
            setExplainBusy(false);
            setExplainPending([]);
            setExplainForce(false); // 强制刷新只作用于这一次
          });
      }, [targetId, currentPath, listing, config.explainDepth, config.explainMaxItems, treeData, explainNonce, explainForce]); // eslint-disable-line react-hooks/exhaustive-deps



      const tiles = useMemo(() => {
        if (!currentNode) return [];
        const items = [];
        for (const child of currentNode.children || []) {
          items.push({ key: child.path, path: child.path, name: child.name, size: child.size, risk: child.risk || 'caution', kind: 'dir' });
        }
        const others = currentNode.others;
        if (others && Array.isArray(others.items)) {
          for (const item of others.items) {
            if (!item || typeof item.path !== 'string') continue;
            items.push({ key: item.path, path: item.path, name: item.name, size: item.size, risk: 'caution', kind: 'dir', folded: true });
          }
          const listed = others.items.reduce((sum, x) => sum + (x.size || 0), 0);
          const restCount = (others.count || 0) - others.items.length;
          const restSize = (others.size || 0) - listed;
          if (restCount > 0 && restSize > 0) {
            items.push({
              key: `${currentNode.path}::others`, path: currentNode.path, kind: 'agg', agg: true,
              name: t('otherDirs', { n: restCount }), size: restSize, risk: 'keep'
            });
          }
        }
        for (const file of currentNode.files || []) {
          items.push({ key: file.path, path: file.path, name: String(file.path).split('/').pop(), size: file.size, risk: file.risk || 'caution', kind: 'file' });
        }
        if ((currentNode.smallRest || 0) > 50 * 1024 * 1024) {
          items.push({ key: `${currentNode.path}::rest`, path: currentNode.path, kind: 'agg', agg: true, name: t('restFiles'), size: currentNode.smallRest, risk: 'keep' });
        }
        const sorted = items.filter((item) => visible(item.name)).sort((a, b) => b.size - a.size);
        // 按**占比**折叠：小于当前目录 0.5% 的块只会变成没有文字的碎片，合并成一个"其他 N 项"
        const totalSize = sorted.reduce((sum, x) => sum + (x.size || 0), 0) || 1;
        const head = sorted.filter((x) => (x.size || 0) / totalSize >= 0.015 || x.agg);
        const tail = sorted.filter((x) => !head.includes(x));
        if (tail.length > 0) {
          head.push({
            key: `${currentNode.path}::folded`,
            path: currentNode.path,
            kind: 'agg',
            agg: true,
            name: t('foldedItems', { n: tail.length }),
            size: tail.reduce((sum, x) => sum + (x.size || 0), 0),
            risk: 'keep'
          });
        }
        return head;
      }, [currentNode, showHidden, version]); // eslint-disable-line react-hooks/exhaustive-deps

      const visibleTiles = tiles.filter((item) => riskFilter[item.risk] !== false);
      const rects = useMemo(
        () => squarify(visibleTiles, 2, 2, Math.max(10, size.w - 4), Math.max(10, size.h - 10)),
        [visibleTiles.map((i) => i.key).join('|'), size.w, size.h, JSON.stringify(riskFilter)] // eslint-disable-line react-hooks/exhaustive-deps
      );

      const childRows = useMemo(() => {
        const rows = [];
        const seen = new Set();
        // 实时读取优先：它带**规则判定出的描述**与真实修改时间，树里的行据此补齐
        const live = new Map(((listing && listing.children) || []).map((c) => [c.path, c]));
        const enrich = (row) => {
          const hit = live.get(row.path);
          if (!hit) return row;
          return Object.assign({}, row, {
            risk: hit.risk || row.risk,
            note: hit.note || row.note,
            mtime: hit.mtime || row.mtime,
            executable: hit.executable,
            candidate: hit.candidate
          });
        };
        const push = (row) => { if (!row || !row.path || seen.has(row.path)) return; seen.add(row.path); rows.push(enrich(row)); };
        if (currentNode) {
          for (const child of currentNode.children || []) push({ name: child.name, path: child.path, isDir: true, size: child.size, risk: child.risk || 'caution', mtime: child.mtime, fromTree: true });
          for (const item of (currentNode.others && Array.isArray(currentNode.others.items)) ? currentNode.others.items : []) {
            push({ name: item.name, path: item.path, isDir: true, size: item.size, risk: 'caution', fromTree: true, folded: true });
          }
          for (const file of currentNode.files || []) push({ name: String(file.path).split('/').pop(), path: file.path, isDir: false, size: file.size, risk: file.risk || 'caution', mtime: file.mtime, fromTree: true });
        }
        for (const child of (listing && listing.children) || []) {
          push({
            name: child.name, path: child.path, isDir: child.isDir, size: child.size, risk: child.risk, mtime: child.mtime,
            executable: child.executable, candidate: child.candidate, note: child.note, live: true, sizeApprox: child.sizeApprox
          });
        }
        const known = (v) => (typeof v === 'number' ? v : -1);
        rows.sort((a, b) => (a.isDir === b.isDir ? known(b.size) - known(a.size) || a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)));
        return rows.filter((row) => visible(row.name));
      }, [currentNode, listing, showHidden, version]); // eslint-disable-line react-hooks/exhaustive-deps

      const candidates = (cand && cand.candidates) || [];
      const selectable = candidates.filter((c) => c.executable && c.risk !== 'blocked' && c.risk !== 'keep');

      /** 规则建议按作用域收敛：盘根显示该目标全部，深入后只显示当前路径下的。 */
      const scopedCandidates = useMemo(() => {
        const atRoot = Boolean(tree && current === tree.path);
        const under = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
        return candidates.filter((c) => (atRoot ? true : under(c.path, current)));
      }, [candidates, current, tree]);

      /** 「本层条目」= 直接子项 + 作用域内的规则建议（按路径去重，建议项打上推荐标记）。 */
      const levelRows = useMemo(() => {
        const rows = childRows.slice();
        const seen = new Set(rows.map((row) => row.path));
        const extras = scopedCandidates
          .filter((c) => !seen.has(c.path))
          .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))
          .map((c) => ({
            name: c.name || String(c.path).split('/').pop(),
            path: c.path,
            isDir: c.kind === 'dir',
            size: typeof c.size === 'number' ? c.size : null,
            risk: c.risk,
            note: c.note,
            mtime: null,
            candidate: true,
            executable: c.executable,
            suggested: true
          }));
        return rows.concat(extras);
      }, [childRows, scopedCandidates]);

      const selfInfo = useMemo(() => {
        const fromListing = listing && listing.path === current ? listing : null;
        return {
          risk: (fromListing && fromListing.risk) || (currentNode && currentNode.risk) || 'caution',
          note: (fromListing && fromListing.note) || '' ,
          remedy: (fromListing && fromListing.remedy) || null,
          size: currentNode ? currentNode.size : (fromListing ? fromListing.size : null),
          sizeApprox: currentNode ? false : Boolean(fromListing && fromListing.sizeApprox),
          dirCount: (fromListing && fromListing.dirCount) != null ? fromListing.dirCount : (currentNode ? (currentNode.children || []).length : null),
          fileCount: (fromListing && fromListing.fileCount) != null ? fromListing.fileCount : (currentNode ? (currentNode.files || []).length : null),
          truncated: Boolean(fromListing && fromListing.truncated),
          total: fromListing ? fromListing.total : null,
          error: fromListing ? fromListing.error : null,
          mtime: currentNode ? currentNode.mtime : (fromListing ? fromListing.mtime : null)
        };
      }, [listing, currentNode, current]);

      const cartItems = useMemo(() => [...cart.values()], [cart]);
      const cartBytes = cartItems.reduce((sum, i) => sum + (Number(i.size) || 0), 0);
      const filteredCart = useMemo(() => {
        const q = cartFilter.trim().toLowerCase();
        if (!q) return cartItems;
        return cartItems.filter((i) => i.path.toLowerCase().includes(q) || String(i.name || '').toLowerCase().includes(q));
      }, [cartItems, cartFilter]);

      // ── 选择动作
      const inCart = (p) => cart.has(p);
      const toggleCart = (row, patch) => {
        setCart((cur) => {
          const next = new Map(cur);
          if (next.has(row.path)) {
            if (patch) next.set(row.path, Object.assign({}, next.get(row.path), patch));
            else next.delete(row.path);
          } else {
            next.set(row.path, Object.assign({
              path: row.path,
              name: row.name || String(row.path).split('/').pop(),
              size: typeof row.size === 'number' ? row.size : null,
              risk: row.risk || 'caution',
              isDir: row.isDir !== false && row.kind !== 'file',
              note: row.note || '',
              mode: 'clean',
              special: ''
            }, patch || {}));
          }
          return next;
        });
      };
      const setCartMode = (p, mode) => toggleCart({ path: p }, { mode });
      const setCartSpecial = (p, special) => toggleCart({ path: p }, { special: String(special).slice(0, 2000) });
      const addCurrentToCart = (mode) => toggleCart({ path: current, name: current.split('/').filter(Boolean).pop() || current, size: currentNode ? currentNode.size : null, risk: selfInfo.risk, isDir: true, note: selfInfo.note }, { mode: mode || 'clean' });
      const renderAtTokens = (text) => {
        const parts = String(text || '').split(/(@[^\s@]+)/g);
        return parts.map((part, i) => (part.startsWith('@')
          ? h('span', { key: i, className: 'gm-at' }, part)
          : h('span', { key: i }, part)));
      };
      const openSpecial = async (cartPath) => {
        const item = cart.get(cartPath);
        setSpecialFor(cartPath);
        setSpecialDraft(item ? item.special || '' : '');
        setSpecialListing(null);
        try {
          const data = await api(`/api/ls?path=${encodeURIComponent(cartPath)}&limit=200`);
          setSpecialListing(data);
        } catch { setSpecialListing({ children: [] }); }
      };
      const saveSpecial = () => {
        if (specialFor) setCartSpecial(specialFor, specialDraft);
        setSpecialFor(null);
      };
      const insertAt = (childPath) => setSpecialDraft((cur) => `${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}@${childPath} `);
      /** 设置里的「重新解释」：清掉当前层的已解释标记，带 force 重新请求（绕过缓存）。 */
      const reexplainCurrent = () => {
        if (!currentPath) return;
        const levelPaths = [currentPath, ...((listing && listing.children) || []).slice(0, 60).map((c) => c.path)];
        for (const p of levelPaths) explainedRef.current.delete(p);
        setExplainError(null);
        setExplainForce(true);
        setExplainNonce((n) => n + 1);
        setSettingsOpen(false);
        showToast(t('reexplainStarted'));
      };

      // 把"令牌过期"接进组件：展示提示 + 自动刷新一次
      useEffect(() => {
        staleTokenSink = () => setStaleToken(true);
        dictSink = t;
        return () => { staleTokenSink = null; dictSink = null; };
      }, []);

      useEffect(() => {
        if (!staleToken) return undefined;
        let alreadyTried = false;
        try { alreadyTried = sessionStorage.getItem('garbage_master_token_reloaded') === '1'; } catch { alreadyTried = false; }
        if (alreadyTried) return undefined; // 已经自动刷过一次，交给用户点按钮，避免刷新循环
        try { sessionStorage.setItem('garbage_master_token_reloaded', '1'); } catch { /* 隐私模式下忽略 */ }
        const timer = setTimeout(() => { try { window.location.reload(); } catch { /* 忽略 */ } }, 1200);
        return () => clearTimeout(timer);
      }, [staleToken]);

      // 请求恢复正常（拿到新令牌）后清掉标记，下次还能自动刷新
      useEffect(() => {
        if (!snapshot) return;
        try { sessionStorage.removeItem('garbage_master_token_reloaded'); } catch { /* 忽略 */ }
      }, [snapshot]);

      /** 读会话侧信息：绑定工作区、权限预设、模型列表、会话策略。 */
      const loadSessionInfo = async () => {
        try { setSessionInfoState(await api('/api/session-info')); } catch { setSessionInfoState(null); }
      };

      /** 用会话生成执行计划（程序拼提示词 → plan 模式会话 → Markdown）。 */
      const sessionPlan = async () => {
        if (sessionPlanning) return;
        setSessionPlanning(true);
        setSessionNotice(null);
        try {
          const items = cartItems.map((i) => ({ path: i.path, mode: i.mode, special: i.special || '' }));
          const out = await api('/api/session-plan', { method: 'POST', body: { targetId, items, includeRecursive: true } });
          if (!out.ok) { setSessionNotice(out.error || t('sessionPlanFailed')); return; }
          setSessionPlanState(out);
          setSessionConfirm(false);
          setFootOpen(false);
        } catch (error) {
          setSessionNotice(error.message);
        } finally {
          setSessionPlanning(false);
        }
      };

      /** 二次确认后在同一个会话里执行。 */
      const sessionExecute = async () => {
        if (!sessionPlanState) return;
        try {
          const out = await api('/api/session-execute', {
            method: 'POST',
            body: { sessionId: sessionPlanState.sessionId, planId: sessionPlanState.planId, planPath: sessionPlanState.planPath }
          });
          if (!out.ok) { setSessionNotice(out.error || t('sessionExecuteFailed')); return; }
          setSessionConfirm(false);
          setSessionPlanState(Object.assign({}, sessionPlanState, { executed: true, permission: out.permission || null, preset: out.preset || null }));
          setCart(new Map());
        } catch (error) {
          setSessionNotice(error.message);
        }
      };

      /** 设置里展示"解释用哪个模型、可选哪些思考强度"。 */
      const loadModelInfo = async () => {
        try { setModelInfo(await api('/api/explain-model')); } catch { setModelInfo(null); }
      };

      /** 打开审计面板：拉取历史清理记录（新的在前）。 */
      const openAudit = async () => {
        setAuditOpen(true);
        setAuditBusy(true);
        setAuditError(null);
        try {
          const out = await api('/api/audit/list?limit=100');
          setAuditRuns(Array.isArray(out.runs) ? out.runs : []);
        } catch (error) {
          setAuditError(`${t('auditLoadFailed')}：${error.message}`);
          setAuditRuns([]);
        } finally {
          setAuditBusy(false);
        }
      };

      /** 清理审计日志（保留最近 N 次；可选顺带清空解释缓存）。 */
      const pruneAuditLogs = async () => {
        const keep = Number(auditKeep);
        if (!Number.isFinite(keep) || keep <= 0) { showToast(t('auditNothingToPrune')); return; }
        try {
          const out = await api('/api/audit/prune', { method: 'POST', body: { keep, clearExplainCache: auditClearExplain } });
          showToast(t('auditPruned', { n: out.removed == null ? 0 : out.removed, keep: out.kept == null ? keep : out.kept }));
          await openAudit();
        } catch (error) { showToast(error.message); }
      };

      const saveSettings = async () => {
        if (!settingsDraft) return;
        try {
          const out = await api('/api/settings', {
            method: 'POST',
            body: {
              bigFileBytes: Number(settingsDraft.bigFileBytes) * 1024 ** 2,
              minExpandBytes: Number(settingsDraft.minExpandBytes) * 1024 ** 2,
              minCandidateBytes: Number(settingsDraft.minCandidateBytes) * 1024,
              maxDepth: Number(settingsDraft.maxDepth),
              keepTop: Number(settingsDraft.keepTop),
              filesPerDir: Number(settingsDraft.filesPerDir),
              workers: Number(settingsDraft.workers),
              explainDepth: Number(settingsDraft.explainDepth),
              explainMaxItems: Number(settingsDraft.explainMaxItems),
              explainMaxSearches: Number(settingsDraft.explainMaxSearches),
              explainUseWeb: settingsDraft.explainUseWeb !== false,
              explainConcurrency: Number(settingsDraft.explainConcurrency),
              explainReasoningEffort: settingsDraft.explainReasoningEffort || '',
              workspaceId: settingsDraft.workspaceId || '',
              planSession: settingsDraft.planSession !== false,
              explainModel: settingsDraft.explainModel || ''
            }
          });
          setSettingsOpen(false);
          showToast(`${t('saved')}（${t('settingsHint')}）`);
          if (out && out.settings) setSnapshot((cur) => (cur ? Object.assign({}, cur, { config: Object.assign({}, cur.config, { workers: out.settings.workers }) }) : cur));
        } catch (e) { showToast(e.message); }
      };
      const locate = (p) => { setCurrentPath(p.slice(0, p.lastIndexOf('/')) || '/'); setFocus({ path: p }); };

      const startScan = async () => {
        if (!targetId) return;
        try { await api('/api/scan', { method: 'POST', body: { targetId } }); showToast(`${t('scanning')}…`); }
        catch (e) { showToast(e.message); }
      };
      const cancelScan = async () => { try { await api('/api/cancel-scan', { method: 'POST', body: { targetId } }); } catch (e) { showToast(e.message); } };
      const doReveal = async (p) => {
        try { await api('/api/reveal', { method: 'POST', body: { path: p } }); showToast(t('reveal')); }
        catch (e) { showToast(`${t('openFailed')}: ${e.message}`); }
      };
      const doOpen = async (p) => { try { await api('/api/open', { method: 'POST', body: { path: p } }); } catch (e) { showToast(`${t('openFailed')}: ${e.message}`); } };
      const copyText = async (text, message) => {
        try { await navigator.clipboard.writeText(text); showToast(message || t('copied')); } catch { showToast(t('copied')); }
      };
      const doMeasure = async (p) => {
        try {
          showToast(t('measuring'));
          const out = await api('/api/measure', { method: 'POST', body: { path: p } });
          setMeasured((cur) => Object.assign({}, cur, { [p]: out }));
          showToast(`${fmtBytes(out.bytes)}${out.truncated ? ' (≥)' : ''}`);
        } catch (e) { showToast(e.message); }
      };
      const goInto = (row) => {
        const isDir = row.isDir === true || row.kind === 'dir';
        if (isDir) { setCurrentPath(row.path); setFocus(null); }
        else setFocus({ path: row.path, name: row.name, size: row.size, risk: row.risk, note: row.note });
      };
      const up = () => setCurrentPath(current.slice(0, current.lastIndexOf('/')) || '/');

      // ── 计划流程：提交 → 计划 → 确认 → 二次确认 → 执行
      const submitPlan = async () => {
        // 定稿：快速计划被"会话计划"替换；会话能力不可用时才回落到旧的快速计划
        if (config.planSession !== false) { await sessionPlan(); return; }
        try {
          const items = cartItems.map((i) => ({ path: i.path, mode: i.mode, special: i.special || '' }));
          const out = await api('/api/plan', {
            method: 'POST',
            body: { targetId, items, includeRecursive: true }
          });
          setPlan(out);
          setFootOpen(false);
          setLog((cur) => [{ at: Date.now(), text: `计划 ${out.planId}：${out.totals.count} 项 / ${fmtBytes(out.totals.bytes)}` }, ...cur].slice(0, 200));
        } catch (e) { showToast(e.message); }
      };
      const runPlan = async () => {
        if (!plan) return;
        try {
          const out = await api('/api/dispatch', { method: 'POST', body: { planId: plan.planId, confirmToken: plan.confirmToken } });
          setFinalOpen(false); setAckDelete(false); setAckDir(false); setPlan(null);
          const groups = (out.dispatch && out.dispatch.groups) || [];
          setDispatch({ mode: out.mode, lead: out.lead || null, reason: out.reason || null, groups, errors: (out.dispatch && out.dispatch.errors) || [] });
          const reports = (out.reports || []).filter((r) => r && !r.error);
          setReport(reports.length > 0 ? reports[reports.length - 1] : null);
          setCart(new Map());
          showToast(out.mode === 'team'
            ? `${t('dispatchTeam')}（${groups.length}）`
            : `${t('dispatchInProcess')}`);
        } catch (e) { showToast(e.message); }
      };
      const cancelRun = async () => { try { await api('/api/cancel', { method: 'POST', body: {} }); } catch (e) { showToast(e.message); } };

      // ── 渲染
      const staleBanner = staleToken ? h('div', { className: 'gm-stale' },
        h('b', null, `⚠ ${t('staleTokenTitle')}`),
        h('span', null, t('staleTokenHint')),
        h('span', { className: 'gm-t3' }, t('staleTokenAuto')),
        h('button', { className: 'gm-btn', onClick: () => { try { sessionStorage.removeItem('garbage_master_token_reloaded'); } catch { /* 忽略 */ } window.location.reload(); } }, t('staleTokenReload'))
      ) : null;

      const header = h('div', { className: 'gm-header' },
        h('div', { className: 'gm-h1' },
          h('h1', null, t('panel')),
          h('div', { className: 'gm-tabs' }, (snapshot ? snapshot.targets : []).map((item) =>
            h('button', {
              key: item.id, title: item.path, className: `gm-tab${item.id === targetId ? ' on' : ''}`,
              onClick: () => { setTargetId(item.id); setCurrentPath(null); setFocus(null); setCart(new Map()); setReport(null); }
            },
            h('b', null, item.path === '/' ? '根分区 /' : String(item.path).replace(/\/+$/, '').split('/').pop()),
            h('span', null, item.usage ? `${t('free')} ${fmtFree(item.usage.free)} · ${t('used')} ${Math.round((item.usage.used / (item.usage.total || 1)) * 100)}%` : t('unknown'))))),
          h('div', { className: 'gm-spacer' }),
          h('div', { className: 'gm-chips' },
            h('span', { className: 'gm-legend-label' }, t('legend')),
            ['safe', 'caution', 'keep', 'blocked'].map((risk) =>
            h('span', {
              key: risk, className: `gm-chip${riskFilter[risk] ? '' : ' off'}`,
              onClick: () => setRiskFilter((cur) => Object.assign({}, cur, { [risk]: !cur[risk] }))
            }, h('i', { style: { background: dotVar(risk), border: '1px solid var(--dsw-alias-label-secondary)' } }), riskLabel(risk)))),
          h('button', { className: 'gm-btn', onClick: async () => {
            try {
              let settings = {};
              try {
                const out = await api('/api/settings');
                settings = out.settings || {};
              } catch (error) {
                // Host 侧还没重启时这个路由不存在：先按默认值打开弹窗，并说清楚为什么保存会失败
                showToast(`${t('settingsNeedsRestart')}`);
              }
              setSettingsDraft({
                bigFileBytes: Math.round((settings.bigFileBytes || 0) / 1024 ** 2),
                minExpandBytes: Math.round((settings.minExpandBytes || 0) / 1024 ** 2),
                minCandidateBytes: Math.round((settings.minCandidateBytes || 0) / 1024),
                maxDepth: settings.maxDepth || 9,
                keepTop: settings.keepTop || 20,
                filesPerDir: settings.filesPerDir || 20,
                workers: settings.workers || 3,
                explainDepth: settings.explainDepth == null ? 2 : settings.explainDepth,
                explainMaxItems: settings.explainMaxItems || 40,
                explainMaxSearches: settings.explainMaxSearches == null ? 2 : settings.explainMaxSearches,
                explainUseWeb: settings.explainUseWeb !== false,
                explainConcurrency: settings.explainConcurrency == null ? 3 : settings.explainConcurrency,
                explainReasoningEffort: settings.explainReasoningEffort || '',
                workspaceId: settings.workspaceId || '',
                planSession: settings.planSession !== false,
                explainModel: settings.explainModel || ''
              });
              setSettingsOpen(true);
            } catch (e) { showToast(e.message); }
          } }, `⚙ ${t('settings')}`),
          h('button', { className: 'gm-btn', onClick: scanning ? cancelScan : startScan, disabled: !targetId },
            scanning ? `⟳ ${t('cancelScan')}` : (scanSummary && scanSummary.status === 'complete' ? t('rescan') : t('scan')))
        ),
        h('div', { className: 'gm-diskbar' }, h('i', { style: { width: `${usedPercent}%` } })),
        scanning ? h('div', { className: 'gm-scanbar', title: t('scanAnim') }, h('i')) : null,
        h('div', { className: 'gm-meta' },
          usage ? h('span', { className: 'gm-t2' }, `${t('size')} `, h('b', { className: 'gm-t1' }, fmtBytes(usage.total)),
            ' · ', t('used'), ' ', h('b', { className: 'gm-t1' }, `${fmtBytes(usage.used)}（${Math.round(usedPercent)}%）`),
            ' · ', t('free'), ' ', h('b', { className: 'gm-t1' }, fmtBytes(usage.free))) : null,
          scanning && scanSummary.progress ? h('span', { className: 'gm-t2' }, `${t('scanning')}：${scanSummary.progress.dirs} ${t('dirs')} · ${scanSummary.progress.files} ${t('files')}`) : null,
          scanSummary && scanSummary.generated
            ? h('span', { className: 'gm-t3' }, `${t('scannedAt')} ${(() => {
              const d = new Date(scanSummary.generated);
              if (Number.isNaN(d.getTime())) return scanSummary.generated;
              const p = (x) => String(x).padStart(2, '0');
              return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
            })()}`)
            : null,
          scanSummary && scanSummary.stats ? h('span', { className: 'gm-t3' },
            t('noPermission', { n: scanSummary.stats.denied }), ' · ', t('symlinks', { n: scanSummary.stats.symlinks })) : null,
          scanSummary && scanSummary.error ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, scanSummary.error) : null,
          null
        )
      );

      const breadcrumb = useMemo(() => {
        const parts = [];
        let cursor = current;
        while (cursor && cursor !== '/') { parts.unshift(cursor); cursor = cursor.slice(0, cursor.lastIndexOf('/')) || '/'; }
        parts.unshift('/');
        return parts;
      }, [current]);

      const mapCard = h('div', { className: 'gm-card' },
        h('div', { className: 'gm-cardhead' },
          h('div', { className: 'gm-crumb' }, breadcrumb.map((p, i) =>
            h(React.Fragment, { key: p },
              i > 0 ? h('span', { className: 'sep' }, '›') : null,
              h('button', { className: i === breadcrumb.length - 1 ? 'cur' : '', onClick: () => { setCurrentPath(p); setFocus(null); } }, i === 0 ? '/' : p.split('/').pop())))),
          h('div', { className: 'gm-spacer' }),
          h('span', { className: 'gm-t3' }, t('mapLimitHint')),
          h('span', { className: `gm-chip${showHidden ? '' : ' off'}`, onClick: () => setShowHidden((v) => !v) }, t('showHidden')),
          h('button', { className: 'gm-mini always', onClick: up, disabled: current === rootPath }, t('up'))
        ),
        h('div', { className: 'gm-map', ref: mapRef },
          !tree
            ? h('div', { className: 'gm-empty' }, scanSummary && scanSummary.status === 'scanning' ? `${t('scanning')}…` : t('noTree'))
            : (currentNode
              ? rects.map((rect, index) => {
                const item = rect.it;
                const isFile = item.kind === 'file';
                const activate = () => {
                  if (item.kind === 'dir') goInto(item);
                  else if (isFile) setFocus({ path: item.path, name: item.name, size: item.size, risk: item.risk });
                };
                const share = pct(item.size, parentSize);
                const showText = item.agg ? (rect.w > 38 && rect.h > 15) : (rect.w > 52 && rect.h > 22);
                const cls = ['gm-tile', isFile ? 'kfile' : 'kdir'];
                if (item.agg) cls.push('agg');
                if (focus && focus.path === item.path) cls.push('focus');
                if (!riskFilter[item.risk]) cls.push('muted');
                if (inCart(item.path)) cls.push('focus');
                if (explainPendingSet.has(item.path)) cls.push('pending'); // 正在解释：描边 + 脉冲
                return h('div', {
                  key: item.key, className: cls.join(' '),
                  style: { left: rect.x, top: rect.y, width: Math.max(0, rect.w), height: Math.max(0, rect.h), background: item.agg ? 'var(--gm-keep2)' : riskVar(item.risk) },
                  title: item.agg
                    ? `${item.name} · ${fmtBytes(item.size)}`
                    : `${item.path}\n${fmtBytes(item.size)}${share != null ? ` · ${t('shareOfCurrent', { p: share.toFixed(1) })}` : ''}\n${riskLabel(item.risk)}\n\n${(explanations[item.path] && explanations[item.path].text) || item.note || ''}`,
                  // 单击目录 = 进入下一层；单击文件 = 聚焦（双击文件才打开）
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': `${item.name}${item.agg ? '' : ` · ${fmtBytes(item.size)}`}`,
                  onClick: activate,
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } },
                  onDoubleClick: () => { if (isFile) doOpen(item.path); }
                },
                showText
                  ? h('div', { className: 'row' },
                    isFile ? h(FileGlyph) : null,
                    h('div', { className: 'tn' }, item.name),
                    explainPendingSet.has(item.path) ? h('span', { className: 'gm-spin gm-spin-sm', title: t('explaining') }) : null)
                  : (explainPendingSet.has(item.path) ? h('span', { className: 'gm-spin gm-spin-sm gm-tsp', title: t('explaining') }) : null),
                showText && rect.h > 40 ? h('div', { className: 'ts', style: { marginBottom: 2 } }, fmtBytes(item.size), share != null ? h('span', { className: 'pct' }, ` · ${share.toFixed(0)}%`) : null) : null);
              })
              : h('div', { className: 'gm-empty' }, t('outsideTree')))
        )
      );

      // 当前位置卡：头 + 可滚动内容（解释完整显示）+ **固定在卡底的操作行**
      const explainSelf = explanations[current] || null;
      const currentCard = h('div', { className: 'gm-card gm-card--current' },
        h('div', { className: 'gm-cardhead' },
          h('b', null, t('current')),
          listingLoading || explainBusy ? h('span', { className: 'gm-spin' }) : null,
          h('div', { className: 'gm-spacer' }),
          h(Badge, { risk: selfInfo.risk })
        ),
        h('div', { className: 'gm-cardbody' },
          h('div', { className: 'gm-path', title: current }, current),
          h('div', { className: 'gm-meta', style: { marginTop: 6, gap: 12 } },
            h('span', { className: 'gm-t2' }, t('size'), ' ', h('b', { className: 'gm-t1' }, fmtBytes(selfInfo.size)), selfInfo.sizeApprox ? ` (${t('approx')})` : ''),
            h('span', { className: 'gm-t2' }, t('shareOfParentLabel'), ' ',
              h('b', { className: 'gm-t1' }, parentNodeSize && selfInfo.size ? `${((selfInfo.size / parentNodeSize) * 100).toFixed(1)}%` : t('unknown'))),
            h('span', { className: 'gm-t2' }, t('modified'), ' ', h('b', { className: 'gm-t1' }, fmtDate(selfInfo.mtime))),
            h('span', { className: 'gm-t3' }, `${t('dirs')} ${selfInfo.dirCount == null ? t('unknown') : selfInfo.dirCount} · ${t('files')} ${selfInfo.fileCount == null ? t('unknown') : selfInfo.fileCount}`)
          ),
          focus ? h('div', { className: 'gm-note' },
            h('b', null, `${t('focusFile')}: `), focus.path,
            h('div', { className: 'gm-sub' }, `${fmtBytes(focus.size)} · ${riskLabel(focus.risk)}`)) : null,
          // 解释：规则 / AI 推测 / 联网，完整显示（不截断）
          explainPendingSet.has(current) && !explainSelf
            ? h('div', { className: 'gm-note gm-note-wait' }, h('span', { className: 'gm-spin gm-spin-sm' }), ` ${t('explaining')}…`)
            : null,
          (explainSelf || selfInfo.note)
            ? h('div', { className: 'gm-note' },
              explainSelf ? h('span', { className: 'gm-t3', style: { marginRight: 6 } }, `[${explainSelf.source === 'rule' ? t('sourceRule') : explainSelf.source === 'web' ? t('sourceWeb') : explainSelf.source === 'cache' ? t('sourceCache') : t('sourceLlm')}]`) : null,
              explainSelf ? explainSelf.text : selfInfo.note)
            : null,
          selfInfo.remedy ? h('div', { className: 'gm-note' },
            h('b', null, `${t('remedy')}: `), h('code', null, selfInfo.remedy.command),
            h('button', { className: 'gm-mini always', style: { marginLeft: 8 }, onClick: () => copyText(selfInfo.remedy.command, t('copiedCmd')) }, t('copyCmd')),
            h('div', { className: 'gm-sub' }, selfInfo.remedy.why)) : null,
          selfInfo.error ? h('div', { className: 'gm-empty' }, `${t('loadFailed')}: ${selfInfo.error}`) : null
        ),
        // 操作行固定在卡片底部：复制路径 / 在资源管理器中打开 / 操作下拉（默认清理）
        h('div', { className: 'gm-cardfoot' },
          h('button', { className: 'gm-mini always', onClick: () => copyText(current) }, t('copyPath')),
          h('button', { className: 'gm-mini always', onClick: () => doReveal(current) }, t('reveal')),
          h('select', {
            className: 'gm-select', value: '', title: t('operation'),
            onChange: (e) => { const mode = e.target.value; if (mode) addCurrentToCart(mode); e.target.value = ''; }
          },
          h('option', { value: '' }, `${t('operation')}…`),
          h('option', { value: 'clean' }, t('modeClean')),
          h('option', { value: 'pack' }, t('modePack')),
          h('option', { value: 'tidy' }, t('modeTidy')))
        )
      );

      // 右下方：本层条目 / 规则建议
      // 本层条目行：单行信息（名称 / 体积 / 占比）+ 细进度条，行高压到 ~34px
      const levelRow = (row, index) => {
        const measuredHere = measured[row.path];
        const rowSize = typeof row.size === 'number' ? row.size : (measuredHere ? measuredHere.bytes : null);
        const share = pct(rowSize, selfInfo.size);
        const picked = cart.get(row.path);
        return h('div', {
          key: row.path, className: 'gm-row', title: row.note || row.path,
          onClick: () => goInto(row),
          onDoubleClick: () => { if (!row.isDir) doOpen(row.path); }
        },
        h('input', {
          type: 'checkbox', checked: Boolean(picked), 'aria-label': row.path,
          onClick: (e) => e.stopPropagation(),
          onChange: () => toggleCart({ path: row.path, name: row.name, size: rowSize, risk: row.risk, isDir: row.isDir, note: row.note })
        }),
        h('span', { className: 'gm-rdot', style: { background: dotVar(row.risk) } }),
        h('span', { className: 'gm-rn' },
          h('span', { className: 'grow' },
            h('span', { className: 'nm' }, row.isDir ? `${row.name}/` : row.name),
            row.candidate ? h('span', { className: 'gm-t3' }, ` · ${t('candidateTag')}`) : null,
            explainPendingSet.has(row.path) ? h('span', { className: 'gm-spin gm-spin-sm', title: t('explaining') }) : null),
          (() => {
            const info = explanations[row.path];
            const text = info ? info.text : row.note;
            if (text) return h('span', { className: 'gm-rex', title: text }, text);
            if (explainPendingSet.has(row.path)) {
              return h('span', { className: 'gm-rex gm-rex-wait' }, `${t('explaining')}…`);
            }
            return null;
          })(),
          h('span', { className: 'gm-t3', style: { whiteSpace: 'nowrap' } }, rowSize == null ? t('sizeUnknown') : fmtBytes(rowSize)),
          share == null ? null : h('span', { className: 'gm-t3', style: { whiteSpace: 'nowrap', minWidth: 38, textAlign: 'right' } }, `${share.toFixed(1)}%`),
          h('div', { className: 'gm-rbar' }, h('i', { style: { width: `${share == null ? 0 : share}%`, background: dotVar(row.risk) } }))
        ),
        picked ? h('select', {
          className: 'gm-select', value: picked.mode, title: t('operation'),
          onClick: (e) => e.stopPropagation(),
          onChange: (e) => { e.stopPropagation(); setCartMode(row.path, e.target.value); }
        }, h('option', { value: 'clean' }, t('modeClean')), h('option', { value: 'pack' }, t('modePack')), h('option', { value: 'tidy' }, t('modeTidy'))) : null,
        row.isDir && rowSize == null && !measuredHere
          ? h('button', { className: 'gm-mini', onClick: (e) => { e.stopPropagation(); doMeasure(row.path); } }, t('measure'))
          : null);
      };

      const tagRows = levelRows.filter((row) => {
        if (levelTag !== 'all' && row.risk !== levelTag) return false;
        const q = filter.trim().toLowerCase();
        return !q || row.path.toLowerCase().includes(q) || String(row.name || '').toLowerCase().includes(q);
      });
      const rightCard = h('div', { className: 'gm-card', style: { flex: '1 1 auto', minHeight: 200 } },
        h('div', { className: 'gm-cardhead' },
          h('b', null, t('level')),
          h('span', { className: 'gm-t3' }, `${tagRows.length}/${levelRows.length}`),
          scopedCandidates.length > 0
            ? h('span', { className: 'gm-t3' }, `· ${t('ruleHints', { n: scopedCandidates.length })}`)
            : null,
          explainError
            ? h('span', {
              className: 'gm-t3', style: { color: 'var(--dsw-alias-state-warn-primary)' }, title: explainError
            }, /bad-token|令牌/.test(explainError)
              ? t('staleTokenHint')
              : /no-such-route|HTTP 404|not found/i.test(explainError)
                ? t('explainUnavailable')
                : `${t('explainFailedShort')}：${explainError}`)
            : null,

          h('div', { className: 'gm-spacer' }),
          h('input', {
            className: 'gm-input', style: { width: 150 }, placeholder: t('searchPlaceholder'), value: filter,
            onChange: (e) => setFilter(e.target.value)
          })
        ),
        h('div', { className: 'gm-cardhead', style: { paddingTop: 0, borderBottom: 'none' } },
          h('div', { className: 'gm-chips' },
            [['all', '全部'], ['safe', t('riskSafe')], ['caution', t('riskCaution')], ['keep', t('riskKeep')], ['blocked', t('riskBlocked')]]
              .map(([key, label]) => h('span', {
                key,
                className: `gm-chip${levelTag === key ? ' on' : ' off'}`,
                onClick: () => setLevelTag(key)
              }, key === 'all' ? null : h('i', { style: { background: dotVar(key) } }), label)))
        ),
        h('div', { className: 'gm-cardbody' },
          levelRows.length === 0
            ? h('div', { className: 'gm-sub' }, listingLoading ? `${t('scanning')}…` : t('emptyDir'))
            : (tagRows.length === 0
              ? h('div', { className: 'gm-sub' }, t('noCandidates'))
              : tagRows.map((row, index) => levelRow(row, index))),
          selfInfo.truncated ? h('div', { className: 'gm-sub', style: { marginTop: 8 } }, t('truncated', { n: childRows.length, total: selfInfo.total || childRows.length })) : null
        )
      );

      // 底部：默认收起；展开是完整选择清单 + 搜索 + 提交
      const footer = h('div', { className: 'gm-foot' },
        h('div', { className: 'gm-footbar' },
          h('button', { className: 'gm-btn', onClick: () => setFootOpen((v) => !v) }, `${footOpen ? '▾' : '▸'} ${t('cart')} · ${cartItems.length} ${t('selected')} · ${fmtBytes(cartBytes)}`),
          h('input', {
            className: 'gm-input', style: { width: 180 }, placeholder: t('cartSearch'),
            value: cartFilter, onChange: (e) => setCartFilter(e.target.value)
          }),
          cartItems.length === 0
            ? h('span', { className: 'gm-t3' }, t('cartHint'))
            : h('span', { className: 'gm-t2' }, `${t('selected')} ${cartItems.length} · ${fmtBytes(cartBytes)} · ${t('actors')} ${config.workers == null ? 3 : config.workers}`),
          h('div', { className: 'gm-spacer' }),
          running && running.status === 'running' ? h('button', { className: 'gm-btn', onClick: cancelRun }, t('cancelRun')) : null,
          h('button', {
            className: 'gm-btn gm-primary',
            disabled: cartItems.length === 0 || Boolean(running && running.status === 'running'),
            onClick: submitPlan
          }, t('submit'))
        ),
        footOpen ? h('div', { className: 'gm-footbody' },
          h('div', { className: 'gm-h1', style: { marginBottom: 8 } },
            h('span', { className: 'gm-spacer' }),
            h('button', { className: 'gm-mini always', onClick: () => setCart(new Map()) }, '清空'),
            h('span', { className: 'gm-t3' }, `${filteredCart.length} 项 · ${fmtBytes(cartBytes)} · ${t('special')}`)
          ),
          filteredCart.length === 0
            ? h('div', { className: 'gm-sub' }, t('cartEmpty'))
            : h('table', { className: 'gm-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('size')), h('th', null, t('risk')), h('th', null, t('modified')), h('th', null, t('path')),
                h('th', null, t('note')), h('th', null, t('operation')), h('th', null, t('special')), h('th', null, ''))),
              h('tbody', null, filteredCart.map((item) => {
                const node = nodesRef.current.get(item.path);
                return h('tr', { key: item.path },
                  h('td', { className: 'num' }, item.size == null ? t('sizeUnknown') : fmtBytes(item.size)),
                  h('td', null, h(Badge, { risk: item.risk })),
                  h('td', { className: 'gm-t3' }, fmtDate(node ? node.mtime : null)),
                  h('td', null, h('div', { className: 'gm-path' }, item.path)),
                  h('td', { className: 'gm-t2', style: { maxWidth: 260 } }, (item.note || '').slice(0, 160)),
                  h('td', null, h('select', {
                    className: 'gm-select', value: item.mode,
                    onChange: (e) => setCartMode(item.path, e.target.value)
                  }, h('option', { value: 'clean' }, t('modeClean')), h('option', { value: 'pack' }, t('modePack')), h('option', { value: 'tidy' }, t('modeTidy')))),
                  h('td', null, h('button', {
                    className: 'gm-mini always', style: { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' },
                    onClick: () => openSpecial(item.path)
                  }, item.special ? `${item.special.slice(0, 24)}${item.special.length > 24 ? '…' : ''}` : `✎ ${t('special')}`)),
                  h('td', null, h('button', { className: 'gm-mini always', onClick: () => toggleCart({ path: item.path }) }, t('removeFromCart'))));
              })))
        ) : null,
        running ? h('div', { className: 'gm-footbody' },
          h('div', { className: 'gm-meta' },
            h('span', { className: 'gm-t2' }, t('progress'), ' ', h('b', { className: 'gm-t1' }, running.status)),
            h('span', { className: 'gm-t2' }, '已释放 ', h('b', { className: 'gm-t1' }, fmtBytes(running.freedBytes || 0))),
            h('span', { className: 'gm-t2' }, t('expected'), ' ', h('b', { className: 'gm-t1' }, fmtBytes(running.totals ? running.totals.bytes : 0)))),
          h('div', { className: 'gm-h1', style: { marginTop: 6 } }, (running.shards || []).map((s) =>
            h('span', { key: s.shardId, className: 'gm-chip' },
              h('i', { style: { background: s.status === 'done' ? 'var(--gm-safe2)' : s.status === 'running' ? 'var(--gm-caution2)' : 'var(--gm-keep2)' } }),
              `${t('shard')} ${String(s.shardId).replace('shard-', '')} ${(t('shardStatus') && t('shardStatus')[s.status]) || s.status} · ${fmtBytes(s.freedBytes || 0)}`)))) : null,
        report || dispatch || log.length > 0
          ? h('div', { className: 'gm-footbody' },
            h('span', { className: 'gm-t3' }, t('auditMovedHint')),
            h('button', { className: 'gm-mini always', onClick: openAudit }, `🗂 ${t('auditOpen')}`))
          : null
      );

      const sessionConfirmModal = sessionConfirm && sessionPlanState ? h('div', { className: 'gm-overlay gm-overlay-top', onClick: (e) => { if (e.target === e.currentTarget) setSessionConfirm(false); } },
        h('div', { className: 'gm-modal', style: { width: 520 }, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('sessionExecuteConfirmTitle') },
          h('h2', null, t('sessionExecuteConfirmTitle')),
          h('div', { className: 'gm-note' }, t('sessionExecuteConfirmBody')),
          h('div', { className: 'gm-h1', style: { justifyContent: 'flex-end', marginTop: 14 } },
            h('button', { className: 'gm-btn', onClick: () => setSessionConfirm(false) }, t('cancelBtn')),
            h('button', { className: 'gm-btn gm-danger', onClick: sessionExecute }, t('sessionExecuteGo'))))) : null;

      const auditModal = auditOpen ? h('div', { className: 'gm-overlay gm-overlay-top', onClick: (e) => { if (e.target === e.currentTarget) setAuditOpen(false); } },
        h('div', { className: 'gm-modal gm-modal-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('auditTitle') },
          h('h2', null, t('auditTitle')),
          h('div', { className: 'gm-sub', style: { marginTop: 4 } }, t('auditIntro')),
          h('div', { className: 'gm-h1', style: { marginTop: 10 } },
            h('button', { className: 'gm-btn', onClick: openAudit }, t('auditRefresh')),
            report ? h('span', { className: 'gm-t2' }, `${t('report')} ${report.status} · ${t('actual')} ${fmtBytes(report.actualBytes)} · ${t('diskDelta')} ${report.diskFreeDelta == null ? t('unknown') : fmtBytes(report.diskFreeDelta)}`) : null),
          auditError ? h('div', { className: 'gm-warn', style: { marginTop: 8 } }, auditError) : null,
          auditBusy && !auditRuns ? h('div', { className: 'gm-t3', style: { marginTop: 8 } }, t('loading')) : null,
          h('div', { className: 'gm-audit' },
            (auditRuns || []).length === 0 && !auditBusy ? h('div', { className: 'gm-empty' }, t('auditEmpty')) : null,
            (auditRuns || []).map((run) => h('div', { key: run.planId, className: 'gm-auditrun' },
              h('div', {
                className: 'gm-auditrow',
                onClick: () => setAuditExpanded(auditExpanded === run.planId ? null : run.planId)
              },
              h('span', { className: `gm-chip${run.dryRun ? ' off' : ' on'}`, style: { height: 22 } }, run.dryRun ? t('dryRunTag') : t('realRunTag')),
              h('span', { className: 'gm-t2' }, fmtDate(run.at)),
              h('span', { className: 'gm-t2' }, t('auditItems', { n: run.deletedCount })),
              h('span', { className: 'gm-t1' }, fmtBytes(run.actualBytes == null ? (run.totals ? run.totals.bytes : 0) : run.actualBytes)),
              h('span', { className: 'gm-t3' }, run.status),
              run.failed ? h('span', { className: 'gm-warn' }, `${t('failedCount')} ${run.failed}`) : null,
              h('div', { className: 'gm-spacer' }),
              h('span', { className: 'gm-t3' }, run.planId)),
              auditExpanded === run.planId ? h('div', { className: 'gm-auditbody' },
                run.deleted.length === 0
                  ? h('div', { className: 'gm-t3' }, t('auditEmpty'))
                  : run.deleted.map((item) => h('div', { key: `${run.planId}:${item.path}`, className: 'gm-audititem' },
                    h('code', { className: 'gm-path' }, item.path),
                    h('span', { className: 'gm-t3' }, `${fmtBytes(item.bytes)} · ${item.actor || '—'} · rule ${item.ruleId == null ? '—' : item.ruleId}`))),
                run.packs.length > 0 ? h('div', { className: 'gm-t2', style: { marginTop: 6 } }, run.packs.map((p, i) => h('div', { key: i }, `${t('packResult')}: ${p.archive || '—'} · ${fmtBytes(p.bytes)}${p.ok ? '' : ' ✗'}`))) : null,
                run.tidies.length > 0 ? h('div', { className: 'gm-t2', style: { marginTop: 6 } }, run.tidies.map((td, i) => h('div', { key: i }, `${t('tidyResult')} ${td.path}: ${t('duplicates', { n: td.stats ? td.stats.groupCount : 0 })} · ${t('wasted', { size: fmtBytes(td.stats ? td.stats.wastedBytes : 0) })}`))) : null,
                h('div', { className: 'gm-sub', style: { marginTop: 6 } }, `${t('audit')}: ${run.planId}.jsonl`)
              ) : null)))
        )) : null;

      const specialModal = specialFor ? h('div', { className: 'gm-overlay', onClick: (e) => { if (e.target === e.currentTarget) setSpecialFor(null); } },
        h('div', { className: 'gm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('specialTitle') },
          h('h2', null, t('specialTitle')),
          h('div', { className: 'gm-path' }, specialFor),
          h('div', { className: 'gm-sub', style: { marginTop: 6 } }, t('specialIntro')),
          h('textarea', {
            className: 'gm-textarea', style: { marginTop: 8 }, value: specialDraft,
            placeholder: t('specialHint'), onChange: (e) => setSpecialDraft(e.target.value)
          }),
          h('div', { className: 'gm-sub', style: { marginTop: 8 } }, t('preview')),
          h('div', { className: 'gm-preview', style: { marginTop: 4 } }, renderAtTokens(specialDraft) ),
          h('details', { style: { marginTop: 10 } },
            h('summary', { className: 'gm-sub' }, `${t('insertAt')}（${(specialListing && specialListing.children ? specialListing.children.length : 0)}）`),
            h('div', { className: 'gm-h1', style: { marginTop: 6, maxHeight: 160, overflow: 'auto' } },
              ((specialListing && specialListing.children) || []).slice(0, 120).map((child) =>
                h('button', { key: child.path, className: 'gm-mini always', onClick: () => insertAt(child.path) },
                  `${child.name}${child.isDir ? '/' : ''}`)))),
          h('div', { className: 'gm-h1', style: { justifyContent: 'flex-end', marginTop: 12 } },
            h('button', { className: 'gm-btn', onClick: () => setSpecialFor(null) }, t('cancelBtn')),
            h('button', { className: 'gm-btn gm-primary', onClick: saveSpecial }, t('save')))
        )) : null;

      const settingsModal = settingsOpen && settingsDraft ? h('div', { className: 'gm-overlay', onClick: (e) => { if (e.target === e.currentTarget) setSettingsOpen(false); } },
        h('div', { className: 'gm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settingsTitle') },
          h('h2', null, t('settingsTitle')),
          h('div', { className: 'gm-sub' }, t('settingsHint')),
          h('div', { className: 'gm-form' },
            h('label', null, t('setBigFile')),
            h('input', { type: 'number', min: 1, value: settingsDraft.bigFileBytes, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { bigFileBytes: e.target.value })) }),
            h('label', null, t('setMinExpand')),
            h('input', { type: 'number', min: 1, value: settingsDraft.minExpandBytes, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { minExpandBytes: e.target.value })) }),
            h('label', null, t('setMinCandidate')),
            h('input', { type: 'number', min: 1, value: settingsDraft.minCandidateBytes, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { minCandidateBytes: e.target.value })) }),
            h('label', null, t('setMaxDepth')),
            h('input', { type: 'number', min: 3, max: 20, value: settingsDraft.maxDepth, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { maxDepth: e.target.value })) }),
            h('label', null, t('setKeepTop')),
            h('input', { type: 'number', min: 5, max: 60, value: settingsDraft.keepTop, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { keepTop: e.target.value })) }),
            h('label', null, t('setFilesPerDir')),
            h('input', { type: 'number', min: 5, max: 50, value: settingsDraft.filesPerDir, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { filesPerDir: e.target.value })) }),
            h('label', null, t('setWorkers')),
            h('input', { type: 'number', min: 1, max: 6, value: settingsDraft.workers, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { workers: e.target.value })) }),
            h('label', null, t('setWorkspace')),
            h('select', {
              className: 'gm-select', value: settingsDraft.workspaceId || '',
              onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { workspaceId: e.target.value }))
            },
            h('option', { value: '' }, t('workspaceAuto')),
            ...((sessionInfoState && sessionInfoState.workspaces) || []).map((w) => h('option', { key: w.id, value: w.id }, `${w.title || w.path}（${w.path}）`))),
            h('label', null, t('setPlanSession')),
            h('input', { type: 'checkbox', checked: settingsDraft.planSession !== false, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { planSession: e.target.checked })) }),
            h('label', null, t('setExplainModel')),
            h('select', {
              className: 'gm-select', value: settingsDraft.explainModel || '',
              onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { explainModel: e.target.value }))
            },
            h('option', { value: '' }, t('modelFollowSession')),
            ...(((sessionInfoState && sessionInfoState.models) || []).flatMap((prov) =>
              (prov.models || []).map((m) => h('option', { key: `${prov.id}/${m.id}`, value: `${prov.id}/${m.id}` }, `${prov.name} / ${m.name}`))))),
            h('label', null, t('setExplainDepth')),
            h('input', { type: 'number', min: 0, max: 6, value: settingsDraft.explainDepth == null ? 2 : settingsDraft.explainDepth, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { explainDepth: e.target.value })) }),
            h('label', null, t('setExplainItems')),
            h('input', { type: 'number', min: 1, max: 200, value: settingsDraft.explainMaxItems == null ? 40 : settingsDraft.explainMaxItems, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { explainMaxItems: e.target.value })) }),
            h('label', null, t('setExplainConcurrency')),
            h('input', { type: 'number', min: 1, max: 6, value: settingsDraft.explainConcurrency == null ? 3 : settingsDraft.explainConcurrency, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { explainConcurrency: e.target.value })) }),
            h('label', null, t('setExplainEffort')),
            h('select', {
              className: 'gm-select', value: settingsDraft.explainReasoningEffort || '',
              onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { explainReasoningEffort: e.target.value }))
            },
            h('option', { value: '' }, t('effortInherit')),
            ...((modelInfo && modelInfo.efforts) || []).map((eff) => h('option', { key: eff.id, value: eff.id },
              `${eff.name}${modelInfo && modelInfo.defaultEffort === eff.id ? ` ${t('effortDefaultTag')}` : ''}`))),
            h('span', { className: 'gm-sub' },
              modelInfo
                ? (modelInfo.efforts && modelInfo.efforts.length > 0
                  ? `${modelInfo.selection.provider} / ${modelInfo.selection.model}`
                  : t('effortNotDeclared'))
                : t('effortLoading')),
            h('label', null, t('setExplainSearches')),
            h('input', { type: 'number', min: 0, max: 20, value: settingsDraft.explainMaxSearches == null ? 2 : settingsDraft.explainMaxSearches, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { explainMaxSearches: e.target.value })) }),
            h('label', null, t('setExplainWeb')),
            h('input', { type: 'checkbox', checked: settingsDraft.explainUseWeb !== false, onChange: (e) => setSettingsDraft(Object.assign({}, settingsDraft, { explainUseWeb: e.target.checked })) })
          ),
          h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
            h('div', { className: 'gm-sub', style: { marginBottom: 8 } }, t('explainCacheHint')),
            h('div', { className: 'gm-h1' },
              h('button', { className: 'gm-btn', onClick: () => { if (!currentPath) return; const paths = [currentPath, ...((listing && listing.children) || []).map((c) => c.path)]; setExplainError(null); setExplainForce(true); setExplainNonce((n) => n + 1); setSettingsOpen(false); for (const p of paths) explainedRef.current.delete(p); showToast(t('reexplainStarted')); } }, t('reexplain'))),
          ),
          h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
            h('label', null, t('setAuditKeep')),
            h('input', { type: 'number', min: 1, max: 10000, value: auditKeep, onChange: (e) => setAuditKeep(e.target.value) }),
            h('div', { className: 'gm-sub', style: { marginTop: 6 } }, t('auditPurgeHint')),
            h('label', { style: { marginTop: 8 } }, t('auditClearExplain')),
            h('input', { type: 'checkbox', checked: auditClearExplain, onChange: (e) => setAuditClearExplain(e.target.checked) }),
            h('div', { className: 'gm-h1', style: { marginTop: 8 } },
              h('button', { className: 'gm-btn', onClick: pruneAuditLogs }, `🧹 ${t('auditPurge')}`),
              h('button', { className: 'gm-btn', onClick: openAudit }, `🗂 ${t('auditTitle')}`)),
          ),
          h('div', { className: 'gm-h1', style: { justifyContent: 'flex-end', marginTop: 14 } },
            h('button', { className: 'gm-btn', onClick: () => setSettingsOpen(false) }, t('cancelBtn')),
            h('button', { className: 'gm-btn gm-primary', onClick: saveSettings }, t('save')))
        )) : null;

      // 计划弹窗：分组展示 + 重启类置尾说明
      const planModal = plan ? h('div', { className: 'gm-overlay', onClick: (e) => { if (e.target === e.currentTarget) setPlan(null); } },
        h('div', { className: 'gm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('planTitle') },
          h('h2', null, t('planTitle')),
          h('div', { className: 'gm-t2' }, t('planIntro')),
          plan.ai && plan.ai.used
            ? h('div', { className: 'gm-note' },
              h('b', null, `${t('aiUsed')}: `), plan.ai.summary || '',
              (plan.ai.warnings || []).length > 0
                ? h('div', { className: 'gm-warn' }, (plan.ai.warnings || []).join('；'))
                : null,
              (plan.ai.dropped || []).length > 0
                ? h('div', { className: 'gm-sub' }, t('aiDropped', { n: plan.ai.dropped.length }))
                : null)
            : h('div', { className: 'gm-sub' }, plan.ai ? t('aiUnavailable', { reason: plan.ai.reason || 'unknown' }) : ''),
          (plan.groups || []).map((group) =>
            h('div', { className: 'gm-group', key: group.mode },
              h('div', { className: 'gm-grouphead' },
                h('b', null, group.mode === 'restart' ? t('planGroupRestart') : (group.mode === 'clean' ? t('planGroupClean') : group.mode === 'pack' ? t('planGroupPack') : t('planGroupTidy'))),
                h('span', { className: 'gm-t3' }, `${group.itemCount} 项 · ${fmtBytes(group.bytes)} · ${group.mode === 'clean' ? t('planDeletes') : t('planNoDelete')}`),
                group.mode === 'restart' ? h('span', { className: 'gm-badge', style: { background: 'var(--gm-caution2)' } }, '⚠ 最后执行') : null),
              group.mode === 'restart' ? h('div', { className: 'gm-groupbody gm-warn' }, t('planRestartNote')) : null,
              h('div', { className: 'gm-groupbody' }, (group.items || []).map((item) =>
                h('div', { key: item.path, className: 'gm-path' }, `${fmtBytes(item.size)}  ${item.path}${item.special ? `  〔${item.special}〕` : ''}`))))),
          (plan.uninstall || []).length > 0 ? h('div', { className: 'gm-group' },
            h('div', { className: 'gm-grouphead' },
              h('b', null, t('uninstallTitle')),
              h('span', { className: 'gm-t3' }, `${plan.uninstall.length} 项 · ${t('uninstallHint')}`)),
            h('div', { className: 'gm-groupbody' }, plan.uninstall.map((hint, i) =>
              h('div', { key: i, style: { padding: '3px 0' } },
                h('div', { className: 'gm-path' }, `${fmtBytes(hint.size)}  ${hint.path}`),
                h('div', { className: 'gm-t2', style: { fontSize: 11.5 } }, hint.why),
                hint.command
                  ? h('div', { style: { marginTop: 2 } },
                    h('code', { className: 'gm-path' }, hint.command),
                    h('button', { className: 'gm-mini always', style: { marginLeft: 8 }, onClick: () => copyText(hint.command, t('copiedCmd')) }, t('copyCmd')))
                  : null)))) : null,
          (plan.pending || []).length > 0 ? h('div', { className: 'gm-note' },
            h('b', null, t('planPending')),
            h('div', { className: 'gm-sub' }, t('executorsPending'))) : null,
          (plan.skipped || []).length > 0 ? h('details', null,
            h('summary', null, `${t('skipped')} ${plan.skipped.length}`),
            h('div', { className: 'gm-list' }, plan.skipped.slice(0, 200).map((s, i) => h('div', { key: i, className: 'gm-path' }, `${s.reason}  ${s.path}`)))) : null,
          h('div', { className: 'gm-h1', style: { justifyContent: 'flex-end', marginTop: 12 } },
            h('button', { className: 'gm-btn', onClick: () => setPlan(null) }, t('planBack')),
            h('button', { className: 'gm-btn gm-primary', onClick: () => setFinalOpen(true) }, t('planConfirm')))
        )) : null;

      const dirCount = (plan && plan.items ? plan.items.filter((i) => i.recursive) : []).length;
      const finalModal = finalOpen && plan ? h('div', { className: 'gm-overlay' },
        h('div', { className: 'gm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('finalTitle') },
          h('h2', null, t('finalTitle')),
          h('div', null, t('finalLine', { groups: (plan.groups || []).map((g) => `${g.label || g.mode} ${g.itemCount}`).join(' · ') })),
          h('div', { className: 'gm-warn' }, '这些内容会被永久删除（不进回收站、无法撤销）'),
          h('label', { className: 'gm-check' },
            h('input', { type: 'checkbox', checked: ackDelete, onChange: (e) => setAckDelete(e.target.checked) }),
            h('span', null, t('finalCheck'))),
          dirCount > 0 ? h('label', { className: 'gm-check' },
            h('input', { type: 'checkbox', checked: ackDir, onChange: (e) => setAckDir(e.target.checked) }),
            h('span', null, t('finalCheckDir'))) : null,
          h('div', { className: 'gm-list' }, (plan.executableItems || plan.items || []).slice(0, 300).map((item) =>
            h('div', { key: item.path, className: 'gm-path' }, `${fmtBytes(item.size)}  ${item.path}`))),
          h('div', { className: 'gm-h1', style: { justifyContent: 'flex-end', marginTop: 12 } },
            h('button', { className: 'gm-btn', onClick: () => setFinalOpen(false) }, t('finalCancel')),
            h('button', {
              className: 'gm-btn gm-danger',
              disabled: !ackDelete || (dirCount > 0 && !ackDir),
              onClick: runPlan
            }, t('finalRun')))
        )) : null;

      // ── 右栏：会话生成的计划文档（可读渲染，不显示 Markdown 源码）──────────
      const planCard = sessionPlanState ? h('div', { className: 'gm-card gm-card--plan' },
        h('div', { className: 'gm-cardhead' },
          h('b', null, t('sessionPlanTitle')),
          sessionPlanning ? h('span', { className: 'gm-spin' }) : null,
          h('div', { className: 'gm-spacer' }),
          h('span', { className: 'gm-t3', title: sessionPlanState.sessionId }, sessionPlanState.planId),
          h('button', { className: 'gm-mini always', onClick: () => { setSessionPlanState(null); setSessionConfirm(false); } }, t('planBack'))
        ),
        h('div', { className: 'gm-cardbody gm-plan-body' },
          h('div', { className: 'gm-meta', style: { marginBottom: 8 } },
            h('span', { className: 'gm-t3' }, `${t('size')} ${fmtBytes(sessionPlanState.totals ? sessionPlanState.totals.bytes : 0)}`),
            sessionPlanState.workspace ? h('span', { className: 'gm-t3' }, sessionPlanState.workspace.title || sessionPlanState.workspace.path) : null,
            h('span', { className: 'gm-t3' }, sessionPlanState.planSource === 'file' ? t('sessionPlanFromFile') : t('sessionPlanFromSession')),
            sessionPlanState.planMode && sessionPlanState.planMode.degraded
              ? h('span', { className: 'gm-t3', title: sessionPlanState.planMode.reason }, t('planModeDegraded'))
              : null),
          sessionNotice ? h('div', { className: 'gm-warn' }, sessionNotice) : null,
          sessionPlanState.executed
            ? h('div', { className: 'gm-ok' }, `${t('sessionExecuted')}${sessionPlanState.preset ? `（${t('sessionPlanPreset')} ${sessionPlanState.preset}）` : ''}`)
            : null,
          h('div', { className: 'gm-md' },
            sessionPlanState.markdown
              ? renderMarkdown(sessionPlanState.markdown)
              : h('div', { className: 'gm-empty' }, t('sessionPlanEmpty')))
        ),
        sessionPlanState.executed ? null : h('div', { className: 'gm-cardfoot' },
          h('button', { className: 'gm-btn gm-danger', onClick: () => setSessionConfirm(true) }, t('sessionPlanConfirm')))
      ) : null;

      return h('div', { className: 'gm-root' },
        h('style', null, STYLE),
        staleBanner,
        header,
        h('div', { className: 'gm-main' }, mapCard,
          h('div', { className: 'gm-col' }, planCard || h('div', { className: 'gm-col-inner' }, currentCard, rightCard))),
        footer,
        specialModal,
        settingsModal,
        planModal,
        finalModal,
        auditModal,
        sessionConfirmModal,
        toast ? h('div', { className: 'gm-toast' }, toast) : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'garbage-master' }, GarbageMasterPage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'garbage-master', order: 20, label: () => 'GarbageMaster'
        }, SidebarIcon));
      }
    };
  }
});
