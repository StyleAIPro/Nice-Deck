# huawei-deck

华为红品牌 **单文件 HTML 演示（网页 PPT）模板 skill**。一套 1920×1080、离线可拷走的幻灯片系统：34 页页型画廊（含 10 页真实课件成品示例）、点击 / 方向键放映、刷新续播，并可一键转成 PPTX。

这是一个 [Claude Code](https://claude.com/claude-code) **skill**——把本目录放进 Claude 的 skills 目录即可，Claude 会在你要「做一份华为风 PPT / 网页演示」时自动用它。

## 能做什么

- 三套模板按场景起步：**授课**（34 页全量画廊）、**技术分享**（25 页，含选型 / 原理 / 架构 / 性能 / 踩坑页型）、**工作汇报**（22 页，含 TL;DR / KPI / 甘特 / 风险页型）——`references/workflow.md` 有完整的七阶段协作流程与场景适配
- 保留整套设计系统：三色体系（品牌红 `#b5333b`）、Noto Sans SC + JetBrains Mono、统一字号刻度、玻璃组件、放映 / 滚动双模式、三种手动推进的动画机制（build 逐步揭示 / layer 标签切换 / SMIL 连续运动）
- 品牌可替换：换 logo / 金色背景画 / 口号 / 品牌色（`references/branding.md` + `scripts/apply_bg.py`）
- 配图有工作流：初版类型化占位标注，终版从素材 PDF 抽原图（PyMuPDF）、自绘流程 / 架构图、制表落地（`references/artwork.md`）
- 一键 `scripts/html2pptx/convert.sh` 导出 PPTX，页内多标签（layer）自动逐标签展开成多页

## 安装

把本目录放到 Claude Code 的 skills 目录（二选一）：

```bash
# 方式 A：软链接（本项目更新后 skill 自动同步，推荐开发时用）
ln -s "$(pwd)" ~/.claude/skills/huawei-deck

# 方式 B：快照复制（分发 / 稳定用）
cp -R "$(pwd)" ~/.claude/skills/huawei-deck
```

装好后，新的 Claude Code 会话里说「用 huawei-deck 帮我做一套 XX 的 PPT」即可触发。分发给别人 = 打包本目录发过去，对方同样放进 `~/.claude/skills/`。

## 依赖

| 用途 | 依赖 | 安装 |
|---|---|---|
| 验证脚本 / html2pptx 截图 | 本机 Google Chrome + `playwright-core` | `npm i -g playwright-core`（或设环境变量 `PLAYWRIGHT_CORE` 指向已装路径） |
| html2pptx 组装 | `python-pptx` | `python3 -m pip install python-pptx` |
| 编辑模板 deck | Python 3（标准库即可） | 系统自带 |

> playwright-core 加载顺序：`PLAYWRIGHT_CORE` 环境变量 → 裸 `import playwright-core` → 内置回退路径。缺依赖时脚本会打印可操作的中文提示。

## 目录

```
huawei-deck/
├── SKILL.md                 # skill 入口：5 步快速上手 + 铁律 + 文件导航
├── assets/
│   ├── template-deck.html   # ★34 页授课模板（离线单文件，~12MB）
│   ├── tech-share-deck.html # 25 页技术分享模板（选型/原理/架构/性能/踩坑/Takeaway）
│   └── work-report-deck.html# 22 页工作汇报模板（TL;DR/KPI/里程碑/甘特/分工/风险）
├── references/
│   ├── workflow.md          # 从零做一份 deck 的七阶段协作流程（授课/汇报/自读通用）
│   ├── template-pages.md    # 34 页逐页索引：每页什么版式 / 常用于 / 怎么改
│   ├── design-system.md     # 颜色 / 字体 / 字号刻度 / 版式硬规
│   ├── animation.md         # build / layer / SMIL 三机制写法 + 放映键位
│   ├── page-snippets.md     # 可直接粘贴的 <section> 片段
│   ├── editing-guide.md     # 编辑独立版 / 增删页 / 踩坑 / 验证工作流
│   ├── artwork.md           # 配图工作流：占位标注 → 抽原图 / 自绘图 / 制表
│   └── branding.md          # 换 logo / 背景画 / 口号 / 品牌色
├── scripts/
│   ├── edit-bundle.py       # 独立版编辑工具函数（增删移页自动同步 nav/chapters）
│   ├── apply_bg.py          # 品牌图替换
│   ├── verify/              # measure_overflow / shot / steps —— 溢出检测·单页截图·放映逐拍
│   └── html2pptx/           # convert.sh + shoot.mjs + build_pptx.py
└── docs/design/             # 设计规格与实现计划（本 skill 的构建记录，供参考）
```

## 模板 deck 页型（34 页 · 6 章）

01 门面（封面 / 目录 / 议程 / 章扉 / 问题页）· 02 内容版式（卡片网格 / 左图右文 / 对比两栏 / 流程条 / 密集多栏 / 表格混排 / 全幅大图 / 截图对照 / 动手实验）· 03 动画机制（build / layer / 混合链 / SMIL / 多组切换）· 04 深色与黑板（金句 / 两种黑板题卡）· 05 完整示例（10 页真实课件成品，即拿即改）· 06 收尾（研讨 / 结语）。

放映：打开默认滚动模式，点右上角玻璃工具条的显示器图标进入放映（自动全屏）；点击空白 / 空格 / → 前进，← 后退。

## 快速上手

见 `SKILL.md`。一句话：`cp assets/template-deck.html 我的演示.html` → 照 `references/template-pages.md` 挑页改占位 → 增删页用 `scripts/edit-bundle.py`（自动记账）→ 跑 `scripts/verify/` 验证 → `scripts/html2pptx/convert.sh` 出 PPTX。
