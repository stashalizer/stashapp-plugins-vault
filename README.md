# stashapp-plugins-vault

A Stash plugin source-index repository that packages and publishes Stash plugins via GitHub Pages. Built on the official [CommunityScripts](https://github.com/stashapp/CommunityScripts) template.

## Plugins

### Scene Rules

An interactive overlay and full-page settings UI for managing a global, 2-level list of "viewing rules" displayed on the scene player.

- **Player overlay** — a collapsible panel pinned to the top-right of the scene player. Shows a rule-count chip when collapsed; expands to list all rules and categories with inline add/edit/delete.
- **Settings page** — a full-page CRUD interface at **Settings > Tools > Scene Rules** (`/plugins/scenerules`) for managing the same rules with more room.
- **2-level structure** — top-level nodes are either standalone rules or categories; categories group leaf rules.
- **Persisted** — all rules are saved to Stash configuration under the key `SceneRules` and survive navigation/reload.

#### Requirements

- [CommunityScriptsUILibrary](https://github.com/stashapp/CommunityScripts/tree/main/plugins/CommunityScriptsUILibrary) (`csLib`) — required by the overlay.
- The settings page additionally uses Stash's built-in `PluginApi` (React + router).

#### Install

Add this repository as a plugin source in Stash (**Settings > Plugins > Available Plugins > Add Source**):

```
https://stashalizer.github.io/stashapp-plugins-vault/main/index.yml
```

Then install **Scene Rules** from the list. Ensure `CommunityScriptsUILibrary` is installed first.

## Repository layout

```
plugins/           # one subdirectory per plugin
  SceneRules/      # SceneRules plugin (manifest + JS/CSS assets)
build_site.sh      # zips each plugin and generates index.yml
.github/workflows/ # deploys the source index to GitHub Pages
```

A full architectural codemap lives in [`codemap.md`](codemap.md); per-folder maps are alongside each directory.

## Publishing

Plugins are built and published automatically. On push to `plugins/**` on `main`, the `deploy.yml` workflow runs `build_site.sh`, which zips each plugin directory and writes `index.yml` (with sha256, version, and metadata), then deploys the result to GitHub Pages.

To publish manually from a fork: open **Settings > Pages** and set the source to **GitHub Actions**.

## License

[AGPL-3.0](LICENCE).
