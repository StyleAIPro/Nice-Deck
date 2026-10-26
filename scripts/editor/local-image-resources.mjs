/** 统一读取本地文件与区域附件并内嵌，不要求另行上传或登记。 */
import {normalize,resolve} from 'node:path';
import {open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolveAttachmentPath} from './attachment-paths.mjs';

export const LOCAL_IMAGE_RECOVERY='本次明确未提交，无需 result 查询。直接使用本地文件路径、file URL 或聊天附件 src；工具会读取并内嵌，不必重新上传。请核对文件是否存在、可读、格式与大小是否可用，修复后 inspect 获取最新 revision 再提交。';
function key(value){
 if(typeof value!=='string'||!value||value.includes('\0'))return null;
 try{if(/^file:/i.test(value))value=fileURLToPath(value);}catch{return null;}
 value=value.replaceAll('\\','/');
 if(process.platform==='win32')value=value.replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\/(?=[a-z]:\/)/i,'');
 const path=normalize(value);
 return process.platform==='win32'?path.toLowerCase():path;
}
export function imageMime(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
 return null;
}
export async function resolveLocalImages(sources,{tasks=[],sessionDir,realSessionDir=sessionDir,baseDir=process.cwd()}){
 const registered=new Map();
 for(const task of tasks)for(const attachment of task.attachments??[]){
  const value=resolveAttachmentPath(realSessionDir,attachment.relativePath);
  registered.set(key(resolveAttachmentPath(sessionDir,attachment.relativePath)),value);
  // Windows TEMP 可能采用 8.3 短路径；API 返回的是同一已绑定目录的真实长路径。
  registered.set(key(resolveAttachmentPath(realSessionDir,attachment.relativePath)),value);
  registered.set(key(attachment.relativePath),value);
 }
 const images={};let total=0;
 for(const source of sources){
  const fail=message=>Object.assign(new Error(message),{code:'LOCAL_IMAGE_UNAVAILABLE',statusCode:409,recovery:LOCAL_IMAGE_RECOVERY});
  const record=registered.get(key(source));
  let path=record??source;
  if(typeof path!=='string'||!path||path.includes('\0'))throw fail('文件路径无效');
  try{if(/^file:/i.test(path))path=fileURLToPath(path);}catch{throw fail('文件 URL 无效');}
  let handle,bytes;
  try{
   handle=await open(resolve(baseDir,path),'r');
   const stat=await handle.stat();
   if(!stat.isFile())throw fail('插入目标不是普通文件');
   if(total+stat.size>25*1024*1024)throw fail('本次内嵌文件超过 25 MiB，请分批修改');
   bytes=await handle.readFile();
  }catch(error){
   if(error.code==='LOCAL_IMAGE_UNAVAILABLE')throw error;
   throw fail(`文件无法读取（${error.code??'读取失败'}）：${source}`);
  }finally{await handle?.close();}
  total+=bytes.length;
  if(total>25*1024*1024)throw fail('本次内嵌文件超过 25 MiB，请分批修改');
  images[source]={mime:imageMime(bytes)??'application/octet-stream',data:bytes.toString('base64'),compressed:false};
 }
 return images;
}
