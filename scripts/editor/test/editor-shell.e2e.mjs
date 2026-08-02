import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { startFixtureServer, openEditor } from './test-helpers.mjs';
import { loadChromium } from '../../verify/load-playwright.mjs';

const RUNTIME_CONTRACT = {
  brand:'com.huawei.deck.visual-editor.patch-runtime',
  schema:1,
  version:'1.0.0',
  api:'pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,pendingTransactionCount,activeActionCount,suspendedTargetCount',
};

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

test('Deck 首帧异步替换 canvas 后导航仍绑定稳定的当前页面', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace('</body>', `
<script>
setTimeout(() => {
  const stage = document.querySelector('.stage');
  stage.replaceChildren(...[...stage.children].map(canvas => canvas.cloneNode(true)));
}, 250);
</script>
</body>`),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.waitForFunction(() => document.querySelectorAll('[data-page-key]').length === 2);

  const navigationKeys = await page.locator('[data-page-key]').evaluateAll(elements => (
    elements.map(element => element.dataset.pageKey)
  ));
  const currentKeys = await page.locator('#deck-frame').evaluate(frame => {
    const runtime = frame.contentWindow.HuaweiDeckPatchRuntime;
    return [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')]
      .map(canvas => runtime.pageKey(canvas));
  });
  assert.deepEqual(navigationKeys, currentKeys);

  await page.getByRole('button', { name:'02 目录页' }).click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  assert.ok(await page.locator('#deck-frame').evaluate(frame => frame.contentWindow.scrollY > 900));
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Deck 外部无关 attribute 持续变化时仍在有界时间发布 ready', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace('</body>', `
<script>
const unrelatedNoise = setInterval(() => {
  document.body.dataset.unrelatedNoise = String(performance.now());
}, 100);
addEventListener('pagehide', () => clearInterval(unrelatedNoise), { once:true });
</script>
</body>`),
  });
  t.after(() => app.close());
  const startedAt = Date.now();
  const { browser, page } = await openEditor(app, { readyTimeoutMs:2_500 });
  t.after(() => browser.close());
  assert.equal(await page.locator('[data-page-key]').count(), 2);
  assert.ok(Date.now() - startedAt < 2_500);
});

test('ready 后晚到 canvas 替换会重新 hydrate 导航并让切页诊断动作使用新节点', async t => {
  const app = await startFixtureServer({
    bundle:true,
    fixtureTransform:fixture => fixture.replace('</body>', `
<script>
setTimeout(() => {
  const stage = document.querySelector('.stage');
  const replacements = [...stage.children].map(canvas => canvas.cloneNode(true));
  const section = replacements[1].querySelector('section[data-label]');
  Object.defineProperties(section, {
    scrollWidth:{ value:1930, configurable:true },
    clientWidth:{ value:1920, configurable:true },
    scrollHeight:{ value:1080, configurable:true },
    clientHeight:{ value:1080, configurable:true },
  });
  stage.replaceChildren(...replacements);
  window.__lateCanvasReplacementDone = true;
}, 900);
</script>
</body>`),
  });
  t.after(() => app.close());
  const { browser, page, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.locator('[data-page-index="2"]').evaluate(button => {
    window.__navBeforeLateHydration = button;
  });
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentWindow?.__lateCanvasReplacementDone === true
  ));
  await page.waitForFunction(() => (
    document.querySelector('[data-page-index="2"]') !== window.__navBeforeLateHydration
  ), undefined, { timeout:3_000 });

  await page.locator('[data-page-index="2"]').click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  assert.ok(await page.locator('#deck-frame').evaluate(frame => frame.contentWindow.scrollY > 900));

  const target = await page.frameLocator('#deck-frame').locator('h2').nth(1)
    .evaluate(element => window.HuaweiDeckPatchRuntime.makeLocator(element));
  const applied = await fetch(`${app.url}/api/actions?token=${app.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      expectedRevision:0,
      taskId:null,
      actions:[{ id:'late-hydration-action', taskId:null, target, kind:'setText', payload:{ text:'新 canvas 动作' } }],
    }),
  });
  assert.equal(applied.status, 200, await applied.text());
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentDocument?.querySelectorAll('h2')[1]?.textContent
      === '新 canvas 动作'
  ));

  const write = await fetch(`${app.url}/api/write-deck?token=${app.token}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:1 }),
  });
  const body = await write.json();
  assert.equal(write.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'NEW_OVERFLOW', JSON.stringify(body));
  assert.ok(body.blockers.some(item => item.kind === 'section' && item.x === 10), JSON.stringify(body));
  assert.deepEqual(resourceProblems, []);
});

test('Deck 使用 stage 内滚动时左侧页序仍切换到目标画布', async t => {
  const app = await startFixtureServer({
    fixtureTransform:fixture => fixture.replace('</style>', `
html,body{height:100%;overflow:hidden}.stage{position:absolute;inset:0;overflow-y:auto}
</style>`),
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.waitForFunction(() => document.querySelectorAll('[data-page-key]').length === 2);

  await page.getByRole('button', { name:'02 目录页' }).click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');
  const position = await page.locator('#deck-frame').evaluate(frame => {
    const stage = frame.contentDocument.querySelector('.stage');
    const second = frame.contentDocument.querySelectorAll('.slide-canvas')[1];
    return { stageScrollTop:stage.scrollTop, secondTop:second.getBoundingClientRect().top };
  });
  assert.ok(position.stageScrollTop > 900, JSON.stringify(position));
  assert.ok(position.secondTop >= -1 && position.secondTop < 1080, JSON.stringify(position));
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

for (const runtimeCase of [
  {
    name:'foreign truthy global',
    code:'RUNTIME_GLOBAL_CONFLICT',
    script:'window.HuaweiDeckPatchRuntime={foreign:true};',
  },
  {
    name:'old branded incompatible runtime',
    code:'RUNTIME_INCOMPATIBLE',
    script:`window.HuaweiDeckPatchRuntime={contract:${JSON.stringify({ ...RUNTIME_CONTRACT, schema:0, version:'0.9.0' })}};`,
  },
]) {
  test(`frame bridge 对 ${runtimeCase.name} 明确显示 ${runtimeCase.code}`, async t => {
    const app = await startFixtureServer({
      fixtureTransform:fixture => fixture.replace(
        '<script src="../../runtime/patch-runtime.js"></script>',
        `<script>${runtimeCase.script}</script>`,
      ),
    });
    t.after(() => app.close());
    const chromium = await loadChromium();
    const browser = await chromium.launch({ channel:'chrome', headless:true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
    await page.goto(`${app.url}/?token=${app.token}&editorToken=${app.editorToken}`);
    const error = page.locator('[data-deck-error]');
    await error.waitFor({ state:'visible', timeout:3_000 });
    assert.match(await error.innerText(), new RegExp(runtimeCase.code));
  });
}
