import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(EDITOR_DIR, '../..');
const CLI_PATH = join(EDITOR_DIR, 'cli.mjs');
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const RETRYABLE_TASK_STATUSES = new Set(['pending', 'failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CONNECTION_SOURCES = new Set(['launch', 'manual', 'created', 'unbound']);
const SKILL_STATUSES = new Set(['loaded', 'detected', 'not-detected', 'unknown']);
const PROVIDER_IDS = new Set(['codex', 'claude-code', 'opencode', 'openclaw']);

function runnerError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

function publicRun(run) {
  if (!run) return { status:'idle' };
  const value = structuredClone(run);
  delete value.internal;
  return value;
}

export const AGENT_PROVIDER_CATALOG = Object.freeze([
  {
    id:'codex', name:'Codex', implemented:true,
    supportsResume:true, supportsAgentSkills:true,
  },
  {
    id:'claude-code', name:'Claude Code', implemented:true,
    supportsResume:true, supportsAgentSkills:true,
  },
  {
    id:'opencode', name:'OpenCode', implemented:true,
    supportsResume:true, supportsAgentSkills:true,
  },
  {
    id:'openclaw', name:'OpenClaw', implemented:true,
    supportsResume:true, supportsAgentSkills:true,
  },
]);

export function normalizeAgentConnection(value, {
  provider = 'codex',
} = {}) {
  if (value === null || value === undefined) {
    return {
      version:1, provider, threadId:null, projectPath:null,
      source:'unbound', skillStatus:'unknown', updatedAt:null,
    };
  }
  const selectedProvider = value.provider ?? provider;
  const validSessionId = value.threadId === null
    || (typeof value.threadId === 'string' && value.threadId.length >= 3
      && value.threadId.length <= 512 && !value.threadId.startsWith('-')
      && !/[\0\r\n]/.test(value.threadId)
      && (!['codex', 'claude-code'].includes(selectedProvider) || UUID.test(value.threadId)));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !PROVIDER_IDS.has(selectedProvider)
    || !validSessionId
    || !CONNECTION_SOURCES.has(value.source)
    || (value.projectPath !== undefined && value.projectPath !== null
      && (typeof value.projectPath !== 'string' || !isAbsolute(value.projectPath)
        || value.projectPath.length > 4096 || /[\0\r\n]/.test(value.projectPath)))
    || (value.skillStatus !== undefined && !SKILL_STATUSES.has(value.skillStatus))
    || (value.updatedAt !== null && typeof value.updatedAt !== 'string')) {
    throw new TypeError('持久化 Agent 连接配置无效');
  }
  if (value.threadId === null && !['manual', 'unbound'].includes(value.source)) {
    throw new TypeError('未绑定的 Agent 连接来源无效');
  }
  return {
    version:1,
    provider:selectedProvider,
    threadId:value.threadId,
    projectPath:value.projectPath ?? null,
    source:value.source,
    skillStatus:value.skillStatus
      ?? (['launch', 'created'].includes(value.source) ? 'loaded' : 'unknown'),
    updatedAt:value.updatedAt,
  };
}

export function resolveAgentConnection({
  provider = 'codex', launchThreadId = null, persistedConnection = null,
  now = () => new Date().toISOString(),
} = {}) {
  const persisted = normalizeAgentConnection(persistedConnection, { provider, now });
  if (launchThreadId === null) return persisted;
  if (typeof launchThreadId !== 'string' || !UUID.test(launchThreadId)) {
    throw new TypeError('Codex 来源任务 ID 必须是 UUID');
  }
  if (persisted.threadId === launchThreadId && persisted.source === 'launch') return persisted;
  return {
    version:1, provider, threadId:launchThreadId, source:'launch',
    projectPath:null, skillStatus:'loaded', updatedAt:now(),
  };
}

export function manualAgentConnection({
  provider = 'codex', threadId, projectPath = null, skillStatus = 'unknown',
  now = () => new Date().toISOString(),
}) {
  if (threadId !== null && ['codex', 'claude-code'].includes(provider) && !UUID.test(threadId)) {
    throw new TypeError(`${provider === 'codex' ? 'Codex 任务' : 'Claude Code 会话'} ID 必须是规范 UUID`);
  }
  return normalizeAgentConnection({
    version:1, provider, threadId, projectPath,
    source:'manual', skillStatus, updatedAt:now(),
  }, { provider });
}

function publicConnection(connection) {
  return { ...connection, mode:connection.threadId ? 'resume' : 'new' };
}

export function providerConfiguration(selectedProvider, connection = null) {
  const normalized = normalizeAgentConnection(connection, { provider:selectedProvider });
  return {
    version:2,
    selectedProvider:normalized.provider,
    sourceSessionBound:Boolean(normalized.threadId && normalized.source === 'launch'),
    connection:publicConnection(normalized),
    providers:AGENT_PROVIDER_CATALOG.map(provider => ({ ...provider })),
  };
}

export function buildAgentPrompt({
  deckPath, serviceUrl, token, taskIds, sourceThreadId, loadSkill = false,
  skillRoot = SKILL_ROOT, skillInvocation = '$huawei-deck', environmentCredentials = false,
}) {
  const cli = environmentCredentials
    ? `node ${JSON.stringify(CLI_PATH)} --url "$HUAWEI_DECK_EDITOR_URL"`
      + ' --token "$HUAWEI_DECK_EDITOR_TOKEN"'
    : `node ${JSON.stringify(CLI_PATH)} --url ${JSON.stringify(serviceUrl)}`
      + ` --token ${JSON.stringify(token)}`;
  const skillContext = loadSkill
    ? [
        skillInvocation,
        '',
        '这是独立打开编辑器后创建的专用任务；首次处理必须加载 Deck 制作规范。',
        `必须使用 huawei-deck skill，并先完整读取 ${JSON.stringify(join(skillRoot, 'SKILL.md'))}。`,
        '按 SKILL.md 的文件导航读取本次修改所需 references；不得跳过 bundle 编辑不变量和视觉规范。',
      ]
    : [
        sourceThreadId
          ? '这是本 Deck 已绑定的 Codex 任务；请沿用已有制作上下文。'
          : '这是独立编辑器的后续批次；请沿用本专用任务已有上下文。',
        'huawei-deck skill 已在本任务中加载，不要再次完整读取 SKILL.md；只在本批修改确有需要时读取对应 reference。',
      ];
  return [
    ...skillContext,
    '',
    `Deck：${deckPath}`,
    `本批任务 ID：${JSON.stringify(taskIds)}`,
    `编辑器 CLI 前缀：${cli}`,
    '',
    '请立即批量处理以上任务：',
    `1. 用 ${cli} status 和 ${cli} tasks 读取权威 revision 与任务内容，只处理本批 ID。`,
    `2. 结合任务区域、附件、Deck 源文件和 huawei-deck 规范判断修改；需要动作协议时读取 ${JSON.stringify(join(skillRoot, 'scripts/editor/protocol.mjs'))} 与 ${JSON.stringify(join(skillRoot, 'references/editing-guide.md'))}。`,
    '3. 每个任务生成受控 action JSON，并用 CLI apply 提交；发生 REVISION_CONFLICT 时重新读取 status 后继续。',
    '4. 不直接编辑 bundle HTML，不调用 write-deck，不处理提交按钮之后新增加的任务。',
    '5. 全部处理完后简洁汇总成功、失败和需要用户确认的任务。',
  ].join('\n');
}

export function buildSessionInitializationPrompt({
  deckPath, projectPath, skillRoot = SKILL_ROOT,
  skillInvocation = '$huawei-deck',
}) {
  return [
    skillInvocation,
    '',
    '这是 Huawei Deck 编辑器刚创建的专用会话。',
    `项目目录：${projectPath}`,
    `当前 Deck：${deckPath}`,
    `请完整读取并遵循 ${JSON.stringify(join(skillRoot, 'SKILL.md'))}。`,
    '按 SKILL.md 的文件导航读取后续 Deck 微调必需的 references，牢记 bundle 编辑不变量。',
    '本轮只建立后续编辑上下文，不修改任何文件，不执行任务，也不启动编辑器。',
    '准备完成后只需简洁回复“Deck 编辑会话已准备好”。',
  ].join('\n');
}

export function buildCodexInvocation({
  deckPath, sourceThreadId = null, projectPath = dirname(deckPath),
}) {
  return sourceThreadId
    ? { mode:'resume', args:['exec', 'resume', '--json', sourceThreadId, '-'] }
    : {
        mode:'new',
        args:[
          'exec', '--json', '--sandbox', 'workspace-write',
          '--skip-git-repo-check', '-C', projectPath,
          ...(resolve(projectPath) === resolve(dirname(deckPath))
            ? [] : ['--add-dir', dirname(deckPath)]),
          '-',
        ],
      };
}

function codexProgress(event) {
  if (event?.type === 'thread.started') return 'Codex 任务已启动';
  if (event?.type === 'turn.started') return 'Codex 正在读取并处理反馈';
  if (event?.type === 'turn.completed') return 'Codex 已完成本批处理';
  if (event?.type === 'turn.failed') return 'Codex 本轮执行失败';
  if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
    const text = String(event.item.text ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 240) : undefined;
  }
  return undefined;
}

function collectJsonLines(stream, onEvent, onOverflow) {
  let buffered = '';
  let bytes = 0;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_OUTPUT_BYTES) {
      onOverflow();
      return;
    }
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* Codex stderr 可包含普通诊断文本 */ }
    }
  });
}

export function createCodexAdapter({
  sourceThreadId = null,
  initialConnection = null,
  persistConnection = async connection => ({ connection }),
  executable = 'codex',
  spawnProcess = spawn,
  timeoutMs = 20 * 60 * 1000,
  killGraceMs = 1_000,
} = {}) {
  let connection = resolveAgentConnection({
    provider:'codex', launchThreadId:sourceThreadId, persistedConnection:initialConnection,
  });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Agent timeoutMs 必须为正整数');
  }
  const adapter = {
    id:'codex',
    get sourceThreadId() { return connection.threadId; },
    get connection() { return publicConnection(connection); },
    get mode() { return connection.threadId ? 'resume' : 'new'; },
    async configure({
      threadId, projectPath = null, source = 'manual', skillStatus = 'unknown',
    }, options = {}) {
      const next = source === 'manual'
        ? manualAgentConnection({ provider:'codex', threadId, projectPath, skillStatus })
        : normalizeAgentConnection({
            version:1, provider:'codex', threadId, projectPath, source,
            skillStatus, updatedAt:new Date().toISOString(),
          });
      const persisted = await persistConnection(next, options);
      connection = normalizeAgentConnection(persisted?.connection ?? next, { provider:'codex' });
      return { connection:adapter.connection, revision:persisted?.revision };
    },
    async run(context) {
      const sessionId = connection.threadId;
      const projectPath = context.projectPath ?? connection.projectPath ?? dirname(context.deckPath);
      const { mode, args } = buildCodexInvocation({
        deckPath:context.deckPath, sourceThreadId:sessionId, projectPath,
      });
      const prompt = context.initializeSession
        ? buildSessionInitializationPrompt({
            deckPath:context.deckPath, projectPath, skillInvocation:'$huawei-deck',
          })
        : buildAgentPrompt({
            ...context,
            sourceThreadId:sessionId,
            loadSkill:mode === 'new' || !['loaded', 'detected'].includes(connection.skillStatus),
          });
      context.onProgress?.({ mode, message:mode === 'resume'
        ? '正在继续本 Deck 已绑定的 Codex 任务'
        : '正在启动 Codex 专用任务并加载一次 huawei-deck skill' });
      let discoveredThreadId = null;
      let executionError = null;
      await new Promise((resolvePromise, reject) => {
        let settled = false;
        let overflowed = false;
        const child = spawnProcess(executable, args, {
          cwd:projectPath,
          env:process.env,
          stdio:['pipe', 'pipe', 'pipe'],
        });
        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolvePromise();
        };
        const terminate = error => {
          if (settled) return;
          child.kill('SIGTERM');
          const killer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
          killer.unref?.();
          finish(error);
        };
        const abort = () => terminate(runnerError('AGENT_RUN_CANCELLED', 409, 'Agent 任务已取消'));
        const timer = setTimeout(() => terminate(
          runnerError('AGENT_RUN_TIMEOUT', 504, 'Agent 批处理超时'),
        ), timeoutMs);
        timer.unref?.();
        context.signal?.addEventListener('abort', abort, { once:true });
        collectJsonLines(child.stdout, event => {
          if (mode === 'new' && event?.type === 'thread.started'
            && typeof event.thread_id === 'string' && UUID.test(event.thread_id)) {
            discoveredThreadId = event.thread_id;
          }
          const message = codexProgress(event);
          if (message) context.onProgress?.({ mode, message });
        }, () => {
          if (overflowed) return;
          overflowed = true;
          terminate(runnerError('AGENT_OUTPUT_TOO_LARGE', 500, 'Agent 输出超过安全上限'));
        });
        collectJsonLines(child.stderr, () => {}, () => {
          if (overflowed) return;
          overflowed = true;
          terminate(runnerError('AGENT_OUTPUT_TOO_LARGE', 500, 'Agent 输出超过安全上限'));
        });
        child.once('error', error => finish(error.code === 'ENOENT'
          ? runnerError('AGENT_NOT_FOUND', 503, '找不到 codex 命令，请先安装并登录 Codex CLI')
          : runnerError('AGENT_START_FAILED', 500, `无法启动 Codex：${error.message}`)));
        child.once('close', (code, signal) => {
          if (settled) return;
          if (code === 0) finish();
          else finish(runnerError(
            'AGENT_RUN_FAILED', 500,
            `Codex 异常退出（${signal ? `signal ${signal}` : `code ${code}`}）`,
          ));
        });
        child.stdin.on('error', error => finish(
          runnerError('AGENT_START_FAILED', 500, `无法发送 Agent 任务：${error.message}`),
        ));
        child.stdin.end(prompt);
      }).catch(error => { executionError = error; });
      if (mode === 'new' && discoveredThreadId) {
        await adapter.configure({
          threadId:discoveredThreadId, projectPath,
          source:'created', skillStatus:'loaded',
        });
      }
      if (executionError) throw executionError;
      if (mode === 'new' && !discoveredThreadId) {
        throw runnerError(
          'AGENT_SESSION_ID_MISSING', 500,
          'Codex 新任务未返回可续用的 thread ID，拒绝丢失后续上下文',
        );
      }
      if (mode === 'resume' && !['loaded', 'detected'].includes(connection.skillStatus)) {
        await adapter.configure({
          threadId:connection.threadId, projectPath:connection.projectPath,
          source:connection.source, skillStatus:'loaded',
        });
      }
      return { mode, summary:'Agent 已完成本批处理，请在编辑器中检查结果' };
    },
  };
  return adapter;
}

function createJsonCliAdapter({
  id,
  name,
  executable,
  initialConnection = null,
  persistConnection = async connection => ({ connection }),
  spawnProcess = spawn,
  timeoutMs = 20 * 60 * 1000,
  killGraceMs = 1_000,
  skillInvocation,
  invocation,
  sessionIdFromEvent = () => null,
  progressFromEvent = () => null,
}) {
  let connection = normalizeAgentConnection(
    initialConnection?.provider === id ? initialConnection : null,
    { provider:id },
  );
  const adapter = {
    id,
    get sourceThreadId() { return connection.threadId; },
    get connection() { return publicConnection(connection); },
    get mode() { return connection.threadId ? 'resume' : 'new'; },
    async configure({
      threadId, projectPath = null, source = 'manual', skillStatus = 'unknown',
    }, options = {}) {
      const next = source === 'manual'
        ? manualAgentConnection({ provider:id, threadId, projectPath, skillStatus })
        : normalizeAgentConnection({
            version:1, provider:id, threadId, projectPath, source,
            skillStatus, updatedAt:new Date().toISOString(),
          }, { provider:id });
      const persisted = await persistConnection(next, options);
      connection = normalizeAgentConnection(persisted?.connection ?? next, { provider:id });
      return { connection:adapter.connection, revision:persisted?.revision };
    },
    async run(context) {
      const originalConnection = connection;
      const projectPath = context.projectPath ?? connection.projectPath ?? dirname(context.deckPath);
      const loadSkill = !['loaded', 'detected'].includes(connection.skillStatus);
      const prompt = context.initializeSession
        ? buildSessionInitializationPrompt({
            deckPath:context.deckPath, projectPath, skillInvocation,
          })
        : buildAgentPrompt({
            ...context,
            sourceThreadId:connection.threadId,
            loadSkill,
            skillInvocation,
            environmentCredentials:true,
          });
      const command = invocation({
        deckPath:context.deckPath,
        projectPath,
        sessionId:connection.threadId,
        prompt,
      });
      context.onProgress?.({
        mode:command.mode,
        message:command.mode === 'resume'
          ? `正在继续已选择的 ${name} 会话`
          : `正在启动 ${name} 专用会话并加载一次 huawei-deck skill`,
      });
      let discoveredSessionId = command.sessionId ?? null;
      let output = '';
      let executionError = null;
      await new Promise((resolvePromise, reject) => {
        let settled = false;
        let bytes = 0;
        let lineBuffer = '';
        const child = spawnProcess(executable, command.args, {
          cwd:projectPath,
          env:{
            ...process.env,
            HUAWEI_DECK_EDITOR_URL:context.serviceUrl,
            HUAWEI_DECK_EDITOR_TOKEN:context.token,
          },
          stdio:['pipe', 'pipe', 'pipe'],
        });
        const consumeEvent = event => {
          discoveredSessionId ??= sessionIdFromEvent(event);
          const message = progressFromEvent(event);
          if (message) context.onProgress?.({ mode:command.mode, message });
        };
        const consumeChunk = chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_OUTPUT_BYTES) {
            terminate(runnerError('AGENT_OUTPUT_TOO_LARGE', 500, 'Agent 输出超过安全上限'));
            return;
          }
          output += chunk;
          lineBuffer += chunk;
          for (;;) {
            const newline = lineBuffer.indexOf('\n');
            if (newline < 0) break;
            const line = lineBuffer.slice(0, newline).trim();
            lineBuffer = lineBuffer.slice(newline + 1);
            if (!line) continue;
            try { consumeEvent(JSON.parse(line)); } catch { /* CLI 可混入普通诊断文本 */ }
          }
        };
        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal?.removeEventListener('abort', abort);
          const remainder = lineBuffer.trim();
          if (remainder) {
            try { consumeEvent(JSON.parse(remainder)); } catch { /* 非 JSON 尾行忽略 */ }
          }
          if (error) reject(error);
          else resolvePromise();
        };
        const terminate = error => {
          if (settled) return;
          child.kill('SIGTERM');
          const killer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
          killer.unref?.();
          finish(error);
        };
        const abort = () => terminate(runnerError('AGENT_RUN_CANCELLED', 409, 'Agent 任务已取消'));
        const timer = setTimeout(() => terminate(
          runnerError('AGENT_RUN_TIMEOUT', 504, 'Agent 批处理超时'),
        ), timeoutMs);
        timer.unref?.();
        context.signal?.addEventListener('abort', abort, { once:true });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', consumeChunk);
        child.stderr.on('data', consumeChunk);
        child.once('error', error => finish(error.code === 'ENOENT'
          ? runnerError('AGENT_NOT_FOUND', 503, `找不到 ${executable} 命令，请先安装并登录 ${name}`)
          : runnerError('AGENT_START_FAILED', 500, `无法启动 ${name}：${error.message}`)));
        child.once('close', (code, signal) => {
          if (settled) return;
          if (code === 0) finish();
          else finish(runnerError(
            'AGENT_RUN_FAILED', 500,
            `${name} 异常退出（${signal ? `signal ${signal}` : `code ${code}`}）`,
          ));
        });
        child.stdin.on('error', error => finish(
          runnerError('AGENT_START_FAILED', 500, `无法发送 Agent 任务：${error.message}`),
        ));
        child.stdin.end(command.stdin ?? '');
      }).catch(error => { executionError = error; });

      if (command.mode === 'new' && discoveredSessionId) {
        await adapter.configure({
          threadId:discoveredSessionId, projectPath,
          source:'created', skillStatus:'loaded',
        });
      }
      if (executionError) throw executionError;
      if (command.mode === 'new' && !discoveredSessionId) {
        throw runnerError(
          'AGENT_SESSION_ID_MISSING', 500,
          `${name} 新会话未返回可续用的 session ID，拒绝丢失后续上下文`,
        );
      }
      if (command.mode === 'resume' && loadSkill) {
        await adapter.configure({
          threadId:originalConnection.threadId,
          projectPath:originalConnection.projectPath,
          source:originalConnection.source,
          skillStatus:'loaded',
        });
      }
      return { mode:command.mode, summary:'Agent 已完成本批处理，请在编辑器中检查结果' };
    },
  };
  return adapter;
}

export function createClaudeAdapter(options = {}) {
  return createJsonCliAdapter({
    ...options,
    id:'claude-code', name:'Claude Code', executable:options.executable ?? 'claude',
    skillInvocation:'请先读取并遵循 huawei-deck 的 SKILL.md。',
    invocation:({ deckPath, projectPath, sessionId, prompt }) => {
      const nextSessionId = sessionId ?? randomUUID();
      const additionalDirectories = [SKILL_ROOT];
      if (resolve(projectPath) !== resolve(dirname(deckPath))) {
        additionalDirectories.push(dirname(deckPath));
      }
      return {
        mode:sessionId ? 'resume' : 'new',
        sessionId:nextSessionId,
        args:[
          '--print', '--output-format', 'stream-json', '--verbose',
          '--permission-mode', 'acceptEdits', '--add-dir', ...additionalDirectories,
          ...(sessionId ? ['--resume', sessionId] : ['--session-id', nextSessionId]),
        ],
        stdin:prompt,
      };
    },
    sessionIdFromEvent:event => event?.session_id ?? null,
    progressFromEvent:event => event?.type === 'assistant'
      ? String(textFromClaudeEvent(event)).replace(/\s+/g, ' ').trim().slice(0, 240)
      : null,
  });
}

function textFromClaudeEvent(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter(item => item?.type === 'text').map(item => item.text).join(' ');
}

export function createOpenCodeAdapter(options = {}) {
  return createJsonCliAdapter({
    ...options,
    id:'opencode', name:'OpenCode', executable:options.executable ?? 'opencode',
    skillInvocation:'请调用 skill 工具加载 huawei-deck。',
    invocation:({ projectPath, sessionId, prompt }) => ({
      mode:sessionId ? 'resume' : 'new',
      args:[
        'run', '--format', 'json', '--dir', projectPath,
        ...(sessionId ? ['--session', sessionId] : []),
        prompt,
      ],
      stdin:'',
    }),
    sessionIdFromEvent:event => event?.sessionID ?? event?.sessionId ?? event?.session_id ?? null,
    progressFromEvent:event => {
      const text = event?.part?.text ?? event?.text;
      return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 240) : null;
    },
  });
}

export function createOpenClawAdapter(options = {}) {
  return createJsonCliAdapter({
    ...options,
    id:'openclaw', name:'OpenClaw', executable:options.executable ?? 'openclaw',
    skillInvocation:'请加载并使用 huawei-deck skill。',
    invocation:({ sessionId, prompt }) => {
      const nextSessionId = sessionId ?? randomUUID();
      return {
        mode:sessionId ? 'resume' : 'new',
        sessionId:nextSessionId,
        args:[
          'agent', '--session-id', nextSessionId, '--message', prompt,
          '--json', '--timeout', String(Math.ceil((options.timeoutMs ?? 20 * 60 * 1000) / 1000)),
        ],
        stdin:'',
      };
    },
    sessionIdFromEvent:event => event?.sessionId ?? event?.session_id ?? null,
    progressFromEvent:event => {
      const text = event?.result?.payloads?.[0]?.text ?? event?.text;
      return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 240) : null;
    },
  });
}

export function createAgentRouter({
  initialConnection = null,
  persistConnection = async connection => ({ connection }),
  spawnProcess = spawn,
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  const shared = { persistConnection, spawnProcess, timeoutMs };
  const factories = new Map([
    ['codex', connection => createCodexAdapter({ ...shared, initialConnection:connection })],
    ['claude-code', connection => createClaudeAdapter({ ...shared, initialConnection:connection })],
    ['opencode', connection => createOpenCodeAdapter({ ...shared, initialConnection:connection })],
    ['openclaw', connection => createOpenClawAdapter({ ...shared, initialConnection:connection })],
  ]);
  const adapters = new Map([...factories].map(([id, factory]) => [
    id, factory(initialConnection?.provider === id ? initialConnection : null),
  ]));
  let active = adapters.get(initialConnection?.provider ?? 'codex');
  return {
    id:'agent-router',
    get connection() { return active.connection; },
    get sourceThreadId() { return active.sourceThreadId; },
    get mode() { return active.mode; },
    async configure({ provider = active.id, ...configuration }, options = {}) {
      const next = adapters.get(provider);
      if (!next) throw runnerError('AGENT_PROVIDER_UNAVAILABLE', 400, `未知 Agent provider：${provider}`);
      const result = await next.configure(configuration, options);
      active = next;
      return result;
    },
    async createSession({ provider = active.id, projectPath }, context) {
      const factory = factories.get(provider);
      if (!factory) {
        throw runnerError('AGENT_PROVIDER_UNAVAILABLE', 400, `未知 Agent provider：${provider}`);
      }
      const next = factory(null);
      await next.run({
        ...context,
        projectPath,
        initializeSession:true,
        taskIds:[],
      });
      active = next;
      adapters.set(provider, next);
      return { connection:active.connection };
    },
    run(context) { return active.run(context); },
  };
}

export class AgentRunCoordinator {
  constructor({ provider, adapter, getSession, getContext, onUpdate = () => {} }) {
    if (!adapter || adapter.id !== provider || typeof adapter.run !== 'function') {
      throw new TypeError('Agent adapter 与 provider 不匹配');
    }
    this.provider = provider;
    this.adapter = adapter;
    this.getSession = getSession;
    this.getContext = getContext;
    this.onUpdate = onUpdate;
    this.current = null;
    this.activePromise = null;
    this.abortController = null;
    this.closed = false;
    this.runGeneration = 0;
  }

  snapshot() { return publicRun(this.current); }

  #publish(patch = {}) {
    Object.assign(this.current, patch, {
      sequence:(this.current.sequence ?? 0) + 1,
      updatedAt:new Date().toISOString(),
    });
    const snapshot = this.snapshot();
    this.onUpdate(snapshot);
    return snapshot;
  }

  start({ expectedRevision, taskIds }) {
    if (this.closed) throw runnerError('SERVICE_CLOSED', 503, '编辑服务已关闭');
    if (this.current && ACTIVE_STATUSES.has(this.current.status)) {
      throw runnerError('AGENT_RUN_ACTIVE', 409, '已有一批反馈正在交给 Agent 处理');
    }
    const session = this.getSession();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision 必须为非负整数');
    }
    if (expectedRevision !== session.revision) {
      const error = runnerError('REVISION_CONFLICT', 409, '任务列表已经变化，请刷新后重试');
      error.revision = session.revision;
      throw error;
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0
      || taskIds.some(id => typeof id !== 'string' || !id)
      || new Set(taskIds).size !== taskIds.length) {
      throw new TypeError('taskIds 必须是非空且不重复的字符串数组');
    }
    const tasks = new Map(session.tasks.map(task => [task.id, task]));
    if (taskIds.some(id => !tasks.has(id))) {
      throw runnerError('TASK_NOT_FOUND', 404, '本批任务中包含不存在的任务');
    }
    if (taskIds.some(id => !RETRYABLE_TASK_STATUSES.has(tasks.get(id).status))) {
      throw runnerError('TASK_NOT_PENDING', 409, '本批任务中包含无需再次处理的任务');
    }
    const now = new Date().toISOString();
    this.current = {
      id:randomUUID(), provider:this.adapter.connection?.provider ?? this.provider, status:'queued',
      generation:this.runGeneration += 1,
      mode:this.adapter.mode ?? (this.adapter.sourceThreadId ? 'resume' : 'new'),
      taskIds:[...taskIds], taskCount:taskIds.length,
      expectedRevision, createdAt:now, updatedAt:now,
      sequence:0,
      message:'反馈已提交，正在启动 Agent',
    };
    this.onUpdate(this.snapshot());
    this.abortController = new AbortController();
    const runId = this.current.id;
    this.activePromise = Promise.resolve().then(async () => {
      if (this.closed) throw runnerError('AGENT_RUN_CANCELLED', 409, 'Agent 任务已取消');
      this.#publish({ status:'running', startedAt:new Date().toISOString() });
      const result = await this.adapter.run({
        ...this.getContext(),
        taskIds:[...taskIds],
        signal:this.abortController.signal,
        onProgress:progress => {
          if (this.current?.id !== runId || this.closed) return;
          this.#publish({
            ...(progress?.mode ? { mode:progress.mode } : {}),
            ...(progress?.message ? { message:String(progress.message).slice(0, 500) } : {}),
          });
        },
      });
      if (this.current?.id !== runId) return;
      this.#publish({
        status:'succeeded', finishedAt:new Date().toISOString(),
        message:result?.summary || 'Agent 已完成本批处理',
      });
    }).catch(error => {
      if (this.current?.id !== runId) return;
      const cancelled = error?.code === 'AGENT_RUN_CANCELLED' || this.closed;
      this.#publish({
        status:cancelled ? 'cancelled' : 'failed',
        finishedAt:new Date().toISOString(),
        code:error?.code ?? 'AGENT_RUN_FAILED',
        message:cancelled ? 'Agent 任务已取消' : (error?.message || 'Agent 批处理失败'),
      });
    }).finally(() => {
      if (this.current?.id === runId) this.abortController = null;
    });
    return this.snapshot();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abortController?.abort();
    await this.activePromise?.catch(() => {});
  }
}
