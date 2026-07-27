# AudioSupport plugin

## Responsibility
Adds audio file support to Stash via the audio-as-scene path: a setup wizard that enables audio ingestion, an audio player overlay using direct-stream playback, and an audio browse/settings page. Designed to migrate to the native Audio type once PR #6824 lands.

## Files
- `AudioSupport.yml` — plugin manifest (name, description, version 0.1.1, `ui.requires: CommunityScriptsUILibrary`, JS/CSS assets).
- `AudioSupport.js` — vanilla-JS player overlay. Detects audio-only scenes via GraphQL (`video_codec === ""` or `width === 0`), hides the broken video.js UI, and renders an HTML5 `<audio>` element loading the direct stream (`scene.paths.stream` or `/scene/{id}/stream`).
- `AudioSupportSettings.js` — React settings page registered at `/plugins/audiosupport`. Includes a setup wizard, audio browse view, and default-cover generator.
- `AudioSupport.css` — overlay styles.
- `AudioSupportSettings.css` — settings page styles.

## Data model
- Plugin config key: `"AudioSupport"` (csLib). State shape: `{ collapsed, opacity, panelPos, audioTagName }`.
- Audio metadata lives on the scene (tags + `custom_fields.AudioMeta`), NOT in plugin config, to ease Phase B migration to the native Audio type.
- Audio detection: primary file `video_codec === ""` (equivalently `width === 0`).

## Control flow
1. On script load, `AudioSupport.js` registers `csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel)` plus a `stash:location` safety net.
2. `setupPanel` parses the scene id from the URL, queries `FindSceneDocument`, and checks whether the scene is audio-only.
3. If audio-only: hide the video player and render the audio overlay (cover art, metadata, transport controls, volume).
4. The `<audio>` element loads the direct stream exclusively; transcode endpoints are never used.
5. Overlay interactions (collapse, opacity slider, drag) save to csLib at user-driven boundaries (`change` for the slider, drag end, collapse toggle, `pagehide`).
6. `AudioSupportSettings.js` registers `/plugins/audiosupport` and a Scene Tools launcher card.
7. Settings page tabs:
   - Setup: read `ConfigurationDocument`, show missing audio extensions, enable ingestion via `ConfigureGeneralDocument` with confirmation diff; create audio tag via `TagCreateDocument`.
   - Audio Library: query audio-tagged scenes via `FindScenesDocument` with `tags INCLUDES`.
   - Generate Covers: query audio-tagged scenes missing a cover blob via `FindScenesDocument` with `is_missing: "cover"` (server-side `scenes.cover_blob IS NULL` check — `paths.screenshot` is always a non-empty URL so cannot be used client-side), render a canvas gradient/music-note cover, and upload via `SceneUpdateDocument(cover_image: dataUrl)`.

## Dependencies
- `window.csLib` (CommunityScriptsUILibrary) — required by the overlay.
- `window.PluginApi` (React, ReactRouterDOM, GQL documents, `utils.StashService.getClient()`).
