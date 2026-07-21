/**
 * MosaicFilterSettings — full-page settings UI.
 *
 * Architecture:
 * - Registers a route via PluginApi.patch.before("PluginRoutes", ...) at
 *   /plugins/mosaicfilter.
 * - Adds a launcher card in Settings > Tools via
 *   PluginApi.patch.before("SettingsToolsSection", ...). The launcher appears
 *   only under the "Scene Tools" subsection (the second SettingsToolsSection
 *   instance in SettingsToolsPanel) by gating on a module-level call counter.
 * - Reads/writes the same config key ("MosaicFilter") as the overlay. The
 *   config is a single flat object (no per-scene storage); the form on this
 *   page edits the same values the overlay reads and writes.
 * - Both surfaces maintain separate save locks and do not coordinate; this
 *   is the same trade-off QuestingAdventurer makes.
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

  const csLib = window.csLib;
  const CONFIG_KEY = "MosaicFilter";
  const PLUGIN_ROUTE = "/plugins/mosaicfilter";

  const MIN_SIZE_PCT = 0.05;
  const MAX_BLUR = 80;

  const FALLBACK_DEFAULTS = {
    blurAmount: 10,
    widthPct: 0.25,
    heightPct: 0.25,
    xPct: 0.1,
    yPct: 0.1,
    active: false,
    follow: false,
    shape: 'rectangle',
    mode: 'normal',
  };

  let settingsToolsCallCount = 0;

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }

  function makeDefaultState() {
    return { ...FALLBACK_DEFAULTS };
  }

  // Merge a stored config map onto a fresh default state. Tolerates the
  // legacy { defaults, scenes } shape by reading the old `defaults` and
  // ignoring `scenes` (per-scene storage was removed in 0.3.0).
  function mergeStored(stored) {
    const out = makeDefaultState();
    if (stored && typeof stored === "object") {
      let source = stored;
      if (stored.defaults && typeof stored.defaults === "object") {
        source = stored.defaults;
      }
      for (const key of Object.keys(out)) {
        if (source[key] !== undefined) {
          out[key] = source[key];
        }
      }
    }
    return sanitizeState(out);
  }

  function sanitizeState(s) {
    const d = FALLBACK_DEFAULTS;
    const out = {
      blurAmount: isFiniteNumber(s.blurAmount) ? s.blurAmount : d.blurAmount,
      widthPct: isFiniteNumber(s.widthPct) ? s.widthPct : d.widthPct,
      heightPct: isFiniteNumber(s.heightPct) ? s.heightPct : d.heightPct,
      xPct: isFiniteNumber(s.xPct) ? s.xPct : d.xPct,
      yPct: isFiniteNumber(s.yPct) ? s.yPct : d.yPct,
      active: typeof s.active === "boolean" ? s.active : d.active,
      follow: typeof s.follow === "boolean" ? s.follow : d.follow,
      shape: (typeof s.shape === 'string' && (s.shape === 'rectangle' || s.shape === 'ellipse')) ? s.shape : d.shape,
      mode: (typeof s.mode === 'string' && (s.mode === 'normal' || s.mode === 'reverse')) ? s.mode : d.mode,
    };
    out.blurAmount = clamp(out.blurAmount, 0, MAX_BLUR);
    out.widthPct = clamp(out.widthPct, MIN_SIZE_PCT, 1);
    out.heightPct = clamp(out.heightPct, MIN_SIZE_PCT, 1);
    out.xPct = clamp(out.xPct, 0, 1 - out.widthPct);
    out.yPct = clamp(out.yPct, 0, 1 - out.heightPct);
    return out;
  }

  function MosaicFilterSettingsPage() {
    const [loaded, setLoaded] = useState(false);
    const [state, setState] = useState(() => makeDefaultState());
    const [dirty, setDirty] = useState(false);
    const [saveError, setSaveError] = useState(null);

    useEffect(function () {
      let cancelled = false;
      (async function () {
        let stored = null;
        try {
          stored = await csLib.getConfiguration(CONFIG_KEY);
        } catch (err) {
          console.error("MosaicFilter settings: failed to read configuration", err);
        }
        if (cancelled) return;
        setState(mergeStored(stored));
        setLoaded(true);
      })();
      return function () { cancelled = true; };
    }, []);

    function updateField(patch) {
      setState(function (prev) {
        return sanitizeState(Object.assign({}, prev, patch));
      });
      setDirty(true);
    }

    async function save() {
      try {
        await csLib.setConfiguration(CONFIG_KEY, state);
        setSaveError(null);
        setDirty(false);
      } catch (err) {
        setSaveError(String((err && err.message) || err));
        console.error("MosaicFilter settings: save failed", err);
      }
    }

    if (!loaded) {
      return h("div", { className: "mosaic-filter-settings" },
        h("p", { className: "mosaic-filter-settings__loading" }, "Loading…")
      );
    }

    // Helper: a number-input row whose value is displayed as a percent.
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
            const pct = clamp(safe, minPct, maxPct) / 100;
            updateField({ [fieldKey]: pct });
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
          onChange: function (e) {
            updateField({ [fieldKey]: e.target.value });
          },
        },
          options.map(function (opt) {
            return h("option", { value: opt.value }, opt.label);
          })
        )
      );
    }

    return h("div", { className: "mosaic-filter-settings" },
      h("h1", null, "Mosaic Filter"),
      h("p", { className: "mosaic-filter-settings__intro" },
        "Place a draggable, resizable blur region over any scene. ",
        "Settings are global — the same filter is used on every scene. ",
        "Turn on Follow so the region tracks the cursor (the most common use case)."
      ),

      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Filter style"),
        h("p", { className: "mosaic-filter-settings__hint" },
          "Look and feel of the blur region."
        ),
        h("div", { className: "mosaic-filter-settings__row" },
          pixelField("Blur amount (px)", "blurAmount", 0, MAX_BLUR),
          selectField("Shape", "shape", [
            { value: "rectangle", label: "Rectangle" },
            { value: "ellipse", label: "Ellipse" },
          ]),
          selectField("Mode", "mode", [
            { value: "normal", label: "Normal — blur inside the filter" },
            { value: "reverse", label: "Reverse — blur everything else" },
          ]),
        ),
      ),

      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Geometry"),
        h("p", { className: "mosaic-filter-settings__hint" },
          "Default size and position on the player."
        ),
        h("div", { className: "mosaic-filter-settings__row" },
          percentField("Width (% of player)", "widthPct", Math.round(MIN_SIZE_PCT * 100), 100),
          percentField("Height (% of player)", "heightPct", Math.round(MIN_SIZE_PCT * 100), 100),
          percentField("Position X (% from left)", "xPct", 0, 100),
          percentField("Position Y (% from top)", "yPct", 0, 100),
        ),
      ),

      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Behavior"),
        h("p", { className: "mosaic-filter-settings__hint" },
          "Defaults when a scene starts."
        ),
        h("div", { className: "mosaic-filter-settings__row" },
          h("label", { className: "mosaic-filter-settings__checkbox" },
            h("input", {
              type: "checkbox",
              checked: !!state.active,
              onChange: function (e) { updateField({ active: !!e.target.checked }); },
            }),
            h("span", null, "Active by default")
          ),
          h("label", { className: "mosaic-filter-settings__checkbox" },
            h("input", {
              type: "checkbox",
              checked: !!state.follow,
              onChange: function (e) { updateField({ follow: !!e.target.checked }); },
            }),
            h("span", null, "Follow cursor by default")
          ),
        ),
        h("div", { className: "mosaic-filter-settings__actions" },
          h("button", {
            type: "button",
            className: "mosaic-filter-settings__button mosaic-filter-settings__button--primary",
            disabled: !dirty,
            onClick: save,
          }, "Save"),
          saveError ? h("span", { className: "mosaic-filter-settings__error" }, saveError) : null,
        ),
      ),
    );
  }

  // Route + launcher registration ----------------------------------------

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
    // SettingsToolsPanel.tsx renders the same PatchContainerComponent twice
    // in fixed order: 1st = general "Tools", 2nd = "Scene Tools". React
    // re-renders fire the pair in the same order, so parity (odd = Tools,
    // even = Scene Tools) is the correct gate. Assumption documented because
    // if Stash ever renders only one instance or swaps the order, the card
    // lands in the wrong section.
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
        h("p", null, "Default mosaic settings (applied to every scene)")
      )
    );
    const newChildren = Array.isArray(props.children)
      ? [...props.children, card]
      : [props.children, card];
    return [Object.assign({}, props, { children: newChildren })];
  });
})();
