# AGENTS.md — stashapp-plugins-vault

A Stash plugin source-index repository: zips each `plugins/<PluginId>/` directory and publishes `index.yml` to GitHub Pages. Built on the official [CommunityScripts](https://github.com/stashapp/CommunityScripts) template. Currently ships one plugin, **QuestingAdventurer**.

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

For deep work on a specific folder, also read that folder's `codemap.md` (`plugins/codemap.md`, `plugins/QuestingAdventurer/codemap.md`).

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
- `_site/` is generated and gitignored — never commit it.

## Plugin manifest gotchas

- **Plugin id = directory name = yml basename.** Renaming the directory means renaming the yml and the asset list inside it.
- `build_site.sh` parses the yml with `grep -E '^(name|description|version):'`. The published `version` becomes `<ymlVersion>-<gitShortHash>` in `index.yml`.
- **Dependencies are read from a comment line, not from `ui.requires`.** Keep `# requires: PluginA, PluginB` (comma-separated) at the bottom of the yml in sync with `ui.requires`. See `QuestingAdventurer.yml:7,14`. The two locations must agree.
- `ui.javascript` / `ui.css` entries are paths relative to the plugin directory.
- **Runtime globals are not bundled.** The plugin expects `window.csLib` and `window.PluginApi` to be provided by Stash; users must install **CommunityScriptsUILibrary** first (declared in `ui.requires`).

## QuestingAdventurer (the only plugin today)

- **Two UIs, one config key** `"QuestingAdventurer"`. State shape: `{ moves: [{id,text}], triggers: [{id,name,active,attachedMoveIds}], collapsed, opacity, panelPos, locked, showAddControls }`.
- **v2 data model**: moves are a global library (`moves: [{id,text}]`); triggers reference moves by id via `attachedMoveIds: [string]`. The `active` flag lives on the **trigger**, not the move. A trigger with no attached moves is `active: false` by design.
- **Penalty / Reward** (overlay header buttons):
  - **Penalty** picks a random **inactive** trigger → activates it AND attaches a random **unattached** move from the library. If every trigger is already active, it picks a random active trigger and just attaches a move. If the library has no unattached moves, the trigger is still activated (no-op for the move part).
  - **Reward** picks a random **active** trigger that still has attached moves → removes a random attached move. If the trigger ends with zero attached moves, it is set `active: false`.
- **Overlay shows only active triggers** and their attached moves (resolved from the global library by id). The chip shows `🗺️ Triggers (N)` where N is the number of active triggers.
- **Dynamic default collapsed**: on first load (no stored `collapsed`), the overlay is expanded if there are active triggers and collapsed otherwise. After the user manually toggles, the stored value is used.
- **Header controls**: 🔒 lock button (`locked: bool` — hides row drag handles, disables panel drag, dims penalty/reward/opacity), ➕ add-toggle button (`showAddControls: bool` — reveals the Add Trigger / Add Move footer which is hidden by default), opacity slider (hover-reveal), ✕ close.
- The **overlay** mutates state in place then re-renders; the **settings page** uses React with immutable updates. They share a config key but each owns different fields semantically: the settings page owns `moves` and `triggers`; the overlay owns `collapsed`, `opacity`, `panelPos`, `locked`, `showAddControls`. Each save re-reads the stored config to preserve the other surface's fields.
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
- `MosaicFilter` — [issue #1: Mosaic Filter](https://github.com/stashalizer/stashapp-plugins-vault/issues/1)

### Examples

- `feat(QuestingAdventurer): support drag-to-reorder triggers and moves`
- `fix(QuestingAdventurer): preserve overlay collapsed state across settings save`
- `chore(codemap): regenerate after QuestingAdventurer v2 data model`
- `build: tighten plugins/** paths filter in deploy workflow`
- `chore(codemap): regenerate after QuestingAdventurer rename`
- `revert(QuestingAdventurer): drop the experimental node drag handler`
- `feat(MosaicFilter): add follow-cursor mode for the rectangle`
- `fix(MosaicFilter): stop writing config per pointermove during follow`
