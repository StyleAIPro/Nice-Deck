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

function runMessage(run) {
  if (!run || run.status === 'idle') return '';
  const defaults = {
    queued:'反馈已提交，正在启动 Agent',
    running:'Agent 正在处理本批反馈',
    succeeded:'Agent 已完成本批处理，请检查结果',
    failed:'Agent 批处理失败',
    cancelled:'Agent 任务已取消',
  };
  return run.message || defaults[run.status] || '';
}

export function renderTaskDrawer(root, {
  tasks, agentRun = { status:'idle' }, onLocate, onProcessAll, onUndo, onEdit, onDelete,
}) {
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
  const setOpen = open => {
    root.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.task-drawer-chevron').textContent = open ? '收起' : '展开';
  };
  toggle.addEventListener('click', () => setOpen(root.dataset.open !== 'true'));
  root.append(toggle);

  const panel = element('section', 'task-drawer-panel deck-notespanel');
  panel.dataset.taskDrawerPanel = '';
  panel.setAttribute('aria-label', 'Agent 修改任务');
  const panelHeader = element('header', 'task-panel-header');
  panelHeader.append(element('span', 'deck-panel-dot'));
  panelHeader.append(element('strong', 'deck-panel-title', 'Agent 修改任务'));
  panelHeader.append(element('span', 'task-panel-count', String(tasks.length)));
  const close = element('button', 'deck-panel-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭 Agent 修改任务面板');
  close.addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  panelHeader.append(close);
  panel.append(panelHeader);
  const list = element('div', 'task-list');
  const activeRun = ['queued', 'running'].includes(agentRun.status);
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
    const mutable = ['pending', 'failed', 'needs-confirmation'].includes(task.status)
      && !task.groupId;
    if (mutable && (onEdit || onDelete)) {
      const actions = element('div', 'task-row-actions');
      if (onEdit) {
        const edit = element('button', 'task-edit', '编辑');
        edit.type = 'button';
        edit.dataset.taskEdit = task.id;
        edit.disabled = activeRun;
        edit.addEventListener('click', () => {
          const originalChildren = [...row.childNodes];
          const form = element('form', 'task-edit-form');
          form.dataset.taskEditForm = task.id;
          const input = element('textarea', 'task-edit-input');
          input.dataset.taskEditInput = task.id;
          input.rows = 3;
          input.maxLength = 10_000;
          input.value = task.instruction;
          input.setAttribute('aria-label', '修改任务说明');
          const note = element('p', 'task-edit-note');
          note.dataset.taskEditNote = '';
          note.setAttribute('role', 'status');
          const controls = element('div', 'task-edit-controls');
          const cancel = element('button', 'task-edit-cancel', '取消');
          cancel.type = 'button';
          cancel.dataset.taskEditCancel = task.id;
          const save = element('button', 'task-edit-save', '保存');
          save.type = 'submit';
          save.dataset.taskEditSave = task.id;
          controls.append(cancel, save);
          form.append(input, note, controls);
          const restore = () => row.replaceChildren(...originalChildren);
          cancel.addEventListener('click', restore);
          form.addEventListener('submit', async event => {
            event.preventDefault();
            const instruction = input.value.trim();
            if (!instruction) {
              note.textContent = '修改说明不能为空';
              input.focus();
              return;
            }
            input.disabled = true;
            cancel.disabled = true;
            save.disabled = true;
            note.textContent = '正在保存…';
            try {
              await onEdit(task, instruction);
            } catch (error) {
              if (!form.isConnected) return;
              input.disabled = false;
              cancel.disabled = false;
              save.disabled = false;
              note.textContent = `保存失败：${error?.message || '未知错误'}`;
              input.focus();
            }
          });
          row.replaceChildren(form);
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        });
        actions.append(edit);
      }
      if (onDelete) {
        const remove = element('button', 'task-delete', '删除');
        remove.type = 'button';
        remove.dataset.taskDelete = task.id;
        remove.disabled = activeRun;
        remove.addEventListener('click', () => {
          if (row.querySelector('[data-task-delete-confirmation]')) return;
          const confirmation = element('div', 'task-delete-confirmation');
          confirmation.dataset.taskDeleteConfirmation = task.id;
          confirmation.append(element('p', '', '确定删除这条任务？区域截图和附件也会一并清理。'));
          const controls = element('div', 'task-delete-controls');
          const cancel = element('button', 'task-delete-cancel', '取消');
          cancel.type = 'button';
          cancel.dataset.taskDeleteCancel = task.id;
          const confirm = element('button', 'task-delete-confirm', '确认删除');
          confirm.type = 'button';
          confirm.dataset.taskDeleteConfirm = task.id;
          cancel.addEventListener('click', () => confirmation.remove());
          confirm.addEventListener('click', async () => {
            cancel.disabled = true;
            confirm.disabled = true;
            confirm.textContent = '正在删除…';
            try {
              await onDelete(task);
            } catch (error) {
              if (!confirmation.isConnected) return;
              cancel.disabled = false;
              confirm.disabled = false;
              confirm.textContent = '确认删除';
              confirmation.querySelector('p').textContent = `删除失败：${error?.message || '未知错误'}`;
            }
          });
          controls.append(cancel, confirm);
          confirmation.append(controls);
          row.append(confirmation);
          confirm.focus();
        });
        actions.append(remove);
      }
      row.append(actions);
    }
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
  const actionableTasks = tasks.filter(task => ['pending', 'failed'].includes(task.status));
  const buttonText = activeRun
    ? `Agent 正在处理 ${agentRun.taskCount ?? actionableTasks.length} 条`
    : `交给 Agent 处理全部 ${actionableTasks.length} 条`;
  const process = element('button', 'task-process-all', buttonText);
  process.type = 'button';
  process.dataset.processAll = '';
  process.disabled = actionableTasks.length === 0 || activeRun;
  process.setAttribute('aria-busy', String(activeRun));
  const note = element('p', 'task-process-note');
  note.dataset.processNote = '';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  note.textContent = runMessage(agentRun);
  process.addEventListener('click', () => {
    process.disabled = true;
    note.textContent = '正在把本批反馈交给 Agent…';
    Promise.resolve(onProcessAll?.(actionableTasks)).then(message => {
      if (note.isConnected && message) note.textContent = message;
    }).catch(error => {
      if (!note.isConnected) return;
      note.textContent = `提交失败：${error?.message || '未知错误'}`;
      process.disabled = false;
    });
  });
  footer.append(process, note);
  panel.append(footer);
  root.append(panel);
}
