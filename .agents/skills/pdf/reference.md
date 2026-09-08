# PDF 处理参考

本地依赖以 [SKILL.md](SKILL.md) 为准；原始来源和许可证保持不变。以下示例只使用 PyMuPDF 与 Python 标准库。AcroForm 填写使用现有 [表单脚本](forms.md)，避免重新实现字体和控件外观。

## 文字与表格

`page.get_text("text", sort=True)` 按阅读位置提取文字；多栏、旋转文字和复杂排版仍需结合原页核对。`page.get_text("words")` 返回文字与位置，位置是未旋转页面左上角坐标；显示坐标可乘 `page.rotation_matrix`。表格用 `page.find_tables().tables` 后立即调用 `table.extract()`；表格对象依赖原页面存活，不要跨页面缓存。

默认表格检测优先识别线框。无边框表格可尝试 `page.find_tables(strategy="text")`，但须对照原页确认行列关系；扫描表格需先读图或 OCR。不能把未检测到表格当作没有表格。`extract_form_structure.py` 提供标准 JSON，不依赖 DataFrame 或其他表格框架。

## 内嵌原图、蒙版与裁切

`page.get_images(full=True)` 给出图像 xref 与透明蒙版 xref；`doc.extract_image(xref)` 返回原始编码的图像，适合按页关联保存。相同 xref 可跨页复用，保存时可以去重，但必须保留每页关联。此列表不代表完整页面外观：矢量图不是位图，有些资源可能未实际显示。

需要合成透明蒙版时：

```python
import pymupdf

with pymupdf.open("参考.pdf") as doc:
    for number, page in enumerate(doc, 1):
        for xref, smask, *_ in page.get_images(full=True):
            if smask:
                base = pymupdf.Pixmap(doc, xref)
                mask = pymupdf.Pixmap(doc, smask)
                pymupdf.Pixmap(base, mask).save(f"page-{number}-image-{xref}.png")
```

`page.get_text("dict")["blocks"]` 中 `type == 1` 的块还可提供内联图像的 `image`、`ext` 和 `bbox`。矢量图或一组混排图形需要裁切时，用 `page.get_pixmap(clip=pymupdf.Rect(...), matrix=pymupdf.Matrix(2, 2))`；这是页面局部栅格化，应标注为裁切图，不声称是原始内嵌图像。

## 页面生成、旋转、合并与拆分

```python
import pymupdf

with pymupdf.open() as doc:
    page = doc.new_page(width=595, height=842)
    page.insert_htmlbox(pymupdf.Rect(50, 50, 545, 200), "<h1>材料摘要</h1><p>中文文字与简单表格</p>")
    doc.save("摘要.pdf", garbage=3, deflate=True)

with pymupdf.open("参考.pdf") as doc:
    doc[0].set_rotation((doc[0].rotation + 90) % 360)
    doc.save("旋转后.pdf", garbage=3, deflate=True)
```

需要添加水印或印章时，按明确范围使用 `insert_text`、`insert_htmlbox` 或 `insert_image`，输出另取文件名并渲染复检。合并拆分代码见 SKILL.md；复制时保留 `widgets=True`，跨文档同名字段不要随意共享。交互表单、书签、附件和内部跳转分别验证，不能只核对页数。

## 加密与权限

读取需要口令的 PDF 时，用 `doc.authenticate(已提供的口令)`，返回失败则停止。材料脚本默认接收未加密或已解密副本，不尝试破解口令。使用 PyMuPDF 的 `save(..., encryption=..., owner_pw=..., user_pw=..., permissions=...)` 可另存受保护文件；不要改写已签名文档，也不要在日志打印口令。具体参数以 [Document API](https://pymupdf.readthedocs.io/en/latest/document.html) 为准。

## OCR 的可选边界

PyMuPDF 的 OCR 接口仍依赖另外提供的 Tesseract 引擎与语言数据；精简运行时不自带这些组件，也不自动安装。普通读取、渲染和表单处理不需要 OCR。已有 OCR 环境时可使用：

```python
textpage = page.get_textpage_ocr(language="chi_sim+eng", dpi=150, full=True)
text = page.get_text("text", textpage=textpage)
```

没有 OCR 时直接让 AI 阅读逐页图，并明确哪些文本来自图像判断。OCR 结果可能漏字、错字和打乱表格，应对照图像核查。

## 官方 API 与回归

- [PyMuPDF 页面 API](https://pymupdf.readthedocs.io/en/latest/page.html)：文字、表格、图片、富文本批注。
- [PyMuPDF Widget API](https://pymupdf.readthedocs.io/en/latest/widget.html)：字段读取、坐标与控件类型。
- [pypdf 表单文档](https://pypdf.readthedocs.io/en/stable/user/forms.html)：保留字段树、默认字体与外观。

仓库回归测试 `python3 -m unittest scripts/editor/test/test_pdf_materials.py` 创建真实 PDF，普通脚本在只开放 PyMuPDF 的 `python -S` 子进程中运行；AcroForm 填写仅额外开放 pypdf。测试不安装软件，不依赖系统 PDF 渲染程序。
