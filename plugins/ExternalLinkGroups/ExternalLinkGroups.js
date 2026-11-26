/**
 * ExternalLinkGroups — detail-page buttons for user-configured external links.
 *
 * Injection point: `ExternalLinkButtons` (PatchComponent, v0.32.0), rendered by
 * `Performer.tsx`, `Studio.tsx` and `Group.tsx` inside `<span class="name-icons">`
 * in the detail title. Patching that one component covers all three pages and
 * anything else that reuses it — there is no per-page code here.
 *
 * Why `instead` and not `before`: `patch.before` transforms the **arguments** of
 * a render function (`args = beforeFn.apply(...)` in patch.tsx), it does not
 * inject elements. `instead` receives the original call arguments plus the rest
 * of the chain appended as the **last** argument (patch.tsx `runInstead`:
 * `fns[0].apply(thisArg, argArray.concat(next()))`). That last argument is the
 * original render function itself — not a factory that returns it. It has to be
 * called *with* props: `original()` renders Stash's `({ urls }) => …` with
 * `undefined` and throws "Cannot destructure property 'urls' of 'undefined'".
 *
 * The original renderer is called on **every** render, from a fixed position
 * after our hooks: it contains a `useMemo`, so skipping it on the first paint
 * (while the config loads) and calling it on the second would change this
 * component's hook count and crash React. It receives the URLs we did not claim
 * and therefore keeps Stash's own grouping — the generic link icon, the Twitter
 * and Instagram groups — for everything unconfigured or disabled.
 *
 * Click behaviour is per group: one URL opens in a new tab directly, several
 * URLs open a dropdown listing them. That mirrors Stash's own `openIfSingle`
 * rule, applied per configured site instead of per icon.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch || !PluginApi.React) {
    console.error("ExternalLinkGroups: PluginApi unavailable; detail-page buttons not patched.");
    return;
  }

  var React = PluginApi.React;
  var h = React.createElement;
  var S = window.ExternalLinkGroupsShared;
  var Store = window.ExternalLinkGroupsStore;
  var Icons = window.ExternalLinkGroupsIcons;

  if (!S || !Store || !Icons) {
    console.error("ExternalLinkGroups: shared/store/icon modules missing; detail-page buttons not patched.");
    return;
  }

  var Bootstrap = PluginApi.libraries && PluginApi.libraries.Bootstrap;
  var faLink =
    PluginApi.libraries &&
    PluginApi.libraries.FontAwesomeSolid &&
    PluginApi.libraries.FontAwesomeSolid.faLink;
  var ReactDOM = PluginApi.ReactDOM;
  var StashIcon = PluginApi.components && PluginApi.components.Icon;

  var hasDropdown = !!(Bootstrap && Bootstrap.Dropdown && Bootstrap.Dropdown.Toggle && ReactDOM);

  function useConfig() {
    var pair = React.useState(function () {
      return Store.get();
    });
    var setConfig = pair[1];

    React.useEffect(function () {
      var unsubscribe = Store.subscribe(setConfig);
      Store.load()
        .then(setConfig)
        .catch(function (err) {
          console.error("ExternalLinkGroups: config load failed", err);
        });
      return unsubscribe;
    }, []);

    return pair[0];
  }

  /** Re-render when any icon resolves; kick off a resolve for this domain. */
  function useIconEntry(domain) {
    var pair = React.useState(0);
    var bump = pair[1];

    React.useEffect(function () {
      return Icons.subscribe(function () {
        bump(function (n) {
          return n + 1;
        });
      });
    }, []);

    React.useEffect(
      function () {
        if (!domain) return;
        Icons.ensure(domain);
      },
      [domain]
    );

    return domain ? Icons.get(domain) : null;
  }

  function LinkIcon(props) {
    var entry = useIconEntry(props.domain);

    if (entry && entry.ok) {
      return h("img", {
        className: "elg-icon",
        src: entry.src,
        alt: "",
        width: 16,
        height: 16,
        loading: "lazy",
        decoding: "async",
        referrerPolicy: "no-referrer",
        onError: function () {
          // Blacklist this source, then immediately start the next candidate:
          // the icon effect below only re-runs when the domain changes, so
          // without the explicit retry a broken icon would stay a letter tile.
          Icons.reportBroken(props.domain, entry.src);
          Icons.ensure(props.domain);
        },
      });
    }

    // No working source (yet): a letter tile keeps the row aligned and still
    // says which site the button belongs to.
    return h(
      "span",
      { className: "elg-letter", "aria-hidden": "true" },
      String(props.domain || "?").charAt(0).toUpperCase()
    );
  }

  function GenericIcon() {
    if (StashIcon && faLink) return h(StashIcon, { icon: faLink });
    return h("span", { className: "elg-letter", "aria-hidden": "true" }, "\u2197");
  }

  function Menu(props) {
    return ReactDOM.createPortal(
      h(
        Bootstrap.Dropdown.Menu,
        null,
        props.urls.map(function (url) {
          return h(
            Bootstrap.Dropdown.Item,
            {
              key: url,
              as: "a",
              href: S.toHref(url) || "#",
              target: "_blank",
              rel: "noopener noreferrer",
              title: url,
            },
            url
          );
        })
      ),
      document.body
    );
  }

  /**
   * One button for one group of URLs.
   *
   * `single` opens the target directly (Stash's own rule for a one-link group);
   * anything else opens the list. `domain` drives the icon: configured sites get
   * their favicon, the shared bucket gets the generic link glyph because it has
   * no single domain to represent.
   */
  function LinkButton(props) {
    var urls = props.urls;
    var label =
      urls.length === 1
        ? "Open " + (props.domain || props.name) + " profile"
        : (props.domain || props.name) + ": " + urls.length + " links";

    var face = props.domain
      ? h(LinkIcon, { domain: props.domain })
      : h(GenericIcon, null);

    if (urls.length === 1) {
      return h(
        "a",
        {
          className: "external-links-button-link minimal btn link elg-button",
          href: S.toHref(urls[0]) || "#",
          target: "_blank",
          rel: "noopener noreferrer",
          title: urls[0],
          "aria-label": label,
        },
        face
      );
    }

    if (!hasDropdown) {
      // React Bootstrap missing is not a situation the plugin can style around;
      // link the first target rather than render nothing.
      return h(
        "a",
        {
          className: "external-links-button-link minimal btn link elg-button",
          href: S.toHref(urls[0]) || "#",
          target: "_blank",
          rel: "noopener noreferrer",
          title: urls.join("\n"),
          "aria-label": label,
        },
        face
      );
    }

    return h(
      Bootstrap.Dropdown,
      { className: "external-links-button elg-button" },
      h(
        Bootstrap.Dropdown.Toggle,
        {
          as: Bootstrap.Button,
          className: "minimal link elg-toggle",
          "aria-label": label,
          title: label,
        },
        face,
        h("span", { className: "elg-count", "aria-hidden": "true" }, String(urls.length))
      ),
      h(Menu, { urls: urls })
    );
  }

  /**
   * The replacement for Stash's `ExternalLinkButtons`.
   *
   * `renderOriginal` is the original render function, invoked with props on
   * every render: see the hook-order note in the file header. Everything it
   * receives is rendered by Stash exactly as before.
   */
  function PatchedButtons(props) {
    var config = useConfig();
    var urls = props.urls || [];

    var parts = React.useMemo(
      function () {
        return S.partition(urls, config);
      },
      [props.urls, config]
    );

    var remainder = props.renderOriginal(Object.assign({}, props.originalProps, { urls: parts.rest }));

    var nodes = parts.separate.map(function (group) {
      return h(LinkButton, {
        key: "elg-" + group.domain,
        domain: group.domain,
        urls: group.urls,
      });
    });

    if (parts.bucket.length) {
      nodes.push(
        h(LinkButton, {
          key: "elg-bucket",
          name: "Configured links",
          urls: parts.bucket,
        })
      );
    }

    nodes.push(h(React.Fragment, { key: "elg-rest" }, remainder));

    return h(React.Fragment, null, nodes);
  }

  try {
    PluginApi.patch.instead("ExternalLinkButtons", function (props) {
      // The chain is appended after the original call arguments, so the last
      // argument is the remaining chain: the original render function when no
      // other plugin patches this component. Take it by position rather than
      // naming a third parameter — React calls a function component with
      // `(props, secondArg)`, and a future change to that arity must not move
      // the original into `ctx` where this patch would call the wrong thing.
      var callArgs = Array.prototype.slice.call(arguments);
      var renderOriginal = callArgs[callArgs.length - 1];

      return h(PatchedButtons, {
        urls: props && props.urls,
        // Passed through so a future Stash prop reaches the original renderer
        // instead of being silently dropped by this patch.
        originalProps: props,
        renderOriginal: renderOriginal,
      });
    });
  } catch (err) {
    console.error("ExternalLinkGroups: could not patch ExternalLinkButtons", err);
  }
})();
