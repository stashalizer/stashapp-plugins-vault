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

  const CONFIG_KEY = "QuestingAdventurer";
  const LEGACY_CONFIG_KEY = "SceneRules";
  const DEFAULT_OPACITY = 0.6;
  const DEFAULT_PANEL_POS = { top: 8, right: 8 };

  let state = {
    moves: [],
    triggers: [],
    collapsed: undefined,
    opacity: DEFAULT_OPACITY,
    panelPos: { ...DEFAULT_PANEL_POS },
    locked: false,
    showAddControls: false,
  };
  let editingId = null;
  let saving = false;
  let pendingSave = false;
  let dragState = null; // { sourceId, startX, startY, isDragging, ghost, sourceRow, list, panel }

  function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function isActiveMove(_node) {
    // Retained for backward compatibility with any caller; in v2, "active"
    // lives on the trigger, not the move. A node's active-ness in the overlay
    // is determined by whether its parent trigger is active.
    return false;
  }

  function getOpacityIcon(value) {
    if (value <= 0.2) return "\u25cb"; // ○
    if (value <= 0.5) return "\u25d1"; // ◑
    if (value <= 0.8) return "\u25d0"; // ◐
    return "\u25cf"; // ●
  }

  // Collect every move that is currently inactive (active === false). These
  // are candidates for the Penalty button. Moves with `active: undefined` are
  // treated as active (post-migration default), so they are NOT in this pool.
  function getInactiveMoves() {
    const result = [];
    for (const n of state.triggers) {
      if (n.type === "move" && n.active === false) {
        result.push(n);
      } else if (n.type === "trigger" && Array.isArray(n.items)) {
        for (const m of n.items) {
          if (m.type === "move" && m.active === false) result.push(m);
        }
      }
    }
    return result;
  }

  // Collect every move that is currently active. These are candidates for the
  // Reward button (we deactivate one of them).
  function getActiveMoves() {
    const result = [];
    for (const n of state.triggers) {
      if (isActiveMove(n)) {
        result.push(n);
      } else if (n.type === "trigger" && Array.isArray(n.items)) {
        for (const m of n.items) {
          if (isActiveMove(m)) result.push(m);
        }
      }
    }
    return result;
  }

  // Penalty: pick a random inactive move and make it active. No-op if the
  // inactive pool is empty (the button is disabled in that case, but we
  // defend here too).
  // Penalty: pick a random inactive trigger → activate it AND attach a random
  // unattached move from the library. If every trigger is already active, pick
  // a random active trigger and just attach a random unattached move. If the
  // library has no unattached moves, the trigger is still activated.
  function applyPenalty() {
    if (state.triggers.length === 0) return;
    const inactiveTriggers = state.triggers.filter(function (t) { return !t.active; });
    let trigger;
    let activatedANewTrigger = false;
    if (inactiveTriggers.length > 0) {
      trigger = inactiveTriggers[Math.floor(Math.random() * inactiveTriggers.length)];
      trigger.active = true;
      activatedANewTrigger = true;
    } else {
      trigger = state.triggers[Math.floor(Math.random() * state.triggers.length)];
    }
    // Attach a random unattached move from the library.
    const availableMoves = state.moves.filter(function (m) {
      return trigger.attachedMoveIds.indexOf(m.id) === -1;
    });
    let attachedMove = null;
    if (availableMoves.length > 0) {
      attachedMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
      trigger.attachedMoveIds.push(attachedMove.id);
    }
    queueSave();
    if (attachedMove) {
      announceToAria(
        "Penalty: " + (activatedANewTrigger ? "activated " : "") + trigger.name + ", attached " + attachedMove.text + "."
      );
    } else if (activatedANewTrigger) {
      announceToAria("Penalty: activated " + trigger.name + " (no moves available to attach).");
    }
    render();
  }

  // Reward: pick a random active trigger that still has attached moves →
  // remove a random attached move. If the trigger ends with zero attached
  // moves, set it to inactive.
  function applyReward() {
    const eligible = state.triggers.filter(function (t) {
      return t.active && t.attachedMoveIds.length > 0;
    });
    if (eligible.length === 0) return;
    const trigger = eligible[Math.floor(Math.random() * eligible.length)];
    const idx = Math.floor(Math.random() * trigger.attachedMoveIds.length);
    const removedMoveId = trigger.attachedMoveIds.splice(idx, 1)[0];
    let deactivated = false;
    if (trigger.attachedMoveIds.length === 0) {
      trigger.active = false;
      deactivated = true;
    }
    const removedMove = state.moves.find(function (m) { return m.id === removedMoveId; });
    queueSave();
    if (removedMove) {
      announceToAria(
        "Reward: detached " + removedMove.text + " from " + trigger.name +
          (deactivated ? "; trigger now inactive." : ".")
      );
    }
    render();
  }

  function announceToAria(message) {
    let live = document.querySelector(".questing-adventurer-panel__aria-live");
    if (!live) {
      live = document.createElement("div");
      live.className = "questing-adventurer-panel__aria-live";
      live.setAttribute("aria-live", "polite");
      live.style.cssText =
        "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;";
      document.body.appendChild(live);
    }
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
      if (n.type === "trigger" && Array.isArray(n.items)) {
        for (let j = 0; j < n.items.length; j++) {
          if (n.items[j].id === id) {
            return { node: n.items[j], container: n.items, index: j, parentId: n.id };
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
    const sourceIsTrigger = sourceLoc.node.type === "trigger";

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
      if (targetTrigger && (!Array.isArray(targetTrigger.items) || targetTrigger.items.length === 0)) {
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
          return p && Array.isArray(p.items) ? p.items : null;
        })();
    if (!container) return null;
    const targetIdx = container.findIndex(function (n) { return n.id === targetId; });
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
      beforeId: next ? next.id : null,
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
    if (parentId === null) {
      destContainer = state.triggers;
    } else {
      const parent = state.triggers.find(function (n) { return n.id === parentId; });
      if (!parent || parent.type !== "trigger") return;
      if (!Array.isArray(parent.items)) parent.items = [];
      destContainer = parent.items;
    }
    // Resolve insertion index
    let destIndex;
    if (beforeId === null) {
      destIndex = destContainer.length;
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

  // CSS.escape polyfill (very small subset; Stash targets evergreen browsers so
  // CSS.escape is available, but a tiny fallback prevents a crash on weird ids).
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c;
    });
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
    let ariaLive = document.querySelector(".questing-adventurer-panel__aria-live");
    if (!ariaLive) {
      ariaLive = document.createElement("div");
      ariaLive.className = "questing-adventurer-panel__aria-live";
      ariaLive.setAttribute("aria-live", "polite");
      ariaLive.style.cssText = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;";
      document.body.appendChild(ariaLive);
    }
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
      const stored = (await csLib.getConfiguration(CONFIG_KEY)) || {};
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
            active: t.active !== false,
            attachedMoveIds: Array.isArray(t.attachedMoveIds) ? t.attachedMoveIds : [],
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
      state.locked = stored.locked === true;
      state.showAddControls = stored.showAddControls === true;
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
      const result = csLib.setConfiguration(CONFIG_KEY, {
        moves: state.moves,
        triggers: state.triggers,
        collapsed: state.collapsed,
        opacity: state.opacity,
        panelPos: state.panelPos,
        locked: state.locked,
        showAddControls: state.showAddControls,
      });
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
      if (node.type === "trigger" && Array.isArray(node.items)) {
        for (const item of node.items) {
          if (item.id === id) return item;
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
      panel.classList.add("questing-adventurer-panel--collapsed");
      panel.style.setProperty("--qa-bg-alpha", state.opacity);
      const chip = document.createElement("div");
      chip.className = "questing-adventurer-panel__chip";
      chip.dataset.action = "toggle-collapse";
      chip.title = "Click to expand";
      chip.textContent = "\ud83d\uddfa\ufe0f Triggers (" + getActiveTriggerCount() + ")";
      panel.appendChild(chip);
      return;
    }

    panel.classList.remove("questing-adventurer-panel--collapsed");
    panel.style.setProperty("--qa-bg-alpha", state.opacity);

    const header = document.createElement("div");
    header.className = "questing-adventurer-panel__header";
    header.addEventListener("pointerdown", startPanelDrag);
    const title = document.createElement("span");
    title.className = "questing-adventurer-panel__header-title";
    title.textContent = "Triggers";
    const controls = document.createElement("span");
    controls.className = "questing-adventurer-panel__header-controls";

    const penaltyBtn = document.createElement("button");
    penaltyBtn.type = "button";
    penaltyBtn.dataset.action = "apply-penalty";
    penaltyBtn.className = "questing-adventurer-panel__penalty-button";
    penaltyBtn.title = "Penalty: activate a random inactive move";
    penaltyBtn.setAttribute("aria-label", "Penalty: activate a random inactive move");
    penaltyBtn.textContent = "Penalty";
    penaltyBtn.disabled = getInactiveMoves().length === 0;
    controls.appendChild(penaltyBtn);

    const rewardBtn = document.createElement("button");
    rewardBtn.type = "button";
    rewardBtn.dataset.action = "apply-reward";
    rewardBtn.className = "questing-adventurer-panel__reward-button";
    rewardBtn.title = "Reward: deactivate a random active move";
    rewardBtn.setAttribute("aria-label", "Reward: deactivate a random active move");
    rewardBtn.textContent = "Reward";
    rewardBtn.disabled = getActiveMoves().length === 0;
    controls.appendChild(rewardBtn);

    const lockBtn = document.createElement("button");
    lockBtn.type = "button";
    lockBtn.dataset.action = "toggle-lock";
    lockBtn.className = "questing-adventurer-panel__lock-button";
    lockBtn.title = state.locked ? "Unlock overlay" : "Lock overlay";
    lockBtn.setAttribute("aria-label", state.locked ? "Unlock overlay" : "Lock overlay");
    lockBtn.setAttribute("aria-pressed", state.locked ? "true" : "false");
    lockBtn.textContent = state.locked ? "\ud83d\udd12" : "\ud83d\udd13";
    controls.appendChild(lockBtn);

    const addToggleBtn = document.createElement("button");
    addToggleBtn.type = "button";
    addToggleBtn.dataset.action = "toggle-add-controls";
    addToggleBtn.className = "questing-adventurer-panel__add-toggle-button";
    addToggleBtn.title = "Add trigger or move";
    addToggleBtn.setAttribute("aria-label", "Add trigger or move");
    addToggleBtn.setAttribute("aria-expanded", state.showAddControls ? "true" : "false");
    addToggleBtn.textContent = "+";
    controls.appendChild(addToggleBtn);

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
    closeBtn.title = "Collapse";
    closeBtn.setAttribute("aria-label", "Collapse panel");
    closeBtn.textContent = "\u00d7";
    controls.appendChild(closeBtn);

    header.appendChild(title);
    header.appendChild(controls);
    panel.appendChild(header);

    const list = document.createElement("div");
    list.className = "questing-adventurer-panel__list";

    const activeTriggers = state.triggers.filter(function (t) { return t.active; });
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

    input.addEventListener("input", syncButtons);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim() !== "") {
        addMoveTop(input.value.trim());
        input.value = "";
        syncButtons();
      }
    });

    footer.appendChild(input);
    footer.appendChild(addTriggerBtn);
    footer.appendChild(addMoveBtn);
    panel.appendChild(footer);

    // Apply the locked / showAddControls state classes so CSS can hide the
    // appropriate elements without touching the DOM.
    if (state.locked) panel.classList.add("questing-adventurer-panel--locked");
    if (state.showAddControls) panel.classList.add("questing-adventurer-panel--show-add-controls");

    syncButtons();
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

    const controls = document.createElement("span");
    controls.className = "questing-adventurer-panel__controls";

    const addBtn = document.createElement("button");
    addBtn.dataset.action = "add-move-into";
    addBtn.dataset.id = trigger.id;
    addBtn.title = "Add move to this trigger";
    addBtn.textContent = "+";

    const delBtn = document.createElement("button");
    delBtn.dataset.action = "delete-trigger";
    delBtn.dataset.id = trigger.id;
    delBtn.title = "Delete trigger";
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
    row.style.setProperty("--qa-indent", indented ? "16px" : "0px");

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
    state.triggers.push({ id: generateId(), type: "trigger", name: name, items: [] });
    queueSave();
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
    const itemCount = Array.isArray(trigger.items) ? trigger.items.length : 0;
    const confirmed = window.confirm(
      'Delete trigger "' + trigger.name + '" and its ' + itemCount + " move(s)?"
    );
    if (confirmed) {
      state.triggers.splice(idx, 1);
      queueSave();
      render();
    }
  }

  function handleClick(e) {
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
      case "toggle-lock":
        state.locked = !state.locked;
        queueSave();
        render();
        break;
      case "toggle-add-controls":
        state.showAddControls = !state.showAddControls;
        queueSave();
        render();
        break;
      case "add-move-top": {
        const text = getFooterValue(panel);
        if (text) {
          addMoveTop(text);
          const input = panel.querySelector(".questing-adventurer-panel__input");
          if (input) input.value = "";
        }
        break;
      }
      case "add-trigger-top": {
        const text = getFooterValue(panel);
        if (text) {
          addQuestTop(text);
          const input = panel.querySelector(".questing-adventurer-panel__input");
          if (input) input.value = "";
        }
        break;
      }
      case "add-move-into": {
        const text = getFooterValue(panel);
        if (text && id) {
          addMoveInto(id, text);
          const input = panel.querySelector(".questing-adventurer-panel__input");
          if (input) input.value = "";
        }
        break;
      }
      case "delete-move":
        if (id) deleteMove(id);
        break;
      case "delete-trigger":
        if (id) deleteTrigger(id);
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
    if (state.locked) return;
    e.preventDefault();
    const panel = document.querySelector(".questing-adventurer-panel");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const startTop = state.panelPos.top;
    const startRight = state.panelPos.right;
    const startX = e.clientX;
    const startY = e.clientY;

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
      queueSave();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  async function setupPanel(playerEl) {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    if (!match) return;

    if (playerEl.querySelector(".questing-adventurer-panel")) return;

    const computed = window.getComputedStyle(playerEl);
    if (computed.position === "static") {
      playerEl.style.position = "relative";
    }

    await migrateFromLegacy();
    await loadState();

    const panel = document.createElement("div");
    panel.className = "questing-adventurer-panel";
    panel.addEventListener("click", handleClick);
    panel.addEventListener("dblclick", handleDblClick);

    // Apply persisted position (or default) so the panel appears where the
    // user last left it, not in the hardcoded CSS top-right corner.
    panel.style.top = state.panelPos.top + "px";
    panel.style.right = state.panelPos.right + "px";

    playerEl.appendChild(panel);
    render();
  }

  csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel);

  if (
    window.PluginApi &&
    window.PluginApi.Event &&
    typeof window.PluginApi.Event.addEventListener === "function"
  ) {
    window.PluginApi.Event.addEventListener("stash:location", function () {
      if (!document.querySelector(".questing-adventurer-panel")) {
        const player = document.querySelector("#VideoJsPlayer");
        if (player) setupPanel(player);
      }
    });
  }
})();
