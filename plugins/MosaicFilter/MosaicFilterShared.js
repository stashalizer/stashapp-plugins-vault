/**
 * MosaicFilterShared — shared constants, the multi-filter data model and the
 * pure helpers used by both MosaicFilter.js (overlay) and
 * MosaicFilterSettings.js (settings page).
 *
 * This file MUST be loaded FIRST in the manifest's ui.javascript list so
 * that window.MosaicFilterShared is available before either consumer runs.
 *
 * Data model
 * ----------
 * A persisted *layer* (a global default, a studio preset or a scene preset)
 * owns a list of independent filter regions plus the id of the one currently
 * being edited:
 *
 *   layer    = { filters: [filter, ...], selectedId: string }
 *   filter   = { id, name, blurAmount, widthPct, heightPct, xPct, yPct,
 *                active, follow, shape, mode, fill, fillColor, pixelSize }
 *   config   = { default: layer, scenePresets: { [id]: layer },
 *                studioPresets: { [id]: layer } }
 *
 * `id` is a stable internal handle: it keys the DOM nodes in the overlay and
 * must never change once a filter exists, or a drag in flight would start
 * writing into a different region. `sanitizeFilter` therefore pins it, and the
 * layer CRUD helpers below never rewrite it.
 *
 * A layer always holds at least one filter (an empty or missing list is
 * upgraded to a single default filter) and at most MAX_FILTERS. Both
 * invariants are enforced by `sanitizeLayer`, not by the callers, so the
 * overlay can assume `layer.filters.length >= 1` everywhere.
 *
 * Legacy compatibility
 * --------------------
 * Versions <= 0.7.0 persisted one flat filter per layer, so every layer is
 * read through `sanitizeLayer`, which accepts all of these shapes:
 *
 *   { filters: [...] }                      current
 *   { blurAmount: 10, widthPct: 0.25, ... } 0.3.x - 0.7.0 flat layer
 *   { default: <flat> }                     0.3.x - 0.7.0 config
 *   { defaults: <flat>, scenes: {...} }     <= 0.2.x config ("scenes" dropped)
 *   <flat>                                  <= 0.2.x flat config
 *
 * The upgrade is lossless and automatic on read; the next save writes the
 * current shape. Nothing is ever migrated destructively, so a user who
 * downgrades still finds their single filter where they left it.
 */
(function () {
  "use strict";

  // Parameters of ONE filter. Every key here is part of the persisted schema
  // and is expected by sanitizeFilter; add new per-filter fields here and the
  // upgrade path (and both UIs) pick them up without further changes.
  var FALLBACK_DEFAULTS = {
    blurAmount: 10,
    widthPct: 0.25,
    heightPct: 0.25,
    xPct: 0.1,
    yPct: 0.1,
    active: false,
    // follow defaults to false: the user opts in to cursor-tracking from
    // the control bar. The region is stationary until they toggle it on.
    follow: false,
    shape: 'rectangle',
    mode: 'normal',
    fill: 'blur',
    fillColor: '#000000',
    pixelSize: 16,
  };

  var MIN_SIZE_PCT = 0.05;
  var MAX_BLUR = 80;
  var MAX_PRESETS = 1000;
  // Upper bound on regions per layer. Not a technical limit — the DOM and the
  // mask compositing would happily take more — but a config that no human
  // built is a config nobody can edit, and each reverse-mode region adds a
  // full-player backdrop-filter layer.
  var MAX_FILTERS = 12;
  var CONFIG_KEY = "MosaicFilter";
  var MAX_NAME_LEN = 40;

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }

  var idSeq = 0;

  // Ids only have to be unique inside one layer and stable for the lifetime of
  // the page. `taken` lets the caller avoid a collision without relying on the
  // random part alone.
  function newFilterId(taken) {
    var id;
    do {
      idSeq += 1;
      id = "f" + Date.now().toString(36) + idSeq.toString(36) +
        Math.random().toString(36).slice(2, 6);
    } while (taken && taken[id]);
    return id;
  }

  // Ids double as CSS attribute selectors (`[data-value="<id>"]`) and object
  // keys, so anything outside this alphabet is replaced rather than escaped.
  var ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

  /**
   * Sanitize one filter. Accepts a partial object, a legacy flat state, or
   * nothing at all. `forcedId` keeps an existing id alive across an update.
   */
  function sanitizeFilter(input, forcedId) {
    var s = (input && typeof input === "object") ? input : {};
    var d = FALLBACK_DEFAULTS;
    var id = forcedId ||
      (typeof s.id === "string" && ID_PATTERN.test(s.id) ? s.id : newFilterId());

    var out = {
      id: id,
      // A name is optional. Empty (or whitespace) means "show the region's
      // position instead" — see filterName — which keeps the default labels
      // numbered correctly after a deletion and lets the settings page's name
      // field be cleared without the model immediately rewriting it.
      name: typeof s.name === "string" ? s.name.slice(0, MAX_NAME_LEN) : "",
      blurAmount: isFiniteNumber(s.blurAmount) ? s.blurAmount : d.blurAmount,
      widthPct: isFiniteNumber(s.widthPct) ? s.widthPct : d.widthPct,
      heightPct: isFiniteNumber(s.heightPct) ? s.heightPct : d.heightPct,
      xPct: isFiniteNumber(s.xPct) ? s.xPct : d.xPct,
      yPct: isFiniteNumber(s.yPct) ? s.yPct : d.yPct,
      active: typeof s.active === "boolean" ? s.active : d.active,
      follow: typeof s.follow === "boolean" ? s.follow : d.follow,
      shape: (typeof s.shape === 'string' && (s.shape === 'rectangle' || s.shape === 'ellipse')) ? s.shape : d.shape,
      mode: (typeof s.mode === 'string' && (s.mode === 'normal' || s.mode === 'reverse')) ? s.mode : d.mode,
      fill: (typeof s.fill === 'string' && (s.fill === 'blur' || s.fill === 'solid' || s.fill === 'pixelate')) ? s.fill : d.fill,
      fillColor: (typeof s.fillColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.fillColor)) ? s.fillColor : d.fillColor,
      pixelSize: isFiniteNumber(s.pixelSize) ? s.pixelSize : d.pixelSize,
    };
    out.blurAmount = clamp(out.blurAmount, 0, MAX_BLUR);
    out.widthPct = clamp(out.widthPct, MIN_SIZE_PCT, 1);
    out.heightPct = clamp(out.heightPct, MIN_SIZE_PCT, 1);
    out.xPct = clamp(out.xPct, 0, 1 - out.widthPct);
    out.yPct = clamp(out.yPct, 0, 1 - out.heightPct);
    out.pixelSize = clamp(Math.round(out.pixelSize), 4, 64);
    return out;
  }

  /** One filter with every field at its built-in default. */
  function makeDefaultState() {
    return sanitizeFilter(FALLBACK_DEFAULTS);
  }

  /** Kept for callers that pre-date the layer model: same as sanitizeFilter. */
  function sanitizeState(s) {
    return sanitizeFilter(s);
  }

  // Split a persisted value into the two things a layer is made of, without
  // sanitizing. Anything that is not recognisably a layer is treated as one
  // legacy flat filter, which is what every pre-0.8.0 write looked like.
  function layerParts(input) {
    if (input && typeof input === "object" && Array.isArray(input.filters)) {
      return { filters: input.filters, selectedId: input.selectedId };
    }
    return { filters: [input], selectedId: null };
  }

  /** Sanitize a whole layer: filter list, unique ids, valid selection. */
  function sanitizeLayer(input) {
    var parts = layerParts(input);
    var list = parts.filters;
    if (!Array.isArray(list) || list.length === 0) list = [null];
    if (list.length > MAX_FILTERS) list = list.slice(0, MAX_FILTERS);

    var filters = [];
    var taken = {};
    for (var i = 0; i < list.length; i++) {
      var f = sanitizeFilter(list[i]);
      // A duplicated id would make two regions share one DOM node and one
      // drag target, so the later one is re-keyed rather than dropped.
      while (taken[f.id]) f.id = newFilterId(taken);
      taken[f.id] = true;
      filters.push(f);
    }

    var selectedId = typeof parts.selectedId === "string" ? parts.selectedId : null;
    if (!selectedId || !taken[selectedId]) selectedId = filters[0].id;
    return { filters: filters, selectedId: selectedId };
  }

  /** A layer holding exactly one fresh filter. */
  function makeDefaultLayer() {
    return sanitizeLayer(null);
  }

  function sanitizePresetMap(map) {
    var out = {};
    if (!map || typeof map !== "object") return out;
    var keys = Object.keys(map).slice(0, MAX_PRESETS);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
      var preset = map[key];
      if (!preset || typeof preset !== "object") continue;
      out[key] = sanitizeLayer(preset);
    }
    return out;
  }

  function makeDefaultConfig() {
    return {
      default: makeDefaultLayer(),
      scenePresets: {},
      studioPresets: {},
    };
  }

  function normalizeConfig(stored) {
    if (!stored || typeof stored !== "object") return makeDefaultConfig();
    // 0.3.x - 0.7.0 wrapped the single filter in `default`; <= 0.2.x called it
    // `defaults` and also carried a `scenes` map, which is dropped on purpose
    // (it was never adopted by the overlay). Otherwise every top-level key was
    // one flat filter.
    var src = stored;
    if (stored.default && typeof stored.default === "object") src = stored.default;
    else if (stored.defaults && typeof stored.defaults === "object") src = stored.defaults;
    return {
      default: sanitizeLayer(src),
      scenePresets: sanitizePresetMap(stored.scenePresets),
      studioPresets: sanitizePresetMap(stored.studioPresets),
    };
  }

  // Kept for callers that only want the global default layer. New code should
  // use normalizeConfig + resolveState so presets are honoured.
  function mergeStored(stored) {
    return normalizeConfig(stored).default;
  }

  /**
   * Resolve the effective layer for a scene. A preset REPLACES the layer below
   * it rather than merging field by field: a preset is always written whole
   * (makePresetLayer), so merging could only ever resurrect a filter list from
   * the layer below that the user deliberately replaced.
   *
   * The result is a fresh object graph — editing it never writes through into
   * `config`, which is what keeps the alternate presets intact until the user
   * explicitly saves.
   */
  function resolveState(config, sceneId, studioId) {
    var normalized = normalizeConfig(config);
    if (sceneId && normalized.scenePresets[String(sceneId)]) {
      return sanitizeLayer(normalized.scenePresets[String(sceneId)]);
    }
    if (studioId && normalized.studioPresets[String(studioId)]) {
      return sanitizeLayer(normalized.studioPresets[String(studioId)]);
    }
    return sanitizeLayer(normalized.default);
  }

  function makePreset(state) {
    return sanitizeFilter(state);
  }

  /** A sanitized, detached copy of a layer, ready to be stored in a preset. */
  function makePresetLayer(layer) {
    return sanitizeLayer(layer);
  }

  function presetSource(config, sceneId, studioId) {
    var normalized = normalizeConfig(config);
    if (sceneId && normalized.scenePresets[String(sceneId)]) return "scene";
    if (studioId && normalized.studioPresets[String(studioId)]) return "studio";
    return "default";
  }

  // ---------------------------------------------------------------------------
  // Layer operations — the only place a filter list is edited.
  //
  // Both surfaces go through these, so "add" means the same thing in the
  // overlay and on the settings page, and the invariants (>= 1 filter, unique
  // ids, valid selection, per-filter isolation) are enforced in one place.
  // Each helper mutates the layer it is given and returns the affected filter,
  // matching the way the overlay already edits its effective layer in place.
  // ---------------------------------------------------------------------------

  function findFilter(layer, id) {
    if (!layer || !Array.isArray(layer.filters)) return null;
    for (var i = 0; i < layer.filters.length; i++) {
      if (layer.filters[i].id === id) return layer.filters[i];
    }
    return null;
  }

  /** The filter the panel edits. Never null for a sanitized layer. */
  function selectedFilter(layer) {
    if (!layer || !Array.isArray(layer.filters) || layer.filters.length === 0) return null;
    return findFilter(layer, layer.selectedId) || layer.filters[0];
  }

  function selectFilter(layer, id) {
    var target = findFilter(layer, id);
    if (target) layer.selectedId = target.id;
    return target || selectedFilter(layer);
  }

  /**
   * Append a filter and select it. Returns null when the layer is at
   * MAX_FILTERS, so the caller can say so instead of silently dropping the
   * request.
   */
  function addFilter(layer, overrides) {
    if (!layer || !Array.isArray(layer.filters)) return null;
    if (layer.filters.length >= MAX_FILTERS) return null;
    var taken = {};
    for (var i = 0; i < layer.filters.length; i++) taken[layer.filters[i].id] = true;
    var seed = Object.assign({}, overrides || {});
    seed.id = newFilterId(taken);
    var filter = sanitizeFilter(seed);
    layer.filters.push(filter);
    layer.selectedId = filter.id;
    return filter;
  }

  /**
   * Merge a patch into one filter and re-sanitize it. The id is pinned and the
   * object identity is preserved, so a caller holding a reference (or a drag in
   * flight) keeps writing to the same filter.
   */
  function updateFilter(layer, id, patch) {
    var filter = findFilter(layer, id);
    if (!filter) return null;
    var index = layer.filters.indexOf(filter);
    var merged = Object.assign({}, filter, patch || {});
    var clean = sanitizeFilter(merged, filter.id);
    // Every key of `filter` already exists in `clean`, so this cannot leave a
    // stale field behind.
    Object.assign(filter, clean);
    return filter;
  }

  /** Reset one filter's parameters, keeping its id and name. */
  function resetFilter(layer, id) {
    var filter = findFilter(layer, id);
    if (!filter) return null;
    var clean = sanitizeFilter(FALLBACK_DEFAULTS, filter.id);
    clean.name = filter.name;
    Object.assign(filter, clean);
    return filter;
  }

  // How far a newly added region is offset from the one it was cloned from, so
  // it does not land exactly on top of it.
  var NEW_FILTER_OFFSET = 0.06;

  function nudge(value, size) {
    var room = Math.max(0, 1 - size);
    var forward = value + NEW_FILTER_OFFSET;
    if (forward <= room) return forward;
    return Math.max(0, value - NEW_FILTER_OFFSET);
  }

  /**
   * Add a region modelled on the selected one. Both surfaces use this so "Add
   * filter" produces the same result in the overlay and on the settings page:
   * same size, effect and colour, nudged diagonally so it is visible next to
   * its parent, and always active — a new region the user cannot see reads as
   * a no-op.
   */
  function spawnFilter(layer) {
    var base = selectedFilter(layer) || makeDefaultState();
    return addFilter(layer, {
      widthPct: base.widthPct,
      heightPct: base.heightPct,
      xPct: nudge(base.xPct, base.widthPct),
      yPct: nudge(base.yPct, base.heightPct),
      blurAmount: base.blurAmount,
      shape: base.shape,
      mode: base.mode,
      fill: base.fill,
      fillColor: base.fillColor,
      pixelSize: base.pixelSize,
      active: true,
      follow: false,
    });
  }

  /**
   * Remove one filter and move the selection to a neighbour. Refuses to remove
   * the last one: a layer with no filters has nothing to edit and nothing to
   * select, and every caller would have to special-case it.
   */
  function removeFilter(layer, id) {
    if (!layer || !Array.isArray(layer.filters)) return false;
    if (layer.filters.length <= 1) return false;
    var index = -1;
    for (var i = 0; i < layer.filters.length; i++) {
      if (layer.filters[i].id === id) { index = i; break; }
    }
    if (index < 0) return false;
    layer.filters.splice(index, 1);
    if (layer.selectedId === id) {
      layer.selectedId = layer.filters[Math.min(index, layer.filters.length - 1)].id;
    }
    return true;
  }

  /**
   * Display name: the user's label if there is one, otherwise the region's
   * position. The fallback is positional on purpose — a renamed region keeps
   * its name wherever it moves in the list, and an unnamed one always matches
   * the row the user is looking at.
   */
  function filterName(filter, index) {
    if (filter && typeof filter.name === "string" && filter.name.trim()) return filter.name;
    return "Filter " + ((index | 0) + 1);
  }

  window.MosaicFilterShared = {
    FALLBACK_DEFAULTS: FALLBACK_DEFAULTS,
    MIN_SIZE_PCT: MIN_SIZE_PCT,
    MAX_BLUR: MAX_BLUR,
    MAX_PRESETS: MAX_PRESETS,
    MAX_FILTERS: MAX_FILTERS,
    MAX_NAME_LEN: MAX_NAME_LEN,
    CONFIG_KEY: CONFIG_KEY,
    clamp: clamp,
    isFiniteNumber: isFiniteNumber,
    makeDefaultState: makeDefaultState,
    makeDefaultLayer: makeDefaultLayer,
    makeDefaultConfig: makeDefaultConfig,
    sanitizeState: sanitizeState,
    sanitizeFilter: sanitizeFilter,
    sanitizeLayer: sanitizeLayer,
    sanitizePresetMap: sanitizePresetMap,
    normalizeConfig: normalizeConfig,
    mergeStored: mergeStored,
    resolveState: resolveState,
    makePreset: makePreset,
    makePresetLayer: makePresetLayer,
    presetSource: presetSource,
    findFilter: findFilter,
    selectedFilter: selectedFilter,
    selectFilter: selectFilter,
    addFilter: addFilter,
    spawnFilter: spawnFilter,
    updateFilter: updateFilter,
    resetFilter: resetFilter,
    removeFilter: removeFilter,
    filterName: filterName,
  };
})();
