const STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  'needs-confirmation': '待确认',
  completed: '已完成',
  failed: '失败',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderTaskDrawer(root, { tasks, onLocate, onProcessAll, onUndo }) {
  const wasOpen = root.dataset.open === 'true';
  const previousCount = Number(root.dataset.taskCount ?? 0);
  const shouldOpen = wasOpen || (previousCount === 0 && tasks.length > 0);
  root.dataset.rendered = 'true';
  root.dataset.taskCount = String(tasks.length);
  root.dataset.open = String(shouldOpen);
  root.replaceChildren();

  const toggle = element('button', 'task-drawer-toggle');
  toggle.type = 'button';
  toggle.dataset.taskDrawerToggle = '';
  toggle.setAttribute('aria-expanded', String(shouldOpen));
  toggle.append(element('span', 'task-drawer-agent', 'AGENT'));
  toggle.append(element('strong', '', `修改任务 ${tasks.length}`));
  toggle.append(element('span', 'task-drawer-chevron', shouldOpen ? '收起' : '展开'));
  toggle.addEventListener('click', () => {
    const open = root.dataset.open !== 'true';
    root.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.task-drawer-chevron').textContent = open ? '收起' : '展开';
  });
  root.append(toggle);

  const panel = element('section', 'task-drawer-panel');
  panel.dataset.taskDrawerPanel = '';
  panel.setAttribute('aria-label', 'Agent 修改任务');
  const list = element('div', 'task-list');
  if (!tasks.length) {
    list.append(element('p', 'task-empty', '拉框标记页面区域后，任务会记录在这里。'));
  }
  for (const task of tasks) {
    const row = element('article', 'task-row');
    row.dataset.taskRow = task.id;
    const locate = element('button', 'task-locate');
    locate.type = 'button';
    locate.dataset.taskLocate = task.id;
    locate.setAttribute('aria-label', `定位第 ${task.pageIndex} 页：${task.instruction}`);
    const meta = element('div', 'task-meta');
    meta.append(element('span', 'task-page', `${String(task.pageIndex).padStart(2, '0')} · ${task.pageLabel}`));
    const status = element('span', `task-status task-status-${task.status}`, STATUS_LABELS[task.status] ?? task.status);
    meta.append(status);
    locate.append(meta, element('p', 'task-instruction', task.instruction));
    locate.addEventListener('click', () => onLocate?.(task));
    row.append(locate);
    if (task.groupId && onUndo) {
      const undo = element('button', 'task-undo', '撤销');
      undo.type = 'button';
      undo.dataset.taskUndo = task.id;
      undo.addEventListener('click', () => onUndo(task));
      row.append(undo);
    }
    list.append(row);
  }
  panel.append(list);

  const footer = element('div', 'task-drawer-footer');
  const process = element('button', 'task-process-all', `交给 Agent 处理全部 ${tasks.length} 条`);
  process.type = 'button';
  process.dataset.processAll = '';
  process.disabled = tasks.length === 0;
  const note = element('p', 'task-process-note');
  note.dataset.processNote = '';
  process.addEventListener('click', () => {
    const message = onProcessAll?.(tasks);
    note.textContent = message || '请在外部 Agent CLI 中读取任务；此处不会伪装已调用。';
  });
  footer.append(process, note);
  panel.append(footer);
  root.append(panel);
}
