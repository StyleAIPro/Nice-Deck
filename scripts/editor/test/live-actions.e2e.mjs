import test from 'node:test';
import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';
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

test('Journal 持久化失败时 apply/undo/redo 均回滚浏览器 tentative 状态', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const movedSessionDir = `${app.sessionDir}-persist-failure`;
  const moveSessionAway = () => rename(app.sessionDir, movedSessionDir);
  const restoreSession = () => rename(movedSessionDir, app.sessionDir);

  await moveSessionAway();
  let failed;
  try {
    failed = await postJson(app, '/api/actions', {
      expectedRevision: 0, taskId: null,
      actions: [{ id:'persist-apply', taskId:null, target, kind:'translate', payload:{ x:40,y:20 } }],
    });
  } finally {
    await restoreSession();
  }
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error, 'JOURNAL_PERSIST_FAILED');
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.equal(await heading.evaluate(() => window.HuaweiDeckPatchRuntime.pendingTransactionCount()), 0);
  assert.deepEqual((await session(app)).groups, []);

  const applied = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'persist-base', taskId:null, target, kind:'translate', payload:{ x:40,y:20 } }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await moveSessionAway();
  try {
    failed = await postJson(app, `/api/groups/${applied.body.groupId}/undo`, { expectedRevision: 1 });
  } finally {
    await restoreSession();
  }
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error, 'JOURNAL_PERSIST_FAILED');
  assert.equal(await heading.evaluate(element => element.style.translate), '40px 20px');
  let state = await session(app);
  assert.equal(state.revision, 1);
  assert.equal(state.groups[0].active, true);

  const undone = await postJson(app, `/api/groups/${applied.body.groupId}/undo`, { expectedRevision: 1 });
  assert.equal(undone.response.status, 200, JSON.stringify(undone.body));
  await moveSessionAway();
  try {
    failed = await postJson(app, `/api/groups/${applied.body.groupId}/redo`, { expectedRevision: 2 });
  } finally {
    await restoreSession();
  }
  assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error, 'JOURNAL_PERSIST_FAILED');
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  state = await session(app);
  assert.equal(state.revision, 2);
  assert.equal(state.groups[0].active, false);
  assert.equal(await heading.evaluate(() => window.HuaweiDeckPatchRuntime.pendingTransactionCount()), 0);
});

test('同一文字连续编辑两次并按组逐次撤销', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.click('[data-mode="text"]');
  await heading.dblclick(); await heading.fill('第一次'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await heading.dblclick();
  await heading.fill('第二次');
  await page.waitForTimeout(160);
  assert.equal(await heading.textContent(), '第二次');
  await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  let state = await session(app);
  assert.equal(state.groups.length, 2);
  assert.deepEqual(state.groups.map(group => group.actions[0].after), ['第一次', '第二次']);
  let result = await postJson(app, `/api/groups/${state.groups[1].id}/undo`, { expectedRevision:2 });
  assert.equal(result.response.status, 200);
  assert.equal(await heading.textContent(), '第一次');
  result = await postJson(app, `/api/groups/${state.groups[0].id}/undo`, { expectedRevision:3 });
  assert.equal(result.response.status, 200);
  assert.equal(await heading.textContent(), '第一页标题');
});

test('复杂富文本的叶 span 仍拒绝直接编辑', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  await heading.evaluate(element => { element.innerHTML='<span data-leaf>第一段</span><span>第二段</span>'; });
  await page.click('[data-mode="text"]');
  await frame.locator('[data-leaf]').dblclick();
  await frame.locator('[data-direct-status][data-state="error"]').waitFor();
  assert.match(await frame.locator('[data-direct-status]').innerText(), /区域标记/);
  assert.equal(await frame.locator('[data-leaf]').getAttribute('contenteditable'), null);
  assert.equal((await session(app)).revision, 0);
});

test('move/resize 到 region 的消息窗口只分派区域拉框', async t => {
  for (const previousMode of ['move', 'resize']) {
    await t.test(previousMode, async t => {
      const app = await startFixtureServer();
      t.after(() => app.close());
      const { browser, page } = await openEditor(app);
      t.after(() => browser.close());
      page.setDefaultTimeout(3_000);
      const frame = page.frameLocator('#deck-frame');
      await page.click(`[data-mode="${previousMode}"]`);
      await frame.locator(`html[data-deck-editor-mode="${previousMode}"]`).waitFor();
      await page.locator('[data-mode="region"]').evaluate(region => {
        for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed','false');
        region.setAttribute('aria-pressed','true');
      });
      const frameBox = await page.locator('#deck-frame').boundingBox();
      await page.mouse.move(frameBox.x+100,frameBox.y+100);
      await page.mouse.down();
      await page.mouse.move(frameBox.x+320,frameBox.y+240);
      await page.mouse.up();
      await frame.locator('[data-region-popover]').waitFor();
      assert.equal((await session(app)).revision, 0);
      assert.equal(await frame.locator('[data-transform-selection]').count(), 0);
    });
  }
});

test('CSS translate/scale 是移动与交互组件缩放的真实基值', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  await page.locator('#deck-frame').evaluate(frameElement => {
    const document=frameElement.contentDocument;
    const style=document.createElement('style');
    style.textContent='.css-shift{translate:30px 20px}.css-scale{scale:1.4}';
    document.head.append(style);
    document.querySelector('h2').classList.add('css-shift');
    const link=document.createElement('a');
    link.className='css-scale'; link.href='#';
    link.innerHTML='<span data-interactive-child>交互链接</span>';
    Object.assign(link.style,{position:'absolute',left:'500px',top:'250px',display:'block',width:'180px',height:'60px'});
    document.querySelector('section').append(link);
  });
  await page.click('[data-mode="move"]');
  const box=await heading.boundingBox();
  await page.mouse.move(box.x+8,box.y+8); await page.mouse.down();
  await page.mouse.move(box.x+28,box.y+18); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='1');
  let state=await session(app);
  assert.deepEqual(state.groups[0].actions[0].before,{x:30,y:20});
  assert.ok(state.groups[0].actions[0].after.x>30 && state.groups[0].actions[0].after.y>20);

  await page.click('[data-mode="resize"]');
  const link=frame.locator('a.css-scale');
  await frame.locator('[data-interactive-child]').click();
  const handle=frame.locator('[data-resize-handle]');
  const handleBox=await handle.boundingBox();
  await page.mouse.move(handleBox.x+5,handleBox.y+5); await page.mouse.down();
  await page.mouse.move(handleBox.x+35,handleBox.y+25); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent==='2');
  state=await session(app);
  const resize=state.groups[1].actions[0];
  assert.deepEqual(resize.before,{scale:1.4});
  assert.deepEqual(Object.keys(resize.payload),['scale']);
  assert.equal(resize.target.tag,'A');
  assert.equal(await link.evaluate(element => element.style.width),'180px');
});

test('prepared 后连接断开会撤销 tentative，并在重连后按 sidecar 收敛', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs: 100 });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      originalSend.call(this, data);
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type === 'actions-prepared' && !window.__closedAfterPrepared) {
        window.__closedAfterPrepared = true;
        this.close();
      }
    };
  });

  const result = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'disconnect-prepared', taskId:null, target, kind:'translate', payload:{x:55,y:25} }],
  });
  assert.equal(result.response.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.error, 'EDITOR_SYNC_REQUIRED');
  assert.equal((await session(app)).revision, 1);
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');
  await page.waitForFunction(() => {
    const frame = document.querySelector('#deck-frame');
    const element = frame?.contentDocument?.querySelector('h2');
    return element?.style.translate === '55px 25px'
      && frame.contentWindow.HuaweiDeckPatchRuntime.pendingTransactionCount() === 0;
  });
});

test('undo prepared 后断线重连会移除 sidecar 已撤销的旧 DOM 效果', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs: 100 });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const applied = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'disconnect-undo-base', taskId:null, target, kind:'translate', payload:{x:45,y:20} }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(await heading.evaluate(element => element.style.translate), '45px 20px');

  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      originalSend.call(this, data);
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type === 'actions-prepared' && !window.__closedDuringUndo) {
        window.__closedDuringUndo = true;
        this.close();
      }
    };
  });
  const undone = await postJson(app, `/api/groups/${applied.body.groupId}/undo`, {
    expectedRevision: 1,
  });
  assert.equal(undone.response.status, 503, JSON.stringify(undone.body));
  assert.equal(undone.body.error, 'EDITOR_SYNC_REQUIRED');
  const state = await session(app);
  assert.equal(state.revision, 2);
  assert.equal(state.groups[0].active, false);
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');
  await page.waitForFunction(() => {
    const frame = document.querySelector('#deck-frame');
    const element = frame?.contentDocument?.querySelector('h2');
    return element?.style.translate === ''
      && frame.contentWindow.HuaweiDeckPatchRuntime.pendingTransactionCount() === 0;
  });
});

test('commit ACK 丢失返回稳定错误并以 sidecar 权威状态收敛', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs: 100 });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const target = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      let message;
      try { message = JSON.parse(String(data)); } catch { return originalSend.call(this, data); }
      if (message.type === 'actions-committed' && !window.__droppedCommitAck) {
        window.__droppedCommitAck = true;
        return;
      }
      return originalSend.call(this, data);
    };
  });

  const result = await postJson(app, '/api/actions', {
    expectedRevision: 0, taskId: null,
    actions: [{ id:'lost-commit-ack', taskId:null, target, kind:'translate', payload:{x:65,y:35} }],
  });
  assert.equal(result.response.status, 502, JSON.stringify(result.body));
  assert.equal(result.body.error, 'EDITOR_COMMIT_UNCONFIRMED');
  const state = await session(app);
  assert.equal(state.revision, 1);
  assert.equal(state.groups.length, 1);
  assert.equal(await heading.evaluate(element => element.style.translate), '65px 35px');
  assert.equal(await heading.evaluate(() => window.HuaweiDeckPatchRuntime.pendingTransactionCount()), 0);
});
