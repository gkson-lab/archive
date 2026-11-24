//! the home screen: what you were last doing and what's unfinished about it.

use crate::{item_dir, to, Service};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

pub fn call(svc: &Service, method: &str, _p: &Value) -> Result<Value> {
    if method != "shelf.get" {
        return Err(anyhow!("unknown method {method}"));
    }
    let v = svc.vault();
    let mut items = v.items(None)?;
    items.sort_by_key(|i| std::cmp::Reverse(i.opened.max(i.updated)));
    let inbox: Vec<_> = items.iter().filter(|i| i.in_inbox()).cloned().collect();
    let pinned: Vec<_> = items.iter().filter(|i| i.pinned).cloned().collect();
    let focus = items.iter().find(|i| i.opened > 0).or(items.iter().find(|i| !i.in_inbox())).cloned();
    let mut unfinished = Vec::new();
    if let Some(f) = &focus {
        if let Ok((_, dir)) = item_dir(&v, &f.id) {
            if let Ok(st) = archival_git::status(&dir) {
                if st.is_repo {
                    let changed = st.files.len();
                    if changed > 0 {
                        unfinished.push(json!({"kind": "uncommitted", "count": changed, "text": format!("{changed} uncommitted file{}", if changed == 1 { "" } else { "s" })}));
                    }
                    if st.ahead > 0 {
                        unfinished.push(json!({"kind": "unpushed", "count": st.ahead, "text": format!("{} commit{} not pushed", st.ahead, if st.ahead == 1 { "" } else { "s" })}));
                    }
                    let conflicts = st.files.iter().filter(|f| f.conflicted).count();
                    if conflicts > 0 {
                        unfinished.push(json!({"kind": "conflicts", "count": conflicts, "text": format!("{conflicts} conflicted file{}", if conflicts == 1 { "" } else { "s" })}));
                    }
                } else if f.is_dir && f.kind == archival_core::Kind::Project {
                    unfinished.push(json!({"kind": "unpublished", "count": 1, "text": "not on github yet"}));
                }
            }
        }
        let draft: Option<String> = v.db().query_row("SELECT title FROM pr_drafts WHERE item_id = ?1", [&f.id], |r| r.get(0)).ok();
        if let Some(t) = draft {
            unfinished.push(json!({"kind": "pr_draft", "count": 1, "text": format!("pr draft not sent: {t}")}));
        }
    }
    let recent: Vec<_> = items.iter().filter(|i| Some(&i.id) != focus.as_ref().map(|f| &f.id) && !i.in_inbox()).take(8).cloned().collect();
    let running = svc.inner.runs.list().into_iter().filter(|r| r.ended.is_none()).collect::<Vec<_>>();
    Ok(json!({
        "focus": focus,
        "unfinished": unfinished,
        "inbox": to(inbox.iter().take(5).collect::<Vec<_>>())?,
        "inbox_count": inbox.len(),
        "recent": recent,
        "pinned": pinned,
        "running": running,
        "total": items.len(),
    }))
}
