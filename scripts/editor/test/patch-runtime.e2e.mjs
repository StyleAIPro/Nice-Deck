import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { PatchJournal } from '../patch-journal.mjs';

test('公开动作登记后定位第二个同名页并在 DOM 重建后幂等重放', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const initial = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    const applied = rt.applyAction({ target, kind:'setText', payload:{ text:'已修改' } });
    const translate = { target, kind:'translate', payload:{ x:10, y:20 } };
    rt.applyAction(translate);
    rt.applyAction(translate);
    rt.applyAction(translate);
    const sameLocator = target === rt.makeLocator(el);
    el.closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    return { pageKey:target.pageKey, text:el.textContent, translate:el.style.translate,
      before:applied.before, sameLocator };
  });
  assert.match(initial.pageKey, /^page-002-/);
  assert.deepEqual({ ...initial, pageKey:undefined }, {
    pageKey:undefined, text:'已修改', translate:'10px 20px', before:'第二页标题', sameLocator:true,
  });
  await page.waitForFunction(() => {
    const el = document.querySelectorAll('h2')[1];
    return el.textContent === '已修改' && el.style.translate === '10px 20px';
  }, undefined, { timeout:1000 });
});

test('新节点指纹不符时 applyAll 抛出 TARGET_AMBIGUOUS', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const error = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    el.closest('section').innerHTML = '<h2>指纹不符</h2>';
    try {
      rt.applyAll([{ target, kind:'setText', payload:{ text:'不应应用' } }]);
      return null;
    } catch (caught) {
      return caught.message;
    }
  });
  assert.equal(error, 'TARGET_AMBIGUOUS');
});

test('hide 和 show 共享 display 状态并以最后一次公开动作为准', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const target = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const locator = rt.makeLocator(el);
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    el.closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    return locator;
  });
  await page.waitForFunction(() => document.querySelectorAll('h2')[1].style.display === 'none',
    undefined, { timeout:1000 });

  await page.evaluate(locator => {
    const rt = window.HuaweiDeckPatchRuntime;
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    rt.applyAction({ target:locator, kind:'hide', payload:{} });
    rt.applyAction({ target:locator, kind:'show', payload:{ display:'' } });
    document.querySelectorAll('h2')[1].closest('section').outerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
  }, target);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('h2').nth(1).evaluate(el => el.style.display), '');
});

test('动作日志可见性编译和撤销重做在 DOM 重建后保持最终状态', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const target = await page.evaluate(() => window.HuaweiDeckPatchRuntime.makeLocator(document.querySelectorAll('h2')[1]));
  const journal = new PatchJournal();
  const group = journal.appendGroup('task-visibility', [
    { id:'v1', taskId:'task-visibility', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t1' },
    { id:'v2', taskId:'task-visibility', target, kind:'show', payload:{display:''}, before:'none', after:'', appliedAt:'t2' },
    { id:'v3', taskId:'task-visibility', target, kind:'hide', payload:{}, before:'', after:'none', appliedAt:'t3' }
  ]);
  const applyAndRebuild = async actions => {
    await page.evaluate(nextActions => {
      window.HuaweiDeckPatchRuntime.applyAll(nextActions);
      document.querySelectorAll('.slide-canvas')[1].innerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
    }, actions);
    await page.waitForTimeout(100);
    return page.locator('h2').nth(1).evaluate(el => el.style.display);
  };

  assert.equal(await applyAndRebuild(journal.compile()), 'none');
  assert.equal(await applyAndRebuild(journal.undo(group.id)), '');
  assert.equal(await applyAndRebuild(journal.redo(group.id)), 'none');
});

test('applyAll 失败后恢复旧 authoritative 集合且不产生异步 pageerror', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const error = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const headings = document.querySelectorAll('h2');
    const goodTarget = rt.makeLocator(headings[1]);
    const ambiguousTarget = rt.makeLocator(headings[0]);
    rt.applyAction({ target:goodTarget, kind:'setText', payload:{ text:'保留动作' } });
    headings[0].closest('section').innerHTML = '<h2>指纹不符</h2>';
    try {
      rt.applyAll([{ target:ambiguousTarget, kind:'setText', payload:{ text:'失败批次' } }]);
      return null;
    } catch (caught) {
      return caught.message;
    }
  });
  assert.equal(error, 'TARGET_AMBIGUOUS');
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    const canvases = document.querySelectorAll('.slide-canvas');
    canvases[0].innerHTML = '<section data-label="目录页"><h2>第一页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 A</div></section>';
    canvases[1].innerHTML = '<section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section>';
  });
  await page.waitForTimeout(100);
  const texts = await page.locator('h2').allTextContents();
  assert.deepEqual(texts, ['第一页标题', '保留动作']);
  assert.deepEqual(pageErrors, []);
});

test('authoritative replace 按 key 恢复基线并隔离 resize 分支', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const rt=window.HuaweiDeckPatchRuntime;
    const heading=document.querySelector('h2');
    const card=document.querySelector('.card');
    const headingTarget=rt.makeLocator(heading);
    const cardTarget=rt.makeLocator(card);
    rt.applyAll([
      { id:'move',target:headingTarget,kind:'translate',payload:{x:40,y:20} },
      { id:'red',target:headingTarget,kind:'setStyle',payload:{property:'color',value:'red'} },
    ]);
    rt.applyAll([
      { id:'blue',target:headingTarget,kind:'setStyle',payload:{property:'color',value:'blue'} },
    ]);
    const oneKey = { translate:heading.style.translate,color:heading.style.color };
    rt.applyAll([]);
    const empty = { translate:heading.style.translate,color:heading.style.color };

    rt.applyAll([{ id:'size',target:cardTarget,kind:'resize',payload:{width:500,height:200} }]);
    rt.applyAll([{ id:'scale',target:cardTarget,kind:'resize',payload:{scale:1.5} }]);
    const scale = { width:card.style.width,height:card.style.height,scale:card.style.scale };
    rt.applyAll([{ id:'size-2',target:cardTarget,kind:'resize',payload:{width:450,height:150} }]);
    const size = { width:card.style.width,height:card.style.height,scale:card.style.scale };
    return { oneKey,empty,scale,size,pending:rt.pendingTransactionCount() };
  });
  assert.deepEqual(result, {
    oneKey:{ translate:'',color:'blue' },
    empty:{ translate:'',color:'' },
    scale:{ width:'300px',height:'100px',scale:'1.5' },
    size:{ width:'450px',height:'150px',scale:'' },
    pending:0,
  });
});

test('定位失败候选最多五个且排除隐藏祖先下的同标签元素', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const canvas = document.querySelector('.slide-canvas');
    const section = canvas.querySelector('section');
    const hiddenParent = document.createElement('div');
    hiddenParent.style.opacity = '0';
    const hidden = document.createElement('h2');
    hidden.textContent = '隐藏候选';
    Object.assign(hidden.style, { position:'absolute', left:'100px', top:'100px', width:'200px', height:'80px' });
    hiddenParent.append(hidden);
    section.append(hiddenParent);
    for (let index=0; index<8; index+=1) {
      const visible = document.createElement('h2');
      visible.textContent = `可见候选 ${index}`;
      Object.assign(visible.style, {
        position:'absolute', left:`${400+index*30}px`, top:'100px', width:'200px', height:'80px',
      });
      section.append(visible);
    }
    const hiddenPath = rt.makeLocator(hidden).path;
    const base = rt.makeLocator(document.querySelector('h2'));
    try {
      rt.applyTransaction([{
        id:'missing', target:{ ...base, path:'999', rect:{ x:100,y:100,w:200,h:80 } },
        kind:'setText', payload:{ text:'不应用' },
      }]);
      return null;
    } catch (error) {
      return { code:error.code, hiddenPath, candidates:error.candidates };
    }
  });
  assert.equal(result.code, 'TARGET_NOT_FOUND');
  assert.ok(result.candidates.length <= 5);
  assert.ok(result.candidates.every(candidate => candidate.tag === 'H2'));
  assert.ok(!result.candidates.some(candidate => candidate.path === result.hiddenPath));
});

test('同一页面二次加载 patch runtime 复用对象身份与已有动作状态', async t => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  await page.evaluate(() => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const heading = document.querySelector('h2');
    const target = runtime.makeLocator(heading);
    runtime.applyAll([{ id:'before-second-load', target, kind:'setText', payload:{ text:'保留状态' } }]);
    window.__runtimeBeforeSecondLoad = runtime;
  });

  await page.addScriptTag({ path:resolve('scripts/editor/runtime/patch-runtime.js') });
  const result = await page.evaluate(() => ({
    same:window.HuaweiDeckPatchRuntime === window.__runtimeBeforeSecondLoad,
    active:window.HuaweiDeckPatchRuntime.activeActionCount(),
    text:document.querySelector('h2').textContent,
  }));
  assert.deepEqual(result, { same:true, active:1, text:'保留状态' });
});
