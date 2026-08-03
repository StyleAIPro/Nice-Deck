import test from 'node:test';
import assert from 'node:assert/strict';
import { makePageKey, normalizeRect, validateAction, validateTask } from '../protocol.mjs';

test('屏幕框换算并约束在 1920×1080', () => {
  const rect = normalizeRect({ left: 100, top: 50, width: 500, height: 250 },
    { left: 0, top: 0, width: 960, height: 540 });
  assert.deepEqual(rect, { x: 200, y: 100, w: 1000, h: 500 });
});

test('右侧、下侧和右下角越界仍位于画布内', () => {
  const canvas = { left: 0, top: 0, width: 1920, height: 1080 };
  assert.deepEqual(normalizeRect({ left: 2000, top: 100, width: 20, height: 10 }, canvas),
    { x: 1919, y: 100, w: 1, h: 10 });
  assert.deepEqual(normalizeRect({ left: 100, top: 1200, width: 10, height: 20 }, canvas),
    { x: 100, y: 1079, w: 10, h: 1 });
  assert.deepEqual(normalizeRect({ left: 2000, top: 1200, width: 20, height: 20 }, canvas),
    { x: 1919, y: 1079, w: 1, h: 1 });
});

test('画布尺寸无效时抛出中文 RangeError', () => {
  for (const canvas of [
    { left: 0, top: 0, width: 0, height: 1080 },
    { left: 0, top: 0, width: 1920, height: 0 },
    { left: 0, top: 0 },
    { left: 0, top: 0, width: NaN, height: 1080 },
    { left: 0, top: 0, width: 1920, height: Infinity },
  ]) {
    assert.throws(
      () => normalizeRect({ left: 0, top: 0, width: 10, height: 10 }, canvas),
      new RangeError('画布尺寸必须为正的有限数'),
    );
  }
});

test('屏幕框与画布偏移字段必须为有限数', () => {
  const rect = { left: 0, top: 0, width: 10, height: 10 };
  const canvas = { left: 0, top: 0, width: 1920, height: 1080 };
  for (const [invalidRect, invalidCanvas] of [
    [{ top: 0, width: 10, height: 10 }, canvas],
    [{ left: 0, top: NaN, width: 10, height: 10 }, canvas],
    [{ left: 0, top: 0, width: Infinity, height: 10 }, canvas],
    [{ left: 0, top: 0, width: 10 }, canvas],
    [rect, { top: 0, width: 1920, height: 1080 }],
    [rect, { left: NaN, top: 0, width: 1920, height: 1080 }],
    [rect, { left: 0, top: Infinity, width: 1920, height: 1080 }],
  ]) {
    assert.throws(
      () => normalizeRect(invalidRect, invalidCanvas),
      new RangeError('屏幕框和画布偏移必须为有限数'),
    );
  }
});

test('同名页仍生成不同 pageKey', () => {
  assert.notEqual(makePageKey(1, '目录页', '<section>A</section>'),
    makePageKey(5, '目录页', '<section>A</section>'));
});

test('pageKey 忽略每次加载变化的 blob URL 但保留真实结构差异', () => {
  const first = '<section><img src="blob:http://127.0.0.1:5000/first"><p>A</p></section>';
  const second = '<section><img src="blob:http://127.0.0.1:6000/second"><p>A</p></section>';
  assert.equal(makePageKey(9, '真实页', first), makePageKey(9, '真实页', second));
  assert.notEqual(
    makePageKey(9, '真实页', first),
    makePageKey(9, '真实页', '<section><img src="asset.png"><p>B</p></section>'),
  );
});

test('pageKey 仅归一化 start-tag 属性并保留 script raw-text 中 blob 字符串', () => {
  const rawFirst = '<section><script>const tpl = `<img src="blob:a">`;</script></section>';
  const rawSecond = '<section><script>const tpl = `<img src="blob:b">`;</script></section>';
  assert.notEqual(makePageKey(9, '真实页', rawFirst), makePageKey(9, '真实页', rawSecond));
  assert.equal(
    makePageKey(9, '真实页', '<section><script src="blob:a">same()</script></section>'),
    makePageKey(9, '真实页', '<section><script src="blob:b">same()</script></section>'),
  );
});

test('拒绝越界任务和任意动作类型', () => {
  assert.throws(() => validateTask({ pageKey: 'p', rect: { x: -1, y: 0, w: 10, h: 10 }, instruction: '改' }));
  assert.throws(() => validateAction({ kind: 'replaceOuterHTML', payload: {} }));
});

test('请求任务不得自行携带附件持久化元数据', () => {
  assert.throws(() => validateTask({
    pageKey: 'p', rect: { x: 1, y: 2, w: 3, h: 4 }, instruction: '改', attachments: [],
  }), /attachments/);
});

test('持久化任务严格校验附件且兼容旧任务', () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const attachmentId = '22222222-2222-4222-8222-222222222222';
  const base = { id: taskId, pageKey: 'p', rect: { x: 1, y: 2, w: 3, h: 4 }, instruction: '改' };
  assert.equal(validateTask(base, { persisted: true }), base);
  const persisted = {
    ...base,
    attachments: [{
      id: attachmentId, name: '新版架构.png', mime: 'image/png', size: 8, source: 'pasted',
      relativePath: `attachments/${taskId}/${attachmentId}.png`,
      createdAt: '2026-08-02T12:00:00.000Z',
    }],
  };
  assert.equal(validateTask(persisted, { persisted: true }), persisted);
  assert.throws(() => validateTask({ ...persisted, attachments: {} }, { persisted: true }), /数组/);
  assert.throws(() => validateTask({ ...persisted, attachments: Array(9).fill(persisted.attachments[0]) }, { persisted: true }), /8/);
});

test('动作 payload 严格拒绝非有限位移、非正缩放和对象污染字段', () => {
  const target = { pageKey: 'page-001-a', path: '0/1' };
  assert.throws(() => validateAction({
    id: 'bad-text', target, kind: 'setText', payload: { text: { html: '<script>' } },
  }), /字符串/);
  assert.throws(() => validateAction({
    id: 'bad-move', target, kind: 'translate', payload: { x: Infinity, y: 0 },
  }), /有限数/);
  assert.throws(() => validateAction({
    id: 'pollute-move', target, kind: 'translate', payload: { x: 1, y: 2, __proto__: null },
  }), /对象/);
  assert.throws(() => validateAction({
    id: 'bad-resize', target, kind: 'resize', payload: { scale: 0 },
  }), /正数/);
  assert.throws(() => validateAction({
    id: 'mixed-resize', target, kind: 'resize', payload: { scale: 1, width: 200, height: 100 },
  }), /正数/);
});
