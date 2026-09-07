"""在参考图上绘制红色填写框与蓝色标签框；只用 PyMuPDF。"""
import json
import sys
import pymupdf


def create_validation_image(page_number, fields_json_path, input_path, output_path):
    with open(fields_json_path, encoding="utf-8") as stream:
        data = json.load(stream)
    image = pymupdf.Pixmap(input_path)
    page_info = next(item for item in data["pages"] if item["page_number"] == page_number)
    reference_width = page_info.get("pdf_width", page_info.get("image_width", image.width))
    reference_height = page_info.get("pdf_height", page_info.get("image_height", image.height))
    if reference_width <= 0 or reference_height <= 0:
        raise ValueError("参考页面尺寸必须为正数")
    scale = pymupdf.Matrix(image.width / reference_width, image.height / reference_height)
    with pymupdf.open() as doc:
        page = doc.new_page(width=image.width, height=image.height)
        page.insert_image(page.rect, pixmap=image)
        count = 0
        for field in data["form_fields"]:
            if field["page_number"] != page_number:
                continue
            for key, color in (("entry_bounding_box", (1, 0, 0)), ("label_bounding_box", (0, 0, 1))):
                page.draw_rect(pymupdf.Rect(field[key]) * scale, color=color, width=2)
                count += 1
        page.get_pixmap(alpha=bool(image.alpha)).save(output_path)
    print(f"已绘制 {count} 个校验框：{output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("用法：create_validation_image.py <page> <fields.json> <input_image> <output_image>")
    create_validation_image(int(sys.argv[1]), *sys.argv[2:])
