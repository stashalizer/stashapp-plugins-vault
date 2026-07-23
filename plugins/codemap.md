# plugins/

## Responsibility
Container directory for Stash plugins. Each immediate subdirectory is one self-contained plugin, packaged as a zip by `build_site.sh` and listed in the published source index (`index.yml`).

## Design
- One subdirectory per plugin, named after the plugin id.
- Each plugin directory contains its manifest (`*.yml`) plus the JS/CSS assets referenced by the manifest.
- The build script zips the entire plugin directory and extracts metadata (name, description, version, requires) from the manifest.

## Flow
1. Developer adds/edits files under `plugins/<plugin-id>/`.
2. On push to `main`, `.github/workflows/deploy.yml` runs `build_site.sh`, which finds every `*.yml` under `plugins/`, zips each plugin directory, and appends an entry to `index.yml`.
3. Output is published to GitHub Pages as the plugin source index.

## Integration
- Consumed by: `build_site.sh` (build), `.github/workflows/deploy.yml` (CI deploy).
- Currently contains: `QuestingAdventurer/` (see [QuestingAdventurer codemap](QuestingAdventurer/codemap.md)), `MosaicFilter/` (see [MosaicFilter codemap](MosaicFilter/codemap.md)), and `SceneVersions/` (see [SceneVersions codemap](SceneVersions/codemap.md)).
