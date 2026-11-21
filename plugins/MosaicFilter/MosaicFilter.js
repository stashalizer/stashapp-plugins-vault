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
 * - Shared constants and pure functions (FALLBACK_DEFAULTS, clamp, etc.) live
 *   in MosaicFilterShared.js, which MUST be loaded first per the manifest.
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

  const CONFIG_KEY = window.MosaicFilterShared.CONFIG_KEY;
  const FALLBACK_DEFAULTS = window.MosaicFilterShared.FALLBACK_DEFAULTS;
  const MIN_SIZE_PCT = window.MosaicFilterShared.MIN_SIZE_PCT;
  const MAX_BLUR = window.MosaicFilterShared.MAX_BLUR;
  const storage = window.MosaicFilterStorage || {
    loadConfig: function () { return csLib.getConfiguration(CONFIG_KEY).then(function (v) { return v || {}; }); },
    saveConfig: function (value) { return csLib.setConfiguration(CONFIG_KEY, value); },
  };

  // ---------------------------------------------------------------------------
  // Utilities (from shared module MosaicFilterShared.js)
  // ---------------------------------------------------------------------------

  var clamp = window.MosaicFilterShared.clamp;
  var isFiniteNumber = window.MosaicFilterShared.isFiniteNumber;
  var makeDefaultState = window.MosaicFilterShared.makeDefaultState;
  var makeDefaultConfig = window.MosaicFilterShared.makeDefaultConfig;
  var mergeStored = window.MosaicFilterShared.mergeStored;
  var sanitizeState = window.MosaicFilterShared.sanitizeState;
  var normalizeConfig = window.MosaicFilterShared.normalizeConfig;
  var resolveState = window.MosaicFilterShared.resolveState;
  var makePreset = window.MosaicFilterShared.makePreset;
  var presetSource = window.MosaicFilterShared.presetSource;

  // Module-level state. `config` owns the persisted layers (default + scene
  // and studio presets); `state` is the effective flat state for the current
  // scene. Every user edit updates the effective layer and then persists.
  let config = makeDefaultConfig();
  let state = makeDefaultState();
  let context = { sceneId: null, studioId: null, source: "default" };
  let studioLookupToken = 0;
  let pixelLoopActive = false;
  let pixelVideoFrameCallback = null;

  // Cached DOM references and geometry for the pixelation loop. The video
  // frame callback runs up to 60x/second, and every `querySelector` or
  // `clientWidth` read in there lands on the main thread — so the canvas,
  // its 2D context and the video element are resolved once per mount, and
  // the rect size is derived from state (see `renderRect`) instead of
  // measured. Nothing in the frame path touches the DOM query API or forces
  // a layout any more.
  let pixelCanvasEl = null;
  let pixelCanvasCtx = null;
  let pixelVideoEl = null;
  let rectW = 0;
  let rectH = 0;

  // Coalesced-render flag. Pointer events arrive faster than the compositor
  // paints (a 125 Hz mouse delivers several per frame), so renders are
  // batched into at most one per animation frame.
  let renderScheduled = false;
  // Follow mode: the latest cursor position still waiting to be turned into
  // rect percentages. Resolved inside the scheduled render, not in the event
  // handler.
  let pendingFollow = null;

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
  // Persistence (Suite Data preferred; csLib fallback)
  // ---------------------------------------------------------------------------

  function applyEffectiveChange() {
    const preset = makePreset(state);
    if (context.source === "scene" && context.sceneId) {
      config.scenePresets[String(context.sceneId)] = preset;
    } else if (context.source === "studio" && context.studioId) {
      config.studioPresets[String(context.studioId)] = preset;
    } else {
      config.default = preset;
    }
  }

  async function persistConfig() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    try {
      await storage.saveConfig(config, function (latest) {
        const normalized = normalizeConfig(latest);
        // Keep the newest revision's maps, then overlay this tab's current
        // effective layer. Presets for other scenes/studios survive.
        return {
          default: config.default,
          scenePresets: Object.assign({}, normalized.scenePresets, config.scenePresets),
          studioPresets: Object.assign({}, normalized.studioPresets, config.studioPresets),
        };
      }, "Mosaic Filter overlay");
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

  async function saveNow() {
    applyEffectiveChange();
    await persistConfig();
  }

  async function resolveStudioId(sceneId) {
    if (!sceneId || !window.PluginApi || !window.PluginApi.utils || !window.PluginApi.utils.StashService) {
      return null;
    }
    const client = window.PluginApi.utils.StashService.getClient();
    if (!client) return null;
    try {
      const result = await client.query({
        query: window.PluginApi.GQL.FindSceneDocument,
        variables: { id: String(sceneId) },
        fetchPolicy: "no-cache",
      });
      const scene = result && result.data && result.data.findScene;
      return scene && scene.studio ? String(scene.studio.id) : null;
    } catch (err) {
      console.warn("MosaicFilter: studio lookup failed", err);
      return null;
    }
  }

  async function loadState() {
    let stored = null;
    try {
      stored = await storage.loadConfig();
    } catch (err) {
      console.error("MosaicFilter: failed to read configuration", err);
      stored = null;
    }
    config = normalizeConfig(stored);
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    context.sceneId = match ? match[1] : null;
    const token = ++studioLookupToken;
    const studioId = await resolveStudioId(context.sceneId);
    if (token === studioLookupToken) {
      context.studioId = studioId;
    }
    context.source = presetSource(config, context.sceneId, context.studioId);
    state = resolveState(config, context.sceneId, context.studioId);
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
    r.setAttribute("data-mosaic-filter-ui", "true");

    // The pixelation canvas is wrapped in a shadow root ON PURPOSE.
    //
    // Stash's SceneVideoFilterPanel resolves the element it styles with
    // `container.getElementsByTagName("canvas")` and only falls back to
    // <video> when that returns nothing. A light-DOM canvas anywhere inside
    // #VideoJsPlayer therefore swallows every Filters-panel transform
    // (rotate, scale, brightness, contrast...): the panel writes its inline
    // `style` to this hidden 0x0 canvas instead of the video, so the panel
    // looks completely broken even though the video is untouched.
    //
    // getElementsByTagName does not cross shadow boundaries, so keeping the
    // canvas in a shadow tree keeps the panel working while the canvas still
    // renders, paints and measures normally. Do not "simplify" this back to a
    // direct child of the rectangle.
    const surface = document.createElement("div");
    surface.className = "mosaic-filter-rectangle__pixel-surface";
    const shadow = surface.attachShadow({ mode: "open" });
    const canvas = document.createElement("canvas");
    canvas.className = "mosaic-filter-rectangle__pixel-canvas";
    canvas.setAttribute("aria-hidden", "true");
    // Inline: the plugin stylesheet cannot reach into the shadow tree.
    canvas.style.cssText =
      "display:block;width:100%;height:100%;image-rendering:pixelated;" +
      "image-rendering:crisp-edges;";
    shadow.appendChild(canvas);
    r.appendChild(surface);

    pixelCanvasEl = canvas;

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
    b.setAttribute("data-mosaic-filter-ui", "true");
    return b;
  }

  function renderBar() {
    if (!bar) return;
    const on = !!state.active;
    const follow = !!state.follow;
    const shape = state.shape;
    const mode = state.mode;
    const fill = state.fill;
    const sourceLabel = context.source === "scene" ? "Scene preset" : context.source === "studio" ? "Studio preset" : "Default";
    const hasPreset = context.source !== "default";
    bar.classList.toggle("mosaic-filter-bar--collapsed", barCollapsed);
    bar.innerHTML =
      `<span class="mosaic-filter-bar__chip" data-action="toggle-bar" title="Hide controls · ${sourceLabel}">` +
        `🔲 Mosaic ${on ? "ON" : "OFF"} · ${sourceLabel}` +
      `</span>` +
      `<span class="mosaic-filter-bar__controls">` +
        `<span class="mosaic-filter-bar__slider">` +
          `<span class="mosaic-filter-bar__label">Blur</span>` +
          `<input type="range" min="0" max="${MAX_BLUR}" step="1" value="${state.blurAmount}" data-action="blur-slider" aria-label="Mosaic blur amount (pixels)" />` +
          `<span class="mosaic-filter-bar__label" data-action="blur-readout">${state.blurAmount}px</span>` +
        `</span>` +
        `<button type="button" class="mosaic-filter-bar__button ${on ? "mosaic-filter-bar__button--active" : ""}" data-action="toggle-active" title="Toggle the mosaic on or off">` +
          `${on ? "✓ Active" : "⏸ Off"}` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button ${follow ? "mosaic-filter-bar__button--active" : ""}" data-action="toggle-follow" title="When on, the rectangle follows the cursor. Drag is disabled in this mode.">` +
          `🎯 Follow` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button mosaic-filter-bar__button--active" data-action="toggle-shape" title="${shape === "ellipse" ? "Shape: ellipse. Click to switch to rectangle." : "Shape: rectangle. Click to switch to ellipse."}">` +
          `${shape === "ellipse" ? "● Ellipse" : "▭ Rectangle"}` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button mosaic-filter-bar__button--active" data-action="toggle-mode" title="${mode === "reverse" ? "Mode: reverse — hide outside the filter. Click to switch to normal." : "Mode: normal — hide inside the filter. Click to switch to reverse."}">` +
          `${mode === "reverse" ? "◈ Reverse" : "▣ Normal"}` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button mosaic-filter-bar__button--active" data-action="cycle-fill" title="Fill mode: ${fill}. Click to cycle blur → solid → pixelate.">` +
          `${fill === "solid" ? "■ Solid" : fill === "pixelate" ? "▦ Pixelate" : "◌ Blur"}` +
        `</button>` +
        (fill === "solid"
          ? `<input type="color" value="${state.fillColor}" data-action="fill-color" title="Solid fill colour" aria-label="Solid fill colour" />`
          : "") +
        `<button type="button" class="mosaic-filter-bar__button" data-action="save-scene-preset" title="Save the current filter as a preset for this scene" ${context.sceneId ? "" : "disabled"}>` +
          `Save scene` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button" data-action="save-studio-preset" title="Save the current filter as a preset for this studio" ${context.studioId ? "" : "disabled"}>` +
          `Save studio` +
        `</button>` +
        (hasPreset
          ? `<button type="button" class="mosaic-filter-bar__button" data-action="clear-preset" title="Remove the preset for this scene/studio">Clear preset</button>`
          : "") +
        `<button type="button" class="mosaic-filter-bar__button" data-action="reset-defaults" title="Reset the current filter to defaults">` +
          `↺ Reset` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button" data-action="screenshot" title="Copy or download a redacted screenshot of the current frame">` +
          `📷 Shot` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button" data-action="panic" title="Show a neutral local reference page (Ctrl+Shift+X to toggle)">` +
          `⛔ Panic` +
        `</button>` +
        `<button type="button" class="mosaic-filter-bar__button" data-action="close-bar" title="Hide the control bar (the rectangle stays if it is active)" aria-label="Close controls">` +
          `✕` +
        `</button>` +
      `</span>`;
  }

  // Position the rectangle based on the current state and player size.
  // All layout reads happen before the first style write, so a render never
  // forces a synchronous reflow. Pointer handlers do not call this directly —
  // they go through `scheduleRender` to batch a burst of events into one
  // render per animation frame. Direct calls are for discrete state changes
  // (toggle, colour change, resize, mount).
  function renderRect() {
    if (!rect || !player) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    // Single layout read at the top: both handlers below reuse these values
    // instead of re-measuring. Reading after the style writes would force a
    // synchronous reflow on every pointer move.
    const left = state.xPct * pw;
    const top = state.yPct * ph;
    const w = state.widthPct * pw;
    const h = state.heightPct * ph;
    // `.mosaic-filter-rectangle` is `box-sizing: border-box` with a 1px
    // border, so these run 2px above the real `clientWidth`/`clientHeight`.
    // That only shifts the canvas backing-store aspect ratio by at most one
    // cell, and the canvas is stretched to `width/height: 100%` anyway — the
    // pixels themselves are blocky by design. In exchange the per-frame
    // pixelation loop never has to read layout.
    rectW = w;
    rectH = h;
    rect.style.left = left + "px";
    rect.style.top = top + "px";
    rect.style.width = w + "px";
    rect.style.height = h + "px";
    player.style.setProperty("--mf-blur", state.blurAmount + "px");
    player.style.setProperty("--mf-fill-color", state.fillColor);
    rect.classList.toggle("mosaic-filter-rectangle--hidden", !state.active);
    rect.classList.toggle("mosaic-filter-rectangle--ellipse", state.shape === 'ellipse');
    rect.classList.toggle("mosaic-filter-rectangle--reverse", state.mode === 'reverse');
    rect.classList.toggle("mosaic-filter-rectangle--fill-solid", state.fill === 'solid');
    rect.classList.toggle("mosaic-filter-rectangle--fill-pixelate", state.fill === 'pixelate');
    updateMask(pw, ph);
    syncPixelCanvas();
  }

  // Pointer handlers fire many times per painted frame; collapsing them into
  // one rAF means one style recalc per frame instead of one per event. The
  // latest state always wins, so intermediate positions are not worth a
  // render.
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(function () {
      renderScheduled = false;
      // Resolve the queued cursor position first: at the top of a rAF
      // callback the previous frame's styles have already been laid out, so
      // these reads are cheap. Doing it in the pointer handler instead would
      // read layout right after our own writes — a forced reflow per event.
      applyPendingFollow();
      renderRect();
    });
  }

  // Turn the queued cursor position into rect percentages. Runs at the top of
  // the scheduled render, before any style write in this frame.
  function applyPendingFollow() {
    const p = pendingFollow;
    pendingFollow = null;
    if (!p || !state.follow || dragState) return;
    if (!player || !rect) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    const pr = player.getBoundingClientRect();
    state.xPct = clamp((p.x - pr.left) / pw - state.widthPct / 2, 0, 1 - state.widthPct);
    state.yPct = clamp((p.y - pr.top) / ph - state.heightPct / 2, 0, 1 - state.heightPct);
  }

  // Update the reverse-mode mask layer position, size, and shape to match
  // the current state. The hole is cut out via `clip-path: path()` with TWO
  // separate subpaths (outer player rect + inner hole shape). The previous
  // approach used `clip-path: polygon(...)` with 8 points for the rectangle
  // and `mask-image` + `mask-composite: subtract` for the ellipse; both
  // approaches were broken:
  //
  //   1. The 8-point polygon closed from the last inner point diagonally
  //      back to the first outer point, making the path self-intersecting.
  //      Under the nonzero fill rule, the L-shaped area (left of and above
  //      the filter) ended up outside the clip, so the backdrop-filter
  //      didn't apply there and the video stayed clear.
  //
  //   2. `mask-composite: subtract` (and its `-webkit-` prefix equivalent)
  //      has inconsistent browser support — some browsers compute the mask
  //      as fully transparent, making the whole mask layer invisible and
  //      so the backdrop-filter was never applied outside the bounding box
  //      either.
  //
  // `clip-path: path()` with two subpaths avoids both problems: the `Z M`
  // separator creates two non-self-intersecting subpaths. The CSS uses
  // `clip-rule: evenodd`, so the inner subpath becomes a hole regardless of
  // winding direction — the rule is "inside iff a ray from the point crosses
  // the path an odd number of times". A point inside the outer rect but
  // outside the inner shape crosses once (odd → inside → blurred). A point
  // inside both crosses twice (even → outside → clear). The path() function
  // is supported in Chrome 88+, Firefox 70+, and Safari 13.1+ — well within
  // Stash's bundled Chromium baseline.
  //
  // The mask layer is only meaningful when both `state.active` is true AND
  // `state.mode === 'reverse'`. If the user toggles the filter off while in
  // reverse mode, the mask layer must hide too — otherwise the entire player
  // is blurred with no clear area and no indicator. The `--hidden` class
  // collapses it to `display: none`, which overrides `--reverse`'s
  // `display: block`.
  function updateMask(pw, ph) {
    if (!maskLayer || !player) return;
    // Resizable callers pass the size they already measured; falling back to
    // a fresh read only happens for one-off callers.
    if (pw === undefined) pw = player.clientWidth;
    if (ph === undefined) ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    const leftPx = state.xPct * pw;
    const topPx = state.yPct * ph;
    const wPx = Math.max(state.widthPct * pw, 1);
    const hPx = Math.max(state.heightPct * ph, 1);

    let innerD;
    if (state.shape === 'ellipse') {
      const cx = leftPx + wPx / 2;
      const cy = topPx + hPx / 2;
      const rx = wPx / 2;
      const ry = hPx / 2;
      // Full ellipse as two half-arcs. Direction: 9 → 6 → 3 → 12 → 9
      // (left → bottom → right → top → left, counter-clockwise visually).
      //   First arc: leftmost → rightmost via the BOTTOM.
      //     angles 180° → 90° → 0° (decreasing) → sweep-flag 0
      //   Second arc: rightmost → leftmost via the TOP.
      //     angles 0° → -90° (=270°) → -180° (=180°) (decreasing) → sweep-flag 0
      // Both sweep-flags are 0 so the path traces a single closed loop.
      // (An earlier draft had sweep-flag 1 for the second arc, which would
      // route it through the BOTTOM too — producing a back-and-forth along
      // the lower half instead of a closed ellipse.)
      innerD = "M " + (cx - rx) + " " + cy +
               " A " + rx + " " + ry + " 0 0 0 " + (cx + rx) + " " + cy +
               " A " + rx + " " + ry + " 0 0 0 " + (cx - rx) + " " + cy +
               " Z";
    } else {
      // Inner rectangle traced counter-clockwise: TL → BL → BR → TR → close.
      innerD = "M " + leftPx + " " + topPx +
               " L " + leftPx + " " + (topPx + hPx) +
               " L " + (leftPx + wPx) + " " + (topPx + hPx) +
               " L " + (leftPx + wPx) + " " + topPx +
               " Z";
    }
    // Outer player rectangle traced clockwise: TL → TR → BR → BL → close.
    // Winding: clockwise outer (+1) + counter-clockwise inner (-1) = frame
    // with a hole under both the nonzero and evenodd clip rules (the CSS
    // uses evenodd, which is more forgiving of winding direction).
    const outerD = "M 0 0 L " + pw + " 0 L " + pw + " " + ph + " L 0 " + ph + " Z";
    maskLayer.style.clipPath = "path('" + outerD + " " + innerD + "')";

    const reverseOn = state.active && state.mode === 'reverse';
    maskLayer.classList.toggle('mosaic-filter-mask-layer--reverse', reverseOn);
    maskLayer.classList.toggle('mosaic-filter-mask-layer--hidden', !state.active);
    maskLayer.classList.toggle('mosaic-filter-mask-layer--fill-solid', reverseOn && state.fill === 'solid');
    maskLayer.classList.toggle('mosaic-filter-mask-layer--fill-blur', reverseOn && state.fill === 'blur');
  }

  function getVideoElement() {
    if (!player) return null;
    // Reuse the cached node while it is still in the document; a React
    // re-render that swaps the <video> without swapping the player element
    // detaches the old one, which `isConnected` catches without a query.
    if (pixelVideoEl && pixelVideoEl.isConnected) return pixelVideoEl;
    pixelVideoEl = player.querySelector("video");
    return pixelVideoEl;
  }

  // The pixel canvas is created by `buildRect` and lives inside a shadow root,
  // so it can no longer be found through `rect.querySelector` — the reference
  // is captured at build time instead. `isConnected` walks the shadow-including
  // tree, so it still detects a canvas dropped with its host on teardown.
  function getPixelCanvas() {
    if (pixelCanvasEl && !pixelCanvasEl.isConnected) {
      pixelCanvasEl = null;
      pixelCanvasCtx = null;
    }
    return pixelCanvasEl;
  }

  function stopPixelLoop() {
    pixelLoopActive = false;
    const video = getVideoElement();
    if (pixelVideoFrameCallback && video && video.cancelVideoFrameCallback) {
      try { video.cancelVideoFrameCallback(pixelVideoFrameCallback); } catch (_) { /* ignore */ }
    }
    pixelVideoFrameCallback = null;
  }

  function drawPixelFrame() {
    const canvas = getPixelCanvas();
    const video = getVideoElement();
    if (!canvas || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    // `rectW`/`rectH` are maintained by renderRect, so this no longer reads
    // layout inside the frame callback.
    if (rectW <= 0 || rectH <= 0) return;
    const step = Math.max(4, state.pixelSize);
    const width = Math.max(4, Math.floor(rectW / step));
    const height = Math.max(4, Math.floor(rectH / step));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (!pixelCanvasCtx) pixelCanvasCtx = canvas.getContext("2d");
    const ctx = pixelCanvasCtx;
    if (!ctx) return;
    // Cover-crop the video into the filter region so the pixelated preview
    // does not stretch when the region has a different aspect ratio.
    const targetAspect = width / height;
    const sourceAspect = video.videoWidth / video.videoHeight;
    let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
    if (sourceAspect > targetAspect) {
      sw = video.videoHeight * targetAspect;
      sx = (video.videoWidth - sw) / 2;
    } else {
      sh = video.videoWidth / targetAspect;
      sy = (video.videoHeight - sh) / 2;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
  }

  function startPixelLoop() {
    if (pixelLoopActive) return;
    const video = getVideoElement();
    if (!video) return;
    pixelLoopActive = true;
    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = function () {
        if (!pixelLoopActive) return;
        drawPixelFrame();
        pixelVideoFrameCallback = video.requestVideoFrameCallback(onFrame);
      };
      pixelVideoFrameCallback = video.requestVideoFrameCallback(onFrame);
      return;
    }
    let last = 0;
    const tick = function (now) {
      if (!pixelLoopActive) return;
      if (!last || now - last > 80) {
        last = now;
        drawPixelFrame();
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }

  function syncPixelCanvas() {
    const canvas = getPixelCanvas();
    if (!canvas) return;
    const on = state.active && state.fill === "pixelate" && state.mode === "normal";
    // Guarded write: `renderRect` runs up to once per frame while dragging,
    // and re-assigning an unchanged value still walks the CSSOM.
    const nextDisplay = on ? "block" : "none";
    if (canvas.style.display !== nextDisplay) canvas.style.display = nextDisplay;
    if (on) {
      // The video-frame loop only repaints while the video is actually
      // presenting frames. `requestVideoFrameCallback` does not fire on a
      // paused video, and resizing the canvas backing store clears it — so a
      // drag over a paused video would leave a blank filter region unless we
      // paint here. Only skip the blit when the loop is guaranteed to
      // repaint on its own.
      const video = getVideoElement();
      const loopWillPaint = pixelLoopActive && video && !video.paused && !video.ended;
      if (!loopWillPaint) drawPixelFrame();
      startPixelLoop();
    } else {
      stopPixelLoop();
    }
  }

  function clipFilterRegion(ctx, x, y, w, h) {
    ctx.beginPath();
    if (state.shape === "ellipse") {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.clip();
  }

  function paintFilterEffect(ctx, video, x, y, w, h, canvasWidth, canvasHeight) {
    if (state.fill === "solid") {
      ctx.fillStyle = state.fillColor;
      ctx.fillRect(x, y, w, h);
      return;
    }
    if (state.fill === "pixelate") {
      const temp = document.createElement("canvas");
      temp.width = Math.max(2, Math.floor(w / Math.max(4, state.pixelSize)));
      temp.height = Math.max(2, Math.floor(h / Math.max(4, state.pixelSize)));
      const tctx = temp.getContext("2d");
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(video, 0, 0, canvasWidth, canvasHeight, 0, 0, temp.width, temp.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(temp, 0, 0, temp.width, temp.height, x, y, w, h);
      ctx.imageSmoothingEnabled = true;
      return;
    }
    ctx.filter = "blur(" + state.blurAmount + "px)";
    ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight, 0, 0, canvasWidth, canvasHeight);
    ctx.filter = "none";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function setScreenshotStatus(message) {
    if (!bar) return;
    const chip = bar.querySelector(".mosaic-filter-bar__chip");
    if (chip) chip.title = message;
  }

  function captureRedacted() {
    const video = getVideoElement();
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      setScreenshotStatus("Screenshot unavailable: video frame is not ready.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const pw = player.clientWidth || canvas.width;
    const ph = player.clientHeight || canvas.height;
    const x = state.xPct * pw * (canvas.width / pw);
    const y = state.yPct * ph * (canvas.height / ph);
    const w = state.widthPct * pw * (canvas.width / pw);
    const h = state.heightPct * ph * (canvas.height / ph);

    if (state.mode === "reverse") {
      const effect = document.createElement("canvas");
      effect.width = canvas.width;
      effect.height = canvas.height;
      const ectx = effect.getContext("2d");
      ectx.drawImage(video, 0, 0, canvas.width, canvas.height);
      paintFilterEffect(ectx, video, 0, 0, canvas.width, canvas.height, canvas.width, canvas.height);
      ctx.drawImage(effect, 0, 0);
      ctx.save();
      clipFilterRegion(ctx, x, y, w, h);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    } else {
      ctx.save();
      clipFilterRegion(ctx, x, y, w, h);
      paintFilterEffect(ctx, video, x, y, w, h, canvas.width, canvas.height);
      ctx.restore();
    }

    canvas.toBlob(function (blob) {
      if (!blob) {
        setScreenshotStatus("Screenshot failed.");
        return;
      }
      const filename = "scene-" + (context.sceneId || "frame") + "-redacted.png";
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(function () {
          setScreenshotStatus("Redacted screenshot copied.");
        }).catch(function () {
          downloadBlob(blob, filename);
          setScreenshotStatus("Clipboard unavailable; downloaded instead.");
        });
      } else {
        downloadBlob(blob, filename);
        setScreenshotStatus("Redacted screenshot downloaded.");
      }
    }, "image/png");
  }

  // ---------------------------------------------------------------------------
  // Panic screen
  // ---------------------------------------------------------------------------

  var panicEl = null;
  var panicActive = false;
  var panicPrevTitle = null;
  var panicPrevIcon = null;

  function buildPanicScreen() {
    const root = document.createElement("div");
    root.className = "mosaic-filter-panic";
    root.setAttribute("data-mosaic-filter-ui", "true");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Reference article");

    const page = document.createElement("article");
    page.className = "mosaic-filter-panic__article";
    const heading = document.createElement("h1");
    heading.textContent = "Reference article";
    page.appendChild(heading);
    const sub = document.createElement("p");
    sub.className = "mosaic-filter-panic__sub";
    sub.textContent = "From the reference collection";
    page.appendChild(sub);
    const body = document.createElement("p");
    body.textContent =
      "This page is a local, static placeholder. It is not connected to the network, does not load remote images, " +
      "and exists only to give the current tab a believable, neutral appearance.";
    page.appendChild(body);
    const body2 = document.createElement("p");
    body2.textContent =
      "Use the same shortcut to return to the previous view. Playback remains paused when the placeholder is dismissed.";
    page.appendChild(body2);
    root.appendChild(page);
    return root;
  }

  function togglePanicScreen() {
    if (panicActive) {
      if (panicEl && panicEl.parentElement) panicEl.parentElement.removeChild(panicEl);
      panicEl = null;
      panicActive = false;
      document.title = panicPrevTitle || document.title;
      if (panicPrevIcon) {
        panicPrevIcon.href = panicPrevIcon.__mosaicOriginal || panicPrevIcon.href;
      }
      document.body.classList.remove("mosaic-filter-panic-open");
      return;
    }
    const video = getVideoElement();
    if (video) {
      video.pause();
      video.muted = true;
    }
    panicPrevTitle = document.title;
    const icon = document.querySelector("link[rel='icon']");
    if (icon) {
      panicPrevIcon = icon;
      icon.__mosaicOriginal = icon.href;
      icon.href = "data:image/svg+xml," + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%23fff'/></svg>"
      );
    }
    document.title = "Reference article";
    panicEl = buildPanicScreen();
    document.body.appendChild(panicEl);
    document.body.classList.add("mosaic-filter-panic-open");
    panicActive = true;
  }

  function render() {
    renderRect();
    renderBar();
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  function teardown() {
    stopPixelLoop();
    if (panicActive) togglePanicScreen();
    detachFollowListener();
    if (rect && rect.parentElement) rect.parentElement.removeChild(rect);
    if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
    if (maskLayer && maskLayer.parentElement) maskLayer.parentElement.removeChild(maskLayer);
    rect = null;
    resizeHandle = null;
    bar = null;
    maskLayer = null;
    player = null;
    pixelCanvasEl = null;
    pixelCanvasCtx = null;
    pixelVideoEl = null;
    rectW = 0;
    rectH = 0;
    pendingFollow = null;
    // Note: barCollapsed is NOT reset here. It is re-derived in setupPanel
    // on the next fresh mount based on state.active, so the bar always
    // starts collapsed when the filter is off. The user's manual choice
    // within the current mount is remembered (handled by the barCollapsed
    // module variable surviving teardown).
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
      // pixelCanvasEl was captured by buildRect; the canvas is in a shadow
      // root, so it is neither re-queried here nor reachable from `rect`.
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

  async function setupPanel(targetPlayer) {
    if (player !== targetPlayer) {
      teardown();
    }
    const routeMatch = window.location.pathname.match(/\/scenes\/(\d+)/);
    const routeSceneId = routeMatch ? routeMatch[1] : null;
    if (rect && bar && context.sceneId !== routeSceneId) {
      // Same player element, different scene: drop the overlay and reload the
      // effective preset for the new scene.
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
    await loadState();
    // Fresh mount: default the bar to collapsed when the filter is
    // off, expanded when the filter is on. The user's manual choice
    // within the current mount is remembered (the barCollapsed module
    // variable is not reset in teardown; it is re-derived here on
    // every fresh mount so opening a scene with mosaic off starts
    // with the bar collapsed).
    barCollapsed = !state.active;
    if (mountOnPlayer()) {
      render();
    }
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
    const action = target?.dataset?.action;
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
    scheduleRender();
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
    saveNow();
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
        renderBar();
        e.preventDefault();
        break;
      case "toggle-active":
        state.active = !state.active;
        saveNow();
        renderBar();
        renderRect();
        break;
      case "toggle-follow":
        state.follow = !state.follow;
        if (state.follow) snapRectToPointer();
        saveNow();
        renderBar();
        break;
      case "toggle-shape":
        state.shape = state.shape === 'rectangle' ? 'ellipse' : 'rectangle';
        saveNow();
        render();
        break;
      case "toggle-mode":
        state.mode = state.mode === 'normal' ? 'reverse' : 'normal';
        saveNow();
        render();
        break;
      case "cycle-fill":
        state.fill = state.fill === 'blur' ? 'solid' : state.fill === 'solid' ? 'pixelate' : 'blur';
        saveNow();
        render();
        break;
      case "save-scene-preset":
        if (!context.sceneId) break;
        context.source = "scene";
        applyEffectiveChange();
        persistConfig();
        render();
        break;
      case "save-studio-preset":
        if (!context.studioId) break;
        context.source = "studio";
        applyEffectiveChange();
        persistConfig();
        render();
        break;
      case "clear-preset":
        if (context.source === "scene" && context.sceneId) {
          delete config.scenePresets[String(context.sceneId)];
        } else if (context.source === "studio" && context.studioId) {
          delete config.studioPresets[String(context.studioId)];
        }
        context.source = presetSource(config, context.sceneId, context.studioId);
        state = resolveState(config, context.sceneId, context.studioId);
        persistConfig();
        render();
        break;
      case "reset-defaults":
        Object.assign(state, makeDefaultState());
        saveNow();
        render();
        break;
      case "close-bar":
        barCollapsed = true;
        renderBar();
        break;
      case "screenshot":
        captureRedacted();
        break;
      case "panic":
        togglePanicScreen();
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
    if (target.dataset && target.dataset.action === "fill-color") {
      if (/^#[0-9a-fA-F]{6}$/.test(target.value)) {
        state.fillColor = target.value;
        saveNow();
        renderRect();
      }
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "blur-slider") return;
    // Slider release: persist the final blur amount. (State was already
    // updated by `input`; this just commits it to csLib.)
    saveNow();
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
    // Defer the geometry to the scheduled render — see applyPendingFollow.
    pendingFollow = lastPointer;
    scheduleRender();
  }

  /** Snap the rectangle to the last known cursor position and persist. */
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
    saveNow();
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

  // Panic shortcut: avoid single-key bindings that would collide with video
  // controls or other plugins. The local decoy page has no network requests.
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === "X" || e.key === "x")) {
      e.preventDefault();
      togglePanicScreen();
    }
  });

  // Re-position the rectangle on window resize so the percentages stay right.
  window.addEventListener("resize", function () {
    if (rect && player) renderRect();
  });

  // Best-effort: persist any in-memory changes before the page is hidden.
  // Async saves may not complete before the page unloads, but the request
  // is at least submitted.
  window.addEventListener("pagehide", function () {
    saveNow();
  });
})();
