/**
 * SceneVersions — Related Scenes tab for the Stash scene page.
 *
 * Architecture:
 * - Adds a "Related Scenes" tab to the scene page via PluginApi.patch.before
 *   on "ScenePage.Tabs" and "ScenePage.TabContent".
 * - Stores bidirectional links in scene custom_fields under the key
 *   "RelatedScenes" (a JSON-serialised array of scene ID strings). Stash's
 *   custom_fields store only supports scalar values, so the id list is
 *   JSON.stringify'd before writing and JSON.parse'd on read.
 * - ALWAYS uses custom_fields.partial for writes to avoid clobbering other
 *   custom fields.
 * - Self-links are prevented: the scene picker excludes the current scene,
 *   and syncBidirectional filters it out before computing diffs.
 * - No csLib dependency — pure PluginApi (React + Apollo).
 * - Patch surface constraint: SceneDetailPanel/SceneEditPanel are NOT
 *   patchable, so we inject a dedicated tab instead.
 */
(function () {
  "use strict";

  if (!window.PluginApi) {
    console.error("SceneVersions: PluginApi not available");
    return;
  }

  var PluginApi = window.PluginApi;
  var React = PluginApi.React;
  var GQL = PluginApi.GQL;
  var libraries = PluginApi.libraries;
  var components = PluginApi.components;
  var hooks = PluginApi.hooks;
  var gql = libraries.Apollo && libraries.Apollo.gql;
  // The Apollo Client instance is NOT libraries.Apollo (that's the
  // @apollo/client namespace: gql, useQuery, etc.). The live client is
  // exposed via StashService.getClient(). Use it for query/mutate calls.
  var apolloClient = PluginApi.utils.StashService.getClient();
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useCallback = React.useCallback;
  var useMemo = React.useMemo;
  var Tab = libraries.Bootstrap.Tab;
  var Nav = libraries.Bootstrap.Nav;
  var Button = libraries.Bootstrap.Button;
  var Badge = libraries.Bootstrap.Badge;
  var Alert = libraries.Bootstrap.Alert;
  var Spinner = libraries.Bootstrap.Spinner;
  var Link = libraries.ReactRouterDOM.Link;

  var RELATED_KEY = "RelatedScenes";
  var TAB_KEY = "scene-versions-panel";

  // ── Data layer ──────────────────────────────────────────────────────
  //
  // Stash's custom_fields store only supports scalar values (string, int,
  // float, bool). Arrays and objects are rejected by the backend with
  // "unsupported custom field value type: []interface {}" (see
  // pkg/sqlite/custom_fields.go:getSQLValueFromCustomFieldInput). We
  // therefore serialise the RelatedScenes id list to a JSON string before
  // writing, and parse it back on read. This keeps the bidirectional-link
  // logic working while staying within the scalar-only constraint.

  function encodeIds(ids) {
    return JSON.stringify(ids);
  }

  function decodeIds(raw) {
    // Current format: a JSON string.
    if (typeof raw === "string") {
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch (e) {
        // fall through to legacy handling
      }
    }
    // Legacy format: a bare array (only possible if written by an older
    // plugin version before the backend rejected arrays — in practice
    // never persisted, but tolerate it if present in cache).
    if (Array.isArray(raw)) return raw.map(String);
    return [];
  }

  async function readRelatedIds(sceneId) {
    var data = await apolloClient.query({
      query: GQL.FindSceneDocument,
      variables: { id: sceneId },
      fetchPolicy: "no-cache",
    });
    var raw = data.data.findScene?.custom_fields?.[RELATED_KEY];
    return decodeIds(raw);
  }

  async function loadScenesByIds(ids) {
    if (!ids || ids.length === 0) return [];
    var results = await Promise.all(
      ids.map(function (id) {
        return apolloClient
          .query({
            query: GQL.FindSceneDocument,
            variables: { id: id },
            fetchPolicy: "no-cache",
          })
          .then(function (res) {
            return res.data.findScene;
          })
          .catch(function () {
            return null;
          });
      })
    );
    return results.filter(Boolean);
  }

  async function writeRelatedIds(sceneId, ids) {
    await apolloClient.mutate({
      mutation: GQL.SceneUpdateDocument,
      variables: {
        input: {
          id: sceneId,
          custom_fields: {
            partial: {
              [RELATED_KEY]: encodeIds(ids),
            },
          },
        },
      },
    });
  }

  // ── Cleanup protection ──────────────────────────────────────────────
  // There is no ecosystem-wide ignore tag. These are the documented defaults
  // for the two cleaners with the clearest tag contracts. The labels are
  // intentionally exact, including the upstream "Addtional" spelling.
  var PROTECTION_TAG_NAMES = [
    "Ignore:Smart Resolve",
    "Addtional Files Deleter: Scenes/Images: Ignore",
  ];
  var protectionTagIdsPromise = null;

  async function findOrCreateTag(name) {
    var found = await apolloClient.query({
      query: gql`
        query SceneVersionsFindTag($name: String!) {
          findTags(
            tag_filter: { name: { value: $name, modifier: EQUALS } }
            filter: { per_page: 1 }
          ) {
            tags { id name }
          }
        }
      `,
      variables: { name: name },
      fetchPolicy: "no-cache",
    });
    var existing = found && found.data && found.data.findTags && found.data.findTags.tags;
    if (existing && existing.length > 0) return existing[0].id;
    var created = await apolloClient.mutate({
      mutation: gql`
        mutation SceneVersionsCreateTag($name: String!) {
          tagCreate(input: { name: $name }) { id name }
        }
      `,
      variables: { name: name },
    });
    return created.data.tagCreate.id;
  }

  async function getProtectionTagIds() {
    if (!protectionTagIdsPromise) {
      protectionTagIdsPromise = Promise.all(PROTECTION_TAG_NAMES.map(findOrCreateTag));
    }
    try {
      return await protectionTagIdsPromise;
    } catch (err) {
      console.warn("SceneVersions: protection tag setup failed", err);
      protectionTagIdsPromise = null;
      return [];
    }
  }

  async function applyProtectionTags(sceneId) {
    try {
      var tagIds = await getProtectionTagIds();
      if (tagIds.length === 0) return;
      var result = await apolloClient.query({
        query: gql`
          query SceneVersionsSceneTags($id: ID!) {
            findScene(id: $id) { id tags { id } }
          }
        `,
        variables: { id: String(sceneId) },
        fetchPolicy: "no-cache",
      });
      var scene = result && result.data && result.data.findScene;
      if (!scene) return;
      var existing = (scene.tags || []).map(function (t) { return String(t.id); });
      var merged = existing.slice();
      for (var i = 0; i < tagIds.length; i++) {
        var id = String(tagIds[i]);
        if (merged.indexOf(id) === -1) merged.push(id);
      }
      if (merged.length === existing.length) return;
      await apolloClient.mutate({
        mutation: GQL.SceneUpdateDocument,
        variables: { input: { id: String(sceneId), tag_ids: merged } },
      });
    } catch (err) {
      console.warn("SceneVersions: could not apply protection tags to " + sceneId, err);
    }
  }

  async function syncBidirectional(currentSceneId, newIds, originalIds) {
    // Filter out self-link from both sets
    var filteredNew = excludeSelf(newIds, currentSceneId);
    var filteredOrig = excludeSelf(originalIds, currentSceneId);

    var newSet = new Set(filteredNew);
    var origSet = new Set(filteredOrig);

    var added = filteredNew.filter(function (id) {
      return !origSet.has(id);
    });
    var removed = filteredOrig.filter(function (id) {
      return !newSet.has(id);
    });

    // Best-effort peer writes — one failure must not block the others
    // or the current scene's write.
    var peerTasks = [];
    for (var i = 0; i < added.length; i++) {
      peerTasks.push(addBackLink(added[i], currentSceneId));
    }
    for (var j = 0; j < removed.length; j++) {
      peerTasks.push(removeBackLink(removed[j], currentSceneId));
    }
    await Promise.allSettled(peerTasks);

    // Always write the current scene last, regardless of peer failures.
    await writeRelatedIds(currentSceneId, filteredNew);

    if (filteredNew.length > 0) {
      var protectTasks = [applyProtectionTags(currentSceneId)];
      for (var k = 0; k < added.length; k++) {
        protectTasks.push(applyProtectionTags(added[k]));
      }
      await Promise.allSettled(protectTasks);
    }

    return;
  }

  async function addBackLink(peerId, currentSceneId) {
    try {
      var existing = await readRelatedIds(peerId);
      if (existing.indexOf(currentSceneId) === -1) {
        existing.push(currentSceneId);
        await writeRelatedIds(peerId, existing);
      }
    } catch (err) {
      console.error("SceneVersions: failed to add back-link to " + peerId, err);
    }
  }

  async function removeBackLink(peerId, currentSceneId) {
    try {
      var existing = await readRelatedIds(peerId);
      var filtered = existing.filter(function (eid) {
        return eid !== currentSceneId;
      });
      if (filtered.length !== existing.length) {
        await writeRelatedIds(peerId, filtered);
      }
    } catch (err) {
      console.error("SceneVersions: failed to remove back-link from " + peerId, err);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function excludeSelf(ids, sceneId) {
    return ids.filter(function (id) {
      return id !== sceneId;
    });
  }

  /**
   * Load related scene IDs and full scene objects for a given scene.
   * Calls the provided handlers at each stage so callers can wire in
   * their own state setters, cancellation checks, and side effects.
   */
  function loadRelatedScenes(sceneId, handlers) {
    return readRelatedIds(sceneId)
      .then(function (ids) {
        var filtered = excludeSelf(ids, sceneId);
        if (handlers.onIds) handlers.onIds(filtered);
        return loadScenesByIds(filtered);
      })
      .then(function (scenes) {
        if (handlers.onScenes) handlers.onScenes(scenes || []);
      })
      .catch(function (err) {
        if (handlers.onError) handlers.onError(err);
      });
  }

  function shallowEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function sceneTitle(scene) {
    if (scene.title) return scene.title;
    if (scene.files && scene.files.length > 0) {
      var path = scene.files[0].path;
      var parts = path.replace(/\\/g, "/").split("/");
      return parts[parts.length - 1];
    }
    return "Untitled";
  }

  /**
   * Derive the folder path of the current scene's first file.
   *
   * The path is kept in its ORIGINAL separator form (no `\` -> `/`
   * normalisation) because the Stash backend builds the LIKE pattern
   * from `folders.path || <filepath.Separator> || files.basename` and
   * matches it against the raw value we send. On Windows the DB stores
   * backslashes, so normalising to `/ here would make the INCLUDES
   * criterion match nothing (the pre-0.3.0 suggestions list had this
   * exact bug — it was always empty on Windows). We only split on BOTH
   * separators to find the basename, then rejoin the folder parts
   * with the same separator the original path used.
   */
  function getFolderPath(scene) {
    if (!scene.files || scene.files.length === 0) return null;
    var path = scene.files[0].path;
    // Detect the dominant separator in the original path.
    var sep = path.indexOf("\\") !== -1 ? "\\" : "/";
    // Split on either separator so mixed paths still work, then
    // rejoin with the original separator.
    var parts = path.split(/[\\/]/);
    parts.pop(); // drop the filename
    return parts.join(sep) + sep;
  }

  /**
   * Build a duck-typed path criterion for SceneIDSelect's `extraCriteria`.
   *
   * SceneSelect spreads `extraCriteria` into `filter.criteria` and then
   * calls `makeFilter()`, which invokes each criterion's
   * `applyToCriterionInput(output)` to write `{ path: { value, modifier } }`
   * into the scene_filter. We only need that one method, so a minimal
   * duck-typed object is enough — no need to import the real
   * PathCriterion class (which isn't exposed on PluginApi anyway).
   *
   * Restricting the picker to the current scene's folder makes the
   * common "same performer/studio lives in one folder" workflow
   * discoverable without paging through every scene in the library.
   * Cross-folder links can still be added via the suggestions list or
   * by removing this criterion in a future toggle.
   */
  function makeFolderCriterion(folderPath) {
    return {
      criterionOption: { type: "path" },
      modifier: "INCLUDES",
      value: folderPath,
      applyToCriterionInput: function (output) {
        output.path = { value: folderPath, modifier: "INCLUDES" };
      },
    };
  }

  // ── Folder suggestions: bounded pages + filename ranking ────────────
  //
  // The folder criterion is a loose `INCLUDES` substring match (see
  // AGENTS.md), so a library where many scenes share one directory can
  // return hundreds of hits — and the old implementation rendered every
  // single one of them. Three changes keep the list small and relevant:
  //
  // 1. A dedicated slim document instead of `GQL.FindScenesDocument`.
  //    The generated document pulls a full scene (files with
  //    fingerprints, performers, tags, …), so fetching 200 of them cost
  //    far more than the handful of fields this list renders. The slim
  //    selection does include the file's media fields, because a
  //    suggestion added without saving is rendered by the comparison
  //    table too — it must not show dashes there. The document also
  //    returns `count`, which is what tells us whether another page
  //    exists.
  // 2. Client-side ranking by filename similarity to the current scene.
  //    The backend can only sort by path/date/etc. — it cannot sort by
  //    "looks like this filename" — and `INCLUDES` ORs the
  //    whitespace-separated terms of its value, so a name prefix cannot
  //    be used as a prefilter either. Ranking therefore runs over the
  //    loaded pool.
  // 3. The list renders a few rows at a time. "Show more" first reveals
  //    the rest of the loaded pool, and only fetches the next backend
  //    page once that pool is exhausted.

  var SUGGESTION_PAGE_SIZE = 200;
  var SUGGESTION_INITIAL_VISIBLE = 6;
  var SUGGESTION_VISIBLE_STEP = 6;
  // Same-directory hits outrank `INCLUDES` false positives from
  // subfolders whose path merely contains this folder string.
  var SUGGESTION_SAME_DIR_BONUS = 0.05;
  // Name-similar files sit next to each other in path order, so the
  // useful candidates are around the current scene's own position. If it
  // is not in the first page, scan a few more (serially, stopping as soon
  // as it shows up) before ranking — otherwise a folder whose scenes are
  // all in one directory would rank against an unrelated slice of itself.
  var SUGGESTION_MAX_SCAN_PAGES = 3;

  var FolderScenesDocument = gql`
    query SceneVersionsFolderScenes($folderPath: String!, $page: Int!, $perPage: Int!) {
      findScenes(
        scene_filter: { path: { value: $folderPath, modifier: INCLUDES } }
        filter: { page: $page, per_page: $perPage, sort: "path" }
      ) {
        count
        scenes {
          id
          title
          date
          paths {
            screenshot
          }
          studio {
            name
          }
          files {
            path
            duration
            width
            height
            video_codec
            bit_rate
          }
        }
      }
    }
  `;

  /** Basename of the scene's first file (no directory part). */
  function sceneFileName(scene) {
    var file = scene && scene.files && scene.files[0];
    if (!file || !file.path) return "";
    var parts = String(file.path).split(/[\\/]/);
    return parts[parts.length - 1] || "";
  }

  /**
   * Lowercase, drop the extension, collapse every run of separators and
   * punctuation to a single space. Kept Unicode-aware so CJK filenames
   * are not erased into an empty string (which would score everything
   * 0 and silently disable the ranking).
   */
  function normalizeFileName(name) {
    if (!name) return "";
    var stem = String(name).replace(/\.[^./\\]+$/, "");
    try {
      return stem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    } catch (e) {
      return stem.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
  }

  function bigramSet(normalized) {
    var grams = new Set();
    for (var i = 0; i < normalized.length - 1; i++) {
      grams.add(normalized.substr(i, 2));
    }
    return grams;
  }

  /**
   * Filename similarity in [0, 1].
   *
   * Versions of one scene usually share a stem and differ in a suffix
   * ("… (1080p)" vs "… (4K)"), and their tokens mostly overlap, so the
   * score mixes token overlap (weight 0.5), shared prefix (0.35 — the
   * strongest signal for "same title, different cut") and character
   * bigrams (0.15, which still rewards partial word matches).
   */
  function similarityScore(target, candidate) {
    if (!target || !candidate) return 0;
    if (target === candidate) return 1;

    var targetTokens = target.split(" ").filter(Boolean);
    var candidateTokens = candidate.split(" ").filter(Boolean);
    var candidateSet = new Set(candidateTokens);
    var sharedTokens = 0;
    targetTokens.forEach(function (t) {
      if (candidateSet.has(t)) sharedTokens++;
    });
    var tokenTotal = targetTokens.length + candidateTokens.length;
    var tokenScore = tokenTotal > 0 ? (2 * sharedTokens) / tokenTotal : 0;

    var shortest = Math.min(target.length, candidate.length);
    var prefixLength = 0;
    while (
      prefixLength < shortest &&
      target.charAt(prefixLength) === candidate.charAt(prefixLength)
    ) {
      prefixLength++;
    }
    var prefixScore =
      prefixLength / Math.max(target.length, candidate.length);

    var targetGrams = bigramSet(target);
    var candidateGrams = bigramSet(candidate);
    var sharedGrams = 0;
    targetGrams.forEach(function (g) {
      if (candidateGrams.has(g)) sharedGrams++;
    });
    var gramTotal = targetGrams.size + candidateGrams.size;
    var gramScore = gramTotal > 0 ? (2 * sharedGrams) / gramTotal : 0;

    return 0.5 * tokenScore + 0.35 * prefixScore + 0.15 * gramScore;
  }

  /**
   * Fetch one page of the folder's scenes, sorted by path.
   *
   * `hasMore` comes from the server-side `count` when it is present and
   * falls back to "the page came back full" otherwise. A failed page is
   * reported as `{ failed: true, scenes: [] }` rather than thrown: the
   * suggestion list is a convenience, and losing it must never break
   * the tab.
   */
  async function fetchSuggestionPage(folderPath, page) {
    if (!folderPath) return { scenes: [], hasMore: false, total: 0 };
    try {
      var result = await apolloClient.query({
        query: FolderScenesDocument,
        variables: {
          folderPath: folderPath,
          page: page,
          perPage: SUGGESTION_PAGE_SIZE,
        },
        fetchPolicy: "no-cache",
      });
      var payload = result && result.data && result.data.findScenes;
      var scenes = (payload && payload.scenes) || [];
      var total = payload && typeof payload.count === "number" ? payload.count : null;
      return {
        scenes: scenes,
        total: total || 0,
        hasMore:
          total !== null
            ? page * SUGGESTION_PAGE_SIZE < total
            : scenes.length === SUGGESTION_PAGE_SIZE,
      };
    } catch (err) {
      console.error("SceneVersions: folder suggestion query failed", err);
      return { scenes: [], hasMore: false, total: 0, failed: true };
    }
  }

  /** Append a page to the pool, dropping ids already present. */
  function mergeScenePool(existing, incoming) {
    var seen = new Set(
      existing.map(function (s) {
        return String(s.id);
      })
    );
    var merged = existing.slice();
    (incoming || []).forEach(function (s) {
      var id = String(s.id);
      if (seen.has(id)) return;
      seen.add(id);
      merged.push(s);
    });
    return merged;
  }

  function getPrimaryHash(scene) {
    if (!scene || !Array.isArray(scene.files) || scene.files.length === 0) return null;
    var files = scene.files;
    var primary = scene.primary_file_id
      ? files.find(function (f) { return String(f.id) === String(scene.primary_file_id); })
      : files[0];
    var fps = primary && primary.fingerprints;
    if (!Array.isArray(fps)) return null;
    var phash = fps.find(function (f) { return f.type === "phash" && f.value; });
    return phash ? phash.value : null;
  }

  async function fetchPhashSuggestions(scene, excludeIds) {
    var hash = getPrimaryHash(scene);
    if (!hash) {
      try {
        var current = await apolloClient.query({
          query: gql`
            query SceneVersionsCurrentHash($id: ID!) {
              findScene(id: $id) {
                id
                files { id fingerprints { type value } }
              }
            }
          `,
          variables: { id: String(scene.id) },
          fetchPolicy: "no-cache",
        });
        var currentScene = current && current.data && current.data.findScene;
        hash = getPrimaryHash(currentScene);
      } catch (err) {
        console.warn("SceneVersions: current pHash lookup failed", err);
      }
    }
    if (!hash) return { needsHash: true, scenes: [] };
    var excludeSet = new Set(excludeIds.map(String));
    try {
      var result = await apolloClient.query({
        query: gql`
          query SceneVersionsPhash($hash: String!) {
            findScenes(
              scene_filter: { phash_distance: { value: $hash, modifier: EQUALS, distance: 8 } }
              filter: { per_page: 20, sort: "path" }
            ) {
              scenes {
                id title date
                files { id path duration width height video_codec bit_rate }
                paths { screenshot }
              }
            }
          }
        `,
        variables: { hash: hash },
        fetchPolicy: "no-cache",
      });
      var scenes = (result && result.data && result.data.findScenes && result.data.findScenes.scenes) || [];
      return {
        needsHash: false,
        scenes: scenes.filter(function (s) { return !excludeSet.has(String(s.id)); }),
      };
    } catch (err) {
      console.warn("SceneVersions: pHash suggestions failed", err);
      return { needsHash: false, scenes: [] };
    }
  }

  function sceneFileSummary(scene) {
    var file = scene && scene.files && scene.files[0];
    if (!file) return { duration: "\u2014", resolution: "\u2014", codec: "\u2014", bitrate: "\u2014" };
    return {
      duration: typeof file.duration === "number" ? Math.round(file.duration) + "s" : "\u2014",
      resolution: file.width && file.height ? file.width + "\u00d7" + file.height : "\u2014",
      codec: file.video_codec || "\u2014",
      bitrate: file.bit_rate ? Math.round(file.bit_rate / 1000) + " kbps" : "\u2014",
    };
  }

  // ── Count sync (tab label <-> tab content) ──────────────────────────
  //
  // The tab label (rendered in the ScenePage.Tabs patch) and the tab
  // content (RelatedScenesTab, rendered in ScenePage.TabContent) are two
  // separate component instances. To keep the count badge in the tab
  // label live while the user edits/saves inside the tab, we use a tiny
  // module-level pub/sub keyed by scene id. RelatedScenesTab emits the
  // current related-ids length whenever it changes; the label subscribes
  // and re-renders. The label also does its own read on mount so it shows
  // the count before the user ever opens the tab.

  var countListeners = {};

  function onCountChange(sceneId, fn) {
    var key = String(sceneId);
    if (!countListeners[key]) countListeners[key] = new Set();
    countListeners[key].add(fn);
    return function () {
      var set = countListeners[key];
      if (set) set.delete(fn);
    };
  }

  function emitCountChange(sceneId, count) {
    var set = countListeners[String(sceneId)];
    if (set) set.forEach(function (fn) { fn(count); });
  }

  // ── Card badge (batched) ────────────────────────────────────────────
  // SceneCard does not receive custom_fields by default, so the badge asks
  // for the current page's ids in one query instead of issuing one query per
  // card.

  var badgeCache = {};
  var badgePending = {};
  var badgeSubscribers = {};
  var badgeTimer = null;

  function notifyBadge(sceneId) {
    var subs = badgeSubscribers[sceneId];
    if (!subs) return;
    subs.forEach(function (fn) { fn(badgeCache[sceneId] || 0); });
  }

  function flushBadgeBatch() {
    badgeTimer = null;
    var ids = Object.keys(badgePending);
    if (ids.length === 0) return;
    ids.forEach(function (id) { delete badgePending[id]; });
    apolloClient.query({
      query: gql`
        query SceneVersionsBadgeBatch($ids: [ID!]!) {
          findScenes(ids: $ids) {
            scenes { id custom_fields }
          }
        }
      `,
      variables: { ids: ids },
      fetchPolicy: "no-cache",
    }).then(function (result) {
      var scenes = (result && result.data && result.data.findScenes && result.data.findScenes.scenes) || [];
      var seen = {};
      scenes.forEach(function (s) {
        var count = decodeIds(s.custom_fields && s.custom_fields[RELATED_KEY]).length;
        badgeCache[String(s.id)] = count;
        seen[String(s.id)] = true;
        notifyBadge(String(s.id));
      });
      ids.forEach(function (id) {
        if (!seen[id]) {
          badgeCache[id] = 0;
          notifyBadge(id);
        }
      });
    }).catch(function (err) {
      console.warn("SceneVersions: badge batch failed", err);
      ids.forEach(function (id) {
        badgeCache[id] = 0;
        notifyBadge(id);
      });
    });
  }

  function requestBadge(sceneId) {
    var id = String(sceneId);
    if (badgeCache[id] !== undefined) return;
    badgePending[id] = true;
    if (!badgeTimer) badgeTimer = setTimeout(flushBadgeBatch, 30);
  }

  function VersionBadge(props) {
    var sceneId = String(props.sceneId);
    var initial = badgeCache[sceneId];
    var pair = React.useState(initial === undefined ? 0 : initial);
    var count = pair[0];
    var setCount = pair[1];
    React.useEffect(function () {
      var id = String(props.sceneId);
      function onCount(n) { setCount(n); }
      if (!badgeSubscribers[id]) badgeSubscribers[id] = new Set();
      badgeSubscribers[id].add(onCount);
      requestBadge(id);
      return function () {
        var subs = badgeSubscribers[id];
        if (subs) subs.delete(onCount);
      };
    }, [props.sceneId]);
    if (!count) return null;
    return h(Badge, {
      pill: true,
      bg: "info",
      text: "dark",
      className: "scene-versions-card-badge",
      title: count + " related version" + (count === 1 ? "" : "s"),
    }, "Versions " + count);
  }

  async function ensureVersionFilter() {
    var existing = await apolloClient.query({
      query: gql`query { findSavedFilters(mode: SCENES) { id name } }`,
      fetchPolicy: "no-cache",
    });
    var filters = (existing && existing.data && existing.data.findSavedFilters) || [];
    var name = "Scene Versions: has alternate cut";
    if (filters.some(function (f) { return f.name === name; })) return false;
    await apolloClient.mutate({
      mutation: gql`
        mutation SceneVersionsSaveFilter($input: SaveFilterInput!) {
          saveFilter(input: $input) { id name }
        }
      `,
      variables: {
        input: {
          mode: "SCENES",
          name: name,
          object_filter: {
            custom_fields: [
              { field: RELATED_KEY, value: [], modifier: "NOT_NULL" },
            ],
          },
        },
      },
    });
    return true;
  }

  // ── Tab label (count badge) ─────────────────────────────────────────

  /**
   * Renders the "Related Scenes" tab link text plus a count badge.
   * Queries the related-ids count on mount (so the user sees the number
   * without opening the tab) and subscribes to live updates from the tab
   * content via emitCountChange.
   */
  function RelatedScenesTabLabel(props) {
    var sceneId = String(props.scene.id);
    var _a = useState(null);
    var count = _a[0];
    var setCount = _a[1];
    useEffect(
      function () {
        var cancelled = false;
        readRelatedIds(sceneId)
          .then(function (ids) {
            if (cancelled) return;
            var filtered = excludeSelf(ids, sceneId);
            setCount(filtered.length);
          })
          .catch(function () {
            if (!cancelled) setCount(0);
          });
        var unsub = onCountChange(sceneId, function (n) {
          if (!cancelled) setCount(n);
        });
        return function () {
          cancelled = true;
          unsub();
        };
      },
      [sceneId]
    );
    return h(
      React.Fragment,
      null,
      "Related Scenes",
      count !== null && count > 0
        ? h(
            Badge,
            {
              pill: true,
              bg: "secondary",
              className: "scene-versions-tab-count",
            },
            String(count)
          )
        : null
    );
  }

  // ── React component ─────────────────────────────────────────────────

  function RelatedScenesTab(props) {
    var scene = props.scene;
    var _a = useState([]);
    var relatedIds = _a[0];
    var setRelatedIds = _a[1];
    var _b = useState([]);
    var relatedScenes = _b[0];
    var setRelatedScenes = _b[1];
    var _c = useState(true);
    var loading = _c[0];
    var setLoading = _c[1];
    var _d = useState(false);
    var saving = _d[0];
    var setSaving = _d[1];
    var _e = useState(null);
    var error = _e[0];
    var setError = _e[1];
    var _f = useState(false);
    var dirty = _f[0];
    var setDirty = _f[1];
    var loadedIdsRef = useRef([]);
    var _g = useState([]); // loaded pool of same-folder candidates
    var suggestionPool = _g[0];
    var setSuggestionPool = _g[1];
    var _h = useState(false); // first page in flight
    var suggestionsLoading = _h[0];
    var setSuggestionsLoading = _h[1];
    var _i = useState(SUGGESTION_INITIAL_VISIBLE);
    var suggestionVisible = _i[0];
    var setSuggestionVisible = _i[1];
    var _j = useState(1); // number of the last backend page fetched
    var suggestionPage = _j[0];
    var setSuggestionPage = _j[1];
    var _k = useState(false); // backend reported more pages
    var suggestionHasMore = _k[0];
    var setSuggestionHasMore = _k[1];
    var _l = useState(false); // next page in flight
    var suggestionLoadingMore = _l[0];
    var setSuggestionLoadingMore = _l[1];
    var _m = useState(false);
    var compareOpen = _m[0];
    var setCompareOpen = _m[1];
    var _n = useState([]);
    var phashSuggestions = _n[0];
    var setPhashSuggestions = _n[1];
    var Toast = hooks.useToast();

    // Restrict the scene picker to the current scene's folder so the
    // common "same performer/studio lives in one folder" workflow is
    // discoverable. Recomputed only when the scene changes.
    var folderCriteria = useMemo(
      function () {
        var folderPath = getFolderPath(scene);
        if (!folderPath) return [];
        return [makeFolderCriterion(folderPath)];
      },
      [scene]
    );

    // Load on mount
    useEffect(
      function () {
        var cancelled = false;
        setLoading(true);
        setError(null);
        loadRelatedScenes(scene.id, {
          onIds: function (filtered) {
            if (cancelled) return;
            loadedIdsRef.current = filtered.slice();
            setRelatedIds(filtered);
            setDirty(false);
            emitCountChange(scene.id, filtered.length);
          },
          onScenes: function (scenes) {
            if (cancelled) return;
            setRelatedScenes(scenes);
            setLoading(false);
          },
          onError: function (err) {
            if (cancelled) return;
            console.error("SceneVersions: load failed", err);
            setError(err.message || String(err));
            setLoading(false);
          },
        });
        return function () {
          cancelled = true;
        };
      },
      [scene.id]
    );

    // Keep the tab-label count badge in sync with the current edit state.
    // Fires whenever relatedIds changes (initial load, picker selection,
    // remove, add-suggestion, discard). The save handler also emits after
    // the persisted list is committed.
    useEffect(
      function () {
        emitCountChange(scene.id, relatedIds.length);
      },
      [scene.id, relatedIds]
    );

    // Load the first batch of same-folder candidates in the background.
    // Keyed on the scene only: already-linked scenes are excluded at
    // render time, so linking one must not re-run the query and reset the
    // pagination the user just expanded.
    useEffect(
      function () {
        var cancelled = false;
        var folderPath = getFolderPath(scene);
        setSuggestionPool([]);
        setSuggestionVisible(SUGGESTION_INITIAL_VISIBLE);
        setSuggestionPage(1);
        setSuggestionHasMore(false);
        setSuggestionLoadingMore(false);
        if (!folderPath) {
          setSuggestionsLoading(false);
          return;
        }
        setSuggestionsLoading(true);
        (async function () {
          var page = 1;
          var pool = [];
          var hasMore = false;
          while (!cancelled && page <= SUGGESTION_MAX_SCAN_PAGES) {
            var result = await fetchSuggestionPage(folderPath, page);
            if (cancelled) return;
            pool = mergeScenePool(pool, result.scenes);
            hasMore = !!result.hasMore;
            page++;
            var foundCurrent = pool.some(function (s) {
              return String(s.id) === String(scene.id);
            });
            if (!hasMore || foundCurrent) break;
          }
          if (cancelled) return;
          setSuggestionPool(pool);
          setSuggestionPage(page - 1);
          setSuggestionHasMore(hasMore);
          setSuggestionsLoading(false);
        })();
        return function () {
          cancelled = true;
        };
      },
      [scene.id]
    );

    useEffect(
      function () {
        var cancelled = false;
        fetchPhashSuggestions(scene, [scene.id].concat(relatedIds))
          .then(function (result) {
            if (cancelled) return;
            setPhashSuggestions(result);
          })
          .catch(function () {
            if (!cancelled) setPhashSuggestions({ needsHash: false, scenes: [] });
          });
        return function () { cancelled = true; };
      },
      [scene.id, relatedIds]
    );

    // Rank the loaded pool by filename similarity to this scene, so the
    // rows shown first are the plausible versions and not simply the
    // alphabetically first files of the folder.
    var currentFolderPath = useMemo(
      function () {
        return getFolderPath(scene);
      },
      [scene]
    );
    var currentFileName = useMemo(
      function () {
        return normalizeFileName(sceneFileName(scene));
      },
      [scene]
    );
    var rankedSuggestions = useMemo(
      function () {
        var excluded = new Set([String(scene.id)].concat(relatedIds.map(String)));
        var scored = [];
        suggestionPool.forEach(function (s) {
          if (excluded.has(String(s.id))) return;
          var score = similarityScore(currentFileName, normalizeFileName(sceneFileName(s)));
          if (currentFolderPath && getFolderPath(s) === currentFolderPath) {
            score = Math.min(1, score + SUGGESTION_SAME_DIR_BONUS);
          }
          scored.push({ scene: s, score: score, name: sceneFileName(s) });
        });
        scored.sort(function (a, b) {
          if (b.score !== a.score) return b.score - a.score;
          return a.name.localeCompare(b.name);
        });
        return scored.map(function (entry) {
          return entry.scene;
        });
      },
      [suggestionPool, relatedIds, scene.id, currentFolderPath, currentFileName]
    );

    var visibleSuggestions = rankedSuggestions.slice(0, suggestionVisible);
    var hiddenSuggestionCount = rankedSuggestions.length - visibleSuggestions.length;
    var canShowMoreSuggestions =
      hiddenSuggestionCount > 0 || suggestionHasMore;

    var handleSelect = useCallback(function (scenes) {
      var ids = scenes.map(function (s) {
        return String(s.id);
      });
      setRelatedIds(ids);
      setRelatedScenes(scenes);
      setDirty(!shallowEqual(ids, loadedIdsRef.current));
    }, []);

    var handleRemove = useCallback(function (removeId) {
      var newIds = relatedIds.filter(function (id) {
        return id !== removeId;
      });
      setRelatedIds(newIds);
      setDirty(!shallowEqual(newIds, loadedIdsRef.current));
      setRelatedScenes(function (prev) {
        return prev.filter(function (s) {
          return String(s.id) !== removeId;
        });
      });
    }, [relatedIds]);

    var handleSave = useCallback(function () {
      setSaving(true);
      setError(null);
      syncBidirectional(scene.id, relatedIds, loadedIdsRef.current)
        .then(function () {
          loadedIdsRef.current = relatedIds.slice();
          setDirty(false);
          setSaving(false);
          Toast.success("Related scenes updated");
        })
        .catch(function (err) {
          console.error("SceneVersions: save failed", err);
          setError(err.message || String(err));
          setSaving(false);
          Toast.error("Failed to save related scenes");
        });
    }, [scene.id, relatedIds]);

    var handleDiscard = useCallback(function () {
      var saved = loadedIdsRef.current.slice();
      setRelatedIds(saved);
      setDirty(false);
      setError(null);
      loadScenesByIds(saved)
        .then(function (scenes) {
          setRelatedScenes(scenes || []);
        })
        .catch(function (err) {
          console.error("SceneVersions: discard reload failed", err);
          setError(err.message || String(err));
        });
    }, []);

    var handleAddSuggestion = useCallback(function (suggestedScene) {
      var sid = String(suggestedScene.id);
      // Only add if not already in the list
      if (relatedIds.indexOf(sid) !== -1) return;
      var newIds = relatedIds.concat([sid]);
      setRelatedIds(newIds);
      setDirty(!shallowEqual(newIds, loadedIdsRef.current));
      // Also add the scene object so it appears in the card list immediately
      setRelatedScenes(function (prev) {
        return prev.concat([suggestedScene]);
      });
    }, [relatedIds]);

    /**
     * Reveal the next slice of candidates.
     *
     * While the loaded pool still has hidden rows, this is pure UI
     * pagination — no request. Only once the pool is exhausted (and the
     * backend count says there are more pages) does it fetch the next
     * page and rank the enlarged pool again.
     */
    function handleShowMoreSuggestions() {
      if (suggestionLoadingMore) return;
      if (hiddenSuggestionCount > 0) {
        setSuggestionVisible(suggestionVisible + SUGGESTION_VISIBLE_STEP);
        return;
      }
      if (!suggestionHasMore) return;
      var folderPath = getFolderPath(scene);
      if (!folderPath) return;
      var nextPage = suggestionPage + 1;
      setSuggestionLoadingMore(true);
      fetchSuggestionPage(folderPath, nextPage).then(function (result) {
        setSuggestionPool(function (prev) {
          return mergeScenePool(prev, result.scenes);
        });
        setSuggestionPage(nextPage);
        setSuggestionHasMore(!!result.hasMore);
        setSuggestionLoadingMore(false);
        setSuggestionVisible(suggestionVisible + SUGGESTION_VISIBLE_STEP);
      });
    }

    // ── Render ──────────────────────────────────────────────────────

    // Loading state
    if (loading) {
      return h(
        "div",
        { className: "scene-versions-loading" },
        h(Spinner, {
          animation: "border",
          size: "sm",
          role: "status",
          "aria-hidden": "true",
        }),
        h("span", null, "Loading related scenes\u2026")
      );
    }

    // Error state
    if (error) {
      return h(
        "div",
        { className: "scene-versions-tab" },
        h(
          Alert,
          { variant: "danger", className: "scene-versions-alert" },
          h(
            "p",
            { className: "mb-2" },
            h("strong", null, "Couldn\u2019t load related scenes"),
            ": ",
            error
          ),
          h(
            "div",
            { className: "d-flex justify-content-end" },
            h(
              Button,
              {
                variant: "outline-danger",
                size: "sm",
                onClick: function () {
                  setLoading(true);
                  setError(null);
                  loadRelatedScenes(scene.id, {
                    onIds: function (filtered) {
                      loadedIdsRef.current = filtered.slice();
                      setRelatedIds(filtered);
                      setDirty(false);
                    },
                    onScenes: function (scenes) {
                      setRelatedScenes(scenes);
                      setLoading(false);
                    },
                    onError: function (err) {
                      setError(err.message || String(err));
                      setLoading(false);
                    },
                  });
                },
              },
              "Retry"
            )
          )
        )
      );
    }

    return h(
      "div",
      { className: "scene-versions-tab" },
      // Related scenes list (shown first so the user sees what's linked
      // immediately on opening the tab, without scrolling past the editor)
      h(
        "div",
        { className: "scene-versions-list" },
        relatedScenes.length === 0
          ? h(
              "div",
              { className: "scene-versions-empty" },
              h("div", {
                className: "scene-versions-empty__illustration",
                "aria-hidden": "true",
              }),
              h(
                "div",
                { className: "scene-versions-empty__title" },
                "No related scenes yet"
              ),
              h(
                "p",
                null,
                "Link alternate versions of this scene \u2014 for example, the same performance in a different costume or from a different angle."
              )
            )
          : relatedScenes.map(function (s) {
              return h(
                "div",
                { key: s.id, className: "scene-versions-card" },
                h(
                  Link,
                  {
                    to: "/scenes/" + s.id,
                    className: "scene-versions-card__body",
                    title: sceneTitle(s),
                  },
                  s.paths && s.paths.screenshot
                    ? h("img", {
                        className: "scene-versions-thumb",
                        src: s.paths.screenshot,
                        alt: "",
                        loading: "lazy",
                      })
                    : h("div", {
                        className:
                          "scene-versions-thumb scene-versions-thumb--placeholder",
                      }),
                  h(
                    "div",
                    { className: "scene-versions-card__info" },
                    h(
                      "div",
                      { className: "scene-versions-card__title" },
                      sceneTitle(s)
                    ),
                    h(
                      "div",
                      { className: "scene-versions-card__meta" },
                      s.date
                        ? h("span", null, s.date)
                        : null,
                      s.studio && s.studio.name
                        ? h("span", null, s.studio.name)
                        : null
                    )
                  )
                ),
                h(
                  "div",
                  { className: "scene-versions-card__actions" },
                  h(
                    Button,
                    {
                      variant: "outline-danger",
                      size: "sm",
                      className: "scene-versions-remove",
                      title: "Remove this related scene",
                      "aria-label": "Remove this related scene",
                      onClick: function (evt) {
                        evt.preventDefault();
                        evt.stopPropagation();
                        handleRemove(String(s.id));
                      },
                    },
                    "Remove"
                  )
                )
              );
            })
      ),
      // Edit region: picker + actions
      h(
        "div",
        { className: "scene-versions-edit" },
        h(
          "label",
          { className: "scene-versions-label" },
          "Link alternate versions of this scene (filtered to the same folder)"
        ),
        h(components.SceneIDSelect, {
          ids: relatedIds,
          isMulti: true,
          excludeIds: [scene.id],
          extraCriteria: folderCriteria,
          onSelect: handleSelect,
        }),
        h(
          "div",
          { className: "scene-versions-actions" },
          dirty && !saving
            ? h(
                Badge,
                {
                  bg: "warning",
                  text: "dark",
                  className: "scene-versions-dirty-badge",
                },
                "Unsaved changes"
              )
            : null,
          h(
            Button,
            {
              variant: "outline-secondary",
              size: "sm",
              onClick: function () { setCompareOpen(!compareOpen); },
            },
            compareOpen ? "Hide compare" : "Compare"
          ),
          h(
            Button,
            {
              variant: "outline-secondary",
              size: "sm",
              onClick: function () {
                ensureVersionFilter()
                  .then(function (created) {
                    if (created) Toast.success("Saved filter created: Scene Versions: has alternate cut");
                    else Toast.success("Saved filter already exists: Scene Versions: has alternate cut");
                  })
                  .catch(function (err) {
                    console.error("SceneVersions: saved filter failed", err);
                    Toast.error("Could not create the scene filter");
                  });
              },
            },
            "Find all versioned"
          ),
          h(
            Button,
            {
              variant: "outline-secondary",
              size: "sm",
              disabled: !dirty || saving,
              onClick: handleDiscard,
            },
            "Discard changes"
          ),
          h(
            Button,
            {
              variant: "primary",
              size: "sm",
              disabled: !dirty || saving,
              onClick: handleSave,
            },
            saving
              ? h(
                  React.Fragment,
                  null,
                  h(Spinner, {
                    as: "span",
                    animation: "border",
                    size: "sm",
                    role: "status",
                    "aria-hidden": "true",
                  }),
                  " Saving\u2026"
                )
              : "Save"
          )
        )
      ),
      compareOpen
        ? h(
            "div",
            { className: "scene-versions-compare" },
            h("h4", null, "Version comparison"),
            h(
              "table",
              { className: "scene-versions-compare__table" },
              h("thead", null,
                h("tr", null,
                  h("th", null, "Field"),
                  h("th", null, "Current"),
                  relatedScenes.map(function (s) {
                    return h("th", { key: s.id }, sceneTitle(s));
                  })
                )
              ),
              h("tbody", null,
                ["duration", "resolution", "codec", "bitrate"].map(function (field) {
                  var base = sceneFileSummary(scene);
                  return h("tr", { key: field },
                    h("th", null, field),
                    h("td", null, base[field]),
                    relatedScenes.map(function (s) {
                      return h("td", { key: s.id }, sceneFileSummary(s)[field]);
                    })
                  );
                }),
                h("tr", null,
                  h("th", null, "date"),
                  h("td", null, scene.date || "\u2014"),
                  relatedScenes.map(function (s) {
                    return h("td", { key: s.id }, s.date || "\u2014");
                  })
                )
              )
            )
          )
        : null,
      // Suggestions from the same folder — closest filenames first, a
      // few rows at a time so a folder holding hundreds of scenes cannot
      // flood the tab.
      suggestionsLoading
        ? h(
            "div",
            { className: "scene-versions-suggestions-loading" },
            "Finding scenes in the same folder\u2026"
          )
        : visibleSuggestions.length > 0 || canShowMoreSuggestions
          ? h(
              "div",
              { className: "scene-versions-suggestions" },
              h(
                "div",
                { className: "scene-versions-suggestions__header" },
                "Scenes in the same folder",
                rankedSuggestions.length > 0
                  ? h(
                      "span",
                      { className: "scene-versions-suggestions__count" },
                      rankedSuggestions.length +
                        (suggestionHasMore ? "+" : "") +
                        " candidates, closest first"
                    )
                  : null
              ),
              visibleSuggestions.map(function (s) {
                return h(
                  "div",
                  { key: s.id, className: "scene-versions-suggestion" },
                  s.paths && s.paths.screenshot
                    ? h("img", {
                        className: "scene-versions-suggestion__thumb",
                        src: s.paths.screenshot,
                        alt: "",
                        loading: "lazy",
                      })
                    : h("div", {
                        className:
                          "scene-versions-suggestion__thumb scene-versions-suggestion__thumb--placeholder",
                      }),
                  h(
                    "span",
                    {
                      className: "scene-versions-suggestion__title",
                      title: sceneFileName(s),
                    },
                    sceneTitle(s)
                  ),
                  h(
                    Button,
                    {
                      variant: "outline-primary",
                      size: "sm",
                      className: "scene-versions-suggestion__add",
                      title: "Add this scene as a related version",
                      "aria-label": "Add this scene as a related version",
                      onClick: function (evt) {
                        evt.preventDefault();
                        evt.stopPropagation();
                        handleAddSuggestion(s);
                      },
                    },
                    "Add"
                  )
                );
              }),
              canShowMoreSuggestions
                ? h(
                    "div",
                    { className: "scene-versions-suggestions__footer" },
                    h(
                      Button,
                      {
                        variant: "outline-secondary",
                        size: "sm",
                        className: "scene-versions-suggestions__more",
                        disabled: suggestionLoadingMore,
                        onClick: handleShowMoreSuggestions,
                      },
                      suggestionLoadingMore
                        ? "Loading\u2026"
                        : hiddenSuggestionCount > 0
                          ? "Show more (" + hiddenSuggestionCount + ")"
                          : "Load more from this folder"
                    )
                  )
                : null
            )
          : null,
      phashSuggestions.needsHash
        ? h(
            "div",
            { className: "scene-versions-suggestions-loading" },
            "No pHash is stored for this scene. Run Generate after enabling video pHashes to get same-shoot suggestions."
          )
        : phashSuggestions.scenes && phashSuggestions.scenes.length > 0
          ? h(
              "div",
              { className: "scene-versions-suggestions" },
              h("div", { className: "scene-versions-suggestions__header" }, "Possible same shoot (pHash)"),
              phashSuggestions.scenes.map(function (s) {
                return h(
                  "div",
                  { key: "phash-" + s.id, className: "scene-versions-suggestion" },
                  s.paths && s.paths.screenshot
                    ? h("img", { className: "scene-versions-suggestion__thumb", src: s.paths.screenshot, alt: "", loading: "lazy" })
                    : h("div", { className: "scene-versions-suggestion__thumb scene-versions-suggestion__thumb--placeholder" }),
                  h("span", { className: "scene-versions-suggestion__title" }, sceneTitle(s)),
                  h(Button, {
                    variant: "outline-primary",
                    size: "sm",
                    className: "scene-versions-suggestion__add",
                    onClick: function (evt) {
                      evt.preventDefault();
                      evt.stopPropagation();
                      handleAddSuggestion(s);
                    },
                  }, "Add")
                );
              })
            )
          : null
    );
  }

  // ── Tab injection ──────────────────────────────────────────────────

  function findInsertIndex(childrenArray) {
    var arr = Array.isArray(childrenArray) ? childrenArray : [childrenArray];
    for (var i = 0; i < arr.length; i++) {
      var el = arr[i];
      if (!el || !el.props) continue;
      // Case 1: Tab.Pane with direct eventKey (TabContent patch)
      if (el.props.eventKey === "scene-details-panel") return i + 1;
      // Case 2: Nav.Item wrapping Nav.Link (Tabs patch)
      var child = el.props.children;
      if (child && child.props && child.props.eventKey === "scene-details-panel") return i + 1;
    }
    return arr.length;
  }

  function insertAfterDetailsTab(childrenArray, newElement) {
    var arr = Array.isArray(childrenArray)
      ? childrenArray.slice()
      : [childrenArray];
    var insertIdx = findInsertIndex(arr);
    arr.splice(insertIdx, 0, newElement);
    return React.createElement(React.Fragment, null, arr);
  }

  try {
    PluginApi.patch.before("ScenePage.Tabs", function (props) {
      try {
        var newChildren = insertAfterDetailsTab(
          props.children,
          h(
            Nav.Item,
            { key: TAB_KEY },
            h(
              Nav.Link,
              { eventKey: TAB_KEY },
              h(RelatedScenesTabLabel, { scene: props.scene })
            )
          )
        );
        return [{ children: newChildren }];
      } catch (e) {
        console.error("SceneVersions: ScenePage.Tabs patch failed", e);
        return [props];
      }
    });

    PluginApi.patch.before("ScenePage.TabContent", function (props) {
      try {
        var newChildren = insertAfterDetailsTab(
          props.children,
          h(
            Tab.Pane,
            { key: TAB_KEY, eventKey: TAB_KEY, mountOnEnter: true },
            h(RelatedScenesTab, { scene: props.scene })
          )
        );
        return [{ children: newChildren }];
      } catch (e) {
        console.error("SceneVersions: ScenePage.TabContent patch failed", e);
        return [props];
      }
    });
    // PatchFunction calls the render function with (props, legacyContext), then
    // appends the render result, so an after handler MUST declare the context
    // slot. Reading the result as the 2nd parameter yields React's
    // emptyContextObject ({}), and rendering it as a child throws
    // "Objects are not valid as a React child (found: object with keys {})".
    PluginApi.patch.after("SceneCard.Overlays", function (props, _ctx, result) {
      try {
        var sceneId = props && props.scene && props.scene.id;
        if (!sceneId) return result;
        return h(
          React.Fragment,
          null,
          result,
          h(VersionBadge, { sceneId: String(sceneId) })
        );
      } catch (e) {
        console.error("SceneVersions: SceneCard.Overlays patch failed", e);
        return result;
      }
    });
  } catch (e) {
    console.error("SceneVersions: failed to register patches", e);
  }
})();
