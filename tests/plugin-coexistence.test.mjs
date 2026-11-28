/**
 * Coexistence test: ExternalLinkGroups alongside the Carbon Arc theme.
 *
 *   node --test "tests/**\/*.test.mjs"
 *
 * (Do not write the recursive test glob unescaped in this header: the
 * star-slash inside it closes the block comment. See the note in AGENTS.md.)
 *
 * Both plugins are installed from this repository at the same time, so they run
 * in one Stash UI. This suite loads the real files of both, in the order Stash
 * loads plugins (plugin id, so CarbonArc first), into one sandbox and asserts
 * the parts that can actually collide:
 *
 *   1. `patch.before("PluginRoutes")` and `patch.before("SettingsToolsSection")`
 *      — the route and launcher card ExternalLinkGroups adds survive intact,
 *      because the theme registers neither and cannot consume the chain.
 *   2. `patch.instead("StringSetting")` — this is the theme's one patch, and it
 *      sees *every* string setting in Stash. A setting it does not own has to
 *      come back through the original renderer with its arguments untouched.
 *   3. Configuration and storage keys are disjoint, so neither plugin can read
 *      or overwrite the other's saved settings.
 *   4. Stylesheet scoping — the plugin's CSS touches only its own `.elg-`
 *      selectors and defines no design tokens, which is what keeps it from
 *      fighting a theme that remaps every `--bs-*` variable.
 *
 * `patch.before` semantics are reproduced from `ui/v2.5/src/patch.tsx`: each
 * registered function receives the current argument list and returns the next
 * one. `patch.instead` appends the next renderer to that list, so the last
 * argument is a function the wrapper calls to draw the original.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugins = path.join(here, "..", "plugins");
const read = (...parts) => readFileSync(path.join(plugins, ...parts), "utf8");

/** Minimal React: elements are plain objects, hooks are never executed here. */
function makeReact() {
  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => undefined,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  };
  return React;
}

function loadBoth() {
  const before = {};
  const instead = {};

  const patch = {
    before(name, fn) {
      (before[name] = before[name] || []).push(fn);
    },
    instead(name, fn) {
      (instead[name] = instead[name] || []).push(fn);
    },
    after() {},
  };

  /** Run the before-chain for one component render, exactly as patch.tsx does. */
  function applyBefore(name, props) {
    let args = [props];
    for (const fn of before[name] || []) args = fn.apply(null, args);
    return args;
  }

  /**
   * Run an instead-chain for one render. `next` is the renderer Stash would
   * have used; the chain passes it as the last argument.
   */
  function applyInstead(name, props, next) {
    const fns = instead[name] || [];
    assert.ok(fns.length > 0, name + " has no instead patch");
    return fns[0].apply(null, [props, undefined, next]);
  }

  const Route = function Route() {
    return null;
  };
  const Link = function Link() {
    return null;
  };

  const storage = {};
  const localStorage = {
    getItem: (key) => (key in storage ? storage[key] : null),
    setItem: (key, value) => {
      storage[key] = String(value);
    },
    removeItem: (key) => {
      delete storage[key];
    },
  };

  const documentElement = {
    attributes: {},
    classList: { add() {}, contains: () => false },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };

  const window = {
    PluginApi: {
      React: makeReact(),
      ReactDOM: { createPortal: (node) => node },
      libraries: {
        ReactRouterDOM: { Route, Link },
        FontAwesomeSolid: { faLink: { iconName: "link" } },
      },
      components: {},
      patch,
    },
    localStorage,
  };

  const sandbox = {
    window,
    document: { documentElement, body: {} },
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const files = [
    ["CarbonArc", "CarbonArcStore.js"],
    ["CarbonArc", "CarbonArcSettings.js"],
    ["ExternalLinkGroups", "ExternalLinkGroupsShared.js"],
    ["ExternalLinkGroups", "ExternalLinkGroupsStore.js"],
    ["ExternalLinkGroups", "ExternalLinkGroupsIcons.js"],
    ["ExternalLinkGroups", "ExternalLinkGroupsScan.js"],
    ["ExternalLinkGroups", "ExternalLinkGroups.js"],
    ["ExternalLinkGroups", "ExternalLinkGroupsSettings.js"],
  ];

  for (const file of files) {
    vm.runInContext(read(...file), sandbox, { filename: file.join("/") });
  }

  return { window, applyBefore, applyInstead, before, instead, sandbox };
}

/**
 * Depth-first walk over a stub element tree. Function components are rendered
 * once (the stub hooks return their initial values), so a nested block like the
 * login-page panel is inspected too.
 */
function walk(node, visit, depth = 0) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit, depth));
    return;
  }
  if (typeof node.type === "function" && node.props && depth < 8) {
    // Visit the element itself (a <Route> carries its path as a prop) and then
    // whatever it renders, so a nested block such as the login-page panel is
    // inspected too.
    visit(node);
    walk(node.type(node.props), visit, depth + 1);
    return;
  }
  visit(node);
  walk(node.props && node.props.children, visit, depth);
}

test("each plugin registers only the patches it owns", () => {
  const { before, instead } = loadBoth();

  assert.equal((before.PluginRoutes || []).length, 1, "the route belongs to ExternalLinkGroups alone");
  assert.equal((before.SettingsToolsSection || []).length, 1, "and so does the Settings > Tools card");
  assert.deepEqual(Object.keys(instead).sort(), ["ExternalLinkButtons", "StringSetting"]);
  assert.equal((instead.StringSetting || []).length, 1, "the theme patches exactly one Stash component");
});

test("the theme never touches the routes or the tools section", () => {
  const { applyBefore } = loadBoth();
  const original = { type: "div", props: { "data-original": "1" } };

  const routes = applyBefore("PluginRoutes", { children: original });
  const paths = [];
  let originalCount = 0;
  walk(routes[0].children, (node) => {
    if (node.props && node.props.path) paths.push(node.props.path);
    if (node.props && node.props["data-original"]) originalCount += 1;
  });

  assert.deepEqual(paths, ["/plugins/externalurlgroups"], "the plugin's own route, and nothing else");
  assert.equal(originalCount, 1, "the app's own routes are wrapped once, not duplicated");

  const first = applyBefore("SettingsToolsSection", { children: [] });
  assert.deepEqual(first[0].children, [], "the odd call is still passed through untouched");

  const second = applyBefore("SettingsToolsSection", { children: [] });
  const cards = (second[0].children || []).map((card) => card.props && card.props.to);
  assert.deepEqual(cards, ["/plugins/externalurlgroups"], "one card, no duplicate");
});

test("a setting the theme does not own comes back through the original renderer", () => {
  const { applyInstead } = loadBoth();

  const props = { id: "plugin-SomeOtherPlugin-apiKey", heading: "API key", value: "abc", onChange() {} };
  let calls = 0;
  const next = (received) => {
    calls += 1;
    return { type: "Original", props: received };
  };

  const node = applyInstead("StringSetting", props, next);

  assert.equal(calls, 1, "the original renderer is called once");
  assert.equal(node.type, "Original");
  assert.equal(node.props, props, "with the arguments it was given, not a copy");
});

test("the theme draws tiles for its own three settings", () => {
  const { applyInstead } = loadBoth();

  const cases = [
    ["plugin-CarbonArc-accent", 4, "ca-login"],
    ["plugin-CarbonArc-density", 2, null],
    ["plugin-CarbonArc-previewbrightness", 4, null],
  ];

  for (const [id, tiles, extra] of cases) {
    const props = { id, heading: "Heading", subHeading: "Sub", value: "", onChange() {} };
    let fallback = 0;
    const next = (received) => {
      fallback += 1;
      return { type: "Original", props: received };
    };

    const node = applyInstead("StringSetting", props, next);
    assert.equal(fallback, 0, id + " must not fall through to Stash's row");

    // The patch returns an element whose type is the tile component; render it
    // the way React would, with the stub hooks.
    const tree = node.type(node.props);
    const buttons = [];
    const classNames = [];
    walk(tree, (child) => {
      if (child.props && typeof child.props.className === "string") classNames.push(child.props.className);
      if (child.props && child.props["aria-pressed"] !== undefined && child.type === "button") buttons.push(child);
    });

    assert.ok(
      classNames.some((name) => name.includes("ca-tiles")),
      id + " renders the tile group"
    );
    assert.equal(buttons.length, tiles, id + " renders one button per choice");
    assert.equal(tree.props.id, props.id, "the setting keeps its id, so Stash can still scroll to it");

    if (extra) {
      assert.ok(
        classNames.some((name) => name.includes(extra)),
        id + " carries the login-page block"
      );
    }
  }
});

test("the brightness row ships a slider, an exact field and one sample per preset", () => {
  const { applyInstead } = loadBoth();

  const props = { id: "plugin-CarbonArc-previewbrightness", heading: "Preview brightness", value: "", onChange() {} };
  const node = applyInstead("StringSetting", props, () => {
    throw new Error("the brightness row must not fall through to Stash's modal");
  });

  // Whatever the patch returns is a component element; draw it once.
  let tree = node;
  while (tree && typeof tree.type === "function") tree = tree.type(tree.props);

  const found = { range: null, number: null, samples: 0 };
  walk(tree, (child) => {
    const type = child.type;
    const kind = child.props && child.props.type;
    if (type === "input" && kind === "range") found.range = child.props;
    if (type === "input" && kind === "number") found.number = child.props;
    if (child.props && typeof child.props.className === "string" && child.props.className.includes("ca-bright__sample")) {
      found.samples += 1;
    }
  });

  assert.ok(found.range, "the row has a range input");
  assert.equal(found.range.min, 20, "range floor");
  assert.equal(found.range.max, 100, "range ceiling");
  assert.equal(found.range.step, 5, "step");
  assert.ok("aria-valuetext" in found.range, "the slider announces a percentage, not a bare 0–1");

  assert.ok(found.number, "the row has an exact-value field");
  assert.equal(found.number.min, 20);
  assert.equal(found.number.max, 100);
  assert.equal(found.number.step, 5);

  assert.equal(found.samples, 5, "one sample per preset tile, plus the live stage");
});

test("configuration and storage keys are disjoint", () => {
  const { window } = loadBoth();

  const ca = window.CarbonArcStore;
  const elg = window.ExternalLinkGroupsStore;
  const shared = window.ExternalLinkGroupsShared;

  assert.ok(ca && elg && shared, "both plugins expose their own namespace");
  assert.notEqual(ca.CONFIG_KEY, shared.CONFIG_KEY);
  assert.notEqual(ca.STORAGE_KEY, shared.CONFIG_STORAGE_KEY);
  assert.equal(shared.CONFIG_KEY, "ExternalLinkGroups");
  assert.equal(ca.CONFIG_KEY, "CarbonArc");
});

test("loading both leaves each plugin's globals intact", () => {
  const { window } = loadBoth();
  const names = ["CarbonArcStore", "ExternalLinkGroupsShared", "ExternalLinkGroupsStore", "ExternalLinkGroupsIcons"];

  for (const name of names) {
    assert.ok(window[name], name + " still exists");
  }
  assert.notEqual(window.CarbonArcStore, window.ExternalLinkGroupsStore);
});

test("the plugin stylesheet stays inside its own selector prefix", () => {
  const css = read("ExternalLinkGroups", "ExternalLinkGroups.css") + read("ExternalLinkGroups", "ExternalLinkGroupsSettings.css");
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const selectors = [];
  let depth = 0;
  let buffer = "";

  for (const char of clean) {
    if (char === "{") {
      if (depth === 0) selectors.push(buffer.trim());
      depth += 1;
      buffer = "";
    } else if (char === "}") {
      depth -= 1;
      buffer = "";
    } else if (char === ";") {
      if (depth === 0) buffer = "";
    } else {
      buffer += char;
    }
  }

  const topLevel = selectors
    .filter(Boolean)
    .filter((selector) => !selector.startsWith("@"))
    .flatMap((selector) => selector.split(",").map((part) => part.trim()))
    .filter(Boolean);

  assert.ok(topLevel.length > 0, "selectors were parsed");

  for (const selector of topLevel) {
    assert.match(selector, /^\.elg-/, "unscoped selector would leak into the theme: " + selector);
  }

  assert.ok(!/:root|\*/.test(clean), "the plugin defines no global tokens or universal rules");
  assert.ok(!/--ca-/.test(clean), "the plugin never reads the theme's private tokens");
});

test("the theme never targets the plugin's classes", () => {
  const theme = read("CarbonArc", "CarbonArc.css") + read("CarbonArc", "CarbonArcTokens.css");
  assert.ok(!/\.elg-/.test(theme), "Carbon Arc has no rule for the plugin's classes");
  assert.ok(!/external-links-button/.test(theme), "Carbon Arc leaves Stash's link buttons alone");
});

test("the theme's own settings row is not a Stash component the plugin relies on", () => {
  // The tiles replace StringSetting for three ids only. If a future release of
  // Stash renames the component, the patch silently stops matching, so the
  // name is asserted here rather than discovered in a screenshot.
  const settings = read("CarbonArc", "CarbonArcSettings.js");
  assert.match(settings, /patch\.instead\("StringSetting"/);
  assert.ok(!/patch\.before\("SettingsToolsSection"/.test(settings), "no Settings > Tools card any more");
  assert.ok(!/PluginRoutes/.test(settings), "no route any more");
});
