import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

test('升级后加载的代码报告新版，旧服务身份不受磁盘清单影响',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-ppt-version-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'scripts/editor'),{recursive:true});
 const generator=join(root,'scripts/sync-runtime-version.mjs');
 await copyFile(new URL('../../../scripts/sync-runtime-version.mjs',import.meta.url),generator);
 const file=join(root,'scripts/editor/runtime-version.mjs');
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module',version:'0.1.40'}));
 execFileSync(process.execPath,[generator]);
 const old=await import(pathToFileURL(file).href+'?generation=old');assert.equal(old.runtimeVersion,'0.1.40');
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module',version:'0.1.41'}));
 assert.throws(()=>execFileSync(process.execPath,[generator,'--check'],{stdio:'pipe'}));
 execFileSync(process.execPath,[generator]);
 const current=await import(pathToFileURL(file).href+'?generation=new');
 assert.equal(current.runtimeVersion,'0.1.41');assert.equal(old.runtimeVersion,'0.1.40');
 assert.ok(!(await readFile(file,'utf8')).includes('createRequire'));
});
