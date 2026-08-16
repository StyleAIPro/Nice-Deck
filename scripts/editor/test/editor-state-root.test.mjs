import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { resolveEditorStateRoot } from '../editor-state-root.mjs';

test('测试进程与显式覆盖都不能落入用户正式状态目录', () => {
  const homeDirectory = resolve('/Users/example');
  const explicitRoot = resolve(tmpdir(), 'huawei-deck-explicit-state');

  assert.equal(resolveEditorStateRoot({
    environment:{ HUAWEI_DECK_EDITOR_STATE_ROOT:explicitRoot },
    homeDirectory,
    processId:101,
  }), explicitRoot);

  assert.equal(resolveEditorStateRoot({
    environment:{ NODE_TEST_CONTEXT:'child-v8' },
    homeDirectory,
    processId:202,
  }), join(tmpdir(), 'huawei-deck-editor-tests-202'));

  assert.equal(resolveEditorStateRoot({
    environment:{},
    homeDirectory,
    processId:303,
  }), join(homeDirectory, '.huawei-deck-editor'));
});

test('统一测试入口为每个子进程注入一次性状态目录', async () => {
  const source = await readFile(resolve('scripts/run-editor-tests.mjs'), 'utf8');
  assert.match(source, /mkdtempSync/);
  assert.match(source, /HUAWEI_DECK_EDITOR_STATE_ROOT/);
  assert.match(source, /rmSync/);
});
