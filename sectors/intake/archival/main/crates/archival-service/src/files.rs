use crate::{b, item_dir, os, s, to, Service, VERSION};
use anyhow::{anyhow, Result};
use archival_core::{ItemPatch, Vault};
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub fn call(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    let v = svc.vault();
    match method {
        "app.info" => Ok(json!({
            "version": VERSION,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "home": dirs::home_dir(),
            "downloads": dirs::download_dir(),
            "config": archival_core::vault::AppConfig::path(),
        })),
        "vault.info" => to(v.stats()?),
        "vault.switch" => {
            let root = PathBuf::from(s(p, "root")?);
            let nv = Vault::open(&root)?;
            let mut cfg = archival_core::vault::AppConfig::load();
            cfg.vault_root = Some(root);
            cfg.save()?;
            svc.inner.runs.stop_all();
            svc.swap_vault(nv);
            to(svc.vault().stats()?)
        }
        "vault.rebuild" => to(v.rebuild_index()?),
        "settings.get" => {
            let mut m = serde_json::Map::new();
            for (k, val) in v.settings()? {
                m.insert(k, serde_json::from_str(&val).unwrap_or(Value::String(val)));
            }
            Ok(Value::Object(m))
        }
        "settings.set" => {
            let key = s(p, "key")?;
            if key.contains("token") || key.contains("secret") {
                return Err(anyhow!("secrets go in the keychain, not settings"));
            }
            let value = p.get("value").cloned().unwrap_or(Value::Null);
            v.set_setting(&key, &serde_json::to_string(&value)?)?;
            Ok(json!({"ok": true}))
        }
        "tree.list" => to(v.tree(&os(p, "path").unwrap_or_default())?),
        "file.read" => {
            let path = s(p, "path")?;
            let c = v.read_file(&path)?;
            if let Some(it) = v.item_for_path(&path)? {
                let _ = v.mark_opened(&it.id);
            }
            to(c)
        }
        "file.read_base64" => {
            let path = s(p, "path")?;
            let abs = v.abs(&path)?;
            let meta = std::fs::metadata(&abs)?;
            if meta.len() > 64 * 1024 * 1024 {
                return Err(anyhow!("that file is over 64 mb. open it in another app"));
            }
            let mime = mime_for(&abs);
            Ok(json!({"mime": mime, "data": B64.encode(v.read_bytes(&path)?), "size": meta.len()}))
        }
        "file.write" => {
            let path = s(p, "path")?;
            let bytes = match (os(p, "base64"), p.get("text").and_then(|t| t.as_str())) {
                (Some(b64), _) => B64.decode(b64)?,
                (None, Some(t)) => t.as_bytes().to_vec(),
                _ => return Err(anyhow!("nothing to write")),
            };
            if b(p, "agent") {
                // agent writes are always revertable: snapshot first
                if let Some(it) = v.item_for_path(&path)? {
                    v.snapshot(&it.id, "before agent write", "agent")?;
                }
            }
            v.write_file(&path, &bytes)?;
            Ok(json!({"ok": true, "item": v.item_for_path(&path)?}))
        }
        "file.create_dir" => {
            v.create_dir(&s(p, "path")?)?;
            Ok(json!({"ok": true}))
        }
        "file.rename" => {
            v.rename(&s(p, "from")?, &s(p, "to")?)?;
            Ok(json!({"ok": true}))
        }
        "file.trash" => to(v.trash_path(&s(p, "path")?)?),
        "file.abs" => Ok(json!({"path": v.abs(&s(p, "path")?)?})),
        "items.list" => to(v.items(os(p, "category").as_deref())?),
        "item.get" => to(v.item(&s(p, "id")?)?),
        "item.opened" => {
            v.mark_opened(&s(p, "id")?)?;
            Ok(json!({"ok": true}))
        }
        "item.update" => {
            let patch: ItemPatch = serde_json::from_value(p.get("patch").cloned().unwrap_or(json!({})))?;
            to(v.patch(&s(p, "id")?, &patch)?)
        }
        "item.file" => to(v.file_item(&s(p, "id")?, os(p, "category").as_deref())?),
        "item.trash" => {
            let it = v.item(&s(p, "id")?)?;
            to(v.trash_path(&it.path)?)
        }
        "item.export" => {
            let dest = os(p, "dest").map(PathBuf::from).or_else(dirs::download_dir).unwrap_or_else(std::env::temp_dir);
            Ok(json!({"path": v.export_zip(&s(p, "id")?, &dest)?}))
        }
        "inbox.list" => {
            let items = v.items(Some("inbox"))?;
            Ok(Value::Array(
                items
                    .into_iter()
                    .map(|it| {
                        let cat = it.kind.category().to_string();
                        json!({"item": it, "suggestion": {"kind": it.kind, "category": cat, "tags": it.tags}})
                    })
                    .collect(),
            ))
        }
        "trash.list" => to(v.trash()?),
        "trash.restore" => Ok(json!({"path": v.restore_trash(&s(p, "id")?)?})),
        "trash.purge" => Ok(json!({"removed": v.purge_trash(os(p, "id").as_deref())?})),
        "snapshot.create" => to(v.snapshot(&s(p, "item_id")?, &os(p, "label").unwrap_or_default(), "manual")?),
        "snapshot.list" => to(v.snapshots(&s(p, "item_id")?)?),
        "snapshot.restore" => to(v.restore_snapshot(&s(p, "id")?)?),
        "snapshot.changes" => to(v.snapshot_changes(&s(p, "id")?)?),
        "snapshot.file" => {
            let data = v.snapshot_file(&s(p, "id")?, &s(p, "path")?)?;
            Ok(json!({"text": data.map(|d| String::from_utf8_lossy(&d).to_string())}))
        }
        "search" | "search.query" => to(v.search(&s(p, "q")?, b(p, "contents"))?),
        "history" | "history.item" => history(&v, &s(p, "item_id")?),
        "mcp.info" => Ok(mcp_info()),
        _ => Err(anyhow!("unknown method {method}")),
    }
}

/// one timeline: git commits and archival snapshots, newest first
fn history(v: &Vault, id: &str) -> Result<Value> {
    let (_it, dir) = item_dir(v, id)?;
    let mut events: Vec<Value> = v
        .snapshots(id)?
        .into_iter()
        .map(|s| json!({"type": "snapshot", "time": s.created, "id": s.id, "title": s.label, "detail": format!("{} files", s.file_count), "source": s.source}))
        .collect();
    if archival_git::is_repo(&dir) {
        for c in archival_git::log(&dir, 200).unwrap_or_default() {
            events.push(json!({"type": "commit", "time": c.time, "id": c.id, "title": c.summary, "detail": format!("{} · {}", c.short, c.author)}));
        }
    }
    events.sort_by_key(|e| std::cmp::Reverse(e["time"].as_i64().unwrap_or(0)));
    Ok(Value::Array(events))
}

pub fn mime_for(p: &std::path::Path) -> String {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "svg" => "image/svg+xml".into(),
        "pdf" => "application/pdf".into(),
        _ => format!("{}", archival_core_mime(p)),
    }
}

fn archival_core_mime(p: &std::path::Path) -> String {
    // reuse the core's read_file mime guess without reading the file
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    match name.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .into()
}

pub fn mcp_info() -> Value {
    // prefer the `archival` cli next to this binary; the desktop app can also serve mcp itself
    let exe = std::env::current_exe().ok();
    let sibling = exe
        .as_ref()
        .and_then(|e| e.parent().map(|d| d.join(if cfg!(windows) { "archival.exe" } else { "archival" })))
        .filter(|p| p.exists());
    let cli = match (&sibling, &exe) {
        (Some(p), _) => p.to_string_lossy().to_string(),
        (None, Some(e)) if e.file_stem().map(|s| s.to_string_lossy().contains("archival")).unwrap_or(false) => e.to_string_lossy().to_string(),
        _ => "archival".into(),
    };
    json!({
        "command": cli,
        "args": ["mcp"],
        "config": {"mcpServers": {"archival": {"command": cli, "args": ["mcp"]}}},
        "add_command": format!("<agent> mcp add archival -- {cli} mcp"),
        "tools": crate_tools(),
    })
}

fn crate_tools() -> Vec<&'static str> {
    vec!["vault_search", "vault_read", "vault_write", "vault_list", "item_create", "item_snapshot", "item_run", "git_commit", "github_open_pr"]
}

