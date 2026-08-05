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

test('同一富文本元素的不同文本片段分别保留最终动作', () => {
  const journal = new PatchJournal();
  journal.appendGroup(null, [{
    id:'run-0', taskId:null, target:{ ...target, textPath:'0' },
    kind:'setText', payload:{ text:'第一段更新' }, before:'第一段', after:'第一段更新', appliedAt:'t1',
  }]);
  journal.appendGroup(null, [{
    id:'run-2', taskId:null, target:{ ...target, textPath:'2' },
    kind:'setText', payload:{ text:'第二段更新' }, before:'第二段', after:'第二段更新', appliedAt:'t2',
  }]);
  assert.deepEqual(
    journal.compile().map(action => [action.target.textPath, action.after]),
    [['0','第一段更新'], ['2','第二段更新']],
  );
});

test('局部文字样式按字符范围分别编译，同范围同属性只保留最终值', () => {
  const journal = new PatchJournal();
  journal.appendGroup(null, [{
    id:'range-first', taskId:null, target, kind:'setStyle',
    payload:{ property:'color', value:'red', textRange:{ start:0, end:2 } },
    before:'rgb(0, 0, 0)', after:'red', appliedAt:'t1',
  }]);
  journal.appendGroup(null, [
    {
      id:'range-first-update', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'blue', textRange:{ start:0, end:2 } },
      before:'red', after:'blue', appliedAt:'t2',
    },
    {
      id:'range-second', taskId:null, target, kind:'setStyle',
      payload:{ property:'color', value:'green', textRange:{ start:3, end:5 } },
      before:'rgb(0, 0, 0)', after:'green', appliedAt:'t2',
    },
  ]);
  assert.deepEqual(journal.compile().map(action => [
    action.payload.textRange, action.payload.value,
  ]), [[{ start:0, end:2 }, 'blue'], [{ start:3, end:5 }, 'green']]);
});

test('旧历史中以运行时局部格式 span 为目标的动作会归一到原文本框', () => {
  const journal = new PatchJournal();
  journal.appendGroup(null, [{
    id:'range-root', taskId:null, target, kind:'setStyle',
    payload:{ property:'font-weight', value:'400', textRange:{ start:10, end:28 } },
    before:'700', after:'400', appliedAt:'t1',
  }]);
  journal.appendGroup(null, [{
    id:'range-generated-span', taskId:null,
    target:{ ...target, path:`${target.path}/0`, tag:'SPAN', fingerprint:'generated' },
    kind:'setStyle',
    payload:{ property:'font-weight', value:'700', textRange:{ start:0, end:18 } },
    before:'400', after:'700', appliedAt:'t2',
  }]);
  assert.deepEqual(journal.compile().map(action => ({
    id:action.id,
    target:action.target,
    range:action.payload.textRange,
    value:action.payload.value,
  })), [{
    id:'range-generated-span',
    target,
    range:{ start:10, end:28 },
    value:'700',
  }]);
});

test('编译时跨 inactive 历史组与动作 kind 复用最早安全 locator', () => {
  const journal = new PatchJournal();
  const first = journal.appendGroup('task-stable-target', [{
    id:'stable-text-first', taskId:'task-stable-target', target,
    kind:'setText', payload:{text:'第一次'}, before:'旧', after:'第一次', appliedAt:'t1',
  }]);
  const modifiedTextTarget = { ...target, fingerprint:'after-first-text' };
  journal.appendGroup('task-stable-target', [{
    id:'stable-text-second', taskId:'task-stable-target', target:modifiedTextTarget,
    kind:'setText', payload:{text:'第二次'}, before:'第一次', after:'第二次', appliedAt:'t2',
  }]);
  const modifiedAgainTarget = { ...target, fingerprint:'after-second-text' };
  journal.appendGroup('task-stable-target', [{
    id:'stable-translate', taskId:'task-stable-target', target:modifiedAgainTarget,
    kind:'translate', payload:{x:20,y:10}, before:{x:0,y:0}, after:{x:20,y:10}, appliedAt:'t3',
  }]);
  journal.undo(first.id);

  const compiled = journal.compile();
  assert.deepEqual(compiled.map(action => action.kind), ['setText','translate']);
  assert.deepEqual(compiled.map(action => action.target), [target,target]);
  assert.equal(compiled[0].after, '第二次');
});
