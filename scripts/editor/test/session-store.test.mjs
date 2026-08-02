import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, RevisionConflict } from '../session-store.mjs';

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
]).toString('base64')}`;

test('跨页任务写入后可恢复且 revision 单调递增', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.huawei-deck-editor') });
  const t1 = await store.createTask({ pageKey:'page-001-a', pageIndex:1, pageLabel:'A', rect:{x:1,y:2,w:3,h:4}, instruction:'改 A' }, 0);
  const t2 = await store.createTask({ pageKey:'page-002-b', pageIndex:2, pageLabel:'B', rect:{x:5,y:6,w:7,h:8}, instruction:'改 B' }, 1);
  assert.equal(t1.revision, 1); assert.equal(t2.revision, 2);
  const reopened = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.huawei-deck-editor') });
  assert.equal(reopened.state.tasks.length, 2);
  await assert.rejects(() => reopened.createTask({ ...t1.task, id:undefined }, 0), RevisionConflict);
  assert.match(await readFile(reopened.sessionPath, 'utf8'), /改 B/);
});

test('合法 PNG 快照原子落盘且 session JSON 不保存 base64', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-snapshot-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.huawei-deck-editor') });
  const result = await store.createTask({
    pageKey: 'page-001-a',
    pageIndex: 1,
    pageLabel: 'A',
    rect: { x: 1, y: 2, w: 30, h: 40 },
    instruction: '改 A',
    snapshot: PNG_DATA_URL,
  }, 0);

  assert.equal(result.task.snapshot, undefined);
  assert.equal(result.task.snapshotPath, `snapshots/${result.task.id}.png`);
  assert.deepEqual(
    [...(await readFile(join(store.sessionDir, result.task.snapshotPath))).subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const sessionJson = await readFile(store.sessionPath, 'utf8');
  assert.doesNotMatch(sessionJson, /data:image\/png|iVBOR/);
});

test('非法、伪 PNG 和超限快照在改变状态前拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-invalid-snapshot-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.huawei-deck-editor') });
  const base = {
    pageKey: 'page-001-a', pageIndex: 1, pageLabel: 'A',
    rect: { x: 1, y: 2, w: 30, h: 40 }, instruction: '改 A',
  };

  for (const snapshot of [
    'data:image/jpeg;base64,AAAA',
    'data:image/png;base64,%%%=',
    `data:image/png;base64,${Buffer.from('not-png').toString('base64')}`,
  ]) {
    await assert.rejects(() => store.createTask({ ...base, snapshot }, 0), error => (
      error.code === 'INVALID_SNAPSHOT' && error.statusCode === 400
    ));
  }
  const oversized = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(512 * 1024, 1),
  ]).toString('base64');
  await assert.rejects(
    () => store.createTask({ ...base, snapshot: `data:image/png;base64,${oversized}` }, 0),
    error => error.code === 'SNAPSHOT_TOO_LARGE' && error.statusCode === 413,
  );
  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
  assert.deepEqual(await readdir(join(store.sessionDir, 'snapshots')), []);
});

test('session 持久化失败会回滚 task/revision 并清理快照和临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-persist-failure-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.huawei-deck-editor') });
  store.sessionPath = join(root, 'missing-parent', 'session.json');
  await assert.rejects(() => store.createTask({
    pageKey: 'page-001-a', pageIndex: 1, pageLabel: 'A',
    rect: { x: 1, y: 2, w: 30, h: 40 }, instruction: '改 A', snapshot: PNG_DATA_URL,
  }, 0), /ENOENT/);

  assert.equal(store.state.revision, 0);
  assert.deepEqual(store.state.tasks, []);
  assert.deepEqual(await readdir(join(store.sessionDir, 'snapshots')), []);
});

test('SessionStore 的 session 与 snapshot 只通过可信 atomic I/O 层提交', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-secure-io-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const writes = [];
  const sidecarIO = {
    async atomicWrite({ directory, name, bytes }) {
      writes.push({ directory, name, bytes:Buffer.from(bytes) });
      await writeFile(join(directory, name), bytes);
    },
    async unlink({ directory, name }) {
      writes.push({ directory, name, unlink:true });
    },
  };
  const store = await SessionStore.open({
    deckPath:deck,
    rootDir:join(root, '.huawei-deck-editor'),
    sidecarIO,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].directory, store.sessionDir);
  assert.equal(writes[0].name, 'session.json');
  writes.length = 0;

  const result = await store.createTask({
    pageKey:'page-001-a', pageIndex:1, pageLabel:'A',
    rect:{ x:1, y:2, w:30, h:40 }, instruction:'改 A', snapshot:PNG_DATA_URL,
  }, 0);

  assert.deepEqual(writes.map(write => [write.directory, write.name]), [
    [join(store.sessionDir, 'snapshots'), `${result.task.id}.png`],
    [store.sessionDir, 'session.json'],
  ]);
});
