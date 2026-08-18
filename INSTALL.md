# Huawei Deck 安装指南

Huawei Deck 包含两层：

- **Skill**：让 Codex、Claude Code 等 Agent 能发现 Huawei Deck 的工作流；
- **Editor**：提供新建、预览、区域任务、直接编辑、撤销和固化界面。

两层可以独立使用。Editor 的导出和材料解析能力按需安装，不会阻塞基础启动。

## 1. 准备仓库

当前版本采用 Developer Link 安装。先在目标电脑 clone 或解压完整仓库，并保持目录不被随意移动。

基础要求：

- Python 3.9 或更高版本；
- 使用 Editor 时需要 Node.js 18 或更高版本；
- 至少安装并登录 Codex、Claude Code 或 OpenCode 中的一个。

## 2. macOS 安装

在仓库根目录运行：

```bash
python3 scripts/install.py install
```

默认行为：

1. 把当前仓库注册到 `~/.agents/skills/huawei-deck`；
2. 检查并修复 Editor Core 的项目依赖；
3. 不安装 LibreOffice、PPTX 导出或材料解析能力。

安装后重新打开 Codex 任务，再双击根目录的 `Huawei Deck 编辑器.app`。

## 3. Windows 安装

在仓库根目录打开 PowerShell：

```powershell
py -3 scripts\install.py install
```

安装器会使用目录 junction 注册 Skill，不要求开启 Windows Developer Mode。安装后重新打开 Codex 任务，再双击 `Huawei Deck 编辑器.cmd`。

如果系统没有 `py`，可改用：

```powershell
python scripts\install.py install
```

### Windows Editor 使用安装在 WSL2 内的 Codex

如果 Editor 在 Windows 启动，而 Codex CLI 只安装在 WSL2，可在
`%USERPROFILE%\.huawei-deck-editor\settings.json` 写入本机配置：

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
修改配置或更新 Editor 代码后，需要彻底退出旧 Editor 后台再重新双击启动。

## 4. 只安装 Skill

如果暂时不使用窗口化 Editor：

```bash
python3 scripts/install.py install --skill-only
```

Windows：

```powershell
py -3 scripts\install.py install --skill-only
```

## 5. 兼容其他 Agent

默认只注册 Codex 当前使用的通用目录 `~/.agents/skills/huawei-deck`。

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
| Codex | `~/.agents/skills/huawei-deck` |
| Claude Code | `~/.claude/skills/huawei-deck` |
| 旧版 Codex 兼容 | `~/.codex/skills/huawei-deck` |

## 6. 检查和修复

只检查 Skill 与 Editor Core：

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

如果注册目标已经指向当前仓库，但没有本安装器的所有权记录，检查结果会显示 `adoption-required`，普通安装或修复会返回 `INSTALL_ADOPTION_REQUIRED`，不会静默接管。确认该链接确实应由 Huawei Deck 管理后运行：

```bash
python3 scripts/install.py repair --adopt-existing
```

Windows PowerShell 使用 `py -3 scripts\install.py repair --adopt-existing`。Editor 首页的“安装与诊断”也会显示“接管此安装”，并在写入所有权记录前要求明确确认。

## 7. 按任务准备能力

基础 Editor：

```bash
python3 scripts/check_deps.py --profile editor-core --repair
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

Windows 把 `python3` 换成 `py -3`。Chrome、LibreOffice、Node.js 和 Agent CLI 需要用户按诊断提示手工安装或登录。

## 8. 启动 Editor

macOS：双击 `Huawei Deck 编辑器.app`，或：

```bash
python3 scripts/deck-editor.py --app
```

Windows：双击 `Huawei Deck 编辑器.cmd`，也可以把一份 deck HTML 拖到该文件上。

命令行直接打开一份 Deck：

```bash
python3 scripts/deck-editor.py /absolute/path/to/deck.html
```

Windows：

```powershell
py -3 scripts\deck-editor.py C:\absolute\path\to\deck.html
```

## 9. 卸载

```bash
python3 scripts/install.py uninstall
```

卸载只移除安装器登记、并且仍指向当前仓库的 Skill 注册。它不会删除：

- 当前仓库；
- 用户创建的 Deck；
- `.huawei-deck-editor` 中的工作副本和会话；
- Python、Node.js、Chrome、LibreOffice 或 Agent CLI。

如果注册目标在安装后被改到别处，卸载会返回 `UNINSTALL_TARGET_CHANGED` 并拒绝删除。

多 Host 卸载按事务执行；任一注册项删除失败时，安装器会恢复此前已经移除的链接和原安装记录，避免留下半卸载状态。

## 10. 常见问题

### Skill 安装后没有触发

先运行 `scripts/install.py inspect`，确认 Codex 注册状态为 `ready`，然后新开一个 Agent 任务。已有任务不会总是自动重新扫描 Skill。

### Editor 能打开，但验证或导出不可用

这属于 Feature Pack 未就绪，不是 Editor Core 安装失败。进入 Editor 的“安装与诊断”，按任务修复 `verify` 或 `pptx-export`。

### macOS 已安装 Python 包，Editor 却显示未就绪

最新版 `.app` 会在 Apple Silicon 上显式使用 arm64，避免 Rosetta Python 无法载入 arm64 扩展。更新后请彻底退出旧工作台并重新双击；“安装与诊断”会把真正的架构冲突显示为“已安装但架构不兼容”，不会再笼统写成缺少。

如果只剩 LibreOffice，先执行 `soffice --version`。Homebrew 链接存在但 `/Applications/LibreOffice.app` 不存在属于残留安装，可运行 `brew reinstall --cask libreoffice` 修复。

### macOS 阻止打开 `.app`

当前仓库入口属于开发版本，尚未作为签名安装包发布。内部使用时应由管理员确认仓库来源；正式外部分发需要完成签名和 notarization。

### Windows 运行后窗口一闪而过

在 PowerShell 中运行 `py -3 scripts\install.py inspect` 查看结构化错误。若找不到 Python，请先安装 Python 3 并启用 `py` launcher。

### Windows 已配置 WSL Codex，但 Editor 仍无法启动 Agent

运行 `py -3 scripts\check_deps.py --profile editor-core --check-only`。诊断结果应显示
`Codex: WSL <发行版>/<用户> · <版本>`。如果提示发行版、用户或 Codex 不可用，请先用
上面的 `wsl.exe` 命令核对名称、登录状态和登录 `PATH`；不要在 Windows 侧复制
`/root/.codex` 或登录凭据。

如果 Codex 能打开但请求模型时提示 DNS、证书或连接失败，确认代理配置在登录 shell
中生效，而不只是某个已经打开的终端会话中生效：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "curl -I --max-time 12 https://chatgpt.com"
```
