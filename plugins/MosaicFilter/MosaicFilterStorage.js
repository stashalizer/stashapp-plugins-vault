/**
 * MosaicFilterStorage — optional Suite Data storage with csLib fallback.
 *
 * Data (global defaults and per-scene/per-studio presets) lives outside the
 * Settings page's plugin-config snapshot when Suite Data is installed. When
 * it is not installed, reads and writes fall back to csLib.
 *
 * Suite Data is optional and must stay undeclared as a dependency: presence is
 * confirmed with a `plugins` query before the first runPluginOperation call,
 * because Stash panics when the mutation is sent an id that is not loaded.
 */
(function () {
  "use strict";

  var PLUGIN_ID = "MosaicFilter";
  var SUITE_ID = "SuiteData";
  var CONFIG_KEY = "MosaicFilter";
  var suiteAvailable = null;
  var configRevision = null;
  var csLib = window.csLib;

  function graphql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (response) {
      if (!response.ok) throw new Error("GraphQL HTTP " + response.status);
      return response.json();
    }).then(function (payload) {
      if (payload.errors && payload.errors.length) {
        throw new Error(payload.errors.map(function (e) { return e.message; }).join("; "));
      }
      return payload.data;
    });
  }

  function suiteOp(args) {
    return graphql(
      'mutation ($args: Map) { runPluginOperation(plugin_id: "' + SUITE_ID + '", args: $args) }',
      { args: args }
    ).then(function (data) {
      if (!data || typeof data.runPluginOperation !== "object" || data.runPluginOperation === null) {
        throw new Error("Suite Data did not answer");
      }
      return data.runPluginOperation;
    });
  }

  // Stash's runPluginOperation panics on an unknown plugin id, so confirm the
  // plugin is installed and enabled before sending the first operation. The ID
  // comparison is exact on purpose: Stash matches plugin IDs case-sensitively.
  async function suiteInstalled() {
    try {
      var data = await graphql("query { plugins { id enabled } }");
      var list = (data && data.plugins) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === SUITE_ID) return list[i].enabled !== false;
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  async function ping() {
    if (suiteAvailable !== null) return suiteAvailable;
    if (!(await suiteInstalled())) {
      suiteAvailable = false;
      return suiteAvailable;
    }
    try {
      var result = await suiteOp({ mode: "ping" });
      suiteAvailable = !!(result && result.ok);
    } catch (err) {
      suiteAvailable = false;
    }
    return suiteAvailable;
  }

  async function readConfigKey() {
    var result = await suiteOp({ mode: "get", plugin: PLUGIN_ID, keys: ["config"] });
    if (result && result.items && result.items.config) return result.items.config;
    return null;
  }

  async function putConfig(value, base, by) {
    var result = await suiteOp({
      mode: "put",
      plugin: PLUGIN_ID,
      by: by || "Mosaic Filter",
      items: { config: { value: value, base: base } },
    });
    if (result && result.ok) return { ok: true, rev: result.revs && result.revs.config };
    if (result && result.ok === false) {
      var conflict = result.conflict && result.conflict.config;
      return { ok: false, rev: conflict ? conflict.rev : null, value: conflict ? conflict.value : null };
    }
    throw new Error("Unexpected Suite Data put response");
  }

  async function loadConfig() {
    if (await ping()) {
      try {
        var record = await readConfigKey();
        if (record) {
          configRevision = record.rev;
          return record.value || {};
        }
        var legacy = (await csLib.getConfiguration(CONFIG_KEY)) || {};
        if (Object.keys(legacy).length > 0) {
          var migrated = await putConfig(legacy, 0, "Mosaic Filter migration");
          if (migrated.ok) configRevision = migrated.rev;
        }
        return legacy;
      } catch (err) {
        console.error("MosaicFilterStorage: Suite Data read failed, using csLib", err);
        suiteAvailable = false;
      }
    }
    return (await csLib.getConfiguration(CONFIG_KEY)) || {};
  }

  async function saveConfig(value, mergeLatest, by) {
    if (await ping()) {
      var base = typeof configRevision === "number" ? configRevision : 0;
      var next = value;
      for (var attempt = 0; attempt < 3; attempt++) {
        var result = await putConfig(next, base, by);
        if (result.ok) {
          configRevision = result.rev;
          try {
            await csLib.setConfiguration(CONFIG_KEY, next);
          } catch (mirrorErr) {
            console.warn("MosaicFilterStorage: csLib mirror failed", mirrorErr);
          }
          return true;
        }
        base = result.rev;
        next = typeof mergeLatest === "function" ? mergeLatest(result.value) : next;
      }
      throw new Error("Suite Data revision conflict after retries");
    }
    await csLib.setConfiguration(CONFIG_KEY, value);
    return true;
  }

  window.MosaicFilterStorage = {
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    isSuiteDataAvailable: ping,
  };
})();
