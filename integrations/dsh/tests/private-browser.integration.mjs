/** 显式复制测试浏览器安装目录到私有资源根，再执行真实图片 PPTX 导出；不证明发行资源可重分发。 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveRuntime } from '../runtime-env.mjs';

const run = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const browserSource = process.env.AICO_TEST_BROWSER_DIRECTORY;
const pythonSource = process.env.AICO_TEST_PYTHON_EXECUTABLE;
if (!browserSource || !pythonSource || !['linux', 'win32'].includes(process.platform)) throw new Error('需要显式 Windows/Linux 测试浏览器目录和 Python 可执行文件');

test('私有浏览器经真实导出脚本生成两页图片 PPTX，不连接旧 Desktop 渲染通道', { timeout:180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'aico-private-render-'));
  t.after(() => rm(root, { recursive:true, force:true, maxRetries:20, retryDelay:100 }));
  await cp(browserSource, join(root, 'browser'), { recursive:true });
  const windows = process.platform === 'win32';
  const python = windows ? join(root, 'python/python.exe') : join(root, 'python3');
  if (windows) await cp(dirname(pythonSource), join(root, 'python'), { recursive:true });
  else await copyFile(pythonSource, python);
  const runtime = await resolveRuntime({ root, paths:{ python, browser:join(root, windows ? 'browser/chrome.exe' : 'browser/chrome') } }, {
    ...process.env, AICO_HOME:join(root, 'nonexistent-old-host'), AICO_BROWSER_EXECUTABLE:'/unusable-inherited-browser',
  });
  assert.equal(runtime.environment.AICO_HOME, undefined);
  const deck = join(root, '测试 deck.html');
  await writeFile(deck, (await readFile(join(source, 'scripts/editor/test/fixtures/minimal-deck.html'), 'utf8'))
    .replace('<script src="../../runtime/patch-runtime.js"></script>', ''));
  const output = join(root, '测试 export.pptx');
  await run(python, [join(source, 'scripts/html2pptx/convert.py'), deck, output, '--mode', 'image', '--scale', '1'], {
    cwd:root, env:runtime.environment, timeout:120000, maxBuffer:1024 * 1024,
  });
  const { stdout } = await run(python, ['-c', [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' names=z.namelist()',
    ' assert z.testzip() is None',
    ' print(json.dumps({"slides":[n for n in names if n.startswith("ppt/slides/slide") and n.endswith(".xml")],"images":[n for n in names if n.startswith("ppt/media/")]}))',
  ].join('\n'), output], { env:runtime.environment, timeout:10000 });
  const contents = JSON.parse(stdout);
  assert.equal(contents.slides.length, 2);
  assert.equal(contents.images.length, 2);
  t.diagnostic(`${process.platform} 真实浏览器与标准库打包器完成两页 PPTX；此测试使用本机安装文件副本，不包含 Desktop UI、WSL 切换或发行资源验证`);
});
