use crate::util::blocking;
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::{anyhow, Result};
use archival_core::Vault;
use archival_ingest::{ingest_path, no_progress, Ingested, Origin};
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Arc;

pub struct LocalFolder {
    pub path: PathBuf,
    pub watch: bool,
}

impl LocalFolder {
    pub fn new(path: String, watch: bool) -> Self {
        Self { path: expand(&path), watch }
    }
}

pub fn expand(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(h) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(h).join(rest);
        }
    }
    PathBuf::from(p)
}

pub fn list_local(base: &std::path::Path, folder: Option<String>) -> Result<Page> {
    let dir = match folder {
        Some(f) => {
            let p = PathBuf::from(&f);
            if !p.starts_with(base) {
                return Err(anyhow!("outside the connected folder"));
            }
            p
        }
        None => base.to_path_buf(),
    };
    let mut entries = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| anyhow!("can't read {}: {e}", dir.display()))? {
        let e = e?;
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || archival_core::tree::is_default_ignored(&name) {
            continue;
        }
        let m = e.metadata()?;
        entries.push(RemoteEntry {
            id: e.path().to_string_lossy().to_string(),
            name,
            kind: if m.is_dir() { "dir".into() } else { "file".into() },
            size: if m.is_dir() { None } else { Some(m.len()) },
            updated: m.modified().ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),
            description: None,
            browsable: m.is_dir(),
        });
    }
    entries.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(Page { entries, next: None })
}

#[async_trait]
impl Connector for LocalFolder {
    fn id(&self) -> &str {
        "local-folder"
    }
    async fn auth(&self) -> Result<AuthState> {
        Ok(AuthState { ok: self.path.is_dir(), who: Some(self.path.to_string_lossy().to_string()) })
    }
    async fn list(&self, folder: Option<String>, _page: Option<String>) -> Result<Page> {
        list_local(&self.path, folder)
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        let src = PathBuf::from(&entry.id);
        if !src.starts_with(&self.path) {
            return Err(anyhow!("outside the connected folder"));
        }
        blocking(move || {
            let origin = Origin { connector: "local-folder".into(), source: src.to_string_lossy().to_string(), title: None };
            ingest_path(&v, &src, &origin, &no_progress)
        })
        .await
    }
    fn watch_path(&self) -> Option<PathBuf> {
        if self.watch {
            Some(self.path.clone())
        } else {
            None
        }
    }
}
