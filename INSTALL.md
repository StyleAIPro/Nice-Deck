# AICO-PPT 安装指南

## 普通用户：安装 AICO 应用与 PPT 插件

正式用户入口只有 AICO 独立软件。先安装 AICO-Harness 应用：Windows 使用 `.exe` 安装器，macOS 将 DMG 中的 AICO 拖入“应用程序”，之后从应用图标启动。应用先安装 Harness，PPT 与所需运行时由插件商店按需安装。实际可下载平台以发布者提供并验证过的安装包为准；公开下载源、签名和 notarization 尚待发布者完成。

首次打开后，在“设置 → 插件 → 插件商店”选择 AICO-PPT 并安装。没有可用来源时，填写发布者提供的 HTTPS 目录地址；该目录应包含 `catalog.json` 和目录记录引用的归档文件。管理器启动时刷新已配置来源，网络不可用时保留缓存目录。安装会下载并校验 PPT 包及其 Python 组件，截图与验证复用 AICO 的 Electron，可取消并重试。新发布要求兼容的桌面渲染能力；旧 Host 需先升级 AICO。激活后页面自动刷新一次以载入插件界面，Host 会话继续运行。在“设置 → 模型”配置模型服务或完成所选服务的登录后，从侧边栏进入 AICO-PPT。此流程无需执行下方源码命令，也无需安装 Codex 或系统 Chrome。

正式插件归档不包含 `docs/showcase/` 展示媒体与独立 Dev Shell 的 PTY / xterm 依赖。Three.js 保留编辑器加载的两个浏览器文件、包信息与许可证；Python 的文档依赖仅为 PyMuPDF、pypdf 和 Pillow，并清除可重新生成的 `__pycache__`，保留源码及独立字节码。PPTX 截图打包和参考内容提取只用标准库；Pillow 用于可选 HTML 附件图标。这些裁剪仅作用于发布准备目录；完整源码中的模板、演示和 Dev Shell 保留，开发调试依赖继续按下文准备。已安装版本的磁盘占用以实际更新后的产物为准。

桌面版的“安装与诊断”显示插件私有能力；缺少资源时报告安装故障，不在应用资源目录运行 npm/pip 修复。移除插件会撤销注册并保留项目及用户数据。桌面冷启动按当前版本、上一版本及会话租约保留产物，并回收能够确认归属的旧产物；旧的仅含 identity 标记的安装保持原位，不自动回收。已验证组件可从缓存复用。更新 Host 前关闭 AICO，再安装替换包，`~/.aico-harness` 数据和 Deck 项目文件保留。已安装原生 DSH 或独立 AICO-PPT Skill 的用户可保留原安装。Harness 网页启动器已收纳到源码仓库的 `tools/dev-web/`，只供维护者调试；普通用户无需运行它。私有描述、Worker 与脚本包装器见 [ADR-0007](docs/adr/0007-plugin-private-runtime.md)，工具与原生对话框接口见 [ADR-0006](docs/adr/0006-desktop-runtime-capabilities.md)。

## 独立 Skill 安装（按需）

AICO-PPT 的产品定位是独立 Skill 与 AICO-Harness 编辑器插件：

- **Skill**：让 Codex、Claude Code 等 Agent 能发现 AICO-PPT 的工作流；
- **AICO-Harness Plugin**：所有用户可视化编辑入口位于 AICO-Harness，提供左侧原生对话与右侧 Editor。

只想在 Codex、Claude Code 等 Agent 中直接使用制作能力时，可以按本节注册独立 Skill。Skill 不依赖 AICO-Harness，可独立使用；默认安装不检查或修复本机 Agent PTY。需要可视化编辑时仍从 AICO 应用进入。开发者的网页联调、源码安装和独立 Dev Shell 见[开发调试](#开发调试)。

插件与独立 Skill 共用同一份 `SKILL.md`，编辑路径复用 Editor Core 和 Managed Workspace。AICO-Harness 插件不要求本机 Codex / Claude Code / OpenCode CLI，也不会加载 `node-pty`；独立 Skill 的导出和材料解析能力按任务准备；应用内插件由插件商店准备相应私有能力。

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

以下仅供维护者开发、回归与故障排查，不作为普通用户的并列安装方式。底层 DSH Web 与 Editor Core 继续保留；AICO 的正式入口仍是已安装的独立应用。

### Harness 网页联调

Harness 网页启动器位于相邻 AICO-Harness 仓库的 `tools/dev-web/`，包括 `start.mjs` 与各平台 `launch-aico.*`；仓库根目录不再提供网页启动器。在 AICO-PPT 仓库根目录运行：

```bash
node ../AICO-Harness/tools/dev-web/start.mjs --ppt "$(pwd)"
node ../AICO-Harness/tools/dev-web/start.mjs --help
```

默认开发数据目录为 `~/.aico-harness-dev-web`，其中 `ppt/` 保存 PPT 全局状态；显式设置 `AICO_HOME` 可选择另一个开发目录。不要用正式应用的 `~/.aico-harness` 启动调试实例，也不要同时从两个实例打开同一个 Deck 工作副本。PPT 原独立 Editor 调试壳位于本仓库的 [`tools/dev-shell/`](tools/dev-shell/README.md)，两者用途不同。

### 源码配套安装（高级）

仅用于配套版本、安装过程与回退回归。将 AICO-Harness 与 AICO-PPT 两个完整仓库并列放置，准备 Node.js 22.19 或 24+、npm、Python 3.9+，然后在 AICO-PPT 仓库根目录执行。以下显式指定开发数据目录，避免使用正式应用的 `~/.aico-harness`：

```bash
AICO_HOME="$HOME/.aico-harness-dev-web" node ../AICO-Harness/scripts/aico.mjs install --ppt .
```

Windows PowerShell：

```powershell
$env:AICO_HOME = Join-Path $HOME ".aico-harness-dev-web"
node ..\AICO-Harness\scripts\aico.mjs install --ppt .
```

安装器将两个仓库的源码快照、锁定依赖和构建结果放入 `~/.aico-harness-dev-web/releases/`，缺少指定版本的 pnpm 时在 AICO 目录内准备；不会更新或覆盖这两个开发仓库。随后用 `~/.aico-harness-dev-web/bin/aico` 启动（Windows：`%USERPROFILE%\.aico-harness-dev-web\bin\aico.cmd`）。左侧边栏的 `AICO-PPT` 打开右侧 Editor，右侧不创建本机 Agent PTY。首次源码安装需要网络和本机构建；生成的 `aico` 命令只用于开发验收。普通用户安装应用并通过插件商店使用 PPT，不执行本小节命令。

### 开发数据、共存与历史导入

无需卸载原 DSH，也无需重装全局 Skill。上述开发安装使用独立 `aico` 入口和 `~/.aico-harness-dev-web`，PPT 全局状态位于其 `ppt/` 子目录；启动器覆盖继承的 `DSH_HOME` / `AICO_PPT_EDITOR_STATE_ROOT`，不会使用原生 DSH 的默认 3080 端口，而是绑定系统分配的空闲端口。PPT 编辑器自己的端口也由系统分配。已有 `.agents/skills/aico-ppt`、`.codex/skills/aico-ppt` 等注册、原 DSH 配置与会话、项目 sidecar 和工作副本都保留。

需要测试旧首页历史导入时，先关闭相关开发实例，在目标开发目录首次启动前执行：

```bash
~/.aico-harness-dev-web/bin/aico import-ppt --from "$HOME/.aico-ppt-editor"
```

旧状态实际位于 `.huawei-deck-editor` 时使用该目录。导入只复制受支持的工作目录 / 最近历史索引，保留 workId、deckId 和项目路径，清空属于旧 DSH 的工作区与会话关联；原来源和项目文件不变。打开工作后新建关联的 AICO 会话。目标必须不存在或为空；同一快照重复导入不会覆盖新工作，来源变化后再次导入会拒绝。已有工作的开发目录保持原样，改用另一个 `AICO_HOME` 执行安装与导入。不要将正式应用的数据目录当作测试目标。

关闭开发实例后重复安装另一配套版本即可升级；安装失败保留当前版本。`~/.aico-harness-dev-web/bin/aico rollback` 切回上个源码版本，`~/.aico-harness-dev-web/bin/aico doctor` 检查依赖。回退不回退数据格式。独立 Skill 注册仍使用上文的所有权管理流程。

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

AICO 应用用户先查看插件内“安装与诊断”：渲染服务不可用时启动或升级支持 `desktopRenderer: 1` 的 Host，缺少插件私有资源时从插件商店重新安装或重试，不在应用资源目录运行 npm/pip。独立 Skill 或源码开发者才按本机依赖检查结果修复 `verify`、`pptx-export` 等能力。

### 开发调试：macOS 已安装 Python 包，Editor 却显示未就绪

本仓库最新版 `tools/dev-shell/AICO-PPT Dev Shell.app` 会在 Apple Silicon 上显式使用 arm64，避免 Rosetta Python 无法载入 arm64 扩展。更新后请彻底退出旧工作台并重新双击；“安装与诊断”会把真正的架构冲突显示为“已安装但架构不兼容”，不会再笼统写成缺少。

PPTX 读取不依赖 LibreOffice 或 PDF 库；`pptx-read` 若提示提取工具缺失，应恢复完整 Skill 文件，桌面版从插件商店重新安装 AICO-PPT。

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
