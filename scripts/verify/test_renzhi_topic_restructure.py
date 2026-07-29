# -*- coding: utf-8 -*-
import contextlib
import importlib.util
import io
import re
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DECK = ROOT / "Deck-Projects/renzhi/renzhi-deck.html"
EDIT_BUNDLE = ROOT / "scripts/edit-bundle.py"
PATCH_SCRIPT = ROOT / "scripts/patch_renzhi_topic_restructure.py"

spec = importlib.util.spec_from_file_location("eb", EDIT_BUNDLE)
eb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eb)

patch_spec = importlib.util.spec_from_file_location(
    "patch_renzhi_topic_restructure",
    PATCH_SCRIPT,
)
patch = importlib.util.module_from_spec(patch_spec)
patch_spec.loader.exec_module(patch)

EXPECTED_LABELS = [
    "封面页", "目录页", "工作经历", "主要项目", "目录页", "专业知识",
    "kc-resp-proj", "kc-sol-agent", "kc-iss-cad", "kc-iss-ctc",
    "kc-mgmt", "kc-comm", "kc-resp-cap", "kc-train-outcomes",
    "kc-sol-a3", "专业回馈", "目录页", "ai-coding-reflection",
    "反思建议", "待改进", "结语",
]

REQUIRED_TEXT = {
    "专业知识": [
        "IT Operations Platform",
        "Model Training Taskforce",
    ],
    "kc-resp-proj": [
        "Middle-Lane + Lower-Lane Agents",
        "X+ Field Practice",
        "Cluster Integration Agent",
        "OCC",
        "57",
        "220+",
        "85%+",
    ],
    "kc-mgmt": [
        "Performance Baseline Retrieval",
        "Workflow + Agentic Workflow",
        "Skills × Knowledge",
        "Technical Governance",
        "All sprint items closed; core migration modules delivered; security inspection passed; HIS production online.",
    ],
    "kc-train-outcomes": [
        "A5 Architecture Evolution",
        "Training Infra Impact",
        "Qwen2.5-7B GRPO",
        "2,000+",
        "98%+",
    ],
    "kc-sol-a3": [
        "Architecture-Aware Proxy Model",
        "Prune Layers",
        "Reduce Total Experts",
        "Engineering Estimate",
        "No Full-Scale Blind Validation",
    ],
    "ai-coding-reflection": [
        "AI Coding in Infra & Agent Development",
        "Practice",
        "Boundaries",
        "Engineering Judgment",
        "Verification",
    ],
}

FORBIDDEN_TEXT = {
    "kc-sol-a3": [
        "Blind Validation Passed",
        "Full-Scale Accuracy Verified",
        "Keep Experts Unchanged",
    ],
    "kc-mgmt": [
        "Dual-Track Integrated Delivery Flow",
        "People Assignment & Growth Map",
    ],
}


def section_html(template, label):
    start = template.find(f'<section data-label="{label}"')
    assert start >= 0, f"页面不存在: {label}"
    end = template.find("</section>", start)
    assert end >= 0, f"页面未闭合: {label}"
    return template[start:end + len("</section>")]


def assert_idempotence_validation():
    original_deck = patch.DECK
    try:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = patch.main()
        assert result == 0
        assert output.getvalue() == "deck 已是双专题完成态，未重复修改\n"

        cases = [
            (
                "数量",
                "      { i:20, code:'致谢', label:'结语' },\n",
                "",
            ),
            (
                "序号",
                "{ i:0, code:'Start', label:'封面页' }",
                "{ i:9, code:'Start', label:'封面页' }",
            ),
            (
                "label",
                "{ i:0, code:'Start', label:'封面页' }",
                "{ i:0, code:'Start', label:'损坏页' }",
            ),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            for name, old, new in cases:
                corrupted = Path(temp_dir) / f"corrupted-{name}.html"
                shutil.copy2(DECK, corrupted)
                lines = eb.load(corrupted)
                template = eb.get_template(lines)
                assert template.count(old) == 1, f"无法构造 nav {name}损坏场景"
                template = template.replace(old, new, 1)
                eb.set_template(lines, template)
                eb.save(corrupted, lines)

                patch.DECK = corrupted
                output = io.StringIO()
                try:
                    with contextlib.redirect_stdout(output):
                        patch.main()
                except RuntimeError as error:
                    expected_error = "导航 label" if name == "label" else f"导航{name}"
                    assert expected_error in str(error), str(error)
                else:
                    raise AssertionError(f"完成态快路径未拒绝 nav {name}损坏")
                assert output.getvalue() == "", f"nav {name}损坏时不应打印幂等成功提示"
    finally:
        patch.DECK = original_deck


def main():
    lines = eb.load(DECK)
    template = eb.get_template(lines)
    labels = re.findall(r'<section\b[^>]*data-label="([^"]+)"', template)
    assert labels == EXPECTED_LABELS, f"页面顺序错误:\n{labels}"
    starts = [
        int(value)
        for value in re.findall(r"name:'[^']+', start:(\d+)", template)
    ]
    assert starts == [2, 5, 17], f"章节起点错误: {starts}"
    assert template.count('class="slide-fit"') == 21
    assert template.count("<section data-label=") == 21

    for label, tokens in REQUIRED_TEXT.items():
        block = section_html(template, label)
        for token in tokens:
            assert token in block, f"{label} 缺少文案: {token}"

    for label, tokens in FORBIDDEN_TEXT.items():
        block = section_html(template, label)
        for token in tokens:
            assert token not in block, f"{label} 仍含禁用文案: {token}"

    blocks = re.findall(
        r'<div class="slide-fit"[^>]*>.*?</section>\s*</div></div>',
        template,
        flags=re.S,
    )
    assert len(blocks) == 21
    for page_number, block in enumerate(blocks, start=1):
        idx = re.search(r'data-idx="(\d+)"', block)
        assert idx and int(idx.group(1)) == page_number - 1
        if "HUAWEI TECHNOLOGIES CO., LTD." in block:
            marker = re.search(r">Page (\d+)<", block)
            assert marker and int(marker.group(1)) == page_number

    assert_idempotence_validation()
    eb.verify(DECK)
    print("PASS: renzhi topic restructure")


if __name__ == "__main__":
    main()
