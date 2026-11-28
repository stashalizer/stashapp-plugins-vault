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

  /**
   * `requestAnimationFrame` is captured rather than run: the brightness row
   * holds a slider move until the next frame, and a test has to be able to say
   * "the frame has not happened yet" and then make it happen.
   */
  let frameSeq = 0;
  const frames = new Map();
  const drainFrames = () => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback();
    return queued.length;
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
    requestAnimationFrame: (callback) => {
      frameSeq += 1;
      frames.set(frameSeq, callback);
      return frameSeq;
    },
    cancelAnimationFrame: (handle) => {
      frames.delete(handle);
    },
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

  return { window, applyBefore, applyInstead, before, instead, sandbox, frames, drainFrames };
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

  // The section renders twice — "Tools" first, "Scene Tools" second — and the
  // launcher belongs to "Tools" (config.tools.heading), so the odd call acts
  // and the even one passes through untouched.
  const first = applyBefore("SettingsToolsSection", { children: [] });
  const added = first[0].children || [];
  assert.equal(added.length, 1, "one group, no duplicate");

  const second = applyBefore("SettingsToolsSection", {
    children: [{ type: "div", props: { "data-stash": "1" } }],
  });
  assert.equal(second[0].children.length, 1, "the Scene Tools instance is left alone");
  assert.equal(second[0].children[0].props["data-stash"], "1", "and its own rows are untouched");

  // Stash's own tools stay where they are. The plugin's launcher goes into a
  // group of its own at the bottom of the card — Stash's list must not look
  // like it grew a plugin entry — and that group opens with a caption row.
  const group = added[0];
  assert.equal(group.props["data-plugin-tools"], "1", "the launcher is wrapped in the plugin-tools group");
  const [label, row] = group.props.children;
  assert.equal(label.props["data-plugin-tools-label"], "1", "the group opens with its own caption row");
  assert.equal(label.props.className, "setting", "the caption is a .setting row, so Stash spaces it");
  assert.equal(row.props.className, "setting", "and the launcher is a .setting row, not a card");
  assert.equal(row.props.children.length, 2, "a label column and the action column");
  assert.equal(
    row.props.children[1].props.children,
    undefined,
    "the action column is empty: the label itself is the link"
  );

  const links = [];
  walk(row, (node) => {
    if (node.props && node.props.to) links.push(node.props.to);
  });
  assert.deepEqual(links, ["/plugins/externalurlgroups"], "and the label still links to the plugin's route");

  // The group is a convention between the four plugins, not a component they
  // share: whichever renders next has to find it and append, not open a second
  // one. Calls alternate, so the third one is the next that acts.
  const third = applyBefore("SettingsToolsSection", { children: added });
  const extended = third[0].children || [];
  assert.equal(extended.length, 1, "a second plugin extends the group instead of adding one");
  assert.equal(extended[0].props.children.length, 3, "caption plus two launcher rows");
  assert.ok(
    extended[0].props.children[0].props["data-plugin-tools-label"],
    "the caption stays first, so it heads the whole group"
  );
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

/**
 * Render the brightness row through the real patch and hand back its live
 * controls: the props of the range input, of the exact-value field, and of the
 * four preset buttons (in reading order). Everything here is the component's
 * own closure, so calling a handler behaves like the browser would.
 */
function renderBrightness(applyInstead, props) {
  const node = applyInstead("StringSetting", props, () => {
    throw new Error("the brightness row must not fall through to Stash's modal");
  });

  let tree = node;
  while (tree && typeof tree.type === "function") tree = tree.type(tree.props);

  const found = { range: null, number: null, samples: 0, buttons: [] };
  walk(tree, (child) => {
    const kind = child.props && child.props.type;
    if (child.type === "input" && kind === "range") found.range = child.props;
    if (child.type === "input" && kind === "number") found.number = child.props;
    if (child.type === "button" && child.props && child.props["aria-pressed"] !== undefined) {
      found.buttons.push(child.props);
    }
    if (child.props && typeof child.props.className === "string" && child.props.className.includes("ca-bright__sample")) {
      found.samples += 1;
    }
  });

  return found;
}

test("the brightness row ships a slider, an exact field and one sample per preset", () => {
  const { applyInstead } = loadBoth();

  const found = renderBrightness(applyInstead, {
    id: "plugin-CarbonArc-previewbrightness",
    heading: "Preview brightness",
    value: "",
    onChange() {},
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

  assert.equal(found.buttons.length, 4, "one button per preset");
  assert.equal(found.samples, 5, "one sample per preset tile, plus the live stage");
});

test("a slider burst becomes one commit per frame, and the release commits it once", () => {
  const { window, applyInstead, frames, drainFrames } = loadBoth();
  const sent = [];

  const { range } = renderBrightness(applyInstead, {
    id: "plugin-CarbonArc-previewbrightness",
    heading: "Preview brightness",
    value: "",
    onChange: (value) => sent.push(value),
  });

  range.onChange({ target: { value: 40 } });
  range.onChange({ target: { value: 60 } });
  range.onChange({ target: { value: 80 } });

  assert.equal(frames.size, 1, "three moves inside one frame schedule one frame, not three");
  assert.deepEqual(sent, [], "moving is not a commit: nothing is written while the thumb is down");

  drainFrames();
  assert.equal(window.CarbonArcStore.get().previewBrightness, 80, "the frame paints the newest value, not each one");

  range.onPointerUp();
  assert.deepEqual(sent, ["80"], "the release hands Stash the value under the thumb, exactly once");

  range.onBlur();
  assert.deepEqual(sent, ["80"], "a settle that repeats the last commit writes nothing");
});

test("a preset click commits once, and clicking it again costs nothing", () => {
  const { window, applyInstead } = loadBoth();
  const store = window.CarbonArcStore;
  const sent = [];

  const { buttons } = renderBrightness(applyInstead, {
    id: "plugin-CarbonArc-previewbrightness",
    heading: "Preview brightness",
    value: "",
    onChange: (value) => sent.push(value),
  });

  let woken = 0;
  store.subscribe(() => {
    woken += 1;
  });

  buttons[3].onClick(); // -50 %
  assert.deepEqual(sent, ["50"], "a new value is handed to Stash");
  assert.ok(woken >= 1, "and the page repaints");
  const afterFirst = woken;

  buttons[3].onClick(); // the same preset again
  assert.deepEqual(sent, ["50"], "the same value is not written twice");
  assert.equal(woken, afterFirst, "and nothing is restyled: the store is already there");
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
