#!/usr/bin/env node
// patches.mjs — 验证单文件 Deck 内嵌 Editor 补丁是否全部成功重放。

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadChromium } from './load-playwright.mjs';

const [deckFile] = process.argv.slice(2);
if (!deckFile) {
  console.error('用法: node scripts/verify/patches.mjs <deck.html>');
  process.exit(2);
}
if (!existsSync(deckFile)) {
  console.error(`找不到 deck 文件: ${deckFile}`);
  process.exit(2);
}

let chromium;
try {
  chromium = await loadChromium();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

let browser;
let exitCode = 0;
try {
  browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({
    viewport:{ width:1920, height:1080 }, deviceScaleFactor:1,
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push({
    name:error.name, message:error.message, code:error.code ?? null,
  }));
  await page.goto(pathToFileURL(deckFile).href, {
    waitUntil:'load', timeout:180_000,
  });
  const initial = await page.evaluate(() => ({
    hasPatches:Boolean(document.getElementById('huawei-deck-editor-patches')),
    hasStatus:Boolean(window.HuaweiDeckEditorPatchStatus),
  }));
  if (initial.hasPatches && !initial.hasStatus) {
    await page.waitForTimeout(1_000);
    const legacy = await page.evaluate(() => !window.HuaweiDeckEditorPatchStatus);
    if (legacy) {
      console.log(JSON.stringify({
        state:'legacy-unobservable', expected:null, applied:null, adopted:null,
        error:{
          code:'PATCH_STATUS_MISSING',
          message:'旧版补丁区块未公开重放状态；请先用当前共享模块重建候选文件',
        },
        pageErrors,
      }, null, 2));
      exitCode = 1;
      process.exitCode = exitCode;
      throw Object.assign(new Error('PATCH_STATUS_MISSING_REPORTED'), { reported:true });
    }
  }
  await page.waitForFunction(() => (
    !document.getElementById('huawei-deck-editor-patches')
    || ['applied', 'failed'].includes(window.HuaweiDeckEditorPatchStatus?.state)
  ), undefined, { timeout:90_000 });
  const result = await page.evaluate(() => {
    const script = document.getElementById('huawei-deck-editor-patches');
    if (!script) return { state:'absent', expected:0, applied:0, adopted:0, error:null };
    return structuredClone(window.HuaweiDeckEditorPatchStatus ?? {
      state:'missing-status', expected:null, applied:null, adopted:null,
      error:{ code:'PATCH_STATUS_MISSING', message:'补丁区块未公开重放状态' },
    });
  });
  const valid = result.state === 'absent' || (
    result.state === 'applied'
    && result.applied === result.expected
    && result.adopted === result.expected
  );
  console.log(JSON.stringify({ ...result, pageErrors }, null, 2));
  if (!valid) exitCode = 1;
} catch (error) {
  if (!error?.reported) {
    console.error(`补丁验证基础设施失败：${error?.message ?? error}`);
    exitCode = 2;
  }
} finally {
  await browser?.close().catch(() => {});
}

process.exit(exitCode);
