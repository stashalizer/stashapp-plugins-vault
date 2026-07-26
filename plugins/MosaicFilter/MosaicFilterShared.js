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
  };

  var MIN_SIZE_PCT = 0.05;
  var MAX_BLUR = 80;
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

  window.MosaicFilterShared = {
    FALLBACK_DEFAULTS: FALLBACK_DEFAULTS,
    MIN_SIZE_PCT: MIN_SIZE_PCT,
    MAX_BLUR: MAX_BLUR,
    CONFIG_KEY: CONFIG_KEY,
    clamp: clamp,
    isFiniteNumber: isFiniteNumber,
    makeDefaultState: makeDefaultState,
    mergeStored: mergeStored,
    sanitizeState: sanitizeState,
  };
})();
