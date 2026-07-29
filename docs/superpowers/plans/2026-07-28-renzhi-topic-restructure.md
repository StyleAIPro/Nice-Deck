# 认知答辩 Deck 双专题重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `renzhi-deck.html` 从 19 页重构为 21 页双专题叙事，新增训战产出与 AI Coding 页面，并重做技术治理和 A3 算力估算页面。

**架构：** 使用一个可重复执行的 Python 补丁脚本加载 bundle template，通过 `scripts/edit-bundle.py` 完成同章移页、跨章插页和安全回填。使用独立的结构/内容断言脚本先失败后通过，再用 overflow、单页截图和逐拍截图完成视觉验证。

**技术栈：** Python 3 标准库、`scripts/edit-bundle.py`、单文件 HTML/CSS/SVG、Node.js、Chrome、Playwright。

---

## 文件职责

- 修改：`Deck-Projects/renzhi/renzhi-deck.html`
  - 21 页最终交付 deck。
  - 只能由补丁脚本经 `edit-bundle.py` 修改。
- 创建：`scripts/patch_renzhi_topic_restructure.py`
  - 封装页面重排、页面替换、新页插入、页码重编号和 bundle 保存。
  - 多次运行时通过完成态检测安全退出，不重复插页。
- 创建：`scripts/verify/test_renzhi_topic_restructure.py`
  - 校验 21 页顺序、章节起点、关键页面文案、禁止性表述和页码连续性。
- 参考：`docs/superpowers/specs/2026-07-28-renzhi-topic-restructure-design.md`
  - 已确认的内容与布局边界。
- 参考：`Deck-Projects/renzhi/项目资料/case_sharing_summary.md`
  - 专业回馈和 AI Coding 实际产出证据。
- 参考：`Deck-Projects/renzhi/项目资料/AICO智能化作业平台建设与新型作业模式分享-v4.pptx`
  - OCC、新作业模式和规模数据来源；只读，不修改。

## 完成态页面顺序

```python
EXPECTED_LABELS = [
    "封面页",
    "目录页",
    "工作经历",
    "主要项目",
    "目录页",
    "专业知识",
    "kc-resp-proj",
    "kc-sol-agent",
    "kc-iss-cad",
    "kc-iss-ctc",
    "kc-mgmt",
    "kc-comm",
    "kc-resp-cap",
    "kc-train-outcomes",
    "kc-sol-a3",
    "专业回馈",
    "目录页",
    "ai-coding-reflection",
    "反思建议",
    "待改进",
    "结语",
]
```

完成态章节起点为零基索引 `[2, 5, 17]`，分别对应第 3、6、18 页。

---

### 任务 1：建立依赖与当前基线

**文件：**
- 检查：`Deck-Projects/renzhi/renzhi-deck.html`
- 检查：`scripts/check_deps.py`

- [ ] **步骤 1：确认依赖，不修改环境**

运行：

```bash
python3 scripts/check_deps.py --check-only
```

预期：退出码为 0；Node、Chrome 和 playwright-core 均显示就绪。若退出码为 1，只按脚本给出的缺失项说明处理，不在此步骤修改 deck。

- [ ] **步骤 2：保存可恢复基线**

运行：

```bash
cp Deck-Projects/renzhi/renzhi-deck.html /tmp/renzhi-deck-before-topic-restructure.html
shasum -a 256 Deck-Projects/renzhi/renzhi-deck.html /tmp/renzhi-deck-before-topic-restructure.html
```

预期：两个 SHA-256 完全相同。

- [ ] **步骤 3：验证当前 bundle**

运行：

```bash
python3 scripts/edit-bundle.py Deck-Projects/renzhi/renzhi-deck.html
```

预期：

```text
slide-fit=19  sections=19  nav=19  nav_seq_ok=True
```

章节起点应为 `2, 5, 16`。

---

### 任务 2：先写结构与内容验收测试

**文件：**
- 创建：`scripts/verify/test_renzhi_topic_restructure.py`
- 测试：`Deck-Projects/renzhi/renzhi-deck.html`

- [ ] **步骤 1：创建完成态断言脚本**

实现以下完整结构：

```python
# -*- coding: utf-8 -*-
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DECK = ROOT / "Deck-Projects/renzhi/renzhi-deck.html"
EDIT_BUNDLE = ROOT / "scripts/edit-bundle.py"

spec = importlib.util.spec_from_file_location("eb", EDIT_BUNDLE)
eb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eb)

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


def main():
    lines = eb.load(DECK)
    template = eb.get_template(lines)
    labels = re.findall(r'<section\b[^>]*data-label="([^"]+)"', template)
    assert labels == EXPECTED_LABELS, f"页面顺序错误:\n{labels}"
    starts = [int(value) for value in re.findall(r"start:(\d+)", template)]
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

    eb.verify(DECK)
    print("PASS: renzhi topic restructure")


if __name__ == "__main__":
    main()
```

- [ ] **步骤 2：运行测试并确认先失败**

运行：

```bash
python3 scripts/verify/test_renzhi_topic_restructure.py
```

预期：FAIL，首个失败原因是当前页面顺序仍为 19 页且缺少 `kc-train-outcomes`。

- [ ] **步骤 3：只提交测试脚本**

```bash
git add scripts/verify/test_renzhi_topic_restructure.py
git commit -m "test: 添加认知答辩双专题验收断言"
```

---

### 任务 3：创建可重复执行的 bundle 补丁骨架并完成页面重排

**文件：**
- 创建：`scripts/patch_renzhi_topic_restructure.py`
- 修改：`Deck-Projects/renzhi/renzhi-deck.html`
- 测试：`scripts/verify/test_renzhi_topic_restructure.py`

- [ ] **步骤 1：创建补丁脚本的加载、替换和重编号助手**

脚本必须包含以下接口：

```python
# -*- coding: utf-8 -*-
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DECK = ROOT / "Deck-Projects/renzhi/renzhi-deck.html"
EDIT_BUNDLE = ROOT / "scripts/edit-bundle.py"

spec = importlib.util.spec_from_file_location("eb", EDIT_BUNDLE)
eb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eb)

RED = "#b5333b"
INK = "#1a1a1c"
MUTED = "#6b7280"
BLUE = "#425d78"
GREEN = "#2f7d5c"
BG = "#eceef1"
WHITE = "#ffffff"

EXPECTED_LABELS = [
    "封面页", "目录页", "工作经历", "主要项目", "目录页", "专业知识",
    "kc-resp-proj", "kc-sol-agent", "kc-iss-cad", "kc-iss-ctc",
    "kc-mgmt", "kc-comm", "kc-resp-cap", "kc-train-outcomes",
    "kc-sol-a3", "专业回馈", "目录页", "ai-coding-reflection",
    "反思建议", "待改进", "结语",
]


def section_bounds(template, label):
    start = template.find(f'<section data-label="{label}"')
    assert start >= 0, label
    end = template.find("</section>", start)
    assert end >= 0, label
    return start, end + len("</section>")


def replace_section(template, label, new_section):
    start, end = section_bounds(template, label)
    assert new_section.startswith(f'<section data-label="{label}"')
    return template[:start] + new_section + template[end:]


def make_slide_block(index, section):
    return (
        f'<div class="slide-fit" data-idx="{index}"><div class="slide-canvas">\n'
        f'      {section}\n'
        "    </div></div>"
    )


def renumber_pages(template):
    matches = list(re.finditer(
        r'<div class="slide-fit"[^>]*>.*?</section>\s*</div></div>',
        template,
        flags=re.S,
    ))
    for page_number, match in reversed(list(enumerate(matches, start=1))):
        block = match.group(0)
        block = re.sub(
            r'data-idx="\d+"',
            f'data-idx="{page_number - 1}"',
            block,
            count=1,
        )
        if "HUAWEI TECHNOLOGIES CO., LTD." in block:
            block = re.sub(
                r">Page \d+<",
                f">Page {page_number}<",
                block,
                count=1,
            )
        template = template[:match.start()] + block + template[match.end():]
    return template
```

- [ ] **步骤 2：实现同章页面重排**

在 `main()` 中加载 template 后，按以下顺序移动已有页面：

```python
order_after_professional = [
    "kc-resp-proj",
    "kc-sol-agent",
    "kc-iss-cad",
    "kc-iss-ctc",
    "kc-mgmt",
    "kc-comm",
    "kc-resp-cap",
    "kc-sol-a3",
    "专业回馈",
]

anchor = "专业知识"
for label in order_after_professional:
    template = eb.move_page(template, label, after_label=anchor)
    anchor = label
```

这些页面都位于 `Self-Evaluation` 章节，`move_page()` 不改变章节起点。

- [ ] **步骤 3：为两个新增页面建立完整空白 section**

使用统一页面骨架，正文直接包含最终标题与三列/双栏容器，不使用临时占位文案：

```python
def page_shell(label, title, subtitle, body):
    return f'''<section data-label="{label}" style="width:100%;height:100%;position:relative;display:flex;flex-direction:column;background:{BG};font-family:'Noto Sans SC',sans-serif;color:{INK};overflow:hidden;box-sizing:border-box;">
<div style="padding:38px 58px 0;">
  <h2 style="margin:0;font-size:44px;font-weight:800;color:{RED};line-height:1.05;">{title}<span style="font-size:27px;"> — {subtitle}</span></h2>
  <div style="height:4px;background:{RED};margin-top:12px;border-radius:2px;"></div>
</div>
<div style="flex:1;min-height:0;padding:22px 58px 18px;">{body}</div>
<div style="height:34px;display:flex;align-items:center;padding:0 58px;font-size:14px;color:#5d6269;border-top:1px solid #d6d9de;">
  <span style="letter-spacing:.02em;">HUAWEI TECHNOLOGIES CO., LTD.</span>
  <span style="flex:1;text-align:center;">Huawei Confidential</span>
  <span style="margin-right:96px;">Page 1</span>
</div>
</section>'''
```

插页操作：

```python
train_block = make_slide_block(
    13,
    build_training_outcomes_section(),
)
template = eb.insert_page(
    template,
    train_block,
    before_label="kc-sol-a3",
    nav_code="训战",
    nav_label="kc-train-outcomes",
)

ai_coding_block = make_slide_block(
    17,
    build_ai_coding_section(),
)
template = eb.insert_page(
    template,
    ai_coding_block,
    before_label="反思建议",
    nav_code="AI码",
    nav_label="ai-coding-reflection",
)
```

插入完成后章节起点必须为 `[2, 5, 17]`。

- [ ] **步骤 4：保存完成态检测**

脚本开头增加：

```python
labels = re.findall(r'<section\b[^>]*data-label="([^"]+)"', template)
if "kc-train-outcomes" in labels or "ai-coding-reflection" in labels:
    assert labels == EXPECTED_LABELS, "检测到不完整的历史补丁，请从 /tmp 基线恢复后重跑"
    print("deck 已是双专题完成态，未重复修改")
    return
```

脚本末尾必须执行：

```python
template = renumber_pages(template)
eb.set_template(lines, template)
eb.save(DECK, lines)
eb.verify(DECK)
```

- [ ] **步骤 5：暂不运行补丁，提交脚本骨架**

```bash
git add scripts/patch_renzhi_topic_restructure.py
git commit -m "feat: 添加认知答辩 bundle 重构脚本"
```

---

### 任务 4：实现 P6、P7、P8、P13 的双专题入口与专题证据

**文件：**
- 修改：`scripts/patch_renzhi_topic_restructure.py`
- 生成：`Deck-Projects/renzhi/renzhi-deck.html`

- [ ] **步骤 1：重建 P6 双专题总览**

`build_professional_overview_section()` 使用左右两张主卡片：

```text
IT Operations Platform & New Delivery Model
Architecture Design → Technical Breakthroughs → Scaled Operations → Reusable Assets

Model Training Taskforce Incubation & Enablement
Model Understanding → Training Infra → Field Validation → Capability Multiplication
```

底部结论固定为：

```text
One engineering method across both tracks: understand the system, solve the bottleneck, verify with evidence, and turn experience into reusable capability.
```

P6 只承担阅读导航，不放项目数字。

- [ ] **步骤 2：重建 P7 专题一总体产出**

标题：

```text
IT Operations Platform & New Delivery Model
Middle-Lane + Lower-Lane Agents · X+ Field Practice · OCC Collaboration
```

页面正文必须包含三层：

```text
PLATFORM
Model Migration & Tuning Agents
Cluster Integration / Digital Twin Agent
Knowledge + Skills + Tooling Foundation

OPERATING MODEL
On-Site FAE ↔ OCC Operations Center ↔ Remote Experts ↔ Agent Platform

SCALE EVIDENCE
57 Projects
250+ Requests Received
220+ Requests Completed
85%+ OCC Closure Rate
30,000+ Knowledge Fragments
```

规模数据旁增加小字来源：

```text
Source: AICO platform and integrated-delivery operating records
```

- [ ] **步骤 3：调整 P8 标题和架构入口**

保留原 `kc-sol-agent` 的主体架构，不重画全部组件，只做以下精确替换：

```text
Model Migration & Tuning Agent Architecture
→
IT Operations Platform Architecture

Scenario-Driven Delivery Flow
→
Integrated On-Site / OCC / Remote-Expert Workflow
```

在平台能力层并列保留：

```text
Model Migration & Tuning
Cluster Integration / Digital Twin
Knowledge & Planning
Issue Localization
```

- [ ] **步骤 4：调整 P13 课题组总览**

标题改为：

```text
Model Training Taskforce Incubation & Enablement
```

左侧保留框架适配、性能调优、效果优化和项目支撑，右侧保留课程开发与讲师培养。顶部增加闭环：

```text
FIELD PROBLEMS → TECHNICAL TASKFORCE → METHODS & TOOLS → TRAINING ENABLEMENT → FIELD REUSE
```

- [ ] **步骤 5：在补丁脚本中注册四个页面替换**

```python
template = replace_section(
    template,
    "专业知识",
    build_professional_overview_section(),
)
template = replace_section(
    template,
    "kc-resp-proj",
    build_platform_outcomes_section(),
)
template = replace_section(
    template,
    "kc-sol-agent",
    build_platform_architecture_section(template),
)
template = replace_section(
    template,
    "kc-resp-cap",
    build_training_taskforce_section(),
)
```

- [ ] **步骤 6：提交双专题入口内容**

```bash
git add scripts/patch_renzhi_topic_restructure.py
git commit -m "feat: 重构认知答辩双专题入口"
```

---

### 任务 5：重做 P11 技术问题解决与技术治理

**文件：**
- 修改：`scripts/patch_renzhi_topic_restructure.py`
- 生成：`Deck-Projects/renzhi/renzhi-deck.html`

- [ ] **步骤 1：实现左侧三个技术问题卡片**

卡片一固定文案：

```text
01 · Performance Baseline Retrieval
Problem: rigid string matching returned no result or the wrong Top-1.
Solution: input normalization → multi-field SQL intersection → generative reranking.
Engineering contribution: converted unstructured intent into traceable structured constraints.
```

卡片二固定文案：

```text
02 · Agent Workflow Stability
Problem: fully agentic execution mixed evidence, logic and tool results.
Solution: Workflow + Agentic Workflow, separating fixed targets from moving targets.
Engineering contribution: deterministic gates for direction, model reasoning for open analysis.
```

卡片三固定文案：

```text
03 · Skills × Knowledge Co-evolution
Problem: fast-changing facts were hard-coded while reusable steps remained fragmented.
Solution: stable process in Skills; changing facts in the knowledge base; improve both from traces and BadCases.
Engineering contribution: made delivery knowledge executable, observable and continuously correctable.
```

- [ ] **步骤 2：实现右侧技术治理栏**

只保留以下两块：

```text
TECHNICAL GOVERNANCE
Goal → Owner → Evidence → Release Gate

CRITICAL-PATH RISK CLOSURE
Freeze noncritical features.
Protect productization and security gates.
Joint verification across backend, MCP, front end, security and HIS.
Outcome: core migration modules delivered, security inspection passed, HIS production online.
```

右栏宽度设置为 31%，左栏宽度为 67%，中间间距为 2%。

- [ ] **步骤 3：确认删除旧内容**

`build_technical_contribution_section()` 的输出不得包含：

```text
Dual-Track Integrated Delivery Flow
People Assignment & Growth Map
Architecture Design → Core Agents Ready → Pilot Validation
```

- [ ] **步骤 4：提交 P11 实现**

```bash
git add scripts/patch_renzhi_topic_restructure.py
git commit -m "feat: 强化技术问题解决与技术治理证据"
```

---

### 任务 6：实现 P14 训战产出

**文件：**
- 修改：`scripts/patch_renzhi_topic_restructure.py`
- 生成：`Deck-Projects/renzhi/renzhi-deck.html`

- [ ] **步骤 1：实现左侧 A5 → Training Infra 影响矩阵**

四行内容固定为：

```text
COMPUTE & TOPOLOGY
Affects TP / PP / EP / DP mapping and machine-granularity planning.

MEMORY HIERARCHY
Affects parameter, activation and optimizer-state placement, recomputation and offload.

COMMUNICATION PATH
Affects collective communication, compute–communication overlap and long-running stability.

SOFTWARE STACK & KERNELS
Affects Megatron / MindSpeed / VeRL adaptation, CANN kernels and version compatibility.
```

标题必须使用：

```text
A5 Architecture Evolution → Training Infra Impact
```

不出现 A5 的具体带宽、容量、芯片数或互联规格。

- [ ] **步骤 2：实现右侧训战成果时间轴**

按时间从上到下：

```text
2024–2025 · X1+
SFT / DPO capability building; train–inference feature validation; field issue closure.

2025–2026 · Training Taskforce
Qwen2.5-7B GRPO; 20% improvement on AIME / MATH; 8 acceleration features validated across MS-RL and VeRL.

2026 · A3 / A5
Training resource design from model structure, parallel strategy, HBM and communication constraints.

CAPABILITY MULTIPLICATION
2,000+ learners · 8+ instructors · 98%+ satisfaction
```

- [ ] **步骤 3：实现底部技术栈**

```text
MODEL STRUCTURE & ALGORITHMS
MoE · SFT · DPO · GRPO

TRAINING FRAMEWORKS
VeRL · Ray · Megatron · MindSpeed

PARALLELISM & RESOURCES
TP · PP · EP · DP · HBM · Offload

RUNTIME & KERNELS
CANN · HCCL · AICPU · Operators
```

四个块使用灰蓝色，只有“影响箭头”和关键结果使用品牌红。

- [ ] **步骤 4：动画节拍**

```text
step 0: A5 四类架构影响整体出现
step 1: X1+ 与训练课题组成果出现
step 2: A3/A5 与能力赋能出现
step 3: 四层产品知识栈出现
```

相关容器整体挂 `build`，禁止出现空框提前显示。

- [ ] **步骤 5：提交 P14 实现**

```bash
git add scripts/patch_renzhi_topic_restructure.py
git commit -m "feat: 新增 A5 训战产出页面"
```

---

### 任务 7：重做 P15 A3 结构驱动的算力工程估算

**文件：**
- 修改：`scripts/patch_renzhi_topic_restructure.py`
- 生成：`Deck-Projects/renzhi/renzhi-deck.html`

- [ ] **步骤 1：实现结构理解区**

必须包含：

```text
MODEL STRUCTURE ACCOUNTING
Total parameters → resident-weight memory
Active parameters → per-token compute
Layer count → repeated compute depth
Top-K + expert distribution + EP → routing and communication
```

配套公式：

```text
Mresident ∝ Ptotal
Ftoken ∝ Pactive
```

- [ ] **步骤 2：实现代理模型构造区**

流程固定为：

```text
FULL MoE MODEL
Preserve hidden size, attention heads, MoE block, Top-K and dtype
↓
PRUNE LAYERS
Reduce repeated compute depth
↓
REDUCE TOTAL EXPERTS
Reduce resident weights until the proxy fits one machine
↓
ARCHITECTURE-AWARE PROXY MODEL
Measure magnitude, not full-model equivalence
```

- [ ] **步骤 3：实现实测外推区**

```text
MEASURE ON ONE MACHINE
Attention time · MoE time · peak HBM · rollout / logprob / actor-update phases

ANALYTICAL EXTRAPOLATION
Restore full layers and total experts; add parallel groups, topology, EP communication and P95 tail factors.

ENGINEERING OUTPUT
Lower Bound · Planning Estimate · Risk Upper Bound
```

- [ ] **步骤 4：实现边界声明**

页面必须有高对比度边界框：

```text
ENGINEERING ESTIMATE — NO FULL-SCALE BLIND VALIDATION
Cross-node EP communication, load imbalance and P95 tail latency remain analytical assumptions. Calibrate in the target environment when resources become available.
```

删除旧页面中以下论述：

```text
Full-Width, Depth-Pruned Extrapolation
Keep experts unchanged
Blind test residual
Minimum-cost P95 pass
```

- [ ] **步骤 5：动画节拍**

```text
step 0: 模型结构核算
step 1: 剪层
step 2: 削减专家并形成单机代理模型
step 3: 实测与解析外推
step 4: 估算区间与边界声明
```

- [ ] **步骤 6：提交 P15 实现**

```bash
git add scripts/patch_renzhi_topic_restructure.py
git commit -m "feat: 重构 A3 结构驱动算力估算"
```

---

### 任务 8：实现 P18 AI Coding 开放技术反思

**文件：**
- 修改：`scripts/patch_renzhi_topic_restructure.py`
- 生成：`Deck-Projects/renzhi/renzhi-deck.html`

- [ ] **步骤 1：实现 Practice 双栏**

Infra 栏：

```text
INFRA DEVELOPMENT
Read VeRL / Ray / Megatron / MindSpeed call paths.
Generate instrumentation, logs and controlled experiments.
Patch version compatibility and source-level integration issues.
Automate distributed-training environment deployment and testing.
```

Agent 栏：

```text
AGENT DEVELOPMENT
Turn delivery workflows into Skills and MCP tools.
Build RAG, evaluation and BadCase improvement loops.
Rapidly develop AICO-PPT, AICO-Bot, distributed-training automation and document extraction.
```

- [ ] **步骤 2：实现 Boundaries**

```text
GOOD FIT
Code understanding · repetitive refactoring · test generation · log analysis · tool orchestration · rapid prototypes

HUMAN ACCOUNTABILITY
Model structure · parallel strategy · performance conclusions · production changes · cross-component root cause

VERIFICATION
Every conclusion must be supported by code, logs, tests or the target environment.
```

- [ ] **步骤 3：实现核心观点与开放问题**

核心观点：

```text
AI Coding does not replace engineering judgment. It accelerates the loop of understanding the system, changing code, verifying results and turning experience into reusable capability.
```

开放问题：

```text
When code generation becomes cheap, the scarce capabilities shift to system understanding, problem definition, verification design and ownership of outcomes.
```

- [ ] **步骤 4：动画节拍**

```text
step 0: Infra 与 Agent 实践
step 1: Good Fit 与 Human Accountability
step 2: Verification 原则
step 3: 核心观点与开放问题
```

- [ ] **步骤 5：提交 P18 实现**

```bash
git add scripts/patch_renzhi_topic_restructure.py
git commit -m "feat: 新增 AI Coding 开放技术反思"
```

---

### 任务 9：执行补丁并通过结构/内容测试

**文件：**
- 修改：`Deck-Projects/renzhi/renzhi-deck.html`
- 测试：`scripts/verify/test_renzhi_topic_restructure.py`

- [ ] **步骤 1：执行补丁**

运行：

```bash
python3 scripts/patch_renzhi_topic_restructure.py
```

预期：

```text
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
```

章节起点为 `2, 5, 17`。

- [ ] **步骤 2：运行完成态断言**

运行：

```bash
python3 scripts/verify/test_renzhi_topic_restructure.py
```

预期：

```text
PASS: renzhi topic restructure
```

- [ ] **步骤 3：确认补丁可重复执行**

再次运行：

```bash
python3 scripts/patch_renzhi_topic_restructure.py
```

预期：

```text
deck 已是双专题完成态，未重复修改
```

- [ ] **步骤 4：检查 bundle 文件差异与体积**

运行：

```bash
shasum -a 256 Deck-Projects/renzhi/renzhi-deck.html
du -h Deck-Projects/renzhi/renzhi-deck.html
```

预期：SHA-256 与基线不同；文件仍为单个 HTML，体积变化主要来自两页 template 文本，不新增外部资源依赖。

---

### 任务 10：全页溢出与关键页视觉 QA

**文件：**
- 验证：`Deck-Projects/renzhi/renzhi-deck.html`
- 输出：`/tmp/renzhi-topic-qa/`

- [ ] **步骤 1：运行全页 overflow**

```bash
node scripts/verify/measure_overflow.mjs Deck-Projects/renzhi/renzhi-deck.html --all
```

预期：21 页 section overflow 的 X/Y 均为 0。任何 nested clip 必须逐条截图确认，不可直接忽略。

- [ ] **步骤 2：生成五个关键页截图**

```bash
mkdir -p /tmp/renzhi-topic-qa
node scripts/verify/shot.mjs Deck-Projects/renzhi/renzhi-deck.html kc-resp-proj /tmp/renzhi-topic-qa/p07-platform.jpg
node scripts/verify/shot.mjs Deck-Projects/renzhi/renzhi-deck.html kc-mgmt /tmp/renzhi-topic-qa/p11-technical.jpg
node scripts/verify/shot.mjs Deck-Projects/renzhi/renzhi-deck.html kc-train-outcomes /tmp/renzhi-topic-qa/p14-training.jpg
node scripts/verify/shot.mjs Deck-Projects/renzhi/renzhi-deck.html kc-sol-a3 /tmp/renzhi-topic-qa/p15-a3.jpg
node scripts/verify/shot.mjs Deck-Projects/renzhi/renzhi-deck.html ai-coding-reflection /tmp/renzhi-topic-qa/p18-ai-coding.jpg
```

预期：全部为 1920×1080，标题、正文、页脚完整。

- [ ] **步骤 3：逐张检查**

检查并记录：

- P7 三层关系是否一眼可读，数字是否抢过专题标题。
- P11 左 2/3 与右 1/3 是否明确，三张技术卡是否有足够字号。
- P14 左右栏是否均衡，底部四层技术栈是否拥挤。
- P15 代理模型流程与边界声明是否能在 10 秒内理解。
- P18 是否呈现为工程反思而非工具清单。

- [ ] **步骤 4：完成至少一次修复—复验循环**

选择首轮检查中优先级最高的问题，修改对应 page builder 后：

```bash
cp /tmp/renzhi-deck-before-topic-restructure.html Deck-Projects/renzhi/renzhi-deck.html
python3 scripts/patch_renzhi_topic_restructure.py
python3 scripts/verify/test_renzhi_topic_restructure.py
node scripts/verify/measure_overflow.mjs Deck-Projects/renzhi/renzhi-deck.html --all
```

然后重新生成受影响页面截图，确认旧问题消失且未产生新问题。

---

### 任务 11：动画逐拍验证与最终验收

**文件：**
- 验证：`Deck-Projects/renzhi/renzhi-deck.html`
- 输出：`/tmp/renzhi-topic-steps/`

- [ ] **步骤 1：生成四个改动页的逐拍截图**

```bash
node scripts/verify/steps.mjs Deck-Projects/renzhi/renzhi-deck.html kc-mgmt /tmp/renzhi-topic-steps/p11
node scripts/verify/steps.mjs Deck-Projects/renzhi/renzhi-deck.html kc-train-outcomes /tmp/renzhi-topic-steps/p14
node scripts/verify/steps.mjs Deck-Projects/renzhi/renzhi-deck.html kc-sol-a3 /tmp/renzhi-topic-steps/p15
node scripts/verify/steps.mjs Deck-Projects/renzhi/renzhi-deck.html ai-coding-reflection /tmp/renzhi-topic-steps/p18
```

预期：

- P14 有 4 个知识节拍。
- P15 有 5 个知识节拍。
- P18 有 4 个知识节拍。
- 空场没有提前显示的灰色容器。

- [ ] **步骤 2：再次运行三项结构验证**

```bash
python3 scripts/edit-bundle.py Deck-Projects/renzhi/renzhi-deck.html
python3 scripts/verify/test_renzhi_topic_restructure.py
node scripts/verify/measure_overflow.mjs Deck-Projects/renzhi/renzhi-deck.html --all
```

预期：全部退出码为 0。

- [ ] **步骤 3：提交实现脚本和测试**

```bash
git add scripts/patch_renzhi_topic_restructure.py scripts/verify/test_renzhi_topic_restructure.py
git commit -m "feat: 完成认知答辩双专题重构"
```

`Deck-Projects/renzhi/` 当前属于用户未跟踪项目目录，不在未获明确授权的情况下将整个目录及参考材料加入 Git。最终交付以修改后的 `renzhi-deck.html` 为准，补丁脚本可复现该结果。

---

## 最终验收清单

- [ ] `renzhi-deck.html` 为 21 页，页面顺序与规格一致。
- [ ] 章节起点为 `[2, 5, 17]`。
- [ ] 两个新增页面存在且导航可达。
- [ ] P11 不再包含开发计划和人员成长地图。
- [ ] P15 明确“工程估算”和“无全量盲测”。
- [ ] P14 不包含未经确认的 A5 硬件参数。
- [ ] P18 包含实践、边界、验证原则和开放问题。
- [ ] 全页 overflow 为 0。
- [ ] 五个关键页完成截图目检。
- [ ] 四个动画页完成逐拍核对。
- [ ] 至少完成一次修复—复验循环。
