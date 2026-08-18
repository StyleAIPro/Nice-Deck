import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveEditorStateRoot } from './editor-state-root.mjs';

const execFileAsync = promisify(execFile);
const EDITOR_DIR = resolve(fileURLToPath(import.meta.url), '..');
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');
const PATH_ENVIRONMENT_KEYS = Object.freeze([
  'HUAWEI_DECK_SOURCE_PATH',
  'HUAWEI_DECK_WORKING_PATH',
  'HUAWEI_DECK_CREATION_CONTEXT',
  'HUAWEI_DECK_CREATION_MATERIALS',
  'HUAWEI_DECK_CREATION_PLAN',
  'HUAWEI_DECK_CREATION_CAPABILITY_FILE',
]);
const VALUE_ENVIRONMENT_KEYS = Object.freeze([
  'HUAWEI_DECK_EDITOR_URL',
  'HUAWEI_DECK_EDITOR_TOKEN',
  'HUAWEI_DECK_CREATION_URL',
]);

function runtimeError(code, message, cause = null) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function normalizeSettings(value) {
  if (value === null || value === undefined) return { codexRuntime:'native' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', '本机 Agent 配置必须是 JSON 对象');
  }
  const codexRuntime = value.codexRuntime ?? 'native';
  if (!['native', 'wsl'].includes(codexRuntime)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', 'codexRuntime 只支持 native 或 wsl');
  }
  if (codexRuntime === 'native') return { codexRuntime:'native' };
  const distribution = value.wslDistribution;
  const user = value.wslUser;
  if (typeof distribution !== 'string' || !distribution.trim()
    || distribution.length > 128 || /[\0-\x1f\x7f]/.test(distribution)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', 'WSL 发行版名称无效');
  }
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,63}$/i.test(user)) {
    throw runtimeError('INVALID_AGENT_RUNTIME_SETTINGS', 'WSL 用户名无效');
  }
  return {
    codexRuntime:'wsl',
    wslDistribution:distribution,
    wslUser:user,
  };
}

export function agentRuntimeSettingsPath({ environment = process.env } = {}) {
  return join(resolveEditorStateRoot({ environment }), 'settings.json');
}

export function loadAgentRuntimeSettings({
  environment = process.env,
  settingsPath = agentRuntimeSettingsPath({ environment }),
} = {}) {
  if (!existsSync(settingsPath)) return { codexRuntime:'native' };
  let value;
  try { value = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (error) {
    throw runtimeError(
      'INVALID_AGENT_RUNTIME_SETTINGS',
      `无法读取本机 Agent 配置 ${settingsPath}：${error.message}`,
      error,
    );
  }
  return normalizeSettings(value);
}

async function defaultRunWsl(args, {
  wslExecutable = 'wsl.exe',
  environment = process.env,
} = {}) {
  try {
    const { stdout } = await execFileAsync(wslExecutable, args, {
      env:environment,
      encoding:'utf8',
      timeout:10_000,
      maxBuffer:2 * 1024 * 1024,
      windowsHide:true,
    });
    return stdout;
  } catch (error) {
    throw runtimeError(
      error.code === 'ENOENT' ? 'WSL_NOT_FOUND' : 'WSL_COMMAND_FAILED',
      error.code === 'ENOENT'
        ? '找不到 wsl.exe，请先启用 Windows Subsystem for Linux'
        : `WSL Codex 环境检查失败：${String(error.stderr || error.message).trim()}`,
      error,
    );
  }
}

function outputLine(stdout, predicate, message) {
  const line = String(stdout ?? '').split(/\r?\n/).map(value => value.trim())
    .filter(Boolean).findLast(predicate);
  if (!line) throw runtimeError('WSL_CODEX_INVALID_OUTPUT', message);
  return line;
}

function appendWslenv(environment) {
  const additions = [];
  for (const key of VALUE_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && environment[key]) additions.push(key);
  }
  for (const key of PATH_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && environment[key]) additions.push(`${key}/p`);
  }
  const entries = String(environment.WSLENV ?? '').split(':').filter(Boolean);
  const known = new Set(entries.map(entry => entry.split('/')[0]));
  for (const entry of additions) {
    const key = entry.split('/')[0];
    if (!known.has(key)) {
      entries.push(entry);
      known.add(key);
    }
  }
  return entries.join(':');
}

function translatePrompt(text, mappings) {
  let translated = String(text);
  const ordered = [...mappings.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [windowsPath, wslPath] of ordered) {
    translated = translated.replaceAll(windowsPath, wslPath);
    translated = translated.replaceAll(windowsPath.replaceAll('\\', '/'), wslPath);
    // 根路径替换后，后续文件片段仍可能沿用 Windows 反斜杠。
    const escaped = wslPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    translated = translated.replace(
      new RegExp(`${escaped}[^\\s\\r\\n"'，。；：）】]*`, 'g'),
      value => value.replaceAll('\\', '/'),
    );
  }
  return translated;
}

function wslArguments(settings, ...tail) {
  return [
    '-d', settings.wslDistribution,
    '-u', settings.wslUser,
    ...tail,
  ];
}

export async function prepareAgentTerminalRuntime(provider, {
  platform = process.platform,
  settings = loadAgentRuntimeSettings(),
  environment = process.env,
  projectRoot = process.cwd(),
  cwd = projectRoot,
  pathRoots = [PROJECT_DIR],
  runWsl = defaultRunWsl,
  wslExecutable = 'wsl.exe',
} = {}) {
  const normalized = normalizeSettings(settings);
  if (provider !== 'codex' || platform !== 'win32' || normalized.codexRuntime !== 'wsl') {
    return null;
  }
  const callWsl = args => runWsl(args, { wslExecutable, environment });
  const codexOutput = await callWsl(wslArguments(
    normalized,
    '--exec', 'bash', '-lic', 'command -v codex',
  ));
  const codexExecutable = outputLine(
    codexOutput,
    line => line.startsWith('/') && !/[\0\r\n]/.test(line),
    `WSL ${normalized.wslDistribution}/${normalized.wslUser} 的登录环境中找不到 codex`,
  );
  const nodeOutput = await callWsl(wslArguments(
    normalized,
    '--exec', 'bash', '-lic', 'command -v node',
  ));
  const nodeExecutable = outputLine(
    nodeOutput,
    line => line.startsWith('/') && !/[\0\r\n]/.test(line),
    `WSL ${normalized.wslDistribution}/${normalized.wslUser} 的登录环境中找不到 node`,
  );
  const homeOutput = await callWsl(wslArguments(
    normalized,
    '--exec', 'printenv', 'HOME',
  ));
  const wslHome = outputLine(
    homeOutput,
    line => line.startsWith('/') && !/[\0\r\n]/.test(line),
    '无法确定 WSL 用户 HOME',
  );

  const candidates = new Set([projectRoot, cwd, ...pathRoots]);
  for (const key of PATH_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && environment[key]) candidates.add(environment[key]);
  }
  const mappings = new Map();
  for (const windowsPath of candidates) {
    if (typeof windowsPath !== 'string' || !win32.isAbsolute(windowsPath)) continue;
    const stdout = await callWsl(wslArguments(
      normalized,
      '--exec', 'wslpath', '-a', '-u', windowsPath,
    ));
    const mapped = outputLine(
      stdout,
      line => line.startsWith('/') && !/[\0\r\n]/.test(line),
      `无法把 Windows 路径转换为 WSL 路径：${windowsPath}`,
    );
    mappings.set(windowsPath, mapped);
  }
  const wslCwd = mappings.get(cwd);
  const wslProjectRoot = mappings.get(projectRoot);
  const wslEditorRoot = [...pathRoots].map(value => mappings.get(value)).find(Boolean);
  if (!wslCwd || !wslProjectRoot || !wslEditorRoot) {
    throw runtimeError('WSL_PATH_MAPPING_FAILED', 'WSL Codex 缺少项目目录或 Editor 路径映射');
  }
  const runtimeEnvironment = {
    ...environment,
    HUAWEI_DECK_CODEX_RUNTIME:'wsl',
    HUAWEI_DECK_WSL_DISTRO:normalized.wslDistribution,
    HUAWEI_DECK_WSL_USER:normalized.wslUser,
    HUAWEI_DECK_WSL_NODE:nodeExecutable,
    HUAWEI_DECK_WSL_CODEX_HOME:posix.join(wslHome, '.codex'),
    HUAWEI_DECK_WSL_CWD:wslCwd,
    HUAWEI_DECK_WSL_SESSION_HELPER:posix.join(
      wslEditorRoot,
      'scripts/editor/wsl-codex-session-helper.mjs',
    ),
  };
  runtimeEnvironment.WSLENV = appendWslenv(runtimeEnvironment);

  return {
    kind:'wsl',
    conversationCwd:wslCwd,
    projectRoot:wslProjectRoot,
    spawnCwd:cwd,
    environment:runtimeEnvironment,
    translateText:text => translatePrompt(text, mappings),
    wrapCommand:command => ({
      ...command,
      label:`Codex（WSL ${normalized.wslDistribution}/${normalized.wslUser}）`,
      executable:wslExecutable,
      args:[
        ...wslArguments(normalized),
        '--cd', wslCwd,
        // 实际 Codex 也必须进入该 WSL 用户的登录环境，才能继承其代理等配置。
        // CLI 与参数全部经位置参数传入，不拼接到 shell 命令字符串。
        '--exec', 'bash', '-lic', 'exec "$@"', 'huawei-deck-codex',
        codexExecutable,
        ...command.args,
      ],
    }),
  };
}
