import { useEffect, useRef, useState } from "react";
import { call, type Item } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Empty, ErrorState, Loading, Button, Kbd } from "@archival/ui";
import { KindIcon } from "../components/KindIcon";
import { ago } from "../util";

type Row = { item: Item; suggestion: { kind: string; category: string; tags: string[] } };
const CATS = ["projects", "docs", "designs", "snippets", "assets", "links"];

/** newly ingested things: suggested folder + tags, one key to accept */
export function Inbox() {
  const app = useApp();
  const { fail, toast, bump, nav } = app;
  const { data, error, loading, reload } = useCall<Row[]>("inbox.list");
  const [pick, setPick] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState(0);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const list = useRef<HTMLUListElement>(null);
  const rows = data ?? [];

  const file = async (r: Row) => {
    const cat = pick[r.item.id] ?? r.suggestion.category;
    setLeaving((s) => new Set(s).add(r.item.id));
    try {
      await call("item.file", { id: r.item.id, category: cat });
      setTimeout(() => { reload(); bump(); }, 180);
    } catch (e) {
      fail(e);
      setLeaving((s) => { const n = new Set(s); n.delete(r.item.id); return n; });
    }
  };
  const fileAll = async () => {
    for (const r of rows) await file(r);
    toast(`filed ${rows.length} item${rows.length === 1 ? "" : "s"}`);
  };
  usePrimary(rows.length ? { label: rows.length === 1 ? "file it" : `file all ${rows.length}`, onClick: rows.length === 1 ? () => file(rows[0]) : fileAll } : null, [rows.length, JSON.stringify(pick)]);

  useEffect(() => {
    list.current?.querySelectorAll<HTMLElement>("[data-row]")[focus]?.focus();
  }, [focus, rows.length]);

  if (loading && !data) return <div className="view pad"><Loading /></div>;
  if (error) return <div className="view pad"><ErrorState error={error} onRetry={reload} /></div>;

  return (
    <div className="view pad inbox">
      <h1 className="view-title">inbox</h1>
      {rows.length === 0 ? (
        <Empty title="all filed">anything you import, pull or drop lands here first, with a suggested place.</Empty>
      ) : (
        <>
          <p className="muted lede"><Kbd>enter</Kbd> files the selected item where it's suggested. <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move.</p>
          <ul className="rows triage" ref={list} aria-label="inbox items">
            {rows.map((r, i) => (
              <li key={r.item.id} className={leaving.has(r.item.id) ? "leaving" : ""}>
                <div
                  className="row-btn triage-row"
                  data-row
                  tabIndex={i === focus ? 0 : -1}
                  onFocus={() => setFocus(i)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "ArrowDown") { e.preventDefault(); setFocus(Math.min(rows.length - 1, i + 1)); }
                    if (e.key === "ArrowUp") { e.preventDefault(); setFocus(Math.max(0, i - 1)); }
                    if (e.key === "Enter") { e.preventDefault(); file(r); }
                    if (e.key === " ") { e.preventDefault(); nav({ view: "files", itemId: r.item.id, path: r.item.path }); }
                  }}
                >
                  <KindIcon kind={r.item.kind} />
                  <span className="grow">
                    <button className="link-btn plain" onClick={() => nav({ view: "files", itemId: r.item.id, path: r.item.path })}>{r.item.title}</button>
                    <span className="muted small block">from {r.item.origin_connector} · {ago(r.item.created)}{r.suggestion.tags.length ? ` · ${r.suggestion.tags.join(", ")}` : ""}</span>
                  </span>
                  <label className="sr-only" htmlFor={`cat-${r.item.id}`}>file into</label>
                  <select id={`cat-${r.item.id}`} className="select small" value={pick[r.item.id] ?? r.suggestion.category} onChange={(e) => setPick({ ...pick, [r.item.id]: e.target.value })}>
                    {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <Button size="small" onClick={() => file(r)}>file</Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
