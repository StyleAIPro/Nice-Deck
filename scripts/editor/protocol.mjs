import { MAX_ATTACHMENTS, validateAttachmentMetadata } from './attachment-protocol.mjs';

export const ACTION_KINDS = new Set(['setText', 'setStyle', 'translate', 'resize', 'hide', 'show']);
export const TASK_STATUSES = new Set(['pending', 'processing', 'needs-confirmation', 'completed', 'failed']);

export function stableHash(text) {
  let h = 2166136261;
  for (const char of text) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function normalizeBlobAttributesInTag(tag) {
  let cursor = 0;
  let index = 1;
  let normalized = '';
  while (index < tag.length && !/[\s/>]/.test(tag[index])) index += 1;
  while (index < tag.length) {
    while (/\s/.test(tag[index] ?? '')) index += 1;
    if (!tag[index] || tag[index] === '>' || tag[index] === '/') break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index])) index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();
    while (/\s/.test(tag[index] ?? '')) index += 1;
    if (tag[index] !== '=') continue;
    index += 1;
    while (/\s/.test(tag[index] ?? '')) index += 1;
    const quote = tag[index];
    if (quote !== '"' && quote !== "'") {
      const valueStart = index;
      while (index < tag.length && !/[\s>]/.test(tag[index])) index += 1;
      if ((name === 'src' || name === 'href') && tag.slice(valueStart, index).startsWith('blob:')) {
        normalized += `${tag.slice(cursor, valueStart)}blob:`;
        cursor = index;
      }
      continue;
    }
    const valueStart = index + 1;
    const valueEnd = tag.indexOf(quote, valueStart);
    if (valueEnd < 0) break;
    if ((name === 'src' || name === 'href') && tag.slice(valueStart, valueEnd).startsWith('blob:')) {
      normalized += `${tag.slice(cursor, valueStart)}blob:`;
      cursor = valueEnd;
    }
    index = valueEnd + 1;
  }
  return normalized ? normalized + tag.slice(cursor) : tag;
}

function normalizeBlobResourceAttributes(html) {
  const source = String(html);
  let output = '';
  let cursor = 0;
  let rawTextTag = null;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) return output + source.slice(cursor);
    output += source.slice(cursor, start);
    if (rawTextTag) {
      const close = source.toLowerCase().indexOf(`</${rawTextTag}`, start);
      if (close < 0) return output + source.slice(start);
      output += source.slice(start, close);
      cursor = close;
      rawTextTag = null;
      continue;
    }
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      const next = end < 0 ? source.length : end + 3;
      output += source.slice(start, next);
      cursor = next;
      continue;
    }
    let end = start + 1;
    let quote = '';
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= source.length) return output + source.slice(start);
    const tag = source.slice(start, end + 1);
    const match = tag.match(/^<\s*([A-Za-z][\w:-]*)/);
    output += match ? normalizeBlobAttributesInTag(tag) : tag;
    if (match && ['script', 'style'].includes(match[1].toLowerCase()) && !/\/\s*>$/.test(tag)) {
      rawTextTag = match[1].toLowerCase();
    }
    cursor = end + 1;
  }
  return output;
}

export function makePageKey(index, label, html) {
  const structure = normalizeBlobResourceAttributes(html);
  const digest = stableHash(`${index}\0${label}\0${structure}`);
  return `page-${String(index).padStart(3, '0')}-${digest}`;
}

export function normalizeRect(rect, canvas) {
  if (!Number.isFinite(canvas?.width) || !Number.isFinite(canvas?.height) || canvas.width <= 0 || canvas.height <= 0) {
    throw new RangeError('画布尺寸必须为正的有限数');
  }
  if (![rect?.left, rect?.top, rect?.width, rect?.height, canvas?.left, canvas?.top].every(Number.isFinite)) {
    throw new RangeError('屏幕框和画布偏移必须为有限数');
  }
  const sx = 1920 / canvas.width;
  const sy = 1080 / canvas.height;
  const x = Math.max(0, Math.min(1919, Math.round((rect.left - canvas.left) * sx)));
  const y = Math.max(0, Math.min(1079, Math.round((rect.top - canvas.top) * sy)));
  const w = Math.max(1, Math.min(1920 - x, Math.round(rect.width * sx)));
  const h = Math.max(1, Math.min(1080 - y, Math.round(rect.height * sy)));
  return { x, y, w, h };
}

export function validateTask(task, { persisted=false } = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || Object.getPrototypeOf(task) !== Object.prototype) {
    throw new TypeError('任务必须为普通对象');
  }
  if (!task.pageKey || !task.instruction?.trim()) {
    throw new TypeError('任务缺少页面或修改说明');
  }
  const { x, y, w, h } = task.rect ?? {};
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1920 || y + h > 1080) {
    throw new RangeError('区域必须位于 1920×1080 画布内');
  }
  if (!persisted && 'attachments' in task) {
    throw new TypeError('请求任务不得直接提供 attachments');
  }
  if (persisted && Object.hasOwn(task, 'attachments')) {
    if (!Array.isArray(task.attachments)) throw new TypeError('持久化 attachments 必须是数组');
    if (task.attachments.length > MAX_ATTACHMENTS) {
      throw new RangeError(`每个任务最多 ${MAX_ATTACHMENTS} 个附件`);
    }
    const ids = new Set();
    const paths = new Set();
    const attachments = task.attachments.map(attachment => validateAttachmentMetadata(attachment, task.id));
    for (const attachment of attachments) {
      if (ids.has(attachment.id) || paths.has(attachment.relativePath)) {
        throw new TypeError('持久化 attachments 不得重复');
      }
      ids.add(attachment.id);
      paths.add(attachment.relativePath);
    }
    task.attachments = attachments;
  }
  return task;
}

export function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('动作必须为对象');
  }
  if (typeof action.id !== 'string' || action.id.length === 0) {
    throw new TypeError('动作缺少 id');
  }
  if (!ACTION_KINDS.has(action.kind)) {
    throw new TypeError(`不支持的动作: ${action.kind}`);
  }
  if (!action.target?.pageKey || !action.target?.path) {
    throw new TypeError('动作缺少目标定位器');
  }
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new TypeError('动作 payload 必须为对象');
  }
  if (action.kind === 'setText' && typeof payload.text !== 'string') {
    throw new TypeError('setText.text 必须为字符串');
  }
  if (action.kind === 'translate'
    && (![payload.x, payload.y].every(Number.isFinite)
      || Object.keys(payload).some(key => !['x', 'y'].includes(key)))) {
    throw new TypeError('translate 只接受有限数 x/y');
  }
  if (action.kind === 'resize') {
    const keys = Object.keys(payload);
    const scaleOnly = keys.length === 1 && Number.isFinite(payload.scale) && payload.scale > 0;
    const sizeOnly = keys.length === 2
      && keys.every(key => ['width', 'height'].includes(key))
      && Number.isFinite(payload.width) && payload.width > 0
      && Number.isFinite(payload.height) && payload.height > 0;
    if (!scaleOnly && !sizeOnly) {
      throw new TypeError('resize 只接受正数 scale 或 width/height');
    }
  }
  if (action.kind === 'setStyle') {
    const allowed = new Set(['color', 'background-color', 'font-size', 'font-weight', 'opacity']);
    if (!allowed.has(payload.property) || typeof payload.value !== 'string') {
      throw new TypeError('setStyle 属性不在白名单内');
    }
  }
  if (action.kind === 'hide' && Object.keys(payload).length !== 0) {
    throw new TypeError('hide payload 必须为空对象');
  }
  if (action.kind === 'show'
    && (Object.keys(payload).some(key => key !== 'display')
      || (payload.display !== undefined && typeof payload.display !== 'string'))) {
    throw new TypeError('show.display 必须为字符串');
  }
  return action;
}

export function hasCanonicalValues(action) {
  if (!Object.hasOwn(action, 'before') || !Object.hasOwn(action, 'after')) return false;
  if (action.kind === 'setText' || action.kind === 'setStyle'
    || action.kind === 'hide' || action.kind === 'show') {
    if (typeof action.before !== 'string' || typeof action.after !== 'string') return false;
    if (action.kind === 'setText') return action.after === action.payload.text;
    if (action.kind === 'setStyle') return action.after === action.payload.value;
    if (action.kind === 'hide') return action.after === 'none';
    return action.after === (action.payload.display ?? '');
  }
  if (action.kind === 'translate') {
    const valid = value => (
      value && typeof value === 'object' && !Array.isArray(value)
      && Number.isFinite(value.x) && Number.isFinite(value.y)
      && Object.keys(value).every(key => ['x', 'y'].includes(key))
    );
    return valid(action.before) && valid(action.after)
      && action.after.x === action.payload.x && action.after.y === action.payload.y;
  }
  if (action.kind === 'resize') {
    const branch = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === 'scale'
        && Number.isFinite(value.scale) && value.scale > 0) return 'scale';
      if (keys.length === 2 && keys.every(key => ['width', 'height'].includes(key))
        && Number.isFinite(value.width) && value.width > 0
        && Number.isFinite(value.height) && value.height > 0) return 'size';
      return null;
    };
    const payloadBranch = branch(action.payload);
    if (!payloadBranch || branch(action.before) !== payloadBranch
      || branch(action.after) !== payloadBranch) return false;
    return payloadBranch === 'scale'
      ? action.after.scale === action.payload.scale
      : action.after.width === action.payload.width && action.after.height === action.payload.height;
  }
  return false;
}
