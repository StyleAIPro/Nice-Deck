// 在原装 Windows Desktop 的隔离 Profile 中验证最终包升级、共存和卸载。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const appRoot = join(dirname(process.execPath), 'resources/app');
const archive = resolve('dist/aico-ppt-skill-0.1.32-win32-x64.tgz');
const previous = resolve('dist/aico-ppt-skill-0.1.31-win32-x64.tgz');
const harness = resolve('../AICO-Harness-Plugin/dist/aico-harness-2.0.0-dev.66.tgz');

test('原装 Desktop 安装 0.1.31 后升级 0.1.32，卸载保留原装插件、Harness 与数据', {
  skip:process.platform !== 'win32', timeout:600_000,
}, async t => {
  const desktop = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
  assert.equal(desktop.name, 'dsh-plugin-desktop');
  assert.equal(desktop.version, '2.0.13');
  const root = await mkdtemp(join(tmpdir(), 'aico-ppt-0132-install-'));
  t.after(() => rm(root, { recursive:true, force:true, maxRetries:10, retryDelay:100 }));
  const home = join(root, 'isolated-dsh');
  const { ensureDesktopProfile } = await import(pathToFileURL(join(appRoot, 'lib/profile.js')).href);
  const profile = ensureDesktopProfile(home);
  const manifestPath = join(profile, 'package.json');
  const manifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'));
  const baseline = await manifest();
  const bin = join(root, 'bin');
  await mkdir(bin);
  const pnpm = join(appRoot, 'node_modules/pnpm/bin/pnpm.cjs');
  await writeFile(join(bin, 'pnpm.cmd'), `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" "${pnpm}" %*\r\n`);
  const env = { ...process.env, DSH_HOME:home, DSH_DESKTOP_DEFAULT_PROFILE:'desktop', CI:'true' };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = `${bin};${dirname(process.execPath)};${env[pathKey] || ''}`;
  const cli = (verb, file) => run(process.execPath, [join(appRoot, 'lib/desktop-cli.js'), 'plugin', verb, file,
    ...(verb === 'add' ? ['--ignore-scripts', '--config.auto-install-peers=false'] : []),
  ], { env, timeout:180_000, maxBuffer:4 * 1024 * 1024 });
  const marker = join(profile, 'keep-user-data.txt');
  await writeFile(marker, '保留用户数据');
  await cli('add', harness);
  await cli('add', previous);
  const installedRoot = join(profile, 'node_modules/aico-ppt-skill');
  assert.equal(JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')).version, '0.1.31');
  await cli('add', archive);
  assert.equal(JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')).version, '0.1.32');
  assert.deepEqual((await manifest()).dsh.profile.bundles,
    [...baseline.dsh.profile.bundles, 'aico-harness', 'aico-ppt-skill']);
  const unpacked = join(root, 'unpacked');
  await mkdir(unpacked);
  await run('tar', ['-xzf', archive, '-C', unpacked], { timeout:60_000 });
  let checked = 0;
  const compare = async (directory, relative = '') => {
    for (const item of await readdir(directory, { withFileTypes:true })) {
      const name = join(relative, item.name);
      if (item.isDirectory()) await compare(join(directory, item.name), name);
      else if (item.isFile()) {
        const expected = await readFile(join(directory, item.name));
        const actual = await readFile(join(installedRoot, name));
        assert.equal(createHash('sha256').update(actual).digest('hex'),
          createHash('sha256').update(expected).digest('hex'), name);
        checked += 1;
      } else assert.equal(item.isSymbolicLink(), true, name);
    }
  };
  await compare(join(unpacked, 'package'));
  assert.ok(checked > 100);
  console.log(`安装文件逐项校验：${checked} 个文件一致`);
  await cli('remove', 'aico-ppt-skill');
  assert.deepEqual((await manifest()).dsh.profile.bundles, [...baseline.dsh.profile.bundles, 'aico-harness']);
  assert.equal(await readFile(marker, 'utf8'), '保留用户数据');
  await assert.rejects(stat(installedRoot), { code:'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules/aico-harness/package.json'), 'utf8')).version, '2.0.0-dev.66');
});
