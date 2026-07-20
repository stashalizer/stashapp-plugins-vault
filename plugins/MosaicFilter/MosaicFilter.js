/**
 * MosaicFilter plugin — player overlay
 *
 * Architecture:
 * - Uses csLib.PathElementListener to inject on /scenes/ when #VideoJsPlayer
 *   exists, and on subsequent stash:location SPA navigations.
 * - Adds an extra window.PluginApi.Event "stash:location" safety net to
 *   re-inject the overlay if React re-renders remove it. There can be a brief
 *   flash between removal and re-injection.
 * - Per-scene state: the overlay reads the scene id from the URL
 *   (/scenes/(\d+)) and reads/writes only that scene's slot in the config
 *   map. Other scenes' data is preserved on save (read-modify-write).
 * - Geometry is stored as percentages of the player so the rectangle scales
 *   correctly across viewport sizes and fullscreen.
 * - All state mutations are persisted via
 *   csLib.setConfiguration("MosaicFilter", state) wrapped in a lock to avoid
 *   concurrent saves. csLib.getConfiguration and setConfiguration are BOTH
 *   async — always await them.
 */
(function () {
  "use strict";

  const csLib = window.csLib;
  if (!csLib) {
    console.error("MosaicFilter: CommunityScriptsUILibrary not loaded. Install it first.");
    return;
  }

  const CONFIG_KEY = "MosaicFilter";

  // Fallback defaults used when no config has ever been written. Note: the
  // settings page can override these via the config's `defaults` field.
  const FALLBACK_DEFAULTS = {
    blurAmount: 24,
    widthPct: 0.25,
    heightPct: 0.25,
    xPct: 0.1,
    yPct: 0.1,
    active: true,
    follow: false, // when true, the rectangle tracks the cursor
  };

  const MIN_SIZE_PCT = 0.05;
  const MAX_BLUR = 80;
  const SLIDER_DEBOUNCE_MS = 80; // throttle blur-slider writes

  // Module-level state. `state` is the whole config map (defaults + scenes).
  // `sceneState` is the per-scene slot currently being edited. `currentSceneId`
  // is the id of the scene the panel was last bound to. They are reloaded from
  // csLib on every fresh scene visit (URL change).
  let state = makeDefaultState();
  let sceneState = null;
  let currentSceneId = null;

  let saving = false;
  let pendingSave = false;
  let lastSliderSaveAt = 0;
  let pendingSliderSaveTimer = null;

  // Live DOM references; null when the overlay is not mounted.
  let player = null;
  let rect = null;
  let resizeHandle = null;
  let bar = null;

  // Track the collapsed state of the control bar so that re-renders (which
  // rebuild the bar's innerHTML) don't silently re-expand the controls. The
  // user can collapse via the chip or the close button and we must remember
  // their choice across subsequent renders.
  let barCollapsed = false;

  // Active pointer interaction. Either { type: "drag" } or { type: "resize" }.
  let dragState = null;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function makeDefaultState() {
    return {
      defaults: { ...FALLBACK_DEFAULTS },
      scenes: {},
    };
  }

  // Merge a stored config map onto a fresh default state. Tolerates partial
  // / missing / legacy shapes.
  function mergeStored(stored) {
    const out = makeDefaultState();
    if (stored && typeof stored === "object") {
      if (stored.defaults && typeof stored.defaults === "object") {
        Object.assign(out.defaults, stored.defaults);
      }
      if (stored.scenes && typeof stored.scenes === "object") {
        out.scenes = {};
        for (const id of Object.keys(stored.scenes)) {
          const entry = stored.scenes[id];
          if (entry && typeof entry === "object") {
            out.scenes[id] = { ...out.defaults, ...entry };
          }
        }
      }
    }
    return out;
  }

  // Extract the scene id from the current URL. Returns null when the URL is
  // not a scene page.
  function getSceneIdFromUrl() {
    const m = window.location.pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }

  // Sanitize a per-scene state object: clamp values into valid ranges, fill
  // missing fields from defaults. Mutates and returns the object.
  function sanitizeSceneEntry(entry) {
    const d = state.defaults;
    const out = {
      blurAmount: isFiniteNumber(entry.blurAmount) ? entry.blurAmount : d.blurAmount,
      widthPct: isFiniteNumber(entry.widthPct) ? entry.widthPct : d.widthPct,
      heightPct: isFiniteNumber(entry.heightPct) ? entry.heightPct : d.heightPct,
      xPct: isFiniteNumber(entry.xPct) ? entry.xPct : d.xPct,
      yPct: isFiniteNumber(entry.yPct) ? entry.yPct : d.yPct,
      active: typeof entry.active === "boolean" ? entry.active : d.active,
      follow: typeof entry.follow === "boolean" ? entry.follow : d.follow,
    };
    out.blurAmount = clamp(out.blurAmount, 0, MAX_BLUR);
    out.widthPct = clamp(out.widthPct, MIN_SIZE_PCT, 1);
    out.heightPct = clamp(out.heightPct, MIN_SIZE_PCT, 1);
    out.xPct = clamp(out.xPct, 0, 1 - out.widthPct);
    out.yPct = clamp(out.yPct, 0, 1 - out.heightPct);
    return out;
  }

  function getOrCreateSceneState(id) {
    if (!state.scenes[id]) {
      state.scenes[id] = sanitizeSceneEntry({ ...state.defaults });
    } else {
      state.scenes[id] = sanitizeSceneEntry(state.scenes[id]);
    }
    return state.scenes[id];
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
        // Recurse to drain. The lock is released so this will proceed.
        saveNow();
      }
    }
  }

  function queueSave() {
    saveNow();
  }

  // Load config from csLib and update the in-memory `state`. If `id` is
  // given, materialize a sceneState for that scene.
  async function loadState(id) {
    let stored = null;
    try {
      stored = await csLib.getConfiguration(CONFIG_KEY);
    } catch (err) {
      console.error("MosaicFilter: failed to read configuration", err);
      stored = null;
    }
    state = mergeStored(stored);
    if (id) {
      sceneState = getOrCreateSceneState(id);
    } else {
      sceneState = null;
    }
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

  function buildBar() {
    const b = document.createElement("div");
    b.className = "mosaic-filter-bar";
    b.dataset.action = "panel";
    b.setAttribute("role", "toolbar");
    b.setAttribute("aria-label", "Mosaic filter controls");
    return b;
  }

  function renderBar() {
    if (!bar || !sceneState) return;
    const on = !!sceneState.active;
    const follow = !!sceneState.follow;
    // Respect the user's collapsed/expanded preference across re-renders.
    bar.classList.toggle("mosaic-filter-bar--collapsed", barCollapsed);
    bar.innerHTML =
      '<span class="mosaic-filter-bar__chip" data-action="toggle-bar" title="Hide controls">' +
        "🔲 Mosaic " + (on ? "ON" : "OFF") +
      "</span>" +
      '<span class="mosaic-filter-bar__controls">' +
        '<span class="mosaic-filter-bar__slider">' +
          '<span class="mosaic-filter-bar__label">Blur</span>' +
          '<input type="range" min="0" max="' + MAX_BLUR + '" step="1" value="' + sceneState.blurAmount + '" data-action="blur-slider" aria-label="Mosaic blur amount (pixels)" />' +
          '<span class="mosaic-filter-bar__label" data-action="blur-readout">' + sceneState.blurAmount + "px</span>" +
        "</span>" +
        '<button type="button" class="mosaic-filter-bar__button ' + (on ? "mosaic-filter-bar__button--active" : "") + '" data-action="toggle-active" title="Toggle mosaic on this scene">' +
          (on ? "✓ Active" : "⏸ Off") +
        "</button>" +
        '<button type="button" class="mosaic-filter-bar__button ' + (follow ? "mosaic-filter-bar__button--active" : "") + '" data-action="toggle-follow" title="When on, the rectangle follows the cursor. Drag is disabled in this mode.">' +
          (follow ? "🎯 Follow" : "🎯 Follow") +
        "</button>" +
        '<button type="button" class="mosaic-filter-bar__button" data-action="reset-defaults" title="Reset this scene\'s mosaic to defaults">' +
          "↺ Reset" +
        "</button>" +
        '<button type="button" class="mosaic-filter-bar__button" data-action="close-bar" title="Hide the control bar (the rectangle stays if it is active)" aria-label="Close controls">' +
          "✕" +
        "</button>" +
      "</span>";
  }

  // Position the rectangle based on the current sceneState and player size.
  // Cheap; safe to call on every pointer move.
  function renderRect() {
    if (!rect || !player || !sceneState) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return; // player not yet visible
    rect.style.left = (sceneState.xPct * pw) + "px";
    rect.style.top = (sceneState.yPct * ph) + "px";
    rect.style.width = (sceneState.widthPct * pw) + "px";
    rect.style.height = (sceneState.heightPct * ph) + "px";
    rect.style.setProperty("--mf-blur", sceneState.blurAmount + "px");
    rect.classList.toggle("mosaic-filter-rectangle--hidden", !sceneState.active);
  }

  function render() {
    renderRect();
    renderBar();
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  function teardown() {
    if (pendingSliderSaveTimer) {
      clearTimeout(pendingSliderSaveTimer);
      pendingSliderSaveTimer = null;
    }
    if (followSaveTimer) {
      clearTimeout(followSaveTimer);
      followSaveTimer = null;
    }
    detachFollowListener();
    if (rect && rect.parentElement) rect.parentElement.removeChild(rect);
    if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
    rect = null;
    resizeHandle = null;
    bar = null;
    player = null;
    // Reset the collapse preference so the next scene starts expanded.
    barCollapsed = false;
    // Drop the stale cursor position; the next scene gets a fresh one.
    lastPointer = null;
  }

  function setupPanel(targetPlayer) {
    const id = getSceneIdFromUrl();
    if (!id) {
      // Not on a scene page; clean up if we were on one.
      if (currentSceneId !== null) {
        teardown();
        currentSceneId = null;
        sceneState = null;
      }
      return;
    }

    // If the player changed (React re-mounted it), drop old children.
    if (player !== targetPlayer) {
      teardown();
    }

    // If the same scene is still up and we already have the overlay, just
    // re-render (handles window resize).
    if (currentSceneId === id && rect && bar) {
      render();
      return;
    }

    // New scene visit: load fresh config, mount, render.
    currentSceneId = id;

    // Load state and build UI. We re-query the player in the .then below
    // because React may have replaced the player element while we were
    // awaiting the config read; appending to a stale node would silently
    // lose the overlay.
    Promise.resolve()
      .then(function () { return loadState(id); })
      .then(function () {
        if (currentSceneId !== id) {
          // User navigated again while we were loading; the next
          // PathElementListener invocation will handle it.
          return;
        }
        if (mountOnPlayer()) {
          render();
        }
      });
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
    // If the user re-enters a scene with follow=true already saved, snap
    // the rectangle to the cursor so they don't see a jump from the saved
    // location to the cursor on the next pointermove.
    if (sceneState && sceneState.follow) {
      snapRectToPointer();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pointer interactions on the rectangle (drag + resize)
  // ---------------------------------------------------------------------------

  function onRectPointerDown(e) {
    if (!sceneState) return;
    if (e.button !== undefined && e.button !== 0) return; // primary button only
    // In follow mode the rectangle is anchored to the cursor already, so
    // dragging it is redundant and would just fight the follow handler.
    // Resize still works.
    if (sceneState.follow && e.target.dataset.action !== "rect-resize") {
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
      startXPct: sceneState.xPct,
      startYPct: sceneState.yPct,
      startWPct: sceneState.widthPct,
      startHPct: sceneState.heightPct,
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
    if (!dragState || !sceneState) return;
    const pw = dragState.pw;
    const ph = dragState.ph;
    if (!pw || !ph) return;
    const dxPct = (e.clientX - dragState.startX) / pw;
    const dyPct = (e.clientY - dragState.startY) / ph;
    if (dragState.type === "drag") {
      sceneState.xPct = clamp(dragState.startXPct + dxPct, 0, 1 - sceneState.widthPct);
      sceneState.yPct = clamp(dragState.startYPct + dyPct, 0, 1 - sceneState.heightPct);
    } else {
      // Resize: bottom-right anchor. The rectangle grows toward the cursor.
      const newW = clamp(dragState.startWPct + dxPct, MIN_SIZE_PCT, 1 - sceneState.xPct);
      const newH = clamp(dragState.startHPct + dyPct, MIN_SIZE_PCT, 1 - sceneState.yPct);
      sceneState.widthPct = newW;
      sceneState.heightPct = newH;
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
  // Bar interactions (click delegation + input for the slider)
  // ---------------------------------------------------------------------------

  function onBarClick(e) {
    if (!sceneState) return;
    const target = e.target.closest("[data-action]");
    if (!target || !bar || !bar.contains(target)) return;
    const action = target.dataset.action;
    switch (action) {
      case "toggle-bar":
        // Clicking the chip toggles the controls' visibility.
        barCollapsed = !barCollapsed;
        bar.classList.toggle("mosaic-filter-bar--collapsed", barCollapsed);
        e.preventDefault();
        break;
      case "toggle-active":
        sceneState.active = !sceneState.active;
        queueSave();
        renderBar();
        renderRect();
        break;
      case "toggle-follow":
        sceneState.follow = !sceneState.follow;
        queueSave();
        renderBar();
        // Snap the rectangle to the current cursor position so the user
        // doesn't see a "jump" from the saved location to the cursor on the
        // next pointermove.
        if (sceneState.follow) snapRectToPointer();
        break;
      case "reset-defaults": {
        // Replace this scene's entry with a copy of the current defaults.
        const fresh = sanitizeSceneEntry({ ...state.defaults });
        state.scenes[currentSceneId] = fresh;
        sceneState = fresh;
        queueSave();
        render();
        break;
      }
      case "close-bar":
        barCollapsed = true;
        bar.classList.add("mosaic-filter-bar--collapsed");
        break;
      default:
        break;
    }
  }

  function onBarInput(e) {
    if (!sceneState) return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "blur-slider") return;
    const value = clamp(parseInt(target.value, 10) || 0, 0, MAX_BLUR);
    sceneState.blurAmount = value;
    rect.style.setProperty("--mf-blur", value + "px");
    const readout = bar.querySelector('[data-action="blur-readout"]');
    if (readout) readout.textContent = value + "px";
    // Throttle saves during dragging the slider; commit on pointerup / change
    // via the `change` event below.
    const now = Date.now();
    if (now - lastSliderSaveAt >= SLIDER_DEBOUNCE_MS) {
      lastSliderSaveAt = now;
      queueSave();
    } else if (!pendingSliderSaveTimer) {
      pendingSliderSaveTimer = setTimeout(function () {
        pendingSliderSaveTimer = null;
        lastSliderSaveAt = Date.now();
        queueSave();
      }, SLIDER_DEBOUNCE_MS);
    }
  }

  function onBarChange(e) {
    if (!sceneState) return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "blur-slider") return;
    // Final commit on slider release.
    if (pendingSliderSaveTimer) {
      clearTimeout(pendingSliderSaveTimer);
      pendingSliderSaveTimer = null;
    }
    lastSliderSaveAt = Date.now();
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
  //
  // When sceneState.follow is true, the rectangle's center tracks the cursor
  // position. The pointermove listener is attached to the player (not the
  // document) so the rectangle only follows while the cursor is over the
  // video; once the cursor leaves, the rectangle stays at its last position.
  // The last known cursor position is stored in `lastPointer` so that
  // toggling Follow on (or mounting the overlay mid-follow) snaps the
  // rectangle to where the cursor currently is, avoiding a visible jump.
  // ---------------------------------------------------------------------------

  let lastPointer = null; // { x: number, y: number } in client coordinates

  function onPlayerPointerMove(e) {
    // Always record the latest cursor position over the player, so that
    // toggling Follow on later snaps to the right spot.
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!sceneState || !sceneState.follow) return;
    if (dragState) return; // a drag/resize is in progress; let it own the position
    if (!player || !rect) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    const pr = player.getBoundingClientRect();
    // Center of rectangle should land on the cursor.
    const halfWPct = sceneState.widthPct / 2;
    const halfHPct = sceneState.heightPct / 2;
    // Convert cursor (client coords) → fraction of player.
    const cursorXPct = (e.clientX - pr.left) / pw;
    const cursorYPct = (e.clientY - pr.top) / ph;
    sceneState.xPct = clamp(cursorXPct - halfWPct, 0, 1 - sceneState.widthPct);
    sceneState.yPct = clamp(cursorYPct - halfHPct, 0, 1 - sceneState.heightPct);
    renderRect();
    // Save is throttled to one write per animation frame to avoid hammering
    // csLib on every pointermove. queuedByFollowSave tracks the pending timer.
    scheduleFollowSave();
  }

  let followSaveTimer = null;
  function scheduleFollowSave() {
    if (followSaveTimer) return;
    followSaveTimer = setTimeout(function () {
      followSaveTimer = null;
      queueSave();
    }, 120);
  }

  // Snap the rectangle to the last known cursor position (or to the center
  // of the player if no cursor position has been recorded yet). Used when
  // the user toggles Follow on so the rectangle doesn't visibly jump from
  // its saved location to the cursor on the next pointermove.
  function snapRectToPointer() {
    if (!player || !rect || !sceneState) return;
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
    sceneState.xPct = clamp(cursorXPct - sceneState.widthPct / 2, 0, 1 - sceneState.widthPct);
    sceneState.yPct = clamp(cursorYPct - sceneState.heightPct / 2, 0, 1 - sceneState.heightPct);
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
    const id = getSceneIdFromUrl();
    if (!id) return;
    const p = document.querySelector("#VideoJsPlayer");
    if (p) setupPanel(p);
  }

  // Primary: re-injects whenever the player element appears in the DOM.
  csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel);

  // Safety net: also re-inject on SPA navigation, in case the player element
  // is still in the DOM but the scene id changed (React re-rendered the page
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
})();
