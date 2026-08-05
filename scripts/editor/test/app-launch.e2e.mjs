import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startAppServer } from '../app-server.mjs';

test('用户在网页点击添加后才打开选择器，取消后仍可重试', async t => {
  let picks = 0;
  const app = await startAppServer({
    token:'browser-secret',
    pickDeck:async () => {
      picks += 1;
      await new Promise(resolve => setTimeout(resolve, 80));
      return null;
    },
  });
  t.after(() => app.close());
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  await page.goto(app.appUrl);
  assert.equal(picks, 0);
  await page.getByRole('button', { name:/添加 Deck HTML/ }).click();
  await page.getByText('已取消，可以重新添加').waitFor();
  assert.equal(picks, 1);
  assert.equal(await page.getByRole('button', { name:/添加 Deck HTML/ }).isEnabled(), true);
});
