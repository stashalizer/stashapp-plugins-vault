/**
 * Render smoke test for ExternalLinkGroups — the `ExternalLinkButtons` patch.
 *
 *   node --test tests/
 *
 * There is no React in this repository (Stash provides it at runtime), so this
 * file supplies a minimal React surface that is just enough to execute one
 * render pass: function components are invoked, `useState` returns its initial
 * value, `useMemo` is computed and `useEffect` runs immediately. That is enough
 * to assert the two things that matter structurally and are easy to break:
 *
 *   1. Stash's original renderer is called once per render, with the URLs the
 *      plugin did NOT claim (unconfigured / disabled ones keep Stash's own
 *      buttons).
 *   2. Each enabled-and-separate domain gets its own button, one URL renders a
 *      direct link, several render a dropdown.
 *
 * It does not replace installing the plugin in a live Stash: CSS, dropdown
 * placement and icon loading are outside what a stub renderer can prove. The
 * `instead` call itself is reproduced with Stash's arguments (React's props,
 * then the remaining chain appended last), because that signature is what the
 * plugin gets wrong most expensively — see the note at the call site.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "plugins", "ExternalLinkGroups");
const read = (name) => readFileSync(path.join(dir, name), "utf8");

const Fragment = Symbol("Fragment");

/** Minimal React: one render pass, no re-renders. */
function makeReact(records) {
  let slots = null;

  const hook = (make) => {
    if (!slots) return make();
    const value = make();
    slots.index += 1;
    return value;
  };

  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState(initial) {
      const value = typeof initial === "function" ? initial() : initial;
      if (!slots) return [value, function () {}];
      slots.index += 1;
      return [value, function () {}];
    },
    useMemo(factory) {
      return hook(factory);
    },
    useEffect(fn) {
      const cleanup = hook(fn);
      if (typeof cleanup === "function") records.cleanups.push(cleanup);
      return cleanup;
    },
    useCallback(fn) {
      return fn;
    },
    useRef(initial) {
      return { current: initial };
    },
  };

  React.__withSlots = function (fn) {
    const previous = slots;
    slots = { index: 0 };
    try {
      return fn();
    } finally {
      slots = previous;
    }
  };

  return React;
}

function loadPlugin(urls, config) {
  const records = { cleanups: [], elements: [], originalCalls: [], originalProps: [] };
  const storage = {};
  if (config) storage["externalLinkGroups.config.v1"] = JSON.stringify(config);

  const localStorage = {
    getItem: (key) => (key in storage ? storage[key] : null),
    setItem: (key, value) => {
      storage[key] = String(value);
    },
    removeItem: (key) => {
      delete storage[key];
    },
  };

  const React = makeReact(records);

  const Dropdown = function Dropdown(props) {
    return React.createElement("div", Object.assign({}, props, { "data-dropdown": "1" }));
  };
  Dropdown.Menu = function Menu(props) {
    return React.createElement("div", Object.assign({}, props, { "data-menu": "1" }));
  };
  Dropdown.Toggle = function Toggle(props) {
    return React.createElement("button", props);
  };
  Dropdown.Item = function Item(props) {
    return React.createElement("a", props);
  };

  const patch = {
    instead(name, fn) {
      records.insteadName = name;
      records.insteadFn = fn;
    },
    before(name, fn) {
      records.beforeNames = (records.beforeNames || []).concat([name]);
      if (name === "PluginRoutes") records.routesFn = fn;
    },
  };

  const Route = function Route() {
    return null;
  };
  const Link = function Link(props) {
    return React.createElement("a", props);
  };

  const window = {
    React: undefined,
    PluginApi: {
      React,
      ReactDOM: {
        createPortal: (node) => node,
      },
      libraries: {
        Bootstrap: { Dropdown, Button: function Button(props) {
          return React.createElement("button", props);
        } },
        FontAwesomeSolid: { faLink: { iconName: "link" } },
        ReactRouterDOM: { Route, Link },
      },
      components: {
        Icon: function Icon(props) {
          return React.createElement("svg", { "data-icon": props.icon && props.icon.iconName });
        },
      },
      patch,
    },
    localStorage,
  };

  const sandbox = {
    window,
    document: { body: {} },
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of [
    "ExternalLinkGroupsShared.js",
    "ExternalLinkGroupsStore.js",
    "ExternalLinkGroupsIcons.js",
    "ExternalLinkGroups.js",
    "ExternalLinkGroupsSettings.js",
  ]) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }

  const original = function OriginalButtons(props) {
    // Stash's own `ExternalLinkButtons` destructures `urls` from these props, so
    // an invocation with `undefined` is the exact failure this module shipped
    // once: it throws inside Stash's header image, not here.
    if (!props) {
      throw new Error("the patch called the original renderer with no props");
    }
    records.originalProps.push(props);
    // Array.from copies the sandbox-realm array into this realm so a strict
    // deep equality compares values rather than prototypes.
    records.originalCalls.push(Array.from(props.urls || []));
    return React.createElement("span", { "data-original": "1" });
  };

  // Stash's `instead` contract, from patch.tsx `runInstead`:
  //   fns[0].apply(thisArg, argArray.concat(next()))
  // React calls a function component with `(props, secondArg)`, and the rest of
  // the chain — the original render function itself — is appended last. A stub
  // that hands over `() => original` instead would prove a contract Stash does
  // not have, and would call `next()` where the plugin must call `original`.
  const tree = records.insteadFn({ urls }, undefined, original);

  // Flatten the returned element tree, invoking function components.
  function flatten(node, out) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) {
      node.forEach((child) => flatten(child, out));
      return;
    }
    if (typeof node !== "object") {
      out.push({ text: String(node) });
      return;
    }
    if (node.type === Fragment) {
      flatten(node.props.children, out);
      return;
    }
    if (typeof node.type === "function") {
      const rendered = React.__withSlots(() => node.type(node.props));
      flatten(rendered, out);
      return;
    }
    out.push({ type: node.type, props: node.props });
    flatten(node.props.children, out);
  }

  const out = [];
  flatten(tree, out);

  // The settings page is registered as a route; render it once as well, so a
  // broken createElement tree there fails here instead of in the browser.
  const settingsOut = [];
  if (records.routesFn) {
    const args = records.routesFn({ children: null });
    const routeEl = findElement(args[0] && args[0].children, (node) => node.props && node.props.path === "/plugins/externalurlgroups");
    if (routeEl) {
      const Page = routeEl.props.component;
      flatten(React.__withSlots(() => Page({})), settingsOut);
    }
  }

  return { out, records, tree, settingsOut };
}

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (predicate(node)) return node;
  return findElement(node.props && node.props.children, predicate);
}

const config = {
  version: 1,
  domains: [
    { domain: "onlyfans.com", enabled: true, separate: true },
    { domain: "tiktok.com", enabled: false, separate: true },
    { domain: "twitter.com", enabled: true, separate: false },
  ],
};

const urls = [
  "https://onlyfans.com/a",
  "onlyfans.com/b",
  "https://www.tiktok.com/@x",
  "https://twitter.com/y",
  "https://example.com/z",
];

test("patches the ExternalLinkButtons component", () => {
  const { records } = loadPlugin(urls, config);
  assert.equal(records.insteadName, "ExternalLinkButtons");
});

test("the original renderer receives props, once per render", () => {
  const { records } = loadPlugin(urls, config);

  assert.equal(records.originalProps.length, 1, "one render calls it once");
  assert.equal(typeof records.originalProps[0], "object");
  assert.ok(
    "urls" in records.originalProps[0],
    "the prop Stash destructures is present on the object it is handed"
  );
});

test("one URL per configured site renders a direct link", () => {
  const { out } = loadPlugin(["https://onlyfans.com/a", "https://example.com/z"], config);
  const link = out.find((node) => node.props && node.props.className && String(node.props.className).includes("elg-button"));

  assert.ok(link, "an elg button was rendered");
  assert.equal(link.type, "a", "a single URL renders an anchor, not a dropdown");
  assert.equal(link.props.href, "https://onlyfans.com/a");
  assert.equal(link.props.target, "_blank");
  assert.match(link.props["aria-label"], /onlyfans\.com/);
});

test("several URLs for one site render a dropdown with all of them", () => {
  const { out } = loadPlugin(urls, config);
  const menu = out.find((node) => node.props && node.props["data-menu"]);
  const items = out.filter((node) => node.props && node.props.title && String(node.props.href || "").includes("onlyfans.com"));

  assert.ok(menu, "a menu was rendered for the multi-link group");
  assert.deepEqual(
    items.map((node) => node.props.href),
    ["https://onlyfans.com/a", "https://onlyfans.com/b"]
  );
  const count = out.find((node) => node.props && node.props.className === "elg-count");
  assert.equal(count.props.children, "2");
});

test("disabled and unconfigured URLs are handed back to Stash", () => {
  const { records } = loadPlugin(urls, config);
  assert.equal(records.originalCalls.length, 1);
  assert.deepEqual(records.originalCalls[0], [
    "https://www.tiktok.com/@x",
    "https://example.com/z",
  ]);
});

test("an enabled-but-not-separate domain shares one button", () => {
  const { out, records } = loadPlugin(["https://twitter.com/y", "https://example.com/z"], config);
  const link = out.find((node) => node.props && node.props.className && String(node.props.className).includes("elg-button"));

  assert.equal(link.props.href, "https://twitter.com/y");
  assert.deepEqual(records.originalCalls[0], ["https://example.com/z"]);
});

test("a bucket holding several URLs renders a menu", () => {
  const { out } = loadPlugin(["https://twitter.com/y", "https://twitter.com/z"], config);
  const items = out.filter((node) => node.props && node.props["data-menu"]);

  assert.equal(items.length, 1);
  const count = out.find((node) => node.props && node.props.className === "elg-count");
  assert.equal(count.props.children, "2");
});

test("an empty config leaves Stash's rendering untouched", () => {
  const { out, records } = loadPlugin(urls, { version: 1, domains: [] });

  assert.deepEqual(records.originalCalls[0], urls);
  const buttons = out.filter((node) => node.props && node.props.className && String(node.props.className).includes("elg-button"));
  assert.equal(buttons.length, 0);
});

test("a missing urls prop does not throw", () => {
  const { records } = loadPlugin(undefined, config);
  assert.deepEqual(records.originalCalls[0], []);
});

test("the settings page renders the configured rows", () => {
  const { settingsOut } = loadPlugin(urls, config);
  const classes = settingsOut
    .filter((node) => node.props && node.props.className)
    .map((node) => String(node.props.className));

  assert.ok(
    classes.some((name) => name.includes("elg-set")),
    "the page root was rendered"
  );
  const rowClasses = classes.filter(
    (name) =>
      (name === "elg-set__row" || name.startsWith("elg-set__row ")) &&
      !name.includes("elg-set__row--head")
  );
  assert.equal(rowClasses.length, 3, "one row per configured domain");

  const domainInputs = settingsOut
    .filter((node) => node.type === "input" && node.props["aria-label"] === "Domain")
    .map((node) => node.props.value);
  assert.deepEqual(domainInputs, ["onlyfans.com", "tiktok.com", "twitter.com"]);
});

test("the settings page registers a route and a tools card", () => {
  const { records } = loadPlugin(urls, config);
  assert.deepEqual(records.beforeNames, ["PluginRoutes", "SettingsToolsSection"]);
});
