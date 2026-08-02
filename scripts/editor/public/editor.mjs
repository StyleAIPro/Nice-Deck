import { renderTaskDrawer } from './task-drawer.mjs';
import { connectEvents } from './ws-client.mjs';

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
const editorToken = params.get('editorToken') ?? '';
const deckFrame = document.querySelector('#deck-frame');
const pageList = document.querySelector('[data-page-list]');
const pageCount = document.querySelector('[data-page-count]');
const currentPage = document.querySelector('[data-current-page]');
const currentKey = document.querySelector('[data-current-key]');
const wsState = document.querySelector('[data-ws-state]');
const wsLabel = document.querySelector('[data-ws-label]');
const frameViewport = document.querySelector('[data-frame-viewport]');
const frameScene = document.querySelector('[data-frame-scene]');
const zoomValue = document.querySelector('[data-zoom]');
const regionButton = document.querySelector('[data-mode="region"]');
const modeBadge = document.querySelector('.mode-badge');
const taskDrawer = document.querySelector('[data-task-drawer]');
let pendingPageKey;
let tornDown = false;
let fitFrameRequest;
let eventsClient;
let pages = [];
let tasks = [];
let revision = 0;
let editorMode = 'preview';
const createRequests = new Set();
const MAX_SNAPSHOT_BYTES = 512 * 1024;

deckFrame.src = `/preview?token=${encodeURIComponent(token)}`;

function endpoint(pathname) {
  const url = new URL(pathname, location.href);
  url.searchParams.set('token', token);
  return url;
}

async function requestJson(pathname, options) {
  const response = await fetch(endpoint(pathname), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
  return body;
}

function uniqueTasks(values) {
  const byId = new Map();
  for (const task of values) {
    if (task?.id) byId.set(task.id, task);
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function snapshotByteLength(snapshot) {
  if (typeof snapshot !== 'string') return 0;
  const match = snapshot.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return 0;
  const padding = match[1].endsWith('==') ? 2 : (match[1].endsWith('=') ? 1 : 0);
  return Math.floor(match[1].length * 3 / 4) - padding;
}

function updatePageBadges() {
  const counts = new Map();
  for (const task of tasks) counts.set(task.pageKey, (counts.get(task.pageKey) ?? 0) + 1);
  for (const button of pageList.querySelectorAll('[data-page-key]')) {
    button.querySelector('[data-page-badge]')?.remove();
    const count = counts.get(button.dataset.pageKey) ?? 0;
    if (!count) continue;
    const badge = document.createElement('span');
    badge.className = 'page-badge';
    badge.dataset.pageBadge = '';
    badge.textContent = String(count);
    badge.setAttribute('aria-label', `${count} 条任务`);
    button.append(badge);
  }
}

function processAllHint() {
  return `外部 Agent CLI 读取命令：node scripts/editor/cli.mjs --url ${location.origin} --token ${token} tasks`;
}

function locateTask(task) {
  pendingPageKey = task.pageKey;
  deckFrame.contentWindow?.postMessage({
    type: 'locate-task',
    pageKey: task.pageKey,
    rect: task.rect,
  }, location.origin);
}

function renderTasks() {
  renderTaskDrawer(taskDrawer, {
    tasks,
    onLocate: locateTask,
    onProcessAll: processAllHint,
    onUndo: () => {},
  });
  updatePageBadges();
}

function upsertTask(task) {
  tasks = uniqueTasks([...tasks, task]);
  renderTasks();
}

async function loadSession() {
  const [session, persistedTasks] = await Promise.all([
    requestJson('/api/session'),
    requestJson('/api/tasks'),
  ]);
  revision = Math.max(revision, session.revision ?? 0);
  tasks = uniqueTasks([...(Array.isArray(persistedTasks) ? persistedTasks : []), ...tasks]);
  renderTasks();
}

function confirmPage(button) {
  for (const item of pageList.querySelectorAll('[data-page-key]')) {
    item.setAttribute('aria-current', item === button ? 'page' : 'false');
  }
  currentPage.textContent = button.dataset.pageTitle;
  currentKey.textContent = button.dataset.pageKey;
}

function requestPage(button) {
  pendingPageKey = button.dataset.pageKey;
  deckFrame.contentWindow?.postMessage({
    type: 'show-page',
    pageKey: pendingPageKey,
  }, location.origin);
}

function renderPages(nextPages) {
  pages = nextPages;
  pageList.replaceChildren();
  for (const page of pages) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-item';
    button.dataset.pageKey = page.pageKey;
    button.dataset.pageIndex = String(page.index);
    button.dataset.pageTitle = `${String(page.index).padStart(2, '0')} ${page.label}`;
    button.setAttribute('aria-current', 'false');
    const label = document.createElement('span');
    label.className = 'page-item-label';
    label.textContent = button.dataset.pageTitle;
    button.append(label);
    button.addEventListener('click', () => requestPage(button));
    pageList.append(button);
  }
  pageCount.textContent = `${pages.length} 页`;
  updatePageBadges();
  const firstPage = pageList.querySelector('[data-page-key]');
  if (firstPage) requestPage(firstPage);
}

function postRegionResult(requestId, result) {
  deckFrame.contentWindow?.postMessage({
    type: 'region-task-result',
    requestId,
    ...result,
  }, location.origin);
}

async function createRegionTask(message) {
  const { requestId, payload, snapshot = null } = message;
  if (typeof requestId !== 'string' || createRequests.has(requestId)) return;
  createRequests.add(requestId);
  try {
    let result;
    let submittedSnapshot = snapshot;
    let revisionRetried = false;
    let snapshotDropped = snapshotByteLength(snapshot) > MAX_SNAPSHOT_BYTES;
    if (snapshotDropped) submittedSnapshot = null;
    while (!result) {
      try {
        result = await requestJson('/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: revision, ...payload, snapshot: submittedSnapshot }),
        });
      } catch (error) {
        if (error.code === 'SNAPSHOT_TOO_LARGE' && submittedSnapshot !== null && !snapshotDropped) {
          submittedSnapshot = null;
          snapshotDropped = true;
          continue;
        }
        if (error.status === 409 && !revisionRetried) {
          revisionRetried = true;
          await loadSession();
          continue;
        }
        throw error;
      }
    }
    revision = Math.max(revision, result.revision);
    upsertTask(result.task);
    postRegionResult(requestId, { ok: true, taskId: result.task.id, snapshotDropped });
  } catch (error) {
    postRegionResult(requestId, { ok: false, message: error.message || '任务提交失败' });
  } finally {
    createRequests.delete(requestId);
  }
}

function onFrameMessage(event) {
  if (event.origin !== location.origin || event.source !== deckFrame.contentWindow) return;
  if (event.data?.type === 'deck-ready' && Array.isArray(event.data.pages)) {
    renderPages(event.data.pages);
    deckFrame.contentWindow?.postMessage({ type: 'set-editor-mode', mode: editorMode }, location.origin);
    return;
  }
  if (event.data?.type === 'create-region-task') {
    void createRegionTask(event.data);
    return;
  }
  if (event.data?.type !== 'page-shown' || event.data.pageKey !== pendingPageKey) return;
  pendingPageKey = undefined;
  if (event.data.shown !== true) return;
  const button = [...pageList.querySelectorAll('[data-page-key]')]
    .find(candidate => candidate.dataset.pageKey === event.data.pageKey);
  if (button) confirmPage(button);
}

window.addEventListener('message', onFrameMessage);

function setEditorMode(mode) {
  editorMode = mode;
  const active = mode === 'region';
  regionButton.setAttribute('aria-pressed', String(active));
  modeBadge.textContent = active ? '区域标记模式' : '预览模式';
  deckFrame.contentWindow?.postMessage({ type: 'set-editor-mode', mode }, location.origin);
}

const onRegionMode = () => setEditorMode(editorMode === 'region' ? 'preview' : 'region');
regionButton.addEventListener('click', onRegionMode);

function fitFrame() {
  const availableWidth = Math.max(frameViewport.clientWidth - 56, 1);
  const availableHeight = Math.max(frameViewport.clientHeight - 56, 1);
  const scale = Math.min(availableWidth / 1920, availableHeight / 1080, 1);
  frameScene.style.width = `${Math.round(1920 * scale)}px`;
  frameScene.style.height = `${Math.round(1080 * scale)}px`;
  deckFrame.style.transform = `scale(${scale})`;
  zoomValue.textContent = `${Math.round(scale * 100)}%`;
}

const resizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(fitFrameRequest);
  fitFrameRequest = requestAnimationFrame(fitFrame);
});
resizeObserver.observe(frameViewport);
fitFrame();
renderTasks();

const eventsUrl = new URL('/events', location.href);
eventsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
eventsUrl.searchParams.set('editorToken', editorToken);
eventsClient = connectEvents({
  url: eventsUrl,
  token,
  onEvent: event => {
    if (Number.isSafeInteger(event?.revision)) revision = Math.max(revision, event.revision);
    if (event?.type === 'task-created' && event.payload?.id) upsertTask(event.payload);
  },
  onState: state => {
    wsState.dataset.wsState = state;
    wsLabel.textContent = state === 'online' ? '在线' : '离线';
  },
});
void loadSession().catch(error => {
  taskDrawer.dataset.open = 'true';
  const note = taskDrawer.querySelector('[data-process-note]');
  if (note) note.textContent = `任务恢复失败：${error.message}`;
});

function teardown() {
  if (tornDown) return;
  tornDown = true;
  deckFrame.contentWindow?.postMessage({ type: 'editor-teardown' }, location.origin);
  eventsClient?.close();
  resizeObserver.disconnect();
  cancelAnimationFrame(fitFrameRequest);
  regionButton.removeEventListener('click', onRegionMode);
  window.removeEventListener('message', onFrameMessage);
  window.removeEventListener('pagehide', teardown);
  window.removeEventListener('unload', teardown);
}

window.addEventListener('pagehide', teardown);
window.addEventListener('unload', teardown);
