use crate::util::{blocking, check, http};
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::Result;
use archival_core::Vault;
use archival_ingest::{ingest_bytes, no_progress, Ingested, Origin};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct Dropbox {
    pub token: String,
    pub root: String,
}

fn entries(v: &Value) -> Vec<RemoteEntry> {
    v["entries"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|e| {
                    let dir = e[".tag"].as_str() == Some("folder");
                    RemoteEntry {
                        id: e["path_lower"].as_str().unwrap_or("").into(),
                        name: e["name"].as_str().unwrap_or("").into(),
                        kind: if dir { "dir".into() } else { "file".into() },
                        size: e["size"].as_u64(),
                        updated: e["server_modified"].as_str().map(|s| s.to_string()),
                        description: None,
                        browsable: dir,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl Connector for Dropbox {
    fn id(&self) -> &str {
        "dropbox"
    }
    async fn auth(&self) -> Result<AuthState> {
        let v: Value = check(http().post("https://api.dropboxapi.com/2/users/get_current_account").bearer_auth(&self.token).send().await?)
            .await?
            .json()
            .await?;
        Ok(AuthState { ok: true, who: v["email"].as_str().map(|s| s.to_string()) })
    }
    async fn list(&self, folder: Option<String>, page: Option<String>) -> Result<Page> {
        let v: Value = match page {
            Some(cursor) => check(
                http().post("https://api.dropboxapi.com/2/files/list_folder/continue").bearer_auth(&self.token).json(&json!({"cursor": cursor})).send().await?,
            )
            .await?
            .json()
            .await?,
            None => check(
                http()
                    .post("https://api.dropboxapi.com/2/files/list_folder")
                    .bearer_auth(&self.token)
                    .json(&json!({"path": folder.unwrap_or_else(|| self.root.clone()), "limit": 200}))
                    .send()
                    .await?,
            )
            .await?
            .json()
            .await?,
        };
        let next = if v["has_more"].as_bool() == Some(true) { v["cursor"].as_str().map(|s| s.to_string()) } else { None };
        Ok(Page { entries: entries(&v), next })
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        let (url, name) = if entry.browsable {
            ("https://content.dropboxapi.com/2/files/download_zip", format!("{}.zip", entry.name))
        } else {
            ("https://content.dropboxapi.com/2/files/download", entry.name.clone())
        };
        let r = check(
            http().post(url).bearer_auth(&self.token).header("Dropbox-API-Arg", json!({"path": entry.id}).to_string()).send().await?,
        )
        .await?;
        let bytes = r.bytes().await?.to_vec();
        let origin = Origin { connector: "dropbox".into(), source: format!("dropbox:{}", entry.id), title: Some(entry.name.clone()) };
        blocking(move || ingest_bytes(&v, &name, &bytes, &origin, &no_progress)).await
    }
}
