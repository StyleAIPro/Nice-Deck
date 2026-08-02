import { normalizeRect } from '/editor/protocol.mjs';

async function ensurePatchRuntime() {
  if (window.HuaweiDeckPatchRuntime) return window.HuaweiDeckPatchRuntime;
  window.__HuaweiDeckPatchRuntimeLoading ??= new Promise((resolvePromise, reject) => {
    const existing = [...document.scripts].find(script => {
      if (!script.src) return false;
      return new URL(script.src, document.baseURI).pathname === '/editor/patch-runtime.js';
    });
    const script = existing ?? Object.assign(document.createElement('script'), {
      src: '/editor/patch-runtime.js',
    });
    const finish = () => {
      if (window.HuaweiDeckPatchRuntime) resolvePromise(window.HuaweiDeckPatchRuntime);
      else reject(new Error('补丁运行时加载失败'));
    };
    if (existing) {
      if (window.HuaweiDeckPatchRuntime) finish();
      else {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', reject, { once: true });
      }
      return;
    }
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', reject, { once: true });
    document.head.append(script);
  });
  return window.__HuaweiDeckPatchRuntimeLoading;
}

function waitForCanvases() {
  const find = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const current = find();
  if (current.length) return Promise.resolve(current);
  return new Promise(resolvePromise => {
    const observer = new MutationObserver(() => {
      const canvases = find();
      if (!canvases.length) return;
      observer.disconnect();
      resolvePromise(canvases);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

const [runtime, canvases] = await Promise.all([ensurePatchRuntime(), waitForCanvases()]);
let mode = 'preview';
let dragging = null;
let activePopover = null;
let highlightTimer;
let tornDown = false;
let directEdit = null;
let transformDrag = null;
let transformSelection = null;
const pendingManual = new Map();
const tentativeCommands = new Map();
let statusTimer;
const INTERACTIVE_TRANSFORM_SELECTOR = 'svg,a,button,input,select,textarea,iframe,[role="button"],.layer-panel';

const style = document.createElement('style');
style.dataset.deckEditorUi = '';
style.textContent = `
  [data-region-selection],[data-task-highlight]{position:fixed;z-index:2147483638;pointer-events:none;box-sizing:border-box}
  [data-region-selection]{border:2px solid #c7000b;background:rgba(199,0,11,.08);box-shadow:0 0 0 1px rgba(255,255,255,.85) inset}
  [data-region-popover]{position:fixed;z-index:2147483640;width:336px;padding:16px;border:1px solid rgba(25,25,25,.16);border-radius:12px;background:#fff;color:#191919;box-shadow:0 14px 38px rgba(25,25,25,.24);box-sizing:border-box;font:14px/1.45 "Huawei Sans","HarmonyOS Sans SC","PingFang SC",sans-serif;transform-origin:0 0}
  [data-region-popover] label{display:block;margin-bottom:8px;font-size:12px;font-weight:700;color:#5f6268}
  [data-region-popover] textarea{display:block;width:100%;min-height:88px;resize:vertical;padding:10px 11px;border:1px solid #c9cbd0;border-radius:8px;outline:none;color:#191919;background:#fff;font:inherit;font-size:14px;line-height:1.5;box-sizing:border-box}
  [data-region-popover] textarea:focus{border-color:#c7000b;box-shadow:0 0 0 3px rgba(199,0,11,.10)}
  [data-region-actions]{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px}
  [data-region-actions] button{min-height:34px;padding:0 14px;border-radius:7px;border:1px solid #d7d8dc;background:#fff;color:#34363a;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  [data-region-actions] [data-region-submit]{border-color:#c7000b;background:#c7000b;color:#fff}
  [data-region-actions] button:disabled{cursor:wait;opacity:.55}
  [data-region-status]{min-height:18px;margin:8px 0 0;color:#777b82;font-size:12px}
  [data-region-status][data-state="error"]{color:#b42318}
  [data-region-status][data-state="success"]{color:#16803b}
  [data-task-highlight]{border:3px dashed #e60012;background:rgba(230,0,18,.08);animation:deck-editor-pulse .45s ease-in-out 2 alternate}
  [data-direct-status]{position:fixed;z-index:2147483641;left:50%;bottom:24px;max-width:520px;padding:10px 16px;border-radius:8px;background:#24262b;color:#fff;box-shadow:0 10px 26px rgba(0,0,0,.24);font:600 14px/1.45 "Huawei Sans","HarmonyOS Sans SC","PingFang SC",sans-serif;transform:translateX(-50%);pointer-events:none}
  [data-direct-status][data-state="error"]{background:#8f1018}
  [data-transform-selection]{position:fixed;z-index:2147483637;box-sizing:border-box;border:2px solid #c7000b;background:rgba(199,0,11,.035);pointer-events:none}
  [data-resize-handle]{position:fixed;z-index:2147483640;box-sizing:border-box;border:2px solid #fff;border-radius:3px;background:#c7000b;box-shadow:0 1px 5px rgba(0,0,0,.3);cursor:nwse-resize;touch-action:none}
  [data-direct-editing]{outline-style:solid!important;outline-color:#c7000b!important;outline-width:calc(3px / var(--deck-editor-ui-scale-x,1))!important;outline-offset:calc(3px / var(--deck-editor-ui-scale-x,1));background:rgba(255,255,255,.96)!important;cursor:text!important}
  @keyframes deck-editor-pulse{from{box-shadow:0 0 0 0 rgba(230,0,18,.35)}to{box-shadow:0 0 0 8px rgba(230,0,18,0)}}
`;
document.head.append(style);

function pageInfo(canvas) {
  const index = canvases.indexOf(canvas) + 1;
  return {
    pageKey: runtime.pageKey(canvas),
    pageIndex: index,
    pageLabel: canvas.querySelector('section[data-label]')?.dataset.label ?? `第 ${index} 页`,
  };
}

function showPage(pageKey) {
  finishDirectEdit();
  cancelTransformDrag();
  removeTransformSelection();
  removePopover();
  const canvas = canvases.find(candidate => runtime.pageKey(candidate) === pageKey);
  if (!canvas) {
    parent.postMessage({ type: 'page-shown', pageKey, shown: false, reason: 'PAGE_NOT_FOUND' }, location.origin);
    return null;
  }
  const top = canvas.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top, left: 0, behavior: 'auto' });
  requestAnimationFrame(() => {
    parent.postMessage({ type: 'page-shown', pageKey, shown: true }, location.origin);
  });
  return canvas;
}

function regionFromPoints(start, end, bounds) {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const x1 = clamp(start.x, bounds.left, bounds.right);
  const y1 = clamp(start.y, bounds.top, bounds.bottom);
  const x2 = clamp(end.x, bounds.left, bounds.right);
  const y2 = clamp(end.y, bounds.top, bounds.bottom);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function setBox(node, rect) {
  Object.assign(node.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function frameVisualScale() {
  const frame = window.frameElement;
  if (!frame) return { x: 1, y: 1 };
  const rect = frame.getBoundingClientRect();
  const layoutWidth = frame.offsetWidth || innerWidth;
  const layoutHeight = frame.offsetHeight || innerHeight;
  const x = rect.width / layoutWidth;
  const y = rect.height / layoutHeight;
  return {
    x: Number.isFinite(x) && x > 0 ? x : 1,
    y: Number.isFinite(y) && y > 0 ? y : 1,
  };
}

function updateUiScale() {
  const scale = frameVisualScale();
  document.documentElement.style.setProperty('--deck-editor-ui-scale-x', String(scale.x));
  document.documentElement.style.setProperty('--deck-editor-ui-scale-y', String(scale.y));
  return scale;
}

function elementIsVisible(element, rect, canvas) {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({
    checkOpacity: true,
    checkVisibilityCSS: true,
  })) return false;
  for (let current = element; current && current !== canvas.parentElement; current = current.parentElement) {
    const computed = getComputedStyle(current);
    if (computed.display === 'none' || computed.visibility === 'hidden'
      || computed.contentVisibility === 'hidden' || Number(computed.opacity || 1) <= 0) {
      return false;
    }
  }
  return true;
}

function rankCandidates(canvas, region) {
  const canvasRect = canvas.getBoundingClientRect();
  const canvasArea = Math.max(1, canvasRect.width * canvasRect.height);
  const intersectionArea = rect => (
    Math.max(0, Math.min(rect.right, region.right) - Math.max(rect.left, region.left))
    * Math.max(0, Math.min(rect.bottom, region.bottom) - Math.max(rect.top, region.top))
  );
  return [...canvas.querySelectorAll('h1,h2,h3,h4,p,span,img,svg,table,[class]')]
    .filter(element => !element.closest('[data-deck-editor-ui]'))
    .filter(element => !element.matches('.stage,.slide-canvas')
      && !element.querySelector('.stage,.slide-canvas'))
    .map(element => {
      const rect = element.getBoundingClientRect();
      const contentElement = element.matches('img,svg,table');
      const layoutContainer = !contentElement && (
        (rect.width >= canvasRect.width * 0.85 && rect.height >= canvasRect.height * 0.85)
        || rect.width * rect.height >= canvasArea * 0.8
      );
      const visible = elementIsVisible(element, rect, canvas);
      return {
        element,
        rect,
        visible,
        layoutContainer,
        score: intersectionArea(rect) / Math.max(1, rect.width * rect.height),
      };
    })
    .filter(item => item.visible && !item.layoutContainer && item.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(item => {
      try {
        return runtime.makeLocator(item.element);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function removePopover() {
  if (!activePopover) return;
  activePopover.selection.remove();
  activePopover.popover.remove();
  activePopover = null;
}

function effectiveMode() {
  try {
    const pending = parent.document.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode;
    // confirmed mode 是主状态；父页值只覆盖消息派发尚未抵达的模式切换窗口。
    if (pending && pending !== mode) return pending;
  } catch {
    // 跨源时只使用 confirmed postMessage 状态。
  }
  return mode;
}

function isRegionMode() {
  return effectiveMode() === 'region';
}

function positionPopover(popover, region) {
  const scale = frameVisualScale();
  const gapX = 12 / scale.x;
  const marginX = 8 / scale.x;
  const marginY = 8 / scale.y;
  const width = popover.offsetWidth / scale.x;
  const height = popover.offsetHeight / scale.y;
  popover.style.transform = `scale(${1 / scale.x}, ${1 / scale.y})`;
  popover.dataset.screenScaleX = String(scale.x);
  popover.dataset.screenScaleY = String(scale.y);
  let left;
  let top;
  let placement;
  if (region.right + gapX + width <= innerWidth - marginX) {
    left = region.right + gapX;
    top = Math.max(marginY, Math.min(innerHeight - height - marginY, region.top));
    placement = 'right';
  } else if (region.left - gapX - width >= marginX) {
    left = region.left - gapX - width;
    top = Math.max(marginY, Math.min(innerHeight - height - marginY, region.top));
    placement = 'left';
  } else {
    left = Math.max(marginX, Math.min(innerWidth - width - marginX, region.right - width));
    top = Math.max(marginY, Math.min(innerHeight - height - marginY, region.bottom - height));
    placement = 'inside';
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.visibility = 'visible';
  popover.dataset.placement = placement;
}

async function captureSnapshot(canvas, rect) {
  try {
    if (typeof window.html2canvas !== 'function') throw new Error('html2canvas unavailable');
    const rendered = await window.html2canvas(canvas, {
      backgroundColor: null,
      scale: 0.5,
      logging: false,
    });
    const crop = document.createElement('canvas');
    crop.width = Math.ceil(rect.w * 0.5);
    crop.height = Math.ceil(rect.h * 0.5);
    crop.getContext('2d').drawImage(
      rendered,
      rect.x * 0.5,
      rect.y * 0.5,
      rect.w * 0.5,
      rect.h * 0.5,
      0,
      0,
      crop.width,
      crop.height,
    );
    return crop.toDataURL('image/png');
  } catch {
    return null;
  }
}

function openPopover(canvas, screenRect, candidates) {
  removePopover();
  const selection = document.createElement('div');
  selection.dataset.deckEditorUi = '';
  selection.dataset.regionSelection = '';
  setBox(selection, screenRect);
  const popover = document.createElement('form');
  popover.dataset.deckEditorUi = '';
  popover.dataset.regionPopover = '';
  popover.style.visibility = 'hidden';
  const label = document.createElement('label');
  label.textContent = '说明希望 Agent 如何修改这一区域';
  const textarea = document.createElement('textarea');
  textarea.placeholder = '例如：把标题缩短，并将数据卡片改成红色强调';
  textarea.required = true;
  label.append(textarea);
  const status = document.createElement('p');
  status.dataset.regionStatus = '';
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.dataset.regionActions = '';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.dataset.regionCancel = '';
  cancel.textContent = '取消';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.dataset.regionSubmit = '';
  submit.textContent = '添加任务';
  actions.append(cancel, submit);
  popover.append(label, status, actions);
  document.body.append(selection, popover);
  positionPopover(popover, screenRect);
  textarea.focus({ preventScroll: true });

  const normalized = normalizeRect(screenRect, canvas.getBoundingClientRect());
  const requestId = crypto.randomUUID();
  activePopover = { canvas, selection, popover, requestId, submitting: false };

  const cancelPopover = () => {
    if (!activePopover?.submitting) removePopover();
  };
  cancel.addEventListener('click', cancelPopover);
  popover.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelPopover();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      popover.requestSubmit();
    }
  });
  popover.addEventListener('submit', async event => {
    event.preventDefault();
    const instruction = textarea.value.trim();
    if (!instruction || activePopover?.submitting) {
      if (!instruction) textarea.focus();
      return;
    }
    activePopover.submitting = true;
    textarea.disabled = true;
    cancel.disabled = true;
    submit.disabled = true;
    submit.textContent = '正在提交…';
    status.dataset.state = 'pending';
    status.textContent = '正在生成区域快照…';
    const snapshot = await captureSnapshot(canvas, normalized);
    if (!snapshot) status.textContent = '区域截图失败，将继续提交无快照任务。';
    else status.textContent = '正在记录任务…';
    parent.postMessage({
      type: 'create-region-task',
      requestId,
      payload: {
        ...pageInfo(canvas),
        rect: normalized,
        instruction,
        candidates,
      },
      snapshot,
    }, location.origin);
  });
}

function showStatus(message, state = 'info') {
  clearTimeout(statusTimer);
  document.querySelector('[data-direct-status]')?.remove();
  const status = document.createElement('div');
  status.dataset.deckEditorUi = '';
  status.dataset.directStatus = '';
  status.dataset.state = state;
  status.setAttribute('role', 'status');
  status.textContent = message;
  document.body.append(status);
  statusTimer = setTimeout(() => status.remove(), state === 'error' ? 4200 : 1800);
}

function submitManualActions(actions, onResult = () => {}) {
  const requestId = crypto.randomUUID();
  pendingManual.set(requestId, onResult);
  parent.postMessage({ type: 'submit-manual-actions', requestId, actions }, location.origin);
}

function manualFailureMessage(result, fallback) {
  const details = [];
  if (result.failedActionId) details.push(`动作 ${result.failedActionId}`);
  if (Array.isArray(result.candidates) && result.candidates.length) {
    details.push(`${result.candidates.length} 个候选位置`);
  }
  const suffix = details.length ? `（${details.join('，')}）` : '';
  return `${result.message || fallback}${suffix}`;
}

function manualSuccessMessage(result, fallback) {
  if (result.syncPending) return result.message || '动作已保存、同步待确认';
  if (result.commitConfirmed === false && result.recoveredBySync) return '动作已保存并恢复同步';
  return fallback;
}

function textTargetFromEvent(event) {
  const semantic = event.target.closest?.('h1,h2,h3,h4,h5,h6,p,li,td,th');
  if (semantic) return semantic;
  const leaf = event.target.closest?.('span,div');
  if (leaf?.parentElement?.closest('.slide-canvas') && leaf.parentElement.children.length > 1) {
    return leaf.parentElement;
  }
  return leaf;
}

function textRejection(element) {
  if (!element || !element.closest('.slide-canvas')) return '请在页面文字上双击';
  if (element.closest('[data-deck-editor-ui],button,a,input,textarea,select,[role="button"],.layer-panel')
    || element.matches('svg,iframe') || element.querySelector('svg,iframe,.layer-panel')) {
    return '该元素包含交互或复杂组件，请改用区域标记';
  }
  if (element.children.length > 0) return '该文字包含复杂富文本结构，请改用区域标记';
  return null;
}

function finishDirectEdit({ restore = true } = {}) {
  if (!directEdit) return;
  const state = directEdit;
  directEdit = null;
  if (restore) state.element.textContent = state.originalText;
  state.element.removeAttribute('contenteditable');
  delete state.element.dataset.directEditing;
  state.element.spellcheck = state.originalSpellcheck;
  state.resumeReplay?.();
}

function commitDirectEdit() {
  if (!directEdit || directEdit.committing) return;
  directEdit.committing = true;
  const state = directEdit;
  const nextText = state.element.textContent ?? '';
  finishDirectEdit({ restore: true });
  if (!nextText.trim() || nextText === state.originalText) return;
  const action = {
    id: crypto.randomUUID(), taskId: null, target: state.target,
    kind: 'setText', payload: { text: nextText },
  };
  showStatus('正在应用文字修改…');
  submitManualActions([action], result => {
    if (result.ok) showStatus(manualSuccessMessage(result, '文字修改已记录'));
    else showStatus(manualFailureMessage(result, '文字修改失败，原文已恢复'), 'error');
  });
}

function onDoubleClick(event) {
  if (effectiveMode() !== 'text') return;
  const element = textTargetFromEvent(event);
  const rejection = textRejection(element);
  if (rejection) {
    showStatus(rejection, 'error');
    event.preventDefault();
    return;
  }
  finishDirectEdit();
  let target;
  try { target = runtime.makeLocator(element); }
  catch { showStatus('无法定位该文字，请改用区域标记', 'error'); return; }
  directEdit = {
    element, target, originalText: element.textContent ?? '',
    originalSpellcheck: element.spellcheck, committing: false,
    resumeReplay: runtime.suspendTarget?.(target),
  };
  element.setAttribute('contenteditable', 'plaintext-only');
  element.dataset.directEditing = '';
  element.spellcheck = false;
  updateUiScale();
  element.focus({ preventScroll: true });
  const selection = getSelection();
  selection?.selectAllChildren(element);
  showStatus('Cmd/Ctrl+Enter 提交 · Escape 取消');
  event.preventDefault();
}

function editableTransformTarget(event) {
  const canvas = event.target.closest?.('.slide-canvas');
  if (!canvas || !canvases.includes(canvas) || event.target.closest?.('[data-deck-editor-ui]')) return null;
  const interactive = event.target.closest?.(INTERACTIVE_TRANSFORM_SELECTOR);
  if (interactive && interactive.closest('.slide-canvas') === canvas) return interactive;
  const element = event.target.closest?.('h1,h2,h3,h4,h5,h6,p,li,span,img,svg,table,.card,[class]');
  if (!element || element.closest('.slide-canvas') !== canvas) return null;
  if (element.matches('.stage,.slide-canvas') || element.querySelector('.stage,.slide-canvas')) return null;
  return element;
}

function currentTranslate(element) {
  const computed = getComputedStyle(element).translate;
  const [x = '0', y = '0'] = (computed && computed !== 'none' ? computed : '0px 0px').split(/\s+/);
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

function removeTransformSelection() {
  transformSelection?.overlay.remove();
  transformSelection?.handle?.remove();
  transformSelection = null;
}

function positionTransformSelection() {
  if (!transformSelection?.element.isConnected) return removeTransformSelection();
  const rect = transformSelection.element.getBoundingClientRect();
  setBox(transformSelection.overlay, rect);
  if (!transformSelection.handle) return;
  const scale = frameVisualScale();
  const width = 14 / scale.x;
  const height = 14 / scale.y;
  setBox(transformSelection.handle, {
    left: rect.right - width / 2,
    top: rect.bottom - height / 2,
    width,
    height,
  });
  transformSelection.handle.dataset.screenSize = '14';
}

function selectTransformElement(element, withHandle) {
  removeTransformSelection();
  const overlay = document.createElement('div');
  overlay.dataset.deckEditorUi = '';
  overlay.dataset.transformSelection = '';
  let handle = null;
  if (withHandle) {
    handle = document.createElement('div');
    handle.dataset.deckEditorUi = '';
    handle.dataset.resizeHandle = '';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', '拖动缩放元素');
  }
  document.body.append(overlay);
  if (handle) document.body.append(handle);
  transformSelection = { element, overlay, handle };
  positionTransformSelection();
}

function restoreTransformPreview(state) {
  if (state.kind === 'translate') {
    if (state.originalTranslate) state.element.style.translate = state.originalTranslate;
    else state.element.style.removeProperty('translate');
  } else if (state.scaleTarget) {
    if (state.originalScale) state.element.style.scale = state.originalScale;
    else state.element.style.removeProperty('scale');
  } else {
    if (state.originalWidth) state.element.style.width = state.originalWidth;
    else state.element.style.removeProperty('width');
    if (state.originalHeight) state.element.style.height = state.originalHeight;
    else state.element.style.removeProperty('height');
  }
  positionTransformSelection();
}

function cancelTransformDrag() {
  if (!transformDrag) return;
  const state = transformDrag;
  transformDrag = null;
  state.capture?.releasePointerCapture?.(state.pointerId);
  restoreTransformPreview(state);
}

function beginMove(event, element) {
  let target;
  try { target = runtime.makeLocator(element); } catch { return; }
  const canvas = element.closest('.slide-canvas');
  selectTransformElement(element, false);
  transformDrag = {
    kind: 'translate', pointerId: event.pointerId, capture: element, element, target, canvas,
    start: { x: event.clientX, y: event.clientY }, base: currentTranslate(element),
    current: currentTranslate(element), originalTranslate: element.style.translate,
  };
  element.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function isScaleTarget(element) {
  return element.matches(INTERACTIVE_TRANSFORM_SELECTOR)
    || Boolean(element.querySelector(INTERACTIVE_TRANSFORM_SELECTOR));
}

function beginResize(event) {
  if (!transformSelection?.element) return;
  const element = transformSelection.element;
  let target;
  try { target = runtime.makeLocator(element); } catch { return; }
  const rect = element.getBoundingClientRect();
  const scaleTarget = isScaleTarget(element);
  transformDrag = {
    kind: 'resize', pointerId: event.pointerId, capture: event.target, element, target,
    canvas: element.closest('.slide-canvas'), start: { x: event.clientX, y: event.clientY },
    scaleTarget, changed: false,
    baseScale: Number.parseFloat(getComputedStyle(element).scale) || 1,
    baseSize: { width: rect.width, height: rect.height },
    current: scaleTarget ? { scale: Number.parseFloat(getComputedStyle(element).scale) || 1 }
      : { width: rect.width, height: rect.height },
    originalScale: element.style.scale, originalWidth: element.style.width,
    originalHeight: element.style.height,
  };
  event.target.setPointerCapture?.(event.pointerId);
  event.preventDefault();
  event.stopPropagation();
}

function onTransformPointerMove(event) {
  if (!transformDrag || event.pointerId !== transformDrag.pointerId) return false;
  const state = transformDrag;
  const bounds = state.canvas.getBoundingClientRect();
  const dx = (event.clientX - state.start.x) * 1920 / bounds.width;
  const dy = (event.clientY - state.start.y) * 1080 / bounds.height;
  if (state.kind === 'translate') {
    state.current = { x: Math.round(state.base.x + dx), y: Math.round(state.base.y + dy) };
    state.element.style.translate = `${state.current.x}px ${state.current.y}px`;
  } else if (state.scaleTarget) {
    const delta = Math.max(dx / Math.max(1, state.baseSize.width), dy / Math.max(1, state.baseSize.height));
    state.current = { scale: Math.max(.1, Math.round(state.baseScale * (1 + delta) * 1000) / 1000) };
    state.element.style.scale = String(state.current.scale);
  } else {
    state.current = {
      width: Math.max(1, Math.round(state.baseSize.width + dx)),
      height: Math.max(1, Math.round(state.baseSize.height + dy)),
    };
    state.element.style.width = `${state.current.width}px`;
    state.element.style.height = `${state.current.height}px`;
  }
  state.changed = Math.abs(dx) >= 1 || Math.abs(dy) >= 1;
  positionTransformSelection();
  event.preventDefault();
  return true;
}

function finishTransformPointer(event) {
  if (!transformDrag || event.pointerId !== transformDrag.pointerId) return false;
  const state = transformDrag;
  transformDrag = null;
  state.capture?.releasePointerCapture?.(state.pointerId);
  restoreTransformPreview(state);
  if (!state.changed && state.kind === 'resize') return true;
  if (state.kind === 'translate'
    && state.current.x === state.base.x && state.current.y === state.base.y) return true;
  const action = {
    id: crypto.randomUUID(), taskId: null, target: state.target,
    kind: state.kind, payload: state.current,
  };
  submitManualActions([action], result => {
    if (result.ok && (result.syncPending || result.recoveredBySync)) {
      showStatus(manualSuccessMessage(result, '变换已记录'));
    } else if (!result.ok) showStatus(manualFailureMessage(result, '变换失败，已恢复原状态'), 'error');
    positionTransformSelection();
  });
  event.preventDefault();
  return true;
}

function onPointerDown(event) {
  const currentMode = effectiveMode();
  if (currentMode === 'resize' && event.target.closest?.('[data-resize-handle]')) {
    beginResize(event);
    return;
  }
  if (currentMode === 'move' && event.button === 0) {
    const element = editableTransformTarget(event);
    if (element) beginMove(event, element);
    return;
  }
  if (currentMode === 'resize' && event.button === 0) {
    const element = editableTransformTarget(event);
    if (element) {
      selectTransformElement(element, true);
      event.preventDefault();
    }
    return;
  }
  if (!isRegionMode() || activePopover?.submitting
    || event.button !== 0 || event.target.closest?.('[data-deck-editor-ui]')) return;
  const canvas = event.target.closest?.('.slide-canvas');
  if (!canvas || !canvases.includes(canvas)) return;
  removePopover();
  const bounds = canvas.getBoundingClientRect();
  dragging = {
    pointerId: event.pointerId,
    canvas,
    bounds,
    start: { x: event.clientX, y: event.clientY },
    current: { x: event.clientX, y: event.clientY },
    selection: document.createElement('div'),
  };
  dragging.selection.dataset.deckEditorUi = '';
  dragging.selection.dataset.regionSelection = '';
  document.body.append(dragging.selection);
  setBox(dragging.selection, regionFromPoints(dragging.start, dragging.current, bounds));
  canvas.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event) {
  if (onTransformPointerMove(event)) return;
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  dragging.current = { x: event.clientX, y: event.clientY };
  setBox(dragging.selection, regionFromPoints(dragging.start, dragging.current, dragging.bounds));
  event.preventDefault();
}

function finishPointer(event) {
  if (finishTransformPointer(event)) return;
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  const state = dragging;
  dragging = null;
  state.current = { x: event.clientX, y: event.clientY };
  state.canvas.releasePointerCapture?.(event.pointerId);
  const region = regionFromPoints(state.start, state.current, state.bounds);
  state.selection.remove();
  const visualScale = frameVisualScale();
  if (region.width * visualScale.x + 0.01 < 6 || region.height * visualScale.y + 0.01 < 6) return;
  const candidates = rankCandidates(state.canvas, region);
  openPopover(state.canvas, region, candidates);
  event.preventDefault();
}

function cancelPointer(event) {
  if (transformDrag && event.pointerId === transformDrag.pointerId) {
    cancelTransformDrag();
    return;
  }
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  const state = dragging;
  dragging = null;
  state.canvas.releasePointerCapture?.(event.pointerId);
  state.selection.remove();
}

function locateTask(pageKey, rect) {
  const canvas = showPage(pageKey);
  if (!canvas || !rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(highlightTimer);
    document.querySelector('[data-task-highlight]')?.remove();
    const bounds = canvas.getBoundingClientRect();
    const highlight = document.createElement('div');
    highlight.dataset.deckEditorUi = '';
    highlight.dataset.taskHighlight = '';
    setBox(highlight, {
      left: bounds.left + rect.x * bounds.width / 1920,
      top: bounds.top + rect.y * bounds.height / 1080,
      width: rect.w * bounds.width / 1920,
      height: rect.h * bounds.height / 1080,
    });
    document.body.append(highlight);
    highlightTimer = setTimeout(() => highlight.remove(), 1500);
  }));
}

function onKeyDown(event) {
  if (directEdit) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finishDirectEdit();
      showStatus('已取消文字修改');
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitDirectEdit();
    }
    return;
  }
  if (event.key === 'Escape' && (transformDrag || transformSelection)) {
    event.preventDefault();
    cancelTransformDrag();
    removeTransformSelection();
  }
}

function rollbackAllTentative() {
  for (const pending of tentativeCommands.values()) pending.transaction.rollback();
  tentativeCommands.clear();
}

function onParentMessage(event) {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'show-page' && typeof event.data.pageKey === 'string') {
    showPage(event.data.pageKey);
    return;
  }
  if (event.data?.type === 'set-editor-mode'
    && ['preview', 'region', 'text', 'move', 'resize'].includes(event.data.mode)) {
    if (event.data.mode !== mode) {
      finishDirectEdit();
      cancelTransformDrag();
      removeTransformSelection();
    }
    mode = event.data.mode;
    document.documentElement.dataset.deckEditorMode = mode;
    document.documentElement.style.cursor = mode === 'region' ? 'crosshair'
      : (mode === 'move' ? 'move' : '');
    if (mode !== 'region') removePopover();
    return;
  }
  if (event.data?.type === 'apply-actions' && typeof event.data.commandId === 'string') {
    const existing = tentativeCommands.get(event.data.commandId);
    if (existing) {
      parent.postMessage(existing.reply, location.origin);
      return;
    }
    try {
      if (event.data.tentative === true) {
        const transaction = runtime.beginTransaction(event.data.actions, {
          replace:event.data.replace === true,
        });
        const reply = {
          type: 'actions-prepared', commandId: event.data.commandId,
          applied: transaction.results.length, results: transaction.results,
        };
        tentativeCommands.set(event.data.commandId, { transaction, reply });
        parent.postMessage(reply, location.origin);
      } else {
        const results = runtime.applyTransaction(event.data.actions);
        parent.postMessage({
          type: 'actions-applied', commandId: event.data.commandId,
          applied: results.length, results,
        }, location.origin);
      }
    } catch (error) {
      parent.postMessage({
        type: 'actions-rejected', commandId: event.data.commandId,
        code: error.code || error.message || 'ACTION_REJECTED',
        failedActionId: error.failedActionId,
        candidates: Array.isArray(error.candidates) ? error.candidates.slice(0, 5) : [],
      }, location.origin);
    }
    return;
  }
  if (event.data?.type === 'commit-actions' && typeof event.data.commandId === 'string') {
    const pending = tentativeCommands.get(event.data.commandId);
    const committed = pending?.transaction.commit() ?? false;
    tentativeCommands.delete(event.data.commandId);
    parent.postMessage({ type:'actions-committed', commandId:event.data.commandId, committed }, location.origin);
    return;
  }
  if (event.data?.type === 'rollback-actions' && typeof event.data.commandId === 'string') {
    const pending = tentativeCommands.get(event.data.commandId);
    const rolledBack = pending?.transaction.rollback() ?? false;
    tentativeCommands.delete(event.data.commandId);
    parent.postMessage({ type:'actions-rolled-back', commandId:event.data.commandId, rolledBack }, location.origin);
    return;
  }
  if (event.data?.type === 'rollback-all-tentative') {
    rollbackAllTentative();
    return;
  }
  if (event.data?.type === 'sync-actions' && Array.isArray(event.data.actions)) {
    try {
      rollbackAllTentative();
      runtime.applyAll(event.data.actions);
      if (typeof event.data.commandId === 'string') {
        parent.postMessage({ type:'actions-synced', commandId:event.data.commandId }, location.origin);
      }
    }
    catch (error) { showStatus(`会话动作恢复失败：${error.code || error.message}`, 'error'); }
    return;
  }
  if (event.data?.type === 'manual-actions-result'
    && typeof event.data.requestId === 'string') {
    const callback = pendingManual.get(event.data.requestId);
    if (!callback) return;
    pendingManual.delete(event.data.requestId);
    callback(event.data);
    return;
  }
  if (event.data?.type === 'locate-task' && typeof event.data.pageKey === 'string') {
    locateTask(event.data.pageKey, event.data.rect);
    return;
  }
  if (event.data?.type === 'region-task-result'
    && activePopover?.requestId === event.data.requestId) {
    const { popover } = activePopover;
    const status = popover.querySelector('[data-region-status]');
    const submit = popover.querySelector('[data-region-submit]');
    const textarea = popover.querySelector('textarea');
    const cancel = popover.querySelector('[data-region-cancel]');
    if (event.data.ok) {
      const completedPopover = activePopover;
      activePopover.submitting = false;
      status.dataset.state = 'success';
      status.textContent = event.data.snapshotDropped ? '快照过大，已无图添加任务' : '任务已添加';
      submit.textContent = '已添加';
      setTimeout(() => {
        if (activePopover === completedPopover) removePopover();
      }, 350);
    } else {
      activePopover.submitting = false;
      status.dataset.state = 'error';
      status.textContent = event.data.message || '提交失败，请重试';
      textarea.disabled = false;
      cancel.disabled = false;
      submit.disabled = false;
      submit.textContent = '重试';
      textarea.focus({ preventScroll: true });
    }
    return;
  }
  if (event.data?.type === 'editor-teardown') teardown();
}

function teardown() {
  if (tornDown) return;
  tornDown = true;
  clearTimeout(highlightTimer);
  clearTimeout(statusTimer);
  finishDirectEdit();
  cancelTransformDrag();
  removeTransformSelection();
  pendingManual.clear();
  rollbackAllTentative();
  dragging?.selection.remove();
  dragging = null;
  removePopover();
  document.querySelector('[data-task-highlight]')?.remove();
  document.querySelector('[data-direct-status]')?.remove();
  style.remove();
  document.documentElement.style.cursor = '';
  delete document.documentElement.dataset.deckEditorMode;
  document.documentElement.style.removeProperty('--deck-editor-ui-scale-x');
  document.documentElement.style.removeProperty('--deck-editor-ui-scale-y');
  window.removeEventListener('message', onParentMessage);
  window.removeEventListener('dblclick', onDoubleClick, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('pointerup', finishPointer, true);
  window.removeEventListener('pointercancel', cancelPointer, true);
  window.removeEventListener('pagehide', teardown);
}

if (parent !== window) {
  window.addEventListener('message', onParentMessage);
  window.addEventListener('dblclick', onDoubleClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', finishPointer, true);
  window.addEventListener('pointercancel', cancelPointer, true);
  window.addEventListener('pagehide', teardown);
  parent.postMessage({
    type: 'deck-ready',
    pages: canvases.map((canvas, index) => ({
      index: index + 1,
      label: canvas.querySelector('section[data-label]')?.dataset.label ?? `第 ${index + 1} 页`,
      pageKey: runtime.pageKey(canvas),
    })),
  }, location.origin);
}
