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

async function createManualTextAction(page, text) {
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.locator('[data-mode="text"]').click();
  await heading.dblclick();
  await heading.fill(text);
  await heading.press('Meta+Enter');
}

async function createManualMoveAction(page) {
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  await page.locator('[data-mode="move"]').click();
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 30);
  await page.mouse.up();
}

async function createManualResizeAction(page) {
  const frame = page.frameLocator('#deck-frame');
  await page.locator('[data-mode="resize"]').click();
  await frame.locator('.card').first().click();
  const handle = frame.locator('[data-resize-handle]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20);
  await page.mouse.up();
}

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
  assert.equal(await undo.getAttribute('title'), '撤销');
  assert.equal(await redo.getAttribute('title'), '重做');

  await createManualTextAction(page, '人工新标题');
  await waitForRevision(page, 1);
  assert.equal(await undo.isEnabled(), true);
  assert.match(await undo.getAttribute('title'), /撤销文字修改/);
  await undo.click();
  await waitForRevision(page, 2);
  assert.equal(await heading.textContent(), '第一页标题');
  assert.equal(await redo.isEnabled(), true);
  assert.match(await redo.getAttribute('title'), /重做文字修改/);
  await redo.click();
  await waitForRevision(page, 3);
  assert.equal(await heading.textContent(), '人工新标题');

  await createManualMoveAction(page);
  await waitForRevision(page, 4);
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
  await page.waitForFunction(() => {
    const deckDocument = document.querySelector('#deck-frame').contentDocument;
    return deckDocument.querySelector('h2').textContent === 'Agent 批次标题'
      && deckDocument.querySelector('.card').style.translate === '60px 30px';
  });
  assert.match(await undo.getAttribute('title'), /撤销 Agent 任务：整体替换标题并移动卡片/);
  await undo.click();
  await waitForRevision(page, 10);
  assert.equal(await heading.textContent(), '人工新标题');
  assert.equal(await card.evaluate(element => element.style.translate), '');
  assert.equal(await redo.getAttribute('data-group-id'), applied.body.groupId);
  await redo.click();
  await waitForRevision(page, 11);
  assert.equal(await heading.textContent(), 'Agent 批次标题');
  assert.equal(await card.evaluate(element => element.style.translate), '60px 30px');

  await page.locator(`[data-task-undo="${taskId}"]`).click();
  await waitForRevision(page, 12);
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
  assert.equal(await undo.getAttribute('data-group-id'), applied.body.groupId);
  assert.match(await undo.getAttribute('title'), /撤销 Agent 任务：整体替换标题并移动卡片/);
  assert.equal(await redo.isDisabled(), true);

  await createManualTextAction(page, '冲突前标题');
  await waitForRevision(page, 14);
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

  await undo.click();
  await waitForRevision(page, 2);
  await page.waitForFunction(() => /撤销已保存/.test(
    document.querySelector('[data-process-note]')?.textContent ?? '',
  ));
  assert.match(await page.locator('[data-process-note]').textContent(), /同步待确认|同步待重试/);
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
