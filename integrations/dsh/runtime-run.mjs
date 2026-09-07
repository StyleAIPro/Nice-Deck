#!/usr/bin/env node
/** 为模型脚本选择插件环境；执行审批与沙箱继续由 Harness 负责。 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { resolveRuntime } from './runtime-env.mjs';

async function main() {
  const [interpreter, ...args] = process.argv.slice(2);
  if (!['python3', 'node'].includes(interpreter)) {
    throw new Error('用法：runtime-run.mjs <python3|node> [解释器参数、脚本或 -]');
  }
  const descriptor = JSON.parse(await readFile(new URL('../../.aico-runtime.json', import.meta.url), 'utf8'));
  const runtime = await resolveRuntime(descriptor);
  const command = interpreter === 'node' ? process.execPath : runtime.paths.python;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env:runtime.environment, stdio:'inherit', windowsHide:true });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      resolve(code ?? 128 + (constants.signals[signal] ?? 1));
    });
  });
}

try { await main(); }
catch (error) {
  console.error(`AICO-PPT 脚本启动失败：${error.message}`);
  process.exitCode = 2;
}
