import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import {
  pickDeckWithSystemPicker,
  pickProjectDirectoryWithSystemPicker,
  startAppServer,
} from '../app-server.mjs';
import { createRecentDeckStore } from '../recent-deck-store.mjs';
import { WorkCatalog } from '../work-catalog.mjs';
import { createWorkHistoryStore } from '../work-history-store.mjs';

function post(app, path) {
  return fetch(`${app.url}${path}?token=${encodeURIComponent(app.token)}`, {
    method:'POST', headers:{ origin:app.url },
  });
}

function postJson(app, path, body) {
  return fetch(`${app.url}${path}?token=${encodeURIComponent(app.token)}`, {
    method:'POST',
    headers:{ origin:app.url, 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
}

function pickerProcess({ stdout = '', stderr = '', code = 0 }, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', code);
    });
    return child;
  };
}

test('系统选择器分别使用文件与目录契约，并把取消保持为 null', async () => {
  const calls = [];
  assert.equal(await pickDeckWithSystemPicker({
    pythonExecutable:'python-test',
    spawnProcess:pickerProcess({ stdout:'{"deckPath":"/tmp/demo.html"}' }, calls),
  }), '/tmp/demo.html');
  assert.equal(await pickProjectDirectoryWithSystemPicker({
    pythonExecutable:'python-test',
    spawnProcess:pickerProcess({ stdout:'{"directoryPath":"/tmp/project"}' }, calls),
  }), '/tmp/project');
  assert.equal(await pickProjectDirectoryWithSystemPicker({
    pythonExecutable:'python-test',
    spawnProcess:pickerProcess({ code:3 }, calls),
  }), null);
  assert.equal(calls[0].command, 'python-test');
  assert.equal(calls[0].args.at(-1), '--pick-only');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[1].args.at(-1), '--pick-directory-only');
});

test('启动器可查询页面租约，并区分从未连接与已经关闭', async t => {
  const app = await startAppServer({
    token:'launcher-status-secret',
    launcherClientCloseGraceMs:5_000,
  });
  t.after(() => app.close());
  const statusUrl = `${app.url}/api/launcher-status?token=${encodeURIComponent(app.token)}`;

  assert.deepEqual(await fetch(statusUrl).then(response => response.json()), {
    state:'idle', activePageCount:0, everConnected:false,
  });
  await postJson(app, '/api/client-connected', { clientId:'page-a', sequence:1 });
  assert.deepEqual(await fetch(statusUrl).then(response => response.json()), {
    state:'idle', activePageCount:1, everConnected:true,
  });
  await fetch(`${app.url}/api/close?token=${encodeURIComponent(app.token)}`
    + '&clientId=page-a&sequence=1', { method:'POST', headers:{ origin:app.url } });
  assert.deepEqual(await fetch(statusUrl).then(response => response.json()), {
    state:'idle', activePageCount:0, everConnected:true,
  });
});

test('显式退出接口立即关闭启动器及其全部运行时', async t => {
  const app = await startAppServer({
    token:'explicit-launcher-shutdown-secret',
    launcherClientCloseGraceMs:60_000,
  });
  t.after(() => app.close());
  const response = await fetch(
    `${app.url}/api/shutdown?token=${encodeURIComponent(app.token)}`,
    { method:'POST', headers:{ origin:app.url } },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status:'shutting-down' });
  const deadline = Date.now() + 1_000;
  while (app.state !== 'closed' && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
  assert.equal(app.state, 'closed');
});

test('页面进程异常消失且没有 close beacon 时由持续租约断线自动回收', async t => {
  const app = await startAppServer({
    token:'launcher-orphan-reap-secret',
    launcherClientCloseGraceMs:20,
  });
  t.after(() => app.close());
  await postJson(app, '/api/client-connected', { clientId:'crashed-page', sequence:1 });

  const leaseUrl = new URL('/launcher-lease', app.url);
  leaseUrl.protocol = 'ws:';
  leaseUrl.searchParams.set('token', app.token);
  leaseUrl.searchParams.set('clientId', 'crashed-page');
  leaseUrl.searchParams.set('sequence', '1');
  const lease = new WebSocket(leaseUrl, { headers:{ origin:app.url } });
  await new Promise((resolvePromise, reject) => {
    lease.once('open', resolvePromise);
    lease.once('error', reject);
  });
  lease.terminate();

  const deadline = Date.now() + 1_000;
  while (app.state !== 'closed' && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
  assert.equal(app.state, 'closed');
});

test('页面登记后在持续租约握手前崩溃也会超时回收', async t => {
  const app = await startAppServer({
    token:'launcher-handshake-timeout-secret',
    launcherClientCloseGraceMs:10,
    launcherLeaseHandshakeMs:15,
  });
  t.after(() => app.close());
  await postJson(app, '/api/client-connected', { clientId:'pre-socket-crash', sequence:1 });

  const deadline = Date.now() + 1_000;
  while (app.state !== 'closed' && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
  assert.equal(app.state, 'closed');
});

test('导入页声明一次只添加一份 HTML，并要求随机令牌', async t => {
  const app = await startAppServer({ token:'app-secret', pickDeck:async () => null });
  t.after(() => app.close());

  assert.equal((await fetch(`${app.url}/app/`)).status, 403);
  const response = await fetch(app.appUrl);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /style-src 'self' 'unsafe-inline'/,
    'xterm DOM renderer 需要运行时注入字体、色板和光标样式',
  );
  const html = await response.text();
  assert.match(html, /添加 Deck HTML/);
  assert.match(html, /一次只处理一份文件/);
  assert.match(html, /返回首页重新选择/);
  assert.match(html, /data-liquid-ether-background/);

  const liquidAsset = await fetch(
    `${app.url}/app/liquid-ether-background.mjs?token=${encodeURIComponent(app.token)}`,
  );
  assert.equal(liquidAsset.status, 200);
  assert.match(liquidAsset.headers.get('content-type') ?? '', /text\/javascript/);
  assert.match(await liquidAsset.text(), /createLiquidEtherBackground/);

  const threeAsset = await fetch(
    `${app.url}/app/three.module.min.js?token=${encodeURIComponent(app.token)}`,
  );
  assert.equal(threeAsset.status, 200);
  assert.match(threeAsset.headers.get('content-type') ?? '', /text\/javascript/);
  const threeCoreAsset = await fetch(
    `${app.url}/app/three.core.min.js?token=${encodeURIComponent(app.token)}`,
  );
  assert.equal(threeCoreAsset.status, 200);
});

test('选择状态原子锁定；选择 Deck 后确认项目目录，点击打开才启动 Editor', async t => {
  let releaseFirst;
  let pickCount = 0;
  let startCount = 0;
  let startOptions;
  const pickDeck = async () => {
    pickCount += 1;
    if (pickCount === 1) return new Promise(resolve => { releaseFirst = resolve; });
    return '/tmp/唯一-deck.html';
  };
  const app = await startAppServer({
    token:'app-secret',
    pickDeck,
    startEditor:async options => {
      startCount += 1;
      startOptions = options;
      return {
        url:'http://127.0.0.1:45678', token:'deck-token', editorToken:'editor-token',
        close:async () => {},
      };
    },
    resolveAgentProject:async ({ deckPath, explicitRoot }) => ({
      path:explicitRoot ?? '/tmp/project-root',
      source:explicitRoot ? 'explicit' : 'workspace-marker',
      needsConfirmation:false,
      warning:null,
      identity:{
        originalPath:explicitRoot ?? '/tmp/project-root',
        realPath:explicitRoot ?? '/tmp/project-root', dev:'1', ino:'2',
      },
      deckPath,
    }),
    assertAgentProject:async project => project.path,
  });
  t.after(() => app.close());

  const first = post(app, '/api/choose-deck');
  while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));
  const concurrent = await post(app, '/api/choose-deck');
  assert.equal(concurrent.status, 409);
  assert.equal((await concurrent.json()).code, 'DECK_SELECTION_IN_PROGRESS');

  releaseFirst(null);
  assert.equal((await first.then(response => response.json())).status, 'cancelled');
  const selected = await post(app, '/api/choose-deck').then(response => response.json());
  assert.equal(selected.status, 'deck-selected');
  assert.equal(selected.projectRoot.path, '/tmp/project-root');
  assert.equal(startCount, 0, '选择 Deck 不得提前启动 Editor 或 Agent');
  const opened = await postJson(app, '/api/open-deck', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  }).then(response => response.json());
  assert.equal(opened.status, 'selected');
  assert.match(opened.editorUrl, /editorToken=editor-token/);
  assert.equal(pickCount, 2);
  assert.equal(startCount, 1);
  assert.equal(startOptions.agentProvider, 'codex');
  assert.equal(startOptions.agentThreadId, null);
  assert.equal(startOptions.agentProjectRoot, '/tmp/project-root');
  assert.equal(startOptions.agentTerminalCwd, '/tmp/project-root');
  assert.equal(startOptions.autoStartAgentTerminal, true);
  assert.equal(app.state, 'selected');
});

test('修改 Deck 切换项目时保留后台 Editor，并在再次打开时复用运行时', async t => {
  let editorClosed = 0;
  let editorStarted = 0;
  const app = await startAppServer({
    token:'workspace-navigation-secret',
    pickDeck:async () => '/tmp/navigation-deck.html',
    resolveAgentProject:async () => ({
      path:'/tmp/navigation-project', source:'workspace-marker',
      needsConfirmation:false, warning:null,
      identity:{
        originalPath:'/tmp/navigation-project', realPath:'/tmp/navigation-project',
        dev:'1', ino:'2',
      },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async () => {
      editorStarted += 1;
      return {
        url:'http://127.0.0.1:45688', token:'deck-token', editorToken:'editor-token',
        close:async () => { editorClosed += 1; },
      };
    },
  });
  t.after(() => app.close());
  const selected = await post(app, '/api/choose-deck').then(response => response.json());
  const opened = await postJson(app, '/api/open-deck', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  }).then(response => response.json());
  const editorUrl = new URL(opened.editorUrl);
  assert.equal(editorUrl.searchParams.get('workspaceKind'), 'editing');
  assert.match(editorUrl.searchParams.get('workspaceUrl'), /\/app\/\?token=workspace-navigation-secret/);
  assert.equal((await fetch(app.appUrl)).status, 200, '进入 Editor 后初始页服务必须保留');

  const left = await postJson(app, '/api/leave-workspace', { destination:'editing' });
  assert.equal(left.status, 200);
  assert.deepEqual(await left.json(), { status:'idle', destination:'editing' });
  assert.equal(editorClosed, 0);
  assert.equal(app.state, 'idle');

  const selectedAgain = await post(app, '/api/choose-deck').then(response => response.json());
  const reopened = await postJson(app, '/api/open-deck', {
    candidateNonce:selectedAgain.candidateNonce,
    selectionRevision:selectedAgain.selectionRevision,
    provider:'codex',
  }).then(response => response.json());
  assert.equal(editorStarted, 1);
  assert.equal(reopened.editorUrl, opened.editorUrl);

  const invalid = await postJson(app, '/api/leave-workspace', { destination:'unknown' });
  assert.equal(invalid.status, 400);
  await app.close();
  assert.equal(editorClosed, 1);
});

test('用户直接关闭工作台页面时统一回收后台任务和初始页服务', async t => {
  let editorClosed = 0;
  const app = await startAppServer({
    token:'workspace-orphan-close-secret',
    launcherClientCloseGraceMs:10,
    pickDeck:async () => '/tmp/orphan-close.html',
    resolveAgentProject:async () => ({
      path:'/tmp/orphan-project', source:'workspace-marker',
      needsConfirmation:false, warning:null,
      identity:{
        originalPath:'/tmp/orphan-project', realPath:'/tmp/orphan-project', dev:'1', ino:'2',
      },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async () => ({
      url:'http://127.0.0.1:45689', token:'deck-token', editorToken:'editor-token',
      close:async () => { editorClosed += 1; },
    }),
  });
  t.after(() => app.close());
  const selected = await post(app, '/api/choose-deck').then(response => response.json());
  await postJson(app, '/api/open-deck', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  });
  await postJson(app, '/api/client-connected', { clientId:'editor-page', sequence:1 });
  await fetch(`${app.url}/api/close?token=${encodeURIComponent(app.token)}`
    + '&clientId=editor-page&sequence=1', { method:'POST', headers:{ origin:app.url } });
  const deadline = Date.now() + 1_000;
  while (app.state !== 'closed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(app.state, 'closed');
  assert.equal(editorClosed, 1);
});

test('多个工作台页面共享运行时，最后一个页面关闭后才统一回收', async t => {
  const app = await startAppServer({
    token:'multi-page-lease-secret',
    launcherClientCloseGraceMs:10,
  });
  t.after(() => app.close());
  await postJson(app, '/api/client-connected', { clientId:'page-a', sequence:1 });
  await postJson(app, '/api/client-connected', { clientId:'page-b', sequence:1 });
  await fetch(`${app.url}/api/close?token=${encodeURIComponent(app.token)}`
    + '&clientId=page-b&sequence=1', { method:'POST', headers:{ origin:app.url } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(app.state, 'idle');
  await fetch(`${app.url}/api/close?token=${encodeURIComponent(app.token)}`
    + '&clientId=page-a&sequence=1', { method:'POST', headers:{ origin:app.url } });
  const deadline = Date.now() + 500;
  while (app.state !== 'closed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(app.state, 'closed');
});

test('多个修改 Deck 任务可同时后台运行，切回时复用各自 Editor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-multi-runtime-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPaths = [join(root, 'one.html'), join(root, 'two.html')];
  await Promise.all(deckPaths.map((deckPath, index) => (
    writeFile(deckPath, `<!doctype html><title>deck-${index + 1}</title>`)
  )));
  const recentDeckStore = createRecentDeckStore({
    filePath:join(root, 'recent-decks.json'),
  });
  const workHistoryStore = createWorkHistoryStore({
    filePath:join(root, 'recent-work.json'), recentDeckStore,
  });
  const editors = [];
  let pickIndex = 0;
  const app = await startAppServer({
    token:'multi-edit-runtime-secret',
    recentDeckStore,
    workHistoryStore,
    pickDeck:async () => deckPaths[pickIndex++],
    resolveAgentProject:async ({ deckPath }) => ({
      path:root, source:'explicit', needsConfirmation:false, warning:null,
      identity:{ originalPath:root, realPath:root, dev:'1', ino:'2' },
      deckPath,
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      const runtime = {
        options,
        closed:false,
        url:`http://127.0.0.1:${46000 + editors.length}`,
        token:`deck-token-${editors.length}`,
        editorToken:`editor-token-${editors.length}`,
        session:{ sessionId:`editor-session-${editors.length}` },
        close:async () => { runtime.closed = true; },
      };
      editors.push(runtime);
      return runtime;
    },
  });
  t.after(() => app.close());

  for (const deckPath of deckPaths) {
    const selected = await post(app, '/api/choose-deck').then(response => response.json());
    assert.equal(selected.deckName, basename(deckPath));
    await postJson(app, '/api/open-deck', {
      candidateNonce:selected.candidateNonce,
      selectionRevision:selected.selectionRevision,
      provider:'codex',
    });
    await postJson(app, '/api/leave-workspace', { destination:'editing' });
  }
  assert.equal(editors.length, 2);
  assert.equal(editors.some(runtime => runtime.closed), false);
  const history = await fetch(
    `${app.url}/api/work-history?token=${encodeURIComponent(app.token)}`,
  ).then(response => response.json());
  assert.equal(history.editing.filter(entry => entry.runtimeState === 'background').length, 2);

  const resumed = await postJson(app, '/api/resume-deck', { deckPath:deckPaths[0] })
    .then(response => response.json());
  assert.equal(resumed.runtimeReused, true);
  assert.equal(editors.length, 2);
  assert.equal(app.state, 'selected');

  await app.close();
  assert.equal(editors.every(runtime => runtime.closed), true);
});

test('同一目录中的多个新建 Deck Draft 各自保持 Agent 运行时', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-multi-creation-runtime-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const recentDeckStore = createRecentDeckStore({
    filePath:join(projectRoot, 'recent-decks.json'),
  });
  const workHistoryStore = createWorkHistoryStore({
    filePath:join(projectRoot, 'recent-work.json'),
    discoveryRoots:[projectRoot],
    recentDeckStore,
  });
  const terminals = [];
  const app = await startAppServer({
    token:'multi-creation-runtime-secret',
    recentDeckStore,
    workHistoryStore,
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => {
      const terminal = new FakeTerminal(options);
      terminal.runtimeId = `creation-runtime-${terminals.length + 1}`;
      terminals.push(terminal);
      return terminal;
    },
  });
  t.after(() => app.close());
  const draftIds = [];
  for (let index = 0; index < 2; index += 1) {
    const selected = await post(app, '/api/choose-creation-project').then(response => response.json());
    const created = await postJson(app, '/api/creation-drafts', {
      candidateNonce:selected.candidateNonce,
      selectionRevision:selected.selectionRevision,
      provider:'codex',
    }).then(response => response.json());
    draftIds.push(created.draft.draftId);
    await postJson(app, '/api/leave-workspace', { destination:'creation' });
  }
  assert.equal(new Set(draftIds).size, 2);
  assert.equal(terminals.length, 2);
  assert.equal(terminals.some(terminal => terminal.closed), false);
  const history = await fetch(
    `${app.url}/api/work-history?token=${encodeURIComponent(app.token)}`,
  ).then(response => response.json());
  assert.equal(history.creation.filter(entry => entry.runtimeState === 'background').length, 2);

  const firstCapability = JSON.parse(await readFile(
    terminals[0].options.environment.HUAWEI_DECK_CREATION_CAPABILITY_FILE,
    'utf8',
  ));
  const backgroundUpdate = await fetch(`${app.url}/api/creation-draft/commands`, {
    method:'POST',
    headers:{
      authorization:`Bearer ${firstCapability.token}`,
      'content-type':'application/json',
    },
    body:JSON.stringify({
      type:'update-brief',
      expectedRevision:0,
      patch:{
        title:'后台任务一', audience:'研发团队', durationMinutes:20, objective:'后台继续执行',
      },
    }),
  });
  assert.equal(backgroundUpdate.status, 200, '后台 Agent capability 必须路由到原 Draft');

  const resumed = await postJson(app, '/api/resume-creation-draft', {
    projectRoot,
    draftId:draftIds[0],
  }).then(response => response.json());
  assert.equal(resumed.runtimeReused, true);
  assert.equal(resumed.terminal.runtimeId, 'creation-runtime-1');
  assert.equal(resumed.draft.brief.title, '后台任务一');
  assert.equal(terminals.length, 2);

  await app.close();
  assert.equal(terminals.every(terminal => terminal.closed), true);
});

test('返回首页会废弃旧候选，并允许在两个入口之间重新选择', async t => {
  const app = await startAppServer({
    token:'app-reset-secret',
    pickDeck:async () => '/tmp/reset-deck.html',
    pickAgentProjectDirectory:async () => '/tmp/reset-creation-project',
    resolveAgentProject:async () => ({
      path:'/tmp/reset-existing-project', source:'workspace-marker',
      needsConfirmation:false, warning:null,
      identity:{
        originalPath:'/tmp/reset-existing-project', realPath:'/tmp/reset-existing-project',
        dev:'1', ino:'2',
      },
    }),
    resolveCreationProject:async () => ({
      path:'/tmp/reset-creation-project', source:'explicit',
      needsConfirmation:false, warning:null,
      identity:{
        originalPath:'/tmp/reset-creation-project', realPath:'/tmp/reset-creation-project',
        dev:'1', ino:'3',
      },
    }),
    startEditor:async () => assert.fail('旧候选不得打开 Editor'),
  });
  t.after(() => app.close());

  const existing = await post(app, '/api/choose-deck').then(response => response.json());
  assert.equal(existing.status, 'deck-selected');
  assert.equal((await post(app, '/api/reset-selection')).status, 200);
  assert.equal(app.state, 'idle');
  const staleOpen = await postJson(app, '/api/open-deck', {
    candidateNonce:existing.candidateNonce,
    selectionRevision:existing.selectionRevision,
    provider:'codex',
  });
  assert.equal(staleOpen.status, 409);
  assert.equal((await staleOpen.json()).code, 'STALE_DECK_CANDIDATE');

  const creation = await post(app, '/api/choose-creation-project')
    .then(response => response.json());
  assert.equal(creation.status, 'creation-project-selected');
  assert.equal((await post(app, '/api/reset-selection')).status, 200);
  assert.equal(app.state, 'idle');
  assert.equal(
    (await post(app, '/api/choose-deck').then(response => response.json())).status,
    'deck-selected',
  );
});

test('启动页返回最近修改 Deck，快捷加载仍经过项目目录确认', async t => {
  const deckPath = '/tmp/recent-deck.html';
  let recorded = null;
  const recentDeckStore = {
    async list() {
      return [{
        deckPath, deckName:'recent-deck.html', directory:'/tmp',
        modifiedAt:'2026-08-10T12:00:00.000Z', lastOpenedAt:'2026-08-10T11:00:00.000Z',
        provider:'codex',
      }];
    },
    async resolve(value) { return value === deckPath ? deckPath : null; },
    async record(value) { recorded = value; },
  };
  const app = await startAppServer({
    token:'recent-secret',
    recentDeckStore,
    resolveAgentProject:async () => ({
      path:'/tmp/recent-project', source:'persisted', needsConfirmation:false, warning:null,
      identity:{ originalPath:'/tmp/recent-project', realPath:'/tmp/recent-project', dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async () => ({
      url:'http://127.0.0.1:45680', token:'deck-token', editorToken:'editor-token',
      close:async () => {},
    }),
  });
  t.after(() => app.close());

  const recent = await fetch(`${app.url}/api/recent-decks?token=${app.token}`).then(response => response.json());
  assert.equal(recent.decks[0].deckPath, deckPath);
  const selected = await postJson(app, '/api/choose-recent-deck', { deckPath })
    .then(response => response.json());
  assert.equal(selected.status, 'deck-selected');
  assert.equal(selected.projectRoot.path, '/tmp/recent-project');
  assert.equal(app.state, 'deck-selected');

  const opened = await postJson(app, '/api/open-deck', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'claude-code',
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(recorded, { deckPath, provider:'claude-code' });
});

test('可继续任务接口同时返回 Creation Draft 与修改 Deck', async t => {
  const history = {
    version:1,
    creation:[{
      kind:'creation', draftId:'draft-history', taskId:'draft-history',
      projectRoot:'/tmp/project', title:'历史新建任务', progress:'大纲已确认',
      provider:'codex', updatedAt:'2026-08-11T12:00:00.000Z',
    }],
    editing:[{
      deckPath:'/tmp/history.html', deckName:'history.html', directory:'/tmp',
      progress:'2 项待处理', provider:'claude-code', modifiedAt:'2026-08-11T13:00:00.000Z',
    }],
  };
  const app = await startAppServer({
    token:'work-history-secret',
    workHistoryStore:{ async list() { return history; } },
  });
  t.after(() => app.close());
  const result = await fetch(`${app.url}/api/work-history?token=${app.token}`).then(
    response => response.json(),
  );
  assert.equal(result.creation[0].title, '历史新建任务');
  assert.equal(result.editing[0].progress, '2 项待处理');
});

test('工作项名称通过 WorkCatalog 修改并立即反映到启动页历史', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-app-work-name-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const workCatalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory:{
      async list() {
        return {
          version:1,
          editing:[],
          creation:[{
            kind:'creation',
            draftId:'draft-name',
            projectRoot:root,
            title:'未命名 Deck',
            progress:'需求沟通中',
            provider:'codex',
            updatedAt:'2026-08-16T09:00:00.000Z',
          }],
        };
      },
    },
    randomUUID:() => '44444444-4444-4444-8444-444444444444',
  });
  const app = await startAppServer({
    token:'work-name-secret',
    workCatalog,
  });
  t.after(() => app.close());

  const initial = await fetch(app.url + '/api/work-history?token=' + app.token)
    .then(response => response.json());
  const workItem = initial.creation[0];
  const response = await postJson(app, '/api/work-items/rename', {
    workId:workItem.workId,
    expectedRevision:workItem.revision,
    displayName:'客户评审版',
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).workItem.displayName, '客户评审版');

  const refreshed = await fetch(app.url + '/api/work-history?token=' + app.token)
    .then(result => result.json());
  assert.equal(refreshed.creation[0].title, '客户评审版');
});

test('启动页重新绑定入口只使用系统选择器结果并保持稳定工作项身份', async t => {
  const workId = '123e4567-e89b-42d3-a456-426614174000';
  const deckId = '223e4567-e89b-42d3-a456-426614174000';
  const oldPath = '/tmp/old-name.html';
  const newPath = '/tmp/new-name.html';
  const current = {
    kind:'editing', workId, deckId, deckPath:oldPath,
    binding:{ revision:3, state:'needs-rebind', reason:'missing' },
  };
  let rebindInput = null;
  const app = await startAppServer({
    token:'home-rebind-secret',
    pickDeck:async () => newPath,
    workCatalog:{
      async list() { return { version:2, revision:1, creation:[], editing:[current] }; },
      async resolve(value) { assert.equal(value, workId); return current; },
      async rebindEditing(input) {
        rebindInput = input;
        return {
          ...current, deckPath:newPath,
          binding:{ revision:4, state:'bound', reason:'manual-rebound' },
        };
      },
    },
  });
  t.after(() => app.close());

  const response = await postJson(app, '/api/work-items/choose-rebind-file', { workId });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'rebound');
  assert.equal(result.workItem.workId, workId);
  assert.deepEqual(rebindInput, {
    workId,
    candidatePath:newPath,
    confirmation:'same-file',
    expectedBindingRevision:3,
  });
});

test('Editor 关闭期间 Deck 改名后按 workId 恢复到新路径', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-app-rebind-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const oldPath = join(root, 'before.html');
  const newPath = join(root, 'after.html');
  await writeFile(oldPath, '<!doctype html><title>Rebind</title>');
  const workHistoryStore = {
    async list() {
      return {
        version:1,
        creation:[],
        editing:[{
          deckPath:oldPath, deckName:'before.html', directory:root,
          projectRoot:root, provider:'codex', modifiedAt:'2026-08-16T10:00:00.000Z',
        }],
      };
    },
    async resolveDeck() { return oldPath; },
    async recordDeck() {},
  };
  const workCatalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'), legacyHistory:workHistoryStore,
  });
  const original = (await workCatalog.list()).editing[0];
  await rename(oldPath, newPath);
  let startedPath = null;
  let app;
  app = await startAppServer({
    token:'resume-rebound-deck-secret',
    workHistoryStore,
    workCatalog,
    resolveAgentProject:async ({ deckPath }) => ({
      path:root, source:'persisted', needsConfirmation:false, warning:null,
      identity:{ originalPath:root, realPath:root, dev:'1', ino:'2' },
      deckPath,
    }),
    assertAgentProject:async () => {},
    startEditor:async options => {
      startedPath = options.deckPath;
      return {
        url:app.url, token:'deck-token', editorToken:'editor-token', close:async () => {},
      };
    },
  });
  t.after(() => app.close());

  const httpResponse = await postJson(app, '/api/resume-deck', { workId:original.workId });
  const response = await httpResponse.json();

  assert.equal(httpResponse.status, 200, JSON.stringify(response));
  assert.equal(response.status, 'selected');
  assert.equal(startedPath, await realpath(newPath));
});

test('首页可以删除 Creation 与修改 Deck 的历史记录，但不操作内容文件', async t => {
  const removed = [];
  const workHistoryStore = {
    async list() { return { version:1, creation:[], editing:[] }; },
    async dismissCreation(value) { removed.push({ kind:'creation', ...value }); },
    async dismissDeck(deckPath) { removed.push({ kind:'editing', deckPath }); },
  };
  const app = await startAppServer({ token:'dismiss-history-secret', workHistoryStore });
  t.after(() => app.close());

  const creation = await postJson(app, '/api/work-history/dismiss', {
    kind:'creation', projectRoot:'/tmp/project', draftId:'draft-1',
  });
  assert.equal(creation.status, 200);
  const editing = await postJson(app, '/api/work-history/dismiss', {
    kind:'editing', deckPath:'/tmp/deck.html',
  });
  assert.equal(editing.status, 200);
  assert.deepEqual(removed, [
    { kind:'creation', projectRoot:'/tmp/project', draftId:'draft-1' },
    { kind:'editing', deckPath:'/tmp/deck.html' },
  ]);
});

test('点击历史 Creation Draft 直接恢复原 Draft 工作区', async t => {
  const snapshot = {
    version:1, draftId:'draft-resume', revision:4, phase:'outline', provider:'codex',
    projectRoot:'/tmp/resume-project', brief:{ title:'恢复中的 Deck' },
  };
  let opened = null;
  const workspace = {
    capabilityToken:'resume-token', capabilityPath:'/tmp/resume-project/capability.json',
    draftDir:null, draftId:'draft-resume',
    snapshot:() => structuredClone(snapshot),
    templates:() => ({ version:1, templates:[] }),
    subscribe:() => () => {}, attachTerminal() {}, close:async () => {},
  };
  const workHistoryStore = {
    async list() { return { version:1, creation:[], editing:[] }; },
    async resolveCreation(value) {
      return value.draftId === 'draft-resume'
        ? { ...snapshot, title:'恢复中的 Deck' } : null;
    },
    async recordCreation() {},
  };
  const app = await startAppServer({
    token:'resume-creation-secret',
    workHistoryStore,
    resolveCreationProject:async ({ selectedPath }) => ({
      path:selectedPath, source:'explicit', needsConfirmation:false, warning:null,
      identity:{ originalPath:selectedPath, realPath:selectedPath, dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    openCreationWorkspace:async options => { opened = options; return workspace; },
    createAgentTerminal:options => new FakeTerminal(options),
  });
  t.after(() => app.close());
  const response = await postJson(app, '/api/resume-creation-draft', {
    projectRoot:'/tmp/resume-project', draftId:'draft-resume',
  });
  assert.equal(response.status, 200);
  const resumed = await response.json();
  assert.equal(resumed.status, 'building');
  assert.equal(resumed.draft.revision, 4);
  assert.equal(opened.draftId, 'draft-resume');
  assert.equal(app.state, 'building');
});

test('点击最近修改任务在目录可信时一步恢复并复用前台编辑器', async t => {
  const deckPath = '/tmp/resume-edit.html';
  let startOptions = null;
  let startCount = 0;
  const workHistoryStore = {
    async resolveDeck(value) { return value === deckPath ? deckPath : null; },
    async list() {
      return { version:1, creation:[], editing:[{
        deckPath, provider:'claude-code', projectRoot:'/tmp/resume-project',
      }] };
    },
    async recordDeck() {},
  };
  const app = await startAppServer({
    token:'resume-edit-secret',
    workHistoryStore,
    resolveAgentProject:async ({ persistedRoot }) => ({
      path:persistedRoot, source:'persisted', needsConfirmation:false, warning:null,
      identity:{ originalPath:persistedRoot, realPath:persistedRoot, dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async options => {
      startCount += 1;
      startOptions = options;
      return {
        url:'http://127.0.0.1:45681', token:'deck-token', editorToken:'editor-token',
        close:async () => {},
      };
    },
  });
  t.after(() => app.close());
  const response = await postJson(app, '/api/resume-deck', { deckPath });
  assert.equal(response.status, 200);
  const resumed = await response.json();
  assert.equal(resumed.status, 'selected');
  assert.equal(resumed.resumed, true);
  assert.equal(startOptions.agentProvider, 'claude-code');
  assert.equal(startOptions.agentProjectRoot, '/tmp/resume-project');

  const connectedResponse = await postJson(app, '/api/client-connected', {
    clientId:'reopened-launcher', sequence:1,
  });
  assert.equal(connectedResponse.status, 200, await connectedResponse.clone().text());
  const connected = await connectedResponse.json();
  assert.equal(connected.status, 'selected');
  assert.equal(connected.editorUrl, resumed.editorUrl);

  const reopenedResponse = await postJson(app, '/api/resume-deck', { deckPath });
  assert.equal(reopenedResponse.status, 200, await reopenedResponse.clone().text());
  const reopened = await reopenedResponse.json();
  assert.equal(reopened.status, 'selected');
  assert.equal(reopened.runtimeReused, true);
  assert.equal(startCount, 1, '重新打开已在前台的 Deck 不得重复启动 Editor');
});

test('陈旧 nonce、伪造 provider 和未确认的过宽目录都被拒绝', async t => {
  const app = await startAppServer({
    token:'app-secret',
    pickDeck:async () => '/tmp/deck.html',
    resolveAgentProject:async () => ({
      path:'/tmp', source:'deck-directory', needsConfirmation:true,
      warning:'目录范围过宽',
      identity:{ originalPath:'/tmp', realPath:'/tmp', dev:'1', ino:'2' },
    }),
    assertAgentProject:async project => project.path,
    startEditor:async () => assert.fail('校验失败时不得启动 Editor'),
  });
  t.after(() => app.close());
  const selected = await post(app, '/api/choose-deck').then(response => response.json());

  assert.equal((await postJson(app, '/api/open-deck', {
    candidateNonce:'forged', selectionRevision:selected.selectionRevision, provider:'codex',
  })).status, 409);
  assert.equal((await postJson(app, '/api/open-deck', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'other', confirmProjectRoot:true,
  })).status, 400);
  const unconfirmed = await postJson(app, '/api/open-deck', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  });
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).code, 'PROJECT_ROOT_CONFIRMATION_REQUIRED');
});

test('项目选择器取消保留 Deck 候选，更改后使用服务器端路径', async t => {
  let pickProjectCount = 0;
  const app = await startAppServer({
    token:'app-secret',
    pickDeck:async () => '/tmp/deck.html',
    pickAgentProjectDirectory:async () => {
      pickProjectCount += 1;
      return pickProjectCount === 1 ? null : '/tmp/chosen-project';
    },
    resolveAgentProject:async ({ explicitRoot }) => ({
      path:explicitRoot ?? '/tmp/default-project',
      source:explicitRoot ? 'explicit' : 'deck-directory',
      needsConfirmation:false,
      warning:null,
      identity:{
        originalPath:explicitRoot ?? '/tmp/default-project',
        realPath:explicitRoot ?? '/tmp/default-project', dev:'1', ino:'2',
      },
    }),
  });
  t.after(() => app.close());
  const selected = await post(app, '/api/choose-deck').then(response => response.json());
  const request = body => postJson(app, '/api/choose-agent-project', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    ...body,
  }).then(response => response.json());
  assert.equal((await request({})).status, 'cancelled');
  assert.equal(app.state, 'deck-selected');
  const changed = await request({});
  assert.equal(changed.status, 'project-selected');
  assert.equal(changed.projectRoot.path, '/tmp/chosen-project');
});

class FakeTerminal {
  constructor(options) {
    this.options = options;
    this.runtimeId = 'terminal-runtime-1';
    this.closed = false;
    this.state = 'stopped';
  }
  snapshot() {
    return {
      runtimeId:this.runtimeId, provider:this.options.provider, state:this.state,
      projectRoot:this.options.projectRoot,
    };
  }
  async start() { this.state = 'running'; this.options.onStateChange?.(this.snapshot()); }
  attach(socket) { socket.send(JSON.stringify({ type:'snapshot', terminal:this.snapshot(), output:'' })); return () => {}; }
  input() {}
  resize() {}
  async restart() { this.state = 'running'; }
  async close() { this.closed = true; this.state = 'closed'; }
}

test('Creation 预览回退接口优先读取工作区声明的最终 Deck', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-published-preview-'));
  const publishedDeck = join(projectRoot, 'published.html');
  const staleStagingDeck = join(projectRoot, 'staging.html');
  await Promise.all([
    writeFile(publishedDeck, '<!doctype html><title>最终版本一</title>'),
    writeFile(staleStagingDeck, '<!doctype html><title>旧 staging</title>'),
  ]);
  const snapshot = {
    version:1, draftId:'published-preview', revision:9, phase:'ready', provider:'codex',
    projectRoot, brief:{ title:'最终预览' },
    generation:{ status:'published', publishedDeck, fingerprint:'published-v1' },
    milestones:{ deck:{ complete:true, state:'complete' } },
    previewDeck:{ path:publishedDeck, revision:'published-v1', status:'published' },
  };
  const workspace = {
    capabilityToken:'preview-token', capabilityPath:join(projectRoot, 'capability.json'),
    draftDir:projectRoot, draftId:'published-preview',
    snapshot:() => structuredClone(snapshot),
    previewDeckPath:() => staleStagingDeck,
    templates:() => ({ version:1, templates:[] }),
    subscribe:() => () => {}, attachTerminal:async () => {}, close:async () => {},
  };
  const app = await startAppServer({
    token:'published-preview-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createCreationWorkspace:async () => workspace,
    createAgentTerminal:options => new FakeTerminal(options),
  });
  t.after(async () => {
    await app.close();
    await rm(projectRoot, { recursive:true, force:true });
  });
  const selected = await post(app, '/api/choose-creation-project').then(response => response.json());
  const created = await postJson(app, '/api/creation-drafts', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  });
  assert.equal(created.status, 201, await created.clone().text());

  const previewUrl = `${app.url}/creation-deck-preview?token=${encodeURIComponent(app.token)}`;
  assert.match(await fetch(previewUrl).then(response => response.text()), /最终版本一/);
  assert.doesNotMatch(await fetch(previewUrl).then(response => response.text()), /旧 staging/);
});

test('新建入口选择项目后创建持久 Draft，并通过统一命令更新需求', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-app-create-'));
  let terminal;
  const app = await startAppServer({
    token:'app-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => (terminal = new FakeTerminal(options)),
  });
  t.after(async () => {
    await app.close();
    await rm(projectRoot, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const selected = await post(app, '/api/choose-creation-project').then(response => response.json());
  assert.equal(selected.status, 'creation-project-selected');
  const created = await postJson(app, '/api/creation-drafts', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  }).then(response => response.json());
  assert.equal(created.status, 'building');
  assert.equal(created.draft.phase, 'brief');
  assert.equal(terminal.options.environment.HUAWEI_DECK_CREATION_URL, app.url);
  assert.match(terminal.options.environment.HUAWEI_DECK_CREATION_CAPABILITY_FILE, /agent-capability\.json$/);

  const updated = await postJson(app, '/api/creation-draft/commands', {
    type:'update-brief', expectedRevision:0,
    patch:{ title:'新建流程', audience:'研发团队', durationMinutes:30, objective:'完成初版 Deck' },
  }).then(response => response.json());
  assert.equal(updated.snapshot.brief.title, '新建流程');
  const restored = await fetch(`${app.url}/api/creation-draft?token=${encodeURIComponent(app.token)}`)
    .then(response => response.json());
  assert.equal(restored.revision, 1);
  assert.equal(app.state, 'building');
});

test('新建 Deck 对话页切换项目时保留 Agent 运行时并在返回时直接复用', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-creation-navigation-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  let terminal;
  const app = await startAppServer({
    token:'creation-navigation-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    createAgentTerminal:options => (terminal = new FakeTerminal(options)),
  });
  t.after(() => app.close());
  const selected = await post(app, '/api/choose-creation-project').then(response => response.json());
  const created = await postJson(app, '/api/creation-drafts', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  }).then(response => response.json());

  const left = await postJson(app, '/api/leave-workspace', { destination:'creation' });
  assert.equal(left.status, 200);
  assert.equal(terminal.closed, false);
  assert.equal(app.state, 'idle');
  const history = await fetch(
    `${app.url}/api/work-history?token=${encodeURIComponent(app.token)}`,
  ).then(response => response.json());
  const background = history.creation.find(entry => entry.draftId === created.draft.draftId);
  assert.equal(background.runtimeState, 'background');
  assert.equal(background.locked, false);
  const resumed = await postJson(app, '/api/resume-creation-draft', {
    projectRoot,
    draftId:created.draft.draftId,
  }).then(response => response.json());
  assert.equal(resumed.runtimeReused, true);
  assert.equal(resumed.terminal.runtimeId, terminal.runtimeId);
  assert.equal(terminal.closed, false);
  await app.close();
  assert.equal(terminal.closed, true);
});

test('Creation Draft 页面关闭后回收孤儿服务并释放工作区', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-app-client-close-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  let workspaceClosed = false;
  const workspace = {
    capabilityToken:'creation-token', capabilityPath:join(projectRoot, 'capability.json'),
    draftDir:null, draftId:'draft-client-close',
    snapshot:() => ({
      version:1, draftId:'draft-client-close', revision:0, phase:'brief',
      provider:'codex', projectRoot, brief:{ title:'' },
    }),
    templates:() => ({ version:1, templates:[] }),
    subscribe:() => () => {}, attachTerminal() {},
    close:async () => { workspaceClosed = true; },
  };
  const app = await startAppServer({
    token:'client-close-secret',
    creationClientCloseGraceMs:20,
    pickAgentProjectDirectory:async () => projectRoot,
    createCreationWorkspace:async () => workspace,
    createAgentTerminal:options => new FakeTerminal(options),
  });
  t.after(() => app.close());
  const selected = await post(app, '/api/choose-creation-project').then(response => response.json());
  const created = await postJson(app, '/api/creation-drafts', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  });
  assert.equal(created.status, 201, await created.clone().text());
  const eventsUrl = new URL('/creation-events', app.url);
  eventsUrl.protocol = 'ws:';
  eventsUrl.searchParams.set('token', app.token);
  eventsUrl.searchParams.set('editorToken', app.token);
  const socket = new WebSocket(eventsUrl);
  await new Promise((resolvePromise, reject) => {
    socket.once('open', resolvePromise);
    socket.once('error', reject);
  });
  socket.close();
  const deadline = Date.now() + 1_000;
  while (!workspaceClosed && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.equal(workspaceClosed, true);
  assert.equal(app.state, 'closed');
});

test('Creation Draft 页面尚未连上事件通道就关闭时也回收孤儿服务', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-app-never-connected-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  let workspaceClosed = false;
  const workspace = {
    capabilityToken:'creation-token', capabilityPath:join(projectRoot, 'capability.json'),
    draftDir:null, draftId:'draft-never-connected',
    snapshot:() => ({
      version:1, draftId:'draft-never-connected', revision:0, phase:'brief',
      provider:'codex', projectRoot, brief:{ title:'' },
    }),
    templates:() => ({ version:1, templates:[] }),
    subscribe:() => () => {}, attachTerminal() {},
    close:async () => { workspaceClosed = true; },
  };
  let terminal;
  const app = await startAppServer({
    token:'never-connected-secret',
    creationClientCloseGraceMs:20,
    pickAgentProjectDirectory:async () => projectRoot,
    createCreationWorkspace:async () => workspace,
    createAgentTerminal:options => (terminal = new FakeTerminal(options)),
  });
  t.after(() => app.close());

  const selection = await post(app, '/api/choose-creation-project').then(response => response.json());
  const created = await postJson(app, '/api/creation-drafts', {
    candidateNonce:selection.candidateNonce,
    selectionRevision:selection.selectionRevision,
    provider:'codex',
  }).then(response => response.json());
  assert.equal(created.status, 'building');

  const deadline = Date.now() + 1_000;
  while (!workspaceClosed && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.equal(workspaceClosed, true);
  assert.equal(terminal.closed, true);
  assert.equal(app.state, 'closed');
});

test('生成成功后 Editor 接收同一个 PTY runtime，交接请求保持幂等', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'deck-app-handoff-'));
  t.after(() => rm(projectRoot, { recursive:true, force:true }));
  const draft = {
    version:1, draftId:'draft-ready', revision:9, phase:'ready', provider:'codex',
    projectRoot,
    brief:{ title:'继承设计上下文', materials:'原始架构图与访谈纪要' },
    outline:{ sections:[{ chapterId:'one', title:'背景' }] },
    pagePlan:{ pages:[{ pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面' }] },
    generation:{ status:'published', publishedDeck:join(projectRoot, 'new.html') },
  };
  let workspaceClosed = false;
  let handoffCount = 0;
  const finalEditor = {
    url:'http://127.0.0.1:45679', token:'deck-token', editorToken:'editor-token',
    session:{ sessionId:'final-editor-session' },
    close:async () => {},
  };
  const workspace = {
    capabilityToken:'creation-token', capabilityPath:join(projectRoot, 'capability.json'),
    draftId:'draft-ready',
    draftDir:join(projectRoot, '.huawei-deck-editor', 'drafts', 'draft-ready'),
    snapshot:() => structuredClone(draft),
    templates:() => ({ version:1, templates:[] }),
    subscribe:() => () => {},
    attachTerminal(value) { this.terminal = value; },
    dispatch:async () => ({ snapshot:structuredClone(draft) }),
    takePublishedEditor() { handoffCount += 1; return finalEditor; },
    close:async () => { workspaceClosed = true; },
  };
  let terminal;
  let startCount = 0;
  const app = await startAppServer({
    token:'app-secret',
    pickAgentProjectDirectory:async () => projectRoot,
    resolveCreationProject:async () => ({
      path:projectRoot, source:'explicit', needsConfirmation:false, warning:null,
      identity:{ originalPath:projectRoot, realPath:projectRoot, dev:'1', ino:'2' },
    }),
    assertAgentProject:async () => projectRoot,
    createCreationWorkspace:async () => workspace,
    createAgentTerminal:options => (terminal = new FakeTerminal(options)),
    startEditor:async () => {
      startCount += 1;
      throw new Error('切换页面不得再次启动 Editor');
    },
  });
  t.after(() => app.close());
  const selected = await post(app, '/api/choose-creation-project').then(response => response.json());
  const created = await postJson(app, '/api/creation-drafts', {
    candidateNonce:selected.candidateNonce,
    selectionRevision:selected.selectionRevision,
    provider:'codex',
  });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal((await created.json()).draft.phase, 'ready');
  const opened = await postJson(app, '/api/creation-draft/open-editor', {});
  assert.equal(opened.status, 200, await opened.clone().text());
  const result = await opened.json();
  assert.match(result.editorUrl, /editorToken=editor-token/);
  assert.equal(app.editorApp, finalEditor);
  assert.equal(handoffCount, 1);
  assert.equal(terminal.snapshot().runtimeId, 'terminal-runtime-1');
  assert.equal(terminal.closed, false);
  assert.equal(workspaceClosed, true);
  assert.equal(startCount, 0);
  const reopened = await postJson(app, '/api/creation-draft/open-editor', {});
  assert.equal(reopened.status, 200, await reopened.clone().text());
  assert.equal((await reopened.json()).editorUrl, result.editorUrl);
  assert.equal(handoffCount, 1);
});
