import { renderTaskDrawer, setTaskDrawerOpen } from './task-drawer.mjs';
import { AgentTerminalPanel } from './agent-terminal-panel.mjs';
import { WorkspaceSwitcher } from './workspace-switcher.mjs';
import { renderInspectorPanel } from './inspector-panel.mjs';
import { AppModal } from './native-controls.mjs';
import { installPillNav, setPillLabel } from './pill-nav.mjs';
import { connectEvents } from './ws-client.mjs';
import { createLauncherLeaseClient } from './launcher-lease-client.mjs';
import { compileActionGroups, sourceRebaseActionIds } from './action-compiler.mjs';
import { historyCandidates, historyLabel } from '/editor/history-state.mjs';
import { isRegionShortcutKey } from '/editor/editor-shortcuts.mjs';

const params = new URLSearchParams(location.search);
installPillNav(document);
const token = params.get('token') ?? '';
const editorToken = params.get('editorToken') ?? '';
const embeddedCreation = params.get('embedded') === 'creation';
const workspaceNavigation = document.querySelector('[data-workspace-navigation]');
const switchWorkspaceButton = document.querySelector('[data-workspace-switch]');
const workspaceHomeButton = document.querySelector('[data-workspace-home]');
const exitEditorButton = document.querySelector('[data-exit-editor]');
const workspaceKind = params.get('workspaceKind') === 'creation' ? 'creation' : 'editing';
if (embeddedCreation) document.documentElement.dataset.embedded = 'creation';
const deckFrame = document.querySelector('#deck-frame');
const pageList = document.querySelector('[data-page-list]');
const pageCount = document.querySelector('[data-page-count]');
const currentPage = document.querySelector('[data-current-page]');
const currentKey = document.querySelector('[data-current-key]');
const wsState = document.querySelector('[data-ws-state]');
const wsLabel = document.querySelector('[data-ws-label]');
const agentStatus = document.querySelector('[data-agent-status]');
const agentLabels = [document.querySelector('[data-agent-label]')].filter(Boolean);
const agentTerminalRoot = document.querySelector('[data-agent-terminal-panel]');
const editorShell = document.querySelector('.editor-shell');
if (embeddedCreation) editorShell.dataset.embedded = 'creation';
const frameViewport = document.querySelector('[data-frame-viewport]');
const frameScene = document.querySelector('[data-frame-scene]');
const zoomValue = document.querySelector('[data-zoom]');
const revisionValue = document.querySelector('[data-revision]');
const exportPptxButton = document.querySelector('[data-export-pptx]');
const modeTools = document.querySelector('.mode-tools');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const pagePanelToggle = document.querySelector('[data-page-panel-toggle]');
const taskDrawer = document.querySelector('[data-task-drawer]');
const historyControls = document.querySelector('.history-controls');
const undoButton = document.querySelector('[data-history-undo]');
const redoButton = document.querySelector('[data-history-redo]');
const solidifyButton = document.querySelector('[data-solidify]');
const solidifyDialog = document.querySelector('[data-solidify-dialog]');
const solidifyCancel = document.querySelector('[data-solidify-cancel]');
const solidifyExitWithout = document.querySelector('[data-solidify-exit-without]');
const solidifyConfirm = document.querySelector('[data-solidify-confirm]');
const solidifyCount = document.querySelector('[data-solidify-count]');
const solidifyMark = document.querySelector('[data-solidify-mark]');
const solidifyEyebrow = document.querySelector('[data-solidify-eyebrow]');
const solidifyTitle = document.querySelector('[data-solidify-title]');
const solidifyDescription = document.querySelector('[data-solidify-description]');
const solidifyTaskSummary = document.querySelector('[data-solidify-task-summary]');
const solidifyTaskCount = document.querySelector('[data-solidify-task-count]');
const solidifyTaskList = document.querySelector('[data-solidify-task-list]');
const solidifyOtherCount = document.querySelector('[data-solidify-other-count]');
const solidifyProgress = document.querySelector('[data-solidify-progress]');
const solidifyProgressBar = document.querySelector('[data-solidify-progressbar]');
const solidifyProgressLabel = document.querySelector('[data-solidify-progress-label]');
const solidifyProgressValue = document.querySelector('[data-solidify-progress-value]');
const deckBindingBanner = document.querySelector('[data-deck-binding-banner]');
const deckBindingTitle = document.querySelector('[data-deck-binding-title]');
const deckBindingDetail = document.querySelector('[data-deck-binding-detail]');
const deckBindingRecheck = document.querySelector('[data-deck-binding-recheck]');
const deckBindingChoose = document.querySelector('[data-deck-binding-choose]');
const solidifyModal = new AppModal(solidifyDialog, {
  panel:solidifyDialog.querySelector('[role="dialog"]'),
  onRequestClose:() => !solidifyBusy,
});
Object.defineProperty(solidifyDialog, 'open', { get:() => solidifyModal.open });
const inspectorPanel = document.querySelector('.inspector-panel');
const inspectorContent = document.querySelector('[data-inspector-content]');
const selectionState = document.querySelector('[data-selection-state]');
const inspectorCollapseButton = document.querySelector('[data-inspector-collapse]');
const inspectorReopenButton = document.querySelector('[data-inspector-reopen]');
let pendingPageKey;
let tornDown = false;
let fitFrameRequest;
let eventsClient;
let pages = [];
let tasks = [];
let agentRun = { status:'idle' };
let agentTerminal;
let agentTerminalOpen = false;
let agentTerminalState = { provider:'codex', state:'stopped' };
let revision = 0;
let editorMode = ['preview', 'edit', 'region'].includes(params.get('mode'))
  ? params.get('mode') : 'region';
let temporaryRegionShortcut = false;
let deckSurfacePointerActive = false;
let inspectorExpanded = false;
let deckReady = false;
let deckReadyPayload;
let activeFrameInstanceId;
let authoritativeReloadPending;
let shownStartupRecovery = null;
const handledAuthoritativeReloads = new Set();
let sessionGroups = [];
let sessionRedo = [];
let historyBusy = false;
let solidifyBusy = false;
let solidifyDialogReason = 'toolbar';
let deckBinding = { state:'locating', reason:'none', revision:0, canPublish:false };
let deckBindingBusy = false;
let lastSolidifiedReloadRevision = -1;
let lastWorkingReloadRevision = -1;
let loadedSessionRevision = -1;
let historyRefreshTargetRevision = 0;
let historySnapshotRequirement = 0;
let historySnapshotFulfilled = 0;
let pendingHistoryShortcut = null;
let sessionRefreshTargetRevision = 0;
let sessionRefreshPromise;
let seenOnline = false;
let inspectorSelection = null;
let inspectorBusy = false;
let inspectorNotice = '';
let pendingInspectorRequest = null;
let historyNoticeTimer;
let pptxExportBusy = false;
const createRequests = new Set();
const manualRequests = new Set();
const commandReplies = new Map();
const pendingFrameCommands = new Map();
const MAX_SNAPSHOT_BYTES = 512 * 1024;

function trustedWorkspaceUrl(value) {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '::1'
      || url.hostname.startsWith('127.');
    return url.protocol === 'http:' && loopback ? url : null;
  } catch { return null; }
}

const workspaceUrl = trustedWorkspaceUrl(params.get('workspaceUrl'));
let navigateToWorkspaceHome;
let terminateEditorProcess;

function requestProcessShutdown(url) {
  document.documentElement.dataset.processExiting = 'true';
  exitEditorButton.disabled = true;
  switchWorkspaceButton.disabled = true;
  workspaceHomeButton.disabled = true;
  setPillLabel(exitEditorButton, '正在退出…');
  let beaconSent = false;
  try { beaconSent = navigator.sendBeacon(url); }
  catch { beaconSent = false; }
  if (!beaconSent) {
    void fetch(url, {
      method:'POST', keepalive:true,
      ...(url.origin === location.origin ? {} : { mode:'no-cors' }),
    }).catch(() => {});
  }
  setTimeout(() => window.close(), 80);
}

const closeStandaloneEditor = () => requestProcessShutdown(endpoint('/api/shutdown'));
if (workspaceUrl && !embeddedCreation) {
  workspaceNavigation.hidden = false;
  const workspaceClientId = workspaceUrl.searchParams.get('clientId');
  const workspaceClientSequence = Number(workspaceUrl.searchParams.get('sequence'));
  const workspaceLeaseUrl = pathname => {
    const url = new URL(pathname, workspaceUrl);
    url.searchParams.set('token', workspaceUrl.searchParams.get('token') ?? '');
    if (workspaceClientId && Number.isSafeInteger(workspaceClientSequence)) {
      url.searchParams.set('clientId', workspaceClientId);
      url.searchParams.set('sequence', String(workspaceClientSequence));
    }
    return url;
  };
  terminateEditorProcess = () => requestProcessShutdown(workspaceLeaseUrl('/api/shutdown'));
  if (workspaceClientId && Number.isSafeInteger(workspaceClientSequence)) {
    navigator.sendBeacon(workspaceLeaseUrl('/api/client-connected'));
    const workspaceLeaseClient = createLauncherLeaseClient({
      workspaceUrl,
      clientId:workspaceClientId,
      sequence:workspaceClientSequence,
    });
    workspaceLeaseClient.start();
    window.addEventListener('pagehide', () => {
      workspaceLeaseClient.close();
      navigator.sendBeacon(workspaceLeaseUrl('/api/close'));
    }, { once:true });
  }
  const navigate = destination => {
    switchWorkspaceButton.disabled = true;
    workspaceHomeButton.disabled = true;
    exitEditorButton.disabled = true;
    workspaceUrl.searchParams.set('view', destination);
    workspaceUrl.searchParams.set('leaveWorkspace', '1');
    location.replace(workspaceUrl.href);
  };
  navigateToWorkspaceHome = () => navigate('home');
  new WorkspaceSwitcher({
    root:workspaceNavigation,
    trigger:switchWorkspaceButton,
    loadHistory:() => requestJson('/api/workspace-history'),
    isCurrent:(kind, entry) => kind === workspaceKind
      && entry.runtimeState === 'foreground',
    onRename:input => requestJson('/api/work-items/rename', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(input),
    }),
    onSelect:(kind, entry) => {
      switchWorkspaceButton.disabled = true;
      workspaceHomeButton.disabled = true;
      exitEditorButton.disabled = true;
      const target = new URL(workspaceUrl);
      target.searchParams.set('view', kind);
      target.searchParams.set('leaveWorkspace', '1');
      target.searchParams.set('switchKind', kind);
      if (kind === 'creation') {
        target.searchParams.set('projectRoot', entry.projectRoot);
        target.searchParams.set('draftId', entry.draftId);
      } else {
        target.searchParams.set('deckPath', entry.deckPath);
        if (typeof entry.workId === 'string') target.searchParams.set('workId', entry.workId);
      }
      location.replace(target.href);
    },
  });
  workspaceHomeButton.addEventListener('click', navigateToWorkspaceHome);
}
if (!embeddedCreation) {
  navigateToWorkspaceHome ??= closeStandaloneEditor;
  terminateEditorProcess ??= closeStandaloneEditor;
  exitEditorButton.hidden = false;
  exitEditorButton.addEventListener('click', requestWorkspaceExit);
}

function onDeckFrameLoad() {
  // document load 早于 frame bridge 的稳定 canvas 发现；此窗口内的 Agent 命令必须排队。
  deckReady = false;
  deckReadyPayload = undefined;
  activeFrameInstanceId = undefined;
  deckSurfacePointerActive = false;
  inspectorSelection = null;
  inspectorBusy = false;
  pendingInspectorRequest = null;
  inspectorNotice = '';
  renderInspector();
  renderHistory();
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
    error.binding = body.binding;
    error.candidate = body.candidate;
    error.stage = body.stage;
    error.recovery = body.recovery;
    error.diagnostic = body.diagnostic;
    throw error;
  }
  return body;
}

function pptxDownloadName(response) {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); }
    catch { /* 回退到兼容文件名。 */ }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return plain || 'deck.pptx';
}

async function onExportPptx() {
  if (pptxExportBusy) return;
  pptxExportBusy = true;
  exportPptxButton.disabled = true;
  exportPptxButton.dataset.exportState = 'busy';
  exportPptxButton.setAttribute('aria-busy', 'true');
  exportPptxButton.setAttribute('aria-label', '正在导出 PPTX');
  exportPptxButton.title = '正在导出 PPTX';
  showHistoryNotice('正在生成 PPTX，页数较多时可能需要几十秒…');
  try {
    const response = await fetch(endpoint('/api/export/pptx'), {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.message || `HTTP ${response.status}`);
      error.code = body.code ?? body.error;
      throw error;
    }
    const filename = pptxDownloadName(response);
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
    showHistoryNotice(`PPTX 已导出：${filename}`, 'success');
  } catch (error) {
    const message = error.code === 'REVISION_CONFLICT'
      ? '编辑内容刚刚更新，请再次点击导出'
      : error.code === 'PPTX_EXPORT_BUSY'
        ? '已有一个 PPTX 正在导出，请稍候'
        : error.message;
    showHistoryNotice(`PPTX 导出失败：${message}`, 'error');
  } finally {
    pptxExportBusy = false;
    exportPptxButton.disabled = false;
    delete exportPptxButton.dataset.exportState;
    exportPptxButton.removeAttribute('aria-busy');
    exportPptxButton.setAttribute('aria-label', '导出为 PPTX');
    exportPptxButton.title = '导出为 PPTX';
  }
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
  const runtime = agentTerminalState;
  const workspaceProvider = runtime.provider ?? 'codex';
  const workspaceProviderName = {
    codex:'Codex', 'claude-code':'Claude Code',
  }[workspaceProvider] ?? workspaceProvider;
  const interactionRequired = runtime.interactionRequired?.kind
    ? runtime.interactionRequired
    : null;
  const startupLocked = ['pending', 'submitting'].includes(runtime.startupPromptState);
  const promptReady = runtime.promptReady !== false;
  const initializing = runtime.state === 'starting'
    || (runtime.state === 'running' && !promptReady)
    || startupLocked;
  const busy = !interactionRequired && (initializing
    || ['queued', 'running'].includes(agentRun.status));
  const ready = runtime.state === 'running' && promptReady
    && !startupLocked && !interactionRequired;
  const failed = ['failed', 'exited'].includes(runtime.state);
  agentStatus.dataset.agentStatus = interactionRequired
    ? 'attention'
    : (busy ? 'busy' : (ready ? 'online' : 'standby'));
  let label = `${workspaceProviderName} 未启动`;
  if (interactionRequired) label = `${workspaceProviderName} 等待确认`;
  else if (agentRun.status === 'queued') label = `${workspaceProviderName} 正在提交`;
  else if (initializing) label = `${workspaceProviderName} 准备中`;
  else if (busy) label = `${workspaceProviderName} 处理中`;
  else if (ready) label = `${workspaceProviderName} 空闲`;
  else if (failed) label = `${workspaceProviderName} 启动失败`;
  for (const agentLabel of agentLabels) agentLabel.textContent = label;
  const detail = interactionRequired?.message ?? (ready
    ? `打开 ${workspaceProviderName} 交互终端`
    : `打开 ${workspaceProviderName} 终端并启动 bypass 会话`);
  agentStatus.title = detail;
  agentStatus.setAttribute('aria-label', detail);
  agentStatus.setAttribute('aria-expanded', String(agentTerminalOpen));
}

function renderAgentTerminal() {
  editorShell.dataset.agentTerminalOpen = String(agentTerminalOpen);
  renderInspectorLayout();
  if (agentTerminalOpen) agentTerminal.open(agentTerminalState.provider);
  else agentTerminal.hide();
}

function openAgentTerminal() {
  agentTerminalOpen = !agentTerminalOpen;
  renderAgentTerminal();
  renderAgentStatus();
}

function ensureAgentTerminalOpen() {
  if (agentTerminalOpen) return false;
  agentTerminalOpen = true;
  renderAgentTerminal();
  renderAgentStatus();
  return true;
}

function adoptAgentTerminalState(state) {
  if (!state?.provider || !state?.state) return false;
  agentTerminalState = state;
  if (state.interactionRequired?.kind) ensureAgentTerminalOpen();
  renderAgentStatus();
  return true;
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
  if (selectionRange) {
    return actionRange?.start === selectionRange.start && actionRange?.end === selectionRange.end;
  }
  const textStyleRange = selection.textStyleRange;
  if (textStyleRange && actionRange) {
    return actionRange.start >= textStyleRange.start && actionRange.end <= textStyleRange.end;
  }
  return actionRange === undefined;
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

function applyInspectorChanges(changes, { coalesceKey = '', scope = 'selection' } = {}) {
  if (!inspectorSelection || inspectorBusy || !Array.isArray(changes) || changes.length === 0) return;
  const requestId = crypto.randomUUID();
  pendingInspectorRequest = { requestId, selectionId:inspectorSelection.selectionId };
  inspectorBusy = true;
  inspectorNotice = '正在保存样式…';
  renderInspector();
  deckFrame.contentWindow?.postMessage({
    type:'apply-inspector-styles', requestId,
    selectionId:inspectorSelection.selectionId, changes,
    ...(scope === 'element' ? { scope:'element' } : {}),
    ...(coalesceKey ? { coalesceKey:`${inspectorSelection.selectionId}:${coalesceKey}` } : {}),
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

function renderInspectorLayout() {
  const editMode = editorMode === 'edit';
  const expanded = editMode && inspectorExpanded;
  const dock = agentTerminalOpen ? 'top' : 'right';
  const state = !editMode ? 'hidden' : (expanded ? 'expanded' : 'collapsed');
  editorShell.dataset.inspectorDock = dock;
  editorShell.dataset.inspectorState = state;
  inspectorContent.querySelector(':scope > .inspector-body')?.dispatchEvent(new CustomEvent(
    'inspector-dock-change', { detail:{ dock } },
  ));
  inspectorPanel.hidden = !expanded;
  inspectorReopenButton.hidden = state !== 'collapsed';

  const collapseDirection = dock === 'top' ? 'up' : 'right';
  const reopenDirection = dock === 'top' ? 'down' : 'left';
  inspectorCollapseButton.dataset.pillArrowDirection = collapseDirection;
  inspectorReopenButton.dataset.pillArrowDirection = reopenDirection;
  inspectorCollapseButton.setAttribute('aria-label', `向${dock === 'top' ? '上' : '右'}收起属性面板`);
  inspectorCollapseButton.title = inspectorCollapseButton.getAttribute('aria-label');
  inspectorReopenButton.setAttribute('aria-label', `展开${dock === 'top' ? '顶部' : '右侧'}属性面板`);
  inspectorReopenButton.title = inspectorReopenButton.getAttribute('aria-label');
}

function setInspectorExpanded(expanded) {
  if (editorMode !== 'edit') return;
  inspectorExpanded = expanded === true;
  renderInspectorLayout();
}

function syncSessionActions() {
  if (!deckReady) return;
  const actions = compiledSessionActions();
  deckFrame.contentWindow?.postMessage({
    type:'sync-actions', actions,
    rebaseActionIds:sourceRebaseActionIds(sessionGroups, actions),
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
  for (const task of tasks) {
    if (task.targetMissing === true) continue;
    if (!['pending', 'processing', 'failed', 'needs-confirmation'].includes(task.status)) continue;
    counts.set(task.pageKey, (counts.get(task.pageKey) ?? 0) + 1);
  }
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
  ensureAgentTerminalOpen();
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

function locateTask(task) {
  if (task?.targetMissing === true) {
    showTaskNotice('这个任务的原目标当前不可定位；请撤销相关结构修改或删除任务后重新标记。');
    return;
  }
  pendingPageKey = task.pageKey;
  deckFrame.contentWindow?.postMessage({
    type: 'locate-task',
    pageKey: task.pageKey,
    rect: task.rect,
    pageState: task.pageState,
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
  const unsolidifiedCount = sessionGroups.length;
  const refreshPending = loadedSessionRevision < historyRefreshTargetRevision
    || historySnapshotFulfilled < historySnapshotRequirement;
  const controlsBusy = historyBusy || solidifyBusy || refreshPending;
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
  solidifyButton.dataset.busy = String(solidifyBusy);
  solidifyButton.dataset.unsolidified = String(unsolidifiedCount > 0);
  const bindingBlocked = deckBinding.state !== 'bound';
  solidifyButton.disabled = controlsBusy || bindingBlocked || unsolidifiedCount === 0;
  solidifyButton.title = bindingBlocked
    ? '源文件需要重新绑定，工作副本仍会继续保存'
    : unsolidifiedCount > 0
      ? `固化 ${unsolidifiedCount} 组修改并清空撤销记录`
      : '当前没有可固化的修改';
  solidifyCount.textContent = `将固化 ${unsolidifiedCount} 组修改`;
  if (solidifyDialog.open) renderSolidifyDialogContent(solidifyDialogReason);
}

function renderDeckBinding(next, { announce = false } = {}) {
  if (!next || !Number.isSafeInteger(next.revision)) return;
  if (next.revision < deckBinding.revision) return;
  const previous = deckBinding;
  deckBinding = next;
  editorShell.dataset.deckBindingState = next.state;
  const blocked = !embeddedCreation && next.state !== 'bound';
  deckBindingBanner.hidden = !blocked;
  if (blocked) {
    const replaced = next.reason === 'replaced';
    deckBindingTitle.textContent = replaced
      ? '原路径现在是另一份文件，已停止固化'
      : '源文件位置已变化，需要重新绑定';
    deckBindingDetail.textContent = replaced
      ? 'Editor 不会覆盖这份新文件；当前修改仍安全保存在工作副本中。'
      : '编辑内容仍会安全保存在工作副本中，重新绑定前无法固化。';
  } else if (announce && next.reason === 'renamed'
    && previous.currentPath !== next.currentPath) {
    showHistoryNotice(
      `已检测到文件改名，已更新为「${next.currentPath.split(/[\\/]/).at(-1)}」`,
      'success',
    );
  }
  deckBindingRecheck.disabled = deckBindingBusy;
  deckBindingChoose.disabled = deckBindingBusy;
  renderHistory();
}

async function reconcileDeckBinding() {
  if (deckBindingBusy) return;
  deckBindingBusy = true;
  deckBindingRecheck.disabled = true;
  deckBindingChoose.disabled = true;
  try {
    renderDeckBinding(await requestJson('/api/deck-binding/reconcile', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:'{}',
    }), { announce:true });
  } catch (error) {
    showHistoryNotice(`重新检查失败：${error.message}`, 'error');
  } finally {
    deckBindingBusy = false;
    deckBindingRecheck.disabled = false;
    deckBindingChoose.disabled = false;
  }
}

async function chooseDeckBinding() {
  if (deckBindingBusy) return;
  deckBindingBusy = true;
  deckBindingRecheck.disabled = true;
  deckBindingChoose.disabled = true;
  try {
    let result;
    try {
      result = await requestJson('/api/deck-binding/choose-file', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedBindingRevision:deckBinding.revision }),
      });
    } catch (error) {
      if (error.code !== 'DECK_BINDING_VERIFIED_COPY_CONFIRMATION_REQUIRED'
        || typeof error.candidate !== 'string') throw error;
      if (error.binding) renderDeckBinding(error.binding);
      const confirmed = window.confirm(
        '所选文件不是原来的物理文件，但内容与最后源版本完全一致。确认把这个内容一致的副本作为当前 Deck 源文件吗？',
      );
      if (!confirmed) {
        showHistoryNotice('已取消绑定内容一致的副本', 'working');
        return;
      }
      result = await requestJson('/api/deck-binding/choose-file', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({
          expectedBindingRevision:deckBinding.revision,
          confirmation:'verified-copy',
          candidatePath:error.candidate,
        }),
      });
    }
    renderDeckBinding(result.binding, { announce:result.status === 'rebound' });
    if (result.status === 'rebound') {
      showHistoryNotice('源文件已重新绑定，可以继续固化', 'success');
    }
  } catch (error) {
    if (error.binding) renderDeckBinding(error.binding);
    showHistoryNotice(`重新绑定失败：${error.message}`, 'error');
  } finally {
    deckBindingBusy = false;
    deckBindingRecheck.disabled = false;
    deckBindingChoose.disabled = false;
  }
}

deckBindingRecheck.addEventListener('click', reconcileDeckBinding);
deckBindingChoose.addEventListener('click', chooseDeckBinding);

function hasUnsolidifiedChanges() {
  return sessionGroups.length > 0 || sessionRedo.length > 0;
}

function taskTimestamp(task) {
  for (const value of [task?.updatedAt, task?.createdAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function unsolidifiedDialogState() {
  const activeGroups = sessionGroups.filter(group => group?.active === true);
  const taskById = new Map(tasks.map(task => [task?.id, task]));
  const sectionsByKey = new Map();
  activeGroups.forEach((group, groupIndex) => {
    const taskId = typeof group?.taskId === 'string' ? group.taskId : null;
    const task = taskId ? taskById.get(taskId) ?? null : null;
    const key = taskId ? `task:${taskId}` : 'direct';
    let section = sectionsByKey.get(key);
    if (!section) {
      section = { key, taskId, task, groups:[], latestIndex:groupIndex };
      sectionsByKey.set(key, section);
    }
    section.groups.push(group);
    section.latestIndex = groupIndex;
  });
  const taskSections = [...sectionsByKey.values()].sort((left, right) => (
    taskTimestamp(right.task) - taskTimestamp(left.task)
    || right.latestIndex - left.latestIndex
  ));
  return {
    activeGroupCount:activeGroups.length,
    taskSections,
    linkedTaskCount:taskSections.filter(section => section.taskId).length,
    redoCount:sessionRedo.length,
  };
}

const ACTION_LABELS = {
  setText:'文字修改',
  translate:'位置移动',
  resize:'尺寸调整',
  setStyle:'样式修改',
  hide:'隐藏元素',
  show:'显示元素',
};

function unsolidifiedGroupSummary(group) {
  if (group?.compensation) return '任务撤销补偿';
  if (group?.mutationType === 'source') {
    const detail = typeof group.source?.summary === 'string'
      ? group.source.summary.trim() : '';
    return detail ? `结构修改：${detail}` : '结构修改';
  }
  const counts = new Map();
  for (const action of group?.actions ?? []) {
    const label = ACTION_LABELS[action?.kind] ?? '其他修改';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = [...counts].map(([label, count]) => count > 1 ? `${label} ${count} 项` : label);
  return labels.join('、') || '一组修改';
}

function renderSolidifyDialogContent(reason = 'toolbar') {
  const {
    activeGroupCount, taskSections, linkedTaskCount, redoCount,
  } = unsolidifiedDialogState();
  const closing = reason === 'exit';
  const hasPendingChanges = activeGroupCount > 0 || redoCount > 0;
  const activeAgent = ['queued', 'running'].includes(agentRun.status);
  solidifyDialog.dataset.reason = closing ? 'exit' : 'toolbar';
  solidifyMark.textContent = closing ? '!' : '✓';
  solidifyEyebrow.textContent = closing ? 'EXIT EDITOR' : 'PERMANENT SAVE';
  solidifyTitle.textContent = closing
    ? linkedTaskCount > 0
      ? `退出前还有 ${linkedTaskCount} 个任务存在未固化修改`
      : hasPendingChanges
        ? '退出前还有修改没有固化'
        : 'Agent 正在处理当前任务'
    : '固化当前修改？';
  solidifyDescription.textContent = closing
    ? hasPendingChanges
      ? `这些修改仍安全保存在工作副本中，但还没有写入原 Deck。${activeAgent ? '退出还会中断当前 Agent 执行。' : ''}`
      : '退出会中断当前 Agent 执行；已经保存的工作副本不会丢失。'
    : '这会把当前修改永久写入这个 Deck，并清空全部撤销和重做记录。固化完成后无法恢复到之前的状态。';
  solidifyCount.textContent = redoCount > 0
    ? `将固化当前生效的 ${activeGroupCount} 组修改，并清空 ${redoCount} 组重做记录`
    : `将固化 ${activeGroupCount} 组修改`;
  solidifyCount.hidden = closing && !hasPendingChanges;

  solidifyTaskList.replaceChildren();
  for (const section of taskSections) {
    const { taskId, task, groups } = section;
    const item = document.createElement('details');
    item.className = 'solidify-task';
    item.dataset.solidifyTask = taskId ?? 'direct';
    const summary = document.createElement('summary');
    summary.className = 'solidify-task-summary-row';
    const taskName = document.createElement('p');
    taskName.className = 'solidify-task-name';
    taskName.textContent = task?.instruction
      ?? (taskId ? `任务 ${taskId.slice(0, 8)}` : '直接编辑与结构调整');
    const chevron = document.createElement('span');
    chevron.className = 'solidify-task-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    summary.append(taskName, chevron);
    item.append(summary);
    item.addEventListener('toggle', () => {
      if (!item.open || item.dataset.detailsLoaded === 'true') return;
      item.dataset.detailsLoaded = 'true';
      const details = document.createElement('div');
      details.className = 'solidify-task-details';
      const meta = document.createElement('div');
      meta.className = 'solidify-task-meta';
      const page = document.createElement('span');
      page.className = 'solidify-task-page';
      page.textContent = task
        ? `${String(task.pageIndex).padStart(2, '0')} · ${task.pageLabel}`
        : taskId ? '任务记录 · 页面信息不可用' : '当前 Deck · 直接编辑';
      const status = document.createElement('span');
      status.className = 'solidify-task-status';
      status.textContent = `${groups.length} 组未固化`;
      meta.append(page, status);
      const changes = document.createElement('ul');
      changes.className = 'solidify-change-list';
      for (const group of groups) {
        const change = document.createElement('li');
        change.className = 'solidify-change-item';
        change.textContent = unsolidifiedGroupSummary(group);
        changes.append(change);
      }
      details.append(meta, changes);
      item.append(details);
    });
    solidifyTaskList.append(item);
  }
  solidifyTaskSummary.hidden = taskSections.length === 0;
  solidifyTaskCount.textContent = linkedTaskCount > 0
    ? `${linkedTaskCount} 个任务 · ${activeGroupCount} 组`
    : `${activeGroupCount} 组直接编辑`;

  const otherChanges = [];
  if (redoCount > 0) otherChanges.push(`${redoCount} 组已撤销历史`);
  solidifyOtherCount.hidden = otherChanges.length === 0;
  solidifyOtherCount.textContent = otherChanges.length > 0
    ? `另有 ${otherChanges.join('、')}尚未固化。`
    : '';

  setPillLabel(solidifyCancel, closing ? '继续编辑' : '取消');
  setPillLabel(solidifyExitWithout, hasPendingChanges ? '暂不固化，退出' : '中断并退出');
  setPillLabel(solidifyConfirm, closing ? '固化并退出' : '永久固化');
  solidifyExitWithout.hidden = !closing;
  solidifyConfirm.hidden = closing && !hasPendingChanges;
  solidifyCancel.disabled = solidifyBusy;
  solidifyExitWithout.disabled = solidifyBusy;
  solidifyConfirm.disabled = solidifyBusy || solidifyButton.disabled;
  solidifyConfirm.title = deckBinding.state !== 'bound'
    ? '源文件需要重新绑定后才能固化'
    : solidifyConfirm.disabled && !solidifyBusy
      ? '正在同步修改历史，请稍后重试'
      : '';
}

function requestWorkspaceExit() {
  if (!terminateEditorProcess || solidifyBusy) return;
  const activeAgent = ['queued', 'running'].includes(agentRun.status);
  if (!hasUnsolidifiedChanges() && !activeAgent) {
    terminateEditorProcess();
    return;
  }
  openSolidifyDialog('exit');
}

function openSolidifyDialog(reason = 'toolbar') {
  const closing = reason === 'exit';
  if ((!closing && solidifyButton.disabled) || solidifyBusy) return;
  solidifyDialogReason = closing ? 'exit' : 'toolbar';
  renderSolidifyDialogContent(solidifyDialogReason);
  if (solidifyDialog.open) return;
  resetSolidifyProgress();
  solidifyModal.show();
}

function closeSolidifyDialog() {
  if (!solidifyBusy && solidifyDialog.open) solidifyModal.close();
}

function exitWorkspaceWithoutSolidifying() {
  if (solidifyBusy || !terminateEditorProcess) return;
  closeSolidifyDialog();
  terminateEditorProcess();
}

function resetSolidifyProgress() {
  solidifyProgress.hidden = true;
  solidifyProgress.dataset.state = 'idle';
  solidifyProgress.style.removeProperty('--solidify-progress');
  solidifyProgressLabel.textContent = '准备固化…';
  solidifyProgressValue.textContent = '';
  solidifyProgressBar.removeAttribute('aria-valuenow');
  solidifyProgressBar.setAttribute('aria-valuetext', '准备固化');
}

function setSolidifyProgress({ state, label, value }) {
  solidifyProgress.hidden = false;
  solidifyProgress.dataset.state = state;
  solidifyProgressLabel.textContent = label;
  if (Number.isFinite(value)) {
    const boundedValue = Math.max(0, Math.min(100, Math.round(value)));
    solidifyProgress.style.setProperty('--solidify-progress', `${boundedValue}%`);
    solidifyProgressValue.textContent = `${boundedValue}%`;
    solidifyProgressBar.setAttribute('aria-valuenow', String(boundedValue));
  } else {
    solidifyProgress.style.removeProperty('--solidify-progress');
    solidifyProgressValue.textContent = '';
    solidifyProgressBar.removeAttribute('aria-valuenow');
  }
  solidifyProgressBar.setAttribute('aria-valuetext', label);
}

function reloadSolidifiedDeck(targetRevision) {
  if (!Number.isSafeInteger(targetRevision) || targetRevision <= lastSolidifiedReloadRevision) return;
  lastSolidifiedReloadRevision = targetRevision;
  const pagePreference = capturePagePreference();
  authoritativeReloadPending = {
    frameInstanceId:`solidify:${targetRevision}`,
    requestSequence:targetRevision,
    pageKey:pagePreference.pageKey || currentKey.textContent,
    pageIndex:pagePreference.pageIndex,
  };
  deckReady = false;
  deckReadyPayload = undefined;
  pendingPageKey = undefined;
  const previewUrl = endpoint('/preview');
  previewUrl.searchParams.set('solidifiedRevision', String(targetRevision));
  deckFrame.src = previewUrl;
}

function reloadWorkingDeck(targetRevision, reason = 'source') {
  if (!Number.isSafeInteger(targetRevision) || targetRevision <= lastWorkingReloadRevision) return;
  lastWorkingReloadRevision = targetRevision;
  const pagePreference = capturePagePreference();
  authoritativeReloadPending = {
    frameInstanceId:`${reason}:${targetRevision}`,
    requestSequence:targetRevision,
    pageKey:pagePreference.pageKey || currentKey.textContent,
    pageIndex:pagePreference.pageIndex,
  };
  deckReady = false;
  deckReadyPayload = undefined;
  pendingPageKey = undefined;
  const previewUrl = endpoint('/preview');
  previewUrl.searchParams.set('workingRevision', String(targetRevision));
  deckFrame.src = previewUrl;
}

async function solidifyChanges() {
  if (solidifyBusy || !hasUnsolidifiedChanges()) return false;
  const exitAfterSolidify = solidifyDialogReason === 'exit';
  solidifyBusy = true;
  solidifyConfirm.disabled = true;
  solidifyCancel.disabled = true;
  solidifyExitWithout.disabled = true;
  setPillLabel(solidifyConfirm, '正在固化…');
  setSolidifyProgress({
    state:'indeterminate',
    label:'正在校验并写入 Deck…',
  });
  renderHistory();
  try {
    setSolidifyProgress({
      state:'indeterminate',
      label:'正在检查历史、页面与文件状态…',
    });
    const preflight = await requestJson('/api/solidify-preflight', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:revision,
        expectedBindingRevision:deckBinding.revision,
      }),
    });
    setSolidifyProgress({
      state:'determinate',
      label:'检查通过，正在原子写入 Deck…',
      value:32,
    });
    const result = await requestJson('/api/solidify-deck', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:revision,
        expectedBindingRevision:deckBinding.revision,
        preflightToken:preflight.preflightToken,
      }),
    });
    setSolidifyProgress({
      state:'determinate',
      label:'写入完成，正在刷新编辑器…',
      value:78,
    });
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
    reloadSolidifiedDeck(result.revision);
    await ensureSessionRevision(result.revision);
    setSolidifyProgress({ state:'complete', label:'固化完成', value:100 });
    await new Promise(resolve => setTimeout(resolve, 220));
    if (solidifyDialog.open) solidifyModal.close();
    if (exitAfterSolidify) {
      terminateEditorProcess?.();
      return true;
    }
    showHistoryNotice(`已固化修改，并清空 ${result.clearedGroupCount ?? 0} 组撤销记录`, 'success');
    return true;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') requireHistoryRefresh(error.revision);
    else expectHistoryRevision(error.revision);
    await loadSession(error.revision).catch(() => {});
    const failureMessage = error.code === 'REVISION_CONFLICT'
      ? '修改历史已经变化，请重新确认固化'
      : error.code === 'PATCH_REPLAY_FAILED'
        ? '历史修改无法安全重放，已停止固化且原 Deck 未被改动'
        : error.code === 'NEW_OVERFLOW'
          ? '检测到新的页面溢出，已停止固化且原 Deck 未被改动'
          : error.code === 'DECK_CHANGED'
            ? '原 Deck 已被外部修改，为避免覆盖已停止固化'
            : error.message?.trim().startsWith('{')
              ? `固化验证失败（${error.code ?? 'UNKNOWN'}），原 Deck 未被改动`
              : `固化失败：${error.message}`;
    showHistoryNotice(failureMessage, 'error');
    setSolidifyProgress({
      state:'error',
      label:failureMessage,
      value:0,
    });
    return false;
  } finally {
    solidifyBusy = false;
    solidifyConfirm.disabled = false;
    solidifyCancel.disabled = false;
    solidifyExitWithout.disabled = false;
    setPillLabel(
      solidifyConfirm,
      solidifyDialogReason === 'exit' ? '固化并退出' : '永久固化',
    );
    renderHistory();
  }
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
  if (historyBusy) return false;
  if (!button.disabled && button.dataset.groupId) {
    void changeHistory(method, button);
    return true;
  }
  const refreshPending = Boolean(sessionRefreshPromise)
    || loadedSessionRevision < historyRefreshTargetRevision
    || historySnapshotFulfilled < historySnapshotRequirement;
  if (!refreshPending) return false;
  if (pendingHistoryShortcut) return true;
  pendingHistoryShortcut = method;
  const refresh = sessionRefreshPromise ?? loadSession(historyRefreshTargetRevision);
  void refresh.then(() => {
    if (tornDown) return;
    const queuedMethod = pendingHistoryShortcut;
    pendingHistoryShortcut = null;
    if (queuedMethod) triggerHistoryShortcut(queuedMethod);
  }).catch(error => {
    pendingHistoryShortcut = null;
    if (!tornDown) showHistoryNotice(`撤销历史加载失败：${error.message}`, 'error');
  });
  return true;
}

function onHistoryKeydown(event) {
  const method = historyMethodForShortcut(event);
  if (!method || acceptsNativeHistoryShortcut(event.target)) return;
  event.preventDefault();
  triggerHistoryShortcut(method);
}

function onSelectionDeleteKeydown(event) {
  if (editorMode !== 'edit' || inspectorSelection?.scope !== 'element'
    || !['Delete', 'Backspace'].includes(event.key)
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || acceptsNativeHistoryShortcut(event.target)) return;
  event.preventDefault();
  if (event.repeat) return;
  deckFrame.contentWindow?.postMessage({
    type:'delete-transform-selection',
    selectionId:inspectorSelection.selectionId,
  }, location.origin);
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
      const startupRecovery = session.startupRecovery;
      if (startupRecovery?.code === 'WORKING_DECK_RECOVERED'
        && startupRecovery.invalidFingerprint !== shownStartupRecovery) {
        shownStartupRecovery = startupRecovery.invalidFingerprint;
        showHistoryNotice('检测到上次工作副本写入未完成，已自动恢复最后一个有效版本。');
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

function samePageInventory(nextPages) {
  return pages.length === nextPages.length && pages.every((page, index) => {
    const next = nextPages[index];
    return page.pageKey === next?.pageKey
      && page.index === next.index
      && page.label === next.label;
  });
}

function renderPages(nextPages, preferredPageKey, preferredPageIndex) {
  pages = nextPages;
  const existing = [...pageList.querySelectorAll('[data-page-key]')];
  const unused = new Set(existing);
  const desired = pages.map(page => {
    let button = existing.find(candidate => (
      unused.has(candidate) && candidate.dataset.pageKey === page.pageKey
    ));
    button ??= existing.find(candidate => (
      unused.has(candidate) && candidate.dataset.pageIndex === String(page.index)
    ));
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'page-item';
      button.setAttribute('aria-current', 'false');
      const label = document.createElement('span');
      label.className = 'page-item-label';
      button.append(label);
      button.addEventListener('click', () => requestPage(button));
    }
    unused.delete(button);
    button.dataset.pageKey = page.pageKey;
    button.dataset.pageIndex = String(page.index);
    button.dataset.pageLabel = page.label;
    button.dataset.pageTitle = `${String(page.index).padStart(2, '0')} ${page.label}`;
    const label = button.querySelector('.page-item-label');
    let pageIndex = label.querySelector('.page-item-index');
    let pageName = label.querySelector('.page-item-name');
    if (!pageIndex || !pageName) {
      pageIndex = document.createElement('span');
      pageIndex.className = 'page-item-index';
      pageName = document.createElement('span');
      pageName.className = 'page-item-name';
      label.replaceChildren(pageIndex, document.createTextNode(' '), pageName);
    }
    pageIndex.textContent = String(page.index).padStart(2, '0');
    pageName.textContent = page.label;
    button.setAttribute('aria-label', button.dataset.pageTitle);
    return button;
  });
  for (const [index, button] of desired.entries()) {
    const current = pageList.children[index];
    if (current !== button) pageList.insertBefore(button, current ?? null);
  }
  const desiredSet = new Set(desired);
  for (const child of [...pageList.children]) {
    if (!desiredSet.has(child)) child.remove();
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
  if (requestedPage) {
    // Deck 重放时先保留（或按页序迁移）当前高亮，再异步向 iframe 确认。
    // 不再清空整列按钮，避免出现“无选中页”的一帧。
    confirmPage(requestedPage);
    requestPage(requestedPage);
  }
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
  const { requestId, actions, coalesceKey } = message;
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
          body: JSON.stringify({
            expectedRevision:revision, taskId:null, actions, commandId:requestId,
            ...(typeof coalesceKey === 'string' && coalesceKey ? { coalesceKey } : {}),
          }),
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
  const {
    requestId, payload, snapshot = null, attachments = [], processAfterCreate = false,
  } = message;
  if (typeof requestId !== 'string' || createRequests.has(requestId)) return;
  createRequests.add(requestId);
  try {
    if (typeof processAfterCreate !== 'boolean') throw new TypeError('任务提交方式无效');
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
    let processStarted = false;
    let processError = '';
    if (processAfterCreate) {
      const actionableTasks = tasks.filter(task => (
        task.targetMissing !== true && ['pending', 'failed'].includes(task.status)
      ));
      const actionableIds = actionableTasks.map(task => task.id);
      try {
        const processMessage = await processAllTasks(actionableTasks);
        processStarted = ['queued', 'running'].includes(agentRun.status)
          && actionableIds.every(id => agentRun.taskIds?.includes(id));
        if (!processStarted) processError = processMessage || '当前 Agent 未接收这批任务';
      } catch (error) {
        processError = error.message || 'Agent 启动失败';
      }
    }
    postRegionResult(requestId, {
      ok:true,
      taskId:result.task.id,
      snapshotDropped,
      processRequested:processAfterCreate,
      processStarted,
      ...(processError ? { processError } : {}),
    });
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
  if (event.data?.type === 'editor-surface-pointerdown') {
    setTaskDrawerOpen(taskDrawer, false);
    return;
  }
  if (event.data?.type === 'editor-surface-pointer-presence'
    && typeof event.data.active === 'boolean') {
    deckSurfacePointerActive = event.data.active;
    return;
  }
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
  if (event.data?.type === 'action-replay-failed'
    && typeof event.data.code === 'string') {
    showHistoryNotice(
      `历史重放冲突：${event.data.code}，请撤销冲突修改或等待页面重新同步`,
      'error',
    );
    return;
  }
  if (event.data?.type === 'temporary-region-shortcut'
    && typeof event.data.active === 'boolean') {
    setTemporaryRegionShortcut(event.data.active);
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
    const inventoryUnchanged = !completedReload
      && activeFrameInstanceId === event.data.frameInstanceId
      && samePageInventory(event.data.pages);
    activeFrameInstanceId = typeof event.data.frameInstanceId === 'string'
      ? event.data.frameInstanceId : undefined;
    deckReady = true;
    deckReadyPayload = {
      type:'deck-ready',
      pages:event.data.pages,
      diagnostics:Array.isArray(event.data.diagnostics) ? event.data.diagnostics : [],
    };
    announceDeckReady();
    if (inventoryUnchanged) {
      pages = event.data.pages;
      pageCount.textContent = `${pages.length} 页`;
      updatePageBadges();
    } else {
      renderPages(
        event.data.pages,
        completedReload?.pageKey ?? pagePreference.pageKey,
        completedReload?.pageIndex ?? pagePreference.pageIndex,
      );
    }
    deckFrame.contentWindow?.postMessage({
      type:'set-editor-mode', mode:activeEditorMode(),
    }, location.origin);
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
  if (event.data?.type === 'active-page-changed'
    && typeof event.data.pageKey === 'string') {
    const button = [...pageList.querySelectorAll('[data-page-key]')]
      .find(candidate => candidate.dataset.pageKey === event.data.pageKey);
    if (!button) return;
    pendingPageKey = undefined;
    confirmPage(button);
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
    'diagnostics-rejected', 'text-locations', 'text-locations-rejected']
    .includes(event.data?.type)
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

function activeEditorMode() {
  if (!temporaryRegionShortcut) return editorMode;
  if (editorMode === 'edit') return 'region';
  if (editorMode === 'region') return 'preview';
  return editorMode;
}

function renderEditorMode({ preserveRegionPopover=false } = {}) {
  const activeMode = activeEditorMode();
  modeTools.dataset.activeMode = activeMode;
  if (temporaryRegionShortcut) modeTools.dataset.temporaryMode = activeMode;
  else delete modeTools.dataset.temporaryMode;
  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === activeMode));
  }
  deckFrame.contentWindow?.postMessage({
    type:'set-editor-mode', mode:activeMode, preserveRegionPopover,
  }, location.origin);
}

function setEditorMode(mode) {
  temporaryRegionShortcut = false;
  const normalizedMode = ['text', 'move', 'resize'].includes(mode) ? 'edit' : mode;
  editorMode = normalizedMode;
  inspectorExpanded = normalizedMode === 'edit';
  renderInspectorLayout();
  renderEditorMode();
}

function setTemporaryRegionShortcut(active) {
  const next = active === true && ['edit', 'region'].includes(editorMode);
  if (temporaryRegionShortcut === next) return false;
  temporaryRegionShortcut = next;
  renderEditorMode({ preserveRegionPopover:!next || editorMode === 'region' });
  return true;
}

function isAgentTerminalInput(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  return Boolean(element?.closest('[data-agent-terminal-host]'));
}

function onTemporaryRegionKeydown(event) {
  const captureAgentInput = deckSurfacePointerActive && agentTerminalOpen
    && isAgentTerminalInput(event.target);
  if (!['edit', 'region'].includes(editorMode) || !isRegionShortcutKey(event)
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || (acceptsNativeHistoryShortcut(event.target) && !captureAgentInput)) return;
  event.preventDefault();
  if (captureAgentInput) event.stopImmediatePropagation();
  setTemporaryRegionShortcut(true);
}

function onTemporaryRegionKeyup(event) {
  if (!temporaryRegionShortcut || !isRegionShortcutKey(event)) return;
  event.preventDefault();
  if (deckSurfacePointerActive && agentTerminalOpen && isAgentTerminalInput(event.target)) {
    event.stopImmediatePropagation();
  }
  setTemporaryRegionShortcut(false);
}

const onModeClick = event => setEditorMode(event.currentTarget.dataset.mode);
for (const button of modeButtons) button.addEventListener('click', onModeClick);
exportPptxButton.addEventListener('click', onExportPptx);
const onInspectorCollapse = () => setInspectorExpanded(false);
const onInspectorReopen = () => setInspectorExpanded(true);
inspectorCollapseButton.addEventListener('click', onInspectorCollapse);
inspectorReopenButton.addEventListener('click', onInspectorReopen);
function setPagePanelCollapsed(collapsed) {
  editorShell.dataset.pagePanelCollapsed = String(collapsed === true);
  pagePanelToggle.setAttribute('aria-expanded', String(collapsed !== true));
  pagePanelToggle.setAttribute('aria-label', collapsed ? '展开页面列表' : '收起页面列表');
  pagePanelToggle.title = collapsed ? '展开页面列表' : '收起页面列表';
  pagePanelToggle.dataset.pillArrowDirection = collapsed ? 'right' : 'left';
}
const onPagePanelToggle = () => setPagePanelCollapsed(
  editorShell.dataset.pagePanelCollapsed !== 'true',
);
pagePanelToggle.addEventListener('click', onPagePanelToggle);
const onUndoClick = () => { void changeHistory('undo', undoButton); };
const onRedoClick = () => { void changeHistory('redo', redoButton); };
const onSolidifyClick = () => openSolidifyDialog('toolbar');
const onSolidifyConfirm = () => { void solidifyChanges(); };
undoButton.addEventListener('click', onUndoClick);
redoButton.addEventListener('click', onRedoClick);
solidifyButton.addEventListener('click', onSolidifyClick);
solidifyCancel.addEventListener('click', closeSolidifyDialog);
solidifyExitWithout.addEventListener('click', exitWorkspaceWithoutSolidifying);
solidifyConfirm.addEventListener('click', onSolidifyConfirm);

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
agentTerminal = new AgentTerminalPanel(agentTerminalRoot, {
  token,
  editorToken,
  onClose:() => {
    agentTerminalOpen = false;
    renderAgentTerminal();
    renderAgentStatus();
    agentStatus.focus();
  },
  onState:state => {
    adoptAgentTerminalState(state);
  },
});
renderTasks();
renderAgentTerminal();
renderInspector();
agentStatus.addEventListener('click', openAgentTerminal);

function onAgentTerminalKeydown(event) {
  if (event.key !== 'Escape' || !agentTerminalOpen) return;
  event.preventDefault();
  agentTerminalOpen = false;
  renderAgentTerminal();
  renderAgentStatus();
  agentStatus.focus();
}

function onTaskDrawerOutsidePointerDown(event) {
  if (taskDrawer.dataset.open !== 'true') return;
  if (event.composedPath().includes(taskDrawer)) return;
  setTaskDrawerOpen(taskDrawer, false);
}

function onEditorPointerMove() {
  // iframe 内的 pointermove 会由 frame bridge 明确上报；父页面能收到移动时，
  // 指针必然已经离开 Deck，及时恢复 Agent 终端的正常键盘输入。
  deckSurfacePointerActive = false;
}

document.addEventListener('pointerdown', onTaskDrawerOutsidePointerDown, true);
document.addEventListener('pointermove', onEditorPointerMove, true);
document.addEventListener('keydown', onAgentTerminalKeydown);
document.addEventListener('keydown', onHistoryKeydown);
document.addEventListener('keydown', onSelectionDeleteKeydown);
document.addEventListener('keydown', onTemporaryRegionKeydown, true);
document.addEventListener('keyup', onTemporaryRegionKeyup, true);

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
      'locate-text': 'text-locations',
    };
    if (replyTypes[event?.type] && typeof event.commandId === 'string') {
      const reply = commandReplies.get(`${replyTypes[event.type]}:${event.commandId}`);
      if (reply) eventsClient?.send(reply);
      else if (deckReady) deckFrame.contentWindow?.postMessage(event, location.origin);
      else pendingFrameCommands.set(event.commandId, event);
      return;
    }
    if (event?.type === 'deck-binding-changed') {
      renderDeckBinding(event.payload, { announce:true });
      return;
    }
    if (['actions-recorded','group-undone','group-redone',
      'source-mutation-recorded'].includes(event?.type)) {
      expectHistoryRevision(event.revision);
      updateRevision(event.revision);
      void ensureSessionRevision(event.revision).catch(() => {});
    } else if (event?.type === 'deck-solidified') {
      updateRevision(event.revision);
      requireHistoryRefresh(event.revision);
      reloadSolidifiedDeck(event.revision);
      void ensureSessionRevision(event.revision).catch(() => {});
    } else {
      updateRevision(event?.revision);
    }
    if (event?.type === 'working-deck-changed') {
      reloadWorkingDeck(event.revision, event.payload?.reason ?? 'source');
    } else if (event?.type === 'source-mutation-failed') {
      showHistoryNotice(`工作副本修改未进入历史：${event.payload?.message ?? '未知错误'}`, 'error');
    }
    if (['task-created','task-updated'].includes(event?.type) && event.payload?.id) {
      upsertTask(event.payload);
    } else if (event?.type === 'task-deleted' && event.payload?.id) {
      tasks = tasks.filter(task => task.id !== event.payload.id);
      renderTasks();
    } else if (event?.type === 'agent-run-updated' && event.payload?.status) {
      if (adoptAgentRun(event.payload)) renderTasks();
    } else if (event?.type === 'agent-terminal-updated' && event.payload?.state) {
      adoptAgentTerminalState(event.payload);
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
  requestJson('/api/deck-binding').then(binding => renderDeckBinding(binding)),
  requestJson('/api/agent-runs/current').then(run => {
    if (adoptAgentRun(run)) renderTasks();
  }),
  requestJson('/api/agent-terminal').then(state => {
    adoptAgentTerminalState(state);
  }),
]).then(() => {
  renderAgentStatus();
}).catch(error => {
  showHistoryNotice(`编辑状态恢复失败：${error.message}`, 'error');
});

function teardown() {
  if (tornDown) return;
  tornDown = true;
  pendingHistoryShortcut = null;
  clearTimeout(historyNoticeTimer);
  deckFrame.contentWindow?.postMessage({ type: 'editor-teardown' }, location.origin);
  eventsClient?.close();
  agentTerminal?.dispose();
  resizeObserver.disconnect();
  cancelAnimationFrame(fitFrameRequest);
  pendingFrameCommands.clear();
  deckFrame.removeEventListener('load', onDeckFrameLoad);
  for (const button of modeButtons) button.removeEventListener('click', onModeClick);
  exportPptxButton.removeEventListener('click', onExportPptx);
  inspectorCollapseButton.removeEventListener('click', onInspectorCollapse);
  inspectorReopenButton.removeEventListener('click', onInspectorReopen);
  pagePanelToggle.removeEventListener('click', onPagePanelToggle);
  undoButton.removeEventListener('click', onUndoClick);
  redoButton.removeEventListener('click', onRedoClick);
  solidifyButton.removeEventListener('click', onSolidifyClick);
  solidifyCancel.removeEventListener('click', closeSolidifyDialog);
  solidifyExitWithout.removeEventListener('click', exitWorkspaceWithoutSolidifying);
  solidifyConfirm.removeEventListener('click', onSolidifyConfirm);
  if (navigateToWorkspaceHome) {
    workspaceHomeButton.removeEventListener('click', navigateToWorkspaceHome);
    exitEditorButton.removeEventListener('click', requestWorkspaceExit);
  }
  deckBindingRecheck.removeEventListener('click', reconcileDeckBinding);
  deckBindingChoose.removeEventListener('click', chooseDeckBinding);
  solidifyModal.destroy();
  agentStatus.removeEventListener('click', openAgentTerminal);
  document.removeEventListener('pointerdown', onTaskDrawerOutsidePointerDown, true);
  document.removeEventListener('pointermove', onEditorPointerMove, true);
  document.removeEventListener('keydown', onAgentTerminalKeydown);
  document.removeEventListener('keydown', onHistoryKeydown);
  document.removeEventListener('keydown', onSelectionDeleteKeydown);
  document.removeEventListener('keydown', onTemporaryRegionKeydown, true);
  document.removeEventListener('keyup', onTemporaryRegionKeyup, true);
  window.removeEventListener('message', onFrameMessage);
  window.removeEventListener('pagehide', teardown);
  window.removeEventListener('unload', teardown);
}

window.addEventListener('pagehide', teardown);
window.addEventListener('unload', teardown);
