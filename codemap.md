# Repository Atlas: stashapp-plugins-vault

## Project Responsibility
A Stash plugin source-index repository (based on the official CommunityScripts template) that packages and publishes Stash plugins via GitHub Pages. Currently ships one plugin — **QuestingAdventurer** — an interactive overlay and settings page that turns scene playback into a quest: the viewer is a "questing adventurer" who must respond to cues in the playing scene by performing the active moves from their quest log.

## System Entry Points
- `plugins/QuestingAdventurer/QuestingAdventurer.yml` — plugin manifest; declares the QuestingAdventurer plugin to Stash (name, description, version, required dependency, asset list).
- `build_site.sh` — build script that zips each plugin directory and generates the `index.yml` source index with sha256, version, and metadata.
- `.github/workflows/deploy.yml` — GitHub Actions workflow that builds and deploys the source index to GitHub Pages on push to `plugins/**` on `main`.
- `LICENCE` — AGPL-3.0.

## How the Plugin Is Published
Source index URL: `https://<username>.github.io/<repository>/main/index.yml`. Stash users add this URL as a plugin source; Stash reads `index.yml` and offers the listed plugins for installation.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `plugins/` | Container for self-contained Stash plugins; one subdirectory per plugin id. | [View Map](plugins/codemap.md) |
| `plugins/QuestingAdventurer/` | QuestingAdventurer plugin — player overlay (vanilla JS) + full-page React settings UI sharing one config key; 2-level quests/moves CRUD with per-move `active` flag, persisted to Stash config; one-shot migration from the legacy `SceneRules` key. | [View Map](plugins/QuestingAdventurer/codemap.md) |

## Build & Deploy
- `build_site.sh <outdir>`: for each `plugins/*/*.yml`, zips the plugin directory, then records `id`, `name`, `description`, `version` (`<ymlVersion>-<gitHash>`), `date`, `path`, `sha256`, and optional `requires` into `<outdir>/index.yml`.
- `deploy.yml`: triggers on `plugins/**` push to `main` (or manual `workflow_dispatch`), runs `build_site.sh _site/<ref>`, uploads a Pages artifact, and deploys to GitHub Pages.
