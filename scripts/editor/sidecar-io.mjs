import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'sidecar_io.py');
const ATTACHMENT_MUTATION_COMMANDS = new Set([
  'publish-attachments',
  'discard-attachment-upload',
  'delete-task-attachments',
  'reconcile-attachments',
]);
const ATTACHMENT_LONG_COMMANDS = new Set([
  ...ATTACHMENT_MUTATION_COMMANDS,
  'verify-task-attachments',
]);
// 最坏 8×25MiB 需要前后两轮 SHA-256 和 fsync；90s 允许约 5MiB/s 的保守吞吐。
const DEFAULT_ATTACHMENT_TIMEOUT_MS = 90_000;
const MAX_ATTACHMENT_TIMEOUT_MS = 120_000;
const plainIdentity = identity => Object.fromEntries(
  ['path', 'realPath', 'dev', 'ino'].map(key => [key, identity[key]]),
);

function helperError(payload) {
  return Object.assign(new Error(payload?.message ?? '可信 sidecar I/O 失败'), {
    code:payload?.code ?? 'UNSAFE_SIDECAR_IO',
    statusCode:Number.isInteger(payload?.statusCode) ? payload.statusCode : 500,
    stage:payload?.stage ?? 'sidecar',
    committed:payload?.committed === true,
    commitScope:typeof payload?.commitScope === 'string' ? payload.commitScope : undefined,
    details:payload?.details && typeof payload.details === 'object'
      ? payload.details : undefined,
  });
}

function lifecycleError(code, message) {
  return Object.assign(new Error(message), {
    code, stage:'sidecar-helper', committed:false,
  });
}

function undispatchedLifecycleError(error) {
  return Object.assign(new Error(error?.message ?? 'sidecar 请求未发送'), error, {
    code:error?.code ?? 'SIDECAR_HELPER_CLOSED',
    stage:error?.stage ?? 'sidecar-helper',
    committed:false,
    commitScope:undefined,
  });
}

function activeLifecycleError(error, request) {
  if (!request?.dispatched || !ATTACHMENT_MUTATION_COMMANDS.has(request.command)) {
    return undispatchedLifecycleError(error);
  }
  return Object.assign(new Error(error?.message ?? '附件命令未收到可信 ACK'), error, {
    committed:true,
    commitScope:'attachments',
    cause:error,
  });
}

class PersistentSidecarIO {
  constructor(child, {
    timeoutMs, maxInputBytes, maxOutputBytes,
    maxSessionInputBytes, maxSessionOutputBytes, attachmentTimeoutMs,
  }) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.maxInputBytes = maxInputBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.maxSessionInputBytes = maxSessionInputBytes;
    this.maxSessionOutputBytes = maxSessionOutputBytes;
    this.attachmentTimeoutMs = Math.min(
      attachmentTimeoutMs, MAX_ATTACHMENT_TIMEOUT_MS,
    );
    this.queue = [];
    this.active = null;
    this.stdout = '';
    this.stderr = '';
    this.closed = false;
    this.finished = false;
    this.aborting = false;
    this.reapTimer = null;
    this.closePromise = new Promise(resolve => { this.resolveClosed = resolve; });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onStdout(String(chunk)));
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-this.maxOutputBytes);
    });
    child.stdin.on('error', error => this.#abort(error));
    child.once('error', error => this.#finish(error));
    child.once('close', () => this.#finish());
  }

  #finish(error = lifecycleError('SIDECAR_HELPER_CLOSED', 'sidecar helper 已关闭')) {
    if (this.finished) return;
    this.finished = true;
    this.aborting = true;
    clearTimeout(this.reapTimer);
    this.#failAll(error);
    this.resolveClosed();
  }

  #failAll(error) {
    const active = this.active;
    this.active = null;
    if (active && !active.settled) {
      active.settled = true;
      active.state = 'settled';
      clearTimeout(active.timer);
      active.reject(activeLifecycleError(error, active));
      for (const resolve of active.waiters) resolve();
      active.waiters.clear();
    }
    this.#rejectQueued(error);
  }

  #rejectQueued(error) {
    for (const request of this.queue.splice(0)) {
      if (request.settled) continue;
      request.settled = true;
      request.state = 'settled';
      request.reject(undispatchedLifecycleError(error));
      for (const resolve of request.waiters) resolve();
      request.waiters.clear();
    }
  }

  #waitForRequest(request) {
    if (request.settled) return Promise.resolve();
    return new Promise(resolve => request.waiters.add(resolve));
  }

  #abort(error) {
    if (this.finished || this.aborting) return;
    this.aborting = true;
    this.#failAll(error);
    this.child.kill?.('SIGKILL');
    clearTimeout(this.reapTimer);
    this.reapTimer = setTimeout(() => this.#finish(error), 20);
    this.reapTimer.unref?.();
  }

  #onStdout(chunk) {
    if (this.finished || this.aborting) return;
    this.stdout += chunk;
    const activeLimit = this.active?.command === 'read-session'
      ? this.maxSessionOutputBytes : this.maxOutputBytes;
    if (Buffer.byteLength(this.stdout) > activeLimit) {
      this.#abort(lifecycleError(
        'SIDECAR_HELPER_OUTPUT_LIMIT', 'sidecar helper 输出超过上限',
      ));
      return;
    }
    let newline;
    while ((newline = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); }
      catch {
        this.#abort(lifecycleError('SIDECAR_HELPER_PROTOCOL', 'sidecar helper 返回无效 JSONL'));
        return;
      }
      const active = this.active;
      if (!active || response?.id !== active.id) {
        this.#abort(lifecycleError(
          'SIDECAR_HELPER_PROTOCOL', 'sidecar helper 返回非活动请求的 response ID',
        ));
        return;
      }
      const responseLimit = active.command === 'read-session'
        ? this.maxSessionOutputBytes : this.maxOutputBytes;
      if (Buffer.byteLength(line) > responseLimit) {
        this.#abort(lifecycleError(
          'SIDECAR_HELPER_OUTPUT_LIMIT', 'sidecar helper 命令输出超过上限',
        ));
        return;
      }
      this.#settleActive(
        active,
        response.ok === true ? { result:response.result } : { error:helperError(response) },
      );
    }
  }

  #settleActive(request, { result, error }) {
    if (this.active !== request || request.settled) return;
    this.active = null;
    request.settled = true;
    request.state = 'settled';
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result);
    for (const resolve of request.waiters) resolve();
    request.waiters.clear();
    this.#dispatchNext();
  }

  #dispatchNext() {
    if (this.active || this.closed || this.finished || this.aborting) return;
    const request = this.queue.shift();
    if (!request) return;
    this.active = request;
    request.state = 'dispatching';
    let writeReturned = false;
    let synchronousCallbackError;
    const onWrite = error => {
      if (!error || request.settled) return;
      if (!writeReturned) {
        synchronousCallbackError = error;
        return;
      }
      if (this.active === request) this.#abort(error);
    };
    try {
      this.child.stdin.write(request.line, onWrite);
      writeReturned = true;
      if (synchronousCallbackError) throw synchronousCallbackError;
    } catch (error) {
      writeReturned = true;
      if (!request.settled && this.active === request) {
        this.active = null;
        request.settled = true;
        request.state = 'settled';
        request.reject(undispatchedLifecycleError(error));
        for (const resolve of request.waiters) resolve();
        request.waiters.clear();
      }
      this.#abort(error);
      return;
    }
    if (request.settled || this.active !== request) return;
    request.dispatched = true;
    request.state = 'active';
    const requestTimeoutMs = ATTACHMENT_LONG_COMMANDS.has(request.command)
      ? this.attachmentTimeoutMs : this.timeoutMs;
    request.timer = setTimeout(() => {
      if (this.active !== request || request.settled) return;
      this.#abort(lifecycleError('SIDECAR_HELPER_TIMEOUT', 'sidecar helper 请求超时'));
    }, requestTimeoutMs);
    request.timer.unref?.();
  }

  #request(command, payload) {
    if (this.closed || this.finished) {
      return Promise.reject(lifecycleError('SIDECAR_HELPER_CLOSED', 'sidecar helper 已关闭'));
    }
    const id = randomUUID();
    let line;
    try {
      line = `${JSON.stringify({ id, command, payload })}\n`;
    } catch (error) {
      return Promise.reject(undispatchedLifecycleError(Object.assign(
        lifecycleError('SIDECAR_HELPER_SERIALIZE', 'sidecar helper 请求序列化失败'),
        { cause:error },
      )));
    }
    const inputLimit = command === 'write-session'
      ? this.maxSessionInputBytes : this.maxInputBytes;
    if (Buffer.byteLength(line) > inputLimit) {
      const error = lifecycleError(
        'SIDECAR_HELPER_INPUT_LIMIT', 'sidecar helper 输入超过上限',
      );
      return Promise.reject(undispatchedLifecycleError(error));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        id, command, line, resolve, reject,
        state:'queued', dispatched:false, settled:false, timer:null,
        waiters:new Set(),
      });
      this.#dispatchNext();
    });
  }

  initialize(payload) { return this.#request('initialize', payload); }
  ensureRoot() { return this.#request('ensure-root', {}); }
  discover({ deckName }) { return this.#request('discover', { deckName }); }
  inspectLegacy({ deckName, currentFingerprint }) {
    return this.#request('inspect-legacy', { deckName, currentFingerprint });
  }
  prepareSession({ deckName, sessionId, initialFingerprint, sessionName, mode }) {
    return this.#request('prepare-session', {
      deckName, sessionId, initialFingerprint, sessionName, mode,
    });
  }
  activateSession({ sessionId }) {
    return this.#request('activate-session', { sessionId });
  }
  bindSession({ deckName, sessionId, sessionName, create=false }) {
    return this.#request('bind-session', { deckName, sessionId, sessionName, create });
  }
  bindAttachments() { return this.#request('bind-attachments', {}); }
  readSession({ missingOk=false } = {}) {
    return this.#request('read-session', { missingOk });
  }
  assertBound() { return this.#request('assert-bound', {}); }
  publishAttachments(payload) { return this.#request('publish-attachments', payload); }
  discardAttachmentUpload({ uploadId, uploadIdentity, files }) {
    return this.#request('discard-attachment-upload', {
      uploadId, uploadIdentity, files,
    });
  }
  deleteTaskAttachments({ taskId }) {
    return this.#request('delete-task-attachments', { taskId });
  }
  verifyTaskAttachments({ taskId, files }) {
    return this.#request('verify-task-attachments', { taskId, files });
  }
  reconcileAttachments({ referencedTaskIds }) {
    return this.#request('reconcile-attachments', { referencedTaskIds });
  }
  readTransaction({ transactionId }) {
    return this.#request('read-transaction', { transactionId });
  }
  listTransactions() { return this.#request('list-transactions', {}); }
  verifyBackup({ backupName, expectedFingerprint }) {
    return this.#request('verify-backup', { backupName, expectedFingerprint });
  }
  hashDeck() { return this.#request('hash-deck', {}); }
  writeSession({ sessionId, bytes }) {
    return this.#request('write-session', {
      sessionId, bytes:Buffer.from(bytes).toString('base64'),
    });
  }
  writeSnapshot({ snapshotId, bytes }) {
    return this.#request('write-snapshot', {
      snapshotId, bytes:Buffer.from(bytes).toString('base64'),
    });
  }
  deleteSnapshot({ snapshotId }) {
    return this.#request('delete-snapshot', { snapshotId });
  }
  deleteTransaction({ transactionId }) {
    return this.#request('delete-transaction', { transactionId });
  }
  pruneTransactions({ maximum=32 } = {}) {
    return this.#request('prune-transactions', { maximum });
  }
  restoreDeck({ backupName, oldFingerprint, candidateFingerprint }) {
    return this.#request('restore-deck', {
      backupName, oldFingerprint, candidateFingerprint,
    });
  }

  async close() {
    if (this.closed) return this.closePromise;
    this.closed = true;
    const error = lifecycleError('SIDECAR_HELPER_CLOSED', 'sidecar helper 已关闭');
    this.#rejectQueued(error);
    const active = this.active;
    if (
      active?.dispatched
      && ATTACHMENT_MUTATION_COMMANDS.has(active.command)
    ) {
      await this.#waitForRequest(active);
    }
    if (!this.finished) {
      this.#abort(error);
    }
    await this.closePromise;
  }
}

export async function createPersistentSidecarIO({
  project,
  root,
  spawnHelper=spawn,
  timeoutMs=1_000,
  maxInputBytes=1024 * 1024,
  maxOutputBytes=1024 * 1024,
  maxSessionInputBytes=64 * 1024 * 1024,
  maxSessionOutputBytes=64 * 1024 * 1024,
  attachmentTimeoutMs=DEFAULT_ATTACHMENT_TIMEOUT_MS,
  skipReadyHandshake=false,
} = {}) {
  const child = spawnHelper('python3', ['-u', HELPER, '--serve'], {
    stdio:['pipe', 'pipe', 'pipe'],
  });
  const io = new PersistentSidecarIO(child, {
    timeoutMs, maxInputBytes, maxOutputBytes,
    maxSessionInputBytes, maxSessionOutputBytes, attachmentTimeoutMs,
  });
  if (!skipReadyHandshake) {
    try { await io.initialize(root ? { project:plainIdentity(project), root:plainIdentity(root) } : {
      project:plainIdentity(project),
    }); }
    catch (error) { await io.close(); throw error; }
  }
  return io;
}

// 仅供不经过 server 的 SessionStore 单元使用；生产服务始终注入 dirfd helper。
export const localDurableIO = {
  async atomicWrite({ directory, name, bytes, commitScope }) {
    const path = join(directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    let renamed = false;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path);
      renamed = true;
      const parent = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      throw Object.assign(error, {
        code:`${String(commitScope ?? 'sidecar').toUpperCase()}_WRITE_FAILED`,
        stage:renamed ? `${commitScope}-directory-fsync` : `${commitScope}-write`,
        committed:renamed,
        commitScope,
      });
    } finally {
      await handle?.close();
      await unlink(temporary).catch(() => {});
    }
  },
  async unlink({ directory, name }) {
    await unlink(join(directory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    const parent = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try { await parent.sync(); } finally { await parent.close(); }
  },
};
