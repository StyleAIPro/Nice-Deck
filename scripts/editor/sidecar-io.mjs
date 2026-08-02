import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'sidecar_io.py');
const plainIdentity = identity => Object.fromEntries(
  ['path', 'realPath', 'dev', 'ino'].map(key => [key, identity[key]]),
);

function helperError(payload) {
  return Object.assign(new Error(payload?.message ?? '可信 sidecar I/O 失败'), {
    code:'UNSAFE_SIDECAR_IO',
    stage:payload?.stage ?? 'sidecar',
    committed:payload?.committed === true,
  });
}

export function callSidecarHelper(request, { spawnHelper=spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnHelper('python3', [HELPER], { stdio:['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      let payload;
      try { payload = JSON.parse(stdout); }
      catch {
        reject(helperError({ message:`sidecar helper 输出无效（${code}）：${stderr.trim()}` }));
        return;
      }
      if (payload.ok !== true) reject(helperError(payload));
      else resolve(payload.result);
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(request));
  });
}

export function createTrustedSidecarIO(identity, options = {}) {
  const call = request => callSidecarHelper(request, options);
  const directoryIdentity = directory => {
    const match = Object.values(identity).find(item => item?.path === directory);
    if (!match) throw helperError({ message:`目录不在可信 sidecar identity 内：${directory}` });
    return match;
  };
  return {
    atomicWrite({ directory, name, bytes }) {
      return call({
        operation:'atomic-write', directory:directoryIdentity(directory), name,
        bytes:Buffer.from(bytes).toString('base64'),
      });
    },
    unlink({ directory, name, missingOk=true }) {
      return call({ operation:'unlink', directory:directoryIdentity(directory), name, missingOk });
    },
    read({ directory, name }) {
      return call({ operation:'read', directory:directoryIdentity(directory), name })
        .then(result => Buffer.from(result.bytes, 'base64'));
    },
    ensureBackup({ deckName, backupName, expectedFingerprint }) {
      return call({
        operation:'ensure-backup', project:identity.project, deckName,
        backups:identity.backups, backupName, expectedFingerprint,
      });
    },
    restoreDeck({ deckName, backupName, oldFingerprint, candidateFingerprint }) {
      return call({
        operation:'restore-deck', project:identity.project, deckName,
        backups:identity.backups, backupName, oldFingerprint, candidateFingerprint,
      });
    },
  };
}

export async function ensureTrustedDirectory(parent, path, options = {}) {
  return callSidecarHelper({
    operation:'ensure-directory', parent:plainIdentity(parent), name:basename(path), path,
  }, options);
}

// 仅供不经过 server 的 SessionStore 单元使用；生产服务始终注入 dirfd helper。
export const localDurableIO = {
  async atomicWrite({ directory, name, bytes }) {
    const path = join(directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path);
      const parent = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await handle?.close();
      await unlink(temporary).catch(() => {});
    }
  },
  async unlink({ directory, name }) {
    await unlink(join(directory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  },
};
