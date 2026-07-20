# plugins/MosaicFilter/

## Responsibility
The **Mosaic Filter** Stash plugin — a player overlay that lets the user place a movable, resizable rectangle over any region of a scene to blur or censor it. The rectangle's position, size, blur intensity, follow-cursor behavior, and on/off state are stored as a **single global config** (shared by every scene). A full-page React settings page lets the user edit the same values via a form.

## Data Model
State shape (persisted under the config key `"MosaicFilter"`):
```js
{
  blurAmount: number,    // backdrop-filter blur radius in px (0..80)
  widthPct: number,      // rectangle width as % of player (0..1)
  heightPct: number,     // rectangle height as % of player (0..1)
  xPct: number,          // top-left x as % of player (0..1)
  yPct: number,          // top-left y as % of player (0..1)
  active: boolean,       // is the mosaic visible on the player?
  follow: boolean        // does the rectangle track the cursor?
}
```
The config is a **flat object** — no per-scene storage. All scenes share the same values. This matches the most common use case: the user opens a scene, the rectangle is there, and (with Follow on) it follows the cursor wherever they point.

Legacy shape `{ defaults: {...}, scenes: { [id]: {...} } }` (versions ≤ 0.2.x) is read on load: the `defaults` object is used as the flat config, and `scenes` is ignored. The next save writes the new flat shape.

Position and size are stored as **percentages of the player** so the rectangle scales correctly when the player is resized and across different viewports.

## Design Patterns
- **Manifest-driven plugin**: `MosaicFilter.yml` declares the plugin to Stash — name, description, version, required dependency (`CommunityScriptsUILibrary`), and the JS/CSS assets to load.
- **Two independent UI surfaces sharing one config key**:
  - **Player overlay** (`MosaicFilter.js`): vanilla JS, imperative DOM manipulation. Renders the mosaic rectangle and a compact control bar; pointer-event drag/resize/follow.
  - **Settings page** (`MosaicFilterSettings.js`): React component registered through Stash's `PluginApi` patching hooks (`patch.before`).
- **SPA injection via `PathElementListener`**: `csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel)` waits for the player element on scene routes and re-injects on SPA navigation.
- **Safety-net re-injection**: a `window.PluginApi.Event` `"stash:location"` listener re-creates the overlay if React re-renders remove it.
- **`backdrop-filter: blur(...)` for the mosaic effect**: a transparent rectangle that blurs whatever video frame is behind it. This is the standard CSS approach for "blur a region of a video" and degrades to a semi-opaque rectangle where `backdrop-filter` is unsupported.
- **Pointer events for drag/resize** (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`) for cross-platform support including touch. `touch-action: none` on handles, `setPointerCapture` keeps the drag alive if the pointer leaves the handle.
- **Save lock with pending flag**: a `saving`/`pendingSave` lock around `csLib.setConfiguration` coalesces concurrent async saves (same pattern as `QuestingAdventurer`).
- **Scene-Tools-only launcher**: the settings launcher uses a module-level call counter on `SettingsToolsSection`; it injects the card on **even** calls (the Scene Tools section).

## Data & Control Flow
**Overlay (`MosaicFilter.js`):**
1. On script load, register `csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel)` and a `stash:location` safety net.
2. `setupPanel(playerEl)`:
   - Ensures the player has `position: relative`.
   - Awaits `loadState()` which reads `csLib.getConfiguration("MosaicFilter")` and applies the legacy-shape migration if needed.
   - Calls `mountOnPlayer()` which (re-)queries the player, builds the rectangle and the control bar, attaches pointer-event listeners, and calls `render()`.
3. `render()`:
   - Updates the rectangle's pixel position/size from the percentages, and the inline `--mf-blur` custom property.
   - Toggles the `mosaic-filter-rectangle--hidden` class based on `state.active`.
   - Renders the control bar: title chip, on/off toggle, blur slider, follow toggle, "Reset", and "Close" (×).
4. **Header actions** (event delegation on `data-action`):
   - **Toggle** (`toggle-active`): flips `state.active`, `queueSave()`, re-render.
   - **Follow** (`toggle-follow`): flips `state.follow`. When turned on, `snapRectToPointer()` jumps the rectangle to the current cursor position so the user doesn't see a "lag" from the saved location to the cursor on the next pointermove. While follow is on, the player-level `pointermove` listener centers the rectangle on the cursor; the rectangle's drag handler refuses to start (resize still works).
   - **Reset** (`reset-defaults`): replaces `state` with `FALLBACK_DEFAULTS`, `queueSave()`, re-render.
   - **Close** (`close-bar`): collapses the control bar (the rectangle stays if it is `active`); the bar can be brought back by clicking the chip. Collapse state is tracked in a module-level `barCollapsed` so re-renders don't silently re-expand the controls.
   - **Chip click** (`toggle-bar`): toggles `barCollapsed` (expands/collapses the controls).
5. **Rectangle drag**:
   - `pointerdown` on the rectangle starts a drag; we track the start pointer position and the start `xPct`/`yPct`.
   - `pointermove` (with `setPointerCapture`) updates `xPct`/`yPct` from pointer delta / player size; clamps to `[0, 1 - widthPct/heightPct]`.
   - `pointerup`/`pointercancel` ends the drag and calls `queueSave()`.
   - Disabled while `state.follow` is true (the cursor already drives the position); only the resize handle can start an interaction in that mode.
6. **Resize**:
   - A bottom-right resize handle starts a resize drag on `pointerdown`.
   - `pointermove` updates `widthPct`/`heightPct` from pointer delta; clamps to a minimum (e.g. 0.05).
   - `pointerup`/`pointercancel` ends and `queueSave()`.
7. **Follow-cursor**:
   - A `pointermove` listener is attached to the player (not the document) while the overlay is mounted. When `state.follow` is true, the handler re-centers the rectangle on the cursor.
   - **Follow-mode position updates are in-memory only** — no `csLib.setConfiguration` is called per pointermove. Every intermediate cursor position is throwaway, and persisting each one would mean a `configurePlugin` GraphQL mutation per frame. The position is persisted at the natural boundaries instead (see "Write policy" below).
   - The handler always records the latest cursor position in `lastPointer`; toggling Follow on later calls `snapRectToPointer()` so the rectangle jumps to that position immediately.
8. **Blur slider**:
   - `<input type="range">` with `min=0 max=80 step=1`.
   - The `input` event updates the visual blur (`--mf-blur` custom property and the readout span) on every value change. **It does NOT call `queueSave()`.**
   - The `change` event (which fires when the user releases the thumb) calls `queueSave()`. This is the persistence boundary.

### Write policy
Writes to `csLib.setConfiguration` happen at user-driven boundaries, never on a continuous animation:
- **Toggle buttons** (active, follow, reset): immediate write.
- **Drag / resize end** (`pointerup`/`pointercancel`): immediate write.
- **Blur slider**: one write on `change` (slider release). The `input` event updates the visual only.
- **`pagehide` event** (tab close, navigation, reload): best-effort write. Async saves may not complete before the page unloads, but the request is at least submitted.

**Settings (`MosaicFilterSettings.js`):**
1. On script load, `PluginApi.patch.before("PluginRoutes", ...)` registers `<Route path="/plugins/mosaicfilter" />` and `PluginApi.patch.before("SettingsToolsSection", ...)` adds a launcher card on even calls (Scene Tools section).
2. `MosaicFilterSettingsPage` mounts → `useEffect` reads `csLib.getConfiguration("MosaicFilter")`, applies the legacy-shape migration if needed, and sets React state.
3. **Settings section**: form fields for `blurAmount`, `widthPct`, `heightPct`, `xPct`, `yPct`, and the `active` and `follow` flags. A single **Save** button writes the whole flat config.
4. No per-scene management — all scenes share the same values, so there is no "Saved scenes" list and no danger-zone clear-all.

## Integration Points
- **Depends on**: `window.csLib` (CommunityScriptsUILibrary) — `PathElementListener`, `getConfiguration`, `setConfiguration`. Required by the manifest (`ui.requires`).
- **Depends on**: `window.PluginApi` — `React` (`createElement`, `useState`/`useEffect`), `libraries.ReactRouterDOM` (`Route`, `Link`), `patch.before` for route/settings injection. Used only by the settings page.
- **Config key**: `"MosaicFilter"` (shared by both surfaces).
- **Routes injected**: `/plugins/mosaicfilter` (settings page).
- **DOM mount**: `#VideoJsPlayer` (mosaic rectangle + control bar appended as absolutely-positioned children).
- **Consumed by**: Stash app runtime, which loads the JS/CSS assets per the manifest.
- **Known limitation**: the overlay and settings page maintain separate save locks and do not coordinate across components; a concurrent write from both could race (last writer wins the whole config map). Settings edits will not live-reflect in an already-open overlay until the next navigation/reload.

## Files
- `MosaicFilter.yml` — plugin manifest (name, description, version 0.3.0, `ui.requires`/`javascript`/`css`).
- `MosaicFilter.js` — player overlay (vanilla JS) with toggle, follow, drag, resize, blur slider, and global persistence.
- `MosaicFilter.css` — overlay styling (rectangle, control bar, drag handle, resize handle, blur slider).
- `MosaicFilterSettings.js` — full-page React settings UI (Settings form editing the global config).
- `MosaicFilterSettings.css` — settings page styling.
