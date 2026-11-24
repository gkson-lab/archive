// one transport for every view: tauri's ipc inside the app, the local bridge in a browser.

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function bridgeToken(): string {
  try {
    const m = location.hash.match(/token=([a-z0-9]+)/i);
    if (m) {
      sessionStorage.setItem("archival.token", m[1]);
      history.replaceState(null, "", location.pathname + location.search);
      return m[1];
    }
    return sessionStorage.getItem("archival.token") ?? "";
  } catch {
    return "";
  }
}
const token = bridgeToken();

export class ApiError extends Error {}

export async function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return (await invoke("api", { method, params })) as T;
    } catch (e) {
      throw new ApiError(typeof e === "string" ? e : (e as Error)?.message ?? String(e));
    }
  }
  let r: Response;
  try {
    r = await fetch("/api", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-archival-token": token } : {}) },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new ApiError("can't reach archival. is `archival serve` running?");
  }
  if (r.status === 401) throw new ApiError("the bridge token is missing or wrong. open the link `archival serve` printed");
  const body = await r.json().catch(() => ({ error: `bridge error ${r.status}` }));
  if ("error" in body) throw new ApiError(body.error);
  return body.ok as T;
}

export const inApp = isTauri;

// shared shapes

export type Kind = "project" | "document" | "design" | "snippet" | "asset" | "link";

export type Item = {
  id: string;
  kind: Kind;
  title: string;
  path: string;
  is_dir: boolean;
  origin_connector: string;
  origin_source: string;
  tags: string[];
  created: number;
  updated: number;
  remote: string | null;
  account: string | null;
  trusted: boolean;
  run_command: string | null;
  run_setup: string | null;
  run_mode: string | null;
  local_only: boolean;
  pinned: boolean;
  opened: number;
};

export type TreeEntry = { name: string; path: string; is_dir: boolean; size: number; ext: string; modified: number; count: number | null; item_id: string | null };

export type Job = { id: string; kind: string; label: string; done: number; total: number; status: "running" | "done" | "error"; error: string | null; result: any; steps: string[]; started: number };

export type FileStatus = { path: string; staged: string; unstaged: string; untracked: boolean; conflicted: boolean };
export type RepoStatus = { is_repo: boolean; branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; files: FileStatus[]; merging: boolean; remotes: { name: string; url: string }[] };

export type RunInfo = { id: string; item_id: string; label: string; command: string; interactive: boolean; started: number; ended: number | null; status: "starting" | "ready" | "exited" | "failed" | "stopped"; exit_code: number | null; ports: number[] };

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
