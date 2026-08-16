import { applyPill, setPillLabel } from './pill-nav.mjs';

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

function taskRecency(task) {
  for (const value of [task?.updatedAt, task?.createdAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
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

export function setTaskDrawerOpen(root, open) {
  const next = open === true;
  root.dataset.open = String(next);
  const toggle = root.querySelector('[data-task-drawer-toggle]');
  toggle?.setAttribute('aria-expanded', String(next));
  const chevron = toggle?.querySelector('.task-drawer-chevron');
  if (chevron) chevron.textContent = next ? '收起' : '展开';
}

export function renderTaskDrawer(root, {
  tasks, agentRun = { status:'idle' },
  onLocate, onProcessAll, onUndo, onEdit, onDelete,
}) {
  const completedCount = tasks.filter(task => task.status === 'completed').length;
  const pendingCount = tasks.length - completedCount;
  const needsConfirmationCount = tasks.filter(
    task => task.status === 'needs-confirmation',
  ).length;
  const targetMissingCount = tasks.filter(task => task.targetMissing === true).length;
  const wasOpen = root.dataset.open === 'true';
  const previousCount = Number(root.dataset.taskCount ?? 0);
  const shouldOpen = wasOpen || (previousCount === 0 && tasks.length > 0);
  root.dataset.rendered = 'true';
  root.dataset.taskCount = String(tasks.length);
  root.dataset.needsConfirmationCount = String(needsConfirmationCount);
  root.dataset.open = String(shouldOpen);
  root.replaceChildren();

  const toggle = element('button', 'task-drawer-toggle');
  toggle.type = 'button';
  toggle.dataset.taskDrawerToggle = '';
  toggle.setAttribute('aria-expanded', String(shouldOpen));
  toggle.setAttribute(
    'aria-label',
    `Agent 修改任务：待完成 ${pendingCount}，`
      + `其中待确认 ${needsConfirmationCount}，已完成 ${completedCount}`,
  );
  toggle.append(element('span', 'task-drawer-agent', 'AGENT'));
  const counts = element('span', 'task-drawer-counts');
  const pending = element('span', 'task-drawer-count task-drawer-count-pending', `待完成 ${pendingCount}`);
  pending.dataset.taskPendingCount = String(pendingCount);
  if (needsConfirmationCount > 0) {
    pending.classList.add('task-drawer-count-attention');
    pending.title = `${needsConfirmationCount} 条任务需要补充信息`;
  }
  const completed = element(
    'span',
    'task-drawer-count task-drawer-count-completed',
    `已完成 ${completedCount}`,
  );
  completed.dataset.taskCompletedCount = String(completedCount);
  counts.append(pending, completed);
  toggle.append(counts);
  toggle.append(element('span', 'task-drawer-chevron', shouldOpen ? '收起' : '展开'));
  const setOpen = open => setTaskDrawerOpen(root, open);
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
  applyPill(close, { variant:'neutral', size:'sm', kind:'icon' });
  close.addEventListener('click', () => {
    setOpen(false);
    toggle.focus();
  });
  panelHeader.append(close);
  panel.append(panelHeader);
  const list = element('div', 'task-list');
  const activeRun = ['queued', 'running'].includes(agentRun.status);
  const completedRows = [];
  if (!tasks.length) {
    list.append(element('p', 'task-empty', '拉框标记页面区域后，任务会记录在这里。'));
  }
  for (const [taskIndex, task] of tasks.entries()) {
    const row = element('article', 'task-row');
    row.dataset.taskRow = task.id;
    const needsConfirmation = task.status === 'needs-confirmation';
    const targetMissing = task.targetMissing === true;
    if (needsConfirmation) row.dataset.needsConfirmation = '';
    if (targetMissing) row.dataset.targetMissing = '';
    const locate = element('button', 'task-locate');
    locate.type = 'button';
    locate.dataset.taskLocate = task.id;
    locate.disabled = targetMissing;
    locate.setAttribute('aria-label', targetMissing
      ? `目标页面已删除：${task.instruction}`
      : `定位第 ${task.pageIndex} 页：${task.instruction}`);
    const meta = element('div', 'task-meta');
    meta.append(element('span', 'task-page', `${String(task.pageIndex).padStart(2, '0')} · ${task.pageLabel}`));
    const status = element(
      'span',
      `task-status ${targetMissing ? 'task-status-target-missing' : `task-status-${task.status}`}`,
      targetMissing ? '页面已删除' : (STATUS_LABELS[task.status] ?? task.status),
    );
    meta.append(status);
    locate.append(meta, element('p', 'task-instruction', task.instruction));
    locate.addEventListener('click', () => {
      if (!targetMissing) onLocate?.(task);
    });
    row.append(locate);
    if (targetMissing) {
      const notice = element('aside', 'task-target-missing-notice');
      notice.dataset.taskTargetMissing = task.id;
      notice.setAttribute('role', 'status');
      notice.append(
        element('strong', '', '这个任务的目标页面已删除。'),
        element('span', '', task.groupId
          ? '撤销本次删页即可恢复页面和任务。'
          : '可以删除任务记录，或在页面恢复后重新标记。'),
      );
      row.append(notice);
    } else if (needsConfirmation) {
      const notice = element('aside', 'task-confirmation-notice');
      notice.dataset.taskConfirmationNotice = task.id;
      notice.setAttribute('role', 'alert');
      const indicator = element('span', 'task-confirmation-indicator');
      indicator.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'task-confirmation-copy');
      copy.append(
        element('strong', '', '检测到多个可能目标，Agent 无法安全确定修改对象。'),
        element('span', '', '请点击“补充说明”，写清具体位置或对象后重新提交。'),
      );
      notice.append(indicator, copy);
      row.append(notice);
    }
    const mutable = !targetMissing
      && ['pending', 'failed', 'needs-confirmation'].includes(task.status)
      && !task.groupId;
    const solidified = task.status === 'completed' && !task.groupId;
    const missingTargetDeletable = targetMissing && !task.groupId
      && ['pending', 'failed', 'needs-confirmation', 'completed'].includes(task.status);
    const deletable = mutable || solidified || missingTargetDeletable;
    if ((mutable && onEdit) || (deletable && onDelete)) {
      const actions = element('div', 'task-row-actions');
      if (mutable && onEdit) {
        const edit = element(
          'button',
          `task-edit${needsConfirmation ? ' task-edit-attention' : ''}`,
          needsConfirmation ? '补充说明' : '编辑',
        );
        edit.type = 'button';
        edit.dataset.taskEdit = task.id;
        edit.disabled = activeRun;
        applyPill(edit, { variant:'neutral', size:'sm', kind:'action' });
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
          applyPill(cancel, { variant:'secondary', size:'sm', kind:'action' });
          applyPill(save, { variant:'primary', size:'sm', kind:'action' });
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
      if (deletable && onDelete) {
        const remove = element('button', 'task-delete', solidified ? '删除记录' : '删除');
        remove.type = 'button';
        remove.dataset.taskDelete = task.id;
        remove.disabled = activeRun;
        applyPill(remove, { variant:'danger', size:'sm', kind:'action' });
        remove.addEventListener('click', () => {
          if (row.querySelector('[data-task-delete-confirmation]')) return;
          const confirmation = element('div', 'task-delete-confirmation');
          confirmation.dataset.taskDeleteConfirmation = task.id;
          confirmation.append(element('p', '', solidified
            ? '确定删除这条已固化任务记录？Deck 中已固化的修改不会改变，区域截图和附件会一并清理。'
            : '确定删除这条任务？区域截图和附件也会一并清理。'));
          const controls = element('div', 'task-delete-controls');
          const cancel = element('button', 'task-delete-cancel', '取消');
          cancel.type = 'button';
          cancel.dataset.taskDeleteCancel = task.id;
          const confirm = element('button', 'task-delete-confirm', '确认删除');
          confirm.type = 'button';
          confirm.dataset.taskDeleteConfirm = task.id;
          applyPill(cancel, { variant:'secondary', size:'sm', kind:'action' });
          applyPill(confirm, { variant:'danger', size:'sm', kind:'action' });
          cancel.addEventListener('click', () => confirmation.remove());
          confirm.addEventListener('click', async () => {
            cancel.disabled = true;
            confirm.disabled = true;
            setPillLabel(confirm, '正在删除…');
            try {
              await onDelete(task);
            } catch (error) {
              if (!confirmation.isConnected) return;
              cancel.disabled = false;
              confirm.disabled = false;
              setPillLabel(confirm, '确认删除');
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
      applyPill(undo, { variant:'neutral', size:'sm', kind:'action' });
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
        applyPill(copy, { variant:'neutral', size:'sm', kind:'action' });
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(attachment.path);
            setPillLabel(copy, '已复制');
          } catch {
            setPillLabel(copy, '复制失败，请手动选择路径');
          }
          window.setTimeout(() => {
            if (!copy.isConnected) return;
            setPillLabel(copy, '复制路径');
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
    if (task.status === 'completed') completedRows.push({ row, task, taskIndex });
    else list.append(row);
  }
  if (completedRows.length > 0) {
    const orderedCompletedRows = [...completedRows]
      .sort((left, right) => (
        taskRecency(right.task) - taskRecency(left.task)
        || right.taskIndex - left.taskIndex
      ))
      .map(item => item.row);
    const completedGroup = element('details', 'task-completed-group');
    completedGroup.dataset.taskCompletedGroup = '';
    completedGroup.open = root.dataset.completedOpen === 'true';
    const completedSummary = element('summary', 'task-completed-summary');
    const undoableCompleted = orderedCompletedRows.some(
      row => row.querySelector('[data-task-undo]'),
    );
    completedSummary.append(
      element('strong', '', `已完成 ${completedRows.length} 条`),
      element('span', '', undoableCompleted ? '可展开查看与撤销' : '已固化，可删除记录'),
    );
    const completedList = element('div', 'task-completed-list');
    completedList.append(...orderedCompletedRows);
    completedGroup.append(completedSummary, completedList);
    completedGroup.addEventListener('toggle', () => {
      root.dataset.completedOpen = String(completedGroup.open);
    });
    list.append(completedGroup);
  } else {
    root.dataset.completedOpen = 'false';
  }
  panel.append(list);

  const footer = element('div', 'task-drawer-footer');
  const actionableTasks = tasks.filter(task => (
    task.targetMissing !== true && ['pending', 'failed'].includes(task.status)
  ));
  const buttonText = activeRun
    ? `Agent 正在处理 ${agentRun.taskCount ?? actionableTasks.length} 条`
    : actionableTasks.length === 0 && targetMissingCount > 0
      ? `有 ${targetMissingCount} 条任务的页面已删除`
    : actionableTasks.length === 0 && needsConfirmationCount > 0
      ? `有 ${needsConfirmationCount} 条任务需要补充说明`
    : `交给 Agent 处理全部 ${actionableTasks.length} 条`;
  const process = element('button', 'task-process-all', buttonText);
  process.type = 'button';
  process.dataset.processAll = '';
  process.disabled = actionableTasks.length === 0 || activeRun;
  process.setAttribute('aria-busy', String(activeRun));
  applyPill(process, { variant:'primary', size:'md', kind:'action' });
  const note = element('p', 'task-process-note');
  note.dataset.processNote = '';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const confirmationMessage = needsConfirmationCount > 0
    ? `${needsConfirmationCount} 条任务因修改目标定位不唯一而暂停，补充说明后可重新提交。`
    : '';
  const targetMissingMessage = targetMissingCount > 0
    ? `${targetMissingCount} 条任务的页面已删除；请删除任务记录或撤销删页。`
    : '';
  note.textContent = [runMessage(agentRun), targetMissingMessage, confirmationMessage]
    .filter(Boolean).join('；');
  if (needsConfirmationCount > 0 || targetMissingCount > 0) note.dataset.attention = '';
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
