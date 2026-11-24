import { useEffect, useMemo, useRef, useState } from "react";
import { call } from "../api";
import { useApp, type View } from "../state";
import { ISearch, Kbd } from "@archival/ui";
import { KindIcon } from "./KindIcon";
import { pickPaths } from "../platform";
import { ingestPaths, ingestUrl } from "../ingest";

type Hit = { item_id: string; title: string; kind: string; path: string; snippet: string };
type Cmd = { id: string; label: string; hint?: string; run: () => void };

function Snip({ s }: { s: string }) {
  const parts = s.split(/(\u0002[^\u0003]*\u0003)/g);
  return (
    <span className="snip">
      {parts.map((p, i) => (p.startsWith("\u0002") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

/** every action is searchable here, plus names and contents across the vault */
export function Palette({ onNewFile, onPaste, onUrl, onPath }: { onNewFile: () => void; onPaste: () => void; onUrl: () => void; onPath: () => void }) {
  const app = useApp();
  const { setPalette, nav, setTheme, theme, item } = app;
  const [q, setQ] = useState("");
  const [contents, setContents] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const close = () => setPalette(false);

  const go = (view: View) => () => { nav({ view }); close(); };
  const cmds: Cmd[] = useMemo(() => {
    const list: Cmd[] = [
      { id: "add-folder", label: "add a folder or files", hint: "import", run: async () => { close(); const p = await pickPaths({ directory: true, multiple: true }); if (p) ingestPaths(p, null, app); else onPath(); } },
      { id: "new-file", label: "new file", hint: "create", run: () => { close(); onNewFile(); } },
      { id: "paste", label: "save pasted text as a snippet", hint: "create", run: () => { close(); onPaste(); } },
      { id: "url", label: "save a url", hint: "import", run: () => { close(); onUrl(); } },
      { id: "shelf", label: "go to shelf", hint: "view", run: go("shelf") },
      { id: "files", label: "go to files", hint: "view", run: go("files") },
      { id: "inbox", label: "triage inbox", hint: "view", run: go("inbox") },
      { id: "run", label: "run", hint: "view", run: go("run") },
      { id: "git", label: "git: changes and history", hint: "view", run: go("git") },
      { id: "connectors", label: "connectors", hint: "view", run: go("connectors") },
      { id: "trash", label: "open trash", hint: "view", run: go("trash") },
      { id: "settings", label: "settings", hint: "view", run: go("settings") },
      { id: "theme", label: theme === "light" ? "switch to chrome theme" : "switch to print theme", hint: "appearance", run: () => { setTheme(theme === "light" ? "dark" : "light"); close(); } },
    ];
    if (item) {
      list.splice(4, 0, { id: "snap", label: `snapshot ${item.title}`, hint: "history", run: async () => { close(); try { await call("snapshot.create", { item_id: item.id, label: "manual snapshot" }); app.toast("snapshot saved"); app.bump(); } catch (e) { app.fail(e); } } });
    }
    return list;
  }, [theme, item?.id]);

  const shownCmds = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return cmds;
    return cmds.filter((c) => c.label.includes(t) || c.hint?.includes(t));
  }, [q, cmds]);

  useEffect(() => {
    const t = q.trim();
    if (!t) { setHits([]); return; }
    if (/^https?:\/\//.test(t)) { setHits([]); return; }
    setSearching(true);
    const h = setTimeout(() => {
      call<Hit[]>("search", { q: t, contents }).then((r) => setHits(r.slice(0, 30))).catch(() => setHits([])).finally(() => setSearching(false));
    }, 120);
    return () => clearTimeout(h);
  }, [q, contents]);

  const isUrl = /^https?:\/\/\S+$/.test(q.trim());
  const rows: { key: string; node: React.ReactNode; run: () => void }[] = [
    ...(isUrl ? [{ key: "save-url", node: <span>save <b>{q.trim()}</b> to the vault</span>, run: () => { ingestUrl(q.trim(), app); close(); } }] : []),
    ...hits.map((h) => ({
      key: `${h.item_id}:${h.path}`,
      node: (
        <span className="pal-hit">
          <KindIcon kind={h.kind} />
          <span className="pal-main">
            <span>{h.path === "" ? h.title : h.path.split("/").pop()}</span>
            <span className="muted mono pal-path">{h.path}</span>
            {h.snippet && <Snip s={h.snippet} />}
          </span>
        </span>
      ),
      run: () => {
        nav({ view: "files", itemId: h.item_id, path: h.path || undefined });
        close();
      },
    })),
    ...(q.trim() && !contents && !isUrl ? [{ key: "contents", node: <span className="muted">search inside files for “{q.trim()}”</span>, run: () => setContents(true) }] : []),
    ...shownCmds.map((c) => ({ key: c.id, node: <span className="pal-cmd"><span>{c.label}</span>{c.hint && <span className="muted">{c.hint}</span>}</span>, run: c.run })),
  ];

  useEffect(() => setSel(0), [q, contents, hits.length]);
  useEffect(() => input.current?.focus(), []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); rows[sel]?.run(); }
    else if (e.key === "Tab") { e.preventDefault(); setContents((c) => !c); }
  };

  useEffect(() => {
    document.getElementById(`pal-${sel}`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <div className="scrim pal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette glass" role="dialog" aria-modal="true" aria-label="search and commands">
        <div className="pal-input">
          <ISearch />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={rows.length ? `pal-${sel}` : undefined}
            placeholder={contents ? "search inside files" : "search names, run a command, or paste a url"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <button className={`btn small ${contents ? "" : "ghost"}`} aria-pressed={contents} onClick={() => setContents(!contents)}>contents <Kbd>tab</Kbd></button>
        </div>
        <ul id="pal-list" role="listbox" className="pal-list" aria-busy={searching}>
          {rows.length === 0 && <li className="pal-empty muted">{searching ? "searching" : `nothing matches “${q}”.${contents ? "" : " press tab to search inside files."}`}</li>}
          {rows.map((r, i) => (
            <li key={r.key} id={`pal-${i}`} role="option" aria-selected={i === sel} className="pal-row" onMouseMove={() => setSel(i)} onClick={r.run}>
              {r.node}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
