(() => {
  const slides = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const fnv1a = text => { let h=2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); };
  const pageKeys = new WeakMap(), locators = new WeakMap(), resolved = new Map();
  const suspendedTargets = new Set();
  let activeActions = [], activeBaselines = new Map(), replayTimer = 0, tentativeCount = 0;
  const pageKey = canvas => {
    if (!canvas) throw runtimeError('PAGE_NOT_FOUND');
    if (pageKeys.has(canvas)) return pageKeys.get(canvas);
    const index = slides().indexOf(canvas) + 1;
    const section = canvas.querySelector('section[data-label]');
    const key = `page-${String(index).padStart(3,'0')}-${fnv1a(`${index}\0${section?.dataset.label ?? ''}\0${section?.outerHTML ?? ''}`)}`;
    pageKeys.set(canvas, key); return key;
  };
  const pathOf = (root, el) => {
    const path=[];
    while (el && el !== root) {
      const parent=el.parentElement;
      if (!parent) throw runtimeError('TARGET_NOT_FOUND');
      path.unshift([...parent.children].indexOf(el)); el=parent;
    }
    return path.join('/');
  };
  const fingerprint = el => fnv1a(`${el.tagName}\0${el.className}\0${(el.textContent ?? '').trim().slice(0,120)}\0${el.getAttribute('style') ?? ''}`);
  const locatorKey = locator => `${locator.pageKey}|${locator.path}|${locator.tag}|${locator.fingerprint}`;
  const stableTargetKey = locator => `${locator.pageKey}|${locator.path}|${locator.tag}`;
  const actionKey = action => {
    const kind = action.kind === 'hide' || action.kind === 'show' ? 'visibility' : action.kind;
    return `${stableTargetKey(action.target)}|${kind}|${action.kind === 'setStyle' ? action.payload.property : ''}`;
  };
  function runtimeError(code, candidates = []) {
    return Object.assign(new Error(code), { code, candidates });
  }
  function makeLocator(el) {
    if (locators.has(el)) return locators.get(el);
    const canvas = el?.closest?.('.slide-canvas');
    const section = canvas?.querySelector('section[data-label]');
    if (!canvas || !section || !section.contains(el)) throw runtimeError('TARGET_NOT_FOUND');
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const locator = {
      pageKey:pageKey(canvas), path:pathOf(section, el), tag:el.tagName,
      fingerprint:fingerprint(el),
      rect:{
        x:Math.round((r.left-c.left)*1920/c.width), y:Math.round((r.top-c.top)*1080/c.height),
        w:Math.round(r.width*1920/c.width), h:Math.round(r.height*1080/c.height),
      },
    };
    locators.set(el, locator); resolved.set(locatorKey(locator), el); return locator;
  }
  function candidateLocators(locator, canvas) {
    const canvasRect = canvas.getBoundingClientRect();
    const desired = locator.rect ?? { x:0, y:0, w:0, h:0 };
    const center = { x:desired.x + desired.w/2, y:desired.y + desired.h/2 };
    const selector = /^[A-Za-z][A-Za-z0-9:-]*$/.test(String(locator.tag)) ? String(locator.tag) : '*';
    const visibleThroughAncestors = el => {
      for (let current=el; current && current!==canvas.parentElement; current=current.parentElement) {
        const computed=getComputedStyle(current);
        if (computed.display==='none' || computed.visibility==='hidden'
          || computed.contentVisibility==='hidden' || Number(computed.opacity || 1)<=0) return false;
      }
      return true;
    };
    return [...canvas.querySelectorAll(selector)]
      .filter(el => !el.closest('[data-deck-editor-ui]'))
      .map(el => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && visibleThroughAncestors(el);
        const tooLarge = rect.width * rect.height > canvasRect.width * canvasRect.height * .8;
        const x=(rect.left-canvasRect.left)*1920/canvasRect.width + rect.width*960/canvasRect.width;
        const y=(rect.top-canvasRect.top)*1080/canvasRect.height + rect.height*540/canvasRect.height;
        return { el, visible, tooLarge, distance:(x-center.x)**2 + (y-center.y)**2 };
      })
      .filter(item => item.visible && !item.tooLarge)
      .sort((a,b) => a.distance-b.distance)
      .slice(0,5)
      .map(item => { try { return makeLocator(item.el); } catch { return null; } })
      .filter(Boolean);
  }
  function resolve(locator) {
    const cached = resolved.get(locatorKey(locator));
    if (cached?.isConnected) return cached;
    const canvas = slides().find(c => pageKey(c) === locator.pageKey);
    if (!canvas) throw runtimeError('PAGE_NOT_FOUND');
    let el = canvas.querySelector('section[data-label]');
    for (const part of String(locator.path).split('/').filter(Boolean)) {
      if (!/^\d+$/.test(part)) throw runtimeError('TARGET_NOT_FOUND', candidateLocators(locator, canvas));
      el = el?.children[Number(part)];
    }
    if (!el || el.tagName !== locator.tag) {
      throw runtimeError('TARGET_NOT_FOUND', candidateLocators(locator, canvas));
    }
    if (fingerprint(el) !== locator.fingerprint) {
      throw runtimeError('TARGET_AMBIGUOUS', candidateLocators(locator, canvas));
    }
    resolved.set(locatorKey(locator), el);
    return el;
  }
  const finite = value => Number.isFinite(value);
  function validatePayload(action) {
    const payload = action?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.getPrototypeOf(payload)!==Object.prototype) throw runtimeError('INVALID_ACTION');
    if (action.kind === 'setText' && typeof payload.text !== 'string') throw runtimeError('INVALID_ACTION');
    if (action.kind === 'translate' && (![payload.x,payload.y].every(finite)
      || Object.keys(payload).some(key => !['x','y'].includes(key)))) throw runtimeError('INVALID_ACTION');
    if (action.kind === 'resize') {
      const keys=Object.keys(payload);
      const scale=keys.length===1 && finite(payload.scale) && payload.scale>0;
      const size=keys.length===2 && keys.every(key => ['width','height'].includes(key))
        && finite(payload.width) && payload.width>0 && finite(payload.height) && payload.height>0;
      if (!scale && !size) throw runtimeError('INVALID_ACTION');
    }
    if (action.kind === 'setStyle') {
      const allowed=['color','background-color','font-size','font-weight','opacity'];
      if (!allowed.includes(payload.property) || typeof payload.value !== 'string') throw runtimeError('INVALID_ACTION');
    }
    if (action.kind === 'hide' && Object.keys(payload).length) throw runtimeError('INVALID_ACTION');
    if (action.kind === 'show' && (Object.keys(payload).some(key => key !== 'display')
      || (payload.display !== undefined && typeof payload.display !== 'string'))) throw runtimeError('INVALID_ACTION');
    if (!['setText','setStyle','translate','resize','hide','show'].includes(action.kind)) throw runtimeError('INVALID_ACTION');
  }
  const translateOf = el => {
    const computed=getComputedStyle(el).translate;
    const parts=(computed && computed!=='none' ? computed : '0px 0px').split(/\s+/);
    return { x:parseFloat(parts[0])||0, y:parseFloat(parts[1])||0 };
  };
  function applyOne(action, el=resolve(action.target)) {
    validatePayload(action);
    let before, after;
    if (action.kind === 'setText') {
      before=el.textContent; after=action.payload.text;
      if (before !== after) el.textContent=after;
    }
    if (action.kind === 'translate') {
      before=translateOf(el); after={ x:action.payload.x, y:action.payload.y };
      if (after.x === 0 && after.y === 0) el.style.removeProperty('translate');
      else el.style.translate=`${after.x}px ${after.y}px`;
    }
    if (action.kind === 'resize') {
      if (Object.hasOwn(action.payload,'scale')) {
        before={ scale:parseFloat(getComputedStyle(el).scale)||1 }; after={ scale:action.payload.scale };
        el.style.scale=String(after.scale);
      } else {
        const computed=getComputedStyle(el);
        before={ width:parseFloat(computed.width), height:parseFloat(computed.height) };
        after={ width:action.payload.width, height:action.payload.height };
        el.style.width=`${after.width}px`; el.style.height=`${after.height}px`;
      }
    }
    if (action.kind === 'setStyle') {
      before=el.style.getPropertyValue(action.payload.property); after=action.payload.value;
      el.style.setProperty(action.payload.property, after);
    }
    if (action.kind === 'hide' || action.kind === 'show') {
      before=el.style.display; after=action.kind === 'hide'?'none':(action.payload.display ?? '');
      el.style.display=after;
    }
    return { ...action, before, after, appliedAt:new Date().toISOString() };
  }
  const inlineProperty = (el,property) => ({
    value:el.style.getPropertyValue(property), priority:el.style.getPropertyPriority(property),
  });
  const restoreInlineProperty = (el,property,snapshot) => {
    if (snapshot.value) el.style.setProperty(property,snapshot.value,snapshot.priority);
    else el.style.removeProperty(property);
  };
  function captureBaseline(action,el) {
    if (action.kind==='setText') return { text:el.textContent };
    if (action.kind==='translate') return { translate:inlineProperty(el,'translate') };
    if (action.kind==='resize') return {
      width:inlineProperty(el,'width'), height:inlineProperty(el,'height'), scale:inlineProperty(el,'scale'),
    };
    if (action.kind==='setStyle') {
      return { property:action.payload.property, style:inlineProperty(el,action.payload.property) };
    }
    return { display:inlineProperty(el,'display') };
  }
  function restoreBaseline(action,baseline) {
    const el=baseline.el?.isConnected ? baseline.el : resolve(action.target);
    if (action.kind==='setText') el.textContent=baseline.text;
    else if (action.kind==='translate') restoreInlineProperty(el,'translate',baseline.translate);
    else if (action.kind==='resize') {
      restoreInlineProperty(el,'width',baseline.width);
      restoreInlineProperty(el,'height',baseline.height);
      restoreInlineProperty(el,'scale',baseline.scale);
    } else if (action.kind==='setStyle') restoreInlineProperty(el,baseline.property,baseline.style);
    else restoreInlineProperty(el,'display',baseline.display);
  }
  const resizeBranch = action => action?.kind==='resize'
    ? (Object.hasOwn(action.payload,'scale') ? 'scale' : 'size') : null;
  function recordActive(action,baseline) {
    const key=actionKey(action), index=activeActions.findIndex(active => actionKey(active) === key);
    if (index < 0) {
      activeActions.push(action);
      activeBaselines.set(key,{ ...baseline,el:baseline.el });
    } else activeActions[index]=action;
  }
  function applyAction(action) {
    const el=resolve(action.target), baseline={ ...captureBaseline(action,el),el };
    const applied=applyOne(action,el); recordActive(applied,baseline); return applied;
  }
  const snapshotElement = el => ({ html:el.innerHTML,style:el.getAttribute('style') });
  const restoreElementSnapshot = (el,snapshot) => {
    if (!el.isConnected) return;
    el.innerHTML=snapshot.html;
    if (snapshot.style===null) el.removeAttribute('style'); else el.setAttribute('style',snapshot.style);
  };
  function prepareActions(actions,{allowEmpty=false}={}) {
    if (!Array.isArray(actions) || (!allowEmpty && !actions.length)) throw runtimeError('INVALID_ACTION');
    const prepared=[];
    for (const action of actions) {
      try { validatePayload(action); prepared.push({action,el:resolve(action.target)}); }
      catch (error) { error.failedActionId=action?.id; throw error; }
    }
    return prepared;
  }
  function beginReplaceTransaction(actions) {
    const prepared=prepareActions(actions,{allowEmpty:true});
    const oldActions=[...activeActions], oldBaselines=new Map(activeBaselines);
    const touched=new Set(prepared.map(item => item.el));
    for (const action of oldActions) {
      const baseline=oldBaselines.get(actionKey(action));
      const el=baseline?.el?.isConnected ? baseline.el : resolve(action.target);
      touched.add(el);
    }
    const snapshots=new Map([...touched].map(el => [el,snapshotElement(el)]));
    const results=[], nextBaselines=new Map(), currentByKey=new Map();
    let settled=false;
    tentativeCount+=1;
    try {
      for (const action of [...oldActions].reverse()) {
        const baseline=oldBaselines.get(actionKey(action));
        if (baseline) restoreBaseline(action,baseline);
      }
      for (const {action,el} of prepared) {
        const key=actionKey(action);
        const baseline=nextBaselines.get(key) ?? { ...captureBaseline(action,el),el };
        const current=currentByKey.get(key);
        if (resizeBranch(current) && resizeBranch(current)!==resizeBranch(action)) {
          restoreBaseline(current,baseline);
        }
        const result=applyOne(action,el);
        results.push(result);
        nextBaselines.set(key,baseline);
        currentByKey.set(key,result);
      }
    } catch (error) {
      for (const [el,snapshot] of snapshots) restoreElementSnapshot(el,snapshot);
      activeActions=oldActions;
      activeBaselines=oldBaselines;
      tentativeCount-=1;
      throw error;
    }
    const finish=method => {
      if (settled) return false;
      settled=true;
      tentativeCount-=1;
      clearTimeout(replayTimer);
      if (method==='commit') {
        activeActions=[];
        activeBaselines=new Map();
        for (const [index,result] of results.entries()) {
          recordActive(result,nextBaselines.get(actionKey(actions[index])));
        }
      } else {
        for (const [el,snapshot] of snapshots) restoreElementSnapshot(el,snapshot);
        activeActions=oldActions;
        activeBaselines=oldBaselines;
      }
      return true;
    };
    return {results,commit:() => finish('commit'),rollback:() => finish('rollback')};
  }
  function beginTransaction(actions,{replace=false}={}) {
    if (replace) return beginReplaceTransaction(actions);
    const prepared=prepareActions(actions);
    const oldActions=[...activeActions];
    const oldBaselines=new Map(activeBaselines);
    const snapshots=new Map(prepared.map(({el}) => [el,snapshotElement(el)]));
    const results=[];
    const transactionBaselines=new Map();
    const currentByKey=new Map(activeActions.map(active => [actionKey(active),active]));
    let settled=false;
    tentativeCount+=1;
    try {
      for (const {action,el} of prepared) {
        const key=actionKey(action);
        const existingBaseline=activeBaselines.get(key) ?? transactionBaselines.get(key);
        const baseline=existingBaseline ?? { ...captureBaseline(action,el),el };
        const current=currentByKey.get(key);
        if (resizeBranch(current) && resizeBranch(current)!==resizeBranch(action)) {
          restoreBaseline(current,baseline);
        }
        const result=applyOne(action,el);
        results.push(result);
        transactionBaselines.set(key,baseline);
        currentByKey.set(key,result);
      }
    } catch (error) {
      for (const [el,snapshot] of snapshots) {
        restoreElementSnapshot(el,snapshot);
      }
      activeActions=oldActions;
      activeBaselines=oldBaselines;
      tentativeCount-=1;
      throw error;
    }
    const finish = method => {
      if (settled) return false;
      settled=true;
      tentativeCount-=1;
      clearTimeout(replayTimer);
      if (method==='commit') {
        for (const [index,action] of results.entries()) {
          recordActive(action,transactionBaselines.get(actionKey(actions[index])));
        }
      } else {
        for (const [el,snapshot] of snapshots) {
          restoreElementSnapshot(el,snapshot);
        }
        activeActions=oldActions;
        activeBaselines=oldBaselines;
      }
      return true;
    };
    return {
      results,
      commit:() => finish('commit'),
      rollback:() => finish('rollback'),
    };
  }
  function applyTransaction(actions, options) {
    const transaction=beginTransaction(actions,options);
    transaction.commit();
    return transaction.results;
  }
  function applyAll(actions) {
    if (!Array.isArray(actions)) throw runtimeError('INVALID_ACTION');
    const oldActions=[...activeActions];
    tentativeCount+=1;
    clearTimeout(replayTimer);
    try {
      for (const action of [...activeActions].reverse()) {
        const baseline=activeBaselines.get(actionKey(action));
        if (baseline) restoreBaseline(action,baseline);
      }
      activeActions=[];
      activeBaselines=new Map();
      if (!actions.length) return [];
      return applyTransaction(actions);
    } catch (error) {
      for (const action of [...activeActions].reverse()) {
        const baseline=activeBaselines.get(actionKey(action));
        if (baseline) restoreBaseline(action,baseline);
      }
      activeActions=[];
      activeBaselines=new Map();
      try { if (oldActions.length) applyTransaction(oldActions); } catch { /* 保留原始 sync 错误。 */ }
      throw error;
    } finally {
      tentativeCount-=1;
    }
  }
  function suspendTarget(locator) {
    const key=stableTargetKey(locator);
    suspendedTargets.add(key);
    let resumed=false;
    return () => {
      if (resumed) return;
      resumed=true;
      suspendedTargets.delete(key);
    };
  }
  function replayActive() {
    if (tentativeCount>0) return;
    for (const action of activeActions) {
      if (suspendedTargets.has(stableTargetKey(action.target))) continue;
      try { applyOne(action); } catch { /* Deck 可能仍在重建。 */ }
    }
  }
  new MutationObserver(() => {
    clearTimeout(replayTimer);
    replayTimer=setTimeout(replayActive,30);
  }).observe(document.documentElement,{childList:true,subtree:true});
  window.HuaweiDeckPatchRuntime={
    pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,
    pendingTransactionCount:() => tentativeCount,
    activeActionCount:() => activeActions.length,
    suspendedTargetCount:() => suspendedTargets.size,
  };
})();
