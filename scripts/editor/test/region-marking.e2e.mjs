import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureServer, openEditor, dragInFrame } from './test-helpers.mjs';

test('拉框弹输入框并跨页持久化两条任务', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');

  await page.locator('#deck-frame').evaluate(frameElement => {
    const section = frameElement.contentDocument.querySelector('section[data-label]');
    for (let index = 0; index < 20; index += 1) {
      const candidate = frameElement.contentDocument.createElement('span');
      candidate.className = `candidate-${index}`;
      candidate.textContent = `候选 ${index}`;
      Object.assign(candidate.style, {
        position: 'absolute', left: `${300 + index}px`, top: `${300 + index}px`,
        display: 'block', width: '100px', height: '40px',
      });
      section.append(candidate);
    }
  });

  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x: 100, y: 100 }, { x: 400, y: 300 });
  await frame.locator('[data-region-popover] textarea').fill('第一页修改');
  await frame.locator('[data-region-submit]').evaluate(button => {
    button.click();
    button.click();
  });
  await page.waitForSelector('[data-task-row]');
  assert.equal(await page.locator('[data-task-row]').count(), 1, '重复提交不得创建重复任务');

  await page.click('[data-page-index="2"]');
  await dragInFrame(page, { x: 180, y: 110 }, { x: 480, y: 300 });
  await frame.locator('[data-region-popover] textarea').fill('第二页修改');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 2);

  assert.equal(await page.locator('[data-task-row]').count(), 2);
  assert.deepEqual(await page.locator('[data-page-badge]').allTextContents(), ['1', '1']);
  const persistedTasks = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(persistedTasks.length, 2);
  assert.equal(persistedTasks[0].candidates.length, 12, '相交候选必须截断到 12 个');
  for (const task of persistedTasks) {
    assert.ok(task.candidates.length <= 12);
    assert.ok(task.rect.x >= 0 && task.rect.y >= 0);
    assert.ok(task.rect.w > 0 && task.rect.h > 0);
    assert.ok(task.rect.x + task.rect.w <= 1920);
    assert.ok(task.rect.y + task.rect.h <= 1080);
    assert.equal(task.snapshot, undefined);
  }
  const snapshotNames = await readdir(join(app.sessionDir, 'snapshots'));
  assert.equal(snapshotNames.filter(name => name.endsWith('.png')).length, 2);
  for (const name of snapshotNames) {
    const bytes = await readFile(join(app.sessionDir, 'snapshots', name));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }

  await page.reload();
  await page.waitForFunction(() => (
    document.querySelectorAll('[data-task-row]').length === 2
    && document.querySelectorAll('[data-page-badge]').length === 2
  ));
  assert.equal(await page.locator('[data-task-row]').count(), 2);
  assert.deepEqual(await page.locator('[data-page-badge]').allTextContents(), ['1', '1']);

  await page.locator('[data-task-locate]').last().click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  await frame.locator('[data-task-highlight]').waitFor({ state: 'visible' });
  await page.waitForTimeout(1_100);
  assert.equal(await frame.locator('[data-task-highlight]').count(), 1);
  await frame.locator('[data-task-highlight]').waitFor({ state: 'detached', timeout: 1_200 });
  assert.equal(await page.locator('[data-process-all]').innerText(), '交给 Agent 处理全部 2 条');
  await page.locator('[data-process-all]').click();
  assert.match(await page.locator('[data-process-note]').innerText(), /外部 Agent CLI 读取命令.*tasks/);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('区域截图失败时以 snapshot=null 非阻断提交任务', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  await page.click('[data-mode="region"]');
  await page.locator('#deck-frame').evaluate(frameElement => {
    frameElement.contentWindow.html2canvas = async () => { throw new Error('tainted canvas'); };
  });
  await dragInFrame(page, { x: 100, y: 100 }, { x: 300, y: 230 });
  await frame.locator('[data-region-popover] textarea').fill('无快照也要提交');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  const [task] = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(task.snapshotPath, null);
  assert.deepEqual(await readdir(join(app.sessionDir, 'snapshots')), []);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('1440×900 缩放下按可见屏幕像素判断阈值且输入 UI 保持可达尺寸', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  await page.click('[data-mode="region"]');

  await dragInFrame(page, { x: 100, y: 100 }, { x: 104, y: 104 });
  await page.waitForTimeout(100);
  assert.equal(await frame.locator('[data-region-popover]').count(), 0, '4×4 屏幕像素必须视为误操作');

  await dragInFrame(page, { x: 100, y: 100 }, { x: 106, y: 106 });
  await frame.locator('[data-region-popover]').waitFor({ state: 'visible' });
  const popoverBox = await frame.locator('[data-region-popover]').boundingBox();
  const submitBox = await frame.locator('[data-region-submit]').boundingBox();
  const frameBox = await page.locator('#deck-frame').boundingBox();
  const typography = await frame.locator('[data-region-popover] textarea').evaluate(textarea => ({
    fontSize: Number.parseFloat(getComputedStyle(textarea).fontSize),
    lineHeight: Number.parseFloat(getComputedStyle(textarea).lineHeight),
  }));
  assert.ok(popoverBox.width >= 330 && popoverBox.width <= 342, JSON.stringify(popoverBox));
  assert.ok(submitBox.height >= 32, JSON.stringify(submitBox));
  assert.ok(typography.fontSize >= 13 && typography.lineHeight >= 18, JSON.stringify(typography));
  assert.ok(popoverBox.x >= frameBox.x && popoverBox.x + popoverBox.width <= frameBox.x + frameBox.width + 1);
  assert.ok(popoverBox.y >= frameBox.y && popoverBox.y + popoverBox.height <= frameBox.y + frameBox.height + 1);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('候选排除 opacity 祖先隐藏子元素和全页布局容器但保留内容元素', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  const locatorPaths = await page.locator('#deck-frame').evaluate(frameElement => {
    const { contentDocument: document, contentWindow: window } = frameElement;
    const section = document.querySelector('section[data-label]');
    const visible = document.createElement('img');
    visible.alt = '可见内容图';
    visible.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    Object.assign(visible.style, {
      position: 'absolute', left: '300px', top: '300px', width: '120px', height: '80px',
    });
    const hiddenParent = document.createElement('div');
    hiddenParent.className = 'hidden-parent';
    hiddenParent.style.opacity = '0';
    const hiddenChild = document.createElement('span');
    hiddenChild.className = 'hidden-child';
    hiddenChild.textContent = '不可见候选';
    Object.assign(hiddenChild.style, {
      position: 'absolute', left: '320px', top: '320px', width: '120px', height: '80px',
    });
    hiddenParent.append(hiddenChild);
    const wholePage = document.createElement('div');
    wholePage.className = 'whole-page-layout';
    Object.assign(wholePage.style, {
      position: 'absolute', left: '8px', top: '0px', width: '1920px', height: '1080px',
      pointerEvents: 'none',
    });
    section.append(visible, hiddenParent, wholePage);
    return {
      visible: window.HuaweiDeckPatchRuntime.makeLocator(visible).path,
      hidden: window.HuaweiDeckPatchRuntime.makeLocator(hiddenChild).path,
      wholePage: window.HuaweiDeckPatchRuntime.makeLocator(wholePage).path,
    };
  });
  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x: 100, y: 100 }, { x: 300, y: 260 });
  await frame.locator('[data-region-popover] textarea').fill('候选过滤');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  const [task] = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  const paths = task.candidates.map(candidate => candidate.path);
  assert.ok(paths.includes(locatorPaths.visible), JSON.stringify(paths));
  assert.ok(!paths.includes(locatorPaths.hidden), JSON.stringify(paths));
  assert.ok(!paths.includes(locatorPaths.wholePage), JSON.stringify(paths));
  assert.ok(paths.length <= 12);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('PNG 快照超限时提交前仅降级一次 snapshot=null 并成功创建任务', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  const taskPosts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') {
      taskPosts.push(request.url());
    }
  });
  await page.click('[data-mode="region"]');
  await page.locator('#deck-frame').evaluate(frameElement => {
    const { contentDocument: document, contentWindow: window } = frameElement;
    const bytes = new Uint8Array(512 * 1024 + 9);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const oversized = `data:image/png;base64,${window.btoa(binary)}`;
    window.html2canvas = async () => document.createElement('canvas');
    window.HTMLCanvasElement.prototype.toDataURL = () => oversized;
  });
  await dragInFrame(page, { x: 100, y: 100 }, { x: 300, y: 230 });
  await frame.locator('[data-region-popover] textarea').fill('超限快照降级提交');
  await frame.locator('[data-region-submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1, null, { timeout: 3_000 });
  const [task] = await fetch(`${app.url}/api/tasks?token=${app.token}`).then(response => response.json());
  assert.equal(task.snapshotPath, null);
  assert.equal(taskPosts.length, 1, '提交前预检后只发送一次无快照请求');
  assert.deepEqual(await readdir(join(app.sessionDir, 'snapshots')), []);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('小于 6×6 屏幕像素的误操作不打开输入框', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.click('[data-mode="region"]');
  await dragInFrame(page, { x: 100, y: 100 }, { x: 101, y: 101 });
  await page.waitForTimeout(100);
  assert.equal(await page.frameLocator('#deck-frame').locator('[data-region-popover]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('邻近输入框按右侧、左侧、选区内右下顺序降级且 pagehide 清理注入 UI', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  const frame = page.frameLocator('#deck-frame');
  await page.click('[data-mode="region"]');

  await dragInFrame(page, { x: 100, y: 100 }, { x: 250, y: 200 });
  assert.equal(await frame.locator('[data-region-popover]').getAttribute('data-placement'), 'right');
  await frame.locator('[data-region-popover] textarea').press('Escape');

  await dragInFrame(page, { x: 650, y: 100 }, { x: 790, y: 200 });
  assert.equal(await frame.locator('[data-region-popover]').getAttribute('data-placement'), 'left');
  await frame.locator('[data-region-popover] textarea').press('Escape');

  await dragInFrame(page, { x: 10, y: 40 }, { x: 830, y: 400 });
  assert.equal(await frame.locator('[data-region-popover]').getAttribute('data-placement'), 'inside');
  const selectionBox = await frame.locator('[data-region-selection]').boundingBox();
  const insideBox = await frame.locator('[data-region-popover]').boundingBox();
  assert.ok(Math.abs((insideBox.x + insideBox.width) - (selectionBox.x + selectionBox.width)) < 3);
  assert.ok(Math.abs((insideBox.y + insideBox.height) - (selectionBox.y + selectionBox.height)) < 3);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForTimeout(100);
  assert.equal(await frame.locator('[data-deck-editor-ui]').count(), 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
