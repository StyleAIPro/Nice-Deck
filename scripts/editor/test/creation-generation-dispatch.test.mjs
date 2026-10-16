import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { startAppServer } from '../app-server.mjs';
import { DeckCreationWorkspace } from '../deck-creation-workspace.mjs';
import { createRecentDeckStore } from '../recent-deck-store.mjs';
import { createWorkHistoryStore } from '../work-history-store.mjs';
import { WorkCatalog } from '../work-catalog.mjs';

// 使用真实 CLI、HTTP 鉴权、Draft 持久化和 DSH Relay；只替换耗时的制版与渲染验证。
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ppt-generation-dispatch-'));
  const recentDeckStore = createRecentDeckStore({ filePath:join(root, 'recent.json'), discoveryRoots:[] });
  const workHistoryStore = createWorkHistoryStore({
    filePath:join(root, 'history.json'), discoveryRoots:[], recentDeckStore,
  });
  const workCatalog = new WorkCatalog({ filePath:join(root, 'catalog.json'), legacyHistory:workHistoryStore });
  let workspace;
  let prepares = 0;
  let failVerification = false;
  const app = await startAppServer({
    embeddedMode:'dsh', recentDeckStore, workHistoryStore, workCatalog,
    pickAgentProjectDirectory:async () => root,
    createCreationWorkspace:async options => {
      workspace = await DeckCreationWorkspace.create({
        ...options, openManagedDeck:null,
        catalog:{ resolve:() => null, snapshot:() => ({ version:2, templates:[] }) },
      });
      workspace.factory = {
        async prepare(snapshot) {
          prepares += 1;
          const stagingDeck = `staging/${snapshot.generation.runId}.html`;
          await mkdir(join(workspace.draftDir, 'staging'), { recursive:true });
          await writeFile(join(workspace.draftDir, stagingDeck), '<!doctype html><title>测试初稿</title>');
          return { stagingDeck, stagingPlan:'staging/plan.md', stagingTocContract:'staging/toc.json', stagingPagePlanContract:'staging/pages.json' };
        },
        async verify() {
          if (failVerification) throw new Error('测试验证失败');
          return { diagnostics:[{ check:'测试验证器', ok:true }] };
        },
        async publish(snapshot) {
          const publishedDeck = join(root, 'published.html');
          await copyFile(snapshot.generation.stagingDeckPath, publishedDeck);
          return { publishedDeck };
        },
      };
      return workspace;
    },
  });
  let socket;
  t.after(async () => {
    socket?.terminate();
    await app.close();
    await rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  });
  const post = async (path, body = {}) => {
    const response = await fetch(`${app.url}${path}?token=${encodeURIComponent(app.token)}`, {
      method:'POST', headers:{ origin:app.url, 'content-type':'application/json' }, body:JSON.stringify(body),
    });
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  };
  const selected = await post('/api/choose-creation-project');
  const created = await post('/api/creation-drafts', {
    candidateNonce:selected.candidateNonce, selectionRevision:selected.selectionRevision, provider:'codex',
  });
  const operationId = '51111111-1111-4111-8111-111111111111';
  await post('/api/dsh-work-items/begin-session', {
    workId:created.workItem.workId, operationId, workspaceId:'workspace-test', sessionId:'session-test',
    origin:'fresh', expectedBindingRevision:0,
  });
  const completed = await post('/api/dsh-work-items/complete-session', { workId:created.workItem.workId, operationId });
  await post('/api/dsh-work-items/activate-session', {
    workId:created.workItem.workId, sessionId:'session-test', expectedBindingRevision:completed.workItem.dshBinding.revision,
  });
  const queued = [];
  socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/creation-events?token=${encodeURIComponent(app.token)}&editorToken=${encodeURIComponent(app.token)}`, { origin:app.url });
  socket.on('message', bytes => {
    const event = JSON.parse(String(bytes));
    if (event.type !== 'dsh-creation-request') return;
    queued.push(event.payload);
    app.creationTerminal.acknowledge({ requestId:event.payload.requestId, accepted:true });
  });
  await once(socket, 'open');
  for (const command of [
    { type:'update-brief', patch:{ title:'初稿', audience:'研发', durationMinutes:20, objective:'演示' } },
    { type:'confirm-brief' },
    { type:'propose-outline', outline:{ sections:[{ chapterId:'one', title:'第一章', objective:'讲清楚', pageBudget:1, timeBudgetMinutes:20 }] } },
    { type:'confirm-outline' },
    { type:'propose-page-plan', pagePlan:{ pages:[{ pageId:'p1', chapterId:'one', pageTypeId:'cover', label:'封面', coreClaim:'核心观点', layoutRationale:'封面', artwork:'无', steps:0 }] } },
    { type:'confirm-page-plan' },
    { type:'set-output', output:{ fileName:'published.html', templateId:'tech-share', includePlan:true, trialPptx:false, autoOpenEditor:true } },
  ]) await workspace.dispatch({ ...command, expectedRevision:workspace.snapshot().revision });
  const cli = async type => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(AICO_PPT|HUAWEI_DECK)_CREATION_/.test(key)) delete env[key];
    const result = await promisify(execFile)(process.execPath, [
      resolve('scripts/editor/cli.mjs'), 'creation', type,
      '--capability-file', workspace.capabilityPath,
      '--expected-revision', String(workspace.snapshot().revision),
    ], { env });
    return JSON.parse(result.stdout);
  };
  return { workspace, queued, cli, post, prepares:() => prepares, failVerification:value => { failVerification = value; } };
}

test('Agent CLI 制作并发布初版后，没有下一轮自动制作消息', { timeout:15_000 }, async t => {
  const f = await fixture(t);
  const started = await f.cli('start-generation');
  const published = await f.cli('generation-ready');
  assert.equal(published.snapshot.generation.status, 'published');
  assert.equal(f.queued.length, 0, '当前 Agent 已发布初稿，不能再排队一条制作任务');
  assert.equal(started.continuation.mode, 'current-turn');
  assert.equal(started.continuation.runId, published.snapshot.generation.runId);
  assert.equal(started.continuation.draftId, published.snapshot.draftId);
  assert.match(started.continuation.instructions, /generation-ready/);
  assert.match(started.continuation.instructions, /staging/);
  assert.doesNotMatch(started.continuation.instructions, /必须完整读取并遵循/);
  assert.equal(f.prepares(), 1);
  assert.match(await readFile(published.snapshot.generation.publishedDeck, 'utf8'), /测试初稿/);
  const persisted = await readFile(join(f.workspace.draftDir, 'draft.json'), 'utf8');
  assert.doesNotMatch(persisted, /continuation|instructions/);
  await assert.rejects(f.cli('start-generation'), /CREATION_PUBLISHED/);
});

test('独立浏览器入口仍只向绑定会话提交一次制作任务', { timeout:15_000 }, async t => {
  const f = await fixture(t);
  const started = await f.post('/api/creation-draft/commands', {
    type:'start-generation', expectedRevision:f.workspace.snapshot().revision,
    agentInitiated:true,
  });
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].sessionId, 'session-test');
  assert.match(f.queued[0].prompt, /页面规划已经由用户确认/);
  assert.equal(started.continuation, undefined);
});

test('制作中禁止再次启动；失败验证可原位恢复；显式重试也不追加消息', { timeout:15_000 }, async t => {
  const f = await fixture(t);
  const started = await f.cli('start-generation');
  await assert.rejects(f.cli('start-generation'), /GENERATION_ALREADY_STARTED/);
  assert.equal(f.prepares(), 1);
  assert.equal(f.workspace.snapshot().generation.runId, started.snapshot.generation.runId);
  f.failVerification(true);
  await assert.rejects(f.cli('generation-ready'), /测试验证失败/);
  await assert.rejects(f.cli('start-generation'), /GENERATION_ALREADY_STARTED/);
  const retried = await f.cli('retry-generation');
  assert.notEqual(retried.continuation.runId, started.continuation.runId);
  assert.equal(retried.continuation.mode, 'current-turn');
  await assert.rejects(f.cli('generation-ready'), /测试验证失败/);
  f.failVerification(false);
  const published = await f.cli('generation-ready');
  assert.equal(published.snapshot.generation.runId, retried.continuation.runId);
  assert.equal(f.prepares(), 2);
  assert.equal(f.queued.length, 0);
});

test('取消后明确重试在当前轮继续，保留新旧 run 的身份区别', { timeout:15_000 }, async t => {
  const f = await fixture(t);
  const started = await f.cli('start-generation');
  await f.cli('cancel-generation');
  await assert.rejects(f.cli('start-generation'), /GENERATION_ALREADY_STARTED/);
  const retried = await f.cli('retry-generation');
  assert.notEqual(retried.continuation.runId, started.continuation.runId);
  assert.equal(retried.continuation.draftId, started.continuation.draftId);
  await f.cli('generation-ready');
  assert.equal(f.prepares(), 2);
  assert.equal(f.queued.length, 0);
});

test('并发启动只有一个请求制版，不会创建第二份初稿或第二轮消息', { timeout:15_000 }, async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.cli('start-generation'), f.cli('start-generation')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.match(rejected.reason.stderr, /REVISION_CONFLICT/);
  await f.cli('generation-ready');
  assert.equal(f.prepares(), 1);
  assert.equal(f.queued.length, 0);
});

test('工作台切到首页后，后台 Agent 仍通过自身 capability 接续制作', { timeout:15_000 }, async t => {
  const f = await fixture(t);
  await f.post('/api/leave-workspace', { destination:'creation' });
  const started = await f.cli('start-generation');
  assert.equal(started.continuation.mode, 'current-turn');
  await f.cli('generation-ready');
  assert.equal(f.prepares(), 1);
  assert.equal(f.queued.length, 0);
});
