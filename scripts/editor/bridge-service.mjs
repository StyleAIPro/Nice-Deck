import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PatchJournal } from './patch-journal.mjs';
import { hasCanonicalValues, validateAction } from './protocol.mjs';
import { RevisionConflict } from './session-store.mjs';

function serviceError(code, statusCode, message = code, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

const isCommittedSession = error => error?.committed === true
  && error?.commitScope === 'session';

function copyJournalState(state) {
  return {
    groups: structuredClone(state.groups ?? []),
    redo: structuredClone(state.redo ?? []),
  };
}

function runtimeWriteActions(actions) {
  return actions.map(action => ({
    id:action.id,
    target:structuredClone(action.target),
    kind:action.kind,
    payload:structuredClone(action.payload),
  }));
}

function diagnosticFailure(code, message, details = {}) {
  return serviceError(code, 409, message, {
    stage:'diagnostics',
    recovery:'打开或重连编辑器，等待页面诊断完成后重试',
    ...details,
  });
}

function locatorIdentity(locator) {
  return `${locator.pageKey}\u0000${locator.path}\u0000${locator.tag ?? ''}`;
}

function normalizeDiagnosticPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.pageKey !== 'string' || !value.pageKey) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断缺少稳定 pageKey');
  }
  const finiteNonNegative = number => Number.isFinite(number) && number >= 0;
  if (!finiteNonNegative(value.sectionOverflow?.x)
    || !finiteNonNegative(value.sectionOverflow?.y)
    || !Array.isArray(value.nestedClips)) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断包含无效几何值');
  }
  const seen = new Set();
  const nestedClips = value.nestedClips.map(clip => {
    const locator = clip?.locator;
    if (!locator || locator.pageKey !== value.pageKey
      || typeof locator.path !== 'string' || !locator.path
      || !finiteNonNegative(clip.x) || !finiteNonNegative(clip.y)) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '内层裁切诊断缺少稳定定位器');
    }
    const identity = locatorIdentity(locator);
    if (seen.has(identity)) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '内层裁切诊断定位器重复');
    }
    seen.add(identity);
    return { locator:structuredClone(locator), x:clip.x, y:clip.y };
  });
  return {
    pageKey:value.pageKey,
    sectionOverflow:{ x:value.sectionOverflow.x, y:value.sectionOverflow.y },
    nestedClips,
  };
}

function diagnosticMap(pages, expectedPageKeys) {
  if (!Array.isArray(pages)) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '编辑器未返回页面诊断');
  }
  const normalized = pages.map(normalizeDiagnosticPage);
  const byPage = Object.fromEntries(normalized.map(page => [page.pageKey, page]));
  if (Object.keys(byPage).length !== normalized.length
    || expectedPageKeys.some(pageKey => !byPage[pageKey])
    || Object.keys(byPage).some(pageKey => !expectedPageKeys.includes(pageKey))) {
    throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断与请求范围不一致');
  }
  return byPage;
}

export function compareDiagnostics(baselineByPage, currentByPage, pageKeys) {
  const blockers = [];
  for (const pageKey of pageKeys) {
    const baseline = baselineByPage?.[pageKey];
    const current = currentByPage?.[pageKey];
    if (!baseline || !current) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', `缺少 ${pageKey} 的权威诊断`);
    }
    const sectionDelta = {
      x:Math.max(0, current.sectionOverflow.x - baseline.sectionOverflow.x),
      y:Math.max(0, current.sectionOverflow.y - baseline.sectionOverflow.y),
    };
    if (sectionDelta.x > 0 || sectionDelta.y > 0) {
      blockers.push({ pageKey, kind:'section', ...sectionDelta });
    }
    const baselineClips = new Map(
      baseline.nestedClips.map(clip => [locatorIdentity(clip.locator), clip]),
    );
    for (const clip of current.nestedClips) {
      const previous = baselineClips.get(locatorIdentity(clip.locator));
      if (!previous) {
        blockers.push({
          pageKey, kind:'nested-new', locator:clip.locator, x:clip.x, y:clip.y,
        });
        continue;
      }
      const delta = { x:clip.x - previous.x, y:clip.y - previous.y };
      if (delta.x > 2 || delta.y > 2) {
        blockers.push({
          pageKey, kind:'nested-delta', locator:clip.locator,
          x:Math.max(0, delta.x), y:Math.max(0, delta.y),
        });
      }
    }
  }
  return blockers;
}

export class BridgeService {
  constructor({ sessionStore, timeoutMs = 10_000, beforeSessionPersist = async () => {} }) {
    this.sessionStore = sessionStore;
    this.timeoutMs = timeoutMs;
    this.beforeSessionPersist = beforeSessionPersist;
    this.editorSocket = null;
    this.pending = new Map();
    this.socketWaiters = new Set();
    this.journal = new PatchJournal(sessionStore.state);
    this.closed = false;
    this.mutationQueue = Promise.resolve();
    this.editorReady = false;
    this.editorPageKeys = [];
    this.readyPromise = null;
    this.recoveryRequired = null;
  }

  #recoveryError() {
    return serviceError('RECOVERY_REQUIRED', 503, '存在未完成的 durable transaction，当前服务已冻结为只读', {
      stage:'recovery-required',
      recovery:'停止继续修改并重启编辑服务，让 transaction 按磁盘与 session 状态收敛',
      ...(this.recoveryRequired ?? {}),
    });
  }

  #closedError() {
    return serviceError('SERVICE_CLOSED', 503, '服务已关闭');
  }

  #throwIfClosed() {
    if (this.closed) throw this.#closedError();
  }

  #assertMutable() {
    this.#throwIfClosed();
    if (this.recoveryRequired) throw this.#recoveryError();
  }

  #enterRecoveryRequired(details = {}) {
    if (!this.recoveryRequired) this.recoveryRequired = details;
    return this.#recoveryError();
  }

  #publishSessionCandidate(candidate) {
    const published = this.sessionStore.state;
    const next = structuredClone(candidate);
    for (const key of Object.keys(published)) {
      if (!(key in next)) delete published[key];
    }
    Object.assign(published, next);
    this.journal = new PatchJournal(published);
  }

  async #persistCandidate(candidate, recoveryDetails = {}) {
    try {
      await this.sessionStore.persistState(candidate);
    } catch (error) {
      this.#throwIfClosed();
      if (isCommittedSession(error)) {
        this.#publishSessionCandidate(candidate);
        throw this.#enterRecoveryRequired({
          ...recoveryDetails,
          committed:true,
          commitScope:'session',
          cause:error,
        });
      }
      throw error;
    }
    this.#throwIfClosed();
    this.#publishSessionCandidate(candidate);
    return this.sessionStore.state;
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
    this.editorReady = false;
    this.editorPageKeys = [];
    this.readyPromise = null;
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(socket);
    }
    this.socketWaiters.clear();
  }
  hasEditorSocket() { return this.editorSocket?.readyState === 1; }

  clearEditorSocket(socket) {
    if (this.editorSocket === socket) {
      this.editorSocket = null;
      this.editorReady = false;
      this.editorPageKeys = [];
      this.readyPromise = null;
    }
    for (const [commandId, pending] of this.pending) {
      if (pending.socket === socket) {
        const error = pending.expectedType === 'diagnostics-result'
          ? diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '页面诊断期间编辑器连接已断开')
          : serviceError('EDITOR_OFFLINE', 409, '编辑器连接已断开');
        this.#settle(commandId, 'reject', error);
      }
    }
  }

  handleMessage(socket, data) {
    let message;
    try { message = JSON.parse(String(data)); } catch { return false; }
    if (message?.type === 'deck-ready' && socket === this.editorSocket) {
      if (!Array.isArray(message.pages) || !Array.isArray(message.diagnostics)) return false;
      const pageKeys = message.pages.map(page => page?.pageKey);
      if (pageKeys.some(pageKey => typeof pageKey !== 'string' || !pageKey)
        || new Set(pageKeys).size !== pageKeys.length) return false;
      let baseline;
      try { baseline = diagnosticMap(message.diagnostics, pageKeys); }
      catch { return false; }
      this.editorReady = true;
      this.editorPageKeys = pageKeys;
      this.readyPromise = this.#enqueue(async () => {
        if (this.closed || socket !== this.editorSocket || !this.editorReady) return;
        const state = this.sessionStore.state;
        if (!Object.keys(state.diagnosticsBaseline ?? {}).length) {
          const candidate = {
            ...structuredClone(state),
            diagnosticsBaseline:baseline,
            diagnosticsCurrent:structuredClone(baseline),
            diagnosticsRevision:state.revision,
          };
          try {
            await this.#persistCandidate(candidate, { operation:'diagnostics-baseline' });
          } catch (error) {
            this.#throwIfClosed();
            if (error?.code === 'RECOVERY_REQUIRED') throw error;
            throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '启动诊断基线无法持久化');
          }
        }
      });
      this.readyPromise.catch(() => {});
      return true;
    }
    if (typeof message?.commandId !== 'string') return false;
    const pending = this.pending.get(message.commandId);
    if (!pending || pending.socket !== socket) return false;
    if (message.type === 'diagnostics-rejected'
      && pending.expectedType === 'diagnostics-result') {
      this.#settle(message.commandId, 'reject', diagnosticFailure(
        'DIAGNOSTICS_UNAVAILABLE', '编辑器无法完成页面诊断', { diagnosticCode:message.code },
      ));
      return true;
    }
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
    if (message.type === 'diagnostics-result') {
      try {
        if (message.revision !== pending.revision) {
          throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '诊断 revision 已过期');
        }
        const pages = diagnosticMap(message.pages, pending.pageKeys);
        this.#settle(message.commandId, 'resolve', { revision:message.revision, pages });
      } catch (error) {
        this.#settle(message.commandId, 'reject', error);
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
      this.#assertMutable();
      const state = this.sessionStore.state;
      const snapshot = { revision: state.revision, tasks: structuredClone(state.tasks ?? []) };
      try {
        const result = await this.sessionStore.createTask(input, expectedRevision);
        this.#throwIfClosed();
        return result;
      }
      catch (error) {
        this.#throwIfClosed();
        if (isCommittedSession(error)) {
          throw this.#enterRecoveryRequired({
            operation:'task', committed:true, commitScope:'session', cause:error,
          });
        }
        state.revision = snapshot.revision;
        state.tasks = snapshot.tasks;
        // 仅兼容不具备可信 I/O 接口的最小测试替身；生产 SessionStore 自行清理 dirfd temp。
        if (!this.sessionStore.sidecarIO) {
          await unlink(`${this.sessionStore.sessionPath}.tmp`).catch(() => {});
        }
        throw error;
      }
    });
  }

  applyActions({ taskId, actions, expectedRevision }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      const prepared = await this.#prepare(actions, expectedRevision);
      let group;
      try {
        group = await this.#commitJournal(journal => journal.appendGroup(taskId, prepared.results));
      } catch (error) {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        await this.#rollbackOrSync(prepared.commandId);
        throw serviceError('JOURNAL_PERSIST_FAILED', 500, '动作日志持久化失败，浏览器修改已回滚');
      }
      const result = { groupId: group.id, revision: this.sessionStore.state.revision, applied: prepared.applied };
      const confirmation = await this.#finalizeCommitted(prepared.commandId);
      const diagnosticsPending = await this.#refreshDiagnostics(
        this.#pageKeysForActions(prepared.results), result.revision,
      ).then(() => false, error => {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        return true;
      });
      return { ...result, ...confirmation, diagnosticsPending };
    });
  }

  undoGroup(groupId, expectedRevision) { return this.#changeGroup('undo', groupId, expectedRevision); }
  redoGroup(groupId, expectedRevision) { return this.#changeGroup('redo', groupId, expectedRevision); }
  compiledActions() { return this.journal.compile(); }

  writeDeck(expectedRevision, {
    fingerprint, writer, restore, finalize = async () => {},
  }) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.assertRevision(expectedRevision);
      if (!this.hasEditorSocket() || !this.editorReady) {
        throw diagnosticFailure('EDITOR_OFFLINE', '编辑器未连接或页面尚未就绪');
      }
      await this.readyPromise;
      this.#throwIfClosed();
      const state = this.sessionStore.state;
      let diskFingerprint;
      try {
        diskFingerprint = await fingerprint();
        this.#throwIfClosed();
      } catch (error) {
        this.#throwIfClosed();
        const actualFingerprint = `unavailable:${error.code ?? 'READ_ERROR'}`;
        const conflictCreated = await this.#recordDeckConflict(actualFingerprint);
        throw serviceError('DECK_CHANGED', 409, '无法读取磁盘 Deck，拒绝写回', {
          stage:'fingerprint',
          recovery:'恢复或重新载入 Deck 文件后重试',
          expectedFingerprint:state.deckFingerprint,
          actualFingerprint,
          conflictCreated,
        });
      }
      if (state.conflict?.code === 'DECK_CHANGED' || diskFingerprint !== state.deckFingerprint) {
        const conflictCreated = await this.#recordDeckConflict(diskFingerprint);
        throw serviceError('DECK_CHANGED', 409, '磁盘 Deck 已被外部修改，拒绝覆盖', {
          stage:'fingerprint',
          recovery:'重新载入外部文件并在新基线上重放补丁，或另存为副本',
          expectedFingerprint:state.deckFingerprint,
          actualFingerprint:diskFingerprint,
          conflictCreated,
        });
      }
      if (!Object.keys(state.diagnosticsBaseline ?? {}).length) {
        throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '会话缺少启动诊断基线');
      }
      const pageKeys = this.#modifiedPageKeys();
      const authoritativeKeys = pageKeys.length ? pageKeys : Object.keys(state.diagnosticsBaseline);
      const current = await this.#diagnose(authoritativeKeys, state.revision);
      this.#throwIfClosed();
      const blockers = compareDiagnostics(state.diagnosticsBaseline, current, authoritativeKeys);
      if (blockers.length) {
        throw serviceError('NEW_OVERFLOW', 409, '修改引入了新的页面或内层溢出', {
          stage:'overflow',
          recovery:'撤销或修复造成溢出的动作后重试',
          blockers,
        });
      }
      let result;
      try {
        result = await writer(runtimeWriteActions(this.compiledActions()), diskFingerprint);
        this.#throwIfClosed();
      } catch (error) {
        this.#throwIfClosed();
        if (['DECK_CHANGED', 'RESTORE_CONFLICT'].includes(error?.code)
          && typeof error?.actualFingerprint === 'string') {
          error.conflictCreated = await this.#recordDeckConflict(error.actualFingerprint);
          try { await finalize(error); }
          catch (finalizeError) {
            throw this.#enterRecoveryRequired({
              backup:error.backup,
              cause:finalizeError,
            });
          }
        }
        throw error;
      }
      try {
        await this.beforeSessionPersist(result);
        this.#throwIfClosed();
      }
      catch (error) {
        this.#throwIfClosed();
        throw this.#enterRecoveryRequired({
          backup:result.backup,
          cause:error,
        });
      }
      const snapshot = {
        deckFingerprint:state.deckFingerprint,
      };
      const candidate = {
        ...structuredClone(state),
        deckFingerprint:result.fingerprint,
        conflict:null,
        diagnosticsBaseline:{
          ...structuredClone(state.diagnosticsBaseline),
          ...structuredClone(current),
        },
        diagnosticsCurrent:{
          ...structuredClone(state.diagnosticsCurrent),
          ...structuredClone(current),
        },
        diagnosticsRevision:state.revision,
      };
      try {
        await this.#persistCandidate(candidate, {
          operation:'write-deck', backup:result.backup,
        });
      } catch (error) {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        try {
          await restore(result, snapshot.deckFingerprint);
        } catch (restoreError) {
          this.#throwIfClosed();
          throw this.#enterRecoveryRequired({
            backup:result.backup,
            committed:true,
            cause:restoreError,
          });
        }
        try { await finalize(result); }
        catch (finalizeError) {
          this.#throwIfClosed();
          throw this.#enterRecoveryRequired({
            backup:result.backup,
            cause:finalizeError,
          });
        }
        throw serviceError('WRITE_FAILED', 500, '会话基线更新失败，Deck 已恢复且事务已安全清理', {
          stage:'session',
          recovery:'检查 sidecar 目录权限后重试',
          backup:result.backup,
          cause:error,
        });
      }
      try { await finalize(result); }
      catch (error) {
        this.#throwIfClosed();
        throw this.#enterRecoveryRequired({
          backup:result.backup,
          committed:true,
          cause:error,
        });
      }
      return result;
    });
  }

  noteDeckFingerprint(fingerprintOrProvider) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      const fingerprint = typeof fingerprintOrProvider === 'function'
        ? await fingerprintOrProvider()
        : fingerprintOrProvider;
      this.#throwIfClosed();
      if (fingerprint === this.sessionStore.state.deckFingerprint) return false;
      return this.#recordDeckConflict(fingerprint);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.editorSocket = null;
    this.editorReady = false;
    this.editorPageKeys = [];
    this.readyPromise = null;
    const error = serviceError('SERVICE_CLOSED', 503, '服务已关闭');
    for (const commandId of [...this.pending.keys()]) this.#settle(commandId, 'reject', error);
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.socketWaiters.clear();
  }

  #enqueue(operation) {
    const guarded = async () => {
      this.#throwIfClosed();
      try {
        const result = await operation();
        this.#throwIfClosed();
        return result;
      } catch (error) {
        this.#throwIfClosed();
        throw error;
      }
    };
    const result = this.mutationQueue.then(guarded, guarded);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async #changeGroup(method, groupId, expectedRevision) {
    return this.#enqueue(async () => {
      this.#assertMutable();
      this.assertRevision(expectedRevision);
      const draftState = copyJournalState(this.sessionStore.state);
      const draft = new PatchJournal(draftState);
      try { draft[method](groupId); }
      catch { throw serviceError('GROUP_NOT_FOUND', 404, '找不到动作组'); }
      const actions = draft.compile();
      const prepared = await this.#prepare(actions, expectedRevision, { replace:true });
      try {
        await this.#commitJournal(journal => {
          journal.state.groups = structuredClone(draftState.groups);
          journal.state.redo = structuredClone(draftState.redo);
          return { id: groupId };
        });
      } catch (error) {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        await this.#rollbackOrSync(prepared.commandId);
        throw serviceError('JOURNAL_PERSIST_FAILED', 500, '动作日志持久化失败，浏览器修改已回滚');
      }
      const result = { groupId, revision: this.sessionStore.state.revision, applied: prepared.applied };
      const confirmation = await this.#finalizeCommitted(prepared.commandId);
      const changedGroup = draftState.groups.find(group => group.id === groupId);
      const diagnosticsPending = await this.#refreshDiagnostics(
        this.#pageKeysForActions(changedGroup?.actions ?? []), result.revision,
      ).then(() => false, error => {
        this.#throwIfClosed();
        if (error?.code === 'RECOVERY_REQUIRED') throw error;
        return true;
      });
      return { ...result, ...confirmation, diagnosticsPending };
    });
  }

  async #prepare(actions, expectedRevision, { replace=false } = {}) {
    this.#throwIfClosed();
    this.assertRevision(expectedRevision);
    const commandId = randomUUID();
    try {
      return await this.#send(
        commandId, { type:'apply-actions', commandId, actions, tentative:true, replace },
        { expectedType:'actions-prepared', actions },
      );
    } catch (error) {
      this.#throwIfClosed();
      if (['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS',
        'INVALID_ACTION', 'ACTION_REJECTED', 'EDITOR_OFFLINE',
        'SERVICE_CLOSED', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      await this.#rollbackOrSync(commandId).catch(syncError => { throw syncError; });
      throw error;
    }
  }

  async #finalizeCommitted(commandId) {
    try {
      const result = await this.#send(
        commandId, { type:'commit-actions', commandId },
        { expectedType:'actions-committed' },
      );
      if (result.committed !== true) throw serviceError('INVALID_ACTION_ACK', 502);
      return { commitConfirmed:true, recoveredBySync:false, syncPending:false };
    } catch (error) {
      this.#throwIfClosed();
      try { await this.#forceSync(); }
      catch (syncError) {
        this.#throwIfClosed();
        return { commitConfirmed:false, recoveredBySync:false, syncPending:true };
      }
      return { commitConfirmed:false, recoveredBySync:true, syncPending:false };
    }
  }

  async #rollbackOrSync(commandId) {
    this.#throwIfClosed();
    try {
      const result = await this.#send(
        commandId, { type:'rollback-actions', commandId },
        { expectedType:'actions-rolled-back' },
      );
      if (result.rolledBack !== true) throw serviceError('INVALID_ACTION_ACK', 502);
      return;
    } catch (error) {
      this.#throwIfClosed();
      try { await this.#forceSync(); }
      catch (syncError) {
        this.#throwIfClosed();
        throw serviceError('EDITOR_SYNC_REQUIRED', 503, '无法确认浏览器回滚，请重连以恢复 sidecar 权威状态');
      }
    }
  }

  async #forceSync() {
    this.#throwIfClosed();
    await this.#waitForEditorSocket();
    const commandId = randomUUID();
    await this.#send(
      commandId,
      { type:'sync-actions', commandId, actions:this.compiledActions() },
      { expectedType:'actions-synced' },
    );
  }

  async #refreshDiagnostics(pageKeys, revision) {
    this.#throwIfClosed();
    if (!pageKeys.length || !this.editorReady) return;
    const pages = await this.#diagnose(pageKeys, revision);
    if (revision !== this.sessionStore.state.revision) return;
    const state = this.sessionStore.state;
    const candidate = {
      ...structuredClone(state),
      diagnosticsCurrent:{
        ...structuredClone(state.diagnosticsCurrent),
        ...pages,
      },
      diagnosticsRevision:revision,
    };
    await this.#persistCandidate(candidate, { operation:'diagnostics-refresh' });
  }

  async #diagnose(pageKeys, revision) {
    this.#throwIfClosed();
    if (!this.hasEditorSocket() || !this.editorReady) {
      throw diagnosticFailure('EDITOR_OFFLINE', '编辑器未连接或页面尚未就绪');
    }
    const uniquePageKeys = [...new Set(pageKeys)];
    if (!uniquePageKeys.length
      || uniquePageKeys.some(pageKey => !this.editorPageKeys.includes(pageKey))) {
      throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '修改页不在当前编辑器页面集合中');
    }
    const commandId = randomUUID();
    try {
      const result = await this.#send(
        commandId,
        { type:'diagnose-pages', commandId, revision, pageKeys:uniquePageKeys },
        { expectedType:'diagnostics-result', revision, pageKeys:uniquePageKeys },
      );
      this.#throwIfClosed();
      return result.pages;
    } catch (error) {
      this.#throwIfClosed();
      if (error?.code === 'DIAGNOSTICS_UNAVAILABLE') throw error;
      if (error?.code === 'COMMAND_TIMEOUT' || error?.code === 'EDITOR_OFFLINE') {
        throw diagnosticFailure('DIAGNOSTICS_UNAVAILABLE', '编辑器未能返回权威页面诊断', {
          diagnosticCode:error.code,
        });
      }
      throw error;
    }
  }

  #pageKeysForActions(actions) {
    return [...new Set(actions.map(action => action?.target?.pageKey).filter(Boolean))];
  }

  #modifiedPageKeys() {
    return this.#pageKeysForActions(
      (this.sessionStore.state.groups ?? []).flatMap(group => group.actions ?? []),
    );
  }

  async #recordDeckConflict(fingerprint) {
    const state = this.sessionStore.state;
    if (state.conflict?.code === 'DECK_CHANGED') return false;
    const candidate = {
      ...structuredClone(state),
      conflict:{
        code:'DECK_CHANGED',
        expectedFingerprint:state.deckFingerprint,
        actualFingerprint:fingerprint,
        detectedAt:new Date().toISOString(),
      },
    };
    try {
      await this.#persistCandidate(candidate, { operation:'deck-conflict' });
      return true;
    } catch (error) {
      this.#throwIfClosed();
      if (error?.code === 'RECOVERY_REQUIRED') throw error;
      throw serviceError('WRITE_FAILED', 500, 'Deck 冲突状态无法持久化', {
        stage:'session',
        recovery:'检查 sidecar 目录权限后重试',
        cause:error,
      });
    }
  }

  #waitForEditorSocket() {
    if (this.closed) return Promise.reject(this.#closedError());
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

  #send(commandId, message, {
    expectedType, actions = [], revision = undefined, pageKeys = [],
  }) {
    if (this.closed) return Promise.reject(this.#closedError());
    const socket = this.editorSocket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(serviceError('EDITOR_OFFLINE', 409, '编辑器未连接'));
    }
    const acknowledgement = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(commandId, 'reject', serviceError('COMMAND_TIMEOUT', 504, '编辑器动作回执超时'));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(commandId, {
        resolve, reject, timer, socket, expectedType, actions, revision, pageKeys,
      });
    });
    try { socket.send(JSON.stringify(message)); }
    catch (error) { this.#settle(commandId, 'reject', error); }
    return acknowledgement;
  }

  async #commitJournal(change) {
    const state = this.sessionStore.state;
    const candidate = structuredClone(state);
    const journal = new PatchJournal(candidate);
    const result = change(journal);
    candidate.revision += 1;
    await this.#persistCandidate(candidate, { operation:'journal' });
    return result;
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
