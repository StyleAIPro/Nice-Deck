import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import {
  mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { BridgeService } from '../bridge-service.mjs';
import { startServer } from '../server.mjs';

const taskInput = {
  expectedRevision: 0,
  pageKey: 'page-001-a',
  pageIndex: 1,
  pageLabel: 'A',
  rect: { x: 1, y: 2, w: 3, h: 4 },
  instruction: '修改',
};

const action = {
  id: 'action-1',
  taskId: 'task-1',
  target: { pageKey: 'page-001-a', path: '0/1' },
  kind: 'setText',
  payload: { text: '新文案' },
  before: '旧文案',
  after: '新文案',
};

async function makeApp(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deck-server-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, options.deckContents ?? 'deck');
  const app = await startServer({
    deckPath: deck,
    host: '127.0.0.1',
    port: 0,
    openBrowser: false,
    token: 'secret',
    editorToken: options.editorToken ?? 'editor-secret',
    bridgeTimeoutMs: options.bridgeTimeoutMs,
    writerTimeoutMs: options.writerTimeoutMs,
    writerKillGraceMs: options.writerKillGraceMs,
    spawnWriter: options.spawnWriter,
    onActiveWritersChange: options.onActiveWritersChange,
    beforeSessionPersist: options.beforeSessionPersist,
    syncDirectory: options.syncDirectory,
  });
  t.after(() => app.close());
  return app;
}

function connect(url, options) {
  const socket = new WebSocket(url, options);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = data => {
      socket.off('error', onError);
      resolve(JSON.parse(data));
    };
    const onError = error => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

async function connectDiagnosticsEditor(t, app) {
  const socket = await connect(app.editorWsUrl);
  t.after(() => socket.close());
  const page = {
    pageKey:'page-001-save-gate',
    sectionOverflow:{ x:0, y:0 },
    nestedClips:[],
  };
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.type !== 'diagnose-pages') return;
    socket.send(JSON.stringify({
      type:'diagnostics-result',
      commandId:message.commandId,
      revision:message.revision,
      pages:message.pageKeys.map(pageKey => ({ ...page, pageKey })),
    }));
  });
  socket.send(JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  const deadline = Date.now() + 1_000;
  while (!Object.keys(app.session.diagnosticsBaseline ?? {}).length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(Object.keys(app.session.diagnosticsBaseline ?? {}).length, 1);
  return socket;
}

async function prepareAndCommit(socket, command, results = command.actions) {
  socket.send(JSON.stringify({
    type: 'actions-prepared', commandId: command.commandId,
    applied: command.actions.length, results,
  }));
  const commit = await nextMessage(socket);
  assert.equal(commit.type, 'commit-actions');
  assert.equal(commit.commandId, command.commandId);
  socket.send(JSON.stringify({
    type: 'actions-committed', commandId: command.commandId, committed: true,
  }));
}

async function sendInvalidPrepared(socket, command, acknowledgement) {
  socket.send(JSON.stringify({
    type: 'actions-prepared', commandId: command.commandId,
    results: command.actions, ...acknowledgement,
  }));
  const rollback = await nextMessage(socket);
  assert.equal(rollback.type, 'rollback-actions');
  assert.equal(rollback.commandId, command.commandId);
  socket.send(JSON.stringify({
    type: 'actions-rolled-back', commandId: command.commandId, rolledBack: true,
  }));
}

function rejectedWebSocketStatus(url, options) {
  const socket = new WebSocket(url, options);
  return new Promise(resolve => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('open', () => {
      socket.terminate();
      resolve(0);
    });
    socket.once('error', () => resolve(0));
  });
}

function postJsonChunks(url, chunks) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method:'POST',
      headers:{ 'content-type':'application/json', 'transfer-encoding':'chunked' },
    }, response => {
      const responseChunks = [];
      response.on('data', chunk => responseChunks.push(chunk));
      response.once('end', () => resolve({
        status:response.statusCode,
        body:JSON.parse(Buffer.concat(responseChunks).toString('utf8')),
      }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.write(chunks[0]);
    setTimeout(() => request.end(chunks[1]), 10);
  });
}

async function createTask(app, overrides = {}) {
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...taskInput, ...overrides }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

function validBundle() {
  const template = '<!doctype html><body><div class="stage"></div></body>';
  return '<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${JSON.stringify(template)}\n</script>`;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function writeTransactionRecord(app, transactionId, oldBytes, candidateBytes) {
  const transactions = join(app.sessionDir, 'transactions');
  await mkdir(transactions, { recursive:true });
  const oldFingerprint = sha256(oldBytes);
  const candidateFingerprint = sha256(candidateBytes);
  const transactionPath = join(transactions, `${transactionId}.json`);
  await writeFile(
    join(app.sessionDir, 'backups', `deck-${oldFingerprint}.html`),
    oldBytes,
  );
  await writeFile(transactionPath, JSON.stringify({
    version:1,
    sessionId:app.session.sessionId,
    transactionId,
    deckPath:app.deckPath,
    sessionDir:app.sessionDir,
    oldFingerprint,
    candidateFingerprint,
    backup:join(app.sessionDir, 'backups', `deck-${oldFingerprint}.html`),
  }));
  return transactionPath;
}

async function createPendingTransactionFixture({
  root, diskBytes, oldBytes, candidateBytes, sessionFingerprint, registered=true,
}) {
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, diskBytes);
  const oldFingerprint = sha256(oldBytes);
  const candidateFingerprint = sha256(candidateBytes);
  const sidecarRoot = join(root, '.huawei-deck-editor');
  const sessionDir = join(sidecarRoot, `deck-${oldFingerprint.slice(0, 8)}`);
  const backup = join(sessionDir, 'backups', `deck-${oldFingerprint}.html`);
  const transactionId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionId = '223e4567-e89b-42d3-a456-426614174000';
  const transaction = join(sessionDir, 'transactions', `${transactionId}.json`);
  await mkdir(join(sessionDir, 'snapshots'), { recursive:true });
  await mkdir(join(sessionDir, 'backups'), { recursive:true });
  await mkdir(join(sessionDir, 'transactions'), { recursive:true });
  await mkdir(join(sessionDir, 'write-errors'), { recursive:true });
  await writeFile(backup, oldBytes);
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
    version:1,
    ...(registered ? { sessionId } : {}),
    deckPath,
    deckFingerprint:sessionFingerprint,
    revision:0,
    tasks:[],
    groups:[],
    redo:[],
    diagnosticsBaseline:{},
    diagnosticsCurrent:{},
    diagnosticsRevision:null,
    conflict:null,
  }, null, 2));
  await writeFile(transaction, JSON.stringify({
    version:1,
    ...(registered ? { sessionId } : {}),
    transactionId,
    deckPath,
    sessionDir,
    oldFingerprint,
    candidateFingerprint,
    backup,
  }));
  if (registered) {
    await writeFile(join(sidecarRoot, 'sessions.json'), JSON.stringify({
      version:1,
      sessions:{
        [sessionId]:{
          sessionId,
          deckRealPath:await realpath(deckPath),
          initialFingerprint:oldFingerprint,
          sessionName:`deck-${oldFingerprint.slice(0, 8)}`,
          mode:'fresh',
          status:'active',
        },
      },
    }, null, 2));
  }
  return {
    deckPath, sidecarRoot, sessionDir, backup, transaction,
    oldFingerprint, candidateFingerprint, sessionId,
  };
}

async function replaceSidecarIdentity(app, level) {
  const sidecarRoot = join(app.deckPath, '..', '.huawei-deck-editor');
  const sessionName = app.sessionDir.split('/').at(-1);
  const target = level === 'root' ? sidecarRoot : app.sessionDir;
  await rename(target, `${target}.trusted-original`);
  if (level === 'root') await mkdir(sidecarRoot);
  const replacementSession = level === 'root' ? join(sidecarRoot, sessionName) : app.sessionDir;
  await mkdir(join(replacementSession, 'snapshots'), { recursive:true });
  await mkdir(join(replacementSession, 'backups'), { recursive:true });
  await mkdir(join(replacementSession, 'transactions'), { recursive:true });
  return replacementSession;
}

async function sidecarTree(root) {
  return (await readdir(root, { recursive:true })).sort();
}

function emptySessionState(deckPath, deckFingerprint, extra = {}) {
  return {
    version:1,
    deckPath,
    deckFingerprint,
    revision:0,
    tasks:[],
    groups:[],
    redo:[],
    diagnosticsBaseline:{},
    diagnosticsCurrent:{},
    diagnosticsRevision:null,
    conflict:null,
    ...extra,
  };
}

async function makeCompleteSessionDirectory(sidecarRoot, sessionName) {
  const sessionDir = join(sidecarRoot, sessionName);
  await mkdir(join(sessionDir, 'snapshots'), { recursive:true });
  await mkdir(join(sessionDir, 'backups'));
  await mkdir(join(sessionDir, 'transactions'));
  await mkdir(join(sessionDir, 'write-errors'));
  return sessionDir;
}

function fakeWriterChild({ onEnd, onKill, closesOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = data => onEnd?.(child, data);
  child.killed = false;
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  child.kill = () => {
    child.killed = true;
    onKill?.(child);
    if (closesOnKill) queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  return child;
}

function hangingChild() {
  return fakeWriterChild();
}

function epipe() {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

test('session lock 跨 helper 进程互斥，失败方零副作用且 close 后可重启', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-lock-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  const first = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  let contender;
  try {
    const sidecarRoot = join(root, '.huawei-deck-editor');
    const treeBefore = await sidecarTree(sidecarRoot);
    const registryBefore = await readFile(join(sidecarRoot, 'sessions.json'));
    const sessionBefore = await readFile(join(first.sessionDir, 'session.json'));
    const outcome = await startServer({
      deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    }).then(app => ({ app }), error => ({ error }));
    contender = outcome.app;
    assert.equal(contender, undefined, '同一 Deck 的第二个 server 不得初始化成功');
    assert.equal(outcome.error?.code, 'SESSION_LOCKED');
    assert.equal(outcome.error?.statusCode, 409);
    assert.deepEqual(await sidecarTree(sidecarRoot), treeBefore);
    assert.deepEqual(await readFile(join(sidecarRoot, 'sessions.json')), registryBefore);
    assert.deepEqual(await readFile(join(first.sessionDir, 'session.json')), sessionBefore);
  } finally {
    await contender?.close();
    await first.close();
  }
  const restarted = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  await restarted.close();
});

test('listen 端口占用会释放 helper/lock，随后可重启', async () => {
  const holder = createNetServer();
  await new Promise((resolvePromise, reject) => {
    holder.once('error', reject);
    holder.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = holder.address().port;
  const root = await mkdtemp(join(tmpdir(), 'deck-session-lock-port-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  await assert.rejects(
    () => startServer({ deckPath, host:'127.0.0.1', port, openBrowser:false }),
    error => error.code === 'EADDRINUSE',
  );
  await new Promise(resolvePromise => holder.close(resolvePromise));
  const restarted = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  await restarted.close();
});

test('空闲 server.close 并行回收活跃 helper，50ms 内收敛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-helper-close-bound-'));
  const deckPath = join(root, 'deck.html');
  await writeFile(deckPath, 'deck');
  const app = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  const startedAt = performance.now();
  await app.close();
  assert.ok(performance.now() - startedAt < 50);
});

test('session registry 提供稳定身份，legacy 仅无 pending 时迁移，未注册新会话只读拒绝', async t => {
  await t.test('新会话发布 registry，重启复用同一随机 sessionId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-fresh-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, 'deck');
    let app = await startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false });
    const firstSessionId = app.session.sessionId;
    const firstSessionDir = app.sessionDir;
    try {
      assert.match(firstSessionId, /^[0-9a-f-]{36}$/);
      const registry = JSON.parse(await readFile(join(root, '.huawei-deck-editor', 'sessions.json')));
      assert.equal(registry.sessions[firstSessionId].sessionId, firstSessionId);
      assert.equal(registry.sessions[firstSessionId].sessionName, firstSessionDir.split('/').at(-1));
      assert.equal(
        JSON.parse(await readFile(join(firstSessionDir, 'session.json'))).sessionId,
        firstSessionId,
      );
    } finally {
      await app.close();
    }
    app = await startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false });
    try {
      assert.equal(app.sessionDir, firstSessionDir);
      assert.equal(app.session.sessionId, firstSessionId);
    } finally {
      await app.close();
    }
  });

  await t.test('无 registry 的严格 legacy 且无 pending 时一次迁移', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-legacy-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, 'legacy-deck');
    const fingerprint = sha256('legacy-deck');
    const sidecarRoot = join(root, '.huawei-deck-editor');
    const sessionName = `deck-${fingerprint.slice(0, 8)}`;
    const sessionDir = await makeCompleteSessionDirectory(sidecarRoot, sessionName);
    await writeFile(
      join(sessionDir, 'session.json'),
      JSON.stringify(emptySessionState(deckPath, fingerprint), null, 2),
    );
    const app = await startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false });
    try {
      assert.equal(app.sessionDir, sessionDir);
      assert.match(app.session.sessionId, /^[0-9a-f-]{36}$/);
      const registry = JSON.parse(await readFile(join(sidecarRoot, 'sessions.json')));
      assert.equal(registry.sessions[app.session.sessionId].sessionName, sessionName);
      assert.equal(
        JSON.parse(await readFile(join(sessionDir, 'session.json'))).sessionId,
        app.session.sessionId,
      );
    } finally {
      await app.close();
    }
  });

  await t.test('无 registry 的 pending 即使完全自洽也只读拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-pending-'));
    const oldBytes = Buffer.from('old');
    const candidateBytes = Buffer.from('candidate');
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes), registered:false,
    });
    const treeBefore = await sidecarTree(fixture.sidecarRoot);
    const deckBefore = await readFile(fixture.deckPath);
    await assert.rejects(
      () => startServer({
        deckPath:fixture.deckPath, host:'127.0.0.1', port:0, openBrowser:false,
      }),
      error => error.code === 'UNSAFE_SIDECAR',
    );
    assert.deepEqual(await sidecarTree(fixture.sidecarRoot), treeBefore);
    assert.deepEqual(await readFile(fixture.deckPath), deckBefore);
  });

  await t.test('带 sessionId 但未注册的自洽目录不得按 legacy 收编', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-registry-unregistered-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, 'unregistered');
    const fingerprint = sha256('unregistered');
    const sidecarRoot = join(root, '.huawei-deck-editor');
    const sessionName = `deck-${fingerprint.slice(0, 8)}`;
    const sessionDir = await makeCompleteSessionDirectory(sidecarRoot, sessionName);
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify(emptySessionState(
      deckPath, fingerprint, { sessionId:'123e4567-e89b-42d3-a456-426614174000' },
    )));
    const treeBefore = await sidecarTree(sidecarRoot);
    await assert.rejects(
      () => startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false }),
      error => error.code === 'UNSAFE_SIDECAR',
    );
    assert.deepEqual(await sidecarTree(sidecarRoot), treeBefore);
  });
});

test('拒绝无令牌请求并向 WebSocket 推送新任务', async t => {
  const app = await makeApp(t);
  assert.equal((await fetch(`${app.url}/api/session`)).status, 403);

  const ws = await connect(`${app.wsUrl}?token=secret`);
  t.after(() => ws.close());
  const event = nextMessage(ws);
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(taskInput),
  });

  assert.equal(response.status, 201);
  assert.equal((await event).type, 'task-created');
});

test('任务快照仅接受限额内 PNG，落盘后响应与 session 均无 data URL', async t => {
  const app = await makeApp(t);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const response = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...taskInput,
      snapshot: `data:image/png;base64,${png.toString('base64')}`,
    }),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.task.snapshot, undefined);
  assert.equal(result.task.snapshotPath, `snapshots/${result.task.id}.png`);
  assert.deepEqual(await readFile(join(app.sessionDir, result.task.snapshotPath)), png);
  assert.doesNotMatch(await readFile(join(app.sessionDir, 'session.json'), 'utf8'), /data:image\/png/);

  const bad = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...taskInput, expectedRevision: 1, snapshot: 'data:image/png;base64,bm90LXBuZw==' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'INVALID_SNAPSHOT');

  const oversized = Buffer.concat([png.subarray(0, 8), Buffer.alloc(512 * 1024, 1)]).toString('base64');
  const tooLarge = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...taskInput,
      expectedRevision: 1,
      snapshot: `data:image/png;base64,${oversized}`,
    }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, 'SNAPSHOT_TOO_LARGE');
  assert.equal(app.session.revision, 1);
});

test('所有受保护路由都拒绝无令牌请求且 Bearer 可授权', async t => {
  const app = await makeApp(t);
  const routes = [
    ['GET', '/api/session'],
    ['GET', '/api/tasks'],
    ['POST', '/api/tasks'],
    ['GET', '/api/tasks/missing'],
    ['POST', '/api/actions'],
    ['POST', '/api/groups/missing/undo'],
    ['POST', '/api/groups/missing/redo'],
    ['POST', '/api/write-deck'],
    ['GET', '/preview'],
    ['GET', '/editor/index.html'],
    ['GET', '/events'],
  ];

  for (const [method, path] of routes) {
    const response = await fetch(`${app.url}${path}`, { method });
    assert.equal(response.status, 403, `${method} ${path}`);
  }

  const authorized = await fetch(`${app.url}/api/session`, {
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).revision, 0);

  const wrongToken = new WebSocket(`${app.wsUrl}?token=wrong`);
  const rejected = await new Promise(resolve => {
    wrongToken.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    wrongToken.once('error', () => resolve(0));
  });
  assert.equal(rejected, 403);
  wrongToken.terminate();
});

test('服务只允许 loopback 监听地址', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-loopback-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck');

  for (const host of ['0.0.0.0', '::', '127.000.000.001']) {
    await t.test(`拒绝 ${host}`, async () => {
      let app;
      try {
        app = await startServer({ deckPath:deck, host, port:0, openBrowser:false });
        assert.fail(`不应监听非 loopback 地址 ${host}`);
      } catch (error) {
        if (error?.code === 'ERR_ASSERTION') throw error;
        assert.equal(error.code, 'INVALID_HOST');
      } finally {
        await app?.close();
      }
    });
  }

  for (const [name, options, expectedUrl] of [
    ['默认地址', {}, /^http:\/\/127\.0\.0\.1:/],
    ['localhost', { host:'localhost' }, /^http:\/\/localhost:/],
    ['127.0.0.1', { host:'127.0.0.1' }, /^http:\/\/127\.0\.0\.1:/],
    ['::1', { host:'::1' }, /^http:\/\/\[::1\]:/],
  ]) {
    await t.test(`接受 ${name}`, async () => {
      const app = await startServer({
        deckPath:deck, port:0, openBrowser:false, ...options,
      });
      assert.match(app.url, expectedUrl);
      await app.close();
    });
  }
});

test('携带 Origin 的 HTTP 与 WebSocket 只接受当前本地服务源', async t => {
  const app = await makeApp(t);
  const evilHttp = await fetch(`${app.url}/api/session?token=secret`, {
    headers:{ Origin:'https://evil.example' },
  });
  assert.equal(evilHttp.status, 403);

  const localHttp = await fetch(`${app.url}/api/session?token=secret`, {
    headers:{ Origin:app.url },
  });
  assert.equal(localHttp.status, 200);
  assert.equal((await fetch(`${app.url}/api/session?token=secret`)).status, 200);

  assert.equal(await rejectedWebSocketStatus(
    `${app.wsUrl}?token=secret`,
    { headers:{ Origin:'https://evil.example' } },
  ), 403);
  const localSocket = await connect(
    `${app.wsUrl}?token=secret`, { headers:{ Origin:app.url } },
  );
  localSocket.close();
  const cliSocket = await connect(`${app.wsUrl}?token=secret`);
  cliSocket.close();
});

test('sidecar root 或 session 祖先为 symlink 时 server 启动即拒绝且不写 outside', async t => {
  for (const level of ['root', 'session']) {
    await t.test(level, async () => {
      const project = await mkdtemp(join(tmpdir(), `deck-sidecar-${level}-`));
      const deck = join(project, 'deck.html');
      const deckBytes = Buffer.from(validBundle());
      await writeFile(deck, deckBytes);
      const outside = join(project, 'outside');
      await mkdir(outside);
      const sidecarRoot = join(project, '.huawei-deck-editor');
      if (level === 'root') {
        await symlink(outside, sidecarRoot);
      } else {
        await mkdir(sidecarRoot);
        const sessionName = `deck-${sha256(deckBytes).slice(0, 8)}`;
        await symlink(outside, join(sidecarRoot, sessionName));
      }

      let app;
      let startupError;
      try {
        app = await startServer({
          deckPath:deck, host:'127.0.0.1', port:0, openBrowser:false,
        });
      } catch (error) {
        startupError = error;
      } finally {
        await app?.close();
      }

      assert.equal(app, undefined, '不应在不可信 sidecar 上启动服务');
      assert.equal(startupError?.code, 'UNSAFE_SIDECAR');
      assert.deepEqual(await readdir(outside), []);
    });
  }
});

test('服务启动后 sidecar root 或 session 身份被替换时保存前拒绝且不写替换目录', async t => {
  for (const level of ['root', 'session']) {
    await t.test(level, async subtest => {
      let spawnCalls = 0;
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(() => {
          current.stdout.emit('data', `${JSON.stringify({
            ok:false, code:'WRITE_FAILED', stage:'write', message:'stop',
          })}\n`);
          current.emit('close', 0);
        }),
      });
      const app = await makeApp(subtest, {
        deckContents:validBundle(),
        spawnWriter:() => {
          spawnCalls += 1;
          return child;
        },
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);
      const memoryBefore = structuredClone(app.session);
      const replacementSession = await replaceSidecarIdentity(app, level);

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });
      const body = await response.json();

      assert.equal(body.code, 'UNSAFE_SIDECAR', JSON.stringify(body));
      assert.equal(spawnCalls, 0, '身份 guard 必须先于 backup 和 writer');
      assert.deepEqual(await readdir(join(replacementSession, 'backups')), []);
      assert.deepEqual(await readdir(join(replacementSession, 'transactions')), []);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(app.session, memoryBefore);
    });
  }
});

test('server guard 后项目根目录被替换时 adapter 以启动 identity 拒绝且零写入', async t => {
  let swapped = false;
  let trustedProject;
  let trustedDeck;
  let replacementDeck;
  let outsideFile;
  const replacementBytes = Buffer.from('replacement deck must stay untouched');
  const outsideBytes = Buffer.from('outside sentinel must stay untouched');
  const originalBytes = Buffer.from(validBundle());
  const app = await makeApp(t, {
    deckContents:originalBytes,
    spawnWriter:(command, args, options) => {
      if (!swapped) {
        swapped = true;
        const project = dirname(app.deckPath);
        trustedProject = `${project}-trusted`;
        trustedDeck = join(trustedProject, 'deck.html');
        replacementDeck = app.deckPath;
        outsideFile = `${project}-outside.txt`;
        renameSync(project, trustedProject);
        mkdirSync(project);
        writeFileSync(replacementDeck, replacementBytes);
        writeFileSync(outsideFile, outsideBytes);
      }
      return spawnProcess(command, args, options);
    },
  });
  await connectDiagnosticsEditor(t, app);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.equal(swapped, true);
  assert.equal(response.status, 500);
  assert.equal(body.code, 'UNSAFE_SIDECAR', JSON.stringify(body));
  assert.deepEqual(await readFile(trustedDeck), originalBytes);
  assert.deepEqual(await readFile(replacementDeck), replacementBytes);
  assert.deepEqual(await readFile(outsideFile), outsideBytes);
  assert.deepEqual(await readdir(dirname(replacementDeck)), ['deck.html']);
});

test('SessionStore 每次 persist 前复核启动时 sidecar 身份', async t => {
  for (const level of ['root', 'session']) {
    await t.test(level, async subtest => {
      const app = await makeApp(subtest);
      const memoryBefore = structuredClone(app.session);
      const replacementSession = await replaceSidecarIdentity(app, level);

      const response = await fetch(`${app.url}/api/tasks?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify(taskInput),
      });
      const body = await response.json();

      assert.equal(body.code, 'UNSAFE_SIDECAR', JSON.stringify(body));
      assert.deepEqual(await readdir(replacementSession), [
        'backups', 'snapshots', 'transactions',
      ]);
      assert.deepEqual(app.session, memoryBefore);
    });
  }
});

test('editor capability 隔离 observer 且拒绝错误或重复 editor', async t => {
  const app = await makeApp(t);
  const editorUrl = app.editorWsUrl
    ?? `${app.wsUrl}?token=secret&editorToken=editor-secret`;
  const editor = await connect(editorUrl);
  const observer = await connect(`${app.wsUrl}?token=secret`);
  t.after(() => editor.close());
  t.after(() => observer.close());

  const editorMessage = nextMessage(editor).then(message => ({ source: 'editor', message }));
  const observerMessage = nextMessage(observer).then(message => ({ source: 'observer', message }));
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const received = await Promise.race([editorMessage, observerMessage]);
  assert.equal(received.source, 'editor');
  assert.equal(received.message.type, 'apply-actions');

  observer.send(JSON.stringify({
    type: 'actions-prepared',
    commandId: received.message.commandId,
    applied: 1,
    results: received.message.actions,
  }));
  const forgedSettled = await Promise.race([
    responsePromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(forgedSettled, false);
  assert.equal(app.session.revision, 0);

  await prepareAndCommit(editor, received.message);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);

  assert.equal(app.editorToken, 'editor-secret');
  assert.match(app.editorWsUrl, /editorToken=editor-secret/);
  const sessionBody = await fetch(`${app.url}/api/session?token=secret`).then(value => value.text());
  assert.doesNotMatch(sessionBody, /editor-secret/);
  assert.equal(
    await rejectedWebSocketStatus(`${app.wsUrl}?token=secret&editorToken=wrong`),
    403,
  );
  assert.equal(await rejectedWebSocketStatus(app.editorWsUrl), 409);
});

test('Action RPC 仅在编辑器回执后写入 Journal 并持久化 revision', async t => {
  const app = await makeApp(t);
  const offline = await fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  assert.equal(offline.status, 409);
  assert.equal((await offline.json()).error, 'EDITOR_OFFLINE');

  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const commandPromise = nextMessage(ws);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const command = await commandPromise;
  assert.equal(command.type, 'apply-actions');
  assert.deepEqual(command.actions, [action]);

  const beforeAck = await fetch(`${app.url}/api/session?token=secret`).then(value => value.json());
  assert.equal(beforeAck.revision, 0);
  assert.deepEqual(beforeAck.groups, []);

  await prepareAndCommit(ws, command);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.revision, 1);
  assert.equal(result.applied, 1);
  assert.ok(result.groupId);

  const persisted = JSON.parse(await readFile(join(app.sessionDir, 'session.json'), 'utf8'));
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.groups[0].id, result.groupId);

  const conflict = await fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'REVISION_CONFLICT');
});

test('close 已开始时 apply 的迟到持久化错误统一为 SERVICE_CLOSED，且不再回滚或 finalize', async () => {
  const state = {
    version:1, sessionId:'session-close-apply', deckPath:'/tmp/deck.html',
    deckFingerprint:'deck', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  let rejectPersist;
  let signalPersistStarted;
  const persistStarted = new Promise(resolve => { signalPersistStarted = resolve; });
  const sessionStore = {
    state, sessionPath:'/tmp/session.json',
    async persistState() {
      signalPersistStarted();
      return new Promise((resolve, reject) => { rejectPersist = reject; });
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const commands = [];
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      commands.push(message.type);
      if (message.type === 'apply-actions') {
        queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
          type:'actions-prepared', commandId:message.commandId,
          applied:message.actions.length, results:message.actions,
        })));
      }
    },
  };
  bridge.setEditorSocket(socket);

  const applying = bridge.applyActions({
    taskId:null, actions:[action], expectedRevision:0,
  });
  await persistStarted;
  bridge.close();
  rejectPersist(Object.assign(new Error('late session failure'), {
    committed:true, commitScope:'session', stage:'session-directory-fsync',
  }));

  await assert.rejects(
    applying,
    error => error.code === 'SERVICE_CLOSED' && error.statusCode === 503,
  );
  assert.deepEqual(commands, ['apply-actions']);
});

test('close 对 task、undo/redo 与 diagnostics 的迟到 helper 错误统一优先返回 SERVICE_CLOSED', async t => {
  await t.test('task', async () => {
    const state = { revision:0, tasks:[], groups:[], redo:[] };
    let rejectTask;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const bridge = new BridgeService({
      sessionStore:{
        state, sessionPath:'/tmp/session.json',
        async createTask() {
          signalStarted();
          return new Promise((resolve, reject) => { rejectTask = reject; });
        },
      },
    });
    const pending = bridge.createTask({ instruction:'改' }, 0);
    await started;
    bridge.close();
    rejectTask(new Error('late task helper failure'));
    await assert.rejects(pending, error => error.code === 'SERVICE_CLOSED');
    assert.equal(state.revision, 0);
    assert.deepEqual(state.tasks, []);
  });

  for (const method of ['undoGroup', 'redoGroup']) {
    await t.test(method, async () => {
      const active = method === 'undoGroup';
      const state = {
        revision:1, tasks:[],
        groups:[{ id:'group-1', taskId:'task-1', actions:[action], active }],
        redo:active ? [] : ['group-1'],
      };
      let rejectPersist;
      let signalStarted;
      const started = new Promise(resolve => { signalStarted = resolve; });
      const bridge = new BridgeService({
        sessionStore:{
          state, sessionPath:'/tmp/session.json',
          async persistState() {
            signalStarted();
            return new Promise((resolve, reject) => { rejectPersist = reject; });
          },
        },
      });
      const commands = [];
      const socket = {
        readyState:1,
        send(data) {
          const message = JSON.parse(data);
          commands.push(message.type);
          if (message.type === 'apply-actions') {
            queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
              type:'actions-prepared', commandId:message.commandId,
              applied:message.actions.length, results:message.actions,
            })));
          }
        },
      };
      bridge.setEditorSocket(socket);
      const pending = bridge[method]('group-1', 1);
      await started;
      bridge.close();
      rejectPersist(new Error('late journal helper failure'));
      await assert.rejects(pending, error => error.code === 'SERVICE_CLOSED');
      assert.deepEqual(commands, ['apply-actions']);
      assert.equal(state.revision, 1);
      assert.equal(state.groups[0].active, active);
    });
  }

  await t.test('diagnostics', async () => {
    const page = {
      pageKey:'page-001-close-diagnostics', sectionOverflow:{ x:0, y:0 }, nestedClips:[],
    };
    const state = {
      revision:0, tasks:[], groups:[], redo:[], deckFingerprint:'deck',
      diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
    };
    let rejectPersist;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const bridge = new BridgeService({
      sessionStore:{
        state, sessionPath:'/tmp/session.json',
        async persistState() {
          signalStarted();
          return new Promise((resolve, reject) => { rejectPersist = reject; });
        },
      },
    });
    const socket = { readyState:1, send() {} };
    bridge.setEditorSocket(socket);
    bridge.handleMessage(socket, JSON.stringify({
      type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
      diagnostics:[page],
    }));
    await started;
    let writerCalls = 0;
    const pending = bridge.writeDeck(0, {
      fingerprint:async () => 'deck',
      writer:async () => { writerCalls += 1; },
      restore:async () => {},
    });
    bridge.close();
    rejectPersist(new Error('late diagnostics helper failure'));
    await assert.rejects(pending, error => error.code === 'SERVICE_CLOSED');
    assert.equal(writerCalls, 0);
    assert.deepEqual(state.diagnosticsBaseline, {});
  });
});

test('action 的 session 写已 committed 后发布候选并冻结，且不回滚或 finalize', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-action-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const createdAt = new Date(0).toISOString();
  const state = {
    version:1, sessionId:'session-action', deckPath:join(root, 'deck.html'),
    deckFingerprint:'deck', revision:0,
    tasks:[{
      id:'task-1', status:'pending', candidates:[], createdAt, updatedAt:createdAt,
    }],
    groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  let observedRevisionDuringWrite = null;
  let createTaskCalls = 0;
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      observedRevisionDuringWrite = state.revision;
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session directory fsync failed after rename'), {
        committed:true,
        commitScope:'session',
      });
    },
    async createTask() { createTaskCalls += 1; },
  };
  const bridge = new BridgeService({ sessionStore });
  let rollbackCommands = 0;
  let finalizeCommands = 0;
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type === 'apply-actions') {
        queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
          type:'actions-prepared', commandId:message.commandId,
          applied:message.actions.length, results:message.actions,
        })));
      } else if (message.type === 'rollback-actions') {
        rollbackCommands += 1;
        queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
          type:'actions-rolled-back', commandId:message.commandId, rolledBack:true,
        })));
      } else if (message.type === 'commit-actions') {
        finalizeCommands += 1;
      }
    },
  };
  bridge.setEditorSocket(socket);

  await assert.rejects(
    bridge.applyActions({ taskId:'task-1', actions:[action], expectedRevision:0 }),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503
      && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(observedRevisionDuringWrite, 0, 'journal 写成功前不得发布候选 revision');
  assert.equal(state.revision, 1);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].taskId, 'task-1');
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.tasks[0].groupId, state.groups[0].id);
  assert.equal(disk.revision, 1);
  assert.deepEqual(disk.groups, state.groups);
  assert.deepEqual(disk.tasks, state.tasks);
  assert.equal(rollbackCommands, 0);
  assert.equal(finalizeCommands, 0);
  await assert.rejects(
    bridge.createTask({ instruction:'later' }, 1),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
  assert.equal(createTaskCalls, 0);
  await assert.rejects(
    bridge.writeDeck(1, {}),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
});

test('undo/redo 的 session 写已 committed 后保留候选 journal 并冻结', async t => {
  for (const method of ['undo', 'redo']) {
    await t.test(method, async () => {
      const root = await mkdtemp(join(tmpdir(), `deck-${method}-committed-session-`));
      const sessionPath = join(root, 'session.json');
      const groupId = `group-${method}`;
      const initiallyActive = method === 'undo';
      const createdAt = new Date(0).toISOString();
      const state = {
        version:1, sessionId:`session-${method}`, deckPath:join(root, 'deck.html'),
        deckFingerprint:'deck', revision:1,
        tasks:[{
          id:'task-1', status:initiallyActive ? 'completed' : 'pending',
          ...(initiallyActive ? { groupId } : {}), candidates:[], createdAt, updatedAt:createdAt,
        }],
        groups:[{ id:groupId, taskId:'task-1', actions:[action], active:initiallyActive }],
        redo:initiallyActive ? [] : [groupId], diagnosticsBaseline:{},
        diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
      };
      let observedRevisionDuringWrite = null;
      const sessionStore = {
        state, sessionPath,
        async persistState(candidate = state) {
          observedRevisionDuringWrite = state.revision;
          await writeFile(sessionPath, JSON.stringify(candidate));
          throw Object.assign(new Error('session committed'), {
            committed:true, commitScope:'session',
          });
        },
      };
      const bridge = new BridgeService({ sessionStore });
      let rollbackCommands = 0;
      let finalizeCommands = 0;
      const socket = {
        readyState:1,
        send(data) {
          const message = JSON.parse(data);
          if (message.type === 'apply-actions') {
            queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
              type:'actions-prepared', commandId:message.commandId,
              applied:message.actions.length, results:message.actions,
            })));
          } else if (message.type === 'rollback-actions') {
            rollbackCommands += 1;
          } else if (message.type === 'commit-actions') {
            finalizeCommands += 1;
          }
        },
      };
      bridge.setEditorSocket(socket);

      await assert.rejects(
        method === 'undo'
          ? bridge.undoGroup(groupId, 1)
          : bridge.redoGroup(groupId, 1),
        error => error.code === 'RECOVERY_REQUIRED' && error.committed === true,
      );

      const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
      assert.equal(observedRevisionDuringWrite, 1);
      assert.equal(state.revision, 2);
      assert.equal(state.groups[0].active, method === 'redo');
      assert.deepEqual(state.redo, method === 'undo' ? [groupId] : []);
      assert.equal(state.tasks[0].status, method === 'undo' ? 'pending' : 'completed');
      assert.equal(state.tasks[0].groupId, method === 'undo' ? undefined : groupId);
      assert.equal(disk.revision, state.revision);
      assert.deepEqual(disk.groups, state.groups);
      assert.deepEqual(disk.tasks, state.tasks);
      assert.equal(rollbackCommands, 0);
      assert.equal(finalizeCommands, 0);
    });
  }
});

test('diagnostics 的 session 写已 committed 后发布候选并冻结后续 mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-diagnostics-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const page = {
    pageKey:'page-001-committed-diagnostics',
    sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  const state = {
    version:1, sessionId:'session-diagnostics', deckPath:join(root, 'deck.html'),
    deckFingerprint:'deck', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  let observedBaselineDuringWrite = null;
  let createTaskCalls = 0;
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      observedBaselineDuringWrite = Object.keys(state.diagnosticsBaseline).length;
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session directory fsync failed after rename'), {
        committed:true,
        commitScope:'session',
      });
    },
    async createTask() { createTaskCalls += 1; },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = { readyState:1, send() {} };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'deck',
      writer:async () => assert.fail('RECOVERY_REQUIRED 不得调用 writer'),
    }),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503
      && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(observedBaselineDuringWrite, 0);
  assert.deepEqual(state.diagnosticsBaseline, { [page.pageKey]:page });
  assert.deepEqual(state.diagnosticsCurrent, { [page.pageKey]:page });
  assert.equal(state.diagnosticsRevision, 0);
  assert.deepEqual(disk.diagnosticsBaseline, state.diagnosticsBaseline);
  await assert.rejects(
    bridge.createTask({ instruction:'later' }, 0),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
  assert.equal(createTaskCalls, 0);
});

test('conflict 的 session 写已 committed 后保留冲突并冻结', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-conflict-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const state = {
    version:1, sessionId:'session-conflict', deckPath:join(root, 'deck.html'),
    deckFingerprint:'expected', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session committed'), {
        committed:true, commitScope:'session',
      });
    },
  };
  const bridge = new BridgeService({ sessionStore });

  await assert.rejects(
    bridge.noteDeckFingerprint('external'),
    error => error.code === 'RECOVERY_REQUIRED' && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(state.conflict.code, 'DECK_CHANGED');
  assert.equal(state.conflict.actualFingerprint, 'external');
  assert.deepEqual(disk.conflict, state.conflict);
  await assert.rejects(
    bridge.noteDeckFingerprint('another'),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
});

test('write-deck 的 session 写已 committed 后保留新基线、保留 record 并冻结', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-write-committed-session-'));
  const sessionPath = join(root, 'session.json');
  const page = {
    pageKey:'page-001-write-committed',
    sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  const state = {
    version:1, sessionId:'session-write', deckPath:join(root, 'deck.html'),
    deckFingerprint:'old', revision:0, tasks:[], groups:[], redo:[],
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:0, conflict:null,
  };
  const sessionStore = {
    state, sessionPath,
    async persistState(candidate = state) {
      await writeFile(sessionPath, JSON.stringify(candidate));
      throw Object.assign(new Error('session committed'), {
        committed:true, commitScope:'session',
      });
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  let restoreCalls = 0;
  let finalizeCalls = 0;

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'old',
      writer:async () => ({ fingerprint:'new', backup:'/tmp/backup.html' }),
      restore:async () => { restoreCalls += 1; },
      finalize:async () => { finalizeCalls += 1; },
    }),
    error => error.code === 'RECOVERY_REQUIRED' && error.committed === true,
  );

  const disk = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(state.deckFingerprint, 'new');
  assert.equal(disk.deckFingerprint, 'new');
  assert.equal(restoreCalls, 0);
  assert.equal(finalizeCalls, 0, 'committed 异常后必须保留 transaction record 供重启收敛');
  await assert.rejects(
    bridge.writeDeck(0, {}),
    error => error.code === 'RECOVERY_REQUIRED' && error.statusCode === 503,
  );
});

test('actions-prepared 只接受与动作数一致的安全非负整数', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const invalidAppliedValues = [undefined, -1, 0, 2, 1.5];

  for (const applied of invalidAppliedValues) {
    const commandPromise = nextMessage(ws);
    const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
    });
    const command = await commandPromise;
    const acknowledgement = {};
    if (applied !== undefined) acknowledgement.applied = applied;
    await sendInvalidPrepared(ws, command, acknowledgement);

    const response = await responsePromise;
    assert.equal(response.status, 502, `applied=${applied}`);
    assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');
    assert.equal(app.session.revision, 0);
    assert.deepEqual(app.session.groups, []);
  }

  const commandPromise = nextMessage(ws);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const command = await commandPromise;
  await prepareAndCommit(ws, command);
  assert.equal((await responsePromise).status, 200);
  assert.equal(app.session.revision, 1);
});

test('缺 canonical、错配 canonical 与浏览器拒绝均不得写 Journal', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const incomplete = { ...action };
  delete incomplete.before;
  delete incomplete.after;

  let commandPromise = nextMessage(ws);
  let responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  let command = await commandPromise;
  await sendInvalidPrepared(ws, command, { applied: 1, results: undefined });
  let response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  command = await commandPromise;
  await sendInvalidPrepared(ws, command, {
    applied: 1,
    results: [{ ...action, id: 'wrong-id' }],
  });
  response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  command = await commandPromise;
  ws.send(JSON.stringify({
    type: 'actions-rejected', commandId: command.commandId,
    code: 'TARGET_AMBIGUOUS', failedActionId: incomplete.id,
    candidates: Array.from({ length: 8 }, (_, index) => ({ path: String(index) })),
  }));
  response = await responsePromise;
  assert.equal(response.status, 409);
  const rejected = await response.json();
  assert.equal(rejected.error, 'TARGET_AMBIGUOUS');
  assert.equal(rejected.failedActionId, incomplete.id);
  assert.equal(rejected.candidates.length, 5);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('TARGET_AMBIGUOUS 持久化关联任务为待确认并广播新 revision', async t => {
  const app = await makeApp(t);
  const created = await createTask(app);
  const taskId = created.task.id;
  await new Promise(resolve => setTimeout(resolve, 5));
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  const requested = { ...action, taskId };

  const commandPromise = nextMessage(editor);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:1, taskId, actions:[requested] }),
  });
  const command = await commandPromise;
  const eventPromise = nextMessage(editor);
  editor.send(JSON.stringify({
    type:'actions-rejected', commandId:command.commandId,
    code:'TARGET_AMBIGUOUS', failedActionId:requested.id,
    candidates:Array.from({ length:8 }, (_, index) => ({ path:String(index) })),
  }));

  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, 'TARGET_AMBIGUOUS');
  assert.equal(body.revision, 2);
  assert.equal(body.candidates.length, 5);
  const event = await eventPromise;
  assert.equal(event.type, 'task-updated');
  assert.equal(event.revision, 2);
  assert.equal(event.payload.id, taskId);
  assert.equal(event.payload.status, 'needs-confirmation');

  const persisted = JSON.parse(await readFile(join(app.sessionDir, 'session.json'), 'utf8'));
  const task = persisted.tasks.find(candidate => candidate.id === taskId);
  assert.equal(persisted.revision, 2);
  assert.equal(task.status, 'needs-confirmation');
  assert.equal(task.candidates.length, 5);
  assert.ok(task.updatedAt > created.task.updatedAt);
  assert.deepEqual(persisted.groups, []);

  const retryCommandPromise = nextMessage(editor);
  const retryResponsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:2, taskId, actions:[requested] }),
  });
  const retryCommand = await retryCommandPromise;
  await prepareAndCommit(editor, retryCommand);
  const retryResponse = await retryResponsePromise;
  const retryBody = await retryResponse.json();
  assert.equal(retryResponse.status, 200);
  assert.equal(retryBody.revision, 3);
  const completed = app.session.tasks.find(candidate => candidate.id === taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.groupId, retryBody.groupId);
  assert.deepEqual(completed.candidates, []);
  assert.equal(app.session.groups.length, 1);
  assert.equal(app.session.groups[0].taskId, taskId);
});

test('成功 action 原子完成任务且 undo/redo 同步任务生命周期', async t => {
  const app = await makeApp(t);
  const created = await createTask(app);
  const taskId = created.task.id;
  await new Promise(resolve => setTimeout(resolve, 5));
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  const requested = { ...action, taskId };

  let commandPromise = nextMessage(editor);
  let responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:1, taskId, actions:[requested] }),
  });
  let command = await commandPromise;
  await prepareAndCommit(editor, command);
  let response = await responsePromise;
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.revision, 2);
  const groupId = body.groupId;
  assert.equal(body.task.id, taskId);
  assert.equal(body.task.status, 'completed');
  assert.equal(body.task.groupId, groupId);

  let persisted = JSON.parse(await readFile(join(app.sessionDir, 'session.json'), 'utf8'));
  let task = persisted.tasks.find(candidate => candidate.id === taskId);
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.groups[0].id, groupId);
  assert.equal(persisted.groups[0].taskId, taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.groupId, groupId);
  assert.ok(task.updatedAt > created.task.updatedAt);

  commandPromise = nextMessage(editor);
  responsePromise = fetch(`${app.url}/api/groups/${groupId}/undo?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:2 }),
  });
  command = await commandPromise;
  await prepareAndCommit(editor, command);
  response = await responsePromise;
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.revision, 3);
  task = app.session.tasks.find(candidate => candidate.id === taskId);
  assert.equal(task.status, 'pending');
  assert.equal(task.groupId, undefined);
  assert.equal(app.session.groups[0].active, false);

  commandPromise = nextMessage(editor);
  responsePromise = fetch(`${app.url}/api/groups/${groupId}/redo?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:3 }),
  });
  command = await commandPromise;
  await prepareAndCommit(editor, command);
  response = await responsePromise;
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.revision, 4);
  task = app.session.tasks.find(candidate => candidate.id === taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.groupId, groupId);
  assert.equal(app.session.groups[0].active, true);

  await new Promise(resolve => {
    editor.once('close', resolve);
    editor.close();
  });
  const replacementEditor = await connect(app.editorWsUrl);
  t.after(() => replacementEditor.close());
  let extraCommands = 0;
  replacementEditor.on('message', () => { extraCommands += 1; });
  response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:4, taskId, actions:[requested] }),
  });
  body = await response.json();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(response.status, 409);
  assert.equal(body.error, 'TASK_ALREADY_COMPLETED');
  assert.equal(extraCommands, 0);
  assert.equal(app.session.revision, 4);
  assert.equal(app.session.groups.length, 1);
});

test('不存在的 taskId 在发送浏览器 tentative action 前拒绝', async t => {
  const app = await makeApp(t);
  const editor = await connect(app.editorWsUrl);
  t.after(() => editor.close());
  let commands = 0;
  editor.on('message', () => { commands += 1; });

  const response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0, taskId:'missing-task', actions:[action] }),
  });
  const body = await response.json();
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(response.status, 404);
  assert.equal(body.error, 'TASK_NOT_FOUND');
  assert.equal(commands, 0);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('重复 action id 与伪造 payload/after 的 canonical ACK 均拒绝', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const duplicate = await fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action, action] }),
  });
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error, 'DUPLICATE_ACTION_ID');

  const incomplete = { ...action };
  delete incomplete.before;
  delete incomplete.after;
  let commandPromise = nextMessage(ws);
  let responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [incomplete] }),
  });
  let command = await commandPromise;
  await sendInvalidPrepared(ws, command, {
    applied: 1,
    results: [{ ...action, payload: { text: '另一份 payload' } }],
  });
  let response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  const resize = {
    id: 'resize-forged-branch', taskId: null, target: action.target,
    kind: 'resize', payload: { scale: 2 },
  };
  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [resize] }),
  });
  command = await commandPromise;
  await sendInvalidPrepared(ws, command, {
    applied: 1,
    results: [{ ...resize, before: { width: 100, height: 50 }, after: { scale: 2 } }],
  });
  response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');

  const forgedLegacy = { ...action, after: 'FORGED' };
  commandPromise = nextMessage(ws);
  responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [forgedLegacy] }),
  });
  command = await commandPromise;
  await sendInvalidPrepared(ws, command, { applied: 1, results: [forgedLegacy] });
  response = await responsePromise;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'INVALID_ACTION_ACK');
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('等待 Action 回执期间串行化其他 revision mutation', async t => {
  const app = await makeApp(t);
  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const commandPromise = nextMessage(ws);
  const actionResponsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  const command = await commandPromise;

  const taskResponsePromise = fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(taskInput),
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  await prepareAndCommit(ws, command);

  const actionResponse = await actionResponsePromise;
  const taskResponse = await taskResponsePromise;
  assert.equal(actionResponse.status, 200);
  assert.equal((await actionResponse.json()).revision, 1);
  assert.equal(taskResponse.status, 409);
  assert.equal((await taskResponse.json()).error, 'REVISION_CONFLICT');
});

test('createTask 持久化失败时回滚共享状态并清理临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-task-rollback-'));
  const sessionPath = join(root, 'session.json');
  const temporaryPath = `${sessionPath}.tmp`;
  const state = { revision: 0, tasks: [], groups: [], redo: [] };
  const sessionStore = {
    state,
    sessionPath,
    async createTask(input) {
      state.tasks.push(input);
      state.revision += 1;
      await writeFile(temporaryPath, 'partial');
      throw new Error('persist failed');
    },
  };
  const bridge = new BridgeService({ sessionStore });

  await assert.rejects(() => bridge.createTask({ instruction: '修改' }, 0), /persist failed/);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.tasks, []);
  await assert.rejects(() => readFile(temporaryPath), { code: 'ENOENT' });
});

test('任务查询、输入错误和已列路由都有明确响应', async t => {
  const app = await makeApp(t);
  const invalidJson = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(invalidJson.status, 400);

  const created = await fetch(`${app.url}/api/tasks?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(taskInput),
  }).then(value => value.json());
  const task = await fetch(`${app.url}/api/tasks/${created.task.id}?token=secret`).then(value => value.json());
  assert.equal(task.id, created.task.id);
  const tasks = await fetch(`${app.url}/api/tasks?token=secret`).then(value => value.json());
  assert.equal(tasks.length, 1);

  assert.equal((await fetch(`${app.url}/api/tasks/missing?token=secret`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/missing?token=secret`)).status, 404);
  assert.equal((await fetch(`${app.url}/editor/index.html?token=secret`)).status, 404);
  assert.equal((await fetch(`${app.url}/events?token=secret`)).status, 426);
  assert.equal((await fetch(`${app.url}/preview?token=secret`)).status, 200);
});

test('JSON 请求体跨 chunk 拆分中文 UTF-8 时完整创建任务', async t => {
  const app = await makeApp(t);
  const instruction = '跨块中文修改';
  const body = Buffer.from(JSON.stringify({ ...taskInput, instruction }));
  const instructionStart = body.indexOf(Buffer.from(instruction));
  assert.notEqual(instructionStart, -1);
  const splitAt = instructionStart + 1;

  const response = await postJsonChunks(
    `${app.url}/api/tasks?token=secret`,
    [body.subarray(0, splitAt), body.subarray(splitAt)],
  );

  assert.equal(response.status, 201);
  assert.equal(response.body.task.instruction, instruction);
});

test('write-deck 调用安全适配器并解析验证诊断后的 JSON 结果', async t => {
  const app = await makeApp(t, { deckContents: validBundle() });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.revision, 0);
  assert.match(result.backup, /backups\/deck-[a-f0-9]{64}\.html$/);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('writer 成功但 session persist 前中断后进入 RECOVERY_REQUIRED，拒绝第二候选并由重启收敛', async t => {
  let app;
  let transactionId;
  let transactionPath;
  let writerStarts = 0;
  const candidateBytes = Buffer.from('candidate before session persist interruption');
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(async () => {
      const oldBytes = await readFile(app.deckPath);
      await writeFile(app.deckPath, candidateBytes);
      transactionPath = await writeTransactionRecord(
        app, transactionId, oldBytes, candidateBytes,
      );
      current.stdout.emit('data', `${JSON.stringify({
        ok:true,
        fingerprint:sha256(candidateBytes),
        backup:join(app.sessionDir, 'backups', `deck-${sha256(oldBytes)}.html`),
        transaction:transactionPath,
      })}\n`);
      current.emit('close', 0);
    }),
  });
  app = await makeApp(t, {
    deckContents:validBundle(),
    spawnWriter:(_command, args) => {
      writerStarts += 1;
      transactionId = args.at(-1);
      return child;
    },
    beforeSessionPersist:async () => {
      assert.ok((await readFile(transactionPath)).length > 0);
      throw Object.assign(new Error('模拟 session persist 前进程中断'), {
        code:'INJECTED_INTERRUPTION', statusCode:500,
      });
    },
  });
  await connectDiagnosticsEditor(t, app);
  const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });

  assert.equal(response.status, 503);
  assert.equal((await response.clone().json()).code, 'RECOVERY_REQUIRED');
  assert.deepEqual(await readFile(app.deckPath), candidateBytes);
  assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
  assert.ok((await readFile(transactionPath)).length > 0);

  const taskResponse = await fetch(`${app.url}/api/tasks?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify(taskInput),
  });
  assert.equal(taskResponse.status, 503);
  assert.equal((await taskResponse.json()).code, 'RECOVERY_REQUIRED');
  for (const [path, body] of [
    ['/api/actions', {
      expectedRevision:0, taskId:null, actions:[{ ...action, taskId:null }],
    }],
    ['/api/groups/missing/undo', { expectedRevision:0 }],
    ['/api/groups/missing/redo', { expectedRevision:0 }],
  ]) {
    const mutation = await fetch(`${app.url}${path}?token=secret`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify(body),
    });
    assert.equal(mutation.status, 503, path);
    assert.equal((await mutation.json()).code, 'RECOVERY_REQUIRED', path);
  }
  const secondSave = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  assert.equal(secondSave.status, 503);
  assert.equal((await secondSave.json()).code, 'RECOVERY_REQUIRED');
  assert.equal(writerStarts, 1, 'fatal 状态不得启动第二个 writer candidate');

  await app.close();
  const restarted = await startServer({
    deckPath:app.deckPath, host:'127.0.0.1', port:0, openBrowser:false,
  });
  try {
    assert.deepEqual(await readFile(app.deckPath), Buffer.from(validBundle()));
    await assert.rejects(() => readFile(transactionPath), { code:'ENOENT' });
  } finally {
    await restarted.close();
  }
});

test('backup 父目录 fsync 失败时不得启动 writer 或发布 transaction record', async t => {
  const order = [];
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(() => {
      current.stdout.emit('data', `${JSON.stringify({
        ok:false, code:'WRITE_FAILED', stage:'write', message:'不应启动 writer',
      })}\n`);
      current.emit('close', 0);
    }),
  });
  const app = await makeApp(t, {
    deckContents:validBundle(),
    syncDirectory:async directory => {
      if (!directory.endsWith('/backups')) return;
      order.push('backup-directory-fsync');
      throw new Error('injected backup directory fsync failure');
    },
    spawnWriter:() => {
      order.push('writer');
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);
  const deckBefore = await readFile(app.deckPath);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(order, ['backup-directory-fsync']);
  assert.deepEqual(await readdir(join(app.sessionDir, 'transactions')), []);
  assert.deepEqual(await readFile(app.deckPath), deckBefore);
});

test('重启按 durable record 收敛 old、candidate 与 third 状态后才清理记录', async t => {
  const oldBytes = Buffer.from(validBundle());
  const candidateBytes = Buffer.from(validBundle().replace('stage', 'stage candidate'));
  const thirdBytes = Buffer.from(validBundle().replace('stage', 'stage external third'));
  const cases = [
    {
      name:'disk candidate + session old 回滚 old',
      diskBytes:candidateBytes,
      sessionFingerprint:sha256(oldBytes),
      expectedBytes:oldBytes,
      expectedSessionFingerprint:sha256(oldBytes),
      conflict:false,
    },
    {
      name:'disk candidate + session candidate 仅清陈旧记录',
      diskBytes:candidateBytes,
      sessionFingerprint:sha256(candidateBytes),
      expectedBytes:candidateBytes,
      expectedSessionFingerprint:sha256(candidateBytes),
      conflict:false,
    },
    {
      name:'disk old + session old 仅清陈旧记录',
      diskBytes:oldBytes,
      sessionFingerprint:sha256(oldBytes),
      expectedBytes:oldBytes,
      expectedSessionFingerprint:sha256(oldBytes),
      conflict:false,
    },
    {
      name:'disk third 保留第三方版本并持久化冲突',
      diskBytes:thirdBytes,
      sessionFingerprint:sha256(oldBytes),
      expectedBytes:thirdBytes,
      expectedSessionFingerprint:sha256(oldBytes),
      conflict:true,
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'deck-restart-transaction-'));
      const fixture = await createPendingTransactionFixture({
        root,
        diskBytes:current.diskBytes,
        oldBytes,
        candidateBytes,
        sessionFingerprint:current.sessionFingerprint,
      });
      let app;
      try {
        app = await startServer({
          deckPath:fixture.deckPath,
          host:'127.0.0.1', port:0, openBrowser:false,
        });
        assert.equal(app.sessionDir, fixture.sessionDir);
        assert.deepEqual(await readFile(fixture.deckPath), current.expectedBytes);
        assert.equal(app.session.deckFingerprint, current.expectedSessionFingerprint);
        if (current.conflict) {
          assert.equal(app.session.conflict?.code, 'DECK_CHANGED');
          assert.equal(app.session.conflict?.actualFingerprint, sha256(thirdBytes));
        } else {
          assert.equal(app.session.conflict, null);
        }
        await assert.rejects(() => readFile(fixture.transaction), { code:'ENOENT' });
      } finally {
        await app?.close();
      }
    });
  }
});

test('启动拒绝 forged/stale transaction 且发现阶段保持 sidecar 只读', async t => {
  const oldBytes = Buffer.from(validBundle());
  const candidateBytes = Buffer.from(validBundle().replace('stage', 'stage candidate'));

  const runRejectedStartup = async fixture => {
    const deckBefore = await readFile(fixture.deckPath);
    const treeBefore = await sidecarTree(fixture.sidecarRoot);
    let app;
    let startupError;
    try {
      app = await startServer({
        deckPath:fixture.deckPath,
        host:'127.0.0.1', port:0, openBrowser:false,
      });
    } catch (error) {
      startupError = error;
    } finally {
      await app?.close();
    }
    assert.equal(app, undefined, '不可信 pending record 不得启动服务');
    assert.equal(startupError?.code, 'UNSAFE_SIDECAR');
    assert.deepEqual(await readFile(fixture.deckPath), deckBefore);
    assert.deepEqual(await sidecarTree(fixture.sidecarRoot), treeBefore);
  };

  await t.test('错误 session 目录名即使 record 自洽也拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-forged-session-name-'));
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes),
    });
    const forgedSession = join(fixture.sidecarRoot, 'deck-deadbeef');
    await rename(fixture.sessionDir, forgedSession);
    const transaction = join(forgedSession, 'transactions', '123e4567-e89b-42d3-a456-426614174000.json');
    const record = JSON.parse(await readFile(transaction, 'utf8'));
    record.sessionDir = forgedSession;
    record.backup = join(forgedSession, 'backups', `deck-${fixture.oldFingerprint}.html`);
    await writeFile(transaction, JSON.stringify(record));
    await runRejectedStartup({ ...fixture, sessionDir:forgedSession, transaction });
  });

  await t.test('session.json deckPath 与当前 Deck 不一致时拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-forged-session-state-'));
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes),
    });
    const sessionPath = join(fixture.sessionDir, 'session.json');
    const state = JSON.parse(await readFile(sessionPath, 'utf8'));
    state.deckPath = join(root, 'other-deck.html');
    await writeFile(sessionPath, JSON.stringify(state));
    await runRejectedStartup(fixture);
  });

  await t.test('record-like symlink 不得被忽略后另建 session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-record-symlink-'));
    const fixture = await createPendingTransactionFixture({
      root, diskBytes:candidateBytes, oldBytes, candidateBytes,
      sessionFingerprint:sha256(oldBytes),
    });
    const outsideRecord = join(root, 'outside-record.json');
    await writeFile(outsideRecord, await readFile(fixture.transaction));
    await unlink(fixture.transaction);
    await symlink(outsideRecord, fixture.transaction);
    await runRejectedStartup(fixture);
  });

  await t.test('无效 record 验证前不得创建任何 session 子目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-invalid-record-readonly-'));
    const deckPath = join(root, 'deck.html');
    await writeFile(deckPath, candidateBytes);
    const sidecarRoot = join(root, '.huawei-deck-editor');
    const sessionDir = join(sidecarRoot, `deck-${sha256(oldBytes).slice(0, 8)}`);
    const transactions = join(sessionDir, 'transactions');
    const transaction = join(transactions, '123e4567-e89b-42d3-a456-426614174000.json');
    await mkdir(transactions, { recursive:true });
    await writeFile(transaction, '{invalid');
    await runRejectedStartup({ deckPath, sidecarRoot, sessionDir, transaction });
  });
});

test('writer 已替换 Deck 后无 ACK、坏 ACK、非零退出、EPIPE 或超时都必须恢复原子状态', async t => {
  const cases = [
    ['无 ACK', current => current.emit('close', 0)],
    ['坏 ACK', current => {
      current.stdout.emit('data', '{bad json\n');
      current.emit('close', 0);
    }],
    ['非零退出', current => {
      current.stderr.emit('data', 'writer failed');
      current.emit('close', 7);
    }],
    ['EPIPE', current => current.stdin.emit('error', epipe())],
    ['超时', () => {}],
  ];

  for (const [name, finish] of cases) {
    await t.test(name, async subtest => {
      let app;
      let transactionId;
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(async () => {
          const oldBytes = await readFile(app.deckPath);
          const candidateBytes = Buffer.from(`writer-mutated-${name}`);
          await writeFile(app.deckPath, candidateBytes);
          await writeTransactionRecord(app, transactionId, oldBytes, candidateBytes);
          finish(current);
        }),
      });
      app = await makeApp(subtest, {
        deckContents:validBundle(),
        writerTimeoutMs:100,
        spawnWriter:(_command, args) => {
          transactionId = args.at(-1);
          return child;
        },
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);
      const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });

      assert.notEqual(response.status, 200);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
      assert.equal(app.session.deckFingerprint, sha256(deckBefore));
      assert.equal(app.session.revision, 0);
      assert.deepEqual(app.session.groups, []);
    });
  }
});

test('writer 成功回执必须完整、可信并与官方 Deck 指纹一致', async t => {
  const replies = [
    ['缺少字段', () => ({ ok:true })],
    ['非法指纹', () => ({ ok:true, fingerprint:'bad', backup:'/tmp/outside.html' })],
    ['会话外备份', (_app, deckBefore) => ({
      ok:true, fingerprint:sha256(deckBefore), backup:'/tmp/outside.html',
    })],
    ['磁盘指纹不匹配', (app, deckBefore) => ({
      ok:true,
      fingerprint:'0'.repeat(64),
      backup:join(app.sessionDir, 'backups', `deck-${sha256(deckBefore)}.html`),
    })],
  ];

  for (const [name, makeReply] of replies) {
    await t.test(name, async subtest => {
      let reply;
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(() => {
          current.stdout.emit('data', `${JSON.stringify(reply)}\n`);
          current.emit('close', 0);
        }),
      });
      const app = await makeApp(subtest, {
        deckContents:validBundle(),
        spawnWriter:() => child,
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);
      reply = makeReply(app, deckBefore);
      const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });
      const body = await response.json();

      assert.equal(response.status, 500, `${name}: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'WRITE_FAILED');
      assert.equal(body.stage, 'adapter');
      assert.match(body.recovery, /重试|恢复|检查/);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
    });
  }
});

test('adapter 在 replace 前发现真实外改时保留外部 bytes', async t => {
  let app;
  const externalBytes = Buffer.from('real external edit before replace');
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(async () => {
      await writeFile(app.deckPath, externalBytes);
      current.stdout.emit('data', `${JSON.stringify({
        ok:false,
        code:'DECK_CHANGED',
        stage:'fingerprint',
        message:'Deck 在 replace 前发生外部变化',
        recovery:'重新载入后重试',
      })}\n`);
      current.emit('close', 0);
    }),
  });
  app = await makeApp(t, {
    deckContents:validBundle(), spawnWriter:() => child,
  });
  await connectDiagnosticsEditor(t, app);
  const oldFingerprint = app.session.deckFingerprint;

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'DECK_CHANGED');
  assert.deepEqual(await readFile(app.deckPath), externalBytes);
  assert.equal(app.session.deckFingerprint, oldFingerprint);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
  assert.equal(app.session.conflict?.actualFingerprint, sha256(externalBytes));
});

test('candidate 已 replace 后无 ACK、坏 ACK 或超时仅凭 durable record 恢复并清理记录', async t => {
  const cases = [
    ['无 ACK', current => current.emit('close', 0)],
    ['坏 ACK', current => {
      current.stdout.emit('data', '{bad json\n');
      current.emit('close', 0);
    }],
    ['超时', () => {}],
  ];
  for (const [name, finish] of cases) {
    await t.test(name, async subtest => {
      let app;
      let transactionId;
      let transactionPath;
      const candidateBytes = Buffer.from(`candidate-${name}`);
      const child = fakeWriterChild({
        onEnd:current => queueMicrotask(async () => {
          const oldBytes = await readFile(app.deckPath);
          await writeFile(app.deckPath, candidateBytes);
          transactionPath = await writeTransactionRecord(
            app, transactionId, oldBytes, candidateBytes,
          );
          finish(current);
        }),
      });
      app = await makeApp(subtest, {
        deckContents:validBundle(), writerTimeoutMs:100,
        spawnWriter:(_command, args) => {
          transactionId = args.at(-1);
          return child;
        },
      });
      await connectDiagnosticsEditor(subtest, app);
      const deckBefore = await readFile(app.deckPath);

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });

      assert.notEqual(response.status, 200);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.ok(transactionPath, 'writer 必须先落 durable transaction record');
      await assert.rejects(() => readFile(transactionPath), { code:'ENOENT' });
    });
  }
});

test('candidate replace 后又出现第三方 hash 时绝不恢复旧 Deck', async t => {
  let app;
  let transactionId;
  const candidateBytes = Buffer.from('writer candidate bytes');
  const thirdPartyBytes = Buffer.from('third party external bytes');
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(async () => {
      const oldBytes = await readFile(app.deckPath);
      await writeFile(app.deckPath, candidateBytes);
      await writeTransactionRecord(app, transactionId, oldBytes, candidateBytes);
      await writeFile(app.deckPath, thirdPartyBytes);
      current.emit('close', 0);
    }),
  });
  app = await makeApp(t, {
    deckContents:validBundle(),
    spawnWriter:(_command, args) => {
      transactionId = args.at(-1);
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.ok(['DECK_CHANGED', 'RESTORE_CONFLICT'].includes(body.code), JSON.stringify(body));
  assert.deepEqual(await readFile(app.deckPath), thirdPartyBytes);
});

test('Node 恢复边界拒绝当前 session backups 内的符号链接文件', async t => {
  let reply;
  const child = fakeWriterChild({
    onEnd:current => queueMicrotask(() => {
      current.stdout.emit('data', `${JSON.stringify(reply)}\n`);
      current.emit('close', 0);
    }),
  });
  const app = await makeApp(t, {
    deckContents:validBundle(), spawnWriter:() => child,
  });
  await connectDiagnosticsEditor(t, app);
  const deckBefore = await readFile(app.deckPath);
  const fingerprint = sha256(deckBefore);
  const outside = join(app.sessionDir, '..', 'outside-backup.html');
  const backup = join(app.sessionDir, 'backups', `deck-${fingerprint}.html`);
  await writeFile(outside, deckBefore);
  await symlink(outside, backup);
  reply = { ok:true, fingerprint, backup };

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0 }),
  });
  const body = await response.json();

  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(body.code, 'WRITE_FAILED');
  assert.equal(body.stage, 'adapter');
  assert.deepEqual(await readFile(app.deckPath), deckBefore);
  assert.deepEqual(await readFile(outside), deckBefore);
});

test('写入适配器只接收运行时所需的最小动作 DTO', async t => {
  let receivedPatches;
  const child = fakeWriterChild({
    onEnd:(current, data) => queueMicrotask(() => {
      receivedPatches = JSON.parse(data);
      current.stdout.emit('data', `${JSON.stringify({
        ok:false, code:'WRITE_FAILED', stage:'write', message:'stop after capture',
      })}\n`);
      current.emit('close', 0);
    }),
  });
  const app = await makeApp(t, {
    deckContents:validBundle(),
    spawnWriter:() => child,
  });
  const editor = await connectDiagnosticsEditor(t, app);
  const canonicalAction = {
    ...action,
    taskId:'ui-task',
    target:{ ...action.target, pageKey:'page-001-save-gate' },
    expectedRevision:0,
    instruction:'仅供 UI 展示',
    snapshot:'data:image/png;base64,ignored',
    appliedAt:'2026-08-02T00:00:00.000Z',
  };
  const commandPromise = nextMessage(editor);
  const applyPromise = fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0, taskId:null, actions:[canonicalAction] }),
  });
  const command = await commandPromise;
  await prepareAndCommit(editor, command, [canonicalAction]);
  assert.equal((await applyPromise).status, 200);

  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:1 }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(Object.keys(receivedPatches[0]).sort(), ['id', 'kind', 'payload', 'target']);
  assert.deepEqual(receivedPatches[0], {
    id:canonicalAction.id,
    target:canonicalAction.target,
    kind:canonicalAction.kind,
    payload:canonicalAction.payload,
  });
});

test('保存回滚后 watcher 必须在串行边界重新读取权威指纹', async () => {
  const page = {
    pageKey:'page-001-watch-race', sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  let diskFingerprint = 'old-fingerprint';
  let persistCalls = 0;
  const state = {
    revision:0, tasks:[], groups:[], redo:[], deckFingerprint:'old-fingerprint', conflict:null,
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:0,
  };
  const sessionStore = {
    state, sessionPath:'/tmp/session.json',
    async persistState() {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error('session persist failed');
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }], diagnostics:[page],
  }));

  const write = bridge.writeDeck(0, {
    fingerprint:async () => diskFingerprint,
    writer:async () => {
      diskFingerprint = 'new-fingerprint';
      return { ok:true, fingerprint:'new-fingerprint', backup:'/tmp/backup.html' };
    },
    restore:async () => { diskFingerprint = 'old-fingerprint'; },
  });
  const watcher = bridge.noteDeckFingerprint(async () => diskFingerprint);

  await assert.rejects(write, error => error.code === 'WRITE_FAILED' && error.stage === 'session');
  assert.equal(await watcher, false);
  assert.equal(diskFingerprint, 'old-fingerprint');
  assert.equal(state.deckFingerprint, 'old-fingerprint');
  assert.equal(state.conflict, null);
});

test('Deck 已替换但 session 基线持久化失败时恢复原文件与内存基线', async () => {
  const page = {
    pageKey:'page-001-save-rollback',
    sectionOverflow:{ x:0, y:0 },
    nestedClips:[],
  };
  const state = {
    revision:0,
    tasks:[],
    groups:[],
    redo:[],
    deckFingerprint:'old-fingerprint',
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page },
    diagnosticsRevision:0,
    conflict:null,
  };
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async persistState() { throw new Error('session persist failed'); },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result',
        commandId:message.commandId,
        revision:message.revision,
        pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));
  let restored = false;

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'old-fingerprint',
      writer:async () => ({ fingerprint:'new-fingerprint', backup:'/tmp/backup.html' }),
      restore:async result => {
        assert.equal(result.fingerprint, 'new-fingerprint');
        restored = true;
      },
    }),
    error => error.code === 'WRITE_FAILED' && error.stage === 'session',
  );
  assert.equal(restored, true);
  assert.equal(state.deckFingerprint, 'old-fingerprint');
  assert.deepEqual(state.diagnosticsBaseline, { [page.pageKey]:page });
});

test('writer success 后 session persist 失败且 Deck 再次外改时保留第三值并冻结恢复', async () => {
  const page = {
    pageKey:'page-001-session-third-party',
    sectionOverflow:{ x:0, y:0 }, nestedClips:[],
  };
  let diskFingerprint = 'old-fingerprint';
  let persistCalls = 0;
  const state = {
    revision:0, tasks:[], groups:[], redo:[],
    deckFingerprint:'old-fingerprint', conflict:null,
    diagnosticsBaseline:{ [page.pageKey]:page },
    diagnosticsCurrent:{ [page.pageKey]:page }, diagnosticsRevision:0,
  };
  const sessionStore = {
    state, sessionPath:'/tmp/session.json',
    async persistState() {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error('session persist failed');
    },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = {
    readyState:1,
    send(data) {
      const message = JSON.parse(data);
      if (message.type !== 'diagnose-pages') return;
      queueMicrotask(() => bridge.handleMessage(socket, JSON.stringify({
        type:'diagnostics-result', commandId:message.commandId,
        revision:message.revision, pages:[page],
      })));
    },
  };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready', pages:[{ index:1, label:'测试页', pageKey:page.pageKey }], diagnostics:[page],
  }));

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => diskFingerprint,
      writer:async () => {
        diskFingerprint = 'candidate-fingerprint';
        return {
          ok:true, fingerprint:'candidate-fingerprint', backup:'/tmp/backup.html',
        };
      },
      restore:async () => {
        diskFingerprint = 'third-party-fingerprint';
        throw Object.assign(new Error('Deck 恢复前已再次外改'), {
          code:'RESTORE_CONFLICT',
          statusCode:409,
          expectedFingerprint:'candidate-fingerprint',
          actualFingerprint:'third-party-fingerprint',
        });
      },
    }),
    error => error.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(diskFingerprint, 'third-party-fingerprint');
  assert.equal(state.deckFingerprint, 'old-fingerprint');
  assert.equal(state.conflict, null);
  assert.equal(persistCalls, 1);
  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => diskFingerprint,
      writer:async () => assert.fail('RECOVERY_REQUIRED 不得产生第二 candidate'),
      restore:async () => assert.fail('RECOVERY_REQUIRED 不得再次恢复'),
    }),
    error => error.code === 'RECOVERY_REQUIRED',
  );
});

test('初始诊断基线持久化失败不得在内存伪装成可保存基线', async () => {
  const page = {
    pageKey:'page-001-baseline-failure',
    sectionOverflow:{ x:0, y:0 },
    nestedClips:[],
  };
  const state = {
    revision:0, tasks:[], groups:[], redo:[], deckFingerprint:'old',
    diagnosticsBaseline:{}, diagnosticsCurrent:{}, diagnosticsRevision:null, conflict:null,
  };
  const sessionStore = {
    state,
    sessionPath:'/tmp/session.json',
    async persistState() { throw new Error('baseline persist failed'); },
  };
  const bridge = new BridgeService({ sessionStore });
  const socket = { readyState:1, send() {} };
  bridge.setEditorSocket(socket);
  bridge.handleMessage(socket, JSON.stringify({
    type:'deck-ready',
    pages:[{ index:1, label:'测试页', pageKey:page.pageKey }],
    diagnostics:[page],
  }));

  await assert.rejects(
    bridge.writeDeck(0, {
      fingerprint:async () => 'old',
      writer:async () => assert.fail('不得调用 writer'),
      restore:async () => {},
    }),
    error => error.code === 'DIAGNOSTICS_UNAVAILABLE' && error.stage === 'diagnostics',
  );
  assert.deepEqual(state.diagnosticsBaseline, {});
  assert.deepEqual(state.diagnosticsCurrent, {});
  assert.equal(state.diagnosticsRevision, null);
});

test('保存诊断超时、断线与显式拒绝统一返回 DIAGNOSTICS_UNAVAILABLE', async t => {
  for (const mode of ['timeout', 'disconnect', 'reject']) {
    await t.test(mode, async subtest => {
      const app = await makeApp(subtest, {
        deckContents:validBundle(), bridgeTimeoutMs:20,
      });
      const socket = await connect(app.editorWsUrl);
      subtest.after(() => socket.close());
      const page = {
        pageKey:'page-001-diagnostics-failure',
        sectionOverflow:{ x:0, y:0 }, nestedClips:[],
      };
      socket.on('message', data => {
        const message = JSON.parse(data);
        if (message.type !== 'diagnose-pages') return;
        if (mode === 'disconnect') socket.close();
        if (mode === 'reject') socket.send(JSON.stringify({
          type:'diagnostics-rejected', commandId:message.commandId, code:'NOT_READY',
        }));
      });
      socket.send(JSON.stringify({
        type:'deck-ready',
        pages:[{ index:1, label:'测试页', pageKey:page.pageKey }], diagnostics:[page],
      }));
      const deadline = Date.now() + 500;
      while (!Object.keys(app.session.diagnosticsBaseline ?? {}).length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const deckBefore = await readFile(app.deckPath);
      const sessionBefore = await readFile(join(app.sessionDir, 'session.json'));

      const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:0 }),
      });
      const body = await response.json();

      assert.equal(response.status, 409, `${mode}: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'DIAGNOSTICS_UNAVAILABLE');
      assert.equal(body.stage, 'diagnostics');
      assert.match(body.recovery, /打开|重连|诊断/);
      assert.deepEqual(await readFile(app.deckPath), deckBefore);
      assert.deepEqual(await readFile(join(app.sessionDir, 'session.json')), sessionBefore);
      assert.equal(app.session.revision, 0);
      assert.deepEqual(app.session.groups, []);
    });
  }
});

test('动作命令超时仍保留 COMMAND_TIMEOUT 语义', async t => {
  const app = await makeApp(t, { bridgeTimeoutMs:20 });
  const socket = await connect(app.editorWsUrl);
  t.after(() => socket.close());
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'rollback-actions') {
      socket.send(JSON.stringify({
        type:'actions-rolled-back', commandId:message.commandId, rolledBack:true,
      }));
    }
  });

  const response = await fetch(`${app.url}/api/actions?token=secret`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:0, taskId:null, actions:[action] }),
  });
  const body = await response.json();

  assert.equal(response.status, 504, JSON.stringify(body));
  assert.equal(body.code, 'COMMAND_TIMEOUT');
  assert.equal(body.stage, undefined);
  assert.equal(app.session.revision, 0);
  assert.deepEqual(app.session.groups, []);
});

test('write-deck 超时终止子进程并映射稳定 504', async t => {
  const child = hangingChild();
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 20,
    spawnWriter: () => child,
  });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 504);
  const error = await response.json();
  assert.equal(error.error, 'WRITE_DECK_TIMEOUT');
  assert.equal(error.stage, 'adapter');
  assert.match(error.recovery, /重试|检查/);
  assert.equal(child.killed, true);
});

test('write-deck stdin 未 settle 的异步 EPIPE 映射稳定 5xx', async t => {
  const child = fakeWriterChild({
    onEnd: current => queueMicrotask(() => current.stdin.emit('error', epipe())),
  });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 1_000,
    spawnWriter: () => child,
  });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.error, 'WRITE_DECK_IO_ERROR');
  assert.equal(error.stage, 'adapter');
  assert.match(error.recovery, /重试|检查/);
  assert.equal(child.killed, true);
});

test('write-deck timeout settle 后吸收 kill 引发的异步 EPIPE', async t => {
  const child = fakeWriterChild({
    onKill: current => queueMicrotask(() => current.stdin.emit('error', epipe())),
  });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 20,
    spawnWriter: () => child,
  });
  await connectDiagnosticsEditor(t, app);
  const response = await fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, 'WRITE_DECK_TIMEOUT');
  assert.equal(child.killed, true);
});

test('write-deck 卡住时 close 取消 child 和请求并在有界时间收敛', async t => {
  const child = hangingChild();
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 10_000,
    spawnWriter: () => {
      signalStarted();
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);
  const responsePromise = fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  const didStart = await Promise.race([
    started.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(didStart, true);

  const beforeClose = performance.now();
  await app.close();
  assert.ok(performance.now() - beforeClose < 500);
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'SERVICE_CLOSED');
  assert.equal(child.killed, true);
});

test('kill 后无 close 仍强制 finalize 并清空 active writer', async t => {
  const child = fakeWriterChild({ closesOnKill: false });
  const activeCounts = [];
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const app = await makeApp(t, {
    deckContents: validBundle(),
    writerTimeoutMs: 10_000,
    writerKillGraceMs: 20,
    onActiveWritersChange: count => activeCounts.push(count),
    spawnWriter: () => {
      signalStarted();
      return child;
    },
  });
  await connectDiagnosticsEditor(t, app);
  const responsePromise = fetch(`${app.url}/api/write-deck?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0 }),
  });
  await started;

  const beforeClose = performance.now();
  await app.close();
  assert.ok(performance.now() - beforeClose < 500);
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'SERVICE_CLOSED');
  assert.equal(child.killed, true);
  assert.equal(child.unrefCalled, true);
  assert.deepEqual(activeCounts, [1, 0]);
  assert.doesNotThrow(() => child.stdin.emit('error', epipe()));
});

test('close 关闭 WebSocket、HTTP 端口并拒绝未完成命令', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-server-close-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck');
  const app = await startServer({ deckPath: deck, host: '127.0.0.1', port: 0, token: 'secret' });
  const ws = await connect(app.editorWsUrl);
  const commandPromise = nextMessage(ws);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: null, actions: [action] }),
  });
  await commandPromise;

  const closedSocket = new Promise(resolve => ws.once('close', resolve));
  await app.close();
  await closedSocket;
  const response = await responsePromise;
  assert.equal(response.status, 503);
  await assert.rejects(() => fetch(`${app.url}/api/session?token=secret`));

  const restarted = await startServer({
    deckPath:deck, host:'127.0.0.1', port:0, openBrowser:false, token:'secret',
  });
  try {
    const session = await fetch(`${restarted.url}/api/session?token=secret`).then(value => value.json());
    assert.equal(session.revision, 0);
    assert.deepEqual(session.groups, []);
  } finally {
    await restarted.close();
  }
});
