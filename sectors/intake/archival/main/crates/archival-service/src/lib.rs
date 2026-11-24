//! the archival api. every front end sends `call(method, params)` and gets json back, so the
//! desktop app, the cli and the mcp server behave the same.

mod assistant;
mod connectors;
mod files;
mod git;
mod github;
mod jobs;
mod run;
mod shelf;
mod watch;

use anyhow::{anyhow, Result};
use archival_core::Vault;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

pub use jobs::Job;

#[derive(Clone)]
pub struct Service {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    vault: RwLock<Arc<Vault>>,
    pub(crate) runs: archival_run::Supervisor,
    pub(crate) jobs: Mutex<Vec<Job>>,
    pub(crate) watchers: Mutex<std::collections::HashMap<String, notify::RecommendedWatcher>>,
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

impl Service {
    /// open the vault at `root`, or the configured / default location.
    pub fn open(root: Option<PathBuf>) -> Result<Service> {
        let root = root.unwrap_or_else(archival_core::vault::default_root);
        let vault = Vault::open(&root)?;
        let svc = Service {
            inner: Arc::new(Inner {
                vault: RwLock::new(Arc::new(vault)),
                runs: archival_run::Supervisor::new(),
                jobs: Mutex::new(Vec::new()),
                watchers: Mutex::new(Default::default()),
            }),
        };
        Ok(svc)
    }

    /// start background watchers for connectors that mirror folders. needs a tokio runtime.
    pub fn start_background(&self) {
        watch::start_all(self);
    }

    pub fn vault(&self) -> Arc<Vault> {
        self.inner.vault.read().unwrap().clone()
    }

    pub(crate) fn swap_vault(&self, v: Vault) {
        *self.inner.vault.write().unwrap() = Arc::new(v);
    }

    pub fn runs(&self) -> &archival_run::Supervisor {
        &self.inner.runs
    }

    pub fn shutdown(&self) {
        self.inner.runs.stop_all();
        self.inner.watchers.lock().unwrap().clear();
    }

    /// the whole api. errors come back as plain sentences.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let params = if params.is_null() { json!({}) } else { params };
        if let Some(r) = self.call_async(method, &params).await {
            return r;
        }
        let svc = self.clone();
        let m = method.to_string();
        tokio::task::spawn_blocking(move || svc.call_sync(&m, &params)).await.map_err(|e| anyhow!("internal error: {e}"))?
    }

    async fn call_async(&self, method: &str, p: &Value) -> Option<Result<Value>> {
        let r = match method {
            "ingest.url" => jobs::ingest_url(self, p),
            "github.accounts" | "github.add_token" | "github.remove" | "github.set_default" | "github.device_start" | "github.device_poll"
            | "github.repos" | "github.publish" | "github.open_pr" | "github.prs" | "github.clone" => github::call(self, method, p).await,
            "git.push" | "git.pull" | "git.ship" => git::call_async(self, method, p).await,
            "connectors.add" | "connectors.test" | "connectors.browse" | "connectors.pull" | "connectors.push" | "connectors.sync" => {
                connectors::call_async(self, method, p).await
            }
            "assistant.commit_message" | "assistant.pr_description" | "assistant.describe" | "assistant.configure" => {
                assistant::call(self, method, p).await
            }
            _ => return None,
        };
        Some(r)
    }

    fn call_sync(&self, method: &str, p: &Value) -> Result<Value> {
        let (group, _) = method.split_once('.').unwrap_or((method, ""));
        match group {
            "app" | "vault" | "settings" | "tree" | "file" | "items" | "item" | "inbox" | "trash" | "snapshot" | "search" | "history" | "mcp" => {
                files::call(self, method, p)
            }
            "ingest" | "jobs" => jobs::call(self, method, p),
            "git" => git::call(self, method, p),
            "github" => github::call_sync(self, method, p),
            "run" => run::call(self, method, p),
            "connectors" => connectors::call(self, method, p),
            "shelf" => shelf::call(self, method, p),
            "assistant" => assistant::call_sync(self, method, p),
            _ => Err(anyhow!("unknown method {method}")),
        }
    }
}

// param helpers

pub(crate) fn s(p: &Value, k: &str) -> Result<String> {
    p.get(k).and_then(|v| v.as_str()).map(|v| v.to_string()).ok_or_else(|| anyhow!("missing {k}"))
}
pub(crate) fn os(p: &Value, k: &str) -> Option<String> {
    p.get(k).and_then(|v| v.as_str()).map(|v| v.to_string()).filter(|v| !v.is_empty())
}
pub(crate) fn b(p: &Value, k: &str) -> bool {
    p.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}
pub(crate) fn n(p: &Value, k: &str) -> Option<u64> {
    p.get(k).and_then(|v| v.as_u64())
}
pub(crate) fn strs(p: &Value, k: &str) -> Vec<String> {
    p.get(k).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}
pub(crate) fn to(v: impl serde::Serialize) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

/// absolute folder of an item (a file item's folder is its parent)
pub(crate) fn item_dir(v: &Vault, id: &str) -> Result<(archival_core::Item, PathBuf)> {
    let it = v.item(id)?;
    let abs = v.abs(&it.path)?;
    let dir = if abs.is_file() { abs.parent().unwrap().to_path_buf() } else { abs };
    Ok((it, dir))
}

#[cfg(test)]
mod tests;
