  // Error sink persists across replaceWith since it's on window, not the DOM.
  // 错误栏按具体资源去重，并保留错误所在页，而非当前观看页。
  var __bundleErrors = new Map();
  window.addEventListener('error', function(e) {
    var message = e && e.message || '';
    if (message.indexOf('ResizeObserver loop completed with undelivered notifications') >= 0 ||
        message.indexOf('ResizeObserver loop limit exceeded') >= 0) return;
    function resourceLabel(value) {
      value = String(value || '未指定地址');
      if (/^data:/i.test(value)) return value.split(',')[0] + ',[内嵌数据]';
      try {
        var url = new URL(value, location.href);
        url.search = ''; url.hash = ''; url.username = ''; url.password = '';
        value = url.href;
      } catch (_) {}
      return value.length > 240 ? '…' + value.slice(-240) : value;
    }
    var target = e && e.target;
    if (!message && target && target.tagName) {
      var page = target.closest && target.closest('section[data-label]');
      var index = page ? Array.prototype.indexOf.call(document.querySelectorAll('section[data-label]'), page) + 1 : 0;
      var label = page && page.getAttribute('data-label') || '';
      var where = page ? (index ? '第 ' + index + ' 页 ' : '') + label.slice(0, 80) : '页面公共资源';
      var source = target.currentSrc || target.getAttribute('src') || target.getAttribute('href');
      message = where + '：' + (target.tagName === 'IMG' ? '图片' : target.tagName) + '加载失败';
      var alt = target.getAttribute('alt');
      if (alt) message += '「' + alt.slice(0, 120) + '」';
      message += ' — ' + resourceLabel(source);
    }
    if (!message) message = e.type || '未知错误';
    if (e.filename) message += ' (' + resourceLabel(e.filename) + ':' + e.lineno + ')';
    __bundleErrors.set(message, true);
    if (__bundleErrors.size > 20) __bundleErrors.delete(__bundleErrors.keys().next().value);
    var p = document.body || document.documentElement;
    var d = document.getElementById('__bundler_err') || p.appendChild(document.createElement('div'));
    d.id = '__bundler_err';
    d.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;font:12px/1.4 ui-monospace,monospace;background:#2a1215;color:#ff8a80;padding:10px 14px;border-radius:8px;border:1px solid #5c2b2e;z-index:99999;white-space:pre-wrap;max-height:40vh;overflow:auto';
    d.textContent = Array.from(__bundleErrors.keys()).map(function(text) { return '[bundle] ' + text; }).join('\n');
  }, true);
