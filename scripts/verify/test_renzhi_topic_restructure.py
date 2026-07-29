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
        "Model Migration & Tuning Agent",
        "X+ Field Practice",
        "Cluster Integration Agent",
        "OCC",
        "57",
        "220+",
        "85%+",
        "Source: AICO platform and integrated-delivery operating records",
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
        "Qwen2.5-7B GRPO; 20% improvement on AIME / MATH; 8 acceleration features validated across MS-RL and VeRL.",
        "2,000+",
        "98%+",
        "Model Structure & Algorithms",
        "MoE · SFT · DPO · GRPO",
        "Training Frameworks",
        "VeRL · Ray · Megatron · MindSpeed",
        "Parallelism & Resources",
        "TP · PP · EP · DP · HBM · Offload",
        "Runtime & Kernels",
        "CANN · HCCL · AICPU · Operators",
    ],
    "kc-sol-a3": [
        "Architecture-Aware Proxy Model",
        "Prune Layers",
        "Reduce Total Experts",
        "Engineering Estimate",
        "No Full-Scale Blind Validation",
        "Mresident ∝ Ptotal",
        "Ftoken ∝ Pactive",
        "Attention time · MoE time · peak HBM · rollout / logprob / actor-update phases",
        "calibration on the target environment",
    ],
    "ai-coding-reflection": [
        "AI Coding in Infra & Agent Development",
        "Practice",
        "Boundaries",
        "Engineering Judgment",
        "Verification",
        "Infra Development",
        "Agent Development",
        "Human Accountability",
    ],
}

FORBIDDEN_TEXT = {
    "专业知识": [
        "Architecture Design → Technical Breakthroughs → Scaled Validation → Capability Assets",
        "Two connected themes turn engineering practice into repeatable delivery capability.",
    ],
    "kc-sol-a3": [
        "Blind Validation Passed",
        "Full-Scale Accuracy Verified",
        "Keep Experts Unchanged",
    ],
    "kc-mgmt": [
        "Dual-Track Integrated Delivery Flow",
        "People Assignment & Growth Map",
    ],
    "kc-train-outcomes": [
        "interconnect bandwidth",
        "HBM capacity",
        "chip count",
        "TB/s",
    ],
}

EXPECTED_STEPS = {
    "kc-train-outcomes": {0, 1, 2, 3},
    "kc-sol-a3": {0, 1, 2, 3, 4},
    "ai-coding-reflection": {0, 1, 2, 3},
}


def section_html(template, label):
    start = template.find(f'<section data-label="{label}"')
    assert start >= 0, f"页面不存在: {label}"
    end = template.find("</section>", start)
    assert end >= 0, f"页面未闭合: {label}"
    return template[start:end + len("</section>")]


def replace_section(template, label, replacement):
    old = section_html(template, label)
    return template.replace(old, replacement, 1)


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

            corruption_cases = []

            source = "Source: AICO platform and integrated-delivery operating records"
            assert source in eb.get_template(eb.load(DECK))
            corruption_cases.append(
                (
                    "关键内容",
                    lambda template: template.replace(source, "", 1),
                    "关键内容",
                )
            )

            def corrupt_steps(template):
                block = section_html(template, "kc-train-outcomes")
                assert block.count('data-step="3"') >= 1
                return replace_section(
                    template,
                    "kc-train-outcomes",
                    block.replace('data-step="3"', 'data-step="2"'),
                )

            corruption_cases.append(("动画步骤", corrupt_steps, "动画步骤"))

            def inject_a5_hardware_fact(template):
                block = section_html(template, "kc-train-outcomes")
                corrupted = block.replace(
                    "</section>",
                    "<div>A5 interconnect bandwidth: 1.6 TB/s.</div></section>",
                    1,
                )
                return replace_section(
                    template,
                    "kc-train-outcomes",
                    corrupted,
                )

            corruption_cases.append(
                ("A5 禁止性硬件事实", inject_a5_hardware_fact, "A5 禁止")
            )

            def inject_removed_overview_copy(template):
                block = section_html(template, "专业知识")
                removed_copy = (
                    "Architecture Design → Technical Breakthroughs → "
                    "Scaled Validation → Capability Assets"
                )
                assert removed_copy not in block
                corrupted = block.replace(
                    "</section>",
                    f"<div>{removed_copy}</div></section>",
                    1,
                )
                return replace_section(template, "专业知识", corrupted)

            corruption_cases.append(
                ("已删除总览文案", inject_removed_overview_copy, "已删除文案")
            )

            for name, corrupt, expected_error in corruption_cases:
                corrupted = Path(temp_dir) / f"corrupted-{name}.html"
                shutil.copy2(DECK, corrupted)
                lines = eb.load(corrupted)
                template = corrupt(eb.get_template(lines))
                eb.set_template(lines, template)
                eb.save(corrupted, lines)

                patch.DECK = corrupted
                output = io.StringIO()
                try:
                    with contextlib.redirect_stdout(output):
                        patch.main()
                except RuntimeError as error:
                    assert expected_error in str(error), str(error)
                else:
                    raise AssertionError(f"完成态快路径未拒绝{name}")
                assert output.getvalue() == "", f"{name}时不应打印幂等成功提示"
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

    for label, expected_steps in EXPECTED_STEPS.items():
        block = section_html(template, label)
        actual_steps = {
            int(value)
            for value in re.findall(r'data-step="(\d+)"', block)
        }
        assert actual_steps == expected_steps, (
            f"{label} 动画步骤错误: {sorted(actual_steps)}"
        )

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
