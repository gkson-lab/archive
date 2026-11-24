//! git for vault items, through libgit2 so a system git isn't required.

use anyhow::{anyhow, Context, Result};
use git2::{
    BranchType, Cred, CredentialType, Delta, DiffFormat, DiffOptions, FetchOptions, IndexAddOption, PushOptions,
    RemoteCallbacks, Repository, RepositoryInitOptions, Signature, Status, StatusOptions,
};
use serde::Serialize;
use std::cell::Cell;
use std::path::Path;

// vendored libgit2 on windows needs the registry and security apis from advapi32
#[cfg(windows)]
#[link(name = "advapi32")]
extern "system" {}

#[derive(Debug, Clone, Default)]
pub struct Auth {
    /// https token (github etc.). ssh remotes use the ssh agent.
    pub token: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FileStatus {
    pub path: String,
    /// "added" | "modified" | "deleted" | "renamed" | "typechange" | ""
    pub staged: String,
    pub unstaged: String,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Serialize)]
pub struct RepoStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<FileStatus>,
    pub merging: bool,
    pub remotes: Vec<RemoteInfo>,
}

#[derive(Debug, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    /// '+', '-', ' '
    pub origin: char,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub status: String,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Serialize)]
pub struct Commit {
    pub id: String,
    pub short: String,
    pub summary: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub time: i64,
}

#[derive(Debug, Serialize)]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

#[derive(Debug, Serialize)]
pub struct PullResult {
    /// "up-to-date" | "fast-forward" | "merged" | "conflicts"
    pub outcome: String,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ConflictFile {
    pub path: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

pub fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

pub fn open(dir: &Path) -> Result<Repository> {
    Repository::open(dir).with_context(|| format!("{} isn't a git repository yet", dir.display()))
}

pub fn init(dir: &Path) -> Result<()> {
    let mut o = RepositoryInitOptions::new();
    o.initial_head("main");
    Repository::init_opts(dir, &o)?;
    Ok(())
}

fn delta_name(d: Delta) -> &'static str {
    match d {
        Delta::Added | Delta::Untracked => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        _ => "",
    }
}

pub fn status(dir: &Path) -> Result<RepoStatus> {
    if !is_repo(dir) {
        return Ok(RepoStatus {
            is_repo: false,
            branch: None,
            head: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![],
            merging: false,
            remotes: vec![],
        });
    }
    let repo = open(dir)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).renames_head_to_index(true);
    let mut files = Vec::new();
    for e in repo.statuses(Some(&mut opts))?.iter() {
        let s = e.status();
        let path = e.path().unwrap_or("").to_string();
        let staged = if s.contains(Status::INDEX_NEW) {
            "added"
        } else if s.contains(Status::INDEX_MODIFIED) {
            "modified"
        } else if s.contains(Status::INDEX_DELETED) {
            "deleted"
        } else if s.contains(Status::INDEX_RENAMED) {
            "renamed"
        } else if s.contains(Status::INDEX_TYPECHANGE) {
            "typechange"
        } else {
            ""
        };
        let unstaged = if s.contains(Status::WT_MODIFIED) {
            "modified"
        } else if s.contains(Status::WT_DELETED) {
            "deleted"
        } else if s.contains(Status::WT_RENAMED) {
            "renamed"
        } else if s.contains(Status::WT_TYPECHANGE) {
            "typechange"
        } else if s.contains(Status::WT_NEW) {
            "added"
        } else {
            ""
        };
        if s.contains(Status::IGNORED) {
            continue;
        }
        files.push(FileStatus {
            path,
            staged: staged.into(),
            unstaged: unstaged.into(),
            untracked: s.contains(Status::WT_NEW),
            conflicted: s.contains(Status::CONFLICTED),
        });
    }
    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand().map(|s| s.to_string())).or_else(|| {
        // unborn branch: read HEAD's symbolic target
        repo.find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(|t| t.trim_start_matches("refs/heads/").to_string()))
    });
    let head_id = head.as_ref().and_then(|h| h.target()).map(|o| o.to_string());
    let (mut upstream, mut ahead, mut behind) = (None, 0, 0);
    if let Some(b) = branch.as_ref().and_then(|b| repo.find_branch(b, BranchType::Local).ok()) {
        if let Ok(up) = b.upstream() {
            upstream = up.name().ok().flatten().map(|s| s.to_string());
            if let (Some(l), Some(r)) = (b.get().target(), up.get().target()) {
                if let Ok((a, bh)) = repo.graph_ahead_behind(l, r) {
                    ahead = a;
                    behind = bh;
                }
            }
        }
    }
    let remotes = remotes(&repo);
    Ok(RepoStatus {
        is_repo: true,
        branch,
        head: head_id,
        upstream,
        ahead,
        behind,
        files,
        merging: repo.state() == git2::RepositoryState::Merge,
        remotes,
    })
}

fn remotes(repo: &Repository) -> Vec<RemoteInfo> {
    repo.remotes()
        .map(|names| {
            names
                .iter()
                .flatten()
                .filter_map(|n| repo.find_remote(n).ok().map(|r| RemoteInfo { name: n.into(), url: r.url().unwrap_or("").into() }))
                .collect()
        })
        .unwrap_or_default()
}

/// diff of the working tree (staged=false) or the index (staged=true), optionally for one path.
pub fn diff(dir: &Path, path: Option<&str>, staged: bool) -> Result<Vec<FileDiff>> {
    let repo = open(dir)?;
    let mut o = DiffOptions::new();
    o.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true).context_lines(3);
    if let Some(p) = path {
        o.pathspec(p);
    }
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let d = if staged {
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut o))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut o))?
    };
    let mut files: Vec<FileDiff> = Vec::new();
    d.print(DiffFormat::Patch, |delta, hunk, line| {
        let p = delta.new_file().path().or(delta.old_file().path()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if files.last().map(|f| f.path != p).unwrap_or(true) {
            files.push(FileDiff {
                path: p,
                status: delta_name(delta.status()).into(),
                binary: delta.flags().is_binary(),
                hunks: vec![],
            });
        }
        let f = files.last_mut().unwrap();
        match line.origin() {
            'H' => {
                f.hunks.push(Hunk { header: String::from_utf8_lossy(line.content()).trim_end().to_string(), lines: vec![] });
            }
            '+' | '-' | ' ' => {
                if f.hunks.is_empty() {
                    let h = hunk.map(|h| String::from_utf8_lossy(h.header()).trim_end().to_string()).unwrap_or_default();
                    f.hunks.push(Hunk { header: h, lines: vec![] });
                }
                f.hunks.last_mut().unwrap().lines.push(DiffLine {
                    origin: line.origin(),
                    old: line.old_lineno(),
                    new: line.new_lineno(),
                    text: String::from_utf8_lossy(line.content()).trim_end_matches(['\n', '\r']).to_string(),
                });
            }
            'B' => f.binary = true,
            _ => {}
        }
        true
    })?;
    Ok(files)
}

pub fn stage(dir: &Path, paths: &[String]) -> Result<()> {
    let repo = open(dir)?;
    let mut idx = repo.index()?;
    for p in paths {
        if dir.join(p).exists() {
            idx.add_path(Path::new(p))?;
        } else {
            idx.remove_path(Path::new(p))?;
        }
    }
    idx.write()?;
    Ok(())
}

pub fn stage_all(dir: &Path) -> Result<()> {
    let repo = open(dir)?;
    let mut idx = repo.index()?;
    idx.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    idx.update_all(["*"].iter(), None)?;
    idx.write()?;
    Ok(())
}

pub fn unstage(dir: &Path, paths: &[String]) -> Result<()> {
    let repo = open(dir)?;
    match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(c) => repo.reset_default(Some(c.as_object()), paths.iter())?,
        None => {
            let mut idx = repo.index()?;
            for p in paths {
                let _ = idx.remove_path(Path::new(p));
            }
            idx.write()?;
        }
    }
    Ok(())
}

/// throw away working tree changes to one file
pub fn discard(dir: &Path, path: &str) -> Result<()> {
    let repo = open(dir)?;
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force().path(path);
    repo.checkout_head(Some(&mut cb))?;
    Ok(())
}

pub fn signature<'a>(repo: &Repository, name: Option<&str>, email: Option<&str>) -> Result<Signature<'a>> {
    if let (Some(n), Some(e)) = (name, email) {
        return Ok(Signature::now(n, e)?);
    }
    repo.signature().or_else(|_| Signature::now(name.unwrap_or("archival"), email.unwrap_or("archival@localhost"))).map_err(Into::into)
}

/// commit what's staged. while merging, the commit gets both parents and the merge is finished.
pub fn commit(dir: &Path, message: &str, name: Option<&str>, email: Option<&str>) -> Result<String> {
    if message.trim().is_empty() {
        return Err(anyhow!("write a commit message first"));
    }
    let repo = open(dir)?;
    let mut idx = repo.index()?;
    if idx.has_conflicts() {
        return Err(anyhow!("resolve the conflicted files before committing"));
    }
    let tree_id = idx.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let sig = signature(&repo, name, email)?;
    let mut parents = Vec::new();
    if let Ok(h) = repo.head() {
        parents.push(h.peel_to_commit()?);
    }
    if repo.state() == git2::RepositoryState::Merge {
        let mut oids = Vec::new();
        open(dir)?.mergehead_foreach(|oid| {
            oids.push(*oid);
            true
        })?;
        for oid in oids {
            parents.push(repo.find_commit(oid)?);
        }
    }
    if parents.len() == 1 && parents[0].tree_id() == tree_id {
        return Err(anyhow!("nothing staged to commit"));
    }
    let refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &refs)?;
    if repo.state() == git2::RepositoryState::Merge {
        repo.cleanup_state()?;
    }
    Ok(oid.to_string())
}

pub fn log(dir: &Path, limit: usize) -> Result<Vec<Commit>> {
    let repo = open(dir)?;
    let mut walk = repo.revwalk()?;
    if walk.push_head().is_err() {
        return Ok(vec![]);
    }
    walk.set_sorting(git2::Sort::TIME)?;
    let mut out = Vec::new();
    for oid in walk.take(limit) {
        let c = repo.find_commit(oid?)?;
        let id = c.id().to_string();
        out.push(Commit {
            short: id[..7].to_string(),
            id,
            summary: c.summary().unwrap_or("").to_string(),
            message: c.message().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            email: c.author().email().unwrap_or("").to_string(),
            time: c.time().seconds() * 1000,
        });
    }
    Ok(out)
}

pub fn branches(dir: &Path) -> Result<Vec<Branch>> {
    let repo = open(dir)?;
    let mut out = Vec::new();
    for b in repo.branches(None)? {
        let (b, t) = b?;
        let name = b.name()?.unwrap_or("").to_string();
        if name.ends_with("/HEAD") {
            continue;
        }
        out.push(Branch { current: b.is_head(), remote: t == BranchType::Remote, name });
    }
    Ok(out)
}

pub fn checkout(dir: &Path, name: &str, create: bool) -> Result<()> {
    let repo = open(dir)?;
    if create {
        let head = repo.head()?.peel_to_commit().context("make a first commit before branching")?;
        repo.branch(name, &head, false)?;
    } else if repo.find_branch(name, BranchType::Local).is_err() {
        // track a remote branch of the same name
        let remote = repo.find_branch(&format!("origin/{name}"), BranchType::Remote)?;
        let c = remote.get().peel_to_commit()?;
        let mut b = repo.branch(name, &c, false)?;
        b.set_upstream(Some(&format!("origin/{name}")))?;
    }
    let refname = format!("refs/heads/{name}");
    let obj = repo.revparse_single(&refname)?;
    repo.checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().safe()))?;
    repo.set_head(&refname)?;
    Ok(())
}

pub fn set_remote(dir: &Path, name: &str, url: &str) -> Result<()> {
    let repo = open(dir)?;
    if repo.find_remote(name).is_ok() {
        repo.remote_set_url(name, url)?;
    } else {
        repo.remote(name, url)?;
    }
    Ok(())
}

fn callbacks<'a>(auth: &'a Auth, tries: &'a Cell<u32>) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |url, user, allowed| {
        tries.set(tries.get() + 1);
        if tries.get() > 4 {
            return Err(git2::Error::from_str("authentication failed. check the account's token"));
        }
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(t) = &auth.token {
                return Cred::userpass_plaintext(auth.username.as_deref().unwrap_or("x-access-token"), t);
            }
        }
        if allowed.contains(CredentialType::SSH_KEY) {
            return Cred::ssh_key_from_agent(user.unwrap_or("git"));
        }
        if allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str(&format!("no credentials for {url}. sign in to the account in connectors")))
    });
    cb
}

pub fn push(dir: &Path, remote: &str, branch: Option<&str>, auth: &Auth) -> Result<String> {
    let repo = open(dir)?;
    let branch = match branch {
        Some(b) => b.to_string(),
        None => repo.head()?.shorthand().ok_or_else(|| anyhow!("detached head. check out a branch first"))?.to_string(),
    };
    let mut r = repo.find_remote(remote).with_context(|| format!("no remote called {remote}"))?;
    let tries = Cell::new(0);
    let rejected = std::cell::RefCell::new(None::<String>);
    let mut o = PushOptions::new();
    let mut cb = callbacks(auth, &tries);
    cb.push_update_reference(|refname, status| {
        if let Some(s) = status {
            *rejected.borrow_mut() = Some(format!("{refname}: {s}"));
        }
        Ok(())
    });
    o.remote_callbacks(cb);
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    r.push(&[spec.as_str()], Some(&mut o))?;
    drop(o);
    let rejected = rejected.borrow().clone();
    if let Some(e) = rejected {
        return Err(anyhow!("push rejected ({e}). pull first, then push again"));
    }
    // remember the upstream
    if let Ok(mut b) = repo.find_branch(&branch, BranchType::Local) {
        let _ = b.set_upstream(Some(&format!("{remote}/{branch}")));
    }
    Ok(branch)
}

pub fn fetch(repo: &Repository, remote: &str, auth: &Auth) -> Result<()> {
    let mut r = repo.find_remote(remote)?;
    let tries = Cell::new(0);
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(auth, &tries));
    r.fetch::<&str>(&[], Some(&mut fo), None)?;
    Ok(())
}

/// fetch then fast-forward. if histories diverged, merge and leave conflicts for the ui.
pub fn pull(dir: &Path, remote: &str, auth: &Auth) -> Result<PullResult> {
    let repo = open(dir)?;
    fetch(&repo, remote, auth)?;
    let branch = repo.head()?.shorthand().unwrap_or("main").to_string();
    let theirs_ref = repo
        .find_reference(&format!("refs/remotes/{remote}/{branch}"))
        .with_context(|| format!("{remote} has no branch {branch}"))?;
    let theirs = repo.reference_to_annotated_commit(&theirs_ref)?;
    let (analysis, _) = repo.merge_analysis(&[&theirs])?;
    if analysis.is_up_to_date() {
        return Ok(PullResult { outcome: "up-to-date".into(), conflicts: vec![] });
    }
    if analysis.is_fast_forward() {
        let mut head = repo.find_reference(&format!("refs/heads/{branch}"))?;
        head.set_target(theirs.id(), "fast-forward")?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().safe()))?;
        return Ok(PullResult { outcome: "fast-forward".into(), conflicts: vec![] });
    }
    repo.merge(&[&theirs], None, None)?;
    let idx = repo.index()?;
    if idx.has_conflicts() {
        let conflicts = idx
            .conflicts()?
            .filter_map(|c| c.ok())
            .filter_map(|c| c.our.or(c.their).or(c.ancestor))
            .map(|e| String::from_utf8_lossy(&e.path).to_string())
            .collect();
        return Ok(PullResult { outcome: "conflicts".into(), conflicts });
    }
    let msg = format!("merge {remote}/{branch}");
    commit(dir, &msg, None, None)?;
    Ok(PullResult { outcome: "merged".into(), conflicts: vec![] })
}

/// the three sides of a conflicted file, for the three-pane view.
pub fn conflict(dir: &Path, path: &str) -> Result<ConflictFile> {
    let repo = open(dir)?;
    let idx = repo.index()?;
    let blob = |e: Option<git2::IndexEntry>| -> Option<String> {
        e.and_then(|e| repo.find_blob(e.id).ok()).map(|b| String::from_utf8_lossy(b.content()).to_string())
    };
    for c in idx.conflicts()? {
        let c = c?;
        let p = c.our.as_ref().or(c.their.as_ref()).or(c.ancestor.as_ref()).map(|e| String::from_utf8_lossy(&e.path).to_string());
        if p.as_deref() == Some(path) {
            return Ok(ConflictFile { path: path.into(), base: blob(c.ancestor), ours: blob(c.our), theirs: blob(c.their) });
        }
    }
    Err(anyhow!("{path} isn't conflicted"))
}

/// write the chosen resolution and mark the file resolved.
pub fn resolve(dir: &Path, path: &str, content: &str) -> Result<()> {
    std::fs::write(dir.join(path), content)?;
    let repo = open(dir)?;
    let mut idx = repo.index()?;
    idx.add_path(Path::new(path))?;
    idx.write()?;
    Ok(())
}

pub fn abort_merge(dir: &Path) -> Result<()> {
    let repo = open(dir)?;
    let head = repo.head()?.peel_to_commit()?;
    repo.reset(head.as_object(), git2::ResetType::Hard, None)?;
    repo.cleanup_state()?;
    Ok(())
}

/// clone into `dest`. github urls use the token.
pub fn clone(url: &str, dest: &Path, auth: &Auth) -> Result<()> {
    let tries = Cell::new(0);
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(auth, &tries));
    let mut b = git2::build::RepoBuilder::new();
    b.fetch_options(fo);
    b.clone(url, dest).with_context(|| format!("couldn't clone {url}"))?;
    Ok(())
}

pub fn current_branch(dir: &Path) -> Option<String> {
    status(dir).ok().and_then(|s| s.branch)
}

/// "owner/repo" from a github remote url
pub fn github_slug(url: &str) -> Option<(String, String)> {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))
        .or_else(|| u.strip_prefix("git@github.com:"))
        .or_else(|| u.strip_prefix("ssh://git@github.com/"))?;
    let mut parts = rest.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner, repo))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn init_commit_diff_branch() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        init(p).unwrap();
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        let s = status(p).unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(s.files[0].untracked);
        stage_all(p).unwrap();
        commit(p, "first", Some("gk"), Some("gk@example.com")).unwrap();
        std::fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        let df = diff(p, None, false).unwrap();
        assert_eq!(df[0].path, "a.txt");
        assert!(df[0].hunks[0].lines.iter().any(|l| l.origin == '+' && l.text == "two"));
        stage(p, &["a.txt".into()]).unwrap();
        assert_eq!(status(p).unwrap().files[0].staged, "modified");
        unstage(p, &["a.txt".into()]).unwrap();
        assert_eq!(status(p).unwrap().files[0].staged, "");
        stage_all(p).unwrap();
        commit(p, "second", Some("gk"), Some("gk@example.com")).unwrap();
        assert_eq!(log(p, 10).unwrap().len(), 2);
        checkout(p, "feature", true).unwrap();
        assert_eq!(current_branch(p).as_deref(), Some("feature"));
        assert!(commit(p, "empty", None, None).is_err());
    }

    #[test]
    fn slugs() {
        assert_eq!(github_slug("git@github.com:gkson-lab/windsim.git"), Some(("gkson-lab".into(), "windsim".into())));
        assert_eq!(github_slug("https://github.com/a/b"), Some(("a".into(), "b".into())));
        assert_eq!(github_slug("https://gitlab.com/a/b"), None);
    }
}
