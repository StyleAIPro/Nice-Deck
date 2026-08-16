# 验证与导出

## 启用质量验证

```bash
python3 scripts/check_deps.py --profile verify --repair
```

Windows：

```powershell
py -3 scripts\check_deps.py --profile verify --repair
```

## 验证三件套

```bash
node scripts/verify/measure_overflow.mjs my-deck.html --all
node scripts/verify/shot.mjs my-deck.html <页label> /tmp/page.jpg
node scripts/verify/steps.mjs my-deck.html <页label> /tmp/steps
```

- `measure_overflow`：检查全部页面是否超出 1920×1080 画布；
- `shot`：生成单页全显截图，供视觉检查；
- `steps`：按放映节拍生成逐拍截图，适用于动画页。

## 导出 PPTX

先启用导出能力：

```bash
python3 scripts/check_deps.py --profile pptx-export --repair
```

在 Editor 中，可点击画布工具栏右侧、画布尺寸之前的导出图标直接下载 PPTX。导出使用当前工作副本快照，包含屏幕上正在预览但尚未固化的修改；导出本身不会固化修改，也不会清空撤销记录。

再执行：

```bash
python3 scripts/html2pptx/convert.py my-deck.html my-deck.pptx
```

Windows：

```powershell
py -3 scripts\html2pptx\convert.py my-deck.html my-deck.pptx
```

页内 layer 多标签页会自动展开为多张 PPTX 页面。只有用户明确需要 PPTX 时才导出；后续继续修改 HTML 不会自动重导。
