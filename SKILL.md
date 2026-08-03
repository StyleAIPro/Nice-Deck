---
name: huawei-deck
description: Use when creating a new Huawei-red-brand 1920×1080 single-file HTML slide deck — for lectures/training（授课培训）, business reporting（汇报/述职/方案评审）, or self-study learning materials（学习材料）— from the bundled template（华为红品牌网页 PPT 模板：34 页页型画廊含 10 页真实课件示例、点击/方向键放映、离线单文件、刷新续播）, editing pages/animations/branding of such a deck, or converting it to PPTX via the bundled html2pptx (multi-tab pages auto-expand).
---

# huawei-deck — 华为红品牌单文件 HTML 演示模板

## 这是什么

一套**单文件 HTML 演示模板**（1920×1080，华为红品牌设计系统）：React / 字体 / 图片全部内联，拷走一个文件即真离线可用。打开默认滚动模式浏览，**点右上角玻璃工具条的显示器图标进入放映模式**（自动全屏）——点击空白、空格或方向键逐拍推进动画（`←` 回退），刷新自动回到上次页，粘贴 bilibili 视频链接可直接弹内嵌播放器。`assets/template-deck.html` 是 34 页**页型画廊**：24 页页型每页既是可复制的版式，占位文案本身又在讲解「这一栏该怎么写」——画廊即文档；另有「05 · 完整示例」章 10 页取自真实课件，展示版式填入真内容后的成品。

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

5. **需要 PPT 交付时**：`bash scripts/html2pptx/convert.sh my-deck.html`——逐页截图组装 PPTX，layer 多标签页自动逐标签展开。

## 后期可视化微调

这条路径只处理结构已稳定 deck 的收尾调整。先跑依赖体检，再启动浏览器工作台：

```bash
python3 scripts/check_deps.py
python3 scripts/deck-editor.py <deck.html>
# 真实项目示例
python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
```

在工作台里可用预览、区域标记、文字、移动、缩放五种模式：区域拉框后在旁侧输入修改说明，任务会跨页累积到 Agent 任务 drawer；简单内容可直接改文字、移动、缩放。外部 Codex / Claude Code / Agent 不是内置聊天机器人，只通过 CLI / HTTP 调用受控接口：`GET /api/session` 读取 status，`GET /api/tasks` 读取任务，`POST /api/actions` 提交动作，`POST /api/groups/<GROUP_ID>/undo` 与 `POST /api/groups/<GROUP_ID>/redo` 执行 undo / redo，`POST /api/write-deck` 正式写回。observer WebSocket 使用 `/events`，仅订阅服务事件；唯一 editor capability WebSocket 只在 parent 与服务之间传递 frame 事务命令和 ACK，不对外提交动作。drawer 只记录任务并给出外部 CLI 提示。

顶栏的“撤销 / 重做”按时间顺序操作同一份权威历史，覆盖人工文字、移动、缩放和 Agent 动作组；任务行仍保留定点撤销，定点撤销后也可从顶栏重做。区域任务可选择文件（支持多选和连续追加）或粘贴图片，粘贴图片会转为 PNG；每个任务最多 8 个附件，单个文件最大 25 MiB。浏览器无法取得原文件绝对路径，服务会把副本复制到 sidecar 会话的 `attachments/`；API / CLI 返回副本绝对 path，供外部 Agent 读取。附件不进入最终 deck，并随 sidecar 生命周期管理，也不属于 Deck 动作的撤销 / 重做范围。

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
| `scripts/deck-editor.py` | 后期可视化微调启动器（默认只监听 127.0.0.1，并自动打开浏览器工作台） |
| `scripts/editor/` | 浏览器 parent/frame、外部 Agent 桥、sidecar、动作日志与安全写回实现 |
| `scripts/apply_bg.py` | 品牌图一键替换（默认预览模式，`--yes` 落盘） |
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
