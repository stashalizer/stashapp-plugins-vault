/**
 * MosaicFilterSettings — full-page settings UI.
 *
 * The persisted config has three layers: global defaults, per-studio presets
 * and per-scene presets. The overlay resolves scene > studio > default. This
 * page can edit the default layer or any existing preset, and delete presets.
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
  const storage = window.MosaicFilterStorage || {
    loadConfig: function () { return window.csLib.getConfiguration(CONFIG_KEY).then(function (v) { return v || {}; }); },
    saveConfig: function (value) { return window.csLib.setConfiguration(CONFIG_KEY, value); },
  };

  var clamp = window.MosaicFilterShared.clamp;
  var isFiniteNumber = window.MosaicFilterShared.isFiniteNumber;
  var makeDefaultState = window.MosaicFilterShared.makeDefaultState;
  var makeDefaultConfig = window.MosaicFilterShared.makeDefaultConfig;
  var normalizeConfig = window.MosaicFilterShared.normalizeConfig;
  var sanitizeState = window.MosaicFilterShared.sanitizeState;

  let settingsToolsCallCount = 0;

  function targetLabel(target, config) {
    if (target.kind === "scene") return "Scene preset · " + target.id;
    if (target.kind === "studio") return "Studio preset · " + target.id;
    return "Global default";
  }

  function targetState(config, target) {
    if (target.kind === "scene") return config.scenePresets[String(target.id)] || makeDefaultState();
    if (target.kind === "studio") return config.studioPresets[String(target.id)] || makeDefaultState();
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

    const state = targetState(config, target);

    function updateField(patch) {
      setConfig(function (prev) {
        const next = normalizeConfig(prev);
        const updated = sanitizeState(Object.assign({}, targetState(next, target), patch));
        if (target.kind === "scene") next.scenePresets[String(target.id)] = updated;
        else if (target.kind === "studio") next.studioPresets[String(target.id)] = updated;
        else next.default = updated;
        return next;
      });
      setDirty(true);
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
          value: Math.round(state[fieldKey] * 100),
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
          value: state[fieldKey],
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
          value: state[fieldKey],
          onChange: function (e) { updateField({ [fieldKey]: e.target.value }); },
        },
          options.map(function (opt) {
            return h("option", { value: opt.value, key: opt.value }, opt.label);
          })
        )
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
            h("span", null, (kind === "scene" ? "Scene " : "Studio ") + id),
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
        "Region-level redaction for any scene. Presets resolve scene > studio > global default. ",
        "Use the overlay's Save scene / Save studio buttons to create a preset."
      ),

      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Editing: " + targetLabel(target, config)),
        target.kind !== "default"
          ? h("button", {
              type: "button",
              className: "mosaic-filter-settings__button",
              onClick: function () { setTarget({ kind: "default", id: null }); },
            }, "Back to global default")
          : null,
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
              value: state.fillColor,
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
              checked: !!state.active,
              onChange: function (e) { updateField({ active: !!e.target.checked }); },
            }),
            h("span", null, "Active")
          ),
          h("label", { className: "mosaic-filter-settings__checkbox" },
            h("input", {
              type: "checkbox",
              checked: !!state.follow,
              onChange: function (e) { updateField({ follow: !!e.target.checked }); },
            }),
            h("span", null, "Follow cursor")
          )
        )
      ),

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
        h("p", null, "Global defaults and scene/studio presets")
      )
    );
    const newChildren = Array.isArray(props.children)
      ? [...props.children, card]
      : [props.children, card];
    return [Object.assign({}, props, { children: newChildren })];
  });
})();
