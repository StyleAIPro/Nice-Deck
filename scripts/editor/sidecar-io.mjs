import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'sidecar_io.py');
const plainIdentity = identity => Object.fromEntries(
  ['path', 'realPath', 'dev', 'ino'].map(key => [key, identity[key]]),
);

function helperError(payload) {
  return Object.assign(new Error(payload?.message ?? '可信 sidecar I/O 失败'), {
    code:'UNSAFE_SIDECAR_IO',
    stage:payload?.stage ?? 'sidecar',
    committed:payload?.committed === true,
  });
}

function lifecycleError(code, message) {
  return Object.assign(new Error(message), { code, stage:'sidecar-helper' });
}

class PersistentSidecarIO {
  constructor(child, { timeoutMs, maxInputBytes, maxOutputBytes }) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.maxInputBytes = maxInputBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.pending = new Map();
    this.stdout = '';
    this.stderr = '';
    this.closed = false;
    this.finished = false;
    this.closePromise = new Promise(resolve => { this.resolveClosed = resolve; });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onStdout(String(chunk)));
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-this.maxOutputBytes);
    });
    child.stdin.on('error', error => this.#failAll(error));
    child.once('error', error => this.#finish(error));
    child.once('close', () => this.#finish());
  }

  #finish(error = lifecycleError('SIDECAR_HELPER_CLOSED', 'sidecar helper 已关闭')) {
    if (this.finished) return;
    this.finished = true;
    this.#failAll(error);
    this.resolveClosed();
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #abort(error) {
    if (this.finished) return;
    this.#failAll(error);
    this.child.kill?.('SIGKILL');
  }

  #onStdout(chunk) {
    if (this.finished) return;
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout) > this.maxOutputBytes) {
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
      const pending = this.pending.get(response?.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok === true) pending.resolve(response.result);
      else pending.reject(helperError(response));
    }
  }

  #request(command, payload) {
    if (this.closed || this.finished) {
      return Promise.reject(lifecycleError('SIDECAR_HELPER_CLOSED', 'sidecar helper 已关闭'));
    }
    const id = randomUUID();
    const line = `${JSON.stringify({ id, command, payload })}\n`;
    if (Buffer.byteLength(line) > this.maxInputBytes) {
      const error = lifecycleError(
        'SIDECAR_HELPER_INPUT_LIMIT', 'sidecar helper 输入超过上限',
      );
      this.#abort(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const error = lifecycleError('SIDECAR_HELPER_TIMEOUT', 'sidecar helper 请求超时');
        reject(error);
        this.#abort(error);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(line);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
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
  bindSession({ deckName, sessionName, create=false }) {
    return this.#request('bind-session', { deckName, sessionName, create });
  }
  readSession({ missingOk=false } = {}) {
    return this.#request('read-session', { missingOk });
  }
  assertBound() { return this.#request('assert-bound', {}); }
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
    if (!this.finished) this.child.kill?.('SIGKILL');
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
  skipReadyHandshake=false,
} = {}) {
  const child = spawnHelper('python3', ['-u', HELPER, '--serve'], {
    stdio:['pipe', 'pipe', 'pipe'],
  });
  const io = new PersistentSidecarIO(child, { timeoutMs, maxInputBytes, maxOutputBytes });
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
  async atomicWrite({ directory, name, bytes }) {
    const path = join(directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
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
      const parent = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await handle?.close();
      await unlink(temporary).catch(() => {});
    }
  },
  async unlink({ directory, name }) {
    await unlink(join(directory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  },
};
