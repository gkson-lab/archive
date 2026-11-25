import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addRun, bus, getRun, listRuns, newRun, node, removeRun, touch } from "./store.js";
import { claudeAuthStatus, logout, machineAgents, openCloudInTerminal, sendLoginCode, startLogin } from "./claude.js";
import { stopLocal, talkLocal, validateCwd } from "./local.js";
import { confirmManaged, consoleStatus, startManaged, stopManaged, talkManaged } from "./managed.js";
import { agentDefs } from "./roster.js";
import type { NewRunRequest, Run, TalkRequest } from "./types.js";

const HOST = "127.0.0.1"; // local only: this server can start agents on your computer
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};
const MODELS = /^[a-z0-9][a-z0-9.\-[\]]{0,63}$/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);

const allowedHosts = new Set<string>();

/** Blocks other websites (and DNS-rebinding tricks) from driving this local server. */
function trusted(req: IncomingMessage) {
  if (!allowedHosts.has(req.headers.host ?? "")) return false;
  if (req.method === "GET") return true;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body<T>(req: IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Request too large");
  }
  return (raw ? JSON.parse(raw) : {}) as T;
}

function clean(v: unknown, max = 200) {
  return typeof v === "string" ? v.trim().slice(0, max) : undefined;
}

/** First sentence of the task, cut at a word boundary. */
function shortTitle(prompt: string) {
  const first = prompt.split(/\n|(?<=[.!?:])\s/)[0].trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60) + "…";
}

async function createRun(r: NewRunRequest): Promise<Run> {
  const prompt = clean(r.prompt, 50_000);
  if (!prompt) throw new Error("Give the agent a task.");
  const model = clean(r.model, 64);
  if (model && !MODELS.test(model)) throw new Error("That model name doesn't look right.");
  const effort = clean(r.effort, 10);
  if (effort && !EFFORTS.has(effort)) throw new Error("Unknown effort level.");
  const title = clean(r.title, 120) || shortTitle(prompt);

  if (r.where === "local") {
    const cwd = validateCwd(r.cwd);
    const permissionMode = clean(r.permissionMode, 32) || "acceptEdits";
    if (!PERMISSION_MODES.has(permissionMode)) throw new Error("Unknown permission mode.");
    const agent = clean(r.agent, 64);
    if (agent && !/^[\w.-]+$/.test(agent)) throw new Error("That agent name doesn't look right.");
    const run = newRun({ kind: "local", title, prompt, cwd, model, effort, agent: agent || undefined, permissionMode });
    addRun(run);
    talkLocal(run, { text: prompt, nodeId: "root", model, effort });
    return run;
  }

  if (r.where === "managed") {
    const run = newRun({ kind: "managed", title, prompt, model: model || "claude-opus-5-5", effort });
    addRun(run);
    run.log.push({ t: Date.now(), nodeId: "root", kind: "user", text: prompt });
    void startManaged(run);
    return run;
  }

  if (r.where === "claude-cloud") {
    const cwd = validateCwd(r.cwd);
    const out = openCloudInTerminal(prompt, cwd);
    const run = newRun({ kind: "claude-cloud", title, prompt, cwd, url: "https://claude.ai/code" });
    run.status = "handed-off";
    run.nodes[0].status = "done";
    run.log.push({ t: Date.now(), nodeId: "root", kind: "user", text: prompt });
    run.log.push({
      t: Date.now(),
      nodeId: "root",
      kind: "system",
      text: (out.opened ? "Opened a terminal running:\n" : (out.message ?? "") + "\n") + out.command +
        "\n\nThe session runs on claude.ai/code under your Claude account.",
    });
    addRun(run);
    return run;
  }
  throw new Error("Pick where the agent runs.");
}

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  const m = req.method ?? "GET";
  const seg = path.split("/").filter(Boolean); // ["api", ...]

  if (path === "/api/auth" && m === "GET") {
    const [claude, consoleApi] = await Promise.all([claudeAuthStatus(), consoleStatus(new URL(req.url!, "http://x").searchParams.has("fresh"))]);
    return send(res, 200, { claude, console: consoleApi });
  }
  if (path === "/api/auth/login" && m === "POST") {
    const b = await body<{ method?: string }>(req);
    return send(res, 200, startLogin(b.method === "console" ? "console" : "claudeai"));
  }
  if (path === "/api/auth/code" && m === "POST") {
    const b = await body<{ code?: string }>(req);
    return send(res, 200, { ok: sendLoginCode(clean(b.code, 2000) ?? "") });
  }
  if (path === "/api/auth/logout" && m === "POST") {
    await logout();
    return send(res, 200, { ok: true });
  }
  if (path === "/api/roster" && m === "GET") {
    const cwd = new URL(req.url!, "http://x").searchParams.get("cwd") ?? undefined;
    let dir: string | undefined;
    try {
      dir = cwd ? validateCwd(cwd) : undefined;
    } catch {
      dir = undefined;
    }
    return send(res, 200, await agentDefs(dir));
  }
  if (path === "/api/machine" && m === "GET") return send(res, 200, await machineAgents());

  if (path === "/api/runs" && m === "GET") return send(res, 200, listRuns());
  if (path === "/api/runs" && m === "POST") return send(res, 200, await createRun(await body<NewRunRequest>(req)));

  if (seg[1] === "runs" && seg[2]) {
    const run = getRun(seg[2]);
    if (!run) return send(res, 404, { error: "No such run." });
    const action = seg[3];
    if (!action && m === "GET") return send(res, 200, run);
    if (!action && m === "DELETE") {
      if (run.kind === "local") stopLocal(run);
      removeRun(run.id);
      return send(res, 200, { ok: true });
    }
    if (action === "talk" && m === "POST") {
      const b = await body<TalkRequest>(req);
      const text = clean(b.text, 50_000);
      if (!text) throw new Error("Say something first.");
      const nodeId = clean(b.nodeId, 100) || "root";
      if (!node(run, nodeId)) throw new Error("That agent isn't in this run.");
      const model = clean(b.model, 64);
      if (model && !MODELS.test(model)) throw new Error("That model name doesn't look right.");
      const effort = clean(b.effort, 10);
      if (effort && !EFFORTS.has(effort)) throw new Error("Unknown effort level.");
      if (run.kind === "local") talkLocal(run, { text, nodeId, model, effort });
      else if (run.kind === "managed") void talkManaged(run, { text, nodeId });
      else throw new Error("This session lives on claude.ai; talk to it there.");
      return send(res, 200, { ok: true });
    }
    if (action === "stop" && m === "POST") {
      if (run.kind === "local") stopLocal(run);
      else if (run.kind === "managed") await stopManaged(run);
      return send(res, 200, { ok: true });
    }
    if (action === "confirm" && m === "POST") {
      const b = await body<{ toolUseId?: string; allow?: boolean }>(req);
      if (run.kind !== "managed" || !b.toolUseId) throw new Error("Nothing to confirm.");
      await confirmManaged(run, b.toolUseId, Boolean(b.allow));
      return send(res, 200, { ok: true });
    }
    if (action === "done" && m === "POST") {
      run.status = "done";
      node(run, "root")!.status = "done";
      touch(run);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: "Not found" });
}

function sse(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const push = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onRun = (r: Run) => push("run", r);
  const onRemoved = (id: string) => push("run-removed", id);
  const onAuthLog = (t: string) => push("auth-log", t);
  const onAuthDone = (code: number) => push("auth-done", code);
  bus.on("run", onRun);
  bus.on("run-removed", onRemoved);
  bus.on("auth-log", onAuthLog);
  bus.on("auth-done", onAuthDone);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("run", onRun);
    bus.off("run-removed", onRemoved);
    bus.off("auth-log", onAuthLog);
    bus.off("auth-done", onAuthDone);
  });
}

async function serveStatic(res: ServerResponse, path: string) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  if (!trusted(req)) return send(res, 403, { error: "Forbidden" });
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (path === "/api/stream") return sse(req, res);
    if (path.startsWith("/api/")) return await api(req, res, path);
    return await serveStatic(res, path);
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

/** Start the server on 127.0.0.1. Uses `port` if it's free, otherwise any free port. Returns the port. */
export async function start(port = Number(process.env.PORT ?? 4477)): Promise<number> {
  let actual: number;
  try {
    actual = await listen(port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    actual = await listen(0);
  }
  allowedHosts.add(`127.0.0.1:${actual}`);
  allowedHosts.add(`localhost:${actual}`);
  return actual;
}
