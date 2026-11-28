/**
 * QuestingAdventurerSettings — full-page CRUD settings UI.
 *
 * Architecture:
 * - Registers a route via PluginApi.patch.before("PluginRoutes", ...) at
 *   /plugins/questingadventurer.
 * - Adds a launcher row to the plugin-tools group in Settings > Tools via
 *   PluginApi.patch.before("SettingsToolsSection", ...). The group appears only
 *   under the "Tools" subsection (the first SettingsToolsSection instance in
 *   SettingsToolsPanel, config.tools.heading) by gating on a module-level call
 *   counter.
 * - Reads/writes the same config key ("QuestingAdventurer") as the overlay.
 *   Semantic split: the settings page owns the quests array; the overlay owns
 *   the collapsed flag and the opacity value. Every save from this page
 *   reads the stored config to preserve both overlay-owned fields.
 * - One-shot migration from the legacy "SceneRules" key runs on first load;
 *   see QuestingAdventurer.js for the migrator (settings page also calls it
 *   before reading state).
 * - The overlay and settings page each have their own save lock. They do NOT
 *   coordinate across components, so a concurrent write from both could race
 *   (last writer wins the whole config map). This is acceptable; settings
 *   edits will not live-reflect in an already-open overlay until the next
 *   page navigation or reload.
 */
(function () {
  "use strict";

  if (!window.PluginApi || !window.csLib) {
    console.error("QuestingAdventurer settings: PluginApi or csLib missing");
    return;
  }

  const React = PluginApi.React;
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const { Route, Link } = PluginApi.libraries.ReactRouterDOM;

  const CONFIG_KEY = "QuestingAdventurer";
  const LEGACY_CONFIG_KEY = "SceneRules";
  const PLUGIN_ROUTE = "/plugins/questingadventurer";
  const DEAL_CS_KEY = "QuestingAdventurerDeal";
  const DEAL_TTL_MS = 10 * 60 * 1000;

  function makeDealCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function normaliseDeal(value) {
    if (!value || typeof value !== "object") return null;
    return {
      code: typeof value.code === "string" ? value.code : "",
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : 0,
      usedAt: typeof value.usedAt === "number" ? value.usedAt : null,
      action: value.action === "draw-trigger" ? "draw-trigger" : "draw-trigger",
    };
  }

  function dealStatus(deal) {
    if (!deal || !deal.code) return "missing";
    if (deal.usedAt) return "used";
    if (Date.now() > deal.expiresAt) return "expired";
    return "active";
  }
  const storage = window.QuestingAdventurerStorage || {
    loadConfig: function () { return csLib.getConfiguration(CONFIG_KEY).then(function (v) { return v || {}; }); },
    saveConfig: function (value) { return csLib.setConfiguration(CONFIG_KEY, value); },
    loadKey: function (key, csKey) { return csLib.getConfiguration(csKey); },
    saveKey: function (key, value, csKey) { return csLib.setConfiguration(csKey, value); },
  };

  // Shared, pure tag-binding model (validation + scene resolution). The overlay
  // uses the same file, so a binding means exactly one thing on both surfaces.
  const shared = window.QuestingAdventurerShared || {
    normalizeTagBindings: function () { return []; },
    resolveTagBindings: function () { return []; },
    describeBindingProblems: function () {
      return [{ code: "unavailable", message: "Tag bindings are unavailable", blocking: true }];
    },
  };

  let settingsToolsCallCount = 0;
  let saving = false;
  let pendingSave = false;
  let latestTriggers = null;
  let latestMoves = null;
  // Loaded once with the config and treated like `latestTriggers`: a save from
  // any control writes it back, so editing a trigger cannot drop bindings.
  let latestTagBindings = null;

  function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // v1' → v2 migration for the settings page. Identical to the overlay's
  // migrateV1ToV2; duplicated here because the settings page runs in its
  // own IIFE scope and can't share the overlay's helper.
  function migrateV1ToV2(stored) {
    const oldTriggers = Array.isArray(stored.triggers) ? stored.triggers : [];
    const moves = [];
    const triggers = [];
    for (const node of oldTriggers) {
      if (node.type === "trigger") {
        const attachedMoveIds = [];
        for (const item of (node.items || [])) {
          const moveId = item.id || generateId();
          moves.push({ id: moveId, type: "move", text: item.text });
          attachedMoveIds.push(moveId);
        }
        triggers.push({
          id: node.id || generateId(),
          type: "trigger",
          name: node.name,
          active: true,
          attachedMoveIds: attachedMoveIds,
        });
      } else if (node.type === "move") {
        moves.push({ id: node.id || generateId(), type: "move", text: node.text });
      }
    }
    return { moves: moves, triggers: triggers };
  }

  function migrateFromLegacy() {
    return (async function () {
      try {
        const current = await csLib.getConfiguration(CONFIG_KEY);
        // v2 shape: { moves: [...], triggers: [...] }
        const hasCurrent = current && Array.isArray(current.moves) && Array.isArray(current.triggers);
        if (hasCurrent) return;
        const legacy = await csLib.getConfiguration(LEGACY_CONFIG_KEY);
        if (!legacy) return;
        const legacyNodes = Array.isArray(legacy.quests)
          ? legacy.quests
          : Array.isArray(legacy.rules)
          ? legacy.rules
          : [];
        if (legacyNodes.length === 0) return;
        const moves = [];
        const triggers = [];
        for (const node of legacyNodes) {
          if (node.type === "category" || node.type === "trigger") {
            const attachedMoveIds = [];
            for (const item of (node.items || [])) {
              const moveId = item.id || generateId();
              moves.push({ id: moveId, type: "move", text: item.text });
              attachedMoveIds.push(moveId);
            }
            triggers.push({
              id: node.id || generateId(),
              type: "trigger",
              name: node.name,
              active: true,
              attachedMoveIds: attachedMoveIds,
            });
          } else if (node.type === "move" || node.type === "rule") {
            moves.push({ id: node.id || generateId(), type: "move", text: node.text });
          }
        }
        const migrated = {
          moves: moves,
          triggers: triggers,
          opacity: typeof legacy.opacity === "number" ? legacy.opacity : 0.6,
          panelPos:
            legacy.panelPos && typeof legacy.panelPos.top === "number" && typeof legacy.panelPos.right === "number"
              ? { top: legacy.panelPos.top, right: legacy.panelPos.right }
              : { top: 8, right: 8 },
        };
        try {
          await csLib.setConfiguration(CONFIG_KEY, migrated);
        } catch (e) {
          console.error("QuestingAdventurer settings: failed to write migrated config:", e);
          return;
        }
        try {
          await csLib.setConfiguration(LEGACY_CONFIG_KEY, { moves: [], triggers: [], collapsed: true });
        } catch (e) {
          console.error("QuestingAdventurer settings: failed to clear legacy config:", e);
        }
        console.info("QuestingAdventurer settings: migrated legacy SceneRules config.");
      } catch (err) {
        console.error("QuestingAdventurer settings: migration check failed:", err);
      }
    })();
  }

  async function saveTriggersNow() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    pendingSave = false;
    try {
      const stored = (await storage.loadConfig()) || {};
      // Falling back to the stored arrays (not `[]`) matters now that this
      // function is also called by controls that never touch triggers: adding
      // a tag binding as the first action on the page used to write an empty
      // trigger list, because `latestTriggers` was still null.
      const triggersToSave = Array.isArray(latestTriggers)
        ? latestTriggers
        : Array.isArray(stored.triggers)
        ? stored.triggers
        : [];
      const movesToSave = Array.isArray(latestMoves)
        ? latestMoves
        : Array.isArray(stored.moves)
        ? stored.moves
        : [];
      const bindingsToSave = Array.isArray(latestTagBindings)
        ? latestTagBindings
        : shared.normalizeTagBindings(stored.tagBindings);
      const merged = {
        moves: movesToSave,
        triggers: triggersToSave,
        // Sanitize on the way out as well as on the way in: a row the page
        // created can still be half-configured, and the overlay would rather
        // receive nulls it understands than undefined fields.
        tagBindings: shared.normalizeTagBindings(bindingsToSave),
        collapsed: typeof stored.collapsed === "boolean" ? stored.collapsed : true,
        opacity:
          typeof stored.opacity === "number" && !Number.isNaN(stored.opacity)
            ? Math.min(1, Math.max(0, stored.opacity))
            : 0.6,
        panelPos:
          stored.panelPos &&
          typeof stored.panelPos.top === "number" &&
          typeof stored.panelPos.right === "number"
            ? {
                top: Math.max(0, stored.panelPos.top),
                right: Math.max(0, stored.panelPos.right),
              }
            : { top: 8, right: 8 },
        panelSize:
          stored.panelSize &&
          typeof stored.panelSize.width === "number" &&
          stored.panelSize.width >= 200 &&
          stored.panelSize.width <= 1200
            ? {
                width: stored.panelSize.width,
                height: typeof stored.panelSize.height === "number" ? stored.panelSize.height : undefined,
              }
            : { width: 360, height: undefined },
        showAddControls: stored.showAddControls === true,
        showManualControls: stored.showManualControls === true,
        hardware: stored.hardware && typeof stored.hardware === "object" ? stored.hardware : {},
      };
      const result = storage.saveConfig(merged, function (latest) {
        return Object.assign({}, latest || {}, {
          moves: movesToSave,
          triggers: triggersToSave,
          tagBindings: shared.normalizeTagBindings(bindingsToSave),
        });
      }, "Questing Adventurer settings");
      await result;
      saving = false;
      if (pendingSave) saveTriggersNow();
    } catch (err) {
      console.error("QuestingAdventurer settings: save failed:", err);
      saving = false;
      if (pendingSave) saveTriggersNow();
    }
  }

  function saveTriggers(newTriggers) {
    latestTriggers = newTriggers;
    saveTriggersNow();
  }

  function saveMoves(newMoves) {
    latestMoves = newMoves;
    saveTriggersNow();
  }

  function QuestingAdventurerSettingsPage() {
    const [moves, setMoves] = useState([]);
    const [triggers, setTriggers] = useState([]);
    // Tag → trigger/move bindings, stored at the top level of the config.
    // `tagAddSeq` is only a React key: the "add a tag" picker keeps its own
    // internal selection, so it is remounted (and therefore cleared) after
    // each added row. `tagPickerEpoch` does the same job for the per-row
    // pickers when a clear is refused.
    const [tagBindings, setTagBindings] = useState([]);
    const [tagAddSeq, setTagAddSeq] = useState(0);
    const [tagPickerEpoch, setTagPickerEpoch] = useState(0);
    const [loading, setLoading] = useState(true);
    const [deal, setDeal] = useState(null);
    const [partnerMode, setPartnerMode] = useState(false);
    const [dealMessage, setDealMessage] = useState("");
    const [hardware, setHardware] = useState({
      enabled: false,
      url: "ws://localhost:12345",
      intensity: 0.4,
      durationMs: 1000,
    });
    const [hardwareStatus, setHardwareStatus] = useState("");
    const [editingId, setEditingId] = useState(null);
    const [footerText, setFooterText] = useState("");
    // Playback rules: per-trigger scene/marker bindings. `autoDraft` holds the
    // uncommitted scene input per trigger, `sceneMarkerCache` the marker lists
    // fetched from Stash so a rule can name a marker instead of a timecode.
    const [autoDraft, setAutoDraft] = useState({});
    const [sceneMarkerCache, setSceneMarkerCache] = useState({});
    const markerRequests = useRef({});
    const inputRef = useRef(null);
    const editingIdRef = useRef(null);

    useEffect(function () {
      let mounted = true;

      function finish(movesArr, triggersArr, bindingsArr) {
        if (!mounted) return;
        setMoves(movesArr);
        setTriggers(triggersArr);
        const bindings = shared.normalizeTagBindings(bindingsArr);
        // Seed the module-level copy too: the first save from any control
        // writes it back, so it must already hold the loaded rows.
        latestTagBindings = bindings;
        setTagBindings(bindings);
        setLoading(false);
      }

      (async function () {
        try {
          await migrateFromLegacy();
          const stored = await storage.loadConfig();
          if (stored && Array.isArray(stored.moves) && Array.isArray(stored.triggers)) {
            // v2 format
            finish(stored.moves, stored.triggers, stored.tagBindings);
          } else {
            // v1' format → migrate to v2
            const migrated = migrateV1ToV2(stored);
            finish(migrated.moves, migrated.triggers, stored && stored.tagBindings);
            // Persist the migrated form. Both arrays are seeded first so the
            // save writes the migrated shape, not the v1' one it replaced.
            latestMoves = migrated.moves;
            saveTriggers(migrated.triggers);
          }
          if (stored && stored.hardware && typeof stored.hardware === "object") {
            setHardware({
              enabled: stored.hardware.enabled === true,
              url: typeof stored.hardware.url === "string" && stored.hardware.url ? stored.hardware.url : "ws://localhost:12345",
              intensity: typeof stored.hardware.intensity === "number" ? Math.max(0, Math.min(1, stored.hardware.intensity)) : 0.4,
              durationMs: typeof stored.hardware.durationMs === "number" ? Math.max(100, Math.min(10000, stored.hardware.durationMs)) : 1000,
            });
          }

          const params = new URLSearchParams(window.location.search);
          const code = params.get("deal");
          if (code) {
            setPartnerMode(true);
            const storedDeal = normaliseDeal(await storage.loadKey("deal", DEAL_CS_KEY));
            if (!storedDeal || storedDeal.code !== code) {
              setDealMessage("This deal code does not exist.");
            } else if (dealStatus(storedDeal) === "used") {
              setDeal(storedDeal);
              setDealMessage("This deal has already been used.");
            } else if (dealStatus(storedDeal) === "expired") {
              setDeal(storedDeal);
              setDealMessage("This deal has expired.");
            } else {
              setDeal(storedDeal);
            }
          } else {
            setDeal(normaliseDeal(await storage.loadKey("deal", DEAL_CS_KEY)));
          }
        } catch (err) {
          console.error("QuestingAdventurer settings: load failed:", err);
          finish([], [], []);
        }
      })();

      return function () {
        mounted = false;
      };
    }, []);

    useEffect(function () {
      if (editingId && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, [editingId]);

    // A rule names its marker by id, so the picker needs that scene's marker
    // list. Prefetch it for every scene any rule mentions; the loader is
    // idempotent and cached per scene id.
    useEffect(function () {
      const scenes = {};
      triggers.forEach(function (trigger) {
        (trigger.autoRules || []).forEach(function (rule) {
          if (rule && rule.sceneId) scenes[String(rule.sceneId)] = true;
        });
      });
      Object.keys(scenes).forEach(function (sceneId) {
        loadSceneMarkers(sceneId);
      });
    }, [triggers]);

    editingIdRef.current = editingId;

    function commitTriggers(nextTriggers) {
      setEditingId(null);
      setTriggers(nextTriggers);
      saveTriggers(nextTriggers);
    }

    function addMoveTop(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      // v2: add to the global move library. The move is unattached until the
      // user attaches it to a trigger.
      const nextMoves = [...moves, { id: generateId(), type: "move", text: trimmed }];
      setMoves(nextMoves);
      saveMoves(nextMoves);
    }

    function addTriggerTop(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      // v2: new triggers start INACTIVE. The user activates them via Penalty.
      const nextTriggers = [...triggers, {
        id: generateId(),
        type: "trigger",
        name: trimmed,
        active: false,
        attachedMoveIds: [],
        sceneTagIds: [],
        markerTagIds: [],
        autoRules: [],
      }];
      commitTriggers(nextTriggers);
    }

    function addMoveInto(triggerId, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      // v2: add the move to the global library AND attach it to the trigger.
      const newMoveId = generateId();
      const nextMoves = [...moves, { id: newMoveId, type: "move", text: trimmed }];
      const nextTriggers = triggers.map(function (node) {
        if (node.type === "trigger" && node.id === triggerId) {
          return {
            ...node,
            attachedMoveIds: [...(node.attachedMoveIds || []), newMoveId],
          };
        }
        return node;
      });
      setMoves(nextMoves);
      saveMoves(nextMoves);
      commitTriggers(nextTriggers);
    }

    function deleteMove(id) {
      // Detach the move from every trigger it's currently attached to.
      // (The "Delete move" button on each move row in the settings page is
      // for v2 semantics: the move stays in the global library, but it's
      // removed from every trigger's attachedMoveIds.)
      const nextTriggers = triggers.map(function (node) {
        if (node.type === "trigger" && Array.isArray(node.attachedMoveIds)) {
          return {
            ...node,
            attachedMoveIds: node.attachedMoveIds.filter(function (mid) {
              return mid !== id;
            }),
          };
        }
        return node;
      });
      commitTriggers(nextTriggers);
    }

    function deleteTrigger(id) {
      const q = triggers.find(function (n) {
        return n.type === "trigger" && n.id === id;
      });
      if (!q) return;
      const itemCount = Array.isArray(q.attachedMoveIds) ? q.attachedMoveIds.length : 0;
      // Bindings are stored outside the trigger, so deleting the trigger would
      // otherwise leave rows pointing at nothing. Removing them is part of the
      // delete, and the prompt says so instead of doing it silently.
      const boundCount = tagBindings.filter(function (b) { return b.triggerId === id; }).length;
      const confirmed = window.confirm(
        'Delete trigger "' +
          q.name +
          '" and its ' +
          itemCount +
          " move(s)?" +
          (boundCount > 0 ? " " + boundCount + " tag binding(s) pointing at it will be removed too." : "")
      );
      if (!confirmed) return;
      const nextTriggers = triggers.filter(function (n) {
        return !(n.type === "trigger" && n.id === id);
      });
      if (boundCount > 0) {
        // Update the module-level copy before the save below so one write
        // carries both changes.
        const nextBindings = tagBindings.filter(function (b) { return b.triggerId !== id; });
        latestTagBindings = nextBindings;
        setTagBindings(nextBindings);
      }
      commitTriggers(nextTriggers);
    }

    function findNodeLocation(id) {
      // v2 model: trigger.attachedMoveIds is an array of move-ID STRINGS,
      // not move objects. So the inner loop compares strings, not r.id.
      for (let i = 0; i < triggers.length; i++) {
        const n = triggers[i];
        if (n.id === id) {
          return { node: n, container: triggers, index: i, parent: null };
        }
        if (n.type === "trigger" && Array.isArray(n.attachedMoveIds)) {
          for (let j = 0; j < n.attachedMoveIds.length; j++) {
            if (n.attachedMoveIds[j] === id) {
              return { node: n, container: n.attachedMoveIds, index: j, parent: n };
            }
          }
        }
      }
      return null;
    }

    function moveNode(id, direction) {
      const loc = findNodeLocation(id);
      if (!loc) return;
      const newIndex = loc.index + direction;
      if (newIndex < 0 || newIndex >= loc.container.length) return;
      const nextContainer = [...loc.container];
      const tmp = nextContainer[loc.index];
      nextContainer[loc.index] = nextContainer[newIndex];
      nextContainer[newIndex] = tmp;
      let nextTriggers;
      if (loc.parent === null) {
        nextTriggers = nextContainer;
      } else {
        nextTriggers = triggers.map(function (n) {
          if (n.id === loc.parent.id) {
            return { ...n, attachedMoveIds: nextContainer };
          }
          return n;
        });
      }
      commitTriggers(nextTriggers);
    }

    function canMoveUp(id) {
      const loc = findNodeLocation(id);
      return loc !== null && loc.index > 0;
    }

    function canMoveDown(id) {
      const loc = findNodeLocation(id);
      return loc !== null && loc.index < loc.container.length - 1;
    }

    function isActiveMoveLocal(node) {
      return node && node.type === "move" && node.active !== false;
    }

    function toggleActive(id) {
      // v2 model: active lives on the TRIGGER, not on the move. The
      // "Activate/Deactivate" button on each move in the settings page is
      // repurposed to mean "detach the move from every trigger it's currently
      // attached to" (i.e. deactivate the move globally). The library entry
      // itself is kept (the move stays in the global library so it can be
      // re-attached later).
      const nextTriggers = triggers.map(function (node) {
        if (node.type === "trigger" && Array.isArray(node.attachedMoveIds)) {
          return {
            ...node,
            attachedMoveIds: node.attachedMoveIds.filter(function (mid) {
              return mid !== id;
            }),
          };
        }
        return node;
      });
      commitTriggers(nextTriggers);
    }

    function editNode(id, newText) {
      if (editingIdRef.current !== id) return;
      const trimmed = newText.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      // Check if the edited node is a trigger (name edit) or a move (text edit).
      const isTrigger = triggers.some(function (n) { return n.id === id && n.type === "trigger"; });
      if (isTrigger) {
        const nextTriggers = triggers.map(function (node) {
          if (node.id === id) {
            return { ...node, name: trimmed };
          }
          return node;
        });
        setEditingId(null);
        setTriggers(nextTriggers);
        saveTriggers(nextTriggers);
      } else {
        // Move text lives in the global moves array, not inside triggers.
        editMoveText(id, trimmed);
      }
    }

    function renderEditInput(node) {
      const currentValue = node.type === "trigger" ? node.name : node.text;
      return h("input", {
        ref: inputRef,
        className: "questing-adventurer-settings__edit-input",
        defaultValue: currentValue,
        onKeyDown: function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            editNode(node.id, e.target.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditingId(null);
          }
        },
        onBlur: function (e) {
          editNode(node.id, e.target.value);
        },
      });
    }

    async function createDeal() {
      const nextDeal = {
        code: makeDealCode(),
        createdAt: Date.now(),
        expiresAt: Date.now() + DEAL_TTL_MS,
        usedAt: null,
        action: "draw-trigger",
      };
      setDeal(nextDeal);
      setDealMessage("");
      try {
        await storage.saveKey("deal", nextDeal, DEAL_CS_KEY, "Questing Adventurer deal");
      } catch (err) {
        console.error("QuestingAdventurer: could not save deal", err);
        setDealMessage("Could not save the deal code.");
      }
    }

    async function copyDealLink() {
      if (!deal || !deal.code) return;
      const link = window.location.origin + PLUGIN_ROUTE + "?deal=" + encodeURIComponent(deal.code);
      try {
        await navigator.clipboard.writeText(link);
        setDealMessage("Link copied.");
      } catch (err) {
        setDealMessage(link);
      }
    }

    async function drawForPartner() {
      if (!deal || dealStatus(deal) !== "active") return;
      const inactive = triggers.filter(function (t) { return t.type === "trigger" && !t.active; });
      if (inactive.length === 0) {
        setDealMessage("No inactive triggers are available.");
        return;
      }
      const picked = inactive[Math.floor(Math.random() * inactive.length)];
      const nextTriggers = triggers.map(function (t) {
        return t.id === picked.id ? Object.assign({}, t, { active: true }) : t;
      });
      setTriggers(nextTriggers);
      saveTriggers(nextTriggers);
      const usedDeal = Object.assign({}, deal, { usedAt: Date.now() });
      setDeal(usedDeal);
      setDealMessage("Drew: " + picked.name);
      try {
        await storage.saveKey("deal", usedDeal, DEAL_CS_KEY, "Questing Adventurer partner");
      } catch (err) {
        console.error("QuestingAdventurer: could not mark deal used", err);
      }
    }

    async function saveHardware() {
      const stored = (await storage.loadConfig()) || {};
      const payload = Object.assign({}, stored, {
        moves: latestMoves || moves,
        triggers: latestTriggers || triggers,
        hardware: hardware,
      });
      try {
        await storage.saveConfig(payload, function (latest) {
          return Object.assign({}, latest || {}, {
            moves: latestMoves || moves,
            triggers: latestTriggers || triggers,
            hardware: hardware,
          });
        }, "Questing Adventurer hardware");
        setHardwareStatus("Saved.");
      } catch (err) {
        console.error("QuestingAdventurer: hardware save failed", err);
        setHardwareStatus("Could not save hardware settings.");
      }
    }

    function testHardware() {
      setHardwareStatus("Connecting…");
      let socket;
      try {
        socket = new WebSocket(hardware.url);
      } catch (err) {
        setHardwareStatus("Invalid WebSocket URL.");
        return;
      }
      const timer = setTimeout(function () {
        setHardwareStatus("No Intiface response within 3 seconds.");
        try { socket.close(); } catch (err) { /* ignore */ }
      }, 3000);
      socket.addEventListener("open", function () {
        socket.send(JSON.stringify({
          RequestServerInfo: { Id: 1, ClientName: "Questing Adventurer", MessageVersion: 1 },
        }));
      });
      socket.addEventListener("message", function (event) {
        let msg;
        try { msg = JSON.parse(event.data); } catch (err) { return; }
        if (msg.ServerInfo) {
          clearTimeout(timer);
          setHardwareStatus("Connected to Intiface.");
          socket.close();
        }
      });
      socket.addEventListener("error", function () {
        clearTimeout(timer);
        setHardwareStatus("Connection failed. Check that Intiface is running and the URL is reachable.");
      });
    }

    function renderHardwarePanel() {
      return h("section", { className: "questing-adventurer-settings__deal" },
        h("h2", null, "Hardware bridge (experimental)"),
        h("p", { className: "questing-adventurer-settings__deal-hint" },
          "Optional local Intiface/Buttplug connection. Disabled by default. ",
          "A completed move sends one vibration command; no hardware data is stored or sent anywhere else."
        ),
        h("label", { className: "questing-adventurer-settings__checkbox" },
          h("input", {
            type: "checkbox",
            checked: !!hardware.enabled,
            onChange: function (e) { setHardware(Object.assign({}, hardware, { enabled: !!e.target.checked })); },
          }),
          h("span", null, "Enable hardware bridge")
        ),
        h("div", { className: "questing-adventurer-settings__deal-row" },
          h("label", null,
            h("span", null, "WebSocket URL"),
            h("input", {
              type: "text",
              value: hardware.url,
              onChange: function (e) { setHardware(Object.assign({}, hardware, { url: e.target.value })); },
            })
          ),
          h("label", null,
            h("span", null, "Intensity (0–1)"),
            h("input", {
              type: "number",
              min: 0,
              max: 1,
              step: 0.05,
              value: hardware.intensity,
              onChange: function (e) {
                setHardware(Object.assign({}, hardware, {
                  intensity: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)),
                }));
              },
            })
          ),
          h("label", null,
            h("span", null, "Duration (ms)"),
            h("input", {
              type: "number",
              min: 100,
              max: 10000,
              step: 100,
              value: hardware.durationMs,
              onChange: function (e) {
                setHardware(Object.assign({}, hardware, {
                  durationMs: Math.max(100, Math.min(10000, parseInt(e.target.value, 10) || 1000)),
                }));
              },
            })
          )
        ),
        h("div", { className: "questing-adventurer-settings__deal-row" },
          h("button", { type: "button", onClick: saveHardware }, "Save hardware"),
          h("button", { type: "button", onClick: testHardware }, "Test connection")
        ),
        hardwareStatus ? h("p", { className: "questing-adventurer-settings__deal-message" }, hardwareStatus) : null
      );
    }

    function renderDealPanel() {
      const status = dealStatus(deal);
      return h("section", { className: "questing-adventurer-settings__deal" },
        h("h2", null, "Deal to a partner"),
        h("p", { className: "questing-adventurer-settings__deal-hint" },
          "Create a one-time code. Your partner must be able to open this Stash instance and sign in. ",
          "The code expires in 10 minutes and works once."
        ),
        h("div", { className: "questing-adventurer-settings__deal-row" },
          h("button", { type: "button", onClick: createDeal }, "Create deal code"),
          deal && status === "active"
            ? h("button", { type: "button", onClick: copyDealLink }, "Copy link")
            : null
        ),
        deal
          ? h("div", { className: "questing-adventurer-settings__deal-code" },
              h("strong", null, deal.code),
              h("span", null, " " + status)
            )
          : null,
        dealMessage ? h("p", { className: "questing-adventurer-settings__deal-message" }, dealMessage) : null
      );
    }

    function renderPartnerPanel() {
      const status = dealStatus(deal);
      return h("section", { className: "questing-adventurer-settings__deal questing-adventurer-settings__deal--partner" },
        h("h2", null, "Partner draw"),
        h("p", null, "Your partner is drawing one inactive trigger. This cannot be undone from this page."),
        deal
          ? h("div", { className: "questing-adventurer-settings__deal-code" },
              h("strong", null, deal.code),
              h("span", null, " " + status)
            )
          : null,
        dealMessage ? h("p", { className: "questing-adventurer-settings__deal-message" }, dealMessage) : null,
        status === "active"
          ? h("button", {
              type: "button",
              className: "questing-adventurer-settings__deal-draw",
              onClick: drawForPartner,
            }, "Draw a trigger")
          : null
      );
    }

    function updateTriggerTagPool(triggerId, field, tags) {
      const ids = (tags || []).map(function (t) { return String(t.id); });
      const next = triggers.map(function (t) {
        if (t.id !== triggerId) return t;
        return Object.assign({}, t, { [field]: ids });
      });
      setTriggers(next);
      saveTriggers(next);
    }

    // ── Playback rules ──────────────────────────────────────────────────
    function makeRuleId() {
      return "rule-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    function parseSceneId(text) {
      if (!text) return null;
      const url = String(text).match(/\/scenes\/(\d+)/);
      if (url) return url[1];
      const plain = String(text).trim().match(/^(\d+)$/);
      return plain ? plain[1] : null;
    }

    function formatClock(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return minutes + ":" + String(rest).padStart(2, "0");
    }

    async function loadSceneMarkers(sceneId) {
      const id = sceneId ? String(sceneId) : "";
      if (!id || markerRequests.current[id]) return;
      markerRequests.current[id] = true;
      setSceneMarkerCache(function (prev) {
        return Object.assign({}, prev, { [id]: { status: "loading", title: "", markers: [] } });
      });
      try {
        const response = await fetch("/graphql", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "query ($id: ID!) { findScene(id: $id) { title scene_markers { id seconds title } } }",
            variables: { id: id },
          }),
        });
        const payload = await response.json();
        if (payload.errors && payload.errors.length) throw new Error(payload.errors[0].message);
        const scene = payload.data && payload.data.findScene;
        setSceneMarkerCache(function (prev) {
          return Object.assign({}, prev, {
            [id]: {
              status: "ready",
              title: scene && scene.title ? scene.title : "",
              markers: scene && Array.isArray(scene.scene_markers)
                ? scene.scene_markers.map(function (m) {
                    return {
                      id: String(m.id),
                      seconds: typeof m.seconds === "number" ? m.seconds : 0,
                      title: m.title || "",
                    };
                  })
                : [],
            },
          });
        });
      } catch (err) {
        console.error("QuestingAdventurer settings: marker lookup failed for scene " + id, err);
        markerRequests.current[id] = false;
        setSceneMarkerCache(function (prev) {
          return Object.assign({}, prev, { [id]: { status: "error", title: "", markers: [] } });
        });
      }
    }

    function updateAutoRules(triggerId, updater) {
      const next = triggers.map(function (trigger) {
        if (trigger.id !== triggerId) return trigger;
        return Object.assign({}, trigger, { autoRules: updater(trigger.autoRules || []) });
      });
      setTriggers(next);
      saveTriggers(next);
    }

    function addAutoRule(triggerId) {
      const sceneId = parseSceneId(autoDraft[triggerId]);
      if (!sceneId) return;
      updateAutoRules(triggerId, function (rules) {
        return rules.concat([{
          id: makeRuleId(),
          sceneId: sceneId,
          markerId: null,
          atSeconds: null,
          moveId: null,
          repeat: "once",
        }]);
      });
      setAutoDraft(function (prev) {
        const next = Object.assign({}, prev);
        delete next[triggerId];
        return next;
      });
      loadSceneMarkers(sceneId);
    }

    function patchAutoRule(triggerId, ruleId, patch) {
      updateAutoRules(triggerId, function (rules) {
        return rules.map(function (rule) {
          return rule.id === ruleId ? Object.assign({}, rule, patch) : rule;
        });
      });
    }

    function removeAutoRule(triggerId, ruleId) {
      updateAutoRules(triggerId, function (rules) {
        return rules.filter(function (rule) { return rule.id !== ruleId; });
      });
    }

    function renderAutoRule(trigger, rule) {
      const cache = sceneMarkerCache[rule.sceneId] || { status: "idle", title: "", markers: [] };
      const markers = cache.markers || [];
      const hasTimeOnly = !rule.markerId && typeof rule.atSeconds === "number";
      const markerValue = rule.markerId || (hasTimeOnly ? "time" : "");
      return h(
        "div",
        { key: rule.id, className: "questing-adventurer-settings__auto-rule" },
        h(
          "span",
          {
            className: "questing-adventurer-settings__auto-scene",
            title: "Scene #" + rule.sceneId + (cache.status === "error" ? " (markers unavailable)" : ""),
          },
          cache.title || ("#" + rule.sceneId)
        ),
        h(
          "select",
          {
            className: "questing-adventurer-settings__auto-select",
            value: markerValue,
            onChange: function (e) {
              const value = e.target.value;
              if (value === "") {
                patchAutoRule(trigger.id, rule.id, { markerId: null, atSeconds: null });
              } else if (value === "time") {
                patchAutoRule(trigger.id, rule.id, { markerId: null });
              } else {
                patchAutoRule(trigger.id, rule.id, { markerId: value, atSeconds: null });
              }
            },
          },
          h("option", { value: "" }, "On scene open"),
          markers.map(function (marker) {
            return h(
              "option",
              { key: marker.id, value: marker.id },
              formatClock(marker.seconds) + " \u00b7 " + (marker.title || "Marker")
            );
          }),
          hasTimeOnly
            ? h("option", { value: "time" }, "At " + formatClock(rule.atSeconds) + " (no marker)")
            : null
        ),
        h(
          "select",
          {
            className: "questing-adventurer-settings__auto-select",
            value: rule.moveId || "",
            onChange: function (e) {
              patchAutoRule(trigger.id, rule.id, { moveId: e.target.value || null });
            },
          },
          h("option", { value: "" }, "Attach no move"),
          moves.map(function (move) {
            return h("option", { key: move.id, value: move.id }, move.text);
          })
        ),
        h(
          "label",
          {
            className: "questing-adventurer-settings__auto-repeat",
            title: "Re-arm when the trigger is cleared before the marker is crossed again",
          },
          h("input", {
            type: "checkbox",
            checked: rule.repeat === "every",
            onChange: function (e) {
              patchAutoRule(trigger.id, rule.id, { repeat: e.target.checked ? "every" : "once" });
            },
          }),
          "Re-arm"
        ),
        h(
          "button",
          {
            className: "questing-adventurer-settings__auto-remove",
            title: "Remove this playback rule",
            "aria-label": "Remove playback rule for scene " + rule.sceneId,
            onClick: function () { removeAutoRule(trigger.id, rule.id); },
          },
          "\u00d7"
        )
      );
    }

    // ── Tag bindings ────────────────────────────────────────────────────
    // One row per "this tag → this trigger (+ optional move)". Rows are stored
    // at the top level of the config, not on the trigger, because the table is
    // keyed by tag and the overlay has to resolve a tag to a trigger id before
    // it can look the trigger up.
    //
    // The whole table is edited in place: picking a tag in the add picker
    // appends a row and immediately pre-selects the first trigger, so there is
    // no half-built draft to discard and an incomplete row stays visible (with
    // its warning) instead of silently vanishing.
    function makeTagBindingId() {
      return "tag-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    // TagIDSelect returns Tag[] in every build this plugin targets, but a
    // single-select variant has returned one Tag in the past. Both shapes are
    // accepted here so a component change cannot write "[object Object]" as a
    // tag id into the config.
    function tagIdsFromSelect(value) {
      if (!value) return [];
      const list = Array.isArray(value) ? value : [value];
      const ids = [];
      for (const item of list) {
        if (item === null || item === undefined) continue;
        const raw = item && item.id !== undefined && item.id !== null ? item.id : item;
        const text = String(raw).trim();
        if (text) ids.push(text);
      }
      return ids;
    }

    function commitTagBindings(next) {
      const normalized = shared.normalizeTagBindings(next);
      latestTagBindings = normalized;
      setTagBindings(normalized);
      saveTriggersNow();
    }

    function addTagBinding(value) {
      const ids = tagIdsFromSelect(value);
      const tagId = ids[0];
      // No tag, nothing to bind. (Clearing the picker fires this with [].)
      if (!tagId) return;
      const firstTrigger = triggers.find(function (t) { return t.type === "trigger"; });
      setTagAddSeq(function (n) { return n + 1; });
      commitTagBindings(tagBindings.concat([{
        id: makeTagBindingId(),
        tagId: tagId,
        triggerId: firstTrigger ? firstTrigger.id : null,
        moveId: null,
      }]));
    }

    function patchTagBinding(id, patch) {
      commitTagBindings(tagBindings.map(function (binding) {
        return binding.id === id ? Object.assign({}, binding, patch) : binding;
      }));
    }

    function removeTagBinding(id) {
      commitTagBindings(tagBindings.filter(function (binding) {
        return binding.id !== id;
      }));
    }

    function renderTagBinding(binding) {
      const TagSelect = PluginApi.components && PluginApi.components.TagIDSelect;
      const trigger = triggers.find(function (t) {
        return t.type === "trigger" && t.id === binding.triggerId;
      });
      const move = binding.moveId
        ? moves.find(function (m) { return m.id === binding.moveId; })
        : null;
      const problems = shared.describeBindingProblems(
        binding,
        function (id) {
          return triggers.some(function (t) { return t.type === "trigger" && t.id === id; });
        },
        function (id) { return moves.some(function (m) { return m.id === id; }); }
      );
      const blocked = problems.some(function (p) { return p.blocking; });
      const rowClass =
        "questing-adventurer-settings__tag-binding" +
        (problems.length > 0 ? " questing-adventurer-settings__tag-binding--invalid" : "");
      return h(
        "div",
        { key: binding.id, className: rowClass },
        TagSelect
          ? h(
              "div",
              { className: "questing-adventurer-settings__tag-binding-picker" },
              h(TagSelect, {
                key: "row-tag-" + binding.id + "-" + tagPickerEpoch,
                ids: [binding.tagId],
                isMulti: false,
                onSelect: function (tags) {
                  const ids = tagIdsFromSelect(tags);
                  // A row without a tag can never fire, and dropping the whole
                  // row because of a stray clear would lose its trigger/move.
                  // Keep the stored tag and remount the picker so it shows it
                  // again instead of sitting blank.
                  if (ids.length === 0) {
                    setTagPickerEpoch(function (n) { return n + 1; });
                    return;
                  }
                  patchTagBinding(binding.id, { tagId: ids[0] });
                },
              })
            )
          : h(
              "div",
              { className: "questing-adventurer-settings__tag-binding-id" },
              "#" + binding.tagId
            ),
        h(
          "select",
          {
            className: "questing-adventurer-settings__auto-select",
            "aria-label": "Trigger bound to tag " + binding.tagId,
            value: binding.triggerId || "",
            onChange: function (e) {
              patchTagBinding(binding.id, { triggerId: e.target.value || null });
            },
          },
          h("option", { value: "" }, "Select a trigger\u2026"),
          binding.triggerId && !trigger
            ? h("option", { value: binding.triggerId }, "Missing trigger #" + binding.triggerId)
            : null,
          triggers
            .filter(function (t) { return t.type === "trigger"; })
            .map(function (t) {
              return h("option", { key: t.id, value: t.id }, t.name);
            })
        ),
        h(
          "select",
          {
            className: "questing-adventurer-settings__auto-select",
            "aria-label": "Move attached by the binding for tag " + binding.tagId,
            value: binding.moveId || "",
            onChange: function (e) {
              patchTagBinding(binding.id, { moveId: e.target.value || null });
            },
          },
          h("option", { value: "" }, "Attach no move"),
          binding.moveId && !move
            ? h("option", { value: binding.moveId }, "Missing move #" + binding.moveId)
            : null,
          moves.map(function (m) {
            return h("option", { key: m.id, value: m.id }, m.text);
          })
        ),
        h(
          "button",
          {
            className: "questing-adventurer-settings__auto-remove",
            title: "Remove this tag binding",
            "aria-label": "Remove tag binding for tag " + binding.tagId,
            onClick: function () { removeTagBinding(binding.id); },
          },
          "\u00d7"
        ),
        problems.length > 0
          ? h(
              "span",
              { className: "questing-adventurer-settings__tag-binding-warning" },
              problems.map(function (p) { return p.message; }).join(" \u00b7 ") +
                (blocked
                  ? " \u2014 this binding will not fire."
                  : " \u2014 the trigger still fires, without the move.")
            )
          : null
      );
    }

    function renderTagBindingsSection() {
      const TagSelect = PluginApi.components && PluginApi.components.TagIDSelect;
      return h(
        "div",
        { className: "questing-adventurer-settings__section" },
        h("h3", { className: "questing-adventurer-settings__section-header" }, "Tag Bindings"),
        h(
          "p",
          { className: "questing-adventurer-settings__section-hint" },
          "When a scene carries a bound tag, the trigger is activated and the move attached as playback starts. ",
          "Each binding fires once per scene open; a scene carrying several bound tags fires each of them, ",
          "and two tags naming the same trigger/move pair still fire once."
        ),
        tagBindings.length === 0
          ? h(
              "div",
              { className: "questing-adventurer-settings__empty" },
              "No tag bindings yet. Pick a tag below to create the first one."
            )
          : tagBindings.map(function (binding) {
              return renderTagBinding(binding);
            }),
        h(
          "div",
          { className: "questing-adventurer-settings__tag-binding-add" },
          h("span", { className: "questing-adventurer-settings__tag-binding-add-label" }, "Bind a tag"),
          TagSelect
            ? h(
                "div",
                { className: "questing-adventurer-settings__tag-binding-add-picker" },
                h(TagSelect, {
                  // Remount after each add: the picker keeps its own internal
                  // selection, so without a fresh key it would still show the
                  // tag that was just bound.
                  key: "tag-add-" + tagAddSeq,
                  ids: [],
                  isMulti: false,
                  onSelect: addTagBinding,
                })
              )
            : h(
                "span",
                { className: "questing-adventurer-settings__tag-binding-warning" },
                "TagIDSelect is unavailable in this Stash build, so tags cannot be picked here."
              )
        )
      );
    }

    function renderTrigger(trigger) {
      const TagSelect = PluginApi.components && PluginApi.components.TagIDSelect;
      return h(
        "div",
        { key: trigger.id, className: "questing-adventurer-settings__trigger" },
        h(
          "span",
          { className: "questing-adventurer-settings__trigger-name" },
          editingId === trigger.id
            ? renderEditInput(trigger)
            : h(
                "span",
                {
                  title: "Double-click to edit",
                  onDoubleClick: function () {
                    setEditingId(trigger.id);
                  },
                },
                trigger.name
              )
        ),
        h(
          "span",
          { className: "questing-adventurer-settings__controls" },
          h(
            "button",
            {
              title: "Move up",
              "aria-label": "Move trigger up",
              disabled: !canMoveUp(trigger.id),
              onClick: function () {
                moveNode(trigger.id, -1);
              },
            },
            "\u25b2"
          ),
          h(
            "button",
            {
              title: "Move down",
              "aria-label": "Move trigger down",
              disabled: !canMoveDown(trigger.id),
              onClick: function () {
                moveNode(trigger.id, 1);
              },
            },
            "\u25bc"
          ),
          h(
            "button",
            {
              title: "Add move to this trigger",
              disabled: footerText.trim() === "",
              onClick: function () {
                addMoveInto(trigger.id, footerText);
                setFooterText("");
              },
            },
            "+"
          ),
          h(
            "button",
            {
              title: "Delete trigger",
              className: "questing-adventurer-settings__delete-btn",
                onClick: function () {
                  deleteTrigger(trigger.id);
                },
            },
            "×"
          )
        ),
        TagSelect
          ? h(
              "div",
              { className: "questing-adventurer-settings__tag-pools" },
              h(
                "label",
                null,
                h("span", null, "Scene tags (empty = every scene)"),
                h(TagSelect, {
                  ids: trigger.sceneTagIds || [],
                  isMulti: true,
                  onSelect: function (tags) { updateTriggerTagPool(trigger.id, "sceneTagIds", tags); },
                })
              ),
              h(
                "label",
                null,
                h("span", null, "Marker tags (timed prompts)"),
                h(TagSelect, {
                  ids: trigger.markerTagIds || [],
                  isMulti: true,
                  onSelect: function (tags) { updateTriggerTagPool(trigger.id, "markerTagIds", tags); },
                })
              )
            )
          : null,
        h(
          "div",
          { className: "questing-adventurer-settings__auto" },
          h(
            "div",
            { className: "questing-adventurer-settings__auto-head" },
            h("span", null, "Playback triggers"),
            h(
              "span",
              { className: "questing-adventurer-settings__auto-hint" },
              "Activate automatically and attach a move on scene open or at a marker"
            )
          ),
          (trigger.autoRules || []).map(function (rule) {
            return renderAutoRule(trigger, rule);
          }),
          h(
            "div",
            { className: "questing-adventurer-settings__auto-add" },
            h("input", {
              type: "text",
              className: "questing-adventurer-settings__auto-input",
              placeholder: "Scene ID or /scenes/123 URL",
              "aria-label": "Scene to bind to " + trigger.name,
              value: autoDraft[trigger.id] || "",
              onChange: function (e) {
                const value = e.target.value;
                setAutoDraft(function (prev) {
                  return Object.assign({}, prev, { [trigger.id]: value });
                });
              },
              onKeyDown: function (e) {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAutoRule(trigger.id);
                }
              },
            }),
            h(
              "button",
              {
                className: "questing-adventurer-settings__auto-add-btn",
                disabled: !parseSceneId(autoDraft[trigger.id]),
                onClick: function () { addAutoRule(trigger.id); },
              },
              "Add scene"
            )
          )
        ),
        (trigger.attachedMoveIds || []).map(function (moveId) {
          const move = moves.find(function (m) { return m.id === moveId; });
          if (!move) return null;
          return renderMove(move, true);
        })
      );
    }

    function renderMove(move, indented) {
      return h(
        "div",
        {
          key: move.id,
          className:
            "questing-adventurer-settings__move" +
            (indented ? " questing-adventurer-settings__move--indented" : ""),
        },
        h(
          "span",
          { className: "questing-adventurer-settings__move-text" },
          editingId === move.id
            ? renderEditInput(move)
            : h(
                "span",
                {
                  title: "Double-click to edit",
                  onDoubleClick: function () {
                    setEditingId(move.id);
                  },
                },
                move.text
              )
        ),
        h(
          "span",
          { className: "questing-adventurer-settings__controls" },
          h(
            "button",
            {
              title: "Move up",
              "aria-label": "Move move up",
              disabled: !canMoveUp(move.id),
              onClick: function () {
                moveNode(move.id, -1);
              },
            },
            "\u25b2"
          ),
          h(
            "button",
            {
              title: "Move down",
              "aria-label": "Move move down",
              disabled: !canMoveDown(move.id),
              onClick: function () {
                moveNode(move.id, 1);
              },
            },
            "\u25bc"
          ),
          h(
            "button",
            {
              title: isActiveMoveLocal(move) ? "Deactivate move" : "Activate move",
              "aria-label": isActiveMoveLocal(move) ? "Deactivate move" : "Activate move",
              "aria-pressed": isActiveMoveLocal(move) ? "true" : "false",
              className: isActiveMoveLocal(move)
                ? "questing-adventurer-settings__active-btn"
                : "questing-adventurer-settings__inactive-btn",
              onClick: function () {
                toggleActive(move.id);
              },
            },
            isActiveMoveLocal(move) ? "\u25cf" : "\u25cb"
          ),
          h(
            "button",
            {
              title: "Delete move",
              className: "questing-adventurer-settings__delete-btn",
              onClick: function () {
                deleteMove(move.id);
              },
            },
            "×"
          )
        )
      );
    }

    const footerDisabled = footerText.trim() === "";

    function deleteMoveFromLibrary(id) {
      const nextMoves = moves.filter(function (m) { return m.id !== id; });
      const nextTriggers = triggers.map(function (node) {
        if (node.type === "trigger" && (node.attachedMoveIds || []).indexOf(id) !== -1) {
          return {
            ...node,
            attachedMoveIds: node.attachedMoveIds.filter(function (m) { return m !== id; }),
          };
        }
        return node;
      });
      setMoves(nextMoves);
      saveMoves(nextMoves);
      commitTriggers(nextTriggers);
    }

    function editMoveText(id, newText) {
      if (editingIdRef.current !== id) return;
      const trimmed = newText.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      const nextMoves = moves.map(function (m) {
        if (m.id === id) {
          return { ...m, text: trimmed };
        }
        return m;
      });
      setEditingId(null);
      setMoves(nextMoves);
      saveMoves(nextMoves);
    }

    function findReferencingTriggers(moveId) {
      return triggers.filter(function (t) {
        return (t.attachedMoveIds || []).indexOf(moveId) !== -1;
      });
    }

    function renderMoveLibrary() {
      return h(
        "div",
        { className: "questing-adventurer-settings__section" },
        h("h3", { className: "questing-adventurer-settings__section-header" }, "Move Library"),
        moves.length === 0
          ? h(
              "div",
              { className: "questing-adventurer-settings__empty" },
              "No moves yet. Add some via the footer or via a trigger's + button."
            )
          : moves.map(function (move) {
              const referencedBy = findReferencingTriggers(move.id);
              return h(
                "div",
                {
                  key: move.id,
                  className: "questing-adventurer-settings__move-library-item",
                },
                h(
                  "span",
                  { className: "questing-adventurer-settings__move-library-text" },
                  editingId === move.id
                    ? h("input", {
                        ref: inputRef,
                        className: "questing-adventurer-settings__edit-input",
                        defaultValue: move.text,
                        onKeyDown: function (e) {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            editMoveText(move.id, e.target.value);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId(null);
                          }
                        },
                        onBlur: function (e) {
                          editMoveText(move.id, e.target.value);
                        },
                      })
                    : h(
                        "span",
                        {
                          title: "Double-click to edit",
                          onDoubleClick: function () {
                            setEditingId(move.id);
                          },
                        },
                        move.text
                      )
                ),
                h(
                  "span",
                  { className: "questing-adventurer-settings__move-references" },
                  referencedBy.length === 0
                    ? h("em", null, "Unattached")
                    : "Used by: " + referencedBy.map(function (t) { return t.name; }).join(", ")
                ),
                h(
                  "span",
                  { className: "questing-adventurer-settings__controls" },
                  h(
                    "button",
                    {
                      title:
                        referencedBy.length > 0
                          ? "Delete move (detaches from " + referencedBy.length + " trigger(s))"
                          : "Delete move",
                      className: "questing-adventurer-settings__delete-btn",
                      onClick: function () {
                        const boundTags = tagBindings.filter(function (b) {
                          return b.moveId === move.id;
                        }).length;
                        if (referencedBy.length > 0 || boundTags > 0) {
                          const parts = [];
                          if (referencedBy.length > 0) {
                            parts.push(
                              "It is currently attached to " +
                                referencedBy.length +
                                " trigger(s) and will be detached from all of them."
                            );
                          }
                          if (boundTags > 0) {
                            parts.push(
                              boundTags +
                                " tag binding(s) use it and will keep firing without the move."
                            );
                          }
                          const ok = window.confirm(
                            'Delete move "' + move.text + '"? ' + parts.join(" ")
                          );
                          if (!ok) return;
                        }
                        deleteMoveFromLibrary(move.id);
                      },
                    },
                    "×"
                  )
                )
              );
            })
      );
    }

    if (loading) {
      return h("div", { className: "questing-adventurer-settings" },
        h("h2", { className: "questing-adventurer-settings__header" }, "Questing Adventurer"),
        h("div", null, "Loading...")
      );
    }

    if (partnerMode) {
      return h("div", { className: "questing-adventurer-settings" },
        h("h2", { className: "questing-adventurer-settings__header" }, "Questing Adventurer"),
        renderPartnerPanel()
      );
    }

    return h(
      "div",
      { className: "questing-adventurer-settings" },
      h("h2", { className: "questing-adventurer-settings__header" }, "Questing Adventurer"),
      h(
        "div",
        { className: "questing-adventurer-settings__body" },
        renderDealPanel(),
        renderHardwarePanel(),
        renderMoveLibrary(),
        renderTagBindingsSection(),
            h("h3", { className: "questing-adventurer-settings__section-header" }, "Triggers"),
            triggers.length === 0
              ? h(
                  "div",
                  { className: "questing-adventurer-settings__empty" },
                  "No triggers yet. Add one below."
                )
              : triggers.map(function (trigger) {
                  return renderTrigger(trigger);
                }),
            h(
              "div",
              { className: "questing-adventurer-settings__footer" },
              h("input", {
                type: "text",
                className: "questing-adventurer-settings__input",
                value: footerText,
                placeholder: "New trigger or move name",
                onChange: function (e) {
                  setFooterText(e.target.value);
                },
                onKeyDown: function (e) {
                  if (e.key === "Enter" && !footerDisabled) {
                    addMoveTop(footerText);
                    setFooterText("");
                  }
                },
              }),
              h(
                "button",
                {
                  disabled: footerDisabled,
                  onClick: function () {
                    addTriggerTop(footerText);
                    setFooterText("");
                  },
                },
                "Add Trigger"
              ),
              h(
                "button",
                {
                  disabled: footerDisabled,
                  onClick: function () {
                    addMoveTop(footerText);
                    setFooterText("");
                  },
                },
                "Add Move"
              )
            )
      )
    );
  }

  PluginApi.patch.before("PluginRoutes", function (props) {
    const newChildren = h(
      React.Fragment,
      null,
      props.children,
      h(Route, { path: PLUGIN_ROUTE, component: QuestingAdventurerSettingsPage })
    );
    return [Object.assign({}, props, { children: newChildren })];
  });

  // The launcher is not one of Stash's own rows: the two above it are Stash's
  // tools and a plugin's page is a different kind of thing. It goes into a
  // group of its own at the bottom of the same card — a label row, then
  // `.setting` rows — so Stash's list stays Stash's.
  //
  // The group is shared by the four plugins that put a tool there. Stash
  // exposes no patch container above the section (`SettingSection` is not
  // patchable), so this cannot be a third section: the first plugin to render
  // creates the group and the rest find it in `props.children` and append their
  // row. Staying inside React's tree is deliberate — no DOM surgery under a
  // component that owns those nodes.
  const GROUP_MARK = "data-plugin-tools";

  function withLauncherGroup(props, row) {
    const children = Array.isArray(props.children) ? [...props.children] : [props.children];
    const at = children.findIndex(
      (child) => child && child.props && child.props[GROUP_MARK] !== undefined
    );

    if (at < 0) {
      const label = h(
        "div",
        { className: "setting", "data-plugin-tools-label": "1" },
        h("div", null, h("div", { className: "sub-heading" }, "Plugin tools")),
        h("div")
      );
      children.push(h("div", { "data-plugin-tools": "1" }, label, row));
    } else {
      const group = children[at];
      const rows = Array.isArray(group.props.children)
        ? [...group.props.children, row]
        : [group.props.children, row];
      children[at] = h(group.type, Object.assign({}, group.props, { children: rows }));
    }

    return [Object.assign({}, props, { children })];
  }

  PluginApi.patch.before("SettingsToolsSection", function (props) {
    settingsToolsCallCount += 1;
    // SettingsToolsPanel.tsx renders the same PatchContainerComponent twice
    // in fixed order: 1st = general "Tools" (config.tools.heading), 2nd =
    // "Scene Tools". React re-renders fire the pair in the same order, so
    // parity (odd = Tools, even = Scene Tools) is the correct gate. The
    // launcher belongs to "Tools" — a plugin page is a tool, not a scene
    // operation — so the even call passes through.
    // Assumption documented because if Stash ever renders only one instance or
    // swaps the order, the group lands in the wrong section.
    if (settingsToolsCallCount % 2 === 0) {
      return [props];
    }
    // A `.setting` row: heading on the left, an empty action column on the
    // right (the label itself is the link). Stash owns the padding, the
    // separator and the heading size, so the row stays in Stash's visual
    // language in every theme, including none.
    const row = h(
      "div",
      { className: "setting" },
      h(
        "div",
        null,
        h("h3", null, h(Link, { to: PLUGIN_ROUTE }, "Questing Adventurer")),
        h("div", { className: "sub-heading" }, "Manage quests and moves")
      ),
      h("div")
    );
    return withLauncherGroup(props, row);
  });
})();
