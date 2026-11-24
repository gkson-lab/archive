//! local bridge so the ui can run in a normal browser during development.
//! binds 127.0.0.1 only, checks the Host header (no dns rebinding) and needs a token header.

use anyhow::Result;
use archival_service::Service;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Clone)]
struct App {
    svc: Service,
    token: String,
    port: u16,
}

async fn api(State(app): State<App>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    let allowed = [format!("127.0.0.1:{}", app.port), format!("localhost:{}", app.port)];
    if !allowed.iter().any(|a| a == host) && !host.starts_with("127.0.0.1:") && !host.starts_with("localhost:") {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "bad host"})));
    }
    let tok = headers.get("x-archival-token").and_then(|t| t.to_str().ok()).unwrap_or("");
    if tok != app.token {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "missing or wrong token"})));
    }
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let params = body.get("params").cloned().unwrap_or(json!({}));
    match app.svc.call(&method, params).await {
        Ok(v) => (StatusCode::OK, Json(json!({"ok": v}))),
        Err(e) => (StatusCode::OK, Json(json!({"error": format!("{e:#}")}))),
    }
}

pub async fn serve(svc: Service, port: u16, ui: Option<PathBuf>) -> Result<()> {
    let token_file = svc.vault().meta_dir().join("bridge-token");
    let token = match std::fs::read_to_string(&token_file) {
        Ok(t) if t.trim().len() >= 32 => t.trim().to_string(),
        _ => {
            let t = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            std::fs::write(&token_file, &t)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600))?;
            }
            t
        }
    };
    let app = App { svc: svc.clone(), token: token.clone(), port };
    let mut router = Router::new().route("/api", post(api)).with_state(app);
    if let Some(dir) = ui {
        router = router.fallback_service(tower_http::services::ServeDir::new(dir));
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("archival bridge on http://127.0.0.1:{port}/#token={token}");
    eprintln!("token file: {}", token_file.display());
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    svc.shutdown();
    Ok(())
}
