import { renderTaskDrawer } from './task-drawer.mjs';
import { renderAgentConnectionPanel } from './agent-connection-panel.mjs';
import { renderInspectorPanel } from './inspector-panel.mjs';
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
const agentStatus = document.querySelector('[data-agent-status]');
const agentLabel = document.querySelector('[data-agent-label]');
const agentConnectionAnchor = document.querySelector('[data-agent-connection-anchor]');
const agentConnectionPanel = document.querySelector('[data-agent-connection-panel]');
const frameViewport = document.querySelector('[data-frame-viewport]');
const frameScene = document.querySelector('[data-frame-scene]');
const zoomValue = document.querySelector('[data-zoom]');
const revisionValue = document.querySelector('[data-revision]');
const modeTools = document.querySelector('.mode-tools');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const taskDrawer = document.querySelector('[data-task-drawer]');
const historyControls = document.querySelector('.history-controls');
const undoButton = document.querySelector('[data-history-undo]');
const redoButton = document.querySelector('[data-history-redo]');
const inspectorContent = document.querySelector('[data-inspector-content]');
const selectionState = document.querySelector('[data-selection-state]');
let pendingPageKey;
let tornDown = false;
let fitFrameRequest;
let eventsClient;
let pages = [];
let tasks = [];
let agentRun = { status:'idle' };
let agentConfiguration = null;
let agentSessions = null;
let agentSessionsLoading = false;
let agentSessionsPromise = null;
let agentSessionsError = '';
let agentPanelOpen = false;
let agentPanelProvider = 'codex';
let agentConnectionBusy = false;
let agentConnectionNotice = '';
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
let historySnapshotRequirement = 0;
let historySnapshotFulfilled = 0;
let sessionRefreshTargetRevision = 0;
let sessionRefreshPromise;
let seenOnline = false;
let inspectorSelection = null;
let inspectorBusy = false;
let inspectorNotice = '';
let pendingInspectorRequest = null;
let historyNoticeTimer;
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
  inspectorSelection = null;
  inspectorBusy = false;
  pendingInspectorRequest = null;
  inspectorNotice = '';
  renderInspector();
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

function adoptAgentRun(nextRun) {
  if (!nextRun?.status) return false;
  if (agentRun.id && !nextRun.id) return false;
  if (nextRun.id && agentRun.id && nextRun.id !== agentRun.id
    && Number(nextRun.generation ?? 0) <= Number(agentRun.generation ?? 0)) {
    return false;
  }
  if (nextRun.id && nextRun.id === agentRun.id
    && Number(nextRun.sequence ?? 0) < Number(agentRun.sequence ?? 0)) {
    return false;
  }
  agentRun = nextRun;
  return true;
}

function renderAgentStatus() {
  const connection = agentConfiguration?.connection;
  const connected = Boolean(connection?.threadId);
  const provider = agentConfiguration?.providers?.find(item => item.id === connection?.provider);
  const providerName = provider?.name ?? connection?.provider ?? 'Agent';
  agentStatus.dataset.agentStatus = connected ? 'online' : 'offline';
  agentLabel.textContent = connected ? `${providerName} 在线` : 'Agent 离线';
  const detail = connected
    ? `已连接 ${providerName} 任务 ${connection.threadId}，点击查看连接设置`
    : 'Agent 会话未连接，点击设置';
  agentStatus.title = detail;
  agentStatus.setAttribute('aria-label', detail);
  agentStatus.setAttribute('aria-expanded', String(agentPanelOpen));
}

function openAgentConnectionSettings() {
  agentPanelOpen = !agentPanelOpen;
  if (agentPanelOpen) {
    agentPanelProvider = agentConfiguration?.connection?.provider
      ?? agentConfiguration?.selectedProvider
      ?? agentPanelProvider;
    void loadAgentSessions().catch(() => {});
  }
  renderAgentPanel();
  renderAgentStatus();
}

function compiledSessionActions() {
  return compileActionGroups(sessionGroups);
}

const INSPECTOR_KIND_LABELS = Object.freeze({
  text:'文字', shape:'图形', svg:'SVG', image:'图片',
});

function sameInspectorTarget(left, right) {
  return Boolean(left && right)
    && left.pageKey === right.pageKey
    && left.path === right.path
    && String(left.tag ?? '') === String(right.tag ?? '');
}

function sameInspectorScope(action, selection) {
  const actionRange = action.payload?.textRange;
  const selectionRange = selection.textRange;
  if (!selectionRange) return actionRange === undefined;
  return actionRange?.start === selectionRange.start && actionRange?.end === selectionRange.end;
}

function enrichInspectorSelection(selection) {
  if (!selection?.target || !selection.computed || !selection.inline) return selection;
  const resetValues = { ...selection.inline };
  const historyBaselines = new Set();
  for (const group of sessionGroups) {
    for (const action of group.actions ?? []) {
      if (action.kind !== 'setStyle' || !sameInspectorTarget(action.target, selection.target)
        || !sameInspectorScope(action, selection)) continue;
      const property = action.payload?.property;
      if (typeof property === 'string' && typeof action.before === 'string'
        && !historyBaselines.has(property)) {
        resetValues[property] = action.before;
        historyBaselines.add(property);
      }
    }
  }
  const modifiedProperties = compiledSessionActions()
    .filter(action => action.kind === 'setStyle'
      && sameInspectorTarget(action.target, selection.target)
      && sameInspectorScope(action, selection)
      && action.payload?.value !== resetValues[action.payload?.property])
    .map(action => action.payload.property);
  return { ...selection, resetValues, modifiedProperties:[...new Set(modifiedProperties)] };
}

function applyInspectorChanges(changes) {
  if (!inspectorSelection || inspectorBusy || !Array.isArray(changes) || changes.length === 0) return;
  const requestId = crypto.randomUUID();
  pendingInspectorRequest = { requestId, selectionId:inspectorSelection.selectionId };
  inspectorBusy = true;
  inspectorNotice = '正在保存样式…';
  renderInspector();
  deckFrame.contentWindow?.postMessage({
    type:'apply-inspector-styles', requestId,
    selectionId:inspectorSelection.selectionId, changes,
  }, location.origin);
}

function resetAllInspectorStyles() {
  if (!inspectorSelection) return;
  const changes = inspectorSelection.modifiedProperties.map(property => ({
    property, value:inspectorSelection.resetValues?.[property] ?? '',
  }));
  applyInspectorChanges(changes);
}

function renderInspector() {
  inspectorSelection = enrichInspectorSelection(inspectorSelection);
  selectionState.textContent = inspectorSelection?.scope === 'text-range'
    ? '选中文字'
    : (inspectorSelection
      ? (INSPECTOR_KIND_LABELS[inspectorSelection.kind] ?? '已选中') : '未选中');
  selectionState.dataset.selected = String(Boolean(inspectorSelection));
  renderInspectorPanel(inspectorContent, {
    selection:inspectorSelection,
    busy:inspectorBusy,
    notice:inspectorNotice,
    onApply:applyInspectorChanges,
    onResetAll:resetAllInspectorStyles,
  });
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

function dataUrlToBlob(snapshot) {
  if (snapshot === null) return null;
  if (typeof snapshot !== 'string') throw new TypeError('区域快照格式无效');
  const match = snapshot.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new TypeError('区域快照格式无效');
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type:'image/png' });
}

function taskFormData(payload, snapshot, attachments, expectedRevision) {
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...payload,
    expectedRevision,
    attachmentSources:attachments.map(item => item.source),
  })], { type:'application/json' }), 'task.json');
  if (snapshot !== null) form.append('snapshot', dataUrlToBlob(snapshot), 'region.png');
  for (const item of attachments) form.append('attachment', item.file, item.file.name);
  return form;
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

async function processAllTasks(selectedTasks) {
  try {
    const startedRun = await requestJson('/api/agent-runs', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:revision,
        taskIds:selectedTasks.map(task => task.id),
      }),
    });
    adoptAgentRun(startedRun);
    renderTasks();
    return agentRun.message;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      showTaskNotice('任务列表已经变化，请检查后再次点击“交给 Agent”');
      return '';
    }
    if (error.code === 'AGENT_RUN_ACTIVE') {
      adoptAgentRun(await requestJson('/api/agent-runs/current').catch(() => agentRun));
      renderTasks();
      return '';
    }
    throw new Error(`无法交给 Agent：${error.message}`);
  }
}

async function configureAgentConnection({ provider, threadId }) {
  agentConnectionBusy = true;
  agentConnectionNotice = threadId ? '正在检测 Skill 并连接会话…' : '正在断开当前会话…';
  renderAgentPanel();
  try {
    const configuration = await requestJson('/api/agent-connection', {
      method:'PUT',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision, provider, threadId }),
    });
    agentConfiguration = configuration;
    agentPanelProvider = configuration.connection.provider;
    updateRevision(configuration.revision);
    await loadSession(configuration.revision);
    agentConnectionNotice = threadId
      ? '已连接；重新打开此 Deck 时会继续该会话。'
      : '已断开；可选择已有会话或新建专用会话。';
    void loadAgentSessions({ force:true }).catch(() => {});
    renderTasks();
    return agentConnectionNotice;
  } catch (error) {
    agentConnectionNotice = `连接失败：${error.message}`;
    throw error;
  } finally {
    agentConnectionBusy = false;
    renderAgentPanel();
    renderAgentStatus();
  }
}

async function loadAgentSessions({ force = false } = {}) {
  if (agentSessionsPromise) return agentSessionsPromise;
  if (agentSessions && !force) return agentSessions;
  agentSessionsLoading = true;
  agentSessionsError = '';
  renderAgentPanel();
  agentSessionsPromise = requestJson('/api/agent-sessions')
    .then(catalog => {
      agentSessions = catalog;
      return catalog;
    })
    .catch(error => {
      agentSessionsError = error?.message || '会话目录读取失败';
      throw error;
    })
    .finally(() => {
      agentSessionsLoading = false;
      agentSessionsPromise = null;
      renderAgentPanel();
    });
  return agentSessionsPromise;
}

async function pickAgentProject() {
  agentConnectionBusy = true;
  agentConnectionNotice = '正在打开系统项目目录选择器…';
  renderAgentPanel();
  try {
    const result = await requestJson('/api/agent-projects/pick', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:'{}',
    });
    agentConnectionNotice = result.status === 'cancelled'
      ? '已取消选择项目。'
      : `已添加项目：${result.project.name}`;
    await loadAgentSessions({ force:true });
  } catch (error) {
    agentConnectionNotice = `添加项目失败：${error.message}`;
  } finally {
    agentConnectionBusy = false;
    renderAgentPanel();
  }
}

async function createAgentSession({ provider, projectPath }) {
  agentConnectionBusy = true;
  agentConnectionNotice = '正在创建会话并加载一次 huawei-deck Skill…';
  renderAgentPanel();
  try {
    const configuration = await requestJson('/api/agent-sessions', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision, provider, projectPath }),
    });
    agentConfiguration = configuration;
    agentPanelProvider = provider;
    updateRevision(configuration.revision);
    await loadSession(configuration.revision);
    agentConnectionNotice = '新会话已创建、Skill 已加载，并已连接当前 Deck。';
    await loadAgentSessions({ force:true });
    renderTasks();
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT' && Number.isSafeInteger(error.revision)) {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
    }
    agentConnectionNotice = `新建会话失败：${error.message}`;
  } finally {
    agentConnectionBusy = false;
    renderAgentPanel();
    renderAgentStatus();
  }
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

function showHistoryNotice(message, state = 'warning') {
  clearTimeout(historyNoticeTimer);
  let notice = document.querySelector('[data-history-notice]');
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'history-notice';
    notice.dataset.historyNotice = '';
    notice.setAttribute('role', 'status');
    document.body.append(notice);
  }
  notice.dataset.state = state;
  notice.textContent = message;
  notice.hidden = false;
  historyNoticeTimer = setTimeout(() => { notice.hidden = true; }, state === 'error' ? 5200 : 3200);
}

function renderHistory() {
  const { undoGroup, redoGroup } = historyCandidates(sessionGroups, sessionRedo);
  const refreshPending = loadedSessionRevision < historyRefreshTargetRevision
    || historySnapshotFulfilled < historySnapshotRequirement;
  const controlsBusy = historyBusy || refreshPending;
  historyControls.dataset.busy = String(controlsBusy);
  historyControls.setAttribute('aria-busy', String(controlsBusy));
  undoButton.disabled = controlsBusy || !undoGroup;
  redoButton.disabled = controlsBusy || !redoGroup;
  undoButton.title = `${historyLabel(undoGroup, tasks, 'undo')} · Cmd/Ctrl+Z`;
  redoButton.title = `${historyLabel(redoGroup, tasks, 'redo')} · Cmd/Ctrl+Shift+Z`;
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

function requireHistoryRefresh(targetRevision) {
  if (Number.isSafeInteger(targetRevision)) {
    historyRefreshTargetRevision = Math.max(historyRefreshTargetRevision, targetRevision);
  } else {
    historySnapshotRequirement += 1;
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
        requireHistoryRefresh(error.revision);
        await loadSession(error.revision).catch(() => {});
        showHistoryNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、同步待确认`);
        return;
      }
      if (error.code === 'REVISION_CONFLICT') requireHistoryRefresh(error.revision);
      else expectHistoryRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      showHistoryNotice(error.code === 'REVISION_CONFLICT'
        ? '历史已更新，请重试'
        : `${method === 'undo' ? '撤销' : '重做'}失败：${error.message}`, 'error');
      return;
    }
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
    try {
      await ensureSessionRevision(result.revision);
    } catch {
      showHistoryNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、会话同步待重试`);
      return;
    }
    if (result.syncPending) {
      showHistoryNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、浏览器同步待重试`);
    }
  } finally {
    historyBusy = false;
    renderHistory();
  }
}

function historyMethodForShortcut(event) {
  if (event.altKey || (!event.metaKey && !event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}

function acceptsNativeHistoryShortcut(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  return Boolean(element?.closest(
    'input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])',
  ));
}

function triggerHistoryShortcut(method) {
  const button = method === 'undo' ? undoButton : redoButton;
  if (historyBusy || button.disabled || !button.dataset.groupId) return false;
  void changeHistory(method, button);
  return true;
}

function onHistoryKeydown(event) {
  const method = historyMethodForShortcut(event);
  if (!method || acceptsNativeHistoryShortcut(event.target)) return;
  event.preventDefault();
  triggerHistoryShortcut(method);
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
          requireHistoryRefresh(error.revision);
          await loadSession();
          const refreshed = tasks.find(candidate => candidate.id === task.id);
          if (!refreshed?.groupId) return;
          task = refreshed;
          continue;
        }
        if (error.committed === true) {
          updateRevision(error.revision);
          requireHistoryRefresh(error.revision);
          await loadSession(error.revision).catch(() => {});
          showTaskNotice('撤销已保存、会话同步待确认');
          return;
        }
        throw error;
      }
    }
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
    try {
      await ensureSessionRevision(result.revision);
    } catch {
      showTaskNotice('撤销已保存、会话同步待重试');
      return;
    }
    if (result.syncPending) showTaskNotice('撤销已保存、浏览器同步待重试');
  } catch (error) {
    await loadSession(error.revision).catch(() => {});
    showTaskNotice(`撤销失败：${error.message || error.code || '未知错误'}`);
  }
}

async function editTask(task, instruction) {
  try {
    const result = await requestJson(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method:'PATCH',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision, instruction }),
    });
    updateRevision(result.revision);
    upsertTask(result.task);
    return result.task;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      throw new Error('任务列表已经变化，请重新编辑');
    }
    throw error;
  }
}

async function deleteTask(task) {
  try {
    const result = await requestJson(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method:'DELETE',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision }),
    });
    updateRevision(result.revision);
    tasks = tasks.filter(candidate => candidate.id !== task.id);
    renderTasks();
    return result;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      throw new Error('任务列表已经变化，请重新确认删除');
    }
    throw error;
  }
}

function renderTasks() {
  renderTaskDrawer(taskDrawer, {
    tasks,
    agentRun,
    onLocate: locateTask,
    onProcessAll: processAllTasks,
    onUndo: task => { void undoTask(task); },
    onEdit:editTask,
    onDelete:deleteTask,
  });
  renderAgentStatus();
  updatePageBadges();
  renderHistory();
}

function renderAgentPanel() {
  renderAgentConnectionPanel(agentConnectionPanel, {
    open:agentPanelOpen,
    configuration:agentConfiguration,
    catalog:agentSessions,
    loading:agentSessionsLoading,
    error:agentSessionsError,
    busy:agentConnectionBusy,
    notice:agentConnectionNotice,
    selectedProvider:agentPanelProvider,
    onClose:() => {
      agentPanelOpen = false;
      renderAgentPanel();
      renderAgentStatus();
      agentStatus.focus();
    },
    onSelectProvider:provider => {
      agentPanelProvider = provider;
      agentConnectionNotice = '';
      renderAgentPanel();
    },
    onRefresh:() => loadAgentSessions({ force:true }).catch(() => {}),
    onConnect:session => configureAgentConnection({
      provider:session.provider,
      threadId:session.id,
    }).catch(() => {}),
    onDisconnect:() => configureAgentConnection({
      provider:agentConfiguration?.connection?.provider ?? agentPanelProvider,
      threadId:null,
    }).catch(() => {}),
    onPickProject:() => { void pickAgentProject(); },
    onCreateSession:input => { void createAgentSession(input); },
    onManualConnect:input => configureAgentConnection(input).catch(() => {}),
  });
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
    while (firstRequest || loadedSessionRevision < sessionRefreshTargetRevision
      || historySnapshotFulfilled < historySnapshotRequirement) {
      firstRequest = false;
      const requestedRevision = sessionRefreshTargetRevision;
      const requestedSnapshotRequirement = historySnapshotRequirement;
      const [session, persistedTasks] = await Promise.all([
        requestJson('/api/session'),
        requestJson('/api/tasks'),
      ]);
      const sessionRevision = Number.isSafeInteger(session.revision) ? session.revision : 0;
      historySnapshotFulfilled = Math.max(
        historySnapshotFulfilled,
        requestedSnapshotRequirement,
      );
      updateRevision(sessionRevision);
      if (sessionRevision >= loadedSessionRevision) {
        loadedSessionRevision = sessionRevision;
        sessionGroups = Array.isArray(session.groups) ? session.groups : [];
        sessionRedo = Array.isArray(session.redo) ? session.redo : [];
        tasks = uniqueTasks([...tasks, ...(Array.isArray(persistedTasks) ? persistedTasks : [])]);
        renderTasks();
        renderInspector();
      } else {
        renderHistory();
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
  if ((!Number.isSafeInteger(targetRevision) || loadedSessionRevision >= targetRevision)
    && historySnapshotFulfilled >= historySnapshotRequirement) {
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
          requireHistoryRefresh(error.revision);
          await loadSession();
          continue;
        }
        throw error;
      }
    }
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
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
      requireHistoryRefresh(error.revision);
      await loadSession(error.revision).catch(() => {});
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
  const { requestId, payload, snapshot = null, attachments = [] } = message;
  if (typeof requestId !== 'string' || createRequests.has(requestId)) return;
  createRequests.add(requestId);
  try {
    if (!Array.isArray(attachments) || attachments.length > 8
      || attachments.some(item => !item || !['selected', 'pasted'].includes(item.source)
        || !(item.file instanceof File))) {
      throw new TypeError('附件提交数据无效');
    }
    let result;
    let submittedSnapshot = snapshot;
    let revisionRetried = false;
    let snapshotDropped = snapshotByteLength(snapshot) > MAX_SNAPSHOT_BYTES;
    if (snapshotDropped) submittedSnapshot = null;
    while (!result) {
      try {
        result = await requestJson('/api/tasks', {
          method: 'POST',
          body: taskFormData(payload, submittedSnapshot, attachments, revision),
        });
      } catch (error) {
        if (error.code === 'SNAPSHOT_TOO_LARGE' && submittedSnapshot !== null && !snapshotDropped) {
          submittedSnapshot = null;
          snapshotDropped = true;
          continue;
        }
        if (error.status === 409 && error.code === 'REVISION_CONFLICT' && !revisionRetried) {
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
    postRegionResult(requestId, {
      ok:false,
      code:error.code,
      message:error.message || '任务提交失败',
    });
  } finally {
    createRequests.delete(requestId);
  }
}

function onFrameMessage(event) {
  if (event.origin !== location.origin || event.source !== deckFrame.contentWindow) return;
  if (tornDown) return;
  if (event.data?.type === 'inspector-selection-changed') {
    inspectorSelection = event.data.selection?.selectionId ? event.data.selection : null;
    if (!inspectorSelection) {
      inspectorBusy = false;
      pendingInspectorRequest = null;
      inspectorNotice = '';
    }
    renderInspector();
    return;
  }
  if (event.data?.type === 'inspector-style-result'
    && pendingInspectorRequest?.requestId === event.data.requestId) {
    pendingInspectorRequest = null;
    inspectorBusy = false;
    inspectorNotice = event.data.ok
      ? (event.data.sessionRefreshPending ? '样式已保存，会话同步待重试' : '')
      : `失败：${event.data.message || '样式修改未保存'}`;
    renderInspector();
    return;
  }
  if (event.data?.type === 'history-shortcut'
    && ['undo', 'redo'].includes(event.data.method)) {
    triggerHistoryShortcut(event.data.method);
    return;
  }
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
    inspectorSelection = null;
    inspectorBusy = false;
    pendingInspectorRequest = null;
    inspectorNotice = '';
    renderInspector();
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
  editorMode = ['text', 'move', 'resize'].includes(mode) ? 'edit' : mode;
  modeTools.dataset.activeMode = editorMode;
  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === editorMode));
  }
  deckFrame.contentWindow?.postMessage({ type: 'set-editor-mode', mode:editorMode }, location.origin);
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
renderAgentPanel();
renderInspector();
agentStatus.addEventListener('click', openAgentConnectionSettings);

function onAgentPanelOutsidePointer(event) {
  if (!agentPanelOpen
    || agentConnectionAnchor.contains(event.target)
    || agentConnectionPanel.contains(event.target)) return;
  agentPanelOpen = false;
  renderAgentPanel();
  renderAgentStatus();
}

function onAgentPanelKeydown(event) {
  if (!agentPanelOpen || event.key !== 'Escape') return;
  event.preventDefault();
  agentPanelOpen = false;
  renderAgentPanel();
  renderAgentStatus();
  agentStatus.focus();
}

document.addEventListener('pointerdown', onAgentPanelOutsidePointer);
document.addEventListener('keydown', onAgentPanelKeydown);
document.addEventListener('keydown', onHistoryKeydown);

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
    } else if (event?.type === 'task-deleted' && event.payload?.id) {
      tasks = tasks.filter(task => task.id !== event.payload.id);
      renderTasks();
    } else if (event?.type === 'agent-run-updated' && event.payload?.status) {
      if (adoptAgentRun(event.payload)) renderTasks();
    } else if (event?.type === 'agent-connection-updated' && event.payload?.connection) {
      agentConfiguration = event.payload;
      void ensureSessionRevision(event.revision).catch(() => {});
      renderTasks();
      renderAgentPanel();
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
void Promise.all([
  loadSession(),
  requestJson('/api/agent-runs/current').then(run => {
    if (adoptAgentRun(run)) renderTasks();
  }),
  requestJson('/api/agent-connection').then(configuration => {
    agentConfiguration = configuration;
    agentPanelProvider = configuration.connection?.provider ?? agentPanelProvider;
    renderTasks();
    renderAgentPanel();
  }),
]).catch(error => {
  showHistoryNotice(`编辑状态恢复失败：${error.message}`, 'error');
});

function teardown() {
  if (tornDown) return;
  tornDown = true;
  clearTimeout(historyNoticeTimer);
  deckFrame.contentWindow?.postMessage({ type: 'editor-teardown' }, location.origin);
  eventsClient?.close();
  resizeObserver.disconnect();
  cancelAnimationFrame(fitFrameRequest);
  pendingFrameCommands.clear();
  deckFrame.removeEventListener('load', onDeckFrameLoad);
  for (const button of modeButtons) button.removeEventListener('click', onModeClick);
  undoButton.removeEventListener('click', onUndoClick);
  redoButton.removeEventListener('click', onRedoClick);
  agentStatus.removeEventListener('click', openAgentConnectionSettings);
  document.removeEventListener('pointerdown', onAgentPanelOutsidePointer);
  document.removeEventListener('keydown', onAgentPanelKeydown);
  document.removeEventListener('keydown', onHistoryKeydown);
  window.removeEventListener('message', onFrameMessage);
  window.removeEventListener('pagehide', teardown);
  window.removeEventListener('unload', teardown);
}

window.addEventListener('pagehide', teardown);
window.addEventListener('unload', teardown);
