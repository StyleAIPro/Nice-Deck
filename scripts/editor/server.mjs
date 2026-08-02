import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeService } from './bridge-service.mjs';
import { validateAction, validateTask } from './protocol.mjs';
import { RevisionConflict, SessionStore } from './session-store.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1024 * 1024;

function httpError(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

function authorize(request, url, token) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (url.searchParams.get('token') !== token && bearer !== token) {
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
      throw httpError('BODY_TOO_LARGE', 400, '请求体过大');
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

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
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
  const message = statusCode === 500 ? '服务内部错误' : error.message;
  json(response, statusCode, { error: code, message });
}

function runWritePatches(deckPath, sessionDir, patches, {
  spawnWriter,
  timeoutMs,
  activeWriters,
}) {
  const adapterPath = join(EDITOR_DIR, 'bundle_adapter.py');
  const program = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("bundle_adapter",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'patches=json.load(sys.stdin)',
    'print(json.dumps(module.write_patches(sys.argv[2],patches,sys.argv[3]),ensure_ascii=False))',
  ].join(';');
  return new Promise((resolvePromise, reject) => {
    const child = spawnWriter('python3', ['-c', program, adapterPath, deckPath, sessionDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let requestSettled = false;
    let processClosed = false;
    let resolveClosed;
    const closed = new Promise(resolveClosedPromise => { resolveClosed = resolveClosedPromise; });
    let timer;
    const settleRequest = (error, value) => {
      if (requestSettled) return;
      requestSettled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const markProcessClosed = () => {
      if (processClosed) return;
      processClosed = true;
      activeWriters.delete(child);
      resolveClosed();
    };
    const cancel = error => {
      settleRequest(error);
      try {
        if (!processClosed) child.kill('SIGKILL');
      } catch {
        markProcessClosed();
      }
    };
    activeWriters.set(child, { cancel, closed });
    timer = setTimeout(() => {
      cancel(httpError('WRITE_DECK_TIMEOUT', 504, '写入 Deck 超时'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      markProcessClosed();
      settleRequest(error);
    });
    child.once('close', code => {
      markProcessClosed();
      if (requestSettled) return;
      if (code !== 0) {
        settleRequest(new Error(stderr.trim() || `写入 Deck 进程退出码 ${code}`));
        return;
      }
      try {
        const resultLine = stdout.trim().split(/\r?\n/).at(-1);
        settleRequest(null, JSON.parse(resultLine));
      } catch {
        settleRequest(new Error('写入 Deck 返回无效结果'));
      }
    });
    try {
      child.stdin.end(JSON.stringify(patches));
    } catch (error) {
      cancel(error);
    }
  });
}

export async function startServer({
  deckPath,
  host = '127.0.0.1',
  port = 0,
  openBrowser = false,
  token = randomUUID(),
  editorToken = randomUUID(),
  writerTimeoutMs = 10_000,
  spawnWriter = spawn,
} = {}) {
  void openBrowser;
  if (!deckPath) throw new TypeError('缺少 deckPath');
  const absoluteDeckPath = resolve(deckPath);
  const sessionStore = await SessionStore.open({ deckPath: absoluteDeckPath });
  const bridge = new BridgeService({ sessionStore });
  const webSockets = new WebSocketServer({ noServer: true });
  const activeWriters = new Map();

  const broadcast = (type, revision, payload) => {
    const message = JSON.stringify({ type, revision, payload });
    for (const client of webSockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      const { pathname } = url;
      if (isProtected(pathname)) authorize(request, url, token);

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
        if (!taskId || !Array.isArray(actions) || actions.length === 0) {
          throw httpError('INVALID_INPUT', 400, '动作请求缺少 taskId 或 actions');
        }
        actions.forEach(validateAction);
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
        const result = await bridge.writeDeck(
          expectedRevision,
          patches => runWritePatches(absoluteDeckPath, sessionStore.sessionDir, patches, {
            spawnWriter,
            timeoutMs: writerTimeoutMs,
            activeWriters,
          }),
        );
        json(response, 200, { revision: sessionStore.state.revision, ...result });
        return;
      }
      if (request.method === 'GET' && pathname === '/preview') {
        const contents = await readFile(absoluteDeckPath);
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': contents.length,
          'cache-control': 'no-store',
        });
        response.end(contents);
        return;
      }
      if (request.method === 'GET' && (pathname === '/editor' || pathname.startsWith('/editor/'))) {
        throw httpError('EDITOR_ASSET_NOT_FOUND', 404, `编辑器资源尚未创建：${pathname}`);
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
      url = new URL(request.url ?? '/', `http://${host}`);
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (url.pathname !== '/events' || url.searchParams.get('token') !== token) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
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
  const url = `http://${host}:${actualPort}`;
  const wsUrl = `ws://${host}:${actualPort}/events`;
  const editorWsUrl = `${wsUrl}?token=${encodeURIComponent(token)}&editorToken=${encodeURIComponent(editorToken)}`;
  let closePromise;

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
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
      let writerWaitTimer;
      const writerWaitBound = new Promise(resolvePromise => {
        writerWaitTimer = setTimeout(resolvePromise, 1_000);
        writerWaitTimer.unref?.();
      });
      await Promise.all([
        webSocketClosed,
        httpClosed,
        Promise.race([writersSettled, writerWaitBound]),
      ]);
      clearTimeout(writerWaitTimer);
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
