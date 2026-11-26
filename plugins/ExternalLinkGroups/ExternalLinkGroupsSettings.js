/**
 * ExternalLinkGroups — settings page.
 *
 * Registered like every other plugin in this repository: a route through
 * `patch.before("PluginRoutes")` plus a launcher card in Settings > Tools (the
 * even-call counter selects the second `SettingsToolsSection` instantiation).
 *
 * The page edits a local draft and writes it explicitly, because the config
 * model has an order (config order is button order) and a half-typed domain
 * must never be persisted. `Store` is still read on mount for the saved values,
 * and the icon cache is manipulated per row so a broken icon can be retried
 * without touching the domain list.
 *
 * Failure modes handled here:
 *   - PluginApi / router missing → nothing registers, one console error.
 *   - no csLib                  → saves go to localStorage; the page says so.
 *   - server write failed       → inline alert, changes stay in the browser copy.
 *   - invalid or duplicate domain → row error, Save disabled.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.patch || !PluginApi.React) {
    console.error("ExternalLinkGroups settings: PluginApi unavailable; settings page not registered.");
    return;
  }

  var React = PluginApi.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useCallback = React.useCallback;
  var useRef = React.useRef;

  var S = window.ExternalLinkGroupsShared;
  var Store = window.ExternalLinkGroupsStore;
  var Icons = window.ExternalLinkGroupsIcons;

  if (!S || !Store || !Icons) {
    console.error("ExternalLinkGroups settings: shared/store modules missing; settings page not registered.");
    return;
  }

  var Router = PluginApi.libraries && PluginApi.libraries.ReactRouterDOM;
  if (!Router || !Router.Route || !Router.Link) {
    console.error("ExternalLinkGroups settings: ReactRouterDOM unavailable; settings page not registered.");
    return;
  }

  var PLUGIN_ROUTE = "/plugins/externalurlgroups";

  function toDraft(config) {
    return config.domains.map(function (entry) {
      return {
        domain: entry.domain,
        enabled: entry.enabled,
        separate: entry.separate,
        error: null,
      };
    });
  }

  function serialize(rows) {
    return JSON.stringify(
      rows.map(function (row) {
        return { domain: row.domain.trim().toLowerCase(), enabled: !!row.enabled, separate: !!row.separate };
      })
    );
  }

  function IconPreview(props) {
    var pair = useState(0);
    var bump = pair[1];

    useEffect(function () {
      return Icons.subscribe(function () {
        bump(function (n) {
          return n + 1;
        });
      });
    }, []);

    useEffect(
      function () {
        if (props.domain) Icons.ensure(props.domain);
      },
      [props.domain, props.revision]
    );

    var entry = props.domain ? Icons.get(props.domain) : null;

    if (entry && entry.ok) {
      return h("img", {
        className: "elg-set__icon",
        src: entry.src,
        alt: "",
        width: 20,
        height: 20,
        referrerPolicy: "no-referrer",
        onError: function () {
          Icons.reportBroken(props.domain, entry.src);
          Icons.ensure(props.domain);
        },
      });
    }

    return h(
      "span",
      { className: "elg-set__icon elg-set__icon--letter", "aria-hidden": "true" },
      String(props.domain || "?").charAt(0).toUpperCase()
    );
  }

  function Checkbox(props) {
    return h(
      "label",
      { className: "elg-set__check", title: props.title },
      h("input", {
        type: "checkbox",
        checked: !!props.checked,
        disabled: !!props.disabled,
        onChange: function (event) {
          props.onChange(event.target.checked);
        },
      }),
      h("span", null, props.label)
    );
  }

  function SettingsPage() {
    var configPair = useState(function () {
      return Store.get();
    });
    var initialConfig = configPair[0];

    var draftPair = useState(function () {
      return toDraft(initialConfig);
    });
    var draft = draftPair[0];
    var setDraft = draftPair[1];

    var newPair = useState("");
    var newDomain = newPair[0];
    var setNewDomain = newPair[1];

    var messagePair = useState(null); // { kind: "ok"|"error"|"info", text }
    var message = messagePair[0];
    var setMessage = messagePair[1];

    var modePair = useState(Store.storageMode());
    var mode = modePair[0];
    var setMode = modePair[1];

    var savingPair = useState(false);
    var saving = savingPair[0];
    var setSaving = savingPair[1];

    var revisionPair = useState(0);
    var revision = revisionPair[0];
    var bumpRevision = revisionPair[1];

    var savedRef = useRef(serialize(toDraft(initialConfig)));
    var mountedRef = useRef(true);

    useEffect(function () {
      mountedRef.current = true;
      return function () {
        mountedRef.current = false;
      };
    }, []);

    useEffect(function () {
      Store.load()
        .then(function (config) {
          if (!mountedRef.current) return;
          setMode(Store.storageMode());
          // Do not clobber edits made while the async read was in flight.
          if (serialize(draft) !== savedRef.current) return;
          savedRef.current = serialize(toDraft(config));
          setDraft(toDraft(config));
        })
        .catch(function (err) {
          console.error("ExternalLinkGroups settings: load failed", err);
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    var dirty = serialize(draft) !== savedRef.current;
    var hasRowError = draft.some(function (row) {
      return !!row.error;
    });

    var updateRow = useCallback(function (index, patch) {
      setDraft(function (rows) {
        return rows.map(function (row, i) {
          return i === index ? Object.assign({}, row, patch) : row;
        });
      });
    }, []);

    var validateDomain = useCallback(
      function (value, index) {
        var domain = S.normalizeDomain(value);
        if (!domain) return { domain: null, error: "Not a domain — try example.com" };

        var duplicate = draft.some(function (row, i) {
          return i !== index && row.domain === domain;
        });
        if (duplicate) return { domain: domain, error: "Already configured" };

        return { domain: domain, error: null };
      },
      [draft]
    );

    var onDomainChange = useCallback(
      function (index, value) {
        updateRow(index, { domain: value, error: null });
      },
      [updateRow]
    );

    var onDomainBlur = useCallback(
      function (index) {
        var row = draft[index];
        if (!row) return;
        var result = validateDomain(row.domain, index);
        updateRow(index, { domain: result.domain || row.domain, error: result.error });
      },
      [draft, updateRow, validateDomain]
    );

    var onAdd = useCallback(
      function (event) {
        if (event) event.preventDefault();

        var result = validateDomain(newDomain, -1);
        if (result.error) {
          setMessage({ kind: "error", text: result.error });
          return;
        }
        if (draft.length >= S.MAX_DOMAINS) {
          setMessage({ kind: "error", text: "At most " + S.MAX_DOMAINS + " domains." });
          return;
        }

        setDraft(function (rows) {
          return rows.concat([{ domain: result.domain, enabled: true, separate: true, error: null }]);
        });
        setNewDomain("");
        setMessage(null);
      },
      [draft.length, newDomain, validateDomain]
    );

    var onMove = useCallback(function (index, delta) {
      setDraft(function (rows) {
        var target = index + delta;
        if (target < 0 || target >= rows.length) return rows;
        var next = rows.slice();
        var moved = next.splice(index, 1)[0];
        next.splice(target, 0, moved);
        return next;
      });
    }, []);

    var onRemove = useCallback(function (index) {
      setDraft(function (rows) {
        return rows.filter(function (_row, i) {
          return i !== index;
        });
      });
    }, []);

    var onSave = useCallback(
      function () {
        var invalid = draft.filter(function (row) {
          return row.error || !S.normalizeDomain(row.domain);
        });
        if (invalid.length) {
          setMessage({ kind: "error", text: "Fix the highlighted domains before saving." });
          return;
        }

        var config = S.sanitizeConfig({
          domains: draft.map(function (row) {
            return { domain: row.domain, enabled: row.enabled, separate: row.separate };
          }),
        });

        setSaving(true);
        Store.save(config)
          .then(function (result) {
            if (!mountedRef.current) return;
            setMode(result.mode);
            savedRef.current = serialize(toDraft(config));
            setDraft(toDraft(config));
            setMessage(
              result.ok
                ? { kind: "ok", text: "Saved." }
                : {
                    kind: "error",
                    text: "Saved in this browser only — Stash rejected the write. See the console.",
                  }
            );
          })
          .finally(function () {
            if (mountedRef.current) setSaving(false);
          });
      },
      [draft]
    );

    var onReset = useCallback(function () {
      setSaving(true);
      Store.reset()
        .then(function () {
          if (!mountedRef.current) return;
          var config = Store.get();
          savedRef.current = serialize(toDraft(config));
          setDraft(toDraft(config));
          setMessage({ kind: "info", text: "Configuration cleared." });
        })
        .finally(function () {
          if (mountedRef.current) setSaving(false);
        });
    }, []);

    var onClearCache = useCallback(function () {
      Icons.clear();
      bumpRevision(function (n) {
        return n + 1;
      });
      setMessage({ kind: "info", text: "Icon cache cleared; icons will be fetched again." });
    }, [bumpRevision]);

    var onRefreshIcon = useCallback(function (domain) {
      Icons.refresh(domain).then(function () {
        bumpRevision(function (n) {
          return n + 1;
        });
      });
    }, [bumpRevision]);

    var rows = draft.map(function (row, index) {
      return h(
        "li",
        {
          key: index,
          className: "elg-set__row" + (row.error ? " elg-set__row--invalid" : "") + (row.enabled ? "" : " elg-set__row--off"),
        },
        h(
          "div",
          { className: "elg-set__cell elg-set__cell--domain" },
          h("input", {
            type: "text",
            className: "form-control form-control-sm",
            value: row.domain,
            spellCheck: false,
            autoComplete: "off",
            "aria-label": "Domain",
            "aria-invalid": row.error ? "true" : "false",
            onChange: function (event) {
              onDomainChange(index, event.target.value);
            },
            onBlur: function () {
              onDomainBlur(index);
            },
          }),
          row.error ? h("span", { className: "elg-set__error" }, row.error) : null
        ),
        h(
          "div",
          { className: "elg-set__cell elg-set__cell--flags" },
          h(Checkbox, {
            label: "Enabled",
            title: "Off: the link stays with Stash's original buttons",
            checked: row.enabled,
            onChange: function (value) {
              updateRow(index, { enabled: value });
            },
          }),
          h(Checkbox, {
            label: "Separate button",
            title: "On: own icon button. Off: shares one “Configured links” button",
            checked: row.separate,
            disabled: !row.enabled,
            onChange: function (value) {
              updateRow(index, { separate: value });
            },
          })
        ),
        h(
          "div",
          { className: "elg-set__cell elg-set__cell--icon" },
          h(IconPreview, { domain: row.domain, revision: revision }),
          h(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-secondary elg-set__icon-button",
              title: "Fetch this icon again",
              "aria-label": "Refresh icon for " + (row.domain || "this domain"),
              onClick: function () {
                onRefreshIcon(row.domain);
              },
            },
            "\u21bb"
          )
        ),
        h(
          "div",
          { className: "elg-set__cell elg-set__cell--order" },
          h(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-secondary",
              disabled: index === 0,
              title: "Move up",
              "aria-label": "Move " + (row.domain || "row") + " up",
              onClick: function () {
                onMove(index, -1);
              },
            },
            "\u2191"
          ),
          h(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-secondary",
              disabled: index === draft.length - 1,
              title: "Move down",
              "aria-label": "Move " + (row.domain || "row") + " down",
              onClick: function () {
                onMove(index, 1);
              },
            },
            "\u2193"
          ),
          h(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-danger",
              title: "Remove",
              "aria-label": "Remove " + (row.domain || "row"),
              onClick: function () {
                onRemove(index);
              },
            },
            "\u2715"
          )
        )
      );
    });

    return h(
      "div",
      { className: "elg-set" },
      h(
        "header",
        { className: "elg-set__header" },
        h("h1", { className: "elg-set__title" }, "External Link Groups"),
        h(
          "p",
          { className: "elg-set__lede" },
          "Promote the sites you actually use out of Stash's generic link menu. Each configured domain gets its own button with that site's icon; clicking one link opens it directly, clicking several shows the list."
        )
      ),

      h(
        "section",
        { className: "elg-set__panel" },
        h("h2", { className: "elg-set__heading" }, "Configured domains"),
        h(
          "ul",
          { className: "elg-set__rules" },
          h("li", null, h("strong", null, "Disabled"), " — the link is left to Stash, which shows it exactly as it did before this plugin."),
          h("li", null, h("strong", null, "Enabled + separate"), " — own icon button, icon fetched and cached from the site."),
          h("li", null, h("strong", null, "Enabled, not separate"), " — grouped into one “Configured links” button (no icon fetch).")
        ),

        draft.length === 0
          ? h("p", { className: "elg-set__empty" }, "No domains yet. Add one below — for example onlyfans.com.")
          : h(
              "div",
              { className: "elg-set__table" },
              h(
                "div",
                { className: "elg-set__row elg-set__row--head", "aria-hidden": "true" },
                h("span", { className: "elg-set__cell elg-set__cell--domain" }, "Domain"),
                h("span", { className: "elg-set__cell elg-set__cell--flags" }, "Behaviour"),
                h("span", { className: "elg-set__cell elg-set__cell--icon" }, "Icon"),
                h("span", { className: "elg-set__cell elg-set__cell--order" }, "Order")
              ),
              h("ul", { className: "elg-set__rows" }, rows)
            ),

        h(
          "form",
          { className: "elg-set__add", onSubmit: onAdd },
          h("input", {
            type: "text",
            className: "form-control form-control-sm",
            placeholder: "example.com",
            value: newDomain,
            spellCheck: false,
            autoComplete: "off",
            "aria-label": "Domain to add",
            onChange: function (event) {
              setNewDomain(event.target.value);
            },
          }),
          h(
            "button",
            { type: "submit", className: "btn btn-sm btn-primary", disabled: !newDomain.trim() },
            "Add domain"
          )
        )
      ),

      h(
        "section",
        { className: "elg-set__panel" },
        h("h2", { className: "elg-set__heading" }, "Icons"),
        h(
          "p",
          { className: "elg-set__note" },
          "Icons come from the site's own /favicon.ico first, then DuckDuckGo, then Google. Only the source URL is cached (30 days for a hit, 6 hours for a miss) — the browser caches the image itself. A failed image falls through to the next source automatically."
        ),
        h(
          "div",
          { className: "elg-set__actions" },
          h(
            "button",
            { type: "button", className: "btn btn-sm btn-secondary", onClick: onClearCache },
            "Clear icon cache"
          )
        )
      ),

      message
        ? h(
            "div",
            {
              className: "elg-set__notice elg-set__notice--" + message.kind,
              role: message.kind === "error" ? "alert" : "status",
            },
            message.text
          )
        : null,

      h(
        "footer",
        { className: "elg-set__footer" },
        h(
          "div",
          { className: "elg-set__actions" },
          h(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              onClick: onSave,
              disabled: saving || !dirty || hasRowError,
            },
            saving ? "Saving…" : dirty ? "Save changes" : "Saved"
          ),
          h(
            "button",
            { type: "button", className: "btn btn-secondary", onClick: onReset, disabled: saving },
            "Clear configuration"
          )
        ),
        h(
          "p",
          { className: "elg-set__storage" },
          mode === "server"
            ? "Stored in Stash's plugin configuration (follows you across browsers)."
            : "CommunityScriptsUILibrary is not installed, so this is stored in this browser's localStorage only."
        )
      )
    );
  }

  // --- registration -------------------------------------------------------

  try {
    PluginApi.patch.before("PluginRoutes", function (props) {
      var children = h(
        React.Fragment,
        null,
        props.children,
        h(Router.Route, { path: PLUGIN_ROUTE, component: SettingsPage })
      );
      return [Object.assign({}, props, { children: children })];
    });
  } catch (err) {
    console.error("ExternalLinkGroups settings: could not register route", err);
  }

  // This patch fires twice per render (two SettingsToolsSection instances), so
  // the odd call passes through untouched and only the even one adds the card.
  var toolsSectionCalls = 0;

  try {
    PluginApi.patch.before("SettingsToolsSection", function (props) {
      toolsSectionCalls += 1;
      if (toolsSectionCalls % 2 !== 0) return [props];

      var card = h(
        Router.Link,
        { to: PLUGIN_ROUTE, className: "elg-set-launcher" },
        h("h3", null, "External Link Groups"),
        h("p", null, "Per-site buttons and icons for performer, studio and group links")
      );

      var children = Array.isArray(props.children)
        ? props.children.concat([card])
        : [props.children, card];

      return [Object.assign({}, props, { children: children })];
    });
  } catch (err) {
    console.error("ExternalLinkGroups settings: could not register tools launcher", err);
  }
})();
