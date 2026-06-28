/**
 * SceneRules plugin
 *
 * Architecture:
 * - Uses csLib.PathElementListener to inject on /scenes/ when #VideoJsPlayer exists,
 *   and on subsequent stash:location SPA navigations.
 * - Adds an extra window.PluginApi.Event "stash:location" safety net to re-inject the
 *   panel if React re-renders remove it. There can be a brief flash between removal
 *   and re-injection.
 * - Enforces a global 2-level structure: top-level nodes are either standalone rules
 *   or categories; categories contain only leaf rules.
 * - All state mutations are persisted via csLib.setConfiguration("SceneRules", state)
 *   wrapped in a lock to avoid concurrent saves.
 */
(function () {
  "use strict";

  const csLib = window.csLib;
  if (!csLib) {
    console.error("SceneRules: CommunityScriptsUILibrary not loaded. Install it first.");
    return;
  }

  let state = { rules: [], collapsed: true };
  let editingId = null;
  let saving = false;
  let pendingSave = false;

  function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function getTotalRuleCount() {
    let count = 0;
    for (const node of state.rules) {
      if (node.type === "rule") {
        count += 1;
      } else if (node.type === "category" && Array.isArray(node.items)) {
        count += node.items.length;
      }
    }
    return count;
  }

  function loadState() {
    try {
      const stored = csLib.getConfiguration("SceneRules") || {};
      state.rules = Array.isArray(stored.rules) ? stored.rules : [];
      state.collapsed = typeof stored.collapsed === "boolean" ? stored.collapsed : true;
    } catch (err) {
      console.error("SceneRules: failed to load configuration:", err);
      state.rules = [];
      state.collapsed = true;
    }
  }

  function queueSave() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    pendingSave = false;
    try {
      const result = csLib.setConfiguration("SceneRules", {
        rules: state.rules,
        collapsed: state.collapsed,
      });
      if (result && typeof result.then === "function") {
        result
          .then(function () {
            saving = false;
            if (pendingSave) queueSave();
          })
          .catch(function (err) {
            saving = false;
            console.error("SceneRules: failed to save configuration:", err);
            if (pendingSave) queueSave();
          });
      } else {
        saving = false;
        if (pendingSave) queueSave();
      }
    } catch (err) {
      saving = false;
      console.error("SceneRules: failed to save configuration:", err);
    }
  }

  function findNode(id) {
    for (const node of state.rules) {
      if (node.id === id) return node;
      if (node.type === "category" && Array.isArray(node.items)) {
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
    input.className = "scene-rules-panel__edit-input";
    input.value = value;
    input.dataset.id = id;

    function save() {
      if (editingId !== id) return;
      const newValue = input.value.trim();
      if (newValue !== "") {
        const node = findNode(id);
        if (node) {
          if (node.type === "category") {
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
    const input = panel.querySelector(".scene-rules-panel__input");
    return input ? input.value.trim() : "";
  }

  function render() {
    const panel = document.querySelector(".scene-rules-panel");
    if (!panel) return;
    clearChildren(panel);

    if (state.collapsed) {
      panel.classList.add("scene-rules-panel--collapsed");
      const chip = document.createElement("div");
      chip.className = "scene-rules-panel__chip";
      chip.dataset.action = "toggle-collapse";
      chip.textContent = "\ud83d\udccb Rules (" + getTotalRuleCount() + ")";
      panel.appendChild(chip);
      return;
    }

    panel.classList.remove("scene-rules-panel--collapsed");

    const header = document.createElement("div");
    header.className = "scene-rules-panel__header";
    const title = document.createElement("span");
    title.textContent = "Viewing Rules";
    const closeBtn = document.createElement("button");
    closeBtn.dataset.action = "toggle-collapse";
    closeBtn.title = "Collapse";
    closeBtn.textContent = "\u00d7";
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const list = document.createElement("div");
    list.className = "scene-rules-panel__list";

    if (state.rules.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scene-rules-panel__empty";
      empty.textContent = "No rules yet. Add a category or rule below.";
      list.appendChild(empty);
    } else {
      state.rules.forEach(function (node) {
        if (node.type === "category") {
          renderCategory(list, node);
        } else {
          renderRule(list, node, false);
        }
      });
    }
    panel.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "scene-rules-panel__footer";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "scene-rules-panel__input";
    input.placeholder = "New rule or category name";

    const addCatBtn = document.createElement("button");
    addCatBtn.dataset.action = "add-category-top";
    addCatBtn.textContent = "Add Category";

    const addRuleBtn = document.createElement("button");
    addRuleBtn.dataset.action = "add-rule-top";
    addRuleBtn.textContent = "Add Rule";

    function syncButtons() {
      const empty = input.value.trim() === "";
      addCatBtn.disabled = empty;
      addRuleBtn.disabled = empty;
      panel.querySelectorAll('[data-action="add-rule-into"]').forEach(function (btn) {
        btn.disabled = empty;
      });
    }

    input.addEventListener("input", syncButtons);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim() !== "") {
        addRuleTop(input.value.trim());
        input.value = "";
        syncButtons();
      }
    });

    footer.appendChild(input);
    footer.appendChild(addCatBtn);
    footer.appendChild(addRuleBtn);
    panel.appendChild(footer);

    syncButtons();
  }

  function renderCategory(list, category) {
    const row = document.createElement("div");
    row.className = "scene-rules-panel__category";

    const nameEl = document.createElement("span");
    nameEl.className = "scene-rules-panel__category-name";
    nameEl.dataset.action = "edit";
    nameEl.dataset.id = category.id;
    nameEl.title = "Double-click to edit";
    if (editingId === category.id) {
      nameEl.appendChild(createEditInput(category.name, category.id));
    } else {
      nameEl.textContent = category.name;
    }
    row.appendChild(nameEl);

    const controls = document.createElement("span");
    controls.className = "scene-rules-panel__controls";

    const addBtn = document.createElement("button");
    addBtn.dataset.action = "add-rule-into";
    addBtn.dataset.id = category.id;
    addBtn.title = "Add rule to this category";
    addBtn.textContent = "+";

    const delBtn = document.createElement("button");
    delBtn.dataset.action = "delete-category";
    delBtn.dataset.id = category.id;
    delBtn.title = "Delete category";
    delBtn.textContent = "\u00d7";

    controls.appendChild(addBtn);
    controls.appendChild(delBtn);
    row.appendChild(controls);
    list.appendChild(row);

    if (Array.isArray(category.items)) {
      category.items.forEach(function (rule) {
        renderRule(list, rule, true);
      });
    }
  }

  function renderRule(list, rule, indented) {
    const row = document.createElement("div");
    row.className = "scene-rules-panel__rule" + (indented ? " scene-rules-panel__rule--indented" : "");

    const textEl = document.createElement("span");
    textEl.className = "scene-rules-panel__rule-text";
    textEl.dataset.action = "edit";
    textEl.dataset.id = rule.id;
    textEl.title = "Double-click to edit";
    if (editingId === rule.id) {
      textEl.appendChild(createEditInput(rule.text, rule.id));
    } else {
      textEl.textContent = rule.text;
    }
    row.appendChild(textEl);

    const controls = document.createElement("span");
    controls.className = "scene-rules-panel__controls";

    const delBtn = document.createElement("button");
    delBtn.dataset.action = "delete-rule";
    delBtn.dataset.id = rule.id;
    delBtn.title = "Delete rule";
    delBtn.textContent = "\u00d7";

    controls.appendChild(delBtn);
    row.appendChild(controls);
    list.appendChild(row);
  }

  function addRuleTop(text) {
    state.rules.push({ id: generateId(), type: "rule", text: text });
    queueSave();
    render();
  }

  function addCategoryTop(name) {
    state.rules.push({ id: generateId(), type: "category", name: name, items: [] });
    queueSave();
    render();
  }

  function addRuleInto(categoryId, text) {
    const category = state.rules.find(function (n) {
      return n.type === "category" && n.id === categoryId;
    });
    if (category) {
      category.items.push({ id: generateId(), type: "rule", text: text });
      queueSave();
      render();
    }
  }

  function deleteRule(id) {
    for (let i = 0; i < state.rules.length; i++) {
      const node = state.rules[i];
      if (node.type === "rule" && node.id === id) {
        state.rules.splice(i, 1);
        queueSave();
        render();
        return;
      }
      if (node.type === "category" && Array.isArray(node.items)) {
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

  function deleteCategory(id) {
    const idx = state.rules.findIndex(function (n) {
      return n.type === "category" && n.id === id;
    });
    if (idx === -1) return;
    const category = state.rules[idx];
    const itemCount = Array.isArray(category.items) ? category.items.length : 0;
    const confirmed = window.confirm(
      'Delete category "' + category.name + '" and its ' + itemCount + " rule(s)?"
    );
    if (confirmed) {
      state.rules.splice(idx, 1);
      queueSave();
      render();
    }
  }

  function handleClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    const panel = document.querySelector(".scene-rules-panel");

    switch (action) {
      case "toggle-collapse":
        state.collapsed = !state.collapsed;
        queueSave();
        render();
        break;
      case "add-rule-top": {
        const text = getFooterValue(panel);
        if (text) {
          addRuleTop(text);
          const input = panel.querySelector(".scene-rules-panel__input");
          if (input) input.value = "";
        }
        break;
      }
      case "add-category-top": {
        const text = getFooterValue(panel);
        if (text) {
          addCategoryTop(text);
          const input = panel.querySelector(".scene-rules-panel__input");
          if (input) input.value = "";
        }
        break;
      }
      case "add-rule-into": {
        const text = getFooterValue(panel);
        if (text && id) {
          addRuleInto(id, text);
          const input = panel.querySelector(".scene-rules-panel__input");
          if (input) input.value = "";
        }
        break;
      }
      case "delete-rule":
        if (id) deleteRule(id);
        break;
      case "delete-category":
        if (id) deleteCategory(id);
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

  function setupPanel(playerEl) {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    if (!match) return;

    if (playerEl.querySelector(".scene-rules-panel")) return;

    const computed = window.getComputedStyle(playerEl);
    if (computed.position === "static") {
      playerEl.style.position = "relative";
    }

    loadState();

    const panel = document.createElement("div");
    panel.className = "scene-rules-panel";
    panel.addEventListener("click", handleClick);
    panel.addEventListener("dblclick", handleDblClick);

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
      if (!document.querySelector(".scene-rules-panel")) {
        const player = document.querySelector("#VideoJsPlayer");
        if (player) setupPanel(player);
      }
    });
  }
})();
