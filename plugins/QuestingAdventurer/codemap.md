# plugins/QuestingAdventurer/

## Responsibility
The **QuestingAdventurer** Stash plugin — turns scene playback into a quest. The
viewer is a "questing adventurer" who must respond to cues (gestures, dance
moves, etc.) in the playing scene by performing the **active** moves from their
quest log. Provides a player overlay (vanilla JS) + a full-page React settings
UI. All state is persisted to Stash configuration under the key
`"QuestingAdventurer"`.

## Data Model
State shape: `{ quests: Node[], collapsed: boolean, opacity: number }` where
`Node` is either
- `{ id, type: "move", text, active: true }` — a top-level move
- `{ id, type: "trigger", name, items: Move[] }` — a trigger grouping leaf moves

`active: true` (the post-migration default) means the move is currently in
effect. `active: false` is an explicit deactivation. The overlay's collapsed
chip counts only active moves; the settings page shows the whole library with
an active toggle per move.

The overlay owns `collapsed` and `opacity`. The settings page owns `quests`.
Both surfaces read-modify-write the entire config map; on save, each preserves
the other surface's fields by reading them from the stored config first
(overlay) or by spreading (settings).

## Design Patterns
- **Manifest-driven plugin**: `QuestingAdventurer.yml` declares the plugin to
  Stash — name, description, version, required dependency
  (`CommunityScriptsUILibrary`), and the JS/CSS assets to load.
- **Two independent UI surfaces sharing one config key**:
  - **Player overlay** (`QuestingAdventurer.js`): vanilla JS, imperative DOM
    manipulation, event delegation via `data-action` attributes on a single
    panel element.
  - **Settings page** (`QuestingAdventurerSettings.js`): React component
    registered through Stash's `PluginApi` patching hooks (`patch.before`).
- **SPA injection via `PathElementListener`**: `csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel)`
  waits for the player element on scene routes and re-injects on SPA navigation.
- **Safety-net re-injection**: a `window.PluginApi.Event` `"stash:location"`
  listener re-creates the panel if React re-renders remove it (a brief flash
  between removal and re-injection is acknowledged).
- **Save lock with pending flag**: both surfaces guard `csLib.setConfiguration`
  with a `saving`/`pendingSave` lock to coalesce concurrent async saves and
  avoid interleaving.
- **Semantic state split**: the settings page owns the `quests` array; the
  overlay owns the `collapsed` flag and the `opacity` value. Every settings
  save re-reads the stored config to preserve both overlay-owned fields.
- **Immutable updates (React surface)**: settings mutators produce new
  arrays/objects via spread; the overlay mutates state in place then re-renders.
- **Stale-closure guard**: settings page keeps an `editingIdRef` mirror of
  `editingId` so blur/Enter handlers read the live value, not the captured
  render-time value.
- **One-shot legacy migration**: both surfaces run a `migrateFromLegacy()` step
  on first load. If no `QuestingAdventurer` config exists but the legacy
  `SceneRules` config does, the data is copied over (every move marked
  `active: true`, `category` → `trigger`, `rule` → `move`), writes to the new
  key, and clears the old key. Safe to run repeatedly; no-ops once migration
  is done.
- **Scene-Tools-only launcher**: the settings launcher uses a module-level
  call counter on `SettingsToolsSection`; it injects the card on **even**
  calls (the Scene Tools section, per `SettingsToolsPanel.tsx`), so the card
  no longer appears in the general Tools section. Parity (odd = Tools, even
  = Scene Tools) is the correct gate because the two `SettingsToolsSection`
  instances render in fixed order on every re-render.
- **CSS custom properties for theming**: the panel's background alpha is
  driven by `--qa-bg-alpha`, set inline from `state.opacity` on every render.
  The drop-line indent is driven by `--qa-indent` set per row (0 for
  top-level, 16px for indented child moves).
- **Custom pointer events for drag**: drag-to-reorder uses
  `pointerdown`/`pointermove`/`pointerup`/`pointercancel` (not HTML5 DnD)
  for cross-platform support including touch. `touch-action: none` on the
  handle and `setPointerCapture` keep the drag alive if the pointer leaves
  the handle.
- **Shared aria-live region**: a single `aria-live="polite"` div lives on
  `document.body` (not inside the panel) so it survives `render()` after
  drag/drop or penalty/reward. Both surfaces append to it for screen-reader
  announcements.

## Data & Control Flow
**Overlay (`QuestingAdventurer.js`):**
1. `csLib.PathElementListener` fires `setupPanel(playerEl)` when
   `#VideoJsPlayer` exists on `/scenes/`.
2. `setupPanel` verifies the URL matches `/scenes/(\d+)`, ensures the player
   has `position: relative`, calls `migrateFromLegacy()` then `loadState()`,
   creates the `.questing-adventurer-panel` div, attaches `click` /
   `dblclick` delegation, appends to the player, and calls `render()`.
3. `render()` clears the panel and renders either a collapsed chip (showing
   the active-move count) or an expanded view: header (title +
   Penalty/Reward buttons + opacity icon (with hover-reveal slider) + close
   button) + scrollable list of quests/moves + footer (input + Add Quest /
   Add Move buttons).
4. **Header actions**:
   - Penalty (`apply-penalty`): random pick from `getInactiveMoves()`
     (pool of moves with `active === false`), set `pick.active = true`,
     `queueSave()`, announce via aria-live, re-render.
   - Reward (`apply-reward`): random pick from `getActiveMoves()` (pool
     via `isActiveMove` which uses `active !== false`), set
     `pick.active = false`, `queueSave()`, announce via aria-live, re-render.
   - Opacity icon (`opacity-reset`): Ctrl/⌘+click resets to the default
     0.6. The opacity slider (`opacity-slider`) drives an `input` event
     listener that mutates `state.opacity`, updates `--qa-bg-alpha`, and
     calls `queueSave()`.
   - Close (`toggle-collapse`): flips `state.collapsed`, `queueSave()`,
     re-render.
5. **List actions**:
   - Drag handle (`drag-handle`): initiates a pointer-event drag. The
     ghost follows the pointer; `getDropTarget()` determines the
     insertion point; `reorder()` performs the mutation; `queueSave()`
     and `render()` finalize.
   - Add (`add-trigger-top` / `add-move-top` / `add-move-into`): append to
     top-level or inside a trigger.
   - Delete (`delete-trigger` / `delete-move`): remove from state; delete
     on a trigger requires `window.confirm`.
   - Edit (`edit`, on the name/text span): double-click swaps in
     `createEditInput`; Enter saves, Escape cancels, blur saves.
6. `queueSave` → `csLib.setConfiguration("QuestingAdventurer", { quests,
   collapsed, opacity })` with the async save lock.

**Settings (`QuestingAdventurerSettings.js`):**
1. On script load, `PluginApi.patch.before("PluginRoutes", ...)` registers
   `<Route path="/plugins/questingadventurer" />` and
   `PluginApi.patch.before("SettingsToolsSection", ...)` adds a launcher
   card on even calls (Scene Tools section).
2. `QuestingAdventurerSettingsPage` mounts → `useEffect` runs
   `migrateFromLegacy()` then `csLib.getConfiguration("QuestingAdventurer")`
   → `setQuests` / `setLoading(false)`.
3. Mutators build immutable next-quests arrays:
   - `addMoveTop`, `addQuestTop`, `addMoveInto`: append at top level or
     inside a trigger; new moves default to `active: true`.
   - `deleteMove`, `deleteQuest`: filter; `deleteQuest` requires
     `window.confirm`.
   - `editNode`: replace the text/name of an existing node.
   - `moveNode(id, direction)`: swap with the adjacent sibling (top-level
     or inside the same trigger) using immutable updates. Used by the ▲/▼
     buttons for keyboard/mouse parity with the overlay's drag-to-reorder.
   - `toggleActive(id)`: flip `active` for a move (top-level or inside a
     trigger). The toggle button shows ● when active (with class
     `__active-btn`) and ○ when inactive (with class `__inactive-btn`),
     with `aria-pressed` reflecting the state.
4. `commitQuests` → `setEditingId(null); setQuests(next); saveQuests(next)`.
5. `saveQuestsNow` re-reads stored config to preserve `collapsed` and
   `opacity`, then `csLib.setConfiguration`.

## Integration Points
- **Depends on**: `window.csLib` (CommunityScriptsUILibrary) —
  `PathElementListener`, `getConfiguration`, `setConfiguration`. Required by
  the manifest (`ui.requires`).
- **Depends on**: `window.PluginApi` — `React` (`createElement`,
  `useState`/`useEffect`/`useRef`), `libraries.ReactRouterDOM` (`Route`,
  `Link`), `patch.before` for route/settings injection. Used only by the
  settings page.
- **Config key**: `"QuestingAdventurer"` (shared by both surfaces). The
  legacy `"SceneRules"` key is read once and migrated, then cleared.
- **Routes injected**: `/plugins/questingadventurer` (settings page).
- **DOM mount**: `#VideoJsPlayer` (overlay panel appended as an
  absolute-positioned child).
- **Consumed by**: Stash app runtime, which loads the JS/CSS assets per the
  manifest.
- **Known limitation**: the overlay and settings page maintain separate save
  locks and do not coordinate across components; a concurrent write from
  both could race (last writer wins the whole config map). Settings edits
  will not live-reflect in an already-open overlay until the next
  navigation/reload.

## Files
- `QuestingAdventurer.yml` — plugin manifest (name, description, version 0.3,
  `ui.requires`/`javascript`/`css`).
- `QuestingAdventurer.js` — player overlay panel (vanilla JS).
- `QuestingAdventurerSettings.js` — full-page React CRUD settings UI.
- `QuestingAdventurer.css` — overlay panel styling.
- `QuestingAdventurerSettings.css` — settings page styling.
