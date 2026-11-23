#!/usr/bin/env python3
"""check: make sure every manifest matches the files on disk.

  python3 tools/check.py

fails when a file is listed but missing, a file is on disk but not
listed, a size is off, or a project sits in a sector that doesn't exist.
"""

import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    problems = []
    sectors = {os.path.basename(os.path.dirname(p))
               for p in glob.glob(os.path.join(ROOT, "sectors", "*", "sector.json"))}
    manifests = glob.glob(os.path.join(ROOT, "sectors", "*", "*", "manifest.json"))
    for path in manifests:
        project = os.path.dirname(path)
        rel = os.path.relpath(project, ROOT)
        with open(path, encoding="utf-8") as f:
            m = json.load(f)
        if m["sector"] not in sectors or os.path.basename(os.path.dirname(project)) != m["sector"]:
            problems.append(f"{rel}: sector '{m['sector']}' doesn't match its folder")
        ids = {v["id"] for v in m["versions"]}
        for v in m["versions"]:
            if v.get("same_as"):
                if v["same_as"] not in ids:
                    problems.append(f"{rel}: {v['id']} points at missing version {v['same_as']}")
                continue
            base = os.path.join(project, v["id"])
            listed = {p: s for p, s in v["files"]}
            on_disk = {}
            for b, _, names in os.walk(base):
                for n in names:
                    full = os.path.join(b, n)
                    if not os.path.islink(full):
                        on_disk[os.path.relpath(full, base).replace(os.sep, "/")] = os.path.getsize(full)
            for p in listed.keys() - on_disk.keys():
                problems.append(f"{rel}/{v['id']}: listed but missing: {p}")
            for p in on_disk.keys() - listed.keys():
                problems.append(f"{rel}/{v['id']}: on disk but not listed: {p}")
            for p in listed.keys() & on_disk.keys():
                if listed[p] != on_disk[p]:
                    problems.append(f"{rel}/{v['id']}: size changed: {p}")
        if m.get("entry") and not os.path.isfile(os.path.join(project, m["entry"])):
            problems.append(f"{rel}: demo entry {m['entry']} is missing")

    for p in problems[:200]:
        print(p)
    if problems:
        sys.exit(f"{len(problems)} problem(s)")
    print(f"all {len(manifests)} manifest(s) match their shelves")


if __name__ == "__main__":
    main()
