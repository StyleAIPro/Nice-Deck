/** 只从当前 Deck 已登记附件读取图片；模型提供的路径不直接进入文件系统 API。 */
import {normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveAttachmentPath} from './attachment-paths.mjs';

export const LOCAL_IMAGE_RECOVERY='本次明确未提交，无需 result 查询。使用当前 Deck 任务附件返回的 path：replaceImage 传 attachmentPath，插入片段的 img.src 可填写该路径，工具会将图片内嵌。其他本地文件先作为附件上传；不要用 Windows 路径或 file URL 当作浏览器外链。修复后读取最新 revision 再提交，并继续无依赖的剩余任务。';
function key(value){
 if(typeof value!=='string'||!value||value.includes('\0'))return null;
 try{if(/^file:/i.test(value))value=fileURLToPath(value);}catch{return null;}
 value=value.replaceAll('\\','/');
 if(process.platform==='win32')value=value.replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\/(?=[a-z]:\/)/i,'');
 const path=normalize(value);
 return process.platform==='win32'?path.toLowerCase():path;
}
function imageMime(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
 return null;
}
export async function resolveLocalImages(sources,{tasks,sessionDir,realSessionDir=sessionDir,io}){
 const registered=new Map();
 for(const task of tasks)for(const attachment of task.attachments??[]){
  const value={taskId:task.id,file:{id:attachment.id,relativePath:attachment.relativePath,size:attachment.size}};
  registered.set(key(resolveAttachmentPath(sessionDir,attachment.relativePath)),value);
  // Windows TEMP 可能采用 8.3 短路径；API 返回的是同一已绑定目录的真实长路径。
  registered.set(key(resolveAttachmentPath(realSessionDir,attachment.relativePath)),value);
  registered.set(key(attachment.relativePath),value);
 }
 const images={};let total=0;
 for(const source of sources){
  const fail=message=>Object.assign(new Error(message),{code:'LOCAL_IMAGE_UNAVAILABLE',statusCode:409,recovery:LOCAL_IMAGE_RECOVERY});
  const record=registered.get(key(source));
  if(!record)throw fail('图片路径不是当前 Deck 已登记的任务附件，请先上传图片附件');
  total+=record.file.size;
  if(total>25*1024*1024)throw fail('本次内嵌图片超过 25 MiB，请分批修改');
  let result;
  try{result=await io.readAttachment(record);}catch{throw fail('图片附件无法安全读取或文件已变化，请重新上传');}
  const bytes=Buffer.from(result.bytes,'base64');const mime=imageMime(bytes);
  if(bytes.length!==record.file.size||!mime)throw fail('附件不是受支持的 PNG、JPEG、GIF 或 WebP 图片');
  images[source]={mime,data:result.bytes,compressed:false};
 }
 return images;
}
