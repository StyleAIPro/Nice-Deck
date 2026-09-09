import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorViews} from '../editor-view.mjs';
import {loadChromium,chromiumLaunchOptions} from '../../verify/load-playwright.mjs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';

test('页面图包含未固化动作和父容器；重复查看复用缓存，新动作不复用旧图',async()=>{
 let inner=await readFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'),'utf8');
 inner=inner.replace('<section data-label="目录页">','<section data-page-id="page-11111111111111111111111111111111" data-label="目录页">');
 inner=inner.replace('<h2>第一页标题</h2>','<h2 data-editor-id="element-11111111111111111111111111111111">第一页标题</h2>');
 // 编辑器会重新生成补丁 runtime；测试 bundle 只负责解包。
 inner=inner.replace('<script src="../../runtime/patch-runtime.js"></script>','');
 const bytes=Buffer.from('<script type="__bundler/manifest">\n{}\n</script>\n<script type="__bundler/template">\n'+JSON.stringify(inner).replaceAll('</','<\\u002F')+'\n</script>\n<script>const html=JSON.parse(document.querySelector(\'script[type="__bundler/template"]\').textContent);document.open();document.write(html);document.close();</script>');
 let launches=0;
 const view=createEditorViews({launch:async()=>{launches++;return(await loadChromium()).launch(chromiumLaunchOptions());}});
 const initial=await view({bytes,actions:[]},{query:'第一页标题'});
 const target=initial.targets.find(t=>t.target.tag==='H2').target;
 const action={id:'change',target,kind:'setText',payload:{text:'修改后的标题'},before:'第一页标题',after:'修改后的标题'};
 const changed=await view({bytes,actions:[action]},{query:'修改后的标题'});
 assert.ok(changed.targets.some(t=>t.text==='修改后的标题'));
 assert.notEqual(changed.stateId,initial.stateId);
 assert.notEqual(changed.image,initial.image);
 assert.equal(Buffer.from(changed.image,'base64').subarray(1,4).toString(),'PNG');
 assert.deepEqual(await view({bytes,actions:[action]},{query:'修改后的标题'}),changed);
 assert.equal(launches,2);
});
