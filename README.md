# stashapp-plugins-vault

A collection of Stash plugins that add interactive overlays to the scene player. Install once from a single plugin source, then turn on whichever plugins you want.

> **Looking for feedback!** This project is still evolving and I'd love to hear what you'd use, what feels awkward, and what features you wish existed. Please open a [GitHub issue](https://github.com/stashalizer/stashapp-plugins-vault/issues) or find the announcement thread on the [stashapp community forum](https://discourse.stashapp.cc/c/plugins/18/none).

## Plugins

- **[Questing Adventurer](#questing-adventurer)** — turns scene playback into a quest: respond to on-screen cues by performing the moves attached to your active triggers.
- **[Mosaic Filter](#mosaic-filter)** — a movable, resizable blur rectangle (or ellipse) over any region of a scene, with a follow-cursor mode and a reverse mode that blurs everything *except* the filter area.
- **[Scene Versions](#scene-versions)** — a "Related Scenes" tab on the scene page that links alternate versions of a scene (same dance, different costume, different angle) bidirectionally, with a suggest-from-folder helper.

## Requirements (all plugins)

- [Stash](https://github.com/stashapp/stash) (tested against the v0.31.x line).
- [CommunityScriptsUILibrary](https://github.com/stashapp/CommunityScripts/tree/main/plugins/CommunityScriptsUILibrary) (`csLib`) — **install this first.** QuestingAdventurer and MosaicFilter depend on it; their player overlays will not load without it. SceneVersions is standalone and does not require csLib.
- The full-page settings UIs additionally use Stash's built-in `PluginApi` (React + router), which ships with Stash — nothing extra to install. SceneVersions also uses `PluginApi` for its tab injection.

## Tested environment

Each plugin has been **code-reviewed and functionally tested** before release — overlays, settings pages, persistence, and migrations all verified against real Stash sessions. Testing is done primarily on **Windows** (desktop Stash + Chromium-based browser). Other environments (macOS, Linux, mobile/touch browsers, other Stash versions) are **not yet tested**. If you run into issues on those platforms, please report them in a [GitHub issue](https://github.com/stashalizer/stashapp-plugins-vault/issues) — it helps expand the tested matrix.

## Install

Add this repository as a plugin source in Stash:

1. Open **Settings → Plugins → Available Plugins → Add Source**.
2. Paste this URL:
   ```
   https://stashalizer.github.io/stashapp-plugins-vault/main/index.yml
   ```
3. Install **Questing Adventurer**, **Mosaic Filter**, and/or **Scene Versions** from the list.
4. Make sure **CommunityScriptsUILibrary** is installed and enabled — the overlays depend on it.

QuestingAdventurer and MosaicFilter each appear in two places: a **player overlay** on every scene page, and a **settings page** under **Settings → Tools → Scene Tools**. SceneVersions instead adds a **tab** to the scene page (no overlay, no settings page).

---

## Questing Adventurer

Turns scene playback into a quest. While a scene plays, the viewer is a "questing adventurer" who must respond to on-screen cues (a gesture, a dance move, a spoken phrase — whatever you define) by performing the moves attached to their **active** triggers. Think of it as a randomized, self-directed challenge layer over any scene.

### Why you might like it

- **You define the vocabulary.** You build a library of *moves* (short text strings — "left hand", "slow grind", "hold eye contact", anything) and a library of *triggers* (named cues — "Dance Break", "Eye Contact", "Whisper"). You attach any number of moves to each trigger.
- **Randomized play.** The **Penalty** and **Reward** buttons on the overlay randomly activate/deactivate triggers and attach/detach moves, so the same scene plays differently every time.
- **Two surfaces, one library.** Manage the full library on the settings page; the overlay only shows what's currently *active* so it stays out of your way during playback.

### How to use it

**1. Set up your library** on the settings page at **Settings → Tools → Scene Tools → Questing Adventurer** (or `/plugins/questingadventurer`):

- **Move Library** — add the moves you want to be able to perform. Each move shows which triggers use it (or "Unattached" if none). Double-click any move to rename it; delete with the trash button (detaching it from any triggers that use it, with a confirm prompt).
- **Triggers** — add named triggers and attach moves to each. A trigger with no attached moves is `active: false` by design — it won't show on the overlay until it has moves. Reorder triggers with ▲/▼, rename by double-clicking, and use "Add Move" on a trigger to create a move *and* attach it in one step.

**2. Play a scene.** The overlay appears as a collapsible panel pinned to the top-right of the player. The collapsed chip shows `🗺️ Triggers (N)` where N is the number of active triggers.

**3. Use the overlay during playback:**

- **Penalty** — picks a random *inactive* trigger, activates it, and attaches a random *unattached* move from your library. If every trigger is already active, it picks an active trigger and just attaches a move. If the library has no unattached moves left, the trigger is still activated (the move part is a no-op).
- **Reward** — picks a random *active* trigger that still has attached moves and removes a random attached move. If a trigger ends up with zero attached moves, it's set back to `active: false`.
- **➕ Add toggle** — reveals an inline footer for adding a new trigger or a new move on the fly without leaving the player.
- **🔒 Lock** — hides the row drag handles, disables panel dragging, and dims Penalty/Reward/opacity so you can't accidentally change things mid-scene.
- **Opacity slider** (hover-reveal) — controls the panel's background alpha. Ctrl/⌘+click the icon to reset to default.
- **Manual Selection library** — for fine-grained control the random buttons can't give you: explicitly activate any inactive trigger, or attach any library move to any trigger via a dropdown. Lets you set up a specific configuration instead of relying on randomness.
- **Drag to reorder** — grab a row's handle to reorder triggers and moves (touch-friendly; disabled while locked).
- **✕ Close** — collapses the panel to the chip.

### Features at a glance

- Global move library + triggers that reference moves by id; `active` lives on the trigger.
- Randomized Penalty/Reward for replay variety, plus a Manual Selection mode for deterministic setups.
- Collapsible, draggable, lockable, opacity-adjustable overlay that survives navigation and reload.
- Inline add/edit/delete from both the overlay and the settings page.
- One-shot migration from the legacy `SceneRules` key on first load (safe to run repeatedly; no-ops once done).

### Known limitations

- The overlay and the settings page keep separate save locks and don't coordinate. If you edit the settings page while the overlay is open, the overlay won't reflect the changes until you navigate away and back (or reload). Avoid editing both at the same instant.
- A brief flash can occur between React unmounting the player area and the overlay re-injecting on SPA navigation — this is expected and resolves instantly.

---

## Mosaic Filter

A toggleable, movable, and resizable blur overlay for any region of a scene. Use it to censor a watermark, blur a face or UI element, or — with **reverse mode** — blur everything *except* the region you want to focus on. The filter can be a rectangle or an ellipse, and an optional **follow-cursor** mode makes it track your pointer.

### Why you might like it

- **Two blur directions.** *Normal* mode blurs the area inside the filter. *Reverse* mode blurs everything *outside* the filter and leaves the filter area clear — handy for "spotlight" style viewing.
- **Two shapes.** Rectangle (default) or ellipse — the reverse-mode hole is cut precisely to match, using a `clip-path: path()` technique that works across modern Chromium/Firefox/Safari.
- **Follow-cursor.** Turn it on and the filter re-centers on your pointer as you move it — no dragging needed. Drag is disabled in this mode (resize still works).
- **Touch-friendly drag and resize.** Pointer-events based, so it works on tablets/touchscreens, not just mouse.
- **One global config.** Position and size are stored as percentages of the player, so the filter scales correctly on resize and across viewports. All scenes share the same filter — open any scene and it's right where you left it.

### How to use it

**On the player** — a compact control bar appears on the scene player:

- **On / Off** — show or hide the filter rectangle.
- **Blur slider** — adjust blur intensity from 0 to 80 px. The visual updates live as you drag; the value is saved when you release the thumb (so dragging doesn't trigger a config write per frame).
- **Follow** — when on, the filter jumps to your cursor immediately and then tracks it. Drag is disabled; resize still works.
- **Shape** — toggle between `▭ Rectangle` and `● Ellipse`.
- **Mode** — toggle between `▣ Normal` (blur inside the filter) and `◈ Reverse` (blur everywhere outside the filter).
- **Reset** — restore defaults.
- **✕ Close** — collapse the control bar (the filter stays if it's on). Click the chip to bring the bar back.

**Drag and resize the filter directly:**

- Drag the rectangle body to move it (disabled in Follow mode).
- Drag the bottom-right handle to resize.
- Position/size are saved when you release the pointer — not on every pixel of movement.

**On the settings page** at **Settings → Tools → Scene Tools → Mosaic Filter** (or `/plugins/mosaicfilter`):

- **Filter style** — blur amount, shape (Rectangle / Ellipse), mode (Normal / Reverse).
- **Geometry** — width, height, and X/Y position, all as percentages of the player.
- **Behavior** — "Active by default" and "Follow cursor by default" checkboxes, then **Save**.

### Features at a glance

- Normal and reverse blur modes; rectangle and ellipse shapes.
- Follow-cursor mode with immediate snap (no lag from the saved position).
- Drag and resize via pointer events (mouse + touch).
- Single global config shared by all scenes; percentages of the player so it scales on resize.
- Legacy `{ defaults, scenes }` config from v0.2.x and earlier is migrated automatically on load (the `defaults` object is used; `scenes` is ignored; the next save writes the flat shape).

### Known limitations

- The config is **global, not per-scene** — every scene shares the same filter position, size, and settings. If you need different filters for different scenes, that's not supported yet (feedback welcome).
- The overlay and settings page keep separate save locks and don't coordinate. Settings edits won't live-reflect in an already-open overlay until the next navigation/reload.
- `backdrop-filter: blur(...)` is used for the effect; on browsers that don't support it, the filter degrades to a semi-opaque rectangle rather than a true blur. Stash's bundled Chromium supports it.

---

## Scene Versions

Adds a "Related Scenes" tab to the scene page for associating alternate versions of a scene (same performance, different costume/angle/source). Links are bidirectional — if A links to B, B shows A too. Supports multiple related scenes per scene.

### Why you might like it

- **Bidirectional auto-sync.** Link once and both scenes show each other — no need to edit both sides.
- **Suggest-from-folder.** Scenes sharing the same file folder surface as quick-add candidates, so the most likely related scenes are one click away.
- **Multi-select picker restricted to the current scene's folder.** The dropdown only shows scenes in the same folder by default, making it easy to find related content without paging through the whole library.
- **No extra dependency.** Works without CommunityScriptsUILibrary — no csLib required.

### How to use it

Open any scene and click the **Related Scenes** tab (after the Details tab):

- Use the scene picker to select related scenes (filtered to the current folder by default; cross-folder links can be added via suggestions).
- **Save** writes both directions — the linked scenes also get a back-link.
- **Add** from the suggestions list queues a scene without saving (non-destructive).
- **Discard** reverts to the last saved state.
- **Remove** a related scene — the unlink is applied bidirectionally on save.

### Features at a glance

- Bidirectional custom_fields links — link once, both scenes reflect it.
- Suggest-from-folder helper — other scenes in the same folder appear as quick-add buttons.
- Folder-scoped picker — the multi-scene dropdown is restricted to the current scene's folder.
- Standalone — no csLib dependency, no per-plugin config key.
- Tab-only — no player overlay, no settings page.

### Known limitations

- Suggest-from-folder uses substring `INCLUDES` on path, so scenes in subfolders whose path contains the folder string may also appear. This is usually fine since folders hold few scenes, and irrelevant suggestions can be ignored.
- Concurrent multi-user edits to the same scene's related list could race (acceptable for typical single-user Stash).
- No batch query — N related scenes trigger N parallel `FindSceneDocument` calls. Fine for small N.

---

## Repository layout

```
plugins/                    # one subdirectory per plugin
  QuestingAdventurer/       # manifest + JS/CSS assets
  MosaicFilter/             # manifest + JS/CSS assets
  SceneVersions/            # manifest + JS/CSS assets
build_site.sh               # zips each plugin and generates index.yml
.github/workflows/          # deploys the source index to GitHub Pages
```

A full architectural codemap lives in [`codemap.md`](codemap.md); per-folder maps are alongside each plugin directory. These are aimed at contributors and plugin developers, not end users.

## Publishing

Plugins are built and published automatically. On push to `plugins/**` on `main`, the `deploy.yml` workflow runs `build_site.sh`, which zips each plugin directory and writes `index.yml` (with sha256, version, and metadata), then deploys the result to GitHub Pages.

To publish manually from a fork: open **Settings → Pages** and set the source to **GitHub Actions**.

## Feedback

All three plugins are actively being shaped by user feedback. If you have a use case the current features don't cover, a workflow that feels awkward, or an idea for a new mode/trigger/move behavior, please:

- Open a [GitHub issue](https://github.com/stashalizer/stashapp-plugins-vault/issues), or
- Reply to the announcement thread on the [stashapp community forum](https://discourse.stashapp.cc/c/plugins/18/none).

Particularly interested in: what kinds of triggers/moves you actually build, whether per-scene Mosaic Filter config would be useful, what overlay interactions feel missing, and whether folder-based scene suggestions are the right discovery mechanism for Scene Versions.

## License

[AGPL-3.0](LICENCE).