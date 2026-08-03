import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} from '../attachment-protocol.mjs';
import { MAX_SNAPSHOT_BYTES } from '../session-store.mjs';
import { parseTaskMultipart } from '../multipart-task.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TASK_LIMIT = 64 * 1024;
let boundarySequence = 0;

function task(sources = [], overrides = {}) {
  return {
    expectedRevision:3,
    pageKey:'page-001-a',
    pageIndex:1,
    pageLabel:'A',
    rect:{ x:1, y:2, w:300, h:200 },
    instruction:'替换为附件中的新版架构图',
    candidates:[{
      pageKey:'page-001-a', path:'0/1', tag:'IMG', fingerprint:'abc12345',
      rect:{ x:1, y:2, w:300, h:200 },
    }],
    attachmentSources:sources,
    ...overrides,
  };
}

function taskPart(value, overrides = {}) {
  return {
    name:'task', filename:'task.json', mime:'application/json',
    body:Buffer.from(JSON.stringify(value)), ...overrides,
  };
}

function partHeader(boundary, part) {
  const disposition = [`form-data`, `name="${part.name}"`];
  if (Object.hasOwn(part, 'filename')) disposition.push(`filename="${part.filename}"`);
  const headers = [`--${boundary}`];
  if (part.disposition !== false) headers.push(
    `Content-Disposition: ${part.dispositionValue ?? disposition.join('; ')}`,
  );
  if (part.mime !== undefined) headers.push(`Content-Type: ${part.mime}`);
  for (const [name, value] of part.headers ?? []) headers.push(`${name}: ${value}`);
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n`);
}

function multipartBytes(parts, { boundary=`deck-boundary-${++boundarySequence}`, close=true } = {}) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(partHeader(boundary, part), Buffer.from(part.body ?? ''), Buffer.from('\r\n'));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, bytes:Buffer.concat(chunks) };
}

function multipartRequest(parts, options = {}) {
  const encoded = multipartBytes(parts, options);
  const request = Readable.from((async function* chunks() {
    const size = options.chunkSize ?? encoded.bytes.length;
    for (let offset = 0; offset < encoded.bytes.length; offset += size) {
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      yield encoded.bytes.subarray(offset, offset + size);
    }
  })());
  request.headers = {
    'content-type':`multipart/form-data; boundary=${encoded.boundary}`,
    ...options.headers,
  };
  return request;
}

function controlledRequest(boundary=`deck-boundary-${++boundarySequence}`) {
  const request = new PassThrough();
  request.headers = { 'content-type':`multipart/form-data; boundary=${boundary}` };
  return { request, boundary };
}

function uploadFixture({ stageFailure, discardFailure, discardResult, stageGate } = {}) {
  const calls = { begin:0, discard:0, stage:[] };
  const active = new Set();
  const upload = {
    staged:[],
    async stage(input) {
      const call = {
        ...input, stream:undefined, sourceStream:input.stream,
        chunks:[], size:0, settled:false,
      };
      calls.stage.push(call);
      const operation = (async () => {
        try {
          if (stageGate) await stageGate;
          for await (const chunk of input.stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            call.chunks.push(bytes);
            call.size += bytes.length;
            if (stageFailure?.(call, calls.stage.length - 1)) {
              if (stageFailure.destroyStream) {
                input.stream.destroy(stageFailure.error);
                await new Promise(resolve => setImmediate(resolve));
              }
              throw stageFailure.error;
            }
          }
          if (input.stream.truncated) {
            throw Object.assign(new Error('附件流被截断'), {
              code:'ATTACHMENT_TOO_LARGE', statusCode:413, stage:'attachment-write',
            });
          }
          if (call.size === 0) {
            throw Object.assign(new Error('附件不能为空'), {
              code:'ATTACHMENT_EMPTY', statusCode:400, stage:'attachment-write',
            });
          }
          if (call.size > MAX_ATTACHMENT_BYTES) {
            throw Object.assign(new Error('附件过大'), {
              code:'ATTACHMENT_TOO_LARGE', statusCode:413, stage:'attachment-write',
            });
          }
          const record = Object.freeze({
            id:`attachment-${calls.stage.length}`, name:input.name, mime:input.mime,
            source:input.source, size:call.size,
          });
          upload.staged.push(record);
          return record;
        } finally {
          call.settled = true;
        }
      })();
      active.add({ stream:input.stream, operation });
      operation.finally(() => {
        for (const item of active) if (item.operation === operation) active.delete(item);
      }).catch(() => {});
      return operation;
    },
    async discard() {
      calls.discard += 1;
      const reason = Object.assign(new Error('upload discarded'), { code:'UPLOAD_DISCARDED' });
      for (const item of active) item.stream.destroy(reason);
      await Promise.allSettled([...active].map(item => item.operation));
      if (discardFailure) throw discardFailure;
      return discardResult ?? { removed:true };
    },
  };
  return {
    calls,
    upload,
    store:{
      beginUpload() {
        calls.begin += 1;
        return upload;
      },
    },
  };
}

async function rejectsMultipart(request, fx, code = 'INVALID_MULTIPART') {
  await assert.rejects(
    parseTaskMultipart(request, { attachmentStore:fx.store }),
    error => {
      assert.equal(error.code, code);
      if (['INVALID_MULTIPART', 'TOO_MANY_ATTACHMENTS', 'SNAPSHOT_TOO_LARGE']
        .includes(code)) assert.equal(error.stage, 'multipart');
      assert.ok(Number.isInteger(error.statusCode));
      return true;
    },
  );
  assert.equal(fx.calls.discard, 1);
  assert.ok(fx.calls.stage.every(call => call.settled));
  for (const event of ['aborted', 'error', 'data', 'end']) {
    assert.equal(request.listenerCount(event), 0, `request 残留 ${event} listener`);
  }
  assert.ok(fx.calls.stage.every(call => call.sourceStream.listenerCount('limit') === 0));
}

test('真实 multipart 成功净化 task、收集 PNG，并按 part 顺序流式 stage', async () => {
  const fx = uploadFixture();
  const request = multipartRequest([
    taskPart(task(['selected', 'pasted'])),
    { name:'snapshot', filename:'region.png', mime:'image/png', body:PNG },
    { name:'attachment', filename:'说明.txt', mime:'text/plain', body:'reference' },
    { name:'attachment', filename:'新版.png', mime:'image/png', body:PNG },
  ], { chunkSize:3 });
  const parsed = await parseTaskMultipart(request, { attachmentStore:fx.store });

  assert.deepEqual(parsed.input, {
    expectedRevision:3,
    pageKey:'page-001-a', pageIndex:1, pageLabel:'A',
    rect:{ x:1, y:2, w:300, h:200 },
    instruction:'替换为附件中的新版架构图',
    candidates:task().candidates,
  });
  assert.deepEqual(parsed.snapshot, PNG);
  assert.equal(parsed.upload, fx.upload);
  assert.deepEqual(parsed.staged, fx.upload.staged);
  assert.deepEqual(fx.calls.stage.map(call => [call.name, call.mime, call.source, call.size]), [
    ['说明.txt', 'text/plain', 'selected', 9],
    ['新版.png', 'image/png', 'pasted', PNG.length],
  ]);
  assert.equal(fx.calls.discard, 0);
  assert.ok(fx.calls.stage.every(call => call.sourceStream.listenerCount('limit') === 0));
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('error'), 0);
});

test('snapshot 与 attachment 均为零时返回 null 与空可信记录', async () => {
  const fx = uploadFixture();
  const parsed = await parseTaskMultipart(multipartRequest([
    taskPart(task([])),
  ]), { attachmentStore:fx.store });
  assert.equal(parsed.snapshot, null);
  assert.deepEqual(parsed.staged, []);
  assert.equal(fx.calls.stage.length, 0);
  assert.equal(fx.calls.discard, 0);
});

test('task 必须是首个、有 filename 的唯一 application/json file part', async t => {
  const cases = [
    ['缺少 task', [{ name:'snapshot', filename:'a.png', mime:'image/png', body:PNG }]],
    ['普通 field task', [{
      name:'task', mime:'application/json', body:JSON.stringify(task()),
    }]],
    ['task MIME 错误', [taskPart(task(), { mime:'text/plain' })]],
    ['task 晚到', [
      { name:'attachment', filename:'a.txt', mime:'text/plain', body:'a' }, taskPart(task(['selected'])),
    ]],
    ['task 重复', [taskPart(task()), taskPart(task())]],
  ];
  for (const [name, parts] of cases) await t.test(name, async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest(parts), fx);
    assert.equal(fx.calls.stage.length, 0);
  });
});

test('task 元数据严格执行 64 KiB、fatal UTF-8、对象与区域请求白名单校验', async t => {
  await t.test('精确 64 KiB', async () => {
    const exact = task();
    const initial = Buffer.from(JSON.stringify(exact));
    exact.instruction += 'x'.repeat(TASK_LIMIT - initial.length);
    const body = Buffer.from(JSON.stringify(exact));
    assert.equal(body.length, TASK_LIMIT);
    const fx = uploadFixture();
    const parsed = await parseTaskMultipart(multipartRequest([
      taskPart(exact, { body }),
    ], { chunkSize:4096 }), { attachmentStore:fx.store });
    assert.equal(parsed.input.instruction.length, exact.instruction.length);
  });
  const oversized = Buffer.alloc(TASK_LIMIT + 1, 0x20);
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
  const cases = [
    ['超限', taskPart(task(), { body:oversized })],
    ['非法 UTF-8', taskPart(task(), { body:invalidUtf8 })],
    ['非对象', taskPart([])],
    ['expectedRevision 非法', taskPart(task([], { expectedRevision:-1 }))],
    ['缺少区域字段', taskPart(task([], { pageIndex:undefined }))],
    ['区域越界', taskPart(task([], { rect:{ x:1900, y:0, w:30, h:10 } }))],
    ['用户 attachments DTO', taskPart(task([], { attachments:[] }))],
    ['未知根字段', taskPart(task([], { status:'pending' }))],
    ['来源非法', taskPart(task(['remote']))],
  ];
  for (const [name, part] of cases) await t.test(name, async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([part]), fx);
  });
});

test('snapshot 仅接受零或一个有 filename 的 PNG，且 512 KiB 精确边界成功', async t => {
  await t.test('恰好 512 KiB', async () => {
    const fx = uploadFixture();
    const bytes = Buffer.alloc(MAX_SNAPSHOT_BYTES, 7);
    const parsed = await parseTaskMultipart(multipartRequest([
      taskPart(task()),
      { name:'snapshot', filename:'region.png', mime:'image/png', body:bytes },
    ], { chunkSize:64 * 1024 }), { attachmentStore:fx.store });
    assert.equal(parsed.snapshot.length, MAX_SNAPSHOT_BYTES);
    assert.equal(fx.calls.discard, 0);
  });
  const cases = [
    ['普通 field', { name:'snapshot', mime:'image/png', body:'not-file' }, 'INVALID_MULTIPART'],
    ['错误 MIME', { name:'snapshot', filename:'a.jpg', mime:'image/jpeg', body:PNG }, 'INVALID_MULTIPART'],
    ['目录 filename', { name:'snapshot', filename:'folder/', mime:'image/png', body:PNG }, 'INVALID_MULTIPART'],
    ['超过限制', {
      name:'snapshot', filename:'a.png', mime:'image/png',
      body:Buffer.alloc(MAX_SNAPSHOT_BYTES + 1),
    }, 'SNAPSHOT_TOO_LARGE'],
  ];
  for (const [name, snapshot, code] of cases) await t.test(name, async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([taskPart(task()), snapshot]), fx, code);
  });
  await t.test('重复', async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([
      taskPart(task()),
      { name:'snapshot', filename:'a.png', mime:'image/png', body:PNG },
      { name:'snapshot', filename:'b.png', mime:'image/png', body:PNG },
    ]), fx);
  });
});

test('attachment 只允许 0–8 个非目录非空文件并严格匹配 sources 数量和顺序', async t => {
  await t.test('八个附件成功并保留 part 顺序', async () => {
    const sources = Array.from({ length:MAX_ATTACHMENTS }, (_, index) => (
      index % 2 ? 'pasted' : 'selected'
    ));
    const fx = uploadFixture();
    const parsed = await parseTaskMultipart(multipartRequest([
      taskPart(task(sources)),
      ...sources.map((source, index) => ({
        name:'attachment', filename:`${index}.bin`, mime:'application/octet-stream',
        body:Buffer.from([index + 1]), source,
      })),
    ], { chunkSize:11 }), { attachmentStore:fx.store });
    assert.equal(parsed.staged.length, MAX_ATTACHMENTS);
    assert.deepEqual(fx.calls.stage.map(call => call.source), sources);
  });
  await t.test('task + snapshot + 八个附件是合法十 part 最大值', async () => {
    const sources = Array(MAX_ATTACHMENTS).fill('selected');
    const fx = uploadFixture();
    const parsed = await parseTaskMultipart(multipartRequest([
      taskPart(task(sources)),
      { name:'snapshot', filename:'region.png', mime:'image/png', body:PNG },
      ...sources.map((_, index) => ({
        name:'attachment', filename:`${index}.bin`, mime:'application/octet-stream',
        body:Buffer.from([index + 1]),
      })),
    ], { chunkSize:13 }), { attachmentStore:fx.store });
    assert.equal(parsed.snapshot.length, PNG.length);
    assert.equal(parsed.staged.length, MAX_ATTACHMENTS);
    assert.equal(fx.calls.discard, 0);
  });
  await t.test('九个附件触发 files/parts 上限', async () => {
    const sources = Array(MAX_ATTACHMENTS + 1).fill('selected');
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([
      taskPart(task(sources)),
      ...sources.map((_, index) => ({
        name:'attachment', filename:`${index}.bin`, mime:'application/octet-stream', body:'x',
      })),
    ]), fx, 'TOO_MANY_ATTACHMENTS');
  });
  for (const [name, sources, files, code] of [
    ['source 少一个', [], [{ name:'attachment', filename:'a', mime:'x/a', body:'x' }], 'INVALID_MULTIPART'],
    ['source 多一个', ['selected'], [], 'INVALID_MULTIPART'],
    ['空文件', ['selected'], [{ name:'attachment', filename:'a', mime:'x/a', body:'' }], 'ATTACHMENT_EMPTY'],
    ['目录 filename', ['selected'], [{ name:'attachment', filename:'folder/', mime:'x/a', body:'x' }], 'INVALID_MULTIPART'],
  ]) await t.test(name, async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([taskPart(task(sources)), ...files]), fx, code);
  });
});

test('attachment 25 MiB 精确成功，25 MiB + 1 的 busboy limit 绝不接受截断记录', async t => {
  await t.test('精确边界', async () => {
    const fx = uploadFixture();
    const parsed = await parseTaskMultipart(multipartRequest([
      taskPart(task(['selected'])),
      {
        name:'attachment', filename:'max.bin', mime:'application/octet-stream',
        body:Buffer.alloc(MAX_ATTACHMENT_BYTES, 5),
      },
    ], { chunkSize:128 * 1024 }), { attachmentStore:fx.store });
    assert.equal(parsed.staged[0].size, MAX_ATTACHMENT_BYTES);
    assert.ok(fx.calls.stage[0].chunks.length > 1, '附件必须以多 chunk 流交给 stage');
  });
  await t.test('超一个字节', async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([
      taskPart(task(['selected'])),
      {
        name:'attachment', filename:'large.bin', mime:'application/octet-stream',
        body:Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 5),
      },
    ], { chunkSize:128 * 1024 }), fx, 'ATTACHMENT_TOO_LARGE');
    assert.equal(fx.upload.staged.length, 0, '截断 Buffer 不得成为可信 stage record');
  });
});

test('未知 part、普通 field 与 parts/fields limit 全部 fail-closed', async t => {
  const cases = [
    ['未知文件', [taskPart(task()), { name:'avatar', filename:'a.png', mime:'image/png', body:PNG }]],
    ['普通 field', [taskPart(task()), { name:'note', body:'hello' }]],
  ];
  for (const [name, parts] of cases) await t.test(name, async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest(parts), fx);
  });
});

test('超量或畸形 part headers 与缺失结束 boundary 触发 parser fail-closed', async t => {
  await t.test('header block 超过 busboy 上限', async () => {
    const fx = uploadFixture();
    const request = multipartRequest([
      taskPart(task(), { headers:[['X-Fill', 'a'.repeat(20 * 1024)]] }),
    ], { chunkSize:512, delayMs:1 });
    await rejectsMultipart(request, fx);
    if (!request.readableEnded) await Promise.race([
      new Promise(resolve => request.once('end', resolve)),
      new Promise(resolve => setTimeout(resolve, 50)),
    ]);
    assert.equal(request.readableEnded, true, 'parser error 后仍须 drain HTTP request');
  });
  await t.test('2100 个短 header 未达 16 KiB 也必须拒绝', async () => {
    const headers = Array.from({ length:2100 }, () => ['X', 'a']);
    const encoded = multipartBytes([taskPart(task(), { headers })]);
    assert.ok(encoded.bytes.length < 16 * 1024);
    const request = multipartRequest([taskPart(task(), { headers })], { chunkSize:37 });
    const fx = uploadFixture();
    await rejectsMultipart(request, fx);
  });
  await t.test('Busboy 静默跳过的物理首 part 仍会被拒绝', async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([
      { disposition:false, name:'ignored', headers:[['X-Unknown', '1']], body:'junk' },
      taskPart(task()),
    ], { chunkSize:5 }), fx);
  });
  for (const [name, dispositionValue] of [
    ['非 form-data', 'attachment; name="ignored"; filename="ignored.bin"'],
    ['缺少 name', 'form-data; filename="ignored.bin"'],
  ]) await t.test(name, async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([
      {
        name:'ignored', dispositionValue, mime:'application/octet-stream', body:'junk',
      },
      taskPart(task()),
    ], { chunkSize:4 }), fx);
  });
  await t.test('重复 Content-Disposition 必须拒绝', async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([
      taskPart(task(), { headers:[['Content-Disposition', 'form-data; name="task"; filename="other.json"']] }),
    ]), fx);
  });
  await t.test('boundary 截断', async () => {
    const fx = uploadFixture();
    await rejectsMultipart(multipartRequest([
      taskPart(task(['selected'])),
      { name:'attachment', filename:'a.txt', mime:'text/plain', body:'partial' },
    ], { close:false, chunkSize:7 }), fx);
  });
});

test('附件正文中的 boundary 行前缀跨 chunk 时 fail-closed，绝不返回截断记录', async () => {
  const boundary = 'deck-near-boundary';
  const body = Buffer.from(`prefix\r\n--${boundary}X-not-a-delimiter\r\nsuffix`);
  const fx = uploadFixture();
  await rejectsMultipart(multipartRequest([
    taskPart(task(['selected'])),
    { name:'attachment', filename:'near.bin', mime:'application/octet-stream', body },
  ], { boundary, chunkSize:3 }), fx);
});

test('stage 失败会取消部分 writer、等待 drain，并且只 discard 一次', async () => {
  const stageError = Object.assign(new Error('disk full'), {
    code:'ATTACHMENT_WRITE_FAILED', statusCode:500, stage:'attachment-write',
  });
  const failure = Object.assign(call => call.size >= 4, {
    error:stageError, destroyStream:true,
  });
  const fx = uploadFixture({ stageFailure:failure });
  const request = multipartRequest([
    taskPart(task(['selected', 'selected'])),
    { name:'attachment', filename:'a.bin', mime:'x/a', body:'partial-a' },
    { name:'attachment', filename:'b.bin', mime:'x/b', body:'partial-b' },
  ], { chunkSize:2, delayMs:1 });
  await assert.rejects(
    parseTaskMultipart(request, { attachmentStore:fx.store }),
    error => error === stageError,
  );
  assert.equal(fx.calls.discard, 1);
  assert.ok(fx.calls.stage.every(call => call.settled));
  for (const event of ['aborted', 'error', 'data', 'end']) {
    assert.equal(request.listenerCount(event), 0, `request 残留 ${event} listener`);
  }
  assert.ok(fx.calls.stage.every(call => call.sourceStream.listenerCount('limit') === 0));
});

test('committed cleanup 错误优先传播，未提交 cleanup 错误不隐藏首个解析错误', async t => {
  const committed = Object.assign(new Error('discard fsync lost ack'), {
    code:'UNSAFE_SIDECAR_IO', statusCode:500, stage:'attachment-discard',
    committed:true, commitScope:'attachment-staging',
  });
  await t.test('committed 优先', async () => {
    const fx = uploadFixture({ discardFailure:committed });
    await assert.rejects(
      parseTaskMultipart(multipartRequest([{ name:'note', body:'bad' }]), {
        attachmentStore:fx.store,
      }),
      error => error === committed && error.cause?.code === 'INVALID_MULTIPART',
    );
    assert.equal(fx.calls.discard, 1);
  });
  await t.test('未提交作为 cleanupError', async () => {
    const cleanup = Object.assign(new Error('busy'), {
      code:'ATTACHMENT_BUSY', statusCode:409, committed:false,
    });
    const fx = uploadFixture({ discardFailure:cleanup });
    await assert.rejects(
      parseTaskMultipart(multipartRequest([{ name:'note', body:'bad' }]), {
        attachmentStore:fx.store,
      }),
      error => error.code === 'INVALID_MULTIPART' && error.cleanupError === cleanup,
    );
    assert.equal(fx.calls.discard, 1);
  });
  await t.test('cleanupFrozen retained 留给 reconcile 且不伪造删除失败', async () => {
    const fx = uploadFixture({
      discardResult:{ removed:false, retained:true, reason:'untrusted-baseline' },
    });
    await assert.rejects(
      parseTaskMultipart(multipartRequest([{ name:'note', body:'bad' }]), {
        attachmentStore:fx.store,
      }),
      error => error.code === 'INVALID_MULTIPART' && error.cleanupError === undefined,
    );
    assert.equal(fx.calls.discard, 1);
  });
});

test('慢 stage/backpressure 未 settle 前解析不会返回，成功后无残留监听器', async () => {
  let releaseStage;
  const stageGate = new Promise(resolve => { releaseStage = resolve; });
  const fx = uploadFixture({ stageGate });
  const request = multipartRequest([
    taskPart(task(['selected'])),
    { name:'attachment', filename:'slow.bin', mime:'application/octet-stream', body:'slow-data' },
  ], { chunkSize:1 });
  let settled = false;
  const parsing = parseTaskMultipart(request, { attachmentStore:fx.store })
    .finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  releaseStage();
  await parsing;
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('error'), 0);
  assert.equal(request.listenerCount('data'), 0);
  assert.equal(request.listenerCount('end'), 0);
  assert.ok(fx.calls.stage.every(call => call.settled));
});

test('request aborted/error 会取消活跃 stage、等待 drain 并移除自身监听器', async t => {
  await t.test('调用前已 aborted', async () => {
    const fx = uploadFixture();
    const request = multipartRequest([taskPart(task())]);
    request.aborted = true;
    await rejectsMultipart(request, fx);
  });
  for (const event of ['aborted', 'error']) await t.test(event, async () => {
    const fx = uploadFixture();
    const { request, boundary } = controlledRequest();
    const parsing = parseTaskMultipart(request, { attachmentStore:fx.store });
    request.write(partHeader(boundary, taskPart(task(['selected']))));
    request.write(Buffer.from(JSON.stringify(task(['selected']))));
    request.write(Buffer.from(`\r\n${partHeader(boundary, {
      name:'attachment', filename:'slow.bin', mime:'application/octet-stream',
    }).toString()}`));
    request.write('partial');
    await new Promise(resolve => setImmediate(resolve));
    const failure = Object.assign(new Error('client reset'), { code:'ECONNRESET' });
    request.emit(event, failure);
    if (!request.destroyed) request.destroy();
    await assert.rejects(parsing, error => error.code === 'INVALID_MULTIPART');
    assert.equal(fx.calls.discard, 1);
    assert.ok(fx.calls.stage.every(call => call.settled));
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(request.listenerCount('error'), 0);
    assert.equal(request.listenerCount('data'), 0);
    assert.equal(request.listenerCount('end'), 0);
  });
});

test('Busboy 构造错误也由 parser 单一所有权 discard', async () => {
  const fx = uploadFixture();
  const request = Readable.from([]);
  request.headers = { 'content-type':'text/plain' };
  await rejectsMultipart(request, fx);
});
