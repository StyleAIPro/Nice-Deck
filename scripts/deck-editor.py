#!/usr/bin/env python3
from pathlib import Path
import argparse
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent


def build_command(deck, host="127.0.0.1", port=0, no_open=False):
    cmd = [
        "node",
        str(ROOT / "scripts/editor/server.mjs"),
        str(Path(deck).resolve()),
        "--host",
        host,
        "--port",
        str(port),
    ]
    if no_open:
        cmd.append("--no-open")
    return cmd


def main(argv=None):
    parser = argparse.ArgumentParser(description="启动 Huawei Deck 后期微调编辑器")
    parser.add_argument("deck")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args(argv)
    deck = Path(args.deck).resolve()
    if not deck.is_file():
        parser.error(f"找不到 deck 文件: {deck}")
    return subprocess.call(build_command(deck, args.host, args.port, args.no_open))


if __name__ == "__main__":
    sys.exit(main())
