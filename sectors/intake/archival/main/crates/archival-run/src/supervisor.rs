use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_BUF: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct StartSpec {
    pub item_id: String,
    pub cwd: PathBuf,
    /// empty = interactive shell
    pub command: String,
    pub label: String,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunInfo {
    pub id: String,
    pub item_id: String,
    pub label: String,
    pub command: String,
    pub interactive: bool,
    pub started: i64,
    pub ended: Option<i64>,
    /// "starting" | "ready" | "exited" | "failed" | "stopped"
    pub status: String,
    pub exit_code: Option<u32>,
    pub ports: Vec<u16>,
}

#[derive(Debug, Serialize)]
pub struct RunOutput {
    pub info: RunInfo,
    /// offset to pass as `since` next time
    pub next: u64,
    /// true when older output was dropped and `since` was too old
    pub truncated: bool,
    #[serde(skip)]
    pub data: Vec<u8>,
}

struct Buffer {
    start: u64,
    data: Vec<u8>,
}

struct Run {
    info: Mutex<RunInfo>,
    buf: Mutex<Buffer>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default, Clone)]
pub struct Supervisor {
    runs: Arc<Mutex<HashMap<String, Arc<Run>>>>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn shell_command(command: &str) -> CommandBuilder {
    #[cfg(windows)]
    {
        if command.is_empty() {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        } else {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/C", command]);
            c
        }
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let mut c = CommandBuilder::new(&shell);
        if command.is_empty() {
            c.arg("-l");
        } else {
            c.args(["-lc", command]);
        }
        c
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self, spec: StartSpec) -> Result<RunInfo> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows: spec.rows.max(4), cols: spec.cols.max(20), pixel_width: 0, pixel_height: 0 })?;
        let mut cmd = shell_command(&spec.command);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("FORCE_COLOR", "1");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| anyhow!("couldn't start: {e}"))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let killer = child.clone_killer();
        let id = uuid::Uuid::new_v4().to_string();
        let info = RunInfo {
            id: id.clone(),
            item_id: spec.item_id.clone(),
            label: if spec.label.is_empty() { if spec.command.is_empty() { "terminal".into() } else { spec.command.clone() } } else { spec.label.clone() },
            command: spec.command.clone(),
            interactive: spec.command.is_empty(),
            started: now(),
            ended: None,
            status: if spec.command.is_empty() { "ready".into() } else { "starting".into() },
            exit_code: None,
            ports: vec![],
        };
        let run = Arc::new(Run {
            info: Mutex::new(info.clone()),
            buf: Mutex::new(Buffer { start: 0, data: Vec::new() }),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
        });
        self.runs.lock().unwrap().insert(id.clone(), run.clone());

        // output reader: append to the ring buffer and watch for dev server ports
        let r2 = run.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut chunk = [0u8; 8192];
            let port_re = regex::Regex::new(r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})").unwrap();
            let ansi = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap();
            let mut tail = String::new();
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        {
                            let mut b = r2.buf.lock().unwrap();
                            b.data.extend_from_slice(&chunk[..n]);
                            if b.data.len() > MAX_BUF {
                                let drop_n = b.data.len() - MAX_BUF;
                                b.data.drain(..drop_n);
                                b.start += drop_n as u64;
                            }
                        }
                        tail.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        if tail.len() > 4096 {
                            let cut = tail.len() - 1024;
                            let cut = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(tail.len());
                            tail.drain(..cut);
                        }
                        let clean = ansi.replace_all(&tail, "");
                        let found: BTreeSet<u16> = port_re.captures_iter(&clean).filter_map(|c| c[1].parse().ok()).filter(|p| *p >= 80).collect();
                        if !found.is_empty() {
                            let mut i = r2.info.lock().unwrap();
                            for p in found {
                                if !i.ports.contains(&p) {
                                    i.ports.push(p);
                                }
                            }
                            if i.status == "starting" {
                                i.status = "ready".into();
                            }
                        }
                    }
                }
            }
        });

        // waiter: record the exit
        let r3 = run.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let mut i = r3.info.lock().unwrap();
            i.ended = Some(now());
            match status {
                Ok(s) => {
                    i.exit_code = Some(s.exit_code());
                    if i.status != "stopped" {
                        i.status = if s.success() { "exited".into() } else { "failed".into() };
                    }
                }
                Err(_) => i.status = "failed".into(),
            }
        });
        Ok(info)
    }

    fn get(&self, id: &str) -> Result<Arc<Run>> {
        self.runs.lock().unwrap().get(id).cloned().ok_or_else(|| anyhow!("that run has ended or doesn't exist"))
    }

    pub fn read(&self, id: &str, since: u64) -> Result<RunOutput> {
        let run = self.get(id)?;
        let b = run.buf.lock().unwrap();
        let end = b.start + b.data.len() as u64;
        let (from, truncated) = if since < b.start { (b.start, since > 0) } else { (since.min(end), false) };
        let data = b.data[(from - b.start) as usize..].to_vec();
        let info = run.info.lock().unwrap().clone();
        Ok(RunOutput { info, next: end, truncated, data })
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let run = self.get(id)?;
        let mut w = run.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let run = self.get(id)?;
        let m = run.master.lock().unwrap();
        m.resize(PtySize { rows: rows.max(4), cols: cols.max(20), pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let run = self.get(id)?;
        {
            let mut i = run.info.lock().unwrap();
            if i.ended.is_some() {
                return Ok(());
            }
            i.status = "stopped".into();
        }
        let _ = run.killer.lock().unwrap().kill();
        Ok(())
    }

    /// forget a finished run
    pub fn remove(&self, id: &str) -> Result<()> {
        let _ = self.stop(id);
        self.runs.lock().unwrap().remove(id);
        Ok(())
    }

    pub fn list(&self) -> Vec<RunInfo> {
        let mut v: Vec<RunInfo> = self.runs.lock().unwrap().values().map(|r| r.info.lock().unwrap().clone()).collect();
        v.sort_by_key(|r| r.started);
        v
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.runs.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }

    /// run to completion and return (exit code, output). used by the cli and mcp.
    pub fn run_blocking(&self, spec: StartSpec, timeout: Duration) -> Result<(Option<u32>, String)> {
        let info = self.start(spec)?;
        let t0 = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let out = self.read(&info.id, 0)?;
            if out.info.ended.is_some() {
                // give the reader a moment to drain
                std::thread::sleep(Duration::from_millis(150));
                let out = self.read(&info.id, 0)?;
                self.remove(&info.id)?;
                return Ok((out.info.exit_code, String::from_utf8_lossy(&out.data).to_string()));
            }
            if t0.elapsed() > timeout {
                let out = self.read(&info.id, 0)?;
                self.remove(&info.id)?;
                return Ok((None, format!("{}\n[stopped after {}s]", String::from_utf8_lossy(&out.data), timeout.as_secs())));
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn runs_and_detects_ports() {
        let s = Supervisor::new();
        let d = tempfile::tempdir().unwrap();
        let spec = |cmd: &str| StartSpec {
            item_id: "x".into(),
            cwd: d.path().to_path_buf(),
            command: cmd.into(),
            label: String::new(),
            env: vec![],
            cols: 80,
            rows: 24,
        };
        let (code, out) = s.run_blocking(spec("echo hello; echo 'listening on http://localhost:5173/'"), Duration::from_secs(10)).unwrap();
        assert_eq!(code, Some(0));
        assert!(out.contains("hello"));
        let info = s.start(spec("echo 'ready at 127.0.0.1:8080'; sleep 5")).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        let o = s.read(&info.id, 0).unwrap();
        assert_eq!(o.info.ports, vec![8080]);
        assert_eq!(o.info.status, "ready");
        s.stop(&info.id).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(s.read(&info.id, 0).unwrap().info.status, "stopped");
    }
}
