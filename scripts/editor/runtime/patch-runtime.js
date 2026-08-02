(() => {
  const slides = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const fnv1a = text => { let h=2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); };
  const pageKeys = new WeakMap(), locators = new WeakMap(), resolved = new Map();
  let activeActions = [], replayTimer = 0;
  const pageKey = canvas => {
    if (pageKeys.has(canvas)) return pageKeys.get(canvas);
    const index = slides().indexOf(canvas) + 1;
    const section = canvas.querySelector('section[data-label]');
    const key = `page-${String(index).padStart(3,'0')}-${fnv1a(`${index}\0${section?.dataset.label ?? ''}\0${section?.outerHTML ?? ''}`)}`;
    pageKeys.set(canvas, key); return key;
  };
  const pathOf = (root, el) => { const path=[]; while (el && el !== root) { const parent=el.parentElement; path.unshift([...parent.children].indexOf(el)); el=parent; } return path.join('/'); };
  const fingerprint = el => fnv1a(`${el.tagName}\0${el.className}\0${(el.textContent ?? '').trim().slice(0,120)}\0${el.getAttribute('style') ?? ''}`);
  const locatorKey = locator => `${locator.pageKey}|${locator.path}|${locator.tag}|${locator.fingerprint}`;
  const actionKey = action => `${locatorKey(action.target)}|${action.kind}|${action.kind === 'setStyle' ? action.payload.property : ''}`;
  function makeLocator(el) {
    if (locators.has(el)) return locators.get(el);
    const canvas = el.closest('.slide-canvas');
    const section = canvas?.querySelector('section[data-label]');
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const locator = { pageKey:pageKey(canvas), path:pathOf(section, el), tag:el.tagName, fingerprint:fingerprint(el), rect:{x:Math.round((r.left-c.left)*1920/c.width),y:Math.round((r.top-c.top)*1080/c.height),w:Math.round(r.width*1920/c.width),h:Math.round(r.height*1080/c.height)} };
    locators.set(el, locator); resolved.set(locatorKey(locator), el); return locator;
  }
  function resolve(locator) {
    const cached = resolved.get(locatorKey(locator));
    if (cached?.isConnected) return cached;
    const canvas = slides().find(c => pageKey(c) === locator.pageKey);
    if (!canvas) throw new Error('PAGE_NOT_FOUND');
    let el = canvas.querySelector('section[data-label]');
    for (const part of locator.path.split('/').filter(Boolean)) el = el?.children[Number(part)];
    if (!el || el.tagName !== locator.tag) throw new Error('TARGET_NOT_FOUND');
    if (fingerprint(el) !== locator.fingerprint) throw new Error('TARGET_AMBIGUOUS');
    resolved.set(locatorKey(locator), el);
    return el;
  }
  function applyOne(action) {
    const el = resolve(action.target); let before, after;
    if (action.kind === 'setText') { before=el.textContent; after=action.payload.text; if (before !== after) el.textContent=after; }
    if (action.kind === 'translate') { const parts=(el.style.translate || '0px 0px').split(/\s+/); before={x:parseFloat(parts[0])||0,y:parseFloat(parts[1])||0}; after=action.payload; el.style.translate=`${after.x}px ${after.y}px`; }
    if (action.kind === 'resize') { before={width:el.style.width,height:el.style.height,scale:el.style.scale}; Object.assign(el.style, action.payload); after=action.payload; }
    if (action.kind === 'setStyle') { before=el.style.getPropertyValue(action.payload.property); after=action.payload.value; el.style.setProperty(action.payload.property, after); }
    if (action.kind === 'hide' || action.kind === 'show') { before=el.style.display; after=action.kind === 'hide'?'none':(action.payload.display ?? ''); el.style.display=after; }
    return { ...action, before, after, appliedAt:new Date().toISOString() };
  }
  function applyAction(action) {
    const applied = applyOne(action);
    const key = actionKey(action);
    const index = activeActions.findIndex(active => actionKey(active) === key);
    if (index < 0) activeActions.push(action); else activeActions[index] = action;
    return applied;
  }
  function applyAll(actions) {
    activeActions = [...actions];
    const applied=[]; for (const action of activeActions) { try { applied.push(applyOne(action)); } catch (error) { if (!['PAGE_NOT_FOUND','TARGET_NOT_FOUND'].includes(error.message)) throw error; } }
    return applied;
  }
  new MutationObserver(() => {
    clearTimeout(replayTimer);
    replayTimer = setTimeout(() => { if (activeActions.length) applyAll(activeActions); }, 30);
  }).observe(document.documentElement, { childList:true, subtree:true });
  window.HuaweiDeckPatchRuntime = { pageKey, makeLocator, resolve, applyAction, applyAll };
})();
