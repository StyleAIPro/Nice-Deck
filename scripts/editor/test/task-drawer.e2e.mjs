import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

test('待确认任务显示原因、补充说明入口与提醒动画', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=needs-confirmation`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testTaskDrawer = '';
    root.dataset.open = 'true';
    document.body.append(root);
    renderTaskDrawer(root, {
      tasks:[{
        id:'task-needs-confirmation',
        pageKey:'page-002',
        pageIndex:2,
        pageLabel:'目录',
        rect:{ x:10, y:10, w:200, h:120 },
        instruction:'把流程图改成一个完整整体',
        status:'needs-confirmation',
        candidates:[{ path:'0/1' }, { path:'0/2' }],
      }],
      onEdit() {},
      onDelete() {},
    });
  }, app.token);

  const root = page.locator('[data-test-task-drawer]');
  const row = root.locator('[data-task-row="task-needs-confirmation"]');
  const notice = row.locator('[data-task-confirmation-notice]');
  assert.match(await notice.innerText(), /多个可能目标/);
  assert.match(await notice.innerText(), /补充说明/);
  assert.equal(
    await row.locator('[data-task-edit] .pill-nav-label-default').innerText(),
    '补充说明',
  );
  assert.equal(
    await root.locator('[data-process-all] .pill-nav-label-default').innerText(),
    '有 1 条任务需要补充说明',
  );
  assert.equal(await root.locator('[data-process-all]').isDisabled(), true);
  assert.match(await root.locator('[data-process-note]').innerText(), /定位不唯一/);

  const animationName = await row.locator('.task-confirmation-indicator').evaluate(
    node => getComputedStyle(node).animationName,
  );
  assert.equal(animationName, 'task-confirmation-pulse');
  await page.emulateMedia({ reducedMotion:'reduce' });
  const reducedAnimationName = await row.locator('.task-confirmation-indicator').evaluate(
    node => getComputedStyle(node).animationName,
  );
  assert.equal(reducedAnimationName, 'none');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('目标页面已删除的任务保留记录但不能定位或交给 Agent', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=target-missing`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testMissingTaskDrawer = '';
    root.dataset.open = 'true';
    document.body.append(root);
    renderTaskDrawer(root, {
      tasks:[{
        id:'task-target-missing',
        pageKey:'page-deleted',
        pageIndex:2,
        pageLabel:'已删除页',
        rect:{ x:10, y:10, w:200, h:120 },
        instruction:'把标题改短',
        status:'pending',
        targetMissing:true,
      }],
      onLocate() { window.__missingTaskLocated = true; },
      onProcessAll() { window.__missingTaskProcessed = true; },
      onEdit() {},
      onDelete() {},
    });
  }, app.token);

  const root = page.locator('[data-test-missing-task-drawer]');
  const row = root.locator('[data-task-row="task-target-missing"]');
  assert.equal(await row.locator('[data-task-locate]').isDisabled(), true);
  assert.match(await row.locator('[data-task-target-missing]').innerText(), /页面已删除/);
  assert.equal(await row.locator('[data-task-edit]').count(), 0);
  assert.equal(await row.locator('[data-task-delete]').count(), 1);
  assert.equal(await root.locator('[data-process-all]').isDisabled(), true);
  assert.match(await root.locator('[data-process-note]').innerText(), /删除任务记录或撤销删页/);
  assert.deepEqual(await page.evaluate(() => ({
    located:Boolean(window.__missingTaskLocated),
    processed:Boolean(window.__missingTaskProcessed),
  })), { located:false, processed:false });
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('已完成任务按最近修改时间倒序展示，待处理任务保持原顺序', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.evaluate(async token => {
    const { renderTaskDrawer } = await import(
      `/editor/task-drawer.mjs?token=${encodeURIComponent(token)}&test=completed-recency`
    );
    const root = document.createElement('aside');
    root.className = 'task-drawer';
    root.dataset.testCompletedOrder = '';
    root.dataset.open = 'true';
    root.dataset.completedOpen = 'true';
    document.body.append(root);
    const task = (id, instruction, status, updatedAt) => ({
      id,
      pageKey:`page-${id}`,
      pageIndex:1,
      pageLabel:'测试页',
      rect:{ x:10, y:10, w:200, h:120 },
      instruction,
      status,
      updatedAt,
    });
    renderTaskDrawer(root, {
      tasks:[
        task('completed-latest', '最近完成', 'completed', '2026-08-16T12:00:00.000Z'),
        task('pending-first', '待处理一', 'pending', '2026-08-16T12:05:00.000Z'),
        task('completed-earliest', '最早完成', 'completed', '2026-08-16T10:00:00.000Z'),
        task('pending-second', '待处理二', 'pending', '2026-08-16T12:06:00.000Z'),
        task('completed-middle', '中间完成', 'completed', '2026-08-16T11:00:00.000Z'),
      ],
      onEdit() {},
      onDelete() {},
    });
  }, app.token);

  const root = page.locator('[data-test-completed-order]');
  assert.deepEqual(
    await root.locator('.task-list > [data-task-row]').evaluateAll(
      rows => rows.map(row => row.dataset.taskRow),
    ),
    ['pending-first', 'pending-second'],
  );
  assert.deepEqual(
    await root.locator('.task-completed-list > [data-task-row]').evaluateAll(
      rows => rows.map(row => row.dataset.taskRow),
    ),
    ['completed-latest', 'completed-middle', 'completed-earliest'],
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
