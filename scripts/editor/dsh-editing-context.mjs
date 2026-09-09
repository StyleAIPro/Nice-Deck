import { writeWorkspaceCapability } from './workspace-capability.mjs';

/** 按持久会话关联解析现有写入方，绝不按当前 UI 或项目路径猜测。 */
export async function resolveEditingContext({ sessionId, workCatalog, findEditingRuntime }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw Object.assign(new Error('缺少有效会话标识'), { statusCode:400 });
  }
  const workItem = await workCatalog.resolveByDshSession(sessionId);
  if (!workItem || workItem.kind !== 'editing') return { status:'unlinked' };
  const identity = { workId:workItem.workId, deckPath:workItem.deckPath };
  const app = findEditingRuntime({ deckId:workItem.deckId, deckPath:workItem.deckPath })?.app;
  if (!app?.sessionDir || !app.workingDeckPath) return { status:'unavailable', ...identity };
  const capabilityPath = await writeWorkspaceCapability(app.sessionDir, {
    url:app.url, token:app.token, mode:'visible',
    deckPath:app.deckPath, workingDeckPath:app.workingDeckPath,
    sessionDir:app.sessionDir, pid:process.pid,
  });
  return { status:'ready', ...identity, capabilityPath, workingDeckPath:app.workingDeckPath };
}
