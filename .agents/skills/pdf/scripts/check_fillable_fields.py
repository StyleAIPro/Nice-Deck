"""检查 PDF 是否包含可填写的 AcroForm 控件。"""
import sys
from pdf_utils import open_pdf


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("用法：check_fillable_fields.py <input.pdf>")
    with open_pdf(sys.argv[1]) as doc:
        if doc.xref_get_key(doc.pdf_catalog(), "AcroForm/XFA")[0] != "null":
            raise SystemExit("该 PDF 使用 XFA 表单，不支持自动填写；请提供 AcroForm 或普通 PDF")
        found = any(any(page.widgets() or []) for page in doc)
        print("此 PDF 包含可填写表单字段" if found else "此 PDF 不含可填写表单字段，请按页面内容确定填写位置")
