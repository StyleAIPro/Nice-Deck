async function ensurePatchRuntime() {
  if (window.HuaweiDeckPatchRuntime) return window.HuaweiDeckPatchRuntime;
  window.__HuaweiDeckPatchRuntimeLoading ??= new Promise((resolvePromise, reject) => {
    const existing = [...document.scripts].find(script => {
      if (!script.src) return false;
      return new URL(script.src, document.baseURI).pathname === '/editor/patch-runtime.js';
    });
    const script = existing ?? Object.assign(document.createElement('script'), {
      src: '/editor/patch-runtime.js',
    });
    const finish = () => {
      if (window.HuaweiDeckPatchRuntime) resolvePromise(window.HuaweiDeckPatchRuntime);
      else reject(new Error('补丁运行时加载失败'));
    };
    if (existing) {
      if (window.HuaweiDeckPatchRuntime) finish();
      else {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', reject, { once: true });
      }
      return;
    }
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', reject, { once: true });
    document.head.append(script);
  });
  return window.__HuaweiDeckPatchRuntimeLoading;
}

function waitForCanvases() {
  const find = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const current = find();
  if (current.length) return Promise.resolve(current);
  return new Promise(resolvePromise => {
    const observer = new MutationObserver(() => {
      const canvases = find();
      if (!canvases.length) return;
      observer.disconnect();
      resolvePromise(canvases);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

const [runtime, canvases] = await Promise.all([ensurePatchRuntime(), waitForCanvases()]);
if (parent !== window) {
  parent.postMessage({
    type: 'deck-ready',
    pages: canvases.map((canvas, index) => ({
      index: index + 1,
      label: canvas.querySelector('section[data-label]')?.dataset.label ?? `第 ${index + 1} 页`,
      pageKey: runtime.pageKey(canvas),
    })),
  }, location.origin);
}
