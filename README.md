# stashapp-plugins-vault

A collection of Stash plugins — player overlays, page additions, and one theme — installed from a single plugin source. Install once, then turn on whichever ones you want.

> **Looking for feedback!** This project is still evolving and I'd love to hear what you'd use, what feels awkward, and what features you wish existed. Please open a [GitHub issue](https://github.com/stashalizer/stashapp-plugins-vault/issues) or find the announcement thread on the [stashapp community forum](https://discourse.stashapp.cc/c/plugins/18/none).

## Plugins

- **[Questing Adventurer](#questing-adventurer)** — turns scene playback into a quest: respond to on-screen cues by performing the moves attached to your active triggers.
- **[Mosaic Filter](#mosaic-filter)** — movable, resizable blur rectangles (or ellipses) over any region of a scene, as many independent filters at once as you need, with a follow-cursor mode and a reverse mode that blurs everything *except* the filter area.
- **[Scene Versions](#scene-versions)** — a "Related Scenes" tab on the scene page that links alternate versions of a scene bidirectionally, with a suggest-from-folder helper.
- **[Scene Rotation](#scene-rotation)** — rotate a sideways scene 90/180/270 degrees and have it stay that way: the angle is saved on the scene and applied to the player, the card preview and the cover, without re-encoding the file or writing anything to disk.
- **[Audio Support](#audio-support)** — plays audio files (mp3, flac, m4a, ogg, opus, wav) as scenes with a dedicated audio overlay, synced LRC lyrics, a play queue with auto-advance, and a browse page (by work / all / by tag).
- **[Carbon Arc](#carbon-arc)** — a desktop-first dark theme: graphite surfaces, bone text, one low-chroma signal and monospaced numbers, with three signal colours and two card densities to choose from.
- **[External Link Groups](#external-link-groups)** — puts the sites you actually use on their own icon buttons on performer, studio and group pages, with each site's favicon fetched and cached, one link opening directly and several opening a menu.

## Requirements (all plugins)

- [Stash](https://github.com/stashapp/stash) (functionally tested against the v0.31.x line; see [Tested environment](#tested-environment) for the v0.32.0 status).
- [CommunityScriptsUILibrary](https://github.com/stashapp/CommunityScripts/tree/main/plugins/CommunityScriptsUILibrary) (`csLib`) — **install this first.** QuestingAdventurer, MosaicFilter, and AudioSupport depend on it; their player overlays will not load without it. SceneVersions, SceneRotation, Carbon Arc and External Link Groups are standalone and do not require csLib.
- The full-page settings UIs additionally use Stash's built-in `PluginApi` (React + router), which ships with Stash — nothing extra to install. SceneVersions also uses `PluginApi` for its tab injection.
- **Carbon Arc without csLib still works**, but its three options are then saved in that browser's `localStorage` instead of the plugin configuration, so they do not follow you to another browser or device. The settings page tells you which of the two is in use. **External Link Groups** behaves the same way: the domain list is kept in `localStorage` without csLib.

## Tested environment

Each plugin is code-reviewed against the repository's architecture notes. The
November 2026 feature pass has **not** yet completed a live functional pass on
Stash 0.31.x/0.32.x; use the plugin's issue tracker to report regressions.
Testing is done primarily on **Windows** (desktop Stash + Chromium-based
browser). Other environments (macOS, Linux, mobile/touch browsers, other Stash
versions) are **not yet tested**. If you run into issues, please report them in a
[GitHub issue](https://github.com/stashalizer/stashapp-plugins-vault/issues) —
it helps expand the tested matrix.

**Stash v0.32.0 (React 18 UI):** compatibility was re-verified against the v0.32.0 source — every patch target the plugins use (`ScenePlayer`, `ScenePage.Tabs` / `ScenePage.TabContent`, `PluginRoutes`, `SettingsToolsSection`, `MainNavBar.MenuItems`), the `SceneIDSelect` props, the `#VideoJsPlayer` mount id, the `custom_fields` / `cover_image` mutation shapes, and the `VideoFile` field nullability the audio workaround depends on are unchanged. A live v0.32.0 install has **not** been through the full functional pass yet, so v0.31.x remains the functionally tested baseline.

## Install

Add this repository as a plugin source in Stash:

1. Open **Settings → Plugins → Available Plugins → Add Source**.
2. Paste this URL:
   ```
   https://stashalizer.github.io/stashapp-plugins-vault/main/index.yml
   ```
3. Install **Questing Adventurer**, **Mosaic Filter**, **Scene Versions**, **Scene Rotation**, **Audio Support** and/or **Carbon Arc** from the list.
4. Make sure **CommunityScriptsUILibrary** is installed and enabled — the overlays depend on it (Audio Support's overlay and settings page both require it).

QuestingAdventurer, MosaicFilter, and AudioSupport each appear in two places: a **player overlay** on every scene page, and a **settings/browse page** under **Settings → Tools → Scene Tools** (AudioSupport also adds a top-nav **Audio** entry). SceneVersions instead adds a **tab** to the scene page (no overlay, no settings page). SceneRotation adds a small control cluster in the player's top-right corner and rotates scene media wherever it appears — player, card preview, cover (no settings page). Carbon Arc adds no surface of its own: it restyles every existing one and adds a **Settings → Tools → Carbon Arc** card for its three options.

---

## Questing Adventurer

Turns scene playback into a quest. While a scene plays, the viewer is a "questing adventurer" who must respond to on-screen cues (a gesture, a dance move, a spoken phrase — whatever you define) by performing the moves attached to their **active** triggers. Think of it as a randomized, self-directed challenge layer over any scene.

### Features

- **You define the vocabulary.** Build a library of *moves* (short text strings — "left hand", "slow grind", "hold eye contact", anything) and a library of *triggers* (named cues — "Dance Break", "Eye Contact", "Whisper"). Attach any number of moves to each trigger.
- **Randomized play.** The **Penalty** and **Reward** buttons on the overlay randomly activate/deactivate triggers and attach/detach moves, so the same scene plays differently every time.
- **Two surfaces, one library.** Manage the full library on the settings page; the overlay only shows what's currently *active* so it stays out of your way during playback.

### How to use it

**1. Set up your library** on the settings page at **Settings → Tools → Scene Tools → Questing Adventurer** (or `/plugins/questingadventurer`):

- **Move Library** — add the moves you want to be able to perform. Double-click any move to rename it; delete with the trash button (detaching it from any triggers that use it, with a confirm prompt).
- **Triggers** — add named triggers and attach moves to each. A trigger with no attached moves is `active: false` by design — it won't show on the overlay until it has moves. Reorder triggers with ▲/▼, rename by double-clicking, and use "Add Move" on a trigger to create a move *and* attach it in one step.
- **Tag Bindings** — pick a scene tag, then the trigger and (optionally) the move it should apply. Any scene carrying that tag activates the trigger and attaches the move as playback starts; a scene whose tags match no binding is left alone. Several bound tags on one scene all fire, and two tags naming the same trigger/move pair still fire once. A row that points at a deleted trigger is flagged in the table and skipped at playback instead of erroring.

**2. Play a scene.** The overlay appears as a collapsible panel pinned to the top-right of the player. The collapsed chip shows `🗺️ Triggers (N)` where N is the number of active triggers.

**3. Use the overlay during playback:**

- **Penalty** — picks a random *inactive* trigger, activates it, and attaches a random *unattached* move from your library. If every trigger is already active, it picks an active trigger and just attaches a move. If the library has no unattached moves left, the trigger is still activated (the move part is a no-op).
- **Reward** — picks a random *active* trigger that still has attached moves and removes a random attached move. If a trigger ends up with zero attached moves, it's set back to `active: false`.
- **➕ Add toggle** — reveals an inline footer for adding a new trigger or a new move on the fly without leaving the player.
- **Manual Selection library** — for fine-grained control the random buttons can't give you: explicitly activate any inactive trigger, or attach any library move to any trigger via a dropdown. Lets you set up a specific configuration instead of relying on randomness.
- **Quest Log** — mark attached moves Done per run, click a tick to undo it; daily counts, streaks and the last three sessions persist across reloads. Completion is tracked per trigger run, so the same move can be ticked again when its trigger comes up a second time, and ticking it under one trigger no longer ticks it under another. Runs are a record of when a trigger was switched on, not a count of how often it appeared in the video — the plugin cannot observe that.
- **Scene-aware triggers** — restrict a trigger to scenes with chosen tags, and show prompts when playback reaches markers with chosen tags.
- **Tag-triggered combos** — a tag bound to a trigger/move under **Tag Bindings** activates that combo the moment a scene carrying the tag opens, so the overlay already lists the right quest without pressing Penalty.
- **Playback rules** — bind a trigger to a scene (opens it automatically) or to one of that scene's markers (fires when the playhead crosses it), optionally attaching a move at the same moment. Configured per trigger under Settings: paste a scene ID or URL, pick "On scene open" or a marker, pick the move, and tick **Re-arm** if the trigger should come back after a Reward clears it. Crossings are detected, not sampled: scrubbing over a marker does not fire it, and an explicit × on the trigger suppresses its rules for the rest of the session.
- **Partner deal** — create a one-time, 10-minute link so a partner signed in to the same Stash instance can draw one inactive trigger.
- **Hardware bridge (experimental)** — opt-in local Intiface connection on move completion.

### Known limitations

- The overlay and the settings page keep separate save locks and don't coordinate. If you edit the settings page while the overlay is open, the overlay won't reflect the changes until you navigate away and back (or reload). Avoid editing both at the same instant.
- A brief flash can occur between React unmounting the player area and the overlay re-injecting on SPA navigation — this is expected and resolves instantly.

---

## Mosaic Filter

Toggleable, movable, and resizable blur overlays for any region of a scene. Use one to censor a watermark, blur a face or UI element, or — with **reverse mode** — blur everything *except* the region you want to focus on. The filter can be a rectangle or an ellipse, and an optional **follow-cursor** mode makes it track your pointer.

**Several filters at once.** A scene can carry more than one filter, each with its own position, size, shape, effect, blur strength and visibility — so two faces, a logo and a background can be redacted in one go. Filters never overwrite each other: drag or resize one and the others stay exactly where they were. Presets save the whole set, so a scene preset restores every region it had.

### Features

- **Multiple independent filters.** Add, select, rename, hide and delete filters from the panel's list. Every filter keeps its own geometry, effect and parameters; edits apply to the selected one only.
- **Two blur directions.** *Normal* mode blurs the area inside the filter. *Reverse* mode blurs everything *outside* the filter and leaves the filter area clear — handy for "spotlight" style viewing.
- **Two shapes.** Rectangle (default) or ellipse — the reverse-mode hole is cut precisely to match, using a `clip-path: path()` technique that works across modern Chromium/Firefox/Safari.
- **Follow-cursor.** Turn it on and the filter re-centers on your pointer as you move it — no dragging needed. Drag is disabled in this mode (resize still works).
- **Blur, solid and pixelate** fill modes. Solid cannot leak shape or colour; pixelate uses a low-resolution video canvas and is opt-in.
- **Global, scene and studio presets** — resolution order is scene > studio > global default.
- **Movable pill** — drag the pill (mouse or touch) to park the launcher anywhere over the picture, out of the way of other overlays and of anything else in that corner. The open panel travels with it, and the placement is remembered per browser.
- **Redacted screenshot** — copy or download the current frame with the filter applied.
- **Panic screen** — Ctrl+Shift+X shows a local, network-free decoy article and pauses/mutes playback.

### How to use it

**On the player** — a small **Mosaic** pill sits in the bottom-right corner, just above Stash's own control bar, and fades out with the rest of the player chrome while you watch. It is the only thing the plugin puts on the video. Click it to open the settings panel; click outside it, press `Esc`, or use the ✕ to close.

**Moving the pill:** drag it anywhere over the picture — the panel follows and never covers it. A press that does not move is still a click, so clicking to open the panel works exactly as before. The pill stays inside the frame (it is re-clamped when the window or fullscreen size changes), and the position is remembered per browser rather than per scene, so it survives navigation and reloads.

The pill's dot is the state read-out for the layer: hollow = every filter off, blue = at least one on, amber = at least one live reverse filter (everything outside it is filtered). With more than one filter the tooltip tells you how many are on.

**The filter list** at the top of the panel is where multiple filters live:

- Each row is one filter: its dot shows whether it is on, and the highlighted row is the one the controls below edit.
- Click a row to select it, or click a filter directly on the video — either way the panel switches to that filter.
- **On/Off** in the row shows or hides that filter alone, without touching the others.
- **Delete** removes a filter. The last one cannot be deleted (a layer always keeps at least one).
- **+ Add filter** creates a new filter copied from the selected one, nudged diagonally so you can see it, and made visible.

Everything below the list applies to the selected filter:

- **On / Off** — show or hide the selected filter. `Alt+M` flips it without opening the panel and confirms with a brief on-screen message.
- **Follow** — when on, that filter jumps to your cursor immediately and then tracks it. Drag is disabled for it; resize still works. Several filters can follow at once.
- **Blur** — adjust blur intensity from 0 to 80 px. The visual updates live as you drag; the value is saved when you release the thumb (so dragging doesn't trigger a config write per frame).
- **Fill / Shape / Mode** — segmented controls (Blur·Solid·Pixelate, Rect·Ellipse, Normal·Reverse), so every option is visible instead of hidden behind a cycling button. Solid adds a colour swatch.
- **Save scene / Save studio / Clear preset** — store or remove the preset for the current scene or studio. A preset stores every filter in the layer, not just the selected one.
- **Reset / Shot / Panic** — reset the selected filter to the built-in defaults, copy or download a redacted screenshot (all active filters are applied), or show the local decoy page.

**Drag and resize the filter directly:**

- Drag a filter's body to move it (disabled in Follow mode). Dragging it also selects it.
- Drag the bottom-right grip to resize. The grip and the region's outline only appear while you hover the region, while you drag it, or while the settings panel is open — the filter itself reads as a blur, not as a selection box. While the panel is open every filter shows its outline and the selected one is outlined in blue.
- Position/size are saved when you release the pointer — not on every pixel of movement.

**On the settings page** at **Settings → Tools → Scene Tools → Mosaic Filter** (or `/plugins/mosaicfilter`):

- **Filters** — the list of filters in the layer being edited. Pick one with its radio button, rename it in place, add one (**+ Add filter**) or delete one. Renaming is only available here; the player panel shows the name you set.
- **Filter style** — blur amount, fill mode, shape (Rectangle / Ellipse), mode (Normal / Reverse), solid colour and pixel size — for the selected filter.
- **Geometry** — width, height, and X/Y position of the selected filter, all as percentages of the player.
- **Behavior** — "Active" and "Follow cursor" for the selected filter, plus **Reset this filter**.
- **Presets** — edit the global default or any scene/studio preset; use Save scene / Save studio in the overlay to create one. The list shows how many filters each preset holds.

### Known limitations

- Pixelate is more expensive than blur and is not available in reverse mode; reverse + solid is supported. Each pixelated filter adds its own canvas, so keep it to the regions that need it.
- Two filters in reverse mode are literal: each hides everything outside itself, so only their overlap stays clear. Use reverse on one filter and normal mode on the rest.
- On a short player (below roughly 420 px tall, e.g. a phone in portrait) the settings panel becomes scrollable rather than shrinking further; fullscreen gives it room.
- Screenshot capture depends on a same-origin video; CORS/DRM-protected streams cannot be captured.
- Clipboard copy requires a secure context; the plugin falls back to a PNG download.
- The overlay and settings page keep separate save locks and don't coordinate. Settings edits won't live-reflect in an already-open overlay until the next navigation/reload.
- `backdrop-filter: blur(...)` is used for the blur mode; on browsers that don't support it, the filter degrades to a semi-opaque rectangle rather than a true blur. Stash's bundled Chromium supports it.

---

## Scene Versions

Adds a "Related Scenes" tab to the scene page for associating alternate versions of a scene (same performance, different costume/angle/source). Links are bidirectional — if A links to B, B shows A too. Supports multiple related scenes per scene.

Think of it as a **lightweight alternative to Stash's built-in Groups**. Stash's native grouping requires you to create and name a Group entity up front, then manage membership through it — fine for curated collections, but too "heavy" when all you want is to mark "these scenes are versions of each other." Scene Versions skips the named-group layer entirely: you just link scenes directly to each other, the relationship lives on the scenes themselves (in `custom_fields`), and the back-link is created automatically. No group to name, no extra entity to maintain — just point-and-click peer associations.

### Features

- **Bidirectional auto-sync.** Link once and both scenes show each other — no need to edit both sides.
- **Suggest-from-folder.** Scenes sharing the same file folder surface as quick-add candidates — ranked by how close their filename is to the one you are viewing, and revealed six at a time with **Show more**, so a folder holding hundreds of scenes cannot bury the tab.
- **Cleanup protection.** New links apply the known ignore tags used by Smart Resolve and additionalFilesDeleter, so duplicate cleaners can skip versioned scenes. Protection is per-tool; other cleaners need their own ignore tags.
- **Visible outside the tab.** A scene-card version badge makes versioned scenes recognizable in any grid, and an optional saved filter (`Scene Versions: has alternate cut`) lists them in one place — create it under **Settings → Plugins → Scene Versions**.
- **Comparison and pHash.** Compare duration, resolution, codec, bitrate and date side by side; pHash suggests possible same-shoot scenes without auto-linking.
- **No extra dependency.** Works without CommunityScriptsUILibrary — no csLib required.

### How to use it

Open any scene and click the **Related Scenes** tab (after the Details tab):

- Use the scene picker to select related scenes (filtered to the current folder by default; cross-folder links can be added via suggestions).
- **Save** writes both directions — the linked scenes also get a back-link.
- **Add** from the suggestions list queues a scene without saving (non-destructive). The list shows the closest filenames first; **Show more** reveals the next six, and once the loaded batch is used up it loads another batch from the folder.
- **Discard** reverts to the last saved state.
- **Remove** a related scene — the unlink is applied bidirectionally on save.

**Browsing everything versioned** is a one-time setup, not a per-scene action: go to **Settings → Plugins → Scene Versions** and click **Create saved filter**. The plugin counts the matching scenes first and refuses to create an empty filter, then the filter shows up in **Scenes → Filter → Saved filters**. Stash has no link that opens a saved filter directly, so the plugin cannot jump there for you.

### Known limitations

- Suggest-from-folder uses substring `INCLUDES` on path, so scenes in subfolders whose path contains the folder string may also appear. They are ranked below same-name, same-directory hits rather than hidden, and the list is paged, so they no longer crowd out the tab.
- Filename ranking runs over the batches loaded so far (200 scenes each; the tab loads up to three batches on open, stopping as soon as the current scene is among them). In a folder large enough that the current scene sits beyond that, a better match further down the path order only surfaces after **Show more** has pulled that batch in.
- The saved filter matches on "field present", so a scene whose last link was removed (the field is stored as `[]`) still appears in it. The count shown before creating the filter uses the same rule, so the two always agree.
- Cleanup protection is per-tool. The plugin applies the known Smart Resolve and additionalFilesDeleter tags, but other cleaners use different names; configure their own ignore tag. Protection is not a backup.
- pHash suggestions depend on a generated video pHash and are suggestions only; they never create links automatically.
- Concurrent multi-user edits to the same scene's related list could race (acceptable for typical single-user Stash).
- No batch query — N related scenes trigger N parallel `FindSceneDocument` calls. Fine for small N.

---

## Scene Rotation

Rotates a scene in the player for videos that were encoded sideways, and remembers the angle. The angle is stored on the scene itself (`custom_fields`) rather than in the file or in the browser, so it survives reloads, other browsers and other devices — and **nothing is written to disk**. No re-encode, no `_rotate` copy in the library, no regenerated preview or cover.

The rotation is a CSS transform applied to everything that shows the scene, not just the player: the **hover preview clip** on the scene card, the **cover** on the card grid and scene wall, and the player itself all turn together.

### Features

- **Out of the way by default.** Rotating a scene is a rare operation, so the controls are not an overlay: they live in the **Filters** tab of the scene page, as a small "Rotation" row right under Stash's own rotate/scale buttons. They are on screen only while that tab is open, and the picture is never covered.
- **Or floating, if you prefer.** `SceneRotation.placement("overlay")` moves the same cluster onto the player instead — draggable by its grip (`⠿`), position remembered as a fraction of the player box so it survives navigation, resizing and fullscreen. `placement("filters")` moves it back, `placement("off")` removes it entirely (the console API keeps working).
- **Per-scene memory.** Three buttons — rotate left, rotate right, clear — with the current angle on a badge. The picture follows every click; the write waits until you stop clicking (half a second), so reaching 180° by two clicks is one save, and 0 → 180 → 0 saves nothing at all.
- **The whole UI follows, not just the player.** The card preview clip and the cover artwork are rotated by the same angle, so the scene wall, the card grid and the detail header point the same way as playback instead of showing the same frame sideways.
- **Zero writes.** Nothing but the integer in `custom_fields` is stored. The media file is never re-encoded, no copy appears in the library, and no Stash artifact is regenerated — the covers you see are the untouched originals, rotated in the browser.
- **Fits instead of crops.** After a 90/270 turn the picture is scaled according to the element's own `object-fit`: shrunk so the whole rotated frame fits in the player, grown so a card stays filled the way it was designed to be. Stash anchors card artwork to the top, so that offset is corrected too — the picture does not jump off-centre.
- **Composes with the built-in Filters tab instead of fighting it.** The rotation is applied with the individual `rotate` / `scale` properties, never with `transform` — which is what the Filters panel owns on that same element. Its Transforms sliders keep working, and its values stack on top of the stored angle (a +30° nudge on a 90° scene gives 120°). A watcher puts our properties back in the same frame the panel wipes the inline style, so neither effect flickers.
- **Unsticks the Filters tab when another plugin breaks it.** Stash's panel sends every transform to the first `<canvas>` it finds inside the player, so *any* plugin that leaves an invisible canvas there makes rotate, scale, brightness and contrast all look dead — silently, with no error. This plugin moves such a canvas out of the player, a console warning names it, and the panel goes back to targeting the video. The canvas stays on the page, but the plugin that owns it can no longer use it, so treat this as a stopgap: the real fix is for that plugin to keep its canvas inside a shadow root (`getElementsByTagName` does not cross shadow boundaries) — which is exactly what **Mosaic Filter 0.5.2+** does. `SceneRotation.filtersGuard(false)` turns the check off and hands the canvas back.
- **One query, then nothing.** Rotated scenes are indexed once per page load, so a grid of cards needs no lookup per card, and a library where nobody uses the plugin costs a single request that comes back empty.
- **No dependencies.** Does not need CommunityScriptsUILibrary, PluginApi or a settings page.

### How to use it

1. Open a scene that plays sideways.
2. Open the **Filters** tab on the scene page. Under Stash's own rotate/scale buttons there is a **Rotation** row: `⟲` rotates 90° counter-clockwise, `⟳` 90° clockwise, the badge shows the saved angle, `✕` clears it.
3. The picture rotates instantly; the angle is saved as soon as you stop clicking (about half a second). Reopening the scene — in this browser, another browser, or another device — restores it. The card preview and cover follow automatically.
4. Prefer it on the player? `SceneRotation.placement("overlay")` — then drag it by the `⠿` grip if it covers something else, and double-click the grip to send it back to the top-right corner. `SceneRotation.placement("filters")` returns it to the tab.

For scripted use there is a small console API:

| Call | What it does |
|---|---|
| `SceneRotation.set(180)` | set the angle; resolves once the debounced save lands |
| `SceneRotation.flush()` | commit a pending save immediately |
| `SceneRotation.cycle()` / `.get()` | step by 90° / read the current angle |
| `SceneRotation.angle(id?)` | angle the UI is applying to a scene (the CSS side) |
| `SceneRotation.cover()` | angle already baked into the cover image, `null` if never |
| `SceneRotation.decorate()` | force a redraw pass (after a stylesheet change, say) |
| `SceneRotation.unstick()` | run the Filters-panel canvas check now; returns how many it moved |
| `SceneRotation.filtersGuard(on)` | turn that check off (or back on) |
| `SceneRotation.resetBar()` | put the floating cluster back in the top-right corner |
| `SceneRotation.placement(mode)` | `"filters"` (default) / `"overlay"` / `"off"`; returns the current mode |
| `SceneRotation.reload()` | reload the index of rotated scenes |
| `SceneRotation.resetAll()` | clear every stored angle (see below) |
| `SceneRotation.bakeCover()` | opt-in, **writes**: burn the angle into the cover image |

### What this cannot fix

Two things stay sideways, and neither can be rotated from the browser:

- **The scrubber sprites.** The frame grid under the seek bar (and on the card's hover scrubber) is one sprite-sheet image cropped by CSS. Rotating the element would rotate the crop window with it and break the frame mapping, so it is left alone.
- **Anything that reads the files directly.** Transcodes, other applications, a media player pointed at the same folder. They see the video exactly as encoded.

If you want those right too, the angle has to live in the file's display matrix. That is lossless and creates no new file — `-c copy` only rewrites the container header — but it *is* a write:

```bash
# overwrite in place: same path, same scene, no re-encode
ffmpeg -v error -display_rotation -90 -i "clip.mp4" -map 0 -c copy -movflags +faststart "clip.tmp.mp4"
move /y "clip.tmp.mp4" "clip.mp4"        # Windows; use mv on POSIX
```

`-display_rotation` is **counter-clockwise degrees** and is *absolute*, not cumulative: clockwise 90° is `-90`, and re-running is idempotent. Needs ffmpeg 7.1+ to override an existing matrix. Works for MP4/MOV (tkhd matrix) and MKV (`TAG:ROTATE`); WebM and AVI have no rotation field and need a real re-encode. Afterwards, rescan the scenes and run **Settings → Tasks → Generate** with *Overwrite* so previews, sprites and covers are rebuilt from the rotated file.

Then run `SceneRotation.resetAll()`. Once the file carries a matrix the browser rotates the picture on its own, so a stored angle would rotate it a second time — and there is no reliable way for the frontend to tell (Chrome reports post-rotation dimensions, which are exactly the dimensions Stash scanned either way). The two mechanisms are mutually exclusive, so the plugin has to be told to stand down. `resetAll()` clears `SceneRotation` / `SceneRotationCover` on every scene that has one and returns how many it cleared.

### Known limitations

- Only 0 / 90 / 180 / 270. The value is an integer custom field, so no arbitrary angles.
- **Sprites and third-party clients stay sideways** — see [What this cannot fix](#what-this-cannot-fix).
- Cover artwork is rotated with CSS, so with `object-fit: cover` (landscape cards) a 90° turn shows a zoomed centre crop rather than the whole frame; with `object-fit: contain` (portrait cards — which is what a sideways recording produces) it fills the card exactly.
- A cover already baked by an earlier version of this plugin (0.2–0.4) keeps its baked angle: the CSS angle is `rotation - cover`, so those scenes are not rotated twice. If the cover was regenerated since (Generate task, rescrape), that marker is stale and the card is off by the difference — `SceneRotation.bakeCover()` realigns it, and that one writes.
- The scene's own **Filters** tab still forgets its sliders on navigation — only rotation is persisted here. Its Transforms values now stack on top of the stored angle rather than overriding it, so pick one: either use the stored rotation (the `⠿` cluster) or the panel's rotate/scale for fine nudges, and reset the panel when you are done.
- Only the main `#VideoJsPlayer` plus scene media elsewhere on the page is handled; multi-player surfaces (Stash TV, grid plugins) are not rotated.
- A pending save is committed on scene change, on leaving the scene page, and on page unload (`keepalive`), so a click followed by immediate navigation is not lost.
- Stash versions without `custom_fields` play the scene unrotated and log a warning instead of failing.

---

## Audio Support

Plays audio files (mp3, flac, m4a, ogg, opus, wav) inside Stash. Because Stash has no native audio type (verified up to v0.32.0 — [PR #6824](https://github.com/stashapp/stash/pull/6824) is still open), the plugin works around this by treating audio files as scenes (the Setup wizard adds audio extensions to Stash's video-extension list). A dedicated audio overlay replaces the video player for audio-only scenes, with synced LRC lyrics, a play queue with auto-advance, and a browse page for navigating your audio library.

### Features

- **Audio-as-scene playback.** Audio files are ingested as scenes and played back with a dedicated HTML5 audio overlay (direct stream only — no broken transcodes). The video.js player is replaced entirely for audio-only scenes.
- **Synced LRC lyrics.** Upload or paste `.lrc` text in the overlay; lyrics scroll in sync with playback, highlight the current line, auto-scroll, and click any line to seek. Lyrics are stored per-scene. Offset calibration, bilingual lines and line-level karaoke highlight are included.
- **Cross-page dock.** Playback continues after SPA navigation in a bottom-right dock; the dock has play/pause, prev/next and close controls. Resume time and play duration are written back to Stash with `sceneSaveActivity`, and play starts are recorded with `sceneAddPlay`.
- **Long-form controls.** Scene markers become chapters; add a sleep timer (5/15/30/60 minutes) and per-scene bookmarks.
- **Play queue + auto-advance.** Build a queue from any browse view ("Play Work", "Play All", or a single track). The overlay auto-advances to the next track when the current one ends. Repeat modes: off / all / one. Prev/next buttons + queue indicator in the transport bar. Keyboard shortcuts: `n` (next), `p` (prev), `r` (repeat).
- **Browse page.** Three views under the Browse tab: **By Work** (groups audio by parent directory, natural-sorted chapters, "Play Work" queues the whole work), **All Audio** (flat grid with search/sort, "Play All" queues the filtered list), **By Tag** (tag cards → scene grid, "Play All" queues the tag's scenes).
- **Cover art.** Extract embedded cover art from MP3/ID3v2, FLAC, and M4A files, or generate default gradient covers via canvas. Stored as scene cover blobs.
- **Generate without audio errors.** The **Generate** tab queues Stash's generate options (previews, sprites, phashes, markers, covers) for every scene *except* audio-tagged ones, so audio-only scenes never reach the ffmpeg subtasks that fail on them. Transcodes are never queued — Stash would write a blank video for audio.
- **Top-nav entry.** An "Audio" link in the main navigation bar (toggleable on the Setup tab).

### How to use it

**1. Enable audio ingestion** on the settings page at **Settings → Tools → Scene Tools → Audio Support** (or click the **Audio** entry in the top nav):

- The **Setup** tab shows which audio extensions are missing from Stash's `VideoExtensions` config. Click to add them (mp3, flac, m4a, ogg, opus, wav). Then run a scan so Stash ingests your audio files as scenes.
- Run the **Tag all audio scenes** task once (Settings → Plugins → Audio Support → Tasks) to tag already-ingested audio scenes.

**2. Browse your audio library** on the **Browse** tab:

- **By Work** — audio grouped by parent directory (e.g. an audiobook or album). Click a work card to see its chapters in natural order. **Play Work** queues all chapters and starts playing the first.
- **All Audio** — every audio scene in a flat grid. Search and sort, then **Play All** to queue the filtered list.
- **By Tag** — tags on your audio scenes as cards. Click a tag to see its scenes, then **Play All** or play a single track.

**3. Play a track.** The audio overlay replaces the video player:

- Transport: play/pause, seek, volume, playback speed (0.5x–2x), loop, prev/next (when in a queue), repeat mode, queue indicator (`N / M`).
- **Load LRC** — upload a `.lrc` file or paste LRC text. Lyrics sync to playback; click a line to seek there.
- Keyboard: Space (play/pause), ←/→ (seek 5s), ↑/↓ (volume), `m` (mute), `l` (loop), `k` (collapse/expand), `n` (next), `p` (prev), `r` (repeat cycle).

**4. Generate previews and sprites safely** on the **Generate** tab:

- Stash's own **Settings → Tasks → Generate** walks every scene, audio included. Audio-only files have no video stream, so the preview/sprite/phash/cover subtasks fail for them and fill the log with errors.
- The Generate tab queues for the video scenes only. **Previews** are the only subtask enabled by default; sprites, phashes, markers and covers are opt-in. Click **Queue generate for video scenes** and it lands in **Settings → Tasks** as **one** generate job, because the plugin passes every scene id in a single `metadataGenerate` call — batching would show up as several tasks running back to back.
- Audio scenes are excluded two ways: the audio tag filters most of them out server-side, and a per-file probe catches any scene the tag misses (for example one scanned while generate was already running). Anything the probe finds untagged is tagged on the way through, so the tag stays the fast path.
- **Tag all audio scenes** is still worth running once on a library that predates the plugin — it is faster than letting each generate run probe for gaps. The same work is available as the **Generate (skip audio scenes)** plugin task under **Settings → Plugins**.

### Known limitations

- **Audio files are ingested as scenes**, not as a native audio type. This is a workaround for Stash up to and including v0.32.0; the plugin is designed to migrate once native audio support lands (see [stashapp/stash#6824](https://github.com/stashapp/stash/pull/6824)).
- **LRC lyrics are manual upload/paste only** — the plugin cannot auto-detect `.lrc` files on disk (the backend hook runs in a sandboxed JS VM with no file I/O).
- **Embedded cover extraction** supports MP3/ID3v2, FLAC, and M4A. OGG and Opus files do not expose embedded art via the library used; use the "generate default cover" option for those.
- **Direct stream playback only.** All transcode endpoints fail for audio-only input; the overlay uses the direct stream URL exclusively.
- **The built-in Generate task still touches audio scenes.** Stash's generate job takes either explicit scene ids or everything — there is no tag filter and no plugin hook — so the plugin cannot stop it. Use the Generate tab (or the plugin task) instead.
- **Transcode is never offered** for the plugin's generate path: Stash's transcode task treats an audio-only file as a video and writes a blank file. If you need transcodes, run them from Stash on a selection that excludes audio scenes.
- **ffmpeg 9 breaks preview generation for VFR sources.** Stash appends `-vsync 2` whenever the framerate looks variable, and ffmpeg 9 removed that flag, so the command fails with `Unrecognized option 'vsync'` before it reads the file. Point Stash's `ffmpegPath` at a build that still accepts `-vsync`, or wait for the upstream fix. A genuinely corrupt file fails differently (`Invalid NAL unit size`), and no plugin setting can skip it.
- The overlay and settings page keep separate save locks and don't coordinate. Settings edits won't live-reflect in an already-open overlay until the next navigation/reload. Queue state is stored in a separate config key to avoid being wiped by this race.

---

## Carbon Arc

A dark theme built for one setup: a 24-inch desktop screen, used at night, with a wall of thumbnails in front of you. The interface is graphite and quietly stepped; the only warm colour in it is a single low-chroma signal, spent on state rather than on surfaces. Nothing on screen is brighter than the picture you are looking at.

### Features

- **Five surfaces, not one.** Sunken wells, page ground, panels, cards and floating menus sit between L\* 3.9 and 15.4. Structure comes from the luminance step; hairline borders only confirm it, which is why nothing reads as a drawn box.
- **Bone instead of white.** Text is `#E6E4DE` (13.2:1 on a card), not `#FFF` — white on a dark ground grows a halo and makes 13 px labels shimmer. Three text steps only, so hierarchy is unambiguous.
- **One signal, used sparingly.** The accent marks state and nothing else: the active nav underline, the keyboard focus ring, filled rating stars, the player's playhead and the knob of a switch that is on. Primary buttons are filled bone, not coloured, so the highest-contrast thing on screen is always the next action — with zero saturation.
- **Every number is monospaced.** Durations, counts, resolutions, dates and file paths use IBM Plex Mono, so a row of cards aligns on its data instead of its prose. IBM Plex Sans and Mono (latin subset, SIL OFL) ship inside the plugin, so the files load from your own server rather than a font CDN.
- **Three signals, two densities, one dimmer.** Arc (brass, default), Patina (oxidised green) and Dusk (muted violet); comfortable or compact card spacing; thumbnails at full or 90% brightness.
- **It only paints.** Nav height, sidebar width, root font size, grid column maths and every control stay exactly where Stash put them — the theme rewrites colour, type, radii, shadows and spacing inside cards, and hides nothing. Every Stash feature keeps working, including plugins layered on top.
- **Details that keep a dark UI usable.** A 2 px focus ring on every interactive element, `prefers-reduced-motion` respected, `scrollbar-gutter: stable` so filtering does not reflow the grid, and a thin dark scrollbar.

### How to use it

1. Install **Carbon Arc** from the source list, enable it, and reload. Nothing else is required — no csLib, no other plugin, and no Stash-side setting to change first: Stash v0.32 has no theme switch, and Carbon Arc paints every surface itself.
2. Open **Settings → Tools → Carbon Arc** (or `/plugins/carbonarc`): pick a signal, a card density and preview brightness. Changes apply as you click.
3. **Optional — the login page.** Stash does not load plugins before you log in, so that page cannot inherit the theme. The settings page has a **Copy login CSS** button; paste the block into **Settings → Interface → Custom CSS** and turn on the custom CSS toggle above that box. The block is generated for the signal colour you have selected, so pick the signal first if you are changing it.
4. Turn off other themes and custom CSS colour overrides. Two themes on one page fight, and the last stylesheet wins section by section.

### What it covers

Shell and top nav, filter rail and toolbars, grid cards and their overlays, list and table views, detail pages and tabs, the video.js player and scrubber, the lightbox, modals and menus and popovers and toasts, forms and React-Select and tag chips, settings pages and log output, scrollbars, and focus/hover/disabled states.

The full token set, the measured contrast pairs and the selector inventory are in [`docs/carbon-arc-theme.html`](docs/carbon-arc-theme.html).

### Known limitations

- **The login page needs the custom CSS step.** It is the one screen a plugin cannot touch.
- **The pasted login CSS does not load IBM Plex.** The block declares the font stack but cannot reach the plugin's bundled font files from a logged-out page, so the login screen uses the system UI font.
- **Third-party plugins that hard-code colours** (overlays with their own palettes) will keep those colours. The theme covers Stash's own markup, not other plugins' inline styles.
- **No mobile pass.** The design targets 1920×1080 on a 24-inch display; phone layouts are left to Stash and are not tuned.
- **Without csLib, the three options live in `localStorage`** for that browser only. The settings page says which storage is in use.
- **Compact density changes card padding and margin, not column count** — Stash owns the grid maths, and a theme that overrode it would break card sizing on other screens.
- **Long values wrap rather than truncating in the middle.** A middle ellipsis needs the string, which CSS cannot read; detail values and file paths break instead of clipping.
- **Not yet through a live functional pass.** The CSS is reviewed against the current Stash markup and the settings page is exercised in a browser harness, but the November 2026 pass has not re-run the full live matrix (see [Tested environment](#tested-environment)). Report anything that stays Stash-blue.

---

## External Link Groups

Stash already collects every profile URL a performer or studio has. What it does with them is one generic link icon plus a hard-coded Twitter and Instagram split, so the sites you actually use — OnlyFans, ManyVids, a personal site — are buried three clicks deep in a menu of raw URLs. This plugin lets you name those sites once, and gives each one its own button in the title row.

### Features

- **Exact-domain control.** A domain on your list claims only URLs on that host (a leading `www.` is ignored, subdomains are not). Everything else — plus every entry you switch off — is handed back to Stash, which renders it exactly as it did before the plugin existed.
- **Two behaviours per site.** *Separate* gives the site its own icon button. *Not separate* groups it into one "Configured links" button, for sites you want convenient but not prominent.
- **Real favicons, cached.** The button shows the site's own icon, found by trying the site's `/favicon.ico` first, then DuckDuckGo, then Google. Only the source URL is cached locally (30 days for a hit, 6 hours for a miss); a broken image falls through to the next source by itself and ends on a letter tile rather than a hole.
- **One click or a menu.** A site with a single URL opens it in a new tab directly. A site with several opens a list — the same rule Stash applies to its own link button, applied per site.
- **Config order is button order.** Reorder with the arrows in the settings page; the icons follow.
- **No dependencies.** No csLib requirement, no GraphQL, no backend hook. With csLib installed the domain list is stored in Stash's plugin configuration; without it, in this browser.

### How to use it

1. Install **External Link Groups** from the source list and enable it.
2. Open **Settings → Tools → External Link Groups** (or `/plugins/externalurlgroups`).
3. Add a domain — `onlyfans.com` or a pasted profile URL both work, it is reduced to the host. Choose **Enabled** and, if you want it promoted, **Separate button**.
4. Save, then open any performer, studio or group page. The configured sites appear as their own icons next to the favourite star, before Stash's own buttons.
5. Icons that look wrong or blank: use **↻** on that row, or **Clear icon cache**, and reload.

### Known limitations

- **Exact host only.** `onlyfans.com` does not claim `fan.onlyfans.com`; add the subdomain as its own entry if a site puts profiles there.
- **Icons come from the network.** First load of a new domain makes one request per candidate (up to three, 4 s each) before falling back to the letter tile. Offline, or behind a block on the icon services, only the site's own `/favicon.ico` can succeed.
- **Not a StashDB feature.** The plugin reads the URLs already on the entity; it does not fetch new ones, and it does not touch the URLs shown in the edit form.
- **Conflicts with External Links Enhanced.** Both replace the same component and that plugin does not chain, so enable one of the two, not both.
- **Not yet through a live functional pass.** The model and the patch are covered by `node:test` (including a stub render), but CSS placement and icon loading have not been exercised against a running Stash in the November 2026 pass (see [Tested environment](#tested-environment)).

---

## Repository layout

```
plugins/                    # one subdirectory per plugin
  QuestingAdventurer/       # manifest + JS/CSS assets
  MosaicFilter/             # manifest + JS/CSS assets
  SceneVersions/            # manifest + JS/CSS assets
  SceneRotation/            # manifest + JS/CSS assets
  AudioSupport/             # manifest + JS/CSS assets + backend hook
  CarbonArc/                # theme: stylesheet + bundled fonts + config helper + settings page
  ExternalLinkGroups/       # detail-title button patch + settings page
build_site.sh               # zips each plugin and generates index.yml
scripts/sync_labels.py      # creates/updates issue labels from .github/labels.json
.github/workflows/          # deploys the source index to GitHub Pages
```

Architecture, per-plugin data models, and the non-obvious implementation traps live in [`AGENTS.md`](AGENTS.md) — that single file is the architectural source of truth for contributors and coding agents. Deeper Stash API notes are in [`docs/`](docs/).

## Publishing

Plugins are built and published automatically. On push to `plugins/**` on `main`, the `deploy.yml` workflow runs `build_site.sh`, which zips each plugin directory and writes `index.yml` (with sha256, version, and metadata), then deploys the result to GitHub Pages.

To publish manually from a fork: open **Settings → Pages** and set the source to **GitHub Actions**.

## Feedback

All plugins are actively being shaped by user feedback. If you have a use case the current features don't cover, a workflow that feels awkward, or an idea for a new mode/trigger/move behavior, please:

- Open a [GitHub issue](https://github.com/stashalizer/stashapp-plugins-vault/issues), or
- Reply to the announcement thread on the [stashapp community forum](https://discourse.stashapp.cc/c/plugins/18/none).

Particularly interested in: what kinds of triggers/moves you actually build, whether per-scene Mosaic Filter config would be useful, what overlay interactions feel missing, and whether folder-based scene suggestions are the right discovery mechanism for Scene Versions.

## License

[AGPL-3.0](LICENCE).