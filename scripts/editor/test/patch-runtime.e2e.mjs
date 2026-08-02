import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';

test('公开动作登记后定位第二个同名页并在 DOM 重建后幂等重放', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const initial = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    const applied = rt.applyAction({ target, kind:'setText', payload:{ text:'已修改' } });
    const translate = { target, kind:'translate', payload:{ x:10, y:20 } };
    rt.applyAction(translate);
    rt.applyAction(translate);
    rt.applyAction(translate);
    const sameLocator = target === rt.makeLocator(el);
    el.closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    return { pageKey:target.pageKey, text:el.textContent, translate:el.style.translate,
      before:applied.before, sameLocator };
  });
  assert.match(initial.pageKey, /^page-002-/);
  assert.deepEqual({ ...initial, pageKey:undefined }, {
    pageKey:undefined, text:'已修改', translate:'10px 20px', before:'第二页标题', sameLocator:true,
  });
  await page.waitForFunction(() => {
    const el = document.querySelectorAll('h2')[1];
    return el.textContent === '已修改' && el.style.translate === '10px 20px';
  }, undefined, { timeout:1000 });
});

test('新节点指纹不符时 applyAll 抛出 TARGET_AMBIGUOUS', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const error = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    el.closest('section').innerHTML = '<h2>指纹不符</h2>';
    try {
      rt.applyAll([{ target, kind:'setText', payload:{ text:'不应应用' } }]);
      return null;
    } catch (caught) {
      return caught.message;
    }
  });
  assert.equal(error, 'TARGET_AMBIGUOUS');
});

test('hide 和 show 共享 display 状态并以最后一次公开动作为准', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const target = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const locator = rt.makeLocator(el);
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    el.closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    return locator;
  });
  await page.waitForFunction(() => document.querySelectorAll('h2')[1].style.display === 'none',
    undefined, { timeout:1000 });

  await page.evaluate(locator => {
    const rt = window.HuaweiDeckPatchRuntime;
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    document.querySelectorAll('h2')[1].closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
  }, target);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('h2').nth(1).evaluate(el => el.style.display), '');
});

test('applyAll 失败后恢复旧 authoritative 集合且不产生异步 pageerror', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const error = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const headings = document.querySelectorAll('h2');
    const goodTarget = rt.makeLocator(headings[1]);
    const ambiguousTarget = rt.makeLocator(headings[0]);
    rt.applyAction({ target:goodTarget, kind:'setText', payload:{ text:'保留动作' } });
    headings[0].closest('section').innerHTML = '<h2>指纹不符</h2>';
    try {
      rt.applyAll([{ target:ambiguousTarget, kind:'setText', payload:{ text:'失败批次' } }]);
      return null;
    } catch (caught) {
      return caught.message;
    }
  });
  assert.equal(error, 'TARGET_AMBIGUOUS');
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    const canvases = document.querySelectorAll('.slide-canvas');
    canvases[0].innerHTML = '<section data-label="目录页"><h2>第一页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 A</div></section>';
    canvases[1].innerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
  });
  await page.waitForTimeout(100);
  const texts = await page.locator('h2').allTextContents();
  assert.deepEqual(texts, ['第一页标题', '保留动作']);
  assert.deepEqual(pageErrors, []);
});
