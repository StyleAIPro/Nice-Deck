(() => {
  const contract=Object.freeze({
    brand:'com.huawei.deck.visual-editor.patch-runtime',schema:1,version:'1.0.0',
    api:'pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,pendingTransactionCount,activeActionCount,suspendedTargetCount',
    features:'textPath,textRangeStyle',
  });
  const contractError=code => Object.assign(new Error(code),{code});
  const compatible=runtime => {
    const seen=runtime?.contract;
    return seen?.brand===contract.brand && seen.schema===contract.schema
      && seen.version===contract.version && seen.api===contract.api
      && contract.api.split(',').every(name => typeof runtime[name]==='function');
  };
  // 编辑预览可能先加载受保护 runtime，保存后的 bundle 随后再解包同一份 inline runtime。
  // 二次加载必须复用已登记的 pageKey、locator 与动作状态，不能覆盖全局实例。
  if (window.HuaweiDeckPatchRuntime) {
    if (compatible(window.HuaweiDeckPatchRuntime)) return;
    throw contractError(window.HuaweiDeckPatchRuntime.contract?.brand===contract.brand
      ? 'RUNTIME_INCOMPATIBLE' : 'RUNTIME_GLOBAL_CONFLICT');
  }
  const slides = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const fnv1a = text => { let h=2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); };
  const normalizeTag=tag => {
    let cursor=0,index=1,normalized='';
    while (index<tag.length && !/[\s/>]/.test(tag[index])) index+=1;
    while (index<tag.length) {
      while (/\s/.test(tag[index]??'')) index+=1;
      if (!tag[index] || tag[index]==='>' || tag[index]==='/') break;
      const start=index;
      while (index<tag.length && !/[\s=/>]/.test(tag[index])) index+=1;
      const name=tag.slice(start,index).toLowerCase();
      while (/\s/.test(tag[index]??'')) index+=1;
      if (tag[index]!=='=') continue;
      index+=1; while (/\s/.test(tag[index]??'')) index+=1;
      const quote=tag[index];
      if (quote!=='"' && quote!=="'") {
        const valueStart=index;
        while (index<tag.length && !/[\s>]/.test(tag[index])) index+=1;
        if ((name==='src' || name==='href') && tag.slice(valueStart,index).startsWith('blob:')) {
          normalized+=`${tag.slice(cursor,valueStart)}blob:`; cursor=index;
        }
        continue;
      }
      const valueStart=index+1,valueEnd=tag.indexOf(quote,valueStart);
      if (valueEnd<0) break;
      if ((name==='src' || name==='href') && tag.slice(valueStart,valueEnd).startsWith('blob:')) {
        normalized+=`${tag.slice(cursor,valueStart)}blob:`; cursor=valueEnd;
      }
      index=valueEnd+1;
    }
    return normalized ? normalized+tag.slice(cursor) : tag;
  };
  const pageStructure = html => {
    const source=String(html); let output='',cursor=0,rawTextTag=null;
    while (cursor<source.length) {
      const start=source.indexOf('<',cursor);
      if (start<0) return output+source.slice(cursor);
      output+=source.slice(cursor,start);
      if (rawTextTag) {
        const close=source.toLowerCase().indexOf(`</${rawTextTag}`,start);
        if (close<0) return output+source.slice(start);
        output+=source.slice(start,close); cursor=close; rawTextTag=null; continue;
      }
      if (source.startsWith('<!--',start)) {
        const close=source.indexOf('-->',start+4),next=close<0?source.length:close+3;
        output+=source.slice(start,next); cursor=next; continue;
      }
      let end=start+1,quote='';
      for (;end<source.length;end+=1) {
        const char=source[end];
        if (quote) { if (char===quote) quote=''; }
        else if (char==='"' || char==="'") quote=char;
        else if (char==='>') break;
      }
      if (end>=source.length) return output+source.slice(start);
      const tag=source.slice(start,end+1),match=tag.match(/^<\s*([A-Za-z][\w:-]*)/);
      output+=match?normalizeTag(tag):tag;
      if (match && ['script','style'].includes(match[1].toLowerCase()) && !/\/\s*>$/.test(tag)) rawTextTag=match[1].toLowerCase();
      cursor=end+1;
    }
    return output;
  };
  const pageKeys = new WeakMap(), locators = new WeakMap(), resolved = new Map();
  const suspendedTargets = new Set();
  let activeActions = [], activeBaselines = new Map(), replayTimer = 0, tentativeCount = 0;
  const pageKey = canvas => {
    if (!canvas) throw runtimeError('PAGE_NOT_FOUND');
    if (pageKeys.has(canvas)) return pageKeys.get(canvas);
    const index = slides().indexOf(canvas) + 1;
    const section = canvas.querySelector('section[data-label]');
    const key = `page-${String(index).padStart(3,'0')}-${fnv1a(`${index}\0${section?.dataset.label ?? ''}\0${pageStructure(section?.outerHTML ?? '')}`)}`;
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
  const stableTargetKey = locator => `${locator.pageKey}|${locator.path}|${locator.tag}|${locator.textPath ?? ''}`;
  const actionKey = action => {
    const kind = action.kind === 'hide' || action.kind === 'show' ? 'visibility' : action.kind;
    const textRange=action.kind==='setStyle' ? action.payload.textRange : null;
    const rangeKey=textRange ? `${textRange.start}:${textRange.end}` : '';
    return `${stableTargetKey(action.target)}|${kind}|${action.kind === 'setStyle' ? action.payload.property : ''}|${rangeKey}`;
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
  const validTextPath = value => typeof value === 'string'
    && /^(0|[1-9]\d{0,3})(\/(0|[1-9]\d{0,3})){0,31}$/.test(value);
  const textNodeFor = (action,el) => {
    if (action.target.textPath === undefined) return null;
    let node=el;
    for (const part of action.target.textPath.split('/')) node=node?.childNodes[Number(part)];
    if (!node || node.nodeType!==Node.TEXT_NODE) throw runtimeError('TARGET_NOT_FOUND');
    return node;
  };
  function validatePayload(action) {
    const payload = action?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.getPrototypeOf(payload)!==Object.prototype) throw runtimeError('INVALID_ACTION');
    if (action.target?.textPath !== undefined
      && (action.kind!=='setText' || !validTextPath(action.target.textPath))) {
      throw runtimeError('INVALID_ACTION');
    }
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
      const allowed=[
        'color','background-color','font-size','font-weight','opacity',
        'border-color','border-width','border-style','fill','stroke','stroke-width',
      ];
      const textRange=payload.textRange;
      const rangeAllowed=['color','font-size','font-weight'];
      const validRange=textRange===undefined || (textRange
        && typeof textRange==='object' && !Array.isArray(textRange)
        && Object.getPrototypeOf(textRange)===Object.prototype
        && Object.keys(textRange).length===2
        && Object.keys(textRange).every(key => ['start','end'].includes(key))
        && Number.isSafeInteger(textRange.start) && Number.isSafeInteger(textRange.end)
        && textRange.start>=0 && textRange.end>textRange.start && textRange.end<=1000000);
      const allowedKeys=textRange===undefined ? ['property','value'] : ['property','value','textRange'];
      if (!allowed.includes(payload.property) || typeof payload.value !== 'string'
        || !validRange || (textRange && !rangeAllowed.includes(payload.property))
        || Object.keys(payload).length!==allowedKeys.length
        || Object.keys(payload).some(key => !allowedKeys.includes(key))) throw runtimeError('INVALID_ACTION');
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
  const textNodesOf = el => {
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    const nodes=[];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  };
  const textPointAt = (el,offset,bias) => {
    const nodes=textNodesOf(el);
    let consumed=0;
    for (const node of nodes) {
      const next=consumed+node.data.length;
      if (offset<next || (offset===next && bias==='end')) {
        return {node,offset:offset-consumed};
      }
      consumed=next;
    }
    if (offset===consumed && nodes.length) {
      const node=nodes[nodes.length-1];
      return {node,offset:node.data.length};
    }
    throw runtimeError('TARGET_NOT_FOUND');
  };
  const rangeComputedStyle = (el,textRange,property) => {
    const point=textPointAt(el,textRange.start,'start');
    const owner=point.node.parentElement ?? el;
    return getComputedStyle(owner).getPropertyValue(property).trim();
  };
  const textRangeWrapper = (el,textRange,property) => [...el.querySelectorAll(
    '[data-deck-text-range-style]',
  )].find(wrapper => wrapper.dataset.deckTextRangeProperty===property
    && Number(wrapper.dataset.deckTextRangeStart)===textRange.start
    && Number(wrapper.dataset.deckTextRangeEnd)===textRange.end);
  const applyTextRangeStyle = (el,payload) => {
    const {textRange,property,value}=payload;
    const existing=textRangeWrapper(el,textRange,property);
    const before=existing
      ? getComputedStyle(existing).getPropertyValue(property).trim()
      : rangeComputedStyle(el,textRange,property);
    const after=value;
    if (before===after) return {before,after};
    if (existing) {
      existing.style.setProperty(property,value);
      return {before,after};
    }
    const start=textPointAt(el,textRange.start,'start');
    const end=textPointAt(el,textRange.end,'end');
    const range=document.createRange();
    range.setStart(start.node,start.offset);
    range.setEnd(end.node,end.offset);
    const wrapper=document.createElement('span');
    wrapper.dataset.deckTextRangeStyle='';
    wrapper.dataset.deckTextRangeProperty=property;
    wrapper.dataset.deckTextRangeStart=String(textRange.start);
    wrapper.dataset.deckTextRangeEnd=String(textRange.end);
    wrapper.style.setProperty('display','contents','important');
    wrapper.style.setProperty(property,value);
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    return {before,after};
  };
  function applyOne(action, el=resolve(action.target)) {
    validatePayload(action);
    let before, after;
    if (action.kind === 'setText') {
      const textNode=textNodeFor(action,el);
      before=textNode ? textNode.data : el.textContent; after=action.payload.text;
      if (before !== after) {
        if (textNode) textNode.data=after;
        else el.textContent=after;
      }
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
      if (action.payload.textRange) {
        ({before,after}=applyTextRangeStyle(el,action.payload));
      } else {
        before=el.style.getPropertyValue(action.payload.property); after=action.payload.value;
        el.style.setProperty(action.payload.property, after);
      }
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
    if (action.kind==='setText') {
      const textNode=textNodeFor(action,el);
      return { text:textNode ? textNode.data : el.textContent };
    }
    if (action.kind==='translate') return { translate:inlineProperty(el,'translate') };
    if (action.kind==='resize') return {
      width:inlineProperty(el,'width'), height:inlineProperty(el,'height'), scale:inlineProperty(el,'scale'),
    };
    if (action.kind==='setStyle') {
      if (action.payload.textRange) {
        const wrapper=textRangeWrapper(el,action.payload.textRange,action.payload.property);
        return { rangeStyle:wrapper ? {
          existed:true,
          property:inlineProperty(wrapper,action.payload.property),
        } : { existed:false } };
      }
      return { property:action.payload.property, style:inlineProperty(el,action.payload.property) };
    }
    return { display:inlineProperty(el,'display') };
  }
  function restoreBaseline(action,baseline) {
    const el=baseline.el?.isConnected ? baseline.el : resolve(action.target);
    if (action.kind==='setText') {
      const textNode=textNodeFor(action,el);
      if (textNode) textNode.data=baseline.text;
      else el.textContent=baseline.text;
    }
    else if (action.kind==='translate') restoreInlineProperty(el,'translate',baseline.translate);
    else if (action.kind==='resize') {
      restoreInlineProperty(el,'width',baseline.width);
      restoreInlineProperty(el,'height',baseline.height);
      restoreInlineProperty(el,'scale',baseline.scale);
    } else if (action.kind==='setStyle' && action.payload.textRange) {
      const wrapper=textRangeWrapper(el,action.payload.textRange,action.payload.property);
      if (baseline.rangeStyle?.existed) {
        if (wrapper) restoreInlineProperty(wrapper,action.payload.property,baseline.rangeStyle.property);
      } else if (wrapper) {
        wrapper.replaceWith(...wrapper.childNodes);
        el.normalize();
      }
    }
    else if (action.kind==='setStyle') restoreInlineProperty(el,baseline.property,baseline.style);
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
    const el=resolve(action.target),key=actionKey(action);
    const baseline=activeBaselines.get(key) ?? { ...captureBaseline(action,el),el };
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
    contract,
    pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,
    pendingTransactionCount:() => tentativeCount,
    activeActionCount:() => activeActions.length,
    suspendedTargetCount:() => suspendedTargets.size,
  };
})();
