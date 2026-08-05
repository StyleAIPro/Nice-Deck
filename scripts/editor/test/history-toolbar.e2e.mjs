import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

async function readSession(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

async function postJson(app, pathname, body) {
  const response = await fetch(`${app.url}${pathname}?token=${app.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  return { response, body:await response.json() };
}

async function waitForRevision(page, revision) {
  await page.waitForFunction(expected => (
    document.querySelector('[data-revision]')?.textContent === String(expected)
  ), revision);
}

async function waitForHistoryReady(page) {
  await page.waitForFunction(() => (
    document.querySelector('.history-controls')?.dataset.busy === 'false'
  ));
}

async function createManualTextAction(page, text) {
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.locator('[data-mode="edit"]').click();
  await heading.dblclick();
  await heading.fill(text);
  await heading.press('Meta+Enter');
}

async function createManualMoveAction(page) {
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.locator('[data-mode="edit"]').click();
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 30);
  await page.mouse.up();
}

async function createManualResizeAction(page) {
  const frame = page.frameLocator('#deck-frame');
  await page.locator('[data-mode="edit"]').click();
  await frame.locator('.card').first().click();
  const handle = frame.locator('[data-resize-handle]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20);
  await page.mouse.up();
}

async function reloadWithoutHistoryEvents(page) {
  await page.routeWebSocket(url => url.pathname === '/events', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      let event;
      try { event = JSON.parse(String(message)); } catch {}
      if (['actions-recorded', 'group-undone', 'group-redone'].includes(event?.type)) return;
      socket.send(message);
    });
  });
  await page.reload();
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');
}

test('键盘快捷键跨 parent 与画布撤销重做，文字输入保留原生撤销', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();

  await createManualTextAction(page, '快捷键标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Meta+z');
  await waitForRevision(page, 2);
  assert.equal(await heading.textContent(), '第一页标题');

  await heading.click();
  await page.keyboard.press('Meta+Shift+z');
  await waitForRevision(page, 3);
  assert.equal(await heading.textContent(), '快捷键标题');

  await heading.dblclick();
  await heading.fill('输入中的临时文字');
  await heading.press('Meta+z');
  await page.waitForTimeout(120);
  assert.equal(await page.locator('[data-revision]').textContent(), '3');
  await heading.press('Escape');
  assert.equal(await heading.textContent(), '快捷键标题');

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await waitForRevision(page, 4);
  assert.equal(await heading.textContent(), '第一页标题');

  await heading.click();
  await page.keyboard.press('Control+y');
  await waitForRevision(page, 5);
  assert.equal(await heading.textContent(), '快捷键标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('撤销与重做移动后选中框和缩放控制点跟随元素位置', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await createManualMoveAction(page);
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);

  const selectionAlignment = () => page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const element = document.querySelector('h2').getBoundingClientRect();
    const overlay = document.querySelector('[data-transform-selection]').getBoundingClientRect();
    const handle = document.querySelector('[data-resize-handle]').getBoundingClientRect();
    return {
      overlay:Math.abs(overlay.left - element.left) < 1
        && Math.abs(overlay.top - element.top) < 1
        && Math.abs(overlay.width - element.width) < 1
        && Math.abs(overlay.height - element.height) < 1,
      handle:Math.abs(handle.left + handle.width / 2 - element.right) < 1
        && Math.abs(handle.top + handle.height / 2 - element.bottom) < 1,
    };
  });
  assert.deepEqual(await selectionAlignment(), { overlay:true, handle:true });

  await page.locator('[data-history-undo]').click();
  await waitForRevision(page, 2);
  await waitForHistoryReady(page);
  assert.equal(await heading.evaluate(element => element.style.translate), '');
  assert.deepEqual(await selectionAlignment(), { overlay:true, handle:true });

  await page.locator('[data-history-redo]').click();
  await waitForRevision(page, 3);
  await waitForHistoryReady(page);
  assert.notEqual(await heading.evaluate(element => element.style.translate), '');
  assert.deepEqual(await selectionAlignment(), { overlay:true, handle:true });
});

test('顶栏从权威 session 撤销重做人工与 Agent 历史并拒绝自动重试陈旧候选', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);

  const undo = page.locator('[data-history-undo]');
  const redo = page.locator('[data-history-redo]');
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  const card = frame.locator('.card').first();
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  assert.equal(await undo.getAttribute('title'), '撤销 · Cmd/Ctrl+Z');
  assert.equal(await redo.getAttribute('title'), '重做 · Cmd/Ctrl+Shift+Z');

  await createManualTextAction(page, '人工新标题');
  await waitForRevision(page, 1);
  await waitForHistoryReady(page);
  assert.equal(await undo.isEnabled(), true);
  assert.match(await undo.getAttribute('title'), /撤销文字修改/);
  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await waitForRevision(page, 2);
  await waitForHistoryReady(page);
  assert.equal(await heading.textContent(), '第一页标题');
  assert.equal(await redo.isEnabled(), true);
  assert.match(await redo.getAttribute('title'), /重做文字修改/);
  await redo.click();
  await waitForRevision(page, 3);
  assert.equal(await heading.textContent(), '人工新标题');

  await createManualMoveAction(page);
  await waitForRevision(page, 4);
  await waitForHistoryReady(page);
  assert.match(await undo.getAttribute('title'), /撤销移动/);
  assert.notEqual(await heading.evaluate(element => element.style.translate), '');
  await undo.click();
  await waitForRevision(page, 5);
  assert.equal(await heading.evaluate(element => element.style.translate), '');

  const originalCardSize = await card.evaluate(element => ({
    width:Number.parseFloat(getComputedStyle(element).width),
    height:Number.parseFloat(getComputedStyle(element).height),
  }));
  await createManualResizeAction(page);
  await waitForRevision(page, 6);
  await waitForHistoryReady(page);
  assert.match(await undo.getAttribute('title'), /撤销缩放/);
  assert.ok(await card.evaluate((element, original) => (
    Number.parseFloat(element.style.width) > original.width
      && Number.parseFloat(element.style.height) > original.height
  ), originalCardSize));
  await undo.click();
  await waitForRevision(page, 7);
  assert.deepEqual(await card.evaluate(element => ({
    width:Number.parseFloat(getComputedStyle(element).width),
    height:Number.parseFloat(getComputedStyle(element).height),
  })), originalCardSize);

  const targets = await page.locator('#deck-frame').evaluate(frameElement => {
    const document = frameElement.contentDocument;
    const runtime = frameElement.contentWindow.HuaweiDeckPatchRuntime;
    return {
      heading:runtime.makeLocator(document.querySelector('h2')),
      card:runtime.makeLocator(document.querySelector('.card')),
      secondHeading:runtime.makeLocator(document.querySelectorAll('h2')[1]),
    };
  });
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:7,
    pageKey:targets.heading.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:180 },
    instruction:'整体替换标题并移动卡片',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:8,
    taskId,
    actions:[
      { id:'history-agent-text', taskId, target:targets.heading, kind:'setText', payload:{ text:'Agent 批次标题' } },
      { id:'history-agent-move', taskId, target:targets.card, kind:'translate', payload:{ x:60, y:30 } },
    ],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await waitForRevision(page, 9);
  await waitForHistoryReady(page);
  await page.waitForFunction(() => {
    const deckDocument = document.querySelector('#deck-frame').contentDocument;
    return deckDocument.querySelector('h2').textContent === 'Agent 批次标题'
      && deckDocument.querySelector('.card').style.translate === '60px 30px';
  });
  assert.match(await undo.getAttribute('title'), /撤销 Agent 任务：整体替换标题并移动卡片/);
  await undo.click();
  await waitForRevision(page, 10);
  await waitForHistoryReady(page);
  assert.equal(await heading.textContent(), '人工新标题');
  assert.equal(await card.evaluate(element => element.style.translate), '');
  assert.equal(await redo.getAttribute('data-group-id'), applied.body.groupId);
  await redo.click();
  await waitForRevision(page, 11);
  assert.equal(await heading.textContent(), 'Agent 批次标题');
  assert.equal(await card.evaluate(element => element.style.translate), '60px 30px');

  await page.locator(`[data-task-undo="${taskId}"]`).click();
  await waitForRevision(page, 12);
  await waitForHistoryReady(page);
  assert.equal(await heading.textContent(), '人工新标题');
  assert.equal(await redo.getAttribute('data-group-id'), applied.body.groupId);
  assert.match(await redo.getAttribute('title'), /重做 Agent 任务：整体替换标题并移动卡片/);
  await redo.click();
  await waitForRevision(page, 13);
  await page.waitForSelector(`[data-task-row="${taskId}"] .task-status-completed`);
  assert.equal(await heading.textContent(), 'Agent 批次标题');

  await page.reload();
  await waitForRevision(page, 13);
  await page.waitForSelector('[data-page-key]');
  await waitForHistoryReady(page);
  assert.equal(await undo.getAttribute('data-group-id'), applied.body.groupId);
  assert.match(await undo.getAttribute('title'), /撤销 Agent 任务：整体替换标题并移动卡片/);
  assert.equal(await redo.isDisabled(), true);

  await createManualTextAction(page, '冲突前标题');
  await waitForRevision(page, 14);
  await waitForHistoryReady(page);
  const staleGroupId = await undo.getAttribute('data-group-id');
  let interceptedUndoRequests = 0;
  let releaseUndo;
  const undoReleased = new Promise(resolve => { releaseUndo = resolve; });
  let markUndoIntercepted;
  const undoIntercepted = new Promise(resolve => { markUndoIntercepted = resolve; });
  await page.route('**/api/groups/**/undo*', async route => {
    interceptedUndoRequests += 1;
    markUndoIntercepted();
    await undoReleased;
    await route.continue();
  });
  const clickPromise = undo.click();
  await undoIntercepted;
  assert.equal(await undo.isDisabled(), true, '请求期间撤销按钮必须锁定');
  assert.equal(await redo.isDisabled(), true, '请求期间重做按钮必须锁定');
  assert.equal(await undo.locator('xpath=..').getAttribute('data-busy'), 'true');

  const concurrent = await postJson(app, '/api/actions', {
    expectedRevision:14,
    taskId:null,
    actions:[{
      id:'history-concurrent-text', taskId:null, target:targets.secondHeading,
      kind:'setText', payload:{ text:'并发新候选' },
    }],
  });
  assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
  releaseUndo();
  await clickPromise;
  await waitForRevision(page, 15);
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId === id
  ), concurrent.body.groupId);
  assert.equal(interceptedUndoRequests, 1, '陈旧 revision 不得自动重试新的候选');
  assert.notEqual(staleGroupId, concurrent.body.groupId);
  assert.equal(await heading.textContent(), '冲突前标题');
  assert.equal(await frame.locator('h2').nth(1).textContent(), '并发新候选');
  const finalState = await readSession(app);
  assert.equal(finalState.revision, 15);
  assert.equal(finalState.groups.at(-2).active, true);
  assert.equal(finalState.groups.at(-1).active, true);
  assert.deepEqual(
    browserProblems.splice(0),
    ['Failed to load resource: the server responded with a status of 409 (Conflict)'],
    '仅允许测试刻意制造的 revision conflict 资源日志',
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('外部历史事件刷新权威 session 前锁定旧候选', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, '已有人工标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  const previousGroupId = await undo.getAttribute('data-group-id');
  const secondHeadingTarget = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelectorAll('h2')[1],
    )
  ));

  let releaseSession;
  const sessionReleased = new Promise(resolve => { releaseSession = resolve; });
  let markSessionIntercepted;
  const sessionIntercepted = new Promise(resolve => { markSessionIntercepted = resolve; });
  await page.route('**/api/session*', async route => {
    markSessionIntercepted();
    await sessionReleased;
    await route.continue();
  });

  try {
    const concurrent = await postJson(app, '/api/actions', {
      expectedRevision:1,
      taskId:null,
      actions:[{
        id:'history-refresh-race', taskId:null, target:secondHeadingTarget,
        kind:'setText', payload:{ text:'外部最新标题' },
      }],
    });
    assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
    await sessionIntercepted;
    await waitForRevision(page, 2);
    assert.equal(await undo.isDisabled(), true, '权威 group 尚未刷新时必须锁定旧候选');
    assert.equal(await undo.getAttribute('data-group-id'), '');
    assert.equal(await undo.locator('xpath=..').getAttribute('aria-busy'), 'true');
    assert.notEqual(previousGroupId, concurrent.body.groupId);
  } finally {
    releaseSession();
  }

  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  const state = await readSession(app);
  assert.equal(await undo.getAttribute('data-group-id'), state.groups.at(-1).id);
  assert.equal(await page.frameLocator('#deck-frame').locator('h2').nth(1).textContent(), '外部最新标题');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('group API 已保存但 session 刷新失败时保持同步待确认语义', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, '等待同步的标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  let sessionRequests = 0;
  await page.route('**/api/session*', async route => {
    sessionRequests += 1;
    await route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'测试中的 session 暂时不可用' }),
    });
  });

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await waitForRevision(page, 2);
  await page.waitForFunction(() => /撤销已保存/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  assert.match(await page.locator('[data-history-notice]').textContent(), /同步待确认|同步待重试/);
  assert.equal(await page.locator('[data-task-drawer]').getAttribute('data-open'), 'false',
    '全局撤销的同步提示不应自动展开 Agent 任务面板');
  assert.equal(sessionRequests, 1, '已保存后的 session 刷新失败不得进入通用失败分支重试');
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  const state = await readSession(app);
  assert.equal(state.revision, 2);
  assert.equal(state.groups[0].active, false);
  assert.equal(await page.frameLocator('#deck-frame').locator('h2').first().textContent(), '第一页标题');
  assert.deepEqual(browserProblems.splice(0), [
    'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
  ]);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('HTTP 先于 history WebSocket 时人工动作与任务行撤销都先锁定旧候选', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');
  const redo = page.locator('[data-history-redo]');

  await createManualTextAction(page, '第一组人工标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  await reloadWithoutHistoryEvents(page);
  await waitForRevision(page, 1);
  const firstGroupId = await undo.getAttribute('data-group-id');

  let releaseManualSession;
  const manualSessionReleased = new Promise(resolve => { releaseManualSession = resolve; });
  let markManualSession;
  const manualSessionIntercepted = new Promise(resolve => { markManualSession = resolve; });
  await page.route('**/api/session*', async route => {
    markManualSession();
    await manualSessionReleased;
    await route.continue();
  });
  try {
    await createManualTextAction(page, '第二组人工标题');
    await manualSessionIntercepted;
    await waitForRevision(page, 2);
    assert.equal(await undo.isDisabled(), true, '人工动作 HTTP 成功后必须立刻锁定旧候选');
    assert.equal(await undo.getAttribute('data-group-id'), '');
    assert.notEqual(firstGroupId, '');
  } finally {
    releaseManualSession();
  }
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId !== ''
      && document.querySelector('[data-history-undo]')?.dataset.groupId !== id
  ), firstGroupId);
  await page.unroute('**/api/session*');

  const target = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelector('h2'),
    )
  ));
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:2,
    pageKey:target.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:180 },
    instruction:'定点撤销门控测试',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:3,
    taskId,
    actions:[{
      id:'history-task-gate', taskId, target, kind:'setText', payload:{ text:'任务完成标题' },
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await page.reload();
  await waitForRevision(page, 4);
  await page.waitForSelector(`[data-task-undo="${taskId}"]`);
  assert.equal(await undo.getAttribute('data-group-id'), applied.body.groupId);

  let releaseUndoSession;
  const undoSessionReleased = new Promise(resolve => { releaseUndoSession = resolve; });
  let markUndoSession;
  const undoSessionIntercepted = new Promise(resolve => { markUndoSession = resolve; });
  await page.route('**/api/session*', async route => {
    markUndoSession();
    await undoSessionReleased;
    await route.continue();
  });
  try {
    await page.locator(`[data-task-undo="${taskId}"]`).click();
    await undoSessionIntercepted;
    await waitForRevision(page, 5);
    assert.equal(await undo.isDisabled(), true, '任务行撤销 HTTP 成功后必须锁定旧候选');
    assert.equal(await redo.isDisabled(), true);
    assert.equal(await undo.getAttribute('data-group-id'), '');
    assert.equal(await redo.getAttribute('data-group-id'), '');
  } finally {
    releaseUndoSession();
  }
  await page.waitForFunction(id => (
    document.querySelector('[data-history-redo]')?.dataset.groupId === id
  ), applied.body.groupId);
  assert.equal(await redo.isEnabled(), true);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('409 无 revision 且 session 503 时持续锁定并在后续快照成功后恢复', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, '冲突前已有标题');
  await waitForRevision(page, 1);
  await page.waitForFunction(() => document.querySelector('[data-history-undo]')?.disabled === false);
  const secondHeadingTarget = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelectorAll('h2')[1],
    )
  ));
  let groupRequests = 0;
  await page.route('**/api/groups/**/undo*', async route => {
    groupRequests += 1;
    await route.fulfill({
      status:409,
      contentType:'application/json',
      body:JSON.stringify({ error:'REVISION_CONFLICT', message:'测试中的无 revision 冲突' }),
    });
  });
  let allowSession = false;
  await page.route('**/api/session*', async route => {
    if (allowSession) return route.continue();
    return route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'测试中的 session 暂不可用' }),
    });
  });

  await undo.click();
  await page.waitForFunction(() => /历史已更新/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  assert.equal(groupRequests, 1, '409 不得自动重发 group 请求');
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  assert.equal((await readSession(app)).revision, 1);

  allowSession = true;
  const concurrent = await postJson(app, '/api/actions', {
    expectedRevision:1,
    taskId:null,
    actions:[{
      id:'history-conflict-recovery', taskId:null, target:secondHeadingTarget,
      kind:'setText', payload:{ text:'冲突后的权威候选' },
    }],
  });
  assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId === id
      && document.querySelector('[data-history-undo]')?.disabled === false
  ), concurrent.body.groupId);
  assert.equal(groupRequests, 1);
  assert.ok(browserProblems.every(problem => /409 \(Conflict\)|503 \(Service Unavailable\)/.test(problem)),
    JSON.stringify(browserProblems));
  browserProblems.splice(0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('committed 错误响应不重发 group 请求并等待后续权威快照恢复', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');

  await createManualTextAction(page, 'committed 分支标题');
  await waitForRevision(page, 1);
  const secondHeadingTarget = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelectorAll('h2')[1],
    )
  ));
  let groupRequests = 0;
  await page.route('**/api/groups/**/undo*', async route => {
    groupRequests += 1;
    const response = await route.fetch();
    const body = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(body));
    await route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({
        ...body,
        error:'RECOVERY_REQUIRED',
        message:'测试中的已提交回执异常',
        committed:true,
      }),
    });
  });
  let allowSession = false;
  await page.route('**/api/session*', async route => {
    if (allowSession) return route.continue();
    return route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'测试中的 session 暂不可用' }),
    });
  });

  await undo.click();
  await waitForRevision(page, 2);
  await page.waitForFunction(() => /撤销已保存.*同步待确认/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  assert.equal(groupRequests, 1);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  const committedState = await readSession(app);
  assert.equal(committedState.revision, 2);
  assert.equal(committedState.groups[0].active, false);

  allowSession = true;
  const concurrent = await postJson(app, '/api/actions', {
    expectedRevision:2,
    taskId:null,
    actions:[{
      id:'history-committed-recovery', taskId:null, target:secondHeadingTarget,
      kind:'setText', payload:{ text:'committed 后权威候选' },
    }],
  });
  assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
  await page.waitForFunction(id => (
    document.querySelector('[data-history-undo]')?.dataset.groupId === id
      && document.querySelector('[data-history-undo]')?.disabled === false
  ), concurrent.body.groupId);
  assert.equal(groupRequests, 1);
  assert.ok(browserProblems.every(problem => /503 \(Service Unavailable\)/.test(problem)),
    JSON.stringify(browserProblems));
  browserProblems.splice(0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('真实 syncPending 响应在权威 session 收敛前锁定且不重发 group 请求', async t => {
  const app = await startFixtureServer({ bridgeTimeoutMs:100 });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');
  const redo = page.locator('[data-history-redo]');

  await createManualTextAction(page, 'syncPending 分支标题');
  await waitForRevision(page, 1);
  const groupId = await undo.getAttribute('data-group-id');
  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      let message;
      try { message = JSON.parse(String(data)); } catch { return originalSend.call(this, data); }
      if (message.type === 'actions-committed' || message.type === 'actions-synced') return;
      return originalSend.call(this, data);
    };
  });
  let releaseSession;
  const sessionReleased = new Promise(resolve => { releaseSession = resolve; });
  let markSession;
  const sessionIntercepted = new Promise(resolve => { markSession = resolve; });
  await page.route('**/api/session*', async route => {
    markSession();
    await sessionReleased;
    await route.continue();
  });
  let groupRequests = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/groups\/[^/]+\/undo$/.test(new URL(request.url()).pathname)) {
      groupRequests += 1;
    }
  });
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'POST'
      && /\/api\/groups\/[^/]+\/undo$/.test(new URL(response.url()).pathname)
  ));

  await undo.click();
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.syncPending, true, JSON.stringify(body));
  await sessionIntercepted;
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await redo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  assert.equal(await redo.getAttribute('data-group-id'), '');
  assert.equal(groupRequests, 1);
  releaseSession();

  await page.waitForFunction(() => /撤销已保存.*浏览器同步待重试/.test(
    document.querySelector('[data-history-notice]')?.textContent ?? '',
  ));
  await page.waitForFunction(id => (
    document.querySelector('[data-history-redo]')?.dataset.groupId === id
      && document.querySelector('[data-history-redo]')?.disabled === false
  ), groupId);
  assert.equal(groupRequests, 1);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('任务行撤销已保存但 session 刷新失败时不误报未提交失败', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(6_000);
  const undo = page.locator('[data-history-undo]');
  const target = await page.locator('#deck-frame').evaluate(frameElement => (
    frameElement.contentWindow.HuaweiDeckPatchRuntime.makeLocator(
      frameElement.contentDocument.querySelector('h2'),
    )
  ));
  const created = await postJson(app, '/api/tasks', {
    expectedRevision:0,
    pageKey:target.pageKey,
    pageIndex:1,
    pageLabel:'目录页',
    rect:{ x:20, y:20, w:400, h:180 },
    instruction:'任务行 durable 语义测试',
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const applied = await postJson(app, '/api/actions', {
    expectedRevision:1,
    taskId,
    actions:[{
      id:'history-task-durable', taskId, target, kind:'setText', payload:{ text:'任务 durable 标题' },
    }],
  });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  await waitForRevision(page, 2);
  await page.waitForSelector(`[data-task-undo="${taskId}"]`);
  let sessionRequests = 0;
  await page.route('**/api/session*', async route => {
    sessionRequests += 1;
    await route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:'TEMPORARY_UNAVAILABLE', message:'任务行测试中的 session 暂不可用' }),
    });
  });

  await page.locator(`[data-task-undo="${taskId}"]`).click();
  await waitForRevision(page, 3);
  await page.waitForFunction(() => /撤销已保存/.test(
    document.querySelector('[data-process-note]')?.textContent ?? '',
  ));
  assert.doesNotMatch(await page.locator('[data-process-note]').textContent(), /撤销失败/);
  assert.match(await page.locator('[data-process-note]').textContent(), /会话同步待重试/);
  assert.equal(sessionRequests, 1);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.getAttribute('data-group-id'), '');
  const state = await readSession(app);
  assert.equal(state.revision, 3);
  assert.equal(state.groups[0].active, false);
  assert.ok(browserProblems.every(problem => /503 \(Service Unavailable\)/.test(problem)),
    JSON.stringify(browserProblems));
  browserProblems.splice(0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
