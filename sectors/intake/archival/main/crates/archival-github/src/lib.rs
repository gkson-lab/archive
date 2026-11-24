//! github: accounts (token or device flow), repos, pull requests, gists.

pub mod secrets;

use anyhow::{anyhow, Context, Result};
use octocrab::Octocrab;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub login: String,
    pub name: Option<String>,
    /// address used as commit author. the github noreply address unless the profile email is public.
    pub email: String,
    pub avatar_url: Option<String>,
    pub id: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Repo {
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub private: bool,
    pub description: Option<String>,
    pub clone_url: String,
    pub html_url: String,
    pub default_branch: String,
    pub pushed_at: Option<String>,
    pub fork: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub html_url: String,
    pub state: String,
    pub draft: bool,
    pub head: String,
    pub base: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Gist {
    pub id: String,
    pub description: String,
    pub html_url: String,
    pub files: Vec<GistFile>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GistFile {
    pub filename: String,
    pub raw_url: String,
    pub size: u64,
}

pub fn token_key(login: &str) -> String {
    format!("github:{login}")
}

pub fn client(token: &str) -> Result<Octocrab> {
    Ok(Octocrab::builder().personal_token(token.to_string()).build()?)
}

fn err(e: octocrab::Error) -> anyhow::Error {
    match &e {
        octocrab::Error::GitHub { source, .. } => {
            let mut msg = source.message.clone();
            if let Some(errs) = &source.errors {
                for x in errs {
                    if let Some(m) = x.get("message").and_then(|m| m.as_str()) {
                        msg.push_str(&format!(". {m}"));
                    }
                }
            }
            anyhow!("github said: {}", msg.to_lowercase())
        }
        _ => anyhow!("github request failed: {e}"),
    }
}

pub async fn whoami(token: &str) -> Result<Account> {
    let gh = client(token)?;
    let u: Value = gh.get("/user", None::<&()>).await.map_err(err)?;
    let login = u["login"].as_str().ok_or_else(|| anyhow!("that token didn't return a user"))?.to_string();
    let id = u["id"].as_u64().unwrap_or(0);
    let email = u["email"].as_str().map(|s| s.to_string()).unwrap_or_else(|| format!("{id}+{login}@users.noreply.github.com"));
    Ok(Account { name: u["name"].as_str().map(|s| s.to_string()), avatar_url: u["avatar_url"].as_str().map(|s| s.to_string()), login, email, id })
}

fn repo_from(v: &Value) -> Repo {
    Repo {
        full_name: v["full_name"].as_str().unwrap_or("").into(),
        name: v["name"].as_str().unwrap_or("").into(),
        owner: v["owner"]["login"].as_str().unwrap_or("").into(),
        private: v["private"].as_bool().unwrap_or(false),
        description: v["description"].as_str().map(|s| s.to_string()),
        clone_url: v["clone_url"].as_str().unwrap_or("").into(),
        html_url: v["html_url"].as_str().unwrap_or("").into(),
        default_branch: v["default_branch"].as_str().unwrap_or("main").into(),
        pushed_at: v["pushed_at"].as_str().map(|s| s.to_string()),
        fork: v["fork"].as_bool().unwrap_or(false),
    }
}

pub async fn list_repos(token: &str, page: u32) -> Result<(Vec<Repo>, bool)> {
    let gh = client(token)?;
    let v: Value = gh
        .get("/user/repos", Some(&json!({"per_page": 100, "page": page.max(1), "sort": "pushed", "affiliation": "owner,collaborator,organization_member"})))
        .await
        .map_err(err)?;
    let list: Vec<Repo> = v.as_array().map(|a| a.iter().map(repo_from).collect()).unwrap_or_default();
    let more = list.len() == 100;
    Ok((list, more))
}

pub async fn get_repo(token: &str, owner: &str, repo: &str) -> Result<Repo> {
    let gh = client(token)?;
    let v: Value = gh.get(format!("/repos/{owner}/{repo}"), None::<&()>).await.map_err(err)?;
    Ok(repo_from(&v))
}

pub async fn create_repo(token: &str, owner: Option<&str>, name: &str, private: bool, description: &str) -> Result<Repo> {
    let gh = client(token)?;
    let body = json!({ "name": name, "private": private, "description": description, "auto_init": false });
    let route = match owner {
        Some(org) => format!("/orgs/{org}/repos"),
        None => "/user/repos".to_string(),
    };
    let v: Value = gh.post(route, Some(&body)).await.map_err(err)?;
    Ok(repo_from(&v))
}

fn pr_from(v: &Value) -> PullRequest {
    PullRequest {
        number: v["number"].as_u64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").into(),
        html_url: v["html_url"].as_str().unwrap_or("").into(),
        state: v["state"].as_str().unwrap_or("").into(),
        draft: v["draft"].as_bool().unwrap_or(false),
        head: v["head"]["ref"].as_str().unwrap_or("").into(),
        base: v["base"]["ref"].as_str().unwrap_or("").into(),
    }
}

pub async fn create_pr(token: &str, owner: &str, repo: &str, title: &str, body: &str, head: &str, base: &str, draft: bool) -> Result<PullRequest> {
    if title.trim().is_empty() {
        return Err(anyhow!("give the pull request a title"));
    }
    let gh = client(token)?;
    let v: Value = gh
        .post(format!("/repos/{owner}/{repo}/pulls"), Some(&json!({"title": title, "body": body, "head": head, "base": base, "draft": draft})))
        .await
        .map_err(err)?;
    Ok(pr_from(&v))
}

/// open pull requests whose head is `branch`
pub async fn prs_for_branch(token: &str, owner: &str, repo: &str, branch: &str) -> Result<Vec<PullRequest>> {
    let gh = client(token)?;
    let v: Value = gh
        .get(format!("/repos/{owner}/{repo}/pulls"), Some(&json!({"state": "open", "head": format!("{owner}:{branch}")})))
        .await
        .map_err(err)?;
    Ok(v.as_array().map(|a| a.iter().map(pr_from).collect()).unwrap_or_default())
}

pub async fn list_gists(token: &str) -> Result<Vec<Gist>> {
    let gh = client(token)?;
    let v: Value = gh.get("/gists", Some(&json!({"per_page": 100}))).await.map_err(err)?;
    Ok(v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|g| Gist {
                    id: g["id"].as_str().unwrap_or("").into(),
                    description: g["description"].as_str().unwrap_or("").into(),
                    html_url: g["html_url"].as_str().unwrap_or("").into(),
                    updated_at: g["updated_at"].as_str().unwrap_or("").into(),
                    files: g["files"]
                        .as_object()
                        .map(|f| {
                            f.values()
                                .map(|x| GistFile {
                                    filename: x["filename"].as_str().unwrap_or("").into(),
                                    raw_url: x["raw_url"].as_str().unwrap_or("").into(),
                                    size: x["size"].as_u64().unwrap_or(0),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default())
}

pub async fn download(token: Option<&str>, url: &str) -> Result<Vec<u8>> {
    let c = reqwest::Client::builder().user_agent("archival/0.1").build()?;
    let mut r = c.get(url);
    if let Some(t) = token {
        r = r.bearer_auth(t);
    }
    Ok(r.send().await?.error_for_status()?.bytes().await?.to_vec())
}

// device flow (needs an oauth app client id, set in settings as github.client_id)

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub async fn device_start(client_id: &str) -> Result<DeviceCode> {
    let c = reqwest::Client::new();
    let r = c
        .post("https://github.com/login/device/code")
        .header("accept", "application/json")
        .form(&[("client_id", client_id), ("scope", "repo gist read:user")])
        .send()
        .await?
        .error_for_status()?;
    r.json::<DeviceCode>().await.context("github didn't return a device code")
}

/// Ok(None) while the user hasn't approved yet
pub async fn device_poll(client_id: &str, device_code: &str) -> Result<Option<String>> {
    let c = reqwest::Client::new();
    let v: Value = c
        .post("https://github.com/login/oauth/access_token")
        .header("accept", "application/json")
        .form(&[("client_id", client_id), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")])
        .send()
        .await?
        .json()
        .await?;
    if let Some(t) = v["access_token"].as_str() {
        return Ok(Some(t.to_string()));
    }
    match v["error"].as_str() {
        Some("authorization_pending") | Some("slow_down") => Ok(None),
        Some("expired_token") => Err(anyhow!("the code expired. start sign in again")),
        Some("access_denied") => Err(anyhow!("sign in was cancelled on github")),
        Some(e) => Err(anyhow!("github sign in failed: {e}")),
        None => Ok(None),
    }
}

/// a pull request template from the repo, if it has one
pub fn pr_template(dir: &Path) -> Option<String> {
    let candidates = [
        ".github/pull_request_template.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "pull_request_template.md",
        "PULL_REQUEST_TEMPLATE.md",
        "docs/pull_request_template.md",
        "docs/PULL_REQUEST_TEMPLATE.md",
    ];
    for c in candidates {
        if let Ok(s) = std::fs::read_to_string(dir.join(c)) {
            return Some(s);
        }
    }
    let multi = dir.join(".github/PULL_REQUEST_TEMPLATE");
    std::fs::read_dir(multi)
        .ok()?
        .filter_map(|e| e.ok())
        .find(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
        .and_then(|e| std::fs::read_to_string(e.path()).ok())
}
