import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolvePptRequest,withPptRequest} from '../request-work-context.mjs';
import {resolveEditingContext} from '../../../scripts/editor/dsh-editing-context.mjs';
import {installEditingContext} from '../editing-context.mjs';
import {installEditingTools} from '../editing-tools.mjs';
import {writeWorkspaceCapability} from '../../../scripts/editor/workspace-capability.mjs';

const reference={schema:1,sessionId:'parent',workId:'work-a',kind:'editing',view:{pageKey:'p2',selection:{editorId:'element'}}};
function fixture(ref=reference){
 const context={sessionId:'child',requestId:'subagent-initial:first',contributions:[{id:'aico-ppt',value:JSON.stringify(ref)}]};
 const origin={sessionId:'parent',requestId:'first-request'},calls=[];
 const service={messageContextFor:async(_session,id)=>{calls.push(id);return context;},messageContextOriginFor:async()=>origin,
  resolveUserContext:async(_session,user,claimed)=>{assert.equal(user.id,'initial');assert.equal(claimed[0],user);return{context,origin};}};
 return{ctx:{get:name=>name==='aicoMessageContexts'?service:undefined},service,context,origin,calls};
}

test('模型首步与工具共用准确来源，隐式页面不随当前视图改变',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ppt-request-work-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:'http://localhost:4200',token:'只用于测试'});
 const f=fixture(),session={id:'child'},requests=[];let hook,tool;
 const current={status:'ready',kind:'editing',workId:'work-a',view:{pageKey:'p9'},capabilityPath,feedbackTasks:[]};
 const request=async(url,options)=>{const body=JSON.parse(options.body??'{}');requests.push({path:new URL(url).pathname,body});return{ok:true,json:async()=>new URL(url).pathname.includes('editing-context')?structuredClone(current):{page:{pageKey:body.pageKey},revision:1}};};
 installEditingContext({...f.ctx,on:(_name,handler)=>{hook=handler;}},'http://localhost:4100/?token=测试',{fetchContext:request});
 const decision=await hook({agent:{session},signal:new AbortController().signal},async()=>({kind:'enter',messages:[{id:'initial',source:{kind:'user'}}]}));
 assert.match(decision.messages.at(-1).content[0].text,/已上报状态/);assert.match(decision.messages.at(-1).content[0].text,/p2/);assert.doesNotMatch(decision.messages.at(-1).content[0].text,/p9/);
 installEditingTools({...f.ctx,tools:{register:value=>{tool=value;}}},'http://localhost:4100/?token=测试',{request});
 const output=await tool.execute({operation:'inspect'},{agent:{session},rootCallId:'outer-ptc',callId:'nested',signal:new AbortController().signal});
 assert.deepEqual(f.calls,['outer-ptc']);assert.equal(output.page.pageKey,'p2');assert.equal(output.workId,'work-a');
 assert.deepEqual(output.delegatedContext,{executionSessionId:'child',sourceSessionId:'parent',sourceRequestId:'first-request'});
 assert.ok(requests.filter(r=>r.path.includes('editing-context')).every(r=>r.body.sessionId==='parent'&&r.body.expectedWorkId==='work-a'));
 current.workId='work-b';await assert.rejects(tool.execute({operation:'tasks'},{agent:{session},callId:'next',signal:new AbortController().signal}),{code:'PPT_REQUEST_WORK_CHANGED'});
});

test('未知来源、另一会话的引用及缺失 PPT 捕获均拒绝委派兜底',async()=>{
 const session={id:'child'};
 for(const change of [f=>{f.context.sessionId='someone';},f=>{f.origin.sessionId='someone';},f=>{f.context.contributions=[];}]){
  const f=fixture();change(f);await assert.rejects(resolvePptRequest(f.ctx,session,{callId:'root'}),/PPT/);
 }
 const f=fixture();f.service.messageContextOriginFor=async()=>undefined;await assert.rejects(resolvePptRequest(f.ctx,session,{callId:'root'}),{code:'PPT_REQUEST_CONTEXT_INVALID'});
 f.service.messageContextFor=async()=>undefined;assert.equal(await resolvePptRequest(f.ctx,session,{callId:'later-uncaptured'}),null);
 assert.equal(await resolvePptRequest({},session,{callId:'no-adapter'}),null);
});

test('工作项在请求后改变时保留后端冲突码，不继续调用编辑器',async()=>{
 const f=fixture();let tool,calls=0;
 installEditingTools({...f.ctx,tools:{register:value=>{tool=value;}}},'http://localhost:4100/?token=测试',{
  request:async()=>{calls++;return{ok:false,status:409,json:async()=>({code:'PPT_REQUEST_WORK_CHANGED',message:'当前工作项已改变'})};},
 });
 await assert.rejects(tool.execute({operation:'tasks'},{agent:{session:{id:'child'}},callId:'root',signal:new AbortController().signal}),{
  code:'PPT_REQUEST_WORK_CHANGED',statusCode:409,message:'当前工作项已改变',
 });
 assert.equal(calls,1);
});

test('请求引用不携带连接凭据或生成 capability；项目变化在访问 Editor 前拒绝',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ppt-public-reference-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let touched=0;
 const input={sessionId:'parent',referenceOnly:true,workCatalog:{resolveByDshSession:async()=>({kind:'editing',workId:'work-a',deckId:'deck',deckPath:'/source'})},
  findEditingRuntime:()=>{touched++;return{app:{sessionDir:root,workingDeckPath:'/working',token:'不可公开',editorToken:'编辑凭据',url:'http://localhost:1234',viewContext:reference.view}};}};
 const result=await resolveEditingContext(input);assert.deepEqual(result,{status:'linked',reference});assert.deepEqual(await readdir(root),[]);assert.ok(!JSON.stringify(result).includes('不可公开'));
 await assert.rejects(resolveEditingContext({...input,referenceOnly:false,expectedWorkId:'work-b'}),{code:'PPT_REQUEST_WORK_CHANGED'});assert.equal(touched,1);
 const request={reference:{...reference,kind:'creation',view:null}};
 assert.equal(withPptRequest({workId:'work-a',kind:'editing'},request).requestView,null,'同一创建工作项生成 Deck 后可继续进入编辑');
 await assert.rejects(async()=>withPptRequest({workId:'work-b',kind:'editing'},request),{code:'PPT_REQUEST_WORK_CHANGED'});
});
