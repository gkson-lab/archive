use anyhow::{anyhow, Result};
use archival_core::Vault;
use archival_ingest::{finish_folder, Ingested, Origin};
use std::path::Path;
use std::sync::Arc;

pub fn http() -> reqwest::Client {
    reqwest::Client::builder().user_agent("archival/0.1").build().expect("http client")
}

pub async fn check(r: reqwest::Response) -> Result<reqwest::Response> {
    if r.status().is_success() {
        return Ok(r);
    }
    let status = r.status();
    let body = r.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.pointer("/error/message"))
                .or_else(|| v.get("error_summary"))
                .or_else(|| v.get("err"))
                .and_then(|m| m.as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    Err(match status.as_u16() {
        401 | 403 => anyhow!("access denied ({status}). the token may be expired or missing a scope. {msg}"),
        404 => anyhow!("not found. {msg}"),
        _ => anyhow!("request failed ({status}). {msg}"),
    })
}

/// run blocking vault work off the async executor
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| anyhow!("task failed: {e}"))?
}

pub async fn register_folder(v: Arc<Vault>, dir: std::path::PathBuf, origin: Origin) -> Result<Ingested> {
    blocking(move || finish_folder(&v, &dir, &origin)).await
}

pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}
