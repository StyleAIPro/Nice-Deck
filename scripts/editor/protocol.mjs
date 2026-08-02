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

export function makePageKey(index, label, html) {
  const digest = stableHash(`${index}\0${label}\0${html}`);
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

export function validateTask(task) {
  if (!task.pageKey || !task.instruction?.trim()) {
    throw new TypeError('任务缺少页面或修改说明');
  }
  const { x, y, w, h } = task.rect ?? {};
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1920 || y + h > 1080) {
    throw new RangeError('区域必须位于 1920×1080 画布内');
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
