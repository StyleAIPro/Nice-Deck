#!/usr/bin/env python3
"""Huawei Deck 可视化编辑器的统一启动入口。

命令行与桌面应用都只经过这里：传入 deck 路径时直接打开编辑器；没有路径时
先打开一次性导入页，由用户在网页中点击后再唤起系统文件选择器。
"""

from pathlib import Path
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
EDITOR_NODE_MODULES = ("ws", "html2canvas", "busboy")


class LauncherError(RuntimeError):
    """可安全展示给用户的启动错误。"""


def build_command(
    deck,
    host="127.0.0.1",
    port=0,
    no_open=False,
    exit_when_editor_closes=False,
    agent_thread_id=None,
    agent_provider="codex",
):
    cmd = [
        "node",
        str(ROOT / "scripts/editor/server.mjs"),
        str(Path(deck).resolve()),
        "--host",
        host,
        "--port",
        str(port),
        "--agent-provider",
        agent_provider,
    ]
    if agent_thread_id:
        cmd.extend(["--agent-thread-id", agent_thread_id])
    if no_open:
        cmd.append("--no-open")
    if exit_when_editor_closes:
        cmd.append("--exit-when-editor-closes")
    return cmd


def build_app_command(
    host="127.0.0.1", port=0, no_open=False, agent_provider="codex"
):
    """构造一次性网页导入入口；成功导入后由它接管编辑器生命周期。"""
    cmd = [
        "node",
        str(ROOT / "scripts/editor/app-server.mjs"),
        "--host",
        host,
        "--port",
        str(port),
        "--python",
        sys.executable,
        "--agent-provider",
        agent_provider,
    ]
    if no_open:
        cmd.append("--no-open")
    return cmd


def _run_applescript(source, *arguments):
    return subprocess.run(
        ["/usr/bin/osascript", "-", *map(str, arguments)],
        input=source,
        capture_output=True,
        text=True,
    )


def choose_deck():
    """用系统文件选择器选一份 HTML；用户取消时返回 None。"""
    if sys.platform == "darwin" and Path("/usr/bin/osascript").is_file():
        result = _run_applescript(
            """
            on run argv
              try
                set pickedFile to choose file with prompt (item 1 of argv) of type {"public.html"}
                return POSIX path of pickedFile
              on error number -128
                return ""
              end try
            end run
            """,
            "选择要继续修改的 Huawei Deck HTML",
        )
        if result.returncode != 0:
            raise LauncherError((result.stderr or "无法打开系统文件选择器").strip())
        selected = result.stdout.strip()
        return Path(selected) if selected else None

    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.update()
        selected = filedialog.askopenfilename(
            title="选择要继续修改的 Huawei Deck HTML",
            filetypes=[("Huawei Deck HTML", "*.html *.htm"), ("所有文件", "*")],
        )
        root.destroy()
        return Path(selected) if selected else None
    except Exception as error:
        raise LauncherError("无法打开系统文件选择器，请改用命令行传入 deck 路径") from error


def show_native_error(message):
    """桌面模式用原生对话框报告错误；失败时退回 stderr。"""
    detail = str(message).strip() or "未知错误"
    if sys.platform == "darwin" and Path("/usr/bin/osascript").is_file():
        result = _run_applescript(
            """
            on run argv
              display alert (item 1 of argv) message (item 2 of argv) as critical buttons {"好"} default button "好"
            end run
            """,
            "Huawei Deck 编辑器无法启动",
            detail,
        )
        if result.returncode == 0:
            return
    elif sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                0, detail, "Huawei Deck 编辑器无法启动", 0x10
            )
            return
        except Exception:
            pass
    print(f"Huawei Deck 编辑器无法启动：{detail}", file=sys.stderr)


def _load_check_deps():
    path = ROOT / "scripts/check_deps.py"
    spec = importlib.util.spec_from_file_location("huawei_deck_check_deps", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def editor_dependency_status():
    """返回 (是否就绪, 说明)，只检查可视化编辑器启动所需依赖。"""
    doctor = _load_check_deps()
    node_ready, node_detail = doctor.probe_node()
    if not node_ready:
        return False, f"Node.js 未就绪：{node_detail}"
    missing = [
        name for name in EDITOR_NODE_MODULES
        if not doctor.probe_node_module(name)[0]
    ]
    if missing:
        return False, "缺少 Node 模块：" + "、".join(missing)
    return True, node_detail


def prepare_editor_runtime(auto_install=False):
    """桌面模式可在首次启动时按 package-lock 自动补齐 Node 模块。"""
    ready, detail = editor_dependency_status()
    if ready:
        return
    if not detail.startswith("缺少 Node 模块："):
        raise LauncherError(detail + "。请先安装 Node.js 18 或更高版本。")
    if not auto_install:
        raise LauncherError(detail + "。请先运行 python3 scripts/check_deps.py。")
    npm = shutil.which("npm")
    if not npm:
        raise LauncherError(detail + "，且找不到 npm，无法自动安装。")
    result = subprocess.run(
        [npm, "install", "--omit=dev", "--no-audit", "--no-fund"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    ready, after_detail = editor_dependency_status()
    if result.returncode != 0 or not ready:
        output = (result.stderr or result.stdout or after_detail).strip()
        raise LauncherError("首次启动自动准备依赖失败：" + output[-1600:])


def normalize_argv(argv):
    """移除 Finder 可能附加的进程序列号参数。"""
    return [value for value in argv if not value.startswith("-psn_")]


def resolve_deck(path):
    deck = Path(path).expanduser().resolve()
    if deck.suffix.lower() not in {".html", ".htm"}:
        raise LauncherError(f"只支持 deck HTML 文件：{deck}")
    if not deck.is_file():
        raise LauncherError(f"找不到 deck 文件：{deck}")
    return deck


def run_editor(command, app_mode=False):
    if not app_mode:
        try:
            return subprocess.call(command, cwd=ROOT)
        except KeyboardInterrupt:
            return 130
    result = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        show_native_error((result.stderr or result.stdout or "编辑服务异常退出").strip())
    return result.returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description="启动 Huawei Deck 后期微调编辑器")
    parser.add_argument("deck", nargs="?", help="要直接打开的 deck HTML；省略时打开网页导入入口")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--choose", action="store_true", help="忽略路径并打开网页导入入口")
    parser.add_argument("--app", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--pick-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--agent-thread-id", help=argparse.SUPPRESS)
    parser.add_argument("--agent-provider", default="codex", help="批处理 Agent provider")
    args = parser.parse_args(normalize_argv(list(sys.argv[1:] if argv is None else argv)))

    if args.pick_only:
        try:
            selected = choose_deck()
            if selected is None:
                return 3
            deck = resolve_deck(selected)
        except LauncherError as error:
            print(str(error), file=sys.stderr)
            return 2
        print(json.dumps({"deckPath": str(deck)}, ensure_ascii=False))
        return 0

    try:
        if args.app:
            prepare_editor_runtime(auto_install=True)
        direct_deck = None if args.choose or not args.deck else resolve_deck(Path(args.deck))
    except LauncherError as error:
        if args.app:
            show_native_error(error)
            return 2
        parser.error(str(error))
    if direct_deck is None:
        command = build_app_command(
            args.host, args.port, args.no_open, agent_provider=args.agent_provider
        )
    else:
        source_thread_id = args.agent_thread_id or os.environ.get("CODEX_THREAD_ID")
        command = build_command(
            direct_deck,
            args.host,
            args.port,
            args.no_open,
            exit_when_editor_closes=args.app,
            agent_thread_id=source_thread_id,
            agent_provider=args.agent_provider,
        )
    return run_editor(command, app_mode=args.app)


if __name__ == "__main__":
    sys.exit(main())
