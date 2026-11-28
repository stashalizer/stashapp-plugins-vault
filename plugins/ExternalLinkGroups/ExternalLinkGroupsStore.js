/**
 * ExternalLinkGroupsStore — persistence for the plugin config.
 *
 * CommunityScriptsUILibrary is optional here, for the same reason it is
 * optional in CarbonArcStore: `ui.requires` is treated as mandatory by Stash,
 * so declaring csLib would stop the whole plugin from loading for users who do
 * not have it. Instead:
 *
 *   - when `window.csLib` answers, the config lives in the plugin
 *     configuration (`configurePlugin`), so it follows the user across
 *     browsers and devices;
 *   - otherwise it is written to localStorage and the settings page says so.
 *
 * localStorage is always written as a mirror, so the synchronous `get()` used
 * by the first render has something to work with before the async server read
 * returns. The server wins on load **unless** it has no domains and the
 * browser copy has some — that is the "installed csLib after configuring"
 * case, and silently dropping a configured list would be the worst outcome.
 *
 * License: AGPL-3.0
 */
(function () {
  "use strict";

  var S = window.ExternalLinkGroupsShared;
  if (!S) {
    console.error("ExternalLinkGroups: shared module missing; config will not persist.");
    return;
  }

  var current = S.makeDefaultConfig();
  var listeners = [];
  var loading = null;
  var mode = "browser"; // "browser" | "server"

  function hasCsLib() {
    return !!(
      window.csLib &&
      typeof window.csLib.getConfiguration === "function" &&
      typeof window.csLib.setConfiguration === "function"
    );
  }

  function clone(config) {
    return {
      version: config.version,
      domains: config.domains.map(function (entry) {
        return {
          domains: entry.domains.slice(),
          enabled: entry.enabled,
          separate: entry.separate,
        };
      }),
    };
  }

  function readLocal() {
    try {
      var raw = window.localStorage.getItem(S.CONFIG_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      // Private mode, quota, corrupt JSON — all non-fatal, defaults are fine.
      return null;
    }
  }

  function writeLocal(config) {
    try {
      window.localStorage.setItem(S.CONFIG_STORAGE_KEY, JSON.stringify(config));
      return true;
    } catch (err) {
      return false;
    }
  }

  function notify() {
    var snapshot = clone(current);
    listeners.slice().forEach(function (fn) {
      try {
        fn(snapshot);
      } catch (err) {
        console.error("ExternalLinkGroups: config listener threw", err);
      }
    });
  }

  function adopt(config) {
    current = S.sanitizeConfig(config);
    writeLocal(current);
    return current;
  }

  function get() {
    return clone(current);
  }

  function storageMode() {
    return mode;
  }

  /**
   * Read the persisted config once. Safe to call from every surface: the
   * promise is memoized, and a failed server read leaves the browser copy in
   * place rather than resetting the UI.
   */
  function load() {
    if (loading) return loading;

    var local = readLocal();
    if (local) adopt(local);

    if (!hasCsLib()) {
      mode = "browser";
      return Promise.resolve(get());
    }

    loading = Promise.resolve()
      .then(function () {
        return window.csLib.getConfiguration(S.CONFIG_KEY, S.makeDefaultConfig());
      })
      .then(function (stored) {
        mode = "server";
        var server = S.sanitizeConfig(stored);

        if (server.domains.length === 0 && current.domains.length > 0) {
          // Browser copy predates csLib; push it up instead of discarding it.
          return window.csLib
            .setConfiguration(S.CONFIG_KEY, clone(current))
            .then(function () {
              return get();
            });
        }

        adopt(server);
        notify();
        return get();
      })
      .catch(function (err) {
        console.error("ExternalLinkGroups: could not read plugin config", err);
        mode = "browser";
        return get();
      });

    return loading;
  }

  /**
   * Persist the whole config object. `csLib.setConfiguration` replaces the
   * plugin's entire config map, so the argument is always the full object —
   * never a partial patch.
   */
  function save(config) {
    adopt(config);
    notify();

    if (!hasCsLib()) {
      mode = "browser";
      return Promise.resolve({ ok: true, mode: mode });
    }

    return Promise.resolve()
      .then(function () {
        return window.csLib.setConfiguration(S.CONFIG_KEY, clone(current));
      })
      .then(function () {
        mode = "server";
        return { ok: true, mode: mode };
      })
      .catch(function (err) {
        console.error("ExternalLinkGroups: could not save plugin config", err);
        mode = "browser";
        // The browser copy is already written; only the server write failed.
        return { ok: false, mode: mode, error: err };
      });
  }

  function reset() {
    return save(S.makeDefaultConfig());
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function () {
      var index = listeners.indexOf(fn);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  // Prime synchronously so the first render already sees the browser copy.
  var primed = readLocal();
  if (primed) current = S.sanitizeConfig(primed);

  window.ExternalLinkGroupsStore = {
    get: get,
    load: load,
    save: save,
    reset: reset,
    subscribe: subscribe,
    storageMode: storageMode,
    hasCsLib: hasCsLib,
  };
})();
