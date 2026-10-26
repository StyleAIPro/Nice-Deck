/** 校验传入文件的字节与摘要，来源和上传入口不影响插入。 */
import {createHash} from 'node:crypto';
import {imageMime} from './local-image-resources.mjs';
export const CHAT_IMAGE_SOURCE=/^attachment:sha256:[a-f0-9]{64}$/;
export const MAX_CHAT_IMAGE_BYTES=25*1024*1024;
export const MAX_LOCAL_EDIT_BODY_BYTES=Math.ceil(MAX_CHAT_IMAGE_BYTES/3)*4+1024*1024;

export function validateChatImageResources(resources={}) {
  const fail=()=>Object.assign(Error('附件字节、格式、摘要或大小无效，请重新 inspect 后插入'),{
    code:'CHAT_IMAGE_UNAVAILABLE',statusCode:400,committed:false});
  if(!resources||typeof resources!=='object'||Array.isArray(resources)||Object.keys(resources).length>32)throw fail();
  let total=0;
  const images={};
  for(const [source,value] of Object.entries(resources)){
    if(!CHAT_IMAGE_SOURCE.test(source)||!value||typeof value.data!=='string'
      ||value.data.length>Math.ceil(MAX_CHAT_IMAGE_BYTES/3)*4)throw fail();
    const bytes=Buffer.from(value.data,'base64');total+=bytes.length;
    const mime=imageMime(bytes)??'application/octet-stream';
    if(total>MAX_CHAT_IMAGE_BYTES||mime!==value.mime||bytes.toString('base64')!==value.data
      ||source!==`attachment:sha256:${createHash('sha256').update(bytes).digest('hex')}`)throw fail();
    images[source]={mime,data:value.data,compressed:false};
  }
  return images;
}
