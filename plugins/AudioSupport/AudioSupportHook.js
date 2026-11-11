var TAG_NAME = "Audio";

function main() {
    // Hook call: Scene.Create.Post
    if (input.Args.hookContext !== undefined) {
        try {
            return handleHook();
        } catch (err) {
            return { Error: err.toString() };
        }
    }

    // Manual task call
    if (input.Args.mode !== undefined) {
        try {
            if (input.Args.mode === "tagAll") {
                return handleTagAll();
            }
            if (input.Args.mode === "generateVideo") {
                return handleGenerateVideo();
            }
        } catch (err) {
            return { Error: err.toString() };
        }
        return { Output: "ok" };
    }

    return { Output: "no action" };
}

// ---------------------------------------------------------------------------
// Shared helpers (used by both handleHook and handleTagAll)
// ---------------------------------------------------------------------------

// Audio-only detection: video_codec is empty/undefined OR width is 0/null.
function isAudioScene(scene) {
    var files = scene.files;
    if (files === undefined || files === null || files.length === 0) {
        return false;
    }
    var primaryFile = files[0];
    var codec = primaryFile.video_codec;
    var width = primaryFile.width;
    return codec === undefined || codec === null || codec === "" || width === 0 || width === null || width === undefined;
}

// Collect existing tag ids from a scene.
function collectTagIds(scene) {
    var ids = [];
    if (scene.tags === undefined || scene.tags === null) {
        return ids;
    }
    for (var i = 0; i < scene.tags.length; i++) {
        ids.push(scene.tags[i].id);
    }
    return ids;
}

// Apply the Audio tag to a scene via SceneUpdate.
function tagScene(sceneId, tagIds) {
    var mutation = "\
mutation SceneUpdate($input: SceneUpdateInput!) {\
  sceneUpdate(input: $input) {\
    id\
  }\
}";
    var updateVariables = {
        input: {
            id: sceneId,
            tag_ids: tagIds
        }
    };
    gql.Do(mutation, updateVariables);
}

// Write audio metadata (codec, bit_rate, duration) to custom_fields.AudioMeta.
function writeAudioMeta(sceneId, primaryFile) {
    var meta = {
        audio_codec: primaryFile.audio_codec,
        bit_rate: primaryFile.bit_rate,
        duration: primaryFile.duration
    };
    var metaJson = JSON.stringify(meta);
    var mutation = "\
mutation SceneUpdate($input: SceneUpdateInput!) {\
  sceneUpdate(input: $input) {\
    id\
  }\
}";
    var updateVariables = {
        input: {
            id: sceneId,
            custom_fields: {
                partial: {
                    AudioMeta: metaJson
                }
            }
        }
    };
    gql.Do(mutation, updateVariables);
    log.Info("AudioSupport: wrote AudioMeta for scene " + sceneId);
}

function handleHook() {
    var sceneId = input.Args.hookContext.id;

    // Query the scene
    var query = "\
query FindScene($id: ID!) {\
  findScene(id: $id) {\
    id\
    title\
    files {\
      video_codec\
      width\
      duration\
      audio_codec\
      bit_rate\
    }\
    tags {\
      id\
      name\
    }\
  }\
}";

    var variables = { id: sceneId };
    var result = gql.Do(query, variables);
    var scene = result.findScene;

    if (scene === undefined || scene === null) {
        return { Output: "scene not found" };
    }

    if (!isAudioScene(scene)) {
        return { Output: "not audio" };
    }

    // Find or create the Audio tag
    var audioTagId = getOrCreateTag();

    // Check if scene already has the Audio tag
    var existingTagIds = collectTagIds(scene);
    var alreadyTagged = existingTagIds.indexOf(audioTagId) !== -1;

    if (!alreadyTagged) {
        // Add the Audio tag
        existingTagIds.push(audioTagId);
        tagScene(sceneId, existingTagIds);
        log.Info("AudioSupport: tagged scene " + sceneId + " as audio");
    } else {
        log.Info("AudioSupport: scene " + sceneId + " already has Audio tag");
    }

    // Write audio metadata for all audio scenes (even if already tagged)
    var primaryFile = scene.files[0];
    writeAudioMeta(sceneId, primaryFile);
    return { Output: alreadyTagged ? "already tagged" : "tagged" };
}

function handleTagAll() {
    var audioTagId = getOrCreateTag();
    var taggedCount = 0;
    var page = 1;
    var perPage = 500;
    var hasMore = true;

    while (hasMore) {
        var query = "\
query FindScenes($filter: FindFilterType) {\
  findScenes(filter: $filter) {\
    count\
    scenes {\
      id\
      files {\
        video_codec\
        width\
        duration\
        audio_codec\
        bit_rate\
      }\
      tags {\
        id\
        name\
      }\
    }\
  }\
}";

        var variables = {
            filter: {
                per_page: perPage,
                page: page
            }
        };

        var result = gql.Do(query, variables);
        var findScenes = result.findScenes;
        var scenes = findScenes.scenes;
        var total = findScenes.count;

        if (scenes === undefined || scenes === null || scenes.length === 0) {
            hasMore = false;
            break;
        }

        for (var i = 0; i < scenes.length; i++) {
            var scene = scenes[i];
            var sceneId = scene.id;

            if (!isAudioScene(scene)) {
                continue;
            }

            // Check if already tagged
            var existingTagIds = collectTagIds(scene);
            var alreadyTagged = existingTagIds.indexOf(audioTagId) !== -1;

            if (!alreadyTagged) {
                // Tag the scene
                existingTagIds.push(audioTagId);
                tagScene(sceneId, existingTagIds);
                taggedCount++;
                log.Info("AudioSupport: processing scene " + (taggedCount) + " of " + total);
            }

            // Write audio metadata for all audio scenes (even if already tagged)
            var primaryFile = scene.files[0];
            writeAudioMeta(sceneId, primaryFile);
        }

        // Check if we've processed all pages
        if (scenes.length < perPage) {
            hasMore = false;
        } else {
            page++;
        }
    }

    log.Info("AudioSupport: tagged " + taggedCount + " scenes total");
    return { Output: "tagged " + taggedCount + " scenes" };
}

function getOrCreateTag() {
    var existingId = findTagIdByName(TAG_NAME);
    if (existingId !== null) {
        log.Info("AudioSupport: found existing Audio tag");
        return existingId;
    }

    // Create the Audio tag
    log.Info("AudioSupport: creating new Audio tag");

    var mutation = "\
mutation tagCreate($input: TagCreateInput!) {\
  tagCreate(input: $input) {\
    id\
  }\
}";

    var variables = {
        input: {
            name: TAG_NAME
        }
    };

    var result = gql.Do(mutation, variables);
    log.Info("AudioSupport: created Audio tag with id " + result.tagCreate.id);
    return result.tagCreate.id;
}

// Look up a tag id by exact name. Returns null when the tag does not exist.
// Read-only on purpose: callers that must not create tags (the generate task)
// use this instead of getOrCreateTag.
function findTagIdByName(name) {
    var query = "\
query {\
  allTags {\
    id\
    name\
  }\
}";

    var result = gql.Do(query);
    var allTags = result.allTags;

    if (allTags === undefined || allTags === null) {
        return null;
    }

    for (var i = 0; i < allTags.length; i++) {
        if (allTags[i].name === name) {
            return allTags[i].id;
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Generate for video scenes (skips audio-tagged scenes)
// ---------------------------------------------------------------------------
//
// Stash's built-in Generate task walks every scene, including the audio-only
// scenes this plugin creates by adding audio extensions to videoExtensions.
// Those files have no video stream, so preview/sprite/phash/cover generation
// fails and logs errors. The built-in task takes either an explicit scene id
// list or "everything" - it has no tag filter and no plugin hook - so a plugin
// cannot stop it. The workaround is to queue the same generate options for the
// video scenes only, which is what this task does.
//
// Audio scenes are identified by the audio tag (the tag handleHook and
// handleTagAll apply), not by probing files. The filter is server-side, so the
// id collection stays a single paged query. Scenes that were never tagged are
// still queued: run "Tag all audio scenes" first on an existing library.
//
// Transcodes are never requested. An audio-only file has no video stream, so
// Stash's transcode task "succeeds" and writes a blank video, wasting disk and
// time; there is no useful transcode target for audio.

var DEFAULT_GENERATE_BATCH_SIZE = 250;
var GENERATE_SCENE_PAGE_SIZE = 500;
var GENERATE_COLLECT_PROGRESS = 0.5;

var GENERATE_SCENES_QUERY = "\
query AudioSupportGenerateScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {\
  findScenes(filter: $filter, scene_filter: $scene_filter) {\
    count\
    scenes {\
      id\
    }\
  }\
}";

var GENERATE_MUTATION = "\
mutation AudioSupportMetadataGenerate($input: GenerateMetadataInput!) {\
  metadataGenerate(input: $input)\
}";

function asBool(value, fallback) {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value !== 0;
    }
    if (typeof value === "string") {
        var lowered = value.toLowerCase();
        if (lowered === "true" || lowered === "1") {
            return true;
        }
        if (lowered === "false" || lowered === "0") {
            return false;
        }
    }
    return fallback;
}

function asInt(value, fallback) {
    if (value === undefined || value === null) {
        return fallback;
    }
    var parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        return fallback;
    }
    return parsed;
}

// Paginate findScenes with the audio tag excluded and collect the scene ids.
function collectVideoSceneIds(tagId) {
    var ids = [];
    var page = 1;
    var total = 0;
    var more = true;

    while (more) {
        var result = gql.Do(GENERATE_SCENES_QUERY, {
            filter: { per_page: GENERATE_SCENE_PAGE_SIZE, page: page },
            scene_filter: {
                tags: { value: [tagId], modifier: "EXCLUDES" }
            }
        });

        var findScenes = result.findScenes;
        if (findScenes === undefined || findScenes === null) {
            more = false;
            break;
        }

        if (page === 1 && findScenes.count !== undefined && findScenes.count !== null) {
            total = findScenes.count;
        }

        var scenes = findScenes.scenes;
        if (scenes === undefined || scenes === null || scenes.length === 0) {
            more = false;
            break;
        }

        for (var i = 0; i < scenes.length; i++) {
            ids.push(scenes[i].id);
        }

        if (total > 0) {
            log.Progress(GENERATE_COLLECT_PROGRESS * (ids.length / total));
        }

        if (scenes.length < GENERATE_SCENE_PAGE_SIZE) {
            more = false;
        } else {
            page++;
        }
    }

    log.Info("AudioSupport: collected " + ids.length + " video scene(s)");
    return ids;
}

// Queue generate for the given scene ids in batches, one metadataGenerate
// mutation per batch so a large library does not produce a single huge input.
function queueGenerate(ids, options, batchSize) {
    var queued = 0;
    var batches = 0;

    for (var start = 0; start < ids.length; start += batchSize) {
        var chunk = ids.slice(start, start + batchSize);

        gql.Do(GENERATE_MUTATION, {
            input: {
                sceneIDs: chunk,
                sprites: options.sprites,
                previews: options.previews,
                phashes: options.phashes,
                markers: options.markers,
                covers: options.covers,
                overwrite: options.overwrite,
                transcodes: false
            }
        });

        queued += chunk.length;
        batches++;
        log.Progress(GENERATE_COLLECT_PROGRESS + (1 - GENERATE_COLLECT_PROGRESS) * (queued / ids.length));
        log.Info("AudioSupport: queued generate for " + queued + " / " + ids.length + " scene(s)");
    }

    return { queued: queued, batches: batches };
}

function handleGenerateVideo() {
    var args = input.Args || {};

    var options = {
        sprites: asBool(args.sprites, true),
        previews: asBool(args.previews, true),
        phashes: asBool(args.phashes, true),
        markers: asBool(args.markers, true),
        covers: asBool(args.covers, false),
        overwrite: asBool(args.overwrite, false)
    };
    var dryRun = asBool(args.dryRun, false);
    var batchSize = asInt(args.batchSize, DEFAULT_GENERATE_BATCH_SIZE);
    if (batchSize < 1) {
        batchSize = DEFAULT_GENERATE_BATCH_SIZE;
    }

    if (asBool(args.transcodes, false)) {
        log.Warn("AudioSupport: ignoring transcodes - Stash would write a blank video for audio-only scenes");
    }

    if (!options.sprites && !options.previews && !options.phashes && !options.markers && !options.covers) {
        return { Error: "no generate option selected (sprites, previews, phashes, markers or covers)" };
    }

    var tagName = (typeof args.tagName === "string" && args.tagName.length > 0) ? args.tagName : TAG_NAME;
    var tagId = findTagIdByName(tagName);
    if (tagId === null) {
        // Never fall back to "all scenes": that would reintroduce the errors.
        return { Error: "audio tag '" + tagName + "' does not exist - run 'Tag all audio scenes' first" };
    }

    var ids = collectVideoSceneIds(tagId);
    if (ids.length === 0) {
        log.Info("AudioSupport: no video scenes to generate");
        return { Output: "no video scenes to generate" };
    }

    if (dryRun) {
        log.Info("AudioSupport: dry run - would queue " + ids.length + " scene(s)");
        return { Output: "dry run: would queue " + ids.length + " scene(s)" };
    }

    var result = queueGenerate(ids, options, batchSize);
    var summary = "queued " + result.queued + " scene(s) in " + result.batches + " batch(es)";
    log.Info("AudioSupport: " + summary);
    return { Output: summary };
}

var result = main();
result;