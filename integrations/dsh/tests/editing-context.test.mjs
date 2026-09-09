import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEditingContext } from '../editing-context.mjs';
import { resolveEditingContext } from '../../../scripts/editor/dsh-editing-context.mjs';

test('自然语言与已有会话每步复用明确绑定的工作区，连接更新不串会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aico-chat-context-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let app = { sessionDir:root, deckPath:'/deck.html', workingDeckPath:'/working.html', url:'http://127.0.0.1:1234', token:'ordinary-action', editorToken:'never-share' };
  const workCatalog = { resolveByDshSession:async id => id === 'linked' ? { kind:'editing', workId:'work-a', deckId:'deck-a', deckPath:'/deck.html' } : null };
  let handler;
  let requests = 0;
  installEditingContext({ on(event, callback) { assert.equal(event, 'agent/pre-step'); handler = callback; } }, 'http://127.0.0.1:1235/app/?token=app-secret', {
    fetchContext:async (url, options) => {
      requests++;
      assert.equal(url.pathname, '/api/dsh-work-items/editing-context');
      assert.equal(options.headers.origin, url.origin);
      const context = await resolveEditingContext({ sessionId:JSON.parse(options.body).sessionId, workCatalog,
        findEditingRuntime:({ deckId }) => { assert.equal(deckId, 'deck-a'); return { app }; } });
      return { ok:true, json:async () => context };
    },
  });
  const signal = new AbortController().signal;
  for (const text of ['第二页重新组织', '整体逻辑不顺，先分析', '图片保留，精简内容']) {
    const original = { kind:'continue', messages:[{ text }] };
    const result = await handler({ agent:{ session:{ id:'linked' } }, signal }, async () => original);
    assert.equal(result.messages[0], original.messages[0]);
    const context = result.messages[1].content[0].text;
    assert.match(context, /begin-source-edit/);
    assert.match(context, /讨论和分析只读/);
    assert.match(context, /不得要求退出 Editor/);
    assert.doesNotMatch(context, /ordinary-action|never-share|app-secret/);
  }
  app.token = 'after-restart';
  app.url = 'http://127.0.0.1:4321';
  await handler({ agent:{ session:{ id:'linked' } }, signal }, async () => ({ messages:[] }));
  const capability = JSON.parse(await readFile(join(root, 'workspace-capability.json'), 'utf8'));
  assert.equal(capability.token, 'after-restart');
  assert.equal(capability.url, app.url);
  const ordinary = { messages:[] };
  assert.equal(await handler({ agent:{ session:{ id:'unlinked' } }, signal }, async () => ordinary), ordinary);
  app = null;
  const unavailable = await handler({ agent:{ session:{ id:'linked' } }, signal }, async () => ordinary);
  assert.match(unavailable.messages[0].content[0].text, /不另起 headless/);
  const before = requests;
  const rejected = { kind:'reject' };
  assert.equal(await handler({ agent:{ session:{ id:'linked' } }, signal }, async () => rejected), rejected);
  assert.equal(requests, before);
});

test('同轮相同上下文只注入一次，压缩和新轮次重新注入',async()=>{
 let callback;const events=[{type:'turn/start',seq:1}];
 installEditingContext({on(_event,fn){callback=fn;}},'http://localhost:1234/?token=x',{
  fetchContext:async()=>({ok:true,json:async()=>({status:'ready',workId:'w',deckPath:'/a',workingDeckPath:'/b',capabilityPath:'/c'})})});
 const input={agent:{session:{id:'s',snapshotEvents:()=>events}},signal:new AbortController().signal};
 const decision={messages:[]};
 assert.equal((await callback(input,async()=>decision)).messages.length,1);
 assert.equal(await callback(input,async()=>decision),decision);
 events.push({type:'compaction/end',seq:2});
 assert.equal((await callback(input,async()=>decision)).messages.length,1);
 events.push({type:'turn/start',seq:3});
 assert.equal((await callback(input,async()=>decision)).messages.length,1);
});
