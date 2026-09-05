# AICO-PPT 安装指南

AICO-PPT 的产品定位是独立 Skill 与 AICO-Harness 编辑器插件：

- **Skill**：让 Codex、Claude Code 等 Agent 能发现 AICO-PPT 的工作流；
- **AICO-Harness Plugin**：所有用户可视化编辑入口位于 AICO-Harness，提供左侧原生对话与右侧 Editor。

维护者调试用的 Dev Shell 收纳于 `tools/dev-shell/`，不属于用户安装入口。Skill 不依赖 AICO-Harness，可独立使用；默认安装不检查或修复本机 Agent PTY。

插件与独立 Skill 共用同一份 `SKILL.md`，编辑路径复用 Editor Core 和 Managed Workspace。AICO-Harness 插件不要求本机 Codex / Claude Code / OpenCode CLI，也不会加载 `node-pty`；导出和材料解析能力按需安装，不会阻塞 Editor Core。

## 1. 准备仓库

当前版本采用 Developer Link 安装。先在目标电脑 clone 或解压完整仓库，并保持目录不被随意移动。

基础要求：

- Python 3.9 或更高版本；
- 使用 Editor Core 时需要 Node.js 18 或更高版本；
- 只有独立 Dev Shell 才要求至少安装并登录 Codex、Claude Code 或 OpenCode 中的一个。

## 2. 安装 AICO-Harness 编辑器插件（唯一用户窗口入口）

从仓库根目录执行：

```bash
dsh plugin --profile web add .
```

随后重启 AICO-Harness 的 `web` profile（沿用 `dsh` CLI 和插件协议）。左侧边栏底部会出现 `AICO-PPT`；点击后保持左侧会话，并在右侧打开 Editor。插件依赖可用 `python3 scripts/check_deps.py --profile editor-core --repair` 准备，右侧不创建本机 Agent PTY。

## 3. macOS / Linux 安装独立 Skill

在仓库根目录运行：

```bash
python3 scripts/install.py install
```

默认行为：

1. 把当前仓库注册到 `~/.agents/skills/aico-ppt`；
2. 不检查或安装 AICO-Harness、Agent CLI、PTY 或 xterm；
3. 制作时按任务准备 `editor-core`、`verify`、`pptx-export` 或 `materials` 依赖。

安装后新开 Agent 任务使用 `aico-ppt`。制作、修改与验证可独立完成，无需启动 AICO-Harness 或 Dev Shell。需要可视化微调时，从 AICO-Harness 的 AICO-PPT 插件打开 Deck。

若机器上已有旧版注册，安装器会先创建并验证 `~/.agents/skills/aico-ppt`，写入新的安装记录后，才删除由旧安装记录明确拥有的注册。来源不明的同名目录或链接一律不会被覆盖或删除。旧项目 sidecar 与旧本机状态目录继续原位兼容读取，避免 Draft、工作副本或会话绑定失联。

## 4. Windows 安装独立 Skill

在仓库根目录打开 PowerShell：

```powershell
py -3 scripts\install.py install
```

安装器会使用目录 junction 注册 Skill，不要求开启 Windows Developer Mode；默认只注册 Skill，不安装独立桌面入口或本机 Agent 终端。

如果系统没有 `py`，可改用：

```powershell
python scripts\install.py install
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

## 5. 只安装 Skill

如果只在 Codex / Claude Code 中调用 Skill，或窗口化操作全部交给 DSH：

```bash
python3 scripts/install.py install --skill-only
```

Windows：

```powershell
py -3 scripts\install.py install --skill-only
```

## 6. 兼容其他 Agent

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

## 7. 检查和修复

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

## 8. 按任务准备能力

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

PDF/PPTX 外部材料解析：

```bash
python3 scripts/check_deps.py --profile materials --repair
```

Windows 把 `python3` 换成 `py -3`。Chrome、LibreOffice 和 Node.js 需要用户按诊断提示手工安装；Agent CLI 只属于 `dev-shell` Profile。

## 9. 启动独立 Dev Shell

本节不是正式 DSH 使用路径，只用于开发、回归与故障排查。

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

## 10. 卸载

```bash
python3 scripts/install.py uninstall
```

卸载只移除安装器登记、并且仍指向当前仓库的 Skill 注册。它不会删除：

- 当前仓库；
- 用户创建的 Deck；
- `.aico-ppt-editor` 中的工作副本和会话；
- Python、Node.js、Chrome、LibreOffice 或 Agent CLI。

如果注册目标在安装后被改到别处，卸载会返回 `UNINSTALL_TARGET_CHANGED` 并拒绝删除。

多 Host 卸载按事务执行；任一注册项删除失败时，安装器会恢复此前已经移除的链接和原安装记录，避免留下半卸载状态。

## 11. 常见问题

### Skill 安装后没有触发

先运行 `scripts/install.py inspect`，确认 Codex 注册状态为 `ready`，然后新开一个 Agent 任务。已有任务不会总是自动重新扫描 Skill。

### Editor 能打开，但验证或导出不可用

这属于 Feature Pack 未就绪，不是 Editor Core 或 `dev-shell` 安装失败。进入 Editor 的“安装与诊断”，按任务修复 `verify` 或 `pptx-export`。

### macOS 已安装 Python 包，Editor 却显示未就绪

最新版 `.app` 会在 Apple Silicon 上显式使用 arm64，避免 Rosetta Python 无法载入 arm64 扩展。更新后请彻底退出旧工作台并重新双击；“安装与诊断”会把真正的架构冲突显示为“已安装但架构不兼容”，不会再笼统写成缺少。

如果只剩 LibreOffice，先执行 `soffice --version`。Homebrew 链接存在但 `/Applications/LibreOffice.app` 不存在属于残留安装，可运行 `brew reinstall --cask libreoffice` 修复。

### macOS 阻止打开 `.app`

当前仓库入口属于开发版本，尚未作为签名安装包发布。内部使用时应由管理员确认仓库来源；正式外部分发需要完成签名和 notarization。

### Windows 运行后窗口一闪而过

在 PowerShell 中运行 `py -3 scripts\install.py inspect` 查看结构化错误。若找不到 Python，请先安装 Python 3 并启用 `py` launcher。

### Windows 已配置 WSL Codex，但 Editor 仍无法启动 Agent

运行 `py -3 scripts\check_deps.py --profile dev-shell --check-only`。诊断结果应显示
`Codex: WSL <发行版>/<用户> · <版本>`。如果提示发行版、用户或 Codex 不可用，请先用
上面的 `wsl.exe` 命令核对名称、登录状态和登录 `PATH`；不要在 Windows 侧复制
`/root/.codex` 或登录凭据。

如果 Codex 能打开但请求模型时提示 DNS、证书或连接失败，确认代理配置在登录 shell
中生效，而不只是某个已经打开的终端会话中生效：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "curl -I --max-time 12 https://chatgpt.com"
```
