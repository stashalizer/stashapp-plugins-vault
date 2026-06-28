"use strict";
(function () {
  const csLib = window.csLib;
  if (!csLib) {
    console.error("SceneInfoOverlay: CommunityScriptsUILibrary not loaded. Install it first.");
    return;
  }

  /**
   * Known limitation:
   * PathElementListener re-fires on navigation to /scenes/ but does NOT re-fire on
   * React re-renders that don't change the URL (e.g. switching scene tabs). If React
   * discards the injected overlay node, it self-heals on the next navigation. This is
   * acceptable for the demo.
   */

  csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setupOverlay);

  /**
   * Build and inject the scene-info-overlay into the video player element.
   * @param {HTMLElement} playerEl - The #VideoJsPlayer container.
   */
  async function setupOverlay(playerEl) {
    // Parse scene id from the current URL path.
    const m = window.location.pathname.match(/^\/scenes\/(\d+)/);
    if (!m) return;
    const sceneId = m[1];

    // Prevent double injection if the overlay already exists.
    if (playerEl.querySelector(".scene-info-overlay")) return;

    // Load plugin settings with sensible defaults.
    const defaults = { overlayText: "", showTags: true };
    let settings;
    try {
      const stored = await csLib.getConfiguration("SceneInfoOverlay");
      // Merge stored values with defaults so missing keys fall back.
      settings = { ...defaults, ...(stored || {}) };
    } catch (e) {
      console.error("SceneInfoOverlay: failed to load settings", e);
      settings = { ...defaults };
    }

    // Fetch scene data from the stash GraphQL API.
    let result;
    try {
      const query = `query($id: ID!) {
        findScene(id: $id) {
          id
          title
          date
          rating
          details
          studio { id name }
          performers { performer { id name } }
          tags { id name }
        }
      }`;
      result = await csLib.callGQL({ query, variables: { id: sceneId } });
    } catch (e) {
      console.error("SceneInfoOverlay: failed to load scene", e);
      return; // Do NOT inject a broken overlay.
    }

    const scene = result?.findScene;
    if (!scene) return;

    // Ensure the player container allows absolute positioning.
    if (getComputedStyle(playerEl).position === "static") {
      playerEl.style.position = "relative";
    }

    // ---- Build the overlay DOM (no innerHTML) ----

    const container = document.createElement("div");
    container.className = "scene-info-overlay";

    // Title
    const titleEl = document.createElement("div");
    titleEl.className = "scene-info-overlay__title";
    titleEl.textContent = scene.title ?? "Untitled";
    container.appendChild(titleEl);

    // Metadata: studio, date, rating
    const metaParts = [];
    if (scene.studio?.name) {
      metaParts.push(scene.studio.name);
    }
    if (scene.date) {
      metaParts.push(scene.date);
    }
    if (scene.rating != null) {
      metaParts.push("Rating: " + scene.rating);
    }
    const metaEl = document.createElement("div");
    metaEl.className = "scene-info-overlay__meta";
    metaEl.textContent = metaParts.join(" · ") || "";
    container.appendChild(metaEl);

    // Performers (Scene.performers is [PerformerAppearance] wrapping { performer })
    const names = (scene.performers || [])
      .map((p) => p?.performer?.name)
      .filter(Boolean);
    const perfEl = document.createElement("div");
    perfEl.className = "scene-info-overlay__performers";
    perfEl.textContent = names.length ? names.join(", ") : "No performers";
    container.appendChild(perfEl);

    // Tags (only if showTags is enabled)
    if (settings.showTags) {
      const tagNames = (scene.tags || [])
        .map((t) => t?.name)
        .filter(Boolean);
      if (tagNames.length > 0) {
        const tagsEl = document.createElement("div");
        tagsEl.className = "scene-info-overlay__tags";
        tagsEl.textContent = tagNames.join(", ");
        container.appendChild(tagsEl);
      }
    }

    // Custom overlay text (if provided in settings)
    if (settings.overlayText && typeof settings.overlayText === "string" && settings.overlayText.trim() !== "") {
      const customEl = document.createElement("div");
      customEl.className = "scene-info-overlay__custom";
      customEl.textContent = settings.overlayText;
      container.appendChild(customEl);
    }

    // Append the overlay to the player element.
    playerEl.appendChild(container);
  }
})();
