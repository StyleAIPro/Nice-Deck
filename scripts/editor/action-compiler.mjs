const targetIdentity = target => target.editorId
  ? `id:${target.editorId}` : `path:${target.path}|${target.tag ?? ''}`;

export const stableTargetKey = action => (
  `${action.target.pageKey}|${targetIdentity(action.target)}|${action.target.textPath ?? ''}`
);

const stableElementKey = action => (
  `${action.target.pageKey}|${targetIdentity(action.target)}`
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

const rangeStyleKey = action => (
  `${stableTargetKey(action)}|setStyle|${action.payload.property}`
);

function withTextRange(action, start, end) {
  return {
    ...action,
    payload:{ ...action.payload, textRange:{ start, end } },
  };
}

function textEditPreservesRangeStyle(textAction, styleAction) {
  const sourceRange = textAction.payload?.sourceRange;
  const styleRange = styleAction.payload?.textRange;
  if (!sourceRange || !styleRange) return false;
  if (sourceRange.start >= styleRange.end) return true;
  if (sourceRange.end > styleRange.start) return false;
  return typeof textAction.before === 'string'
    && textAction.before.length === textAction.payload.text.length;
}

function overlayRangeStyle(segments, action) {
  const { start, end } = action.payload.textRange;
  const next = [];
  for (const segment of segments) {
    const range = segment.payload.textRange;
    if (range.end <= start || range.start >= end) {
      next.push(segment);
      continue;
    }
    if (range.start < start) next.push(withTextRange(segment, range.start, start));
    if (range.end > end) next.push(withTextRange(segment, end, range.end));
  }
  next.push(action);
  next.sort((left, right) => (
    left.payload.textRange.start - right.payload.textRange.start
      || left.payload.textRange.end - right.payload.textRange.end
  ));
  const merged = [];
  for (const segment of next) {
    const previous = merged.at(-1);
    if (previous
      && previous.payload.value === segment.payload.value
      && previous.payload.textRange.end === segment.payload.textRange.start) {
      previous.payload.textRange.end = segment.payload.textRange.end;
    } else {
      merged.push(withTextRange(
        segment, segment.payload.textRange.start, segment.payload.textRange.end,
      ));
    }
  }
  return merged;
}

function compactRangeStyles(actions) {
  const buckets = new Map();
  const output = [];
  for (const action of actions) {
    if (action.kind !== 'setStyle' || !action.payload?.textRange) {
      output.push({ action });
      continue;
    }
    const key = rangeStyleKey(action);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { segments:[] };
      buckets.set(key, bucket);
      output.push({ bucket });
    }
    bucket.segments = overlayRangeStyle(bucket.segments, action);
  }
  return output.flatMap(item => item.action ? [item.action] : item.bucket.segments);
}

function sameCanonicalValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameCanonicalValue(left[key], right[key]));
}

function activeSourceSegment(groups) {
  const sourceIndex = groups.findLastIndex(group => (
    group?.active === true && group?.mutationType === 'source'
  ));
  if (sourceIndex < 0) return { sourceIndex:-1, endIndex:groups.length };
  const nextSourceOffset = groups.slice(sourceIndex + 1)
    .findIndex(group => group?.mutationType === 'source');
  return {
    sourceIndex,
    endIndex:nextSourceOffset < 0 ? groups.length : sourceIndex + 1 + nextSourceOffset,
  };
}

function sourceSupersededActionKeys(groups, sourceIndex, endIndex) {
  if (sourceIndex < 0) return new Set();
  const beforeSource = new Map();
  const beforeSourceByElement = new Map();
  for (const group of groups.slice(0, sourceIndex)) {
    if (group?.active !== true) continue;
    for (const action of group.actions ?? []) {
      beforeSource.set(actionKey(action), action);
      const elementKey = stableElementKey(action);
      const elementActions = beforeSourceByElement.get(elementKey) ?? [];
      elementActions.push(action);
      beforeSourceByElement.set(elementKey, elementActions);
    }
  }
  const superseded = new Set();
  for (const group of groups.slice(sourceIndex + 1, endIndex)) {
    for (const action of group.actions ?? []) {
      const previous = beforeSource.get(actionKey(action));
      if (previous && Object.hasOwn(action, 'before') && Object.hasOwn(previous, 'after')
        && !sameCanonicalValue(action.before, previous.after)) {
        superseded.add(actionKey(action));
        if (action.kind === 'setText' && action.target?.textPath === undefined) {
          for (const candidate of beforeSourceByElement.get(stableElementKey(action)) ?? []) {
            if (candidate.kind === 'setText') superseded.add(actionKey(candidate));
          }
        }
      }
    }
  }
  return superseded;
}

export function compileActionGroups(groups = []) {
  const normalizedGroups = normalizeGeneratedRangeTargets(groups);
  const { sourceIndex, endIndex } = activeSourceSegment(normalizedGroups);
  const superseded = sourceSupersededActionKeys(
    normalizedGroups, sourceIndex, endIndex,
  );
  const stableTargets = new Map();
  const postSourceTargets = new Set();
  for (const [groupIndex, group] of normalizedGroups.entries()) {
    if (groupIndex >= endIndex) break;
    for (const action of group.actions ?? []) {
      const key = stableElementKey(action);
      const firstAfterSource = sourceIndex >= 0 && groupIndex > sourceIndex
        && !postSourceTargets.has(key);
      if (!stableTargets.has(key) || firstAfterSource) {
        const { textPath: _textPath, ...elementTarget } = action.target;
        stableTargets.set(key, elementTarget);
        if (firstAfterSource) postSourceTargets.add(key);
      }
    }
  }

  const final = new Map();
  for (const [groupIndex, group] of normalizedGroups.entries()) {
    if (!group.active) continue;
    for (const action of group.actions ?? []) {
      if (groupIndex < sourceIndex && superseded.has(actionKey(action))) continue;
      if (action.kind === 'setText') {
        const elementKey = stableElementKey(action);
        for (const [key, previous] of final) {
          if (previous.kind === 'setStyle'
            && previous.payload?.textRange
            && stableElementKey(previous) === elementKey
            && !textEditPreservesRangeStyle(action, previous)) {
            // 局部格式使用旧文字的字符偏移。后续文字替换后这些偏移不再具有
            // 稳定语义；继续发布会让离线补丁在预解析阶段 TARGET_AMBIGUOUS。
            // 已知修改位于格式段之后，或位于之前但长度不变时，原范围仍安全；
            // 其他情况保持保守淘汰。之后新建的局部格式会重新进入最终动作集。
            final.delete(key);
          }
        }
      }
      const key = actionKey(action);
      const previous = final.get(key);
      final.set(key, {
        ...action,
        // 同一属性的连续动作只发布最终值，但离线固化和
        // replace 撤销必须从这条链的最早基线重放，不能把中间态
        // 误当成 Deck 基线。源码修改判定为 superseded 时，旧动作
        // 已在上方跳过，因此不会把跨源码边界的旧 before 带进来。
        ...(previous && Object.hasOwn(previous, 'before')
          ? { before:structuredClone(previous.before) } : {}),
        target:{
          ...(stableTargets.get(stableElementKey(action)) ?? action.target),
          ...(action.target.textPath === undefined ? {} : { textPath:action.target.textPath }),
        },
      });
    }
  }
  return compactRangeStyles([...final.values()]);
}

export function sourceRebaseActionIds(groups = [], compiled = compileActionGroups(groups)) {
  const { sourceIndex } = activeSourceSegment(groups);
  if (sourceIndex < 0) return [];
  const beforeSource = new Set(groups.slice(0, sourceIndex)
    .filter(group => group?.active === true)
    .flatMap(group => group.actions ?? [])
    .map(action => action?.id)
    .filter(id => typeof id === 'string' && id));
  return compiled.map(action => action.id).filter(id => beforeSource.has(id));
}
