import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentNode, LogEntry, Run } from "./types.js";

export const DATA_DIR = process.env.AGENTDECK_HOME ?? join(homedir(), ".agentdeck");
const RUNS_FILE = join(DATA_DIR, "runs.json");
const MAX_LOG = 1500;

mkdirSync(DATA_DIR, { recursive: true });

/** Broadcasts "run" (a full run) and "auth-log" events to every open browser tab. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

const runs = new Map<string, Run>();

function load() {
  if (!existsSync(RUNS_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(RUNS_FILE, "utf8")) as Run[];
    for (const r of saved) {
      r.queue ??= [];
      r.pending ??= [];
      // A process from an earlier launch of the app is gone; keep the session so you can keep talking to it.
      if (["starting", "running", "waiting"].includes(r.status)) {
        r.status = r.sessionId ? "idle" : "stopped";
        for (const n of r.nodes) if (n.status === "running" || n.status === "queued") n.status = "stopped";
      }
      runs.set(r.id, r);
    }
  } catch (e) {
    console.warn("[agentdeck] could not read saved runs:", e);
  }
}
load();

let saveTimer: NodeJS.Timeout | undefined;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(RUNS_FILE, JSON.stringify([...runs.values()]), { mode: 0o600 });
    } catch (e) {
      console.warn("[agentdeck] could not save runs:", e);
    }
  }, 400);
}

const emitTimers = new Map<string, NodeJS.Timeout>();
/** Mark a run changed: persist and push to the UI (throttled per run). */
export function touch(run: Run) {
  run.updatedAt = Date.now();
  scheduleSave();
  if (emitTimers.has(run.id)) return;
  emitTimers.set(
    run.id,
    setTimeout(() => {
      emitTimers.delete(run.id);
      bus.emit("run", run);
    }, 80),
  );
}

export function listRuns(): Run[] {
  return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);
}
export function getRun(id: string) {
  return runs.get(id);
}
export function addRun(run: Run) {
  runs.set(run.id, run);
  touch(run);
}
export function removeRun(id: string) {
  runs.delete(id);
  scheduleSave();
  bus.emit("run-removed", id);
}

export function newRun(partial: Pick<Run, "kind" | "title" | "prompt"> & Partial<Run>): Run {
  const now = Date.now();
  return {
    id: randomUUID().slice(0, 8),
    status: "starting",
    createdAt: now,
    updatedAt: now,
    costUsd: 0,
    nodes: [rootNode(partial.agent ?? "main", partial.title ?? "Main agent", partial.model, partial.effort)],
    log: [],
    pending: [],
    queue: [],
    ...partial,
  };
}

export function rootNode(name: string, description: string, model?: string, effort?: string): AgentNode {
  return {
    id: "root",
    parentId: null,
    name,
    description,
    status: "queued",
    startedAt: Date.now(),
    depth: 0,
    model,
    effort,
    toolUses: 0,
  };
}

export function node(run: Run, id: string): AgentNode | undefined {
  return run.nodes.find((n) => n.id === id);
}

export function log(run: Run, nodeId: string, kind: LogEntry["kind"], text: string) {
  if (!text) return;
  run.log.push({ t: Date.now(), nodeId, kind, text: text.length > 6000 ? text.slice(0, 6000) + " …" : text });
  if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
  touch(run);
}
