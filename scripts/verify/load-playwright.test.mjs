import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromiumLaunchOptions } from './load-playwright.mjs';

test('独立 Skill 使用 Chrome；桌面运行时显式选择内置浏览器', () => {
  assert.deepEqual(chromiumLaunchOptions({}), { channel:'chrome', headless:true });
  assert.deepEqual(chromiumLaunchOptions({ AICO_BROWSER_EXECUTABLE:'/AICO App/chrome' }), { executablePath:'/AICO App/chrome', headless:true });
  assert.throws(() => chromiumLaunchOptions({ AICO_BROWSER_EXECUTABLE:' ' }), /浏览器/);
});
