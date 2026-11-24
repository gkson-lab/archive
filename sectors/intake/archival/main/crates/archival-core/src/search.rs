//! full text search over item titles, file paths and text file contents (sqlite fts5).

use crate::classify::{ext_of, is_text_ext};
use crate::paths::relative;
use crate::tree::walk_files;
use crate::{Item, Kind, Result, SearchHit};
use rusqlite::{params, Connection};
use std::path::Path;

const MAX_FILE: u64 = 512 * 1024;
const MAX_FILES: usize = 5000;

pub fn reindex(c: &Connection, item: &Item, abs_root: &Path, vault_dir: &Path) -> Result<()> {
    let tx = c.unchecked_transaction()?;
    tx.execute("DELETE FROM fts WHERE item_id = ?1", [&item.id])?;
    tx.execute(
        "INSERT INTO fts (item_id, path, title, body) VALUES (?1, ?2, ?3, ?4)",
        params![item.id, item.path, item.title, item.tags.join(" ")],
    )?;
    for (i, f) in walk_files(abs_root).enumerate() {
        if i >= MAX_FILES {
            break;
        }
        let rel = relative(vault_dir, &f);
        let ext = ext_of(&f);
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let body = if is_text_ext(&ext) && size <= MAX_FILE {
            std::fs::read(&f).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
        } else {
            String::new()
        };
        tx.execute(
            "INSERT INTO fts (item_id, path, title, body) VALUES (?1, ?2, ?3, ?4)",
            params![item.id, rel, f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), body],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// turn free text into a safe fts5 query: every word becomes a quoted prefix term.
pub fn to_fts_query(q: &str) -> Option<String> {
    let terms: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

pub fn search(c: &Connection, q: &str, contents: bool, limit: usize) -> Result<Vec<SearchHit>> {
    let Some(fq) = to_fts_query(q) else { return Ok(vec![]) };
    let query = if contents { fq } else { format!("{{path title}} : ({fq})") };
    let mut st = c.prepare(
        "SELECT f.item_id, i.title, i.kind, f.path,
                CASE WHEN ?2 THEN snippet(fts, 3, char(2), char(3), '…', 12) ELSE '' END
         FROM fts f JOIN items i ON i.id = f.item_id
         WHERE fts MATCH ?1 ORDER BY rank LIMIT ?3",
    )?;
    let rows = st.query_map(params![query, contents, limit as i64], |r| {
        let kind: String = r.get(2)?;
        Ok(SearchHit {
            item_id: r.get(0)?,
            title: r.get(1)?,
            kind: Kind::parse(&kind).unwrap_or(Kind::Asset),
            path: r.get(3)?,
            snippet: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
