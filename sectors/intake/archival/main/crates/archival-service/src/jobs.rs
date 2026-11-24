//! long work (ingest, clone, publish) runs as a job the ui can poll for "12 of 40 files".

use crate::{os, s, strs, to, Service};
use anyhow::{anyhow, Result};
use archival_ingest::{ingest_bytes, ingest_path, ingest_text, Origin};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub done: usize,
    pub total: usize,
    /// "running" | "done" | "error"
    pub status: String,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub steps: Vec<String>,
    pub started: i64,
}

impl Service {
    pub(crate) fn job_new(&self, kind: &str, label: &str, total: usize, steps: Vec<String>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut jobs = self.inner.jobs.lock().unwrap();
        // keep the list short: drop finished jobs beyond 30
        if jobs.len() > 40 {
            jobs.retain(|j| j.status == "running");
        }
        jobs.push(Job {
            id: id.clone(),
            kind: kind.into(),
            label: label.into(),
            done: 0,
            total,
            status: "running".into(),
            error: None,
            result: None,
            steps,
            started: archival_core::now(),
        });
        id
    }
    pub(crate) fn job_progress(&self, id: &str, done: usize, total: usize) {
        if let Some(j) = self.inner.jobs.lock().unwrap().iter_mut().find(|j| j.id == id) {
            j.done = done;
            j.total = total;
        }
    }
    pub(crate) fn job_finish(&self, id: &str, r: Result<Value>) {
        if let Some(j) = self.inner.jobs.lock().unwrap().iter_mut().find(|j| j.id == id) {
            match r {
                Ok(v) => {
                    j.status = "done".into();
                    j.done = j.total.max(j.done);
                    j.result = Some(v);
                }
                Err(e) => {
                    j.status = "error".into();
                    j.error = Some(format!("{e:#}"));
                }
            }
        }
    }

    /// run blocking work as a job with a progress callback
    pub(crate) fn spawn_job<F>(&self, kind: &str, label: &str, f: F) -> Value
    where
        F: FnOnce(&Service, &(dyn Fn(usize, usize) + Send + Sync)) -> Result<Value> + Send + 'static,
    {
        let id = self.job_new(kind, label, 0, vec![]);
        let svc = self.clone();
        let jid = id.clone();
        std::thread::spawn(move || {
            let s2 = svc.clone();
            let j2 = jid.clone();
            let progress = move |d: usize, t: usize| s2.job_progress(&j2, d, t);
            let r = f(&svc, &progress);
            svc.job_finish(&jid, r);
        });
        json!({"job": id})
    }
}

pub fn call(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    match method {
        "jobs.list" => to(svc.inner.jobs.lock().unwrap().clone()),
        "jobs.get" => {
            let id = s(p, "id")?;
            to(svc.inner.jobs.lock().unwrap().iter().find(|j| j.id == id).cloned().ok_or_else(|| anyhow!("no such job"))?)
        }
        "jobs.dismiss" => {
            let id = s(p, "id")?;
            svc.inner.jobs.lock().unwrap().retain(|j| j.id != id);
            Ok(json!({"ok": true}))
        }
        "ingest.paths" => {
            let paths = strs(p, "paths");
            if paths.is_empty() {
                return Err(anyhow!("nothing to import"));
            }
            let label = if paths.len() == 1 {
                format!("importing {}", PathBuf::from(&paths[0]).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
            } else {
                format!("importing {} things", paths.len())
            };
            let title = os(p, "title");
            Ok(svc.spawn_job("ingest", &label, move |svc, progress| {
                let v = svc.vault();
                let mut out = Vec::new();
                for path in &paths {
                    let src = PathBuf::from(path);
                    let mut origin = Origin::local(&src);
                    origin.title = title.clone();
                    out.push(to(ingest_path(&v, &src, &origin, progress)?)?);
                }
                Ok(Value::Array(out))
            }))
        }
        "ingest.upload" => {
            let name = s(p, "name")?;
            let data = base64::engine::general_purpose::STANDARD.decode(s(p, "base64")?)?;
            Ok(svc.spawn_job("ingest", &format!("importing {name}"), move |svc, progress| {
                let origin = Origin { connector: "upload".into(), source: name.clone(), title: None };
                to(ingest_bytes(&svc.vault(), &name, &data, &origin, progress)?)
            }))
        }
        "ingest.text" => {
            let v = svc.vault();
            let origin = Origin { connector: "paste".into(), source: String::new(), title: None };
            to(ingest_text(&v, &os(p, "title").unwrap_or_default(), &s(p, "text")?, &os(p, "ext").unwrap_or_default(), &origin)?)
        }
        _ => Err(anyhow!("unknown method {method}")),
    }
}

pub fn ingest_url(svc: &Service, p: &Value) -> Result<Value> {
    let url = s(p, "url")?;
    let id = svc.job_new("ingest", &format!("saving {url}"), 1, vec![]);
    let svc2 = svc.clone();
    let jid = id.clone();
    tokio::spawn(async move {
        let v = svc2.vault();
        let r = archival_ingest::ingest_url(&v, &url).await.and_then(to);
        svc2.job_finish(&jid, r);
    });
    Ok(json!({"job": id}))
}
