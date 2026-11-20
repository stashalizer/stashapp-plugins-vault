#!/bin/bash
# AGPLv3.0
# https://github.com/stashapp/CommunityScripts/blob/main/LICENSE

# builds a repository of plugins
# outputs to _site with the following structure:
# index.yml
# <plugin_id>.zip
# Each zip file contains the plugin.yml file and any other files in the same directory

outdir="$1"
if [ -z "$outdir" ]; then
    outdir="_site"
fi

rm -rf "$outdir"
mkdir -p "$outdir"

# Read the first "<key>: value" line of a manifest and print the value with one
# layer of YAML quoting removed. Plain values are printed verbatim.
manifestValue()
{
    file=$1
    key=$2
    value=$(grep -m1 "^$key:" "$file" | sed -e 's/\r$//' -e "s/^$key:[[:space:]]*//")

    case $value in
    \"*\")
        value=${value#\"}
        value=${value%\"}
        value=${value//\\\"/\"}
        value=${value//\\\\/\\}
        ;;
    \'*\')
        value=${value#\'}
        value=${value%\'}
        value=${value//\'\'/\'}
        ;;
    esac

    printf '%s' "$value"
}

# Print a value as a double-quoted YAML scalar. The index is machine generated,
# so it must not rely on the manifest happening to be quote-safe: an unquoted
# description containing ": " (e.g. "Optional: install SuiteData ...") makes
# Stash reject the whole package list with
# "yaml: line N: mapping values are not allowed in this context".
yamlScalar()
{
    value=$(manifestValue "$1" "$2")
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "$value"
}

buildPlugin() 
{
    f=$1
    # get the plugin id from the directory
    dir=$(dirname "$f")
    plugin_id=$(basename "$f" .yml)

    echo "Processing $plugin_id"

    # create a directory for the version
    version=$(git log -n 1 --pretty=format:%h -- "$dir"/*)
    updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- "$dir"/*)
    
    # create the zip file
    # copy other files
    # Markdown files in a plugin directory are developer documentation only and
    # must not be published to plugin users — exclude them from the zip.
    zipfile=$(realpath "$outdir/$plugin_id.zip")

    pushd "$dir" > /dev/null
    zip -r "$zipfile" . -x "*.md" > /dev/null
    popd > /dev/null

    name=$(yamlScalar "$f" name)
    description=$(yamlScalar "$f" description)
    ymlVersion=$(manifestValue "$f" version)
    version="$ymlVersion-$version"
    IFS=$'\n' dep=$(grep "^# requires:" "$f" | sed -e 's/^#[[:space:]]*requires:[[:space:]]*//' -e 's/\r$//')

    # write to spec index
    echo "- id: $plugin_id
  name: $name
  metadata:
    description: $description
  version: $version
  date: $updated
  path: $plugin_id.zip
  sha256: $(sha256sum "$zipfile" | cut -d' ' -f1)" >> "$outdir"/index.yml

    # handle dependencies
    if [ ! -z "$dep" ]; then
        echo "  requires:" >> "$outdir"/index.yml
        for d in ${dep//,/ }; do
            echo "    - $d" >> "$outdir"/index.yml
        done
    fi

    echo "" >> "$outdir"/index.yml
}

find ./plugins -mindepth 1 -name *.yml | while read file; do
    buildPlugin "$file"
done
