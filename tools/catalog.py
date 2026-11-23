#!/usr/bin/env python3
"""catalog: rebuild catalog.json from every sector and manifest.

  python3 tools/catalog.py

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
    with open(os.path.join(ROOT, "catalog.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1, ensure_ascii=False)
        f.write("\n")
    t = catalog["totals"]
    print(f"catalog: {t['projects']} projects, {t['versions']} versions, {t['files']} files")


if __name__ == "__main__":
    main()
