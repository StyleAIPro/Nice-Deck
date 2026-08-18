import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, win32 } from 'node:path';
import {
  agentProviderDefinition,
  buildRegisteredTerminalCommand,
  publicAgentProviders,
} from './agent-provider-registry.mjs';
import { prepareAgentTerminalRuntime } from './agent-terminal-runtime.mjs';

const MAX_BUFFER_CHARS = 1024 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const WINDOWS_CLAUDE_PASTE_CHUNK_BYTES = 512;
const WINDOWS_CLAUDE_PASTE_CHUNK_DELAY_MS = 30;
const MISSING_AGENT_SESSION = Object.freeze({
  codex:/No saved session found|no rollout found for thread id/i,
  'claude-code':/No conversation found with session ID/i,
});
const INTERACTION_SCAN_CHARS = 8 * 1024;
const DIRECTORY_TRUST_MESSAGE = '请在右侧终端确认是否信任当前项目目录';

function visibleTerminalText(output) {
  return String(output ?? '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    // Codex TUI 用 CSI n C/a 表示单词之间的水平空白；若直接删掉，
    // `Do you trust` 会塌成 `Doyoutrust`，目录信任闸门无法识别。
    .replace(/\u001b\[\d{0,4}[Ca]/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function directoryTrustRequested(output) {
  const text = visibleTerminalText(output).replace(/[ \t]+/g, ' ').toLowerCase();
  if (!text.trim()) return false;
  return [
    /do\s+you\s+trust[\s\S]{0,180}(?:directory|folder|project|workspace|files?|contents?|codebase)/,
    /do\s+you\s+trust\b/,
    /(?:trust|trusted)\s+(?:the\s+contents\s+of\s+)?(?:this|the|current)?\s*(?:directory|folder|project|workspace|codebase)/,
    /is\s+this[\s\S]{0,120}(?:project|folder|directory)[\s\S]{0,120}(?:you\s+trust|trusted)/,
    /(?:是否|请)[\s\S]{0,40}信任[\s\S]{0,80}(?:目录|文件夹|项目|工作区)/,
    /(?:目录|文件夹|项目|工作区)[\s\S]{0,80}(?:是否|请)[\s\S]{0,40}信任/,
  ].some(pattern => pattern.test(text));
}

function missingAgentSession(provider, output) {
  return MISSING_AGENT_SESSION[provider]?.test(visibleTerminalText(output)) === true;
}

function splitUtf8(text, maxBytes) {
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const symbol of text) {
    const symbolBytes = Buffer.byteLength(symbol, 'utf8');
    if (chunk && chunkBytes + symbolBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += symbol;
    chunkBytes += symbolBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function terminalAcceptsPrompt(provider, output) {
  const visibleOutput = visibleTerminalText(output);
  if (!visibleOutput.trim()) return false;
  if (provider === 'claude-code') {
    // Claude Code/Ink 在启动、恢复长会话和重绘历史时都会输出
    // 大量 ANSI，但只有真正的空输入行会画出“❯ + 反色空格光标”。
    // 不能再用“有任意输出”作为 ready；Windows 恢复长会话时会因此
    // 把任务前几个分块灌进尚未接管键盘的启动画面。
    return /❯(?:\u00a0| )?(?:\u001b\[[0-?]*[ -/]*[@-~])*\u001b\[7m /.test(output);
  }
  if (provider !== 'codex') return true;
  // Codex 启动时会先输出终端模式、标题和模型加载信息；这些首批字节并不代表
  // Ink 输入框已经接管键盘。真正可输入的屏幕会绘制粗体 ›，并在它之后显示
  // 光标。测试和不带完整 ANSI 能力的兼容终端可使用明确的 ready 文本。
  const promptMarker = output.lastIndexOf('›');
  if (promptMarker >= 0 && output.indexOf('\u001b[?25h', promptMarker) >= 0) return true;
  return /codex ready/i.test(output);
}

function terminalError(code, message) {
  return Object.assign(new Error(message), { code });
}

function providerConfig(provider) {
  try { return agentProviderDefinition(provider); }
  catch (error) { throw terminalError(error.code, error.message); }
}

export function agentTerminalProviders() {
  return publicAgentProviders();
}

export function buildAgentTerminalCommand(provider, {
  platform = process.platform, conversationId = null, resume = false,
} = {}) {
  providerConfig(provider);
  if (conversationId !== null && (typeof conversationId !== 'string'
    || conversationId.length < 3 || conversationId.length > 512
    || conversationId.startsWith('-') || /[\0\r\n]/.test(conversationId))) {
    throw terminalError('INVALID_AGENT_CONVERSATION_ID', 'Agent 会话 ID 无效');
  }
  return buildRegisteredTerminalCommand(provider, { platform, conversationId, resume });
}

export function resolveAgentTerminalExecutable(provider, {
  platform = process.platform,
  environment = process.env,
  exists = existsSync,
} = {}) {
  const definition = providerConfig(provider);
  const base = definition.terminal.executable;
  if (platform !== 'win32') return base;
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const directories = String(environment.PATH ?? environment.Path ?? '')
    .split(pathDelimiter).map(value => value.replace(/^"|"$/g, '')).filter(Boolean);
  // native installer 优先于 npm shim；候选名固定来自注册表，浏览器不能注入路径。
  for (const suffix of ['.exe', '.cmd', '.bat', '']) {
    const name = `${base}${suffix}`;
    for (const directory of directories) {
      const candidate = win32.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  // 保留既有错误体验：未安装时让 node-pty 报 ENOENT，并转成 AGENT_NOT_FOUND。
  return `${base}.cmd`;
}

function socketOpen(socket) {
  return socket?.readyState === undefined || socket.readyState === 1;
}

export class AgentTerminalSession {
  constructor({
    projectRoot,
    cwd = projectRoot,
    provider = 'codex',
    platform = process.platform,
    environment = process.env,
    spawnPty = pty.spawn,
    initialPrompt = () => '',
    resolveConversation = async () => null,
    identifyConversation = async () => null,
    onConversationStarted = async () => {},
    onProviderChange = async () => {},
    onStateChange = () => {},
    scheduleSubmit = setTimeout,
    cancelScheduledSubmit = clearTimeout,
    resolveExecutable = resolveAgentTerminalExecutable,
    prepareRuntime = prepareAgentTerminalRuntime,
    runtimePathRoots = [],
  }) {
    const absolutePath = platform === 'win32' ? win32.isAbsolute : isAbsolute;
    if (typeof projectRoot !== 'string' || !absolutePath(projectRoot)) {
      throw new TypeError('Agent 终端项目目录必须是绝对路径');
    }
    if (typeof cwd !== 'string' || !absolutePath(cwd)) {
      throw new TypeError('Agent 终端启动目录必须是绝对路径');
    }
    providerConfig(provider);
    if (typeof platform !== 'string' || !platform) throw new TypeError('终端平台无效');
    if (typeof spawnPty !== 'function') throw new TypeError('spawnPty 必须是函数');
    if (typeof initialPrompt !== 'function') throw new TypeError('initialPrompt 必须是函数');
    if (typeof resolveConversation !== 'function') throw new TypeError('resolveConversation 必须是函数');
    if (typeof identifyConversation !== 'function') throw new TypeError('identifyConversation 必须是函数');
    if (typeof onConversationStarted !== 'function') throw new TypeError('onConversationStarted 必须是函数');
    if (typeof onProviderChange !== 'function') throw new TypeError('onProviderChange 必须是函数');
    if (typeof onStateChange !== 'function') throw new TypeError('onStateChange 必须是函数');
    if (typeof scheduleSubmit !== 'function') throw new TypeError('scheduleSubmit 必须是函数');
    if (typeof cancelScheduledSubmit !== 'function') throw new TypeError('cancelScheduledSubmit 必须是函数');
    if (typeof resolveExecutable !== 'function') throw new TypeError('resolveExecutable 必须是函数');
    if (typeof prepareRuntime !== 'function') throw new TypeError('prepareRuntime 必须是函数');
    if (!Array.isArray(runtimePathRoots)
      || runtimePathRoots.some(value => typeof value !== 'string')) {
      throw new TypeError('runtimePathRoots 必须是路径数组');
    }
    this.projectRoot = projectRoot;
    this.cwd = cwd;
    this.provider = provider;
    this.platform = platform;
    this.environment = { ...environment };
    this.spawnPty = spawnPty;
    this.initialPrompt = initialPrompt;
    this.resolveConversation = resolveConversation;
    this.identifyConversation = identifyConversation;
    this.onConversationStarted = onConversationStarted;
    this.onProviderChange = onProviderChange;
    this.onStateChange = onStateChange;
    this.scheduleSubmit = scheduleSubmit;
    this.cancelScheduledSubmit = cancelScheduledSubmit;
    this.resolveExecutable = resolveExecutable;
    this.prepareRuntime = prepareRuntime;
    this.runtimePathRoots = [...runtimePathRoots];
    this.providerChangeListeners = new Set();
    this.stateListeners = new Set();
    this.interruptListeners = new Set();
    this.runtimeId = randomUUID();
    this.process = null;
    this.state = 'stopped';
    this.output = '';
    this.startedAt = null;
    this.conversationId = null;
    this.conversationResumed = false;
    this.conversationError = null;
    this.startupPromptState = null;
    this.promptReady = false;
    this.interactionRequired = null;
    this.interactionResponsePending = false;
    this.interactionScanOutput = '';
    this.exit = null;
    this.sockets = new Set();
    this.generation = 0;
    this.startPromise = null;
    this.pendingSubmitTimer = null;
    this.discoveryController = null;
    this.closed = false;
    this.activeCommand = null;
    this.activeRuntime = null;
  }

  snapshot() {
    const command = this.activeCommand
      ?? buildAgentTerminalCommand(this.provider, { platform:this.platform });
    return {
      runtimeId:this.runtimeId,
      provider:this.provider,
      providerLabel:command.label,
      state:this.state,
      projectRoot:this.projectRoot,
      command:[command.executable, ...command.args].join(' '),
      pid:this.process?.pid ?? null,
      conversationId:this.conversationId,
      conversationResumed:this.conversationResumed,
      conversationError:this.conversationError,
      startupPromptState:this.startupPromptState,
      promptReady:this.promptReady,
      interactionRequired:this.interactionRequired ? { ...this.interactionRequired } : null,
      startedAt:this.startedAt,
      exit:this.exit ? { ...this.exit } : null,
      providers:agentTerminalProviders(),
    };
  }

  #send(socket, message) {
    if (!socketOpen(socket)) return;
    socket.send(JSON.stringify(message));
  }

  #broadcast(message) {
    for (const socket of this.sockets) this.#send(socket, message);
  }

  #publishState() {
    const terminal = this.snapshot();
    this.#broadcast({ type:'state', terminal });
    try {
      const pending = this.onStateChange(terminal);
      pending?.catch?.(() => {});
    } catch { /* 状态投影失败不能破坏 PTY 生命周期 */ }
    for (const listener of this.stateListeners) {
      try {
        const pending = listener(terminal);
        pending?.catch?.(() => {});
      } catch { /* 状态投影失败不能破坏 PTY 生命周期 */ }
    }
  }

  addStateListener(listener) {
    if (typeof listener !== 'function') throw new TypeError('状态 listener 必须是函数');
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  addProviderChangeListener(listener) {
    if (typeof listener !== 'function') throw new TypeError('provider listener 必须是函数');
    this.providerChangeListeners.add(listener);
    return () => this.providerChangeListeners.delete(listener);
  }

  addInterruptListener(listener) {
    if (typeof listener !== 'function') throw new TypeError('interrupt listener 必须是函数');
    this.interruptListeners.add(listener);
    return () => this.interruptListeners.delete(listener);
  }

  updateConversationLifecycle({
    resolveConversation,
    identifyConversation = this.identifyConversation,
    onConversationStarted,
  } = {}) {
    if (typeof resolveConversation !== 'function') {
      throw new TypeError('resolveConversation 必须是函数');
    }
    if (typeof onConversationStarted !== 'function') {
      throw new TypeError('onConversationStarted 必须是函数');
    }
    if (typeof identifyConversation !== 'function') {
      throw new TypeError('identifyConversation 必须是函数');
    }
    this.resolveConversation = resolveConversation;
    this.identifyConversation = identifyConversation;
    this.onConversationStarted = onConversationStarted;
  }

  updateEnvironment(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('终端环境变量 patch 必须是对象');
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete this.environment[key];
      else this.environment[key] = String(value);
    }
  }

  attach(socket) {
    if (!socket || typeof socket.send !== 'function') throw new TypeError('终端 socket 无效');
    this.sockets.add(socket);
    this.#send(socket, { type:'snapshot', terminal:this.snapshot(), output:this.output });
    return () => this.sockets.delete(socket);
  }

  async start({
    provider = this.provider, cols = 80, rows = 24, initialPrompt, newConversation = false,
  } = {}) {
    if (this.closed) throw terminalError('SERVICE_CLOSED', '编辑服务已关闭');
    providerConfig(provider);
    if (this.process && this.state === 'running' && this.provider === provider) {
      this.resize(cols, rows);
      return this.snapshot();
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start({ provider, cols, rows, initialPrompt, newConversation })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start({ provider, cols, rows, initialPrompt, newConversation }) {
    await this.stop({ clear:false });
    await this.onProviderChange(provider);
    for (const listener of this.providerChangeListeners) await listener(provider);
    if (this.closed) throw terminalError('SERVICE_CLOSED', '编辑服务已关闭');
    this.provider = provider;
    this.output = '';
    this.exit = null;
    this.conversationId = null;
    this.conversationResumed = false;
    this.conversationError = null;
    this.startupPromptState = null;
    this.promptReady = false;
    this.interactionRequired = null;
    this.interactionResponsePending = false;
    this.interactionScanOutput = '';
    this.state = 'starting';
    this.#publishState();
    let runtime = null;
    try {
      runtime = await this.prepareRuntime(provider, {
        platform:this.platform,
        environment:this.environment,
        projectRoot:this.projectRoot,
        cwd:this.cwd,
        pathRoots:this.runtimePathRoots,
      });
    } catch (error) {
      this.state = 'failed';
      this.exit = { code:null, signal:null, message:error?.message || 'Agent 运行环境准备失败' };
      this.#publishState();
      throw terminalError(
        error?.code ?? 'AGENT_RUNTIME_PREPARE_FAILED',
        error?.message ?? 'Agent 运行环境准备失败',
      );
    }
    const runtimeEnvironment = runtime?.environment ?? this.environment;
    const hasExplicitPrompt = initialPrompt !== undefined;
    const prompt = initialPrompt ?? await this.initialPrompt(provider);
    let conversation = null;
    try {
      conversation = await this.resolveConversation(provider, {
        newConversation:newConversation === true,
        initialPrompt:prompt,
        environment:runtimeEnvironment,
      });
      const hasConversationId = typeof conversation?.conversationId === 'string';
      const hasDiscoveryToken = conversation?.conversationId === null
        && typeof conversation?.discoveryToken === 'string'
        && conversation.discoveryToken.length >= 3
        && conversation.discoveryToken.length <= 512
        && !/[\0\r\n]/.test(conversation.discoveryToken);
      if (conversation !== null && (typeof conversation !== 'object'
        || (!hasConversationId && !hasDiscoveryToken))) {
        throw terminalError('INVALID_AGENT_CONVERSATION', 'Agent 会话恢复信息无效');
      }
    } catch (error) {
      this.state = 'failed';
      this.exit = { code:null, signal:null, message:error?.message || 'Agent 会话恢复失败' };
      this.#publishState();
      throw terminalError(
        error?.code ?? 'AGENT_CONVERSATION_RESOLVE_FAILED',
        error?.message ?? 'Agent 会话恢复失败',
      );
    }
    if (this.closed) throw terminalError('SERVICE_CLOSED', '编辑服务已关闭');
    const discoveryPrompt = conversation?.discoveryToken
      ? `[Huawei Deck 会话标识：${conversation.discoveryToken}]\n${prompt}`
      : prompt;
    const startupPromptSource = conversation?.initialPromptConsumed === true
        || (conversation?.resume === true && !hasExplicitPrompt)
      ? ''
      : discoveryPrompt;
    const startupPrompt = runtime?.translateText
      ? runtime.translateText(startupPromptSource)
      : startupPromptSource;
    const registeredCommand = buildAgentTerminalCommand(provider, {
      // 先让 CLI 显示并接管输入框，再由 PTY 统一粘贴初始指令并回车。
      platform:this.platform,
      conversationId:conversation?.conversationId ?? null,
      resume:conversation?.resume === true,
    });
    const command = runtime?.wrapCommand
      ? runtime.wrapCommand(registeredCommand)
      : {
          ...registeredCommand,
          executable:this.resolveExecutable(provider, {
            platform:this.platform,
            environment:this.environment,
          }),
        };
    this.activeCommand = command;
    this.activeRuntime = runtime;
    const generation = ++this.generation;
    let child;
    try {
      child = this.spawnPty(command.executable, command.args, {
        name:'xterm-256color',
        cols:Number.isInteger(cols) && cols > 0 ? Math.min(cols, 500) : 80,
        rows:Number.isInteger(rows) && rows > 0 ? Math.min(rows, 300) : 24,
        cwd:runtime?.spawnCwd ?? this.cwd,
        env:{
          ...runtimeEnvironment,
          TERM:'xterm-256color',
          COLORTERM:'truecolor',
        },
      });
    } catch (error) {
      this.state = 'failed';
      this.exit = { code:null, signal:null, message:error?.message || 'Agent 终端启动失败' };
      this.activeRuntime = null;
      this.#publishState();
      throw terminalError(
        error?.code === 'ENOENT' ? 'AGENT_NOT_FOUND' : 'AGENT_START_FAILED',
        error?.code === 'ENOENT'
          ? `找不到 ${command.executable} 命令，请先安装并登录 ${command.label}`
          : `${command.label} 启动失败：${error?.message || '未知错误'}`,
      );
    }
    this.process = child;
    this.conversationId = conversation?.conversationId ?? null;
    this.conversationResumed = conversation?.resume === true;
    this.startupPromptState = startupPrompt ? 'pending' : null;
    this.state = 'running';
    this.startedAt = new Date().toISOString();
    child.onData(data => {
      if (generation !== this.generation || this.process !== child) return;
      const chunk = String(data);
      this.output = `${this.output}${chunk}`.slice(-MAX_BUFFER_CHARS);
      this.interactionScanOutput = `${this.interactionScanOutput}${chunk}`
        .slice(-INTERACTION_SCAN_CHARS);
      this.#broadcast({ type:'output', data:chunk });
      const trustRequested = (!this.promptReady || this.interactionRequired)
        && directoryTrustRequested(this.interactionScanOutput);
      if (trustRequested && !this.interactionRequired) {
        this.interactionRequired = {
          kind:'directory-trust',
          message:DIRECTORY_TRUST_MESSAGE,
        };
        this.interactionResponsePending = false;
        this.#publishState();
      }
      if (this.interactionRequired) {
        if (!this.interactionResponsePending || trustRequested
          || !terminalAcceptsPrompt(provider, this.interactionScanOutput)) return;
        this.interactionRequired = null;
        this.interactionResponsePending = false;
        this.#publishState();
      }
      if (!this.promptReady
        && terminalAcceptsPrompt(provider, this.interactionScanOutput || this.output)) {
        this.promptReady = true;
        if (this.startupPromptState === 'pending') {
          this.#queuePrompt(startupPrompt, { startup:true });
        } else {
          this.#publishState();
        }
      }
    });
    child.onExit(({ exitCode = null, signal = null } = {}) => {
      if (generation !== this.generation || this.process !== child) return;
      this.process = null;
      if (conversation?.resume === true && missingAgentSession(provider, this.output)) {
        this.state = 'starting';
        this.exit = null;
        this.#publishState();
        setTimeout(() => {
          if (this.closed || generation !== this.generation || this.process) return;
          void this.restart({ provider, cols, rows, initialPrompt:prompt, newConversation:true });
        }, 0);
        return;
      }
      this.state = 'exited';
      this.promptReady = false;
      this.interactionRequired = null;
      this.interactionResponsePending = false;
      this.exit = { code:exitCode, signal, message:`${command.label} 会话已退出` };
      this.#publishState();
    });
    this.#publishState();
    if (conversation?.conversationId) {
      try {
        await this.onConversationStarted(provider, conversation.conversationId);
      } catch { /* 会话已经启动，身份回执失败不能杀掉 PTY */ }
    } else if (conversation?.discoveryToken) {
      const identifyConversation = this.identifyConversation;
      const onConversationStarted = this.onConversationStarted;
      const discoveryController = new AbortController();
      this.discoveryController = discoveryController;
      void identifyConversation(provider, {
        discoveryToken:conversation.discoveryToken,
        discoveryStartedAt:conversation.discoveryStartedAt,
        knownConversationIds:conversation.knownConversationIds,
        projectRoot:runtime?.projectRoot ?? this.projectRoot,
        cwd:runtime?.conversationCwd ?? this.cwd,
        environment:runtimeEnvironment,
        signal:discoveryController.signal,
        startedAt:this.startedAt,
      }).then(async conversationId => {
        if (generation !== this.generation || this.process !== child || this.closed) return;
        if (typeof conversationId !== 'string' || conversationId.length < 3
          || conversationId.length > 512 || conversationId.startsWith('-')
          || /[\0\r\n]/.test(conversationId)) {
          throw terminalError('INVALID_AGENT_CONVERSATION_ID', 'Agent 会话 ID 无效');
        }
        this.conversationId = conversationId;
        this.conversationError = null;
        if (this.discoveryController === discoveryController) this.discoveryController = null;
        this.#publishState();
        await onConversationStarted(provider, conversationId);
      }).catch(error => {
        if (generation !== this.generation || this.process !== child || this.closed) return;
        if (this.discoveryController === discoveryController) this.discoveryController = null;
        this.conversationError = error?.message || 'Agent 会话标识保存失败';
        this.#publishState();
      });
    }
    return this.snapshot();
  }

  input(data) {
    if (!this.process || this.state !== 'running') {
      throw terminalError('AGENT_TERMINAL_STOPPED', 'Agent 终端尚未启动');
    }
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INPUT_CHARS) {
      throw terminalError('INVALID_TERMINAL_INPUT', '终端输入长度无效');
    }
    // 一般初始化阶段仍锁住键盘，避免用户输入与自动任务粘在一起；但目录信任
    // 是 CLI 在任务输入框之前设置的交互闸门，必须让用户能在右侧终端作答。
    if (['pending', 'submitting'].includes(this.startupPromptState)
      && !this.interactionRequired) return;
    this.process.write(data);
    if (this.interactionRequired && /[\r\nyYnN12]/.test(data)) {
      this.interactionResponsePending = true;
      this.interactionScanOutput = '';
    }
    // xterm 的独立 Escape 键是单字节 ESC；方向键等控制序列以 ESC 开头但
    // 长度大于 1，不能误判为用户中断当前 Agent 批次。
    if (data === '\u001b') {
      const event = Object.freeze({ source:'escape-key', at:new Date().toISOString() });
      for (const listener of this.interruptListeners) {
        try {
          const pending = listener(event);
          pending?.catch?.(() => {});
        } catch { /* 批次状态同步失败不能阻断 ESC 传给 CLI */ }
      }
    }
  }

  submitPrompt(text) {
    this.#queuePrompt(text);
  }

  waitUntilReady({ timeoutMs = 10_000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('等待终端就绪的超时时间无效');
    }
    const ready = () => this.state === 'running'
      && this.promptReady
      && !this.interactionRequired
      && !['pending', 'submitting'].includes(this.startupPromptState);
    if (ready()) return Promise.resolve(this.snapshot());
    if (['failed', 'exited', 'closed'].includes(this.state)) {
      return Promise.reject(terminalError(
        'AGENT_TERMINAL_UNAVAILABLE',
        this.exit?.message || 'Agent 终端不可用',
      ));
    }
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.stateListeners.delete(onState);
      };
      const onState = state => {
        if (state.state === 'running'
          && state.promptReady
          && !state.interactionRequired
          && !['pending', 'submitting'].includes(state.startupPromptState)) {
          cleanup();
          resolve(state);
        } else if (['failed', 'exited', 'closed'].includes(state.state)) {
          cleanup();
          reject(terminalError(
            'AGENT_TERMINAL_UNAVAILABLE',
            state.exit?.message || 'Agent 终端不可用',
          ));
        }
      };
      this.stateListeners.add(onState);
      timer = setTimeout(() => {
        cleanup();
        if (this.interactionRequired) {
          reject(terminalError(
            'AGENT_TERMINAL_INTERACTION_REQUIRED',
            this.interactionRequired.message,
          ));
          return;
        }
        reject(terminalError(
          'AGENT_TERMINAL_INITIALIZING',
          '等待 Agent 初始指令自动回车超时',
        ));
      }, timeoutMs);
      // 注册 listener 后再复核一次，封住“检查状态”和“注册监听”之间的竞态。
      onState(this.snapshot());
    });
  }

  #queuePrompt(text, { startup = false } = {}) {
    if (!this.process || this.state !== 'running') {
      throw terminalError('AGENT_TERMINAL_STOPPED', 'Agent 终端尚未启动');
    }
    if (this.interactionRequired) {
      throw terminalError(
        'AGENT_TERMINAL_INTERACTION_REQUIRED',
        this.interactionRequired.message,
      );
    }
    if (!startup && !this.promptReady) {
      throw terminalError('AGENT_TERMINAL_INITIALIZING', 'Agent 终端输入框尚未就绪');
    }
    if (!startup && ['pending', 'submitting'].includes(this.startupPromptState)) {
      throw terminalError('AGENT_TERMINAL_INITIALIZING', 'Agent 终端正在提交初始指令');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT_CHARS) {
      throw terminalError('INVALID_AGENT_PROMPT', 'Agent 任务提示长度无效');
    }
    if (this.pendingSubmitTimer !== null) {
      throw terminalError('AGENT_PROMPT_PENDING', '上一条 Agent 任务仍在提交中');
    }
    const runtimeText = this.activeRuntime?.translateText
      ? this.activeRuntime.translateText(text)
      : text;
    const safeText = runtimeText.replaceAll('\u001b', '');
    const child = this.process;
    const generation = this.generation;
    if (startup) {
      this.startupPromptState = 'submitting';
      this.#publishState();
    }
    const windowsClaude = this.platform === 'win32' && this.provider === 'claude-code';
    const submitDelay = windowsClaude
      ? Math.min(6_000, 3_000 + Math.ceil(Buffer.byteLength(safeText, 'utf8') / 4_000) * 500)
      : (this.platform === 'win32' ? 1_000 : 120);
    const submit = () => {
      this.pendingSubmitTimer = null;
      if (this.process !== child || this.generation !== generation || this.state !== 'running') return;
      if (this.provider === 'claude-code') {
        // Enter 之后上一个空输入框已经失效。清空扫描窗口，只有
        // Claude 完成当前 turn 并重新画出空“❯”输入行后才恢复
        // promptReady，避免相邻两批任务串入尚未就绪的 Ink 界面。
        this.promptReady = false;
        this.interactionScanOutput = '';
      }
      child.write('\r');
      if (startup) {
        this.startupPromptState = 'submitted';
      }
      this.#publishState();
    };
    if (!windowsClaude) {
      child.write(`\u001b[200~${safeText}\u001b[201~`);
      this.pendingSubmitTimer = this.scheduleSubmit(submit, submitDelay);
      return;
    }

    // Windows ConPTY 与 Claude Code 的 Ink 输入框之间没有 write drain 回执。
    // 单次灌入长中文会把正文、paste 结束符一起截在输入边界外；即使随后
    // 延迟发送 Enter，输入框仍处于 paste 状态，因此看起来既缺字也不提交。
    // Windows Claude/ConPTY 的实际输入边界可能只保留大块写入的末尾约
    // 1 KiB；这里按 UTF-8 字节边界分块并节流，每块限制为 512 B，给不同
    // 终端版本留出两倍余量。正文全部
    // 交付后再单独关闭 bracketed paste，最后才开始等待并发送 Enter。
    const chunks = splitUtf8(safeText, WINDOWS_CLAUDE_PASTE_CHUNK_BYTES);
    let chunkIndex = 0;
    const writeNext = () => {
      this.pendingSubmitTimer = null;
      if (this.process !== child || this.generation !== generation || this.state !== 'running') return;
      if (chunkIndex < chunks.length) {
        child.write(chunks[chunkIndex]);
        chunkIndex += 1;
        this.pendingSubmitTimer = this.scheduleSubmit(
          writeNext,
          WINDOWS_CLAUDE_PASTE_CHUNK_DELAY_MS,
        );
        return;
      }
      child.write('\u001b[201~');
      this.pendingSubmitTimer = this.scheduleSubmit(submit, submitDelay);
    };
    child.write('\u001b[200~');
    this.pendingSubmitTimer = this.scheduleSubmit(
      writeNext,
      WINDOWS_CLAUDE_PASTE_CHUNK_DELAY_MS,
    );
  }

  resize(cols, rows) {
    if (!this.process || this.state !== 'running') return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)
      || cols < 2 || cols > 500 || rows < 2 || rows > 300) return;
    this.process.resize(cols, rows);
  }

  async stop({ clear = false } = {}) {
    this.discoveryController?.abort();
    this.discoveryController = null;
    if (this.pendingSubmitTimer !== null) {
      this.cancelScheduledSubmit(this.pendingSubmitTimer);
      this.pendingSubmitTimer = null;
    }
    const child = this.process;
    if (child) {
      let exitTimer;
      let exitSubscription;
      const exited = new Promise(resolve => {
        const settle = () => {
          if (exitTimer !== undefined) clearTimeout(exitTimer);
          exitSubscription?.dispose?.();
          resolve();
        };
        try { exitSubscription = child.onExit(settle); }
        catch { resolve(); return; }
        // Windows ConPTY 需要给 native handle 一个确定的回收窗口；超时后仍继续
        // 关闭服务，避免坏掉的第三方 CLI 永久卡住 Editor。
        exitTimer = setTimeout(settle, this.platform === 'win32' ? 2_000 : 500);
      });
      this.generation += 1;
      this.process = null;
      try { child.kill(); } catch { /* 进程可能已经退出 */ }
      await exited;
    }
    if (clear) this.output = '';
    this.startupPromptState = null;
    this.promptReady = false;
    this.interactionRequired = null;
    this.interactionResponsePending = false;
    this.interactionScanOutput = '';
    this.activeCommand = null;
    this.activeRuntime = null;
    if (!this.closed) this.state = 'stopped';
    this.exit = null;
    this.#publishState();
  }

  async restart(options = {}) {
    await this.stop({ clear:true });
    return this.start(options);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.stop({ clear:false });
    this.state = 'closed';
    this.#publishState();
    this.sockets.clear();
    this.providerChangeListeners.clear();
    this.stateListeners.clear();
    this.interruptListeners.clear();
  }
}
