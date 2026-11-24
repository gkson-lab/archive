//! snapshots: a manifest of (path, blake3 hash) for every file of an item at a point in time.
//! file contents live in the object store, so unchanged files cost nothing extra.

use crate::objects::ObjectStore;
use crate::paths::relative;
use crate::tree::walk_files;
use crate::{Manifest, ManifestEntry, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub fn capture(store: &ObjectStore, root: &Path) -> Result<Manifest> {
    let mut files = Vec::new();
    let base = if root.is_file() { root.parent().unwrap_or(root) } else { root };
    for f in walk_files(root) {
        let meta = match fs::metadata(&f) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let hash = store.put_file(&f)?;
        files.push(ManifestEntry { path: relative(base, &f), hash, size: meta.len(), exec: is_exec(&meta) });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Manifest { files })
}

/// hash only, without storing. used for duplicate detection.
pub fn fingerprint(root: &Path) -> Result<String> {
    let base = if root.is_file() { root.parent().unwrap_or(root) } else { root };
    let mut entries: Vec<(String, String)> = Vec::new();
    for f in walk_files(root) {
        entries.push((relative(base, &f), ObjectStore::hash_file(&f)?));
    }
    entries.sort();
    let mut h = blake3::Hasher::new();
    for (p, x) in entries {
        h.update(p.as_bytes());
        h.update(&[0]);
        h.update(x.as_bytes());
        h.update(&[0]);
    }
    Ok(h.finalize().to_hex().to_string())
}

#[cfg(unix)]
fn is_exec(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn is_exec(_m: &fs::Metadata) -> bool {
    false
}

#[derive(Debug, Serialize, Default)]
pub struct Changes {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
}

/// what changed in `root` compared to `manifest`. added = new since the snapshot.
pub fn changes(manifest: &Manifest, root: &Path) -> Result<Changes> {
    let base = if root.is_file() { root.parent().unwrap_or(root) } else { root };
    let mut snap: HashMap<&str, &str> = manifest.files.iter().map(|e| (e.path.as_str(), e.hash.as_str())).collect();
    let mut out = Changes::default();
    for f in walk_files(root) {
        let rel = relative(base, &f);
        match snap.remove(rel.as_str()) {
            None => out.added.push(rel),
            Some(h) => {
                if ObjectStore::hash_file(&f)? != h {
                    out.modified.push(rel)
                }
            }
        }
    }
    out.deleted = snap.keys().map(|s| s.to_string()).collect();
    out.added.sort();
    out.modified.sort();
    out.deleted.sort();
    Ok(out)
}

/// make `root` match `manifest`. files not in the manifest (and not ignored) are removed.
pub fn restore(store: &ObjectStore, manifest: &Manifest, root: &Path, single_file: bool) -> Result<()> {
    let base = if single_file { root.parent().unwrap_or(root).to_path_buf() } else { root.to_path_buf() };
    let wanted: HashMap<&str, &ManifestEntry> = manifest.files.iter().map(|e| (e.path.as_str(), e)).collect();
    if root.exists() {
        for f in walk_files(root) {
            let rel = relative(&base, &f);
            if !wanted.contains_key(rel.as_str()) {
                fs::remove_file(&f)?;
            }
        }
    }
    for e in &manifest.files {
        let dest = base.join(&e.path);
        if dest.exists() && ObjectStore::hash_file(&dest)? == e.hash {
            continue;
        }
        store.write_to(&e.hash, &dest)?;
        #[cfg(unix)]
        if e.exec {
            use std::os::unix::fs::PermissionsExt;
            let mut p = fs::metadata(&dest)?.permissions();
            p.set_mode(p.mode() | 0o755);
            fs::set_permissions(&dest, p)?;
        }
    }
    if !single_file {
        remove_empty_dirs(root);
    }
    Ok(())
}

fn remove_empty_dirs(root: &Path) {
    let mut dirs: Vec<_> = walkdir::WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| e.file_name() != ".git")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir())
        .map(|e| e.into_path())
        .collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = fs::remove_dir(&d);
    }
}
