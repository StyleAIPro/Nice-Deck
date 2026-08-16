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
    const group = {
      id:randomUUID(), mutationType:'action', taskId, actions, active:true,
    };
    this.state.groups.push(group);
    this.state.redo = [];
    return group;
  }

  appendSourceGroup(source, taskId = null) {
    if (!source || typeof source !== 'object'
      || !/^[0-9a-f]{64}$/.test(source.beforeFingerprint ?? '')
      || !/^[0-9a-f]{64}$/.test(source.afterFingerprint ?? '')
      || source.beforeFingerprint === source.afterFingerprint) {
      throw new TypeError('source mutation 必须提供不同的前后工作副本指纹');
    }
    if (taskId !== null && (typeof taskId !== 'string' || !taskId)) {
      throw new TypeError('source mutation taskId 必须是非空字符串或 null');
    }
    const group = {
      id:randomUUID(), mutationType:'source', taskId, actions:[],
      source:structuredClone(source), active:true,
    };
    this.state.groups.push(group);
    this.state.redo = [];
    return group;
  }

  appendToLatestGroup(id, actions) {
    const group = this.state.groups.at(-1);
    if (!group || group.mutationType === 'source'
      || group.id !== id || !group.active || this.state.redo.length > 0) return null;
    group.actions.push(...actions);
    return group;
  }

  compile() {
    return compileActionGroups(this.state.groups);
  }

  compileForWrite() {
    const solidifiedActions = Array.isArray(this.state.solidifiedActions)
      ? this.state.solidifiedActions : [];
    return compileActionGroups([
      { id:'solidified-baseline', taskId:null, active:true, actions:solidifiedActions },
      ...(Array.isArray(this.state.groups) ? this.state.groups : []),
    ]);
  }

  solidify() {
    const actions = this.compileForWrite();
    const clearedGroupCount = Array.isArray(this.state.groups) ? this.state.groups.length : 0;
    const clearedRedoCount = Array.isArray(this.state.redo) ? this.state.redo.length : 0;
    this.state.solidifiedActions = structuredClone(actions);
    this.state.groups = [];
    this.state.redo = [];
    return { actions, clearedGroupCount, clearedRedoCount };
  }

  undo(id) {
    const group = this.state.groups.find(x => x.id === id && x.active);
    if (!group) throw new Error('找不到可撤销动作组');
    group.active = false;
    this.state.redo.push(id);
    return group.mutationType === 'source'
      ? [] : [...group.actions].reverse().map(inverse);
  }

  redo(id) {
    const group = this.state.groups.find(x => x.id === id && !x.active);
    if (!group || !this.state.redo.includes(id)) throw new Error('找不到可重做动作组');
    group.active = true;
    this.state.redo = this.state.redo.filter(x => x !== id);
    return group.mutationType === 'source' ? [] : group.actions;
  }
}
