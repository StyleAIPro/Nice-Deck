import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installEditingTools} from '../editing-tools.mjs';
import {writeWorkspaceCapability} from '../../../scripts/editor/workspace-capability.mjs';

test('编辑工具合并检查和图片、稳定命令重试，截图失败不冒充提交失败',async t=>{
 const root=await mkdtemp(join(tmpdir(),'aico-tool-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://127.0.0.1:1234',token:'private'});
 let tool,badPicture=false;const edits=[];
 installEditingTools({tools:{register(t){tool=t;}},attachments:{saveImage:async()=>({id:'image'})}},'http://127.0.0.1:1235/?token=secret',{
  request:async(url,options)=>{
   const path=new URL(url).pathname;
   let value;
   if(path.includes('editing-context'))value={status:'ready',capabilityPath};
   else if(path==='/api/actions'){edits.push(JSON.parse(options.body));value={committed:true,revision:4,diagnosticsPending:false};}
   else if(path==='/api/inspect'){
    if(badPicture)return {ok:false,json:async()=>({code:'VIEW_FAILED',message:'截图失败'})};
    value={image:Buffer.from('png').toString('base64'),revision:4,page:{pageKey:'p'},stateId:'state'};
   }else value={committed:true};
   return {ok:true,json:async()=>value};
  }});
 const exec={agent:{session:{id:'s'}},signal:new AbortController().signal};
 const args={operation:'edit',expectedRevision:3,commandId:'11111111-1111-4111-a111-111111111111',actions:[{target:{pageKey:'p'},kind:'hide',payload:{}}]};
 const result=await tool.execute(args,exec);
 assert.equal(result.committed,true);assert.equal(result.visualStatus,'ready');
 assert.equal(tool.output.render({},result)[1].type,'image');
 badPicture=true;
 const retried=await tool.execute(args,exec);
 assert.deepEqual(edits[0],edits[1]);
 assert.equal(retried.committed,true);assert.equal(retried.visualStatus,'pending');
 assert.equal(edits.length,2,'截图错误不再次执行修改');
});
