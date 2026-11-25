import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  effort?: string;
  tools?: string;
  color?: string;
  source: "built-in" | "user" | "project";
  path?: string;
}

const BUILT_IN: AgentDef[] = [
  { name: "general-purpose", description: "Researches, searches code and runs multi-step tasks.", source: "built-in", tools: "*" },
  { name: "Explore", description: "Fast read-only search across a codebase.", source: "built-in", tools: "read-only" },
  { name: "Plan", description: "Designs an implementation plan before any edits.", source: "built-in", tools: "read-only" },
];

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

async function readDir(dir: string, source: AgentDef["source"]): Promise<AgentDef[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const defs: AgentDef[] = [];
  for (const f of files) {
    try {
      const path = join(dir, f);
      const fm = frontmatter(await readFile(path, "utf8"));
      defs.push({
        name: fm.name || f.replace(/\.md$/, ""),
        description: fm.description || "",
        model: fm.model,
        effort: fm.effort,
        tools: fm.tools,
        color: fm.color,
        source,
        path,
      });
    } catch {
      /* unreadable file: skip */
    }
  }
  return defs;
}

/** Subagents Claude Code can use from `cwd`: project ones win over user ones, which win over built-ins. */
export async function agentDefs(cwd?: string): Promise<AgentDef[]> {
  const user = await readDir(join(homedir(), ".claude", "agents"), "user");
  const project = cwd ? await readDir(join(cwd, ".claude", "agents"), "project") : [];
  const byName = new Map<string, AgentDef>();
  for (const d of [...BUILT_IN, ...user, ...project]) byName.set(d.name, d);
  return [...byName.values()];
}
