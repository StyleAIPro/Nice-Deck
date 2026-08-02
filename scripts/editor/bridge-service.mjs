import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PatchJournal } from './patch-journal.mjs';
import { hasCanonicalValues, validateAction } from './protocol.mjs';
import { RevisionConflict } from './session-store.mjs';

function serviceError(code, statusCode, message = code, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
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
    this.socketWaiters = new Set();
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
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(socket);
    }
    this.socketWaiters.clear();
  }
  hasEditorSocket() { return this.editorSocket?.readyState === 1; }

  clearEditorSocket(socket) {
    if (this.editorSocket === socket) this.editorSocket = null;
    for (const [commandId, pending] of this.pending) {
      if (pending.socket === socket) {
        this.#settle(commandId, 'reject', serviceError('EDITOR_OFFLINE', 409, '编辑器连接已断开'));
      }
    }
  }

  handleMessage(socket, data) {
    let message;
    try { message = JSON.parse(String(data)); } catch { return false; }
    if (typeof message?.commandId !== 'string') return false;
    const pending = this.pending.get(message.commandId);
    if (!pending || pending.socket !== socket) return false;
    if (message.type === 'actions-rejected' && pending.expectedType === 'actions-prepared') {
      const allowed = new Set(['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS', 'INVALID_ACTION']);
      const code = allowed.has(message.code) ? message.code : 'ACTION_REJECTED';
      this.#settle(message.commandId, 'reject', serviceError(
        code, 409, '编辑器拒绝动作批次', {
          failedActionId: message.failedActionId,
          candidates: Array.isArray(message.candidates) ? message.candidates.slice(0, 5) : [],
        },
      ));
      return true;
    }
    if (message.type !== pending.expectedType) {
      if (message.type === 'actions-applied') {
        this.#settle(message.commandId, 'reject', serviceError(
          'INVALID_ACTION_ACK', 502, '旧版 count-only ACK 不支持事务提交',
        ));
        return true;
      }
      return false;
    }
    if (message.type === 'actions-prepared') {
      if (!Number.isSafeInteger(message.applied)
        || message.applied !== pending.actions.length
        || !this.#validCanonicalResults(pending.actions, message.results)) {
        this.#settle(message.commandId, 'reject', serviceError(
          'INVALID_ACTION_ACK', 502, '编辑器 prepared canonical 回执无效',
        ));
      } else {
        this.#settle(message.commandId, 'resolve', {
          commandId: message.commandId, applied: message.applied, results: message.results,
        });
      }
      return true;
    }
    const booleanFields = {
      'actions-committed': 'committed',
      'actions-rolled-back': 'rolledBack',
    };
    const field = booleanFields[message.type];
    if (field && typeof message[field] !== 'boolean') {
      this.#settle(message.commandId, 'reject', serviceError('INVALID_ACTION_ACK', 502));
    } else {
      this.#settle(message.commandId, 'resolve', message);
    }
    return true;
  }

  createTask(input, expectedRevision) {
    return this.#enqueue(async () => {
      if (this.closed) throw serviceError('SERVICE_CLOSED', 503, '服务已关闭');
      const state = this.sessionStore.state;
      const snapshot = { revision: state.revision, tasks: structuredClone(state.tasks ?? []) };
      try { return await this.sessionStore.createTask(input, expectedRevision); }
      catch (error) {
        state.revision = snapshot.revision;
        state.tasks = snapshot.tasks;
        await unlink(`${this.sessionStore.sessionPath}.tmp`).catch(() => {});
        throw error;
      }
    });
  }

  applyActions({ taskId, actions, expectedRevision }) {
    return this.#enqueue(async () => {
      const prepared = await this.#prepare(actions, expectedRevision);
      let group;
      try {
        group = await this.#commitJournal(journal => journal.appendGroup(taskId, prepared.results));
      } catch {
        await this.#rollbackOrSync(prepared.commandId);
        throw serviceError('JOURNAL_PERSIST_FAILED', 500, '动作日志持久化失败，浏览器修改已回滚');
      }
      const result = { groupId: group.id, revision: this.sessionStore.state.revision, applied: prepared.applied };
      const confirmation = await this.#finalizeCommitted(prepared.commandId, result);
      return { ...result, ...confirmation };
    });
  }

  undoGroup(groupId, expectedRevision) { return this.#changeGroup('undo', groupId, expectedRevision); }
  redoGroup(groupId, expectedRevision) { return this.#changeGroup('redo', groupId, expectedRevision); }
  compiledActions() { return this.journal.compile(); }

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
    for (const commandId of [...this.pending.keys()]) this.#settle(commandId, 'reject', error);
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.socketWaiters.clear();
  }

  #enqueue(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async #changeGroup(method, groupId, expectedRevision) {
    return this.#enqueue(async () => {
      this.assertRevision(expectedRevision);
      const draftState = copyJournalState(this.sessionStore.state);
      const draft = new PatchJournal(draftState);
      try { draft[method](groupId); }
      catch { throw serviceError('GROUP_NOT_FOUND', 404, '找不到动作组'); }
      const actions = draft.compile();
      const prepared = await this.#prepare(actions, expectedRevision, { replace:true });
      try {
        await this.#commitJournal(() => {
          this.sessionStore.state.groups = draftState.groups;
          this.sessionStore.state.redo = draftState.redo;
          return { id: groupId };
        });
      } catch {
        await this.#rollbackOrSync(prepared.commandId);
        throw serviceError('JOURNAL_PERSIST_FAILED', 500, '动作日志持久化失败，浏览器修改已回滚');
      }
      const result = { groupId, revision: this.sessionStore.state.revision, applied: prepared.applied };
      const confirmation = await this.#finalizeCommitted(prepared.commandId, result);
      return { ...result, ...confirmation };
    });
  }

  async #prepare(actions, expectedRevision, { replace=false } = {}) {
    if (this.closed) throw serviceError('SERVICE_CLOSED', 503, '服务已关闭');
    this.assertRevision(expectedRevision);
    const commandId = randomUUID();
    try {
      return await this.#send(
        commandId, { type:'apply-actions', commandId, actions, tentative:true, replace },
        { expectedType:'actions-prepared', actions },
      );
    } catch (error) {
      if (['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS',
        'INVALID_ACTION', 'ACTION_REJECTED', 'EDITOR_OFFLINE',
        'SERVICE_CLOSED', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      await this.#rollbackOrSync(commandId).catch(syncError => { throw syncError; });
      throw error;
    }
  }

  async #finalizeCommitted(commandId, committedResult) {
    try {
      const result = await this.#send(
        commandId, { type:'commit-actions', commandId },
        { expectedType:'actions-committed' },
      );
      if (result.committed !== true) throw serviceError('INVALID_ACTION_ACK', 502);
      return { commitConfirmed:true, recoveredBySync:false };
    } catch {
      try { await this.#forceSync(); }
      catch {
        throw serviceError(
          'EDITOR_SYNC_REQUIRED', 503, '动作已保存，编辑器同步待确认',
          { committed:true, commitConfirmed:false, recoveredBySync:false, ...committedResult },
        );
      }
      return { commitConfirmed:false, recoveredBySync:true };
    }
  }

  async #rollbackOrSync(commandId) {
    try {
      const result = await this.#send(
        commandId, { type:'rollback-actions', commandId },
        { expectedType:'actions-rolled-back' },
      );
      if (result.rolledBack !== true) throw serviceError('INVALID_ACTION_ACK', 502);
      return;
    } catch {
      try { await this.#forceSync(); }
      catch {
        throw serviceError('EDITOR_SYNC_REQUIRED', 503, '无法确认浏览器回滚，请重连以恢复 sidecar 权威状态');
      }
    }
  }

  async #forceSync() {
    await this.#waitForEditorSocket();
    const commandId = randomUUID();
    await this.#send(
      commandId,
      { type:'sync-actions', commandId, actions:this.compiledActions() },
      { expectedType:'actions-synced' },
    );
  }

  #waitForEditorSocket() {
    if (this.closed) return Promise.reject(serviceError('SERVICE_CLOSED', 503, '服务已关闭'));
    if (this.hasEditorSocket()) return Promise.resolve(this.editorSocket);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer:null };
      waiter.timer = setTimeout(() => {
        this.socketWaiters.delete(waiter);
        reject(serviceError('EDITOR_OFFLINE', 409, '等待编辑器重连超时'));
      }, this.timeoutMs);
      waiter.timer.unref?.();
      this.socketWaiters.add(waiter);
    });
  }

  #send(commandId, message, { expectedType, actions = [] }) {
    const socket = this.editorSocket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(serviceError('EDITOR_OFFLINE', 409, '编辑器未连接'));
    }
    const acknowledgement = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(commandId, 'reject', serviceError('COMMAND_TIMEOUT', 504, '编辑器动作回执超时'));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(commandId, { resolve, reject, timer, socket, expectedType, actions });
    });
    try { socket.send(JSON.stringify(message)); }
    catch (error) { this.#settle(commandId, 'reject', error); }
    return acknowledgement;
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

  #validCanonicalResults(requested, results) {
    if (!Array.isArray(results) || results.length !== requested.length) return false;
    return results.every((result, index) => {
      const source = requested[index];
      try { validateAction(result); } catch { return false; }
      return result.id === source.id
        && result.kind === source.kind
        && isDeepStrictEqual(result.target, source.target)
        && isDeepStrictEqual(result.payload, source.payload)
        && hasCanonicalValues(result);
    });
  }
}
