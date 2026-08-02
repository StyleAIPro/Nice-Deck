import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startServer } from '../server.mjs';

export async function startFixtureServer() {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-fixture-'));
  const deckPath = join(root, 'minimal-deck.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  try {
    const app = await startServer({
      deckPath,
      host: '127.0.0.1',
      port: 0,
      openBrowser: false,
      token: 'fixture-token',
      editorToken: 'fixture-editor-token',
    });
    const closeServer = app.close;
    let closePromise;
    app.close = () => {
      closePromise ??= closeServer().finally(() => rm(root, { recursive: true, force: true }));
      return closePromise;
    };
    return app;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function openEditor(app) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const browserProblems = [];
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) browserProblems.push(message.text());
    });
    page.on('pageerror', error => browserProblems.push(error.message));
    await page.goto(`${app.url}/?token=${encodeURIComponent(app.token)}`
      + `&editorToken=${encodeURIComponent(app.editorToken)}`);
    await page.waitForSelector('#deck-frame', { timeout: 3_000 });
    return { browser, page, browserProblems };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function dragInFrame(page, start, end) {
  const box = await page.locator('#deck-frame').boundingBox();
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y);
  await page.mouse.up();
}
