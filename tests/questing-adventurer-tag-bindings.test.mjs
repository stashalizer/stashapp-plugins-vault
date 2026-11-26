/**
 * Tests for QuestingAdventurerShared — the tag → trigger/move binding model.
 *
 *   node --test tests/
 *
 * QuestingAdventurerShared.js is a browser IIFE that only touches `window`, so
 * it runs unchanged in a node:vm sandbox. The point of testing it here is that
 * the interesting cases — several tags matching one scene, two tags naming the
 * same combo, a binding whose trigger was deleted, a hand-edited config with
 * numeric ids — cannot be reproduced reliably by clicking around in a live
 * Stash, and every one of them decides whether a scene fires or not.
 *
 * Values that cross the realm boundary are cloned with `snap()` before a strict
 * comparison, because strict deep equality also compares prototypes and the
 * sandbox has its own Object/Array.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..", "plugins", "QuestingAdventurer");
const sharedPath = path.join(pluginDir, "QuestingAdventurerShared.js");

function loadShared() {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(sharedPath, "utf8"), sandbox, { filename: sharedPath });
  return sandbox.window.QuestingAdventurerShared;
}

const S = loadShared();

/** Clone a sandbox value into host-realm plain objects. */
const snap = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// normalizeTagBindings — what survives a load
// ---------------------------------------------------------------------------

test("normalize: missing or non-array config is an empty list, not a crash", () => {
  for (const value of [undefined, null, {}, "", 42, true]) {
    assert.deepEqual(snap(S.normalizeTagBindings(value)), []);
  }
});

test("normalize: drops entries that can never match a scene", () => {
  const out = snap(
    S.normalizeTagBindings([
      null,
      "tag-1",
      { id: "a", triggerId: "t1" },            // no tagId
      { id: "b", tagId: "   ", triggerId: "t1" }, // blank tagId
      { id: "c", tagId: "10", triggerId: "t1" },
    ])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].tagId, "10");
});

test("normalize: keeps an unfinished row (no trigger) so the page can show it", () => {
  const out = snap(S.normalizeTagBindings([{ id: "a", tagId: "7" }]));
  assert.deepEqual(out, [{ id: "a", tagId: "7", triggerId: null, moveId: null }]);
});

test("normalize: accepts numeric ids from a hand-edited or exported config", () => {
  const out = snap(S.normalizeTagBindings([{ id: "a", tagId: 12, triggerId: 34, moveId: 56 }]));
  assert.deepEqual(out, [{ id: "a", tagId: "12", triggerId: "34", moveId: "56" }]);
});

test("normalize: collapses rows that are identical in effect", () => {
  const out = snap(
    S.normalizeTagBindings([
      { id: "a", tagId: "1", triggerId: "t1", moveId: "m1" },
      { id: "b", tagId: "1", triggerId: "t1", moveId: "m1" },
      // Same tag, same trigger, different move: a different statement.
      { id: "c", tagId: "1", triggerId: "t1", moveId: "m2" },
      // Same tag, same move, different trigger: also different.
      { id: "d", tagId: "1", triggerId: "t2", moveId: "m1" },
    ])
  );
  assert.deepEqual(out.map((b) => b.id), ["a", "c", "d"]);
});

test("normalize: ids stay unique even when a config repeats one", () => {
  const out = snap(
    S.normalizeTagBindings([
      { id: "dup", tagId: "1", triggerId: "t1" },
      { id: "dup", tagId: "2", triggerId: "t1" },
      { tagId: "3", triggerId: "t1" }, // no id at all
    ])
  );
  const ids = out.map((b) => b.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], "dup");
  assert.match(ids[1], /^tag-2/);
  assert.match(ids[2], /^tag-3/);
});

test("normalize: caps the table instead of growing without bound", () => {
  const raw = [];
  for (let i = 0; i < S.MAX_TAG_BINDINGS + 25; i += 1) {
    raw.push({ id: "b" + i, tagId: String(i), triggerId: "t" + i });
  }
  assert.equal(snap(S.normalizeTagBindings(raw)).length, S.MAX_TAG_BINDINGS);
});

test("normalize: does not mutate its input", () => {
  const input = [{ id: "a", tagId: 1, triggerId: 2 }];
  const before = JSON.stringify(input);
  S.normalizeTagBindings(input);
  assert.equal(JSON.stringify(input), before);
});

// ---------------------------------------------------------------------------
// resolveTagBindings — what fires for one scene
// ---------------------------------------------------------------------------

const binding = (id, tagId, triggerId, moveId = null) => ({
  id,
  tagId,
  triggerId,
  moveId,
});

test("resolve: no bindings, or a scene without tags, fires nothing", () => {
  assert.deepEqual(snap(S.resolveTagBindings([], ["1"])), []);
  assert.deepEqual(snap(S.resolveTagBindings([binding("a", "1", "t1")], [])), []);
  assert.deepEqual(snap(S.resolveTagBindings([binding("a", "1", "t1")], undefined)), []);
});

test("resolve: a scene whose tags match no binding fires nothing", () => {
  const out = S.resolveTagBindings([binding("a", "1", "t1")], ["2", "3"]);
  assert.deepEqual(snap(out), []);
});

test("resolve: matches string ids to numeric scene tags", () => {
  const out = snap(S.resolveTagBindings([binding("a", "42", "t1", "m1")], [42]));
  assert.deepEqual(out, [{ bindingId: "a", tagId: "42", triggerId: "t1", moveId: "m1" }]);
});

test("resolve: several bound tags fire several bindings, in config order", () => {
  const out = snap(
    S.resolveTagBindings(
      [binding("a", "1", "t1", "m1"), binding("b", "2", "t2", "m2"), binding("c", "3", "t3")],
      ["3", "1", "2"]
    )
  );
  assert.deepEqual(out.map((f) => f.bindingId), ["a", "b", "c"]);
});

test("resolve: two tags naming the same trigger+move fire once", () => {
  const out = snap(
    S.resolveTagBindings(
      [binding("a", "1", "t1", "m1"), binding("b", "2", "t1", "m1")],
      ["1", "2"]
    )
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].bindingId, "a");
});

test("resolve: two tags naming the same trigger with different moves keep both", () => {
  const out = snap(
    S.resolveTagBindings(
      [binding("a", "1", "t1", "m1"), binding("b", "2", "t1", "m2")],
      ["1", "2"]
    )
  );
  assert.deepEqual(out.map((f) => f.moveId), ["m1", "m2"]);
});

test("resolve: an unbound row never fires", () => {
  const out = S.resolveTagBindings([binding("a", "1", null)], ["1"]);
  assert.deepEqual(snap(out), []);
});

test("resolve: tolerates unsanitized entries instead of throwing", () => {
  const out = snap(
    S.resolveTagBindings([null, "x", { tagId: "1", triggerId: 9 }], ["1"])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].triggerId, "9");
});

test("resolve: duplicate scene tags are not double-counted", () => {
  const out = S.resolveTagBindings([binding("a", "1", "t1")], ["1", "1", 1]);
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------------------
// describeBindingProblems — the same definition the settings page renders
// ---------------------------------------------------------------------------

test("problems: a complete binding has none", () => {
  const out = S.describeBindingProblems(binding("a", "1", "t1", "m1"), () => true, () => true);
  assert.deepEqual(snap(out), []);
});

test("problems: a missing trigger blocks, a missing move does not", () => {
  const noTrigger = snap(S.describeBindingProblems(binding("a", "1", null), () => true, () => true));
  assert.deepEqual(noTrigger.map((p) => p.code), ["no-trigger"]);
  assert.equal(noTrigger[0].blocking, true);

  const deletedTrigger = snap(
    S.describeBindingProblems(binding("a", "1", "gone"), () => false, () => true)
  );
  assert.equal(deletedTrigger[0].code, "missing-trigger");
  assert.equal(deletedTrigger[0].blocking, true);

  const deletedMove = snap(
    S.describeBindingProblems(binding("a", "1", "t1", "gone"), () => true, () => false)
  );
  assert.deepEqual(deletedMove.map((p) => p.code), ["missing-move"]);
  assert.equal(deletedMove[0].blocking, false);
});

// ---------------------------------------------------------------------------
// Both surfaces must preserve the key they do not own
// ---------------------------------------------------------------------------

const readSource = (name) => readFileSync(path.join(pluginDir, name), "utf8");

test("overlay: every config save carries tagBindings, so it cannot wipe them", () => {
  const source = readSource("QuestingAdventurer.js");
  const writes = source.match(/tagBindings:\s*state\.tagBindings/g) || [];
  // One in the JSON payload, one in the Suite Data merge callback.
  assert.equal(writes.length, 2, "queueSave must write tagBindings in both objects");
  assert.match(source, /state\.tagBindings\s*=\s*shared\.normalizeTagBindings/);
  // A call statement, not the `function applyTagBindings() {` declaration.
  assert.match(source, /applyTagBindings\(\);\s*$/m, "setupPanel must evaluate bindings");
});

test("settings: every config save writes the normalized binding table", () => {
  const source = readSource("QuestingAdventurerSettings.js");
  const writes = source.match(/tagBindings:\s*shared\.normalizeTagBindings\(bindingsToSave\)/g) || [];
  assert.equal(writes.length, 2, "saveTriggersNow must write tagBindings in both objects");
});

test("both surfaces load the shared module it depends on", () => {
  const yml = readSource("QuestingAdventurer.yml");
  const sharedAt = yml.indexOf("QuestingAdventurerShared.js");
  assert.ok(sharedAt > -1, "manifest lists the shared module");
  assert.ok(
    sharedAt < yml.indexOf("QuestingAdventurer.js"),
    "shared module must load before the overlay"
  );
  assert.ok(
    sharedAt < yml.indexOf("QuestingAdventurerSettings.js"),
    "shared module must load before the settings page"
  );
});
