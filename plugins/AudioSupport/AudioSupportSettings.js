/**
 * AudioSupportSettings — full-page settings UI.
 *
 * Architecture:
 * - Registers a route via PluginApi.patch.before("PluginRoutes", ...) at
 *   /plugins/audiosupport.
 * - Adds a launcher card in Settings > Tools via
 *   PluginApi.patch.before("SettingsToolsSection", ...). The launcher appears
 *   only under the "Scene Tools" subsection (the second SettingsToolsSection
 *   instance in SettingsToolsPanel) by gating on a module-level call counter.
 * - Reads/writes the config key "AudioSupport" (overlay owns collapsed/opacity/
 *   panelPos; this page owns audioTagName).
 * - Uses Apollo client via PluginApi.utils.StashService.getClient() for all data.
 * - Three views: setup wizard, audio browse, and generate default covers.
 */
(function () {
  "use strict";

  if (!window.PluginApi || !window.csLib) {
    console.error("AudioSupport settings: PluginApi or csLib missing");
    return;
  }

  const React = PluginApi.React;
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;
  const { Route, Link } = PluginApi.libraries.ReactRouterDOM;
  const GQL = PluginApi.GQL;
  const apolloClient = PluginApi.utils.StashService.getClient();

  const CONFIG_KEY = "AudioSupport";
  const PLUGIN_ROUTE = "/plugins/audiosupport";
  const AUDIO_EXTENSIONS = ["mp3", "flac", "ogg", "opus", "m4a", "wav", "aac"];
  const DEFAULT_TAG_NAME = "Audio";
  const SORT_OPTIONS = [
    { value: "title_asc", label: "Title (A-Z)" },
    { value: "title_desc", label: "Title (Z-A)" },
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

  // ---------------------------------------------------------------------------
  // Persistence helpers (overlay fields preserved)
  // ---------------------------------------------------------------------------

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
      const merged = {
        collapsed: typeof stored.collapsed === "boolean" ? stored.collapsed : false,
        opacity: typeof stored.opacity === "number" && !Number.isNaN(stored.opacity)
          ? Math.min(1, Math.max(0, stored.opacity))
          : 0.92,
        panelPos: stored.panelPos && typeof stored.panelPos.top === "number" && typeof stored.panelPos.right === "number"
          ? { top: Math.max(0, stored.panelPos.top), right: Math.max(0, stored.panelPos.right) }
          : { top: 8, right: 8 },
        audioTagName: typeof stored.audioTagName === "string" && stored.audioTagName.trim()
          ? stored.audioTagName.trim()
          : DEFAULT_TAG_NAME,
      };
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
      return {
        collapsed: typeof stored.collapsed === "boolean" ? stored.collapsed : false,
        opacity: typeof stored.opacity === "number" && !Number.isNaN(stored.opacity)
          ? Math.min(1, Math.max(0, stored.opacity))
          : 0.92,
        panelPos: stored.panelPos && typeof stored.panelPos.top === "number" && typeof stored.panelPos.right === "number"
          ? { top: Math.max(0, stored.panelPos.top), right: Math.max(0, stored.panelPos.right) }
          : { top: 8, right: 8 },
        audioTagName: typeof stored.audioTagName === "string" && stored.audioTagName.trim()
          ? stored.audioTagName.trim()
          : DEFAULT_TAG_NAME,
      };
    } catch (err) {
      console.error("AudioSupport settings: load failed", err);
      return {
        collapsed: false,
        opacity: 0.92,
        panelPos: { top: 8, right: 8 },
        audioTagName: DEFAULT_TAG_NAME,
      };
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
  // Components
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
    return files.find(function (f) { return f.video_codec === ""; }) || null;
  }

  function useDebouncedValue(value, delay) {
    const [debounced, setDebounced] = useState(value);
    useEffect(function () {
      const t = setTimeout(function () { setDebounced(value); }, delay);
      return function () { clearTimeout(t); };
    }, [value, delay]);
    return debounced;
  }

  function AudioSceneCard(props) {
    const scene = props.scene;
    const audioFile = getAudioFile(scene);
    return h(
      Link,
      {
        to: "/scenes/" + scene.id,
        className: "audio-support-settings__scene-card",
        title: scene.title || "Untitled",
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
        h("div", { className: "audio-support-settings__scene-card-title" }, scene.title || "Untitled"),
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
    );
  }

  function AudioLibraryTab(props) {
    const scenes = props.scenes || [];
    const search = props.search;
    const setSearch = props.setSearch;
    const sortBy = props.sortBy;
    const setSortBy = props.setSortBy;
    const tag = props.tag;

    const debouncedSearch = useDebouncedValue(search, 200);

    const filteredSorted = React.useMemo(
      function () {
        let list = scenes.slice();
        const q = debouncedSearch.trim().toLowerCase();
        if (q) {
          list = list.filter(function (s) {
            return (s.title || "").toLowerCase().indexOf(q) !== -1;
          });
        }
        list.sort(function (a, b) {
          switch (sortBy) {
            case "title_desc":
              return (b.title || "").localeCompare(a.title || "");
            case "created_desc":
              return new Date(b.created_at || 0) - new Date(a.created_at || 0);
            case "created_asc":
              return new Date(a.created_at || 0) - new Date(b.created_at || 0);
            case "duration_desc":
              return (getAudioFile(b).duration || 0) - (getAudioFile(a).duration || 0);
            case "duration_asc":
              return (getAudioFile(a).duration || 0) - (getAudioFile(b).duration || 0);
            case "title_asc":
            default:
              return (a.title || "").localeCompare(b.title || "");
          }
        });
        return list;
      },
      [scenes, debouncedSearch, sortBy]
    );

    return h(
      "section",
      { className: "audio-support-settings__section" },
      h("h2", null, "Audio Library"),
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
                placeholder: "Search by title...",
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
            { className: "audio-support-settings__scene-grid" },
            filteredSorted.map(function (scene) {
              return h(AudioSceneCard, { key: scene.id, scene: scene });
            })
          )
        : null
    );
  }

  function AudioSupportSettingsPage() {
    const [config, setConfig] = useState(null);
    const [activeTab, setActiveTab] = useState("setup");
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
    const [search, setSearch] = useState("");
    const [sortBy, setSortBy] = useState("title_asc");

    useEffect(function () {
      let mounted = true;
      async function init() {
        try {
          const cfg = await loadConfig();
          if (!mounted) return;
          setConfig(cfg);
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

    async function saveTagName(name) {
      const trimmed = (name || DEFAULT_TAG_NAME).trim();
      if (!trimmed) return;
      const next = { ...config, audioTagName: trimmed };
      setConfig(next);
      try {
        await saveConfig({ audioTagName: trimmed });
        setMessage("Saved audio tag name.");
        const existingTag = await findTagByName(trimmed);
        setTag(existingTag);
        if (existingTag) {
          const scenes = await findAudioScenes(existingTag.id);
          setAudioScenes(scenes);
        }
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
          setTag(existing);
          const scenes = await findAudioScenes(existing.id);
          setAudioScenes(scenes);
          setMessage("Tag '" + name + "' already exists.");
        } else {
          const created = await createTag(name);
          setTag(created);
          setAudioScenes([]);
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
        tabButton("setup", "Setup"),
        tabButton("browse", "Audio Library"),
        tabButton("covers", "Generate Covers")
      ),

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
            h("h3", null, "Generation caveats"),
            h(
              "p",
              { className: "audio-support-settings__hint" },
              "Stash's generate tasks (sprite, preview, phash) silently produce no output for audio-only scenes. ",
              "For audio-heavy libraries, consider disabling those generate options or skipping audio-tagged scenes."
            )
          )
        : null,

      activeTab === "browse"
        ? h(AudioLibraryTab, {
            tag: tag,
            scenes: audioScenes,
            search: search,
            setSearch: setSearch,
            sortBy: sortBy,
            setSortBy: setSortBy,
          })
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
  // Route + launcher registration
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
})();
