# editing-guide.md — 独立版结构、edit-bundle.py 用法与验证工作流

deck 是一个「独立版」单文件 HTML：React 运行时、字体、全部图片都内联在文件里，真离线可用。代价是**不能用普通文本编辑器直接改 bundle 那两行超长 JSON**——结构编辑要经 `scripts/edit-bundle.py`，结构稳定后的细节修改也可以使用本文的后期可视化编辑器。所有命令均在 skill 根目录（`huawei-deck/`）执行，示例均假设你在工作副本上操作（**改前先备份**）。

## 0. 后期可视化微调

### 0.1 什么时候使用

可视化编辑器用于制作后期：页面结构和顺序已经确认，只剩精确位置、字号观感、短文案与跨页修改清单。新建 deck、批量替换、增删页或大范围结构重构仍由外部 Agent 经 `scripts/edit-bundle.py` 完成。

先体检依赖，再启动浏览器工作台：

```bash
python3 scripts/check_deps.py
python3 scripts/deck-editor.py <deck.html>

# 真实项目示例
python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
```

启动器只接受 `deck`、`--host`、`--port`、`--no-open`；不要把测试内部的 `--keep-temp` 当作用户参数。默认监听 `127.0.0.1` 并自动打开浏览器。服务终端会输出一行 JSON，其中的 `url` 与 `token` 供外部 Agent 连接。

### 0.2 五种模式

五种模式依次为：预览、区域标记、文字、移动、缩放。

| 模式 | 使用方式 | 结果 |
|---|---|---|
| 预览 | 浏览、切页，不拦截 deck 原有交互 | 不产生动作 |
| 区域标记 | 在 1920×1080 页面上区域拉框，在选区旁侧输入修改说明 | 创建带归一化区域、候选 locator 和可选 PNG 快照的任务 |
| 文字 | 双击简单叶子文字，`Cmd/Ctrl+Enter` 提交，`Escape` 取消 | 创建 `setText` 动作组；复杂富文本会提示改用区域标记 |
| 移动 | 拖动可定位元素 | 创建 `translate` 动作组 |
| 缩放 | 选择元素并拖动右下控制点 | 普通元素记录宽高，SVG / 交互组件等记录 scale |

区域任务可以跨页连续添加；左侧页缩略图显示任务数，右下角 Agent 任务 drawer 汇总全部任务，可定位回原页和原区域。直接文字、移动、缩放与 Agent 动作进入同一 `PatchJournal`，因此共享 revision 和动作组语义。

### 0.3 外部 Agent 协作与撤销 / 重做

外部 Codex / Claude Code / Agent 通过本地 CLI、HTTP 或 capability WebSocket 读取任务并提交动作；这不是内置聊天机器人。drawer 的“交给 Agent 处理全部”只显示命令提示，不会假装已调用外部系统。

```bash
# 用启动器输出的真实值替换下面两项
EDITOR_URL=http://127.0.0.1:12345
EDITOR_TOKEN=启动器输出的token
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" status
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" tasks
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" task TASK_ID
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" apply actions.json
node scripts/editor/cli.mjs --url "$EDITOR_URL" --token "$EDITOR_TOKEN" undo GROUP_ID
```

`apply` 的动作类型限于 `setText`、`setStyle`、`translate`、`resize`、`hide`、`show`，并必须带当前 `expectedRevision`（传数组时 CLI 会先读取 revision）。drawer 在任务已有动作组时提供“撤销”；CLI 第一版也只暴露 `undo`。完整重做由本地接口 `POST /api/groups/<GROUP_ID>/redo` 执行，仍要携带当前 `expectedRevision`。撤销 / 重做都会让浏览器按权威动作集合重放，不是单纯反改 DOM。

### 0.4 保存会话不等于正式写回

预览、区域标记和自动会话保存不触碰原始 source deck。浏览器中的直接编辑先作用于运行时，并把任务和动作自动持久化到 deck 同目录的 `.huawei-deck-editor/`：其中保存会话、任务、快照、动作、诊断与备份。该目录不进入最终交付 deck；本仓库已在 `.gitignore` 忽略提交，若 deck 位于其他仓库，也应加入同名规则。

保存会话不同于正式写回：关闭服务后 session 可以重开，预览与自动保存期间正式 HTML 字节保持不变。推荐策略是始终选工作副本启动编辑器；模板与唯一原稿保持只读，验收后再交付写回后的工作副本。

正式写回只能由用户明确触发。当前第一版没有内置写回按钮或 CLI `write` 子命令；用户确认后，外部 Agent 读取 `/api/session` 的 revision，再调用本地 `POST /api/write-deck`。三重闸门依次检查：

1. **editor online**：浏览器 frame 与协作桥在线且诊断已就绪，否则 `EDITOR_OFFLINE`；
2. **文件指纹**：磁盘 deck 仍与 session 基线一致，否则 `DECK_CHANGED`；
3. **验证闸门**：修改页相对基线无新增溢出，随后候选 bundle 通过 `eb.verify`。

通过闸门后，writer 才调用 `scripts/edit-bundle.py` 在系统临时目录生成候选内容：先保留原文件备份，再写同目录临时文件，复查文件指纹，落盘 transaction record，最后用 `os.replace` 原子替换。会话基线更新失败时会尝试从备份恢复；冲突或验证失败不静默覆盖。

### 0.5 写回后的验证

```bash
python3 scripts/edit-bundle.py <deck.html>                         # bundle 结构；等价 eb.verify
node scripts/verify/measure_overflow.mjs <deck.html> --all        # 全页溢出
node scripts/verify/shot.mjs <deck.html> <页label> /tmp/page.jpg  # 改动页 1920×1080 截图
node scripts/verify/steps.mjs <deck.html> <页label> /tmp/steps    # 仅修改动画页时逐拍核对
```

`shot.mjs` 会让 build 全显并输出 1920×1080 逻辑画布截图；`steps.mjs` 按放映规则逐拍输出同尺寸截图。没有 build / layer 的页面运行 `steps.mjs` 也会生成起始帧和结束帧，但通常只需在修改动画页时使用。

### 0.6 错误恢复与第一版边界

| 错误 | 含义 | 处理 |
|---|---|---|
| `DECK_CHANGED` | source deck 被外部进程改动，文件指纹不再匹配 | 停止写回，重载外部版本并重放动作，或另存副本 |
| `NEW_OVERFLOW` | 当前动作相对启动诊断基线引入新 section / nested clip | 撤销或调整对应动作，再次写回 |
| `EDITOR_OFFLINE` | frame 未连接、未 ready，或诊断超时 | 保持 session，重开 / 重连浏览器后重试 |
| `RECOVERY_REQUIRED` | durable transaction 处于未决恢复状态 | 立即停止修改；重启服务，让磁盘与 session 收敛后再写回 |
| `TARGET_NOT_FOUND` | 目标缺失，页面或 DOM 路径已变化 | 重载页面，重新选择目标并生成 locator |
| `TARGET_AMBIGUOUS` | 目标歧义，路径与指纹无法唯一匹配 | 缩小区域或由 Agent 选择更稳定的候选 locator |

所有 Agent 动作都受 token、revision、locator 与事务校验；frame 返回的 canonical action 还会与请求逐字段核对。冲突、目标缺失 / 歧义或验证失败都不会留下“看似成功”的静默覆盖。

第一版不增删页、不调整页序、不重构复杂动画、不内置聊天。需要这些结构能力时，回到本文第 3 节的 `scripts/edit-bundle.py` 工作流；可视化编辑器只保留已实现的细节编辑与任务桥能力。

## 1. 独立版结构：两行超长 JSON

文件里有两个关键 `<script>`，各自的**下一行**是一整行 JSON：

| 标记行 | 下一行内容 |
|---|---|
| `<script type="__bundler/manifest">` | 一行 JSON dict：`{uid: {mime, compressed, data(base64)}}`——全部图片 / 资源 |
| `<script type="__bundler/template">` | 一行 JSON **字符串**：整份 deck 的 HTML（含每页 `<section>`、导航数组、运行时脚本） |

改内容 = 解码 template 字符串 → 字符串手术 → 重编码回填。`scripts/edit-bundle.py` 封装了这一切。

## 2. 安全编码铁律

1. **改 template 必须经 `get_template` / `set_template` / `save`，绝不手拼、绝不用编辑器 / sed 直改那两行。** `set_template` 负责唯一正确的编码：`json.dumps(s, ensure_ascii=False).replace('</', '<\\u002F')`——只转义 `</`（防字符串里的 `</script>` 提前闭合文档），中文不转义、URL 里的普通 `/` 不动，并内置断言（回填串不含 `</`、不含换行、`json.loads` 后与原字符串相等）。直改几乎必然把整个文件弄坏。
2. **manifest 是一整行 JSON dict，手改容易截断**——嵌图用 `eb.embed_image`，换品牌图用 `scripts/apply_bg.py`（见 `branding.md`）。
3. 改结构（加 / 删 / 移页）必须**三处同步**：slide DOM、`nav[]` 数组、`chapters[].start`——`insert_page` / `delete_page` / `move_page` 已自动做完，别手动改其中一处。

## 3. edit-bundle.py 典型用法

### 3.1 加载（所有片段的公共开头）

```python
import importlib.util
spec = importlib.util.spec_from_file_location('eb', 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)

lines = eb.load('my-deck.html')     # 整个文件按行读入
s = eb.get_template(lines)          # 解码出 deck HTML 字符串
```

### 3.2 改文字 = section 切片手术

**改前先看目标文本**——先把该页 section 片段打出来（去掉标签更好读），确认要替换的占位文案原文一字不差，再做替换：

```python
import re
i = s.find('<section data-label="版式·流程条"'); j = s.find('</section>', i)
print(re.sub(r'<[^>]+>', ' ', s[i:j])[:1500])   # 去标签打印该页文本，核对占位原文
```

然后把手术范围收窄到目标页的 `<section>`，在片内替换，避免误伤其他页的同词：

```python
i = s.find('<section data-label="版式·流程条"')
j = s.find('</section>', i) + len('</section>')
blk = s[i:j]

OLD, NEW = '页面标题 = 一句话概括流程', '数据准备四步走'
assert blk.count(OLD) == 1, '目标文本应恰有 1 处，实际 %d' % blk.count(OLD)
s = s[:i] + blk.replace(OLD, NEW) + s[j:]

eb.set_template(lines, s)
eb.save('my-deck.html', lines)
eb.verify('my-deck.html')
```

替换前 `assert count == 1`（或预期处数）是习惯动作——0 处说明找错了，多处说明会误伤。

### 3.3 加 / 删 / 移页（自动三处同步）

```python
# 复制章扉页为第二章扉页，插到「问题页」之前
i = s.find('<section data-label="章扉页"')
st = s.rfind('<div class="slide-fit"', 0, i)
end = s.find('</div></div>', s.find('</section>', i)) + len('</div></div>')
new_block = s[st:end].replace('data-label="章扉页"', 'data-label="章扉页2"')
s = eb.insert_page(s, new_block, before_label='问题页', nav_code='章2', nav_label='章扉页2')

# 门面页型的背景由 <style id="tpl-bg-950"> 按 data-label 精确匹配，新 label 要补选择器：
OLD_SEL = 'section[data-label="章扉页"],'
assert s.count(OLD_SEL) == 1
s = s.replace(OLD_SEL, 'section[data-label="章扉页"], section[data-label="章扉页2"],')

# 删页 / 同章内移页
s = eb.delete_page(s, '版式·动手实验')                        # 按 data-label 删
s = eb.move_page(s, '版式·流程条', after_label='版式·对比两栏')  # 同章内移到某页之后

eb.set_template(lines, s); eb.save('my-deck.html', lines); eb.verify('my-deck.html')
```

`new_block` 必须是完整的 `<div class="slide-fit"...>…</div></div>` 块；`nav_code` 是导航条上显示的短码（模板里多为两字，如「章扉」「对比」），`nav_label` 必须与页面 data-label 完全一致（增删移页都靠它对上号）。

- **插入的章归属约定**：插到某章**首页之前** = 新页成为该章新首页（该章 start 不动）；插到章中 / 章尾页之前 = 新页归入该章，下一章起 start 全部 +1。
- **删除的对应规则**：删页后，被删页所在章**之后**各章 start 自动 −1（本章 start 不变）。
- ⚠ **`move_page` 只在同章内移动是安全的**（chapters 不需要变，它也不会去调整）；跨章移动后 `chapters.start` 不会自动修正，需按 3.5 节手工修。
- 插删页后都跑一下 `verify`，看打印出的 `chapters` start 是否符合预期。

### 3.4 嵌入图片

```python
uid = eb.embed_image(lines, '你的图.png', mime='image/png', prefix='img')  # 写入 manifest，返回 uid
s = s.replace('src="旧图uid或占位"', 'src="%s"' % uid)                     # template 里用 uid 引用
eb.set_template(lines, s); eb.save('my-deck.html', lines)
```

jpg 用 `mime='image/jpeg'`。大图先压缩（1MB 内为宜），deck 体积直接跟着涨。替换四类品牌图（背景画 / 黑板 / 人像 / logo）不用手写这些——`apply_bg.py` 全自动（含旧条目清理），见 `branding.md`。

### 3.5 结构验证与 chapters 手工修正

```bash
python3 scripts/edit-bundle.py my-deck.html
```

打印 slide-fit / section / nav 三者数量与章节起点，`nav` 编号不连续会直接 assert 失败——每次保存后都跑一下。

若 `chapters` 的 start 与预期不符（例如做了跨章 `move_page`），用 `bump_chapters` 助手手工修正后再验：

```python
s = eb.bump_chapters(s, +1, 13)   # 把 start > 13 的所有章起点 +1（delta 可为负）
eb.set_template(lines, s); eb.save('my-deck.html', lines); eb.verify('my-deck.html')
```

## 4. 同名 data-label 警告

`data-label` 是所有工具定位页面的唯一手段。deck 里出现同名 label 时：**verify 三件套会打印警告并只处理第一个**；而 **edit-bundle 的定位函数（insert/delete/move、切片手术的 `find`）同样只取第一个、且不打印任何警告**——插删改之前先确认目标 label 唯一（`s.count('<section data-label="某页"') == 1`）。复制页面务必改成新名字；万一已有同名页，`measure_overflow.mjs --all` 是唯一能把同名页各测各的模式（显示为 `label #2`）。

## 5. 踩坑表

| 症状 | 根因 / 修法 |
|---|---|
| 整页灰屏 / 加载死循环 | `data-idx` 必须是**数字**（如 `"45b"` 直接灰屏）。它是装饰性的，可重复，但必须是数字。 |
| 中文显示成细体、看不清 | 该元素只挂了 `JetBrains Mono`（无中文字形，回退细体）。中文一律 `'Noto Sans SC'`，要粗用 `font-weight:700`。 |
| 点按钮 / 链接报 React #231（onClick 是字符串） | 写了内联 `onclick="fn()"`——运行时会把它当 React 的 `onClick` 字符串。**别用内联 on\***，用事件委托：`document.addEventListener('click', e => { const t = e.target.closest('.你的class'); if (!t) return; /* 处理 */ }, true)`（capture + `stopPropagation`）。模板的复制链接、bilibili 播放器都是这么实现的，可直接复用。 |
| 改完后整个文件打不开 / JSON 报错 | 没走 `set_template` 的编码铁律（第 2 节），`</script>` 提前闭合或转义损坏。从备份恢复，重做并只经 edit-bundle。 |
| 加页后导航乱 / 某页掉出章节 | 三处同步没做全。用 `insert_page` / `delete_page` / `move_page`，并用 `verify` 检查 `nav` 连续、`chapters.start` 正确。手插 HTML 块时还要注意 `</div>` 配平。 |
| 改了章数后，目录页选中某章左侧空白 / 动画内容跑题 | 目录页左侧动画按章节索引取自 `const builders = [...]` 数组，且各动画文案是模板课程主题。增删章后同步 builders 数组并替换动画内文字，见 `template-pages.md` 目录页一节。 |

放映态动画的坑（`:has()`、SVG transform、外层框漏挂 build）见 `animation.md` 第 5 节。

## 6. 验证工作流（改完一批必做）

```bash
node scripts/verify/measure_overflow.mjs my-deck.html --all          # 1) 全页溢出检测
node scripts/verify/shot.mjs my-deck.html 版式·流程条 /tmp/p.jpg      # 2) 改过的页截图目检
node scripts/verify/steps.mjs my-deck.html 版式·流程条 /tmp/steps     # 3) 动过动画的页逐拍核对
```

- **退出码契约（三个脚本一致）**：`0` = 通过 / 成功；`1` = 检出问题（存在溢出 / label 不存在）；`2` = 工具或参数错误（浏览器起不来、参数缺失）。可以直接接进 CI / 脚本判断。
- `measure_overflow` 不传 label 等价 `--all`；报告分两层——section 级溢出（Y/X 像素，>0 即失败）和内层 `overflow:hidden` 裁切（只报告不判失败，逐条截图目检）。
- 已知基线：模板出厂时「版式·左图右文」页自带 3 处 nested clip（图占位框裁切自身的提示文字，+38px）——属预期表现，不是问题，换成真图后自然消失。
- 依赖：Node ≥ 18、本机安装 Google Chrome、playwright-core。**playwright-core 按三级顺序查找**：环境变量 `PLAYWRIGHT_CORE`（指向其 index.js）→ 裸 `import('playwright-core')`（在 skill 根目录 `npm i playwright-core` 即可满足）→ openclaw 全局安装的内置路径。都找不到时脚本会以退出码 2 报错并给出提示。
- 首次加载等待较长是正常的（脚本内置了等待 React mount 的 settle 时间）。

## 7. 导出 PPTX（html2pptx）

```bash
bash scripts/html2pptx/convert.sh my-deck.html            # 输出同名 my-deck.pptx
bash scripts/html2pptx/convert.sh my-deck.html 出货版.pptx  # 指定输出名
SCALE=2 QUALITY=92 bash scripts/html2pptx/convert.sh my-deck.html   # 清晰度 / 压缩（即默认值）
EMBED_HTML=1 bash scripts/html2pptx/convert.sh my-deck.html         # 第一页嵌原始 HTML（OLE，Windows PowerPoint 可双击打开；体积会明显增大）
```

- 原理：headless Chrome 逐页截图（自动隐藏导航条等 UI 外壳、`.build` 全显），python-pptx 组装成 16:9、每页一张满屏图。工具不解析打包结构——渲染什么截什么，改完课件**直接重跑**即可。
- **layer 页自动展开**：带 `[data-layer-btn]` 的页会逐标签各截一张、按顺序全部进 PPTX（一页 N 个标签 → N 张）；一页有多个 layer 组时逐组展开、其余组停在首标签，全默认态只截一张不重复（共 ΣN − (组数 − 1) 张）。所以模板 34 页导出为 **55 张**（`动画·layer切换` 4 张、`动画·混合链` 5 张、`动画·多组切换` 2 组共 5 张、`SFT vs LoRA` 6 张、`找问题·六层级` 6 张）。实测约 47 秒、22MB。
- 已知限制：靠 React 内部 state 切换的自制交互页无法程序化展开，只能截到默认状态（模板自带页没有这种页；自己加页时若做了这类交互，导出前心里有数）。
- 依赖：Node + Chrome + playwright-core（同第 6 节三级查找）、`python3 -m pip install python-pptx`。

## 8. 性能守则

- **别删内联的 React / 字体**。运行时默认从 CDN 拉 React——正因模板把 react / react-dom UMD 内联在运行时脚本之前才真离线；删了它，断网 / 代理环境整页起不来。`scripts/react.umd.js` / `react-dom.umd.js` 是备件，误删后可用 `eb.inline_react(lines, 'scripts/react.umd.js', 'scripts/react-dom.umd.js')` 修复。
- iframe 一律 `loading="lazy"`；能重画成矢量 / HTML 的图别贴低清大截图。
- **大改用 Python 切片，别开编辑器**——那两行 JSON 每行数 MB，多数编辑器会卡死或悄悄截断。
- 参考基线：模板 12MB，headless Chrome 首开约 2.6 秒；桌面浏览器首次打开多等几秒属正常，不是卡死。用 `file://` 直开时控制台可能有 2 条 CORS 报错，良性，忽略即可。
