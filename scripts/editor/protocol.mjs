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
  const sx = 1920 / canvas.width;
  const sy = 1080 / canvas.height;
  const x = Math.max(0, Math.min(1920, Math.round((rect.left - canvas.left) * sx)));
  const y = Math.max(0, Math.min(1080, Math.round((rect.top - canvas.top) * sy)));
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
  if (!ACTION_KINDS.has(action.kind)) {
    throw new TypeError(`不支持的动作: ${action.kind}`);
  }
  if (!action.target?.pageKey || !action.target?.path) {
    throw new TypeError('动作缺少目标定位器');
  }
  return action;
}
