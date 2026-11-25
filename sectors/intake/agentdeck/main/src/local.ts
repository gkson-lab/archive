/**
 * Runs agents on this computer through the Claude Code CLI, signed in with your Claude account.
 *
 * Each turn is one `claude -p --output-format stream-json` process; later turns use `--resume <session>`,
 * which is what lets every chamber pick its own model and effort per message. Subagents show up in the
 * stream as `Agent`/`Task` tool calls plus `task_*` system events, and their own messages carry
 * `parent_tool_use_id`, which is how each one gets its own chamber.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { spawnClaude } from "./cli.js";
import { agentDefs, type AgentDef } from "./roster.js";
import { log, node, touch } from "./store.js";
import type { AgentNode, QueuedMessage, Run } from "./types.js";

const procs = new Map<string, ChildProcess>();
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export function expandHome(p?: string) {
  if (!p) return homedir();
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

export function validateCwd(p?: string): string {
  const dir = expandHome(p?.trim());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  return dir;
}

export function isBusy(run: Run) {
  return procs.has(run.id);
}

/** Queue a message for a chamber. Runs now if the agent is free, otherwise after the current turn. */
export function talkLocal(run: Run, msg: QueuedMessage) {
  log(run, msg.nodeId, "user", msg.text);
  if (procs.has(run.id)) {
    run.queue.push(msg);
    touch(run);
    return;
  }
  void runTurn(run, msg);
}

/** Stop every agent this app started on this computer (used when the desktop app quits). */
export function stopAllLocal() {
  for (const [, p] of procs) {
    if (p.pid && process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    else p.kill("SIGINT");
  }
}

export function stopLocal(run: Run) {
  run.queue = [];
  const p = procs.get(run.id);
  if (p?.pid && process.platform === "win32") {
    // On Windows the CLI can sit behind cmd.exe; end the whole process tree.
    spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
  } else if (p) {
    p.kill("SIGINT");
    setTimeout(() => procs.get(run.id)?.kill("SIGKILL"), 4000);
  }
  run.status = "stopped";
  for (const n of run.nodes) if (n.status === "running" || n.status === "queued") n.status = "stopped";
  touch(run);
}

function relayText(target: AgentNode, text: string) {
  return [
    `[Message from the user for your subagent "${target.name}"${target.taskId ? ` (agent id: ${target.taskId})` : ""}, which you started for: "${target.description}"]`,
    "",
    text,
    "",
    `Relay this to that subagent with SendMessage${target.taskId ? ` (to agent id ${target.taskId})` : ""}, wait for its answer, and report the answer back word for word. ` +
      `If it can no longer be messaged, start a new "${target.name}" subagent with its earlier task as context and this message.`,
  ].join("\n");
}

async function runTurn(run: Run, msg: QueuedMessage) {
  const target = node(run, msg.nodeId) ?? node(run, "root")!;
  const isRoot = target.id === "root";
  const prompt = isRoot ? msg.text : relayText(target, msg.text);
  const model = msg.model || run.model;
  const effort = msg.effort || run.effort;

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--forward-subagent-text"];
  if (run.permissionMode) args.push("--permission-mode", run.permissionMode);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (run.sessionId) args.push("--resume", run.sessionId);
  else if (run.agent && run.agent !== "main") args.push("--agent", run.agent);

  const root = node(run, "root")!;
  if (isRoot) {
    root.model = model ?? root.model;
    root.effort = effort ?? root.effort;
  }
  root.status = "running";
  target.status = "running";
  target.endedAt = undefined;
  run.status = "running";
  run.error = undefined;
  touch(run);

  const defs = await agentDefs(run.cwd).catch(() => [] as AgentDef[]);
  const ctx: TurnCtx = { run, defs, toolParent: new Map(), turnCost: 0, sawError: false };

  let child: ChildProcess;
  try {
    child = spawnClaude(args, { cwd: run.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    procs.delete(run.id);
    return fail(run, (e as Error).message);
  }
  procs.set(run.id, child);
  child.stdin!.end(prompt); // prompt on stdin, so text that starts with "-" is never read as a flag

  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      handle(ctx, JSON.parse(line));
    } catch {
      /* not JSON: ignore */
    }
  });
  let stderr = "";
  child.stderr!.on("data", (b) => (stderr = (stderr + b).slice(-4000)));

  child.on("error", (e) => {
    procs.delete(run.id);
    fail(run, (e as NodeJS.ErrnoException).code === "ENOENT" ? "The `claude` CLI isn't installed or isn't on PATH." : String(e));
  });
  child.on("close", (code) => {
    procs.delete(run.id);
    run.costUsd += ctx.turnCost;
    if (run.status === "stopped") return touch(run);
    for (const n of run.nodes) {
      if (n.status === "running" || n.status === "queued") {
        n.status = n.id === "root" ? "idle" : "done";
        n.endedAt ??= Date.now();
      }
    }
    if (code !== 0 && !ctx.sawResult) {
      return fail(run, stderr.trim().split("\n").slice(-3).join("\n") || `claude exited with code ${code}`);
    }
    run.status = ctx.sawError ? "error" : "idle";
    root.status = ctx.sawError ? "error" : "idle";
    touch(run);
    const next = run.queue.shift();
    if (next) void runTurn(run, next);
  });
}

function fail(run: Run, message: string) {
  run.status = "error";
  run.error = message;
  const root = node(run, "root");
  if (root) root.status = "error";
  log(run, "root", "error", message);
}

interface TurnCtx {
  run: Run;
  defs: AgentDef[];
  toolParent: Map<string, string>;
  turnCost: number;
  sawError: boolean;
  sawResult?: boolean;
}

function short(s: unknown, n = 140) {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

export function describeTool(name: string, input: Record<string, unknown> = {}) {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  const arg =
    pick("command") ?? pick("to") ?? pick("file_path") ?? pick("path") ?? pick("pattern") ?? pick("url") ?? pick("query") ?? pick("description") ?? "";
  return arg ? `${name}: ${short(arg, 110)}` : name;
}

function ensureNode(ctx: TurnCtx, id: string | null | undefined): AgentNode {
  const { run } = ctx;
  const key = id ?? "root";
  let n = node(run, key);
  if (!n) {
    n = {
      id: key,
      parentId: ctx.toolParent.get(key) ?? "root",
      name: "subagent",
      description: "",
      status: "running",
      startedAt: Date.now(),
      depth: 1,
      toolUses: 0,
    };
    run.nodes.push(n);
  }
  return n;
}

// The CLI's stream-json lines. Only the fields used here are typed.
interface StreamLine {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  message?: { model?: string; content?: unknown };
  tool_use_id?: string;
  task_id?: string;
  subagent_type?: string;
  description?: string;
  prompt?: string;
  spawn_depth?: number;
  status?: string;
  summary?: string;
  last_tool_name?: string;
  usage?: { total_tokens?: number; tool_uses?: number };
  patch?: { status?: string };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}
interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function handle(ctx: TurnCtx, d: StreamLine) {
  const { run } = ctx;
  switch (d.type) {
    case "system":
      return handleSystem(ctx, d);

    case "assistant": {
      const who = ensureNode(ctx, d.parent_tool_use_id);
      if (d.message?.model) who.model = d.message.model;
      if (who.status === "queued") who.status = "running";
      const blocks = Array.isArray(d.message?.content) ? (d.message!.content as Block[]) : [];
      for (const b of blocks) {
        if (b.type === "text" && b.text?.trim()) log(run, who.id, "text", b.text);
        if (b.type !== "tool_use" || !b.id) continue;
        ctx.toolParent.set(b.id, who.id);
        if (SUBAGENT_TOOLS.has(b.name ?? "")) {
          const input = b.input ?? {};
          const type = String(input.subagent_type ?? "general-purpose");
          const def = ctx.defs.find((x) => x.name === type);
          const requested = typeof input.model === "string" ? input.model : undefined;
          const inherit = (v?: string) => (!v || v === "inherit" ? undefined : v);
          run.nodes.push({
            id: b.id,
            parentId: who.id,
            name: type,
            description: String(input.description ?? ""),
            prompt: typeof input.prompt === "string" ? input.prompt : undefined,
            status: "queued",
            startedAt: Date.now(),
            depth: who.depth + 1,
            model: requested ?? inherit(def?.model) ?? who.model,
            effort: inherit(def?.effort) ?? who.effort ?? run.effort,
            toolUses: 0,
          });
          who.toolUses++;
          who.lastAction = `Spawned ${type}`;
          log(run, who.id, "tool", `↳ spawned subagent "${type}": ${short(input.description, 100)}`);
        } else {
          who.toolUses++;
          who.lastAction = describeTool(b.name ?? "tool", b.input);
          log(run, who.id, "tool", who.lastAction);
        }
      }
      touch(run);
      return;
    }

    case "user": {
      const who = ensureNode(ctx, d.parent_tool_use_id);
      const blocks = Array.isArray(d.message?.content) ? (d.message!.content as Block[]) : [];
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const sub = b.tool_use_id ? node(run, b.tool_use_id) : undefined;
        if (sub && sub.id !== "root" && b.is_error) {
          sub.status = "error";
          sub.endedAt = Date.now();
        }
        if (b.is_error) log(run, who.id, "error", short(contentText(b.content), 400));
        else if (!sub) log(run, who.id, "tool-result", short(contentText(b.content), 220));
      }
      return;
    }

    case "result": {
      ctx.sawResult = true;
      if (typeof d.total_cost_usd === "number") ctx.turnCost = Math.max(ctx.turnCost, d.total_cost_usd);
      if (d.is_error) {
        ctx.sawError = true;
        log(run, "root", "error", d.result ?? "The turn ended with an error.");
      } else if (d.result) {
        const root = node(run, "root")!;
        root.summary = short(d.result, 300);
      }
      touch(run);
      return;
    }
  }
}

function handleSystem(ctx: TurnCtx, d: StreamLine) {
  const { run } = ctx;
  if (d.subtype === "init") {
    if (d.session_id && !run.sessionId) run.sessionId = d.session_id;
    const root = node(run, "root")!;
    if (d.model) root.model = d.model;
    touch(run);
    return;
  }
  const sub = d.tool_use_id ? node(run, d.tool_use_id) : undefined;
  const byTask = !sub && d.task_id ? run.nodes.find((n) => n.taskId === d.task_id) : undefined;
  const n = sub ?? byTask;
  if (!n) return;

  switch (d.subtype) {
    case "task_started":
      n.status = "running";
      n.taskId = d.task_id;
      if (d.spawn_depth) n.depth = d.spawn_depth;
      if (d.description) n.description ||= d.description;
      break;
    case "task_progress":
      if (d.usage?.total_tokens) n.tokens = d.usage.total_tokens;
      if (d.usage?.tool_uses != null) n.toolUses = d.usage.tool_uses;
      if (d.last_tool_name) n.lastAction = d.description ? `${d.last_tool_name} · ${short(d.description, 90)}` : d.last_tool_name;
      break;
    case "task_updated":
    case "task_notification": {
      const s = d.patch?.status ?? d.status;
      if (s) {
        n.status = s === "completed" ? "done" : s === "failed" ? "error" : s === "killed" || s === "stopped" ? "stopped" : n.status;
        if (n.status !== "running") n.endedAt ??= Date.now();
      }
      if (d.usage?.total_tokens) n.tokens = d.usage.total_tokens;
      if (d.summary) {
        n.summary = short(d.summary, 400);
        // The report usually repeats the subagent's last message: mark that message as the report instead of showing it twice.
        const lastMine = [...run.log].reverse().find((l) => l.nodeId === n.id);
        if (lastMine && lastMine.kind === "text" && lastMine.text.trim() === d.summary.trim()) lastMine.kind = "result";
        else log(run, n.id, "result", d.summary);
      }
      break;
    }
    default:
      return;
  }
  touch(run);
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : "")).join(" ");
  return "";
}
