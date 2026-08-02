import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchJournal } from '../patch-journal.mjs';

const target = { pageKey:'page-001-a', path:'0/1', tag:'DIV', fingerprint:'f1', rect:{x:0,y:0,w:10,h:10} };

test('同一属性只编译最终值，整组可撤销重做', () => {
  const journal = new PatchJournal();
  const group = journal.appendGroup('task-1', [
    { id:'a1', taskId:'task-1', target, kind:'setText', payload:{text:'新'}, before:'旧', after:'新', appliedAt:'t1' },
    { id:'a2', taskId:'task-1', target, kind:'setText', payload:{text:'更新'}, before:'新', after:'更新', appliedAt:'t2' }
  ]);
  assert.equal(journal.compile()[0].after, '更新');
  assert.deepEqual(journal.undo(group.id).map(x => x.payload.text), ['新','旧']);
  assert.deepEqual(journal.redo(group.id).map(x => x.payload.text), ['新','更新']);
});

test('hide 和 show 共享可见性编译槽并保留最后一次公开动作', () => {
  const journal = new PatchJournal();
  journal.appendGroup('task-2', [
    { id:'v1', taskId:'task-2', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t1' },
    { id:'v2', taskId:'task-2', target, kind:'show', payload:{display:''}, before:'none', after:'', appliedAt:'t2' },
    { id:'v3', taskId:'task-2', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t3' }
  ]);

  assert.deepEqual(journal.compile().map(action => action.kind), ['hide']);
});
