import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { PatchJournal } from './patch-journal.mjs';
import { RevisionConflict } from './session-store.mjs';

function serviceError(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

function copyJournalState(state) {
  return {
    groups: structuredClone(state.groups ?? []),
    redo: structuredClone(state.redo ?? []),
  };
}

export class BridgeService {
  constructor({ sessionStore, timeoutMs = 10_000 }) {
    this.sessionStore = sessionStore;
    this.timeoutMs = timeoutMs;
    this.editorSocket = null;
    this.pending = new Map();
    this.journal = new PatchJournal(sessionStore.state);
    this.closed = false;
    this.mutationQueue = Promise.resolve();
  }

  assertRevision(expectedRevision) {
    if (expectedRevision !== this.sessionStore.state.revision) {
      throw new RevisionConflict(
        `版本号 ${expectedRevision} 与当前版本 ${this.sessionStore.state.revision} 不一致`,
      );
    }
  }

  setEditorSocket(socket) {
    this.editorSocket = socket;
  }

  hasEditorSocket() {
    return this.editorSocket?.readyState === 1;
  }

  clearEditorSocket(socket) {
    if (this.editorSocket === socket) this.editorSocket = null;
    for (const [commandId, pending] of this.pending) {
      if (pending.socket === socket) {
        this.#settle(commandId, 'reject', serviceError('EDITOR_OFFLINE', 409));
      }
    }
  }

  handleMessage(socket, data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return false;
    }
    if (message?.type !== 'actions-applied' || typeof message.commandId !== 'string') {
      return false;
    }
    const pending = this.pending.get(message.commandId);
    if (!pending || pending.socket !== socket) return false;
    if (!Number.isSafeInteger(message.applied)
      || message.applied < 0
      || message.applied !== pending.expectedActionCount) {
      this.#settle(
        message.commandId,
        'reject',
        serviceError('INVALID_ACTION_ACK', 502, '编辑器动作回执计数无效'),
      );
      return true;
    }
    this.#settle(message.commandId, 'resolve', message.applied);
    return true;
  }

  waitFor(commandId, socket, expectedActionCount) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(
          commandId,
          'reject',
          serviceError('COMMAND_TIMEOUT', 504, '编辑器动作回执超时'),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(commandId, {
        resolve,
        reject,
        timer,
        socket,
        expectedActionCount,
      });
    });
  }

  async requestApply(actions, expectedRevision) {
    if (this.closed) throw serviceError('SERVICE_CLOSED', 503, '服务已关闭');
    const socket = this.editorSocket;
    if (!socket || socket.readyState !== 1) {
      throw serviceError('EDITOR_OFFLINE', 409, '编辑器未连接');
    }
    this.assertRevision(expectedRevision);
    const commandId = randomUUID();
    const acknowledgement = this.waitFor(commandId, socket, actions.length);
    try {
      socket.send(JSON.stringify({ type: 'apply-actions', commandId, actions }));
    } catch (error) {
      this.#settle(commandId, 'reject', error);
    }
    return await acknowledgement;
  }

  createTask(input, expectedRevision) {
    return this.#enqueue(async () => {
      if (this.closed) throw serviceError('SERVICE_CLOSED', 503, '服务已关闭');
      const state = this.sessionStore.state;
      const snapshot = {
        revision: state.revision,
        tasks: structuredClone(state.tasks ?? []),
      };
      try {
        return await this.sessionStore.createTask(input, expectedRevision);
      } catch (error) {
        state.revision = snapshot.revision;
        state.tasks = snapshot.tasks;
        await unlink(`${this.sessionStore.sessionPath}.tmp`).catch(() => {});
        throw error;
      }
    });
  }

  applyActions({ taskId, actions, expectedRevision }) {
    return this.#enqueue(async () => {
      const applied = await this.requestApply(actions, expectedRevision);
      const group = await this.#commitJournal(journal => journal.appendGroup(taskId, actions));
      return { groupId: group.id, revision: this.sessionStore.state.revision, applied };
    });
  }

  undoGroup(groupId, expectedRevision) {
    return this.#changeGroup('undo', groupId, expectedRevision);
  }

  redoGroup(groupId, expectedRevision) {
    return this.#changeGroup('redo', groupId, expectedRevision);
  }

  compiledActions() {
    return this.journal.compile();
  }

  writeDeck(expectedRevision, writer) {
    return this.#enqueue(async () => {
      if (this.closed) throw serviceError('SERVICE_CLOSED', 503, '服务已关闭');
      this.assertRevision(expectedRevision);
      return await writer(this.compiledActions());
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.editorSocket = null;
    const error = serviceError('SERVICE_CLOSED', 503, '服务已关闭');
    for (const commandId of [...this.pending.keys()]) {
      this.#settle(commandId, 'reject', error);
    }
  }

  #enqueue(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async #changeGroup(method, groupId, expectedRevision) {
    return this.#enqueue(async () => {
      if (this.closed) throw serviceError('SERVICE_CLOSED', 503, '服务已关闭');
      if (!this.editorSocket || this.editorSocket.readyState !== 1) {
        throw serviceError('EDITOR_OFFLINE', 409, '编辑器未连接');
      }
      this.assertRevision(expectedRevision);
      const draftState = copyJournalState(this.sessionStore.state);
      const draft = new PatchJournal(draftState);
      let actions;
      try {
        actions = draft[method](groupId);
      } catch {
        throw serviceError('GROUP_NOT_FOUND', 404, '找不到动作组');
      }
      const applied = await this.requestApply(actions, expectedRevision);
      await this.#commitJournal(() => {
        this.sessionStore.state.groups = draftState.groups;
        this.sessionStore.state.redo = draftState.redo;
        return { id: groupId };
      });
      return { groupId, revision: this.sessionStore.state.revision, applied };
    });
  }

  async #commitJournal(change) {
    const state = this.sessionStore.state;
    const snapshot = {
      revision: state.revision,
      groups: structuredClone(state.groups ?? []),
      redo: structuredClone(state.redo ?? []),
    };
    const result = change(this.journal);
    state.revision += 1;
    const temporaryPath = `${this.sessionStore.sessionPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(state, null, 2));
      await rename(temporaryPath, this.sessionStore.sessionPath);
      this.journal = new PatchJournal(state);
      return result;
    } catch (error) {
      state.revision = snapshot.revision;
      state.groups = snapshot.groups;
      state.redo = snapshot.redo;
      this.journal = new PatchJournal(state);
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  #settle(commandId, method, value) {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    this.pending.delete(commandId);
    clearTimeout(pending.timer);
    pending[method](value);
  }
}
