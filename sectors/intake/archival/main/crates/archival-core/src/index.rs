//! the sqlite index: items, snapshots, trash, connectors, settings and the fts5 search table.

use crate::{now, Item, ItemPatch, Kind, Result, SnapshotInfo, TrashEntry};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

pub const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  is_dir INTEGER NOT NULL,
  origin_connector TEXT NOT NULL DEFAULT 'local',
  origin_source TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  remote TEXT,
  account TEXT,
  trusted INTEGER NOT NULL DEFAULT 0,
  run_command TEXT,
  run_setup TEXT,
  run_mode TEXT,
  local_only INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  manifest TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_item ON snapshots(item_id, created);
CREATE TABLE IF NOT EXISTS trash (
  id TEXT PRIMARY KEY,
  original_path TEXT NOT NULL,
  item_id TEXT,
  title TEXT NOT NULL,
  trashed_at INTEGER NOT NULL,
  is_item INTEGER NOT NULL,
  item_json TEXT
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}',
  last_sync INTEGER,
  last_error TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_drafts (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  base TEXT NOT NULL,
  head TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(item_id UNINDEXED, path, title, body, tokenize = 'unicode61');
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

pub const ITEM_COLS: &str = "id, kind, title, path, is_dir, origin_connector, origin_source, tags, created, updated, remote, account, trusted, run_command, run_setup, run_mode, local_only, pinned, opened";

pub fn row_to_item(r: &Row) -> rusqlite::Result<Item> {
    let kind: String = r.get(1)?;
    let tags: String = r.get(7)?;
    Ok(Item {
        id: r.get(0)?,
        kind: Kind::parse(&kind).unwrap_or(Kind::Asset),
        title: r.get(2)?,
        path: r.get(3)?,
        is_dir: r.get::<_, i64>(4)? != 0,
        origin_connector: r.get(5)?,
        origin_source: r.get(6)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        created: r.get(8)?,
        updated: r.get(9)?,
        remote: r.get(10)?,
        account: r.get(11)?,
        trusted: r.get::<_, i64>(12)? != 0,
        run_command: r.get(13)?,
        run_setup: r.get(14)?,
        run_mode: r.get(15)?,
        local_only: r.get::<_, i64>(16)? != 0,
        pinned: r.get::<_, i64>(17)? != 0,
        opened: r.get(18)?,
    })
}

pub fn insert_item(c: &Connection, it: &Item) -> Result<()> {
    c.execute(
        &format!("INSERT INTO items ({ITEM_COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)"),
        params![
            it.id,
            it.kind.as_str(),
            it.title,
            it.path,
            it.is_dir as i64,
            it.origin_connector,
            it.origin_source,
            serde_json::to_string(&it.tags)?,
            it.created,
            it.updated,
            it.remote,
            it.account,
            it.trusted as i64,
            it.run_command,
            it.run_setup,
            it.run_mode,
            it.local_only as i64,
            it.pinned as i64,
            it.opened
        ],
    )?;
    Ok(())
}

pub fn get_item(c: &Connection, id: &str) -> Result<Option<Item>> {
    Ok(c.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id = ?1"), [id], row_to_item).optional()?)
}

pub fn item_by_path(c: &Connection, path: &str) -> Result<Option<Item>> {
    Ok(c.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE path = ?1"), [path], row_to_item).optional()?)
}

pub fn list_items(c: &Connection, category: Option<&str>) -> Result<Vec<Item>> {
    let mut out = Vec::new();
    match category {
        Some(cat) => {
            let mut st = c.prepare(&format!(
                "SELECT {ITEM_COLS} FROM items WHERE path = ?1 OR path LIKE ?2 ORDER BY lower(title)"
            ))?;
            for r in st.query_map(params![cat, format!("{cat}/%")], row_to_item)? {
                out.push(r?);
            }
        }
        None => {
            let mut st = c.prepare(&format!("SELECT {ITEM_COLS} FROM items ORDER BY updated DESC"))?;
            for r in st.query_map([], row_to_item)? {
                out.push(r?);
            }
        }
    }
    Ok(out)
}

pub fn patch_item(c: &Connection, id: &str, p: &ItemPatch) -> Result<()> {
    let tx = c.unchecked_transaction()?;
    if let Some(v) = &p.title {
        tx.execute("UPDATE items SET title = ?2 WHERE id = ?1", params![id, v])?;
    }
    if let Some(v) = &p.kind {
        tx.execute("UPDATE items SET kind = ?2 WHERE id = ?1", params![id, v.as_str()])?;
    }
    if let Some(v) = &p.tags {
        tx.execute("UPDATE items SET tags = ?2 WHERE id = ?1", params![id, serde_json::to_string(v)?])?;
    }
    if let Some(v) = &p.remote {
        tx.execute("UPDATE items SET remote = ?2 WHERE id = ?1", params![id, v])?;
    }
    if let Some(v) = &p.account {
        tx.execute("UPDATE items SET account = ?2 WHERE id = ?1", params![id, v])?;
    }
    if let Some(v) = p.trusted {
        tx.execute("UPDATE items SET trusted = ?2 WHERE id = ?1", params![id, v as i64])?;
    }
    if let Some(v) = &p.run_command {
        tx.execute("UPDATE items SET run_command = ?2 WHERE id = ?1", params![id, v])?;
    }
    if let Some(v) = &p.run_setup {
        tx.execute("UPDATE items SET run_setup = ?2 WHERE id = ?1", params![id, v])?;
    }
    if let Some(v) = &p.run_mode {
        tx.execute("UPDATE items SET run_mode = ?2 WHERE id = ?1", params![id, v])?;
    }
    if let Some(v) = p.local_only {
        tx.execute("UPDATE items SET local_only = ?2 WHERE id = ?1", params![id, v as i64])?;
    }
    if let Some(v) = p.pinned {
        tx.execute("UPDATE items SET pinned = ?2 WHERE id = ?1", params![id, v as i64])?;
    }
    tx.execute("UPDATE items SET updated = ?2 WHERE id = ?1", params![id, now()])?;
    tx.commit()?;
    Ok(())
}

pub fn touch(c: &Connection, id: &str) -> Result<()> {
    c.execute("UPDATE items SET updated = ?2 WHERE id = ?1", params![id, now()])?;
    Ok(())
}

pub fn mark_opened(c: &Connection, id: &str) -> Result<()> {
    c.execute("UPDATE items SET opened = ?2 WHERE id = ?1", params![id, now()])?;
    Ok(())
}

pub fn set_item_path(c: &Connection, id: &str, path: &str) -> Result<()> {
    c.execute("UPDATE items SET path = ?2, updated = ?3 WHERE id = ?1", params![id, path, now()])?;
    Ok(())
}

pub fn delete_item_row(c: &Connection, id: &str) -> Result<()> {
    c.execute("DELETE FROM items WHERE id = ?1", [id])?;
    c.execute("DELETE FROM fts WHERE item_id = ?1", [id])?;
    c.execute("DELETE FROM pr_drafts WHERE item_id = ?1", [id])?;
    Ok(())
}

pub fn set_manifest_hash(c: &Connection, id: &str, h: &str) -> Result<()> {
    c.execute("UPDATE items SET manifest_hash = ?2 WHERE id = ?1", params![id, h])?;
    Ok(())
}

pub fn item_with_manifest(c: &Connection, h: &str) -> Result<Option<Item>> {
    Ok(c.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE manifest_hash = ?1"), [h], row_to_item).optional()?)
}

// snapshots

pub fn insert_snapshot(c: &Connection, s: &SnapshotInfo) -> Result<()> {
    c.execute(
        "INSERT INTO snapshots (id, item_id, created, label, source, manifest, file_count, bytes) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![s.id, s.item_id, s.created, s.label, s.source, s.manifest, s.file_count as i64, s.bytes as i64],
    )?;
    Ok(())
}

fn row_to_snapshot(r: &Row) -> rusqlite::Result<SnapshotInfo> {
    Ok(SnapshotInfo {
        id: r.get(0)?,
        item_id: r.get(1)?,
        created: r.get(2)?,
        label: r.get(3)?,
        source: r.get(4)?,
        manifest: r.get(5)?,
        file_count: r.get::<_, i64>(6)? as u64,
        bytes: r.get::<_, i64>(7)? as u64,
    })
}

pub fn list_snapshots(c: &Connection, item_id: &str) -> Result<Vec<SnapshotInfo>> {
    let mut st = c.prepare(
        "SELECT id, item_id, created, label, source, manifest, file_count, bytes FROM snapshots WHERE item_id = ?1 ORDER BY created DESC",
    )?;
    let rows = st.query_map([item_id], row_to_snapshot)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_snapshot(c: &Connection, id: &str) -> Result<Option<SnapshotInfo>> {
    Ok(c.query_row(
        "SELECT id, item_id, created, label, source, manifest, file_count, bytes FROM snapshots WHERE id = ?1",
        [id],
        row_to_snapshot,
    )
    .optional()?)
}

// trash

pub fn insert_trash(c: &Connection, t: &TrashEntry, item_json: Option<String>) -> Result<()> {
    c.execute(
        "INSERT INTO trash (id, original_path, item_id, title, trashed_at, is_item, item_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![t.id, t.original_path, t.item_id, t.title, t.trashed_at, t.is_item as i64, item_json],
    )?;
    Ok(())
}

pub fn list_trash(c: &Connection) -> Result<Vec<(TrashEntry, Option<String>)>> {
    let mut st = c.prepare(
        "SELECT id, original_path, item_id, title, trashed_at, is_item, item_json FROM trash ORDER BY trashed_at DESC",
    )?;
    let rows = st.query_map([], |r| {
        Ok((
            TrashEntry {
                id: r.get(0)?,
                original_path: r.get(1)?,
                item_id: r.get(2)?,
                title: r.get(3)?,
                trashed_at: r.get(4)?,
                is_item: r.get::<_, i64>(5)? != 0,
            },
            r.get(6)?,
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn delete_trash_row(c: &Connection, id: &str) -> Result<()> {
    c.execute("DELETE FROM trash WHERE id = ?1", [id])?;
    Ok(())
}

// settings

pub fn get_setting(c: &Connection, key: &str) -> Result<Option<String>> {
    Ok(c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_setting(c: &Connection, key: &str, value: &str) -> Result<()> {
    c.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn all_settings(c: &Connection) -> Result<Vec<(String, String)>> {
    let mut st = c.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
