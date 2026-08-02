import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function identity(path) {
  const { lstat } = await import('node:fs/promises');
  const info = await lstat(path, { bigint:true });
  return {
    path,
    realPath:await realpath(path),
    dev:String(info.dev),
    ino:String(info.ino),
  };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('持久 helper 长期持有 root dirfd，换根后 discover 仍只读取原目录', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  assert.equal(typeof createPersistentSidecarIO, 'function');

  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-persistent-'));
  const root = join(project, '.huawei-deck-editor');
  await mkdir(root);
  const io = await createPersistentSidecarIO({
    project:await identity(project),
    root:await identity(root),
  });
  const trusted = `${root}.trusted`;
  await rename(root, trusted);
  await mkdir(join(root, 'deck-deadbeef', 'transactions'), { recursive:true });
  await writeFile(
    join(root, 'deck-deadbeef', 'transactions', '123e4567-e89b-42d3-a456-426614174000.json'),
    '{}',
  );

  try {
    const result = await io.discover({ deckName:'deck.html' });
    assert.deepEqual(result, { registry:null, sessions:[] });
  } finally {
    await io.close();
  }
});

test('session/transaction/backup/deck 的实际读取只走已绑定 dirfd 且 API 无通用文件能力', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-bound-'));
  const root = join(project, '.huawei-deck-editor');
  const sessionName = 'deck-deadbeef';
  const session = join(root, sessionName);
  const transactionId = '123e4567-e89b-42d3-a456-426614174000';
  const deckBytes = Buffer.from('trusted-deck');
  const fingerprint = sha256(deckBytes);
  const backupName = `deck-${fingerprint}.html`;
  const sessionState = { source:'trusted-session' };
  const transaction = { source:'trusted-transaction' };
  await mkdir(join(session, 'snapshots'), { recursive:true });
  await mkdir(join(session, 'backups'));
  await mkdir(join(session, 'transactions'));
  await mkdir(join(session, 'write-errors'));
  await writeFile(join(project, 'deck.html'), deckBytes);
  await writeFile(join(session, 'session.json'), JSON.stringify(sessionState));
  await writeFile(join(session, 'transactions', `${transactionId}.json`), JSON.stringify(transaction));
  await writeFile(join(session, 'backups', backupName), deckBytes);

  const io = await createPersistentSidecarIO({
    project:await identity(project),
    root:await identity(root),
  });
  try {
    await io.bindSession({ deckName:'deck.html', sessionName, create:false });
    assert.equal(io.atomicWrite, undefined);
    assert.equal(io.read, undefined);
    assert.equal(io.ensureBackup, undefined);

    const movedProject = `${project}.trusted`;
    await rename(project, movedProject);
    const forgedSession = join(project, '.huawei-deck-editor', sessionName);
    await mkdir(join(forgedSession, 'backups'), { recursive:true });
    await mkdir(join(forgedSession, 'transactions'));
    await writeFile(join(project, 'deck.html'), 'forged-deck');
    await writeFile(join(forgedSession, 'session.json'), JSON.stringify({ source:'forged' }));
    await writeFile(
      join(forgedSession, 'transactions', `${transactionId}.json`),
      JSON.stringify({ source:'forged' }),
    );
    await writeFile(join(forgedSession, 'backups', backupName), 'forged-backup');

    assert.deepEqual(await io.readSession(), sessionState);
    assert.deepEqual(await io.readTransaction({ transactionId }), transaction);
    assert.deepEqual(await io.listTransactions(), [transactionId]);
    assert.deepEqual(
      await io.verifyBackup({ backupName, expectedFingerprint:fingerprint }),
      { fingerprint },
    );
    assert.deepEqual(await io.hashDeck(), { fingerprint });
  } finally {
    await io.close();
  }
});

test('registry 原子发布后 discovery 只接受注册 session，未注册伪造目录保持只读', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-registry-'));
  const root = join(project, '.huawei-deck-editor');
  const initialFingerprint = sha256('deck');
  const sessionName = `deck-${initialFingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  await mkdir(join(root, sessionName, 'snapshots'), { recursive:true });
  await mkdir(join(root, sessionName, 'backups'));
  await mkdir(join(root, sessionName, 'transactions'));
  await mkdir(join(root, sessionName, 'write-errors'));
  await writeFile(join(project, 'deck.html'), 'deck');
  const before = await readdir(root, { recursive:true });
  const io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  try {
    assert.deepEqual(
      await io.discover({ deckName:'deck.html' }),
      { registry:null, sessions:[] },
    );
    assert.deepEqual(await readdir(root, { recursive:true }), before);
    await io.prepareSession({
      deckName:'deck.html', sessionId, initialFingerprint, sessionName, mode:'legacy',
    });
    await io.bindSession({ deckName:'deck.html', sessionName, create:false });
    await io.writeSession({
      sessionId,
      bytes:Buffer.from(JSON.stringify({
        sessionId,
        deckPath:join(project, 'deck.html'),
        deckFingerprint:initialFingerprint,
        source:'migrated',
      })),
    });
    await io.activateSession({ sessionId });
    assert.deepEqual(await io.discover({ deckName:'deck.html' }), {
      registry:{
        version:1,
        sessions:{
          [sessionId]:{
            sessionId,
            deckRealPath:join(await realpath(project), 'deck.html'),
            initialFingerprint,
            sessionName,
            mode:'legacy',
            status:'active',
          },
        },
      },
      sessions:[{
        sessionId,
        deckRealPath:join(await realpath(project), 'deck.html'),
        initialFingerprint,
        sessionName,
        mode:'legacy',
        status:'active',
        kind:'directory',
      }],
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'sessions.json'))),
      (await io.discover({ deckName:'deck.html' })).registry,
    );
  } finally {
    await io.close();
  }
});

test('registry preparing 在两处崩溃后都可由重启安全完成而非遗留未注册 session', async () => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');
  const project = await mkdtemp(join(tmpdir(), 'deck-sidecar-preparing-'));
  const root = join(project, '.huawei-deck-editor');
  const deckName = 'deck.html';
  const initialFingerprint = sha256('deck');
  const sessionName = `deck-${initialFingerprint.slice(0, 8)}`;
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  await mkdir(root);
  await writeFile(join(project, deckName), 'deck');

  let io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  await io.prepareSession({
    deckName, sessionId, initialFingerprint, sessionName, mode:'fresh',
  });
  await io.close(); // crash point 1: registry preparing durable，session 尚未创建

  io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  assert.equal((await io.discover({ deckName })).sessions[0].status, 'preparing');
  assert.equal((await io.discover({ deckName })).sessions[0].kind, 'missing');
  await io.bindSession({ deckName, sessionName, create:true });
  await io.writeSession({
    sessionId,
    bytes:Buffer.from(JSON.stringify({
      sessionId, deckPath:join(project, deckName), deckFingerprint:initialFingerprint,
    })),
  });
  await io.close(); // crash point 2: session durable，registry 仍 preparing

  io = await createPersistentSidecarIO({
    project:await identity(project), root:await identity(root),
  });
  try {
    const pending = (await io.discover({ deckName })).sessions[0];
    assert.equal(pending.status, 'preparing');
    assert.equal(pending.kind, 'directory');
    await io.bindSession({ deckName, sessionName, create:false });
    assert.equal((await io.readSession()).sessionId, sessionId);
    await io.activateSession({ sessionId });
    assert.equal((await io.discover({ deckName })).sessions[0].status, 'active');
  } finally {
    await io.close();
  }
});

test('持久 helper 对超时、输出上限和 close 都只 settle 一次并回收 child', async t => {
  const { createPersistentSidecarIO } = await import('../sidecar-io.mjs');

  const fakeChild = onWrite => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.write = data => { onWrite?.(child, data); return true; };
    child.stdin.end = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); };
    return child;
  };
  const baseIdentity = { path:'/tmp/project', realPath:'/tmp/project', dev:'1', ino:'2' };

  await t.test('request timeout 终止 helper', async () => {
    const child = fakeChild();
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:20,
      maxOutputBytes:1024,
      skipReadyHandshake:true,
    });
    await assert.rejects(() => io.discover({ deckName:'deck.html' }), error => (
      error.code === 'SIDECAR_HELPER_TIMEOUT'
    ));
    assert.equal(child.killed, true);
    await io.close();
  });

  await t.test('oversized stdout 终止 helper', async () => {
    const child = fakeChild(current => queueMicrotask(() => {
      current.stdout.emit('data', 'x'.repeat(65));
    }));
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:100,
      maxInputBytes:1024,
      maxOutputBytes:64,
      skipReadyHandshake:true,
    });
    await assert.rejects(() => io.discover({ deckName:'deck.html' }), error => (
      error.code === 'SIDECAR_HELPER_OUTPUT_LIMIT'
    ));
    assert.equal(child.killed, true);
    await io.close();
  });

  await t.test('oversized input 在写入 child 前拒绝并终止 helper', async () => {
    const child = fakeChild();
    const io = await createPersistentSidecarIO({
      project:baseIdentity,
      spawnHelper:() => child,
      timeoutMs:100,
      maxInputBytes:64,
      maxOutputBytes:1024,
      skipReadyHandshake:true,
    });
    await assert.rejects(
      () => io.bindSession({
        deckName:'deck.html', sessionName:`deck-${'a'.repeat(80)}`, create:false,
      }),
      error => error.code === 'SIDECAR_HELPER_INPUT_LIMIT',
    );
    assert.equal(child.killed, true);
    await io.close();
  });
});
