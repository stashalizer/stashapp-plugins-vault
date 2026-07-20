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

  let state = { quests: [], collapsed: true, opacity: DEFAULT_OPACITY, panelPos: { ...DEFAULT_PANEL_POS } };
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

  function isActiveMove(node) {
    return node && node.type === "move" && node.active !== false;
  }

  function getTotalActiveMoveCount() {
    let count = 0;
    for (const node of state.quests) {
      if (isActiveMove(node)) {
        count += 1;
      } else if (node.type === "quest" && Array.isArray(node.items)) {
        for (const item of node.items) {
          if (isActiveMove(item)) count += 1;
        }
      }
    }
    return count;
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
    for (const n of state.quests) {
      if (n.type === "move" && n.active === false) {
        result.push(n);
      } else if (n.type === "quest" && Array.isArray(n.items)) {
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
    for (const n of state.quests) {
      if (isActiveMove(n)) {
        result.push(n);
      } else if (n.type === "quest" && Array.isArray(n.items)) {
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
  function applyPenalty() {
    const pool = getInactiveMoves();
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pick.active = true;
    queueSave();
    announceToAria("Penalty: " + pick.text + " is now active.");
    render();
  }

  // Reward: pick a random active move and deactivate it. No-op if the active
  // pool is empty.
  function applyReward() {
    const pool = getActiveMoves();
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pick.active = false;
    queueSave();
    announceToAria("Reward: " + pick.text + " is no longer active.");
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
    for (let i = 0; i < state.quests.length; i++) {
      const n = state.quests[i];
      if (n.id === id) {
        return { node: n, container: state.quests, index: i, parentId: null };
      }
      if (n.type === "quest" && Array.isArray(n.items)) {
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
  // - parentId: id of the quest that should contain the moved node (null = top-level)
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
    const targetParentId = row.dataset.parentQuest || null;
    const rect = row.getBoundingClientRect();
    const isTopHalf = clientY < rect.top + rect.height / 2;

    const sourceLoc = findNodeLocation(sourceId);
    if (!sourceLoc) return null;
    const sourceIsQuest = sourceLoc.node.type === "quest";

    // If the source is a quest and the target is a child row (inside a quest),
    // we forbid quest-into-quest nesting. Fall back to top-level insertion
    // before/after the parent quest of the target child.
    if (sourceIsQuest && targetParentId !== null) {
      const parentIdx = state.quests.findIndex(function (n) {
        return n.id === targetParentId;
      });
      if (parentIdx === -1) return null;
      const beforeRow = isTopHalf ? state.quests[parentIdx] : state.quests[parentIdx + 1];
      return {
        beforeId: beforeRow ? beforeRow.id : null,
        parentId: null,
        dropClass: isTopHalf ? "drop-before" : "drop-after",
      };
    }

    // If the target is an empty quest (no children) and the source is a move,
    // the bottom half of the quest header appends the move as the first child.
    if (targetType === "quest" && sourceIsQuest === false) {
      const targetQuest = state.quests.find(function (n) { return n.id === targetId; });
      if (targetQuest && (!Array.isArray(targetQuest.items) || targetQuest.items.length === 0)) {
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
      ? state.quests
      : (function () {
          const p = state.quests.find(function (n) { return n.id === targetParentId; });
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
      destContainer = state.quests;
    } else {
      const parent = state.quests.find(function (n) { return n.id === parentId; });
      if (!parent || parent.type !== "quest") return;
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
        const hasCurrent =
          current && (Array.isArray(current.quests) || Array.isArray(current.rules));
        if (hasCurrent) return;
        const legacy = await csLib.getConfiguration(LEGACY_CONFIG_KEY);
        if (!legacy) return;
        const legacyNodes = Array.isArray(legacy.quests)
          ? legacy.quests
          : Array.isArray(legacy.rules)
          ? legacy.rules
          : [];
        if (legacyNodes.length === 0) return;
        const migrated = {
          quests: legacyNodes.map(function (node) {
            if (node.type === "category") {
              return {
                id: node.id || generateId(),
                type: "quest",
                name: node.name,
                items: (node.items || []).map(function (item) {
                  return { id: item.id || generateId(), type: "move", text: item.text, active: true };
                }),
              };
            }
            return { id: node.id || generateId(), type: "move", text: node.text, active: true };
          }),
          collapsed: typeof legacy.collapsed === "boolean" ? legacy.collapsed : true,
        };
        try {
          await csLib.setConfiguration(CONFIG_KEY, migrated);
        } catch (e) {
          console.error("QuestingAdventurer: failed to write migrated config:", e);
          return;
        }
        try {
          await csLib.setConfiguration(LEGACY_CONFIG_KEY, { quests: [], collapsed: true });
        } catch (e) {
          console.error("QuestingAdventurer: failed to clear legacy config:", e);
        }
        console.info("QuestingAdventurer: migrated legacy SceneRules config.");
      } catch (err) {
        console.error("QuestingAdventurer: migration check failed:", err);
      }
    })();
  }

  async function loadState() {
    try {
      const stored = (await csLib.getConfiguration(CONFIG_KEY)) || {};
      const raw = Array.isArray(stored.quests)
        ? stored.quests
        : Array.isArray(stored.rules)
        ? stored.rules
        : [];
      state.quests = raw;
      state.collapsed = typeof stored.collapsed === "boolean" ? stored.collapsed : true;
      const o =
        typeof stored.opacity === "number" && !Number.isNaN(stored.opacity)
          ? stored.opacity
          : DEFAULT_OPACITY;
      state.opacity = Math.min(1, Math.max(0, o));
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
      state.quests = [];
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
        quests: state.quests,
        collapsed: state.collapsed,
        opacity: state.opacity,
        panelPos: state.panelPos,
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
    for (const node of state.quests) {
      if (node.id === id) return node;
      if (node.type === "quest" && Array.isArray(node.items)) {
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
          if (node.type === "quest") {
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
    const panel = document.querySelector(".questing-adventurer-panel");
    if (!panel) return;
    clearChildren(panel);

    if (state.collapsed) {
      panel.classList.add("questing-adventurer-panel--collapsed");
      panel.style.setProperty("--qa-bg-alpha", state.opacity);
      const chip = document.createElement("div");
      chip.className = "questing-adventurer-panel__chip";
      chip.dataset.action = "toggle-collapse";
      chip.textContent = "\ud83d\uddfa\ufe0f Quests (" + getTotalActiveMoveCount() + ")";
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
    title.textContent = "Quests";
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

    if (state.quests.length === 0) {
      const empty = document.createElement("div");
      empty.className = "questing-adventurer-panel__empty";
      empty.textContent = "No quests yet. Add a quest or move below.";
      list.appendChild(empty);
    } else {
      state.quests.forEach(function (node) {
        if (node.type === "quest") {
          renderQuest(list, node);
        } else {
          renderMove(list, node, false, null);
        }
      });
    }
    panel.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "questing-adventurer-panel__footer";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "questing-adventurer-panel__input";
    input.placeholder = "New quest or move name";

    const addQuestBtn = document.createElement("button");
    addQuestBtn.dataset.action = "add-quest-top";
    addQuestBtn.textContent = "Add Quest";

    const addMoveBtn = document.createElement("button");
    addMoveBtn.dataset.action = "add-move-top";
    addMoveBtn.textContent = "Add Move";

    function syncButtons() {
      const empty = input.value.trim() === "";
      addQuestBtn.disabled = empty;
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
    footer.appendChild(addQuestBtn);
    footer.appendChild(addMoveBtn);
    panel.appendChild(footer);

    syncButtons();
  }

  function renderQuest(list, quest) {
    const row = document.createElement("div");
    row.className = "questing-adventurer-panel__quest";
    row.dataset.id = quest.id;
    row.dataset.rowType = "quest";
    row.dataset.parentQuest = "";
    row.style.setProperty("--qa-indent", "0px");

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "questing-adventurer-panel__drag-handle";
    handle.dataset.action = "drag-handle";
    handle.dataset.id = quest.id;
    handle.setAttribute("aria-label", "Drag to reorder");
    handle.title = "Drag to reorder";
    handle.textContent = "\u22ee\u22ee";
    handle.addEventListener("pointerdown", function (e) {
      startDrag(e, quest.id, quest.name);
    });
    if (editingId === quest.id) {
      row.classList.add("questing-adventurer-panel__row--editing");
    } else {
      row.appendChild(handle);
    }

    const nameEl = document.createElement("span");
    nameEl.className = "questing-adventurer-panel__quest-name";
    nameEl.dataset.action = "edit";
    nameEl.dataset.id = quest.id;
    nameEl.title = "Double-click to edit";
    if (editingId === quest.id) {
      nameEl.appendChild(createEditInput(quest.name, quest.id));
    } else {
      nameEl.textContent = quest.name;
    }
    row.appendChild(nameEl);

    const controls = document.createElement("span");
    controls.className = "questing-adventurer-panel__controls";

    const addBtn = document.createElement("button");
    addBtn.dataset.action = "add-move-into";
    addBtn.dataset.id = quest.id;
    addBtn.title = "Add move to this quest";
    addBtn.textContent = "+";

    const delBtn = document.createElement("button");
    delBtn.dataset.action = "delete-quest";
    delBtn.dataset.id = quest.id;
    delBtn.title = "Delete quest";
    delBtn.textContent = "\u00d7";

    controls.appendChild(addBtn);
    controls.appendChild(delBtn);
    row.appendChild(controls);
    list.appendChild(row);

    if (Array.isArray(quest.items)) {
      quest.items.forEach(function (move) {
        renderMove(list, move, true, quest.id);
      });
    }
  }

  function renderMove(list, move, indented, parentQuestId) {
    const row = document.createElement("div");
    row.className =
      "questing-adventurer-panel__move" +
      (indented ? " questing-adventurer-panel__move--indented" : "");
    row.dataset.id = move.id;
    row.dataset.rowType = "move";
    row.dataset.parentQuest = parentQuestId || "";
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
    state.quests.push({ id: generateId(), type: "move", text: text, active: true });
    queueSave();
    render();
  }

  function addQuestTop(name) {
    state.quests.push({ id: generateId(), type: "quest", name: name, items: [] });
    queueSave();
    render();
  }

  function addMoveInto(questId, text) {
    const quest = state.quests.find(function (n) {
      return n.type === "quest" && n.id === questId;
    });
    if (quest) {
      quest.items.push({ id: generateId(), type: "move", text: text, active: true });
      queueSave();
      render();
    }
  }

  function deleteMove(id) {
    for (let i = 0; i < state.quests.length; i++) {
      const node = state.quests[i];
      if (node.type === "move" && node.id === id) {
        state.quests.splice(i, 1);
        queueSave();
        render();
        return;
      }
      if (node.type === "quest" && Array.isArray(node.items)) {
        const idx = node.items.findIndex(function (r) {
          return r.id === id;
        });
        if (idx !== -1) {
          node.items.splice(idx, 1);
          queueSave();
          render();
          return;
        }
      }
    }
  }

  function deleteQuest(id) {
    const idx = state.quests.findIndex(function (n) {
      return n.type === "quest" && n.id === id;
    });
    if (idx === -1) return;
    const quest = state.quests[idx];
    const itemCount = Array.isArray(quest.items) ? quest.items.length : 0;
    const confirmed = window.confirm(
      'Delete quest "' + quest.name + '" and its ' + itemCount + " move(s)?"
    );
    if (confirmed) {
      state.quests.splice(idx, 1);
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
      case "add-move-top": {
        const text = getFooterValue(panel);
        if (text) {
          addMoveTop(text);
          const input = panel.querySelector(".questing-adventurer-panel__input");
          if (input) input.value = "";
        }
        break;
      }
      case "add-quest-top": {
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
      case "delete-quest":
        if (id) deleteQuest(id);
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
