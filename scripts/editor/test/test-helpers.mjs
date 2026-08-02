import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startServer } from '../server.mjs';

export async function startFixtureServer(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-fixture-'));
  const deckPath = join(root, 'minimal-deck.html');
  if (options.bundle) {
    const wrapper = await readFile(resolve('assets/template-deck.html'), 'utf8');
    const template = (await readFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), 'utf8'))
      .replace('../../runtime/patch-runtime.js', '/editor/patch-runtime.js');
    const lines = wrapper.split('\n');
    const manifest = lines.findIndex(line => line.trim() === '<script type="__bundler/manifest">');
    const bundledTemplate = lines.findIndex(line => line.trim() === '<script type="__bundler/template">');
    if (manifest < 0 || bundledTemplate < 0) throw new Error('测试 bundle 外壳缺少 manifest/template');
    lines[manifest + 1] = '{}';
    lines[bundledTemplate + 1] = JSON.stringify(template).replaceAll('</', '<\\u002F');
    await writeFile(deckPath, lines.join('\n'));
  } else {
    await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  }
  try {
    const app = await startServer({
      deckPath,
      host: '127.0.0.1',
      port: 0,
      openBrowser: false,
      token: 'fixture-token',
      editorToken: 'fixture-editor-token',
      bridgeTimeoutMs: options.bridgeTimeoutMs,
      writerTimeoutMs: options.writerTimeoutMs,
      writerKillGraceMs: options.writerKillGraceMs,
      spawnWriter: options.spawnWriter,
      onActiveWritersChange: options.onActiveWritersChange,
    });
    const closeServer = app.close;
    let closePromise;
    app.close = () => {
      closePromise ??= options.preserveRoot
        ? closeServer()
        : closeServer().finally(() => rm(root, { recursive: true, force: true }));
      return closePromise;
    };
    app.cleanup = () => rm(root, { recursive: true, force: true });
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
    const resourceProblems = [];
    const resourceRequests = [];
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) browserProblems.push(message.text());
    });
    page.on('pageerror', error => browserProblems.push(error.message));
    page.on('request', request => resourceRequests.push(request.url()));
    page.on('requestfailed', request => {
      resourceProblems.push(`${request.resourceType()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', response => {
      const type = response.request().resourceType();
      if (['script', 'stylesheet', 'image'].includes(type) && !response.ok()) {
        resourceProblems.push(`${type} ${response.status()} ${response.url()}`);
      }
    });
    await page.goto(`${app.url}/?token=${encodeURIComponent(app.token)}`
      + `&editorToken=${encodeURIComponent(app.editorToken)}`);
    await page.waitForSelector('#deck-frame', { timeout: 3_000 });
    return { browser, page, browserProblems, resourceProblems, resourceRequests };
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
