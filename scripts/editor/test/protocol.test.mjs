import test from 'node:test';
import assert from 'node:assert/strict';
import { makePageKey, normalizeRect, validateAction, validateTask } from '../protocol.mjs';

test('屏幕框换算并约束在 1920×1080', () => {
  const rect = normalizeRect({ left: 100, top: 50, width: 500, height: 250 },
    { left: 0, top: 0, width: 960, height: 540 });
  assert.deepEqual(rect, { x: 200, y: 100, w: 1000, h: 500 });
});

test('同名页仍生成不同 pageKey', () => {
  assert.notEqual(makePageKey(1, '目录页', '<section>A</section>'),
    makePageKey(5, '目录页', '<section>A</section>'));
});

test('拒绝越界任务和任意动作类型', () => {
  assert.throws(() => validateTask({ pageKey: 'p', rect: { x: -1, y: 0, w: 10, h: 10 }, instruction: '改' }));
  assert.throws(() => validateAction({ kind: 'replaceOuterHTML', payload: {} }));
});
