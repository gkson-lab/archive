/** Thin wrappers around the official `claude` CLI: sign-in, status, the agents on this machine, and cloud hand-off. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCommand, runClaude, spawnClaude } from "./cli.js";
import { bus } from "./store.js";

export interface ClaudeAuth {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

export async function claudeAuthStatus(): Promise<ClaudeAuth> {
  const r = await runClaude(["auth", "status", "--json"]);
  if (r.code === 127) return { installed: false, loggedIn: false };
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    return {
      installed: true,
      loggedIn: Boolean(j.loggedIn),
      authMethod: j.authMethod as string | undefined,
      email: (j.email ?? j.emailAddress) as string | undefined,
      orgName: (j.orgName ?? j.organizationName) as string | undefined,
      subscriptionType: j.subscriptionType as string | undefined,
    };
  } catch {
    return { installed: true, loggedIn: false };
  }
}

let loginProc: ChildProcess | undefined;

/**
 * Starts Claude Code's own sign-in (`claude auth login`), which opens claude.ai in your browser.
 * agentdeck never sees your password or token: the CLI stores the credential where it always does.
 */
export function startLogin(method: "claudeai" | "console") {
  if (loginProc && loginProc.exitCode === null) return { started: false, message: "A sign-in is already in progress." };
  try {
    loginProc = spawnClaude(["auth", "login", method === "console" ? "--console" : "--claudeai"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (e) {
    return { started: false, message: (e as Error).message };
  }
  const forward = (b: Buffer) => {
    // Pass the CLI's output (the sign-in URL, prompts) to the UI, without terminal escape codes.
    const text = b.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (text.trim()) bus.emit("auth-log", text);
  };
  loginProc.stdout!.on("data", forward);
  loginProc.stderr!.on("data", forward);
  loginProc.on("error", (e) => bus.emit("auth-log", `Could not start claude: ${e.message}\n`));
  loginProc.on("close", (code) => bus.emit("auth-done", code));
  return { started: true };
}

/** Some sign-in flows ask you to paste a code from the browser; this hands it to the CLI's prompt. */
export function sendLoginCode(code: string) {
  if (!loginProc || loginProc.exitCode !== null) return false;
  loginProc.stdin!.write(code.trim() + "\n");
  return true;
}

export async function logout() {
  return runClaude(["auth", "logout"]);
}

/** Every Claude Code session on this computer (interactive, background, and ones agentdeck started). */
export async function machineAgents() {
  const r = await runClaude(["agents", "--json", "--all"], 20000);
  if (r.code === 127) return { installed: false, sessions: [] };
  try {
    return { installed: true, sessions: JSON.parse(r.stdout) as unknown[] };
  } catch {
    return { installed: true, sessions: [], error: r.stderr.trim() || "Could not read `claude agents --json`." };
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function has(cmd: string) {
  try {
    execFileSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detached(cmd: string, args: string[]) {
  const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
  p.on("error", () => {});
  p.unref();
}

/**
 * A new Claude Code cloud session (claude.ai/code) can only be created from an interactive terminal,
 * so this opens one running `claude --cloud "<task>"`. The task goes through a temp file, so no
 * character in it can be read by a shell as a command.
 */
export function openCloudInTerminal(task: string, cwd: string): { opened: boolean; command: string; message?: string } {
  const os = platform();
  const claude = claudeCommand()?.cmd ?? "claude";
  const dir = mkdtempSync(join(tmpdir(), "agentdeck-"));
  const taskFile = join(dir, "task.txt");
  writeFileSync(taskFile, task, { mode: 0o600 });

  if (os === "win32") {
    const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const command = `Set-Location -LiteralPath ${ps(cwd)}; & ${ps(claude)} --cloud (Get-Content -Raw -LiteralPath ${ps(taskFile)})`;
    detached("cmd.exe", ["/c", "start", "agentdeck", "powershell.exe", "-NoExit", "-NoProfile", "-Command", command]);
    return { opened: true, command: `claude --cloud "<your task>"  (in ${cwd})` };
  }

  const command = `cd ${shq(cwd)} && ${shq(claude)} --cloud "$(cat ${shq(taskFile)})"`;
  if (os === "darwin") {
    const as = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    detached("osascript", ["-e", `tell application "Terminal" to do script "${as}"`, "-e", 'tell application "Terminal" to activate']);
    return { opened: true, command };
  }

  const keep = `${command}; exec "\${SHELL:-bash}"`;
  const terminals: [string, string[]][] = [
    ["x-terminal-emulator", ["-e", "bash", "-lc", keep]],
    ["gnome-terminal", ["--", "bash", "-lc", keep]],
    ["konsole", ["-e", "bash", "-lc", keep]],
    ["xfce4-terminal", ["-x", "bash", "-lc", keep]],
    ["kitty", ["bash", "-lc", keep]],
    ["alacritty", ["-e", "bash", "-lc", keep]],
    ["xterm", ["-e", "bash", "-lc", keep]],
  ];
  for (const [bin, args] of terminals) {
    if (has(bin)) {
      detached(bin, args);
      return { opened: true, command };
    }
  }
  return { opened: false, command, message: "Couldn't find a terminal app. Run this yourself:" };
}
