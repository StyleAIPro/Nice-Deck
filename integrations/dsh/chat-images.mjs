/** 会话里的文件和图片统一提供给 Deck，不按上传入口或消息来源划分插入权限。 */
import {CHAT_IMAGE_SOURCE,MAX_CHAT_IMAGE_BYTES,validateChatImageResources} from '../../scripts/editor/chat-image-resources.mjs';
import {imageMime} from '../../scripts/editor/local-image-resources.mjs';

export function chatImageReferences(session,{claimedUsers=[],callId}={}) {
  let events=session.snapshotEvents?.()??[];
  if(callId!==undefined){
    const index=events.findIndex(event=>event.type==='assistant/message'
      &&event.data.message?.content?.some(block=>block.type==='tool-call'&&block.id===callId));
    // 工具执行只看所属调用之前的图片，防止并发的新消息改变本轮素材。
    events=index<0?[]:events.slice(0,index);
  }
  const contents=[...events.flatMap(event=>{
    const data=event.data??{};
    return [data.content,data.message?.content,...(data.inserted??[]).map(message=>message.content)];
  }),...claimedUsers.map(message=>message.content)];
  const refs=new Map();
  for(const content of contents){
    if(!Array.isArray(content))continue;
    for(const block of content){
      const ref=['image','file'].includes(block.type)?block.attachment:null;
      if(!ref||!CHAT_IMAGE_SOURCE.test(`attachment:${ref.attachmentId}`))continue;
      refs.delete(ref.attachmentId);refs.set(ref.attachmentId,ref);
    }
  }
  return refs;
}

export function chatImageCatalog(refs) {
  return [...refs.values()].reverse().filter(ref=>ref.mediaType).slice(0,32).map(ref=>({attachmentId:ref.attachmentId,
    src:`attachment:${ref.attachmentId}`,name:ref.name,mediaType:ref.mediaType,width:ref.width,height:ref.height}));
}

export function chatFileCatalog(refs) {
  return [...refs.values()].reverse().filter(ref=>!ref.mediaType).slice(0,32).map(ref=>({
    attachmentId:ref.attachmentId,src:`attachment:${ref.attachmentId}`,name:ref.name,bytes:ref.bytes}));
}

/** 图片字节通过插件内的鉴权请求传到 Editor，不进入模型参数或返回值。 */
export async function readChatImageResources(operations,refs,attachments,signal) {
  const sources=new Set();
  for(const op of operations){
    const payload=op.payload??{};
    if(op.kind==='replaceImage'){
      const source=payload.attachmentPath??payload.src;
      if(typeof source==='string'&&source.startsWith('attachment:'))sources.add(source);
    }else if(['insertFragment','replaceFragment'].includes(op.kind)&&typeof payload.html==='string'){
      for(const match of payload.html.matchAll(/attachment:sha256:[a-f0-9]{64}/g))sources.add(match[0]);
    }
  }
  const resources={};let total=0;
  for(const source of sources){
    signal?.throwIfAborted();
    const ref=refs.get(source.slice('attachment:'.length));
    if(!ref)throw Object.assign(Error('找不到该附件引用，请 inspect 获取文件或图片的 src，也可直接使用本地路径'),{code:'CHAT_IMAGE_UNAVAILABLE'});
    const isImage=!!ref.mediaType;
    if(typeof attachments?.[isImage?'readImage':'readFileStream']!=='function')throw Object.assign(Error('原装宿主的附件读取服务暂不可用'),{code:'CHAT_IMAGE_UNAVAILABLE'});
    total+=ref.bytes;
    if(!Number.isSafeInteger(ref.bytes)||ref.bytes<0||total>MAX_CHAT_IMAGE_BYTES)
      throw Object.assign(Error('本次插入文件超过 25 MiB，请分批插入'),{code:'CHAT_IMAGE_UNAVAILABLE'});
    let bytes;
    if(isImage){
      bytes=(await attachments.readImage(ref,signal)).data;
    }else{
      const chunks=[];let length=0;
      for await(const chunk of attachments.readFileStream(ref,signal)){
        signal?.throwIfAborted();length+=chunk.byteLength;
        if(length>ref.bytes)throw Object.assign(Error('文件实际大小与附件记录不一致'),{code:'CHAT_IMAGE_UNAVAILABLE'});
        chunks.push(Buffer.from(chunk));
      }
      bytes=Buffer.concat(chunks);
    }
    signal?.throwIfAborted();
    if(!(bytes instanceof Uint8Array)||bytes.byteLength!==ref.bytes)
      throw Object.assign(Error('文件读取结果与附件记录不一致'),{code:'CHAT_IMAGE_UNAVAILABLE'});
    resources[source]={mime:isImage?ref.mediaType:imageMime(Buffer.from(bytes))??'application/octet-stream',data:Buffer.from(bytes).toString('base64')};
  }
  validateChatImageResources(resources);
  return resources;
}
