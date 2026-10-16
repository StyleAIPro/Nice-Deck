import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {startFixtureServer,openEditor} from './test-helpers.mjs';
import {verifyWorkingPatchReplay} from '../working-deck-store.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64');
const session=app=>fetch(`${app.url}/api/session?token=${app.token}`).then(r=>r.json());
async function post(app,path,body){
 const response=await fetch(`${app.url}${path}?token=${app.token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
async function setup(t){
 const app=await startFixtureServer({bundle:true,workingPatchVerifier:verifyWorkingPatchReplay});t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const target=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('.card')));
 return {app,page,target};
}
async function upload(app,target){
 const body=new FormData();
 body.append('task',new Blob([JSON.stringify({expectedRevision:(await session(app)).revision,
  pageKey:target.pageKey,pageIndex:1,pageLabel:'测试页',rect:{x:1,y:1,w:100,h:100},
  instruction:'使用上传的图片',attachmentSources:['selected']})],{type:'application/json'}),'task.json');
 body.append('snapshot',new Blob([png],{type:'image/png'}),'snapshot.png');
 body.append('attachment',new Blob([png],{type:'image/png'}),'中文 图片.png');
 const response=await fetch(`${app.url}/api/tasks?token=${app.token}`,{method:'POST',body});
 const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));
 return result.task.attachments[0];
}
async function edit(app,target,kind,payload){
 return post(app,'/api/local-edits',{expectedRevision:(await session(app)).revision,commandId:randomUUID(),operations:[{target,kind,payload}]});
}

test('附件路径在插入和替换时内嵌，完整浏览器验证通过且撤销重做保留图片',async t=>{
 const {app,page,target}=await setup(t);
 const attachment=await upload(app,target);
 // Windows 真实路径使用正斜杠，复现模型生成 C:/... 的请求。
 const path=attachment.path.replaceAll('\\','/');
 const result=await edit(app,target,'insertFragment',{html:`<img alt="附件回归" src="${path}">`});
 assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(result.body.committed,true);
 assert.ok(!(await readFile(app.workingDeckPath,'utf8')).includes(path),'附件必须写入 bundle，不能保留文件路径');
 await page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('img[alt="附件回归"]')?.naturalWidth===1);
 for(const method of ['undo','redo']){
  const response=await post(app,`/api/groups/${result.body.groupId}/${method}`,{expectedRevision:(await session(app)).revision});
  assert.equal(response.status,200,JSON.stringify(response));
  await page.waitForFunction(method=>{
   const img=document.querySelector('#deck-frame')?.contentDocument?.querySelector('img[alt="附件回归"]');
   return method==='undo'?!img:img?.naturalWidth===1;
  },method);
 }
 const imageTarget=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('img')));
 const replaced=await edit(app,imageTarget,'replaceImage',{attachmentPath:attachment.path});
 assert.equal(replaced.status,200,JSON.stringify(replaced));
});

test('无法解码的图片在提交前被拒绝并回滚，返回页码且仍能继续编辑',async t=>{
 const {app,page,target}=await setup(t);
 const before=await readFile(app.workingDeckPath);
 const result=await edit(app,target,'insertFragment',{html:'<img alt="损坏图片" src="data:image/png;base64,YmFk">'});
 assert.equal(result.status,409,JSON.stringify(result));
 assert.equal(result.body.error,'RESOURCE_LOAD_FAILED');
 assert.equal(result.body.committed,false);
 assert.equal(result.body.resources[0].pageKey,target.pageKey);
 assert.equal(result.body.resources[0].pageIndex,1);
 assert.match(result.body.message,/图片/);
 assert.deepEqual(await readFile(app.workingDeckPath),before);
 const state=await session(app);assert.equal(state.groups.length,0);assert.equal(state.sourceEdit,undefined);
 const retry=await edit(app,target,'setShape',{shape:'ellipse'});
 assert.equal(retry.status,200,JSON.stringify(retry));
 await page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('[data-aico-shape="ellipse"]'));
});

test('未登记路径不会读取，失败明确未提交且不写历史',async t=>{
 const {app,target}=await setup(t);
 const before=await readFile(app.workingDeckPath);
 const result=await edit(app,target,'insertFragment',{html:'<img src="C:/Users/other/private.png">'});
 assert.equal(result.status,409,JSON.stringify(result));
 assert.equal(result.body.error,'LOCAL_IMAGE_UNAVAILABLE');
 assert.equal(result.body.committed,false);
 assert.deepEqual(await readFile(app.workingDeckPath),before);
 assert.equal((await session(app)).groups.length,0);
});

test('错误栏显示出错页和图片名称，同一图片重复事件不刷屏',async t=>{
 const app=await startFixtureServer({bundle:true,fixtureTransform:html=>html.replace('卡片 A','卡片 A<img alt="通信域截图" src="C:/missing/screenshot.png">')});
 t.after(()=>app.close());const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const result=await page.locator('#deck-frame').evaluate(frame=>{
  const img=frame.contentDocument.querySelector('img');
  for(let i=0;i<3;i++)img.dispatchEvent(new frame.contentWindow.Event('error'));
  return frame.contentDocument.querySelector('#__bundler_err')?.textContent;
 });
 assert.match(result,/第 1 页 目录页：图片加载失败/);
 assert.match(result,/通信域截图/);assert.match(result,/screenshot\.png/);
 assert.equal(result.split('\n').length,1);
});
