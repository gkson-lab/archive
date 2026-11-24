//! everything that brings outside files into the vault. ingested things always land in
//! `vault/inbox/` first with a suggested kind, folder and tags; triage files them.

use anyhow::{anyhow, Context, Result};
use archival_core::classify::suggest;
use archival_core::paths::{safe_name, unique_name};
use archival_core::{Item, Kind, Suggestion, Vault};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub type Progress<'a> = &'a (dyn Fn(usize, usize) + Send + Sync);

pub fn no_progress(_: usize, _: usize) {}

#[derive(Debug, Serialize)]
pub struct Ingested {
    pub item: Item,
    pub suggestion: Suggestion,
    /// an existing item with identical contents, if there is one
    pub duplicate_of: Option<Item>,
}

#[derive(Debug, Clone)]
pub struct Origin {
    pub connector: String,
    pub source: String,
    pub title: Option<String>,
}

impl Origin {
    pub fn local(src: &Path) -> Self {
        Origin { connector: "local".into(), source: src.to_string_lossy().to_string(), title: None }
    }
}

fn inbox(v: &Vault) -> PathBuf {
    v.vault_dir().join("inbox")
}

/// count what a copy would move, so progress can say "12 of 40 files".
fn count_files(src: &Path) -> usize {
    walkdir::WalkDir::new(src)
        .into_iter()
        .filter_entry(|e| !archival_core::tree::is_default_ignored(&e.file_name().to_string_lossy()))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .count()
}

/// copy a folder, keeping .git (history matters) but skipping the default ignore list.
fn copy_tree(src: &Path, dest: &Path, progress: Progress) -> Result<()> {
    let total = count_files(src);
    let mut done = 0;
    progress(0, total);
    for e in walkdir::WalkDir::new(src)
        .into_iter()
        .filter_entry(|e| !archival_core::tree::is_default_ignored(&e.file_name().to_string_lossy()))
    {
        let e = e?;
        let rel = e.path().strip_prefix(src)?;
        let target = dest.join(rel);
        if e.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if e.file_type().is_file() {
            if let Some(p) = target.parent() {
                fs::create_dir_all(p)?;
            }
            fs::copy(e.path(), &target).with_context(|| format!("copying {}", e.path().display()))?;
            done += 1;
            if done % 16 == 0 || done == total {
                progress(done, total);
            }
        } else if e.file_type().is_symlink() {
            #[cfg(unix)]
            if let Ok(link) = fs::read_link(e.path()) {
                let _ = std::os::unix::fs::symlink(link, &target);
            }
        }
    }
    progress(total, total);
    Ok(())
}

fn finish(v: &Vault, dest: &Path, origin: &Origin, dup: Option<Item>) -> Result<Ingested> {
    let s = suggest(dest);
    let item = v.register(dest, &origin.connector, &origin.source, &s, origin.title.as_deref())?;
    v.set_fingerprint(&item.id)?;
    // first snapshot = the state it arrived in
    v.snapshot(&item.id, "as ingested", "ingest")?;
    let item = v.item(&item.id)?;
    Ok(Ingested { item, suggestion: s, duplicate_of: dup })
}

/// import a folder or single file by copying it into the inbox.
pub fn ingest_path(v: &Vault, src: &Path, origin: &Origin, progress: Progress) -> Result<Ingested> {
    let src = src.canonicalize().with_context(|| format!("can't read {}", src.display()))?;
    if src.starts_with(v.root()) {
        return Err(anyhow!("that's already inside the vault"));
    }
    if src.is_file() && src.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false) {
        return ingest_zip(v, &src, origin, progress);
    }
    let dup = v.duplicate_of(&src).ok().flatten();
    let name = origin
        .title
        .as_deref()
        .map(safe_name)
        .map(|n| match (src.is_file(), src.extension()) {
            (true, Some(e)) if !n.ends_with(&format!(".{}", e.to_string_lossy())) => format!("{n}.{}", e.to_string_lossy()),
            _ => n,
        })
        .unwrap_or_else(|| src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "imported".into()));
    let dest = inbox(v).join(unique_name(&inbox(v), &name));
    if src.is_dir() {
        copy_tree(&src, &dest, progress)?;
    } else {
        progress(0, 1);
        fs::copy(&src, &dest)?;
        progress(1, 1);
    }
    finish(v, &dest, origin, dup)
}

/// extract a zip into the inbox. a zip with one top folder becomes that folder.
pub fn ingest_zip(v: &Vault, src: &Path, origin: &Origin, progress: Progress) -> Result<Ingested> {
    let f = fs::File::open(src)?;
    let mut z = zip::ZipArchive::new(f).context("not a readable zip")?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "archive".into());
    let tmp = v.meta_dir().join("tmp").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&tmp)?;
    let total = z.len();
    for i in 0..total {
        let mut entry = z.by_index(i)?;
        let Some(rel) = entry.enclosed_name() else { continue };
        if rel.components().any(|c| c.as_os_str() == "__MACOSX") {
            continue;
        }
        let out = tmp.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p)?;
            }
            let mut w = fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut w)?;
        }
        if i % 16 == 0 {
            progress(i, total);
        }
    }
    progress(total, total);
    let tops: Vec<_> = fs::read_dir(&tmp)?.filter_map(|e| e.ok()).collect();
    let (content, name) = if tops.len() == 1 && tops[0].path().is_dir() {
        (tops[0].path(), tops[0].file_name().to_string_lossy().to_string())
    } else {
        (tmp.clone(), stem)
    };
    let name = origin.title.as_deref().map(safe_name).unwrap_or(name);
    let dup = v.duplicate_of(&content).ok().flatten();
    let dest = inbox(v).join(unique_name(&inbox(v), &name));
    fs::rename(&content, &dest)?;
    let _ = fs::remove_dir_all(&tmp);
    finish(v, &dest, origin, dup)
}

/// save pasted text as a file in the inbox.
pub fn ingest_text(v: &Vault, title: &str, text: &str, ext: &str, origin: &Origin) -> Result<Ingested> {
    let ext = ext.trim_start_matches('.');
    let ext = if ext.is_empty() { guess_ext(text) } else { ext };
    let name = format!("{}.{ext}", safe_name(if title.is_empty() { "pasted" } else { title }));
    let dest = inbox(v).join(unique_name(&inbox(v), &name));
    fs::write(&dest, text)?;
    finish(v, &dest, origin, None)
}

/// save uploaded bytes (browser drop, connector download) as a file or extracted zip.
pub fn ingest_bytes(v: &Vault, name: &str, bytes: &[u8], origin: &Origin, progress: Progress) -> Result<Ingested> {
    let name = safe_name(name);
    let tmp_dir = v.meta_dir().join("tmp").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&tmp_dir)?;
    let tmp = tmp_dir.join(&name);
    fs::write(&tmp, bytes)?;
    let out = if name.to_lowercase().ends_with(".zip") {
        ingest_zip(v, &tmp, origin, progress)
    } else {
        let dest = inbox(v).join(unique_name(&inbox(v), &name));
        fs::rename(&tmp, &dest)?;
        finish(v, &dest, origin, None)
    };
    let _ = fs::remove_dir_all(&tmp_dir);
    out
}

/// prepare a fresh inbox folder for a connector to write into, then register it with `finish_folder`.
pub fn new_inbox_folder(v: &Vault, name: &str) -> Result<PathBuf> {
    let dest = inbox(v).join(unique_name(&inbox(v), &safe_name(name)));
    fs::create_dir_all(&dest)?;
    Ok(dest)
}

pub fn finish_folder(v: &Vault, dest: &Path, origin: &Origin) -> Result<Ingested> {
    let dup = None;
    finish(v, dest, origin, dup)
}

fn guess_ext(text: &str) -> &'static str {
    let t = text.trim_start();
    if t.starts_with("<!doctype html") || t.starts_with("<!DOCTYPE html") || t.starts_with("<html") {
        "html"
    } else if t.starts_with("<svg") {
        "svg"
    } else if t.starts_with('{') || t.starts_with('[') {
        "json"
    } else if t.starts_with("#!/") {
        "sh"
    } else if t.starts_with('#') || t.contains("\n## ") {
        "md"
    } else if t.contains("fn main") || t.contains("pub fn ") {
        "rs"
    } else if t.contains("def ") && t.contains(':') || t.starts_with("import ") && !t.contains(" from ") {
        "py"
    } else if t.contains("function ") || t.contains("const ") || t.contains("=> ") {
        "js"
    } else {
        "txt"
    }
}

/// fetch a url. pages become link items with a cached copy; files are saved directly.
pub async fn ingest_url(v: &Vault, raw: &str) -> Result<Ingested> {
    let u = url::Url::parse(raw).context("that doesn't look like a url")?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(anyhow!("only http and https urls can be saved"));
    }
    let client = reqwest::Client::builder().user_agent("archival/0.1").build()?;
    let resp = client.get(u.clone()).send().await?.error_for_status()?;
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let origin = Origin { connector: "url".into(), source: raw.into(), title: None };
    let final_url = resp.url().clone();
    let bytes = resp.bytes().await?;
    if !ctype.contains("text/html") {
        let name = final_url
            .path_segments()
            .and_then(|s| s.last())
            .filter(|s| !s.is_empty())
            .unwrap_or("download")
            .to_string();
        return ingest_bytes(v, &name, &bytes, &origin, &no_progress);
    }
    let html = String::from_utf8_lossy(&bytes).to_string();
    let title = meta(&html, r"(?is)<title[^>]*>(.*?)</title>")
        .map(|t| decode_entities(t.trim()))
        .unwrap_or_else(|| u.host_str().unwrap_or("link").to_string());
    let description = meta(&html, r#"(?is)<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)"#);
    let image = meta(&html, r#"(?is)<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)"#);
    let dir = new_inbox_folder(v, &title)?;
    fs::write(dir.join("page.html"), &html)?;
    let mut thumb = None;
    if let Some(img) = image.and_then(|i| final_url.join(&i).ok()) {
        if let Ok(r) = client.get(img.clone()).send().await {
            if let Ok(b) = r.bytes().await {
                let ext = Path::new(img.path()).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "png".into());
                let name = format!("thumb.{ext}");
                fs::write(dir.join(&name), &b)?;
                thumb = Some(name);
            }
        }
    }
    let link = serde_json::json!({
        "url": final_url.as_str(),
        "title": title,
        "description": description.map(|d| decode_entities(&d)),
        "thumbnail": thumb,
        "fetched": chrono::Utc::now().to_rfc3339(),
    });
    fs::write(dir.join("link.json"), serde_json::to_vec_pretty(&link)?)?;
    let s = Suggestion { kind: Kind::Link, category: "links".into(), tags: vec![] };
    let item = v.register(&dir, "url", raw, &s, Some(&title))?;
    v.snapshot(&item.id, "as saved", "ingest")?;
    Ok(Ingested { item, suggestion: s, duplicate_of: None })
}

fn meta(html: &str, re: &str) -> Option<String> {
    regex::Regex::new(re).ok()?.captures(html).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_zip_and_text() {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::open(d.path().join("vault-root")).unwrap();
        let src = d.path().join("myapp");
        fs::create_dir_all(src.join("node_modules/x")).unwrap();
        fs::write(src.join("node_modules/x/i.js"), "x").unwrap();
        fs::write(src.join("package.json"), "{}").unwrap();
        fs::write(src.join("app.ts"), "const a = 1").unwrap();
        let r = ingest_path(&v, &src, &Origin::local(&src), &no_progress).unwrap();
        assert_eq!(r.item.path, "inbox/myapp");
        assert_eq!(r.suggestion.kind, Kind::Project);
        assert!(!d.path().join("vault-root/vault/inbox/myapp/node_modules").exists());
        let again = ingest_path(&v, &src, &Origin::local(&src), &no_progress).unwrap();
        assert_eq!(again.duplicate_of.unwrap().id, r.item.id);
        assert_eq!(again.item.path, "inbox/myapp-2");

        // zip with one top folder
        let zpath = d.path().join("bundle.zip");
        {
            let mut z = zip::ZipWriter::new(fs::File::create(&zpath).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("site/index.html", o).unwrap();
            std::io::Write::write_all(&mut z, b"<html></html>").unwrap();
            z.finish().unwrap();
        }
        let r = ingest_path(&v, &zpath, &Origin::local(&zpath), &no_progress).unwrap();
        assert_eq!(r.item.path, "inbox/site");
        assert_eq!(r.item.kind, Kind::Project);

        let t = ingest_text(&v, "idea", "# idea\n\nsome text", "", &Origin::local(d.path())).unwrap();
        assert_eq!(t.item.path, "inbox/idea.md");
        assert_eq!(t.item.kind, Kind::Document);
    }
}
