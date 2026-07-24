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

  async function syncBidirectional(currentSceneId, newIds, originalIds) {
    // Filter out self-link from both sets
    var filteredNew = newIds.filter(function (id) {
      return id !== currentSceneId;
    });
    var filteredOrig = originalIds.filter(function (id) {
      return id !== currentSceneId;
    });

    var newSet = new Set(filteredNew);
    var origSet = new Set(filteredOrig);

    var added = filteredNew.filter(function (id) {
      return !origSet.has(id);
    });
    var removed = filteredOrig.filter(function (id) {
      return !newSet.has(id);
    });

    // Update added scenes: add currentSceneId to their RelatedScenes
    for (var i = 0; i < added.length; i++) {
      var id = added[i];
      var existing = await readRelatedIds(id);
      if (existing.indexOf(currentSceneId) === -1) {
        existing.push(currentSceneId);
        await writeRelatedIds(id, existing);
      }
    }

    // Update removed scenes: remove currentSceneId from their RelatedScenes
    for (var j = 0; j < removed.length; j++) {
      var rid = removed[j];
      var existing = await readRelatedIds(rid);
      var filtered = existing.filter(function (eid) {
        return eid !== currentSceneId;
      });
      if (filtered.length !== existing.length) {
        await writeRelatedIds(rid, filtered);
      }
    }

    // Write current scene's list
    await writeRelatedIds(currentSceneId, filteredNew);

    return { ok: true };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

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

  /**
   * Fetch scenes sharing the same folder as the current scene.
   *
   * Approach: Use GQL.FindScenesDocument with a scene_filter on path
   * (modifier: "INCLUDES"). This is the standard Stash API filter for
   * path-based queries. The folder path is derived from the current
   * scene's first file path with the basename stripped.
   *
   * We request up to 200 scenes sorted by path. The INCLUDES modifier
   * is a substring match, which may also match scenes in subfolders
   * whose path contains the folder string — acceptable for a suggestion
   * feature since folders usually contain few scenes and the user can
   * simply ignore irrelevant suggestions.
   */
  async function fetchSuggestions(folderPath, excludeIds) {
    if (!folderPath) return [];
    var excludeSet = new Set(excludeIds.map(String));
    try {
      var result = await apolloClient.query({
        query: GQL.FindScenesDocument,
        variables: {
          filter: { per_page: 200, sort: "path" },
          scene_filter: {
            path: { value: folderPath, modifier: "INCLUDES" },
          },
        },
        fetchPolicy: "no-cache",
      });
      var scenes = result.data.findScenes.scenes || [];
      return scenes.filter(function (s) {
        return !excludeSet.has(String(s.id));
      });
    } catch (err) {
      console.error("SceneVersions: fetchSuggestions failed", err);
      return [];
    }
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
            var filtered = ids.filter(function (id) {
              return id !== sceneId;
            });
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
      count !== null
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
    var _g = useState([]);
    var suggestions = _g[0];
    var setSuggestions = _g[1];
    var _h = useState(false);
    var suggestionsLoading = _h[0];
    var setSuggestionsLoading = _h[1];
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
        readRelatedIds(scene.id)
          .then(function (ids) {
            if (cancelled) return;
            var filtered = ids.filter(function (id) {
              return id !== scene.id;
            });
            loadedIdsRef.current = filtered.slice();
            setRelatedIds(filtered);
            setDirty(false);
            emitCountChange(scene.id, filtered.length);
            return loadScenesByIds(filtered);
          })
          .then(function (scenes) {
            if (cancelled) return;
            setRelatedScenes(scenes || []);
            setLoading(false);
          })
          .catch(function (err) {
            if (cancelled) return;
            console.error("SceneVersions: load failed", err);
            setError(err.message || String(err));
            setLoading(false);
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

    // Fetch suggestions from same folder (parallel, non-blocking)
    useEffect(
      function () {
        var cancelled = false;
        var folderPath = getFolderPath(scene);
        if (!folderPath) {
          setSuggestions([]);
          setSuggestionsLoading(false);
          return;
        }
        setSuggestionsLoading(true);
        fetchSuggestions(folderPath, [scene.id].concat(relatedIds))
          .then(function (scenes) {
            if (cancelled) return;
            setSuggestions(scenes);
            setSuggestionsLoading(false);
          })
          .catch(function () {
            if (cancelled) return;
            setSuggestions([]);
            setSuggestionsLoading(false);
          });
        return function () {
          cancelled = true;
        };
      },
      [scene.id, relatedIds]
    );

    var handleSelect = useCallback(function (scenes) {
      var ids = scenes.map(function (s) {
        return String(s.id);
      });
      setRelatedIds(ids);
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
                  readRelatedIds(scene.id)
                    .then(function (ids) {
                      var filtered = ids.filter(function (id) {
                        return id !== scene.id;
                      });
                      loadedIdsRef.current = filtered.slice();
                      setRelatedIds(filtered);
                      setDirty(false);
                      return loadScenesByIds(filtered);
                    })
                    .then(function (scenes) {
                      setRelatedScenes(scenes || []);
                      setLoading(false);
                    })
                    .catch(function (err) {
                      setError(err.message || String(err));
                      setLoading(false);
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
      // Suggestions from same folder
      suggestions.length > 0
        ? h(
            "div",
            { className: "scene-versions-suggestions" },
            h(
              "div",
              { className: "scene-versions-suggestions__header" },
              "Scenes in the same folder"
            ),
            suggestions.map(function (s) {
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
                  { className: "scene-versions-suggestion__title" },
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
            })
          )
        : suggestionsLoading
          ? h(
              "div",
              { className: "scene-versions-suggestions-loading" },
              "Finding scenes in the same folder\u2026"
            )
          : null
    );
  }

  // ── Tab injection ──────────────────────────────────────────────────

  function findInsertIndex(childrenArray) {
    var arr = Array.isArray(childrenArray) ? childrenArray : [childrenArray];
    for (var i = 0; i < arr.length; i++) {
      var el = arr[i];
      if (el && el.props) {
        // Direct eventKey (Tab.Pane)
        if (el.props.eventKey === "scene-details-panel") return i + 1;
        // Child Nav.Link eventKey (Nav.Item > Nav.Link)
        if (
          el.props.children &&
          el.props.children.props &&
          el.props.children.props.eventKey === "scene-details-panel"
        )
          return i + 1;
      }
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
  } catch (e) {
    console.error("SceneVersions: failed to register patches", e);
  }
})();
