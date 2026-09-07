import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDeckWithSystemPicker } from '../system-picker.mjs';

test('桌面文件选择通过私有对话框通道，不启动 Python GUI', async () => {
  const result = await pickDeckWithSystemPicker({
    environment:{ AICO_DESKTOP_DIALOG_URL:'http://127.0.0.1:45001/pick', AICO_DESKTOP_DIALOG_TOKEN:'private' },
    spawnProcess:() => { throw new Error('桌面不应启动外部选择器'); },
    fetchRequest:async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:45001/pick');
      assert.equal(options.headers.Authorization, 'Bearer private');
      assert.equal(JSON.parse(options.body).kind, 'deck');
      return { ok:true, json:async () => ({ path:'/tmp/测试 Deck.html' }) };
    },
  });
  assert.equal(result, '/tmp/测试 Deck.html');
});
