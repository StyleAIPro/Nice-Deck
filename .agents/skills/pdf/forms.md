# PDF 表单处理

沿用原 Skill 的命令名和 JSON 契约；本地改造来源与许可证见 [SKILL.md](SKILL.md)。运行前保留原文件，输出另取文件名。未解密 PDF 和 XFA 表单不自动处理；已签名 PDF 不改写。不能确定逻辑字段与页面控件对应关系时，报告具体问题，不能根据截图猜测成功。

## 1. 识别表单

```bash
python3 .agents/skills/pdf/scripts/check_fillable_fields.py 输入.pdf
python3 .agents/skills/pdf/scripts/extract_form_field_info.py 输入.pdf field_info.json
```

以上命令只需 PyMuPDF，所有页码从 1 开始。字段 JSON 保留以下格式：

```json
[
  {"field_id":"name","page":1,"type":"text","rect":[50,275,250,300]},
  {"field_id":"consent","page":1,"type":"checkbox","rect":[50,245,65,260],"checked_value":"/Yes","unchecked_value":"/Off"},
  {"field_id":"country","page":1,"type":"choice","rect":[50,205,200,230],"choice_options":[{"value":"CN","text":"China"},{"value":"FR","text":"France"}]},
  {"field_id":"color","page":1,"type":"radio_group","radio_options":[{"value":"/Red","rect":[50,165,65,180]},{"value":"/Blue","rect":[100,165,115,180]}]}
]
```

`field_id` 使用表单完整字段名；`rect` 是原 PDF 未旋转坐标系的 `[左, 下, 右, 上]`，原点在左下方。单选组每个选项各有位置。同一共享字段可能跨页重复出现；填写同名字段的值必须一致。不要从标签文案重新编造字段名，也不要把显示文字代替选择框的 `value`。

## 2. 填写 AcroForm

准备 `field_values.json`，使用字段提取结果中的页码和合法值：

```json
[
  {"field_id":"name","page":1,"value":"Ada"},
  {"field_id":"consent","page":1,"value":"/Yes"},
  {"field_id":"country","page":1,"value":"FR"},
  {"field_id":"color","page":1,"value":"/Blue"}
]
```

```bash
python3 .agents/skills/pdf/scripts/fill_fillable_fields.py 输入.pdf field_values.json 已填写.pdf
```

该脚本另用 pypdf，保留原字段字体并生成显示外观，避免 PyMuPDF 更新控件时把中文字体替换为西文字体。支持文字、复选框、单选组和单选选择框；未知字段、错误页码、非法选项、冲突的共享字段值会中止且不发布结果。保留交互，不扁平化，不把“要求阅读器自行重建外观”当作验证成功。

保存后重新读取逻辑 `/AcroForm/Fields` 中的值和页面控件状态，再渲染逐页图目检。原表单必须具有覆盖待填字符的字体；如果原字体缺少中文、出现缺字警告或图像不完整，停止交付，改用具有合适字体的原表单。脚本不安装系统字体、不自行重建字体引擎。外观排版是否合适仍需目检；嵌入式 JavaScript 的计算、校验和复杂多选列表不在当前自动填写契约中，需另行核对。

## 3. 普通 PDF 的填写位置

没有 AcroForm 的页面可添加文字批注。先读取文字、横线、方框与表格结构：

```bash
python3 .agents/skills/pdf/scripts/extract_form_structure.py 输入.pdf structure.json
python3 .agents/skills/pdf/scripts/convert_pdf_to_images.py 输入.pdf images
```

结构 JSON 包含 `pages`、`labels`、`lines`、`checkboxes`、`row_boundaries`，并新增 `tables`（每项含 `page`、`bbox` 和二维 `rows`）。结构坐标是显示页面左上角起的点数，已经考虑页面旋转。扫描页可能只有图像；此时 AI 读图确定位置，不依赖空的文字提取结果。

按显示页面的点数准备 `fields.json`：

```json
{
  "pages": [{"page_number":1,"pdf_width":400,"pdf_height":500}],
  "form_fields": [{
    "page_number":1,
    "description":"审核意见",
    "label_bounding_box":[20,370,45,395],
    "entry_bounding_box":[50,370,250,395],
    "entry_text":{"text":"审核通过","font_size":12,"font":"Arial","font_color":"000000"}
  }]
}
```

如果基于 PNG 定位，改用 `image_width`、`image_height` 并以该图片的像素作为框坐标。不要混用两套单位。两种框均是左上角坐标 `[左, 上, 右, 下]`，与 AcroForm 的原 PDF `rect` 不同。`font_color` 是六位 RGB；普通批注使用内置字体回退支持中文，`Arial`/`Helvetica`、`Courier New`、`Times New Roman` 分别映射到无衬线、等宽和衬线字体族；不承诺精确复现系统字体。

```bash
python3 .agents/skills/pdf/scripts/check_bounding_boxes.py fields.json
python3 .agents/skills/pdf/scripts/create_validation_image.py 1 fields.json images/page_1.png validation.png
python3 .agents/skills/pdf/scripts/fill_pdf_form_with_annotations.py 输入.pdf fields.json 已填写.pdf
python3 .agents/skills/pdf/scripts/convert_pdf_to_images.py 已填写.pdf result-images
```

校验图红框是填写区域、蓝框是标签区域；先目检位置，再添加批注并复检结果。普通批注保留原有表单，不把标签或整页覆盖成图片。长文本或较小框可能裁切；须调整字号或填写区域后再次验证。所有这些命令只需 PyMuPDF 和标准库，不需要其他渲染程序或图像包。
