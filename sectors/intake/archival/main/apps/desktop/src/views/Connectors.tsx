import { useState } from "react";
import { call } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Button, Dialog, Empty, ErrorState, Field, Loading, IconButton, IRefresh, ITrash, IChevron, IFolder, IFile, IBox, ILink, IDoc, IImage, IGit, ICloud, IPlug } from "@archival/ui";
import { ago, bytes } from "../util";
import { pickPaths } from "../platform";

type FieldDef = { key: string; label: string; placeholder: string; secret: boolean; required: boolean; input: string };
type KindInfo = { kind: string; name: string; about: string; fields: FieldDef[]; can_push: boolean; can_watch: boolean };
type Row = { id: string; kind: string; name: string; config: Record<string, string>; state: any; last_sync: number | null; last_error: string | null; created: number };
type Entry = { id: string; name: string; kind: string; size: number | null; updated: string | null; description: string | null; browsable: boolean };
type Page = { entries: Entry[]; next: string | null };

const ICON: Record<string, any> = { "local-folder": IFolder, git: IGit, github: IGit, "agent-workspace": IBox, gdrive: ICloud, dropbox: ICloud, s3: ICloud, figma: IImage, notion: IDoc };

export function Connectors() {
  const app = useApp();
  const { fail, toast } = app;
  const kinds = useCall<KindInfo[]>("connectors.kinds");
  const list = useCall<Row[]>("connectors.list");
  const [adding, setAdding] = useState(false);
  const [browse, setBrowse] = useState<Row | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  usePrimary({ label: "add connector", onClick: () => setAdding(true) }, []);

  const sync = async (r: Row) => {
    setSyncing(r.id);
    try {
      const res = await call<any>("connectors.sync", { id: r.id });
      if (res?.added) toast(res.added.length ? `${res.added.length} new in the inbox` : "nothing new");
      else if (res?.changed != null) toast(res.changed ? `${res.changed} files updated` : "already up to date");
      else toast(`${r.name} is connected`);
      app.bump();
    } catch (e) { fail(e); } finally { setSyncing(null); list.reload(); }
  };

  return (
    <div className="view pad connectors">
      <h1 className="view-title">connectors</h1>
      <p className="muted lede">sources archival pulls from. anything pulled lands in the inbox first.</p>
      {list.loading && !list.data && <Loading />}
      {!!list.error && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && (
        <Empty title="no sources yet" action={<Button onClick={() => setAdding(true)}>add github, a folder or a bucket</Button>}>
          connect github to pull your repos, or watch the folder your agents write to.
        </Empty>
      )}
      {!!list.data?.length && (
        <ul className="rows conn-rows">
          {list.data.map((r) => {
            const Icon = ICON[r.kind] ?? IPlug;
            return (
              <li key={r.id}>
                <div className="row-btn">
                  <button className="grow conn-open" onClick={() => setBrowse(r)} aria-label={`browse ${r.name}`}>
                    <Icon />
                    <span className="conn-name">{r.name}</span>
                    <span className="muted small">{r.kind}{r.config.mode === "watch" || r.kind === "agent-workspace" ? " · watching" : ""}</span>
                    {r.last_error ? <span className="conn-err" title={r.last_error}>error</span> : <span className="muted small">{r.last_sync ? `checked ${ago(r.last_sync)}` : "not synced yet"}</span>}
                  </button>
                  <IconButton label={`sync ${r.name}`} onClick={() => sync(r)} disabled={syncing === r.id}><span className={syncing === r.id ? "tb-sync turn" : ""}><IRefresh size={15} /></span></IconButton>
                  <IconButton label={`remove ${r.name}`} onClick={async () => { if (!confirm(`remove ${r.name}? items already pulled stay in the vault.`)) return; try { await call("connectors.remove", { id: r.id }); list.reload(); } catch (e) { fail(e); } }}><ITrash size={15} /></IconButton>
                </div>
                {r.last_error && (
                  <div className="conn-errline">
                    <span>{r.last_error}</span>
                    <Button size="small" onClick={() => sync(r)}>retry</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">github sign in lives in <button className="link-btn" onClick={() => app.nav({ view: "settings" })}>settings → accounts</button>.</p>
      {adding && kinds.data && <AddConnector kinds={kinds.data} onClose={() => setAdding(false)} onAdded={(r) => { setAdding(false); list.reload(); setBrowse(r); }} />}
      {browse && <Browse row={browse} onClose={() => setBrowse(null)} />}
    </div>
  );
}

function AddConnector({ kinds, onClose, onAdded }: { kinds: KindInfo[]; onClose: () => void; onAdded: (r: Row) => void }) {
  const [kind, setKind] = useState<KindInfo | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const accounts = useCall<{ account: { login: string } }[]>("github.accounts");
  const save = async () => {
    if (!kind) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await call<Row>("connectors.add", { kind: kind.kind, name: name || undefined, config: vals });
      onAdded(r);
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setBusy(false); }
  };
  if (!kind) {
    return (
      <Dialog title="add a connector" onClose={onClose}>
        <ul className="rows kind-list">
          {kinds.map((k) => {
            const Icon = ICON[k.kind] ?? IPlug;
            return (
              <li key={k.kind}>
                <button className="row-btn" onClick={() => { setKind(k); setVals(Object.fromEntries(k.fields.filter((f) => f.input.startsWith("select:")).map((f) => [f.key, f.input.slice(7).split(",")[0]]))); }}>
                  <Icon />
                  <span className="grow"><span>{k.name}</span><span className="muted small block">{k.about}</span></span>
                  <IChevron size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={kind.name}
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={() => setKind(null)}>back</Button><Button onClick={save} disabled={busy}>{busy ? "checking" : "connect"}</Button></>}
    >
      <p className="muted">{kind.about}</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="name (optional)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind.name} /></Field>
        {kind.fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.secret ? "stored in the os keychain, never in the vault" : undefined}>
            {f.input === "account" ? (
              accounts.data?.length ? (
                <select className="select" value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} required>
                  <option value="">pick an account</option>
                  {accounts.data.map((a) => <option key={a.account.login} value={a.account.login}>{a.account.login}</option>)}
                </select>
              ) : <p className="note">sign in to github in settings first.</p>
            ) : f.input.startsWith("select:") ? (
              <select className="select" value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                {f.input.slice(7).split(",").map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.input === "path" ? (
              <div className="row gap">
                <input className="input mono" value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} placeholder={f.placeholder} required={f.required} />
                <Button size="small" onClick={async () => { const p = await pickPaths({ directory: true }); if (p?.[0]) setVals({ ...vals, [f.key]: p[0] }); }}>pick</Button>
              </div>
            ) : (
              <input className="input" type={f.secret ? "password" : "text"} autoComplete="off" value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} placeholder={f.placeholder} required={f.required} />
            )}
          </Field>
        ))}
        {err && <p className="err-line" role="alert">{err}</p>}
        <button type="submit" hidden />
      </form>
      <span className="sr-only" aria-live="polite">{busy ? "checking the connection" : ""}</span>
    </Dialog>
  );
}

function Browse({ row, onClose }: { row: Row; onClose: () => void }) {
  const app = useApp();
  const { fail, track, toast } = app;
  const [stack, setStack] = useState<{ id: string | null; name: string }[]>([{ id: null, name: row.name }]);
  const [extra, setExtra] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [pulling, setPulling] = useState<Set<string>>(new Set());
  const cur = stack[stack.length - 1];
  const page = useCall<Page>("connectors.browse", { id: row.id, folder: cur.id ?? undefined }, [row.id, cur.id]);
  const entries = [...(page.data?.entries ?? []), ...extra];
  const moreToken = extra.length ? next : page.data?.next;

  const pull = async (e: Entry) => {
    setPulling((s) => new Set(s).add(e.id));
    try {
      const r = await call<{ job: string }>("connectors.pull", { id: row.id, entry: e });
      track(r.job, (j) => {
        setPulling((s) => { const n = new Set(s); n.delete(e.id); return n; });
        if (j.status === "done") toast(`${e.name} is in the inbox`, "info", { label: "triage", run: () => app.nav({ view: "inbox" }) });
      });
    } catch (er) { fail(er); setPulling((s) => { const n = new Set(s); n.delete(e.id); return n; }); }
  };

  return (
    <Dialog title={row.name} onClose={onClose} label={`browse ${row.name}`}>
      <nav className="crumbs small" aria-label="folder">
        {stack.map((s, i) => (
          <span key={i} className="crumb-wrap">
            {i > 0 && <span className="sep">/</span>}
            {i === stack.length - 1 ? <span className="crumb cur">{s.name}</span> : <button className="crumb" onClick={() => { setStack(stack.slice(0, i + 1)); setExtra([]); }}>{s.name}</button>}
          </span>
        ))}
      </nav>
      {page.loading && !page.data && <Loading />}
      {!!page.error && <ErrorState error={page.error} onRetry={page.reload} />}
      {page.data && entries.length === 0 && <p className="muted">nothing here.</p>}
      <ul className="rows browse-rows">
        {entries.map((e) => {
          const Icon = e.kind === "dir" ? IFolder : e.kind === "repo" ? IGit : e.kind === "page" ? IDoc : e.kind === "design" ? IImage : e.kind === "gist" ? ILink : IFile;
          return (
            <li key={e.id}>
              <div className="row-btn">
                <button className="grow conn-open" disabled={!e.browsable} onClick={() => { if (e.browsable) { setStack([...stack, { id: e.id, name: e.name }]); setExtra([]); } }}>
                  <Icon />
                  <span className="grow"><span>{e.name}</span>{e.description && <span className="muted small block">{e.description}</span>}</span>
                  {e.size != null && <span className="muted small">{bytes(e.size)}</span>}
                  {e.updated && <span className="muted small">{ago(Date.parse(e.updated))}</span>}
                </button>
                <Button size="small" onClick={() => pull(e)} disabled={pulling.has(e.id)}>{pulling.has(e.id) ? "pulling" : "pull in"}</Button>
              </div>
            </li>
          );
        })}
      </ul>
      {moreToken && (
        <Button size="small" onClick={async () => { try { const p = await call<Page>("connectors.browse", { id: row.id, folder: cur.id ?? undefined, page: moreToken }); setExtra([...extra, ...p.entries]); setNext(p.next); } catch (e) { fail(e); } }}>load more</Button>
      )}
    </Dialog>
  );
}
