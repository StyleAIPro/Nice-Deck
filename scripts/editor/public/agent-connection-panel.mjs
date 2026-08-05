function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function providerName(configuration, providerId) {
  return configuration?.providers?.find(provider => provider.id === providerId)?.name
    ?? providerId;
}

function skillLabel(status, provider) {
  if (status === 'unknown' && provider === 'openclaw') return '无法确认 Skill';
  return {
    loaded:'Skill 已加载',
    detected:'检测到 Skill',
    'not-detected':'未检测到 Skill',
    unknown:'连接时检测',
  }[status] ?? '无法确认 Skill';
}

function formattedTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
  }).format(date);
}

function shortId(value) {
  if (!value) return '';
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

function projectGroups(catalog, providerId) {
  const sessions = (catalog?.sessions ?? []).filter(session => session.provider === providerId);
  const byPath = new Map();
  for (const project of catalog?.projects ?? []) {
    if (project.source === 'discovered' && !project.providers?.includes(providerId)) continue;
    byPath.set(project.path, { ...project, sessions:[] });
  }
  let ungrouped;
  for (const session of sessions) {
    if (session.cwd) {
      const group = byPath.get(session.cwd) ?? {
        path:session.cwd,
        name:session.cwd.split('/').filter(Boolean).at(-1) || session.cwd,
        source:'discovered',
        sessions:[],
      };
      group.sessions.push(session);
      byPath.set(session.cwd, group);
    } else {
      ungrouped ??= {
        path:null, name:'未识别项目', source:'unknown', sessions:[],
      };
      ungrouped.sessions.push(session);
    }
  }
  const groups = [...byPath.values()].sort((left, right) => {
    const leftSelected = left.sessions.some(session => session.selected);
    const rightSelected = right.sessions.some(session => session.selected);
    return Number(rightSelected) - Number(leftSelected)
      || right.sessions.length - left.sessions.length
      || left.name.localeCompare(right.name, 'zh-CN');
  });
  if (ungrouped) groups.push(ungrouped);
  return groups;
}

function renderSession(session, { busy, onConnect }) {
  const button = element('button', 'agent-session-row');
  button.type = 'button';
  button.dataset.agentSession = session.id;
  button.dataset.skillStatus = session.skillStatus ?? 'unknown';
  button.disabled = busy;
  if (session.selected) {
    button.dataset.selected = 'true';
    button.setAttribute('aria-current', 'true');
  }
  const heading = element('span', 'agent-session-row-heading');
  heading.append(
    element('strong', '', session.title || '未命名会话'),
    element('code', '', shortId(session.id)),
  );
  const meta = element('span', 'agent-session-row-meta');
  meta.append(
    element('span', '', [session.model, formattedTime(session.updatedAt)].filter(Boolean).join(' · ')),
    element(
      'span',
      `agent-session-skill agent-session-skill-${session.skillStatus ?? 'unknown'}`,
      skillLabel(session.skillStatus, session.provider),
    ),
  );
  button.append(heading, meta);
  button.addEventListener('click', () => onConnect?.(session));
  return button;
}

export function renderAgentConnectionPanel(root, {
  open = false,
  configuration = null,
  catalog = null,
  loading = false,
  error = '',
  busy = false,
  notice = '',
  selectedProvider = 'codex',
  onClose,
  onSelectProvider,
  onRefresh,
  onConnect,
  onDisconnect,
  onPickProject,
  onCreateSession,
  onManualConnect,
}) {
  root.hidden = !open;
  root.replaceChildren();
  if (!open) return;

  const header = element('header', 'agent-panel-header');
  header.append(element('span', 'deck-panel-dot'));
  const title = element('div', 'agent-panel-title');
  title.append(element('strong', '', 'Agent 连接'));
  title.append(element('span', '', '按 Agent 与项目管理会话'));
  const headerActions = element('div', 'agent-panel-header-actions');
  const refresh = element('button', 'agent-panel-quiet-button', loading ? '查找中…' : '刷新');
  refresh.type = 'button';
  refresh.disabled = loading || busy;
  refresh.addEventListener('click', () => onRefresh?.());
  const close = element('button', 'agent-panel-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭 Agent 连接面板');
  close.addEventListener('click', () => onClose?.());
  headerActions.append(refresh, close);
  header.append(title, headerActions);
  root.append(header);

  const providers = configuration?.providers ?? [];
  const providerStatus = new Map((catalog?.providers ?? []).map(provider => [provider.id, provider]));
  const tabs = element('div', 'agent-provider-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const provider of providers) {
    const availability = providerStatus.get(provider.id);
    const count = (catalog?.sessions ?? []).filter(session => session.provider === provider.id).length;
    const tab = element('button', 'agent-provider-tab');
    tab.type = 'button';
    tab.dataset.provider = provider.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(provider.id === selectedProvider));
    tab.append(
      element('span', '', provider.name),
      element('span', 'agent-provider-count', availability?.available === false ? '不可用' : String(count)),
    );
    tab.addEventListener('click', () => onSelectProvider?.(provider.id));
    tabs.append(tab);
  }
  root.append(tabs);

  const body = element('div', 'agent-panel-body');
  const availability = providerStatus.get(selectedProvider);
  if (availability?.available === false) {
    const unavailable = element('div', 'agent-panel-empty');
    unavailable.append(element('strong', '', `${providerName(configuration, selectedProvider)} 当前不可用`));
    unavailable.append(element('span', '', availability.reason || '未安装或会话目录读取失败'));
    body.append(unavailable);
  } else if (loading && !catalog) {
    body.append(element('p', 'agent-panel-loading', '正在查找本机 Agent 会话…'));
  } else if (error && !catalog) {
    body.append(element('p', 'agent-panel-error', `查找失败：${error}`));
  } else {
    const search = element('input', 'agent-session-search');
    search.type = 'search';
    search.placeholder = `搜索 ${providerName(configuration, selectedProvider)} 会话或项目`;
    search.setAttribute('aria-label', search.placeholder);
    body.append(search);

    const projects = element('div', 'agent-project-list');
    const groups = projectGroups(catalog, selectedProvider);
    if (!groups.length) {
      projects.append(element('p', 'agent-panel-loading', '暂无项目。可在下方添加项目目录。'));
    }
    groups.forEach((group, index) => {
      const project = element('details', 'agent-project-group');
      project.dataset.projectPath = group.path ?? '';
      project.open = index === 0 || group.sessions.some(session => session.selected);
      const summary = element('summary', 'agent-project-summary');
      const projectIdentity = element('span', 'agent-project-identity');
      projectIdentity.append(element('strong', '', group.name));
      projectIdentity.append(element('span', '', group.path ?? '此 Agent 未提供工作目录'));
      const projectActions = element('span', 'agent-project-actions');
      projectActions.append(element('span', 'agent-project-count', `${group.sessions.length} 个会话`));
      summary.append(projectIdentity, projectActions);
      const sessions = element('div', 'agent-project-sessions');
      if (group.path) {
        const sessionToolbar = element('div', 'agent-project-session-toolbar');
        const create = element('button', 'agent-project-create-session', '新建会话');
        create.type = 'button';
        create.disabled = busy;
        create.addEventListener('click', () => {
          onCreateSession?.({ provider:selectedProvider, projectPath:group.path });
        });
        sessionToolbar.append(create);
        sessions.append(sessionToolbar);
      }
      for (const session of group.sessions) sessions.append(renderSession(session, { busy, onConnect }));
      if (!group.sessions.length) {
        sessions.append(element('p', 'agent-project-empty', '这个项目还没有该 Agent 的会话。'));
      }
      project.append(summary, sessions);
      projects.append(project);
    });
    body.append(projects);
    search.addEventListener('input', () => {
      const query = search.value.trim().toLocaleLowerCase('zh-CN');
      for (const project of projects.querySelectorAll('.agent-project-group')) {
        const match = !query || project.textContent.toLocaleLowerCase('zh-CN').includes(query);
        project.hidden = !match;
        if (match && query) project.open = true;
      }
    });
  }
  root.append(body);

  const footer = element('footer', 'agent-panel-footer');
  const primaryActions = element('div', 'agent-panel-primary-actions');
  const pickProject = element('button', 'agent-panel-project-button', '添加 / 新建项目');
  pickProject.type = 'button';
  pickProject.disabled = busy;
  pickProject.addEventListener('click', () => onPickProject?.());
  const defaultProjectPath = catalog?.defaultProjectPath;
  const createDefault = element('button', 'agent-panel-create-button', '在当前 Deck 项目新建会话');
  createDefault.type = 'button';
  createDefault.disabled = busy || availability?.available === false || !defaultProjectPath;
  createDefault.addEventListener('click', () => onCreateSession?.({
    provider:selectedProvider,
    projectPath:defaultProjectPath,
  }));
  primaryActions.append(pickProject, createDefault);

  const manual = element('details', 'agent-panel-manual');
  const manualSummary = element('summary', '', '手动连接会话 ID');
  const manualForm = element('form', 'agent-panel-manual-form');
  const manualInput = element('input', 'agent-panel-manual-input');
  manualInput.name = 'sessionId';
  manualInput.placeholder = '输入会话 ID';
  manualInput.autocomplete = 'off';
  manualInput.spellcheck = false;
  const manualSubmit = element('button', 'agent-panel-manual-submit', '连接');
  manualSubmit.type = 'submit';
  manualSubmit.disabled = busy;
  manualForm.append(manualInput, manualSubmit);
  manualForm.addEventListener('submit', event => {
    event.preventDefault();
    const sessionId = manualInput.value.trim();
    if (sessionId) onManualConnect?.({ provider:selectedProvider, threadId:sessionId });
  });
  manual.append(manualSummary, manualForm);

  const status = element('div', 'agent-panel-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = notice || (busy ? '正在处理连接操作…' : '连接会跟随当前 Deck 保存。');
  const disconnect = element('button', 'agent-panel-disconnect', '断开当前会话');
  disconnect.type = 'button';
  disconnect.disabled = busy || !configuration?.connection?.threadId;
  disconnect.addEventListener('click', () => onDisconnect?.());
  footer.append(primaryActions, manual, status, disconnect);
  root.append(footer);
}
