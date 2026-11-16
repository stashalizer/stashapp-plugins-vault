/**
 * QuestingAdventurerSettings — full-page CRUD settings UI.
 *
 * Architecture:
 * - Registers a route via PluginApi.patch.before("PluginRoutes", ...) at
 *   /plugins/questingadventurer.
 * - Adds a launcher card in Settings > Tools via
 *   PluginApi.patch.before("SettingsToolsSection", ...). The launcher appears
 *   only under the "Scene Tools" subsection (the second SettingsToolsSection
 *   instance in SettingsToolsPanel) by gating on a module-level call counter.
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

  let settingsToolsCallCount = 0;
  let saving = false;
  let pendingSave = false;
  let latestTriggers = null;
  let latestMoves = null;

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
      const triggersToSave = latestTriggers || [];
      const movesToSave = latestMoves || [];
      const stored = (await storage.loadConfig()) || {};
      const merged = {
        moves: movesToSave,
        triggers: triggersToSave,
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
    const inputRef = useRef(null);
    const editingIdRef = useRef(null);

    useEffect(function () {
      let mounted = true;

      function finish(movesArr, triggersArr) {
        if (!mounted) return;
        setMoves(movesArr);
        setTriggers(triggersArr);
        setLoading(false);
      }

      (async function () {
        try {
          await migrateFromLegacy();
          const stored = await storage.loadConfig();
          if (stored && Array.isArray(stored.moves) && Array.isArray(stored.triggers)) {
            // v2 format
            finish(stored.moves, stored.triggers);
          } else {
            // v1' format → migrate to v2
            const migrated = migrateV1ToV2(stored);
            finish(migrated.moves, migrated.triggers);
            // Persist the migrated form
            saveMoves(migrated.moves);
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
          finish([], []);
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
      const confirmed = window.confirm(
        'Delete trigger "' + q.name + '" and its ' + itemCount + " move(s)?"
      );
      if (!confirmed) return;
      const nextTriggers = triggers.filter(function (n) {
        return !(n.type === "trigger" && n.id === id);
      });
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
                        if (referencedBy.length > 0) {
                          const ok = window.confirm(
                            'Delete move "' +
                              move.text +
                              '"? It is currently attached to ' +
                              referencedBy.length +
                              " trigger(s) and will be detached from all of them."
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

  PluginApi.patch.before("SettingsToolsSection", function (props) {
    settingsToolsCallCount += 1;
    // SettingsToolsPanel.tsx renders the same PatchContainerComponent twice
    // in fixed order: 1st = general "Tools", 2nd = "Scene Tools". React
    // re-renders fire the pair in the same order, so parity (odd = Tools,
    // even = Scene Tools) is the correct gate. Assumption documented because
    // if Stash ever renders only one instance or swaps the order, the card
    // lands in the wrong section.
    if (settingsToolsCallCount % 2 !== 0) {
      return [props];
    }
    const card = h(
      Link,
      { to: PLUGIN_ROUTE, className: "questing-adventurer-settings__launcher" },
      h(
        "div",
        { className: "questing-adventurer-settings__launcher-card" },
        h("h3", null, "Questing Adventurer"),
        h("p", null, "Manage quests and moves")
      )
    );
    const newChildren = Array.isArray(props.children)
      ? [...props.children, card]
      : [props.children, card];
    return [Object.assign({}, props, { children: newChildren })];
  });
})();
