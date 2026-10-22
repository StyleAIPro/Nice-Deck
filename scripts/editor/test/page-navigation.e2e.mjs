import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

async function openPages(t) {
  const app = await startFixtureServer({
    fixtureTransform:html => {
      const slides = Array.from({ length:20 }, (_, index) => (
        `<div class="slide-canvas" style="width:1920px;height:1080px"><section data-label="测试 ${index + 1}"><h2>第 ${index + 1} 页</h2></section></div>`
      )).join('\n');
      const nav = Array.from({ length:20 }, (_, i) => ({ i, code:String(i + 1), label:`测试 ${i + 1}` }));
      return html.replace(/<div class="stage">[\s\S]*?<\/div>\n<script>/, `<div class="stage">${slides}</div>\n<script>`)
        .replace(/const nav = \[[\s\S]*?\];/, `const nav = ${JSON.stringify(nav)};`);
    },
  });
  t.after(() => app.close());
  const result = await openEditor(app);
  t.after(() => result.browser.close());
  result.page.setDefaultTimeout(6_000);
  return result;
}

async function selected(page, index) {
  await page.waitForFunction(expected => document.querySelector(
    '[data-page-list] [aria-current="page"]',
  )?.dataset.pageIndex === String(expected), index);
}

test('页码栏上下键连续切页、首尾停留，并在展开与收起时保持焦点可见', async t => {
  const { page, browserProblems, resourceProblems } = await openPages(t);
  for (const expanded of [false, true]) {
    if (expanded) await page.click('[data-page-panel-toggle]');
    await page.locator('[data-page-index="1"]').click();
    await page.keyboard.press('ArrowUp');
    await selected(page, 1);
    for (let index = 2; index <= 20; index += 1) await page.keyboard.press('ArrowDown');
    await selected(page, 20);
    await page.keyboard.press('ArrowDown');
    await selected(page, 20);
    const visible = await page.locator('[data-page-index="20"]').evaluate(button => {
      const list = button.closest('[data-page-list]');
      const item = button.getBoundingClientRect(), bounds = list.getBoundingClientRect();
      return { focused:document.activeElement === button,
        visible:item.top >= bounds.top - 1 && item.bottom <= bounds.bottom + 1,
        scrollTop:list.scrollTop };
    });
    assert.equal(visible.focused, true);
    assert.equal(visible.visible, true);
    assert.ok(visible.scrollTop > 0);
    await page.keyboard.press('ArrowUp');
    await selected(page, 19);
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(80);
    await selected(page, 19);
  }
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('滚轮点击后逐页切换，小增量合并且不抢占缩放、横滚或外部焦点', async t => {
  const { page, browserProblems, resourceProblems } = await openPages(t);
  const list = page.locator('[data-page-list]');
  await list.hover();
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(100);
  await selected(page, 1);
  await page.locator('[data-page-index="3"]').click();
  await selected(page, 3);
  await page.mouse.wheel(0, 120);
  await selected(page, 4);
  await page.mouse.wheel(0, -120);
  await selected(page, 3);
  await page.mouse.wheel(0, 2400);
  await selected(page, 4);
  await page.locator('[data-page-index="4"]').click();
  await list.evaluate(element => {
    for (let index = 0; index < 20; index += 1) element.dispatchEvent(new WheelEvent('wheel', {
      deltaY:10, bubbles:true, cancelable:true,
    }));
  });
  await selected(page, 5);
  const ignored = await list.evaluate(element => [
    { deltaY:120, ctrlKey:true }, { deltaY:120, metaKey:true }, { deltaX:120, deltaY:1 },
  ].map(options => {
    const event = new WheelEvent('wheel', { ...options, bubbles:true, cancelable:true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }));
  assert.deepEqual(ignored, [false, false, false]);
  await selected(page, 5);
  // 页码栏之外取得焦点后，键盘与栏内滚动不再触发切页。
  await page.click('[data-mode="edit"]');
  await page.keyboard.press('ArrowDown');
  await list.hover();
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(100);
  await selected(page, 5);
  const heading = page.frameLocator('#deck-frame').locator('h2').nth(4);
  await heading.dblclick();
  await heading.press('ArrowUp');
  assert.equal(await heading.getAttribute('contenteditable'), 'plaintext-only');
  await selected(page, 5);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
