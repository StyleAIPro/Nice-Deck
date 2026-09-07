"""按既有字段 JSON 填写 AcroForm；pypdf 保留字段原有字体和显示外观。"""
import json
import sys
import pymupdf
from pypdf import PdfReader, PdfWriter
from extract_form_field_info import get_field_info
from pdf_utils import open_pdf, atomic_pdf_output, require_unsigned


def validation_error_for_field_value(field, value):
    kind, name = field["type"], field["field_id"]
    if kind == "checkbox":
        choices = [field["checked_value"], field["unchecked_value"]]
    elif kind == "radio_group":
        choices = [option["value"] for option in field["radio_options"]]
    elif kind == "choice":
        choices = [option["value"] for option in field["choice_options"]]
    elif kind == "text":
        return None if isinstance(value, str) else f"字段 {name} 需要字符串"
    else:
        return f"字段 {name} 的类型不支持填写：{kind}"
    if value not in choices:
        return f"字段 {name} 的值无效：{value!r}；允许值：{choices}"
    return None


def fill_pdf_fields(input_pdf_path, fields_json_path, output_pdf_path):
    with open(fields_json_path, encoding="utf-8") as stream:
        requests = json.load(stream)
    if not isinstance(requests, list):
        raise ValueError("字段 JSON 顶层必须是数组")
    with open_pdf(input_pdf_path) as doc:
        require_unsigned(doc)
        info = get_field_info(doc)
        by_location = {(field["field_id"], field["page"]): field for field in info}
        values = {}
        for request in requests:
            key = (request["field_id"], request["page"])
            field = by_location.get(key)
            if field is None:
                raise ValueError(f"字段名或页码无效：{key}")
            if "value" not in request:
                continue
            value = request["value"]
            error = validation_error_for_field_value(field, value)
            if error:
                raise ValueError(error)
            if key[0] in values and values[key[0]] != value:
                raise ValueError(f"同名共享字段不能填写不同值：{key[0]}")
            values[key[0]] = value
        pages_with_values = {field["page"] for field in info if field["field_id"] in values}
    # 不用 Widget.update()，该接口会把表单的自定义中文字体重置为西文字体。
    writer = PdfWriter(clone_from=input_pdf_path)
    try:
        for page in sorted(pages_with_values):
            writer.update_page_form_field_values(writer.pages[page - 1], values, auto_regenerate=False)
        with atomic_pdf_output(input_pdf_path, output_pdf_path) as temporary:
            writer.write(temporary)
            verify_saved_fields(temporary, values)
    finally:
        writer.close()
    print(f"已填写并复检 {len(values)} 个字段：{output_pdf_path}")


def verify_saved_fields(path, values):
    # 同时读取逻辑字段树和页面控件；校验失败时不发布输出。
    with PdfReader(path) as reader:
        logical = reader.get_fields() or {}
        for name, expected in values.items():
            if logical.get(name, {}).get("/V") != expected:
                raise ValueError(f"逻辑字段保存后校验失败：{name}")
    with open_pdf(path) as doc:
        for page in doc:
            for widget in page.widgets() or []:
                if widget.field_name not in values:
                    continue
                expected = values[widget.field_name]
                if widget.field_type in (pymupdf.PDF_WIDGET_TYPE_CHECKBOX, pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON):
                    expected = expected[1:]
                if widget.field_type == pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON:
                    # 非选中按钮的 field_value 可是 Off，检查其组选中项之外的外观。
                    expected = expected if widget.on_state() == expected else "Off"
                    actual = doc.xref_get_key(widget.xref, "AS")[1].lstrip("/")
                else:
                    actual = widget.field_value
                if actual != expected:
                    raise ValueError(f"字段保存后校验失败：{widget.field_name}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("用法：fill_fillable_fields.py <input.pdf> <field_values.json> <output.pdf>")
    try:
        fill_pdf_fields(*sys.argv[1:])
    except (ValueError, KeyError) as error:
        raise SystemExit(str(error))
