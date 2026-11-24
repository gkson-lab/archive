use crate::util::{check, http, register_folder, write};
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::{anyhow, Result};
use archival_core::paths::safe_name;
use archival_core::{Kind, Vault};
use archival_ingest::{new_inbox_folder, Ingested, Origin};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

const API: &str = "https://api.figma.com/v1";

pub struct Figma {
    pub token: String,
    pub project: Option<String>,
    pub files: String,
}

/// accepts a bare key or a figma.com/design|file/<key>/... url
pub fn file_key(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(u) = url::Url::parse(s) {
        let segs: Vec<&str> = u.path_segments()?.collect();
        let i = segs.iter().position(|p| *p == "design" || *p == "file" || *p == "proto" || *p == "board")?;
        return segs.get(i + 1).map(|k| k.to_string());
    }
    Some(s.to_string())
}

impl Figma {
    async fn get(&self, path: &str) -> Result<Value> {
        Ok(check(http().get(format!("{API}{path}")).header("X-Figma-Token", &self.token).send().await?).await?.json().await?)
    }
}

#[async_trait]
impl Connector for Figma {
    fn id(&self) -> &str {
        "figma"
    }
    async fn auth(&self) -> Result<AuthState> {
        let v = self.get("/me").await?;
        Ok(AuthState { ok: true, who: v["handle"].as_str().or(v["email"].as_str()).map(|s| s.to_string()) })
    }
    async fn list(&self, _folder: Option<String>, _page: Option<String>) -> Result<Page> {
        let mut entries = Vec::new();
        if let Some(p) = &self.project {
            let v = self.get(&format!("/projects/{p}/files")).await?;
            for f in v["files"].as_array().cloned().unwrap_or_default() {
                entries.push(RemoteEntry {
                    id: f["key"].as_str().unwrap_or("").into(),
                    name: f["name"].as_str().unwrap_or("").into(),
                    kind: "design".into(),
                    size: None,
                    updated: f["last_modified"].as_str().map(|s| s.to_string()),
                    description: None,
                    browsable: false,
                });
            }
        }
        for k in self.files.split(',').filter_map(file_key) {
            if entries.iter().any(|e| e.id == k) {
                continue;
            }
            let v = self.get(&format!("/files/{k}?depth=1")).await?;
            entries.push(RemoteEntry {
                id: k,
                name: v["name"].as_str().unwrap_or("figma file").into(),
                kind: "design".into(),
                size: None,
                updated: v["lastModified"].as_str().map(|s| s.to_string()),
                description: None,
                browsable: false,
            });
        }
        if entries.is_empty() {
            return Err(anyhow!("add a project id or some file links to this connector"));
        }
        Ok(Page { entries, next: None })
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        let key = &entry.id;
        let file = self.get(&format!("/files/{key}?depth=2")).await?;
        let name = file["name"].as_str().unwrap_or(&entry.name).to_string();
        let mut frames: Vec<(String, String)> = Vec::new();
        for page in file["document"]["children"].as_array().cloned().unwrap_or_default() {
            for node in page["children"].as_array().cloned().unwrap_or_default() {
                if matches!(node["type"].as_str(), Some("FRAME") | Some("COMPONENT") | Some("SECTION")) && frames.len() < 12 {
                    frames.push((node["id"].as_str().unwrap_or("").into(), node["name"].as_str().unwrap_or("frame").into()));
                }
            }
        }
        let dir = new_inbox_folder(&v, &name)?;
        let mut thumb = None;
        if let Some(t) = file["thumbnailUrl"].as_str() {
            if let Ok(r) = http().get(t).send().await {
                if let Ok(b) = r.bytes().await {
                    write(&dir.join("thumb.png"), &b)?;
                    thumb = Some("thumb.png");
                }
            }
        }
        if !frames.is_empty() {
            let ids = frames.iter().map(|f| f.0.as_str()).collect::<Vec<_>>().join(",");
            let imgs = self.get(&format!("/images/{key}?ids={ids}&format=png&scale=1")).await?;
            for (id, fname) in &frames {
                if let Some(u) = imgs["images"][id].as_str() {
                    if let Ok(r) = http().get(u).send().await {
                        if let Ok(b) = r.bytes().await {
                            write(&dir.join("frames").join(format!("{}.png", safe_name(fname))), &b)?;
                        }
                    }
                }
            }
        }
        let link = json!({
            "url": format!("https://www.figma.com/design/{key}"),
            "title": name,
            "description": format!("{} frames exported", frames.len()),
            "thumbnail": thumb,
            "fetched": chrono::Utc::now().to_rfc3339(),
            "figma": { "key": key, "last_modified": file["lastModified"] },
        });
        write(&dir.join("link.json"), serde_json::to_string_pretty(&link)?.as_bytes())?;
        let mut ing = register_folder(v.clone(), dir, Origin { connector: "figma".into(), source: format!("https://www.figma.com/design/{key}"), title: Some(name) }).await?;
        let patch = archival_core::ItemPatch { kind: Some(Kind::Design), tags: Some(vec!["figma".into()]), ..Default::default() };
        ing.item = v.patch(&ing.item.id, &patch)?;
        ing.suggestion.kind = Kind::Design;
        ing.suggestion.category = "designs".into();
        Ok(ing)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys() {
        assert_eq!(super::file_key("https://www.figma.com/design/AbC123/My-File?node-id=1-2").as_deref(), Some("AbC123"));
        assert_eq!(super::file_key("AbC123").as_deref(), Some("AbC123"));
    }
}
