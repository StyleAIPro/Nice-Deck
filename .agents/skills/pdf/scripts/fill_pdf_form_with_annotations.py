"""为普通 PDF 添加透明背景文字批注，保留已有表单与原文件。"""
import json
import sys
from html import escape
import pymupdf
from pdf_utils import open_pdf, save_pdf


def entry_rect(field, page_info, page):
    rect = pymupdf.Rect(field["entry_bounding_box"])
    if "pdf_width" not in page_info:
        width, height = page_info["image_width"], page_info["image_height"]
        if width <= 0 or height <= 0:
            raise ValueError("参考图片尺寸必须为正数")
        rect = rect * pymupdf.Matrix(page.rect.width / width, page.rect.height / height)
    if rect.is_empty or not page.rect.contains(rect):
        raise ValueError("填写区域为空或超出页面")
    return rect * page.derotation_matrix


def fill_pdf_form(input_pdf_path, fields_json_path, output_pdf_path):
    with open(fields_json_path, encoding="utf-8") as stream:
        data = json.load(stream)
    pages = {item["page_number"]: item for item in data["pages"]}
    count = 0
    with open_pdf(input_pdf_path) as doc:
        for field in data["form_fields"]:
            text = field.get("entry_text", {}).get("text")
            if not text:
                continue
            page_number = field["page_number"]
            if not isinstance(page_number, int) or not 1 <= page_number <= len(doc):
                raise ValueError("填写页码超出 PDF 范围")
            page = doc[page_number - 1]
            rect = entry_rect(field, pages[page_number], page)
            entry = field["entry_text"]
            color = entry.get("font_color", "000000").lstrip("#")
            if len(color) != 6:
                raise ValueError("font_color 必须是六位 RGB 十六进制颜色")
            rgb = tuple(int(color[index:index + 2], 16) / 255 for index in (0, 2, 4))
            # richtext 使用 MuPDF 内置字体回退，避免中文在基本西文字体下漏字。
            family = {"Courier New": "monospace", "Times New Roman": "serif"}.get(entry.get("font"), "sans-serif")
            size = float(entry.get("font_size", 14))
            if size <= 0:
                raise ValueError("font_size 必须为正数")
            style = f"font-family:{family};font-size:{size}pt;color:#{color};"
            annotation = page.add_freetext_annot(rect, escape(str(text)).replace("\n", "<br>"), richtext=True, style=style, text_color=rgb, border_width=0, rotate=page.rotation)
            annotation.set_info(content=str(text))
            count += 1
        save_pdf(doc, input_pdf_path, output_pdf_path)
    print(f"已添加 {count} 个文字批注：{output_pdf_path}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("用法：fill_pdf_form_with_annotations.py <input.pdf> <fields.json> <output.pdf>")
    fill_pdf_form(*sys.argv[1:])
