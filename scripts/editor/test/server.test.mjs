import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  });
  t.after(() => app.close());
  return app;
}

function connect(url) {
  const socket = new WebSocket(url);
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

function rejectedWebSocketStatus(url) {
  const socket = new WebSocket(url);
  return new Promise(resolve => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('open', () => {
      socket.terminate();
      resolve(0);
    });
    socket.once('error', () => resolve(0));
  });
}

function validBundle() {
  const template = '<!doctype html><body><div class="stage"></div></body>';
  return '<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${JSON.stringify(template)}\n</script>`;
}

function fakeWriterChild({ onEnd, onKill, closesOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => onEnd?.(child);
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
    body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
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
    body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
  });
  assert.equal(offline.status, 409);
  assert.equal((await offline.json()).error, 'EDITOR_OFFLINE');

  const ws = await connect(app.editorWsUrl);
  t.after(() => ws.close());
  const commandPromise = nextMessage(ws);
  const responsePromise = fetch(`${app.url}/api/actions?token=secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
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
    body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'REVISION_CONFLICT');
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
      body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
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
    body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
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
    body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
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
    body: JSON.stringify({ expectedRevision: 0, taskId: 'task-1', actions: [action] }),
  });
  await commandPromise;

  const closedSocket = new Promise(resolve => ws.once('close', resolve));
  await app.close();
  await closedSocket;
  const response = await responsePromise;
  assert.equal(response.status, 503);
  await assert.rejects(() => fetch(`${app.url}/api/session?token=secret`));
});
