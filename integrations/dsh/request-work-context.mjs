/** 只接受 Harness 从当前用户请求或原装工具调用解析出的观察归属。 */
export async function resolvePptRequest(ctx,session,{callId,claimedUsers}={}) {
  const service=ctx.get?.('aicoMessageContexts');
  let context,origin;
  if(callId!==undefined){
    context=await service?.messageContextFor?.(session,callId);
    if(context)origin=await service?.messageContextOriginFor?.(session,callId);
  }else{
    const user=claimedUsers?.at(-1)??session.snapshotEvents?.().findLast(event=>event.type==='user/message'&&event.data.source?.kind==='user')?.data;
    const resolved=await service?.resolveUserContext?.(session,user,claimedUsers);
    context=resolved?.context;origin=resolved?.origin;
  }
  if(!context)return null;
  if(context.sessionId!==session.id)throw Object.assign(Error('PPT 请求上下文不属于当前执行会话'),{code:'PPT_CONTEXT_SESSION_MISMATCH'});
  const contribution=context.contributions?.find(value=>value.id==='aico-ppt');
  const delegated=origin&&origin.sessionId!==session.id;
  if(!contribution){
    if(delegated)throw Object.assign(Error('本次委派缺少 PPT 工作项引用，请从已关联的 PPT 业务入口重新提交新请求'),{code:'PPT_REQUEST_CONTEXT_UNAVAILABLE'});
    return null;
  }
  const reference=JSON.parse(contribution.value);
  if(!origin||reference?.schema!==1||reference.sessionId!==origin.sessionId
    ||typeof reference.workId!=='string'||!reference.workId
    ||!['creation','editing'].includes(reference.kind)
    ||!Object.hasOwn(reference,'view')||(reference.view!==null&&(typeof reference.view!=='object'||Array.isArray(reference.view)))){
    throw Object.assign(Error('PPT 工作项引用与原始请求归属不一致'),{code:'PPT_REQUEST_CONTEXT_INVALID'});
  }
  return {...origin,reference,executionSessionId:session.id,delegated:!!delegated};
}

/** 动态连接信息仍来自正式 Catalog；持久引用只固定项目和已上报页面。 */
export function withPptRequest(context,request) {
  if(!request)return context;
  const sameKind=context.kind===request.reference.kind;
  const createdDeck=request.reference.kind==='creation'&&context.kind==='editing';
  if(context.workId!==request.reference.workId||(!sameKind&&!createdDeck)){
    throw Object.assign(Error('PPT 请求对应的工作项已变化，未读取或修改其他文档'),{code:'PPT_REQUEST_WORK_CHANGED'});
  }
  return {...context,requestView:structuredClone(request.reference.view),requestViewTiming:'reported-request'};
}
