/** 所有只读检查使用同一物化候选；不写工作副本、不移动历史游标。 */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {materializePatchBytes,verifyWorkingPatchReplay} from './working-deck-store.mjs';

export async function withEffectiveDeck({bytes,actions,pythonExecutable},use) {
  const htmlBytes=await materializePatchBytes(bytes,actions,{pythonExecutable});
  const directory=await mkdtemp(join(tmpdir(),'aico-ppt-effective-'));
  const path=join(directory,'deck.html');
  try {
    await writeFile(path,htmlBytes,{mode:0o600});
    return await use({path,bytes:htmlBytes,stateId:createHash('sha256').update(htmlBytes).digest('hex')});
  } finally {await rm(directory,{recursive:true,force:true});}
}

export function verifyEffectiveDeck(input,{verify=verifyWorkingPatchReplay,droppableActionIds=[]}={}) {
  return withEffectiveDeck(input,async candidate=>({
    ...await verify(candidate.path,{droppableActionIds}),stateId:candidate.stateId,
  }));
}
