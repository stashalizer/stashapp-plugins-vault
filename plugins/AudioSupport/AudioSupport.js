/**
 * AudioSupport plugin — player overlay
 *
 * Architecture:
 * - Uses PluginApi.patch.instead("ScenePlayer", ...) to intercept the React
 *   ScenePlayer component at script load. For audio-only scenes (video_codec === ""
 *   or width === 0), returns a <div id="AudioSupportMount"> instead of the video.js
 *   player. video.js never initializes for audio scenes — no errors, no visual
 *   redundancy.
 * - Uses csLib.PathElementListener to inject the audio overlay on /scenes/ when
 *   #AudioSupportMount exists, and on subsequent stash:location SPA navigations.
 * - Adds an extra window.PluginApi.Event "stash:location" safety net to re-inject
 *   the audio overlay if React re-renders remove it. There can be a brief flash
 *   between removal and re-injection.
 * - Audio-only scenes are detected via the GraphQL FindScene query: the primary file
 *   has video_codec === "" (or width === 0). For those scenes, the overlay renders a
 *   plain HTML5 <audio> element loading the direct stream URL.
 * - Stash's transcode endpoints (stream.mp4 / stream.webm / mkv) fail for audio-only
 *   files because FileGetCodec forces a video encode. The ONLY working endpoint is
 *   the direct stream, available as scene.paths.stream (fallback /scene/{id}/stream).
 * - Overlay-owned state (collapsed, opacity, panelPos, audioTagName, playbackRate,
 *   loop, volume, lyricsVisible) is persisted to the same config key "AudioSupport".
 *   csLib.getConfiguration/setConfiguration are async; a save lock coalesces
 *   concurrent writes. Lyrics are stored per-scene in custom_fields.AudioLyrics.
 */
(function () {
  "use strict";

  const csLib = window.csLib;

  // --- ScenePlayer patch: replace video.js with a mount div for audio scenes ---
  var PluginApi = window.PluginApi;
  if (PluginApi && PluginApi.patch && PluginApi.React) {
    var React = PluginApi.React;
    // PluginApi.patch.instead passes (props, _, original) where `original` is
    // the next render function (called directly, not as a factory). The second
    // arg is an unused context slot — do NOT treat it as the next fn.
    PluginApi.patch.instead("ScenePlayer", function (props, _ctx, original) {
      var scene = props && props.scene;
      var file = scene && scene.files && scene.files[0];
      // Audio-only scene: return a mount point; video.js never initializes.
      if (isAudioFile(file)) {
        return React.createElement("div", {
          id: "AudioSupportMount",
          className: "audio-support-mount",
        });
      }
      // Normal video scene: render the original ScenePlayer.
      return original(props);
    });
  } else {
    console.error("AudioSupport: PluginApi not available; cannot patch ScenePlayer.");
  }

  if (!csLib) {
    console.error("AudioSupport: CommunityScriptsUILibrary not loaded. Install it first.");
    return;
  }

  const CONFIG_KEY = "AudioSupport";
  const QUEUE_CONFIG_KEY = "AudioSupportQueue";
  const storage = window.AudioSupportStorage || {
    loadConfig: function () { return csLib.getConfiguration(CONFIG_KEY).then(function (v) { return v || {}; }); },
    saveConfig: function (value) { return csLib.setConfiguration(CONFIG_KEY, value); },
    loadKey: function (key, csKey) { return csLib.getConfiguration(csKey); },
    saveKey: function (key, value, csKey) { return csLib.setConfiguration(csKey, value); },
  };
  const DEFAULT_OPACITY = 0.92;
  const DEFAULT_PANEL_POS = { top: 8, right: 8 };

  let state = {
    collapsed: false,
    opacity: DEFAULT_OPACITY,
    panelPos: { ...DEFAULT_PANEL_POS },
    audioTagName: "Audio",
    playbackRate: 1.0,
    loop: false,
    volume: 1.0,
    lyricsVisible: false,
  };

  // In-memory lyrics for the current scene (loaded from scene.custom_fields.AudioLyrics).
  let lyricsState = { parsed: [], metadata: {}, raw: null };

  let saving = false;
  let pendingSave = false;

  // Queue state lives in a separate config key to avoid racing with the settings
  // page over the main "AudioSupport" key.
  let queueState = { queue: [], currentIndex: 0, repeat: "off" };
  let queueSaving = false;
  let queuePendingSave = false;
  // Whether the current scene is part of the persisted queue. When false
  // (user navigated to a scene outside the queue), queue controls are hidden
  // but the queue itself is preserved for later resumption.
  let sceneInQueue = false;

  // Current audio overlay references.
  let currentPlayer = null;
  let overlayRoot = null;
  let audioEl = null;
  // Cached scene + audio file from the last successful setupPanel, so the
  // collapsed→expand path can re-render without a fresh Apollo query
  // (fetchPolicy is "no-cache", so without this the expand would re-fetch).
  let cachedScene = null;
  let cachedAudioFile = null;

  // Volume persistence debounce timer.
  let volumeSaveTimeout = null;

  // Current scene id (for saving lyrics back to custom_fields).
  let currentSceneId = null;
  let lyricsOffset = 0;
  let chaptersState = [];
  let bookmarksState = [];
  let sleepTimerId = null;
  let sleepFadeId = null;

  // Container element for lyrics DOM nodes, used for sync scrolling.
  let lyricsContainer = null;

  // Name of the scene custom field used for LRC lyrics.
  let lyricsFieldName = "AudioLyrics";

  // ---------------------------------------------------------------------------
  // Queue helpers
  // ---------------------------------------------------------------------------

  function sanitizeQueueState(stored) {
    const s = stored && typeof stored === "object" ? stored : {};
    const queue = Array.isArray(s.queue)
      ? s.queue.filter(function (id) { return typeof id === "string" && id; })
      : [];
    const idx = typeof s.currentIndex === "number" && !Number.isNaN(s.currentIndex)
      ? Math.max(0, Math.min(queue.length - 1, Math.floor(s.currentIndex)))
      : 0;
    const repeat = ["off", "all", "one"].indexOf(s.repeat) !== -1 ? s.repeat : "off";
    return { queue: queue, currentIndex: queue.length > 0 ? idx : 0, repeat: repeat };
  }

  async function saveQueueNow() {
    if (queueSaving) {
      queuePendingSave = true;
      return;
    }
    queueSaving = true;
    queuePendingSave = false;
    try {
      await storage.saveKey("queue", {
        queue: queueState.queue,
        currentIndex: queueState.currentIndex,
        repeat: queueState.repeat,
      }, QUEUE_CONFIG_KEY, "Audio Support queue");
    } catch (err) {
      console.error("AudioSupport: failed to save queue configuration", err);
    } finally {
      queueSaving = false;
      if (queuePendingSave) {
        queuePendingSave = false;
        saveQueueNow();
      }
    }
  }

  async function loadQueueState() {
    let stored = null;
    try {
      stored = await storage.loadKey("queue", QUEUE_CONFIG_KEY);
    } catch (err) {
      console.error("AudioSupport: failed to read queue configuration", err);
      stored = null;
    }
    queueState = sanitizeQueueState(stored);
  }

  function updateQueueIndicator(el) {
    if (!el) return;
    const len = queueState.queue.length;
    if (len > 1 && sceneInQueue) {
      el.textContent = (queueState.currentIndex + 1) + " / " + len;
      el.style.display = "";
    } else {
      el.style.display = "none";
    }
  }

  function updatePrevNextButtons(prevBtn, nextBtn) {
    if (!prevBtn || !nextBtn) return;
    const len = queueState.queue.length;
    const active = len > 1 && sceneInQueue;
    prevBtn.style.display = active ? "" : "none";
    nextBtn.style.display = active ? "" : "none";
    if (!active) return;
    const canGoBack = queueState.currentIndex > 0 || queueState.repeat === "all";
    const canGoForward = queueState.currentIndex + 1 < len || queueState.repeat === "all";
    prevBtn.disabled = !canGoBack;
    nextBtn.disabled = !canGoForward;
  }

  function updateRepeatButton(btn) {
    if (!btn) return;
    btn.classList.toggle("audio-support-overlay__repeat-button--off", queueState.repeat === "off");
    btn.classList.toggle("audio-support-overlay__repeat-button--all", queueState.repeat === "all");
    btn.classList.toggle("audio-support-overlay__repeat-button--one", queueState.repeat === "one");
    btn.title = "Repeat: " + queueState.repeat + " (r)";
    btn.setAttribute("aria-label", "Repeat mode: " + queueState.repeat);
    btn.textContent = queueState.repeat === "one" ? "1" : "\ud83d\udd01";
  }

  function navigateToScene(sceneId) {
    if (!sceneId) return;
    // Use React Router's history API if it is exposed; otherwise pushState + a
    // synthetic popstate so the SPA picks up the route change without a reload.
    const router = window.PluginApi && window.PluginApi.libraries && window.PluginApi.libraries.ReactRouterDOM;
    if (router && router.history) {
      try {
        router.history.push("/scenes/" + sceneId);
        return;
      } catch (err) {
        console.warn("AudioSupport: ReactRouter history.push failed", err);
      }
    }
    window.history.pushState({}, "", "/scenes/" + sceneId);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // ---------------------------------------------------------------------------
  // Docked player (survives SPA navigation)
  // ---------------------------------------------------------------------------

  let dockRoot = null;
  let dockAudio = null;
  let dockScene = null;
  let dockTitle = null;

  function graphqlRequest(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (response) {
      if (!response.ok) throw new Error("GraphQL HTTP " + response.status);
      return response.json();
    }).then(function (payload) {
      if (payload.errors && payload.errors.length) throw new Error(payload.errors[0].message);
      return payload.data;
    });
  }

  let activityState = {
    sceneId: null,
    audio: null,
    lastWrite: 0,
    pendingDuration: 0,
    timer: null,
    counted: false,
  };

  function beginActivity(sceneId, audio) {
    if (!sceneId || !audio) return;
    if (activityState.sceneId === String(sceneId) && activityState.audio === audio && activityState.counted) {
      return;
    }
    endActivity();
    activityState.sceneId = String(sceneId);
    activityState.audio = audio;
    activityState.lastWrite = Date.now();
    activityState.pendingDuration = 0;
    activityState.counted = true;
    graphqlRequest(
      "mutation ($id: ID!) { sceneAddPlay(id: $id) { count history } }",
      { id: String(sceneId) }
    ).catch(function (err) { console.warn("AudioSupport: sceneAddPlay failed", err); });
    activityState.timer = setInterval(function () {
      flushActivity();
    }, 5000);
  }

  function flushActivity(force) {
    if (!activityState.audio || !activityState.sceneId) return;
    const now = Date.now();
    if (!force && now - activityState.lastWrite < 5000) return;
    const elapsed = Math.max(0, (now - activityState.lastWrite) / 1000);
    activityState.lastWrite = now;
    if (!activityState.audio.paused) activityState.pendingDuration += elapsed;
    const audio = activityState.audio;
    const sceneId = activityState.sceneId;
    if (audio.readyState < 1) return;
    const duration = activityState.pendingDuration;
    activityState.pendingDuration = 0;
    graphqlRequest(
      "mutation ($id: ID!, $resume: Float, $duration: Float) { sceneSaveActivity(id: $id, resume_time: $resume, playDuration: $duration) }",
      { id: sceneId, resume: audio.currentTime || 0, duration: duration }
    ).catch(function (err) { console.warn("AudioSupport: sceneSaveActivity failed", err); });
  }

  function endActivity() {
    if (activityState.timer) {
      clearInterval(activityState.timer);
      activityState.timer = null;
    }
    if (activityState.audio) flushActivity(true);
    activityState.sceneId = null;
    activityState.audio = null;
    activityState.counted = false;
  }

  function maybeResumeFromScene(scene, audio) {
    if (!scene || !audio) return;
    const resume = typeof scene.resume_time === "number" ? scene.resume_time : 0;
    if (resume > 5 && isFinite(audio.duration) && resume < audio.duration - 5) {
      try {
        audio.currentTime = resume;
      } catch (err) {
        console.warn("AudioSupport: resume seek failed", err);
      }
    }
  }

  function ensureDock() {
    if (dockRoot) return dockRoot;
    dockRoot = document.createElement("div");
    dockRoot.className = "audio-support-dock";

    const controls = document.createElement("div");
    controls.className = "audio-support-dock__controls";

    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "\u23ee";
    prev.title = "Previous track";
    prev.addEventListener("click", function () { dockStep(-1); });

    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "\u25b6";
    play.title = "Play/Pause";
    play.addEventListener("click", function () {
      if (!dockAudio) return;
      if (dockAudio.paused) dockAudio.play().catch(function () {});
      else dockAudio.pause();
    });

    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "\u23ed";
    next.title = "Next track";
    next.addEventListener("click", function () { dockStep(1); });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "\u00d7";
    close.title = "Stop and close dock";
    close.addEventListener("click", closeDock);

    controls.appendChild(prev);
    controls.appendChild(play);
    controls.appendChild(next);
    controls.appendChild(close);

    dockTitle = document.createElement("span");
    dockTitle.className = "audio-support-dock__title";
    dockTitle.textContent = "Audio";

    dockRoot.appendChild(controls);
    dockRoot.appendChild(dockTitle);
    document.body.appendChild(dockRoot);

    dockAudio = document.createElement("audio");
    dockAudio.preload = "metadata";
    dockAudio.addEventListener("play", function () {
      if (dockScene) beginActivity(dockScene.id, dockAudio);
      syncDockButtons();
    });
    dockAudio.addEventListener("pause", function () {
      flushActivity(true);
      syncDockButtons();
    });
    dockAudio.addEventListener("ended", function () {
      endActivity();
      if (queueState.repeat === "one") {
        dockAudio.currentTime = 0;
        dockAudio.play().catch(function () {});
        return;
      }
      dockStep(1, true);
    });
    dockAudio.addEventListener("loadedmetadata", function () {
      if (dockScene) maybeResumeFromScene(dockScene, dockAudio);
      syncDockButtons();
    });
    dockAudio.addEventListener("timeupdate", function () {
      if (!dockAudio.paused) flushActivity();
    });
    dockRoot.appendChild(dockAudio);
    return dockRoot;
  }

  function syncDockButtons() {
    if (!dockRoot || !dockAudio) return;
    const play = dockRoot.querySelector("button[title='Play/Pause']");
    if (play) play.textContent = dockAudio.paused ? "\u25b6" : "\u23f8";
    if (dockTitle && dockScene) dockTitle.textContent = getSceneDisplayName(dockScene);
  }

  function startDockPlayback(scene, audio, startTime) {
    if (!scene || !audio) return;
    ensureDock();
    dockScene = scene;
    dockRoot.classList.add("audio-support-dock--visible");
    const src = scene.paths && scene.paths.stream ? scene.paths.stream : "/scene/" + scene.id + "/stream";
    if (dockAudio.src !== new URL(src, window.location.href).href) {
      dockAudio.src = src;
      dockAudio.currentTime = 0;
    }
    dockAudio.playbackRate = audio.playbackRate || state.playbackRate;
    dockAudio.volume = audio.volume;
    dockAudio.loop = audio.loop;
    const seekTo = typeof startTime === "number" ? startTime : audio.currentTime;
    const applySeekAndPlay = function () {
      try {
        if (seekTo > 0) dockAudio.currentTime = seekTo;
      } catch (err) { /* metadata may not be ready */ }
      dockAudio.play().catch(function (err) {
        console.warn("AudioSupport: dock play failed", err);
      });
    };
    if (dockAudio.readyState >= 1) applySeekAndPlay();
    else dockAudio.addEventListener("loadedmetadata", applySeekAndPlay, { once: true });
    syncDockButtons();
  }

  function detachToDock() {
    if (!audioEl || audioEl.paused || !cachedScene) return;
    startDockPlayback(cachedScene, audioEl, audioEl.currentTime);
  }

  async function dockPlayScene(sceneId, index) {
    const scene = await fetchScene(sceneId);
    if (!scene) return;
    const audioFile = getAudioFile(scene);
    if (!audioFile) return;
    if (typeof index === "number") queueState.currentIndex = index;
    const inQueueIndex = queueState.queue.indexOf(String(scene.id));
    if (inQueueIndex !== -1) queueState.currentIndex = inQueueIndex;
    sceneInQueue = true;
    saveQueueNow();
    ensureDock();
    dockScene = scene;
    dockRoot.classList.add("audio-support-dock--visible");
    dockAudio.src = scene.paths && scene.paths.stream ? scene.paths.stream : "/scene/" + scene.id + "/stream";
    dockAudio.playbackRate = state.playbackRate;
    dockAudio.volume = state.volume;
    dockAudio.loop = state.loop;
    syncDockButtons();
    try {
      await dockAudio.play();
    } catch (err) {
      console.warn("AudioSupport: dock play failed", err);
    }
  }

  function dockStep(delta, auto) {
    const len = queueState.queue.length;
    if (len === 0) return;
    let next = queueState.currentIndex + delta;
    if (next < 0) next = queueState.repeat === "all" && auto ? len - 1 : 0;
    if (next >= len) {
      if (queueState.repeat === "all") next = 0;
      else return;
    }
    dockPlayScene(queueState.queue[next], next);
  }

  function closeDock() {
    endActivity();
    if (dockAudio) {
      dockAudio.pause();
      dockAudio.removeAttribute("src");
      dockAudio.load();
    }
    if (dockRoot) dockRoot.classList.remove("audio-support-dock--visible");
    dockScene = null;
  }

  function pauseDock() {
    if (dockAudio && !dockAudio.paused) dockAudio.pause();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function getOpacityIcon(value) {
    if (value <= 0.2) return "\u25cb";
    if (value <= 0.5) return "\u25d1";
    if (value <= 0.8) return "\u25d0";
    return "\u25cf";
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    const secs = Math.floor(seconds % 60);
    const mins = Math.floor((seconds / 60) % 60);
    const hours = Math.floor(seconds / 3600);
    if (hours > 0) {
      return hours + ":" + (mins < 10 ? "0" + mins : mins) + ":" + (secs < 10 ? "0" + secs : secs);
    }
    return mins + ":" + (secs < 10 ? "0" + secs : secs);
  }

  function parseSceneId() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  function isAudioFile(file) {
    return file && (file.video_codec === "" || file.width === 0 || file.height === 0);
  }

  function parseTimeToSeconds(str) {
    const match = String(str || "").match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!match) return null;
    const hours = parseInt(match[1] || "0", 10);
    const mins = parseInt(match[2], 10);
    const secs = parseInt(match[3], 10);
    const ms = parseInt((match[4] || "0").padEnd(3, "0"), 10);
    return hours * 3600 + mins * 60 + secs + ms / 1000;
  }

  function parseLrcText(text, extraOffsetSec) {
    const entries = [];
    const metadata = {};
    if (typeof text !== "string" || text.trim() === "") {
      return { entries: entries, metadata: metadata };
    }
    const lines = text.split(/\r?\n/);
    const timeTagRe = /\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/g;
    const metaTagRe = /^\[(\w+):([^\]]*)\]$/;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const metaMatch = line.match(metaTagRe);
      if (metaMatch) {
        const key = metaMatch[1].toLowerCase();
        const value = metaMatch[2].trim();
        metadata[key] = value;
        continue;
      }
      const timeTags = [];
      let match;
      while ((match = timeTagRe.exec(line)) !== null) {
        timeTags.push(match[1]);
      }
      if (timeTags.length === 0) continue;
      const lyricText = line.replace(timeTagRe, "").trim();
      for (const tag of timeTags) {
        const seconds = parseTimeToSeconds(tag);
        if (seconds !== null) {
          entries.push({ time: seconds, text: lyricText, text2: "" });
        }
      }
    }
    entries.sort(function (a, b) { return a.time - b.time; });
    let offsetMs = 0;
    if (metadata.offset) {
      const parsed = parseInt(metadata.offset, 10);
      if (!Number.isNaN(parsed)) offsetMs = parsed;
    }
    const totalOffset = offsetMs / 1000 + (typeof extraOffsetSec === "number" ? extraOffsetSec : 0);
    const grouped = [];
    for (const entry of entries) {
      const adjusted = Math.max(0, entry.time + totalOffset);
      const prev = grouped[grouped.length - 1];
      if (prev && Math.abs(prev.time - adjusted) < 0.01) {
        if (!prev.text2 && entry.text) prev.text2 = entry.text;
      } else {
        grouped.push({ time: adjusted, text: entry.text, text2: "" });
      }
    }
    return { entries: grouped, metadata: metadata };
  }

  function findCurrentLyricIndex(time) {
    const entries = lyricsState.parsed;
    if (!entries || entries.length === 0) return -1;
    let idx = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].time <= time) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }

  function getAudioFile(scene) {
    const files = scene && scene.files;
    if (!Array.isArray(files) || files.length === 0) return null;
    const primary = scene.primary_file_id ? files.find(function (f) { return String(f.id) === String(scene.primary_file_id); }) : null;
    if (primary && isAudioFile(primary)) return primary;
    for (const f of files) {
      if (isAudioFile(f)) return f;
    }
    return null;
  }

  // Header label for the current track: the file name without its extension.
  // Stash leaves a scanned scene's title empty, and titles written by an import
  // are sometimes the full path, so neither can be shown as-is. Mirrors
  // getSceneDisplayName in AudioSupportSettings.js — keep the two in sync.
  var FILE_EXTENSION_PATTERN = /^[A-Za-z0-9]{1,5}$/;

  function getBaseName(value) {
    if (!value) return "";
    var parts = String(value).replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || "";
  }

  // Only strip when the tail looks like an extension, so a title such as
  // "Op. 27 No. 2" keeps its dots.
  function stripFileExtension(name) {
    if (!name) return "";
    var dot = name.lastIndexOf(".");
    if (dot <= 0) return name;
    if (!FILE_EXTENSION_PATTERN.test(name.substring(dot + 1))) return name;
    return name.substring(0, dot);
  }

  function getSceneDisplayName(scene) {
    var file = scene && scene.files && scene.files[0];
    var fromFile = stripFileExtension(getBaseName(file && file.path));
    if (fromFile) return fromFile;
    return stripFileExtension(getBaseName(scene && scene.title)) || "Audio";
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async function saveNow() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    pendingSave = false;
    try {
      const stored = (await storage.loadConfig()) || {};
      const merged = Object.assign({}, stored, {
        collapsed: state.collapsed,
        opacity: state.opacity,
        panelPos: state.panelPos,
        audioTagName: state.audioTagName,
        playbackRate: state.playbackRate,
        loop: state.loop,
        volume: state.volume,
        lyricsVisible: state.lyricsVisible,
      });
      await storage.saveConfig(merged, function (latest) {
        return Object.assign({}, latest || {}, merged);
      }, "Audio Support overlay");
    } catch (err) {
      console.error("AudioSupport: failed to save configuration", err);
    } finally {
      saving = false;
      if (pendingSave) {
        pendingSave = false;
        saveNow();
      }
    }
  }

  async function loadState() {
    let stored = null;
    try {
      stored = await storage.loadConfig();
    } catch (err) {
      console.error("AudioSupport: failed to read configuration", err);
      stored = null;
    }
    if (stored && typeof stored === "object") {
      if (typeof stored.collapsed === "boolean") state.collapsed = stored.collapsed;
      if (typeof stored.opacity === "number" && !Number.isNaN(stored.opacity)) {
        state.opacity = clamp(stored.opacity, 0, 1);
      }
      if (stored.panelPos && typeof stored.panelPos.top === "number" && typeof stored.panelPos.right === "number") {
        state.panelPos = {
          top: Math.max(0, stored.panelPos.top),
          right: Math.max(0, stored.panelPos.right),
        };
      }
      if (typeof stored.audioTagName === "string" && stored.audioTagName.trim()) {
        state.audioTagName = stored.audioTagName.trim();
      }
      // New fields: safe fallbacks for backward compatibility with old config.
      if (typeof stored.playbackRate === "number" && !Number.isNaN(stored.playbackRate)) {
        state.playbackRate = stored.playbackRate;
      }
      if (typeof stored.loop === "boolean") {
        state.loop = stored.loop;
      }
      if (typeof stored.volume === "number" && !Number.isNaN(stored.volume)) {
        state.volume = clamp(stored.volume, 0, 1);
      }
      if (typeof stored.lyricsVisible === "boolean") {
        state.lyricsVisible = stored.lyricsVisible;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GraphQL / data
  // ---------------------------------------------------------------------------

  async function fetchScene(sceneId) {
    if (!window.PluginApi || !window.PluginApi.GQL || !window.PluginApi.utils || !window.PluginApi.utils.StashService) {
      return null;
    }
    try {
      const client = window.PluginApi.utils.StashService.getClient();
      const result = await client.query({
        query: window.PluginApi.GQL.FindSceneDocument,
        variables: { id: sceneId },
        fetchPolicy: "no-cache",
      });
      return result && result.data ? result.data.findScene : null;
    } catch (err) {
      console.error("AudioSupport: failed to fetch scene", err);
      return null;
    }
  }

  async function saveSceneLyrics(sceneId, lrcText) {
    if (!window.PluginApi || !window.PluginApi.GQL || !window.PluginApi.utils || !window.PluginApi.utils.StashService) {
      return false;
    }
    try {
      const client = window.PluginApi.utils.StashService.getClient();
      await client.mutate({
        mutation: window.PluginApi.GQL.SceneUpdateDocument,
        variables: {
          input: {
            id: sceneId,
            custom_fields: { partial: { AudioLyrics: lrcText } },
          },
        },
      });
      return true;
    } catch (err) {
      console.error("AudioSupport: failed to save lyrics", err);
      return false;
    }
  }

  async function saveSceneCustomField(sceneId, field, value) {
    if (!window.PluginApi || !window.PluginApi.GQL || !window.PluginApi.utils || !window.PluginApi.utils.StashService) {
      return false;
    }
    try {
      const client = window.PluginApi.utils.StashService.getClient();
      const partial = {};
      partial[field] = value;
      await client.mutate({
        mutation: window.PluginApi.GQL.SceneUpdateDocument,
        variables: {
          input: {
            id: sceneId,
            custom_fields: { partial: partial },
          },
        },
      });
      return true;
    } catch (err) {
      console.error("AudioSupport: failed to save custom field", field, err);
      return false;
    }
  }

  async function fetchChapters(sceneId) {
    try {
      const response = await fetch("/graphql", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "query ($id: ID!) { findScene(id: $id) { scene_markers { id seconds title } } }",
          variables: { id: String(sceneId) },
        }),
      });
      const payload = await response.json();
      const scene = payload.data && payload.data.findScene;
      return ((scene && scene.scene_markers) || []).map(function (m) {
        return { id: String(m.id), seconds: typeof m.seconds === "number" ? m.seconds : 0, title: m.title || "" };
      }).sort(function (a, b) { return a.seconds - b.seconds; });
    } catch (err) {
      console.warn("AudioSupport: chapter lookup failed", err);
      return [];
    }
  }

  function parseBookmarks(scene) {
    const raw = scene && scene.custom_fields && scene.custom_fields.AudioBookmarks;
    if (typeof raw !== "string" || !raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (b) {
        return b && typeof b.seconds === "number" && isFinite(b.seconds);
      }).map(function (b) {
        return {
          id: String(b.id || ("bm-" + b.seconds)),
          seconds: b.seconds,
          label: typeof b.label === "string" && b.label ? b.label : formatTime(b.seconds),
        };
      });
    } catch (err) {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay DOM construction
  // ---------------------------------------------------------------------------

  function clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function buildOverlay(scene, audioFile) {
    const overlay = document.createElement("div");
    overlay.className = "audio-support-overlay__panel";
    overlay.style.setProperty("--as-bg-alpha", state.opacity);

    const header = document.createElement("div");
    header.className = "audio-support-overlay__header";

    const title = document.createElement("span");
    title.className = "audio-support-overlay__title";
    title.textContent = getSceneDisplayName(scene);
    header.appendChild(title);

    const controls = document.createElement("span");
    controls.className = "audio-support-overlay__header-controls";

    const opacityWrap = document.createElement("span");
    opacityWrap.className = "audio-support-overlay__opacity-control";

    const opacityBtn = document.createElement("button");
    opacityBtn.type = "button";
    opacityBtn.dataset.action = "opacity-reset";
    opacityBtn.className = "audio-support-overlay__opacity-button";
    opacityBtn.title = "Background opacity (Ctrl/\u2318+click to reset)";
    opacityBtn.setAttribute("aria-label", "Background opacity");
    opacityBtn.textContent = getOpacityIcon(state.opacity);
    opacityWrap.appendChild(opacityBtn);

    const opacitySlider = document.createElement("input");
    opacitySlider.type = "range";
    opacitySlider.className = "audio-support-overlay__opacity-slider";
    opacitySlider.dataset.action = "opacity-slider";
    opacitySlider.min = "0";
    opacitySlider.max = "1";
    opacitySlider.step = "0.05";
    opacitySlider.value = String(state.opacity);
    opacitySlider.setAttribute("aria-label", "Background opacity");
    opacitySlider.addEventListener("input", function () {
      const v = parseFloat(opacitySlider.value);
      if (Number.isNaN(v)) return;
      state.opacity = clamp(v, 0, 1);
      overlay.style.setProperty("--as-bg-alpha", state.opacity);
      opacityBtn.textContent = getOpacityIcon(state.opacity);
    });
    opacitySlider.addEventListener("change", function () {
      saveNow();
    });
    opacityWrap.appendChild(opacitySlider);
    controls.appendChild(opacityWrap);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "audio-support-overlay__close-button";
    closeBtn.title = "Collapse";
    closeBtn.setAttribute("aria-label", "Collapse panel");
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", function () {
      state.collapsed = true;
      saveNow();
      renderCollapsed(overlayRoot);
    });
    controls.appendChild(closeBtn);

    header.appendChild(controls);
    overlay.appendChild(header);

    const body = document.createElement("div");
    body.className = "audio-support-overlay__body";

    // Cover art
    const cover = document.createElement("div");
    cover.className = "audio-support-overlay__cover";
    const coverImg = document.createElement("img");
    coverImg.className = "audio-support-overlay__cover-img";
    coverImg.alt = "";
    coverImg.src = scene.paths && scene.paths.screenshot ? scene.paths.screenshot : "";
    coverImg.addEventListener("error", function () {
      coverImg.style.display = "none";
      cover.classList.add("audio-support-overlay__cover--placeholder");
    });
    if (!coverImg.src) {
      cover.classList.add("audio-support-overlay__cover--placeholder");
    }
    cover.appendChild(coverImg);
    body.appendChild(cover);

    // Metadata
    const meta = document.createElement("div");
    meta.className = "audio-support-overlay__meta";

    const codec = document.createElement("span");
    codec.className = "audio-support-overlay__codec";
    codec.textContent = (audioFile.audio_codec || "Unknown").toUpperCase();
    meta.appendChild(codec);

    const duration = document.createElement("span");
    duration.className = "audio-support-overlay__duration";
    duration.textContent = formatTime(audioFile.duration || 0);
    meta.appendChild(duration);

    if (audioFile.bit_rate) {
      const br = document.createElement("span");
      br.className = "audio-support-overlay__bitrate";
      br.textContent = Math.round(audioFile.bit_rate / 1000) + " kbps";
      meta.appendChild(br);
    }

    body.appendChild(meta);

    // Transport controls
    const transport = document.createElement("div");
    transport.className = "audio-support-overlay__transport";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "audio-support-overlay__prev-button";
    prevBtn.title = "Previous track (p / MediaTrackPrevious)";
    prevBtn.setAttribute("aria-label", "Previous track");
    prevBtn.textContent = "\u23ee";
    transport.appendChild(prevBtn);

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "audio-support-overlay__play-button";
    playBtn.textContent = "\u25b6";
    playBtn.setAttribute("aria-label", "Play");
    transport.appendChild(playBtn);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "audio-support-overlay__next-button";
    nextBtn.title = "Next track (n / MediaTrackNext)";
    nextBtn.setAttribute("aria-label", "Next track");
    nextBtn.textContent = "\u23ed";
    transport.appendChild(nextBtn);

    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "audio-support-overlay__seek";
    seek.min = "0";
    seek.max = "1000";
    seek.value = "0";
    seek.step = "1";
    seek.setAttribute("aria-label", "Seek");
    transport.appendChild(seek);

    const time = document.createElement("span");
    time.className = "audio-support-overlay__time";
    time.textContent = "0:00 / 0:00";
    transport.appendChild(time);

    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "audio-support-overlay__volume";
    volume.min = "0";
    volume.max = "1";
    volume.step = "0.05";
    volume.value = String(state.volume);
    volume.setAttribute("aria-label", "Volume");
    transport.appendChild(volume);

    const lyricsBtn = document.createElement("button");
    lyricsBtn.type = "button";
    lyricsBtn.className = "audio-support-overlay__lyrics-button" + (state.lyricsVisible ? " audio-support-overlay__lyrics-button--active" : "");
    lyricsBtn.title = "Toggle lyrics (k)";
    lyricsBtn.setAttribute("aria-label", "Toggle lyrics");
    lyricsBtn.textContent = "\u266a Lyrics";
    transport.appendChild(lyricsBtn);

    const speedLoop = document.createElement("div");
    speedLoop.className = "audio-support-overlay__speed-loop";

    const speedSelect = document.createElement("select");
    speedSelect.className = "audio-support-overlay__speed-select";
    speedSelect.title = "Playback speed";
    speedSelect.setAttribute("aria-label", "Playback speed");
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    for (const rate of speeds) {
      const opt = document.createElement("option");
      opt.value = String(rate);
      opt.textContent = rate + "x";
      if (Math.abs(rate - state.playbackRate) < 0.001) opt.selected = true;
      speedSelect.appendChild(opt);
    }
    speedLoop.appendChild(speedSelect);

    const loopBtn = document.createElement("button");
    loopBtn.type = "button";
    loopBtn.className = "audio-support-overlay__loop-button" + (state.loop ? " audio-support-overlay__loop-button--active" : "");
    loopBtn.title = "Loop (l)";
    loopBtn.setAttribute("aria-label", "Loop");
    loopBtn.textContent = "\ud83d\udd01";
    speedLoop.appendChild(loopBtn);

    const repeatBtn = document.createElement("button");
    repeatBtn.type = "button";
    repeatBtn.className = "audio-support-overlay__repeat-button";
    repeatBtn.title = "Repeat (r)";
    repeatBtn.setAttribute("aria-label", "Repeat");
    repeatBtn.textContent = "\ud83d\udd01";
    speedLoop.appendChild(repeatBtn);

    const queueIndicator = document.createElement("span");
    queueIndicator.className = "audio-support-overlay__queue-indicator";
    queueIndicator.title = "Queue position";
    speedLoop.appendChild(queueIndicator);

    const sleepSelect = document.createElement("select");
    sleepSelect.className = "audio-support-overlay__sleep-select";
    sleepSelect.title = "Sleep timer";
    sleepSelect.setAttribute("aria-label", "Sleep timer");
    [["0", "Sleep off"], ["5", "5 min"], ["15", "15 min"], ["30", "30 min"], ["60", "60 min"]].forEach(function (opt) {
      const option = document.createElement("option");
      option.value = opt[0];
      option.textContent = opt[1];
      sleepSelect.appendChild(option);
    });
    sleepSelect.addEventListener("change", function () {
      if (sleepTimerId) {
        clearTimeout(sleepTimerId);
        sleepTimerId = null;
      }
      if (sleepFadeId) {
        clearInterval(sleepFadeId);
        sleepFadeId = null;
      }
      const minutes = parseInt(sleepSelect.value, 10) || 0;
      if (minutes <= 0) return;
      const fadeMs = 30000;
      const delay = Math.max(0, minutes * 60000 - fadeMs);
      sleepTimerId = setTimeout(function () {
        const startVolume = audio.volume;
        const started = Date.now();
        sleepFadeId = setInterval(function () {
          const progress = Math.min(1, (Date.now() - started) / fadeMs);
          audio.volume = startVolume * (1 - progress);
          if (progress >= 1) {
            clearInterval(sleepFadeId);
            sleepFadeId = null;
            audio.pause();
            audio.volume = startVolume;
            sleepSelect.value = "0";
          }
        }, 500);
      }, delay);
    });
    speedLoop.appendChild(sleepSelect);

    transport.appendChild(speedLoop);
    body.appendChild(transport);

    updateRepeatButton(repeatBtn);
    updateQueueIndicator(queueIndicator);
    updatePrevNextButtons(prevBtn, nextBtn);
    overlay.appendChild(body);

    // Audio element (hidden, direct stream only)
    const audio = document.createElement("audio");
    audio.className = "audio-support-overlay__audio";
    audio.preload = "metadata";
    audio.playbackRate = state.playbackRate;
    audio.loop = state.loop;
    audio.volume = state.volume;
    const streamUrl = scene.paths && scene.paths.stream ? scene.paths.stream : "/scene/" + scene.id + "/stream";
    audio.src = streamUrl;
    overlay.appendChild(audio);

    audio.addEventListener("play", function () {
      pauseDock();
      beginActivity(scene.id, audio);
    });
    audio.addEventListener("pause", function () {
      flushActivity(true);
    });
    audio.addEventListener("ended", function () {
      endActivity();
    });
    audio.addEventListener("loadedmetadata", function () {
      maybeResumeFromScene(scene, audio);
    });
    audio.addEventListener("timeupdate", function () {
      if (!audio.paused) flushActivity();
    });

    if (chaptersState.length > 0) {
      const chapters = document.createElement("div");
      chapters.className = "audio-support-overlay__chapters";
      const heading = document.createElement("div");
      heading.className = "audio-support-overlay__chapters-header";
      heading.textContent = "Chapters";
      chapters.appendChild(heading);
      chaptersState.forEach(function (chapter) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "audio-support-overlay__chapter";
        row.textContent = formatTime(chapter.seconds) + " · " + (chapter.title || "Chapter");
        row.addEventListener("click", function () {
          audio.currentTime = chapter.seconds;
          if (audio.paused) audio.play().catch(function () {});
        });
        chapters.appendChild(row);
      });
      body.appendChild(chapters);
    }

    // Wire controls
    playBtn.addEventListener("click", function () {
      if (audio.paused) {
        audio.play().catch(function (err) {
          console.error("AudioSupport: play failed", err);
        });
      } else {
        audio.pause();
      }
    });

    function updatePlayButton() {
      playBtn.textContent = audio.paused ? "\u25b6" : "\u23f8";
      playBtn.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    }

    audio.addEventListener("play", updatePlayButton);
    audio.addEventListener("pause", updatePlayButton);
    audio.addEventListener("ended", async function () {
      updatePlayButton();
      seek.value = 0;
      if (queueState.repeat === "one") {
        audio.currentTime = 0;
        try {
          await audio.play();
        } catch (err) {
          console.warn("AudioSupport: repeat-one play failed", err);
        }
        return;
      }
      const len = queueState.queue.length;
      const nextIndex = queueState.currentIndex + 1;
      if (len > 1 && nextIndex < len) {
        queueState.currentIndex = nextIndex;
        await saveQueueNow();
        navigateToScene(queueState.queue[nextIndex]);
      } else if (len > 1 && queueState.repeat === "all") {
        queueState.currentIndex = 0;
        await saveQueueNow();
        navigateToScene(queueState.queue[0]);
      }
    });

    audio.addEventListener("loadedmetadata", function () {
      seek.max = isFinite(audio.duration) ? audio.duration : 1000;
      time.textContent = formatTime(audio.currentTime || 0) + " / " + formatTime(audio.duration || 0);
    });

    function updateLyricsHighlight(time) {
      if (!lyricsContainer) return;
      const idx = findCurrentLyricIndex(time);
      const lines = lyricsContainer.children;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === idx) {
          if (!line.classList.contains("audio-support-overlay__lyrics-line--current")) {
            line.classList.add("audio-support-overlay__lyrics-line--current");
            line.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          const start = parseFloat(line.dataset.time) || 0;
          const end = parseFloat(line.dataset.end) || (start + 4);
          const pct = clamp((time - start) / Math.max(0.1, end - start), 0, 1);
          line.style.setProperty("--as-karaoke", (pct * 100).toFixed(1) + "%");
        } else {
          line.classList.remove("audio-support-overlay__lyrics-line--current");
          line.style.removeProperty("--as-karaoke");
        }
      }
    }

    audio.addEventListener("timeupdate", function () {
      if (!audio.seeking) {
        seek.value = isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime : 0;
      }
      time.textContent = formatTime(audio.currentTime || 0) + " / " + formatTime(audio.duration || 0);
      updateLyricsHighlight(audio.currentTime || 0);
    });

    let wasPlayingBeforeSeek = false;
    seek.addEventListener("input", function () {
      if (!wasPlayingBeforeSeek && !audio.paused) {
        wasPlayingBeforeSeek = true;
        audio.pause();
      }
      if (isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = parseFloat(seek.value);
      }
    });
    seek.addEventListener("change", function () {
      if (isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = parseFloat(seek.value);
      }
      if (wasPlayingBeforeSeek) {
        audio.play().catch(function () {});
      }
      wasPlayingBeforeSeek = false;
    });

    volume.addEventListener("input", function () {
      audio.volume = clamp(parseFloat(volume.value), 0, 1);
    });
    volume.addEventListener("change", function () {
      // Slider release: commit immediately.
      state.volume = clamp(parseFloat(volume.value), 0, 1);
      saveNow();
    });

    function scheduleVolumeSave() {
      if (volumeSaveTimeout) clearTimeout(volumeSaveTimeout);
      volumeSaveTimeout = setTimeout(function () {
        state.volume = clamp(audio.volume, 0, 1);
        volume.value = String(state.volume);
        saveNow();
      }, 500);
    }

    audio.addEventListener("volumechange", function () {
      const v = clamp(audio.volume, 0, 1);
      // Keep the slider in sync when muted via keyboard shortcut or system changes.
      if (Math.abs(parseFloat(volume.value) - v) > 0.001) {
        volume.value = String(v);
      }
      // Debounced persistence: don't write on every pixel of a drag.
      scheduleVolumeSave();
    });

    speedSelect.addEventListener("change", function () {
      const rate = parseFloat(speedSelect.value);
      if (!Number.isNaN(rate) && isFinite(rate) && rate > 0) {
        state.playbackRate = rate;
        audio.playbackRate = rate;
        saveNow();
      }
    });

    function updateLoopButton() {
      loopBtn.classList.toggle("audio-support-overlay__loop-button--active", state.loop);
    }

    function toggleLoop() {
      state.loop = !state.loop;
      audio.loop = state.loop;
      updateLoopButton();
      saveNow();
    }

    loopBtn.addEventListener("click", toggleLoop);

    function cycleRepeatMode() {
      const modes = ["off", "all", "one"];
      queueState.repeat = modes[(modes.indexOf(queueState.repeat) + 1) % modes.length];
      updateRepeatButton(repeatBtn);
      saveQueueNow();
    }

    repeatBtn.addEventListener("click", cycleRepeatMode);

    async function goToPreviousTrack() {
      const len = queueState.queue.length;
      if (len <= 1) return;
      if (queueState.currentIndex > 0) {
        queueState.currentIndex -= 1;
      } else if (queueState.repeat === "all") {
        queueState.currentIndex = len - 1;
      } else {
        return;
      }
      await saveQueueNow();
      navigateToScene(queueState.queue[queueState.currentIndex]);
    }

    async function goToNextTrack() {
      const len = queueState.queue.length;
      if (len <= 1) return;
      if (queueState.currentIndex + 1 < len) {
        queueState.currentIndex += 1;
      } else if (queueState.repeat === "all") {
        queueState.currentIndex = 0;
      } else {
        return;
      }
      await saveQueueNow();
      navigateToScene(queueState.queue[queueState.currentIndex]);
    }

    prevBtn.addEventListener("click", goToPreviousTrack);
    nextBtn.addEventListener("click", goToNextTrack);

    function toggleLyricsPanel() {
      state.lyricsVisible = !state.lyricsVisible;
      updateLyricsButton();
      renderLyricsSection();
      saveNow();
    }

    function updateLyricsButton() {
      lyricsBtn.classList.toggle("audio-support-overlay__lyrics-button--active", state.lyricsVisible);
    }

    lyricsBtn.addEventListener("click", toggleLyricsPanel);

    const lyricsSection = document.createElement("div");
    lyricsSection.className = "audio-support-overlay__lyrics-section";
    body.appendChild(lyricsSection);

    const bookmarksSection = document.createElement("div");
    bookmarksSection.className = "audio-support-overlay__bookmarks";
    body.appendChild(bookmarksSection);

    function persistBookmarks() {
      if (currentSceneId) {
        saveSceneCustomField(currentSceneId, "AudioBookmarks", JSON.stringify(bookmarksState));
      }
    }

    function renderBookmarksSection() {
      clearChildren(bookmarksSection);
      const header = document.createElement("div");
      header.className = "audio-support-overlay__bookmarks-header";
      const label = document.createElement("span");
      label.textContent = "Bookmarks";
      header.appendChild(label);
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "+ Bookmark";
      add.className = "audio-support-overlay__bookmark-add";
      add.addEventListener("click", function () {
        const seconds = audio.currentTime || 0;
        bookmarksState.push({
          id: "bm-" + Date.now().toString(36),
          seconds: seconds,
          label: formatTime(seconds),
        });
        bookmarksState.sort(function (a, b) { return a.seconds - b.seconds; });
        persistBookmarks();
        renderBookmarksSection();
      });
      header.appendChild(add);
      bookmarksSection.appendChild(header);
      bookmarksState.forEach(function (bookmark) {
        const row = document.createElement("div");
        row.className = "audio-support-overlay__bookmark";
        const seek = document.createElement("button");
        seek.type = "button";
        seek.textContent = formatTime(bookmark.seconds) + " · " + bookmark.label;
        seek.addEventListener("click", function () {
          audio.currentTime = bookmark.seconds;
          if (audio.paused) audio.play().catch(function () {});
        });
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "\u00d7";
        del.title = "Delete bookmark";
        del.addEventListener("click", function () {
          bookmarksState = bookmarksState.filter(function (b) { return b.id !== bookmark.id; });
          persistBookmarks();
          renderBookmarksSection();
        });
        row.appendChild(seek);
        row.appendChild(del);
        bookmarksSection.appendChild(row);
      });
    }

    function setLyricsOffset(value) {
      lyricsOffset = Math.round(value * 10) / 10;
      const parsed = parseLrcText(lyricsState.raw || "", lyricsOffset);
      lyricsState.parsed = parsed.entries;
      lyricsState.metadata = parsed.metadata;
      if (currentSceneId) saveSceneCustomField(currentSceneId, "AudioLyricsOffset", lyricsOffset);
      renderLyricsSection();
    }

    function adjustLyricsOffset(delta) {
      setLyricsOffset(lyricsOffset + delta);
    }

    function renderLyricsSection() {
      clearChildren(lyricsSection);
      if (!state.lyricsVisible) {
        lyricsSection.style.display = "none";
        return;
      }
      lyricsSection.style.display = "";
      // Allow keyboard shortcut to re-trigger rendering when the section is empty.
      lyricsSection.addEventListener("as-render-lyrics", renderLyricsSection, { once: true });
      const hasLyrics = lyricsState.parsed && lyricsState.parsed.length > 0;

      const header = document.createElement("div");
      header.className = "audio-support-overlay__lyrics-header";
      const title = document.createElement("span");
      title.className = "audio-support-overlay__lyrics-title";
      title.textContent = lyricsState.metadata.ti || "Lyrics";
      header.appendChild(title);

      const artist = lyricsState.metadata.ar;
      if (artist) {
        const byline = document.createElement("span");
        byline.className = "audio-support-overlay__lyrics-byline";
        byline.textContent = artist;
        header.appendChild(byline);
      }

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "audio-support-overlay__lyrics-load-button";
      loadBtn.textContent = hasLyrics ? "Edit LRC" : "Load LRC";
      loadBtn.addEventListener("click", showLyricsEditor);
      header.appendChild(loadBtn);

      const offsetWrap = document.createElement("span");
      offsetWrap.className = "audio-support-overlay__lyrics-offset";
      const minus = document.createElement("button");
      minus.type = "button";
      minus.textContent = "-0.1s";
      minus.title = "Lyrics earlier by 100 ms";
      minus.addEventListener("click", function () { adjustLyricsOffset(-0.1); });
      const plus = document.createElement("button");
      plus.type = "button";
      plus.textContent = "+0.1s";
      plus.title = "Lyrics later by 100 ms";
      plus.addEventListener("click", function () { adjustLyricsOffset(0.1); });
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "0";
      reset.title = "Reset lyrics offset";
      reset.addEventListener("click", function () { setLyricsOffset(0); });
      offsetWrap.appendChild(minus);
      offsetWrap.appendChild(plus);
      offsetWrap.appendChild(reset);
      header.appendChild(offsetWrap);
      lyricsSection.appendChild(header);

      if (hasLyrics) {
        const container = document.createElement("div");
        container.className = "audio-support-overlay__lyrics-lines";
        for (let i = 0; i < lyricsState.parsed.length; i++) {
          const entry = lyricsState.parsed[i];
          const line = document.createElement("div");
          line.className = "audio-support-overlay__lyrics-line";
          line.dataset.time = String(entry.time);
          line.dataset.index = String(i);
          if (i + 1 < lyricsState.parsed.length) {
            line.dataset.end = String(lyricsState.parsed[i + 1].time);
          }
          const primary = document.createElement("span");
          primary.className = "audio-support-overlay__lyrics-primary";
          primary.textContent = entry.text || "\u266a";
          line.appendChild(primary);
          if (entry.text2) {
            const secondary = document.createElement("span");
            secondary.className = "audio-support-overlay__lyrics-secondary";
            secondary.textContent = entry.text2;
            line.appendChild(secondary);
          }
          line.addEventListener("click", function () {
            audio.currentTime = entry.time;
            if (audio.paused) audio.play().catch(function () {});
          });
          container.appendChild(line);
        }
        lyricsSection.appendChild(container);
        lyricsContainer = container;
      } else {
        const empty = document.createElement("div");
        empty.className = "audio-support-overlay__lyrics-empty";
        const hint = document.createElement("p");
        hint.textContent = "No lyrics loaded";
        empty.appendChild(hint);
        const loadBtn2 = document.createElement("button");
        loadBtn2.type = "button";
        loadBtn2.className = "audio-support-overlay__lyrics-load-button";
        loadBtn2.textContent = "Load LRC";
        loadBtn2.addEventListener("click", showLyricsEditor);
        empty.appendChild(loadBtn2);
        lyricsSection.appendChild(empty);
        lyricsContainer = null;
      }
      updateLyricsHighlight(audio.currentTime || 0);
    }

    function showLyricsEditor() {
      clearChildren(lyricsSection);
      lyricsSection.style.display = "";

      const editor = document.createElement("div");
      editor.className = "audio-support-overlay__lyrics-editor";

      const title = document.createElement("div");
      title.className = "audio-support-overlay__lyrics-editor-title";
      title.textContent = "Load LRC lyrics";
      editor.appendChild(title);

      const fileWrap = document.createElement("div");
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".lrc,.txt";
      fileInput.className = "audio-support-overlay__lyrics-file";
      fileInput.addEventListener("change", function () {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
          textarea.value = String(reader.result || "");
        };
        reader.readAsText(file);
      });
      fileWrap.appendChild(fileInput);
      editor.appendChild(fileWrap);

      const textarea = document.createElement("textarea");
      textarea.className = "audio-support-overlay__lyrics-textarea";
      textarea.placeholder = "Paste LRC lyrics here...";
      textarea.value = lyricsState.raw || "";
      editor.appendChild(textarea);

      const buttons = document.createElement("div");
      buttons.className = "audio-support-overlay__lyrics-editor-buttons";

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "audio-support-overlay__lyrics-save-button";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", async function () {
        const text = textarea.value;
        const parsed = parseLrcText(text, lyricsOffset);
        lyricsState = { parsed: parsed.entries, metadata: parsed.metadata, raw: text };
        if (currentSceneId) {
          await saveSceneLyrics(currentSceneId, text);
        }
        renderLyricsSection();
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "audio-support-overlay__lyrics-cancel-button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", renderLyricsSection);

      buttons.appendChild(saveBtn);
      buttons.appendChild(cancelBtn);
      editor.appendChild(buttons);
      lyricsSection.appendChild(editor);
    }

    renderLyricsSection();
    renderBookmarksSection();

    return { overlay: overlay, audio: audio, playBtn: playBtn, seek: seek, time: time, prevBtn: prevBtn, nextBtn: nextBtn, queueIndicator: queueIndicator };
  }

  function renderCollapsed(panel) {
    clearChildren(panel);
    panel.classList.add("audio-support-overlay--collapsed");
    panel.style.width = "";
    panel.style.height = "";
    panel.style.top = state.panelPos.top + "px";
    panel.style.right = state.panelPos.right + "px";
    panel.style.left = "auto";
    panel.style.bottom = "auto";

    const chip = document.createElement("div");
    chip.className = "audio-support-overlay__chip";
    chip.dataset.dragThreshold = "true";
    chip.title = "Click to expand \u00b7 Drag to move";
    chip.textContent = "\u266a Audio";
    chip.addEventListener("pointerdown", startPanelDrag);
    chip.addEventListener("click", function () {
      state.collapsed = false;
      saveNow();
      // Re-render from the cached scene/audio file (set during the last
      // setupPanel) to avoid a fresh Apollo query on every expand.
      const p = currentPlayer || document.querySelector("#AudioSupportMount");
      if (p && cachedScene && cachedAudioFile) {
        renderExpanded(overlayRoot, cachedScene, cachedAudioFile);
      } else if (p) {
        setupPanel(p);
      }
    });
    panel.appendChild(chip);
  }

  function renderExpanded(panel, scene, audioFile) {
    clearChildren(panel);
    panel.classList.remove("audio-support-overlay--collapsed");
    panel.style.width = "";
    panel.style.height = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.left = "";
    panel.style.bottom = "";

    const built = buildOverlay(scene, audioFile);
    panel.appendChild(built.overlay);
    audioEl = built.audio;
    // Refresh queue controls after a fresh render, using the queue state that was
    // loaded/updated during setupPanel.
    updateQueueIndicator(built.queueIndicator);
    updatePrevNextButtons(built.prevBtn, built.nextBtn);
    installKeyboardListeners();
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  function isEditingText() {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
  }

  function onKeyDown(e) {
    if (!audioEl || overlayRoot.classList.contains("audio-support-overlay--collapsed")) return;
    if (isEditingText()) return;

    switch (e.key) {
      case " ":
      case "Spacebar":
        e.preventDefault();
        if (audioEl.paused) {
          audioEl.play().catch(function () {});
        } else {
          audioEl.pause();
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isFinite(audioEl.duration) && audioEl.duration > 0) {
          audioEl.currentTime = Math.max(0, audioEl.currentTime - 5);
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (isFinite(audioEl.duration) && audioEl.duration > 0) {
          audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + 5);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        audioEl.volume = clamp(audioEl.volume + 0.1, 0, 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        audioEl.volume = clamp(audioEl.volume - 0.1, 0, 1);
        break;
      case "m":
      case "M":
        audioEl.muted = !audioEl.muted;
        break;
      case "l":
      case "L":
        {
          state.loop = !state.loop;
          audioEl.loop = state.loop;
          saveNow();
          // Update the button visual if it still exists in the DOM.
          const loopBtn = overlayRoot.querySelector(".audio-support-overlay__loop-button");
          if (loopBtn) loopBtn.classList.toggle("audio-support-overlay__loop-button--active", state.loop);
        }
        break;
      case "k":
      case "K":
        {
          state.lyricsVisible = !state.lyricsVisible;
          saveNow();
          const lyricsBtn = overlayRoot.querySelector(".audio-support-overlay__lyrics-button");
          if (lyricsBtn) lyricsBtn.classList.toggle("audio-support-overlay__lyrics-button--active", state.lyricsVisible);
          const lyricsSection = overlayRoot.querySelector(".audio-support-overlay__lyrics-section");
          if (lyricsSection) {
            // Render the section content if toggling on and it is currently empty.
            if (state.lyricsVisible) {
              lyricsSection.style.display = "";
              if (lyricsSection.children.length === 0) {
                const event = new Event("as-render-lyrics");
                lyricsSection.dispatchEvent(event);
              }
            } else {
              lyricsSection.style.display = "none";
            }
          }
        }
        break;
      case "n":
      case "N":
      case "MediaTrackNext":
        e.preventDefault();
        {
          const nextBtn = overlayRoot.querySelector(".audio-support-overlay__next-button");
          if (nextBtn && nextBtn.style.display !== "none" && !nextBtn.disabled) {
            nextBtn.click();
          }
        }
        break;
      case "p":
      case "P":
      case "MediaTrackPrevious":
        e.preventDefault();
        {
          const prevBtn = overlayRoot.querySelector(".audio-support-overlay__prev-button");
          if (prevBtn && prevBtn.style.display !== "none" && !prevBtn.disabled) {
            prevBtn.click();
          }
        }
        break;
      case "r":
      case "R":
        e.preventDefault();
        {
          const repeatBtn = overlayRoot.querySelector(".audio-support-overlay__repeat-button");
          if (repeatBtn) repeatBtn.click();
        }
        break;
    }
  }

  let keyboardInstalled = false;
  function installKeyboardListeners() {
    if (keyboardInstalled) return;
    keyboardInstalled = true;
    document.addEventListener("keydown", onKeyDown);
  }

  function removeKeyboardListeners() {
    if (!keyboardInstalled) return;
    keyboardInstalled = false;
    document.removeEventListener("keydown", onKeyDown);
  }

  // ---------------------------------------------------------------------------
  // Panel drag
  // ---------------------------------------------------------------------------

  function startPanelDrag(e) {
    if (e.target.closest("button") || e.target.closest("input")) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const panel = document.querySelector(".audio-support-overlay");
    if (!panel) return;
    const isCollapsed = panel.classList.contains("audio-support-overlay--collapsed");
    if (!isCollapsed) return;

    const rect = panel.getBoundingClientRect();
    const startTop = state.panelPos.top;
    const startRight = state.panelPos.right;
    const startX = e.clientX;
    const startY = e.clientY;
    const threshold = e.currentTarget.dataset && e.currentTarget.dataset.dragThreshold === "true";
    let dragMoved = false;

    function clampPosition(top, right) {
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const maxRight = Math.max(0, window.innerWidth - rect.width);
      return {
        top: Math.max(0, Math.min(maxTop, top)),
        right: Math.max(0, Math.min(maxRight, right)),
      };
    }

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (threshold && !dragMoved) {
        if (Math.hypot(dx, dy) < 5) return;
        dragMoved = true;
      }
      const next = clampPosition(startTop + dy, startRight - dx);
      state.panelPos = next;
      panel.style.top = next.top + "px";
      panel.style.right = next.right + "px";
      panel.style.left = "auto";
      panel.style.bottom = "auto";
    }

    function onEnd() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      if (dragMoved) saveNow();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  function teardownOverlay() {
    if (activityState.audio === audioEl) endActivity();
    if (sleepTimerId) {
      clearTimeout(sleepTimerId);
      sleepTimerId = null;
    }
    if (sleepFadeId) {
      clearInterval(sleepFadeId);
      sleepFadeId = null;
    }
    removeKeyboardListeners();
    if (volumeSaveTimeout) {
      clearTimeout(volumeSaveTimeout);
      volumeSaveTimeout = null;
    }
    if (overlayRoot && overlayRoot.parentElement) {
      overlayRoot.parentElement.removeChild(overlayRoot);
    }
    overlayRoot = null;
    audioEl = null;
    currentPlayer = null;
    lyricsContainer = null;
  }

  async function setupPanel(playerEl) {
    const sceneId = parseSceneId();
    if (!sceneId) return;

    if (playerEl.querySelector(".audio-support-overlay")) return;

    const scene = await fetchScene(sceneId);
    if (!scene) return;

    const audioFile = getAudioFile(scene);
    if (!audioFile) {
      cachedScene = null;
      cachedAudioFile = null;
      return;
    }

    await loadState();
    await loadQueueState();

    // If the current scene is part of the persisted queue, keep its index in
    // sync; otherwise treat it as a standalone scene (hide queue controls).
    const inQueueIndex = queueState.queue.indexOf(String(sceneId));
    if (inQueueIndex !== -1) {
      queueState.currentIndex = inQueueIndex;
      sceneInQueue = true;
    } else {
      sceneInQueue = false;
    }

    if (playerEl.querySelector(".audio-support-overlay")) return;

    currentPlayer = playerEl;
    // Cache so the collapsed→expand path can re-render without a fresh query.
    cachedScene = scene;
    cachedAudioFile = audioFile;

    currentSceneId = scene.id;
    const rawLyrics = scene.custom_fields && typeof scene.custom_fields.AudioLyrics === "string"
      ? scene.custom_fields.AudioLyrics
      : null;
    const storedOffset = scene.custom_fields && scene.custom_fields.AudioLyricsOffset;
    lyricsOffset = typeof storedOffset === "number" && isFinite(storedOffset) ? storedOffset : 0;
    const parsedLyrics = parseLrcText(rawLyrics || "", lyricsOffset);
    lyricsState = { parsed: parsedLyrics.entries, metadata: parsedLyrics.metadata, raw: rawLyrics };
    chaptersState = await fetchChapters(scene.id);
    bookmarksState = parseBookmarks(scene);

    overlayRoot = document.createElement("div");
    overlayRoot.className = "audio-support-overlay";
    playerEl.appendChild(overlayRoot);

    if (state.collapsed) {
      renderCollapsed(overlayRoot);
    } else {
      renderExpanded(overlayRoot, scene, audioFile);
    }
  }

  function tryInject() {
    const p = document.querySelector("#AudioSupportMount");
    if (p) setupPanel(p);
  }

  // On SPA navigation, React may unmount the player element. Tear down any
  // overlay bound to the previous (now-detached) player before re-injecting,
  // so we don't leak a dangling overlay or double-mount on the new player.
  function reInject() {
    detachToDock();
    teardownOverlay();
    tryInject();
  }

  csLib.PathElementListener("/scenes/", "#AudioSupportMount", setupPanel);

  if (window.PluginApi && window.PluginApi.Event && typeof window.PluginApi.Event.addEventListener === "function") {
    window.PluginApi.Event.addEventListener("stash:location", function () {
      reInject();
    });
  }

  window.addEventListener("pagehide", function () {
    // Flush any pending volume/queue/activity saves before leaving the page.
    if (volumeSaveTimeout) {
      clearTimeout(volumeSaveTimeout);
      volumeSaveTimeout = null;
      state.volume = audioEl ? clamp(audioEl.volume, 0, 1) : state.volume;
    }
    flushActivity(true);
    saveNow();
    saveQueueNow();
  });
})();
