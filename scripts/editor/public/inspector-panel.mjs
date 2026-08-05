const KIND_LABELS = Object.freeze({
  text:'文字', shape:'图形', svg:'SVG 图形', image:'图片',
});

const STYLE_LABELS = Object.freeze({
  color:'文字颜色',
  'font-size':'字号',
  'font-weight':'字重',
  'background-color':'填充',
  'border-color':'边框颜色',
  'border-width':'边框宽度',
  'border-style':'边框样式',
  fill:'填充',
  stroke:'描边颜色',
  'stroke-width':'描边宽度',
  opacity:'透明度',
});

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name === 'checked') node.checked = Boolean(value);
    else if (name === 'disabled') node.disabled = Boolean(value);
    else if (name === 'value') node.value = value;
    else node.setAttribute(name, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function colorToHex(value, fallback = '#ffffff') {
  const source = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(source)) return source;
  if (/^#[0-9a-f]{3}$/.test(source)) {
    return `#${[...source.slice(1)].map(char => char.repeat(2)).join('')}`;
  }
  const rgb = source.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  if (!rgb) return fallback;
  return `#${rgb.slice(1, 4).map(part => (
    Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, '0')
  )).join('')}`;
}

function numberFromCss(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function resetButton(property, selection, busy, onApply) {
  const modified = selection.modifiedProperties?.includes(property);
  const button = element('button', {
    className:'inspector-reset', type:'button', title:`恢复原始${STYLE_LABELS[property] ?? '属性'}`,
    'aria-label':`恢复原始${STYLE_LABELS[property] ?? '属性'}`,
    dataset:{ resetProperty:property },
    disabled:busy || !modified, text:'↶',
  });
  button.addEventListener('click', () => onApply([{
    property, value:selection.resetValues?.[property] ?? '',
  }]));
  return button;
}

function fieldRow(labelText, control, reset) {
  return element('div', { className:'inspector-field' }, [
    element('span', { className:'inspector-field-label', text:labelText }),
    element('div', { className:'inspector-field-control' }, [control, reset]),
  ]);
}

function colorControl({ property, value, selection, busy, onApply, noneValue }) {
  const input = element('input', {
    className:'inspector-color-input', type:'color', value:colorToHex(value), disabled:busy,
    dataset:{ styleProperty:property },
    title:STYLE_LABELS[property], 'aria-label':STYLE_LABELS[property],
  });
  input.addEventListener('change', () => onApply([{ property, value:input.value }]));
  const swatch = element('label', { className:'inspector-color-swatch', title:STYLE_LABELS[property] }, [input]);
  const controls = [swatch, element('code', {
    className:'inspector-color-value', dataset:{ colorValue:property },
    text:colorToHex(value).toUpperCase(),
  })];
  if (noneValue !== undefined) {
    const none = element('button', {
      className:'inspector-none-button', type:'button', text:'无', disabled:busy,
    });
    none.addEventListener('click', () => onApply([{ property, value:noneValue }]));
    controls.push(none);
  }
  return fieldRow(STYLE_LABELS[property], element('div', {
    className:'inspector-color-control',
  }, controls), resetButton(property, selection, busy, onApply));
}

function section(title, children) {
  return element('section', { className:'inspector-section' }, [
    element('h3', { text:title }), ...children,
  ]);
}

function typographySection(selection, busy, onApply) {
  if (!selection.capabilities?.typography) return null;
  const computed = selection.computed;
  const bold = Number.parseInt(computed['font-weight'], 10) >= 600;
  const boldButton = element('button', {
    className:'inspector-icon-button', type:'button', disabled:busy,
    dataset:{ styleProperty:'font-weight' },
    title:bold ? '取消加粗' : '加粗', 'aria-label':bold ? '取消加粗' : '加粗',
    'aria-pressed':String(bold), text:'B',
  });
  boldButton.addEventListener('click', () => {
    const active = boldButton.getAttribute('aria-pressed') === 'true';
    onApply([{ property:'font-weight', value:active ? '400' : '700' }]);
  });
  const fontSize = element('input', {
    className:'inspector-number-input', type:'number', min:'6', max:'240', step:'1',
    dataset:{ valueProperty:'font-size' },
    value:String(Math.round(numberFromCss(computed['font-size'], 24, 6, 240))), disabled:busy,
    'aria-label':'字号',
  });
  fontSize.addEventListener('change', () => onApply([{
    property:'font-size', value:`${numberFromCss(fontSize.value, 24, 6, 240)}px`,
  }]));
  return section('文字', [
    fieldRow('字重', boldButton, resetButton('font-weight', selection, busy, onApply)),
    fieldRow('字号', element('div', { className:'inspector-unit-control' }, [
      fontSize, element('span', { text:'px' }),
    ]), resetButton('font-size', selection, busy, onApply)),
    colorControl({
      property:'color', value:computed.color, selection, busy, onApply,
    }),
  ]);
}

function htmlBorderSection(selection, busy, onApply) {
  if (!selection.capabilities?.border) return null;
  const computed = selection.computed;
  const enabled = computed['border-style'] !== 'none'
    && numberFromCss(computed['border-width'], 0, 0, 40) > 0;
  const toggle = element('input', {
    className:'inspector-switch-input', type:'checkbox', checked:enabled, disabled:busy,
    dataset:{ borderToggle:'', borderStyle:computed['border-style'], borderWidth:computed['border-width'] },
    'aria-label':'显示边框',
  });
  toggle.addEventListener('change', () => onApply(toggle.checked ? [
    { property:'border-style', value:toggle.dataset.borderStyle === 'none'
      ? 'solid' : toggle.dataset.borderStyle },
    { property:'border-width', value:numberFromCss(toggle.dataset.borderWidth, 0, 0, 40) > 0
      ? toggle.dataset.borderWidth : '1px' },
  ] : [{ property:'border-style', value:'none' }]));
  const width = element('input', {
    className:'inspector-number-input', type:'number', min:'0', max:'40', step:'1',
    dataset:{ valueProperty:'border-width' },
    value:String(numberFromCss(computed['border-width'], 0, 0, 40)), disabled:busy || !enabled,
    'aria-label':'边框宽度',
  });
  width.addEventListener('change', () => onApply([{
    property:'border-width', value:`${numberFromCss(width.value, 1, 0, 40)}px`,
  }]));
  const borderStyle = element('select', {
    className:'inspector-select', dataset:{ valueProperty:'border-style' },
    disabled:busy || !enabled, 'aria-label':'边框样式',
  }, [
    element('option', { value:'solid', text:'实线' }),
    element('option', { value:'dashed', text:'虚线' }),
    element('option', { value:'dotted', text:'点线' }),
    element('option', { value:'double', text:'双线' }),
  ]);
  borderStyle.value = ['solid', 'dashed', 'dotted', 'double'].includes(computed['border-style'])
    ? computed['border-style'] : 'solid';
  borderStyle.addEventListener('change', () => onApply([{
    property:'border-style', value:borderStyle.value,
  }]));
  return section('边框', [
    fieldRow('显示边框', element('label', { className:'inspector-switch' }, [
      toggle, element('span', { 'aria-hidden':'true' }),
    ]), resetButton('border-style', selection, busy, onApply)),
    colorControl({
      property:'border-color', value:computed['border-color'], selection, busy, onApply,
    }),
    fieldRow('宽度', element('div', { className:'inspector-unit-control' }, [
      width, element('span', { text:'px' }),
    ]), resetButton('border-width', selection, busy, onApply)),
    fieldRow('样式', borderStyle, resetButton('border-style', selection, busy, onApply)),
  ]);
}

function svgStrokeSection(selection, busy, onApply) {
  if (!selection.capabilities?.svgStyle) return null;
  const computed = selection.computed;
  const width = element('input', {
    className:'inspector-number-input', type:'number', min:'0', max:'40', step:'.5',
    dataset:{ valueProperty:'stroke-width' },
    value:String(numberFromCss(computed['stroke-width'], 0, 0, 40)), disabled:busy,
    'aria-label':'描边宽度',
  });
  width.addEventListener('change', () => onApply([{
    property:'stroke-width', value:String(numberFromCss(width.value, 1, 0, 40)),
  }]));
  return section('描边', [
    colorControl({
      property:'stroke', value:computed.stroke, selection, busy, onApply, noneValue:'none',
    }),
    fieldRow('宽度', width, resetButton('stroke-width', selection, busy, onApply)),
  ]);
}

function opacitySection(selection, busy, onApply) {
  if (!selection.capabilities?.opacity) return null;
  const opacity = Math.round(numberFromCss(selection.computed.opacity, 1, 0, 1) * 100);
  const range = element('input', {
    className:'inspector-range', type:'range', min:'0', max:'100', step:'1',
    dataset:{ valueProperty:'opacity' },
    value:String(opacity), disabled:busy, 'aria-label':'不透明度',
  });
  const output = element('output', { className:'inspector-range-value', text:`${opacity}%` });
  range.addEventListener('input', () => { output.textContent = `${range.value}%`; });
  range.addEventListener('change', () => onApply([{
    property:'opacity', value:String(Number(range.value) / 100),
  }]));
  return section('透明度', [
    fieldRow('不透明度', element('div', { className:'inspector-range-control' }, [range, output]),
      resetButton('opacity', selection, busy, onApply)),
  ]);
}

function appearanceSection(selection, busy, onApply) {
  if (!selection.capabilities?.fill) return null;
  const property = selection.capabilities.svgStyle ? 'fill' : 'background-color';
  return section('外观', [colorControl({
    property, value:selection.computed[property], selection, busy, onApply,
    noneValue:selection.capabilities.svgStyle ? 'none' : 'transparent',
  })]);
}

function selectionSummary(selection) {
  const tag = String(selection.tag ?? '').toUpperCase();
  const title = selection.scope === 'text-range'
    ? `“${selection.textPreview}”` : (selection.label || selection.textPreview || tag);
  const meta = selection.scope === 'text-range'
    ? `第 ${selection.pageIndex} 页 · 已选 ${selection.textRange.end - selection.textRange.start} 个字`
    : `第 ${selection.pageIndex} 页 · ${tag}`;
  return element('div', { className:'inspector-object' }, [
    element('div', { className:'inspector-object-icon', text:selection.kind === 'text' ? 'T' : '◇' }),
    element('div', { className:'inspector-object-copy' }, [
      element('strong', {
        dataset:{ inspectorObjectTitle:'' },
        text:title || KIND_LABELS[selection.kind] || '元素', title:title,
      }),
      element('span', {
        dataset:{ inspectorObjectMeta:'' }, text:meta,
      }),
    ]),
  ]);
}

function updateColor(body, selection, property) {
  const input = body.querySelector(`[data-style-property="${CSS.escape(property)}"]`);
  if (!input || input.type !== 'color') return;
  const value = colorToHex(selection.computed[property]);
  input.value = value;
  const output = body.querySelector(`[data-color-value="${CSS.escape(property)}"]`);
  if (output) output.textContent = value.toUpperCase();
}

function updateInspectorBody(body, { selection, busy, notice }) {
  body.dataset.busy = String(busy);
  body.dataset.selectionId = selection.selectionId;
  const title = selection.scope === 'text-range'
    ? `“${selection.textPreview}”`
    : (selection.label || selection.textPreview
      || String(selection.tag ?? '').toUpperCase()
      || KIND_LABELS[selection.kind] || '元素');
  const titleNode = body.querySelector('[data-inspector-object-title]');
  if (titleNode) {
    titleNode.textContent = title;
    titleNode.title = title;
  }
  const meta = body.querySelector('[data-inspector-object-meta]');
  if (meta) meta.textContent = selection.scope === 'text-range'
    ? `第 ${selection.pageIndex} 页 · 已选 ${selection.textRange.end - selection.textRange.start} 个字`
    : `第 ${selection.pageIndex} 页 · ${String(selection.tag ?? '').toUpperCase()}`;

  const noticeNode = body.querySelector('.inspector-notice');
  noticeNode.hidden = !notice;
  noticeNode.textContent = notice;
  noticeNode.dataset.state = notice.startsWith('失败') ? 'error' : 'info';

  for (const control of body.querySelectorAll('button,input,select')) control.disabled = busy;
  const modified = new Set(selection.modifiedProperties ?? []);
  for (const reset of body.querySelectorAll('[data-reset-property]')) {
    reset.disabled = busy || !modified.has(reset.dataset.resetProperty);
  }
  const resetAll = body.querySelector('.inspector-reset-all');
  resetAll.hidden = modified.size === 0;
  resetAll.disabled = busy;

  const borderEnabled = selection.computed['border-style'] !== 'none'
    && numberFromCss(selection.computed['border-width'], 0, 0, 40) > 0;
  const borderToggle = body.querySelector('[data-border-toggle]');
  const borderWidth = body.querySelector('[data-value-property="border-width"]');
  const borderStyle = body.querySelector('[data-value-property="border-style"]');
  if (borderWidth) borderWidth.disabled = busy || !borderEnabled;
  if (borderStyle) borderStyle.disabled = busy || !borderEnabled;

  // 提交开始时 selection 仍是旧快照；保留用户刚刚操作的控件值，避免视觉回跳。
  if (!busy) {
    const bold = body.querySelector('[data-style-property="font-weight"]');
    if (bold?.tagName === 'BUTTON') {
      const active = Number.parseInt(selection.computed['font-weight'], 10) >= 600;
      bold.setAttribute('aria-pressed', String(active));
      bold.setAttribute('aria-label', active ? '取消加粗' : '加粗');
      bold.title = active ? '取消加粗' : '加粗';
    }
    const setNumber = (property, value) => {
      const input = body.querySelector(`[data-value-property="${CSS.escape(property)}"]`);
      if (input) input.value = String(value);
    };
    setNumber('font-size', Math.round(numberFromCss(selection.computed['font-size'], 24, 6, 240)));
    setNumber('border-width', numberFromCss(selection.computed['border-width'], 0, 0, 40));
    setNumber('stroke-width', numberFromCss(selection.computed['stroke-width'], 0, 0, 40));
    for (const property of ['color', 'background-color', 'border-color', 'fill', 'stroke']) {
      updateColor(body, selection, property);
    }
    if (borderToggle) {
      borderToggle.checked = borderEnabled;
      borderToggle.dataset.borderStyle = selection.computed['border-style'];
      borderToggle.dataset.borderWidth = selection.computed['border-width'];
    }
    if (borderStyle) {
      borderStyle.value = ['solid', 'dashed', 'dotted', 'double']
        .includes(selection.computed['border-style']) ? selection.computed['border-style'] : 'solid';
    }
    const opacity = Math.round(numberFromCss(selection.computed.opacity, 1, 0, 1) * 100);
    const opacityRange = body.querySelector('[data-value-property="opacity"]');
    if (opacityRange) opacityRange.value = String(opacity);
    const opacityOutput = body.querySelector('.inspector-range-value');
    if (opacityOutput) opacityOutput.textContent = `${opacity}%`;
  }
}

function emptyState() {
  return element('div', { className:'inspector-empty' }, [
    element('div', { className:'selection-frame', 'aria-hidden':'true' }),
    element('h3', { text:'选择文字或画面元素开始编辑' }),
    element('p', { text:'双击文字直接修改；拖动元素移动，拖动右下角控制点缩放；Cmd/Ctrl+Enter 提交，Escape 取消。' }),
  ]);
}

export function renderInspectorPanel(root, {
  selection = null, busy = false, notice = '', onApply = () => {}, onResetAll = () => {},
} = {}) {
  if (!selection) {
    root.replaceChildren(emptyState());
    return;
  }
  const currentBody = root.querySelector(':scope > .inspector-body');
  if (currentBody?.dataset.selectionId === selection.selectionId) {
    updateInspectorBody(currentBody, { selection, busy, notice });
    return;
  }
  const noticeNode = element('p', {
    className:'inspector-notice', dataset:{ state:'info' }, role:'status', 'aria-live':'polite',
  });
  noticeNode.hidden = true;
  const body = element('div', {
    className:'inspector-body', dataset:{ busy:String(busy), selectionId:selection.selectionId },
  }, [
    selectionSummary(selection),
    noticeNode,
    typographySection(selection, busy, onApply),
    appearanceSection(selection, busy, onApply),
    htmlBorderSection(selection, busy, onApply),
    svgStrokeSection(selection, busy, onApply),
    opacitySection(selection, busy, onApply),
  ]);
  const resetAll = element('button', {
    className:'inspector-reset-all', type:'button', disabled:busy, text:'恢复全部原始样式',
  });
  resetAll.addEventListener('click', onResetAll);
  body.append(element('div', { className:'inspector-footer' }, [resetAll]));
  root.replaceChildren(body);
  updateInspectorBody(body, { selection, busy, notice });
}

export { colorToHex };
