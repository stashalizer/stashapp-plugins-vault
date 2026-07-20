# Stash Plugin Development — References

Durable reference links for plugin development on this repo. Keep this file
in sync with the official sources if URLs change.

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

## Stash source code (for reference when the docs are thin)

- [stashapp/stash](https://github.com/stashapp/stash) — the main
  Stash repo. When the official docs are silent on a patch target or
  component name, the source is authoritative. Useful entry points:
  - `ui/v2.5/src/components/Settings/SettingsToolsPanel.tsx` — the
    `SettingsToolsSection` `PatchContainerComponent` (instantiated
    twice: general "Tools" and "Scene Tools").
  - `ui/v2.5/src/patch.tsx` — the patching system itself.
