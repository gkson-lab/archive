//! folder watching for `local-folder` (watch mode) and `agent-workspace` connectors.
//! local folders keep one mirror item up to date; agent workspaces file each new
//! subfolder into the inbox once it has been quiet for a few seconds.

use crate::connectors::{instance, record, row, rows, set_state};
use crate::{to, Service};
use anyhow::{anyhow, Result};
use archival_ingest::{ingest_path, no_progress, Origin};
use notify::{RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

pub fn start_all(svc: &Service) {
    if let Ok(all) = rows(svc) {
        for r in all {
            start(svc, &r.id);
        }
    }
}

pub fn start(svc: &Service, id: &str) {
    let Ok(r) = row(svc, id) else { return };
    let Ok(c) = instance(svc, &r) else { return };
    let Some(path) = c.watch_path() else { return };
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut w = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            record(svc, id, Some(format!("can't watch {}: {e}", path.display())));
            return;
        }
    };
    let mode = if r.kind == "agent-workspace" { RecursiveMode::NonRecursive } else { RecursiveMode::Recursive };
    if let Err(e) = w.watch(&path, mode) {
        record(svc, id, Some(format!("can't watch {}: {e}", path.display())));
        return;
    }
    svc.inner.watchers.lock().unwrap().insert(id.to_string(), w);
    let svc2 = svc.clone();
    let id2 = id.to_string();
    let kind = r.kind.clone();
    std::thread::spawn(move || {
        // debounce: act once events stop for a moment
        let quiet = if kind == "agent-workspace" { Duration::from_secs(4) } else { Duration::from_millis(1500) };
        loop {
            match rx.recv() {
                Ok(_) => {}
                Err(_) => return,
            }
            while rx.recv_timeout(quiet).is_ok() {}
            if !svc2.inner.watchers.lock().unwrap().contains_key(&id2) {
                return;
            }
            let r = if kind == "agent-workspace" { collect_agent(&svc2, &id2) } else { mirror(&svc2, &id2) };
            record(&svc2, &id2, r.err().map(|e| format!("{e:#}")));
        }
    });
    // first pass right away
    let svc3 = svc.clone();
    let id3 = id.to_string();
    let kind3 = r.kind;
    std::thread::spawn(move || {
        let res = if kind3 == "agent-workspace" { collect_agent(&svc3, &id3) } else { mirror(&svc3, &id3) };
        record(&svc3, &id3, res.err().map(|e| format!("{e:#}")));
    });
}

fn src_path(svc: &Service, id: &str) -> Result<PathBuf> {
    let r = row(svc, id)?;
    instance(svc, &r)?.watch_path().ok_or_else(|| anyhow!("not a watched connector"))
}

/// keep the mirror item identical to the watched folder (ignoring the default ignore list)
fn mirror(svc: &Service, id: &str) -> Result<Value> {
    let r = row(svc, id)?;
    let src = src_path(svc, id)?;
    let v = svc.vault();
    let mirror_id = r.state.get("item_id").and_then(|x| x.as_str()).map(|s| s.to_string());
    let existing = mirror_id.as_deref().and_then(|m| v.item(m).ok());
    let item = match existing {
        Some(it) => it,
        None => {
            let origin = Origin { connector: "local-folder".into(), source: src.to_string_lossy().to_string(), title: None };
            let ing = ingest_path(&v, &src, &origin, &no_progress)?;
            set_state(svc, id, &json!({"item_id": ing.item.id}))?;
            return to(ing.item);
        }
    };
    let dest = v.abs(&item.path)?;
    let mut changed = 0;
    let mut seen = std::collections::HashSet::new();
    for f in archival_core::tree::walk_files(&src) {
        let rel = archival_core::paths::relative(&src, &f);
        let d = dest.join(&rel);
        seen.insert(rel);
        let same = d.exists()
            && archival_core::objects::ObjectStore::hash_file(&d).ok() == archival_core::objects::ObjectStore::hash_file(&f).ok();
        if !same {
            if let Some(p) = d.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(&f, &d)?;
            changed += 1;
        }
    }
    for f in archival_core::tree::walk_files(&dest) {
        let rel = archival_core::paths::relative(&dest, &f);
        if !seen.contains(&rel) {
            std::fs::remove_file(&f)?;
            changed += 1;
        }
    }
    if changed > 0 {
        v.snapshot(&item.id, "folder changed", "connector")?;
        v.reindex(&item)?;
    }
    Ok(json!({"changed": changed, "item": item}))
}

/// file new subfolders of an agent workspace into the inbox, once each
fn collect_agent(svc: &Service, id: &str) -> Result<Value> {
    let r = row(svc, id)?;
    let src = src_path(svc, id)?;
    let v = svc.vault();
    let mut seen: Vec<String> = r.state.get("seen").and_then(|s| serde_json::from_value(s.clone()).ok()).unwrap_or_default();
    let first_run = r.state.get("seen").is_none();
    let mut added = Vec::new();
    for e in std::fs::read_dir(&src)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_dir() || name.starts_with('.') || seen.contains(&name) {
            continue;
        }
        seen.push(name.clone());
        // on the very first pass just remember what's there, so connecting doesn't flood the inbox
        if first_run || is_empty(&e.path()) {
            continue;
        }
        let origin = Origin { connector: "agent-workspace".into(), source: e.path().to_string_lossy().to_string(), title: None };
        let ing = ingest_path(&v, &e.path(), &origin, &no_progress)?;
        added.push(ing.item);
    }
    set_state(svc, id, &json!({"seen": seen}))?;
    Ok(json!({"added": added}))
}

fn is_empty(p: &Path) -> bool {
    std::fs::read_dir(p).map(|mut d| d.next().is_none()).unwrap_or(true)
}

pub async fn sync_now(svc: &Service, id: &str) -> Result<Value> {
    let r = row(svc, id)?;
    let svc2 = svc.clone();
    let id2 = id.to_string();
    let res = match r.kind.as_str() {
        "local-folder" if r.config.get("mode").and_then(|m| m.as_str()) == Some("watch") => {
            tokio::task::spawn_blocking(move || mirror(&svc2, &id2)).await?
        }
        "agent-workspace" => tokio::task::spawn_blocking(move || {
            // a manual sync treats everything not yet seen as new
            let r = row(&svc2, &id2)?;
            if r.state.get("seen").is_none() {
                set_state(&svc2, &id2, &json!({"seen": []}))?;
            }
            collect_agent(&svc2, &id2)
        })
        .await?,
        _ => instance(svc, &r)?.auth().await.and_then(to),
    };
    record(svc, id, res.as_ref().err().map(|e| format!("{e:#}")));
    res
}
