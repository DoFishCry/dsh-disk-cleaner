/**
 * GarbageMaster — Linux 规则包（声明式数据 + 匹配器）。
 *
 * 纯逻辑：不 import 任何宿主模块，也不 import node:*。`home` 由调用方注入，
 * 因此本文件可以原样复用到浏览器、独立程序或未来其它宿主。
 *
 * 匹配语义与既有 Python 规则库一致：**按顺序匹配，第一条命中即生效**。
 * 因此顺序本身就是安全设计：具体路径 → 通用缓存 → 系统禁区 → 用户数据 → 项目碎片。
 *
 * ⚠️ 锚定纪律（这一条曾真实导致过 bug）：
 *    绝对路径规则**必须**以 `^` 开头；只有需要"任意层级出现"的规则才用 `(^|/)`。
 *    反例：写成 `/tmp(/|$)` 而不加 `^`，它会匹配**任何**位于 /tmp 之下的路径，
 *    从而把后面所有规则全部遮住。`tests/smoke.mjs` 里有对应的回归检查。
 *
 * risk:
 *   safe    可安全删除（可再生 / 删除后软件自行重建或重新下载）
 *   caution 需你确认（删了有代价：重下、丢历史、需重装）
 *   keep    建议保留（用户数据或程序本体，不该由自动化清理）
 *   blocked 绝不允许本插件删除（系统本体、密钥、仓库元数据、挂载根）
 *
 * action:
 *   unlink   直接用文件系统删除（默认永久删除）
 *   archive  先打包归档再删原件
 *   command  必须用官方命令达成（本插件只呈现命令，不代执行）
 *   manual   只能由你在文件管理器/软件内处理
 */

/** 占位符：调用方注入的家目录；缺省是通用 /home/<user> 与 /root。 */
const HOME_TOKEN = '%H%';
const HOME_ANY = String.raw`(?:/home/[^/]+|/root)`;

/** 规则表：[正则源, risk, action, note, opts?] —— 顺序即优先级。 */
const RAW = [
  // ════════════════════════════════════════════════════════════════════
  // A. 具体缓存 / 可再生数据（先具体，后通用）
  // ════════════════════════════════════════════════════════════════════

  // ---- A1. 语言与包管理器缓存 ----
  [String.raw`^%H%/\.cache/pip(/|$)`, 'safe', 'unlink',
    'pip 的 HTTP/轮子缓存。删掉不影响任何已安装的库，只是下次装包要重新下载。等价命令 `pip cache purge`。',
    { recursive: true }],
  [String.raw`^%H%/\.cache/uv(/|$)`, 'safe', 'unlink',
    'uv 的包缓存，删除后 uv 会按需重新下载。', { recursive: true }],
  [String.raw`^%H%/\.npm/_cacache(/|$)`, 'safe', 'unlink',
    'npm 的 content-addressable 缓存（经常能到几 GB，且碎文件极多）。删除不影响已安装依赖，只是重装时要重新下载。',
    { recursive: true }],
  [String.raw`^%H%/\.npm/_logs(/|$)`, 'safe', 'unlink', 'npm 的调试日志，纯文本，删了无害。', { recursive: true }],
  [String.raw`^%H%/\.cache/(?:yarn|pnpm|bun)(/|$)`, 'safe', 'unlink',
    'yarn / pnpm / bun 的下载缓存，可再生。', { recursive: true }],
  [String.raw`^%H%/\.bun/install/cache(/|$)`, 'safe', 'unlink', 'bun 的依赖缓存，可再生。', { recursive: true }],
  [String.raw`^%H%/\.cargo/registry/cache(/|$)`, 'safe', 'unlink',
    'Rust 依赖的 .crate 压缩包缓存。删除后 cargo 会重新下载，已编译产物不受影响。', { recursive: true }],
  [String.raw`^%H%/\.cargo/registry/(?:src|index)(/|$)`, 'caution', 'unlink',
    'Rust 依赖解压后的源码与索引。删了会触发重新下载解压；离线编译时需要它。', { recursive: true }],
  [String.raw`^%H%/\.rustup/(?:downloads|tmp)(/|$)`, 'safe', 'unlink', 'rustup 的下载临时目录，可再生。', { recursive: true }],
  [String.raw`^%H%/\.gradle/(?:caches|daemon|workers|native)(/|$)`, 'safe', 'unlink',
    'Gradle 构建缓存与守护进程日志。删除后下次构建会重新下载依赖并重算缓存（首次构建变慢）。', { recursive: true }],
  [String.raw`^%H%/\.m2/repository(/|$)`, 'caution', 'unlink',
    'Maven 本地仓库。删掉不是丢项目代码，但下次构建要把所有依赖重新下载一遍，通常很慢。', { recursive: true }],
  [String.raw`^%H%/(?:go/pkg/mod/cache|\.cache/go-build)(/|$)`, 'safe', 'unlink',
    'Go 模块缓存 / 构建缓存（可用 `go clean -modcache`、`go clean -cache`）。可再生。', { recursive: true }],
  [String.raw`^%H%/\.pub-cache(/|$)|^%H%/\.cache/dart(?:flutter)?(/|$)`, 'caution', 'unlink',
    'Dart / Flutter 的包与构建缓存，可再生但重新拉取较慢。', { recursive: true }],
  [String.raw`^%H%/\.conda/pkgs(/|$)|(^|/)pkgs$`, 'safe', 'command',
    'conda 的软件包缓存。推荐用官方命令清理，避免损坏环境元数据。',
    { remedy: { command: 'conda clean -p -y && conda clean -t -y', why: '官方清理包缓存与 tarball，不改动任何已建环境。' } }],

  // ---- A2. 模型 / 科学计算缓存 ----
  [String.raw`^%H%/\.cache/huggingface(/|$)`, 'caution', 'unlink',
    'HuggingFace 模型权重缓存，通常非常大（几十 GB 很常见）。删了不丢代码，但下次用同一个模型要重新下载。**建议先确认里面没有你正在用的模型。**',
    { recursive: true }],
  [String.raw`^%H%/\.cache/(?:torch|triton|numba|jax|keras)(/|$)`, 'safe', 'unlink',
    '深度学习框架的编译/内核缓存，删除后首次运行会重新编译（只慢这一次）。', { recursive: true }],
  [String.raw`^%H%/\.cache/(?:wandb|mlflow)(/|$)`, 'caution', 'unlink',
    '实验跟踪工具的本地缓存。**注意：如果尚未同步到云端，删掉会丢实验记录**，请先确认已 sync。',
    { recursive: true }],
  [String.raw`^%H%/\.cache/(?:ms-playwright|puppeteer|electron)(/|$)`, 'caution', 'unlink',
    '自动化浏览器 / Electron 的二进制缓存。删了要重新下载几百 MB，用到时才需要。', { recursive: true }],
  [String.raw`^%H%/\.cache/(?:whisper|clip|sentence_transformers)(/|$)`, 'caution', 'unlink',
    '模型权重缓存，删了需要重新下载。', { recursive: true }],

  // ---- A3. 缩略图与显卡缓存 ----
  [String.raw`^%H%/(?:\.cache/thumbnails|\.thumbnails)(/|$)`, 'safe', 'unlink',
    '文件管理器的图片缩略图缓存，删除后会自动重建。', { recursive: true }],
  [String.raw`^%H%/\.cache/(?:mesa_shader_cache|mesa_shader_cache_db|nvidia|nv)(/|$)|^%H%/\.nv(/|$)`, 'safe', 'unlink',
    '显卡着色器缓存。删除后游戏/桌面首次渲染会重新编译着色器（只慢这一次）。', { recursive: true }],

  // ---- A4. 浏览器缓存（只清缓存，不碰配置与书签）----
  [String.raw`^%H%/\.cache/(?:google-chrome|chromium|microsoft-edge|brave|vivaldi|opera)(/|$)`, 'safe', 'unlink',
    'Chromium 系浏览器的磁盘缓存。删除后网页首次加载变慢，**书签/密码/扩展/历史都不受影响**（它们在 ~/.config 下）。',
    { recursive: true }],
  [String.raw`^%H%/\.config/(?:google-chrome|chromium|microsoft-edge|brave)[^/]*/(?:Default|Profile \d+)/(?:Cache|Code Cache|GPUCache|ShaderCache|GrShaderCache|Service Worker)(/|$)`,
    'safe', 'unlink', '浏览器缓存目录（旧版布局）。删除后自动重建，不影响配置。', { recursive: true }],
  [String.raw`^%H%/\.cache/(?:mozilla|firefox)(/|$)`, 'safe', 'unlink',
    'Firefox 的磁盘缓存（cache2）。删除后自动重建；书签、密码、扩展不受影响。', { recursive: true }],
  [String.raw`^%H%/\.mozilla/firefox/[^/]+/cache2(/|$)`, 'safe', 'unlink', 'Firefox 的 cache2 缓存目录，可再生。',
    { recursive: true }],

  // ---- A5. 编辑器 / IDE 缓存 ----
  [String.raw`^%H%/\.config/Code/(?:Cache|CachedData|CachedExtensionVSIXs|GPUCache|Code Cache|logs|Crashpad)(/|$)`,
    'safe', 'unlink', 'VS Code 的缓存与日志，删除后自动重建。**扩展与设置不在这些目录里**（在 ~/.vscode 与 User/settings.json）。',
    { recursive: true }],
  [String.raw`^%H%/\.config/Code/User/workspaceStorage(/|$)`, 'caution', 'unlink',
    'VS Code 的工作区状态缓存（含每个工作区的 UI 状态、部分扩展本地数据）。删了会丢失各项目的窗口状态。',
    { recursive: true }],
  [String.raw`^%H%/\.cache/(?:JetBrains|Google/AndroidStudio)(/|$)`, 'safe', 'unlink',
    'JetBrains 系列 IDE 的索引与缓存，删除后首次打开项目会重建索引（耗时但安全）。', { recursive: true }],
  [String.raw`^%H%/\.cache/vscode-(?:cpptools|python|ripgrep)(/|$)`, 'safe', 'unlink',
    'VS Code 扩展的缓存，可再生。', { recursive: true }],
  [String.raw`^%H%/\.local/share/nvim(/|$)|^%H%/\.cache/nvim(/|$)`, 'caution', 'unlink',
    'Neovim 的插件与缓存。**注意 ~/.local/share/nvim 里可能装着你的插件本体**，删了要重装；只清 ~/.cache/nvim 最安全。',
    { recursive: true }],

  // ---- A6. 容器 / 虚拟化（多数只能靠官方命令）----
  [String.raw`^/var/lib/docker/overlay2(/|$)|^/var/lib/docker/(?:image|container|volumes|buildkit)(/|$)`, 'caution', 'command',
    'Docker 的镜像层与卷。**直接删目录会让 Docker 状态不一致**，必须用官方命令回收。',
    { remedy: { command: 'docker system prune -a --volumes', why: '清理未使用的镜像、容器、网络与卷；先跑 `docker system df` 看清占用。' } }],
  [String.raw`^%H%/\.local/share/(?:containers|docker)(/|$)`, 'caution', 'command',
    'rootless Podman/Docker 的存储。请用官方命令回收。',
    { remedy: { command: 'podman system prune -a --volumes', why: '回收未使用的镜像与卷。' } }],
  [String.raw`^%H%/\.cache/(?:libvirt|qemu)(/|$)`, 'caution', 'unlink', '虚拟机的临时/缓存数据，可再生。', { recursive: true }],
  [String.raw`^/var/lib/(?:libvirt|libvirt-images)(/|$)`, 'blocked', 'manual',
    '虚拟机磁盘镜像所在目录。**删掉就是删掉整台虚拟机**，请用 virt-manager 删除虚拟机。'],

  // ---- A7. 系统包管理与日志（需要 root，只给命令）----
  [String.raw`^/var/cache/apt/archives(/|$)|^/var/cache/apt/[^/]+\.bin$`, 'safe', 'command',
    'APT 下载的 .deb 安装包缓存。安装完成后就没有用了。',
    { remedy: { command: 'sudo apt clean', why: '清空 /var/cache/apt/archives，不影响已安装的软件。' } }],
  [String.raw`^/var/cache/pacman/pkg(/|$)|^/var/cache/pkg(/|$)`, 'safe', 'command',
    'Arch 的包缓存（旧版本包会一直堆积）。',
    { remedy: { command: 'sudo pacman -Sc', why: '清理未安装版本的包缓存；`-Scc` 会清得更彻底。' } }],
  [String.raw`^/var/cache/(?:dnf|yum)(/|$)`, 'safe', 'command', 'DNF/YUM 的包缓存。',
    { remedy: { command: 'sudo dnf clean all', why: '清理所有元数据与包缓存。' } }],
  [String.raw`^/var/log/journal(/|$)`, 'safe', 'command',
    'systemd 的持久化日志。长期运行会涨到几 GB，可以用官方命令按大小裁剪。',
    { remedy: { command: 'sudo journalctl --vacuum-size=200M', why: '把日志裁到 200MB；先 `journalctl --disk-usage` 看当前占用。' } }],
  [String.raw`^/var/log/.*\.(?:gz|[0-9]+)$|^/var/log/[^/]+\.old$`, 'safe', 'unlink',
    '轮转后的旧日志（已压缩或编号）。当前正在写的日志不在此列，可以安全删除。'],
  [String.raw`^/var/log/(?:upstart|syslog\.[0-9]+)(/|$)`, 'safe', 'unlink', '轮转日志，可删。'],
  [String.raw`^/var/crash(/|$)`, 'safe', 'unlink', '系统崩溃转储，除非要排查崩溃否则没有保留价值。', { recursive: true }],
  [String.raw`^/var/lib/snapd/cache(/|$)|^/var/cache/snapd(/|$)`, 'safe', 'unlink',
    'Snap 的下载缓存。删除后已安装的 snap 不受影响。', { recursive: true }],
  [String.raw`^%H%/snap/[^/]+/[^/]+/\.cache(/|$)`, 'safe', 'unlink', 'Snap 应用的私有缓存，可再生。', { recursive: true }],
  [String.raw`^%H%/\.var/app/[^/]+/cache(/|$)`, 'safe', 'unlink', 'Flatpak 应用的缓存目录，可再生。', { recursive: true }],

  // ---- A8. 临时目录与回收站 ----
  [String.raw`^/var/tmp(/|$)`, 'caution', 'unlink',
    '系统级临时目录，**重启后通常保留**，所以里面可能有正在被引用的东西。删前最好确认没有程序在跑。',
    { recursive: true }],
  [String.raw`^/tmp(/|$)`, 'caution', 'unlink',
    '临时目录（多数在 tmpfs 上，重启即清）。删除可以立刻释放内存/磁盘，但**运行中的程序可能正在用它**，建议只删明确属于旧会话的子项。',
    { recursive: true }],
  [String.raw`^%H%/\.local/share/Trash(/|$)`, 'safe', 'command',
    '你的回收站。里面是已经删掉但还在占空间的东西。',
    { remedy: { command: 'gio trash --empty', why: '清空回收站（等价于在文件管理器里点「清空回收站」）。' } }],
  [String.raw`^%H%/\.local/share/(?:recently-used\.xbel|recently-used)$|^%H%/\.cache/(?:gvfs-metadata|tracker3?)(/|$)`,
    'safe', 'unlink', '「最近使用」记录与文件索引缓存，删除后自动重建。', { recursive: true }],

  // ---- A9. 游戏与娱乐 ----
  [String.raw`^%H%/\.local/share/Steam/steamapps/(?:shadercache|downloading|temp)(/|$)`, 'safe', 'unlink',
    'Steam 的着色器缓存与下载暂存，可再生。', { recursive: true }],
  [String.raw`^%H%/\.local/share/Steam/steamapps/compatdata(/|$)`, 'caution', 'unlink',
    'Steam Play(Proton) 的 Windows 兼容前缀，**每个游戏一个**，里面含该游戏的存档与设置。删掉会丢存档。'],
  [String.raw`^%H%/\.steam/steam/steamapps/(?:shadercache|downloading)(/|$)`, 'safe', 'unlink', 'Steam 着色器/下载缓存。',
    { recursive: true }],
  [String.raw`^%H%/\.wine(/|$)`, 'caution', 'manual',
    'Wine 前缀（含 Windows 程序的注册表与数据）。要清理请在 winecfg / winetricks 内处理，不要直接删目录。'],
  [String.raw`^%H%/\.cache/(?:Epic|Battle\.net|Heroic)(/|$)`, 'safe', 'unlink', '游戏平台的网络与缩略图缓存，可再生。',
    { recursive: true }],

  // ---- A10. 通用缓存兜底（必须排在所有具体 .cache 规则之后）----
  [String.raw`^%H%/\.cache(/|$)`, 'safe', 'unlink',
    '用户级通用缓存目录（XDG_CACHE_HOME）。按 XDG 规范，这里的东西**随时可以被删除**，程序会自行重建；代价通常只是下次启动/加载变慢。',
    { recursive: true }],
  [String.raw`^/var/cache(/|$)`, 'caution', 'unlink',
    '系统级缓存目录。多数子项可再生，但**其中有些属于正在运行的服务**（如 apt 列表、man 索引），建议只删你认得的那几个子目录。',
    { recursive: true }],

  // ════════════════════════════════════════════════════════════════════
  // B. 系统禁区（绝不允许本插件自动删除）
  // ════════════════════════════════════════════════════════════════════
  [String.raw`^/(?:proc|sys|dev|run)(/|$)`, 'blocked', 'manual',
    '内核/运行时虚拟文件系统。这里没有真实磁盘占用，删除会导致系统立即异常。'],
  [String.raw`^/(?:bin|sbin|lib|lib32|lib64|libx32)(/|$)`, 'blocked', 'manual',
    '系统可执行文件与共享库（通常是 /usr 的符号链接）。删除会直接让系统无法启动。'],
  [String.raw`^/usr(/|$)`, 'blocked', 'manual',
    '系统程序本体。要释放空间应该用包管理器卸载软件，而不是删目录（可以用 `du -sh /usr/*` 先看谁在占地方）。'],
  [String.raw`^/boot(/|$)`, 'blocked', 'manual',
    '内核与引导文件。**删了机器起不来。** 旧内核请用包管理器清理（Debian/Ubuntu：`sudo apt autoremove --purge`）。'],
  [String.raw`^/etc(/|$)`, 'blocked', 'manual', '系统与软件配置。这里的体积通常很小，动它只有风险没有收益。'],
  [String.raw`^/opt(/|$)`, 'blocked', 'manual',
    '第三方软件安装位置（如浏览器、IDE 的独立安装版）。要清理请用它们自带的卸载方式。'],
  [String.raw`^/srv(/|$)`, 'blocked', 'manual', '服务数据目录，可能承载网站/数据库内容。'],
  [String.raw`^/var/lib/(?:dpkg|apt|rpm|snapd)(/|$)`, 'blocked', 'manual',
    '包管理器的数据库。**动了它，系统就再也装不上/卸不掉软件。**'],
  [String.raw`^/var/lib/(?:mysql|postgresql|mariadb|mongodb|redis|elasticsearch)(/|$)`, 'blocked', 'manual',
    '数据库的数据目录。**删掉就是删库。**'],
  [String.raw`^/var/log(/|$)`, 'blocked', 'manual',
    '日志目录。其中**轮转后的旧日志是可安全删除的**（已由上面的规则单独覆盖），但目录整体不该被删。'],
  // 注意：这里只把「挂载容器的浅层」判为不可删（/media、/media/<user>），
  // **不**把 /media/<user>/<mount> 以下的任意深度都封死——否则数据盘上就什么都清不了了。
  // 「挂载点/扫描根本身不可删」由执行层的 protectedPaths 硬校验负责，比正则更可靠。
  [String.raw`^/(?:media|mnt)$|^/(?:media|mnt)/[^/]+$`, 'blocked', 'manual',
    '挂载容器目录（挂载点自身的上一层）。整盘不能被当作「垃圾」删除；请展开到具体子目录再判断。'],
  [String.raw`(^|/)\.git(/|$)`, 'blocked', 'manual',
    'Git 仓库元数据。**删掉等于丢掉全部提交历史**，而它占的空间通常根本没多少。清理仓库请用 `git gc`。'],
  [String.raw`(^|/)\.ssh(/|$)|(^|/)\.gnupg(/|$)|(^|/)\.password-store(/|$)`, 'blocked', 'manual',
    'SSH 私钥 / GPG 密钥 / 密码库。**删了不可恢复，且会立刻失去对服务器的访问能力。**'],
  [String.raw`(^|/)\.(?:aws|kube|docker)/config(?:\.json)?$`, 'blocked', 'manual', '云与容器凭据文件。删除会造成访问中断。'],
  [String.raw`^/home/[^/]+$|^/root$`, 'blocked', 'manual',
    '家目录本身。不能整体删除；请展开看具体子目录。'],
  [String.raw`(^|/)lost\+found(/|$)`, 'blocked', 'manual',
    'ext2/3/4 的保留区（文件系统损坏时 fsck 会往这里放恢复文件）。不能删，也不该计入清理范围。'],

  // ════════════════════════════════════════════════════════════════════
  // C. 用户数据（插件不替你决定，只能手动处理）
  // ════════════════════════════════════════════════════════════════════
  [String.raw`^%H%/(?:Documents|Pictures|Videos|Music|Desktop|Templates|Public)(/|$)`, 'keep', 'manual',
    '你的文档/图片/视频/音乐目录。**这些是你的数据，不该由清理工具自动处理。** 想清就手动挑。'],
  [String.raw`^%H%/Downloads(/|$)`, 'caution', 'manual',
    '下载目录。里面既可能有大安装包（可删），也可能有你还需要的文件——**所以这里只呈现给你，不参与自动删除**。'],

  // ════════════════════════════════════════════════════════════════════
  // D. 项目构建碎片（刻意排在系统禁区 B 之后：
  //    这样 /usr/lib/node_modules、/usr/.../__pycache__ 会先被 B 判为 blocked，
  //    绝不会因为「node_modules 可再生」而被误标成可执行删除项。）
  // ════════════════════════════════════════════════════════════════════
  [String.raw`(^|/)__pycache__(/|$)`, 'safe', 'unlink',
    'Python 字节码缓存，删除后 import 时自动重建。', { recursive: true }],
  [String.raw`(^|/)(?:\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox)(/|$)`, 'safe', 'unlink',
    'Python 测试 / 类型检查工具的缓存，可再生。', { recursive: true }],
  [String.raw`(^|/)node_modules(/|$)`, 'caution', 'unlink',
    'Node.js 依赖目录。删掉不丢源码，但下次要 `npm install` 重装（可能很慢，且需要网络）。**建议只删你确认不再需要的项目下的 node_modules。**',
    { recursive: true }],
  [String.raw`(^|/)(?:dist|build|target)(/|$)`, 'caution', 'manual',
    '构建输出目录。删掉需要重新编译；**如果 dist/build 属于某个前端的发布产物，删了业务就断了**，所以这里只呈现给你、不参与自动删除。']
];

/** 兜底规则：命不中任何规则时的判定。 */
export const DEFAULT_RULE = {
  id: 'default',
  risk: 'caution',
  action: 'manual',
  note: '未识别出它属于哪个软件，可能是你自己放的文件或未收录的目录。建议先在文件管理器里打开看看内容再决定。'
};

/** 风险档的中文标签（与既有原型保持一致，新增 blocked）。 */
export const RISK_LABEL = {
  safe: '可安全删除',
  caution: '需你确认',
  keep: '建议保留',
  blocked: '不可删除'
};

/** 该动作是否允许被本插件自动执行。 */
export const AUTO_EXECUTABLE_ACTIONS = new Set(['unlink', 'archive']);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编译规则包。
 * @param {{home?: string}} [options] home 用于替换 %H% 占位符；缺省匹配任意家目录。
 * @returns {Array<{id:number,re:RegExp,risk:string,action:string,note:string,recursive:boolean,source:string,remedy?:{command:string,why:string}}>}
 */
export function compileRules(options = {}) {
  const home = options.home && options.home !== '/' ? escapeRegExp(options.home) : HOME_ANY;
  return RAW.map(([source, risk, action, note, opts], index) => {
    const expanded = source.split(HOME_TOKEN).join(home);
    const rule = {
      id: index,
      re: new RegExp(expanded),
      source: expanded,
      risk,
      action,
      note,
      recursive: Boolean(opts && opts.recursive)
    };
    if (opts && opts.remedy) rule.remedy = { command: opts.remedy.command, why: opts.remedy.why };
    // 防御：command 若无 remedy，就退化为纯手动，避免界面上出现"无解"的条目。
    if (rule.action === 'command' && !rule.remedy) {
      rule.action = 'manual';
      rule.note += '（本插件不提供自动处置方式，请按软件官方方式处理。）';
    }
    return rule;
  });
}

/**
 * 为一条路径判定风险与处置方式。第一条命中的规则生效。
 * @param {string} path 绝对路径（Linux 用 / 分隔）。
 * @param {ReturnType<typeof compileRules>} compiled 已编译的规则包。
 */
export function annotate(path, compiled) {
  if (typeof path !== 'string' || path.length === 0) return { ...DEFAULT_RULE, ruleId: null };
  for (const rule of compiled) {
    if (rule.re.test(path)) {
      return {
        ruleId: rule.id,
        risk: rule.risk,
        action: rule.action,
        note: rule.note,
        recursive: rule.recursive,
        remedy: rule.remedy
      };
    }
  }
  return { ...DEFAULT_RULE, ruleId: null, recursive: false };
}

/** 规则条数（用于界面显示与自检）。 */
export const RULE_COUNT = RAW.length;
