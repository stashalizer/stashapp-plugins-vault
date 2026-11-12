# Stash Plugin Development — References

Durable reference links for plugin development on this repo. Keep this file
in sync with the official sources if URLs change.

## How to fetch these during development

Every source below was reachable from this repo's environment when checked on
2026-11-08. The patch targets and API shapes this repo depends on were
re-verified against the **v0.32.0** tag on the same date (see *Ready reckoner*
below). Three channels, in order of preference:

1. **GitHub connector (preferred for source).** Code search across repos and
   direct file reads return the raw file, with no HTML→markdown loss. Use it
   whenever the question is "does this patch target / function signature still
   exist".
2. **`raw.githubusercontent.com` (fallback).** Plain `curl -sL <url>` works for
   any file, so the docs stay usable even without the connector. Pipe to a temp
   file and read it rather than trying to skim it inline. This is the cheapest
   way to diff two tags:
   `curl -sL https://raw.githubusercontent.com/stashapp/stash/v0.32.0/<path>`.
3. **Web fetch on `docs.stashapp.cc` (concepts only).** The site is Docusaurus;
   pages convert to markdown cleanly. Good for *what a plugin is* and *what the
   UI API offers*, but it lags the source — it is not authoritative on exact
   component names or current signatures.

Caveats that cost real time:

- **Code search only indexes the default branch.** It is also literal about
  query terms. Start with the bare symbol (`PatchContainerComponent repo:stashapp/stash`)
  and narrow with `path:` only if the result set is noisy. A `path:` prefix that
  is even slightly off — e.g. `path:ui/v2.5/src/components/ScenePlayer` — returns
  zero hits and looks like the symbol is gone.
- **Component paths move between Stash minor versions.** The paths recorded in
  this file are for v2.5 and were last re-checked against v0.32.0. Treat them as
  lookups to re-verify, never bake them into plugin code or a build step.
- **Patchable component names have one authoritative list, and it lives in the
  source tree:** `ui/v2.5/src/docs/en/Manual/UIPluginApi.md` (shipped with Stash
  as the in-app plugin UI manual). It enumerates every name accepted by
  `PluginApi.patch.*` — read it instead of grepping for
  `PatchContainerComponent`. Note that container names created with
  `PatchContainerComponent("<Name>")` do **not** all appear in that list (e.g.
  `SettingsToolsSection` is missing from it), so fall back to code search when a
  name is not listed.
- **Reading source proves a symbol exists, not that an injection lands.**
  Whether `PluginApi.patch.after(...)` actually renders against the live DOM can
  only be confirmed by installing the plugin in a real Stash — this repo has no
  visual regression net (see `AGENTS.md`). The same goes for React 18: the
  component still mounts and the hooks still run, but only a live instance shows
  whether an injected node survives a concurrent re-render.

## Ready reckoner — what this repo depends on (verified at v0.32.0)

| Dependency | Where it is used | Status at v0.32.0 |
|---|---|---|
| `patch.instead("ScenePlayer", (props, ctx, next))` | AudioSupport | Unchanged. `runInstead` still calls `fns[0](props, ctx, next)`; `ScenePlayer` is still `PatchComponent("ScenePlayer", ...)` with the same props (`scene`, `hideScrubberOverride`, …) |
| `ScenePage.Tabs` / `ScenePage.TabContent` | SceneVersions | Unchanged. Children are still `Nav.Item > Nav.Link eventKey="scene-details-panel"` and `<Tab.Pane>`; `props.scene` is still passed |
| `SettingsToolsSection` | all three settings pages | Still a `PatchContainerComponent` instantiated **twice** in `SettingsToolsPanel.tsx` — the even-call counter still selects the Scene Tools section |
| `PluginRoutes`, `MainNavBar.MenuItems` | `PluginRoutes`: all three settings pages; `MainNavBar.MenuItems`: AudioSupport | Both in the patch list |
| `SceneIDSelect` (`isMulti`, `excludeIds`, `extraCriteria`) | SceneVersions | All three props still accepted (`excludeIds` / `extraCriteria` on `ExtraSceneProps`) |
| `#VideoJsPlayer` (`VIDEO_PLAYER_ID`) | MosaicFilter, QuestingAdventurer, AudioSupport (fallback) | `"VideoJsPlayer"`, unchanged |
| `utils.StashService.getClient()`, `libraries.Bootstrap`, `libraries.ReactRouterDOM` | SceneVersions, all settings pages | All exposed; React Router is still v5 |
| `SceneUpdateInput.cover_image`, `custom_fields.partial` | AudioSupport, SceneVersions | Unchanged (a `production_date` field was added, nothing removed) |
| `VideoFile.width/height/video_codec` non-nullable | AudioSupport | Still `Int!` / `Int!` / `String!` — the audio-as-scene workaround is still required |
| `ConfigureGeneral({ videoExtensions })` partial input | AudioSupport setup wizard | Unchanged; unaffected by the config fields v0.32.0 removed |
| `metadataGenerate(input: GenerateMetadataInput!)` | AudioSupport generate task | `sceneIDs: [ID!]` + `covers/sprites/previews/phashes/markers/transcodes` booleans. A nil `previewOptions` falls back to the stored config, so passing only `previews: true` respects the user's preview settings |
| `scene_filter.tags` (`HierarchicalMultiCriterionInput`) | AudioSupport generate task | `{ value: [tagId], modifier: "EXCLUDES" }` excludes scenes carrying that tag; still the way to scope a task to non-audio scenes |
| `runPluginTask(plugin_id, task_name, description, args_map)` | AudioSupport generate tab | `task_name` is optional; without it only `args_map` is sent. With it, `buildPluginInput` applies `defaultArgs` **only for keys the caller omitted**, so `args_map` always wins |
| `log.Progress(0..1)` in the Goja VM | AudioSupport generate task | Exposed alongside `Trace/Debug/Info/Warn/Error`; drives the job progress bar |

## Environment traps (verified 2026-11-12)

**ffmpeg 9 removed `-vsync`, and Stash still passes it.** Verified on a v0.32.0
install whose Stash directory carried ffmpeg 9.0.2: `task_generate_preview.go`
appends `-vsync 2` whenever the source framerate looks like VFR (including every
audio-only file, where the framerate is `0.000000`), and 9.0.2 answers
`Unrecognized option 'vsync' / Error splitting the argument list`, so preview
generation fails with exit 69. A 2026 master build that still accepts the
deprecated flag works. Upstream `develop` still passes `-vsync`, so this is not
fixed by upgrading Stash; pin an ffmpeg that accepts it (`ffmpegPath` in the
Stash config) or wait for Stash to move to `-fps_mode`. The AudioSupport generate
task cannot route around this: Stash builds the ffmpeg command, the plugin only
chooses which scenes are queued.

**Reading Stash's own log buffer over GraphQL.** `{ logs { time level message } }`
returns the most recent entries (about 30: level, timestamp, full ffmpeg stderr
and the wrapper line naming the input path). It is the fastest way to attribute a
generation failure to a specific file without asking the user for a log export —
the UI log view truncates the same entries. A corrupt input shows up as thousands
of `Invalid NAL unit size` lines from `h264`, all belonging to the handful of
shells decoding the same file; decoding the file directly (`ffmpeg -v error -i
<file> -f null -`) and counting those lines separates a broken file from a
broken command, and stream-copy remuxing will not repair it.

## React 18 (Stash UI ≥ v0.32.0)

The UI moved from React 17 to React 18. What that means for plugins:

- `PluginApi.React` is React 18. Hooks, `createElement`, `Fragment` — no change.
- `PluginApi.ReactDOM.render` still exists but is deprecated and mounts in React
  17 compatibility mode. Use `PluginApi.ReactDOMClient.createRoot(container)`
  for any new self-managed mount point.
- No plugin in this repo uses `ReactDOM`, class components, or `findDOMNode` —
  keep it that way. Patch functions receive plain props and return elements; that
  surface is unchanged.
- React 18 batches state updates inside promises and timeouts too. Settings
  pages that `await` a save and then `setState` are fine, but do not rely on a
  synchronous re-render between two `setState` calls in the same tick.
- New extension points added in v0.32.0, unused here: `SavedFilter.Loaded`,
  `FilterTags.Extras`, plus newly patchable `StudioPage`, `TagPage`, `GroupPage`,
  `SceneCreate`, `PerformerCreate`, the merge modals, and `SceneScrapeDialog`.

## Official Stash plugin documentation

- [Plugins overview](https://docs.stashapp.cc/in-app-manual/plugins/) —
  entry point for everything plugin-related.
- [External plugins](https://docs.stashapp.cc/in-app-manual/plugins/externalplugins/) —
  how plugins are packaged, distributed via source indexes, and installed
  from a Stash plugin source URL.
- [Embedded plugins](https://docs.stashapp.cc/in-app-manual/plugins/embeddedplugins/) —
  plugins that ship with Stash itself (different lifecycle from external
  plugins).
- [UI plugin API](https://docs.stashapp.cc/in-app-manual/plugins/uipluginapi/) —
  `window.PluginApi` patching hooks (`PluginRoutes`, `SettingsToolsSection`,
  `ScenePage.Tabs`, etc.), `React` access, `libraries.ReactRouterDOM`,
  the `Event` bus, and how to register settings page routes. Rendered from the
  in-repo `UIPluginApi.md`; if the two disagree, the source file wins (linked
  under *Stash source code* below).

## Community plugin repository

- [stashapp/CommunityScripts/plugins](https://github.com/stashapp/CommunityScripts/tree/main/plugins) —
  the canonical collection of community plugins. Useful for:
  - **Studying real-world usage** of `PluginApi.patch.before(...)` and
    `csLib` patterns.
  - **Finding the latest CommunityScriptsUILibrary** (see below) which
    is the de-facto runtime helper that most Stash plugins depend on.
  - **Discovering new patterns** for SPA integration, SPA-navigation
    handling, and React component injection.

## CommunityScriptsUILibrary (csLib)

The `csLib` global is provided by the
[CommunityScriptsUILibrary plugin](https://github.com/stashapp/CommunityScripts/tree/main/plugins/CommunityScriptsUILibrary)
and is the easiest way to persist per-plugin configuration, inject into
scene player pages, and listen for SPA navigation.

Key source file (the actual API surface — read this when debugging
`csLib` behavior):

- [cs-ui-lib.js](https://raw.githubusercontent.com/stashapp/CommunityScripts/main/plugins/CommunityScriptsUILibrary/cs-ui-lib.js)

### Notes on the csLib API

- **`csLib.getConfiguration(pluginId, fallback?)`** and
  **`csLib.setConfiguration(pluginId, values)`** are **both `async`**
  (always return Promises). Always `await` them. Treating a Promise as
  a plain object is a silent failure mode that surfaces as "data
  disappears after refresh".
- `setConfiguration` does a **full-replace** of the plugin's config
  map (the GraphQL `configurePlugin` mutation writes the whole `$input`
  as the new value). If you need to preserve fields owned by another
  surface, read-modify-write — don't write a partial object.
- The `csLib` object is exposed on `window` after the library plugin
  loads. Check for it before use; if a user installs your plugin
  without csLib first, every call will throw.
- `csLib.PathElementListener(pathPattern, selector, callback)` watches
  the SPA for the given path + element and invokes `callback` whenever
  the element appears. Pair it with a
  `window.PluginApi.Event.addEventListener("stash:location", ...)`
  safety net because React re-renders can remove the injected element
  between navigations.

## CSS gotchas for Stash overlays

`backdrop-filter` is the standard way to "blur a region of video" — the
plugin puts a transparent element over the player and the browser blurs
whatever is behind it. Inverting the effect (blur *everywhere except* a
region) requires stacking `backdrop-filter` with a clip-path or mask, and
the obvious approaches are fragile. Notes from real bugs:

- **`clip-path: polygon(...)` with 8+ points is self-intersecting.** A
  polygon with N points closes diagonally from the last point back to the
  first, so a naive "outer rect clockwise + inner rect counter-clockwise"
  polygon (intended as a frame with a hole) becomes a single self-
  intersecting path. Under the default `nonzero` fill rule, the L-shaped
  area outside the inner rect can land *outside* the clip, leaving that
  region unblurred. Use **`clip-path: path('…Z M …Z')` with TWO separate
  subpaths** (the `Z M` separator creates non-intersecting subpaths)
  instead, and add **`clip-rule: evenodd`** for direction-independent hole
  cutting. SVG `A` arc commands handle ellipses uniformly in the same
  path.

- **`mask-composite: subtract` / `-webkit-mask-composite: destination-out`
  has inconsistent browser support.** Some engines compute the composite
  as fully transparent, which makes the whole masked element invisible
  — so the `backdrop-filter` on it never applies at all. Don't use it
  for plugin overlays; prefer the `clip-path: path()` two-subpath
  approach above.

- **No visual regression net in this repo.** There's no local toolchain
  (no bundler, linter, typecheck, tests, or dev server — see
  `AGENTS.md`). Visual CSS changes ship unreviewed until a user installs
  the plugin in Stash. At minimum, manually install + reload Stash and
  verify the change against a real scene before tagging a release. The
  plugin's section in `AGENTS.md` is the right place to capture the
  specific fix history and the trap that made it necessary.

## Stash source code (for reference when the docs are thin)

- [stashapp/stash](https://github.com/stashapp/stash) — the main
  Stash repo. When the official docs are silent on a patch target or
  component name, the source is authoritative. Useful entry points:
  - [`ui/v2.5/src/docs/en/Manual/UIPluginApi.md`](https://raw.githubusercontent.com/stashapp/stash/v0.32.0/ui/v2.5/src/docs/en/Manual/UIPluginApi.md)
    — **start here for a patch target name.** This is the in-app plugin UI
    manual shipped with Stash and carries the canonical list of patchable
    component names, plus the `PluginApi` surface (`React`, `ReactDOM`,
    `ReactDOMClient`, `libraries`, `hooks`, `utils`). It is more complete and
    more current than the Docusaurus page. Some container names created with
    `PatchContainerComponent("<Name>")` are absent from it (e.g.
    `SettingsToolsSection`) — fall back to a code search for those.
  - `ui/v2.5/src/patch.tsx` — the patching system itself (`before` / `instead` /
    `after`, `PatchComponent`, `PatchContainerComponent`, `RegisterComponent`).
  - `ui/v2.5/src/pluginApi.tsx` — exactly what `window.PluginApi` exposes.
  - `ui/v2.5/src/components/Settings/SettingsToolsPanel.tsx` — the
    `SettingsToolsSection` `PatchContainerComponent` (instantiated
    twice: general "Tools" and "Scene Tools"; still true at v0.32.0).
  - `ui/v2.5/src/components/Scenes/SceneDetails/Scene.tsx` — the scene page, where
    `ScenePage.Tabs` / `ScenePage.TabContent` wrap the `Nav.Item` list and the
    `Tab.Pane` list (tab injection point for SceneVersions).
  - `ui/v2.5/src/components/ScenePlayer/ScenePlayer.tsx` and
    `ScenePlayer/util.ts` — the `ScenePlayer` patch target and
    `VIDEO_PLAYER_ID = "VideoJsPlayer"` (the overlay mount point).
  - **Other `PatchContainerComponent` sites**, from a code search for that
    symbol (not exhaustive — re-run the search when adding an injection point,
    or check `UIPluginApi.md` first):
    - `ui/v2.5/src/components/List/FilterTags.tsx`
    - `ui/v2.5/src/components/Tags/TagList.tsx`
    - `ui/v2.5/src/components/Groups/GroupList.tsx`
    - `ui/v2.5/src/components/Studios/StudioList.tsx`
    - `ui/v2.5/src/components/Scenes/SceneList.tsx`
    - `ui/v2.5/src/components/Scenes/SceneMarkerList.tsx`
  - `graphql/schema/` — the GraphQL schema (types, queries, mutations) as
    shipped in the repo. Read this before calling a mutation from a plugin, e.g.
    to confirm the exact shape of `configurePlugin`'s `$input`. A running
    instance also serves the GraphQL playground (introspection), which reflects
    the *installed* version rather than `main` — use it when the two disagree.
