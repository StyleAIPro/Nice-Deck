// 通过真实打包、解包、Python 导入和运行时复用复现缓存摘要变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {acquireManagedRuntime} from '../managed-runtime.mjs';
const run=promisify(execFile);
const pack=fileURLToPath(new URL('../../../scripts/package-windows-plugin.py',import.meta.url));
test('Python 重建有源码的字节码缓存后仍可复用发行运行时，源码损坏仍被拒绝',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ppt-package-cache-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const python=process.env.AICO_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
 await run(python,['-c',`
import pathlib,sys,tarfile,io,py_compile,os,json
r=pathlib.Path(sys.argv[1]); p=r/'resources/python/Lib'; p.mkdir(parents=True)
source=p/'cache_probe.py'; source.write_text('VALUE = 42\\n')
py_compile.compile(str(source),doraise=True)
py_compile.compile(str(source),cfile=str(p/'cache_probe.pyc'),doraise=True)
os.utime(source,(1,1))
(r/'resources/python/python.exe').write_bytes(b'python')
b=r/'resources/browser'; b.mkdir(); (b/'chrome.exe').write_bytes(b'browser')
# 无源码字节码属于必要代码，不能被当作可再生缓存丢弃。
(p/'only_bytecode.pyc').write_bytes(b'bytecode-only')
(p/'__pycache__/orphan.cpython-313.pyc').write_bytes(b'orphan-bytecode')
(b/'browser.py').write_bytes(b'browser-source')
(b/'browser.pyc').write_bytes(b'browser-bytecode')
with tarfile.open(r/'base.tgz','w:gz') as out:
 data=json.dumps({'name':'aico-ppt-skill','version':'0.0.0'}).encode()
 entry=tarfile.TarInfo('package/package.json'); entry.size=len(data); out.addfile(entry,io.BytesIO(data))
 data=b'export const runtimeVersion = \"0.0.0\";\\n'
 entry=tarfile.TarInfo('package/scripts/editor/runtime-version.mjs'); entry.size=len(data); out.addfile(entry,io.BytesIO(data))
`,root]);
 await run(python,[pack,'--plugin-tgz',join(root,'base.tgz'),'--runtime-root',join(root,'resources'),'--output',join(root,'full.tgz')]);
 await mkdir(join(root,'unpacked'));
 await run('tar',['-xzf',join(root,'full.tgz'),'-C',join(root,'unpacked')]);
 const source=join(root,'unpacked/package/runtime'),store=join(root,'store');
 const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
 manifest.target=process.platform+'-'+process.arch;
 await writeFile(join(source,'manifest.json'),JSON.stringify(manifest));
 const first=await acquireManagedRuntime(source,store);
 await run(python,['-c','import sys; sys.dont_write_bytecode=False; sys.path.insert(0,sys.argv[1]); import cache_probe; assert cache_probe.VALUE == 42',join(first.root,'python/Lib')]);
 await first.release();
 const second=await acquireManagedRuntime(source,store);
 assert.equal(second.root,first.root);
 assert.ok(!manifest.files.some(f=>/cache_probe.*\.pyc$/.test(f.path)));
 assert.ok(manifest.files.some(f=>f.path.endsWith('only_bytecode.pyc')));
 assert.ok(manifest.files.some(f=>f.path.endsWith('__pycache__/orphan.cpython-313.pyc')));
 assert.ok(manifest.files.some(f=>f.path==='browser/browser.pyc'));
 await second.release();
 await writeFile(join(first.root,'python/Lib/cache_probe.py'),'VALUE = 99\n');
 await assert.rejects(acquireManagedRuntime(source,store),/Runtime file digest changed/);
});
