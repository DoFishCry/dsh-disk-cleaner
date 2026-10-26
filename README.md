# GarbageMaster（DSH 插件 · Linux 版）

一个装在 DSH Web UI 里的磁盘清理控制台：**扫描 → 看解释 → 勾选 → 清理 → 实时看到空间变化**。
本文件说明「现在能用什么、怎么用、哪里还没做、和设计文档有哪些偏差」。

设计与契约基线见 [docs/design.md](docs/design.md)。

---

## 1. 安装状态与重启

已安装到当前 `web` profile（`install_bundle`，`application: applied`），插件行：

```
entryId: include:garbage-master        moduleName: @local/dsh-garbage-master        fiberPhase: active
```

**代码改动要重启 dsh 才会生效**：Host 侧模块被进程级 ESM 缓存，客户端的 bundle 也是按 rev 缓存的。
本仓库在安装后又修了两个 bug（见 §7），因此**需要重启一次**才能拿到最新行为：

```bash
# 按你的日常方式重启即可（用户级 systemd 服务；那台机器上还有 ~/dsh/restart-and-verify.sh）
systemctl --user restart dsh
```

重启后：**候选清单会从 1 项变成 ~20 项**（家目录约 14.7 GiB 可回收）。

---

## 2. 现在能用什么

| 能力 | 说明 |
|---|---|
| 自动探测目标 | 家目录 + `/` + `/media`、`/mnt` 下的真实数据盘（本机识别出 `/media/user/Data Disk`） |
| 只读扫描 | 单遍遍历、自底向上剪枝、**不跨挂载点**、**不跟进符号链接**、**包含隐藏文件与隐藏目录**；进度实时回传 |
| 规则解释 | 每条候选给出风险档（可安全删除 / 需你确认 / 建议保留 / 不可删除）+ 处置方式 + 一句人话说明；需要官方命令的会给出可复制的命令 |
| 矩形树图 | 面积即体积，可下钻、面包屑、按风险着色与过滤、可切换是否显示隐藏文件；**单击目录 = 进入**、**双击文件 = 用系统默认程序打开**（不提供"用默认应用打开"按钮） |
| **当前位置面板** | 右栏上方跟随当前路径：体积/风险/**规则说明**/官方处置命令 + **子项清单**（子目录在前、含占比例条）。走 `/api/ls` **实时列目录**，所以**任意深度都有内容**，不用打开文件管理器；目录体积未知时显示"体积未知"并可点「量体积」（有界遍历） |
| **在文件管理器中显示** | 行内 hover 动作与当前位置卡片各有一个入口（`org.freedesktop.FileManager1.ShowItems`，失败退回 `xdg-open`） |
| 手动指定 | 树图里任何一项都能「加入清理清单」，不受规则覆盖范围限制（服务端仍会拒绝 `blocked` 与受保护路径） |
| 计划与确认 | 提交前由**服务端**重算体积，弹出确认框列出将处理的条目；勾选「目录候选包含子项」才允许递归删目录 |
| 演练模式 | **默认开启**，只出报告不删任何东西；关掉后才真删 |
| 执行 | 分片 + **路径租约**（越界即拒）+ **删除前写审计并 fsync** + 每片结束一次 `statfs` 刷新容量 |
| 实时更新 | 每删一项推送 `item-deleted`，界面**本地增量**减树、减清单（O(树深)），**不重扫、不调 LLM** |
| 报告 | 预期 vs 实际、`statfs` 差值、失败/跳过明细、审计文件路径 |

## 3. 安全模型（默认永久删除下的四层护栏）

1. **规则层**：`blocked` 档永不可删（系统本体、密钥、`.git`、数据库、包管理数据库、挂载容器、家目录本身）。
2. **计划层**：服务端重算体积、拒绝越界/受保护路径、`blocked` 直接剔除、一次性 `confirmToken`（5 分钟有效）。
3. **执行层**：`protectedPaths`（目标根、挂载点、状态目录、家目录）+ 路径租约互斥（不变式 I1）+ 计划后目标变化则跳过。
4. **审计层**：`~/.dsh/garbage-master/audit/<planId>.jsonl`，**删除前**先写 intent 并 fsync，结束后写 result。

## 4. HTTP 接口（面板就是调这些）

同源，需 `x-garbage-master-token`（插件启动时生成，经 `tapIndex` 注入到 index.html；外部拿不到）。

```
GET  /garbage-master/api/state          状态快照（目标、扫描摘要、运行状态、配置）
POST /garbage-master/api/scan           启动扫描       {targetId}
POST /garbage-master/api/cancel-scan    中断扫描
POST /garbage-master/api/target-add     运行期加目标   {path,label}
GET  /garbage-master/api/tree           扫描树         ?target=
GET  /garbage-master/api/candidates     候选清单       ?target=
GET  /garbage-master/api/bigfiles       大文件         ?target=&limit=
GET  /garbage-master/api/ls             实时列目录     ?path=&limit=（任意深度；目录体积能取扫描真值就取，取不到报 null）
POST /garbage-master/api/measure        按需量体积     {path,maxEntries?,maxMs?}（有界遍历，超限标 truncated）
POST /garbage-master/api/plan           生成计划       {targetId,selection[],extraPaths[],includeRecursive}
POST /garbage-master/api/submit         执行           {planId,confirmToken}
POST /garbage-master/api/cancel         中断执行
GET  /garbage-master/api/report         报告           ?planId=
GET  /garbage-master/api/audit          审计           ?planId=
POST /garbage-master/api/reveal         在文件管理器显示 {path}
POST /garbage-master/api/open           用默认程序打开  {path}
POST /garbage-master/api/config         切换演练/并发数 {dryRun,workers}
GET  /garbage-master/api/events         SSE 进度流      ?seq=（断线重连补齐）
```

## 5. 规则包

`core/rules.js` 里是一张**有序**表：**按顺序匹配，第一条命中即生效**，所以顺序本身就是安全设计
（具体缓存 → 通用缓存 → 系统禁区 → 用户数据 → 项目碎片）。

两条纪律：

- **绝对路径规则必须以 `^` 锚定**，只有"任意层级出现"的才用 `(^|/)`。
  反例：写成 `/tmp(/|$)` 不加 `^`，会匹配 `/tmp` 下的一切并遮蔽后续所有规则（真实踩过，回归测试守着）。
- **笼统的安全规则不得吞掉内部更高风险的命中项**。例如 `~/.cache` 是 safe，但里面有
  `~/.cache/huggingface`（caution，重下载代价高）：此时界面**不会**建议整体删 `~/.cache`，
  而是列出更具体的子项。

## 6. 测试

```bash
node tests/smoke.mjs        # 67 项，全绿
```

夹具建在**本仓库目录**下的唯一临时目录（不是 `/tmp`——`/tmp` 有规则会遮蔽夹具；也不是家目录——沙箱不允许）。
覆盖：规则优先级与锚定、体积准确性与不变式 I2、候选推导（含"扫描根不得吞掉子树"回归）、
计划护栏、dry-run 不删、真删后模型守恒、审计三行、租约互斥、`applyDeletion` 边界。

## 7. 安装后修掉的两个真实 bug（重启后生效）

1. **`buildIndex` 把每个节点都登记成 `kind:'root'`** —— 递归时覆盖了刚写好的 `kind:'child'`，
   导致 `applyDeletion` 对任何子节点都报 `refuse-root`，删除后树图不更新。
2. **扫描根被当作候选吸收整棵子树** —— `/home/<user>` 命中「家目录本身 blocked」规则，
   于是整盘只列出 **1 个**不可删除的候选（真实数据上复现）。现在扫描根只作容器。

另外把规则表里 3 条未锚定的绝对路径规则（`/tmp`、`/var/tmp`、`/var/cache` 等）全部改成 `^` 锚定。

## 8. 还没做（按设计文档的里程碑）

| 里程碑 | 状态 |
|---|---|
| M1 本地扫描 + Linux 规则包 + 只读面板 | **已做** |
| M2 `ExplainPort`（`ctx.llm`）+ 签名聚合 + 缓存 + 预算 | **未做**：解释目前全部来自规则（0 成本） |
| M3 永久删除 + 审计 + 报告 + 实时界面更新 | **已做**（进程内 worker 池，串行/并行均可） |
| M4 Agent Teams 分片执行 | **未做**：租约强制与审计已就位，M4 只需把 `pool-worker-N` 换成 teammate 并复用同一套 lease 校验 |
| M5 第二传输（SSH / sidecar 复用你现有的 Python 扫描器） | **未做**：`Target.transport` 字段已留，目前只有 `local` |
| M6 独立软件形态 | 不在本插件内 |

也**没有**给模型注册任何删除类工具（`garbage_delete(path)` 之类永不提供），
所以现阶段"由智能体团队并行删除"还没接上——但删除协议的护栏（租约/审计/一次性确认）已经先落地了。

## 9. 与设计文档的偏差（实现时的务实取舍，均已记录）

| 设计 | 实现 | 原因 |
|---|---|---|
| 规则包用 YAML | 用 JS 数据表 | Node 无内置 YAML 解析器，不为一个数据文件引入依赖 |
| 页面走 `@Remote`（typert） | 自注册 HTTP 路由 + SSE + 索引注入 token | typert 需要编译期生成的反射，手写纯 JS 插件不可靠；SSE 也更适合实时进度 |
| 文案走 `ctx.locale` 服务 | 客户端内置 zh/en 字典（`locale/*.json` 仍提供 `meta` 供插件管理页显示） | 避免对未验证的客户端 locale API 形成硬依赖（`t` 不存在会直接让插槽崩溃） |
| `core/` 独立 npm 包 | 同包内子目录，保持零宿主 import | 避免本地 workspace 依赖解析问题；拆包时只需移动文件 |
| `archive` 打包动作 | 枚举已留、执行器暂未实现 | 先把删除路径做扎实 |

## 10. 文件结构

```
index.js          宿主入口：目标探测 / 规则编译 / 状态 / 路由 / token 注入
client.js         客户端整页控制台 + 侧栏图标
core/rules.js     Linux 规则包（有序、声明式）+ 匹配器
core/model.js     纯逻辑：签名归一化、候选推导、applyDeletion（I2 增量维护）
host/scan.js      只读扫描器（剪枝 / 不跨挂载点 / 含隐藏文件 / 进度）
host/state.js     状态存储 + 事件广播（带 seq，支持断线补齐）
host/exec.js      计划构建 + 分片 + 租约 + 审计 + 执行
host/open.js      reveal / open（xdg-open、FileManager1；不经 shell）
host/http.js      HTTP + SSE 通道与 token 鉴权
tests/smoke.mjs   端到端冒烟测试（67 项）
```

## 11. 已知限制

- 仅 `transport: 'local'`；跨机清理需要 M5。
- 扫描会为每个文件做一次 `lstat`（体积必须准确），家目录 86 万文件约 **55 秒**；`/` 会更久。
- 权限不足的目录会计入 `denied` 并跳过，界面显示数量（不会静默）。
- 启动时读 `/proc/self/mounts` 建立挂载点集合，因此**不跨挂载点**；扫描根自身是挂载点属正常。
- 界面视觉验证**尚未完成**：需要浏览器里的 dsh 访问 token，而这属于凭据，我不提取。
  已完成的替代验证见 §12。
- 大文件清单按 `bigFileBytes`（默认 500 MB）收集；家目录当前为 0 条。

## 12. 已完成的验证（截至本次交付）

- `node --check` 全部 9 个 JS 文件；`package.json`、两个 locale JSON、`icon.svg` 均校验通过。
- `node tests/smoke.mjs` → **67/67**。
- 插件行 `include:garbage-master`：`fiberPhase: active`。
- 路由已注册：未带 token 请求 `/garbage-master/api/state` 返回 **403 `bad-token`**（不是 404）。
- 索引注入生效：`window.__GARBAGE_MASTER__ = {"token":…,"prefix":"/garbage-master"}`；客户端 bundle 被 index 引用。
- 插槽注册（`Slots.listSubTree`）：`main` keyed 占用者含 `garbage-master`（未顶掉 `conversation`）；
  `sidebar.panellist` 占用者含 `garbage-master`（order 20，无 id 冲突）；两者 `active: true`。
- 真实扫描：家目录 121,650 目录 / 863,621 文件 / 71.2 GB，**54.8 秒**，1 个无权限目录，1850 个符号链接被跳过。
- 真实数据上的候选推导（修复后代码离线跑同一棵树）：**20 个候选、19 个可执行、14.7 GiB 可回收**
  （`~/.cache/uv` 9.01 GB、playwright 1.23 GB、`_npm/_cacache` 966 MB、`snap/firefox/.cache` 1007 MB…），
  `~/.local/share/Trash` 正确作为「官方命令」条目不参与自动删除。
- 客户端静态合规：只用 `--dsw-alias-*`（13 个已核实存在的 token），无任何 `@deepseek-ai/dsh-client-ui-*` import。
- **未验证**：面板的实际渲染、明暗主题观感、双击打开与"在文件管理器中显示"的真实效果（需要图形会话与页面访问）。

---

## 13. r3 修订（界面与交互，2026-10-18）

按你的反馈改的，逐条对应：

### 13.1 深色模式：白字压浅红读不出来（已修）

**根因（实测宿主主题包）**：`--dsw-alias-state-*` 是**别名**，会随主题换值：

```
body                      { --dsw-alias-state-error-primary: var(--dsw-static-red-600) }  /* #ec1313 深红 */
body[data-ds-dark-theme]  { --dsw-alias-state-error-primary: var(--dsw-static-red-400) }  /* #f25a5a 浅红 */
```

我原来拿它当**色块填充**，又配 `color:#fff` → 深色下就是白字压浅红（约 2.4:1）。而你选的目标是系统根分区 `/`，它的子项（`/bin` `/boot` `/etc`…）**全是 blocked**，所以整屏都命中这个 bug。

**修法**（对齐你 `disk_map.html` 的做法）：色块与徽章改用**固定 700 阶色板**，白字在两种主题下都 ≥4.5:1；外壳（背景/边框/文字）继续用宿主 token；暗色微调挂在宿主真实的 `body[data-ds-dark-theme]` 下。

```
safe   #15803d #16a34a #166534      caution #b45309 #d97706 #92400e
keep   #475569 #64748b #334155      blocked #b91c1c #dc2626 #991b1b
```

同层相邻色块**轮换色阶**（你文件里的 `COLORS[i%4]`），避免大片同色糊在一起。

### 13.2 删掉的无用元素

| 删/改 | 原来是什么 |
|---|---|
| 副标题 | `扫描 → 看解释 → 勾选 → 清理；删除后此处实时更新` |
| `✔ 演练模式` 按钮 | 我把它截断成 `t(...).slice(0,4)` 产生的乱码；现在只有**头部一个状态胶囊** + **底部一个正经开关** |
| `statfs Δ` / `failed` / `dry-run` / `manual pick` | 中文界面里的英文残留，统一中文（英文界面走 en 字典） |
| 每行的长说明 | 默认折两行 + `展开/收起` |
| 每行常驻的三个按钮 | 收到 hover 才出现 |
| 「用默认程序打开」按钮 | 按你的要求删掉，改为**单击/双击直接操作** |

### 13.3 交互

- **单击目录 = 进入**（原来是双击）；**双击文件 = 系统默认程序打开**。
- 单击文件 = 高亮并在「当前位置」顶部显示它的体积/风险（不切换目录）。
- 面包屑、`返回上级` 照旧。

### 13.4 新增「当前位置」面板（右栏上方，与候选清单上下堆叠）

- 当前路径 + 体积 + 风险徽章 + **规则说明** + 官方处置命令（可复制）。
- **子项清单**：子目录在前、文件在后，各按体积降序；每行 = 风险色点 + 名称 + 体积 + **占当前目录比例条**（你文件里的 `.row/.rbar`）。
- 数据来源两级：**扫描树里已知的**（体积是扫描时量准的，含被折叠的 `others` 项，现在会铺开成独立图块）→ **`/api/ls` 实时读取**（任意深度都有内容）。
- 目录体积查不到时**诚实显示"体积未知"**，并提供「量体积」（`/api/measure`，有界遍历：默认 40k 条目 / 3s 上限，超限标 `truncated` 并显示 `≥`）。
- `/api/ls` 只接受落在已注册目标内的绝对路径，越界直接 403。

### 13.5 其他

- 扫描剪枝阈值 `minExpandBytes` 由 200 MiB 降到 **32 MiB**、`keepTop` 14→20：树图能多下钻几层（树规模仍由"体积达标的目录数量"限制，内存有界）。
- 测试从 67 项加到 **81 项**，新增一节覆盖 `/api/ls` 与 `/api/measure`（隐藏文件、精确体积、目录体积来源、blocked 标注、截断、路径不存在、有界停止）。

**仍需重启 dsh 生效**（Host 与客户端 bundle 都按进程/rev 缓存）：
```bash
systemctl --user restart dsh
```
刷新页面后：深色模式应当能正常阅读，右栏上方会出现「当前位置」，单击目录直接进入。

---

## 14. r4 修订（2026-10-18 第二批反馈）

### 14.1 目标探测：家目录与 / 不再算两个盘（真实 bug）

**根因**：原来的目标列表是"家目录 + 所有真实挂载点"，把**同一分区上的不同路径**当成了不同的盘。
这台机器上 `stat -c %d` 显示家目录与 `/` 的 `st_dev` 相同（都在 `/dev/mapper/ubuntu--vg-ubuntu--lv`），
所以界面上出现了两个"盘"，容量还是同一份。

**修法**：按 `stat().dev` 归并，**每个真实文件系统一个目标**；家目录只在独立分区时才单独出现；
目标按"剩余空间比例"从紧到松排序；每个页签直接显示 `剩余 X G · 已用 NN%`（在**扫描之前**就有，
因为容量来自一次 `statfs`，不依赖扫描）。家目录另用「快捷」胶囊提供一键跳转。

顺带把两行晦涩的统计改成普通人能读懂的：`1 个目录没有读取权限，已跳过 · 跳过 1850 个符号链接（不跟进，避免绕圈）`，
并在容量那行补上了百分比。

### 14.2 交互与视觉

- **修掉树图不可点击的 bug**：tile 传的是 `kind`，而 `goInto()` 判的是 `isDir`，所以单击目录一直没反应。
  现在单击目录 = 进入下一层；单击文件 = 聚焦；双击文件 = 系统默认程序打开。
- 色块上直接显示**占当前目录的百分比**（`体积 · NN%`）。
- **文件块加图标**（小文件页图标 + 轻微渐变），与纯色目录块区分开。
- 文字层级分开：标题最重、体积加粗、路径等宽弱色、元信息更弱（`.gm-t1/.gm-t2/.gm-t3`），不再一色到底。
- **移除演练模式**（界面与 `/api/config` 都不再接受 `dryRun`）。
- 「当前位置」重做：位置、路径、**体积 + 占上级百分比**、修改时间、解释、官方处置命令，
  下面三个按钮 = 复制路径 / 在资源管理器中打开 / **操作下拉（加入清理清单[默认] / 打包 / 整理）**。

### 14.3 选择清单与流程

- 右下方两个页签：**本层条目**（复选框 + 描述 + 体积 + 占当前目录百分比条形图 + 逐项操作模式）
  与 **规则建议**（原来的候选清单）。支持**按路径或文件名搜索**（两个页签共用同一个搜索框）。
- 底部栏**默认收起**为一行（清单 · N 项 · 体积 · 提交键）；展开后是完整清单表格：
  **大小 / 风险 / 修改时间 / 路径 / 说明 / 操作 / 特殊要求 / 移除**，并有独立搜索框。
  「特殊要求」逐条自由文本，随计划一路带到 LLM 输入。
- 流程改为：**选择 → 浏览清单 → 提交 → 计划 → 界面展示 → 确认 → 二次确认（勾选） → 执行/派发**。

### 14.4 三种操作与计划编排（Host 侧已就位）

`host/exec.js` 里 `buildPlan` 现在接受 `items: [{path, mode, special}]`，`mode ∈ clean|pack|tidy`：

| 模式 | 语义 | 目录是否需要"包含子项" | 本阶段执行器 |
|---|---|---|---|
| `clean` 清除 | 删除（应用/环境类应改为卸载） | 需要显式确认 | **已接入**（分片 + 租约 + 审计） |
| `pack` 打包 | 压缩成一个归档文件，**不删原文件** | 不需要 | 待接入（列入 `plan.pending`） |
| `tidy` 整理 | 去重整理，**不删任何文件** | 不需要 | 待接入（列入 `plan.pending`） |

编排约束已实现并有测试守着：
- **同类操作合并成组**，组顺序固定 `清除 → 打包 → 整理`；
- **需要重启/重登的任务一律挑出来排到最后**（`requiresRestart()` 识别命令与说明里的 reboot/重启/重新登录等关键词），
  单独成组并在界面顶部标注 `⚠ 最后执行` 与"执行前请先保存工作"；
- 每个组带 `deletesFiles` 标记，二次确认弹窗按其区分措辞。

### 14.5 还没做的（下一步）

1. **AI 计划**：目前计划是**确定性生成**的（分组 + 置尾 + 风险与官方命令），还没有让 LLM 参与
   （例如"这看起来是个应用，应该卸载而不是删目录"、"这些是重复文件，建议保留哪一份"）。
   接口与数据结构已经备好（`items[].mode/special`、`plan.groups/pending`），接 `ctx.llm` 即可。
2. **打包 / 整理执行器**：现在会进计划与清单，但明确列在 `plan.pending`，不会被静默跳过。
3. **派发给智能体**：二次确认后目前执行的是 `clean` 组（进程内执行器，带租约与审计）；
   "一个子代理只负责一类任务"的团队派发（M4）还没接。
4. 视觉仍然只能靠你确认——我没有浏览器控制权。

测试从 81 项加到 **93 项**（新增一节覆盖三种模式、分组顺序、重启类置尾、特殊要求透传、keep 项在打包/整理下放行）。



---

## 15. r5 修订（目标轮次 1：AI 计划 + 打包/整理执行器）

### 15.1 三种操作都有执行器了

| 模式 | 实现 | 语义 |
|---|---|---|
| `clean` 清除 | `host/exec.js` 分片 + 租约 + 审计（原有） | 删除；目录需二次确认里的"包含子项"勾选 |
| `pack` 打包 | **新增** `host/archive.js` | `tar -czf` 把所有打包条目压进**一个**归档；**默认不删原文件**；`-C /` + 相对路径，归档里不写绝对路径；显式排除状态目录与归档自身 |
| `tidy` 整理 | **新增** `host/tidy.js` | 先按尺寸分桶、只对同尺寸做 sha256，找重复文件并统计浪费空间；**不删除任何文件** |

执行顺序：**先打包 → 再清除 → 最后整理**（整理放在删除之后，避免把刚删掉的重复项再算一遍）。
三者的结果都进 `RunReport`（`report.pack` / `report.tidy`）与审计（`kind: pack|tidy`），并各自发进度事件。

### 15.2 AI 计划（宿主模型配置，不新建凭据）

`host/plan-ai.js`：取 `ctx.agentDefaultModel.currentSelection()` 的 provider/model，
用 `ctx.llm.stream()` 发一次一次性请求，要求严格 JSON（summary / items[path,reason,suggestion] / order / warnings）。

**模型不决定删除范围**，这是硬约束：
- 返回里**任何不在用户选择清单内的路径一律丢弃**并记录（`ai.dropped`），测试守着这条；
- `suggestion`（如"这条应该卸载应用而不是删目录"）**只作为建议展示**，不会自动改变用户选定的模式；
- 建议值只接受 `clean|pack|tidy|uninstall|keep` 白名单；
- 模型给的 `order` 只影响组内**展示/执行顺序**，不会改变分组模式，也不会让重启类任务提前；
- LLM 不可用 / 没配模型 / 超时 / JSON 坏了 → **自动降级为确定性计划**，响应里带 `ai.used=false` 与原因，界面明确显示"AI 不可用（原因），已按规则生成计划"。

提示词是紧凑的逐行格式（路径 | 字节 | 风险 | 用户模式 | 规则说明 | 特殊要求），最多 80 条（按体积取前 80），
避免把整段规则说明塞进上下文；用户填的「特殊要求」原样带进去。

### 15.3 界面

计划弹窗新增：AI 判断摘要、AI 告警（⚠ 需要重启等）、被丢弃的清单外路径计数、每条目的 AI 理由、
以及"AI 建议：uninstall"这类徽章（与用户所选模式不一致时才显示）。报告区新增归档路径/体积/条目数与重复文件统计。

### 15.4 仍然没做（下一轮）

1. **派发给智能体**：二次确认后仍由进程内执行器执行（带租约与审计），
   "一个子代理只负责一类任务"的团队派发没接。技术路径已确认可行：`ctx.tools.register()` 接受
   **纯 JSON Schema 的 ToolDefinition**（`{name,description,parameters,output:{schema,render},execute}`），
   因此可以注册一个只允许"按计划执行某一类任务"的工具，再让 teammate 只能调它。
2. **`clean` 的"应用/环境→卸载"分支**：目前只作为 AI 建议展示，尚未产出卸载命令。
3. 视觉验证仍缺（无浏览器控制）。

测试 96 → **113 项**（新增：真实 tar 打包与归档条目校验、重复文件分组与"不删文件"、打包不删原文件、
归档落在指定目录、AI 解析（代码围栏/越界路径丢弃/顺序过滤/suggestion 白名单/坏 JSON 不抛异常）、
提示词内容、需要重启的任务单独成组且不混进本批）。

---

## 16. r6 修订（目标轮次 2：派发给智能体 + 卸载分支）

### 16.1 派发：一类任务一个执行者，子代理只能调一个受限工具

`host/dispatch.js` + 宿主里的工具注册，落实第 9/11 条：

- **一个执行者只负责一类任务**：`clean` / `pack` / `tidy` 各一个 teammate（名字 `gc-clean` / `gc-pack` / `gc-tidy`），
  互不越界；`restart` 组**不派发**（要用户先保存工作）。
- **子代理不直接动文件系统**：它只能调用 `garbage_run_group({planId, mode})`，真正的删除/打包/去重
  仍由插件里带**路径租约 + 审计**的执行器完成。工具本身做三道鉴权：
  1. 计划必须存在；2. 该模式必须是被派发过的组；3. **调用者必须是该组的指定执行者**
     （用 `agentTeams.tryMembership(exec.agent).name` 比对）。所以即使主智能体看到这个工具也越不了权。
  执行是**幂等**的：同组重复调用直接返回缓存结果。
- **同类合并**：一次工具调用处理该组全部条目，不逐个路径派发。
- **顺序**：先 `pack` → 再 `clean` → 最后 `tidy`（整理在删除之后）。每组的完成由工具回报触发
  （`createGroupWaiters` 闸门，15 分钟超时），完成后才派下一组，并把任务板上该任务标为 complete；
  任务之间用 `blockedBy` 串成链，`writeScopes` 就是该组的路径。
- **降级**：没有 `agentTeams` / 解析不到 Lead / spawn 失败 → **进程内执行器**按同一顺序跑同一份计划、
  同一套租约与审计，并在界面明确写「团队不可用（原因），使用进程内执行器」。
- 界面新增派发状态条：模式（团队/进程内）、Lead、每组执行者与状态（等待/进行中/完成/失败）、错误原因。

### 16.2 清除的第二种情况：应用 / 环境 → 卸载而不是删目录

`core/uninstall.js` 做纯识别，覆盖 `snap` / `flatpak`（`~/.var/app`）/ `conda env` / `nvm` / `pyenv` / `/opt`：
命中时该条目**不进入删除执行器**，而是转入计划的 `uninstall` 列表，带官方卸载命令与原因
（例如 `flatpak uninstall org.mozilla.firefox`、`conda env remove -n torch`）。
计划弹窗里单独一块展示，命令可一键复制 —— **命令不会被自动执行**。

这里踩到一个顺序坑并修掉了：卸载判定必须排在"规则是否允许直接删"**之前**。
很多应用目录根本没命中规则（默认 `manual`），先按 `manual` 拒绝就永远走不到卸载建议。

### 16.3 测试

113 → **140 项**。新增：派发清单（一类一组、restart 不派发、writeScopes、提示词点名工具与计划、
提示词禁止动清单外内容）、工具鉴权（本组放行 / 跨组拒绝 / 未派发模式拒绝 / 无计划拒绝）、
完成闸门（已完成立即返回、超时返回失败不挂住）、逐类派发的调用顺序与 `blockedBy` 成链、
某类失败不中断后续、卸载识别（6 类 + 不误判缓存）、`plan.uninstall` 不进删除项。

### 16.4 待验证（需要你在重启后跑一次）

- 团队派发这一路**没有在真实团队上跑过**（插件模块要重启才加载，而我不能重启自己所在的会话）。
  逻辑用假团队对象覆盖了（spawn→建任务→指派→等完成→标完成），但真实的 `spawnTeammate` /
  `updateTask` 的 revision 语义只能实跑确认。**如果团队这一路失败，会自动降级为进程内执行器**，
  所以不会卡住，只会在派发状态条里显示原因。
- 视觉与交互仍需你刷新后确认。

---

## 17. r7 修订（2026-10-19 第三批反馈）

### 17.1 「说明」显示错的问题（真 bug + 文案重做）

你看到的"都显示未识别出它属于哪个软件…"来自兜底规则文案，它出现在两个本来不该出现的地方：

- **分区根目录**（例如 `/media/user/Data Disk`）本身没命中任何规则 → 显示兜底文案。现在按上下文生成：
  `这里是「数据盘 /media/user/Data Disk」这个分区的根目录，已用 77%，剩余 102.0 G。下面列出的是它的各个顶级目录；点进具体目录（比如各类缓存、日志、软件数据）才能判断哪些可以清理。`
- **未命中规则的普通目录** → 现在带上本层摘要：
  `没有命中清理规则：可能是你自己放的文件，或者规则库还没收录的目录。这一层有 3 个目录、5 个文件（合计 12.4 MB）。展开看看内容再决定，不要整目录删除。`

命中规则的目录仍显示规则自己的说明（`noteKind: rule`），接口里带 `noteKind` 便于区分。三种情况都有测试。

### 17.2 界面按你的要求调整

| 要求 | 处理 |
|---|---|
| 快捷家目录/下载等不要展示 | 头部「快捷」胶囊整组移除 |
| 特殊要求改成弹窗、支持大段文字、展示该目录内容、支持 @ 文件且用颜色区分 | 清单里点「特殊要求」打开弹窗：多行 `textarea` + 该路径下内容的 `@` 插入按钮 + **实时预览**（`@路径` 用品牌色加粗，正文保持普通色） |
| 本层条目不展示"在资源管理器中打开" | 行内该按钮移除（「当前位置」卡片里的三个按钮保留） |
| 规则建议合并到本层条目、按标签筛选、盘根显示全部/深入只显示该路径下 | 两个页签合并成一个列表：直接子项 + 作用域内的规则建议（去重、建议项打推荐标记）；顶部标签胶囊 `全部 / 可安全删除 / 需你确认 / 建议保留 / 不可删除` 过滤；**盘根显示该盘全部建议，进入子目录后只显示该路径下的** |
| 扫描要展示动画 | 扫描中在容量条下方显示不确定进度条（CSS 动画）+ 按钮变 `⟳ 中断扫描`；顺带修了"首次扫描状态进不来"的问题（首扫时 snapshot 里还没有该目标，事件被丢） |
| 右上角设置按钮 + 弹窗配置"其余小文件/大文件"等参数 | 头部 `⚙ 设置`：大文件阈值、目录展开阈值（低于它折进「其余小文件」）、候选下限、扫描深度、每层保留子目录数、每目录展示大文件数、并行执行者数；**保存后写到 `<stateDir>/settings.json`，不动 profile**，启动时读回，界面提示"需要重新扫描才生效" |

### 17.3 测试与状态

- 测试 140 → **143 项**（新增：分区根说明、未命中规则的上下文说明、命中规则仍用规则说明）。
- **浏览器视觉验证仍未完成**：browser-skill 扩展目前没连上（`browser_session start` 报 `no browser is currently connected`）。
  需要你在 GUI 页面里打开 browser-skill 扩展、等弹层显示 `connected`，我才能实际打开页面核对渲染。
- 以上改动仍需 `systemctl --user restart dsh` 后生效。

---

## 18. 空白界面修复（2026-10-19）

**现象**：重启后打开面板，整个页面空白。

**根因**：r7 把"规则建议合并进本层条目"的两个 `useMemo` 插到了
`const candidates = (cand && cand.candidates) || []` **之前**。`const` 有暂时性死区，
组件在渲染时直接抛 `ReferenceError: Cannot access 'candidates' before initialization`，
插槽条目崩溃 → 整个面板渲染为空（`node --check` 只查语法，抓不到这种问题）。

**修复**：把 `candidates` / `selectable` 的声明移到使用它们的 `useMemo` 之前。

**新增回归测试 `tests/render.mjs`**：不再只做语法检查，而是**真正跑一遍组件渲染**。
做法是不依赖浏览器——把 `client.js` 在 `vm` 沙箱里求值，取出 `__ModuleLoader__` 注册的工厂，
用一个极简 React 替身（`useState/useMemo/useCallback/useEffect/useRef/Fragment/createElement`）
渲染，并通过"按源码顺序索引 `useState` 名字 + 调用 setter 再重放渲染"的方式**灌入真实形状的数据**。

覆盖 9 项：
1. client.js 能在沙箱求值并注册模块（id 正确）
2. 工厂返回 `apply` 且声明注入 `slots`
3. 注册了 `main` 与 `sidebar.panellist`
4. 面板组件存在
5. **首屏渲染不抛异常**（`snapshot` 为 null 的最早时机 ← 这次就死在这一步）
6. **灌入数据后重渲染不抛异常**（树块 / 本层条目 / 底部清单表都真的渲染出来了）
7. 扫描中会渲染动画条
8. 计划 / 二次确认 / 特殊要求 / 设置四个弹窗都能渲染，且 `@` 引用被着色
9. 侧栏图标跟随 `size`

以后每个改客户端的回合都跑这两个：
```bash
node tests/smoke.mjs     # Host 侧 143 项
node tests/render.mjs    # 客户端渲染 9 项
```

**仍需重启 + 硬刷新**：客户端 bundle 按进程/rev 缓存，改完必须 `systemctl --user restart dsh` 再 Ctrl+Shift+R。

---

## 19. UI 元素与配色审计（2026-10-19）

浏览器不可用（见 §19.3），所以改成**有数字依据的静态审计**：新增 `tests/ui-audit.mjs`，
从宿主主题包里解析出真实的明/暗色 token 值（不是猜的），对每一处"文字压在背景上"算 WCAG 对比度，
再核对元素/样式一致性。

### 19.1 查出的真问题

| # | 问题 | 证据 | 处理 |
|---|---|---|---|
| 1 | **深色模式下主按钮/选中页签是白字压白底** | 宿主 `body[data-ds-dark-theme]{--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50)=#f9fafb}`，而我的 `.gm-btn.gm-primary{background:brand;color:#fff}` → 对比度 **1.03:1** | 改用自有成对变量 `--gm-accent` / `--gm-on-accent`：明 `#2563eb`+白（5.17:1）、暗 `#60a5fa`+`#0b1220`（7.36:1） |
| 2 | 色块白字对比度不足 | 原色板里 `#16a34a`=3.30:1、`#d97706`=3.19:1；白字 88% 透明度更低（2.8–4.3）；百分比 72% 只有 2.35–3.9 | 12 个色阶全部换成 700–900 阶（绿 5.02/7.13/9.11、琥珀 5.02/7.09/9.07、石板 7.58/10.35/14.63、红 6.47/8.31/10.02），**色块文字改为纯白**，层级靠字号/字重 |
| 3 | 第三级文字（`.gm-t3`）浅色下看不清 | `label-secondary` 再降透明度到 72% → **3.18:1** | 去掉透明度（`label-secondary` 本身 5.8:1 / 暗色 12.1:1），层级用字号 |
| 4 | 触摸设备上行内按钮永久不可见 | `.gm-mini{opacity:0}` 只在 `:hover` 显示 | 加 `@media (hover:none),(pointer:coarse){.gm-mini{opacity:1}}` |
| 5 | 行内小按钮点击目标偏小 | 估算 22px < WCAG 2.2 的 24px | `min-height:24px` + `inline-flex` 居中 |
| 6 | `.gm-list` 样式缺失 | 计划弹窗的"跳过清单"没有边框/内边距 | 补上定义 |
| 7 | 树块只能鼠标点 | div 无 `role`/`tabIndex` | 加 `role="button"`、`tabIndex:0`、Enter/Space 触发、`:focus-visible` 描边 |

### 19.2 审计结果（每次改动都跑）

```
36/37 → 37/37 对比度与一致性全部通过
  · 12 个色块：白字 5.02–14.63:1
  · 明/暗 × 三层背景的正文与次要文字：5.8–18.9 / 9.25–17.45
  · 主按钮、@ 引用、危险按钮：5.17 / 5.17 / 6.47（明）· 7.36 / 5.48 / 6.47（暗）
  · 回归检查：不再出现 brand+白字、选中页签不再用会翻转的填充、t3 不再降透明度
  · 59 个 className 全部有样式；字号 ≥11px；触摸兜底与 24px 点击目标就位
```
（中间那次 36/37 的失败是审计脚本自己把模板字符串里的 `${...}` 截断导致误报，已修。）

### 19.3 浏览器为什么不可用、你怎么帮我

`browser_session` 报：`no browser is currently connected (hint: open the browser-skill extension in your browser and wait for the popup to show "connected")`。
也就是说 **browser-skill 扩展没有连到这个 Harness**，我无法打开页面看渲染。

帮我连上（任选一种）：

**A. 连扩展（推荐，之后我能自己看）**
1. 在**服务器桌面**的浏览器里打开 `http://localhost:3080/` —— 用 `~/dsh/loopback-url.sh` 打印的带 token 地址。
   必须走 **loopback**：BrowserSkill 校验 Host 头必须是 localhost/127.0.0.1，公网地址会被拒。
2. 点浏览器工具栏里的 **BrowserSkill 扩展图标**，等弹层显示 **connected**。
3. 保持该标签页开着，回来跟我说一句"连上了"，我就直接打开页面、截图、核对明暗两套配色。

**B. 直接给我截图**
把侧栏/面板截图作为附件发我（我能读图片），并说明是明色还是暗色。我会按截图核对间距、对齐、颜色与遮挡。

**注意**：以上修复仍需 `systemctl --user restart dsh` + Ctrl+Shift+R 才生效；重启后启动日志里的 `dryRun=false` 可顺手核一眼。

---

## 20. 真实浏览器 + 视觉模型评审（2026-10-19）

浏览器这次连上了（借用了你已登录的 GUI 标签页），并用**带视觉的模型**（`deepseek/deepseek-v4.1-flash`，声明了 `input: [text, image]`）
派子代理做了**三轮像素级评审**。当前模型不支持图片输入，所以这是我这边看图的办法。

### 20.1 评审抓到的真问题（都已修）

| 问题 | 证据 | 修法 |
|---|---|---|
| **主按钮/选中页签深色下白字压白底** | 宿主 `--dsw-alias-brand-primary` 在暗色 = `#f9fafb`，我拿它当填充 + 白字 → **1.03:1** | 自有 `--gm-accent` / `--gm-on-accent` 成对变量（明 5.17:1 / 暗 7.36:1） |
| 色块白字对比度不足 | `#16a34a` 3.30:1、`#d97706` 3.19:1、白字 88% 透明度 2.8:1 | 12 级色阶换到 700–900 阶（5.02–14.63:1），**色块文字纯白** |
| **树图配色有语义 bug** | 同风险按序号轮换三档深浅，看起来像不同类别；且这块盘顶层全是"需你确认"，整片橙 | 改**一风险一色**；块间靠 2px 间隙与描边分隔 |
| 树图出现 2px 无文字碎片 | 截图实测 5 个无字块，最小 9×10px | 按**占比 <1.5%** 折叠成「其他 N 项」聚合块，聚合块降低文字门槛 |
| 未选中胶囊 3.27:1、占位符 3.40:1 | 我原来用 `opacity:.38` / `.75` 表达"未选中/占位" | 改为实线边框 + 次要文字色，不降透明度 |
| 进度条轨道 1.19–1.40:1 | 轨道用 `layer-2`/`border-l1`，压在卡片上几乎看不见 | 新增 `--gm-track`（明 `#c9ced6` / 暗 `#7a7a80`，≥3:1） |
| 禁用态主按钮文字 2.58:1 | 整体 `opacity:.45` | 禁用态单独换 layer-2 底 + 次要文字（9.25:1） |
| 卡片头分隔线错位 5px | 两卡内容高度不同 | `.gm-cardhead` 固定最小高 42px |
| 控件高度不一（24/26/28/30） | `box-sizing` 不一致（button border-box、span content-box） | `.gm-root *{box-sizing:border-box}` 后统一 28px |
| 滚动条带 ▲▼ 按钮 | 同时写了 `scrollbar-width:thin` 与 `::-webkit-scrollbar`，Chromium 优先前者、忽略后者 | 去掉 `scrollbar-width`，细条样式生效 |
| **文案缺 18 个词条**（设置弹窗/特殊要求弹窗显示原始 key） | 自动比对 `t('…')` 与 zh/en 字典发现的 | 补齐；审计脚本加**文案完整性检查**（133 键全部有词条） |
| 筛选胶囊换行、"不可删除"被挤到第二行 | 估算需 428px、可用 404px | gap 6→4、padding 10→8，一行放下（实测 5 个胶囊间隔 5px，右侧余 21px） |
| 底部条中间 697px 空白 | 无摘要 | 0 选中显示引导文案，否则显示"已选 N · 体积 · 并行执行者" |
| 说明/操作按钮被卡片底边裁 | 当前位置卡 42% 高度不足 | 元信息压成一行、说明限 2 行、卡片 50%，四个按钮完整可见 |
| 子项说明全是同一句"未识别出它属于哪个软件…" | `listDirectory` 对未命中规则的子项也返回兜底文案 | 子项未命中规则时**不再给说明**（当前目录的说明另有上下文生成） |
| `lost+found` 被当成候选项 | 规则没覆盖 | 新增规则：`blocked`，属文件系统保留区 |
| 0 字节目录显示"体积未知" | `pct(0, total)` 返回 null | 修 `pct` 逻辑，显示 `0.0%` |

### 20.2 现在的验证手段（三层）

```bash
node tests/smoke.mjs      # Host：143 项
node tests/render.mjs     # 客户端渲染：9 项（沙箱 + 假 React + 播种重放）
node tests/ui-audit.mjs   # 配色/文案/一致性：52 项（从宿主主题包解析真实 token 算 WCAG）
```
再加：**真实浏览器 DOM 观察 + 视觉模型像素评审**（截图交给 `deepseek-v4.1-flash` 子代理）。

### 20.3 评审结论

第三轮视觉终验：四项修复全部达成、对比度达标、**"可以交付日常使用"**；第四轮又收掉了它指出的
"卡片底部 2px 字头残渣 / 树图底部数字被切 / 图例点与列表点不同色 / '其他'块与'建议保留'撞色"。
最后剩下的只是可滚动列表的正常截断与观感偏好，不是缺陷。

### 20.4 注意事项

- **客户端改动刷新页面即生效**（宿主会重建客户端 bundle），**Host 侧改动（`ls.js` / `rules.js` / 设置路由）仍要重启 dsh**。
  在重启前，⚙ 设置按钮会提示"设置路由还没生效，请重启 dsh"，子项说明仍是旧文案。
- 浏览器标签页是从你的会话借用的，用完已归还。

---

## 21. r9 修订（2026-10-19 第四批：路径解释 + 布局与用语）

### 21.1 路径解释：规则优先 → LLM 推测 → 低把握才联网

新增 `host/explain.js`，按你定义的两种来源分工：

| 路径类型 | 来源 | 说明 |
|---|---|---|
| 系统类（规则能命中的） | **规则** | 零成本、离线、结论稳定；"这是系统目录不能动"/"这是 temp 可以删"直接给 |
| 其余（个人文件、项目、软件数据） | **LLM 推测** | 一次批量解释一整层；模型自评 `confidence` |
| LLM 把握不足（<0.6） | **联网搜索** | 用路径名搜一次，把检索结果再交给模型重写；每层有搜索次数预算 |

成本控制（按你的要求）：
- **逐层惰性**：只解释"当前这一层"，不预先解释整棵树；
- **默认只自动解释前两层**（根 + 直接子项）；进入第 2 层才解释下一层；
- **每层一次批量调用**，结果**按路径缓存**（`<stateDir>/explain-cache.json`，键含规则包版本 + 模型 + 提示词版本），回看零成本；
- 设置里可配：自动解释层级（0=关）、每层最多几条、每层联网次数、是否允许联网。

接口：`POST /api/explain { entries: [{path,isDir,size}] }` → `{ results: {path: {text, source, confidence}}, used }`；
只接受落在已注册目标内的绝对路径。

### 21.2 界面修正

- **「当前位置」的解释不再被遮住**：卡片改成"头 + 可滚动内容 + **固定在卡底的操作行**"，解释完整显示（去掉 2 行截断）；
- **底栏加常驻搜索框**（`搜索清单…`），直接过滤选择清单；展开区里那份重复的搜索框删掉；
- **本层条目显示子项解释**：每行一行截断的解释（AI/规则），鼠标悬停 `title` 看全文；
- **术语统一**：动词统一用「清理」（操作项 = 清理 / 打包 / 整理），删掉与操作下拉重复的「加入清理清单」按钮，只留下拉（默认清理）；
- **删掉开发解释性措辞**：如"（不跟进，避免绕圈）"、悬停里的"……都不会被计入体积"，树图提示也改成用户视角的
  「较大目录按体积铺开，其余合并为「其他 N 项」」。

### 21.3 验证

```
node tests/smoke.mjs      → 160/160   （新增 17 项：层级/深度门控/解析/越界丢弃/缓存键/规则优先/批量/低把握联网/关掉联网/缓存命中/模型不可用）
node tests/render.mjs     →   9/9     （这次又靠它抓到一处 TDZ：新 effect 引用了后面才声明的 config）
node tests/ui-audit.mjs   →  59/59    （新增 7 项：固定操作行、无开发措辞、术语统一、无重复按钮、底栏搜索、解释行样式、解释设置项）
```
真实浏览器 DOM 复核：图例/提示/术语/固定操作行/树图 7 块 + 「其他 12 项」均按预期渲染。

### 21.4 注意

- **Host 侧改动要重启 dsh 才生效**：`/api/explain`、设置新键、`ls.js` 的子项说明、`exec.js` 的分组名。
  重启前：解释接口静默降级（行内仍显示规则文案）、⚙ 设置会提示"路由还没生效"。
- 客户端改动刷新页面即生效。

---

## 22. r10 修订：审计身份、审计入口、日志清理

### 22.1 审计里补上"谁执行的"

以前审计只记执行器内部工号（`pool-worker-1`），**看不出是哪个执行者被授权做的**。
现在派发路径会把 teammate 名字带进执行器：

```js
actorName('gc-clean', 'pool-worker-1')  // → 'gc-clean/pool-worker-1'
actorName(null, 'pool-worker-2')        // → 'pool-worker-2'（进程内执行）
```
下次派发执行的审计记录会写成 `gc-clean/pool-worker-1`，一眼能看出"哪个 teammate + 哪个工号"。

### 22.2 报告/日志从底栏搬到右上角「审计」

底栏以前会渲染运行报告、分片进度、日志、审计文件路径，**收不起来、挤占界面**。现在：

- 右上角新增 **🗂 审计** 按钮（与 ⚙ 设置 并列）；
- 审计弹窗列出**历史清理记录**（`GET /api/audit/list`）：演练/真实、时间、项数、实际回收、状态、失败数、计划 id；
  点开某一次 → 逐条列出被删路径 + 字节 + **执行者身份** + 命中规则号，打包与去重结果也一并展示；
- 底栏只保留：折叠栏（清单 + 搜索 + 提交）、**运行中的实时进度**、以及一行"报告已移到审计"的提示。

### 22.3 设置里能清理日志

`POST /api/audit/prune`（`host/audit.js` 的 `pruneAudit`）：
- 「日志保留最近几次」= N（默认 50）；
- 可选「同时清空解释缓存」；
- 只删除本插件自己的 `~/.dsh/garbage-master/audit/*.jsonl`，**不碰任何用户数据**；
- 两个条件都不给时不动任何文件（返回 `nothing-to-prune`）。

### 22.4 验证

```
node tests/smoke.mjs      → 171/171   （新增 10 项：actor 标签、审计 delete 带 actor、
                                       历史倒序、含删除条目/执行者/字节/磁盘变化、dry-run 可区分、保留 N 次、零条件不动文件）
node tests/render.mjs     →  10/10    （新增：审计弹窗渲染历史删除记录 + 执行者身份 + 被删路径）
node tests/ui-audit.mjs   →  65/65    （新增 4 项：审计弹窗样式、右上角入口、设置里的日志清理、报告/日志已移出底栏）
```

---

## 23. r11 修订：弹窗层级、解释失败诊断、解析兜底

### 23.1 审计弹窗被设置弹窗盖住（真 bug）

所有弹窗都用 `.gm-overlay{z-index:1000}`，堆叠顺序由 DOM 顺序决定；而 `auditModal` 挂载在 `settingsModal` **之前** →
从设置里点「审计」时，审计弹窗在设置后面。修复：
- 把 `auditModal` 挪到弹窗列表**最后**（DOM 顺序决定在上层）；
- 另外给它 `.gm-overlay-top{z-index:1100}` 作为保险。

### 23.2 解释失败不再一律说"需重启 dsh"

以前任何解释失败都显示同一句 `解释服务未就绪（重启 dsh 后可用）`，把三种完全不同的原因混在一起。现在按真实原因分开：

| 失败原因 | 提示 |
|---|---|
| `bad-token` | 页面令牌已过期（dsh 重启过），刷新即可恢复 |
| `no-such-route` / HTTP 404 | 解释服务未就绪（重启 dsh 后可用）—— 真的是路由没上线 |
| 其他（`llm-unavailable` / `no-model-selected` / `not-json` …） | **解释失败：<真实错误码>**（悬停看完整信息） |

### 23.3 模型没按 JSON 输出时的兜底 + 重试 + 诊断落盘

- **兜底解析** `salvageLineFormat`：模型啰嗦成 `- /path: 说明` 这种逐行格式时也能救回来（仍然只接受清单内路径）；
- **严格重试一次**：第一次解析失败后，用"只输出 JSON 数组、不要任何解释文字"的系统提示再问一次；
- **诊断落盘** `<stateDir>/explain-last.json`：记录最后一次解释的时间、路径、成功与否、错误码、**模型原始输出片段**——
  这样"解释为什么没出来"可以直接看文件，而不是猜。

### 23.4 验证

```
node tests/smoke.mjs     → 176/176  （新增 5 项：逐行兜底、兜底也丢弃清单外路径、salvaged 标记、
                                     失败时保留原始片段、坏 JSON 严格重试一次后成功）
node tests/render.mjs    →  11/11
node tests/ui-audit.mjs  →  73/73   （新增 4 项：审计弹窗最后挂载、更高 z-index、真实错误提示、诊断落盘）
```

---

## 24. r12 修订：解释输出改成逐行格式 + 层级语义修正

### 24.1 `not-json` 的真实原因：模型返回了**空文本**

诊断文件 `explain-last.json` 给出的关键证据：

```json
{ "paths": ["/media/user/Data Disk/动漫/anime"], "error": "not-json",
  "snippet": null, "used": { "llm": 2, "web": 0 }, "got": 0 }
```

`snippet: null` 说明模型**没吐任何文本**（不是"格式不对"），而旧提示词只接受 JSON 数组，
一旦输出为空或带前言，就只能报 `not-json`。修复：

1. **提示词改成逐行格式**：`路径 | 一句中文说明`，明确"不要 JSON、不要代码块、不要前言、路径原样照抄"；
   实测同一模型（`deepseek/deepseek-v4.1-flash`）完全照做，且路径里的空格也原样保留；
2. **解析顺序**：先按行解析（`format:'lines'`），JSON 仍兼容（`format:'json'`）；
   带空格的路径用"已知路径前缀匹配"而不是按分隔符切，避免把 `/media/user/Data Disk/动漫` 切坏；
3. **空输出单独归因**：`empty-output`（附收到的 chunk 类型统计）与 `unparseable`（附原始片段）分开，
   不再混成 `not-json`；诊断文件同时记录 `chunkTypes`，下次一眼能看出是流里没文本还是有别的块类型。

### 24.2 站在第三层时"本层条目没有解释"

诊断里 `paths` **只有当前目录、没有子项**——因为旧逻辑把 `levelOf(current) + 1 <= explainDepth` 当硬上限，
站在第 3 层时子项（第 4 层）就被跳过了。语义修正为：

> **站在哪一层就解释那一层的子项**（逐层惰性、进入才解释）。`explainDepth` 只当开关（0=关闭）。

这样既满足"到哪儿解释到哪儿"，又不会一次性解释整棵树（成本仍由惰性 + 缓存控制）。
设置项也改名为「自动解释本层子项（0=关闭）」。

### 24.3 验证

```
node tests/smoke.mjs     → 181/181  （新增 6 项：行格式标记 format=lines、JSON 仍兼容、
                                     空输出归因 empty-output、带空格路径不被截断、
                                     线上真实模型输出逐条命中、层级语义）
node tests/render.mjs    →  11/11
node tests/ui-audit.mjs  →  73/73
```

---

## 25. r13 修订：把"模型吐空"从根上绕过去

### 25.1 现象与证据

`explain-last.json`：`error: "empty-output"`、`snippet: null`、`paths` 20 条（实际请求 40 条，`/home/user/.agent` 那一层）。
即：**一次问 40 个路径，模型一个字的正文都没吐**（不是格式问题）。

### 25.2 四个修复（不依赖"下次再复现"）

1. **分批**：默认每批 12 条（`explainBatchSize` 可调），一批吐空不会拖垮整层，其余批次照常返回解释；
   部分批次失败记为 `partialErrors`，**不会**用错误提示盖住已经拿到的解释（整层失败才报错）。
2. **吐空专门重试**：`empty-output` → 换成**极简提示词**（只给路径清单、只要求"路径 | 说明"）+ 输出预算提到 3000，
   针对"推理块吃掉输出预算"这种最常见成因。
3. **流式块形状兼容**：正文可能以 `text-delta` / `text` / `delta` / `content` / `output_text` /
   OpenAI 风格 `choices[].delta.content` 到达，现在都能取到（以前只认 `text-delta`，provider 一换形状就全空）。
4. **诊断补全**：`explain-last.json` 现在记录 `chunkTypes`（收到过哪些块），下次一眼能区分"流里没正文"与"块形状不认得"。

### 25.3 验证

```
node tests/smoke.mjs     → 188/188  （新增 7 项：25 条自动分 3 批、分批后条条有解释、
                                     吐空→极简重试成功、三种流式形状都认、
                                     部分失败仍返回结果、部分失败不标整层错误、partialErrors 记录）
node tests/render.mjs    →  11/11
node tests/ui-audit.mjs  →  73/73
```

---

## 26. r14 修订：解释加载态 + 结合目录内容做解释

### 26.1 前端：正在解释的路径有明确加载态

以前只有卡片头一个全局转圈，用户不知道**哪一条**在解释。现在三处都标出来：

| 位置 | 表现 |
|---|---|
| 本层条目行 | 名称后面一个小转圈（`gm-spin-sm`），解释位置同时显示「正在解释…」占位 |
| 矩形树图色块 | 右上角小转圈 + 描边脉冲（`.gm-tile.pending`） |
| 当前位置卡 | 说明位置显示「⟳ 正在解释…」，与已有的卡片头转圈呼应 |

数据来源：请求发出时把这一批的路径记进 `explainPending`，回来（成功或失败）清空；只影响视觉，不影响逻辑。

### 26.2 后端：解释不再只看路径名，而是先"看一眼里面有什么"

新增 `probeDirectory(dir, {maxEntries})`：**单层** `readdir`（不递归、不跟符号链接），取最多 N 个
孩子的名字/类型/大小（目录优先、名字短的优先），失败即放弃这一项。

提示词里每条从 `路径 | 类型 | 字节 | 父目录` 扩展为 `… | 内含37项：code/, data/, docs/, …`，
并明确要求"**结合内含的文件名/类型判断，不要只看目录名**"；极简重试版同样带内含。

**实测效果（同一模型 `deepseek-v4.1-flash`）**：

| 路径 | 只给路径名 | 结合内含 |
|---|---|---|
| `/home/user/.agent` | 猜不出 | **agent 智能体主目录，含配置、日志、插件、QQ 机器人与多个工作区** |
| `…/.agent/agents` | — | **智能体角色定义，含 main、reviewer、scribe 三个角色及索引** |
| `…/.agent/workspace` | — | **智能体工作区，含人格设定、记忆、项目、技能与待办文件** |

成本：只读且单层——每个目录 1 次 `readdir` + 最多 N 次 `stat`（默认 N=12，`explainSampleEntries` 可调）；
**缓存命中的请求不取样**（不会为已经解释过的目录做多余 IO）。

### 26.3 验证

```
node tests/smoke.mjs     → 197/197  （新增 9 项：取样条目数/类型/大小、truncated、目录不存在返回 null、
                                     提示词带内含、极简版也带内含、解释前确实取样、取样后仍正常返回）
node tests/render.mjs    →  12/12   （新增：解释中的条目渲染转圈 + "正在解释…"占位 + 树块 pending 状态）
node tests/ui-audit.mjs  →  77/77   （新增 4 项：小转圈样式、树块 pending、条目行占位、提示词带内含）
```

> 过程备注：这一轮有一次补丁**静默没生效**（树块 className 是数组拼接，不是模板串），
> 被 render 测试逮住（"树块没有解释中状态"）。此后所有关键替换都加了锚点断言。

---

## 27. r15 修订：解释失败的真正根因（`finish` 块被忽略 + 未用 prepared call）

### 27.1 上一版为什么没修好

r13/r14 的修复都是**基于猜测**（分批、块形状兼容），没有触及根因。读了 `@deepseek-ai/dsh-llm` 的契约后
才看清两件事：

1. **失败不是抛异常，而是终止性的 `finish` 块**：

   ```ts
   type StreamChunk = … | { type:'finish'; reason: FinishReason; replayState? }
   type FinishReasonMap = { 'stop'; 'tool-calls'; 'max-tokens';
                            'aborted': { failure: LlmFailure }; 'error': { failure: LlmFailure } }
   ```
   文档原话：*"An adapter implementation may throw, but `LlmRuntime.stream()` normalizes that failure to a
   terminal `error` or `aborted` finish before exposing it to consumers."*

   而我的循环只处理 `text-delta`，**`finish` 被整条忽略** → 任何失败（provider 报错、被中断、预算耗尽）
   都表现为"模型吐空"，真实错误被吞掉。这就是一直查不到原因的地方。

2. **官方调用路径是 `llm.prepareCall(provider, model).stream(options)`**，不是直接 `llm.stream(options)`：
   `prepareCall` 返回 `{ model: LlmResolvedModelInfo, stream() }`，"锁定 adapter 代际与已解析的模型元数据
   （连接事实、调用默认值）"。agent loop 与 compaction 都走这条。直连在某些 provider 上会因为
   动态连接事实未解析而以 `finish:error` 结束。

另外两个连带问题：诊断合并有 bug（失败响应在 `continue` 前没合并 `chunkTypes`，所以永远是 `{}`）；
`reasoning-delta` 的文本被当成正文拼进了结果。

### 27.2 本版修复

| 项 | 做法 |
|---|---|
| 读懂 `finish` | `describeFinish()` 把 `error`/`aborted` 的 `failure` 翻成一句人话（`llm-error: 上游 502 status=502`），`max-tokens` 单独标记 |
| 精确归因 | 空正文时依次判定：`finish` 原因 → `reasoning-only` → `no-text-in-stream` → `empty-stream`；异常另记 `thrown: …` |
| 走对路径 | 优先 `prepareCall().stream()`，失败回落直连，诊断记 `via:prepared` / `via:direct-after-prepare-failed:…` |
| 重试阶梯 | 预算耗尽/只剩推理/空流 → 极简提示词 + 4000 预算 → 仍只剩推理 → 追加"不要推理，直接给结论"（最多 3 次） |
| 不污染正文 | `pickText` 显式排除 `reasoning-delta`，只在 `block-end` 文本块上兜底 |
| 诊断补全 | 合并失败响应的 `chunkTypes`（含 `finish:*`、`reason:*`、`via:*`），并记录本次使用的 provider/model |

### 27.3 验证

```
node tests/smoke.mjs     → 213/213  （新增 16 项：finish:error/aborted/max-tokens 的翻译、
                                     reasoning 不进正文、provider 报错给真实原因、
                                     max-tokens 加大预算重试成功、纯推理走满三次阶梯、
                                     prepared 优先 / prepareCall 抛错回落 / 无 prepareCall 时直连）
node tests/render.mjs    →  12/12
node tests/ui-audit.mjs  →  77/77
```

> 教训记在这里：**不要用"猜测 + 重试"代替读契约**。上一版把 provider 的报错当成了"模型输出格式问题"。

---

## 28. r16：`signals[0] is not of type AbortSignal` — 我自己引入的 bug，并用真机验证

### 28.1 根因

r12 起 `host/http.js` 里写成了 `explainPaths(entries, null, force)`，`null` 被一路传到 `llm.stream(options.signal)`。
宿主 seam **严格校验**：`signal` 要么是真正的 AbortSignal，要么**整个键不出现**——传 `null` 直接抛
`signals[0] is not of type AbortSignal. code=UNKNOWN`，而它被规范成 `finish:error`（见 r15），
表现出来就是"模型吐空"。11:57 那 55 条成功记录是在写入 `null` 之前跑的。

**为什么没测到**：单测里的假 LLM 忽略 `signal`，真 seam 的校验触发不到。这是我的测试设计问题。

修复：新增 `host/signal.js`（`optSignal` / `withSignal`），**所有跨 seam 的调用**统一规范化——
非法值直接**删掉这个键**；覆盖 `llm.stream`、`llm.prepareCall`、`web.search`、`plan-ai`，并在入口归一化。

### 28.2 用真机做的小规模测试（DSH 自带入口）

不再用假 LLM 自证。做法：另起一个实例（`dsh --profile web --port 0 --no-open`，随机端口、跑最新代码），
从它渲染的页面里取插件 token（`__GARBAGE_MASTER__`），直接打它自己的 `/garbage-master/api/explain`——
**真服务 + 真 LLM + 真代码路径**，测完按 PID 关闭，用户主实例不受影响。

结果：

| 用例 | 结果 |
|---|---|
| 3 个真实目录 | `ok=True error=None used={llm:1}`，3 条解释（20s） |
| **之前报错的那 13 项**（`…/That Time I Got Reincarnated as a Slime`） | **`ok=True error=None`，13/13 拿到解释**（14.4s）：`该动画剧集根目录，含第四季视频与各季海报等元数据`、`.plexmatch => Plex媒体库匹配用文本文件…`、`Season 4 => 第四季视频目录，含BeanSub&LoliHouse压制字幕组剧集` |
| 20 个真实目录 | `ok=True`，`used={llm:2,web:2}`（自动分 2 批），19 条解释 |
| `GET /api/settings` | `explainDepth=2 / explainMaxItems=40 / explainMaxSearches=2 / explainUseWeb=true` |
| `GET /api/audit/list` | 真实读出 `plan-7cb82d98d276`：1 项 / 33,720,693 字节 / `actor=pool-worker-1` / `rule=73` |
| `POST /api/explain {force:true}` | `ok=True`，联网兜底真的触发（`used={llm:1,web:1}`） |

诊断文件同时给出了真实的流内容：`chunkTypes={'block-start':2,'text-delta':116,'block-end':2,'usage':2,'finish:stop':2}`
——说明流是好的；另外发现 `prepareCall` 在这个 provider 上会抛 `signal?.throwIfAborted is not a function`，
于是改成**失败一次就记住、后续直接走已验证可用的直连**，诊断里不再刷噪声。

### 28.3 顺带修掉两个真机发现

1. **联网重写会把好答案改笼统**：实测 `tools` 从"内置 Node 运行时目录，含 v24 与 v22 版本"被改写成
   "参考资料未涉及该具体路径…"。现在只有 `confidence` 明显更高才覆盖原结果。
2. **严格契约回归测试**：单测里的假 LLM 现在**按真 seam 的规则校验 `signal`**（`null`/非 AbortSignal 直接抛），
   把这类"假 LLM 掩盖真契约"的漏洞堵上。

### 28.4 验证

```
node tests/smoke.mjs     → 215/215   （新增：signal null 不打到 seam、真 AbortSignal 原样透传、prepareCall 回落记录）
node tests/render.mjs    →  12/12
node tests/ui-audit.mjs  →  77/77
```

---

## 29. r17：解释提速（并行分批 / 分批推送 / 启发式短路）+ 思考强度 + 缓存加固

### 29.1 思考强度（`reasoningEffort`）

宿主 seam 有 `GenerateOptions.reasoningEffort`（adapter 自有取值）。本插件：
- **透传**：优先用设置里的值，否则用当前模型选择里带的 `reasoningEffort`；都没设就**不带这个键**（交给 provider 默认）。
- **设置界面**：新增「解释的思考强度」下拉，选项来自 `GET /api/explain-model`（内部用 `llm.resolveModelInfo(provider, model).reasoning.efforts`）。
- **真机实测**：当前模型 `commandcode / deepseek-v4.1-flash` **没有声明任何可调强度**（`efforts: 未声明`），
  所以现在**关不掉**；一旦换到声明了 efforts 的模型，下拉会自动出现选项。界面在无选项时给出说明文字。

### 29.2 三项提速（用户选定的 1/2/3）

| # | 做法 | 效果 |
|---|---|---|
| 1 | **分批并行**：`explainConcurrency`（默认 3，可 1–6），原来是串行一批批等 | 4 批从"4×单批"变成"2 波" |
| 2 | **分批推送**：每批完成即 `store.emit('explain-partial')`，前端 SSE 增量合并（`explainedRef` 同步标记） | **首屏解释提前到第一批完成时出现**，不再整层等完 |
| 3 | **启发式短路**：`FILE_HEURISTICS` 覆盖海报/字幕/元数据/压缩包/字体/临时文件等常见形态，文件级直接给答案 | 真机：动漫那层 13 项里 **11 项不再进模型** |

顺带：**联网搜索改并行**（原来串行，两项就多等好几秒）；联网重写提示词里"只输出 JSON"与 system"逐行输出"的**自相矛盾**也被修掉。

### 29.3 缓存加固（"上次有解释就不再生成"）

- 这本来就是行为（真机验证：同一批第二次请求 `used={llm:0}`、来源 `cache`）；
- 但做了两点加固：**缓存键去掉 model 维度**（换模型不该让已有解释失效）、**改成立即落盘**
  （原来 2s 防抖，进程重启会丢掉最近几条花钱换来的解释）；
- 只有设置里的「重新解释当前这一层」或请求带 `force` 才会重算（此时也**跳过启发式**）。

### 29.4 真机数据（含负面结论）

| 用例 | 结果 |
|---|---|
| 13 项媒体文件（动漫那层） | 11 项启发式 + 2 项模型；15.6s（大头是 2 次联网搜索 + 1 次模型调用） |
| 24 个目录 + force | 4 次模型调用 + 2 次搜索 = **14.0s**，过程中收到 **3 个 `explain-partial`** → 首屏提前可见 |
| 并发 A/B（同 24 项） | **测不干净**：单次调用波动 3.8–11s（并发1：7.6s/11 条；并发3：11.0s/23 条）。不声称并行带来固定倍数提升 |
| 缓存复用 | 同一批第二次：`used={llm:0}`、来源 `cache` |
| 思考强度查询 | `efforts: 未声明`（该模型不可调） |

### 29.5 验证

```
node tests/smoke.mjs     → 226/226  （新增：启发式识别/不猜目录、短路零调用、每批回调、
                                     并发受限 3 与严格串行 1、思考强度透传与"不设置则键不出现"、
                                     缓存键不绑模型、部分失败 partialErrors）
node tests/render.mjs    →  12/12
node tests/ui-audit.mjs  →  83/83   （新增 5 项：分批推送、启发式、并行分批、并行搜索、思考强度查询与设置项）
```

> 过程备注：这一版又出现一次**静默未生效**（SSE `explain-partial` 的补丁锚点猜错，前端根本没接上），
> 同样是被审计检查逮住。教训重复了两次，已把关键补丁全部改成"锚点断言 + 跑测试确认"。

---

## 30. r18：会话计划（用户定稿：B+C、两段式、按天复用会话）

### 30.1 机制（全部用宿主现成 Service）

| 能力 | 接口 |
|---|---|
| 绑定工作区 | `workspaceRegistry.list()/resolveByPath()/get()`；建会话传 `SessionCreateRequest.{workspaceId,cwd}` |
| 提交提示词 | `sessionController.prompt({requestId, sessionId, mode:'queue', content})` |
| 计划模式 | `planMode.set(agent,active)/get(agent)`（返回 `committed\|queued\|cancelled\|noop`） |
| 权限 | `permissionPresets.catalog()/set(session,name)`（`PresetSpec={sandbox,approval}`） |
| 可见通知 | `createUserMessage({source:{kind,form:'notice',summary}})` + `session.append('user/message', …, {surfaceOp:'append'})`（照抄 `dsh-plan-mode` 的写法） |
| 原始记录 | `session.append('plugin:garbage-master/explain', …)`（log-only）+ 另存 `<stateDir>/explain-records/<day>.jsonl` |
| 模型列表 | `sessionController.modelCatalog()` |

### 30.2 会话复用策略（`host/session-policy.js`，纯逻辑）

```
没有会话 → 新建；跨天 → 新建；上一轮动过文件（清理/打包/整理执行了）→ 新建；否则复用当天会话
```
状态落 `<stateDir>/session-policy.json`；会话不存在时自动回退新建。

### 30.3 流程

1. 勾选 → 点「生成执行计划」→ 程序拼 **Markdown 提示词**（`host/session-prompt.js`，非 LLM 生成）；
2. 绑定工作区的会话（按策略复用/新建）→ `planMode` 只读 → `prompt()`；
3. 等它产出 → 读 `.garbage-master/plans/<planId>.md`（读不到则取会话最后一条 assistant 文本）；
4. 面板渲染 Markdown → 二次确认 → `/api/session-execute`：退计划模式 + 放宽权限（挑最宽 preset）+ **同一会话**里按计划执行；
5. 计划同时落 `audit/session-plan-<planId>.json`，便于事后核对"计划了什么"。

### 30.4 明确的取舍

- 执行走**会话自己的工具**（用户定的"执行放宽"）→ **不再经过插件的路径租约与删前审计**；安全网只剩计划二次确认 + 会话日志 + 计划存档。
- 计划阶段可能耗时数分钟（完整 agent loop）；面板显示"会话正在生成计划…"，超时上限 240s。
- 解释仍是轻量一次性调用（B+C 中的 C：可见通知 + 完整记录），**不**变成会话回合，避免每次都跑 agent。

### 30.5 验证

```
node tests/smoke.mjs → 242/242  （新增：会话策略状态机、日期键、计划/执行提示词结构、解释通知摘要）
node tests/render.mjs →  12/12
node tests/ui-audit.mjs → 88/88 （新增 5 项：Markdown 渲染、会话路由、可见通知、设置项）
```
> 尚未做真机会话验证（会在用户侧侧栏创建会话）；等重启后用一个明确的工作区跑一次"计划"来验。

---

## 31. r19：已经解释过的路径不再"空转圈"

### 31.1 现场取证（浏览器技能 + 网络抓包）

- 单独测 `/api/explain` 缓存命中：**14–31 ms**（所以不是后端慢）；
- 但客户端每次进入目录都会为**整层**发一次 explain —— 即使每个答案都已在宿主缓存里；
- 转圈就是在等这个"本来没必要发"的往返；页面刷新后尤其明显（`explainedRef` 被清空）。

### 31.2 修法：让 `/api/ls` 直接带回解释

- `host/ls.js`：新增 `explainLookup` 入参，在 `self.explanation` 与每个 `child.explanation` 上带出**已缓存的解释**（没有则为 `null`）；
- `index.js`：`lookupExplanation(path)` 复用同一份 `explainCache` 与同一套 `cacheKey`；
- `client.js`：采用 `listing.explanation` / `child.explanation` → 直接填进 `explanations` 并写入 `explainedRef`，
  于是 `wanted` 里只剩**真正没解释过的**；`wanted.length === 0` 时**强制 `setExplainPending([])`**（修掉"提前返回导致转圈残留"的隐患）。

### 31.3 真机验收（隔离实例，`dsh --profile web --port 0`，未触碰用户主实例）

| 场景 | 结果 |
|---|---|
| 进入已解释过的 `动漫` | **explain 请求数 = 0**，解释立即显示（当前位置标记 `[缓存]`） |
| 进入 `动漫/downloads`（部分缓存） | 只请求 **5 个未缓存子项**（请求体 683 字节），父目录与已解释兄弟项都没重复请求；该请求 9.0s（真 LLM），转圈只出现在这 5 项上 |

### 31.4 验证

```
node tests/smoke.mjs     → 246/246  （新增 4 项：ls 带回当前目录/子项的缓存解释、无缓存为 null、不传 lookup 无字段）
node tests/render.mjs    →  12/12
node tests/ui-audit.mjs  →  92/92   （新增 4 项：前端采用 ls 解释、wanted 为空清 pending、Host 侧 lookupExplanation）
```

### 31.5 需要你做

```bash
systemctl --user restart dsh
```
Host（`ls.js` / `index.js`）与客户端都有改动，重启 + 刷新后生效。
