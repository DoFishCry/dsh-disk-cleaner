/**
 * GarbageMaster — Host 侧状态存储（唯一真源）与进度事件广播。
 *
 * 页面只是投影：扫描结果、候选集、运行状态都以这里为准。
 * 事件带单调 seq，页面刷新后用 seq 去重、并能补齐断线期间的事件。
 */

/** 保留的最近事件条数（供页面重连补齐）。 */
const EVENT_LOG_LIMIT = 400;

export function createStore({ config, home, stateDir, targets, quickPaths = [] }) {
  const listeners = new Set();
  /** targetId → 扫描结果 */
  const scans = new Map();
  /** planId → plan */
  const plans = new Map();
  const eventLog = [];
  let run = null;
  let seq = 0;

  const store = {
    config,
    home,
    stateDir,
    targets,
    quickPaths,
    scans,
    plans,

    get run() { return run; },
    set run(value) { run = value; },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    emit(type, payload = {}) {
      seq += 1;
      const event = { seq, type, at: Date.now(), ...payload };
      eventLog.push(event);
      if (eventLog.length > EVENT_LOG_LIMIT) eventLog.splice(0, eventLog.length - EVENT_LOG_LIMIT);
      for (const listener of listeners) {
        try { listener(event); } catch { /* 单个订阅者出错不影响其它订阅者 */ }
      }
      return event;
    },

    /** 断线重连补齐：返回 seq 之后的事件。 */
    recent(afterSeq = 0) {
      return eventLog.filter((e) => e.seq > afterSeq);
    },

    /** 扫描状态摘要（不含巨树与候选集，避免首屏载荷过大）。 */
    scanSummaries() {
      const out = {};
      for (const [id, scan] of scans) {
        out[id] = {
          status: scan.status,
          error: scan.error || null,
          progress: scan.progress || null,
          generated: scan.generated || null,
          stats: scan.stats || null,
          usage: scan.usage || null,
          candidateCount: scan.candidates ? scan.candidates.length : 0,
          candidateBytes: scan.totals ? scan.totals.executableBytes : 0,
          treeVersion: scan.treeVersion || 0
        };
      }
      return out;
    },

    /** 页面首屏快照。 */
    snapshot() {
      return {
        config: {
          workers: config.workers,
          minCandidateBytes: config.minCandidateBytes,
          bigFileBytes: config.scan.bigFileBytes,
          explainDepth: config.explainDepth,
          explainMaxItems: config.explainMaxItems,
          explainMaxSearches: config.explainMaxSearches,
          explainUseWeb: config.explainUseWeb,
          explainConcurrency: config.explainConcurrency,
          explainReasoningEffort: config.explainReasoningEffort,
          scanLimits: {
            maxDepth: config.scan.maxDepth,
            keepTop: config.scan.keepTop,
            minExpandBytes: config.scan.minExpandBytes,
            maxNodes: config.scan.maxNodes
          }
        },
        // 目标带上实时容量：界面因此能在**扫描之前**就显示每个盘剩余多少
        targets: targets.map((t) => ({
          id: t.id,
          label: t.label,
          path: t.path,
          usage: t.usage || null
        })),
        quickPaths: store.quickPaths,
        scans: store.scanSummaries(),
        run: run
          ? {
              planId: run.planId,
              status: run.status,
              dryRun: run.dryRun,
              totals: run.totals,
              freedBytes: run.freedBytes,
              shards: run.shards.map((s) => ({ shardId: s.shardId, status: s.status, itemCount: s.items.length, freedBytes: s.freedBytes, lease: s.lease })),
              startedAt: run.startedAt,
              endedAt: run.endedAt || null,
              report: run.report || null
            }
          : null,
        seq,
        home
      };
    }
  };

  return store;
}
