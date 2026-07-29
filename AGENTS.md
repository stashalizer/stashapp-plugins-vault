# AGENTS.md — stashapp-plugins-vault

A Stash plugin source-index repository: zips each `plugins/<PluginId>/` directory and publishes `index.yml` to GitHub Pages. Built on the official [CommunityScripts](https://github.com/stashapp/CommunityScripts) template. Currently ships four plugins: **QuestingAdventurer**, **MosaicFilter**, **SceneVersions**, and **AudioSupport**.

## Repository map

A full codemap is available at `codemap.md` in the project root.

Stash plugin development reference links (official docs + community
repo + csLib source notes) live in [`docs/references.md`](docs/references.md).
Consult it before adding a new patch target, wiring up `csLib`, or
debugging persistence / SPA-injection issues.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md` (`plugins/codemap.md`, `plugins/QuestingAdventurer/codemap.md`, `plugins/MosaicFilter/codemap.md`, `plugins/SceneVersions/codemap.md`, `plugins/AudioSupport/codemap.md`).

## Language policy

All code comments, commit messages, documentation, and user-facing text in this repository MUST be in English. Do not add non-English (e.g. Chinese) comments or docs. Existing non-English content should be translated to English when encountered.

## Layout

```
plugins/<PluginId>/
  <PluginId>.yml            # manifest: name, description, version, ui.requires/javascript/css
  <PluginId>.js             # player overlay (vanilla JS, uses window.csLib)
  <PluginId>Settings.js     # optional full-page settings UI (React via window.PluginApi)
  codemap.md                # per-plugin architectural map
  *.css
build_site.sh               # zips each plugin + writes index.yml
.github/workflows/deploy.yml
```

## Build & publish

- **No local toolchain** — no bundler, linter, typecheck, tests, or dev server. Stash loads the raw JS/CSS at runtime; you only need a text editor.
- **Preview the build locally:** `./build_site.sh _site/main` from the repo root. Requires `zip`, `sha256sum`, `git`, `realpath` on `PATH`. Output: `_site/main/index.yml` + one `<PluginId>.zip` per plugin.
- **Publish trigger:** `.github/workflows/deploy.yml` runs on push to `main` whose paths filter matches `plugins/**`. Doc/README/codemap-only changes do **not** trigger a publish.
- **Published URL:** `https://<owner>.github.io/<repo>/main/index.yml` (the path segment is the branch name). Users add this under **Settings > Plugins > Available Plugins > Add Source** in Stash.
- **Push the current branch, not always `main`.** After committing a plugin change, run `git push` (or `git push -u origin HEAD` if the branch has no upstream yet) and report which branch was pushed. The deploy trigger above only fires from `main`, so if you are inside a `git worktree` lane on a feature branch (`omos/...`, `feat/...`, `fix/...`), the push lands on that branch and will **not** publish — the user must merge to `main` (or open a PR) for the deploy to happen. Never force-push a feature branch without explicit confirmation.
- `_site/` is generated and gitignored — never commit it.

## Plugin manifest gotchas

- **Plugin id = directory name = yml basename.** Renaming the directory means renaming the yml and the asset list inside it.
- `build_site.sh` parses the yml with `grep -E '^(name|description|version):'`. The published `version` becomes `<ymlVersion>-<gitShortHash>` in `index.yml`.
- **Dependencies are read from a comment line, not from `ui.requires`.** Keep `# requires: PluginA, PluginB` (comma-separated) at the bottom of the yml in sync with `ui.requires`. See `QuestingAdventurer.yml:7,14`. The two locations must agree.
- `ui.javascript` / `ui.css` entries are paths relative to the plugin directory.
- **Runtime globals are not bundled.** The plugin expects `window.csLib` and `window.PluginApi` to be provided by Stash; users must install **CommunityScriptsUILibrary** first (declared in `ui.requires`).

## QuestingAdventurer

- **Two UIs, one config key** `"QuestingAdventurer"`. State shape: `{ moves: [{id,text}], triggers: [{id,name,active,attachedMoveIds}], collapsed, opacity, panelPos, showAddControls }`.
- **v2 data model**: moves are a global library (`moves: [{id,text}]`); triggers reference moves by id via `attachedMoveIds: [string]`. The `active` flag lives on the **trigger**, not the move. A trigger with no attached moves is `active: false` by design.
- **Penalty / Reward** (overlay header buttons):
  - **Penalty** picks a random **inactive** trigger → activates it AND attaches a random **unattached** move from the library. If every trigger is already active, it picks a random active trigger and just attaches a move. If the library has no unattached moves, the trigger is still activated (no-op for the move part).
  - **Reward** picks a random **active** trigger that still has attached moves → removes a random attached move. If the trigger ends with zero attached moves, it is set `active: false`.
- **Overlay shows only active triggers** and their attached moves (resolved from the global library by id). The chip shows `🗺️ Triggers (N)` where N is the number of active triggers.
- **Dynamic default collapsed**: on first load (no stored `collapsed`), the overlay is expanded if there are active triggers and collapsed otherwise. After the user manually toggles, the stored value is used.
- **Header controls**: ➕ add-toggle button (`showAddControls: bool` — reveals the Add Trigger / Add Move footer which is hidden by default), opacity slider (hover-reveal), ✕ close.
- The **overlay** mutates state in place then re-renders; the **settings page** uses React with immutable updates. They share a config key but each owns different fields semantically: the settings page owns `moves` and `triggers`; the overlay owns `collapsed`, `opacity`, `panelPos`, `showAddControls`. Each save re-reads the stored config to preserve the other surface's fields.
- Each surface has its own `saving`/`pendingSave` save lock. **They do not coordinate across components** — concurrent writes race and last writer wins the whole config map. Settings edits will not live-reflect in an already-open overlay until the next navigation or reload.
- `csLib.getConfiguration` and `setConfiguration` are BOTH `async` (always return Promises). Always `await` them. Treating a Promise as a plain object is a silent failure mode that surfaces as "data disappears after refresh". Both surfaces' `loadState` and `saveTriggersNow`/`queueSave` are `async` and `await` the calls. See `docs/references.md` for the full csLib notes.
- Overlay re-injects on the `stash:location` SPA event via `csLib.PathElementListener`; a brief flash between React unmount and re-injection is expected (see the header comment in `QuestingAdventurer.js`).
- The settings page is registered through `PluginApi.patch.before`:
  - `PluginRoutes` → `<Route path="/plugins/questingadventurer" />` (lowercase plugin id, hardcoded — update if you rename the plugin)
  - `SettingsToolsSection` → launcher card on the **2nd** call only (Scene Tools section). See `QuestingAdventurerSettings.js` for the call-counter; do not remove it.
- **Two migrations run on first load**:
  1. `migrateFromLegacy()` — v0 (`SceneRules`) → v2 (`QuestingAdventurer`). Both surfaces run it. If a `SceneRules` key exists but no `QuestingAdventurer` key does, the data is migrated (`category` → `trigger`, `rule` → `move`, all moves go into the global library, triggers get `attachedMoveIds`) and the old key is cleared. Writes v2 format directly. Safe to run repeatedly; no-ops once migration is done.
  2. `migrateV1ToV2()` — v1' (post-rename, pre-v2) → v2. Runs in `loadState` and the settings `useEffect`. Collects moves from `trigger.items` and top-level moves into the global library, creates `attachedMoveIds`, persists the v2 form. Safe to run repeatedly.
- `editingIdRef` in the settings page is a deliberate stale-closure guard for blur/Enter handlers. Do not "simplify" it away.
- Bump `version:` in the yml for user-visible releases; the git hash is appended automatically by the build.

## MosaicFilter

- **Two UIs, one config key** `"MosaicFilter"`. State shape (flat object, no per-scene storage — all scenes share the same values): `{ blurAmount, widthPct, heightPct, xPct, yPct, active, follow, shape, mode }`. Percentages are of the player so the rectangle scales on resize.
- **Overlay** (`MosaicFilter.js`, vanilla JS) mounts on `#VideoJsPlayer` via `csLib.PathElementListener("/scenes/", ...)` plus a `stash:location` safety-net re-injection. **Settings** (`MosaicFilterSettings.js`, React) registers `/plugins/mosaicfilter` (lowercase, hardcoded) via `PluginApi.patch.before` and a Scene-Tools-only launcher card (even-call counter on `SettingsToolsSection` — same pattern as QuestingAdventurer; do not remove the counter).
- **Legacy shape migration**: versions ≤ 0.2.x stored `{ defaults: {...}, scenes: { [id]: {...} } }`. On load, `defaults` is used as the flat config and `scenes` is ignored; the next save writes the flat shape. `mergeStored` iterates `Object.keys(FALLBACK_DEFAULTS)` so new fields (e.g. `shape`, `mode`) are safe to add — missing keys fall back to defaults, and `sanitizeState` coerces unknown values.
- **Write policy — never persist per animation frame.** `csLib.setConfiguration` is called only at user-driven boundaries: toggle buttons (immediate), drag/resize end `pointerup`/`pointercancel` (immediate), blur slider `change` event (slider release — the `input` event updates the visual `--mf-blur` only and must NOT save), and a best-effort `pagehide` write. Follow-cursor position updates are in-memory only.
- **Follow-cursor mode**: when `state.follow` is on, a player-level `pointermove` re-centers the rectangle on the cursor; rectangle drag is disabled (resize still works). Toggling Follow on calls `snapRectToPointer()` so the rectangle jumps to the last recorded cursor position immediately (no lag from the saved location).
- **`shape`** (`'rectangle'` | `'ellipse'`) toggles `.mosaic-filter-rectangle--ellipse` (`border-radius: 50%`). **`mode`** (`'normal'` | `'reverse'`) transfers the blur to a sibling `.mosaic-filter-mask-layer` that blurs everything EXCEPT the filter area (the rectangle stays clear).
- **Reverse-mode hole is cut with `clip-path: path()`** built in JS by `updateMask()`. The path uses TWO subpaths separated by `Z M`: an outer clockwise player rect + an inner counter-clockwise hole (rectangle bounding box, or two half-ellipse arcs for ellipse). Under the nonzero fill rule, clockwise-outer + counter-clockwise-inner = frame with a hole. Do NOT switch back to `clip-path: polygon()` (pre-0.4.2 L-shape self-intersection bug) or `mask-image` + `mask-composite: subtract` (pre-0.4.2 ellipse invisible-mask bug — inconsistent browser support made the mask fully transparent).
- **Bar collapse**: `barCollapsed` is module-level so re-renders don't silently re-expand the controls. On every fresh mount (after `teardown`, e.g. navigating to a new scene), `setupPanel` re-derives `barCollapsed = !state.active` after `loadState` — opening a scene with mosaic off starts with the bar collapsed.
- **z-order**: mask layer `z-index: 7`, rectangle `z-index: 8` (so the rectangle's drag/resize handlers still work in reverse mode). Mask layer has `pointer-events: none` so clicks pass through to video controls.
- Same cross-surface race caveat as QuestingAdventurer: overlay and settings maintain separate save locks and do not coordinate; last writer wins the whole config map. Settings edits won't live-reflect in an already-open overlay until next navigation/reload.
- `csLib.getConfiguration`/`setConfiguration` are BOTH `async` — always `await` them (same silent failure mode as QuestingAdventurer).
- Bump `version:` in the yml for user-visible releases; the git hash is appended automatically by the build. Tracking issue: [issue #1](https://github.com/stashalizer/stashapp-plugins-vault/issues/1) (closed) — historical reference via `Refs #1` / `Fixes #1`.

## SceneVersions

- **No config key, no csLib dependency.** Data lives in each scene's `custom_fields` under key `"RelatedScenes"` (array of scene ID strings). No plugin-level config, so no cross-surface race (unlike QuestingAdventurer/MosaicFilter).
- **Bidirectional links**: when scene A lists B, B also lists A. `syncBidirectional` writes both sides on every link/unlink using `custom_fields: { partial: { RelatedScenes: [...] } }` to avoid clobbering other custom fields. Self-links filtered at every step.
- **Tab-only React plugin** (no player overlay, no `csLib.PathElementListener`, no SPA re-injection). Single component `RelatedScenesTab` injected via `PluginApi.patch.before` on `"ScenePage.Tabs"` (Nav link, `eventKey: "scene-versions-panel"`, inserted after the Details tab) and `"ScenePage.TabContent"` (Tab.Pane).
- **Apollo client for all data**: `libraries.Apollo.client.query` for reads (`FindSceneDocument`, `FindScenesDocument`), `libraries.Apollo.client.mutate` for writes (`SceneUpdateDocument`). No `csLib.getConfiguration`/`setConfiguration`.
- **SceneIDSelect picker** with `isMulti` + `excludeIds={[scene.id]}` to prevent self-links; `extraCriteria` restricts the dropdown to the current scene's folder via a path `INCLUDES` criterion (`makeFolderCriterion`).
- **Suggest-from-folder helper**: `GQL.FindScenesDocument` with `scene_filter.path { modifier: "INCLUDES" }` queries other scenes in the same folder; "Add" button appends to `relatedIds` without saving (non-destructive). Rendered only when suggestions exist.
- **patch.before error return shape**: handlers return `[props]` (pass-through) on error so the scene page doesn't break. Do NOT change to `[]` (zero args → original component called with `props=undefined` → breaks the whole scene page).
- **`fetchPolicy: "no-cache"`** on all Apollo queries so stale cache doesn't hide bidirectional writes.
- **No migrations** (new plugin, no legacy data).
- **No settings page, no route injection** — tab injection only.
- Bump `version:` in the yml for user-visible releases; the git hash is appended automatically by the build. No tracking issue at this time.

## AudioSupport

- **Audio-as-scene hack.** Stash v0.31.1 has no native audio support — the scanner rejects audio extensions, there is no Audio content type, and the `VideoFile` schema is video-shaped (`width: Int!`, `height: Int!`, `video_codec: String!` are non-nullable). The plugin works around this by having the user add audio extensions (mp3, flac, m4a, ogg, opus, wav) to the `VideoExtensions` config via the Setup wizard. Audio files are then ingested as scenes with `VideoFile{Width:0, Height:0, VideoCodec:""}`. GraphQL serves these without error. Designed to migrate to the native Audio type once [PR #6824](https://github.com/stashapp/stash/pull/6824) lands.
- **Two UIs, two config keys.** Main config key `"AudioSupport"` (csLib): overlay-owned `{ collapsed, opacity, panelPos, playbackRate, loop, volume, lyricsVisible }`; settings-owned `{ audioTagName, showNavEntry }`. Queue state is isolated in a SEPARATE config key `"AudioSupportQueue"`: `{ queue: [sceneId, ...], currentIndex: number, repeat: "off" | "all" | "one" }` — this avoids the cross-surface race wiping queue state when the settings page saves.
- **Cross-surface race — mitigated, not eliminated.** Overlay and settings share the `"AudioSupport"` key with separate save locks (same pattern as QuestingAdventurer/MosaicFilter). `normalizeConfig` in both surfaces preserves all keys via `Object.assign({}, stored, { validated overrides })` so neither surface wipes the other's fields. The overlay's `saveNow` reads-then-merges. Settings edits still won't live-reflect in an already-open overlay until the next navigation/reload.
- **Direct stream playback ONLY.** All transcode endpoints fail for audio-only input. The overlay loads `/scene/{id}/stream` (which is `http.ServeFile`, no ffmpeg) into an HTML5 `<audio>` element. Never wire transcode URLs.
- **`patch.instead("ScenePlayer", ...)`** intercepts the React ScenePlayer at script load. For audio-only scenes (detected via `video_codec === ""` or `width === 0`), it returns a `<div id="AudioSupportMount">` instead of the video.js player — video.js never initializes. Then `csLib.PathElementListener("/scenes/", "#AudioSupportMount", setupPanel)` plus a `stash:location` safety-net re-injects on SPA navigation.
- **LRC synced lyrics** (overlay): manual upload/paste only — the Goja backend VM has NO file I/O (sandboxed to `input`, `log`, `util.Sleep`, `gql.Do`, `console`; no `os`/`fs`/`readFile`), so the hook cannot auto-read `.lrc` sibling files. Lyrics are stored in `custom_fields.AudioLyrics` as raw LRC text. The parser supports `[mm:ss.xx]` timestamps and `[offset: +N]` (ADD N ms to timestamps, not subtract — fixed in ora-1 remediation). Synced highlight + auto-scroll + click-to-seek. The `lyricsVisible` config flag toggles the panel.
- **AudioMeta extraction** (hook): `writeAudioMeta()` in `AudioSupportHook.js` writes `{ audio_codec, bit_rate, duration }` as a JSON string to `custom_fields.AudioMeta` (custom_fields is scalar-only — objects must be JSON-stringified). Runs on both `Scene.Create.Post` and `tagAll`.
- **Backend Goja JS VM is sandboxed and ES5.1 only.** `AudioSupportHook.js` runs in the Stash server, NOT the browser. Only globals: `input`, `log`, `util.Sleep`, `gql.Do`, `console`. No arrow functions, no `const`/`let`, no template literals, no `async`/`await`, no Promises. Do not add browser-only APIs.
- **Queue + auto-advance + prev/next** (overlay): on `<audio>` `ended`, the overlay navigates to the next scene in the queue via `window.history.pushState` + `window.dispatchEvent(new PopStateEvent("popstate"))` (triggers Stash SPA router without full reload). Repeat modes: off (stop at end), all (loop queue), one (loop current track). Prev/next buttons + queue indicator (`N / M`) in the transport bar. Keyboard shortcuts: `n` (next), `p` (prev), `r` (repeat cycle).
- **`sceneInQueue` flag**: module-level boolean in `AudioSupport.js`. When the user navigates to a scene that is NOT in the current queue, prev/next buttons and the queue indicator are hidden, but the queue state is preserved so the user can resume by navigating back to a queued scene. Added in ora-2 remediation — do not remove.
- **Nav entry via `MainNavBar.MenuItems` patch** (settings): `PluginApi.patch.before("MainNavBar.MenuItems", ...)` injects an "Audio" nav link. Toggleable via `showNavEntry` config (default true). The label is `♫ Audio` (music note + space + word — the space was added in 0.6.2 to match native nav items' icon-text spacing). A module-level `navEntryEnabled` flag (updated from config) gates rendering.
- **Browse page** (settings): three sub-views under the Browse tab — **By Work** (groups by parent directory, natural-sort chapters, "Play Work" queues all chapters), **All Audio** (flat grid with search/sort, "Play All" queues filtered list), **By Tag** (tag cards → scene grid, "Play All" queues tag's scenes). Plus Setup (wizard + nav toggle) and Covers (extract embedded via jsmediatags CDN — MP3/ID3v2, FLAC, M4A supported; OGG/Opus NOT supported; generate default gradient covers via canvas).
- **Cover art**: `SceneUpdate(cover_image: "data:image/png;base64,...")` stored as a DB blob. Use server-side `is_missing: "cover"` filter for detection (`scenes.cover_blob IS NULL` — `paths.screenshot` is always a non-empty URL so cannot be used client-side).
- `csLib.getConfiguration`/`setConfiguration` are BOTH `async` — always `await` them (same silent failure mode as QuestingAdventurer/MosaicFilter: treating a Promise as a plain object causes "data disappears after refresh").
- **No migrations** (new plugin, no legacy data).
- Bump `version:` in the yml for user-visible releases; the git hash is appended automatically by the build. No tracking issue at this time.

## Conventions

- One plugin per directory. No cross-plugin imports.
- Vanilla JS for player overlays (matches CommunityScriptsUI library conventions); reach for React only when you need to register routes via `PluginApi.patch.before`.
- License: **AGPL-3.0** (`LICENCE`). New plugin code must remain AGPL-3.0 compatible.

## Git commits

This project follows the global Conventional Commits spec at
`~/.config/opencode/AGENTS.md` (modeled after
[anomalyco/opencode `dev`](https://github.com/anomalyco/opencode/commits/dev/)).
The format, type list, subject rules, body guidance, version-bump rule,
and issue-reference rule are defined there.

### Project-specific scopes

Omit the scope for cross-cutting changes. When the change targets one area,
use a top-level component name:

- `QuestingAdventurer` — the QuestingAdventurer plugin
- `MosaicFilter` — the MosaicFilter plugin
- `SceneVersions` — the SceneVersions plugin
- `AudioSupport` — the AudioSupport plugin
- `manifest` — `*.yml` plugin manifests
- `site` — `build_site.sh`, `index.yml`, GitHub Pages publish
- `ci` — `.github/workflows/`
- `codemap` — `codemap.md` and per-folder codemaps

### Version bumping in this project

This project ships versioned Stash plugins. **Every commit that changes a
plugin's user-visible behavior MUST bump the `version:` field in the
affected plugin's `*.yml`** (follow the global Version-bumping rule):

- Small fix → patch bump (e.g. `0.1.0` → `0.1.1`)
- Small feature → minor bump (e.g. `0.1.0` → `0.2.0`)
- Breaking change → major bump (e.g. `0.1.0` → `1.0.0`)

`build_site.sh` appends `<ymlVersion>-<gitShortHash>` to produce the
published version, so editing the yml is the only manual step. State the
bump in the commit body (e.g. `Bump version to 0.2.1 (small fix)`) so the
release history is self-documenting.

### Plugin → issue associations

Commits that change a plugin should reference that plugin's tracking issue
in the commit body using the global Issue-references rule (`Refs #N` or
`Fixes #N`):

- `QuestingAdventurer` — no tracking issue at this time
- `MosaicFilter` — [issue #1: Mosaic Filter](https://github.com/stashalizer/stashapp-plugins-vault/issues/1) (closed)
- `SceneVersions` — no tracking issue at this time
- `AudioSupport` — no tracking issue at this time

### Codemap sync

Codemaps are **living docs**, not generated artifacts — there is no
auto-regeneration step. When you change code, you MUST hand-update the
relevant codemap(s) in the same change set so the maps stay accurate for
the next task (the workflow requires reading `codemap.md` before
starting work, so a stale map misleads every subsequent agent).

**Trigger rules:**

| Change | Codemap update required |
|--------|-------------------------|
| `plugins/<PluginId>/*.js` / `*.css` / `*.yml` user-visible behavior (data model, control flow, UI, persistence, migrations) | Update `plugins/<PluginId>/codemap.md` (Data Model, Data & Control Flow, Files, version number). If the plugin's responsibility summary shifts, also update `plugins/codemap.md` and the top-level `codemap.md` directory table. |
| Plugin directory structure change (add / rename / delete files or subdirectories) | Update the plugin codemap's Files section and the top-level `codemap.md` directory table. |
| `build_site.sh`, `.github/workflows/`, `docs/`, README, or other non-plugin files | No codemap update — use `site` / `ci` / `docs` scope. |

**Version numbers in codemaps:** the Files section of each plugin codemap
records the current `version:` from the yml. When you bump the yml
version (per the Version-bumping rule above), also update that line in
the codemap so the two stay in sync.

**Committing:** the codemap sync may be folded into the feature/fix
commit or split into a separate `chore(codemap): ...` commit. Either is
acceptable; a separate commit keeps the diff reviewable when the map
rewrite is large. Examples of both forms appear in the Examples list
below.

**Publish note:** codemap files live outside `plugins/**`, so a
codemap-only commit does NOT trigger the deploy workflow and does NOT
publish a new plugin version. Publishing is driven solely by the yml
`version:` bump on a `plugins/**` change — the codemap sync is a
documentation concern, separate from the release.

### Examples

- `feat(QuestingAdventurer): support drag-to-reorder triggers and moves`
- `fix(QuestingAdventurer): preserve overlay collapsed state across settings save`
- `chore(codemap): regenerate after QuestingAdventurer v2 data model`
- `build: tighten plugins/** paths filter in deploy workflow`
- `chore(codemap): regenerate after QuestingAdventurer rename`
- `revert(QuestingAdventurer): drop the experimental node drag handler`
- `feat(MosaicFilter): add follow-cursor mode for the rectangle`
- `fix(MosaicFilter): stop writing config per pointermove during follow`
- `feat(SceneVersions): add suggest-from-folder helper`
- `feat(AudioSupport): add play queue with auto-advance and prev/next`
- `fix(AudioSupport): remove invalid settings field from ui config`

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/stashapp__stash/` - `stashapp/stash` at `v0.31.1`; Stash server source for the plugin API surface, GraphQL schema, and UI plugin injection points that the vault's plugins integrate against.
