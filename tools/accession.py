#!/usr/bin/env python3
"""accession: file a project into the archive.

every branch of a git repo becomes a version under
sectors/<sector>/<project>/<version>/, as a full copy of its files.
open pull requests are filed too, as pr-<number>. branches whose files
match a version already filed are recorded as "same as" instead of
being copied twice. commits and pull requests go to activity.json.

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
  --no-pulls         don't ask github for pull requests

pull requests come from the github api through the gh cli, so gh has
to be signed in (in actions, GH_TOKEN does that). without it the shelf
is still filed, just without pull requests.

after filing, run tools/catalog.py to rebuild catalog.json.
"""

import argparse
import hashlib
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


def github_repo(url):
    m = re.match(r"(?:https://github\.com/|git@github\.com:)([^/]+)/([^/]+?)(?:\.git)?/?$", url or "")
    return f"{m.group(1)}/{m.group(2)}" if m else None


def gh_api(path):
    """a list from the github rest api, every page, or None when gh can't reach it."""
    try:
        out = subprocess.run(
            ["gh", "api", "--paginate", "-H", "Accept: application/vnd.github+json",
             "--jq", ".[] | tojson", path],
            check=True, capture_output=True, text=True, timeout=120,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def fetch_pulls(repo_slug):
    raw = gh_api(f"repos/{repo_slug}/pulls?state=all&per_page=100")
    if raw is None:
        return None
    pulls = []
    for p in raw:
        pulls.append({
            "number": p["number"],
            "title": p["title"],
            "state": "merged" if p.get("merged_at") else p["state"],
            "draft": bool(p.get("draft")),
            "author": (p.get("user") or {}).get("login"),
            "head": (p.get("head") or {}).get("ref"),
            "base": (p.get("base") or {}).get("ref"),
            "sha": (p.get("head") or {}).get("sha"),
            "created": p.get("created_at"),
            "updated": p.get("updated_at"),
            "closed": p.get("closed_at"),
            "merged": p.get("merged_at"),
            "url": p.get("html_url"),
        })
    pulls.sort(key=lambda p: p["number"], reverse=True)
    return pulls


def remote_heads(url):
    """{branch: sha} for every branch on the remote, without cloning."""
    out = subprocess.run(["git", "ls-remote", "--heads", url], check=True,
                         capture_output=True, text=True, timeout=120).stdout
    heads = {}
    for line in out.splitlines():
        sha, ref = line.split("\t")
        heads[ref[len("refs/heads/"):]] = sha
    return heads


def signature(heads, pulls, demo_branch=None):
    """a fingerprint of everything that would change a shelf."""
    if demo_branch:
        heads = {demo_branch: heads.get(demo_branch)}
    parts = sorted(f"b {k} {v}" for k, v in heads.items())
    parts += sorted(f"p {p['number']} {p['state']} {p['sha']} {p['updated']}" for p in (pulls or []))
    return hashlib.sha1("\n".join(parts).encode()).hexdigest()


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


def commits(repo):
    out = git(repo, "log", "--all", "--format=%H%x00%aI%x00%an%x00%s%x00%D%x1e")
    rows = []
    for rec in out.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        sha, date, author, subject, refs = rec.split("\x00")
        tips = [r.strip().split("origin/", 1)[-1] for r in refs.split(",")
                if r.strip().startswith("origin/") and not r.strip().endswith("/HEAD")]
        rows.append({"sha": sha, "date": date, "author": author, "message": subject, "tips": tips})
    return rows


def accession(repo_arg, sector, name=None, title=None, summary="", only=None,
              demo=None, entry=None, keep_source=None, pulls=True, quiet=False):
    sector_dir = os.path.join(SECTORS, sector)
    if not os.path.isfile(os.path.join(sector_dir, "sector.json")):
        raise SystemExit(f"no sector called '{sector}'. make sectors/{sector}/sector.json first.")

    work = tempfile.mkdtemp(prefix="accession-")
    try:
        if os.path.isdir(repo_arg):
            repo = os.path.abspath(repo_arg)
            source = keep_source or git(repo, "remote", "get-url", "origin").strip()
        else:
            repo = os.path.join(work, "repo")
            subprocess.run(["git", "clone", "-q", "--no-checkout", repo_arg, repo], check=True)
            source = keep_source or repo_arg
        source = re.sub(r"\.git$", "", source)
        slug_repo = github_repo(source)

        name = name or os.path.basename(source)
        final_dir = os.path.join(sector_dir, name)
        # build next to the old shelf and swap at the end, so a failure leaves the old one alone
        project_dir = final_dir + ".incoming"

        pull_list = fetch_pulls(slug_repo) if (pulls and slug_repo) else None
        if pull_list is None:
            # keep what we knew before rather than forgetting every pull request
            old = os.path.join(final_dir, "activity.json")
            if os.path.isfile(old):
                with open(old, encoding="utf-8") as f:
                    pull_list = json.load(f).get("pulls")
        open_pulls = [p for p in (pull_list or []) if p["state"] == "open"]

        # open pull requests become versions too, forks included
        if not demo:
            for p in open_pulls:
                try:
                    git(repo, "fetch", "-q", "origin",
                        f"+refs/pull/{p['number']}/head:refs/remotes/origin/pr/{p['number']}")
                except subprocess.CalledProcessError:
                    pass

        if os.path.exists(project_dir):
            shutil.rmtree(project_dir)
        os.makedirs(project_dir)

        refs = branches(repo)
        main_branch = default_branch(repo, refs)
        if only:
            refs = [(n, r) for n, r in refs if n in only]
        pr_refs = [(n, r) for n, r in refs if n.startswith("pr/")]
        refs = [(n, r) for n, r in refs if not n.startswith("pr/")]
        refs.sort(key=lambda nr: (nr[0] != main_branch, nr[0]))
        pr_refs.sort(key=lambda nr: -int(nr[0][3:]))

        heads = {n: git(repo, "rev-parse", r).strip() for n, r in refs}
        dates = git(repo, "log", "--all", "--format=%as").split()
        manifest = {
            "name": name,
            "title": title or name,
            "sector": sector,
            "summary": summary,
            "source": source,
            "repo": slug_repo,
            "kind": "demo" if demo else "source",
            "first": min(dates) if dates else None,
            "last": max(dates) if dates else None,
            "commits": int(git(repo, "rev-list", "--all", "--count").strip() or 0),
            "pulls": {
                "open": len(open_pulls),
                "total": len(pull_list or []),
            },
            "signature": signature(heads, pull_list, main_branch if demo else None),
            "versions": [],
        }

        if demo:
            ref = dict(refs)[main_branch]
            paths = [p.strip() for p in demo.split(",") if p.strip()]
            export(repo, ref, os.path.join(project_dir, "demo"), paths)
            manifest["entry"] = "demo/" + (entry or "index.html")
            manifest["demo_paths"] = paths
            manifest["versions"].append(version_record(repo, main_branch, ref, "demo", project_dir))
        else:
            trees = {}
            by_number = {p["number"]: p for p in open_pulls}
            for branch, ref in refs + pr_refs:
                tree = git(repo, "rev-parse", ref + "^{tree}").strip()
                vid = slug(branch)
                rec = version_record(repo, branch, ref, vid, None)
                if branch.startswith("pr/"):
                    p = by_number.get(int(branch[3:]))
                    if p:
                        rec["pull"] = {"number": p["number"], "title": p["title"], "author": p["author"], "url": p["url"]}
                        rec["branch"] = f"pr #{p['number']}"
                if tree in trees:
                    rec["same_as"] = trees[tree]
                    manifest["versions"].append(rec)
                    continue
                trees[tree] = vid
                export(repo, ref, os.path.join(project_dir, vid))
                rec["files"] = listing(os.path.join(project_dir, vid))
                manifest["versions"].append(rec)

        with open(os.path.join(project_dir, "history.txt"), "w", encoding="utf-8") as f:
            f.write(git(repo, "log", "--all", "--date=short",
                        "--format=%h  %ad  %an  %s%d"))
        with open(os.path.join(project_dir, "activity.json"), "w", encoding="utf-8") as f:
            json.dump({"commits": commits(repo), "pulls": pull_list or []}, f, indent=1, ensure_ascii=False)
            f.write("\n")
        with open(os.path.join(project_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=1, ensure_ascii=False)
            f.write("\n")

        if os.path.exists(final_dir):
            shutil.rmtree(final_dir)
        os.rename(project_dir, final_dir)

        filed = [v for v in manifest["versions"] if not v.get("same_as")]
        if not quiet:
            print(f"filed {name} in {sector}: {len(filed)} version(s), "
                  f"{sum(len(v['files']) for v in filed)} files, "
                  f"{manifest['pulls']['total']} pull request(s)")
        return manifest
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if os.path.exists(project_dir):
            shutil.rmtree(project_dir, ignore_errors=True)


def version_record(repo, branch, ref, vid, project_dir):
    sha, date, subject = git(repo, "log", "-1", "--format=%H%x00%as%x00%s", ref).split("\0")
    rec = {
        "id": vid,
        "branch": branch,
        "head": sha[:7],
        "sha": sha,
        "date": date,
        "message": subject.strip(),
        "commits": int(git(repo, "rev-list", "--count", ref).strip()),
    }
    rec["files"] = listing(os.path.join(project_dir, vid)) if project_dir else []
    return rec


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
    ap.add_argument("--no-pulls", action="store_true")
    a = ap.parse_args()
    accession(a.repo, a.sector, a.name, a.title, a.summary, a.branch,
              a.demo, a.entry, a.keep_source, not a.no_pulls)


if __name__ == "__main__":
    sys.exit(main())
