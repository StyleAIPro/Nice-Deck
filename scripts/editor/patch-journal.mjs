import { randomUUID } from 'node:crypto';
import { compileActionGroups } from './action-compiler.mjs';

function inverse(action) {
  let kind = action.kind;
  let payload;
  if (kind === 'setText') payload = { text:action.before };
  if (kind === 'setStyle') payload = {
    property:action.payload.property,
    value:action.before,
    ...(action.payload.textRange ? { textRange:structuredClone(action.payload.textRange) } : {}),
  };
  if (kind === 'translate' || kind === 'resize') payload = action.before;
  if (kind === 'hide') { kind = 'show'; payload = { display:action.before }; }
  else if (kind === 'show') { kind = 'hide'; payload = {}; }
  return { ...action, id:randomUUID(), kind, payload, before:action.after, after:action.before };
}

export class PatchJournal {
  constructor(state = { groups:[], redo:[] }) { this.state = state; }

  appendGroup(taskId, actions) {
    const group = { id:randomUUID(), taskId, actions, active:true };
    this.state.groups.push(group);
    this.state.redo = [];
    return group;
  }

  compile() {
    return compileActionGroups(this.state.groups);
  }

  undo(id) {
    const group = this.state.groups.find(x => x.id === id && x.active);
    if (!group) throw new Error('找不到可撤销动作组');
    group.active = false;
    this.state.redo.push(id);
    return [...group.actions].reverse().map(inverse);
  }

  redo(id) {
    const group = this.state.groups.find(x => x.id === id && !x.active);
    if (!group || !this.state.redo.includes(id)) throw new Error('找不到可重做动作组');
    group.active = true;
    this.state.redo = this.state.redo.filter(x => x !== id);
    return group.actions;
  }
}
