use crate::git::clone_into_inbox;
use crate::util::{register_folder, write};
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::{anyhow, Result};
use archival_core::Vault;
use archival_ingest::{new_inbox_folder, Ingested, Origin};
use async_trait::async_trait;
use std::sync::Arc;

pub struct GitHub {
    pub account: String,
    pub token: String,
}

#[async_trait]
impl Connector for GitHub {
    fn id(&self) -> &str {
        "github"
    }
    async fn auth(&self) -> Result<AuthState> {
        let a = archival_github::whoami(&self.token).await?;
        Ok(AuthState { ok: true, who: Some(a.login) })
    }
    async fn list(&self, folder: Option<String>, page: Option<String>) -> Result<Page> {
        match folder.as_deref() {
            None => Ok(Page {
                entries: vec![
                    RemoteEntry { id: "repos".into(), name: "repositories".into(), kind: "dir".into(), size: None, updated: None, description: None, browsable: true },
                    RemoteEntry { id: "gists".into(), name: "gists".into(), kind: "dir".into(), size: None, updated: None, description: None, browsable: true },
                ],
                next: None,
            }),
            Some("repos") => {
                let n: u32 = page.and_then(|p| p.parse().ok()).unwrap_or(1);
                let (repos, more) = archival_github::list_repos(&self.token, n).await?;
                Ok(Page {
                    entries: repos
                        .into_iter()
                        .map(|r| RemoteEntry {
                            id: format!("repo:{}", r.clone_url),
                            name: r.full_name,
                            kind: "repo".into(),
                            size: None,
                            updated: r.pushed_at,
                            description: r.description.or(Some(if r.private { "private".into() } else { "public".into() })),
                            browsable: false,
                        })
                        .collect(),
                    next: if more { Some((n + 1).to_string()) } else { None },
                })
            }
            Some("gists") => {
                let gists = archival_github::list_gists(&self.token).await?;
                Ok(Page {
                    entries: gists
                        .into_iter()
                        .map(|g| RemoteEntry {
                            id: format!("gist:{}", g.id),
                            name: if g.description.is_empty() { g.files.first().map(|f| f.filename.clone()).unwrap_or_else(|| g.id.clone()) } else { g.description.clone() },
                            kind: "gist".into(),
                            size: Some(g.files.iter().map(|f| f.size).sum()),
                            updated: Some(g.updated_at),
                            description: Some(g.files.iter().map(|f| f.filename.clone()).collect::<Vec<_>>().join(", ")),
                            browsable: false,
                        })
                        .collect(),
                    next: None,
                })
            }
            Some(_) => Err(anyhow!("nothing there")),
        }
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        if let Some(url) = entry.id.strip_prefix("repo:") {
            let title = entry.name.rsplit('/').next().map(|s| s.to_string());
            let mut ing = clone_into_inbox(v.clone(), url.to_string(), Some(self.token.clone()), "github", title).await?;
            let patch = archival_core::ItemPatch { account: Some(Some(self.account.clone())), ..Default::default() };
            ing.item = v.patch(&ing.item.id, &patch)?;
            return Ok(ing);
        }
        if let Some(id) = entry.id.strip_prefix("gist:") {
            let gists = archival_github::list_gists(&self.token).await?;
            let g = gists.into_iter().find(|g| g.id == id).ok_or_else(|| anyhow!("gist not found"))?;
            let dir = new_inbox_folder(&v, &entry.name)?;
            for f in &g.files {
                let bytes = archival_github::download(Some(&self.token), &f.raw_url).await?;
                write(&dir.join(archival_core::paths::safe_name(&f.filename)), &bytes)?;
            }
            return register_folder(v, dir, Origin { connector: "github".into(), source: g.html_url, title: Some(entry.name.clone()) }).await;
        }
        Err(anyhow!("can't pull that"))
    }
}
