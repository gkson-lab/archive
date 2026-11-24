use crate::{os, s, to, Service};
use anyhow::{anyhow, Result};
use archival_connectors::{build, kinds, BuildArgs, Connector, RemoteEntry};
use archival_github::secrets;
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct ConnectorRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub config: Value,
    pub state: Value,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
    pub created: i64,
}

pub fn rows(svc: &Service) -> Result<Vec<ConnectorRow>> {
    let v = svc.vault();
    let c = v.db();
    let mut st = c.prepare("SELECT id, kind, name, config, state, last_sync, last_error, created FROM connectors ORDER BY created")?;
    let out = st
        .query_map([], |r| {
            Ok(ConnectorRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                config: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(json!({})),
                state: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(json!({})),
                last_sync: r.get(5)?,
                last_error: r.get(6)?,
                created: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

pub fn row(svc: &Service, id: &str) -> Result<ConnectorRow> {
    rows(svc)?.into_iter().find(|r| r.id == id).ok_or_else(|| anyhow!("that connector is gone"))
}

fn secret_key(id: &str) -> String {
    format!("connector:{id}")
}

pub fn instance(_svc: &Service, r: &ConnectorRow) -> Result<Box<dyn Connector>> {
    let github_token = r.config.get("account").and_then(|a| a.as_str()).and_then(crate::github::token_for);
    build(BuildArgs { kind: r.kind.clone(), config: r.config.clone(), secret: secrets::get(&secret_key(&r.id)).ok().flatten(), github_token })
}

pub fn record(svc: &Service, id: &str, err: Option<String>) {
    let v = svc.vault();
    let _ = v.db().execute("UPDATE connectors SET last_sync = ?2, last_error = ?3 WHERE id = ?1", params![id, archival_core::now(), err]);
}

pub fn set_state(svc: &Service, id: &str, state: &Value) -> Result<()> {
    svc.vault().db().execute("UPDATE connectors SET state = ?2 WHERE id = ?1", params![id, state.to_string()])?;
    Ok(())
}

pub fn call(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    match method {
        "connectors.kinds" => to(kinds()),
        "connectors.list" => to(rows(svc)?),
        "connectors.remove" => {
            let id = s(p, "id")?;
            let _ = secrets::delete(&secret_key(&id));
            svc.inner.watchers.lock().unwrap().remove(&id);
            svc.vault().db().execute("DELETE FROM connectors WHERE id = ?1", [&id])?;
            Ok(json!({"ok": true}))
        }
        _ => Err(anyhow!("unknown method {method}")),
    }
}

pub async fn call_async(svc: &Service, method: &str, p: &Value) -> Result<Value> {
    match method {
        "connectors.add" => {
            let kind = s(p, "kind")?;
            let info = kinds().into_iter().find(|k| k.kind == kind).ok_or_else(|| anyhow!("unknown connector {kind}"))?;
            let mut config = p.get("config").cloned().unwrap_or(json!({}));
            // secrets never go into the index
            let secret = config.get("token").and_then(|t| t.as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
            if let Some(o) = config.as_object_mut() {
                o.remove("token");
            }
            for f in &info.fields {
                if f.required && !f.secret && config.get(f.key).and_then(|x| x.as_str()).map(|x| x.trim().is_empty()).unwrap_or(true) {
                    return Err(anyhow!("{} is required", f.label));
                }
                if f.required && f.secret && secret.is_none() {
                    return Err(anyhow!("{} is required", f.label));
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            if let Some(sec) = &secret {
                secrets::set(&secret_key(&id), sec)?;
            }
            let name = os(p, "name").unwrap_or_else(|| info.name.to_string());
            let r = ConnectorRow { id: id.clone(), kind: kind.clone(), name: name.clone(), config: config.clone(), state: json!({}), last_sync: None, last_error: None, created: archival_core::now() };
            // check it works before saving
            let check = match instance(svc, &r) {
                Ok(c) => c.auth().await,
                Err(e) => Err(e),
            };
            match check {
                Ok(a) if a.ok => {}
                Ok(_) => {
                    let _ = secrets::delete(&secret_key(&id));
                    return Err(anyhow!("that folder doesn't exist or can't be read"));
                }
                Err(e) => {
                    let _ = secrets::delete(&secret_key(&id));
                    return Err(e);
                }
            }
            svc.vault().db().execute(
                "INSERT INTO connectors (id, kind, name, config, state, created) VALUES (?1,?2,?3,?4,'{}',?5)",
                params![id, kind, name, config.to_string(), r.created],
            )?;
            crate::watch::start(svc, &id);
            to(row(svc, &id)?)
        }
        "connectors.test" => {
            let r = row(svc, &s(p, "id")?)?;
            let res = instance(svc, &r)?.auth().await;
            record(svc, &r.id, res.as_ref().err().map(|e| format!("{e:#}")));
            to(res?)
        }
        "connectors.browse" => {
            let r = row(svc, &s(p, "id")?)?;
            let res = instance(svc, &r)?.list(os(p, "folder"), os(p, "page")).await;
            record(svc, &r.id, res.as_ref().err().map(|e| format!("{e:#}")));
            to(res?)
        }
        "connectors.pull" => {
            let r = row(svc, &s(p, "id")?)?;
            let entry: RemoteEntry = serde_json::from_value(p.get("entry").cloned().ok_or_else(|| anyhow!("missing entry"))?)?;
            let c = instance(svc, &r)?;
            let jid = svc.job_new("pull", &format!("pulling {} from {}", entry.name, r.name), 1, vec![]);
            let svc2 = svc.clone();
            let job = jid.clone();
            tokio::spawn(async move {
                let res = c.pull(svc2.vault(), &entry).await;
                record(&svc2, &r.id, res.as_ref().err().map(|e| format!("{e:#}")));
                svc2.job_finish(&job, res.and_then(to));
            });
            Ok(json!({"job": jid}))
        }
        "connectors.push" => {
            let r = row(svc, &s(p, "id")?)?;
            let v = svc.vault();
            let it = v.item(&s(p, "item_id")?)?;
            let res = instance(svc, &r)?.push(v, &it, os(p, "target")).await;
            record(svc, &r.id, res.as_ref().err().map(|e| format!("{e:#}")));
            to(res?)
        }
        "connectors.sync" => {
            let id = s(p, "id")?;
            crate::watch::sync_now(svc, &id).await
        }
        _ => Err(anyhow!("unknown method {method}")),
    }
}
