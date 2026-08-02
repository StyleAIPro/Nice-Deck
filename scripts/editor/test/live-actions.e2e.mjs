import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

async function session(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

async function postJson(app, pathname, body) {
  const response = await fetch(`${app.url}${pathname}?token=${app.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('人工改字与 Agent 位移共享 canonical 日志并实时撤销重做', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  await page.click('[data-mode="text"]');
  await heading.dblclick();
  await heading.fill('人工新标题');
  await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');

  const afterManual = await session(app);
  assert.equal(afterManual.revision, 1);
  assert.equal(afterManual.groups.length, 1);
  assert.equal(afterManual.groups[0].taskId, null);
  assert.deepEqual(
    afterManual.groups[0].actions.map(action => ({ kind: action.kind, before: action.before, after: action.after })),
    [{ kind: 'setText', before: '第一页标题', after: '人工新标题' }],
  );

  const moved = await postJson(app, '/api/actions', {
    expectedRevision: afterManual.revision,
    taskId: null,
    actions: [{
      id: 'agent-move-1', taskId: null, target, kind: 'translate', payload: { x: 20, y: 10 },
      expectedRevision: afterManual.revision,
    }],
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  await heading.evaluate(element => new Promise(resolve => {
    const done = () => element.style.translate === '20px 10px' && resolve();
    const observer = new MutationObserver(done);
    observer.observe(element, { attributes: true, attributeFilter: ['style'] });
    done();
  }));
  assert.equal(await heading.textContent(), '人工新标题');

  const afterAgent = await session(app);
  assert.equal(afterAgent.revision, 2);
  assert.equal(afterAgent.groups.length, 2);
  assert.deepEqual(afterAgent.groups[1].actions[0].before, { x: 0, y: 0 });
  assert.deepEqual(afterAgent.groups[1].actions[0].after, { x: 20, y: 10 });

  const undoAgent = await postJson(app, `/api/groups/${moved.body.groupId}/undo`, {
    expectedRevision: 2,
  });
  assert.equal(undoAgent.response.status, 200, JSON.stringify(undoAgent.body));
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame').contentDocument.querySelector('h2').style.translate === ''
  ));
  const manualGroupId = afterManual.groups[0].id;
  const undoManual = await postJson(app, `/api/groups/${manualGroupId}/undo`, {
    expectedRevision: 3,
  });
  assert.equal(undoManual.response.status, 200, JSON.stringify(undoManual.body));
  await heading.waitFor({ state: 'visible' });
  assert.equal(await heading.textContent(), '第一页标题');

  const redoManual = await postJson(app, `/api/groups/${manualGroupId}/redo`, {
    expectedRevision: 4,
  });
  assert.equal(redoManual.response.status, 200, JSON.stringify(redoManual.body));
  const redoAgent = await postJson(app, `/api/groups/${moved.body.groupId}/redo`, {
    expectedRevision: 5,
  });
  assert.equal(redoAgent.response.status, 200, JSON.stringify(redoAgent.body));
  await page.waitForFunction(() => {
    const element = document.querySelector('#deck-frame').contentDocument.querySelector('h2');
    return element.textContent === '人工新标题' && element.style.translate === '20px 10px';
  });

  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '6');
  await page.waitForFunction(() => {
    const element = document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2');
    return element?.textContent === '人工新标题' && element.style.translate === '20px 10px';
  });
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');

  const beforeRejected = await session(app);
  const rejected = await postJson(app, '/api/actions', {
    expectedRevision: beforeRejected.revision,
    taskId: null,
    actions: [
      { id: 'batch-first', taskId: null, target, kind: 'translate', payload: { x: 200, y: 100 } },
      {
        id: 'batch-missing', taskId: null,
        target: { ...target, path: '999/999', fingerprint: 'missing' },
        kind: 'setText', payload: { text: '不应出现' },
      },
    ],
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, 'TARGET_NOT_FOUND');
  assert.equal(rejected.body.failedActionId, 'batch-missing');
  const afterRejected = await session(app);
  assert.equal(afterRejected.revision, beforeRejected.revision);
  assert.deepEqual(afterRejected.groups, beforeRejected.groups);
  assert.equal(await heading.evaluate(element => element.style.translate), '20px 10px');
  assert.equal(await heading.textContent(), '人工新标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('文字取消、空白、无变化和复杂富文本均不创建动作组', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  await page.click('[data-mode="text"]');
  assert.deepEqual(await page.locator('[data-mode][aria-pressed="true"]').evaluateAll(
    buttons => buttons.map(button => button.dataset.mode),
  ), ['text']);

  await heading.dblclick();
  await heading.fill('取消的文字');
  await page.waitForTimeout(180);
  await page.screenshot({
    path: resolve('.superpowers/sdd/task-11-direct-edit.png'),
  });
  await heading.press('Escape');
  assert.equal(await heading.textContent(), '第一页标题');

  await heading.dblclick();
  await heading.fill('   ');
  await heading.press('Meta+Enter');
  assert.equal(await heading.textContent(), '第一页标题');

  await heading.dblclick();
  await heading.fill('第一页标题');
  await heading.press('Meta+Enter');

  await heading.evaluate(element => { element.innerHTML = '<span>复杂</span><span>标题</span>'; });
  await heading.dblclick();
  await frame.locator('[data-direct-status][data-state="error"]').waitFor();
  assert.match(await frame.locator('[data-direct-status]').innerText(), /区域标记/);
  assert.equal(await heading.getAttribute('contenteditable'), null);

  const state = await session(app);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.groups, []);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('移动和普通块缩放按画布坐标提交且控制点保持可点尺寸', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="move"]');
  const headingBox = await heading.boundingBox();
  await page.mouse.move(headingBox.x + 10, headingBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(headingBox.x + 50, headingBox.y + 30);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  let state = await session(app);
  const move = state.groups[0].actions[0];
  assert.equal(move.kind, 'translate');
  assert.deepEqual(move.before, { x: 0, y: 0 });
  assert.ok(move.after.x > 0 && move.after.y > 0, JSON.stringify(move.after));
  assert.equal(
    await heading.evaluate(element => element.style.translate),
    `${move.after.x}px ${move.after.y}px`,
  );

  const movedBox = await heading.boundingBox();
  await page.mouse.move(movedBox.x + 10, movedBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(movedBox.x + 30, movedBox.y + 20);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  state = await session(app);
  const repeatedMove = state.groups[1].actions[0];
  assert.deepEqual(repeatedMove.before, move.after);
  assert.ok(repeatedMove.after.x > move.after.x && repeatedMove.after.y > move.after.y);

  await page.click('[data-mode="resize"]');
  const card = frame.locator('.card').first();
  await card.click();
  const handle = frame.locator('[data-resize-handle]');
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox.width >= 10 && handleBox.height >= 10, JSON.stringify(handleBox));
  await page.waitForTimeout(180);
  await page.screenshot({
    path: resolve('.superpowers/sdd/task-11-transform.png'),
  });
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 30, handleBox.y + handleBox.height / 2 + 20);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  state = await session(app);
  const resize = state.groups[2].actions[0];
  assert.equal(resize.kind, 'resize');
  assert.ok(resize.after.width > resize.before.width, JSON.stringify(resize));
  assert.ok(resize.after.height > resize.before.height, JSON.stringify(resize));
  assert.equal(await card.evaluate(element => Number.parseFloat(element.style.width)), resize.after.width);
  assert.equal(await card.evaluate(element => Number.parseFloat(element.style.height)), resize.after.height);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('复杂 SVG 使用 scale 且模式切换与 pagehide 清理预览和覆盖 UI', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="move"]');
  const headingBox = await heading.boundingBox();
  await page.mouse.move(headingBox.x + 8, headingBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(headingBox.x + 48, headingBox.y + 28);
  await page.evaluate(() => {
    const iframe = document.querySelector('#deck-frame');
    iframe.contentWindow.postMessage({ type: 'set-editor-mode', mode: 'preview' }, location.origin);
  });
  await page.waitForTimeout(50);
  await page.mouse.up();
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.equal((await session(app)).revision, 0);

  const svg = frame.locator('[data-test-complex-svg]');
  await page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    element.dataset.testComplexSvg = '';
    element.setAttribute('viewBox', '0 0 200 100');
    Object.assign(element.style, {
      position: 'absolute', left: '600px', top: '300px', width: '200px', height: '100px',
      zIndex: '2', pointerEvents: 'auto',
    });
    element.innerHTML = '<g><rect width="200" height="100" fill="#c7000b"></rect></g>';
    document.querySelector('section[data-label]').append(element);
  });
  await page.click('[data-mode="resize"]');
  await frame.locator('html[data-deck-editor-mode="resize"]').waitFor();
  const clickPoint = await page.locator('#deck-frame').evaluate(frameElement => {
    const rect = frameElement.contentDocument.querySelector('[data-test-complex-svg]').getBoundingClientRect();
    const frameRect = frameElement.getBoundingClientRect();
    return {
      x: frameRect.left + (rect.left + rect.width / 2) * frameRect.width / frameElement.offsetWidth,
      y: frameRect.top + (rect.top + rect.height / 2) * frameRect.height / frameElement.offsetHeight,
    };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  const handle = frame.locator('[data-resize-handle]');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 36, handleBox.y + handleBox.height / 2 + 18);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  const state = await session(app);
  const resize = state.groups[0].actions[0];
  assert.equal(resize.kind, 'resize');
  assert.deepEqual(Object.keys(resize.payload), ['scale']);
  assert.ok(resize.after.scale > resize.before.scale, JSON.stringify(resize));
  assert.equal(await svg.evaluate(element => Number(element.style.scale)), resize.after.scale);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForTimeout(80);
  assert.equal(await frame.locator('[data-deck-editor-ui]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
