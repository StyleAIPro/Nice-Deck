import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenCommand, startServer } from './server.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const APP_PUBLIC_DIR = join(EDITOR_DIR, 'app-public');
const APP_ASSETS = new Map([
  ['/app/app.css', { path:join(APP_PUBLIC_DIR, 'app.css'), type:'text/css; charset=utf-8' }],
  ['/app/app.mjs', { path:join(APP_PUBLIC_DIR, 'app.mjs'), type:'text/javascript; charset=utf-8' }],
  ['/app/huawei-logo.png', {
    path:join(PROJECT_DIR, 'assets/huawei-refs/logos/huawei-横版logo-透明.png'),
    type:'image/png',
  }],
]);

function loopbackHost(host) {
  const normalized = String(host).toLowerCase();
  const ipv4Loopback = isIP(normalized) === 4 && normalized.startsWith('127.');
  if (!ipv4Loopback && normalized !== '::1' && normalized !== 'localhost') {
    throw new TypeError('导入页只允许监听 loopback 地址');
  }
  return normalized;
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual ?? ''));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'cache-control':'no-store',
    'content-type':'application/json; charset=utf-8',
    'x-content-type-options':'nosniff',
  });
  response.end(JSON.stringify(body));
}

function pickerError(message, code = 'PICK_FAILED') {
  return Object.assign(new Error(message), { code });
}

export function pickDeckWithSystemPicker({
  pythonExecutable = 'python3',
  signal,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(
      pythonExecutable,
      [join(PROJECT_DIR, 'scripts/deck-editor.py'), '--pick-only'],
      { cwd:PROJECT_DIR, stdio:['ignore', 'pipe', 'pipe'], signal },
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = target => chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        child.kill();
        reject(pickerError('文件选择器返回内容过大'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', error => reject(error));
    child.once('close', code => {
      if (code === 3) {
        resolvePromise(null);
        return;
      }
      if (code !== 0) {
        reject(pickerError(
          Buffer.concat(stderr).toString('utf8').trim() || '系统文件选择器异常退出',
        ));
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (typeof payload.deckPath !== 'string' || !payload.deckPath) {
          throw new Error('缺少 deckPath');
        }
        resolvePromise(payload.deckPath);
      } catch (error) {
        reject(pickerError(`无法解析文件选择结果：${error.message}`));
      }
    });
  });
}

export async function startAppServer({
  host = '127.0.0.1',
  port = 0,
  token = randomUUID(),
  pythonExecutable = 'python3',
  pickDeck = options => pickDeckWithSystemPicker({ pythonExecutable, ...options }),
  startEditor = options => startServer(options),
  editorCloseGraceMs = 10_000,
  agentProvider = 'codex',
} = {}) {
  host = loopbackHost(host);
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const appHtml = await readFile(join(APP_PUBLIC_DIR, 'index.html'), 'utf8');
  let state = 'idle';
  let serviceOrigin = '';
  let editorApp = null;
  let activePicker = null;
  let launcherClosePromise = null;
  let appClosePromise = null;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', serviceOrigin || `http://${urlHost}`);
    if (!tokenMatches(requestUrl.searchParams.get('token'), token)) {
      sendJson(response, 403, { code:'FORBIDDEN', message:'导入页令牌无效' });
      return;
    }

    if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/app/')) {
      const html = appHtml.replaceAll('__APP_TOKEN__', encodeURIComponent(token));
      response.writeHead(200, {
        'cache-control':'no-store',
        'content-security-policy':[
          "default-src 'self'", "script-src 'self'", "style-src 'self'",
          "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'",
          "form-action 'none'", "frame-ancestors 'none'",
        ].join('; '),
        'content-type':'text/html; charset=utf-8',
        'x-content-type-options':'nosniff',
      });
      response.end(html);
      return;
    }

    const asset = APP_ASSETS.get(requestUrl.pathname);
    if (request.method === 'GET' && asset) {
      try {
        const bytes = await readFile(asset.path);
        response.writeHead(200, {
          'cache-control':'no-store',
          'content-type':asset.type,
          'x-content-type-options':'nosniff',
        });
        response.end(bytes);
      } catch {
        sendJson(response, 404, { code:'NOT_FOUND', message:'导入页资源不存在' });
      }
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/close') {
      response.writeHead(204, { 'cache-control':'no-store' });
      response.end();
      if (state !== 'selected') state = 'closed';
      setImmediate(() => void closeLauncher());
      return;
    }

    if (request.method !== 'POST' || requestUrl.pathname !== '/api/choose-deck') {
      sendJson(response, 404, { code:'NOT_FOUND', message:'接口不存在' });
      return;
    }
    if (request.headers.origin !== serviceOrigin) {
      sendJson(response, 403, { code:'FORBIDDEN', message:'只接受导入页自身发起的请求' });
      return;
    }
    if (state === 'choosing') {
      sendJson(response, 409, {
        code:'DECK_SELECTION_IN_PROGRESS', message:'系统文件选择器已经打开',
      });
      return;
    }
    if (state === 'selected') {
      sendJson(response, 409, {
        code:'DECK_ALREADY_SELECTED', message:'本次启动已经添加过一份 HTML',
      });
      return;
    }
    if (state === 'closed') {
      sendJson(response, 410, { code:'APP_CLOSED', message:'导入页已经关闭' });
      return;
    }

    state = 'choosing';
    activePicker = new AbortController();
    let deckPath;
    try {
      deckPath = await pickDeck({ signal:activePicker.signal });
    } catch (error) {
      activePicker = null;
      if (state === 'closed') {
        response.destroy();
        return;
      }
      state = 'idle';
      sendJson(response, 500, {
        code:error.code ?? 'PICK_FAILED', message:error.message || '无法打开系统文件选择器',
      });
      return;
    }
    activePicker = null;
    if (state === 'closed') {
      response.destroy();
      return;
    }
    if (!deckPath) {
      state = 'idle';
      sendJson(response, 200, { status:'cancelled' });
      return;
    }

    try {
      editorApp = await startEditor({
        deckPath,
        host,
        port:0,
        openBrowser:false,
        exitWhenEditorCloses:true,
        editorCloseGraceMs,
        agentProvider,
        agentThreadId:null,
      });
    } catch (error) {
      state = 'idle';
      sendJson(response, 500, {
        code:error.code ?? 'EDITOR_START_FAILED', message:error.message || '编辑器启动失败',
      });
      return;
    }

    state = 'selected';
    const editorUrl = `${editorApp.url}/editor/?token=${encodeURIComponent(editorApp.token)}`
      + `&editorToken=${encodeURIComponent(editorApp.editorToken)}`;
    sendJson(response, 200, { status:'selected', deckName:basename(deckPath), editorUrl });
    setImmediate(() => void closeLauncher());
  });

  const closeLauncher = () => {
    if (launcherClosePromise) return launcherClosePromise;
    activePicker?.abort();
    activePicker = null;
    launcherClosePromise = new Promise(resolvePromise => {
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
    });
    return launcherClosePromise;
  };

  const close = () => {
    if (appClosePromise) return appClosePromise;
    if (state !== 'selected') state = 'closed';
    appClosePromise = Promise.allSettled([
      closeLauncher(),
      editorApp?.close?.() ?? Promise.resolve(),
    ]).then(results => {
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(
        failures.map(result => result.reason), '关闭桌面导入入口失败',
      );
    });
    return appClosePromise;
  };

  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
  } catch (error) {
    await closeLauncher();
    throw error;
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  serviceOrigin = `http://${urlHost}:${actualPort}`;
  return {
    url:serviceOrigin,
    appUrl:`${serviceOrigin}/app/?token=${encodeURIComponent(token)}`,
    port:actualPort,
    token,
    get state() { return state; },
    get editorApp() { return editorApp; },
    close,
  };
}

function appHelp() {
  return [
    '用法: node scripts/editor/app-server.mjs [选项]',
    '',
    '选项:',
    '  --host HOST      监听地址（默认 127.0.0.1）',
    '  --port PORT      导入页端口（默认 0，自动分配）',
    '  --python PATH    Python 启动器路径',
    '  --agent-provider ID  新建会话的默认 Agent provider（默认 codex）',
    '  --no-open        不自动打开浏览器',
    '  --help           显示帮助',
  ].join('\n');
}

function parseArguments(argv) {
  let host = '127.0.0.1';
  let port = 0;
  let pythonExecutable = 'python3';
  let openBrowser = true;
  let agentProvider = 'codex';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help:true };
    if (argument === '--no-open') {
      openBrowser = false;
      continue;
    }
    if (argument === '--host' || argument === '--port' || argument === '--python'
      || argument === '--agent-provider') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new TypeError(`${argument} 缺少值`);
      if (argument === '--host') host = value;
      else if (argument === '--python') pythonExecutable = value;
      else if (argument === '--agent-provider') agentProvider = value;
      else {
        port = Number(value);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
          throw new TypeError('--port 必须是 0 到 65535 的整数');
        }
      }
      index += 1;
      continue;
    }
    throw new TypeError(`未知参数: ${argument}`);
  }
  return { help:false, host, port, pythonExecutable, openBrowser, agentProvider };
}

function openPage(url) {
  const { command, args } = buildOpenCommand(process.platform, url);
  const opener = spawn(command, args, { detached:true, stdio:'ignore' });
  opener.once('error', () => {});
  opener.unref();
}

export async function runAppServerCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${appHelp()}\n`);
    return 0;
  }

  let app;
  try {
    app = await startAppServer(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ url:app.url, appUrl:app.appUrl })}\n`);
  if (options.openBrowser) openPage(app.appUrl);

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
  process.exitCode = await runAppServerCli();
}
