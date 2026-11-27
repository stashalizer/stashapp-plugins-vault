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
  const { search = "", cache = null, plugins: stored = null, pending = false, links = [] } = options;

  const local = new Map();
  if (cache) local.set("carbonArc.config.v2", JSON.stringify(cache));
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
  const classes = new Set();
  const documentElement = {
    attrs: {},
    style: {
      setProperty: (name, value) => {
        style[name] = value;
      },
      removeProperty: (name) => {
        delete style[name];
      },
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
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

  return { window, sandbox, documentElement, style, classes, local };
}

/** Let the GraphQL promise chain finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("the first paint uses the browser's copy, before the query resolves", () => {
  const { window, documentElement, style } = boot({
    cache: { accent: "patina", density: "compact", dimPreviews: true },
  });

  assert.equal(documentElement.attrs["data-ca-accent"], "patina", "the saved signal is painted at once");
  assert.equal(documentElement.attrs["data-ca-density"], "compact");
  assert.equal(documentElement.attrs["data-ca-dim"], "on");
  assert.equal(documentElement.attrs["data-ca-version"], window.CarbonArcStore.VERSION);
  assert.deepEqual(style, {}, "a shipped signal needs no inline properties");
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

  assert.equal(store.normalize({ dimPreviews: "true" }).dimPreviews, true, "the 0.2 boolean is still understood");
  assert.equal(store.normalize({ dimPreviews: "dimmed" }).dimPreviews, true);
  assert.equal(store.normalize({ dimPreviews: "full" }).dimPreviews, false);
  assert.equal(store.normalize({}).density, "comfortable");
  assert.equal(store.normalize({ density: "wide" }).density, "comfortable");

  assert.ok(store.contrast("#0a0b0c", "#101213") < store.MIN_CONTRAST);
  assert.ok(store.contrast("#7fb0d0", "#101213") >= store.MIN_CONTRAST);
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

  for (const selector of [".grid-card.card:hover", ".filter-item:hover", ".tag-item:hover", ".nav-link:hover"]) {
    const at = css.indexOf(selector);
    assert.ok(at !== -1, selector + " still exists");
    const opened = css.lastIndexOf(gate, at);
    assert.ok(opened !== -1 && at - opened < 200, selector + " is inside the hover gate");
  }
});
