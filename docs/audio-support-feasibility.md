# Stash Audio File Support — Feasibility Investigation

> Investigates whether the current Stash release (v0.31.1) supports audio file
> import, and assesses the necessity and feasibility of building a community
> plugin for audio support covering **scan ingestion**, **tag management**, and
> **audio playback**, including how Stash's built-in `scan` and `generate` tasks
> handle audio files.
>
> Evidence base: Stash v0.31.1 source (cloned at `.slim/clonedeps/repos/stashapp__stash/`)
> cross-validated against external research (GitHub issues, PRs, docs, community
> plugins). All source citations are `path:line` against that clone.

## TL;DR

1. **Stash v0.31.1 does not support audio files.** The scanner rejects audio
   extensions; there is no `Audio` content type; the `VideoFile` schema is
   video-shaped (non-nullable `width`/`height`/`video_codec`); the `generate`
   task pipeline (sprite, screenshot, preview, phash) assumes a video stream and
   silently breaks on audio-only input.
2. **A plugin is necessary.** Audio support has been the #1 most-requested
   feature since 2019 (issue #11, then #1258), driven by the GoneWildAudio /
   e-stim / audiobook communities. The only existing workaround
   (`audio-transcodes`) is a band-aid that wraps audio into a blank MP4.
3. **A plugin is possible but bounded.** The plugin API cannot add a content
   type, extend the GraphQL schema, or influence the scanner. It *can* patch
   the scene player, add routes, hook `Scene.Create.Post`, call GraphQL, and
   use csLib. The realistic shape is an **audio-as-scene enhancement** plugin,
   not a native audio type.
4. **The strategic factor is PR #6824.** A live backend PR adds a native
   `Audio` type (DB + GraphQL + scanner + streaming), but it is **UI-deferred**
   and not landing imminently. A plugin built today should (a) bridge the gap
   now via the audio-as-scene hack, and (b) be designed to become the **UI
   layer** for the native `Audio` type once #6824 lands — the plugin is
   complementary to the backend PR, not obsoleted by it.
5. **Recommendation: build it, scoped as a two-phase bridge plugin.** See
   §6–§7.

---

## 1. Current State: Does Stash v0.31.1 Support Audio?

### 1.1 Scan / ingestion — NO

The scanner uses hardcoded extension allowlists for three content types only:
video, image, and zip/gallery. There is no audio content type and no audio
extension in any default list.

- `internal/manager/config/config.go:313-315` —
  `defaultVideoExtensions` = `m4v, mp4, mov, wmv, avi, mpg, mpeg, rmvb, rm, flv, asf, mkv, webm, f4v`
  (no `mp3`, `flac`, `ogg`, `opus`, `m4a`, `wav`, `aac`).
- `internal/manager/manager_tasks.go:43-51` — `isVideo()` / `isImage()` route
  files by extension list.
- `internal/manager/task_scan.go:598-605` — files matching none of video/image/zip
  are rejected with "does not match any known file extensions".
- `internal/manager/config/config.go:61-63` — `VideoExtensions` /
  `ImageExtensions` / `GalleryExtensions` are user-configurable. A user *can*
  manually add `mp3` to `VideoExtensions`; this is the only ingestion path
  today, and it is an unsupported hack (see §5.3).

**Confidence: high.**

### 1.2 Generate task — BROKEN for audio-only

Every generate subtask that depends on a video stream fails or no-ops on an
audio-only file (which probes as `VideoFile{Width:0, Height:0, VideoCodec:""}`):

| Subtask | Failure point | Behavior on audio-only |
|---------|---------------|------------------------|
| Sprite | `internal/manager/generator_sprite.go:84-87` — requires `VideoStreamDuration > 0` | Error "duration/frame count invalid, skipping sprite creation" |
| Screenshot/cover | `internal/manager/task_generate_screenshot.go:67` — uses `videoFile.Width`/`Duration` | ffmpeg screenshot on audio fails (no video frames) |
| Preview | `internal/manager/task_generate_preview.go:43` — uses `VideoStreamDuration`/`FrameRate` | Fails or zero-length output |
| Phash | `pkg/hash/videophash/phash.go:79-103` — 25 screenshots | Fails (no frames) |
| Transcode | `internal/manager/task_transcode.go:49-56` — checks `VideoCodec`/`AudioCodec` | Attempts transcode; produces blank video (only subtask that "works") |

**v0.31.1 nuance (per Oracle review):** the historical issue #4109
`integer divide by zero` crash no longer occurs in v0.31.1 because
`pkg/ffmpeg/codec_hardware.go:440-443` (`hwMaxResFilter`) returns an empty
filter when `vf.Width == 0 || vf.Height == 0`. So the current failure mode is
**silent breakage** (empty video filter → broken/blank transcode, no sprite,
no preview), not a crash. The conclusion (generate is broken for audio) is
unchanged.

**Confidence: high.**

### 1.3 Schema / data model — NO Audio type

- `pkg/models/model_file.go:278-292` — `VideoFile` struct has `Width`, `Height`,
  `VideoCodec`, `FrameRate`, `AudioCodec`, `Duration`. No `AudioFile` type exists.
- `graphql/schema/types/file.graphql:70-98` — GraphQL `VideoFile` exposes
  `width: Int!`, `height: Int!`, `video_codec: String!`, `audio_codec: String!`,
  `frame_rate: Float!`, `bit_rate: Int!` — **all non-nullable**. An audio-only
  file (width=0, height=0, video_codec="") violates these `!` constraints.
- `graphql/schema/types/scene.graphql:39-80` — `Scene.files: [VideoFile!]!` —
  scenes can only have `VideoFile` children; there is no `AudioFile` alternative.
- No `Audio` type anywhere under `graphql/schema/types/`.

An audio-only file can be *stored* as a `VideoFile` with zeroed video fields at
the Go struct level, but the GraphQL layer's non-nullable fields make it a
schema-level violation to surface cleanly.

**Confidence: high.**

### 1.4 Playback / UI — PARTIAL

- `ui/v2.5/src/components/ScenePlayer/ScenePlayer.tsx:337-419` — video.js player.
  video.js *can* technically play audio-only sources, but the UI renders a
  `<video-js>` element and assumes video.
- `ScenePlayer.tsx:622-641` — stream sources come from `scene.sceneStreams`;
  mime types are all video (`video/mp4`, `video/webm`).
- `ui/v2.5/src/components/Scenes/SceneDetails/Scene.tsx:1034-1045` — scene page
  renders `ScenePlayer` and shows `paths.screenshot` as cover
  (`SceneEditPanel.tsx:198`, `QueueViewer.tsx:94`) — missing for audio.
- `ui/v2.5/src/components/Scenes/PreviewScrubber.tsx` — sprite VTT/image scrubber
  — empty for audio.
- `ui/v2.5/src/components/Scenes/SceneDetails/SceneFileInfoPanel.tsx:103-105` —
  displays `width x height` and `frame_rate` → `0 x 0` / `0 fps` for audio.
- `ui/v2.5/src/components/Scenes/SceneCard.tsx:77-88` — card preview missing/broken.

**Confidence: high.**

### 1.5 Tag management — WORKS (the one subsystem that's fine)

Tags are entity-agnostic. If an audio file becomes a scene, it can be tagged
like any scene.

- `pkg/models/model_tag.go:8-22` — no media-type-specific fields.
- `pkg/models/model_scene.go:42` — `TagIDs RelatedIDs`.
- `graphql/schema/types/scene.graphql:78` — `tags: [Tag!]!`.
- Tag UI under `ui/v2.5/src/components/Tags/` is generic across entity types.

**Confidence: high.**

---

## 2. Plugin API Capabilities & Limits for Audio

### What plugins CAN do
- Add UI routes: `PluginApi.register.route("/plugin/...", Component)`.
- Patch existing components: `PluginApi.patch.before/instead/after` (scene
  player, scene page, scene card, navbar `MenuItems`/`UtilityItems`, etc.).
- Inject custom CSS/JS; register React components for reuse.
- Hook existing events: `Scene.Create.Post`, `Scene.Update.Post`, etc.
  (`pkg/plugin/hook/hooks.go:13-14`; registered at `pkg/scene/scan.go:123` —
  fires for any new scene regardless of file type, including audio-as-scene).
- Use GraphQL via `PluginApi.GQL` / `PluginApi.libraries.Apollo` — including
  `ConfigureGeneral` (to set `VideoExtensions`), `SceneUpdate`, `TagCreate`,
  metadata queries.
- Add custom tasks (run from the Tasks page).
- Use csLib (CommunityScriptsUILibrary) for path listeners, config, SPA events.

### What plugins CANNOT do
- Register a new content type (no `register.contentType`).
- Add GraphQL queries/mutations (schema is server-side Go, compiled at build).
- Influence the scanner — scan pipeline is hardcoded
  (`internal/manager/manager_tasks.go:127-150`); no plugin hook for scan
  filtering or file-type routing.
- Add new hook trigger types (no `Audio.Create.Post` because `Audio` doesn't
  exist).
- Add top-level navbar items (though `MainNavBar.MenuItems`/`UtilityItems` are
  patchable).

**Confidence: high.**

---

## 3. External Context

### 3.1 Official stance & demand
- **Issue #1258** "Support audio files/object type" — open since April 2021,
  still active July 2026. Canonical tracking issue.
- **Issue #11** "Audio file support" — opened Feb 2019 (the 2nd issue ever filed
  on the repo), closed Mar 2024 in favor of #1258.
- **Issue #4795** (May 2024) — closed as duplicate.
- Maintainer **WithoutPants** (2021): estimated ~20 hours for a new top-level
  `audio` object; never implemented.
- Maintainer **DogmaDragon** (Discussion #3346, Jan 2024): "interest in the
  feature. No timeline."
- **WithoutPants** (#4109, Feb 2024): "Treating mp3 as video files is not a
  supported use case, and these sorts of errors would be expected."
- **Demand drivers:** GoneWildAudio community (audio-only adult content),
  e-stim audio (#4002), audiobooks/TTS, music libraries, audio fingerprinting
  for dedup (#4083, Chromaprint/AcoustID).

### 3.2 PR #6824 "Audio Backend" — the strategic factor
- Opened April 2026, still open July 2026. +17,118 lines across 129 files.
- Author: `bob12224`. Reviewed by `Gykes` + non-exhaustive review by
  `WithoutPants`.
- Implements: DB schema, GraphQL queries/mutations, scanner integration,
  ffprobe metadata extraction (FrameRate → SampleRate), streaming endpoints.
- **Explicitly backend-only:** "This PR adds backend support for Audio Only,
  future tickets can add the UI elements."
- **Timeline implication (per Oracle):** 3+ months open, unresolved review
  comments, non-exhaustive maintainer review, UI explicitly deferred → **not
  landing imminently**, and even when the backend merges, the UI will still be
  absent. This is the single most important fact for plugin planning.

### 3.3 Existing community plugins
- **`audio-transcodes`** (in official CommunityScripts): Python plugin, hooks
  `Scene.Create.Post`, runs ffmpeg to wrap audio into an MP4 with a solid blue
  background. Band-aid: requires the audio-as-video-extension hack, no ID3
  metadata extraction, large MP4 output, static background. v0.2.
- **`StashAudioPlayer`** (community, now 404/deleted): was a UI plugin adding an
  audio player overlay; referenced in #1258 comments; repo gone.
- **JS workaround** (in #1258 comments): `PluginApi.patch.instead("ScenePlayer",
  ...)` ~10-line snippet filtering streams to WEBM transcode only.
- No other audio plugins in the official community repository.

### 3.4 ffmpeg/ffprobe
ffmpeg/ffprobe fully support probing and transcoding audio-only files (mp3,
flac, ogg, opus, m4a/aac, wav): duration, codec, sample rate, bit rate,
channels. Stash already uses ffprobe and extracts `audio_codec`/`audio_bitrate`.
The #4109 panic is a Stash bug (`ffmpeg.VideoFilter` divide-by-zero, now guarded
in v0.31.1), not an ffmpeg limitation.

---

## 4. Feasibility Analysis

### 4.1 Necessity — YES
- Sustained, real demand since 2019; the longest-running open feature request.
- No native support in v0.31.1; the only workarounds are a config hack + a
  blank-MP4 transcode plugin.
- Even after PR #6824 lands, the UI is deferred — users will have audio in the
  DB but no way to browse/play/manage them. A plugin is needed to fill that UI
  gap.

### 4.2 Possibility — BOUNDED YES
A plugin cannot deliver a *native* audio experience (no new content type, no
scanner influence, no schema extension). It *can* deliver a workable
audio-as-scene experience today and a UI layer for the native type tomorrow.

The realistic plugin surface:
1. **Ingestion assist:** programmatically add audio extensions to
   `VideoExtensions` via `ConfigureGeneral` GraphQL mutation on setup (or
   guide the user to do so), so the scanner accepts audio files as scenes.
2. **Scene.Create.Post hook:** detect audio-as-scene (width=0 or audio-only
   ffprobe result), tag it as `audio`, extract metadata (ID3/ffprobe), store
   alongside the scene (tag-based or custom_fields).
3. **Playback:** patch `ScenePlayer` for audio-tagged scenes → render an audio
   player (waveform/cover/metadata) instead of the broken video player.
4. **Tag management:** already works natively; plugin can add an
   audio-focused browse/manage route.
5. **Generate mitigation:** the plugin cannot prevent generate from running,
   but generate failures on audio scenes are silent (no output produced, no
   crash). The plugin can offer its own "generate audio cover/waveform" task.

### 4.3 The audio-as-scene hack — full consequence chain
1. User adds `mp3` (etc.) to `VideoExtensions` (manually or via plugin setup).
2. Scan ingests audio files as scenes with `VideoFile{Width:0, Height:0,
   VideoCodec:"", AudioCodec:<set>, Duration:<set>}`.
3. GraphQL `VideoFile` non-nullable fields (`width: Int!`, etc.) are
   technically violated at the schema level; in practice Stash returns 0/"".
4. `Scene.Create.Post` hook fires → plugin can tag + extract metadata.
5. User opens the scene → video.js tries to play; stream endpoints return
   video mime types; playback may work via WEBM transcode (per JS workaround)
   but the UI is broken (no poster, no sprite scrubber, `0x0` file info).
6. User runs `Generate` → sprite/screenshot/preview/phash fail silently (no
   output); transcode may produce a blank video. Scene ends up with no
   generated artifacts.
7. Net: the scene exists, is taggable, and is *playable with effort*, but the
   UX is poor and the generate pipeline wastes work.

### 4.4 Self-contained workflow — can the plugin automate it?
Yes, largely. A plugin can:
- Call `ConfigureGeneral` to add audio extensions to `VideoExtensions`
  (one-time setup). **Critical:** `ConfigureGeneral` performs a full overwrite
  of `videoExtensions`, not an append — calling it with only the audio list
  would wipe the user's video extensions and break video scanning. The plugin
  must first read the current list via the `configuration` GraphQL query
  (`general.videoExtensions`, `graphql/schema/types/config.graphql`), merge the
  audio extensions in, and write the combined list back. The plugin should
  prompt/confirm before mutating this global scan config and show the diff.
  **Verified v0.31.1 (high confidence):** each `ConfigGeneralInput` field is
  nil-guarded (`if input.VideoExtensions != nil` at
  `internal/api/resolver_mutation_configure.go:382-384`), so the plugin can send
  *only* `{ videoExtensions: [...] }` without round-tripping the entire config.
  But the list value is a full replace via `SetInterface` (not append), so the
  read-merge-write is still required to preserve existing video extensions.
- Hook `Scene.Create.Post` to tag + extract metadata automatically (see §7.2
  component 2 for the fast-no-op requirement).
- Patch `ScenePlayer` (or overlay on `#VideoJsPlayer`) to render an audio
  player automatically.
- Provide a custom task for audio cover/waveform generation.

The one unavoidable user action is **triggering a scan** (plugins cannot start
scans on their own in a clean way, and even if they could via GraphQL, scanning
is a heavy operation the user should control). This is acceptable — the plugin
handles everything *after* the scan.

---

## 5. Scan & Generate Task Adaptation Analysis

### 5.1 Scan
- **Native scan:** rejects audio. No plugin hook to change this. The only path
  is the `VideoExtensions` config mutation, which routes audio into the scene
  scan handler. The plugin can perform this mutation on setup.
- **Post-scan hook:** `Scene.Create.Post` fires for audio-as-scene, giving the
  plugin a reliable integration point to tag and enrich new audio scenes.

### 5.2 Generate
- **Sprite / screenshot / preview / phash:** all assume a video stream and
  produce no output for audio-only. These are silent failures (logged, no
  crash in v0.31.1). The plugin cannot suppress them per-scene (no per-scene
  generate exclusion exists), but the wasted work is bounded and harmless.
- **Transcode:** produces a blank video; not useful for audio.
- **Plugin alternative:** the plugin should ship its own lightweight
  "generate audio artifacts" task (cover art extraction from ID3, waveform
  image, duration/codec metadata) rather than relying on the broken native
  generate pipeline.
- **Recommendation to users:** disable sprite/preview/phash generation for
  audio-tagged scenes (or globally if the library is mostly audio) to avoid
  wasted work; the plugin can document this and optionally detect/grey-out
  generate options for audio scenes.

---

## 6. Recommendation

**Build the plugin, scoped as a two-phase bridge.**

- **Phase A (now, pre-#6824):** an **audio-as-scene enhancement** plugin that
  makes the existing hack usable — ingestion assist, audio player, metadata,
  tag-based management, custom audio-artifact generation. This is genuinely
  useful today and has no dependency on unreleased Stash work.
- **Phase B (post-#6824):** the same plugin becomes the **UI layer** for the
  native `Audio` type — routes, player, browse/manage — because PR #6824
  explicitly defers all UI. The plugin is *complementary* to the backend PR,
  not obsoleted by it.

**Do NOT** attempt to build a standalone "audio content type" inside a plugin
(no schema/scanner extension possible). **Do NOT** wait for #6824 before
shipping anything (it is not landing imminently, and even after it lands the
UI gap remains).

**Risks:**
- The `VideoExtensions` hack is unsupported; a future Stash change could break
  audio-as-scene ingestion. Mitigation: the plugin should detect the failure
  mode and surface a clear message; design Phase B to migrate off the hack.
- **`ConfigureGeneral` overwrites `videoExtensions`** (full replace, not
  append). A naive setup call would wipe the user's video extension list and
  break video scanning. Mitigation: read-modify-write — query
  `general.videoExtensions` first, merge audio extensions, write back the
  combined list; show the diff and require user confirmation.
- **GraphQL non-nullable field violation:** `VideoFile` exposes
  `width: Int!`, `height: Int!`, `video_codec: String!`, `audio_codec: String!`
  (`graphql/schema/types/file.graphql:88-92`). An audio-as-scene produces
  `width=0, height=0, video_codec=""`. **Verified v0.31.1 (high confidence):**
  the Go backing types are value types (`int`/`string`, not `*int`/`*string`)
  at `pkg/models/model_file.go:279-292`, so gqlgen always serves valid `0`/`""`
  — never a null error. ffprobe `parse()` returns zeroed fields without error
  for audio-only (`pkg/ffmpeg/ffprobe.go:304-344`); the video decorator passes
  them through unguarded (`pkg/file/video/scan.go:18-58`); the scene handler
  creates the scene unconditionally (`pkg/scene/scan.go:115-121`); the extension
  gate is purely name-based (`internal/manager/manager_tasks.go:43-46`). **The
  audio-as-scene approach is viable at the GraphQL/data layer — no blank-MP4
  fallback needed for the query path.** (A blank-MP4 may still be useful for
  the video.js player to have something to stream, but that is a playback
  concern, not a data concern.)
- PR #6824's data model may differ from the plugin's tag/metadata convention.
  Mitigation: keep the plugin's audio metadata in scene `custom_fields` (which
  #6824 is unlikely to touch) and use a stable tag name, so migration to the
  native type is a read-and-rewrite, not a schema migration.
- Generate breakage is silent; users may not realize why audio scenes have no
  sprites. Mitigation: plugin documents this and offers its own artifacts.

---

## 7. Plugin Design Sketch

### 7.1 Scope
- **Name (working):** `AudioSupport` (plugin id = directory name).
- **Config key:** `"AudioSupport"` (csLib), storing plugin settings only —
  audio metadata lives on the scene (tags + `custom_fields`), not in plugin
  config, to ease Phase B migration.
- **Dependencies:** `CommunityScriptsUILibrary` (csLib) — declared in
  `ui.requires` and `# requires:` comment, matching the repo convention.

### 7.2 Architecture (Phase A)

```
plugins/AudioSupport/
  AudioSupport.yml              # manifest
  AudioSupport.js               # player overlay: patches ScenePlayer for audio scenes
  AudioSupportSettings.js       # React settings page: setup, metadata, browse
  AudioSupportTask.js           # custom task: generate audio artifacts (cover/waveform)
  codemap.md
  *.css
```

**Components:**

1. **Setup wizard** (settings page, React via `PluginApi`):
   - Detects whether audio extensions are in `VideoExtensions`; offers a
     one-click "enable audio ingestion" button that calls `ConfigureGeneral`
     to add `mp3, flac, ogg, opus, m4a, wav, aac` (with user confirmation,
     showing the diff).
   - Creates a dedicated `Audio` tag (or a configurable tag name) if absent.
   - Documents the generate-task caveats.

2. **`Scene.Create.Post` hook** (server-side plugin hook, JS/Python):
   - **Fires for *every* new scene, not just audio** — so audio detection must
     be a fast no-op for video scenes. Detect via the file extension or the
     hook context's `VideoCodec == ""` / `Width == 0`; do **not** re-run ffprobe
     in the hook (ffprobe already ran during scan; re-probing every scene adds
     scan latency). Only audio-detected scenes proceed to tag + metadata.
   - Adds the `Audio` tag.
   - Extracts metadata (ID3 tags for mp3/flac, ffprobe sample_rate/bit_rate/
     channels, duration) and writes to scene `custom_fields` under an
     `AudioMeta` key (stable, migration-friendly).
   - **Cover art:** set via `SceneUpdate(cover_image: "data:image/png;base64,...")`
     — `SceneUpdateInput.cover_image: String` accepts a base64 data URL
     (`graphql/schema/types/scene.graphql:150-151`), decoded by
     `utils.ProcessImageInput` and stored as a DB blob
     (`internal/api/resolver_mutation_scene.go:306-314`), served from
     `/scene/{id}/screenshot`. **No file write to the generated path is
     required** — the plugin can extract ID3 album art (or render a waveform
     image) and pass it as base64.

3. **ScenePlayer overlay** (`AudioSupport.js`, vanilla JS via csLib
   `PathElementListener`):
   - **Prefer the overlay approach** (mount on `#VideoJsPlayer` via
   `csLib.PathElementListener`, matching QuestingAdventurer/MosaicFilter) as
   primary — it is proven in this repo, doesn't require patching a complex
   React component, and is more resilient across Stash versions. Use
   `PluginApi.patch.instead("ScenePlayer", ...)` only as a fallback if the
   overlay cannot suppress the broken video.js element cleanly.
   - For audio-tagged scenes, render an audio player UI: transport controls,
     waveform/cover, metadata, seek bar driven by audio duration.
   - **Source selection — direct stream only.** Verified v0.31.1 (high
     confidence): all transcode endpoints (MP4, WEBM, MKV) **fail** for
     audio-only input because `FileGetCodec` (`pkg/ffmpeg/stream_transcode.go:152-185`)
     always includes a `-c:v` video-encode flag with no guard for missing video
     streams — the encoder tries to produce video from nothing and crashes
     (MP4: `libx264`/`h264_nvenc`; WEBM: `libvpx-vp9`; both fail identically).
     The **direct stream** `/scene/{id}/stream` is the only working endpoint:
     `StreamSceneDirect` (`internal/manager/running_streams.go:42-62`) serves
     raw file bytes via `http.ServeFile` with **no ffmpeg**, Content-Type
     inferred from extension (mp3→`audio/mpeg`, wav→`audio/wav`). The plugin
     must force the player to the direct stream and filter out all transcode
     endpoints for audio-only scenes. Two viable approaches:
     - **(A, recommended)** patch `sceneStreams` / the player's source list so
       audio-only scenes (`video_codec == ""`) only get the direct-stream
       endpoint — video.js never tries a transcode.
     - **(B)** overlay a plain `<audio>` element loading `/scene/{id}/stream`
       directly, bypassing video.js's transcode fallback chain entirely.
   - **Why the default UI fails:** `IsStreamable("", audioCodec, container)`
     (`pkg/ffmpeg/browser.go:37-43`) returns an error because `""` is not in
     `defaultSupportedCodecs = [H264, H265]`, so Stash marks the file
     "not directly streamable" and the player skips the direct stream in favor
     of transcode endpoints — which then crash. The direct stream IS offered in
     `GetSceneStreamPaths` (`internal/manager/scene.go:150-159`) via
     `IsValidAudioForContainer` (mp3/aac/opus valid for mp4), but the player's
     source selector jumps past it. The plugin patch must override this.

4. **Audio browse route** (settings page or a patched scene list filter):
   - A `/plugins/audiosupport` route showing audio-tagged scenes with
     audio-specific columns (codec, sample rate, bit rate, duration) instead
     of video columns (resolution, framerate).

5. **Custom generate task** (`AudioSupportTask.js`):
   - Declared as a `tasks:` entry in `AudioSupport.yml`. Stash automatically
     surfaces plugin tasks on the **Settings > Tasks page** as runnable buttons
     (`pkg/plugin/config.go:58-59` parses yml `tasks:`; `PluginTask` GraphQL
     type at `graphql/schema/types/plugin.graphql:30-34`; UI at
     `ui/v2.5/src/components/Settings/Tasks/PluginTasks.tsx:19-36` calls
     `mutateRunPluginTask(plugin.id, operation.name)`). **No settings-page
     button or custom UI is required** for the task — the yml declaration is
     sufficient.
   - Generates audio-appropriate artifacts: cover art (from ID3 or a default),
     waveform image, duration/codec metadata. Does *not* attempt sprite/preview.

### 7.3 Architecture (Phase B, post-#6824)

When PR #6824 lands, the native `Audio` type exists but has no UI. The plugin
adapts:

- **Ingestion assist** becomes unnecessary (native scanner handles audio) —
  remove the `VideoExtensions` mutation; instead detect native `Audio` objects.
- **`Scene.Create.Post` hook** → migrate to `Audio.Create.Post` (or whatever
  hook #6824 exposes) for metadata extraction.
- **ScenePlayer overlay** → becomes an `AudioPlayer` route/component for native
  Audio objects (no more scene-player overlay).
- **Browse route** → queries native `Audio` objects instead of audio-tagged
  scenes.
- **Migration helper:** a one-time task that reads audio-tagged scenes (Phase
  A data) and rewrites them as native `Audio` objects using #6824's mutations,
  preserving tags and `custom_fields.AudioMeta`.

**Dependency caveat:** the Phase B plan assumes #6824 exposes plugin-callable
hooks (`Audio.Create.Post` or equivalent) and Audio GraphQL mutations that
plugins can invoke. This is likely but not guaranteed — the PR is still under
review and its final plugin-facing API surface is not fixed. If #6824 does not
expose plugin-callable hooks/mutations for Audio, the migration path changes
(the plugin may need to read Audio objects via query only and rely on a future
UI ticket for write surfaces). Confirm the final API surface before starting
Phase B (see §8 open question 4).

This keeps the plugin useful across the transition and avoids a dead-end
Phase A.

### 7.4 Conventions followed (per repo AGENTS.md)
- One plugin per directory, no cross-plugin imports.
- Vanilla JS for the player overlay; React only for the settings/route (via
  `PluginApi.patch.before`, matching QuestingAdventurer/MosaicFilter patterns).
- `csLib.getConfiguration`/`setConfiguration` are async — always `await`
  (silent failure mode otherwise).
- Manifest keeps `# requires:` comment in sync with `ui.requires`.
- Bump `version:` in the yml for user-visible releases; build appends the git
  hash automatically.
- AGPL-3.0 compatible.

---

## 8. Open Questions / Follow-ups

### Resolved by v0.31.1 source verification (high confidence)

1. ~~**Cover art storage:**~~ **RESOLVED.** A plugin can set a scene's cover
   via `SceneUpdate(cover_image: "data:image/png;base64,...")`.
   `SceneUpdateInput.cover_image: String` accepts a base64 data URL
   (`graphql/schema/types/scene.graphql:150-151`), decoded by
   `utils.ProcessImageInput` and stored as a DB blob
   (`internal/api/resolver_mutation_scene.go:306-314`), served from
   `/scene/{id}/screenshot`. No file write to the generated path is required.
2. ~~**Custom task UI:**~~ **RESOLVED.** A plugin declares a `tasks:` entry in
   its yml manifest (`pkg/plugin/config.go:58-59`). Stash surfaces it
   automatically on the Settings > Tasks page as a runnable button
   (`ui/v2.5/src/components/Settings/Tasks/PluginTasks.tsx:19-36` calls
   `mutateRunPluginTask(plugin.id, operation.name)`). No settings-page button
   or custom UI is required.
3. ~~**`ConfigureGeneral` overwrite behavior:**~~ **RESOLVED.** Each
   `ConfigGeneralInput` field is nil-guarded
   (`internal/api/resolver_mutation_configure.go:382-384`), so a plugin can
   send only `{ videoExtensions: [...] }` without round-tripping the entire
   config. But the list value is a full replace (not append), so read-merge-
   write is still required to preserve existing video extensions.
   `configuration` query returns `general.videoExtensions: [String!]!`
   (`graphql/schema/types/config.graphql:313`,
   `internal/api/resolver_query_configuration.go:125`).
4. ~~**GraphQL non-nullable field tolerance:**~~ **RESOLVED — VIABLE.** The
   Go backing types are value types (`int`/`string`, not pointers) at
   `pkg/models/model_file.go:279-292`, so gqlgen always serves valid `0`/`""`
   for audio-as-scene — never a null error. ffprobe returns zeroed fields
   without error (`pkg/ffmpeg/ffprobe.go:304-344`); the video decorator passes
   them through unguarded (`pkg/file/video/scan.go:18-58`); the scene handler
   creates the scene unconditionally (`pkg/scene/scan.go:115-121`); the
   extension gate is purely name-based
   (`internal/manager/manager_tasks.go:43-46`). **The audio-as-scene approach
   is viable at the data/query layer — no blank-MP4 fallback needed for the
   query path.** This was the critical feasibility gate; it passes.

### Resolved by live testing + source verification (high confidence)

5. ~~**Stream codec support:**~~ **RESOLVED by live test (mp3, wav).** The
   **direct stream** `/scene/{id}/stream` serves raw file bytes via
   `http.ServeFile` with no ffmpeg (`internal/manager/running_streams.go:42-62`),
   Content-Type inferred from extension. **Live-confirmed 2026-07-27:** browsers
   play the direct stream for both mp3 (`http://localhost:9999/scene/6378/stream`)
   and wav (`http://localhost:9999/scene/6377/stream`) natively. The plugin's
   player must use the direct stream exclusively for audio-only scenes
   (see §7.2 component 3). Remaining codecs (flac, ogg, opus, m4a) are not
   blocking — the direct stream serves raw bytes regardless of codec; only
   browser codec support varies (Chrome/Firefox natively support flac/ogg/
   opus; m4a/aac is platform-dependent). They can be tested the same way to
   fill the §9.6 matrix, but mp3 + wav confirm the direct-stream approach
   works for the common cases.
6. ~~**WEBM transcode viability for audio-only:**~~ **RESOLVED — WEBM is NOT
   viable.** Source verification (high confidence): `FileGetCodec`
   (`pkg/ffmpeg/stream_transcode.go:152-185`) always includes a `-c:v`
   video-encode flag with no guard for missing video streams. For audio-only
   (`VideoCodec==""`), MP4 selects `libx264`/`h264_nvenc` and WEBM selects
   `libvpx-vp9` — both try to encode video from nothing and crash. Live test
   confirmed MP4 transcode fails (ffmpeg log: `-c:v h264_nvenc ... -f mp4
   pipe:>` → CUDA error → `TerminateProcess: Access is denied`). WEBM has the
   same structural failure. **The earlier assumption that WEBM could serve as a
   fallback was wrong.** The direct stream is the only working endpoint for
   audio-only files. MKV transcode (`-c:v copy`) would be a no-op for
   audio-only but is only offered when the container is already Matroska
   (`internal/manager/scene.go:158`), so it is not a general solution.

### Live test results recorded (2026-07-27)
- **Data layer (Q4/#1 confirmed live):** GraphQL `findScenes` returns audio
  scenes with `width:0, height:0, video_codec:"", audio_codec:"mp3"/"pcm_s16le"`
  — no errors. Matches the source verification exactly.
- **Default UI playback:** fails — video.js requests `/scene/{id}/stream.mp4`
  (MP4 transcode), ffmpeg crashes trying to encode video from audio-only input.
  Stash retries at `resolution=ORIGINAL/FOUR_K/FULL_HD`, all MP4 transcode, all
  fail. Root cause: `IsStreamable("","mp3",container)` returns error (empty
  video codec not in `[H264,H265]`, `pkg/ffmpeg/browser.go:37-43`), so the
  player skips the direct stream and goes straight to transcode endpoints.
- **Direct stream:** not yet tested in-browser by the user; source confirms it
  serves raw bytes with no ffmpeg. Pending user confirmation at
  `http://localhost:9999/scene/{id}/stream`.

### Deferred to Phase B (post-#6824)

7. **PR #6824 hook names & plugin-facing API:** once #6824 merges, confirm the
   exact `Audio.*` hook names, GraphQL mutation names, and whether they are
   plugin-callable — so the Phase B migration is precise and the dependency
   caveat in §7.3 is resolved.

---

## 9. Pre-Build Testing Procedure (for open questions 5 & 6)

The two remaining open questions require a **running Stash v0.31.1 instance**
and a **browser** — they cannot be answered from source alone. This section is
a concrete, repeatable procedure to resolve them. Expected time: ~1 hour
including instance setup.

### 9.1 Prerequisites

**A. Run a Stash v0.31.1 instance**

Easiest path is Docker (avoids building from source):

```bash
# Create a scratch config dir (do NOT use your real Stash config)
mkdir -p /tmp/stash-audio-test/config /tmp/stash-audio-test/data
# Put test audio files in the data dir (see step B)
docker run --rm -d --name stash-audio-test \
  -p 9999:9999 \
  -v /tmp/stash-audio-test/config:/root/.stash \
  -v /tmp/stash-audio-test/data:/data \
  stashapp/stash:v0.31.1
# Wait for startup, then open http://localhost:9999
# Complete the initial setup wizard (create a username/password or skip auth)
```

> If `stashapp/stash:v0.31.1` is unavailable on Docker Hub, check
> `ghcr.io/stashapp/stash:v0.31.1` or build from the cloned source:
> `cd .slim/clonedeps/repos/stashapp__stash && make docker`. The clone is
> already at v0.31.1.

**B. Prepare one test file per audio codec**

Put these in `/tmp/stash-audio-test/data/audio/` (create the `audio/`
subdirectory). Use ffmpeg to generate short (10-second) test clips so you
isolate the codec variable:

```bash
mkdir -p /tmp/stash-audio-test/data/audio
cd /tmp/stash-audio-test/data/audio
# Generate a 10s sine-wave tone in each codec (no external files needed)
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" -c:a libmp3lame   test.mp3
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" -c:a flac          test.flac
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" -c:a libvorbis    test.ogg
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" -c:a libopus      test.opus
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" -c:a aac          test.m4a
ffmpeg -f lavfi -i "sine=frequency=440:duration=10" -c:a pcm_s16le    test.wav
```

> Real audio files (with ID3 album art) also work and additionally exercise the
> cover-art path, but synthetic tones are sufficient to answer questions 5 & 6.

### 9.2 Step 1 — Enable audio ingestion

In the Stash UI: **Settings → Library → Video Extensions**, append
`,mp3,flac,ogg,opus,m4a,wav` to the existing list (keep the video extensions!),
then **Save**.

Or via the GraphQL playground at `http://localhost:9999/api/playground` (this
is exactly what the plugin's setup wizard will do — read-merge-write):

```graphql
# 1. Read current list
query { configuration { general { videoExtensions } } }

# 2. Merge audio extensions into the returned list, then write back:
mutation {
  configureGeneral(input: {
    videoExtensions: [
      "m4v","mp4","mov","wmv","avi","mpg","mpeg","rmvb","rm","flv","asf","mkv","webm","f4v",
      "mp3","flac","ogg","opus","m4a","wav"
    ]
  }) { general { videoExtensions } }
}
```

### 9.3 Step 2 — Scan & verify the data layer (live confirmation of Q4/#1)

1. **Settings → Library → Scan** (or `mutation { metadataScan(input: {}) }`).
   Wait for the scan to finish (6 small files, should be seconds).
2. Go to **Scenes** — you should see 6 new scenes (one per audio file).
3. Open the GraphQL playground and query one scene to confirm the data layer
   serves zeroed video fields **without error** (live confirmation of the
   source-verified finding #1):

```graphql
query {
  findScenes(scene_filter: { path: { modifier: INCLUDES, value: "/audio/" } }) {
    scenes {
      id
      title
      files { width height video_codec audio_codec duration }
      paths { screenshot }
    }
  }
}
```

**Expected:** each scene returns `width: 0, height: 0, video_codec: ""`,
`audio_codec: <codec>`, `duration: ~10`. **No GraphQL errors.** If this
fails, the source verification was wrong and the audio-as-scene approach is
blocked — report this immediately.

4. Note the `id` of each scene for step 4.

### 9.4 Step 3 — Test browser native playback (answers Q5)

This determines which codecs the browser plays directly via the **direct file
stream**, without transcode.

For each of the 6 scenes, in a **clean browser profile** (to avoid
extension/codec interference — Chrome and Firefox differ in codec support):

1. Open the scene page: `http://localhost:9999/scenes/{id}`
2. Observe the player:
   - Does the video.js player load?
   - Does pressing play produce **audible audio** (the 440 Hz tone)?
   - Open the browser DevTools **Console** — note any codec/Media error
     (e.g., `MEDIA_ELEMENT_ERROR: Format error`, `CHUNK_DEMUXER_ERROR`).
   - Open DevTools **Network** — find the stream request; note its URL and
     `Content-Type` response header.
3. Record the result per codec in the matrix (§9.6):
   - ✅ Plays with audio
   - ❌ No audio / error (note the console error)

The direct stream URL pattern is `/scene/{hash}/stream` (direct file serve).
You can also test it directly in a bare `<audio>` tag to isolate from
video.js:

```html
<!-- save as /tmp/test-audio.html, open in the browser -->
<audio controls src="http://localhost:9999/scene/{HASH}/stream"></audio>
```

(Replace `{HASH}` with the scene's hash — find it via
`query { findScene(id: "{id}") { hash } }`.)

### 9.5 Step 4 — Test WEBM transcode playback (answers Q6)

This determines whether the WEBM transcode fallback (used by the known JS
workaround) produces a **playable** stream for audio-only input, or a
broken/blank video stream.

The transcode stream URL pattern is `/scene/{hash}/stream.webm` (the WEBM
transcode endpoint). Test it two ways:

**A. Direct fetch — inspect what the transcode actually produces:**

```bash
# Replace {HASH} with a scene hash from step 2
curl -sS -o /tmp/transcode.webm -D - \
  "http://localhost:9999/scene/{HASH}/stream.webm" \
  | head -20   # show response headers
file /tmp/transcode.webm   # confirm it's a WebM container
ffprobe -v error -show_streams /tmp/transcode.webm
# Key question: does ffprobe report a video stream, an audio stream, or both?
#   - audio stream only  → transcode is usable as an audio source
#   - video stream only  → blank video, no audio → NOT usable
#   - both               → blank video + audio → video.js may render blank frame
#                          but audio plays (acceptable fallback)
#   - error / empty file → transcode fails for audio-only
```

**B. In-browser — does video.js render it:**

```html
<!-- save as /tmp/test-transcode.html, open in the browser -->
<video controls src="http://localhost:9999/scene/{HASH}/stream.webm"></video>
```

- Does the `<video>` element show a playable duration?
- Does pressing play produce **audible audio**?
- DevTools Console: any decode errors?

Record the result per codec in the matrix (§9.6). The MP4 transcode endpoint
(`/scene/{hash}/stream.mp4`) can be tested the same way for completeness — it's
the other fallback the player might use.

### 9.6 Results matrix template

Fill this in during testing and record the outcome in the deepwork file
(`.slim/deepwork/audio-support-feasibility.md`) so the plugin's player
component (§7.2 component 3) can be built against confirmed data.

| Codec | Direct stream plays? (Q5) | Direct `Content-Type` | WEBM transcode: ffprobe streams (Q6) | WEBM transcode plays in-browser? (Q6) | Player source choice |
|-------|---------------------------|------------------------|--------------------------------------|---------------------------------------|----------------------|
| mp3   |                           |                        |                                      |                                       | direct / transcode   |
| flac  |                           |                        |                                      |                                       |                      |
| ogg   |                           |                        |                                      |                                       |                      |
| opus  |                           |                        |                                      |                                       |                      |
| m4a   |                           |                        |                                      |                                       |                      |
| wav   |                           |                        |                                      |                                       |                      |

**Decision rule for the player's source-selection logic (§7.2 component 3):**
- If direct stream plays → prefer direct (lowest overhead, best quality).
- If direct fails but WEBM transcode plays → fall back to transcode.
- If both fail → that codec is unsupported in-browser; the plugin must either
  server-side transcode to a supported codec on the fly, or pre-convert (the
  `audio-transcodes` blank-MP4 approach) — record this as a Phase A limitation.

### 9.7 Cleanup

```bash
docker stop stash-audio-test && docker rm stash-audio-test
rm -rf /tmp/stash-audio-test /tmp/test-audio.html /tmp/test-transcode.html /tmp/transcode.webm
```

---

## References

- Stash v0.31.1 source clone: `.slim/clonedeps/repos/stashapp__stash/`
- Issue #1258 (canonical): https://github.com/stashapp/stash/issues/1258
- Issue #11 (original, closed): https://github.com/stashapp/stash/issues/11
- Issue #4109 (mp3 panic): https://github.com/stashapp/stash/issues/4109
- Issue #4002 (e-stim): https://github.com/stashapp/stash/issues/4002
- Issue #4083 (audio hash): https://github.com/stashapp/stash/issues/4083
- Discussion #3346: https://github.com/stashapp/stash/discussions/3346
- PR #6824 (Audio Backend): https://github.com/stashapp/stash/pull/6824
- `audio-transcodes` plugin:
  https://github.com/stashapp/CommunityScripts/tree/main/plugins/audio-transcodes
- Plugin docs: https://docs.stashapp.cc/in-app-manual/plugins/
- UI Plugin API docs: https://docs.stashapp.cc/in-app-manual/plugins/uipluginapi/