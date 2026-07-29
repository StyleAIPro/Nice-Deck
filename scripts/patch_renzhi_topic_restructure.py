#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将认知答辩 deck 从 19 页重构为双专题 21 页完成态。"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DECK = ROOT / "Deck-Projects/renzhi/renzhi-deck.html"
EDIT_BUNDLE = ROOT / "scripts/edit-bundle.py"

BASELINE_LABELS = [
    "封面页",
    "目录页",
    "工作经历",
    "主要项目",
    "目录页",
    "专业知识",
    "kc-resp-proj",
    "kc-resp-cap",
    "kc-sol-agent",
    "kc-sol-a3",
    "kc-iss-ctc",
    "kc-iss-cad",
    "kc-mgmt",
    "kc-comm",
    "专业回馈",
    "目录页",
    "反思建议",
    "待改进",
    "结语",
]

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


def load_edit_bundle():
    spec = importlib.util.spec_from_file_location("eb", EDIT_BUNDLE)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 scripts/edit-bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def labels_of(template: str) -> list[str]:
    return re.findall(r'<section\b[^>]*data-label="([^"]+)"', template)


def footer() -> str:
    return """
<div style="position:absolute;left:0;right:0;bottom:0;height:54px;display:flex;align-items:center;padding:0 58px;gap:22px;border-top:1px solid #d7d9dd;color:#6c6c72;font-size:15px;font-weight:700;background:#eceef1;">
  <span style="letter-spacing:.02em;">HUAWEI TECHNOLOGIES CO., LTD.</span>
  <span style="flex:1;text-align:center;">Huawei Confidential</span>
  <span style="margin-right:96px;">Page 0</span>
</div>"""


def page(label: str, title: str, body: str, subtitle: str = "") -> str:
    subtitle_html = (
        f'<div style="margin-top:9px;font-size:23px;line-height:1.25;color:#566472;font-weight:650;">{subtitle}</div>'
        if subtitle
        else ""
    )
    return f"""<section data-label="{label}" style="width:100%;height:100%;position:relative;display:flex;flex-direction:column;background:#eceef1;font-family:'Noto Sans SC',sans-serif;color:#1a1a1c;overflow:hidden;box-sizing:border-box;">
<div style="padding:34px 58px 0;">
  <h2 style="margin:0;font-size:46px;font-weight:800;color:#b5333b;line-height:1.05;letter-spacing:-.01em;">{title}</h2>
  <div style="height:4px;background:#b5333b;margin-top:11px;border-radius:2px;"></div>
  {subtitle_html}
</div>
{body}
{footer()}
</section>"""


def shell(label: str, section: str) -> str:
    return (
        f'<div class="slide-fit" data-idx="0"><div class="slide-canvas">\n'
        f"      {section}\n"
        f"    </div></div>"
    )


def professional_knowledge() -> str:
    body = """
<div style="flex:1;min-height:0;padding:18px 58px 66px;display:flex;flex-direction:column;gap:16px;">
  <div style="background:#fff;border:1px solid #bdc3cb;border-left:7px solid #b5333b;padding:13px 18px;font-size:24px;line-height:1.25;font-weight:800;color:#566472;">
    Architecture Design → Technical Breakthroughs → Scaled Validation → Capability Assets
  </div>
  <div style="flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:22px;">
    <article style="background:#fff;border:1px solid #bdc3cb;border-radius:10px;padding:22px 24px;display:flex;flex-direction:column;">
      <div style="font-size:21px;font-weight:900;color:#b5333b;letter-spacing:.08em;">THEME 01 · P7–P12</div>
      <h3 style="margin:10px 0 18px;font-size:30px;line-height:1.16;">IT Operations Platform & New Delivery Model</h3>
      <div style="display:grid;grid-template-rows:repeat(3,1fr);gap:12px;flex:1;">
        <div style="background:#f5f6f7;border-left:5px solid #566472;padding:15px 16px;font-size:22px;line-height:1.32;"><b>Build the platform:</b> agents, knowledge and tools.</div>
        <div style="background:#f5f6f7;border-left:5px solid #566472;padding:15px 16px;font-size:22px;line-height:1.32;"><b>Prove it in delivery:</b> technical problem solving and field collaboration.</div>
        <div style="background:#f5f6f7;border-left:5px solid #566472;padding:15px 16px;font-size:22px;line-height:1.32;"><b>Scale the model:</b> OCC coordination, project closure and reusable assets.</div>
      </div>
    </article>
    <article style="background:#fff;border:1px solid #bdc3cb;border-radius:10px;padding:22px 24px;display:flex;flex-direction:column;">
      <div style="font-size:21px;font-weight:900;color:#b5333b;letter-spacing:.08em;">THEME 02 · P13–P15</div>
      <h3 style="margin:10px 0 18px;font-size:30px;line-height:1.16;">Model Training Taskforce Incubation & Enablement</h3>
      <div style="display:grid;grid-template-rows:repeat(3,1fr);gap:12px;flex:1;">
        <div style="background:#f5f6f7;border-left:5px solid #566472;padding:15px 16px;font-size:22px;line-height:1.32;"><b>Build expertise:</b> framework adaptation, performance tuning and quality optimization.</div>
        <div style="background:#f5f6f7;border-left:5px solid #566472;padding:15px 16px;font-size:22px;line-height:1.32;"><b>Prove it in practice:</b> training projects, product validation and delivery support.</div>
        <div style="background:#f5f6f7;border-left:5px solid #566472;padding:15px 16px;font-size:22px;line-height:1.32;"><b>Scale the capability:</b> courses, instructors, train-and-fight programs and knowledge assets.</div>
      </div>
    </article>
  </div>
  <div style="font-size:24px;line-height:1.25;font-weight:850;text-align:center;color:#566472;">Two connected themes turn engineering practice into repeatable delivery capability.</div>
</div>"""
    return page("专业知识", "Professional Knowledge: Two Focused Themes", body)


def platform_outcomes() -> str:
    def platform_card(title: str, detail: str = "") -> str:
        detail_html = (
            f'<div style="margin-top:7px;font-size:21px;line-height:1.2;color:#566472;font-weight:750;">{detail}</div>'
            if detail
            else ""
        )
        return f"""<div style="background:#fff;border:1px solid #bdc3cb;border-top:5px solid #566472;border-radius:7px;padding:14px 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
  <div style="font-size:22px;line-height:1.24;font-weight:800;">{title}</div>
  {detail_html}
</div>"""

    platform_cards = "".join(
        platform_card(title, detail)
        for title, detail in (
            ("Middle-Lane + Lower-Lane Agents", "Model Migration & Tuning Agent"),
            ("X+ Field Practice", ""),
            ("Cluster Integration Agent", ""),
            ("Knowledge and Tool Foundation", ""),
        )
    )
    metric_cards = "".join(
        f"""<div style="background:#fff;border:1px solid #bdc3cb;border-radius:7px;padding:12px 8px;text-align:center;display:flex;flex-direction:column;justify-content:center;">
  <div style="font-size:42px;line-height:1;color:#b5333b;font-weight:900;">{value}</div>
  <div style="font-size:21px;line-height:1.18;margin-top:8px;font-weight:800;">{label}</div>
</div>"""
        for value, label in (
            ("57", "Projects"),
            ("250+", "Requests Received"),
            ("220+", "Requests Completed"),
            ("85%+", "OCC Closure Rate"),
            ("30,000+", "Knowledge Fragments"),
        )
    )
    body = f"""
<div style="flex:1;min-height:0;padding:16px 58px 66px;display:grid;grid-template-rows:32fr 25fr 31fr 12fr;gap:13px;">
  <div class="build" data-step="0" style="background:#f5f6f7;border:1px solid #bdc3cb;border-radius:9px;padding:14px 16px;">
    <div style="font-size:24px;font-weight:900;color:#b5333b;margin-bottom:10px;">1. Platform Construction</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">{platform_cards}</div>
  </div>
  <div class="build" data-step="1" style="background:#fff;border:1px solid #bdc3cb;border-radius:9px;padding:13px 16px;">
    <div style="font-size:24px;font-weight:900;color:#b5333b;margin-bottom:9px;">2. Collaborative Operating Model</div>
    <div style="display:grid;grid-template-columns:1fr 34px 1fr 34px 1fr 34px 1fr;align-items:center;text-align:center;font-size:22px;font-weight:850;">
      <div style="background:#f5f6f7;padding:13px 8px;border:1px solid #bdc3cb;">On-site FAE</div><div style="color:#b5333b;font-size:30px;">→</div>
      <div style="background:#fdf0f1;padding:13px 8px;border:2px solid #b5333b;">OCC Operations Center</div><div style="color:#b5333b;font-size:30px;">↔</div>
      <div style="background:#f5f6f7;padding:13px 8px;border:1px solid #bdc3cb;">Remote Experts</div><div style="color:#b5333b;font-size:30px;">↔</div>
      <div style="background:#f5f6f7;padding:13px 8px;border:1px solid #bdc3cb;">Agent Platform</div>
    </div>
    <div style="margin-top:10px;text-align:center;font-size:21px;line-height:1.24;color:#566472;font-weight:750;">One operating loop: intake → diagnosis → execution → closure → knowledge feedback</div>
  </div>
  <div class="build" data-step="2" style="display:grid;grid-template-columns:repeat(5,1fr);gap:11px;">{metric_cards}</div>
  <div style="font-size:23px;line-height:1.25;font-weight:850;color:#566472;text-align:center;display:flex;align-items:center;justify-content:center;">The platform connects delivery evidence, expert collaboration and reusable knowledge in one closed loop.</div>
</div>"""
    return page(
        "kc-resp-proj",
        "IT Operations Platform & New Delivery Model",
        body,
        "Platform construction, collaborative operations and measurable delivery outcomes",
    )


def platform_architecture() -> str:
    def route_card(title: str, items: list[str], accent: bool = False) -> str:
        border = "#b5333b" if accent else "#566472"
        rows = "".join(
            f'<div style="background:#f5f6f7;border:1px solid #d7d9dd;padding:13px 12px;font-size:21px;line-height:1.24;font-weight:750;">{item}</div>'
            for item in items
        )
        return f"""<article style="background:#fff;border:2px solid {border};border-radius:9px;padding:17px;display:flex;flex-direction:column;min-height:0;">
  <h3 style="margin:0 0 13px;font-size:26px;line-height:1.15;color:{border};">{title}</h3>
  <div style="display:grid;grid-template-rows:repeat({len(items)},1fr);gap:10px;flex:1;">{rows}</div>
</article>"""

    body = f"""
<div style="flex:1;min-height:0;padding:15px 58px 66px;display:flex;flex-direction:column;gap:12px;">
  <div style="background:#fff;border:1px solid #bdc3cb;padding:12px 18px;text-align:center;font-size:21px;font-weight:850;color:#566472;">Project Demand · Customer Environment · Operations Data · Expert Knowledge</div>
  <div style="flex:1;min-height:0;display:grid;grid-template-columns:26fr 48fr 26fr;gap:16px;">
    {route_card("Mid-Route Agent", ["Demand Intake & Feasibility Analysis", "Solution Planning & Resource Coordination", "Remote Collaboration & Delivery Guidance"])}
    {route_card("Platform Core", ["Agent Orchestration", "Knowledge & Tool Foundation", "Hybrid Retrieval, Evaluation & Feedback", "Skills for Reusable Delivery Workflows"], True)}
    {route_card("Down-Route Agent", ["On-site Diagnosis & Issue Localization", "Model Migration, Deployment & Performance Tuning", "Local Execution Bot & Environment Access"])}
  </div>
  <div style="background:#fff;border:2px solid #b5333b;border-radius:9px;padding:15px 18px;display:grid;grid-template-columns:330px 1fr;align-items:center;gap:20px;">
    <div style="font-size:27px;font-weight:900;color:#b5333b;text-align:center;">OCC Operations Center</div>
    <div style="font-size:22px;line-height:1.28;font-weight:800;color:#566472;text-align:center;">Request Dispatch · Expert Collaboration · Progress Visibility · Closure Evidence</div>
  </div>
  <div style="font-size:22px;line-height:1.25;text-align:center;color:#566472;font-weight:800;">Plan & Coordinate → Orchestrate → Execute & Validate → return validated cases, knowledge feedback and improved Skills.</div>
</div>"""
    return page(
        "kc-sol-agent",
        "IT Operations Platform Architecture",
        body,
        "A layered platform connecting mid-route planning, down-route execution and OCC coordination",
    )


def technical_governance() -> str:
    def problem(step: int, title: str, mechanisms: list[str], result: str) -> str:
        points = "".join(
            f'<li style="margin-bottom:6px;">{item}</li>' for item in mechanisms
        )
        return f"""<article class="build" data-step="{step}" style="background:#fff;border:1px solid #bdc3cb;border-left:6px solid #566472;border-radius:7px;padding:13px 16px;display:flex;flex-direction:column;justify-content:center;">
  <h4 style="margin:0 0 7px;font-size:25px;line-height:1.13;">{title}</h4>
  <ul style="margin:0;padding-left:24px;font-size:21px;line-height:1.25;">{points}</ul>
  <div style="margin-top:5px;font-size:21px;line-height:1.22;font-weight:850;color:#b5333b;">{result}</div>
</article>"""

    body = f"""
<div style="flex:1;min-height:0;padding:16px 58px 66px;display:grid;grid-template-columns:2fr 1fr;gap:22px;">
  <div style="min-height:0;display:grid;grid-template-rows:auto repeat(3,1fr);gap:10px;">
    <div style="font-size:27px;font-weight:900;color:#566472;">Three Technical Problems Solved</div>
    {problem(0, "Performance Baseline Retrieval", ["Parse non-standard inputs; normalize model name, quantization and card count.", "Intersect multi-dimensional SQL conditions, then rerank semantically."], "More reliable baseline selection for delivery decisions.")}
    {problem(1, "Workflow + Agentic Workflow", ["Use Workflow to keep critical paths deterministic and auditable.", "Use Agentic Workflow for retrieval, analysis and tool invocation."], "Stable control where it matters; adaptive reasoning where it helps.")}
    {problem(2, "Skills × Knowledge", ["Package stable processes as Skills; keep high-change information in knowledge.", "Use traces, BadCases and user feedback for continuous correction."], "Reusable execution with an evolving knowledge foundation.")}
  </div>
  <aside class="build" data-step="3" style="min-height:0;background:#fff;border:2px solid #b5333b;border-radius:9px;padding:18px 19px;display:flex;flex-direction:column;">
    <h3 style="margin:0 0 15px;font-size:27px;color:#b5333b;">Technical Governance</h3>
    <div style="display:grid;grid-template-rows:repeat(4,1fr);gap:12px;flex:1;font-size:21px;line-height:1.3;">
      <div style="background:#f5f6f7;padding:14px;border-left:5px solid #566472;">Decompose goals into owners, acceptance evidence and release gates.</div>
      <div style="background:#f5f6f7;padding:14px;border-left:5px solid #566472;">Freeze non-critical features when critical-path resources conflict.</div>
      <div style="background:#f5f6f7;padding:14px;border-left:5px solid #566472;">Verify jointly across backend, MCP, front end, security and HIS.</div>
      <div style="background:#fdf0f1;padding:14px;border-left:5px solid #b5333b;font-weight:800;">All sprint items closed; core migration modules delivered; security inspection passed; HIS production online.</div>
    </div>
    <div style="margin-top:14px;font-size:21px;line-height:1.28;font-weight:850;color:#566472;">Governance serves engineering delivery through visible evidence, dependencies and release decisions.</div>
  </aside>
</div>"""
    return page("kc-mgmt", "Technical Problem Solving & Governance", body)


def training_taskforce() -> str:
    def track(title: str, items: list[str], supporting: str) -> str:
        rows = "".join(
            f'<div style="background:#f5f6f7;border-left:5px solid #566472;padding:13px 15px;font-size:22px;font-weight:800;">{item}</div>'
            for item in items
        )
        return f"""<article style="background:#fff;border:1px solid #bdc3cb;border-radius:9px;padding:19px 21px;display:flex;flex-direction:column;">
  <h3 style="margin:0 0 13px;font-size:28px;color:#b5333b;">{title}</h3>
  <div style="display:grid;grid-template-rows:repeat(4,1fr);gap:9px;flex:1;">{rows}</div>
  <div style="margin-top:12px;font-size:21px;line-height:1.28;color:#566472;font-weight:750;">{supporting}</div>
</article>"""

    metrics = "".join(
        f"""<div style="background:#fff;border:1px solid #bdc3cb;border-radius:7px;padding:11px;text-align:center;">
  <div style="font-size:38px;line-height:1;color:#b5333b;font-weight:900;">{value}</div>
  <div style="font-size:22px;line-height:1.2;margin-top:7px;font-weight:800;">{label}</div>
</div>"""
        for value, label in (
            ("2,000+", "Participants Trained"),
            ("8+", "Instructors Developed"),
            ("98%+", "Course Satisfaction"),
        )
    )
    body = f"""
<div style="flex:1;min-height:0;padding:16px 58px 66px;display:flex;flex-direction:column;gap:13px;">
  <div style="flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:20px;">
    {track("Training Taskforce", ["Training Framework Adaptation", "Performance Tuning", "Quality Optimization", "Project Support"], "Connect project delivery, product validation and reusable training expertise.")}
    {track("Enablement", ["Courses & Hands-on Labs", "Instructor Development", "Train-and-Fight Programs", "Knowledge & Case Assets"], "Turn project experience into teachable, repeatable capability.")}
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:13px;">{metrics}</div>
  <div style="font-size:23px;line-height:1.22;text-align:center;color:#566472;font-weight:850;">Delivery creates evidence; enablement multiplies it.</div>
</div>"""
    return page(
        "kc-resp-cap",
        "Model Training Taskforce Incubation & Enablement",
        body,
        "Build delivery depth through a training taskforce and scale it through enablement",
    )


def training_outcomes() -> str:
    impact_cards = "".join(
        f"""<div style="background:#f5f6f7;border:1px solid #d7d9dd;border-left:5px solid #566472;padding:11px 13px;">
  <div style="font-size:24px;line-height:1.12;font-weight:900;">{title}</div>
  <div style="font-size:21px;line-height:1.25;margin-top:5px;color:#566472;">{text}</div>
</div>"""
        for title, text in (
            ("Compute & Topology", "Re-map TP / PP / EP / DP and re-check viable system granularity."),
            ("Memory Hierarchy", "Re-balance parameters, activations and optimizer states across recompute and offload."),
            ("Communication Paths", "Re-evaluate collectives, compute–communication overlap and long-run stability."),
            ("Software Stack & Operators", "Re-validate Megatron, MindSpeed, VeRL, CANN operators and version compatibility."),
        )
    )
    timeline = "".join(
        f"""<div style="display:grid;grid-template-columns:150px 1fr;gap:12px;background:#f5f6f7;border-left:5px solid #566472;padding:10px 13px;">
  <div style="font-size:21px;font-weight:900;color:#b5333b;">{tag}</div>
  <div><div style="font-size:24px;line-height:1.12;font-weight:900;">{title}</div><div style="font-size:21px;line-height:1.24;margin-top:4px;color:#566472;">{text}</div></div>
</div>"""
        for tag, title, text in (
            ("X1+", "Train–Inference Integration", "Validated SFT / DPO and train–inference integration; closed field issues."),
            ("Training Taskforce", "Qwen2.5-7B GRPO", "Advanced AIME / MATH results and verified eight acceleration features."),
            ("A3 / A5", "Resource Design", "Designed from model structure, parallelism, memory and communication constraints."),
            ("Enablement", "Capability at Scale", "Courses reached 2,000+ learners, developed 8+ instructors and achieved 98%+ satisfaction."),
        )
    )
    stack = "".join(
        f'<div style="background:#f5f6f7;border:1px solid #bdc3cb;padding:12px 10px;text-align:center;font-size:21px;line-height:1.2;font-weight:850;">{text}</div>'
        for text in (
            "Model Structure & Algorithms",
            "Training Frameworks",
            "Parallelism & Resources",
            "CANN / HCCL / Operators",
        )
    )
    body = f"""
<div style="flex:1;min-height:0;padding:14px 58px 66px;display:flex;flex-direction:column;gap:12px;">
  <div style="flex:1;min-height:0;display:grid;grid-template-columns:45fr 55fr;gap:18px;">
    <div class="build" data-step="0" style="background:#fff;border:1px solid #bdc3cb;border-radius:9px;padding:14px;display:flex;flex-direction:column;">
      <div style="font-size:21px;font-weight:900;color:#b5333b;margin-bottom:9px;">A5 Architecture Evolution → Training Infra Impact</div>
      <div style="display:grid;grid-template-rows:repeat(4,1fr);gap:8px;flex:1;">{impact_cards}</div>
    </div>
    <div class="build" data-step="1" style="background:#fff;border:1px solid #bdc3cb;border-radius:9px;padding:14px;display:flex;flex-direction:column;">
      <div style="font-size:21px;font-weight:900;color:#b5333b;margin-bottom:9px;">TRAINING, DELIVERY & ENABLEMENT</div>
      <div style="display:grid;grid-template-rows:repeat(4,1fr);gap:8px;flex:1;">{timeline}</div>
    </div>
  </div>
  <div class="build" data-step="2" style="background:#fff;border:1px solid #bdc3cb;border-radius:9px;padding:12px 14px;">
    <div style="font-size:21px;font-weight:900;color:#b5333b;margin-bottom:8px;">FOUR-LAYER PRODUCT KNOWLEDGE STACK</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:9px;">{stack}</div>
  </div>
</div>"""
    return page(
        "kc-train-outcomes",
        "Training Outcomes — A5 Architecture Impact & Capability Depth",
        body,
    )


def a3_estimate() -> str:
    body = """
<div style="padding:11px 58px 0;">
  <div style="height:44px;background:#b5333b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;letter-spacing:.02em;">Engineering Estimate — No Full-Scale Blind Validation</div>
</div>
<div style="flex:1;min-height:0;padding:12px 58px 66px;display:grid;grid-template-rows:1.05fr .9fr 1fr;gap:11px;">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;min-height:0;">
    <article class="build" data-step="0" style="background:#fff;border:1px solid #bdc3cb;border-left:6px solid #566472;border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;justify-content:center;">
      <div style="font-size:21px;font-weight:900;color:#b5333b;">STEP 01</div>
      <h3 style="margin:5px 0 7px;font-size:25px;">Read the Model Structure</h3>
      <div style="font-size:21px;line-height:1.26;color:#566472;">Total parameters set resident memory. Active parameters set per-token compute. Layer count sets repeated depth. Top-K, expert distribution and EP expose routing and communication cost.</div>
    </article>
    <div class="build" data-step="1" style="display:grid;grid-template-columns:38px 1fr;align-items:stretch;">
      <div style="display:flex;align-items:center;justify-content:center;font-size:32px;color:#b5333b;font-weight:900;">→</div>
      <article style="background:#fff;border:1px solid #bdc3cb;border-left:6px solid #566472;border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;justify-content:center;">
        <div style="font-size:21px;font-weight:900;color:#b5333b;">STEP 02 · Architecture-Aware Proxy Model</div>
        <h3 style="margin:5px 0 7px;font-size:25px;">Build a Single-Node Proxy</h3>
        <div style="font-size:21px;line-height:1.26;color:#566472;">Keep hidden size, attention heads, MoE blocks, Top-K and data type. <b>Prune Layers</b> to reduce repeated depth. <b>Reduce Total Experts</b> so resident memory fits one node.</div>
      </article>
    </div>
  </div>
  <div class="build" data-step="2" style="display:grid;grid-template-columns:1fr 42px 1fr;gap:8px;min-height:0;">
    <article style="background:#fff;border:1px solid #bdc3cb;border-radius:8px;padding:13px 16px;display:flex;flex-direction:column;justify-content:center;">
      <div style="font-size:21px;font-weight:900;color:#b5333b;">STEP 03</div>
      <h3 style="margin:4px 0 6px;font-size:25px;">Measure the Proxy</h3>
      <div style="font-size:21px;line-height:1.25;color:#566472;">Measure Attention, MoE, peak memory and key training-stage time.</div>
    </article>
    <div style="display:flex;align-items:center;justify-content:center;font-size:32px;color:#b5333b;font-weight:900;">→</div>
    <article style="background:#fff;border:1px solid #bdc3cb;border-radius:8px;padding:13px 16px;display:flex;flex-direction:column;justify-content:center;">
      <div style="font-size:21px;font-weight:900;color:#b5333b;">STEP 04</div>
      <h3 style="margin:4px 0 6px;font-size:25px;">Extrapolate with Constraints</h3>
      <div style="font-size:21px;line-height:1.25;color:#566472;">Scale analytically with full-model layers, total experts, parallel strategy and topology constraints.</div>
    </article>
  </div>
  <article class="build" data-step="3" style="background:#fff;border:2px solid #b5333b;border-radius:8px;padding:12px 16px;display:grid;grid-template-columns:260px 1fr;gap:14px;min-height:0;align-items:center;">
    <div>
      <div style="font-size:21px;font-weight:900;color:#b5333b;">STEP 05</div>
      <h3 style="margin:5px 0 8px;font-size:25px;">Report a Planning Range</h3>
      <div style="font-size:21px;line-height:1.24;font-weight:850;color:#566472;">The proxy captures compute and memory order of magnitude; it is not the full model.</div>
    </div>
    <div style="display:flex;flex-direction:column;justify-content:center;gap:9px;">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;">
        <div style="background:#f5f6f7;padding:12px;text-align:center;font-size:22px;font-weight:900;">Lower Bound</div>
        <div style="background:#fdf0f1;padding:12px;text-align:center;font-size:22px;font-weight:900;color:#b5333b;">Recommended Value</div>
        <div style="background:#f5f6f7;padding:12px;text-align:center;font-size:22px;font-weight:900;">Risk Upper Bound</div>
      </div>
      <div style="font-size:21px;line-height:1.24;color:#566472;">Cross-node EP communication, load imbalance and P95 tail behavior remain analytical estimates until calibration on the target environment.</div>
    </div>
  </article>
</div>"""
    return page("kc-sol-a3", "A3 Structure-Driven Compute Engineering Estimate", body)


def ai_coding_reflection() -> str:
    def bullet(text: str) -> str:
        return f'<div style="background:#f5f6f7;border-left:5px solid #566472;padding:12px 13px;font-size:21px;line-height:1.28;">{text}</div>'

    practice = "".join(
        bullet(text)
        for text in (
            "Trace VeRL, Ray, Megatron and MindSpeed call paths; generate debugging scripts and log probes.",
            "Handle version compatibility and source-level adaptation; automate distributed training deployment and tests.",
            "Package delivery flows as Skills / MCP; build RAG, evaluation and BadCase feedback loops.",
            "Accelerate AICO-PPT, AICO-Bot, distributed-training utilities and document-extraction tools.",
        )
    )
    boundaries = "".join(
        bullet(text)
        for text in (
            "Good fit: code understanding, repetitive refactoring, test generation, log analysis, tool orchestration and rapid prototypes.",
            "Do not delegate directly: model-structure or parallel-strategy decisions, performance conclusions, production changes or cross-component root-cause judgments.",
        )
    )
    body = f"""
<div style="flex:1;min-height:0;padding:19px 58px 66px;display:grid;grid-template-columns:30fr 38fr 32fr;gap:18px;">
  <article class="build" data-step="0" style="background:#fff;border:1px solid #bdc3cb;border-radius:9px;padding:19px;display:flex;flex-direction:column;">
    <h3 style="margin:0 0 15px;font-size:28px;color:#b5333b;">Practice</h3>
    <div style="display:grid;grid-template-rows:repeat(4,1fr);gap:11px;flex:1;">{practice}</div>
  </article>
  <article class="build" data-step="1" style="background:#fff;border:1px solid #bdc3cb;border-radius:9px;padding:19px;display:flex;flex-direction:column;">
    <h3 style="margin:0 0 15px;font-size:28px;color:#b5333b;">Boundaries & Verification</h3>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">
      <div style="display:grid;grid-template-rows:1fr 1.15fr;gap:11px;">{boundaries}</div>
      <div style="margin-top:15px;background:#fdf0f1;border-left:7px solid #b5333b;padding:16px;font-size:22px;line-height:1.32;font-weight:900;">
        AI Coding does not replace Engineering Judgment.<br><br>
        Every conclusion requires Verification through code, logs, tests or the target environment.
      </div>
    </div>
  </article>
  <article class="build" data-step="2" style="background:#fff;border:1px solid #bdc3cb;border-left:8px solid #b5333b;border-radius:9px;padding:22px;display:flex;flex-direction:column;">
    <h3 style="margin:0 0 22px;font-size:28px;color:#b5333b;">Open Question</h3>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">
      <div style="font-size:24px;line-height:1.34;font-weight:850;color:#566472;">AI Coding accelerates the loop from system understanding to code change, result verification and capability reuse.</div>
      <div style="height:2px;background:#bdc3cb;margin:24px 0;"></div>
      <div style="font-size:24px;line-height:1.34;font-weight:850;">When code generation becomes cheaper, scarce engineering capability shifts to system understanding, problem definition, verification design and accountability for results.</div>
    </div>
  </article>
</div>"""
    return page(
        "ai-coding-reflection",
        "AI Coding in Infra & Agent Development",
        body,
    )


def replace_section(template: str, label: str, replacement: str) -> str:
    marker = f'<section data-label="{label}"'
    start = template.find(marker)
    if start < 0:
        raise RuntimeError(f"目标页面不存在：{label}")
    end = template.find("</section>", start)
    if end < 0:
        raise RuntimeError(f"目标页面未闭合：{label}")
    end += len("</section>")
    return template[:start] + replacement + template[end:]


def normalize_nav_labels(eb, template: str) -> str:
    """让导航 label 与 data-label 对齐，保证 edit-bundle 的结构 API 可定位页面。"""
    _, _, codes, nav_labels = eb._nav_entries(template)
    section_labels = labels_of(template)
    if len(codes) != len(section_labels):
        raise RuntimeError("导航与页面数量不一致，无法安全重构")
    if len(nav_labels) != len(section_labels):
        raise RuntimeError("导航 label 解析失败，无法安全重构")
    return eb._write_nav(template, codes, section_labels)


def normalize_slide_separators(template: str) -> str:
    """移除 wrapper 前的页注释，恢复 edit-bundle 结构 API 要求的固定分隔符。"""
    normalized, count = re.subn(
        r'\n\n    <!--[^\n]*-->\n    (?=<div class="slide-fit")',
        "\n\n    ",
        template,
    )
    if count != len(BASELINE_LABELS):
        raise RuntimeError(f"页块分隔符归一化数量异常：{count}")
    return normalized


def move_after(eb, template: str, label: str, after_label: str) -> str:
    current = labels_of(template)
    index = current.index(label)
    if index > 0 and current[index - 1] == after_label:
        return template
    return eb.move_page(template, label, after_label=after_label)


def renumber(template: str) -> str:
    blocks = re.findall(
        r'<div class="slide-fit"[^>]*>.*?</section>\s*</div></div>',
        template,
        flags=re.S,
    )
    if len(blocks) != len(EXPECTED_LABELS):
        raise RuntimeError(f"页块数量异常：{len(blocks)}")

    result = template
    for page_number, block in enumerate(blocks, start=1):
        updated = re.sub(
            r'data-idx="\d+"',
            f'data-idx="{page_number - 1}"',
            block,
            count=1,
        )
        if "HUAWEI TECHNOLOGIES CO., LTD." in updated:
            updated, count = re.subn(
                r">Page \d+<",
                f">Page {page_number}<",
                updated,
                count=1,
            )
            if count != 1:
                raise RuntimeError(f"第 {page_number} 页缺少企业页码标记")
        result = result.replace(block, updated, 1)
    return result


def validate_complete(template: str) -> None:
    actual = labels_of(template)
    if actual != EXPECTED_LABELS:
        raise RuntimeError(f"完成态页面顺序错误：{actual}")
    if template.count('class="slide-fit"') != 21:
        raise RuntimeError("完成态 slide-fit 数量不是 21")

    nav_start = template.find("const nav = [")
    nav_end = template.find("];", nav_start)
    if nav_start < 0 or nav_end < 0:
        raise RuntimeError("完成态导航数量错误：未找到 nav 数组")
    nav_entries = re.findall(
        r"\{ i:(\d+), code:'((?:[^'\\]|\\.)*)', label:'((?:[^'\\]|\\.)*)' \}",
        template[nav_start:nav_end],
    )
    if len(nav_entries) != 21:
        raise RuntimeError(f"完成态导航数量错误：{len(nav_entries)}")
    nav_numbers = [int(number) for number, _, _ in nav_entries]
    if nav_numbers != list(range(21)):
        raise RuntimeError(f"完成态导航序号错误：{nav_numbers}")
    nav_labels = [label for _, _, label in nav_entries]
    if nav_labels != EXPECTED_LABELS:
        raise RuntimeError(f"完成态导航 label 错误：{nav_labels}")

    starts = [
        int(value)
        for value in re.findall(
            r"\{\s*name:'[^']+',\s*start:(\d+)\s*\}",
            template,
        )
    ]
    if starts != [2, 5, 17]:
        raise RuntimeError(f"完成态章节起点错误：{starts}")

    blocks = re.findall(
        r'<div class="slide-fit"[^>]*>.*?</section>\s*</div></div>',
        template,
        flags=re.S,
    )
    if len(blocks) != 21:
        raise RuntimeError(f"完成态页块数量错误：{len(blocks)}")
    for page_number, block in enumerate(blocks, start=1):
        marker = re.search(r'data-idx="(\d+)"', block)
        if marker is None or int(marker.group(1)) != page_number - 1:
            raise RuntimeError(f"第 {page_number} 页 data-idx 错误")
        if "HUAWEI TECHNOLOGIES CO., LTD." in block:
            page_marker = re.search(r">Page (\d+)<", block)
            if page_marker is None or int(page_marker.group(1)) != page_number:
                raise RuntimeError(f"第 {page_number} 页页脚页码错误")


def main() -> int:
    eb = load_edit_bundle()
    lines = eb.load(DECK)
    template = eb.get_template(lines)
    labels = labels_of(template)

    new_labels = {"kc-train-outcomes", "ai-coding-reflection"}
    present = new_labels.intersection(labels)
    if present == new_labels and labels == EXPECTED_LABELS:
        validate_complete(template)
        print("deck 已是双专题完成态，未重复修改")
        return 0
    if present or labels != BASELINE_LABELS:
        print(
            "错误：deck 处于不完整或非基线状态，请从 19 页基线恢复后重试。",
            file=sys.stderr,
        )
        return 1

    template = normalize_nav_labels(eb, template)
    template = normalize_slide_separators(template)

    # 先在 Self-Evaluation 章内重排既有页面，章节起点保持不变。
    template = move_after(eb, template, "kc-sol-agent", "kc-resp-proj")
    template = move_after(eb, template, "kc-iss-cad", "kc-sol-agent")
    template = move_after(eb, template, "kc-iss-ctc", "kc-iss-cad")
    template = move_after(eb, template, "kc-mgmt", "kc-iss-ctc")
    template = move_after(eb, template, "kc-comm", "kc-mgmt")
    template = move_after(eb, template, "kc-resp-cap", "kc-comm")

    # 重建六张既有页面。
    replacements = {
        "专业知识": professional_knowledge(),
        "kc-resp-proj": platform_outcomes(),
        "kc-sol-agent": platform_architecture(),
        "kc-mgmt": technical_governance(),
        "kc-resp-cap": training_taskforce(),
        "kc-sol-a3": a3_estimate(),
    }
    for label, replacement in replacements.items():
        template = replace_section(template, label, replacement)

    # 两张新增页必须通过 insert_page 同步 DOM、nav 与章节起点。
    template = eb.insert_page(
        template,
        shell("kc-train-outcomes", training_outcomes()),
        before_label="kc-sol-a3",
        nav_code="训战",
        nav_label="kc-train-outcomes",
    )
    template = eb.insert_page(
        template,
        shell("ai-coding-reflection", ai_coding_reflection()),
        before_label="反思建议",
        nav_code="AI码",
        nav_label="ai-coding-reflection",
    )

    template = renumber(template)
    validate_complete(template)

    eb.set_template(lines, template)
    eb.save(DECK, lines)
    eb.verify(DECK)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
