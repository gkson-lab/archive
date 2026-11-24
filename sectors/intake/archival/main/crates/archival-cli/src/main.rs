//! `archival`: the vault from a terminal, an mcp server for agents, and a local bridge.

mod serve;

use anyhow::{anyhow, Result};
use archival_service::Service;
use base64::Engine;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser)]
#[command(name = "archival", version, about = "one vault for everything you build. a gk labs tool.")]
struct Cli {
    /// vault folder (defaults to the configured vault, or ~/archival)
    #[arg(long, global = true, env = "ARCHIVAL_VAULT")]
    vault: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// create or open a vault and make it the default
    Init { path: Option<PathBuf> },
    /// import a folder, file, zip or url into the inbox
    Add {
        target: String,
        #[arg(long)]
        title: Option<String>,
        /// file it straight away instead of leaving it in the inbox
        #[arg(long)]
        file: bool,
    },
    /// list items (optionally one folder: projects, docs, designs, snippets, assets, links, inbox)
    Ls { category: Option<String> },
    /// search names, or contents with --contents
    Search {
        query: String,
        #[arg(long, short)]
        contents: bool,
    },
    /// print where an item lives (and open the desktop app on it if installed)
    Open { item: String },
    /// run an item's command in this terminal
    Run {
        item: String,
        /// command to run instead of the detected or saved one
        #[arg(long)]
        command: Option<String>,
        #[arg(long, short)]
        yes: bool,
    },
    /// commit everything and push. with --pr, open a pull request too
    Ship {
        item: String,
        #[arg(long, short)]
        message: String,
        #[arg(long)]
        pr: bool,
        #[arg(long)]
        title: Option<String>,
    },
    /// snapshot an item
    Snapshot {
        item: String,
        #[arg(long, short)]
        label: Option<String>,
    },
    /// run the mcp server on stdio for ai agents
    Mcp,
    /// local http bridge for the browser ui (127.0.0.1 only, token protected)
    Serve {
        #[arg(long, default_value_t = 7311)]
        port: u16,
        /// serve a built ui folder too
        #[arg(long)]
        ui: Option<PathBuf>,
    },
    /// call any api method with json params (for scripting)
    Api { method: String, params: Option<String> },
}

fn print(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

async fn wait_job(svc: &Service, v: Value) -> Result<Value> {
    let Some(job) = v.get("job").and_then(|j| j.as_str()).map(|s| s.to_string()) else { return Ok(v) };
    let mut last = 0;
    loop {
        let j = svc.call("jobs.get", json!({"id": job})).await?;
        let done = j["done"].as_u64().unwrap_or(0);
        let total = j["total"].as_u64().unwrap_or(0);
        if total > 0 && done != last {
            eprint!("\r{} {done} of {total}", j["label"].as_str().unwrap_or(""));
            last = done;
        }
        match j["status"].as_str() {
            Some("done") => {
                if total > 0 {
                    eprintln!();
                }
                return Ok(j["result"].clone());
            }
            Some("error") => return Err(anyhow!("{}", j["error"].as_str().unwrap_or("failed"))),
            _ => tokio::time::sleep(Duration::from_millis(120)).await,
        }
    }
}

async fn resolve(svc: &Service, s: &str) -> Result<Value> {
    if let Ok(it) = svc.call("item.get", json!({"id": s})).await {
        return Ok(it);
    }
    let v = svc.vault();
    if let Some(it) = v.item_for_path(s.trim_matches('/'))? {
        return Ok(serde_json::to_value(it)?);
    }
    let hits = v.search(s, false)?;
    let mut ids: Vec<String> = hits.iter().map(|h| h.item_id.clone()).collect();
    ids.dedup();
    match ids.len() {
        0 => Err(anyhow!("no item matches {s}")),
        1 => svc.call("item.get", json!({"id": ids[0]})).await,
        _ => {
            let exact = hits.iter().find(|h| h.title.eq_ignore_ascii_case(s));
            match exact {
                Some(h) => svc.call("item.get", json!({"id": h.item_id})).await,
                None => Err(anyhow!("{s} matches several items: {}", hits.iter().map(|h| h.title.as_str()).collect::<Vec<_>>().join(", "))),
            }
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("archival: {e:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    if let Cmd::Init { path } = &cli.cmd {
        let root = path.clone().or(cli.vault.clone()).unwrap_or_else(archival_core::vault::default_root);
        let svc = Service::open(Some(root.clone()))?;
        let mut cfg = archival_core::vault::AppConfig::load();
        cfg.vault_root = Some(root.canonicalize()?);
        cfg.save()?;
        print(&svc.call("vault.info", json!({})).await?);
        return Ok(());
    }
    let svc = Service::open(cli.vault.clone())?;
    match cli.cmd {
        Cmd::Init { .. } => unreachable!(),
        Cmd::Add { target, title, file } => {
            let r = if target.starts_with("http://") || target.starts_with("https://") {
                svc.call("ingest.url", json!({"url": target})).await?
            } else {
                let p = PathBuf::from(&target).canonicalize().map_err(|_| anyhow!("can't find {target}"))?;
                svc.call("ingest.paths", json!({"paths": [p], "title": title})).await?
            };
            let r = wait_job(&svc, r).await?;
            let first = if r.is_array() { r[0].clone() } else { r };
            let mut item = first["item"].clone();
            if let Some(d) = first.get("duplicate_of").filter(|d| !d.is_null()) {
                eprintln!("note: same contents as {} ({})", d["title"].as_str().unwrap_or(""), d["path"].as_str().unwrap_or(""));
            }
            if file {
                item = svc.call("item.file", json!({"id": item["id"]})).await?;
            }
            println!("{}  {}", item["path"].as_str().unwrap_or(""), item["kind"].as_str().unwrap_or(""));
        }
        Cmd::Ls { category } => {
            let items = svc.call("items.list", json!({"category": category})).await?;
            for it in items.as_array().cloned().unwrap_or_default() {
                println!("{:<10} {:<44} {}", it["kind"].as_str().unwrap_or(""), it["path"].as_str().unwrap_or(""), it["tags"].as_array().map(|t| t.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default());
            }
        }
        Cmd::Search { query, contents } => {
            let hits = svc.call("search", json!({"q": query, "contents": contents})).await?;
            for h in hits.as_array().cloned().unwrap_or_default() {
                let snip = h["snippet"].as_str().unwrap_or("").replace('\u{2}', "\x1b[1m").replace('\u{3}', "\x1b[0m").replace('\n', " ");
                println!("{}  {}", h["path"].as_str().unwrap_or(""), snip);
            }
        }
        Cmd::Open { item } => {
            let it = resolve(&svc, &item).await?;
            let abs = svc.call("file.abs", json!({"path": it["path"]})).await?;
            svc.call("item.opened", json!({"id": it["id"]})).await?;
            println!("{}", abs["path"].as_str().unwrap_or(""));
            let exe = std::env::current_exe()?;
            let app = exe.with_file_name(if cfg!(windows) { "archival-desktop.exe" } else { "archival-desktop" });
            if app.exists() {
                let _ = std::process::Command::new(app).arg("--open").arg(it["id"].as_str().unwrap_or("")).spawn();
            }
        }
        Cmd::Run { item, command, yes } => {
            let it = resolve(&svc, &item).await?;
            let id = it["id"].as_str().unwrap_or("").to_string();
            let det = svc.call("run.detect", json!({"item_id": id})).await?;
            let cmd = command
                .or(det["saved"]["command"].as_str().map(|s| s.to_string()))
                .or(det["detection"]["candidates"][0]["command"].as_str().map(|s| s.to_string()))
                .ok_or_else(|| anyhow!("couldn't find how to run this. pass --command"))?;
            let mut r = svc.call("run.start", json!({"item_id": id, "command": cmd})).await?;
            if r["needs_confirm"] == true {
                eprintln!("this came from outside the vault. it will run:");
                for c in r["commands"].as_array().cloned().unwrap_or_default() {
                    eprintln!("  {}", c.as_str().unwrap_or(""));
                }
                if !yes {
                    eprint!("run it? [y/N] ");
                    std::io::stderr().flush()?;
                    let mut line = String::new();
                    std::io::stdin().lock().read_line(&mut line)?;
                    if !line.trim().eq_ignore_ascii_case("y") {
                        return Ok(());
                    }
                }
                r = svc.call("run.start", json!({"item_id": id, "command": cmd, "confirm": true})).await?;
            }
            let run_id = r["id"].as_str().unwrap_or("").to_string();
            let mut since = 0u64;
            let mut stdout = std::io::stdout();
            loop {
                let out = svc.call("run.read", json!({"run_id": run_id, "since": since})).await?;
                since = out["next"].as_u64().unwrap_or(since);
                let data = base64::engine::general_purpose::STANDARD.decode(out["data"].as_str().unwrap_or(""))?;
                stdout.write_all(&data)?;
                stdout.flush()?;
                if out["info"]["ended"].is_number() {
                    let code = out["info"]["exit_code"].as_i64().unwrap_or(1);
                    svc.shutdown();
                    std::process::exit(code as i32);
                }
                tokio::time::sleep(Duration::from_millis(60)).await;
            }
        }
        Cmd::Ship { item, message, pr, title } => {
            let it = resolve(&svc, &item).await?;
            let r = svc.call("git.ship", json!({"item_id": it["id"], "message": message})).await?;
            println!("committed {}", &r["commit"].as_str().unwrap_or("")[..7.min(r["commit"].as_str().unwrap_or("").len())]);
            if let Some(b) = r["pushed"].as_str() {
                println!("pushed {b}");
            }
            if pr {
                let pr = svc.call("github.open_pr", json!({"item_id": it["id"], "title": title.unwrap_or(message)})).await?;
                println!("opened pr #{}  {}", pr["number"], pr["html_url"].as_str().unwrap_or(""));
            }
        }
        Cmd::Snapshot { item, label } => {
            let it = resolve(&svc, &item).await?;
            let s = svc.call("snapshot.create", json!({"item_id": it["id"], "label": label})).await?;
            println!("snapshot {}  {} files", s["label"].as_str().unwrap_or(""), s["file_count"]);
        }
        Cmd::Mcp => {
            svc.start_background();
            archival_mcp::serve_stdio(svc.clone()).await?;
        }
        Cmd::Serve { port, ui } => {
            svc.start_background();
            serve::serve(svc.clone(), port, ui).await?;
        }
        Cmd::Api { method, params } => {
            let p: Value = match params {
                Some(s) => serde_json::from_str(&s)?,
                None => json!({}),
            };
            let r = svc.call(&method, p).await?;
            print(&wait_job(&svc, r).await?);
        }
    }
    svc.shutdown();
    Ok(())
}
