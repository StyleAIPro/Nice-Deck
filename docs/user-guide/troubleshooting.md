# 故障排查

## Skill 没有被 Agent 发现

运行：

```bash
python3 scripts/install.py inspect
```

确认 `codex` 注册状态为 `ready`，再新开一个 Agent 任务。如果显示 `occupied`，目标目录属于其他安装，安装器不会覆盖。如果显示 `adoption-required`，说明链接已经指向当前仓库，但还没有安装器所有权记录；请在首页“安装与诊断”中点击“接管此安装”并确认，或明确运行：

```bash
python3 scripts/install.py repair --adopt-existing
```

接管只登记这个已经核对为同源的链接，让后续修复和卸载能按所有权安全执行，不会改动仓库或用户 Deck。

## Editor 无法启动

```bash
python3 scripts/check_deps.py --profile editor-core --check-only
python3 scripts/check_deps.py --profile editor-core --repair
```

Node.js 或 Agent CLI 缺失时需要手工安装。Agent 已安装但未登录时，请先在普通终端完成登录。

### Windows Editor 使用 WSL Codex 时提示找不到 CLI

本机配置位于 `%USERPROFILE%\.huawei-deck-editor\settings.json`。确认其中的
`wslDistribution`、`wslUser` 与实际环境一致，再在 PowerShell 运行：

```powershell
wsl.exe -d Ubuntu-26.04 -u root --exec bash -lic "command -v codex"
wsl.exe -d Ubuntu-26.04 -u root --exec codex login status
py -3 scripts\check_deps.py --profile editor-core --check-only
```

诊断应显示 `Codex: WSL <发行版>/<用户> · <版本>`。修改配置或更新 Editor 后要彻底
退出旧后台并重新双击入口；只关掉启动命令窗口不会替换已经运行的 Node 服务。
Codex 登录和会话继续保存在对应 WSL 用户的 `~/.codex`，无需复制到 Windows 用户目录。
若 CLI 能打开但模型请求提示 DNS、证书或连接失败，确认代理变量由该用户的登录 shell
加载；Editor 会通过 `bash -lic` 启动 Codex，以继承同一套代理环境。

## 验证或导出不可用

Editor Core、质量验证和导出是独立能力：

```bash
python3 scripts/check_deps.py --profile verify --check-only
python3 scripts/check_deps.py --profile pptx-export --check-only
```

缺少 LibreOffice 只影响外部 PPTX 材料转换，不阻塞 Editor、验证或 HTML → PPTX 导出。

### macOS 显示 Python 包“未就绪”，但终端可以导入

Apple Silicon 上必须通过最新版 `Huawei Deck 编辑器.app` 启动。入口会显式使用 arm64，避免 LaunchServices 把脚本型 App 放进 Rosetta 进程树，导致 arm64 的 `python-pptx`、`pdfplumber` 或 `PyMuPDF` 被误判为不可用。更新入口后请彻底退出旧工作台再重新双击；诊断若仍发现架构冲突，会明确显示“已安装但架构不兼容”。

### LibreOffice 看似已安装但仍不可用

`which soffice` 能找到命令，不代表应用仍完整存在。诊断会实际执行 `soffice --version`；若 Homebrew 链接仍在而 `/Applications/LibreOffice.app` 已被移除，会显示“找到但无法启动”。此时重新安装 LibreOffice，而不是反复修复 Python 包：

```bash
brew reinstall --cask libreoffice
```

## 任务显示“待确认”

这表示 Agent 找到多个可能目标。打开任务的“补充说明”，写清页码、栏目、原文字或相对位置，再重新提交。

## 修改无法固化

常见稳定错误：

- `DECK_CHANGED`：源文件在 Editor 外被修改；
- `NEW_OVERFLOW`：修改产生了新的页面溢出；
- `EDITOR_OFFLINE`：受控浏览器 frame 未连接；
- `RECOVERY_REQUIRED`：工作副本需要先恢复；
- `MISSING_PAGE_TARGETS`：结构修改删除了仍被动作引用的页面。

不要绕过固化直接覆盖真实 Deck。保留工作副本，按错误提示重新加载、处理冲突或另存副本。

## 获取结构化诊断

```bash
python3 scripts/install.py inspect --json
python3 scripts/check_deps.py --profile full --check-only --json
```

分享日志前删除用户名、绝对项目路径、令牌和 Agent 对话内容。
