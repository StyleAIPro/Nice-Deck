/** 桌面版显式指定内置 Chromium；独立 Skill 保留本机 Chrome 默认值。 */
export function chromiumLaunchOptions(environment = process.env) {
  const executablePath = environment.AICO_BROWSER_EXECUTABLE;
  if (executablePath === undefined) return { channel:'chrome', headless:true };
  if (!executablePath.trim()) throw new Error('AICO 内置浏览器路径不能为空');
  return { executablePath, headless:true };
}

export async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.js'].filter(Boolean);
  for (const candidate of candidates) {
    try { const mod = await import(candidate); return (mod.default ?? mod).chromium; } catch {}
  }
  throw new Error(`无法加载 playwright-core（已尝试: ${candidates.join(' → ')}）`);
}
