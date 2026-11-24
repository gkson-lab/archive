use crate::{Error, Result};
use std::path::{Component, Path, PathBuf};

/// turn a vault-relative path ("projects/windsim/src") into an absolute path under `base`,
/// refusing anything that would escape it.
pub fn resolve(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.trim_start_matches('/').replace('\\', "/");
    let mut out = base.to_path_buf();
    for part in Path::new(&rel).components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err(Error::OutsideVault(rel.clone())),
        }
    }
    Ok(out)
}

/// path of `abs` relative to `base`, forward slashes.
pub fn relative(base: &Path, abs: &Path) -> String {
    abs.strip_prefix(base)
        .unwrap_or(abs)
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{}/{}", a.trim_end_matches('/'), b.trim_start_matches('/')),
    }
}

/// pick a name inside `dir` that doesn't exist yet: name, name-2, name-3 ...
pub fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2.. {
        let candidate = format!("{stem}-{n}{ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// filesystem-safe slug that keeps a readable shape.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_. ".contains(c) { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "untitled".into()
    } else {
        trimmed.chars().take(96).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_escape() {
        let base = Path::new("/v");
        assert!(resolve(base, "../etc").is_err());
        assert!(resolve(base, "a/../../b").is_err());
        assert_eq!(resolve(base, "a/b").unwrap(), PathBuf::from("/v/a/b"));
    }
}
