(() => {
  const slides = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const fnv1a = text => { let h=2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); };
  const pageKeys = new WeakMap(), locators = new WeakMap(), resolved = new Map();
  let activeActions = [], replayTimer = 0;
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
  const actionKey = action => {
    const kind = action.kind === 'hide' || action.kind === 'show' ? 'visibility' : action.kind;
    return `${locatorKey(action.target)}|${kind}|${action.kind === 'setStyle' ? action.payload.property : ''}`;
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
    const parts=(el.style.translate || '0px 0px').split(/\s+/);
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
        before={ scale:parseFloat(el.style.scale)||1 }; after={ scale:action.payload.scale };
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
  function recordActive(action) {
    const key=actionKey(action), index=activeActions.findIndex(active => actionKey(active) === key);
    if (index < 0) activeActions.push(action); else activeActions[index]=action;
  }
  function applyAction(action) {
    const applied=applyOne(action); recordActive(action); return applied;
  }
  function applyTransaction(actions, { replace=false }={}) {
    if (!Array.isArray(actions) || !actions.length) throw runtimeError('INVALID_ACTION');
    const prepared=[];
    for (const action of actions) {
      try { validatePayload(action); prepared.push({ action, el:resolve(action.target) }); }
      catch (error) { error.failedActionId=action?.id; throw error; }
    }
    const oldActions=[...activeActions];
    const snapshots=new Map(prepared.map(({el}) => [el,{ html:el.innerHTML, style:el.getAttribute('style') }]));
    const results=[];
    try {
      if (replace) activeActions=[];
      for (const {action,el} of prepared) {
        results.push(applyOne(action,el));
        if (!replace) recordActive(action);
      }
      if (replace) activeActions=[...actions];
      return results;
    } catch (error) {
      for (const [el,snapshot] of snapshots) {
        el.innerHTML=snapshot.html;
        if (snapshot.style === null) el.removeAttribute('style'); else el.setAttribute('style',snapshot.style);
      }
      activeActions=oldActions;
      throw error;
    }
  }
  function applyAll(actions) {
    if (!actions.length) { activeActions=[]; return []; }
    return applyTransaction(actions,{replace:true});
  }
  new MutationObserver(() => {
    clearTimeout(replayTimer);
    replayTimer=setTimeout(() => {
      if (!activeActions.length) return;
      try { applyAll(activeActions); } catch { /* 等待 Deck 完成重建后再次重放。 */ }
    },30);
  }).observe(document.documentElement,{childList:true,subtree:true});
  window.HuaweiDeckPatchRuntime={ pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction };
})();
