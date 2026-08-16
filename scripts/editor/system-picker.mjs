import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPythonExecutable, pythonUtf8SpawnOptions } from './python-utf8.mjs';

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(EDITOR_DIR, '../..');

function pickerError(message, code = 'PICK_FAILED') {
  return Object.assign(new Error(message), { code });
}

function pickPathWithSystemPicker({
  pythonExecutable = defaultPythonExecutable(),
  pickerFlag,
  resultKey,
  resultLabel,
  signal,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(
      pythonExecutable,
      [join(PROJECT_DIR, 'scripts/deck-editor.py'), pickerFlag],
      pythonUtf8SpawnOptions({ cwd:PROJECT_DIR, stdio:['ignore', 'pipe', 'pipe'], signal }),
    );
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = target => chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        child.kill();
        reject(pickerError('文件选择器返回内容过大'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', code => {
      if (code === 3) {
        resolvePromise(null);
        return;
      }
      if (code !== 0) {
        reject(pickerError(
          Buffer.concat(stderr).toString('utf8').trim() || '系统文件选择器异常退出',
        ));
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (typeof payload[resultKey] !== 'string' || !payload[resultKey]) {
          throw new Error(`缺少 ${resultKey}`);
        }
        resolvePromise(payload[resultKey]);
      } catch (error) {
        reject(pickerError(`无法解析${resultLabel}选择结果：${error.message}`));
      }
    });
  });
}

export function pickDeckWithSystemPicker(options = {}) {
  return pickPathWithSystemPicker({
    ...options,
    pickerFlag:'--pick-only',
    resultKey:'deckPath',
    resultLabel:'文件',
  });
}

export function pickProjectDirectoryWithSystemPicker(options = {}) {
  return pickPathWithSystemPicker({
    ...options,
    pickerFlag:'--pick-directory-only',
    resultKey:'directoryPath',
    resultLabel:'目录',
  });
}
