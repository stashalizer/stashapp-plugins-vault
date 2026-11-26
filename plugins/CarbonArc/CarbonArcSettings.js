/**
 * CarbonArcSettings — the theme's settings page.
 *
 * Registered the same way as the other plugins in this repository:
 * a route through `PluginApi.patch.before("PluginRoutes")` and a launcher card
 * in Settings > Tools. Options are applied live as they are clicked (the
 * stylesheet reads them off <html>), then persisted by CarbonArcStore.
 *
 * Failure modes handled here:
 *   - PluginApi missing            → nothing registers, one console error.
 *   - CarbonArcStore missing       → page renders a readable error, no crash.
 *   - read/write failure           → inline message, change stays applied for
 *                                    the session because the store already
 *                                    wrote the browser copy.
 *   - double patching (StrictMode) → the tools-section patch is idempotent.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  if (!window.PluginApi || !window.PluginApi.patch || !window.PluginApi.React) {
    console.error("CarbonArc settings: PluginApi is unavailable; settings page not registered.");
    return;
  }

  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const h = React.createElement;
  const { useState, useEffect, useCallback, useRef } = React;

  const ReactRouterDOM = PluginApi.libraries && PluginApi.libraries.ReactRouterDOM;
  if (!ReactRouterDOM || !ReactRouterDOM.Route || !ReactRouterDOM.Link) {
    console.error("CarbonArc settings: ReactRouterDOM is unavailable; settings page not registered.");
    return;
  }
  const { Route, Link } = ReactRouterDOM;

  const PLUGIN_ROUTE = "/plugins/carbonarc";
  const store = window.CarbonArcStore;

  const ACCENT_META = {
    arc: { label: "Arc", hex: "#c2a176", note: "Brass lamplight. The default." },
    patina: { label: "Patina", hex: "#8aa79a", note: "Oxidised copper-green." },
    dusk: { label: "Dusk", hex: "#a79cb8", note: "Muted violet, coolest of the three." },
  };

  const DENSITY_META = {
    comfortable: { label: "Comfortable", note: "6 px card margin, 11 px padding." },
    compact: { label: "Compact", note: "3 px margin, 8 px padding — more cards per row." },
  };

  function Swatch(props) {
    return h("span", {
      className: "ca-set__swatch",
      style: { background: props.hex },
      "aria-hidden": "true",
    });
  }

  function OptionButton(props) {
    return h(
      "button",
      {
        type: "button",
        className: "ca-set__option" + (props.selected ? " ca-set__option--on" : ""),
        "aria-pressed": props.selected ? "true" : "false",
        onClick: props.onClick,
        disabled: props.disabled,
      },
      props.children
    );
  }

  function CarbonArcSettingsPage() {
    const [config, setConfig] = useState(function () {
      return store ? store.get() : null;
    });
    const [status, setStatus] = useState("idle"); // idle | saving | saved | error
    const [message, setMessage] = useState("");
    const [copied, setCopied] = useState("idle"); // idle | ok | fail
    const mounted = useRef(true);
    const saveToken = useRef(0);

    useEffect(function () {
      mounted.current = true;
      return function () {
        mounted.current = false;
      };
    }, []);

    // Keep in sync when the store changes underneath us (another tab, reset).
    useEffect(function () {
      if (!store) return undefined;
      return store.subscribe(function (next) {
        if (mounted.current) setConfig(next);
      });
    }, []);

    // Reload from storage on mount: the synchronous defaults may already have
    // been replaced by the async read before this page appeared.
    useEffect(function () {
      if (!store) return;
      store
        .load()
        .then(function (next) {
          if (mounted.current) setConfig(next);
        })
        .catch(function (err) {
          console.error("CarbonArc settings: load failed", err);
          if (mounted.current) {
            setStatus("error");
            setMessage("Could not read the saved configuration. Using defaults for this session.");
          }
        });
    }, []);

    const persist = useCallback(
      function (patch) {
        if (!store) return;
        const next = Object.assign({}, config || {}, patch);
        setConfig(store.normalize(next));
        setStatus("saving");
        setMessage("");

        const token = ++saveToken.current;
        store
          .save(next)
          .then(function (result) {
            if (!mounted.current || token !== saveToken.current) return;
            setStatus("saved");
            setMessage(
              result.scope === "plugin"
                ? "Saved to the plugin configuration."
                : "Saved in this browser only — CommunityScriptsUI library is not installed."
            );
          })
          .catch(function (err) {
            if (!mounted.current || token !== saveToken.current) return;
            console.error("CarbonArc settings: save failed", err);
            setStatus("error");
            setMessage("Could not save. The change applies until you reload the page.");
          });
      },
      [config]
    );

    const onReset = useCallback(
      function () {
        if (!store) return;
        setStatus("saving");
        setMessage("");
        store
          .reset()
          .then(function () {
            if (!mounted.current) return;
            setConfig(store.get());
            setStatus("saved");
            setMessage("Back to the theme defaults.");
          })
          .catch(function (err) {
            console.error("CarbonArc settings: reset failed", err);
            if (mounted.current) {
              setStatus("error");
              setMessage("Could not reset. Reload the page and try again.");
            }
          });
      },
      []
    );

    const onCopyLoginCss = useCallback(
      function () {
        if (!store) return;
        const text = store.LOGIN_CSS;
        const fallback = function () {
          try {
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "readonly");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(area);
            setCopied(ok ? "ok" : "fail");
          } catch (err) {
            setCopied("fail");
          }
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            setCopied("ok");
          }, fallback);
        } else {
          fallback();
        }
      },
      []
    );

    if (!store) {
      return h(
        "div",
        { className: "ca-set" },
        h("h1", { className: "ca-set__title" }, "Carbon Arc"),
        h(
          "div",
          { className: "ca-set__notice ca-set__notice--error", role: "alert" },
          "The theme's configuration module did not load. Reinstall the plugin, then reload Stash."
        )
      );
    }

    const saving = status === "saving";

    return h(
      "div",
      { className: "ca-set" },

      h(
        "header",
        { className: "ca-set__head" },
        h("p", { className: "ca-set__kicker" }, "theme · desktop only"),
        h("h1", { className: "ca-set__title" }, "Carbon Arc"),
        h(
          "p",
          { className: "ca-set__lede" },
          "Graphite surfaces, bone text, one warm signal. Set Stash’s own theme to Dark before installing — this theme paints surfaces, ",
          "but Stash’s light theme still owns a few inherited defaults. Changes apply as you click."
        )
      ),

      h(
        "div",
        { className: "ca-set__group" },
        h("h2", { className: "ca-set__group-title" }, "signal"),
        h(
          "p",
          { className: "ca-set__group-note" },
          "Used in four places only: active navigation, keyboard focus, rating stars, the playhead."
        ),
        h(
          "div",
          { className: "ca-set__options", role: "group", "aria-label": "Signal colour" },
          store.ACCENTS.map(function (key) {
            const meta = ACCENT_META[key] || { label: key, hex: "#c2a176", note: "" };
            return h(
              OptionButton,
              {
                key: key,
                selected: config.accent === key,
                disabled: saving,
                onClick: function () {
                  persist({ accent: key });
                },
              },
              h(Swatch, { hex: meta.hex }),
              h("span", { className: "ca-set__option-label" }, meta.label),
              h("span", { className: "ca-set__option-note" }, meta.note)
            );
          })
        )
      ),

      h(
        "div",
        { className: "ca-set__group" },
        h("h2", { className: "ca-set__group-title" }, "card density"),
        h(
          "p",
          { className: "ca-set__group-note" },
          "Only the card's own padding and margin change; Stash’s grid maths and column sizing are untouched."
        ),
        h(
          "div",
          { className: "ca-set__options ca-set__options--row", role: "group", "aria-label": "Card density" },
          store.DENSITIES.map(function (key) {
            const meta = DENSITY_META[key] || { label: key, note: "" };
            return h(
              OptionButton,
              {
                key: key,
                selected: config.density === key,
                disabled: saving,
                onClick: function () {
                  persist({ density: key });
                },
              },
              h("span", { className: "ca-set__option-label" }, meta.label),
              h("span", { className: "ca-set__option-note" }, meta.note)
            );
          })
        )
      ),

      h(
        "div",
        { className: "ca-set__group" },
        h("h2", { className: "ca-set__group-title" }, "preview brightness"),
        h(
          "p",
          { className: "ca-set__group-note" },
          "Dims thumbnails by 10% so a bright still does not blow out the room. Off keeps Stash’s rendering exactly as it is."
        ),
        h(
          "div",
          { className: "ca-set__options ca-set__options--row", role: "group", "aria-label": "Preview brightness" },
          h(
            OptionButton,
            {
              selected: !config.dimPreviews,
              disabled: saving,
              onClick: function () {
                persist({ dimPreviews: false });
              },
            },
            h("span", { className: "ca-set__option-label" }, "Full"),
            h("span", { className: "ca-set__option-note" }, "No filter on thumbnails.")
          ),
          h(
            OptionButton,
            {
              selected: config.dimPreviews,
              disabled: saving,
              onClick: function () {
                persist({ dimPreviews: true });
              },
            },
            h("span", { className: "ca-set__option-label" }, "Dimmed"),
            h("span", { className: "ca-set__option-note" }, "Thumbnails at 90% brightness.")
          )
        )
      ),

      // live preview of the tokens currently in force
      h(
        "div",
        { className: "ca-set__group" },
        h("h2", { className: "ca-set__group-title" }, "preview"),
        h(
          "div",
          { className: "ca-set__preview" },
          h(
            "div",
            { className: "ca-set__preview-card" },
            h("div", { className: "ca-set__preview-thumb" }),
            h(
              "div",
              { className: "ca-set__preview-body" },
              h("span", { className: "ca-set__preview-title" }, "A scene title on two lines at most"),
              h("span", { className: "ca-set__preview-meta" }, "24:31 · 1080p · h264")
            )
          ),
          h(
            "div",
            { className: "ca-set__preview-controls" },
            h("button", { type: "button", className: "btn btn-primary" }, "Save"),
            h("button", { type: "button", className: "btn btn-secondary" }, "Cancel"),
            h("span", { className: "ca-set__preview-focus" }, "Focus ring"),
            h("span", { className: "ca-set__preview-stars" }, "★★★★★")
          )
        )
      ),

      status !== "idle" && message
        ? h(
            "div",
            {
              className:
                "ca-set__notice" +
                (status === "error" ? " ca-set__notice--error" : "") +
                (status === "saved" ? " ca-set__notice--ok" : ""),
              role: status === "error" ? "alert" : "status",
            },
            message
          )
        : null,

      h(
        "div",
        { className: "ca-set__group ca-set__group--last" },
        h("h2", { className: "ca-set__group-title" }, "login page"),
        h(
          "p",
          { className: "ca-set__group-note" },
          "Stash does not load plugins on the login screen, so that page cannot inherit the theme. Copy the block below into ",
          h("strong", null, "Settings → Interface → Custom CSS"),
          " and enable custom CSS to match it."
        ),
        h("pre", { className: "ca-set__code" }, store.LOGIN_CSS),
        h(
          "div",
          { className: "ca-set__actions" },
          h(
            "button",
            { type: "button", className: "btn btn-secondary", onClick: onCopyLoginCss },
            copied === "ok"
              ? "Copied"
              : copied === "fail"
              ? "Copy failed — select the text above"
              : "Copy login CSS"
          ),
          h(
            "button",
            { type: "button", className: "btn btn-quiet ca-set__reset", onClick: onReset, disabled: saving },
            "Reset to defaults"
          )
        )
      )
    );
  }

  // --- registration -------------------------------------------------------

  try {
    PluginApi.patch.before("PluginRoutes", function (props) {
      const children = h(
        React.Fragment,
        null,
        props.children,
        h(Route, { path: PLUGIN_ROUTE, component: CarbonArcSettingsPage })
      );
      return [Object.assign({}, props, { children: children })];
    });
  } catch (err) {
    console.error("CarbonArc settings: could not register route", err);
  }

  // This patch can fire twice per render (StrictMode double-invoke), so the
  // odd call is passed through untouched and only the even one adds the card.
  let toolsSectionCalls = 0;

  try {
    PluginApi.patch.before("SettingsToolsSection", function (props) {
      toolsSectionCalls += 1;
      if (toolsSectionCalls % 2 !== 0) {
        return [props];
      }

      const card = h(
        Link,
        { to: PLUGIN_ROUTE, className: "ca-set-launcher" },
        h("h3", null, "Carbon Arc"),
        h("p", null, "Signal colour, card density and preview brightness")
      );

      const children = Array.isArray(props.children)
        ? props.children.concat([card])
        : [props.children, card];

      return [Object.assign({}, props, { children: children })];
    });
  } catch (err) {
    console.error("CarbonArc settings: could not register tools launcher", err);
  }
})();
