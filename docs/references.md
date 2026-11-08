# Stash Plugin Development — References

Durable reference links for plugin development on this repo. Keep this file
in sync with the official sources if URLs change.

## How to fetch these during development

Every source below was reachable from this repo's environment when checked on
2026-11-08. Three channels, in order of preference:

1. **GitHub connector (preferred for source).** Code search across repos and
   direct file reads return the raw file, with no HTML→markdown loss. Use it
   whenever the question is "does this patch target / function signature still
   exist".
2. **`raw.githubusercontent.com` (fallback).** Plain `curl -sL <url>` works for
   any file, so the docs stay usable even without the connector. Pipe to a temp
   file and read it rather than trying to skim it inline.
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
  this file are for v2.5. Treat them as lookups to re-verify, never bake them
  into plugin code or a build step.
- **Reading source proves a symbol exists, not that an injection lands.**
  Whether `PluginApi.patch.after(...)` actually renders against the live DOM can
  only be confirmed by installing the plugin in a real Stash — this repo has no
  visual regression net (see `AGENTS.md`).

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
  the `Event` bus, and how to register settings page routes.

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
  - `ui/v2.5/src/patch.tsx` — the patching system itself.
  - `ui/v2.5/src/components/Settings/SettingsToolsPanel.tsx` — the
    `SettingsToolsSection` `PatchContainerComponent` (instantiated
    twice: general "Tools" and "Scene Tools").
  - **Other `PatchContainerComponent` sites**, from a code search for that
    symbol (not exhaustive — re-run the search when adding an injection point):
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
