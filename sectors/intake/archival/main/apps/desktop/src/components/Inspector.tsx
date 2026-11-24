import { useState } from "react";
import { call, type Item, type Kind } from "../api";
import { useApp, useCall } from "../state";
import { Button, IconButton, IX, Switch, Loading, ErrorState } from "@archival/ui";
import { ago, bytes } from "../util";
import { reveal } from "../platform";

type Snap = { id: string; created: number; label: string; source: string; file_count: number; bytes: number };
type Changes = { added: string[]; modified: string[]; deleted: string[] };

const KINDS: Kind[] = ["project", "document", "design", "snippet", "asset", "link"];

/** advanced details live here, collapsed by default */
export function Inspector() {
  const app = useApp();
  const { item, setInspector } = app;
  return (
    <aside className="inspector" aria-label="inspector">
      <div className="insp-head">
        <h3>details</h3>
        <IconButton label="close inspector" onClick={() => setInspector(false)}><IX /></IconButton>
      </div>
      {item ? <ItemDetails key={item.id} item={item} /> : <p className="muted insp-empty">select something in the vault to see where it came from, its history and settings.</p>}
    </aside>
  );
}

function ItemDetails({ item }: { item: Item }) {
  const app = useApp();
  const { bump, fail, toast, nav } = app;
  const [tag, setTag] = useState("");
  const snaps = useCall<Snap[]>("snapshot.list", { item_id: item.id }, [item.id]);
  const accounts = useCall<{ account: { login: string } }[]>("github.accounts", {}, []);
  const [changes, setChanges] = useState<{ id: string; c: Changes } | null>(null);

  const patch = async (p: Record<string, unknown>) => {
    try {
      const it = await call<Item>("item.update", { id: item.id, patch: p });
      app.setItem(it);
      bump();
    } catch (e) { fail(e); }
  };

  return (
    <div className="insp-body">
      <section>
        <h4>about</h4>
        <dl className="kv">
          <dt>kind</dt>
          <dd>
            <select className="select" value={item.kind} onChange={(e) => patch({ kind: e.target.value })} aria-label="kind">
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </dd>
          <dt>path</dt><dd className="mono">{item.path}</dd>
          <dt>came from</dt><dd>{item.origin_connector}{item.origin_source ? <span className="muted mono block">{item.origin_source}</span> : null}</dd>
          <dt>added</dt><dd>{ago(item.created)}</dd>
          <dt>changed</dt><dd>{ago(item.updated)}</dd>
          {item.remote && (<><dt>remote</dt><dd className="mono">{item.remote}</dd></>)}
        </dl>
      </section>

      <section>
        <h4>tags</h4>
        <div className="tags">
          {item.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
              <button className="tag-x" aria-label={`remove ${t}`} onClick={() => patch({ tags: item.tags.filter((x) => x !== t) })}>×</button>
            </span>
          ))}
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); const t = tag.trim().toLowerCase(); if (t && !item.tags.includes(t)) patch({ tags: [...item.tags, t] }); setTag(""); }}>
          <input className="input" placeholder="add a tag" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="add a tag" />
        </form>
      </section>

      <section>
        <h4>settings</h4>
        <Switch label="pinned to shelf" checked={item.pinned} onChange={(v) => patch({ pinned: v })} />
        <Switch label="local only (never pushed or synced)" checked={item.local_only} onChange={(v) => patch({ local_only: v })} />
        {!!accounts.data?.length && (
          <label className="field">
            <span>github account</span>
            <select className="select" value={item.account ?? ""} onChange={(e) => patch({ account: e.target.value || null })}>
              <option value="">default</option>
              {accounts.data.map((a) => <option key={a.account.login} value={a.account.login}>{a.account.login}</option>)}
            </select>
          </label>
        )}
        {item.run_command && (
          <dl className="kv"><dt>runs with</dt><dd className="mono">{item.run_command}</dd><dt>mode</dt><dd>{item.run_mode ?? "local"}</dd></dl>
        )}
        <Switch label="approved to run" checked={item.trusted} onChange={(v) => patch({ trusted: v })} />
      </section>

      <section>
        <div className="row between">
          <h4>snapshots</h4>
          <Button size="small" onClick={async () => { try { await call("snapshot.create", { item_id: item.id, label: "manual snapshot" }); toast("snapshot saved"); snaps.reload(); } catch (e) { fail(e); } }}>snapshot now</Button>
        </div>
        {snaps.loading && <Loading lines={2} />}
        {!!snaps.error && <ErrorState error={snaps.error} onRetry={snaps.reload} />}
        {snaps.data && snaps.data.length === 0 && <p className="muted">no snapshots yet.</p>}
        <ol className="snaps">
          {snaps.data?.map((s) => (
            <li key={s.id}>
              <div className="row between">
                <span>{s.label}</span>
                <span className="muted">{ago(s.created)}</span>
              </div>
              <div className="muted small">{s.file_count} files · {bytes(s.bytes)} · {s.source}</div>
              <div className="row gap">
                <button className="link-btn" onClick={async () => { try { setChanges({ id: s.id, c: await call<Changes>("snapshot.changes", { id: s.id }) }); } catch (e) { fail(e); } }}>what changed since</button>
                <button className="link-btn" onClick={async () => {
                  if (!confirm(`restore ${item.title} to “${s.label}”? the current state is saved first.`)) return;
                  try { await call("snapshot.restore", { id: s.id }); toast("restored. the previous state is in snapshots"); bump(); snaps.reload(); } catch (e) { fail(e); }
                }}>restore</button>
              </div>
              {changes?.id === s.id && (
                <div className="changes">
                  {!changes.c.added.length && !changes.c.modified.length && !changes.c.deleted.length && <p className="muted">nothing changed.</p>}
                  {changes.c.modified.map((f) => <div key={f} className="mono">~ {f}</div>)}
                  {changes.c.added.map((f) => <div key={f} className="mono add">+ {f}</div>)}
                  {changes.c.deleted.map((f) => <div key={f} className="mono del">- {f}</div>)}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="insp-actions">
        <Button size="small" onClick={async () => { try { const r = await call<{ path: string }>("item.export", { id: item.id }); toast(`exported to ${r.path}`); } catch (e) { fail(e); } }}>export zip</Button>
        <Button size="small" onClick={async () => { try { const r = await call<{ path: string }>("file.abs", { path: item.path }); await reveal(r.path); } catch (e) { fail(e); } }}>show in folder</Button>
        <Button size="small" variant="danger" onClick={async () => {
          try {
            const t = await call<{ id: string }>("item.trash", { id: item.id });
            nav({ view: "shelf", itemId: undefined, path: undefined });
            bump();
            toast(`${item.title} moved to trash`, "info", { label: "undo", run: () => call("trash.restore", { id: t.id }).then(bump).catch(fail) });
          } catch (e) { fail(e); }
        }}>move to trash</Button>
      </section>
    </div>
  );
}
