/**
 * SceneVersions — Related Scenes tab for the Stash scene page.
 *
 * Architecture:
 * - Adds a "Related Scenes" tab to the scene page via PluginApi.patch.before
 *   on "ScenePage.Tabs" and "ScenePage.TabContent".
 * - Stores bidirectional links in scene custom_fields under the key
 *   "RelatedScenes" (an array of scene ID strings).
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
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useCallback = React.useCallback;
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

  async function readRelatedIds(sceneId) {
    var data = await libraries.Apollo.client.query({
      query: GQL.FindSceneDocument,
      variables: { id: sceneId },
      fetchPolicy: "no-cache",
    });
    var raw = data.data.findScene?.custom_fields?.[RELATED_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.map(String);
  }

  async function loadScenesByIds(ids) {
    if (!ids || ids.length === 0) return [];
    var results = await Promise.all(
      ids.map(function (id) {
        return libraries.Apollo.client
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
    await libraries.Apollo.client.mutate({
      mutation: GQL.SceneUpdateDocument,
      variables: {
        input: {
          id: sceneId,
          custom_fields: {
            partial: {
              [RELATED_KEY]: ids,
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
    var Toast = hooks.useToast();

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
      // Section header
      h(
        "div",
        { className: "scene-versions-header" },
        h("h5", { className: "scene-versions-heading" }, "Related Scenes"),
        h(
          Badge,
          {
            pill: true,
            bg: "secondary",
            className: "scene-versions-count",
          },
          String(relatedIds.length)
        )
      ),
      // Edit region: picker + actions
      h(
        "div",
        { className: "scene-versions-edit" },
        h(
          "label",
          { className: "scene-versions-label" },
          "Link alternate versions of this scene"
        ),
        h(components.SceneIDSelect, {
          ids: relatedIds,
          isMulti: true,
          excludeIds: [scene.id],
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
      // Related scenes list
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
      )
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
            h(Nav.Link, { eventKey: TAB_KEY }, "Related Scenes")
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
