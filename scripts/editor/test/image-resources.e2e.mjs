import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {startFixtureServer,openEditor} from './test-helpers.mjs';
import {verifyWorkingPatchReplay} from '../working-deck-store.mjs';
import {installEditingTools} from '../../../integrations/dsh/editing-tools.mjs';
import {writeWorkspaceCapability} from '../workspace-capability.mjs';

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

test('聊天大图经原生 PPT 工具内嵌进 Deck，插入替换、回执重放和撤销重做可用',async t=>{
 const {app,page,target}=await setup(t);
 // 无损噪声图超过旧接口的 1 MiB 请求和 100000 字符片段限制。
 const data=execFileSync('python3',['-c',[
  'import random, struct, sys, zlib',
  'def chunk(k, v): return struct.pack(">I", len(v)) + k + v + struct.pack(">I", zlib.crc32(k + v))',
  'pixels = random.Random(42).randbytes(768 * 768 * 3)',
  'raw = b"".join(b"\\0" + pixels[i:i+768*3] for i in range(0, len(pixels), 768*3))',
  'sys.stdout.buffer.write(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 768, 768, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))',
 ].join('\n')],{maxBuffer:4*1024*1024});
 assert.ok(data.length>1024*1024);
 const attachment={attachmentId:`sha256:${createHash('sha256').update(data).digest('hex')}`,mediaType:'image/png',bytes:data.length,width:768,height:768,name:'聊天训练曲线.png'};
 const fileBytes=Buffer.from('普通文件也直接插入');
 const file={attachmentId:`sha256:${createHash('sha256').update(fileBytes).digest('hex')}`,bytes:fileBytes.length,name:'材料.txt'};
 const capabilityPath=await writeWorkspaceCapability(app.sessionDir,{url:app.url,token:app.token});
 const events=[{type:'user/message',data:{source:{kind:'user'},content:[{type:'image',attachment},{type:'file',attachment:file}]}},
  {type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'本轮工具'}]}}}];
 let tool,reads=0;
 installEditingTools({tools:{register:value=>{tool=value;}},attachments:{saveImage:async()=>({attachmentId:'结果预览'}),readImage:async ref=>{reads++;assert.deepEqual(ref,attachment);return {ref,data};},async *readFileStream(ref){assert.deepEqual(ref,file);yield fileBytes;}}},'http://localhost:1234/?token=fixture',{
  request:(url,options)=>new URL(url).pathname.includes('editing-context')
   ?Promise.resolve({ok:true,json:async()=>({status:'ready',workId:'w',capabilityPath,feedbackTasks:[]})})
   :fetch(url,options),
 });
 const exec={agent:{session:{id:'s',snapshotEvents:()=>events}},callId:'本轮工具',signal:new AbortController().signal};
 const inspected=await tool.execute({operation:'inspect',target},exec);
 assert.equal(inspected.chatImages[0].src,`attachment:${attachment.attachmentId}`);
 const commandId=randomUUID();
 const args={operation:'structure',workId:'w',expectedRevision:inspected.revision,commandId,operations:[
  {target,kind:'insertFragment',payload:{html:`<img alt="聊天插图" style="width:80px;height:80px" src="${inspected.chatImages[0].src}"><a download="材料.txt" href="${inspected.chatFiles[0].src}">材料.txt</a>`}},
 ]};
 const result=await tool.execute(args,exec);
 assert.equal(result.committed,true,JSON.stringify(result));
 await page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('img[alt="聊天插图"]')?.naturalWidth===768);
 assert.equal(await page.locator('#deck-frame').evaluate(async frame=>{
  const link=frame.contentDocument.querySelector('a[download="材料.txt"]');
  return (await frame.contentWindow.fetch(link.href)).text();
 }),'普通文件也直接插入');
 const bundle=await readFile(app.workingDeckPath,'utf8');
 assert.ok(bundle.includes(data.toString('base64')),'图片应内嵌在 bundle manifest');
 assert.ok(!bundle.includes(inspected.chatImages[0].src),'Deck 不依赖聊天附件或宿主地址');
 assert.equal((await session(app)).tasks.length,0,'聊天插图不创建多余反馈任务');
 const replay=await tool.execute(args,exec);
 assert.equal(replay.committed,true);assert.equal(reads,1,'已提交命令重放不再依赖聊天图片服务');
 for(const method of ['undo','redo']){
  const response=await post(app,`/api/groups/${result.groupId}/${method}`,{expectedRevision:(await session(app)).revision});
  assert.equal(response.status,200,JSON.stringify(response));
  await page.waitForFunction(method=>{
   const img=document.querySelector('#deck-frame')?.contentDocument?.querySelector('img[alt="聊天插图"]');
   return method==='undo'?!img:img?.naturalWidth===768;
  },method);
 }
 const imageTarget=await page.locator('#deck-frame').evaluate(frame=>frame.contentWindow.HuaweiDeckPatchRuntime.makeLocator(frame.contentDocument.querySelector('img[alt="聊天插图"]')));
 const replaced=await tool.execute({operation:'structure',workId:'w',expectedRevision:(await session(app)).revision,operations:[
  {target:imageTarget,kind:'replaceImage',payload:{src:inspected.chatImages[0].src}},
 ]},exec);
 assert.equal(replaced.committed,true,JSON.stringify(replaced));
});

test('工作区外的本地图片和普通文件直接插入，file URL 和附件下载可用',async t=>{
 const {app,page,target}=await setup(t);
 const root=await mkdtemp(join(tmpdir(),'ppt-external-materials-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const imagePath=join(root,'本地图片.png'),filePath=join(root,'参考材料.txt');
 await writeFile(imagePath,png);await writeFile(filePath,'本地文件直接内嵌');
 const imageSource=pathToFileURL(imagePath).href;
 const result=await edit(app,target,'insertFragment',{html:`<img alt="本地插图" src="${imageSource}"><a download="参考材料.txt" href="${filePath.replaceAll('\\','/')}">参考材料</a>`});
 assert.equal(result.status,200,JSON.stringify(result));
 await page.waitForFunction(()=>document.querySelector('#deck-frame')?.contentDocument?.querySelector('img[alt="本地插图"]')?.naturalWidth===1);
 assert.equal(await page.locator('#deck-frame').evaluate(async frame=>{
  const link=frame.contentDocument.querySelector('a[download="参考材料.txt"]');
  return (await frame.contentWindow.fetch(link.href)).text();
 }),'本地文件直接内嵌');
 const bundle=await readFile(app.workingDeckPath,'utf8');
 assert.ok(!bundle.includes(imageSource));assert.ok(!bundle.includes(filePath));
});

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

test('文件不存在时明确报告无法读取，不写入历史',async t=>{
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
