//! guess what an ingested file or folder is, where it should be filed and how to tag it.

use crate::tree::walk_files;
use crate::{Kind, Suggestion};
use std::collections::BTreeSet;
use std::path::Path;

const PROJECT_MARKERS: &[&str] = &[
    ".git", "package.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "go.mod", "Makefile",
    "justfile", "deno.json", "index.html", "docker-compose.yml", "compose.yaml", ".devcontainer",
    "setup.py", "pom.xml", "build.gradle", "CMakeLists.txt", "Gemfile", "composer.json", "mix.exs",
];

pub fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn kind_for_ext(ext: &str) -> Kind {
    match ext {
        "md" | "markdown" | "txt" | "pdf" | "docx" | "doc" | "rtf" | "odt" | "html" | "htm" | "org" | "rst" | "tex" => {
            Kind::Document
        }
        "svg" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "fig" | "sketch" | "psd" | "ai" | "xd" | "afdesign" => {
            Kind::Design
        }
        "url" | "webloc" => Kind::Link,
        e if is_code_ext(e) => Kind::Snippet,
        _ => Kind::Asset,
    }
}

pub fn is_code_ext(ext: &str) -> bool {
    matches!(
        ext,
        "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "rb" | "php" | "java" | "kt" | "swift"
            | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "sh" | "bash" | "zsh" | "fish" | "ps1" | "lua" | "sql"
            | "css" | "scss" | "vue" | "svelte" | "json" | "yaml" | "yml" | "toml" | "xml" | "zig" | "dart"
            | "ex" | "exs" | "hs" | "ml" | "r" | "jl" | "scala" | "clj" | "elm" | "nim" | "wgsl" | "glsl" | "frag" | "vert"
    )
}

pub fn is_text_ext(ext: &str) -> bool {
    is_code_ext(ext)
        || matches!(
            ext,
            "md" | "markdown" | "txt" | "html" | "htm" | "svg" | "csv" | "tsv" | "ini" | "cfg" | "conf" | "env"
                | "gitignore" | "lock" | "log" | "org" | "rst" | "tex" | "mdx" | "astro" | "graphql" | "proto"
                | "dockerfile" | "makefile" | "editorconfig" | ""
        )
}

pub fn lang_tag(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "rb" => "ruby",
        "swift" => "swift",
        "kt" => "kotlin",
        "java" => "java",
        "c" | "h" => "c",
        "cc" | "cpp" | "hpp" => "c++",
        "cs" => "c#",
        "php" => "php",
        "sh" | "bash" | "zsh" => "shell",
        "lua" => "lua",
        "zig" => "zig",
        "dart" => "dart",
        "svelte" => "svelte",
        "vue" => "vue",
        "wgsl" | "glsl" | "frag" | "vert" => "shaders",
        "fig" => "figma",
        _ => return None,
    })
}

pub fn suggest(path: &Path) -> Suggestion {
    let mut tags = BTreeSet::new();
    let kind = if path.is_dir() {
        let has_marker = PROJECT_MARKERS.iter().any(|m| path.join(m).exists());
        let mut counts = std::collections::HashMap::<Kind, usize>::new();
        let mut code = 0usize;
        for (i, f) in walk_files(path).enumerate() {
            if i > 4000 {
                break;
            }
            let ext = ext_of(&f);
            if let Some(t) = lang_tag(&ext) {
                tags.insert(t.to_string());
            }
            // data formats (json, yaml, toml, xml) don't make a folder a project on their own
            if is_code_ext(&ext) && !matches!(ext.as_str(), "json" | "yaml" | "yml" | "toml" | "xml" | "css" | "scss") {
                code += 1;
            }
            *counts.entry(kind_for_ext(&ext)).or_default() += 1;
        }
        if path.join("index.html").exists() {
            tags.insert("web".into());
        }
        if path.join(".git").exists() {
            tags.insert("git".into());
        }
        if walk_files(path).take(200).any(|f| ext_of(&f) == "json" && looks_like_tokens(&f)) {
            tags.insert("tokens".into());
            *counts.entry(Kind::Design).or_default() += 2;
        }
        let total: usize = counts.values().sum();
        if has_marker || code > 0 && code * 3 >= total {
            Kind::Project
        } else if total > 0 && counts.get(&Kind::Design).copied().unwrap_or(0) * 2 >= total {
            Kind::Design
        } else if total > 0 && counts.get(&Kind::Document).copied().unwrap_or(0) * 2 >= total {
            Kind::Document
        } else if code > 0 {
            Kind::Project
        } else {
            Kind::Document
        }
    } else {
        let ext = ext_of(path);
        if let Some(t) = lang_tag(&ext) {
            tags.insert(t.to_string());
        }
        if ext == "json" && looks_like_tokens(path) {
            tags.insert("tokens".into());
            Kind::Design
        } else {
            kind_for_ext(&ext)
        }
    };
    Suggestion { kind, category: kind.category().to_string(), tags: tags.into_iter().take(6).collect() }
}

fn looks_like_tokens(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|s| s.len() < 2_000_000 && (s.contains("\"$value\"") || s.contains("\"tokens\"") || s.contains("\"$type\"")))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_projects_and_docs() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("app");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("package.json"), "{}").unwrap();
        std::fs::write(p.join("main.ts"), "let a = 1").unwrap();
        let s = suggest(&p);
        assert_eq!(s.kind, Kind::Project);
        assert!(s.tags.contains(&"typescript".to_string()));

        let n = d.path().join("notes");
        std::fs::create_dir_all(&n).unwrap();
        std::fs::write(n.join("a.md"), "# a").unwrap();
        std::fs::write(n.join("b.pdf"), "x").unwrap();
        assert_eq!(suggest(&n).kind, Kind::Document);
        assert_eq!(suggest(&n.join("a.md")).kind, Kind::Document);

        let b = d.path().join("brand");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("tokens.json"), r##"{"color":{"a":{"$value":"#fff"}}}"##).unwrap();
        std::fs::write(b.join("mark.svg"), "<svg/>").unwrap();
        assert_eq!(suggest(&b).kind, Kind::Design);
    }
}
