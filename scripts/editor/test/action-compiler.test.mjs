import test from 'node:test';
import assert from 'node:assert/strict';
import { compileActionGroups, sourceRebaseActionIds } from '../action-compiler.mjs';

const target = Object.freeze({
  pageKey:'page-001', path:'0/1', tag:'DIV', fingerprint:'标题',
});

function rangeStyle(id, property, value, start, end) {
  return {
    id, taskId:null, target:{ ...target }, kind:'setStyle',
    payload:{ property, value, textRange:{ start, end } },
    before:'', after:value,
  };
}

test('局部格式编译为互不重叠的最终运行段，并合并相邻同值区间', () => {
  const compiled = compileActionGroups([{
    id:'group-1', active:true, actions:[
      rangeStyle('weight-a', 'font-weight', '700', 0, 1),
      rangeStyle('weight-b', 'font-weight', '700', 1, 9),
      rangeStyle('weight-c', 'font-weight', '700', 9, 56),
      rangeStyle('color-a', 'color', '#c7000b', 0, 10),
      rangeStyle('color-b', 'color', '#000000', 5, 15),
    ],
  }]);

  assert.deepEqual(compiled.map(action => ({
    property:action.payload.property,
    value:action.payload.value,
    range:action.payload.textRange,
  })), [
    { property:'font-weight', value:'700', range:{ start:0, end:56 } },
    { property:'color', value:'#c7000b', range:{ start:0, end:5 } },
    { property:'color', value:'#000000', range:{ start:5, end:15 } },
  ]);
});

test('后续文字替换会淘汰同一元素上基于旧文字范围的局部格式', () => {
  const editorId = 'element-22222222222222222222222222222222';
  const rangeTarget = { ...target, editorId, fingerprint:'旧范围指纹' };
  const textTarget = {
    ...target,
    editorId,
    fingerprint:'文字替换指纹',
    textPath:'2',
  };
  const groups = [
    {
      id:'range-style', mutationType:'action', active:true,
      actions:[{
        ...rangeStyle('old-range-font', 'font-family', 'STXingkai', 16, 36),
        target:rangeTarget,
      }],
    },
    {
      id:'replace-text', mutationType:'action', active:true,
      actions:[{
        id:'replace-whole-copy', taskId:null, target:textTarget, kind:'setText',
        payload:{ text:'组织内部技术分享' },
        before:'组织内部技术分享 · 模型结构 / 训推框架 / 资源预测',
        after:'组织内部技术分享',
      }],
    },
    { id:'later-source', mutationType:'source', active:true, actions:[] },
  ];

  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(action => action.id), ['replace-whole-copy']);
});

test('局部格式之后的细粒度文字替换保留不受影响的格式范围', () => {
  const editorId = 'element-33333333333333333333333333333333';
  const rangeTarget = { ...target, editorId, fingerprint:'局部格式指纹' };
  const groups = [
    {
      id:'range-style', mutationType:'action', active:true,
      actions:[{
        ...rangeStyle('local-color', 'color', '#c7000b', 3, 7),
        target:rangeTarget,
      }],
    },
    {
      id:'replace-trailing-text', mutationType:'action', active:true,
      actions:[{
        id:'replace-trailing-run', taskId:null,
        target:{ ...rangeTarget, textPath:'2' }, kind:'setText',
        payload:{ text:'统一编辑', sourceRange:{ start:7, end:10 } },
        before:'第二段', after:'统一编辑',
      }],
    },
  ];

  assert.deepEqual(
    compileActionGroups(groups).map(action => action.id),
    ['local-color', 'replace-trailing-run'],
  );
});

test('只标记最新有效源码基线之前仍参与编译的动作', () => {
  const action = (id, path, text, before = '旧') => ({
    id, taskId:null, target:{ ...target, path }, kind:'setText',
    payload:{ text }, before, after:text,
  });
  const groups = [
    { id:'old', mutationType:'action', active:true, actions:[action('old', '0/1', '旧动作')] },
    { id:'source', mutationType:'source', active:true, actions:[] },
    { id:'new', mutationType:'action', active:true, actions:[
      action('new', '0/1', '覆盖旧动作', '旧动作'),
      action('after-source', '0/2', '源码后的动作'),
    ] },
  ];
  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(item => item.id), ['new', 'after-source']);
  assert.deepEqual(sourceRebaseActionIds(groups, compiled), []);

  groups[2].active = false;
  const restored = compileActionGroups(groups);
  assert.deepEqual(restored.map(item => item.id), ['old']);
  assert.deepEqual(sourceRebaseActionIds(groups, restored), ['old']);

  groups[1].active = false;
  assert.deepEqual(sourceRebaseActionIds(groups, restored), []);
});

test('源码后的实际 before 与旧动作不连续时，撤销不会复活过期动作', () => {
  const old = {
    id:'old', taskId:null, target:{ ...target }, kind:'setText',
    payload:{ text:'旧动作结果' }, before:'源码原文', after:'旧动作结果',
  };
  const oldGranular = {
    id:'old-granular', taskId:null, target:{ ...target, textPath:'0/1' }, kind:'setText',
    payload:{ text:'局部旧结果' }, before:'局部原文', after:'局部旧结果',
  };
  const afterSource = {
    id:'after-source', taskId:null,
    target:{ ...target, fingerprint:'新源码指纹' }, kind:'setText',
    payload:{ text:'删字后' }, before:'源码改写后的文字', after:'删字后',
  };
  const groups = [
    { id:'old-group', mutationType:'action', active:true, actions:[old, oldGranular] },
    { id:'source-group', mutationType:'source', active:true, actions:[] },
    { id:'new-group', mutationType:'action', active:false, actions:[afterSource] },
  ];
  assert.deepEqual(compileActionGroups(groups), []);
  assert.deepEqual(sourceRebaseActionIds(groups), []);

  groups[2].active = true;
  const compiled = compileActionGroups(groups);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].id, 'after-source');
  assert.equal(compiled[0].target.fingerprint, '新源码指纹');
});

test('持久元素身份跨 DOM 路径合并同一目标的源码前后动作', () => {
  const editorId = 'element-11111111111111111111111111111111';
  const action = (id, path, text, before) => ({
    id, taskId:null,
    target:{ ...target, path, editorId },
    kind:'setText', payload:{ text }, before, after:text,
  });
  const old = action('before-source', '0/1', '人工旧结果', '原始标题');
  const afterSource = action('after-source', '3/2/0', 'Agent 后人工结果', '人工旧结果');
  const groups = [
    { id:'old-group', mutationType:'action', active:true, actions:[old] },
    { id:'source-group', mutationType:'source', active:true, actions:[] },
    { id:'new-group', mutationType:'action', active:true, actions:[afterSource] },
  ];

  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(item => item.id), ['after-source']);
  assert.equal(compiled[0].target.path, '3/2/0');

  groups[2].active = false;
  const restored = compileActionGroups(groups);
  assert.deepEqual(restored.map(item => item.id), ['before-source']);
  assert.deepEqual(sourceRebaseActionIds(groups, restored), ['before-source']);
});
