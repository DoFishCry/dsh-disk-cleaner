# dsh-disk-cleaner（GarbageMaster）

> **状态：开发中（WIP）—— 还没有可以直接安装使用的版本。**
> 这个仓库传到 GitHub，主要是为了在 **Windows 环境**下方便地拉取 / 修改代码；功能、接口、文件名都还在变，随时可能改动。
>
> **English:** Work in progress. This repo is published mainly so the code can be fetched and edited from a Windows machine. There is no installable release yet; interfaces and behavior will change.

---

## 这是什么

一个跑在 **DSH（DeepSeek Harness）** Web 界面里的磁盘清理控制台：

**扫描 → 看风险分级与解释 → 勾选 → 计划预览 → 二次确认 → 执行 → 审计留痕**，全程不用敲命令。

设计上最核心的一条：**删什么由人决定，模型不参与"选什么该删"**。模型只负责解释与生成计划，执行集合 = 用户勾选 ∩ 规则判定，并靠四层护栏（规则档位 / 计划校验 / 二次确认 / 审计日志）兜底。

## 仓库名 ≠ 包名

| | 名字 |
|---|---|
| GitHub 仓库 | `dsh-disk-cleaner` |
| 产品名（界面里显示） | GarbageMaster |
| 插件包名 | `@local/dsh-garbage-master` |

包名是装进 DSH profile 的模块标识（`cordis.patch.yml` 里引用它），改掉会让现有安装失效，所以暂时和仓库名不一致。以后要发布到 npm 再统一。

## 平台：仅 Linux

扫描依赖 `/proc/self/mounts`，"在文件管理器里显示 / 用默认程序打开"依赖 `xdg-open` 与 dbus `org.freedesktop.FileManager1`。

**Windows 上只能读代码、改代码，插件本身跑不起来。**

## 现在有什么 / 还没有什么

**已经能做：**
- 只读扫描：单遍遍历、自底向上剪枝、**不跨挂载点**、**不跟进符号链接**、含隐藏文件，进度实时回传
- 规则解释：每条候选给四档风险（可安全删除 / 需确认 / 建议保留 / 不可删除）+ 处置方式 + 一句人话说明
- 矩形树图：面积即体积，可下钻、面包屑、按风险着色过滤
- 当前位置面板：走 `/api/ls` 实时列目录，目录体积可单独度量
- 手动指定任意项加入清理清单（服务端仍拒绝 `blocked` 与受保护路径）
- AI 计划（可选，可降级为确定性清单）、执行器（租约互斥 + 审计）、卸载识别

**还没有：**
- 可安装的发布包 / 正式版本号
- Windows 支持
- CI、完整用户文档、截图

> 开发过程中的修订记录（r1–r22）在 [docs/dev-log.md](docs/dev-log.md)；设计基线在 [docs/design.md](docs/design.md)。这两份都是内部资料，不是用户手册。

## 目录结构

```
index.js             插件入口（Host 侧）：挂载 HTTP 路由、会话桥、状态机
client.js            Web 侧：侧栏面板（树图 / 当前位置 / 清单 / 计划 / 审计）
cordis.patch.yml     DSH 的 cordis 补丁：把插件插进 profile
core/                纯逻辑：规则库、磁盘模型（候选推导 / 删除 / 租约）、卸载识别
host/                Host 适配：扫描、ls、计划、执行、打包、去重、解释、会话桥、审计
locale/              中英文文案
docs/                设计基线（design.md）与开发日志（dev-log.md）
tests/               冒烟测试 / 渲染测试 / UI 审计
icon.svg             插件图标
```

## 跑测试

需要 Node ≥ 20，在仓库根目录执行：

```bash
node tests/smoke.mjs      # 规则 / 扫描 / 候选 / 计划 / 执行 / 租约（只用临时目录，不碰真实磁盘）
node tests/render.mjs     # 用假 React 真跑一遍客户端渲染，抓"打开面板一片空白"这类问题
node tests/ui-audit.mjs   # 配色对比度 + 元素一致性审计（不需要浏览器，但需要宿主主题包）
```

`ui-audit` 会自己找 `@deepseek-ai/dsh-client-ui-theme`（装过 DSH 的机器通常能找到）；找不到就显式指定：

```bash
DSH_THEME_PATH=/path/to/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js node tests/ui-audit.mjs
```

## 装到 DSH 里（仅限 Linux，开发用）

插件走 DSH 的 bundle 安装：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，用 profile 的 `install_bundle` 装进 `web` profile，然后重启 dsh：

```bash
systemctl --user restart dsh
```

（安装细节随 DSH 版本变化，暂不保证可复现。）

## ⚠️ 会真删文件

默认走**永久删除**（不是移到回收站）。虽然有四层护栏，**也不要在生产机器或有重要数据的机器上随手点确认**。先看清风险档位、先量体积、再勾选。

## 许可证

本项目按 **CC BY-NC 4.0**（署名 — 非商业性使用 4.0 国际）发布，**禁止商业使用**，详见 [LICENSE](LICENSE)。

> 注：CC 许可并非软件专用许可（不含专利授权，NC 的边界也需要个案判断）。作者选择该许可是明确的；如需商业授权请另行联系。
