import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  AgentRunCoordinator, buildAgentPrompt, buildCodexInvocation, createCodexAdapter,
  createAgentRouter, createClaudeAdapter, manualAgentConnection, resolveAgentConnection,
} from '../agent-runner.mjs';

test('Deck 连接优先使用启动任务，并允许手动切回新任务', () => {
  const oldThreadId = '019fc842-816b-7413-bb23-10b0f87e1d4c';
  const launchThreadId = '019fc842-816b-7413-bb23-10b0f87e1d4d';
  const persistedConnection = {
    version:1, provider:'codex', threadId:oldThreadId,
    source:'created', updatedAt:'2026-08-04T00:00:00.000Z',
  };
  assert.equal(resolveAgentConnection({ persistedConnection }).threadId, oldThreadId);
  const launched = resolveAgentConnection({ persistedConnection, launchThreadId });
  assert.equal(launched.threadId, launchThreadId);
  assert.equal(launched.source, 'launch');
  assert.equal(manualAgentConnection({ threadId:null }).threadId, null);
  assert.throws(() => manualAgentConnection({ threadId:'not-a-thread' }), /规范 UUID/);
});

test('独立 Agent prompt 强制加载 huawei-deck，并限定批次和写回边界', () => {
  const prompt = buildAgentPrompt({
    deckPath:'/tmp/deck.html', serviceUrl:'http://127.0.0.1:1234',
    token:'secret', taskIds:['task-a'], sourceThreadId:null,
    loadSkill:true, skillRoot:'/skill',
  });
  assert.match(prompt, /^\$huawei-deck/m);
  assert.match(prompt, /完整读取 "\/skill\/SKILL\.md"/);
  assert.match(prompt, /只处理本批 ID/);
  assert.match(prompt, /不调用 write-deck/);

  const resumed = buildAgentPrompt({
    deckPath:'/tmp/deck.html', serviceUrl:'http://127.0.0.1:1234',
    token:'secret', taskIds:['task-b'], sourceThreadId:null,
    loadSkill:false, skillRoot:'/skill',
  });
  assert.doesNotMatch(resumed, /\$huawei-deck/);
  assert.doesNotMatch(resumed, /先完整读取/);
  assert.match(resumed, /不要再次完整读取 SKILL\.md/);
});

test('Codex 调用按来源任务选择 resume 或新会话', () => {
  const threadId = '019fc842-816b-7413-bb23-10b0f87e1d4c';
  assert.deepEqual(
    buildCodexInvocation({ deckPath:'/tmp/deck.html', sourceThreadId:threadId }),
    { mode:'resume', args:['exec', 'resume', '--json', threadId, '-'] },
  );
  const fresh = buildCodexInvocation({ deckPath:'/tmp/project/deck.html' });
  assert.equal(fresh.mode, 'new');
  assert.deepEqual(fresh.args.slice(-3), ['-C', '/tmp/project', '-']);
  assert.ok(fresh.args.includes('workspace-write'));
});

test('未绑定 Deck 只在首批新建任务，后续批次 resume 该专用任务', async () => {
  const threadId = '019fc842-816b-7413-bb23-10b0f87e1d4c';
  const calls = [];
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    calls.push(args);
    queueMicrotask(() => {
      const event = calls.length === 1
        ? { type:'thread.started', thread_id:threadId }
        : { type:'turn.completed' };
      child.stdout.write(`${JSON.stringify(event)}\n`);
      child.emit('close', 0, null);
    });
    return child;
  };
  const adapter = createCodexAdapter({ spawnProcess, timeoutMs:1_000 });
  const context = {
    deckPath:'/tmp/deck.html', serviceUrl:'http://127.0.0.1:1234',
    token:'secret', taskIds:['task-a'], signal:new AbortController().signal,
  };

  assert.equal((await adapter.run(context)).mode, 'new');
  assert.equal(adapter.mode, 'resume');
  assert.equal((await adapter.run({ ...context, taskIds:['task-b'] })).mode, 'resume');
  assert.deepEqual(calls[1], ['exec', 'resume', '--json', threadId, '-']);
});

test('Claude Code 续用所选会话，凭据不进入参数且首次补载 Skill', async () => {
  const sessionId = '019fc842-816b-7413-bb23-10b0f87e1d4c';
  let call;
  let prompt = '';
  const persisted = [];
  const spawnProcess = (command, args, options) => {
    call = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', chunk => { prompt += chunk; });
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type:'result', session_id:sessionId })}\n`);
      child.emit('close', 0, null);
    });
    return child;
  };
  const adapter = createClaudeAdapter({
    initialConnection:{
      version:1, provider:'claude-code', threadId:sessionId,
      source:'manual', skillStatus:'not-detected', updatedAt:null,
    },
    spawnProcess,
    timeoutMs:1_000,
    persistConnection:async connection => {
      persisted.push(connection);
      return { connection };
    },
  });

  await adapter.run({
    deckPath:'/tmp/deck.html', serviceUrl:'http://127.0.0.1:1234',
    token:'secret-token', taskIds:['task-a'], signal:new AbortController().signal,
  });

  assert.equal(call.command, 'claude');
  assert.deepEqual(call.args.slice(-2), ['--resume', sessionId]);
  assert.doesNotMatch(call.args.join(' '), /secret-token/);
  assert.equal(call.options.env.HUAWEI_DECK_EDITOR_TOKEN, 'secret-token');
  assert.match(prompt, /先完整读取 .*SKILL\.md/);
  assert.equal(persisted.at(-1).skillStatus, 'loaded');
});

test('新建项目会话使用项目 cwd、授予 Deck 目录并只做 Skill 初始化', async () => {
  const threadId = '019fc842-816b-7413-bb23-10b0f87e1d4c';
  let invocation;
  let prompt = '';
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', chunk => { prompt += chunk; });
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type:'thread.started', thread_id:threadId })}\n`);
      child.emit('close', 0, null);
    });
    return child;
  };
  const router = createAgentRouter({ spawnProcess, timeoutMs:1_000 });

  const result = await router.createSession(
    { provider:'codex', projectPath:'/tmp/new-agent-project' },
    { deckPath:'/tmp/decks/deck.html', serviceUrl:'http://127.0.0.1:1', token:'secret' },
  );

  assert.equal(invocation.options.cwd, '/tmp/new-agent-project');
  assert.ok(invocation.args.includes('/tmp/new-agent-project'));
  assert.deepEqual(invocation.args.slice(-3), ['--add-dir', '/tmp/decks', '-']);
  assert.match(prompt, /本轮只建立后续编辑上下文，不修改任何文件/);
  assert.doesNotMatch(prompt, /本批任务 ID/);
  assert.equal(result.connection.threadId, threadId);
  assert.equal(result.connection.projectPath, '/tmp/new-agent-project');
  assert.equal(result.connection.skillStatus, 'loaded');
});

test('调度器快照当前批次、拒绝并发，并发布完成状态', async () => {
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  const updates = [];
  const session = {
    revision:2,
    tasks:[{ id:'task-a', status:'pending' }, { id:'task-done', status:'completed' }],
  };
  const coordinator = new AgentRunCoordinator({
    provider:'codex',
    adapter:{ id:'codex', run:async () => { await completion; return { summary:'处理完成' }; } },
    getSession:() => session,
    getContext:() => ({ deckPath:'/tmp/deck.html' }),
    onUpdate:run => updates.push(run),
  });

  const started = coordinator.start({ expectedRevision:2, taskIds:['task-a'] });
  assert.equal(started.status, 'queued');
  assert.throws(
    () => coordinator.start({ expectedRevision:2, taskIds:['task-a'] }),
    error => error.code === 'AGENT_RUN_ACTIVE',
  );
  assert.throws(
    () => new AgentRunCoordinator({
      provider:'codex', adapter:{ id:'codex', run:async () => {} },
      getSession:() => session, getContext:() => ({}),
    }).start({ expectedRevision:2, taskIds:['task-done'] }),
    error => error.code === 'TASK_NOT_PENDING',
  );

  release();
  await coordinator.activePromise;
  assert.equal(coordinator.snapshot().status, 'succeeded');
  assert.equal(coordinator.snapshot().message, '处理完成');
  assert.ok(updates.some(run => run.status === 'running'));
  await coordinator.close();
});
