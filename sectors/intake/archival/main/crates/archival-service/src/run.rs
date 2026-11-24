use crate::{b, item_dir, n, os, s, to, Service};
use anyhow::{anyhow, Result};
use archival_core::ItemPatch;
use archival_run::detect::{container_command, wrap_with_mise};
use archival_run::{detect, StartSpec};
use base64::Engine;
use serde_json::{json, Value};

pub fn call(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    let v = svc.vault();
    let runs = &svc.inner.runs;
    match method {
        "run.detect" => {
            let id = s(p, "item_id")?;
            let it = v.item(&id)?;
            let abs = v.abs(&it.path)?;
            let det = detect(&abs);
            Ok(json!({
                "detection": det,
                "saved": {"command": it.run_command, "setup": it.run_setup, "mode": it.run_mode},
                "trusted": it.trusted,
                "origin": it.origin_connector,
            }))
        }
        "run.save" => {
            let id = s(p, "item_id")?;
            let patch = ItemPatch {
                run_command: Some(os(p, "command")),
                run_setup: Some(os(p, "setup")),
                run_mode: Some(os(p, "mode")),
                ..Default::default()
            };
            to(v.patch(&id, &patch)?)
        }
        "run.start" => {
            let id = s(p, "item_id")?;
            let (it, dir) = item_dir(&v, &id)?;
            let command = os(p, "command").or(it.run_command.clone()).ok_or_else(|| anyhow!("pick a command to run"))?;
            let setup = if b(p, "with_setup") { os(p, "setup").or(it.run_setup.clone()) } else { None };
            let mode = os(p, "mode").or(it.run_mode.clone()).unwrap_or_else(|| "local".into());
            let mut full = match &setup {
                Some(s) => format!("{s} && {command}"),
                None => command.clone(),
            };
            // safety: anything that came from outside shows its commands before the first run
            if !it.trusted && !b(p, "confirm") {
                let commands: Vec<String> = [setup, Some(command)].into_iter().flatten().collect();
                return Ok(json!({"needs_confirm": true, "commands": commands, "mode": mode, "cwd": dir}));
            }
            if !it.trusted {
                v.patch(&id, &ItemPatch { trusted: Some(true), ..Default::default() })?;
            }
            let abs = v.abs(&it.path)?;
            let det = detect(&abs);
            match mode.as_str() {
                "local" => {
                    // a missing toolchain is fetched by mise into the vault's toolchain folder
                    if let Some(tool) = det.tools.iter().find(|t| !t.installed && t.via_mise) {
                        if let Some(w) = wrap_with_mise(&full, &tool.tool, tool.version.as_deref()) {
                            full = w;
                        }
                    }
                }
                "container" => {
                    let plan = det.container.ok_or_else(|| anyhow!("couldn't work out a container image for this project"))?;
                    let engine = plan.engine.ok_or_else(|| anyhow!("container mode needs docker or podman installed"))?;
                    let ports: Vec<u16> = p.get("ports").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u16)).collect()).unwrap_or_default();
                    full = container_command(&engine, &plan.image, &dir, &full, !b(p, "no_network"), &ports);
                }
                "wasm" => return Err(anyhow!("wasm runs happen in the app window")),
                _ => return Err(anyhow!("unknown run mode {mode}")),
            }
            let mut env = vec![("MISE_DATA_DIR".to_string(), v.meta_dir().join("toolchains").to_string_lossy().to_string())];
            if let Some(obj) = p.get("env").and_then(|e| e.as_object()) {
                for (k, val) in obj {
                    if let Some(sv) = val.as_str() {
                        env.push((k.clone(), sv.to_string()));
                    }
                }
            }
            v.patch(&id, &ItemPatch { run_command: Some(Some(command.clone())), run_mode: Some(Some(mode.clone())), run_setup: Some(setup.clone().or(it.run_setup.clone())), ..Default::default() })?;
            let info = runs.start(StartSpec {
                item_id: id,
                cwd: dir,
                command: full,
                label: command,
                env,
                cols: n(p, "cols").unwrap_or(100) as u16,
                rows: n(p, "rows").unwrap_or(30) as u16,
            })?;
            to(info)
        }
        "run.terminal" => {
            let cwd = match os(p, "item_id") {
                Some(id) => item_dir(&v, &id)?.1,
                None => v.vault_dir().to_path_buf(),
            };
            let info = runs.start(StartSpec {
                item_id: os(p, "item_id").unwrap_or_default(),
                cwd,
                command: String::new(),
                label: "terminal".into(),
                env: vec![],
                cols: n(p, "cols").unwrap_or(100) as u16,
                rows: n(p, "rows").unwrap_or(30) as u16,
            })?;
            to(info)
        }
        "run.read" => {
            let out = runs.read(&s(p, "run_id")?, n(p, "since").unwrap_or(0))?;
            Ok(json!({"info": out.info, "next": out.next, "truncated": out.truncated, "data": base64::engine::general_purpose::STANDARD.encode(&out.data)}))
        }
        "run.write" => {
            runs.write(&s(p, "run_id")?, s(p, "data")?.as_bytes())?;
            Ok(json!({"ok": true}))
        }
        "run.resize" => {
            runs.resize(&s(p, "run_id")?, n(p, "cols").unwrap_or(100) as u16, n(p, "rows").unwrap_or(30) as u16)?;
            Ok(json!({"ok": true}))
        }
        "run.stop" => {
            runs.stop(&s(p, "run_id")?)?;
            Ok(json!({"ok": true}))
        }
        "run.remove" => {
            runs.remove(&s(p, "run_id")?)?;
            Ok(json!({"ok": true}))
        }
        "run.list" => to(runs.list()),
        _ => Err(anyhow!("unknown method {method}")),
    }
}
