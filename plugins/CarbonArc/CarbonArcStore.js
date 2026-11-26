/**
 * CarbonArcStore — configuration for the Carbon Arc theme.
 *
 * A theme must not hard-require CommunityScriptsUILibrary: `ui.requires` is
 * treated as mandatory by Stash, and a missing entry would stop the theme's
 * CSS from loading at all. So the library is optional here:
 *
 *   - when `window.csLib` answers, config is read from and written to the
 *     plugin configuration (survives browser changes, shared by the server);
 *   - otherwise it falls back to localStorage (per browser), and the settings
 *     page says so.
 *
 * The three options are applied as data attributes on <html>, which the
 * stylesheet keys off. Defaults are applied synchronously at parse time so
 * the first paint already has the right accent.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var CONFIG_KEY = "CarbonArc";
  var STORAGE_KEY = "carbonArc.config.v1";
  var VERSION = "0.1.0";

  var DEFAULTS = {
    accent: "arc",
    density: "comfortable",
    dimPreviews: false,
  };

  var ACCENTS = ["arc", "patina", "dusk"];
  var DENSITIES = ["comfortable", "compact"];

  /**
   * CSS for the login page. Stash does not load plugins before login, so this
   * cannot be injected automatically — the settings page offers it as a
   * copy-paste block for Settings > Interface > Custom CSS.
   */
  var LOGIN_CSS = [
    "/* Carbon Arc — login page (paste into Custom CSS) */",
    ":root { color-scheme: dark; }",
    "body, html { background: #101213 !important; color: #e6e4de !important; }",
    "body { font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif; }",
    ".login-page, .login-container, .card { background: #16191b !important; border-color: #2a2e31 !important; }",
    ".card-header, .card-footer { background: transparent !important; border-color: #2a2e31 !important; }",
    "h1, h2, h3, h4, label, .form-label { color: #e6e4de !important; }",
    "p, .text-muted, small { color: #a9aba8 !important; }",
    ".form-control { background: #0c0e0f !important; border: 1px solid #2a2e31 !important; color: #e6e4de !important; }",
    ".form-control:focus { border-color: rgba(194,161,118,.4) !important; box-shadow: 0 0 0 3px rgba(194,161,118,.12) !important; }",
    ".btn-primary { background: #e6e4de !important; border-color: #e6e4de !important; color: #17140f !important; }",
    ".btn-primary:hover, .btn-primary:focus { background: #d9d6ce !important; border-color: #d9d6ce !important; }",
    "a { color: #c2a176 !important; }",
  ].join("\n");

  var memoryConfig = null;
  var current = normalize(DEFAULTS);
  var listeners = [];

  function normalize(raw) {
    var out = {
      accent: DEFAULTS.accent,
      density: DEFAULTS.density,
      dimPreviews: DEFAULTS.dimPreviews,
    };
    if (!raw || typeof raw !== "object") return out;

    if (ACCENTS.indexOf(raw.accent) !== -1) out.accent = raw.accent;
    if (DENSITIES.indexOf(raw.density) !== -1) out.density = raw.density;
    if (typeof raw.dimPreviews === "boolean") out.dimPreviews = raw.dimPreviews;
    else if (raw.dimPreviews === "true") out.dimPreviews = true;
    else if (raw.dimPreviews === "false") out.dimPreviews = false;

    return out;
  }

  function hasCsLib() {
    return !!(
      window.csLib &&
      typeof window.csLib.getConfiguration === "function" &&
      typeof window.csLib.setConfiguration === "function"
    );
  }

  function readLocal() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      // Private mode, disabled storage, corrupt JSON — all non-fatal.
      return null;
    }
  }

  function writeLocal(config) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      return true;
    } catch (err) {
      return false;
    }
  }

  function apply(config) {
    var root = document.documentElement;
    if (!root) return;
    root.setAttribute("data-ca-accent", config.accent);
    root.setAttribute("data-ca-density", config.density);
    root.setAttribute("data-ca-dim", config.dimPreviews ? "on" : "off");
    root.setAttribute("data-ca-version", VERSION);
    root.classList.add("ca-theme");
  }

  function notify() {
    listeners.slice().forEach(function (fn) {
      try {
        fn(current);
      } catch (err) {
        console.error("CarbonArc: listener failed", err);
      }
    });
  }

  function set(config, options) {
    current = normalize(config);
    apply(current);
    if (!options || options.persist !== false) writeLocal(current);
    notify();
    return current;
  }

  /**
   * Read config. Prefers the plugin configuration, falls back to the browser,
   * then to in-memory state. Never rejects.
   */
  function load() {
    if (!hasCsLib()) {
      return Promise.resolve(set(readLocal() || memoryConfig || DEFAULTS));
    }

    return window.csLib
      .getConfiguration(CONFIG_KEY)
      .then(function (stored) {
        var fromPlugin =
          stored && typeof stored === "object" && Object.keys(stored).length > 0
            ? stored
            : null;
        return set(fromPlugin || readLocal() || memoryConfig || DEFAULTS);
      })
      .catch(function (err) {
        console.warn("CarbonArc: could not read plugin configuration, using browser storage", err);
        return set(readLocal() || memoryConfig || DEFAULTS);
      });
  }

  /**
   * Persist. Always writes the browser copy; writes the plugin configuration
   * too when the UI library is present.
   *
   * Resolves with { config, scope } where scope is "plugin" or "browser" so
   * the settings page can tell the user where the value lives.
   */
  function save(next) {
    var config = set(next, { persist: true });
    var browserSaved = writeLocal(config);

    if (!hasCsLib()) {
      return Promise.resolve({ config: config, scope: "browser", browserSaved: browserSaved });
    }

    return window.csLib
      .setConfiguration(CONFIG_KEY, config)
      .then(function () {
        return { config: config, scope: "plugin", browserSaved: browserSaved };
      })
      .catch(function (err) {
        console.error("CarbonArc: could not write plugin configuration", err);
        return { config: config, scope: "browser", browserSaved: browserSaved, error: err };
      });
  }

  function reset() {
    return save(DEFAULTS);
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function () {
      var index = listeners.indexOf(fn);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  // Apply defaults before the async read resolves, so the first paint is on
  // brand rather than Stash's default blue.
  apply(current);

  window.CarbonArcStore = {
    CONFIG_KEY: CONFIG_KEY,
    STORAGE_KEY: STORAGE_KEY,
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    ACCENTS: ACCENTS,
    DENSITIES: DENSITIES,
    LOGIN_CSS: LOGIN_CSS,
    normalize: normalize,
    apply: apply,
    load: load,
    save: save,
    reset: reset,
    set: set,
    subscribe: subscribe,
    hasCsLib: hasCsLib,
    get: function () {
      return current;
    },
  };

  // Kick off the async read; nobody has to await it.
  load().catch(function (err) {
    console.error("CarbonArc: failed to load configuration", err);
  });
})();
