use crate::util::{blocking, register_folder};
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::Result;
use archival_core::Vault;
use archival_ingest::{new_inbox_folder, Ingested, Origin};
use async_trait::async_trait;
use std::sync::Arc;

pub struct GitRemote {
    pub url: String,
    pub token: Option<String>,
}

pub fn repo_name(url: &str) -> String {
    url.trim_end_matches('/').trim_end_matches(".git").rsplit(['/', ':']).next().unwrap_or("repo").to_string()
}

pub async fn clone_into_inbox(v: Arc<Vault>, url: String, token: Option<String>, connector: &str, title: Option<String>) -> Result<Ingested> {
    let name = title.clone().unwrap_or_else(|| repo_name(&url));
    let v2 = v.clone();
    let u2 = url.clone();
    let dir = blocking(move || {
        let dir = new_inbox_folder(&v2, &name)?;
        std::fs::remove_dir(&dir)?;
        let auth = archival_git::Auth { token, username: None };
        if let Err(e) = archival_git::clone(&u2, &dir, &auth) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        Ok(dir)
    })
    .await?;
    register_folder(v, dir, Origin { connector: connector.into(), source: url, title }).await
}

#[async_trait]
impl Connector for GitRemote {
    fn id(&self) -> &str {
        "git"
    }
    async fn auth(&self) -> Result<AuthState> {
        Ok(AuthState { ok: true, who: Some(self.url.clone()) })
    }
    async fn list(&self, _folder: Option<String>, _page: Option<String>) -> Result<Page> {
        Ok(Page {
            entries: vec![RemoteEntry {
                id: self.url.clone(),
                name: repo_name(&self.url),
                kind: "repo".into(),
                size: None,
                updated: None,
                description: Some(self.url.clone()),
                browsable: false,
            }],
            next: None,
        })
    }
    async fn pull(&self, v: Arc<Vault>, _entry: &RemoteEntry) -> Result<Ingested> {
        clone_into_inbox(v, self.url.clone(), self.token.clone(), "git", None).await
    }
}
