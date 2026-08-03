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

function formatSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${unit}`;
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
  for (const [taskIndex, task] of tasks.entries()) {
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
    if (Array.isArray(task.attachments) && task.attachments.length > 0) {
      const attachmentsId = `task-attachments-${taskIndex}`;
      const attachmentsToggle = element(
        'button',
        'task-attachments-toggle',
        `附件 ${task.attachments.length}`,
      );
      attachmentsToggle.type = 'button';
      attachmentsToggle.dataset.taskAttachmentsToggle = task.id;
      attachmentsToggle.setAttribute('aria-controls', attachmentsId);
      attachmentsToggle.setAttribute('aria-expanded', 'false');

      const attachments = element('div', 'task-attachments');
      attachments.id = attachmentsId;
      attachments.hidden = true;
      for (const attachment of task.attachments) {
        const item = element('article', 'task-attachment');
        item.dataset.taskAttachment = '';
        const summary = element('div', 'task-attachment-summary');
        summary.append(element('strong', '', attachment.name));
        const size = element('span', '', formatSize(attachment.size));
        size.dataset.attachmentSize = '';
        summary.append(size);

        const path = element('code', 'task-attachment-path', attachment.path);
        path.dataset.attachmentPath = '';
        const copy = element('button', 'task-copy-attachment', '复制路径');
        copy.type = 'button';
        copy.dataset.copyAttachmentPath = '';
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(attachment.path);
            copy.textContent = '已复制';
          } catch {
            copy.textContent = '复制失败，请手动选择路径';
          }
          window.setTimeout(() => {
            if (!copy.isConnected) return;
            copy.textContent = '复制路径';
            copy.disabled = false;
          }, 1_500);
        });
        item.append(summary, path, copy);
        attachments.append(item);
      }
      attachmentsToggle.addEventListener('click', () => {
        const expanded = attachmentsToggle.getAttribute('aria-expanded') !== 'true';
        attachmentsToggle.setAttribute('aria-expanded', String(expanded));
        attachments.hidden = !expanded;
      });
      row.append(attachmentsToggle, attachments);
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
