export const stableTargetKey = action => (
  `${action.target.pageKey}|${action.target.path}|${action.target.tag ?? ''}`
);

export const actionKey = action => {
  const kind = action.kind === 'hide' || action.kind === 'show' ? 'visibility' : action.kind;
  return `${stableTargetKey(action)}|${kind}|${action.payload?.property ?? ''}`;
};

export function compileActionGroups(groups = []) {
  const stableTargets = new Map();
  for (const group of groups) {
    for (const action of group.actions ?? []) {
      const key = stableTargetKey(action);
      if (!stableTargets.has(key)) stableTargets.set(key, action.target);
    }
  }

  const final = new Map();
  for (const group of groups) {
    if (!group.active) continue;
    for (const action of group.actions ?? []) {
      final.set(actionKey(action), {
        ...action,
        target:stableTargets.get(stableTargetKey(action)) ?? action.target,
      });
    }
  }
  return [...final.values()];
}
