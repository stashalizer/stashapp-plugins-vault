/**
 * AudioSupport plugin — player overlay
 *
 * Architecture:
 * - Uses csLib.PathElementListener to inject on /scenes/ when #VideoJsPlayer exists,
 *   and on subsequent stash:location SPA navigations.
 * - Adds an extra window.PluginApi.Event "stash:location" safety net to re-inject the
 *   audio overlay if React re-renders remove it. There can be a brief flash between
 *   removal and re-injection.
 * - Audio-only scenes are detected via the GraphQL FindScene query: the primary file
 *   has video_codec === "" (or width === 0). For those scenes, we hide the broken
 *   video.js player UI and render a plain HTML5 <audio> element loading the direct
 *   stream URL.
 * - Stash's transcode endpoints (stream.mp4 / stream.webm / mkv) fail for audio-only
 *   files because FileGetCodec forces a video encode. The ONLY working endpoint is
 *   the direct stream, available as scene.paths.stream (fallback /scene/{id}/stream).
 * - Overlay-owned state (collapsed, opacity, panelPos, audioTagName) is persisted to
 *   the same config key "AudioSupport". csLib.getConfiguration/setConfiguration are
 *   async; a save lock coalesces concurrent writes.
 */
(function () {
  "use strict";

  const csLib = window.csLib;
  if (!csLib) {
    console.error("AudioSupport: CommunityScriptsUILibrary not loaded. Install it first.");
    return;
  }

  const CONFIG_KEY = "AudioSupport";
  const DEFAULT_OPACITY = 0.92;
  const DEFAULT_PANEL_POS = { top: 8, right: 8 };
  const DEFAULT_PANEL_WIDTH = 360;

  let state = {
    collapsed: false,
    opacity: DEFAULT_OPACITY,
    panelPos: { ...DEFAULT_PANEL_POS },
    audioTagName: "Audio",
    playbackRate: 1.0,
    loop: false,
    volume: 1.0,
  };

  let saving = false;
  let pendingSave = false;

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
    const mmss = mins + ":" + (secs < 10 ? "0" + secs : secs);
    return hours > 0 ? hours + ":" + (mins < 10 ? "0" + mins : mins) + ":" + (secs < 10 ? "0" + secs : secs) : mmss;
  }

  function parseSceneId() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  function isAudioFile(file) {
    return file && (file.video_codec === "" || file.width === 0 || file.height === 0);
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
      await csLib.setConfiguration(CONFIG_KEY, {
        collapsed: state.collapsed,
        opacity: state.opacity,
        panelPos: state.panelPos,
        audioTagName: state.audioTagName,
        playbackRate: state.playbackRate,
        loop: state.loop,
        volume: state.volume,
      });
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
      stored = await csLib.getConfiguration(CONFIG_KEY);
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
    header.addEventListener("pointerdown", startPanelDrag);

    const title = document.createElement("span");
    title.className = "audio-support-overlay__title";
    title.textContent = scene.title || "Audio";
    header.appendChild(title);

    const controls = document.createElement("span");
    controls.className = "audio-support-overlay__header-controls";

    const opacityWrap = document.createElement("span");
    opacityWrap.className = "audio-support-overlay__opacity-control";

    const opacityBtn = document.createElement("button");
    opacityBtn.type = "button";
    opacityBtn.dataset.action = "opacity-reset";
    opacityBtn.className = "audio-support-overlay__opacity-button";
    opacityBtn.title = "Panel opacity (Ctrl/\u2318+click to reset)";
    opacityBtn.setAttribute("aria-label", "Panel opacity");
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
    opacitySlider.setAttribute("aria-label", "Panel background opacity");
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

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "audio-support-overlay__play-button";
    playBtn.textContent = "\u25b6";
    playBtn.setAttribute("aria-label", "Play");
    transport.appendChild(playBtn);

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

    transport.appendChild(speedLoop);
    body.appendChild(transport);
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
    audio.addEventListener("ended", function () {
      updatePlayButton();
      seek.value = 0;
    });

    audio.addEventListener("loadedmetadata", function () {
      seek.max = isFinite(audio.duration) ? audio.duration : 1000;
      time.textContent = formatTime(audio.currentTime || 0) + " / " + formatTime(audio.duration || 0);
    });

    audio.addEventListener("timeupdate", function () {
      if (!audio.seeking) {
        seek.value = isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime : 0;
      }
      time.textContent = formatTime(audio.currentTime || 0) + " / " + formatTime(audio.duration || 0);
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

    return { overlay: overlay, audio: audio, playBtn: playBtn, seek: seek, time: time };
  }

  function renderCollapsed(panel) {
    clearChildren(panel);
    panel.classList.add("audio-support-overlay--collapsed");
    panel.style.width = "";
    panel.style.height = "";

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
      const p = currentPlayer || document.querySelector("#VideoJsPlayer");
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
    panel.style.width = DEFAULT_PANEL_WIDTH + "px";
    panel.style.height = "";
    panel.style.top = state.panelPos.top + "px";
    panel.style.right = state.panelPos.right + "px";

    const built = buildOverlay(scene, audioFile);
    panel.appendChild(built.overlay);
    audioEl = built.audio;
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
  }

  async function setupPanel(playerEl) {
    const sceneId = parseSceneId();
    if (!sceneId) return;

    if (playerEl.querySelector(".audio-support-overlay")) return;

    const scene = await fetchScene(sceneId);
    if (!scene) return;

    const audioFile = getAudioFile(scene);
    if (!audioFile) {
      // Normal video scene: make sure any hidden state is cleared.
      playerEl.classList.remove("audio-support-overlay__player-hidden");
      cachedScene = null;
      cachedAudioFile = null;
      return;
    }

    // This is an audio scene: hide the broken video.js UI.
    playerEl.classList.add("audio-support-overlay__player-hidden");

    await loadState();

    if (playerEl.querySelector(".audio-support-overlay")) return;

    const computed = window.getComputedStyle(playerEl);
    if (computed.position === "static") {
      playerEl.style.position = "relative";
    }

    currentPlayer = playerEl;
    // Cache so the collapsed→expand path can re-render without a fresh query.
    cachedScene = scene;
    cachedAudioFile = audioFile;
    overlayRoot = document.createElement("div");
    overlayRoot.className = "audio-support-overlay";
    overlayRoot.style.top = state.panelPos.top + "px";
    overlayRoot.style.right = state.panelPos.right + "px";
    playerEl.appendChild(overlayRoot);

    if (state.collapsed) {
      renderCollapsed(overlayRoot);
    } else {
      renderExpanded(overlayRoot, scene, audioFile);
    }
  }

  function tryInject() {
    const p = document.querySelector("#VideoJsPlayer");
    if (p) setupPanel(p);
  }

  // On SPA navigation, React may unmount the player element. Tear down any
  // overlay bound to the previous (now-detached) player before re-injecting,
  // so we don't leak a dangling overlay or double-mount on the new player.
  function reInject() {
    teardownOverlay();
    tryInject();
  }

  csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupPanel);

  if (window.PluginApi && window.PluginApi.Event && typeof window.PluginApi.Event.addEventListener === "function") {
    window.PluginApi.Event.addEventListener("stash:location", function () {
      reInject();
    });
  }

  window.addEventListener("pagehide", function () {
    // Flush any pending volume save before leaving the page.
    if (volumeSaveTimeout) {
      clearTimeout(volumeSaveTimeout);
      volumeSaveTimeout = null;
      state.volume = audioEl ? clamp(audioEl.volume, 0, 1) : state.volume;
    }
    saveNow();
  });
})();
