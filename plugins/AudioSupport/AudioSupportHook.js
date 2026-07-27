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

    // Check if audio-only: video_codec is empty/undefined OR width is 0/null
    var files = scene.files;
    var isAudio = false;
    if (files !== undefined && files !== null && files.length > 0) {
        var primaryFile = files[0];
        var codec = primaryFile.video_codec;
        var width = primaryFile.width;
        if (codec === undefined || codec === null || codec === "" || width === 0 || width === null || width === undefined) {
            isAudio = true;
        }
    }

    if (!isAudio) {
        return { Output: "not audio" };
    }

    // Find or create the Audio tag
    var audioTagId = getOrCreateTag();

    // Check if scene already has the Audio tag
    var existingTagIds = [];
    var alreadyTagged = false;
    if (scene.tags !== undefined && scene.tags !== null) {
        for (var i = 0; i < scene.tags.length; i++) {
            var tag = scene.tags[i];
            existingTagIds.push(tag.id);
            if (tag.id === audioTagId) {
                alreadyTagged = true;
            }
        }
    }

    if (alreadyTagged) {
        log.Info("AudioSupport: scene " + sceneId + " already has Audio tag");
        return { Output: "already tagged" };
    }

    // Add the Audio tag
    existingTagIds.push(audioTagId);

    var mutation = "\
mutation SceneUpdate($input: SceneUpdateInput!) {\
  sceneUpdate(input: $input) {\
    id\
  }\
}";

    var updateVariables = {
        input: {
            id: sceneId,
            tag_ids: existingTagIds
        }
    };

    gql.Do(mutation, updateVariables);
    log.Info("AudioSupport: tagged scene " + sceneId + " as audio");
    return { Output: "tagged" };
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

            // Check if audio-only
            var files = scene.files;
            var isAudio = false;
            if (files !== undefined && files !== null && files.length > 0) {
                var primaryFile = files[0];
                var codec = primaryFile.video_codec;
                var width = primaryFile.width;
                if (codec === undefined || codec === null || codec === "" || width === 0 || width === null || width === undefined) {
                    isAudio = true;
                }
            }

            if (!isAudio) {
                continue;
            }

            // Check if already tagged
            var existingTagIds = [];
            var alreadyTagged = false;
            if (scene.tags !== undefined && scene.tags !== null) {
                for (var j = 0; j < scene.tags.length; j++) {
                    var tag = scene.tags[j];
                    existingTagIds.push(tag.id);
                    if (tag.id === audioTagId) {
                        alreadyTagged = true;
                    }
                }
            }

            if (alreadyTagged) {
                continue;
            }

            // Tag the scene
            existingTagIds.push(audioTagId);

            var mutation = "\
mutation SceneUpdate($input: SceneUpdateInput!) {\
  sceneUpdate(input: $input) {\
    id\
  }\
}";

            var updateVariables = {
                input: {
                    id: sceneId,
                    tag_ids: existingTagIds
                }
            };

            gql.Do(mutation, updateVariables);
            taggedCount++;
            log.Info("AudioSupport: processing scene " + (taggedCount) + " of " + total);
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
