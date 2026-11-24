import type { Kind } from "./api";

export function ago(ms: number): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} b`;
  const u = ["kb", "mb", "gb", "tb"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export const CATEGORY_LABEL: Record<string, string> = {
  projects: "projects", docs: "docs", designs: "designs", snippets: "snippets", assets: "assets", links: "links", inbox: "inbox",
};

export const KIND_CATEGORY: Record<Kind, string> = {
  project: "projects", document: "docs", design: "designs", snippet: "snippets", asset: "assets", link: "links",
};

export function extOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function parentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

export const TEXT_EXT = new Set(["md", "markdown", "txt", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "rb", "php", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "sh", "bash", "zsh", "lua", "sql", "css", "scss", "vue", "svelte", "json", "yaml", "yml", "toml", "xml", "html", "htm", "svg", "csv", "env", "ini", "cfg", "gitignore", "lock", "log", "mdx", "astro", "graphql", "proto", "zig", "dart", "wgsl", "glsl"]);
