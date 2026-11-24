use crate::local::{expand, list_local};
use crate::util::blocking;
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::{anyhow, Result};
use archival_core::Vault;
use archival_ingest::{ingest_path, no_progress, Ingested, Origin};
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Arc;

/// a folder where ai coding agents leave their output. each subfolder is a candidate project.
pub struct AgentWorkspace {
    pub path: PathBuf,
}

impl AgentWorkspace {
    pub fn new(path: String) -> Self {
        Self { path: expand(&path) }
    }
}

#[async_trait]
impl Connector for AgentWorkspace {
    fn id(&self) -> &str {
        "agent-workspace"
    }
    async fn auth(&self) -> Result<AuthState> {
        Ok(AuthState { ok: self.path.is_dir(), who: Some(self.path.to_string_lossy().to_string()) })
    }
    async fn list(&self, folder: Option<String>, _page: Option<String>) -> Result<Page> {
        let mut p = list_local(&self.path, folder)?;
        for e in &mut p.entries {
            if e.kind == "dir" {
                e.kind = "repo".into();
                e.description = Some(describe(&PathBuf::from(&e.id)));
            }
        }
        Ok(p)
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        let src = PathBuf::from(&entry.id);
        if !src.starts_with(&self.path) {
            return Err(anyhow!("outside the workspace"));
        }
        blocking(move || {
            let origin = Origin { connector: "agent-workspace".into(), source: src.to_string_lossy().to_string(), title: None };
            ingest_path(&v, &src, &origin, &no_progress)
        })
        .await
    }
    fn watch_path(&self) -> Option<PathBuf> {
        Some(self.path.clone())
    }
}

fn describe(dir: &std::path::Path) -> String {
    let s = archival_core::classify::suggest(dir);
    let mut out = s.kind.as_str().to_string();
    if !s.tags.is_empty() {
        out.push_str(" · ");
        out.push_str(&s.tags.join(", "));
    }
    out
}
