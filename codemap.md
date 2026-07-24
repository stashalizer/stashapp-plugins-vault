# Repository Atlas: stashapp-plugins-vault

## Project Responsibility
A Stash plugin source-index repository (based on the official CommunityScripts template) that packages and publishes Stash plugins via GitHub Pages. Currently ships three plugins:
- **QuestingAdventurer** — an interactive overlay and settings page that turns scene playback into a quest: the viewer is a "questing adventurer" who must respond to cues in the playing scene by performing the moves attached to their active triggers.
- **MosaicFilter** — a player overlay that places a movable, resizable rectangle (or ellipse) over any region of a scene to blur or censor it, with optional follow-cursor and reverse-blur modes; a full-page React settings page edits the same global config.
- **SceneVersions** — a "Related Scenes" tab on the scene page that lets users associate alternate versions of a scene via bidirectional links stored in scene custom fields, with a suggest-from-folder helper.

## System Entry Points
- `plugins/QuestingAdventurer/QuestingAdventurer.yml` — plugin manifest; declares the QuestingAdventurer plugin to Stash (name, description, version, required dependency, asset list).
- `plugins/MosaicFilter/MosaicFilter.yml` — plugin manifest; declares the MosaicFilter plugin to Stash (name, description, version, required dependency, asset list).
- `plugins/SceneVersions/SceneVersions.yml` — plugin manifest; declares the SceneVersions plugin to Stash (name, description, version, asset list; no csLib dependency).
- `build_site.sh` — build script that zips each plugin directory and generates the `index.yml` source index with sha256, version, and metadata.
- `.github/workflows/deploy.yml` — GitHub Actions workflow that builds and deploys the source index to GitHub Pages on push to `plugins/**` on `main`.
- `LICENCE` — AGPL-3.0.

## How the Plugin Is Published
Source index URL: `https://<username>.github.io/<repository>/main/index.yml`. Stash users add this URL as a plugin source; Stash reads `index.yml` and offers the listed plugins for installation.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `plugins/` | Container for self-contained Stash plugins; one subdirectory per plugin id. | [View Map](plugins/codemap.md) |
| `plugins/QuestingAdventurer/` | QuestingAdventurer plugin — player overlay (vanilla JS) + full-page React settings UI sharing one config key; v2 data model with a global moves library and triggers that reference moves by id (`active` lives on the trigger); overlay shows only active triggers with their attached moves; add-controls toggle in the header; persisted to Stash config; one-shot v0 (SceneRules) → v2 migration. | [View Map](plugins/QuestingAdventurer/codemap.md) |
| `plugins/MosaicFilter/` | MosaicFilter plugin — player overlay (vanilla JS) that blurs a movable/resizable rectangle or ellipse over the scene, plus a full-page React settings page; single global flat config (no per-scene storage) shared by both surfaces; optional follow-cursor and reverse-blur modes; reverse-mode hole cut with `clip-path: path()`; legacy `{ defaults, scenes }` shape migrated on load. | [View Map](plugins/MosaicFilter/codemap.md) |
| `plugins/SceneVersions/` | SceneVersions plugin — a "Related Scenes" tab on the scene page (React) that stores bidirectional links in scene custom_fields; uses Apollo client for reads/writes; includes a suggest-from-folder helper that queries other scenes in the same file folder. No csLib dependency. | [View Map](plugins/SceneVersions/codemap.md) |

## Build & Deploy
- `build_site.sh <outdir>`: for each `plugins/*/*.yml`, zips the plugin directory, then records `id`, `name`, `description`, `version` (`<ymlVersion>-<gitHash>`), `date`, `path`, `sha256`, and optional `requires` into `<outdir>/index.yml`.
- `deploy.yml`: triggers on `plugins/**` push to `main` (or manual `workflow_dispatch`), runs `build_site.sh _site/<ref>`, uploads a Pages artifact, and deploys to GitHub Pages.
