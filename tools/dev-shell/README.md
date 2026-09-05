# 维护者调试壳

AICO-PPT 的产品定位是独立 Skill 与 AICO-Harness 编辑器插件。用户的可视化编辑入口统一位于 AICO-Harness；独立 Skill 不依赖 Harness，也不自动打开桌面编辑器。

本目录仅保留维护者开发、回归与故障排查需要的 Dev Shell。它复用 Editor Core，并额外启动本机 Agent PTY。

在仓库根目录准备调试依赖：

```bash
python3 scripts/install.py install --dev-shell
```

macOS 可双击本目录的 `AICO-PPT Dev Shell.app`；Windows 使用 `py -3 scripts\install.py install --dev-shell`，再双击 `AICO-PPT Dev Shell.cmd`。Windows 快捷方式也只生成在本目录。请保持目录结构，不能单独移动启动器。

独立 Skill 安装使用 `python3 scripts/install.py install`；只注册 Skill，不安装调试终端。无窗口编辑继续使用 `python3 scripts/deck-editor.py <deck.html> --headless-workspace`。正式插件安装见 [插件说明](../../integrations/dsh/README.md)。
