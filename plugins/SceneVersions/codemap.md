# plugins/SceneVersions/

## Responsibility
The **Scene Versions** Stash plugin — adds a "Related Scenes" tab to the scene page that lets the user associate alternate versions of a scene (e.g. the same performance in a different costume or from a different angle). Bidirectional links are stored in scene custom fields under the key `"RelatedScenes"` (a JSON-serialised array of scene ID strings — Stash's custom_fields store only supports scalar values, so the id list is `JSON.stringify`'d before writing and `JSON.parse`'d on read). A "suggest from same folder" helper queries other scenes sharing the current scene's file folder and offers a quick "Add" button for each.

## Data Model
Data is stored in each scene's `custom_fields` under the key `"RelatedScenes"`:
```js
// On each scene (stored as a JSON string because Stash custom_fields
// only accept scalar values — arrays are rejected by the backend):
custom_fields: {
  RelatedScenes: string  // JSON.stringify(string[]) e.g. "[\"12\",\"34\"]"
}
```
On read, the string is `JSON.parse`'d back to `string[]`. Links are **bidirectional**: when scene A lists scene B, scene B also lists scene A. The `syncBidirectional` function ensures both sides are updated atomically (within the limits of async writes).

No plugin-level config key is used — the data lives entirely on the scene objects themselves, so there is no cross-surface race condition (unlike QuestingAdventurer or MosaicFilter).

## Design Patterns
- **Manifest-driven plugin**: `SceneVersions.yml` declares the plugin to Stash — name, description, version, and the JS/CSS assets to load. No `ui.requires` (no csLib dependency).
- **Single React component** (`RelatedScenesTab`) injected into the scene page via `PluginApi.patch.before` on `"ScenePage.Tabs"` and `"ScenePage.TabContent"`.
- **No player overlay** — this is a tab-only plugin. No `csLib.PathElementListener` or SPA re-injection needed.
- **Apollo client for all data access**: `libraries.Apollo.client.query` for reads, `libraries.Apollo.client.mutate` for writes. No `csLib.getConfiguration`/`setConfiguration`.
- **SceneIDSelect picker**: uses `components.SceneIDSelect` for the multi-scene picker UI, with `excludeIds` to prevent self-links and `extraCriteria` set to a duck-typed path `INCLUDES` criterion (built by `makeFolderCriterion`) that restricts the dropdown to the current scene's folder — so the common "same performer/studio lives in one folder" workflow is discoverable without paging through the whole library. Cross-folder links can still be added via the suggestions list.
- **Suggest-from-folder**: uses `GQL.FindScenesDocument` with a `scene_filter` on `path` (modifier: `"INCLUDES"`) to find other scenes in the same folder. Suggestions are fetched in a parallel `useEffect` and rendered as a compact list above the related scenes card list. The "Add" button appends the scene id to `relatedIds` and the scene object to `relatedScenes` without saving.
- **Bidirectional sync**: `syncBidirectional` reads each added/removed scene's current `RelatedScenes`, patches it, and writes back. Self-links are filtered at every step.
- **`custom_fields.partial` for writes**: all mutations use `custom_fields: { partial: { RelatedScenes: JSON.stringify([...]) } }` to avoid clobbering other custom fields. The value is a JSON string because Stash's custom_fields store only supports scalar values (arrays/objects are rejected by `getSQLValueFromCustomFieldInput`). `encodeIds`/`decodeIds` handle the (de)serialisation; `decodeIds` also tolerates a legacy bare-array value if one is ever encountered in cache.

## Data & Control Flow
1. On script load, `PluginApi.patch.before` registers two patches:
   - `"ScenePage.Tabs"` — inserts a `Nav.Item` / `Nav.Link` with `eventKey: "scene-versions-panel"` after the "Details" tab. The link content is the `RelatedScenesTabLabel` component, which renders "Related Scenes" plus a count badge. The label does its own `readRelatedIds` on mount (so the count is visible before the user opens the tab) and subscribes to a module-level pub/sub (`onCountChange`/`emitCountChange`, keyed by scene id) so it stays live as the user edits/saves inside the tab.
   - `"ScenePage.TabContent"` — inserts a `Tab.Pane` with the `RelatedScenesTab` component, mounted after the Details pane.
2. `RelatedScenesTab` mounts:
   - **Main load** (`useEffect` on `[scene.id]`): calls `readRelatedIds(scene.id)` → `loadScenesByIds(ids)` → sets `relatedIds`, `relatedScenes`, `loading`; emits the initial count via `emitCountChange`.
   - **Count sync** (`useEffect` on `[scene.id, relatedIds]`): emits the current `relatedIds.length` to the tab-label pub/sub whenever the edit state changes (load, picker select, remove, add-suggestion, discard).
   - **Folder criteria** (`useMemo` on `[scene]`): calls `getFolderPath(scene)` → `makeFolderCriterion(folderPath)` → `folderCriteria`, passed to `SceneIDSelect` as `extraCriteria` so the picker dropdown only lists scenes in the current scene's folder.
   - **Suggestions load** (parallel `useEffect` on `[scene.id, relatedIds]`): calls `getFolderPath(scene)` → `fetchSuggestions(folderPath, excludeIds)` → sets `suggestions`.
3. **Render order** (top to bottom): related-scenes card list (or empty state) → edit region (picker + Save/Discard) → suggestions-from-folder. The in-tab section header (title + count badge) was removed in 0.4.0 because the count now lives on the tab strip itself.
4. **Picker selection** (`handleSelect`): replaces `relatedIds` with the selected scene IDs, sets `dirty` by comparing to `loadedIdsRef.current`.
5. **Remove** (`handleRemove`): removes a scene id from `relatedIds` and the scene object from `relatedScenes`, sets `dirty`.
6. **Add suggestion** (`handleAddSuggestion`): appends a scene id to `relatedIds` and the scene object to `relatedScenes`, sets `dirty`. Does NOT save.
7. **Save** (`handleSave`): calls `syncBidirectional(scene.id, relatedIds, loadedIdsRef.current)`, updates `loadedIdsRef`, clears `dirty`, shows toast.
8. **Discard** (`handleDiscard`): resets `relatedIds` to `loadedIdsRef.current`, reloads `relatedScenes`, clears `dirty` and `error`.
9. **Error state**: if the main load fails, an error alert with a "Retry" button is shown. Suggestions errors are silently logged to console.

## Integration Points
- **Depends on**: `window.PluginApi` — `React` (`createElement`, `useState`/`useEffect`/`useRef`/`useCallback`), `GQL` (`FindSceneDocument`, `FindScenesDocument`, `SceneUpdateDocument`), `libraries.Apollo.client`, `libraries.Bootstrap` (`Tab`, `Nav`, `Button`, `Badge`, `Alert`, `Spinner`), `libraries.ReactRouterDOM` (`Link`), `components.SceneIDSelect`, `hooks.useToast`.
- **No csLib dependency** — the manifest has no `ui.requires`.
- **Config key**: none — data is stored in scene `custom_fields`.
- **Routes injected**: none (tab injection only, no settings page).
- **DOM mount**: injected into the scene page tab content area via `PluginApi.patch.before`.
- **Consumed by**: Stash app runtime, which loads the JS/CSS assets per the manifest.
- **Known limitation**: the suggest-from-folder query and the picker's folder criterion both use `path: { modifier: "INCLUDES" }`, which is a substring match — scenes in subfolders whose path contains the folder string may also appear. This is acceptable since folders usually contain few scenes and irrelevant entries can be ignored. `getFolderPath` preserves the original path separator (`\` on Windows, `/` elsewhere) because the Stash backend builds the LIKE pattern from `folders.path || <filepath.Separator> || files.basename` and matches it against the raw value sent — normalising to `/` made the criterion match nothing on Windows (fixed in 0.3.0; pre-0.3.0 the suggestions list was always empty on Windows). The INCLUDES modifier also splits the value on whitespace and ORs the terms, so folder paths containing spaces may match loosely.

## Files
- `SceneVersions.yml` — plugin manifest (name, description, version 0.4.0, `ui.javascript`/`ui.css`).
- `SceneVersions.js` — React component for the Related Scenes tab, including suggest-from-folder helper and a `RelatedScenesTabLabel` component (count badge in the tab strip, kept live via a module-level pub/sub keyed by scene id).
- `SceneVersions.css` — tab styling (header, edit region, card list, empty/loading/error states, suggestions section, responsive breakpoints).
