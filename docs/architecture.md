# huawei-deck · 设计原则、工作流与代码架构梳理

> 本文是对本 skill 的系统性梳理：它按什么原则设计、用户与 Agent 按什么流程协作、代码分几层各干什么。
> 与 `docs/design/` 的关系：`design-spec.md` / `implementation-plan.md` 是**构建时**的规格与计划（记录「当初怎么做出来的」）；本文描述**现状**（现在的结构是什么、为什么这样设计）。改动仓库时若行为与本文不符，以 `SKILL.md` 与 `references/` 为准并回来同步本文。

---

## 1. 这是什么

huawei-deck 是一个符合 `SKILL.md` 目录约定的 **Agent Skill**，不是普通应用代码库。它交付的能力是：从三套华为红品牌模板出发，做出 1920×1080、离线可拷走的**单文件 HTML 演示（网页 PPT）**，并可一键导出 PPTX。

交付物四块：

| 组成 | 内容 | 角色 |
|---|---|---|
| `SKILL.md` | 触发描述 + 5 步快速上手 + 9 条设计铁律 + 文件导航 | skill 入口，Claude 触发后最先读取的文件 |
| `assets/` | 三套模板 deck（授课 34 页 / 技术分享 36 页 / 汇报 41 页，各 ~12MB）+ 华为官方素材库 `huawei-refs/` | 起点资产：复制后再改，绝不直接改模板 |
| `references/` | 9 份使用文档（流程 / 页型索引 / 设计系统 / 动画 / 片段 / 编辑 / 配图 / 品牌 / 官方风格） | 按需加载的知识库，SKILL.md 每条铁律指向对应 reference |
| `scripts/` | edit-bundle.py（编辑）、deck-editor.py + editor/（后期微调）、verify 三件套（验证）、html2pptx（导出）、apply_bg.py（品牌图替换）、check_deps.py（依赖检查） | 工具链：编辑、微调、验证、导出均由脚本完成结构同步与检查 |

一个关键的产品决策（见 `docs/design/design-spec.md`）：模板不是「最小空壳」也不是「生成器」，而是**页型画廊**——从一份 77 页真实课件**做减法**产出。每一页既是可复制的版式，占位文案本身又在讲解「这一栏该怎么写」，即「**画廊即文档**」；另保留 10 页真实课件成品作对照。

---

## 2. 设计原则

### 2.1 产品层

1. **单文件、真离线**。React 运行时、双字体（Noto Sans SC 400–700 + JetBrains Mono）、全部图片以 base64 内联进一个 HTML；拷走一个文件即可放映，断网、`file://` 直开均可。代价是文件 ~12MB、不能用编辑器直改——这是整套工具链存在的根因（见 §4.1）。
2. **画廊即文档**。占位文案 = 用法说明（例：h3 占位写「一句话说清本页主张」），浏览器滚一遍模板就等于读完排版手册；`references/template-pages.md` 只做逐页索引与「怎么改」。
3. **场景三分，同一工具链**。授课 / 技术分享 / 汇报三套模板平等并列，共用设计系统与全部脚本；差异只在页型集合与基调（叙事骨架、页数节奏、动画量、语言风格——见 `workflow.md` 场景适配表）。
4. **品牌可替换，不做通用主题系统**。华为品牌元素（背景画 / 黑板底图 / 人像 / logo / 口号 / 红色系）全部登记为**可替换点**，配有脚本和文档；但不抽象成主题配置——保持模板可直接照抄的具体性。
5. **模板只读，副本工作**。所有编辑都发生在 `cp assets/xxx.html my-deck.html` 之后的副本上。

### 2.2 视觉设计系统（`design-system.md` / `huawei-style.md`）

- **三色体系**：品牌红 `#b5333b`（强调 / 真警示）+ 灰蓝 `#566472`（对照 / 次要）+ 中性灰阶。铁律「去花花绿绿」：外部素材搬入先按三色重新上色；红只给真警示与本页重点。深色页参照官方公式「黑底 + 白字 + 金强调 + 红点缀」。
- **双字体分工**：中文一律 Noto Sans SC（**绝不只挂 JetBrains Mono**——它无中文字形，会回退细体）；数字 / 英文 / 代码 / mono 小标签用 JetBrains Mono。
- **一套字号刻度 + 21px 散文地板**：正文区只用 `{13,15,17,19,21,24,27,30}`；「给听众读的散文」最小 21px，图元（表格单元格、轴标签、框图内文字）豁免。判别法：`font-size < 21` 且带 `line-height` 的是散文。
- **四段页结构**：eyebrow（18px mono 小标签）→ h3 大标题（46px）→ 可选导语（21px）→ 主体（`flex:1; min-height:0`，版式不塌的关键）。
- **1080 硬约束**：section 是 `overflow:hidden`，超高**无声裁切**——所以「改完必跑 measure_overflow」是铁律而非建议。
- **文案原则**：标题即观点且点名技术（「基于 X 实现 Y」句式，全部标题连读 = 论证链）；不写套话广告词；页面上绝不写「点击查看」类操作提示。

### 2.3 动画原则（`animation.md`）

- **只靠讲者手动推进，绝不自动循环**——动画是讲课节奏的控制器，不是炫技。SMIL 装饰动效是唯一例外（循环但不占节拍）。
- 三机制分工：**build**（逐拍揭示，`data-step` + 点击计数 level）、**layer**（同 key 同组按钮/面板互斥切换）、**SMIL**（SVG 连续运动，随页激活/冻结）。build 与 layer 共享同一 level，可串成混合链。
- **拍数公式**：总拍数 = 页内最大 `data-step` + 2（进页空场 1 拍 + 讲完翻页 1 拍）。此规则在 deck 运行时与 `steps.mjs` 各实现一份，**改一处必须同步另一处**。
- 设计方法「先排拍后编号」：先列讲稿节拍表（一个知识节拍归同一拍），再翻译成连续的 data-step。

### 2.4 协作流程原则（`workflow.md`）

- **设计先于搭页**：从零做 deck 必走七阶段流程，三个「讨论」阶段是**硬闸门**——用户没确认不进下一阶段。用户催「直接做」时，把五问压成带默认值的一轮快答，加速形式、不豁免闸门。
- **初版占位、终版落地**：初版配图一律放类型化占位块（`data-todo="fig"` + 类型 + 来源 + 规格），结构定了才抠图、配动画——避免精修变沉没成本。
- **计划落盘**：大纲与逐页规划写进伴生文件 `<deck名>.plan.md`，不留在对话里（换会话即丢）。
- **验证先于交付**：每改一批跑 verify 三件套；溢出裁切是无声的，「不跑 verify 就给用户」列在常见错误表里。

### 2.5 工程原则（贯穿所有脚本）

1. **编辑必经 edit-bundle.py**。deck 的 HTML 藏在一行 JSON 字符串里，编码只有一条正确路径（§4.2）；编辑器 / sed / Edit 工具直改几乎必坏文件。
2. **结构三处同步自动化**。增删移页要同时改 slide DOM / `nav[]` / `chapters[].start` 三处，`insert_page` / `delete_page` / `move_page` 已封装这三处的同步，调用方不手工修改其中任何一处。
3. **统一退出码契约**：所有可执行脚本一致——`0` 通过 / `1` 检出业务问题 / `2` 工具或参数错误，可直接接 CI。
4. **`data-label` 是唯一定位手段**。shot / steps / measure_overflow / edit-bundle 全靠它找页；同名 label 是全工具链的已知弱点（多数工具只取第一个，见 `editing-guide.md` §4）。
5. **危险操作先预览、写盘要原子、落盘后复核**。`apply_bg.py` 默认只打印摘要（`--yes` 才落盘），写盘走「临时文件 + `os.replace`」，之后从盘上重读复核（旧 key 零残留、引用数一致）再跑 `eb.verify`。
6. **缺依赖时给出可操作提示**。playwright-core 三级查找（`PLAYWRIGHT_CORE` 环境变量 → 直接 import → openclaw 内置路径），四处实现（三个 verify 脚本 + shoot.mjs）顺序一致，check_deps.py 的探测也用同一顺序；缺依赖时打印**具体的中文安装命令**，而不是原始报错堆栈。
7. **全中文**。文档、注释、报错信息均为中文，新增内容保持中文。

---

## 3. 工作流

### 3.1 总流程：七阶段协作（从零做一份 deck）

```mermaid
flowchart LR
    S1["1 主题讨论<br/>五问一次问完"] -->|"闸门：用户确认需求共识"| S2["2 大纲规划<br/>大纲落盘 plan.md"]
    S2 -->|"闸门：用户确认"| S3["3 选择模板<br/>页型映射表"]
    S3 --> S4["4 初版制定<br/>逐页规划表 + 初版 deck"]
    S4 --> S5["5 讨论修改<br/>按页记录修改清单"]
    S5 -->|"闸门：结构定了"| S6["6 终版制作<br/>配图 / 动画 / 品牌 / 全量验证"]
    S6 --> S7["7 讨论修改<br/>只接受精修"]
    S7 -->|"闸门：用户验收"| D(["交付"])
    S7 -.->|"结构性返工回闸门"| S5
```

- 阶段 1 问清五件事（听众 / 场合时长 / 目标 / 素材 / 品牌与交付），按**场景适配表**定基调。
- 阶段 4 的逐页规划表每页一行：`页序 | data-label | 页型 | 核心观点(一句话) | 排版逻辑 | 配图(类型+规格) | 拍数`。核心观点写不成一句话就拆页，两页同一句就合页。
- 阶段 6 精修顺序固定：配图落地 → 动画节拍 → 品牌替换 → 全量验证 → （可选）导 PPTX。
- 汇报场景若 PPTX 是硬要求，**阶段 4 初版就先试导一次**，转换问题在结构讨论前暴露。
- 阶段 7 只接受精修级改动；结构性返工回阶段 5 重新走闸门。

### 3.2 机械操作：5 步循环（改一份已有 deck 时直接用）

```mermaid
flowchart LR
    A["复制模板<br/>cp assets/…"] --> B["挑页改占位<br/>查 template-pages<br/>经 edit-bundle"]
    B --> C["增删移页<br/>edit-bundle.py<br/>三处同步全自动"]
    C --> V["verify 三件套<br/>每改一批必跑"]
    V -.->|"检出溢出 / 拍数不对"| B
    V -->|"通过"| P["（可选）html2pptx<br/>convert.sh"]
```

### 3.3 配图工作流（`artwork.md`）

总原则「字不如表，表不如图」，分工：素材原图给证据 / 自绘图讲机制 / 表格管对比枚举。

```mermaid
flowchart TD
    P["初版：每个图位放类型化占位块 data-todo=fig<br/>类型四选一（原图 / 自绘·流程 / 自绘·架构 / 表格）+ 来源 + 内容规格"]
    P --> G["终版：grep data-todo 清点，逐个落地"]
    G --> A["A 抽原图<br/>pptx 先 soffice 转 pdf → PyMuPDF 整页渲染找图<br/>→ zoom 3 裁切 → Read 目检 → embed_image"]
    G --> B["B 自绘<br/>div + flex 拼节点 / 箭头<br/>三种拓扑（直线 / 分支 / 泳道），三色上色"]
    G --> C["C 制表<br/>分组表骨架<br/>单元格按图元字号（15–17px）"]
    A --> Z["data-todo 计数归零"]
    B --> Z
    C --> Z
    Z --> V["verify（measure_overflow --all + 改动页 shot 目检）"]
```

素材多于 3 篇时并行派 agent 抽图，每个 agent 给足路径 / 目标图描述 / 输出名 / 三步方法。

### 3.4 验证工作流（verify 三件套）

| 脚本 | 干什么 | 判定 |
|---|---|---|
| `measure_overflow.mjs <deck> --all` | 全页测 section 级溢出（Y/X 像素）+ 内层 `overflow:hidden` 裁切 | 溢出 >0 → exit 1；内层裁切只报告，逐条目检 |
| `shot.mjs <deck> <label> out.jpg` | 单页 1920×1080 截图（build 全显），供目检 | label 不存在 → exit 1 并列出全部可用 label |
| `steps.mjs <deck> <label> outdir/` | 模拟放映引擎逐拍截图 step-NN.jpg，逐拍打印新出现元素 | 对着讲稿核对每拍内容 |

外加结构验证 `python3 scripts/edit-bundle.py my-deck.html`（= `eb.verify`）：打印 slide-fit / section / nav 数量与 chapters 起点，nav 编号不连续直接 assert 失败。

### 3.5 PPTX 导出（html2pptx）

```mermaid
flowchart LR
    IN["my-deck.html"] --> SH
    subgraph CV ["convert.sh（一键入口，SCALE / QUALITY / EMBED_HTML 可调）"]
        SH["shoot.mjs<br/>headless Chrome 逐页截图<br/>layer 逐标签展开"] --> IMG["slide-NNN.jpg<br/>+ manifest.json"]
        IMG --> BP["build_pptx.py<br/>python-pptx 组装 16:9<br/>每页一张满屏图"]
        OLE["ole_package.py<br/>原 HTML 封装为 OLE Package"] -.->|"EMBED_HTML=1 时嵌入第 1 页"| BP
    end
    BP --> OUT["my-deck.pptx"]
```

工具不解析打包结构——**渲染什么截什么**，改完 deck 直接重跑。已知限制：靠 React 内部 state 的自制交互页无法程序化展开，只截默认态。

### 3.6 品牌替换（`branding.md`）

四类图（bg / board / people / logo）走 `apply_bg.py`（预览 → `--yes`）；口号与品牌色走 edit-bundle 文本 / 色值映射替换（每个色值打印替换处数，出现 0 处即停下检查）；换色后注意警示红与品牌红同值的语义检查。

### 3.7 环境体检

动手前 `python3 scripts/check_deps.py`：探测 13 项依赖（pdf skill、pypdf、pdfplumber、Node≥18、ws、html2canvas、busboy、playwright-core、Chrome、python-pptx、pymupdf、soffice、可选 reportlab），能自动装的（pip/npm/npx）先打印命令再装并复检，装不了的给安装提示；`--check-only` 只报告。

### 3.8 后期可视化微调工作流

新建 deck、批量重构、增删移页仍由 Agent 和 `scripts/edit-bundle.py` 完成；当页面结构已经稳定，可启动后期编辑器：

```bash
python3 scripts/deck-editor.py <deck.html>
python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
```

浏览器提供预览、编辑、区域标记三种一级模式；`edit` 在 frame 内统一路由文字、移动和缩放，旧 `text` / `move` / `resize` 消息会规范化为 `edit`，但不再作为界面工具出现。双击文字进入修改，拖动元素本体移动，选中框右下控制点缩放；移动与缩放超过 3 个屏幕像素才更新预览，避免单击和双击误提交动作。区域拉框后在旁侧输入说明，任务可跨页进入 Agent 任务 drawer；待处理、失败和待确认任务可经 `PATCH /api/tasks/<TASK_ID>` 修改说明，或经 `DELETE` 二次确认删除，Agent run 活跃时服务端统一拒绝，已完成任务需先撤销。任务删除先提交权威 session，再清理截图与附件；清理失败只留下可对账孤儿，不会恢复任务或制造悬空引用。frame 的文字命中先使用点击坐标取得真实 Text 节点：无 class 叶节点直接定位元素；混排父元素则在 element locator 上附加最多 32 层的规范 childNodes `textPath`，编辑时仅临时包装该文本节点，提交前恢复 DOM，再由 runtime 精确写回节点 data，因此不会把 `strong`、链接和 `<br>` 扁平化。action compiler 的状态键包含 `textPath`，但 locator 仍跨片段和动作类型复用同一元素的最早安全指纹。进入文字编辑时只按点击坐标放置折叠光标，blur 或 `Cmd/Ctrl+Enter` 统一提交动作。移动命中则沿祖先寻找最近的 positioned 或 block / flex / grid 等独立布局盒，不依赖 class，同时排除 section / stage / canvas 等结构容器。图片内文字、SVG 和交互组件仍 fail closed。外部 Codex / Claude Code / Agent 不是内置聊天机器人；drawer 不承载对话，但“交给 Agent”会经固定 schema 的 `POST /api/agent-runs` 立即触发当前批次。Agent 只通过 CLI / HTTP 调用受控接口：`GET /api/session` 读取 status，`GET /api/tasks` 读取任务，`PATCH|DELETE /api/tasks/<TASK_ID>` 维护任务，`POST /api/actions` 提交动作，`POST /api/groups/<GROUP_ID>/undo` 与 `POST /api/groups/<GROUP_ID>/redo` 执行 undo / redo，`POST /api/write-deck` 正式写回。observer WebSocket 使用 `/events`，仅订阅服务事件；唯一 editor capability WebSocket 只在 parent 与服务之间传递 frame 事务命令和 ACK，不对外提交动作。

顶栏的“撤销 / 重做”按时间顺序操作同一份权威历史，覆盖人工文字、移动、缩放和 Agent 动作组。parent 与 frame 分别监听键盘并通过受限 `history-shortcut` 消息汇合到同一 `changeHistory`：`Cmd/Ctrl+Z` 撤销，`Cmd/Ctrl+Shift+Z` 重做，Windows 兼容 `Ctrl+Y`；输入框、`role=textbox` 与 `contenteditable` 保留浏览器原生撤销。任务行仍保留定点撤销，定点撤销后也可从顶栏重做。区域任务可选择文件（支持多选和连续追加）或粘贴图片，粘贴图片会转为 PNG；每个任务最多 8 个附件，单个文件最大 25 MiB。浏览器无法取得原文件绝对路径，服务会把副本复制到 sidecar 会话的 `attachments/`。只有任务 payload 的序列化出口会派生路径：`GET /api/tasks`、`GET /api/tasks/<TASK_ID>`、`POST /api/tasks` 响应中的 `task`、`task-created` / `task-updated` 等事件或动作响应中的 `task`，以及 CLI `tasks` / `task`；这些出口返回副本绝对 path，供外部 Agent 读取。`GET /api/session` 与磁盘 `session.json` 只含 sidecar 相对 `relativePath`，不保存、也不返回附件绝对路径。附件不进入最终 deck，并随 sidecar 生命周期管理，也不属于 Deck 动作的撤销 / 重做范围。

预览、区域标记和自动会话保存不触碰原始 source deck。`.huawei-deck-editor/` 自动保存会话、任务、快照、动作、诊断与备份；它不进入最终交付 deck，并由仓库 `.gitignore` 忽略提交。正式写回由用户明确触发，三重闸门依次检查 editor online、文件指纹、无新增溢出并执行 bundle verify。`scripts/edit-bundle.py` 仅在系统临时工作副本执行 `load`、`get_template`、`set_template`、`save`、`eb.verify`；bundle adapter / writer 负责 sidecar 备份、同目录候选、transaction、fingerprint 复核、`os.replace` 与失败恢复。冲突或验证失败拒绝覆盖。

第一版不增删页、不调整页序、不重构复杂动画、不内置聊天。Agent 动作受 token、revision、locator 与事务校验。session 可重开；`RECOVERY_REQUIRED` 会让未决恢复状态阻断继续写回，外部文件变化必须重载，或另存副本。

写回后运行 `python3 scripts/edit-bundle.py <deck.html>`（`eb.verify`）、`measure_overflow.mjs` 和改动页 `shot.mjs`；只有修改动画页才运行 `steps.mjs`。`shot.mjs` / 动画页的 `steps.mjs` 固定按 1920×1080 逻辑画布截图；无动画页执行 `steps.mjs` 只打印“此页无动画”并退出 0，不生成逐拍截图。

---

## 4. 代码架构

### 4.1 单文件 bundle 格式与浏览器端 loader

deck 文件本体约 220 行，由页面骨架、两行超长 JSON 和 loader 脚本组成：

```
<!DOCTYPE html>
<head>   骨架样式 + loading 动画（牛顿摆）+ noscript 提示
<body>
  <div id="__bundler_thumbnail">      # 解包期间的占位画面
  <script>  ← bundler loader（见下）
  <script type="__bundler/manifest">  # 下一行 = 一行 JSON dict: {uuid: {mime, compressed, data(base64)}}
  <script type="__bundler/template">  # 下一行 = 一行 JSON 字符串: 整份 deck HTML
```

**template 字符串包含整份 deck 的全部内容**：每页 `<section data-label=…>`、导航数组 `nav[]`、章节起点 `chapters[]`、目录页数据 `TOC[]` / `builders[]`、内联的 React/ReactDOM UMD、运行时脚本、按 data-label 精确匹配挂背景的 `<style id="tpl-bg-950">`。

loader 在 `DOMContentLoaded` 后执行五步：

```mermaid
flowchart TD
    S1["① 解包 manifest<br/>逐条 base64 解码（compressed:true 走 DecompressionStream gzip，如 React 运行时）<br/>每个资源转成 blob URL"]
    S1 --> S2["② 替换引用<br/>template 字符串里的所有 uuid 全局替换为对应 blob URL"]
    S2 --> S3["③ 移除 SRI 属性<br/>删除 integrity / crossorigin 属性<br/>（file:// 下 blob URL 是 null origin，SRI 校验会失败、脚本被拒绝加载）"]
    S3 --> S4["④ 解析并替换 DOM<br/>DOMParser 解析 template → document.documentElement.replaceWith(...)<br/>DOMParser 注入的 script 默认不执行：逐个 createElement 重建<br/>并 await onload 保证执行顺序（React → ReactDOM → 运行时）"]
    S4 --> S5["⑤ 显示加载遮罩<br/>插入 #__deck_loading_overlay 遮住 React 挂载前的原始页面<br/>等 React mount + 图片加载完成后淡出并移除"]
```

这套结构决定了两条工程铁律：**图片的增删走 manifest**（`embed_image` 追加条目；`apply_bg.py` 替换后删除旧条目，避免 manifest 残留无引用的数据），**HTML 改动走 template 字符串替换**。

### 4.2 edit-bundle.py：唯一的安全编辑通道

按行读文件（`load`/`save`），靠标记行定位那两行 JSON（`_tpl_idx`/`_man_idx`），全部操作是**纯字符串查找与替换**——不引入 HTML parser，读出再写回不会改动任何未触及的内容。

```
读写      load / save / get_template / set_template(→dump_template)
资源      embed_image（追加 manifest）/ get_resource（解码某 uuid）/ inline_react（离线修复）
结构      insert_page / delete_page / move_page（三处同步）+ bump_chapters（跨章移动后手工修正）
内部      _slide_bounds（按 data-label 定位整块 slide-fit）/ _nav_entries / _write_nav / _bump_after_page
辅助      grid（矩阵表 HTML 生成）
验证      verify（数量一致 + nav 连续断言 + 打印 chapters）
```

**编码不变量**（改脚本必须保持，`dump_template` 内置断言）：

```python
raw = json.dumps(s, ensure_ascii=False).replace('</', '<\\u002F')
assert '\n' not in raw and '</' not in raw and json.loads(raw) == s
```

只转义 `</`（防字符串里的 `</script>` 提前闭合文档），CJK 与 URL 里的普通 `/` 不动。

**三处同步的记账逻辑**：页所属章 = `max(start ≤ 该页 nav 索引)`。插页时**先**用 before 页的原索引定章再动 DOM/nav（插入后索引 +1 会撞下一章 start）；删页后该页所在章之后各章 start −1；`move_page` 只保证同章内安全，跨章需手工 `bump_chapters`。

### 4.3 verify 三件套 + shoot.mjs：四个脚本的公共执行流程

四个 .mjs 共用同一套模式：

```mermaid
flowchart TD
    L["loadChromium()<br/>三级查找 playwright-core：<br/>PLAYWRIGHT_CORE 环境变量 → import → openclaw 内置路径"]
    L -->|"都找不到"| X(["exit 2 + 中文安装提示"])
    L --> LA["launch Chrome<br/>channel:'chrome' + headless，1920×1080 viewport"]
    LA --> LO["load & settle<br/>goto(file://) 180s 超时 → waitForFunction(.slide-canvas 出现)<br/>→ 定时 settle（React mount / 字体 / 图片）"]
    LO --> CSS["注入 CSS<br/>隐藏 UI 外壳（玻璃条 / 侧栏 / 提示 / 笔记 / loading overlay）<br/>+ 强制 content-visibility:visible<br/>+ logo 左移 8px（fixed right:22px 超出 canvas 元素框，element.screenshot 会裁右缘）"]
    CSS --> LOC["定位目标页<br/>按 data-label 找 .slide-canvas<br/>（CSS.escape 防特殊字符；同名只取第一个并警告）"]
    LOC --> ACT["截图 / 测量（各脚本核心动作，见下）<br/>scrollIntoViewIfNeeded 后原位操作<br/>（canvas 祖先有 transform，不能 position:fixed 钉页）"]
```

差异在核心动作：

- **measure_overflow**：`.build` 强显后测 `sect.scrollHeight - clientHeight`（section 级，>0 判失败）+ 遍历全部元素找 `overflow:hidden` 且 scroll>client 的内层裁切（只报告）。`--all` 按 canvas 遍历，是同名 label 唯一各测各的模式。
- **shot**：`.build` 强显，单页 element.screenshot。
- **steps**：在页面里实现了一份与 deck 运行时相同的放映引擎规则——对 level 从 0 到 max+1 逐拍：build 按 `data-step < level` toggle `data-shown`；layer 每组取「data-step < level 中最大者，否则组内第一个按钮」toggle `data-active`；每拍截图并打印新出现元素摘要。**此实现与 deck 运行时的引擎规则一一对应，改任一侧必须同步另一侧。**
- **shoot（html2pptx）**：不按拍数截图，而是做 **layer 标签展开**——探测每页的标签组（按钮须有配对面板才算），先把所有组切到第一个标签、截一张全默认态，再逐组逐标签各截一张（截某组时其余组停在第一个标签；`gi>0 && ki==0` 跳过，避免全默认态重复），按顺序写 `manifest.json`。34 页模板由此展开为 55 张。

### 4.4 apply_bg.py：品牌图替换流程

替换点的定位是**运行时解析**而非硬编码 key（bg/board/people 从 `<style id="tpl-bg-950">` 对应规则的 `url()` 读当前 key；logo 从 `alt="HUAWEI"` 或 `data-brand-logo` 的 img 读 src），所以换过一次后仍可再换。执行六步：新图入 manifest → 全部引用替换（计数校验）→ `set_template` 回填 → 删旧 manifest 条目 → 原子写盘（tmp + `os.replace`）→ 盘上复核 + `eb.verify`。

### 4.5 依赖关系图

```mermaid
flowchart TD
    U["用户 / Claude"] --> SK["SKILL.md（入口）"]
    SK -->|"每条铁律指向"| REF["references/*.md × 9<br/>（互相交叉引用）"]

    subgraph EDIT ["编辑层（纯 Python 标准库）"]
        AB["apply_bg.py"] -->|"importlib 导入"| EB["edit-bundle.py"]
    end
    U --> EB
    EB -->|"字符串读写"| DECK["assets / my-deck.html<br/>（bundle：manifest + template）"]

    subgraph BROWSER ["验证 / 截图层（Node ≥ 18 + 本机 Chrome + playwright-core 三级查找）"]
        VER["verify/measure_overflow.mjs<br/>verify/shot.mjs · verify/steps.mjs"]
        SH["html2pptx/shoot.mjs"]
    end
    VER -->|"headless 渲染"| DECK
    SH -->|"headless 渲染"| DECK
    SH --> IMG["截图目录 + manifest.json"]
    IMG --> BP["html2pptx/build_pptx.py<br/>（python-pptx；EMBED_HTML 时 + PIL / ole_package.py）"]

    CD["check_deps.py"] -.->|"探测 / 自动安装"| BROWSER
    CD -.->|"探测 / 自动安装"| EXT["外部素材解析<br/>soffice（pptx→pdf）+ PyMuPDF（渲染 / 抽图）<br/>+ .agents/skills/pdf/（进阶 PDF）"]
    CD -.->|"探测"| PPTXDEP["python-pptx"]
    PPTXDEP -.-> BP
```

### 4.6 后期编辑器组件与运行时契约

后期编辑器的启动 seam 是 `scripts/deck-editor.py`：macOS 的 `Huawei Deck 编辑器.app` 是桌面 adapter，Python 启动器是命令 adapter。用户双击 `Huawei Deck 编辑器.app` 后会先打开本地网页导入页；只有用户在网页点击“添加 Deck HTML”后，才会打开系统文件选择器以选择已有 deck HTML。导入状态只能从 idle 进入 choosing，再进入 selected；取消回到 idle，成功后立即锁定并关闭导入服务。每次应用启动只允许成功添加一份 deck HTML；添加后不提供切换或再次添加入口。命令式入口完整保留：`python3 scripts/deck-editor.py <deck.html>`。

无路径时，Python 只启动 `app-server.mjs`；它以随机 token 保护 loopback 导入页，按钮请求只能触发本机选择器，浏览器不能提交任意文件路径。选择成功后，它在同一 Node 进程启动现有 `server.mjs` 并跳转到编辑工作台。有路径时则绕过导入页，直接进入 `server.mjs`，因此 Skill 生成第一版后仍可直接带路径打开。带路径的 Python 入口自动捕获 `CODEX_THREAD_ID`，macOS App 参数也可显式传 `--agent-thread-id`；该启动值只是 Deck-Agent 连接模块的高优先级输入，解析后会写入 Deck sidecar。以后独立导入同一份 Deck 时即使没有启动参数，也会恢复持久化连接。两条路径共享 deck 校验、依赖探测、编辑服务、Agent 调度、bundle adapter、BridgeService 与写回闸门；桌面 adapter 仅增加一次性导入、原生错误提示、缺失 Node 模块自动安装和浏览器关闭后的延迟退出。

macOS App 的主可执行文件只做短时派发：经 `nohup` 启动 Python 后立即退出，编辑服务独立持有生命周期。不能让 shell 型 App 主进程随编辑服务长期存活，否则 LaunchServices 会把它当成单实例应用；第二次双击无法向非 Cocoa 进程投递 reopen 事件并返回 `-600`。App 必须保留在 skill 根目录，若被单独移动则以原生对话框明确提示，而不是静默退出。

后期编辑器由 browser parent 和 preview frame 两层组成：parent 的 `public/editor.mjs` 管模式、页列表、task drawer、session 拉取与外部事件；frame 中注入 `frame-bridge.mjs` 和 `runtime/patch-runtime.js`，负责坐标换算、locator、区域快照、直接操作与 tentative DOM 变更。两层通过同源 `postMessage` 协作，frame 不获得通用文件系统能力。

核心组件职责如下：

| 组件 | 职责 |
|---|---|
| `Huawei Deck 编辑器.app` / `deck-editor.py` | 桌面与命令双入口；无路径进入一次性网页导入，有路径直接接收 deck |
| `app-server.mjs` | loopback 导入页与 idle → choosing → selected 状态机；成功后关闭自身并启动既有编辑服务 |
| observer WebSocket | 普通 token 客户端连接 `/events`，只订阅 revision、task、action、undo / redo 与冲突广播，不能发送动作命令 |
| editor capability WebSocket | 同一 `/events` 端点上额外携带 `editorToken`；只允许一个 editor client，服务用它下发 frame 事务 / 诊断命令并接收 ACK |
| `BridgeService` | mutation queue 串行化任务、动作、undo / redo、诊断和写回；执行页面事务与 durable session 的两阶段收敛 |
| `SessionStore` + `PatchJournal` | session revision、跨页任务、PNG 快照路径、动作组、redo 集与 diagnostics；编译当前权威动作集合 |
| `AgentRunCoordinator` + provider router | 冻结一次点击的任务 ID，限制单批并发，管理 queued / running / succeeded / failed；按当前 Deck 连接路由到 Codex / Claude Code / OpenCode / OpenClaw adapter |
| `agent-session-catalog.mjs` | 只读聚合各 provider 的本机会话目录，隔离未安装 / 读取失败，并按历史证据给出 Skill 状态 |
| persistent dirfd helper | Python JSONL 长驻进程；绑定 project / root / session / snapshots / backups / transactions / write-errors 的目录 fd，执行原子持久化 |
| bundle adapter | Python `bundle_adapter.py`；只在可信临时副本上调用 `scripts/edit-bundle.py`，构造离线补丁块并做 bundle verify |
| diagnostics / watch / write gate | frame 诊断 1920×1080 溢出，watch 监测外部 deck 指纹，write gate 聚合 online、fingerprint、overflow 与 bundle 校验 |

状态模型可以概括为一条链：session registry 绑定稳定 sessionId，transaction record 记录可恢复写回事务，revision 守住并发前提，mutation queue 串行化变更，canonical action 固化 frame 实际接受的动作，authoritative reload 用完整编译集合替换浏览器状态。

#### Agent 批处理与 provider seam

浏览器点击“交给 Agent”时只向 `POST /api/agent-runs` 发送 `expectedRevision` 和仍为 pending / failed 的任务 ID。服务端校验 revision、任务存在性与单批互斥后立即返回 run snapshot；后续状态通过 `GET /api/agent-runs/current` 和 observer WebSocket 的 `agent-run-updated` 广播。浏览器不能指定 executable、命令参数或 Prompt，因此该入口不是任意命令执行器。点击之后新建的任务不属于已冻结批次。

adapter 不再根据 App 的打开方式选择会话，而只读取当前 Deck-Agent 连接。Codex 使用 `codex exec resume`，Claude Code 使用 print/resume，OpenCode 使用 run/session，OpenClaw 使用 agent/session；没有绑定时可由当前 provider 新建专用会话。用户在连接面板显式新建会话时，adapter 立即以所选 `projectPath` 为 cwd 做一次只读 Skill 初始化，并在 Deck 不属于该项目时单独授予 Deck 目录；初始化不处理任务、不修改 deck。旧会话的 Skill 状态若为未检测到 / 无法确认，则只在首次任务注入 `SKILL.md` 与所需 references。成功后经 BridgeService mutation queue 把会话 ID、`projectPath` 与 `skillStatus=loaded` 持久化到 `session.json.agentConnection`。启动参数、网页会话选择、手动设置和新建结果都汇入同一个 seam。顶栏把连接投影为绿色“<provider> 在线”或红色“Agent 离线”；点击后按 provider 标签和项目 cwd 分组展示会话，项目标题与缩进会话使用不同视觉层级。Agent 只能经已有 CLI / HTTP 读取任务、提交 action，不直接改 bundle，也不自动调用 `write-deck`。

provider seam 统一为 `run(...)`、`connection`、`configure(...)` 与 `createSession(...)`：adapter 内部负责非交互命令、session 续跑、结构化事件解析、项目 cwd、权限与 Skill 注入。`GET /api/agent-sessions` 聚合 Codex app-server `thread/list`、Claude Code 本地 JSONL、OpenCode `session list` 与 OpenClaw `sessions --json`，同时返回按 cwd 归并的项目；`POST /api/agent-sessions/inspect` 只读检查选定会话，`POST /api/agent-projects/pick` 只接收原生目录选择器返回的规范路径，`POST /api/agent-sessions` 只允许在这批已验证项目中创建会话。检测结果分为 `loaded`（sidecar 已确认）、`detected`（历史有明确证据）、`not-detected`（可读历史无证据）与 `unknown`（provider 无法证明）。`GET /api/agent-providers` 暴露能力目录，`GET/PUT /api/agent-connection` 只接受 provider 枚举、规范会话 ID、已知项目路径与 revision，网页不能传 executable、参数或 Prompt；运行期间禁止改绑。编辑器 URL / token 经子进程环境变量传递，避免进入 provider 命令参数。

#### 动作事务

1. 外部 Agent 经 `POST /api/actions`，或 parent 经同一 HTTP 路由，带 `expectedRevision` 与 locator 提交 action。
2. `BridgeService` 通过唯一 editor capability WebSocket 把事务命令发给 parent，再转交 preview frame；frame 定位目标并做 tentative 应用，返回逐字段完整的 canonical action 与 ACK。该 capability 不对外暴露动作提交能力。
3. `PatchJournal` 把动作组写入候选 session，`SessionStore` durable 落盘并增加 revision；成功后才向 frame 发 commit。持久化失败则发 rollback，DOM 与 runtime 基线恢复。
4. commit ACK 丢失时以 durable session 为准同步；重连或 iframe-only reload 都用 authoritative compiled 集合重放。undo / redo 也走同一队列和完整集合，而不是只发送单条反向动作。

#### sidecar、恢复与持久化

`.huawei-deck-editor/` 根下的 `sessions.json` 是 session registry；每个注册 session 包含 `session.json`、`snapshots/`、`backups/`、`transactions/`、`write-errors/`、正式附件目录 `attachments/` 与上传暂存目录 `attachments/.staging/`。目录保存会话、任务、快照、动作、附件、诊断与备份，不进入最终交付 deck；仓库 `.gitignore` 忽略提交它。helper 启动后持有根目录锁，所有实际读取与写入都相对已绑定 dirfd 完成，并拒绝符号链接替换、未注册 session 和不可信 record。`attachments/` 与 `attachments/.staging/` 的 dirfd 在恢复校验后绑定，并与 helper 生命周期一致；服务关闭时先收敛附件 writer，再释放附件 dirfd 和核心 dirfd。

关闭再启动同一 deck 时，registry 与文件指纹选择唯一可恢复 session。若发现 durable transaction，服务按磁盘 fingerprint、session fingerprint 与备份三方收敛；无法证明唯一安全结果时进入 `RECOVERY_REQUIRED` 只读状态，阻断动作和继续写回，要求重启恢复。外部 deck 变化记录为 `DECK_CHANGED`，只能重载新基线或另存副本，不会猜测覆盖。

#### 写回顺序与失败原子性

正式写回仅接受用户明确授权后的 `POST /api/write-deck`，顺序固定：

1. mutation queue 检查 revision、editor online 和诊断 ready；
2. 读取磁盘 fingerprint，与 session 基线及 watch conflict 比较；
3. frame 针对修改页返回 diagnostics，与启动基线比较，新增 section overflow 或 nested clip 以 `NEW_OVERFLOW` 阻断；
4. bundle adapter / writer 经可信 dirfd 读取 deck 并创建 sidecar 内容寻址备份；`scripts/edit-bundle.py` 仅在系统临时工作副本执行 `load` → `get_template` → `set_template` → `save` → `eb.verify`；
5. 把候选写成 deck 同目录的独占临时文件，再次核对源文件，durable 写入 transaction record；
6. `os.replace` 原子替换，持久化新的 session fingerprint / diagnostics，最后删除 transaction。

若替换前失败，正式 deck 字节不变；替换后 session 持久化失败会尝试从可信备份恢复。恢复或 transaction 清理无法安全完成时进入 `RECOVERY_REQUIRED`，保留诊断和备份，绝不静默声称成功。

#### 信任边界

网络边界从 loopback 开始：服务拒绝非回环监听，HTTP 用 token（query / Bearer / SameSite cookie）授权并校验浏览器 Origin，editor WebSocket 还需独立 capability token；文件边界由路径规范化和 dirfd / `O_NOFOLLOW` 绑定，版本边界由 fingerprint、revision、locator 与 transaction 校验。服务没有任意路径读写 API。外部 Agent 常用受控接口包括 session / status（`GET /api/session`）、tasks（列表 `GET /api/tasks`、详情 `GET /api/tasks/<TASK_ID>`、创建 `POST /api/tasks`）、actions（`POST /api/actions`）、undo / redo（`POST /api/groups/<GROUP_ID>/undo|redo`）、write-deck（`POST /api/write-deck`）和 observer events（`GET /events` 升级 WebSocket）；Agent 调度另有固定 schema 的 `POST /api/agent-runs`、`GET /api/agent-runs/current`、`GET /api/agent-providers`、`GET /api/agent-sessions`、`POST /api/agent-sessions/inspect`、`POST /api/agent-projects/pick`、`POST /api/agent-sessions` 与 `GET/PUT /api/agent-connection`。唯一 editor capability 只为 frame 事务命令与 ACK 服务。

目标 locator 找不到返回 `TARGET_NOT_FOUND`，不能唯一匹配返回 `TARGET_AMBIGUOUS`；frame 未就绪返回 `EDITOR_OFFLINE`。所有错误都保留稳定 code 与恢复提示，浏览器 tentative 状态和 durable session 不会分叉。

### 4.7 文档架构与一致性维护

`SKILL.md` 是唯一入口：description 负责触发，正文给 5 步 + 9 铁律，**每条铁律指向一个 reference**。references 分工不重叠：

| 层 | 文件 | 管什么 |
|---|---|---|
| 流程 | workflow.md | 七阶段 + 场景适配 + 常见错误表 |
| 选型 | template-pages.md | 三套模板逐页索引（共用页型只在授课节写全，变体指回，避免三处维护） |
| 视觉 | design-system.md / huawei-style.md | 本模板硬规 / 官方风格参照（冲突以前者为准） |
| 制作 | animation.md / page-snippets.md / artwork.md | 动画机制 / 可粘贴骨架 / 配图工作流 |
| 工程 | editing-guide.md / branding.md | bundle 结构与 edit-bundle / 品牌替换 |

**改动时的同步清单**（来自 CLAUDE.md）：

- 改脚本行为 / 命令用法 → 同步 `SKILL.md`、`README.md` 与相关 reference；
- 改模板页数（34/36/41）→ 同步 SKILL.md、README、template-pages.md、workflow.md 中的全部提法；
- 改动画引擎规则 → deck 运行时与 `steps.mjs` 双侧同步；
- 改 edit-bundle 编码/记账逻辑 → 保持 §4.2 四条不变量，并同步 editing-guide.md。

---

## 5. 关键不变量速查

| # | 不变量 | 破坏后果 |
|---|---|---|
| 1 | template 编码只走 `dump_template()`（只转义 `</`，回填断言往返相等） | `</script>` 提前闭合，整个文件打不开 |
| 2 | 增删移页三处同步（DOM / nav[] / chapters[].start），nav `i:` 连续 | 导航乱、某页掉出章节；`eb.verify` assert 失败 |
| 3 | `data-idx` 必须是数字 | 整页灰屏 / 加载死循环 |
| 4 | `data-label` 全 deck 唯一 | 全部工具只认第一个同名页，编辑与验证错位 |
| 5 | 动画引擎规则运行时与 steps.mjs 双份一致；总拍数 = max(data-step)+2 | 逐拍验证与真实放映不符 |
| 6 | 每页内容 ≤1080 高（section overflow:hidden） | 无声裁切，讲到才发现 |
| 7 | 中文字体必含 Noto Sans SC；正文散文 ≥21px | 中文回退细体 / 投影看不清 |
| 8 | 不删内联 React / 字体（误删用 `eb.inline_react` 修复） | 断网环境整页起不来 |
| 9 | 退出码契约 0/1/2 全脚本一致 | CI / 上层判断失灵 |
| 10 | manifest 条目与 template 引用一一对应（嵌图走 embed_image，换图走 apply_bg） | manifest 残留无引用的数据白占体积，或 template 引用了不存在的条目导致图片加载失败 |
