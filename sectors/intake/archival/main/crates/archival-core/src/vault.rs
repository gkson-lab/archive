use crate::classify::{ext_of, suggest};
use crate::index;
use crate::objects::ObjectStore;
use crate::paths::{join, relative, resolve, safe_name, unique_name};
use crate::snapshot::{self, Changes};
use crate::trash::{day_ms, DEFAULT_RETENTION_DAYS};
use crate::tree::list_dir;
use crate::{
    now, Error, Item, ItemPatch, Kind, Manifest, Result, SearchHit, SnapshotInfo, Suggestion, TrashEntry, TreeEntry,
    CATEGORIES,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub struct Vault {
    root: PathBuf,
    vault_dir: PathBuf,
    meta_dir: PathBuf,
    pub objects: ObjectStore,
    db: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub vault_root: Option<PathBuf>,
}

impl AppConfig {
    pub fn path() -> PathBuf {
        dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("archival").join("config.json")
    }
    pub fn load() -> AppConfig {
        fs::read_to_string(Self::path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    pub fn save(&self) -> Result<()> {
        let p = Self::path();
        fs::create_dir_all(p.parent().unwrap())?;
        fs::write(p, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

pub fn default_root() -> PathBuf {
    if let Ok(p) = std::env::var("ARCHIVAL_VAULT") {
        return PathBuf::from(p);
    }
    AppConfig::load()
        .vault_root
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(std::env::temp_dir).join("archival"))
}

#[derive(Debug, Serialize, Default)]
pub struct RebuildReport {
    pub added: usize,
    pub removed: usize,
    pub total: usize,
}

#[derive(Debug, Serialize)]
pub struct FileContent {
    pub path: String,
    pub size: u64,
    pub mime: String,
    pub ext: String,
    /// utf-8 text when the file is text and not too large
    pub text: Option<String>,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Serialize)]
pub struct VaultStats {
    pub root: String,
    pub items: usize,
    pub inbox: usize,
    pub snapshots: usize,
    pub object_bytes: u64,
    pub trash: usize,
}

const MAX_TEXT: u64 = 8 * 1024 * 1024;

impl Vault {
    /// open the vault at `root`, creating the layout if it doesn't exist yet.
    pub fn open(root: impl AsRef<Path>) -> Result<Vault> {
        let root = root.as_ref().to_path_buf();
        let vault_dir = root.join("vault");
        let meta_dir = root.join(".archival");
        for c in CATEGORIES {
            fs::create_dir_all(vault_dir.join(c))?;
        }
        for d in ["objects", "snapshots", "trash", "connectors", "logs", "toolchains"] {
            fs::create_dir_all(meta_dir.join(d))?;
        }
        let readme = root.join("README.txt");
        if !readme.exists() {
            fs::write(
                &readme,
                "this folder is an archival vault.\n\nvault/ holds your files as plain folders. it stays readable without archival.\n.archival/ holds the index, history and trash. don't edit it by hand.\n",
            )?;
        }
        let conn = index::open(&meta_dir.join("index.sqlite"))?;
        let v = Vault { root, vault_dir, meta_dir, objects: ObjectStore::new(PathBuf::new()), db: Mutex::new(conn) };
        let v = Vault { objects: ObjectStore::new(v.meta_dir.join("objects")), ..v };
        v.rebuild_index()?;
        let _ = v.purge_trash(None);
        Ok(v)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn vault_dir(&self) -> &Path {
        &self.vault_dir
    }
    pub fn meta_dir(&self) -> &Path {
        &self.meta_dir
    }
    pub fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn abs(&self, rel: &str) -> Result<PathBuf> {
        resolve(&self.vault_dir, rel)
    }

    pub fn rel(&self, abs: &Path) -> String {
        relative(&self.vault_dir, abs)
    }

    /// sync the index with what's actually in `vault/`: new folders become items, vanished ones go.
    pub fn rebuild_index(&self) -> Result<RebuildReport> {
        let mut report = RebuildReport::default();
        let existing = index::list_items(&self.db(), None)?;
        for it in &existing {
            if !self.vault_dir.join(&it.path).exists() {
                index::delete_item_row(&self.db(), &it.id)?;
                report.removed += 1;
            }
        }
        for cat in CATEGORIES {
            let dir = self.vault_dir.join(cat);
            for (p, _) in list_dir(&dir)? {
                let rel = self.rel(&p);
                if index::item_by_path(&self.db(), &rel)?.is_none() {
                    let s = suggest(&p);
                    self.register(&p, "local", &p.to_string_lossy(), &s, None)?;
                    report.added += 1;
                }
            }
        }
        report.total = index::list_items(&self.db(), None)?.len();
        Ok(report)
    }

    /// add an index entry for a path that already sits inside `vault/`.
    pub fn register(&self, abs: &Path, connector: &str, source: &str, s: &Suggestion, title: Option<&str>) -> Result<Item> {
        let rel = self.rel(abs);
        let name = abs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "untitled".into());
        let title = title.map(|t| t.to_string()).unwrap_or_else(|| {
            if abs.is_dir() {
                name.clone()
            } else {
                match name.rfind('.') {
                    Some(i) if i > 0 => name[..i].to_string(),
                    _ => name.clone(),
                }
            }
        });
        let t = now();
        let remote = if abs.join(".git").exists() { git_remote_url(abs) } else { None };
        let item = Item {
            id: uuid::Uuid::new_v4().to_string(),
            kind: s.kind,
            title,
            path: rel,
            is_dir: abs.is_dir(),
            origin_connector: connector.into(),
            origin_source: source.into(),
            tags: s.tags.clone(),
            created: t,
            updated: t,
            remote,
            account: None,
            trusted: connector == "local-create",
            run_command: None,
            run_setup: None,
            run_mode: None,
            local_only: false,
            pinned: false,
            opened: 0,
        };
        index::insert_item(&self.db(), &item)?;
        let _ = self.reindex(&item);
        Ok(item)
    }

    pub fn reindex(&self, item: &Item) -> Result<()> {
        let abs = self.abs(&item.path)?;
        crate::search::reindex(&self.db(), item, &abs, &self.vault_dir)
    }

    pub fn item(&self, id: &str) -> Result<Item> {
        index::get_item(&self.db(), id)?.ok_or_else(|| Error::NotFound(format!("item {id}")))
    }

    pub fn items(&self, category: Option<&str>) -> Result<Vec<Item>> {
        index::list_items(&self.db(), category)
    }

    /// the item whose root contains `rel` (a vault-relative path), if any.
    pub fn item_for_path(&self, rel: &str) -> Result<Option<Item>> {
        let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() < 2 {
            return Ok(None);
        }
        index::item_by_path(&self.db(), &format!("{}/{}", parts[0], parts[1]))
    }

    pub fn patch(&self, id: &str, p: &ItemPatch) -> Result<Item> {
        index::patch_item(&self.db(), id, p)?;
        let it = self.item(id)?;
        if p.title.is_some() || p.tags.is_some() {
            let _ = self.reindex(&it);
        }
        Ok(it)
    }

    pub fn mark_opened(&self, id: &str) -> Result<()> {
        index::mark_opened(&self.db(), id)
    }

    // tree + files

    pub fn tree(&self, rel: &str) -> Result<Vec<TreeEntry>> {
        if rel.is_empty() {
            let items = self.items(None)?;
            return Ok(CATEGORIES
                .iter()
                .map(|c| TreeEntry {
                    name: c.to_string(),
                    path: c.to_string(),
                    is_dir: true,
                    size: 0,
                    ext: String::new(),
                    modified: 0,
                    count: Some(items.iter().filter(|i| i.category() == *c).count()),
                    item_id: None,
                })
                .collect());
        }
        let dir = self.abs(rel)?;
        if !dir.is_dir() {
            return Err(Error::NotFound(rel.into()));
        }
        let top_level = !rel.contains('/');
        let mut out = Vec::new();
        for (p, m) in list_dir(&dir)? {
            let path = self.rel(&p);
            let item_id = if top_level { index::item_by_path(&self.db(), &path)?.map(|i| i.id) } else { None };
            out.push(TreeEntry {
                name: p.file_name().unwrap_or_default().to_string_lossy().to_string(),
                ext: if m.is_dir() { String::new() } else { ext_of(&p) },
                path,
                is_dir: m.is_dir(),
                size: if m.is_dir() { 0 } else { m.len() },
                modified: m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
                count: None,
                item_id,
            });
        }
        Ok(out)
    }

    pub fn read_file(&self, rel: &str) -> Result<FileContent> {
        let p = self.abs(rel)?;
        let meta = fs::metadata(&p).map_err(|_| Error::NotFound(rel.into()))?;
        if meta.is_dir() {
            return Err(Error::msg("that's a folder"));
        }
        let ext = ext_of(&p);
        let mime = mime_guess::from_path(&p).first_or_octet_stream().to_string();
        let too_large = meta.len() > MAX_TEXT;
        let mut text = None;
        let mut binary = true;
        if !too_large {
            let bytes = fs::read(&p)?;
            let sniff = &bytes[..bytes.len().min(8000)];
            if !sniff.contains(&0) {
                if let Ok(s) = String::from_utf8(bytes) {
                    text = Some(s);
                    binary = false;
                }
            }
        }
        Ok(FileContent { path: rel.into(), size: meta.len(), mime, ext, text, binary, too_large })
    }

    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        Ok(fs::read(self.abs(rel)?)?)
    }

    pub fn write_file(&self, rel: &str, data: &[u8]) -> Result<()> {
        let p = self.abs(rel)?;
        if rel.split('/').filter(|s| !s.is_empty()).count() < 2 {
            return Err(Error::msg("files go inside a folder like docs/ or projects/"));
        }
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = p.with_extension(format!("{}.archival-tmp", ext_of(&p)));
        fs::File::create(&tmp)?.write_all(data)?;
        fs::rename(&tmp, &p)?;
        match self.item_for_path(rel)? {
            Some(it) => {
                index::touch(&self.db(), &it.id)?;
                let _ = self.reindex(&it);
            }
            None => {
                // a new file directly under a category becomes its own item
                let s = suggest(&p);
                self.register(&p, "local-create", "", &s, None)?;
            }
        }
        Ok(())
    }

    pub fn create_dir(&self, rel: &str) -> Result<()> {
        let p = self.abs(rel)?;
        if rel.split('/').filter(|s| !s.is_empty()).count() < 2 {
            return Err(Error::msg("pick a folder like projects/ first"));
        }
        fs::create_dir_all(&p)?;
        if self.item_for_path(rel)?.is_none() {
            let s = Suggestion { kind: kind_for_category(rel), category: String::new(), tags: vec![] };
            self.register(&p, "local-create", "", &s, None)?;
        }
        Ok(())
    }

    /// rename or move a path. moving an item root updates the index.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let a = self.abs(from)?;
        let b = self.abs(to)?;
        if b.exists() {
            return Err(Error::msg(format!("{to} already exists")));
        }
        if to.split('/').filter(|s| !s.is_empty()).count() < 2 {
            return Err(Error::msg("can't move something to the top of the vault"));
        }
        if let Some(parent) = b.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&a, &b)?;
        let moved = index::item_by_path(&self.db(), from)?;
        if let Some(it) = moved {
            index::set_item_path(&self.db(), &it.id, to)?;
            let it = self.item(&it.id)?;
            let _ = self.reindex(&it);
        } else if let Some(it) = self.item_for_path(to)? {
            let _ = self.reindex(&it);
        }
        Ok(())
    }

    /// file an inbox item into its category (or any category).
    pub fn file_item(&self, id: &str, category: Option<&str>) -> Result<Item> {
        let it = self.item(id)?;
        let cat = category.map(|c| c.to_string()).unwrap_or_else(|| it.kind.category().to_string());
        if !CATEGORIES.contains(&cat.as_str()) {
            return Err(Error::msg(format!("unknown folder {cat}")));
        }
        let name = it.path.rsplit('/').next().unwrap_or("item").to_string();
        let dest_dir = self.vault_dir.join(&cat);
        let name = unique_name(&dest_dir, &name);
        let to = join(&cat, &name);
        self.rename(&it.path, &to)?;
        self.item(id)
    }

    // trash

    pub fn trash_path(&self, rel: &str) -> Result<TrashEntry> {
        let p = self.abs(rel)?;
        if !p.exists() {
            return Err(Error::NotFound(rel.into()));
        }
        if rel.split('/').filter(|s| !s.is_empty()).count() < 2 {
            return Err(Error::msg("category folders can't be trashed"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        let dest = self.meta_dir.join("trash").join(&id).join(&name);
        fs::create_dir_all(dest.parent().unwrap())?;
        fs::rename(&p, &dest)?;
        let root_item = index::item_by_path(&self.db(), rel)?;
        let (item_id, title, is_item, json) = match &root_item {
            Some(it) => {
                let j = serde_json::to_string(it)?;
                index::delete_item_row(&self.db(), &it.id)?;
                (Some(it.id.clone()), it.title.clone(), true, Some(j))
            }
            None => (self.item_for_path(rel)?.map(|i| i.id), name.clone(), false, None),
        };
        let t = TrashEntry { id, original_path: rel.into(), item_id, title, trashed_at: now(), is_item };
        index::insert_trash(&self.db(), &t, json)?;
        if !is_item {
            if let Some(it) = self.item_for_path(rel)? {
                let _ = self.reindex(&it);
            }
        }
        Ok(t)
    }

    pub fn trash(&self) -> Result<Vec<TrashEntry>> {
        Ok(index::list_trash(&self.db())?.into_iter().map(|(t, _)| t).collect())
    }

    pub fn restore_trash(&self, id: &str) -> Result<String> {
        let (t, json) = index::list_trash(&self.db())?
            .into_iter()
            .find(|(t, _)| t.id == id)
            .ok_or_else(|| Error::NotFound(format!("trash {id}")))?;
        let holder = self.meta_dir.join("trash").join(&t.id);
        let src = fs::read_dir(&holder)?.next().ok_or_else(|| Error::msg("trash entry is empty"))??.path();
        let mut dest_rel = t.original_path.clone();
        let mut dest = self.abs(&dest_rel)?;
        if dest.exists() {
            let parent = dest.parent().unwrap().to_path_buf();
            let name = unique_name(&parent, &dest.file_name().unwrap().to_string_lossy());
            dest = parent.join(&name);
            dest_rel = self.rel(&dest);
        }
        fs::create_dir_all(dest.parent().unwrap())?;
        fs::rename(&src, &dest)?;
        let _ = fs::remove_dir_all(&holder);
        index::delete_trash_row(&self.db(), id)?;
        if t.is_item {
            if let Some(j) = json {
                let mut it: Item = serde_json::from_str(&j)?;
                it.path = dest_rel.clone();
                it.updated = now();
                index::insert_item(&self.db(), &it)?;
                let _ = self.reindex(&it);
            }
        } else if let Some(it) = self.item_for_path(&dest_rel)? {
            let _ = self.reindex(&it);
        }
        Ok(dest_rel)
    }

    /// permanently remove trash older than the retention window (or one entry by id).
    pub fn purge_trash(&self, only: Option<&str>) -> Result<usize> {
        let days = index::get_setting(&self.db(), "trash.retention_days")?
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(DEFAULT_RETENTION_DAYS);
        let cutoff = now() - days * day_ms();
        let mut n = 0;
        let entries = index::list_trash(&self.db())?;
        for (t, _) in entries {
            let hit = match only {
                Some(id) => t.id == id,
                None => t.trashed_at < cutoff,
            };
            if hit {
                let _ = fs::remove_dir_all(self.meta_dir.join("trash").join(&t.id));
                index::delete_trash_row(&self.db(), &t.id)?;
                n += 1;
            }
        }
        Ok(n)
    }

    // snapshots

    pub fn snapshot(&self, id: &str, label: &str, source: &str) -> Result<SnapshotInfo> {
        let it = self.item(id)?;
        let abs = self.abs(&it.path)?;
        let manifest = snapshot::capture(&self.objects, &abs)?;
        let json = serde_json::to_vec(&manifest)?;
        let mhash = self.objects.put_bytes(&json)?;
        // identical to the newest snapshot: reuse it instead of piling up duplicates
        let last = index::list_snapshots(&self.db(), id)?.into_iter().next();
        if let Some(last) = last {
            if last.manifest == mhash && source != "manual" {
                return Ok(last);
            }
        }
        let info = SnapshotInfo {
            id: uuid::Uuid::new_v4().to_string(),
            item_id: id.into(),
            created: now(),
            label: if label.is_empty() { "snapshot".into() } else { label.into() },
            source: source.into(),
            manifest: mhash.clone(),
            file_count: manifest.files.len() as u64,
            bytes: manifest.files.iter().map(|f| f.size).sum(),
        };
        index::insert_snapshot(&self.db(), &info)?;
        fs::write(self.meta_dir.join("snapshots").join(format!("{}.json", info.id)), serde_json::to_vec_pretty(&info)?)?;
        index::set_manifest_hash(&self.db(), id, &snapshot::fingerprint(&abs)?)?;
        Ok(info)
    }

    pub fn snapshots(&self, id: &str) -> Result<Vec<SnapshotInfo>> {
        index::list_snapshots(&self.db(), id)
    }

    pub fn manifest(&self, snap: &SnapshotInfo) -> Result<Manifest> {
        Ok(serde_json::from_slice(&self.objects.get(&snap.manifest)?)?)
    }

    fn snap(&self, snap_id: &str) -> Result<SnapshotInfo> {
        index::get_snapshot(&self.db(), snap_id)?.ok_or_else(|| Error::NotFound(format!("snapshot {snap_id}")))
    }

    pub fn snapshot_changes(&self, snap_id: &str) -> Result<Changes> {
        let s = self.snap(snap_id)?;
        let it = self.item(&s.item_id)?;
        snapshot::changes(&self.manifest(&s)?, &self.abs(&it.path)?)
    }

    /// contents of one file as it was in a snapshot
    pub fn snapshot_file(&self, snap_id: &str, path: &str) -> Result<Option<Vec<u8>>> {
        let s = self.snap(snap_id)?;
        let m = self.manifest(&s)?;
        match m.files.iter().find(|f| f.path == path) {
            Some(f) => Ok(Some(self.objects.get(&f.hash)?)),
            None => Ok(None),
        }
    }

    pub fn restore_snapshot(&self, snap_id: &str) -> Result<SnapshotInfo> {
        let s = self.snap(snap_id)?;
        let it = self.item(&s.item_id)?;
        let before = self.snapshot(&it.id, "before restore", "restore")?;
        let abs = self.abs(&it.path)?;
        snapshot::restore(&self.objects, &self.manifest(&s)?, &abs, !it.is_dir)?;
        index::touch(&self.db(), &it.id)?;
        let _ = self.reindex(&it);
        Ok(before)
    }

    pub fn duplicate_of(&self, abs: &Path) -> Result<Option<Item>> {
        let fp = snapshot::fingerprint(abs)?;
        index::item_with_manifest(&self.db(), &fp)
    }

    pub fn set_fingerprint(&self, id: &str) -> Result<()> {
        let it = self.item(id)?;
        let fp = snapshot::fingerprint(&self.abs(&it.path)?)?;
        index::set_manifest_hash(&self.db(), id, &fp)
    }

    // search

    pub fn search(&self, q: &str, contents: bool) -> Result<Vec<SearchHit>> {
        crate::search::search(&self.db(), q, contents, 80)
    }

    // export

    pub fn export_zip(&self, id: &str, dest: &Path) -> Result<PathBuf> {
        let it = self.item(id)?;
        let abs = self.abs(&it.path)?;
        let dest = if dest.is_dir() { dest.join(format!("{}.zip", safe_name(&it.title))) } else { dest.to_path_buf() };
        let f = fs::File::create(&dest)?;
        let mut z = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let base = abs.parent().unwrap_or(&abs).to_path_buf();
        for file in crate::tree::walk_files(&abs) {
            z.start_file(relative(&base, &file), opts)?;
            let mut src = fs::File::open(&file)?;
            std::io::copy(&mut src, &mut z)?;
        }
        z.finish()?;
        Ok(dest)
    }

    pub fn stats(&self) -> Result<VaultStats> {
        let items = self.items(None)?;
        let snaps: i64 = self.db().query_row("SELECT count(*) FROM snapshots", [], |r| r.get(0))?;
        Ok(VaultStats {
            root: self.root.to_string_lossy().to_string(),
            inbox: items.iter().filter(|i| i.in_inbox()).count(),
            items: items.len(),
            snapshots: snaps as usize,
            object_bytes: self.objects.disk_usage(),
            trash: self.trash()?.len(),
        })
    }

    // settings

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        index::get_setting(&self.db(), key)
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        index::set_setting(&self.db(), key, value)
    }
    pub fn settings(&self) -> Result<Vec<(String, String)>> {
        index::all_settings(&self.db())
    }
}

fn kind_for_category(rel: &str) -> Kind {
    match rel.split('/').next().unwrap_or("") {
        "projects" => Kind::Project,
        "docs" => Kind::Document,
        "designs" => Kind::Design,
        "snippets" => Kind::Snippet,
        "links" => Kind::Link,
        "assets" => Kind::Asset,
        _ => Kind::Project,
    }
}

/// read `remote.origin.url` from .git/config without needing git.
fn git_remote_url(dir: &Path) -> Option<String> {
    let cfg = fs::read_to_string(dir.join(".git").join("config")).ok()?;
    let mut in_origin = false;
    for line in cfg.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_origin = l == "[remote \"origin\"]";
        } else if in_origin {
            if let Some(v) = l.strip_prefix("url") {
                return Some(v.trim_start_matches([' ', '=']).trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::open(d.path()).unwrap();
        (d, v)
    }

    #[test]
    fn layout_and_rebuild() {
        let (d, v) = vault();
        assert!(d.path().join("vault/projects").is_dir());
        assert!(d.path().join(".archival/index.sqlite").is_file());
        fs::create_dir_all(d.path().join("vault/projects/demo")).unwrap();
        fs::write(d.path().join("vault/projects/demo/main.rs"), "fn main() {}").unwrap();
        let r = v.rebuild_index().unwrap();
        assert_eq!(r.added, 1);
        let items = v.items(Some("projects")).unwrap();
        assert_eq!(items[0].title, "demo");
        assert_eq!(items[0].kind, Kind::Project);
    }

    #[test]
    fn write_search_snapshot_restore() {
        let (_d, v) = vault();
        v.create_dir("projects/app").unwrap();
        v.write_file("projects/app/readme.md", b"hello windmill world").unwrap();
        let it = v.item_for_path("projects/app").unwrap().unwrap();
        let hits = v.search("windmill", true).unwrap();
        assert!(hits.iter().any(|h| h.item_id == it.id && h.snippet.contains('\u{2}')));
        assert!(v.search("windmill", false).unwrap().is_empty());
        assert!(!v.search("readme", false).unwrap().is_empty());

        let s1 = v.snapshot(&it.id, "first", "manual").unwrap();
        v.write_file("projects/app/readme.md", b"changed").unwrap();
        v.write_file("projects/app/new.txt", b"new").unwrap();
        let ch = v.snapshot_changes(&s1.id).unwrap();
        assert_eq!(ch.modified, vec!["readme.md"]);
        assert_eq!(ch.added, vec!["new.txt"]);
        v.restore_snapshot(&s1.id).unwrap();
        assert_eq!(v.read_file("projects/app/readme.md").unwrap().text.unwrap(), "hello windmill world");
        assert!(v.read_file("projects/app/new.txt").is_err());
        // the pre-restore state was kept
        assert_eq!(v.snapshots(&it.id).unwrap().len(), 2);
    }

    #[test]
    fn trash_and_restore_items() {
        let (_d, v) = vault();
        v.write_file("docs/note.md", b"# note").unwrap();
        let it = v.item_for_path("docs/note.md").unwrap().unwrap();
        let t = v.trash_path("docs/note.md").unwrap();
        assert!(v.item(&it.id).is_err());
        assert_eq!(v.trash().unwrap().len(), 1);
        let back = v.restore_trash(&t.id).unwrap();
        assert_eq!(back, "docs/note.md");
        assert_eq!(v.item(&it.id).unwrap().title, "note");
        assert!(v.trash_path("docs").is_err());
        assert!(v.read_file("../x").is_err());
    }

    #[test]
    fn filing_and_dedup() {
        let (d, v) = vault();
        let p = d.path().join("vault/inbox/thing");
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("package.json"), "{}").unwrap();
        v.rebuild_index().unwrap();
        let it = v.items(Some("inbox")).unwrap().remove(0);
        v.set_fingerprint(&it.id).unwrap();
        let other = d.path().join("elsewhere");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("package.json"), "{}").unwrap();
        assert_eq!(v.duplicate_of(&other).unwrap().unwrap().id, it.id);
        let filed = v.file_item(&it.id, None).unwrap();
        assert_eq!(filed.path, "projects/thing");
        let zip = v.export_zip(&it.id, d.path()).unwrap();
        assert!(zip.exists());
    }
}
