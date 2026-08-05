#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Huawei Deck 公共运行时迁移。

每项能力提供独立 probe 与幂等迁移；三套模板初始化和 upgrade_deck 共用本模块，
避免同一段脆弱的 HTML/CSS/JS 字符串在多个脚本中重复维护。
"""


def _replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"无法安全迁移 {label}：应匹配 1 处，实际 {count} 处。"
            "该 Deck 的公共运行时可能被自定义过，请人工合并。"
        )
    return text.replace(old, new, 1)


def has_zoom_pan(s):
    markers = (
        'id="panlock"',
        ".pan-hint { position:fixed;",
        "this._setPanLocked = (on) =>",
        "this._panDownH = (e) =>",
        ".panlock-btn[hidden] { display:none !important; }",
        ".zoomreset-btn:focus, .zoomreset-btn:focus-visible { outline:none; }",
        "const panAvailable = (this._userZoom || 1) > 1.001;",
        "if (e.currentTarget && e.currentTarget.blur) e.currentTarget.blur();",
    )
    return all(marker in s for marker in markers)


def migrate_zoom_pan(s):
    """增加放大后空格临时抓手、glass 小手锁定与焦点修复。"""
    if has_zoom_pan(s):
        return s

    s = _replace_once(
        s,
        ".zoomreset-wrap { flex:none; position:relative;",
        ".zoomreset-wrap { flex:none; position:relative; display:flex; align-items:center; gap:2px;",
        "缩放工具容器布局",
    )
    s = _replace_once(
        s,
        '.zoomreset-btn { width:56px; height:38px; border:none;',
        '.zoomreset-btn { width:56px; height:38px; border:none; outline:none;',
        "四角复位按钮焦点样式",
    )
    s = _replace_once(
        s,
        "  .zoomreset-btn:hover { background:transparent; }",
        "  .zoomreset-btn:focus, .zoomreset-btn:focus-visible { outline:none; }\n"
        "  .zoomreset-btn:hover { background:transparent; }",
        "四角复位按钮焦点状态",
    )
    s = _replace_once(
        s,
        "  .zoomreset-btn:active { transform:scale(.94); }\n  .zoom-corners",
        "  .zoomreset-btn:active { transform:scale(.94); }\n"
        "  .zoomreset-wrap[data-pan-available] { max-width:106px !important; }\n"
        "  .panlock-btn[hidden] { display:none !important; }\n"
        "  .panlock-btn { width:38px; height:38px; flex:none; border:0; outline:none; border-radius:50%; padding:0; display:flex; align-items:center; justify-content:center; cursor:pointer; color:#566472; background:transparent; transition:background .2s,color .2s,transform .18s; }\n"
        "  .panlock-btn:focus, .panlock-btn:focus-visible { outline:none; }\n"
        "  .panlock-btn:hover { background:rgba(255,255,255,.46); color:#1f2328; }\n"
        "  .panlock-btn:active { transform:scale(.92); }\n"
        "  .panlock-btn[data-active] { background:#b5333b; color:#fff; box-shadow:0 4px 12px rgba(181,51,59,.24); }\n"
        "  .panlock-btn svg { width:19px; height:19px; display:block; }\n"
        "  .zoom-corners",
        "小手按钮样式",
    )
    s = _replace_once(
        s,
        "  .app[data-mode=\"scroll\"] .stage[data-scrolling]::-webkit-scrollbar-thumb { background:rgba(69,74,84,.48); }\n\n  .slide-canvas",
        "  .app[data-mode=\"scroll\"] .stage[data-scrolling]::-webkit-scrollbar-thumb { background:rgba(69,74,84,.48); }\n"
        "  .pan-hint { position:fixed; left:50%; bottom:34px; transform:translate(-50%,12px); z-index:120; pointer-events:none; opacity:0; padding:10px 16px; border:1px solid rgba(255,255,255,.58); border-radius:999px; background:rgba(22,26,33,.78); color:#fff; box-shadow:0 10px 30px rgba(14,18,24,.24); backdrop-filter:blur(14px) saturate(1.2); -webkit-backdrop-filter:blur(14px) saturate(1.2); font-family:'Noto Sans SC',sans-serif; font-size:15px; font-weight:700; letter-spacing:.01em; transition:opacity .2s ease,transform .2s ease; }\n"
        "  .app[data-pan-hint] .pan-hint { opacity:1; transform:translate(-50%,0); }\n"
        "  .stage[data-space-pan] { cursor:grab; }\n"
        "  .stage[data-space-pan] * { cursor:grab !important; }\n"
        "  .stage[data-panning], .stage[data-panning] * { cursor:grabbing !important; }\n\n"
        "  .slide-canvas",
        "平移提示与抓手样式",
    )
    s = _replace_once(
        s,
        '  .app[data-mode="present"] .slide-canvas { transform:scale(var(--sa)); transform-origin:center center; }',
        '  .app[data-mode="present"] .slide-canvas { transform:translate(var(--pan-x,0px),var(--pan-y,0px)) scale(var(--sa)); transform-origin:center center; }',
        "放映画布平移变换",
    )
    s = _replace_once(
        s,
        """      </button>
    </div>
    <div class="navprog"><i id="navprogi"></i></div>""",
        """      </button>
      <button type="button" class="panlock-btn" id="panlock" title="切换点击 / 拖动画面" aria-label="切换到拖动画面" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 11V6.7a1.55 1.55 0 0 1 3.1 0V10"></path><path d="M10.6 10V5.5a1.55 1.55 0 0 1 3.1 0V10"></path><path d="M13.7 10V6.4a1.55 1.55 0 0 1 3.1 0v4.2"></path><path d="M16.8 10.6V8.4a1.55 1.55 0 0 1 3.1 0v5.1c0 4.6-2.7 7.1-6.9 7.1h-1.2c-2.2 0-3.8-.8-5.1-2.5L3.9 14.5a1.6 1.6 0 0 1 2.4-2.1l1.2 1.1V11z"></path></svg>
      </button>
    </div>
    <div class="navprog"><i id="navprogi"></i></div>""",
        "小手按钮 DOM",
    )

    zoom_anchor = """    const zoomResetLabel = $('#zoomresetlabel');
    this._syncZoomUi = () => {"""
    zoom_runtime = """    const zoomResetLabel = $('#zoomresetlabel');
    const zoomResetWrap = $('#zoomreset-wrap');
    const panLock = $('#panlock');
    const panHint = document.createElement('div');
    panHint.className = 'pan-hint';
    panHint.setAttribute('role', 'status');
    panHint.textContent = '画面已放大 · 按住空格键，或点击顶部小手拖动画面';
    app.appendChild(panHint);
    this._panHintEl = panHint;
    this._panX = 0; this._panY = 0; this._spacePan = false; this._panLocked = false; this._panning = false;
    this._canPan = () => (this._userZoom || 1) > 1.001;
    this._setPanLocked = (on) => {
      this._panLocked = !!on && this._canPan();
      if (panLock) {
        panLock.toggleAttribute('data-active', this._panLocked);
        panLock.setAttribute('aria-pressed', this._panLocked ? 'true' : 'false');
        panLock.setAttribute('aria-label', this._panLocked ? '切换到点击模式' : '切换到拖动画面');
      }
      if (this._panLocked || this._spacePan) stage.setAttribute('data-space-pan', '');
      else stage.removeAttribute('data-space-pan');
    };
    this._applyPan = () => {
      app.style.setProperty('--pan-x', this._panX + 'px');
      app.style.setProperty('--pan-y', this._panY + 'px');
    };
    this._clampPan = () => {
      if (app.dataset.mode !== 'present') return;
      const scale = parseFloat(getComputedStyle(app).getPropertyValue('--sa')) || 1;
      const maxX = Math.max(0, (1920 * scale - stage.clientWidth) / 2);
      const maxY = Math.max(0, (1080 * scale - Math.max(1, stage.clientHeight - 68)) / 2);
      this._panX = Math.max(-maxX, Math.min(maxX, this._panX));
      this._panY = Math.max(-maxY, Math.min(maxY, this._panY));
      this._applyPan();
    };
    this._resetPan = () => { this._panX = 0; this._panY = 0; this._applyPan(); };
    this._showPanHint = () => {
      if (!this._canPan()) return;
      app.setAttribute('data-pan-hint', '');
      if (this._panHintT) clearTimeout(this._panHintT);
      this._panHintT = setTimeout(() => app.removeAttribute('data-pan-hint'), 2600);
    };
    this._syncZoomUi = () => {"""
    s = _replace_once(s, zoom_anchor, zoom_runtime, "平移运行时初始化")
    s = _replace_once(
        s,
        """      if (zoomResetLabel) zoomResetLabel.textContent = Math.round(this._userZoom * 100) + '%';
    };""",
        """      if (zoomResetLabel) zoomResetLabel.textContent = Math.round(this._userZoom * 100) + '%';
      const panAvailable = (this._userZoom || 1) > 1.001;
      if (zoomResetWrap) zoomResetWrap.toggleAttribute('data-pan-available', panAvailable);
      if (panLock) { panLock.hidden = !panAvailable; panLock.tabIndex = panAvailable ? 0 : -1; panLock.setAttribute('aria-hidden', panAvailable ? 'false' : 'true'); }
      if (!panAvailable && this._setPanLocked) this._setPanLocked(false);
    };""",
        "缩放工具状态同步",
    )
    s = _replace_once(
        s,
        """        this._syncZoomUi();
        fit();
        if (keepAnchor) stage.scrollTop += active.getBoundingClientRect().top - anchorTop;
        requestAnimationFrame(() => { this._zooming = false; });""",
        """        this._syncZoomUi();
        fit();
        if (keepAnchor) stage.scrollTop += active.getBoundingClientRect().top - anchorTop;
        requestAnimationFrame(() => {
          if (!this._canPan()) this._resetPan(); else { this._clampPan(); this._showPanHint(); }
          this._zooming = false;
        });""",
        "缩放后平移同步",
    )
    s = _replace_once(
        s,
        "this._zoomResetH = (e) => { e.preventDefault(); e.stopPropagation(); this._setUserZoom(1); };",
        "this._zoomResetH = (e) => { e.preventDefault(); e.stopPropagation(); this._setUserZoom(1); if (e.currentTarget && e.currentTarget.blur) e.currentTarget.blur(); };",
        "四角复位焦点释放",
    )
    s = _replace_once(
        s,
        """    if (zoomReset) zoomReset.addEventListener('click', this._zoomResetH);
    this._syncZoomUi();""",
        """    if (zoomReset) zoomReset.addEventListener('click', this._zoomResetH);
    this._panLockH = (e) => { e.preventDefault(); e.stopPropagation(); this._setPanLocked(!this._panLocked); app.removeAttribute('data-pan-hint'); if (e.currentTarget && e.currentTarget.blur) e.currentTarget.blur(); };
    if (panLock) panLock.addEventListener('click', this._panLockH);
    this._syncZoomUi();""",
        "小手按钮事件",
    )
    s = _replace_once(
        s,
        """    const apply = () => {
      this._fits.forEach((f, k) => f.toggleAttribute('data-active', k === this._index));""",
        """    const apply = () => {
      if (this._resetPan) this._resetPan();
      this._fits.forEach((f, k) => f.toggleAttribute('data-active', k === this._index));""",
        "换页复位平移",
    )

    click_anchor = """    this._clickH = (e) => {
      if (!e.isTrusted || e.button !== 0) return;"""
    drag_runtime = """    const endPan = () => {
      this._panning = false;
      stage.removeAttribute('data-panning');
      if (!this._spacePan && !this._panLocked) stage.removeAttribute('data-space-pan');
    };
    this._panDownH = (e) => {
      if ((!this._spacePan && !this._panLocked) || !this._canPan() || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this._panning = true; this._panMoved = false;
      this._panStartX = e.clientX; this._panStartY = e.clientY;
      this._panLastX = e.clientX; this._panLastY = e.clientY;
      stage.setAttribute('data-panning', '');
    };
    this._panMoveH = (e) => {
      if (!this._panning) return;
      e.preventDefault(); e.stopPropagation();
      const dx = e.clientX - this._panLastX, dy = e.clientY - this._panLastY;
      this._panLastX = e.clientX; this._panLastY = e.clientY;
      if (Math.abs(e.clientX - this._panStartX) + Math.abs(e.clientY - this._panStartY) > 4) this._panMoved = true;
      if (app.dataset.mode === 'present') {
        this._panX += dx; this._panY += dy; this._clampPan();
      } else {
        stage.scrollLeft -= dx; stage.scrollTop -= dy;
      }
    };
    this._panUpH = (e) => {
      if (!this._panning) return;
      e.preventDefault(); e.stopPropagation();
      if (this._panMoved) this._panSuppressClick = true;
      endPan();
    };
    stage.addEventListener('mousedown', this._panDownH, true);
    window.addEventListener('mousemove', this._panMoveH, true);
    window.addEventListener('mouseup', this._panUpH, true);

    this._clickH = (e) => {
      if (this._panSuppressClick) { this._panSuppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
      if (!e.isTrusted || e.button !== 0) return;"""
    s = _replace_once(s, click_anchor, drag_runtime, "鼠标拖动画布")
    s = _replace_once(
        s,
        """      if (e.target.closest && e.target.closest(CHROME)) return;
      if (isInteractive(e.target)) return;""",
        """      if (e.target.closest && e.target.closest(CHROME)) return;
      if (this._panLocked) { e.preventDefault(); e.stopPropagation(); return; }
      if (isInteractive(e.target)) return;""",
        "抓手模式禁用点击推进",
    )
    s = _replace_once(
        s,
        """      const k = e.key;
      if (e.ctrlKey || e.metaKey) {""",
        """      const k = e.key;
      if ((k === ' ' || k === 'Spacebar') && this._canPan()) {
        e.preventDefault(); e.stopPropagation();
        if (!e.repeat) { this._spacePan = true; stage.setAttribute('data-space-pan', ''); app.removeAttribute('data-pan-hint'); }
        return;
      }
      if (e.ctrlKey || e.metaKey) {""",
        "空格键临时抓手",
    )
    s = _replace_once(
        s,
        """    window.addEventListener('keydown', this._keyH, true);

    this._scrollH = () => {""",
        """    window.addEventListener('keydown', this._keyH, true);
    this._keyUpH = (e) => {
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      if (!this._spacePan) return;
      e.preventDefault(); e.stopPropagation();
      this._spacePan = false; endPan();
    };
    this._panBlurH = () => { this._spacePan = false; endPan(); };
    window.addEventListener('keyup', this._keyUpH, true);
    window.addEventListener('blur', this._panBlurH);

    this._scrollH = () => {""",
        "释放空格结束抓手",
    )
    s = _replace_once(
        s,
        """    if (this._keyH) window.removeEventListener('keydown', this._keyH, true);
    if (this._stage && this._scrollH) this._stage.removeEventListener('scroll', this._scrollH);""",
        """    if (this._keyH) window.removeEventListener('keydown', this._keyH, true);
    if (this._keyUpH) window.removeEventListener('keyup', this._keyUpH, true);
    if (this._panBlurH) window.removeEventListener('blur', this._panBlurH);
    if (this._stage && this._panDownH) this._stage.removeEventListener('mousedown', this._panDownH, true);
    if (this._panMoveH) window.removeEventListener('mousemove', this._panMoveH, true);
    if (this._panUpH) window.removeEventListener('mouseup', this._panUpH, true);
    if (this._panHintT) clearTimeout(this._panHintT);
    if (this._panHintEl && this._panHintEl.parentNode) this._panHintEl.parentNode.removeChild(this._panHintEl);
    if (this._stage && this._scrollH) this._stage.removeEventListener('scroll', this._scrollH);""",
        "卸载平移监听",
    )
    s = _replace_once(
        s,
        """    if (this._zoomResetH) { const z = document.getElementById('zoomreset'); if (z) z.removeEventListener('click', this._zoomResetH); }
    if (this._fsH)""",
        """    if (this._zoomResetH) { const z = document.getElementById('zoomreset'); if (z) z.removeEventListener('click', this._zoomResetH); }
    if (this._panLockH) { const p = document.getElementById('panlock'); if (p) p.removeEventListener('click', this._panLockH); }
    if (this._fsH)""",
        "卸载小手按钮",
    )
    return s


def has_present_wheel(s):
    markers = (
        "this._presentWheelH = (e) =>",
        "this._presentWheelArmed = true",
        "window.addEventListener('wheel', this._presentWheelH",
        "clearTimeout(this._presentWheelEndT)",
    )
    return all(marker in s for marker in markers)


def migrate_present_wheel(s):
    """放映态普通滚轮复用方向键的逐拍/翻页语义，并过滤惯性尾流。"""
    if has_present_wheel(s):
        return s
    s = _replace_once(
        s,
        """    window.addEventListener('click', this._clickH, true);

    this._keyH = (e) => {""",
        """    window.addEventListener('click', this._clickH, true);

    // 放映模式：一段连续滚轮/触控板手势只推进一次，手势停止后重新武装。
    this._presentWheelArmed = true;
    this._presentWheelDelta = 0;
    this._presentWheelH = (e) => {
      if (app.dataset.mode !== 'present' || e.ctrlKey || e.metaKey) return;
      if (e.target && e.target.closest && e.target.closest(CHROME + ', #a3calcModal')) return;
      e.preventDefault(); e.stopPropagation();
      if (this._presentWheelEndT) clearTimeout(this._presentWheelEndT);
      this._presentWheelEndT = setTimeout(() => {
        this._presentWheelArmed = true;
        this._presentWheelDelta = 0;
      }, 180);
      if (!this._presentWheelArmed) return;
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 18;
      else if (e.deltaMode === 2) delta *= Math.max(1, stage.clientHeight);
      if (!delta) return;
      if (this._presentWheelDelta && Math.sign(delta) !== Math.sign(this._presentWheelDelta)) this._presentWheelDelta = 0;
      this._presentWheelDelta += delta;
      if (Math.abs(this._presentWheelDelta) < 48) return;
      this._presentWheelArmed = false;
      const forward = this._presentWheelDelta > 0;
      this._presentWheelDelta = 0;
      if (forward) { if (!forwardStep()) go(this._index + 1); }
      else { if (!backStep()) go(this._index - 1, true); }
    };
    window.addEventListener('wheel', this._presentWheelH, { passive:false, capture:true });

    this._keyH = (e) => {""",
        "放映滚轮导航",
    )
    s = _replace_once(
        s,
        """    if (this._clickH) window.removeEventListener('click', this._clickH, true);
    if (this._keyH) window.removeEventListener('keydown', this._keyH, true);""",
        """    if (this._clickH) window.removeEventListener('click', this._clickH, true);
    if (this._presentWheelH) window.removeEventListener('wheel', this._presentWheelH, true);
    if (this._presentWheelEndT) clearTimeout(this._presentWheelEndT);
    if (this._keyH) window.removeEventListener('keydown', this._keyH, true);""",
        "卸载放映滚轮导航",
    )
    return s
