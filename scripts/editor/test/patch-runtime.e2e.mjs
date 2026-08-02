import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';

test('定位第二个同名页并幂等重放文字与位移', async () => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    const applied = rt.applyAction({ target, kind:'setText', payload:{ text:'已修改' } });
    rt.applyAction({ target, kind:'translate', payload:{ x:10, y:20 } });
    return { text:el.textContent, translate:el.style.translate, before:applied.before };
  });
  assert.deepEqual(result, { text:'已修改', translate:'10px 20px', before:'第二页标题' });
  await browser.close();
});
