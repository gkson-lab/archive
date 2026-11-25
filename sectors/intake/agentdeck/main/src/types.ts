export type RunKind = "local" | "managed" | "claude-cloud";
export type RunStatus =
  | "starting"
  | "running"
  | "waiting" // needs you (a tool approval)
  | "idle" // turn finished, ready for your next message
  | "done"
  | "error"
  | "stopped"
  | "handed-off"; // opened in a terminal / claude.ai

export type NodeStatus = "queued" | "running" | "waiting" | "idle" | "done" | "error" | "stopped";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One agent in a run: the main agent ("root") or a subagent it spawned. Each gets its own chamber in the UI. */
export interface AgentNode {
  id: string; // "root" or the tool_use id of the Agent/Task call that spawned it
  parentId: string | null;
  name: string; // subagent type, e.g. "general-purpose"
  description: string;
  prompt?: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
  taskId?: string; // Claude Code's agent id for the subagent (used to message it)
  depth: number;
  model?: string; // model actually observed on its messages, or requested
  effort?: string; // effort it runs at (own definition, else inherited)
  toolUses: number;
  tokens?: number;
  lastAction?: string;
  summary?: string;
}

export interface LogEntry {
  t: number;
  nodeId: string;
  kind: "user" | "text" | "tool" | "tool-result" | "system" | "error" | "result";
  text: string;
}

export interface PendingConfirmation {
  toolUseId: string;
  name: string;
  input: string;
}

export interface QueuedMessage {
  text: string;
  nodeId: string;
  model?: string;
  effort?: string;
}

export interface Run {
  id: string;
  kind: RunKind;
  title: string;
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  agent?: string;
  permissionMode?: string;
  status: RunStatus;
  sessionId?: string; // Claude Code session id, or Managed Agents session id
  url?: string;
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  nodes: AgentNode[];
  log: LogEntry[];
  pending: PendingConfirmation[];
  queue: QueuedMessage[];
  error?: string;
}

export interface NewRunRequest {
  where: RunKind;
  prompt: string;
  title?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  agent?: string;
  permissionMode?: string;
}

export interface TalkRequest {
  text: string;
  nodeId?: string;
  model?: string;
  effort?: string;
}
