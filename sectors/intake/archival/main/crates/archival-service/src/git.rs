use crate::github::{account_for, auth_for};
use crate::{b, item_dir, os, s, strs, to, Service};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

pub fn call(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    let v = svc.vault();
    let id = s(p, "item_id")?;
    let (it, dir) = item_dir(&v, &id)?;
    let r = match method {
        "git.status" => to(archival_git::status(&dir)?),
        "git.diff" => to(archival_git::diff(&dir, os(p, "path").as_deref(), b(p, "staged"))?),
        "git.stage" => {
            archival_git::stage(&dir, &strs(p, "paths"))?;
            Ok(json!({"ok": true}))
        }
        "git.stage_all" => {
            archival_git::stage_all(&dir)?;
            Ok(json!({"ok": true}))
        }
        "git.unstage" => {
            archival_git::unstage(&dir, &strs(p, "paths"))?;
            Ok(json!({"ok": true}))
        }
        "git.discard" => {
            v.snapshot(&id, "before discard", "git")?;
            archival_git::discard(&dir, &s(p, "path")?)?;
            Ok(json!({"ok": true}))
        }
        "git.commit" => {
            let acct = account_for(svc, &it);
            let oid = archival_git::commit(
                &dir,
                &s(p, "message")?,
                acct.as_ref().map(|a| a.name.clone().unwrap_or_else(|| a.login.clone())).as_deref(),
                acct.as_ref().map(|a| a.email.as_str()),
            )?;
            Ok(json!({"commit": oid}))
        }
        "git.log" => to(archival_git::log(&dir, crate::n(p, "limit").unwrap_or(100) as usize)?),
        "git.branches" => to(archival_git::branches(&dir)?),
        "git.checkout" => {
            archival_git::checkout(&dir, &s(p, "name")?, b(p, "create"))?;
            Ok(json!({"ok": true}))
        }
        "git.init" => {
            if !it.is_dir {
                return Err(anyhow!("git needs a folder. this item is a single file"));
            }
            archival_git::init(&dir)?;
            Ok(json!({"ok": true}))
        }
        "git.set_remote" => {
            let url = s(p, "url")?;
            archival_git::set_remote(&dir, &os(p, "name").unwrap_or_else(|| "origin".into()), &url)?;
            v.patch(&id, &archival_core::ItemPatch { remote: Some(Some(url)), ..Default::default() })?;
            Ok(json!({"ok": true}))
        }
        "git.conflict" => to(archival_git::conflict(&dir, &s(p, "path")?)?),
        "git.resolve" => {
            archival_git::resolve(&dir, &s(p, "path")?, &s(p, "content")?)?;
            Ok(json!({"ok": true}))
        }
        "git.abort_merge" => {
            archival_git::abort_merge(&dir)?;
            Ok(json!({"ok": true}))
        }
        _ => Err(anyhow!("unknown method {method}")),
    };
    if method != "git.status" && method != "git.diff" && method != "git.log" && method != "git.branches" && method != "git.conflict" {
        let _ = v.reindex(&it);
    }
    r
}

pub async fn call_async(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    let v = svc.vault();
    let id = s(p, "item_id")?;
    let (it, dir) = item_dir(&v, &id)?;
    let auth = auth_for(svc, &it);
    let acct = account_for(svc, &it);
    let p = p.clone();
    let method = method.to_string();
    tokio::task::spawn_blocking(move || -> Result<Value> {
        match method.as_str() {
            "git.push" => {
                let st = archival_git::status(&dir)?;
                if st.remotes.is_empty() {
                    return Err(anyhow!("no remote yet. publish it to github or add a remote"));
                }
                let remote = os(&p, "remote").unwrap_or_else(|| st.remotes[0].name.clone());
                let branch = archival_git::push(&dir, &remote, None, &auth)?;
                Ok(json!({"pushed": branch, "remote": remote}))
            }
            "git.pull" => {
                v.snapshot(&id, "before pull", "git")?;
                let r = archival_git::pull(&dir, &os(&p, "remote").unwrap_or_else(|| "origin".into()), &auth)?;
                let _ = v.reindex(&it);
                to(r)
            }
            "git.ship" => {
                // the dock's primary action: stage everything, commit, push if there's a remote
                let msg = s(&p, "message")?;
                archival_git::stage_all(&dir)?;
                let oid = archival_git::commit(
                    &dir,
                    &msg,
                    acct.as_ref().map(|a| a.name.clone().unwrap_or_else(|| a.login.clone())).as_deref(),
                    acct.as_ref().map(|a| a.email.as_str()),
                )?;
                let st = archival_git::status(&dir)?;
                let pushed = match st.remotes.first() {
                    Some(r) => Some(archival_git::push(&dir, &r.name, None, &auth).map_err(|e| anyhow!("committed, but the push failed: {e}"))?),
                    None => None,
                };
                let _ = v.reindex(&it);
                Ok(json!({"commit": oid, "pushed": pushed}))
            }
            _ => Err(anyhow!("unknown method {method}")),
        }
    })
    .await?
}
