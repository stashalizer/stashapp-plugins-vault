/**
 * QuestingAdventurerStorage — optional Suite Data storage with csLib fallback.
 *
 * Suite Data keeps plugin data in <config>/plugin-data/<plugin>/<key>.json,
 * outside the Settings page's plugin-config snapshot. When Suite Data is not
 * installed, every call falls back to the plugin's existing csLib config so
 * the plugin keeps working exactly as before.
 */
(function () {
  "use strict";

  var PLUGIN_ID = "QuestingAdventurer";
  var SUITE_ID = "SuiteData";
  var CONFIG_KEY = "QuestingAdventurer";
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
      'mutation ($args: Map) { runPluginOperation(plugin_id: "SuiteData", args: $args) }',
      { args: args }
    ).then(function (data) {
      if (!data || typeof data.runPluginOperation !== "object" || data.runPluginOperation === null) {
        throw new Error("Suite Data did not answer");
      }
      return data.runPluginOperation;
    });
  }

  async function ping() {
    if (suiteAvailable !== null) return suiteAvailable;
    try {
      var result = await suiteOp({ mode: "ping" });
      suiteAvailable = !!(result && result.ok);
    } catch (err) {
      suiteAvailable = false;
    }
    return suiteAvailable;
  }

  async function readSuiteKey(key) {
    var result = await suiteOp({ mode: "get", plugin: PLUGIN_ID, keys: [key] });
    if (result && result.items && result.items[key]) return result.items[key];
    return null;
  }

  async function putSuiteKey(key, value, base, by) {
    var items = {};
    items[key] = { value: value, base: base };
    var result = await suiteOp({
      mode: "put",
      plugin: PLUGIN_ID,
      by: by || "Questing Adventurer",
      items: items,
    });
    if (result && result.ok) {
      return { ok: true, rev: result.revs && result.revs[key] };
    }
    if (result && result.ok === false) {
      var conflict = result.conflict && result.conflict[key];
      return {
        ok: false,
        rev: conflict ? conflict.rev : null,
        value: conflict ? conflict.value : null,
      };
    }
    throw new Error("Unexpected Suite Data put response");
  }

  async function loadConfig() {
    if (await ping()) {
      try {
        var record = await readSuiteKey("config");
        if (record) {
          configRevision = record.rev;
          return record.value || {};
        }
        var legacy = (await csLib.getConfiguration(CONFIG_KEY)) || {};
        if (Object.keys(legacy).length > 0) {
          var migrated = await putSuiteKey("config", legacy, 0, "Questing Adventurer migration");
          if (migrated.ok) configRevision = migrated.rev;
        }
        return legacy;
      } catch (err) {
        console.error("QuestingAdventurerStorage: Suite Data read failed, using csLib", err);
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
        var result = await putSuiteKey("config", next, base, by);
        if (result.ok) {
          configRevision = result.rev;
          try {
            await csLib.setConfiguration(CONFIG_KEY, next);
          } catch (mirrorErr) {
            console.warn("QuestingAdventurerStorage: csLib mirror failed", mirrorErr);
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

  async function loadKey(key, fallbackCsKey) {
    if (await ping()) {
      try {
        var record = await readSuiteKey(key);
        if (record) return record.value;
      } catch (err) {
        console.error("QuestingAdventurerStorage: key read failed", key, err);
      }
    }
    if (fallbackCsKey) {
      var legacy = await csLib.getConfiguration(fallbackCsKey);
      if (legacy !== undefined && legacy !== null) return legacy;
    }
    return null;
  }

  async function saveKey(key, value, fallbackCsKey, by, mergeLatest) {
    if (await ping()) {
      try {
        var record = await readSuiteKey(key);
        var base = record ? record.rev : 0;
        var next = value;
        for (var attempt = 0; attempt < 3; attempt++) {
          var result = await putSuiteKey(key, next, base, by);
          if (result.ok) {
            if (fallbackCsKey) {
              try { await csLib.setConfiguration(fallbackCsKey, next); } catch (e) { /* mirror only */ }
            }
            return true;
          }
          base = result.rev;
          next = typeof mergeLatest === "function" ? mergeLatest(result.value) : next;
        }
        throw new Error("Suite Data revision conflict after retries");
      } catch (err) {
        console.error("QuestingAdventurerStorage: key write failed, using csLib", key, err);
        suiteAvailable = false;
      }
    }
    if (fallbackCsKey) {
      await csLib.setConfiguration(fallbackCsKey, value);
      return true;
    }
    throw new Error("No storage available for key " + key);
  }

  window.QuestingAdventurerStorage = {
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    loadKey: loadKey,
    saveKey: saveKey,
    isSuiteDataAvailable: ping,
  };
})();
