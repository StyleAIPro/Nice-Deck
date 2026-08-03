import { renderTaskDrawer } from './task-drawer.mjs';
import { connectEvents } from './ws-client.mjs';
import { compileActionGroups } from './action-compiler.mjs';
import { historyCandidates, historyLabel } from '/editor/history-state.mjs';

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
const revisionValue = document.querySelector('[data-revision]');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const modeBadge = document.querySelector('.mode-badge');
const taskDrawer = document.querySelector('[data-task-drawer]');
const historyControls = document.querySelector('.history-controls');
const undoButton = document.querySelector('[data-history-undo]');
const redoButton = document.querySelector('[data-history-redo]');
let pendingPageKey;
let tornDown = false;
let fitFrameRequest;
let eventsClient;
let pages = [];
let tasks = [];
let revision = 0;
let editorMode = 'preview';
let deckReady = false;
let deckReadyPayload;
let activeFrameInstanceId;
let authoritativeReloadPending;
const handledAuthoritativeReloads = new Set();
let sessionGroups = [];
let sessionRedo = [];
let historyBusy = false;
let loadedSessionRevision = -1;
let historyRefreshTargetRevision = 0;
let sessionRefreshTargetRevision = 0;
let sessionRefreshPromise;
let seenOnline = false;
const createRequests = new Set();
const manualRequests = new Set();
const commandReplies = new Map();
const pendingFrameCommands = new Map();
const MAX_SNAPSHOT_BYTES = 512 * 1024;

function onDeckFrameLoad() {
  // document load 早于 frame bridge 的稳定 canvas 发现；此窗口内的 Agent 命令必须排队。
  deckReady = false;
  deckReadyPayload = undefined;
  activeFrameInstanceId = undefined;
}

deckFrame.addEventListener('load', onDeckFrameLoad);
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
    error.failedActionId = body.failedActionId;
    error.candidates = body.candidates;
    error.committed = body.committed;
    error.commitConfirmed = body.commitConfirmed;
    error.recoveredBySync = body.recoveredBySync;
    error.revision = body.revision;
    error.groupId = body.groupId;
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

function updateRevision(value) {
  if (Number.isSafeInteger(value)) revision = Math.max(revision, value);
  revisionValue.textContent = String(revision);
}

function compiledSessionActions() {
  return compileActionGroups(sessionGroups);
}

function syncSessionActions() {
  if (!deckReady) return;
  deckFrame.contentWindow?.postMessage({
    type: 'sync-actions', actions: compiledSessionActions(),
  }, location.origin);
}

function announceDeckReady() {
  if (!deckReadyPayload) return false;
  return eventsClient?.send({ ...deckReadyPayload, revision }) ?? false;
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

function showTaskNotice(message) {
  taskDrawer.dataset.open = 'true';
  const note = taskDrawer.querySelector('[data-process-note]');
  if (note) note.textContent = message;
}

function renderHistory() {
  const { undoGroup, redoGroup } = historyCandidates(sessionGroups, sessionRedo);
  const refreshPending = loadedSessionRevision < historyRefreshTargetRevision;
  const controlsBusy = historyBusy || refreshPending;
  historyControls.dataset.busy = String(controlsBusy);
  historyControls.setAttribute('aria-busy', String(controlsBusy));
  undoButton.disabled = controlsBusy || !undoGroup;
  redoButton.disabled = controlsBusy || !redoGroup;
  undoButton.title = historyLabel(undoGroup, tasks, 'undo');
  redoButton.title = historyLabel(redoGroup, tasks, 'redo');
  undoButton.setAttribute('aria-label', undoButton.title);
  redoButton.setAttribute('aria-label', redoButton.title);
  undoButton.dataset.groupId = controlsBusy ? '' : (undoGroup?.id ?? '');
  redoButton.dataset.groupId = controlsBusy ? '' : (redoGroup?.id ?? '');
}

function expectHistoryRevision(targetRevision) {
  if (Number.isSafeInteger(targetRevision)) {
    historyRefreshTargetRevision = Math.max(historyRefreshTargetRevision, targetRevision);
  }
  renderHistory();
}

async function changeHistory(method, button) {
  if (historyBusy || !button.dataset.groupId) return;
  const groupId = button.dataset.groupId;
  historyBusy = true;
  renderHistory();
  try {
    let result;
    try {
      result = await requestJson(
        `/api/groups/${encodeURIComponent(groupId)}/${method}`,
        {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ expectedRevision:revision }),
        },
      );
    } catch (error) {
      if (error.committed === true) {
        updateRevision(error.revision);
        expectHistoryRevision(error.revision);
        await loadSession(error.revision).catch(() => {});
        showTaskNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、同步待确认`);
        return;
      }
      expectHistoryRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      showTaskNotice(error.code === 'REVISION_CONFLICT'
        ? '历史已更新，请重试'
        : `${method === 'undo' ? '撤销' : '重做'}失败：${error.message}`);
      return;
    }
    updateRevision(result.revision);
    expectHistoryRevision(result.revision);
    try {
      await ensureSessionRevision(result.revision);
    } catch {
      showTaskNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、会话同步待重试`);
      return;
    }
    if (result.syncPending) {
      showTaskNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、浏览器同步待重试`);
    }
  } finally {
    historyBusy = false;
    renderHistory();
  }
}

async function undoTask(task) {
  if (!task?.groupId) return;
  let retried = false;
  try {
    let result;
    while (!result) {
      try {
        result = await requestJson(`/api/groups/${encodeURIComponent(task.groupId)}/undo`, {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ expectedRevision:revision }),
        });
      } catch (error) {
        if (error.status === 409 && error.code === 'REVISION_CONFLICT' && !retried) {
          retried = true;
          await loadSession();
          const refreshed = tasks.find(candidate => candidate.id === task.id);
          if (!refreshed?.groupId) return;
          task = refreshed;
          continue;
        }
        if (error.committed === true) {
          updateRevision(error.revision);
          await loadSession(error.revision).catch(() => {});
          showTaskNotice('撤销已保存、会话同步待确认');
          return;
        }
        throw error;
      }
    }
    updateRevision(result.revision);
    await ensureSessionRevision(result.revision);
    if (result.syncPending) showTaskNotice('撤销已保存、浏览器同步待重试');
  } catch (error) {
    await loadSession(error.revision).catch(() => {});
    showTaskNotice(`撤销失败：${error.message || error.code || '未知错误'}`);
  }
}

function renderTasks() {
  renderTaskDrawer(taskDrawer, {
    tasks,
    onLocate: locateTask,
    onProcessAll: processAllHint,
    onUndo: task => { void undoTask(task); },
  });
  updatePageBadges();
  renderHistory();
}

function upsertTask(task) {
  tasks = uniqueTasks([...tasks, task]);
  renderTasks();
}

function loadSession(targetRevision = revision) {
  if (Number.isSafeInteger(targetRevision)) {
    sessionRefreshTargetRevision = Math.max(sessionRefreshTargetRevision, targetRevision);
  }
  if (sessionRefreshPromise) return sessionRefreshPromise;
  const refresh = async () => {
    let firstRequest = true;
    while (firstRequest || loadedSessionRevision < sessionRefreshTargetRevision) {
      firstRequest = false;
      const requestedRevision = sessionRefreshTargetRevision;
      const [session, persistedTasks] = await Promise.all([
        requestJson('/api/session'),
        requestJson('/api/tasks'),
      ]);
      const sessionRevision = Number.isSafeInteger(session.revision) ? session.revision : 0;
      updateRevision(sessionRevision);
      if (sessionRevision >= loadedSessionRevision) {
        loadedSessionRevision = sessionRevision;
        sessionGroups = Array.isArray(session.groups) ? session.groups : [];
        sessionRedo = Array.isArray(session.redo) ? session.redo : [];
        tasks = uniqueTasks([...tasks, ...(Array.isArray(persistedTasks) ? persistedTasks : [])]);
        renderTasks();
      }
      if (loadedSessionRevision < requestedRevision) {
        throw new Error(`权威会话 revision ${loadedSessionRevision} 落后于 ${requestedRevision}`);
      }
    }
    syncSessionActions();
  };
  sessionRefreshPromise = refresh().finally(() => { sessionRefreshPromise = undefined; });
  return sessionRefreshPromise;
}

function ensureSessionRevision(targetRevision) {
  if (!Number.isSafeInteger(targetRevision) || loadedSessionRevision >= targetRevision) {
    return Promise.resolve();
  }
  return loadSession(targetRevision);
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

function capturePagePreference() {
  const activePage = pageList.querySelector('[data-page-key][aria-current="page"]');
  const preferredPageKey = pendingPageKey || activePage?.dataset.pageKey;
  const preferredPage = preferredPageKey
    ? [...pageList.querySelectorAll('[data-page-key]')]
      .find(button => button.dataset.pageKey === preferredPageKey)
    : activePage;
  const preferredPageIndex = Number(preferredPage?.dataset.pageIndex);
  return {
    pageKey:preferredPageKey,
    pageIndex:Number.isSafeInteger(preferredPageIndex) && preferredPageIndex > 0
      ? preferredPageIndex : undefined,
  };
}

function renderPages(nextPages, preferredPageKey, preferredPageIndex) {
  pages = nextPages;
  pageList.replaceChildren();
  for (const page of pages) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-item';
    button.dataset.pageKey = page.pageKey;
    button.dataset.pageIndex = String(page.index);
    button.dataset.pageLabel = page.label;
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
  const preferredPage = preferredPageKey
    ? pageList.querySelector(`[data-page-key="${CSS.escape(preferredPageKey)}"]`)
    : null;
  const fallbackPage = Number.isSafeInteger(preferredPageIndex) && preferredPageIndex > 0
    ? pageList.querySelector(`[data-page-index="${preferredPageIndex}"]`)
    : null;
  const requestedPage = preferredPage ?? fallbackPage ?? pageList.querySelector('[data-page-key]');
  if (requestedPage) requestPage(requestedPage);
}

function postRegionResult(requestId, result) {
  deckFrame.contentWindow?.postMessage({
    type: 'region-task-result',
    requestId,
    ...result,
  }, location.origin);
}

function postManualResult(requestId, result) {
  deckFrame.contentWindow?.postMessage({
    type: 'manual-actions-result', requestId, ...result,
  }, location.origin);
}

async function submitManualActions(message) {
  const { requestId, actions } = message;
  if (typeof requestId !== 'string' || manualRequests.has(requestId)) return;
  manualRequests.add(requestId);
  try {
    let result;
    let retried = false;
    while (!result) {
      try {
        result = await requestJson('/api/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: revision, taskId: null, actions }),
        });
      } catch (error) {
        if (error.status === 409 && error.code === 'REVISION_CONFLICT' && !retried) {
          retried = true;
          await loadSession();
          continue;
        }
        throw error;
      }
    }
    updateRevision(result.revision);
    let sessionRefreshPending = false;
    try { await ensureSessionRevision(result.revision); }
    catch { sessionRefreshPending = true; }
    postManualResult(requestId, {
      ok:true, ...result, sessionRefreshPending,
      ...(sessionRefreshPending ? { message:'动作已保存、会话同步待重试' } : {}),
    });
  } catch (error) {
    if (error.committed === true) {
      updateRevision(error.revision);
      await loadSession().catch(() => {});
      postManualResult(requestId, {
        ok: true, committed:true, commitConfirmed:false, recoveredBySync:false,
        syncPending:true, revision:error.revision, groupId:error.groupId,
        message:'动作已保存、同步待确认',
      });
      return;
    }
    postManualResult(requestId, {
      ok: false, code: error.code, message: error.message || '动作提交失败',
      failedActionId: error.failedActionId, candidates: error.candidates,
    });
  } finally {
    manualRequests.delete(requestId);
  }
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
  if (tornDown) return;
  if (event.data?.type === 'request-authoritative-reload'
    && typeof event.data.frameInstanceId === 'string'
    && Number.isSafeInteger(event.data.requestSequence)
    && event.data.requestSequence > 0) {
    if (event.data.frameInstanceId !== activeFrameInstanceId) return;
    const requestKey = `${event.data.frameInstanceId}:${event.data.requestSequence}`;
    if (handledAuthoritativeReloads.has(requestKey) || authoritativeReloadPending) return;
    handledAuthoritativeReloads.add(requestKey);
    const pagePreference = capturePagePreference();
    authoritativeReloadPending = {
      frameInstanceId:event.data.frameInstanceId,
      requestSequence:event.data.requestSequence,
      pageKey:pagePreference.pageKey || currentKey.textContent,
      pageIndex:pagePreference.pageIndex,
    };
    deckReady = false;
    deckReadyPayload = undefined;
    pendingPageKey = undefined;
    deckFrame.contentWindow?.location.reload();
    return;
  }
  if (event.data?.type === 'deck-error' && typeof event.data.code === 'string') {
    deckReady = false;
    deckReadyPayload = undefined;
    pages = [];
    pendingFrameCommands.clear();
    pageList.replaceChildren();
    const error = document.createElement('div');
    error.dataset.deckError = '';
    error.setAttribute('role', 'alert');
    error.textContent = `${event.data.code}：${event.data.message || 'Deck 运行时不可用'}`;
    pageList.append(error);
    pageCount.textContent = '0 页';
    currentPage.textContent = '运行时错误';
    currentKey.textContent = event.data.code;
    return;
  }
  if (event.data?.type === 'deck-ready' && Array.isArray(event.data.pages)) {
    if (authoritativeReloadPending
      && event.data.frameInstanceId === authoritativeReloadPending.frameInstanceId) return;
    const pagePreference = capturePagePreference();
    const completedReload = authoritativeReloadPending;
    activeFrameInstanceId = typeof event.data.frameInstanceId === 'string'
      ? event.data.frameInstanceId : undefined;
    deckReady = true;
    deckReadyPayload = {
      type:'deck-ready',
      pages:event.data.pages,
      diagnostics:Array.isArray(event.data.diagnostics) ? event.data.diagnostics : [],
    };
    announceDeckReady();
    renderPages(
      event.data.pages,
      completedReload?.pageKey ?? pagePreference.pageKey,
      completedReload?.pageIndex ?? pagePreference.pageIndex,
    );
    deckFrame.contentWindow?.postMessage({ type: 'set-editor-mode', mode: editorMode }, location.origin);
    if (loadedSessionRevision >= revision) syncSessionActions();
    else void ensureSessionRevision(revision).catch(() => {});
    for (const command of pendingFrameCommands.values()) {
      deckFrame.contentWindow?.postMessage(command, location.origin);
    }
    pendingFrameCommands.clear();
    if (completedReload) {
      authoritativeReloadPending = undefined;
      deckFrame.contentWindow?.postMessage({ type:'show-authoritative-reload-notice' }, location.origin);
    }
    return;
  }
  if (event.data?.type === 'create-region-task') {
    void createRegionTask(event.data);
    return;
  }
  if (event.data?.type === 'submit-manual-actions') {
    void submitManualActions(event.data);
    return;
  }
  if (['actions-applied', 'actions-rejected', 'actions-prepared', 'actions-committed',
    'actions-rolled-back', 'actions-synced', 'diagnostics-result',
    'diagnostics-rejected'].includes(event.data?.type)
    && typeof event.data.commandId === 'string') {
    commandReplies.set(`${event.data.type}:${event.data.commandId}`, event.data);
    if (commandReplies.size > 100) commandReplies.delete(commandReplies.keys().next().value);
    eventsClient?.send(event.data);
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
  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  const labels = {
    preview: '预览模式', region: '区域标记模式', text: '文字模式',
    move: '移动模式', resize: '缩放模式',
  };
  modeBadge.textContent = labels[mode] ?? '预览模式';
  deckFrame.contentWindow?.postMessage({ type: 'set-editor-mode', mode }, location.origin);
}

const onModeClick = event => setEditorMode(event.currentTarget.dataset.mode);
for (const button of modeButtons) button.addEventListener('click', onModeClick);
const onUndoClick = () => { void changeHistory('undo', undoButton); };
const onRedoClick = () => { void changeHistory('redo', redoButton); };
undoButton.addEventListener('click', onUndoClick);
redoButton.addEventListener('click', onRedoClick);

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
    const replyTypes = {
      'apply-actions': event?.tentative === true ? 'actions-prepared' : 'actions-applied',
      'commit-actions': 'actions-committed',
      'rollback-actions': 'actions-rolled-back',
      'sync-actions': 'actions-synced',
      'diagnose-pages': 'diagnostics-result',
    };
    if (replyTypes[event?.type] && typeof event.commandId === 'string') {
      const reply = commandReplies.get(`${replyTypes[event.type]}:${event.commandId}`);
      if (reply) eventsClient?.send(reply);
      else if (deckReady) deckFrame.contentWindow?.postMessage(event, location.origin);
      else pendingFrameCommands.set(event.commandId, event);
      return;
    }
    if (['actions-recorded','group-undone','group-redone'].includes(event?.type)) {
      expectHistoryRevision(event.revision);
      updateRevision(event.revision);
      void ensureSessionRevision(event.revision).catch(() => {});
    } else {
      updateRevision(event?.revision);
    }
    if (['task-created','task-updated'].includes(event?.type) && event.payload?.id) {
      upsertTask(event.payload);
    }
  },
  onState: state => {
    wsState.dataset.wsState = state;
    wsLabel.textContent = state === 'online' ? '在线' : '离线';
    if (state === 'offline') {
      deckFrame.contentWindow?.postMessage({ type:'rollback-all-tentative' }, location.origin);
    } else {
      announceDeckReady();
      if (seenOnline) void loadSession().catch(() => {});
      else seenOnline = true;
    }
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
  pendingFrameCommands.clear();
  deckFrame.removeEventListener('load', onDeckFrameLoad);
  for (const button of modeButtons) button.removeEventListener('click', onModeClick);
  undoButton.removeEventListener('click', onUndoClick);
  redoButton.removeEventListener('click', onRedoClick);
  window.removeEventListener('message', onFrameMessage);
  window.removeEventListener('pagehide', teardown);
  window.removeEventListener('unload', teardown);
}

window.addEventListener('pagehide', teardown);
window.addEventListener('unload', teardown);
