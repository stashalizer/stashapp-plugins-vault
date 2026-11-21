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
 * - The cover image is rotated with the video, because the cover is what the
 *   scene wall and the card grid show; leaving it sideways defeats the point.
 *   `sceneUpdate(cover_image:)` takes a base64 data URL, so the browser can
 *   render the current cover into a canvas, rotate it and write it back — no
 *   backend hook, no ImageMagick. The applied angle is tracked in
 *   custom_fields["SceneRotationCover"] so only the delta is re-encoded on each
 *   change; the cover is the only thing this plugin writes that is lossy, and
 *   the media file itself is never touched.
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
  // Tracks the angle already baked into the cover image, so the next change
  // only has to rotate by the delta instead of re-rotating from scratch.
  var COVER_FIELD_KEY = "SceneRotationCover";
  var PLAYER_ID = "VideoJsPlayer";
  // Safety net for SPA transitions that fire neither popstate nor
  // `stash:location` (the player element can be swapped without a route
  // change). One pass is a getElementById plus two regexes — cheap.
  var TICK_MS = 1000;
  var COVER_JPEG_QUALITY = 0.92;
  // Rotation is decided by clicking, and getting to 180 means two clicks. The
  // picture follows every click, but the write waits for the clicks to stop, so
  // 0 -> 180 costs one cover re-encode instead of two (and 0 -> 180 -> 0 costs
  // none at all).
  var SAVE_DEBOUNCE_MS = 500;

  var state = { sceneId: null, deg: 0 };
  // sceneId -> { rotation, cover, screenshot }
  //   rotation    video angle, from custom_fields["SceneRotation"]
  //   cover       angle already baked into the cover image; null means this
  //               plugin has never touched it (which is not the same as 0)
  //   screenshot  paths.screenshot, the source for rebuilding the cover
  var cache = Object.create(null);
  var inflight = Object.create(null); // sceneId -> Promise<record>
  // { sceneId, target, timer, waiters } — one pending write, latest angle wins
  var pendingSave = null;
  var bar = null;
  var boundVideo = null;
  var syncQueued = false;

  // ── Data layer ──────────────────────────────────────────────────────

  function graphql(query, variables, options) {
    return fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
      // Only used by the unload path for the tiny rotation mutation; a cover
      // payload would blow past the 64 KB keepalive budget.
      keepalive: !!(options && options.keepalive),
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

  function readScene(sceneId) {
    if (sceneId in cache) return Promise.resolve(cache[sceneId]);
    if (inflight[sceneId]) return inflight[sceneId];
    var request = graphql(
      "query ($id: ID!) { findScene(id: $id) { id custom_fields paths { screenshot } } }",
      { id: String(sceneId) }
    )
      .then(function (data) {
        var scene = data && data.findScene;
        var fields = (scene && scene.custom_fields) || {};
        var record = {
          rotation: normalize(fields[FIELD_KEY]),
          // null rather than 0: "never rotated" and "rotated back to 0" need
          // to be distinguishable, otherwise a scene that already carries a
          // rotation from an older plugin version would have its cover
          // rotated twice.
          cover:
            fields[COVER_FIELD_KEY] === undefined || fields[COVER_FIELD_KEY] === null
              ? null
              : normalize(fields[COVER_FIELD_KEY]),
          screenshot: (scene && scene.paths && scene.paths.screenshot) || "",
        };
        cache[sceneId] = record;
        return record;
      })
      .catch(function (err) {
        // A scene without custom_fields support (older Stash) must not break
        // playback; degrade to "no rotation stored".
        console.warn("SceneRotation: could not read custom_fields", err);
        var fallback = { rotation: 0, cover: null, screenshot: "" };
        cache[sceneId] = fallback;
        return fallback;
      })
      .then(function (record) {
        delete inflight[sceneId];
        return record;
      });
    inflight[sceneId] = request;
    return request;
  }

  function writeRotation(sceneId, deg, keepalive) {
    var record = cache[sceneId];
    if (record) record.rotation = deg;
    var input = deg
      ? { id: String(sceneId), custom_fields: { partial: {} } }
      : { id: String(sceneId), custom_fields: { remove: [FIELD_KEY] } };
    if (deg) input.custom_fields.partial[FIELD_KEY] = deg;
    return graphql(
      "mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
      { input: input },
      { keepalive: keepalive }
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

  // ── Cover rotation ──────────────────────────────────────────────────
  //
  // Rotating only the playing video leaves every thumbnail sideways: the cover
  // is what the scene wall, the card grid and the detail header show, so it has
  // to match the playback direction.
  //
  // `sceneUpdate(cover_image:)` accepts a base64 data URL (the same path the UI
  // uses when you paste a cover), so this needs no backend hook and no
  // ImageMagick — the browser renders the current cover into a canvas and
  // writes the rotated result back as the scene's cover blob.
  //
  // Two consequences are deliberate:
  //  - The write is a re-encode, so each angle change costs one generation of
  //    JPEG quality. That is why the already-applied angle is tracked in
  //    custom_fields["SceneRotationCover"] and only the delta is rotated; a
  //    change that does not move the angle writes nothing.
  //  - A cover that cannot be rebuilt (missing screenshot, tainted canvas)
  //    leaves the marker untouched so a later attempt retries, and never
  //    blocks saving the rotation itself.
  //
  // The canvas here is created detached and never appended anywhere in the
  // document: a <canvas> inside #VideoJsPlayer hijacks Stash's Filters panel
  // (see the MosaicFilter note in AGENTS.md).

  // Fetched as a blob rather than assigned straight to an <img>: after the
  // cover is replaced, a plain re-assignment can be served from the HTTP cache
  // and rotate the previous image, and a blob URL keeps the canvas untainted.
  function loadImage(url) {
    return fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve) {
          var objectUrl = URL.createObjectURL(blob);
          var image = new Image();
          image.onload = function () {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
          };
          image.onerror = function () {
            URL.revokeObjectURL(objectUrl);
            resolve(null);
          };
          image.src = objectUrl;
        });
      })
      .catch(function (err) {
        console.warn("SceneRotation: cover image could not be loaded", err);
        return null;
      });
  }

  function rotateIntoCanvas(image, deg) {
    var width = image.naturalWidth;
    var height = image.naturalHeight;
    var swap = deg % 180 !== 0;
    var canvas = document.createElement("canvas");
    canvas.width = swap ? height : width;
    canvas.height = swap ? width : height;
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // Rotate about the centre and draw the image back through it: this maps
    // the source top-left to the output top-right for +90, i.e. the same
    // clockwise direction CSS `rotate()` uses on the video.
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    return canvas;
  }

  function rotateCoverImage(url, deg) {
    if (!url) return Promise.resolve(null);
    return loadImage(url).then(function (image) {
      if (!image || !image.naturalWidth) return null;
      var canvas = rotateIntoCanvas(image, deg);
      if (!canvas) return null;
      try {
        return canvas.toDataURL("image/jpeg", COVER_JPEG_QUALITY);
      } catch (err) {
        // Tainted canvas: the cover is served from a different origin.
        console.warn("SceneRotation: cover could not be exported", err);
        return null;
      }
    });
  }

  // Rotate only by the difference to what is already baked in.
  function applyCoverTarget(id, target) {
    return readScene(id)
      .then(function (record) {
        var applied = record.cover === null ? 0 : record.cover;
        if (applied === target) return false;
        var delta = ((target - applied) % 360 + 360) % 360;
        return rotateCoverImage(record.screenshot, delta).then(function (dataUrl) {
          if (!dataUrl) {
            console.warn(
              "SceneRotation: no cover image to rotate, cover left as-is"
            );
            return false;
          }
          var customFields = target
            ? { partial: {} }
            : { remove: [COVER_FIELD_KEY] };
          if (target) customFields.partial[COVER_FIELD_KEY] = target;
          return graphql(
            "mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
            {
              input: {
                id: String(id),
                cover_image: dataUrl,
                custom_fields: customFields,
              },
            }
          )
            .then(function () {
              record.cover = target;
              refreshCoverImages(id, record.screenshot);
              // Awaited on purpose: the queue must not start the next rotation
              // from a screenshot URL that still points at the old cover.
              return refreshScreenshotUrl(id).then(function () {
                return true;
              });
            })
            .catch(function (err) {
              console.error("SceneRotation: could not save the rotated cover", err);
              return false;
            });
        });
      })
      .catch(function (err) {
        console.warn("SceneRotation: cover rotation skipped", err);
        return false;
      });
  }

  // Cover writes are serialised per scene. Two fast clicks would otherwise both
  // read the same "already applied" angle, both rotate the same source frame
  // and both write a cover — the second one undoing the first.
  var coverQueue = Object.create(null);

  function syncCover(sceneId, target) {
    var id = sceneId || state.sceneId || currentSceneId();
    if (!id) return Promise.resolve(false);
    var previous = coverQueue[id] || Promise.resolve();
    var next = previous.then(function () {
      return applyCoverTarget(id, target);
    });
    coverQueue[id] = next.catch(function () {});
    return next;
  }

  // The scene detail header renders the cover from the same screenshot URL, so
  // a replaced cover keeps showing the old orientation until the page reloads.
  // Bumping the cache-buster on the matching <img> makes the change immediate;
  // this only touches the attribute, never React state. Matching is best-effort
  // (Stash may key the screenshot URL by checksum), so a miss is a no-op.
  function refreshCoverImages(sceneId, url) {
    var base = url ? url.split("#")[0].split("?")[0] : "";
    var fallback = "/scene/" + sceneId + "/screenshot";
    Array.prototype.forEach.call(document.images, function (image) {
      var src = (image.currentSrc || image.src).split("#")[0].split("?")[0];
      if (src !== base && src.indexOf(fallback) === -1) return;
      image.src = src + "?t=" + Date.now();
    });
  }


  // Stash may key the screenshot URL by the cover checksum, in which case the
  // URL we just used is already stale and the next rotation would start from
  // the previous image. Re-read it once per write.
  function refreshScreenshotUrl(id) {
    return graphql(
      "query ($id: ID!) { findScene(id: $id) { id paths { screenshot } } }",
      { id: String(id) }
    )
      .then(function (data) {
        var record = cache[id];
        var url =
          data && data.findScene && data.findScene.paths
            ? data.findScene.paths.screenshot
            : "";
        if (record && url) record.screenshot = url;
      })
      .catch(function () {
        // Non-fatal: the next cover sync just reports "no cover image".
      });
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
    // The player is gone, so a pending click would never be committed by the
    // debounce timer running against a live scene — commit it now.
    flushSave();
    if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
    bar = null;
    boundVideo = null;
    state.sceneId = null;
    state.deg = 0;
  }

  // ── Public setter (also used by the console / other plugins) ────────

  // Debounced write. The angle on screen is always the latest one; what is
  // coalesced is the persistence: reaching 180 by two clicks writes once, and
  // 0 -> 180 -> 0 writes nothing, so the cover is re-encoded at most once per
  // settled decision instead of once per click.
  function scheduleSave(sceneId, target) {
    // The queue belongs to a scene: an angle left pending on the previous scene
    // has to be committed before this one starts, or it is lost.
    if (pendingSave && pendingSave.sceneId !== sceneId) flushSave();
    if (!pendingSave) {
      pendingSave = { sceneId: sceneId, target: target, timer: 0, waiters: [] };
    }
    pendingSave.target = target;
    if (pendingSave.timer) window.clearTimeout(pendingSave.timer);
    var settled = new Promise(function (resolve) {
      pendingSave.waiters.push(resolve);
    });
    pendingSave.timer = window.setTimeout(function () {
      flushSave();
    }, SAVE_DEBOUNCE_MS);
    return settled;
  }

  // Commit whatever is pending right now. Called by the debounce timer, and
  // eagerly whenever the pending write is about to be lost: scene change,
  // player teardown, page unload.
  function flushSave(options) {
    var pending = pendingSave;
    if (!pending) return Promise.resolve(false);
    pendingSave = null;
    if (pending.timer) window.clearTimeout(pending.timer);

    // Clicking back to the angle the scene already has (0 -> 90 -> 0) leaves
    // nothing to write: skip both requests instead of sending a no-op mutation.
    var record = cache[pending.sceneId];
    var unchanged = !!record && record.rotation === pending.target;

    var settled = unchanged
      ? Promise.resolve(true)
      : writeRotation(pending.sceneId, pending.target, options && options.keepalive);
    if (!unchanged) {
      // Fire and forget: a cover that cannot be rebuilt (no screenshot, tainted
      // canvas) must never block or fail the rotation itself.
      syncCover(pending.sceneId, pending.target);
    }
    settled.then(function (ok) {
      pending.waiters.forEach(function (resolve) {
        resolve(ok);
      });
    });
    return settled;
  }

  function set(deg) {
    var sceneId = state.sceneId || currentSceneId();
    if (!sceneId) return Promise.resolve(false);
    state.sceneId = sceneId;
    state.deg = normalize(deg);
    // Visual feedback is immediate; only the write is deferred.
    apply();
    renderBar();
    return scheduleSave(sceneId, state.deg);
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
      // Commit an angle still inside the debounce window for the scene we are
      // leaving before switching scenes, otherwise those clicks are dropped.
      flushSave();
      // New scene: drop the old angle immediately rather than showing the
      // previous scene's rotation until the query resolves.
      state.sceneId = sceneId;
      state.deg = 0;
      apply();
      renderBar();
      readScene(sceneId).then(function (record) {
        if (state.sceneId !== sceneId) return; // navigated away meanwhile
        state.deg = record.rotation;
        apply();
        renderBar();
        // A mismatch means the cover predates cover sync, or was regenerated
        // after the rotation was set. Reported, never written here: opening a
        // scene must not mutate it.
        var appliedCover = record.cover === null ? 0 : record.cover;
        if (record.rotation !== appliedCover) {
          console.info(
            "SceneRotation: cover is not in sync with the rotation — run " +
              "SceneRotation.syncCover() to fix it"
          );
        }
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

  // Closing or reloading inside the debounce window must not drop the click.
  // The rotation mutation is a few hundred bytes, so it can go out with
  // keepalive; the cover write cannot (its payload exceeds the keepalive
  // budget) and is repaired by syncCover() if it never lands.
  window.addEventListener("pagehide", function () {
    flushSave({ keepalive: true });
  });

  window.SceneRotation = {
    set: set,
    get: function () { return state.deg; },
    cycle: function () { return set((state.deg + 90) % 360); },
    // Commit a pending (debounced) write immediately.
    flush: function () { return flushSave(); },
    sceneId: currentSceneId,
    sync: sync,
    // Repair a cover that predates cover sync, or that was regenerated after
    // the rotation was set. Rotates by the difference only.
    syncCover: function () {
      return syncCover(state.sceneId || currentSceneId(), state.deg);
    },
    // Angle currently baked into the cover: null when this plugin has not
    // touched it, otherwise 0 / 90 / 180 / 270.
    cover: function () {
      var record = state.sceneId ? cache[state.sceneId] : null;
      return record ? record.cover : null;
    },
  };

  sync();
})();
