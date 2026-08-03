import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AttachmentStore } from '../attachment-store.mjs';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const FIXED_ID = '22222222-2222-4222-8222-222222222222';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function directoryIdentity(path) {
  const info = await lstat(path, { bigint:true });
  return { path:resolve(path), realPath:resolve(path), dev:String(info.dev), ino:String(info.ino) };
}

async function fixture(options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'attachment-store-'));
  const root = await realpath(temporaryRoot);
  const session = join(root, 'session');
  const attachments = join(session, 'attachments');
  const staging = join(attachments, '.staging');
  await mkdir(staging, { recursive:true });
  const identities = {
    session:await directoryIdentity(session),
    attachments:await directoryIdentity(attachments),
    attachmentStaging:await directoryIdentity(staging),
  };
  const calls = { publish:[], discard:[], delete:[] };
  const sidecarIO = {
    async publishAttachments(payload) {
      calls.publish.push(payload);
      await rename(join(staging, payload.uploadId), join(attachments, payload.taskId));
      return payload.files.map(file => ({
        id:file.id, size:file.size,
        relativePath:`attachments/${payload.taskId}/${file.id}${file.suffix}`,
      }));
    },
    async discardAttachmentUpload({ uploadId }) {
      calls.discard.push(uploadId);
      await rm(join(staging, uploadId), { recursive:true, force:true });
      return { removed:true };
    },
    async deleteTaskAttachments({ taskId }) {
      calls.delete.push(taskId);
      await rm(join(attachments, taskId), { recursive:true, force:true });
      return { removed:true };
    },
    ...options.sidecarIO,
  };
  const sidecarBoundary = {
    sessionDir:session,
    session:identities.session,
    attachments:identities.attachments,
    attachmentStaging:identities.attachmentStaging,
    pythonIdentity:identities,
    guard:async () => {},
  };
  const store = new AttachmentStore({
    sidecarBoundary, sidecarIO,
    spawnAttachmentWriter:options.spawnAttachmentWriter ?? spawn,
    timeoutMs:options.timeoutMs ?? 2_000,
    killGraceMs:options.killGraceMs ?? 20,
    hardTerminationTimeoutMs:options.hardTerminationTimeoutMs ?? 100,
    randomUUID:options.randomUUID,
    now:options.now ?? (() => new Date('2026-08-02T12:00:00.000Z')),
  });
  return {
    root, session, attachments, staging, identities, calls, sidecarIO,
    sidecarBoundary, store,
    cleanup:async () => { await store.close(); await rm(root, { recursive:true, force:true }); },
  };
}

async function waitForPath(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { await lstat(path); return; } catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 5)); }
  }
  throw new Error(`等待路径超时：${path}`);
}

function hangingChild({ closeOnKill=true, exitCode=0, output=null } = {}) {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.unrefs = 0;
  child.kill = signal => {
    child.kills.push(signal);
    if (closeOnKill) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  child.unref = () => { child.unrefs += 1; };
  if (output !== null) queueMicrotask(() => {
    child.stdout.end(output);
    child.stderr.end();
    child.emit('close', exitCode, null);
  });
  return child;
}

test('真实 writer 流式 stage、publish 并仅在 serialize 派生绝对 path', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const bytes = Buffer.concat([Buffer.from('reference-'), Buffer.alloc(8192, 7)]);
  const upload = fx.store.beginUpload();
  const staged = await upload.stage({
    stream:Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]),
    name:'新版架构.PNG', mime:'image/png', source:'selected',
  });
  assert.equal(staged.size, bytes.length);
  assert.equal(staged.sha256, sha256(bytes));
  assert.equal(staged.suffix, '.png');
  assert.equal(Object.hasOwn(staged, 'path'), false);

  const descriptors = await upload.publish(TASK_ID);
  assert.equal(upload.published, true);
  assert.equal(fx.calls.publish[0].files[0].sha256, sha256(bytes));
  assert.equal(descriptors.length, 1);
  assert.equal(Object.hasOwn(descriptors[0], 'path'), false);
  assert.deepEqual(Object.keys(descriptors[0]).sort(), [
    'createdAt', 'id', 'mime', 'name', 'relativePath', 'size', 'source',
  ]);
  assert.equal(await readFile(join(fx.attachments, TASK_ID, `${staged.id}.png`), 'utf8'), bytes.toString());

  const task = { id:TASK_ID, attachments:descriptors };
  const serialized = fx.store.serializeTask(task);
  assert.equal(
    serialized.attachments[0].path,
    join(fx.attachments, TASK_ID, `${staged.id}.png`),
  );
  assert.equal(Object.hasOwn(task.attachments[0], 'path'), false);
});

test('stage 调用独立 spawnAttachmentWriter 注入点并按序执行多文件', async t => {
  let active = 0;
  let maximum = 0;
  const seen = [];
  const spawnAttachmentWriter = (command, args, options) => {
    assert.equal(command, 'python3');
    assert.equal(args[0], '-u');
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    const config = JSON.parse(args[args.indexOf('--config') + 1]);
    const child = hangingChild();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { seen.push(Buffer.from(chunk)); callback(); },
      final(callback) {
        active += 1;
        maximum = Math.max(maximum, active);
        setTimeout(() => {
          const bytes = Buffer.concat(seen.splice(0));
          child.stdout.end(`${JSON.stringify({
            ok:true, uploadId:config.uploadId, attachmentId:config.attachmentId,
            suffix:config.suffix,
            path:join(config.attachmentStaging.path, config.uploadId,
              `${config.attachmentId}${config.suffix}`),
            size:bytes.length, sha256:sha256(bytes),
            uploadIdentity:{ dev:'1', ino:'10', mountDev:'1', mountId:'20' },
            fileIdentity:{
              dev:'1', ino:String(100 + config.attachmentId.charCodeAt(0)),
              mountDev:'1', mountId:'20',
            },
          })}\n`);
          active -= 1;
          child.emit('close', 0, null);
        }, 10);
        callback();
      },
    });
    return child;
  };
  const fx = await fixture({ spawnAttachmentWriter });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  const first = upload.stage({ stream:Readable.from(['one']), name:'one.txt', mime:'text/plain', source:'selected' });
  const second = upload.stage({ stream:Readable.from(['two']), name:'two.txt', mime:'text/plain', source:'selected' });
  const staged = await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(staged.length, 2);
});

test('stream 截断错误会杀死 writer，部分 stage 失败会清理整个 upload', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  const broken = new Readable({
    read() {
      this.push(Buffer.from('partial'));
      queueMicrotask(() => this.destroy(Object.assign(new Error('truncated'), { code:'ECONNRESET' })));
    },
  });
  await assert.rejects(
    upload.stage({ stream:broken, name:'broken.txt', mime:'text/plain', source:'selected' }),
    error => error.code === 'ATTACHMENT_STREAM_ERROR',
  );
  assert.deepEqual(await lstat(join(fx.staging, upload.id)).then(() => 'exists', () => 'missing'), 'missing');
  assert.equal(fx.calls.discard.length, 1);
});

test('真实 Store+writer 遇到 upload/target replacement 不按旧 uploadId 补偿删除', async t => {
  const ids = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const fx = await fixture({ randomUUID:() => ids.shift() });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  const input = new PassThrough();
  const staged = upload.stage({ stream:input, name:'race.txt', mime:'text/plain', source:'selected' });
  input.write('prefix');
  const target = join(fx.staging, upload.id, '44444444-4444-4444-8444-444444444444.txt');
  await waitForPath(target);
  await rm(target);
  await writeFile(target, 'target-replacement');
  input.end('suffix');
  await assert.rejects(staged, error => error.code === 'UNSAFE_SIDECAR_IO');
  assert.equal(await readFile(target, 'utf8'), 'target-replacement');
  assert.equal(fx.calls.discard.length, 0, '不可信 writer cleanup 不得仅凭 uploadId 调 helper');

  const uploadIds = [
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
  ];
  const replacementFx = await fixture({ randomUUID:() => uploadIds.shift() });
  t.after(replacementFx.cleanup);
  const replacementUpload = replacementFx.store.beginUpload();
  const replacementInput = new PassThrough();
  const replacementStage = replacementUpload.stage({
    stream:replacementInput, name:'race.txt', mime:'text/plain', source:'selected',
  });
  replacementInput.write('prefix');
  const uploadPath = join(replacementFx.staging, replacementUpload.id);
  const uploadTarget = join(uploadPath, '66666666-6666-4666-8666-666666666666.txt');
  await waitForPath(uploadTarget);
  await rename(uploadPath, `${uploadPath}.held`);
  await mkdir(uploadPath);
  const marker = join(uploadPath, 'replacement-marker');
  await writeFile(marker, 'keep');
  replacementInput.end('suffix');
  await assert.rejects(replacementStage, error => error.code === 'UNSAFE_SIDECAR_IO');
  assert.equal(await readFile(marker, 'utf8'), 'keep');
  assert.equal(replacementFx.calls.discard.length, 0);
});

test('真实 store 保留 writer 的空文件与 25 MiB 超限稳定错误码', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  await assert.rejects(
    fx.store.beginUpload().stage({
      stream:Readable.from([]), name:'empty.bin', mime:'', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_EMPTY',
  );
  async function* oversized() {
    const chunk = Buffer.alloc(1024 * 1024, 3);
    for (let index = 0; index < 26; index += 1) yield chunk;
  }
  await assert.rejects(
    fx.store.beginUpload().stage({
      stream:Readable.from(oversized()), name:'large.bin', mime:'', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_TOO_LARGE',
  );
});

test('重复 attachment ID fail-closed 并清理已暂存文件', async t => {
  const fx = await fixture({ randomUUID:() => FIXED_ID });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(
    upload.stage({ stream:Readable.from(['second']), name:'second.txt', mime:'text/plain', source:'selected' }),
    error => error.code === 'ATTACHMENT_ID_COLLISION',
  );
  assert.equal(fx.calls.discard.length, 1);
});

test('writer timeout、非零 exit 与超量 stdout 各自只 settle 一次并杀死 child', async t => {
  const children = [];
  const fx = await fixture({
    timeoutMs:20,
    spawnAttachmentWriter:() => {
      const child = hangingChild({ closeOnKill:true });
      children.push(child);
      return child;
    },
  });
  t.after(fx.cleanup);
  await assert.rejects(
    fx.store.beginUpload().stage({ stream:Readable.from(['data']), name:'a.bin', mime:'', source:'selected' }),
    error => error.code === 'ATTACHMENT_WRITER_TIMEOUT',
  );
  assert.deepEqual(children[0].kills, ['SIGKILL']);

  const exited = await fixture({
    spawnAttachmentWriter:() => hangingChild({ output:'writer failed', exitCode:7 }),
  });
  t.after(exited.cleanup);
  await assert.rejects(
    exited.store.beginUpload().stage({ stream:Readable.from(['x']), name:'b.bin', mime:'', source:'selected' }),
    error => error.code === 'ATTACHMENT_WRITE_FAILED',
  );

  const overflow = await fixture({
    spawnAttachmentWriter:() => hangingChild({ output:'x'.repeat(64 * 1024 + 1), exitCode:0 }),
  });
  t.after(overflow.cleanup);
  await assert.rejects(
    overflow.store.beginUpload().stage({ stream:Readable.from(['x']), name:'c.bin', mime:'', source:'selected' }),
    error => error.code === 'ATTACHMENT_WRITER_OUTPUT_LIMIT',
  );
});

test('child error 必须 kill 并等待真实 close 后才注销 active writer', async t => {
  const child = hangingChild({ closeOnKill:false });
  const fx = await fixture({
    killGraceMs:20,
    spawnAttachmentWriter:() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('child error'), {
        code:'ECHILD',
      })));
      setTimeout(() => child.emit('close', null, 'SIGKILL'), 30);
      return child;
    },
  });
  t.after(fx.cleanup);
  await assert.rejects(
    fx.store.beginUpload().stage({
      stream:Readable.from(['data']), name:'error.bin', mime:'', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_WRITE_FAILED',
  );
  assert.ok(child.kills.length >= 1);
  assert.ok(child.kills.every(signal => signal === 'SIGKILL'));
  assert.equal(fx.store.activeWriters.size, 0);
});

test('绝对终止超时只结算 stage，真实 close 前 discard/store.close 不成功且 active 保留', async t => {
  for (const operation of ['discard', 'close']) {
    await t.test(operation, async () => {
      const child = hangingChild({ closeOnKill:false });
      const fx = await fixture({
        timeoutMs:5_000,
        killGraceMs:5,
        hardTerminationTimeoutMs:20,
        spawnAttachmentWriter:() => child,
      });
      const upload = fx.store.beginUpload();
      const stageOutcome = upload.stage({
        stream:Readable.from(['data']), name:'pending.bin', mime:'', source:'selected',
      }).then(
        () => ({ ok:true }),
        error => ({ ok:false, error }),
      );
      await new Promise(resolvePromise => setImmediate(resolvePromise));
      let lifecycleSettled = false;
      const lifecycle = (operation === 'discard' ? upload.discard() : fx.store.close())
        .finally(() => { lifecycleSettled = true; });
      const outcome = await stageOutcome;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, 'ATTACHMENT_WRITER_TERMINATION_TIMEOUT');
      assert.equal(lifecycleSettled, false);
      assert.equal(fx.store.activeWriters.size, 1);
      assert.ok(child.kills.includes('SIGKILL'));
      assert.equal(child.unrefs, 0, 'sync-pending child 必须继续保持 event-loop 跟踪');
      child.emit('close', null, 'SIGKILL');
      await lifecycle;
      assert.equal(fx.store.activeWriters.size, 0);
      if (operation === 'discard') await fx.store.close();
      await rm(fx.root, { recursive:true, force:true });
    });
  }
});

test('discard 和 store.close 会中止 active writer 并等待资源收敛', async t => {
  const children = [];
  const fx = await fixture({
    timeoutMs:5_000,
    spawnAttachmentWriter:() => {
      const child = hangingChild();
      children.push(child);
      return child;
    },
  });
  t.after(async () => { await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  const pending = upload.stage({ stream:Readable.from(['data']), name:'a.txt', mime:'text/plain', source:'selected' });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await upload.discard();
  await assert.rejects(pending, error => error.code === 'ATTACHMENT_UPLOAD_ABORTED');
  assert.deepEqual(children[0].kills, ['SIGKILL']);

  const other = fx.store.beginUpload();
  const otherPending = other.stage({ stream:Readable.from(['data']), name:'b.txt', mime:'text/plain', source:'selected' });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await fx.store.close();
  await assert.rejects(otherPending, error => error.code === 'ATTACHMENT_STORE_CLOSED');
  assert.deepEqual(children[1].kills, ['SIGKILL']);
});

test('store.close 等待 active 与排队 stage 都完成单次拒绝', async t => {
  const child = hangingChild();
  const fx = await fixture({
    timeoutMs:5_000,
    spawnAttachmentWriter:() => child,
  });
  t.after(async () => { await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  let firstSettled = false;
  let secondSettled = false;
  const first = upload.stage({
    stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected',
  }).finally(() => { firstSettled = true; });
  const second = upload.stage({
    stream:Readable.from(['second']), name:'second.txt', mime:'text/plain', source:'selected',
  }).finally(() => { secondSettled = true; });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await fx.store.close();
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  await assert.rejects(first, error => error.code === 'ATTACHMENT_STORE_CLOSED');
  await assert.rejects(second, error => error.code === 'ATTACHMENT_STORE_CLOSED');
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('publish no-replace 与 committed 错误原样透传且补偿语义明确', async t => {
  const noReplace = Object.assign(new Error('exists'), {
    code:'UNSAFE_SIDECAR_IO', stage:'attachment-publish', committed:false,
  });
  const fx = await fixture({ sidecarIO:{ publishAttachments:async () => { throw noReplace; } } });
  t.after(fx.cleanup);
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['data']), name:'a.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(upload.publish(TASK_ID), error => error === noReplace);
  assert.equal(upload.published, false);
  await upload.discard();

  const committed = Object.assign(new Error('fsync lost ack'), {
    code:'ATTACHMENT_PUBLISH_FAILED', stage:'attachment-directory-fsync',
    committed:true, commitScope:'attachments', details:{ renamed:true },
  });
  const committedFx = await fixture({ sidecarIO:{ publishAttachments:async () => { throw committed; } } });
  t.after(committedFx.cleanup);
  const committedUpload = committedFx.store.beginUpload();
  await committedUpload.stage({ stream:Readable.from(['data']), name:'b.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(committedUpload.publish(TASK_ID), error => error === committed);
  assert.equal(committedUpload.published, true);
  await committedUpload.discard();
  assert.equal(committedFx.calls.discard.length, 0);
});

test('stage 失败后的 committed cleanup 包装保留 helper 语义并以原错误为 cause', async t => {
  const cleanup = Object.assign(new Error('unlink 后 upload fsync 失败'), {
    code:'ATTACHMENT_DELETE_FAILED', statusCode:500, stage:'attachment-delete',
    committed:true, commitScope:'attachments',
    details:{ target:'upload', unlinkedFiles:1, directoryRemoved:false },
  });
  const fx = await fixture({
    sidecarIO:{ discardAttachmentUpload:async () => { throw cleanup; } },
  });
  t.after(async () => { await fx.store.close().catch(() => {}); await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  const broken = new Readable({
    read() {
      this.push('partial');
      queueMicrotask(() => this.destroy(new Error('truncated')));
    },
  });
  await assert.rejects(
    upload.stage({ stream:broken, name:'broken.txt', mime:'text/plain', source:'selected' }),
    error => (
      error !== cleanup
      && error.code === cleanup.code
      && error.stage === cleanup.stage
      && error.committed === true
      && error.commitScope === cleanup.commitScope
      && error.details === cleanup.details
      && error.cause?.code === 'ATTACHMENT_STREAM_ERROR'
    ),
  );
});

test('publish 同步封存 upload，重复调用只执行一次 helper', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  let publishCalls = 0;
  let releasePublish;
  const publishGate = new Promise(resolvePromise => { releasePublish = resolvePromise; });
  fx.sidecarIO.publishAttachments = async payload => {
    publishCalls += 1;
    await publishGate;
    return payload.files.map(file => ({
      id:file.id, size:file.size,
      relativePath:`attachments/${payload.taskId}/${file.id}${file.suffix}`,
    }));
  };
  const upload = fx.store.beginUpload();
  await upload.stage({
    stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected',
  });
  const firstPublish = upload.publish(TASK_ID);
  const repeatedPublish = upload.publish(TASK_ID);
  await assert.rejects(
    upload.stage({
      stream:Readable.from(['late']), name:'late.txt', mime:'text/plain', source:'selected',
    }),
    error => error.code === 'ATTACHMENT_UPLOAD_CLOSED',
  );
  releasePublish();
  const [first, repeated] = await Promise.all([firstPublish, repeatedPublish]);
  assert.deepEqual(repeated, first);
  assert.equal(publishCalls, 1);
});

test('helper 已提交但 relativePath suffix 不匹配时进入 publish-uncertain 且不返回 DTO', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  fx.sidecarIO.publishAttachments = async payload => payload.files.map(file => ({
    id:file.id, size:file.size,
    relativePath:`attachments/${payload.taskId}/${file.id}.forged`,
  }));
  const upload = fx.store.beginUpload();
  await upload.stage({ stream:Readable.from(['data']), name:'a.txt', mime:'text/plain', source:'selected' });
  await assert.rejects(
    upload.publish(TASK_ID),
    error => error.code === 'ATTACHMENT_PUBLISH_PROTOCOL'
      && error.committed === true && error.commitScope === 'attachments',
  );
  assert.equal(upload.state, 'publish-uncertain');
  assert.equal(upload.descriptors, null);
  assert.equal(upload.published, true);
});

test('queued stage 在状态检查失败时也释放 reservedIds', async t => {
  const ids = [
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999',
  ];
  const child = hangingChild();
  const fx = await fixture({ randomUUID:() => ids.shift(), spawnAttachmentWriter:() => child });
  t.after(async () => { await rm(fx.root, { recursive:true, force:true }); });
  const upload = fx.store.beginUpload();
  const first = upload.stage({ stream:Readable.from(['first']), name:'first.txt', mime:'text/plain', source:'selected' });
  const second = upload.stage({ stream:Readable.from(['second']), name:'second.txt', mime:'text/plain', source:'selected' });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  await upload.discard();
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(upload.reservedIds.size, 0);
  await fx.store.close();
});

test('serializeTask 重新净化 DTO 并拒绝不可信 relativePath', async t => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const base = {
    id:FIXED_ID, name:'a.png', mime:'image/png', size:4, source:'selected',
    relativePath:`attachments/${TASK_ID}/${FIXED_ID}.png`,
    createdAt:'2026-08-02T12:00:00.000Z',
  };
  assert.throws(() => fx.store.serializeTask({
    id:TASK_ID,
    attachments:[{ ...base, relativePath:'../../outside' }],
  }), /相对路径/);
  assert.throws(() => fx.store.serializeTask({
    id:TASK_ID,
    attachments:[{ ...base, path:'/tmp/forged' }],
  }), /字段/);
});
