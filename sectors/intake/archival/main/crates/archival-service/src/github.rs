use crate::{b, item_dir, n, os, s, to, Service};
use anyhow::{anyhow, Result};
use archival_core::{Item, ItemPatch, Vault};
use archival_github::{secrets, token_key, Account};
use serde_json::{json, Value};

pub fn accounts(v: &Vault) -> Vec<Account> {
    v.setting("github.accounts").ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_accounts(v: &Vault, a: &[Account]) -> Result<()> {
    v.set_setting("github.accounts", &serde_json::to_string(a)?)?;
    Ok(())
}

pub fn default_login(v: &Vault) -> Option<String> {
    v.setting("github.default")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<String>(&s).ok())
        .or_else(|| accounts(v).first().map(|a| a.login.clone()))
}

pub fn token_for(login: &str) -> Option<String> {
    secrets::get(&token_key(login)).ok().flatten()
}

/// the account an item uses: its own, else the default
pub fn account_for(svc: &Service, it: &Item) -> Option<Account> {
    let v = svc.vault();
    let login = it.account.clone().or_else(|| default_login(&v))?;
    accounts(&v).into_iter().find(|a| a.login == login)
}

pub fn auth_for(svc: &Service, it: &Item) -> archival_git::Auth {
    let is_github = it.remote.as_deref().map(|r| r.contains("github.com")).unwrap_or(true);
    let token = if is_github { account_for(svc, it).and_then(|a| token_for(&a.login)) } else { None };
    archival_git::Auth { token, username: None }
}

fn login_param(svc: &Service, p: &Value) -> Result<(String, String)> {
    let v = svc.vault();
    let login = os(p, "login").or_else(|| default_login(&v)).ok_or_else(|| anyhow!("sign in to github first"))?;
    let token = token_for(&login).ok_or_else(|| anyhow!("the token for {login} is missing. sign in again"))?;
    Ok((login, token))
}

async fn add_account(svc: &Service, token: &str) -> Result<Account> {
    let acct = archival_github::whoami(token).await?;
    secrets::set(&token_key(&acct.login), token)?;
    let v = svc.vault();
    let mut all = accounts(&v);
    all.retain(|a| a.login != acct.login);
    all.push(acct.clone());
    save_accounts(&v, &all)?;
    if all.len() == 1 {
        v.set_setting("github.default", &serde_json::to_string(&acct.login)?)?;
    }
    Ok(acct)
}

fn client_id(v: &Vault) -> Option<String> {
    std::env::var("ARCHIVAL_GITHUB_CLIENT_ID")
        .ok()
        .or_else(|| v.setting("github.client_id").ok().flatten().and_then(|s| serde_json::from_str::<String>(&s).ok()))
        .filter(|s| !s.is_empty())
}

pub fn call_sync(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    let v = svc.vault();
    match method {
        "github.pr_template" => {
            let (_, dir) = item_dir(&v, &s(p, "item_id")?)?;
            Ok(json!({"template": archival_github::pr_template(&dir)}))
        }
        "github.pr_draft_get" => {
            let id = s(p, "item_id")?;
            let row = v
                .db()
                .query_row("SELECT title, body, base, head FROM pr_drafts WHERE item_id = ?1", [&id], |r| {
                    Ok(json!({"title": r.get::<_, String>(0)?, "body": r.get::<_, String>(1)?, "base": r.get::<_, String>(2)?, "head": r.get::<_, String>(3)?}))
                })
                .ok();
            Ok(row.unwrap_or(Value::Null))
        }
        "github.pr_draft_save" => {
            let id = s(p, "item_id")?;
            v.db().execute(
                "INSERT INTO pr_drafts (item_id, title, body, base, head, updated) VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(item_id) DO UPDATE SET title=excluded.title, body=excluded.body, base=excluded.base, head=excluded.head, updated=excluded.updated",
                rusqlite::params![id, os(p, "title").unwrap_or_default(), os(p, "body").unwrap_or_default(), os(p, "base").unwrap_or_default(), os(p, "head").unwrap_or_default(), archival_core::now()],
            )?;
            Ok(json!({"ok": true}))
        }
        "github.pr_draft_delete" => {
            v.db().execute("DELETE FROM pr_drafts WHERE item_id = ?1", [s(p, "item_id")?])?;
            Ok(json!({"ok": true}))
        }
        "github.device_available" => Ok(json!({"available": client_id(&v).is_some()})),
        _ => Err(anyhow!("unknown method {method}")),
    }
}

pub async fn call(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    let v = svc.vault();
    match method {
        "github.accounts" => {
            let all = accounts(&v);
            let def = default_login(&v);
            Ok(Value::Array(
                all.into_iter()
                    .map(|a| {
                        let has = token_for(&a.login).is_some();
                        json!({"account": a, "default": def.as_deref() == Some(a.login.as_str()), "token": has})
                    })
                    .collect(),
            ))
        }
        "github.add_token" => to(add_account(svc, s(p, "token")?.trim()).await?),
        "github.remove" => {
            let login = s(p, "login")?;
            secrets::delete(&token_key(&login))?;
            let mut all = accounts(&v);
            all.retain(|a| a.login != login);
            save_accounts(&v, &all)?;
            Ok(json!({"ok": true}))
        }
        "github.set_default" => {
            v.set_setting("github.default", &serde_json::to_string(&s(p, "login")?)?)?;
            Ok(json!({"ok": true}))
        }
        "github.device_start" => {
            let id = client_id(&v).ok_or_else(|| anyhow!("device sign in needs an oauth app client id in settings. paste a token instead"))?;
            to(archival_github::device_start(&id).await?)
        }
        "github.device_poll" => {
            let id = client_id(&v).ok_or_else(|| anyhow!("no client id"))?;
            match archival_github::device_poll(&id, &s(p, "device_code")?).await? {
                Some(token) => Ok(json!({"account": add_account(svc, &token).await?})),
                None => Ok(json!({"pending": true})),
            }
        }
        "github.repos" => {
            let (_, token) = login_param(svc, p)?;
            let (repos, more) = archival_github::list_repos(&token, n(p, "page").unwrap_or(1) as u32).await?;
            Ok(json!({"repos": repos, "more": more}))
        }
        "github.prs" => {
            let (it, dir) = item_dir(&v, &s(p, "item_id")?)?;
            let Some((owner, repo)) = it.remote.as_deref().and_then(archival_git::github_slug) else { return Ok(json!([])) };
            let Some(acct) = account_for(svc, &it) else { return Ok(json!([])) };
            let Some(token) = token_for(&acct.login) else { return Ok(json!([])) };
            let branch = archival_git::current_branch(&dir).unwrap_or_default();
            to(archival_github::prs_for_branch(&token, &owner, &repo, &branch).await?)
        }
        "github.clone" => {
            let (login, token) = login_param(svc, p)?;
            let url = s(p, "url")?;
            let id = svc.job_new("clone", &format!("cloning {}", url.trim_end_matches(".git").rsplit('/').next().unwrap_or("repo")), 1, vec![]);
            let svc2 = svc.clone();
            let jid = id.clone();
            tokio::spawn(async move {
                let v = svc2.vault();
                let r = async {
                    let mut ing = archival_connectors_clone(v.clone(), url, token).await?;
                    ing.item = v.patch(&ing.item.id, &ItemPatch { account: Some(Some(login)), ..Default::default() })?;
                    to(ing)
                }
                .await;
                svc2.job_finish(&jid, r);
            });
            Ok(json!({"job": id}))
        }
        "github.publish" => publish(svc, p),
        "github.open_pr" => open_pr(svc, p).await,
        _ => Err(anyhow!("unknown method {method}")),
    }
}

async fn archival_connectors_clone(v: std::sync::Arc<Vault>, url: String, token: String) -> Result<archival_ingest::Ingested> {
    let entry = archival_connectors::RemoteEntry {
        id: format!("repo:{url}"),
        name: url.trim_end_matches(".git").rsplit('/').next().unwrap_or("repo").to_string(),
        kind: "repo".into(),
        size: None,
        updated: None,
        description: None,
        browsable: false,
    };
    let c = archival_connectors::build(archival_connectors::BuildArgs {
        kind: "github".into(),
        config: json!({"account": "-"}),
        secret: None,
        github_token: Some(token),
    })?;
    c.pull(v, &entry).await
}

/// publish as new repo: init, first commit, create on github, push. runs as a 4 step job.
fn publish(svc: &Service, p: &Value) -> Result<Value> {
    let v = svc.vault();
    let id = s(p, "item_id")?;
    let (it, dir) = item_dir(&v, &id)?;
    if !it.is_dir {
        return Err(anyhow!("publishing needs a folder. this item is a single file"));
    }
    if it.local_only {
        return Err(anyhow!("this item is marked local only"));
    }
    let (login, token) = login_param(svc, p)?;
    let name = os(p, "name").unwrap_or_else(|| slug::slugify(&it.title));
    let private = p.get("private").and_then(|x| x.as_bool()).unwrap_or(true);
    let description = os(p, "description").unwrap_or_default();
    let owner = os(p, "owner").filter(|o| o != &login);
    let steps = vec!["prepare git".to_string(), "first commit".into(), "create repo on github".into(), "push".into()];
    let jid = svc.job_new("publish", &format!("publishing {name}"), steps.len(), steps);
    let svc2 = svc.clone();
    let job = jid.clone();
    tokio::spawn(async move {
        let r: Result<Value> = async {
            let v = svc2.vault();
            let acct = archival_github::whoami(&token).await?;
            if !archival_git::is_repo(&dir) {
                archival_git::init(&dir)?;
            }
            svc2.job_progress(&job, 1, 4);
            archival_git::stage_all(&dir)?;
            let st = archival_git::status(&dir)?;
            if st.head.is_none() || st.files.iter().any(|f| !f.staged.is_empty()) {
                archival_git::commit(&dir, "first commit", Some(acct.name.as_deref().unwrap_or(&acct.login)), Some(&acct.email))?;
            }
            svc2.job_progress(&job, 2, 4);
            let repo = archival_github::create_repo(&token, owner.as_deref(), &name, private, &description).await?;
            svc2.job_progress(&job, 3, 4);
            archival_git::set_remote(&dir, "origin", &repo.clone_url)?;
            let auth = archival_git::Auth { token: Some(token.clone()), username: None };
            let d2 = dir.clone();
            let branch = tokio::task::spawn_blocking(move || archival_git::push(&d2, "origin", None, &auth)).await??;
            v.patch(&id, &ItemPatch { remote: Some(Some(repo.clone_url.clone())), account: Some(Some(login.clone())), ..Default::default() })?;
            svc2.job_progress(&job, 4, 4);
            Ok(json!({"repo": repo, "branch": branch}))
        }
        .await;
        svc2.job_finish(&job, r);
    });
    Ok(json!({"job": jid}))
}

async fn open_pr(svc: &Service, p: &Value) -> Result<Value> {
    let v = svc.vault();
    let id = s(p, "item_id")?;
    let (it, dir) = item_dir(&v, &id)?;
    let (owner, repo) = it
        .remote
        .as_deref()
        .and_then(archival_git::github_slug)
        .ok_or_else(|| anyhow!("this item isn't linked to a github repo. publish it first"))?;
    let acct = account_for(svc, &it).ok_or_else(|| anyhow!("sign in to github first"))?;
    let token = token_for(&acct.login).ok_or_else(|| anyhow!("the token for {} is missing. sign in again", acct.login))?;
    let title = s(p, "title")?;
    let body = os(p, "body").unwrap_or_default();
    let base = match os(p, "base") {
        Some(b) => b,
        None => archival_github::get_repo(&token, &owner, &repo).await?.default_branch,
    };
    let mut head = os(p, "head").or_else(|| archival_git::current_branch(&dir)).unwrap_or_else(|| "main".into());
    let auth = archival_git::Auth { token: Some(token.clone()), username: None };
    if head == base {
        // on the base branch: move the work to a new branch named after the title
        let branch = slug::slugify(&title).chars().take(48).collect::<String>();
        let branch = if branch.is_empty() { format!("change-{}", &uuid::Uuid::new_v4().to_string()[..6]) } else { branch };
        archival_git::checkout(&dir, &branch, true)?;
        head = branch;
    }
    let d2 = dir.clone();
    let h2 = head.clone();
    tokio::task::spawn_blocking(move || archival_git::push(&d2, "origin", Some(&h2), &auth)).await??;
    let pr = archival_github::create_pr(&token, &owner, &repo, &title, &body, &head, &base, b(p, "draft")).await?;
    v.db().execute("DELETE FROM pr_drafts WHERE item_id = ?1", [&id])?;
    to(pr)
}
