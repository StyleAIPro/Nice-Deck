# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

本仓库是一个 **Claude Code skill**（华为红品牌单文件 HTML 演示模板），不是普通应用代码库。交付物 = `SKILL.md`（skill 入口）+ `references/`（9 份使用文档）+ `scripts/`（编辑/验证/导出工具）+ `assets/` 下三套模板 deck（授课 34 页 / 技术分享 34 页 / 工作汇报 32 页，均为 ~12MB 离线单文件）。改动本仓库时，多数工作是维护这套文档与脚本的一致性；`docs/design/` 是本 skill 自身的设计规格与实现计划，仅供参考。

所有文档、注释、报错信息均为中文，新增内容保持中文。

## 常用命令

```bash
# verify 三件套（退出码契约：0 通过 / 1 检测到问题 / 2 工具或参数错误）
node scripts/verify/measure_overflow.mjs <deck.html> --all       # 全页溢出检测（也可只传若干 data-label）
node scripts/verify/shot.mjs <deck.html> <页label> /tmp/p.jpg     # 单页 1920×1080 截图（build 全显）
node scripts/verify/steps.mjs <deck.html> <页label> /tmp/steps    # 放映态动画逐拍截图

# HTML → PPTX（layer 多标签页自动逐标签展开；SCALE/QUALITY/EMBED_HTML 可调）
bash scripts/html2pptx/convert.sh <deck.html> [out.pptx]

# 品牌图替换（默认只打印预览，加 --yes 才落盘；target: bg|board|people|logo）
python3 scripts/apply_bg.py <deck.html> <new-image> --target bg --yes
```

依赖：Node ≥ 18 + 本机 Google Chrome + playwright-core（查找顺序：`PLAYWRIGHT_CORE` 环境变量 → `import('playwright-core')` → openclaw 内置路径）；PPTX 导出另需 `python3 -m pip install python-pptx`。edit-bundle.py 只用 Python 标准库。

没有测试框架、lint 或构建步骤——验证方式就是对 deck 跑 verify 三件套，以及 `eb.verify(path)` 的结构一致性检查。

## 核心架构：单文件 bundle 格式

deck HTML 是「独立版」bundle（约 187 行），关键在两个 `<script>`：

- `<script type="__bundler/manifest">`：一行 JSON dict `{uuid: {mime, compressed, data(base64)}}`，内联全部图片/字体/React 运行时。
- `<script type="__bundler/template">`：一行 JSON 字符串，内容是**整份 deck 的 HTML**（所有 `<section data-label=...>` 幻灯片、`nav[]` 导航数组、`chapters[]` 章节起点都在这个字符串里）。

因此**绝不能用编辑器/Edit 工具直改 deck 文件**——必须经 `scripts/edit-bundle.py`：

```python
import importlib.util
spec = importlib.util.spec_from_file_location('eb', 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(spec); spec.loader.exec_module(eb)

lines = eb.load('my-deck.html')
s = eb.get_template(lines)        # 解码出 deck HTML 字符串
s = s.replace('旧文案', '新文案')
eb.set_template(lines, s)         # 回填，自动做转义与断言
eb.save('my-deck.html', lines); eb.verify('my-deck.html')
```

edit-bundle 的不变量（改该脚本时必须保持）：

1. 编码只走 `dump_template()`：`json.dumps(s, ensure_ascii=False).replace('</', '<\\u002F')` —— 只转义 `</`（防 `</script>` 提前闭合），CJK 与 URL 中的 `/` 不动；回填后断言 `'</' not in raw` 且 `json.loads(raw) == s`。
2. 增删移页必须三处同步：slide DOM / `nav[]` / `chapters[]`。`insert_page` / `delete_page` / `move_page` 已封装好，勿绕过。
3. `data-idx` 必须是数字。

动画引擎规则（steps.mjs 与 deck 运行时保持一致，改一处须同步另一处）：`build` 元素按 `data-step` 与点击计数 level 显隐；`layer` 按钮/面板同 key 同 group 联动 `data-active`；总拍数 = 页内最大 `data-step` + 2。

## 文档一致性

`SKILL.md` 与 `references/*.md` 互相交叉引用（每条设计铁律指向对应 reference，README 复述了目录结构与快速上手）。改脚本行为、命令用法、页数（当前 34 页）或铁律时，检查并同步 `SKILL.md`、`README.md` 与相关 reference。各 reference 分工见 `SKILL.md` 的「文件导航」表。

## 本地试装

skill 通过放入 `~/.claude/skills/huawei-deck` 生效；开发时用软链接 `ln -s "$(pwd)" ~/.claude/skills/huawei-deck`，改动即时同步。
