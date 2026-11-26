/**
 * QuestingAdventurerShared — pure data helpers for tag → trigger/move bindings.
 *
 * A tag binding is one row: `{ id, tagId, triggerId, moveId }`. It means
 * "when a scene carries this tag, activate this trigger and attach this move".
 * Bindings live in one top-level `tagBindings` array in the plugin config
 * (not on a trigger, unlike `autoRules`) because the settings page edits them
 * as a table keyed by tag, and because a tag may point at a trigger the overlay
 * has to resolve before it can look anything up.
 *
 * Everything here is pure: no DOM, no fetch, no csLib. The overlay and the
 * settings page load this file first and both call the same two functions, so
 * the rules for "what counts as a valid binding" and "which bindings fire for
 * this scene" cannot drift between the two surfaces. It also means the edge
 * cases below are exercised by `tests/questing-adventurer-tag-bindings.test.mjs`
 * instead of by clicking around in a live Stash.
 *
 * Normalization decisions (all deliberate):
 * - A row without a `tagId` is dropped: it can never match a scene, so keeping
 *   it would only be a row the user cannot see a reason for.
 * - A row without a `triggerId` is KEPT. It is an unfinished row the settings
 *   page shows with a warning, and `resolveTagBindings` skips it at runtime.
 * - Rows that are identical in effect (same tag, same trigger, same move) are
 *   collapsed to the first one. Firing the same trigger with the same move
 *   twice does nothing, and hand-edited or duplicated config should not be
 *   able to create a second run in the quest log.
 * - Ids are coerced to trimmed strings because Stash ids arrive as strings
 *   from GraphQL but as numbers from a hand-written config or an old export.
 */
(function () {
  "use strict";

  // A tag binding list is a lookup table, not a feed: 500 rows would mean 500
  // tag lookups on every scene open. Truncation is silent by design — the
  // settings page never gets near this, and a hand-edited config that does is
  // beyond what the plugin promises.
  var MAX_TAG_BINDINGS = 200;

  function asId(value) {
    if (typeof value === "number" && isFinite(value)) return String(value);
    if (typeof value !== "string") return "";
    return value.trim();
  }

  function makeBindingId(tagId, taken) {
    var base = "tag-" + tagId;
    var id = base;
    var suffix = 2;
    while (taken[id]) {
      id = base + "-" + suffix;
      suffix += 1;
    }
    return id;
  }

  /**
   * Sanitize a stored `tagBindings` value into the shape the plugin uses.
   * Always returns a fresh array; never throws and never mutates its input.
   */
  function normalizeTagBindings(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    var takenIds = {};
    var seenEffects = {};
    for (var i = 0; i < value.length && out.length < MAX_TAG_BINDINGS; i += 1) {
      var raw = value[i];
      if (!raw || typeof raw !== "object") continue;
      var tagId = asId(raw.tagId);
      if (!tagId) continue;
      var triggerId = asId(raw.triggerId) || null;
      var moveId = asId(raw.moveId) || null;
      var effect = tagId + "\u0000" + (triggerId || "") + "\u0000" + (moveId || "");
      if (seenEffects[effect]) continue;
      seenEffects[effect] = true;
      var id = asId(raw.id);
      if (!id || takenIds[id]) id = makeBindingId(tagId, takenIds);
      takenIds[id] = true;
      out.push({ id: id, tagId: tagId, triggerId: triggerId, moveId: moveId });
    }
    return out;
  }

  /**
   * Which bindings fire for a scene carrying `sceneTagIds`?
   *
   * Returns ordered `{ bindingId, tagId, triggerId, moveId }` entries, in
   * config order so a repeated scene open always fires in the same sequence.
   * Deduplicated by (triggerId, moveId): two tags may name the same trigger,
   * and that must activate it once rather than start two runs. Two tags naming
   * the same trigger with *different* moves are kept — each tag contributes
   * its own move, which is the only reading that does not silently drop half
   * of what the user configured.
   *
   * Unbound rows (no triggerId) are skipped, so an unfinished row is inert
   * instead of activating an arbitrary trigger.
   */
  function resolveTagBindings(bindings, sceneTagIds) {
    if (!Array.isArray(bindings) || bindings.length === 0) return [];
    var sceneTags = {};
    var tagCount = 0;
    if (Array.isArray(sceneTagIds)) {
      for (var i = 0; i < sceneTagIds.length; i += 1) {
        var tagId = asId(sceneTagIds[i]);
        if (tagId && !sceneTags[tagId]) {
          sceneTags[tagId] = true;
          tagCount += 1;
        }
      }
    }
    if (tagCount === 0) return [];
    var out = [];
    var seen = {};
    for (var j = 0; j < bindings.length; j += 1) {
      var binding = bindings[j];
      if (!binding || typeof binding !== "object") continue;
      var tag = asId(binding.tagId);
      if (!tag || !sceneTags[tag]) continue;
      var triggerId = asId(binding.triggerId);
      if (!triggerId) continue;
      var moveId = asId(binding.moveId) || null;
      var key = triggerId + "\u0000" + (moveId || "");
      if (seen[key]) continue;
      seen[key] = true;
      out.push({
        bindingId: asId(binding.id),
        tagId: tag,
        triggerId: triggerId,
        moveId: moveId,
      });
    }
    return out;
  }

  /**
   * Problems with one binding, for the settings page.
   *
   * Returns `[{ code, message, blocking }]`. `blocking: true` means the row
   * cannot fire at all (no trigger, or a trigger that no longer exists);
   * `blocking: false` means it still fires but loses something (a deleted move
   * is skipped — the trigger is still activated, same as an auto rule whose
   * move was deleted). The overlay only needs the blocking side, the page
   * renders the messages, and both read the same definition.
   */
  function describeBindingProblems(binding, hasTrigger, hasMove) {
    if (!binding) {
      return [{ code: "missing", message: "Missing binding", blocking: true }];
    }
    var problems = [];
    if (!asId(binding.tagId)) {
      problems.push({ code: "no-tag", message: "No tag selected", blocking: true });
    }
    var triggerId = asId(binding.triggerId);
    if (!triggerId) {
      problems.push({ code: "no-trigger", message: "No trigger selected", blocking: true });
    } else if (typeof hasTrigger === "function" && !hasTrigger(triggerId)) {
      problems.push({ code: "missing-trigger", message: "Trigger no longer exists", blocking: true });
    }
    var moveId = asId(binding.moveId);
    if (moveId && typeof hasMove === "function" && !hasMove(moveId)) {
      problems.push({ code: "missing-move", message: "Move no longer exists", blocking: false });
    }
    return problems;
  }

  window.QuestingAdventurerShared = {
    MAX_TAG_BINDINGS: MAX_TAG_BINDINGS,
    normalizeTagBindings: normalizeTagBindings,
    resolveTagBindings: resolveTagBindings,
    describeBindingProblems: describeBindingProblems,
  };
})();
