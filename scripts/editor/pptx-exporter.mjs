import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPythonExecutable, pythonUtf8SpawnOptions } from './python-utf8.mjs';


const CONVERTER = fileURLToPath(new URL('../html2pptx/convert.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_LOG_BYTES = 64 * 1_024;

function exportError(code, statusCode, message, diagnostic) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    ...(diagnostic ? { diagnostic:String(diagnostic).slice(-16_384) } : {}),
  });
}

function runConverter(inputPath, outputPath, {
  mode,
  pythonExecutable,
  spawnProcess,
  timeoutMs,
  signal,
}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stopping = false;
    let stdout = '';
    let stderr = '';
    const child = spawnProcess(
      pythonExecutable,
      [CONVERTER, inputPath, outputPath, '--mode', mode],
      pythonUtf8SpawnOptions({ stdio:['ignore', 'pipe', 'pipe'] }),
    );
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(value);
    };
    // Windows 的 kill 只结束父进程；必须在父进程仍存活时终止整棵转换树。
    // 等待系统终止命令完成后才返回，避免清理临时目录时浏览器仍在读写。
    const stop = error => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      if (process.platform === 'win32' && child.pid) {
        const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(executable, ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide:true, timeout:15_000 }, failure => {
            if (failure) {
              finish(exportError('PPTX_EXPORT_CLEANUP_FAILED', 503,
                'PPTX 转换进程清理失败', failure.message));
            } else finish(error);
          });
      } else {
        child.once('close', () => finish(error));
        child.kill('SIGKILL');
      }
    };
    const abort = () => stop(exportError('PPTX_EXPORT_CANCELLED', 503, 'PPTX 导出已取消'));
    const timer = setTimeout(() => stop(exportError(
      'PPTX_EXPORT_TIMEOUT', 504, 'PPTX 导出超时，请缩小 Deck 后重试', stderr,
    )), timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      stdout = `${stdout}${chunk}`.slice(-MAX_LOG_BYTES);
    });
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-MAX_LOG_BYTES);
    });
    child.once('error', error => {
      const unavailable = error?.code === 'ENOENT';
      finish(exportError(
        unavailable ? 'PPTX_EXPORT_UNAVAILABLE' : 'PPTX_EXPORT_FAILED',
        unavailable ? 503 : 500,
        unavailable
          ? '找不到 PPTX 导出所需的 Python，请先启用 PPTX 导出能力'
          : 'PPTX 导出进程启动失败',
        error?.message,
      ));
    });
    child.once('close', code => {
      if (stopping) return;
      if (code !== 0) {
        const patchFailure = stderr.match(/^PPTX_PATCH_REPLAY_FAILED: (.+)$/mu)?.[1];
        finish(exportError(
          patchFailure ? 'PPTX_PATCH_REPLAY_FAILED' : 'PPTX_EXPORT_FAILED', 422,
          patchFailure ?? 'PPTX 导出失败，请在“安装与诊断”中检查 PPTX 导出能力',
          stderr.trim() || stdout.trim() || `转换器退出码 ${code}`,
        ));
        return;
      }
      finish(null, { stdout, stderr });
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once:true });
  });
}

export async function exportPptxSnapshot({
  htmlBytes,
  mode='image',
  pythonExecutable=defaultPythonExecutable(),
  spawnProcess=spawn,
  timeoutMs=DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  if (!Buffer.isBuffer(htmlBytes) || htmlBytes.length === 0) {
    throw new TypeError('PPTX 导出需要非空 HTML Buffer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('PPTX 导出超时必须为正整数毫秒');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'aico-ppt-pptx-'));
  const inputPath = join(temporary, 'deck.html');
  const outputPath = join(temporary, 'deck.pptx');
  try {
    await writeFile(inputPath, htmlBytes);
    await runConverter(inputPath, outputPath, {
      pythonExecutable, spawnProcess, timeoutMs, signal, mode,
    });
    const bytes = await readFile(outputPath);
    if (bytes.length < 4 || bytes.subarray(0, 2).toString('ascii') !== 'PK') {
      throw exportError('PPTX_EXPORT_FAILED', 500, 'PPTX 导出结果无效');
    }
    return bytes;
  } finally {
    await rm(temporary, { recursive:true, force:true, maxRetries:3, retryDelay:50 });
  }
}
