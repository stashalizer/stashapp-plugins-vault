/**
 * CarbonArcSettings — the option tiles inside Stash's own settings page.
 *
 * The options are declared in CarbonArc.yml under `settings:`, so Stash owns
 * the form: the values are saved by the plugin settings page itself
 * (`configurePlugin`) and read back by CarbonArcStore. That leaves exactly one
 * job here — Stash would draw `accent` and `density` as a button that opens a
 * text modal, and these are three or four choices, so the row is replaced with
 * colour/weight tiles.
 *
 * The patch is narrow on purpose:
 *   - `patch.instead("StringSetting")` and it only takes over the ids
 *     `plugin-<id>-accent`, `plugin-<id>-density` and `plugin-<id>-dimpreviews`;
 *     every other string setting in Stash is handed straight back to the
 *     original renderer, with its arguments untouched.
 *   - A tile calls CarbonArcStore.preview() first, so the page repaints on
 *     click, then Stash's own onChange, so the value is saved exactly as if it
 *     had been typed into the field it replaced.
 *   - Nothing is registered under Settings > Tools and no route is added: the
 *     theme adds no surface of its own.
 *
 * Failure modes handled here: PluginApi missing, CarbonArcStore missing, a
 * clipboard that refuses to work. Each leaves Stash's own settings working.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var api = window.PluginApi;
  if (!api || !api.patch || typeof api.patch.instead !== "function" || !api.React) {
    console.error("CarbonArc settings: PluginApi is unavailable; the option tiles are not registered.");
    return;
  }

  var store = window.CarbonArcStore;
  if (!store) {
    console.error("CarbonArc settings: CarbonArcStore did not load; the option tiles are not registered.");
    return;
  }

  var React = api.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;

  var PREFIX = "plugin-" + String(store.PLUGIN_ID).toLowerCase() + "-";

  var ACCENT_META = {
    arc: { label: "Arc", note: "Brass lamplight. The default." },
    patina: { label: "Patina", note: "Oxidised copper-green." },
    dusk: { label: "Dusk", note: "Muted violet, coolest of the three." },
    custom: { label: "Custom", note: "Needs a hex below; stays on Arc until then." },
  };

  var DENSITY_META = {
    comfortable: { label: "Comfortable", note: "6 px card margin, 11 px padding." },
    compact: { label: "Compact", note: "3 px margin, 8 px padding — same columns." },
  };

  var DIM_META = {
    full: { label: "Full", note: "No filter on thumbnails." },
    dimmed: { label: "Dimmed", note: "Thumbnails at 90% brightness." },
  };

  var CHOICES = {
    accent: store.ACCENTS,
    density: store.DENSITIES,
    dimPreviews: ["full", "dimmed"],
  };

  var META = {
    accent: ACCENT_META,
    density: DENSITY_META,
    dimPreviews: DIM_META,
  };

  /** Which of our settings a Stash setting id belongs to, or null. */
  function settingKey(id) {
    var value = String(id == null ? "" : id).toLowerCase();
    if (value.indexOf(PREFIX) !== 0) return null;
    var key = value.slice(PREFIX.length);
    if (key === "accent") return "accent";
    if (key === "density") return "density";
    if (key === "dimpreviews") return "dimPreviews";
    return null;
  }

  /** The value in force, read from the store so it matches what is painted. */
  function paintedValue(key) {
    var config = store.get();
    if (key === "accent") return config.accent;
    if (key === "density") return config.density;
    return config.dimPreviews ? "dimmed" : "full";
  }

  function Swatch(props) {
    var config = store.get();
    var colour = props.value === "custom" ? config.customSignal : (store.ACCENT_COLORS[props.value] || {}).hex;
    return h("span", {
      className: "ca-tile__swatch" + (colour ? "" : " ca-tile__swatch--empty"),
      style: colour ? { background: colour } : undefined,
      "aria-hidden": "true",
    });
  }

  function LoginBlock() {
    var pair = useState("idle"); // idle | ok | fail
    var copied = pair[0];
    var setCopied = pair[1];
    var css = store.loginCss(store.get());

    function fallback() {
      try {
        var area = document.createElement("textarea");
        area.value = css;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(area);
        setCopied(ok ? "ok" : "fail");
      } catch (err) {
        setCopied("fail");
      }
    }

    function onCopy() {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(css).then(function () {
          setCopied("ok");
        }, fallback);
      } else {
        fallback();
      }
    }

    return h(
      "details",
      { className: "ca-login" },
      h("summary", null, "Login page CSS"),
      h(
        "p",
        { className: "ca-login__note" },
        "Stash does not load plugins on the sign-in screen. Copy this block into ",
        h("strong", null, "Settings → Interface → Custom CSS"),
        " and tick “Custom CSS enabled”. Every rule is scoped to ",
        h("code", null, "body.login"),
        ", so it changes nothing in the app. It is rebuilt from the signal colour above, ",
        "and it cannot load the bundled font on a logged-out page — that page falls back to the system UI font."
      ),
      h("pre", { className: "ca-login__code" }, css),
      h(
        "div",
        { className: "ca-login__actions" },
        h(
          "button",
          { type: "button", className: "btn btn-secondary", onClick: onCopy },
          copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed — select the text above" : "Copy login CSS"
        )
      )
    );
  }

  var refreshed = false;

  function Tiles(props) {
    var key = props.settingKey;
    var selected = paintedValue(key);

    // Stash has just saved something we cannot see yet (another tab, or a
    // colour typed into its own field): one read per page keeps the tiles and
    // the painted theme telling the same story. Three rows mount, so it runs
    // once, not once per row.
    useEffect(function () {
      if (refreshed) return;
      refreshed = true;
      store.refresh();
    }, []);

    function choose(value) {
      var patch = {};
      if (key === "dimPreviews") patch.dimPreviews = value === "dimmed";
      else patch[key] = value;

      store.preview(patch);
      if (props.source && typeof props.source.onChange === "function") {
        props.source.onChange(value);
      }
    }

    return h(
      "div",
      { className: "setting", id: props.source.id },
      h(
        "div",
        { className: "ca-field" },
        h("h3", null, props.source.heading),
        props.source.subHeading ? h("div", { className: "sub-heading" }, props.source.subHeading) : null,
        h(
          "div",
          { className: "ca-tiles", role: "group", "aria-label": props.source.heading || key },
          CHOICES[key].map(function (value) {
            var meta = META[key][value] || { label: value, note: "" };
            var on = selected === value;
            return h(
              "button",
              {
                key: value,
                type: "button",
                className: "ca-tile" + (on ? " ca-tile--on" : ""),
                "aria-pressed": on ? "true" : "false",
                onClick: function () {
                  choose(value);
                },
              },
              key === "accent" ? h(Swatch, { value: value }) : null,
              h("span", { className: "ca-tile__label" }, meta.label),
              h("span", { className: "ca-tile__note" }, meta.note)
            );
          })
        ),
        key === "accent" ? h(LoginBlock) : null
      )
    );
  }

  /* --- registration ------------------------------------------------------ */

  try {
    api.patch.instead("StringSetting", function () {
      var args = Array.prototype.slice.call(arguments);
      // patch.tsx appends the next renderer to the argument list; it is the
      // last one, and it must be called with the same arguments for Stash's
      // own rows.
      var original = args.pop();
      var source = args[0] || {};
      var key = settingKey(source.id);

      if (!key) return original.apply(null, args);
      return h(Tiles, { settingKey: key, source: source });
    });
  } catch (err) {
    console.error("CarbonArc settings: could not register the option tiles", err);
  }
})();
