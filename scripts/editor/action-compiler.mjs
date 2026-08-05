export const stableTargetKey = action => (
  `${action.target.pageKey}|${action.target.path}|${action.target.tag ?? ''}`
  + `|${action.target.textPath ?? ''}`
);

const stableElementKey = action => (
  `${action.target.pageKey}|${action.target.path}|${action.target.tag ?? ''}`
);

const pathParent = path => {
  const parts = String(path ?? '').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
};

function normalizeGeneratedRangeTargets(groups) {
  const lineage = new Map();
  return groups.map(group => ({
    ...group,
    actions:(group.actions ?? []).map(action => {
      const range = action.kind === 'setStyle' ? action.payload?.textRange : null;
      if (!range) return action;
      let normalized = action;
      const parentPath = action.target?.tag === 'SPAN' ? pathParent(action.target.path) : null;
      const candidates = parentPath
        ? lineage.get(`${action.target.pageKey}|${parentPath}`) ?? [] : [];
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        const candidateRange = candidate.payload.textRange;
        const candidateLength = candidateRange.end - candidateRange.start;
        if (range.start < 0 || range.end > candidateLength) continue;
        normalized = {
          ...action,
          target:candidate.target,
          payload:{
            ...action.payload,
            textRange:{
              start:candidateRange.start + range.start,
              end:candidateRange.start + range.end,
            },
          },
        };
        break;
      }
      const lineageKey = `${action.target.pageKey}|${action.target.path}`;
      const previous = lineage.get(lineageKey) ?? [];
      previous.push(normalized);
      lineage.set(lineageKey, previous);
      return normalized;
    }),
  }));
}

export const actionKey = action => {
  const kind = action.kind === 'hide' || action.kind === 'show' ? 'visibility' : action.kind;
  const textRange = action.kind === 'setStyle' ? action.payload?.textRange : null;
  const rangeKey = textRange ? `${textRange.start}:${textRange.end}` : '';
  return `${stableTargetKey(action)}|${kind}|${action.payload?.property ?? ''}|${rangeKey}`;
};

export function compileActionGroups(groups = []) {
  const normalizedGroups = normalizeGeneratedRangeTargets(groups);
  const stableTargets = new Map();
  for (const group of normalizedGroups) {
    for (const action of group.actions ?? []) {
      const key = stableElementKey(action);
      if (!stableTargets.has(key)) {
        const { textPath: _textPath, ...elementTarget } = action.target;
        stableTargets.set(key, elementTarget);
      }
    }
  }

  const final = new Map();
  for (const group of normalizedGroups) {
    if (!group.active) continue;
    for (const action of group.actions ?? []) {
      final.set(actionKey(action), {
        ...action,
        target:{
          ...(stableTargets.get(stableElementKey(action)) ?? action.target),
          ...(action.target.textPath === undefined ? {} : { textPath:action.target.textPath }),
        },
      });
    }
  }
  return [...final.values()];
}
