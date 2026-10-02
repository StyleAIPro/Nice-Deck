# ADR-0007：插件目录安装与 PPT 私有运行时

状态：已实现。

2026-09-27（0.1.25）：Editor 公共 Python 启动环境强制设置 `PYTHONDONTWRITEBYTECODE=1`，模型运行包装器对 Python 显式追加 `-B`。避免辅助模块在安装目录生成 `__pycache__`，造成归档严格比对不一致。此变更不删除已有缓存，不放宽完整性核验；用户绕过这些入口自行执行 Python 不在此保护范围内。

用户选择将 AICO-Harness 与 AICO-PPT 分开发行。Host 安装器不包含 PPT 模板、插件 Python 或额外浏览器；桌面插件管理器下载并校验本插件的准备产物，再通过既有 DSH Web profile 注册它。此决策替代完整应用首次启动时下载整套 PPT 运行时的方案。

PPT Host 入口接受显式 `aicoRuntime:{ root, paths:{ python } }`。描述中只允许工具路径，实际文件经 realpath 校验后必须位于该插件发行根目录。管理器向插件包根目录写入相同 JSON 的 `.aico-runtime.json`；该文件不含凭据、用户配置或自定义环境。Node 复用 Host 的 `process.execPath`。

配置运行时时，原 Editor App Server 在受 Host 持有的 Worker 中启动。Worker 环境在导入任何 Editor 模块前固定，防止模块级 Python 默认值串用 Host 或其他插件的运行时。环境移除继承的工具覆盖与凭据变量，并设置私有 Python / PATH 与禁止写入字节码缓存的环境；桌面渲染通过保留的 `AICO_HOME` 定位 Host 的私有能力文件；现有 AICO 和 PPT 数据目录保持不变。源码 `apply(ctx)` 仍直接启动原 App Server。

Worker 就绪后报告实际 loopback URL，Host 沿用原有 index-inject 提供 Editor 入口。启动与运行中异常分别拒绝激活或报告 Host 日志与注入错误。卸载请求先等待 `app.close()` 和 Worker 退出；15 秒关闭期限后强制终止 Worker 并等待完成，30 秒启动期限内无法就绪则拒绝激活。

模型读取的规范 Skill 仅在桌面配置存在时追加 `runtime-run.mjs` 调用说明。包装器读取相同描述并重建独立环境，允许 `python3` / `node` 的常规解释器参数、stdin 与项目脚本；执行权限由 Harness 的审批与沙箱管理，包装器不建立第二套脚本权限规则。工作目录、标准输入输出与脚本退出码保留，规范 `SKILL.md` 文件不作桌面专用改写。

验证覆盖真实 Editor HTTP 启动 / 关闭、私有诊断环境、路径逃逸和额外字段拒绝、Worker 崩溃与关闭失败、强制关闭完成、源码 Skill 回退，以及模型脚本的参数、stdin、目录和退出码。桌面浏览器截图与 HTML → PPTX 导出由发行验收继续覆盖。参考 PPTX 使用标准库工具按页提取内容和内嵌原图，不再要求 Office；`office` 运行时字段被拒绝，继承的 `AICO_SOFFICE_EXECUTABLE` 仍被过滤。发行方只发布插件包与 Python 组件，运行时描述仅含 Python 路径；`browser` 字段被拒绝，继承的 `AICO_BROWSER_EXECUTABLE` 被过滤。发布清单使用 `apiVersion: 2` 与 `requires: {desktopRenderer: 1}`，截图、验证和导出要求兼容的运行中 Electron Host。

桌面文件与目录选择能力通过 Host 到 Worker 的私有启动参数传递，仅注入系统选择器回调；地址与认证令牌不进入 Worker 通用环境、模型脚本或运行时描述文件。启动时验证通道必须是带认证信息的本机 `/pick` 地址。真实 Worker 到 Electron 对话框桥的回归覆盖 HTML 选择和创建项目目录选择，同时保留无令牌及带浏览器 Origin 请求的拒绝检查。

## 原装 Desktop 插件安装布局验证

原装 Desktop 的包管理器可以将依赖提升到 Profile 的 `node_modules`。Editor 的 html2canvas、Three.js 与可选 xterm 浏览器资源按 Node 包解析规则定位，不再假定依赖嵌套在 PPT 包目录内。资源按需解析，DSH Editor Core 跳过独立终端时不解析 xterm。依赖体检使用同一 ESM 包解析规则，并验证 Three.js 的两个浏览器文件；独立运行的Node 版本要求同步为 ^18.19 或 ≥20.6。

Windows 原装 Desktop 2.0.10-beta.1 / DSH 0.1.5-rc.2 已通过真实离线 CLI 安装包测试：从预置最近任务打开两页 HTML Deck，实际修改标题、撤销、重做并永久固化到 R4，退出后核对 HTML 写回及卸载后的文件保留；同时验证 Knowledge 导入、阅读和保存笔记，卸载 AICO 包后原装桌面重新启动且业务数据保留。这不代表原生文件选择、新建 Deck、导出或完整 WSL 切换已验收。前述私有桌面能力属于旧运行时说明，不能据此要求修改原装宿主；原装模式的缺口由适配插件继续实现和验证。

## 原装宿主的私有浏览器模式

原装 Desktop 的 `desktopActions` 仅公开终端打开与重启，没有旧 AICO Electron renderer 私有通道。原装插件模式因此允许资源描述声明 `paths.browser`；它与 Python 一起通过 realpath 和普通文件校验，位于同一资源根目录。适配插件的资源配置映射接受该角色，Worker 与模型脚本包装器共同使用 `AICO_RUNTIME_KIND=plugin` 和显式浏览器路径，移除旧 `AICO_HOME`。截图、验证、导出使用现有 Playwright 路径，不加载或改写宿主原生主进程。

本节替代前文“所有桌面模式只携带 Python、拒绝 browser 字段”的约定。省略 browser 的旧描述仍使用原来的桌面渲染通道，不能用于证明原装宿主具备导出能力。插件模式缺少显式浏览器路径时不回退本机 Chrome。`aico.release.json` 只声明 Windows 的 Python 和浏览器文件，不再要求 `desktopRenderer`；WSL 仅承担模型通信，不安装 PPT 业务运行时。正式原装发布仍需构建、校验并分发匹配 Windows 平台的浏览器资源。

显式集成测试已在 Linux 与 Windows 用临时复制的浏览器／Python 执行真实两页图片导出，检查 PPTX ZIP 完整性、两页及两张图片，随后删除测试目录。Windows 文件占用仅有限重试，不吞掉清理失败。该测试父进程为 Node；不证明原装 Electron Utility Host 的脚本入口、导出 UI、WSL 切换或正式资源发行可用。

Worker 和包装器的独立环境显式记录当前 `process.execPath` 为 `AICO_NODE_EXECUTABLE`，过滤继承覆盖；Electron 中仅给子进程设置 `ELECTRON_RUN_AS_NODE=1`。Python 转换器与体检使用该绝对路径，路径无效时拒绝执行，不因宿主目录没有 node.exe 而错误回退系统 Node。Windows Electron 43.3.0 的 Node 模式已完成相同真实图片导出；原装 Utility Host 内完整 Worker/UI 验收仍独立进行。

原装 Windows Desktop 2.0.10-beta.1 / DSH 0.1.5-rc.2 的实际 Utility Host + 私有 Worker 联合检查已通过：编辑保留原始运行时的授课模板前两页、固化，再通过导出 UI 和真实原生保存窗口生成图片 PPTX。封面及目录四个标签按既有规则展开为五页；退出后验证 ZIP、五页和五张图片，卸载并重启后文件保留。此处的 Python／浏览器仍是本机安装目录的测试副本；可编辑 PPTX、正式资源、模型脚本首次启动和完整 WSL 切换仍须独立验证。

## 模型命令的首次启动

Skill provider 把当前 aicoRuntime 的根目录及工具路径编码到包装器参数，调用方不必在只读包目录创建描述文件。包装器校验显式描述；只有未提供参数才读取旧描述文件。Windows PowerShell 5 的原生命令引号规则要求 JSON 使用 base64url 传输，内容只包含路径；Electron 的 Node 模式仅在调用期间设置并恢复，管道保证等待 GUI 子系统的进程且保留输出，脚本块显式传回 LASTEXITCODE。POSIX shell 使用单命令环境。

Linux shell 与 Windows Node／Electron 实测覆盖无包内描述文件、中文及单引号路径、原工作目录、私有环境和非零退出码。显式无效描述的检查证明不会回退包内文件。该验证不调用真实模型，也不代表 Agent 的完整新建、导出和 WSL 任务已验收。
