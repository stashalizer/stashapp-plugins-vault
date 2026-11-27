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
 *   - library scan failed       → the suggestion panel says why and the manual
 *                                 add form keeps working.
 *
 * The suggestion panel is the "I do not want to type twelve domains" path: a
 * click on Scan library ranks domains by how many links use them, and the ones
 * the user accepts are appended to the same draft the manual form edits. It is
 * click-triggered rather than automatic because the scan walks every performer,
 * studio and group, and most visits to this page are about something else
 * (an icon, an order). It never writes: no existing row is touched, no default
 * is applied to a configured domain, and nothing reaches the server until Save
 * changes.
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
  var Scan = window.ExternalLinkGroupsScan;

  if (!S || !Store || !Icons || !Scan) {
    console.error("ExternalLinkGroups settings: shared/store/icon/scan modules missing; settings page not registered.");
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

  /** Draft row → config entry, for the pure helpers that take a config. */
  function toEntry(row) {
    return { domain: row.domain, enabled: !!row.enabled, separate: !!row.separate };
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

    var scanPair = useState({
      status: "idle", // "idle" | "scanning" | "done" | "error"
      error: null,
      summary: [],
      totals: null,
      links: 0,
      pages: 0,
      truncated: false,
      progress: null,
      // Domains the scan checked by default: the most used ones that were not
      // configured at scan time. Frozen with the result so that adding a batch
      // does not silently check the next batch — a second click should be a
      // decision, not a follow-through.
      defaults: {},
    });
    var scan = scanPair[0];
    var setScan = scanPair[1];

    // Explicit checkbox toggles, keyed by domain. An absent key means "whatever
    // the scan default said".
    var pickedPair = useState({});
    var picked = pickedPair[0];
    var setPicked = pickedPair[1];

    var revisionPair = useState(0);
    var revision = revisionPair[0];
    var bumpRevision = revisionPair[1];

    var savedRef = useRef(serialize(toDraft(initialConfig)));
    var mountedRef = useRef(true);

    // Latest draft, for the scan callbacks: they outlive the render that started
    // them and must not answer "already configured" from a stale closure.
    var draftRef = useRef(draft);
    draftRef.current = draft;

    var scanTokenRef = useRef(0);

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

    /**
     * Sweep the library once and rank its domains.
     *
     * Only ever called from a click: opening the settings page must not cost a
     * library read. The page can be opened for a dozen reasons that have nothing
     * to do with suggestions (fixing an icon, reordering a button), and a sweep
     * of every performer/studio/group is the most expensive thing this plugin
     * does. The result also stays put until the user asks for a new one, so
     * revisiting the page does not throw away a list they were working through.
     *
     * The token guard is the only cancellation the page needs: a rescan, or an
     * unmount, makes the older promise's results irrelevant, and a late
     * `setState` on an unmounted tree is what React warns about.
     */
    var runScan = useCallback(function () {
      scanTokenRef.current += 1;
      var token = scanTokenRef.current;

      setScan(function (previous) {
        return Object.assign({}, previous, {
          status: "scanning",
          error: null,
          summary: [],
          links: 0,
          pages: 0,
          truncated: false,
          progress: null,
          defaults: {},
        });
      });
      setPicked({});

      Scan.scan({
        onProgress: function (progress) {
          if (token !== scanTokenRef.current || !mountedRef.current) return;
          setScan(function (previous) {
            return Object.assign({}, previous, { progress: progress });
          });
        },
      })
        .then(function (result) {
          if (token !== scanTokenRef.current || !mountedRef.current) return;

          var configured = {};
          draftRef.current.forEach(function (row) {
            var domain = S.normalizeDomain(row.domain);
            if (domain) configured[domain] = true;
          });

          var defaults = {};
          var checked = 0;
          for (var i = 0; i < result.summary.length && checked < S.SUGGEST_PRESELECT; i += 1) {
            var domain = result.summary[i].domain;
            if (configured[domain]) continue;
            defaults[domain] = true;
            checked += 1;
          }

          setScan({
            status: "done",
            error: null,
            summary: result.summary,
            totals: result.totals,
            links: result.links,
            pages: result.pages,
            truncated: result.truncated,
            progress: null,
            defaults: defaults,
          });
        })
        .catch(function (err) {
          if (token !== scanTokenRef.current || !mountedRef.current) return;
          console.error("ExternalLinkGroups settings: library scan failed", err);
          setScan(function (previous) {
            return Object.assign({}, previous, {
              status: "error",
              error: err && err.message ? err.message : String(err),
              summary: [],
              progress: null,
              defaults: {},
            });
          });
        });
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

    var togglePick = useCallback(function (domain, value) {
      setPicked(function (previous) {
        var next = Object.assign({}, previous);
        next[domain] = !!value;
        return next;
      });
    }, []);

    /**
     * Append domains to the draft. Additive only: an existing row is never
     * rewritten, reordered or re-flagged, and a domain that is already there is
     * skipped — that is what makes "Add selected" safe to press twice. The rule
     * itself is `Shared.appendDomains`, so it is the same one the tests check.
     */
    var addSuggested = useCallback(
      function (domains) {
        var result = S.appendDomains({ domains: draft.map(toEntry) }, domains);

        if (!result.added.length) {
          setMessage({
            kind: result.overflow ? "error" : "info",
            text: result.overflow
              ? "At most " + S.MAX_DOMAINS + " domains — remove one before adding another."
              : "Those domains are already on the list.",
          });
          return;
        }

        var rows = result.added.map(function (item) {
          return { domain: item.domain, enabled: item.enabled, separate: item.separate, error: null };
        });

        setDraft(function (current) {
          return current.concat(rows);
        });
        setPicked({});
        setMessage({
          kind: "info",
          text:
            "Added " + rows.length + " domain" + (rows.length === 1 ? "" : "s") +
            " to the draft — review them, then Save changes." +
            (result.overflow
              ? " " + result.overflow + " did not fit under the " + S.MAX_DOMAINS + "-domain limit."
              : ""),
        });
      },
      [draft]
    );

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

    // --- suggestions ------------------------------------------------------
    // Recomputed from the current draft, not cached: adding a domain, renaming
    // one or clearing the list must all move the suggestion list with it.
    var configuredDomains = {};
    draft.forEach(function (row) {
      var domain = S.normalizeDomain(row.domain);
      if (domain) configuredDomains[domain] = true;
    });

    var scanDone = scan.status === "done";
    var suggestions = scanDone
      ? S.suggestDomains({ domains: draft.map(toEntry) }, scan.summary, S.SUGGEST_LIMIT)
      : [];

    var configuredHits = 0;
    if (scanDone) {
      scan.summary.forEach(function (item) {
        if (configuredDomains[item.domain]) configuredHits += 1;
      });
    }

    var isPicked = function (domain) {
      if (typeof picked[domain] === "boolean") return picked[domain];
      return !!scan.defaults[domain];
    };

    var selectedDomains = suggestions
      .filter(function (item) {
        return isPicked(item.domain);
      })
      .map(function (item) {
        return item.domain;
      });

    var scanText = "";
    if (scan.status === "scanning") {
      scanText = scan.progress
        ? "Scanning… " + scan.progress.links + " link" + (scan.progress.links === 1 ? "" : "s") +
          " from page " + scan.progress.pages + "."
        : "Scanning performer, studio and group links…";
    } else if (scan.status === "error") {
      scanText = "Scan failed: " + scan.error + ". Adding domains by hand below still works.";
    } else if (scanDone) {
      var totals = scan.totals || {};
      scanText =
        scan.summary.length + " domain" + (scan.summary.length === 1 ? "" : "s") +
        " across " + scan.links + " link" + (scan.links === 1 ? "" : "s") +
        " (performers " + (totals.performers || 0) +
        ", studios " + (totals.studios || 0) +
        ", groups " + (totals.groups || 0) + ").";
      if (configuredHits) {
        scanText += " " + configuredHits + " already configured — left untouched.";
      }
      if (scan.truncated) {
        scanText += " The sweep stopped after " + scan.pages + " pages, so treat this as a partial count.";
      }
      if (!suggestions.length && draft.length >= S.MAX_DOMAINS) {
        scanText += " The list is full — remove a domain to make room for another.";
      } else if (!suggestions.length && scan.summary.length && !configuredHits) {
        scanText += " Nothing left to suggest.";
      } else if (!suggestions.length && !scan.summary.length) {
        scanText += " No link in this library resolves to a hostname yet.";
      }
    } else {
      scanText =
        "Not scanned yet. A scan reads the URL list of every performer, studio and group — press Scan library when you want suggestions. Nothing is written: results only fill the draft above.";
    }

    var suggestionRows = suggestions.map(function (item) {
      var selected = isPicked(item.domain);
      return h(
        "li",
        { key: item.domain, className: "elg-set__suggest-row" },
        h(
          "label",
          { className: "elg-set__check elg-set__suggest-label", title: item.sample || item.domain },
          h("input", {
            type: "checkbox",
            checked: selected,
            onChange: function (event) {
              togglePick(item.domain, event.target.checked);
            },
          }),
          h("span", null, item.domain)
        ),
        h(
          "span",
          { className: "elg-set__suggest-count" },
          item.count === 1 ? "1 link" : item.count + " links"
        ),
        h(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-secondary",
            "aria-label": "Add " + item.domain + " to the list",
            onClick: function () {
              addSuggested([item.domain]);
            },
          },
          "Add"
        )
      );
    });

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
          ? h("p", { className: "elg-set__empty" }, "No domains yet. Add one below — for example onlyfans.com — or pick one from the suggestions further down.")
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
        h("h2", { className: "elg-set__heading" }, "Suggested from your library"),
        h(
          "p",
          { className: "elg-set__note" },
          "Stash stores a URL list on every performer, studio and group. Scan library reads those lists on demand, drops the links that cannot be parsed and ranks what is left by how many links use each domain — so the sites your library actually links to can be added without typing them. Scanning is a click, not something this page does on open: it walks the whole library, and the result stays until you scan again. Adding a suggestion only fills in the draft above; nothing is saved until you press Save changes, and a domain you already configured keeps the flags you gave it."
        ),
        h(
          "p",
          { className: "elg-set__scan" + (scan.status === "error" ? " elg-set__scan--error" : ""), role: "status" },
          scanText
        ),
        suggestions.length
          ? h("ul", { className: "elg-set__suggest" }, suggestionRows)
          : null,
        h(
          "div",
          { className: "elg-set__actions elg-set__suggest-actions" },
          suggestions.length
            ? h(
                "button",
                {
                  type: "button",
                  className: "btn btn-sm btn-primary",
                  disabled: scan.status === "scanning" || selectedDomains.length === 0,
                  onClick: function () {
                    addSuggested(selectedDomains);
                  },
                },
                "Add selected" + (selectedDomains.length ? " (" + selectedDomains.length + ")" : "")
              )
            : null,
          h(
            "button",
            {
              type: "button",
              // Primary only while there is nothing to add — otherwise it
              // competes with "Add selected" for the eye.
              className: "btn btn-sm " + (suggestions.length ? "btn-secondary" : "btn-primary"),
              disabled: scan.status === "scanning",
              onClick: runScan,
            },
            scan.status === "scanning"
              ? "Scanning…"
              : scan.status === "idle"
                ? "Scan library"
                : "Rescan library"
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
          "Icons come from the site's own /favicon.ico first, then DuckDuckGo, then Google. Only the source URL is cached (30 days for a hit, 6 hours for a miss) — the browser caches the image itself. A failed image falls through to the next source automatically. Both services answer “no icon for this site” with a 404 that still carries a picture, so DuckDuckGo's placeholder (a grey chevron) is recognised by its size and only used when nothing better loads — a site behind Cloudflare, for example, still gets its real icon from the next source."
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
