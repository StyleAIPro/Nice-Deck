# huawei-deck skill 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 从 77 页《训练Infra课程-独立版 (2).html》做减法，产出 24 页「页型画廊」模板 deck，连同文档与工具打包成自包含 Claude Code skill `huawei-deck`。

**架构：** 模板 deck 由主 deck 整块重组产出（复制源文件 → 抽取 24 个 slide 块按模板章节重排 → 整块替换 slides 区 → 重写 nav[]/chapters[]），运行时（字体/内联 React/玻璃 CSS/loading overlay/localStorage 恢复）零改动随文件带走；随后逐批占位化文字与图、清理 manifest、写文档、跑出厂验证、安装测试。

**技术栈：** Python 3（复用 `dc-slide-deck/edit-bundle.py` 的 load/get_template/set_template/dump_template/verify）、Node + playwright-core（headless Chrome 验证/截图）、python-pptx（html2pptx）。

**规格：** `docs/superpowers/specs/2026-07-06-huawei-deck-skill-design.md`

---

## 全局纪律（每个任务都适用）

- **本项目不是 git 仓库，且项目目录内备份会被外部进程清空。** 所有 commit 步骤替换为「checkpoint 副本」：`cp` 产物到 session scratchpad（环境提示中的 scratchpad 目录，下文记 `$SCRATCH`），命名 `_ckpt_task<N>_<说明>.html`。构建脚本（一次性）也放 `$SCRATCH`，最终 skill 目录里只留使用者需要的文件。
- **主课程 deck 与 `dc-slide-deck/` 只读，绝不修改。**
- 每次改模板 deck 后必跑：`python3 dc-slide-deck/edit-bundle.py "class-1/huawei-deck/assets/template-deck.html"`（即 `eb.verify`，断言 slide-fit/sections/nav 三者一致且 nav i: 连续）。
- 所有 Python 构建脚本用如下方式引用 edit-bundle（它带连字符不能 import）：

```python
import importlib.util, os
ROOT = '/Users/zhaoyinqi/Downloads/Training Lesson/class-1'
spec = importlib.util.spec_from_file_location('eb', os.path.join(ROOT, 'dc-slide-deck/edit-bundle.py'))
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)
```

- **独立版编码铁律**（edit-bundle 已内置，手写替换时同样遵守）：template 字符串改完必经 `eb.set_template`（内部 `json.dumps(...).replace('</','<\\u002F')` + 断言）；绝不手拼 JSON。
- 浏览器验证统一环境变量：`PW=/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.js`（脚本里做成 `process.env.PLAYWRIGHT_CORE || <该默认值>`）。

## 文件结构（最终产物）

```
class-1/huawei-deck/
├── SKILL.md                        # 任务 8 产出
├── assets/
│   └── template-deck.html          # 任务 1-5 产出（24 页页型画廊）
├── references/
│   ├── template-pages.md           # 任务 8
│   ├── design-system.md            # 任务 8
│   ├── page-snippets.md            # 任务 8
│   ├── animation.md                # 任务 8
│   ├── editing-guide.md            # 任务 8
│   └── branding.md                 # 任务 5
└── scripts/
    ├── edit-bundle.py              # 任务 6（自 dc-slide-deck 复制）
    ├── apply_bg.py                 # 任务 5（自 apply_template_bg.py 参数化）
    ├── html2pptx/{convert.sh, shoot.mjs, build_pptx.py}   # 任务 6
    ├── verify/{measure_overflow.mjs, shot.mjs, steps.mjs} # 任务 6
    └── react.umd.js, react-dom.umd.js                     # 任务 6
```

## 模板页选定表（任务 1 的输入，已按 77 页盘点确定）

新 deck 页序 / 源 DOM idx / 源 data-label → 新 data-label（nav label 同）/ nav code：

| # | 源idx | 源label | 新label | code | 动画特征（必须保留） |
|---|---|---|---|---|---|
| 0 | 0 | 封面 | 封面 | 封面 | 金色背景画、口号（任务5占位） |
| 1 | 1 | 目录 | 目录 | 目录 | — |
| 2 | 2 | 课程概览 | 议程页 | 议程 | SMIL×2 装饰 |
| 3 | 3 | 第一章 | 章扉页 | 章扉 | 大数字水印 |
| 4 | 5 | 问题一 | 问题页 | 问题 | 大红 Q 水印 |
| 5 | 4 | AI 与 ML | 版式·卡片网格 | 卡片 | build×5 逐卡 |
| 6 | 6 | 数据集 | 版式·左图右文 | 图文 | build×3，img×5→占位 |
| 7 | 14 | 训练四步 | 版式·流程条 | 流程 | build×4 逐节点 |
| 8 | 36 | 架构演进 | 版式·对比两栏 | 对比 | build×2，img×4→占位 |
| 9 | 23 | 训练超参数 | 版式·密集多栏 | 密集 | build×15 |
| 10 | 40 | 模型评测 | 版式·表格混排 | 表格 | build×10，img×2→占位 |
| 11 | 50 | 方法论主图 | 版式·全幅大图 | 大图 | 全幅 SVG（保留结构） |
| 12 | 71 | Timeline对比 | 版式·截图对照 | 截图 | img×2→占位 |
| 13 | 21 | 动手实验·Playground | 版式·动手实验 | 实验 | iframe/链接语汇 |
| 14 | 15 | 数据采样 | 动画·build逐步 | build | build×9 steps0-4（机制demo） |
| 15 | 20 | 优化器 | 动画·layer切换 | layer | layerbtn×4 g=opt + data-step |
| 16 | 44 | LoRA 原理直观 | 动画·混合链 | 混合 | layer×5 g=lora + build×3 steps0-6 |
| 17 | 10 | 网络结构 | 动画·SMIL运动 | SMIL | SMIL×21（机制demo） |
| 18 | 12 | 承上启下 | 深色·金句 | 金句 | #15171c，build×4 |
| 19 | 24 | 本章小结 | 黑板·题卡A | 题卡A | #15171c+金框黑板背景，build×10（题卡：选择/填空混排） |
| 20 | 61 | 三章巩固一 | 黑板·金框题卡 | 题卡B | 金框背景画（tpl-bg-950），build×8（950 重编卡风） |
| 21 | 73 | 问题十 | 研讨页 | 研讨 | 研讨条目版式 + 右下人像 ::after |
| 22 | 76 | 结语 | 结语页 | 结语 | 金色门面背景、口号（任务5占位）；纯 Thanks 页无动画 |

**共 23 页。** 新 chapters（5 章）：`{name:'01 · 门面页型', start:1}, {name:'02 · 内容版式', start:5}, {name:'03 · 动画机制', start:14}, {name:'04 · 深色与黑板', start:18}, {name:'05 · 收尾页型', start:21}`。

> 注 1：源 label「本章小结」「课堂巩固二」在主 deck 出现两次（idx 24/46、25/47），因此**一律按 DOM 序号抽取，不按 label**。
> 注 2（执行中修订）：① 源 idx25「课堂巩固二」与 idx24 同款题卡，冗余，已从 KEEP 删除（24 页→23 页）；idx24 实为题卡内容，改名「黑板·题卡A」。② 结语页（idx76）经精确核查为纯 Thanks 页，早前盘点的 layer(tl)+SMIL 属正则把运行时 JS 计入的假象——tl 层机制属未入选的 idx70，模板 layer 示例由「动画·layer切换」「动画·混合链」覆盖。③ deck 的 `<style id="tpl-bg-950">` 用 data-label 属性选择器挂门面/黑板背景与人像——改 label 后必须同步重写该块选择器（任务 1 构建脚本已含此步）。

---

### 任务 1：整块重组产出 24 页模板 deck

**文件：**
- 创建：`class-1/huawei-deck/assets/template-deck.html`
- 创建（构建脚本）：`$SCRATCH/tpl_task1_rebuild.py`

- [ ] **步骤 1：建目录骨架**

```bash
cd "/Users/zhaoyinqi/Downloads/Training Lesson/class-1"
mkdir -p huawei-deck/assets huawei-deck/references huawei-deck/scripts/html2pptx huawei-deck/scripts/verify
```

- [ ] **步骤 2：写构建脚本 `$SCRATCH/tpl_task1_rebuild.py`**

```python
# -*- coding: utf-8 -*-
"""任务1：从主 deck 整块重组出 24 页模板 deck（复制→抽块→重排→整块替换→重写 nav/chapters）。幂等：每次从源重建。"""
import importlib.util, os, re, shutil
ROOT = '/Users/zhaoyinqi/Downloads/Training Lesson/class-1'
spec = importlib.util.spec_from_file_location('eb', os.path.join(ROOT, 'dc-slide-deck/edit-bundle.py'))
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)

SRC = os.path.join(ROOT, '训练Infra课程-独立版 (2).html')
DST = os.path.join(ROOT, 'huawei-deck/assets/template-deck.html')
SEP = '\n\n    '

# (源DOM idx, 新data-label, nav code)——顺序即新页序。源 label 有重复，一律按 DOM 序号抽取。
KEEP = [
    (0,'封面','封面'), (1,'目录','目录'), (2,'议程页','议程'), (3,'章扉页','章扉'), (5,'问题页','问题'),
    (4,'版式·卡片网格','卡片'), (6,'版式·左图右文','图文'), (14,'版式·流程条','流程'),
    (36,'版式·对比两栏','对比'), (23,'版式·密集多栏','密集'), (40,'版式·表格混排','表格'),
    (50,'版式·全幅大图','大图'), (71,'版式·截图对照','截图'), (21,'版式·动手实验','实验'),
    (15,'动画·build逐步','build'), (20,'动画·layer切换','layer'), (44,'动画·混合链','混合'), (10,'动画·SMIL运动','SMIL'),
    (12,'深色·金句','金句'), (24,'黑板·题卡A','题卡A'), (61,'黑板·金框题卡','题卡B'),
    (73,'研讨页','研讨'), (76,'结语页','结语'),
]
CHAPTERS = [('01 · 门面页型',1), ('02 · 内容版式',5), ('03 · 动画机制',14), ('04 · 深色与黑板',18), ('05 · 收尾页型',21)]
# ……（执行版脚本另含「重写 tpl-bg-950 选择器」步骤：门面背景→封面/目录/章扉页/结语页；
#     黑板背景→黑板·题卡A/黑板·金框题卡；人像 ::after 与 h2 限宽→问题页/研讨页。声明体不动。）

shutil.copyfile(SRC, DST)
lines = eb.load(DST)
s = eb.get_template(lines)

secs = [m.start() for m in re.finditer(r'<section\b', s)]
assert len(secs) == 77, len(secs)

def block_by_index(k):
    """按 DOM 序号抽取完整 '<div class="slide-fit"...>…</div></div>' 块（同 eb._slide_bounds 逻辑）。"""
    i = secs[k]
    st = s.rfind('<div class="slide-fit"', 0, i)
    end = s.find('</div></div>', s.find('</section>', i)) + len('</div></div>')
    assert 0 < st < i < end
    return s[st:end]

blocks = []
for newidx, (srcidx, newlbl, code) in enumerate(KEEP):
    b = block_by_index(srcidx)
    b = re.sub(r'(<section\b[^>]*data-label=")([^"]*)(")', lambda m: m.group(1)+newlbl+m.group(3), b, count=1)
    b = re.sub(r'(<div class="slide-fit"[^>]*data-idx=")(\d+)(")', lambda m: m.group(1)+str(newidx)+m.group(3), b, count=1)
    assert 'data-label="%s"' % newlbl in b
    blocks.append(b)
new_slides = SEP.join(blocks)

# 整块替换 slides 区（配方同 dc-slide-deck/build_review_deck.py 步骤3）
first = s.find('<div class="slide-fit"')
last_fit = s.rfind('<div class="slide-fit"')
slide_block_end = s.find('</div></div>', s.find('</section>', last_fit)) + len('</div></div>')
assert first > 0 and slide_block_end > first
s = s[:first] + new_slides + s[slide_block_end:]

# 重写 nav[]
nav_body = "const nav = [\n" + "\n".join(
    "      { i:%d, code:'%s', label:'%s' }," % (i, c, l) for i, (_, l, c) in enumerate(KEEP)
) + "\n    ];"
ns = s.find('const nav = ['); ne = s.find('];', ns); assert ns > 0
s = s[:ns] + nav_body + s[ne+2:]

# 重写 chapters[]
chap_body = "const chapters = [\n" + "\n".join(
    "      { name:'%s', start:%d }," % (n, st) for n, st in CHAPTERS
) + "\n    ];"
cs = s.find('const chapters'); ce = s.find('];', cs); assert cs > 0
s = s[:cs] + chap_body + s[ce+2:]

eb.set_template(lines, s)
eb.save(DST, lines)
print('saved %.1f MB' % (os.path.getsize(DST)/1e6))
eb.verify(DST)
```

- [ ] **步骤 3：运行并验证**

运行：`cd "$ROOT" && python3 "$SCRATCH/tpl_task1_rebuild.py"`
预期输出：`slide-fit=23  sections=23  nav=23  nav_seq_ok=True`，chapters 5 条如上（start 1/5/14/18/21）。若断言失败先修脚本再重跑（幂等，从源重建）。改 label 后**必须截图验证背景**（tpl-bg-950 属性选择器页：章扉/题卡×2/研讨/结语/封面/问题页）——溢出检测查不出丢背景。

- [ ] **步骤 4：浏览器冒烟**

用任务 6 之前的临时方式跑一次现有工具：
`node "$ROOT/scratchpad/measure_overflow.mjs" "$ROOT/huawei-deck/assets/template-deck.html" 封面 版式·卡片网格 结语页`
注意：该旧脚本第 10 行有 `length > 60` 的等待条件，对 24 页会 falsy——先临时把该行 `60` 改 `20`（此脚本在 scratchpad，可改）。预期三页都能找到、section overflow Y=0。

- [ ] **步骤 5：checkpoint**

```bash
cp "$ROOT/huawei-deck/assets/template-deck.html" "$SCRATCH/_ckpt_task1_rebuilt.html"
```

---

### 任务 2：图片→占位框 + 口号占位（占位化第一批：全局机械替换）

**文件：**
- 修改：`class-1/huawei-deck/assets/template-deck.html`
- 创建：`$SCRATCH/tpl_task2_imgs.py`

品牌图（**保留不占位**）：封面/结语的金色背景画、HUAWEI logo 水印、金框题卡的 `tpl-bg-950` 背景。识别方法：这些以 CSS `background-image:url(<uuid>)` 或 `.tpl-bg-950` 规则引用，或 `<img>` 出现在 section 0/23 的背景层（`position:absolute` 且 `z-index` 为负或最先出现）。**内容图（占位）**：其余 `<img src="<32位hex uuid>">` 课程截图。

- [ ] **步骤 1：先盘点再动手（只读）**

```python
# $SCRATCH/tpl_task2_imgs.py 开头：列出每页 <img>，人工核对哪些是品牌背景
import re
# ...load 同全局纪律...
s = eb.get_template(eb.load(DST))
secs = [m.start() for m in re.finditer(r'<section\b', s)]
for k in range(len(secs)):
    seg = s[secs[k]:secs[k+1] if k+1 < len(secs) else len(s)]
    lbl = re.search(r'data-label="([^"]*)"', seg).group(1)
    for m in re.finditer(r'<img\b[^>]*>', seg):
        tag = m.group(0)
        print(k, lbl, tag[:160])
```

运行后把「品牌背景图」的 uuid 记入脚本常量 `BRAND_UUIDS = {…}`（预期：封面/结语背景画、logo、tpl-bg-950 用图；对照记忆线索 image20.jpg=天空山峰金色画）。

- [ ] **步骤 2：内容图替换为占位框**

在同一脚本追加：对每个非品牌 `<img>` 标签，保留其原 style 中的尺寸声明（`width/height/max-width/max-height/flex` 等），替换为占位 div：

```python
PLACEHOLDER = ('<div style="{size}display:flex;align-items:center;justify-content:center;'
    'background:#f2f2f4;border:1.5px dashed #c9c9cf;border-radius:10px;color:#8a8a92;'
    'font-size:17px;font-family:\'JetBrains Mono\',monospace;text-align:center;padding:12px;">'
    '图 · 占位<br>截图 width:100% 按列宽放大 / 矢量图填满高框</div>')

def img_to_placeholder(tag):
    st = re.search(r'style="([^"]*)"', tag)
    size = ''
    if st:
        for decl in st.group(1).split(';'):
            if re.match(r'\s*(width|height|max-width|max-height|min-width|min-height|flex|margin|object-fit)\s*:', decl):
                if 'object-fit' in decl: continue
                size += decl.strip() + ';'
    return PLACEHOLDER.format(size=size)

count = 0
def repl(m):
    global count
    tag = m.group(0)
    if any(u in tag for u in BRAND_UUIDS): return tag
    count += 1
    return img_to_placeholder(tag)
s = re.sub(r'<img\b[^>]*>', repl, s)
print('replaced imgs:', count)
```

- [ ] **步骤 3：口号占位**

主 deck 封面与结语页各有一处口号 `专业精深　攻坚克难　首战用我　用我必胜`（U+3000 全角空格分隔）。替换：

```python
old = '专业精深　攻坚克难　首战用我　用我必胜'
new = '在此替换口号　八字四段　全角空格分隔　详见branding'
n = s.count(old); assert n == 2, n
s = s.replace(old, new)
```

- [ ] **步骤 4：保存 + verify + 截图抽查**

`eb.set_template/save/verify` 后，跑 measure_overflow（临时旧脚本）对含图页：`版式·左图右文 版式·对比两栏 版式·表格混排 版式·截图对照 研讨页`，预期全部 Y=0（占位框继承了原尺寸声明，若某页溢出→缩小该占位框的 height/max-height 再验）。

- [ ] **步骤 5：checkpoint** `cp … "$SCRATCH/_ckpt_task2_imgs.html"`

---

### 任务 3：manifest 清理（体积 24MB → 目标 ≤10MB）

**文件：**
- 修改：`class-1/huawei-deck/assets/template-deck.html`
- 创建：`$SCRATCH/tpl_task3_prune.py`

清理规则：**保留 template 字符串中仍被引用的每一个 uuid**（含运行时 `<script src=uuid>`、字体/CSS `url(uuid)`、品牌图、金框背景），删除其余 manifest 条目。全自动、无需人工分类——被删页与被占位的课程截图自然失去引用。

- [ ] **步骤 1：写清理脚本**

```python
import json, re
lines = eb.load(DST)
s = eb.get_template(lines)
mi = None
for i, ln in enumerate(lines):
    if ln.strip() == '<script type="__bundler/manifest">': mi = i + 1; break
man = json.loads(lines[mi].strip())
used = {u for u in man if u in s}          # template 里出现即保留
dropped = [u for u in man if u not in used]
man2 = {u: man[u] for u in used}
lead = lines[mi][:len(lines[mi]) - len(lines[mi].lstrip())]
lines[mi] = lead + json.dumps(man2, ensure_ascii=False, separators=(',', ':'))
print('kept %d, dropped %d entries' % (len(man2), len(dropped)))
# 双向对账：template 里引用的 32hex uuid 必须都在 manifest
refs = set(re.findall(r'["\'(]([0-9a-f-]{32,36})["\')]', s))
missing = [r for r in refs if r in man and r not in man2]
assert not missing, missing
eb.save(DST, lines)
eb.verify(DST)
```

- [ ] **步骤 2：运行，记录体积**

运行：`python3 "$SCRATCH/tpl_task3_prune.py"`；然后 `ls -lh huawei-deck/assets/template-deck.html`。
预期：体积明显下降（剩字体 + React + 品牌图 + 运行时，约 5-10MB）。若仍 >10MB，打印 man2 各条目大小排序，检查是否有漏占位的大图（回任务 2 补），**不删字体/React/品牌图**。

- [ ] **步骤 3：断网可开验证**

`node` 起 headless Chrome 打开（file:// 本身不走网），确认控制台无 unpkg/CDN 报错、23 页渲染齐全（`document.querySelectorAll('.stage .slide-canvas').length === 23`）、loading overlay 出现后消失。可临时用 scratchpad 里任一 mjs 改造，或前置到任务 6 的 shot.mjs 完成后再补验——但**本任务结束前必须跑过一次**。

- [ ] **步骤 4：checkpoint** `cp … "$SCRATCH/_ckpt_task3_pruned.html"`

---

### 任务 4：文字占位化（逐批，每批截图验证）

**文件：**
- 修改：`class-1/huawei-deck/assets/template-deck.html`
- 创建：`$SCRATCH/tpl_task4_batch{1..5}.py`（每批一个脚本，section 切片字符串手术）

**总规则（每批相同）：**
- 只改「给学生读的散文」：h3 标题、intro、卡片标题/正文、要点、题干/选项/答案、caption。**不动**：eyebrow 结构（改文字为 `X.X · 页型名 / TYPE`）、所有 `class`/`data-*` 属性、style、SVG 图形结构、表格结构。
- 占位文案 = **教学式**：写「这里该写什么 + 关键规格」，长度与原文同量级（防版式抖动）。示例：
  - h3 → `一句话说清本页主张（46px）`
  - intro → `一行引导语：先抛结论再展开，散文最小 21px，点睛结论可用蓝色加粗。`
  - 卡片 → 标题 `要点标题` / 正文 `一到两行支撑句，写满约同原文长度以保持卡片高度稳定。`
  - 带 build 的元素，文案末尾标注节拍：`（第 2 拍出现 · data-step="1"）`
- 手术方式：按 section 切片定位（`secs=[m.start() for m in re.finditer(r'<section\b', s)]`，`seg = s[secs[k]:secs[k+1]]`），在 seg 内 `old→new` 替换并 `assert seg.count(old)==1`，回拼。**不用 DOM 工具**（浏览器会归一化 style）。
- 每批完成：`eb.verify` + 对该批每页截图目检（任务 6 的 shot.mjs 已在此前可用——见任务顺序说明）+ measure_overflow 该批全页 Y=0。

> **任务顺序说明：任务 6（脚本工具）先做 verify 三件套（6.1-6.3），再回来做任务 4/5。** 执行顺序：任务 1→2→3→6.1-6.3→4→5→6.4-6.6→7→8。计划按交付物编号，此处显式给出执行序。

- [ ] **步骤 1：批 1 门面（页 0-4：封面/目录/议程页/章扉页/问题页）**
  - 封面：主标题→`课程主标题（占位）`，副题→`副标题 · 一行说明`，讲师/日期→`主讲人 · 日期（占位）`；口号已在任务 2 占位。
  - 目录：4 个章名→`01 · 第一章名（占位）`…；保持条目数=4（与源一致，使用者自行增删）。
  - 议程页：各时段条目→`环节名 · N MIN`。
  - 章扉页：章号水印保留，章名→`章名（占位）· SECTION 01`。
  - 问题页：问题文字→`用一个真问题开场：问题要具体、可讨论，不给答案。`
  - 运行 + 截图 5 页 + overflow 验证。
- [ ] **步骤 2：批 2 版式（页 5-13）**：9 页逐页占位化；每页 eyebrow 改 `2.X · 版式名 / LAYOUT`；带 build 页标注节拍。截图 9 页 + overflow。
- [ ] **步骤 3：批 3 动画机制（页 14-17）**：占位文案改为**机制讲解**——build 页各拍元素写 `data-step="N"：第 N+1 拍`；layer 页按钮写 `标签A/B/C/D（data-layer-btn）`、面板写 `面板内容（data-layer-panel 同 key 同 group）`；混合链页标注 layer 与 build 如何共享 level；SMIL 页保留全部 `<animate>`、仅改旁白散文。截图 + **steps.mjs 逐拍截图**（此时已可用）核对每拍出现的元素正确。
- [ ] **步骤 4：批 4 深色与黑板（页 18-20）**：金句→`一句有力的金句（占位）`；两种题卡（题卡A=选择/填空混排卡风、题卡B=950 重编卡风）：题干→`题干（占位）：填空/选择题写法见此卡结构`，选项/答案占位；金框页改后跑 clearance 检查（`section.bottom − 最后卡.bottom ≥ 50`，用临时 evaluate 脚本，参考 PROGRESS 07-05「clr6162」判据）。截图 + overflow。
- [ ] **步骤 5：批 5 收尾（页 21-22）**：研讨条目→`研讨题 N：开放式、无标准答案（占位）`；结语页为纯 Thanks 页（无动画），谢辞→占位。截图 + overflow。
- [ ] **步骤 6：全 23 页 measure_overflow 扫一遍**，预期全部 `section overflow Y=0 X=0`；`cp … "$SCRATCH/_ckpt_task4_placeholder.html"`。

---

### 任务 5：品牌可替换点（apply_bg.py + branding.md）

**文件：**
- 创建：`class-1/huawei-deck/scripts/apply_bg.py`
- 创建：`class-1/huawei-deck/references/branding.md`
- 参考（只读）：`dc-slide-deck/apply_template_bg.py`

- [ ] **步骤 1：读 `dc-slide-deck/apply_template_bg.py`**，弄清它如何定位门面页背景并换图（记忆线索：template bg = image20.jpg，apply_template_bg.py restyles 门面页）。
- [ ] **步骤 2：改造为 `scripts/apply_bg.py`**：参数化 `apply_bg.py <deck.html> <new-bg.jpg>`——用 `eb.embed_image` 嵌新图进 manifest，把门面页（封面/章扉/结语/金框题卡的 `tpl-bg-950`）背景引用的旧 uuid 替换为新 uuid，旧条目从 manifest 删除。顶部 docstring 写用法。脚本内 edit-bundle 以**相对本文件路径**加载（`os.path.join(os.path.dirname(__file__), 'edit-bundle.py')`——任务 6 会把 edit-bundle.py 复制进 scripts/）。
- [ ] **步骤 3：写 `references/branding.md`**，内容（全部为已核实事实，写文件时带上任务 2 步骤 1 盘点出的实际 uuid/selector）：
  - 三个可替换点清单：① 封面/结语金色背景画（uuid、所在 selector）；② HUAWEI logo 水印（元素位置、如何换成自己 logo：`eb.embed_image` + 改 src）；③ 口号（占位文案原文、U+3000 分隔约定、出现在封面+结语 2 处）。
  - 换背景画：`python3 scripts/apply_bg.py 我的.html 新背景.jpg`。
  - 品牌色变更指引：红 `#b5333b` 在 deck 内出现于内联 style 与 CSS 规则，整体换色 = 对 template 字符串做色值映射表替换（列出 `#b5333b/#cf6b72/#e0a3a7` 三个色值），并提醒**真警示红与品牌红同值，换色即全换**。
- [ ] **步骤 4：在模板 deck 副本上实测 apply_bg.py**（用 `素材/图片/` 任一 jpg），headless 截图封面确认背景已换、无 manifest 悬空；**实测后丢弃副本**，模板 deck 保持原金色背景。checkpoint。

---

### 任务 6：scripts/ 工具集（verify 三件套 + edit-bundle + html2pptx + React 备件）

**文件：**
- 创建：`scripts/verify/measure_overflow.mjs`、`scripts/verify/shot.mjs`、`scripts/verify/steps.mjs`
- 复制：`scripts/edit-bundle.py`、`scripts/react.umd.js`、`scripts/react-dom.umd.js`、`scripts/html2pptx/*`

> 执行序提醒：6.1-6.3（verify 三件套）在任务 4 之前做。

- [ ] **步骤 6.1：measure_overflow.mjs** —— 复制 `$ROOT/scratchpad/measure_overflow.mjs`，三处修改：① 首行 import 改 `const PW = process.env.PLAYWRIGHT_CORE || '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.js'; const { chromium } = (await import(PW)).default;`；② 第 10 行等待条件 `length > 60` 改为 `length > 0`，且 waitForTimeout 6000→4000；③ 支持 `--all`：不传 label 时 `page.evaluate` 收集全部 `section[data-label]` 逐页量。验证：对模板 deck 跑 `--all`，输出 24 页结果。
- [ ] **步骤 6.2：shot.mjs**（新写，~40 行）：`node shot.mjs <deck.html> <label> <out.jpg>`——同 measure_overflow 的加载与 UI 隐藏逻辑，找到含该 label 的 `.slide-canvas`，`position:fixed` 钉到 1920×1080 视口后 `page.screenshot`。build 元素强制 `opacity:1`。验证：给「封面」截一张，肉眼确认。
- [ ] **步骤 6.3：steps.mjs**（新写，~60 行）：`node steps.mjs <deck.html> <label> <outdir>` 放映态逐拍截图。核心：钉页后模拟引擎——收集页内 `[data-step]` 的 max，`for L in 0..max+1`：`.build` 按 `data-step < L` toggle `data-shown`；layer 按钮组按「active = data-step<L 的最大按钮，否则第一个」toggle `data-active`（btn 与同 key panel 同步）；每 L 截一张 `step-L.jpg`。（引擎规则来源：dc-slide-deck/SKILL.md 第二节。）验证：对「动画·layer切换」跑，逐拍图与预期一致。
- [ ] **步骤 6.4：复制其余工具**

```bash
cd "$ROOT"
cp dc-slide-deck/edit-bundle.py huawei-deck/scripts/
cp dc-slide-deck/react.umd.js dc-slide-deck/react-dom.umd.js huawei-deck/scripts/
cp dc-slide-deck/html2pptx/convert.sh dc-slide-deck/html2pptx/build_pptx.py huawei-deck/scripts/html2pptx/
cp dc-slide-deck/html2pptx/shoot.mjs huawei-deck/scripts/html2pptx/
chmod +x huawei-deck/scripts/html2pptx/convert.sh
```

- [ ] **步骤 6.5：shoot.mjs 去机器绑定** —— 第 8 行 import 改成与 6.1 相同的 `PLAYWRIGHT_CORE` env 方式（convert.sh/build_pptx.py 无绝对路径，无需改）。
- [ ] **步骤 6.6：html2pptx 全流程实测** —— `huawei-deck/scripts/html2pptx/convert.sh huawei-deck/assets/template-deck.html "$SCRATCH/template-deck.pptx"`。预期：23 页 deck 出 ≥30 张（「动画·layer切换」4 标签 +3、「动画·混合链」5 标签 +4；精确张数以 shoot.mjs 输出为准并记录到 editing-guide.md）；打开 pptx 抽查 layer 展开页齐全、build 页全显。

---

### 任务 7：出厂验证（六项全过才算模板 deck 完成）

**文件：** 无新建（全部用已建工具）；产出验证记录追加到 `$SCRATCH/factory_check.md`

- [ ] **步骤 1：完整性** —— `python3 huawei-deck/scripts/edit-bundle.py huawei-deck/assets/template-deck.html`：slide-fit=sections=nav=23、i: 连续、chapters 5 条 start={1,5,14,18,21}。
- [ ] **步骤 2：版式** —— `measure_overflow.mjs --all`：23 页 Y=0 X=0；输出中的 nested clips 逐条核对均为图占位框/装饰容器而非文字截断。
- [ ] **步骤 3：动画逐拍** —— 对全部带动画页（选定表中 build/layer/SMIL 非零的 ~14 页）跑 `steps.mjs`，逐拍目检：无提前露出的空框（「外层背景框必须挂 build」铁律）、layer 推进顺序正确、回退无残留。SMIL 页截 2 个时刻确认在动。**另加背景抽查**：tpl-bg-950 相关 7 页截图确认门面画/金框/人像在。
- [ ] **步骤 4：易用性** —— headless 实测：① 加载 overlay 出现→消失；② 刷新恢复：evaluate 跳到第 10 页→reload→`JSON.parse(localStorage.deck_pos).i === 10` 且视口回到该页（参考 PROGRESS 07-06 `test_restore.mjs` 做法）；③ 控制台无网络请求报错（真离线）。
- [ ] **步骤 5：PPTX** —— 任务 6.6 已跑；确认输出张数与 manifest.json 一致、文件可开。
- [ ] **步骤 6：体积与开速** —— 记录最终 MB 数与 headless load 秒数，写进 SKILL.md「预期性能」一句话。全过 → `cp … "$SCRATCH/_ckpt_task7_factory_ok.html"`。

---

### 任务 8：文档（SKILL.md + references 五份）

**文件：**
- 创建：`huawei-deck/SKILL.md`
- 创建：`references/template-pages.md`、`design-system.md`、`page-snippets.md`、`animation.md`、`editing-guide.md`
- 来源（只读提炼，面向零上下文新用户改写措辞，删除课程项目专有名词）：`class-1/DESIGN.md`、`dc-slide-deck/SKILL.md`、`dc-slide-deck/page-templates.md`、`dc-slide-deck/html2pptx/README.md`

- [ ] **步骤 1：`references/template-pages.md`** —— 24 页逐页条目，每条固定四栏：**页型名（data-label）/ 长什么样（一句话）/ 常用于 / 怎么改**（哪些是占位文案、动画节拍怎么调、复制此页做多页的 edit-bundle 一行命令）。按 5 个模板章分节。以本计划「模板页选定表」+ 任务 4 各批实际占位内容为准编写。
- [ ] **步骤 2：`references/design-system.md`** —— 提炼 DESIGN.md 一~三、七、八节：三色体系表（红/灰蓝/中性 + 米色框 + 深底）、两字体铁律（中文绝不只挂 JetBrains Mono）、字号刻度 `{13,15,17,19,21,24,27,30}` + 散文地板 21px + 图元豁免判别法（带 line-height=散文）、每页四段结构（eyebrow/h3/intro/主体）、审美硬要求 4 条、1080 溢出验证法。
- [ ] **步骤 3：`references/animation.md`** —— 提炼 DESIGN.md 四节 + dc SKILL.md 二节：总原则（手动推进、无自动循环、不写操作提示）；build/layer/SMIL 三机制完整写法与属性表；「外层背景框也要挂 build」「勿用 :has() 控 opacity」「SVG transform 放非 build 外层 g」三条铁律；放映键位（点击空白/空格/→ 前进、← 回退）；验证用 `scripts/verify/steps.mjs`。
- [ ] **步骤 4：`references/page-snippets.md`** —— 以 `dc-slide-deck/page-templates.md` 为底，逐片段核对与模板 deck 实页一致后收录，并补齐模板 deck 有而片段库缺的页型（对照 template-pages.md，至少补：议程、研讨、金框题卡、SMIL 图解骨架）。
- [ ] **步骤 5：`references/editing-guide.md`** —— 提炼 dc SKILL.md 三~六节 + html2pptx/README：独立版结构与安全编码铁律；edit-bundle.py 典型用法（insert/delete/move/embed_image/verify 各一段可复制代码）；三处同步铁律；踩坑表（照搬 dc SKILL.md 五节表格）；验证清单（overflow/steps/截图）；html2pptx 用法 + layer 展开语义 + 已知例外（React 内部 state 页不可展开）；性能守则（不删内联 React、iframe lazy、不在 rAF 读布局）。
- [ ] **步骤 6：`SKILL.md`** —— frontmatter：`name: huawei-deck`；`description: Use when creating a new Huawei-red-brand 1920×1080 single-file HTML slide deck from the bundled template (华为风红色品牌网页 PPT), editing such a deck (pages/animations/branding), or converting it to PPTX via the bundled html2pptx — template gallery, click/arrow-key present mode, offline single file.`（措辞与 dc-slide-deck 区分：本 skill 管「从模板新建」，dc 管「维护训练Infra课程」。）正文 ≤120 行：① 这是什么（一段）；② 快速上手 5 步工作流（cp 模板→照 template-pages.md 改页→增删页用 edit-bundle→verify 工具→convert.sh）；③ 设计铁律 6 条摘要（各一行，指向 references 细读）；④ 文件导航表；⑤ 预期性能一句话（体积/首开秒数，任务 7 实测值）。
- [ ] **步骤 7：文档自检** —— 逐份检查：无课程专有名词残留（「训练Infra」「950PR」等只允许出现在示例注释里）、所有相对路径真实存在、代码段可直接复制运行。

---

### 任务 9：安装与端到端用户流测试

- [ ] **步骤 1：安装** —— `cp -R "$ROOT/huawei-deck" ~/.claude/skills/huawei-deck`。
- [ ] **步骤 2：模拟新用户全流程**（在 `$SCRATCH/e2e/` 下，全程只用 skill 内文件与文档所写命令）：
  1. `cp ~/.claude/skills/huawei-deck/assets/template-deck.html demo.html`
  2. 照 template-pages.md 改「版式·卡片网格」页一张卡的占位文字（Python section 切片）。
  3. 用 `scripts/edit-bundle.py` 的 `delete_page` 删「版式·截图对照」页 → verify 通过（22 页、chapters start 正确 -1）。
  4. `measure_overflow.mjs --all` 全 Y=0；`steps.mjs` 验改过的页动画未破。
  5. `convert.sh demo.html` 出 pptx，张数正确。
- [ ] **步骤 3：收尾** —— e2e 产物留在 `$SCRATCH`；向用户报告：skill 位置（项目内 + ~/.claude/skills）、模板 deck 页数/体积、验证结论、分发方式（打包 huawei-deck/ 目录）。

---

## 自检记录

- **规格覆盖度**：规格 §2 目录结构→任务 1/5/6/8；§3 产出规则 1-6→任务 1(盘点表已定)/2/3/4/5；§4 html2pptx→任务 6.4-6.6；§5 六项验证→任务 7（+任务 9 步骤 2 的安装测试=规格验证第 6 项）；§6 风险（记账→每任务 verify、manifest 悬空→任务 3 双向对账、占位破版式→同量级文案+每批 overflow、描述撞车→任务 8 步骤 6）。无遗漏。
- **占位符扫描**：无「待定/TODO」；文档任务给出每份文件的成文来源与固定结构；任务 2 的 BRAND_UUIDS 需运行时盘点确定，已给出盘点步骤与判定标准，不属悬空。
- **一致性**：`eb.*` 函数名与 edit-bundle.py 实文件一致（load/get_template/set_template/save/verify/embed_image/delete_page）；chapters start 值 {1,5,14,18,21} 与 23 页选定表页序一致；执行序（1→2→3→6.1-6.3→4→5→6.4-6.6→7→8→9）在任务 4 与 6 处双向标注。
