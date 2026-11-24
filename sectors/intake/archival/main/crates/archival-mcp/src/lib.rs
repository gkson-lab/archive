//! model context protocol server over stdio (json-rpc, one message per line).
//! agents can search, read and write the vault, snapshot and run items, commit and open prs.
//! every agent write is snapshotted first, so it can be reverted from the item's history.

use anyhow::Result;
use archival_service::Service;
use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn tools() -> Value {
    let t = |name: &str, description: &str, props: Value, required: &[&str]| {
        json!({"name": name, "description": description, "inputSchema": {"type": "object", "properties": props, "required": required}})
    };
    json!([
        t("vault_search", "search the vault by name, or by file contents with contents=true", json!({"query": {"type": "string"}, "contents": {"type": "boolean"}}), &["query"]),
        t("vault_list", "list a folder in the vault. empty path lists the top folders (projects, docs, designs, snippets, assets, links, inbox)", json!({"path": {"type": "string"}}), &[]),
        t("vault_read", "read a text file from the vault by its vault path, e.g. projects/app/src/main.rs", json!({"path": {"type": "string"}}), &["path"]),
        t("vault_write", "write a text file in the vault. the item is snapshotted first so the change can be reverted", json!({"path": {"type": "string"}, "text": {"type": "string"}}), &["path", "text"]),
        t("item_create", "create a new item. kind picks the folder: project, document, design, snippet. for a project, files maps relative paths to text", json!({"title": {"type": "string"}, "kind": {"type": "string", "enum": ["project", "document", "design", "snippet"]}, "files": {"type": "object", "additionalProperties": {"type": "string"}}, "text": {"type": "string"}, "ext": {"type": "string"}}), &["title", "kind"]),
        t("item_snapshot", "save a snapshot of an item (by vault path or id)", json!({"item": {"type": "string"}, "label": {"type": "string"}}), &["item"]),
        t("item_run", "run a command in an item's folder and return its output. the item must have been approved to run in the app once", json!({"item": {"type": "string"}, "command": {"type": "string"}, "timeout_seconds": {"type": "integer"}}), &["item"]),
        t("git_commit", "stage all changes in a project and commit them", json!({"item": {"type": "string"}, "message": {"type": "string"}, "push": {"type": "boolean"}}), &["item", "message"]),
        t("github_open_pr", "push the project's branch and open a pull request on github", json!({"item": {"type": "string"}, "title": {"type": "string"}, "body": {"type": "string"}, "base": {"type": "string"}, "draft": {"type": "boolean"}}), &["item", "title"]),
    ])
}

/// accept an item id or any vault path inside the item
async fn resolve_item(svc: &Service, s: &str) -> Result<String> {
    if let Ok(it) = svc.call("item.get", json!({"id": s})).await {
        return Ok(it["id"].as_str().unwrap_or_default().to_string());
    }
    let v = svc.vault();
    let it = v.item_for_path(s.trim_matches('/'))?.ok_or_else(|| anyhow::anyhow!("no item at {s}"))?;
    Ok(it.id)
}

pub async fn call_tool(svc: &Service, name: &str, a: &Value) -> Result<Value> {
    let st = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "vault_search" => svc.call("search", json!({"q": st("query"), "contents": a.get("contents").and_then(|c| c.as_bool()).unwrap_or(false)})).await,
        "vault_list" => svc.call("tree.list", json!({"path": st("path")})).await,
        "vault_read" => {
            let f = svc.call("file.read", json!({"path": st("path")})).await?;
            Ok(json!({"path": f["path"], "text": f["text"], "binary": f["binary"], "size": f["size"]}))
        }
        "vault_write" => svc.call("file.write", json!({"path": st("path"), "text": st("text"), "agent": true})).await,
        "item_create" => {
            let kind = st("kind");
            let cat = match kind.as_str() {
                "project" => "projects",
                "document" => "docs",
                "design" => "designs",
                _ => "snippets",
            };
            let title = st("title");
            let safe: String = title.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' }).collect();
            let safe = safe.trim().to_string();
            if let Some(files) = a.get("files").and_then(|f| f.as_object()) {
                let base = format!("{cat}/{safe}");
                svc.call("file.create_dir", json!({"path": base})).await?;
                for (rel, text) in files {
                    svc.call("file.write", json!({"path": format!("{base}/{}", rel.trim_start_matches('/')), "text": text.as_str().unwrap_or("")})).await?;
                }
                let it = svc.vault().item_for_path(&base)?;
                Ok(json!({"item": it}))
            } else {
                let ext = a.get("ext").and_then(|e| e.as_str()).unwrap_or(if kind == "document" { "md" } else { "txt" });
                let path = format!("{cat}/{safe}.{}", ext.trim_start_matches('.'));
                svc.call("file.write", json!({"path": path, "text": st("text")})).await?;
                Ok(json!({"item": svc.vault().item_for_path(&path)?}))
            }
        }
        "item_snapshot" => {
            let id = resolve_item(svc, &st("item")).await?;
            svc.call("snapshot.create", json!({"item_id": id, "label": a.get("label").and_then(|l| l.as_str()).unwrap_or("agent snapshot")})).await
        }
        "item_run" => {
            let id = resolve_item(svc, &st("item")).await?;
            let v = svc.vault();
            let it = v.item(&id)?;
            if !it.trusted {
                anyhow::bail!("this item hasn't been approved to run yet. open it in archival and press run once");
            }
            let command = a.get("command").and_then(|c| c.as_str()).map(|s| s.to_string()).or(it.run_command.clone()).ok_or_else(|| anyhow::anyhow!("no command given and none saved"))?;
            let started = svc.call("run.start", json!({"item_id": id, "command": command})).await?;
            let run_id = started["id"].as_str().unwrap_or("").to_string();
            let timeout = a.get("timeout_seconds").and_then(|t| t.as_u64()).unwrap_or(120).min(900);
            let t0 = std::time::Instant::now();
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let out = svc.call("run.read", json!({"run_id": run_id, "since": 0})).await?;
                let ended = out["info"]["ended"].is_number();
                if ended || t0.elapsed().as_secs() >= timeout {
                    if !ended {
                        svc.call("run.stop", json!({"run_id": run_id})).await?;
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    let out = svc.call("run.read", json!({"run_id": run_id, "since": 0})).await?;
                    let data = base64::engine::general_purpose::STANDARD.decode(out["data"].as_str().unwrap_or("")).unwrap_or_default();
                    let text = String::from_utf8_lossy(&data);
                    let tail: String = text.chars().rev().take(30_000).collect::<Vec<_>>().into_iter().rev().collect();
                    let _ = svc.call("run.remove", json!({"run_id": run_id})).await;
                    return Ok(json!({"exit_code": out["info"]["exit_code"], "status": out["info"]["status"], "ports": out["info"]["ports"], "output": tail}));
                }
            }
        }
        "git_commit" => {
            let id = resolve_item(svc, &st("item")).await?;
            let push = a.get("push").and_then(|p| p.as_bool()).unwrap_or(false);
            svc.call("snapshot.create", json!({"item_id": id, "label": "before agent commit"})).await?;
            if push {
                svc.call("git.ship", json!({"item_id": id, "message": st("message")})).await
            } else {
                svc.call("git.stage_all", json!({"item_id": id})).await?;
                svc.call("git.commit", json!({"item_id": id, "message": st("message")})).await
            }
        }
        "github_open_pr" => {
            let id = resolve_item(svc, &st("item")).await?;
            svc.call("github.open_pr", json!({"item_id": id, "title": st("title"), "body": st("body"), "base": a.get("base"), "draft": a.get("draft").and_then(|d| d.as_bool()).unwrap_or(false)})).await
        }
        _ => anyhow::bail!("unknown tool {name}"),
    }
}

pub async fn handle(svc: &Service, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let result: std::result::Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "archival", "version": archival_service::VERSION},
            "instructions": "archival is a local vault of projects, documents, designs and snippets. use vault_search or vault_list to find things, vault_read and vault_write for files (vault paths look like projects/app/src/main.rs). writes are snapshotted so they can be undone.",
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(match call_tool(svc, name, &args).await {
                Ok(v) => json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default()}], "isError": false}),
                Err(e) => json!({"content": [{"type": "text", "text": format!("{e:#}")}], "isError": true}),
            })
        }
        m if m.starts_with("notifications/") => return None,
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    let id = id?;
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    })
}

pub async fn serve_stdio(svc: Service) -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(&svc, &msg).await,
            Err(e) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
        };
        if let Some(r) = reply {
            out.write_all(serde_json::to_string(&r)?.as_bytes()).await?;
            out.write_all(b"\n").await?;
            out.flush().await?;
        }
    }
    svc.shutdown();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread")]
    async fn protocol() {
        let d = std::env::temp_dir().join(format!("archival-mcp-test-{}", std::process::id()));
        let svc = Service::open(Some(d.clone())).unwrap();
        let init = handle(&svc, &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})).await.unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "archival");
        assert!(handle(&svc, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await.is_none());
        let list = handle(&svc, &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).await.unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 9);
        let r = handle(&svc, &json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "item_create", "arguments": {"title": "agent app", "kind": "project", "files": {"main.py": "print('hi')"}}}})).await.unwrap();
        assert_eq!(r["result"]["isError"], false, "{r}");
        let r = handle(&svc, &json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "vault_read", "arguments": {"path": "projects/agent app/main.py"}}})).await.unwrap();
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("print('hi')"));
        let r = handle(&svc, &json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "item_run", "arguments": {"item": "projects/agent app", "command": "echo hi"}}})).await.unwrap();
        assert_eq!(r["result"]["isError"], false, "{r}");
        svc.shutdown();
        let _ = std::fs::remove_dir_all(d);
    }
}
