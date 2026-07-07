# 华为风 HTML 演示模板 skill（huawei-deck）· 设计规格

> 2026-07-06。基于《训练Infra课程-独立版 (2).html》（77 页成品 deck）提炼一套可复用、可分发的
> 华为红品牌单文件 HTML 演示模板，打包为自包含 Claude Code skill。

## 1. 目标与非目标

**目标**
1. 别人拿到一套 skill 目录即可起步做同风格演示：复制模板 deck → 改占位内容 → 验证 → 可选转 PPTX。
2. 完整保留成品 deck 的：红色设计系统（颜色/字体/字号刻度/排版）、玻璃组件（导航条/进度条/笔记面板）、
   放映交互（点击空白/空格/方向键推进，绝不自动播放）、三种动画机制（build 逐步揭示 / layer 标签切换 / SMIL 连续运动）、
   性能与易用性补丁（离线内联 React、content-visibility+warm-window、loading overlay、localStorage 刷新恢复页面）。
3. html2pptx 一键转换：一页一图；含多标签（layer）的页逐标签激活各截一张展开成多页；build 元素强制全显不展开。
4. 品牌元素（HUAWEI logo 水印、金色封面背景画、口号）保留但做成**可替换点**，文档写明替换方法。

**非目标**
- 不重建运行时（不从零写 CSS/JS）；模板 deck 由成品 deck 做减法产出。
- 不改 html2pptx 的 build 展开语义（保持全显一页）。
- 不动现有 `dc-slide-deck/`（继续服务本课程 deck 维护）；不动主课程 deck 文件。
- 不做去品牌化的通用主题系统（只标注替换点）。

## 2. 交付物：skill 目录结构

构建位置 `class-1/huawei-deck/`，完成后复制到 `~/.claude/skills/huawei-deck/` 本机可用；
分发 = 打包该目录给他人放进其 skills 目录。

```
huawei-deck/
├── SKILL.md                  # 入口：触发条件、快速上手工作流、设计铁律摘要、文件导航
├── assets/
│   └── template-deck.html    # ★模板 deck：页型画廊 ~25-35 页，全部运行时补丁内置，约 5-8MB
├── references/
│   ├── template-pages.md     # 逐页索引：第 N 页 = 什么页型 / 常用于什么 / 改哪里 / 动画写法
│   ├── design-system.md      # 颜色、字体、字号刻度（body {13,15,17,19,21,24,27,30}、散文地板 21px、
│   │                         #   图元豁免判别法）、每页结构、页型语汇、审美硬要求（提炼自 DESIGN.md）
│   ├── page-snippets.md      # 可直接粘贴的 <section> 片段（现 page-templates.md 升级：补齐模板 deck 各页型）
│   ├── animation.md          # build / layer / SMIL 三机制写法 + 放映键位 + 「外层背景框也要挂 build」等铁律
│   ├── editing-guide.md      # 独立版结构（__bundler/template JSON）、edit-bundle.py 用法、
│   │                         #   加删移页三处同步（slide DOM / nav[] / chapters[]）、安全编码规则、踩坑表、验证清单
│   └── branding.md           # 可替换点：logo 水印 / 金色封面背景画 / 口号占位；替换步骤与脚本用法
└── scripts/
    ├── edit-bundle.py        # 编辑独立版工具（自现有复制，路径解耦：deck 路径一律做参数）
    ├── apply_bg.py           # 换封面背景画（自 apply_template_bg.py 改造为参数化）
    ├── html2pptx/
    │   ├── convert.sh        # 一键转换入口（照搬，路径适配）
    │   ├── shoot.mjs         # 逐页截图 + layer 逐标签展开 + build 全显（照搬）
    │   └── build_pptx.py     # python-pptx 组装（照搬）
    ├── verify/
    │   ├── measure_overflow.mjs   # 全页 section 溢出检测（Y=0 判据）
    │   ├── clipscan.mjs           # 内层元素裁切扫描
    │   └── shot.mjs               # 指定页截图目检
    └── react.umd.js / react-dom.umd.js   # 修复离线 React 用备件（模板 deck 本身已内联）
```

**使用者工作流**（SKILL.md 主线）：
1. `cp assets/template-deck.html 我的演示.html`（改前改后都只动副本）。
2. 读 `template-pages.md` 挑页型；直接改对应页的占位内容；同页型多用 = 用 `edit-bundle.py`
   复制该页 section 再插入；删除不用的模板页（工具自动同步 nav/chapters）。
3. 每改一批跑 `verify/measure_overflow.mjs`（Y=0）+ `shot.mjs` 截图目检；动画页按 animation.md 验放映态。
4. 需要 PPTX 时 `html2pptx/convert.sh 我的演示.html`。

## 3. 模板 deck 产出规则（核心工作，做减法）

1. **页型盘点**：脚本枚举 77 页的 `data-label` + 版式特征（背景色/水印元素/网格结构/动画属性），
   人工归类页型；每种版式保留最典型 1 页，其余整页删除（nav/chapters 记账）。
   预期页型全集（以实际盘点为准，估 25-35 页）：
   - 门面：封面（金色背景画）、目录/议程、章扉页（大数字水印）、问题页（大红 Q 水印）
   - 内容版式：卡片网格、左图右文、对比两栏、流程条、表格/矩阵、全幅大图、多栏密集页
     ——**每页自带该版式的典型动画**（选代表页时优先选带动画的实例并完整保留其 build/layer 标记，
     如：卡片网格逐卡 build、流程条逐节点推进、对比两栏左右先后揭示、全幅大图先图后批注），
     使每个版式页既是排版范本也是该版式的动画范本
   - 动画机制：build 逐步揭示 demo、layer 标签切换 demo、SMIL 连续运动 demo（保留完整可点交互，
     作为机制讲解页——版式页示范「怎么用在真实版式上」，机制页示范「三种机制本身的写法」）
   - 深色页：敲黑板金框题卡（选择/填空两式）、深色金句页、RECAP 小结
   - 收尾：研讨页、结语页
   - nav/chapters 重排为模板章节：01 门面 · 02 内容版式 · 03 动画机制 · 04 深色/黑板 · 05 收尾
2. **占位化**：保留页课程文字 → **教学式占位文案**（占位即用法说明，例：h3 写「一句话说清本页主张」、
   卡片正文写「要点支撑句，散文最小 21px」）；**课程截图/嵌入 base64 图删除**（manifest 条目一并清，
   体积 24MB → 约 5-8MB），原位换灰色占位框标注用法（如「图：按列宽放大填充」）；
   SVG 重画图保留图形结构、文字改占位。
3. **占位化只动文字与图，不动动画标记**：所有保留页（版式页与机制 demo 页）的 build 链、
   layer 按钮组（含 data-step 推进）、SMIL 动画、data-reveal 联动一律保持完整可运行，作为照抄范本；
   占位文案顺带标注动画节奏（如「此卡第 2 拍出现（data-step="1"）」）。
4. **品牌可替换点**：金色背景画、HUAWEI logo 水印原样保留；口号改占位；`branding.md` + `apply_bg.py` 提供替换路径。
5. **运行时零改动**：`<head>` 字体包（Noto Sans SC 400-700 + JetBrains Mono）、内联 React/ReactDOM、
   玻璃条块 CSS、loading overlay、warm-window、localStorage 刷新恢复、事件委托——原样保留。
6. **过程纪律**：一切在副本上操作，主课程 deck 只读；中间备份放 session scratchpad（项目目录备份会被外部清）。

## 4. html2pptx

照搬现有实现（已满足需求）：`.stage .slide-canvas` 逐页 `element.screenshot`；截图前隐藏 UI 外壳、
build 元素强制 `opacity:1`；`[data-layer-btn]/[data-layer-panel]` 页逐标签 `toggleAttribute('data-active')`
各截一张按序写入 PPTX。改动仅限：脚本内路径与 skill 布局适配；README 内容并入 SKILL.md/editing-guide.md；
文档写明已知例外（React 内部 state 切换、DOM 一次只渲染一态的页无法程序化展开，只截默认态——模板 deck
不包含此类页，属使用者自造交互时的注意事项）。

## 5. 验证（模板 deck 出厂标准）

1. 完整性：`json.loads` template 通过；section / nav[] / chapters 三处数量与顺序一致。
2. 版式：全页 `measure_overflow.mjs` Y=0 X=0；`clipscan.mjs` 无内层文字裁切。
3. 动画：三个机制 demo 页 + 全部带动画的版式页，放映态逐拍截图（模拟 level 推进），build/layer/SMIL 行为正确。
4. 易用性：断网（file://，无代理）能打开；刷新后回到上次页；loading overlay 正常出现与消失。
5. 转换：`convert.sh` 全流程跑通，layer demo 页在 PPTX 中展开为多页，页序正确。
6. skill 安装测试：目录复制到 `~/.claude/skills/` 后新会话可触发；SKILL.md 内相对路径全部有效。

## 6. 风险与对策

- **删 40+ 页的记账风险**：逐批删 + 每批 `verify`（section/nav/chapters 一致性）+ 截图抽查；备份进 scratchpad。
- **删 base64 图后 manifest 悬空引用**：删除时同步清 manifest 条目，完成后扫描 `<img src="uuid">` 与 manifest 双向对账。
- **占位文案破坏版式**（文字量变化致溢出/空洞）：占位文案按原文字量级书写；改完全页 overflow 验证。
- **skill 触发描述与现有 dc-slide-deck 撞车**：SKILL.md description 面向「新建华为风演示」，
  dc-slide-deck 面向「维护训练Infra课程 deck」，措辞区分。

## 7. 已确认的决策记录

- 起步形态：从课程 HTML 抽出的模板 deck（页型画廊，非最小空壳、非生成器）；模板作为 skill 资料库内置。
- 品牌元素：保留但做成可替换点。
- html2pptx：layer 展开、build 全显一页（不展开、不加开关）。
- 产出方式：方案 A（页型精选 + 占位化，做减法）。
- 现有 dc-slide-deck 与主课程 deck 均保持原样不动。
