# plugins/QuestingAdventurer/

## Responsibility
The **QuestingAdventurer** Stash plugin — turns scene playback into a quest. The
viewer is a "questing adventurer" who must respond to cues (gestures, dance
moves, etc.) in the playing scene by performing the moves attached to their
**active** triggers. Provides a player overlay (vanilla JS) + a full-page
React settings UI. All state is persisted to Stash configuration under the
key `"QuestingAdventurer"`.

## Data Model
State shape:
```js
{
  moves: [{ id: string, text: string }],                    // global move library
  triggers: [{
    id: string,
    type: "trigger",
    name: string,
    active: boolean,                                       // is this trigger in effect?
    attachedMoveIds: [string, ...]                         // ids into the global library
  }],
  collapsed: boolean,                                      // overlay collapsed state
  opacity: number,                                         // 0.0–1.0, panel background alpha
  panelPos: { top: number, right: number },                // overlay position
  locked: boolean,                                         // disable drag + dim controls
  showAddControls: boolean,                                // show Add Trigger/Move footer
  showManualControls: boolean                              // show Manual Selection library section
}
```

- `active` lives on the **trigger**, not on the move. A trigger with no
  attached moves is `active: false` by design.
- The **overlay** owns `collapsed`, `opacity`, `panelPos`, `locked`,
  `showAddControls`. The **settings page** owns `moves` and `triggers`.
- Both surfaces read-modify-write the entire config map. On save, each
  preserves the other surface's fields by reading them from the stored
  config first (overlay) or by spreading (settings).

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
  avoid interleaving. The `await` is critical — `csLib.getConfiguration` and
  `setConfiguration` are BOTH `async` (always return Promises); treating a
  Promise as a plain object is a silent failure mode.
- **Scene-Tools-only launcher**: the settings launcher uses a module-level
  call counter on `SettingsToolsSection`; it injects the card on **even**
  calls (the Scene Tools section, per `SettingsToolsPanel.tsx`), so the card
  no longer appears in the general Tools section. Parity (odd = Tools, even
  = Scene Tools) is the correct gate because the two `SettingsToolsSection`
  instances render in fixed order on every re-render.
- **One-shot legacy migration (v0 → v2)**: `migrateFromLegacy()` in both
  surfaces handles the `SceneRules` → `QuestingAdventurer` migration in a
  single step, producing v2 format directly. Safe to run repeatedly;
  no-ops once migration is done.
- **One-shot v1' → v2 migration**: `migrateV1ToV2()` in `loadState`
  (and the settings page's `useEffect`) handles the intermediate data
  model (post-rename, pre-v2) by collecting moves from `trigger.items`
  and top-level moves into the global library, creating
  `attachedMoveIds`, and persisting the v2 form. Safe to run repeatedly.
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
- **Dynamic default collapsed**: on first load (no stored `collapsed`),
  the overlay is expanded if there are active triggers and collapsed
  otherwise. After the user manually toggles, the stored value is used.
- **Lock state**: `locked: true` adds the `questing-adventurer-panel--locked`
  class, which hides row drag handles, reverts the header cursor to default
  (disabling panel drag), and dims penalty/reward/opacity controls.

## Data & Control Flow
**Overlay (`QuestingAdventurer.js`):**
1. `csLib.PathElementListener` fires `setupPanel(playerEl)` when
   `#VideoJsPlayer` exists on `/scenes/`.
2. `setupPanel` verifies the URL matches `/scenes/(\d+)`, ensures the player
   has `position: relative`, awaits `migrateFromLegacy()` then `loadState()`,
   creates the `.questing-adventurer-panel` div, attaches `click` /
   `dblclick` delegation, applies the persisted `panelPos`, appends to the
   player, and calls `render()`.
3. `render()` clears the panel and renders either a collapsed chip
   (showing the active-trigger count: `🗺️ Triggers (N)`) or an expanded view:
   header (title + 🔒 lock + ➕ add-toggle + Penalty/Reward + opacity
   hover-reveal slider + ✕ close) + scrollable list of active triggers
   with their attached moves + footer (input + Add Trigger / Add Move
   buttons, revealed by the add-toggle).
4. **Header actions**:
   - **Penalty** (`apply-penalty`): pick a random inactive trigger →
     activate it AND attach a random unattached move from the library. If
     every trigger is already active, pick a random active trigger and
     just attach a move. If the library has no unattached moves, just
     activate (no-op for the move part). Announces via aria-live.
   - **Reward** (`apply-reward`): pick a random active trigger that still
     has attached moves → remove a random attached move. If the trigger
     ends with zero attached moves, set it `active: false`. Announces
     via aria-live.
   - **Lock** (`toggle-lock`): flip `state.locked`, persist, re-render.
   - **Add toggle** (`toggle-add-controls`): flip `state.showAddControls`,
     persist, re-render. The footer (input + Add buttons) is hidden by
     default; revealed when this is on.
   - **Opacity icon** (`opacity-reset`): Ctrl/⌘+click resets to the
     default 0.6. The opacity slider drives an `input` listener that
     mutates `state.opacity`, updates `--qa-bg-alpha`, and calls
     `queueSave()`.
  - **Close** (`toggle-collapse`): flips `state.collapsed`, `queueSave()`,
    re-render.
  - **Manual toggle** (`toggle-manual-controls`): flips
    `state.showManualControls`, `queueSave()`, re-render. When on,
    renders a "Library" section between the active list and the
    bottom toggles. The Library is the manual-control surface for
    the v2 model: it gives the user fine-grained actions that the
    random Penalty/Reward buttons can't provide.
    - **Activate Trigger** subsection: lists every inactive trigger
      with a single-click ▶ button (`activate-trigger-manual`).
      Allowed even when the trigger has no attached moves — manual
      activation is an explicit user intent, not the atomic
      activate+attach that Penalty performs.
    - **Attach Move to Trigger** subsection: lists every library move
      not at the global `MAX_MOVE_ATTACHMENTS` (2) cap, each with
      a `<select>` listing all triggers (active first, then
      inactive). The select fires `change` (not `click`); the
      handler (`attachMoveToTriggerManual`) attaches the move and,
      if the target trigger was inactive, also activates it
      (mirroring Penalty's atomic behavior). Options for triggers
      the move is already attached to are disabled.
  5. **List rendering** (only active triggers):
   - `renderTrigger(list, trigger)` shows the trigger name + controls
     (drag handle, add-move button, delete button).
   - For each `attachedMoveIds` id, the move text is resolved from
     `state.moves` and rendered via `renderMove` (indented under the
     trigger).
6. `queueSave` → `csLib.setConfiguration("QuestingAdventurer", { moves,
   triggers, collapsed, opacity, panelPos, locked, showAddControls })`
   with the async save lock.

**Settings (`QuestingAdventurerSettings.js`):**
1. On script load, `PluginApi.patch.before("PluginRoutes", ...)` registers
   `<Route path="/plugins/questingadventurer" />` and
   `PluginApi.patch.before("SettingsToolsSection", ...)` adds a launcher
   card on even calls (Scene Tools section).
2. `QuestingAdventurerSettingsPage` mounts → `useEffect` runs
   `migrateFromLegacy()` (v0 → v2), reads `csLib.getConfiguration`, detects
   v2 format (`stored.moves` and `stored.triggers`) or migrates v1' → v2,
   then sets `moves` / `triggers` React state.
3. **Move Library section**: every move in `moves` is shown with its text
   (double-click to edit), a "Used by: [trigger names]" indicator
   (or "Unattached" in italic), and a delete button. Deleting a move
   that's attached to triggers prompts a confirm dialog and detaches it
   from all of them.
4. **Triggers section**: every trigger in `triggers` is shown with its
   name (double-click to edit), ▲/▼ reorder buttons, an "Add Move" button
   (adds a new move to the library AND attaches it to this trigger), a
   delete button, and its attached moves (resolved from the library)
   with their own delete buttons.
5. Mutators:
   - `addMoveTop(text)` — add a move to the global library (unattached).
   - `addTriggerTop(name)` — add a trigger (no attached moves).
   - `addMoveInto(triggerId, text)` — add to library AND attach.
   - `deleteMove(id)` — detach from parent trigger (move stays in library).
   - `deleteMoveFromLibrary(id)` — remove from library AND detach from
     all triggers (with confirm if attached).
   - `deleteTrigger(id)` — remove trigger (attached moves go back to
     library; unattached); requires `window.confirm`.
   - `editNode(id, newText)` / `editMoveText(id, newText)` — rename
     trigger or edit move text.
   - `moveNode(id, direction)` — swap with adjacent sibling using
     immutable updates. Used by the ▲/▼ buttons.
6. `commitTriggers` / `saveTriggersNow` — `saveTriggersNow` is `async`
   and re-reads stored config to preserve `collapsed`, `opacity`,
   `panelPos`, `locked`, `showAddControls`, then `await
   csLib.setConfiguration`.

## Integration Points
- **Depends on**: `window.csLib` (CommunityScriptsUILibrary) —
  `PathElementListener`, `getConfiguration`, `setConfiguration`. Required by
  the manifest (`ui.requires`).
- **Depends on**: `window.PluginApi` — `React` (`createElement`,
  `useState`/`useEffect`/`useRef`), `libraries.ReactRouterDOM` (`Route`,
  `Link`), `patch.before` for route/settings injection. Used only by the
  settings page.
- **Config key**: `"QuestingAdventurer"` (shared by both surfaces). Legacy
  `"SceneRules"` key is read once and migrated, then cleared.
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
- `QuestingAdventurer.yml` — plugin manifest (name, description, version 0.8,
  `ui.requires`/`javascript`/`css`).
- `QuestingAdventurer.js` — player overlay panel (vanilla JS).
- `QuestingAdventurerSettings.js` — full-page React CRUD settings UI with
  Move Library + Triggers sections.
- `QuestingAdventurer.css` — overlay panel styling.
- `QuestingAdventurerSettings.css` — settings page styling.
