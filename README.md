# huawei-deck

华为红品牌 **单文件 HTML 演示（网页 PPT）模板 skill**。一套 1920×1080、离线可拷走的幻灯片系统：34 页页型画廊（含 10 页真实课件成品示例）、点击 / 方向键放映、刷新续播，并可一键转成 PPTX。

这是一个 [Claude Code](https://claude.com/claude-code) **skill**——把本目录放进 Claude 的 skills 目录即可，Claude 会在你要「做一份华为风 PPT / 网页演示」时自动用它。

## 效果预览

![deck 交互演示：液态玻璃工具条 · 侧边预览 · 记笔记 · 放映/滚动切换](docs/showcase/deck-demo.gif)

> 本地 Chrome 实录一份用本 skill 做出的答辩 deck：顶部液态玻璃工具条随讲切章，左上侧边预览缩略图跳页，左下角记笔记留评审批注，右上放映 / 滚动一键切换——放映翻到「03 · 研究过程」后切滚动，缓慢通览到致谢页。完整图文案例见 [`docs/showcase/showcase-1.md`](docs/showcase/showcase-1.md)。

## 能做什么

- 三套模板按场景起步：**授课**（34 页全量画廊）、**技术分享**（36 页，深色光轨 KV 封面，含选型 / 原理 / 性能对比 / 演进曲线 / 精读批注 / 截图跟读页型）、**工作汇报**（41 页，含 TL;DR / KPI / 数据墙 / 案例 / 批示纪要 / 场景裁剪流程 / 组织阵型 / 状态热力表 / 甘特 / 风险页型）——`references/workflow.md` 有完整的七阶段协作流程与场景适配
- 保留整套设计系统：三色体系（品牌红 `#b5333b`）、Noto Sans SC + JetBrains Mono、统一字号刻度、玻璃组件、放映 / 滚动双模式、独立的幻灯片内容缩放、三种手动推进的动画机制（build 逐步揭示 / layer 标签切换 / SMIL 连续运动）
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

> **一键体检**：`python3 scripts/check_deps.py` 会检查下表全部依赖（含外部依赖 skill `pdf`），缺失项能自动装的（pip / npx / npm）先打印命令再装，装不了的（Node / Chrome / soffice）给安装提示；`--check-only` 只报告不改环境。退出码 0 就绪 / 1 仍缺 / 2 工具或参数错误。

| 用途 | 依赖 | 安装 |
|---|---|---|
| 验证脚本 / html2pptx 截图 | 本机 Google Chrome + `playwright-core` | `npm i -g playwright-core`（或设环境变量 `PLAYWRIGHT_CORE` 指向已装路径） |
| html2pptx 组装 | `python-pptx` | `python3 -m pip install python-pptx` |
| 编辑模板 deck | Python 3（标准库即可） | 系统自带 |
| 解析外部参考材料：pptx → 逐页图 | 本机 LibreOffice（`soffice`） | `brew install --cask libreoffice` |
| 解析外部参考材料：pdf 渲染 / 抽图 | `pymupdf` | `python3 -m pip install pymupdf` |

> playwright-core 加载顺序：`PLAYWRIGHT_CORE` 环境变量 → 裸 `import playwright-core` → 内置回退路径。缺依赖时脚本会打印可操作的中文提示。
>
> 解析外部参考材料指从 pptx/pdf 素材提取版式与图片（`assets/huawei-refs/` 即由此产出）：pptx 先经 `soffice --headless --convert-to pdf` 转 PDF，再用 PyMuPDF 渲染逐页图 / 抽内嵌图；pptx 内嵌媒体可直接用 Python `zipfile` 解包 `ppt/media/`。PDF 的进阶处理（合并 / 拆分 / 表格提取 / 表单）参考仓库内置的 pdf skill：`.agents/skills/pdf/`（`npx skills add https://github.com/anthropics/skills --skill pdf` 安装）。

## 目录

```
huawei-deck/
├── SKILL.md                 # skill 入口：5 步快速上手 + 铁律 + 文件导航
├── assets/
│   ├── template-deck.html   # ★34 页授课模板（离线单文件，~12MB）
│   ├── tech-share-deck.html # 36 页技术分享模板（深色KV封面/选型/原理/对比/演进/精读/跟读/Takeaway）
│   ├── work-report-deck.html# 41 页工作汇报模板（TL;DR/KPI/数据墙/案例/纪要/阵型/热力表/甘特/风险）
│   └── huawei-refs/         # 华为官方 PPT 提取素材库：封面 KV / logo / 图标 / 组件 + 官方模板 pptx
├── references/
│   ├── workflow.md          # 从零做一份 deck 的七阶段协作流程（授课/汇报/自读通用）
│   ├── template-pages.md    # 三套模板逐页索引：怎么选 + 每页长什么样 / 常用于 / 怎么改
│   ├── design-system.md     # 颜色 / 字体 / 字号刻度 / 版式硬规
│   ├── animation.md         # build / layer / SMIL 三机制写法 + 放映键位
│   ├── page-snippets.md     # 可直接粘贴的 <section> 片段
│   ├── editing-guide.md     # 编辑独立版 / 增删页 / 踩坑 / 验证工作流
│   ├── artwork.md           # 配图工作流：占位标注 → 抽原图 / 自绘图 / 制表
│   ├── branding.md          # 换 logo / 背景画 / 口号 / 品牌色
│   └── huawei-style.md      # 华为官方胶片风格分析：配色公式 / 页型 / 标题句式 / 数字用法
├── scripts/
│   ├── edit-bundle.py       # 独立版编辑工具函数（增删移页自动同步 nav/chapters）
│   ├── apply_bg.py          # 品牌图替换
│   ├── verify/              # measure_overflow / shot / steps —— 溢出检测·单页截图·放映逐拍
│   └── html2pptx/           # convert.sh + shoot.mjs + build_pptx.py
└── docs/design/             # 设计规格与实现计划（本 skill 的构建记录，供参考）
```

## 模板 deck 页型（34 页 · 6 章）

01 门面（封面 / 目录 / 议程 / 章扉 / 问题页）· 02 内容版式（卡片网格 / 左图右文 / 对比两栏 / 流程条 / 密集多栏 / 表格混排 / 全幅大图 / 截图对照 / 动手实验）· 03 动画机制（build / layer / 混合链 / SMIL / 多组切换）· 04 深色与黑板（金句 / 两种黑板题卡）· 05 完整示例（10 页真实课件成品，即拿即改）· 06 收尾（研讨 / 结语）。

放映：打开默认滚动模式，点右上角玻璃工具条的显示器图标进入放映（自动全屏）；点击空白 / 空格 / → 前进，← 后退。`Ctrl/Cmd + 滚轮` 或 `Ctrl/Cmd + +/-` 只缩放幻灯片内容，刷新保留倍率；非 100% 时顶部 glass bar 液态展开四角百分比控件，点击复位。点击右上角播放 / 滚动任一模式按钮同样恢复 100%；缩放时工具条固定、滚动态当前页不跳转。

## 快速上手

见 `SKILL.md`。一句话：`cp assets/template-deck.html 我的演示.html` → 照 `references/template-pages.md` 挑页改占位 → 增删页用 `scripts/edit-bundle.py`（自动记账）→ 跑 `scripts/verify/` 验证 → `scripts/html2pptx/convert.sh` 出 PPTX。

## 许可证

原创代码与文档（`scripts/` / `references/` / `SKILL.md` 等）以 **MIT** 许可，见 [`LICENSE`](LICENSE)。

两块第三方内容**不在** MIT 范围内，按各自条款使用：`.agents/skills/pdf/`（Anthropic 官方 skill，© Anthropic, PBC）、`assets/huawei-refs/` 与模板中的华为官方版式 / 封面 / 插画 / Logo / 品牌色（版权归华为）。复用品牌素材前须自行获得授权；发布自己的 deck 前建议按 `references/branding.md` 替换为自有或已授权资产。详见 `LICENSE` 末尾的第三方声明。
