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
    // Query all tags
    var query = "\
query {\
  allTags {\
    id\
    name\
  }\
}";

    var result = gql.Do(query);
    var allTags = result.allTags;

    // Look for existing Audio tag
    if (allTags !== undefined && allTags !== null) {
        for (var i = 0; i < allTags.length; i++) {
            if (allTags[i].name === TAG_NAME) {
                log.Info("AudioSupport: found existing Audio tag");
                return allTags[i].id;
            }
        }
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

    result = gql.Do(mutation, variables);
    log.Info("AudioSupport: created Audio tag with id " + result.tagCreate.id);
    return result.tagCreate.id;
}

var result = main();
result;