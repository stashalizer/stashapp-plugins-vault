/**
 * Smoke tests for the MosaicFilter overlay (MosaicFilter.js).
 *
 * Run the whole suite with `node --test` from the repo root, passing the test
 * glob in quotes (see AGENTS.md > Tests for the exact command).
 *
 * There is no jsdom here on purpose: the plugin is a browser IIFE that only
 * needs `window`, `document`, `csLib` and `localStorage`, so a hand-written
 * node stub is enough to mount it, drive real pointer events and check what it
 * renders and what it persists. The stub is deliberately dumb (querySelector
 * only answers the handful of lookups the overlay makes) — if the overlay
 * starts querying something new, the stub should grow, not the assertions.
 *
 * What this covers that the shared-model suite cannot: that adding, dragging,
 * hiding and deleting a second filter actually produces independent DOM nodes
 * and independent saved state.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedPath = path.join(here, "..", "plugins", "MosaicFilter", "MosaicFilterShared.js");
const overlayPath = path.join(here, "..", "plugins", "MosaicFilter", "MosaicFilter.js");

const PLAYER_W = 640;
const PLAYER_H = 360;

// ---------------------------------------------------------------------------
// A very small DOM
// ---------------------------------------------------------------------------

// The overlay gates its range-slider handling on `instanceof HTMLInputElement`,
// so the sandbox needs a constructor and the fake inputs need its prototype.
class FakeInputElement {}

function makeNode(doc, tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    children: [],
    parentElement: null,
    dataset: {},
    className: "",
    id: "",
    textContent: "",
    title: "",
    type: "",
    _listeners: {},
    _attrs: {},
    _html: "",
    _classes: new Set(),

    get classList() {
      const set = this._classes;
      return {
        add: (...names) => names.forEach((n) => set.add(n)),
        remove: (...names) => names.forEach((n) => set.delete(n)),
        toggle: (name, force) => {
          const on = force === undefined ? !set.has(name) : !!force;
          if (on) set.add(name);
          else set.delete(name);
          return on;
        },
        contains: (name) => set.has(name),
        get length() { return set.size; },
      };
    },

    get style() {
      if (!this._style) {
        const props = {};
        this._style = new Proxy(props, {
          get(target, key) {
            if (key === "setProperty") {
              return (name, value) => { target[name] = value; };
            }
            if (key === "removeProperty") {
              return (name) => { delete target[name]; };
            }
            return target[key] === undefined ? "" : target[key];
          },
          set(target, key, value) {
            target[key] = value;
            return true;
          },
        });
      }
      return this._style;
    },

    setAttribute(name, value) { this._attrs[name] = String(value); },
    getAttribute(name) { return this._attrs[name] === undefined ? null : this._attrs[name]; },
    removeAttribute(name) { delete this._attrs[name]; },
    hasAttribute(name) { return name in this._attrs; },

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentElement = null;
      return child;
    },
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    },
    contains(other) {
      let n = other;
      while (n) {
        if (n === this) return true;
        n = n.parentElement;
      }
      return false;
    },

    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this._listeners[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event) {
      const list = this._listeners[type];
      if (!list) return;
      for (const fn of list.slice()) fn(event);
    },
    closest(selector) {
      // The overlay only asks for "[data-action]".
      let n = this;
      while (n) {
        if (selector === "[data-action]" && n.dataset && n.dataset.action) return n;
        n = n.parentElement;
      }
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    attachShadow() {
      const shadow = makeNode(doc, "shadow-root");
      shadow.mode = "open";
      return shadow;
    },
    focus() { doc.activeElement = this; },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: PLAYER_W, bottom: PLAYER_H, width: PLAYER_W, height: PLAYER_H };
    },
    setPointerCapture() {},
    releasePointerCapture() {},

    get clientWidth() { return PLAYER_W; },
    get clientHeight() { return PLAYER_H; },
    get offsetWidth() { return this.className.indexOf("mosaic-filter-panel") >= 0 ? 288 : 120; },
    get offsetHeight() { return this.className.indexOf("mosaic-filter-panel") >= 0 ? 300 : 28; },
    get isConnected() { return true; },

    set innerHTML(value) { this._html = String(value); this.children = []; },
    get innerHTML() { return this._html; },
  };
  return node;
}

function makeDocument() {
  const doc = {
    _player: null,
    activeElement: null,
    title: "",
    body: null,
    createElement(tag) { return makeNode(doc, tag); },
    querySelector(selector) {
      if (selector === "#VideoJsPlayer") return doc._player;
      return null;
    },
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = doc._listeners[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event) {
      const list = doc._listeners[type];
      if (!list) return;
      for (const fn of list.slice()) fn(event);
    },
    _listeners: {},
  };
  doc.body = makeNode(doc, "body");
  return doc;
}

/** Depth-first search for the first descendant carrying a class. */
function findByClass(node, className) {
  if ((node.className || "").split(/\s+/).includes(className)) return node;
  for (const child of node.children) {
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
}

function findAllByClass(node, className, out = []) {
  if ((node.className || "").split(/\s+/).includes(className)) out.push(node);
  for (const child of node.children) findAllByClass(child, className, out);
  return out;
}

// ---------------------------------------------------------------------------
// Loading the overlay into a fresh sandbox
// ---------------------------------------------------------------------------

/**
 * Boot MosaicFilter.js with `stored` as the config on disk, mount it on a fake
 * player and hand back the pieces a test needs to drive it.
 */
async function boot(stored) {
  const doc = makeDocument();
  const player = makeNode(doc, "div");
  player.className = "video-js";
  doc._player = player;

  const saved = { value: null, calls: 0 };
  let pathCallback = null;

  const storage = {
    loadConfig: async () => JSON.parse(JSON.stringify(stored)),
    saveConfig: async (value) => {
      saved.value = JSON.parse(JSON.stringify(value));
      saved.calls += 1;
      return true;
    },
  };

  const csLib = {
    PathElementListener(route, selector, callback) { pathCallback = callback; },
    getConfiguration: async () => ({}),
    setConfiguration: async () => true,
  };

  const sandbox = {
    console,
    Set,
    Map,
    Math,
    JSON,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    fetch: async () => { throw new Error("network is not expected in a test"); },
    localStorage: {
      _data: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
    },
    getComputedStyle: () => ({ position: "relative" }),
  };
  sandbox.window = sandbox;
  sandbox.document = doc;
  sandbox.location = { pathname: "/scenes/42" };
  sandbox.csLib = csLib;
  sandbox.MosaicFilterStorage = storage;
  sandbox.HTMLInputElement = FakeInputElement;
  // `window` is the sandbox itself, so these have to live on it.
  sandbox._listeners = {};
  sandbox.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  sandbox.removeEventListener = function (type, fn) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  // No window.PluginApi: the studio lookup then short-circuits to null, which
  // is exactly what the overlay does on a scene without a studio.

  vm.createContext(sandbox);
  // Same order as the manifest: the shared module must define
  // window.MosaicFilterShared before the overlay reads it.
  vm.runInContext(readFileSync(sharedPath, "utf8"), sandbox, { filename: sharedPath });
  vm.runInContext(readFileSync(overlayPath, "utf8"), sandbox, { filename: overlayPath });

  assert.equal(typeof pathCallback, "function", "the overlay registers a path listener");

  await pathCallback(player);
  // Let the fire-and-forget saves settle.
  await new Promise((resolve) => setImmediate(resolve));

  return {
    doc,
    player,
    saved,
    sandbox,
    rects: () => findAllByClass(player, "mosaic-filter-rectangle"),
    masks: () => findAllByClass(player, "mosaic-filter-mask-layer"),
    chrome: () => findByClass(player, "mosaic-filter-chrome"),
    /** Click a delegated control in the chrome by its data-action. */
    async click(action, value) {
      const chrome = findByClass(player, "mosaic-filter-chrome");
      const target = makeNode(doc, "button");
      target.dataset.action = action;
      if (value !== undefined) target.dataset.value = value;
      target.parentElement = chrome;
      chrome.dispatch("click", { target, preventDefault() {}, stopPropagation() {} });
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** A fake <input> the overlay's `instanceof HTMLInputElement` accepts. */
    input(value, action) {
      const el = makeNode(doc, "input");
      el.value = String(value);
      if (action) el.dataset.action = action;
      Object.setPrototypeOf(el, FakeInputElement.prototype);
      return el;
    },
    /** Press a region and move the pointer by a pixel delta. */
    dragRect(rectNode, dx, dy) {
      rectNode.dispatch("pointerdown", {
        button: 0,
        pointerId: 7,
        clientX: 100,
        clientY: 100,
        target: rectNode,
        preventDefault() {},
        stopPropagation() {},
      });
      doc.dispatch("pointermove", { pointerId: 7, clientX: 100 + dx, clientY: 100 + dy });
      doc.dispatch("pointerup", { pointerId: 7 });
    },
  };
}

const LEGACY_CONFIG = {
  blurAmount: 25,
  widthPct: 0.25,
  heightPct: 0.25,
  xPct: 0.1,
  yPct: 0.1,
  active: true,
  shape: "rectangle",
  mode: "normal",
  fill: "blur",
  fillColor: "#000000",
  pixelSize: 16,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("a legacy single-filter config mounts exactly one region and one mask", async () => {
  const app = await boot(LEGACY_CONFIG);
  const rects = app.rects();
  assert.equal(rects.length, 1);
  assert.equal(app.masks().length, 1);
  // 25% of a 640x360 player.
  assert.equal(rects[0].style.width, "160px");
  assert.equal(rects[0].style.height, "90px");
  assert.equal(rects[0].style.left, "64px");
  assert.equal(rects[0].style.top, "36px");
  // The legacy blur amount reaches the region as its own custom property.
  assert.equal(rects[0].style["--mf-blur"], "25px");
});

test("adding a filter creates a second independent region", async () => {
  const app = await boot(LEGACY_CONFIG);
  assert.equal(app.rects().length, 1);

  await app.click("add-filter");

  const rects = app.rects();
  assert.equal(rects.length, 2, "one region node per filter");
  assert.equal(app.masks().length, 2, "one reverse mask per filter");
  assert.equal(app.saved.value.default.filters.length, 2);
  assert.equal(app.saved.value.default.selectedId, app.saved.value.default.filters[1].id);

  // The new region is offset from its parent, so it is actually visible.
  assert.notEqual(rects[0].style.left, rects[1].style.left);
  assert.notEqual(rects[1].style.left, "");
});

test("dragging one region moves only that region", async () => {
  const app = await boot(LEGACY_CONFIG);
  await app.click("add-filter");

  const [first, second] = app.rects();
  const firstLeft = first.style.left;
  const firstTop = first.style.top;

  // +64px / +36px is exactly 10% of the fake player on each axis.
  app.dragRect(second, PLAYER_W * 0.1, PLAYER_H * 0.1);
  await new Promise((resolve) => setImmediate(resolve));

  const filters = app.saved.value.default.filters;
  assert.equal(filters.length, 2);
  const second0 = 0.1 + 0.06; // spawn offsets by NEW_FILTER_OFFSET
  assert.ok(Math.abs(filters[1].xPct - (second0 + 0.1)) < 1e-6, "dragged region moved");
  assert.ok(Math.abs(filters[1].yPct - (second0 + 0.1)) < 1e-6);
  assert.equal(filters[0].xPct, 0.1, "the other region's geometry is untouched");
  assert.equal(filters[0].yPct, 0.1);
  assert.equal(first.style.left, firstLeft, "and its DOM node did not move");
  assert.equal(first.style.top, firstTop);
});

test("per-region parameters stay independent in the DOM", async () => {
  const app = await boot(LEGACY_CONFIG);
  await app.click("add-filter");
  const [first, second] = app.rects();

  // Select the first region and change its blur through the panel's slider.
  const filters = app.saved.value.default.filters;
  await app.click("select-filter", filters[0].id);
  const chrome = app.chrome();
  chrome.dispatch("input", { target: app.input(70, "blur-slider"), preventDefault() {} });
  chrome.dispatch("change", { target: app.input(70, "blur-slider"), preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.style["--mf-blur"], "70px");
  assert.equal(second.style["--mf-blur"], "25px", "the sibling keeps its own blur");
  assert.equal(app.saved.value.default.filters[0].blurAmount, 70);
  assert.equal(app.saved.value.default.filters[1].blurAmount, 25);
});

test("hiding one region leaves the other visible", async () => {
  const app = await boot(LEGACY_CONFIG);
  await app.click("add-filter");
  const filters = app.saved.value.default.filters;

  await app.click("toggle-filter", filters[0].id);

  const [first, second] = app.rects();
  assert.ok(first.classList.contains("mosaic-filter-rectangle--hidden"));
  assert.ok(!second.classList.contains("mosaic-filter-rectangle--hidden"));
  assert.equal(app.saved.value.default.filters[0].active, false);
  assert.equal(app.saved.value.default.filters[1].active, true);
});

test("deleting one region removes only its nodes", async () => {
  const app = await boot(LEGACY_CONFIG);
  await app.click("add-filter");
  await app.click("add-filter");
  assert.equal(app.rects().length, 3);

  const filters = app.saved.value.default.filters;
  const doomed = filters[1].id;
  await app.click("delete-filter", doomed);

  assert.equal(app.rects().length, 2);
  assert.equal(app.masks().length, 2);
  assert.equal(app.saved.value.default.filters.length, 2);
  assert.ok(!app.saved.value.default.filters.some((f) => f.id === doomed));
  assert.equal(app.saved.value.default.filters[0].blurAmount, 25, "the survivors keep their state");
});

test("the last region cannot be deleted", async () => {
  const app = await boot(LEGACY_CONFIG);
  // Force one write so the persisted id is readable.
  await app.click("toggle-active");
  const id = app.saved.value.default.filters[0].id;

  // The delete button is not rendered for a single-filter layer, but the
  // handler must not empty the layer even if it is reached.
  await app.click("delete-filter", id);

  assert.equal(app.rects().length, 1, "the single region survives");
  assert.equal(app.masks().length, 1);
  assert.equal(app.saved.value.default.filters.length, 1);
});

test("a reverse region gets its own live mask, and turning it off hides that mask", async () => {
  const app = await boot(LEGACY_CONFIG);
  await app.click("add-filter");
  const filters = app.saved.value.default.filters;
  await app.click("select-filter", filters[1].id);

  await app.click("set-mode", "reverse");
  let masks = app.masks();
  assert.equal(masks.length, 2);
  assert.ok(masks[1].classList.contains("mosaic-filter-mask-layer--reverse"));
  assert.ok(!masks[0].classList.contains("mosaic-filter-mask-layer--reverse"));
  assert.match(masks[1].style.clipPath, /^path\('/, "the hole is a real path");

  // Filter off: that mask must go dark even though the other region is live.
  await app.click("toggle-active");
  masks = app.masks();
  assert.ok(masks[1].classList.contains("mosaic-filter-mask-layer--hidden"));
});

test("switching the fill of one region does not change the other", async () => {
  const app = await boot(LEGACY_CONFIG);
  await app.click("add-filter");
  const filters = app.saved.value.default.filters;
  await app.click("select-filter", filters[1].id);
  await app.click("set-fill", "solid");

  const [first, second] = app.rects();
  assert.ok(second.classList.contains("mosaic-filter-rectangle--fill-solid"));
  assert.ok(!first.classList.contains("mosaic-filter-rectangle--fill-solid"));
  assert.equal(app.saved.value.default.filters[0].fill, "blur");
  assert.equal(app.saved.value.default.filters[1].fill, "solid");
});
