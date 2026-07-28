# AudioSupport plugin

## Responsibility
Adds audio file support to Stash via the audio-as-scene path: a setup wizard that enables audio ingestion, an audio player overlay using direct-stream playback, and an audio browse/settings page. Designed to migrate to the native Audio type once PR #6824 lands.

## Files
- `AudioSupport.yml` — plugin manifest (name, description, version 0.4.1, `interface: js`, `exec: AudioSupportHook.js`, `hooks: Scene.Create.Post`, `tasks: tagAll`, `ui.requires: CommunityScriptsUILibrary`, JS/CSS assets).
- `AudioSupport.js` — vanilla-JS player overlay. Registers `PluginApi.patch.instead("ScenePlayer", ...)` at script load to replace video.js with a mount div (`#AudioSupportMount`) for audio-only scenes. Detects audio-only scenes via GraphQL (`video_codec === ""` or `width === 0`), renders an HTML5 `<audio>` element loading the direct stream (`scene.paths.stream` or `/scene/{id}/stream`). The overlay now fills the entire `#AudioSupportMount` player area with a centered, full-size cover art + metadata + transport layout instead of a small floating top-right panel. Supports playback speed (0.5x–2x), loop toggle, keyboard shortcuts (Space/Arrows/m/l), and volume persistence.
- `AudioSupportHook.js` — backend Goja JS hook script (runs in Stash server, NOT browser). Handles `Scene.Create.Post` (auto-tags audio-only scenes during scan) and `tagAll` manual task (tags all existing audio scenes). Uses `gql.Do()` for GraphQL, `log.Info()` for logging. ES5.1 only (no arrow functions, no Promise).
- `AudioSupportSettings.js` — React settings page registered at `/plugins/audiosupport`. Includes a setup wizard, audio browse view (search/sort/responsive card grid), and cover generator (ID3 embedded extraction via jsmediatags + default canvas covers).
- `AudioSupport.css` — full-area overlay styles: the overlay fills the mount with `inset: 0`, the panel centers cover art and controls, and the collapsed state renders a small, draggable chip in the top-right corner.
- `AudioSupportSettings.css` — settings page styles (scene card grid, cover option cards, search/sort controls).

## Data model
- Plugin config key: `"AudioSupport"` (csLib). State shape: `{ collapsed, opacity, panelPos, audioTagName, playbackRate, loop, volume }`.
- `panelPos` is now used only for positioning the collapsed chip (`top`/`right`). The expanded overlay fills the mount div via CSS and does not use inline panel positioning.
- Audio metadata lives on the scene (tags + `custom_fields.AudioMeta`), NOT in plugin config, to ease Phase B migration to the native Audio type.
- Audio detection: primary file `video_codec === ""` (equivalently `width === 0`).

## Control flow
1. On script load, `AudioSupport.js` registers `PluginApi.patch.instead("ScenePlayer", ...)` to intercept the React ScenePlayer component. For audio-only scenes, it returns a `<div id="AudioSupportMount">` instead of the video.js player — video.js never initializes. Then registers `csLib.PathElementListener("/scenes/", "#AudioSupportMount", setupPanel)` plus a `stash:location` safety net.
2. `setupPanel` parses the scene id from the URL, queries `FindSceneDocument`, and checks whether the scene is audio-only.
3. If audio-only: render the audio overlay as a full-area player inside `#AudioSupportMount`. The overlay spans the mount, centers the cover art, metadata, and transport controls, and uses `--as-bg-alpha` to control the background opacity of the whole player area.
4. The `<audio>` element loads the direct stream exclusively; transcode endpoints are never used.
5. Overlay interactions (collapse, opacity slider, collapsed-chip drag, playback speed, loop toggle, volume slider, keyboard shortcuts) save to csLib at user-driven boundaries (`change` for sliders, drag end, collapse toggle, shortcut action, `pagehide`).
6. `AudioSupportHook.js` runs in the Stash server's Goja JS VM (not browser). On `Scene.Create.Post` (fires during scan — `pkg/scene/scan.go:123`), it queries the new scene, checks `video_codec === ""` or `width === 0`, finds/creates the "Audio" tag via `allTags`/`tagCreate`, and appends the tag id via `sceneUpdate(tag_ids: [...existing, audioTagId])`. The `tagAll` manual task paginates all scenes and applies the same logic.
7. `AudioSupportSettings.js` registers `/plugins/audiosupport` and a Scene Tools launcher card.
8. Settings page tabs:
   - Setup: read `ConfigurationDocument`, show missing audio extensions, enable ingestion via `ConfigureGeneralDocument` with confirmation diff; create audio tag via `TagCreateDocument`.
   - Audio Library: query audio-tagged scenes via `FindScenesDocument` with `tags INCLUDES`; client-side search (debounced 200ms) and sort (title/date/duration); responsive card grid with cover thumbnails.
   - Generate Covers: two options — (a) Extract Embedded Covers: lazy-loads jsmediatags from CDN, fetches `/scene/{id}/stream`, parses ID3/FLAC/M4A embedded art, uploads via `SceneUpdateDocument(cover_image: dataUrl)`; (b) Generate default covers: query audio-tagged scenes missing a cover blob via `FindScenesDocument` with `is_missing: "cover"` (server-side `scenes.cover_blob IS NULL` check — `paths.screenshot` is always a non-empty URL so cannot be used client-side), render a canvas gradient/music-note cover, and upload via `SceneUpdateDocument(cover_image: dataUrl)`.

## Dependencies
- `window.csLib` (CommunityScriptsUILibrary) — required by the overlay.
- `window.PluginApi` (React, ReactRouterDOM, GQL documents, `utils.StashService.getClient()`).
