/**
 * MosaicFilter plugin — player overlay
 *
 * Architecture:
 * - Uses csLib.PathElementListener to inject on /scenes/ when #VideoJsPlayer
 *   exists, and on subsequent stash:location SPA navigations.
 * - Adds an extra window.PluginApi.Event "stash:location" safety net to
 *   re-inject the overlay if React re-renders remove it. There can be a brief
 *   flash between removal and re-injection.
 * - Single global config — all scenes share one set of mosaic settings. The
 *   most common use case is follow-cursor, so the rectangle's position is
 *   normally derived from the cursor at runtime, not stored per scene.
 * - Geometry is stored as percentages of the player so the rectangle scales
 *   correctly across viewport sizes and fullscreen.
 * - All state mutations are persisted via
 *   csLib.setConfiguration("MosaicFilter", state) wrapped in a lock to avoid
 *   concurrent saves. csLib.getConfiguration and setConfiguration are BOTH
 *   async — always await them.
 * - Write policy: writes happen at user-driven boundaries (toggle, drag end,
 *   resize end, slider release, scene transition, pagehide). The blur slider
 *   updates the visual on every `input` event but only persists on `change`
 *   (slider release). Follow-mode position updates are in-memory only and
 *   persist at the boundaries.
 */
(function () {
  "use strict";

  const csLib = window.csLib;
  if (!csLib) {
    console.error("MosaicFilter: CommunityScriptsUILibrary not loaded. Install it first.");
    return;
  }

  const CONFIG_KEY = "MosaicFilter";

  // Hard-coded defaults used when no config has ever been written, and as
  // the target of the overlay's "Reset" button.
  const FALLBACK_DEFAULTS = {
    blurAmount: 10,
    widthPct: 0.25,
    heightPct: 0.25,
    xPct: 0.1,
    yPct: 0.1,
    active: false,
    // follow defaults to false: the user opts in to cursor-tracking from
    // the control bar. The rectangle is stationary until they toggle it on.
    follow: false,
    shape: 'rectangle',
    mode: 'normal',
  };

  const MIN_SIZE_PCT = 0.05;
  const MAX_BLUR = 80;

  // Module-level state. `state` is the single global config object. It is
  // reloaded from csLib on every fresh mount of the overlay (e.g. after
  // navigation, after the settings page writes, or after React re-mounts
  // the player element).
  let state = makeDefaultState();

  let saving = false;
  let pendingSave = false;

  // Live DOM references; null when the overlay is not mounted.
  let player = null;
  let rect = null;
  let resizeHandle = null;
  let bar = null;
  let maskLayer = null;

  // Track the collapsed state of the control bar so that re-renders (which
  // rebuild the bar's innerHTML) don't silently re-expand the controls. The
  // user can collapse via the chip or the close button and we must remember
  // their choice across subsequent renders.
  let barCollapsed = false;

  // Active pointer interaction. Either { type: "drag" } or { type: "resize" }.
  let dragState = null;

  // Last known cursor position over the player. Used by snapRectToPointer
  // when toggling Follow on or mounting with Follow already enabled.
  let lastPointer = null;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }

  function makeDefaultState() {
    return { ...FALLBACK_DEFAULTS };
  }

  // Merge a stored config map onto a fresh default state. Tolerates the
  // legacy { defaults, scenes } shape (used by 0.2.x) by reading the old
  // `defaults` and ignoring `scenes` — the per-scene model is gone.
  function mergeStored(stored) {
    const out = makeDefaultState();
    if (stored && typeof stored === "object") {
      let source = stored;
      // Legacy shape: { defaults: {...}, scenes: {...} } — use defaults,
      // drop scenes.
      if (stored.defaults && typeof stored.defaults === "object") {
        source = stored.defaults;
      }
      for (const key of Object.keys(out)) {
        if (source[key] !== undefined) {
          out[key] = source[key];
        }
      }
    }
    return sanitizeState(out);
  }

  // Sanitize a state object: clamp values into valid ranges, fill missing
  // fields from FALLBACK_DEFAULTS, coerce types. Mutates and returns the
  // object.
  function sanitizeState(s) {
    const d = FALLBACK_DEFAULTS;
    const out = {
      blurAmount: isFiniteNumber(s.blurAmount) ? s.blurAmount : d.blurAmount,
      widthPct: isFiniteNumber(s.widthPct) ? s.widthPct : d.widthPct,
      heightPct: isFiniteNumber(s.heightPct) ? s.heightPct : d.heightPct,
      xPct: isFiniteNumber(s.xPct) ? s.xPct : d.xPct,
      yPct: isFiniteNumber(s.yPct) ? s.yPct : d.yPct,
      active: typeof s.active === "boolean" ? s.active : d.active,
      follow: typeof s.follow === "boolean" ? s.follow : d.follow,
      shape: (typeof s.shape === 'string' && (s.shape === 'rectangle' || s.shape === 'ellipse')) ? s.shape : d.shape,
      mode: (typeof s.mode === 'string' && (s.mode === 'normal' || s.mode === 'reverse')) ? s.mode : d.mode,
    };
    out.blurAmount = clamp(out.blurAmount, 0, MAX_BLUR);
    out.widthPct = clamp(out.widthPct, MIN_SIZE_PCT, 1);
    out.heightPct = clamp(out.heightPct, MIN_SIZE_PCT, 1);
    out.xPct = clamp(out.xPct, 0, 1 - out.widthPct);
    out.yPct = clamp(out.yPct, 0, 1 - out.heightPct);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Persistence (csLib is async; coalesce concurrent writes with a lock)
  // ---------------------------------------------------------------------------

  async function saveNow() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    try {
      await csLib.setConfiguration(CONFIG_KEY, state);
    } catch (err) {
      console.error("MosaicFilter: failed to save configuration", err);
    } finally {
      saving = false;
      if (pendingSave) {
        pendingSave = false;
        saveNow();
      }
    }
  }

  function queueSave() {
    saveNow();
  }

  // Load config from csLib and update the in-memory `state`.
  async function loadState() {
    let stored = null;
    try {
      stored = await csLib.getConfiguration(CONFIG_KEY);
    } catch (err) {
      console.error("MosaicFilter: failed to read configuration", err);
      stored = null;
    }
    state = mergeStored(stored);
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function ensurePlayerRelative(el) {
    // getComputedStyle always returns a non-empty value for `position`, so
    // checking the empty-string branch is unreachable. The only way the
    // element lacks a positioning context is when the computed value is
    // "static" — we promote it to "relative" so our absolutely-positioned
    // children (the mosaic rectangle and control bar) anchor to it.
    const style = window.getComputedStyle(el);
    if (style.position === "static") {
      el.style.position = "relative";
    }
  }

  function buildRect() {
    const r = document.createElement("div");
    r.className = "mosaic-filter-rectangle";
    r.dataset.action = "rect-drag";

    const h = document.createElement("div");
    h.className = "mosaic-filter-rectangle__resize";
    h.dataset.action = "rect-resize";
    h.setAttribute("aria-label", "Resize mosaic");
    r.appendChild(h);

    return r;
  }

  function buildMaskLayer() {
    const ml = document.createElement("div");
    ml.className = "mosaic-filter-mask-layer";
    return ml;
  }

  function buildBar() {
    const b = document.createElement("div");
    b.className = "mosaic-filter-bar";
    b.dataset.action = "panel";
    b.setAttribute("role", "toolbar");
    b.setAttribute("aria-label", "Mosaic filter controls");
    return b;
  }

  function renderBar() {
    if (!bar) return;
    const on = !!state.active;
    const follow = !!state.follow;
    const shape = state.shape;
    const mode = state.mode;
    bar.classList.toggle("mosaic-filter-bar--collapsed", barCollapsed);
    bar.innerHTML =
      '<span class="mosaic-filter-bar__chip" data-action="toggle-bar" title="Hide controls">' +
        "🔲 Mosaic " + (on ? "ON" : "OFF") +
      "</span>" +
      '<span class="mosaic-filter-bar__controls">' +
        '<span class="mosaic-filter-bar__slider">' +
          '<span class="mosaic-filter-bar__label">Blur</span>' +
          '<input type="range" min="0" max="' + MAX_BLUR + '" step="1" value="' + state.blurAmount + '" data-action="blur-slider" aria-label="Mosaic blur amount (pixels)" />' +
          '<span class="mosaic-filter-bar__label" data-action="blur-readout">' + state.blurAmount + "px</span>" +
        "</span>" +
        '<button type="button" class="mosaic-filter-bar__button ' + (on ? "mosaic-filter-bar__button--active" : "") + '" data-action="toggle-active" title="Toggle the mosaic on or off">' +
          (on ? "✓ Active" : "⏸ Off") +
        "</button>" +
        '<button type="button" class="mosaic-filter-bar__button ' + (follow ? "mosaic-filter-bar__button--active" : "") + '" data-action="toggle-follow" title="When on, the rectangle follows the cursor. Drag is disabled in this mode.">' +
          "🎯 Follow" +
        "</button>" +
        '<button type="button" class="mosaic-filter-bar__button mosaic-filter-bar__button--active" data-action="toggle-shape" title="' + (shape === "ellipse" ? "Shape: ellipse. Click to switch to rectangle." : "Shape: rectangle. Click to switch to ellipse.") + '">' +
          (shape === "ellipse" ? "● Ellipse" : "▭ Rectangle") +
        '</button>' +
        '<button type="button" class="mosaic-filter-bar__button mosaic-filter-bar__button--active" data-action="toggle-mode" title="' + (mode === "reverse" ? "Mode: reverse — blur outside the filter. Click to switch to normal." : "Mode: normal — blur inside the filter. Click to switch to reverse.") + '">' +
          (mode === "reverse" ? "◈ Reverse" : "▣ Normal") +
        '</button>' +
        '<button type="button" class="mosaic-filter-bar__button" data-action="reset-defaults" title="Reset the mosaic to default size, position, and blur">' +
          "↺ Reset" +
        "</button>" +
        '<button type="button" class="mosaic-filter-bar__button" data-action="close-bar" title="Hide the control bar (the rectangle stays if it is active)" aria-label="Close controls">' +
          "✕" +
        "</button>" +
      "</span>";
  }

  // Position the rectangle based on the current state and player size.
  // Cheap; safe to call on every pointer move.
  function renderRect() {
    if (!rect || !player) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    rect.style.left = (state.xPct * pw) + "px";
    rect.style.top = (state.yPct * ph) + "px";
    rect.style.width = (state.widthPct * pw) + "px";
    rect.style.height = (state.heightPct * ph) + "px";
    player.style.setProperty("--mf-blur", state.blurAmount + "px");
    rect.classList.toggle("mosaic-filter-rectangle--hidden", !state.active);
    rect.classList.toggle("mosaic-filter-rectangle--ellipse", state.shape === 'ellipse');
    rect.classList.toggle("mosaic-filter-rectangle--reverse", state.mode === 'reverse');
    updateMask();
  }

  // Update the reverse-mode mask layer position, size, and shape to match
  // the current state. The mask layer uses CSS custom properties for the hole
  // position/size so a single setProperty call updates it without re-generating
  // a data URL or re-building the mask-image string.
  //
  // The mask layer is only meaningful when both `state.active` is true AND
  // `state.mode === 'reverse'`. If the user toggles the filter off while in
  // reverse mode, the mask layer must hide too — otherwise the entire player
  // is blurred with no clear area and no indicator. The `--hidden` class
  // collapses it to `display: none`, which overrides `--reverse`'s
  // `display: block`.
  function updateMask() {
    if (!maskLayer || !player) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    const leftPx = state.xPct * pw;
    const topPx = state.yPct * ph;
    const wPx = Math.max(state.widthPct * pw, 1);
    const hPx = Math.max(state.heightPct * ph, 1);
    maskLayer.style.setProperty('--mf-mask-x', leftPx + 'px');
    maskLayer.style.setProperty('--mf-mask-y', topPx + 'px');
    maskLayer.style.setProperty('--mf-mask-w', wPx + 'px');
    maskLayer.style.setProperty('--mf-mask-h', hPx + 'px');
    const reverseOn = state.active && state.mode === 'reverse';
    maskLayer.classList.toggle('mosaic-filter-mask-layer--ellipse', state.shape === 'ellipse');
    maskLayer.classList.toggle('mosaic-filter-mask-layer--reverse', reverseOn);
    maskLayer.classList.toggle('mosaic-filter-mask-layer--hidden', !state.active);
  }

  function render() {
    renderRect();
    renderBar();
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  function teardown() {
    detachFollowListener();
    if (rect && rect.parentElement) rect.parentElement.removeChild(rect);
    if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
    if (maskLayer && maskLayer.parentElement) maskLayer.parentElement.removeChild(maskLayer);
    rect = null;
    resizeHandle = null;
    bar = null;
    maskLayer = null;
    player = null;
    barCollapsed = false;
    lastPointer = null;
  }

  // Re-validate the live player and (re-)attach our overlay elements to it.
  // Returns true if the overlay is now mounted on a live player, false if no
  // #VideoJsPlayer exists in the current DOM.
  function mountOnPlayer() {
    const freshPlayer = document.querySelector("#VideoJsPlayer");
    if (!freshPlayer) return false;
    if (player !== freshPlayer) {
      // React replaced the player element; drop any children still bound to
      // the old (orphaned) node and start fresh.
      teardown();
      player = freshPlayer;
      ensurePlayerRelative(player);
    }
    if (!maskLayer) {
      maskLayer = buildMaskLayer();
      player.appendChild(maskLayer);
    }
    if (!rect) {
      rect = buildRect();
      resizeHandle = rect.querySelector(".mosaic-filter-rectangle__resize");
      player.appendChild(rect);
      attachRectPointerListeners();
    }
    if (!bar) {
      bar = buildBar();
      player.appendChild(bar);
      attachBarListeners();
    }
    // Always attach the follow listener while the overlay is mounted, so
    // that toggling Follow on later just flips the flag (and snaps the
    // rectangle to the cursor) without re-binding event handlers.
    attachFollowListener();
    if (state.follow) {
      snapRectToPointer();
    }
    return true;
  }

  function setupPanel(targetPlayer) {
    if (player !== targetPlayer) {
      teardown();
    }
    if (rect && bar) {
      // Same overlay, same player — re-render only (handles window resize).
      render();
      return;
    }
    // Load fresh config and build the UI. We re-query the player in the
    // .then below because React may have replaced the player element while
    // we were awaiting the config read; appending to a stale node would
    // silently lose the overlay.
    player = targetPlayer;
    Promise.resolve()
      .then(function () { return loadState(); })
      .then(function () {
        if (mountOnPlayer()) {
          render();
        }
      });
  }

  // ---------------------------------------------------------------------------
  // Pointer interactions on the rectangle (drag + resize)
  // ---------------------------------------------------------------------------

  function onRectPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return; // primary button only
    // In follow mode the rectangle is anchored to the cursor already, so
    // dragging it is redundant and would just fight the follow handler.
    // Resize still works.
    if (state.follow && e.target.dataset.action !== "rect-resize") {
      return;
    }
    const target = e.target;
    const action = target && target.dataset && target.dataset.action;
    let type;
    if (action === "rect-resize") {
      type = "resize";
    } else if (action === "rect-drag" || (rect && rect.contains(target))) {
      type = "drag";
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!player) return;
    dragState = {
      type: type,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startXPct: state.xPct,
      startYPct: state.yPct,
      startWPct: state.widthPct,
      startHPct: state.heightPct,
      pw: player.clientWidth,
      ph: player.clientHeight,
    };
    if (rect.setPointerCapture) {
      try { rect.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }
    rect.classList.add(
      type === "resize" ? "mosaic-filter-rectangle--resizing" : "mosaic-filter-rectangle--dragging"
    );
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragState) return;
    const pw = dragState.pw;
    const ph = dragState.ph;
    if (!pw || !ph) return;
    const dxPct = (e.clientX - dragState.startX) / pw;
    const dyPct = (e.clientY - dragState.startY) / ph;
    if (dragState.type === "drag") {
      state.xPct = clamp(dragState.startXPct + dxPct, 0, 1 - state.widthPct);
      state.yPct = clamp(dragState.startYPct + dyPct, 0, 1 - state.heightPct);
    } else {
      const newW = clamp(dragState.startWPct + dxPct, MIN_SIZE_PCT, 1 - state.xPct);
      const newH = clamp(dragState.startHPct + dyPct, MIN_SIZE_PCT, 1 - state.yPct);
      state.widthPct = newW;
      state.heightPct = newH;
    }
    renderRect();
  }

  function onPointerUp(e) {
    if (!dragState) return;
    const pointerId = dragState.pointerId;
    rect.classList.remove(
      "mosaic-filter-rectangle--dragging",
      "mosaic-filter-rectangle--resizing"
    );
    if (rect && rect.releasePointerCapture && pointerId !== undefined) {
      try { rect.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
    }
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    dragState = null;
    queueSave();
  }

  function attachRectPointerListeners() {
    if (!rect) return;
    rect.addEventListener("pointerdown", onRectPointerDown);
  }

  // ---------------------------------------------------------------------------
  // Bar interactions (click delegation + slider)
  // ---------------------------------------------------------------------------

  function onBarClick(e) {
    const target = e.target.closest("[data-action]");
    if (!target || !bar || !bar.contains(target)) return;
    const action = target.dataset.action;
    switch (action) {
      case "toggle-bar":
        barCollapsed = !barCollapsed;
        bar.classList.toggle("mosaic-filter-bar--collapsed", barCollapsed);
        e.preventDefault();
        break;
      case "toggle-active":
        state.active = !state.active;
        queueSave();
        renderBar();
        renderRect();
        break;
      case "toggle-follow":
        state.follow = !state.follow;
        if (state.follow) snapRectToPointer();
        queueSave();
        renderBar();
        break;
      case "toggle-shape":
        state.shape = state.shape === 'rectangle' ? 'ellipse' : 'rectangle';
        queueSave();
        render();
        break;
      case "toggle-mode":
        state.mode = state.mode === 'normal' ? 'reverse' : 'normal';
        queueSave();
        render();
        break;
      case "reset-defaults":
        Object.assign(state, makeDefaultState());
        queueSave();
        render();
        break;
      case "close-bar":
        barCollapsed = true;
        bar.classList.add("mosaic-filter-bar--collapsed");
        break;
      default:
        break;
    }
  }

  // The slider fires `input` continuously while the user drags the thumb.
  // We update the visual blur on every event for instant feedback, but we
  // deliberately do NOT persist on every event — the `change` event (which
  // fires when the user releases the thumb) is the persistence boundary.
  function onBarInput(e) {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "blur-slider") return;
    const value = clamp(parseInt(target.value, 10) || 0, 0, MAX_BLUR);
    state.blurAmount = value;
    player.style.setProperty("--mf-blur", value + "px");
    const readout = bar.querySelector('[data-action="blur-readout"]');
    if (readout) readout.textContent = value + "px";
  }

  function onBarChange(e) {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "blur-slider") return;
    // Slider release: persist the final blur amount. (State was already
    // updated by `input`; this just commits it to csLib.)
    queueSave();
  }

  function attachBarListeners() {
    if (!bar) return;
    bar.addEventListener("click", onBarClick);
    bar.addEventListener("input", onBarInput);
    bar.addEventListener("change", onBarChange);
  }

  // ---------------------------------------------------------------------------
  // Follow-cursor mode
  // ---------------------------------------------------------------------------

  function onPlayerPointerMove(e) {
    // Always record the latest cursor position over the player, so that
    // toggling Follow on later snaps to the right spot.
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!state.follow) return;
    if (dragState) return;
    if (!player || !rect) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    const pr = player.getBoundingClientRect();
    const cursorXPct = (e.clientX - pr.left) / pw;
    const cursorYPct = (e.clientY - pr.top) / ph;
    state.xPct = clamp(cursorXPct - state.widthPct / 2, 0, 1 - state.widthPct);
    state.yPct = clamp(cursorYPct - state.heightPct / 2, 0, 1 - state.heightPct);
    // In-memory only — see the "Write policy" note in the file header.
    renderRect();
  }

  function snapRectToPointer() {
    if (!player || !rect) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    const pr = player.getBoundingClientRect();
    let cursorXPct, cursorYPct;
    if (lastPointer) {
      cursorXPct = (lastPointer.x - pr.left) / pw;
      cursorYPct = (lastPointer.y - pr.top) / ph;
    } else {
      cursorXPct = 0.5;
      cursorYPct = 0.5;
    }
    state.xPct = clamp(cursorXPct - state.widthPct / 2, 0, 1 - state.widthPct);
    state.yPct = clamp(cursorYPct - state.heightPct / 2, 0, 1 - state.heightPct);
    renderRect();
    queueSave();
  }

  function attachFollowListener() {
    if (!player) return;
    player.addEventListener("pointermove", onPlayerPointerMove);
  }

  function detachFollowListener() {
    if (!player) return;
    player.removeEventListener("pointermove", onPlayerPointerMove);
  }

  // ---------------------------------------------------------------------------
  // SPA injection: PathElementListener + stash:location safety net
  // ---------------------------------------------------------------------------

  function tryInject() {
    const p = document.querySelector("#VideoJsPlayer");
    if (p) setupPanel(p);
  }

  // Primary: re-injects whenever the player element appears in the DOM.
  csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel);

  // Safety net: also re-inject on SPA navigation, in case the player element
  // is still in the DOM but the scene changed (React re-rendered the page
  // without removing the player first).
  if (window.PluginApi && window.PluginApi.Event && typeof window.PluginApi.Event.addEventListener === "function") {
    window.PluginApi.Event.addEventListener("stash:location", function () {
      tryInject();
    });
  }

  // Re-position the rectangle on window resize so the percentages stay right.
  window.addEventListener("resize", function () {
    if (rect && player) renderRect();
  });

  // Best-effort: persist any in-memory changes before the page is hidden.
  // Async saves may not complete before the page unloads, but the request
  // is at least submitted.
  window.addEventListener("pagehide", function () {
    queueSave();
  });
})();
