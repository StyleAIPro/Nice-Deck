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

function isRegionMode() {
  try {
    const control = parent.document.querySelector('[data-mode="region"]');
    if (control) return control.getAttribute('aria-pressed') === 'true';
  } catch {
    // 跨源嵌入时退回已确认的 postMessage 状态。
  }
  return mode === 'region';
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

function onPointerDown(event) {
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
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  dragging.current = { x: event.clientX, y: event.clientY };
  setBox(dragging.selection, regionFromPoints(dragging.start, dragging.current, dragging.bounds));
  event.preventDefault();
}

function finishPointer(event) {
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

function onParentMessage(event) {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'show-page' && typeof event.data.pageKey === 'string') {
    showPage(event.data.pageKey);
    return;
  }
  if (event.data?.type === 'set-editor-mode' && ['preview', 'region'].includes(event.data.mode)) {
    mode = event.data.mode;
    document.documentElement.style.cursor = mode === 'region' ? 'crosshair' : '';
    if (mode !== 'region') removePopover();
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
  dragging?.selection.remove();
  dragging = null;
  removePopover();
  document.querySelector('[data-task-highlight]')?.remove();
  style.remove();
  document.documentElement.style.cursor = '';
  window.removeEventListener('message', onParentMessage);
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('pointerup', finishPointer, true);
  window.removeEventListener('pointercancel', cancelPointer, true);
  window.removeEventListener('pagehide', teardown);
}

if (parent !== window) {
  window.addEventListener('message', onParentMessage);
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
