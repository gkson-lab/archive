#!/usr/bin/env python3
"""catalog: rebuild catalog.json and activity.json from every shelf.

  python3 tools/catalog.py

catalog.json lists the sectors and projects. activity.json is one feed of
every commit and pull request across the archive, newest first.

accession numbers come from when a project started, oldest first,
so they stay put when a newer project is filed.
"""

import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    sectors = []
    for path in sorted(glob.glob(os.path.join(ROOT, "sectors", "*", "sector.json"))):
        s = load(path)
        s["id"] = os.path.basename(os.path.dirname(path))
        sectors.append(s)
    sectors.sort(key=lambda s: s.get("order", 99))

    projects = []
    for path in glob.glob(os.path.join(ROOT, "sectors", "*", "*", "manifest.json")):
        m = load(path)
        filed = [v for v in m["versions"] if not v.get("same_as")]
        projects.append({
            "name": m["name"],
            "title": m["title"],
            "sector": m["sector"],
            "summary": m.get("summary", ""),
            "source": m.get("source"),
            "kind": m.get("kind", "source"),
            "entry": m.get("entry"),
            "first": m.get("first"),
            "last": m.get("last"),
            "commits": m.get("commits", 0),
            "pulls": m.get("pulls", {"open": 0, "total": 0}),
            "versions": len(m["versions"]),
            "files": sum(len(v["files"]) for v in filed),
            "bytes": sum(size for v in filed for _, size in v["files"]),
            "path": os.path.relpath(os.path.dirname(path), ROOT).replace(os.sep, "/"),
        })
    projects.sort(key=lambda p: (p["first"] or "9999", p["name"]))
    for i, p in enumerate(projects, 1):
        p["accession"] = f"{i:03d}"

    catalog = {
        "sectors": sectors,
        "projects": projects,
        "totals": {
            "projects": len(projects),
            "versions": sum(p["versions"] for p in projects),
            "files": sum(p["files"] for p in projects),
            "bytes": sum(p["bytes"] for p in projects),
        },
    }
    events = []
    for p in projects:
        path = os.path.join(ROOT, p["path"], "activity.json")
        if not os.path.isfile(path):
            continue
        a = load(path)
        for c in a.get("commits", []):
            events.append({"type": "commit", "project": p["name"], "date": c["date"], "who": c["author"],
                           "text": c["message"], "sha": c["sha"], "tips": c.get("tips", [])})
        for pr in a.get("pulls", []):
            base = {"project": p["name"], "number": pr["number"], "text": pr["title"], "url": pr["url"],
                    "head": pr.get("head"), "base": pr.get("base")}
            events.append(dict(base, type="pr-opened", date=pr["created"], who=pr["author"], draft=pr.get("draft")))
            if pr.get("merged"):
                events.append(dict(base, type="pr-merged", date=pr["merged"], who=pr["author"]))
            elif pr.get("closed"):
                events.append(dict(base, type="pr-closed", date=pr["closed"], who=pr["author"]))
    events.sort(key=lambda e: e["date"] or "", reverse=True)
    catalog["totals"]["events"] = len(events)
    catalog["totals"]["pulls"] = sum(p["pulls"]["total"] for p in projects)
    with open(os.path.join(ROOT, "catalog.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(ROOT, "activity.json"), "w", encoding="utf-8") as f:
        json.dump(events, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    t = catalog["totals"]
    print(f"catalog: {t['projects']} projects, {t['versions']} versions, {t['files']} files, {t['events']} events")


if __name__ == "__main__":
    main()
