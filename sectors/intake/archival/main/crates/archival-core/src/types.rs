use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Project,
    Document,
    Design,
    Snippet,
    Asset,
    Link,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Project => "project",
            Kind::Document => "document",
            Kind::Design => "design",
            Kind::Snippet => "snippet",
            Kind::Asset => "asset",
            Kind::Link => "link",
        }
    }
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "project" => Kind::Project,
            "document" => Kind::Document,
            "design" => Kind::Design,
            "snippet" => Kind::Snippet,
            "asset" => Kind::Asset,
            "link" => Kind::Link,
            _ => return None,
        })
    }
    /// the folder under `vault/` an item of this kind is filed into.
    pub fn category(&self) -> &'static str {
        match self {
            Kind::Project => "projects",
            Kind::Document => "docs",
            Kind::Design => "designs",
            Kind::Snippet => "snippets",
            Kind::Asset => "assets",
            Kind::Link => "links",
        }
    }
}

/// top-level folders under `vault/`. `inbox` holds ingested items that are not filed yet.
pub const CATEGORIES: &[&str] = &["projects", "docs", "designs", "snippets", "assets", "links", "inbox"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    /// path relative to `vault/`, forward slashes. e.g. `projects/windsim`
    pub path: String,
    pub is_dir: bool,
    pub origin_connector: String,
    pub origin_source: String,
    pub tags: Vec<String>,
    pub created: i64,
    pub updated: i64,
    pub remote: Option<String>,
    pub account: Option<String>,
    pub trusted: bool,
    pub run_command: Option<String>,
    pub run_setup: Option<String>,
    pub run_mode: Option<String>,
    pub local_only: bool,
    pub pinned: bool,
    pub opened: i64,
}

impl Item {
    pub fn category(&self) -> &str {
        self.path.split('/').next().unwrap_or("")
    }
    pub fn in_inbox(&self) -> bool {
        self.category() == "inbox"
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemPatch {
    pub title: Option<String>,
    pub kind: Option<Kind>,
    pub tags: Option<Vec<String>>,
    pub remote: Option<Option<String>>,
    pub account: Option<Option<String>>,
    pub trusted: Option<bool>,
    pub run_command: Option<Option<String>>,
    pub run_setup: Option<Option<String>>,
    pub run_mode: Option<Option<String>>,
    pub local_only: Option<bool>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub ext: String,
    pub modified: i64,
    /// for category roots: how many items it holds
    pub count: Option<usize>,
    /// set when this entry is the root of an item
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub id: String,
    pub item_id: String,
    pub created: i64,
    pub label: String,
    pub source: String,
    pub manifest: String,
    pub file_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub hash: String,
    pub size: u64,
    #[serde(default)]
    pub exec: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Manifest {
    pub files: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub item_id: String,
    pub title: String,
    pub kind: Kind,
    pub path: String,
    /// snippet with matches wrapped in \u{2} ... \u{3}
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashEntry {
    pub id: String,
    pub original_path: String,
    pub item_id: Option<String>,
    pub title: String,
    pub trashed_at: i64,
    pub is_item: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    pub kind: Kind,
    pub category: String,
    pub tags: Vec<String>,
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
