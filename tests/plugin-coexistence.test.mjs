/**
 * Coexistence test: ExternalLinkGroups alongside the Carbon Arc theme.
 *
 *   node --test tests/
 *
 * (Do not write the recursive test glob in this header: the star-slash inside
 * it closes the block comment. See the note in AGENTS.md.)
 *
 * Both plugins are installed from this repository at the same time, so they run
 * in one Stash UI. This suite loads the real files of both, in the order Stash
 * loads plugins (plugin id, so CarbonArc first), into one sandbox and asserts
 * the parts that can actually collide:
 *
 *   1. `patch.before("PluginRoutes")` chain — both routes survive the chain and
 *      the original children are neither dropped nor duplicated.
 *   2. `patch.before("SettingsToolsSection")` chain — both launcher cards are
 *      added on the same (even) call and neither one lands on the odd call.
 *   3. Configuration and storage keys are disjoint, so neither plugin can read
 *      or overwrite the other's saved settings.
 *   4. Stylesheet scoping — the plugin's CSS touches only its own `.elg-`
 *      selectors and defines no design tokens, which is what keeps it from
 *      fighting a theme that remaps every `--bs-*` variable.
 *
 * `patch.before` semantics are reproduced from `ui/v2.5/src/patch.tsx`: each
 * registered function receives the current argument list and returns the next
 * one.
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
    classList: { add() {} },
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
    ["ExternalLinkGroups", "ExternalLinkGroups.js"],
    ["ExternalLinkGroups", "ExternalLinkGroupsSettings.js"],
  ];

  for (const file of files) {
    vm.runInContext(read(...file), sandbox, { filename: file.join("/") });
  }

  return { window, applyBefore, before, instead, sandbox };
}

/** Depth-first walk over a stub element tree. */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  visit(node);
  walk(node.props && node.props.children, visit);
}

test("both plugins register their patches without clobbering each other", () => {
  const { before, instead } = loadBoth();

  assert.equal((before.PluginRoutes || []).length, 2, "one route patch per plugin");
  assert.equal((before.SettingsToolsSection || []).length, 2, "one launcher patch per plugin");
  assert.deepEqual(Object.keys(instead), ["ExternalLinkButtons"], "only the link buttons are replaced");
});

test("the PluginRoutes chain keeps both routes and the original children", () => {
  const { window, applyBefore } = loadBoth();
  const React = window.PluginApi.React;
  const original = React.createElement("div", { "data-original": "1" });

  const args = applyBefore("PluginRoutes", { children: original });
  const paths = [];
  let originalCount = 0;

  walk(args[0].children, (node) => {
    if (node.props && node.props.path) paths.push(node.props.path);
    if (node.props && node.props["data-original"]) originalCount += 1;
  });

  assert.deepEqual(paths.sort(), ["/plugins/carbonarc", "/plugins/externalurlgroups"]);
  assert.equal(originalCount, 1, "the app's own routes are wrapped once, not duplicated");
});

test("both launcher cards land on the same SettingsToolsSection call", () => {
  const { applyBefore } = loadBoth();

  const first = applyBefore("SettingsToolsSection", { children: [] });
  assert.deepEqual(first[0].children, [], "the odd call is passed through untouched");

  const second = applyBefore("SettingsToolsSection", { children: [] });
  const cards = (second[0].children || []).map((card) => card.props && card.props.to);

  assert.deepEqual(cards.sort(), ["/plugins/carbonarc", "/plugins/externalurlgroups"]);
  assert.equal(cards.length, 2, "exactly one card each, no duplicate");
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

test("the login CSS block follows the selected accent", () => {
  const { window } = loadBoth();
  const ca = window.CarbonArcStore;

  assert.equal(ca.LOGIN_CSS, ca.loginCss("arc"), "the exported default is the arc block");

  for (const [accent, hex] of [
    ["arc", "#c2a176"],
    ["patina", "#8aa79a"],
    ["dusk", "#a79cb8"],
  ]) {
    const css = ca.loginCss(accent);
    assert.ok(css.includes(hex), accent + " block carries its signal colour");
    assert.ok(/\.btn-primary \{[^}]*color: #[0-9a-f]{6}/.test(css), accent + " block sets a primary ink");
    assert.ok(!/--ca-/.test(css), accent + " block inlines values: a login page has no theme tokens");
  }

  assert.equal(ca.loginCss("nope"), ca.loginCss("arc"), "an unknown accent falls back to arc");
});

test("the store version matches the manifest", () => {
  const { window } = loadBoth();
  const match = read("CarbonArc", "CarbonArc.yml").match(/^version:\s*(\S+)/m);

  assert.ok(match, "the manifest declares a version");
  assert.equal(window.CarbonArcStore.VERSION, match[1], "data-ca-version tracks the published version");
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
  const theme = read("CarbonArc", "CarbonArc.css");
  assert.ok(!/\.elg-/.test(theme), "Carbon Arc has no rule for the plugin's classes");
  assert.ok(!/external-links-button/.test(theme), "Carbon Arc leaves Stash's link buttons alone");
});
