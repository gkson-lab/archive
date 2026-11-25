/**
 * Cloud agents on Anthropic's Managed Agents (beta): Anthropic runs the agent loop and a sandbox
 * container per session. Subagents are session threads, so each one gets its own chamber.
 *
 * Credentials: the SDK resolves ANTHROPIC_API_KEY, or a Console sign-in made with `ant auth login`.
 * Billing is your Console organization's (tokens plus session runtime); sessions are kept until you delete them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, log, node, touch } from "./store.js";
import { describeTool } from "./local.js";
import type { AgentNode, QueuedMessage, Run } from "./types.js";

const CONFIG_FILE = join(DATA_DIR, "managed.json");
const DEFAULT_MODEL = "claude-opus-5-5";
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

interface ManagedConfig {
  environmentId?: string;
  agents: Record<string, { id: string; version: number }>; // keyed by "model|effort"
}

let client: Anthropic | undefined;
function api() {
  client ??= new Anthropic();
  return client;
}

function readConfig(): ManagedConfig {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as ManagedConfig;
  } catch {
    /* start fresh */
  }
  return { agents: {} };
}
function writeConfig(c: ManagedConfig) {
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

let statusCache: { at: number; value: { ok: boolean; error?: string } } | undefined;
/** Whether an Anthropic API credential is available (free call: lists one model). */
export async function consoleStatus(force = false) {
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  let value: { ok: boolean; error?: string };
  try {
    client = new Anthropic();
    await client.models.list({ limit: 1 });
    value = { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    value = { ok: false, error: /resolve authentication|apiKey|authToken/i.test(msg) ? "No Anthropic API credential found." : msg };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** Agents and environments are persistent: create once, then reuse by id. */
async function ensureAgent(model: string, effort?: string) {
  const cfg = readConfig();
  if (!cfg.environmentId) {
    const env = await api().beta.environments.create({
      name: "agentdeck",
      config: { type: "cloud", networking: { type: "limited", allow_package_managers: true, allow_mcp_servers: true } },
    });
    cfg.environmentId = env.id;
    writeConfig(cfg);
  }
  const key = `${model}|${effort ?? "default"}`;
  if (!cfg.agents[key]) {
    const agent = await api().beta.agents.create({
      name: `agentdeck worker (${model}${effort ? `, ${effort}` : ""})`,
      description: "General-purpose worker. A copy can be spawned to own one self-contained sub-task.",
      model: effort && EFFORTS.has(effort) ? { id: model, effort: effort as EffortLevel } : model,
      system:
        "You are a capable general-purpose agent working in a sandbox. When a task splits into independent, " +
        "self-contained pieces, delegate each piece to a copy of yourself and combine their reports; do small tasks yourself. " +
        "When the user sends a message meant for one of your subagents, forward it to that subagent and report its reply.",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: true, permission_policy: { type: "auto" } },
          // The web tools are off; turn them on here if your tasks need the web.
          configs: [
            { name: "web_fetch", enabled: false },
            { name: "web_search", enabled: false },
          ],
        },
      ],
      multiagent: {
        type: "multiagent_20261001",
        subagents: { type: "enabled", predefined_agents: [{ type: "self" }] },
        workflows: { type: "disabled" },
      },
    });
    cfg.agents[key] = { id: agent.id, version: agent.version };
    writeConfig(cfg);
  }
  return { environmentId: cfg.environmentId, agent: cfg.agents[key] };
}

const streaming = new Set<string>();

export async function startManaged(run: Run) {
  try {
    const model = run.model || DEFAULT_MODEL;
    const { environmentId, agent } = await ensureAgent(model, run.effort);
    const session = await api().beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environmentId,
      title: run.title.slice(0, 200),
    });
    run.sessionId = session.id;
    run.url = `https://platform.claude.com/workspaces/default/sessions/${session.id}`;
    const root = node(run, "root")!;
    root.model = model;
    root.effort = run.effort ?? "model default";
    touch(run);
    await sendAndStream(run, run.prompt);
  } catch (e) {
    failRun(run, e);
  }
}

function relay(target: AgentNode, text: string) {
  return `[Message from the user for your subagent "${target.name}" (thread ${target.id})]\n\n${text}\n\nForward this to that subagent, wait for its answer, and report it back word for word.`;
}

export async function talkManaged(run: Run, msg: QueuedMessage) {
  if (!run.sessionId) return;
  log(run, msg.nodeId, "user", msg.text);
  const target = node(run, msg.nodeId);
  const text = !target || target.id === "root" ? msg.text : relay(target, msg.text);
  try {
    await sendAndStream(run, text);
  } catch (e) {
    failRun(run, e);
  }
}

export async function confirmManaged(run: Run, toolUseId: string, allow: boolean) {
  if (!run.sessionId) return;
  run.pending = run.pending.filter((p) => p.toolUseId !== toolUseId);
  await api().beta.sessions.events.send(run.sessionId, {
    events: [{ type: "user.tool_confirmation", tool_use_id: toolUseId, result: allow ? "allow" : "deny" }],
  });
  if (!run.pending.length) run.status = "running";
  touch(run);
  if (!streaming.has(run.id)) void consume(run);
}

export async function stopManaged(run: Run) {
  if (run.sessionId) {
    await api().beta.sessions.events.send(run.sessionId, { events: [{ type: "user.interrupt" }] }).catch(() => {});
  }
  run.status = "stopped";
  for (const n of run.nodes) if (n.status === "running") n.status = "stopped";
  touch(run);
}

async function sendAndStream(run: Run, text: string) {
  const root = node(run, "root")!;
  root.status = "running";
  run.status = "running";
  touch(run);
  // Stream first, then send, so no early event is missed.
  const done = consume(run);
  await api().beta.sessions.events.send(run.sessionId!, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  await done;
}

function threadNode(run: Run, threadId: string, agentName?: string): AgentNode {
  let n = node(run, threadId);
  if (!n) {
    n = {
      id: threadId,
      parentId: "root",
      name: agentName ?? "subagent",
      description: "",
      status: "running",
      startedAt: Date.now(),
      depth: 1,
      toolUses: 0,
    };
    run.nodes.push(n);
    void fillThreadModel(run, n);
  }
  return n;
}

/** Look up which model and effort a subagent thread actually runs on. */
async function fillThreadModel(run: Run, n: AgentNode) {
  try {
    const t = await api().beta.sessions.threads.retrieve(n.id, { session_id: run.sessionId! });
    const a = t.agent as unknown as { model?: unknown; type?: string };
    const m = a?.model as { id?: string; effort?: { type?: string } } | string | undefined;
    if (typeof m === "string") n.model = m;
    else if (m) {
      n.model = m.id;
      n.effort = m.effort?.type;
    }
    if (a?.type === "advisor") n.name = "advisor";
    touch(run);
  } catch {
    /* best effort */
  }
}

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text: string }).text : ""))
        .join("")
    : "";

async function consume(run: Run) {
  if (!run.sessionId || streaming.has(run.id)) return;
  streaming.add(run.id);
  try {
    const stream = await api().beta.sessions.events.stream(run.sessionId);
    const root = node(run, "root")!;
    for await (const ev of stream) {
      const e = ev as unknown as Record<string, unknown> & { type: string };
      const thread = typeof e.session_thread_id === "string" ? e.session_thread_id : undefined;
      const who = thread ? threadNode(run, thread, e.agent_name as string | undefined) : root;
      switch (e.type) {
        case "agent.message":
          log(run, who.id, "text", textOf(e.content));
          break;
        case "agent.tool_use":
        case "agent.mcp_tool_use": {
          const name = String(e.name ?? "tool");
          who.toolUses++;
          who.lastAction = describeTool(name, (e.input ?? {}) as Record<string, unknown>);
          log(run, who.id, "tool", who.lastAction);
          if (e.evaluated_permission === "ask") {
            run.pending.push({ toolUseId: String(e.id), name, input: JSON.stringify(e.input ?? {}).slice(0, 600) });
            run.status = "waiting";
            who.status = "waiting";
          }
          touch(run);
          break;
        }
        case "session.thread_created":
          threadNode(run, String(e.session_thread_id), e.agent_name as string | undefined);
          touch(run);
          break;
        case "session.thread_status_running":
          who.status = "running";
          touch(run);
          break;
        case "session.thread_status_idle":
          who.status = "idle";
          who.endedAt = Date.now();
          touch(run);
          break;
        case "session.thread_status_terminated":
          who.status = "done";
          who.endedAt ??= Date.now();
          touch(run);
          break;
        case "agent.thread_message_sent": {
          const to = threadNode(run, String(e.to_session_thread_id), e.to_agent_name as string | undefined);
          const t = textOf(e.content);
          if (!to.description) to.description = t.slice(0, 160);
          to.prompt ??= t;
          log(run, to.id, "user", `From ${who.name === "main" ? "the coordinator" : who.name}: ${t}`);
          break;
        }
        case "agent.thread_message_received": {
          const from = threadNode(run, String(e.from_session_thread_id), e.from_agent_name as string | undefined);
          const t = textOf(e.content);
          from.summary = t.slice(0, 400);
          log(run, from.id, "result", t || "(redacted)");
          break;
        }
        case "session.error":
          log(run, who.id, "error", JSON.stringify(e.error ?? e).slice(0, 600));
          break;
        case "session.status_idle": {
          const stop = (e.stop_reason ?? {}) as { type?: string };
          if (stop.type === "requires_action") {
            run.status = "waiting";
            touch(run);
            break;
          }
          root.status = "idle";
          run.status = "idle";
          touch(run);
          return;
        }
        case "session.status_terminated":
          root.status = "done";
          run.status = "done";
          touch(run);
          return;
      }
    }
  } catch (e) {
    failRun(run, e);
  } finally {
    streaming.delete(run.id);
    await refreshUsage(run);
  }
}

async function refreshUsage(run: Run) {
  try {
    const s = (await api().beta.sessions.retrieve(run.sessionId!)) as unknown as { usage?: { list_cost?: { amount?: string } } };
    const cents = Number(s.usage?.list_cost?.amount);
    if (Number.isFinite(cents)) {
      run.costUsd = cents / 100;
      touch(run);
    }
  } catch {
    /* best effort */
  }
}

function failRun(run: Run, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  run.status = "error";
  run.error = msg;
  const root = node(run, "root");
  if (root) root.status = "error";
  log(run, "root", "error", msg);
}
