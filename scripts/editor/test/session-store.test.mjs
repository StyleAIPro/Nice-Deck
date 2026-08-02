import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, RevisionConflict } from '../session-store.mjs';

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
