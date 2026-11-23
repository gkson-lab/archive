#!/usr/bin/env python3
"""sync: keep every shelf in step with the repo it came from.

  python3 tools/sync.py [--only NAME] [--force]

for every project in sources.json:
  - ask the remote for its branches and github for its pull requests
  - if anything moved (a push, a new branch, a pull request opened,
    updated, merged or closed), file the shelf again
  - demo shelves (onyx) only refresh the demo and the activity

new repos on the owner's account that aren't forks are added to
sources.json and filed in the intake sector, so nothing gets missed.

a project listed in sources.json but not on main yet is waiting for its
pull request to be reviewed, so sync leaves it alone.

prints the names of the shelves it changed, one per line, after "changed:".
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from accession import ROOT, SECTORS, accession, fetch_pulls, gh_api, github_repo, remote_heads, signature  # noqa: E402

SOURCES = os.path.join(ROOT, "sources.json")


def load_sources():
    with open(SOURCES, encoding="utf-8") as f:
        return json.load(f)


def save_sources(data):
    with open(SOURCES, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")


def discover(data):
    """add the owner's new, non-fork repos to the intake sector."""
    intake = data.get("intake") or {}
    owner = intake.get("owner")
    if not owner:
        return []
    repos = gh_api(f"users/{owner}/repos?per_page=100&type=owner")
    if repos is None:
        print("couldn't list the owner's repos, skipping discovery")
        return []
    known = {github_repo(p["repo"]) for p in data["projects"]}
    skip = set(intake.get("exclude", []))
    added = []
    for r in repos:
        full = r["full_name"]
        if r.get("fork") or r.get("private"):
            continue
        if r.get("archived") and intake.get("skip_archived"):
            continue
        if full in known or r["name"] in skip:
            continue
        entry = {
            "repo": r["html_url"],
            "sector": intake.get("sector", "intake"),
            "name": r["name"],
            "title": r["name"].replace("-", " ").lower(),
            "summary": (r.get("description") or "").strip().lower(),
            "auto": True,
        }
        data["projects"].append(entry)
        added.append(r["name"])
    return added


def manifest_path(p):
    return os.path.join(SECTORS, p["sector"], p["name"], "manifest.json")


def main():
    ap = argparse.ArgumentParser(description="sync every shelf with its source repo")
    ap.add_argument("--only", action="append", help="only this project (repeatable)")
    ap.add_argument("--force", action="store_true", help="file again even if nothing moved")
    a = ap.parse_args()

    data = load_sources()
    added = discover(data) if not a.only else []
    if added:
        save_sources(data)
        print("found new repos: " + ", ".join(added))

    changed = []
    for p in data["projects"]:
        if a.only and p["name"] not in a.only:
            continue
        path = manifest_path(p)
        on_main = os.path.isfile(path)
        if not on_main and not p.get("auto"):
            print(f"{p['name']}: waiting for its pull request, skipped")
            continue

        slug = github_repo(p["repo"])
        try:
            heads = remote_heads(p["repo"])
        except Exception as e:  # a deleted or renamed repo shouldn't stop the rest
            print(f"{p['name']}: couldn't reach the repo ({e}), kept as it was")
            continue
        pulls = fetch_pulls(slug) if slug else None
        old = {}
        if on_main:
            with open(path, encoding="utf-8") as f:
                old = json.load(f)
        if pulls is None and old:
            act = os.path.join(os.path.dirname(path), "activity.json")
            if os.path.isfile(act):
                with open(act, encoding="utf-8") as f:
                    pulls = json.load(f).get("pulls")
        demo = p.get("demo")
        main_branch = None
        if demo:
            main_branch = p.get("branch") or ("main" if "main" in heads else next(iter(heads), None))
        sig = signature(heads, pulls, main_branch)
        if not a.force and old.get("signature") == sig:
            print(f"{p['name']}: up to date")
            continue

        print(f"{p['name']}: moved, filing again")
        try:
            accession(p["repo"], p["sector"], p["name"], p.get("title"), p.get("summary", ""),
                      None, ",".join(demo) if demo else None, p.get("entry"), None, True)
        except Exception as e:
            print(f"{p['name']}: filing failed ({e}), kept as it was")
            continue
        changed.append(p["name"])

    print("changed: " + " ".join(changed))


if __name__ == "__main__":
    main()
