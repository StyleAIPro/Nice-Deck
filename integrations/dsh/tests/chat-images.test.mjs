import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chatImageReferences,chatImageCatalog,chatFileCatalog,readChatImageResources} from '../chat-images.mjs';
import {installEditingContext} from '../editing-context.mjs';
import {validateChatImageResources,MAX_CHAT_IMAGE_BYTES} from '../../../scripts/editor/chat-image-resources.mjs';

const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64');
const ref={attachmentId:`sha256:${createHash('sha256').update(data).digest('hex')}`,mediaType:'image/png',bytes:data.length,width:1,height:1,name:'聊天图片.png'};
const user=(attachment=ref)=>({source:{kind:'user'},content:[{type:'image',attachment}]});

test('图片不按消息来源划分插入权限，当前调用之后的新消息留给下一轮',()=>{
 const later={...ref,attachmentId:`sha256:${'b'.repeat(64)}`};
 const future={...ref,attachmentId:`sha256:${'c'.repeat(64)}`};
 const session={snapshotEvents:()=>[
  {type:'user/message',data:user()},
  {type:'compaction/end'},
  {type:'user/message',data:{...user(later),source:{kind:'plugin:aico-ppt'}}},
  {type:'tool/result',data:{message:{content:[{type:'image',attachment:later}]}}},
  {type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'本轮调用'}]}}},
  {type:'user/message',data:user(future)},
 ]};
 const refs=chatImageReferences(session,{callId:'本轮调用'});
 assert.deepEqual([...refs.values()],[ref,later]);
 assert.equal(chatImageCatalog(refs)[0].src,`attachment:${later.attachmentId}`);
 assert.equal(chatImageReferences(session,{callId:'未知调用'}).size,0);
 assert.equal(chatImageReferences({},{claimedUsers:[user()]}).size,1,'首步尚未写日志的用户消息也可登记');
});

test('聊天普通文件和按文件上传的图片均可直接插入，不要求转换上传入口',async()=>{
 const text=Buffer.from('直接插入的材料');
 const file={attachmentId:`sha256:${createHash('sha256').update(text).digest('hex')}`,bytes:text.length,name:'材料.txt'};
 const imageFile={attachmentId:ref.attachmentId,bytes:data.length,name:'图片.png'};
 const refs=chatImageReferences({},{claimedUsers:[{content:[{type:'file',attachment:file},{type:'file',attachment:imageFile}]}]});
 assert.equal(chatFileCatalog(refs).length,2);
 const sources=[file,imageFile].map(value=>`attachment:${value.attachmentId}`);
 const resources=await readChatImageResources([{kind:'insertFragment',payload:{html:`<a download="材料.txt" href="${sources[0]}">材料</a><img src="${sources[1]}">`}}],refs,{
  async *readFileStream(ref){yield ref===file?text:data;},
 });
 assert.equal(resources[sources[0]].mime,'application/octet-stream');
 assert.equal(resources[sources[1]].mime,'image/png');
 assert.equal(Buffer.from(resources[sources[0]].data,'base64').toString(),'直接插入的材料');
});

test('首步直接告知聊天图片可插入，后续无图补充仍能使用原图且不注入字节',async()=>{
 let hook;
 installEditingContext({on:(_name,fn)=>{hook=fn;}},'http://localhost:1234/?token=fixture',{
  fetchContext:async()=>({ok:true,json:async()=>({status:'ready',workId:'w'})}),
 });
 const session={id:'s',snapshotEvents:()=>[]},signal=new AbortController().signal;
 const first=await hook({agent:{session},signal},async()=>({messages:[user()]}));
 const text=first.messages.at(-1).content[0].text;
 assert.ok(text.includes(`attachment:${ref.attachmentId}`));assert.match(text,/无需用户在 Editor 重复上传/);
 assert.ok(!text.includes(data.toString('base64')));
 session.snapshotEvents=()=>[{type:'user/message',data:user()}];
 const later=await hook({agent:{session},signal},async()=>({messages:[{source:{kind:'user'},content:[{type:'text',text:'右图再收窄一点'}]}]}));
 assert.ok(later.messages.at(-1).content[0].text.includes(ref.attachmentId));
});

test('未知聊天附件及过大图片在调用宿主读取前拒绝，取消不读取图片',async()=>{
 let reads=0;
 const attachments={readImage:async()=>{reads++;return {data};}};
 const op={kind:'replaceImage',payload:{src:`attachment:${ref.attachmentId}`}};
 await assert.rejects(readChatImageResources([op],new Map(),attachments),{code:'CHAT_IMAGE_UNAVAILABLE'});
 await assert.rejects(readChatImageResources([op],new Map([[ref.attachmentId,{...ref,bytes:MAX_CHAT_IMAGE_BYTES+1}]]),attachments),{code:'CHAT_IMAGE_UNAVAILABLE'});
 const controller=new AbortController();controller.abort();
 await assert.rejects(readChatImageResources([op],new Map([[ref.attachmentId,ref]]),attachments,controller.signal),{name:'AbortError'});
 assert.equal(reads,0);
});

test('Editor 校验传入图片的实际格式、规范编码与内容摘要，不能替换成路径或其他内容',()=>{
 const source=`attachment:${ref.attachmentId}`;
 const resource={mime:'image/png',data:data.toString('base64')};
 assert.equal(validateChatImageResources({[source]:resource})[source].compressed,false);
 for(const invalid of [
  {'C:/private.png':resource},
  {[source]:{...resource,mime:'image/jpeg'}},
  {[`attachment:sha256:${'b'.repeat(64)}`]:resource},
  {[source]:{...resource,data:resource.data+'\n'}},
  [],
 ])assert.throws(()=>validateChatImageResources(invalid),{code:'CHAT_IMAGE_UNAVAILABLE',committed:false});
});
