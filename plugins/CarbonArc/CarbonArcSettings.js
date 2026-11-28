/**
 * CarbonArcSettings — the option tiles inside Stash's own settings page.
 *
 * The options are declared in CarbonArc.yml under `settings:`, so Stash owns
 * the form: the values are saved by the plugin settings page itself
 * (`configurePlugin`) and read back by CarbonArcStore. That leaves exactly one
 * job here — Stash would draw every one of these as a button that opens a
 * text modal, and they are three or four choices, so the row is replaced with
 * colour/weight tiles and a brightness slider.
 *
 * The patch is narrow on purpose:
 *   - `patch.instead("StringSetting")` and it only takes over the ids
 *     `plugin-<id>-accent`, `plugin-<id>-density` and
 *     `plugin-<id>-previewbrightness`; every other string setting in Stash is
 *     handed straight back to the original renderer, with its arguments
 *     untouched.
 *   - A tile calls CarbonArcStore.preview() first, so the page repaints on
 *     click, then Stash's own onChange, which saves the value (Stash debounces
 *     that write by 500 ms — see `commitAt` for what that means for a drag).
 *   - Nothing is registered under Settings > Tools and no route is added: the
 *     theme adds no surface of its own.
 *
 * The brightness row is the one control here that cannot be a row of tiles:
 * it has a range, not a list. It is a slider plus an exact-value field over
 * four one-click presets, and each of them draws a sample at its own value,
 * because the grid itself is behind another route while this page is open —
 * the sample is the only place the change can be seen as it is made.
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

  /**
   * The one-click brightness presets, keyed by their percentage. The order and
   * the numbers themselves are the store's (`BRIGHTNESS_PRESETS`), so the
   * tiles, the slider's stops and the clamp in `normalize()` cannot drift into
   * disagreeing about the range; this table only adds the wording, and
   * tests/carbon-arc.test.mjs fails if a preset has no entry. "−10%" is the
   * old `dimmed` value, kept because an existing install that wanted a nudge
   * still does.
   */
  var BRIGHTNESS_META = {
    100: { label: "Full", note: "100% · no filter." },
    90: { label: "−10%", note: "90% · what Dimmed was." },
    75: { label: "−25%", note: "75% · clearly darker." },
    50: { label: "−50%", note: "50% · half the light." },
  };

  var CHOICES = {
    accent: store.ACCENTS,
    density: store.DENSITIES,
  };

  var META = {
    accent: ACCENT_META,
    density: DENSITY_META,
  };

  /** Which of our settings a Stash setting id belongs to, or null. */
  function settingKey(id) {
    var value = String(id == null ? "" : id).toLowerCase();
    if (value.indexOf(PREFIX) !== 0) return null;
    var key = value.slice(PREFIX.length);
    if (key === "accent") return "accent";
    if (key === "density") return "density";
    if (key === "previewbrightness") return "previewBrightness";
    return null;
  }

  /** The value in force, read from the store so it matches what is painted. */
  function paintedValue(key) {
    var config = store.get();
    if (key === "accent") return config.accent;
    if (key === "density") return config.density;
    return config.previewBrightness;
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

  /* --- preview brightness ------------------------------------------------ */

  /**
   * The filter number for a percentage. Three decimals is more than CSS needs
   * and fewer than a float can drift into: 0.9, 0.75, 0.5 rather than
   * 0.8999999999999999, which is what `percent / 100` produces for 90.
   */
  function ratioOf(percent) {
    return Number((store.snapBrightness(percent) / 100).toFixed(3));
  }

  /**
   * A specimen thumbnail: the gradient lives in CarbonArcSettings.css, so a
   * preset tile and the slider's own stage can show the same image at
   * different brightness. This is how the option is judged while it is being
   * set — the grid is on another route.
   */
  function Sample(props) {
    return h("span", {
      className: "ca-bright__sample" + (props.large ? " ca-bright__sample--lg" : ""),
      style: { filter: "brightness(" + ratioOf(props.percent) + ")" },
      "aria-hidden": "true",
    });
  }

  /**
   * Presets, a slider and an exact-value field over the same number.
   *
   * Three different write paths, on purpose:
   *   - `previewAt` repaints and nothing else. It runs on every step of a
   *     drag, so it skips both the localStorage mirror and Stash's onChange
   *     (`savePluginSettings` re-renders the whole plugin settings panel and
   *     schedules a `configurePlugin` write — fine once per gesture, not once
   *     per pixel).
   *   - `commitAt` repaints, mirrors to localStorage and hands the value to
   *     Stash. The slider calls it on pointer release, key release and blur
   *     (all three fire for one gesture; repeating it is harmless), the
   *     presets on click, and the text field as soon as what was typed is a
   *     legal percentage — a typed value has no "release" event, and Stash's
   *     own text fields save per keystroke, debounced by half a second.
   *   - The text field keeps what was typed in `draft` until the value is
   *     legal again, so "5" on the way to "50" does not snap the field to 20
   *     mid-word; blur puts the painted value back.
   *
   * The value is read from the store on every render, never from props and
   * never from local state: this row's job is to show what the page is
   * painted at. Stash's own field for the setting starts empty (`value=""`),
   * and the row mounts before the GraphQL read lands — both are reasons a
   * local copy would drift from the thumbnails. `Tiles` subscribes to the
   * store, so an update from any source redraws the row.
   */
  function Brightness(props) {
    var limits = store.BRIGHTNESS;
    var value = store.get().previewBrightness;
    var typedPair = useState(null);
    var draft = typedPair[0];
    var setDraft = typedPair[1];

    var hintId = String((props.source && props.source.id) || "ca-brightness") + "-hint";

    /* Where the thumb sits on the track, as a percentage of the *range* rather
       than of 100: at 20 % the thumb belongs at the far left. The sheet turns
       this into the travelled part of the webkit track. */
    var fill = ((value - limits.min) / (limits.max - limits.min)) * 100;

    function paint(next, cache) {
      var snapped = store.snapBrightness(next);
      // The store notifies, `Tiles` re-renders, this row redraws: one source
      // of truth, and the sample is never a step behind the page.
      store.preview({ previewBrightness: snapped }, { cache: cache });
      return snapped;
    }

    function previewAt(next) {
      return paint(next, false);
    }

    function commitAt(next) {
      var snapped = paint(next, true);
      if (props.source && typeof props.source.onChange === "function") {
        props.source.onChange(String(snapped));
      }
      return snapped;
    }

    /* The settle handlers read the store rather than this render's `value`:
       a pointerup lands after the last input event, in a render that may not
       have been committed yet. */
    function settle() {
      setDraft(null);
      commitAt(store.get().previewBrightness);
    }

    function choosePreset(preset) {
      setDraft(null);
      commitAt(preset);
    }

    function onSlide(event) {
      previewAt(event.target.value);
    }

    function onType(event) {
      var raw = event.target.value;
      setDraft(raw);
      if (raw.trim() === "") return;
      var number = Number(raw);
      if (!isFinite(number) || number < limits.min || number > limits.max) return;
      commitAt(number);
    }

    function onTypeKey(event) {
      if (event.key === "Enter") settle();
    }

    return h(
      "div",
      { className: "ca-bright" },

      h(
        "div",
        { className: "ca-tiles ca-tiles--bright", role: "group", "aria-label": "Preview brightness presets" },
        store.BRIGHTNESS_PRESETS.map(function (preset) {
          var meta = BRIGHTNESS_META[preset] || { label: preset + "%", note: "" };
          var on = value === preset;
          return h(
            "button",
            {
              key: preset,
              type: "button",
              className: "ca-tile ca-tile--bright" + (on ? " ca-tile--on" : ""),
              "aria-pressed": on ? "true" : "false",
              onClick: function () {
                choosePreset(preset);
              },
            },
            h(Sample, { percent: preset }),
            h("span", { className: "ca-tile__label" }, meta.label),
            h("span", { className: "ca-tile__note" }, meta.note)
          );
        })
      ),

      h(
        "div",
        { className: "ca-bright__row" },
        h(Sample, { percent: value, large: true }),

        h(
          "div",
          { className: "ca-bright__controls" },
          h("input", {
            type: "range",
            className: "ca-bright__range",
            min: limits.min,
            max: limits.max,
            step: limits.step,
            value: value,
            style: { "--ca-fill": String(fill) + "%" },
            "aria-label": "Preview brightness",
            "aria-valuetext": value + "% of full brightness",
            "aria-describedby": hintId,
            onChange: onSlide,
            onPointerUp: settle,
            onKeyUp: settle,
            onBlur: settle,
          }),
          h(
            "div",
            { className: "ca-bright__scale" },
            h("span", null, limits.min + "%"),
            h("span", null, limits.max + "%")
          )
        ),

        h(
          "div",
          { className: "ca-bright__exact" },
          h("input", {
            type: "number",
            className: "ca-bright__number",
            min: limits.min,
            max: limits.max,
            step: limits.step,
            value: draft === null ? String(value) : draft,
            "aria-label": "Preview brightness, exact value",
            "aria-describedby": hintId,
            onChange: onType,
            onKeyDown: onTypeKey,
            onBlur: settle,
          }),
          h("span", { className: "ca-bright__unit" }, "%")
        )
      ),

      h(
        "p",
        { className: "ca-bright__hint", id: hintId },
        "Default " + store.DEFAULTS.previewBrightness + "% · range " + limits.min + "–" + limits.max +
          "% · step " + limits.step + "%"
      )
    );
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

    // One subscription per mounted row: the store is the source of truth for
    // what the page is painted at, so the row redraws whenever it changes —
    // the GraphQL read landing after first paint, a drag in this row, or a
    // change made in another tab. `refreshed` keeps the read itself to one
    // per page, since three rows mount together.
    var tickPair = useState(0);
    var bump = tickPair[1];
    useEffect(function () {
      var stop = store.subscribe(function () {
        bump(function (n) {
          return n + 1;
        });
      });
      if (!refreshed) {
        refreshed = true;
        store.refresh();
      }
      return stop;
    }, []);

    function choose(value) {
      var patch = {};
      patch[key] = value;

      store.preview(patch);
      if (props.source && typeof props.source.onChange === "function") {
        props.source.onChange(value);
      }
    }

    var body;
    if (key === "previewBrightness") {
      body = h(Brightness, { source: props.source });
    } else {
      body = h(
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
      );
    }

    return h(
      "div",
      { className: "setting", id: props.source.id },
      h(
        "div",
        { className: "ca-field" },
        h("h3", null, props.source.heading),
        props.source.subHeading ? h("div", { className: "sub-heading" }, props.source.subHeading) : null,
        body,
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
