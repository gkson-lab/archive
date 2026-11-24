use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Container,
    Wasm,
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub label: String,
    pub command: String,
    /// run once before the first run (install dependencies)
    pub setup: Option<String>,
    /// main tool this needs, e.g. "node", "python", "cargo"
    pub tool: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolState {
    pub tool: String,
    pub installed: bool,
    /// pinned version from .nvmrc, .python-version, rust-toolchain.toml ...
    pub version: Option<String>,
    pub via_mise: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Detection {
    pub candidates: Vec<Candidate>,
    pub tools: Vec<ToolState>,
    pub container: Option<ContainerPlan>,
    pub wasm: Option<String>,
    pub mise: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerPlan {
    pub engine: Option<String>,
    pub image: String,
    pub from_devcontainer: bool,
}

fn read(dir: &Path, f: &str) -> Option<String> {
    fs::read_to_string(dir.join(f)).ok()
}

fn has(dir: &Path, f: &str) -> bool {
    dir.join(f).exists()
}

fn c(label: &str, command: &str, setup: Option<&str>, tool: Option<&str>, source: &str) -> Candidate {
    Candidate {
        label: label.into(),
        command: command.into(),
        setup: setup.map(|s| s.into()),
        tool: tool.map(|s| s.into()),
        source: source.into(),
    }
}

fn node_pm(dir: &Path) -> &'static str {
    if has(dir, "pnpm-lock.yaml") {
        "pnpm"
    } else if has(dir, "yarn.lock") {
        "yarn"
    } else if has(dir, "bun.lockb") || has(dir, "bun.lock") {
        "bun"
    } else {
        "npm"
    }
}

pub fn detect(dir: &Path) -> Detection {
    let mut out = Vec::new();
    let single_file = dir.is_file();
    if single_file {
        let ext = dir.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        let q = shell_quote(&name);
        match ext.as_str() {
            "py" => out.push(c("run with python", &format!("python3 {q}"), None, Some("python"), "file")),
            "js" | "mjs" => out.push(c("run with node", &format!("node {q}"), None, Some("node"), "file")),
            "ts" => out.push(c("run with node", &format!("npx -y tsx {q}"), None, Some("node"), "file")),
            "sh" | "bash" => out.push(c("run with sh", &format!("sh {q}"), None, None, "file")),
            "rb" => out.push(c("run with ruby", &format!("ruby {q}"), None, Some("ruby"), "file")),
            "go" => out.push(c("go run", &format!("go run {q}"), None, Some("go"), "file")),
            "rs" => out.push(c("compile and run", &format!("rustc {q} -o /tmp/archival-run && /tmp/archival-run"), None, Some("rustc"), "file")),
            "html" | "htm" => out.push(c("serve this page", &format!("python3 -m http.server 4173 --bind 127.0.0.1 # open /{name}"), None, Some("python"), "file")),
            _ => {}
        }
        let wasm = match ext.as_str() {
            "js" | "mjs" => Some("js".to_string()),
            "py" => Some("python".to_string()),
            _ => None,
        };
        return finish(dir.parent().unwrap_or(dir), out, wasm);
    }

    if let Some(pkg) = read(dir, "package.json") {
        let pm = node_pm(dir);
        let install = format!("{pm} install");
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pkg) {
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                for key in ["dev", "start", "serve", "preview", "build", "test"] {
                    if scripts.contains_key(key) {
                        let cmd = if pm == "npm" && key != "start" && key != "test" {
                            format!("npm run {key}")
                        } else {
                            format!("{pm} {key}")
                        };
                        out.push(c(&format!("{pm} {key}"), &cmd, Some(&install), Some("node"), "package.json"));
                    }
                }
                for (k, _) in scripts {
                    if !["dev", "start", "serve", "preview", "build", "test"].contains(&k.as_str()) {
                        out.push(c(&format!("{pm} run {k}"), &format!("{pm} run {k}"), Some(&install), Some("node"), "package.json"));
                    }
                }
            }
            if out.is_empty() {
                if let Some(main) = v.get("main").and_then(|m| m.as_str()) {
                    out.push(c("node main", &format!("node {}", shell_quote(main)), Some(&install), Some("node"), "package.json"));
                }
            }
        }
    }
    if let Some(d) = read(dir, "deno.json").or_else(|| read(dir, "deno.jsonc")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&d) {
            if let Some(t) = v.get("tasks").and_then(|t| t.as_object()) {
                for k in t.keys() {
                    out.push(c(&format!("deno task {k}"), &format!("deno task {k}"), None, Some("deno"), "deno.json"));
                }
            }
        }
    }
    if has(dir, "Cargo.toml") {
        out.push(c("cargo run", "cargo run", None, Some("cargo"), "Cargo.toml"));
        out.push(c("cargo test", "cargo test", None, Some("cargo"), "Cargo.toml"));
    }
    if has(dir, "go.mod") {
        out.push(c("go run .", "go run .", Some("go mod download"), Some("go"), "go.mod"));
        out.push(c("go test", "go test ./...", None, Some("go"), "go.mod"));
    }
    let py_setup = if has(dir, "uv.lock") {
        Some("uv sync".to_string())
    } else if has(dir, "requirements.txt") {
        Some("python3 -m venv .venv && .venv/bin/pip install -r requirements.txt".to_string())
    } else if has(dir, "pyproject.toml") {
        Some("python3 -m venv .venv && .venv/bin/pip install -e .".to_string())
    } else {
        None
    };
    let py = if has(dir, "uv.lock") { "uv run python" } else if py_setup.is_some() { ".venv/bin/python" } else { "python3" };
    for entry in ["main.py", "app.py", "manage.py", "run.py", "server.py"] {
        if has(dir, entry) {
            let cmd = if entry == "manage.py" { format!("{py} manage.py runserver") } else { format!("{py} {entry}") };
            out.push(c(&format!("python {entry}"), &cmd, py_setup.as_deref(), Some("python"), entry));
        }
    }
    if has(dir, "pyproject.toml") && !out.iter().any(|c| c.tool.as_deref() == Some("python")) {
        out.push(c("python -m (project)", &format!("{py} -m {}", dir.file_name().unwrap_or_default().to_string_lossy().replace('-', "_")), py_setup.as_deref(), Some("python"), "pyproject.toml"));
    }
    if let Some(mk) = read(dir, "Makefile") {
        for t in make_targets(&mk).into_iter().take(8) {
            out.push(c(&format!("make {t}"), &format!("make {t}"), None, Some("make"), "Makefile"));
        }
    }
    if let Some(j) = read(dir, "justfile").or_else(|| read(dir, "Justfile")) {
        for t in make_targets(&j).into_iter().take(8) {
            out.push(c(&format!("just {t}"), &format!("just {t}"), None, Some("just"), "justfile"));
        }
    }
    for f in ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"] {
        if has(dir, f) {
            out.push(c("compose up", &format!("docker compose -f {f} up"), None, Some("docker"), f));
            break;
        }
    }
    if has(dir, "Gemfile") && has(dir, "config.ru") {
        out.push(c("rackup", "bundle exec rackup", Some("bundle install"), Some("ruby"), "Gemfile"));
    }
    if has(dir, "index.html") && !out.iter().any(|c| c.tool.as_deref() == Some("node")) {
        out.push(c("serve static site", "python3 -m http.server 4173 --bind 127.0.0.1", None, Some("python"), "index.html"));
    }
    finish(dir, out, None)
}

fn finish(dir: &Path, candidates: Vec<Candidate>, wasm: Option<String>) -> Detection {
    let mise = which::which("mise").is_ok();
    let mut tools: Vec<ToolState> = Vec::new();
    for cand in &candidates {
        if let Some(t) = &cand.tool {
            if tools.iter().any(|x| &x.tool == t) {
                continue;
            }
            let bin = match t.as_str() {
                "python" => "python3",
                other => other,
            };
            let installed = which::which(bin).is_ok() || (t == "python" && which::which("python").is_ok());
            tools.push(ToolState { tool: t.clone(), installed, version: pinned_version(dir, t), via_mise: !installed && mise && mise_name(t).is_some() });
        }
    }
    let container = container_plan(dir, &candidates);
    Detection { candidates, tools, container, wasm, mise }
}

fn pinned_version(dir: &Path, tool: &str) -> Option<String> {
    let f = match tool {
        "node" => read(dir, ".nvmrc").or_else(|| read(dir, ".node-version")),
        "python" => read(dir, ".python-version"),
        "go" => read(dir, "go.mod").and_then(|g| g.lines().find(|l| l.starts_with("go ")).map(|l| l[3..].to_string())),
        "cargo" | "rustc" => read(dir, "rust-toolchain").or_else(|| {
            read(dir, "rust-toolchain.toml").and_then(|t| {
                t.lines().find(|l| l.trim_start().starts_with("channel")).and_then(|l| l.split('"').nth(1).map(|s| s.to_string()))
            })
        }),
        _ => None,
    };
    f.map(|s| s.trim().trim_start_matches('v').to_string()).filter(|s| !s.is_empty())
}

pub fn mise_name(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "node" => "node",
        "python" => "python",
        "go" => "go",
        "cargo" | "rustc" => "rust",
        "deno" => "deno",
        "ruby" => "ruby",
        "just" => "just",
        _ => return None,
    })
}

fn default_version(tool: &str) -> &'static str {
    match tool {
        "node" => "lts",
        "python" => "3.12",
        "rust" => "stable",
        _ => "latest",
    }
}

/// wrap a command so a missing toolchain is fetched by mise into archival's own toolchain
/// folder instead of the system.
pub fn wrap_with_mise(command: &str, tool: &str, version: Option<&str>) -> Option<String> {
    let name = mise_name(tool)?;
    let v = version.unwrap_or_else(|| default_version(name));
    Some(format!("mise exec {name}@{v} -- sh -c {}", shell_quote(command)))
}

fn container_plan(dir: &Path, candidates: &[Candidate]) -> Option<ContainerPlan> {
    let engine = ["docker", "podman"].iter().find(|e| which::which(e).is_ok()).map(|s| s.to_string());
    if let Some(dc) = read(dir, ".devcontainer/devcontainer.json").or_else(|| read(dir, ".devcontainer.json")) {
        let stripped: String = dc.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stripped) {
            if let Some(img) = v.get("image").and_then(|i| i.as_str()) {
                return Some(ContainerPlan { engine, image: img.into(), from_devcontainer: true });
            }
        }
    }
    let tool = candidates.first().and_then(|c| c.tool.clone())?;
    let image = match tool.as_str() {
        "node" => "node:22-bookworm",
        "python" => "python:3.12-bookworm",
        "cargo" | "rustc" => "rust:1-bookworm",
        "go" => "golang:1-bookworm",
        "ruby" => "ruby:3-bookworm",
        "deno" => "denoland/deno:latest",
        _ => "debian:bookworm",
    };
    Some(ContainerPlan { engine, image: image.into(), from_devcontainer: false })
}

/// build the container command for a project. network can be turned off.
pub fn container_command(engine: &str, image: &str, dir: &Path, command: &str, network: bool, ports: &[u16]) -> String {
    let mut s = format!("{engine} run --rm -it -v {}:/work -w /work", shell_quote(&dir.to_string_lossy()));
    if !network {
        s.push_str(" --network none");
    }
    for p in ports {
        s.push_str(&format!(" -p 127.0.0.1:{p}:{p}"));
    }
    s.push_str(&format!(" {image} sh -lc {}", shell_quote(command)));
    s
}

fn make_targets(src: &str) -> Vec<String> {
    let re = regex::Regex::new(r"(?m)^([A-Za-z][A-Za-z0-9_-]*)\s*:(?:[^=]|$)").unwrap();
    let mut out: Vec<String> = Vec::new();
    for cap in re.captures_iter(src) {
        let t = cap[1].to_string();
        if !out.contains(&t) && t != "PHONY" {
            out.push(t);
        }
    }
    out
}

pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_node_python_make() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        fs::write(p.join("package.json"), r#"{"scripts":{"dev":"vite","lint":"eslint ."}}"#).unwrap();
        fs::write(p.join("pnpm-lock.yaml"), "").unwrap();
        fs::write(p.join("Makefile"), "build:\n\tcc x.c\n\ntest: build\n\t./a\n").unwrap();
        let det = detect(p);
        let cmds: Vec<_> = det.candidates.iter().map(|c| c.command.as_str()).collect();
        assert_eq!(cmds[0], "pnpm dev");
        assert!(cmds.contains(&"pnpm run lint"));
        assert!(cmds.contains(&"make build") && cmds.contains(&"make test"));
        assert_eq!(det.candidates[0].setup.as_deref(), Some("pnpm install"));

        let f = p.join("hello.py");
        fs::write(&f, "print(1)").unwrap();
        let det = detect(&f);
        assert_eq!(det.candidates[0].command, "python3 hello.py");
        assert_eq!(det.wasm.as_deref(), Some("python"));
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
