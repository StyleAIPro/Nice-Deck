import { TextDecoder } from 'node:util';
import Busboy from 'busboy';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from './attachment-protocol.mjs';
import { validateTask } from './protocol.mjs';
import { MAX_SNAPSHOT_BYTES } from './session-store.mjs';

export const MAX_TASK_METADATA_BYTES = 64 * 1024;

const TASK_REQUIRED_KEYS = [
  'attachmentSources', 'expectedRevision', 'instruction', 'pageIndex', 'pageKey',
  'pageLabel', 'rect',
];
const TASK_OPTIONAL_KEYS = ['candidates'];
const TASK_KEYS = new Set([...TASK_REQUIRED_KEYS, ...TASK_OPTIONAL_KEYS]);
const RECT_KEYS = ['h', 'w', 'x', 'y'];
const UTF8 = new TextDecoder('utf-8', { fatal:true });
const MAX_PART_HEADER_BYTES = 16 * 1024 - 1;
// Busboy 1.6.0 以 `++pairCount < 2000` 保存 header；第 2000 对起会静默丢弃。
const MAX_PART_HEADER_PAIRS = 1999;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MIME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function multipartError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), {
    code, statusCode, stage:'multipart', ...details,
  });
}

function invalid(message, details) {
  return multipartError('INVALID_MULTIPART', 400, message, details);
}

function parseParameterizedValue(value, label) {
  if (typeof value !== 'string') throw invalid(`${label} 无效`);
  let index = 0;
  while (index < value.length && value[index] !== ';') index += 1;
  const main = value.slice(0, index).trim().toLowerCase();
  if (!main) throw invalid(`${label} 无效`);
  const parameters = new Map();
  while (index < value.length) {
    index += 1;
    while (index < value.length && /[ \t]/.test(value[index])) index += 1;
    const nameStart = index;
    while (index < value.length && HEADER_NAME.test(value[index])) index += 1;
    const name = value.slice(nameStart, index).toLowerCase();
    if (!name || parameters.has(name)) throw invalid(`${label} 参数重复或无效`);
    while (index < value.length && /[ \t]/.test(value[index])) index += 1;
    if (value[index] !== '=') throw invalid(`${label} 参数缺少等号`);
    index += 1;
    while (index < value.length && /[ \t]/.test(value[index])) index += 1;
    let parameter = '';
    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const character = value[index];
        index += 1;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === '\\') {
          if (index >= value.length) throw invalid(`${label} 引号转义无效`);
          parameter += value[index];
          index += 1;
        } else {
          if (character === '\r' || character === '\n') throw invalid(`${label} 参数换行无效`);
          parameter += character;
        }
      }
      if (!closed) throw invalid(`${label} 引号未闭合`);
      while (index < value.length && /[ \t]/.test(value[index])) index += 1;
      if (index < value.length && value[index] !== ';') {
        throw invalid(`${label} 引号参数后含多余字符`);
      }
    } else {
      const valueStart = index;
      while (index < value.length && value[index] !== ';') index += 1;
      parameter = value.slice(valueStart, index).trim();
    }
    parameters.set(name, parameter);
  }
  return { main, parameters };
}

function multipartBoundary(headers) {
  const raw = headers?.['content-type'];
  if (typeof raw !== 'string') throw invalid('multipart Content-Type 无效');
  const parsed = parseParameterizedValue(raw, 'multipart Content-Type');
  if (parsed.main !== 'multipart/form-data'
    || !parsed.parameters.has('boundary')
    || parsed.parameters.size !== 1) {
    throw invalid('multipart Content-Type 必须唯一提供 boundary');
  }
  const boundary = parsed.parameters.get('boundary');
  if (boundary.length === 0 || boundary.length > 200
    || /[^\x20-\x7e]/.test(boundary) || /[ \t]$/.test(boundary)) {
    throw invalid('multipart boundary 无效');
  }
  return boundary;
}

function parseRawHeaders(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_PART_HEADER_BYTES) {
    throw invalid('multipart part header block 大小无效');
  }
  const lines = bytes.toString('latin1').split('\r\n');
  if (lines.length > MAX_PART_HEADER_PAIRS) {
    throw invalid('multipart part header 数量超限');
  }
  const headers = new Map();
  for (const line of lines) {
    if (/^[ \t]/.test(line)) throw invalid('multipart part header 不接受折行');
    const separator = line.indexOf(':');
    if (separator <= 0) throw invalid('multipart part header 格式无效');
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^[ \t]*/, '').replace(/[ \t]*$/, '');
    if (!HEADER_NAME.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw invalid('multipart part header 格式无效');
    }
    const normalized = name.toLowerCase();
    const values = headers.get(normalized) ?? [];
    values.push(value);
    headers.set(normalized, values);
  }
  return headers;
}

function validateRawPartHeaders(bytes, state) {
  const headers = parseRawHeaders(bytes);
  const dispositions = headers.get('content-disposition') ?? [];
  const contentTypes = headers.get('content-type') ?? [];
  if (dispositions.length !== 1 || contentTypes.length > 1) {
    throw invalid('multipart part 必须有唯一 Content-Disposition 和至多一个 Content-Type');
  }
  const disposition = parseParameterizedValue(dispositions[0], 'Content-Disposition');
  if (disposition.main !== 'form-data'
    || !disposition.parameters.has('name')
    || disposition.parameters.get('name').length === 0) {
    throw invalid('multipart part 必须是带 name 的 form-data');
  }
  const fieldName = disposition.parameters.get('name');
  if (!['task', 'snapshot', 'attachment'].includes(fieldName)) {
    throw invalid(`不支持的 multipart part：${fieldName}`);
  }
  const filenameKeys = ['filename', 'filename*']
    .filter(key => disposition.parameters.has(key));
  if (filenameKeys.length !== 1
    || disposition.parameters.get(filenameKeys[0]).length === 0) {
    throw invalid('multipart file part 必须提供唯一非空 filename');
  }
  let mime = null;
  if (contentTypes.length === 1) {
    const contentType = parseParameterizedValue(contentTypes[0], 'Content-Type');
    if (!MIME.test(contentType.main)) throw invalid('multipart part Content-Type 无效');
    mime = contentType.main;
  }

  state.parts += 1;
  if (state.parts === 1 && fieldName !== 'task') {
    throw invalid('task 必须是物理首个 multipart part');
  }
  if (fieldName === 'task') {
    if (state.taskSeen || state.parts !== 1 || mime !== 'application/json') {
      throw invalid('task 必须是首个且唯一的 application/json file part');
    }
    state.taskSeen = true;
  } else if (fieldName === 'snapshot') {
    if (state.snapshotSeen || mime !== 'image/png') {
      throw invalid('snapshot 必须是唯一的 image/png file part');
    }
    state.snapshotSeen = true;
  } else {
    state.attachments += 1;
    if (state.attachments > MAX_ATTACHMENTS) {
      throw multipartError(
        'TOO_MANY_ATTACHMENTS', 413, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`,
      );
    }
  }
  if (state.parts > MAX_ATTACHMENTS + 2) {
    throw invalid('multipart part 数量超限');
  }
}

function createMultipartAudit(boundary) {
  const initial = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const headerEnd = Buffer.from('\r\n\r\n');
  const state = {
    mode:'initial', initialOffset:0, post:Buffer.alloc(0), header:Buffer.alloc(0),
    tail:Buffer.alloc(0), epilogue:Buffer.alloc(0), parts:0, attachments:0,
    taskSeen:false, snapshotSeen:false, finished:false,
  };

  const fail = message => { throw invalid(message); };
  const feedData = chunk => {
    if (chunk.length === 0) return;
    if (state.tail.length) {
      const prefix = chunk.subarray(0, Math.min(chunk.length, delimiter.length));
      const bridge = Buffer.concat([state.tail, prefix]);
      const match = bridge.indexOf(delimiter);
      if (match >= 0 && match < state.tail.length) {
        const consumed = Math.max(0, match + delimiter.length - state.tail.length);
        state.tail = Buffer.alloc(0);
        state.mode = 'post-boundary';
        feed(chunk.subarray(consumed));
        return;
      }
    }
    const match = chunk.indexOf(delimiter);
    if (match >= 0) {
      state.tail = Buffer.alloc(0);
      state.mode = 'post-boundary';
      feed(chunk.subarray(match + delimiter.length));
      return;
    }
    const tailLength = delimiter.length - 1;
    if (chunk.length >= tailLength) {
      state.tail = Buffer.from(chunk.subarray(chunk.length - tailLength));
    } else {
      const combinedTail = Buffer.concat([state.tail, chunk]);
      state.tail = Buffer.from(combinedTail.subarray(
        Math.max(0, combinedTail.length - tailLength),
      ));
    }
  };

  const feed = input => {
    let chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    while (chunk.length) {
      if (state.mode === 'initial') {
        const needed = initial.length - state.initialOffset;
        const take = Math.min(needed, chunk.length);
        if (!chunk.subarray(0, take).equals(
          initial.subarray(state.initialOffset, state.initialOffset + take),
        )) fail('multipart body 必须以 boundary 开始');
        state.initialOffset += take;
        chunk = chunk.subarray(take);
        if (state.initialOffset === initial.length) state.mode = 'post-boundary';
        continue;
      }
      if (state.mode === 'post-boundary') {
        const needed = 2 - state.post.length;
        const take = Math.min(needed, chunk.length);
        state.post = Buffer.concat([state.post, chunk.subarray(0, take)]);
        chunk = chunk.subarray(take);
        if (state.post.length < 2) continue;
        if (state.post.equals(Buffer.from('\r\n'))) {
          state.post = Buffer.alloc(0);
          state.header = Buffer.alloc(0);
          state.mode = 'headers';
        } else if (state.post.equals(Buffer.from('--'))) {
          state.post = Buffer.alloc(0);
          state.mode = 'end';
        } else {
          fail('multipart part 正文包含 boundary 行前缀');
        }
        continue;
      }
      if (state.mode === 'headers') {
        const capacity = MAX_PART_HEADER_BYTES + headerEnd.length - state.header.length;
        const take = Math.min(capacity, chunk.length);
        const previous = state.header.length;
        const candidate = Buffer.concat([state.header, chunk.subarray(0, take)]);
        const end = candidate.indexOf(headerEnd);
        if (end >= 0) {
          const consumed = Math.max(0, end + headerEnd.length - previous);
          validateRawPartHeaders(candidate.subarray(0, end), state);
          state.header = Buffer.alloc(0);
          state.tail = Buffer.alloc(0);
          state.mode = 'data';
          chunk = chunk.subarray(consumed);
          continue;
        }
        if (candidate.length >= MAX_PART_HEADER_BYTES + headerEnd.length) {
          fail('multipart part header block 超过 16 KiB');
        }
        state.header = candidate;
        chunk = chunk.subarray(take);
        continue;
      }
      if (state.mode === 'data') {
        feedData(chunk);
        return;
      }
      if (state.mode === 'end') {
        if (state.epilogue.length + chunk.length > 2) {
          fail('multipart closing boundary 后含多余数据');
        }
        state.epilogue = Buffer.concat([state.epilogue, chunk]);
        return;
      }
      fail('multipart 原始结构状态无效');
    }
  };

  return {
    get parts() { return state.parts; },
    push:feed,
    finish() {
      if (state.finished) return;
      state.finished = true;
      if (state.mode !== 'end'
        || (state.epilogue.length !== 0 && !state.epilogue.equals(Buffer.from('\r\n')))
        || !state.taskSeen) {
        fail('multipart 请求缺少完整 closing boundary 或 task');
      }
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isSafeText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\p{Cc}\p{Cs}\p{Bidi_Control}\u200B\uFEFF]/u.test(value);
}

function cloneJsonValue(value, depth = 0) {
  if (depth > 16) throw invalid('task candidates 嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('task candidates 含非有限数');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw invalid('task candidates 数组过长');
    return value.map(item => cloneJsonValue(item, depth + 1));
  }
  if (!isPlainObject(value)) throw invalid('task candidates 必须是 JSON 值');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw invalid('task candidates 含危险字段');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalid('task candidates 字段无效');
    }
    Object.defineProperty(result, key, {
      value:cloneJsonValue(descriptor.value, depth + 1),
      enumerable:true, configurable:true, writable:true,
    });
  }
  return result;
}

function sanitizeTask(value) {
  if (!isPlainObject(value)) throw invalid('task part 必须是 JSON 普通对象');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !TASK_KEYS.has(key))
    || TASK_REQUIRED_KEYS.some(key => !Object.hasOwn(value, key))) {
    throw invalid('task part 字段无效');
  }
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw invalid('expectedRevision 必须为非负安全整数');
  }
  if (!isSafeText(value.pageKey, 512)
    || !Number.isSafeInteger(value.pageIndex) || value.pageIndex <= 0
    || !isSafeText(value.pageLabel, 512)
    || typeof value.instruction !== 'string'
    || value.instruction.trim().length === 0) {
    throw invalid('task 缺少有效区域字段');
  }
  if (!isPlainObject(value.rect)
    || Reflect.ownKeys(value.rect).length !== RECT_KEYS.length
    || RECT_KEYS.some(key => !Object.hasOwn(value.rect, key))) {
    throw invalid('task rect 字段无效');
  }
  if (!Array.isArray(value.attachmentSources)
    || value.attachmentSources.some(source => source !== 'selected' && source !== 'pasted')) {
    throw invalid('attachmentSources 只能按顺序包含 selected 或 pasted');
  }
  if (value.attachmentSources.length > MAX_ATTACHMENTS) {
    throw multipartError(
      'TOO_MANY_ATTACHMENTS', 413, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`,
    );
  }
  if (value.candidates !== undefined
    && (!Array.isArray(value.candidates) || value.candidates.length > 12)) {
    throw invalid('task candidates 必须是至多 12 项的数组');
  }

  const input = {
    expectedRevision:value.expectedRevision,
    pageKey:value.pageKey,
    pageIndex:value.pageIndex,
    pageLabel:value.pageLabel,
    rect:Object.fromEntries(RECT_KEYS.map(key => [key, value.rect[key]])),
    instruction:value.instruction.trim(),
  };
  if (value.candidates !== undefined) input.candidates = cloneJsonValue(value.candidates);
  try { validateTask(input); }
  catch (cause) { throw invalid(cause.message || 'task 区域字段无效', { cause }); }
  return {
    input,
    attachmentSources:[...value.attachmentSources],
  };
}

function parseTaskBytes(bytes) {
  let source;
  try { source = UTF8.decode(bytes); }
  catch (cause) { throw invalid('task part 不是有效 UTF-8', { cause }); }
  let value;
  try { value = JSON.parse(source); }
  catch (cause) { throw invalid('task part 不是有效 JSON', { cause }); }
  return sanitizeTask(value);
}

function fileNameIsValid(filename) {
  return typeof filename === 'string' && filename.length > 0 && filename.length <= 1024
    && !/[\\/\0\r\n]/.test(filename)
    && filename !== '.' && filename !== '..';
}

function collectPart(stream, maximum, tooLargeCode, tooLargeMessage) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let outcome = null;
    const settleError = error => {
      if (outcome !== null) return;
      outcome = { error };
      chunks.length = 0;
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximum) {
        settleError(multipartError(tooLargeCode, 413, tooLargeMessage));
        return;
      }
      if (outcome === null) chunks.push(bytes);
    };
    const onLimit = () => settleError(multipartError(
      tooLargeCode, 413, tooLargeMessage,
    ));
    const onError = cause => settleError(invalid('multipart 文件 part 在完成前截断', { cause }));
    const onEnd = () => {
      cleanup();
      if (stream.truncated && outcome === null) onLimit();
      if (outcome?.error) reject(outcome.error);
      else resolve(Buffer.concat(chunks, size));
    };
    const onClose = () => {
      if (stream.readableEnded) return;
      cleanup();
      reject(outcome?.error ?? invalid('multipart 文件 part 在完成前关闭'));
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('limit', onLimit);
      stream.removeListener('error', onError);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
    };
    stream.on('data', onData);
    stream.once('limit', onLimit);
    stream.once('error', onError);
    stream.once('end', onEnd);
    stream.once('close', onClose);
  });
}

function normalizeParserError(error) {
  if (error?.code && Number.isInteger(error?.statusCode)) return error;
  return invalid(error?.message ? `multipart 解析失败：${error.message}` : 'multipart 解析失败', {
    cause:error,
  });
}

function prioritizeCleanupError(primaryError, cleanupError) {
  if (cleanupError?.committed === true) {
    if (cleanupError && typeof cleanupError === 'object' && cleanupError.cause === undefined) {
      try { cleanupError.cause = primaryError; } catch { /* 冻结错误对象仍原样优先传播 */ }
    }
    return cleanupError;
  }
  if (primaryError && typeof primaryError === 'object') {
    try { primaryError.cleanupError = cleanupError; } catch { /* 保留首个错误 */ }
  }
  return primaryError;
}

export async function parseTaskMultipart(request, { attachmentStore } = {}) {
  if (!request || typeof request.pipe !== 'function' || !request.headers) {
    throw new TypeError('multipart request 必须是带 headers 的 Node Readable');
  }
  if (!attachmentStore || typeof attachmentStore.beginUpload !== 'function') {
    throw new TypeError('parseTaskMultipart 缺少 AttachmentStore');
  }

  const upload = attachmentStore.beginUpload();
  if (!upload || typeof upload.stage !== 'function' || typeof upload.discard !== 'function') {
    throw new TypeError('AttachmentStore.beginUpload() 接口无效');
  }
  let discardPromise = null;
  const discardOnce = () => {
    if (!discardPromise) {
      discardPromise = Promise.resolve().then(() => upload.discard());
      discardPromise.catch(() => {});
    }
    return discardPromise;
  };

  let parser;
  let audit;
  try {
    audit = createMultipartAudit(multipartBoundary(request.headers));
    parser = Busboy({
      headers:request.headers,
      defParamCharset:'utf8',
      preservePath:true,
      limits:{
        fields:0,
        files:MAX_ATTACHMENTS + 2,
        // Busboy 在“达到” partsLimit 时发事件并停止下一 part；11 才能允许合法的 10。
        parts:MAX_ATTACHMENTS + 3,
        // Busboy 在“恰好达到 fileSize”时也发 limit；多留一字节才能接受精确 25 MiB，
        // 同时仍让第 25 MiB + 1 字节触发 fail-closed，writer 自身也独立执行 25 MiB 上限。
        fileSize:MAX_ATTACHMENT_BYTES + 1,
      },
    });
  } catch (cause) {
    const primary = normalizeParserError(cause);
    try { await discardOnce(); } catch (cleanupError) {
      throw prioritizeCleanupError(primary, cleanupError);
    }
    throw primary;
  }

  try {
    return await new Promise((resolve, reject) => {
      let firstError = null;
      let partIndex = 0;
      let attachmentCount = 0;
      let taskSeen = false;
      let snapshotSeen = false;
      let taskPromise = null;
      let snapshotPromise = Promise.resolve(null);
      let finalized = false;
      const stagedPromises = [];
      const fileStreams = new Set();

      const record = error => {
        firstError ??= normalizeParserError(error);
        return firstError;
      };

      const trackFile = stream => {
        fileStreams.add(stream);
        const onError = cause => record(
          cause?.code && Number.isInteger(cause?.statusCode)
            ? cause
            : invalid('multipart 文件 part 在完成前失败', { cause }),
        );
        const cleanup = () => {
          stream.removeListener('error', onError);
          stream.removeListener('end', cleanup);
          stream.removeListener('close', cleanup);
          fileStreams.delete(stream);
        };
        stream.once('error', onError);
        stream.once('end', cleanup);
        stream.once('close', cleanup);
      };

      const drainFile = stream => {
        const absorbError = () => {};
        const cleanup = () => {
          stream.removeListener('error', absorbError);
          stream.removeListener('end', cleanup);
          stream.removeListener('close', cleanup);
        };
        stream.on('error', absorbError);
        stream.once('end', cleanup);
        stream.once('close', cleanup);
        stream.resume();
      };

      const finalize = async () => {
        if (finalized) return;
        finalized = true;
        request.removeListener('aborted', onRequestAborted);
        request.removeListener('error', onRequestError);
        request.removeListener('data', onAuditData);
        request.removeListener('end', onAuditEnd);
        request.unpipe(parser);
        parser.removeListener('error', onParserError);

        let parsedTask;
        let snapshot = null;
        let staged = [];
        let cleanupError = null;
        const cleanupFailedUpload = async () => {
          if (!firstError || discardPromise && cleanupError) return;
          try { await discardOnce(); } catch (error) { cleanupError ??= error; }
        };
        if (!firstError && audit.parts !== partIndex) {
          record(invalid('multipart 原始 part 与 Busboy 事件数量不一致'));
        }
        const taskOutcome = taskPromise
          ? await Promise.resolve(taskPromise).then(
            value => ({ value }), error => ({ error }),
          )
          : { error:invalid('缺少 task part') };
        if (taskOutcome.error) record(taskOutcome.error);
        else parsedTask = taskOutcome.value;

        const snapshotOutcome = await Promise.resolve(snapshotPromise).then(
          value => ({ value }), error => ({ error }),
        );
        if (snapshotOutcome.error) record(snapshotOutcome.error);
        else snapshot = snapshotOutcome.value;

        // parser/request/task/snapshot 失败时必须先取消 writer，随后才能等待 stage 收敛。
        await cleanupFailedUpload();

        const stageOutcomes = await Promise.all(stagedPromises.map(promise => Promise.resolve(promise).then(
          value => ({ value }), error => ({ error }),
        )));
        for (const outcome of stageOutcomes) {
          if (outcome.error) record(outcome.error);
          else staged.push(outcome.value);
        }
        if (parsedTask
          && parsedTask.attachmentSources.length !== attachmentCount) {
          record(invalid('attachmentSources 数量与 attachment part 不匹配'));
        }

        if (firstError) {
          await cleanupFailedUpload();
          await Promise.allSettled(stagedPromises);
          await Promise.all([...fileStreams].map(stream => new Promise(resolveStream => {
            const absorbError = () => {};
            const finishStream = () => {
              stream.removeListener('error', absorbError);
              stream.removeListener('end', finishStream);
              stream.removeListener('close', finishStream);
              resolveStream();
            };
            stream.on('error', absorbError);
            stream.once('end', finishStream);
            stream.once('close', finishStream);
            if (stream.readableEnded || stream.closed) finishStream();
            else stream.destroy(firstError);
          })));
          parser.removeAllListeners();
          reject(cleanupError
            ? prioritizeCleanupError(firstError, cleanupError)
            : firstError);
          return;
        }
        parser.removeAllListeners();
        resolve(Object.freeze({
          input:Object.freeze(parsedTask.input),
          snapshot,
          upload,
          staged:Object.freeze(staged.map(record => Object.freeze({ ...record }))),
        }));
      };

      const abortParser = error => {
        record(error);
        void discardOnce();
        request.unpipe(parser);
        request.resume();
        if (!parser.destroyed) parser.destroy(firstError);
      };
      const onRequestAborted = () => abortParser(invalid('multipart 请求在完成前中断'));
      const onRequestError = cause => abortParser(invalid('multipart 请求流失败', { cause }));
      const onAuditData = chunk => {
        try { audit.push(chunk); }
        catch (error) { abortParser(error); }
      };
      const onAuditEnd = () => {
        try { audit.finish(); }
        catch (error) { abortParser(error); }
      };
      const onParserError = error => {
        record(normalizeParserError(error));
        void discardOnce();
        request.unpipe(parser);
        request.resume();
        if (!parser.destroyed) parser.destroy();
      };

      parser.on('field', () => {
        partIndex += 1;
        record(invalid('multipart 不接受普通 field'));
      });
      parser.on('file', (fieldName, stream, info) => {
        const currentPart = partIndex;
        partIndex += 1;
        trackFile(stream);

        if (!fileNameIsValid(info.filename)) {
          record(invalid('multipart file part 必须提供非目录 filename'));
          drainFile(stream);
          return;
        }
        if (fieldName === 'task') {
          if (currentPart !== 0 || taskSeen || info.mimeType !== 'application/json') {
            record(invalid('task 必须是首个且唯一的 application/json file part'));
            drainFile(stream);
            return;
          }
          taskSeen = true;
          taskPromise = collectPart(
            stream,
            MAX_TASK_METADATA_BYTES,
            'INVALID_MULTIPART',
            'task 元数据超过 64 KiB',
          ).then(parseTaskBytes);
          taskPromise.catch(record);
          return;
        }
        if (!taskSeen) {
          record(invalid('所有文件 part 之前必须先提供 task'));
          drainFile(stream);
          return;
        }
        if (fieldName === 'snapshot') {
          if (snapshotSeen || info.mimeType !== 'image/png') {
            record(invalid('snapshot 必须是唯一的 image/png file part'));
            drainFile(stream);
            return;
          }
          snapshotSeen = true;
          snapshotPromise = collectPart(
            stream,
            MAX_SNAPSHOT_BYTES,
            'SNAPSHOT_TOO_LARGE',
            'snapshot 超过 512 KiB',
          );
          snapshotPromise.catch(record);
          return;
        }
        if (fieldName !== 'attachment') {
          record(invalid(`不支持的 multipart part：${fieldName}`));
          drainFile(stream);
          return;
        }
        if (attachmentCount >= MAX_ATTACHMENTS) {
          record(multipartError(
            'TOO_MANY_ATTACHMENTS', 413, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`,
          ));
          drainFile(stream);
          return;
        }

        const attachmentIndex = attachmentCount;
        attachmentCount += 1;
        let limitError = null;
        const onAttachmentLimit = () => {
          limitError = multipartError(
            'ATTACHMENT_TOO_LARGE', 413, '单个附件不得超过 25 MiB',
          );
          abortParser(limitError);
        };
        const removeAttachmentLimit = () => {
          stream.removeListener('limit', onAttachmentLimit);
          stream.removeListener('end', removeAttachmentLimit);
          stream.removeListener('close', removeAttachmentLimit);
        };
        stream.once('limit', onAttachmentLimit);
        stream.once('end', removeAttachmentLimit);
        stream.once('close', removeAttachmentLimit);
        stream.pause();
        const stagedPromise = Promise.resolve(taskPromise).then(parsed => {
          if (firstError && firstError !== limitError) {
            drainFile(stream);
            throw firstError;
          }
          const source = parsed.attachmentSources[attachmentIndex];
          if (source !== 'selected' && source !== 'pasted') {
            drainFile(stream);
            throw invalid('attachmentSources 与附件 part 顺序不一致');
          }
          return upload.stage({
            stream,
            name:info.filename,
            mime:info.mimeType || 'application/octet-stream',
            source,
          });
        }).then(record => {
          if (limitError || stream.truncated) {
            throw limitError ?? multipartError(
              'ATTACHMENT_TOO_LARGE', 413, '单个附件不得超过 25 MiB',
            );
          }
          return record;
        });
        stagedPromise.catch(error => {
          abortParser(error);
          if (!stream.destroyed && !stream.readableEnded) drainFile(stream);
        });
        stagedPromises.push(stagedPromise);
      });
      parser.once('fieldsLimit', () => record(invalid('multipart field 数量超限')));
      parser.once('filesLimit', () => record(multipartError(
        'TOO_MANY_ATTACHMENTS', 413, 'multipart 文件 part 数量超限',
      )));
      parser.once('partsLimit', () => record(multipartError(
        'INVALID_MULTIPART', 400, 'multipart part 数量超限',
      )));
      parser.on('error', onParserError);
      parser.once('close', () => { void finalize(); });
      request.once('aborted', onRequestAborted);
      request.once('error', onRequestError);
      request.on('data', onAuditData);
      request.once('end', onAuditEnd);
      if (request.aborted === true || request.readableAborted === true
        || (request.destroyed === true && request.readableEnded !== true)) {
        abortParser(invalid('multipart 请求在解析前已经中断'));
      } else {
        try { request.pipe(parser); }
        catch (cause) { abortParser(normalizeParserError(cause)); }
      }
    });
  } catch (primaryError) {
    let cleanupError = null;
    try { await discardOnce(); } catch (error) { cleanupError = error; }
    throw cleanupError
      ? prioritizeCleanupError(primaryError, cleanupError)
      : primaryError;
  }
}
