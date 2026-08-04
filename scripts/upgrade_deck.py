#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""旧 Deck 升级器：迁移公共运行时，保留页面、导航、章节与 manifest。

默认只预览；加 --yes 才落盘。落盘前自动备份，升级后调用 edit-bundle.verify。
视觉风格只审计、不盲改；新增迁移时按版本顺序追加到 MIGRATIONS。
"""

import argparse
import importlib.util
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
CURRENT_VERSION = "2026.08.1"
VERSION_RE = re.compile(r'<meta name="huawei-deck-version" content="([^"]+)">')


def load_edit_bundle():
    path = REPO / "scripts" / "edit-bundle.py"
    spec = importlib.util.spec_from_file_location("edit_bundle", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


eb = load_edit_bundle()


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Migration:
    key: str
    title: str
    probe: object
    apply: object


OLD_RAIL_CSS = """  .railtoggle { top:18px; left:18px; width:48px; height:48px; justify-content:center; cursor:pointer; color:#b5333b; }
  .railtoggle svg { position:relative; z-index:1; }"""

NEW_RAIL_CSS = """  .railtoggle { top:18px; left:18px; width:108px; height:48px; justify-content:flex-start; gap:9px; padding:0 14px; box-sizing:border-box; cursor:pointer; color:#b5333b; }
  .railtoggle svg { position:relative; z-index:1; flex:none; }
  .railpage { position:relative; z-index:1; display:flex; align-items:baseline; gap:3px; font-family:'JetBrains Mono',monospace; line-height:1; white-space:nowrap; color:#3f464d; }
  .railpage-current { min-width:14px; text-align:right; font-size:15px; font-weight:800; color:#b5333b; }
  .railpage-sep, .railpage-total { font-size:12px; font-weight:700; color:#566472; }"""

OLD_RAIL_BUTTON = """  <button type="button" class="glassbar railtoggle" id="railtoggle" title="幻灯片预览" aria-label="幻灯片预览">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>
  </button>"""

NEW_RAIL_BUTTON = """  <button type="button" class="glassbar railtoggle" id="railtoggle" title="幻灯片预览" aria-label="幻灯片预览；当前第 1 页，共 1 页">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>
    <span class="railpage" aria-hidden="true"><span class="railpage-current" id="railPgCur">1</span><span class="railpage-sep">/</span><span class="railpage-total" id="railPgTot">1</span></span>
  </button>"""

OLD_RAIL_SYNC = """      const rfc = document.getElementById('rfCur'), rft = document.getElementById('rfTot');
      if (rfc) rfc.textContent = this._index + 1;
      if (rft) rft.textContent = this._fits.length;"""

NEW_RAIL_SYNC = """      const rfc = document.getElementById('rfCur'), rft = document.getElementById('rfTot');
      const rpc = document.getElementById('railPgCur'), rpt = document.getElementById('railPgTot');
      const railtoggle = document.getElementById('railtoggle');
      if (rfc) rfc.textContent = this._index + 1;
      if (rft) rft.textContent = this._fits.length;
      if (rpc) rpc.textContent = this._index + 1;
      if (rpt) rpt.textContent = this._fits.length;
      if (railtoggle) railtoggle.setAttribute('aria-label', '幻灯片预览；当前第 ' + (this._index + 1) + ' 页，共 ' + this._fits.length + ' 页');"""


def has_page_counter(s):
    return all(x in s for x in ("railPgCur", "railPgTot", NEW_RAIL_SYNC))


def migrate_page_counter(s):
    if has_page_counter(s):
        return s
    replacements = (
        (OLD_RAIL_CSS, NEW_RAIL_CSS, "railtoggle 样式"),
        (OLD_RAIL_BUTTON, NEW_RAIL_BUTTON, "railtoggle DOM"),
        (OLD_RAIL_SYNC, NEW_RAIL_SYNC, "页码同步逻辑"),
    )
    for old, _, label in replacements:
        count = s.count(old)
        if count != 1:
            raise MigrationError(
                f"无法安全迁移 {label}：应匹配 1 处，实际 {count} 处。"
                "该 Deck 的导航运行时可能被自定义过，请人工合并。"
            )
    for old, new, _ in replacements:
        s = s.replace(old, new)
    return s


MIGRATIONS = [
    Migration("page-counter-glass", "左上角 glass 胶囊实时 x/yy 页码", has_page_counter, migrate_page_counter),
]


def get_version(s):
    match = VERSION_RE.search(s)
    return match.group(1) if match else "未标记"


def set_version(s, version):
    marker = f'<meta name="huawei-deck-version" content="{version}">'
    if VERSION_RE.search(s):
        return VERSION_RE.sub(marker, s, count=1)
    anchor = '<meta charset="utf-8">'
    if s.count(anchor) != 1:
        raise MigrationError("无法写入版本标记：未唯一找到 <meta charset=\"utf-8\">。")
    return s.replace(anchor, anchor + "\n" + marker, 1)


def plan_migrations(s):
    return [migration for migration in MIGRATIONS if not migration.probe(s)]


def backup_path(path):
    base = path.with_name(path.stem + ".before-upgrade" + path.suffix)
    if not base.exists():
        return base
    i = 2
    while True:
        candidate = path.with_name(path.stem + f".before-upgrade-{i}" + path.suffix)
        if not candidate.exists():
            return candidate
        i += 1


def audit_template(s):
    findings = []
    section_re = re.compile(r'<section data-label="([^"]+)"[^>]*>(.*?)</section>', re.S)
    for label, block in section_re.findall(s):
        notes = []
        old_cards = len(re.findall(
            r'<div style="[^"]*background:#(?:fff|ffffff)[^"]*border:1px solid #[0-9a-fA-F]{6}[^"]*"',
            block,
        ))
        rounded = len(re.findall(r'border-radius:(?:14px|7px)', block))
        if old_cards and not rounded:
            notes.append(f"发现 {old_cards} 个白底边框容器，未检测到统一圆角")
        badges = block.count('data-role="delivery-force-badge"')
        if badges:
            notes.append(f"发现 {badges} 个说明性 badge，确认是否承载业务信息")
        red_frames = len(re.findall(
            r'border:(?:1|2|3)px solid #(?:b5333b|8d252c|d4001a)', block, re.I
        ))
        if red_frames:
            notes.append(f"发现 {red_frames} 个红色描边区域，确认是否均为关键强调")
        if "<svg" in block:
            notes.append("包含 SVG：需截图检查文字边界、箭头方向和连线端点")
        if notes:
            findings.append((label, notes))
    return findings


def format_audit(path, version, findings):
    out = [
        f"# Deck 升级审计：{path.name}",
        "",
        f"- 当前版本：{version}",
        f"- 目标版本：{CURRENT_VERSION}",
        f"- 需人工复核页面：{len(findings)}",
        "",
    ]
    if not findings:
        out.append("未发现需要人工复核的已知视觉模式。")
    for label, notes in findings:
        out.append(f"## {label}")
        out.append("")
        out.extend(f"- {note}" for note in notes)
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def main():
    parser = argparse.ArgumentParser(description="升级旧 Huawei Deck 的公共运行时并审计视觉规范")
    parser.add_argument("deck", type=Path, help="待升级的单文件 HTML deck")
    parser.add_argument("--check", action="store_true", help="只检查版本和待迁移项；不修改")
    parser.add_argument("--yes", action="store_true", help="确认落盘；修改前自动生成备份")
    parser.add_argument("--audit", action="store_true", help="输出逐页视觉审计")
    parser.add_argument("--report", type=Path, help="把视觉审计写入 Markdown；隐含 --audit")
    args = parser.parse_args()

    path = args.deck.resolve()
    if not path.is_file():
        print(f"错误：文件不存在：{path}", file=sys.stderr)
        return 2
    if args.check and args.yes:
        print("错误：--check 与 --yes 不能同时使用。", file=sys.stderr)
        return 2

    try:
        lines = eb.load(path)
        original = eb.get_template(lines)
        version = get_version(original)
        pending = plan_migrations(original)
        needs_version = version != CURRENT_VERSION

        print(f"Deck：{path}")
        print(f"版本：{version} → {CURRENT_VERSION}")
        if pending:
            print("待迁移：")
            for migration in pending:
                print(f"  - {migration.key}：{migration.title}")
        else:
            print("待迁移：无")

        audit_requested = args.audit or args.report is not None
        findings = audit_template(original) if audit_requested else []
        if audit_requested:
            report = format_audit(path, version, findings)
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(report, encoding="utf-8")
                print(f"审计报告：{args.report.resolve()}")
            else:
                print("\n" + report.rstrip())

        if args.check:
            return 1 if pending or needs_version else 0
        if not args.yes:
            if pending or needs_version:
                print("\n预览完成，未修改文件。确认后加 --yes 执行升级。")
            else:
                print("\n当前 Deck 已是最新版本。")
            return 0

        if not pending and not needs_version:
            print("当前 Deck 已是最新版本，未写入文件。")
            return 0

        upgraded = original
        for migration in pending:
            upgraded = migration.apply(upgraded)
        upgraded = set_version(upgraded, CURRENT_VERSION)

        backup = backup_path(path)
        shutil.copy2(path, backup)
        eb.set_template(lines, upgraded)
        eb.save(path, lines)
        eb.verify(path)
        print(f"备份：{backup}")
        print(f"升级完成：{version} → {CURRENT_VERSION}")
        return 0
    except (AssertionError, MigrationError, RuntimeError, ValueError) as exc:
        print(f"升级失败：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
