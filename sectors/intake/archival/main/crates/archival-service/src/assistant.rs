//! optional assistant, off by default. bring your own provider: any openai-compatible
//! chat completions endpoint. the key lives in the keychain.

use crate::{item_dir, os, s, Service};
use anyhow::{anyhow, Result};
use archival_github::secrets;
use serde_json::{json, Value};

const KEY: &str = "assistant";

fn cfg(svc: &Service) -> (bool, Option<String>, Option<String>) {
    let v = svc.vault();
    let get = |k: &str| v.setting(k).ok().flatten().and_then(|s| serde_json::from_str::<Value>(&s).ok());
    (
        get("assistant.enabled").and_then(|x| x.as_bool()).unwrap_or(false),
        get("assistant.base_url").and_then(|x| x.as_str().map(|s| s.to_string())),
        get("assistant.model").and_then(|x| x.as_str().map(|s| s.to_string())),
    )
}

pub fn call_sync(svc: &Service, method: &str, _p: &Value) -> Result<Value> {
    match method {
        "assistant.status" => {
            let (enabled, base, model) = cfg(svc);
            Ok(json!({"enabled": enabled, "base_url": base, "model": model, "key": secrets::get(KEY).ok().flatten().is_some()}))
        }
        "assistant.disable" => {
            svc.vault().set_setting("assistant.enabled", "false")?;
            Ok(json!({"ok": true}))
        }
        _ => Err(anyhow!("unknown method {method}")),
    }
}

async fn complete(svc: &Service, system: &str, user: &str) -> Result<String> {
    let (enabled, base, model) = cfg(svc);
    if !enabled {
        return Err(anyhow!("the assistant is off. turn it on in settings"));
    }
    let base = base.ok_or_else(|| anyhow!("set the assistant's endpoint in settings"))?;
    let model = model.ok_or_else(|| anyhow!("set the assistant's model in settings"))?;
    let key = secrets::get(KEY)?.ok_or_else(|| anyhow!("add the assistant's api key in settings"))?;
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let body = json!({"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "max_tokens": 600});
    let r = reqwest::Client::new().post(url).bearer_auth(key).json(&body).send().await?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(json!({}));
    if !status.is_success() {
        return Err(anyhow!("the assistant's provider said {}: {}", status, v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("")));
    }
    v.pointer("/choices/0/message/content").and_then(|c| c.as_str()).map(|s| s.trim().to_string()).ok_or_else(|| anyhow!("no answer from the provider"))
}

fn diff_text(dir: &std::path::Path) -> String {
    let mut out = String::new();
    for staged in [true, false] {
        for f in archival_git::diff(dir, None, staged).unwrap_or_default() {
            out.push_str(&format!("--- {} ({})\n", f.path, f.status));
            for h in f.hunks {
                out.push_str(&h.header);
                out.push('\n');
                for l in h.lines {
                    out.push(l.origin);
                    out.push_str(&l.text);
                    out.push('\n');
                }
            }
            if out.len() > 24_000 {
                return out;
            }
        }
    }
    out
}

pub async fn call(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    match method {
        "assistant.configure" => {
            let v = svc.vault();
            if let Some(k) = os(p, "key") {
                secrets::set(KEY, k.trim())?;
            }
            if let Some(b) = os(p, "base_url") {
                v.set_setting("assistant.base_url", &serde_json::to_string(&b)?)?;
            }
            if let Some(m) = os(p, "model") {
                v.set_setting("assistant.model", &serde_json::to_string(&m)?)?;
            }
            v.set_setting("assistant.enabled", "true")?;
            call_sync(svc, "assistant.status", p)
        }
        "assistant.commit_message" => {
            let (_, dir) = item_dir(&svc.vault(), &s(p, "item_id")?)?;
            let d = diff_text(&dir);
            if d.is_empty() {
                return Err(anyhow!("there are no changes to describe"));
            }
            let m = complete(svc, "write a short git commit message for this diff. one summary line under 60 characters, lowercase, no period. add a short body only if needed. reply with the message only.", &d).await?;
            Ok(json!({"message": m}))
        }
        "assistant.pr_description" => {
            let (_, dir) = item_dir(&svc.vault(), &s(p, "item_id")?)?;
            let log: Vec<String> = archival_git::log(&dir, 20).unwrap_or_default().into_iter().map(|c| c.summary).collect();
            let template = archival_github::pr_template(&dir).unwrap_or_default();
            let prompt = format!("recent commits:\n{}\n\ndiff:\n{}\n\ntemplate to follow (may be empty):\n{}", log.join("\n"), diff_text(&dir), template);
            let m = complete(svc, "write a pull request description in markdown. plain, specific, no filler. if a template is given, keep its headings.", &prompt).await?;
            Ok(json!({"body": m}))
        }
        "assistant.describe" => {
            let v = svc.vault();
            let it = v.item(&s(p, "item_id")?)?;
            let abs = v.abs(&it.path)?;
            let files: Vec<String> = archival_core::tree::walk_files(&abs).take(200).map(|f| archival_core::paths::relative(&abs, &f)).collect();
            let readme = ["README.md", "readme.md", "README"].iter().find_map(|r| std::fs::read_to_string(abs.join(r)).ok()).unwrap_or_default();
            let prompt = format!("files:\n{}\n\nreadme:\n{}", files.join("\n"), readme.chars().take(6000).collect::<String>());
            let m = complete(svc, "in two short lowercase sentences, say what this folder is and what it does. no marketing words.", &prompt).await?;
            Ok(json!({"summary": m}))
        }
        _ => Err(anyhow!("unknown method {method}")),
    }
}
