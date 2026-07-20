# stashapp-plugins-vault

A Stash plugin source-index repository that packages and publishes Stash plugins via GitHub Pages. Built on the official [CommunityScripts](https://github.com/stashapp/CommunityScripts) template.

## Plugins

### Questing Adventurer

Turns scene playback into a quest: while a scene plays, the viewer is a "questing adventurer" who must respond to on-screen cues (gestures, dance moves, etc.) by performing the active moves from their quest log. The plugin surfaces the active triggers and their attached moves in a player overlay; the full library is managed in a settings page.

- **Player overlay** — a collapsible panel pinned to the top-right of the scene player. Shows the active-move count when collapsed; expands to list quests and moves with inline add/edit/delete.
- **Settings page** — a full-page CRUD interface at **Settings > Tools > Scene Tools > Questing Adventurer** (`/plugins/questingadventurer`) for managing the full trigger + move library.
- **2-level structure** — top-level nodes are either standalone moves or quests; quests group leaf moves.
- **Active / inactive** — every move has an `active` flag. The overlay only surfaces active moves; the settings page shows the whole library and lets you toggle moves in or out of the active set.
- **Persisted** — all state is saved to Stash configuration under the key `QuestingAdventurer` and survives navigation/reload. A one-shot migration imports the legacy `SceneRules` key on first load.

#### Requirements

- [CommunityScriptsUILibrary](https://github.com/stashapp/CommunityScripts/tree/main/plugins/CommunityScriptsUILibrary) (`csLib`) — required by the overlay.
- The settings page additionally uses Stash's built-in `PluginApi` (React + router).

#### Install

Add this repository as a plugin source in Stash (**Settings > Plugins > Available Plugins > Add Source**):

```
https://stashalizer.github.io/stashapp-plugins-vault/main/index.yml
```

Then install **Questing Adventurer** from the list. Ensure `CommunityScriptsUILibrary` is installed first.

## Repository layout

```
plugins/                    # one subdirectory per plugin
  QuestingAdventurer/       # QuestingAdventurer plugin (manifest + JS/CSS assets)
build_site.sh               # zips each plugin and generates index.yml
.github/workflows/          # deploys the source index to GitHub Pages
```

A full architectural codemap lives in [`codemap.md`](codemap.md); per-folder maps are alongside each directory.

## Publishing

Plugins are built and published automatically. On push to `plugins/**` on `main`, the `deploy.yml` workflow runs `build_site.sh`, which zips each plugin directory and writes `index.yml` (with sha256, version, and metadata), then deploys the result to GitHub Pages.

To publish manually from a fork: open **Settings > Pages** and set the source to **GitHub Actions**.

## License

[AGPL-3.0](LICENCE).
