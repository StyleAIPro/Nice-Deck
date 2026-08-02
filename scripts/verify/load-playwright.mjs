export async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.js'].filter(Boolean);
  for (const candidate of candidates) {
    try { const mod = await import(candidate); return (mod.default ?? mod).chromium; } catch {}
  }
  throw new Error(`无法加载 playwright-core（已尝试: ${candidates.join(' → ')}）`);
}
