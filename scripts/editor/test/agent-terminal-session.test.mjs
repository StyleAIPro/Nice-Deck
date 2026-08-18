import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AgentTerminalSession,
  agentTerminalProviders,
  buildAgentTerminalCommand,
  resolveAgentTerminalExecutable,
} from '../agent-terminal-session.mjs';
import { buildAgentPrompt } from '../agent-runner.mjs';

class FakePty {
  constructor(executable, args, options) {
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pid = 4321;
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

class BoundedWritePty extends FakePty {
  constructor(executable, args, options, maxWriteBytes = 512) {
    super(executable, args, options);
    this.maxWriteBytes = maxWriteBytes;
    this.accepted = [];
  }

  write(data) {
    super.write(data);
    const encoded = Buffer.from(data, 'utf8');
    this.accepted.push(encoded.subarray(0, this.maxWriteBytes).toString('utf8'));
  }
}

class TailBoundedWritePty extends FakePty {
  constructor(executable, args, options, maxWriteBytes = 1_024) {
    super(executable, args, options);
    this.maxWriteBytes = maxWriteBytes;
    this.accepted = [];
  }

  write(data) {
    super.write(data);
    const encoded = Buffer.from(data, 'utf8');
    const accepted = encoded.length > this.maxWriteBytes
      ? encoded.subarray(encoded.length - this.maxWriteBytes)
      : encoded;
    this.accepted.push(accepted.toString('utf8'));
  }
}

function drainScheduledCallbacks(queue) {
  while (queue.length) queue.shift().callback();
}

const CLAUDE_READY_OUTPUT = '\u001b[5;1H────\r\n❯\u00a0\u001b[7m \u001b[27m';

test('生产 node-pty 可以真实创建子进程且不遗留测试句柄', () => {
  // ConPTY 的 native handle 必须隔离在短进程内；否则 Windows test worker 即使
  // 收到 onExit 也可能继续存活，掩盖真正的孤儿进程问题。
  const script = String.raw`
    const pty = require('node-pty');
    const windows = process.platform === 'win32';
    const file = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/echo';
    const args = windows ? ['/d','/s','/c','echo pty-ready'] : ['pty-ready'];
    let output = '';
    const child = pty.spawn(file, args, {
      name:'xterm-256color', cols:80, rows:24, cwd:process.cwd(), env:process.env,
    });
    const timeout = setTimeout(() => process.exit(2), 3000);
    child.onData(data => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      process.stdout.write(output);
      process.exit(exitCode === 0 && output.includes('pty-ready') ? 0 : 1);
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd:process.cwd(), encoding:'utf8', timeout:5_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pty-ready/);
});

test('终端 provider 暴露 Codex、Claude Code 与 OpenCode，并使用固定参数', () => {
  assert.deepEqual(agentTerminalProviders(), [
    { id:'codex', label:'Codex' },
    { id:'claude-code', label:'Claude Code' },
    { id:'opencode', label:'OpenCode' },
  ]);
  assert.deepEqual(buildAgentTerminalCommand('codex', {
    initialPrompt:'准备 Deck', platform:'linux',
  }), {
    provider:'codex', label:'Codex', executable:'codex',
    args:['--dangerously-bypass-approvals-and-sandbox'],
  });
  assert.deepEqual(buildAgentTerminalCommand('claude-code', { platform:'linux' }), {
    provider:'claude-code', label:'Claude Code', executable:'claude',
    args:['--dangerously-skip-permissions'],
  });
  assert.deepEqual(buildAgentTerminalCommand('claude-code', { platform:'win32' }), {
    provider:'claude-code', label:'Claude Code', executable:'claude.cmd',
    args:['--dangerously-skip-permissions'],
  });
  assert.deepEqual(buildAgentTerminalCommand('codex', {
    platform:'linux',
    conversationId:'019fcac9-3fbe-7a81-817b-a00f88d2b7ed',
    resume:true,
    initialPrompt:'继续 Deck',
  }), {
    provider:'codex', label:'Codex', executable:'codex',
    args:[
      'resume', '--dangerously-bypass-approvals-and-sandbox',
      '019fcac9-3fbe-7a81-817b-a00f88d2b7ed',
    ],
  });
  assert.deepEqual(buildAgentTerminalCommand('claude-code', {
    platform:'linux',
    conversationId:'bad74b80-1b7d-415b-bd6f-645c7deed723',
    resume:true,
    initialPrompt:'继续 Deck',
  }), {
    provider:'claude-code', label:'Claude Code', executable:'claude',
    args:[
      '--dangerously-skip-permissions', '--resume',
      'bad74b80-1b7d-415b-bd6f-645c7deed723',
    ],
  });
  assert.deepEqual(buildAgentTerminalCommand('opencode', { platform:'linux' }), {
    provider:'opencode', label:'OpenCode', executable:'opencode', args:[],
  });
  assert.deepEqual(buildAgentTerminalCommand('opencode', {
    platform:'win32', conversationId:'ses_huawei_deck_1', resume:true,
  }), {
    provider:'opencode', label:'OpenCode', executable:'opencode.cmd',
    args:['--session', 'ses_huawei_deck_1'],
  });
  assert.throws(() => buildAgentTerminalCommand('openclaw'), /不支持的终端 Agent/);
});

test('三种 Agent 遇到目录信任提示时等待用户确认且不误投初始任务', async t => {
  const scenarios = [
    {
      name:'codex',
      provider:'codex',
      output:'Do you trust the contents of this directory?\r\n› 1. Yes, proceed\r\n  2. No, quit\u001b[?25h',
      readyOutput:'Codex ready',
    },
    {
      name:'codex-wsl-cursor-positioned',
      provider:'codex',
      output:'\u001b[3;3HDo\u001b[1Cyou\u001b[1Ctrust\u001b[1Cthe\u001b[1Ccontents'
        + '\u001b[1Cof\u001b[1Cthis\u001b[1Cdirectory?\r\n› 1. Yes, continue\r\n'
        + '2.\u001b[1CNo,\u001b[1Cquit\u001b[?25h',
      readyOutput:'Codex ready',
    },
    {
      name:'claude-code',
      provider:'claude-code',
      output:'Do you trust the files in this folder?\r\n  Yes, proceed\r\n  No, exit',
      readyOutput:CLAUDE_READY_OUTPUT,
    },
    {
      name:'opencode',
      provider:'opencode',
      output:'Do you trust this project directory?\r\n  Trust\r\n  Exit',
      readyOutput:'OpenCode ready',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const children = [];
      const session = new AgentTerminalSession({
        projectRoot:'/tmp/huawei-deck',
        provider:scenario.provider,
        initialPrompt:() => '这条任务必须等目录信任确认后再提交',
        spawnPty:(executable, args, options) => {
          const child = new FakePty(executable, args, options);
          children.push(child);
          return child;
        },
      });
      await session.start();
      children[0].events.emit('data', scenario.output);
      assert.deepEqual(session.snapshot().interactionRequired, {
        kind:'directory-trust',
        message:'请在右侧终端确认是否信任当前项目目录',
      });
      assert.equal(session.snapshot().promptReady, false);
      assert.equal(session.snapshot().startupPromptState, 'pending');
      assert.deepEqual(children[0].writes, [], '信任提示不能被初始任务覆盖');
      session.input('\r');
      assert.deepEqual(children[0].writes, ['\r'], '等待确认时必须允许用户操作终端');
      children[0].events.emit('data', scenario.readyOutput);
      assert.equal(session.snapshot().interactionRequired, null);
      assert.equal(session.snapshot().promptReady, true);
      assert.equal(session.snapshot().startupPromptState, 'submitting');
      assert.deepEqual(children[0].writes, [
        '\r',
        '\u001b[200~这条任务必须等目录信任确认后再提交\u001b[201~',
      ]);
      await session.close();
    });
  }
});

test('Claude Code 启动输出不能误当成可输入提示符', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    provider:'claude-code',
    initialPrompt:() => '必须等到 Claude 输入框再提交',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', '\u001b]0;Claude Code\u0007Claude Code v2.1.108');
  assert.equal(session.snapshot().promptReady, false);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.deepEqual(children[0].writes, []);
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.equal(session.snapshot().promptReady, true);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  await session.close();
});

test('恢复会话的 PTY 已运行但输入框未出现时仍不算就绪', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    resolveConversation:async () => ({
      conversationId:'codex-resumed-trust-session',
      resume:true,
      initialPromptConsumed:true,
    }),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  let readyResolved = false;
  const ready = session.waitUntilReady({ timeoutMs:1_000 }).then(value => {
    readyResolved = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(session.snapshot().state, 'running');
  assert.equal(session.snapshot().promptReady, false);
  assert.equal(readyResolved, false);
  children[0].events.emit(
    'data',
    'Do you trust the contents of this directory?\r\n› 1. Yes\r\n  2. No\u001b[?25h',
  );
  assert.equal(readyResolved, false);
  session.input('\r');
  children[0].events.emit('data', 'Codex ready');
  await ready;
  assert.equal(session.snapshot().promptReady, true);
  await session.close();
});

test('Windows 优先使用 native exe，并兼容 npm cmd shim', () => {
  const native = resolveAgentTerminalExecutable('claude-code', {
    platform:'win32',
    environment:{ PATH:String.raw`C:\Native;C:\Npm`, PATHEXT:'.EXE;.CMD' },
    exists:path => path === String.raw`C:\Native\claude.exe`
      || path === String.raw`C:\Npm\claude.cmd`,
  });
  assert.equal(native, String.raw`C:\Native\claude.exe`);

  const shim = resolveAgentTerminalExecutable('claude-code', {
    platform:'win32',
    environment:{ PATH:String.raw`C:\Npm`, PATHEXT:'.EXE;.CMD' },
    exists:path => path === String.raw`C:\Npm\claude.cmd`,
  });
  assert.equal(shim, String.raw`C:\Npm\claude.cmd`);
});

test('Windows PTY 使用 npm 的 .cmd shim 启动 Agent', async () => {
  const children = [];
  const scheduledSubmits = [];
  const scheduledDelays = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`C:\huawei-deck`,
    provider:'claude-code',
    platform:'win32',
    resolveExecutable:() => 'claude.cmd',
    scheduleSubmit:(callback, delayMs) => {
      scheduledDelays.push(delayMs);
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  assert.equal(children[0].executable, 'claude.cmd');
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  session.submitPrompt('第一行\n第二行');
  assert.deepEqual(children[0].writes, ['\u001b[200~']);
  assert.equal(scheduledSubmits[0].delayMs, 30);
  drainScheduledCallbacks(scheduledSubmits);
  assert.deepEqual(children[0].writes, [
    '\u001b[200~', '第一行\n第二行', '\u001b[201~', '\r',
  ]);
  assert.deepEqual(scheduledDelays, [30, 30, 3_500]);
  await session.close();
});

test('Windows Claude Code 长任务分块穿过 ConPTY 后再自动回车', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`Y:\huawei-deck`,
    provider:'claude-code',
    platform:'win32',
    resolveExecutable:() => 'claude.exe',
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new BoundedWritePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  const prompt = [
    String.raw`Deck：Y:\huawei-deck\Deck-Projects\demo\working\deck.html`,
    '只处理本批 ID；不要读取整份历史；保持 action envelope 完整。'.repeat(120),
    '如果收到这里，说明任务指令完整。',
  ].join('\n');

  session.submitPrompt(prompt);
  drainScheduledCallbacks(scheduledSubmits);

  assert.equal(
    children[0].accepted.join(''),
    `\u001b[200~${prompt}\u001b[201~\r`,
    '任一单次 PTY 写入受限时，也必须完整交付正文、paste 结束符和回车',
  );
  assert.ok(children[0].writes.length > 3, '长 Prompt 必须拆成多个 PTY write');
  assert.ok(
    children[0].writes.every(data => Buffer.byteLength(data, 'utf8') <= 512),
    '每次正文写入不得超过保守的 512 B ConPTY 边界',
  );
  assert.equal(children[0].writes.at(-1), '\r');
  await session.close();
});

test('Windows Claude Code 在单次写入只保留末尾 1 KiB 时不得丢失任务开头', async () => {
  const children = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`Y:\huawei-deck`,
    provider:'claude-code',
    platform:'win32',
    resolveExecutable:() => 'claude.exe',
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new TailBoundedWritePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  const prompt = buildAgentPrompt({
    deckPath:String.raw`Y:\huawei-deck\Deck-Projects\demo\.huawei-deck-editor\test\working\deck.html`,
    serviceUrl:'http://127.0.0.1:54117',
    token:'secret',
    taskIds:['task-windows-prefix'],
    sourceThreadId:null,
    loadSkill:false,
    environmentCredentials:true,
  });

  session.submitPrompt(prompt);
  drainScheduledCallbacks(scheduledSubmits);

  assert.equal(
    children[0].accepted.join(''),
    `\u001b[200~${prompt}\u001b[201~\r`,
    '接收端保留大块写入的末尾时，任务第一行和第 1 点仍必须完整',
  );
  await session.close();
});

test('Windows Claude Code 分块提交中重启会取消整条旧写入链', async () => {
  const children = [];
  const scheduledSubmits = [];
  const cancelled = [];
  let nextHandle = 0;
  const session = new AgentTerminalSession({
    projectRoot:String.raw`C:\huawei-deck`,
    provider:'claude-code',
    platform:'win32',
    scheduleSubmit:(callback, delayMs) => {
      const entry = { callback, delayMs, handle:nextHandle += 1 };
      scheduledSubmits.push(entry);
      return entry.handle;
    },
    cancelScheduledSubmit:handle => cancelled.push(handle),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', CLAUDE_READY_OUTPUT);
  session.submitPrompt('长任务正文'.repeat(1_000));
  assert.deepEqual(children[0].writes, ['\u001b[200~']);
  scheduledSubmits.shift().callback();
  const staleStep = scheduledSubmits.shift();
  assert.ok(staleStep, '首块正文之后应继续调度下一块');

  await session.restart({ provider:'claude-code' });
  assert.deepEqual(cancelled, [staleStep.handle]);
  staleStep.callback();
  assert.deepEqual(children[1].writes, [], '旧回调不得把正文或回车写入新会话');
  await session.close();
});

test('Windows PTY 对外保留可信 UNC 项目身份，但用映射盘 cwd 启动 Agent', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`\\server\share\huawei-deck`,
    cwd:String.raw`R:\huawei-deck`,
    provider:'claude-code',
    platform:'win32',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  assert.equal(session.snapshot().projectRoot, String.raw`\\server\share\huawei-deck`);
  assert.equal(children[0].options.cwd, String.raw`R:\huawei-deck`);
  await session.close();
});

test('Windows Codex 通过 WSL runtime 启动并用 WSL 路径提交与发现会话', async () => {
  const children = [];
  const resolutions = [];
  const discoveries = [];
  const scheduled = [];
  const session = new AgentTerminalSession({
    projectRoot:String.raw`C:\Users\tester\workspace\project`,
    cwd:String.raw`C:\Users\tester\workspace\project`,
    provider:'codex',
    platform:'win32',
    environment:{ HUAWEI_DECK_EDITOR_TOKEN:'secret' },
    runtimePathRoots:[String.raw`C:\Users\tester\workspace\AICO-PPT`],
    prepareRuntime:async () => ({
      kind:'wsl',
      conversationCwd:'/mnt/c/Users/tester/workspace/project',
      spawnCwd:String.raw`C:\Users\tester\workspace\project`,
      environment:{
        HUAWEI_DECK_EDITOR_TOKEN:'secret',
        HUAWEI_DECK_CODEX_RUNTIME:'wsl',
      },
      translateText:text => text
        .replaceAll(String.raw`C:\Users\tester\workspace\project`, '/mnt/c/Users/tester/workspace/project'),
      wrapCommand:command => ({
        ...command,
        label:'Codex（WSL Ubuntu-26.04/root）',
        executable:'wsl.exe',
        args:['-d', 'Ubuntu-26.04', '--exec', 'codex', ...command.args],
      }),
    }),
    initialPrompt:() => String.raw`读取 C:\Users\tester\workspace\project 中的 Skill`,
    resolveConversation:async (provider, options) => {
      resolutions.push([provider, options]);
      return {
        conversationId:null,
        resume:false,
        discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
        discoveryStartedAt:'2026-08-17T00:00:00.000Z',
        knownConversationIds:[],
      };
    },
    identifyConversation:async (provider, options) => {
      discoveries.push([provider, options]);
      return 'wsl-codex-session';
    },
    scheduleSubmit:(callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  assert.equal(children[0].executable, 'wsl.exe');
  assert.equal(children[0].options.cwd, String.raw`C:\Users\tester\workspace\project`);
  assert.deepEqual(resolutions[0][1].environment, {
    HUAWEI_DECK_EDITOR_TOKEN:'secret',
    HUAWEI_DECK_CODEX_RUNTIME:'wsl',
  });
  children[0].events.emit('data', 'Codex ready');
  assert.match(children[0].writes[0], /\/mnt\/c\/Users\/tester\/workspace\/project/);
  assert.equal(discoveries[0][1].cwd, '/mnt/c/Users/tester/workspace/project');
  assert.equal(discoveries[0][1].environment.HUAWEI_DECK_CODEX_RUNTIME, 'wsl');
  await session.close();
});

test('独立 Escape 输入发布批次中断事件，方向键转义序列不误触发', async () => {
  const children = [];
  const interrupts = [];
  const projectRoot = process.platform === 'win32'
    ? String.raw`C:\huawei-deck`
    : '/tmp/huawei-deck';
  const session = new AgentTerminalSession({
    projectRoot,
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  session.addInterruptListener(value => interrupts.push(value));
  await session.start();
  session.input('\u001b[A');
  session.input('\u001b');
  assert.deepEqual(children[0].writes, ['\u001b[A', '\u001b']);
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].source, 'escape-key');
  assert.equal(session.snapshot().state, 'running');
  await session.close();
});

test('重启会话会取消待发送回车，旧回调不能提交到新 Agent', async () => {
  const children = [];
  const cancelled = [];
  let scheduled;
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    platform:'linux',
    scheduleSubmit:(callback, delayMs) => {
      scheduled = { callback, delayMs };
      return 99;
    },
    cancelScheduledSubmit:handle => cancelled.push(handle),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start();
  children[0].events.emit('data', 'Codex ready');
  session.submitPrompt('不会误发');
  assert.deepEqual(children[0].writes, ['\u001b[200~不会误发\u001b[201~']);
  assert.equal(scheduled.delayMs, 120);

  await session.restart();
  assert.deepEqual(cancelled, [99]);
  scheduled.callback();
  assert.deepEqual(children[1].writes, []);
  await session.close();
});

test('Codex 初始化指令等待真实输入框就绪，添加任务和新会话都不抢跑', async () => {
  const children = [];
  const resolutions = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    platform:'linux',
    initialPrompt:() => '这是新建 Deck 的初始化说明',
    resolveConversation:async (_provider, options) => {
      resolutions.push(options.newConversation);
      return { conversationId:'codex-visible-session', resume:false };
    },
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  const emitBanner = child => child.events.emit(
    'data',
    '\u001b[?2004h\u001b[?2026h\u001b[2;1HOpenAI Codex\u001b[5;1Hmodel: loading',
  );
  const emitInputReady = child => child.events.emit(
    'data',
    '\u001b[11;1H\u001b[1m›\u001b[11;3H\u001b[2mExplain this codebase'
      + '\u001b[?25h\u001b[11;3H\u001b[?2026l',
  );

  await session.start({ provider:'codex' });
  emitBanner(children[0]);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.deepEqual(children[0].writes, [], 'Codex 仍在初始化时不得提前粘贴指令');
  emitInputReady(children[0]);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(children[0].writes, [
    '\u001b[200~这是新建 Deck 的初始化说明\u001b[201~',
  ]);
  scheduledSubmits[0].callback();

  await session.restart({ provider:'codex', newConversation:true });
  emitBanner(children[1]);
  assert.equal(session.snapshot().startupPromptState, 'pending');
  assert.deepEqual(children[1].writes, [], '新会话同样必须等待输入框就绪');
  emitInputReady(children[1]);
  assert.deepEqual(children[1].writes, [
    '\u001b[200~这是新建 Deck 的初始化说明\u001b[201~',
  ]);
  scheduledSubmits[1].callback();
  assert.deepEqual(resolutions, [false, true]);
  await session.close();
});

test('PTY 会话在项目目录启动、回放输出并支持输入、缩放和重启', async () => {
  const children = [];
  const providerChanges = [];
  const scheduledSubmits = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    platform:'linux',
    initialPrompt:provider => `初始化 ${provider}`,
    onProviderChange:async provider => providerChanges.push(provider),
    scheduleSubmit:(callback, delayMs) => {
      scheduledSubmits.push({ callback, delayMs });
      return scheduledSubmits.length;
    },
    cancelScheduledSubmit:() => {},
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  const runtimeId = session.snapshot().runtimeId;
  const listenerProviders = [];
  const listenerStates = [];
  session.addProviderChangeListener(value => listenerProviders.push(value));
  session.addStateListener(value => listenerStates.push(value.state));
  session.updateEnvironment({ HUAWEI_DECK_CREATION_URL:'http://127.0.0.1:1234' });
  const sent = [];
  const socket = { readyState:1, send:value => sent.push(JSON.parse(value)) };
  session.attach(socket);
  await session.start({ cols:100, rows:32 });
  const first = children[0];
  assert.equal(first.executable, 'codex');
  assert.deepEqual(first.args, [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(first.options.cwd, '/tmp/huawei-deck');
  assert.equal(first.options.env.TERM, 'xterm-256color');
  assert.equal(first.options.env.HUAWEI_DECK_CREATION_URL, 'http://127.0.0.1:1234');
  first.events.emit('data', '\u001b[31mCodex ready\u001b[0m');
  assert.ok(sent.some(message => message.type === 'output'));
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(first.writes, ['\u001b[200~初始化 codex\u001b[201~']);
  session.input('初始化期间不得写入');
  assert.deepEqual(first.writes, ['\u001b[200~初始化 codex\u001b[201~']);
  assert.equal(scheduledSubmits.length, 1);
  assert.equal(scheduledSubmits[0].delayMs, 120);
  scheduledSubmits[0].callback();
  assert.equal(session.snapshot().startupPromptState, 'submitted');
  session.input('hello');
  session.submitPrompt('处理任务');
  session.resize(120, 40);
  assert.deepEqual(first.writes, [
    '\u001b[200~初始化 codex\u001b[201~', '\r',
    'hello', '\u001b[200~处理任务\u001b[201~',
  ]);
  assert.equal(scheduledSubmits.length, 2);
  assert.equal(scheduledSubmits[1].delayMs, 120);
  scheduledSubmits[1].callback();
  assert.deepEqual(first.writes, [
    '\u001b[200~初始化 codex\u001b[201~', '\r',
    'hello', '\u001b[200~处理任务\u001b[201~', '\r',
  ]);
  assert.deepEqual(first.resizes, [[120, 40]]);

  const replay = [];
  session.attach({ readyState:1, send:value => replay.push(JSON.parse(value)) });
  assert.match(replay[0].output, /Codex ready/);
  await session.restart({ provider:'claude-code', initialPrompt:'Claude 初始化' });
  assert.equal(first.killed, true);
  assert.equal(children[1].executable, 'claude');
  assert.deepEqual(children[1].args, ['--dangerously-skip-permissions']);
  children[1].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.equal(session.snapshot().startupPromptState, 'submitting');
  assert.deepEqual(children[1].writes, ['\u001b[200~Claude 初始化\u001b[201~']);
  assert.deepEqual(providerChanges, ['codex', 'claude-code']);
  assert.deepEqual(listenerProviders, ['codex', 'claude-code']);
  assert.ok(listenerStates.includes('running'));
  assert.equal(session.snapshot().runtimeId, runtimeId);
  await session.close();
  assert.equal(children[1].killed, true);
});

test('PTY 启动前解析任务专属会话，启动后持久化回执', async () => {
  const children = [];
  const started = [];
  const resolutions = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    environment:{ HUAWEI_DECK_TEST:'conversation-env' },
    resolveConversation:async (provider, options) => {
      resolutions.push([provider, options]);
      return {
        conversationId:provider === 'codex' ? 'codex-task-session' : 'claude-task-session',
        resume:provider === 'codex',
      };
    },
    onConversationStarted:async (provider, conversationId) => started.push([provider, conversationId]),
    initialPrompt:() => '继续当前任务',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });
  await session.start({ provider:'codex' });
  assert.deepEqual(children[0].args, [
    'resume', '--dangerously-bypass-approvals-and-sandbox',
    'codex-task-session',
  ]);
  await session.restart({ provider:'codex', initialPrompt:'处理新任务' });
  assert.deepEqual(children[1].args, [
    'resume', '--dangerously-bypass-approvals-and-sandbox',
    'codex-task-session',
  ]);
  children[1].events.emit('data', 'Codex ready');
  assert.deepEqual(children[1].writes, ['\u001b[200~处理新任务\u001b[201~']);
  assert.equal(session.snapshot().conversationId, 'codex-task-session');
  assert.equal(session.snapshot().conversationResumed, true);
  await session.restart({ provider:'claude-code', newConversation:true });
  assert.deepEqual(children[2].args, [
    '--dangerously-skip-permissions', '--session-id',
    'claude-task-session',
  ]);
  children[2].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.deepEqual(children[2].writes, ['\u001b[200~继续当前任务\u001b[201~']);
  assert.deepEqual(started, [
    ['codex', 'codex-task-session'],
    ['codex', 'codex-task-session'],
    ['claude-code', 'claude-task-session'],
  ]);
  assert.deepEqual(resolutions, [
    ['codex', {
      newConversation:false,
      initialPrompt:'继续当前任务',
      environment:{ HUAWEI_DECK_TEST:'conversation-env' },
    }],
    ['codex', {
      newConversation:false,
      initialPrompt:'处理新任务',
      environment:{ HUAWEI_DECK_TEST:'conversation-env' },
    }],
    ['claude-code', {
      newConversation:true,
      initialPrompt:'继续当前任务',
      environment:{ HUAWEI_DECK_TEST:'conversation-env' },
    }],
  ]);
  await session.close();
});

test('Codex 新会话先显示 PTY，再异步发现并持久化真实 ID', async () => {
  const children = [];
  const started = [];
  let releaseIdentity;
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    initialPrompt:() => '读取 Skill 并建立编辑上下文',
    resolveConversation:async () => ({
      conversationId:null,
      resume:false,
      initialPromptConsumed:false,
      discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
    }),
    identifyConversation:async () => new Promise(resolve => { releaseIdentity = resolve; }),
    onConversationStarted:async (provider, conversationId) => started.push([provider, conversationId]),
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start({ provider:'codex' });
  assert.equal(children.length, 1, '异步身份发现不得阻塞 PTY 显示');
  assert.equal(session.snapshot().state, 'running');
  assert.equal(session.snapshot().conversationId, null);
  assert.deepEqual(children[0].args.slice(0, 1), [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  children[0].events.emit('data', 'Codex ready');
  assert.match(children[0].writes[0], /019ff4b7-0622-7272-b0e2-394f6316b52a/);
  assert.match(children[0].writes[0], /读取 Skill/);

  releaseIdentity('019ff4b7-0622-7272-b0e2-394f6316b52b');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().conversationId, '019ff4b7-0622-7272-b0e2-394f6316b52b');
  assert.deepEqual(started, [[
    'codex', '019ff4b7-0622-7272-b0e2-394f6316b52b',
  ]]);
  await session.close();
});

test('Codex 恢复 ID 已失效时由可见 CLI 失败信号自动切换新会话', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    initialPrompt:() => '读取 Skill',
    resolveConversation:async (_provider, { newConversation }) => newConversation
      ? {
          conversationId:null,
          resume:false,
          initialPromptConsumed:false,
          discoveryToken:'019ff4b7-0622-7272-b0e2-394f6316b52a',
        }
      : { conversationId:'missing-codex-session', resume:true },
    identifyConversation:async () => 'replacement-codex-session',
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start({ provider:'codex' });
  children[0].events.emit('data', 'ERROR: No saved session found with ID missing-codex-session.');
  children[0].events.emit('exit', { exitCode:1, signal:null });
  for (let attempt = 0; attempt < 50 && children.length < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].args.slice(0, 1), [
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  children[1].events.emit('data', 'Codex ready');
  assert.match(children[1].writes[0], /019ff4b7-0622-7272-b0e2-394f6316b52a/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().conversationId, 'replacement-codex-session');
  await session.close();
});

test('Claude Code 恢复 ID 已失效时由可见 CLI 失败信号自动切换新会话', async () => {
  const children = [];
  const session = new AgentTerminalSession({
    projectRoot:'/tmp/huawei-deck',
    initialPrompt:() => '读取 Skill',
    resolveConversation:async (_provider, { newConversation }) => newConversation
      ? {
          conversationId:'replacement-claude-session',
          resume:false,
          initialPromptConsumed:false,
        }
      : { conversationId:'missing-claude-session', resume:true },
    spawnPty:(executable, args, options) => {
      const child = new FakePty(executable, args, options);
      children.push(child);
      return child;
    },
  });

  await session.start({ provider:'claude-code' });
  assert.deepEqual(children[0].args, [
    '--dangerously-skip-permissions', '--resume', 'missing-claude-session',
  ]);
  children[0].events.emit(
    'data',
    'No conversation found with session ID: missing-claude-session',
  );
  children[0].events.emit('exit', { exitCode:1, signal:null });
  for (let attempt = 0; attempt < 50 && children.length < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].args, [
    '--dangerously-skip-permissions', '--session-id', 'replacement-claude-session',
  ]);
  children[1].events.emit('data', CLAUDE_READY_OUTPUT);
  assert.deepEqual(children[1].writes, ['\u001b[200~读取 Skill\u001b[201~']);
  assert.equal(session.snapshot().conversationId, 'replacement-claude-session');
  assert.equal(session.snapshot().conversationResumed, false);
  await session.close();
});
