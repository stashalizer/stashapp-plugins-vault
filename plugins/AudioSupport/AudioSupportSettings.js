/**
 * AudioSupportSettings — full-page settings / browse UI.
 *
 * Architecture:
 * - Registers a route via PluginApi.patch.before("PluginRoutes", ...) at
 *   /plugins/audiosupport.
 * - Adds a launcher card in Settings > Tools via
 *   PluginApi.patch.before("SettingsToolsSection", ...). The launcher appears
 *   only under the "Scene Tools" subsection (the second SettingsToolsSection
 *   instance in SettingsToolsPanel) by gating on a module-level call counter.
 * - Adds a top-navigation entry via PluginApi.patch.before("MainNavBar.MenuItems",
 *   ...). Visibility is controlled by the plugin config `showNavEntry` toggle
 *   on the Setup tab.
 * - Reads/writes the config key "AudioSupport" (overlay owns collapsed/opacity/
 *   panelPos/playbackRate/loop/volume; this page owns audioTagName and
 *   showNavEntry).
 * - Uses Apollo client via PluginApi.utils.StashService.getClient() for all data.
 * - Three top-level tabs: Browse (By Folder / All Audio / By Tag), Setup, Covers.
 * - The By Folder detail view plays a track in place (sticky bar, direct stream
 *   URL — no transcode endpoints) and edits the scene's tags inline, so
 *   listening and tagging never leave the browse view. /scenes/:id stays one
 *   click away through each row's title for the full scene page.
 */
(function () {
  "use strict";

  if (!window.PluginApi || !window.csLib) {
    console.error("AudioSupport settings: PluginApi or csLib missing");
    return;
  }

  const React = PluginApi.React;
  const h = React.createElement;
  const { useState, useEffect, useMemo, useCallback, useRef } = React;
  const { Route, Link } = PluginApi.libraries.ReactRouterDOM;
  const GQL = PluginApi.GQL;
  const apolloClient = PluginApi.utils.StashService.getClient();
  const Apollo = PluginApi.libraries.Apollo;

  const CONFIG_KEY = "AudioSupport";
  const QUEUE_CONFIG_KEY = "AudioSupportQueue";
  const PLUGIN_ROUTE = "/plugins/audiosupport";
  // Plugin id = directory name = yml basename; runPluginTask needs it verbatim.
  const PLUGIN_ID = "AudioSupport";
  const AUDIO_EXTENSIONS = ["mp3", "flac", "ogg", "opus", "m4a", "wav", "aac"];
  const DEFAULT_TAG_NAME = "Audio";
  const DEFAULT_SHOW_NAV_ENTRY = true;

  // The generate tab hands the work to the Goja task in AudioSupportHook.js
  // (mode "generateVideo") instead of collecting scene ids in the browser: the
  // task is the single implementation, and it also stays usable from
  // Settings > Tasks for headless installs.
  const RUN_PLUGIN_TASK_MUTATION = Apollo && Apollo.gql
    ? Apollo.gql`
        mutation AudioSupportRunTask($plugin_id: ID!, $description: String, $args_map: Map) {
          runPluginTask(plugin_id: $plugin_id, description: $description, args_map: $args_map)
        }
      `
    : null;

  // Previews only, unlike Stash's GenerateDialog (which turns sprites,
  // previews, phashes and markers on). Previews are the subtask that failed on
  // audio scenes and the reason this tab exists; everything else is opt-in
  // because it is expensive on a large library. Transcodes are never offered.
  const DEFAULT_GENERATE_OPTIONS = {
    sprites: false,
    previews: true,
    phashes: false,
    markers: false,
    covers: false,
    overwrite: false,
  };

  let queueSaving = false;
  let queuePendingSave = false;
  let latestQueuePatch = null;

  async function saveQueueConfig(patch) {
    if (queueSaving) {
      queuePendingSave = true;
      latestQueuePatch = patch;
      return;
    }
    queueSaving = true;
    queuePendingSave = false;
    try {
      const stored = (await csLib.getConfiguration(QUEUE_CONFIG_KEY)) || {};
      const merged = {
        queue: Array.isArray(stored.queue) ? stored.queue : [],
        currentIndex: typeof stored.currentIndex === "number" ? stored.currentIndex : 0,
        repeat: ["off", "all", "one"].indexOf(stored.repeat) !== -1 ? stored.repeat : "off",
      };
      Object.assign(merged, patch);
      await csLib.setConfiguration(QUEUE_CONFIG_KEY, merged);
    } catch (err) {
      console.error("AudioSupport settings: failed to save queue config", err);
      throw err;
    } finally {
      queueSaving = false;
      if (queuePendingSave) {
        queuePendingSave = false;
        const next = latestQueuePatch;
        latestQueuePatch = null;
        saveQueueConfig(next);
      }
    }
  }

  const SORT_OPTIONS = [
    { value: "title_asc", label: "Name (A-Z)" },
    { value: "title_desc", label: "Name (Z-A)" },
    { value: "created_desc", label: "Date added (newest)" },
    { value: "created_asc", label: "Date added (oldest)" },
    { value: "duration_desc", label: "Duration (longest)" },
    { value: "duration_asc", label: "Duration (shortest)" },
  ];

  let settingsToolsCallCount = 0;
  let saving = false;
  let pendingSave = false;
  // Captures the latest patch so the saveConfig retry uses the most recent
  // data instead of the first call's stale argument (matches the
  // latestTriggers/latestMoves pattern in QuestingAdventurerSettings).
  let latestPatch = null;

  // Module-level nav-entry visibility. The MainNavBar.MenuItems patch reads
  // this on every render; it is updated once config loads and whenever the
  // user toggles the setting. Because the navbar only re-renders on route
  // changes, the initial render may briefly show the item even if the stored
  // value is false, but the default is true so this is rarely visible.
  let navEntryEnabled = true;
  let navEntryLoaded = false;

  function updateNavEntryEnabled(enabled) {
    navEntryEnabled = !!enabled;
    navEntryLoaded = true;
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers (overlay fields preserved)
  // ---------------------------------------------------------------------------

  // Normalize a raw stored config into the canonical shape, preserving the
  // overlay-owned fields and the settings-owned fields (audioTagName,
  // showNavEntry) with safe fallbacks. Shared by loadConfig and saveConfig
  // so the two surfaces agree on the persisted shape.
  function normalizeConfig(stored) {
    const s = stored || {};
    const merged = Object.assign({}, s);  // preserve ALL existing keys
    // overlay-owned fields (validated)
    merged.collapsed = typeof s.collapsed === "boolean" ? s.collapsed : false;
    merged.opacity = typeof s.opacity === "number" && !Number.isNaN(s.opacity)
      ? Math.min(1, Math.max(0, s.opacity))
      : 0.92;
    merged.panelPos = s.panelPos && typeof s.panelPos.top === "number" && typeof s.panelPos.right === "number"
      ? { top: Math.max(0, s.panelPos.top), right: Math.max(0, s.panelPos.right) }
      : { top: 8, right: 8 };
    // settings-owned fields (validated)
    merged.audioTagName = typeof s.audioTagName === "string" && s.audioTagName.trim()
      ? s.audioTagName.trim()
      : DEFAULT_TAG_NAME;
    merged.showNavEntry = typeof s.showNavEntry === "boolean" ? s.showNavEntry : DEFAULT_SHOW_NAV_ENTRY;
    return merged;
  }

  async function saveConfig(patch) {
    if (saving) {
      pendingSave = true;
      latestPatch = patch;
      return;
    }
    saving = true;
    pendingSave = false;
    try {
      const stored = (await csLib.getConfiguration(CONFIG_KEY)) || {};
      const merged = normalizeConfig(stored);
      Object.assign(merged, patch);
      await csLib.setConfiguration(CONFIG_KEY, merged);
    } catch (err) {
      console.error("AudioSupport settings: save failed", err);
      throw err;
    } finally {
      saving = false;
      if (pendingSave) {
        pendingSave = false;
        const next = latestPatch;
        latestPatch = null;
        saveConfig(next);
      }
    }
  }

  async function loadConfig() {
    try {
      const stored = (await csLib.getConfiguration(CONFIG_KEY)) || {};
      return normalizeConfig(stored);
    } catch (err) {
      console.error("AudioSupport settings: load failed", err);
      return normalizeConfig(null);
    }
  }

  // ---------------------------------------------------------------------------
  // GraphQL helpers
  // ---------------------------------------------------------------------------

  async function queryConfiguration() {
    const result = await apolloClient.query({
      query: GQL.ConfigurationDocument,
      fetchPolicy: "no-cache",
    });
    return result && result.data ? result.data.configuration : null;
  }

  async function findTagByName(name) {
    const result = await apolloClient.query({
      query: GQL.FindTagsDocument,
      variables: {
        filter: { per_page: 1, sort: "name" },
        tag_filter: { name: { value: name, modifier: "EQUALS" } },
      },
      fetchPolicy: "no-cache",
    });
    const tags = (result && result.data && result.data.findTags && result.data.findTags.tags) || [];
    return tags.find(function (t) { return t.name === name; }) || null;
  }

  async function createTag(name) {
    const result = await apolloClient.mutate({
      mutation: GQL.TagCreateDocument,
      variables: { input: { name: name } },
    });
    return result && result.data ? result.data.tagCreate : null;
  }

  async function findAudioScenes(tagId) {
    const result = await apolloClient.query({
      query: GQL.FindScenesDocument,
      variables: {
        filter: { per_page: 500, sort: "title" },
        scene_filter: {
          tags: { value: [tagId], modifier: "INCLUDES" },
        },
      },
      fetchPolicy: "no-cache",
    });
    return (result && result.data && result.data.findScenes && result.data.findScenes.scenes) || [];
  }

  // Find audio-tagged scenes that have no cover blob. Uses the server-side
  // `is_missing: "cover"` filter (maps to `scenes.cover_blob IS NULL` in
  // pkg/sqlite/scene_filter.go). Do NOT filter on `paths.screenshot` client-side:
  // the Stash resolver unconditionally builds a screenshot URL for every scene
  // (it serves a default placeholder image when no cover blob exists), so a
  // truthy `paths.screenshot` does NOT imply a cover exists.
  async function findAudioScenesMissingCover(tagId) {
    const result = await apolloClient.query({
      query: GQL.FindScenesDocument,
      variables: {
        filter: { per_page: 500, sort: "title" },
        scene_filter: {
          tags: { value: [tagId], modifier: "INCLUDES" },
          is_missing: "cover",
        },
      },
      fetchPolicy: "no-cache",
    });
    return (result && result.data && result.data.findScenes && result.data.findScenes.scenes) || [];
  }

  // Count scenes matching a filter without pulling the rows. `per_page: 1`
  // keeps the payload small; `count` is always the total match count.
  async function countScenes(sceneFilter) {
    const variables = { filter: { per_page: 1 } };
    if (sceneFilter) {
      variables.scene_filter = sceneFilter;
    }
    const result = await apolloClient.query({
      query: GQL.FindScenesDocument,
      variables: variables,
      fetchPolicy: "no-cache",
    });
    const findScenes = result && result.data ? result.data.findScenes : null;
    return findScenes && typeof findScenes.count === "number" ? findScenes.count : 0;
  }

  async function loadSceneCounts(tagId) {
    const total = await countScenes(null);
    const audio = await countScenes({ tags: { value: [tagId], modifier: "INCLUDES" } });
    return { total: total, audio: audio, video: Math.max(total - audio, 0) };
  }

  async function updateSceneCover(sceneId, base64Png) {
    await apolloClient.mutate({
      mutation: GQL.SceneUpdateDocument,
      variables: {
        input: {
          id: sceneId,
          cover_image: base64Png,
        },
      },
    });
  }

  // Tag search for the inline tag editor. `tag_filter.name` with INCLUDES is
  // used instead of `FindFilterType.q` because it is the one name search the
  // schema has always supported (the repo's findTagByName already relies on the
  // EQUALS form of it).
  async function searchTags(query) {
    const variables = {
      filter: { per_page: 20, sort: "name", direction: "ASC" },
    };
    const trimmed = (query || "").trim();
    if (trimmed) {
      variables.tag_filter = { name: { value: trimmed, modifier: "INCLUDES" } };
    }
    const result = await apolloClient.query({
      query: GQL.FindTagsDocument,
      variables: variables,
      fetchPolicy: "no-cache",
    });
    return (result && result.data && result.data.findTags && result.data.findTags.tags) || [];
  }

  // Tag edits are scene edits: `tag_ids` REPLACES the whole list, so every call
  // must carry the complete set. Returns the updated scene (the mutation selects
  // SceneData, so `tags` comes back with id + name).
  async function updateSceneTags(sceneId, tagIds) {
    const result = await apolloClient.mutate({
      mutation: GQL.SceneUpdateDocument,
      variables: { input: { id: sceneId, tag_ids: tagIds } },
    });
    return result && result.data ? result.data.sceneUpdate : null;
  }

  // ---------------------------------------------------------------------------
  // ID3 embedded cover extraction
  // ---------------------------------------------------------------------------

  function loadJsMediaTags() {
    return new Promise(function (resolve, reject) {
      if (window.jsmediatags) { resolve(); return; }
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.7/jsmediatags.min.js";
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error("Failed to load jsmediatags from CDN")); };
      document.head.appendChild(script);
    });
  }

  function extractCoverFromScene(sceneId) {
    return new Promise(function (resolve, reject) {
      window.jsmediatags.read("/scene/" + sceneId + "/stream", {
        onSuccess: function (tag) {
          const picture = tag.tags && tag.tags.picture;
          if (!picture || !picture.data || !picture.format) { resolve(null); return; }
          let binary = "";
          const data = picture.data;
          for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
          }
          try {
            const base64 = window.btoa(binary);
            resolve("data:" + picture.format + ";base64," + base64);
          } catch (e) {
            reject(e);
          }
        },
        onError: function (err) { reject(err); }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Canvas cover generator
  // ---------------------------------------------------------------------------

  function generateDefaultCover(size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Gradient background
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, "#1a1a2e");
    grad.addColorStop(0.5, "#16213e");
    grad.addColorStop(1, "#0f3460");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Soft radial glow
    const glow = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.7);
    glow.addColorStop(0, "rgba(110, 160, 220, 0.25)");
    glow.addColorStop(1, "rgba(110, 160, 220, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Music note glyph
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.font = "bold " + Math.floor(size * 0.55) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("\u266b", size / 2, size / 2 + size * 0.02);

    return canvas.toDataURL("image/png");
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  function Loading() {
    return h("div", { className: "audio-support-settings__loading" }, "Loading\u2026");
  }

  function ErrorBox(props) {
    return h("div", { className: "audio-support-settings__error" }, props.message);
  }

  function StatusBadge(props) {
    const ok = !!props.ok;
    return h(
      "span",
      { className: "audio-support-settings__status " + (ok ? "audio-support-settings__status--ok" : "audio-support-settings__status--bad") },
      ok ? "\u2713 " + (props.label || "Enabled") : "\u2717 " + (props.label || "Not enabled")
    );
  }

  function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return "0:00";
    const secs = Math.floor(seconds % 60);
    const mins = Math.floor((seconds / 60) % 60);
    const hours = Math.floor(seconds / 3600);
    if (hours > 0) return hours + ":" + (mins < 10 ? "0" + mins : mins) + ":" + (secs < 10 ? "0" + secs : secs);
    return mins + ":" + (secs < 10 ? "0" + secs : secs);
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function getAudioFile(scene) {
    const files = scene && scene.files;
    if (!Array.isArray(files) || files.length === 0) return null;
    const primary = scene.primary_file_id
      ? files.find(function (f) { return String(f.id) === String(scene.primary_file_id); })
      : null;
    if (primary && primary.video_codec === "") return primary;
    return files.find(function (f) { return f.video_codec === ""; }) || files[0] || null;
  }

  // Browse views label a scene by its file name, because that is the only
  // identifier audio files reliably have: Stash leaves `title` empty for
  // scanned files (which used to render as "Untitled"), and titles that do
  // exist are sometimes the full path (imported/scraped libraries). Both
  // sources are reduced to a bare base name with the extension stripped, so
  // every card shows a short, distinguishable label.
  const FILE_EXTENSION_PATTERN = /^[A-Za-z0-9]{1,5}$/;

  // Split a path into its parent folder and its last segment. Backslashes are
  // normalized first: a Windows path (or a title written by another tool) has no
  // "/" at all, and a bare lastIndexOf("/") would then return -1 and hand back
  // the whole path as the "file name".
  function splitPath(target) {
    if (!target) return { dir: "", name: "" };
    const normalized = String(target).replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash < 0) return { dir: "", name: normalized };
    return {
      dir: normalized.substring(0, lastSlash),
      name: normalized.substring(lastSlash + 1),
    };
  }

  // Base name of a path or title.
  function getBaseName(value) {
    return splitPath(value).name;
  }

  // Drop the extension only when the tail actually looks like one, so titles
  // such as "Op. 27 No. 2" or "01. Intro" survive intact.
  function stripFileExtension(name) {
    if (!name) return "";
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return name;
    if (!FILE_EXTENSION_PATTERN.test(name.substring(dot + 1))) return name;
    return name.substring(0, dot);
  }

  function getSceneDisplayName(scene) {
    const filePath = scene && scene.files && scene.files[0] && scene.files[0].path;
    const fromFile = stripFileExtension(getBaseName(filePath));
    if (fromFile) return fromFile;
    return stripFileExtension(getBaseName(scene && scene.title)) || "Untitled";
  }

  function useDebouncedValue(value, delay) {
    const [debounced, setDebounced] = useState(value);
    useEffect(function () {
      const t = setTimeout(function () { setDebounced(value); }, delay);
      return function () { clearTimeout(t); };
    }, [value, delay]);
    return debounced;
  }

  function naturalCompare(a, b) {
    const aName = (a.files && a.files[0] && a.files[0].path || a.title || "").toLowerCase();
    const bName = (b.files && b.files[0] && b.files[0].path || b.title || "").toLowerCase();
    const aMatch = aName.match(/(\d+)/);
    const bMatch = bName.match(/(\d+)/);
    if (aMatch && bMatch) {
      const aNum = parseInt(aMatch[1], 10);
      const bNum = parseInt(bMatch[1], 10);
      if (aNum !== bNum) return aNum - bNum;
    }
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  }

  // Audio has no album/work entity in Stash: a track is a scene, and the only
  // grouping the library actually has is the folder it sits in. Group by the
  // immediate parent folder and label the card with that folder's name — the
  // full folder path stays in `dir` for the key and the hover tooltip.
  function groupByFolder(scenes) {
    const groups = {};
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const path = scene.files && scene.files[0] && scene.files[0].path;
      if (!path) continue;
      const dir = splitPath(path).dir;
      if (!groups[dir]) {
        groups[dir] = {
          name: splitPath(dir).name || "No folder",
          dir: dir,
          scenes: [],
        };
      }
      groups[dir].scenes.push(scene);
    }
    return Object.values(groups).sort(function (a, b) {
      return a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir);
    });
  }

  function collectTagGroups(scenes) {
    const groups = {};
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const tags = scene.tags || [];
      for (let j = 0; j < tags.length; j++) {
        const tag = tags[j];
        if (!tag || !tag.id) continue;
        if (!groups[tag.id]) groups[tag.id] = { tag: tag, scenes: [] };
        groups[tag.id].scenes.push(scene);
      }
    }
    return Object.values(groups).sort(function (a, b) {
      return a.tag.name.localeCompare(b.tag.name);
    });
  }

  function getFolderDuration(folder) {
    return folder.scenes.reduce(function (total, scene) {
      const f = getAudioFile(scene);
      return total + (f && f.duration ? f.duration : 0);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Scene cards
  // ---------------------------------------------------------------------------

  function AudioSceneCard(props) {
    const scene = props.scene;
    const audioFile = getAudioFile(scene);
    const displayName = props.name || getSceneDisplayName(scene);
    const history = PluginApi.libraries.ReactRouterDOM.useHistory();
    const onPlay = async function (e) {
      e.preventDefault();
      e.stopPropagation();
      try {
        await saveQueueConfig({ queue: [String(scene.id)], currentIndex: 0 });
        history.push("/scenes/" + scene.id);
      } catch (err) {
        console.error("AudioSupport settings: failed to play scene", err);
      }
    };
    return h(
      "div",
      { className: "audio-support-settings__scene-card" },
      h(
        Link,
        {
          to: "/scenes/" + scene.id,
          className: "audio-support-settings__scene-card-link",
          title: displayName,
        },
        h(
          "div",
          { className: "audio-support-settings__scene-cover" },
          scene.paths && scene.paths.screenshot
            ? h("img", { src: scene.paths.screenshot, alt: "", loading: "lazy" })
            : h("div", { className: "audio-support-settings__scene-cover--placeholder" })
        ),
        h(
          "div",
          { className: "audio-support-settings__scene-card-info" },
          h("div", { className: "audio-support-settings__scene-card-title" }, displayName),
          h(
            "div",
            { className: "audio-support-settings__scene-card-meta" },
            formatDuration(audioFile && audioFile.duration),
            " \u00b7 ",
            (audioFile && audioFile.audio_codec ? audioFile.audio_codec.toUpperCase() : "AUDIO"),
            audioFile && audioFile.bit_rate
              ? " \u00b7 " + Math.round(audioFile.bit_rate / 1000) + " kbps"
              : null
          ),
          scene.created_at
            ? h("div", { className: "audio-support-settings__scene-card-date" }, "Added " + formatDate(scene.created_at))
            : null
        )
      ),
      h(
        "button",
        {
          type: "button",
          className: "audio-support-settings__scene-card-play",
          title: "Play scene",
          onClick: onPlay,
        },
        "\u25b6"
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Browse sub-views
  // ---------------------------------------------------------------------------

  function AllAudioView(props) {
    const scenes = props.scenes || [];
    const search = props.search;
    const setSearch = props.setSearch;
    const sortBy = props.sortBy;
    const setSortBy = props.setSortBy;
    const tag = props.tag;
    const history = PluginApi.libraries.ReactRouterDOM.useHistory();

    const debouncedSearch = useDebouncedValue(search, 200);

    const filteredSorted = useMemo(
      function () {
        const q = debouncedSearch.trim().toLowerCase();
        // Decorate once: the display name drives the visible label, the search
        // and the "Name" sort options, so compute it a single time per scene.
        let items = scenes.map(function (scene) {
          return { scene: scene, name: getSceneDisplayName(scene) };
        });
        if (q) {
          items = items.filter(function (item) {
            return item.name.toLowerCase().indexOf(q) !== -1;
          });
        }
        items.sort(function (a, b) {
          switch (sortBy) {
            case "title_desc":
              return b.name.localeCompare(a.name);
            case "created_desc":
              return new Date(b.scene.created_at || 0) - new Date(a.scene.created_at || 0);
            case "created_asc":
              return new Date(a.scene.created_at || 0) - new Date(b.scene.created_at || 0);
            case "duration_desc":
              return (getAudioFile(b.scene).duration || 0) - (getAudioFile(a.scene).duration || 0);
            case "duration_asc":
              return (getAudioFile(a.scene).duration || 0) - (getAudioFile(b.scene).duration || 0);
            case "title_asc":
            default:
              return a.name.localeCompare(b.name);
          }
        });
        return items;
      },
      [scenes, debouncedSearch, sortBy]
    );

    return h(
      "div",
      { className: "audio-support-settings__browse-panel" },
      !tag
        ? h("p", { className: "audio-support-settings__hint" }, "Create the audio tag on the Setup tab first.")
        : h(
            "div",
            { className: "audio-support-settings__library-controls" },
            h(
              "div",
              { className: "audio-support-settings__search" },
              h("input", {
                type: "text",
                className: "audio-support-settings__input",
                placeholder: "Search by file name...",
                value: search,
                onChange: function (e) { setSearch(e.target.value); },
              })
            ),
            h(
              "div",
              { className: "audio-support-settings__sort" },
              h(
                "label",
                null,
                "Sort:",
                h(
                  "select",
                  {
                    className: "audio-support-settings__select",
                    value: sortBy,
                    onChange: function (e) { setSortBy(e.target.value); },
                  },
                  SORT_OPTIONS.map(function (opt) {
                    return h("option", { key: opt.value, value: opt.value }, opt.label);
                  })
                )
              )
            )
          ),
      tag && scenes.length > 0
        ? h(
            "div",
            { className: "audio-support-settings__count" },
            filteredSorted.length + " scene" + (filteredSorted.length === 1 ? "" : "s")
          )
        : null,
      tag && filteredSorted.length === 0
        ? h(
            "div",
            { className: "audio-support-settings__empty" },
            h("p", null, "No scenes found."),
            scenes.length === 0
              ? h("p", { className: "audio-support-settings__hint" }, "Scan your library after enabling audio ingestion, then run the Tag all audio scenes task.")
              : h("p", { className: "audio-support-settings__hint" }, "Try a different search term or sort option.")
          )
        : null,
      tag && filteredSorted.length > 0
        ? h(
            "div",
            null,
            h(
              "div",
              { className: "audio-support-settings__library-controls" },
              h(
                "button",
                {
                  type: "button",
                  className: "audio-support-settings__button audio-support-settings__button--primary",
                  onClick: async function () {
                    try {
                      const ids = filteredSorted.map(function (item) { return item.scene.id; });
                      await saveQueueConfig({ queue: ids, currentIndex: 0 });
                      history.push("/scenes/" + ids[0]);
                    } catch (err) {
                      console.error("AudioSupport settings: failed to play all", err);
                    }
                  },
                },
                "Play All"
              )
            ),
            h(
              "div",
              { className: "audio-support-settings__scene-grid" },
              filteredSorted.map(function (item) {
                return h(AudioSceneCard, { key: item.scene.id, scene: item.scene, name: item.name });
              })
            )
          )
        : null
    );
  }

  // NOTE: the `...__work-*` CSS class names are styling hooks only — they kept
  // their historical prefix when the UI was reworded from "work" to "folder".
  function FolderCard(props) {
    const folder = props.folder;
    const totalDuration = getFolderDuration(folder);
    const firstScene = folder.scenes[0];
    return h(
      "button",
      {
        type: "button",
        className: "audio-support-settings__work-card",
        // Hover shows the folder path: sibling folders can share a name
        // (CD1, Disc 1, ...), and the card itself only has room for the name.
        title: folder.dir,
        onClick: props.onClick,
      },
      h(
        "div",
        { className: "audio-support-settings__work-cover" },
        firstScene && firstScene.paths && firstScene.paths.screenshot
          ? h("img", { src: firstScene.paths.screenshot, alt: "", loading: "lazy" })
          : h("div", { className: "audio-support-settings__work-cover--placeholder" })
      ),
      h(
        "div",
        { className: "audio-support-settings__work-info" },
        h("div", { className: "audio-support-settings__work-title" }, folder.name),
        h(
          "div",
          { className: "audio-support-settings__work-meta" },
          folder.scenes.length + " file" + (folder.scenes.length === 1 ? "" : "s"),
          " \u00b7 ",
          formatDuration(totalDuration)
        )
      )
    );
  }

  function FolderGridView(props) {
    const folders = props.folders;
    if (folders.length === 0) {
      return h(
        "div",
        { className: "audio-support-settings__empty" },
        h("p", null, "No audio folders found."),
        h("p", { className: "audio-support-settings__hint" }, "Scan your library after enabling audio ingestion.")
      );
    }
    return h(
      "div",
      { className: "audio-support-settings__work-grid" },
      folders.map(function (folder) {
        return h(FolderCard, { key: folder.dir, folder: folder, onClick: function () { props.onSelect(folder); } });
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Inline tag editing
  // ---------------------------------------------------------------------------

  function TagChip(props) {
    const tag = props.tag;
    return h(
      "span",
      { className: "audio-support-settings__tag-chip" },
      h("span", { className: "audio-support-settings__tag-chip-name" }, tag.name),
      props.onRemove
        ? h(
            "button",
            {
              type: "button",
              className: "audio-support-settings__tag-chip-remove",
              title: "Remove tag '" + tag.name + "'",
              "aria-label": "Remove tag " + tag.name,
              disabled: props.disabled,
              onClick: props.onRemove,
            },
            "\u00d7"
          )
        : null
    );
  }

  // Chips + a "+ Tag" popover. Removing writes the scene immediately (no
  // confirm step, matching the scene edit page); adding also creates the tag
  // when the typed name does not exist yet, because typing a genre or a
  // narrator from scratch is the common case.
  function TrackTagEditor(props) {
    const scene = props.scene;
    const tags = Array.isArray(scene.tags) ? scene.tags : [];
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const debouncedQuery = useDebouncedValue(query, 200);
    const wrapRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(
      function () {
        if (!open) return undefined;
        let cancelled = false;
        setSearching(true);
        searchTags(debouncedQuery)
          .then(function (found) {
            if (cancelled) return;
            setResults(found);
            setError(null);
          })
          .catch(function (err) {
            if (cancelled) return;
            console.error("AudioSupport settings: tag search failed", err);
            setResults([]);
            setError("Tag search failed");
          })
          .then(function () {
            if (!cancelled) setSearching(false);
          });
        return function () {
          cancelled = true;
        };
      },
      [open, debouncedQuery]
    );

    // Click-outside / Escape close. pointerdown (not click) so the panel is gone
    // before another row's handler runs.
    useEffect(
      function () {
        if (!open) return undefined;
        function onPointerDown(e) {
          if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        }
        function onKeyDown(e) {
          if (e.key === "Escape") setOpen(false);
        }
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return function () {
          document.removeEventListener("pointerdown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      },
      [open]
    );

    useEffect(
      function () {
        if (open && inputRef.current) inputRef.current.focus();
      },
      [open]
    );

    async function commit(nextTags) {
      setBusy(true);
      setError(null);
      try {
        const updated = await updateSceneTags(
          scene.id,
          nextTags.map(function (t) { return String(t.id); })
        );
        const finalTags = updated && Array.isArray(updated.tags) ? updated.tags : nextTags;
        if (props.onTagsChange) props.onTagsChange(scene.id, finalTags);
      } catch (err) {
        console.error("AudioSupport settings: failed to update scene tags", err);
        setError("Could not update tags");
      } finally {
        setBusy(false);
      }
    }

    function addTag(tag) {
      if (!tag || busy) return;
      const exists = tags.some(function (t) { return String(t.id) === String(tag.id); });
      if (exists) return;
      setQuery("");
      // Keep the popover open: tagging a track usually means several tags.
      commit(tags.concat([{ id: tag.id, name: tag.name }]));
    }

    async function createAndAdd(name) {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const created = await createTag(name);
        if (!created || !created.id) throw new Error("tagCreate returned no tag");
        setQuery("");
        await commit(tags.concat([{ id: created.id, name: created.name }]));
      } catch (err) {
        console.error("AudioSupport settings: failed to create tag", err);
        setError("Could not create tag");
      } finally {
        setBusy(false);
      }
    }

    const attachedIds = tags.map(function (t) { return String(t.id); });
    const trimmed = query.trim();
    const lower = trimmed.toLowerCase();
    const available = results.filter(function (t) {
      return attachedIds.indexOf(String(t.id)) === -1;
    });
    const hasExact = tags
      .concat(results)
      .some(function (t) { return String(t.name || "").toLowerCase() === lower; });

    return h(
      "div",
      {
        className: "audio-support-settings__track-tags" + (props.up ? " audio-support-settings__track-tags--up" : ""),
        ref: wrapRef,
      },
      tags.map(function (tag) {
        return h(TagChip, {
          key: tag.id,
          tag: tag,
          disabled: busy,
          onRemove: function () {
            if (busy) return;
            commit(tags.filter(function (t) { return String(t.id) !== String(tag.id); }));
          },
        });
      }),
      h(
        "button",
        {
          type: "button",
          className: "audio-support-settings__tag-add-button",
          title: "Add or remove tags",
          "aria-expanded": open,
          onClick: function () { setOpen(!open); },
        },
        "+ Tag"
      ),
      open
        ? h(
            "div",
            { className: "audio-support-settings__tag-popover" },
            h("input", {
              ref: inputRef,
              type: "text",
              className: "audio-support-settings__input audio-support-settings__tag-search",
              placeholder: "Search tags\u2026",
              value: query,
              onChange: function (e) { setQuery(e.target.value); },
              onKeyDown: function (e) {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (available.length > 0) {
                  addTag(available[0]);
                } else if (trimmed && !hasExact) {
                  createAndAdd(trimmed);
                }
              },
            }),
            error ? h("div", { className: "audio-support-settings__tag-popover-status" }, error) : null,
            h(
              "div",
              { className: "audio-support-settings__tag-results" },
              available.map(function (tag) {
                return h(
                  "button",
                  {
                    key: tag.id,
                    type: "button",
                    className: "audio-support-settings__tag-result",
                    disabled: busy,
                    onClick: function () { addTag(tag); },
                  },
                  tag.name
                );
              }),
              searching && results.length === 0
                ? h("div", { className: "audio-support-settings__tag-popover-status" }, "Searching\u2026")
                : null,
              !searching && !error && available.length === 0
                ? h(
                    "div",
                    { className: "audio-support-settings__tag-popover-status" },
                    trimmed ? "No matching tag." : "No tags yet."
                  )
                : null
            ),
            trimmed && !hasExact
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "audio-support-settings__tag-create",
                    disabled: busy,
                    onClick: function () { createAndAdd(trimmed); },
                  },
                  'Create tag "' + trimmed + '"'
                )
              : null
          )
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Inline player
  // ---------------------------------------------------------------------------

  // Sticky player for the folder view: choosing a track plays it here instead of
  // navigating to /scenes/:id. The source is scene.paths.stream (never a
  // transcode endpoint — FileGetCodec forces a video encode for audio-only
  // files) and it already carries the ?apikey= param authenticated installs
  // need.
  function InlinePlayer(props) {
    const scene = props.scene;
    const audioRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState(null);
    const streamUrl = scene.paths && scene.paths.stream ? scene.paths.stream : "";

    // Start the newly selected track. The selection came from a click, so the
    // autoplay policy is satisfied; the effect runs after <audio> got its new
    // src, which is why it is not part of the click handler.
    useEffect(
      function () {
        setCurrentTime(0);
        setDuration(0);
        setError(null);
        const audio = audioRef.current;
        if (!audio) return;
        const promise = audio.play();
        if (promise && typeof promise.catch === "function") {
          promise.catch(function (err) {
            if (err && err.name === "AbortError") return;
            console.error("AudioSupport settings: inline play failed", err);
            setError("Playback failed");
          });
        }
      },
      [scene.id]
    );

    function togglePlay() {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        const promise = audio.play();
        if (promise && typeof promise.catch === "function") {
          promise.catch(function () { setError("Playback failed"); });
        }
      } else {
        audio.pause();
      }
    }

    function handleSeek(e) {
      const audio = audioRef.current;
      const value = parseFloat(e.target.value);
      if (!audio || Number.isNaN(value)) return;
      audio.currentTime = value;
      setCurrentTime(value);
    }

    return h(
      "div",
      { className: "audio-support-settings__player" },
      h("audio", {
        ref: audioRef,
        src: streamUrl,
        preload: "metadata",
        onPlay: function () { setPlaying(true); setError(null); },
        onPause: function () { setPlaying(false); },
        onEnded: props.onEnded,
        onTimeUpdate: function (e) { setCurrentTime(e.target.currentTime || 0); },
        onLoadedMetadata: function (e) {
          if (isFinite(e.target.duration)) setDuration(e.target.duration);
        },
        onError: function () { setPlaying(false); setError("Cannot load audio"); },
      }),
      h(
        "button",
        {
          type: "button",
          className: "audio-support-settings__player-button audio-support-settings__player-button--play",
          title: playing ? "Pause" : "Play",
          "aria-label": playing ? "Pause" : "Play",
          onClick: togglePlay,
        },
        playing ? "\u275a\u275a" : "\u25b6"
      ),
      h(
        "button",
        {
          type: "button",
          className: "audio-support-settings__player-button",
          title: "Previous track",
          "aria-label": "Previous track",
          disabled: !props.canPrev,
          onClick: props.onPrev,
        },
        "\u23ee"
      ),
      h(
        "button",
        {
          type: "button",
          className: "audio-support-settings__player-button",
          title: "Next track",
          "aria-label": "Next track",
          disabled: !props.canNext,
          onClick: props.onNext,
        },
        "\u23ed"
      ),
      h(
        "div",
        { className: "audio-support-settings__player-info" },
        h(
          "div",
          { className: "audio-support-settings__player-title", title: getSceneDisplayName(scene) },
          getSceneDisplayName(scene)
        ),
        h(
          "div",
          { className: "audio-support-settings__player-tags" },
          h(TrackTagEditor, { scene: scene, onTagsChange: props.onTagsChange, up: true })
        )
      ),
      h(
        "input",
        {
          type: "range",
          className: "audio-support-settings__player-seek",
          min: 0,
          max: duration > 0 ? duration : 1,
          step: "0.1",
          value: duration > 0 ? Math.min(currentTime, duration) : 0,
          disabled: duration <= 0,
          "aria-label": "Seek",
          onChange: handleSeek,
        }
      ),
      h(
        "span",
        { className: "audio-support-settings__player-time" },
        formatDuration(currentTime) + " / " + formatDuration(duration)
      ),
      h(
        "span",
        { className: "audio-support-settings__player-count" },
        props.index + 1 + " / " + props.total
      ),
      error ? h("span", { className: "audio-support-settings__player-error" }, error) : null,
      h(
        Link,
        { to: "/scenes/" + scene.id, className: "audio-support-settings__player-link", title: "Open scene page" },
        "\u2197"
      ),
      h(
        "button",
        {
          type: "button",
          className: "audio-support-settings__player-close",
          title: "Close player",
          "aria-label": "Close player",
          onClick: props.onClose,
        },
        "\u00d7"
      )
    );
  }

  function TrackRow(props) {
    const scene = props.scene;
    const audioFile = getAudioFile(scene);
    const displayName = getSceneDisplayName(scene);
    return h(
      "div",
      {
        className:
          "audio-support-settings__chapter-row" +
          (props.isActive ? " audio-support-settings__chapter-row--active" : ""),
      },
      h(
        "div",
        { className: "audio-support-settings__chapter-cover" },
        scene.paths && scene.paths.screenshot
          ? h("img", { src: scene.paths.screenshot, alt: "", loading: "lazy" })
          : h("div", { className: "audio-support-settings__chapter-cover--placeholder" })
      ),
      h(
        "div",
        { className: "audio-support-settings__chapter-info" },
        // The title stays a link so the full scene page (details, lyrics,
        // cover) is still one click away.
        h(
          Link,
          { to: "/scenes/" + scene.id, className: "audio-support-settings__chapter-title", title: "Open scene page" },
          displayName
        ),
        h(
          "div",
          { className: "audio-support-settings__chapter-meta" },
          formatDuration(audioFile && audioFile.duration),
          audioFile && audioFile.audio_codec ? " \u00b7 " + audioFile.audio_codec.toUpperCase() : null
        ),
        h(TrackTagEditor, { scene: scene, onTagsChange: props.onTagsChange })
      ),
      props.isActive
        ? h(
            "span",
            { className: "audio-support-settings__chapter-playing", title: "Now playing", "aria-label": "Now playing" },
            "\u266a"
          )
        : h(
            "button",
            {
              type: "button",
              className: "audio-support-settings__chapter-play",
              title: "Play here",
              "aria-label": "Play " + displayName,
              onClick: props.onPlay,
            },
            "\u25b6"
          )
    );
  }

  function FolderDetailView(props) {
    const folder = props.folder;
    const sortedScenes = useMemo(function () {
      return folder.scenes.slice().sort(naturalCompare);
    }, [folder]);

    // Tag edits land on the scene, not on this snapshot of it. The override map
    // keeps the row and the player in sync immediately, and the same set is
    // handed to the page so the By Tag view does not fall back to the stale list.
    const [tagOverrides, setTagOverrides] = useState({});

    const scenes = useMemo(
      function () {
        return sortedScenes.map(function (scene) {
          const override = tagOverrides[String(scene.id)];
          return override ? Object.assign({}, scene, { tags: override }) : scene;
        });
      },
      [sortedScenes, tagOverrides]
    );

    const ids = useMemo(function () {
      return scenes.map(function (s) { return String(s.id); });
    }, [scenes]);

    const [playerIndex, setPlayerIndex] = useState(-1);

    // Keep the persisted queue in step with what the folder view is playing, so
    // opening a scene page afterwards resumes the same folder.
    const persistQueue = useCallback(
      function (index) {
        saveQueueConfig({ queue: ids, currentIndex: index }).catch(function (err) {
          console.error("AudioSupport settings: failed to update queue", err);
        });
      },
      [ids]
    );

    const playIndex = useCallback(
      function (index) {
        if (index < 0 || index >= scenes.length) return;
        setPlayerIndex(index);
        persistQueue(index);
      },
      [scenes.length, persistQueue]
    );

    function handleTagsChange(sceneId, tags) {
      setTagOverrides(function (prev) {
        const next = Object.assign({}, prev);
        next[String(sceneId)] = tags;
        return next;
      });
      if (props.onTagsChange) props.onTagsChange(sceneId, tags);
    }

    function handleEnded() {
      if (playerIndex + 1 < scenes.length) {
        playIndex(playerIndex + 1);
      } else {
        setPlayerIndex(-1);
      }
    }

    const activeScene = playerIndex >= 0 && playerIndex < scenes.length ? scenes[playerIndex] : null;

    return h(
      "div",
      { className: "audio-support-settings__browse-panel" },
      h(
        "div",
        { className: "audio-support-settings__detail-header" },
        h(
          "button",
          {
            type: "button",
            className: "audio-support-settings__button",
            onClick: props.onBack,
          },
          "\u2190 Back to folders"
        ),
        h(
          "button",
          {
            type: "button",
            className: "audio-support-settings__button audio-support-settings__button--primary",
            disabled: scenes.length === 0,
            onClick: function () { playIndex(0); },
          },
          playerIndex >= 0 ? "Restart folder" : "Play Folder"
        )
      ),
      h("h3", { className: "audio-support-settings__detail-title" }, folder.name),
      // The folder path is the only way to tell same-named folders apart, and
      // this header has the room for it.
      h("p", { className: "audio-support-settings__hint" }, folder.dir),
      h(
        "div",
        { className: "audio-support-settings__chapter-list" },
        scenes.map(function (scene, index) {
          return h(TrackRow, {
            key: scene.id,
            scene: scene,
            isActive: index === playerIndex,
            onPlay: function () { playIndex(index); },
            onTagsChange: handleTagsChange,
          });
        })
      ),
      activeScene
        ? h(InlinePlayer, {
            scene: activeScene,
            index: playerIndex,
            total: scenes.length,
            canPrev: playerIndex > 0,
            canNext: playerIndex + 1 < scenes.length,
            onPrev: function () { playIndex(playerIndex - 1); },
            onNext: function () { playIndex(playerIndex + 1); },
            onEnded: handleEnded,
            onClose: function () { setPlayerIndex(-1); },
            onTagsChange: handleTagsChange,
          })
        : null
    );
  }

  function TagCard(props) {
    const group = props.group;
    const count = group.scenes.length;
    return h(
      "button",
      {
        type: "button",
        className: "audio-support-settings__tag-card",
        onClick: props.onClick,
      },
      h("div", { className: "audio-support-settings__tag-name" }, group.tag.name),
      h(
        "div",
        { className: "audio-support-settings__tag-count" },
        count + " scene" + (count === 1 ? "" : "s")
      )
    );
  }

  function TagGridView(props) {
    const groups = props.groups;
    if (groups.length === 0) {
      return h(
        "div",
        { className: "audio-support-settings__empty" },
        h("p", null, "No tags found on audio scenes."),
        h("p", { className: "audio-support-settings__hint" }, "Tag audio scenes to browse by tag.")
      );
    }
    return h(
      "div",
      { className: "audio-support-settings__tag-grid" },
      groups.map(function (group) {
        return h(TagCard, { key: group.tag.id, group: group, onClick: function () { props.onSelect(group); } });
      })
    );
  }

  function TagDetailView(props) {
    const group = props.group;
    const history = PluginApi.libraries.ReactRouterDOM.useHistory();
    const ids = useMemo(function () {
      return group.scenes.map(function (s) { return s.id; });
    }, [group]);

    async function playAll() {
      if (ids.length === 0) return;
      try {
        await saveQueueConfig({ queue: ids, currentIndex: 0 });
        history.push("/scenes/" + ids[0]);
      } catch (err) {
        console.error("AudioSupport settings: failed to play all tagged scenes", err);
      }
    }

    return h(
      "div",
      { className: "audio-support-settings__browse-panel" },
      h(
        "div",
        { className: "audio-support-settings__detail-header" },
        h(
          "button",
          {
            type: "button",
            className: "audio-support-settings__button",
            onClick: props.onBack,
          },
          "\u2190 Back to tags"
        ),
        h(
          "button",
          {
            type: "button",
            className: "audio-support-settings__button audio-support-settings__button--primary",
            onClick: playAll,
          },
          "Play All"
        )
      ),
      h("h3", { className: "audio-support-settings__detail-title" }, group.tag.name),
      h(
        "div",
        { className: "audio-support-settings__scene-grid" },
        group.scenes.map(function (scene) {
          return h(AudioSceneCard, { key: scene.id, scene: scene });
        })
      )
    );
  }

  function BrowseSubNav(props) {
    const views = [
      { id: "folder", label: "By Folder" },
      { id: "all", label: "All Audio" },
      { id: "tag", label: "By Tag" },
    ];
    return h(
      "div",
      { className: "audio-support-settings__sub-nav" },
      views.map(function (view) {
        return h(
          "button",
          {
            key: view.id,
            type: "button",
            className: "audio-support-settings__sub-nav-button " + (props.active === view.id ? "audio-support-settings__sub-nav-button--active" : ""),
            onClick: function () { props.onChange(view.id); },
          },
          view.label
        );
      })
    );
  }

  function BrowseTab(props) {
    const [subView, setSubView] = useState("folder");
    const [selectedFolder, setSelectedFolder] = useState(null);
    const [selectedTagGroup, setSelectedTagGroup] = useState(null);
    const [search, setSearch] = useState("");
    const [sortBy, setSortBy] = useState("title_asc");

    const folders = useMemo(function () {
      return groupByFolder(props.scenes);
    }, [props.scenes]);

    const tagGroups = useMemo(function () {
      return collectTagGroups(props.scenes);
    }, [props.scenes]);

    function handleSubViewChange(view) {
      setSubView(view);
      setSelectedFolder(null);
      setSelectedTagGroup(null);
    }

    return h(
      "section",
      { className: "audio-support-settings__section" },
      h("h2", null, "Browse Audio"),
      h(BrowseSubNav, { active: subView, onChange: handleSubViewChange }),
      subView === "folder" && !selectedFolder
        ? h(FolderGridView, { folders: folders, onSelect: setSelectedFolder })
        : null,
      subView === "folder" && selectedFolder
        ? h(FolderDetailView, {
            // Key by folder so switching folders remounts the view: its tag
            // overrides and the player belong to one folder only.
            key: selectedFolder.dir,
            folder: selectedFolder,
            onTagsChange: props.onTagsChange,
            onBack: function () { setSelectedFolder(null); },
          })
        : null,
      subView === "all"
        ? h(AllAudioView, {
            tag: props.tag,
            scenes: props.scenes,
            search: search,
            setSearch: setSearch,
            sortBy: sortBy,
            setSortBy: setSortBy,
          })
        : null,
      subView === "tag" && !selectedTagGroup
        ? h(TagGridView, { groups: tagGroups, onSelect: setSelectedTagGroup })
        : null,
      subView === "tag" && selectedTagGroup
        ? h(TagDetailView, { group: selectedTagGroup, onBack: function () { setSelectedTagGroup(null); } })
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Covers tab
  // ---------------------------------------------------------------------------

  function GenerateCoversTab(props) {
    return h(
      "section",
      { className: "audio-support-settings__section" },
      h("h2", null, "Generate Covers"),
      h(
        "div",
        { className: "audio-support-settings__covers-grid" },
        h(
          "div",
          { className: "audio-support-settings__cover-option" },
          h("h3", null, "Extract embedded covers"),
          h(
            "p",
            { className: "audio-support-settings__hint" },
            "Reads album art already embedded in MP3/FLAC/M4A files. Skips scenes with no embedded art."
          ),
          h(
            "button",
            {
              type: "button",
              className: "audio-support-settings__button audio-support-settings__button--primary",
              disabled: props.working || !props.tag,
              onClick: props.onExtractEmbedded,
            },
            "Extract embedded covers"
          )
        ),
        h(
          "div",
          { className: "audio-support-settings__cover-option" },
          h("h3", null, "Generate default covers"),
          h(
            "p",
            { className: "audio-support-settings__hint" },
            "Creates a music-note-on-gradient placeholder for every audio scene that has no cover."
          ),
          h(
            "button",
            {
              type: "button",
              className: "audio-support-settings__button",
              disabled: props.working || !props.tag,
              onClick: props.onGenerateDefault,
            },
            "Generate default covers"
          )
        )
      ),
      props.coverProgress
        ? h("div", { className: "audio-support-settings__progress audio-support-settings__progress--center" }, props.coverProgress)
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Generate tab
  // ---------------------------------------------------------------------------

  // Previews are on by default; the rest are opt-in, unlike Stash's
  // GenerateDialog, which enables sprites/phashes/markers as well. Transcodes
  // are not offered at all.
  const GENERATE_OPTION_ROWS = [
    { key: "previews", label: "Previews" },
    { key: "sprites", label: "Sprites" },
    { key: "phashes", label: "Phashes" },
    { key: "markers", label: "Marker screenshots and previews" },
    { key: "covers", label: "Covers" },
  ];

  function GenerateScenesTab(props) {
    const options = props.options;

    return h(
      "section",
      { className: "audio-support-settings__section" },
      h("h2", null, "Generate (skip audio scenes)"),
      h(
        "p",
        { className: "audio-support-settings__hint" },
        "Stash's built-in generate task (Settings > Tasks > Generate) walks every scene. ",
        "Audio files are stored as scenes with an empty video stream, so preview, sprite, phash and cover generation ",
        "fails for them and logs errors. This tab queues the same generate options for the video scenes only: audio ",
        "scenes are skipped by tag, and a per-file probe catches any that the tag misses (typically a scene scanned ",
        "in the same second as a generate run). Probed scenes get the audio tag on the way through."
      ),
      props.tag
        ? h(
            "p",
            { className: "audio-support-settings__hint" },
            props.counts
              ? "Will queue up to " + props.counts.video + " scene(s) as a single generate job; " + props.counts.audio + " scene(s) already carry '" + props.tag.name + "' and more may be caught by the probe."
              : "Counting scenes\u2026"
          )
        : h(
            "p",
            { className: "audio-support-settings__hint" },
            "The audio tag '" + props.tagName + "' does not exist yet, and the task needs it as the place to put the " +
              "scenes it probes. Create it on the Setup tab, then either run 'Tag all audio scenes' or just use this " +
              "tab \u2014 probing tags what it finds."
          ),
      h(
        "div",
        { className: "audio-support-settings__generate-options" },
        GENERATE_OPTION_ROWS.map(function (row) {
          const id = "as-generate-" + row.key;
          return h(
            "div",
            { key: row.key, className: "audio-support-settings__generate-option" },
            h("input", {
              id: id,
              type: "checkbox",
              className: "audio-support-settings__checkbox",
              checked: !!options[row.key],
              onChange: function (e) { props.onToggle(row.key, e.target.checked); },
            }),
            h("label", { htmlFor: id, className: "audio-support-settings__toggle-label" }, row.label)
          );
        }),
        h(
          "div",
          { className: "audio-support-settings__generate-option audio-support-settings__generate-option--disabled" },
          h("input", {
            id: "as-generate-transcodes",
            type: "checkbox",
            className: "audio-support-settings__checkbox",
            disabled: true,
            checked: false,
            readOnly: true,
          }),
          h("label", { htmlFor: "as-generate-transcodes", className: "audio-support-settings__toggle-label" }, "Transcode"),
          h("span", { className: "audio-support-settings__hint" }, "not offered")
        )
      ),
      h(
        "p",
        { className: "audio-support-settings__hint" },
        "Transcode is deliberately unavailable: Stash's transcode task treats an audio-only file as a video and writes a ",
        "blank video, wasting disk and time. There is no useful transcode target for audio."
      ),
      h(
        "div",
        { className: "audio-support-settings__wizard-row" },
        h(
          "label",
          { className: "audio-support-settings__toggle-label" },
          h("input", {
            id: "as-generate-overwrite",
            type: "checkbox",
            className: "audio-support-settings__checkbox",
            checked: !!options.overwrite,
            onChange: function (e) { props.onToggle("overwrite", e.target.checked); },
          }),
          " Overwrite existing generated media"
        )
      ),
      h(
        "div",
        { className: "audio-support-settings__wizard-action" },
        h(
          "button",
          {
            type: "button",
            className: "audio-support-settings__button audio-support-settings__button--primary",
            disabled: props.working || !props.tag || !props.canRun,
            onClick: props.onRun,
          },
          "Queue generate for video scenes"
        ),
        h(
          "span",
          { className: "audio-support-settings__hint" },
          "Runs as a single Stash job \u2014 track progress under Settings > Tasks."
        )
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Settings page component
  // ---------------------------------------------------------------------------

  function AudioSupportSettingsPage() {
    const [config, setConfig] = useState(null);
    const [activeTab, setActiveTab] = useState("browse");
    const [generalConfig, setGeneralConfig] = useState(null);
    const [tag, setTag] = useState(null);
    const [audioScenes, setAudioScenes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [working, setWorking] = useState(false);
    const [message, setMessage] = useState(null);
    const [wizardConfirm, setWizardConfirm] = useState(false);
    const [wizardDiff, setWizardDiff] = useState([]);
    const [coverProgress, setCoverProgress] = useState(null);
    const [generateOptions, setGenerateOptions] = useState(DEFAULT_GENERATE_OPTIONS);
    const [sceneCounts, setSceneCounts] = useState(null);

    useEffect(function () {
      let mounted = true;
      async function init() {
        try {
          const cfg = await loadConfig();
          if (!mounted) return;
          setConfig(cfg);
          updateNavEntryEnabled(cfg.showNavEntry);
          const gen = await queryConfiguration();
          if (!mounted) return;
          setGeneralConfig(gen);
          const existingTag = await findTagByName(cfg.audioTagName);
          if (!mounted) return;
          setTag(existingTag);
          if (existingTag) {
            const scenes = await findAudioScenes(existingTag.id);
            if (!mounted) return;
            setAudioScenes(scenes);
            const counts = await loadSceneCounts(existingTag.id);
            if (!mounted) return;
            setSceneCounts(counts);
          }
          setLoading(false);
        } catch (err) {
          if (!mounted) return;
          console.error("AudioSupport settings: init failed", err);
          setError(String((err && err.message) || err));
          setLoading(false);
        }
      }
      init();
      return function () { mounted = false; };
    }, []);

    const currentExtensions = (generalConfig && generalConfig.general && Array.isArray(generalConfig.general.videoExtensions))
      ? generalConfig.general.videoExtensions
      : [];
    const missingExtensions = AUDIO_EXTENSIONS.filter(function (ext) {
      return currentExtensions.indexOf(ext) === -1;
    });
    const ingestionEnabled = missingExtensions.length === 0;

    async function refreshTagState(existingTag) {
      setTag(existingTag);
      if (!existingTag) {
        setAudioScenes([]);
        setSceneCounts(null);
        return;
      }
      const scenes = await findAudioScenes(existingTag.id);
      setAudioScenes(scenes);
      setSceneCounts(await loadSceneCounts(existingTag.id));
    }

    async function saveTagName(name) {
      const trimmed = (name || DEFAULT_TAG_NAME).trim();
      if (!trimmed) return;
      const next = { ...config, audioTagName: trimmed };
      setConfig(next);
      try {
        await saveConfig({ audioTagName: trimmed });
        setMessage("Saved audio tag name.");
        await refreshTagState(await findTagByName(trimmed));
      } catch (err) {
        setError("Failed to save tag name: " + String((err && err.message) || err));
      }
    }

    async function handleCreateTag() {
      setWorking(true);
      setError(null);
      try {
        const name = config.audioTagName || DEFAULT_TAG_NAME;
        const existing = await findTagByName(name);
        if (existing) {
          await refreshTagState(existing);
          setMessage("Tag '" + name + "' already exists.");
        } else {
          const created = await createTag(name);
          await refreshTagState(created);
          setMessage("Created tag '" + name + "'.");
        }
      } catch (err) {
        setError("Failed to create tag: " + String((err && err.message) || err));
      } finally {
        setWorking(false);
      }
    }

    function startEnableIngestion() {
      if (missingExtensions.length === 0) return;
      setWizardDiff(missingExtensions);
      setWizardConfirm(true);
    }

    async function confirmEnableIngestion() {
      setWizardConfirm(false);
      setWorking(true);
      setError(null);
      try {
        const merged = currentExtensions.slice();
        for (const ext of missingExtensions) {
          if (merged.indexOf(ext) === -1) merged.push(ext);
        }
        await apolloClient.mutate({
          mutation: GQL.ConfigureGeneralDocument,
          variables: { input: { videoExtensions: merged } },
        });
        const refreshed = await queryConfiguration();
        setGeneralConfig(refreshed);
        setMessage("Audio ingestion enabled. Added extensions: " + missingExtensions.join(", "));
      } catch (err) {
        setError("Failed to enable audio ingestion: " + String((err && err.message) || err));
      } finally {
        setWorking(false);
      }
    }

    async function handleGenerateCovers() {
      if (!tag) {
        setError("Create the audio tag first.");
        return;
      }
      setWorking(true);
      setError(null);
      setCoverProgress("Finding audio scenes\u2026");
      try {
        // Use the server-side `is_missing: "cover"` filter so we only generate
        // covers for scenes that actually lack a cover blob. The previous
        // client-side `!paths.screenshot` check was always false because the
        // Stash resolver unconditionally returns a screenshot URL for every
        // scene (placeholder image when no cover exists).
        const target = await findAudioScenesMissingCover(tag.id);
        setCoverProgress("Generating covers for " + target.length + " scene(s)\u2026");
        let done = 0;
        for (const scene of target) {
          const dataUrl = generateDefaultCover(640);
          await updateSceneCover(scene.id, dataUrl);
          done += 1;
          setCoverProgress("Generated " + done + " / " + target.length + " covers\u2026");
        }
        const refreshed = await findAudioScenes(tag.id);
        setAudioScenes(refreshed);
        setCoverProgress(null);
        setMessage("Generated " + done + " default cover(s).");
      } catch (err) {
        setCoverProgress(null);
        setError("Failed to generate covers: " + String((err && err.message) || err));
      } finally {
        setWorking(false);
      }
    }

    function toggleGenerateOption(key, value) {
      setGenerateOptions({ ...generateOptions, [key]: value });
    }

    // The folder view edits tags on the scene itself. Mirror the result into the
    // page's scene list so the By Tag sub-view (built from it) stays truthful.
    function handleSceneTagsChange(sceneId, tags) {
      setAudioScenes(function (prev) {
        return prev.map(function (scene) {
          return String(scene.id) === String(sceneId) ? Object.assign({}, scene, { tags: tags }) : scene;
        });
      });
    }

    // Queues the Goja task (mode "generateVideo") rather than collecting ids
    // here: one implementation, and it also works from Settings > Tasks.
    async function handleRunGenerate() {
      if (!tag) {
        setError("Create the audio tag first (Setup tab).");
        return;
      }
      if (!RUN_PLUGIN_TASK_MUTATION) {
        setError(
          "This Stash version does not expose Apollo's gql tag to plugins, so the task cannot be queued from here. " +
            "Run the 'Generate (skip audio scenes)' plugin task from Settings > Tasks instead."
        );
        return;
      }
      setWorking(true);
      setError(null);
      try {
        const result = await apolloClient.mutate({
          mutation: RUN_PLUGIN_TASK_MUTATION,
          variables: {
            plugin_id: PLUGIN_ID,
            description: "Audio Support: generate (skip audio scenes)",
            args_map: {
              mode: "generateVideo",
              tagName: config.audioTagName || DEFAULT_TAG_NAME,
              sprites: generateOptions.sprites,
              previews: generateOptions.previews,
              phashes: generateOptions.phashes,
              markers: generateOptions.markers,
              covers: generateOptions.covers,
              overwrite: generateOptions.overwrite,
            },
          },
        });
        const jobId = result && result.data ? result.data.runPluginTask : null;
        setMessage(
          "Queued generate for video scenes" +
            (jobId ? " (job " + jobId + ")" : "") +
            ". Progress is shown under Settings > Tasks."
        );
      } catch (err) {
        setError("Failed to queue generate: " + String((err && err.message) || err));
      } finally {
        setWorking(false);
      }
    }

    async function handleExtractEmbeddedCovers() {
      if (!tag) {
        setError("Create the audio tag first.");
        return;
      }
      setWorking(true);
      setError(null);
      setCoverProgress("Loading ID3 parser...");
      try {
        await loadJsMediaTags();
      } catch (err) {
        setError("Failed to load jsmediatags: " + String((err && err.message) || err));
        setCoverProgress(null);
        setWorking(false);
        return;
      }

      let target;
      try {
        setCoverProgress("Finding audio scenes without covers...");
        target = await findAudioScenesMissingCover(tag.id);
      } catch (err) {
        setError("Failed to find scenes: " + String((err && err.message) || err));
        setCoverProgress(null);
        setWorking(false);
        return;
      }

      let extracted = 0;
      let skipped = 0;
      let lastError = null;
      for (let i = 0; i < target.length; i++) {
        const scene = target[i];
        setCoverProgress("Extracting " + (i + 1) + " / " + target.length + "...");
        try {
          const dataUrl = await extractCoverFromScene(scene.id);
          if (dataUrl) {
            await updateSceneCover(scene.id, dataUrl);
            extracted += 1;
          } else {
            skipped += 1;
          }
        } catch (err) {
          console.warn("AudioSupport: embedded cover extraction failed for scene " + scene.id, err);
          skipped += 1;
          lastError = err;
        }
      }

      try {
        const refreshed = await findAudioScenes(tag.id);
        setAudioScenes(refreshed);
      } catch (err) {
        console.error("AudioSupport: failed to refresh scenes after extraction", err);
      }

      setCoverProgress(null);
      let msg = "Extracted " + extracted + " cover" + (extracted === 1 ? "" : "s") + " from " + target.length + " scene" + (target.length === 1 ? "" : "s") + " (" + skipped + " had no embedded art).";
      if (lastError) {
        msg += " Some formats (e.g. OGG) may not be supported.";
      }
      setMessage(msg);
      setWorking(false);
    }

    function tabButton(id, label) {
      return h(
        "button",
        {
          type: "button",
          className: "audio-support-settings__tab " + (activeTab === id ? "audio-support-settings__tab--active" : ""),
          onClick: function () { setActiveTab(id); },
        },
        label
      );
    }

    if (loading || !config) {
      return h("div", { className: "audio-support-settings" }, h(Loading));
    }

    return h(
      "div",
      { className: "audio-support-settings" },
      h("h1", { className: "audio-support-settings__header" }, "Audio Support"),
      error ? h(ErrorBox, { message: error }) : null,
      message
        ? h(
            "div",
            { className: "audio-support-settings__message" },
            message,
            h(
              "button",
              {
                type: "button",
                className: "audio-support-settings__dismiss",
                onClick: function () { setMessage(null); },
              },
              "\u00d7"
            )
          )
        : null,
      h(
        "div",
        { className: "audio-support-settings__tabs" },
        tabButton("browse", "Browse"),
        tabButton("setup", "Setup"),
        tabButton("generate", "Generate"),
        tabButton("covers", "Covers")
      ),

      activeTab === "browse"
        ? h(BrowseTab, { tag: tag, scenes: audioScenes, onTagsChange: handleSceneTagsChange })
        : null,

      activeTab === "generate"
        ? h(GenerateScenesTab, {
            tag: tag,
            tagName: config.audioTagName,
            counts: sceneCounts,
            options: generateOptions,
            onToggle: toggleGenerateOption,
            onRun: handleRunGenerate,
            working: working,
            canRun:
              generateOptions.sprites ||
              generateOptions.previews ||
              generateOptions.phashes ||
              generateOptions.markers ||
              generateOptions.covers,
          })
        : null,

      activeTab === "setup"
        ? h(
            "section",
            { className: "audio-support-settings__section" },
            h("h2", null, "Setup Wizard"),
            h(
              "div",
              { className: "audio-support-settings__wizard-row" },
              h("span", null, "Audio ingestion (videoExtensions)"),
              h(StatusBadge, { ok: ingestionEnabled, label: ingestionEnabled ? "Enabled" : "Not enabled" })
            ),
            h(
              "p",
              { className: "audio-support-settings__hint" },
              "Stash ingests audio files as scenes when their extensions are in the global ",
              h("code", null, "videoExtensions"),
              " list. The plugin needs these extensions: ",
              AUDIO_EXTENSIONS.join(", "),
              "."
            ),
            ingestionEnabled
              ? h("p", { className: "audio-support-settings__hint" }, "All required audio extensions are present.")
              : h(
                  "div",
                  { className: "audio-support-settings__wizard-action" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "audio-support-settings__button audio-support-settings__button--primary",
                      disabled: working,
                      onClick: startEnableIngestion,
                    },
                    "Enable audio ingestion"
                  ),
                  h(
                    "span",
                    { className: "audio-support-settings__hint" },
                    "Will add: " + missingExtensions.join(", ")
                  )
                ),
            wizardConfirm
              ? h(
                  "div",
                  { className: "audio-support-settings__confirm" },
                  h("p", null, "This will add the following extensions to videoExtensions:"),
                  h(
                    "ul",
                    null,
                    wizardDiff.map(function (ext) { return h("li", { key: ext }, ext); })
                  ),
                  h(
                    "div",
                    { className: "audio-support-settings__confirm-actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "audio-support-settings__button audio-support-settings__button--primary",
                        disabled: working,
                        onClick: confirmEnableIngestion,
                      },
                      "Confirm"
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "audio-support-settings__button",
                        disabled: working,
                        onClick: function () { setWizardConfirm(false); },
                      },
                      "Cancel"
                    )
                  )
                )
              : null,
            h("hr", { className: "audio-support-settings__divider" }),
            h(
              "div",
              { className: "audio-support-settings__wizard-row" },
              h("label", { htmlFor: "as-audio-tag" }, "Audio tag name"),
              h("input", {
                id: "as-audio-tag",
                type: "text",
                className: "audio-support-settings__input",
                value: config.audioTagName,
                onChange: function (e) { setConfig({ ...config, audioTagName: e.target.value }); },
                onBlur: function (e) { saveTagName(e.target.value); },
                onKeyDown: function (e) {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveTagName(e.target.value);
                    e.target.blur();
                  }
                },
              })
            ),
            h(
              "div",
              { className: "audio-support-settings__wizard-action" },
              h(
                "button",
                {
                  type: "button",
                  className: "audio-support-settings__button",
                  disabled: working,
                  onClick: handleCreateTag,
                },
                tag ? "Refresh tag" : "Create tag"
              ),
              tag
                ? h("span", { className: "audio-support-settings__hint" }, "Tag exists: " + tag.name)
                : h("span", { className: "audio-support-settings__hint" }, "Tag '" + config.audioTagName + "' does not exist yet.")
            ),
            h("hr", { className: "audio-support-settings__divider" }),
            h("h3", null, "Interface"),
            h(
              "div",
              { className: "audio-support-settings__wizard-row" },
              h("label", { htmlFor: "as-show-nav", className: "audio-support-settings__toggle-label" }, "Show Audio in top navigation"),
              h("input", {
                id: "as-show-nav",
                type: "checkbox",
                className: "audio-support-settings__checkbox",
                checked: config.showNavEntry,
                onChange: function (e) {
                  const next = { ...config, showNavEntry: e.target.checked };
                  setConfig(next);
                  saveConfig({ showNavEntry: e.target.checked });
                  updateNavEntryEnabled(e.target.checked);
                },
              })
            ),
            h("p", { className: "audio-support-settings__hint" }, "Adds an Audio entry to the main top navigation bar. May require a page refresh to take effect."),
            h("hr", { className: "audio-support-settings__divider" }),
            h("h3", null, "Generation caveats"),
            h(
              "p",
              { className: "audio-support-settings__hint" },
              "Stash's generate tasks (sprite, preview, phash) silently produce no output for audio-only scenes, ",
              "and log errors while trying. Use the Generate tab to queue the same work for the non-audio scenes only."
            )
          )
        : null,

      activeTab === "covers"
        ? h(GenerateCoversTab, {
            tag: tag,
            working: working,
            coverProgress: coverProgress,
            onGenerateDefault: handleGenerateCovers,
            onExtractEmbedded: handleExtractEmbeddedCovers,
          })
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Route + launcher + top-nav registration
  // ---------------------------------------------------------------------------

  PluginApi.patch.before("PluginRoutes", function (props) {
    const newChildren = h(
      React.Fragment,
      null,
      props.children,
      h(Route, { path: PLUGIN_ROUTE, component: AudioSupportSettingsPage })
    );
    return [Object.assign({}, props, { children: newChildren })];
  });

  PluginApi.patch.before("SettingsToolsSection", function (props) {
    settingsToolsCallCount += 1;
    if (settingsToolsCallCount % 2 !== 0) {
      return [props];
    }
    const card = h(
      Link,
      { to: PLUGIN_ROUTE, className: "audio-support-settings__launcher" },
      h(
        "div",
        { className: "audio-support-settings__launcher-card" },
        h("h3", null, "Audio Support"),
        h("p", null, "Enable audio ingestion and browse audio scenes")
      )
    );
    const newChildren = Array.isArray(props.children)
      ? [...props.children, card]
      : [props.children, card];
    return [Object.assign({}, props, { children: newChildren })];
  });

  PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    // If config has loaded and the user disabled the entry, skip injection.
    if (navEntryLoaded && !navEntryEnabled) {
      return [props];
    }
    const Bootstrap = PluginApi.libraries.Bootstrap;
    const ReactRouter = PluginApi.libraries.ReactRouterDOM;
    if (!Bootstrap || !Bootstrap.Nav || !Bootstrap.Button || !ReactRouter || !ReactRouter.Link) {
      return [props];
    }
    const Nav = Bootstrap.Nav;
    const Button = Bootstrap.Button;
    const navItem = h(
      Nav.Link,
      { eventKey: PLUGIN_ROUTE, as: "div", key: "audio-nav", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(
        ReactRouter.Link,
        { to: PLUGIN_ROUTE, className: "audio-support-settings__nav-link" },
        h(
          Button,
          { className: "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" },
          h("span", { className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" }, "\u266b"),
          " ",
          h("span", null, "Audio")
        )
      )
    );
    const children = Array.isArray(props.children) ? props.children.slice() : [props.children];
    children.push(navItem);
    return [Object.assign({}, props, { children: children })];
  });
})();
