/**
 * MosaicFilter plugin — player overlay
 *
 * Architecture:
 * - Uses csLib.PathElementListener to inject on /scenes/ when #VideoJsPlayer
 *   exists, and on subsequent stash:location SPA navigations.
 * - Adds an extra window.PluginApi.Event "stash:location" safety net to
 *   re-inject the overlay if React re-renders remove it. There can be a brief
 *   flash between removal and re-injection.
 * - A scene resolves ONE layer, and a layer holds a LIST of independent filter
 *   regions: { filters: [...], selectedId }. Each region owns its own
 *   geometry, effect parameters and visibility, so editing one can never
 *   overwrite another. The shared module owns the schema and the list
 *   operations (add / update / reset / remove / select); this file only maps
 *   that list onto DOM nodes and persists it.
 * - Legacy data (one flat filter per layer, the 0.7.0 shape) is upgraded by
 *   MosaicFilterShared.sanitizeLayer on read and written back in the current
 *   shape on the next save, so a single-filter user notices nothing but the
 *   new "Add filter" row.
 * - UI surface is two-tier, deliberately quiet: a 28px pill in the bottom-right
 *   corner (clear of Stash's own control bar) is the only persistent chrome,
 *   and it fades out with the player chrome when the user goes idle. Every
 *   control lives in a popover that only opens on request — see renderChrome
 *   and setPanelOpen. Nothing is written to config about the panel's state.
 * - Geometry is stored as percentages of the player so the regions scale
 *   correctly across viewport sizes and fullscreen.
 * - All state mutations are persisted through
 *   MosaicFilterStorage.saveConfig("MosaicFilter", layer) wrapped in a lock to
 *   avoid concurrent saves. csLib.getConfiguration and setConfiguration are
 *   BOTH async — always await them.
 * - Shared constants and pure functions (FALLBACK_DEFAULTS, clamp, the layer
 *   CRUD helpers, ...) live in MosaicFilterShared.js, which MUST be loaded
 *   first per the manifest.
 * - Write policy: writes happen at user-driven boundaries (toggle, drag end,
 *   resize end, slider release, scene transition, pagehide). The blur slider
 *   updates the visual on every `input` event but only persists on `change`
 *   (slider release). Follow-mode position updates are in-memory only and
 *   persist at the boundaries.
 * - Per-region effect parameters reach CSS as inline custom properties on the
 *   region element itself (`--mf-blur`, `--mf-fill-color`). They used to be
 *   set once on #VideoJsPlayer, which cannot work once two regions blur by
 *   different amounts.
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
  const MAX_FILTERS = window.MosaicFilterShared.MAX_FILTERS;

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
  var makeDefaultLayer = window.MosaicFilterShared.makeDefaultLayer;
  var makeDefaultConfig = window.MosaicFilterShared.makeDefaultConfig;
  var normalizeConfig = window.MosaicFilterShared.normalizeConfig;
  var resolveState = window.MosaicFilterShared.resolveState;
  var makePresetLayer = window.MosaicFilterShared.makePresetLayer;
  var presetSource = window.MosaicFilterShared.presetSource;
  var findFilter = window.MosaicFilterShared.findFilter;
  var selectedFilter = window.MosaicFilterShared.selectedFilter;
  var selectFilter = window.MosaicFilterShared.selectFilter;
  var spawnFilter = window.MosaicFilterShared.spawnFilter;
  var updateFilter = window.MosaicFilterShared.updateFilter;
  var resetFilter = window.MosaicFilterShared.resetFilter;
  var removeFilter = window.MosaicFilterShared.removeFilter;
  var filterName = window.MosaicFilterShared.filterName;

  // Filter names are user input and end up in innerHTML, so every interpolation
  // of a name (or an id read back from an older config) goes through this.
  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Module-level state. `config` owns the persisted layers (default + scene
  // and studio presets); `layer` is the effective layer for the current scene
  // — its filter list is what the DOM below is built from. Every user edit
  // updates the effective layer and then persists.
  let config = makeDefaultConfig();
  let layer = makeDefaultLayer();
  let context = { sceneId: null, studioId: null, source: "default" };
  let studioLookupToken = 0;
  let pixelLoopActive = false;
  let pixelVideoFrameCallback = null;

  // Cached DOM references for the pixelation loop. The video frame callback
  // runs up to 60x/second, so the video element is resolved once per mount and
  // each region's canvas + 2D context are held in its `rects` entry. The rect
  // size is derived from the layer (see `layoutFilter`) instead of measured.
  // Nothing in the frame path touches the DOM query API or forces a layout.
  let pixelVideoEl = null;

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

  // Per-region DOM, keyed by filter id. An entry is
  // { el, surface, canvas, ctx, w, h, pixelOn }. Keyed by id rather than by
  // index so reordering, deleting a neighbour or a selection change never
  // re-binds a node to a different region — the id is the identity.
  const rects = new Map();
  // Per-region reverse-mode mask layers, keyed by the same ids. One mask per
  // region (rather than one shared mask with several holes) is what lets two
  // regions use different blur radii; see the note in updateMask.
  const masks = new Map();

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
  const ICON_TRASH =
    '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">' +
    '<path d="M2.5 3.5h7M4.5 3.5V2.5h3v1M3.5 3.5l.4 6h4.2l.4-6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_PLUS =
    '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">' +
    '<path d="M6 2.5v7M2.5 6h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  // Active pointer interaction on a region: { type, filterId, ... }.
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

  // Last known cursor position over the player. Used by snapFollowersToPointer
  // when toggling Follow on or mounting with Follow already enabled.
  let lastPointer = null;

  // ---------------------------------------------------------------------------
  // Layer accessors
  // ---------------------------------------------------------------------------

  /** The region the panel edits and the shortcuts act on. Never null. */
  function currentFilter() {
    return selectedFilter(layer);
  }

  function currentIndex() {
    const f = currentFilter();
    if (!f) return 0;
    const i = layer.filters.indexOf(f);
    return i < 0 ? 0 : i;
  }

  /** Aggregate state for the pill, which speaks for the whole layer. */
  function layerState() {
    let on = 0;
    let reverse = false;
    for (let i = 0; i < layer.filters.length; i++) {
      if (!layer.filters[i].active) continue;
      on += 1;
      if (layer.filters[i].mode === "reverse") reverse = true;
    }
    return { on: on, total: layer.filters.length, reverse: reverse };
  }

  // ---------------------------------------------------------------------------
  // Persistence (Suite Data preferred; csLib fallback)
  // ---------------------------------------------------------------------------

  function applyEffectiveChange() {
    const preset = makePresetLayer(layer);
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
    layer = resolveState(config, context.sceneId, context.studioId);
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function ensurePlayerRelative(el) {
    // getComputedStyle always returns a non-empty value for `position`, so
    // checking the empty-string branch is unreachable. The only way the
    // element lacks a positioning context is when the computed value is
    // "static" — we promote it to "relative" so our absolutely-positioned
    // children (the mask layers, the filter regions and the chrome anchor)
    // anchor to it.
    const style = window.getComputedStyle(el);
    if (style.position === "static") {
      el.style.position = "relative";
    }
  }

  /**
   * One filter region. Returns an entry rather than the bare element, because
   * the pixel canvas lives in a shadow root and therefore cannot be found
   * again with a querySelector.
   */
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
    // renders, paints and measures normally. This applies to EVERY region's
    // canvas — the Filters panel takes the first canvas it finds. Do not
    // "simplify" this back to a direct child of the rectangle.
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

    const handle = document.createElement("div");
    handle.className = "mosaic-filter-rectangle__resize";
    handle.dataset.action = "rect-resize";
    handle.setAttribute("aria-label", "Resize mosaic region");
    r.appendChild(handle);

    return {
      el: r,
      surface: surface,
      canvas: canvas,
      ctx: null,
      w: 0,
      h: 0,
      pixelOn: false,
    };
  }

  function buildMaskLayer() {
    const ml = document.createElement("div");
    ml.className = "mosaic-filter-mask-layer";
    ml.setAttribute("aria-hidden", "true");
    return ml;
  }

  // Create the DOM for every filter in the layer and drop the DOM of filters
  // that no longer exist. Runs on every render; it is a no-op once the set
  // matches, and the `rects` / `masks` maps keep it O(n) in filters, not in
  // renders.
  function syncFilterNodes() {
    if (!player) return;
    const live = new Set(layer.filters.map(function (f) { return f.id; }));

    rects.forEach(function (entry, id) {
      if (live.has(id)) return;
      if (entry.el.parentElement) entry.el.parentElement.removeChild(entry.el);
      rects.delete(id);
    });
    masks.forEach(function (el, id) {
      if (live.has(id)) return;
      if (el.parentElement) el.parentElement.removeChild(el);
      masks.delete(id);
    });

    for (let i = 0; i < layer.filters.length; i++) {
      const f = layer.filters[i];
      if (!rects.has(f.id)) {
        const entry = buildRect();
        // The closure captures the id, not the index or the object: the entry
        // must stay bound to this region across reorders and deletions.
        entry.el.addEventListener("pointerdown", function (e) {
          onRectPointerDown(e, f.id);
        });
        player.appendChild(entry.el);
        rects.set(f.id, entry);
      }
      if (!masks.has(f.id)) {
        const mask = buildMaskLayer();
        player.appendChild(mask);
        masks.set(f.id, mask);
      }
    }
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

  // The filter list: one row per region, then the add button. Selection is a
  // button (so it is keyboard reachable and announces its state), visibility
  // and deletion are separate icon buttons so neither needs a modifier or a
  // second click to reach.
  function filterListMarkup() {
    const selectedId = layer.selectedId;
    const rows = layer.filters.map(function (f, index) {
      const on = !!f.active;
      const selected = f.id === selectedId;
      const name = esc(filterName(f, index));
      return (
        '<div class="mosaic-filter-filters__row' + (selected ? " mosaic-filter-filters__row--selected" : "") + '">' +
          '<button type="button" class="mosaic-filter-filters__select" ' +
            'data-action="select-filter" data-value="' + esc(f.id) + '" ' +
            'aria-pressed="' + (selected ? "true" : "false") + '" ' +
            'title="Edit ' + name + '">' +
            '<span class="mosaic-filter-filters__dot' + (on ? " mosaic-filter-filters__dot--on" : "") + '" aria-hidden="true"></span>' +
            '<span class="mosaic-filter-filters__name">' + name + "</span>" +
          "</button>" +
          '<button type="button" class="mosaic-filter-filters__icon" ' +
            'data-action="toggle-filter" data-value="' + esc(f.id) + '" ' +
            'aria-pressed="' + (on ? "true" : "false") + '" ' +
            'aria-label="Show or hide ' + name + '" ' +
            'title="Show or hide ' + name + '">' +
            (on ? "On" : "Off") +
          "</button>" +
          (layer.filters.length > 1
            ? '<button type="button" class="mosaic-filter-filters__icon mosaic-filter-filters__icon--danger" ' +
                'data-action="delete-filter" data-value="' + esc(f.id) + '" ' +
                'aria-label="Delete ' + name + '" title="Delete ' + name + '">' + ICON_TRASH + "</button>"
            : "") +
        "</div>"
      );
    }).join("");

    const atCap = layer.filters.length >= MAX_FILTERS;
    return (
      '<div class="mosaic-filter-filters" role="group" aria-label="Filter regions">' +
        rows +
        '<button type="button" class="mosaic-filter-filters__add" data-action="add-filter"' +
          (atCap ? " disabled" : "") +
          ' title="' + (atCap
            ? "Limit reached (" + MAX_FILTERS + " filters)"
            : "Add another filter region") + '">' +
          ICON_PLUS + "<span>Add filter</span>" +
        "</button>" +
      "</div>"
    );
  }

  // Panel contents. Rebuilt on every render; the pill is not, so the control
  // the user actually opens the panel with keeps its identity and focus.
  function panelMarkup() {
    const f = currentFilter();
    if (!f) return "";
    const index = currentIndex();
    const name = filterName(f, index);
    const nameAttr = esc(name);
    const fill = f.fill;
    const hasPreset = context.source !== "default";
    const multi = layer.filters.length > 1;
    return (
      '<div class="mosaic-filter-panel__header">' +
        '<span class="mosaic-filter-panel__title">Mosaic</span>' +
        '<span class="mosaic-filter-panel__source">' + sourceLabel() + "</span>" +
        '<button type="button" class="mosaic-filter-icon-btn" data-action="close-panel" ' +
          'aria-label="Close mosaic settings" title="Close (Esc)">' + ICON_CLOSE + "</button>" +
      "</div>" +

      filterListMarkup() +

      '<div class="mosaic-filter-switches">' +
        '<button type="button" class="mosaic-filter-switch" data-action="toggle-active" ' +
          'aria-pressed="' + (f.active ? "true" : "false") + '" ' +
          'aria-label="' + nameAttr + ': on or off" ' +
          'title="Show or hide ' + nameAttr + ' (Alt+M)">' +
          '<span class="mosaic-filter-switch__dot" aria-hidden="true"></span>' +
          (f.active ? "On" : "Off") +
        "</button>" +
        '<button type="button" class="mosaic-filter-switch" data-action="toggle-follow" ' +
          'aria-pressed="' + (f.follow ? "true" : "false") + '" ' +
          'title="Re-centre ' + nameAttr + ' on the pointer as it moves. Dragging is disabled in this mode.">' +
          '<span class="mosaic-filter-switch__dot" aria-hidden="true"></span>' +
          "Follow" +
        "</button>" +
      "</div>" +

      '<label class="mosaic-filter-slider">' +
        '<span class="mosaic-filter-slider__label">Blur</span>' +
        '<input class="mosaic-filter-slider__input" type="range" min="0" max="' + MAX_BLUR +
          '" step="1" value="' + f.blurAmount + '" data-action="blur-slider" ' +
          'aria-label="' + nameAttr + ': mosaic blur amount in pixels" />' +
        '<span class="mosaic-filter-slider__value" data-action="blur-readout">' + f.blurAmount + "px</span>" +
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
              f.fillColor + '" aria-label="' + nameAttr + ': solid fill colour" title="Solid fill colour" />' +
          "</div>"
        : "") +

      segmentedRow("set-shape", f.shape, [
        { value: "rectangle", label: "Rect" },
        { value: "ellipse", label: "Ellipse" },
      ], "Shape") +

      segmentedRow("set-mode", f.mode, [
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
        actionButton("reset-defaults", "Reset", false,
          multi ? "Reset " + nameAttr + " to the built-in defaults" : "Restore the built-in defaults") +
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
    // Ids and segmented values are sanitized to [A-Za-z0-9_-], so quoting is
    // enough and CSS.escape is not needed.
    const selector =
      '[data-action="' + key.action + '"]' + (key.value ? '[data-value="' + key.value + '"]' : "");
    const el = panel.querySelector(selector);
    if (el && typeof el.focus === "function") {
      el.focus({ preventScroll: true });
    }
  }

  function renderChrome() {
    if (!chrome || !pill || !panel) return;
    const agg = layerState();
    const anyOn = agg.on > 0;
    chrome.classList.toggle("mosaic-filter-chrome--on", anyOn);
    // Reverse is only meaningful while at least one region is live; gating the
    // class on `on` keeps the pill from advertising a state that is not applied.
    chrome.classList.toggle("mosaic-filter-chrome--reverse", anyOn && agg.reverse);
    chrome.classList.toggle("mosaic-filter-chrome--open", panelOpen);
    // An open panel is an explicit interaction, so it must not fade away when
    // video.js decides the user is idle.
    chrome.classList.toggle("mosaic-filter-chrome--pinned", panelOpen);

    pill.setAttribute("aria-expanded", panelOpen ? "true" : "false");
    pill.title =
      "Mosaic filter — " + (agg.total > 1 ? agg.on + "/" + agg.total + " on" : (anyOn ? "on" : "off")) +
      " · " + sourceLabel() +
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

  // The pill speaks for the layer, so the message names the region only when
  // there is more than one to be confused about.
  function stateLabel() {
    return layer.filters.length > 1 ? filterName(currentFilter(), currentIndex()) : "Mosaic filter";
  }

  function toggleActive() {
    const f = currentFilter();
    if (!f) return;
    const label = stateLabel();
    updateFilter(layer, f.id, { active: !f.active });
    saveNow();
    render();
    announce(f.active ? label + " on" + (f.mode === "reverse" ? " · reverse" : "") : label + " off");
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

  // ---------------------------------------------------------------------------
  // Render path (regions, masks, pixelation)
  // ---------------------------------------------------------------------------

  /**
   * Position one region and push its own parameters into its own element.
   * All layout reads happen before the first style write, so a render never
   * forces a synchronous reflow: `pw`/`ph` are measured once by the caller.
   *
   * The effect parameters are written as custom properties on the region
   * itself rather than on the player. Two regions can now blur by different
   * amounts, and a player-level --mf-blur would apply the last write to both.
   */
  function layoutFilter(f, pw, ph) {
    const entry = rects.get(f.id);
    if (!entry) return;
    const el = entry.el;
    const w = f.widthPct * pw;
    const h = f.heightPct * ph;
    // `.mosaic-filter-rectangle` is `box-sizing: border-box` with a 1px
    // border, so these run 2px above the real `clientWidth`/`clientHeight`.
    // That only shifts the canvas backing-store aspect ratio by at most one
    // cell, and the canvas is stretched to `width/height: 100%` anyway — the
    // pixels themselves are blocky by design. In exchange the per-frame
    // pixelation loop never has to read layout.
    entry.w = w;
    entry.h = h;
    el.style.left = (f.xPct * pw) + "px";
    el.style.top = (f.yPct * ph) + "px";
    el.style.width = w + "px";
    el.style.height = h + "px";
    el.style.setProperty("--mf-blur", f.blurAmount + "px");
    el.style.setProperty("--mf-fill-color", f.fillColor);
    el.classList.toggle("mosaic-filter-rectangle--hidden", !f.active);
    el.classList.toggle("mosaic-filter-rectangle--ellipse", f.shape === "ellipse");
    el.classList.toggle("mosaic-filter-rectangle--reverse", f.mode === "reverse");
    el.classList.toggle("mosaic-filter-rectangle--fill-solid", f.fill === "solid");
    el.classList.toggle("mosaic-filter-rectangle--fill-pixelate", f.fill === "pixelate");
    // Show the region's full outline (edge + resize grip) while the panel is
    // open — the user is editing geometry, so every boundary has to be
    // visible — and mark the one the panel is actually pointed at.
    el.classList.toggle("mosaic-filter-rectangle--editing", panelOpen);
    el.classList.toggle("mosaic-filter-rectangle--selected", panelOpen && layer.selectedId === f.id);

    const mask = masks.get(f.id);
    if (mask) updateMask(f, mask, pw, ph);
    syncFilterCanvas(f, entry);
  }

  /**
   * Update one region's reverse-mode mask: position, size, shape and fill.
   *
   * One mask per region, not one shared mask with several holes. Two regions
   * can carry different blur radii / fill colours, and a single element cannot
   * apply two backdrop-filters. The consequence is compositing: two regions in
   * reverse mode each blur everything outside themselves, so the area that
   * stays clear is their intersection. That is the literal meaning of the
   * setting, and it is announced by the panel — but it is also why reverse
   * mode is normally used on exactly one region.
   *
   * The hole is cut via `clip-path: path()` with TWO separate subpaths (outer
   * player rect + inner hole shape). The previous approach used
   * `clip-path: polygon(...)` with 8 points for the rectangle and
   * `mask-image` + `mask-composite: subtract` for the ellipse; both were
   * broken:
   *
   *   1. The 8-point polygon closed from the last inner point diagonally
   *      back to the first outer point, making the path self-intersecting.
   *      Under the nonzero fill rule, the L-shaped area (left of and above
   *      the filter) ended up outside the clip, so the backdrop-filter
   *      didn't apply there and the video stayed clear.
   *
   *   2. `mask-composite: subtract` (and its `-webkit-` prefix equivalent)
   *      has inconsistent browser support — some browsers compute the mask
   *      as fully transparent, making the whole mask layer invisible and
   *      so the backdrop-filter was never applied outside the bounding box
   *      either.
   *
   * `clip-path: path()` with two subpaths avoids both problems: the `Z M`
   * separator creates two non-self-intersecting subpaths. The CSS uses
   * `clip-rule: evenodd`, so the inner subpath becomes a hole regardless of
   * winding direction — the rule is "inside iff a ray from the point crosses
   * the path an odd number of times". A point inside the outer rect but
   * outside the inner shape crosses once (odd → inside → blurred). A point
   * inside both crosses twice (even → outside → clear). The path() function
   * is supported in Chrome 88+, Firefox 70+, and Safari 13.1+ — well within
   * Stash's bundled Chromium baseline.
   *
   * A mask is only meaningful when `f.active` is true AND
   * `f.mode === 'reverse'`. If the user toggles that region off while it is
   * in reverse mode, the mask must hide too — otherwise the whole player is
   * blurred with no clear area and no indicator, even though other regions
   * may still be on.
   */
  function updateMask(f, mask, pw, ph) {
    if (!mask) return;
    const leftPx = f.xPct * pw;
    const topPx = f.yPct * ph;
    const wPx = Math.max(f.widthPct * pw, 1);
    const hPx = Math.max(f.heightPct * ph, 1);

    let innerD;
    if (f.shape === 'ellipse') {
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
    mask.style.clipPath = "path('" + outerD + " " + innerD + "')";
    mask.style.setProperty("--mf-blur", f.blurAmount + "px");
    mask.style.setProperty("--mf-fill-color", f.fillColor);

    const reverseOn = f.active && f.mode === 'reverse';
    mask.classList.toggle('mosaic-filter-mask-layer--reverse', reverseOn);
    mask.classList.toggle('mosaic-filter-mask-layer--hidden', !f.active);
    mask.classList.toggle('mosaic-filter-mask-layer--fill-solid', reverseOn && f.fill === 'solid');
    mask.classList.toggle('mosaic-filter-mask-layer--fill-blur', reverseOn && f.fill !== 'solid');
  }

  /**
   * Redraw every region. Direct calls are for discrete state changes (toggle,
   * colour, resize, mount, selection); pointer handlers go through
   * `scheduleRender` so a burst of events costs one render per frame.
   */
  function renderFilters() {
    if (!player) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    syncFilterNodes();
    for (let i = 0; i < layer.filters.length; i++) {
      layoutFilter(layer.filters[i], pw, ph);
    }
    syncPixelLoops();
  }

  // Pointer handlers fire many times per painted frame; collapsing them into
  // one rAF means one style recalc per frame instead of one per event. The
  // latest layer state always wins, so intermediate positions are not worth a
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
      renderFilters();
    });
  }

  // Turn the queued cursor position into rect percentages for every region
  // that is following. Runs at the top of the scheduled render, before any
  // style write in this frame.
  function applyPendingFollow() {
    const p = pendingFollow;
    pendingFollow = null;
    if (!p || dragState || pillDrag) return;
    if (!player || layer.filters.length === 0) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) return;
    const pr = player.getBoundingClientRect();
    for (let i = 0; i < layer.filters.length; i++) {
      const f = layer.filters[i];
      if (!f.follow) continue;
      f.xPct = clamp((p.x - pr.left) / pw - f.widthPct / 2, 0, 1 - f.widthPct);
      f.yPct = clamp((p.y - pr.top) / ph - f.heightPct / 2, 0, 1 - f.heightPct);
    }
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

  function stopPixelLoop() {
    pixelLoopActive = false;
    const video = getVideoElement();
    if (pixelVideoFrameCallback && video && video.cancelVideoFrameCallback) {
      try { video.cancelVideoFrameCallback(pixelVideoFrameCallback); } catch (_) { /* ignore */ }
    }
    pixelVideoFrameCallback = null;
  }

  // One loop paints every pixelated region: they all sample the same video
  // frame, so a second callback per region would only duplicate work.
  function drawPixelFrame() {
    const video = getVideoElement();
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    for (let i = 0; i < layer.filters.length; i++) {
      const f = layer.filters[i];
      const entry = rects.get(f.id);
      if (!entry || !entry.pixelOn || !entry.canvas) continue;
      // `entry.w`/`entry.h` are maintained by layoutFilter, so this no longer
      // reads layout inside the frame callback.
      if (entry.w <= 0 || entry.h <= 0) continue;
      const step = Math.max(4, f.pixelSize);
      const width = Math.max(4, Math.floor(entry.w / step));
      const height = Math.max(4, Math.floor(entry.h / step));
      if (entry.canvas.width !== width) entry.canvas.width = width;
      if (entry.canvas.height !== height) entry.canvas.height = height;
      if (!entry.ctx) entry.ctx = entry.canvas.getContext("2d");
      const ctx = entry.ctx;
      if (!ctx) continue;
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

  // Toggle one region's canvas and decide whether the shared loop still has
  // anything to paint.
  function syncFilterCanvas(f, entry) {
    if (!entry || !entry.canvas) return;
    const on = f.active && f.fill === "pixelate" && f.mode === "normal";
    // Guarded write: layoutFilter runs up to once per frame while dragging,
    // and re-assigning an unchanged value still walks the CSSOM.
    const nextDisplay = on ? "block" : "none";
    if (entry.canvas.style.display !== nextDisplay) entry.canvas.style.display = nextDisplay;
    entry.pixelOn = on;
  }

  function syncPixelLoops() {
    let any = false;
    rects.forEach(function (entry) {
      if (entry.pixelOn) any = true;
    });
    if (!any) {
      stopPixelLoop();
      return;
    }
    // The video-frame loop only repaints while the video is actually
    // presenting frames. `requestVideoFrameCallback` does not fire on a
    // paused video, and resizing the canvas backing store clears it — so a
    // drag over a paused video would leave a blank filter region unless we
    // paint here. Only skip the blit when the loop is guaranteed to repaint
    // on its own.
    const video = getVideoElement();
    const loopWillPaint = pixelLoopActive && video && !video.paused && !video.ended;
    if (!loopWillPaint) drawPixelFrame();
    startPixelLoop();
  }

  function clipRegion(ctx, f, x, y, w, h) {
    ctx.beginPath();
    if (f.shape === "ellipse") {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.clip();
  }

  function paintEffect(ctx, video, f, x, y, w, h, canvasWidth, canvasHeight) {
    if (f.fill === "solid") {
      ctx.fillStyle = f.fillColor;
      ctx.fillRect(x, y, w, h);
      return;
    }
    if (f.fill === "pixelate") {
      const temp = document.createElement("canvas");
      temp.width = Math.max(2, Math.floor(w / Math.max(4, f.pixelSize)));
      temp.height = Math.max(2, Math.floor(h / Math.max(4, f.pixelSize)));
      const tctx = temp.getContext("2d");
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(video, 0, 0, canvasWidth, canvasHeight, 0, 0, temp.width, temp.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(temp, 0, 0, temp.width, temp.height, x, y, w, h);
      ctx.imageSmoothingEnabled = true;
      return;
    }
    ctx.filter = "blur(" + f.blurAmount + "px)";
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

  // The player box and the video frame do not line up when the video is
  // letterboxed, so region percentages are mapped onto the *canvas* here
  // (which holds the frame). Same mapping the single-region version used.
  function canvasGeometry(f, canvas) {
    return {
      x: f.xPct * canvas.width,
      y: f.yPct * canvas.height,
      w: f.widthPct * canvas.width,
      h: f.heightPct * canvas.height,
    };
  }

  function captureRedacted() {
    const video = getVideoElement();
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      setScreenshotStatus("Screenshot unavailable: video frame is not ready.");
      return;
    }
    const active = layer.filters.filter(function (f) { return f.active; });
    if (active.length === 0) {
      setScreenshotStatus("Nothing to redact: every filter is off.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const cw = canvas.width;
    const ch = canvas.height;

    // Reverse first: each one paints its effect over the whole frame and then
    // restores its own hole from the untouched video, so a later normal-mode
    // region still lands inside a clear area. Pixelate is not available in
    // reverse mode (the mask layer has no pixelation path), so it degrades to
    // blur here exactly as it does on screen.
    active.filter(function (f) { return f.mode === "reverse"; }).forEach(function (f) {
      const paint = f.fill === "pixelate" ? Object.assign({}, f, { fill: "blur" }) : f;
      const g = canvasGeometry(f, canvas);
      const effect = document.createElement("canvas");
      effect.width = cw;
      effect.height = ch;
      const ectx = effect.getContext("2d");
      ectx.drawImage(video, 0, 0, cw, ch);
      paintEffect(ectx, video, paint, 0, 0, cw, ch, cw, ch);
      ctx.drawImage(effect, 0, 0);
      ctx.save();
      clipRegion(ctx, f, g.x, g.y, g.w, g.h);
      ctx.drawImage(video, 0, 0, cw, ch);
      ctx.restore();
    });

    active.filter(function (f) { return f.mode !== "reverse"; }).forEach(function (f) {
      const g = canvasGeometry(f, canvas);
      ctx.save();
      clipRegion(ctx, f, g.x, g.y, g.w, g.h);
      paintEffect(ctx, video, f, g.x, g.y, g.w, g.h, cw, ch);
      ctx.restore();
    });

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
    renderFilters();
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
    if (dragState) {
      const entry = rects.get(dragState.filterId);
      if (entry) {
        entry.el.classList.remove(
          "mosaic-filter-rectangle--dragging",
          "mosaic-filter-rectangle--resizing"
        );
      }
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      dragState = null;
    }
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    rects.forEach(function (entry) {
      if (entry.el.parentElement) entry.el.parentElement.removeChild(entry.el);
    });
    masks.forEach(function (el) {
      if (el.parentElement) el.parentElement.removeChild(el);
    });
    rects.clear();
    masks.clear();
    if (chrome && chrome.parentElement) chrome.parentElement.removeChild(chrome);
    chrome = null;
    pill = null;
    panel = null;
    toastEl = null;
    statusEl = null;
    player = null;
    pixelVideoEl = null;
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
    // Creates the region and mask nodes for every filter, including the ones
    // added after the previous mount.
    syncFilterNodes();
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
    // regions to the cursor) without re-binding event handlers.
    attachFollowListener();
    if (layer.filters.some(function (f) { return f.follow; })) {
      snapFollowersToPointer();
    }
    return true;
  }

  async function setupPanel(targetPlayer) {
    if (player !== targetPlayer) {
      teardown();
    }
    const routeMatch = window.location.pathname.match(/\/scenes\/(\d+)/);
    const routeSceneId = routeMatch ? routeMatch[1] : null;
    if (chrome && context.sceneId !== routeSceneId) {
      // Same player element, different scene: drop the overlay and reload the
      // effective preset for the new scene.
      teardown();
    }
    if (chrome) {
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
  // Pointer interactions on a region (drag + resize)
  // ---------------------------------------------------------------------------

  function onRectPointerDown(e, filterId) {
    if (e.button !== undefined && e.button !== 0) return; // primary button only
    const f = findFilter(layer, filterId);
    const entry = rects.get(filterId);
    if (!f || !entry) return;

    // Pressing a region is also how you pick which one the panel edits.
    // Rendering here is once per gesture, not per frame.
    if (layer.selectedId !== f.id) {
      selectFilter(layer, f.id);
      render();
    }

    // In follow mode the region is anchored to the cursor already, so
    // dragging it is redundant and would just fight the follow handler.
    // Resize still works.
    const action = e.target?.dataset?.action;
    if (f.follow && action !== "rect-resize") {
      return;
    }

    let type;
    if (action === "rect-resize") {
      type = "resize";
    } else if (action === "rect-drag" || entry.el.contains(e.target)) {
      type = "drag";
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!player) return;
    dragState = {
      type: type,
      filterId: f.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startXPct: f.xPct,
      startYPct: f.yPct,
      startWPct: f.widthPct,
      startHPct: f.heightPct,
      pw: player.clientWidth,
      ph: player.clientHeight,
    };
    if (entry.el.setPointerCapture) {
      try { entry.el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }
    entry.el.classList.add(
      type === "resize" ? "mosaic-filter-rectangle--resizing" : "mosaic-filter-rectangle--dragging"
    );
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragState) return;
    // The dragged region is looked up by id on every move: a save, a preset
    // change or a selection change can replace the layer while a drag is in
    // flight, and an index would then point at a different region.
    const f = findFilter(layer, dragState.filterId);
    if (!f) return;
    const pw = dragState.pw;
    const ph = dragState.ph;
    if (!pw || !ph) return;
    const dxPct = (e.clientX - dragState.startX) / pw;
    const dyPct = (e.clientY - dragState.startY) / ph;
    if (dragState.type === "drag") {
      f.xPct = clamp(dragState.startXPct + dxPct, 0, 1 - f.widthPct);
      f.yPct = clamp(dragState.startYPct + dyPct, 0, 1 - f.heightPct);
    } else {
      f.widthPct = clamp(dragState.startWPct + dxPct, MIN_SIZE_PCT, 1 - f.xPct);
      f.heightPct = clamp(dragState.startHPct + dyPct, MIN_SIZE_PCT, 1 - f.yPct);
    }
    scheduleRender();
  }

  function onPointerUp(e) {
    if (!dragState) return;
    const pointerId = dragState.pointerId;
    const entry = rects.get(dragState.filterId);
    if (entry) {
      entry.el.classList.remove(
        "mosaic-filter-rectangle--dragging",
        "mosaic-filter-rectangle--resizing"
      );
      if (entry.el.releasePointerCapture && pointerId !== undefined) {
        try { entry.el.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
      }
    }
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    dragState = null;
    saveNow();
  }

  // ---------------------------------------------------------------------------
  // Chrome interactions (click delegation + slider)
  // ---------------------------------------------------------------------------

  function announceFilterState(f) {
    const index = layer.filters.indexOf(f);
    const label = filterName(f, index < 0 ? 0 : index);
    announce(label + (f.active ? " on" + (f.mode === "reverse" ? " · reverse" : "") : " off"));
  }

  function onChromeClick(e) {
    const target = e.target.closest("[data-action]");
    if (!target || !chrome || !chrome.contains(target)) return;
    const action = target.dataset.action;
    const value = target.dataset.value;
    const selected = currentFilter();
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
      case "add-filter": {
        const created = spawnFilter(layer);
        if (!created) {
          announce("Filter limit reached (" + MAX_FILTERS + ")");
          break;
        }
        saveNow();
        render();
        announce(filterName(created, layer.filters.length - 1) + " added");
        break;
      }
      case "select-filter": {
        const target2 = findFilter(layer, value);
        if (!target2 || layer.selectedId === target2.id) break;
        selectFilter(layer, target2.id);
        // The selection is part of the layer, so it survives a reload with the
        // preset it belongs to.
        saveNow();
        render();
        break;
      }
      case "toggle-filter": {
        const target2 = findFilter(layer, value);
        if (!target2) break;
        updateFilter(layer, target2.id, { active: !target2.active });
        saveNow();
        render();
        announceFilterState(target2);
        break;
      }
      case "delete-filter": {
        const target2 = findFilter(layer, value);
        if (!target2) break;
        const index = layer.filters.indexOf(target2);
        const name = filterName(target2, index < 0 ? 0 : index);
        if (!removeFilter(layer, target2.id)) {
          announce("Keep at least one filter");
          break;
        }
        saveNow();
        render();
        announce(name + " deleted");
        break;
      }
      case "toggle-active":
        // Same path as the Alt+M shortcut, so the pill, the switch and the
        // keyboard can never disagree about the state.
        toggleActive();
        break;
      case "toggle-follow": {
        if (!selected) break;
        const next = !selected.follow;
        updateFilter(layer, selected.id, { follow: next });
        if (next) snapFollowersToPointer();
        else {
          saveNow();
          render();
        }
        break;
      }
      case "set-shape": {
        if (!selected || selected.shape === value) break;
        updateFilter(layer, selected.id, { shape: value === "ellipse" ? "ellipse" : "rectangle" });
        saveNow();
        render();
        break;
      }
      case "set-mode": {
        if (!selected || selected.mode === value) break;
        const next = value === "reverse" ? "reverse" : "normal";
        updateFilter(layer, selected.id, { mode: next });
        saveNow();
        render();
        // Two reverse regions each hide everything outside themselves, so the
        // area left clear is only their intersection. Say so once, when the
        // second one is switched on.
        if (next === "reverse") {
          const reverseCount = layer.filters.filter(function (f) {
            return f.active && f.mode === "reverse";
          }).length;
          if (reverseCount > 1) {
            announce("Reverse on " + reverseCount + " filters: only their overlap stays clear");
            break;
          }
        }
        break;
      }
      case "set-fill": {
        if (!selected || selected.fill === value) break;
        if (value !== "blur" && value !== "solid" && value !== "pixelate") break;
        updateFilter(layer, selected.id, { fill: value });
        saveNow();
        render();
        break;
      }
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
        // Replacing the whole layer, not merging: the preset that was cleared
        // is gone, so there is nothing left to merge into.
        layer = resolveState(config, context.sceneId, context.studioId);
        persistConfig();
        render();
        announce("Preset cleared · " + sourceLabel());
        break;
      case "reset-defaults": {
        if (!selected) break;
        const index = layer.filters.indexOf(selected);
        const name = filterName(selected, index < 0 ? 0 : index);
        resetFilter(layer, selected.id);
        saveNow();
        render();
        announce(layer.filters.length > 1 ? name + " reset" : "Reset to defaults");
        break;
      }
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
    const f = currentFilter();
    if (!f) return;
    const value = clamp(parseInt(target.value, 10) || 0, 0, MAX_BLUR);
    f.blurAmount = value;
    const entry = rects.get(f.id);
    if (entry) entry.el.style.setProperty("--mf-blur", value + "px");
    const readout = panel && panel.querySelector('[data-action="blur-readout"]');
    if (readout) readout.textContent = value + "px";
  }

  function onChromeChange(e) {
    const target = e.target;
    if (target.dataset && target.dataset.action === "fill-color") {
      const f = currentFilter();
      if (f && /^#[0-9a-fA-F]{6}$/.test(target.value)) {
        updateFilter(layer, f.id, { fillColor: target.value });
        saveNow();
        renderFilters();
      }
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "blur-slider") return;
    // Slider release: persist the final blur amount. (State was already
    // updated by `input`; this just commits it to the layer.)
    const f = currentFilter();
    if (!f) return;
    updateFilter(layer, f.id, { blurAmount: f.blurAmount });
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
  // MosaicFilterShared.sanitizeFilter and the settings page, and a throwaway
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
    if (dragState) return;
    // Moving the pill must not drag the regions along with it.
    if (pillDrag) return;
    if (!player) return;
    if (!layer.filters.some(function (f) { return f.follow; })) return;
    // Defer the geometry to the scheduled render — see applyPendingFollow.
    pendingFollow = lastPointer;
    scheduleRender();
  }

  /**
   * Snap every following region to the last known cursor position and persist.
   * Follow is a per-region flag, so turning it on for one region must not move
   * the others; regions that are already following simply re-centre, which is
   * also what the user expects from toggling it on.
   */
  function snapFollowersToPointer() {
    if (!player) return;
    const pw = player.clientWidth;
    const ph = player.clientHeight;
    if (pw === 0 || ph === 0) {
      saveNow();
      render();
      return;
    }
    const pr = player.getBoundingClientRect();
    let cursorXPct, cursorYPct;
    if (lastPointer) {
      cursorXPct = (lastPointer.x - pr.left) / pw;
      cursorYPct = (lastPointer.y - pr.top) / ph;
    } else {
      cursorXPct = 0.5;
      cursorYPct = 0.5;
    }
    for (let i = 0; i < layer.filters.length; i++) {
      const f = layer.filters[i];
      if (!f.follow) continue;
      f.xPct = clamp(cursorXPct - f.widthPct / 2, 0, 1 - f.widthPct);
      f.yPct = clamp(cursorYPct - f.heightPct / 2, 0, 1 - f.heightPct);
    }
    renderFilters();
    saveNow();
    renderChrome();
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
    // Alt+M flips the selected filter without opening anything — the fastest
    // way to hide something, and the reason the collapsed state can stay
    // silent. Alt keeps the binding clear of video.js hotkeys (m = mute) and
    // of every plain-letter shortcut another plugin might claim.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat && (e.key === "m" || e.key === "M")) {
      if (isTypingTarget(e.target)) return;
      if (chrome === null || !player) return;
      e.preventDefault();
      toggleActive();
    }
  });

  // Re-position the regions on window resize so the percentages stay right.
  // The control bar is re-measured too: Stash's bar height changes with the
  // player size at some breakpoints.
  window.addEventListener("resize", function () {
    if (!player) return;
    syncPlayerMetrics();
    renderFilters();
    // A smaller frame can leave a dragged pill (and the panel under it) outside
    // the picture.
    placeChrome();
  });

  // Fullscreen swaps the player box for the viewport, so both the control-bar
  // offset and every region have to be recomputed.
  document.addEventListener("fullscreenchange", function () {
    if (!player) return;
    syncPlayerMetrics();
    renderFilters();
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
