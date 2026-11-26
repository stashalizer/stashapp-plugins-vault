/**
 * Tests for MosaicFilterShared — the multi-filter data model.
 *
 *   node --test tests/
 *
 * No dependencies and no bundler: MosaicFilterShared.js is a browser IIFE that
 * only touches `window`, so it runs unchanged inside a node:vm sandbox. The
 * alternative — pulling in jsdom or a DOM shim — would test a different object
 * than the one Stash loads.
 *
 * Values that cross the realm boundary (everything the sandbox creates) are
 * converted with `snap()` before a strict comparison, because a strict deep
 * equality also compares prototypes and the sandbox has its own Object/Array.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedPath = path.join(here, "..", "plugins", "MosaicFilter", "MosaicFilterShared.js");

function loadShared() {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(sharedPath, "utf8"), sandbox, { filename: sharedPath });
  return sandbox.window.MosaicFilterShared;
}

const S = loadShared();

/** Clone a sandbox value into host-realm plain objects. */
const snap = (value) => JSON.parse(JSON.stringify(value));

/** Assert the invariants every sanitized layer must hold. */
function assertLayerInvariants(layer) {
  assert.ok(Array.isArray(layer.filters), "layer.filters is an array");
  assert.ok(layer.filters.length >= 1, "a layer always holds at least one filter");
  assert.ok(layer.filters.length <= S.MAX_FILTERS, "a layer never exceeds MAX_FILTERS");
  const ids = layer.filters.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "filter ids are unique");
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,40}$/, "ids are selector-safe");
  assert.ok(ids.includes(layer.selectedId), "selectedId points at a real filter");
  for (const f of layer.filters) {
    assert.ok(f.widthPct >= S.MIN_SIZE_PCT && f.widthPct <= 1);
    assert.ok(f.heightPct >= S.MIN_SIZE_PCT && f.heightPct <= 1);
    assert.ok(f.xPct + f.widthPct <= 1 + 1e-9, "filter stays inside the frame horizontally");
    assert.ok(f.yPct + f.heightPct <= 1 + 1e-9, "filter stays inside the frame vertically");
    assert.ok(f.blurAmount >= 0 && f.blurAmount <= S.MAX_BLUR);
    assert.match(f.fillColor, /^#[0-9a-fA-F]{6}$/);
    assert.ok(["rectangle", "ellipse"].includes(f.shape));
    assert.ok(["normal", "reverse"].includes(f.mode));
    assert.ok(["blur", "solid", "pixelate"].includes(f.fill));
    assert.equal(typeof f.name, "string");
    assert.ok(f.name.length <= S.MAX_NAME_LEN);
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("makeDefaultConfig holds exactly one inactive filter and selects it", () => {
  const config = snap(S.makeDefaultConfig());
  assertLayerInvariants(config.default);
  assert.equal(config.default.filters.length, 1);
  assert.equal(config.default.filters[0].name, "");
  assert.equal(S.filterName(config.default.filters[0], 0), "Filter 1");
  assert.equal(config.default.filters[0].active, false);
  assert.equal(config.default.selectedId, config.default.filters[0].id);
  assert.deepEqual(config.scenePresets, {});
  assert.deepEqual(config.studioPresets, {});
});

test("makeDefaultLayer and makeDefaultState agree on the parameter defaults", () => {
  const layer = snap(S.makeDefaultLayer());
  const params = snap(S.makeDefaultState());
  assert.equal(layer.filters.length, 1);
  for (const key of Object.keys(S.FALLBACK_DEFAULTS)) {
    assert.deepEqual(layer.filters[0][key], params[key], `default for ${key}`);
  }
});

test("sanitizeFilter clamps out-of-range values instead of trusting them", () => {
  const f = snap(S.sanitizeFilter({
    blurAmount: 999,
    widthPct: 0.01,
    heightPct: 2,
    xPct: 5,
    yPct: -3,
    pixelSize: 1,
    shape: "triangle",
    mode: "sideways",
    fill: "glitter",
    fillColor: "red",
  }, 0));
  assert.equal(f.blurAmount, S.MAX_BLUR);
  assert.equal(f.widthPct, S.MIN_SIZE_PCT);
  assert.equal(f.heightPct, 1);
  // xPct is clamped to the widest position the (already clamped) width allows.
  assert.equal(f.xPct, 1 - S.MIN_SIZE_PCT);
  assert.equal(f.yPct, 0);
  assert.equal(f.pixelSize, 4);
  assert.equal(f.shape, "rectangle");
  assert.equal(f.mode, "normal");
  assert.equal(f.fill, "blur");
  assert.equal(f.fillColor, "#000000");
});

test("sanitizeFilter re-keys an id that cannot be used as a selector", () => {
  const f = snap(S.sanitizeFilter({ id: 'x"] , body', name: "Face" }));
  assert.match(f.id, /^[A-Za-z0-9_-]{1,40}$/);
  assert.equal(f.name, "Face");
});

// ---------------------------------------------------------------------------
// Legacy compatibility (the single-filter era)
// ---------------------------------------------------------------------------

test("legacy flat config becomes one filter with every parameter intact", () => {
  // Exactly what 0.7.0 wrote: the flat state was the whole config.
  const legacy = {
    blurAmount: 42,
    widthPct: 0.4,
    heightPct: 0.3,
    xPct: 0.25,
    yPct: 0.5,
    active: true,
    follow: true,
    shape: "ellipse",
    mode: "reverse",
    fill: "solid",
    fillColor: "#123456",
    pixelSize: 24,
  };
  const config = snap(S.normalizeConfig(legacy));
  assertLayerInvariants(config.default);
  assert.equal(config.default.filters.length, 1);
  const f = config.default.filters[0];
  for (const key of Object.keys(S.FALLBACK_DEFAULTS)) {
    assert.deepEqual(f[key], legacy[key], `${key} survives the upgrade`);
  }
  assert.equal(S.filterName(f, 0), "Filter 1");
  assert.equal(config.default.selectedId, f.id);
});

test("0.7.0 {default: <flat>} keeps its presets and upgrades each to a layer", () => {
  const stored = {
    default: { blurAmount: 12, widthPct: 0.25, heightPct: 0.25, xPct: 0.1, yPct: 0.1, active: true },
    scenePresets: { "42": { blurAmount: 30, active: true, shape: "ellipse" } },
    studioPresets: { "7": { blurAmount: 5, fill: "solid", fillColor: "#ff0000" } },
  };
  const config = snap(S.normalizeConfig(stored));
  assert.equal(config.default.filters[0].blurAmount, 12);
  assert.equal(config.scenePresets["42"].filters.length, 1);
  assert.equal(config.scenePresets["42"].filters[0].blurAmount, 30);
  assert.equal(config.scenePresets["42"].filters[0].shape, "ellipse");
  assert.equal(config.studioPresets["7"].filters[0].fillColor, "#ff0000");
  assertLayerInvariants(config.scenePresets["42"]);
  assertLayerInvariants(config.studioPresets["7"]);
});

test("<= 0.2.x {defaults, scenes} uses defaults and drops the unused scenes map", () => {
  const config = snap(S.normalizeConfig({
    defaults: { blurAmount: 18, widthPct: 0.5, heightPct: 0.5, xPct: 0, yPct: 0 },
    scenes: { "1": { blurAmount: 99 } },
  }));
  assert.equal(config.default.filters.length, 1);
  assert.equal(config.default.filters[0].blurAmount, 18);
  assert.equal(config.default.filters[0].widthPct, 0.5);
  assert.deepEqual(config.scenePresets, {});
});

test("empty, null and garbage configs all degrade to one default filter", () => {
  for (const stored of [undefined, null, {}, "nope", 42, { default: null }, { filters: [] }]) {
    const config = snap(S.normalizeConfig(stored));
    assertLayerInvariants(config.default);
    assert.equal(config.default.filters.length, 1, `stored=${JSON.stringify(stored)}`);
    assert.equal(config.default.filters[0].blurAmount, S.FALLBACK_DEFAULTS.blurAmount);
  }
});

test("normalizeConfig is idempotent", () => {
  const stored = {
    default: { filters: [{ id: "a", blurAmount: 3, active: true }, { id: "b", shape: "ellipse" }], selectedId: "b" },
    scenePresets: { "9": { blurAmount: 20 } },
  };
  const once = snap(S.normalizeConfig(stored));
  const twice = snap(S.normalizeConfig(once));
  assert.deepEqual(twice, once);
});

test("a layer that already holds filters keeps them all, with their own state", () => {
  const stored = {
    default: {
      filters: [
        { id: "left", name: "Left eye", blurAmount: 8, widthPct: 0.1, heightPct: 0.1, xPct: 0.1, yPct: 0.2, active: true, fill: "blur" },
        { id: "right", name: "Right eye", blurAmount: 40, widthPct: 0.2, heightPct: 0.15, xPct: 0.7, yPct: 0.6, active: false, fill: "solid", fillColor: "#ffffff", shape: "ellipse" },
      ],
      selectedId: "right",
    },
  };
  const config = snap(S.normalizeConfig(stored));
  assertLayerInvariants(config.default);
  const [left, right] = config.default.filters;
  assert.equal(left.id, "left");
  assert.equal(left.blurAmount, 8);
  assert.equal(left.active, true);
  assert.equal(left.fill, "blur");
  assert.equal(right.id, "right");
  assert.equal(right.blurAmount, 40);
  assert.equal(right.active, false);
  assert.equal(right.fill, "solid");
  assert.equal(right.shape, "ellipse");
  assert.equal(right.xPct, 0.7);
  assert.equal(config.default.selectedId, "right");
});

test("duplicate ids are re-keyed so two filters never share one DOM node", () => {
  const config = snap(S.normalizeConfig({
    default: { filters: [{ id: "same", blurAmount: 1 }, { id: "same", blurAmount: 2 }], selectedId: "same" },
  }));
  assertLayerInvariants(config.default);
  assert.equal(config.default.filters[0].id, "same");
  assert.notEqual(config.default.filters[1].id, "same");
  assert.equal(config.default.filters[1].blurAmount, 2);
  assert.equal(config.default.selectedId, "same");
});

test("a selectedId that no longer exists falls back to the first filter", () => {
  const config = snap(S.normalizeConfig({
    default: { filters: [{ id: "a" }, { id: "b" }], selectedId: "deleted" },
  }));
  assert.equal(config.default.selectedId, "a");
});

test("a layer is capped at MAX_FILTERS and keeps the leading ones", () => {
  const filters = [];
  for (let i = 0; i < S.MAX_FILTERS + 5; i++) filters.push({ id: "f" + i, blurAmount: i });
  const config = snap(S.normalizeConfig({ default: { filters, selectedId: "f0" } }));
  assert.equal(config.default.filters.length, S.MAX_FILTERS);
  assert.equal(config.default.filters[0].blurAmount, 0);
  assert.equal(config.default.filters[S.MAX_FILTERS - 1].blurAmount, S.MAX_FILTERS - 1);
});

// ---------------------------------------------------------------------------
// Adding filters
// ---------------------------------------------------------------------------

test("addFilter appends, selects the new filter and leaves the others untouched", () => {
  const layer = S.makeDefaultLayer();
  S.updateFilter(layer, layer.filters[0].id, {
    name: "First", blurAmount: 33, xPct: 0.1, yPct: 0.1, active: true,
  });
  const before = snap(layer.filters[0]);

  const added = S.addFilter(layer, { blurAmount: 7, xPct: 0.6, yPct: 0.6, active: true });

  assert.ok(added);
  assertLayerInvariants(layer);
  assert.equal(layer.filters.length, 2);
  assert.equal(layer.selectedId, added.id);
  assert.notEqual(added.id, layer.filters[0].id);
  assert.equal(added.name, "", "an unnamed filter falls back to its position");
  assert.equal(S.filterName(added, 1), "Filter 2");
  assert.equal(added.blurAmount, 7);
  assert.deepEqual(snap(layer.filters[0]), before, "the existing filter is not overwritten");
});

test("addFilter keeps ids unique even when the same name is used twice", () => {
  const layer = S.makeDefaultLayer();
  const a = S.addFilter(layer, { name: "Face" });
  const b = S.addFilter(layer, { name: "Face" });
  assert.notEqual(a.id, b.id);
  assertLayerInvariants(layer);
  assert.equal(layer.filters.length, 3);
});

test("addFilter refuses past MAX_FILTERS instead of dropping a filter silently", () => {
  const layer = S.makeDefaultLayer();
  while (layer.filters.length < S.MAX_FILTERS) S.addFilter(layer, {});
  assert.equal(layer.filters.length, S.MAX_FILTERS);
  const idsBefore = layer.filters.map((f) => f.id);
  assert.equal(S.addFilter(layer, {}), null);
  assert.deepEqual(layer.filters.map((f) => f.id), idsBefore);
  assert.equal(layer.filters.length, S.MAX_FILTERS);
});

test("addFilter sanitizes its overrides and leaves the frame violations clamped", () => {
  const layer = S.makeDefaultLayer();
  const added = S.addFilter(layer, { widthPct: 0.9, heightPct: 0.9, xPct: 0.9, yPct: 0.9, blurAmount: 500 });
  assert.equal(added.blurAmount, S.MAX_BLUR);
  // Both axes are pushed back inside the frame, whatever the rounding does.
  assert.ok(Math.abs(added.xPct - (1 - added.widthPct)) < 1e-9);
  assert.ok(Math.abs(added.yPct - (1 - added.heightPct)) < 1e-9);
  assertLayerInvariants(layer);
});

test("addFilter cannot be steered onto an existing id by its overrides", () => {
  const layer = S.makeDefaultLayer();
  const first = layer.filters[0];
  S.addFilter(layer, { id: first.id });
  assert.notEqual(layer.filters[1].id, first.id);
  assertLayerInvariants(layer);
});

// ---------------------------------------------------------------------------
// Editing filters
// ---------------------------------------------------------------------------

test("updateFilter only touches the filter it is given", () => {
  const layer = S.makeDefaultLayer();
  const a = S.addFilter(layer, { blurAmount: 11 });
  const b = S.addFilter(layer, { blurAmount: 22 });
  const snapshotA = snap(a);
  const snapshotB = snap(b);

  S.updateFilter(layer, a.id, { blurAmount: 60 });

  assert.equal(a.blurAmount, 60);
  assert.equal(b.blurAmount, 22);
  assert.deepEqual(snap(b), snapshotB, "the sibling filter is untouched");
  assert.equal(a.id, snapshotA.id);
  assert.equal(a.name, snapshotA.name, "an unnamed patch does not rename");
});

test("updateFilter keeps object identity and pins the id", () => {
  const layer = S.makeDefaultLayer();
  const target = layer.filters[0];
  const returned = S.updateFilter(layer, target.id, { id: "hijacked", xPct: 0.5 });
  assert.equal(returned, target, "identity is preserved for drags in flight");
  assert.equal(target.id, layer.filters[0].id);
  assert.notEqual(target.id, "hijacked");
  assert.equal(target.xPct, 0.5);
});

test("updateFilter sanitizes every patched field", () => {
  const layer = S.makeDefaultLayer();
  const id = layer.filters[0].id;
  S.updateFilter(layer, id, { fillColor: "blue", shape: "hexagon", pixelSize: 999, follow: "yes" });
  const f = S.findFilter(layer, id);
  assert.equal(f.fillColor, "#000000");
  assert.equal(f.shape, "rectangle");
  assert.equal(f.pixelSize, 64);
  assert.equal(f.follow, false);
});

test("updateFilter moves a region without pushing it out of the frame", () => {
  const layer = S.makeDefaultLayer();
  const id = layer.filters[0].id;
  S.updateFilter(layer, id, { widthPct: 0.4, heightPct: 0.4, xPct: 0.95, yPct: 0.95 });
  const f = S.findFilter(layer, id);
  assert.ok(f.xPct + f.widthPct <= 1 + 1e-9);
  assert.ok(f.yPct + f.heightPct <= 1 + 1e-9);
});

test("updateFilter returns null for an unknown id and changes nothing", () => {
  const layer = S.makeDefaultLayer();
  const before = snap(layer);
  assert.equal(S.updateFilter(layer, "nope", { blurAmount: 1 }), null);
  assert.deepEqual(snap(layer), before);
});

test("resetFilter restores parameters but keeps the id and the custom name", () => {
  const layer = S.makeDefaultLayer();
  const id = layer.filters[0].id;
  S.updateFilter(layer, id, {
    name: "Tattoo", blurAmount: 55, shape: "ellipse", mode: "reverse",
    fill: "solid", active: true, follow: true, widthPct: 0.6, xPct: 0.2,
  });
  S.resetFilter(layer, id);
  const f = S.findFilter(layer, id);
  assert.equal(f.id, id);
  assert.equal(f.name, "Tattoo");
  for (const key of Object.keys(S.FALLBACK_DEFAULTS)) {
    assert.deepEqual(f[key], S.FALLBACK_DEFAULTS[key], `${key} is back to its default`);
  }
});

// ---------------------------------------------------------------------------
// Removing filters
// ---------------------------------------------------------------------------

test("removeFilter deletes only the requested filter and reselects a neighbour", () => {
  const layer = S.makeDefaultLayer();
  const a = layer.filters[0];
  const b = S.addFilter(layer, { blurAmount: 20 });
  const c = S.addFilter(layer, { blurAmount: 30 });
  assert.equal(layer.selectedId, c.id);

  assert.equal(S.removeFilter(layer, c.id), true);
  assert.equal(layer.filters.length, 2);
  assert.deepEqual(snap(layer.filters.map((f) => f.id)), [a.id, b.id]);
  assert.equal(layer.selectedId, b.id, "selection moves to the previous filter");
  assertLayerInvariants(layer);

  assert.equal(S.removeFilter(layer, a.id), true);
  assert.equal(layer.filters.length, 1);
  assert.equal(layer.selectedId, b.id);
  assert.equal(layer.filters[0].blurAmount, 20, "the survivor keeps its own state");
});

test("removeFilter keeps the selection when another filter is deleted", () => {
  const layer = S.makeDefaultLayer();
  const a = layer.filters[0];
  const b = S.addFilter(layer, {});
  S.selectFilter(layer, a.id);
  assert.equal(S.removeFilter(layer, b.id), true);
  assert.equal(layer.selectedId, a.id);
  assert.equal(layer.filters.length, 1);
});

test("removeFilter refuses to empty the layer", () => {
  const layer = S.makeDefaultLayer();
  const id = layer.filters[0].id;
  assert.equal(S.removeFilter(layer, id), false);
  assert.equal(layer.filters.length, 1);
  assert.equal(layer.selectedId, id);
});

test("removeFilter reports an unknown id", () => {
  const layer = S.makeDefaultLayer();
  S.addFilter(layer, {});
  assert.equal(S.removeFilter(layer, "nope"), false);
  assert.equal(layer.filters.length, 2);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("selectFilter stores the id and ignores unknown ones", () => {
  const layer = S.makeDefaultLayer();
  const a = layer.filters[0];
  const b = S.addFilter(layer, {});
  assert.equal(S.selectFilter(layer, a.id), a);
  assert.equal(layer.selectedId, a.id);
  assert.equal(S.selectFilter(layer, "nope"), a, "an unknown id keeps the current selection");
  assert.equal(layer.selectedId, a.id);
});

test("selectedFilter never returns null for a sanitized layer", () => {
  const layer = S.makeDefaultLayer();
  assert.equal(S.selectedFilter(layer).id, layer.selectedId);
  layer.selectedId = "gone";
  assert.equal(S.selectedFilter(layer).id, layer.filters[0].id);
});

// ---------------------------------------------------------------------------
// Resolution, presets and isolation
// ---------------------------------------------------------------------------

test("resolveState prefers scene over studio over the global default", () => {
  const config = S.normalizeConfig({
    default: { filters: [{ id: "d" }] },
    studioPresets: { "9": { filters: [{ id: "s" }] } },
    scenePresets: { "42": { filters: [{ id: "c" }] } },
  });
  assert.equal(S.resolveState(config, "42", "9").filters[0].id, "c");
  assert.equal(S.resolveState(config, "43", "9").filters[0].id, "s");
  assert.equal(S.resolveState(config, "43", "8").filters[0].id, "d");
  assert.equal(S.resolveState(config, null, null).filters[0].id, "d");
});

test("resolveState upgrades a legacy flat scene preset", () => {
  const config = S.normalizeConfig({
    default: { blurAmount: 10 },
    scenePresets: { "42": { blurAmount: 70, active: true } },
  });
  const resolved = S.resolveState(config, "42", null);
  assert.equal(resolved.filters.length, 1);
  assert.equal(resolved.filters[0].blurAmount, 70);
  assert.equal(resolved.filters[0].active, true);
});

test("a resolved layer is detached from the config it came from", () => {
  const config = S.normalizeConfig({
    default: { filters: [{ id: "d", blurAmount: 10 }, { id: "e", blurAmount: 20 }] },
    scenePresets: { "42": { filters: [{ id: "c", blurAmount: 30 }] } },
  });
  const before = snap(config);

  const resolved = S.resolveState(config, "42", null);
  S.updateFilter(resolved, "c", { blurAmount: 60, xPct: 0.4 });
  S.addFilter(resolved, { blurAmount: 5 });
  S.removeFilter(resolved, "c");

  assert.deepEqual(snap(config), before, "editing the effective layer never writes back");
});

test("makePresetLayer stores a detached copy", () => {
  const layer = S.makeDefaultLayer();
  S.addFilter(layer, { blurAmount: 12 });
  const preset = S.makePresetLayer(layer);
  const stored = snap(preset);

  S.updateFilter(layer, layer.filters[0].id, { blurAmount: 77 });
  S.addFilter(layer, { blurAmount: 88 });

  assert.deepEqual(snap(preset), stored);
  assert.equal(stored.filters.length, 2);
});

test("presetSource reports which layer wins", () => {
  const config = S.normalizeConfig({
    scenePresets: { "42": { filters: [{ id: "c" }] } },
    studioPresets: { "9": { filters: [{ id: "s" }] } },
  });
  assert.equal(S.presetSource(config, "42", "9"), "scene");
  assert.equal(S.presetSource(config, "43", "9"), "studio");
  assert.equal(S.presetSource(config, "43", "8"), "default");
});

test("filterName falls back to the row position", () => {
  assert.equal(S.filterName({ name: "Face" }, 0), "Face");
  assert.equal(S.filterName({}, 2), "Filter 3");
  assert.equal(S.filterName(null, 0), "Filter 1");
});

// ---------------------------------------------------------------------------
// End-to-end at the model level: upgrade, add, edit, delete, save
// ---------------------------------------------------------------------------

test("a legacy single-filter session can grow to several filters and shrink again", () => {
  // What the overlay does on mount with 0.7.0 data on disk.
  const config = S.normalizeConfig({
    blurAmount: 25, widthPct: 0.3, heightPct: 0.3, xPct: 0.2, yPct: 0.2, active: true,
    scenePresets: { "42": { blurAmount: 55, active: true } },
  });
  let layer = S.resolveState(config, null, null);
  assert.equal(layer.filters.length, 1);
  assert.equal(layer.filters[0].blurAmount, 25);

  // Add a second region and give it its own geometry/parameters.
  const second = S.addFilter(layer, { blurAmount: 60, xPct: 0.6, yPct: 0.6, shape: "ellipse", fill: "solid", fillColor: "#00ff00" });
  S.updateFilter(layer, layer.filters[0].id, { xPct: 0.05, yPct: 0.05, fill: "pixelate" });

  // Overlay-style save: the effective layer replaces the global default and
  // the untouched scene preset keeps its own single filter.
  config.default = S.makePresetLayer(layer);
  assert.equal(config.default.filters.length, 2);
  assert.equal(config.default.filters[0].fill, "pixelate");
  assert.equal(config.default.filters[1].id, second.id);
  assert.equal(config.scenePresets["42"].filters.length, 1);
  assert.equal(config.scenePresets["42"].filters[0].blurAmount, 55);

  // Reload: the two filters come back exactly as saved.
  const reloaded = S.resolveState(config, null, null);
  assert.equal(reloaded.filters.length, 2);
  assert.equal(reloaded.filters[1].shape, "ellipse");
  assert.equal(reloaded.filters[1].fillColor, "#00ff00");
  assert.equal(reloaded.selectedId, second.id);

  // Delete one, reload again: one filter, still the surviving one's state.
  S.removeFilter(reloaded, second.id);
  config.default = S.makePresetLayer(reloaded);
  const again = S.resolveState(config, null, null);
  assert.equal(again.filters.length, 1);
  assert.equal(again.filters[0].fill, "pixelate");
  assert.equal(again.filters[0].blurAmount, 25);
});

test("editing one scene's layer cannot disturb another scene's preset", () => {
  const config = S.normalizeConfig({
    scenePresets: {
      "1": { filters: [{ id: "a", blurAmount: 11 }] },
      "2": { filters: [{ id: "b", blurAmount: 22 }] },
    },
  });
  const one = S.resolveState(config, "1", null);
  S.updateFilter(one, "a", { blurAmount: 99 });
  S.addFilter(one, { blurAmount: 1 });
  config.scenePresets["1"] = S.makePresetLayer(one);

  const two = S.resolveState(config, "2", null);
  assert.equal(two.filters.length, 1);
  assert.equal(two.filters[0].blurAmount, 22);
});

// ---------------------------------------------------------------------------
// spawnFilter — the seeding both surfaces use for "Add filter"
// ---------------------------------------------------------------------------

test("spawnFilter clones the selected filter, offsets it and makes it live", () => {
  const layer = S.makeDefaultLayer();
  const first = layer.filters[0];
  S.updateFilter(layer, first.id, {
    blurAmount: 44, shape: "ellipse", fill: "solid", fillColor: "#00ff00",
    widthPct: 0.2, heightPct: 0.2, xPct: 0.1, yPct: 0.1, active: false,
  });

  const spawned = S.spawnFilter(layer);

  assert.equal(layer.filters.length, 2);
  assert.equal(layer.selectedId, spawned.id);
  assert.equal(spawned.blurAmount, 44);
  assert.equal(spawned.shape, "ellipse");
  assert.equal(spawned.fill, "solid");
  assert.equal(spawned.fillColor, "#00ff00");
  assert.equal(spawned.widthPct, 0.2);
  assert.equal(spawned.heightPct, 0.2);
  assert.equal(spawned.active, true, "a new filter is visible even when its source is hidden");
  assert.equal(spawned.follow, false);
  assert.ok(spawned.xPct > 0.1 && spawned.yPct > 0.1, "it is offset, not stacked");
  assert.equal(first.active, false, "the source filter keeps its own visibility");
  assertLayerInvariants(layer);
});

test("spawnFilter steps back instead of piling up against the bottom-right corner", () => {
  const layer = S.makeDefaultLayer();
  const first = layer.filters[0];
  S.updateFilter(layer, first.id, { widthPct: 0.25, heightPct: 0.25, xPct: 0.75, yPct: 0.75 });

  const spawned = S.spawnFilter(layer);
  assert.ok(spawned.xPct < 0.75, "it moves away from the edge it cannot pass");
  assert.ok(spawned.yPct < 0.75);
  assert.ok(Math.abs(spawned.xPct - first.xPct) > 1e-9);
  assertLayerInvariants(layer);
});

test("spawnFilter reports failure at the limit and leaves the layer alone", () => {
  const layer = S.makeDefaultLayer();
  while (layer.filters.length < S.MAX_FILTERS) S.spawnFilter(layer);
  const before = snap(layer);
  assert.equal(S.spawnFilter(layer), null);
  assert.deepEqual(snap(layer), before);
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test("a name is capped at MAX_NAME_LEN and an empty one falls back to its position", () => {
  const long = "x".repeat(S.MAX_NAME_LEN + 30);
  const f = snap(S.sanitizeFilter({ name: long }));
  assert.equal(f.name.length, S.MAX_NAME_LEN);

  const blank = snap(S.sanitizeFilter({ name: "   " }));
  assert.equal(S.filterName(blank, 2), "Filter 3");
});

test("renaming one filter does not touch its siblings", () => {
  const layer = S.makeDefaultLayer();
  const second = S.spawnFilter(layer);
  const firstName = layer.filters[0].name;
  S.updateFilter(layer, second.id, { name: "Face" });
  assert.equal(S.filterName(layer.filters[1], 1), "Face");
  assert.equal(layer.filters[0].name, firstName);
});
