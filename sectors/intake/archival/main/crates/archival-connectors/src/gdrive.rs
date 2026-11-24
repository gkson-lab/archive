use crate::util::{check, http, register_folder, write};
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::{anyhow, Result};
use archival_core::paths::safe_name;
use archival_core::Vault;
use archival_ingest::{new_inbox_folder, Ingested, Origin};
use async_trait::async_trait;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

const API: &str = "https://www.googleapis.com/drive/v3";
const FOLDER: &str = "application/vnd.google-apps.folder";

pub struct Drive {
    pub token: String,
    pub root: String,
}

/// google-native files have no bytes; export them to something useful
fn export_as(mime: &str) -> Option<(&'static str, &'static str)> {
    Some(match mime {
        "application/vnd.google-apps.document" => ("text/markdown", "md"),
        "application/vnd.google-apps.spreadsheet" => ("text/csv", "csv"),
        "application/vnd.google-apps.presentation" => ("application/pdf", "pdf"),
        "application/vnd.google-apps.drawing" => ("image/svg+xml", "svg"),
        _ => return None,
    })
}

impl Drive {
    async fn files(&self, parent: &str, page: Option<String>) -> Result<(Vec<Value>, Option<String>)> {
        let q = format!("'{}' in parents and trashed = false", parent.replace('\'', ""));
        let mut req = http()
            .get(format!("{API}/files"))
            .bearer_auth(&self.token)
            .query(&[("q", q.as_str()), ("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime)"), ("pageSize", "100"), ("orderBy", "folder,modifiedTime desc")]);
        if let Some(p) = &page {
            req = req.query(&[("pageToken", p.as_str())]);
        }
        let v: Value = check(req.send().await?).await?.json().await?;
        Ok((v["files"].as_array().cloned().unwrap_or_default(), v["nextPageToken"].as_str().map(|s| s.to_string())))
    }

    async fn fetch(&self, id: &str, mime: &str) -> Result<(Vec<u8>, Option<&'static str>)> {
        let (url, ext) = match export_as(mime) {
            Some((m, ext)) => (format!("{API}/files/{id}/export?mimeType={}", m.replace('+', "%2B")), Some(ext)),
            None => (format!("{API}/files/{id}?alt=media"), None),
        };
        let r = check(http().get(url).bearer_auth(&self.token).send().await?).await?;
        Ok((r.bytes().await?.to_vec(), ext))
    }

    async fn save(&self, id: &str, name: &str, mime: &str, dir: &Path) -> Result<()> {
        let (bytes, ext) = self.fetch(id, mime).await?;
        let mut fname = safe_name(name);
        if let Some(e) = ext {
            fname = format!("{fname}.{e}");
        }
        write(&dir.join(fname), &bytes)
    }

    async fn save_tree(&self, id: &str, dir: &Path, budget: &mut usize) -> Result<()> {
        let mut page = None;
        loop {
            let (files, next) = self.files(id, page).await?;
            for f in files {
                if *budget == 0 {
                    return Ok(());
                }
                let fid = f["id"].as_str().unwrap_or("");
                let name = f["name"].as_str().unwrap_or("untitled");
                let mime = f["mimeType"].as_str().unwrap_or("");
                if mime == FOLDER {
                    Box::pin(self.save_tree(fid, &dir.join(safe_name(name)), budget)).await?;
                } else if !mime.starts_with("application/vnd.google-apps.") || export_as(mime).is_some() {
                    self.save(fid, name, mime, dir).await?;
                    *budget -= 1;
                }
            }
            match next {
                Some(n) => page = Some(n),
                None => return Ok(()),
            }
        }
    }
}

#[async_trait]
impl Connector for Drive {
    fn id(&self) -> &str {
        "gdrive"
    }
    async fn auth(&self) -> Result<AuthState> {
        let v: Value = check(http().get(format!("{API}/about?fields=user")).bearer_auth(&self.token).send().await?).await?.json().await?;
        Ok(AuthState { ok: true, who: v["user"]["emailAddress"].as_str().map(|s| s.to_string()) })
    }
    async fn list(&self, folder: Option<String>, page: Option<String>) -> Result<Page> {
        let parent = folder.unwrap_or_else(|| self.root.clone());
        let (files, next) = self.files(&parent, page).await?;
        Ok(Page {
            entries: files
                .into_iter()
                .map(|f| {
                    let mime = f["mimeType"].as_str().unwrap_or("").to_string();
                    let is_dir = mime == FOLDER;
                    RemoteEntry {
                        id: format!("{}|{}", f["id"].as_str().unwrap_or(""), mime),
                        name: f["name"].as_str().unwrap_or("").into(),
                        kind: if is_dir { "dir".into() } else { "file".into() },
                        size: f["size"].as_str().and_then(|s| s.parse().ok()),
                        updated: f["modifiedTime"].as_str().map(|s| s.to_string()),
                        description: export_as(&mime).map(|(_, e)| format!("exports as .{e}")),
                        browsable: is_dir,
                    }
                })
                .map(|mut e| {
                    if e.browsable {
                        e.id = e.id.split('|').next().unwrap_or("").to_string();
                    }
                    e
                })
                .collect(),
            next,
        })
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        let mut parts = entry.id.splitn(2, '|');
        let id = parts.next().unwrap_or("").to_string();
        let mime = parts.next().unwrap_or(FOLDER).to_string();
        if id.is_empty() {
            return Err(anyhow!("missing file id"));
        }
        let dir = new_inbox_folder(&v, &entry.name)?;
        if mime == FOLDER {
            let mut budget = 500;
            self.save_tree(&id, &dir, &mut budget).await?;
        } else {
            self.save(&id, &entry.name, &mime, &dir).await?;
        }
        register_folder(v, dir, Origin { connector: "gdrive".into(), source: format!("https://drive.google.com/open?id={id}"), title: Some(entry.name.clone()) }).await
    }
}
