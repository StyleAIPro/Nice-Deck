import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

function connectWebSocket(url) {
  const socket = new WebSocket(url);
  return new Promise((resolvePromise, reject) => {
    socket.once('open', () => resolvePromise(socket));
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`WebSocket 被拒绝：${response.statusCode}`));
    });
    socket.once('error', reject);
  });
}

function closeWebSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolvePromise => {
    socket.once('close', resolvePromise);
    socket.close();
  });
}

test('iframe 挂载后发现两个同名页并显示独立页序', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
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
  assert.equal(await page.locator('.mode-badge').innerText(), '预览模式');
  assert.match(await page.locator('.inspector-empty').innerText(), /选择文字或画面元素开始编辑/);
  await page.waitForTimeout(100);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('点击页序经 frame 确认后真实切换画布并同步当前页', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.waitForSelector('[data-page-key][aria-current="page"]');

  await page.getByRole('button', { name: '02 目录页' }).click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  assert.equal(await page.locator('[data-page-key][aria-current="page"]').innerText(), '02 目录页');
  const secondVisible = await page.locator('#deck-frame').evaluate(frame => {
    const headings = [...frame.contentDocument.querySelectorAll('h2')];
    return {
      scrollY: frame.contentWindow.scrollY,
      firstTop: headings[0].getBoundingClientRect().top,
      secondTop: headings[1].getBoundingClientRect().top,
      secondText: headings[1].textContent,
      cardText: frame.contentDocument.querySelectorAll('.card')[1].textContent,
    };
  });
  assert.ok(secondVisible.scrollY > 900, JSON.stringify(secondVisible));
  assert.ok(secondVisible.secondTop >= -1 && secondVisible.secondTop < 1080, JSON.stringify(secondVisible));
  assert.ok(secondVisible.firstTop < 0, JSON.stringify(secondVisible));
  assert.deepEqual(
    { heading: secondVisible.secondText, card: secondVisible.cardText },
    { heading: '第二页标题', card: '卡片 B' },
  );

  await page.getByRole('button', { name: '01 目录页' }).click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '01 目录页');
  assert.equal(await page.locator('[data-page-key][aria-current="page"]').innerText(), '01 目录页');
  assert.ok(await page.locator('#deck-frame').evaluate(frame => frame.contentWindow.scrollY < 100));

  const currentKey = await page.locator('[data-page-key][aria-current="page"]').getAttribute('data-page-key');
  await page.getByRole('button', { name: '02 目录页' }).evaluate(button => {
    button.dataset.pageKey = 'page-does-not-exist';
    button.click();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-current-key]').innerText(), currentKey);
  assert.equal(await page.locator('[data-page-key][aria-current="page"]').innerText(), '01 目录页');
  assert.deepEqual(resourceProblems, []);
});

test('pagehide 释放 editor capability 且不会由旧页面重连', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  await page.waitForFunction(() => document.querySelector('[data-ws-state]')?.dataset.wsState === 'online');

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForTimeout(100);
  const firstReplacement = await connectWebSocket(app.editorWsUrl);
  await closeWebSocket(firstReplacement);
  await page.waitForTimeout(350);
  const secondReplacement = await connectWebSocket(app.editorWsUrl);
  await closeWebSocket(secondReplacement);
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
    '/editor/task-drawer.mjs',
    '/editor/protocol.mjs',
    '/editor/editor.css',
    '/editor/huawei-logo.png',
    '/editor/html2canvas.min.js',
    '/editor/patch-runtime.js',
  ]) {
    assert.equal((await fetch(`${app.url}${path}`)).status, 403, path);
  }
  for (const path of [
    `/editor/editor.mjs?token=${app.token}`,
    `/editor/task-drawer.mjs?token=${app.token}`,
    `/editor/protocol.mjs?token=${app.token}`,
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

test('frame bridge 复用真实 inline runtime 且不请求外部 runtime', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const fixture = await readFile(app.deckPath, 'utf8');
  const runtime = await readFile(resolve('scripts/editor/runtime/patch-runtime.js'), 'utf8');
  await writeFile(app.deckPath, fixture.replace(
    '<script src="../../runtime/patch-runtime.js"></script>',
    `<script>${runtime}</script>`,
  ));
  const { browser, page, browserProblems, resourceProblems, resourceRequests } = await openEditor(app);
  t.after(() => browser.close());
  await page.waitForSelector('[data-page-key]');
  assert.equal(await page.locator('#deck-frame').evaluate(frame => (
    Boolean(frame.contentWindow.HuaweiDeckPatchRuntime)
  )), true);
  assert.equal(resourceRequests.filter(url => new URL(url).pathname === '/editor/patch-runtime.js').length, 0);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
