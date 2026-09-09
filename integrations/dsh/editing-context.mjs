import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 最新连接信息覆盖历史端口与旧的“等待区域任务”提示，不改变用户意图。 */
export function renderEditingContext(context) {
  if (context.status === 'unlinked') return '';
  const identity = `当前会话明确关联的 AICO-PPT 工作项：${JSON.stringify(context.workId)}；源文件：${JSON.stringify(context.deckPath)}。`;
  if (context.status !== 'ready') return `${identity}\n对应 Editor 工作区当前不可用。不要使用历史 capability，不另起 headless workspace，不直改源文件；请提示用户打开此会话关联的右侧 Editor 后重试。`;
  const cli = fileURLToPath(new URL('../../scripts/editor/cli.mjs', import.meta.url));
  return [
    identity,
    `本步有效的工作区凭据文件：${JSON.stringify(context.capabilityPath)}。CLI 路径：${JSON.stringify(cli)}；每次调用传 --capability-file 及该凭据文件路径（按当前 shell 正确引用），不依赖环境变量或历史 token。`,
    `唯一可编辑的托管工作副本：${JSON.stringify(context.workingDeckPath)}。真实源文件只通过 solidify 发布。`,
    '这是当前连接状态，取代历史“等待 Editor 提交带 capability 的任务”的初始化限制。用户自然语言明确要求修改即可通过同一工作区执行，无需口令、区域标注或点击交给 Agent；讨论和分析只读，意图不清时才澄清。连接能力本身不构成修改请求。',
    '已有元素细节用 CLI action；跨页重构、增删排序与复杂 DOM 修改先 begin-source-edit，保存 sourceEditId 与预留 revision，再用 edit-bundle.py 修改上述工作副本，使用 --expected-revision 提交 commit-source-edit；失败用 cancel-source-edit 回滚。显式区域批次仍用 begin-source-task TASK_ID，遵守原批次范围。',
    '右侧 Editor 持有的是本工作区租约，应复用而不是释放。不得要求退出 Editor，不启动第二套编辑器，不调用 shutdown，不绕过工作区直接改源文件。按完整修改批次提交后预览自动更新；源码事务期间人工写入被串行保护。普通编辑优先 aico_ppt 的 inspect/edit/view，提交自带局部诊断与截图，不重复 verify 或完整读 Skill。结构修改后执行完整 verify；按用户保存意图 solidify。',
  ].join('\n');
}

/** 每步重新解析稳定会话标识，兼容旧会话、服务重启与界面切换。 */
export function installEditingContext(ctx, appUrl, { fetchContext = fetch } = {}) {
  const emitted = new WeakMap();
  const endpoint = new URL('/api/dsh-work-items/editing-context', appUrl);
  endpoint.searchParams.set('token', new URL(appUrl).searchParams.get('token'));
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    const response = await fetchContext(endpoint, {
      method:'POST', headers:{ 'content-type':'application/json', origin:endpoint.origin },
      body:JSON.stringify({ sessionId:agent.session.id }),
      signal:AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error(`AICO-PPT 会话工作区解析失败（${response.status}）`);
    const text = renderEditingContext(await response.json());
    if (!text || signal.aborted) {emitted.delete(agent);return decision;}
    // 连接每步检查；同一轮、同一压缩段的稳定说明只进入一次历史。
    // 没有公开日志读取能力的宿主保持原来逐步注入的兼容行为。
    const events=agent.session.snapshotEvents?.();
    if(events) {
      let turn='',compaction='';
      for(let i=events.length-1;i>=0;i--) {
        if(!turn&&events[i].type==='turn/start')turn=String(events[i].seq);
        if(!compaction&&events[i].type==='compaction/end')compaction=String(events[i].seq);
        if(turn&&compaction)break;
      }
      const key=JSON.stringify([text,turn,compaction]);
      if(emitted.get(agent)===key)return decision;
      emitted.set(agent,key);
    }
    // 采用 Host 的标准消息结构，不让独立插件依赖 Host 的内部 npm 包。
    const message = Object.freeze({
      id:randomUUID(), role:'user',
      content:Object.freeze([Object.freeze({ type:'text', text })]),
      source:Object.freeze({ kind:'plugin', plugin:'aico-ppt', form:'snapshot',
        sections:Object.freeze([Object.freeze({ name:'aico-ppt-workspace', text })]) }),
    });
    return { ...decision, messages:[...decision.messages, message] };
  }, { prepend:true });
}
