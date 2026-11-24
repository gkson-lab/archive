//! listing the vault as a tree, and walking item files with the default ignore list + .gitignore.

use crate::classify::ext_of;
use std::path::{Path, PathBuf};

/// folders that are almost never worth archiving or indexing.
pub const DEFAULT_IGNORES: &[&str] = &[
    "node_modules", "target", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache",
    ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".idea", "Pods", "DerivedData",
    ".DS_Store", "Thumbs.db", ".archival",
];

pub fn is_default_ignored(name: &str) -> bool {
    DEFAULT_IGNORES.contains(&name)
}

fn builder(root: &Path) -> ignore::WalkBuilder {
    let mut b = ignore::WalkBuilder::new(root);
    b.hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .parents(false)
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            n != ".git" && !is_default_ignored(&n)
        });
    b
}

/// all files under root (or root itself if it's a file), skipping ignored ones.
pub fn walk_files(root: &Path) -> impl Iterator<Item = PathBuf> {
    let root = root.to_path_buf();
    let single = if root.is_file() { Some(root.clone()) } else { None };
    let walker = if single.is_none() { Some(builder(&root).build()) } else { None };
    single.into_iter().chain(
        walker
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.into_path()),
    )
}

/// direct children of a directory, honoring ignores. dirs first, then by name.
pub fn list_dir(dir: &Path) -> std::io::Result<Vec<(PathBuf, std::fs::Metadata)>> {
    let mut out = Vec::new();
    for e in builder(dir).max_depth(Some(1)).build().filter_map(|e| e.ok()) {
        if e.depth() == 0 {
            continue;
        }
        if let Ok(m) = e.metadata() {
            out.push((e.into_path(), m));
        }
    }
    out.sort_by(|a, b| {
        b.1.is_dir()
            .cmp(&a.1.is_dir())
            .then_with(|| a.0.file_name().unwrap_or_default().to_ascii_lowercase().cmp(&b.0.file_name().unwrap_or_default().to_ascii_lowercase()))
    });
    Ok(out)
}

pub fn ext_string(p: &Path) -> String {
    ext_of(p)
}
