# AGENTS.md — stashapp-plugins-vault

A Stash plugin source-index repository: zips each `plugins/<PluginId>/` directory and publishes `index.yml` to GitHub Pages. Built on the official [CommunityScripts](https://github.com/stashapp/CommunityScripts) template. Currently ships one plugin, **SceneRules**.

## Repository map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md` (`plugins/codemap.md`, `plugins/SceneRules/codemap.md`).

## Layout

```
plugins/<PluginId>/
  <PluginId>.yml            # manifest: name, description, version, ui.requires/javascript/css
  <PluginId>.js             # player overlay (vanilla JS, uses window.csLib)
  <PluginId>Settings.js     # optional full-page settings UI (React via window.PluginApi)
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
- **Dependencies are read from a comment line, not from `ui.requires`.** Keep `# requires: PluginA, PluginB` (comma-separated) at the bottom of the yml in sync with `ui.requires`. See `SceneRules.yml:7,14`. The two locations must agree.
- `ui.javascript` / `ui.css` entries are paths relative to the plugin directory.
- **Runtime globals are not bundled.** The plugin expects `window.csLib` and `window.PluginApi` to be provided by Stash; users must install **CommunityScriptsUILibrary** first (declared in `ui.requires`).

## SceneRules (the only plugin today)

- **Two UIs, one config key** `"SceneRules"`. State shape: `{ rules: Node[], collapsed: boolean }`. `Node` is `{type:"rule",id,text}` or `{type:"category",id,name,items:Rule[]}`. Top-level nodes are rules or categories; categories contain only leaf rules.
- The **overlay** mutates state in place then re-renders; the **settings page** uses React with immutable updates. They share a config key but each owns different fields semantically (settings owns `rules`, overlay owns `collapsed`), and each save re-reads stored config to preserve the other's field.
- Each surface has its own `saving`/`pendingSave` save lock. **They do not coordinate across components** — concurrent writes race and last writer wins the whole config map. Settings edits will not live-reflect in an already-open overlay until the next navigation or reload.
- Overlay re-injects on the `stash:location` SPA event via `csLib.PathElementListener`; a brief flash between React unmount and re-injection is expected (see the header comment in `SceneRules.js`).
- The settings page is registered through `PluginApi.patch.before`:
  - `PluginRoutes` → `<Route path="/plugins/scenerules" />` (lowercase plugin id, hardcoded — update if you rename the plugin)
  - `SettingsToolsSection` → launcher card linking to the same path
- `editingIdRef` in the settings page is a deliberate stale-closure guard for blur/Enter handlers. Do not "simplify" it away.
- Bump `version:` in the yml for user-visible releases; the git hash is appended automatically by the build.

## Conventions

- One plugin per directory. No cross-plugin imports.
- Vanilla JS for player overlays (matches CommunityScriptsUI library conventions); reach for React only when you need to register routes via `PluginApi.patch.before`.
- License: **AGPL-3.0** (`LICENCE`). New plugin code must remain AGPL-3.0 compatible.
