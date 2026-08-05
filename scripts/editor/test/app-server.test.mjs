import test from 'node:test';
import assert from 'node:assert/strict';
import { startAppServer } from '../app-server.mjs';

function post(app, path) {
  return fetch(`${app.url}${path}?token=${encodeURIComponent(app.token)}`, {
    method:'POST', headers:{ origin:app.url },
  });
}

test('导入页声明一次只添加一份 HTML，并要求随机令牌', async t => {
  const app = await startAppServer({ token:'app-secret', pickDeck:async () => null });
  t.after(() => app.close());

  assert.equal((await fetch(`${app.url}/app/`)).status, 403);
  const response = await fetch(app.appUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /添加 Deck HTML/);
  assert.match(html, /一次只处理一份文件/);
  assert.match(html, /不提供切换或再次添加入口/);
});

test('选择状态原子锁定；取消可重试，成功后关闭导入入口', async t => {
  let releaseFirst;
  let pickCount = 0;
  let startCount = 0;
  let startOptions;
  const pickDeck = async () => {
    pickCount += 1;
    if (pickCount === 1) return new Promise(resolve => { releaseFirst = resolve; });
    return '/tmp/唯一-deck.html';
  };
  const app = await startAppServer({
    token:'app-secret',
    pickDeck,
    startEditor:async options => {
      startCount += 1;
      startOptions = options;
      return {
        url:'http://127.0.0.1:45678', token:'deck-token', editorToken:'editor-token',
        close:async () => {},
      };
    },
  });
  t.after(() => app.close());

  const first = post(app, '/api/choose-deck');
  while (!releaseFirst) await new Promise(resolve => setImmediate(resolve));
  const concurrent = await post(app, '/api/choose-deck');
  assert.equal(concurrent.status, 409);
  assert.equal((await concurrent.json()).code, 'DECK_SELECTION_IN_PROGRESS');

  releaseFirst(null);
  assert.equal((await first.then(response => response.json())).status, 'cancelled');
  const selected = await post(app, '/api/choose-deck').then(response => response.json());
  assert.equal(selected.status, 'selected');
  assert.match(selected.editorUrl, /editorToken=editor-token/);
  assert.equal(pickCount, 2);
  assert.equal(startCount, 1);
  assert.equal(startOptions.agentProvider, 'codex');
  assert.equal(startOptions.agentThreadId, null);
  assert.equal(app.state, 'selected');
});
