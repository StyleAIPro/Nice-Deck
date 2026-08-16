import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { openEditor, startFixtureServer } from './test-helpers.mjs';

const terminalExecutable = name => process.platform === 'win32' ? `${name}.cmd` : name;

class FakePty {
  constructor(executable, args, options, pid) {
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pid = pid;
    this.events = new EventEmitter();
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }

  onData(listener) { this.events.on('data', listener); return { dispose() {} }; }
  onExit(listener) { this.events.on('exit', listener); return { dispose() {} }; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() {
    this.killed = true;
    this.events.emit('exit', { exitCode:0, signal:null });
  }
}

async function postApi(app, pathname, body) {
  const response = await fetch(`${app.url}${pathname}?token=${encodeURIComponent(app.token)}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function terminalLayout(page) {
  return page.evaluate(() => {
    const panelNode = document.querySelector('[data-agent-terminal-panel]');
    const hostNode = document.querySelector('[data-agent-terminal-host]');
    const viewportNode = hostNode?.querySelector('.xterm-viewport');
    const screenNode = hostNode?.querySelector('.xterm-screen');
    const panel = panelNode?.getBoundingClientRect();
    const host = hostNode?.getBoundingClientRect();
    const viewport = viewportNode?.getBoundingClientRect();
    const screen = screenNode?.getBoundingClientRect();
    return {
      panelBottom:panel?.bottom ?? 0,
      hostBottom:host?.bottom ?? 0,
      viewportBottom:viewport?.bottom ?? 0,
      screenBottom:screen?.bottom ?? 0,
      visibleRows:screenNode?.querySelectorAll('.xterm-rows > div').length ?? 0,
      scrollGap:viewportNode
        ? viewportNode.scrollHeight - viewportNode.clientHeight - viewportNode.scrollTop
        : Number.POSITIVE_INFINITY,
    };
  });
}

async function assertStableTerminalLayout(page, child, context) {
  await page.waitForTimeout(80);
  const layout = await terminalLayout(page);
  const ptySize = child.resizes.at(-1) ?? [child.options.cols, child.options.rows];
  assert.equal(ptySize[1], layout.visibleRows, `${context} PTY rows 与 xterm rows 不一致：${JSON.stringify({ ptySize, layout })}`);
  assert.ok(layout.hostBottom <= layout.panelBottom + 1, `${context} host 超出抽屉底部：${JSON.stringify(layout)}`);
  assert.ok(layout.viewportBottom <= layout.hostBottom + 1, `${context} viewport 超出 host：${JSON.stringify(layout)}`);
  assert.ok(layout.screenBottom <= layout.hostBottom + 1, `${context} screen 超出 host：${JSON.stringify(layout)}`);
  assert.ok(layout.scrollGap <= 1, `${context} 终端没有保持在输入区末端：${JSON.stringify(layout)}`);
  return layout;
}

test('bypass Agent 遇到目录信任提示时自动展开右侧终端并等待用户确认', async t => {
  const children = [];
  const app = await startFixtureServer({
    autoStartAgentTerminal:true,
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 4900 + children.length);
      children.push(child);
      queueMicrotask(() => child.events.emit(
        'data',
        'Do you trust the contents of this directory?\r\n› 1. Yes, proceed\r\n  2. No, quit\u001b[?25h',
      ));
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const panel = page.locator('[data-agent-terminal-panel]');
  await panel.waitFor({ state:'visible' });
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'attention'
      && document.querySelector('[data-agent-terminal-panel]')?.dataset.interactionRequired
        === 'directory-trust'
  ));
  assert.match(await page.locator('[data-agent-status]').innerText(), /Codex 等待确认/);
  assert.match(await panel.locator('.agent-terminal-detail').innerText(), /确认是否信任/);
  assert.equal(await panel.getAttribute('data-terminal-loading'), 'false', '信任页不能被加载遮罩挡住');
  assert.deepEqual(children[0].writes, [], '显示信任页前不能误投初始化任务');

  await panel.locator('[data-agent-terminal-host]').click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(40);
  assert.deepEqual(children[0].writes, ['\r']);
  children[0].events.emit('data', '\r\nCodex ready\r\n');
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  assert.ok(
    children[0].writes.some(value => value.includes('Huawei Deck')),
    '确认信任并进入正常输入框后才应提交初始化任务',
  );
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('Editor 后台预启动 bypass 终端，右上角负责展开、重连、切换 provider 和新会话', async t => {
  const children = [];
  const createdPrompts = [];
  let conversations = 0;
  let releaseFreshOutput;
  let releaseFreshIdentity;
  const app = await startFixtureServer({
    autoStartAgentTerminal:true,
    createAgentTerminalConversation:async (provider, options) => {
      conversations += 1;
      createdPrompts.push(options.initialPrompt);
      if (provider === 'codex' && conversations === 2) {
        return {
          conversationId:null,
          resume:false,
          initialPromptConsumed:false,
          discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
        };
      }
      return {
        conversationId:`${provider}-terminal-e2e-${conversations}`,
        resume:provider === 'codex',
        initialPromptConsumed:provider === 'codex',
      };
    },
    discoverAgentTerminalConversation:async () => new Promise(resolve => {
      releaseFreshIdentity = () => resolve('codex-terminal-e2e-2');
    }),
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 5000 + children.length);
      children.push(child);
      if (children.length === 2) {
        releaseFreshOutput = () => child.events.emit('data', '\r\ncodex READY\r\n');
      } else {
        queueMicrotask(() => child.events.emit('data', '\r\ncodex READY\r\n'));
      }
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  assert.equal(children.length, 1, '打开抽屉前就应创建默认 Agent 会话');

  await page.click('[data-mode="edit"]');
  const initialTaskInset = await page.locator('[data-task-drawer]').evaluate(node => (
    window.innerWidth - node.getBoundingClientRect().right
  ));
  await page.click('[data-agent-status]');
  const panel = page.locator('[data-agent-terminal-panel]');
  await panel.waitFor({ state:'visible' });
  await page.waitForTimeout(260);
  await page.waitForFunction(() => {
    const terminal = document.querySelector('[data-agent-terminal-panel]')?.getBoundingClientRect();
    const inspector = document.querySelector('.inspector-panel')?.getBoundingClientRect();
    const canvas = document.querySelector('.canvas-column')?.getBoundingClientRect();
    const pages = document.querySelector('.page-panel')?.getBoundingClientRect();
    const tasks = document.querySelector('[data-task-drawer]')?.getBoundingClientRect();
    return terminal && inspector && canvas && pages && tasks
      && Math.abs(inspector.left - canvas.left) <= 1
      && canvas.top - inspector.bottom >= 7
      && terminal.left - inspector.right >= 7
      && Math.abs(terminal.top - pages.top) <= 1
      && Math.abs(terminal.bottom - pages.bottom) <= 1
      && terminal.left - tasks.right >= 7;
  });
  await page.waitForFunction(initialInset => {
    const tasks = document.querySelector('[data-task-drawer]')?.getBoundingClientRect();
    return tasks && window.innerWidth - tasks.right > initialInset + 200;
  }, initialTaskInset);
  const geometry = await page.evaluate(() => {
    const terminal = document.querySelector('[data-agent-terminal-panel]').getBoundingClientRect();
    const inspector = document.querySelector('.inspector-panel').getBoundingClientRect();
    const canvas = document.querySelector('.canvas-column').getBoundingClientRect();
    const pages = document.querySelector('.page-panel').getBoundingClientRect();
    const tasks = document.querySelector('[data-task-drawer]').getBoundingClientRect();
    return {
      terminal:{ x:terminal.x, y:terminal.y, width:terminal.width, height:terminal.height },
      inspector:{ x:inspector.x, y:inspector.y, width:inspector.width, height:inspector.height },
      canvas:{ x:canvas.x, y:canvas.y, width:canvas.width, height:canvas.height },
      pages:{ x:pages.x, y:pages.y, width:pages.width, height:pages.height },
      taskInset:window.innerWidth - tasks.right,
    };
  });
  assert.ok(Math.abs(geometry.inspector.x - geometry.canvas.x) <= 1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.inspector.width - geometry.canvas.width) <= 1, JSON.stringify(geometry));
  assert.ok(geometry.canvas.y - (geometry.inspector.y + geometry.inspector.height) >= 7,
    JSON.stringify(geometry));
  assert.ok(geometry.terminal.x - (geometry.inspector.x + geometry.inspector.width) >= 7,
    JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.terminal.y - geometry.pages.y) <= 1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.terminal.height - geometry.pages.height) <= 1, JSON.stringify(geometry));
  assert.ok(geometry.taskInset > initialTaskInset + 200, JSON.stringify(geometry));
  assert.equal(await panel.evaluate(node => getComputedStyle(node).animationName), 'agent-drawer-in');
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  await assertStableTerminalLayout(page, children[0], '首次打开且尚未拖动宽度');

  const canvasWidthBeforeResize = await page.locator('.canvas-column').evaluate(
    node => node.getBoundingClientRect().width,
  );
  const resizerBox = await panel.locator('[data-agent-terminal-resizer]').boundingBox();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x - 120, resizerBox.y + resizerBox.height / 2, { steps:8 });
  await page.mouse.up();
  await page.waitForFunction(previousWidth => (
    document.querySelector('[data-agent-terminal-panel]')?.getBoundingClientRect().width
      >= previousWidth + 100
  ), geometry.terminal.width);
  await page.waitForFunction(() => {
    const terminal = document.querySelector('[data-agent-terminal-panel]')?.getBoundingClientRect();
    const tasks = document.querySelector('[data-task-drawer]')?.getBoundingClientRect();
    return terminal && tasks && window.innerWidth - tasks.right >= terminal.width;
  });
  const resizedGeometry = await page.evaluate(() => ({
    terminalWidth:document.querySelector('[data-agent-terminal-panel]').getBoundingClientRect().width,
    canvasWidth:document.querySelector('.canvas-column').getBoundingClientRect().width,
    taskInset:window.innerWidth
      - document.querySelector('[data-task-drawer]').getBoundingClientRect().right,
  }));
  assert.ok(resizedGeometry.terminalWidth >= geometry.terminal.width + 100, JSON.stringify(resizedGeometry));
  assert.ok(resizedGeometry.canvasWidth <= canvasWidthBeforeResize - 100, JSON.stringify(resizedGeometry));
  assert.ok(resizedGeometry.taskInset >= resizedGeometry.terminalWidth, JSON.stringify(resizedGeometry));

  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
  ));
  assert.equal(children.length, 1);
  assert.equal(children[0].executable, terminalExecutable('codex'));
  assert.deepEqual(children[0].args.slice(0, 3), [
    'resume', '--dangerously-bypass-approvals-and-sandbox', 'codex-terminal-e2e-1',
  ]);
  assert.equal(children[0].args.length, 3);
  assert.match(createdPrompts[0], /huawei-deck/);
  assert.equal(children[0].options.cwd, app.agentTerminal.cwd);
  assert.equal(app.agentTerminal.projectRoot, app.agentWorkspace.snapshot().projectRoot);
  assert.equal(await panel.locator('[data-agent-chat-input], .agent-chat-tabs, .agent-chat-composer').count(), 0);
  assert.equal(await panel.locator('[data-agent-terminal-provider] option').count(), 3);
  assert.equal(await panel.locator('[data-agent-terminal-provider] option[value="opencode"]').count(), 1);
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  const terminalBottomGeometry = await page.evaluate(() => {
    const hostNode = document.querySelector('[data-agent-terminal-host]');
    const screenNode = hostNode.querySelector('.xterm-screen');
    const host = hostNode.getBoundingClientRect();
    const screen = screenNode.getBoundingClientRect();
    const rowCount = screenNode.querySelectorAll('.xterm-rows > div').length;
    const hostStyle = getComputedStyle(hostNode);
    return {
      hostTop:host.top,
      hostBottom:host.bottom,
      hostHeight:host.height,
      hostClientHeight:hostNode.clientHeight,
      paddingTop:Number.parseFloat(hostStyle.paddingTop),
      paddingBottom:Number.parseFloat(hostStyle.paddingBottom),
      screenTop:screen.top,
      screenBottom:screen.bottom,
      bottomInset:host.bottom - screen.bottom,
      screenHeight:screen.height,
      rowCount,
      rowHeight:rowCount ? screen.height / rowCount : 0,
    };
  });
  assert.ok(
    terminalBottomGeometry.paddingBottom >= 10
      && terminalBottomGeometry.bottomInset + .5 >= terminalBottomGeometry.paddingBottom,
    `Codex 输入区必须完整位于终端底部安全区上方：${JSON.stringify(terminalBottomGeometry)}`,
  );
  await assertStableTerminalLayout(page, children[0], '首次打开');
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await panel.locator('.agent-terminal-close').click();
    await panel.waitFor({ state:'hidden' });
    await page.click('[data-agent-status]');
    await panel.waitFor({ state:'visible' });
    await assertStableTerminalLayout(page, children[0], `第 ${cycle} 次重开`);
  }
  if (process.env.AGENT_TERMINAL_SCREENSHOT) {
    await page.screenshot({ path:process.env.AGENT_TERMINAL_SCREENSHOT, fullPage:true });
  }

  await panel.locator('[data-agent-terminal-host]').click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(100);
  assert.match(children[0].writes.join(''), /hello/);

  await panel.locator('[data-agent-terminal-command="new-session"]').click();
  await panel.locator('[data-agent-terminal-loading]').waitFor({ state:'visible' });
  assert.match(
    await panel.locator('[data-agent-terminal-loading]').innerText(),
    /正在创建会话并读取项目规则/,
  );
  assert.notEqual(
    await panel.locator('.agent-terminal-loading-spinner').evaluate(
      node => getComputedStyle(node).animationName,
    ),
    'none',
  );
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
  ));
  assert.equal(children.length, 2, '新 PTY 必须在会话 ID 发现前立即启动');
  assert.equal(await panel.getAttribute('data-conversation-id'), '');
  releaseFreshOutput();
  for (let attempt = 0; attempt < 700 && children[1].writes.at(-1) !== '\r'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(children[1].writes.at(-1), '\r', '新会话初始指令必须完成自动回车');
  await panel.locator('[data-agent-terminal-loading]').waitFor({ state:'hidden' });
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  assert.match(
    await panel.locator('[data-agent-terminal-host]').textContent(),
    /codex(?:\.cmd)? READY/,
  );
  while (!releaseFreshIdentity) await page.waitForTimeout(10);
  releaseFreshIdentity();
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.conversationId
      === 'codex-terminal-e2e-2'
  ));
  assert.equal(children.length, 2);
  assert.equal(children[0].killed, true);
  assert.equal(children[1].executable, terminalExecutable('codex'));
  assert.deepEqual(children[1].args.slice(0, 1), [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.match(children[1].writes[0], /019ff4b7-0622-7272-b0e2-394f6316b52a/);
  assert.match(children[1].writes[0], /huawei-deck/);
  assert.equal(children[1].writes.at(-1), '\r');
  assert.equal(
    await panel.getAttribute('data-conversation-id'),
    'codex-terminal-e2e-2',
  );
  assert.equal(
    app.agentWorkspace.snapshot().providers.codex.activeConversationId,
    'codex-terminal-e2e-2',
  );

  await page.reload();
  await page.waitForSelector('[data-page-key]');
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
      && document.querySelector('[data-agent-label]')?.textContent.includes('Codex')
  ));
  await page.click('[data-agent-status]');
  await page.waitForFunction(() => (
    /codex(?:\.cmd)? READY/.test(
      document.querySelector('[data-agent-terminal-host]')?.textContent ?? '',
    )
  ));
  assert.ok(Math.abs(
    await panel.evaluate(node => node.getBoundingClientRect().width)
      - resizedGeometry.terminalWidth,
  ) <= 1, '拖动后的终端宽度必须在刷新后恢复');
  assert.equal(children.length, 2, '浏览器刷新必须重连刚创建的新 PTY 会话');

  await panel.getByRole('combobox', { name:'选择终端 Agent' }).click();
  await page.getByRole('option', { name:'Claude Code' }).click();
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-terminal-panel]')?.dataset.terminalState === 'running'
      && document.querySelector('[data-agent-terminal-provider]')?.value === 'claude-code'
  ));
  assert.equal(
    children.length,
    3,
    JSON.stringify(children.map(child => ({
      executable:child.executable,
      args:child.args,
      killed:child.killed,
    }))),
  );
  assert.equal(children[1].killed, true);
  assert.equal(children[2].executable, terminalExecutable('claude'));
  assert.deepEqual(children[2].args.slice(0, 3), [
    '--dangerously-skip-permissions', '--session-id', 'claude-code-terminal-e2e-3',
  ]);
  assert.match(
    await panel.locator('.agent-terminal-commandbar').innerText(),
    /claude(?:\.cmd)? --dangerously-skip-permissions/,
  );
  await assertStableTerminalLayout(page, children[2], '切换 provider 后');

  const previousConversationId = await panel.getAttribute('data-conversation-id');
  await panel.locator('[data-agent-terminal-command="new-session"]').click();
  await page.waitForFunction(previous => {
    const terminal = document.querySelector('[data-agent-terminal-panel]');
    return terminal?.dataset.terminalState === 'running'
      && terminal.dataset.conversationId !== previous;
  }, previousConversationId);
  assert.equal(children.length, 4);
  assert.equal(children[2].killed, true);
  assert.equal(children[3].executable, terminalExecutable('claude'));
  assert.deepEqual(children[3].args.slice(0, 3), [
    '--dangerously-skip-permissions', '--session-id', 'claude-code-terminal-e2e-4',
  ]);
  await assertStableTerminalLayout(page, children[3], '新会话启动后');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});

test('任务批次进入同一 bypass PTY，权威 action 完成后退出 pending', async t => {
  const children = [];
  const app = await startFixtureServer({
    agentRunTimeoutMs:5_000,
    createAgentTerminalConversation:async provider => ({
      conversationId:`${provider}-task-e2e`,
      resume:provider === 'codex',
    }),
    spawnAgentTerminal:(executable, args, options) => {
      const child = new FakePty(executable, args, options, 6000 + children.length);
      children.push(child);
      queueMicrotask(() => child.events.emit(
        'data',
        `\r\n${executable} TASK READY\r\n`
          + '\u001b[11;1H\u001b[1m›\u001b[11;3H\u001b[?25h\u001b[11;3H\u001b[?2026l',
      ));
      return child;
    },
  });
  t.after(() => app.close());
  const { browser, page, browserProblems, resourceProblems } = await openEditor(app);
  t.after(() => browser.close());

  const pageKey = await page.locator('[data-page-key]').first().getAttribute('data-page-key');
  const createdResponse = await fetch(
    `${app.url}/api/tasks?token=${encodeURIComponent(app.token)}`,
    {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:0,
        pageKey,
        pageIndex:1,
        pageLabel:'01 目录页',
        instruction:'把第一页标题向右移动 24px',
        rect:{ x:80, y:80, w:500, h:160 },
      }),
    },
  );
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  await page.waitForSelector('[data-task-row]');
  const target = await page.frameLocator('#deck-frame').locator('h2').first().evaluate(
    element => window.HuaweiDeckPatchRuntime.makeLocator(element),
  );

  await page.locator('[data-process-all]').click();
  await page.waitForFunction(() => (
    document.querySelector('[data-process-note]')?.textContent.includes('终端')
  ));
  await page.waitForFunction(() => document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'busy');
  await page.waitForFunction(() => document.querySelector('[data-agent-terminal-panel]')
    ?.dataset.terminalState === 'running');
  assert.equal(children.length, 1);
  assert.equal(children[0].executable, terminalExecutable('codex'));
  assert.deepEqual(children[0].args.slice(0, 3), [
    'resume', '--dangerously-bypass-approvals-and-sandbox', 'codex-task-e2e',
  ]);
  for (let attempt = 0; attempt < 800
    && !children[0].writes.some(value => value.includes(created.task.id)); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const startupPrompt = children[0].writes.find(value => value.includes(created.task.id));
  assert.match(startupPrompt, new RegExp(created.task.id));
  assert.match(startupPrompt, /huawei-deck/);

  await postApi(app, '/api/actions', {
    expectedRevision:1,
    taskId:created.task.id,
    actions:[{
      id:'terminal-agent-move',
      taskId:created.task.id,
      target,
      kind:'translate',
      payload:{ x:24, y:0 },
    }],
  });
  let run;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(
      `${app.url}/api/agent-runs/current?token=${encodeURIComponent(app.token)}`,
    );
    run = await response.json();
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  await page.waitForFunction(() => (
    document.querySelector('[data-agent-status]')?.dataset.agentStatus === 'online'
  ));
  assert.match(await page.locator('[data-process-note]').innerText(), /完成本批处理/);
  assert.equal(await page.locator('[data-task-row]').filter({ has:page.locator('.task-status-completed') }).count(), 1);
  assert.equal(children.length, 1, '任务完成前后必须复用同一个 PTY');
  assert.deepEqual(browserProblems, []);
  assert.deepEqual(resourceProblems, []);
});
