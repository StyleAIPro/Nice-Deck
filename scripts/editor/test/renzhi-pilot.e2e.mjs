import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access, copyFile, mkdir, mkdtemp, readFile, rm, stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { startServer } from '../server.mjs';
import {
  applyPilotActions, createPilotTasks, openEditor,
} from './test-helpers.mjs';

const KEEP_TEMP = process.argv.includes('--keep-temp');
const FIXED_ROOT = '/tmp/huawei-deck-editor-renzhi-pilot';
const PILOT_PAGE_INDEXES = [7, 8, 9, 12, 17];
const EXPECTED_PAGE_COUNT = 21;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function locateSourceDeck() {
  const candidates = [
    resolve('Deck-Projects/renzhi/renzhi-deck.html'),
    resolve('../..', 'Deck-Projects/renzhi/renzhi-deck.html'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 尝试 worktree 对应的主工作区路径。
    }
  }
  throw new Error(`找不到 renzhi 源 Deck：${candidates.join(', ')}`);
}

function sourceNavigation(bundle) {
  const lines = bundle.split('\n');
  const marker = lines.findIndex(line => line.trim() === '<script type="__bundler/template">');
  assert.ok(marker >= 0, '真实 Deck 缺少 bundle template');
  const template = JSON.parse(lines[marker + 1]);
  const navBlock = template.match(/const nav\s*=\s*\[([\s\S]*?)\n\s*\];/);
  assert.ok(navBlock, '真实 Deck 缺少 nav[]');
  const navLabels = [...navBlock[1].matchAll(/\blabel\s*:\s*'([^']+)'/g)].map(match => match[1]);
  const sectionLabels = [...template.matchAll(/<section\b[^>]*\bdata-label="([^"]+)"/g)]
    .map(match => match[1]);
  assert.equal(navLabels.length, EXPECTED_PAGE_COUNT);
  assert.deepEqual(sectionLabels, navLabels, 'slide DOM 与真实 nav[] 顺序必须一致');
  return { template, labels:navLabels };
}

async function requestJson(app, pathname, options = {}) {
  const separator = pathname.includes('?') ? '&' : '?';
  const response = await fetch(`${app.url}${pathname}${separator}token=${encodeURIComponent(app.token)}`, options);
  let body;
  try { body = await response.json(); }
  catch { body = { message:await response.text() }; }
  if (!response.ok) {
    throw new Error(JSON.stringify({
      status:response.status,
      code:body.code ?? null,
      stage:body.stage ?? null,
      recovery:body.recovery ?? null,
      body,
    }));
  }
  return body;
}

async function waitForSession(app, predicate, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await requestJson(app, '/api/session');
    if (predicate(state)) return state;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`${message}：${JSON.stringify(state)}`);
}

async function waitForPages(page) {
  await page.waitForFunction(count => (
    document.querySelectorAll('[data-page-key]').length === count
  ), EXPECTED_PAGE_COUNT, { timeout:20_000 });
}

async function editorPageMetadata(page) {
  const navigation = await page.locator('[data-page-key]').evaluateAll(elements => elements.map(element => ({
    pageKey:element.dataset.pageKey,
    pageIndex:Number(element.dataset.pageIndex),
    pageLabel:element.dataset.pageLabel,
  })));
  const runtime = await page.locator('#deck-frame').evaluate(frame => {
    const canvases = [...frame.contentDocument.querySelectorAll('.stage .slide-canvas')];
    return canvases.map((canvas, index) => ({
      pageKey:frame.contentWindow.HuaweiDeckPatchRuntime.pageKey(canvas),
      pageIndex:index + 1,
      pageLabel:canvas.querySelector('section[data-label]')?.dataset.label,
    }));
  });
  return { navigation, runtime };
}

function assertPageMetadata(metadata, labels) {
  const expected = labels.map((pageLabel, index) => ({
    pageIndex:index + 1,
    pageLabel,
  }));
  assert.deepEqual(
    metadata.navigation.map(({ pageIndex, pageLabel }) => ({ pageIndex, pageLabel })),
    expected,
  );
  assert.deepEqual(
    metadata.runtime.map(({ pageIndex, pageLabel }) => ({ pageIndex, pageLabel })),
    expected,
  );
  assert.deepEqual(
    metadata.navigation.map(item => item.pageKey),
    metadata.runtime.map(item => item.pageKey),
    '左侧导航 pageKey 必须来自真实 iframe runtime',
  );
  assert.equal(new Set(metadata.navigation.map(item => item.pageKey)).size, EXPECTED_PAGE_COUNT);
}

function assertTask(task, expectedPage) {
  assert.equal(task.pageIndex, expectedPage.pageIndex);
  assert.equal(task.pageKey, expectedPage.pageKey);
  assert.equal(task.pageLabel, expectedPage.pageLabel);
  assert.equal(task.instruction, `试点页 ${expectedPage.pageIndex} 修改`);
  assert.ok(task.rect.x >= 0 && task.rect.y >= 0);
  assert.ok(task.rect.w > 0 && task.rect.h > 0);
  assert.ok(task.rect.x + task.rect.w <= 1920);
  assert.ok(task.rect.y + task.rect.h <= 1080);
  assert.ok(Array.isArray(task.candidates) && task.candidates.length > 0);
  assert.ok(task.candidates.length <= 12);
  assert.match(task.snapshotPath, /^snapshots\/[0-9a-f-]+\.png$/);
}

async function assertPng(path) {
  const bytes = await readFile(path);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.length > 8);
}

async function assertPilotEffects(page, evidence) {
  await page.waitForFunction(input => {
    const frame = document.querySelector('#deck-frame');
    const runtime = frame?.contentWindow?.HuaweiDeckPatchRuntime;
    if (!runtime) return false;
    try {
      return runtime.resolve(input.setText.target).textContent === input.setText.after;
    } catch {
      return false;
    }
  }, evidence);
  const actual = await page.locator('#deck-frame').evaluate((frame, input) => {
    const runtime = frame.contentWindow.HuaweiDeckPatchRuntime;
    const resolveTarget = target => runtime.resolve(target);
    const moved = getComputedStyle(resolveTarget(input.translate.target)).translate;
    const resized = resolveTarget(input.resize.target);
    return {
      text:resolveTarget(input.setText.target).textContent,
      translate:moved === 'none' ? '0px 0px' : moved,
      width:Number.parseFloat(getComputedStyle(resized).width),
      height:Number.parseFloat(getComputedStyle(resized).height),
    };
  }, evidence);
  assert.equal(actual.text, evidence.setText.after);
  const [x = 0, y = 0] = actual.translate.split(/\s+/)
    .map(value => Number.parseFloat(value) || 0);
  assert.deepEqual({ x, y }, evidence.translate.after);
  assert.ok(Math.abs(actual.width - evidence.resize.after.width) < 0.51, JSON.stringify(actual));
  assert.ok(Math.abs(actual.height - evidence.resize.after.height) < 0.51, JSON.stringify(actual));
}

function assertBundleIsClean(template) {
  const markupWithoutScripts = template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assert.equal(
    markupWithoutScripts.includes('data-deck-editor-ui'),
    false,
    '最终 bundle 不得固化 editor UI DOM',
  );
  for (const forbidden of [
    'frame-bridge.mjs',
    'task-drawer.mjs',
    '.huawei-deck-editor/',
    '/tmp/huawei-deck-editor-renzhi-pilot',
    '试点页 7 修改',
    '试点页 8 修改',
    '试点页 9 修改',
    '试点页 12 修改',
    '试点页 17 修改',
    'snapshots/',
  ]) {
    assert.equal(template.includes(forbidden), false, `最终 bundle 不得包含 ${forbidden}`);
  }
}

test('renzhi 工作副本完成 21 页、跨页任务、实时动作与写回重开', {
  timeout:180_000,
}, async t => {
  const sourceDeck = await locateSourceDeck();
  const sourceBefore = await sha256File(sourceDeck);
  const sourceBundle = await readFile(sourceDeck, 'utf8');
  const source = sourceNavigation(sourceBundle);
  const root = KEEP_TEMP
    ? FIXED_ROOT
    : await mkdtemp(join(tmpdir(), 'huawei-deck-editor-renzhi-pilot-'));
  if (KEEP_TEMP) {
    await rm(root, { recursive:true, force:true });
    await mkdir(root, { recursive:true });
  }
  const deckPath = join(root, 'renzhi-deck.html');
  await mkdir(dirname(deckPath), { recursive:true });
  await copyFile(sourceDeck, deckPath);
  const copyBefore = await sha256File(deckPath);
  const resources = { app:null, browser:null, reopened:null, reopenedBrowser:null };

  t.after(async () => {
    await resources.reopenedBrowser?.close().catch(() => {});
    await resources.reopened?.close().catch(() => {});
    await resources.browser?.close().catch(() => {});
    await resources.app?.close().catch(() => {});
    assert.equal(await sha256File(sourceDeck), sourceBefore, '真实源 Deck SHA-256 必须保持不变');
    if (!KEEP_TEMP) await rm(root, { recursive:true, force:true });
  });

  resources.app = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    token:'renzhi-pilot', editorToken:'renzhi-pilot-editor',
  });
  const opened = await openEditor(resources.app, { allowPilotDocumentBlobAbort:true });
  resources.browser = opened.browser;
  opened.page.setDefaultTimeout(12_000);
  await waitForPages(opened.page);
  const metadata = await editorPageMetadata(opened.page);
  assertPageMetadata(metadata, source.labels);
  const initial = await waitForSession(
    resources.app,
    state => Object.keys(state.diagnosticsBaseline ?? {}).length === EXPECTED_PAGE_COUNT,
    '等待 21 页诊断基线超时',
  );
  assert.equal(initial.revision, 0);
  assert.equal(initial.tasks.length, 0);
  assert.equal(initial.groups.length, 0);

  const expectedPilotPages = PILOT_PAGE_INDEXES.map(pageIndex => metadata.navigation[pageIndex - 1]);
  const created = await createPilotTasks(resources.app, opened.page, PILOT_PAGE_INDEXES);
  assert.equal(created.length, PILOT_PAGE_INDEXES.length);
  created.forEach((task, index) => assertTask(task, expectedPilotPages[index]));
  for (const task of created) await assertPng(join(resources.app.sessionDir, task.snapshotPath));

  const pilotTask = created.find(task => task.pageIndex === 9);
  assert.ok(pilotTask, '第 9 页必须存在可关联的真实试点任务');
  const actionEvidence = await applyPilotActions(resources.app, opened.page, pilotTask);
  assert.deepEqual(
    actionEvidence.groups.map(group => group.kind),
    ['setText', 'translate', 'resize'],
  );
  assert.equal(new Set(actionEvidence.groups.map(group => group.groupId)).size, 1);
  assert.ok(actionEvidence.groups.every(group => group.action.taskId === pilotTask.id));
  await assertPilotEffects(opened.page, actionEvidence);
  const beforeWrite = await waitForSession(
    resources.app,
    state => state.revision === 8 && state.groups.length === 1 && state.tasks.length === 5,
    '等待跨页任务与 undo/redo 权威状态超时',
  );
  assert.equal(beforeWrite.redo.length, 0);
  assert.ok(beforeWrite.groups.every(group => group.active));
  assert.equal(new Set(beforeWrite.tasks.map(task => task.pageKey)).size, 5);
  const completedTask = beforeWrite.tasks.find(task => task.id === pilotTask.id);
  assert.equal(beforeWrite.groups[0].taskId, pilotTask.id);
  assert.equal(completedTask.status, 'completed');
  assert.equal(completedTask.groupId, beforeWrite.groups[0].id);

  const write = await requestJson(resources.app, '/api/write-deck', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ expectedRevision:beforeWrite.revision }),
  });
  const copyAfter = await sha256File(deckPath);
  assert.notEqual(copyAfter, copyBefore, '正式写回必须改变工作副本');
  assert.equal(write.fingerprint, copyAfter);
  assert.match(write.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(write.revision, beforeWrite.revision);
  assert.match(write.backup, /backups\/renzhi-deck-[0-9a-f]{64}\.html$/);
  assert.equal(await sha256File(sourceDeck), sourceBefore);

  if (KEEP_TEMP) {
    await opened.page.screenshot({ path:join(root, 'editor-pilot.png'), fullPage:false });
  }
  assert.deepEqual(opened.browserProblems, []);
  assert.deepEqual(opened.resourceProblems, []);
  assert.ok(opened.resourceCancellations.length <= 1, JSON.stringify(opened.resourceCancellations));
  for (const cancellation of opened.resourceCancellations) {
    assert.match(cancellation, /^document blob:http:\/\/127\.0\.0\.1:\d+\/.+ net::ERR_ABORTED$/);
  }

  await resources.browser.close();
  resources.browser = null;
  await resources.app.close();
  resources.app = null;

  const finalBundle = await readFile(deckPath, 'utf8');
  const final = sourceNavigation(finalBundle);
  assertBundleIsClean(final.template);

  resources.reopened = await startServer({
    deckPath, host:'127.0.0.1', port:0, openBrowser:false,
    token:'renzhi-reopen', editorToken:'renzhi-reopen-editor',
  });
  const reopened = await openEditor(resources.reopened, { allowPilotDocumentBlobAbort:true });
  resources.reopenedBrowser = reopened.browser;
  reopened.page.setDefaultTimeout(12_000);
  await waitForPages(reopened.page);
  assertPageMetadata(await editorPageMetadata(reopened.page), source.labels);
  const restored = await waitForSession(
    resources.reopened,
    state => Object.keys(state.diagnosticsBaseline ?? {}).length === EXPECTED_PAGE_COUNT,
    '重开后等待诊断与 session 恢复超时',
  );
  assert.equal(restored.sessionId, beforeWrite.sessionId);
  assert.equal(restored.revision, beforeWrite.revision);
  assert.equal(restored.deckFingerprint, write.fingerprint);
  assert.equal(restored.tasks.length, 5);
  assert.equal(restored.groups.length, 1);
  assert.ok(restored.groups.every(group => group.active));
  const restoredTask = restored.tasks.find(task => task.id === pilotTask.id);
  assert.equal(restoredTask.status, 'completed');
  assert.equal(restoredTask.groupId, restored.groups[0].id);
  await assertPilotEffects(reopened.page, actionEvidence);
  assert.deepEqual(reopened.browserProblems, []);
  assert.deepEqual(reopened.resourceProblems, []);
  assert.ok(reopened.resourceCancellations.length <= 1, JSON.stringify(reopened.resourceCancellations));
  for (const cancellation of reopened.resourceCancellations) {
    assert.match(cancellation, /^document blob:http:\/\/127\.0\.0\.1:\d+\/.+ net::ERR_ABORTED$/);
  }
  assert.equal(await sha256File(sourceDeck), sourceBefore);
});
