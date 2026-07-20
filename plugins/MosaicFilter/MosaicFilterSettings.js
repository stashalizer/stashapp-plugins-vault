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
 * - Reads/writes the same config key ("MosaicFilter") as the overlay. Both
 *   surfaces maintain separate save locks and do not coordinate; this is
 *   the same trade-off QuestingAdventurer makes.
 * - Three sections: Defaults (form), Saved Scenes (per-scene list with
 *   delete), Danger Zone (clear-all with confirm).
 */
(function () {
  "use strict";

  if (!window.PluginApi || !window.csLib) {
    console.error("MosaicFilter settings: PluginApi or csLib missing");
    return;
  }

  const React = PluginApi.React;
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const { Route, Link } = PluginApi.libraries.ReactRouterDOM;

  const csLib = window.csLib;
  const CONFIG_KEY = "MosaicFilter";
  const PLUGIN_ROUTE = "/plugins/mosaicfilter";

  // Same field clamps as the overlay. Centralized here so the two surfaces
  // agree on what "valid" means.
  const MIN_SIZE_PCT = 0.05;
  const MAX_BLUR = 80;

  const FALLBACK_DEFAULTS = {
    blurAmount: 24,
    widthPct: 0.25,
    heightPct: 0.25,
    xPct: 0.1,
    yPct: 0.1,
    active: true,
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

  function sanitizeDefaults(input) {
    const d = input || {};
    return {
      blurAmount: clamp(
        isFiniteNumber(d.blurAmount) ? d.blurAmount : FALLBACK_DEFAULTS.blurAmount,
        0,
        MAX_BLUR
      ),
      widthPct: clamp(
        isFiniteNumber(d.widthPct) ? d.widthPct : FALLBACK_DEFAULTS.widthPct,
        MIN_SIZE_PCT,
        1
      ),
      heightPct: clamp(
        isFiniteNumber(d.heightPct) ? d.heightPct : FALLBACK_DEFAULTS.heightPct,
        MIN_SIZE_PCT,
        1
      ),
      xPct: clamp(
        isFiniteNumber(d.xPct) ? d.xPct : FALLBACK_DEFAULTS.xPct,
        0,
        1
      ),
      yPct: clamp(
        isFiniteNumber(d.yPct) ? d.yPct : FALLBACK_DEFAULTS.yPct,
        0,
        1
      ),
      active: typeof d.active === "boolean" ? d.active : FALLBACK_DEFAULTS.active,
    };
  }

  function mergeStored(stored) {
    const out = {
      defaults: sanitizeDefaults(stored && stored.defaults),
      scenes: {},
    };
    if (stored && stored.scenes && typeof stored.scenes === "object") {
      for (const id of Object.keys(stored.scenes)) {
        const entry = stored.scenes[id];
        if (entry && typeof entry === "object") {
          out.scenes[id] = sanitizeSceneEntry(entry, out.defaults);
        }
      }
    }
    return out;
  }

  function sanitizeSceneEntry(entry, defaults) {
    const d = defaults || FALLBACK_DEFAULTS;
    const base = sanitizeDefaults(entry);
    // Clamp position so the rectangle stays on screen even after a save from
    // a smaller player size.
    base.xPct = clamp(base.xPct, 0, 1 - base.widthPct);
    base.yPct = clamp(base.yPct, 0, 1 - base.heightPct);
    return base;
  }

  // Save lock — coalesces concurrent saves by queuing attempts and draining
  // them serially. Each `saveNow(state)` call returns a promise that resolves
  // (or rejects) only when that specific attempt has been written. New
  // attempts added while the drain is running are appended to the queue.
  let saving = false;
  const pendingAttempts = [];

  function saveNow(state) {
    return new Promise(function (resolve, reject) {
      pendingAttempts.push({ state: state, resolve: resolve, reject: reject });
      drainAttempts();
    });
  }

  async function drainAttempts() {
    if (saving) return;
    saving = true;
    try {
      while (pendingAttempts.length > 0) {
        const attempt = pendingAttempts.shift();
        try {
          await csLib.setConfiguration(CONFIG_KEY, attempt.state);
          attempt.resolve(true);
        } catch (err) {
          attempt.reject(err);
        }
      }
    } finally {
      saving = false;
    }
  }

  function MosaicFilterSettingsPage() {
    const [loaded, setLoaded] = useState(false);
    const [defaults, setDefaults] = useState(() => sanitizeDefaults(null));
    const [scenes, setScenes] = useState({});
    const [dirty, setDirty] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const loadedRef = useRef(false);

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
        const merged = mergeStored(stored);
        setDefaults(merged.defaults);
        setScenes(merged.scenes);
        setLoaded(true);
        loadedRef.current = true;
      })();
      return function () { cancelled = true; };
    }, []);

    // Helpers ------------------------------------------------------------

    function updateDefaults(patch) {
      setDefaults(function (prev) {
        const next = sanitizeDefaults(Object.assign({}, prev, patch));
        return next;
      });
      setDirty(true);
    }

    function buildFullState(nextDefaults, nextScenes) {
      return { defaults: nextDefaults, scenes: nextScenes };
    }

    // Route all writes through the module-level save lock so concurrent
    // clicks (e.g. two rapid Delete buttons) cannot interleave their
    // `setConfiguration` calls.
    async function persist(nextDefaults, nextScenes) {
      try {
        await saveNow(buildFullState(nextDefaults, nextScenes));
        setSaveError(null);
        setDirty(false);
      } catch (err) {
        setSaveError(String((err && err.message) || err));
        console.error("MosaicFilter settings: save failed", err);
      }
    }

    function saveDefaults() {
      persist(defaults, scenes);
    }

    function deleteScene(id) {
      // Build the next scenes map once, then commit it through both React
      // state and the save lock. Avoids the previous dual update where the
      // functional updater and the persist call could disagree.
      const next = Object.assign({}, scenes);
      delete next[id];
      setScenes(next);
      persist(defaults, next);
    }

    function clearAll() {
      const confirmed = window.confirm(
        "Delete saved mosaic data for all scenes? " +
        "Each scene will revert to the current defaults on next visit."
      );
      if (!confirmed) return;
      setScenes({});
      persist(defaults, {});
    }

    // Rendering ----------------------------------------------------------

    if (!loaded) {
      return h("div", { className: "mosaic-filter-settings" },
        h("p", { className: "mosaic-filter-settings__loading" }, "Loading…")
      );
    }

    // Helper: a number-input row whose value is displayed as a percent.
    // `fieldKey` is the key on the defaults object (e.g. "widthPct"); the
    // displayed value is `Math.round(defaults[fieldKey] * 100)` and the
    // onChange converts the entered number back to a fraction and applies
    // the supplied clamp. `minPct`/`maxPct` are in 0..100.
    function percentField(label, fieldKey, minPct, maxPct) {
      return h("label", null,
        h("span", null, label),
        h("input", {
          type: "number",
          min: minPct,
          max: maxPct,
          step: 1,
          value: Math.round(defaults[fieldKey] * 100),
          onChange: function (e) {
            const v = parseInt(e.target.value, 10);
            const safe = isNaN(v) ? minPct : v;
            const pct = clamp(safe, minPct, maxPct) / 100;
            updateDefaults({ [fieldKey]: pct });
          },
        })
      );
    }

    // Helper: a plain pixel number-input (no percent conversion).
    function pixelField(label, fieldKey, min, max) {
      return h("label", null,
        h("span", null, label),
        h("input", {
          type: "number",
          min: min,
          max: max,
          step: 1,
          value: defaults[fieldKey],
          onChange: function (e) {
            const v = parseInt(e.target.value, 10);
            updateDefaults({ [fieldKey]: clamp(isNaN(v) ? min : v, min, max) });
          },
        })
      );
    }

    const sceneIds = Object.keys(scenes).sort(function (a, b) {
      // Numeric sort when possible so scene ids read in natural order.
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });

    return h("div", { className: "mosaic-filter-settings" },
      h("h1", null, "Mosaic Filter"),
      h("p", { className: "mosaic-filter-settings__intro" },
        "Place a draggable, resizable blur rectangle over any region of a scene. ",
        "Each scene remembers its own position, size, and blur amount."
      ),

      // Defaults --------------------------------------------------------
      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Defaults"),
        h("p", { className: "mosaic-filter-settings__hint" },
          "Applied to scenes that don't yet have their own saved mosaic."
        ),
        h("div", { className: "mosaic-filter-settings__row" },
          pixelField("Blur amount (px)", "blurAmount", 0, MAX_BLUR),
          percentField("Width (% of player)", "widthPct",
            Math.round(MIN_SIZE_PCT * 100), 100),
          percentField("Height (% of player)", "heightPct",
            Math.round(MIN_SIZE_PCT * 100), 100),
        ),
        h("div", { className: "mosaic-filter-settings__row" },
          percentField("Position X (% from left)", "xPct", 0, 100),
          percentField("Position Y (% from top)", "yPct", 0, 100),
          h("label", { className: "mosaic-filter-settings__checkbox" },
            h("input", {
              type: "checkbox",
              checked: !!defaults.active,
              onChange: function (e) { updateDefaults({ active: !!e.target.checked }); },
            }),
            h("span", null, "Active by default")
          ),
        ),
        h("div", { className: "mosaic-filter-settings__actions" },
          h("button", {
            type: "button",
            className: "mosaic-filter-settings__button mosaic-filter-settings__button--primary",
            disabled: !dirty,
            onClick: saveDefaults,
          }, "Save defaults"),
          saveError ? h("span", { className: "mosaic-filter-settings__error" }, saveError) : null,
        ),
      ),

      // Saved scenes ---------------------------------------------------
      h("section", { className: "mosaic-filter-settings__section" },
        h("h2", null, "Saved scenes"),
        sceneIds.length === 0
          ? h("p", { className: "mosaic-filter-settings__empty" },
              "No scenes have saved mosaic data yet. Open a scene to set one up.")
          : h("ul", { className: "mosaic-filter-settings__scene-list" },
              sceneIds.map(function (id) {
                const s = scenes[id];
                return h("li", {
                  key: id,
                  className: "mosaic-filter-settings__scene-item",
                },
                  h("div", { className: "mosaic-filter-settings__scene-info" },
                    h("code", { className: "mosaic-filter-settings__scene-id" }, "Scene " + id),
                    h("span", { className: "mosaic-filter-settings__scene-meta" },
                      s.blurAmount + "px blur · " +
                      Math.round(s.widthPct * 100) + "% × " +
                      Math.round(s.heightPct * 100) + "% · " +
                      (s.active ? "active" : "off")
                    ),
                  ),
                  h("div", { className: "mosaic-filter-settings__scene-actions" },
                    h(Link, {
                      to: "/scenes/" + id,
                      className: "mosaic-filter-settings__button",
                    }, "Open"),
                    h("button", {
                      type: "button",
                      className: "mosaic-filter-settings__button mosaic-filter-settings__button--danger",
                      onClick: function () { deleteScene(id); },
                    }, "Delete"),
                  ),
                );
              })
            ),
      ),

      // Danger zone ----------------------------------------------------
      h("section", { className: "mosaic-filter-settings__section mosaic-filter-settings__section--danger" },
        h("h2", null, "Danger zone"),
        h("p", { className: "mosaic-filter-settings__hint" },
          "Delete saved mosaic data for every scene."
        ),
        h("button", {
          type: "button",
          className: "mosaic-filter-settings__button mosaic-filter-settings__button--danger",
          onClick: clearAll,
          disabled: sceneIds.length === 0,
        }, "Clear all saved scenes"),
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
        h("p", null, "Default mosaic settings and saved scenes")
      )
    );
    const newChildren = Array.isArray(props.children)
      ? [...props.children, card]
      : [props.children, card];
    return [Object.assign({}, props, { children: newChildren })];
  });
})();
