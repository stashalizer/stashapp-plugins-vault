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
 * - UI surface is two-tier, deliberately quiet: a 28px pill in the bottom-right
 *   corner (clear of Stash's own control bar) is the only persistent chrome,
 *   and it fades out with the player chrome when the user goes idle. Every
 *   control lives in a popover that only opens on request — see renderChrome
 *   and setPanelOpen. Nothing is written to config about the panel's state.
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

  // Pill drag constants. Declared up here (not next to the drag functions)
  // because `pillPos` calls loadPillPos() at module init, and a `const` further
  // down would still be in its temporal dead zone at that point.
  const PILL_POS_KEY = "MosaicFilter.pillPos";
  // Pointer travel (px) before a press on the pill counts as a drag rather than
  // a click. The pill is the panel's disclosure button, so the click has to
  // survive a slightly shaky press.
  const PILL_DRAG_THRESHOLD_PX = 4;
  // Clicks that land on the player this long after a drag are swallowed, so the
  // release over the picture is not read by videojs as play/pause.
  const DRAG_CLICK_SWALLOW_MS = 400;
  // Keeps the pill and the panel off the frame's edges when they are free.
  const CHROME_INSET = 8;
  // Distance between the pill and the panel that follows it.
  const PILL_PANEL_GAP = 8;
  // Floor for a floating panel's height. Below this it still scrolls, but the
  // header and the first rows stay readable.
  const PANEL_MIN_H = 120;
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
  let maskLayer = null;

  // The chrome is the inset-0, pointer-events:none anchor that gives the pill,
  // the panel and the toast a positioning frame equal to the player box. Only
  // the pill and the panel accept pointer events.
  let chrome = null;
  let pill = null;
  let panel = null;
  let toastEl = null;
  // Cached after every panel rebuild because renderChrome() replaces the
  // panel's innerHTML wholesale.
  let statusEl = null;

  // Whether the settings panel is open. In-memory only and always false on a
  // fresh mount: opening a scene must never push a slab of controls over the
  // frame, however the filter was left last time.
  let panelOpen = false;

  // Last message written to the panel's status line. Kept module-level so a
  // panel rebuild (which drops the DOM node) does not lose it.
  let statusMessage = "";
  let toastTimer = null;

  // Inline SVG rather than emoji: emoji glyphs vary per platform (and render
  // in colour over the video), which is exactly what makes plugin chrome look
  // foreign next to video.js's monochrome icon font.
  const ICON_CHEVRON =
    '<svg class="mosaic-filter-pill__chevron" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
    '<path d="M2.75 4.75 6 8l3.25-3.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">' +
    '<path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  // Active pointer interaction. Either { type: "drag" } or { type: "resize" }.
  let dragState = null;

  // Where the pill was dragged to, as fractions of the chrome box (0..1).
  // `null` means "never dragged": the stylesheet's bottom-right anchor applies
  // untouched, which is also the only case where --mf-cb-h matters. Kept in
  // localStorage rather than in the plugin config — it is a per-browser UI
  // preference, not preset data (see the "Pill drag" section).
  let pillPos = loadPillPos();
  // Active pill drag: { id, grabX, grabY, startX, startY, moved, captured, geom }.
  let pillDrag = null;
  // Latest cursor position queued for the coalesced drag frame.
  let pillMovePoint = null;
  let pillMoveFrame = 0;
  // Set when a drag moved the pill, so the click pointerup produces does not
  // also toggle the panel.
  let suppressPillClick = false;
  // Timestamp until which a click on the picture is swallowed after a drag.
  let swallowClickUntil = 0;
  // Natural (uncapped) height of the panel, measured by placePanel. The drag
  // frame reuses it instead of measuring: with an inline max-height applied,
  // offsetHeight only reports the capped height.
  let panelNatH = 0;

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
    // children (the mask layer, the filter rectangle and the chrome anchor)
    // anchor to it.
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

  function buildChrome() {
    // Container: covers the player exactly, but is transparent to pointer
    // events. Everything the user can hit re-enables them individually.
    const root = document.createElement("div");
    root.className = "mosaic-filter-chrome";
    root.setAttribute("data-mosaic-filter-ui", "true");

    // The pill is built once and only restyled afterwards, so focus and
    // aria-expanded survive every state change.
    const p = document.createElement("button");
    p.type = "button";
    p.className = "mosaic-filter-pill";
    p.dataset.action = "toggle-panel";
    p.setAttribute("aria-expanded", "false");
    p.setAttribute("aria-controls", "mosaic-filter-panel");
    p.innerHTML =
      '<span class="mosaic-filter-pill__dot" aria-hidden="true"></span>' +
      '<span class="mosaic-filter-pill__label">Mosaic</span>' +
      ICON_CHEVRON;
    root.appendChild(p);

    const panelEl = document.createElement("div");
    panelEl.className = "mosaic-filter-panel";
    panelEl.id = "mosaic-filter-panel";
    // Non-modal: no focus trap, no aria-modal, Escape and click-outside close
    // it. `group` tells assistive tech it is a labelled cluster of controls
    // without promising dialog behaviour this element does not implement.
    panelEl.setAttribute("role", "group");
    panelEl.setAttribute("aria-label", "Mosaic filter");
    root.appendChild(panelEl);

    const toast = document.createElement("div");
    toast.className = "mosaic-filter-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    root.appendChild(toast);

    pill = p;
    panel = panelEl;
    toastEl = toast;
    return root;
  }

  function sourceLabel() {
    if (context.source === "scene") return "Scene preset";
    if (context.source === "studio") return "Studio preset";
    return "Global default";
  }

  function segmentedRow(action, current, options, label) {
    const buttons = options.map(function (opt) {
      const pressed = current === opt.value;
      return (
        '<button type="button" class="mosaic-filter-seg__btn" data-action="' + action +
        '" data-value="' + opt.value + '" aria-pressed="' + (pressed ? "true" : "false") + '"' +
        (opt.title ? ' title="' + opt.title + '"' : "") + ">" + opt.label + "</button>"
      );
    }).join("");
    return (
      '<div class="mosaic-filter-row">' +
        '<span class="mosaic-filter-row__label">' + label + "</span>" +
        '<div class="mosaic-filter-seg" role="group" aria-label="' + label + '">' + buttons + "</div>" +
      "</div>"
    );
  }

  function actionButton(action, label, disabled, title, variant) {
    return (
      '<button type="button" class="mosaic-filter-actions__btn' +
      (variant ? " mosaic-filter-actions__btn--" + variant : "") +
      '" data-action="' + action + '" title="' + title + '"' +
      (disabled ? " disabled" : "") + ">" + label + "</button>"
    );
  }

  // Panel contents. Rebuilt on every render; the pill is not, so the control
  // the user actually opens the panel with keeps its identity and focus.
  function panelMarkup() {
    const on = !!state.active;
    const follow = !!state.follow;
    const fill = state.fill;
    const hasPreset = context.source !== "default";
    return (
      '<div class="mosaic-filter-panel__header">' +
        '<span class="mosaic-filter-panel__title">Mosaic</span>' +
        '<span class="mosaic-filter-panel__source">' + sourceLabel() + "</span>" +
        '<button type="button" class="mosaic-filter-icon-btn" data-action="close-panel" ' +
          'aria-label="Close mosaic settings" title="Close (Esc)">' + ICON_CLOSE + "</button>" +
      "</div>" +

      '<div class="mosaic-filter-switches">' +
        '<button type="button" class="mosaic-filter-switch" data-action="toggle-active" ' +
          'aria-pressed="' + (on ? "true" : "false") + '" title="Show or hide the filter (Alt+M)">' +
          '<span class="mosaic-filter-switch__dot" aria-hidden="true"></span>' +
          (on ? "On" : "Off") +
        "</button>" +
        '<button type="button" class="mosaic-filter-switch" data-action="toggle-follow" ' +
          'aria-pressed="' + (follow ? "true" : "false") + '" ' +
          'title="Re-centre the filter on the pointer as it moves. Dragging is disabled in this mode.">' +
          '<span class="mosaic-filter-switch__dot" aria-hidden="true"></span>' +
          "Follow" +
        "</button>" +
      "</div>" +

      '<label class="mosaic-filter-slider">' +
        '<span class="mosaic-filter-slider__label">Blur</span>' +
        '<input class="mosaic-filter-slider__input" type="range" min="0" max="' + MAX_BLUR +
          '" step="1" value="' + state.blurAmount + '" data-action="blur-slider" ' +
          'aria-label="Mosaic blur amount in pixels" />' +
        '<span class="mosaic-filter-slider__value" data-action="blur-readout">' + state.blurAmount + "px</span>" +
      "</label>" +

      segmentedRow("set-fill", fill, [
        { value: "blur", label: "Blur" },
        { value: "solid", label: "Solid" },
        { value: "pixelate", label: "Pixelate", title: "Pixelate is the most expensive fill mode" },
      ], "Fill") +

      (fill === "solid"
        ? '<div class="mosaic-filter-row">' +
            '<span class="mosaic-filter-row__label">Colour</span>' +
            '<input type="color" class="mosaic-filter-color" data-action="fill-color" value="' +
              state.fillColor + '" aria-label="Solid fill colour" title="Solid fill colour" />' +
          "</div>"
        : "") +

      segmentedRow("set-shape", state.shape, [
        { value: "rectangle", label: "Rect" },
        { value: "ellipse", label: "Ellipse" },
      ], "Shape") +

      segmentedRow("set-mode", state.mode, [
        { value: "normal", label: "Normal", title: "Normal: the filter area is hidden" },
        { value: "reverse", label: "Reverse", title: "Reverse: everything outside the filter is hidden" },
      ], "Mode") +

      '<div class="mosaic-filter-actions">' +
        actionButton("save-scene-preset", "Save scene", !context.sceneId,
          "Store these settings as the preset for this scene") +
        actionButton("save-studio-preset", "Save studio", !context.studioId,
          "Store these settings as the preset for this studio") +
        (hasPreset
          ? actionButton("clear-preset", "Clear preset", false,
              "Remove the stored preset and fall back to the layer below", "danger")
          : "") +
        actionButton("reset-defaults", "Reset", false, "Restore the built-in defaults") +
        actionButton("screenshot", "Shot", false, "Copy or download a redacted screenshot of this frame") +
        actionButton("panic", "Panic", false, "Show a neutral local page (Ctrl+Shift+X)", "quiet") +
      "</div>" +

      '<div class="mosaic-filter-panel__status" role="status" aria-live="polite"></div>'
    );
  }

  // Remember which control had focus inside the panel so rebuilding its
  // innerHTML does not drop keyboard users back to the top of the document.
  function capturePanelFocus() {
    const el = document.activeElement;
    if (!el || !panel || !panel.contains(el) || !el.dataset || !el.dataset.action) return null;
    return { action: el.dataset.action, value: el.dataset.value || "" };
  }

  function restorePanelFocus(key) {
    if (!key || !panel) return;
    const selector =
      '[data-action="' + key.action + '"]' + (key.value ? '[data-value="' + key.value + '"]' : "");
    const el = panel.querySelector(selector);
    if (el && typeof el.focus === "function") {
      el.focus({ preventScroll: true });
    }
  }

  function renderChrome() {
    if (!chrome || !pill || !panel) return;
    const on = !!state.active;
    chrome.classList.toggle("mosaic-filter-chrome--on", on);
    // Reverse is only meaningful while the filter is live; gating the class on
    // `on` keeps the pill from advertising a state that is not applied.
    chrome.classList.toggle("mosaic-filter-chrome--reverse", on && state.mode === "reverse");
    chrome.classList.toggle("mosaic-filter-chrome--open", panelOpen);
    // An open panel is an explicit interaction, so it must not fade away when
    // video.js decides the user is idle.
    chrome.classList.toggle("mosaic-filter-chrome--pinned", panelOpen);

    pill.setAttribute("aria-expanded", panelOpen ? "true" : "false");
    pill.title =
      "Mosaic filter — " + (on ? "on" : "off") + " · " + sourceLabel() +
      " (drag to move · Alt+M toggles · Esc closes)";

    const focusKey = panelOpen ? capturePanelFocus() : null;
    panel.innerHTML = panelMarkup();
    statusEl = panel.querySelector(".mosaic-filter-panel__status");
    if (statusEl) statusEl.textContent = statusMessage;
    if (focusKey) restorePanelFocus(focusKey);
    // The panel's content just changed, so its height did too: a floating
    // panel has to be re-placed or it can end up half out of the frame.
    placeChrome();
  }

  // ---------------------------------------------------------------------------
  // Panel visibility + state feedback
  // ---------------------------------------------------------------------------

  function setPanelOpen(open) {
    if (panelOpen === open) return;
    // Keyboard users who close the panel from inside it must not be dropped
    // back to the top of the document; the pill is the disclosure control, so
    // that is where focus belongs.
    const returnFocus = !open && panel && panel.contains(document.activeElement);
    panelOpen = open;
    if (open) {
      // Stale text from a previous session reads as a current claim.
      statusMessage = "";
      document.addEventListener("pointerdown", onDocumentPointerDown, true);
    } else {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    }
    render();
    if (returnFocus && pill) {
      pill.focus({ preventScroll: true });
    }
  }

  function onDocumentPointerDown(e) {
    if (!panelOpen) return;
    const target = e.target;
    if (chrome && target && target.nodeType === 1 && chrome.contains(target)) return;
    setPanelOpen(false);
  }

  // Collapsed state has no room for a message, so the result of an action
  // goes to the panel's status line when it is open and to a transient toast
  // when it is not. One rule, applied consistently.
  function announce(message) {
    statusMessage = message;
    if (panelOpen) {
      if (statusEl) statusEl.textContent = message;
      return;
    }
    showToast(message);
  }

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("mosaic-filter-toast--visible");
    // Alt+M works while the chrome is faded out, and a `visibility: hidden`
    // ancestor would swallow both the toast and its live-region announcement.
    if (chrome) chrome.classList.add("mosaic-filter-chrome--toasting");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (toastEl) toastEl.classList.remove("mosaic-filter-toast--visible");
      if (chrome) chrome.classList.remove("mosaic-filter-chrome--toasting");
    }, 1600);
  }

  function toggleActive() {
    state.active = !state.active;
    saveNow();
    render();
    announce(
      state.active
        ? "Mosaic filter on" + (state.mode === "reverse" ? " · reverse" : "")
        : "Mosaic filter off"
    );
  }

  // The pill sits just above Stash's control bar, so its offset has to come
  // from the bar's real height rather than a guessed constant. Measured on
  // mount, on resize, on fullscreen change — never in a per-frame path.
  function syncPlayerMetrics() {
    if (!player) return;
    const controlBar = player.querySelector(".vjs-control-bar");
    const height = controlBar ? Math.round(controlBar.getBoundingClientRect().height) : 0;
    // With no control bar (controls disabled) hug the bottom edge instead of
    // reserving space for nothing.
    player.style.setProperty("--mf-cb-h", (height > 0 ? height : 8) + "px");
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
    // Show the region's full outline (edge + resize grip) while the panel is
    // open: the user is editing geometry, so the boundary has to be visible.
    rect.classList.toggle("mosaic-filter-rectangle--editing", panelOpen);
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
    if (!p || !state.follow || dragState || pillDrag) return;
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
    // Never a silent failure: the result of a Shot goes to the panel's status
    // line when it is open and to the toast when it is not.
    announce(message);
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
    renderChrome();
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  function teardown() {
    stopPixelLoop();
    if (panicActive) togglePanicScreen();
    detachFollowListener();
    // A pill drag in flight would keep its document listeners and its pending
    // frame alive after the node is detached.
    if (pillDrag) {
      document.removeEventListener("pointermove", onPillPointerMove);
      document.removeEventListener("pointerup", onPillPointerUp);
      document.removeEventListener("pointercancel", onPillPointerUp);
      pillDrag = null;
    }
    if (pillMoveFrame) {
      window.cancelAnimationFrame(pillMoveFrame);
      pillMoveFrame = 0;
    }
    pillMovePoint = null;
    suppressPillClick = false;
    swallowClickUntil = 0;
    panelNatH = 0;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    if (rect && rect.parentElement) rect.parentElement.removeChild(rect);
    if (maskLayer && maskLayer.parentElement) maskLayer.parentElement.removeChild(maskLayer);
    if (chrome && chrome.parentElement) chrome.parentElement.removeChild(chrome);
    rect = null;
    resizeHandle = null;
    maskLayer = null;
    chrome = null;
    pill = null;
    panel = null;
    toastEl = null;
    statusEl = null;
    player = null;
    pixelCanvasEl = null;
    pixelCanvasCtx = null;
    pixelVideoEl = null;
    rectW = 0;
    rectH = 0;
    pendingFollow = null;
    // The panel is never carried across mounts: a new scene starts collapsed.
    panelOpen = false;
    statusMessage = "";
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
    if (!chrome) {
      chrome = buildChrome();
      player.appendChild(chrome);
      attachChromeListeners();
      syncPlayerMetrics();
      // video.js may still be building its control bar on the first mount;
      // re-measure once it has settled so the pill does not sit under it. The
      // second pass also places a dragged pill: the chrome can still be 0x0 at
      // the first render (a player revealed a frame later), and then the first
      // placeChrome() has nothing to measure against.
      setTimeout(function () {
        syncPlayerMetrics();
        placeChrome();
      }, 400);
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
    if (rect && chrome && context.sceneId !== routeSceneId) {
      // Same player element, different scene: drop the overlay and reload the
      // effective preset for the new scene.
      teardown();
    }
    if (rect && chrome) {
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
    // A fresh mount always starts collapsed, whatever the filter's state is.
    // The panel is an on-demand surface, not a status display.
    panelOpen = false;
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

  function onChromeClick(e) {
    const target = e.target.closest("[data-action]");
    if (!target || !chrome || !chrome.contains(target)) return;
    const action = target.dataset.action;
    const value = target.dataset.value;
    switch (action) {
      case "toggle-panel":
        e.preventDefault();
        // The click that ends a pill drag lands on the pill, and it must not
        // count as "show me the panel".
        if (suppressPillClick) {
          suppressPillClick = false;
          break;
        }
        setPanelOpen(!panelOpen);
        break;
      case "close-panel":
        setPanelOpen(false);
        break;
      case "toggle-active":
        // Same path as the Alt+M shortcut, so the pill, the switch and the
        // keyboard can never disagree about the state.
        toggleActive();
        break;
      case "toggle-follow":
        state.follow = !state.follow;
        if (state.follow) snapRectToPointer();
        saveNow();
        render();
        break;
      case "set-shape":
        if (state.shape === value) break;
        state.shape = value === "ellipse" ? "ellipse" : "rectangle";
        saveNow();
        render();
        break;
      case "set-mode":
        if (state.mode === value) break;
        state.mode = value === "reverse" ? "reverse" : "normal";
        saveNow();
        render();
        break;
      case "set-fill":
        if (state.fill === value) break;
        if (value !== "blur" && value !== "solid" && value !== "pixelate") break;
        state.fill = value;
        saveNow();
        render();
        break;
      case "save-scene-preset":
        if (!context.sceneId) break;
        context.source = "scene";
        applyEffectiveChange();
        persistConfig();
        render();
        announce("Saved as this scene's preset");
        break;
      case "save-studio-preset":
        if (!context.studioId) break;
        context.source = "studio";
        applyEffectiveChange();
        persistConfig();
        render();
        announce("Saved as this studio's preset");
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
        announce("Preset cleared · " + sourceLabel());
        break;
      case "reset-defaults":
        Object.assign(state, makeDefaultState());
        saveNow();
        render();
        announce("Reset to defaults");
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
  function onChromeInput(e) {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "blur-slider") return;
    const value = clamp(parseInt(target.value, 10) || 0, 0, MAX_BLUR);
    state.blurAmount = value;
    if (player) player.style.setProperty("--mf-blur", value + "px");
    const readout = panel && panel.querySelector('[data-action="blur-readout"]');
    if (readout) readout.textContent = value + "px";
  }

  function onChromeChange(e) {
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

  function attachChromeListeners() {
    if (!chrome) return;
    chrome.addEventListener("click", onChromeClick);
    chrome.addEventListener("input", onChromeInput);
    chrome.addEventListener("change", onChromeChange);
    // The pill is built once per mount and only restyled afterwards, so the
    // listener survives every renderChrome() pass.
    if (pill) pill.addEventListener("pointerdown", onPillPointerDown);
  }

  // ---------------------------------------------------------------------------
  // Pill drag (mouse + touch)
  //
  // The pill is the only persistent chrome, and it sits in a corner that is not
  // always free: Stash's own badges live at the top, other plugins mount their
  // overlays wherever they like, and the bottom-right corner collides with
  // whatever a user has already put there. Dragging it is the only answer a
  // plugin can give to "that corner is taken" — it cannot know which corner is
  // free.
  //
  // No separate grip: the pill is both the disclosure button and the handle. A
  // press only becomes a drag after PILL_DRAG_THRESHOLD_PX of travel, so a
  // click still opens the panel, and a keyboard Enter keeps working because it
  // never produces a pointerdown.
  //
  // The position is stored as FRACTIONS of the chrome box, not pixels: Stash
  // rebuilds the player on every navigation, and fullscreen turns the same
  // corner into a different offset. It lives in localStorage because it is a
  // per-browser UI preference — the config schema belongs to
  // MosaicFilterShared.sanitizeState and the settings page, and a throwaway
  // value there would be synced to Suite Data (same reasoning as
  // SceneRotation's cluster). `pillPos === null` means "never dragged", and
  // then the stylesheet's `right`/`bottom` anchor — the one built around
  // --mf-cb-h — applies untouched.
  // ---------------------------------------------------------------------------

  function loadPillPos() {
    try {
      const raw = window.localStorage.getItem(PILL_POS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed) return null;
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!isFinite(x) || !isFinite(y)) return null;
      return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    } catch (err) {
      // Storage disabled or full: the pill just stays in its corner and
      // forgets where it was put.
      return null;
    }
  }

  function savePillPos() {
    try {
      if (pillPos) window.localStorage.setItem(PILL_POS_KEY, JSON.stringify(pillPos));
      else window.localStorage.removeItem(PILL_POS_KEY);
    } catch (err) {
      // Non-fatal: the position does not survive the next navigation.
    }
  }

  // The chrome box in CSS pixels — the frame the pill is clamped into. Null when
  // it has no layout yet (before the player is sized, or while hidden).
  function chromeBox() {
    if (!chrome) return null;
    const cw = chrome.clientWidth;
    const ch = chrome.clientHeight;
    if (cw === 0 || ch === 0) return null;
    return { cw, ch };
  }

  // Clamp the stored fractions into the frame and write left/top. Only the
  // dragged case writes anything: with no stored position the stylesheet's
  // anchor is already correct, and clearing the inline values keeps it that
  // way after a rebuild.
  function placePill() {
    if (!chrome || !pill) return;
    // A drag writes left/top itself; writing here would snap the pill back
    // under the pointer.
    if (pillDrag) return;
    if (!pillPos) {
      pill.style.left = "";
      pill.style.top = "";
      pill.style.right = "";
      pill.style.bottom = "";
      return;
    }
    const box = chromeBox();
    if (!box) return;
    // Measure before writing: the pill is inline-flex, so its size comes from
    // its content and the clamp needs it.
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const left = clamp(Math.round(pillPos.x * box.cw), 0, Math.max(0, box.cw - w));
    const top = clamp(Math.round(pillPos.y * box.ch), 0, Math.max(0, box.ch - h));
    pill.style.left = left + "px";
    pill.style.top = top + "px";
    // Both anchors have to go: with right/bottom still set as well, the
    // inline-flex pill would stretch between them across the player.
    pill.style.right = "auto";
    pill.style.bottom = "auto";
  }

  // Where the panel goes once the pill is no longer in its corner. The
  // stylesheet anchors the panel above the pill with `bottom: calc(...)`, which
  // only holds for the bottom-right corner, so a dragged pill needs real
  // geometry: right-aligned with the pill, flipped below when there is more
  // room there, and clamped into the frame.
  //
  // Neither side always has room (a 357px panel, a 600px frame, a pill parked
  // in the middle), and letting the panel overflow would put it *over* the pill
  // — the one control that can close or move it. So the panel is capped to the
  // space that is actually free and scrolls inside it instead. Returns
  // `maxHeight: 0` when the natural height fits and no cap is needed.
  //
  // `geom` carries the measurements (see measureDragGeom) so this stays pure
  // and cheap inside a drag frame.
  function panelSpot(pillLeft, pillTop, geom) {
    const ch = geom.ch;
    const natural = geom.panelH;
    const spaceAbove = pillTop - PILL_PANEL_GAP - CHROME_INSET;
    const spaceBelow = ch - (pillTop + geom.pillH) - PILL_PANEL_GAP - CHROME_INSET;
    const useAbove = spaceAbove >= natural || spaceAbove >= spaceBelow;
    const space = Math.max(0, useAbove ? spaceAbove : spaceBelow);
    const height = Math.min(natural, Math.max(PANEL_MIN_H, space));
    const capped = natural > space;
    const rawTop = useAbove
      ? pillTop - PILL_PANEL_GAP - height
      : pillTop + geom.pillH + PILL_PANEL_GAP;
    const maxTop = Math.max(CHROME_INSET, ch - height - CHROME_INSET);
    // Right edges line up, exactly like the stylesheet's own anchor; near the
    // left edge the clamp flips that to a left alignment.
    const maxLeft = Math.max(CHROME_INSET, geom.cw - geom.panelW - CHROME_INSET);
    const rawLeft = pillLeft + geom.pillW - geom.panelW;
    return {
      left: clamp(rawLeft, CHROME_INSET, maxLeft),
      top: clamp(rawTop, CHROME_INSET, maxTop),
      maxHeight: capped ? Math.max(PANEL_MIN_H, space) : 0,
    };
  }

  // Write the panel's placement. `maxHeight` is set inline only while it bites,
  // which keeps the stylesheet's own cap (60vh / the container query) in charge
  // whenever the panel has room.
  function applyPanelSpot(spot) {
    if (!panel) return;
    const cap = spot.maxHeight ? spot.maxHeight + "px" : "";
    if (panel.style.maxHeight !== cap) panel.style.maxHeight = cap;
    panel.style.left = spot.left + "px";
    panel.style.top = spot.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function placePanel() {
    if (!chrome || !panel || !pill) return;
    if (pillDrag) return;
    if (!pillPos) {
      // Corner case: the stylesheet's formula (which knows about the control
      // bar) is the correct placement, so drop anything a drag left behind.
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
      panel.style.maxHeight = "";
      return;
    }
    // A closed panel has no layout (display:none), so there is nothing to
    // measure and nothing to see.
    if (!panelOpen) return;
    const box = chromeBox();
    if (!box) return;
    // Measure the *natural* height: drop any cap a previous placement applied,
    // otherwise the panel would ratchet itself smaller and never grow back.
    panel.style.maxHeight = "";
    panelNatH = panel.offsetHeight;
    const geom = {
      cw: box.cw,
      ch: box.ch,
      pillW: pill.offsetWidth,
      pillH: pill.offsetHeight,
      panelW: panel.offsetWidth,
      panelH: panelNatH,
    };
    applyPanelSpot(panelSpot(pill.offsetLeft, pill.offsetTop, geom));
  }

  // Keep both pieces of chrome where they belong. Called from renderChrome
  // (panel rebuilt, panel opened/closed), resize, fullscreen change and drag
  // end — never from a per-frame path, so the layout reads here are cheap.
  function placeChrome() {
    if (!chrome || !pill) return;
    if (pillDrag) return;
    placePill();
    placePanel();
  }

  // Everything a drag frame needs, measured once when the drag starts: the
  // position is recomputed up to 125 times a second, and re-measuring the panel
  // on every one of those would be a reflow per event.
  function measureDragGeom() {
    const box = chromeBox();
    if (!box || !pill) return null;
    const panelMeasurable = panelOpen && panel && panel.offsetHeight > 0;
    return {
      cw: box.cw,
      ch: box.ch,
      pillW: pill.offsetWidth,
      pillH: pill.offsetHeight,
      panelOpen: !!panelMeasurable,
      panelW: panelMeasurable ? panel.offsetWidth : 0,
      // The natural height, remembered by placePanel: measuring here would
      // report the height the current cap allows, not the height the panel
      // wants.
      panelH: panelMeasurable ? (panelNatH || panel.offsetHeight) : 0,
    };
  }

  function onPillPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return; // primary button only
    if (!chrome || !pill) return;
    // One gesture at a time.
    if (pillDrag || dragState) return;
    // Every click follows its own pointerup, so clearing the flag here cannot
    // eat an unrelated click; it also stops a drag whose click never fired
    // (pointer left the window) from swallowing the next press.
    suppressPillClick = false;
    // Keep the gesture away from videojs, which seeks/pauses on pointer events
    // over the picture. preventDefault is deliberately NOT called: it would
    // suppress the compatibility mouse events and take the pill's click — the
    // panel toggle — down with it.
    e.stopPropagation();
    const box = pill.getBoundingClientRect();
    pillDrag = {
      id: e.pointerId,
      // Where inside the pill the press landed, so the pill does not jump to
      // put its corner under the cursor.
      grabX: e.clientX - box.left,
      grabY: e.clientY - box.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      captured: false,
      geom: null,
    };
    document.addEventListener("pointermove", onPillPointerMove);
    document.addEventListener("pointerup", onPillPointerUp);
    document.addEventListener("pointercancel", onPillPointerUp);
  }

  function onPillPointerMove(e) {
    if (!pillDrag || e.pointerId !== pillDrag.id) return;
    if (!pillDrag.moved) {
      // Sub-threshold travel is a click on the pill, not a drag — the panel
      // must still open on a slightly shaky press.
      if (Math.hypot(e.clientX - pillDrag.startX, e.clientY - pillDrag.startY) < PILL_DRAG_THRESHOLD_PX) {
        return;
      }
      pillDrag.geom = measureDragGeom();
      if (!pillDrag.geom) return;
      pillDrag.moved = true;
      // Capture on the first movement rather than on pointerdown: while capture
      // is active the click retargets to the pill, and a plain press has to
      // stay a plain click.
      if (pill.setPointerCapture) {
        try { pill.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
      }
      pillDrag.captured = true;
      pill.classList.add("mosaic-filter-pill--dragging");
    }
    // No scroll/zoom gesture and no text selection while dragging on touch.
    if (e.cancelable) e.preventDefault();
    // Queue only the cursor: the frame below does the single read and the write
    // for this batch of events.
    pillMovePoint = { x: e.clientX, y: e.clientY };
    schedulePillMove();
  }

  // One frame per burst of pointer events: one layout read, then writes.
  function schedulePillMove() {
    if (pillMoveFrame) return;
    pillMoveFrame = window.requestAnimationFrame(function () {
      pillMoveFrame = 0;
      applyPillMove();
    });
  }

  function applyPillMove() {
    const p = pillMovePoint;
    pillMovePoint = null;
    if (!p || !pillDrag || !pillDrag.geom || !pill || !chrome || !panel) return;
    // The chrome rect is the only measurement taken per frame: it tracks
    // scrolling and any layout shift, while everything else was cached when the
    // drag started.
    const cr = chrome.getBoundingClientRect();
    const g = pillDrag.geom;
    const left = clamp(Math.round(p.x - cr.left - pillDrag.grabX), 0, Math.max(0, g.cw - g.pillW));
    const top = clamp(Math.round(p.y - cr.top - pillDrag.grabY), 0, Math.max(0, g.ch - g.pillH));
    pill.style.left = left + "px";
    pill.style.top = top + "px";
    pill.style.right = "auto";
    pill.style.bottom = "auto";
    // An open panel travels with the pill — otherwise it would be left behind
    // in the corner with nothing pointing at it.
    if (g.panelOpen) {
      applyPanelSpot(panelSpot(left, top, g));
    }
  }

  function onPillPointerUp(e) {
    if (!pillDrag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== pillDrag.id) return;
    const moved = pillDrag.moved;
    const captured = pillDrag.captured;
    const pointerId = pillDrag.id;
    // Flush the last queued position before tearing the frame down, otherwise a
    // fast flick stops one frame short of where the cursor let go.
    if (pillMoveFrame) {
      window.cancelAnimationFrame(pillMoveFrame);
      pillMoveFrame = 0;
      applyPillMove();
    }
    if (captured && pill && pill.releasePointerCapture) {
      try { pill.releasePointerCapture(pointerId); } catch (_) { /* already released */ }
    }
    document.removeEventListener("pointermove", onPillPointerMove);
    document.removeEventListener("pointerup", onPillPointerUp);
    document.removeEventListener("pointercancel", onPillPointerUp);
    pillDrag = null;
    pillMovePoint = null;
    if (pill) pill.classList.remove("mosaic-filter-pill--dragging");
    if (!moved || !pill || !chrome) return;
    // A drag that moved the pointer is a drag even if there was nothing to
    // store: the click it produces must not open the panel.
    suppressPillClick = true;
    swallowClickUntil = Date.now() + DRAG_CLICK_SWALLOW_MS;
    // Without an inline position there is nothing to commit — that can only
    // happen when the chrome had no measurable size, and storing 0,0 would park
    // the pill in the corner for no reason.
    if (!pill.style.left) return;
    const box = chromeBox();
    if (!box) return;
    pillPos = {
      x: clamp((parseFloat(pill.style.left) || 0) / box.cw, 0, 1),
      y: clamp((parseFloat(pill.style.top) || 0) / box.ch, 0, 1),
    };
    savePillPos();
    // Re-measure and re-clamp with fresh numbers: the cached drag geometry was
    // taken before the last few pixels of travel.
    placeChrome();
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
    // Moving the pill must not drag the filter along with it.
    if (pillDrag) return;
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

  // Keyboard shortcuts live here rather than in the panel so they work while
  // the chrome is collapsed or faded out.
  function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }

  document.addEventListener("keydown", function (e) {
    // Panic shortcut: avoid single-key bindings that would collide with video
    // controls or other plugins. The local decoy page has no network requests.
    if (e.ctrlKey && e.shiftKey && (e.key === "X" || e.key === "x")) {
      e.preventDefault();
      togglePanicScreen();
      return;
    }
    // Escape closes the panel but is never preventDefault-ed: Stash uses it
    // for its own dismissals and this panel is not modal.
    if (e.key === "Escape" && panelOpen) {
      setPanelOpen(false);
      return;
    }
    // Alt+M flips the filter without opening anything — the fastest way to
    // hide something, and the reason the collapsed state can stay silent.
    // Alt keeps the binding clear of video.js hotkeys (m = mute) and of every
    // plain-letter shortcut another plugin might claim.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat && (e.key === "m" || e.key === "M")) {
      if (isTypingTarget(e.target)) return;
      if (!rect || !player) return;
      e.preventDefault();
      toggleActive();
    }
  });

  // Re-position the rectangle on window resize so the percentages stay right.
  // The control bar is re-measured too: Stash's bar height changes with the
  // player size at some breakpoints.
  window.addEventListener("resize", function () {
    if (!rect || !player) return;
    syncPlayerMetrics();
    renderRect();
    // A smaller frame can leave a dragged pill (and the panel under it) outside
    // the picture.
    placeChrome();
  });

  // Fullscreen swaps the player box for the viewport, so both the control-bar
  // offset and the rectangle have to be recomputed.
  document.addEventListener("fullscreenchange", function () {
    if (!rect || !player) return;
    syncPlayerMetrics();
    renderRect();
    placeChrome();
  });

  // Safety net for a pill drag that ends without a pointerup we can see: the
  // drag listeners are on `document`, and if the browser never granted pointer
  // capture a release outside the document — dragged out of the window, or
  // cancelled by the OS on touch — reaches `window` only. A `pillDrag` left set
  // would silently disable moving the pill *and* follow mode (both pointermove
  // paths bail on it) until the page is reloaded. The handler is a no-op when
  // no drag is active, so double delivery is harmless.
  window.addEventListener("pointerup", onPillPointerUp);
  window.addEventListener("pointercancel", onPillPointerUp);

  // The click that ends a pill drag must not read as a gesture on the picture —
  // videojs turns that into play/pause, and a drag across the video would pause
  // it. Scoped three ways so nothing else pays for it: by time (a few hundred
  // ms after the drag, so ordinary playback clicks keep working), by target
  // (only clicks inside the player — an event that lands elsewhere never
  // reaches videojs anyway), and by subtree (clicks inside the chrome are the
  // user pressing a control right after moving the pill, which is exactly what
  // a user does next).
  document.addEventListener("click", function (e) {
    if (Date.now() > swallowClickUntil) return;
    const target = e.target;
    if (!target || !target.closest) return;
    if (chrome && chrome.contains(target)) return;
    if (!player || !player.contains(target)) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // Best-effort: persist any in-memory changes before the page is hidden.
  // Async saves may not complete before the page unloads, but the request
  // is at least submitted.
  window.addEventListener("pagehide", function () {
    saveNow();
  });
})();
