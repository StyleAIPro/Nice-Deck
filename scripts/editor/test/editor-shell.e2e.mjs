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
  features:'textPath,textRangeStyle',
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

test('同一服务进程固定编辑器资源快照，避免新前端连接旧协议', async t => {
  const pinned = Buffer.from('// pinned frame bridge\n');
  const app = await startFixtureServer({
    editorAssets:new Map([['/editor/frame-bridge.mjs', {
      type:'text/javascript; charset=utf-8', contents:pinned,
    }]]),
  });
  t.after(() => app.close());
  const response = await fetch(
    `${app.url}/editor/frame-bridge.mjs?token=${encodeURIComponent(app.token)}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pinned);
});

test('页面抽屉箭头使用统一圆形样式并随状态反向', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const toggle = page.locator('[data-page-panel-toggle]');
  await page.waitForFunction(() => (
    document.querySelector('[data-page-panel-toggle]')?.dataset.pillNavReady === 'true'
  ));
  await page.waitForFunction(() => (
    getComputedStyle(document.querySelector('[data-page-panel-toggle]')).color === 'rgb(25, 25, 25)'
  ));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.getAttribute('data-pill-arrow-direction'), 'right');
  assert.deepEqual(await toggle.evaluate(button => {
    const style = getComputedStyle(button);
    const hover = getComputedStyle(button.querySelector('.pill-nav-label-hover'));
    const arrow = getComputedStyle(button.querySelector('.pill-nav-label-default .pill-nav-arrow-icon'));
    return {
      width:style.width,
      height:style.height,
      borderRadius:style.borderRadius,
      color:style.color,
      pillText:style.getPropertyValue('--pill-nav-text').trim(),
      hoverDisplay:hover.display,
      arrowTransition:arrow.transitionProperty,
    };
  }), {
    width:'30px', height:'30px', borderRadius:'999px', color:'rgb(25, 25, 25)', pillText:'#191919',
    hoverDisplay:'none', arrowTransition:'transform',
  });
  assert.ok(await page.locator('.page-panel')
    .evaluate(element => element.getBoundingClientRect().width <= 72));

  const arrowBeforeHover = await toggle.locator('.pill-nav-label-default .pill-nav-arrow-icon')
    .evaluate(element => getComputedStyle(element).transform);
  const fillBeforeHover = await toggle.locator('.pill-nav-fill')
    .evaluate(element => getComputedStyle(element).transform);
  await toggle.hover();
  await page.waitForFunction(before => (
    getComputedStyle(document.querySelector('[data-page-panel-toggle] .pill-nav-fill')).transform
      !== before
  ), fillBeforeHover);
  await page.waitForTimeout(340);
  assert.equal(await toggle.locator('.pill-nav-label-default')
    .evaluate(element => getComputedStyle(element).opacity), '1');
  assert.equal(await toggle.locator('.pill-nav-label-default .pill-nav-arrow-icon')
    .evaluate(element => getComputedStyle(element).transform), arrowBeforeHover);

  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.mouse.move(500, 500);
  await toggle.hover();
  assert.equal(await toggle.locator('.pill-nav-label-default')
    .evaluate(element => getComputedStyle(element).opacity), '1');
  await page.emulateMedia({ reducedMotion:'no-preference' });

  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle.getAttribute('data-pill-arrow-direction'), 'left');
  await page.waitForFunction(before => (
    getComputedStyle(document.querySelector(
      '[data-page-panel-toggle] .pill-nav-label-default .pill-nav-arrow-icon',
    )).transform !== before
  ), arrowBeforeHover);
  assert.ok(await page.locator('.page-panel')
    .evaluate(element => element.getBoundingClientRect().width >= 200));
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('画布工具栏用品牌导出图标下载当前工作副本 PPTX', async t => {
  let exportCalls = 0;
  const app = await startFixtureServer({
    pptxExporter:async ({ htmlBytes }) => {
      exportCalls += 1;
      assert.match(htmlBytes.toString('utf8'), /slide-canvas/);
      return Buffer.from('PK\u0003\u0004fixture-pptx');
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const button = page.locator('[data-export-pptx]');
  const resolution = page.locator('.canvas-resolution');
  assert.equal(await button.getAttribute('aria-label'), '导出为 PPTX');
  assert.equal(await button.getAttribute('title'), '导出为 PPTX');
  assert.equal(await button.locator('.pill-nav-label-default .canvas-export-icon').count(), 1);
  assert.equal(await button.locator('.pill-nav-label-default path').count(), 3);
  assert.ok(await button.evaluate((node, resolutionNode) => (
    node.getBoundingClientRect().right <= resolutionNode.getBoundingClientRect().left
  ), await resolution.elementHandle()));
  assert.equal(await button.evaluate(node => getComputedStyle(node).width), '30px');
  assert.equal(await button.locator('.pill-nav-label-default').evaluate(node => (
    getComputedStyle(node).color
  )), 'rgb(168, 0, 9)');

  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'minimal-deck.pptx');
  assert.deepEqual(await readFile(await download.path()), Buffer.from('PK\u0003\u0004fixture-pptx'));
  assert.equal(exportCalls, 1);
  await page.waitForFunction(() => (
    document.querySelector('[data-history-notice]')?.textContent
      === 'PPTX 已导出：minimal-deck.pptx'
  ));
  assert.equal(await button.isEnabled(), true);
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Agent 任务列表点击外部区域自动收起，内部操作保持展开', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(3_000);

  const drawer = page.locator('[data-task-drawer]');
  const toggle = page.locator('[data-task-drawer-toggle]');
  await page.waitForSelector('[data-page-key]');
  await toggle.click();
  assert.equal(await drawer.getAttribute('data-open'), 'true');

  await page.locator('[data-task-drawer-panel] .deck-panel-title').click();
  assert.equal(await drawer.getAttribute('data-open'), 'true', '任务列表内部点击不得误收起');

  await page.locator('.page-panel .panel-heading').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-task-drawer]')?.dataset.open === 'false'
  ));

  await toggle.click();
  assert.equal(await drawer.getAttribute('data-open'), 'true');
  await page.frameLocator('#deck-frame').locator('.slide-canvas').first().click({ position:{ x:20, y:20 } });
  await page.waitForFunction(() => (
    document.querySelector('[data-task-drawer]')?.dataset.open === 'false'
  ));

  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

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
  assert.equal(await page.locator('[data-agent-status]').getAttribute('data-agent-status'), 'standby');
  assert.match(await page.locator('[data-agent-status]').innerText(), /Codex 未启动/);
  for (const selector of ['.workspace-navigation', '.history-controls']) {
    assert.equal(await page.locator(selector).evaluate(element => (
      getComputedStyle(element).backgroundColor
    )), 'rgb(227, 229, 233)');
    assert.equal(await page.locator(selector).evaluate(element => (
      getComputedStyle(element).backgroundImage
    )), 'none');
  }
  for (const selector of [
    '.workspace-navigation-button', '.history-button', '.solidify-button', '.agent-status',
  ]) {
    assert.equal(await page.locator(selector).first().locator('.pill-nav-fill').evaluate(element => (
      getComputedStyle(element).backgroundColor
    )), 'rgb(227, 229, 233)');
  }
  for (const selector of [
    '.workspace-navigation-button', '.history-button', '.solidify-button', '.agent-status',
  ]) {
    assert.equal(await page.locator(selector).first().evaluate(element => (
      getComputedStyle(element).borderRadius
    )), '999px');
  }
  assert.equal(await page.locator('.topbar .pill-nav-label-stack').count(), 7);
  assert.equal(await page.locator('.topbar .pill-nav-label-default').count(), 7);
  assert.equal(await page.locator('.topbar .pill-nav-label-hover').count(), 7);
  assert.equal(
    (await page.locator('[data-agent-label]').textContent()).trim(),
    (await page.locator('.agent-status .pill-nav-label-hover').textContent()).trim(),
  );
  assert.equal(await page.locator('.history-controls').evaluate(element => (
    getComputedStyle(element).height
  )), '44px');
  assert.equal(await page.locator('.solidify-button').evaluate(element => (
    getComputedStyle(element).height
  )), '44px');
  assert.equal(await page.locator('[data-solidify]').getAttribute('data-unsolidified'), 'false');
  assert.equal(await page.locator('.solidify-dot').first().evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(22, 163, 74)');
  assert.equal(await page.locator('.agent-status').evaluate(element => (
    getComputedStyle(element).height
  )), '44px');
  for (const selector of ['[data-history-undo]', '[data-history-redo]', '[data-solidify]']) {
    const disabledStyle = await page.locator(selector).evaluate(element => ({
      background:getComputedStyle(element).backgroundColor,
      color:getComputedStyle(element).color,
      opacity:getComputedStyle(element).opacity,
    }));
    assert.equal(disabledStyle.background, 'rgb(247, 247, 248)');
    assert.equal(disabledStyle.color, 'rgb(168, 168, 173)');
    assert.equal(disabledStyle.opacity, '1');
  }
  const agentHoverBefore = await page.locator('.agent-status .pill-nav-fill').evaluate(element => (
    getComputedStyle(element).transform
  ));
  const agentLabelBefore = await page.locator('.agent-status .pill-nav-label-default').evaluate(element => (
    getComputedStyle(element).transform
  ));
  await page.locator('.agent-status').hover();
  await page.waitForTimeout(180);
  assert.notEqual(await page.locator('.agent-status .pill-nav-fill').evaluate(element => (
    getComputedStyle(element).transform
  )), agentHoverBefore);
  assert.notEqual(await page.locator('.agent-status .pill-nav-label-default').evaluate(element => (
    getComputedStyle(element).transform
  )), agentLabelBefore);
  await page.waitForFunction(() => (
    getComputedStyle(document.querySelector('.agent-status .pill-nav-label-hover')).opacity === '1'
  ));
  const disabledLabelBefore = await page.locator('[data-history-redo] .pill-nav-label-default')
    .evaluate(element => getComputedStyle(element).transform);
  await page.locator('[data-history-redo]').hover();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('[data-history-redo] .pill-nav-label-default')
    .evaluate(element => getComputedStyle(element).transform), disabledLabelBefore);
  assert.equal(await rejectedWebSocketStatus(app.editorWsUrl), 409);
  assert.equal(await page.locator('[data-agent-placeholder]').count(), 0);
  assert.ok(await page.locator('.brand-logo').evaluate(image => image.naturalWidth > 0));
  assert.equal(await page.locator('.mode-badge').count(), 0);
  assert.equal(await page.locator('.mode-emblem').count(), 1);
  assert.equal(await page.locator('.mode-emblem-icon').count(), 1);
  assert.equal(await page.locator('.mode-pill-list').count(), 1);
  assert.deepEqual(await page.locator('[data-mode]').evaluateAll(buttons => (
    buttons.map(button => button.dataset.mode)
  )), ['preview', 'edit', 'region']);
  assert.equal(await page.locator('.mode-button .pill-nav-fill').count(), 3);
  assert.equal(await page.locator('.mode-tools').getAttribute('data-active-mode'), 'region');
  assert.equal(await page.locator('[data-mode="region"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-page-panel-toggle]').getAttribute('aria-expanded'), 'false');
  assert.ok(await page.locator('.page-panel').evaluate(element => element.getBoundingClientRect().width <= 72));
  assert.equal(await page.locator('.page-item-name').first().evaluate(element => (
    getComputedStyle(element).display
  )), 'none');
  await page.locator('[data-page-panel-toggle]').click();
  assert.equal(await page.locator('[data-page-panel-toggle]').getAttribute('aria-expanded'), 'true');
  assert.ok(await page.locator('.page-panel').evaluate(element => element.getBoundingClientRect().width >= 200));
  assert.notEqual(await page.locator('.page-item-name').first().evaluate(element => (
    getComputedStyle(element).display
  )), 'none');
  assert.notEqual(await page.locator('.mode-pill-list').evaluate(element => (
    getComputedStyle(element).boxShadow
  )), 'none');
  assert.equal(await page.locator('.mode-tools').evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('.mode-emblem').evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(227, 229, 233)');
  assert.equal(await page.locator('.mode-emblem-icon').evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), await page.locator('[data-mode="region"] .pill-nav-label-default').evaluate(element => (
    getComputedStyle(element).color
  )));
  assert.match(await page.locator('.mode-emblem-icon').evaluate(element => (
    getComputedStyle(element).webkitMaskImage
  )), /edit-deck-icon\.png/);
  assert.equal(await page.locator('.mode-pill-list').evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(227, 229, 233)');
  assert.equal(await page.locator('.mode-pill-list').evaluate(element => (
    getComputedStyle(element).backgroundImage
  )), 'none');
  assert.equal(await page.locator('.mode-button .pill-nav-fill').first().evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(227, 229, 233)');
  assert.equal(await page.locator('[data-mode="edit"]').evaluate(element => (
    getComputedStyle(element, '::before').content
  )), 'none');
  assert.ok(await page.locator('.canvas-toolbar').evaluate(toolbar => {
    const toolbarRect = toolbar.getBoundingClientRect();
    const modeRect = toolbar.querySelector('.mode-tools').getBoundingClientRect();
    return Math.abs((toolbarRect.left + toolbarRect.width / 2)
      - (modeRect.left + modeRect.width / 2)) < 1;
  }));
  assert.equal(await page.locator('.canvas-resolution').innerText(), '画布 1920 × 1080');
  assert.match(await page.locator('.zoom-value').innerText(), /^缩放 \d+%$/);
  assert.equal(await page.locator('.revision-value').innerText(), '会话版本 R0');
  const emblemTransformBefore = await page.locator('.mode-emblem-icon')
    .evaluate(element => getComputedStyle(element).transform);
  await page.locator('.mode-emblem').hover();
  await page.waitForTimeout(120);
  assert.notEqual(await page.locator('.mode-emblem-icon')
    .evaluate(element => getComputedStyle(element).transform), emblemTransformBefore);
  const hoverCircleBefore = await page.locator('[data-mode="edit"] .pill-nav-fill')
    .evaluate(element => getComputedStyle(element).transform);
  await page.locator('[data-mode="edit"]').hover();
  await page.waitForTimeout(350);
  assert.notEqual(await page.locator('[data-mode="edit"] .pill-nav-fill')
    .evaluate(element => getComputedStyle(element).transform), hoverCircleBefore);
  assert.equal(await page.locator('[data-mode="edit"] .pill-nav-label-hover')
    .evaluate(element => getComputedStyle(element).color), 'rgb(168, 0, 9)');
  await page.locator('[data-mode="edit"]').click();
  assert.equal(await page.locator('.mode-tools').getAttribute('data-active-mode'), 'edit');
  await page.waitForTimeout(220);
  assert.equal(await page.locator('[data-mode="edit"]').evaluate(element => (
    getComputedStyle(element).backgroundColor
  )), 'rgb(227, 229, 233)');
  assert.equal(await page.locator('[data-mode="edit"]').evaluate(element => (
    getComputedStyle(element).color
  )), 'rgb(168, 0, 9)');
  assert.equal(await page.locator('[data-mode="edit"]').evaluate(element => (
    getComputedStyle(element).boxShadow
  )), 'none');
  assert.equal(await page.locator('[data-task-drawer]').evaluate(element => getComputedStyle(element).position), 'fixed');
  assert.equal(await page.locator('[data-task-drawer-panel]').evaluate(element => getComputedStyle(element).position), 'absolute');
  assert.equal(await page.locator('[data-agent-connection-panel]').count(), 0);
  assert.equal(await page.locator('[data-agent-chat-advanced]').count(), 0);
  assert.equal(await page.locator('.workspace > [data-agent-terminal-panel]').count(), 1);
  assert.equal(await page.locator('[data-task-drawer]').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
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

test('ready 后晚到 canvas 替换会稳定 hydrate 导航并让切页诊断动作使用新节点', async t => {
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
    window.__lateReadyCount = 0;
    window.addEventListener('message', event => {
      if (event.data?.type === 'deck-ready') window.__lateReadyCount += 1;
    });
  });
  await page.waitForFunction(() => (
    document.querySelector('#deck-frame')?.contentWindow?.__lateCanvasReplacementDone === true
  ));
  await page.waitForFunction(() => window.__lateReadyCount > 0);
  await page.waitForFunction(() => (
    document.querySelector('[data-page-index="2"]') === window.__navBeforeLateHydration
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
  assert.equal(await page.locator('[data-page-key][aria-current="page"]').innerText(), '02');
  assert.equal(
    await page.locator('[data-page-key][aria-current="page"]').getAttribute('aria-label'),
    '02 目录页',
  );
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
  assert.equal(await page.locator('[data-page-key][aria-current="page"]').innerText(), '01');
  assert.equal(
    await page.locator('[data-page-key][aria-current="page"]').getAttribute('aria-label'),
    '01 目录页',
  );
  assert.ok(await page.locator('#deck-frame').evaluate(frame => frame.contentWindow.scrollY < 100));

  const currentKey = await page.locator('[data-page-key][aria-current="page"]').getAttribute('data-page-key');
  await page.getByRole('button', { name: '02 目录页' }).evaluate(button => {
    button.dataset.pageKey = 'page-does-not-exist';
    button.click();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-current-key]').innerText(), currentKey);
  assert.equal(await page.locator('[data-page-key][aria-current="page"]').innerText(), '01');
  assert.equal(
    await page.locator('[data-page-key][aria-current="page"]').getAttribute('aria-label'),
    '01 目录页',
  );
  assert.deepEqual(resourceProblems, []);
});

test('Deck 重新就绪时左侧页序保留同一选中节点且不会短暂失去高亮', async t => {
  const app = await startFixtureServer();
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());
  await page.getByRole('button', { name:'02 目录页' }).click();
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页');

  const activeButton = await page.locator('[data-page-key][aria-current="page"]').elementHandle();
  await page.evaluate(() => {
    const list = document.querySelector('[data-page-list]');
    window.__pageHighlightSamples = [];
    window.__deckReadyCount = 0;
    window.addEventListener('message', event => {
      if (event.data?.type === 'deck-ready') window.__deckReadyCount += 1;
    });
    const capture = () => window.__pageHighlightSamples.push({
      count:list.querySelectorAll('[aria-current="page"]').length,
      index:list.querySelector('[aria-current="page"]')?.dataset.pageIndex ?? null,
    });
    window.__pageHighlightObserver = new MutationObserver(capture);
    window.__pageHighlightObserver.observe(list, {
      childList:true, subtree:true, attributes:true, attributeFilter:['aria-current'],
    });
  });
  await page.locator('#deck-frame').evaluate(frame => new Promise(resolve => {
    frame.addEventListener('load', resolve, { once:true });
    frame.contentWindow.location.reload();
  }));
  await page.waitForFunction(() => window.__deckReadyCount > 0);
  await page.waitForFunction(() => document.querySelector('[data-current-page]')?.textContent === '02 目录页'
    && document.querySelector('[data-page-index="2"]')?.getAttribute('aria-current') === 'page');
  await page.waitForTimeout(100);
  const samples = await page.evaluate(() => {
    window.__pageHighlightObserver.disconnect();
    return window.__pageHighlightSamples;
  });
  assert.equal(await activeButton.evaluate(button => button.isConnected), true,
    `Deck 重放不应替换左侧已选中节点：${JSON.stringify(samples)}`);
  assert.ok(samples.every(sample => sample.count === 1 && sample.index === '2'),
    `左侧页序高亮不应消失或跳页：${JSON.stringify(samples)}`);
  assert.deepEqual(browserProblems, []);
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
  const pillStyles = '<link rel="stylesheet" href="/editor/pill-nav.css" data-deck-editor-ui>';
  const frameBridge = '<script type="module" src="/editor/frame-bridge.mjs"></script>';
  assert.equal(count(preview, '<script src="/editor/html2canvas.min.js"></script>'), 1);
  assert.equal(count(preview, pillStyles), 1,
    'PillNav 样式必须随 preview 标记注入，避免画布按钮先出现双层文字');
  assert.equal(count(preview, frameBridge), 1);
  assert.ok(preview.indexOf(pillStyles) < preview.indexOf(frameBridge),
    'PillNav 样式必须先于画布桥接脚本加载');
  assert.equal(await readFile(app.deckPath, 'utf8'), before);

  assert.equal((await fetch(`${app.url}/`)).status, 403);
  assert.equal((await fetch(`${app.url}/?token=${app.token}&editorToken=wrong`)).status, 403);
  const editorIndex = await fetch(`${app.url}/?token=${app.token}&editorToken=${app.editorToken}`);
  assert.equal(editorIndex.status, 200);
  assert.match(editorIndex.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);

  for (const path of [
    '/preview',
    '/editor/editor.mjs',
    '/editor/agent-terminal-panel.mjs',
    '/editor/inspector-panel.mjs',
    '/editor/history-state.mjs',
    '/editor/task-drawer.mjs',
    '/editor/protocol.mjs',
    '/editor/attachment-protocol.mjs',
    '/editor/editor.css',
    '/editor/huawei-logo.png',
    '/editor/html2canvas.min.js',
    '/editor/xterm.js',
    '/editor/xterm.css',
    '/editor/patch-runtime.js',
  ]) {
    assert.equal((await fetch(`${app.url}${path}`)).status, 403, path);
  }
  for (const path of [
    `/editor/editor.mjs?token=${app.token}`,
    `/editor/agent-terminal-panel.mjs?token=${app.token}`,
    `/editor/inspector-panel.mjs?token=${app.token}`,
    `/editor/history-state.mjs?token=${app.token}`,
    `/editor/task-drawer.mjs?token=${app.token}`,
    `/editor/protocol.mjs?token=${app.token}`,
    `/editor/attachment-protocol.mjs?token=${app.token}`,
    `/editor/huawei-logo.png?token=${app.token}`,
    `/editor/html2canvas.min.js?token=${app.token}`,
    `/editor/xterm.js?token=${app.token}`,
    `/editor/xterm.css?token=${app.token}`,
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

test('frame bridge 先加载受保护 runtime 并让真实 inline runtime 安全复用', async t => {
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
  assert.equal(resourceRequests.filter(url => new URL(url).pathname === '/editor/patch-runtime.js').length, 1);
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
