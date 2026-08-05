#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""旧 Deck 升级器：以当前模板重组公共外壳，保留用户内容与资源。

默认只预览；加 --yes 才落盘。公共外壳通过稳定 seam 计算指纹，不逐项理解
页码、缩放或放映功能；模板外壳一变，历史 Deck 就自动换到最新版。
"""

import argparse
import difflib
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
CURRENT_VERSION = "2026.08.2"
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


USER_STYLE_START = "<!-- HUAWEI_DECK_USER_STYLE_START -->"
USER_STYLE_END = "<!-- HUAWEI_DECK_USER_STYLE_END -->"
USER_SCRIPT_START = "<!-- HUAWEI_DECK_USER_SCRIPT_START -->"
USER_SCRIPT_END = "<!-- HUAWEI_DECK_USER_SCRIPT_END -->"
HASH_RE = re.compile(r'<meta name="huawei-deck-runtime-hash" content="([^"]+)">')
KIND_RE = re.compile(r'<meta name="huawei-deck-template-kind" content="([^"]+)">')
LATEST_TEMPLATES = {
    "teaching": REPO / "assets" / "template-deck.html",
    "tech-share": REPO / "assets" / "tech-share-deck.html",
    "work-report": REPO / "assets" / "work-report-deck.html",
}


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


LEGACY_RUNTIME_MARKERS = (
    '<div class="app"',
    'class="stage" id="stage"',
    'class="slide-fit"',
    '<section data-label=',
    'const nav = [',
    'const chapters = [',
    'id="railtoggle"',
)


def is_recomposable(s):
    """核心内容结构完整时允许重组公共外壳。"""
    if not all(marker in s for marker in LEGACY_RUNTIME_MARKERS):
        return False
    try:
        _slide_bounds(s)
        _array_bounds(s, "nav")
        _array_bounds(s, "chapters")
    except MigrationError:
        return False
    return True


def _slide_bounds(s):
    labels = re.findall(r'<section data-label="([^"]+)"', s)
    if not labels:
        raise MigrationError("无法识别页面区：未找到 section data-label。")
    first_section = s.find(f'<section data-label="{labels[0]}"')
    start = s.rfind('<div class="slide-fit"', 0, first_section)
    last_section = s.find(f'<section data-label="{labels[-1]}"')
    end = s.find('</div></div>', s.find('</section>', last_section))
    if start < 0 or end < 0:
        raise MigrationError("无法唯一识别早期 Deck 的页面容器边界。")
    return start, end + len('</div></div>')


def _array_bounds(s, name):
    anchor = f"const {name} = ["
    start = s.find(anchor)
    end = s.find('];', start)
    if start < 0 or end < 0 or s.find(anchor, start + 1) >= 0:
        raise MigrationError(f"无法唯一识别 {name}[]。")
    return start, end + 2


def _slot_content(s, start_marker, end_marker):
    starts, ends = s.count(start_marker), s.count(end_marker)
    if starts == ends == 0:
        return ""
    if starts != 1 or ends != 1:
        raise MigrationError(f"用户扩展槽标记不完整：{start_marker}")
    start = s.find(start_marker) + len(start_marker)
    end = s.find(end_marker, start)
    if end < start:
        raise MigrationError(f"用户扩展槽顺序错误：{start_marker}")
    return s[start:end]


def _replace_slot(s, start_marker, end_marker, content):
    start = s.find(start_marker)
    end = s.find(end_marker, start)
    if start < 0 or end < 0:
        raise MigrationError(f"最新模板缺少用户扩展槽：{start_marker}")
    inner_start = start + len(start_marker)
    return s[:inner_start] + content + s[end:]


def _profile_style(s):
    start = s.find('<style id="tpl-bg-950">')
    if start < 0:
        return ""
    end = s.find('</style>', start)
    if end < 0:
        raise MigrationError("页面背景 profile 样式未闭合。")
    return s[start:end + len('</style>')]


def _profile_element(s, pattern):
    match = re.search(pattern, s, re.S)
    return match.group(0) if match else ""


def _replace_profile(result, latest_block, user_block, label):
    if not user_block:
        return result
    if not latest_block or result.count(latest_block) != 1:
        raise MigrationError(f"最新模板无法唯一定位 {label}。")
    return result.replace(latest_block, user_block, 1)


def extract_user_content(s):
    if not is_recomposable(s):
        raise MigrationError("无法唯一识别页面、导航或章节，不能安全重组公共外壳。")
    slide_start, slide_end = _slide_bounds(s)
    nav_start, nav_end = _array_bounds(s, "nav")
    chapter_start, chapter_end = _array_bounds(s, "chapters")
    title = re.search(r'<title>.*?</title>', s, re.S)
    return {
        "slides": s[slide_start:slide_end],
        "nav": s[nav_start:nav_end],
        "chapters": s[chapter_start:chapter_end],
        "title": title.group(0) if title else "",
        "user_style": _slot_content(s, USER_STYLE_START, USER_STYLE_END),
        "user_script": _slot_content(s, USER_SCRIPT_START, USER_SCRIPT_END),
        "profile_style": _profile_style(s),
        "brand_button": _profile_element(
            s, r'<button\b[^>]*\bid="brandbtn"[^>]*>.*?</button>'
        ),
        "brand_logo": _profile_element(
            s, r'<img\b(?=[^>]*(?:data-brand-logo|alt="HUAWEI"))[^>]*>'
        ),
    }


def _replace_user_references(content, old, new):
    return {key: value.replace(old, new) for key, value in content.items()}


def compose_latest(latest, content):
    slide_start, slide_end = _slide_bounds(latest)
    result = latest[:slide_start] + content["slides"] + latest[slide_end:]
    for name in ("nav", "chapters"):
        start, end = _array_bounds(result, name)
        result = result[:start] + content[name] + result[end:]
    if content["title"]:
        result = re.sub(r'<title>.*?</title>', content["title"], result, count=1, flags=re.S)
    result = _replace_slot(result, USER_STYLE_START, USER_STYLE_END, content["user_style"])
    result = _replace_slot(result, USER_SCRIPT_START, USER_SCRIPT_END, content["user_script"])
    result = _replace_profile(
        result, _profile_style(latest), content["profile_style"], "页面背景 profile"
    )
    result = _replace_profile(
        result,
        _profile_element(latest, r'<button\b[^>]*\bid="brandbtn"[^>]*>.*?</button>'),
        content["brand_button"],
        "品牌标题",
    )
    result = _replace_profile(
        result,
        _profile_element(latest, r'<img\b(?=[^>]*(?:data-brand-logo|alt="HUAWEI"))[^>]*>'),
        content["brand_logo"],
        "品牌 Logo",
    )
    return result


def _normalize_runtime(s):
    """删除用户拥有区域，返回只代表 Skill 公共外壳的稳定文本。"""
    content = extract_user_content(s)
    slide_start, slide_end = _slide_bounds(s)
    result = s[:slide_start] + "__HUAWEI_DECK_SLIDES__" + s[slide_end:]
    for name in ("nav", "chapters"):
        start, end = _array_bounds(result, name)
        result = result[:start] + f"__HUAWEI_DECK_{name.upper()}__" + result[end:]
    result = re.sub(r'<title>.*?</title>', "__HUAWEI_DECK_TITLE__", result, count=1, flags=re.S)
    if USER_STYLE_START in result and USER_STYLE_END in result:
        result = _replace_slot(result, USER_STYLE_START, USER_STYLE_END, "__USER_STYLE__")
    else:
        result += "__NO_USER_STYLE_SLOT__"
    if USER_SCRIPT_START in result and USER_SCRIPT_END in result:
        result = _replace_slot(result, USER_SCRIPT_START, USER_SCRIPT_END, "__USER_SCRIPT__")
    else:
        result += "__NO_USER_SCRIPT_SLOT__"
    result = VERSION_RE.sub('<meta name="huawei-deck-version" content="__VERSION__">', result)
    result = HASH_RE.sub('<meta name="huawei-deck-runtime-hash" content="__HASH__">', result)
    result = KIND_RE.sub('<meta name="huawei-deck-template-kind" content="__KIND__">', result)
    profile = _profile_style(result)
    if profile:
        result = result.replace(profile, "__PAGE_PROFILE_STYLE__", 1)
    brand = _profile_element(result, r'<button\b[^>]*\bid="brandbtn"[^>]*>.*?</button>')
    if brand:
        result = result.replace(brand, "__BRAND_BUTTON__", 1)
    logo = _profile_element(
        result, r'<img\b(?=[^>]*(?:data-brand-logo|alt="HUAWEI"))[^>]*>'
    )
    if logo:
        result = result.replace(logo, "__BRAND_LOGO__", 1)
    return result


def runtime_hash(s):
    return hashlib.sha256(_normalize_runtime(s).encode("utf-8")).hexdigest()


def set_runtime_hash(s, value):
    marker = f'<meta name="huawei-deck-runtime-hash" content="{value}">'
    if HASH_RE.search(s):
        return HASH_RE.sub(marker, s, count=1)
    version = VERSION_RE.search(s)
    if not version:
        raise MigrationError("写入运行时指纹前未找到版本标记。")
    return s[:version.end()] + "\n" + marker + s[version.end():]


def get_template_kind(s):
    match = KIND_RE.search(s)
    return match.group(1) if match else ""


def set_template_kind(s, kind):
    marker = f'<meta name="huawei-deck-template-kind" content="{kind}">'
    if KIND_RE.search(s):
        return KIND_RE.sub(marker, s, count=1)
    version = VERSION_RE.search(s)
    if not version:
        raise MigrationError("写入模板类型前未找到版本标记。")
    return s[:version.end()] + "\n" + marker + s[version.end():]


def _similarity_surface(s):
    """模板类型识别只移除页面、导航、章节和标题；保留各模板 profile 差异。"""
    slide_start, slide_end = _slide_bounds(s)
    result = s[:slide_start] + "__SLIDES__" + s[slide_end:]
    for name in ("nav", "chapters"):
        start, end = _array_bounds(result, name)
        result = result[:start] + f"__{name.upper()}__" + result[end:]
    result = re.sub(r'<title>.*?</title>', "__TITLE__", result, count=1, flags=re.S)
    result = VERSION_RE.sub("", result)
    result = HASH_RE.sub("", result)
    result = KIND_RE.sub("", result)
    return result.splitlines()


def select_latest_template(s):
    kind = get_template_kind(s)
    if kind in LATEST_TEMPLATES:
        return kind, eb.load(LATEST_TEMPLATES[kind])
    if "技术分享模板" in s:
        return "tech-share", eb.load(LATEST_TEMPLATES["tech-share"])
    if "工作汇报模板" in s:
        return "work-report", eb.load(LATEST_TEMPLATES["work-report"])
    if not is_recomposable(s):
        raise MigrationError("无法识别模板类型：Deck 核心结构不完整。")
    old_surface = _similarity_surface(s)
    scored = []
    for candidate, path in LATEST_TEMPLATES.items():
        latest = eb.get_template(eb.load(path))
        ratio = difflib.SequenceMatcher(
            None, old_surface, _similarity_surface(latest), autojunk=False
        ).ratio()
        scored.append((ratio, candidate, path))
    ratio, kind, path = max(scored)
    return kind, eb.load(path)


def _merge_normalize(s):
    """三方合并用：只把用户页面数据换成稳定占位，保留壳内用户定制。"""
    start, end = _slide_bounds(s)
    result = s[:start] + "__HUAWEI_DECK_SLIDES__" + s[end:]
    for name in ("nav", "chapters"):
        start, end = _array_bounds(result, name)
        result = result[:start] + f"__HUAWEI_DECK_{name.upper()}__" + result[end:]
    result = re.sub(
        r'<title>.*?</title>', "__HUAWEI_DECK_TITLE__", result, count=1, flags=re.S
    )
    result = VERSION_RE.sub("", result)
    result = HASH_RE.sub("", result)
    result = KIND_RE.sub("", result)
    for start_marker, end_marker in (
        (USER_STYLE_START, USER_STYLE_END),
        (USER_SCRIPT_START, USER_SCRIPT_END),
    ):
        if start_marker in result:
            start = result.find(start_marker)
            end = result.find(end_marker, start)
            if end < 0:
                raise MigrationError(f"用户扩展槽未闭合：{start_marker}")
            result = result[:start] + result[end + len(end_marker):]
    return result


def _git(*args):
    try:
        return subprocess.check_output(
            ["git", "-c", f"safe.directory={REPO}", *args],
            cwd=REPO,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise MigrationError("历史 Deck 安全升级需要 Skill 仓库的 Git 历史。") from exc


def find_legacy_baseline(s, template_kind):
    path = LATEST_TEMPLATES[template_kind].relative_to(REPO).as_posix()
    commits = _git("log", "--format=%H", "--", path).splitlines()
    if not commits:
        raise MigrationError(f"未找到 {template_kind} 模板历史基线。")
    target = _similarity_surface(s)
    candidates = []
    for commit in commits:
        try:
            raw = _git("show", f"{commit}:{path}")
            candidate = eb.get_template(raw.split('\n'))
            score = difflib.SequenceMatcher(
                None, target, _similarity_surface(candidate), autojunk=False
            ).ratio()
            candidates.append((score, commit, candidate))
        except (MigrationError, RuntimeError, ValueError):
            continue
    if not candidates:
        raise MigrationError(f"无法解析 {template_kind} 的历史模板。")
    return max(candidates, key=lambda item: item[0])


def merge_legacy_shell(original, latest, template_kind, content):
    score, commit, baseline = find_legacy_baseline(original, template_kind)
    with tempfile.TemporaryDirectory() as directory:
        paths = []
        for name, value in (
            ("user", original), ("base", baseline), ("latest", latest)
        ):
            path = Path(directory) / name
            path.write_text(_merge_normalize(value), encoding="utf-8")
            paths.append(path)
        result = subprocess.run(
            ["git", "merge-file", "-p", *(str(path) for path in paths)],
            text=True,
            capture_output=True,
        )
    if result.returncode != 0 or "<<<<<<<" in result.stdout:
        raise MigrationError(
            f"历史模板三方合并冲突（基线 {commit[:8]}，相似度 {score:.3f}），已停止写入。"
        )
    merged = result.stdout
    replacements = {
        "__HUAWEI_DECK_SLIDES__": content["slides"],
        "__HUAWEI_DECK_NAV__": content["nav"],
        "__HUAWEI_DECK_CHAPTERS__": content["chapters"],
        "__HUAWEI_DECK_TITLE__": content["title"],
    }
    for marker, value in replacements.items():
        if marker == "__HUAWEI_DECK_TITLE__" and not value and marker not in merged:
            continue
        if merged.count(marker) != 1:
            raise MigrationError(f"三方合并结果缺少唯一占位：{marker}")
        merged = merged.replace(marker, value, 1)
    # 历史模板没有扩展槽；升级后接入当前 seam，后续不再依赖 Git 基线。
    latest_style_slot = (
        USER_STYLE_START
        + _slot_content(latest, USER_STYLE_START, USER_STYLE_END)
        + USER_STYLE_END
    )
    latest_script_slot = (
        USER_SCRIPT_START
        + _slot_content(latest, USER_SCRIPT_START, USER_SCRIPT_END)
        + USER_SCRIPT_END
    )
    if USER_STYLE_START not in merged:
        merged = merged.replace('</head>', latest_style_slot + '\n</head>', 1)
    if USER_SCRIPT_START not in merged:
        merged = merged.replace('</body>', latest_script_slot + '\n</body>', 1)
    merged = _replace_slot(
        merged, USER_STYLE_START, USER_STYLE_END, content["user_style"]
    )
    merged = _replace_slot(
        merged, USER_SCRIPT_START, USER_SCRIPT_END, content["user_script"]
    )
    return merged, commit, score


def runtime_surface(s):
    """用于判断最新公共外壳实际引用了哪些 manifest 资源。"""
    return _normalize_runtime(s)


def merge_manifests(old_manifest, latest_manifest, latest, content):
    merged = dict(old_manifest)
    surface = runtime_surface(latest)
    required = {uid: entry for uid, entry in latest_manifest.items() if uid in surface}
    for uid, entry in required.items():
        if uid in merged and merged[uid] != entry:
            seed = uid + json.dumps(merged[uid], sort_keys=True, ensure_ascii=False)
            replacement = "legacy-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
            while replacement in merged or replacement in required:
                replacement += "x"
            content = _replace_user_references(content, uid, replacement)
            merged[replacement] = merged.pop(uid)
        merged[uid] = entry
    return merged, content


def build_upgrade(old_lines, latest_lines, template_kind):
    original = eb.get_template(old_lines)
    latest = eb.get_template(latest_lines)
    content = extract_user_content(original)
    merged_manifest, content = merge_manifests(
        eb.get_manifest(old_lines), eb.get_manifest(latest_lines), latest, content
    )
    is_legacy = (
        not HASH_RE.search(original)
        or USER_STYLE_START not in original
        or USER_SCRIPT_START not in original
    )
    if is_legacy:
        upgraded, _, _ = merge_legacy_shell(
            original, latest, template_kind, content
        )
    else:
        upgraded = compose_latest(latest, content)
    upgraded = set_version(upgraded, CURRENT_VERSION)
    upgraded = set_template_kind(upgraded, template_kind)
    target_hash = runtime_hash(latest)
    upgraded = set_runtime_hash(upgraded, target_hash)
    return upgraded, merged_manifest, target_hash


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
    parser = argparse.ArgumentParser(description="按当前模板重组 Huawei Deck 公共外壳并审计视觉规范")
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
        template_kind, latest_lines = select_latest_template(original)
        latest = eb.get_template(latest_lines)
        version = get_version(original)
        target_hash = runtime_hash(latest)
        stored_hash = HASH_RE.search(original)
        stored_hash = stored_hash.group(1) if stored_hash else ""
        current_hash = (
            stored_hash
            if stored_hash
            else (runtime_hash(original) if is_recomposable(original) else "无法识别")
        )
        needs_runtime = current_hash != target_hash
        needs_version = version != CURRENT_VERSION
        needs_metadata = not stored_hash or get_template_kind(original) != template_kind

        print(f"Deck：{path}")
        print(f"模板类型：{template_kind}")
        print(f"版本：{version} → {CURRENT_VERSION}")
        print(f"公共外壳：{'需要同步到最新模板' if needs_runtime else '已与最新模板一致'}")
        print(f"运行时指纹：{current_hash[:12]} → {target_hash[:12]}")

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
            return 1 if needs_runtime or needs_version or needs_metadata else 0
        if not args.yes:
            if needs_runtime or needs_version or needs_metadata:
                print("\n预览完成，未修改文件。确认后加 --yes 执行升级。")
            else:
                print("\n当前 Deck 已是最新版本。")
            return 0

        if not needs_runtime and not needs_version and not needs_metadata:
            print("当前 Deck 已是最新版本，未写入文件。")
            return 0

        upgraded, merged_manifest, target_hash = build_upgrade(
            lines, latest_lines, template_kind
        )

        backup = backup_path(path)
        shutil.copy2(path, backup)
        eb.set_template(lines, upgraded)
        eb.set_manifest(lines, merged_manifest)
        eb.save(path, lines)
        eb.verify(path)
        print(f"备份：{backup}")
        print(f"升级完成：{version} → {CURRENT_VERSION}；运行时 {target_hash[:12]}")
        return 0
    except (AssertionError, MigrationError, RuntimeError, ValueError) as exc:
        print(f"升级失败：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
