/** 插件自己承载编辑协议，Host 只提供工具与图片附件能力。 */
import {randomUUID,createHash} from 'node:crypto';
import {readWorkspaceCapability} from '../../scripts/editor/workspace-capability.mjs';

export function installEditingTools(ctx,appUrl,{request=fetch}={}) {
  if(!ctx.tools?.register)return;
  const endpoint=new URL('/api/dsh-work-items/editing-context',appUrl);
  endpoint.searchParams.set('token',new URL(appUrl).searchParams.get('token'));
  ctx.tools.register({
    name:'aico_ppt',
    description:'操作当前会话关联的 PPT。先 inspect 读取 taskId 或 pageKey/query 的目标、父容器和当前截图，再 edit 原样使用目标提交。普通编辑无需读取完整 Skill、源码或协议，不要额外改版式。edit 返回提交结果及同版本截图；已提交但检查未完成时用 view/result，禁止重交。setText payload={text}; setStyle={property,value}; translate={x,y}; resize={width,height} 或 {scale}; hide/show={}; hide 是隐藏、不补位。复杂 DOM/整页修改仍走源码事务。',
    parameters:{type:'object',additionalProperties:false,properties:{
      operation:{type:'string',enum:['inspect','edit','view','result','verify']},
      taskId:{type:'string'},pageKey:{type:'string'},query:{type:'string'},
      expectedRevision:{type:'integer',minimum:0},commandId:{type:'string'},
      actions:{type:'array',items:{type:'object',properties:{
        target:{type:'object'},kind:{type:'string',enum:['setText','setStyle','translate','resize','hide','show']},payload:{type:'object'},
      },required:['target','kind','payload']}}
    },required:['operation']},
    output:{schema:{type:'object'},render:(_args,value)=>{
      const {imageRef,...text}=value;
      return [{type:'text',text:JSON.stringify(text)},...(imageRef?[{type:'image',attachment:imageRef}]:[])];
    }},
    async execute(args,exec) {
      if(!args||!['inspect','edit','view','result','verify'].includes(args.operation))throw new Error('无效的 PPT 操作');
      const linked=await request(endpoint,{method:'POST',headers:{'content-type':'application/json',origin:endpoint.origin},
        body:JSON.stringify({sessionId:exec.agent?.session.id}),signal:exec.signal});
      if(!linked.ok)throw new Error('无法取得当前 PPT 工作区');
      const context=await linked.json();
      if(context.status!=='ready')throw new Error('请先打开此会话关联的 PPT Editor');
      const capability=await readWorkspaceCapability(context.capabilityPath);
      const call=async(path,body)=>{
        const response=await request(new URL(path,capability.url),{method:body?'POST':'GET',
          headers:{authorization:`Bearer ${capability.token}`,'content-type':'application/json'},
          ...(body?{body:JSON.stringify(body)}:{}),signal:exec.signal});
        const value=await response.json();
        if(!response.ok)throw Object.assign(new Error(value.message??value.code),{code:value.code});
        return value;
      };
      const picture=async body=>{
        let result;
        for(let attempt=0;attempt<2;attempt++) {
          try{result=await call('/api/inspect',body);break;}
          catch(error){if(attempt||!['SNAPSHOT_STALE','REVISION_CONFLICT'].includes(error.code))throw error;}
        }
        const {image,...metadata}=result;
        const attachments=ctx.get?.('attachments')??ctx.attachments;
        if(!attachments)return {...metadata,visualStatus:'unavailable',message:'Host 未提供图片附件服务'};
        const imageRef=await attachments.saveImage({data:Buffer.from(image,'base64'),mediaType:'image/png',name:'aico-ppt-page.png'});
        return {...metadata,imageRef,visualStatus:'ready'};
      };
      if(args.operation==='inspect'||args.operation==='view')return picture({taskId:args.taskId,pageKey:args.pageKey,query:args.query});
      if(args.operation==='result') {
        if(!args.commandId)throw new Error('读取结果需要 commandId');
        return call(`/api/commands/${encodeURIComponent(args.commandId)}`);
      }
      if(args.operation==='verify')return call('/api/verify',{});
      if(!Number.isSafeInteger(args.expectedRevision)||!Array.isArray(args.actions)||!args.actions.length)throw new Error('edit 需要 inspect 返回的 expectedRevision 和非空 actions');
      // 将命令号返回给调用方；断线后只按同一号查回执，不自动换版本重放写操作。
      const commandId=args.commandId??randomUUID();
      const taskId=args.taskId??null;
      const actions=args.actions.map((action,index)=>{
        const hex=createHash('sha256').update(`${commandId}:${index}`).digest('hex');
        const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
        return {...action,id,taskId};
      });
      let committed;
      try {committed={...await call('/api/actions',{expectedRevision:args.expectedRevision,taskId,commandId,actions}),committed:true};}
      catch(error) {return {committed:null,commitStatus:'unknown-or-rejected',commandId,error:error.code??'TRANSPORT_ERROR',message:error.message,recovery:'先用 result 查询同一 commandId；不要直接重复提交或改用新版本'};}
      try {
        const view=await picture({pageKey:actions[0].target.pageKey});
        return {...committed,commandId,viewRevision:view.revision,viewStateId:view.stateId,
          ...(view.imageRef?{imageRef:view.imageRef}:{}),visualStatus:view.visualStatus,affectedPages:[...new Set(actions.map(a=>a.target.pageKey))],
          viewPage:view.page,currentViewMatchesCommit:view.revision===committed.revision};
      }catch(error){return {...committed,commandId,visualStatus:'pending',visualError:error.message,recovery:'修改已经提交；使用 view 查看，勿重交 edit'};}
    },
  });
}
