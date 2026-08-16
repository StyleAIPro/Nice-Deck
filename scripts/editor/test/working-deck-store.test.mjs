import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  WorkingDeckStore, pageIdsFromBundle, verifyWorkingPatchReplay,
} from '../working-deck-store.mjs';

function bundle(template) {
  const encoded = JSON.stringify(template).replaceAll('</', '<\\u002F');
  return Buffer.from('<script type="__bundler/manifest">\n{}\n</script>\n'
    + `<script type="__bundler/template">\n${encoded}\n</script>`);
}

const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

test('补丁重放失败保留具体动作 ID 与可恢复提示', async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({
        state:'failed', expected:2, applied:0, adopted:0,
        error:{
          code:'TARGET_AMBIGUOUS', message:'TARGET_AMBIGUOUS',
          failedActionId:'action-stale-range',
        },
      }));
      child.emit('close', 1);
    });
    return child;
  };

  await assert.rejects(
    verifyWorkingPatchReplay('/tmp/not-read-by-fake.html', { spawnProcess }),
    error => {
      assert.equal(error.code, 'PATCH_REPLAY_FAILED');
      assert.equal(error.failedActionId, 'action-stale-range');
      assert.equal(error.stage, 'patch-replay');
      assert.match(error.message, /历史修改无法安全重放/);
      assert.match(error.recovery, /原 Deck 未被改动/);
      return true;
    },
  );
});

function templateOf(bytes) {
  const match = Buffer.from(bytes).toString('utf8')
    .match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
  if (!match) throw new Error('测试 bundle 缺少 template');
  return JSON.parse(match[1]);
}

test('工作副本结构校验兼容 slide-fit 与直接 slide-canvas 页面容器', () => {
  for (const wrapper of ['slide-fit', 'slide-canvas']) {
    const template = `<!doctype html><body><div class="stage">`
      + `<div class="${wrapper}"><section data-label="第一页" data-page-id="page-11111111111111111111111111111111"></section></div>`
      + `<div class="${wrapper}"><section data-label="第二页" data-page-id="page-22222222222222222222222222222222"></section></div>`
      + `</div><script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n      { i:1, code:'02', label:'第二页' },\n    ];</script></body>`;
    assert.deepEqual(pageIdsFromBundle(bundle(template)), [
      'page-11111111111111111111111111111111',
      'page-22222222222222222222222222222222',
    ]);
  }
});

test('导出快照临时物化未固化补丁且不改写工作副本', async () => {
  const pageId = 'page-11111111111111111111111111111111';
  const current = bundle('<!doctype html><body><div class="stage">'
    + `<div class="slide-fit"><section data-label="第一页" data-page-id="${pageId}">`
    + '<h1 data-editor-id="element-22222222222222222222222222222222">旧文案</h1>'
    + '</section></div></div>'
    + `<script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n    ];</script></body>`);
  const store = new WorkingDeckStore({
    deckPath:'/tmp/source-deck.html',
    workingPath:'/tmp/working-deck.html',
    sessionId:'123e4567-e89b-42d3-a456-426614174099',
    sidecarIO:{
      readWorkingDeck:async () => ({
        bytes:current.toString('base64'), fingerprint:fingerprint(current),
      }),
    },
    fingerprint:fingerprint(current),
    pageIds:[pageId],
    managed:true,
  });
  const snapshot = await store.materializePatches([{
    id:'action-export-snapshot',
    taskId:null,
    target:{ pageKey:pageId, path:'0', tag:'H1' },
    kind:'setText',
    payload:{ text:'导出快照文案' },
    before:'旧文案',
    after:'导出快照文案',
  }]);

  assert.match(templateOf(snapshot), /导出快照文案/);
  assert.doesNotMatch(templateOf(current), /导出快照文案/);
  assert.equal(store.fingerprint, fingerprint(current));
});

test('Windows GBK 环境下 Python 适配器的中文错误仍按 UTF-8 返回', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-python-utf8-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '中文错误.html');
  await writeFile(deckPath, bundle('<!doctype html><body>缺少页面结构</body>'));
  const spawnWithHostileConsoleEncoding = (command, args, options = {}) => spawn(
    command,
    args,
    {
      ...options,
      env:{
        ...process.env,
        PYTHONIOENCODING:'gbk:replace',
        PYTHONUTF8:'0',
        LANG:'C',
        ...options.env,
      },
    },
  );

  await assert.rejects(
    WorkingDeckStore.open({
      deckPath,
      sessionDir:root,
      sessionId:'123e4567-e89b-42d3-a456-426614174099',
      sidecarIO:{ readWorkingDeck:async () => null },
      spawnProcess:spawnWithHostileConsoleEncoding,
    }),
    error => {
      assert.equal(
        error.message,
        '工作副本准备失败：未找到任何 section[data-label] 页面',
      );
      assert.equal(error.message.includes('�'), false);
      return true;
    },
  );
});

test('已有工作副本和 Agent 新增元素都在 SourceMutation 前补齐持久身份', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-id-migrate-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'deck.html');
  const pageId = 'page-11111111111111111111111111111111';
  const legacyTemplate = '<!doctype html><body><div class="stage">'
    + `<div class="slide-fit"><div class="slide-canvas"><section data-label="第一页" data-page-id="${pageId}">`
    + '<div class="card"><h2>标题</h2></div></section></div></div></div>'
    + `<script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n    ];</script></body>`;
  await writeFile(deckPath, bundle(legacyTemplate));
  let current = bundle(legacyTemplate);
  const writes = [];
  const archives = [];
  const sidecarIO = {
    async readWorkingDeck() {
      return { bytes:current.toString('base64'), fingerprint:fingerprint(current) };
    },
    async writeWorkingDeck({ bytes, expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
      current = Buffer.from(bytes);
      writes.push(current);
      return { fingerprint:fingerprint(current) };
    },
    async archiveWorkingDeck({ expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
      archives.push(expectedFingerprint);
    },
  };

  const { store } = await WorkingDeckStore.open({
    deckPath, sessionDir:root,
    sessionId:'123e4567-e89b-42d3-a456-426614174099', sidecarIO,
  });
  const initialIds = [...templateOf(current).matchAll(
    /data-editor-id="(element-[0-9a-f]{32})"/g,
  )].map(match => match[1]);
  assert.equal(writes.length, 1);
  assert.equal(initialIds.length, 2);
  assert.equal(new Set(initialIds).size, 2);

  current = bundle(templateOf(current).replace(
    '</section>', '<p>Agent 新增内容</p></section>',
  ));
  const rawAgentFingerprint = fingerprint(current);
  const change = await store.checkpointExternalChange();
  const normalizedTemplate = templateOf(current);
  const normalizedIds = [...normalizedTemplate.matchAll(
    /data-editor-id="(element-[0-9a-f]{32})"/g,
  )].map(match => match[1]);
  assert.equal(writes.length, 2);
  assert.equal(normalizedIds.length, 3);
  assert.deepEqual(normalizedIds.slice(0, 2), initialIds);
  assert.notEqual(change.afterFingerprint, rawAgentFingerprint);
  assert.equal(change.afterFingerprint, fingerprint(current));
  assert.equal(archives.at(-1), change.afterFingerprint);
});

test('重启活动源码事务时保留 session 起始指纹并把磁盘候选留给显式提交', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-source-edit-restart-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'deck.html');
  const pageId = 'page-11111111111111111111111111111111';
  const before = bundle('<!doctype html><body><div class="stage">'
    + `<div class="slide-fit"><section data-label="第一页" data-page-id="${pageId}" `
    + 'data-editor-id="element-11111111111111111111111111111111">'
    + '<h1 data-editor-id="element-22222222222222222222222222222222">事务前</h1>'
    + '</section></div></div>'
    + `<script>const nav = [\n      { i:0, code:'01', label:'第一页' },\n    ];</script></body>`);
  const after = Buffer.from(before.toString('utf8').replace('事务前', '事务后'));
  await writeFile(deckPath, before);
  let current = after;
  const sidecarIO = {
    async readWorkingDeck() {
      return { bytes:current.toString('base64'), fingerprint:fingerprint(current) };
    },
    async writeWorkingDeck({ bytes, expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
      current = Buffer.from(bytes);
      return { fingerprint:fingerprint(current) };
    },
    async archiveWorkingDeck({ expectedFingerprint }) {
      assert.equal(expectedFingerprint, fingerprint(current));
    },
  };
  const beforeFingerprint = fingerprint(before);
  const { store } = await WorkingDeckStore.open({
    deckPath,
    sessionDir:root,
    sessionId:'123e4567-e89b-42d3-a456-426614174099',
    sidecarIO,
    expectedWorkingFingerprint:beforeFingerprint,
    reservedBeforeFingerprint:beforeFingerprint,
  });

  assert.equal(store.fingerprint, beforeFingerprint);
  const change = await store.checkpointExternalChange();
  assert.equal(change.beforeFingerprint, beforeFingerprint);
  assert.equal(change.afterFingerprint, fingerprint(current));
});
