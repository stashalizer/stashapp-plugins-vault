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

  let settingsToolsCallCount = 0;
  let saving = false;
  let pendingSave = false;
  let latestTriggers = null;

  function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
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
          triggers: legacyNodes.map(function (node) {
            if (node.type === "category") {
              return {
                id: node.id || generateId(),
                type: "trigger",
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
          console.error("QuestingAdventurer settings: failed to write migrated config:", e);
          return;
        }
        try {
          await csLib.setConfiguration(LEGACY_CONFIG_KEY, { quests: [], collapsed: true });
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
      const stored = (await csLib.getConfiguration(CONFIG_KEY)) || {};
      const merged = {
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
      };
      const result = csLib.setConfiguration(CONFIG_KEY, merged);
      await result;
      saving = false;
      if (pendingSave) saveQuestsNow();
    } catch (err) {
      console.error("QuestingAdventurer settings: save failed:", err);
      saving = false;
      if (pendingSave) saveQuestsNow();
    }
  }

  function saveTriggers(newTriggers) {
    latestTriggers = newTriggers;
    saveTriggersNow();
  }

  function QuestingAdventurerSettingsPage() {
    const [triggers, setTriggers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState(null);
    const [footerText, setFooterText] = useState("");
    const inputRef = useRef(null);
    const editingIdRef = useRef(null);

    useEffect(function () {
      let mounted = true;

      function finish(questsArr) {
        if (!mounted) return;
        setTriggers(questsArr);
        setLoading(false);
      }

      (async function () {
        try {
          await migrateFromLegacy();
          const stored = await csLib.getConfiguration(CONFIG_KEY);
          const raw = stored && Array.isArray(stored.quests)
            ? stored.quests
            : stored && Array.isArray(stored.rules)
            ? stored.rules
            : [];
          finish(raw);
        } catch (err) {
          console.error("QuestingAdventurer settings: load failed:", err);
          finish([]);
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
      const nextTriggers = [...quests, { id: generateId(), type: "move", text: trimmed, active: true }];
      commitQuests(nextTriggers);
    }

    function addTriggerTop(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const nextTriggers = [...quests, { id: generateId(), type: "trigger", name: trimmed, items: [] }];
      commitQuests(nextTriggers);
    }

    function addMoveInto(questId, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const nextTriggers = quests.map(function (node) {
        if (node.type === "trigger" && node.id === questId) {
          return {
            ...node,
            items: [...(node.items || []), { id: generateId(), type: "move", text: trimmed, active: true }],
          };
        }
        return node;
      });
      commitQuests(nextTriggers);
    }

    function deleteMove(id) {
      const nextTriggers = [];
      for (const node of quests) {
        if (node.type === "move" && node.id === id) continue;
        if (node.type === "trigger") {
          nextTriggers.push({
            ...node,
            items: (node.items || []).filter(function (r) {
              return r.id !== id;
            }),
          });
        } else {
          nextTriggers.push(node);
        }
      }
      commitQuests(nextTriggers);
    }

    function deleteTrigger(id) {
      const q = quests.find(function (n) {
        return n.type === "trigger" && n.id === id;
      });
      if (!q) return;
      const itemCount = Array.isArray(q.items) ? q.items.length : 0;
      const confirmed = window.confirm(
        'Delete trigger "' + q.name + '" and its ' + itemCount + " move(s)?"
      );
      if (!confirmed) return;
      const nextTriggers = quests.filter(function (n) {
        return !(n.type === "trigger" && n.id === id);
      });
      commitQuests(nextTriggers);
    }

    function findNodeLocation(id) {
      for (let i = 0; i < quests.length; i++) {
        const n = quests[i];
        if (n.id === id) {
          return { node: n, container: quests, index: i, parent: null };
        }
        if (n.type === "trigger" && Array.isArray(n.items)) {
          for (let j = 0; j < n.items.length; j++) {
            if (n.items[j].id === id) {
              return { node: n.items[j], container: n.items, index: j, parent: n };
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
        nextTriggers = quests.map(function (n) {
          if (n.id === loc.parent.id) {
            return { ...n, items: nextContainer };
          }
          return n;
        });
      }
      commitQuests(nextTriggers);
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
      const nextTriggers = quests.map(function (node) {
        if (node.id === id && node.type === "move") {
          return { ...node, active: !isActiveMoveLocal(node) };
        }
        if (node.type === "trigger" && Array.isArray(node.items)) {
          return {
            ...node,
            items: node.items.map(function (item) {
              if (item.id === id) {
                return { ...item, active: !isActiveMoveLocal(item) };
              }
              return item;
            }),
          };
        }
        return node;
      });
      commitQuests(nextTriggers);
    }

    function editNode(id, newText) {
      if (editingIdRef.current !== id) return;
      const trimmed = newText.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      const nextTriggers = quests.map(function (node) {
        if (node.id === id) {
          if (node.type === "trigger") {
            return { ...node, name: trimmed };
          }
          return { ...node, text: trimmed };
        }
        if (node.type === "trigger") {
          return {
            ...node,
            items: (node.items || []).map(function (item) {
              return item.id === id ? { ...item, text: trimmed } : item;
            }),
          };
        }
        return node;
      });
      setEditingId(null);
      setTriggers(nextTriggers);
      saveQuests(nextTriggers);
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

    function renderTrigger(trigger) {
      return h(
        "div",
        { key: trigger.id, className: "questing-adventurer-settings__quest" },
        h(
          "span",
          { className: "questing-adventurer-settings__quest-name" },
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
        (trigger.items || []).map(function (move) {
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

    return h(
      "div",
      { className: "questing-adventurer-settings" },
      h("h2", { className: "questing-adventurer-settings__header" }, "Questing Adventurer"),
      loading
        ? h("div", null, "Loading...")
        : h(
            "div",
            { className: "questing-adventurer-settings__list" },
            quests.length === 0
              ? h(
                  "div",
                  { className: "questing-adventurer-settings__empty" },
                  "No triggers yet. Add a trigger or move below."
                )
              : quests.map(function (node) {
                  return node.type === "trigger"
                    ? renderQuest(node)
                    : renderMove(node, false);
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
                    addQuestTop(footerText);
                    setFooterText("");
                  },
                },
                "Add Quest"
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
