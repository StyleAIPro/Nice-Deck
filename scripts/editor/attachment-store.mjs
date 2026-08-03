import { spawn } from 'node:child_process';
import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  validateAttachmentMetadata,
} from './attachment-protocol.mjs';
import { resolveAttachmentPath } from './attachment-paths.mjs';

const WRITER = join(dirname(fileURLToPath(import.meta.url)), 'attachment_writer.py');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUFFIX = /^\.[a-z0-9]{1,16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = [
  'attachmentId', 'ok', 'path', 'sha256', 'size', 'suffix', 'uploadId',
];
const PUBLISH_RESULT_KEYS = ['id', 'relativePath', 'size'];
const PROBE_TASK_ID = '00000000-0000-4000-8000-000000000000';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 250;
const MAX_OUTPUT_BYTES = 64 * 1024;

function attachmentError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), {
    code, statusCode, stage:details.stage ?? 'attachment-write',
    committed:details.committed === true,
    commitScope:details.commitScope,
    ...details,
  });
}

function abortError(code, message) {
  return attachmentError(code, 503, message, {
    stage:'attachment-abort', committed:false,
  });
}

function exactPlainObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    });
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new TypeError(`${label} 必须是规范小写 UUID v4`);
  }
  return value;
}

function captureIdentity(sidecarBoundary, name) {
  const source = sidecarBoundary?.pythonIdentity?.[name] ?? sidecarBoundary?.[name];
  if (!source || typeof source !== 'object') throw new TypeError(`缺少可信 ${name} identity`);
  const identity = Object.fromEntries(['path', 'dev', 'ino'].map(key => [key, source[key]]));
  if (Object.values(identity).some(value => typeof value !== 'string')) {
    throw new TypeError(`${name} identity 格式无效`);
  }
  if (resolve(identity.path) !== identity.path) throw new TypeError(`${name} identity path 无效`);
  const direct = sidecarBoundary?.[name];
  if (direct && ['path', 'dev', 'ino'].some(key => direct[key] !== identity[key])) {
    throw new TypeError(`${name} identity 与 sidecar boundary 不一致`);
  }
  return Object.freeze(identity);
}

function captureBoundIdentities(sidecarBoundary) {
  if (!sidecarBoundary || typeof sidecarBoundary.guard !== 'function') {
    throw new TypeError('缺少可信 sidecar boundary guard');
  }
  const session = captureIdentity(sidecarBoundary, 'session');
  const attachments = captureIdentity(sidecarBoundary, 'attachments');
  const attachmentStaging = captureIdentity(sidecarBoundary, 'attachmentStaging');
  if (attachments.path !== join(session.path, 'attachments')
    || attachmentStaging.path !== join(attachments.path, '.staging')) {
    throw new TypeError('附件 identity 路径未严格绑定 session');
  }
  if (sidecarBoundary.sessionDir
    && resolve(sidecarBoundary.sessionDir) !== session.path) {
    throw new TypeError('sessionDir 与可信 session identity 不一致');
  }
  return Object.freeze({ session, attachments, attachmentStaging });
}

function normalizeSuffix(suffix, name) {
  if (suffix !== undefined) {
    if (typeof suffix !== 'string' || !SUFFIX.test(suffix)) {
      throw new TypeError('附件扩展名必须是 1–16 位小写字母或数字');
    }
    return suffix;
  }
  const match = typeof name === 'string' ? name.match(/\.([a-z0-9]{1,16})$/i) : null;
  return match ? `.${match[1].toLowerCase()}` : '.bin';
}

function createdAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('附件创建时间无效');
  return date.toISOString();
}

function sanitizeStageMetadata({ id, name, mime, source, suffix, now }) {
  const timestamp = createdAt(now);
  const normalizedSuffix = normalizeSuffix(suffix, name);
  const probe = validateAttachmentMetadata({
    id, name, mime, source, size:1, createdAt:timestamp,
    relativePath:`attachments/${PROBE_TASK_ID}/${id}${normalizedSuffix}`,
  }, PROBE_TASK_ID);
  return {
    id:probe.id,
    name:probe.name,
    mime:probe.mime,
    source:probe.source,
    createdAt:probe.createdAt,
    suffix:normalizedSuffix,
  };
}

function writerErrorFromReceipt(receipt, stderr, exitCode) {
  if (receipt?.ok === false && typeof receipt.code === 'string') {
    const statusCodes = {
      ATTACHMENT_EMPTY:400,
      ATTACHMENT_TOO_LARGE:413,
      ATTACHMENT_BUSY:409,
      ATTACHMENT_CONFIG_INVALID:500,
      UNSAFE_SIDECAR_IO:500,
    };
    return attachmentError(
      receipt.code,
      statusCodes[receipt.code] ?? 500,
      typeof receipt.message === 'string' ? receipt.message : '附件 writer 失败',
      {
        stage:typeof receipt.stage === 'string' ? receipt.stage : 'attachment-write',
        committed:false,
      },
    );
  }
  return attachmentError(
    'ATTACHMENT_WRITE_FAILED', 500,
    stderr.trim() || `附件 writer 退出码 ${exitCode}`,
    { stage:'attachment-writer-exit', committed:false },
  );
}

function parseWriterOutput(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw attachmentError(
      'ATTACHMENT_WRITER_PROTOCOL', 500, '附件 writer 未返回唯一 JSON 回执',
      { stage:'attachment-writer-protocol', committed:false },
    );
  }
  try { return JSON.parse(lines[0]); }
  catch {
    throw attachmentError(
      'ATTACHMENT_WRITER_PROTOCOL', 500, '附件 writer 返回无效 JSON',
      { stage:'attachment-writer-protocol', committed:false },
    );
  }
}

function runWriter({
  stream, config, expectedPath, spawnAttachmentWriter, timeoutMs, killGraceMs,
  register, unregister,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnAttachmentWriter('python3', [
        '-u', WRITER, '--config', JSON.stringify(config),
      ], { stdio:['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      rejectPromise(attachmentError(
        'ATTACHMENT_WRITE_FAILED', 500,
        `无法启动附件 writer：${error?.code ?? error?.message ?? 'spawn failed'}`,
        { stage:'attachment-writer-spawn', committed:false, cause:error },
      ));
      return;
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr
      || typeof child.once !== 'function') {
      rejectPromise(attachmentError(
        'ATTACHMENT_WRITE_FAILED', 500, '附件 writer 子进程接口无效',
        { stage:'attachment-writer-spawn', committed:false },
      ));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let observedBytes = 0;
    let observedSha256;
    let outcome = null;
    let finalized = false;
    let cancelStarted = false;
    let forceTimer;
    let timeout;
    let sourceError;
    let transportError;
    const digest = createHash('sha256');
    let resolveClosed;
    const closed = new Promise(resolveClosedPromise => { resolveClosed = resolveClosedPromise; });
    const hasher = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        observedBytes += bytes.length;
        digest.update(bytes);
        callback(null, bytes);
      },
      flush(callback) {
        observedSha256 = digest.digest('hex');
        callback();
      },
    });

    const absorbLateError = () => {};
    const setOutcome = value => {
      if (outcome === null) outcome = value;
    };
    const cleanup = ({ force=false } = {}) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      stream.removeListener('error', onSourceError);
      child.on('error', absorbLateError);
      child.stdin.on('error', absorbLateError);
      if (force) {
        for (const candidate of [stream, hasher, child.stdin, child.stdout, child.stderr]) {
          try { candidate.destroy?.(); } catch { /* 尽力收敛 */ }
        }
        child.unref?.();
      }
      unregister(record);
      resolveClosed();
      const finalOutcome = outcome ?? { error:attachmentError(
        'ATTACHMENT_WRITE_FAILED', 500, '附件 writer 未返回结果',
        { stage:'attachment-writer-exit', committed:false },
      ) };
      if (finalOutcome.error) rejectPromise(finalOutcome.error);
      else resolvePromise(finalOutcome.value);
    };
    const cancel = error => {
      setOutcome({ error });
      if (cancelStarted || finalized) return;
      cancelStarted = true;
      try { stream.destroy?.(error); } catch { /* 输入流可能已关闭 */ }
      try { child.stdin.destroy?.(error); } catch { /* stdin 可能已关闭 */ }
      try { child.kill?.('SIGKILL'); }
      catch { cleanup({ force:true }); return; }
      forceTimer = setTimeout(() => cleanup({ force:true }), killGraceMs);
      forceTimer.unref?.();
    };
    const onSourceError = error => { sourceError = error; };
    const onStdout = chunk => {
      const text = String(chunk);
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        cancel(attachmentError(
          'ATTACHMENT_WRITER_OUTPUT_LIMIT', 500, '附件 writer stdout 超过 64 KiB',
          { stage:'attachment-writer-protocol', committed:false },
        ));
        return;
      }
      stdout += text;
    };
    const onStderr = chunk => {
      const text = String(chunk);
      stderrBytes += Buffer.byteLength(text);
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += text;
      else stderr = `${stderr}${text}`.slice(-MAX_OUTPUT_BYTES);
    };
    const onChildError = error => {
      cancel(attachmentError(
        'ATTACHMENT_WRITE_FAILED', 500,
        `附件 writer 进程错误：${error?.code ?? error?.message ?? 'process error'}`,
        { stage:'attachment-writer-spawn', committed:false, cause:error },
      ));
    };
    const onChildClose = exitCode => {
      if (outcome === null) {
        if (exitCode !== 0) {
          let receipt;
          try { receipt = parseWriterOutput(stdout); } catch { receipt = null; }
          setOutcome({ error:writerErrorFromReceipt(receipt, stderr, exitCode) });
        } else {
          if (transportError) {
            setOutcome({ error:attachmentError(
              'ATTACHMENT_WRITE_FAILED', 500,
              `写入附件 writer stdin 失败：${transportError?.code
                ?? transportError?.message ?? 'I/O error'}`,
              {
                stage:'attachment-writer-stdin', committed:false,
                cause:transportError,
              },
            ) });
          } else {
            try {
              const receipt = parseWriterOutput(stdout);
              setOutcome({ value:{ receipt, observedBytes, observedSha256 } });
            } catch (error) {
              setOutcome({ error });
            }
          }
        }
      }
      cleanup();
    };
    const record = { child, closed, cancel };
    register(record);
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    stream.once('error', onSourceError);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onChildError);
    child.once('close', onChildClose);
    timeout = setTimeout(() => cancel(attachmentError(
      'ATTACHMENT_WRITER_TIMEOUT', 504, '附件 writer 超时',
      { stage:'attachment-writer-timeout', committed:false },
    )), timeoutMs);
    timeout.unref?.();

    pipeline(stream, hasher, child.stdin).catch(error => {
      if (finalized || cancelStarted) return;
      if (sourceError) {
        cancel(attachmentError(
          'ATTACHMENT_STREAM_ERROR', 400,
          `附件输入流在完成前失败：${sourceError.message ?? 'stream error'}`,
          { stage:'attachment-stream', committed:false, cause:sourceError },
        ));
      } else {
        // writer 可能因空文件/超限主动关闭 stdin；保留其稳定 JSON 错误回执。
        // 若 child 反而以 0 退出，onChildClose 会用 transportError 拒绝伪成功。
        transportError = error;
      }
    });
  }).then(({ receipt, observedBytes, observedSha256 }) => {
    if (!exactPlainObject(receipt, RECEIPT_KEYS)
      || receipt.ok !== true
      || receipt.uploadId !== config.uploadId
      || receipt.attachmentId !== config.attachmentId
      || receipt.suffix !== config.suffix
      || receipt.path !== expectedPath
      || !Number.isSafeInteger(receipt.size)
      || receipt.size <= 0
      || receipt.size > MAX_ATTACHMENT_BYTES
      || receipt.size !== observedBytes
      || typeof receipt.sha256 !== 'string'
      || !SHA256.test(receipt.sha256)
      || receipt.sha256 !== observedSha256) {
      throw attachmentError(
        'ATTACHMENT_WRITER_PROTOCOL', 500, '附件 writer 回执与请求流不一致',
        { stage:'attachment-writer-protocol', committed:false },
      );
    }
    return { ...receipt };
  });
}

class AttachmentUpload {
  constructor(store, id) {
    this.store = store;
    this.id = id;
    this.published = false;
    this.records = [];
    this.reservedIds = new Set();
    this.sequence = Promise.resolve();
    this.state = 'open';
    this.abortReason = null;
    this.active = new Set();
    this.discardPromise = null;
    this.taskId = null;
    this.descriptors = null;
    this.sealed = false;
    this.publishPromise = null;
    this.publishTaskId = null;
  }

  stage(input) {
    if (this.state !== 'open' || this.sealed) return Promise.reject(this.#stateError());
    if (this.records.length + this.reservedIds.size >= MAX_ATTACHMENTS) {
      const error = attachmentError(
        'TOO_MANY_ATTACHMENTS', 413, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`,
        { stage:'attachment-limit', committed:false },
      );
      this.#markFailed(error);
      return this.#discardStaging().then(() => Promise.reject(error));
    }
    let id;
    try { id = canonicalUuid(this.store.randomUUID(), 'attachmentId'); }
    catch (error) {
      this.#markFailed(error);
      return this.#discardStaging().then(() => Promise.reject(error));
    }
    if (this.reservedIds.has(id) || this.records.some(record => record.id === id)) {
      const error = attachmentError(
        'ATTACHMENT_ID_COLLISION', 500, 'attachmentId 重复，拒绝覆盖暂存文件',
        { stage:'attachment-id', committed:false },
      );
      this.#markFailed(error);
      return this.#discardStaging().then(() => Promise.reject(error));
    }
    this.reservedIds.add(id);
    const operation = this.sequence.then(async () => {
      if (this.state !== 'open') throw this.#stateError();
      try {
        const record = await this.#stageOne(id, input);
        this.records.push(record);
        return { ...record };
      } catch (error) {
        this.#markFailed(error);
        try { await this.#discardStaging(); }
        catch (cleanupError) {
          if (error && typeof error === 'object') error.cleanupError = cleanupError;
        }
        throw error;
      } finally {
        this.reservedIds.delete(id);
      }
    });
    this.sequence = operation.catch(() => {});
    return operation;
  }

  async #stageOne(id, input) {
    if (!input || typeof input !== 'object' || !input.stream
      || typeof input.stream.pipe !== 'function' || typeof input.stream.once !== 'function') {
      throw new TypeError('附件 stream 必须是 Node Readable');
    }
    const metadata = sanitizeStageMetadata({
      id, name:input.name, mime:input.mime, source:input.source,
      suffix:input.suffix, now:this.store.now,
    });
    await this.store.guard();
    if (this.state !== 'open') throw this.#stateError();
    const config = {
      session:{ ...this.store.identities.session },
      attachments:{ ...this.store.identities.attachments },
      attachmentStaging:{ ...this.store.identities.attachmentStaging },
      uploadId:this.id,
      attachmentId:id,
      suffix:metadata.suffix,
      maximumBytes:MAX_ATTACHMENT_BYTES,
    };
    const expectedPath = join(
      this.store.identities.attachmentStaging.path,
      this.id,
      `${id}${metadata.suffix}`,
    );
    const receipt = await runWriter({
      stream:input.stream,
      config,
      expectedPath,
      spawnAttachmentWriter:this.store.spawnAttachmentWriter,
      timeoutMs:this.store.timeoutMs,
      killGraceMs:this.store.killGraceMs,
      register:record => {
        this.active.add(record);
        this.store.activeWriters.add(record);
      },
      unregister:record => {
        this.active.delete(record);
        this.store.activeWriters.delete(record);
      },
    });
    if (this.state !== 'open') throw this.#stateError();
    return Object.freeze({
      ...metadata,
      size:receipt.size,
      sha256:receipt.sha256,
    });
  }

  publish(taskId) {
    try { canonicalUuid(taskId, 'taskId'); }
    catch (error) { return Promise.reject(error); }
    if (this.publishPromise) {
      if (this.publishTaskId !== taskId) {
        return Promise.reject(attachmentError(
          'ATTACHMENT_ALREADY_PUBLISHED', 409, '附件 upload 已绑定其他 task',
          {
            stage:'attachment-publish', committed:this.published,
            commitScope:this.published ? 'attachments' : undefined,
          },
        ));
      }
      return this.publishPromise.then(
        descriptors => descriptors.map(descriptor => ({ ...descriptor })),
      );
    }
    if (this.sealed || this.state !== 'open') return Promise.reject(this.#stateError());
    this.sealed = true;
    this.publishTaskId = taskId;
    this.publishPromise = this.#publish(taskId);
    return this.publishPromise.then(
      descriptors => descriptors.map(descriptor => ({ ...descriptor })),
    );
  }

  async #publish(taskId) {
    await this.sequence;
    if (this.state !== 'open') throw this.#stateError();
    if (this.records.length === 0) {
      this.published = true;
      this.state = 'published';
      this.taskId = taskId;
      this.descriptors = [];
      this.store.finishUpload(this);
      return [];
    }
    await this.store.guard();
    let published;
    try {
      published = await this.store.sidecarIO.publishAttachments({
        uploadId:this.id,
        taskId,
        files:this.records.map(({ id, suffix, size, sha256 }) => ({
          id, suffix, size, sha256,
        })),
      });
    } catch (error) {
      if (error?.committed === true && error?.commitScope === 'attachments') {
        this.published = true;
        this.state = 'publish-uncertain';
        this.taskId = taskId;
        this.store.finishUpload(this);
      }
      throw error;
    }
    try {
      if (!Array.isArray(published) || published.length !== this.records.length) {
        throw new TypeError('附件 helper 发布回执数量不匹配');
      }
      const descriptors = this.records.map((record, index) => {
        const result = published[index];
        if (!exactPlainObject(result, PUBLISH_RESULT_KEYS)
          || result.id !== record.id || result.size !== record.size) {
          throw new TypeError('附件 helper 发布回执与 writer 回执不一致');
        }
        return validateAttachmentMetadata({
          id:record.id,
          name:record.name,
          mime:record.mime,
          size:record.size,
          source:record.source,
          relativePath:result.relativePath,
          createdAt:record.createdAt,
        }, taskId);
      });
      this.published = true;
      this.state = 'published';
      this.taskId = taskId;
      this.descriptors = descriptors.map(descriptor => Object.freeze(descriptor));
      this.store.finishUpload(this);
      return descriptors.map(descriptor => ({ ...descriptor }));
    } catch (cause) {
      this.published = true;
      this.state = 'publish-uncertain';
      this.taskId = taskId;
      this.store.finishUpload(this);
      throw attachmentError(
        'ATTACHMENT_PUBLISH_PROTOCOL', 500,
        '附件已经发布，但 helper 回执无法验证',
        {
          stage:'attachment-publish-protocol', committed:true,
          commitScope:'attachments', cause,
        },
      );
    }
  }

  async discard() {
    if (this.published) return { removed:false, published:true };
    this.sealed = true;
    if (this.publishPromise) {
      try { await this.publishPromise; } catch { /* 下面按 committed 状态决定清理 */ }
      if (this.published) return { removed:false, published:true };
    }
    if (this.state === 'open') {
      this.state = 'aborted';
      this.abortReason = abortError('ATTACHMENT_UPLOAD_ABORTED', '附件 upload 已放弃');
    }
    const result = await this.#discardStaging();
    await this.sequence;
    this.store.finishUpload(this);
    return result;
  }

  async close(error) {
    if (this.published) return Promise.resolve();
    this.sealed = true;
    if (this.publishPromise) {
      try { await this.publishPromise; } catch { /* 未提交失败仍需清 staging */ }
      if (this.published) return;
    }
    if (this.state === 'open') {
      this.state = 'aborted';
      this.abortReason = error;
    }
    return this.#discardStaging()
      .then(() => this.sequence)
      .finally(() => this.store.finishUpload(this));
  }

  #markFailed(error) {
    if (this.state === 'open') {
      this.state = 'failed';
      this.sealed = true;
      this.abortReason = error;
    }
  }

  #stateError() {
    return this.abortReason ?? attachmentError(
      'ATTACHMENT_UPLOAD_CLOSED', 409, '附件 upload 已结束',
      { stage:'attachment-upload', committed:this.published,
        commitScope:this.published ? 'attachments' : undefined },
    );
  }

  #discardStaging() {
    if (this.discardPromise) return this.discardPromise;
    this.discardPromise = (async () => {
      const reason = this.abortReason
        ?? abortError('ATTACHMENT_UPLOAD_ABORTED', '附件 upload 已放弃');
      const active = [...this.active];
      for (const record of active) record.cancel(reason);
      await Promise.allSettled(active.map(record => record.closed));
      await this.store.guard();
      return this.store.sidecarIO.discardAttachmentUpload({ uploadId:this.id });
    })();
    return this.discardPromise;
  }
}

export class AttachmentStore {
  constructor({
    sidecarBoundary,
    sidecarIO=sidecarBoundary?.io,
    spawnAttachmentWriter=spawn,
    timeoutMs=DEFAULT_TIMEOUT_MS,
    killGraceMs=DEFAULT_KILL_GRACE_MS,
    randomUUID=systemRandomUUID,
    now=() => new Date(),
  } = {}) {
    this.identities = captureBoundIdentities(sidecarBoundary);
    if (!sidecarIO
      || ['publishAttachments', 'discardAttachmentUpload', 'deleteTaskAttachments']
        .some(name => typeof sidecarIO[name] !== 'function')) {
      throw new TypeError('AttachmentStore 缺少 sidecarIO 附件生命周期接口');
    }
    if (typeof spawnAttachmentWriter !== 'function') {
      throw new TypeError('spawnAttachmentWriter 必须是函数');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new RangeError('attachment writer timeout 必须在 1–120000ms');
    }
    if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > 5_000) {
      throw new RangeError('attachment writer kill grace 无效');
    }
    if (typeof randomUUID !== 'function' || typeof now !== 'function') {
      throw new TypeError('AttachmentStore 随机数或时钟注入无效');
    }
    this.sidecarBoundary = sidecarBoundary;
    this.sidecarIO = sidecarIO;
    this.spawnAttachmentWriter = spawnAttachmentWriter;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.randomUUID = randomUUID;
    this.now = now;
    this.uploads = new Set();
    this.uploadIds = new Set();
    this.activeWriters = new Set();
    this.closed = false;
    this.closePromise = null;
  }

  guard() { return this.sidecarBoundary.guard(); }

  beginUpload() {
    if (this.closed) throw abortError('ATTACHMENT_STORE_CLOSED', 'AttachmentStore 已关闭');
    const id = canonicalUuid(this.randomUUID(), 'uploadId');
    if (this.uploadIds.has(id)) {
      throw attachmentError(
        'ATTACHMENT_UPLOAD_ID_COLLISION', 500, 'uploadId 重复',
        { stage:'attachment-id', committed:false },
      );
    }
    const upload = new AttachmentUpload(this, id);
    this.uploads.add(upload);
    this.uploadIds.add(id);
    return upload;
  }

  finishUpload(upload) {
    this.uploads.delete(upload);
    this.uploadIds.delete(upload.id);
  }

  async deleteTask(taskId) {
    canonicalUuid(taskId, 'taskId');
    if (this.closed) throw abortError('ATTACHMENT_STORE_CLOSED', 'AttachmentStore 已关闭');
    await this.guard();
    return this.sidecarIO.deleteTaskAttachments({ taskId });
  }

  serializeTask(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new TypeError('任务无效');
    }
    canonicalUuid(task.id, 'taskId');
    const attachments = task.attachments === undefined ? [] : task.attachments;
    if (!Array.isArray(attachments)) throw new TypeError('任务 attachments 必须是数组');
    const serialized = attachments.map(value => {
      const metadata = validateAttachmentMetadata(value, task.id);
      return {
        ...metadata,
        path:resolveAttachmentPath(this.identities.session.path, metadata.relativePath),
      };
    });
    return { ...task, attachments:serialized };
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const error = abortError('ATTACHMENT_STORE_CLOSED', 'AttachmentStore 已关闭');
    this.closePromise = (async () => {
      const results = await Promise.allSettled(
        [...this.uploads].map(upload => upload.close(error)),
      );
      await Promise.allSettled([...this.activeWriters].map(record => record.closed));
      const rejected = results.filter(result => result.status === 'rejected');
      if (rejected.length) {
        throw new AggregateError(
          rejected.map(result => result.reason),
          'AttachmentStore 关闭时清理 upload 失败',
        );
      }
    })();
    return this.closePromise;
  }
}

export { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS };
