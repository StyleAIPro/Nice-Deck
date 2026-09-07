"""提取 PDF 文字、表格、横线和方框；坐标均为显示页面左上角起的点数。"""
import json
import sys
import pymupdf
from pdf_utils import open_pdf


def extract_form_structure(pdf_path):
    result = {"pages": [], "labels": [], "lines": [], "checkboxes": [], "row_boundaries": [], "tables": []}
    with open_pdf(pdf_path) as doc:
        for number, page in enumerate(doc, 1):
            result["pages"].append({"page_number": number, "width": page.rect.width, "height": page.rect.height})
            rotation = page.rotation_matrix
            for word in page.get_text("words", sort=True):
                rect = pymupdf.Rect(word[:4]) * rotation
                result["labels"].append({"page": number, "text": word[4], "x0": round(rect.x0, 1), "top": round(rect.y0, 1), "x1": round(rect.x1, 1), "bottom": round(rect.y1, 1)})
            lines, boxes = set(), set()
            for drawing in page.get_drawings():
                for item in drawing["items"]:
                    if item[0] == "l":
                        start, end = item[1] * rotation, item[2] * rotation
                        if abs(start.y - end.y) < 0.5 and abs(end.x - start.x) > page.rect.width * 0.5:
                            lines.add((round(start.y, 1), round(min(start.x, end.x), 1), round(max(start.x, end.x), 1)))
                    elif item[0] == "re":
                        rect = item[1] * rotation
                        if 5 <= rect.width <= 15 and 5 <= rect.height <= 15 and abs(rect.width - rect.height) < 2:
                            boxes.add(tuple(round(value, 1) for value in rect))
            for y, left, right in sorted(lines):
                result["lines"].append({"page": number, "y": y, "x0": left, "x1": right})
            for left, top, right, bottom in sorted(boxes):
                result["checkboxes"].append({"page": number, "x0": left, "top": top, "x1": right, "bottom": bottom, "center_x": round((left + right) / 2, 1), "center_y": round((top + bottom) / 2, 1)})
            ys = sorted({line[0] for line in lines})
            result["row_boundaries"].extend({"page": number, "row_top": top, "row_bottom": bottom, "row_height": round(bottom - top, 1)} for top, bottom in zip(ys, ys[1:]))
            for table in page.find_tables().tables:
                # find_tables 已按页面旋转返回显示坐标，不能像 words 那样再旋转一次。
                result["tables"].append({"page": number, "bbox": list(table.bbox), "rows": table.extract()})
    return result


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("用法：extract_form_structure.py <input.pdf> <output.json>")
    result = extract_form_structure(sys.argv[1])
    with open(sys.argv[2], "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(f"已提取 {len(result['pages'])} 页、{len(result['labels'])} 个文字片段、{len(result['tables'])} 个表格：{sys.argv[2]}")
