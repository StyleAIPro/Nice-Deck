#!/usr/bin/env python3
"""跨平台 HTML → PPTX 入口；Windows/macOS/Linux 共用。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass


HERE = Path(__file__).resolve().parent


def run(command: list[str]) -> None:
    print(">> " + subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, check=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把 Huawei Deck HTML 转成 PPTX")
    parser.add_argument("input", help="输入单文件 HTML")
    parser.add_argument("output", nargs="?", help="输出 PPTX；默认与输入同名")
    parser.add_argument("--scale", type=float, default=float(os.environ.get("SCALE", "2")))
    parser.add_argument("--quality", type=int, default=int(os.environ.get("QUALITY", "92")))
    parser.add_argument("--embed-html", action="store_true", default=os.environ.get("EMBED_HTML") == "1")
    args = parser.parse_args(argv)

    source = Path(args.input).expanduser().resolve()
    output = Path(args.output).expanduser().resolve() if args.output else source.with_suffix(".pptx")
    if not source.is_file():
        parser.error(f"找不到输入文件：{source}")
    if shutil.which("node") is None:
        parser.error("找不到 Node.js，请先安装 Node ≥ 18")
    if not 1 <= args.quality <= 100 or args.scale <= 0:
        parser.error("--scale 必须为正数，--quality 必须在 1 到 100 之间")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="html2pptx-") as temporary:
        image_dir = Path(temporary)
        print(f">> 截图：{source}", flush=True)
        run([
            "node", str(HERE / "shoot.mjs"), str(source), str(image_dir),
            str(args.scale), str(args.quality),
        ])
        print(">> 组装 PPTX", flush=True)
        command = [sys.executable, str(HERE / "build_pptx.py"), str(image_dir), str(output)]
        if args.embed_html:
            command.append(str(source))
        run(command)
    size_mib = output.stat().st_size / (1024 * 1024)
    print(f"完成：{output}（{size_mib:.1f} MiB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
