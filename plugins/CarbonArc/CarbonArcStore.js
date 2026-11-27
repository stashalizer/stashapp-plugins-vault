/**
 * CarbonArcStore — the Carbon Arc theme's configuration and apply layer.
 *
 * The three options (signal colour, card density, preview brightness) are
 * declared in CarbonArc.yml under `settings:`. That means Stash draws them
 * under Settings > Plugins > Carbon Arc and stores them in the plugin
 * configuration itself, so this file only reads them: there is no
 * CommunityScriptsUI library in the picture, no second write path and no
 * `ui.requires` entry that could stop the theme's CSS from loading.
 *
 * Reading them is one GraphQL query, which cannot finish before the first
 * paint. So the last known value is mirrored to localStorage and applied
 * synchronously at parse time; the server value wins once it arrives. If the
 * server holds nothing (fresh install, settings cleared) the browser copy is
 * kept instead of being reset to the defaults.
 *
 * The options are applied as attributes on <html>, which the stylesheets key
 * off, so a change is a restyle rather than a reload. A custom signal colour
 * is written as inline custom properties on <html> — the only case that
 * cannot be a stylesheet block, because the value is not known at build time.
 *
 * `?carbonarc=off` stands the theme down for the tab: the stylesheet is
 * parked on a media type that never matches and nothing is applied, so Stash
 * looks exactly as it ships. `?carbonarc=on` brings it back.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var CONFIG_KEY = "CarbonArc";
  var STORAGE_KEY = "carbonArc.config.v2";
  var LEGACY_STORAGE_KEY = "carbonArc.config.v1";
  var OFF_KEY = "carbonArc.off";
  var URL_PARAM = "carbonarc";
  var VERSION = "0.3.0";

  var DEFAULTS = {
    accent: "arc",
    customSignal: "",
    density: "comfortable",
    dimPreviews: false,
  };

  var ACCENTS = ["arc", "patina", "dusk", "custom"];
  var DENSITIES = ["comfortable", "compact"];

  /**
   * The three shipped signals. The stylesheet half of each lives in
   * CarbonArcTokens.css; tests/carbon-arc.test.mjs fails if the two halves
   * drift, so change both together.
   */
  var ACCENT_COLORS = {
    arc: { hex: "#c2a176", ink: "#17140f" },
    patina: { hex: "#8aa79a", ink: "#0f1513" },
    dusk: { hex: "#a79cb8", ink: "#14111a" },
  };

  /* The page ground a signal has to stay legible against (`--ca-canvas`). */
  var GROUND = "#101213";
  var MIN_CONTRAST = 4.5;
  var BONE = "#e6e4de";
  var INK = "#17140f";

  /**
   * The id Stash installed the theme under: the yml basename, so a renamed
   * copy still works. Read off this script's own address while it loads —
   * `/plugin/<id>/javascript` — because the settings are looked up under that
   * key.
   */
  var PLUGIN_ID = (function () {
    var src = "";
    try {
      src = (document.currentScript && document.currentScript.src) || "";
    } catch (err) {
      src = "";
    }
    var m = src.match(/\/plugin\/([^/?#]+)\/javascript/);
    return m ? decodeURIComponent(m[1]) : CONFIG_KEY;
  })();

  /* --- kill switch ------------------------------------------------------ */

  function readSwitch() {
    var search = "";
    try {
      search = (window.location && window.location.search) || "";
    } catch (err) {
      search = "";
    }

    var asked = null;
    try {
      asked = new URLSearchParams(search).get(URL_PARAM);
    } catch (err) {
      var found = search.match(new RegExp("[?&]" + URL_PARAM + "=([a-z]+)"));
      asked = found ? found[1] : null;
    }

    try {
      if (asked === "off") window.sessionStorage.setItem(OFF_KEY, "1");
      else if (asked === "on") window.sessionStorage.removeItem(OFF_KEY);
      return window.sessionStorage.getItem(OFF_KEY) === "1";
    } catch (err) {
      // Private browsing can refuse sessionStorage; the address alone decides.
      return new RegExp("[?&]" + URL_PARAM + "=off\\b").test(search);
    }
  }

  var off = readSwitch();

  /**
   * Stash serves every plugin stylesheet as one response at
   * /plugin/<id>/css. Setting `disabled` before the file has finished
   * downloading does not hold — the browser attaches the sheet anyway when it
   * arrives — but pointing the link at a media type that never matches does
   * hold, so that is the one that counts.
   */
  function makePark() {
    var match = "/plugin/" + PLUGIN_ID + "/css";

    return function park() {
      if (typeof document.querySelectorAll !== "function") return false;
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      var found = false;

      Array.prototype.forEach.call(links, function (link) {
        var href = String((link.getAttribute && link.getAttribute("href")) || "");
        if (href.indexOf(match) === -1) return;
        if (link.media !== "not all") link.media = "not all";
        link.disabled = true;
        found = true;
      });

      return found;
    };
  }

  function parkStylesheet() {
    var park = makePark();
    var root = document && document.documentElement;
    if (root && root.classList && typeof root.classList.add === "function") {
      root.classList.add("ca-off");
    }
    park();

    // The link may not be in the page yet, and it may finish loading after
    // this runs: keep trying for three seconds and once more on load.
    var tries = 0;
    var timer = window.setInterval(function () {
      park();
      if (++tries > 60) window.clearInterval(timer);
    }, 50);
    window.addEventListener("load", park);
  }

  /* --- colour helpers --------------------------------------------------- */

  function hexToRgb(hex) {
    var value = String(hex || "").replace("#", "");
    if (value.length === 3) {
      value = value.charAt(0) + value.charAt(0) + value.charAt(1) + value.charAt(1) + value.charAt(2) + value.charAt(2);
    }
    if (!/^[0-9a-f]{6}$/i.test(value)) return null;
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }

  function channel(value) {
    var v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function luminance(rgb) {
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    var hi = Math.max(la, lb);
    var lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /**
   * A custom signal is accepted only when it reaches MIN_CONTRAST against the
   * page ground; anything else would paint an invisible focus ring and an
   * unreadable link. Returns "" for "not usable", which the caller reads as
   * "stay on the default signal" — never as an error state.
   */
  function normalizeSignal(value) {
    var raw = String(value || "").trim();
    var rgb = hexToRgb(raw);
    if (!rgb) return "";
    if (contrast(rgb, hexToRgb(GROUND)) < MIN_CONTRAST) return "";
    var hex = raw.toLowerCase().replace("#", "");
    return "#" + hex;
  }

  /** The ink that reads best on a signal-filled surface. */
  function inkFor(rgb) {
    return contrast(rgb, hexToRgb(INK)) >= contrast(rgb, hexToRgb(BONE)) ? INK : BONE;
  }

  /* --- config ----------------------------------------------------------- */

  function normalizeDim(raw) {
    if (typeof raw === "boolean") return raw;
    var value = String(raw == null ? "" : raw).trim().toLowerCase();
    if (value === "true" || value === "on" || value === "1" || value === "dimmed" || value === "dim") return true;
    if (value === "false" || value === "off" || value === "0" || value === "full") return false;
    return DEFAULTS.dimPreviews;
  }

  /**
   * Runs on every read and every write, so a hand-edited, older ("true")
   * or partially filled value cannot reach the DOM.
   */
  function normalize(raw) {
    var out = {
      accent: DEFAULTS.accent,
      customSignal: "",
      density: DEFAULTS.density,
      dimPreviews: DEFAULTS.dimPreviews,
    };
    if (!raw || typeof raw !== "object") return out;

    out.customSignal = normalizeSignal(raw.customSignal);

    var accent = String(raw.accent == null ? "" : raw.accent).trim().toLowerCase();
    if (ACCENTS.indexOf(accent) !== -1) out.accent = accent;
    // "custom" without a usable colour is not a state the theme can paint.
    if (out.accent === "custom" && !out.customSignal) out.accent = DEFAULTS.accent;

    var density = String(raw.density == null ? "" : raw.density).trim().toLowerCase();
    if (DENSITIES.indexOf(density) !== -1) out.density = density;

    out.dimPreviews = normalizeDim(raw.dimPreviews);
    return out;
  }

  function signalFor(config) {
    var settings = config || current;
    if (settings.accent === "custom" && settings.customSignal) {
      var rgb = hexToRgb(settings.customSignal);
      return {
        hex: settings.customSignal,
        rgb: rgb,
        rgbText: rgb.r + ", " + rgb.g + ", " + rgb.b,
        ink: inkFor(rgb),
      };
    }
    var shipped = ACCENT_COLORS[settings.accent] || ACCENT_COLORS[DEFAULTS.accent];
    var shippedRgb = hexToRgb(shipped.hex);
    return {
      hex: shipped.hex,
      rgb: shippedRgb,
      rgbText: shippedRgb.r + ", " + shippedRgb.g + ", " + shippedRgb.b,
      ink: shipped.ink,
    };
  }

  /* --- apply ------------------------------------------------------------ */

  var current = normalize(DEFAULTS);
  var listeners = [];

  function paintSignal(root, config) {
    var style = root.style;
    if (!style || typeof style.setProperty !== "function") return;

    var properties = ["--ca-arc", "--ca-arc-rgb", "--ca-arc-ink", "--ca-arc-12", "--ca-arc-24", "--ca-arc-40"];

    if (config.accent !== "custom" || !config.customSignal) {
      properties.forEach(function (name) {
        style.removeProperty(name);
      });
      return;
    }

    var signal = signalFor(config);
    var rgb = signal.rgbText;
    style.setProperty("--ca-arc", signal.hex);
    style.setProperty("--ca-arc-rgb", rgb);
    style.setProperty("--ca-arc-ink", signal.ink);
    style.setProperty("--ca-arc-12", "rgba(" + rgb + ", 0.12)");
    style.setProperty("--ca-arc-24", "rgba(" + rgb + ", 0.24)");
    style.setProperty("--ca-arc-40", "rgba(" + rgb + ", 0.4)");
  }

  function apply(config) {
    var settings = config || current;
    if (off) return settings;

    var root = document && document.documentElement;
    if (!root) return settings;

    root.setAttribute("data-ca-accent", settings.accent);
    root.setAttribute("data-ca-density", settings.density);
    root.setAttribute("data-ca-dim", settings.dimPreviews ? "on" : "off");
    root.setAttribute("data-ca-version", VERSION);
    if (root.classList && typeof root.classList.add === "function") {
      root.classList.add("ca-theme");
    }

    paintSignal(root, settings);
    return settings;
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

  function commit(next, options) {
    current = normalize(next);
    apply(current);
    if (!options || options.cache !== false) writeCache(current);
    notify();
    return current;
  }

  /* --- browser cache ---------------------------------------------------- */

  function readKey(key) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      // Private mode, disabled storage, corrupt JSON — all non-fatal.
      return null;
    }
  }

  function readCache() {
    return readKey(STORAGE_KEY) || readKey(LEGACY_STORAGE_KEY);
  }

  function writeCache(config) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* --- server read ------------------------------------------------------ */

  var QUERY = "query { configuration { plugins } }";

  function pickPlugin(all) {
    if (!all || typeof all !== "object") return null;
    if (all[PLUGIN_ID] && typeof all[PLUGIN_ID] === "object") return all[PLUGIN_ID];

    var wanted = PLUGIN_ID.toLowerCase();
    var keys = Object.keys(all);
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i].toLowerCase() === wanted && all[keys[i]] && typeof all[keys[i]] === "object") {
        return all[keys[i]];
      }
    }
    return null;
  }

  function hasSetting(raw) {
    if (!raw) return false;
    return Object.keys(DEFAULTS).some(function (key) {
      return Object.prototype.hasOwnProperty.call(raw, key);
    });
  }

  /**
   * Read the stored options. Never rejects: a failed query leaves whatever the
   * browser had, which is already painted.
   */
  function refresh() {
    if (off) return Promise.resolve(current);
    if (typeof fetch !== "function") return Promise.resolve(current);

    return fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (json) {
        var all = json && json.data && json.data.configuration && json.data.configuration.plugins;
        var mine = pickPlugin(all);
        // Nothing stored yet: keep the browser's copy rather than resetting.
        var next = hasSetting(mine) ? mine : readCache() || current;
        return commit(next);
      })
      .catch(function (err) {
        console.warn("CarbonArc: could not read the plugin settings, keeping the browser copy", err);
        return current;
      });
  }

  /**
   * Apply a change immediately, before Stash has saved it. The settings tiles
   * call this and then hand the value to Stash's own onChange, so the page
   * repaints on click and the saved value arrives separately.
   */
  function preview(patch) {
    if (off) return current;
    return commit(Object.assign({}, current, patch));
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function () {
      var index = listeners.indexOf(fn);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  /* --- login page CSS --------------------------------------------------- */

  /**
   * Stash does not load plugins before auth, so the sign-in page cannot be
   * themed by the plugin itself. What it does load is Stash's Custom CSS
   * (`<link rel="stylesheet" href="css">` in ui/login/login.html), so this
   * block is offered for copy-paste.
   *
   * Two rules shape it. Every selector starts with `body.login`, because
   * Stash loads that same Custom CSS into the app as well — anything broader
   * would restyle the app from a block meant for one screen. And every
   * selector is one the page really has: `body.login > .dialog > .card`,
   * `h6` headings, `.text-input.form-control`, `.login-error` and
   * `#login-button.btn.btn-primary`. `.login-page`, `.login-container`,
   * `.card-header`, `.form-label` and `p` do not exist there.
   *
   * No `!important` is needed: `body.login .x` outranks the sheet's own `.x`
   * and `.x:focus`, so the page keeps its cascade.
   */
  function loginCss(input) {
    // Accepts a config object or a bare accent key ("patina"), so a caller
    // does not have to build one just to ask for a different block.
    var config = normalize(typeof input === "string" ? { accent: input } : input);
    var signal = signalFor(config);

    return [
      "/* Carbon Arc — login page.",
      "   Paste into Settings > Interface > Custom CSS, then tick",
      "   \"Custom CSS enabled\". Every rule is scoped to body.login: Stash loads",
      "   this same sheet into the app, and nothing here should reach it. */",
      "",
      "/* The canvas behind the sign-in box. Safari on iOS tints its own bars",
      "   from <html>'s background, so the colour goes there, not on <body>. */",
      "@supports selector(:has(a)) {",
      "  html:has(body.login) {",
      "    min-height: 100%;",
      "    background-color: #101213;",
      "  }",
      "}",
      "",
      "body.login {",
      "  background: #101213 linear-gradient(to bottom, #1b1e20 0%, #101213 55%) no-repeat;",
      "  background-size: 100% 100vh;",
      "  color: " + BONE + ";",
      "  font-family: \"IBM Plex Sans\", \"Segoe UI\", system-ui, sans-serif;",
      "}",
      "",
      "body.login .dialog { padding: 0 15px; }",
      "",
      "body.login .card {",
      "  background-color: #16191b;",
      "  border: 1px solid #2a2e31;",
      "  border-radius: 6px;",
      "  box-shadow: 0 18px 48px -14px rgba(0, 0, 0, 0.62);",
      "  padding: 24px;",
      "}",
      "",
      "body.login h6 {",
      "  color: " + BONE + ";",
      "  font-weight: 500;",
      "  letter-spacing: -0.01em;",
      "}",
      "",
      "body.login .text-input {",
      "  background-color: #0c0e0f;",
      "  border: 1px solid #2a2e31;",
      "  border-radius: 4px;",
      "  box-shadow: none;",
      "  color: " + BONE + ";",
      "}",
      "",
      "body.login .text-input:focus,",
      "body.login .text-input[readonly] {",
      "  background-color: #0c0e0f;",
      "  border-color: rgba(" + signal.rgbText + ", 0.4);",
      "  box-shadow: 0 0 0 3px rgba(" + signal.rgbText + ", 0.12);",
      "}",
      "",
      "body.login .text-input::placeholder { color: #8c8f90; }",
      "",
      "/* A password manager's autofill paints the fields pale blue. */",
      "body.login .text-input:-webkit-autofill {",
      "  -webkit-box-shadow: 0 0 0 100px #0c0e0f inset;",
      "  -webkit-text-fill-color: " + BONE + ";",
      "  caret-color: " + BONE + ";",
      "}",
      "",
      "body.login .login-error { color: #c96a60; }",
      "",
      "body.login .btn-primary {",
      "  background-color: " + BONE + ";",
      "  border-color: " + BONE + ";",
      "  color: " + signal.ink + ";",
      "}",
      "",
      "body.login .btn-primary:hover,",
      "body.login .btn-primary:focus {",
      "  background-color: #d9d6ce;",
      "  border-color: #d9d6ce;",
      "}",
      "",
      "body.login .btn-primary:focus-visible {",
      "  outline: 2px solid " + signal.hex + ";",
      "  outline-offset: 2px;",
      "}",
      "",
      "body.login a { color: " + signal.hex + "; }",
    ].join("\n");
  }

  var LOGIN_CSS = loginCss(DEFAULTS);

  /* --- boot ------------------------------------------------------------- */

  if (off) {
    parkStylesheet();
    console.info("[CarbonArc] theme off for this tab (?carbonarc=on to bring it back)");
  } else {
    // Apply the last known options before the async read resolves, so the
    // first paint is already on the saved signal rather than the default one.
    apply(normalize(readCache() || DEFAULTS));
    refresh().catch(function (err) {
      console.warn("CarbonArc: failed to read the plugin settings", err);
    });
  }

  window.CarbonArcStore = {
    PLUGIN_ID: PLUGIN_ID,
    CONFIG_KEY: CONFIG_KEY,
    STORAGE_KEY: STORAGE_KEY,
    LEGACY_STORAGE_KEY: LEGACY_STORAGE_KEY,
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    ACCENTS: ACCENTS,
    DENSITIES: DENSITIES,
    ACCENT_COLORS: ACCENT_COLORS,
    GROUND: GROUND,
    MIN_CONTRAST: MIN_CONTRAST,
    off: off,
    LOGIN_CSS: LOGIN_CSS,
    loginCss: loginCss,
    signalFor: signalFor,
    normalizeSignal: normalizeSignal,
    normalize: normalize,
    contrast: function (a, b) {
      var first = hexToRgb(a);
      var second = hexToRgb(b);
      return first && second ? contrast(first, second) : 0;
    },
    apply: apply,
    preview: preview,
    refresh: refresh,
    subscribe: subscribe,
    get: function () {
      return current;
    },
  };
})();
