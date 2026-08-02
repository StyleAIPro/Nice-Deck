import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER = join(ROOT, 'scripts/editor/server.mjs');
const CLI = join(ROOT, 'scripts/editor/cli.mjs');

const action = {
  id: 'action-cli-1',
  taskId: 'task-placeholder',
  target: { pageKey: 'page-001-cli', path: '0/1' },
  kind: 'setText',
  payload: { text: '新文案' },
  before: '旧文案',
  after: '新文案',
};

function collectProcess(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function spawnCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, result: collectProcess(child) };
}

async function runCli(args) {
  return spawnCli(args).result;
}

function firstLine(stream, child) {
  stream.setEncoding('utf8');
  return new Promise((resolvePromise, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('等待 server ready JSON 超时')), 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = chunk => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolvePromise(buffered.slice(0, newline));
    };
    const onExit = code => {
      cleanup();
      reject(new Error(`server 在 ready 前退出：${code}`));
    };
    stream.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolvePromise => {
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

async function startServerProcess(t) {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-cli-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, '<!doctype html><title>CLI test</title>');
  const child = spawn(process.execPath, [SERVER, deck, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    await rm(root, { recursive: true, force: true });
  });
  const ready = JSON.parse(await firstLine(child.stdout, child));
  return { child, ready };
}

function connect(url) {
  const socket = new WebSocket(url);
  return new Promise((resolvePromise, reject) => {
    socket.once('open', () => resolvePromise(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolvePromise, reject) => {
    socket.once('message', data => resolvePromise(JSON.parse(data)));
    socket.once('error', reject);
  });
}

function parseJsonOutput(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('server CLI 输出 ready JSON、保持运行并响应 SIGINT/SIGTERM', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async t => {
      const { child, ready } = await startServerProcess(t);
      assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(typeof ready.token, 'string');
      assert.match(ready.editorUrl, /^http:\/\/127\.0\.0\.1:\d+\/editor\//);
      const editorUrl = new URL(ready.editorUrl);
      assert.equal(editorUrl.searchParams.get('token'), ready.token);
      assert.ok(editorUrl.searchParams.get('editorToken'));
      assert.equal(child.exitCode, null);
      assert.equal((await fetch(`${ready.url}/api/session`, {
        headers: { authorization: `Bearer ${ready.token}` },
      })).status, 200);

      child.kill(signal);
      const exit = await waitForExit(child);
      assert.deepEqual(exit, { code: 0, signal: null });
      await assert.rejects(() => fetch(`${ready.url}/api/session`));
    });
  }
});

test('Agent CLI 经真实服务完成 status/tasks/task/apply/undo', async t => {
  const { ready } = await startServerProcess(t);
  const common = ['--url', ready.url, '--token', ready.token];
  const auth = { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' };

  const createdResponse = await fetch(`${ready.url}/api/tasks`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      expectedRevision: 0,
      pageKey: 'page-001-cli',
      pageIndex: 1,
      pageLabel: 'CLI',
      rect: { x: 1, y: 2, w: 3, h: 4 },
      instruction: '通过 CLI 修改',
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const taskId = created.task.id;

  assert.equal(parseJsonOutput(await runCli([...common, 'status'])).revision, 1);
  assert.equal(parseJsonOutput(await runCli([...common, 'tasks']))[0].id, taskId);
  assert.equal(parseJsonOutput(await runCli([...common, 'task', taskId])).id, taskId);

  const editorUrl = new URL(ready.editorUrl);
  const editorSocketUrl = new URL('/events', ready.url);
  editorSocketUrl.protocol = 'ws:';
  editorSocketUrl.searchParams.set('token', ready.token);
  editorSocketUrl.searchParams.set('editorToken', editorUrl.searchParams.get('editorToken'));
  const editor = await connect(editorSocketUrl);
  t.after(() => editor.close());

  const root = await mkdtemp(join(tmpdir(), 'deck-editor-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actionsPath = join(root, 'actions.json');
  await writeFile(actionsPath, JSON.stringify({
    expectedRevision: 1,
    taskId,
    actions: [{ ...action, taskId }],
  }));

  const applyCommand = nextMessage(editor);
  const apply = spawnCli([...common, 'apply', actionsPath]);
  const applyMessage = await applyCommand;
  assert.equal(applyMessage.type, 'apply-actions');
  editor.send(JSON.stringify({
    type: 'actions-applied', commandId: applyMessage.commandId, applied: 1,
  }));
  const applied = parseJsonOutput(await apply.result);
  assert.equal(applied.revision, 2);
  assert.equal(typeof applied.groupId, 'string');

  const undoCommand = nextMessage(editor);
  const undo = spawnCli([...common, 'undo', applied.groupId]);
  const undoMessage = await undoCommand;
  assert.equal(undoMessage.type, 'apply-actions');
  editor.send(JSON.stringify({
    type: 'actions-applied', commandId: undoMessage.commandId, applied: 1,
  }));
  assert.equal(parseJsonOutput(await undo.result).revision, 3);
});

test('apply 数组先取 revision，以 Bearer 包装提交且 token 不进入 URL', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.method === 'GET' ? { revision: 7 } : { ok: true }));
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-array-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actionsPath = join(root, 'actions.json');
  await writeFile(actionsPath, JSON.stringify([action]));

  const result = await runCli(['--url', url, '--token', 'local-secret', 'apply', actionsPath]);
  assert.deepEqual(parseJsonOutput(result), { ok: true });
  assert.deepEqual(requests.map(request => request.url), ['/api/session', '/api/actions']);
  assert.ok(requests.every(request => request.authorization === 'Bearer local-secret'));
  assert.deepEqual(JSON.parse(requests[1].body), {
    expectedRevision: 7, taskId: null, actions: [action],
  });
});

test('Agent CLI 区分 HTTP 失败 exit 1 与参数/文件/JSON错误 exit 2', async t => {
  const { ready } = await startServerProcess(t);
  const common = ['--url', ready.url, '--token', ready.token];
  const notFound = await runCli([...common, 'task', 'missing']);
  assert.equal(notFound.code, 1);
  assert.equal(notFound.stdout, '');
  assert.equal(JSON.parse(notFound.stderr).error, 'TASK_NOT_FOUND');

  const root = await mkdtemp(join(tmpdir(), 'deck-editor-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidJson = join(root, 'invalid.json');
  await writeFile(invalidJson, '{not-json');
  for (const args of [
    [...common, 'apply', join(root, 'missing.json')],
    [...common, 'apply', invalidJson],
    [...common, 'task'],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(typeof JSON.parse(result.stderr).error, 'string');
  }
});

test('Agent CLI help 是 JSON 且列出固定命令', async () => {
  const help = parseJsonOutput(await runCli(['--help']));
  assert.deepEqual(help.commands, ['status', 'tasks', 'task', 'apply', 'undo']);
});
