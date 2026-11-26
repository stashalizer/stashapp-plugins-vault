/**
 * QuestingAdventurer plugin — player overlay
 *
 * Architecture:
 * - Uses csLib.PathElementListener to inject on /scenes/ when #VideoJsPlayer exists,
 *   and on subsequent stash:location SPA navigations.
 * - Adds an extra window.PluginApi.Event "stash:location" safety net to re-inject the
 *   panel if React re-renders remove it. There can be a brief flash between removal
 *   and re-injection.
 * - Enforces a 2-level structure: top-level nodes are either standalone moves or
 *   quests; quests contain only leaf moves.
 * - The overlay owns the `collapsed` flag and the `opacity` value (the
 *   background-alpha control). All state mutations are persisted via
 *   csLib.setConfiguration("QuestingAdventurer", state) wrapped in a lock to
 *   avoid concurrent saves.
 * - One-shot migration: on first load, if no "QuestingAdventurer" config exists but a
 *   legacy "SceneRules" config does, copy the data over (marking every move active)
 *   and clear the old key. Safe to run repeatedly; no-ops once migration is done.
 */
(function () {
  "use strict";

  const csLib = window.csLib;
  if (!csLib) {
    console.error("QuestingAdventurer: CommunityScriptsUILibrary not loaded. Install it first.");
    return;
  }

  const storage = window.QuestingAdventurerStorage || {
    loadConfig: function () { return csLib.getConfiguration("QuestingAdventurer").then(function (v) { return v || {}; }); },
    saveConfig: function (value) { return csLib.setConfiguration("QuestingAdventurer", value); },
    loadKey: function () { return Promise.resolve(null); },
    saveKey: function () { return Promise.resolve(false); },
  };

  // Pure tag-binding model. Falls back to an inert stub so a stale cached
  // `index.yml` (one that does not list QuestingAdventurerShared.js yet) costs
  // the tag bindings, not the whole overlay.
  const shared = window.QuestingAdventurerShared || {
    normalizeTagBindings: function () { return []; },
    resolveTagBindings: function () { return []; },
    describeBindingProblems: function () { return []; },
  };

  const CONFIG_KEY = "QuestingAdventurer";
  const LEGACY_CONFIG_KEY = "SceneRules";
  const DEFAULT_OPACITY = 0.6;
  const DEFAULT_PANEL_POS = { top: 8, right: 8 };
  const DEFAULT_PANEL_WIDTH = 360;

  let state = {
    moves: [],
    triggers: [],
    // Tag → trigger/move bindings: `[{ id, tagId, triggerId, moveId }]`.
    // Top-level rather than per-trigger because the settings page edits them
    // as one table keyed by tag, and the overlay resolves them before it knows
    // which trigger they point at. Owned by the settings page, but preserved
    // verbatim by every overlay save.
    tagBindings: [],
    collapsed: undefined,
    opacity: DEFAULT_OPACITY,
    panelPos: { ...DEFAULT_PANEL_POS },
    panelSize: { width: DEFAULT_PANEL_WIDTH, height: undefined },
    showAddControls: false,
    // Toggles the "Library" section in the expanded overlay — a manual-control
    // surface where the user can (a) activate any inactive trigger and
    // (b) attach any library move to any trigger (active or inactive — if
    // the target is inactive, the attach also activates it). Lives next to
    // showAddControls as a sibling view flag, persisted independently so
    // the user's preferred panel state survives reloads.
    showManualControls: false,
  };
  let editingId = null;
  let saving = false;
  let pendingSave = false;
  let dragState = null; // { sourceId, startX, startY, isDragging, ghost, sourceRow, list, panel }
  // When the user drags the collapsed chip (or the expanded header) past the
  // drag threshold, we set this flag so the subsequent `click` event (which
  // the browser fires after pointerup) is suppressed — otherwise dragging
  // the chip would also toggle collapse. Reset on every pointerup.
  let suppressNextClick = false;

  // ── Quest Log ────────────────────────────────────────────────────────
  // Layout: one session per playthrough of one scene → one run per time a
  // trigger becomes active inside that session → one completion per
  // (run, move) pair.
  //
  // A run is NOT a count of how often the trigger happened on screen. The
  // plugin cannot observe that: `active` is a persisted flag rather than an
  // episode, and the only repeatable on-screen signal is a scene marker.
  // Runs are therefore a lower bound ("this many times the trigger was
  // switched on while you watched") and the UI never claims more.
  //
  // Progress is derived from the event list on every render; no completion
  // boolean is persisted. Undo appends an event instead of deleting one, so
  // "what was ticked, and when" stays answerable.
  //
  // Sessions are stored outside the plugin's settings object. Suite Data is
  // preferred; csLib is the backward-compatible fallback.
  const LOG_KEY = "log";
  const LOG_CS_KEY = "QuestingAdventurerLog";
  const LOG_SCHEMA = 2;
  const MAX_SESSIONS = 200;
  const MAX_EVENTS_PER_SESSION = 2000;
  let questLog = { schema: LOG_SCHEMA, sessions: [] };
  let currentSession = null;
  let openRuns = {}; // triggerId -> runId for the session in progress
  let currentSceneId = null;
  let logSaving = false;
  let logPending = false;
  let logSaveTimer = null;
  let sessionStateCache = null;
  let statsCache = null;
  let hardwareConfig = { enabled: false, url: "ws://localhost:12345", intensity: 0.4, durationMs: 1000 };

  function dayKey(timestamp) {
    const d = new Date(timestamp);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + month + "-" + day;
  }

  function currentPlaybackSeconds() {
    const video = document.querySelector("#VideoJsPlayer video");
    if (!video || typeof video.currentTime !== "number" || !isFinite(video.currentTime)) return null;
    return Math.round(video.currentTime * 10) / 10;
  }

  function runItemKey(runId, moveId) {
    return runId + "\u0000" + moveId;
  }

  // Fold the append-only event list into the state the UI renders. Everything
  // completion-related is derived here — there is no stored boolean, so an
  // undo is just another event.
  function foldEvents(events) {
    const runs = [];
    const byId = {};
    const done = {};
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (event.type === "trigger-activated" && event.runId) {
        const run = {
          id: event.runId,
          triggerId: event.triggerId ? String(event.triggerId) : "",
          triggerName: event.triggerName || "",
          run: typeof event.run === "number" ? event.run : 0,
          at: typeof event.at === "number" ? event.at : null,
          atSeconds: typeof event.atSeconds === "number" ? event.atSeconds : null,
          origin: event.origin || event.source || "unknown",
          observedBy: event.observedBy || "state",
          markerId: event.markerId || null,
          closedAt: null,
          closeReason: null,
        };
        runs.push(run);
        byId[run.id] = run;
      } else if (event.type === "trigger-deactivated" && event.runId) {
        const run = byId[event.runId];
        if (run) {
          run.closedAt = typeof event.at === "number" ? event.at : null;
          run.closeReason = event.reason || "unknown";
        }
      } else if (event.type === "move-completed" && event.runId && event.moveId) {
        done[runItemKey(event.runId, event.moveId)] = typeof event.at === "number" ? event.at : null;
      } else if (event.type === "move-uncompleted" && event.runId && event.moveId) {
        delete done[runItemKey(event.runId, event.moveId)];
      }
    }
    return { runs: runs, byId: byId, done: done };
  }

  // 1-based ordinal of this scene inside the log, so history can say
  // "scene X, visit 2" without another API call.
  function nextSceneVisit(sceneId) {
    if (!sceneId) return null;
    let count = 0;
    const id = String(sceneId);
    for (const session of questLog.sessions) {
      if (session.sceneId === id) count++;
    }
    return count + 1;
  }

  // Trim whole runs, never a run in half: a surviving completion whose
  // activation was dropped would be uncountable after the next fold.
  function trimSessionEvents(session) {
    if (!session || !Array.isArray(session.events)) return;
    if (session.events.length <= MAX_EVENTS_PER_SESSION) return;
    const groups = [];
    for (const event of session.events) {
      if (event.type === "trigger-activated" && event.runId) {
        groups.push({ events: [event] });
      } else if (groups.length > 0) {
        groups[groups.length - 1].events.push(event);
      } else {
        groups.push({ events: [event] });
      }
    }
    let total = session.events.length;
    while (groups.length > 1 && total > MAX_EVENTS_PER_SESSION) {
      total -= groups.shift().events.length;
    }
    const kept = [];
    for (const group of groups) {
      for (const event of group.events) kept.push(event);
    }
    session.events = kept;
  }

  function normalizeEvent(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return null;
    const event = {
      at: typeof raw.at === "number" ? raw.at : null,
      type: raw.type,
      source: typeof raw.source === "string" ? raw.source : "manual",
    };
    if (typeof raw.runId === "string") event.runId = raw.runId;
    if (typeof raw.run === "number") event.run = raw.run;
    if (raw.triggerId) event.triggerId = String(raw.triggerId);
    if (raw.triggerName) event.triggerName = String(raw.triggerName);
    if (raw.moveId) event.moveId = String(raw.moveId);
    if (raw.moveText) event.moveText = String(raw.moveText);
    if (typeof raw.atSeconds === "number") event.atSeconds = raw.atSeconds;
    if (raw.origin) event.origin = String(raw.origin);
    if (raw.observedBy) event.observedBy = String(raw.observedBy);
    if (raw.markerId) event.markerId = String(raw.markerId);
    if (raw.reason) event.reason = String(raw.reason);
    if (Array.isArray(raw.requiredMoveIds)) event.requiredMoveIds = raw.requiredMoveIds.map(String);
    if (Array.isArray(raw.clearedMoveIds)) event.clearedMoveIds = raw.clearedMoveIds.map(String);
    return event;
  }

  // Schema 1 kept one flat event list and a per-session `counts` map. Replay
  // it to attach a runId to everything: a trigger's first activation opens a
  // run, later completions join the run that is open for that trigger, and an
  // orphan completion (activation trimmed away) opens a synthetic one.
  // Precision is unrecoverable: v1 recorded a move once per session, so a
  // migrated session can only ever show one run per trigger.
  function upgradeLegacySession(session) {
    const events = [];
    const open = {};
    const seq = {};
    for (const raw of session.events) {
      const event = normalizeEvent(raw);
      if (!event) continue;
      if (event.type === "trigger-activated" && event.triggerId) {
        seq[event.triggerId] = (seq[event.triggerId] || 0) + 1;
        event.runId = "legacy:" + session.id + ":" + event.triggerId + ":" + seq[event.triggerId];
        event.run = seq[event.triggerId];
        event.origin = event.origin || "legacy";
        event.observedBy = "legacy";
        open[event.triggerId] = event.runId;
      } else if (event.type === "trigger-deactivated" && event.triggerId) {
        event.runId = open[event.triggerId] || null;
        event.reason = event.reason || "legacy";
        delete open[event.triggerId];
      } else if (event.type === "move-completed" && event.triggerId) {
        if (!open[event.triggerId]) {
          seq[event.triggerId] = (seq[event.triggerId] || 0) + 1;
          const runId = "legacy:" + session.id + ":" + event.triggerId + ":" + seq[event.triggerId];
          open[event.triggerId] = runId;
          events.push({
            at: event.at,
            type: "trigger-activated",
            source: "legacy",
            runId: runId,
            run: seq[event.triggerId],
            triggerId: event.triggerId,
            origin: "legacy",
            observedBy: "legacy",
          });
        }
        event.runId = open[event.triggerId];
        event.run = seq[event.triggerId];
      } else {
        event.runId = event.triggerId ? open[event.triggerId] || null : null;
      }
      events.push(event);
    }
    return events;
  }

  function normalizeQuestLog(value) {
    const log = value && typeof value === "object" ? value : {};
    const sessions = Array.isArray(log.sessions) ? log.sessions : [];
    const visits = {};
    const result = [];
    for (const raw of sessions) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string") continue;
      const rawEvents = Array.isArray(raw.events) ? raw.events : [];
      const isCurrent = raw.schema === LOG_SCHEMA;
      let events;
      if (isCurrent) {
        events = rawEvents.map(normalizeEvent).filter(function (event) { return !!event; });
      } else {
        events = upgradeLegacySession({ id: raw.id, events: rawEvents });
      }
      const session = {
        id: raw.id,
        schema: LOG_SCHEMA,
        sceneId: raw.sceneId ? String(raw.sceneId) : null,
        sceneTitle: raw.sceneTitle ? String(raw.sceneTitle) : null,
        sceneVisit: typeof raw.sceneVisit === "number" ? raw.sceneVisit : null,
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
        endedAt: typeof raw.endedAt === "number" ? raw.endedAt : null,
        legacy: isCurrent ? false : true,
        events: events,
      };
      if (!session.sceneVisit && session.sceneId) {
        visits[session.sceneId] = (visits[session.sceneId] || 0) + 1;
        session.sceneVisit = visits[session.sceneId];
      }
      trimSessionEvents(session);
      result.push(session);
    }
    return { schema: LOG_SCHEMA, sessions: result.slice(-MAX_SESSIONS) };
  }

  async function loadQuestLog() {
    try {
      const stored = await storage.loadKey(LOG_KEY, LOG_CS_KEY);
      questLog = normalizeQuestLog(stored);
    } catch (err) {
      console.error("QuestingAdventurer: failed to load quest log:", err);
      questLog = { schema: LOG_SCHEMA, sessions: [] };
    }
    sessionStateCache = null;
    statsCache = null;
  }

  function ensureSession() {
    if (currentSession) return currentSession;
    const now = Date.now();
    const session = {
      id: generateId(),
      schema: LOG_SCHEMA,
      sceneId: currentSceneId ? String(currentSceneId) : null,
      sceneTitle: sceneContext && sceneContext.title ? String(sceneContext.title) : null,
      sceneVisit: nextSceneVisit(currentSceneId),
      startedAt: now,
      endedAt: null,
      events: [],
    };
    questLog.sessions.push(session);
    currentSession = session;
    openRuns = {};
    sessionStateCache = null;
    statsCache = null;
    // Triggers that were already active when the scene opened start their
    // first run of this session. Origin "session" records why the run exists
    // without pretending the trigger happened again on screen.
    for (const trigger of state.triggers) {
      if (trigger.active) startRun(trigger, { origin: "session", observedBy: "state" });
    }
    trimQuestLog();
    return session;
  }

  function startRun(trigger, options) {
    if (!trigger) return null;
    // Idempotent: an open run for this trigger is the run we are joining.
    if (openRuns[trigger.id]) return openRuns[trigger.id];
    const session = ensureSession();
    const opts = options || {};
    let seq = 1;
    for (const event of session.events) {
      if (event.type === "trigger-activated" && event.triggerId === trigger.id) seq++;
    }
    const runId = generateId();
    openRuns[trigger.id] = runId;
    recordEvent("trigger-activated", {
      runId: runId,
      run: seq,
      triggerId: trigger.id,
      triggerName: trigger.name,
      origin: opts.origin || "manual",
      observedBy: opts.observedBy || "user",
      markerId: opts.markerId || null,
      requiredMoveIds: Array.isArray(trigger.attachedMoveIds) ? trigger.attachedMoveIds.slice() : [],
      atSeconds: currentPlaybackSeconds(),
    });
    return runId;
  }

  function closeRun(triggerId, reason, extra) {
    if (!currentSession || !openRuns[triggerId]) return;
    const runId = openRuns[triggerId];
    delete openRuns[triggerId];
    recordEvent(
      "trigger-deactivated",
      Object.assign({}, extra || {}, {
        runId: runId,
        triggerId: triggerId,
        reason: reason || "unknown",
        atSeconds: currentPlaybackSeconds(),
      })
    );
  }

  function sessionState() {
    if (!currentSession) return { runs: [], byId: {}, done: {} };
    if (
      sessionStateCache &&
      sessionStateCache.sessionId === currentSession.id &&
      sessionStateCache.length === currentSession.events.length
    ) {
      return sessionStateCache.state;
    }
    const folded = foldEvents(currentSession.events);
    sessionStateCache = {
      sessionId: currentSession.id,
      length: currentSession.events.length,
      state: folded,
    };
    return folded;
  }

  function currentRun(triggerId) {
    if (!triggerId) return null;
    const runId = openRuns[triggerId];
    if (!runId) return null;
    return sessionState().byId[runId] || null;
  }

  function isRunItemDone(runId, moveId) {
    if (!runId || !moveId) return false;
    return Object.prototype.hasOwnProperty.call(sessionState().done, runItemKey(runId, moveId));
  }

  // A move ticked off in an earlier run of the same trigger must not tick the
  // current run, but the user still benefits from seeing that it happened.
  // Return that run so the row can hint at it instead of blocking the button.
  function earlierRunCompletion(triggerId, moveId) {
    const folded = sessionState();
    const current = currentRun(triggerId);
    for (const run of folded.runs) {
      if (run.triggerId !== triggerId) continue;
      if (current && run.id === current.id) continue;
      if (Object.prototype.hasOwnProperty.call(folded.done, runItemKey(run.id, moveId))) return run;
    }
    return null;
  }

  function trimQuestLog() {
    if (questLog.sessions.length > MAX_SESSIONS) {
      questLog.sessions = questLog.sessions.slice(-MAX_SESSIONS);
    }
    for (const session of questLog.sessions) {
      trimSessionEvents(session);
    }
  }

  function recordEvent(type, data) {
    const session = ensureSession();
    const event = Object.assign({ at: Date.now(), type: type, source: "manual" }, data || {});
    session.events.push(event);
    trimQuestLog();
    sessionStateCache = null;
    statsCache = null;
    scheduleQuestLogSave();
    return event;
  }

  function completeMove(moveId, triggerId) {
    if (!moveId) return;
    ensureSession();
    let run = triggerId ? currentRun(triggerId) : null;
    if (!run) {
      // The settings page can activate a trigger without telling the open
      // overlay. A row can therefore be visible with no run to record into —
      // open one rather than leaving a dead button.
      const trigger = state.triggers.find(function (t) { return t.id === triggerId; });
      if (!trigger || !trigger.active) return;
      startRun(trigger, { origin: "session", observedBy: "state" });
      run = triggerId ? currentRun(triggerId) : null;
      if (!run) return;
    }
    if (isRunItemDone(run.id, moveId)) return;
    const move = state.moves.find(function (m) { return m.id === moveId; });
    const trigger = state.triggers.find(function (t) { return t.id === triggerId; });
    recordEvent("move-completed", {
      runId: run.id,
      run: run.run,
      triggerId: triggerId || null,
      triggerName: trigger ? trigger.name : run.triggerName,
      moveId: moveId,
      moveText: move ? move.text : "",
      source: "tap",
      atSeconds: currentPlaybackSeconds(),
    });
    dispatchHardwareCommand();
    announceToAria("Completed " + (move ? move.text : "move") + ".");
    render();
  }

  // Undo appends instead of deleting: the fold neutralises the completion,
  // while the log keeps the fact that it was ticked and then retracted.
  function undoMove(moveId, triggerId) {
    const run = triggerId ? currentRun(triggerId) : null;
    if (!run || !isRunItemDone(run.id, moveId)) return;
    recordEvent("move-uncompleted", {
      runId: run.id,
      run: run.run,
      triggerId: triggerId || null,
      moveId: moveId,
      reason: "undo",
    });
    announceToAria("Completion undone.");
    render();
  }

  function dispatchHardwareCommand() {
    if (!hardwareConfig.enabled || !hardwareConfig.url) return;
    try {
      const socket = new WebSocket(hardwareConfig.url);
      let deviceIndex = null;
      let stopped = false;
      const stop = function () {
        if (stopped) return;
        stopped = true;
        if (deviceIndex !== null && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ StopDeviceCmd: { Id: 4, DeviceIndex: deviceIndex } }));
        }
        setTimeout(function () {
          try { socket.close(); } catch (err) { /* ignore */ }
        }, 100);
      };
      socket.addEventListener("open", function () {
        socket.send(JSON.stringify({
          RequestServerInfo: {
            Id: 1,
            ClientName: "Questing Adventurer",
            MessageVersion: 1,
          },
        }));
      });
      socket.addEventListener("message", function (event) {
        let message;
        try { message = JSON.parse(event.data); } catch (err) { return; }
        if (message.ServerInfo && hardwareConfig.enabled) {
          socket.send(JSON.stringify({ StartScanning: { Id: 2 } }));
        }
        if (message.DeviceAdded && deviceIndex === null) {
          deviceIndex = message.DeviceAdded.DeviceIndex;
          socket.send(JSON.stringify({
            ScalarCmd: {
              Id: 3,
              DeviceIndex: deviceIndex,
              Scalars: [
                {
                  Index: 0,
                  Scalar: Math.max(0, Math.min(1, Number(hardwareConfig.intensity) || 0)),
                  ActuatorType: "Vibrate",
                },
              ],
            },
          }));
          setTimeout(stop, Math.max(100, Number(hardwareConfig.durationMs) || 1000));
        }
      });
      socket.addEventListener("error", function () {
        console.warn("QuestingAdventurer: Intiface connection failed");
        stop();
      });
      setTimeout(stop, 5000);
    } catch (err) {
      console.warn("QuestingAdventurer: Intiface dispatch failed", err);
    }
  }

  function endSession(reason, silent) {
    if (!currentSession) return;
    // Close every open run first so the log never ends mid-run: an
    // un-deactivated run is indistinguishable from "still going" on reload.
    for (const triggerId of Object.keys(openRuns)) {
      closeRun(triggerId, reason || "session-end");
    }
    currentSession.endedAt = Date.now();
    currentSession = null;
    openRuns = {};
    sessionStateCache = null;
    statsCache = null;
    // A new session is a clean slate for automation too: "once" rules re-arm
    // and a session-scoped × no longer suppresses anything.
    resetAutoState();
    scheduleQuestLogSave(true);
    if (!silent) render();
  }

  function flushQuestLogSave() {
    if (logSaving) {
      logPending = true;
      return;
    }
    logSaving = true;
    logPending = false;
    const snapshot = JSON.parse(JSON.stringify(questLog));
    storage.saveKey(LOG_KEY, snapshot, LOG_CS_KEY, "Questing Adventurer quest log", function (latest) {
      // Merge by session id so a concurrent tab's sessions are not dropped.
      // The snapshot wins per id: it is the tab that owns this session.
      const merged = normalizeQuestLog(latest);
      const byId = {};
      for (const s of merged.sessions) byId[s.id] = s;
      for (const s of snapshot.sessions) byId[s.id] = s;
      const sessions = Object.keys(byId).map(function (id) { return byId[id]; });
      sessions.sort(function (a, b) { return a.startedAt - b.startedAt; });
      return { schema: LOG_SCHEMA, sessions: sessions.slice(-MAX_SESSIONS) };
    }).then(function () {
      logSaving = false;
      if (logPending) flushQuestLogSave();
    }).catch(function (err) {
      console.error("QuestingAdventurer: failed to save quest log:", err);
      logSaving = false;
      if (logPending) flushQuestLogSave();
    });
  }

  function scheduleQuestLogSave(immediate) {
    if (logSaveTimer) clearTimeout(logSaveTimer);
    if (immediate) {
      flushQuestLogSave();
      return;
    }
    logSaveTimer = setTimeout(function () {
      logSaveTimer = null;
      flushQuestLogSave();
    }, 800);
  }

  function sessionDoneCount(session) {
    if (!session || !Array.isArray(session.events)) return 0;
    return Object.keys(foldEvents(session.events).done).length;
  }

  // Recomputing 200 sessions on every render is wasteful; the signature is
  // cheap to build and only changes when an event is appended or a session
  // starts/ends, which is exactly when the numbers can change.
  function logSignature() {
    let signature = questLog.sessions.length + "|" + (currentSession ? currentSession.id : "-");
    for (const session of questLog.sessions) {
      signature += "|" + session.id + ":" + session.events.length;
    }
    return signature;
  }

  function getQuestLogStats() {
    const signature = logSignature();
    if (statsCache && statsCache.signature === signature) return statsCache.stats;
    const today = dayKey(Date.now());
    const completedDays = {};
    let todayDone = 0;
    let totalDone = 0;
    let totalRuns = 0;
    for (const session of questLog.sessions) {
      const folded = foldEvents(session.events);
      totalRuns += folded.runs.length;
      for (const key in folded.done) {
        if (!Object.prototype.hasOwnProperty.call(folded.done, key)) continue;
        totalDone++;
        const at = folded.done[key];
        if (typeof at !== "number") continue;
        const day = dayKey(at);
        completedDays[day] = true;
        if (day === today) todayDone++;
      }
    }
    let cursor = new Date();
    if (!completedDays[dayKey(cursor.getTime())]) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (completedDays[dayKey(cursor.getTime())]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    const current = currentSession ? foldEvents(currentSession.events) : { runs: [], done: {} };
    const stats = {
      todayDone: todayDone,
      totalDone: totalDone,
      streak: streak,
      totalRuns: totalRuns,
      sessionDone: Object.keys(current.done).length,
      sessionRuns: current.runs.length,
    };
    statsCache = { signature: signature, stats: stats };
    return stats;
  }

  function renderQuestLog(panel) {
    const stats = getQuestLogStats();
    const box = document.createElement("div");
    box.className = "questing-adventurer-panel__quest-log";

    const header = document.createElement("div");
    header.className = "questing-adventurer-panel__quest-log-header";
    const title = document.createElement("span");
    title.textContent = "Quest Log";
    header.appendChild(title);
    if (currentSession) {
      const end = document.createElement("button");
      end.type = "button";
      end.dataset.action = "end-session";
      end.className = "questing-adventurer-panel__quest-log-end";
      end.textContent = "End";
      end.title = "End the current session";
      end.setAttribute("aria-label", "End current quest session");
      header.appendChild(end);
    }
    box.appendChild(header);

    // Metrics are laid out as label + value pairs rather than one sentence:
    // the numbers are the only thing the user scans here, so they get the
    // weight and the tabular alignment while the labels recede. The wording
    // is unchanged ("Today: 4 done · Streak: 2 days"). "Done" counts
    // completion events, so the same move can count twice in one scene —
    // that is the point, not a duplicate.
    const summary = document.createElement("div");
    summary.className = "questing-adventurer-panel__quest-log-summary";
    const metrics = [
      ["Today", stats.todayDone + " done"],
      ["Streak", stats.streak + " day" + (stats.streak === 1 ? "" : "s")],
    ];
    metrics.forEach(function (metric, index) {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "questing-adventurer-panel__quest-log-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "\u00b7";
        summary.appendChild(sep);
      }
      const pair = document.createElement("span");
      pair.className = "questing-adventurer-panel__quest-log-metric";
      const label = document.createElement("span");
      label.className = "questing-adventurer-panel__quest-log-label";
      label.textContent = metric[0];
      const value = document.createElement("span");
      value.className = "questing-adventurer-panel__quest-log-value";
      value.textContent = metric[1];
      pair.appendChild(label);
      pair.appendChild(value);
      summary.appendChild(pair);
    });
    box.appendChild(summary);

    // "runs", never "occurrences": a run is one stretch of a trigger being
    // active, which is all the plugin can observe. Say so by using the word.
    if (currentSession) {
      const now = document.createElement("div");
      now.className = "questing-adventurer-panel__quest-log-current";
      const doneWord = stats.sessionDone === 1 ? "move" : "moves";
      const runWord = stats.sessionRuns === 1 ? "run" : "runs";
      now.textContent =
        "This session: " + stats.sessionDone + " " + doneWord + " · " +
        stats.sessionRuns + " trigger " + runWord;
      box.appendChild(now);
    }

    const recent = questLog.sessions.slice(-3).reverse();
    if (recent.length > 0) {
      const list = document.createElement("div");
      list.className = "questing-adventurer-panel__quest-log-recent";
      for (const session of recent) {
        const done = sessionDoneCount(session);
        if (done === 0 && !session.endedAt) continue;
        const row = document.createElement("div");
        row.className = "questing-adventurer-panel__quest-log-row";
        const parts = [new Date(session.startedAt).toLocaleDateString()];
        if (session.sceneTitle) parts.push(session.sceneTitle);
        parts.push(done + " done");
        row.textContent = parts.join(" \u00b7 ");
        row.title =
          (session.sceneId ? "Scene #" + session.sceneId : "No scene") +
          (session.sceneVisit ? " \u00b7 visit " + session.sceneVisit : "") +
          (session.legacy ? " \u00b7 legacy record (coarse)" : "");
        list.appendChild(row);
      }
      if (list.children.length > 0) box.appendChild(list);
    }

    panel.appendChild(box);
  }

  // ── Scene-aware triggers ────────────────────────────────────────────
  var sceneContext = { title: "", tagIds: [], markers: [] };
  var sceneContextSceneId = null;
  var timelineCleanup = null;
  var firedMarkerIds = {};

  async function fetchSceneContext(sceneId) {
    try {
      const response = await fetch("/graphql", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query:
            "query ($id: ID!) { findScene(id: $id) { title tags { id } scene_markers { id seconds title tags { id } } } }",
          variables: { id: String(sceneId) },
        }),
      });
      const payload = await response.json();
      if (payload.errors && payload.errors.length) throw new Error(payload.errors[0].message);
      const scene = payload.data && payload.data.findScene;
      if (!scene) return { title: "", tagIds: [], markers: [] };
      return {
        // The title is snapshotted onto the session so history stays readable
        // after the scene is renamed or deleted; it is never re-queried.
        title: scene.title || "",
        tagIds: (scene.tags || []).map(function (t) { return String(t.id); }),
        markers: (scene.scene_markers || []).map(function (m) {
          return {
            id: String(m.id),
            seconds: typeof m.seconds === "number" ? m.seconds : 0,
            title: m.title || "",
            tagIds: (m.tags || []).map(function (t) { return String(t.id); }),
          };
        }),
      };
    } catch (err) {
      console.warn("QuestingAdventurer: scene context lookup failed", err);
      return { title: "", tagIds: [], markers: [] };
    }
  }

  function isTriggerEligible(trigger) {
    const required = Array.isArray(trigger.sceneTagIds) ? trigger.sceneTagIds : [];
    if (required.length === 0) return true;
    return required.some(function (id) { return sceneContext.tagIds.indexOf(String(id)) !== -1; });
  }

  function getEligibleTriggers() {
    return state.triggers.filter(isTriggerEligible);
  }

  function attachTimelinePrompts() {
    if (timelineCleanup) timelineCleanup();
    const video = document.querySelector("#VideoJsPlayer video");
    if (!video) return;
    const onTime = function () {
      const raw = video.currentTime;
      const t = typeof raw === "number" && isFinite(raw) ? raw : 0;
      if (autoPrevTime === null) {
        // A resume mid-scene must not replay every marker behind the playhead;
        // start at 0 only when playback is actually still at the top.
        autoPrevTime = t <= 1 ? 0 : t;
      } else {
        evaluateAutoMarkerRules(autoPrevTime, t);
        autoPrevTime = t;
      }
      for (const marker of sceneContext.markers) {
        if (firedMarkerIds[marker.id]) continue;
        if (t + 0.15 < marker.seconds) continue;
        // A marker claimed by an auto rule never prompts: it already fired (or
        // will, when the rule's own conditions allow), and prompting would ask
        // the user to accept what just happened automatically.
        if (isMarkerAutoHandled(marker.id)) {
          firedMarkerIds[marker.id] = true;
          continue;
        }
        const trigger = getEligibleTriggers().find(function (tr) {
          const wanted = Array.isArray(tr.markerTagIds) ? tr.markerTagIds : [];
          return wanted.some(function (id) { return marker.tagIds.indexOf(String(id)) !== -1; });
        });
        // Only burn the marker when a prompt is actually shown. Burning it on
        // a miss (no matching trigger, or the trigger is already active) used
        // to spend the marker for the whole session with nothing to show.
        if (!trigger || trigger.active) continue;
        firedMarkerIds[marker.id] = true;
        showMarkerPrompt(marker, trigger);
      }
    };
    video.addEventListener("timeupdate", onTime);
    timelineCleanup = function () {
      video.removeEventListener("timeupdate", onTime);
      timelineCleanup = null;
    };
  }

  function showMarkerPrompt(marker, trigger) {
    const panel = document.querySelector(".questing-adventurer-panel");
    if (!panel) return;
    const existing = panel.querySelector(".questing-adventurer-panel__prompt");
    if (existing) existing.remove();
    const box = document.createElement("div");
    box.className = "questing-adventurer-panel__prompt";
    const title = document.createElement("div");
    title.className = "questing-adventurer-panel__prompt-title";
    // "PROMPT" stays a micro-label; the marker title keeps sentence case
    // (marker titles are often long, and all-caps them reads as shouting).
    const titleLabel = document.createElement("span");
    titleLabel.className = "questing-adventurer-panel__prompt-label";
    titleLabel.textContent = "Prompt";
    const titleName = document.createElement("span");
    titleName.className = "questing-adventurer-panel__prompt-name";
    titleName.textContent = marker.title || trigger.name;
    title.appendChild(titleLabel);
    title.appendChild(titleName);
    box.appendChild(title);
    const copy = document.createElement("div");
    copy.className = "questing-adventurer-panel__prompt-copy";
    copy.textContent = trigger.name + " is available at this marker.";
    box.appendChild(copy);
    const actions = document.createElement("div");
    actions.className = "questing-adventurer-panel__prompt-actions";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Accept";
    accept.dataset.action = "accept-marker-prompt";
    accept.dataset.triggerId = trigger.id;
    accept.dataset.markerId = marker.id;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.dataset.action = "dismiss-marker-prompt";
    actions.appendChild(accept);
    actions.appendChild(dismiss);
    box.appendChild(actions);
    panel.appendChild(box);
  }

  function acceptMarkerPrompt(triggerId, markerId) {
    const trigger = state.triggers.find(function (t) { return t.id === triggerId; });
    if (!trigger || trigger.active) {
      const prompt = document.querySelector(".questing-adventurer-panel__prompt");
      if (prompt) prompt.remove();
      return;
    }
    // Session first: ensureSession records the carried runs before this
    // trigger flips to active, so this activation is not double-counted.
    ensureSession();
    trigger.active = true;
    startRun(trigger, { origin: "marker", observedBy: "marker", markerId: markerId });
    queueSave();
    announceToAria("Activated " + trigger.name + " from a scene marker.");
    render();
  }

  // ── Automatic playback rules ────────────────────────────────────────
  // A rule binds one scene (or one marker inside that scene) to one trigger,
  // and optionally to one move that gets attached when the rule fires. Rules
  // live on the trigger (`trigger.autoRules`) rather than in a separate config
  // key, so the settings page can edit them with the trigger it already owns
  // and the overlay can evaluate them with the trigger list it already loads.
  //
  // Semantics, deliberately boring:
  // - Firing only ever means "make sure this trigger is active and this move
  //   is attached". It never deactivates, detaches or reorders anything.
  // - `repeat: "once"` (default) fires at most once per session.
  // - `repeat: "every"` re-evaluates on every forward crossing, so a trigger
  //   emptied by Reward comes back at the next marker. It stays idempotent
  //   while the trigger is already active, so a repeated crossing is a no-op.
  // - A manual × suppresses every rule of that trigger for the rest of the
  //   session: an explicit "not now" beats automation.
  // - Markers are crossed, not sampled: backwards playback and jumps larger
  //   than AUTO_SEEK_GUARD are rejected, so scrubbing past a marker does not
  //   fire it.
  const AUTO_SEEK_GUARD = 2;
  let autoPrevTime = null;
  let autoFiredRules = {};
  let autoSuppressed = {};
  let autoWarnedRules = {};

  function normalizeAutoRules(value) {
    if (!Array.isArray(value)) return [];
    const rules = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) continue;
      const sceneId = raw.sceneId ? String(raw.sceneId) : null;
      // Scene-specific by design: "fire anywhere" would silently rewrite the
      // whole library every time a scene opens.
      if (!sceneId) continue;
      rules.push({
        id: raw.id,
        sceneId: sceneId,
        markerId: raw.markerId ? String(raw.markerId) : null,
        atSeconds:
          typeof raw.atSeconds === "number" && isFinite(raw.atSeconds) && raw.atSeconds >= 0
            ? raw.atSeconds
            : null,
        moveId: raw.moveId ? String(raw.moveId) : null,
        repeat: raw.repeat === "every" ? "every" : "once",
      });
    }
    return rules;
  }

  function getAutoRules(trigger) {
    return trigger && Array.isArray(trigger.autoRules) ? trigger.autoRules : [];
  }

  function resetAutoState() {
    autoPrevTime = null;
    autoFiredRules = {};
    autoSuppressed = {};
    autoWarnedRules = {};
  }

  function ruleAppliesToScene(rule) {
    if (!rule || !rule.sceneId || !currentSceneId) return false;
    return String(rule.sceneId) === String(currentSceneId);
  }

  // A rule can carry an explicit time instead of a marker id (useful when the
  // marker was deleted after the rule was written); the marker wins otherwise.
  function ruleMarkerSeconds(rule) {
    if (rule.markerId) {
      for (const marker of sceneContext.markers) {
        if (marker.id === rule.markerId) {
          return typeof marker.seconds === "number" ? marker.seconds : null;
        }
      }
      return typeof rule.atSeconds === "number" ? rule.atSeconds : null;
    }
    return typeof rule.atSeconds === "number" ? rule.atSeconds : null;
  }

  function isMarkerAutoHandled(markerId) {
    for (const trigger of state.triggers) {
      for (const rule of getAutoRules(trigger)) {
        if (!ruleAppliesToScene(rule)) continue;
        if (autoSuppressed[trigger.id]) continue;
        if (rule.markerId === markerId) return true;
      }
    }
    return false;
  }

  // A rule pinned to this scene overrides `sceneTagIds` for display: the user
  // named the scene explicitly, so an activated trigger must not vanish from
  // the list just because its tag filter does not match. Random selection and
  // marker prompts still honour `sceneTagIds`. A tag binding is just as
  // explicit — it names the tag, which this scene demonstrably carries — so it
  // pins the same way.
  function isTriggerAutoPinned(trigger) {
    for (const rule of getAutoRules(trigger)) {
      if (ruleAppliesToScene(rule)) return true;
    }
    return isTriggerTagBoundInScene(trigger);
  }

  function canAttachMoveToTrigger(moveId, triggerId) {
    let count = 0;
    for (const trigger of state.triggers) {
      if (trigger.id === triggerId) continue;
      if (Array.isArray(trigger.attachedMoveIds) && trigger.attachedMoveIds.indexOf(moveId) !== -1) {
        count++;
        if (count >= MAX_MOVE_ATTACHMENTS) return false;
      }
    }
    return true;
  }

  // Shared by every automatic activation path (scene rules, marker rules, tag
  // bindings). Firing only ever means "make sure this trigger is active and
  // this move is attached": it never deactivates, detaches or reorders.
  // Returns true only when something actually changed, so a caller can decide
  // whether its "once" bookkeeping has been spent.
  function activateTriggerWithMove(trigger, move, source) {
    let changed = false;
    // Session first: ensureSession records carried runs before this trigger
    // flips to active, so the activation is not double-counted.
    ensureSession();
    if (!trigger.active) {
      trigger.active = true;
      startRun(trigger, { origin: "auto-" + source, observedBy: "playback" });
      changed = true;
    }
    if (move) {
      if (!Array.isArray(trigger.attachedMoveIds)) trigger.attachedMoveIds = [];
      const alreadyAttached = trigger.attachedMoveIds.indexOf(move.id) !== -1;
      if (!alreadyAttached && canAttachMoveToTrigger(move.id, trigger.id)) {
        trigger.attachedMoveIds.push(move.id);
        recordEvent("move-attached", {
          runId: openRuns[trigger.id] || null,
          triggerId: trigger.id,
          moveId: move.id,
          moveText: move.text,
          source: "auto-" + source,
          atSeconds: currentPlaybackSeconds(),
        });
        changed = true;
      }
    }
    if (changed) {
      queueSave();
      announceToAria(
        "Auto-triggered " + trigger.name + (move ? ", attached " + move.text : "") + "."
      );
      render();
    }
    return changed;
  }

  function fireAutoRule(trigger, rule, source) {
    if (!trigger || !rule) return false;
    if (autoSuppressed[trigger.id]) return false;
    if (rule.repeat !== "every" && autoFiredRules[rule.id]) return false;
    const move = rule.moveId
      ? state.moves.find(function (m) { return m.id === rule.moveId; })
      : null;
    const changed = activateTriggerWithMove(trigger, move, source);
    // A firing that accomplished nothing (already active, move already
    // attached, or the move was at its attachment cap) does not spend a
    // "once" rule, so the next crossing can still apply it. A firing that
    // activated the trigger counts as spent.
    if (changed) autoFiredRules[rule.id] = true;
    return changed;
  }

  // Scene rules run once per panel setup: the scene is already open, so there
  // is no crossing to wait for.
  function applyAutoSceneRules() {
    if (!currentSceneId) return false;
    let changed = false;
    for (const trigger of state.triggers) {
      for (const rule of getAutoRules(trigger)) {
        if (rule.markerId) continue;
        if (typeof rule.atSeconds === "number") continue;
        if (!ruleAppliesToScene(rule)) continue;
        if (fireAutoRule(trigger, rule, "scene")) changed = true;
      }
    }
    return changed;
  }

  function evaluateAutoMarkerRules(previous, time) {
    if (typeof previous !== "number" || typeof time !== "number") return false;
    const delta = time - previous;
    // Backwards playback or a seek: not a crossing.
    if (delta <= 0 || delta > AUTO_SEEK_GUARD) return false;
    let changed = false;
    for (const trigger of state.triggers) {
      for (const rule of getAutoRules(trigger)) {
        if (!rule.markerId && typeof rule.atSeconds !== "number") continue;
        if (!ruleAppliesToScene(rule)) continue;
        const seconds = ruleMarkerSeconds(rule);
        if (seconds === null) {
          // The marker was deleted (or moved to another scene) and the rule has
          // no explicit time to fall back on. Warn once per rule, not per tick.
          if (!autoWarnedRules[rule.id]) {
            autoWarnedRules[rule.id] = true;
            console.warn(
              "QuestingAdventurer: auto rule " + rule.id + " points at a marker that is not in scene " + currentSceneId
            );
          }
          continue;
        }
        const crossed = previous + 0.001 < seconds && seconds <= time + 0.25;
        if (!crossed) continue;
        if (fireAutoRule(trigger, rule, "marker")) changed = true;
      }
    }
    return changed;
  }

  // ── Tag bindings ────────────────────────────────────────────────────
  // A binding is one row `{ id, tagId, triggerId, moveId }` saying "a scene
  // carrying `tagId` activates `triggerId` and attaches `moveId`". Unlike
  // `autoRules` it is not pinned to one scene, so it applies to every scene
  // that carries the tag; and unlike `sceneTagIds` it names the combo to use
  // instead of only filtering what the random buttons may pick.
  //
  // Evaluated once per panel setup, like scene rules: the scene is already
  // open, so there is no crossing to wait for. That gives "once per scene
  // open" semantics for free — a binding that re-fires is a no-op because the
  // trigger is already active and the move already attached, so no second run
  // is logged. Within one evaluation the shared resolver dedupes the same
  // trigger+move reached through two tags.
  function getSceneTagBindingFires() {
    return shared.resolveTagBindings(state.tagBindings, sceneContext.tagIds);
  }

  // Tag bindings pin their trigger for display the same way a scene rule does:
  // the user named the tag explicitly, so an activated trigger must not vanish
  // from the list just because its own `sceneTagIds` filter excludes this scene.
  function isTriggerTagBoundInScene(trigger) {
    if (!trigger || !trigger.id) return false;
    return getSceneTagBindingFires().some(function (fire) {
      return fire.triggerId === trigger.id;
    });
  }

  function warnTagBindingOnce(bindingId, message) {
    const key = "tag-binding:" + (bindingId || "?");
    if (autoWarnedRules[key]) return;
    autoWarnedRules[key] = true;
    console.warn("QuestingAdventurer: tag binding " + (bindingId || "(no id)") + " " + message);
  }

  function applyTagBindings() {
    if (!currentSceneId) return false;
    const fires = getSceneTagBindingFires();
    let changed = false;
    for (const fire of fires) {
      const trigger = state.triggers.find(function (t) { return t.id === fire.triggerId; });
      if (!trigger) {
        // The trigger was deleted (or the config was hand-edited). Skipping is
        // the only safe answer — inventing a trigger is not. Warn once so the
        // console explains the silence.
        warnTagBindingOnce(fire.bindingId, "points at a trigger that does not exist");
        continue;
      }
      // A manual × on this trigger already said "not now" for this session.
      if (autoSuppressed[trigger.id]) continue;
      let move = null;
      if (fire.moveId) {
        move = state.moves.find(function (m) { return m.id === fire.moveId; });
        if (!move) {
          // Same as an auto rule with a deleted move: the trigger still fires,
          // the missing move is skipped rather than aborting the activation.
          warnTagBindingOnce(fire.bindingId, "points at a move that does not exist");
        }
      }
      if (activateTriggerWithMove(trigger, move, "tag")) changed = true;
    }
    return changed;
  }

  function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // Count active triggers for the chip display. The chip shows the number
  // of currently-active triggers (each active trigger is a "quest" the user
  // is currently undertaking).
  function getActiveTriggerCount() {
    return state.triggers.filter(function (t) { return t.active; }).length;
  }

  function getOpacityIcon(value) {
    if (value <= 0.2) return "\u25cb"; // ○
    if (value <= 0.5) return "\u25d1"; // ◑
    if (value <= 0.8) return "\u25d0"; // ◐
    return "\u25cf"; // ●
  }

  // Penalty: pick a random inactive move and make it active. No-op if the
  // inactive pool is empty (the button is disabled in that case, but we
  // defend here too).
  // Penalty: pick a random inactive trigger → activate it AND attach a random
  // unattached move from the library. If every trigger is already active, pick
  // a random active trigger and just attach a random unattached move. If the
  // Returns the list of library moves that are NOT yet at the per-move
  // attachment cap (currently 2). A move is "available" if it is attached
  // to fewer than MAX_MOVE_ATTACHMENTS triggers across the whole trigger
  // list. Shared between the Penalty click handler and the Penalty button's
  // enabled-state check so they can never disagree.
  const MAX_MOVE_ATTACHMENTS = 2;
  function getAvailableMoves() {
    return state.moves.filter(function (m) {
      let attachCount = 0;
      for (const t of state.triggers) {
        if ((t.attachedMoveIds || []).indexOf(m.id) !== -1) {
          attachCount++;
          if (attachCount >= MAX_MOVE_ATTACHMENTS) return false;
        }
      }
      return true;
    });
  }

  // Penalty: pick a random inactive trigger → activate it AND attach a random
  // unattached move from the library. If every trigger is already active, pick
  // a random active trigger and just attach a move. If the library has no
  // available moves (all at the 2-trigger cap), do nothing — don't activate
  // an empty trigger. The button is also disabled in that case.
  function applyPenalty() {
    if (state.triggers.length === 0) return;
    const inactiveTriggers = state.triggers.filter(function (t) { return !t.active && isTriggerEligible(t); });
    let trigger;
    let activatedANewTrigger = false;
    if (inactiveTriggers.length > 0) {
      trigger = inactiveTriggers[Math.floor(Math.random() * inactiveTriggers.length)];
      activatedANewTrigger = true;
    } else {
      const eligible = getEligibleTriggers();
      if (eligible.length === 0) {
        announceToAria("No triggers match this scene's tags.");
        return;
      }
      trigger = eligible[Math.floor(Math.random() * eligible.length)];
    }
    // Per-trigger move filter: a move is "available" for THIS trigger if
    // (a) it's not already attached to this trigger (no duplicates on the
    // same trigger), and (b) it's attached to fewer than MAX_MOVE_ATTACHMENTS
    // triggers globally (the 0.9.7 cap). Activation and attachment stay
    // atomic: the availability check runs BEFORE anything is mutated, so the
    // no-move case no longer has to undo an activation (which used to leave a
    // phantom run in the log).
    const availableForTrigger = state.moves.filter(function (m) {
      if (trigger.attachedMoveIds.indexOf(m.id) !== -1) return false;
      let attachCount = 0;
      for (const t of state.triggers) {
        if ((t.attachedMoveIds || []).indexOf(m.id) !== -1) {
          attachCount++;
          if (attachCount >= MAX_MOVE_ATTACHMENTS) return false;
        }
      }
      return true;
    });
    if (availableForTrigger.length === 0) {
      announceToAria(
        "Penalty: all available moves are already attached to " +
          trigger.name +
          ". Add more moves to the library or pick a different trigger."
      );
      queueSave();
      render();
      return;
    }
    const attachedMove = availableForTrigger[Math.floor(Math.random() * availableForTrigger.length)];
    // Session before mutation: ensureSession opens carried runs from the
    // pre-activation state, so this trigger is not counted twice.
    ensureSession();
    if (activatedANewTrigger) {
      trigger.active = true;
      startRun(trigger, { origin: "penalty", observedBy: "user" });
    }
    trigger.attachedMoveIds.push(attachedMove.id);
    recordEvent("move-attached", {
      runId: openRuns[trigger.id] || null,
      triggerId: trigger.id,
      moveId: attachedMove.id,
      moveText: attachedMove.text,
      source: "penalty",
      atSeconds: currentPlaybackSeconds(),
    });
    queueSave();
    announceToAria(
      "Penalty: " + (activatedANewTrigger ? "activated " : "") + trigger.name + ", attached " + attachedMove.text + "."
    );
    render();
  }

  // Reward: pick a random active trigger that still has attached moves →
  // remove a random attached move. If the trigger ends with zero attached
  // moves, set it to inactive and close its run.
  function applyReward() {
    const eligible = state.triggers.filter(function (t) {
      return t.active && t.attachedMoveIds.length > 0;
    });
    if (eligible.length === 0) return;
    const trigger = eligible[Math.floor(Math.random() * eligible.length)];
    // Session first: the trigger is still active here, so ensureSession opens
    // its carried run and the detach below lands inside a run that exists.
    ensureSession();
    const idx = Math.floor(Math.random() * trigger.attachedMoveIds.length);
    const removedMoveId = trigger.attachedMoveIds.splice(idx, 1)[0];
    let deactivated = false;
    if (trigger.attachedMoveIds.length === 0) {
      trigger.active = false;
      deactivated = true;
    }
    const removedMove = state.moves.find(function (m) { return m.id === removedMoveId; });
    recordEvent("move-detached", {
      runId: openRuns[trigger.id] || null,
      triggerId: trigger.id,
      moveId: removedMoveId,
      moveText: removedMove ? removedMove.text : "",
      source: "reward",
      atSeconds: currentPlaybackSeconds(),
    });
    // A detach is not a completion, and it no longer erases the run's
    // completion history — it only closes the run when the trigger empties.
    if (deactivated) closeRun(trigger.id, "empty");
    queueSave();
    if (removedMove) {
      announceToAria(
        "Reward: detached " + removedMove.text + " from " + trigger.name +
          (deactivated ? "; trigger now inactive." : ".")
      );
    }
    render();
  }

  // Ensure the shared aria-live element exists on document.body. Idempotent —
  // returns the existing element if already present. The element lives outside
  // the panel so it survives render() calls that clear the panel's children.
  function ensureAriaLive() {
    let live = document.querySelector(".questing-adventurer-panel__aria-live");
    if (!live) {
      live = document.createElement("div");
      live.className = "questing-adventurer-panel__aria-live";
      live.setAttribute("aria-live", "polite");
      live.style.cssText =
        "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;";
      document.body.appendChild(live);
    }
    return live;
  }

  function announceToAria(message) {
    const live = ensureAriaLive();
    // Clear first so identical consecutive messages still announce.
    live.textContent = "";
    live.textContent = message;
  }

  // Find a node by id and return its location in the state tree.
  // Returns { node, container, index, parentId } or null.
  // parentId is null for top-level nodes.
  function findNodeLocation(id) {
    for (let i = 0; i < state.triggers.length; i++) {
      const n = state.triggers[i];
      if (n.id === id) {
        return { node: n, container: state.triggers, index: i, parentId: null };
      }
      if (n.type === "trigger" && Array.isArray(n.attachedMoveIds)) {
        for (let j = 0; j < n.attachedMoveIds.length; j++) {
          if (n.attachedMoveIds[j] === id) {
            return { node: id, container: n.attachedMoveIds, index: j, parentId: n.id };
          }
        }
      }
    }
    return null;
  }

  // Clear the drop-target visual classes from any row.
  function clearDropTargetClasses() {
    const list = document.querySelector(".questing-adventurer-panel__list");
    if (!list) return;
    list.querySelectorAll(".questing-adventurer-panel__row--drop-before, .questing-adventurer-panel__row--drop-after").forEach(function (el) {
      el.classList.remove("questing-adventurer-panel__row--drop-before");
      el.classList.remove("questing-adventurer-panel__row--drop-after");
    });
  }

  // Given a pointer position, determine the drop target.
  // Returns { beforeId, parentId, dropClass } or null.
  // - beforeId: id of the row to insert before (null = append at end of parent)
  // - parentId: id of the trigger that should contain the moved node (null = top-level)
  // - dropClass: "drop-before" or "drop-after" for the line visual
  function getDropTarget(clientX, clientY, sourceId) {
    const panel = document.querySelector(".questing-adventurer-panel");
    if (!panel) return null;
    const el = document.elementFromPoint(clientX, clientY);
    if (!el || !panel.contains(el)) return null;
    const row = el.closest("[data-row-type]");
    if (!row || !panel.contains(row)) return null;
    if (row.dataset.id === sourceId) return null; // can't drop on self

    const targetId = row.dataset.id;
    const targetType = row.dataset.rowType;
    const targetParentId = row.dataset.parentTrigger || null;
    const rect = row.getBoundingClientRect();
    const isTopHalf = clientY < rect.top + rect.height / 2;

    const sourceLoc = findNodeLocation(sourceId);
    if (!sourceLoc) return null;
    // Top-level nodes (parentId === null) are triggers; child nodes are moves.
    // This is more robust than checking sourceLoc.node.type, since for moves
    // sourceLoc.node is the move ID string (not an object with .type).
    const sourceIsTrigger = sourceLoc.parentId === null;

    // If the source is a trigger and the target is a child row (inside a trigger),
    // we forbid trigger-into-trigger nesting. Fall back to top-level insertion
    // before/after the parent trigger of the target child.
    if (sourceIsTrigger && targetParentId !== null) {
      const parentIdx = state.triggers.findIndex(function (n) {
        return n.id === targetParentId;
      });
      if (parentIdx === -1) return null;
      const beforeRow = isTopHalf ? state.triggers[parentIdx] : state.triggers[parentIdx + 1];
      return {
        beforeId: beforeRow ? beforeRow.id : null,
        parentId: null,
        dropClass: isTopHalf ? "drop-before" : "drop-after",
      };
    }

    // If the target is an empty trigger (no children) and the source is a move,
    // the bottom half of the trigger header appends the move as the first child.
    if (targetType === "trigger" && sourceIsTrigger === false) {
      const targetTrigger = state.triggers.find(function (n) { return n.id === targetId; });
      if (targetTrigger && (!Array.isArray(targetTrigger.attachedMoveIds) || targetTrigger.attachedMoveIds.length === 0)) {
        if (!isTopHalf) {
          return {
            beforeId: null,
            parentId: targetId,
            dropClass: "drop-after",
          };
        }
      }
    }

    // Standard insertion at the target's level.
    const container = targetParentId === null
      ? state.triggers
      : (function () {
          const p = state.triggers.find(function (n) { return n.id === targetParentId; });
          return p && Array.isArray(p.attachedMoveIds) ? p.attachedMoveIds : null;
        })();
    if (!container) return null;
    const isStringContainer = targetParentId !== null;
    let targetIdx;
    if (isStringContainer) {
      targetIdx = container.indexOf(targetId);
    } else {
      targetIdx = container.findIndex(function (n) { return n.id === targetId; });
    }
    if (targetIdx === -1) return null;
    if (isTopHalf) {
      return {
        beforeId: targetId,
        parentId: targetParentId,
        dropClass: "drop-before",
      };
    }
    const next = container[targetIdx + 1];
    return {
      beforeId: next ? (isStringContainer ? next : next.id) : null,
      parentId: targetParentId,
      dropClass: "drop-after",
    };
  }

  // Move the source node to (beforeId, parentId). beforeId=null means append.
  function reorder(sourceId, beforeId, parentId) {
    const sourceLoc = findNodeLocation(sourceId);
    if (!sourceLoc) return;
    // Resolve destination container
    let destContainer;
    let isStringContainer = false;
    if (parentId === null) {
      destContainer = state.triggers;
    } else {
      const parent = state.triggers.find(function (n) { return n.id === parentId; });
      if (!parent || parent.type !== "trigger") return;
      if (!Array.isArray(parent.attachedMoveIds)) parent.attachedMoveIds = [];
      destContainer = parent.attachedMoveIds;
      isStringContainer = true;
    }
    // Resolve insertion index
    let destIndex;
    if (beforeId === null) {
      destIndex = destContainer.length;
    } else if (isStringContainer) {
      destIndex = destContainer.indexOf(beforeId);
      if (destIndex === -1) destIndex = destContainer.length;
    } else {
      destIndex = destContainer.findIndex(function (n) { return n.id === beforeId; });
      if (destIndex === -1) destIndex = destContainer.length;
    }
    // Splice out the source
    sourceLoc.container.splice(sourceLoc.index, 1);
    // If the source's removal shifted the destination index backward, adjust
    if (sourceLoc.container === destContainer && sourceLoc.index < destIndex) {
      destIndex -= 1;
    }
    destContainer.splice(destIndex, 0, sourceLoc.node);
    queueSave();
    render();
  }

  function maybeAutoScroll(listEl, clientY) {
    if (!listEl) return;
    const rect = listEl.getBoundingClientRect();
    const edge = 24;
    if (clientY < rect.top + edge) {
      listEl.scrollTop -= 8;
    } else if (clientY > rect.bottom - edge) {
      listEl.scrollTop += 8;
    }
  }

  function endDrag(e) {
    if (!dragState) return;
    const ds = dragState;
    dragState = null;
    if (ds.pointerId !== undefined && ds.handle && typeof ds.handle.releasePointerCapture === "function") {
      try { ds.handle.releasePointerCapture(ds.pointerId); } catch (err) { /* ignore */ }
    }
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    clearDropTargetClasses();
    if (ds.sourceRow) ds.sourceRow.classList.remove("questing-adventurer-panel__row--dragging-source");
    // Remove the ghost unconditionally so it doesn't survive a successful drop.
    if (ds.ghost && ds.ghost.parentNode) {
      ds.ghost.parentNode.removeChild(ds.ghost);
    }
    if (ds.isDragging) {
      const drop = getDropTarget(e.clientX, e.clientY, ds.sourceId);
      if (drop) {
        reorder(ds.sourceId, drop.beforeId, drop.parentId);
        if (ds.ariaLive) {
          ds.ariaLive.textContent = "Moved " + ds.sourceLabel + " to new position.";
        }
      }
    }
  }

  function onPointerUp(e) {
    endDrag(e);
  }

  function onPointerMove(e) {
    if (!dragState) return;
    const ds = dragState;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (!ds.isDragging) {
      // Wait until the user moves past a small threshold before starting the drag.
      if (Math.hypot(dx, dy) < 5) return;
      ds.isDragging = true;
      // Build the ghost.
      const ghost = document.createElement("div");
      ghost.className = "questing-adventurer-panel__drag-ghost";
      ghost.textContent = ds.sourceLabel;
      document.body.appendChild(ghost);
      ds.ghost = ghost;
      if (ds.sourceRow) ds.sourceRow.classList.add("questing-adventurer-panel__row--dragging-source");
      if (ds.sourceRow) ds.sourceRow.setAttribute("aria-grabbed", "true");
    }
    // Update ghost position
    if (ds.ghost) {
      ds.ghost.style.left = e.clientX + 8 + "px";
      ds.ghost.style.top = e.clientY + 8 + "px";
    }
    // Update drop target
    clearDropTargetClasses();
    const drop = getDropTarget(e.clientX, e.clientY, ds.sourceId);
    if (drop) {
      const list = document.querySelector(".questing-adventurer-panel__list");
      if (list) {
        const targetRow = list.querySelector('[data-id="' + cssEscape(drop.beforeId || "") + '"]') ||
          (drop.parentId ? list.querySelector('[data-id="' + cssEscape(drop.parentId) + '"]') : null);
        if (targetRow) {
          targetRow.classList.add("questing-adventurer-panel__row--" + drop.dropClass);
        }
      }
    }
    // Auto-scroll if near edges
    if (ds.list) maybeAutoScroll(ds.list, e.clientY);
  }

  // CSS.escape wrapper. Stash targets evergreen browsers where CSS.escape is
  // always available.
  function cssEscape(s) {
    return CSS.escape(s);
  }

  function startDrag(e, sourceId, sourceLabel) {
    if (editingId) return; // no drag while editing
    if (e.button !== undefined && e.button !== 0) return; // only primary button
    e.preventDefault();
    const handle = e.currentTarget;
    const sourceRow = handle.closest("[data-row-type]");
    const list = document.querySelector(".questing-adventurer-panel__list");
    // aria-live lives on document.body so it survives the render() that
    // happens after a successful drop. (If it were inside the panel,
    // reorder() -> render() would clear it before the announcement fires.)
    const ariaLive = ensureAriaLive();
    dragState = {
      sourceId: sourceId,
      sourceLabel: sourceLabel,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      ghost: null,
      sourceRow: sourceRow,
      list: list,
      handle: handle,
      pointerId: e.pointerId,
      ariaLive: ariaLive,
    };
    if (typeof handle.setPointerCapture === "function" && e.pointerId !== undefined) {
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
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
          // Don't set collapsed here — let loadState apply the dynamic default
          // (expanded if there are active triggers, collapsed otherwise).
          opacity: typeof legacy.opacity === "number" ? legacy.opacity : 0.6,
          panelPos:
            legacy.panelPos && typeof legacy.panelPos.top === "number" && typeof legacy.panelPos.right === "number"
              ? { top: legacy.panelPos.top, right: legacy.panelPos.right }
              : { top: 8, right: 8 },
        };
        try {
          await csLib.setConfiguration(CONFIG_KEY, migrated);
        } catch (e) {
          console.error("QuestingAdventurer: failed to write migrated config:", e);
          return;
        }
        try {
          await csLib.setConfiguration(LEGACY_CONFIG_KEY, { moves: [], triggers: [], collapsed: true });
        } catch (e) {
          console.error("QuestingAdventurer: failed to clear legacy config:", e);
        }
        console.info("QuestingAdventurer: migrated legacy SceneRules config.");
      } catch (err) {
        console.error("QuestingAdventurer: migration check failed:", err);
      }
    })();
  }

  // Migrate v1' (post-rename) data to v2 (moves library + triggers with
  // attachedMoveIds). Runs on every loadState when the stored data is in
  // v1' format (has `triggers` but no `moves`).
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
        // Top-level moves in v1' go into the library, unattached.
        moves.push({ id: node.id || generateId(), type: "move", text: node.text });
      }
    }
    return { moves: moves, triggers: triggers };
  }

  async function loadState() {
    try {
      const stored = (await storage.loadConfig()) || {};
      // v2 format has both `moves` and `triggers` arrays.
      if (Array.isArray(stored.moves) && Array.isArray(stored.triggers)) {
        state.moves = stored.moves.map(function (m) {
          return { id: m.id, type: "move", text: m.text };
        });
      state.triggers = stored.triggers.map(function (t) {
        return {
          id: t.id,
          type: "trigger",
          name: t.name,
          // v2 default: only "active" if explicitly true. Triggers migrated
          // from v0/v1' data have active: true set by migrateFromLegacy.
          // New triggers created in the overlay/settings page should start
          // INACTIVE (active: false) so the user activates them via Penalty.
          active: t.active === true,
          attachedMoveIds: Array.isArray(t.attachedMoveIds) ? t.attachedMoveIds : [],
          sceneTagIds: Array.isArray(t.sceneTagIds) ? t.sceneTagIds.map(String) : [],
          markerTagIds: Array.isArray(t.markerTagIds) ? t.markerTagIds.map(String) : [],
          autoRules: normalizeAutoRules(t.autoRules),
        };
      });
      } else {
        // v1' or v0 format — migrate to v2.
        const migrated = migrateV1ToV2(stored);
        state.moves = migrated.moves;
        state.triggers = migrated.triggers;
        // Persist the migrated form so the next load is a fast v2 read.
        queueSave();
      }
      // Tag bindings are additive: absent in every config written before the
      // feature existed (normalize returns []), and sanitized on every load so
      // a hand-edited or half-written config cannot reach the firing path with
      // a numeric id or a duplicated row.
      state.tagBindings = shared.normalizeTagBindings(stored.tagBindings);
      // `collapsed`: first-load default is dynamic — expanded if there are
      // active triggers, collapsed otherwise. After the user manually toggles,
      // the stored boolean value is used.
      if (typeof stored.collapsed === "boolean") {
        state.collapsed = stored.collapsed;
      } else {
        const hasActive = state.triggers.some(function (t) { return t.active; });
        state.collapsed = !hasActive;
      }
      const o =
        typeof stored.opacity === "number" && !Number.isNaN(stored.opacity)
          ? stored.opacity
          : DEFAULT_OPACITY;
      state.opacity = Math.min(1, Math.max(0, o));
      state.showAddControls = stored.showAddControls === true;
      state.showManualControls = stored.showManualControls === true;
      if (stored.hardware && typeof stored.hardware === "object") {
        hardwareConfig = {
          enabled: stored.hardware.enabled === true,
          url: typeof stored.hardware.url === "string" && stored.hardware.url ? stored.hardware.url : "ws://localhost:12345",
          intensity: typeof stored.hardware.intensity === "number" ? Math.max(0, Math.min(1, stored.hardware.intensity)) : 0.4,
          durationMs: typeof stored.hardware.durationMs === "number" ? Math.max(100, Math.min(10000, stored.hardware.durationMs)) : 1000,
        };
      }
      if (
        stored.panelSize &&
        typeof stored.panelSize.width === "number" &&
        stored.panelSize.width >= 200 &&
        stored.panelSize.width <= 1200
      ) {
        state.panelSize = {
          width: stored.panelSize.width,
          height: typeof stored.panelSize.height === "number" ? stored.panelSize.height : undefined,
        };
      } else {
        state.panelSize = { width: DEFAULT_PANEL_WIDTH, height: undefined };
      }
      if (
        stored.panelPos &&
        typeof stored.panelPos.top === "number" &&
        typeof stored.panelPos.right === "number"
      ) {
        state.panelPos = {
          top: Math.max(0, stored.panelPos.top),
          right: Math.max(0, stored.panelPos.right),
        };
      } else {
        state.panelPos = { ...DEFAULT_PANEL_POS };
      }
    } catch (err) {
      console.error("QuestingAdventurer: failed to load configuration:", err);
      state.moves = [];
      state.triggers = [];
      state.collapsed = true;
      state.opacity = DEFAULT_OPACITY;
      state.panelPos = { ...DEFAULT_PANEL_POS };
    }
  }

  async function queueSave() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    pendingSave = false;
    try {
      const result = storage.saveConfig({
        moves: state.moves,
        triggers: state.triggers,
        // The overlay never edits bindings, but it must carry them: the save
        // replaces the whole config object, so omitting this key would delete
        // every binding the settings page wrote.
        tagBindings: state.tagBindings,
        collapsed: state.collapsed,
        opacity: state.opacity,
        panelPos: state.panelPos,
        panelSize: state.panelSize,
        showAddControls: state.showAddControls,
        showManualControls: state.showManualControls,
        hardware: hardwareConfig,
      }, function (latest) {
        // Persist this surface's values on top of the newest revision. The
        // two surfaces own different fields; this at least guarantees the
        // write is based on the newest revision rather than a stale one.
        return Object.assign({}, latest || {}, {
          moves: state.moves,
          triggers: state.triggers,
          tagBindings: state.tagBindings,
          collapsed: state.collapsed,
          opacity: state.opacity,
          panelPos: state.panelPos,
          panelSize: state.panelSize,
          showAddControls: state.showAddControls,
          showManualControls: state.showManualControls,
          hardware: hardwareConfig,
        });
      }, "Questing Adventurer overlay");
      await result;
      saving = false;
      if (pendingSave) queueSave();
    } catch (err) {
      console.error("QuestingAdventurer: failed to save configuration:", err);
      saving = false;
      if (pendingSave) queueSave();
    }
  }

  function findNode(id) {
    for (const node of state.triggers) {
      if (node.id === id) return node;
      if (node.type === "trigger" && Array.isArray(node.attachedMoveIds)) {
        for (const moveId of node.attachedMoveIds) {
          if (moveId === id) {
            const move = state.moves.find(function (m) { return m.id === id; });
            return move || null;
          }
        }
      }
    }
    return null;
  }

  function clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function createEditInput(value, id) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "questing-adventurer-panel__edit-input";
    input.value = value;
    input.dataset.id = id;

    function save() {
      if (editingId !== id) return;
      const newValue = input.value.trim();
      if (newValue !== "") {
        const node = findNode(id);
        if (node) {
          if (node.type === "trigger") {
            node.name = newValue;
          } else {
            node.text = newValue;
          }
          queueSave();
        }
      }
      editingId = null;
      render();
    }

    function cancel() {
      if (editingId !== id) return;
      editingId = null;
      render();
    }

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });

    input.addEventListener("blur", save);

    requestAnimationFrame(function () {
      input.focus();
      input.select();
    });

    return input;
  }

  function getFooterValue(panel) {
    const input = panel.querySelector(".questing-adventurer-panel__input");
    return input ? input.value.trim() : "";
  }

  function renderCollapsedChip(panel) {
    panel.classList.add("questing-adventurer-panel--collapsed");
    // Clear any inline width/height left over from a previous edge-resize
    // so the collapsed panel can shrink to the chip's intrinsic size
    // (the --collapsed CSS rule sets min-width/min-height to 0). Without
    // this, a panel the user resized to e.g. 600×400 stays that big
    // even when collapsed, leaving a huge empty box around the chip.
    panel.style.width = "";
    panel.style.height = "";
    panel.style.setProperty("--qa-bg-alpha", state.opacity);
    try {
      const chip = document.createElement("div");
      chip.className = "questing-adventurer-panel__chip";
      chip.dataset.action = "toggle-collapse";
      chip.dataset.dragThreshold = "true";
      chip.title = "Click to expand · Drag to move";
      chip.setAttribute(
        "aria-label",
        "\ud83d\uddfa\ufe0f Triggers (" + getActiveTriggerCount() + "). Click to expand, drag to move."
      );
      // Icon / label / count as separate spans so the count can be set in
      // tabular figures on an accent pill instead of sitting inside a run of
      // text. Same words as before ("🗺️ Triggers (N)"), same meaning.
      const chipIcon = document.createElement("span");
      chipIcon.className = "questing-adventurer-panel__chip-icon";
      chipIcon.setAttribute("aria-hidden", "true");
      chipIcon.textContent = "\ud83d\uddfa\ufe0f";
      const chipLabel = document.createElement("span");
      chipLabel.className = "questing-adventurer-panel__chip-label";
      chipLabel.textContent = "Triggers";
      const chipCount = document.createElement("span");
      chipCount.className = "questing-adventurer-panel__chip-count";
      chipCount.textContent = String(getActiveTriggerCount());
      chip.appendChild(chipIcon);
      chip.appendChild(chipLabel);
      chip.appendChild(chipCount);
      // The collapsed chip doubles as a drag handle: pointerdown starts a
      // threshold-gated panel drag (the panel only moves after 5px of
      // movement; a sub-threshold release is a click that toggles
      // collapse). See startPanelDrag for the threshold logic and
      // suppressNextClick for how we keep the click from firing after a
      // real drag.
      chip.addEventListener("pointerdown", startPanelDrag);
      panel.appendChild(chip);
    } catch (chipErr) {
      console.error("QuestingAdventurer: failed to render collapse chip:", chipErr);
    }
  }

  // Render the expanded header: penalty, reward, opacity slider, close button.
  // Returns { addToggleBtn, manualToggleBtn } for use by renderBottomToggles.
  function renderHeader(panel) {
    const header = document.createElement("div");
    header.className = "questing-adventurer-panel__header";
    header.addEventListener("pointerdown", startPanelDrag);
    // A compact micro-label plus the active count. Three anonymous buttons in
    // a row have no subject; "TRIGGERS (3)" names the panel and surfaces the
    // count that the collapsed chip already shows. The label is hidden by a
    // container query below 320px so the controls never crowd (see CSS).
    const titleWrap = document.createElement("span");
    titleWrap.className = "questing-adventurer-panel__header-title-wrap";
    const titleEl = document.createElement("span");
    titleEl.className = "questing-adventurer-panel__header-title";
    titleEl.textContent = "Triggers";
    const titleCount = document.createElement("span");
    titleCount.className = "questing-adventurer-panel__header-count";
    titleCount.textContent = String(getActiveTriggerCount());
    titleCount.title = getActiveTriggerCount() + " active trigger(s)";
    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(titleCount);
    header.appendChild(titleWrap);

    const controls = document.createElement("span");
    controls.className = "questing-adventurer-panel__header-controls";

    const penaltyBtn = document.createElement("button");
    penaltyBtn.type = "button";
    penaltyBtn.dataset.action = "apply-penalty";
    penaltyBtn.className = "questing-adventurer-panel__penalty-button";
    penaltyBtn.title = "Penalty: activate a random inactive trigger or attach a move";
    penaltyBtn.setAttribute("aria-label", "Penalty: activate a random inactive trigger or attach a move");
    penaltyBtn.textContent = "Penalty";
    // v2 semantics: penalty is enabled only if there is at least one
    // trigger AND at least one move is under the 2-trigger attachment cap.
    // When the library is exhausted, the button greys out instead of
    // activating empty triggers.
    penaltyBtn.disabled = state.triggers.length === 0 || getAvailableMoves().length === 0;
    controls.appendChild(penaltyBtn);

    const rewardBtn = document.createElement("button");
    rewardBtn.type = "button";
    rewardBtn.dataset.action = "apply-reward";
    rewardBtn.className = "questing-adventurer-panel__reward-button";
    rewardBtn.title = "Reward: detach a random move from a random active trigger";
    rewardBtn.setAttribute("aria-label", "Reward: detach a random move from a random active trigger");
    rewardBtn.textContent = "Reward";
    // v2 semantics: reward needs an active trigger that still has attached moves.
    rewardBtn.disabled = !state.triggers.some(function (t) {
      return t.active && Array.isArray(t.attachedMoveIds) && t.attachedMoveIds.length > 0;
    });
    controls.appendChild(rewardBtn);

    const addToggleBtn = document.createElement("button");
    addToggleBtn.type = "button";
    addToggleBtn.dataset.action = "toggle-add-controls";
    addToggleBtn.className = "questing-adventurer-panel__add-toggle-button";
    addToggleBtn.title = "Add trigger or move";
    addToggleBtn.setAttribute("aria-label", "Add trigger or move");
    addToggleBtn.setAttribute("aria-expanded", state.showAddControls ? "true" : "false");
    addToggleBtn.textContent = "+";
    // Moved out of the header controls and instead appended to the
    // panel itself between the list and the footer (see renderBottomToggles),
    // so it sits at the bottom-center of the panel rather than the top-right
    // of the header. This is more natural for the expand-add-controls
    // action — the toggle lives where the controls it reveals (the
    // footer with input + Add Trigger + Add Move) lives.
    //
    // Sits next to the manual button in a bottom-toggles wrapper.
    // The two toggles share the same row:
    //   +     — Add new trigger or move (creates a fresh item)
    //   ≡     — Manual selection (operate on EXISTING items: activate
    //           inactive triggers, attach library moves to triggers)

    const manualToggleBtn = document.createElement("button");
    manualToggleBtn.type = "button";
    manualToggleBtn.dataset.action = "toggle-manual-controls";
    manualToggleBtn.className = "questing-adventurer-panel__manual-toggle-button";
    manualToggleBtn.title = "Manual selection: activate an inactive trigger or attach a library move to a trigger";
    manualToggleBtn.setAttribute("aria-label", "Manual selection");
    manualToggleBtn.setAttribute("aria-expanded", state.showManualControls ? "true" : "false");
    manualToggleBtn.textContent = "\u2261"; // ≡ — equivalent / library symbol

    const opacityWrap = document.createElement("span");
    opacityWrap.className = "questing-adventurer-panel__opacity-control";

    const opacityBtn = document.createElement("button");
    opacityBtn.type = "button";
    opacityBtn.dataset.action = "opacity-reset";
    opacityBtn.className = "questing-adventurer-panel__opacity-button";
    opacityBtn.title = "Panel opacity (Ctrl/⌘+click to reset)";
    opacityBtn.setAttribute("aria-label", "Panel opacity");
    opacityBtn.textContent = getOpacityIcon(state.opacity);
    opacityWrap.appendChild(opacityBtn);

    const opacitySlider = document.createElement("input");
    opacitySlider.type = "range";
    opacitySlider.className = "questing-adventurer-panel__opacity-slider";
    opacitySlider.dataset.action = "opacity-slider";
    opacitySlider.min = "0";
    opacitySlider.max = "1";
    opacitySlider.step = "0.05";
    opacitySlider.value = String(state.opacity);
    opacitySlider.setAttribute("aria-label", "Panel background opacity");
    opacitySlider.title = "Panel background opacity (" + Math.round(state.opacity * 100) + "%)";

    opacitySlider.addEventListener("input", function () {
      const v = parseFloat(opacitySlider.value);
      if (Number.isNaN(v)) return;
      state.opacity = Math.min(1, Math.max(0, v));
      panel.style.setProperty("--qa-bg-alpha", state.opacity);
      opacityBtn.textContent = getOpacityIcon(state.opacity);
      opacitySlider.title = "Panel background opacity (" + Math.round(state.opacity * 100) + "%)";
      queueSave();
    });

    opacityWrap.appendChild(opacitySlider);
    controls.appendChild(opacityWrap);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.dataset.action = "toggle-collapse";
    closeBtn.className = "questing-adventurer-panel__close-button";
    closeBtn.title = "Collapse";
    closeBtn.setAttribute("aria-label", "Collapse panel");
    closeBtn.textContent = "\u00d7";

    header.appendChild(controls);
    // The close button is appended directly to the header (not inside the
    // controls span) and absolutely positioned at the top-right corner via
    // .questing-adventurer-panel__close-button. This decouples it from the
    // opacity slider's hover-reveal expansion — previously, when the user
    // moved the cursor left-to-right toward close, the opacity-control's
    // hover triggered the slider to expand (width 0 → 80px), pushing close
    // rightward and making it "run away" from the cursor.
    header.appendChild(closeBtn);
    panel.appendChild(header);

    return { addToggleBtn: addToggleBtn, manualToggleBtn: manualToggleBtn };
  }

  function renderActiveList(panel) {
    const list = document.createElement("div");
    list.className = "questing-adventurer-panel__list";

    const activeTriggers = state.triggers.filter(function (t) {
      return t.active === true && (isTriggerEligible(t) || isTriggerAutoPinned(t));
    });
    if (activeTriggers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "questing-adventurer-panel__empty";
      empty.textContent = "No active triggers. Click Penalty to activate one.";
      list.appendChild(empty);
    } else {
      activeTriggers.forEach(function (trigger) {
        renderTrigger(list, trigger);
      });
    }
    panel.appendChild(list);
  }

  function renderBottomToggles(panel, addToggleBtn, manualToggleBtn) {
    // Bottom-center toggles. The + and ≡ buttons share a single row so the
    // user can see at a glance that there are two related "show more"
    // affordances sitting at the bottom of the panel. The CSS uses flexbox
    // with gap to space them; both are align-self: center on the panel's
    // flex column, so they sit centered horizontally below the list (or
    // the library section, if open).
    const bottomToggles = document.createElement("div");
    bottomToggles.className = "questing-adventurer-panel__bottom-toggles";
    bottomToggles.appendChild(addToggleBtn);
    bottomToggles.appendChild(manualToggleBtn);
    panel.appendChild(bottomToggles);
  }

  function renderFooter(panel) {
    const footer = document.createElement("div");
    footer.className = "questing-adventurer-panel__footer";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "questing-adventurer-panel__input";
    input.placeholder = "New trigger or move name";

    const addTriggerBtn = document.createElement("button");
    addTriggerBtn.dataset.action = "add-trigger-top";
    addTriggerBtn.textContent = "Add Trigger";

    const addMoveBtn = document.createElement("button");
    addMoveBtn.dataset.action = "add-move-top";
    addMoveBtn.textContent = "Add Move";

    function syncButtons() {
      const empty = input.value.trim() === "";
      addTriggerBtn.disabled = empty;
      addMoveBtn.disabled = empty;
      panel.querySelectorAll('[data-action="add-move-into"]').forEach(function (btn) {
        btn.disabled = empty;
      });
    }

    // Only run syncButtons() when the input's empty/non-empty state changes,
    // not on every keystroke. The button disabled states only flip when the
    // input goes from empty → non-empty or vice versa; running the full
    // DOM traversal (querySelectorAll over every trigger's add-move-into
    // button) on every keypress is wasteful at scale.
    let wasEmpty = true;
    input.addEventListener("input", function (e) {
      const isEmpty = e.target.value.trim() === "";
      if (isEmpty !== wasEmpty) {
        wasEmpty = isEmpty;
        syncButtons();
      }
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim() !== "") {
        // addMoveTop calls render() which rebuilds the DOM with a fresh empty
        // input and a fresh syncButtons() call. No need to clear the value
        // or call syncButtons() here — the old DOM is already detached.
        addMoveTop(input.value.trim());
      }
    });

    footer.appendChild(input);
    footer.appendChild(addTriggerBtn);
    footer.appendChild(addMoveBtn);
    panel.appendChild(footer);

    // Apply the showAddControls state class so CSS can hide the footer
    // (input + Add buttons) by default and reveal it when the + toggle is
    // on. We use toggle() (not just add()) so the class is actually REMOVED
    // when the state is false — otherwise the class would stick around
    // forever after the first time it was set true, and the CSS
    // hide-by-default would be permanently overridden.
    panel.classList.toggle("questing-adventurer-panel--show-add-controls", state.showAddControls);

    // syncButtons must run AFTER the list is rendered (so add-move-into
    // buttons exist in the DOM). The caller (render()) ensures this order.
    syncButtons();
  }

  function render() {
    let panel = document.querySelector(".questing-adventurer-panel");
    if (!panel) {
      // Panel was removed (e.g., by a React re-render of the video player).
      // Re-create it on the current player and bail — setupPanel calls render.
      const player = document.querySelector("#VideoJsPlayer");
      if (player) {
        setupPanel(player);
        return;
      }
      return;
    }

    // Always re-apply the persisted position so the panel never drifts to
    // (0,0) if the inline style was clobbered.
    panel.style.top = state.panelPos.top + "px";
    panel.style.right = state.panelPos.right + "px";

    clearChildren(panel);

    if (state.collapsed) {
      renderCollapsedChip(panel);
      // Collapsed panels have no resizable edges — this also strips any
      // handles that survived from the expanded state.
      syncResizeHandles(panel);
      return;
    }

    panel.classList.remove("questing-adventurer-panel--collapsed");
    // Restore the persisted panel size when expanding. The collapsed
    // branch clears inline width/height so the box shrinks to the chip;
    // here we re-apply the user's last resize so the expanded panel
    // returns to the size they set. Only width is always restored;
    // height is restored only if the user had set one (undefined →
    // auto, letting the panel grow with content).
    if (state.panelSize && typeof state.panelSize.width === "number") {
      panel.style.width = state.panelSize.width + "px";
    }
    if (state.panelSize && typeof state.panelSize.height === "number") {
      panel.style.height = state.panelSize.height + "px";
    } else {
      panel.style.height = "";
    }
    panel.style.setProperty("--qa-bg-alpha", state.opacity);

    const toggles = renderHeader(panel);

    renderActiveList(panel);

    renderQuestLog(panel);

    // Manual selection "Library" section. Rendered between the active-trigger
    // list and the bottom toggles when the user has opened it via the ≡ button.
    if (state.showManualControls) {
      renderLibrarySection(panel);
    }

    renderBottomToggles(panel, toggles.addToggleBtn, toggles.manualToggleBtn);
    // renderFooter must come after renderActiveList so syncButtons() can
    // query the add-move-into buttons that renderTrigger creates.
    renderFooter(panel);
    // Re-create the decorative edge strips LAST so they stay on top of the
    // freshly rendered content and are never removed by clearChildren() on
    // the next pass without being put back. Rebuilding them here is the fix
    // for "the panel can't be resized by dragging" — see the Edge resize
    // block below.
    syncResizeHandles(panel);
  }

  function renderTrigger(list, trigger) {
    const row = document.createElement("div");
    row.className = "questing-adventurer-panel__trigger";
    row.dataset.id = trigger.id;
    row.dataset.rowType = "trigger";
    row.dataset.parentTrigger = "";
    row.style.setProperty("--qa-indent", "0px");

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "questing-adventurer-panel__drag-handle";
    handle.dataset.action = "drag-handle";
    handle.dataset.id = trigger.id;
    handle.setAttribute("aria-label", "Drag to reorder");
    handle.title = "Drag to reorder";
    handle.textContent = "\u22ee\u22ee";
    handle.addEventListener("pointerdown", function (e) {
      startDrag(e, trigger.id, trigger.name);
    });
    if (editingId === trigger.id) {
      row.classList.add("questing-adventurer-panel__row--editing");
    } else {
      row.appendChild(handle);
    }

    const nameEl = document.createElement("span");
    nameEl.className = "questing-adventurer-panel__trigger-name";
    nameEl.dataset.action = "edit";
    nameEl.dataset.id = trigger.id;
    nameEl.title = "Double-click to edit";
    if (editingId === trigger.id) {
      nameEl.appendChild(createEditInput(trigger.name, trigger.id));
    } else {
      nameEl.textContent = trigger.name;
    }
    row.appendChild(nameEl);

    // "2/4" for the run this trigger is currently in. The denominator is the
    // attached list, not a count of how often the trigger happened — see the
    // Quest Log header comment for why that distinction matters.
    const run = currentRun(trigger.id);
    if (run) {
      const attached = Array.isArray(trigger.attachedMoveIds) ? trigger.attachedMoveIds : [];
      let doneCount = 0;
      for (const moveId of attached) {
        if (isRunItemDone(run.id, moveId)) doneCount++;
      }
      if (attached.length > 0) {
        const badge = document.createElement("span");
        badge.className = "questing-adventurer-panel__run-count";
        badge.textContent = doneCount + "/" + attached.length;
        badge.title = doneCount + " of " + attached.length + " moves completed in run #" + run.run;
        badge.setAttribute(
          "aria-label",
          "Run " + run.run + ": " + doneCount + " of " + attached.length + " moves completed"
        );
        row.appendChild(badge);
      }
    }

    const controls = document.createElement("span");
    controls.className = "questing-adventurer-panel__controls";

    const addBtn = document.createElement("button");
    addBtn.dataset.action = "add-move-into";
    addBtn.dataset.id = trigger.id;
    addBtn.title = "Add move to this trigger";
    addBtn.textContent = "+";

    const delBtn = document.createElement("button");
    delBtn.dataset.action = "deactivate-trigger";
    delBtn.dataset.id = trigger.id;
    delBtn.title = "Deactivate trigger";
    delBtn.textContent = "\u00d7";

    controls.appendChild(addBtn);
    controls.appendChild(delBtn);
    row.appendChild(controls);
    list.appendChild(row);

    // v2: render attached moves by resolving ids against the global library.
    if (Array.isArray(trigger.attachedMoveIds)) {
      for (const moveId of trigger.attachedMoveIds) {
        const move = state.moves.find(function (m) { return m.id === moveId; });
        if (move) {
          renderMove(list, move, true, trigger.id);
        }
      }
    }
  }

  function renderMove(list, move, indented, parentTriggerId) {
    const row = document.createElement("div");
    row.className =
      "questing-adventurer-panel__move" +
      (indented ? " questing-adventurer-panel__move--indented" : "");
    row.dataset.id = move.id;
    row.dataset.rowType = "move";
    row.dataset.parentTrigger = parentTriggerId || "";
    row.style.setProperty("--qa-indent", indented ? "24px" : "0px");

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "questing-adventurer-panel__drag-handle";
    handle.dataset.action = "drag-handle";
    handle.dataset.id = move.id;
    handle.setAttribute("aria-label", "Drag to reorder");
    handle.title = "Drag to reorder";
    handle.textContent = "\u22ee\u22ee";
    handle.addEventListener("pointerdown", function (e) {
      startDrag(e, move.id, move.text);
    });
    if (editingId === move.id) {
      row.classList.add("questing-adventurer-panel__row--editing");
    } else {
      row.appendChild(handle);
    }

    const textEl = document.createElement("span");
    textEl.className = "questing-adventurer-panel__move-text";
    textEl.dataset.action = "edit";
    textEl.dataset.id = move.id;
    textEl.title = "Double-click to edit";
    if (editingId === move.id) {
      textEl.appendChild(createEditInput(move.text, move.id));
    } else {
      textEl.textContent = move.text;
    }
    row.appendChild(textEl);

    const controls = document.createElement("span");
    controls.className = "questing-adventurer-panel__controls";

    if (indented) {
      const doneBtn = document.createElement("button");
      doneBtn.type = "button";
      doneBtn.dataset.id = move.id;
      doneBtn.dataset.triggerId = parentTriggerId || "";
      const run = parentTriggerId ? currentRun(parentTriggerId) : null;
      const completed = run ? isRunItemDone(run.id, move.id) : false;
      // Completion is per (run, move). A tick in an earlier run of the same
      // trigger is shown as a hint, not as a tick, and never blocks the
      // button — that was the old bug where one tick marked the move done
      // everywhere for the rest of the session.
      const earlier = completed || !run ? null : earlierRunCompletion(parentTriggerId, move.id);
      doneBtn.dataset.action = completed ? "uncomplete-move" : "complete-move";
      doneBtn.className =
        "questing-adventurer-panel__complete-button" +
        (completed ? " questing-adventurer-panel__complete-button--done" : "") +
        (earlier ? " questing-adventurer-panel__complete-button--earlier" : "");
      doneBtn.title = completed
        ? "Completed in this run \u2014 click to undo"
        : earlier
          ? "Completed in run #" + earlier.run + " \u2014 click to count this run"
          : "Mark this move complete";
      doneBtn.setAttribute(
        "aria-label",
        completed
          ? "Move completed in this run, click to undo"
          : earlier
            ? "Completed in an earlier run, click to complete this run"
            : "Mark move complete"
      );
      doneBtn.textContent = completed ? "\u2713" : "\u25cb";
      controls.appendChild(doneBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.dataset.action = "delete-move";
    delBtn.dataset.id = move.id;
    delBtn.title = "Delete move";
    delBtn.textContent = "\u00d7";

    controls.appendChild(delBtn);
    row.appendChild(controls);
    list.appendChild(row);
  }

  function addMoveTop(text) {
    // v2: add to the global move library. The move is unattached and won't
    // appear in the overlay until Penalty (or the settings page) attaches it
    // to a trigger.
    state.moves.push({ id: generateId(), type: "move", text: text });
    queueSave();
    render();
  }

  function addTriggerTop(name) {
    // v2: new triggers start INACTIVE. The user activates them via Penalty.
    state.triggers.push({
      id: generateId(),
      type: "trigger",
      name: name,
      active: false,
      attachedMoveIds: [],
      sceneTagIds: [],
      markerTagIds: [],
      autoRules: [],
    });
    queueSave();
    render();
  }

  // v2: the overlay's × button on a trigger deactivates it (active: false)
  // and clears its attached moves — it does NOT delete the trigger. The
  // trigger stays in the library and can be re-activated later via Penalty.
  // The moves stay in the global library (clearing the references just
  // makes them available again for Penalty's 2-trigger cap filter).
  function deactivateTrigger(id) {
    const trigger = state.triggers.find(function (n) {
      return n.type === "trigger" && n.id === id;
    });
    if (!trigger) return;
    // The × also drops every attached move. Record that as a run end with the
    // cleared ids, or the log would show a run that simply stops mid-air and
    // a move list that vanished with no explanation.
    // An explicit × is a decision for the rest of the session: automation must
    // not undo it at the next marker.
    autoSuppressed[trigger.id] = true;
    const clearedMoveIds = Array.isArray(trigger.attachedMoveIds) ? trigger.attachedMoveIds.slice() : [];
    if (currentSession && openRuns[trigger.id]) {
      closeRun(trigger.id, "deactivated", { clearedMoveIds: clearedMoveIds });
    }
    trigger.active = false;
    trigger.attachedMoveIds = [];
    queueSave();
    render();
  }

  // Manual-control surface. Two subsections:
  //   1. "Activate Trigger" — list every inactive trigger with a single
  //      click-to-activate button. The user can also leave the trigger
  //      empty (no attached moves) and attach moves later via section 2
  //      or the trigger's own + button. This intentionally diverges from
  //      the Penalty atomicity rule (which refuses to activate a trigger
  //      with no available moves) because manual activation is an
  //      explicit user intent — the user can see the empty trigger in
  //      the active list and choose to attach moves to it themselves.
  //   2. "Attach Move" — list every library move (not at the global
  //      MAX_MOVE_ATTACHMENTS cap) with a dropdown of all triggers
  //      (active first, then inactive). Picking a trigger attaches the
  //      move; if the target trigger is inactive, it's also activated
  //      (mirroring Penalty's atomic behavior). The dropdown disables
  //      options where the move is already attached to that trigger.
  function renderLibrarySection(panel) {
    const library = document.createElement("div");
    library.className = "questing-adventurer-panel__library";

    const headerEl = document.createElement("div");
    headerEl.className = "questing-adventurer-panel__library-header";
    headerEl.textContent = "Manual Selection";
    library.appendChild(headerEl);

    // --- Section 1: Activate inactive triggers ---
    const inactiveTriggers = state.triggers.filter(function (t) { return !t.active && isTriggerEligible(t); });
    if (inactiveTriggers.length > 0) {
      const subheader = document.createElement("div");
      subheader.className = "questing-adventurer-panel__library-subheader";
      subheader.textContent = "Activate Trigger";
      library.appendChild(subheader);

      for (const trigger of inactiveTriggers) {
        const row = document.createElement("div");
        row.className = "questing-adventurer-panel__library-item";
        row.dataset.id = trigger.id;

        const nameEl = document.createElement("span");
        nameEl.className = "questing-adventurer-panel__library-item-text";
        nameEl.textContent = trigger.name;
        row.appendChild(nameEl);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.action = "activate-trigger-manual";
        btn.dataset.id = trigger.id;
        btn.title = "Activate this trigger";
        btn.setAttribute("aria-label", "Activate " + trigger.name);
        btn.textContent = "\u25b6"; // ▶ play / activate
        row.appendChild(btn);

        library.appendChild(row);
      }
    }

    // --- Section 2: Attach library moves to triggers ---
    // Show moves that still have attachment headroom (i.e. attached to
    // fewer than MAX_MOVE_ATTACHMENTS triggers globally). Moves at the
    // cap are filtered out — there's no point showing them, as the
    // attach handler would refuse them anyway.
    const availableMoves = getAvailableMoves();
    const activeTriggers = state.triggers.filter(function (t) { return t.active && isTriggerEligible(t); });
    const inactiveForAttach = state.triggers.filter(function (t) { return !t.active && isTriggerEligible(t); });

    if (state.moves.length > 0) {
      const subheader = document.createElement("div");
      subheader.className = "questing-adventurer-panel__library-subheader";
      subheader.textContent = "Attach Move to Trigger";
      library.appendChild(subheader);

      if (state.triggers.length === 0) {
        const empty = document.createElement("div");
        empty.className = "questing-adventurer-panel__library-empty";
        empty.textContent = "No triggers exist yet. Add one via + above.";
        library.appendChild(empty);
      } else if (availableMoves.length === 0) {
        const empty = document.createElement("div");
        empty.className = "questing-adventurer-panel__library-empty";
        empty.textContent = "All library moves are at the attachment cap. Detach one to free up a slot.";
        library.appendChild(empty);
      } else {
        for (const move of availableMoves) {
          const row = document.createElement("div");
          row.className = "questing-adventurer-panel__library-item";
          row.dataset.id = move.id;

          const textEl = document.createElement("span");
          textEl.className = "questing-adventurer-panel__library-item-text";
          textEl.textContent = move.text;
          // Show the user where the move is currently attached, so they
          // know what the cap situation looks like for this move.
          const attachedTo = state.triggers.filter(function (t) {
            return Array.isArray(t.attachedMoveIds) && t.attachedMoveIds.indexOf(move.id) !== -1;
          });
          if (attachedTo.length > 0) {
            const meta = document.createElement("span");
            meta.className = "questing-adventurer-panel__library-item-meta";
            meta.textContent = " (" + attachedTo.length + "/" + MAX_MOVE_ATTACHMENTS + ")";
            textEl.appendChild(meta);
          }
          row.appendChild(textEl);

          const select = document.createElement("select");
          select.className = "questing-adventurer-panel__library-trigger-picker";
          select.dataset.action = "attach-move-manual";
          select.dataset.moveId = move.id;
          select.setAttribute("aria-label", "Pick a trigger to attach " + move.text + " to");
          // The <select> fires `change` (not `click`) when the user picks
          // an option. Listen directly here rather than relying on the
          // panel-level click delegation. After the attach, render()
          // rebuilds the DOM — the old <select> is detached, so we don't
          // need to clear its value manually. The "— pick trigger —"
          // placeholder (value="") re-appears automatically.
          select.addEventListener("change", function (e) {
            const target = e.target;
            const pickedTriggerId = target.value;
            if (pickedTriggerId) {
              attachMoveToTriggerManual(move.id, pickedTriggerId);
            }
          });

          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "\u2192 pick trigger";
          select.appendChild(placeholder);

          // Active triggers first (the common case), then inactive.
          const orderedTriggers = activeTriggers.concat(inactiveForAttach);
          for (const trigger of orderedTriggers) {
            const opt = document.createElement("option");
            opt.value = trigger.id;
            const alreadyAttached = Array.isArray(trigger.attachedMoveIds) &&
              trigger.attachedMoveIds.indexOf(move.id) !== -1;
            const status = alreadyAttached
              ? " (attached)"
              : trigger.active
              ? " (active)"
              : " (inactive)";
            opt.textContent = trigger.name + status;
            if (alreadyAttached) opt.disabled = true;
            select.appendChild(opt);
          }
          row.appendChild(select);

          library.appendChild(row);
        }
      }
    }

    // If the section is empty (no inactive triggers AND no moves in the
    // library), show a single helpful message instead of an empty box.
    if (inactiveTriggers.length === 0 && state.moves.length === 0) {
      const empty = document.createElement("div");
      empty.className = "questing-adventurer-panel__library-empty";
      empty.textContent = "Library is empty. Add triggers and moves via + above, then come back here to manually activate them.";
      library.appendChild(empty);
    }

    panel.appendChild(library);
  }

  // Manual activate: flip a trigger from inactive to active, without
  // attaching any moves. The user can then attach moves via the library
  // or the trigger's + button. Allowed even when the trigger has no
  // attached moves — manual activation is an explicit user intent and
  // doesn't need the Penalty atomicity guarantee (no empty active
  // triggers by accident).
  function activateTriggerManual(id) {
    const trigger = state.triggers.find(function (n) {
      return n.type === "trigger" && n.id === id;
    });
    if (!trigger || trigger.active) return;
    ensureSession();
    trigger.active = true;
    startRun(trigger, { origin: "manual", observedBy: "user" });
    queueSave();
    announceToAria("Activated " + trigger.name + ".");
    render();
  }

  // Manual attach: attach a library move to a trigger. If the target
  // trigger is inactive, also activate it (mirrors Penalty's atomic
  // behavior — attaching a move to an inactive trigger is meaningless
  // without activation, since the move wouldn't be visible in the
  // active list). Enforces both the per-trigger uniqueness (a move can
  // appear once per trigger's attachedMoveIds) and the global cap
  // (a move can be attached to at most MAX_MOVE_ATTACHMENTS triggers).
  function attachMoveToTriggerManual(moveId, triggerId) {
    if (!moveId || !triggerId) return;
    const move = state.moves.find(function (m) { return m.id === moveId; });
    const trigger = state.triggers.find(function (n) {
      return n.type === "trigger" && n.id === triggerId;
    });
    if (!move || !trigger) return;
    if (!Array.isArray(trigger.attachedMoveIds)) trigger.attachedMoveIds = [];
    if (trigger.attachedMoveIds.indexOf(moveId) !== -1) {
      announceToAria(move.text + " is already attached to " + trigger.name + ".");
      return;
    }
    // Global cap check (the dropdown is built from getAvailableMoves()
    // so a move at the cap shouldn't appear in the list, but defend in
    // depth in case state changed between render and click).
    let attachCount = 0;
    for (const t of state.triggers) {
      if (Array.isArray(t.attachedMoveIds) && t.attachedMoveIds.indexOf(moveId) !== -1) {
        attachCount++;
      }
    }
    if (attachCount >= MAX_MOVE_ATTACHMENTS) {
      announceToAria(
        move.text + " is already attached to " + attachCount +
          " triggers (max " + MAX_MOVE_ATTACHMENTS + "). Detach one to free a slot."
      );
      return;
    }
    // Session first, before the trigger flips to active: ensureSession only
    // opens carried runs for triggers that were already active, so the
    // activation below is the one that starts this run.
    ensureSession();
    trigger.attachedMoveIds.push(moveId);
    const wasInactive = !trigger.active;
    if (wasInactive) {
      trigger.active = true;
      startRun(trigger, { origin: "manual-attach", observedBy: "user" });
    }
    recordEvent("move-attached", {
      runId: openRuns[trigger.id] || null,
      triggerId: trigger.id,
      moveId: moveId,
      moveText: move.text,
      source: "manual",
      atSeconds: currentPlaybackSeconds(),
    });
    queueSave();
    announceToAria(
      "Attached " + move.text + " to " + trigger.name +
        (wasInactive ? "; trigger now active." : ".")
    );
    render();
  }

  function addMoveInto(triggerId, text) {
    // v2: add the move to the global library AND attach it to the trigger.
    const newMoveId = generateId();
    state.moves.push({ id: newMoveId, type: "move", text: text });
    const trigger = state.triggers.find(function (n) {
      return n.type === "trigger" && n.id === triggerId;
    });
    if (trigger) {
      trigger.attachedMoveIds.push(newMoveId);
      queueSave();
      render();
    }
  }

  function deleteMove(id) {
    // v2: moves live in the global library, but the overlay's delete button
    // detaches the move from its parent trigger (not deleting from the
    // library). The settings page handles library-level deletion.
    // Determine the parent trigger via the row's data attribute.
    for (let i = 0; i < state.triggers.length; i++) {
      const trigger = state.triggers[i];
      if (!Array.isArray(trigger.attachedMoveIds)) continue;
      const idx = trigger.attachedMoveIds.indexOf(id);
      if (idx !== -1) {
        trigger.attachedMoveIds.splice(idx, 1);
        if (trigger.attachedMoveIds.length === 0) {
          trigger.active = false;
        }
        queueSave();
        render();
        return;
      }
    }
  }

  function deleteTrigger(id) {
    const idx = state.triggers.findIndex(function (n) {
      return n.type === "trigger" && n.id === id;
    });
    if (idx === -1) return;
    const trigger = state.triggers[idx];
    const itemCount = Array.isArray(trigger.attachedMoveIds) ? trigger.attachedMoveIds.length : 0;
    const confirmed = window.confirm(
      'Delete trigger "' + trigger.name + '" and its ' + itemCount + " move(s)?"
    );
    if (confirmed) {
      state.triggers.splice(idx, 1);
      queueSave();
      render();
    }
  }

  // Read the footer input, call fn(text) if non-empty, then clear the input.
  function consumeFooterText(panel, fn) {
    const text = getFooterValue(panel);
    if (!text) return;
    fn(text);
    const input = panel.querySelector(".questing-adventurer-panel__input");
    if (input) input.value = "";
  }

  function handleClick(e) {
    // If the user just finished a panel drag (collapsed chip or expanded
    // header), the browser still fires a `click` after pointerup. Suppress
    // it so dragging the chip doesn't also toggle collapse, and dragging
    // the header doesn't trigger any button that happened to be under the
    // pointer at release time.
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    const panel = document.querySelector(".questing-adventurer-panel");

    switch (action) {
      case "toggle-collapse":
        state.collapsed = !state.collapsed;
        queueSave();
        render();
        break;
      case "opacity-reset":
        if (e.ctrlKey || e.metaKey) {
          state.opacity = DEFAULT_OPACITY;
          queueSave();
          render();
        }
        break;
      case "opacity-slider":
        // Slider changes are handled by its 'input' event listener. Clicks on
        // the track fall through here and are ignored.
        break;
      case "apply-penalty":
        applyPenalty();
        break;
      case "apply-reward":
        applyReward();
        break;
      case "drag-handle":
        // Drag interactions are handled by pointerdown listeners on the handle.
         // A plain click on the handle (no drag) reaches this case and is a
         // no-op. This prevents the click from bubbling to a parent action.
         break;
      case "toggle-add-controls":
        state.showAddControls = !state.showAddControls;
        queueSave();
        render();
        break;
      case "toggle-manual-controls":
        state.showManualControls = !state.showManualControls;
        queueSave();
        render();
        break;
      case "activate-trigger-manual":
        if (id) activateTriggerManual(id);
        break;
      case "attach-move-manual":
        // The <select> fires `change` events, not `click`. The delegation
        // here catches the bubble of a change handler attached below in
        // renderLibrarySection, but it's safer to handle the change
        // directly on the element rather than rely on click delegation
        // (clicks on a <select> don't fire on the select itself across
        // all browsers when the user picks an option). The actual
        // handler is registered in renderLibrarySection.
        break;
      case "add-move-top": {
        consumeFooterText(panel, function (text) { addMoveTop(text); });
        break;
      }
      case "add-trigger-top": {
        consumeFooterText(panel, function (text) { addTriggerTop(text); });
        break;
      }
      case "add-move-into": {
        if (id) {
          consumeFooterText(panel, function (text) { addMoveInto(id, text); });
        }
        break;
      }
      case "complete-move":
        if (id) completeMove(id, el.dataset.triggerId);
        break;
      case "uncomplete-move":
        if (id) undoMove(id, el.dataset.triggerId);
        break;
      case "end-session":
        endSession("manual");
        break;
      case "accept-marker-prompt":
        if (el.dataset.triggerId) acceptMarkerPrompt(el.dataset.triggerId, el.dataset.markerId);
        break;
      case "dismiss-marker-prompt": {
        const prompt = document.querySelector(".questing-adventurer-panel__prompt");
        if (prompt) prompt.remove();
        break;
      }
      case "delete-move":
        if (id) deleteMove(id);
        break;
      case "deactivate-trigger":
        if (id) deactivateTrigger(id);
        break;
    }
  }

  function handleDblClick(e) {
    const el = e.target.closest('[data-action="edit"]');
    if (!el) return;
    const id = el.dataset.id;
    if (id) {
      editingId = id;
      render();
    }
  }

  function startPanelDrag(e) {
    // Don't start a panel drag when the user is pressing a button inside the
    // header (penalty, reward, opacity icon, close).
    if (e.target.closest("button") || e.target.closest("input")) return;
    if (e.button !== undefined && e.button !== 0) return;
    const panel = document.querySelector(".questing-adventurer-panel");
    if (!panel) return;
    // An edge press belongs to the resize gesture (see onPanelPointerDown),
    // not to the move drag — otherwise both handlers would grab the same
    // pointer and the panel would jump around while it resizes. The collapsed
    // chip has no resizable edges, so it keeps its full drag area.
    if (
      !panel.classList.contains("questing-adventurer-panel--collapsed") &&
      resizeEdgeAt(panel, e.clientX, e.clientY)
    ) {
      return;
    }
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const startTop = state.panelPos.top;
    const startRight = state.panelPos.right;
    const startX = e.clientX;
    const startY = e.clientY;
    // Whether to require a movement threshold before actually moving the
    // panel. The collapsed chip doubles as a click-to-expand target, so we
    // can't move the panel on the first pointermove — that would make it
    // impossible to click the chip without dragging it. When threshold is
    // true, the panel only moves after the pointer travels past 5px; if the
    // user releases before that, no drag happened and the click goes
    // through to toggle collapse. The expanded header doesn't need this
    // (its buttons have their own pointerdown handlers and the header
    // itself isn't a click target), so threshold defaults to false.
    const threshold = e.currentTarget.dataset && e.currentTarget.dataset.dragThreshold === "true";
    let dragMoved = false;

    function clampPosition(top, right) {
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const maxRight = Math.max(0, window.innerWidth - rect.width);
      return {
        top: Math.max(0, Math.min(maxTop, top)),
        right: Math.max(0, Math.min(maxRight, right)),
      };
    }

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (threshold && !dragMoved) {
        // Wait until the user moves past a small threshold before starting
        // the drag. This lets the user click the collapsed chip without
        // accidentally dragging the panel.
        if (Math.hypot(dx, dy) < 5) return;
        dragMoved = true;
      }
      // "right" decreases as the user drags right (the panel's right edge
      // moves toward the viewport's right edge).
      const next = clampPosition(startTop + dy, startRight - dx);
      state.panelPos = next;
      panel.style.top = next.top + "px";
      panel.style.right = next.right + "px";
    }

    function onEnd() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      // If a drag actually moved the panel, suppress the next click so the
      // chip's click-to-expand handler doesn't fire on the pointerup.
      if (dragMoved) {
        suppressNextClick = true;
        queueSave();
      }
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  // ---------------------------------------------------------------------------
  // Edge resize: geometry, not DOM
  //
  // Resizing is driven by a hit-test against the panel's own bounding box
  // rather than by pointerdown listeners on the four ".…__resize-handle"
  // strips, for two reasons:
  //
  //  1. The strips are children of the panel, and render() rebuilds the
  //     panel's child list from scratch on every state change. Bindings made
  //     once in setupPanel() were therefore destroyed by the first render,
  //     which is what made the panel impossible to resize by dragging. The
  //     strips are now re-created after each render (syncResizeHandles) but
  //     stay purely decorative, so any future re-render cannot kill resizing.
  //  2. The panel is a scroll container (overflow-y: auto). An absolutely
  //     positioned strip scrolls out of position once the content overflows,
  //     so a strip-anchored gesture would silently stop working at exactly
  //     the moment the user has shrunk the panel enough to need it. A
  //     bounding-box hit-test always matches what the user sees.
  // ---------------------------------------------------------------------------

  // How close to an edge (in px) a press has to be to count as an edge grab.
  // The panel's padding is 8px vertical / 12px horizontal, so this band stays
  // inside the padding and never overlaps a button or an input.
  const RESIZE_EDGE_PX = 6;
  const RESIZE_EDGES = ["top", "right", "bottom", "left"];

  // Returns "top" | "right" | "bottom" | "left" when the point is inside the
  // panel's border box and within RESIZE_EDGE_PX of one of its edges,
  // otherwise null. The nearest edge wins, which also resolves corners: a
  // press 2px from the top and 5px from the left edge resizes from the top.
  function resizeEdgeAt(panel, clientX, clientY) {
    const r = panel.getBoundingClientRect();
    const distances = {
      top: clientY - r.top,
      right: r.right - clientX,
      bottom: r.bottom - clientY,
      left: clientX - r.left,
    };
    let edge = null;
    let nearest = Infinity;
    RESIZE_EDGES.forEach(function (name) {
      const d = distances[name];
      // Negative means the point is outside the panel — a press there can't
      // reach this handler anyway, but guards keep the helper honest.
      if (d < 0 || d > RESIZE_EDGE_PX) return;
      if (d < nearest) {
        nearest = d;
        edge = name;
      }
    });
    return edge;
  }

  // (Re)create the four decorative edge strips. Called at the end of every
  // render pass, because render() clears the panel's children. Collapsed
  // panels have no resizable edges, so no strips are added there.
  function syncResizeHandles(panel) {
    const stale = panel.querySelectorAll(".questing-adventurer-panel__resize-handle");
    for (let i = 0; i < stale.length; i += 1) {
      if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
    }
    if (panel.classList.contains("questing-adventurer-panel--collapsed")) return;
    RESIZE_EDGES.forEach(function (edge) {
      const handle = document.createElement("div");
      handle.className =
        "questing-adventurer-panel__resize-handle " +
        "questing-adventurer-panel__resize-handle--" +
        edge;
      handle.setAttribute("aria-hidden", "true");
      panel.appendChild(handle);
    });
  }

  // Panel-level pointerdown: decides between "nothing", "edge resize" and
  // (via the header/chip handlers that run before this one) "move". Only the
  // primary button resizes, and interactive controls keep their own press.
  function onPanelPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const panel = e.currentTarget;
    if (!panel || panel.classList.contains("questing-adventurer-panel--collapsed")) return;
    if (e.target.closest("button, input, select, textarea, a")) return;
    const edge = resizeEdgeAt(panel, e.clientX, e.clientY);
    if (!edge) return;
    startEdgeResize(e, panel, edge);
  }

  // Edge resize: handle pointer-drag on the four edges (top, right, bottom,
  // left). The panel is positioned with `top` and `right` (anchored to the
  // top-right corner of the video player), so each edge update has to keep
  // the OPPOSITE edge fixed in place by adjusting the appropriate pair of
  // properties.
  //   top:    newTop += dy;   newHeight -= dy   (keep bottom in place)
  //   right:  newRight -= dx; newWidth -= dx    (keep left in place)
  //   bottom: newHeight += dy                   (keep top in place)
  //   left:   newWidth -= dx                    (keep right in place)
  function startEdgeResize(e, panel, edge) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startTop = state.panelPos.top;
    const startRight = state.panelPos.right;
    const startWidth = panel.offsetWidth;
    const startHeight = panel.offsetHeight;

    // Min/max bounds (mirrored from the CSS rules).
    const MIN_W = 240, MAX_W = 800;
    const MIN_H = 80;
    const MAX_H = Math.floor(window.innerHeight * 0.9);

    function clampWidth(w) { return Math.max(MIN_W, Math.min(MAX_W, w)); }
    function clampHeight(h) { return Math.max(MIN_H, Math.min(MAX_H, h)); }

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let newTop = startTop, newRight = startRight;
      let newWidth = startWidth, newHeight = startHeight;
      if (edge === "top") {
        newTop = startTop + dy;
        newHeight = clampHeight(startHeight - dy);
        // Re-anchor: if height hit a min/max bound, top must follow so the
        // bottom edge stays at startTop + startHeight.
        if (startHeight - newHeight !== dy) {
          newTop = startTop + (startHeight - newHeight);
        }
      } else if (edge === "bottom") {
        newHeight = clampHeight(startHeight + dy);
      } else if (edge === "right") {
        newWidth = clampWidth(startWidth - dx);
        newRight = startRight - dx;
        if (startWidth - newWidth !== dx) {
          newRight = startRight - (startWidth - newWidth);
        }
      } else if (edge === "left") {
        newWidth = clampWidth(startWidth - dx);
        // Right edge stays put — don't touch state.panelPos.right.
      }
      state.panelPos = { top: newTop, right: newRight };
      state.panelSize = { width: newWidth, height: newHeight };
      panel.style.top = newTop + "px";
      panel.style.right = newRight + "px";
      panel.style.width = newWidth + "px";
      panel.style.height = newHeight + "px";
    }

    function onEnd() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      queueSave();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  async function setupPanel(playerEl) {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    if (!match) return;
    currentSceneId = match[1];

    if (playerEl.querySelector(".questing-adventurer-panel")) return;

    const computed = window.getComputedStyle(playerEl);
    if (computed.position === "static") {
      playerEl.style.position = "relative";
    }

    await migrateFromLegacy();
    await loadState();
    await loadQuestLog();
    sceneContextSceneId = String(match[1]);
    sceneContext = await fetchSceneContext(match[1]);
    firedMarkerIds = {};
    resetAutoState();

    // Use a plain <div> (not a <dialog>) so the rest of the page is NOT
    // made inert. The overlay is appended to the video player element
    // itself (#VideoJsPlayer) — not to document.body — so when the player
    // goes fullscreen (video.js calls requestFullscreen() on the player
    // element), our overlay goes fullscreen with it as part of the same
    // fullscreen view. Inside the fullscreen view, `z-index` (not the top
    // layer) determines the stacking order, so we can lay the overlay on
    // top of the video with a plain `z-index` value — no top layer, no
    // <dialog showModal()>, no page inertness.
    const panel = document.createElement("div");
    panel.className = "questing-adventurer-panel";
    panel.addEventListener("click", handleClick);
    panel.addEventListener("dblclick", handleDblClick);

    // Apply persisted position (or default) so the panel appears where the
    // user last left it, not in the hardcoded CSS top-right corner. With
    // `position: absolute` (set in CSS), these are offsets from the
    // top-right corner of the player — which becomes the viewport when
    // the player goes fullscreen.
    panel.style.top = state.panelPos.top + "px";
    panel.style.right = state.panelPos.right + "px";

    // Append the panel as a child of the video player. When the player
    // goes fullscreen, the panel goes with it.
    playerEl.appendChild(panel);

    // Edge resize. ONE pointerdown listener on the panel decides whether the
    // press started on an edge (see onPanelPointerDown -> resizeEdgeAt). The
    // four invisible strips are a cursor affordance only and are re-created
    // by render()/syncResizeHandles() on every pass — do NOT bind resize
    // gestures to them here, they are wiped by the next render().
    //
    // The panel never listens for a "resize" event: that event only fires on
    // window and on natively-resizable form controls, never on a <div>, so
    // the size is persisted directly by startEdgeResize() on pointerup.
    panel.addEventListener("pointerdown", onPanelPointerDown);
    render();
    attachTimelinePrompts();
    // Scene-level rules fire only after the first render: firing renders again,
    // and doing it before the panel exists would leave the panel stale.
    applyAutoSceneRules();
    // Tag bindings are scene-level too, so they run here and not on the
    // timeline. Scene rules go first because a rule pinned to this exact scene
    // is more specific than a tag; both paths are idempotent, so the order only
    // decides which origin opens the run in the quest log.
    applyTagBindings();
  }

  csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel);

  if (
    window.PluginApi &&
    window.PluginApi.Event &&
    typeof window.PluginApi.Event.addEventListener === "function"
  ) {
    window.PluginApi.Event.addEventListener("stash:location", function () {
      const nextMatch = window.location.pathname.match(/\/scenes\/(\d+)/);
      if (currentSession && (!nextMatch || String(currentSession.sceneId) !== nextMatch[1])) {
        endSession("navigation");
      }
      if (!nextMatch || (sceneContextSceneId && sceneContextSceneId !== nextMatch[1])) {
        if (timelineCleanup) timelineCleanup();
        firedMarkerIds = {};
      }
      if (!document.querySelector(".questing-adventurer-panel")) {
        const player = document.querySelector("#VideoJsPlayer");
        if (player) setupPanel(player);
      }
    });
  }

  window.addEventListener("pagehide", function () {
    // Silent: the page is going away, and render() would try to re-inject the
    // panel into a player that is already being torn down.
    endSession("pagehide", true);
    flushQuestLogSave();
  });
})();
