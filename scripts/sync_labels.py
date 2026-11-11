#!/usr/bin/env python3
"""Create or update the repository's issue labels from .github/labels.json.

Usage:
    GITHUB_TOKEN=<token> ./scripts/sync_labels.py [--repo owner/name] [--dry-run]

The token needs the `issues: write` permission on the repository (a classic
token with `repo` works too). The repo defaults to the `origin` remote of the
current checkout.

Only labels listed in .github/labels.json are touched. Labels that exist on
GitHub but are missing from the file are left alone: deleting a label also
removes it from every issue, which is not something this script should do
silently.

Standard library only, so it runs anywhere python3 does.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.github.com"
LABELS_FILE = Path(__file__).resolve().parent.parent / ".github" / "labels.json"


def repo_from_git():
    try:
        url = subprocess.check_output(
            ["git", "config", "--get", "remote.origin.url"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit("error: no origin remote; pass --repo owner/name")

    match = re.search(r"github\.com[:/]+([^/]+)/(.+?)(?:\.git)?$", url)
    if not match:
        sys.exit("error: could not parse repo from origin url: " + url)
    return match.group(1) + "/" + match.group(2)


def request(method, url, token, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8")
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = {"message": body}
        return err.code, parsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="owner/name (defaults to the origin remote)")
    parser.add_argument("--dry-run", action="store_true", help="print what would change")
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    repo = args.repo or repo_from_git()
    labels = json.loads(LABELS_FILE.read_text(encoding="utf-8"))

    if not token and not args.dry_run:
        sys.exit("error: set GITHUB_TOKEN (or GH_TOKEN) to apply labels")

    created = updated = failed = 0
    for label in labels:
        name, color, description = label["name"], label["color"], label.get("description", "")
        path = API + "/repos/" + repo + "/labels/" + urllib.parse.quote(name, safe="")

        if args.dry_run:
            print("would sync {name} (#{color})".format(name=name, color=color))
            continue

        status, body = request("PATCH", path, token, {"color": color, "description": description})
        if status == 200:
            updated += 1
            print("updated  " + name)
            continue
        if status != 404:
            failed += 1
            print("FAILED   " + name + ": " + str(body))
            continue

        status, body = request(
            "POST",
            API + "/repos/" + repo + "/labels",
            token,
            {"name": name, "color": color, "description": description},
        )
        if status == 201:
            created += 1
            print("created  " + name)
        else:
            failed += 1
            print("FAILED   " + name + ": " + str(body))

    print("\n{repo}: {created} created, {updated} updated, {failed} failed".format(
        repo=repo, created=created, updated=updated, failed=failed
    ))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
