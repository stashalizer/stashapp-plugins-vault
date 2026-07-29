# AudioSupport plugin

## Responsibility
Adds audio file support to Stash via the audio-as-scene path: a setup wizard that enables audio ingestion, an audio player overlay using direct-stream playback, and an audio browse/settings page. Designed to migrate to the native Audio type once PR #6824 lands.

## Files
- `AudioSupport.yml` — plugin manifest (name, description, version 0.6.2, `interface: js`, `exec: AudioSupportHook.js`, `hooks: Scene.Create.Post`, `tasks: tagAll`, `ui.requires: CommunityScriptsUILibrary`, JS/CSS assets).
- `AudioSupport.js` — vanilla-JS player overlay. Registers `PluginApi.patch.instead("ScenePlayer", ...)` at script load to replace video.js with a mount div (`#AudioSupportMount`) for audio-only scenes. Detects audio-only scenes via GraphQL (`video_codec === ""` or `width === 0`), renders an HTML5 `<audio>` element loading the direct stream (`scene.paths.stream` or `/scene/{id}/stream`). The overlay fills the entire `#AudioSupportMount` player area with a centered cover art + metadata + transport layout. Supports playback speed (0.5x–2x), loop toggle, repeat mode, prev/next track, auto-advance, keyboard shortcuts (Space/Arrows/m/l/k/n/p/r/MediaTrackNext/MediaTrackPrevious), volume persistence, and a synced LRC lyrics panel with load/edit, click-to-seek, and auto-scroll.
- `AudioSupportHook.js` — backend Goja JS hook script (runs in Stash server, NOT browser). Handles `Scene.Create.Post` (auto-tags audio-only scenes during scan) and `tagAll` manual task (tags all existing audio scenes). Uses `gql.Do()` for GraphQL, `log.Info()` for logging. ES5.1 only (no arrow functions, no Promise).
- `AudioSupportSettings.js` — React settings / browse page registered at `/plugins/audiosupport`. Adds a top-navigation entry via `PluginApi.patch.before("MainNavBar.MenuItems", ...)` (toggleable via `showNavEntry` config). Three top-level tabs: **Browse** (sub-views: By Work, All Audio, By Tag), **Setup** (wizard + nav toggle), and **Covers** (extract embedded + generate default covers).
- `AudioSupport.css` — full-area overlay styles: the overlay fills the mount with `inset: 0`, the panel centers cover art and controls, and the collapsed state renders a small, draggable chip in the top-right corner.
- `AudioSupportSettings.css` — settings page styles (tabs, sub-nav, work/tag cards, chapter list, scene card grid, cover option cards, search/sort controls).

## Data model
- Plugin config key: `"AudioSupport"` (csLib). Overlay-owned: `{ collapsed, opacity, panelPos, playbackRate, loop, volume, lyricsVisible }`; settings-owned: `{ audioTagName, showNavEntry }`.
- Separate queue config key: `"AudioSupportQueue"` (csLib). State shape: `{ queue: [sceneId, ...], currentIndex: number, repeat: "off" | "all" | "one" }`. Isolates queue state from the cross-surface race on the main config key.
- Scene lyrics are stored in `custom_fields.AudioLyrics` as raw LRC text. The overlay loads, parses, and saves synced LRC text per scene using Apollo; lyrics are not persisted in the plugin config.
- `panelPos` is now used only for positioning the collapsed chip (`top`/`right`). The expanded overlay fills the mount div via CSS and does not use inline panel positioning.
- Audio metadata lives on the scene (tags + `custom_fields.AudioMeta`), NOT in plugin config, to ease migration to the native Audio type.
- Audio detection: primary file `video_codec === ""` (equivalently `width === 0`).

## Control flow
1. On script load, `AudioSupport.js` registers `PluginApi.patch.instead("ScenePlayer", ...)` to intercept the React ScenePlayer component. For audio-only scenes, it returns a `<div id="AudioSupportMount">` instead of the video.js player — video.js never initializes. Then registers `csLib.PathElementListener("/scenes/", "#AudioSupportMount", setupPanel)` plus a `stash:location` safety net.
2. `setupPanel` parses the scene id from the URL, queries `FindSceneDocument`, and checks whether the scene is audio-only.
3. If audio-only: render the audio overlay as a full-area player inside `#AudioSupportMount`. The overlay spans the mount, centers the cover art, metadata, and transport controls, and uses `--as-bg-alpha` to control the background opacity of the whole player area.
4. The `<audio>` element loads the direct stream exclusively; transcode endpoints are never used.
5. Overlay interactions (collapse, opacity slider, collapsed-chip drag, playback speed, loop toggle, volume slider, repeat mode, prev/next track, keyboard shortcuts) save to csLib at user-driven boundaries (`change` for sliders, drag end, collapse toggle, shortcut action, track change, `pagehide`).
6. `AudioSupportHook.js` runs in the Stash server's Goja JS VM (not browser). On `Scene.Create.Post` (fires during scan — `pkg/scene/scan.go:123`), it queries the new scene, checks `video_codec === ""` or `width === 0`, finds/creates the "Audio" tag via `allTags`/`tagCreate`, and appends the tag id via `sceneUpdate(tag_ids: [...existing, audioTagId])`. The `tagAll` manual task paginates all scenes and applies the same logic.
7. `AudioSupportSettings.js` registers:
   - `/plugins/audiosupport` route via `PluginApi.patch.before("PluginRoutes", ...)`.
   - A Scene Tools launcher card via `PluginApi.patch.before("SettingsToolsSection", ...)` (second instance only).
   - A top-navigation entry via `PluginApi.patch.before("MainNavBar.MenuItems", ...)`. The item is injected at script load; a module-level `navEntryEnabled` flag (default `true`, updated from config) controls whether it is rendered. The toggle lives on the Setup tab.
8. Settings page tabs:
   - **Browse** (default): sub-nav with three views:
    - **By Work**: groups audio scenes by parent directory; each work card shows the first scene's cover, work name (directory basename), chapter count, and total duration. Clicking a work opens a chapter list sorted by natural filename order, with a "Play Work" button that writes the work's chapter IDs to `"AudioSupportQueue"` and navigates to the first chapter, plus a back button.
    - **All Audio**: flat card grid with search/sort and a "Play All" button that queues the currently filtered/sorted scenes and navigates to the first one.
    - **By Tag**: collects all tags on audio scenes, shows tag cards with scene counts; clicking a tag shows its scene grid with a "Play All" button that queues the tag's scenes and navigates to the first one, plus a back button. Each scene card has a play button that queues a single scene.
   - **Setup**: read `ConfigurationDocument`, show missing audio extensions, enable ingestion via `ConfigureGeneralDocument` with confirmation diff; create audio tag via `TagCreateDocument`; toggle `showNavEntry` to show/hide the top nav item.
   - **Covers**: two options — (a) Extract Embedded Covers: lazy-loads jsmediatags from CDN, fetches `/scene/{id}/stream`, parses ID3/FLAC/M4A embedded art, uploads via `SceneUpdateDocument(cover_image: dataUrl)`; (b) Generate default covers: query audio-tagged scenes missing a cover blob via `FindScenesDocument` with `is_missing: "cover"` (server-side `scenes.cover_blob IS NULL` check — `paths.screenshot` is always a non-empty URL so cannot be used client-side), render a canvas gradient/music-note cover, and upload via `SceneUpdateDocument(cover_image: dataUrl)`.

## Dependencies
- `window.csLib` (CommunityScriptsUILibrary) — required by the overlay and settings page persistence.
- `window.PluginApi` (React, ReactRouterDOM, Bootstrap, GQL documents, `utils.StashService.getClient()`).
