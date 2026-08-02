import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

function rejectedWebSocketStatus(url) {
  const socket = new WebSocket(url);
  return new Promise(resolve => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('open', () => {
      socket.terminate();
      resolve(0);
    });
    socket.once('error', () => resolve(0));
  });
}

test('iframe 挂载后发现两个同名页并显示独立页序', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.waitForSelector('[data-page-key]');
  const pages = await page.locator('[data-page-key]').allTextContents();
  assert.deepEqual(pages.map(value => value.trim()), ['01 目录页', '02 目录页']);
  const pageKeys = await page.locator('[data-page-key]').evaluateAll(elements => (
    elements.map(element => element.dataset.pageKey)
  ));
  assert.equal(new Set(pageKeys).size, 2);
  assert.equal(await page.locator('#deck-frame').getAttribute('src'), `/preview?token=${app.token}`);
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');
  assert.match(await page.locator('[data-ws-state]').innerText(), /在线/);
  assert.equal(await rejectedWebSocketStatus(app.editorWsUrl), 409);
  assert.equal(await page.locator('[data-agent-placeholder]').count(), 1);
  assert.ok(await page.locator('.brand-logo').evaluate(image => image.naturalWidth > 0));
  await page.waitForTimeout(100);
  assert.deepEqual(browserProblems, []);
});

test('preview 仅在内存注入一次且静态资源保持受保护', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const before = await readFile(app.deckPath, 'utf8');
  const response = await fetch(`${app.url}/preview?token=${app.token}`);
  assert.equal(response.status, 200);
  const preview = await response.text();
  assert.equal(count(preview, '<script src="/editor/html2canvas.min.js"></script>'), 1);
  assert.equal(count(preview, '<script type="module" src="/editor/frame-bridge.mjs"></script>'), 1);
  assert.equal(await readFile(app.deckPath, 'utf8'), before);

  assert.equal((await fetch(`${app.url}/`)).status, 403);
  assert.equal((await fetch(`${app.url}/?token=${app.token}&editorToken=wrong`)).status, 403);
  const editorIndex = await fetch(`${app.url}/?token=${app.token}&editorToken=${app.editorToken}`);
  assert.equal(editorIndex.status, 200);
  assert.match(editorIndex.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);

  for (const path of [
    '/preview',
    '/editor/editor.mjs',
    '/editor/editor.css',
    '/editor/huawei-logo.png',
    '/editor/html2canvas.min.js',
    '/editor/patch-runtime.js',
  ]) {
    assert.equal((await fetch(`${app.url}${path}`)).status, 403, path);
  }
  for (const path of [
    `/editor/editor.mjs?token=${app.token}`,
    `/editor/huawei-logo.png?token=${app.token}`,
    `/editor/html2canvas.min.js?token=${app.token}`,
    `/editor/patch-runtime.js?token=${app.token}`,
  ]) {
    assert.equal((await fetch(`${app.url}${path}`)).status, 200, path);
  }

  for (const path of [
    `/editor/../server.mjs?token=${app.token}`,
    `/editor/%2e%2e/server.mjs?token=${app.token}`,
    `/editor/not-found.js?token=${app.token}`,
  ]) {
    const unexpected = await fetch(`${app.url}${path}`);
    assert.notEqual(unexpected.status, 200, path);
    assert.doesNotMatch(await unexpected.text(), /BridgeService|createServer/);
  }
});

test('frame bridge 复用 Deck 已有 runtime 而不创建重复实例', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  await page.waitForSelector('[data-page-key]');
  const runtimeScripts = await page.locator('#deck-frame').evaluate(frame => (
    [...frame.contentDocument.scripts]
      .filter(script => new URL(script.src, frame.contentDocument.baseURI).pathname === '/editor/patch-runtime.js')
      .length
  ));
  assert.equal(runtimeScripts, 1);
});

test('frame bridge 在 Deck 未嵌 runtime 时只加载一个受保护实例', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const fixture = await readFile(app.deckPath, 'utf8');
  await writeFile(app.deckPath, fixture.replace(
    '<script src="../../runtime/patch-runtime.js"></script>',
    '',
  ));
  const { browser, page, browserProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.waitForSelector('[data-page-key]');
  const runtimeState = await page.locator('#deck-frame').evaluate(frame => ({
    available: Boolean(frame.contentWindow.HuaweiDeckPatchRuntime),
    scripts: [...frame.contentDocument.scripts]
      .filter(script => new URL(script.src, frame.contentDocument.baseURI).pathname === '/editor/patch-runtime.js')
      .length,
  }));
  assert.deepEqual(runtimeState, { available: true, scripts: 1 });
  assert.deepEqual(browserProblems, []);
});
