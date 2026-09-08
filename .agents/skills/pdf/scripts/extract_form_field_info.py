"""提取 AcroForm 字段；保留原 CLI、JSON 字段与 PDF 左下角坐标。"""
import json
import sys
import pymupdf
from pdf_utils import open_pdf


def make_field_dict(widget, page):
    # Widget.rect 使用 MuPDF 左上角坐标；原接口要求未旋转 PDF 左下角坐标。
    result = {"field_id": widget.field_name, "page": page.number + 1,
              "rect": list(widget.rect * ~page.transformation_matrix)}
    kind = widget.field_type
    if kind == pymupdf.PDF_WIDGET_TYPE_TEXT:
        result["type"] = "text"
    elif kind == pymupdf.PDF_WIDGET_TYPE_CHECKBOX:
        states = (widget.button_states() or {}).get("normal") or []
        on = [state for state in states if state != "Off"]
        if len(on) != 1:
            raise ValueError(f"复选框 {widget.field_name} 的选中状态不唯一")
        result.update(type="checkbox", checked_value="/" + on[0], unchecked_value="/Off")
    elif kind == pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON:
        result["type"] = "radio_group"
        result["radio_options"] = [{"value": "/" + str(widget.on_state()), "rect": result.pop("rect")}]
    elif kind in (pymupdf.PDF_WIDGET_TYPE_COMBOBOX, pymupdf.PDF_WIDGET_TYPE_LISTBOX):
        result["type"] = "choice"
        result["choice_options"] = [{"value": value[0], "text": value[1]} if isinstance(value, (tuple, list)) else {"value": value, "text": value}
                                    for value in widget.choice_values or []]
    else:
        result["type"] = f"unknown ({widget.field_type_string})"
    return result


def get_field_info(doc):
    if doc.xref_get_key(doc.pdf_catalog(), "AcroForm/XFA")[0] != "null":
        raise ValueError("XFA 表单不支持自动填写；请提供 AcroForm 或普通 PDF")
    fields, radio_groups = [], {}
    for page in doc:
        for widget in page.widgets() or []:
            field = make_field_dict(widget, page)
            if field["type"] == "radio_group":
                key = (field["field_id"], field["page"])
                if key in radio_groups:
                    radio_groups[key]["radio_options"].extend(field["radio_options"])
                    continue
                radio_groups[key] = field
            fields.append(field)
    fields.sort(key=lambda field: (field["page"], -(field.get("rect") or field["radio_options"][0]["rect"])[1], (field.get("rect") or field["radio_options"][0]["rect"])[0]))
    return fields


def write_field_info(pdf_path, json_output_path):
    with open_pdf(pdf_path) as doc:
        fields = get_field_info(doc)
    with open(json_output_path, "w", encoding="utf-8") as stream:
        json.dump(fields, stream, ensure_ascii=False, indent=2)
    print(f"已写入 {len(fields)} 个字段：{json_output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("用法：extract_form_field_info.py <input.pdf> <output.json>")
    write_field_info(sys.argv[1], sys.argv[2])
