# plugins/MosaicFilter/

## Responsibility
The **Mosaic Filter** Stash plugin — a player overlay that lets the user place a movable, resizable rectangle over any region of a scene to blur or censor it. The rectangle's position, size, blur intensity, and on/off state are remembered **per scene** and restored when the scene is reopened. A full-page React settings page provides global defaults and lets the user manage or clear the saved per-scene states.

## Data Model
State shape (persisted under the config key `"MosaicFilter"`):
```js
{
  defaults: {
    blurAmount: number,    // default backdrop-filter blur radius in px (e.g. 24)
    widthPct: number,      // default mosaic width as % of player (0..1) (e.g. 0.25)
    heightPct: number,     // default mosaic height as % of player (0..1) (e.g. 0.25)
    active: boolean,       // default active state for new scenes
    follow: boolean        // default follow-cursor state for new scenes
  },
  scenes: {
    // sceneId (string, from /scenes/<id>) -> per-scene mosaic rectangle
    [sceneId]: {
      active: boolean,     // is the mosaic on for this scene?
      follow: boolean,     // does the rectangle track the cursor?
      xPct: number,        // top-left as % of player (0..1)
      yPct: number,
      widthPct: number,    // size as % of player (0..1)
      heightPct: number,
      blurAmount: number   // backdrop-filter blur radius in px
    }
  }
}
```
Position and size are stored as **percentages of the player** so the mosaic rectangle scales correctly when the player is resized and across different viewports.

## Design Patterns
- **Manifest-driven plugin**: `MosaicFilter.yml` declares the plugin to Stash — name, description, version, required dependency (`CommunityScriptsUILibrary`), and the JS/CSS assets to load.
- **Two independent UI surfaces sharing one config key**:
  - **Player overlay** (`MosaicFilter.js`): vanilla JS, imperative DOM manipulation. Renders the mosaic rectangle and a compact control bar; pointer-event drag/resize.
  - **Settings page** (`MosaicFilterSettings.js`): React component registered through Stash's `PluginApi` patching hooks (`patch.before`).
- **SPA injection via `PathElementListener`**: `csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel)` waits for the player element on scene routes and re-injects on SPA navigation.
- **Safety-net re-injection**: a `window.PluginApi.Event` `"stash:location"` listener re-creates the overlay if React re-renders remove it.
- **Per-scene isolation**: the overlay reads the scene id from the URL (`/scenes/(\d+)`) and reads/writes only that scene's slot in `state.scenes`. Other scenes' data is preserved on save (read-modify-write).
- **Percent-based geometry**: rectangle coordinates are stored as fractions of player size; the overlay recomputes pixel positions on every render and resize.
- **`backdrop-filter: blur(...)` for the mosaic effect**: a transparent rectangle that blurs whatever video frame is behind it. This is the standard CSS approach for "blur a region of a video" and degrades to a semi-opaque rectangle where `backdrop-filter` is unsupported.
- **Pointer events for drag/resize** (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`) for cross-platform support including touch. `touch-action: none` on handles, `setPointerCapture` keeps the drag alive if the pointer leaves the handle.
- **Save lock with pending flag**: a `saving`/`pendingSave` lock around `csLib.setConfiguration` coalesces concurrent async saves (same pattern as `QuestingAdventurer`).
- **Scene-Tools-only launcher**: the settings launcher uses a module-level call counter on `SettingsToolsSection`; it injects the card on **even** calls (the Scene Tools section).

## Data & Control Flow
**Overlay (`MosaicFilter.js`):**
1. On script load, register `csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel)` and a `stash:location` safety net.
2. `setupPanel(playerEl)`:
   - Verifies the URL matches `/scenes/(\d+)` and extracts the scene id; otherwise bails.
   - Ensures the player has `position: relative`.
   - Awaits `loadState()` which reads `csLib.getConfiguration("MosaicFilter")`, applies defaults, and materializes a per-scene state object (creating one with defaults if this scene has no entry yet).
   - Creates the mosaic rectangle (the blur element) and the control bar, attaches pointer-event listeners, applies the saved `xPct`/`yPct`/`widthPct`/`heightPct`/`blurAmount`, appends both to the player, and calls `render()`.
3. `render()`:
   - Updates the rectangle's pixel position/size from the percentages, and the inline `--mf-blur` custom property.
   - Toggles the `mosaic-filter-rectangle--hidden` class based on `sceneState.active`.
   - Renders the control bar: title chip, on/off toggle, blur slider, "Reset to defaults", "Clear this scene's data", and "Close" (×).
4. **Header actions** (event delegation on `data-action`):
   - **Toggle** (`toggle-active`): flips `sceneState.active`, `queueSave()`, re-render.
   - **Follow** (`toggle-follow`): flips `sceneState.follow`. When turned on, `snapRectToPointer()` jumps the rectangle to the current cursor position so the user doesn't see a "lag" from the saved location to the cursor on the next pointermove. While follow is on, the player-level `pointermove` listener centers the rectangle on the cursor; the rectangle's drag handler refuses to start (resize still works).
   - **Reset to defaults** (`reset-defaults`): overwrites this scene's slot with `state.defaults`, `queueSave()`, re-render.
   - **Close** (`close-bar`): collapses the control bar (the rectangle stays if it is `active`); the bar can be brought back by clicking the chip. Collapse state is tracked in a module-level `barCollapsed` so re-renders don't silently re-expand the controls.
   - **Chip click** (`toggle-bar`): toggles `barCollapsed` (expands/collapses the controls).
5. **Rectangle drag**:
   - `pointerdown` on the rectangle starts a drag; we track the start pointer position and the start `xPct`/`yPct`.
   - `pointermove` (with `setPointerCapture`) updates `xPct`/`yPct` from pointer delta / player size; clamps to `[0, 1 - widthPct/heightPct]`.
   - `pointerup`/`pointercancel` ends the drag and calls `queueSave()`.
   - Disabled while `sceneState.follow` is true (the cursor already drives the position); only the resize handle can start an interaction in that mode.
6. **Resize**:
   - A bottom-right resize handle starts a resize drag on `pointerdown`.
   - `pointermove` updates `widthPct`/`heightPct` from pointer delta; clamps to a minimum (e.g. 0.05).
   - `pointerup`/`pointercancel` ends and `queueSave()`.
7. **Follow-cursor**:
   - A `pointermove` listener is attached to the player (not the document) while the overlay is mounted. When `sceneState.follow` is true, the handler re-centers the rectangle on the cursor and schedules a throttled `queueSave()` (one write per ~120 ms while the cursor is in motion).
   - The handler always records the latest cursor position in `lastPointer`; toggling Follow on later calls `snapRectToPointer()` so the rectangle jumps to that position immediately.
8. **Blur slider**:
   - `<input type="range">` with `min=0 max=80 step=1`; `input` listener mutates `sceneState.blurAmount`, updates the inline `--mf-blur` custom property, and `queueSave()`.
9. `queueSave` → `csLib.setConfiguration("MosaicFilter", state)` (whole config map) wrapped in the async save lock.

**Settings (`MosaicFilterSettings.js`):**
1. On script load, `PluginApi.patch.before("PluginRoutes", ...)` registers `<Route path="/plugins/mosaicfilter" />` and `PluginApi.patch.before("SettingsToolsSection", ...)` adds a launcher card on even calls (Scene Tools section).
2. `MosaicFilterSettingsPage` mounts → `useEffect` reads `csLib.getConfiguration("MosaicFilter")`, ensures `defaults` and `scenes` are present (filling missing fields from defaults), then sets React state.
3. **Defaults section**: form fields for `blurAmount`, `widthPct`, `heightPct`, and the default `active` state. Save button writes back the entire config (preserving `scenes`).
4. **Saved Scenes section**: a list of every entry in `scenes` showing the scene id, blur amount, size, and a "Delete" button. Each item also has a "Copy id" affordance (troubleshooting). The list can be empty (the section collapses to "No saved scenes yet").
5. **Danger zone**: "Clear all saved scenes" button with confirm.
6. `saveConfig(next)` — re-reads stored config (preserves any overlay-owned fields if a save race happens; here the settings page is the only writer of `scenes` and `defaults` so this is mostly a safety net) and `await csLib.setConfiguration`.

## Integration Points
- **Depends on**: `window.csLib` (CommunityScriptsUILibrary) — `PathElementListener`, `getConfiguration`, `setConfiguration`. Required by the manifest (`ui.requires`).
- **Depends on**: `window.PluginApi` — `React` (`createElement`, `useState`/`useEffect`/`useRef`), `libraries.ReactRouterDOM` (`Route`, `Link`), `patch.before` for route/settings injection. Used only by the settings page.
- **Config key**: `"MosaicFilter"` (shared by both surfaces).
- **Routes injected**: `/plugins/mosaicfilter` (settings page).
- **DOM mount**: `#VideoJsPlayer` (mosaic rectangle + control bar appended as absolutely-positioned children).
- **Consumed by**: Stash app runtime, which loads the JS/CSS assets per the manifest.
- **Known limitation**: the overlay and settings page maintain separate save locks and do not coordinate across components; a concurrent write from both could race (last writer wins the whole config map). Settings edits will not live-reflect in an already-open overlay until the next navigation/reload.

## Files
- `MosaicFilter.yml` — plugin manifest (name, description, version 0.1.0, `ui.requires`/`javascript`/`css`).
- `MosaicFilter.js` — player overlay (vanilla JS) with toggle, drag, resize, blur slider, and per-scene persistence.
- `MosaicFilter.css` — overlay styling (rectangle, control bar, drag handle, resize handle, blur slider).
- `MosaicFilterSettings.js` — full-page React settings UI (Defaults, Saved Scenes, Clear-all).
- `MosaicFilterSettings.css` — settings page styling.
