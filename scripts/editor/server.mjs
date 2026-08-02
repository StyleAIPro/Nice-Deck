import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, unwatchFile, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeService } from './bridge-service.mjs';
import { validateAction, validateTask } from './protocol.mjs';
import { RevisionConflict, SessionStore } from './session-store.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const PUBLIC_DIR = join(EDITOR_DIR, 'public');
const MAX_BODY_BYTES = 1024 * 1024;
const EDITOR_ASSETS = new Map([
  ['/editor/editor.css', { path: join(PUBLIC_DIR, 'editor.css'), type: 'text/css; charset=utf-8' }],
  ['/editor/editor.mjs', { path: join(PUBLIC_DIR, 'editor.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/action-compiler.mjs', { path: join(EDITOR_DIR, 'action-compiler.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/frame-bridge.mjs', { path: join(PUBLIC_DIR, 'frame-bridge.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/task-drawer.mjs', { path: join(PUBLIC_DIR, 'task-drawer.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/ws-client.mjs', { path: join(PUBLIC_DIR, 'ws-client.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/protocol.mjs', { path: join(EDITOR_DIR, 'protocol.mjs'), type: 'text/javascript; charset=utf-8' }],
  ['/editor/html2canvas.min.js', {
    path: join(PROJECT_DIR, 'node_modules/html2canvas/dist/html2canvas.min.js'),
    type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/patch-runtime.js', {
    path: join(EDITOR_DIR, 'runtime/patch-runtime.js'),
    type: 'text/javascript; charset=utf-8',
  }],
  ['/editor/huawei-logo.png', {
    path: join(PROJECT_DIR, 'assets/huawei-refs/logos/huawei-横版logo-透明.png'),
    type: 'image/png',
  }],
]);

function httpError(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

function adapterError(code, statusCode, message) {
  return Object.assign(httpError(code, statusCode, message), {
    stage:'adapter',
    recovery:'检查适配器诊断、目录权限和磁盘空间后重试',
  });
}

function detailedHttpError(code, statusCode, message, details = {}) {
  return Object.assign(httpError(code, statusCode, message), details);
}

async function fileFingerprint(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function bytesFingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function restoreConflictError(expectedFingerprint, actualFingerprint, message, cause) {
  return detailedHttpError('RESTORE_CONFLICT', 409, message, {
    stage:'recovery',
    recovery:'保留磁盘外部版本，重新载入后在新基线上重放补丁',
    expectedFingerprint,
    actualFingerprint,
    cause,
  });
}

function unsafeSidecarError(message, cause) {
  return detailedHttpError('UNSAFE_SIDECAR', 500, message, {
    stage:'sidecar',
    recovery:'移除 sidecar 路径中的符号链接并使用 Deck 同目录下的真实目录后重试',
    cause,
  });
}

async function ensureTrustedChildDirectory(parentPath, childPath, label) {
  const parentInfo = await lstat(parentPath);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error(`${label} 的父目录不是可信真实目录`);
  }
  const parentReal = await realpath(parentPath);
  await mkdir(childPath, { mode:0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const childInfo = await lstat(childPath);
  if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
    throw new Error(`${label} 必须是非符号链接的真实目录`);
  }
  const childReal = await realpath(childPath);
  if (dirname(childReal) !== parentReal) {
    throw new Error(`${label} 真实路径逃逸预期父目录`);
  }
  return childPath;
}

async function prepareSidecarBoundary(deckPath, deckFingerprint) {
  const projectDir = dirname(deckPath);
  const sidecarRoot = join(projectDir, '.huawei-deck-editor');
  await ensureTrustedChildDirectory(projectDir, sidecarRoot, 'sidecar root');
  const sessionDir = join(
    sidecarRoot,
    `${basename(deckPath, '.html')}-${deckFingerprint.slice(0, 8)}`,
  );
  await ensureTrustedChildDirectory(sidecarRoot, sessionDir, 'sidecar session');
  return { sidecarRoot, sessionDir };
}

async function safeBackupsDirectory(sessionDir) {
  const absoluteSession = resolve(sessionDir);
  const sessionInfo = await lstat(absoluteSession);
  if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) {
    throw new Error('当前会话目录不是可信真实目录');
  }
  const sessionReal = await realpath(absoluteSession);
  const backupRoot = join(absoluteSession, 'backups');
  await mkdir(backupRoot, { mode:0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const backupInfo = await lstat(backupRoot);
  if (backupInfo.isSymbolicLink() || !backupInfo.isDirectory()) {
    throw new Error('backups 必须是非符号链接的真实目录');
  }
  const backupReal = await realpath(backupRoot);
  if (dirname(backupReal) !== sessionReal) {
    throw new Error('backups 不在当前会话目录内');
  }
  return { backupRoot, backupReal };
}

async function safeTransactionsDirectory(sessionDir) {
  const absoluteSession = resolve(sessionDir);
  const sessionInfo = await lstat(absoluteSession);
  if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) {
    throw new Error('当前会话目录不是可信真实目录');
  }
  const sessionReal = await realpath(absoluteSession);
  const transactionRoot = join(absoluteSession, 'transactions');
  await mkdir(transactionRoot, { mode:0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const transactionInfo = await lstat(transactionRoot);
  if (transactionInfo.isSymbolicLink() || !transactionInfo.isDirectory()) {
    throw new Error('transactions 必须是非符号链接的真实目录');
  }
  const transactionReal = await realpath(transactionRoot);
  if (dirname(transactionReal) !== sessionReal) {
    throw new Error('transactions 不在当前会话目录内');
  }
  return { transactionRoot, transactionReal };
}

function requireTransactionId(transactionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    transactionId,
  )) throw new Error('transactionId 不是规范 UUID v4');
  return transactionId;
}

async function readTransactionRecord(
  deckPath,
  sessionDir,
  transactionId,
  expectedFingerprint,
  backupRecord,
) {
  requireTransactionId(transactionId);
  const { transactionRoot, transactionReal } = await safeTransactionsDirectory(sessionDir);
  const transactionPath = join(transactionRoot, `${transactionId}.json`);
  const info = await lstat(transactionPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('事务记录必须是非符号链接的常规文件');
  }
  if (dirname(await realpath(transactionPath)) !== transactionReal) {
    throw new Error('事务记录真实路径逃逸当前会话目录');
  }
  const handle = await open(
    transactionPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let bytes;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('事务记录句柄不是常规文件');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  let record;
  try { record = JSON.parse(bytes); }
  catch { throw new Error('事务记录不是有效 JSON'); }
  const expectedKeys = [
    'backup', 'candidateFingerprint', 'deckPath', 'oldFingerprint',
    'sessionDir', 'transactionId', 'version',
  ];
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
    || record.version !== 1
    || record.transactionId !== transactionId
    || resolve(record.deckPath ?? '') !== resolve(deckPath)
    || resolve(record.sessionDir ?? '') !== resolve(sessionDir)
    || record.oldFingerprint !== expectedFingerprint
    || !/^[a-f0-9]{64}$/.test(record.candidateFingerprint ?? '')
    || resolve(record.backup ?? '') !== backupRecord.backupPath) {
    throw new Error('事务记录未严格绑定当前 Deck、session 和保存基线');
  }
  await readTrustedBackup(sessionDir, record.backup, expectedFingerprint);
  return { transactionPath, record };
}

async function removeTransactionRecord(sessionDir, transactionId) {
  const { transactionRoot, transactionReal } = await safeTransactionsDirectory(sessionDir);
  const transactionPath = join(transactionRoot, `${requireTransactionId(transactionId)}.json`);
  let info;
  try { info = await lstat(transactionPath); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()
    || dirname(await realpath(transactionPath)) !== transactionReal) {
    throw new Error('拒绝清理不可信事务记录');
  }
  await unlink(transactionPath);
}

async function pruneTransactionRecords(sessionDir, maximum = 32) {
  const { transactionRoot } = await safeTransactionsDirectory(sessionDir);
  const candidates = [];
  for (const entry of await readdir(transactionRoot, { withFileTypes:true })) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
    const path = join(transactionRoot, entry.name);
    const info = await lstat(path);
    if (!info.isSymbolicLink() && info.isFile()) candidates.push({ path, mtimeMs:info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates.slice(maximum)) await unlink(candidate.path);
}

async function readTrustedBackup(sessionDir, backupPath, expectedFingerprint) {
  const { backupRoot, backupReal } = await safeBackupsDirectory(sessionDir);
  const absoluteBackup = resolve(backupPath);
  if (dirname(absoluteBackup) !== backupRoot) {
    throw new Error('备份路径不在当前会话 backups 目录内');
  }
  const backupInfo = await lstat(absoluteBackup);
  if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
    throw new Error('备份必须是非符号链接的常规文件');
  }
  const backupRealPath = await realpath(absoluteBackup);
  if (dirname(backupRealPath) !== backupReal) {
    throw new Error('备份真实路径逃逸当前会话目录');
  }
  const handle = await open(
    absoluteBackup,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let backupBytes;
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) throw new Error('备份句柄不是常规文件');
    backupBytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytesFingerprint(backupBytes) !== expectedFingerprint) {
    throw new Error('备份指纹与写回前基线不一致');
  }
  return { backupPath:absoluteBackup, backupBytes };
}

async function ensureTransactionBackup(deckPath, sessionDir, expectedFingerprint) {
  const { backupRoot } = await safeBackupsDirectory(sessionDir);
  const originalBytes = await readFile(deckPath);
  const actualFingerprint = bytesFingerprint(originalBytes);
  if (actualFingerprint !== expectedFingerprint) {
    throw detailedHttpError('DECK_CHANGED', 409, '诊断期间磁盘 Deck 已发生变化，拒绝覆盖', {
      stage:'fingerprint',
      recovery:'重新载入外部文件并在新基线上重放补丁，或另存为副本',
      expectedFingerprint,
      actualFingerprint,
    });
  }
  const backupPath = join(backupRoot, `${basename(deckPath, '.html')}-${expectedFingerprint}.html`);
  let handle;
  try {
    handle = await open(
      backupPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(originalBytes);
    await handle.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await handle?.close();
  }
  const trusted = await readTrustedBackup(sessionDir, backupPath, expectedFingerprint);
  return { ...trusted, expectedFingerprint };
}

async function restoreDeckBackup(
  deckPath,
  sessionDir,
  backupRecord,
  expectedFingerprint,
  candidateFingerprint,
) {
  const trusted = await readTrustedBackup(sessionDir, backupRecord.backupPath, expectedFingerprint);
  const currentFingerprint = await fileFingerprint(deckPath);
  if (currentFingerprint === expectedFingerprint) return;
  if (currentFingerprint !== candidateFingerprint) {
    throw restoreConflictError(
      candidateFingerprint,
      currentFingerprint,
      'Deck 已不再是本次 writer candidate，拒绝自动恢复覆盖',
    );
  }
  const backupBytes = trusted.backupBytes;
  const temporaryPath = join(
    dirname(deckPath), `.${basename(deckPath)}.${randomUUID()}.restore.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(backupBytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const latestFingerprint = await fileFingerprint(deckPath);
    if (latestFingerprint !== candidateFingerprint) {
      throw restoreConflictError(
        candidateFingerprint,
        latestFingerprint,
        'Deck 在自动恢复期间发生外部变化，拒绝覆盖',
      );
    }
    await rename(temporaryPath, deckPath);
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch(() => {});
  }
}

async function validateWriterResult(
  deckPath,
  sessionDir,
  result,
  backupRecord,
  transactionId,
) {
  if (result?.ok !== true) throw adapterError('WRITE_FAILED', 500, '写入 Deck 未返回成功状态');
  if (typeof result.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.fingerprint)) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 返回无效 fingerprint');
  }
  if (typeof result.backup !== 'string' || resolve(result.backup) !== backupRecord.backupPath) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 返回不可信 backup');
  }
  const expectedTransactionPath = join(
    sessionDir, 'transactions', `${requireTransactionId(transactionId)}.json`,
  );
  if (typeof result.transaction !== 'string'
    || resolve(result.transaction) !== resolve(expectedTransactionPath)) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 返回不可信 transaction');
  }
  await readTrustedBackup(sessionDir, result.backup, backupRecord.expectedFingerprint);
  const { record } = await readTransactionRecord(
    deckPath,
    sessionDir,
    transactionId,
    backupRecord.expectedFingerprint,
    backupRecord,
  );
  if (record.candidateFingerprint !== result.fingerprint) {
    throw adapterError('WRITE_FAILED', 500, '事务记录 candidate 与 writer 回执不一致');
  }
  if (await fileFingerprint(deckPath) !== result.fingerprint) {
    throw adapterError('WRITE_FAILED', 500, '写入 Deck 回执与官方文件指纹不一致');
  }
  return result;
}

function authCookieName(token) {
  const sessionId = createHash('sha256').update(token).digest('hex').slice(0, 16);
  return `huawei_deck_editor_${sessionId}`;
}

function cookieValue(request, name) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function authorize(request, url, token, serviceOrigin) {
  if (request.headers.origin !== undefined) {
    let suppliedOrigin;
    try { suppliedOrigin = new URL(request.headers.origin).origin; }
    catch { throw httpError('FORBIDDEN', 403, '请求 Origin 无效'); }
    if (suppliedOrigin !== serviceOrigin) {
      throw httpError('FORBIDDEN', 403, '请求 Origin 不属于当前本地编辑服务');
    }
  }
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const cookieToken = cookieValue(request, authCookieName(token));
  if (url.searchParams.get('token') !== token && bearer !== token && cookieToken !== token) {
    throw httpError('FORBIDDEN', 403, '无权访问本地编辑服务');
  }
}

function isProtected(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/preview'
    || pathname === '/editor' || pathname.startsWith('/editor/')
    || pathname === '/events';
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw httpError('BODY_TOO_LARGE', 413, '请求体过大');
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw httpError('INVALID_JSON', 400, '请求体不是有效 JSON');
  }
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError('INVALID_INPUT', 400, 'expectedRevision 必须为非负整数');
  }
  return value;
}

function requireTaskId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw httpError('INVALID_INPUT', 400, 'taskId 必须为 null 或非空字符串');
  }
  return value;
}

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function send(response, statusCode, body, contentType, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

async function sendEditorIndex(request, response, url, token, editorToken, serviceOrigin) {
  authorize(request, url, token, serviceOrigin);
  if (url.searchParams.get('editorToken') !== editorToken) {
    throw httpError('FORBIDDEN', 403, '缺少编辑器能力令牌');
  }
  const contents = await readFile(join(PUBLIC_DIR, 'index.html'));
  send(response, 200, contents, 'text/html; charset=utf-8', {
    'set-cookie': `${authCookieName(token)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
  });
}

function injectPreviewBridge(contents) {
  let preview = contents.replace(
    /(<script\b[^>]*?\bsrc=)(["'])(?:\.\.\/)+runtime\/patch-runtime\.js\2/gi,
    '$1$2/editor/patch-runtime.js$2',
  );
  const tags = [];
  if (!/<script\b[^>]*\bsrc=["']\/editor\/html2canvas\.min\.js["'][^>]*>/i.test(preview)) {
    tags.push('<script src="/editor/html2canvas.min.js"></script>');
  }
  if (!/<script\b[^>]*\bsrc=["']\/editor\/frame-bridge\.mjs["'][^>]*>/i.test(preview)) {
    tags.push('<script type="module" src="/editor/frame-bridge.mjs"></script>');
  }
  if (!tags.length) return preview;
  const injection = `${tags.join('\n')}\n`;
  const bodyEnd = preview.toLowerCase().lastIndexOf('</body>');
  if (bodyEnd < 0) return `${preview}\n${injection}`;
  preview = `${preview.slice(0, bodyEnd)}${injection}${preview.slice(bodyEnd)}`;
  return preview;
}

function errorResponse(response, error) {
  let statusCode = error?.statusCode;
  let code = error?.code;
  if (error instanceof RevisionConflict) {
    statusCode = 409;
    code = 'REVISION_CONFLICT';
  } else if (error instanceof TypeError || error instanceof RangeError || error instanceof URIError) {
    statusCode ??= 400;
    code ??= 'INVALID_INPUT';
  }
  statusCode ??= 500;
  code ??= 'INTERNAL_ERROR';
  const safeMessages = new Set([
    'JOURNAL_PERSIST_FAILED', 'EDITOR_SYNC_REQUIRED', 'VERIFY_FAILED', 'WRITE_FAILED',
  ]);
  const message = statusCode === 500 && !safeMessages.has(code) ? '服务内部错误' : error.message;
  const details = {};
  if (typeof error?.failedActionId === 'string') details.failedActionId = error.failedActionId;
  if (Array.isArray(error?.candidates)) details.candidates = error.candidates.slice(0, 5);
  if (typeof error?.committed === 'boolean') details.committed = error.committed;
  if (typeof error?.commitConfirmed === 'boolean') details.commitConfirmed = error.commitConfirmed;
  if (typeof error?.recoveredBySync === 'boolean') details.recoveredBySync = error.recoveredBySync;
  if (Number.isSafeInteger(error?.revision)) details.revision = error.revision;
  if (typeof error?.groupId === 'string') details.groupId = error.groupId;
  if (typeof error?.stage === 'string') details.stage = error.stage;
  if (typeof error?.recovery === 'string') details.recovery = error.recovery;
  if (typeof error?.diagnostic === 'string') details.diagnostic = error.diagnostic;
  if (typeof error?.candidate === 'string') details.candidate = error.candidate;
  if (typeof error?.backup === 'string') details.backup = error.backup;
  if (typeof error?.expectedFingerprint === 'string') details.expectedFingerprint = error.expectedFingerprint;
  if (typeof error?.actualFingerprint === 'string') details.actualFingerprint = error.actualFingerprint;
  if (Array.isArray(error?.blockers)) details.blockers = error.blockers;
  json(response, statusCode, { error: code, code, message, ...details });
}

function runWritePatches(deckPath, sessionDir, patches, expectedFingerprint, transactionId, {
  spawnWriter,
  timeoutMs,
  killGraceMs,
  activeWriters,
  onActiveWritersChange,
}) {
  const adapterPath = join(EDITOR_DIR, 'bundle_adapter.py');
  const program = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("bundle_adapter",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'patches=json.load(sys.stdin)',
    'print(json.dumps(module.write_patches_safe(sys.argv[2],patches,sys.argv[3],sys.argv[4],sys.argv[5]),ensure_ascii=False))',
  ].join(';');
  return new Promise((resolvePromise, reject) => {
    const child = spawnWriter('python3', [
      '-c', program, adapterPath, deckPath, sessionDir, expectedFingerprint, transactionId,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let requestSettled = false;
    let processFinalized = false;
    let cancelStarted = false;
    let resolveClosed;
    const closed = new Promise(resolveClosedPromise => { resolveClosed = resolveClosedPromise; });
    let requestTimer;
    let killGraceTimer;
    const absorbLateError = () => {};
    const notifyActiveWriters = () => {
      try {
        onActiveWritersChange(activeWriters.size);
      } catch {
        // 测试/诊断 hook 不得影响 writer 生命周期。
      }
    };
    const settleRequest = (error, value) => {
      if (requestSettled) return;
      requestSettled = true;
      clearTimeout(requestTimer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const finalizeProcess = ({ force = false } = {}) => {
      if (processFinalized) return;
      processFinalized = true;
      clearTimeout(requestTimer);
      clearTimeout(killGraceTimer);
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.stdin.removeListener('error', onStdinError);
      child.on('error', absorbLateError);
      child.stdin.on('error', absorbLateError);
      if (force) {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            stream.destroy?.();
          } catch {
            // 强制收敛阶段只做尽力清理。
          }
        }
        child.unref?.();
      }
      if (activeWriters.delete(child)) notifyActiveWriters();
      resolveClosed();
    };
    const cancel = error => {
      settleRequest(error);
      if (cancelStarted || processFinalized) return;
      cancelStarted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        finalizeProcess({ force: true });
        return;
      }
      if (!processFinalized) {
        killGraceTimer = setTimeout(() => finalizeProcess({ force: true }), killGraceMs);
        killGraceTimer.unref?.();
      }
    };
    const onStdoutData = chunk => { stdout += chunk; };
    const onStderrData = chunk => { stderr += chunk; };
    const onStdinError = error => {
      if (!requestSettled) {
        cancel(adapterError(
          'WRITE_DECK_IO_ERROR', 502, `写入 Deck 输入失败：${error.code ?? 'IO_ERROR'}`,
        ));
      }
    };
    const onChildError = error => {
      settleRequest(adapterError(
        'WRITE_FAILED', 500, `无法启动 Deck 保存适配器：${error.code ?? error.message}`,
      ));
      finalizeProcess();
    };
    const onChildClose = code => {
      if (!requestSettled) {
        if (code !== 0) {
          settleRequest(adapterError(
            'WRITE_FAILED', 500, stderr.trim() || `写入 Deck 进程退出码 ${code}`,
          ));
        } else {
          try {
            const resultLine = stdout.trim().split(/\r?\n/).at(-1);
            const result = JSON.parse(resultLine);
            if (result?.ok === false) {
              const statuses = {
                DECK_CHANGED:409, VERIFY_FAILED:500, WRITE_FAILED:500,
              };
              settleRequest(Object.assign(
                httpError(result.code ?? 'WRITE_FAILED', statuses[result.code] ?? 500,
                  result.message ?? '写回 Deck 失败'),
                {
                  stage:result.stage ?? 'write',
                  recovery:result.recovery ?? '检查诊断信息后重试',
                  diagnostic:result.diagnostic,
                  candidate:result.candidate,
                },
              ));
            } else if (result?.ok === true) {
              settleRequest(null, result);
            } else {
              settleRequest(adapterError('WRITE_FAILED', 500, '写入 Deck 未返回明确成功状态'));
            }
          } catch {
            settleRequest(adapterError('WRITE_FAILED', 500, '写入 Deck 返回无效结果'));
          }
        }
      }
      finalizeProcess();
    };
    activeWriters.set(child, { cancel, closed });
    notifyActiveWriters();
    requestTimer = setTimeout(() => {
      cancel(adapterError('WRITE_DECK_TIMEOUT', 504, '写入 Deck 超时'));
    }, timeoutMs);
    requestTimer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.stdin.on('error', onStdinError);
    child.once('error', onChildError);
    child.once('close', onChildClose);
    try {
      child.stdin.end(JSON.stringify(patches));
    } catch (error) {
      cancel(httpError('WRITE_DECK_IO_ERROR', 502, `写入 Deck 输入失败：${error.code ?? 'IO_ERROR'}`));
    }
  });
}

async function runWriteTransaction({
  deckPath,
  sessionDir,
  expectedFingerprint,
  runWriter,
}) {
  const transactionId = randomUUID();
  let backupRecord;
  try {
    backupRecord = await ensureTransactionBackup(deckPath, sessionDir, expectedFingerprint);
    await pruneTransactionRecords(sessionDir);
  } catch (error) {
    if (error?.code === 'DECK_CHANGED') throw error;
    throw adapterError('WRITE_FAILED', 500, `无法建立可信事务备份：${error.message}`);
  }
  try {
    const result = await runWriter(transactionId);
    await validateWriterResult(
      deckPath, sessionDir, result, backupRecord, transactionId,
    );
    await removeTransactionRecord(sessionDir, transactionId);
    return result;
  } catch (error) {
    const actualFingerprint = await fileFingerprint(deckPath).catch(readError => (
      `unavailable:${readError.code ?? 'READ_ERROR'}`
    ));
    let transaction;
    try {
      transaction = await readTransactionRecord(
        deckPath,
        sessionDir,
        transactionId,
        expectedFingerprint,
        backupRecord,
      );
    } catch (recordError) {
      if (actualFingerprint === expectedFingerprint) throw error;
      if (error?.code === 'DECK_CHANGED') {
        Object.assign(error, { expectedFingerprint, actualFingerprint });
        throw error;
      }
      throw restoreConflictError(
        expectedFingerprint,
        actualFingerprint,
        'writer 失败且缺少可信 transaction，保留当前磁盘 Deck',
        recordError,
      );
    }
    try {
      if (actualFingerprint === expectedFingerprint) throw error;
      if (actualFingerprint !== transaction.record.candidateFingerprint) {
        throw restoreConflictError(
          transaction.record.candidateFingerprint,
          actualFingerprint,
          'writer 失败后磁盘 Deck 已是第三方版本，拒绝恢复旧文件',
          error,
        );
      }
      await restoreDeckBackup(
        deckPath,
        sessionDir,
        backupRecord,
        expectedFingerprint,
        transaction.record.candidateFingerprint,
      );
      throw error;
    } finally {
      await removeTransactionRecord(sessionDir, transactionId);
    }
  }
}

export async function startServer({
  deckPath,
  host = '127.0.0.1',
  port = 0,
  openBrowser = false,
  token = randomUUID(),
  editorToken = randomUUID(),
  bridgeTimeoutMs = 10_000,
  writerTimeoutMs = 10_000,
  writerKillGraceMs = 250,
  spawnWriter = spawn,
  onActiveWritersChange = () => {},
} = {}) {
  void openBrowser;
  if (!deckPath) throw new TypeError('缺少 deckPath');
  const normalizedHost = String(host).toLowerCase();
  const ipv4Loopback = isIP(normalizedHost) === 4 && normalizedHost.startsWith('127.');
  if (!ipv4Loopback && normalizedHost !== '::1' && normalizedHost !== 'localhost') {
    throw httpError('INVALID_HOST', 400, '编辑服务只允许监听 loopback 地址');
  }
  host = normalizedHost;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const absoluteDeckPath = resolve(deckPath);
  let sidecarBoundary;
  try {
    sidecarBoundary = await prepareSidecarBoundary(
      absoluteDeckPath,
      await fileFingerprint(absoluteDeckPath),
    );
  } catch (error) {
    throw unsafeSidecarError('sidecar 路径不可信，拒绝启动编辑服务', error);
  }
  const sessionStore = await SessionStore.open({
    deckPath:absoluteDeckPath,
    rootDir:sidecarBoundary.sidecarRoot,
  });
  if (resolve(sessionStore.sessionDir) !== resolve(sidecarBoundary.sessionDir)) {
    throw unsafeSidecarError('Deck 在 sidecar 初始化期间发生变化，请重试');
  }
  const bridge = new BridgeService({ sessionStore, timeoutMs: bridgeTimeoutMs });
  const webSockets = new WebSocketServer({ noServer: true });
  const activeWriters = new Map();
  let watcherClosed = false;
  let watcherGeneration = 0;
  let watcherQueue = Promise.resolve();
  let serviceOrigin;

  const broadcast = (type, revision, payload) => {
    const message = JSON.stringify({ type, revision, payload });
    for (const client of webSockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const watchListener = () => {
    const generation = watcherGeneration;
    watcherQueue = watcherQueue.then(async () => {
      if (watcherClosed || generation !== watcherGeneration) return;
      const changed = await bridge.noteDeckFingerprint(async () => {
        try { return await fileFingerprint(absoluteDeckPath); }
        catch (error) { return `unavailable:${error.code ?? 'READ_ERROR'}`; }
      });
      if (!watcherClosed && generation === watcherGeneration && changed) {
        broadcast('deck-conflict', sessionStore.state.revision, sessionStore.state.conflict);
      }
    }).catch(() => {});
  };

  const server = createServer(async (request, response) => {
    response.once('finish', () => {
      if (watcherClosed) server.closeIdleConnections?.();
    });
    try {
      const url = new URL(request.url ?? '/', `http://${urlHost}`);
      const { pathname } = url;
      if (isProtected(pathname)) authorize(request, url, token, serviceOrigin);

      if (request.method === 'GET' && pathname === '/') {
        await sendEditorIndex(request, response, url, token, editorToken, serviceOrigin);
        return;
      }

      if (request.method === 'GET' && pathname === '/api/session') {
        json(response, 200, sessionStore.state);
        return;
      }
      if (request.method === 'GET' && pathname === '/api/tasks') {
        json(response, 200, sessionStore.state.tasks);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/tasks') {
        const { expectedRevision, ...input } = await readJson(request);
        requireRevision(expectedRevision);
        validateTask(input);
        const result = await bridge.createTask(input, expectedRevision);
        broadcast('task-created', result.revision, result.task);
        json(response, 201, result);
        return;
      }
      const taskMatch = request.method === 'GET' && pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const task = sessionStore.state.tasks.find(candidate => candidate.id === id);
        if (!task) throw httpError('TASK_NOT_FOUND', 404, '找不到任务');
        json(response, 200, task);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/actions') {
        const { expectedRevision, taskId, actions } = await readJson(request);
        requireRevision(expectedRevision);
        requireTaskId(taskId);
        if (!Array.isArray(actions) || actions.length === 0) {
          throw httpError('INVALID_INPUT', 400, 'actions 必须为非空数组');
        }
        actions.forEach(validateAction);
        if (new Set(actions.map(action => action.id)).size !== actions.length) {
          throw httpError('DUPLICATE_ACTION_ID', 400, '同一批次 action id 不得重复');
        }
        const result = await bridge.applyActions({ taskId, actions, expectedRevision });
        broadcast('actions-recorded', result.revision, result);
        json(response, 200, result);
        return;
      }
      const groupMatch = request.method === 'POST'
        && pathname.match(/^\/api\/groups\/([^/]+)\/(undo|redo)$/);
      if (groupMatch) {
        const groupId = decodeURIComponent(groupMatch[1]);
        const { expectedRevision } = await readJson(request);
        requireRevision(expectedRevision);
        const result = groupMatch[2] === 'undo'
          ? await bridge.undoGroup(groupId, expectedRevision)
          : await bridge.redoGroup(groupId, expectedRevision);
        broadcast(`group-${groupMatch[2] === 'undo' ? 'undone' : 'redone'}`, result.revision, result);
        json(response, 200, result);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/write-deck') {
        const { expectedRevision } = await readJson(request);
        requireRevision(expectedRevision);
        let result;
        try {
          result = await bridge.writeDeck(
            expectedRevision,
            {
              fingerprint:() => fileFingerprint(absoluteDeckPath),
              writer:(patches, expectedFingerprint) => runWriteTransaction({
                deckPath:absoluteDeckPath,
                sessionDir:sessionStore.sessionDir,
                expectedFingerprint,
                runWriter:transactionId => runWritePatches(
                  absoluteDeckPath,
                  sessionStore.sessionDir,
                  patches,
                  expectedFingerprint,
                  transactionId,
                  {
                    spawnWriter,
                    timeoutMs: writerTimeoutMs,
                    killGraceMs: writerKillGraceMs,
                    activeWriters,
                    onActiveWritersChange,
                  },
                ),
              }),
              restore:(writerResult, expectedFingerprint) => restoreDeckBackup(
                absoluteDeckPath,
                sessionStore.sessionDir,
                { backupPath:resolve(writerResult.backup) },
                expectedFingerprint,
                writerResult.fingerprint,
              ),
            },
          );
        } catch (error) {
          if (error?.conflictCreated === true) {
            broadcast('deck-conflict', sessionStore.state.revision, sessionStore.state.conflict);
          }
          throw error;
        }
        json(response, 200, { revision: sessionStore.state.revision, ...result });
        return;
      }
      if (request.method === 'GET' && pathname === '/preview') {
        const contents = await readFile(absoluteDeckPath, 'utf8');
        const preview = injectPreviewBridge(contents);
        send(response, 200, preview, 'text/html; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && (pathname === '/editor' || pathname === '/editor/')) {
        await sendEditorIndex(request, response, url, token, editorToken, serviceOrigin);
        return;
      }
      if (request.method === 'GET' && EDITOR_ASSETS.has(pathname)) {
        const asset = EDITOR_ASSETS.get(pathname);
        const contents = await readFile(asset.path);
        send(response, 200, contents, asset.type);
        return;
      }
      if (request.method === 'GET' && (pathname === '/editor' || pathname.startsWith('/editor/'))) {
        throw httpError('EDITOR_ASSET_NOT_FOUND', 404, `编辑器资源不存在：${pathname}`);
      }
      if (request.method === 'GET' && pathname === '/events') {
        response.setHeader('upgrade', 'websocket');
        throw httpError('WEBSOCKET_UPGRADE_REQUIRED', 426, '请使用 WebSocket 连接');
      }
      throw httpError('NOT_FOUND', 404, '资源不存在');
    } catch (error) {
      errorResponse(response, error);
    }
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url ?? '/', `http://${urlHost}`);
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (url.pathname !== '/events' || url.searchParams.get('token') !== token) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (request.headers.origin !== undefined) {
      let suppliedOrigin;
      try { suppliedOrigin = new URL(request.headers.origin).origin; }
      catch { suppliedOrigin = null; }
      if (suppliedOrigin !== serviceOrigin) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
    }
    const suppliedEditorToken = url.searchParams.get('editorToken');
    const isEditor = suppliedEditorToken === editorToken;
    if (suppliedEditorToken !== null && !isEditor) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (isEditor && bridge.hasEditorSocket()) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    webSockets.handleUpgrade(request, socket, head, client => {
      client.isEditor = isEditor;
      webSockets.emit('connection', client, request);
    });
  });

  webSockets.on('connection', socket => {
    if (socket.isEditor) bridge.setEditorSocket(socket);
    socket.on('message', data => bridge.handleMessage(socket, data));
    socket.on('close', () => {
      if (socket.isEditor) bridge.clearEditorSocket(socket);
    });
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${urlHost}:${actualPort}`;
  serviceOrigin = url;
  const wsUrl = `ws://${urlHost}:${actualPort}/events`;
  const editorWsUrl = `${wsUrl}?token=${encodeURIComponent(token)}&editorToken=${encodeURIComponent(editorToken)}`;
  let closePromise;
  watchFile(absoluteDeckPath, { interval:500 }, watchListener);

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      watcherClosed = true;
      watcherGeneration += 1;
      unwatchFile(absoluteDeckPath, watchListener);
      await watcherQueue;
      bridge.close();
      const writerClosed = [];
      for (const writer of activeWriters.values()) {
        writerClosed.push(writer.closed);
        writer.cancel(httpError('SERVICE_CLOSED', 503, '服务已关闭'));
      }
      for (const client of webSockets.clients) client.terminate();
      const webSocketClosed = new Promise(resolvePromise => webSockets.close(() => resolvePromise()));
      const httpClosed = new Promise(resolvePromise => server.close(() => resolvePromise()));
      await new Promise(resolvePromise => setImmediate(resolvePromise));
      server.closeIdleConnections?.();
      const writersSettled = Promise.allSettled(writerClosed);
      await Promise.all([
        webSocketClosed,
        httpClosed,
        writersSettled,
      ]);
      server.closeAllConnections?.();
    })();
    return closePromise;
  };

  return {
    url,
    wsUrl,
    token,
    editorToken,
    editorWsUrl,
    port: actualPort,
    deckPath: absoluteDeckPath,
    sessionDir: sessionStore.sessionDir,
    session: sessionStore.state,
    close,
  };
}

function serverHelp() {
  return [
    '用法: node scripts/editor/server.mjs <deck> [选项]',
    '',
    '选项:',
    '  --host HOST   监听地址（默认 127.0.0.1）',
    '  --port PORT   监听端口（默认 0，自动分配）',
    '  --no-open     不自动打开浏览器',
    '  --help        显示帮助',
  ].join('\n');
}

function parseServerArguments(argv) {
  let deckPath;
  let host = '127.0.0.1';
  let port = 0;
  let openBrowser = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--no-open') {
      openBrowser = false;
      continue;
    }
    if (argument === '--host' || argument === '--port') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new TypeError(`${argument} 缺少值`);
      if (argument === '--host') host = value;
      else {
        port = Number(value);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
          throw new TypeError('--port 必须是 0 到 65535 的整数');
        }
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new TypeError(`未知参数: ${argument}`);
    if (deckPath) throw new TypeError(`多余参数: ${argument}`);
    deckPath = argument;
  }
  if (!deckPath) throw new TypeError('缺少 deck 文件');
  return { help: false, deckPath, host, port, openBrowser };
}

export function buildOpenCommand(platform, editorUrl) {
  if (platform === 'darwin') return { command: 'open', args: [editorUrl] };
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', editorUrl],
    };
  }
  return { command: 'xdg-open', args: [editorUrl] };
}

function openEditor(editorUrl) {
  const { command, args } = buildOpenCommand(process.platform, editorUrl);
  const opener = spawn(command, args, { detached: true, stdio: 'ignore' });
  opener.once('error', () => {});
  opener.unref();
}

export async function runServerCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseServerArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${serverHelp()}\n`);
    return 0;
  }

  let app;
  try {
    app = await startServer({
      deckPath: options.deckPath,
      host: options.host,
      port: options.port,
      openBrowser: false,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const editorUrl = `${app.url}/editor/?token=${encodeURIComponent(app.token)}`
    + `&editorToken=${encodeURIComponent(app.editorToken)}`;
  process.stdout.write(`${JSON.stringify({ url: app.url, token: app.token, editorUrl })}\n`);
  if (options.openBrowser) openEditor(editorUrl);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runServerCli();
}
