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
 * - Nothing is written to disk. Not the media file (no re-encode, no copy), and
 *   not Stash's generated artifacts either: the rotation is a CSS transform on
 *   whatever element is showing the scene, so the preview clip on the scene
 *   card and the cover on the card/scene wall are rotated the same way the
 *   player is. The only write this plugin ever performs is the integer in
 *   custom_fields.
 *
 *   The consequence is that Stash's own derivations (preview file, sprite
 *   sheet, generated cover) stay sideways on disk — they are simply never shown
 *   unrotated by this UI. Anything that reads the files directly (another app,
 *   a different client) still sees them as encoded.
 *
 * - The cover angle has to be split into "already baked" and "still to apply".
 *   custom_fields["SceneRotationCover"] records an angle that an older version
 *   of this plugin wrote into the cover image itself, so the CSS angle is
 *   rotation - cover. Scenes that were never baked have cover = null and get the
 *   full angle; scenes baked by 0.2/0.3 get 0 and are not rotated twice.
 *
 * - We style the media element itself, never `#VideoJsPlayer`, and we write the
 *   INDIVIDUAL transform properties (`rotate`, `scale`) plus `transform-origin`
 *   — not `transform`. Stash's SceneVideoFilterPanel owns `transform` on the
 *   very same element and replaces the entire inline style attribute on every
 *   slider move, so sharing the property would mean each side deleting the
 *   other's work: its Transforms sliders would look dead (our re-assert wins
 *   within a second) and our rotation would vanish while dragging. Individual
 *   properties compose instead — the panel's rotation is added to ours, its
 *   scale multiplied — and the style-attribute watcher puts ours back in the
 *   same frame the panel wiped them, so neither effect flickers.
 *
 * - We must never insert a `<canvas>` anywhere inside `#VideoJsPlayer`. That
 *   panel resolves its target with `getElementsByTagName("canvas")` before
 *   falling back to `<video>`, so a canvas in the light DOM under the player
 *   silently swallows every panel filter. The controls here are divs/buttons
 *   only.
 *
 * - The control cluster is draggable so it can step out of the way of other
 *   plugins' overlays. Its position is stored as a fraction of the player box
 *   in localStorage (a few dozen bytes in the browser profile, never on the
 *   Stash side), clamped so it cannot be dragged out of reach, and applied on
 *   every resize and fullscreen switch. Double-clicking the grip puts it back
 *   in the corner.
 *
 * - The scale factor mirrors the element's own `object-fit`. A 90/270 turn
 *   swaps the footprint, so the picture no longer fills the box: with
 *   `contain` (what the player and portrait cards use) it is shrunk by
 *   min(boxW / h, boxH / w) so the whole rotated frame fits; with `cover`
 *   (what landscape cards use) it is grown by max(...) so the box stays filled
 *   the way the card expects. Cropping or letterboxing therefore stays exactly
 *   as intentional as it was before the rotation.
 *
 *   `object-position` matters as well: Stash aligns card artwork to `top`, so
 *   the picture is not centred in its box. That is handled by putting
 *   `transform-origin` on the picture's centre rather than the box's, which
 *   keeps the rotation in place and — unlike a `translate()` — is expressible
 *   alongside the individual properties.
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
  // Scene-bound media in the DOM: the player stream, the hover preview clip on
  // a scene card, the animated-webp variant of that preview, and the cover
  // (card artwork, scene wall, detail header). Sprite sheets and VTT files are
  // deliberately absent — see the note on non-rotatable artifacts.
  var SCENE_MEDIA_RE = /\/scene\/(\d+)\/(screenshot|preview|stream|webp)(?:[?#/]|$)/i;
  // Any element showing scene media. Narrow enough to be cheap on image-heavy
  // pages (a gallery grid would otherwise match every thumbnail).
  var MEDIA_SELECTOR = 'video[src*="/scene/"], img[src*="/scene/"]';
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
  // Control cluster: where it was last dragged to, and the inset of the default
  // (top-right) position.
  var BAR_POS_KEY = "SceneRotation.barPos";
  var BAR_INSET = 8;

  // Individual transform properties (`rotate`, `scale`) compose with a
  // `transform` written by somebody else, which is the whole reason this plugin
  // uses them: Stash's Filters panel owns `transform` on the player video and
  // replaces the entire inline style attribute on every slider move. Anything we
  // put in `transform` would be clobbered by it and, when re-asserted, clobber it
  // right back — which is what made its Transforms sliders look broken.
  // Chrome 104+, Firefox 72+, Safari 14.1+; the fallback keeps old browsers
  // working, they just lose the composition.
  var CAN_ROTATE_PROP = (function () {
    try {
      return !!(window.CSS && window.CSS.supports && window.CSS.supports("rotate", "90deg"));
    } catch (err) {
      return false;
    }
  })();

  var state = { sceneId: null, deg: 0 };
  // sceneId -> { rotation, cover, screenshot }
  //   rotation    video angle, from custom_fields["SceneRotation"]
  //   cover       angle already baked into the cover image; null means this
  //               plugin has never touched it (which is not the same as 0)
  //   screenshot  paths.screenshot, the source for rebuilding the cover
  var cache = Object.create(null);
  var inflight = Object.create(null); // sceneId -> Promise<record>
  // The card grid needs the angle of every scene it shows, and asking per card
  // would be dozens of requests. One query loads every scene that carries the
  // field; after that, "not in cache" means "not rotated" and needs no lookup.
  var indexLoaded = false;
  var indexRequest = null;
  var NOT_ROTATED = { rotation: 0, cover: null, screenshot: "" };
  // { sceneId, target, timer, waiters } — one pending write, latest angle wins
  var pendingSave = null;
  var bar = null;
  // Position of the control cluster: { x, y } as fractions of the player box,
  // loaded from localStorage so it survives Stash rebuilding the player on
  // every navigation. null = "never moved", which means top-right.
  var barPos = loadBarPos();
  var drag = null; // { id, grabX, grabY, moved, captured } while the grip is held
  // Timestamp until which clicks are swallowed: the click that ends a drag
  // would otherwise land on the player and toggle playback.
  var swallowClickUntil = 0;
  // Last box the cluster was placed for, so an idle sync pass does no layout
  // reads and no style writes at all.
  var placedFor = { width: 0, height: 0, barW: 0, barH: 0 };
  var boundVideo = null;
  var styleWatcher = null; // watches the player video's inline style
  var boundMedia = new WeakSet(); // media elements already listening for load
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

  function recordFrom(scene) {
    var fields = (scene && scene.custom_fields) || {};
    return {
      rotation: normalize(fields[FIELD_KEY]),
      // null rather than 0: "never rotated" and "rotated back to 0" need to be
      // distinguishable, otherwise a scene whose cover was already baked by an
      // older plugin version would have that rotation applied a second time.
      cover:
        fields[COVER_FIELD_KEY] === undefined || fields[COVER_FIELD_KEY] === null
          ? null
          : normalize(fields[COVER_FIELD_KEY]),
      screenshot: (scene && scene.paths && scene.paths.screenshot) || "",
    };
  }

  // Get a mutable record for a scene, creating it if the index said "not
  // rotated" (or nothing is known about it yet).
  function remember(sceneId) {
    var record = cache[sceneId];
    if (!record) {
      record = { rotation: 0, cover: null, screenshot: "" };
      cache[sceneId] = record;
    }
    return record;
  }

  // Synchronous lookup for the render pass: null means "not known yet, ask".
  function recordFor(sceneId) {
    var record = cache[sceneId];
    if (record) return record;
    return indexLoaded ? NOT_ROTATED : null;
  }

  function readScene(sceneId) {
    if (sceneId in cache) return Promise.resolve(cache[sceneId]);
    if (inflight[sceneId]) return inflight[sceneId];
    // The index is authoritative: a scene missing from it carries no angle, so
    // navigating between scenes costs no request at all.
    if (indexLoaded) return Promise.resolve(NOT_ROTATED);
    var request = graphql(
      "query ($id: ID!) { findScene(id: $id) { id custom_fields paths { screenshot } } }",
      { id: String(sceneId) }
    )
      .then(function (data) {
        var record = recordFrom(data && data.findScene);
        cache[sceneId] = record;
        return record;
      })
      .catch(function (err) {
        // A scene without custom_fields support (older Stash) must not break
        // playback; degrade to "no rotation stored".
        console.warn("SceneRotation: could not read custom_fields", err);
        cache[sceneId] = NOT_ROTATED;
        return NOT_ROTATED;
      })
      .then(function (record) {
        delete inflight[sceneId];
        return record;
      });
    inflight[sceneId] = request;
    return request;
  }

  // One query for every rotated scene in the library. A library where nobody
  // uses the plugin costs one request returning an empty list; a library where
  // a few hundred scenes are rotated costs one request returning a few hundred
  // {id, custom_fields} rows. Either way the card grid then renders without a
  // lookup per card.
  function preload() {
    if (indexLoaded) return Promise.resolve(true);
    if (indexRequest) return indexRequest;
    indexRequest = graphql(
      "query ($filter: SceneFilterType) { findScenes(scene_filter: $filter, filter: { per_page: -1 }) { scenes { id custom_fields paths { screenshot } } } }",
      { filter: { custom_fields: [{ field: FIELD_KEY, modifier: "NOT_NULL" }] } }
    )
      .then(function (data) {
        var scenes = (data && data.findScenes && data.findScenes.scenes) || [];
        scenes.forEach(function (scene) {
          if (!scene || scene.id === undefined) return;
          cache[String(scene.id)] = recordFrom(scene);
        });
        indexLoaded = true;
        return true;
      })
      .catch(function (err) {
        // Older Stash, or a filter shape this version does not accept: fall
        // back to a lookup per scene instead of failing the whole feature.
        console.warn(
          "SceneRotation: bulk index unavailable, falling back to per-scene lookups",
          err
        );
        return false;
      })
      .then(function (ok) {
        indexRequest = null;
        return ok;
      });
    return indexRequest;
  }

  function writeRotation(sceneId, deg, keepalive) {
    remember(sceneId).rotation = deg;
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

  // Resolve a computed `object-position` (normalised by the browser to
  // percentages, e.g. "50% 0%") into a 0..1 pair of anchors.
  function parsePosition(value) {
    var parts = String(value || "50% 50%").trim().split(/\s+/);
    function anchor(token) {
      if (!token) return 0.5;
      if (token === "left" || token === "top") return 0;
      if (token === "right" || token === "bottom") return 1;
      if (token === "center") return 0.5;
      if (/%$/.test(token)) return parseFloat(token) / 100;
      return 0; // absolute offsets: treated as top/left
    }
    return { x: anchor(parts[0]), y: anchor(parts[1]) };
  }

  // Where the picture actually sits inside the element box, and how the box
  // behaves when the picture has to be stretched back over it.
  //   covers -> the picture is clipped to the box, so the visible area IS the
  //             box and only the box aspect matters
  //   fits   -> the picture is letterboxed and may be anchored off-centre
  function pictureBox(el, boxW, boxH, fixW, fixH) {
    var style = window.getComputedStyle(el);
    var fit = style.objectFit || "contain";
    // The UA never stretches a <video> even when the computed value says fill.
    if (el.tagName === "VIDEO" && fit === "fill") fit = "contain";
    if (fit === "cover" || fit === "fill") {
      return { width: boxW, height: boxH, offsetX: 0, offsetY: 0, covers: true };
    }
    var scale = fit === "none"
      ? 1
      : fit === "scale-down"
        ? Math.min(1, Math.min(boxW / fixW, boxH / fixH))
        : Math.min(boxW / fixW, boxH / fixH);
    var width = fixW * scale;
    var height = fixH * scale;
    var anchor = parsePosition(style.objectPosition);
    return {
      width: width,
      height: height,
      offsetX: (boxW - width) * anchor.x,
      offsetY: (boxH - height) * anchor.y,
      covers: false,
    };
  }

  // Angle, scale and pivot for one element. Returns null when the element has
  // no layout or no decoded picture yet.
  //
  // The pivot is the *picture's* centre, not the element's. Stash anchors card
  // artwork to `top`, so the picture is not centred in its box and rotating
  // about the box centre would leave it visibly offset. Expressing that as
  // `transform-origin` instead of a `translate()` also removes the translate
  // from the transform, which is what makes the individual `rotate`/`scale`
  // properties usable (they apply in a fixed order, with no translate slot
  // where a transform needs one).
  function rotationFor(el, deg) {
    var boxW = el.clientWidth;
    var boxH = el.clientHeight;
    if (!boxW || !boxH) return null;
    var fixW = el.naturalWidth || el.videoWidth || 0;
    var fixH = el.naturalHeight || el.videoHeight || 0;
    // Not decoded yet (image still loading, video without metadata): the scale
    // would be a guess. Leave whatever is there and pick it up next pass — the
    // intrinsic size is part of the cache key, so the next pass will not skip.
    if (!fixW || !fixH) return null;

    var box = pictureBox(el, boxW, boxH, fixW, fixH);
    var spec = {
      deg: deg,
      scale: 1,
      originX: Math.round(box.offsetX + box.width / 2),
      originY: Math.round(box.offsetY + box.height / 2),
    };
    // 180 turns the picture inside its own footprint: no re-fit needed, and
    // rotating about the picture centre flips it in place.
    if (deg % 180 === 0) return spec;

    // A 90/270 turn swaps the footprint: width x height becomes height x width.
    var footprintW = box.height;
    var footprintH = box.width;
    spec.scale = box.covers
      ? Math.max(boxW / footprintW, boxH / footprintH)
      : Math.min(boxW / footprintW, boxH / footprintH);
    if (!isFinite(spec.scale) || spec.scale <= 0) return null;
    spec.scale = Number(spec.scale.toFixed(4));
    return spec;
  }

  function clearRotation(el) {
    el.style.removeProperty("transform-origin");
    if (CAN_ROTATE_PROP) {
      el.style.removeProperty("rotate");
      el.style.removeProperty("scale");
    } else {
      el.style.removeProperty("transform");
    }
    delete el.dataset.sceneRotation;
    delete el.dataset.sceneRotationKey;
    delete el.dataset.sceneRotationStyle;
  }

  // Apply or clear the rotation on one element.
  //
  // With the individual properties available this writes `rotate` / `scale` /
  // `transform-origin` and never touches `transform`, so Stash's Filters panel
  // (which owns `transform` on the player video, and replaces the whole style
  // attribute on every slider move) composes with us instead of fighting us:
  // its rotation is added, its scale multiplied.
  //
  // The "did someone clobber us" test is the serialised style attribute we left
  // behind. A per-property comparison would depend on how the browser
  // normalises numbers; this only depends on "has anything changed since I last
  // looked", which is exactly the question being asked.
  function applyTo(el, deg) {
    if (!deg) {
      if (el.dataset.sceneRotation) clearRotation(el);
      return;
    }
    var key =
      deg +
      "|" + el.clientWidth + "x" + el.clientHeight +
      "|" + (el.naturalWidth || el.videoWidth || 0) +
      "x" + (el.naturalHeight || el.videoHeight || 0);
    if (
      el.dataset.sceneRotationKey === key &&
      el.getAttribute("style") === el.dataset.sceneRotationStyle
    ) {
      return;
    }
    var spec = rotationFor(el, deg);
    if (!spec) return;

    el.style.transformOrigin = spec.originX + "px " + spec.originY + "px";
    if (CAN_ROTATE_PROP) {
      el.style.rotate = spec.deg + "deg";
      el.style.scale = String(spec.scale);
    } else {
      el.style.transform =
        "rotate(" + spec.deg + "deg) scale(" + spec.scale + ")";
    }
    el.dataset.sceneRotation = String(deg);
    el.dataset.sceneRotationKey = key;
    el.dataset.sceneRotationStyle = el.getAttribute("style") || "";
  }

  // ── Optional: baking the cover into the scene ──────────────────────
  //
  // Not used by the plugin itself any more. Covers on the card grid, the scene
  // wall and the detail header are rotated by the same CSS transform as the
  // player (see `decorate`), which needs no write at all.
  //
  // This path is kept because it is the only way to make the cover correct for
  // something that reads Stash's files without this plugin. It writes: the
  // browser renders the current cover into a canvas and sends the rotated
  // result back through `sceneUpdate(cover_image:)`, which Stash stores as the
  // scene's cover blob. Every call costs one generation of JPEG quality, so it
  // is never automatic — `SceneRotation.bakeCover()` is the explicit opt-in.
  //
  // The angle already baked in is tracked in custom_fields["SceneRotationCover"]
  // so only the difference is ever applied: that keeps the CSS angle
  // (rotation - cover) at zero for baked scenes instead of rotating them twice.
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
      .then(function () {
        // `remember` rather than the resolved record: nothing is known about
        // most scenes beyond "not rotated", and that record is shared.
        var record = remember(id);
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

  // The main player. Re-asserted on every sync pass because the Filters panel
  // rewrites the whole inline style attribute of its target, which can drop the
  // transform; `applyTo` repairs that and does nothing when it is intact.
  function apply() {
    var video = getVideo();
    if (!video) return;
    applyTo(video, state.deg);
  }

  // Angle still to be applied with CSS: what the scene stores minus whatever a
  // previous version already baked into the cover image.
  function cssAngleFor(record) {
    var baked = record.cover === null || record.cover === undefined ? 0 : record.cover;
    return ((record.rotation - baked) % 360 + 360) % 360;
  }

  // Scene id and kind of a media element, from its URL. Stash serves scene
  // media at /scene/<id>/{stream,preview,webp,screenshot}.
  function mediaTarget(el) {
    var src = el.currentSrc || el.getAttribute("src") || "";
    var match = src.match(SCENE_MEDIA_RE);
    if (!match) return null;
    return { sceneId: match[1], kind: match[2].toLowerCase() };
  }

  // Rotate everything on the page that shows a scene: the hover preview clip
  // and the cover on every card, the cover in the detail header, and whatever
  // else renders scene media. This is what makes the library look consistent
  // without touching a single file on disk.
  //
  // Runs on every sync pass (mutation, resize, navigation, 1s tick); each
  // element bails out early when neither its box nor its angle changed.
  function decorate() {
    var player = getPlayer();
    var nodes = document.querySelectorAll(MEDIA_SELECTOR);
    var unknown = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // The player is handled by apply(), which owns the angle of the scene
      // being watched rather than the one baked into the DOM at the time.
      if (player && player.contains(el)) continue;
      var target = mediaTarget(el);
      if (!target) continue;
      // The scale needs the intrinsic size, which arrives with the media. One
      // listener per element, so a cover does not sit sideways until the next
      // one-second tick.
      if (!boundMedia.has(el)) {
        boundMedia.add(el);
        el.addEventListener(el.tagName === "VIDEO" ? "loadedmetadata" : "load", scheduleSync);
      }
      var record = recordFor(target.sceneId);
      if (!record) {
        (unknown || (unknown = [])).push(target.sceneId);
        continue;
      }
      applyTo(el, cssAngleFor(record));
    }
    if (!unknown || indexLoaded || indexRequest) return;
    // Nothing indexed yet (first paint of a card grid): one bulk query, then
    // the next pass has every angle it needs.
    preload();
  }

  // ── Filters-panel guard ─────────────────────────────────────────────
  //
  // Stash's SceneVideoFilterPanel picks its target with
  // getElementsByTagName("canvas") and only falls back to <video> when there is
  // no canvas at all. Any plugin that leaves a canvas inside #VideoJsPlayer —
  // including a 0x0 one it created and never finished drawing — therefore
  // receives every Filters transform: rotate, scale, aspect ratio, brightness,
  // contrast. The sliders look completely dead and nothing in the UI says why.
  //
  // An invisible canvas cannot be the thing painting the video, so moving it to
  // the player's parent is safe: the element stays connected, whoever owns it
  // keeps its reference and its data, it is simply no longer inside the subtree
  // the panel scans. The alternative — leaving it and telling the user to go
  // patch some other plugin — is what this plugin's own README used to say.
  var FILTERS_GUARD = true;
  var guardedCanvases = new WeakSet(); // already reported
  var firstSeenEmpty = new WeakMap(); // canvas -> when it was first seen at 0x0
  // A canvas that is 0x0 for less than this is probably still initialising;
  // only something that stays invisible gets moved, so a plugin that sizes its
  // canvas right after appending is never disturbed.
  var EMPTY_CANVAS_GRACE_MS = 700;

  function describeNode(node) {
    var classes = node.className ? "." + String(node.className).trim().split(/\s+/).join(".") : "";
    var name = node.id ? "#" + node.id : classes || " (no class)";
    return "<canvas" + name + " " + (node.width || 0) + "x" + (node.height || 0) + ">";
  }

  function guardFiltersPanel() {
    if (!FILTERS_GUARD) return 0;
    var player = getPlayer();
    if (!player || !player.parentElement) return 0;
    var canvases = player.getElementsByTagName("canvas");
    if (!canvases.length) return 0;
    var now = Date.now();
    var moved = 0;
    // Backwards: moving a canvas out mutates the live collection.
    for (var i = canvases.length - 1; i >= 0; i--) {
      var canvas = canvases[i];
      // A canvas with a layout box may be doing something visible; it is not
      // this plugin's business to move it.
      if (canvas.clientWidth || canvas.clientHeight) {
        firstSeenEmpty.delete(canvas);
        continue;
      }
      var since = firstSeenEmpty.get(canvas);
      if (since === undefined) {
        firstSeenEmpty.set(canvas, now);
        continue;
      }
      if (now - since < EMPTY_CANVAS_GRACE_MS) continue;
      firstSeenEmpty.delete(canvas);
      // Take it out of the parent's layout flow as well: a 0x0 element promoted
      // to a flex/grid item can still add a gap and shift the player by a few
      // pixels, which would get blamed on this plugin.
      if (window.getComputedStyle(canvas).position === "static") {
        canvas.style.position = "absolute";
      }
      player.parentElement.appendChild(canvas);
      moved++;
      if (!guardedCanvases.has(canvas)) {
        guardedCanvases.add(canvas);
        console.warn(
          "SceneRotation: moved " + describeNode(canvas) + " out of #VideoJsPlayer. " +
            "Stash's Filters panel sends every rotate/scale/brightness/contrast " +
            "change to the first canvas it finds, so as long as that canvas was " +
            "inside the player the sliders had no visible effect. The canvas is " +
            "still on the page, just outside the player.\n" +
            "  If it belongs to another plugin, that plugin can no longer use it " +
            "— update it instead: the fix is to keep the canvas inside a shadow " +
            "root, which getElementsByTagName does not cross (MosaicFilter 0.5.2+ " +
            "does this). Until then, SceneRotation.filtersGuard(false) trades the " +
            "Filters sliders back for that plugin's canvas."
        );
      }
    }
    return moved;
  }

  // ── Controls ────────────────────────────────────────────────────────

  // Where the cluster sits, as a fraction of the player box so it survives a
  // resize, a fullscreen switch and the next scene. Kept in localStorage (a few
  // dozen bytes in the browser profile — never on the Stash side, which is what
  // this plugin promises) because Stash rebuilds the player on every
  // navigation and the position would otherwise reset constantly.
  function loadBarPos() {
    try {
      var raw = window.localStorage.getItem(BAR_POS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed) return null;
      var x = Number(parsed.x);
      var y = Number(parsed.y);
      if (!isFinite(x) || !isFinite(y)) return null;
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    } catch (err) {
      // Storage disabled or full: the cluster just starts at the default spot.
      return null;
    }
  }

  function saveBarPos() {
    try {
      if (barPos) window.localStorage.setItem(BAR_POS_KEY, JSON.stringify(barPos));
      else window.localStorage.removeItem(BAR_POS_KEY);
    } catch (err) {
      // Non-fatal: the position simply does not survive the next navigation.
    }
  }

  // Top-right with a small inset, opposite the videojs control bar.
  function defaultBarPos() {
    var player = getPlayer();
    if (!player) return { x: 1, y: 0 };
    var width = player.clientWidth || 1;
    var height = player.clientHeight || 1;
    var barW = bar ? bar.offsetWidth : 96;
    var barH = bar ? bar.offsetHeight : 28;
    return {
      x: Math.max(0, Math.min(1, (width - barW - BAR_INSET) / width)),
      y: Math.max(0, Math.min(1, BAR_INSET / height)),
    };
  }

  // Clamp into the player and write left/top. Cheap enough to run on every sync
  // pass, but guarded: on a busy page sync runs per frame, and forcing layout
  // reads for an unchanged box every frame is exactly how a plugin gets blamed
  // for jank.
  function placeBar() {
    if (!bar) return;
    var player = getPlayer();
    if (!player) return;
    // A drag writes left/top directly; letting this run mid-drag would snap the
    // cluster back to the committed position under the pointer.
    if (drag) return;
    var width = player.clientWidth;
    var height = player.clientHeight;
    if (!width || !height) return;
    var barW = bar.offsetWidth;
    var barH = bar.offsetHeight;
    if (
      placedFor.width === width &&
      placedFor.height === height &&
      placedFor.barW === barW &&
      placedFor.barH === barH
    ) {
      return;
    }
    placedFor = { width: width, height: height, barW: barW, barH: barH };

    var pos = barPos || defaultBarPos();
    var maxLeft = Math.max(0, width - barW);
    var maxTop = Math.max(0, height - barH);
    var left = Math.min(Math.max(0, Math.round(pos.x * width)), maxLeft);
    var top = Math.min(Math.max(0, Math.round(pos.y * height)), maxTop);
    bar.style.left = left + "px";
    bar.style.top = top + "px";
  }

  function onGripDown(event) {
    if (event.button && event.button !== 0) return;
    var player = getPlayer();
    if (!player || !bar) return;
    // Keep the gesture away from videojs: the player scrubs/pauses on pointer
    // events, and a drag across the picture must not seek. `preventDefault` is
    // deliberately *not* called — it suppresses the compatibility mouse events
    // and takes `dblclick` (reset position) down with it.
    event.stopPropagation();
    var barBox = bar.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      grabX: event.clientX - barBox.left,
      grabY: event.clientY - barBox.top,
      moved: false,
      captured: false,
    };
    bar.classList.add("scene-rotation-bar--dragging");
  }

  function onGripMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    var player = getPlayer();
    if (!player || !bar) return;
    // Capture on the first movement rather than on pointerdown: while capture
    // is active the click/dblclick retarget to the capturing element, and a
    // plain click on the grip has to stay a click.
    if (!drag.captured) {
      drag.captured = true;
      try {
        bar.setPointerCapture(event.pointerId);
      } catch (err) {
        // Older engines: the window-level pointerup still ends the drag.
      }
    }
    event.preventDefault();
    var box = player.getBoundingClientRect();
    var maxLeft = Math.max(0, player.clientWidth - bar.offsetWidth);
    var maxTop = Math.max(0, player.clientHeight - bar.offsetHeight);
    var left = Math.min(Math.max(0, event.clientX - box.left - drag.grabX), maxLeft);
    var top = Math.min(Math.max(0, event.clientY - box.top - drag.grabY), maxTop);
    bar.style.left = Math.round(left) + "px";
    bar.style.top = Math.round(top) + "px";
    drag.moved = true;
  }

  function onGripUp(event) {
    if (!drag) return;
    if (event && event.pointerId !== undefined && event.pointerId !== drag.id) return;
    var player = getPlayer();
    var moved = drag.moved;
    var captured = drag.captured;
    if (captured) {
      try {
        bar.releasePointerCapture(drag.id);
      } catch (err) {
        // Already released.
      }
    }
    drag = null;
    if (bar) bar.classList.remove("scene-rotation-bar--dragging");
    if (!moved || !player || !bar) return;
    // The drag ends over the picture, so the click that follows would hit the
    // player and toggle playback. Swallow it for a moment.
    swallowClickUntil = Date.now() + 400;
    // Store what the drag actually produced (already clamped), so the next
    // player of the same size puts the cluster exactly here.
    barPos = {
      x: parseFloat(bar.style.left) / (player.clientWidth || 1),
      y: parseFloat(bar.style.top) / (player.clientHeight || 1),
    };
    placedFor = { width: 0, height: 0, barW: 0, barH: 0 };
    saveBarPos();
  }

  function resetBarPos() {
    barPos = null;
    saveBarPos();
    placedFor = { width: 0, height: 0, barW: 0, barH: 0 };
    placeBar();
  }

  function renderBar() {
    if (!bar) return;
    var value = bar.querySelector(".scene-rotation-bar__value");
    if (value) value.textContent = state.deg + "\u00b0";
    var reset = bar.querySelector('[data-action="reset"]');
    if (reset) reset.disabled = !state.deg;
    // The badge grows from "0°" to "270°", so the cluster can grow past the
    // right edge of a narrow player; re-clamping here keeps it reachable.
    placeBar();
  }

  function onBarClick(event) {
    // Everything inside the cluster belongs to the cluster, not to the player:
    // videojs toggles playback on click, and without this a click on the badge
    // or on the drag handle would pause the scene.
    event.stopPropagation();
    var button = event.target.closest("button[data-action]");
    if (!button) return;
    event.preventDefault();
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
    // A fresh element starts with no inline position, so the placement cache
    // from the previous player must not short-circuit the first placement.
    placedFor = { width: 0, height: 0, barW: 0, barH: 0 };
    bar = document.createElement("div");
    bar.className = "scene-rotation-bar";
    bar.setAttribute("data-scene-rotation-ui", "true");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Playback rotation");
    bar.innerHTML =
      '<span class="scene-rotation-bar__grip" aria-hidden="true"' +
      ' title="Drag to move · double-click to reset the position">⠿</span>' +
      '<button type="button" class="scene-rotation-bar__button" data-action="ccw"' +
      ' title="Rotate 90° counter-clockwise" aria-label="Rotate 90 degrees counter-clockwise">⟲</button>' +
      '<span class="scene-rotation-bar__value" aria-live="polite">0°</span>' +
      '<button type="button" class="scene-rotation-bar__button" data-action="cw"' +
      ' title="Rotate 90° clockwise" aria-label="Rotate 90 degrees clockwise">⟳</button>' +
      '<button type="button" class="scene-rotation-bar__button scene-rotation-bar__button--reset"' +
      ' data-action="reset" title="Clear rotation for this scene" aria-label="Clear rotation">✕</button>';
    bar.addEventListener("click", onBarClick);

    var grip = bar.querySelector(".scene-rotation-bar__grip");
    if (grip) {
      grip.addEventListener("pointerdown", onGripDown);
      grip.addEventListener("dblclick", function (event) {
        event.preventDefault();
        event.stopPropagation();
        resetBarPos();
      });
    }
    bar.addEventListener("pointermove", onGripMove);
    bar.addEventListener("pointerup", onGripUp);
    bar.addEventListener("pointercancel", onGripUp);

    player.appendChild(bar);
    renderBar();
  }

  function unmount() {
    // The player is gone, so a pending click would never be committed by the
    // debounce timer running against a live scene — commit it now.
    flushSave();
    drag = null;
    if (styleWatcher) {
      styleWatcher.disconnect();
      styleWatcher = null;
    }
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
    // Nothing else to do on commit: the covers and previews on screen follow
    // the angle through the CSS pass, not through a write.
    settled.then(function (ok) {
      pending.waiters.forEach(function (resolve) {
        resolve(ok);
      });
      // The angle came from a guess until now; redraw whatever is on screen.
      decorate();
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

  // ── Migration off stored angles ─────────────────────────────────────
  //
  // Baking the angle into the file's display matrix is the only way to make
  // Stash's own artifacts (preview, sprite, cover, transcodes) come out the
  // right way up: the generator runs plain ffmpeg with autorotate on, so it
  // honours the file's matrix and knows nothing about our custom field.
  //
  // But once a file carries that matrix the browser rotates the picture too,
  // and a remaining stored angle would rotate it a second time — and the
  // frontend cannot tell the two cases apart (Chrome reports post-rotation
  // dimensions, which is exactly what Stash scanned into the DB either way).
  // So the two mechanisms are mutually exclusive, and this is the switch that
  // retires the stored angles after the files have been rewritten.
  function resetAll() {
    return graphql(
      "query ($filter: SceneFilterType) { findScenes(scene_filter: $filter, filter: { per_page: -1 }) { scenes { id } } }",
      { filter: { custom_fields: [{ field: FIELD_KEY, modifier: "NOT_NULL" }] } }
    )
      .then(function (data) {
        var scenes = (data && data.findScenes && data.findScenes.scenes) || [];
        var ids = scenes.map(function (scene) {
          return scene.id;
        });
        if (!ids.length) return 0;
        return graphql(
          "mutation ($input: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $input) { id } }",
          {
            input: {
              ids: ids,
              custom_fields: { remove: [FIELD_KEY, COVER_FIELD_KEY] },
            },
          }
        ).then(function () {
          cache = Object.create(null);
          inflight = Object.create(null);
          coverQueue = Object.create(null);
          indexLoaded = false;
          state.deg = 0;
          apply();
          decorate();
          renderBar();
          console.info(
            "SceneRotation: cleared the stored angle on " +
              ids.length +
              " scene(s). Nothing is rotated in the UI any more. If you baked " +
              "the angle into the files instead, regenerate previews, sprites " +
              "and covers so those follow the file's own metadata."
          );
          return ids.length;
        });
      })
      .catch(function (err) {
        console.error("SceneRotation: reset failed", err);
        return 0;
      });
  }

  // ── Reconciliation ──────────────────────────────────────────────────

  function bindVideo() {
    var video = getVideo();
    if (!video || video === boundVideo) return;
    boundVideo = video;
    // The transform needs the intrinsic size, which is only known once the
    // metadata is in; the safety-net tick would catch it, but this is instant.
    video.addEventListener("loadedmetadata", apply);

    // Stash's Filters panel replaces the whole inline style attribute on every
    // slider move, which takes our `rotate`/`scale` with it. Re-applying from a
    // mutation callback puts them back before the browser paints, so the panel's
    // transform and our rotation are both on screen instead of the picture
    // snapping back a second later.
    if (CAN_ROTATE_PROP) {
      if (styleWatcher) styleWatcher.disconnect();
      styleWatcher = new MutationObserver(function () {
        // apply() early-outs when the attribute is the one it wrote, so this
        // only reacts to somebody else's write — no feedback loop.
        apply();
      });
      styleWatcher.observe(video, { attributes: true, attributeFilter: ["style"] });
    }
  }

  function sync() {
    var player = getPlayer();
    if (!player) {
      unmount();
      // Card grids, walls and the detail header have no player but still show
      // scene media, so the decoration pass runs either way.
      decorate();
      return;
    }
    ensurePositioned(player);
    // Before anything else: if a stray canvas is parked in the player, every
    // Filters transform is going into it, and that has nothing to do with us.
    guardFiltersPanel();
    if (!bar) mountBar(player);
    else placeBar();
    bindVideo();

    var sceneId = currentSceneId();
    if (!sceneId) {
      decorate();
      return;
    }

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
        // The stored angle says nothing about what is baked into the cover; a
        // cover baked by an older version and then regenerated is off by
        // exactly this difference. Only worth reporting when something WAS
        // baked (cover === null means nothing was), otherwise every rotated
        // scene would log this on every open.
        if (record.cover !== null && record.rotation !== record.cover) {
          console.info(
            "SceneRotation: the cover already baked " +
              (record.cover === null ? 0 : record.cover) +
              "\u00b0, so the on-screen angle is " +
              cssAngleFor(record) +
              "\u00b0. Run SceneRotation.bakeCover() if you want it baked into " +
              "the image instead (that one writes to disk)."
          );
        }
      });
      decorate();
      return;
    }

    apply();
    decorate();
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

  // Safety net for a drag that ends outside the cluster without pointer
  // capture (released outside the window, or an engine without capture): the
  // move must be committed to storage, not left half-applied.
  window.addEventListener("pointerup", onGripUp);
  window.addEventListener("pointercancel", onGripUp);

  // Capture phase, so videojs never sees the click that ends a drag. Scoped to
  // a few hundred ms after the drag instead of a permanent listener so normal
  // playback clicks keep working, and skipped for clicks on the cluster itself
  // — hitting "rotate" right after moving it is a perfectly normal thing to do.
  document.addEventListener(
    "click",
    function (event) {
      if (Date.now() > swallowClickUntil) return;
      var target = event.target;
      if (target && target.closest && target.closest(".scene-rotation-bar")) return;
      event.stopPropagation();
      event.preventDefault();
    },
    true
  );

  // Closing or reloading inside the debounce window must not drop the click.
  // The mutation is a few hundred bytes, so it can go out with keepalive. It is
  // also the only write this plugin performs.
  window.addEventListener("pagehide", function () {
    flushSave({ keepalive: true });
  });

  window.SceneRotation = {
    set: set,
    get: function () { return state.deg; },
    cycle: function () { return set((state.deg + 90) % 360); },
    // Commit a pending (debounced) write immediately.
    flush: function () { return flushSave(); },
    // Retire every stored angle, e.g. after the rotation has been written into
    // the files themselves (see the migration note in the source).
    resetAll: resetAll,
    sceneId: currentSceneId,
    sync: sync,
    // Re-run the decoration pass by hand (after a stylesheet change, say).
    decorate: decorate,
    // Run the Filters-panel guard now; returns how many canvases it moved.
    unstick: guardFiltersPanel,
    // Turn the guard off (or back on). Off = leave other plugins' canvases
    // alone, at the cost of Stash's Filters tab targeting them again.
    filtersGuard: function (enabled) {
      FILTERS_GUARD = enabled !== false;
      return FILTERS_GUARD;
    },
    // Put the control cluster back in the top-right corner.
    resetBar: resetBarPos,
    // Reload the index of rotated scenes.
    reload: function () {
      indexLoaded = false;
      cache = Object.create(null);
      return preload().then(function () {
        decorate();
        return true;
      });
    },
    // OPT-IN AND WRITEY: bake the current angle into the cover image so that
    // Stash's stored cover no longer shows the card rotated by CSS. Rotates by
    // the difference only, so calling it twice is harmless.
    bakeCover: function () {
      return syncCover(state.sceneId || currentSceneId(), state.deg);
    },
    // Kept as an alias for the old name.
    syncCover: function () {
      return syncCover(state.sceneId || currentSceneId(), state.deg);
    },
    // Angle currently baked into the cover image: null when nothing has been
    // baked, otherwise 0 / 90 / 180 / 270.
    cover: function () {
      var record = state.sceneId ? cache[state.sceneId] : null;
      return record ? record.cover : null;
    },
    // Angle the UI is currently applying with CSS.
    angle: function (sceneId) {
      var record = recordFor(sceneId || state.sceneId || currentSceneId());
      return record ? cssAngleFor(record) : 0;
    },
  };

  // Load the rotated-scene index up front so the first card grid paints with
  // the right angles instead of flashing sideways thumbnails.
  preload().then(function (ok) {
    if (ok) scheduleSync();
  });

  sync();
})();
