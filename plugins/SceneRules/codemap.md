# plugins/SceneRules/

## Responsibility
The **SceneRules** Stash plugin — provides an interactive overlay on the scene player plus a full-page settings UI for managing a global, 2-level list of "viewing rules". Top-level nodes are either standalone rules or categories; categories contain only leaf rules. All state is persisted to Stash configuration under the key `"SceneRules"`.

## Design Patterns
- **Manifest-driven plugin**: `SceneRules.yml` declares the plugin to Stash — name, description, version, required dependency (`CommunityScriptsUILibrary`), and the JS/CSS assets to load.
- **Two independent UI surfaces sharing one config key**:
  - **Player overlay** (`SceneRules.js`): vanilla JS, imperative DOM manipulation, event delegation via `data-action` attributes on a single panel element.
  - **Settings page** (`SceneRulesSettings.js`): React component registered through Stash's `PluginApi` patching hooks (`patch.before`).
- **SPA injection via `PathElementListener`**: `csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel)` waits for the player element on scene routes and re-injects on SPA navigation.
- **Safety-net re-injection**: a `window.PluginApi.Event` `"stash:location"` listener re-creates the panel if React re-renders remove it (a brief flash between removal and re-injection is acknowledged).
- **Save lock with pending flag**: both surfaces guard `csLib.setConfiguration` with a `saving`/`pendingSave` lock to coalesce concurrent async saves and avoid interleaving.
- **Semantic state split**: the settings page owns the `rules` array; the overlay owns the `collapsed` flag. Every settings save re-reads the stored config to preserve `collapsed`.
- **Immutable updates (React surface)**: settings mutators produce new arrays/objects via spread; the overlay mutates state in place then re-renders.
- **Stale-closure guard**: settings page keeps an `editingIdRef` mirror of `editingId` so blur/Enter handlers read the live value, not the captured render-time value.

## Data & Control Flow
State shape: `{ rules: Node[], collapsed: boolean }` where `Node` is either `{ id, type: "rule", text }` or `{ id, type: "category", name, items: Rule[] }`.

**Overlay (`SceneRules.js`):**
1. `csLib.PathElementListener` fires `setupPanel(playerEl)` when `#VideoJsPlayer` exists on `/scenes/`.
2. `setupPanel` verifies the URL matches `/scenes/(\d+)`, ensures the player has `position: relative`, calls `loadState()`, creates the `.scene-rules-panel` div, attaches `click`/`dblclick` delegation, appends to the player, and calls `render()`.
3. `render()` clears the panel and renders either a collapsed chip (showing `getTotalRuleCount()`) or a header + scrollable list + footer (input + Add Category / Add Rule buttons).
4. User clicks flow through `handleClick` → switch on `data-action` → mutators (`addRuleTop`, `addCategoryTop`, `addRuleInto`, `deleteRule`, `deleteCategory`, `toggle-collapse`) → `queueSave()` → `render()`.
5. Double-click → `handleDblClick` → sets `editingId` → `render()` swaps in `createEditInput`; Enter saves, Escape cancels, blur saves.
6. `queueSave` → `csLib.setConfiguration("SceneRules", { rules, collapsed })` with the async save lock.

**Settings (`SceneRulesSettings.js`):**
1. On script load, `PluginApi.patch.before("PluginRoutes", ...)` registers `<Route path="/plugins/scenerules">` and `PluginApi.patch.before("SettingsToolsSection", ...)` adds a launcher card in Settings > Tools.
2. `SceneRulesSettingsPage` mounts → `useEffect` loads `csLib.getConfiguration("SceneRules")` → `setRules` / `setLoading(false)`.
3. Mutators (`addRuleTop`, `addCategoryTop`, `addRuleInto`, `deleteRule`, `deleteCategory`, `editNode`) build immutable next-rules arrays → `commitRules` (or direct `setRules` + `saveRules`) → `saveRulesNow` re-reads stored config to preserve `collapsed`, then `csLib.setConfiguration`.
4. Inline edit via `renderEditInput` with `editingIdRef` to avoid stale-closure guards on blur/Enter.

## Integration Points
- **Depends on**: `window.csLib` (CommunityScriptsUILibrary) — `PathElementListener`, `getConfiguration`, `setConfiguration`. Required by the manifest (`ui.requires`).
- **Depends on**: `window.PluginApi` — `React` (`createElement`, `useState`/`useEffect`/`useRef`), `libraries.ReactRouterDOM` (`Route`, `Link`), `patch.before` for route/settings injection. Used only by the settings page.
- **Config key**: `"SceneRules"` (shared by both surfaces).
- **Routes injected**: `/plugins/scenerules` (settings page).
- **DOM mount**: `#VideoJsPlayer` (overlay panel appended as an absolute-positioned child).
- **Consumed by**: Stash app runtime, which loads the JS/CSS assets per the manifest.
- **Known limitation**: the overlay and settings page maintain separate save locks and do not coordinate across components; a concurrent write from both could race (last writer wins the whole config map). Settings edits will not live-reflect in an already-open overlay until the next navigation/reload.

## Files
- `SceneRules.yml` — plugin manifest (name, description, version 0.2, `ui.requires`/`javascript`/`css`).
- `SceneRules.js` — player overlay panel (vanilla JS, 487 lines).
- `SceneRulesSettings.js` — full-page React CRUD settings UI (449 lines).
- `SceneRules.css` — overlay panel styling (absolute overlay, dark translucent theme, collapsible chip).
- `SceneRulesSettings.css` — settings page styling (centered max-width layout, launcher card, edit inputs).
