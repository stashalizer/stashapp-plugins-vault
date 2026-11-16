/**
 * MosaicFilterShared — shared constants and pure functions used by both
 * MosaicFilter.js (overlay) and MosaicFilterSettings.js (settings page).
 *
 * This file MUST be loaded FIRST in the manifest's ui.javascript list so
 * that window.MosaicFilterShared is available before either consumer runs.
 */
(function () {
  "use strict";

  var FALLBACK_DEFAULTS = {
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
    fill: 'blur',
    fillColor: '#000000',
    pixelSize: 16,
  };

  var MIN_SIZE_PCT = 0.05;
  var MAX_BLUR = 80;
  var MAX_PRESETS = 1000;
  var CONFIG_KEY = "MosaicFilter";

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

  function sanitizeState(s) {
    const d = FALLBACK_DEFAULTS;
    const out = {
      blurAmount: isFiniteNumber(s && s.blurAmount) ? s.blurAmount : d.blurAmount,
      widthPct: isFiniteNumber(s && s.widthPct) ? s.widthPct : d.widthPct,
      heightPct: isFiniteNumber(s && s.heightPct) ? s.heightPct : d.heightPct,
      xPct: isFiniteNumber(s && s.xPct) ? s.xPct : d.xPct,
      yPct: isFiniteNumber(s && s.yPct) ? s.yPct : d.yPct,
      active: typeof (s && s.active) === "boolean" ? s.active : d.active,
      follow: typeof (s && s.follow) === "boolean" ? s.follow : d.follow,
      shape: (typeof (s && s.shape) === 'string' && (s.shape === 'rectangle' || s.shape === 'ellipse')) ? s.shape : d.shape,
      mode: (typeof (s && s.mode) === 'string' && (s.mode === 'normal' || s.mode === 'reverse')) ? s.mode : d.mode,
      fill: (typeof (s && s.fill) === 'string' && (s.fill === 'blur' || s.fill === 'solid' || s.fill === 'pixelate')) ? s.fill : d.fill,
      fillColor: (typeof (s && s.fillColor) === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.fillColor)) ? s.fillColor : d.fillColor,
      pixelSize: isFiniteNumber(s && s.pixelSize) ? s.pixelSize : d.pixelSize,
    };
    out.blurAmount = clamp(out.blurAmount, 0, MAX_BLUR);
    out.widthPct = clamp(out.widthPct, MIN_SIZE_PCT, 1);
    out.heightPct = clamp(out.heightPct, MIN_SIZE_PCT, 1);
    out.xPct = clamp(out.xPct, 0, 1 - out.widthPct);
    out.yPct = clamp(out.yPct, 0, 1 - out.heightPct);
    out.pixelSize = clamp(Math.round(out.pixelSize), 4, 64);
    return out;
  }

  function sanitizePresetMap(map) {
    const out = {};
    if (!map || typeof map !== "object") return out;
    const keys = Object.keys(map).slice(0, MAX_PRESETS);
    for (const key of keys) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
      const preset = map[key];
      if (!preset || typeof preset !== "object") continue;
      out[key] = sanitizeState(preset);
    }
    return out;
  }

  function makeDefaultConfig() {
    return {
      default: makeDefaultState(),
      scenePresets: {},
      studioPresets: {},
    };
  }

  function normalizeConfig(stored) {
    if (!stored || typeof stored !== "object") return makeDefaultConfig();
    if (stored.default && typeof stored.default === "object") {
      return {
        default: sanitizeState(stored.default),
        scenePresets: sanitizePresetMap(stored.scenePresets),
        studioPresets: sanitizePresetMap(stored.studioPresets),
      };
    }
    // Legacy 0.2.x: { defaults, scenes }. Use defaults, drop scenes.
    if (stored.defaults && typeof stored.defaults === "object") {
      return {
        default: sanitizeState(stored.defaults),
        scenePresets: sanitizePresetMap(stored.scenePresets),
        studioPresets: sanitizePresetMap(stored.studioPresets),
      };
    }
    // Legacy flat config: every key belonged to the single global filter.
    return {
      default: sanitizeState(stored),
      scenePresets: {},
      studioPresets: {},
    };
  }

  // Kept for callers that only want the global default. New code should use
  // normalizeConfig + resolveState so presets are honoured.
  function mergeStored(stored) {
    return normalizeConfig(stored).default;
  }

  function resolveState(config, sceneId, studioId) {
    const normalized = normalizeConfig(config);
    const out = Object.assign({}, normalized.default);
    if (studioId && normalized.studioPresets[String(studioId)]) {
      Object.assign(out, normalized.studioPresets[String(studioId)]);
    }
    if (sceneId && normalized.scenePresets[String(sceneId)]) {
      Object.assign(out, normalized.scenePresets[String(sceneId)]);
    }
    return sanitizeState(out);
  }

  function makePreset(state) {
    return sanitizeState(state);
  }

  function presetSource(config, sceneId, studioId) {
    const normalized = normalizeConfig(config);
    if (sceneId && normalized.scenePresets[String(sceneId)]) return "scene";
    if (studioId && normalized.studioPresets[String(studioId)]) return "studio";
    return "default";
  }

  window.MosaicFilterShared = {
    FALLBACK_DEFAULTS: FALLBACK_DEFAULTS,
    MIN_SIZE_PCT: MIN_SIZE_PCT,
    MAX_BLUR: MAX_BLUR,
    MAX_PRESETS: MAX_PRESETS,
    CONFIG_KEY: CONFIG_KEY,
    clamp: clamp,
    isFiniteNumber: isFiniteNumber,
    makeDefaultState: makeDefaultState,
    makeDefaultConfig: makeDefaultConfig,
    sanitizeState: sanitizeState,
    sanitizePresetMap: sanitizePresetMap,
    normalizeConfig: normalizeConfig,
    mergeStored: mergeStored,
    resolveState: resolveState,
    makePreset: makePreset,
    presetSource: presetSource,
  };
})();
