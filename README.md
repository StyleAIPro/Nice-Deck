# huawei-deck

华为红品牌 **单文件 HTML 演示（网页 PPT）Agent Skill + 可选桌面 Editor**。一套 1920×1080、离线可拷走的幻灯片系统：三套场景模板、点击 / 方向键放映、刷新续播，并可按需转成 PPTX。

Skill 让 Codex、Claude Code 等 Agent 掌握 Huawei Deck 的工作流；Editor 提供新建、预览、区域任务、直接编辑、撤销和安全固化。没有 Editor 窗口时，Skill 仍可独立创建和修改 Deck。

## 效果预览

![deck 交互演示：液态玻璃工具条 · 侧边预览 · 记笔记 · 放映/滚动切换](docs/showcase/deck-demo.gif)

> 本地 Chrome 实录一份用本 skill 做出的答辩 deck：顶部液态玻璃工具条随讲切章，左上 `图标 + x/yy` glass 胶囊显示实时页码并展开侧边预览缩略图跳页，左下角记笔记留评审批注，右上放映 / 滚动一键切换——放映翻到「03 · 研究过程」后切滚动，缓慢通览到致谢页。完整图文案例见 [`docs/showcase/showcase-1.md`](docs/showcase/showcase-1.md)。

## 能做什么

- 三套模板按场景起步但不物理合并：**授课**（34 页全量画廊）、**技术分享**（37 页，新增代码 + 曲线 + 指标证据页）、**工作汇报**（46 页，新增战略能力组合、系统交付侧栏、分层运维架构、双层方法管线和阶段责任交付页）。场景模板负责整套外壳，页级目录再加入经过兼容性审核的共享页型；`references/workflow.md` 有完整的七阶段协作流程与场景适配
- 保留整套设计系统：三色体系（品牌红 `#b5333b`）、Noto Sans SC + JetBrains Mono、统一字号刻度、品牌红表头 / 黑边分组标准表格、玻璃组件、放映 / 滚动双模式、独立内容缩放、放大后空格 / 小手抓取平移，以及三种手动推进动画机制（build / layer / SMIL）；目录、标签页和阶段视图等页内多画面统一使用固定 DOM 的 layer 协议
- 品牌可替换：换 logo / 金色背景画 / 口号 / 品牌色（`references/branding.md` + `scripts/apply_bg.py`）
- 配图有工作流：初版类型化占位标注，终版从素材 PDF 抽原图（PyMuPDF）、自绘流程 / 架构图、制表落地（`references/artwork.md`）
- 一体化 Deck 工作台：启动页提供“新建 Deck”和“修改 Deck（打开已有 Deck）”两个入口；新建流程由右侧真实 Agent PTY 协作确认需求与页面规划，合法 staging Deck 出现后立即复用 Editor Managed Workspace 实时制作、刷新、固化和发布（`references/editing-guide.md`）
- 后期可视化微调：区域拉框批注、跨页 Agent 任务、直接文字 / 移动 / 缩放 / 删除、统一动作日志与安全写回（`references/editing-guide.md`）
- 跨平台 `scripts/html2pptx/convert.py` 导出 PPTX，Editor 也可用画布工具栏图标下载当前工作副本；页内多标签（layer）自动逐标签展开成多页
- 统一白底圆角卡片体系：浅灰细边、标题无色块底、黑色 / 品牌红标题，删除无业务含义的装饰标签
- 按源码 / 配置展开异构模型与系统架构，自绘 SVG 同时校验文字边界、箭头方向和连线端点
- 旧 Deck 可原地升级：公共外壳 hash 对比、历史模板三方合并、自动备份和逐页视觉审计

## 安装

当前版本从完整仓库安装。跨平台安装器默认注册 Codex Skill，并检查、修复 Editor Core；不会因为缺少 LibreOffice 或 PPTX 导出工具而阻止基础启动。

macOS / Linux：

```bash
python3 scripts/install.py install
```

Windows PowerShell：

```powershell
py -3 scripts\install.py install
```

默认注册位置是 `~/.agents/skills/huawei-deck`。macOS/Linux 使用 symlink，Windows 使用不要求 Developer Mode 的目录 junction。已有目标不指向当前仓库时，安装器会停止并报告 `INSTALL_TARGET_OCCUPIED`，不会覆盖用户内容；已有同源链接但缺少安装记录时也不会静默接管，需在诊断页确认“接管此安装”，或显式运行 `scripts/install.py repair --adopt-existing`。

安装后新开 Agent 任务，再双击 `Huawei Deck 编辑器.app`（macOS）或 `Huawei Deck 编辑器.cmd`（Windows）。macOS `.app` 已内置应用图标；Windows 首次运行 `.cmd` 会在同目录生成带图标的 `Huawei Deck 编辑器（Windows）.lnk`，之后可直接使用该快捷方式。完整的检查、其他 Agent 兼容注册、修复与卸载说明见 [`INSTALL.md`](INSTALL.md)。

## 依赖

> **按任务体检**：使用 `--profile editor-core|verify|pptx-export|materials|full` 选择能力；`--check-only` 只报告，`--repair` 修复可自动安装项，`--json` 提供结构化结果。退出码 0 就绪 / 1 仍缺 / 2 工具或参数错误。

| Profile | 用途 | 主要依赖 |
|---|---|---|
| `editor-core` | 启动窗口化 Editor | Node ≥ 18、Editor Node 模块、一个 Agent CLI |
| `verify` | 截图、溢出、逐拍验证 | Chrome、playwright-core |
| `pptx-export` | HTML → PPTX | `verify` 能力、python-pptx |
| `materials` | 读取 PDF/PPTX 参考材料 | PDF Skill、PyMuPDF、LibreOffice 等 |

例如只准备 Editor：

```bash
python3 scripts/check_deps.py --profile editor-core --repair
```

playwright-core 加载顺序：`PLAYWRIGHT_CORE` 环境变量 → 裸 `import playwright-core` → 内置回退路径。缺依赖时脚本会打印可操作的中文提示。
>
> 解析外部参考材料指从 pptx/pdf 素材提取版式与图片（`assets/huawei-refs/` 即由此产出）：pptx 先经 `soffice --headless --convert-to pdf` 转 PDF，再用 PyMuPDF 渲染逐页图 / 抽内嵌图；pptx 内嵌媒体可直接用 Python `zipfile` 解包 `ppt/media/`。PDF 的进阶处理（合并 / 拆分 / 表格提取 / 表单）参考仓库内置的 pdf skill：`.agents/skills/pdf/`（`npx skills add https://github.com/anthropics/skills --skill pdf` 安装）。

## 目录

```
huawei-deck/
├── Huawei Deck 编辑器.app  # macOS 双击入口；网页内新建或打开已有 Deck
├── Huawei Deck 编辑器.cmd  # Windows 启动入口；首次运行生成带图标的本机 .lnk
├── INSTALL.md               # macOS / Windows 安装、修复与卸载
├── SKILL.md                 # skill 入口：5 步快速上手 + 铁律 + 文件导航
├── assets/
│   ├── training-deck.html   # ★34 页授课模板（离线单文件，~12MB）
│   ├── tech-share-deck.html # 37 页技术分享模板（含代码/曲线/指标证据页）
│   ├── work-report-deck.html# 46 页工作汇报模板（含五种复合高密度页型）
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
│   ├── deck-editor.py       # 新建 / 打开 / 后期微调共用启动器
│   ├── install.py           # 跨平台 Skill 安装、检查、修复与卸载
│   ├── check_deps.py        # 按能力 Profile 诊断和修复依赖
│   ├── editor/              # Draft、DeckFactory、真实 PTY、浏览器工作台与安全写回
│   ├── apply_bg.py          # 品牌图替换
│   ├── upgrade_deck.py      # 历史三方合并、公共外壳重组、manifest 合并与审计
│   ├── test_upgrade_deck.py # 升级器回归测试
│   ├── verify/              # measure_overflow / shot / steps —— 溢出检测·单页截图·放映逐拍
│   └── html2pptx/           # 跨平台 convert.py + POSIX convert.sh + 截图 / 组装工具
├── docs/user-guide/         # Editor 内置帮助中心的 Markdown 来源
└── docs/design/             # 设计规格与实现计划（本 skill 的构建记录，供参考）
```

## 模板 deck 页型（34 页 · 6 章）

01 门面（封面 / 目录 / 议程 / 章扉 / 问题页）· 02 内容版式（卡片网格 / 左图右文 / 对比两栏 / 流程条 / 密集多栏 / 表格混排 / 全幅大图 / 截图对照 / 动手实验）· 03 动画机制（build / layer / 混合链 / SMIL / 多组切换）· 04 深色与黑板（金句 / 两种黑板题卡）· 05 完整示例（10 页真实课件成品，即拿即改）· 06 收尾（研讨 / 结语）。

放映：打开默认滚动模式，左上侧边预览 glass 胶囊持续显示实时 `x/yy` 页码；点右上角显示器图标进入放映（自动全屏）。点击空白 / 空格 / → / 向下滚前进，← / 向上滚后退；一段连续滚轮手势只推进一次。`Ctrl/Cmd + 滚轮` 或 `Ctrl/Cmd + +/-` 只缩放内容；非 100% 时 glass bar 展开四角百分比，点击复位；仅放大到 110% 及以上时出现小手，点按可锁定拖动，按住空格可临时拖动。缩小时不显示小手，点击四角或小手后会释放焦点，不残留浏览器黑色焦点圈。

## 快速上手

浏览器工作台打开已有编辑历史后，首次撤销 / 重做快捷键即使早于权威会话加载完成，也会排队一次并在加载后立即执行，不要求先点击顶栏按钮。

见 `SKILL.md`。一句话：复制 `assets/training-deck.html` → 照 `references/template-pages.md` 挑页改占位 → 增删页用 `scripts/edit-bundle.py`（自动记账）→ 跑 `scripts/verify/` 验证 → 用 `scripts/html2pptx/convert.py` 出 PPTX。

## 从零新建与后期可视化微调

重复双击不会再打开第二个工作台页面；如果旧页面已经关闭，则先结束无页面的旧服务，再启动加载当前资源快照的新服务。

启动页背景使用品牌红白流体效果响应鼠标，同时保持工作卡和文字的原有视觉层级；背景层不接管点击，进入制作区或标签页隐藏时暂停，系统启用“减少动态效果”时降级为静态柔光。

任务状态“待确认”表示 Agent 匹配到多个可能修改目标，无法安全判断该改哪一个，并不对应一个确认按钮。任务行会直接显示“目标定位不唯一”的原因、间歇醒目提醒和“补充说明”入口；补充具体位置或对象并保存后，任务回到待处理，才可重新提交。系统启用减少动态效果时不播放提醒动画。

双击桌面入口后，启动页提供左右两张“新建 Deck / 修改 Deck”工作卡，其中“修改 Deck”就是原“打开已有 Deck”入口。桌面入口通过原子实例登记表保持单实例。macOS 会先按原 URL 或“Huawei Deck”标题定位并激活已有 Chrome / Safari 标签页；Windows 则查询 App Server 的鉴权页面租约，有活动页面时只尽力激活 Chrome / Edge / Firefox，激活失败也不会打开第二个标签页。若页面租约已经关闭，则先结束仍处于重连宽限期的旧 App Server，再启动一套加载当前固定资源快照的新服务，不会让两套服务同时争抢 Deck 锁。loopback 存活探测明确绕过系统 HTTP 代理，避免把健康实例误判为失效后与同一 Deck 争锁。每张卡以“继续任务”为主，分别恢复 Creation Draft 或 Deck 工作副本、里程碑、修改记录和任务专属 Agent 会话；右下角小加号才进入新建 Draft 或添加 HTML。Creation Draft 以 `projectRoot + draftId` 唯一定位，同一项目目录可以并行保存多份 Deck 过程文件而不会串灯或串上下文。Draft 锁带进程租约；页面关闭后服务会在短暂重连宽限期结束时回收，崩溃遗留的陈旧锁不会永久显示为“另一窗口正在使用”。新建流程先选择 Agent 项目目录，再进入左侧四个只读里程碑与右侧真实 PTY 的对话工作区；里程碑不是导航，页面不提供阶段按钮、中间表单、章节卡片或页面卡片。需求、大纲和逐页规划由 Agent 通过受控 creation CLI 写入 Draft 与对应里程碑文件，终端自然语言输出不会被解析成进度；Deck 合法落盘后中间画布才自动展开。浏览器与 Agent 共用同一 Draft revision，用户确认前不会跨过闸门。生成阶段先创建 Draft 专属 staging 副本，再立刻启动与修改页相同的 Managed Workspace：Agent 经 `scripts/edit-bundle.py` 修改托管工作副本，或经 Editor CLI action 修改已有元素，画布随安全保存自动刷新。完成初版时服务先固化统一历史，再执行 bundle verify、全页溢出检查和不覆盖发布；发布后立即为最终 Deck 建立标准 Managed Workspace，并让创建页中间画布无缝改为嵌入这个运行时。此后“进入微调编辑器”只切换页面外壳，不创建新工作区，也不改变预览、监听、撤销和固化机制。交接同时在最终 Deck 的 Editor session 中持久化 `creation-context.json`，把已确认的需求、大纲、页面规划、设计文稿与原 Draft 素材目录作为后期微调的正式上下文；同一会话直接收到新的 Editor CLI 地址，新会话或重开任务也会先恢复这份上下文。

启动页和独立 Editor 页面都会向 App Server 建立持续 WebSocket 页面租约。正常关页仍用 `pagehide` beacon 主动退租；浏览器崩溃、被任务管理器强制结束或 beacon 丢失时，操作系统关闭连接，App Server 在 5 秒重连宽限期后统一回收 Editor、Agent PTY、helper、HTTP 与 WebSocket。页面完成 HTTP 登记后若 15 秒内没有建立持续租约，也按启动中崩溃处理。工作台与 Editor 跳转时沿用同一 `clientId + sequence`，新页面在宽限期内接管，不会把正常导航误判为孤儿。

启动页的工作项名称与 HTML 文件名相互独立：新建 Deck 可在创建页左上角改名，已有 Deck 可在启动卡片或工作区切换器中改名，改名只整理工作项，不修改磁盘文件。若 Finder 或资源管理器在 Editor 内外给源 HTML 改名，系统使用稳定 `deckId` 与平台文件见证恢复同一个工作项和原 Session；可以唯一确认时自动跟随新路径，无法确认、文件缺失或同名候选冲突时持续显示“需要重新绑定”，保留工作副本、撤销历史、任务和 Agent 上下文，但禁止固化。用户通过系统文件选择器选回原物理文件后原地继续，不创建第二个任务。若固化已经原子发布、但 Work Catalog 的新见证写回遗漏，活动 Editor 会先重新检查物理文件再补写；重启后也只有同一 `deckId`、当前源文件指纹与最近成功固化检查点完全一致时才自动恢复，任何外部版本仍保持冲突。固化发布不再写启动时缓存的旧路径：POSIX 使用原子文件条目交换，Windows 使用 `ReplaceFileW`，改名恰好与固化竞争时只会安全成功或明确拒绝，不会重新创建旧文件名。

Draft 位于 `<项目目录>/.huawei-deck-editor/drafts/<draft-id>/`，刷新页面会恢复当前 revision 与步骤。Agent capability 只绑定当前 Draft；终端自然语言输出不会被解析成结构化状态。内置模板与最终输出路径都不能被生成流程隐式覆盖。Skill 只有一份质量契约，创建、续作、修改、区域任务和直接调用全部原样加载，不按入口维护或降级成不同规范；两条入口只表示当前是否已有合法 Deck。模板目录从 bundle 自动展开全部 34 / 37 / 46 页，并为每个实际页面提供稳定语义 ID、视觉家族、密度和节奏角色。页面规划使用所选场景外壳的 `availablePageTypes`：既含原生页，也含 `compatibleWith` 明确允许的共享页；共享页必须通过 `deck_factory.py import-page` 导入。规划必须保留第一张封面、第二张目录和最后一张感谢页，并为每个内容页填写排版理由与配图 / 证据方案；连续三页同一视觉家族会被拒绝。生成开始时会把已确认规划写成独立 `page-plan-contract.json`；发布前逐页核对最终 Deck 的页数、顺序、页型、来源模板、页面 / 章节身份和 label，任何不一致都停止发布并保留 staging。封面和感谢页同时验证原始结构；目录由已确认大纲生成独立 `toc-contract.json`，发布前强制核对实际章数、章名、章节目标与逐章动画，不能继承模板示例动画。

结构、大纲和页序已经稳定后，可以在浏览器工作台做最后一轮细节修改。批量替换或结构性重构仍由 Agent 经 `scripts/edit-bundle.py` 完成；可视化编辑器专注于那些“手改一下更快”的收尾动作。

macOS 上直接双击根目录中已带应用图标的 `Huawei Deck 编辑器.app`；Windows 首次双击 `Huawei Deck 编辑器.cmd` 会在同目录生成带图标的 `Huawei Deck 编辑器（Windows）.lnk`，之后可直接双击该快捷方式。两者启动同一套工作台；Windows 也可以把一份 deck HTML 拖到 `.cmd` 或快捷方式上直接打开。`.lnk` 只保存当前机器的绝对路径，因此不会进入 Git；移动仓库后删除旧快捷方式并再次运行 `.cmd` 即可重建。Windows `.cmd` 只负责启动一个隐藏的标准 Python 后台进程，随后立即退出，不会把 Python/控制台图标长期留在任务栏。打开已有 Deck 使用系统文件选择器添加一份 HTML；Agent 项目目录与区域任务附件也直接调用 macOS / Windows 的系统原生选择器，不在页面内复刻文件管理器。在进入编辑器前可返回首页废弃当前候选并重新选择，取消选择器后也可直接重试。新建 Deck 的项目目录同样可反复更改或返回首页，确认后才创建持久 Draft 并自动启动 Agent 终端。首次启动若只缺项目 Node 模块，会按 `package-lock.json` 自动安装；Node.js ≥18 与 Python 3 仍需预先安装。

Windows 的 Agent 终端会把可信目录 identity 与进程 cwd 分开处理：普通 `C:` / `D:` 本地目录直接启动，映射网络盘或 Parallels 共享盘保留用户当前的任意盘符，不把 `\\server\share` UNC realpath 直接交给 CMD。若项目只有 UNC 路径且没有可验证的盘符映射，启动会明确拒绝并提示先映射盘符，避免 Agent 静默退回 `C:\Windows`。sidecar 的受控读写在 Windows 内部使用 extended-length path，因此 Draft staging 与工作副本即使超过传统 260 字符限制也能原子保存；持久化和界面仍显示普通盘符 / UNC 路径。

Editor 的全部 Node → Python 子进程通过 `scripts/editor/python-utf8.mjs` 固定 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8`，并在 Windows 设置 `windowsHide`。会话 JSON、工作副本、附件、新建校验、固化结果与中文错误输出都不继承 Windows 控制台的 GBK/ACP，也不会因辅助进程额外弹出任务栏窗口；Windows 与 macOS 轮流操作同一项目时，仍以 UTF-8 作为唯一进程协议编码。

桌面入口默认使用 `auto` provider：按当前系统实际可执行命令依次识别 Codex、Claude Code、OpenCode，只安装 Claude Code 的 Windows 环境会直接启动 `claude --dangerously-skip-permissions`，不会先尝试 Codex，也不会在 provider 缺失时静默切换。Windows 也可通过 `%USERPROFILE%\.huawei-deck-editor\settings.json` 把 Codex runtime 固定到指定 WSL2 发行版和用户；Editor 会用登录 `PATH` 定位 CLI、用 `wslpath` 转换项目与任务路径，并在 WSL 用户自己的 `~/.codex` 内发现和恢复会话，完整配置见 [`INSTALL.md`](INSTALL.md#windows-editor-使用安装在-wsl2-内的-codex)。这项本机配置不改变原生 Windows、macOS 或其他 provider。Codex 或 Claude Code 恢复持久会话时，只有可见 CLI 明确报告会话 ID 不存在，才自动创建并持久化替代会话；工作副本与待办原样保留，登录、网络或其他启动失败不会误清旧绑定。三种 CLI 都使用各自的真实输入态闸门：Codex 0.148 初始化期间提前出现的草稿输入框不能触发任务，必须等模型与工作目录完整状态栏；Claude Code 必须画出 Ink 的空 `❯` 输入行和光标；OpenCode 必须画出 `Ask anything` placeholder 与可见光标。Windows ConPTY 对三者都把正文按 UTF-8 字节拆成不超过 512 B 的 bracketed-paste 分块并逐块节流，完整写入且单独关闭 paste 后才延迟发送 Enter，Claude Code 额外保留较长渲染等待。Enter 发出后只有收到 CLI 活动区重绘或处理中信号才算提交；1.5 秒无回执重试一次，再失败就明确提示手动提交。每次成功提交后重新等待下一个输入提示符。

命令式入口继续保留：`python3 scripts/deck-editor.py <deck.html>`。Skill / Agent 完成第一版 deck 并通过基础验证后可直接带路径启动，Windows / Linux 也使用这一入口：

```bash
# 只检查 Editor 启动所需能力；不会被 LibreOffice 等可选工具阻塞
python3 scripts/check_deps.py --profile editor-core --check-only

# 通用启动命令；默认回环地址 127.0.0.1，并自动打开浏览器工作台
python3 scripts/deck-editor.py <deck.html>

# 仓库里的真实示例
python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
```

Windows PowerShell 对应命令：

```powershell
py -3 scripts\check_deps.py --profile editor-core --check-only
py -3 scripts\deck-editor.py .\Deck-Projects\renzhi\renzhi-deck.html
```

PPTX 转换统一走跨平台 Python 入口；`convert.sh` 只是 macOS / Linux 的薄包装：

```bash
python3 scripts/html2pptx/convert.py my-deck.html my-deck.pptx
```

```powershell
py -3 scripts\html2pptx\convert.py .\my-deck.html .\my-deck.pptx
```

窗口化 Editor 是 Skill 的可选增强，不是使用前提。任何 Agent 直接调用 Skill 修改已有 Deck 时，优先复用环境中的活动 Managed Workspace；没有可见窗口时可启动同一事务内核的无窗口 workspace：

```bash
python3 scripts/deck-editor.py /absolute/path/to/deck.html --headless-workspace
export HUAWEI_DECK_WORKSPACE_CAPABILITY_FILE=/启动首行返回的/capabilityPath
node scripts/editor/cli.mjs replace-text "旧文字" "新文字"
node scripts/editor/cli.mjs verify
node scripts/editor/cli.mjs solidify
```

无窗口模式不打开浏览器 UI、不启动内嵌 Agent，但仍使用受控 frame，因此 ActionMutation、SourceMutation、revision、撤销 / 重做、溢出诊断和固化语义与窗口模式完全一致。真实 Deck 在 `solidify` 前保持只读；用户要求仅预览时保留 workspace 与未固化历史。只有用户明确不要后台运行时或依赖不可用时才使用经典 `edit-bundle.py` 直改；该 fallback 没有 Mutation、跨轮撤销与固化，不能静默冒充受控模式。新建 Deck 仅在复制模板产生目标文件前不需要 workspace，合法 bundle 出现后第一版制作立即切入同一流程。

macOS 上由 Skill 直接打开桌面应用并带入刚生成的文件：

```bash
open -n "Huawei Deck 编辑器.app" --args --agent-thread-id "$CODEX_THREAD_ID" "$(pwd)/my-deck.html"
```

添加 Deck 时，导入页会把自动识别的项目根目录显示出来供用户确认，也允许改选。进入工作台后无需手动绑定会话：Editor 打开新任务时会在后台创建 Codex / Claude Code / OpenCode CLI 会话。Codex 与 OpenCode 在首个可见 turn 后发现并保存真实会话 ID，Claude Code 使用显式 session ID；点击“继续任务”时恢复原会话与工作副本。首个 Prompt 对当前 `huawei-deck` Skill 只初始化一次，打开终端只是接入已经运行的 PTY。活动 provider、项目根目录和会话标识单独写入 sidecar 的 `agent-workspace.json` 和 `workspaceRevision`，不增加 Deck revision，也不污染撤销 / 重做与固化队列。

右上角状态反映真实 PTY 的准备中、处理中、等待确认、空闲或失败状态；点击后从右侧推出唯一的 Agent 交互终端，不会到这一步才创建会话。终端抽屉与属性面板保持相同高度，默认宽度为浏览器窗口的三分之一；左边界可拖动，向左加宽会压缩中间画布，任务面板同步向内避让。产品不再提供结构化对话页签、消息气泡或独立消息输入框。窗口化 Agent Host 的固定 provider 注册表只包含 Codex、Claude Code 与 OpenCode；浏览器刷新只重连同一个 PTY，新会话按钮才会结束旧 CLI 并重新启动。未安装的 provider 明确报错，不静默切换。三种 CLI 在 bypass 启动后若显示目录 trust 询问，服务会把它视为“需要用户交互”而不是“Agent 已就绪”：编辑页和新建页都会自动展开（已收起则重新展开）右侧终端，显示“等待确认”并脉冲提醒；确认前不会粘贴初始化说明或任务，确认后等正常输入框出现才继续自动提交。Agent 任务与人工键盘输入共享这一终端。终端是 Editor 的实时交互视图，但任务完成、Deck action、撤销与固化仍以 sidecar 为权威。界面不提供高级设置或“连接已有会话”，也不会扫描本机历史会话；旧绑定数据只做一次静默迁移。

工作台提供预览、编辑、区域标记三种一级模式。编辑模式统一承担文字、移动和缩放：文字内部保持文本光标，单击即可放置光标并编辑，按住拖动可选择文字；红色选框边缘显示抓取手势，只有拖动边缘才移动整个元素，超过 7 个屏幕像素才启动位移；右下控制点继续缩放，无需切换工具。编辑模式下按住 `R` 可临时进入区域标记，拉框后松开即回到编辑模式并保留标注输入框；临时 `R` 快捷键按物理 `KeyR` 识别，中文输入法组合态也有效，直接文字编辑和其他真实输入控件仍保留输入语义。区域拉框后在旁侧输入说明，任务会跨页累积到右下角 Agent 任务 drawer；左侧页码 badge 只统计待处理、处理中、失败和待确认任务，已完成任务不再占用页码提示。完成项默认收进闭合的“已完成”分组，未固化时可从任务行撤回；非末尾 Agent 动作会追加补偿修改以保留后续编辑，固化后完成项只保留供查看。待处理、失败和待确认任务可在任务行二次编辑或确认删除，Agent 批处理期间锁定，已完成任务需先撤回。删除会同步移除该任务的局部截图与附件。文字编辑范围始终复用单击后出现的红色选框：单击框内普通文字或局部加粗 / 着色片段，都只把红框对应的整个独立布局盒设为统一编辑区，不会因 `span` / `strong` 或局部格式包装拆成多个编辑框。含格式与 `<br>` 的混排段落提交时，会为实际改动的文本节点记录 `textPath`，保留未改片段的结构；局部格式包装因覆盖或撤销重建后，旧 `textPath` 只在同一文字盒内按修改前原文唯一恢复，重复内容不猜测目标。单击只放置光标，不自动全选，用户可按住鼠标拖选；双击沿用浏览器原生按词选择，点击别处或按 `Cmd/Ctrl+Enter` 提交；全选删除会记录空字符串，不会恢复旧文字。移动命中不再依赖 class，内联文字会提升到最近的独立布局盒。图片内文字、SVG、链接与交互组件仍使用区域标记，避免伪造可编辑文本或破坏结构。外部 Agent 不是内置聊天机器人：既有文字可先用 CLI `locate-text` / `replace-text` 唯一定位并提交同一 action API，其他细节修改用 `apply`；模板升级、DOM 重构和整页操作只修改托管工作副本。连续标注后点击一次“交给 Agent”，网页只提交点击瞬间未完成的任务 ID 与 revision；服务端立即创建批处理并通过 WebSocket 回显 queued / running / succeeded / failed，提交之后的新标注进入下一批。Editor 专用会话按 provider 持续复用；当前 Skill 契约只在首次创建或版本升级时初始化。observer WebSocket 使用 `/events`，仅订阅服务事件；唯一 editor capability WebSocket 只在 parent 与服务之间传递 frame 事务、文字定位和 ACK，不对外提交动作。

Agent 通过受控 HTTP 使用 `GET /api/session`、`GET /api/tasks`、带幂等 `commandId` 的 `POST /api/actions`、`POST /api/groups/<GROUP_ID>/undo`、`POST /api/groups/<GROUP_ID>/redo` 与检查点 `POST /api/write-deck`；真实发布只允许明确固化意图，先经 `POST /api/solidify-preflight` 取得一次性令牌，再调用 `POST /api/solidify-deck`。可见 Editor 由浏览器用户确认，无窗口 Skill 仅在用户要求完成、保存或正式写入时由 Agent 调用。

文字拖选后会在选区旁显示浮动格式工具条；点击右侧面板或工具条不会退出文字编辑，动作完成后恢复原生选区、焦点和继续输入状态。属性面板支持字体、字重、斜体、下划线、字号、颜色、左 / 中 / 右对齐、项目符号和行距，`Cmd/Ctrl+B/I/U` 可作用于局部选区或整个文字盒。右侧停靠时，控件按“文字 / 段落 / 外观 / 更多”组成互斥手风琴，对象摘要和恢复操作分别固定在顶部与底部；右侧终端展开后，属性面板停靠到画布上方，字体、字号与 `B/I/U` 单行常驻，段落、外观和更多通过互斥下拉抽屉展开，始终不依赖横向滚动。表格单元格按独立 `TD` 文字盒命中，格式与直接改字都不会把整张表变成目标。局部选区和含富文本运行段的整框选中都会显示混合三态；整框字形修改覆盖完整字符范围，不会被内部 `span` 的旧格式挡住。退出直接编辑时同步恢复权威格式动作，避免用户紧接着点击整框时取得短暂无格式的旧快照。零长度文本节点不参与判定，重叠范围按后写覆盖并合并为互不重叠的最终运行段。同一字号或行距控件 3 秒内的连续调整合并为一个撤销步骤。

页面栏与属性面板的开合控件统一使用 30px 圆形白底 PillNav 箭头；hover 只保留液态圆形填充，不复制箭头做文字翻页。页面栏展开 / 收起分别朝左 / 右，右侧属性面板展开 / 收起分别朝右 / 左，顶部属性面板展开 / 收起分别朝上 / 下，状态切换只旋转同一枚 CSS chevron。

Agent 终端通过独立的 `/agent-terminal` WebSocket 传输 PTY 输出、键盘输入和终端尺寸，只接受带 editor capability 的当前本地页面。浏览器只能从注册表选择 `codex`、`claude-code` 或 `opencode`，以及重启会话和发送终端输入；不能提交 executable、任意 CLI 参数、环境变量或历史会话 ID。编辑器 URL / token 只通过受控子进程环境变量传递。

把一批反馈交给 Agent 后，如果在右侧 CLI 中按独立的 `Esc` 中断当前执行，编辑器会同步把本批状态改为“已取消”，未完成任务仍保持待处理并可立即重新提交；长期 Codex / Claude Code / OpenCode PTY 与会话身份继续保留。方向键等以 ESC 开头的终端控制序列不会被误判为批次中断。

顶栏的“撤销 / 重做”只移动编辑时间线的唯一历史游标，覆盖人工文字、移动、缩放、Agent 动作和结构修改；新修改会截断游标后的旧重做分支。`Cmd/Ctrl+Z` 撤销，`Cmd/Ctrl+Shift+Z` 重做，Windows 也可用 `Ctrl+Y`。焦点位于文字或其他输入框时快捷键保留原生输入撤销，不触发 Deck 全局历史。任务行撤回非末尾 Agent ActionMutation 时追加可逆补偿修改；涉及 SourceMutation 或无法保留后续修改时明确报冲突。区域任务可选择文件（支持多选和连续追加）或粘贴图片，粘贴图片会转为 PNG；每个任务最多 8 个附件，单个文件最大 25 MiB。浏览器无法取得原文件绝对路径，服务会把副本复制到 sidecar 会话的 `attachments/`。只有任务 payload 的序列化出口会派生路径：`GET /api/tasks`、`GET /api/tasks/<TASK_ID>`、`POST /api/tasks` 响应中的 `task`、`task-created` / `task-updated` 等事件或动作响应中的 `task`，以及 CLI `tasks` / `task`；这些出口返回副本绝对 path，供外部 Agent 读取。`GET /api/session` 与磁盘 `session.json` 只含 sidecar 相对 `relativePath`，不保存、也不返回附件绝对路径。附件不进入最终 deck，并随 sidecar 生命周期管理，也不属于 Deck 动作的撤销 / 重做范围。

任务删除规则以撤销边界判断：上文“已完成任务需先撤销”只指仍有 `groupId` 的未固化任务；已固化任务可删除记录，删除不会改变 Deck 中已经固化的修改，但仍会清理对应局部截图与附件。

常用的外部 Agent CLI 是：

```bash
# 用启动器输出的真实值替换下面两项
EDITOR_URL=http://127.0.0.1:12345
EDITOR_TOKEN=启动器输出的token
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" revision  # 只读权威 revision（Agent 批处理优先）
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" status    # 完整会话状态（人工诊断）
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" tasks
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" task TASK_ID
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" locate-text "待查文字"
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" replace-text "旧文字" "新文字"
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" apply actions.json
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" undo GROUP_ID
```

Editor 启动时把真实 source deck 复制到 `.huawei-deck-editor/<session>/working/deck.html`，会话内真实 Deck 只读；旧页面在工作副本中一次性获得持久 `data-page-id`。重开时先以内嵌且可解析的工作副本补丁块对账 `session.solidifiedActions`，再迁移页面身份，可修复旧版编码损坏的已固化基线，同时保留未固化编辑时间线。session v2 以 `timeline.entries + timeline.cursor` 为权威，`groups / redo` 只是兼容投影；旧 active 空洞在加载时线性化，无法证明有效的 redo 进入迁移归档。若写入中断留下无效工作副本，启动按 session 指纹从 `working/versions` 恢复最后有效版本并在界面提示，不覆盖真实 Deck。统一历史包含重放 locator 的 `ActionMutation`，以及保存工作副本前后 SHA-256 的 `SourceMutation`。所有带 revision 的写操作先强制登记已经写盘的工作副本变化；若 Agent 已经写盘，旧人工动作、撤销 / 重做或固化请求会在产生副作用前以 revision 冲突结束。模板升级、复杂 DOM / 动画重构和整页增删排序由终端 Agent 经 `scripts/edit-bundle.py` 修改 `HUAWEI_DECK_WORKING_PATH`；该脚本先验证候选，再同目录原子替换，Editor 验证后自动记录结构历史并刷新页面。插页生成新 ID、移页保留 ID、删页移除目标 ID，因此其他页补丁不依赖页序。源码变化后旧 action 仅在几何、语义指纹及语义规范化后的当前 `before` / `after` 值仍一致时继续重放；同一属性已被 Agent 改写、元素被替换或文字范围变化时以 `HISTORY_DIVERGED` 安全报冲突并显示全局提示，不能静默覆盖，固化后的离线补丁也使用同一规则。sidecar 不进入最终交付 deck，本仓库 `.gitignore` 已忽略提交该目录。

Agent 结构修改必须先执行 `begin-source-edit`（区域任务使用 `begin-source-task`）取得 `sourceEditId` 与预留 revision，成功后才能写工作副本，写盘完成必须执行 `commit-source-edit`；失败执行 `cancel-source-edit` 回滚。事务活动期间，人工 action、撤销、重做和固化统一返回 `SOURCE_EDIT_ACTIVE`。源码事务与 revision 一并持久化；服务重开后仍保留开始前基线，只允许同一 `sourceEditId` 继续 commit 提交或 cancel 取消，不由文件监视器猜测提交顺序。文件监视器只兼容旧客户端在事务外直接写入。

`data-editor-id` 是可编辑元素的持久元素身份。Agent 移动或调整层级时必须保留既有 `data-editor-id`；新增元素会在 SourceMutation 之前由工作副本归一化补齐。格式错误或重复的身份必须安全停止。`data-editor-id` 只定位元素，不放宽 `before` / `after` 与文字范围校验；Agent 改写同一属性或改变字符偏移时仍然冲突关闭。旧 action 没有该身份时继续使用保守的路径、几何与语义锚点，不猜测迁移目标。

区域任务中的结构修改先用 `begin-source-task TASK_ID` 建立事务，写盘后按返回的 `sourceEditId` 与 revision 调用 `commit-source-edit`，SourceMutation 才会完成对应任务；失败调用 `cancel-source-edit`。撤销 / 重做同步让任务回到待处理 / 再次完成。任务原 `pageKey` 在当前工作副本中不存在时保留不可定位安全标记：待处理、失败或待确认任务显示“原目标不可定位”并停止交给 Agent；已完成历史仍显示“已完成”，不进入红色告警计数。该标记不再武断表示页面已删除，因为页面替换或结构重建也可能让旧身份消失；撤销相关结构修改后任务自动恢复。这样整页删除不再卡在元素 Action，也不会用隐藏内容冒充删页。

自动保存 session 不等于修改正式文件。正式发布先调用 `POST /api/solidify-preflight` 检查 revision、文件绑定、真实 / working 双指纹、页面目标、诊断和动作投影，再把 60 秒内一次性令牌交给唯一写入 API `POST /api/solidify-deck`。可见 Editor 由用户点击顶栏“固化修改”并二次确认，无窗口 Skill 仅在用户明确要求完成、保存或正式写入时由 Agent 调用；固化成功会建立检查点并归档当前编辑时间线。它把托管工作副本与当前最终 action 快照组成唯一离线补丁块，经 bundle verify 与 browser patch replay 后，由可信 sidecar 备份并原子替换真实 Deck。连续固化不会丢失上一轮结果，也不会按保存次数追加补丁块。浏览器标签页的 `×` 会直接关闭，不触发 Chrome 通用离开提醒；网页无法用自定义弹窗接管标签页关闭。要离开编辑器，应点击品牌区右侧、页面左上角独立的“退出编辑”；右侧工作区导航继续保留“初始页”按钮，二者不能互相替换。有未固化历史或 Agent 正在运行时，“退出编辑”会直接打开页面内未固化任务清单，按最新修改倒序列出页码与任务说明，并提供“继续编辑”“暂不固化，退出”“固化并退出”。后者仍走同一预检与安全写入流程；未固化历史和工作副本会保留到下次打开。`Cmd/Ctrl+S` 和 `POST /api/write-deck` 只做检查点，不发布真实文件。冲突或验证失败会拒绝覆盖。

当前退出交互以“退出编辑器”为唯一文案：初始页、流程页和各编辑页面的品牌区右侧保持同一位置，文字右侧使用品牌红线性的门框与向右退出箭头，不带独立底框。退出会显式关闭启动器、全部编辑运行时与 Agent 终端，而不是返回初始页。退出弹窗覆盖游标前全部生效条目，按 `taskId` 分组；任务默认只显示任务说明与下拉箭头，首次展开时才生成页码、条目数和修改类型。直接编辑 / 结构修改与游标后的重做历史独立显示。

进入后期编辑器后，iframe 动作层仍不直接增删页、调整页序或重构复杂动画；这些结构工作由右侧真实 PTY 中的 Agent 经 `scripts/edit-bundle.py` 修改托管工作副本，Editor 自动接入 SourceMutation。删除仍有 action 的页面不会阻断重开与撤销，但会以 `MISSING_PAGE_TARGETS` 阻止固化，直到用户恢复页面或清理对应动作。编辑器不另造一套聊天协议，直接承接同一个 CLI 终端。Agent 动作受 token、revision、pageId、locator 与事务校验。关闭服务后可重开同一 session；若出现 `RECOVERY_REQUIRED`，未决恢复状态会阻断继续发布。

写回后运行完整验证：

```bash
python3 scripts/edit-bundle.py <deck.html>                         # eb.verify
node scripts/verify/measure_overflow.mjs <deck.html> --all        # 全页无新增溢出
node scripts/verify/shot.mjs <deck.html> <页label> /tmp/page.jpg  # 1920×1080 目检
node scripts/verify/steps.mjs <deck.html> <页label> /tmp/steps    # 仅修改动画页时逐拍核对
```

`shot.mjs` 和动画页的 `steps.mjs` 使用 1920×1080 逻辑画布；无动画页运行 `steps.mjs` 只打印“此页无动画”并退出 0，不生成逐拍截图。操作细节与错误恢复见 [`references/editing-guide.md`](references/editing-guide.md)，开发者架构与信任边界见 [`docs/architecture.md`](docs/architecture.md)。

已有 Deck 跟随 skill 更新：Agent 每次加载本 skill 后，首次接触一个 deck 目录时批量运行一次 `python3 scripts/upgrade_deck.py 我的演示.html --yes`，同一工作过程不重复检查；Editor 会话中只升级 `HUAWEI_DECK_WORKING_PATH`。升级器会识别声明 hash 与实际外壳漂移并走 Git 三方合并，给页面补齐持久 ID，严格迁移补丁 locator，最后用真实浏览器验证全部补丁重放；任何未知合并冲突或失效补丁都会停止写入。

编辑模式中，从红框边缘点选整个元素后按 `Delete` / `Backspace` 会以可撤销的显隐 action 删除；直接文字编辑中的删除键仍只修改文字。Windows / Linux 内嵌终端的 `Ctrl+V` 只粘贴一次剪贴板文字，不再向 Codex 误送图片粘贴控制字符；有文字选区时，`Ctrl+C` 由浏览器复制且不向 PTY 发送 `0x03`，没有选区时仍发送终端中断。macOS 继续使用原生 `Cmd+C` / `Cmd+V` 路径。

### 区域任务的交互画面绑定

编辑器打开时默认进入区域标记，左侧页面栏默认折叠为窄页码轨道，可按顶部箭头展开完整标题。区域说明弹窗可选“继续添加任务”只保存当前标记，或选“直接提交任务”将累计的全部待完成任务作为一批交给 Agent。区域标记模式下按住 `R` 会临时进入预览，可直接操作 Deck 内按钮，松开后恢复区域标记；输入控件继续把 `R` 当普通文字。区域拉框时把当前页的 layer、分步显示、展开项等交互状态写入任务，定位会先恢复标记画面，再显示原区域；历史 Deck 的 `data-mod` 目录仍保留兼容读取，但新页面不得再生成。Deck 内导航与主舞台滚动结果会同步回左侧页序，同页内容重绘不会再触发页面重定位，缩略图副本不参与当前页判断。

## 许可证

原创代码与文档（`scripts/` / `references/` / `SKILL.md` 等）以 **MIT** 许可，见 [`LICENSE`](LICENSE)。

两块第三方内容**不在** MIT 范围内，按各自条款使用：`.agents/skills/pdf/`（Anthropic 官方 skill，© Anthropic, PBC）、`assets/huawei-refs/` 与模板中的华为官方版式 / 封面 / 插画 / Logo / 品牌色（版权归华为）。复用品牌素材前须自行获得授权；发布自己的 deck 前建议按 `references/branding.md` 替换为自有或已授权资产。详见 `LICENSE` 末尾的第三方声明。
