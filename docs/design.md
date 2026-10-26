# GarbageMaster · DSH 插件设计方案

> 状态：**设想阶段（M0）设计基线**。本文只描述"如何设计"，不包含实现路线、不包含代码。
> 修订：r2（新增 §10「删除后的界面更新 · 零 LLM 调用」）
> 范围声明见 §0；里程碑见 §18。

---

## 0. 本次交付物与范围

**交付物**：本设计文档。它固定了契约（数据形状、事件、接口、不变式）、决策与验收标准，后续任何实现都必须服从本文。

**不在本次范围**：
- 任何插件代码、扫描 / 删除 / LLM 的实现；
- 规则包的实际数据填充（只定义 schema 与迁移映射）；
- `plugin_manager` 安装与 profile 变更；
- 界面视觉稿（若需要，属于独立的一次设计步骤）。

**实现阶段的硬边界（写给未来的实现者）**：
1. `core/` 内**不许出现任何 `@deepseek-ai/*` import**，也不许出现 `node:fs` / `process` / 任何 IO。核心域必须是纯逻辑。
2. 宿主相关代码只允许出现在 `host/` 与 `client/`。
3. §5 的不变式与 §15 的回归测试是**验收门槛**，不是建议。

---

## 1. 目标与成功标准

### 1.1 要解决的痛点
| 痛点 | 现状 | 设计回应 |
|---|---|---|
| 路径复杂、看不懂 | 需要自己在资源管理器里一层层翻 | 矩形树图 + 面包屑 + 按风险着色，面积即体积 |
| 不知道该清什么 | 靠经验猜，删错代价高 | 规则包给风险档与动作；不清楚的才付费用 LLM 解释；`blocked` 档永不可删 |
| 手动清理麻烦耗时 | 逐个目录右键、逐个确认 | 一次勾选 + 一次提交，分片并行执行，界面实时反馈 |

### 1.2 成功标准（可检验）
1. 用户在**一个界面**内完成 扫描 → 看解释 → 勾选 → 提交 → 看进度 → 看结果，全程不敲命令；**会话（对话）里不出现任何选择交互**。
2. 每个候选项显示：体积、路径、最后修改时间、风险档、动作、一句人话解释，并标明解释来源（规则 / LLM / 缓存）。
3. 提交后的执行是并行的，且**任意两个执行者不可能触碰同一路径**——由资源层强制，不依赖提示词或模型自觉。
4. 执行前有 append-only 审计（记录了依据哪条规则、删了什么、多大），执行后能核对「预期回收字节 vs 实测回收字节」。
5. **每删掉一项，界面立刻反映：树图变小、清单移除、报告新增一行；整个过程 LLM 调用数为 0，且不做全盘重扫。**（r2）
6. 平台与宿主可替换：核心域与适配器分离；扫描/执行可经可插拔传输（本机 / SSH / 外部扫描器进程）指向不同目标；换宿主只换适配器。
7. 成本受控：LLM 只解释**签名**而不是文件；缓存命中后重复扫描近乎零成本；单次运行有预算上限。

### 1.3 非目标（现在明确不做）
- 独立软件形态（远期愿景，见 §18 M6，不在本插件内）；
- 跨机集群调度、多目标同时清理；
- 不经用户勾选、由模型自动决定"什么该删"；
- 自动执行系统级修复命令（`powercfg` / `diskpart` / `docker prune` 等只呈现，不代执行）。

---

## 2. 已确认的决定

| # | 决定 | 取值 | 设计含义 |
|---|---|---|---|
| D1 | 平台 | 平台中立，传输端口可拔插 | 核心域无 OS / 宿主逻辑；`ScanPort` / `ActionPort` 由 `Target.transport` 解析 |
| D2 | 动作语义 | 直接永久删除 | 护栏从"可恢复"转移到"事前可知 + 事后可查"（§11）；`unlink` 是默认动作 |
| D3 | 解释来源 | 调用宿主已有的模型配置，不是每文件一次调用 | `ExplainPort`；DSH 下 = `ctx.llm` + `ctx.agentDefaultModel`；换宿主只换适配器 |
| D4 | 界面 | 新界面；侧栏打开整页；提交也在页内 | Client 插件注册 `main`（keyed）+ `sidebar.panellist`；后续可选 `sidebar.right.pane.tab` |
| D5 | 删除后 | 界面实时更新，不再调用 LLM | 事件驱动的本地增量更新 + 轻量容量查询；刷新路径与解释流水线物理隔离（§10） |

---

## 3. 关键设计判断

### J1 团队不提供互斥，插件才提供（必须纠正的认知）
已核实：Agent Teams 的 `write_scopes`（任务板的文件触及提示）是 **advisory——只产生重叠告警，绝不阻止任何操作**；并且所有 teammate **共享同一工作目录与文件系统**，没有任何机制阻止某个 teammate 自己跑 `bash rm -rf`。

**结论**：把"防止相互干扰"寄托在团队机制上是不可靠的。互斥必须由**插件的路径租约表**强制：执行者唯一的删除入口是 `garbage_execute_shard(shardId, leaseToken)`，执行器对每一条目标路径校验「∈ 本 shard 租约」且「未被其他 shard 租用」。

团队的真正价值是：**可视化**（谁在做什么、卡在哪）、**可中断**、**任务板可审计**，以及把并行执行者纳入用户已开启的团队名额内。它是"协作外壳"，不是"安全边界"。

### J2 删除集合永远不由模型决定
删除集合 = 用户在面板的勾选 ∩ 规则/计划器的机器判定。模型只承担 **解释** 与 **执行**，不承担 **"选什么该删"**。这条是安全底线：一旦模型能扩大删除集合，任何提示注入或幻觉都会变成数据损失。

### J3 执行者是被裁剪过的受限 agent
利用 `ctx.tools.restrict()` 在 teammate 的 `agent.ctx` 上裁掉 `bash` / `pwsh` / `write` / `edit` 等通用破坏性工具，只保留只读查询 + `garbage_execute_shard`。

三层防御：**工具裁剪 → 租约校验 → 审计**。任一层单独都不够；三层同时存在才把"执行者越权"的概率压到可接受。

### J4 宿主能力可选加载
`agentTeams` / `llm` / `jobs` 放进可选 `inject`；缺失时 `CoordinatorPort` 降级为进程内 worker 池、`ExplainPort` 降级为纯规则。插件在没有团队服务的宿主（未来 Codex / Claude Code / 独立程序）里仍可用，**删除协议不变**。

### J5 不绕过宿主围栏
DSH 的 `workspace-write` 沙箱不允许删除工作区外的路径；且 `ctx.fs` **根本没有删除原语**（只有 `writeText` / `editText`）。删除只能经 `ctx.shell` / `ctx.subprocess`（Linux 上是 Landlock 内核级围栏）或 ActionPort 自己的受控执行路径。

**设计**：把删除做成**一次性的、本次运行专用的提权**；权限不常驻，运行结束即失效。绝不偷偷绕过宿主围栏，也不在插件里私藏一个"万能删除"后门。

### J6 状态权威在 Host，不在页面
扫描模型、候选集、运行状态都是 Host 侧单一 store；页面只是投影。界面的乐观更新是**表现**，Host 的 reducer 是**事实**。页面刷新 / 关闭重开后必须能重建一致视图。

---

## 4. 架构与模块边界

依赖严格单向：`hosts → adapters → ports ← core`。`core` 与 `ports` 不知道任何宿主的存在。

```
GarbageMaster/
  core/          纯逻辑，零 IO、零宿主 import
                   domain/     领域模型与类型契约（§5）
                   rules/      规则匹配引擎（读 RulePack）
                   signature/  签名归一化（§8.2）
                   shards/     分片装箱 + 不变式断言（§9.3）
                   budget/     预算闸门与缓存键（§8.4）
                   update/     applyDeletion 增量更新（§10.2）
                   audit/      审计记录构造
  ports/         仅 interface：ScanPort / ActionPort / ExplainPort /
                 CoordinatorPort / StorePort / ClockPort / ProgressSink
  adapters/
    scan-local/      Node fs + worker_threads
    scan-ssh/        SSH 远程扫描
    scan-sidecar/    复用现有 Python 扫描器（NDJSON 协议）
    action-local/    unlink / rmdir / archive
    action-ssh/      远程执行
    explain-host/    DSH：ctx.llm + ctx.agentDefaultModel
    coordinator-team/ DSH：ctx.agentTeams
    coordinator-pool/ 进程内 worker 池降级
  host/           DSH 装配：@Remote 控制器、进度流、模型工具、
                 插槽注册、locale、生命周期、一次性提权
  client/         新界面：整页控制台 + 侧栏图标（明文 React）
  rules/          win32.yml | linux.yml（声明式规则包，带 version）
  docs/design.md  本文
```

### 4.1 打包决定
- `core/` 是**同一个 bundle 包内的子目录**（`@local/dsh-garbage-master` 的 `./core` 子路径导出），避免本地 workspace 依赖解析问题。
- 因为 `core/` 保持 import 纯净，日后把它拆成独立 npm 包（供独立软件复用）只是移动文件，不需要改代码。
- 面板 id = `garbage-master`，同时是 `main` 插槽的 key 与 `sidebar.panellist` 的 id。

### 4.2 命名
| 对象 | 名称 |
|---|---|
| 工程 / 工作区 | GarbageMaster |
| bundle 包名 | `@local/dsh-garbage-master` |
| 面板 id / 插槽 key | `garbage-master` |
| Remote 命名空间 | `ctx.remote.garbageMaster` |
| 工具前缀 | `garbage_*` |
| 团队执行者名 | `gc-shard-<n>`（唯一、小写、永不复用） |

---

## 5. 领域模型（数据结构即契约）

### 5.1 Target
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定标识，用于面板选中态持久化 |
| `transport` | `'local'\|'ssh'\|'sidecar'` | **"传输端口可拔插"的落点** |
| `root` | string | 卷/挂载点根，如 `C:\`、`D:\`、`/`、`/media/user/Data Disk` |
| `os` | `'win32'\|'linux'\|'darwin'` | 决定规则包与路径分隔符语义 |
| `label` | string | 界面显示名 |

### 5.2 ScanNode
**沿用现有 `disk_data.json` 的形状**，这样才能继续复用 `build_map.py` 里已经写好并验证过的 squarify 树图渲染与 safe/caution/keep 配色语义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` / `path` | string | 节点名与完整路径 |
| `size` | number | 字节 |
| `mtime` | number | 秒级时间戳 |
| `kind` | `'dir'` | 目前只有目录节点 |
| `children` | ScanNode[] | 剪枝后的子目录 |
| `files` | BigFile[] | 直属大文件（阈值见 Config） |
| `others` | `{count, size, items[]} \| null` | 被折叠的小目录集合 |
| `smallRest` | number | 直属小文件合计（用于补齐树图面积） |

### 5.3 Candidate（候选清理项）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | **内容签名**，稳定；同一候选跨扫描保持一致 |
| `path` / `pattern` | string | 具体路径或签名模式 |
| `kind` | `'dir'\|'file'\|'group'` | `group` = 同签名聚合体 |
| `bytes` / `count` | number | 体积与条目数 |
| `mtimeRange` | `[number, number]` | 最早/最晚修改时间 |
| `signature` | string | 归一化"类路径"（§8.2），聚合与缓存键的基础 |
| `risk` | `'safe'\|'caution'\|'keep'\|'blocked'` | 新增 **`blocked`**：绝不允许插件删，只能给官方命令 |
| `action` | `'unlink'\|'archive'\|'command'\|'manual'` | **从现有 RULES 文案抽出的关键一列**（§7.2） |
| `remedy` | `{command, why}?` | 官方手段，如 `powercfg -h off`、`conda clean -p -y`、`docker system prune -a --volumes`、`wsl --shutdown` + diskpart、Steam 取消订阅 |
| `explain` | `{source, text, model?, at}` | `source: 'rule'\|'llm'\|'cache'`；必须可追溯 |
| `ruleId` | string? | 命中的规则 id，可追溯到具体规则与规则包版本 |
| `status` | `'pending'\|'deleted'\|'partial'\|'failed'\|'skipped'` | 执行结果回写到候选本身（r2） |
| `recursive` | boolean | 目录候选是否包含子项（决定是否允许递归删） |

### 5.4 RulePack（声明式）
| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | **进缓存键**；变更即自动失效旧解释 |
| `platform` | `'win32'\|'linux'\|'darwin'\|'*'` | 平台标签 |
| `rules[]` | Rule[] | 见 §7.1 |
| `default` | Rule | 兜底规则（现为 `caution` + 提示用户点开看看） |

### 5.5 Plan（勾选结果）
`{ id, target, items[{candidateId, action, bytes, recursive}], totals, createdAt, confirmToken }`

**totals 一律由 Host 重算，不信客户端。** `confirmToken` 是"用户已在面板内确认永久删除"的服务端凭据，一次性、有时效。

### 5.6 Shard（执行分片）
`{ shardId, lease: string[], items: PlanItem[], estBytes }`

### 5.7 AuditRecord（append-only）
`{ seq, planId, shardId, actor, action, path, bytes, ruleId, at, outcome }`

**写时机**：删除**之前**写入并 fsync（意图），删除**之后**追加结果。永久删除不可恢复，所以"删了什么"必须比"删除动作"更早落盘。

### 5.8 RunReport
`{ planId, expectedBytes, actualBytes, deleted[], failed[{path, reason}], skipped[{path, reason}], partial[], leases, startedAt, endedAt }`

### 5.9 ProgressEvent（r2，推给页面）
| 事件 | 载荷 | 用途 |
|---|---|---|
| `scan-progress` | `{scanned, nodes, bytes, phase}` | 扫描进度 |
| `shard-started` | `{shardId, actor, itemCount, estBytes}` | 谁开始干活 |
| `item-deleted` | `{path, bytes, candidateId, freedTotal, seq}` | **界面增量更新的核心事件** |
| `item-failed` | `{path, reason}` | 失败可见 |
| `item-skipped` | `{path, reason: 'changed'\|'denied'}` | 跳过可见 |
| `shard-done` | `{shardId, verifiedBytes, diskFree}` | 校正点 + 容量条刷新 |
| `run-done` | `{report}` | 收尾 |

每条带单调 `seq`；页面据此排序与去重。

---

## 6. 不变式

### I1 租约前缀互斥（分片层）
对任意两个 shard `s ≠ t`：`lease(s)` 与 `lease(t)` 中**不存在**互为前缀（含相等）的两个元素。

即：不存在 `a ∈ lease(s)`、`b ∈ lease(t)` 使得 `a` 是 `b` 的前缀或 `b` 是 `a` 的前缀。这保证了"任一路径最多归属一个 shard"，从而任一路径最多被一个执行者触碰。

**断言时机**：分片装箱后、派发前。断言失败即**拒绝执行**并报内部错误——这是编程错误，不是用户错误，绝不能降级为告警。

### I2 树图面积守恒（模型层）
对任意节点 `n`：

```
sum(c.size for c in n.children)
+ (n.others?.size ?? 0)
+ sum(f.size for f in n.files)
+ n.smallRest
== n.size
```

现有 `build_map.py` 的 `recalc()` 正是在维护它。**删除后必须继续维护**（§10.2），否则树图会出现"面积对不上"的假象。

### I3 解释来源可追溯
每个候选的 `explain.source` 与 `ruleId`（命中规则时）必须非空；`source='llm'` 时必须带 `model`。禁止出现"解释来源不明"的候选。

### I4 预算不越界
单次运行内 `ExplainPort` 的实际调用次数与 token 消耗不得超过 Config 的预算上限；超限必须**优雅停止并标记**，而非抛异常中断扫描。

---

## 7. 规则包

### 7.1 Rule 字段
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✓ | 稳定 id，进入审计与候选 |
| `match` | `{platform, regex, pathType}` | ✓ | `pathType: 'dir'\|'file'\|'any'`；Windows 下 match 需大小写不敏感 |
| `risk` | 同候选 | ✓ | 四档 |
| `action` | 同候选 | ✓ | 四选一 |
| `remedy` | `{command, why}` | 条件 | `action ∈ {command, manual}` 时必填 |
| `note` | string | ✓ | 面向用户的人话解释（可含 Markdown 强调，与现有文案风格一致） |
| `priority` | number | | 命中顺序；缺省按声明顺序（**第一条命中即生效**，与现有 RULES 语义一致） |

### 7.2 为什么 `action` 是必需的（迁移映射）
现有 `build_map.py` 的 ~90 条 RULES 里，**大量条目根本无法用 unlink 达成目标**。这些必须显式标注，否则"永久删除"会变成"命令跑不通然后什么都没发生"或者更糟——"删掉了不该删的东西"。映射示例：

| 现有规则片段 | 不能 unlink 的原因 | 迁移后的 action / remedy |
|---|---|---|
| `hiberfil.sys` | 系统占用，只能关休眠 | `command` / `powercfg -h off` |
| `pagefile.sys` | 系统占用，需改虚拟内存设置 | `manual` |
| `$RECYCLE.BIN` | 应清空回收站，而非删目录 | `unlink`（可，但建议 `manual` 走资源管理器） |
| `WinSxS` | **绝不可手动删** | `blocked` + remedy：磁盘清理 → 清理系统文件 |
| `SoftwareDistribution\Download` | 可用系统工具清 | `unlink`（safe） |
| `Package Cache` | 删后修复/卸载需重新下载 | `caution` + `unlink` |
| `NVIDIA ... UpdateFramework` | 装完即无用 | `unlink`（safe） |
| `DXCache` / `PSOCache` | 可再生 | `unlink`（safe） |
| `Steam workshop` | 直接删会被重新下载，**正确做法是取消订阅** | `manual` + `command`（给出指引） |
| `WSL ext4.vhdx` | 只增不减，删文件会损坏 WSL | `command` / `wsl --shutdown` + diskpart |
| `Docker disk.vhdx` | 同上 | `command` / `docker system prune -a --volumes` |
| `pip` / `conda` 缓存 | 应用自家工具清更稳 | `command` / `pip cache purge`、`conda clean -p -y` |
| `用户项目目录`（各类代码仓库 / 数据集 / 训练产物等 …） | 用户数据 | `blocked` |
| `Program Files` / `AppData\Local\Programs` | 应走卸载程序 | `blocked` + `manual` |

**规则包版本进缓存键**：规则变更后旧解释自动失效，不会出现"规则改了但界面还显示旧结论"。

### 7.3 规则包分发
- `rules/win32.yml`（首版，来自现有已实机验证的 RULES）
- `rules/linux.yml`（首版基础包：`~/.cache`、apt/pip/npm 缓存、journal、缩略图、Trash、docker overlay2、snap）

---

## 8. 解释流水线（成本模型）

### 8.1 流水线
```
候选集
  → 1) 规则命中? ── 是 ──→ 立即解释（0 成本，source='rule'）
                  └ 否
  → 2) 签名归一化（N 个文件 → M 个签名）
  → 3) 缓存命中? ── 是 ──→ 直接取回（0 成本，source='cache'）
                  └ 否
  → 4) 批量 LLM（每批 ≤ K 个签名，严格 JSON，失败重试 1 次，source='llm'）
  → 5) 写缓存
  → 6) 预算闸门：超限即停，剩余标 "未解释（预算用尽）"
```

**目标**：规则 + 缓存消化掉绝大多数候选，LLM 只处理真正新增且规则不认识的那一小撮。

### 8.2 签名归一化
抹掉路径中的**个体差异**，保留**类别特征**：

| 抹掉 | 示例 |
|---|---|
| 用户名 | `C:\Users\user\…` → `%USERPROFILE%\…` |
| 版本号 | `26100.8457` → `*` |
| GUID | `{8f2a…}` → `*` |
| 日期 | `20260906` → `*` |
| 哈希/序号文件名 | `f_0000a1`、`data_0001.tmp` → `*` |
| 环境变量根 | `C:\Users\X\AppData\Local` → `%LOCALAPPDATA%` |

例：`C:\Users\user\AppData\Local\Google\Chrome\User Data\Default\Cache\Cache_Data\f_0000a1`
→ `%LOCALAPPDATA%/Google/Chrome/User Data/*/Cache/**`

### 8.3 批量与输出契约
- 每批 ≤ K 个签名（Config 默认 20）。
- 强制严格 JSON，字段固定：`{signature, risk, action, note, remedy?}`。
- JSON 解析失败重试 1 次；仍失败则该签名标"未解释"，不阻塞其余批次。
- **LLM 返回的文本永远只作展示**：不得进入执行者的系统提示或工具参数（防提示注入）。界面渲染一律转义（沿用现有 `esc()` 的做法）。

### 8.4 缓存键与预算
- 缓存键 = `hash(rulePackVersion, signature, modelId, promptVersion)`
- 缓存落在 `ctx.storageDomain`（宿主中立时落 StorePort 实现）
- 预算（Config）：`maxCalls` / `maxTokens` / `maxBytes` per run（默认 40 次调用）
- 面板显示：当前 provider / model、本次已用调用数、命中缓存数

### 8.5 模型来源（回应"接哪个宿主就用哪个宿主的模型配置"）
```
ctx.agentDefaultModel.currentSelection()   → 用户当前的模型选择（provider + model）
ctx.llm.stream({provider, model, messages, system, maxTokens, …})  → 直接一次性调用
```
- **不引入第二套 API key、不新建凭据存储、不重建模型层**。
- 换宿主（Codex / Claude Code / 独立程序）= 换 `ExplainPort` 的一个实现，`core/` 与 `host/` 语义不变。

### 8.6 唯一的 LLM 入口
**进入解释流水线的唯一触发是"扫描产生新签名"或"用户对单项点『为什么？』"。**
删除、进度、界面刷新、核对（verify）、容量条更新——§10 的全部路径——**都不经过 ExplainPort**。这条是 r2 的硬约束，由回归测试守住（§15）。

---

## 9. 执行：分片 + 租约 + Agent Teams

### 9.1 提交流程（Host 侧 `garbageMaster.submit(planId, confirmToken)`）
1. **校验计划**：重算 totals；`confirmToken` 校验（一次性 + 时效）；`blocked` 项移出可执行集合；`action ∈ {command, manual}` 的项**不进执行器**，改列"待你手动执行"清单（附可复制的命令）。
2. **写审计意图**（append-only + fsync），拿到本次运行租约。
3. **分片**：见 §9.2，随后断言 I1。
4. **取得 Lead 句柄**：见 §9.4。
5. **建团队**：`spawnTeammate(leadAgent, {name, description, prompt})` × S（S = shard 数）。
6. **建任务**：`createTask(leadAgent, {subject, description, blocked_by, writeScopes})`，`writeScopes` = 该 shard 的 lease 前缀（让任务板的重叠告警对人可见）。
7. **指派**：`sendMessage(leadAgent, {target, content})` 把 shard 交给对应执行者。
8. 执行者调 `garbage_execute_shard({shardId, leaseToken})`。
9. **收尾**：verify → 写审计结果 → `run-done` + RunReport → 回收执行者。

### 9.2 分片装箱
目标：均衡体积、减少同一物理设备的并发争抢、**保证 I1**。

策略（按顺序）：
1. 按**顶层 lease 前缀**把候选分组（同一顶层目录的项尽量归同一 shard，减少跨 shard 争抢与文件系统热点）。
2. 按**同盘/同设备**聚集（避免同一磁盘被 S 个执行者同时随机写）。
3. 用 **estBytes 做贪心装箱**分到 S 个 shard（S 默认 4，Config 可调）。
4. **断言 I1**；失败即拒绝执行。

### 9.3 租约的强制点（不靠提示词）
执行器每次删除前逐条校验：
```
assert leaseToken.shardId == shard.shardId
assert target ∈ 本 shard 的 lease 前缀集合
assert 该 target 未被其他 shard 租用          // 租约表 = 插件内存 + Store 的单一真源
```
越界、缺租约、已租用 → **拒绝**并记 `lease_violation`。这是必须被观测到的异常：出现即说明有 bug 或有人绕过工具。

### 9.4 Lead 句柄怎么拿（一个容易踩空的地方）
UI 触发的 Remote 调用**不属于任何 Agent 调用链**，因此 `ctx.agents.currentInitiator()` 在 UI 触发的调用路径上为空。正确做法：
1. 面板绑定一个**会话**（当前工作区会话）；
2. Host 用 `ctx.agents.get(sessionId)` 解析该会话的 agent；
3. 用 `ctx.agentTeams.tryMembership(agent)` 校验角色为 `lead`；
4. 未命中则**明确报错**——不猜、不换人、不自己造一个假 Lead。

Team 是 implicit-root：首次 `spawnTeammate` 即建立团队。因此在"用户会话还没开过团队"时，第一次提交会顺带创建团队，这是预期行为，但**必须在提交确认里如实告知**（会占用团队名额、`maxMembers` 默认 16、执行者默认 ≤4）。

### 9.5 Lead 的角色
- **授权句柄**：Agent Teams 里只有 Lead 能 spawn / 指派 / 中断。
- **结束摘要**：运行结束后通过 `agent.inject()` 给 Lead 一条运行摘要（删了多少、省了多少、失败什么）。
- **不参与决策**：模型不决定删什么、不决定怎么分片、不决定租约归属。

### 9.6 降级（无团队服务的宿主）
`coordinator-pool` 用 worker 池跑**同一份分片计划与同一套租约校验**，产出**结构等价的 RunReport**。契约测试要求：同一份计划在 team 与 pool 两种实现下产出等价报告。

### 9.7 中断与并发
- `cancel()` → 停止新派发；在跑的执行者**完成当前项**后停（避免半删目录）；审计记录中断点。
- 多 shard 的事件并发到达 → 全部经**单一 RunState reducer 串行应用**，`seq` 保证顺序与去重。

---

## 10. 删除后的界面更新（零 LLM 调用）

**原则**：删除是"视图的减法"，不是"重新理解"。所以更新走**事件驱动的本地增量更新**，与解释流水线物理隔离。

### 10.1 事件链
```
执行者删除一项
  → item-deleted{path, bytes, candidateId, freedTotal, seq}
  → Host 单一 RunState reducer 依序应用（§10.2）
  → @Remote({mode:'stream'}) 进度流推给页面
  → 页面增量重绘：树图变小 / 清单移除 / 累计已释放增长
每个 shard 结束
  → shard-done{shardId, verifiedBytes, diskFree}
  → 容量条刷新一次（§10.3）+ verify 校正（§10.4）
```

### 10.2 Host 侧增量更新：`applyDeletion(scanModel, path, bytes)`
纯函数，放 `core/update/`：

1. 定位命中节点（用路径索引，O(1)/O(log n)，**不重扫、不遍历兄弟**）；
2. 若是文件：从 `files[]` 移除；
3. 若是目录候选、且计划标记 `recursive`：整棵子树从模型脱落；
4. 沿**祖先链**逐级减去 `bytes`（O(深度)）；
5. **重新维护 I2**（复用 `recalc()` 的同一套算术），保证树图"子项面积之和 == 父节点"；
6. 候选集：`candidateId.status = 'deleted'`，从待执行集合移除，累加 `freedTotal`。

复杂度：**O(树的深度)**，与目标体积、文件数量无关。

### 10.3 容量条：不做全盘重扫，只做一次廉价查询
- 容量条在**每个 shard 结束**时刷新一次：只调 `statfs` / `GetDiskFreeSpaceEx`（一次系统调用，**不遍历目录、不 hash、不调 LLM**）。
- 刷新粒度 = 每 shard 一次（不是每删一项一次）：避免把系统调用打成风暴。
- 想要精确重扫是**用户显式点"重新扫描"**的行为；且重扫时解释全部命中缓存（§8.4），LLM 调用数仍为 0。

### 10.4 verify：范围是租约前缀，不是整盘
每个 shard 结束后，只对该 shard 的 `lease` 前缀做一次小范围 re-stat，用途：
- 核对「预期回收 vs 实测回收」；
- 发现"计划制定后目标又变了"（mtime/size 不符）的情况。

**verify 只读候选集与缓存，不进入签名聚合 → LLM 的路径。**

### 10.5 三种可见状态（避免界面"说谎"）
| 情况 | 界面处理 | 理由 |
|---|---|---|
| 已永久删除 | 从候选清单移除，**同时在运行报告里新增一行**（路径、字节、规则、时间） | 永久删除不可恢复，行消失了也必须留痕（报告 + 审计） |
| 部分删除 | 该行**保留**，标 `partial`，显示剩余字节与原因 | 让"还剩多少"可见 |
| 目标已变化 | 标 `skipped(changed)`，保留在清单 | 让"没删成"可见，而不是静默消失 |

### 10.6 页面刷新 / 关掉再打开
乐观更新不是唯一来源：
1. 页面重新 attach → 先向 Host 拉一次一致快照（`runStatus()`）；
2. 再用 `follow(planId)` 增量跟随；
3. 事件带单调 `seq` → 页面去重与排序，断线重连不会重复计数。

### 10.7 硬约束（写成回归测试）
- 删除 → 一次 `item-deleted` 的完整处理路径上，**ExplainPort 调用次数必须为 0**。
- 删除整个计划后：`sum(item-deleted.bytes) == freedTotal`，且与 `shard-done.verifiedBytes` 一致（在 tmpfs 上可精确相等）。
- `shard-done` 到容量条更新之间**不得发生目录遍历**（用 mock ScanPort 或 syscall 计数断言）。

---

## 11. 安全模型（默认"永久删除"下的护栏）

用户选择了直接永久删除，所以护栏不放在"可恢复"上，而放在四层：

| 层 | 措施 | 失败时的后果 |
|---|---|---|
| L1 规则层 | `blocked` 档（WinSxS、Program Files、用户项目目录、休眠/页面文件、WSL/Docker vhdx 等）**永不可删**，只能走 remedy 命令或手动 | 无法通过界面把 blocked 项放进执行集合 |
| L2 计划层 | 提交前在面板内展示"将永久删除 N 项 / 共 X GB"，清单可展开、可导出；**确认动作在面板内，不在对话里**；`confirmToken` 一次性 + 时效 | 误点也不能立刻执行 |
| L3 沙箱层 | 删除需要**一次性提权**；仅本次运行有效、结束即失效；绝不偷偷绕过宿主围栏 | 无提权则删除失败并可见，而非静默绕过 |
| L4 审计层 | 删除**前**写意图（含 `ruleId` 与当时解释快照）并 fsync；失败项单列 | 即使崩在中途，也能知道原计划删什么 |

**dry-run 默认开启**：面板明确显示当前处于 dry-run；关掉并二次确认后才真删。dry-run ≠ 隔离区——它只保证"没有意外提交"，不改变"永久删除"的动作语义。

---

## 12. 界面设计（新界面，不在对话里）

### 12.1 落点
- `ctx.slots.inject("main", () => ctx.slots.register({name:"main", key:"garbage-master"}, GarbageMasterPage))`
  → 整页控制台（"Central panel selected by sidebar entry id"）。
- `ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({name:"sidebar.panellist", id:"garbage-master", order:…}, GarbageMasterIcon))`
  → 侧栏图标，点开切到整页。
- 可选后续：`sidebar.right.pane.tab`（"在右边展示"的运行中面板）。
- 打开方式与宿主一致：`ctx.layout.selectPanel("garbage-master")`。

### 12.2 页面四区
| 区 | 内容 |
|---|---|
| 顶部 | 目标选择（transport + 卷）、容量条（沿用现有 disk_map 的容量条）、扫描/重扫、dry-run 开关、运行状态 |
| 左 | 矩形树图（可下钻、面包屑、按 risk 过滤着色）；复用现有 squarify 与 safe/caution/keep 配色语义，新增 blocked 的视觉区分（如斜纹） |
| 右 | 候选清单/详情：按签名聚合的勾选列表（可展开到具体文件）、风险标记、体积、动作下拉、解释文本（标注来源与 model）、remedy 命令一键复制、单项"为什么？"追问 |
| 底部 | 待执行摘要（N 项 / X GB / 分片数 / 执行者数）+ **提交** + 每个 shard 的实时进度 + 结果报告 + 审计导出 |

**运行中就在底部这一区生长**（§10）：进度条、已释放字节、每 shard 状态；树图与容量条同步变化。

### 12.3 组件规则（实现约束）
- 只用主题 token（`--dsw-alias-*`），不写死颜色；明暗两套都要读得对。
- 文案走 Client locale（`locale/zh.json` + `locale/en.json`），面板标题/图标按 bundle 展示清单准备（`meta.title` / `meta.description` / 图标资源）。
- 管理列表样式参考 Plugin Manager 页面（宿主同类页面的参考实现）。
- 树图用 DOM 绝对定位渲染（沿用现有实现），不引图形库。
- **不 import 任何 `@deepseek-ai/dsh-client-ui-*` 包**；控件自写并与宿主对齐（复制宿主控件的标记/行为，类名加插件前缀，只保留 `--dsw-alias-*` token 引用）。
- 不 append 到 `document.body`，不改 app root。
- 资源（样式、定时器、监听器）在 `apply` 里用 `ctx.effect` / `ctx.on` 注册并返回清理函数。

### 12.4 视觉稿
若需要界面视觉稿，属于**独立的一次设计步骤**，不在本设计的里程碑内。

---

## 13. Agent 工具面（执行面，不是选择面）

| 工具 | 权限 | 说明 |
|---|---|---|
| `garbage_targets` | 只读 | 列出可用目标 |
| `garbage_scan_start` | 启动扫描 | 不阻塞 |
| `garbage_candidates` | 只读 | 分页查询候选 |
| `garbage_explain` | 计预算 | 对单个候选生成/取回解释（走 ExplainPort） |
| `garbage_execute_shard` | **仅执行者** | 需 `leaseToken`；越界即拒 |
| `garbage_run_status` | 只读 | 运行状态快照 |
| `garbage_report` | 只读 | 运行报告 |

**明确不提供**：
- `garbage_delete(path)` 或任何"任意路径删除"工具——否则等于把永久删除权限开放给任意模型调用；
- 任何"确认/授权"类工具——勾选与提交确认是 user-only，模型不能替用户授权。

**收敛手段**：`garbage_execute_shard` 通过工具裁剪只出现在被指派执行者的上下文里；工具内部再自校验 lease 归属（双保险）。

---

## 14. 页面 ↔ Host 接口（`@Remote` 控制器）

单个 Host 控制器服务（`@Remote` 装饰，暴露为 `ctx.remote.garbageMaster.*`）。**界面与工具调用同一批方法**——"一个操作，两个调用者"，避免两套逻辑分叉。

| 方法 | 调用者 | 说明 |
|---|---|---|
| `targets()` | UI + 工具 | 列出目标 |
| `scan(targetId)` | UI + 工具 | 启动扫描 |
| `scanStatus()` | UI + 工具 | 扫描进度快照 |
| `candidates(filter, page)` | UI + 工具 | 分页查询候选 |
| `explainOne(candidateId)` | UI + 工具 | 单项解释（计预算） |
| `plan(selection)` | UI | 生成计划并返回服务端 totals |
| `submit(planId, confirmToken)` | **UI only** | 提交执行（用户授权动作） |
| `runStatus()` | UI + 工具 | 一致快照（页面刷新后重建视图） |
| `report(planId)` | UI + 工具 | 运行报告 |
| `audit(planId)` | UI + 工具 | 审计记录 |
| `cancel()` | UI + 工具 | 中断 |
| `follow(planId)` | UI | `@Remote({mode:'stream'})` 进度流（r2） |

**user-only 的两个动作**：勾选与提交确认（`submit` 的 `confirmToken` 只能由面板内确认产生）。

---

## 15. 测试与验收

### 15.1 单元
| 对象 | 用例 |
|---|---|
| 规则引擎 | 用现有 RULES 的样例路径做**回归表**（迁移前后结论一致） |
| 签名归一化 | 抹除表逐项；同一目录的不同文件归一到同一签名 |
| 分片装箱 | **I1 property test**（随机路径集 → 断言前缀互斥） |
| `applyDeletion` | **I2 property test**（随机树 + 随机删除序列 → 面积守恒恒成立） |
| 预算闸门 | 超限时优雅停止、标记"未解释"、不抛异常（I4） |

### 15.2 集成
本地临时目录树 → dry-run → 真删 → 核对：
`预期字节 == 实测释放字节 == 树图减少量`（tmpfs 上可精确相等）。

### 15.3 契约
- `ExplainPort` 的 fake 实现跑通 批量 / 缓存 / 超预算 三条路径。
- `CoordinatorPort` 的 pool 与 team 两种实现跑**同一份计划**，产出结构等价 RunReport。

### 15.4 安全回归
- `blocked` 项永不出现在可执行集合；
- `action ∈ {command, manual}` 的项永不进 ActionPort；
- lease 越界、缺租约、跨 shard 路径 → 必拒并记 `lease_violation`；
- 无 `confirmToken` 的 `submit` → 必拒。

### 15.5 成本回归
- 同一目标连续扫描两次 → 第二次 LLM 调用数 **== 0**；
- 删除后刷新事件的 LLM 调用数 **== 0**（§10.7）；
- 规则包版本变更 → 旧缓存不再命中。

### 15.6 界面验收
- 只引主题 token；无 `@deepseek-ai/dsh-client-ui-*` import；
- console 无 slot entry crash；
- 明暗主题都正确；中英文案齐全；
- 侧栏图标能打开整页；
- **提交与进度都在页内完成（对话里无选择交互）**；
- **删除时能看到树图与容量条实时变化，且不触发重扫**。

> 无浏览器控制权时，只能验证到 JS 语法 / 清单校验 / 插槽注册；**"渲染正确"必须报告为未验证**，不得宣称视觉成功。

---

## 16. 失败模式与边界

| 场景 | 处理 | 可见性 |
|---|---|---|
| 权限拒绝（`System Volume Information`、root-only 目录） | 记 `skipped(denied)` | 界面显示"未覆盖 N 项（无权限）"，**不静默** |
| reparse point / symlink | 不跟进（沿用现有 `is_reparse`） | — |
| 超大扫描 | `MAX_NODES` 剪枝 + 流式 NDJSON + 分块渲染；跑在 job/worker 里，不阻塞 Host 事件循环 | 扫描进度条 |
| 删除前目标已变化 | re-stat 比对 mtime/size → 跳过并标 `changed` | 清单保留该行 |
| 目录非空 | 不递归删，除非计划显式标 `recursive` 且用户勾了"包含子项" | 面板勾选项 |
| 部分失败 | 单项失败不影响同 shard 其余项；shard 失败重试 1 次；仍失败进报告 | 报告失败列表 |
| 执行者失联 / `maxMembers`（默认 16）用尽 | 任务 `release` 后由插件重派；超限则串行跑完剩余 shard | 底部进度显示降级 |
| 中断 | 停止新派发，等在跑的执行者完成当前项；审计记中断点 | 按已发生事件收敛 |
| LLM 不可用 / 超预算 | 退化为规则基线 + "未解释"标记 | 面板显示降级原因与已用预算 |
| 缓存失效 | 规则包版本 / 模型 / prompt 版本变化 → 键变化，旧解释不冒充新结论 | — |
| 租约冲突 | 结构上不可能（I1）；若发生 → 拒绝 + 记 `lease_violation` | 异常上报 |
| 多 shard 事件并发 | 单一 RunState reducer 串行应用，`seq` 排序去重 | — |

---

## 17. 数据流时序

### 17.1 扫描
```
UI → remote.scan(targetId)
   → Host 编排 ScanPort（worker / 线程）
   → 分块 NDJSON 进度 → scan-progress 事件
   → core 聚合与剪枝（沿用现有参数：BIG_FILE / MIN_EXPAND / MAX_DEPTH / KEEP_TOP / MAX_NODES）
   → 规则标注（0 成本）
   → 签名聚合 → 缓存命中 → 差额批量 LLM
   → 候选集落 Store
   → UI 增量渲染
```

### 17.2 提交与执行（这条链上没有任何 LLM 调用）
```
UI 勾选 → remote.plan → remote.submit(planId, confirmToken)
  → 校验计划 + 审计意图（fsync）
  → 分片 + 断言 I1
  → 取得 Lead 句柄 → spawn 执行者 → createTask(writeScopes=lease) → sendMessage 指派
  → 执行者 garbage_execute_shard(shardId, leaseToken)
  → 租约校验 → ActionPort 删除
  → item-deleted 事件 → RunState reducer 增量更新模型（O(深度)）
  → 页面：树图变小 / 清单移除 / 已释放增长
  → shard-done → 一次 statfs 刷新容量条 + verify 校正
  → run-done + RunReport + 审计结果
```

---

## 18. 里程碑

| 阶段 | 内容 | 完成度定义（DoD） |
|---|---|---|
| **M0** | **本设计文档**（唯一交付物） | 文档落盘，决策表、契约、不变式、事件表、验收清单齐全 |
| M1 | 本地扫描 + Windows 规则包基线 + 只读面板 | 能扫、能看树图与清单、能显示风险与解释；dry-run；不改动任何文件 |
| M2 | `ExplainPort`（`ctx.llm`）+ 签名聚合 + 缓存 + 预算 | 成本回归通过（重复扫描 0 调用）；预算超限优雅降级 |
| M3 | `ActionPort` 永久删除 + 审计 + 报告 + **§10 实时界面更新**（串行，不用团队） | 集成测试字节相等；删除路径 LLM 调用 0；I2 不破 |
| M4 | `CoordinatorPort` + Agent Teams 分片执行 + 租约强制 | I1 property test 通过；team/pool 报告等价；越界必拒 |
| M5 | 第二传输（SSH 或 sidecar 复用现有 Python 扫描器）+ Linux 规则包 | 同一 UI 操作两种 transport；规则包按平台加载 |
| M6 | 独立软件形态（**不在本插件内**） | 远期愿景，不在本设计承诺范围 |

> **实施现状（2026-10-18）**：M1 / M2 / M3 / M4 **已落地**，
> M5（第二传输：SSH / sidecar）与 M6（独立软件形态）未做。
>
> - **M2 解释与计划**：`host/plan-ai.js` 走 `ctx.agentDefaultModel.currentSelection()` + `ctx.llm.stream()`，
>   模型只做**解释 / 建议 / 排序 / 告警**；越界路径一律丢弃（有测试）。按签名聚合与缓存尚未实现 ——
>   当前是"每次提交问一次"，预算闸门用 `maxTokens` + 30s 超时兜底。
> - **M3 执行**：`clean`（删除 + 租约 + 删前 fsync 审计 + 分片）、`pack`（`tar.gz`，**不删原件**）、
>   `tidy`（只统计重复，**不删文件**）三种执行器齐备；`§10` 的零 LLM 增量更新保持不变。
> - **M4 派发**：`host/dispatch.js` + 受限工具 `garbage_run_group`。一类任务一个执行者，
>   子代理**只能**调这个工具（按 `membership().name` 鉴权、幂等）；团队不可用时降级为进程内执行器。
>   与设计的一个偏差：**编排者仍是插件**（插件用 Lead 的授权句柄 spawn/建任务/指派），
>   而不是让 Lead 模型自己拆任务 —— 这样"删什么"不经过模型判断。
> - **§7.2 的 `action: command` 之外**，新增 `core/uninstall.js`：识别 snap/flatpak/conda/nvm/pyenv/opt，
>   把这些条目从"删除"转入"卸载建议"（只给命令，不自动执行）。
>
> 实现过程中的代码修复与务实偏差见 [README.md](../README.md) §7–§9、§13–§16。

---

## 19. 已定默认值（Config 草案）

| 键 | 默认 | 说明 |
|---|---|---|
| `shardCount` | 4 | 分片/执行者数；团队 `maxMembers` 默认 16，不会撞上限 |
| `dryRun` | `true` | 首版安全默认；面板可显式关闭 + 二次确认 |
| `llm.maxCallsPerRun` | 40 | 预算闸门 |
| `llm.batchSize` | 20 | 每批签名数 |
| `llm.provider` / `llm.model` | 跟随 `ctx.agentDefaultModel.currentSelection()` | 不设独立凭据 |
| `scan.bigFileBytes` | 500 MiB | 沿用现有 `BIG_FILE` |
| `scan.minExpandBytes` | 200 MiB | 沿用现有 `MIN_EXPAND` |
| `scan.maxDepth` | 9 | 沿用现有 `MAX_DEPTH` |
| `scan.keepTop` | 14 | 沿用现有 `KEEP_TOP` |
| `scan.maxNodes` | 16000 | 沿用现有 `MAX_NODES` |
| `exec.allowRecursiveDirDelete` | `false` | 目录候选默认不递归 |
| `capacityRefresh` | `per-shard` | 容量条刷新粒度（每 shard 一次 statfs） |
| `rules.pack` | 按目标 OS 自动 | `win32.yml` / `linux.yml` |

---

## 20. 假设与风险

### 20.1 假设
1. DSH profile 为 `web`；面板挂在当前会话，但不需要会话内交互。
2. 用户接受为"删除"做**一次性提权**批准（L3），且理解永久删除不可恢复。
3. 现有 4 份 Python 脚本（`scan_disks.py` / `patch_recycle.py` / `build_map.py` / `compare.py`）作为**参考实现与规则来源**，不是首版必须复用的运行时——它们绑定 Windows 与 `C:\`/`D:\`。sidecar 传输可在 M5 复用它们。
4. 面板绑定"当前工作区会话"以取得 Lead 句柄。

### 20.2 风险
| # | 风险 | 缓解 |
|---|---|---|
| R1 | `Agent Teams` 是实验性包（`dsh-experimental-*`），API 可能变动 | `CoordinatorPort` 隔离它；删除协议不依赖团队细节；无团队时走 pool |
| R2 | 把删除权限交给"执行者 teammate"本质扩大攻击面 | 三层收敛：工具裁剪 + 租约校验 + 审计；永不提供 `garbage_delete(path)` |
| R3 | 默认永久删除 + 真实数据 | 首版强制 dry-run；`blocked` 档不可删；审计先落盘。**三条为不可协商项** |
| R4 | 增量更新与真实磁盘状态漂移（界面"看起来对但其实不对"） | 每 shard 的 verify 是校正点；报告数字以**实测**为准，不以累加值为准 |
| R5 | 一次性的提权若设计不当会变成常驻后门 | 提权绑定"本次运行"，运行结束即失效；提权只在删除路径上生效 |
| R6 | 平台上 Linux 规则包质量低于 Windows 包（现有资产是 Windows 的） | 首版 Linux 包只覆盖低风险可再生缓存（`safe`），`caution` 以上不自动放行 |

---

## 附录 A · 术语对照

| 本文用语 | 含义 |
|---|---|
| 候选 / Candidate | 一条可被勾选清理的项（可能聚合了多个文件） |
| 签名 / signature | 抹掉个体差异后的"类路径"，聚合与缓存的基本单位 |
| 计划 / Plan | 用户勾选结果的快照（Host 侧重算 totals） |
| 分片 / Shard | 一份计划切出的互斥子集 |
| 租约 / lease | 某 shard 独占的路径前缀集合，互斥的强制依据 |
| verify | 用实测数据校正"预期 vs 实际"的小范围核对 |
| 执行者 | 被裁剪过的 teammate（或 pool worker），只能按租约删除 |

## 附录 B · 现有资产映射

| 现有文件 | 在本设计中的位置 |
|---|---|
| `scan_disks.py` | 参考实现：扫描与剪枝参数（Config 已沿用其常量）；M5 的 `scan-sidecar` 候选 |
| `patch_recycle.py` | 参考：回收站需作为独立候选项被显式呈现（对应 §7.2 的 `$RECYCLE.BIN` 规则） |
| `build_map.py` | 规则来源（RULES → RulePack，§7.2）；树图渲染与配色语义（squarify / safe-caution-keep）直接复用 |
| `compare.py` | 参考：两次扫描的差异对比，是"预留的报告视角"（本次未纳入，但 RunReport 的形状与其兼容） |
| `disk_data.json` | ScanNode 的形状来源（§5.2） |

## 附录 C · 需要在实现前实测确认的 DSH 行为

1. **一次性提权**在 `ctx.shell` / ActionPort 上的确切形态（是否可对单次运行盖章更宽的 sandbox 模式）。
2. `ctx.agentTeams` 在 `web` profile 下是否已挂载；`tryMembership` 对"Lead 但尚未建团队"的会话返回什么。
3. 客户端插件的 `main` 页面与 `sidebar.panellist` 在当前 profile 的可见性与其 `order` 取值（避免与现有 panel 冲突）。
4. `@Remote({mode:'stream'})` 进度流在页面重连时的行为（是否需要显式重放窗口）。
5. 明文 React 客户端半的 HMR 生效条件（是否需要 `dev:web` 在跑），以便给出准确的验证方式。
