/**
 * MosaicFilterSettings — full-page settings UI.
 *
 * The persisted config has three layers: global defaults, per-studio presets
 * and per-scene presets. The overlay resolves scene > studio > default. This
 * page can edit the default layer or any existing preset, and delete presets.
 *
 * Each layer holds a list of independent filter regions plus the id of the one
 * being edited, so this page works in two steps: pick the layer (the target),
 * then pick the region inside it. Adding, renaming, selecting and deleting a
 * region all go through MosaicFilterShared's layer operations — the same calls
 * the player overlay makes — so the two surfaces cannot drift apart.
 */
(function () {
  "use strict";

  if (!window.PluginApi || !window.csLib) {
    console.error("MosaicFilter settings: PluginApi or csLib missing");
    return;
  }

  const React = PluginApi.React;
  const h = React.createElement;
  const { useState, useEffect } = React;
  const { Route, Link } = PluginApi.libraries.ReactRouterDOM;

  const CONFIG_KEY = window.MosaicFilterShared.CONFIG_KEY;
  const PLUGIN_ROUTE = "/plugins/mosaicfilter";
  const MIN_SIZE_PCT = window.MosaicFilterShared.MIN_SIZE_PCT;
  const MAX_BLUR = window.MosaicFilterShared.MAX_BLUR;
  const MAX_FILTERS = window.MosaicFilterShared.MAX_FILTERS;
  const MAX_NAME_LEN = window.MosaicFilterShared.MAX_NAME_LEN;
  const storage = window.MosaicFilterStorage || {
    loadConfig: function () { return window.csLib.getConfiguration(CONFIG_KEY).then(function (v) { return v || {}; }); },
    saveConfig: function (value) { return window.csLib.setConfiguration(CONFIG_KEY, value); },
  };

  var clamp = window.MosaicFilterShared.clamp;
  var makeDefaultLayer = window.MosaicFilterShared.makeDefaultLayer;
  var makeDefaultConfig = window.MosaicFilterShared.makeDefaultConfig;
  var normalizeConfig = window.MosaicFilterShared.normalizeConfig;
  var selectedFilter = window.MosaicFilterShared.selectedFilter;
  var selectFilter = window.MosaicFilterShared.selectFilter;
  var spawnFilter = window.MosaicFilterShared.spawnFilter;
  var updateFilter = window.MosaicFilterShared.updateFilter;
  var resetFilter = window.MosaicFilterShared.resetFilter;
  var removeFilter = window.MosaicFilterShared.removeFilter;
  var filterName = window.MosaicFilterShared.filterName;

  let settingsToolsCallCount = 0;

  function targetLabel(target) {
    if (target.kind === "scene") return "Scene preset · " + target.id;
    if (target.kind === "studio") return "Studio preset · " + target.id;
    return "Global default";
  }

  // Read a target's layer for display. A preset is created by the overlay's
  // "Save scene" / "Save studio" (or by the first edit here, via
  // ensureTargetLayer), so a missing one only ever shows a placeholder: its ids
  // are fresh on every render and are not meant to be edited through. Deleting
  // a preset drops the target back to the global default, so the placeholder
  // cannot be reached by navigation.
  function targetLayer(config, target) {
    if (target.kind === "scene") {
      return config.scenePresets[String(target.id)] || makeDefaultLayer();
    }
    if (target.kind === "studio") {
      return config.studioPresets[String(target.id)] || makeDefaultLayer();
    }
    return config.default;
  }

  // Read a target's layer for writing. The returned layer is part of `config`,
  // so mutating it and returning `config` is enough.
  function ensureTargetLayer(config, target) {
    if (target.kind === "scene") {
      const key = String(target.id);
      if (!config.scenePresets[key]) config.scenePresets[key] = makeDefaultLayer();
      return config.scenePresets[key];
    }
    if (target.kind === "studio") {
      const key = String(target.id);
      if (!config.studioPresets[key]) config.studioPresets[key] = makeDefaultLayer();
      return config.studioPresets[key];
    }
    return config.default;
  }

  function MosaicFilterSettingsPage() {
    const [config, setConfig] = useState(function () { return makeDefaultConfig(); });
    const [target, setTarget] = useState({ kind: "default", id: null });
    const [loaded, setLoaded] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [saveError, setSaveError] = useState(null);

    useEffect(function () {
      let cancelled = false;
      (async function () {
        try {
          const stored = await storage.loadConfig();
          if (!cancelled) setConfig(normalizeConfig(stored));
        } catch (err) {
          console.error("MosaicFilter settings: failed to read configuration", err);
        }
        if (!cancelled) setLoaded(true);
      })();
      return function () { cancelled = true; };
    }, []);

    const layer = targetLayer(config, target);
    const filter = selectedFilter(layer);
    const multi = layer.filters.length > 1;

    // Every edit funnels through here: copy the previous config, find (or
    // create) the target layer inside the copy, let the caller mutate it, and
    // hand the copy back to React. Normalizing on the way in is what keeps
    // ids unique and the selection valid after a deletion.
    function editLayer(mutate, markDirty) {
      setConfig(function (prev) {
        const next = normalizeConfig(prev);
        mutate(ensureTargetLayer(next, target), next);
        return next;
      });
      if (markDirty !== false) setDirty(true);
    }

    function updateField(patch) {
      editLayer(function (l) {
        const f = selectedFilter(l);
        if (f) updateFilter(l, f.id, patch);
      });
    }

    function chooseFilter(id) {
      // Selection is layer state, but it is a browsing action: it must not
      // light up Save on its own. It rides along with the next real edit.
      editLayer(function (l) { selectFilter(l, id); }, false);
    }

    function addRegion() {
      editLayer(function (l) { spawnFilter(l); });
    }

    function deleteRegion(id) {
      editLayer(function (l) { removeFilter(l, id); });
    }

    function renameRegion(id, name) {
      editLayer(function (l) { updateFilter(l, id, { name: name }); });
    }

    function deletePreset(kind, id) {
      setConfig(function (prev) {
        const next = normalizeConfig(prev);
        if (kind === "scene") delete next.scenePresets[String(id)];
        if (kind === "studio") delete next.studioPresets[String(id)];
        return next;
      });
      if (target.kind === kind && String(target.id) === String(id)) {
        setTarget({ kind: "default", id: null });
      }
      setDirty(true);
    }

    async function save() {
      try {
        await storage.saveConfig(config, function (latest) {
          const normalized = normalizeConfig(latest);
          return {
            default: config.default,
            scenePresets: Object.assign({}, normalized.scenePresets, config.scenePresets),
            studioPresets: Object.assign({}, normalized.studioPresets, config.studioPresets),
          };
        }, "Mosaic Filter settings");
        setSaveError(null);
        setDirty(false);
      } catch (err) {
        setSaveError(String((err && err.message) || err));
        console.error("MosaicFilter settings: save failed", err);
      }
    }

    if (!loaded) {
      return h("div", { className: "mosaic-filter-settings", "data-mosaic-filter-ui": "true" },
        h("p", { className: "mosaic-filter-settings__loading" }, "Loading…")
      );
    }

    function percentField(label, fieldKey, minPct, maxPct) {
      return h("label", null,
        h("span", null, label),
        h("input", {
          type: "number",
          min: minPct,
          max: maxPct,
          step: 1,
          value: Math.round(filter[fieldKey] * 100),
          onChange: function (e) {
            const v = parseInt(e.target.value, 10);
            const safe = isNaN(v) ? minPct : v;
            updateField({ [fieldKey]: clamp(safe, minPct, maxPct) / 100 });
          },
        })
      );
    }

    function pixelField(label, fieldKey, min, max) {
      return h("label", null,
        h("span", null, label),
        h("input", {
          type: "number",
          min: min,
          max: max,
          step: 1,
          value: filter[fieldKey],
          onChange: function (e) {
            const v = parseInt(e.target.value, 10);
            updateField({ [fieldKey]: clamp(isNaN(v) ? min : v, min, max) });
          },
        })
      );
    }

    function selectField(label, fieldKey, options) {
      return h("label", null,
        h("span", null, label),
        h("select", {
          value: filter[fieldKey],
          onChange: function (e) { updateField({ [fieldKey]: e.target.value }); },
        },
          options.map(function (opt) {
            return h("option", { value: opt.value, key: opt.value }, opt.label);
          })
        )
      );
    }

    // One editable region: a radio to make it the target of the form below, a
    // name field, its on/off state and a delete button.
    function regionRow(f, index) {
      const selected = f.id === layer.selectedId;
      const label = filterName(f, index);
      return h("div", {
        className: "mosaic-filter-settings__region" + (selected ? " mosaic-filter-settings__region--selected" : ""),
        key: f.id,
      },
        h("input", {
          type: "radio",
          className: "mosaic-filter-settings__region-pick",
          name: "mosaic-filter-region",
          checked: selected,
          onChange: function () { chooseFilter(f.id); },
          "aria-label": "Edit " + label,
          title: "Edit this filter",
        }),
        h("input", {
          type: "text",
          className: "mosaic-filter-settings__region-name",
          value: f.name,
          maxLength: MAX_NAME_LEN,
          placeholder: "Filter " + (index + 1),
          "aria-label": "Name of filter " + (index + 1),
          onChange: function (e) { renameRegion(f.id, e.target.value); },
        }),
        h("span", { className: "mosaic-filter-settings__region-state" }, f.active ? "on" : "off"),
        h("button", {
          type: "button",
          className: "mosaic-filter-settings__button mosaic-filter-settings__button--danger",
          disabled: !multi,
          title: multi ? "Delete " + label : "A layer needs at least one filter",
          onClick: function () { deleteRegion(f.id); },
        }, "Delete")
      );
    }

    function presetList(kind, map) {
      const keys = Object.keys(map);
      if (keys.length === 0) {
        return h("p", { className: "mosaic-filter-settings__hint" },
          "No " + kind + " presets yet. Use “Save " + kind + "” in the player overlay.");
      }
      return h("div", { className: "mosaic-filter-settings__preset-list" },
        keys.map(function (id) {
          return h("div", { className: "mosaic-filter-settings__preset-row", key: kind + ":" + id },
            h("span", null, (kind === "scene" ? "Scene " : "Studio ") + id +
              " · " + map[id].filters.length + (map[id].filters.length === 1 ? " filter" : " filters")),
            h("button", {
              type: "button",
              className: "mosaic-filter-settings__button",
              onClick: function () { setTarget({ kind: kind, id: id }); },
            }, "Edit"),
            h("button", {
              type: "button",
              className: "mosaic-filter-settings__button mosaic-filter-settings__button--danger",
              onClick: function () { deletePreset(kind, id); },
            }, "Delete")
          );
        })
      );
    }

    return h("div", { className: "mosaic-filter-settings", "data-mosaic-filter-ui": "true" },
      h("h1", null, "Mosaic Filter"),
      h("p", { className: "mosaic-filter-settings__intro" },
        "Region-level redaction for any scene. A layer can hold several independent filters; ",
        "presets resolve scene > studio > global default. ",
        "Use the overlay's Save scene / Save studio buttons to create a preset."
      ),

      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Editing: " + targetLabel(target)),
        target.kind !== "default"
          ? h("button", {
              type: "button",
              className: "mosaic-filter-settings__button",
              onClick: function () { setTarget({ kind: "default", id: null }); },
            }, "Back to global default")
          : null,

        h("h3", { className: "mosaic-filter-settings__subhead" },
          "Filters (" + layer.filters.length + (multi ? " of " + MAX_FILTERS : "") + ")"),
        h("p", { className: "mosaic-filter-settings__hint" },
          "Each filter keeps its own position, size, effect and visibility. ",
          multi
            ? "The selected filter is the one the controls below edit."
            : "Add a second filter to redact more than one region at the same time."
        ),
        h("div", { className: "mosaic-filter-settings__region-list" },
          layer.filters.map(regionRow),
          h("button", {
            type: "button",
            className: "mosaic-filter-settings__button mosaic-filter-settings__add",
            disabled: layer.filters.length >= MAX_FILTERS,
            title: layer.filters.length >= MAX_FILTERS
              ? "Limit reached (" + MAX_FILTERS + " filters)"
              : "Add a filter copied from the selected one",
            onClick: addRegion,
          }, "+ Add filter")
        )
      ),

      filter ? h("div", null,

        h("section", { className: "mosaic-filter-settings__section" },
          h("h2", null, "Style · " + filterName(filter, layer.filters.indexOf(filter))),
          h("div", { className: "mosaic-filter-settings__row" },
            pixelField("Blur amount (px)", "blurAmount", 0, MAX_BLUR),
            selectField("Fill", "fill", [
              { value: "blur", label: "Blur" },
              { value: "solid", label: "Solid" },
              { value: "pixelate", label: "Pixelate" },
            ]),
            selectField("Shape", "shape", [
              { value: "rectangle", label: "Rectangle" },
              { value: "ellipse", label: "Ellipse" },
            ]),
            selectField("Mode", "mode", [
              { value: "normal", label: "Normal — hide inside the filter" },
              { value: "reverse", label: "Reverse — hide everything else" },
            ])
          ),
          h("div", { className: "mosaic-filter-settings__row" },
            h("label", null,
              h("span", null, "Solid colour"),
              h("input", {
                type: "color",
                value: filter.fillColor,
                onChange: function (e) { updateField({ fillColor: e.target.value }); },
              })
            ),
            pixelField("Pixel size (px)", "pixelSize", 4, 64)
          )
        ),

        h("section", { className: "mosaic-filter-settings__section" },
          h("h2", null, "Geometry"),
          h("p", { className: "mosaic-filter-settings__hint" },
            "Size and position as percentages of the player."
          ),
          h("div", { className: "mosaic-filter-settings__row" },
            percentField("Width (% of player)", "widthPct", Math.round(MIN_SIZE_PCT * 100), 100),
            percentField("Height (% of player)", "heightPct", Math.round(MIN_SIZE_PCT * 100), 100),
            percentField("Position X (% from left)", "xPct", 0, 100),
            percentField("Position Y (% from top)", "yPct", 0, 100)
          )
        ),

        h("section", { className: "mosaic-filter-settings__section" },
          h("h2", null, "Behavior"),
          h("div", { className: "mosaic-filter-settings__row" },
            h("label", { className: "mosaic-filter-settings__checkbox" },
              h("input", {
                type: "checkbox",
                checked: !!filter.active,
                onChange: function (e) { updateField({ active: !!e.target.checked }); },
              }),
              h("span", null, "Active")
            ),
            h("label", { className: "mosaic-filter-settings__checkbox" },
              h("input", {
                type: "checkbox",
                checked: !!filter.follow,
                onChange: function (e) { updateField({ follow: !!e.target.checked }); },
              }),
              h("span", null, "Follow cursor")
            ),
            h("button", {
              type: "button",
              className: "mosaic-filter-settings__button",
              title: "Restore this filter's parameters to the built-in defaults",
              onClick: function () { editLayer(function (l) { resetFilter(l, filter.id); }); },
            }, "Reset this filter")
          )
        )
      ) : null,

      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Scene presets"),
        presetList("scene", config.scenePresets)
      ),

      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Studio presets"),
        presetList("studio", config.studioPresets)
      ),

      h("section", { className: "mosaic-filter-settings__section" },
        h("div", { className: "mosaic-filter-settings__actions" },
          h("button", {
            type: "button",
            className: "mosaic-filter-settings__button mosaic-filter-settings__button--primary",
            disabled: !dirty,
            onClick: save,
          }, "Save"),
          dirty
            ? h("span", { className: "mosaic-filter-settings__hint" }, "Unsaved changes")
            : null,
          saveError ? h("span", { className: "mosaic-filter-settings__error" }, saveError) : null
        )
      )
    );
  }

  PluginApi.patch.before("PluginRoutes", function (props) {
    const newChildren = h(
      React.Fragment,
      null,
      props.children,
      h(Route, { path: PLUGIN_ROUTE, component: MosaicFilterSettingsPage })
    );
    return [Object.assign({}, props, { children: newChildren })];
  });

  PluginApi.patch.before("SettingsToolsSection", function (props) {
    settingsToolsCallCount += 1;
    if (settingsToolsCallCount % 2 !== 0) {
      return [props];
    }
    const card = h(
      Link,
      { to: PLUGIN_ROUTE, className: "mosaic-filter-settings__launcher" },
      h(
        "div",
        { className: "mosaic-filter-settings__launcher-card" },
        h("h3", null, "Mosaic Filter"),
        h("p", null, "Global defaults, scene/studio presets and multiple filter regions")
      )
    );
    const newChildren = Array.isArray(props.children)
      ? [...props.children, card]
      : [props.children, card];
    return [Object.assign({}, props, { children: newChildren })];
  });
})();
