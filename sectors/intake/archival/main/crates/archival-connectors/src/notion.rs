use crate::util::{check, http, register_folder, write};
use crate::{AuthState, Connector, Page, RemoteEntry};
use anyhow::Result;
use archival_core::paths::safe_name;
use archival_core::Vault;
use archival_ingest::{new_inbox_folder, Ingested, Origin};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

const API: &str = "https://api.notion.com/v1";
const VERSION: &str = "2022-06-28";

pub struct Notion {
    pub token: String,
}

fn text(rt: &Value) -> String {
    rt.as_array()
        .map(|a| {
            a.iter()
                .map(|t| {
                    let s = t["plain_text"].as_str().unwrap_or("").to_string();
                    let ann = &t["annotations"];
                    let mut s = if ann["code"].as_bool() == Some(true) { format!("`{s}`") } else { s };
                    if ann["bold"].as_bool() == Some(true) {
                        s = format!("**{s}**");
                    }
                    if ann["italic"].as_bool() == Some(true) {
                        s = format!("*{s}*");
                    }
                    match t["href"].as_str() {
                        Some(h) => format!("[{s}]({h})"),
                        None => s,
                    }
                })
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn title_of(page: &Value) -> String {
    page["properties"]
        .as_object()
        .and_then(|props| props.values().find(|p| p["type"] == "title"))
        .map(|p| p["title"].as_array().map(|a| a.iter().filter_map(|t| t["plain_text"].as_str()).collect::<String>()).unwrap_or_default())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "untitled".into())
}

impl Notion {
    fn req(&self, r: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        r.bearer_auth(&self.token).header("Notion-Version", VERSION)
    }

    async fn children(&self, id: &str) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut url = format!("{API}/blocks/{id}/children?page_size=100");
            if let Some(c) = &cursor {
                url.push_str(&format!("&start_cursor={c}"));
            }
            let v: Value = check(self.req(http().get(url)).send().await?).await?.json().await?;
            out.extend(v["results"].as_array().cloned().unwrap_or_default());
            match (v["has_more"].as_bool(), v["next_cursor"].as_str()) {
                (Some(true), Some(c)) => cursor = Some(c.to_string()),
                _ => return Ok(out),
            }
        }
    }

    async fn render(&self, id: &str, depth: usize, md: &mut String) -> Result<()> {
        let indent = "  ".repeat(depth);
        let mut n = 0;
        for b in self.children(id).await? {
            let t = b["type"].as_str().unwrap_or("");
            let body = &b[t];
            let line = match t {
                "paragraph" => format!("{indent}{}\n", text(&body["rich_text"])),
                "heading_1" => format!("# {}\n", text(&body["rich_text"])),
                "heading_2" => format!("## {}\n", text(&body["rich_text"])),
                "heading_3" => format!("### {}\n", text(&body["rich_text"])),
                "bulleted_list_item" => format!("{indent}- {}", text(&body["rich_text"])),
                "numbered_list_item" => {
                    n += 1;
                    format!("{indent}{n}. {}", text(&body["rich_text"]))
                }
                "to_do" => format!("{indent}- [{}] {}", if body["checked"].as_bool() == Some(true) { "x" } else { " " }, text(&body["rich_text"])),
                "quote" | "callout" => format!("> {}\n", text(&body["rich_text"])),
                "code" => format!("```{}\n{}\n```\n", body["language"].as_str().unwrap_or(""), text(&body["rich_text"])),
                "divider" => "---\n".into(),
                "image" => {
                    let u = body["file"]["url"].as_str().or(body["external"]["url"].as_str()).unwrap_or("");
                    format!("![{}]({u})\n", text(&body["caption"]))
                }
                "bookmark" | "embed" | "link_preview" => format!("<{}>\n", body["url"].as_str().unwrap_or("")),
                "child_page" => format!("- page: {}\n", body["title"].as_str().unwrap_or("")),
                "table_row" => format!("| {} |", body["cells"].as_array().map(|c| c.iter().map(text).collect::<Vec<_>>().join(" | ")).unwrap_or_default()),
                _ => String::new(),
            };
            if t != "numbered_list_item" {
                n = 0;
            }
            if !line.is_empty() {
                md.push_str(&line);
                md.push('\n');
            }
            if b["has_children"].as_bool() == Some(true) && depth < 3 && t != "child_page" {
                Box::pin(self.render(b["id"].as_str().unwrap_or(""), depth + 1, md)).await?;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl Connector for Notion {
    fn id(&self) -> &str {
        "notion"
    }
    async fn auth(&self) -> Result<AuthState> {
        let v: Value = check(self.req(http().get(format!("{API}/users/me"))).send().await?).await?.json().await?;
        Ok(AuthState { ok: true, who: v["name"].as_str().map(|s| s.to_string()) })
    }
    async fn list(&self, _folder: Option<String>, page: Option<String>) -> Result<Page> {
        let mut body = json!({"filter": {"property": "object", "value": "page"}, "page_size": 50, "sort": {"direction": "descending", "timestamp": "last_edited_time"}});
        if let Some(p) = page {
            body["start_cursor"] = json!(p);
        }
        let v: Value = check(self.req(http().post(format!("{API}/search"))).json(&body).send().await?).await?.json().await?;
        Ok(Page {
            entries: v["results"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| RemoteEntry {
                    id: p["id"].as_str().unwrap_or("").into(),
                    name: title_of(p),
                    kind: "page".into(),
                    size: None,
                    updated: p["last_edited_time"].as_str().map(|s| s.to_string()),
                    description: None,
                    browsable: false,
                })
                .collect(),
            next: if v["has_more"].as_bool() == Some(true) { v["next_cursor"].as_str().map(|s| s.to_string()) } else { None },
        })
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        let page: Value = check(self.req(http().get(format!("{API}/pages/{}", entry.id))).send().await?).await?.json().await?;
        let title = title_of(&page);
        let mut md = format!("# {title}\n\n");
        self.render(&entry.id, 0, &mut md).await?;
        let dir = new_inbox_folder(&v, &title)?;
        write(&dir.join(format!("{}.md", safe_name(&title))), md.as_bytes())?;
        let url = page["url"].as_str().unwrap_or("").to_string();
        register_folder(v, dir, Origin { connector: "notion".into(), source: url, title: Some(title) }).await
    }
}
