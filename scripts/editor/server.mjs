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
    'print(json.dumps(module.write_patches(sys.argv[2],patches,sys.argv[3]),ensure_ascii=False))',
  ].join(';');
  return new Promise((resolvePromise, reject) => {
    const child = spawnWriter('python3', ['-c', program, adapterPath, deckPath, sessionDir], {
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
        cancel(httpError('WRITE_DECK_IO_ERROR', 502, `写入 Deck 输入失败：${error.code ?? 'IO_ERROR'}`));
      }
    };
    const onChildError = error => {
      settleRequest(error);
      finalizeProcess();
    };
    const onChildClose = code => {
      if (!requestSettled) {
        if (code !== 0) {
          settleRequest(new Error(stderr.trim() || `写入 Deck 进程退出码 ${code}`));
        } else {
          try {
            const resultLine = stdout.trim().split(/\r?\n/).at(-1);
            settleRequest(null, JSON.parse(resultLine));
          } catch {
            settleRequest(new Error('写入 Deck 返回无效结果'));
          }
        }
      }
      finalizeProcess();
    };
    activeWriters.set(child, { cancel, closed });
    notifyActiveWriters();
    requestTimer = setTimeout(() => {
      cancel(httpError('WRITE_DECK_TIMEOUT', 504, '写入 Deck 超时'));
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

export async function startServer({
  deckPath,
  host = '127.0.0.1',
  port = 0,
  openBrowser = false,
  token = randomUUID(),
  editorToken = randomUUID(),
  writerTimeoutMs = 10_000,
  writerKillGraceMs = 250,
  spawnWriter = spawn,
  onActiveWritersChange = () => {},
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
        requireTaskId(taskId);
        if (!Array.isArray(actions) || actions.length === 0) {
          throw httpError('INVALID_INPUT', 400, 'actions 必须为非空数组');
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
            killGraceMs: writerKillGraceMs,
            activeWriters,
            onActiveWritersChange,
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
