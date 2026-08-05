import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { openEditor, startFixtureServer } from './test-helpers.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function session(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

async function waitFor(predicate, { timeout = 4_000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('等待保存闸门状态超时');
}

async function waitForBaseline(app) {
  return waitFor(async () => {
    const state = await session(app);
    return Object.keys(state.diagnosticsBaseline ?? {}).length === 2 ? state : null;
  });
}

async function post(app, pathname, body = {}) {
  const response = await fetch(`${app.url}${pathname}?token=${app.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function writeDeck(app, expectedRevision) {
  return post(app, '/api/write-deck', { expectedRevision });
}

async function savedPatches(deckPath) {
  const lines = (await readFile(deckPath, 'utf8')).split('\n');
  const marker = lines.findIndex(line => line.trim() === '<script type="__bundler/template">');
  assert.ok(marker >= 0, '保存结果缺少 bundle template');
  const template = JSON.parse(lines[marker + 1]);
  const match = template.match(
    /<script type="application\/json" id="huawei-deck-editor-patches">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, '保存结果缺少离线补丁数据');
  return { patches:JSON.parse(match[1]), template };
}

async function apply(app, expectedRevision, id, target, kind, payload) {
  const result = await post(app, '/api/actions', {
    expectedRevision,
    taskId: null,
    actions: [{ id, taskId:null, target, kind, payload, expectedRevision }],
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function undo(app, expectedRevision, groupId) {
  const result = await post(app, `/api/groups/${groupId}/undo`, { expectedRevision });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function openReadyEditor(t, app) {
  const opened = await openEditor(app);
  t.after(() => opened.browser.close());
  opened.page.setDefaultTimeout(4_000);
  await waitForBaseline(app);
  return opened;
}

function connectObserver(app) {
  const socket = new WebSocket(`${app.wsUrl}?token=${encodeURIComponent(app.token)}`);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function resultWriter(result) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => {
      child.stdout.emit('data', `${JSON.stringify(result)}\n`);
      child.emit('close', 0);
    });
    child.kill = () => true;
    return child;
  };
}

test('无新增溢出时原子写回并更新 fingerprint，服务自身替换不触发冲突', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { browserProblems, resourceProblems } = await openReadyEditor(t, app);
  const before = await readFile(app.deckPath);
  const observer = await connectObserver(app);
  t.after(() => observer.close());
  const events = [];
  observer.on('message', data => events.push(JSON.parse(data)));

  const result = await writeDeck(app, 0);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const after = await readFile(app.deckPath);
  assert.notEqual(sha256(after), sha256(before));
  assert.equal(result.body.fingerprint, sha256(after));
  assert.match(result.body.backup, /backups\/minimal-deck-[a-f0-9]{64}\.html$/);

  await new Promise(resolve => setTimeout(resolve, 750));
  const state = await session(app);
  assert.equal(state.deckFingerprint, result.body.fingerprint);
  assert.equal(state.conflict ?? null, null);
  assert.equal(events.filter(event => event.type === 'deck-conflict').length, 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('section、新 nested clip 与既有 clip 增量均阻断，撤销后恢复保存', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const { page } = await openReadyEditor(t, app);
  const frame = page.frameLocator('#deck-frame');
  const card = frame.locator('.card').first();
  const existingClip = frame.locator('.baseline-clip').first();
  const cardTarget = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const clipTarget = await existingClip.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  let applied = await apply(app, 0, 'overflow-section', cardTarget, 'translate', { x:1900, y:0 });
  let beforeWrite = await readFile(app.deckPath);
  let blocked = await writeDeck(app, 1);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'NEW_OVERFLOW');
  assert.ok(blocked.body.blockers.some(item => item.kind === 'section' && item.x > 0));
  assert.equal(sha256(await readFile(app.deckPath)), sha256(beforeWrite));
  await undo(app, 1, applied.groupId);

  applied = await apply(app, 2, 'overflow-new-clip', cardTarget, 'resize', { width:300, height:1 });
  beforeWrite = await readFile(app.deckPath);
  blocked = await writeDeck(app, 3);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'NEW_OVERFLOW');
  assert.ok(blocked.body.blockers.some(item => item.kind === 'nested-new'));
  assert.equal(sha256(await readFile(app.deckPath)), sha256(beforeWrite));
  await undo(app, 3, applied.groupId);

  applied = await apply(app, 4, 'overflow-clip-delta', clipTarget, 'resize', { width:300, height:96 });
  beforeWrite = await readFile(app.deckPath);
  blocked = await writeDeck(app, 5);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'NEW_OVERFLOW');
  assert.ok(blocked.body.blockers.some(item => item.kind === 'nested-delta' && item.y > 2));
  assert.equal(sha256(await readFile(app.deckPath)), sha256(beforeWrite));
  await undo(app, 5, applied.groupId);

  const saved = await writeDeck(app, 6);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  const persisted = await savedPatches(app.deckPath);
  assert.deepEqual(persisted.patches, []);
});

test('外部修改只广播一次持久冲突且不得被静默覆盖', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  await openReadyEditor(t, app);
  const observer = await connectObserver(app);
  t.after(() => observer.close());
  const events = [];
  observer.on('message', data => events.push(JSON.parse(data)));

  await appendFile(app.deckPath, '\n<!-- external one -->');
  const blocked = await writeDeck(app, 0);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'DECK_CHANGED');
  assert.equal((await session(app)).conflict.code, 'DECK_CHANGED');
  await waitFor(() => events.find(event => event.type === 'deck-conflict'));
  await appendFile(app.deckPath, '\n<!-- external two -->');
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(events.filter(event => event.type === 'deck-conflict').length, 1);
  const externalHash = sha256(await readFile(app.deckPath));

  const retried = await writeDeck(app, 0);
  assert.equal(retried.response.status, 409, JSON.stringify(retried.body));
  assert.equal(retried.body.code, 'DECK_CHANGED');
  assert.equal(sha256(await readFile(app.deckPath)), externalHash);
  assert.equal((await session(app)).conflict.code, 'DECK_CHANGED');
});

test('editor 离线时返回稳定的保存恢复信息', async t => {
  const app = await startFixtureServer({ bundle:true });
  t.after(() => app.close());
  const before = await readFile(app.deckPath);
  const blocked = await writeDeck(app, 0);
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));
  assert.deepEqual(
    { code:blocked.body.code, stage:blocked.body.stage },
    { code:'EDITOR_OFFLINE', stage:'diagnostics' },
  );
  assert.match(blocked.body.message, /编辑器/);
  assert.match(blocked.body.recovery, /打开|重连/);
  assert.equal(sha256(await readFile(app.deckPath)), sha256(before));
});

test('adapter verify 失败保留原 deck 并返回具体阶段与恢复动作', async t => {
  const app = await startFixtureServer({
    bundle:true,
    spawnWriter:resultWriter({
      ok:false,
      code:'VERIFY_FAILED',
      stage:'verify',
      message:'模拟 verify 失败',
      recovery:'检查 bundle 结构后重试',
      diagnostic:'backups/write-error.json',
      candidate:'write-errors/candidate-deck.html',
    }),
  });
  t.after(() => app.close());
  await openReadyEditor(t, app);
  const before = await readFile(app.deckPath);
  const failed = await writeDeck(app, 0);
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.deepEqual(
    { code:failed.body.code, stage:failed.body.stage },
    { code:'VERIFY_FAILED', stage:'verify' },
  );
  assert.equal(failed.body.message, '模拟 verify 失败');
  assert.match(failed.body.recovery, /重试/);
  assert.equal(failed.body.candidate, 'write-errors/candidate-deck.html');
  assert.equal(sha256(await readFile(app.deckPath)), sha256(before));
});

test('close 解除 watcher，之后的文件变化不再回写会话冲突', async t => {
  const app = await startFixtureServer({ bundle:true, preserveRoot:true });
  t.after(() => app.cleanup());
  const { browser } = await openEditor(app);
  await waitForBaseline(app);
  await browser.close();
  await app.close();
  const conflictBefore = structuredClone(app.session.conflict ?? null);
  await appendFile(app.deckPath, '\n<!-- after close -->');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(app.session.conflict ?? null, conflictBefore);
});
