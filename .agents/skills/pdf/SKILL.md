---
name: pdf
description: 读取和处理 PDF 材料：提取文字、表格和内嵌图片，合并拆分、旋转、生成页面与预览，检查和填写 PDF 表单。仅用于 PDF；参考 PPTX 使用 AICO-PPT 的标准库内容提取器。
license: Proprietary. LICENSE.txt has complete terms
---

# PDF 材料处理

本目录源自 [Anthropic PDF Skill](https://github.com/anthropics/skills/tree/main/skills/pdf)，保留原许可证 [LICENSE.txt](LICENSE.txt)。AICO-PPT 的本地适配把普通 PDF 能力统一到 PyMuPDF；只有 AcroForm 填写保留 pypdf，以保留字段原有字体和交互。不要用上游安装命令覆盖本地适配。

## 依赖与入口

桌面插件使用随包 Python。独立 Skill 的 PDF 依赖体检：

```bash
python3 scripts/check_deps.py --profile materials --check-only
python3 scripts/check_deps.py --profile materials --repair
```

下方路径均相对于 AICO-PPT 仓库根。普通 PDF 读取、表格、原图、合并拆分、页面渲染及文字批注只需 `pymupdf`；`fill_fillable_fields.py` 另需 `pypdf`。本地回归使用 PyMuPDF 1.26.5；使用其他版本时须验证表格、富文本批注和表单保留能力。

## 读取文字、表格与图片

```python
from pathlib import Path
import pymupdf

out = Path("pdf-materials")
out.mkdir(exist_ok=True)
with pymupdf.open("参考.pdf") as doc:
    for number, page in enumerate(doc, 1):
        print(f"第 {number} 页", page.get_text("text", sort=True))
        for table in page.find_tables().tables:
            print(table.extract())
        for image in page.get_images(full=True):
            xref = image[0]
            data = doc.extract_image(xref)
            if data:
                (out / f"page-{number}-image-{xref}.{data['ext']}").write_bytes(data["image"])
```

`get_text` 读取已有文字层；扫描页没有文字层时，让 AI 阅读逐页图，或在环境已具备 Tesseract 和语言数据时按 [reference.md](reference.md) 使用 OCR。`find_tables()` 是结构识别，复杂合并单元格、无边框和扫描表格可能漏检；空结果不能解释为原文没有表格。原图按页保存，透明蒙版、矢量图与内联图的处理见参考文档。

需要同时获取页面尺寸、文字位置、横线、方框和表格时：

```bash
python3 .agents/skills/pdf/scripts/extract_form_structure.py 参考.pdf 结构.json
```

## 合并、拆分与页面操作

```python
import pymupdf

with pymupdf.open() as merged:
    for path in ["第一份.pdf", "第二份.pdf"]:
        with pymupdf.open(path) as source:
            merged.insert_pdf(source, widgets=True)
    merged.save("合并.pdf", garbage=3, deflate=True)

with pymupdf.open("参考.pdf") as source:
    for index in range(len(source)):
        with pymupdf.open() as single:
            single.insert_pdf(source, from_page=index, to_page=index, widgets=True)
            single.save(f"第{index + 1}页.pdf", garbage=3, deflate=True)
```

输出使用新文件名。`insert_pdf` 保留所选页面的可见内容和表单控件，但文档级书签、附件和跨文档内部跳转不等同于逐页复制；需要这些对象时另作明确检查。同名独立表单在合并时保留为独立字段，不要无条件合并为共享字段。

## 表单与输出复检

填写前先读 [forms.md](forms.md)，按 AcroForm 和普通页面区分处理。保持原始 PDF；填写脚本拒绝覆盖原文件或其硬链接，并在临时文件上完成写入。AcroForm 填写还会复查逻辑字段值和页面控件状态后才发布结果。

```bash
python3 .agents/skills/pdf/scripts/convert_pdf_to_images.py 结果.pdf 逐页图
```

生成 `page_1.png` 等文件，默认最长边 1000 像素；第三个参数可改为 1600。AI 查看每页图，核对内容完整、文字不重叠、勾选位置正确。表单不能只看截图，还须核对字段值；不要默认扁平化。

高级页面操作、生成、图片与 OCR 说明见 [reference.md](reference.md)。本流程不用于 PPTX 渲染或转 PDF；参考 PPTX 直接使用 `python3 scripts/extract-pptx.py 参考.pptx 输出目录`，AI 阅读提取内容和内嵌原图。
