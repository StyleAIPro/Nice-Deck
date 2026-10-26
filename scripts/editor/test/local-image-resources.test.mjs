import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveLocalImages} from '../local-image-resources.mjs';

test('本地文件直接内嵌，不要求位于工作区或先登记为区域附件',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ppt-direct-file-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64');
 const path=join(root,'直接插入.png');await writeFile(path,png);
 const file=join(root,'材料.txt');await writeFile(file,'项目材料');
 const sources=[path,pathToFileURL(path).href,file];
 const result=await resolveLocalImages(sources,{tasks:[],sessionDir:join(root,'无关工作区')});
 assert.equal(result[path].mime,'image/png');assert.equal(result[path].data,png.toString('base64'));
 assert.deepEqual(result[pathToFileURL(path).href],result[path]);
 assert.equal(Buffer.from(result[file].data,'base64').toString(),'项目材料');
 const relative=await resolveLocalImages(['材料.txt'],{sessionDir:join(root,'无关工作区'),baseDir:root});
 assert.deepEqual(relative['材料.txt'],result[file]);
});
