/**
 * Finding and launching the `claude` CLI on Windows, macOS and Linux.
 *
 * A desktop app opened from the Dock, Start menu or a launcher doesn't get your shell's PATH,
 * so a plain `spawn("claude")` often fails there. This module rebuilds PATH from your login shell
 * (macOS/Linux), checks the usual install locations, and handles Windows .cmd shims.
 */
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const isWin = platform() === "win32";
let resolved: { cmd: string; shell: boolean } | null | undefined;

/** Add the login shell's PATH and common install folders to this process's PATH (once). */
export function fixPath() {
  const parts = new Set((process.env.PATH ?? "").split(delimiter).filter(Boolean));
  if (!isWin) {
    const sh = process.env.SHELL || (platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
    try {
      const out = execFileSync(sh, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/__PATH__(.*)__PATH__/);
      if (m) for (const p of m[1].split(":")) if (p) parts.add(p);
    } catch {
      /* no login shell available: fall back to the defaults below */
    }
  }
  const home = homedir();
  const extra = isWin
    ? [join(home, ".local", "bin"), join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"), join(home, ".claude", "local")]
    : [join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join(home, ".npm-global", "bin")];
  for (const p of extra) parts.add(p);
  process.env.PATH = [...parts].join(delimiter);
  resolved = undefined;
}

/** Where `claude` is, and whether it must go through a shell (Windows .cmd/.bat shims). */
export function claudeCommand(): { cmd: string; shell: boolean } | null {
  if (resolved !== undefined) return resolved;
  const override = process.env.CLAUDE_BIN;
  if (override) return (resolved = { cmd: override, shell: isWin && /\.(cmd|bat)$/i.test(override) });
  const names = isWin ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const n of names) {
      const full = join(dir, n);
      if (dir && existsSync(full)) return (resolved = { cmd: full, shell: isWin && !n.endsWith(".exe") });
    }
  }
  return null; // not cached: it may get installed while the app is open
}

const winQuote = (a: string) => (/^[\w.\-:\\/=@[\]]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

/** Spawn `claude` with arguments. Throws an ENOENT-style error when it isn't installed. */
export function spawnClaude(args: string[], opts: SpawnOptions = {}): ChildProcess {
  const c = claudeCommand();
  if (!c) {
    const err = new Error("The `claude` CLI isn't installed or isn't on PATH.") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  if (c.shell) {
    // Node refuses to run .cmd files without a shell; quote each argument for cmd.exe.
    return spawn([winQuote(c.cmd), ...args.map(winQuote)].join(" "), { ...opts, shell: true, windowsHide: true });
  }
  return spawn(c.cmd, args, { ...opts, windowsHide: true });
}

/** Run `claude` to completion and collect its output. */
export function runClaude(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnClaude(args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ stdout: "", stderr: "", code: 127 });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout!.on("data", (b) => (stdout += b));
    child.stderr!.on("data", (b) => (stderr += b));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}
