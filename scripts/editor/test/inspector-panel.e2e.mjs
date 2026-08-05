import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

async function session(app) {
  return fetch(`${app.url}/api/session?token=${app.token}`).then(response => response.json());
}

test('属性面板识别文字和图形，并将样式修改与恢复写入统一历史', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture
      .replace('<h2>第一页标题</h2>', '<h2 style="color:#123456;font-weight:500">第一页标题</h2>')
      .replace('</section></div>', '<div class="shape" aria-label="测试图形" style="position:absolute;left:900px;top:180px;width:160px;height:100px;background:#ddd"></div></section></div>'),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();

  await page.click('[data-mode="edit"]');
  await heading.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent === '文字');
  assert.match(await page.locator('.inspector-object').innerText(), /第一页标题/);
  assert.equal(await page.locator('.inspector-section').filter({ hasText:'文字' }).count(), 1);

  const textColorField = page.locator('.inspector-field').filter({ hasText:'文字颜色' });
  await textColorField.locator('input[type="color"]').evaluate(input => {
    input.value = '#c7000b';
    input.dispatchEvent(new Event('change', { bubbles:true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(await heading.evaluate(element => element.style.color), 'rgb(199, 0, 11)');
  assert.equal((await session(app)).groups[0].actions[0].payload.property, 'color');

  await textColorField.locator('.inspector-reset').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  assert.equal(await heading.evaluate(element => element.style.color), 'rgb(18, 52, 86)');
  await page.waitForFunction(() => [...document.querySelectorAll('.inspector-field')]
    .find(row => row.textContent.includes('文字颜色'))
    ?.querySelector('.inspector-reset')?.disabled === true);

  const shape = frame.locator('.shape').first();
  await shape.click();
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent === '图形');
  assert.match(await page.locator('.inspector-object').innerText(), /测试图形/);
  assert.equal(await page.locator('.inspector-field').filter({ hasText:'文字颜色' }).count(), 0);
  assert.equal(await page.locator('.inspector-field').filter({ hasText:'显示边框' }).count(), 1);
  const inspectorBody = await page.locator('.inspector-body').elementHandle();
  const borderSwitch = page.locator('.inspector-field').filter({ hasText:'显示边框' })
    .locator('.inspector-switch');
  const switchBefore = await borderSwitch.evaluate(label => {
    const track = label.getBoundingClientRect();
    const thumb = label.querySelector('span').getBoundingClientRect();
    return { width:track.width, left:thumb.left - track.left, right:track.right - thumb.right };
  });
  await borderSwitch.click();
  const inspectorBodyConnected = await inspectorBody.evaluate(element => element.isConnected);
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  assert.equal(await shape.evaluate(element => element.style.borderStyle), 'solid');
  assert.equal(await shape.evaluate(element => element.style.borderWidth), '1px');
  await page.waitForFunction(() => {
    const body = document.querySelector('.inspector-body');
    return body?.dataset.busy === 'false'
      && document.querySelector('[data-border-toggle]')?.checked === true;
  });
  await page.waitForFunction(() => {
    const label = document.querySelector('.inspector-switch');
    const track = label?.getBoundingClientRect();
    const thumb = label?.querySelector('span')?.getBoundingClientRect();
    return track && thumb && thumb.left - track.left >= 15.5;
  });
  const switchAfter = await borderSwitch.evaluate(label => {
    const track = label.getBoundingClientRect();
    const thumb = label.querySelector('span').getBoundingClientRect();
    return { left:thumb.left - track.left, right:track.right - thumb.right };
  });
  assert.deepEqual({
    compact:switchBefore.width <= 40,
    bodyStable:inspectorBodyConnected,
    thumbStartedAtEnd:Math.abs(switchBefore.left - switchBefore.right) >= 10,
    thumbFinishedAtEnd:Math.abs(switchAfter.left - switchAfter.right) >= 10,
    thumbChangedEnd:Math.sign(switchBefore.left - switchBefore.right)
      !== Math.sign(switchAfter.left - switchAfter.right),
  }, {
    compact:true,
    bodyStable:true,
    thumbStartedAtEnd:true,
    thumbFinishedAtEnd:true,
    thumbChangedEnd:true,
  }, `开关前后几何：${JSON.stringify({ switchBefore, switchAfter })}`);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('鼠标选中的局部文字可单独设置格式并撤销重做', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture
      .replace('</style>', '.range-layout-probe{display:inline-flex;gap:24px}</style>')
      .replace('<h2>第一页标题</h2>', '<h2 class="range-layout-probe">第一页标题</h2>'),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const card = page.frameLocator('#deck-frame').locator('.card').first();

  const cardTarget = await card.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const unrelated = await fetch(`${app.url}/api/actions?token=${app.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:0,
      taskId:null,
      actions:[{
        id:'unrelated-text-edit', taskId:null, target:cardTarget,
        kind:'setText', payload:{ text:'无关内容保留' },
      }],
    }),
  });
  assert.equal(unrelated.status, 200, await unrelated.text());
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('.card')?.textContent === '无关内容保留');

  await page.click('[data-mode="edit"]');
  await heading.dblclick();
  await heading.evaluate(element => {
    const textNode = element.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, 3);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  assert.match(await page.locator('.inspector-object').innerText(), /“一页”/);
  assert.equal(await page.locator('.inspector-section').filter({ hasText:'外观' }).count(), 0);
  assert.equal(await page.locator('.inspector-section').filter({ hasText:'边框' }).count(), 0);
  assert.equal(await page.locator('.inspector-section').filter({ hasText:'透明度' }).count(), 0);

  const bold = page.locator('[data-style-property="font-weight"]');
  assert.equal(await bold.getAttribute('aria-pressed'), 'true');
  await bold.click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await heading.locator('[data-deck-text-range-style]').waitFor();
  assert.equal(await heading.locator('[data-deck-text-range-style]').textContent(), '一页');
  assert.equal(await heading.locator('[data-deck-text-range-style]')
    .evaluate(element => element.style.fontWeight), '400');
  const afterApply = await session(app);
  assert.deepEqual(afterApply.groups[1].actions[0].payload.textRange, { start:1, end:3 });

  const selectedRunGap = await heading.evaluate(element => {
    const run = element.querySelector('[data-deck-text-range-style]');
    const before = document.createRange();
    before.setStart(element.firstChild, element.firstChild.length - 1);
    before.setEnd(element.firstChild, element.firstChild.length);
    const selected = document.createRange();
    selected.setStart(run.firstChild, 0);
    selected.setEnd(run.firstChild, 1);
    return selected.getBoundingClientRect().left - before.getBoundingClientRect().right;
  });

  await heading.locator('[data-deck-text-range-style]').dblclick();
  await heading.locator('[data-direct-editing]').evaluate(element => {
    const textNode = element.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() => document.querySelector('[data-selection-state]')?.textContent
    === '选中文字');
  await bold.click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  const afterRepeatedFormat = await session(app);
  assert.equal(afterRepeatedFormat.groups[2].actions[0].target.tag, 'H2');
  assert.deepEqual(afterRepeatedFormat.groups[2].actions[0].payload.textRange, { start:1, end:3 });
  const repeatedFormat = {
    selectedRunGap,
    cardText:await card.textContent(),
    headingText:await heading.textContent(),
    runCount:await heading.locator('[data-deck-text-range-style]').count(),
    weight:await heading.evaluate(element => getComputedStyle(
      element.querySelector('[data-deck-text-range-style]') ?? element,
    ).fontWeight),
  };
  assert.deepEqual(repeatedFormat, {
    selectedRunGap:0,
    cardText:'无关内容保留',
    headingText:'第一页标题',
    runCount:0,
    weight:'700',
  });

  await page.locator('[data-history-undo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '4');
  assert.equal(await heading.locator('[data-deck-text-range-style]')
    .evaluate(element => element.style.fontWeight), '400');

  await page.locator('[data-history-redo]').click();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '5');
  await page.waitForFunction(() => {
    const headingElement = document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2');
    return headingElement && !headingElement.querySelector('[data-deck-text-range-style]')
      && getComputedStyle(headingElement).fontWeight === '700';
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '5');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('.card')?.textContent === '无关内容保留');
  const restoredHeading = page.frameLocator('#deck-frame').locator('h2').first();
  await restoredHeading.waitFor();
  assert.equal(await restoredHeading.locator('[data-deck-text-range-style]').count(), 0);
  assert.equal(await restoredHeading.evaluate(element => getComputedStyle(element).fontWeight), '700');
  assert.equal(await page.frameLocator('#deck-frame').locator('.card').first().textContent(), '无关内容保留');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('历史中以局部格式包装为目标的动作可在重开后恢复且撤销不展开 Agent 面板', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(5_000);
  const heading = page.frameLocator('#deck-frame').locator('h2').first();
  const rootTarget = await heading.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));

  const postAction = async (expectedRevision, action) => {
    const response = await fetch(`${app.url}/api/actions?token=${app.token}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision, taskId:null, actions:[action] }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await postAction(0, {
    id:'root-range-weight', taskId:null, target:rootTarget, kind:'setStyle',
    payload:{ property:'font-weight', value:'400', textRange:{ start:0, end:2 } },
  });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  const wrapper = heading.locator('[data-deck-text-range-style]');
  await wrapper.waitFor();
  const wrapperTarget = await wrapper.evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  await postAction(1, {
    id:'nested-range-weight', taskId:null, target:wrapperTarget, kind:'setStyle',
    payload:{ property:'font-weight', value:'700', textRange:{ start:0, end:2 } },
  });
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');

  await page.reload();
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForTimeout(150);
  const frameError = await page.frameLocator('#deck-frame').locator('[data-direct-status]').textContent()
    .catch(() => '');

  await page.locator('[data-current-page]').click();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  await page.waitForFunction(() => document.querySelector('.history-controls')?.dataset.busy === 'false');
  assert.deepEqual({
    frameError,
    taskDrawerOpen:await page.locator('[data-task-drawer]').getAttribute('data-open'),
  }, {
    frameError:'',
    taskDrawerOpen:'false',
  });
});
