import { normalizeRect } from '/editor/protocol.mjs';
import {
  MAX_ATTACHMENTS,
  validateFileLike,
} from '/editor/attachment-protocol.mjs';

const FRAME_INSTANCE_ID = crypto.randomUUID();
const RUNTIME_CONTRACT = Object.freeze({
  brand:'com.huawei.deck.visual-editor.patch-runtime',
  schema:1,
  version:'1.0.0',
  api:'pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,pendingTransactionCount,activeActionCount,suspendedTargetCount',
});

function runtimeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function validatePatchRuntime(runtime) {
  const seen = runtime?.contract;
  const compatible = seen?.brand === RUNTIME_CONTRACT.brand
    && seen.schema === RUNTIME_CONTRACT.schema
    && seen.version === RUNTIME_CONTRACT.version
    && seen.api === RUNTIME_CONTRACT.api
    && RUNTIME_CONTRACT.api.split(',').every(name => typeof runtime[name] === 'function');
  if (compatible) return runtime;
  throw runtimeError(seen?.brand === RUNTIME_CONTRACT.brand
    ? 'RUNTIME_INCOMPATIBLE' : 'RUNTIME_GLOBAL_CONFLICT');
}

function abortError() {
  return new DOMException('页面已卸载', 'AbortError');
}

async function ensurePatchRuntime(signal) {
  if (signal.aborted) throw abortError();
  if (window.HuaweiDeckPatchRuntime) return validatePatchRuntime(window.HuaweiDeckPatchRuntime);
  window.__HuaweiDeckPatchRuntimeLoading ??= new Promise((resolvePromise, reject) => {
    const existing = [...document.scripts].find(script => {
      if (!script.src) return false;
      return new URL(script.src, document.baseURI).pathname === '/editor/patch-runtime.js';
    });
    const script = existing ?? Object.assign(document.createElement('script'), {
      src: '/editor/patch-runtime.js',
    });
    const finish = () => {
      try {
        if (window.HuaweiDeckPatchRuntime) resolvePromise(validatePatchRuntime(window.HuaweiDeckPatchRuntime));
        else reject(runtimeError('RUNTIME_LOAD_FAILED', '补丁运行时加载失败'));
      } catch (error) {
        reject(error);
      }
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
  return Promise.race([
    window.__HuaweiDeckPatchRuntimeLoading,
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once:true })),
  ]);
}

const startupController = new AbortController();
const abortStartup = () => startupController.abort();
window.addEventListener('pagehide', abortStartup, { once:true });

let runtime;
try {
  runtime = await ensurePatchRuntime(startupController.signal);
} catch (error) {
  if (error.name !== 'AbortError') {
    parent.postMessage({
      type:'deck-error',
      code:error.code || 'RUNTIME_LOAD_FAILED',
      message:error.message || '补丁运行时加载失败',
    }, location.origin);
  }
  window.removeEventListener('pagehide', abortStartup);
}

if (runtime) {
let canvases = [];
let mode = 'preview';
let dragging = null;
let activePopover = null;
let highlightTimer;
let tornDown = false;
let directEdit = null;
let transformDrag = null;
let transformSelection = null;
let textRangeSelection = null;
const pendingManual = new Map();
const tentativeCommands = new Map();
let statusTimer;
let canvasMonitor;
let requiresAuthoritativeReload = false;
let authoritativeReloadRequested = false;
let authoritativeReloadRequestSequence = 0;
const INTERACTIVE_TRANSFORM_SELECTOR = 'svg,a,button,input,select,textarea,iframe,[role="button"],.layer-panel';
const EDIT_MODE_ALIASES = new Set(['edit', 'text', 'move', 'resize']);
const INSPECTOR_STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'opacity',
  'border-color', 'border-width', 'border-style', 'fill', 'stroke', 'stroke-width',
]);

function canonicalMode(value) {
  return EDIT_MODE_ALIASES.has(value) ? 'edit' : value;
}

function structuralSignature(canvas) {
  const source = canvas.querySelector('section[data-label]') ?? canvas;
  const structure = [source, ...source.querySelectorAll('*')].map(node => (
    `${node.tagName}:${node.childElementCount}:${node.dataset.label ?? ''}:${node.dataset.idx ?? ''}`
  )).join('|');
  return `${runtime.pageKey(canvas)}\0${structure}`;
}

function createCanvasMonitor(onPublish, signal, onObserved = () => {}) {
  const QUIET_MS = 100;
  const MAX_WAIT_MS = 1_200;
  const capture = () => {
    const nextCanvases = [...document.querySelectorAll('.stage .slide-canvas')];
    return {
      stage:nextCanvases[0]?.closest('.stage') ?? document.querySelector('.stage'),
      canvases:nextCanvases,
      signatures:nextCanvases.map(structuralSignature),
    };
  };
  const same = (left, right) => Boolean(left && right)
    && left.canvases.length === right.canvases.length
    && left.canvases.every((canvas, index) => (
      canvas === right.canvases[index]
      && canvas.isConnected
      && left.signatures[index] === right.signatures[index]
    ));
  const sameReferences = (left, right) => Boolean(left && right)
    && left.canvases.length === right.canvases.length
    && left.canvases.every((canvas, index) => canvas === right.canvases[index]);
  const mutationTouchesStage = record => record.target?.closest?.('.stage')
    || [...record.addedNodes, ...record.removedNodes].some(node => (
      node.nodeType === Node.ELEMENT_NODE
      && (node.matches?.('.stage,.slide-canvas') || node.querySelector?.('.stage,.slide-canvas'))
    ));
  let candidate;
  let published;
  let observedStage;
  let quietTimer;
  let maxTimer;
  let bootstrapTimer;
  let stopped = false;
  const stageObserver = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.type !== 'attributes') return true;
      return !['style', 'class', 'hidden', 'contenteditable', 'spellcheck', 'data-active',
        'data-shown', 'data-direct-editing'].includes(record.attributeName)
        && !record.attributeName.startsWith('aria-');
    });
    if (relevant) consider();
  });
  const bindStage = stage => {
    if (stage === observedStage) return;
    stageObserver.disconnect();
    observedStage = stage;
    if (stage) stageObserver.observe(stage, {
      attributes:true, childList:true, characterData:true, subtree:true,
    });
  };
  const publish = () => {
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    quietTimer = undefined;
    maxTimer = undefined;
    const latest = capture();
    bindStage(latest.stage);
    if (published && !sameReferences(published, latest)) onObserved(latest.canvases);
    candidate = latest;
    if (!latest.canvases.length || same(published, latest)) return;
    if (onPublish(latest.canvases) === false) {
      quietTimer = setTimeout(publish, QUIET_MS);
      maxTimer ??= setTimeout(publish, MAX_WAIT_MS);
      return;
    }
    published = latest;
  };
  function consider() {
    if (stopped) return;
    bindDocument(document.documentElement);
    const latest = capture();
    bindStage(latest.stage);
    if (published && !sameReferences(published, latest)) onObserved(latest.canvases);
    if (!latest.canvases.length) {
      candidate = latest;
      clearTimeout(quietTimer);
      quietTimer = undefined;
      clearTimeout(bootstrapTimer);
      bootstrapTimer = setTimeout(consider, QUIET_MS);
      return;
    }
    clearTimeout(bootstrapTimer);
    bootstrapTimer = undefined;
    if (same(candidate, latest)) return;
    candidate = latest;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(publish, QUIET_MS);
    maxTimer ??= setTimeout(publish, MAX_WAIT_MS);
  }
  const documentObserver = new MutationObserver(records => {
    if (records.some(mutationTouchesStage)) consider();
  });
  let observedDocumentElement;
  const bindDocument = root => {
    if (!root || root === observedDocumentElement) return;
    documentObserver.disconnect();
    observedDocumentElement = root;
    documentObserver.observe(root, { childList:true, subtree:true });
  };
  bindDocument(document.documentElement);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    clearTimeout(bootstrapTimer);
    documentObserver.disconnect();
    stageObserver.disconnect();
  };
  signal.addEventListener('abort', stop, { once:true });
  consider();
  return { stop };
}

function hasTransientInteraction() {
  return Boolean(directEdit || transformDrag || pendingManual.size > 0 || tentativeCommands.size > 0);
}

function noteCanvasReplacementDuringInteraction(nextCanvases) {
  const referencesChanged = canvases.length > 0
    && (canvases.length !== nextCanvases.length
      || canvases.some((canvas, index) => canvas !== nextCanvases[index]));
  if (referencesChanged && hasTransientInteraction()) requiresAuthoritativeReload = true;
}

function requestAuthoritativeReloadIfSettled() {
  if (!requiresAuthoritativeReload || authoritativeReloadRequested || hasTransientInteraction()
    || tornDown || startupController.signal.aborted) return false;
  authoritativeReloadRequested = true;
  canvasMonitor?.stop();
  parent.postMessage({
    type:'request-authoritative-reload',
    frameInstanceId:FRAME_INSTANCE_ID,
    requestSequence:++authoritativeReloadRequestSequence,
    reason:'TRANSIENT_CANVAS_REPLACED',
  }, location.origin);
  return true;
}

const style = document.createElement('style');
style.dataset.deckEditorUi = '';
style.textContent = `
  [data-region-selection],[data-task-highlight]{position:fixed;z-index:2147483638;pointer-events:none;box-sizing:border-box}
  [data-region-selection]{border:2px solid #c7000b;background:rgba(199,0,11,.08);box-shadow:0 0 0 1px rgba(255,255,255,.85) inset}
  [data-region-popover]{position:fixed;z-index:2147483640;width:336px;padding:16px;border:1px solid rgba(25,25,25,.16);border-radius:12px;background:#fff;color:#191919;box-shadow:0 14px 38px rgba(25,25,25,.24);box-sizing:border-box;font:14px/1.45 "Huawei Sans","HarmonyOS Sans SC","PingFang SC",sans-serif;transform-origin:0 0}
  [data-region-popover] label{display:block;margin-bottom:8px;font-size:12px;font-weight:700;color:#5f6268}
  [data-region-popover] textarea{display:block;width:100%;min-height:88px;resize:vertical;padding:10px 11px;border:1px solid #c9cbd0;border-radius:8px;outline:none;color:#191919;background:#fff;font:inherit;font-size:14px;line-height:1.5;box-sizing:border-box}
  [data-region-popover] textarea:focus{border-color:#c7000b;box-shadow:0 0 0 3px rgba(199,0,11,.10)}
  [data-attachment-controls]{display:flex;align-items:center;gap:8px;margin-top:10px}
  [data-attachment-choose]{min-height:32px;padding:0 11px;border:1px solid #c9cbd0;border-radius:7px;background:#fff;color:#34363a;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  [data-attachment-hint]{color:#777b82;font-size:12px}
  [data-attachment-list]{display:grid;gap:6px;max-height:156px;margin:8px 0 0;padding:0;overflow:auto;list-style:none}
  [data-attachment-item]{display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:7px;padding:7px 8px;border:1px solid #e1e2e5;border-radius:7px;background:#f8f8f9}
  [data-attachment-icon]{color:#777b82;text-align:center}
  [data-attachment-detail]{min-width:0}
  [data-attachment-name]{display:block;overflow:hidden;color:#34363a;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
  [data-attachment-size]{display:block;color:#777b82;font-size:11px}
  [data-attachment-remove]{width:26px;height:26px;padding:0;border:0;border-radius:5px;background:transparent;color:#777b82;font:700 16px/1 sans-serif;cursor:pointer}
  [data-attachment-remove]:hover{background:#ececef;color:#b42318}
  [data-attachment-choose]:disabled,[data-attachment-remove]:disabled{cursor:wait;opacity:.55}
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
  [data-direct-editing]{cursor:text!important}
  html[data-deck-editor-dragging="translate"],html[data-deck-editor-dragging="translate"] *{cursor:grabbing!important}
  html[data-deck-editor-dragging="resize"],html[data-deck-editor-dragging="resize"] *{cursor:nwse-resize!important}
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

function finiteOverflow(scrollSize, clientSize) {
  const value = Math.max(0, Number(scrollSize) - Number(clientSize));
  return Number.isFinite(value) ? value : 0;
}

function diagnosesNestedClip(element) {
  if (element.matches('[data-deck-editor-ui],[data-deck-editor-ui] *')) return false;
  const computed = getComputedStyle(element);
  const clips = value => ['hidden', 'clip', 'auto', 'scroll'].includes(value);
  return clips(computed.overflowX) || clips(computed.overflowY);
}

function diagnoseCanvas(canvas) {
  const { pageKey } = pageInfo(canvas);
  const section = canvas.querySelector('section[data-label]') ?? canvas.firstElementChild ?? canvas;
  const sectionOverflow = {
    x: finiteOverflow(section.scrollWidth, section.clientWidth),
    y: finiteOverflow(section.scrollHeight, section.clientHeight),
  };
  const nestedClips = [];
  for (const element of section.querySelectorAll('*')) {
    if (!diagnosesNestedClip(element)) continue;
    const x = finiteOverflow(element.scrollWidth, element.clientWidth);
    const y = finiteOverflow(element.scrollHeight, element.clientHeight);
    if (x <= 0 && y <= 0) continue;
    nestedClips.push({ locator:runtime.makeLocator(element), x, y });
  }
  return { pageKey, sectionOverflow, nestedClips };
}

function diagnosePages(pageKeys) {
  const requested = pageKeys === undefined
    ? canvases
    : pageKeys.map(pageKey => canvases.find(canvas => runtime.pageKey(canvas) === pageKey));
  if (requested.some(canvas => !canvas)) {
    const error = new Error('诊断页面不存在');
    error.code = 'PAGE_NOT_FOUND';
    throw error;
  }
  return requested.map(diagnoseCanvas);
}

function showPage(pageKey) {
  const canvas = canvases.find(candidate => runtime.pageKey(candidate) === pageKey);
  const preserveSelection = interactionBelongsToSnapshot(transformSelection?.element, canvases)
    && transformSelection.element.closest('.slide-canvas') === canvas;
  finishDirectEdit();
  clearTextRangeSelection();
  cancelTransformDrag();
  if (!preserveSelection) removeTransformSelection();
  removePopover();
  if (!canvas) {
    parent.postMessage({ type: 'page-shown', pageKey, shown: false, reason: 'PAGE_NOT_FOUND' }, location.origin);
    return null;
  }
  const stage = canvas.closest('.stage');
  const stageStyle = stage ? getComputedStyle(stage) : null;
  const stageScrolls = stage && ['auto', 'scroll', 'overlay'].includes(stageStyle.overflowY)
    && stage.scrollHeight > stage.clientHeight;
  if (stageScrolls) {
    const scrollTarget = canvas.closest('.slide-fit') ?? canvas;
    const stageRect = stage.getBoundingClientRect();
    const targetRect = scrollTarget.getBoundingClientRect();
    stage.scrollTo({
      top:stage.scrollTop + targetRect.top - stageRect.top,
      left:stage.scrollLeft,
      behavior:'auto',
    });
  } else {
    const top = canvas.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top, left: 0, behavior: 'auto' });
  }
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
    if (pending && canonicalMode(pending) !== mode) return canonicalMode(pending);
  } catch {
    // 跨源时只使用 confirmed postMessage 状态。
  }
  return mode;
}

function isRegionMode() {
  return effectiveMode() === 'region';
}

function isEditMode() {
  return effectiveMode() === 'edit';
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

function formatAttachmentSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function setRegionStatus(status, message, state = 'info') {
  status.dataset.state = state;
  status.textContent = message;
}

function pastedImageName(sequence, date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `pasted-image-${day}-${time}-${String(sequence).padStart(3, '0')}.png`;
}

async function normalizePastedImage(file, name) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理剪贴板图片');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolvePromise, reject) => {
      canvas.toBlob(value => {
        if (value) resolvePromise(value);
        else reject(new Error('浏览器无法重新编码剪贴板图片'));
      }, 'image/png');
    });
    return new File([blob], name, { type:'image/png', lastModified:Date.now() });
  } finally {
    bitmap.close();
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
  const attachmentInput = document.createElement('input');
  attachmentInput.type = 'file';
  attachmentInput.multiple = true;
  attachmentInput.hidden = true;
  attachmentInput.dataset.attachmentInput = '';
  const attachmentControls = document.createElement('div');
  attachmentControls.dataset.attachmentControls = '';
  const attachmentChoose = document.createElement('button');
  attachmentChoose.type = 'button';
  attachmentChoose.dataset.attachmentChoose = '';
  attachmentChoose.textContent = '选择文件';
  const attachmentHint = document.createElement('span');
  attachmentHint.dataset.attachmentHint = '';
  attachmentHint.textContent = '也可直接粘贴图片';
  attachmentControls.append(attachmentChoose, attachmentHint);
  const attachmentList = document.createElement('ul');
  attachmentList.dataset.attachmentList = '';
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
  popover.append(label, attachmentInput, attachmentControls, attachmentList, status, actions);
  document.body.append(selection, popover);
  positionPopover(popover, screenRect);
  textarea.focus({ preventScroll: true });

  const normalized = normalizeRect(screenRect, canvas.getBoundingClientRect());
  const requestId = crypto.randomUUID();
  activePopover = {
    canvas, selection, popover, requestId, submitting:false, processing:0,
    attachments:[], pasteSequence:0,
  };
  const popoverState = activePopover;

  const updateAttachmentControls = () => {
    if (activePopover !== popoverState) return;
    const disabled = popoverState.submitting;
    attachmentInput.disabled = disabled;
    attachmentChoose.disabled = disabled;
    submit.disabled = disabled || popoverState.processing > 0;
    for (const button of attachmentList.querySelectorAll('[data-attachment-remove]')) {
      button.disabled = disabled;
    }
  };

  const renderAttachments = () => {
    if (activePopover !== popoverState) return;
    attachmentList.replaceChildren();
    for (const item of popoverState.attachments) {
      const row = document.createElement('li');
      row.dataset.attachmentItem = '';
      row.dataset.attachmentClientId = item.clientId;
      const icon = document.createElement('span');
      icon.dataset.attachmentIcon = '';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.file.type.startsWith('image/') ? '▧' : '▤';
      const detail = document.createElement('span');
      detail.dataset.attachmentDetail = '';
      const name = document.createElement('span');
      name.dataset.attachmentName = '';
      name.title = item.file.name;
      name.textContent = item.file.name;
      const size = document.createElement('span');
      size.dataset.attachmentSize = '';
      size.textContent = formatAttachmentSize(item.file.size);
      detail.append(name, size);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.attachmentRemove = '';
      remove.setAttribute('aria-label', `删除附件 ${item.file.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        if (activePopover !== popoverState || popoverState.submitting) return;
        popoverState.attachments = popoverState.attachments
          .filter(candidate => candidate.clientId !== item.clientId);
        renderAttachments();
        setRegionStatus(status, `已删除附件 ${item.file.name}`);
      });
      row.append(icon, detail, remove);
      attachmentList.append(row);
    }
    updateAttachmentControls();
    positionPopover(popover, screenRect);
  };

  const appendFiles = (files, source) => {
    if (activePopover !== popoverState || popoverState.submitting) return 0;
    let added = 0;
    let errorMessage = '';
    for (const file of files) {
      if (popoverState.attachments.length >= MAX_ATTACHMENTS) {
        errorMessage = `每个任务最多 ${MAX_ATTACHMENTS} 个附件`;
        break;
      }
      try {
        validateFileLike(file);
        popoverState.attachments.push({ clientId:crypto.randomUUID(), file, source });
        added += 1;
      } catch (error) {
        errorMessage = error.message || '附件无效';
      }
    }
    renderAttachments();
    if (errorMessage) setRegionStatus(status, errorMessage, 'error');
    else if (added > 0) setRegionStatus(status, `已添加 ${added} 个附件`);
    return added;
  };

  attachmentChoose.addEventListener('click', () => {
    if (activePopover === popoverState && !popoverState.submitting) attachmentInput.click();
  });
  attachmentInput.addEventListener('change', () => {
    if (activePopover !== popoverState) return;
    appendFiles([...attachmentInput.files], 'selected');
    attachmentInput.value = '';
  });
  textarea.addEventListener('paste', event => {
    if (activePopover !== popoverState || popoverState.submitting) return;
    const images = [...(event.clipboardData?.items ?? [])]
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (images.length === 0) return;
    event.preventDefault();
    popoverState.processing += 1;
    updateAttachmentControls();
    void (async () => {
      try {
        setRegionStatus(status, '正在处理粘贴图片…', 'pending');
        let added = 0;
        let pasteError = false;
        for (const image of images) {
          if (activePopover !== popoverState || popoverState.submitting) return;
          if (popoverState.attachments.length >= MAX_ATTACHMENTS) {
            setRegionStatus(status, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`, 'error');
            pasteError = true;
            break;
          }
          try {
            popoverState.pasteSequence += 1;
            const file = await normalizePastedImage(
              image,
              pastedImageName(popoverState.pasteSequence),
            );
            if (activePopover !== popoverState || popoverState.submitting) return;
            const appended = appendFiles([file], 'pasted');
            added += appended;
            if (appended === 0) pasteError = true;
          } catch (error) {
            if (activePopover === popoverState) {
              setRegionStatus(status, error.message || '粘贴图片处理失败', 'error');
            }
            pasteError = true;
          }
        }
        if (added > 0 && !pasteError && activePopover === popoverState) {
          setRegionStatus(status, `已添加 ${added} 张粘贴图片`);
        }
      } finally {
        popoverState.processing -= 1;
        if (activePopover === popoverState) updateAttachmentControls();
      }
    })();
  });

  const cancelPopover = () => {
    if (activePopover === popoverState && !popoverState.submitting) removePopover();
  };
  cancel.addEventListener('click', cancelPopover);
  popover.addEventListener('keydown', event => {
    if (activePopover !== popoverState) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelPopover();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (popoverState.processing > 0) {
        setRegionStatus(status, '正在处理粘贴图片，请稍候', 'pending');
        return;
      }
      popover.requestSubmit();
    }
  });
  popover.addEventListener('submit', async event => {
    event.preventDefault();
    if (activePopover !== popoverState) return;
    if (popoverState.processing > 0) {
      setRegionStatus(status, '正在处理粘贴图片，请稍候', 'pending');
      return;
    }
    const instruction = textarea.value.trim();
    if (!instruction || popoverState.submitting) {
      if (!instruction) textarea.focus();
      return;
    }
    popoverState.submitting = true;
    textarea.disabled = true;
    cancel.disabled = true;
    submit.disabled = true;
    updateAttachmentControls();
    submit.textContent = '正在提交…';
    status.dataset.state = 'pending';
    status.textContent = '正在生成区域快照…';
    const snapshot = await captureSnapshot(canvas, normalized);
    if (activePopover !== popoverState) return;
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
      attachments:popoverState.attachments.map(item => ({
        clientId:item.clientId,
        source:item.source,
        file:item.file,
      })),
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
  if (result.sessionRefreshPending) return result.message || '动作已保存、会话同步待重试';
  if (result.syncPending) return result.message || '动作已保存、同步待确认';
  if (result.commitConfirmed === false && result.recoveredBySync) return '动作已保存并恢复同步';
  return fallback;
}

function textTargetFromEvent(event) {
  const canvas = event.target.closest?.('.slide-canvas');
  if (!canvas) return null;
  for (let element = event.target; element && element !== canvas; element = element.parentElement) {
    if (element.matches?.('[data-deck-text-range-style]')) continue;
    if ((element.textContent ?? '').trim()) return element;
  }
  return null;
}

function textRejection(element, { allowChildren = false } = {}) {
  if (!element || !element.closest('.slide-canvas')) return '请在页面文字上双击';
  if (element.closest('[data-deck-editor-ui],button,a,input,textarea,select,[role="button"],.layer-panel')
    || element.closest('svg,iframe') || element.querySelector('svg,iframe,.layer-panel')) {
    return '该元素包含交互或复杂组件，请改用区域标记';
  }
  if (!(element.textContent ?? '').trim()) return '请在页面文字上双击';
  if (!allowChildren && element.children.length > 0) {
    return '该文字包含复杂富文本结构，请改用区域标记';
  }
  return null;
}

function textNodeAtPoint(element, event) {
  const range = element.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = range?.startContainer;
  return node?.nodeType === Node.TEXT_NODE && element.contains(node)
    && (node.data ?? '').trim() ? node : null;
}

function textNodePath(root, textNode) {
  const path = [];
  for (let node = textNode; node && node !== root; node = node.parentNode) {
    const parent = node.parentNode;
    if (!parent) return null;
    const index = [...parent.childNodes].indexOf(node);
    if (index < 0 || index > 9_999) return null;
    path.unshift(index);
  }
  return path.length > 0 && path.length <= 32 ? path.join('/') : null;
}

function directTextTarget(event) {
  const element = textTargetFromEvent(event);
  const rejection = textRejection(element, { allowChildren:true });
  if (rejection) return { rejection };
  if (element.children.length === 0) return { element };
  if (runtime.contract?.features?.split(',').includes('textPath') !== true) {
    return { rejection:'当前 Deck 的补丁运行时较旧，请重新写回后再编辑富文本片段' };
  }
  const textNode = textNodeAtPoint(element, event);
  if (!textNode) return { rejection:'请双击具体文字；复杂组件仍请使用区域标记' };
  let root = textNode.parentElement;
  while (root?.matches('[data-deck-text-range-style]')) root = root.parentElement;
  const path = textNodePath(root, textNode);
  if (!root || !path) return { rejection:'无法稳定定位该段文字，请改用区域标记' };
  const rootRejection = textRejection(root, { allowChildren:true });
  if (rootRejection) return { rejection:rootRejection };
  return { element:root, textNode, textPath:path };
}

function finishDirectEdit({ restore = true } = {}) {
  if (!directEdit) return;
  const state = directEdit;
  directEdit = null;
  state.element.removeEventListener('blur', onDirectEditBlur);
  if (state.textNode) {
    state.textNode.data = restore ? state.originalText : (state.element.textContent ?? '');
  } else if (restore) state.element.textContent = state.originalText;
  state.element.removeAttribute('contenteditable');
  delete state.element.dataset.directEditing;
  state.element.spellcheck = state.originalSpellcheck;
  if (state.textNode) state.element.replaceWith(state.textNode);
  state.resumeReplay?.();
  requestAuthoritativeReloadIfSettled();
}

function onDirectEditBlur(event) {
  if (directEdit?.element !== event.currentTarget || directEdit.committing) return;
  commitDirectEdit();
}

function placeDirectEditCaret(element, event) {
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  let range = element.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null;
  if (!range || !element.contains(range.startContainer)) {
    range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function commitDirectEdit() {
  if (!directEdit || directEdit.committing) return;
  directEdit.committing = true;
  const state = directEdit;
  const nextText = state.element.textContent ?? '';
  finishDirectEdit({ restore: true });
  if (requiresAuthoritativeReload) return;
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
  if (!isEditMode()) return;
  const directTarget = directTextTarget(event);
  const rejection = directTarget.rejection;
  if (rejection) {
    showStatus(rejection, 'error');
    event.preventDefault();
    return;
  }
  finishDirectEdit();
  cancelTransformDrag();
  clearTextRangeSelection({ notify:false });
  removeTransformSelection();
  let { element } = directTarget;
  let target;
  let formatTarget;
  try {
    formatTarget = runtime.makeLocator(element);
    target = formatTarget;
    if (directTarget.textPath) target = { ...target, textPath:directTarget.textPath };
  }
  catch { showStatus('无法定位该文字，请改用区域标记', 'error'); return; }
  if (directTarget.textNode) {
    const wrapper = document.createElement('span');
    wrapper.dataset.directTextRun = '';
    directTarget.textNode.replaceWith(wrapper);
    wrapper.append(directTarget.textNode);
    element = wrapper;
  }
  directEdit = {
    element, target, originalText: element.textContent ?? '',
    originalSpellcheck: element.spellcheck, committing: false,
    textNode:directTarget.textNode ?? null,
    formatRoot:directTarget.element,
    formatTarget,
    resumeReplay: runtime.suspendTarget?.(target),
  };
  element.setAttribute('contenteditable', 'plaintext-only');
  element.dataset.directEditing = '';
  element.spellcheck = false;
  element.addEventListener('blur', onDirectEditBlur);
  updateUiScale();
  element.focus({ preventScroll: true });
  placeDirectEditCaret(element, event);
  showStatus('点击别处或 Cmd/Ctrl+Enter 提交 · Escape 取消');
  event.preventDefault();
}

function editableTransformTarget(event) {
  const canvas = event.target.closest?.('.slide-canvas');
  if (!canvas || !canvases.includes(canvas) || event.target.closest?.('[data-deck-editor-ui]')) return null;
  const interactive = event.target.closest?.(INTERACTIVE_TRANSFORM_SELECTOR);
  if (interactive && interactive.closest('.slide-canvas') === canvas) return interactive;
  for (let element = event.target; element && element !== canvas; element = element.parentElement) {
    if (element.matches('html,body,section,.stage,.slide-fit,.slide-canvas')) continue;
    if (element.closest('.slide-canvas') !== canvas) return null;
    const style = getComputedStyle(element);
    const independentBox = style.position !== 'static'
      || ['block','inline-block','flex','inline-flex','grid','inline-grid','table','list-item']
        .includes(style.display);
    if (independentBox || element.matches('img,video,canvas,svg,table')) return element;
  }
  return null;
}

function currentTranslate(element) {
  const computed = getComputedStyle(element).translate;
  const [x = '0', y = '0'] = (computed && computed !== 'none' ? computed : '0px 0px').split(/\s+/);
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

function inspectorKind(element) {
  if (element instanceof SVGElement) return 'svg';
  if (element.matches('img,video,canvas,iframe')) return 'image';
  return (element.textContent ?? '').trim() ? 'text' : 'shape';
}

function textNodesWithin(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function textOffsetWithin(root, node, offset) {
  let total = 0;
  for (const textNode of textNodesWithin(root)) {
    if (textNode === node) {
      return Number.isSafeInteger(offset) && offset >= 0 && offset <= textNode.data.length
        ? total + offset : null;
    }
    total += textNode.data.length;
  }
  return null;
}

function textNodeAtOffset(root, offset) {
  let total = 0;
  const nodes = textNodesWithin(root);
  for (const node of nodes) {
    if (offset < total + node.data.length) return node;
    total += node.data.length;
  }
  return offset === total ? nodes.at(-1) ?? null : null;
}

function clearTextRangeSelection({ notify = true } = {}) {
  if (!textRangeSelection) return;
  textRangeSelection = null;
  if (notify) publishInspectorSelection();
}

function updateTextRangeSelection() {
  if (!directEdit?.formatRoot?.isConnected) return;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    if (document.hasFocus()) clearTextRangeSelection();
    return;
  }
  const range = selection.getRangeAt(0);
  const root = directEdit.formatRoot;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    if (document.hasFocus()) clearTextRangeSelection();
    return;
  }
  const start = textOffsetWithin(root, range.startContainer, range.startOffset);
  const end = textOffsetWithin(root, range.endContainer, range.endOffset);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    clearTextRangeSelection();
    return;
  }
  const sameRange = textRangeSelection?.element === root
    && textRangeSelection.start === start && textRangeSelection.end === end;
  textRangeSelection = {
    element:root,
    target:directEdit.formatTarget,
    start,
    end,
    selectionId:sameRange ? textRangeSelection.selectionId : crypto.randomUUID(),
  };
  publishInspectorSelection();
}

function inspectorLabel(element) {
  return element.getAttribute('aria-label')
    || element.dataset.label
    || element.getAttribute('title')
    || element.id
    || '';
}

function inspectorSelectionSnapshot() {
  const state = textRangeSelection ?? transformSelection;
  if (!state?.element?.isConnected || !state.target) return null;
  const { element } = state;
  const canvas = element.closest('.slide-canvas');
  if (!canvas) return null;
  const isTextRange = state === textRangeSelection;
  const kind = isTextRange ? 'text' : inspectorKind(element);
  const rangeOwner = isTextRange
    ? (textNodeAtOffset(element, state.start)?.parentElement ?? element) : element;
  const computedStyle = getComputedStyle(rangeOwner);
  const computed = {};
  const inline = {};
  for (const property of INSPECTOR_STYLE_PROPERTIES) {
    computed[property] = computedStyle.getPropertyValue(property).trim();
    inline[property] = isTextRange
      ? computed[property] : element.style.getPropertyValue(property);
  }
  const selectedText = isTextRange
    ? (element.textContent ?? '').slice(state.start, state.end) : '';
  return {
    selectionId:state.selectionId,
    target:state.target,
    ...pageInfo(canvas),
    kind,
    tag:element.tagName,
    label:isTextRange ? `已选 ${state.end - state.start} 个字` : inspectorLabel(element),
    textPreview:(isTextRange ? selectedText : (element.textContent ?? ''))
      .replace(/\s+/g, ' ').trim().slice(0, 72),
    ...(isTextRange ? {
      scope:'text-range', textRange:{ start:state.start, end:state.end },
    } : { scope:'element' }),
    computed,
    inline,
    capabilities:{
      typography:kind === 'text',
      fill:!isTextRange && kind !== 'image',
      border:!isTextRange && kind !== 'svg',
      svgStyle:kind === 'svg',
      opacity:!isTextRange,
    },
  };
}

function publishInspectorSelection() {
  parent.postMessage({
    type:'inspector-selection-changed',
    selection:inspectorSelectionSnapshot(),
  }, location.origin);
}

function removeTransformSelection({ notify = true } = {}) {
  transformSelection?.overlay.remove();
  transformSelection?.handle?.remove();
  transformSelection = null;
  if (notify) publishInspectorSelection();
}

function interactionBelongsToSnapshot(element, nextCanvases) {
  const canvas = element?.closest?.('.slide-canvas');
  return Boolean(element?.isConnected && canvas && nextCanvases.includes(canvas));
}

function pruneDisconnectedInteractionState(nextCanvases) {
  if (directEdit && !interactionBelongsToSnapshot(directEdit.element, nextCanvases)) {
    finishDirectEdit();
    showStatus('页面已更新，未提交的文字修改已取消');
  }
  if (transformSelection && !transformDrag
    && !interactionBelongsToSnapshot(transformSelection.element, nextCanvases)) {
    removeTransformSelection();
  }
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

function selectTransformElement(element, withHandle, target) {
  clearTextRangeSelection({ notify:false });
  removeTransformSelection({ notify:false });
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
  transformSelection = {
    element, overlay, handle, target:target ?? runtime.makeLocator(element),
    selectionId:crypto.randomUUID(),
  };
  positionTransformSelection();
  publishInspectorSelection();
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
  delete document.documentElement.dataset.deckEditorDragging;
  state.capture?.releasePointerCapture?.(state.pointerId);
  restoreTransformPreview(state);
  requestAuthoritativeReloadIfSettled();
}

function beginMove(event, element) {
  let target;
  try { target = runtime.makeLocator(element); } catch { return; }
  const canvas = element.closest('.slide-canvas');
  selectTransformElement(element, true, target);
  transformDrag = {
    kind: 'translate', pointerId: event.pointerId, capture: element, element, target, canvas,
    start: { x: event.clientX, y: event.clientY }, base: currentTranslate(element),
    current: currentTranslate(element), originalTranslate: element.style.translate, changed: false,
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
  const visualScale = frameVisualScale();
  const screenDx = (event.clientX - state.start.x) * visualScale.x;
  const screenDy = (event.clientY - state.start.y) * visualScale.y;
  if (!state.changed && Math.hypot(screenDx, screenDy) < 3) {
    event.preventDefault();
    return true;
  }
  state.changed = true;
  document.documentElement.dataset.deckEditorDragging = state.kind;
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
  positionTransformSelection();
  event.preventDefault();
  return true;
}

function finishTransformPointer(event) {
  if (!transformDrag || event.pointerId !== transformDrag.pointerId) return false;
  const state = transformDrag;
  transformDrag = null;
  delete document.documentElement.dataset.deckEditorDragging;
  state.capture?.releasePointerCapture?.(state.pointerId);
  restoreTransformPreview(state);
  if (requiresAuthoritativeReload) {
    requestAuthoritativeReloadIfSettled();
    event.preventDefault();
    return true;
  }
  if (!state.changed && state.kind === 'resize') return true;
  if (state.kind === 'translate'
    && state.current.x === state.base.x && state.current.y === state.base.y) return true;
  const action = {
    id: crypto.randomUUID(), taskId: null, target: state.target,
    kind: state.kind, payload: state.current,
  };
  submitManualActions([action], result => {
    if (result.ok && (result.sessionRefreshPending || result.syncPending || result.recoveredBySync)) {
      showStatus(manualSuccessMessage(result, '变换已记录'));
    } else if (!result.ok) showStatus(manualFailureMessage(result, '变换失败，已恢复原状态'), 'error');
    positionTransformSelection();
    publishInspectorSelection();
  });
  event.preventDefault();
  return true;
}

function onPointerDown(event) {
  const currentMode = effectiveMode();
  if (directEdit) return;
  if (currentMode === 'edit' && event.target.closest?.('[data-resize-handle]')) {
    beginResize(event);
    return;
  }
  if (currentMode === 'edit' && event.button === 0) {
    const element = editableTransformTarget(event);
    if (element) beginMove(event, element);
    else removeTransformSelection();
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
      clearTextRangeSelection();
      finishDirectEdit();
      showStatus('已取消文字修改');
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitDirectEdit();
    }
    return;
  }
  const shortcutKey = event.key.toLowerCase();
  const shortcutMethod = !event.altKey && (event.metaKey || event.ctrlKey)
    ? (shortcutKey === 'z' ? (event.shiftKey ? 'redo' : 'undo')
      : (shortcutKey === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey
        ? 'redo' : null))
    : null;
  const shortcutElement = event.target instanceof Element ? event.target : event.target?.parentElement;
  const acceptsNativeShortcut = shortcutElement?.closest(
    'input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])',
  );
  if (shortcutMethod && !acceptsNativeShortcut) {
    event.preventDefault();
    parent.postMessage({ type:'history-shortcut', method:shortcutMethod }, location.origin);
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
  if (transformSelection) {
    positionTransformSelection();
    publishInspectorSelection();
  }
  requestAuthoritativeReloadIfSettled();
}

function onParentMessage(event) {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'show-authoritative-reload-notice') {
    showStatus('页面重建，未提交编辑已取消');
    return;
  }
  if (event.data?.type === 'show-page' && typeof event.data.pageKey === 'string') {
    showPage(event.data.pageKey);
    return;
  }
  if (event.data?.type === 'set-editor-mode'
    && ['preview', 'edit', 'region', 'text', 'move', 'resize'].includes(event.data.mode)) {
    const nextMode = canonicalMode(event.data.mode);
    if (nextMode !== mode) {
      finishDirectEdit();
      clearTextRangeSelection();
      cancelTransformDrag();
      removeTransformSelection();
    }
    mode = nextMode;
    document.documentElement.dataset.deckEditorMode = mode;
    document.documentElement.style.cursor = mode === 'region' ? 'crosshair' : '';
    if (mode !== 'region') removePopover();
    return;
  }
  if (event.data?.type === 'apply-inspector-styles'
    && typeof event.data.requestId === 'string'
    && typeof event.data.selectionId === 'string') {
    const requestId = event.data.requestId;
    const selectionId = event.data.selectionId;
    const changes = event.data.changes;
    const reject = message => parent.postMessage({
      type:'inspector-style-result', requestId, selectionId, ok:false, message,
    }, location.origin);
    const selectedState = textRangeSelection?.selectionId === selectionId
      ? textRangeSelection : transformSelection;
    if (!selectedState?.element?.isConnected || selectedState.selectionId !== selectionId) {
      reject('选中对象已经变化，请重新选择');
      return;
    }
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 12
      || changes.some(change => !change || typeof change.value !== 'string'
        || !INSPECTOR_STYLE_PROPERTIES.has(change.property))
      || new Set(changes.map(change => change.property)).size !== changes.length) {
      reject('样式参数无效');
      return;
    }
    const textRange = selectedState === textRangeSelection
      ? { start:selectedState.start, end:selectedState.end } : null;
    if (textRange && changes.some(change => !['color', 'font-size', 'font-weight']
      .includes(change.property))) {
      reject('局部文字仅支持字重、字号和文字颜色');
      return;
    }
    const actions = changes.map(change => ({
      id:crypto.randomUUID(), taskId:null, target:selectedState.target,
      kind:'setStyle', payload:{
        property:change.property, value:change.value,
        ...(textRange ? { textRange } : {}),
      },
    }));
    submitManualActions(actions, result => {
      if (transformSelection?.selectionId === selectionId) {
        positionTransformSelection();
      }
      publishInspectorSelection();
      parent.postMessage({
        type:'inspector-style-result', requestId, selectionId,
        ok:result.ok === true,
        message:result.message,
        sessionRefreshPending:result.sessionRefreshPending === true,
        failedActionId:result.failedActionId,
      }, location.origin);
    });
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
        if (transformSelection) {
          positionTransformSelection();
          publishInspectorSelection();
        }
        const reply = {
          type: 'actions-prepared', commandId: event.data.commandId,
          applied: transaction.results.length, results: transaction.results,
        };
        tentativeCommands.set(event.data.commandId, { transaction, reply });
        parent.postMessage(reply, location.origin);
      } else {
        const results = runtime.applyTransaction(event.data.actions);
        if (transformSelection) {
          positionTransformSelection();
          publishInspectorSelection();
        }
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
    requestAuthoritativeReloadIfSettled();
    return;
  }
  if (event.data?.type === 'rollback-actions' && typeof event.data.commandId === 'string') {
    const pending = tentativeCommands.get(event.data.commandId);
    const rolledBack = pending?.transaction.rollback() ?? false;
    tentativeCommands.delete(event.data.commandId);
    if (transformSelection) {
      positionTransformSelection();
      publishInspectorSelection();
    }
    parent.postMessage({ type:'actions-rolled-back', commandId:event.data.commandId, rolledBack }, location.origin);
    requestAuthoritativeReloadIfSettled();
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
      if (transformSelection) {
        positionTransformSelection();
        publishInspectorSelection();
      }
      if (typeof event.data.commandId === 'string') {
        parent.postMessage({ type:'actions-synced', commandId:event.data.commandId }, location.origin);
      }
    }
    catch (error) { showStatus(`会话动作恢复失败：${error.code || error.message}`, 'error'); }
    return;
  }
  if (event.data?.type === 'diagnose-pages'
    && typeof event.data.commandId === 'string'
    && Number.isSafeInteger(event.data.revision)
    && Array.isArray(event.data.pageKeys)) {
    try {
      parent.postMessage({
        type:'diagnostics-result',
        commandId:event.data.commandId,
        revision:event.data.revision,
        pages:diagnosePages(event.data.pageKeys),
      }, location.origin);
    } catch (error) {
      parent.postMessage({
        type:'diagnostics-rejected',
        commandId:event.data.commandId,
        revision:event.data.revision,
        code:error.code || 'DIAGNOSTICS_UNAVAILABLE',
      }, location.origin);
    }
    return;
  }
  if (event.data?.type === 'manual-actions-result'
    && typeof event.data.requestId === 'string') {
    const callback = pendingManual.get(event.data.requestId);
    if (!callback) return;
    pendingManual.delete(event.data.requestId);
    callback(event.data);
    requestAuthoritativeReloadIfSettled();
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
    const attachmentInput = popover.querySelector('[data-attachment-input]');
    const attachmentChoose = popover.querySelector('[data-attachment-choose]');
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
      attachmentInput.disabled = false;
      attachmentChoose.disabled = false;
      for (const button of popover.querySelectorAll('[data-attachment-remove]')) {
        button.disabled = false;
      }
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
  startupController.abort();
  canvasMonitor?.stop();
  clearTimeout(highlightTimer);
  clearTimeout(statusTimer);
  finishDirectEdit();
  cancelTransformDrag();
  removeTransformSelection();
  clearTextRangeSelection();
  pendingManual.clear();
  rollbackAllTentative();
  dragging?.selection.remove();
  dragging = null;
  removePopover();
  document.querySelector('[data-task-highlight]')?.remove();
  document.querySelector('[data-direct-status]')?.remove();
  style.remove();
  document.documentElement.style.cursor = '';
  delete document.documentElement.dataset.deckEditorDragging;
  delete document.documentElement.dataset.deckEditorMode;
  document.documentElement.style.removeProperty('--deck-editor-ui-scale-x');
  document.documentElement.style.removeProperty('--deck-editor-ui-scale-y');
  window.removeEventListener('message', onParentMessage);
  window.removeEventListener('dblclick', onDoubleClick, true);
  window.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('selectionchange', updateTextRangeSelection);
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('pointerup', finishPointer, true);
  window.removeEventListener('pointercancel', cancelPointer, true);
  window.removeEventListener('pagehide', teardown);
  window.removeEventListener('pagehide', abortStartup);
}

if (parent !== window) {
  window.addEventListener('message', onParentMessage);
  window.addEventListener('dblclick', onDoubleClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('selectionchange', updateTextRangeSelection);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', finishPointer, true);
  window.addEventListener('pointercancel', cancelPointer, true);
  window.addEventListener('pagehide', teardown);
  canvasMonitor = createCanvasMonitor(nextCanvases => {
    if (!style.isConnected) document.head?.append(style);
    document.documentElement.dataset.deckEditorMode = mode;
    pruneDisconnectedInteractionState(nextCanvases);
    if (requiresAuthoritativeReload) {
      requestAuthoritativeReloadIfSettled();
      return false;
    }
    if (dragging || directEdit || transformDrag
      || activePopover || pendingManual.size > 0 || tentativeCommands.size > 0) return false;
    finishDirectEdit();
    cancelTransformDrag();
    removePopover();
    canvases = nextCanvases;
    if (transformSelection) positionTransformSelection();
    parent.postMessage({
      type: 'deck-ready',
      frameInstanceId:FRAME_INSTANCE_ID,
      pages: canvases.map((canvas, index) => ({
        index: index + 1,
        label: canvas.querySelector('section[data-label]')?.dataset.label ?? `第 ${index + 1} 页`,
        pageKey: runtime.pageKey(canvas),
      })),
      diagnostics: diagnosePages(),
    }, location.origin);
    return true;
  }, startupController.signal, noteCanvasReplacementDuringInteraction);
}
}
