# AICO-PPT 安装指南

## 普通用户：原装 DSH Desktop 与 AICO 插件

更新：2026-09-19。AICO 2.0 使用原装 DSH Desktop 和配套原装 DSH，不提供修改版 AICO Desktop 安装器。当前桌面业务交付只准备 Windows，macOS 暂缓；独立 Skill 的跨平台安装见下文。

1. 安装已验证兼容的原装 DSH Desktop。
2. 在 Desktop 托盘的 DSH Terminal 中，用发布页给出的真实附件名执行 `dsh plugin add "<Harness 归档绝对路径>" --ignore-scripts`。
3. 保存工作并重启，进入“设置 → AICO 插件下载”，选择 PPT，由安装流程准备业务 bundle 与 Windows Python／浏览器资源。
4. 按提示重启并检查激活，在原装“模型”页配置模型，从侧边栏进入 AICO-PPT。

生产附件、签名索引和公网下载尚未确认就绪；本机开发包不能等同官网下载版。详细前提与原装 Profile 边界见[Harness 安装流程](../AICO-Harness-Plugin/docs/extension-design/installation-flow.md)。资源归档不能直接用 `dsh plugin add` 当作业务 bundle 安装。

WSL 只负责模型通信和所选用户授权。PPT Editor、Deck、Agent、工具及资源始终在 Windows；不因选择 WSL 模型而安装 Linux 业务运行时。插件不要求 Codex／Claude Code CLI，不加载 Dev Shell 的 PTY／xterm，也不假定原装 Desktop 提供旧 AICO 的专用渲染服务。

正式插件准备会排除展示媒体、独立 Dev Shell 终端依赖和可再生成缓存；源码与开发工具保留。PPTX 截图打包和参考内容提取使用标准库，其他材料能力按发布声明准备私有依赖。资源缺失作为安装问题报告，不直接在宿主目录运行 npm／pip 修复。卸载释放插件自有服务与进程，保留 Deck 和用户数据。

当前私有 Worker 与运行时参数见[DSH 接入说明](integrations/dsh/README.md)。历史 ADR 中依赖旧桌面渲染接口的内容不能作为原装宿主已具备能力的证明。

## 独立 Skill 安装（按需）

AICO-PPT 的产品定位是独立 Skill 与 AICO-Harness 编辑器插件：

- **Skill**：让 Codex、Claude Code 等 Agent 能发现 AICO-PPT 的工作流；
- **AICO-Harness Plugin**：桌面可视化编辑入口位于原装 DSH Desktop 中的 AICO 工作台，提供左侧原生对话与右侧 Editor。

只想在 Codex、Claude Code 等 Agent 中直接使用制作能力时，可以按本节注册独立 Skill。Skill 不依赖 AICO-Harness，可独立使用；默认安装不检查或修复本机 Agent PTY。需要可视化编辑时仍从原装 DSH Desktop 的 AICO-PPT 入口进入。开发者的网页联调、源码安装和独立 Dev Shell 见[开发调试](#开发调试)。

插件与独立 Skill 共用同一份 `SKILL.md`，编辑路径复用 Editor Core 和 Managed Workspace。AICO-Harness 插件不要求本机 Codex / Claude Code / OpenCode CLI，也不会加载 `node-pty`；独立 Skill 的导出和材料解析能力按任务准备；应用内插件由 AICO 安装流程准备相应私有能力。

### 准备仓库

独立 Skill 从完整的 AICO-PPT 仓库注册 Developer Link，无需同时获取 Harness 源码。

基础要求：

- Python 3.9 或更高版本；
- 使用 Editor Core 的制作与编辑工具需要 Node.js 18+；
- 只有独立 Dev Shell 才要求至少安装并登录 Codex、Claude Code 或 OpenCode 中的一个。

### macOS / Linux 安装独立 Skill

在仓库根目录运行：

```bash
python3 scripts/install.py install
```

默认行为：

1. 把当前仓库注册到 `~/.agents/skills/aico-ppt`；
2. 不检查或安装 AICO-Harness、Agent CLI、PTY 或 xterm；
3. 制作时按任务准备 `editor-core`、`verify`、`pptx-export`、`pptx-read` 或 `materials` 依赖。

安装后新开 Agent 任务使用 `aico-ppt`。制作、修改与验证可独立完成，无需启动 AICO-Harness 或 Dev Shell。需要可视化微调时，从 AICO-Harness 的 AICO-PPT 插件打开 Deck。

若机器上已有旧版注册，安装器会先创建并验证 `~/.agents/skills/aico-ppt`，写入新的安装记录后，才删除由旧安装记录明确拥有的注册。来源不明的同名目录或链接一律不会被覆盖或删除。旧项目 sidecar 与旧本机状态目录继续原位兼容读取，避免 Draft、工作副本或会话绑定失联。

### Windows 安装独立 Skill

在仓库根目录打开 PowerShell：

```powershell
py -3 scripts\install.py install
```

安装器会使用目录 junction 注册 Skill，不要求开启 Windows Developer Mode；默认只注册 Skill，不安装独立桌面入口或本机 Agent 终端。

如果系统没有 `py`，可改用：

```powershell
python scripts\install.py install
```

### 只安装 Skill

如果只在 Codex / Claude Code 中调用 Skill，或窗口化操作全部交给 DSH：

```bash
python3 scripts/install.py install --skill-only
```

Windows：

```powershell
py -3 scripts\install.py install --skill-only
```

### 兼容其他 Agent

默认只注册 Codex 当前使用的通用目录 `~/.agents/skills/aico-ppt`。

同时注册 Claude Code：

```bash
python3 scripts/install.py repair --hosts codex,claude-code
```

同时建立全部兼容链接：

```bash
python3 scripts/install.py repair --hosts all
```

对应位置：

| Host | 注册位置 |
|---|---|
| Codex | `~/.agents/skills/aico-ppt` |
| Claude Code | `~/.claude/skills/aico-ppt` |
| 旧版 Codex 兼容 | `~/.codex/skills/aico-ppt` |

### 独立 Skill 检查和修复

检查独立 Skill（维护者检查 Dev Shell 时显式加 `--dev-shell`）：

```bash
python3 scripts/install.py inspect
```

安全修复：

```bash
python3 scripts/install.py repair
```

查看将发生的文件变化：

```bash
python3 scripts/install.py repair --dry-run
```

给自动化读取：

```bash
python3 scripts/install.py inspect --json
```

如果注册目标已经存在且不指向当前仓库，安装器会返回 `INSTALL_TARGET_OCCUPIED` 并停止，不会覆盖原目录。请先确认旧目录来源，再手工移动或删除；不要对不明目录执行递归删除。

如果注册目标已经指向当前仓库，但没有本安装器的所有权记录，检查结果会显示 `adoption-required`，普通安装或修复会返回 `INSTALL_ADOPTION_REQUIRED`，不会静默接管。确认该链接确实应由 AICO-PPT 管理后运行：

```bash
python3 scripts/install.py repair --adopt-existing
```

Windows PowerShell 使用 `py -3 scripts\install.py repair --adopt-existing`。Editor 首页的“安装与诊断”也会显示“接管此安装”，并在写入所有权记录前要求明确确认。

### 独立 Skill 与源码开发：按任务准备能力

DSH Editor Core（不含本机 PTY 和 Agent CLI）：

```bash
python3 scripts/check_deps.py --profile editor-core --repair
```

独立 Dev Shell：

```bash
python3 scripts/check_deps.py --profile dev-shell --repair
```

截图、溢出和逐拍验证：

```bash
python3 scripts/check_deps.py --profile verify --repair
```

PPTX 导出：

```bash
python3 scripts/check_deps.py --profile pptx-export --repair
```

PPTX 参考内容读取只用标准库，无需修复第三方依赖：

```bash
python3 scripts/check_deps.py --profile pptx-read --check-only
python3 scripts/extract-pptx.py 参考.pptx 输出目录
```

输出 `slides.json`、`slides.md` 和 `media/`，供 AI 按页直接阅读文字、备注、表格和原始图片。工具不渲染 PPTX，也不转换 PDF；不支持的对象会标出限制，详见 [配图工作流](references/artwork.md#21-从-pptx-提取内容与原图)。

PDF 外部材料解析只需随包适配的 PDF Skill、PyMuPDF 与 pypdf；文字、表格、原图、渲染、批注和页面操作使用 PyMuPDF，pypdf 仅用于 AcroForm 填写：

```bash
python3 scripts/check_deps.py --profile materials --repair
```

Windows 把 `python3` 换成 `py -3`。Chrome 和 Node.js 需要用户按诊断提示手工安装；Agent CLI 只属于 `dev-shell` Profile。

### 卸载独立 Skill

```bash
python3 scripts/install.py uninstall
```

卸载只移除安装器登记、并且仍指向当前仓库的 Skill 注册。它不会删除：

- 当前仓库；
- 用户创建的 Deck；
- `.aico-ppt-editor` 中的工作副本和会话；
- Python、Node.js、Chrome 或 Agent CLI。

如果注册目标在安装后被改到别处，卸载会返回 `UNINSTALL_TARGET_CHANGED` 并拒绝删除。

多 Host 卸载按事务执行；任一注册项删除失败时，安装器会恢复此前已经移除的链接和原安装记录，避免留下半卸载状态。

## 开发调试

以下仅供维护者开发、回归与故障排查，不作为普通用户的并列安装方式。底层 DSH Web 与 Editor Core 继续保留；当前桌面入口为原装 DSH Desktop 中的 AICO-PPT 插件。

### 当前原装宿主联调

使用固定原装 Desktop、当前 AICO-Harness 适配插件和 PPT 的 DSH 入口，在隔离的 Windows Profile／测试数据中检查真实 Editor 与会话流程。依赖与命令入口见[Harness 本地开发](../AICO-Harness-Plugin/docs/extension-design/local-development.md)和[DSH 集成](integrations/dsh/README.md)。不要用旧修改版 Harness 启动结果证明兼容原装宿主。

旧网页启动器、配套源码安装及 dev-web 数据步骤保存在[历史说明](docs/history/2026-09-19-old-harness-development.md)，不再是当前执行入口。以下独立 Dev Shell 只验证 Editor 自身，不代表桌面插件整机验收。

### 启动 PPT 独立 Dev Shell

本小节只启动原独立 Editor 与本机 Agent PTY，不会安装或打开正式 AICO 应用。

先运行 `python3 scripts/install.py install --dev-shell`（Windows：`py -3 scripts\install.py install --dev-shell`）准备调试依赖；默认安装只注册 Skill。

macOS：双击 `tools/dev-shell/AICO-PPT Dev Shell.app`，或：

```bash
python3 scripts/deck-editor.py --app
```

Windows：首次双击 `tools/dev-shell/AICO-PPT Dev Shell.cmd` 会生成带图标的 `AICO-PPT Dev Shell（Windows）.lnk`；之后可双击快捷方式，也可以把一份 deck HTML 拖到 `.cmd` 或快捷方式上。快捷方式保存当前机器的绝对路径，移动仓库后删除旧 `.lnk` 并重新运行 `.cmd` 即可重建。

命令行直接打开一份 Deck：

```bash
python3 scripts/deck-editor.py /absolute/path/to/deck.html
```

Windows：

```powershell
py -3 scripts\deck-editor.py C:\absolute\path\to\deck.html
```

### 维护者专用：Dev Shell 使用 WSL2 Codex

本小节仅用于维护者显式调试。先运行 `py -3 scripts\install.py install --dev-shell`；启动器位于 `tools/dev-shell/`，不用于普通 Skill 或 AICO-Harness 插件安装。

如果 Editor 在 Windows 启动，而 Codex CLI 只安装在 WSL2，可在
`%USERPROFILE%\.aico-ppt-editor\settings.json` 写入本机配置：

```json
{
  "codexRuntime": "wsl",
  "wslDistribution": "Ubuntu-26.04",
  "wslUser": "root"
}
```

先在对应 WSL 用户中完成一次登录并确认命令可用：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "command -v codex"
wsl.exe -d Ubuntu-26.04 -u root --exec codex login status
```

Editor 会进入该发行版用户的登录 shell，继承其 `PATH`、代理等环境后启动 Codex，
并把 Windows 项目路径转换为 WSL 路径。会话继续从该 WSL 用户的 `~/.codex`
发现和恢复；配置只在
Windows 的 Codex provider 上生效，不改变 macOS、Linux、Claude Code 或 OpenCode。
启动器会在用户打开任务前预热 WSL；同一 Editor 进程会缓存该发行版 / 用户对应的
Codex、Node、HOME 与 Windows→WSL 路径映射。任务终端依次显示“WSL 准备 / Codex
启动 / 历史重绘”；恢复历史只在服务端无界面终端中解析，真实输入态成立后才把最终
终端画面一次性投影到浏览器，避免长会话逐块重绘。
修改配置或更新 Editor 代码后，需要彻底退出旧 Editor 后台再重新双击启动。

## 常见问题

### Skill 安装后没有触发

先运行 `scripts/install.py inspect`，确认 Codex 注册状态为 `ready`，然后新开一个 Agent 任务。已有任务不会总是自动重新扫描 Skill。

### Editor 能打开，但验证或导出不可用

桌面插件用户先查看插件内“安装与诊断”，核对 AICO 安装流程登记的 Windows 私有 Python／浏览器资源；缺失时检查资源安装回执并通过原装支持的插件流程修复，不在宿主目录运行 npm／pip。旧 `desktopRenderer: 1` 不属于当前原装交付前提。独立 Skill 或源码开发者按本机依赖检查结果修复 `verify`、`pptx-export` 等能力。

### 开发调试：macOS 已安装 Python 包，Editor 却显示未就绪

本仓库最新版 `tools/dev-shell/AICO-PPT Dev Shell.app` 会在 Apple Silicon 上显式使用 arm64，避免 Rosetta Python 无法载入 arm64 扩展。更新后请彻底退出旧工作台并重新双击；“安装与诊断”会把真正的架构冲突显示为“已安装但架构不兼容”，不会再笼统写成缺少。

PPTX 读取不依赖 LibreOffice 或 PDF 库；`pptx-read` 若提示提取工具缺失，应恢复完整 Skill 文件，桌面版通过 AICO 安装入口检查并修复 AICO-PPT。

### 开发调试：macOS 阻止打开 Dev Shell `.app`

当前仓库入口属于开发版本，尚未作为签名安装包发布。内部使用时应由管理员确认仓库来源；正式外部分发需要完成签名和 notarization。

### 开发调试：Windows Dev Shell 窗口一闪而过

在 PowerShell 中运行 `py -3 scripts\install.py inspect` 查看结构化错误。若找不到 Python，请先安装 Python 3 并启用 `py` launcher。

### 开发调试：Windows 已配置 WSL Codex，但 Editor 仍无法启动 Agent

运行 `py -3 scripts\check_deps.py --profile dev-shell --check-only`。诊断结果应显示
`Codex: WSL <发行版>/<用户> · <版本>`。如果提示发行版、用户或 Codex 不可用，请先用
上面的 `wsl.exe` 命令核对名称、登录状态和登录 `PATH`；不要在 Windows 侧复制
`/root/.codex` 或登录凭据。

如果 Codex 能打开但请求模型时提示 DNS、证书或连接失败，确认代理配置在登录 shell
中生效，而不只是某个已经打开的终端会话中生效：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "curl -I --max-time 12 https://chatgpt.com"
```

## 本机测试：0.1.12 离线插件包（2026-09-19）

旧 `.migration/desktop-business-packages/aico-ppt-skill-0.1.11.tgz` 未携带 npm 运行依赖，并包含独立终端可选依赖；在当前 Windows registry 请求返回 `EACCES` 的环境中会反复重试。不要继续使用该旧包做桌面安装测试。

`0.1.12` 将五项直接运行依赖及其依赖闭包随插件打包，不携带独立终端依赖。在原装 DSH Terminal 中执行：

```powershell
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\.migration\ppt-offline-r1\aico-ppt-skill-0.1.12.tgz" --ignore-scripts --offline
```

原装 Windows Desktop CLI 在隔离 Profile、空 pnpm store 下已完成安装并登记 bundle，约 9 秒。插件接口测试 34 通过、1 跳过。本次修复不代表 Python／浏览器资源或完整 PPT 业务已验收；这些资源仍由 AICO 资源安装流程管理。无需修改 DSH Desktop，也不需要关闭 TLS 证书校验。`--offline` 会在其他依赖缺失时立即报错，不进行网络重试。

### 0.1.20 开发插件包

本版新增右侧当前页/选区上下文、项目资料索引，以及活动任务的取消等待与删除入口。仅修改 PPT 插件，配合 AICO-Harness dev.19，使用原装 DSH Desktop。

```powershell
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-PPT\dist\aico-ppt-skill-0.1.20.tgz" --ignore-scripts --offline
```

安装后重启 Desktop。浏览器夹具和工具协议测试不等于用户日常 Desktop、真实模型及 WSL 模型链路的完整验收。

### 0.1.21 Editor 连接诊断

插件自动记录服务启停、Editor 握手拒绝、WebSocket 建立/关闭及浏览器重连事件。日志位于运行 PPT 服务用户的 `~/.aico/diagnostics/ppt-editor-*.jsonl`（Windows 通常为 `%USERPROFILE%\.aico\diagnostics`），时间使用 UTC。日志只保存白名单字段，不保存令牌、URL、关闭文本或 Deck 内容；单文件约 1 MiB 轮转，启动新记录器时清理较旧的同类日志。写入失败不阻断编辑。

此版本用于定位连接中断，并不代表此前 `EDITOR_OFFLINE` 的触发原因已经确认。出现问题时保留故障时间及该目录下 `ppt-editor-*.jsonl*`。浏览器若不能连接后台，事件上报也可能失败，需结合服务端连接记录；此时不能仅凭缺少浏览器日志断言没有重连。当前 Windows 业务直连模式不需要更新 Harness。

### 0.1.22 项目切换菜单

修复嵌入 DSH 时顶部工具栏横向滚动容器裁切“切换项目”列表。菜单挂载到页面顶层，继续锚定入口，并在窗口缩放或滚动时调整位置，限制在可视区域内；保留菜单内滚动、Escape 关闭及原有项目/会话关联逻辑。无需修改或重新安装宿主与 Harness。

### 0.1.23 创建项目后台发布

创建项目准备发布时，如果 Managed Editor 没有浏览器连接，临时使用插件私有浏览器挂载同一 Editor，沿用原有 flush、就绪确认、固化和后续验证流程，结束后释放临时浏览器。无需保持该项目在前台；不会跳过验证或自动重放模型指令。未安装私有浏览器或真正的验证失败仍会明确报错。

`aico_ppt` 上下文支持按持久会话关联定位创建项目已经存在的 Managed Editor；未生成 Deck 的创建项目仍不提供编辑能力，不会借用其他项目。后台发布挂载是临时的，不代表所有编辑工具在关闭可见画布后都有常驻后台写入能力。

## 0.1.24：工作版本缓存回收

`.huawei-deck-editor`（旧目录）和 `.aico-ppt-editor`（新目录）包含工作副本、恢复数据与历史，不能整目录删除。此前每次源码变化都会按 SHA-256 保存完整 HTML，缺少孤立版本回收；大型单文件 Deck 的中间版本会持续积累。

从 0.1.24 开始，Editor 在启动恢复完成后及正常关闭、写入队列排空后回收 `working/versions` 中超过 24 小时的无引用版本，额外保留最新 8 份。当前工作副本、撤销/重做、时间线、固化检查点、历史归档、命令回执及备份仍引用的版本全部保留。源 Deck、附件、备份、会话、任务列表和其他项目不在删除范围内；必要历史仍可能占用较多空间，回收规则不是总容量上限。

存在未完成源码/固化事务、尚未登记的工作副本变化或元数据异常时跳过回收。Windows 使用现有原生独占锁，其他编辑服务占用项目时不清理。只更新 PPT 插件即可，不需要修改或更新 DSH Desktop、DSH 或 Harness。

需要手动清理指定会话时，先正常退出占用该项目的编辑服务。用 Windows Python 执行随包的 `scripts/editor/prune-working-versions.py "<包含 session.json 的会话目录>"` 默认只预览；增加 `--apply --report "<sidecar 之外的新报告文件.json>"` 才删除已确认无引用的版本并保存清单。该命令不会强制解除编辑锁，也不提供清空历史选项。
