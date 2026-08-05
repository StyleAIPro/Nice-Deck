import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// 防止损坏的本地目录拖垮编辑器，同时覆盖正常使用下的完整会话列表。
const SESSION_LIMIT = 500;
const SKILL_MARKERS = [
  '$huawei-deck',
  '/huawei-deck',
  'huawei-deck/skill.md',
  'skills/huawei-deck',
  '"name":"huawei-deck"',
  '"name": "huawei-deck"',
];

function catalogError(code, message, cause) {
  return Object.assign(new Error(message), { code, cause });
}

function containsSkillEvidence(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = text.toLowerCase();
  return SKILL_MARKERS.some(marker => normalized.includes(marker));
}

function timestamp(value, fallback = null) {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return fallback;
}

function textFromMessage(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromMessage).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if ('content' in value) return textFromMessage(value.content);
  return '';
}

function cleanTitle(value, fallback) {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (title || fallback).slice(0, 160);
}

function runJsonCommand(executable, args, {
  spawnProcess = spawn, cwd, env = process.env, timeoutMs = 8_000,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    const child = spawnProcess(executable, args, {
      cwd, env, stdio:['ignore', 'pipe', 'pipe'],
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const append = (target, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish(catalogError('SESSION_CATALOG_TOO_LARGE', 'Agent 会话目录输出超过安全上限'));
        return target;
      }
      return target + chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', error => finish(error.code === 'ENOENT'
      ? catalogError('AGENT_NOT_INSTALLED', `未安装 ${executable}`, error)
      : catalogError('SESSION_CATALOG_FAILED', `${executable} 会话目录启动失败`, error)));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) {
        finish(catalogError(
          'SESSION_CATALOG_FAILED',
          `${executable} 会话目录读取失败${stderr.trim() ? `：${stderr.trim().slice(0, 240)}` : ''}`,
        ));
        return;
      }
      try { finish(null, JSON.parse(stdout)); }
      catch (error) {
        finish(catalogError('SESSION_CATALOG_INVALID', `${executable} 返回的会话目录不是有效 JSON`, error));
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(catalogError('SESSION_CATALOG_TIMEOUT', `${executable} 会话目录读取超时`));
    }, timeoutMs);
    timer.unref?.();
  });
}

class CodexAppServerClient {
  constructor({ executable = 'codex', spawnProcess = spawn, timeoutMs = 8_000 } = {}) {
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
  }

  async request(method, params) {
    const child = this.spawnProcess(this.executable, ['app-server', '--listen', 'stdio://'], {
      env:process.env, stdio:['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let outputBytes = 0;
    const pending = new Map();
    const close = () => {
      child.stdin.end();
      child.kill('SIGTERM');
    };
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const waitFor = id => new Promise((resolvePromise, reject) => pending.set(id, {
      resolve:resolvePromise, reject,
    }));
    const failure = error => {
      if (settled) return;
      settled = true;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      close();
    };
    child.once('error', error => failure(error.code === 'ENOENT'
      ? catalogError('AGENT_NOT_INSTALLED', '未安装 codex', error)
      : catalogError('SESSION_CATALOG_FAILED', 'Codex app-server 启动失败', error)));
    child.once('close', code => {
      if (!settled && pending.size) failure(catalogError(
        'SESSION_CATALOG_FAILED', `Codex app-server 提前退出（code ${code}）`,
      ));
    });
    const lines = createInterface({ input:child.stdout });
    lines.on('line', line => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        failure(catalogError('SESSION_CATALOG_TOO_LARGE', 'Codex 会话目录输出超过安全上限'));
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(catalogError(
        'SESSION_CATALOG_FAILED', message.error.message ?? 'Codex app-server 请求失败',
      ));
      else waiter.resolve(message.result);
    });
    const timer = setTimeout(() => failure(
      catalogError('SESSION_CATALOG_TIMEOUT', 'Codex 会话目录读取超时'),
    ), this.timeoutMs);
    timer.unref?.();
    try {
      const initialized = waitFor(1);
      send({ method:'initialize', id:1, params:{
        clientInfo:{ name:'huawei_deck_editor', title:'Huawei Deck 编辑器', version:'1' },
      } });
      await initialized;
      send({ method:'initialized', params:{} });
      const response = waitFor(2);
      send({ method, id:2, params });
      const result = await response;
      settled = true;
      clearTimeout(timer);
      close();
      return result;
    } catch (error) {
      failure(error);
      throw error;
    }
  }
}

function codexAdapter(options = {}) {
  const client = new CodexAppServerClient(options);
  return {
    id:'codex', name:'Codex',
    async list(limit) {
      const result = await client.request('thread/list', {
        limit,
        sortKey:'updated_at',
        sortDirection:'desc',
        sourceKinds:['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      });
      return (result?.data ?? []).map(thread => ({
        provider:'codex',
        id:thread.id,
        title:cleanTitle(thread.name ?? thread.preview, '未命名 Codex 任务'),
        preview:cleanTitle(thread.preview, ''),
        cwd:typeof thread.cwd === 'string' ? thread.cwd : null,
        model:thread.model ?? thread.modelProvider ?? null,
        updatedAt:timestamp(thread.updatedAt ?? thread.createdAt),
        runtimeStatus:thread.status?.type ?? 'unknown',
        skillStatus:containsSkillEvidence([thread.name, thread.preview]) ? 'detected' : 'unknown',
      }));
    },
    async inspectSkill(sessionId) {
      const result = await client.request('thread/read', { threadId:sessionId, includeTurns:true });
      return containsSkillEvidence(result?.thread) ? 'detected' : 'not-detected';
    },
  };
}

async function claudeFiles(configRoot) {
  const projects = join(configRoot, 'projects');
  let directories;
  try { directories = await readdir(projects, { withFileTypes:true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const root = join(projects, directory.name);
    for (const entry of await readdir(root, { withFileTypes:true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(root, entry.name);
      const info = await stat(path);
      files.push({ path, mtime:info.mtime.toISOString(), bytes:info.size });
    }
  }
  return files.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

async function scanClaudeSession(file, { stopAfterSkill = false } = {}) {
  const session = {
    provider:'claude-code', id:basename(file.path, '.jsonl'),
    title:'未命名 Claude Code 会话', preview:'', cwd:null, model:null,
    updatedAt:file.mtime, runtimeStatus:'stored', skillStatus:'not-detected',
  };
  let customTitle = '';
  let firstPrompt = '';
  const lines = createInterface({ input:createReadStream(file.path, { encoding:'utf8' }) });
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.sessionId === 'string') session.id = entry.sessionId;
    if (!session.cwd && typeof entry.cwd === 'string') session.cwd = entry.cwd;
    if (!session.model && typeof entry.message?.model === 'string') session.model = entry.message.model;
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      customTitle = entry.customTitle;
    }
    if (!firstPrompt && entry.type === 'user') {
      firstPrompt = textFromMessage(entry.message).replace(/\s+/g, ' ').trim();
    }
    if (containsSkillEvidence(entry)) {
      session.skillStatus = 'detected';
      if (stopAfterSkill) break;
    }
  }
  session.preview = cleanTitle(firstPrompt, '');
  session.title = cleanTitle(customTitle || firstPrompt, '未命名 Claude Code 会话');
  return session;
}

function claudeAdapter({ configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude') } = {}) {
  return {
    id:'claude-code', name:'Claude Code',
    async list(limit) {
      const files = (await claudeFiles(configRoot)).slice(0, limit);
      return Promise.all(files.map(file => scanClaudeSession(file)));
    },
    async inspectSkill(sessionId) {
      const file = (await claudeFiles(configRoot)).find(candidate => (
        basename(candidate.path, '.jsonl') === sessionId
      ));
      if (!file) throw catalogError('SESSION_NOT_FOUND', '找不到 Claude Code 会话');
      return (await scanClaudeSession(file, { stopAfterSkill:true })).skillStatus;
    },
  };
}

function openCodeAdapter(options = {}) {
  return {
    id:'opencode', name:'OpenCode',
    async list(limit) {
      const rows = await runJsonCommand(
        'opencode', ['session', 'list', '--format', 'json', '--max-count', String(limit)], options,
      );
      return (Array.isArray(rows) ? rows : rows?.sessions ?? []).map(session => ({
        provider:'opencode',
        id:String(session.id ?? session.sessionID ?? session.sessionId),
        title:cleanTitle(session.title ?? session.name, '未命名 OpenCode 会话'),
        preview:'',
        cwd:session.directory ?? session.cwd ?? null,
        model:session.model ?? null,
        updatedAt:timestamp(session.time?.updated ?? session.updatedAt ?? session.updated),
        runtimeStatus:'stored',
        skillStatus:'unknown',
      })).filter(session => session.id && session.id !== 'undefined');
    },
    async inspectSkill(sessionId) {
      const value = await runJsonCommand('opencode', ['export', sessionId, '--sanitize'], options);
      return containsSkillEvidence(value) ? 'detected' : 'not-detected';
    },
  };
}

function openClawAdapter(options = {}) {
  return {
    id:'openclaw', name:'OpenClaw',
    async list(limit) {
      const value = await runJsonCommand('openclaw', ['sessions', '--json'], options);
      return (value?.sessions ?? []).slice(0, limit).map(session => ({
        provider:'openclaw',
        id:String(session.sessionId ?? session.key),
        title:cleanTitle(session.key, '未命名 OpenClaw 会话'),
        preview:'',
        cwd:null,
        model:session.model ?? null,
        updatedAt:timestamp(session.updatedAt, session.ageMs
          ? new Date(Date.now() - session.ageMs).toISOString() : null),
        runtimeStatus:session.abortedLastRun ? 'failed' : 'stored',
        skillStatus:'unknown',
      })).filter(session => session.id && session.id !== 'undefined');
    },
    async inspectSkill() { return 'unknown'; },
  };
}

export function createAgentSessionCatalog({ adapters, limit = SESSION_LIMIT, ...options } = {}) {
  const availableAdapters = adapters ?? [
    codexAdapter(options.codex),
    claudeAdapter(options.claude),
    openCodeAdapter(options.opencode),
    openClawAdapter(options.openclaw),
  ];
  const byId = new Map(availableAdapters.map(adapter => [adapter.id, adapter]));
  return {
    async list() {
      const results = await Promise.all(availableAdapters.map(async adapter => {
        try {
          return { provider:{ id:adapter.id, name:adapter.name, available:true }, sessions:await adapter.list(limit) };
        } catch (error) {
          return {
            provider:{
              id:adapter.id, name:adapter.name, available:false,
              reason:error.code === 'AGENT_NOT_INSTALLED' ? '未安装' : '读取失败',
            },
            sessions:[],
          };
        }
      }));
      return {
        version:1,
        providers:results.map(result => result.provider),
        sessions:results.flatMap(result => result.sessions).sort((a, b) => (
          String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
        )),
      };
    },
    async inspectSkill(provider, sessionId) {
      const adapter = byId.get(provider);
      if (!adapter) throw catalogError('AGENT_PROVIDER_UNAVAILABLE', `未知 Agent provider：${provider}`);
      return { provider, sessionId, skillStatus:await adapter.inspectSkill(sessionId) };
    },
  };
}

export { containsSkillEvidence };
