/**
 * SceneRotation — per-scene playback rotation for Stash.
 *
 * Why this exists: some videos are encoded sideways. Stash's scene page has a
 * Filters tab that can rotate the picture, but its transform state lives in a
 * React useState and is thrown away on every navigation and reload, so the
 * rotation has to be re-applied by hand each time. Doing it with ffmpeg writes
 * a new file into the library instead (or rewrites the original). This plugin
 * stores the angle on the scene itself and re-applies it at playback.
 *
 * Design notes, all of them load-bearing:
 *
 * - The angle lives in the scene's `custom_fields` under `SceneRotation`
 *   (an integer, degrees clockwise: 0 / 90 / 180 / 270). `custom_fields` is
 *   per-scene and server-side, so the rotation follows the scene to every
 *   browser and device. It is written with `custom_fields.partial`, which
 *   merges, so other plugins' keys on the same scene are left alone.
 *   Only scalar values are allowed in custom_fields (see
 *   pkg/sqlite/custom_fields.go); an int is exactly what we need.
 *
 * - We style the `<video>` element itself, never `#VideoJsPlayer`, and we write
 *   ONLY `transform` / `transform-origin`. Stash's SceneVideoFilterPanel
 *   rewrites the whole inline `style` attribute of the element it picks, so
 *   sharing an element with it is fine as long as we hold only transform and
 *   it holds only filter/transform — and we re-assert our transform on the
 *   next tick if the panel clobbered it.
 *
 * - We must never insert a `<canvas>` anywhere inside `#VideoJsPlayer`. That
 *   panel resolves its target with `getElementsByTagName("canvas")` before
 *   falling back to `<video>`, so a canvas in the light DOM under the player
 *   silently swallows every panel filter. The controls here are divs/buttons
 *   only.
 *
 * - Rotation is "contain", not "cover": after rotating, the footprint becomes
 *   h x w, and the scale factor is min(boxW / contentH, boxH / contentW). That
 *   fits the whole (now rotated) picture inside the player instead of cropping
 *   it, which is what you want when the content itself is what was sideways.
 *
 * - No csLib / PluginApi dependency: plain DOM plus `fetch("/graphql")`, the
 *   same helper shape used by the other vanilla overlays in this repo. The
 *   plugin therefore works on its own, with no `ui.requires`.
 */
(function () {
  "use strict";

  var FIELD_KEY = "SceneRotation";
  var PLAYER_ID = "VideoJsPlayer";
  // Safety net for SPA transitions that fire neither popstate nor
  // `stash:location` (the player element can be swapped without a route
  // change). One pass is a getElementById plus two regexes — cheap.
  var TICK_MS = 1000;

  var state = { sceneId: null, deg: 0 };
  var cache = Object.create(null); // sceneId -> deg as stored server-side
  var inflight = Object.create(null); // sceneId -> Promise<deg>
  var bar = null;
  var boundVideo = null;
  var syncQueued = false;

  // ── Data layer ──────────────────────────────────────────────────────

  function graphql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("GraphQL HTTP " + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (payload.errors && payload.errors.length) {
          throw new Error(payload.errors.map(function (e) { return e.message; }).join("; "));
        }
        return payload.data;
      });
  }

  // Snap to the four supported angles and normalise into [0, 360).
  function normalize(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    return ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  }

  function readRotation(sceneId) {
    if (sceneId in cache) return Promise.resolve(cache[sceneId]);
    if (inflight[sceneId]) return inflight[sceneId];
    var request = graphql(
      "query ($id: ID!) { findScene(id: $id) { id custom_fields } }",
      { id: String(sceneId) }
    )
      .then(function (data) {
        var fields = data && data.findScene && data.findScene.custom_fields;
        var deg = fields ? normalize(fields[FIELD_KEY]) : 0;
        cache[sceneId] = deg;
        return deg;
      })
      .catch(function (err) {
        // A scene without custom_fields support (older Stash) must not break
        // playback; degrade to "no rotation stored".
        console.warn("SceneRotation: could not read custom_fields", err);
        cache[sceneId] = 0;
        return 0;
      })
      .then(function (deg) {
        delete inflight[sceneId];
        return deg;
      });
    inflight[sceneId] = request;
    return request;
  }

  function writeRotation(sceneId, deg) {
    cache[sceneId] = deg;
    var input = deg
      ? { id: String(sceneId), custom_fields: { partial: {} } }
      : { id: String(sceneId), custom_fields: { remove: [FIELD_KEY] } };
    if (deg) input.custom_fields.partial[FIELD_KEY] = deg;
    return graphql(
      "mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
      { input: input }
    )
      .then(function () {
        return true;
      })
      .catch(function (err) {
        console.error("SceneRotation: could not save rotation", err);
        return false;
      });
  }

  // ── DOM lookups ─────────────────────────────────────────────────────

  function getPlayer() {
    return document.getElementById(PLAYER_ID);
  }

  // Deliberately the <video>, never a canvas: see the header note.
  function getVideo() {
    var player = getPlayer();
    if (!player) return null;
    return player.querySelector("video.vjs-tech") || player.querySelector("video");
  }

  function ensurePositioned(player) {
    if (window.getComputedStyle(player).position === "static") {
      player.style.position = "relative";
    }
  }

  function routeSceneId() {
    var match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  // The route is updated slightly after the stream source switches during queue
  // playback, so fall back to the stream URL (/scene/<id>/stream).
  function currentSceneId() {
    var id = routeSceneId();
    if (id) return id;
    var video = getVideo();
    var src = (video && video.currentSrc) || "";
    var match = src.match(/\/scene\/(\d+)\//);
    return match ? match[1] : null;
  }

  // ── Geometry ────────────────────────────────────────────────────────

  // Displayed size of the picture inside the (object-fit: contain) video box.
  function containSize(boxW, boxH, videoW, videoH) {
    var aspect = videoW / videoH;
    var width = boxW;
    var height = boxW / aspect;
    if (height > boxH) {
      height = boxH;
      width = boxH * aspect;
    }
    return { width: width, height: height };
  }

  function transformFor(deg, video, player) {
    var boxW = player.clientWidth;
    var boxH = player.clientHeight;
    if (!boxW || !boxH) return "";
    if (deg % 180 === 0) return "rotate(" + deg + "deg)";
    var videoW = video.videoWidth || boxW;
    var videoH = video.videoHeight || boxH;
    var size = containSize(boxW, boxH, videoW, videoH);
    // A 90/270 turn swaps the footprint: contentW x contentH becomes
    // contentH x contentW, so the fitting scale is min(boxW/h, boxH/w).
    var scale = Math.min(boxW / size.height, boxH / size.width);
    if (!isFinite(scale) || scale <= 0) return "";
    return "rotate(" + deg + "deg) scale(" + scale + ")";
  }

  // ── Applying ────────────────────────────────────────────────────────

  function apply() {
    var video = getVideo();
    var player = getPlayer();
    if (!video || !player) return;

    if (!state.deg) {
      // Only clear a transform this plugin is responsible for.
      if (video.dataset.sceneRotation) {
        video.style.removeProperty("transform");
        delete video.dataset.sceneRotation;
      }
      return;
    }

    var transform = transformFor(state.deg, video, player);
    if (!transform) return;
    if (video.style.transform !== transform) {
      // Re-asserted every sync pass: the Filters panel rewrites the whole
      // style attribute, so this also repairs a clobbered rotation.
      video.style.transformOrigin = "center center";
      video.style.transform = transform;
    }
    video.dataset.sceneRotation = String(state.deg);
  }

  // ── Controls ────────────────────────────────────────────────────────

  function renderBar() {
    if (!bar) return;
    var value = bar.querySelector(".scene-rotation-bar__value");
    if (value) value.textContent = state.deg + "\u00b0";
    var reset = bar.querySelector('[data-action="reset"]');
    if (reset) reset.disabled = !state.deg;
  }

  function onBarClick(event) {
    var button = event.target.closest("button[data-action]");
    if (!button) return;
    // Keep the click away from videojs: the player toggles play/pause on click.
    event.preventDefault();
    event.stopPropagation();
    var action = button.getAttribute("data-action");
    var next =
      action === "reset"
        ? 0
        : action === "cw"
          ? (state.deg + 90) % 360
          : (state.deg + 270) % 360;
    set(next);
  }

  function mountBar(player) {
    bar = document.createElement("div");
    bar.className = "scene-rotation-bar";
    bar.setAttribute("data-scene-rotation-ui", "true");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Playback rotation");
    bar.innerHTML =
      '<button type="button" class="scene-rotation-bar__button" data-action="ccw"' +
      ' title="Rotate 90° counter-clockwise" aria-label="Rotate 90 degrees counter-clockwise">⟲</button>' +
      '<span class="scene-rotation-bar__value" aria-live="polite">0°</span>' +
      '<button type="button" class="scene-rotation-bar__button" data-action="cw"' +
      ' title="Rotate 90° clockwise" aria-label="Rotate 90 degrees clockwise">⟳</button>' +
      '<button type="button" class="scene-rotation-bar__button scene-rotation-bar__button--reset"' +
      ' data-action="reset" title="Clear rotation for this scene" aria-label="Clear rotation">✕</button>';
    bar.addEventListener("click", onBarClick);
    player.appendChild(bar);
    renderBar();
  }

  function unmount() {
    if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
    bar = null;
    boundVideo = null;
    state.sceneId = null;
    state.deg = 0;
  }

  // ── Public setter (also used by the console / other plugins) ────────

  function set(deg) {
    var sceneId = state.sceneId || currentSceneId();
    if (!sceneId) return Promise.resolve(false);
    state.sceneId = sceneId;
    state.deg = normalize(deg);
    apply();
    renderBar();
    return writeRotation(sceneId, state.deg);
  }

  // ── Reconciliation ──────────────────────────────────────────────────

  function bindVideo() {
    var video = getVideo();
    if (!video || video === boundVideo) return;
    boundVideo = video;
    // The transform needs the intrinsic size, which is only known once the
    // metadata is in; the safety-net tick would catch it, but this is instant.
    video.addEventListener("loadedmetadata", apply);
  }

  function sync() {
    var player = getPlayer();
    if (!player) {
      unmount();
      return;
    }
    ensurePositioned(player);
    if (!bar) mountBar(player);
    bindVideo();

    var sceneId = currentSceneId();
    if (!sceneId) return;

    if (sceneId !== state.sceneId) {
      // New scene: drop the old angle immediately rather than showing the
      // previous scene's rotation until the query resolves.
      state.sceneId = sceneId;
      state.deg = 0;
      apply();
      renderBar();
      readRotation(sceneId).then(function (deg) {
        if (state.sceneId !== sceneId) return; // navigated away meanwhile
        state.deg = deg;
        apply();
        renderBar();
      });
      return;
    }

    apply();
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    window.requestAnimationFrame(function () {
      syncQueued = false;
      sync();
    });
  }

  // ── Wiring ──────────────────────────────────────────────────────────

  // The player element is created/destroyed by React on every navigation, so
  // there is no stable node to observe: watch insertion under <body> and
  // coalesce to one pass per frame.
  var observer = new MutationObserver(scheduleSync);
  observer.observe(document.body, { childList: true, subtree: true });

  // SPA navigation: Stash uses the history API for scene pages, plus its own
  // `stash:location` event (immediately after pushState, before React renders).
  window.addEventListener("popstate", scheduleSync);
  window.addEventListener("stash:location", scheduleSync);
  document.addEventListener("fullscreenchange", scheduleSync);
  window.addEventListener("resize", scheduleSync);
  window.setInterval(sync, TICK_MS);

  window.SceneRotation = {
    set: set,
    get: function () { return state.deg; },
    cycle: function () { return set((state.deg + 90) % 360); },
    sceneId: currentSceneId,
    sync: sync,
  };

  sync();
})();
