/**
 * CarbonArc — the theme's own modules.
 *
 *   node --test "tests/**\/*.test.mjs"
 *
 * (Do not write the recursive test glob unescaped in this header: the
 * star-slash inside it closes the block comment. See AGENTS.md.)
 *
 * No jsdom, no React runtime: CarbonArcStore.js is a browser IIFE, so it runs
 * in a node:vm sandbox holding the handful of globals it touches. The
 * stylesheet and manifest assertions read the files directly.
 *
 * What each group guards, and why it is worth a test:
 *
 *   1. First paint carries the cached options. The flash this prevents is
 *      invisible in review: it needs a browser, a saved non-default signal and
 *      a slow query to show up.
 *   2. The server value wins, and an empty server value does not wipe the
 *      browser's copy.
 *   3. normalize() — a hand-edited or 0.2-era value cannot reach the DOM, and a
 *      custom signal under 4.5:1 is refused instead of painted.
 *   4. The login block — every selector is scoped to body.login. Stash loads
 *      the same Custom CSS into the app, so one unscoped `p { color }` repaints
 *      every paragraph in Stash.
 *   5. The palette lives in two halves (ACCENT_COLORS here, the signal blocks
 *      in CarbonArcTokens.css) and nothing but a test keeps them equal.
 *   6. The manifest — settings match DEFAULTS, the tokens load first, the
 *      fonts go through the assets map instead of being inlined.
 *   7. The kill switch — `?carbonarc=off` paints nothing and parks the sheet.
 *   8. Hover-only rules stay behind a hover-capable pointer.
 *   9. The Settings > Tools launcher row — one shape per entry, and the two
 *      guards that keep a stretched link off a row's own controls.
 *  10. The select caret — Stash and this theme both paint it with a
 *      `background` shorthand, so it disappears on any select with a class
 *      unless the rule that draws it outranks both.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugins = path.join(here, "..", "plugins");
const read = (...parts) => readFileSync(path.join(plugins, ...parts), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const PLUGIN = "CarbonArc";
const SCRIPT_SRC = "http://stash.local/plugin/CarbonArc/javascript";

/** A stylesheet link as Stash renders it, so the kill switch has a target. */
function makeLink(href) {
  return {
    href,
    media: "all",
    disabled: false,
    getAttribute(name) {
      return name === "href" ? this.href : null;
    },
  };
}

/**
 * Runs CarbonArcStore.js in a sandbox and returns what it painted.
 *
 * `pending` (the default fetch) never resolves, which is the real shape of
 * the first paint: the synchronous half has finished, the query has not.
 */
function boot(options = {}) {
  const {
    search = "",
    cache = null,
    cacheKey = "carbonArc.config.v3",
    plugins: stored = null,
    pending = false,
    links = [],
  } = options;

  const local = new Map();
  if (cache) local.set(cacheKey, JSON.stringify(cache));
  const session = new Map();

  const localStorage = {
    getItem: (key) => (local.has(key) ? local.get(key) : null),
    setItem: (key, value) => local.set(key, String(value)),
    removeItem: (key) => local.delete(key),
  };
  const sessionStorage = {
    getItem: (key) => (session.has(key) ? session.get(key) : null),
    setItem: (key, value) => session.set(key, String(value)),
    removeItem: (key) => session.delete(key),
  };

  const style = {};
  const writes = { attrs: 0, styles: 0 };
  const classes = new Set();
  const documentElement = {
    attrs: {},
    style: {
      setProperty: (name, value) => {
        style[name] = value;
        writes.styles += 1;
      },
      removeProperty: (name) => {
        delete style[name];
        writes.styles += 1;
      },
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      writes.attrs += 1;
    },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    classList: {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
    },
  };

  const document = {
    currentScript: { src: SCRIPT_SRC },
    documentElement,
    querySelectorAll: (selector) => (selector === 'link[rel="stylesheet"]' ? links : []),
    body: { appendChild() {}, removeChild() {} },
  };

  const fetchImpl = pending
    ? () => new Promise(() => {})
    : () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { configuration: { plugins: stored || {} } } }),
        });

  const window = {
    localStorage,
    sessionStorage,
    location: { search },
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
  };

  const sandbox = { window, document, console, fetch: fetchImpl, URLSearchParams, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(PLUGIN, "CarbonArcStore.js"), sandbox, { filename: "CarbonArcStore.js" });

  return { window, sandbox, documentElement, style, writes, classes, local };
}

/** Let the GraphQL promise chain finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("the first paint uses the browser's copy, before the query resolves", () => {
  const { window, documentElement, style } = boot({
    cache: { accent: "patina", density: "compact", previewBrightness: 75 },
  });

  assert.equal(documentElement.attrs["data-ca-accent"], "patina", "the saved signal is painted at once");
  assert.equal(documentElement.attrs["data-ca-density"], "compact");
  assert.equal(documentElement.attrs["data-ca-bright"], "75");
  assert.equal(documentElement.attrs["data-ca-version"], window.CarbonArcStore.VERSION);
  assert.equal(style["--ca-dim"], "0.75", "the brightness is an inline property, so it needs no rule per step");
});

test("a pre-0.5 boolean cache still paints, as 90 %", () => {
  const { window, documentElement, style } = boot({
    cache: { accent: "patina", density: "compact", dimPreviews: true },
    cacheKey: "carbonArc.config.v2",
  });

  assert.equal(documentElement.attrs["data-ca-accent"], "patina", "the old cache is read, not discarded");
  assert.equal(documentElement.attrs["data-ca-bright"], "90", "dimmed was 10 % off");
  assert.equal(style["--ca-dim"], "0.9");
  assert.equal(window.CarbonArcStore.get().previewBrightness, 90);
});

test("full brightness paints no inline filter at all", () => {
  const { window, documentElement, style } = boot({ cache: { previewBrightness: 100 } });

  assert.equal(documentElement.attrs["data-ca-bright"], "100");
  assert.deepEqual(style, {}, "100 % removes the property instead of writing 1");
});

test("a commit that lands on the value in force does not restyle the page", () => {
  const { window, documentElement, writes, local } = boot({ cache: { previewBrightness: 75 } });
  const store = window.CarbonArcStore;

  let woken = 0;
  const stop = store.subscribe(() => {
    woken += 1;
  });

  const attrsBefore = writes.attrs;
  const stylesBefore = writes.styles;

  store.preview({ previewBrightness: 75 });
  assert.equal(writes.attrs, attrsBefore, "no attribute is rewritten");
  assert.equal(writes.styles, stylesBefore, "no custom property is touched");
  assert.equal(woken, 0, "no subscriber is woken: there is nothing new to draw");
  assert.ok(
    local.get("carbonArc.config.v3"),
    "the localStorage mirror is still refreshed — it is the next load's first paint"
  );

  store.preview({ previewBrightness: 50 });
  assert.ok(writes.attrs > attrsBefore, "a real change still restyles");
  assert.equal(woken, 1);

  // A value that only differs by a step still counts as a change.
  store.preview({ previewBrightness: 55 });
  assert.equal(woken, 2);

  stop();
});

test("the server's value replaces the cached one, and an empty server keeps it", async () => {
  const wins = boot({ cache: { accent: "patina" }, plugins: { CarbonArc: { accent: "dusk" } } });
  await flush();
  assert.equal(wins.documentElement.attrs["data-ca-accent"], "dusk");

  const empty = boot({ cache: { accent: "patina" }, plugins: { CarbonArc: {} } });
  await flush();
  assert.equal(empty.documentElement.attrs["data-ca-accent"], "patina", "an empty plugin config is not a reset");

  const missing = boot({ cache: { accent: "patina" }, plugins: {} });
  await flush();
  assert.equal(missing.documentElement.attrs["data-ca-accent"], "patina");
});

test("normalize refuses values the theme cannot paint", () => {
  const { window } = boot();
  const store = window.CarbonArcStore;

  assert.equal(store.normalize({ accent: "nope" }).accent, "arc");
  assert.equal(store.normalize({ accent: "PATINA" }).accent, "patina", "case is not significant");
  assert.equal(store.normalize({ accent: "custom" }).accent, "arc", "custom needs a colour");
  assert.equal(
    store.normalize({ accent: "custom", customSignal: "#0a0b0c" }).accent,
    "arc",
    "a custom signal below 4.5:1 is refused"
  );
  assert.equal(store.normalize({ accent: "custom", customSignal: "#7fb0d0" }).accent, "custom");
  assert.equal(store.normalize({ accent: "custom", customSignal: "7fb0d0" }).customSignal, "#7fb0d0", "a bare hex is accepted");

  assert.equal(store.normalize({}).density, "comfortable");
  assert.equal(store.normalize({ density: "wide" }).density, "comfortable");

  assert.ok(store.contrast("#0a0b0c", "#101213") < store.MIN_CONTRAST);
  assert.ok(store.contrast("#7fb0d0", "#101213") >= store.MIN_CONTRAST);
});

test("brightness is a clamped, stepped percentage with an explicit default", () => {
  const { window } = boot();
  const store = window.CarbonArcStore;
  const { min, max, step } = store.BRIGHTNESS;

  assert.deepEqual({ min, max, step }, { min: 20, max: 100, step: 5 });
  assert.equal(store.DEFAULTS.previewBrightness, max, "full brightness is the default");

  // The old flag, in both shapes it was ever stored in.
  assert.equal(store.normalize({ dimPreviews: true }).previewBrightness, 90, "0.4's boolean");
  assert.equal(store.normalize({ dimPreviews: "dimmed" }).previewBrightness, 90, "0.4's string");
  assert.equal(store.normalize({ dimPreviews: false }).previewBrightness, 100);
  assert.equal(store.normalize({ dimPreviews: "full" }).previewBrightness, 100);
  assert.equal(store.normalize({ dimPreviews: true, previewBrightness: 50 }).previewBrightness, 50, "the new name wins");
  assert.equal(
    store.normalize({ dimPreviews: "dimmed", previewBrightness: "" }).previewBrightness,
    90,
    "an empty new value is absent, not zero: the legacy key still speaks"
  );

  // What Stash actually saves: a string in the settings map.
  for (const [raw, want] of [
    ["75", 75],
    ["75%", 75],
    [75, 75],
    [" 60 ", 60],
    ["", 100],
    [null, 100],
    ["nonsense", 100],
  ]) {
    assert.equal(store.normalize({ previewBrightness: raw }).previewBrightness, want, "reads " + JSON.stringify(raw));
  }

  // Range and step: out-of-range clamps, off-step snaps to the nearest stop.
  assert.equal(store.normalize({ previewBrightness: 0 }).previewBrightness, min, "below the floor");
  assert.equal(store.normalize({ previewBrightness: -40 }).previewBrightness, min);
  assert.equal(store.normalize({ previewBrightness: 250 }).previewBrightness, max, "above the ceiling");
  assert.equal(store.normalize({ previewBrightness: 77 }).previewBrightness, 75);
  assert.equal(store.normalize({ previewBrightness: 78 }).previewBrightness, 80);

  // Every preset must be a legal stop, or a tile would paint a value the
  // slider cannot sit on.
  for (const preset of store.BRIGHTNESS_PRESETS) {
    assert.ok(preset >= min && preset <= max, preset + " is inside the range");
    assert.equal((preset - min) % step, 0, preset + " sits on a step boundary");
    assert.equal(store.snapBrightness(preset), preset, preset + " is its own snap");
  }
  assert.ok(store.BRIGHTNESS_PRESETS.includes(90), "the old Dimmed value is still one click away");
});

test("a custom signal is painted as inline properties, and cleared again", () => {
  const { window, documentElement, style } = boot();

  window.CarbonArcStore.preview({ accent: "custom", customSignal: "#7fb0d0" });
  assert.equal(documentElement.attrs["data-ca-accent"], "custom");
  assert.equal(style["--ca-arc"], "#7fb0d0");
  assert.equal(style["--ca-arc-rgb"], "127, 176, 208");
  assert.equal(style["--ca-arc-12"], "rgba(127, 176, 208, 0.12)");
  assert.equal(style["--ca-arc-ink"], "#17140f", "a light signal takes the dark ink");

  window.CarbonArcStore.preview({ accent: "dusk" });
  assert.equal(style["--ca-arc"], undefined, "the inline override is removed, not left behind");
  assert.equal(documentElement.attrs["data-ca-accent"], "dusk");
});

test("the login block is scoped to body.login and uses that page's selectors", () => {
  const { window } = boot();
  const store = window.CarbonArcStore;

  assert.equal(store.LOGIN_CSS, store.loginCss("arc"), "the exported default is the arc block");

  for (const [accent, hex] of [
    ["arc", "#c2a176"],
    ["patina", "#8aa79a"],
    ["dusk", "#a79cb8"],
  ]) {
    const css = store.loginCss(accent);
    assert.ok(css.includes(hex), accent + " block carries its signal colour");
    assert.ok(/\.btn-primary \{[^}]*color: #[0-9a-f]{6}/.test(css), accent + " block sets a primary ink");
    assert.ok(!/--ca-/.test(css), accent + " block inlines values: a login page has no theme tokens");
  }

  assert.equal(store.loginCss("nope"), store.loginCss("arc"), "an unknown accent falls back to arc");

  const css = store.loginCss("patina");

  assert.ok(!/!important/.test(css), "body.login .x already outranks the login sheet");

  // The classes the block used to style, none of which exist on the page.
  for (const dead of [".login-page", ".login-container", ".card-header", ".card-footer", ".form-label"]) {
    assert.ok(!css.includes(dead), dead + " is not on Stash's login page");
  }

  // The two elements it used to miss.
  assert.ok(css.includes("body.login h6"), "the page's headings are h6, not h1–h4");
  assert.ok(css.includes("body.login .login-error"), "the error line is .login-error");

  const selectors = css
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("{") && !line.startsWith("@"))
    .map((line) => line.slice(0, -1).trim());

  assert.ok(selectors.length > 8, "selectors were parsed");
  for (const selector of selectors) {
    assert.ok(
      selector.startsWith("body.login") || selector.startsWith("html:has(body.login)"),
      "unscoped selector would restyle the app from this block: " + selector
    );
  }
});

test("the two halves of the palette agree", () => {
  const { window } = boot();
  const colors = window.CarbonArcStore.ACCENT_COLORS;
  const tokens = strip(read(PLUGIN, "CarbonArcTokens.css"));

  assert.deepEqual(Object.keys(colors).sort(), ["arc", "dusk", "patina"]);

  for (const [accent, { hex, ink }] of Object.entries(colors)) {
    const block = tokens.match(new RegExp('html\\[data-ca-accent="' + accent + '"\\]\\s*\\{([\\s\\S]*?)\\}'));
    assert.ok(block, "CarbonArcTokens.css has a block for " + accent);

    const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)).join(", ");
    assert.ok(block[1].includes("--ca-arc: " + hex), accent + " signal colour matches ACCENT_COLORS");
    assert.ok(block[1].includes("--ca-arc-ink: " + ink), accent + " ink matches ACCENT_COLORS");
    assert.ok(block[1].includes("--ca-arc-rgb: " + rgb), accent + " rgb triple follows its hex");
    assert.ok(block[1].includes("rgba(" + rgb + ", 0.12)"), accent + " tint follows its hex");
  }
});

test("the brightness option's two halves agree", () => {
  const { window } = boot();
  const store = window.CarbonArcStore;
  const theme = strip(read(PLUGIN, "CarbonArc.css"));
  const tokens = strip(read(PLUGIN, "CarbonArcTokens.css"));
  const settings = read(PLUGIN, "CarbonArcSettings.js");

  // The sheet filters by a token, and the store writes that token inline.
  assert.ok(/filter:\s*brightness\(var\(--ca-dim\)\)/.test(theme), "thumbnails read --ca-dim");
  assert.ok(/--ca-dim:\s*1;/.test(tokens), "the token has a no-JavaScript default of full brightness");
  assert.ok(!/data-ca-dim/.test(theme + read(PLUGIN, "CarbonArcSettings.js")), "the old on/off attribute is gone");

  // The settings row must know every preset and the setting's new name, or a
  // preset would render as a bare number and the row would never be patched.
  assert.ok(settings.includes("previewbrightness"), "the patch matches Stash's id for the new setting name");
  assert.ok(!settings.includes("dimPreviews"), "nothing still writes the 0.4 name");
  for (const preset of store.BRIGHTNESS_PRESETS) {
    assert.ok(
      new RegExp("^\\s+" + preset + ":\\s*\\{", "m").test(settings),
      "the settings row has a label and a note for " + preset + "%"
    );
  }

  // The manifest's description is the only place the contract is stated to a
  // user who never opens this file; the numbers themselves belong to the hint
  // under the control, which is built from the store so it cannot drift.
  const yml = read(PLUGIN, "CarbonArc.yml");
  const description = yml.slice(yml.indexOf("\n  previewBrightness:")).split("\n").slice(0, 4).join(" ");
  for (const fact of ["100", "90", "clamp"]) {
    assert.ok(description.includes(fact), "the setting description states " + fact);
  }
  assert.ok(
    /Default " \+ store\.DEFAULTS\.previewBrightness/.test(settings),
    "the hint reads the default from the store instead of hard-coding it"
  );
  for (const limit of ["limits.min", "limits.max", "limits.step"]) {
    assert.ok(settings.includes(limit), "the hint reads " + limit);
  }
});

test("the manifest, the tokens and the fonts agree", () => {
  const { window } = boot();
  const store = window.CarbonArcStore;
  const yml = read(PLUGIN, "CarbonArc.yml");

  const version = yml.match(/^version:\s*(\S+)/m);
  assert.ok(version, "the manifest declares a version");
  assert.equal(store.VERSION, version[1], "data-ca-version tracks the published version");

  const settingsBlock = yml.slice(yml.indexOf("\nsettings:"));
  const keys = [...settingsBlock.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys.sort(), Object.keys(store.DEFAULTS).sort(), "every option the store normalizes is declared");

  const cssList = yml.match(/css:\r?\n((?:[ \t]*- [^\r\n]*\r?\n)+)/);
  assert.ok(cssList, "the manifest lists its stylesheets");
  const order = cssList[1]
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/^[ \t]*- /, "").trim());

  assert.deepEqual(order, ["CarbonArcTokens.css", "CarbonArcFonts.css", "CarbonArcCJK.css", "CarbonArc.css", "CarbonArcSettings.css"]);

  // The fonts are files behind the assets map, not base64 in the stylesheet.
  const assetsBlock = yml.match(/^ {2}assets:\r?\n((?: {4}[^\r\n]*\r?\n)+)/m);
  assert.ok(assetsBlock, "the manifest maps a URL prefix to a directory");
  const assetKeys = [...assetsBlock[1].matchAll(/^ {4}(")?([^\s:"]+)\1:[ \t]*(\S+)[ \t]*\r?$/gm)];
  assert.ok(assetKeys.length > 0, "the assets map has entries");
  for (const [, , key] of assetKeys) {
    assert.ok(key.startsWith("/"), 'assets key "' + key + '" must start with "/": Stash matches it by prefix against "/<key>/…"');
  }
  assert.deepEqual(
    assetKeys.map(([, , key, dir]) => [key, dir]),
    [["/fonts", "fonts"]],
    "the assets map publishes fonts/"
  );

  const fonts = strip(read(PLUGIN, "CarbonArcFonts.css"));
  const theme = strip(read(PLUGIN, "CarbonArc.css"));

  assert.equal((fonts.match(/@font-face/g) || []).length, 3, "one face per source file");
  assert.equal(
    (fonts.match(/url\("assets\/fonts\/[a-z0-9-]+\.woff2"\) format\("woff2"\)/g) || []).length,
    3,
    "each face points at the assets route, relative to /plugin/<id>/css"
  );
  assert.ok(!/data:font/.test(fonts), "no base64 faces: they cannot be cached or loaded on demand");
  assert.ok(!/@font-face/.test(theme), "the faces live in CarbonArcFonts.css");
  assert.ok(!/url\(\s*["']?fonts\//.test(theme + fonts), "a url() into fonts/ is not on any served route");
});

test("the CJK faces cover Chinese and kana, and stay off Latin-only pages", () => {
  const cjk = strip(read(PLUGIN, "CarbonArcCJK.css"));
  const tokens = strip(read(PLUGIN, "CarbonArcTokens.css"));
  const faces = [...cjk.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);

  assert.equal(faces.length, 3, "one face per weight the theme actually asks for: 400, 500, 600");

  const weights = faces.map((body) => body.match(/font-weight:\s*(\d+)/)[1]).sort();
  assert.deepEqual(weights, ["400", "500", "600"]);

  for (const body of faces) {
    const family = body.match(/font-family:\s*"([^"]+)"/)[1];
    assert.equal(family, "Carbon Arc Sans CJK", "the subset must not carry the reserved name Plex");

    // Without unicode-range every page downloads ~850 KB per weight.
    const range = body.match(/unicode-range:\s*([^;]+);/)[1];
    for (const block of ["U+3000-30FF", "U+4E00-9FFF", "U+FF01-FF60"]) {
      assert.ok(range.includes(block), "unicode-range must cover " + block);
    }

    const src = body.match(/url\("assets\/fonts\/([a-z0-9-]+\.woff2)"\)/);
    assert.ok(src, "each face points at the assets route, relative to /plugin/<id>/css");
    const file = path.join(plugins, PLUGIN, "fonts", src[1]);
    const size = statSync(file).size;
    assert.ok(size > 200 * 1024, src[1] + " looks truncated: " + size + " bytes");
    assert.ok(size < 2 * 1024 * 1024, src[1] + " is larger than a GB2312 subset should be: " + size + " bytes");
  }

  assert.ok(!/data:font/.test(cjk), "no base64 faces");

  // The faces only matter if the stack names them.
  for (const token of ["--ca-font", "--ca-mono"]) {
    const stack = tokens.match(new RegExp(token + ":\\s*([^;]+);"))[1];
    assert.ok(stack.includes('"Carbon Arc Sans CJK"'), token + " must fall back to the CJK family");
  }
  assert.ok(
    tokens.match(/--ca-font:\s*([^;]+);/)[1].indexOf('"IBM Plex Sans"') < tokens.match(/--ca-font:\s*([^;]+);/)[1].indexOf('"Carbon Arc Sans CJK"'),
    "the Latin face comes first, so Latin text never renders in the CJK subset"
  );
});

test("the type scale is px tokens, never rem", () => {
  const theme = strip(read(PLUGIN, "CarbonArc.css"));
  const tokens = strip(read(PLUGIN, "CarbonArcTokens.css"));

  // Stash ships `html { font-size: 14px }` (assets/index-*.css), so a rem in
  // this theme renders at 87.5 % of its number: that is how 0.875rem became
  // 12.25 px and the whole UI read a step small.
  assert.ok(!/font-size:\s*[0-9.]+rem/.test(theme), "no rem font sizes: Stash's root is 14px, not 16");

  const declared = [...tokens.matchAll(/(--ca-fs-[a-z-]+):\s*([0-9]+)px;/g)].map((m) => m[1] + "=" + m[2]);
  assert.deepEqual(declared, [
    "--ca-fs-title=16",
    "--ca-fs-title-compact=15",
    "--ca-fs-body=15",
    "--ca-fs-ctl=14",
    "--ca-fs-meta=13",
    "--ca-fs-micro=12",
  ]);

  const sizes = [...theme.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(sizes.length >= 20, "the theme sets its sizes");
  for (const value of sizes) {
    // `font-size: 0` hides a bare text node (the icon-band nav label); it is a
    // hiding trick, not a text size, and it is the only zero allowed.
    if (value === "0") continue;
    assert.match(value, /^var\(--ca-fs-[a-z-]+\)$/, "every size names a scale step, got " + value);
  }

  const title = theme.match(/\.grid-card \.card-section-title,[\s\S]{0,160}?\{([^}]*)\}/);
  assert.ok(title, "the card title rule exists");
  assert.match(title[1], /font-size:\s*var\(--ca-fs-title\)/, "a card title takes the title step");

  // The span under the title inherits <body> unless it is named here, which
  // made a file path as tall as the title above it.
  assert.match(theme, /\.grid-card \.card-section \.scene-card__details/, "the path/date line is named");
});

test("a select keeps its caret whatever classes it carries", () => {
  const theme = strip(read(PLUGIN, "CarbonArc.css"));
  const tokens = strip(read(PLUGIN, "CarbonArcTokens.css"));

  // Stash paints the dropdown glyph for the whole app with `select { background:
  // url(…) no-repeat right 2px center }`, and this theme's `.form-control` block
  // is a `background:` shorthand too — so a select that carries any class loses
  // the glyph and reads as a text box. That is how the duplicate checker's
  // "Search Accuracy" and "Maximum Duration" shipped arrowless on 2026-11-29.
  const base = theme.match(/\nselect:not\(\[multiple\]\),\n\.custom-select \{([^}]*)\}/);
  assert.ok(base, "the caret rule exists");
  assert.match(base[1], /background: var\(--ca-sunken\) var\(--ca-caret\) no-repeat right 8px center \/ 12px 12px/, "the theme draws, sizes and places the glyph rather than inheriting Stash's right 2px");
  assert.match(base[1], /padding-right: 26px/, "the value stops short of the glyph");

  // `:not()` adopts the specificity of its argument, so this selector is
  // (0,1,1): it outranks `.form-control` (0,1,0) and `select` (0,0,1), which is
  // the whole reason the caret survives.
  assert.match(theme, /select:not\(\[multiple\]\)/, "the selector outranks both shorthands");

  // A state rule that only restates the image keeps the glyph but loses its
  // place: the competing `.form-control:disabled` / `.is-valid` rules are
  // `background:` shorthands, so they reset position and size to the initial
  // values and the caret lands in the top-left corner (measured).
  for (const selector of ["select:not([multiple]):disabled", "select:not([multiple]).is-valid"]) {
    const at = theme.indexOf(selector);
    assert.ok(at !== -1, selector + " still exists");
    const block = theme.slice(at, theme.indexOf("}", at));
    assert.match(block, /background: [^;]*right 8px center \/ 12px 12px/, selector + " restates the whole background");
  }

  // A `data:` image cannot use currentColor, so the two carets carry literal hex
  // copies of the palette; a drift here is invisible until a page renders.
  const hex = (token) => tokens.match(new RegExp(token + ":\\s*(#[0-9a-f]{6});"))[1];
  for (const [name, token] of [["rest", "--ca-tx-3"], ["hot", "--ca-tx-1"]]) {
    const rule = theme.match(new RegExp("--ca-caret" + (name === "hot" ? "-hot" : "") + ":\\s*url\\(\"([^\"]+)\"\\)"));
    assert.ok(rule, "the " + name + " caret is declared");
    assert.ok(rule[1].startsWith("data:image/svg+xml"), "the " + name + " caret needs no route of its own");
    assert.ok(rule[1].includes("%23" + hex(token).slice(1)), "the " + name + " caret tracks " + token);
  }

  // A list box is not a dropdown: Stash's global rule paints a caret on
  // `[multiple]` too, and one over a scrollable list reads as broken.
  assert.match(theme, /select\[multiple\],\nselect\[size\]:not\(\[size="1"\]\) \{\s*background-image: none;/, "a list box gets no caret");
});

test("the nav keeps its labels reachable when they cannot fit", () => {
  const theme = strip(read(PLUGIN, "CarbonArc.css"));
  const block = theme.match(/@media \(min-width: 1200px\) and \(max-width: 1489\.98px\) \{([\s\S]*?)\n\}/);
  assert.ok(block, "the nav has an icon band between Stash's hamburger and the labelled row");
  const css = block[1];

  // Ten labelled items need ~1442 px at 15 px; below that the label moves out
  // of the flow and becomes a chip. It must not be display:none: that would
  // drop the only text an icon-only item has out of the accessibility tree.
  assert.match(css, /\.btn > span:not\(\[class\]\) \{[^}]*position: absolute/, "the label is moved, not deleted");
  assert.ok(!/display:\s*none/.test(css), "no display:none in the icon band");
  assert.match(css, /font-size: var\(--ca-fs-micro\)/, "the chip takes the micro step");
  assert.match(css, /:focus-visible > span/, "keyboard focus reveals the chip too");
  assert.match(css, /\.nav-menu-icon[^{]*\{[^}]*font-size: var\(--ca-fs-body\)/, "the icon keeps its size when the label is hidden");

  // Icons are not one kind of object: eight are Font Awesome <svg> (1.25 x 1 em)
  // and Audio Support's is a text glyph in a <span> (1 x 1.27 em). Inline layout
  // put the note 1 px low and made its cell 7 px narrow, so the row looked like
  // it drifted. The cell is a fixed flex box with the glyph centred in it.
  assert.match(css, /\.btn \{[^}]*display: inline-flex/, "an icon cell is a flex box");
  assert.match(css, /\.btn \{[^}]*align-items: center/, "the glyph is centred, not baseline aligned");
  assert.match(css, /\.btn \{[^}]*min-width: 44px/, "every cell is at least as wide as the widest glyph, so the pitch is uniform");
  assert.match(css, /\.nav-menu-icon[^{]*\{[^}]*display: block/, "the glyph is a block inside the cell, so its own metrics cannot stretch the line");
});

test("?carbonarc=off paints nothing and parks the stylesheet", () => {
  const link = makeLink("/plugin/CarbonArc/css");
  const { window, documentElement, classes } = boot({ search: "?carbonarc=off", links: [link] });

  assert.equal(window.CarbonArcStore.off, true);
  assert.equal(documentElement.attrs["data-ca-accent"], undefined, "nothing is applied while off");
  assert.ok(classes.has("ca-off"), "the page is marked");
  assert.equal(link.media, "not all", "the sheet is parked on a media type that never matches");
  assert.equal(link.disabled, true);
});

test("hover-only rules stay behind a hover-capable pointer", () => {
  const css = strip(read(PLUGIN, "CarbonArc.css"));
  const gate = "@media (hover: hover) and (pointer: fine)";

  assert.ok((css.match(new RegExp(gate.replace(/[()]/g, "\\$&"), "g")) || []).length >= 15, "the gate is applied");

  for (const selector of [".grid-card.card:hover", ".filter-item:hover", ".tag-item:hover", ".nav-link:hover", "select:not([multiple]):hover"]) {
    const at = css.indexOf(selector);
    assert.ok(at !== -1, selector + " still exists");
    const opened = css.lastIndexOf(gate, at);
    assert.ok(opened !== -1 && at - opened < 200, selector + " is inside the hover gate");
  }
});

test("the Tools launcher rows cannot catch a stranger, or cover a control", () => {
  const theme = strip(read(PLUGIN, "CarbonArc.css"));

  // Settings > Tools receives two shapes and the theme folds both into one
  // row: an `<a href="/plugins/…">` dropped into the card, and a `.setting`
  // whose whole label is a link. Two guards keep that from overreaching.
  //
  // `:has(h3)` — a launcher carries a title (and maybe a one-liner). A link
  // that merely happens to sit in a settings card keeps its own padding
  // instead of being flattened into a full-width row.
  const bare = theme.match(/\.card > a\[href\^="\/plugins\/"\](?!:has\(h3\))/g) || [];
  assert.deepEqual(bare, [], "a rule would restyle a plain card link too");

  // `:has(> div:last-child:empty)` — the stretched link covers the whole row,
  // so it may only land where the row owns nothing else. Stash's Library and
  // Backup rows are `.setting > h3 > a > .btn` as well, and their own buttons
  // have to stay clickable.
  const stretched = theme.match(/\.setting:has\(> div:first-child > h3 > a\)(?!:has\(> div:last-child:empty\))/g) || [];
  assert.deepEqual(stretched, [], "a stretched link would sit over the row's own controls");

  // The row comes from the shape, not from a plugin's class name: otherwise
  // the next plugin to patch this section reintroduces the split.
  for (const cls of [
    "elg-set-launcher",
    "questing-adventurer-settings__launcher",
    "mosaic-filter-settings__launcher",
    "audio-support-settings__launcher",
  ]) {
    assert.ok(!theme.includes(cls), "the row must not name " + cls);
  }

  // Both shapes end on the same title and description steps.
  assert.match(theme, /a\[href\^="\/plugins\/"\]:has\(h3\) h3 \{[\s\S]{0,120}?font-size: var\(--ca-fs-title\)/);
  assert.match(theme, /a\[href\^="\/plugins\/"\]:has\(h3\) p \{[\s\S]{0,120}?font-size: var\(--ca-fs-meta\)/);

  // The group the plugins put their launchers in is Stash's `.setting` row
  // again; only its caption gets the theme's type (micro, mono, tracked out).
  assert.match(
    theme,
    /\[data-plugin-tools-label\] \.sub-heading \{[\s\S]{0,240}?font-size: var\(--ca-fs-micro\)/,
    "the group caption takes the micro step"
  );
  assert.match(
    theme,
    /\[data-plugin-tools-label\] \.sub-heading \{[\s\S]{0,240}?text-transform: uppercase/,
    "and reads as a caption, not a heading"
  );
});
