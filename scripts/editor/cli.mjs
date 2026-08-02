#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const HELP = {
  usage: 'node scripts/editor/cli.mjs --url URL --token TOKEN COMMAND [ARG]',
  options: ['--url URL', '--token TOKEN', '--help'],
  commands: ['status', 'tasks', 'task', 'apply', 'undo'],
};

class CliError extends Error {
  constructor(message, exitCode = 2, output = null) {
    super(message);
    this.exitCode = exitCode;
    this.output = output;
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function parseArguments(argv) {
  let url;
  let token;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--url' || argument === '--token') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new CliError(`${argument} 缺少值`);
      if (argument === '--url') url = value;
      else token = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new CliError(`未知参数: ${argument}`);
    positional.push(argument);
  }
  if (!url) throw new CliError('缺少 --url');
  if (!token) throw new CliError('缺少 --token');
  let baseUrl;
  try {
    baseUrl = new URL(url);
  } catch {
    throw new CliError(`无效 --url: ${url}`);
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new CliError('--url 必须使用 http 或 https');
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  baseUrl.search = '';
  baseUrl.hash = '';

  const [command, ...args] = positional;
  const expectedArgs = { status: 0, tasks: 0, task: 1, apply: 1, undo: 1 };
  if (!(command in expectedArgs)) throw new CliError(command ? `未知命令: ${command}` : '缺少命令');
  if (args.length !== expectedArgs[command]) throw new CliError(`${command} 参数数量错误`);
  return { help: false, baseUrl, token, command, args };
}

async function requestJson({ baseUrl, token }, pathname, { method = 'GET', body } = {}) {
  const endpoint = new URL(pathname, `${baseUrl.href.replace(/\/$/, '')}/`);
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new CliError(`无法连接编辑服务: ${error.message}`, 1);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(`HTTP ${response.status}`, 1, text || JSON.stringify({
      error: 'HTTP_ERROR', message: `HTTP ${response.status}`,
    }));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('服务返回的成功响应不是有效 JSON', 1);
  }
}

async function readActions(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError(`无法读取动作文件: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new CliError(`动作文件不是有效 JSON: ${error.message}`);
  }
}

async function execute(options) {
  const { command, args } = options;
  if (command === 'status') return requestJson(options, '/api/session');
  if (command === 'tasks') return requestJson(options, '/api/tasks');
  if (command === 'task') return requestJson(options, `/api/tasks/${encodeURIComponent(args[0])}`);
  if (command === 'apply') {
    const input = await readActions(args[0]);
    if (input === null || typeof input !== 'object') throw new CliError('动作文件必须是数组或对象');
    let body = input;
    if (Array.isArray(input)) {
      const session = await requestJson(options, '/api/session');
      body = { expectedRevision: session.revision, taskId: null, actions: input };
    }
    return requestJson(options, '/api/actions', { method: 'POST', body });
  }
  const session = await requestJson(options, '/api/session');
  return requestJson(options, `/api/groups/${encodeURIComponent(args[0])}/undo`, {
    method: 'POST', body: { expectedRevision: session.revision },
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      writeJson(process.stdout, HELP);
      return 0;
    }
    writeJson(process.stdout, await execute(options));
    return 0;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    if (error instanceof CliError && error.output !== null) {
      process.stderr.write(`${error.output.replace(/\n?$/, '\n')}`);
    } else {
      writeJson(process.stderr, {
        error: exitCode === 2 ? 'CLI_INPUT_ERROR' : 'CLI_ERROR',
        message: error.message,
      });
    }
    return exitCode;
  }
}

process.exitCode = await main();
