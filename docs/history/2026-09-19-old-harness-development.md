# 旧 Harness 开发步骤（历史保留）

2026-09-19 归档。这些命令依赖已退役的旧 Harness，不得在当前工作区继续运行、打包或用其结果证明原装兼容性。当前开发见[安装指南](../../INSTALL.md#开发调试)。

### Harness 网页联调

Harness 网页启动器位于相邻 AICO-Harness 仓库的 `tools/dev-web/`，包括 `start.mjs` 与各平台 `launch-aico.*`；仓库根目录不再提供网页启动器。在 AICO-PPT 仓库根目录运行：

```bash
node ../upstream-old/AICO-Harness/tools/dev-web/start.mjs --ppt "$(pwd)"
node ../upstream-old/AICO-Harness/tools/dev-web/start.mjs --help
```

默认开发数据目录为 `~/.aico-harness-dev-web`，其中 `ppt/` 保存 PPT 全局状态；显式设置 `AICO_HOME` 可选择另一个开发目录。不要用正式应用的 `~/.aico-harness` 启动调试实例，也不要同时从两个实例打开同一个 Deck 工作副本。PPT 原独立 Editor 调试壳位于本仓库的 [`tools/dev-shell/`](../../tools/dev-shell/README.md)，两者用途不同。

### 源码配套安装（高级）

仅用于配套版本、安装过程与回退回归。将 AICO-Harness 与 AICO-PPT 两个完整仓库并列放置，准备 Node.js 22.19 或 24+、npm、Python 3.9+，然后在 AICO-PPT 仓库根目录执行。以下显式指定开发数据目录，避免使用正式应用的 `~/.aico-harness`：

```bash
AICO_HOME="$HOME/.aico-harness-dev-web" node ../upstream-old/AICO-Harness/scripts/aico.mjs install --ppt .
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

