const landing = document.querySelector('[data-landing]');
const supportNavigation = document.querySelector('[data-support-navigation]');
const existingFlow = document.querySelector('[data-existing-flow]');
const existingDeckButton = document.querySelector('[data-existing-deck]');
const backHomeButton = document.querySelector('[data-back-home]');
const addButton = document.querySelector('[data-add-deck]');
const buttonLabels = document.querySelectorAll('[data-button-label]');
const status = document.querySelector('[data-existing-status]');
const confirmation = document.querySelector('[data-confirmation]');
const deckName = document.querySelector('[data-deck-name]');
const projectRoot = document.querySelector('[data-project-root]');
const projectSource = document.querySelector('[data-project-source]');
const projectWarning = document.querySelector('[data-project-warning]');
const confirmationRow = document.querySelector('[data-project-confirmation]');
const confirmationInput = document.querySelector('[data-confirm-project]');
const provider = document.querySelector('[data-provider]');
const changeDeckButton = document.querySelector('[data-change-deck]');
const changeProjectButton = document.querySelector('[data-change-project]');
const openButton = document.querySelector('[data-open-deck]');
const exitEditorButton = document.querySelector('[data-exit-editor]');
const historyUi = {
  creationList:document.querySelector('[data-creation-work-list]'),
  editingList:document.querySelector('[data-editing-work-list]'),
  creationCount:document.querySelector('[data-creation-work-count]'),
  editingCount:document.querySelector('[data-editing-work-count]'),
  creationStatus:document.querySelector('[data-creation-history-status]'),
  editingStatus:document.querySelector('[data-editing-history-status]'),
};
const launchParams = new URLSearchParams(window.location.search);
const token = launchParams.get('token');
let pageIsClosing = false;
let launcherLeaseHandedOff = false;
let startupVisualsReleased = false;
let liquidEtherBackground = { destroy() {} };
function startStartupVisuals() {
  if (pageIsClosing || startupVisualsReleased) return;
  const startShell = document.querySelector('[data-start-shell]');
  if (startShell?.hidden) {
    document.querySelector('[data-liquid-ether-background]')?.setAttribute('data-state', 'paused');
    startupVisualsReleased = true;
    return;
  }
  void import(`/app/liquid-ether-background.mjs?token=${encodeURIComponent(token)}`)
    .then(({ createLiquidEtherBackground }) => {
      if (pageIsClosing || startupVisualsReleased) return;
      liquidEtherBackground = createLiquidEtherBackground(
        document.querySelector('[data-liquid-ether-background]'),
      );
    })
    .catch(error => {
      const background = document.querySelector('[data-liquid-ether-background]');
      if (background) background.dataset.state = 'fallback';
      console.warn('启动页动态背景载入失败，已使用静态柔光。', error);
    });
}
function releaseStartupVisuals() {
  startupVisualsReleased = true;
  liquidEtherBackground.destroy();
  liquidEtherBackground = { destroy() {} };
}
const isLeavingWorkspace = launchParams.get('leaveWorkspace') === '1';
if (isLeavingWorkspace) {
  document.documentElement.dataset.workspaceNavigationState = 'pending';
}
const requestedWorkspaceView = ['home', 'creation', 'editing'].includes(launchParams.get('view'))
  ? launchParams.get('view') : null;
const launcherClientId = sessionStorage.getItem('huawei-deck-launcher-client-id')
  ?? globalThis.crypto?.randomUUID?.()
  ?? `${Date.now()}-${Math.random()}`;
sessionStorage.setItem('huawei-deck-launcher-client-id', launcherClientId);
const launcherClientSequence = Number(
  sessionStorage.getItem('huawei-deck-launcher-client-sequence') ?? 0,
) + 1;
sessionStorage.setItem('huawei-deck-launcher-client-sequence', String(launcherClientSequence));
const launcherLeasePromise = fetch(
  `/api/client-connected?token=${encodeURIComponent(token)}`,
  {
    method:'POST',
    headers:{ accept:'application/json', 'content-type':'application/json' },
    body:JSON.stringify({ clientId:launcherClientId, sequence:launcherClientSequence }),
  },
).then(async response => {
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '页面连接失败');
  return result;
}).catch(() => null);
let launcherLeaseClient = null;
void launcherLeasePromise.then(async connected => {
  if (!connected || pageIsClosing) return;
  const { createLauncherLeaseClient } = await import(
    `/app/launcher-lease-client.mjs?token=${encodeURIComponent(token)}`
  );
  if (pageIsClosing) return;
  launcherLeaseClient = createLauncherLeaseClient({
    workspaceUrl:new URL(location.href),
    clientId:launcherClientId,
    sequence:launcherClientSequence,
  });
  launcherLeaseClient.start();
}).catch(() => {});
const { AgentTerminalPanel } = await import(
  `/app/agent-terminal-panel.mjs?token=${encodeURIComponent(token)}`
);
const { WorkspaceSwitcher } = await import(
  `/app/workspace-switcher.mjs?token=${encodeURIComponent(token)}`
);
const { enhanceSelect } = await import(
  `/app/native-controls.mjs?token=${encodeURIComponent(token)}`
);
const { applyPill, installPillNav, setPillLabel } = await import(
  `/app/pill-nav.mjs?token=${encodeURIComponent(token)}`
);
const {
  agentProviderDefinition,
  isAgentProviderId,
  publicAgentProviders,
} = await import(`/app/agent-provider-registry.mjs?token=${encodeURIComponent(token)}`);
enhanceSelect(provider, { minimumMenuWidth:190 });
enhanceSelect(document.querySelector('[data-creation-provider]'), { minimumMenuWidth:190 });
installPillNav(document);
let state = 'idle';
let candidate = null;
let creationCandidate = null;
let creationDraft = null;
let activeCreationWorkItem = null;
let creationTerminalPanel = null;
let creationEvents = null;
let creationRefreshTimer = null;
let creationPreviewKey = null;
let creationHasDeck = false;

const creationUi = {
  startShell:document.querySelector('[data-start-shell]'),
  creationFlow:document.querySelector('[data-creation-flow]'),
  builder:document.querySelector('[data-builder]'),
  newDeck:document.querySelector('[data-new-deck]'),
  creationBack:document.querySelector('[data-creation-back]'),
  chooseProject:document.querySelector('[data-choose-creation-project]'),
  changeProject:document.querySelector('[data-change-creation-project]'),
  createDraft:document.querySelector('[data-create-draft]'),
  confirmation:document.querySelector('[data-creation-confirmation]'),
  projectRoot:document.querySelector('[data-creation-project-root]'),
  projectSource:document.querySelector('[data-creation-project-source]'),
  projectWarning:document.querySelector('[data-creation-project-warning]'),
  projectConfirmation:document.querySelector('[data-creation-project-confirmation]'),
  confirmProject:document.querySelector('[data-confirm-creation-project]'),
  provider:document.querySelector('[data-creation-provider]'),
  status:document.querySelector('[data-creation-status]'),
  terminalRoot:document.querySelector('[data-agent-terminal]'),
  terminalReopen:document.querySelector('[data-terminal-reopen]'),
  workspaceNavigation:document.querySelector('[data-workspace-navigation]'),
  switchWorkspace:document.querySelector('[data-workspace-switch]'),
  home:document.querySelector('[data-workspace-home]'),
  draftTitle:document.querySelector('[data-draft-title]'),
  draftTitleButton:document.querySelector('[data-draft-title-button]'),
  draftTitleForm:document.querySelector('[data-draft-title-form]'),
  draftTitleInput:document.querySelector('[data-draft-title-input]'),
  draftTitleSave:document.querySelector('[data-draft-title-save]'),
  draftTitleCancel:document.querySelector('[data-draft-title-cancel]'),
  draftRevision:document.querySelector('[data-draft-revision]'),
  deckStage:document.querySelector('[data-deck-stage]'),
  deckStageTitle:document.querySelector('[data-deck-stage-title]'),
  deckStageStatus:document.querySelector('[data-deck-stage-status]'),
  deckPreview:document.querySelector('[data-deck-preview]'),
  openGenerated:document.querySelector('[data-open-generated]'),
  workspaceStatus:document.querySelector('[data-workspace-status]'),
};
applyPill(creationUi.draftTitleSave, { variant:'primary', size:'sm', kind:'action' });
applyPill(creationUi.draftTitleCancel, { variant:'secondary', size:'sm', kind:'action' });

for (const select of [provider, creationUi.provider]) {
  select.replaceChildren(...publicAgentProviders().map(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    return option;
  }));
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setState(nextState, message, kind = '') {
  state = nextState;
  addButton.disabled = nextState !== 'idle';
  for (const label of buttonLabels) {
    label.textContent = nextState === 'choosing-deck'
      ? '请选择 HTML…'
      : '添加 Deck HTML';
  }
  changeProjectButton.disabled = nextState !== 'deck-selected';
  changeDeckButton.disabled = nextState !== 'deck-selected';
  openButton.disabled = nextState !== 'deck-selected';
  provider.disabled = nextState !== 'deck-selected';
  for (const button of landing.querySelectorAll(
    '[data-work-task], [data-dismiss-work], [data-rename-work], [data-new-deck], [data-existing-deck]',
  )) {
    button.disabled = nextState !== 'idle';
  }
  setStatus(message, kind);
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const url = new URL(path, location.origin);
  url.searchParams.set('token', token);
  const response = await fetch(url, {
    method,
    headers:{ accept:'application/json', ...(body === undefined ? {} : { 'content-type':'application/json' }) },
    ...(body === undefined ? {} : { body:JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message || '操作失败');
    error.code = result.code;
    throw error;
  }
  return result;
}

function post(path, body) {
  return requestJson(path, { method:'POST', body:body ?? {} });
}

function workspaceNavigationUrl(destination) {
  const url = new URL('/app/', location.origin);
  url.searchParams.set('token', token);
  url.searchParams.set('view', destination);
  url.searchParams.set('leaveWorkspace', '1');
  return url.href;
}

function workspaceTaskNavigationUrl(kind, entry) {
  const url = new URL(workspaceNavigationUrl(kind));
  url.searchParams.set('switchKind', kind);
  if (kind === 'creation') {
    url.searchParams.set('projectRoot', entry.projectRoot);
    url.searchParams.set('draftId', entry.draftId);
  } else {
    url.searchParams.set('deckPath', entry.deckPath);
    if (typeof entry.workId === 'string') url.searchParams.set('workId', entry.workId);
  }
  return url.href;
}

function navigateFromCreation(destination) {
  creationUi.switchWorkspace.disabled = true;
  creationUi.home.disabled = true;
  exitEditorButton.disabled = true;
  location.replace(workspaceNavigationUrl(destination));
}

function terminateEditorProcess() {
  document.documentElement.dataset.processExiting = 'true';
  creationUi.switchWorkspace.disabled = true;
  creationUi.home.disabled = true;
  exitEditorButton.disabled = true;
  setPillLabel(exitEditorButton, '正在退出…');
  const shutdownUrl = `/api/shutdown?token=${encodeURIComponent(token)}`;
  let beaconSent = false;
  try { beaconSent = navigator.sendBeacon(shutdownUrl); }
  catch { beaconSent = false; }
  if (!beaconSent) {
    void fetch(shutdownUrl, { method:'POST', keepalive:true }).catch(() => {});
  }
  setTimeout(() => window.close(), 80);
}

function showLanding() {
  landing.hidden = false;
  existingFlow.hidden = true;
  creationUi.creationFlow.hidden = true;
  supportNavigation.hidden = false;
  exitEditorButton.hidden = false;
}

function showExistingFlow() {
  landing.hidden = true;
  existingFlow.hidden = false;
  creationUi.creationFlow.hidden = true;
  supportNavigation.hidden = true;
  exitEditorButton.hidden = false;
}

function showCreationFlow() {
  landing.hidden = true;
  existingFlow.hidden = true;
  creationUi.creationFlow.hidden = false;
  supportNavigation.hidden = true;
  exitEditorButton.hidden = false;
}

function resetEntryChoices() {
  candidate = null;
  confirmation.hidden = true;
  confirmationInput.checked = false;
  addButton.hidden = false;
  deckName.textContent = '';
  projectRoot.textContent = '';
  projectSource.textContent = '';
  projectWarning.textContent = '';
  projectWarning.hidden = true;
  confirmationRow.hidden = true;

  creationCandidate = null;
  creationUi.confirmation.hidden = true;
  creationUi.confirmProject.checked = false;
  creationUi.chooseProject.hidden = false;
  creationUi.projectRoot.textContent = '';
  creationUi.projectSource.textContent = '';
  creationUi.projectWarning.textContent = '';
  creationUi.projectWarning.hidden = true;
  creationUi.projectConfirmation.hidden = true;

  setCreationChoiceState('idle', '尚未选择目录');
  setState('idle', '尚未添加文件');
}

async function returnToLanding(flow) {
  const selectedState = flow === 'existing' ? 'deck-selected' : 'creation-project-selected';
  if (!['idle', selectedState].includes(state)) return;
  const previousState = state;
  if (previousState !== 'idle') {
    state = 'resetting-selection';
    if (flow === 'existing') setStatus('正在返回首页…', 'working');
    else creationStatus('正在返回首页…', 'working');
    try {
      const result = await post('/api/reset-selection');
      if (result.status !== 'idle') throw new Error('服务未完成选择复位');
    } catch (error) {
      if (flow === 'existing') {
        setState(previousState, error.message || '暂时无法返回首页', 'error');
      } else {
        setCreationChoiceState(previousState, error.message || '暂时无法返回首页', 'error');
      }
      return;
    }
  }
  resetEntryChoices();
  showLanding();
  void loadWorkHistory();
}

function formatModifiedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '修改时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false,
  }).format(date);
}

function historyStatus(kind, message = '', stateKind = '') {
  const node = kind === 'creation' ? historyUi.creationStatus : historyUi.editingStatus;
  node.textContent = message;
  node.dataset.kind = stateKind;
}

function createTrashIcon(className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('work-item-delete-icon', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = [
    ['path', { d:'M4 7h16' }],
    ['path', { d:'M9 7V4.75h6V7' }],
    ['path', { d:'M7 7l.75 12h8.5L17 7' }],
    ['path', { d:'M10 10.5v5' }],
    ['path', { d:'M14 10.5v5' }],
  ];
  for (const [tag, attributes] of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value);
    svg.append(path);
  }
  return svg;
}

function createPencilIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('work-item-edit-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M4.5 19.5l4.1-.8 10-10a2.1 2.1 0 0 0-3-3l-10 10-.8 4.1z');
  const seam = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  seam.setAttribute('d', 'M14.2 7.1l2.7 2.7');
  svg.append(body, seam);
  return svg;
}

function workItemName(kind, entry) {
  return entry.displayName || (kind === 'creation' ? entry.title : entry.deckName);
}

function beginWorkItemRename(kind, entry, row) {
  if (state !== 'idle' || row.dataset.renaming === 'true') return;
  row.dataset.renaming = 'true';
  const content = row.querySelector('.work-item');
  const actions = row.querySelector('.work-item-actions');
  content.hidden = true;
  actions.hidden = true;
  const form = document.createElement('form');
  form.className = 'work-item-rename-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  input.value = workItemName(kind, entry);
  input.setAttribute('aria-label', '工作项名称');
  input.autocomplete = 'off';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = '保存';
  save.setAttribute('aria-label', '保存名称');
  applyPill(save, { variant:'primary', size:'sm', kind:'action' });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.setAttribute('aria-label', '取消改名');
  applyPill(cancel, { variant:'secondary', size:'sm', kind:'action' });
  const restore = () => {
    form.remove();
    row.dataset.renaming = 'false';
    content.hidden = false;
    actions.hidden = false;
  };
  cancel.addEventListener('click', restore);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') restore();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    input.disabled = true;
    save.disabled = true;
    cancel.disabled = true;
    historyStatus(kind, '正在保存工作项名称…', 'working');
    try {
      await post('/api/work-items/rename', {
        workId:entry.workId,
        displayName:input.value,
        expectedRevision:entry.revision,
      });
      await loadWorkHistory();
      historyStatus(kind, '工作项名称已更新');
    } catch (error) {
      input.disabled = false;
      save.disabled = false;
      cancel.disabled = false;
      historyStatus(kind, error.message || '工作项改名失败', 'error');
      input.focus();
      input.select();
    }
  });
  form.append(input, save, cancel);
  row.append(form);
  input.focus();
  input.select();
}

function renderWorkList(kind, entries) {
  const creation = kind === 'creation';
  const list = creation ? historyUi.creationList : historyUi.editingList;
  const count = creation ? historyUi.creationCount : historyUi.editingCount;
  list.replaceChildren();
  count.textContent = entries.length ? `${entries.length} 个` : '';
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'work-empty';
    empty.textContent = creation
      ? '还没有进行中的 Draft。\n从右下角开始第一个新建任务。'
      : '还没有可继续的 Deck。\n从右下角添加一份 HTML。';
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'work-item-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'work-item';
    button.dataset.workTask = creation ? entry.draftId : entry.deckPath;
    if (!creation) button.dataset.recentDeck = entry.deckPath;
    button.dataset.locked = String(Boolean(entry.locked));
    button.title = creation
      ? `继续 ${entry.title} · ${entry.projectRoot}`
      : `继续 ${entry.deckPath}`;
    const copy = document.createElement('span');
    copy.className = 'work-item-copy';
    const name = document.createElement('strong');
    const displayName = workItemName(kind, entry);
    name.textContent = displayName;
    const detail = document.createElement('small');
    const needsRebind = Boolean(!creation && entry.binding && entry.binding.state !== 'bound');
    detail.textContent = creation
      ? `${entry.runtimeState === 'background' ? 'Agent 后台运行 · ' : ''}`
        + `${entry.locked ? '其他窗口正在使用 · ' : ''}${entry.progress} · ${entry.projectName}`
      : `${needsRebind ? '需要重新绑定 · 工作副本已保存 · ' : ''}`
        + `${entry.runtimeState === 'background' ? 'Agent 后台运行 · ' : ''}`
        + `${entry.progress || '继续编辑'} · ${entry.directory}`;
    copy.append(name, detail);
    const time = document.createElement('time');
    time.dateTime = creation ? entry.updatedAt : entry.modifiedAt;
    time.textContent = formatModifiedAt(time.dateTime);
    button.append(copy, time);
    button.addEventListener('click', () => void (creation
      ? resumeCreationTask(entry)
      : resumeDeckTask(entry)));
    const actions = document.createElement('span');
    actions.className = 'work-item-actions';
    if (needsRebind) {
      const rebind = document.createElement('button');
      rebind.type = 'button';
      rebind.className = 'work-item-rebind';
      rebind.textContent = '重新绑定';
      rebind.setAttribute('aria-label', `重新绑定 ${displayName} 的源文件`);
      rebind.title = '选择改名后的同一份 HTML 文件';
      applyPill(rebind, { variant:'primary', size:'sm', kind:'action' });
      rebind.addEventListener('click', () => void rebindWorkTask(entry, rebind));
      actions.append(rebind);
    }
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'work-item-edit';
    rename.dataset.renameWork = entry.workId;
    rename.setAttribute('aria-label', `重命名 ${displayName}`);
    rename.title = '只修改 Editor 中显示的工作项名称';
    rename.append(createPencilIcon());
    applyPill(rename, { variant:'secondary', size:'md', kind:'icon' });
    rename.addEventListener('click', () => beginWorkItemRename(kind, entry, row));
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'work-item-delete';
    dismiss.dataset.dismissWork = creation ? 'creation' : 'editing';
    dismiss.setAttribute('aria-label', `删除 ${displayName} 的任务记录`);
    dismiss.title = '只删除首页记录，不删除 Deck 或 Draft 文件';
    dismiss.append(createTrashIcon('work-item-delete-icon-default'));
    applyPill(dismiss, { variant:'danger', size:'md', kind:'icon' });
    dismiss.addEventListener('click', () => void dismissWorkTask(kind, entry, dismiss));
    actions.append(rename, dismiss);
    row.append(button, actions);
    list.append(row);
  }
}

async function rebindWorkTask(entry, button) {
  if (state !== 'idle') return;
  button.disabled = true;
  setState('choosing-rebind', '请选择改名后的同一份 Deck HTML…', 'working');
  historyStatus('editing', '工作副本安全保留；正在等待选择源文件…', 'working');
  try {
    const result = await post('/api/work-items/choose-rebind-file', {
      workId:entry.workId,
    });
    if (result.status === 'cancelled') {
      await loadWorkHistory();
      setState('idle', '已取消重新绑定；工作副本仍安全保留');
      historyStatus('editing', '仍需重新绑定后才能固化', 'error');
      return;
    }
    if (result.status !== 'rebound' || !result.workItem) {
      throw new Error('重新绑定没有返回有效工作项');
    }
    await loadWorkHistory();
    setState('idle', '源文件已重新绑定，正在恢复原编辑会话…', 'working');
    await resumeDeckTask(result.workItem);
  } catch (error) {
    await loadWorkHistory();
    const message = error.message || '重新绑定失败，请确认选择的是原来的物理文件';
    setState('idle', message, 'error');
    historyStatus('editing', message, 'error');
  }
}

async function dismissWorkTask(kind, entry, button) {
  if (state !== 'idle') return;
  button.disabled = true;
  historyStatus(kind, '正在删除任务记录…', 'working');
  try {
    await post('/api/work-history/dismiss', kind === 'creation'
      ? {
          kind, workId:entry.workId, expectedRevision:entry.revision,
          projectRoot:entry.projectRoot, draftId:entry.draftId,
        }
      : {
          kind, workId:entry.workId, expectedRevision:entry.revision,
          deckPath:entry.deckPath,
        });
    await loadWorkHistory();
    historyStatus(kind, '任务记录已删除；内容文件仍保留');
  } catch (error) {
    button.disabled = false;
    historyStatus(kind, error.message || '任务记录删除失败', 'error');
  }
}

async function loadWorkHistory() {
  try {
    const result = await requestJson('/api/work-history');
    renderWorkList('creation', Array.isArray(result.creation) ? result.creation : []);
    renderWorkList('editing', Array.isArray(result.editing) ? result.editing : []);
    historyStatus('creation');
    historyStatus('editing');
  } catch (error) {
    historyUi.creationList.replaceChildren();
    historyUi.editingList.replaceChildren();
    for (const list of [historyUi.creationList, historyUi.editingList]) {
      const message = document.createElement('p');
      message.className = 'work-empty';
      message.textContent = '任务历史读取失败，可继续使用右下角的新任务入口。';
      list.append(message);
    }
    historyStatus('creation', error.message || '任务历史读取失败', 'error');
    historyStatus('editing', error.message || '任务历史读取失败', 'error');
  }
}

function renderCandidate(value) {
  candidate = value;
  deckName.textContent = value.deckName;
  projectRoot.textContent = value.projectRoot.path;
  projectSource.textContent = ({
    persisted:'已保存目录',
    explicit:'用户选择',
    'launch-cwd':'启动目录',
    'git-root':'Git 根目录',
    'workspace-marker':'工作区标记',
    'deck-directory':'Deck 所在目录',
  })[value.projectRoot.source] ?? value.projectRoot.source;
  projectWarning.textContent = value.projectRoot.warning ?? '';
  projectWarning.hidden = !value.projectRoot.warning;
  confirmationRow.hidden = !value.projectRoot.needsConfirmation;
  confirmationInput.checked = false;
  if (isAgentProviderId(value.provider)) {
    provider.value = value.provider;
  }
  confirmation.hidden = false;
  addButton.hidden = true;
  showExistingFlow();
  setState('deck-selected', '确认项目目录后打开编辑器');
}

async function resumeDeckTask(entry) {
  if (state !== 'idle') return;
  setState('resuming-deck', '正在恢复 Deck 工作区…', 'working');
  historyStatus('editing', '正在恢复工作副本与 Agent 上下文…', 'working');
  try {
    const result = await post('/api/resume-deck', {
      workId:entry.workId,
      deckPath:entry.deckPath,
    });
    if (result.status === 'deck-selected') {
      renderCandidate(result);
      setStatus('需要确认项目目录后继续原任务');
      return;
    }
    if (result.status !== 'selected' || !result.editorUrl) throw new Error('编辑器没有返回有效地址');
    state = 'selected';
    historyStatus('editing', `正在打开 ${result.deckName}…`, 'working');
    releaseStartupVisuals();
    launcherLeaseHandedOff = true;
    window.location.replace(result.editorUrl);
  } catch (error) {
    candidate = null;
    confirmation.hidden = true;
    addButton.hidden = false;
    const message = error.code === 'SESSION_LOCKED'
      ? '这项任务已在另一个编辑器窗口打开，请切换到那个窗口；关闭它后可在这里重试。'
      : error.message || 'Deck 任务恢复失败';
    // 先刷新列表、再写错误。loadWorkHistory 会清空状态栏，顺序反过来会让
    // “另一窗口占用”只闪一下，用户既看不清原因也不知道如何恢复。
    await loadWorkHistory();
    setState('idle', message, 'error');
    historyStatus('editing', message, 'error');
  }
}

async function resumeCreationTask(entry) {
  if (state !== 'idle') return;
  setState('resuming-draft', '正在恢复 Creation Draft…', 'working');
  historyStatus('creation', '正在恢复 Draft、里程碑与 Agent 对话…', 'working');
  try {
    const result = await post('/api/resume-creation-draft', {
      projectRoot:entry.projectRoot,
      draftId:entry.draftId,
    });
    if (result.status !== 'building' || !result.draft) throw new Error('Draft 没有返回有效状态');
    creationDraft = result.draft;
    activeCreationWorkItem = result.workItem ?? entry;
    state = 'building';
    enterCreationBuilder(result.terminal?.provider ?? creationDraft.provider);
  } catch (error) {
    setState('idle', error.message || 'Creation Draft 恢复失败', 'error');
    historyStatus('creation', error.message || 'Creation Draft 恢复失败', 'error');
    void loadWorkHistory();
  }
}

existingDeckButton.addEventListener('click', () => {
  if (state !== 'idle') return;
  showExistingFlow();
});

backHomeButton.addEventListener('click', () => void returnToLanding('existing'));

creationUi.newDeck.addEventListener('click', () => {
  if (state !== 'idle') return;
  showCreationFlow();
});

creationUi.creationBack.addEventListener('click', () => void returnToLanding('creation'));

async function chooseExistingDeck() {
  if (!['idle', 'deck-selected'].includes(state)) return;
  const previousCandidate = candidate;
  setState('choosing-deck', '系统文件选择器已打开', 'working');
  try {
    const result = await post('/api/choose-deck', {});
    if (result.status === 'cancelled') {
      if (previousCandidate) setState('deck-selected', '已取消，仍使用当前 Deck');
      else setState('idle', '已取消，可以重新添加');
      return;
    }
    if (result.status !== 'deck-selected') throw new Error('没有返回有效的 Deck 候选');
    renderCandidate(result);
  } catch (error) {
    if (previousCandidate) {
      setState('deck-selected', error.message || '重新选择失败，请重试', 'error');
    } else {
      setState('idle', error.message || '添加失败，请重试', 'error');
    }
  }
}

addButton.addEventListener('click', chooseExistingDeck);
changeDeckButton.addEventListener('click', chooseExistingDeck);

changeProjectButton.addEventListener('click', async () => {
  if (state !== 'deck-selected' || !candidate) return;
  setState('choosing-project', '系统目录选择器已打开', 'working');
  try {
    const result = await post('/api/choose-agent-project', {
      candidateNonce:candidate.candidateNonce,
      selectionRevision:candidate.selectionRevision,
    });
    if (result.status === 'cancelled') {
      setState('deck-selected', '已取消更改，仍使用当前项目目录');
      return;
    }
    renderCandidate(result);
    setStatus('项目目录已更新');
  } catch (error) {
    setState('deck-selected', error.message || '无法更改项目目录', 'error');
  }
});

openButton.addEventListener('click', async () => {
  if (state !== 'deck-selected' || !candidate) return;
  if (candidate.projectRoot.needsConfirmation && !confirmationInput.checked) {
    setStatus('请先确认这个项目目录范围', 'error');
    confirmationInput.focus();
    return;
  }
  setState('starting-editor', '正在启动编辑器', 'working');
  try {
    const result = await post('/api/open-deck', {
      candidateNonce:candidate.candidateNonce,
      selectionRevision:candidate.selectionRevision,
      provider:provider.value,
      confirmProjectRoot:confirmationInput.checked,
    });
    if (result.status !== 'selected' || !result.editorUrl) {
      throw new Error('编辑器没有返回有效地址');
    }
    state = 'selected';
    setStatus(`已锁定 ${result.deckName}，正在打开编辑器`, 'working');
    releaseStartupVisuals();
    launcherLeaseHandedOff = true;
    window.location.replace(result.editorUrl);
  } catch (error) {
    setState('deck-selected', error.message || '编辑器启动失败，请重试', 'error');
  }
});

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function creationStatus(message, kind = '') {
  creationUi.status.textContent = message;
  creationUi.status.dataset.kind = kind;
}

function workspaceStatus(message, kind = '') {
  creationUi.workspaceStatus.textContent = message;
  creationUi.workspaceStatus.dataset.kind = kind;
}

function setCreationChoiceState(nextState, message, kind = '') {
  state = nextState;
  creationUi.chooseProject.disabled = !['idle', 'creation-project-selected'].includes(nextState);
  creationUi.changeProject.disabled = nextState !== 'creation-project-selected';
  creationUi.createDraft.disabled = nextState !== 'creation-project-selected';
  creationUi.provider.disabled = nextState !== 'creation-project-selected';
  creationStatus(message, kind);
}

function renderCreationCandidate(value) {
  creationCandidate = value;
  creationUi.projectRoot.textContent = value.projectRoot.path;
  creationUi.projectSource.textContent = ({
    explicit:'用户选择', persisted:'已保存目录', 'git-root':'Git 根目录',
    'workspace-marker':'工作区标记', 'deck-directory':'Deck 所在目录',
  })[value.projectRoot.source] ?? value.projectRoot.source;
  creationUi.projectWarning.textContent = value.projectRoot.warning ?? '';
  creationUi.projectWarning.hidden = !value.projectRoot.warning;
  creationUi.projectConfirmation.hidden = !value.projectRoot.needsConfirmation;
  creationUi.confirmProject.checked = false;
  creationUi.confirmation.hidden = false;
  creationUi.chooseProject.hidden = true;
  setCreationChoiceState('creation-project-selected', '确认目录后创建 Draft');
}

async function chooseCreationProject() {
  if (!['idle', 'creation-project-selected'].includes(state)) return;
  const previousState = state;
  setCreationChoiceState('choosing-creation-project', '系统目录选择器已打开', 'working');
  try {
    const result = await post('/api/choose-creation-project', {});
    if (result.status === 'cancelled') {
      if (previousState === 'creation-project-selected' && creationCandidate) {
        setCreationChoiceState(previousState, '已取消更改，仍使用当前目录');
      } else {
        setCreationChoiceState('idle', '已取消，可以重新选择');
      }
      return;
    }
    renderCreationCandidate(result);
  } catch (error) {
    setCreationChoiceState(previousState, error.message || '无法选择项目目录', 'error');
  }
}

creationUi.chooseProject.addEventListener('click', chooseCreationProject);
creationUi.changeProject.addEventListener('click', chooseCreationProject);

creationUi.createDraft.addEventListener('click', async () => {
  if (state !== 'creation-project-selected' || !creationCandidate) return;
  if (creationCandidate.projectRoot.needsConfirmation && !creationUi.confirmProject.checked) {
    creationStatus('请先确认这个项目目录范围', 'error');
    creationUi.confirmProject.focus();
    return;
  }
  setCreationChoiceState('creating-draft', '正在创建 Draft 并启动 Agent…', 'working');
  try {
    const result = await post('/api/creation-drafts', {
      candidateNonce:creationCandidate.candidateNonce,
      selectionRevision:creationCandidate.selectionRevision,
      provider:creationUi.provider.value,
      confirmProjectRoot:creationUi.confirmProject.checked,
    });
    creationDraft = result.draft;
    activeCreationWorkItem = result.workItem ?? null;
    state = 'building';
    enterCreationBuilder(result.terminal?.provider ?? creationUi.provider.value);
  } catch (error) {
    setCreationChoiceState('creation-project-selected', error.message || 'Draft 创建失败', 'error');
  }
});



function enterCreationBuilder(providerName) {
  creationUi.startShell.hidden = true;
  creationUi.builder.hidden = false;
  supportNavigation.hidden = true;
  creationUi.workspaceNavigation.hidden = false;
  exitEditorButton.hidden = false;
  exitEditorButton.disabled = false;
  if (!creationTerminalPanel) {
    creationTerminalPanel = new AgentTerminalPanel(creationUi.terminalRoot, {
      token,
      editorToken:token,
      onClose:() => {
        creationTerminalPanel.hide();
        creationUi.builder.dataset.terminalHidden = 'true';
        creationUi.terminalReopen.hidden = false;
      },
      onState:terminalState => {
        if (terminalState?.interactionRequired?.kind) {
          ensureCreationTerminalOpen(terminalState.provider);
        }
      },
    });
  }
  creationUi.builder.dataset.terminalHidden = 'false';
  creationUi.terminalReopen.hidden = true;
  creationTerminalPanel.open(providerName);
  connectCreationEvents();
  renderCreationDraft();
}

function creationWorkItemDisplayName() {
  if (activeCreationWorkItem?.nameSource === 'custom') {
    return activeCreationWorkItem.displayName;
  }
  return creationDraft?.brief?.title
    || activeCreationWorkItem?.displayName
    || '未命名 Deck';
}

async function syncActiveCreationWorkItem() {
  if (!creationDraft) return null;
  const history = await requestJson('/api/work-history');
  activeCreationWorkItem = history.creation?.find(entry => (
    entry.draftId === creationDraft.draftId
    && entry.projectRoot === creationDraft.projectRoot
  )) ?? null;
  renderCreationDraft();
  return activeCreationWorkItem;
}

function closeCreationTitleEditor() {
  creationUi.draftTitleForm.hidden = true;
  creationUi.draftTitleButton.hidden = false;
}

creationUi.draftTitleButton.addEventListener('click', async () => {
  if (!activeCreationWorkItem) {
    try { await syncActiveCreationWorkItem(); } catch {}
  }
  if (!activeCreationWorkItem) {
    workspaceStatus('工作项身份尚未就绪，请稍后再试', 'error');
    return;
  }
  creationUi.draftTitleInput.value = creationWorkItemDisplayName();
  creationUi.draftTitleButton.hidden = true;
  creationUi.draftTitleForm.hidden = false;
  creationUi.draftTitleInput.focus();
  creationUi.draftTitleInput.select();
});
creationUi.draftTitleCancel.addEventListener('click', closeCreationTitleEditor);
creationUi.draftTitleInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeCreationTitleEditor();
});
creationUi.draftTitleForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeCreationWorkItem) return;
  creationUi.draftTitleInput.disabled = true;
  creationUi.draftTitleSave.disabled = true;
  creationUi.draftTitleCancel.disabled = true;
  workspaceStatus('正在保存工作项名称…', 'working');
  try {
    const result = await post('/api/work-items/rename', {
      workId:activeCreationWorkItem.workId,
      displayName:creationUi.draftTitleInput.value,
      expectedRevision:activeCreationWorkItem.revision,
    });
    activeCreationWorkItem = result.workItem;
    closeCreationTitleEditor();
    renderCreationDraft();
    workspaceStatus('工作项名称已更新；Brief 标题和输出文件名未改变');
  } catch (error) {
    workspaceStatus(error.message || '工作项改名失败', 'error');
    creationUi.draftTitleInput.focus();
    creationUi.draftTitleInput.select();
  } finally {
    creationUi.draftTitleInput.disabled = false;
    creationUi.draftTitleSave.disabled = false;
    creationUi.draftTitleCancel.disabled = false;
  }
});

new WorkspaceSwitcher({
  root:creationUi.workspaceNavigation,
  trigger:creationUi.switchWorkspace,
  loadHistory:() => requestJson('/api/work-history'),
  isCurrent:(kind, entry) => kind === 'creation'
    && creationDraft?.draftId === entry.draftId
    && creationDraft?.projectRoot === entry.projectRoot,
  onRename:input => post('/api/work-items/rename', input),
  onSelect:(kind, entry) => {
    creationUi.home.disabled = true;
    location.replace(workspaceTaskNavigationUrl(kind, entry));
  },
});
creationUi.home.addEventListener('click', () => navigateFromCreation('home'));
exitEditorButton.addEventListener('click', terminateEditorProcess);

creationUi.terminalReopen.addEventListener('click', () => {
  ensureCreationTerminalOpen(creationDraft?.provider);
});

function ensureCreationTerminalOpen(providerName = creationDraft?.provider) {
  if (!creationTerminalPanel) return false;
  const hidden = creationUi.builder.dataset.terminalHidden === 'true'
    || creationUi.terminalRoot.hidden;
  if (!hidden) return false;
  creationUi.builder.dataset.terminalHidden = 'false';
  creationUi.terminalReopen.hidden = true;
  creationTerminalPanel.open(providerName);
  return true;
}

function connectCreationEvents() {
  if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(creationEvents?.readyState)) return;
  const url = new URL('/creation-events', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('editorToken', token);
  creationEvents = new WebSocket(url);
  creationEvents.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { message = null; }
    if (message?.type === 'agent-terminal-updated'
      && message.payload?.interactionRequired?.kind) {
      ensureCreationTerminalOpen(message.payload.provider);
    }
    scheduleCreationRefresh();
  });
  creationEvents.addEventListener('close', () => {
    creationEvents = null;
    if (state === 'building') setTimeout(connectCreationEvents, 600);
  });
}

function scheduleCreationRefresh() {
  clearTimeout(creationRefreshTimer);
  creationRefreshTimer = setTimeout(async () => {
    try {
      const next = await requestJson('/api/creation-draft');
      if (!creationDraft || next.revision >= creationDraft.revision) {
        creationDraft = next;
        renderCreationDraft();
      }
    } catch { /* 断线后由 WebSocket 重连或下一次事件恢复 */ }
  }, 40);
}

function fallbackMilestones(draft) {
  const complete = (value, state) => ({ complete:value, state:value ? 'complete' : state });
  const brief = draft.briefConfirmedRevision !== null;
  const outline = draft.outlineStatus === 'confirmed' && draft.outlineConfirmedRevision !== null;
  const pagePlan = draft.pagePlanStatus === 'confirmed' && draft.pagePlanConfirmedRevision !== null;
  const deck = Boolean(
    draft.generation?.stagingDeck
    && ['editing', 'verifying', 'published'].includes(draft.generation.status),
  );
  return {
    brief:complete(brief, 'active'),
    outline:complete(outline, draft.outlineStatus === 'stale' ? 'stale' : brief ? 'active' : 'pending'),
    pagePlan:complete(pagePlan, draft.pagePlanStatus === 'stale' ? 'stale' : outline ? 'active' : 'pending'),
    deck:complete(deck, draft.generation?.status === 'failed'
      ? 'failed' : draft.generation?.status === 'preparing'
        ? 'working' : pagePlan ? 'active' : 'pending'),
  };
}

const milestoneDetails = {
  brief:{
    pending:'等待开始对话',
    active:'正在通过对话了解需求',
    complete:'brief.json 已写入',
    stale:'需求变化，等待重新确认',
  },
  outline:{
    pending:'等待需求共识',
    active:'Agent 正在组织大纲',
    complete:'outline.json 已写入',
    stale:'上游变化，等待重写',
  },
  pagePlan:{
    pending:'等待大纲共识',
    active:'Agent 正在拆分页面',
    complete:'page-plan.json 已写入',
    stale:'上游变化，等待重写',
  },
  deck:{
    pending:'等待页面规划',
    active:'等待生成独立 Deck',
    working:'正在创建独立 Deck',
    complete:'deck-ready.json 已写入',
    failed:'生成失败，可在对话中重试',
  },
};

function renderMilestones(milestones) {
  for (const node of document.querySelectorAll('[data-milestone]')) {
    const key = node.dataset.milestone;
    const milestone = milestones[key] ?? { state:'pending', complete:false };
    const nextState = milestone.complete ? 'complete' : milestone.state ?? 'pending';
    node.dataset.state = nextState;
    const detail = node.querySelector('[data-milestone-detail]');
    detail.textContent = milestoneDetails[key]?.[nextState] ?? '等待 Agent 更新';
    detail.title = milestone.path ?? '';
  }
}

function generationStatusCopy(generation) {
  const copies = {
    editing:'Agent 正在制作，可继续在右侧讨论',
    verifying:'正在独立验证 Deck',
    published:'已验证并发布，可进入微调编辑器',
    failed:'生成或验证失败，请在对话中让 Agent 修复',
  };
  return copies[generation?.status] ?? '独立 Deck 已载入';
}

function renderCreationDraft() {
  if (!creationDraft) return;
  const milestones = creationDraft.milestones ?? fallbackMilestones(creationDraft);
  const hasDeck = Boolean(creationDraft.previewDeck?.path && milestones.deck?.complete);
  const workItemName = creationWorkItemDisplayName();
  creationUi.draftTitle.textContent = workItemName;
  creationUi.draftTitleButton.setAttribute('aria-label', `重命名工作项 ${workItemName}`);
  let providerLabel = creationDraft.provider;
  try { providerLabel = agentProviderDefinition(creationDraft.provider).label; } catch {}
  creationUi.draftRevision.textContent = 'Revision ' + creationDraft.revision + ' · '
    + providerLabel;
  renderMilestones(milestones);

  creationUi.builder.dataset.hasDeck = String(hasDeck);
  creationUi.deckStage.hidden = !hasDeck;
  if (hasDeck) {
    creationUi.deckStageTitle.textContent = creationDraft.brief?.title || '未命名 Deck';
    creationUi.deckStageStatus.textContent = generationStatusCopy(creationDraft.generation);
    creationUi.openGenerated.hidden = creationDraft.phase !== 'ready';
    const nextKey = creationDraft.previewDeck.editorUrl
      ?? creationDraft.previewDeck.path + ':' + creationDraft.previewDeck.revision;
    if (creationPreviewKey !== nextKey) {
      creationPreviewKey = nextKey;
      workspaceStatus('正在刷新 Deck 画布…', 'working');
      creationUi.deckPreview.src = creationDraft.previewDeck.editorUrl
        ?? '/creation-deck-preview?token='
          + encodeURIComponent(token) + '&revision='
          + encodeURIComponent(creationDraft.previewDeck.revision);
    }
  } else {
    creationPreviewKey = null;
    creationUi.openGenerated.hidden = true;
    creationUi.deckPreview.removeAttribute('src');
    workspaceStatus('');
  }

  if (creationHasDeck !== hasDeck) {
    creationHasDeck = hasDeck;
    requestAnimationFrame(() => creationTerminalPanel?.open(creationDraft.provider));
  }
}

creationUi.deckPreview.addEventListener('load', () => {
  if (creationHasDeck) workspaceStatus('Deck 画布已同步');
});

creationUi.openGenerated.addEventListener('click', async () => {
  workspaceStatus('正在把当前 Agent 会话交给编辑器…', 'working');
  try {
    const result = await post('/api/creation-draft/open-editor');
    state = 'selected';
    releaseStartupVisuals();
    launcherLeaseHandedOff = true;
    window.location.replace(result.editorUrl);
  } catch (error) {
    workspaceStatus(error.message || '无法打开编辑器', 'error');
  }
});

async function resumeCreationDraft() {
  try {
    creationDraft = await requestJson('/api/creation-draft');
    state = 'building';
    enterCreationBuilder(creationDraft.provider);
    void syncActiveCreationWorkItem().catch(() => {});
    return true;
  } catch (error) {
    if (error.code !== 'CREATION_DRAFT_NOT_FOUND') {
      creationStatus(error.message || '无法恢复 Creation Draft', 'error');
    }
    return false;
  }
}

window.addEventListener('pagehide', () => {
  pageIsClosing = true;
  launcherLeaseClient?.close();
  if (!launcherLeaseHandedOff) {
    navigator.sendBeacon('/api/close?token=' + encodeURIComponent(token)
      + '&clientId=' + encodeURIComponent(launcherClientId)
      + '&sequence=' + encodeURIComponent(launcherClientSequence));
  }
  releaseStartupVisuals();
});

let navigationError = null;
const requestedWorkspaceTask = launchParams.get('switchKind') === 'creation'
  && launchParams.get('projectRoot') && launchParams.get('draftId')
  ? {
      kind:'creation',
      projectRoot:launchParams.get('projectRoot'),
      draftId:launchParams.get('draftId'),
    }
  : launchParams.get('switchKind') === 'editing' && launchParams.get('deckPath')
    ? {
        kind:'editing', deckPath:launchParams.get('deckPath'),
        workId:launchParams.get('workId'),
      }
    : null;
if (isLeavingWorkspace) {
  try {
    await post('/api/leave-workspace', {
      destination:requestedWorkspaceView ?? 'home',
    });
  } catch (error) {
    navigationError = error;
  }
  const cleanUrl = new URL('/app/', location.origin);
  cleanUrl.searchParams.set('token', token);
  if (requestedWorkspaceView) cleanUrl.searchParams.set('view', requestedWorkspaceView);
  history.replaceState(null, '', cleanUrl);
}

const connectedState = await launcherLeasePromise ?? await post('/api/client-connected', {
  clientId:launcherClientId,
  sequence:launcherClientSequence,
});
if (requestedWorkspaceTask && !navigationError) {
  showLanding();
  if (requestedWorkspaceTask.kind === 'creation') {
    await resumeCreationTask(requestedWorkspaceTask);
  } else {
    await resumeDeckTask(requestedWorkspaceTask);
  }
} else if (!isLeavingWorkspace
  && connectedState.status === 'selected' && connectedState.editorUrl) {
  releaseStartupVisuals();
  launcherLeaseHandedOff = true;
  window.location.replace(connectedState.editorUrl);
} else if (!isLeavingWorkspace && connectedState.status === 'deck-selected') {
  renderCandidate(connectedState);
} else if (!isLeavingWorkspace && connectedState.status === 'creation-project-selected') {
  showCreationFlow();
  renderCreationCandidate(connectedState);
} else if (!await resumeCreationDraft()) {
  if (requestedWorkspaceView === 'creation') showCreationFlow();
  else if (requestedWorkspaceView === 'editing') showExistingFlow();
  else showLanding();
  if (navigationError) {
    if (requestedWorkspaceView === 'creation') {
      creationStatus(navigationError.message || '暂时无法切换项目', 'error');
    } else if (requestedWorkspaceView === 'editing') {
      setStatus(navigationError.message || '暂时无法切换项目', 'error');
    } else {
      historyStatus('creation', navigationError.message || '暂时无法返回初始页', 'error');
    }
  }
  void loadWorkHistory();
}
startStartupVisuals();
const { createSupportCenter } = await import(
  `/app/support-center.mjs?token=${encodeURIComponent(token)}`
);
createSupportCenter({
  requestJson,
  post,
  getAppState:() => state,
  onSampleCreated:result => {
    renderCandidate(result);
    setStatus('示例副本已创建；确认项目目录和 Agent 后打开编辑器。');
  },
});
document.documentElement.dataset.appReady = 'true';
delete document.documentElement.dataset.workspaceNavigationState;
