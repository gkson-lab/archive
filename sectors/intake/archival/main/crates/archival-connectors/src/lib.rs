//! connectors pull things into the vault from somewhere else, and some push back out.
//! every connector implements one trait; secrets come from the os keychain.

mod agent;
mod dropbox;
mod figma;
mod gdrive;
mod git;
mod github;
mod local;
mod notion;
mod s3;
mod util;

use anyhow::{anyhow, Result};
use archival_core::{Item, Vault};
use archival_ingest::Ingested;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub id: String,
    pub name: String,
    /// "dir" | "file" | "repo" | "gist" | "page" | "design"
    pub kind: String,
    pub size: Option<u64>,
    pub updated: Option<String>,
    pub description: Option<String>,
    /// can be opened like a folder with `list(Some(id))`
    pub browsable: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Page {
    pub entries: Vec<RemoteEntry>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthState {
    pub ok: bool,
    pub who: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushResult {
    pub location: String,
    pub files: usize,
}

#[async_trait]
pub trait Connector: Send + Sync {
    /// "github", "gdrive", "local-folder" ...
    fn id(&self) -> &str;
    /// check the credentials work
    async fn auth(&self) -> Result<AuthState>;
    /// list entries at the top (folder = None) or inside a browsable entry. `page` continues a listing.
    async fn list(&self, folder: Option<String>, page: Option<String>) -> Result<Page>;
    /// bring one entry into the vault inbox
    async fn pull(&self, vault: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested>;
    /// send an item out. only some connectors support it.
    async fn push(&self, _vault: Arc<Vault>, _item: &Item, _target: Option<String>) -> Result<PushResult> {
        Err(anyhow!("{} can't receive items", self.id()))
    }
    /// a local path to watch for changes, for connectors that mirror a folder
    fn watch_path(&self) -> Option<std::path::PathBuf> {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub placeholder: &'static str,
    pub secret: bool,
    pub required: bool,
    /// "text" | "path" | "account" | "select:a,b"
    pub input: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindInfo {
    pub kind: &'static str,
    pub name: &'static str,
    pub about: &'static str,
    pub fields: Vec<Field>,
    pub can_push: bool,
    pub can_watch: bool,
}

const fn f(key: &'static str, label: &'static str, placeholder: &'static str, secret: bool, required: bool, input: &'static str) -> Field {
    Field { key, label, placeholder, secret, required, input }
}

/// built-in connectors, in the order the ui lists them
pub fn kinds() -> Vec<KindInfo> {
    vec![
        KindInfo {
            kind: "local-folder",
            name: "local folder",
            about: "import a folder once, or watch it and keep a mirror in the vault",
            fields: vec![f("path", "folder", "/home/you/code", false, true, "path"), f("mode", "mode", "import", false, false, "select:import,watch")],
            can_push: false,
            can_watch: true,
        },
        KindInfo {
            kind: "git",
            name: "git remote",
            about: "clone any git remote over https or ssh",
            fields: vec![f("url", "remote url", "https://example.com/team/repo.git", false, true, "text"), f("token", "token (https only, optional)", "", true, false, "text")],
            can_push: false,
            can_watch: false,
        },
        KindInfo {
            kind: "github",
            name: "github",
            about: "your repos and gists. sign in under accounts first",
            fields: vec![f("account", "account", "", false, true, "account")],
            can_push: false,
            can_watch: false,
        },
        KindInfo {
            kind: "agent-workspace",
            name: "agent workspace",
            about: "watch the folder your coding agents write to. new projects show up in the inbox",
            fields: vec![f("path", "workspace folder", "/home/you/agent-work", false, true, "path")],
            can_push: false,
            can_watch: true,
        },
        KindInfo {
            kind: "gdrive",
            name: "google drive",
            about: "files and google docs (exported as markdown, csv or pdf)",
            fields: vec![f("token", "access token", "", true, true, "text"), f("folder", "folder id (optional)", "root", false, false, "text")],
            can_push: false,
            can_watch: false,
        },
        KindInfo {
            kind: "dropbox",
            name: "dropbox",
            about: "files and folders from your dropbox",
            fields: vec![f("token", "access token", "", true, true, "text"), f("path", "start folder (optional)", "/", false, false, "text")],
            can_push: false,
            can_watch: false,
        },
        KindInfo {
            kind: "s3",
            name: "s3 / r2 bucket",
            about: "any s3-compatible bucket. pull objects in, push items out",
            fields: vec![
                f("bucket", "bucket", "my-bucket", false, true, "text"),
                f("region", "region", "us-east-1 (auto for r2)", false, false, "text"),
                f("endpoint", "endpoint (r2, minio ...)", "https://<account>.r2.cloudflarestorage.com", false, false, "text"),
                f("prefix", "prefix", "archival/", false, false, "text"),
                f("access_key_id", "access key id", "", false, true, "text"),
                f("token", "secret access key", "", true, true, "text"),
            ],
            can_push: true,
            can_watch: false,
        },
        KindInfo {
            kind: "figma",
            name: "figma",
            about: "figma files as link items with thumbnails and exported frames",
            fields: vec![
                f("token", "personal access token", "", true, true, "text"),
                f("project", "project id (optional)", "", false, false, "text"),
                f("files", "file keys or urls, comma separated (optional)", "", false, false, "text"),
            ],
            can_push: false,
            can_watch: false,
        },
        KindInfo {
            kind: "notion",
            name: "notion",
            about: "pages saved as markdown snapshots",
            fields: vec![f("token", "integration token", "", true, true, "text")],
            can_push: false,
            can_watch: false,
        },
    ]
}

pub struct BuildArgs {
    pub kind: String,
    pub config: Value,
    pub secret: Option<String>,
    /// for github: the account's token
    pub github_token: Option<String>,
}

pub fn build(a: BuildArgs) -> Result<Box<dyn Connector>> {
    let cfg = |k: &str| a.config.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let need = |k: &str| cfg(k).ok_or_else(|| anyhow!("{k} is required"));
    let secret = || a.secret.clone().ok_or_else(|| anyhow!("the token is missing from the keychain. remove and re-add this connector"));
    Ok(match a.kind.as_str() {
        "local-folder" => Box::new(local::LocalFolder::new(need("path")?, cfg("mode").as_deref() == Some("watch"))),
        "agent-workspace" => Box::new(agent::AgentWorkspace::new(need("path")?)),
        "git" => Box::new(git::GitRemote { url: need("url")?, token: a.secret.clone() }),
        "github" => Box::new(github::GitHub {
            account: need("account")?,
            token: a.github_token.clone().ok_or_else(|| anyhow!("sign in to that github account again"))?,
        }),
        "gdrive" => Box::new(gdrive::Drive { token: secret()?, root: cfg("folder").unwrap_or_else(|| "root".into()) }),
        "dropbox" => Box::new(dropbox::Dropbox { token: secret()?, root: cfg("path").map(|p| if p == "/" { String::new() } else { p }).unwrap_or_default() }),
        "s3" => Box::new(s3::Bucket::new(
            need("bucket")?,
            cfg("region"),
            cfg("endpoint"),
            cfg("prefix").unwrap_or_default(),
            need("access_key_id")?,
            secret()?,
        )?),
        "figma" => Box::new(figma::Figma { token: secret()?, project: cfg("project"), files: cfg("files").unwrap_or_default() }),
        "notion" => Box::new(notion::Notion { token: secret()? }),
        other => return Err(anyhow!("unknown connector {other}")),
    })
}
