---
name: huawei-deck
description: Use when creating a new Huawei-red-brand 1920×1080 single-file HTML slide deck — for lectures/training（授课培训）, business reporting（汇报/述职/方案评审）, or self-study learning materials（学习材料）— from the bundled template（华为红品牌网页 PPT 模板：34 页页型画廊含 10 页真实课件示例、点击/方向键放映、离线单文件、刷新续播）, editing pages/animations/branding of such a deck, or converting it to PPTX via the bundled html2pptx (multi-tab pages auto-expand).
---

# huawei-deck — 华为红品牌单文件 HTML 演示模板

## 这是什么

一套**单文件 HTML 演示模板**（1920×1080，华为红品牌设计系统）：React / 字体 / 图片全部内联，拷走一个文件即真离线可用。打开默认滚动模式浏览，左上角侧边预览 glass 胶囊持续显示实时 `x/yy` 页码，右侧 6px 细滑块仅在滚动时显现、停止 800ms 后自动淡出；`Ctrl/Cmd + 滚轮` 或 `Ctrl/Cmd + +/-` 缩放幻灯片内容（刷新保留倍率）。非 100% 时顶部 glass bar 展开四角百分比复位控件；**仅放大到 110% 及以上时**再展开小手按钮，可锁定点击 / 拖动模式，按住空格则临时抓手，松开即恢复。**点右上角显示器图标进入放映模式**（自动全屏）——点击空白、空格、方向键或上下滚轮逐拍推进 / 回退，当前页拍完才翻页；滚轮按手势防抖，触控板惯性不会连续跳页。刷新自动回到上次页，粘贴 bilibili 视频链接可直接弹内嵌播放器。`assets/template-deck.html` 是 34 页**页型画廊**：24 页页型每页既是可复制的版式，占位文案本身又在讲解「这一栏该怎么写」——画廊即文档；另有「05 · 完整示例」章 10 页取自真实课件，展示版式填入真内容后的成品。

## 从零做一份 PPT？先走流程

用户要**从零做一份新 PPT** 时——授课、汇报、学习材料都算——不要直接开搭页：先走 `references/workflow.md` 的七阶段协作流程（主题讨论 → 大纲规划 → 选择模板 → 初版制定 → 讨论修改 → 终版制作 → 讨论修改），其中三个「讨论」阶段是硬闸门；流程开头的**场景适配表**定授课 / 汇报 / 自读的基调差异（骨架、页数、页型、动画量）。下面的 5 步是该流程中「初版 / 终版制作」阶段的机械操作。新建 deck 或批量重构仍由 Agent 经 `scripts/edit-bundle.py` 完成；结构稳定后的后期精细调整可启动可视化编辑器，详见 `references/editing-guide.md` 的「后期可视化微调」章节。

## 快速上手（5 步）

1. **按场景复制模板**（所有命令都在本 skill 根目录执行）：授课 `cp assets/template-deck.html my-deck.html`；技术分享用 `assets/tech-share-deck.html`；汇报 / 述职用 `assets/work-report-deck.html`（三套差异与逐页索引见 `references/template-pages.md`）
2. **挑页改占位**：浏览器滚一遍 deck，对照 `references/template-pages.md`（三套模板逐页索引）选中要用的页型，替换占位文案（改法见 `references/editing-guide.md` 第 3.2 节）；品牌图 / 口号 / 品牌色替换见 `references/branding.md`。
3. **增删复制页**：用 `scripts/edit-bundle.py` 的 `insert_page` / `delete_page` / `move_page`——slide DOM、导航数组、章节起点**三处同步全自动**；从零拼页参考 `references/page-snippets.md`。
4. **每改一批就验证**（verify 三件套，退出码 0 = 过）：

   ```bash
   node scripts/verify/measure_overflow.mjs my-deck.html --all      # 溢出检测
   node scripts/verify/shot.mjs my-deck.html <页label> /tmp/p.jpg    # 单页截图目检
   node scripts/verify/steps.mjs my-deck.html <页label> /tmp/steps   # 动画逐拍核对
   ```

5. **用户明确要求 PPTX 时才导出**：`bash scripts/html2pptx/convert.sh my-deck.html`——逐页截图组装 PPTX，layer 多标签页自动逐标签展开；后续只改 HTML 时不自动重导，除非用户再次要求。

## 旧 Deck 升级

本次会话加载 skill 后，首次接触一个已有 deck 目录时，对目录内目标 deck 各无感运行一次 `python3 scripts/upgrade_deck.py old-deck.html --yes`；不要等用户提醒，也不要先询问。同一会话、同一目录、同一批文件后续编辑不得重复检查。仅在 skill 更新后首次加载、切换目录、出现新 deck、文件被外部替换，或用户明确要求时重新检查。脚本把页面 / 导航 / 章节 / 用户扩展与公共外壳分离，通过 hash 对照同类型最新模板；带 hash 的 Deck 用当前 seam 重组，历史 Deck 则从 Git 历史寻找最接近的同类模板并做三方合并，避免覆盖页面 profile、品牌元素和课程专属外壳逻辑。升级器不逐项维护功能迁移。有变更时生成 `.before-upgrade.html` 备份，保留用户内容并合并 manifest。完成后告诉用户是否升级、目标版本和备份路径。核心结构无法可靠识别或三方合并冲突时安全停止。加 `--audit` 输出逐页视觉复核清单；完整用法见 `references/editing-guide.md` 第 7 节。

## 后期可视化微调

这条路径只处理结构已稳定 deck 的收尾调整。macOS 用户可直接双击 skill 根目录的 `Huawei Deck 编辑器.app`，应用会先打开本地网页导入页；只有用户在网页点击“添加 Deck HTML”后，才会打开系统文件选择器以选择已有 deck HTML。每次应用启动只允许成功添加一份 deck HTML；添加后锁定该文件，不提供切换或再次添加入口；取消选择可以重试。首次桌面启动会按锁定版本自动补齐 `ws`、`html2canvas`、`busboy`，但仍要求机器已安装 Node.js ≥18 与 Python 3。

命令式入口完整保留：`python3 scripts/deck-editor.py <deck.html>`。它适合 Skill / Agent 在第一版 deck 生成并通过结构与溢出验证后直接带入文件，也适合 Windows / Linux：

```bash
python3 scripts/check_deps.py
python3 scripts/deck-editor.py <deck.html>
# 真实项目示例
python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
```

在 macOS 上，Skill 完成第一版后应直接打开桌面应用并带入新 deck，让用户继续微调：

```bash
open -n "Huawei Deck 编辑器.app" --args --agent-thread-id "$CODEX_THREAD_ID" "$(pwd)/my-deck.html"
```

带 deck 路径的 Python 入口会自动读取当前 `CODEX_THREAD_ID`；显式 App 命令则按上例传入。任务绑定会写入该 Deck 的 sidecar，因此用户误关后直接双击 App、重新添加同一份 Deck，也会自动恢复原任务。右上角 Agent 状态始终可见：已绑定为绿色“<provider> 在线”，未绑定为红色“Agent 离线”。点击状态会原位展开连接面板：Codex、Claude Code、OpenCode、OpenClaw 各自独立成页，每页按项目目录分组；项目标题使用独立底色，会话向内缩进并显示引导线。可以选择已有会话，也可以通过系统目录选择器添加 / 新建项目，并在目标项目中立即创建会话；未安装的 provider 单独标注，不影响其他列表，底部仍保留 provider + 会话 ID 的手动输入兜底。选择会话时只读检测 `$huawei-deck`、`SKILL.md` 等明确历史证据，显示“Skill 已加载 / 检测到 / 未检测到 / 选择时检测”，不会为了检查而唤醒或修改会话。

已有绑定且 Skill 状态已确认时，“交给 Agent”按 provider 续用同一会话并复用制作上下文，不会重复读取本 skill；Codex 使用 `codex exec resume`，其余 provider 使用各自非交互续会话入口。用户在连接面板显式新建会话时，会立即在目标项目目录启动一次只读初始化：读取一遍 `SKILL.md`、建立 Deck 编辑上下文，但不处理任务、不修改 deck；已选旧会话中未检测到 / 无法确认 Skill 时，则在首次真正处理任务时补读一次。成功后状态持久化为已加载；后续批次只续会话并按需读取相关 reference。

桌面模式在编辑器浏览器页关闭 10 秒后自动回收本地服务；命令式入口仍由调用者用 `Ctrl+C` 结束。

工作台只有预览、编辑、区域标记三种一级模式：编辑模式统一承担文字、移动和缩放，双击文字进入修改，拖动元素本体移动，拖动右下控制点缩放，不再要求先切换工具；单击 / 双击产生的小幅抖动不会误提交移动。区域拉框后在旁侧输入修改说明，任务会跨页累积到 Agent 任务 drawer；待处理、失败和待确认任务可二次编辑或确认删除，Agent 批处理期间锁定，已完成任务需先撤销。删除同步清理该任务的局部截图与附件。文字按鼠标落点命中：支持无 class 文字块及嵌套 `span` / `strong`，混排段落通过 `textPath` 只修改具体文本节点并保留加粗、链接与 `<br>`；双击只放置光标，不自动全选，点击别处或按 `Cmd/Ctrl+Enter` 提交。移动命中不依赖 class，并把普通内联文字提升到最近的独立布局盒。图片内文字、SVG 与交互组件继续走区域标记，避免破坏结构。外部 Codex / Claude Code / OpenCode / OpenClaw 不是内置聊天机器人。点击“交给 Agent”会把点击瞬间仍未完成的任务 ID 与 revision 一次提交给服务端 `AgentRunCoordinator`；按钮之后新增的标注留到下一批。运行状态经 observer WebSocket 实时回显；Agent 仍只通过受控 CLI / HTTP 调用 `GET /api/session`、`GET /api/tasks`、`PATCH|DELETE /api/tasks/<TASK_ID>`、`POST /api/actions`、`POST /api/groups/<GROUP_ID>/undo|redo` 和用户确认后的 `POST /api/write-deck`。observer WebSocket 使用 `/events`，仅订阅服务事件；唯一 editor capability WebSocket 只在 parent 与服务之间传递 frame 事务命令和 ACK，不对外提交动作。

顶栏的“撤销 / 重做”按时间顺序操作同一份权威历史，覆盖人工文字、移动、缩放和 Agent 动作组；`Cmd/Ctrl+Z` 撤销，`Cmd/Ctrl+Shift+Z` 重做，Windows 也可用 `Ctrl+Y`。焦点位于文字或其他输入框时快捷键保留原生输入撤销，不触发 Deck 全局历史。任务行仍保留定点撤销，定点撤销后也可从顶栏重做。区域任务可选择文件（支持多选和连续追加）或粘贴图片，粘贴图片会转为 PNG；每个任务最多 8 个附件，单个文件最大 25 MiB。浏览器无法取得原文件绝对路径，服务会把副本复制到 sidecar 会话的 `attachments/`。只有任务 payload 的序列化出口会派生路径：`GET /api/tasks`、`GET /api/tasks/<TASK_ID>`、`POST /api/tasks` 响应中的 `task`、`task-created` / `task-updated` 等事件或动作响应中的 `task`，以及 CLI `tasks` / `task`；这些出口返回副本绝对 path，供外部 Agent 读取。`GET /api/session` 与磁盘 `session.json` 只含 sidecar 相对 `relativePath`，不保存、也不返回附件绝对路径。附件不进入最终 deck，并随 sidecar 生命周期管理，也不属于 Deck 动作的撤销 / 重做范围。

预览、区域标记和自动会话保存不触碰原始 source deck。会话自动保存在 deck 同目录的 `.huawei-deck-editor/`，包含会话、任务、快照、动作、诊断与备份；它不进入最终交付 deck，且已由 `.gitignore` 忽略提交。正式写回必须由用户明确触发：三重闸门依次确认 editor online、文件指纹未变、无新增溢出，并在候选文件上通过 bundle verify。`scripts/edit-bundle.py` 仅在系统临时工作副本执行 `load`、`get_template`、`set_template`、`save`、`eb.verify`；bundle adapter / writer 负责 sidecar 备份、同目录候选、transaction、fingerprint 复核、`os.replace` 与失败恢复。冲突或验证失败一律拒绝覆盖，不会静默改写源文件。

第一版不增删页、不调整页序、不重构复杂动画、不内置聊天。所有 Agent 动作都要经过 token、revision、locator 与事务校验。session 可在关闭后重开；若出现 `RECOVERY_REQUIRED`，未决恢复状态会阻断继续写回，外部文件变化则应重载，或另存副本后再继续。

写回后仍按完整工具链验证：`python3 scripts/edit-bundle.py <deck.html>`（等价调用 `eb.verify`）、`node scripts/verify/measure_overflow.mjs <deck.html> --all`、改动页 `shot.mjs`；只有修改了动画页才需要运行 `steps.mjs`。`shot.mjs` 与动画页的 `steps.mjs` 均按 1920×1080 逻辑画布截图；无动画页运行 `steps.mjs` 只打印“此页无动画”并退出 0，不生成逐拍截图。详细操作、错误恢复和外部 Agent 命令见 `references/editing-guide.md`，组件与信任边界见 `docs/architecture.md`。

## 设计铁律（细则见对应 reference）

1. **中文绝不只挂 JetBrains Mono**（无中文字形会回退成细体）——中文一律 Noto Sans SC → `references/design-system.md`
2. **给听众读的散文最小 21px**，图表 / 表格内文字豁免（判别法：带 line-height 的是散文）→ `references/design-system.md`
3. **去花花绿绿**：只用 品牌红 + 灰蓝 + 中性灰 三色体系，红只给真警示 / 重点 → `references/design-system.md`
4. **动画只靠讲者手动推进，绝不自动循环**；页面上**绝不写「点击查看」「点击切换」类操作提示**——操作逻辑是讲者的事，页面只放内容 → `references/animation.md`
5. **改 template 必须经 edit-bundle.py**（转义有铁律），绝不用编辑器直改文件 → `references/editing-guide.md`
6. **每页内容必须塞进 1080 高**（超出被无声裁切），改完必跑 measure_overflow → `references/design-system.md` 第 7 节
7. **从零起新 deck 先对齐再动手**：主题与大纲没经用户确认前不碰模板 → `references/workflow.md`
8. **字不如表，表不如图**：方法论 / 原理 / 流程页用图表做主表达——初版放类型化占位块，终版抽原图 / 自绘 / 制表落地、`data-todo` 归零 → `references/artwork.md`
9. **文字朴实专业、标题即观点且点名技术**：不写套话与广告词，也不自造比喻式修辞（「整树换血」「优雅落地」一类读者对不上具体所指的词）——讲流程与机制一律直接写「动作 + 技术名称」；正文页标题必须承载这页的核心技术观点并写出最关键的技术名词（「基于 X 实现 Y」句式），栏目式 / 悬念式 / 有判断无技术名词的标题都是反模式 → `references/workflow.md`
10. **表格统一用标准样式**：品牌红表头 + 白色居中粗体、全黑边框、分组范围 3px 黑色粗外框、正文 15px 黑字；列宽直接写到 `th` / `td`，默认按 `15% / 19% / 66%` 分配，优先单行但空间不足时自然换行，表格用 `flex:1;min-height:0` 吃满可用高度 → `references/artwork.md` 第 4 节
11. **卡片只用统一白卡体系**：大卡片统一白底 + 浅灰细边 + 14px 圆角；卡片标题无色块底，只用黑色或品牌红文字；删除不承载业务信息的胶囊、角标和版式说明标签 → `references/design-system.md` 第 5～6 节
12. **异构架构必须展开差异单元**：当不同层 / Block / 模块的执行路径不同，不能只画抽象层列表；必须依据项目源码或正式规格展开代表单元，标清输入输出、状态、缓存、分支与选择策略 → `references/artwork.md` 第 3 节
13. **自绘图按工程图验收**：红色只标真正关键节点，不画无意义红框；所有 SVG / HTML 图逐项检查文字不越框、箭头方向正确、线条接在框边而非穿框或悬空，普通 overflow 检测不能替代截图目检 → `references/artwork.md` 第 5 节
14. **导航 / 缩放 / 放映运行时三模板一致**：左上侧边预览统一为 `图标 + x/yy`；放大后统一支持空格临时抓手、glass 小手锁定；放映态普通滚轮统一复用方向键节拍且按手势防抖。修改公共运行时只需同步三套模板并更新版本标记；外壳 hash 会自动触发旧 Deck 重组。只有用户内容 seam 或 bundle 格式变化时才改升级器 → `references/animation.md`

## 文件导航

| 文件 | 用途 |
|---|---|
| `assets/template-deck.html` | 34 页授课模板 deck（复制后再改） |
| `assets/tech-share-deck.html` | 36 页技术分享模板（深色 KV 封面 / 选型 / 原理 / 性能 / 对比 / 演进 / 精读 / 跟读 / 踩坑 / Takeaway） |
| `assets/work-report-deck.html` | 41 页工作汇报模板（TL;DR / KPI / 数据墙 / 案例 / 批示纪要 / 彩色横区架构 / 勾叉盘点 / 状态热力表 / 甘特 / 风险） |
| `references/workflow.md` | 从零做 PPT 的七阶段协作流程（何时问什么、每阶段产出与闸门） |
| `references/template-pages.md` | 三套模板逐页索引：怎么选模板 + 每页长什么样 / 常用于 / 怎么改 / 动画拍数 |
| `references/design-system.md` | 颜色、字体、字号刻度、排版结构、审美硬要求 |
| `references/animation.md` | build / layer / SMIL 三机制写法、节拍设计与验证 |
| `references/page-snippets.md` | 可直接粘贴的页面骨架与构件（每段注明模板活例） |
| `references/editing-guide.md` | 后期可视化微调入口、独立版结构、edit-bundle 用法、错误恢复、验证与 PPTX 导出 |
| `references/artwork.md` | 配图工作流：初版类型化占位 → 终版 PDF 抽原图（PyMuPDF）/ 自绘流程架构图 / 表格 |
| `references/branding.md` | 品牌替换：背景画 / 黑板 / 人像 / logo / 口号 / 品牌色 |
| `references/huawei-style.md` | 华为官方胶片风格分析：两套配色公式、页型清单、标题句式、数字用法、高复用组件 |
| `assets/huawei-refs/` | 官方 PPT 提取素材库：封面 KV / logo / 图标 / 装饰组件 + 官方空白模板 pptx（内附 README 索引） |
| `scripts/edit-bundle.py` | 安全编辑工具函数库（load / get·set_template / insert·delete·move_page / embed_image / verify） |
| `Huawei Deck 编辑器.app` | macOS 双击入口；先开网页并单次添加旧 deck，或接收 Skill 传入的 HTML |
| `scripts/deck-editor.py` | 桌面与命令式入口共用的启动模块（默认只监听 127.0.0.1，并自动打开浏览器工作台） |
| `scripts/editor/` | 一次性网页导入、浏览器 parent/frame、外部 Agent 桥、sidecar、动作日志与安全写回实现 |
| `scripts/apply_bg.py` | 品牌图一键替换（默认预览模式，`--yes` 落盘） |
| `scripts/upgrade_deck.py` | 公共外壳 hash 对比、历史模板三方合并、最新模板重组、manifest 合并、自动备份与视觉审计 |
| `scripts/test_upgrade_deck.py` | 升级器的 profile、品牌元素、历史模板与最新版运行时回归测试 |
| `scripts/verify/*.mjs` | verify 三件套（measure_overflow / shot / steps） |
| `scripts/html2pptx/convert.sh` | HTML → PPTX 一键转换 |
| `scripts/react*.umd.js` | 离线 React 备件（模板已内联，仅修复用） |

## 编辑独立版的最小代码块

deck 的 HTML 藏在一行 JSON 字符串里，必须经 edit-bundle 读写（直改文件必坏）：

```python
import importlib.util
spec = importlib.util.spec_from_file_location('eb', 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)

lines = eb.load('my-deck.html')
s = eb.get_template(lines)          # 解码出整份 deck HTML 字符串
s = s.replace('旧文案', '新文案')     # …字符串手术（先切片到目标 section，见 editing-guide）
eb.set_template(lines, s)           # 回填（自动做转义与断言）
eb.save('my-deck.html', lines)
eb.verify('my-deck.html')           # 页数 / 导航 / 章节一致性检查
```

## 性能与依赖

- **一键体检**：动手前先跑 `python3 scripts/check_deps.py`——检查以下全部依赖（含外部依赖 skill `pdf`），缺失项能自动装的（pip / npx / npm）会先打印命令再装，装不了的（Node / Chrome / soffice）给安装提示。加 `--check-only` 只报告不改环境。退出码：0 就绪 / 1 仍缺 / 2 工具或参数错误。
- 预期性能：模板 12MB，headless Chrome 首开约 2.6s；PPTX 导出 34 页 → 55 张、约 47s。
- 依赖：本机 Google Chrome + playwright-core（三级查找：`PLAYWRIGHT_CORE` 环境变量 → 根目录 `npm i playwright-core` → openclaw 内置路径）；PPTX 导出另需 `python3 -m pip install python-pptx`。
- 解析外部参考材料（用户给的 pptx / pdf 素材 → 逐页图目检、提取封面与配图）：pptx 先 `soffice --headless --convert-to pdf` 再用 PyMuPDF（`pip install pymupdf`）渲染逐页图；pptx 内嵌媒体用 `zipfile` 解包 `ppt/media/`；PDF 的合并 / 拆分 / 表格与表单处理按 `.agents/skills/pdf/` 的方法执行（pypdf / pdfplumber）。
