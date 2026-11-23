#!/usr/bin/env python3
"""accession: file a project into the archive.

every branch of a git repo becomes a version under
sectors/<sector>/<project>/<version>/, as a full copy of its files.
branches whose files match a version already filed are recorded as
"same as" instead of being copied twice.

  python3 tools/accession.py <repo url or path> <sector> [options]

options:
  --name NAME        folder name for the project (default: the repo name)
  --title TITLE      display name (default: NAME)
  --summary TEXT     one line about the project, lowercase
  --branch B         only file this branch (repeatable)
  --demo PATHS       demo mode: file only these paths from the default
                     branch, comma separated, into <project>/demo/
  --entry FILE       demo mode: the page that starts the demo
  --keep-source URL  link shown as the project's origin (default: repo url)

after filing, run tools/catalog.py to rebuild catalog.json.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECTORS = os.path.join(ROOT, "sectors")


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", repo, *args], check=True, capture_output=True, text=True
    ).stdout


def slug(branch):
    return re.sub(r"[^a-z0-9._-]+", "-", branch.replace("/", "--").lower()).strip("-")


def branches(repo):
    out = git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin", "refs/heads")
    seen, names = set(), []
    for ref in out.split():
        if ref.endswith("/HEAD"):
            continue
        name = ref.split("refs/remotes/origin/", 1)[-1].split("refs/heads/", 1)[-1]
        if name not in seen:
            seen.add(name)
            names.append((name, ref))
    return names


def default_branch(repo, refs):
    try:
        head = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").strip()
        return head.split("/", 1)[1]
    except subprocess.CalledProcessError:
        names = [n for n, _ in refs]
        return "main" if "main" in names else names[0]


def export(repo, ref, dest, paths=None):
    """copy the files of ref into dest using git archive (no .git, no history)."""
    os.makedirs(dest, exist_ok=True)
    with tempfile.TemporaryFile() as tmp:
        subprocess.run(
            ["git", "-C", repo, "archive", "--format=tar", ref, *(paths or [])],
            check=True, stdout=tmp,
        )
        tmp.seek(0)
        with tarfile.open(fileobj=tmp) as tar:
            tar.extractall(dest, filter="data")


def listing(folder):
    files = []
    for base, dirs, names in os.walk(folder):
        dirs.sort()
        for n in sorted(names):
            full = os.path.join(base, n)
            if os.path.islink(full):
                continue
            files.append([os.path.relpath(full, folder).replace(os.sep, "/"), os.path.getsize(full)])
    return files


def main():
    ap = argparse.ArgumentParser(description="file a project into the archive")
    ap.add_argument("repo")
    ap.add_argument("sector")
    ap.add_argument("--name")
    ap.add_argument("--title")
    ap.add_argument("--summary", default="")
    ap.add_argument("--branch", action="append")
    ap.add_argument("--demo")
    ap.add_argument("--entry")
    ap.add_argument("--keep-source")
    a = ap.parse_args()

    sector_dir = os.path.join(SECTORS, a.sector)
    if not os.path.isfile(os.path.join(sector_dir, "sector.json")):
        sys.exit(f"no sector called '{a.sector}'. make sectors/{a.sector}/sector.json first.")

    work = tempfile.mkdtemp(prefix="accession-")
    try:
        if os.path.isdir(a.repo):
            repo = os.path.abspath(a.repo)
            source = a.keep_source or git(repo, "remote", "get-url", "origin").strip()
        else:
            repo = os.path.join(work, "repo")
            subprocess.run(["git", "clone", "-q", "--no-checkout", a.repo, repo], check=True)
            source = a.keep_source or a.repo
        source = re.sub(r"\.git$", "", source)

        name = a.name or os.path.basename(source)
        project_dir = os.path.join(sector_dir, name)
        if os.path.exists(project_dir):
            shutil.rmtree(project_dir)
        os.makedirs(project_dir)

        refs = branches(repo)
        main_branch = default_branch(repo, refs)
        if a.branch:
            refs = [(n, r) for n, r in refs if n in a.branch]
        # default branch first, the rest by name
        refs.sort(key=lambda nr: (nr[0] != main_branch, nr[0]))

        dates = git(repo, "log", "--all", "--format=%as").split()
        manifest = {
            "name": name,
            "title": a.title or name,
            "sector": a.sector,
            "summary": a.summary,
            "source": source,
            "kind": "demo" if a.demo else "source",
            "first": min(dates) if dates else None,
            "last": max(dates) if dates else None,
            "commits": int(git(repo, "rev-list", "--all", "--count").strip() or 0),
            "versions": [],
        }

        if a.demo:
            ref = dict(refs)[main_branch]
            paths = [p.strip() for p in a.demo.split(",") if p.strip()]
            export(repo, ref, os.path.join(project_dir, "demo"), paths)
            manifest["entry"] = "demo/" + (a.entry or "index.html")
            manifest["versions"].append(version_record(repo, main_branch, ref, "demo", project_dir))
        else:
            trees = {}
            for branch, ref in refs:
                tree = git(repo, "rev-parse", ref + "^{tree}").strip()
                vid = slug(branch)
                if tree in trees:
                    rec = version_record(repo, branch, ref, vid, None)
                    rec["same_as"] = trees[tree]
                    manifest["versions"].append(rec)
                    continue
                trees[tree] = vid
                export(repo, ref, os.path.join(project_dir, vid))
                manifest["versions"].append(version_record(repo, branch, ref, vid, project_dir))

        with open(os.path.join(project_dir, "history.txt"), "w") as f:
            f.write(git(repo, "log", "--all", "--date=short",
                        "--format=%h  %ad  %an  %s%d"))
        with open(os.path.join(project_dir, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=1, ensure_ascii=False)
            f.write("\n")

        filed = [v for v in manifest["versions"] if not v.get("same_as")]
        print(f"filed {name} in {a.sector}: {len(filed)} version(s), "
              f"{sum(len(v['files']) for v in filed)} files")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def version_record(repo, branch, ref, vid, project_dir):
    sha, date, subject = git(repo, "log", "-1", "--format=%h%x00%as%x00%s", ref).split("\0")
    rec = {
        "id": vid,
        "branch": branch,
        "head": sha,
        "date": date,
        "message": subject.strip(),
        "commits": int(git(repo, "rev-list", "--count", ref).strip()),
    }
    rec["files"] = listing(os.path.join(project_dir, vid)) if project_dir else []
    return rec


if __name__ == "__main__":
    main()
