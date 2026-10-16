import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

test('原生删空富文本后再次编辑、撤销重做和固化均保持一致', async t => {
  const app = await startFixtureServer({
    bundle:true,
    fixtureTransform:html => html.replace('卡片 A', '<span>保留</span><b>删除</b><i>后文</i>'),
  });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(8_000);
  const card = page.frameLocator('#deck-frame').locator('.card').first();
  await page.locator('#deck-frame').evaluate(frame => {
    frame.contentDocument.querySelector('#__deck_loading_overlay')?.remove();
  });
  await page.click('[data-mode="edit"]');
  await card.dblclick();
  await card.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element.querySelector('b'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Backspace');
  await card.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '1');
  assert.equal(await card.textContent(), '保留后文');
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await card.dblclick();
    await card.press('Escape');
    await page.waitForTimeout(120);
    assert.doesNotMatch((await page.locator('[data-history-notice]').allTextContents()).join(' '),
      /历史重放冲突|TARGET_AMBIGUOUS|TARGET_NOT_FOUND/);
    assert.equal(await card.textContent(), '保留后文');
  }
  for (const [method, revision, text] of [['undo', 2, '保留删除后文'], ['redo', 3, '保留后文']]) {
    await page.click(`[data-history-${method}]`);
    await page.waitForFunction(rev => document.querySelector('[data-revision]')?.textContent === String(rev), revision);
    assert.equal(await card.textContent(), text);
  }
  await page.click('[data-solidify]');
  await page.click('[data-solidify-confirm]');
  await page.waitForFunction(() => document.querySelector('[data-solidify]')?.dataset.unsolidified === 'false');
  await page.reload();
  await card.waitFor();
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument
    ?.querySelector('.card')?.textContent === '保留后文');
  assert.equal(app.session.historyArchives.at(-1).entries.length, 1);
});

async function fixture(t) {
  const app = await startFixtureServer({
    fixtureTransform:html => html.replace('卡片 B', '<b data-editor-id="element-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">表格原文</b><p>页脚原文</p>'),
  });
  t.after(() => app.close());
  const { browser, page } = await openEditor(app);
  t.after(() => browser.close());
  page.setDefaultTimeout(4_000);
  return { app, page, frame:page.frameLocator('#deck-frame') };
}

test('另一页的父容器文字与子元素历史重放，不得回退当前页手工改字', async t => {
  const { app, page, frame } = await fixture(t);
  for (const index of [0,1]) {
    const action = await frame.locator('.card').nth(1).evaluate((element,index) => {
      const runtime = window.HuaweiDeckPatchRuntime;
      return index===0
        ? { id:'child-text', taskId:null, kind:'setText',
          target:{ ...runtime.makeLocator(element.querySelector('b')), textPath:'0' },
          payload:{ text:'表格新文' } }
        : { id:'parent-text', taskId:null, kind:'setText',
          target:{ ...runtime.makeLocator(element), textPath:'1/0' },
          payload:{ text:'页脚新文' } };
    },index);
    const response = await fetch(`${app.url}/api/actions?token=${app.token}`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:index, taskId:null, actions:[action] }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  // 重新进入 Editor 时，这两条动作按子元素、父容器的顺序恢复。
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('.card b')?.textContent === '表格新文');
  const heading = frame.locator('h2').first();
  await page.click('[data-mode="edit"]');
  await heading.dblclick(); await heading.fill('当前页新标题'); await heading.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
  await page.waitForTimeout(150);
  assert.equal(await heading.textContent(), '当前页新标题');
  assert.equal(await frame.locator('.card b').textContent(), '表格新文');
  assert.equal(await frame.locator('.card p').textContent(), '页脚新文');
  assert.equal(await frame.locator('[data-direct-status][data-state="error"]').count(), 0);
  const groupId = app.session.groups.at(-1).id;
  for (const [method,revision,text] of [['undo',3,'第一页标题'],['redo',4,'当前页新标题']]) {
    const response = await fetch(`${app.url}/api/groups/${groupId}/${method}?token=${app.token}`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision }),
    });
    assert.equal(response.status, 200, await response.text());
    await page.waitForTimeout(150);
    assert.equal(await heading.textContent(), text);
    assert.equal(await frame.locator('.card b').textContent(), '表格新文');
    assert.equal(await frame.locator('.card p').textContent(), '页脚新文');
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#deck-frame')?.contentDocument?.querySelector('h2')?.textContent === '当前页新标题');
});

test('暂停富文本框编辑时，后代文字与父容器动作也暂停重放', async t => {
  const { page, frame } = await fixture(t);
  const result = await frame.locator('.card').nth(1).evaluate(async element => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const target = runtime.makeLocator(element);
    const actions = [
      { id:'rich-child', kind:'setText', target:{ ...runtime.makeLocator(element.querySelector('b')), textPath:'0' }, payload:{ text:'子框新文' } },
      { id:'rich-parent', kind:'setText', target:{ ...target, textPath:'1/0' }, payload:{ text:'页脚新文' } },
    ];
    runtime.applyAll(actions);
    const originalHTML = element.innerHTML;
    const errors = [];
    document.addEventListener('huawei-deck-patch-replay-error', event => errors.push(event.detail));
    const resume = runtime.suspendTarget(target);
    element.innerHTML = '正在输入的新内容';
    await new Promise(resolve => setTimeout(resolve, 100));
    const typing = element.textContent;
    element.innerHTML = originalHTML;
    resume();
    await new Promise(resolve => setTimeout(resolve, 100));
    return { typing, errors, restored:element.textContent, suspended:runtime.suspendedTargetCount() };
  });
  assert.equal(result.typing, '正在输入的新内容');
  assert.deepEqual(result.errors, []);
  assert.equal(result.restored, '子框新文页脚新文');
  assert.equal(result.suspended, 0);
});

test('历史恢复在中途遇到缺失目标时，已经恢复的文字与历史必须原子回滚', async t => {
  const { frame } = await fixture(t);
  const result = await frame.locator('h2').first().evaluate(element => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const other = document.querySelectorAll('h2')[1];
    const target = runtime.makeLocator(element);
    runtime.applyAll([
      { id:'missing-later', kind:'setText', target:runtime.makeLocator(other), payload:{ text:'另一页已修改' } },
      { id:'keep-current', kind:'setText', target, payload:{ text:'当前页已修改' } },
    ]);
    other.remove();
    let code;
    try { runtime.applyAll([]); } catch (error) { code=error.code; }
    const preserved = element.textContent;
    const active = runtime.activeActionCount();
    runtime.applyAction({ id:'next-edit', kind:'setText', target, payload:{ text:'出错后仍可修改' } });
    return { code, preserved, active, next:element.textContent };
  });
  assert.equal(result.code, 'TARGET_NOT_FOUND');
  assert.equal(result.preserved, '当前页已修改');
  assert.equal(result.active, 2);
  assert.equal(result.next, '出错后仍可修改');
});

test('撤销重做的替换事务须重新定位被父容器恢复重建的子元素', async t => {
  const { frame } = await fixture(t);
  const result = await frame.locator('.card').nth(1).evaluate(element => {
    const runtime = window.HuaweiDeckPatchRuntime;
    const child = runtime.applyAction({
      id:'child-replace', kind:'setText',
      target:{ ...runtime.makeLocator(element.querySelector('b')), textPath:'0' },
      payload:{ text:'需要保留的子框' },
    });
    const parent = runtime.applyAction({
      id:'parent-replace', kind:'setText',
      target:{ ...runtime.makeLocator(element), textPath:'1/0' },
      payload:{ text:'已修改页脚' },
    });
    const texts = [];
    for (let index=0; index<2; index+=1) {
      runtime.beginTransaction([child,parent], { replace:true }).commit();
      texts.push(element.textContent);
    }
    return texts;
  });
  assert.deepEqual(result, ['需要保留的子框已修改页脚', '需要保留的子框已修改页脚']);
});
