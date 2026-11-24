import { useEffect, useMemo, useRef, useState } from "react";
import { call, type TreeEntry } from "../api";
import { useApp } from "../state";
import { IChevron, IFolder, IFile, IPlus, IconButton } from "@archival/ui";
import { KindIcon, CATEGORY_KIND } from "./KindIcon";
import { ingestFiles } from "../ingest";
import { Menu, type MenuItem } from "./Menu";

type Row = { e: TreeEntry; level: number; itemId: string | null };

/** the vault tree: categories at the top, items below, files lazily. a real aria treeview. */
export function Tree({ onNew }: { onNew: (dir: string) => void }) {
  const app = useApp();
  const { route, nav, version, bump, fail } = app;
  const [roots, setRoots] = useState<TreeEntry[] | null>(null);
  const [kids, setKids] = useState<Record<string, TreeEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("archival.tree") || '["projects","inbox"]')); } catch { return new Set(["projects", "inbox"]); }
  });
  const [focus, setFocus] = useState<string>("");
  const [drop, setDrop] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = async (path: string) => {
    try {
      const r = await call<TreeEntry[]>("tree.list", { path });
      setKids((k) => ({ ...k, [path]: r }));
    } catch {
      setKids((k) => { const n = { ...k }; delete n[path]; return n; });
      setOpen((o) => { const n = new Set(o); n.delete(path); return n; });
    }
  };
  useEffect(() => {
    call<TreeEntry[]>("tree.list", { path: "" }).then((r) => { setRoots(r); setErr(null); }).catch(setErr);
    open.forEach((p) => load(p));
  }, [version]);
  useEffect(() => {
    try { localStorage.setItem("archival.tree", JSON.stringify([...open])); } catch {}
  }, [open]);

  // reveal the current path
  useEffect(() => {
    if (!route.path) return;
    const parts = route.path.split("/");
    const want = new Set(open);
    let changed = false;
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!want.has(p)) { want.add(p); changed = true; load(p); }
    }
    if (changed) setOpen(want);
    setFocus(route.path);
  }, [route.path]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (list: TreeEntry[], level: number, itemId: string | null) => {
      for (const e of list) {
        const id = e.item_id ?? itemId;
        out.push({ e, level, itemId: id });
        if (e.is_dir && open.has(e.path) && kids[e.path]) walk(kids[e.path], level + 1, id);
      }
    };
    if (roots) walk(roots, 1, null);
    return out;
  }, [roots, kids, open]);

  const toggle = (p: string, force?: boolean) => {
    const n = new Set(open);
    const want = force ?? !n.has(p);
    if (want) { n.add(p); load(p); } else n.delete(p);
    setOpen(n);
  };

  const activate = (r: Row) => {
    setFocus(r.e.path);
    if (r.level === 1) {
      if (r.e.path === "inbox") nav({ view: "inbox", itemId: undefined, path: undefined });
      toggle(r.e.path);
      return;
    }
    if (r.e.is_dir) {
      if (r.e.item_id) {
        nav({ view: route.view === "run" || route.view === "git" ? route.view : "files", itemId: r.e.item_id, path: r.e.path });
        if (!open.has(r.e.path)) toggle(r.e.path, true);
      } else toggle(r.e.path);
      return;
    }
    nav({ view: "files", itemId: r.itemId ?? undefined, path: r.e.path });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.e.path === focus);
    const r = rows[i];
    const go = (j: number) => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (t) {
        setFocus(t.e.path);
        ref.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(t.e.path)}"]`)?.focus();
      }
    };
    if (e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(rows.length - 1); }
    else if (e.key === "ArrowRight" && r?.e.is_dir) {
      e.preventDefault();
      if (!open.has(r.e.path)) toggle(r.e.path, true); else go(i + 1);
    } else if (e.key === "ArrowLeft" && r) {
      e.preventDefault();
      if (r.e.is_dir && open.has(r.e.path)) toggle(r.e.path, false);
      else {
        const parent = r.e.path.split("/").slice(0, -1).join("/");
        if (parent) go(rows.findIndex((x) => x.e.path === parent));
      }
    } else if ((e.key === "Enter" || e.key === " ") && r) { e.preventDefault(); activate(r); }
  };

  const destFor = (r: Row): string => (r.e.is_dir ? r.e.path : r.e.path.split("/").slice(0, -1).join("/"));

  const onDrop = async (ev: React.DragEvent, r: Row) => {
    ev.preventDefault();
    const dest = destFor(r);
    setDrop(null);
    const internal = ev.dataTransfer.getData("application/x-archival-path");
    if (internal) {
      if (internal === dest || dest.startsWith(internal + "/")) return;
      const name = internal.split("/").pop();
      try {
        await call("file.rename", { from: internal, to: `${dest}/${name}` });
        bump();
      } catch (e) { fail(e); }
      return;
    }
    const files = Array.from(ev.dataTransfer.files);
    if (files.length) ingestFiles(files, dest, app);
  };

  const contextMenu = (ev: React.MouseEvent, r: Row) => {
    ev.preventDefault();
    const items: MenuItem[] = [];
    const dir = destFor(r);
    if (r.level > 1 || r.e.is_dir) items.push({ label: "new file here", run: () => onNew(dir) });
    if (r.level > 1) {
      items.push({
        label: "rename",
        run: async () => {
          const name = prompt("new name", r.e.name);
          if (!name || name === r.e.name) return;
          try {
            await call("file.rename", { from: r.e.path, to: `${r.e.path.split("/").slice(0, -1).join("/")}/${name}` });
            bump();
          } catch (e) { fail(e); }
        },
      });
      items.push({
        label: "move to trash",
        danger: true,
        run: async () => {
          try {
            const t = await call<{ id: string }>("file.trash", { path: r.e.path });
            bump();
            if (route.path?.startsWith(r.e.path)) nav({ view: "shelf", itemId: undefined, path: undefined });
            app.toast(`${r.e.name} moved to trash`, "info", { label: "undo", run: () => call("trash.restore", { id: t.id }).then(bump).catch(fail) });
          } catch (e) { fail(e); }
        },
      });
    }
    if (items.length) setMenu({ x: ev.clientX, y: ev.clientY, items });
  };

  if (err) return <p className="muted tree-err">couldn't read the vault. {String((err as any)?.message ?? err)}</p>;
  if (!roots) return <div className="tree-loading" aria-busy="true">{[70, 55, 62, 48].map((w, i) => <div key={i} className="skeleton" style={{ width: `${w}%`, margin: "10px 14px" }} />)}</div>;

  return (
    <div className="tree" role="tree" aria-label="vault" ref={ref} onKeyDown={onKey}>
      {rows.map((r) => {
        const isOpen = open.has(r.e.path);
        const selected = route.path === r.e.path || (!route.path && route.view === "inbox" && r.e.path === "inbox");
        const tabbable = (focus || rows[0]?.e.path) === r.e.path;
        return (
          <div
            key={r.e.path}
            role="treeitem"
            aria-level={r.level}
            aria-expanded={r.e.is_dir ? isOpen : undefined}
            aria-selected={selected}
            tabIndex={tabbable ? 0 : -1}
            data-path={r.e.path}
            data-drop-path={destFor(r)}
            className={`tree-row l${Math.min(r.level, 8)} ${r.level === 1 ? "cat" : ""} ${drop === destFor(r) && r.e.is_dir ? "drop" : ""} ${selected ? "sel" : ""}`}
            style={{ paddingLeft: 8 + (r.level - 1) * 14 }}
            draggable={r.level > 1}
            onDragStart={(ev) => { ev.dataTransfer.setData("application/x-archival-path", r.e.path); ev.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(ev) => { ev.preventDefault(); if (drop !== destFor(r)) setDrop(destFor(r)); }}
            onDragLeave={(ev) => { if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node)) setDrop((d) => (d === destFor(r) ? null : d)); }}
            onDrop={(ev) => onDrop(ev, r)}
            onClick={() => activate(r)}
            onContextMenu={(ev) => contextMenu(ev, r)}
            onFocus={() => setFocus(r.e.path)}
          >
            <span className={`tw ${isOpen ? "open" : ""}`} aria-hidden="true">{r.e.is_dir ? <IChevron size={12} /> : null}</span>
            <span className="ti" aria-hidden="true">
              {r.level === 1 ? <KindIcon kind={CATEGORY_KIND[r.e.name]} size={15} /> : r.e.item_id ? <KindIcon kind={guessKind(r.e)} size={15} /> : r.e.is_dir ? <IFolder size={15} /> : <IFile size={15} />}
            </span>
            <span className="tn">{r.e.name}</span>
            {r.e.count != null && r.e.count > 0 && <span className={`tc ${r.e.path === "inbox" ? "hot" : ""}`}>{r.e.count}</span>}
            {r.level === 1 && r.e.path !== "inbox" && (
              <IconButton label={`new in ${r.e.name}`} className="tree-add" onClick={(ev) => { ev.stopPropagation(); onNew(r.e.path); }}>
                <IPlus size={13} />
              </IconButton>
            )}
          </div>
        );
      })}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function guessKind(e: TreeEntry): string {
  const cat = e.path.split("/")[0];
  if (cat === "inbox") return e.is_dir ? "dir" : "file";
  return CATEGORY_KIND[cat] ?? "file";
}
