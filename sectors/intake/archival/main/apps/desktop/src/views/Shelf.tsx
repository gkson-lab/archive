import type { Item, RunInfo } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Loading, ErrorState, IChevron } from "@archival/ui";
import { KindIcon } from "../components/KindIcon";
import { ago } from "../util";
import { StatusDot } from "../components/StatusDot";

type Unfinished = { kind: string; count: number; text: string };
type ShelfData = { focus: Item | null; unfinished: Unfinished[]; inbox: Item[]; inbox_count: number; recent: Item[]; pinned: Item[]; running: RunInfo[]; total: number };

/** home: the thing you were last working on, what's unfinished about it, then compact rows */
export function Shelf() {
  const { nav } = useApp();
  const { data, error, loading, reload } = useCall<ShelfData>("shelf.get");
  const f = data?.focus ?? null;

  usePrimary(f ? { label: `open ${f.title.toLowerCase()}`, onClick: () => nav({ view: "files", itemId: f.id, path: f.path }) } : null, [f?.id]);

  if (loading && !data) return <div className="view pad"><Loading lines={4} /></div>;
  if (error) return <div className="view pad"><ErrorState error={error} onRetry={reload} /></div>;
  if (!data) return null;

  const openItem = (it: Item) => nav({ view: "files", itemId: it.id, path: it.path });
  const fix = (u: Unfinished) => {
    if (!f) return;
    if (u.kind === "uncommitted" || u.kind === "unpushed" || u.kind === "conflicts" || u.kind === "pr_draft" || u.kind === "unpublished") nav({ view: "git", itemId: f.id, path: f.path });
  };

  return (
    <div className="view shelf">
      <section className="shelf-focus" aria-labelledby="focus-title">
        {f ? (
          <>
            <p className="eyebrow-free muted">you were working on</p>
            <h1 id="focus-title" className="focus-title">
              <button className="title-btn" onClick={() => openItem(f)}>{f.title.toLowerCase()}</button>
            </h1>
            <p className="focus-meta muted">
              <KindIcon kind={f.kind} size={14} /> {f.kind} · {f.path} · {f.opened ? `opened ${ago(f.opened)}` : `changed ${ago(f.updated)}`}
            </p>
            {data.unfinished.length > 0 ? (
              <ul className="unfinished" aria-label="unfinished">
                {data.unfinished.map((u) => (
                  <li key={u.kind}>
                    <button className="unf" onClick={() => fix(u)}>
                      <span className="unf-count">{u.count}</span>
                      <span>{u.text.replace(/^\d+ /, "")}</span>
                      <IChevron size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">nothing unfinished here.</p>
            )}
          </>
        ) : (
          <>
            <h1 className="focus-title">your vault</h1>
            <p className="muted">open something from the tree and it shows up here next time.</p>
          </>
        )}
      </section>

      <div className="shelf-rows">
        {data.running.length > 0 && (
          <section aria-labelledby="running-h">
            <h2 id="running-h" className="row-h">running</h2>
            <ul className="rows">
              {data.running.map((r) => (
                <li key={r.id}>
                  <button className="row-btn" onClick={() => nav({ view: "run", itemId: r.item_id || undefined })}>
                    <StatusDot status={r.status} />
                    <span className="grow mono">{r.label}</span>
                    {r.ports.length > 0 && <span className="muted">:{r.ports.join(", :")}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-labelledby="inbox-h">
          <div className="row between">
            <h2 id="inbox-h" className="row-h">inbox <span className="muted">{data.inbox_count}</span></h2>
            {data.inbox_count > 0 && <button className="link-btn" onClick={() => nav({ view: "inbox" })}>triage all</button>}
          </div>
          {data.inbox_count === 0 ? <p className="muted">empty. anything you import lands here first.</p> : (
            <ul className="rows">
              {data.inbox.map((it) => <ItemRow key={it.id} it={it} onOpen={() => nav({ view: "inbox" })} />)}
            </ul>
          )}
        </section>
        {data.pinned.length > 0 && (
          <section aria-labelledby="pinned-h">
            <h2 id="pinned-h" className="row-h">pinned</h2>
            <ul className="rows">{data.pinned.map((it) => <ItemRow key={it.id} it={it} onOpen={() => openItem(it)} />)}</ul>
          </section>
        )}
        <section aria-labelledby="recent-h">
          <h2 id="recent-h" className="row-h">recent</h2>
          {data.recent.length === 0 ? <p className="muted">nothing else yet.</p> : (
            <ul className="rows">{data.recent.map((it) => <ItemRow key={it.id} it={it} onOpen={() => openItem(it)} />)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}

export function ItemRow({ it, onOpen, right }: { it: Item; onOpen: () => void; right?: React.ReactNode }) {
  return (
    <li>
      <button className="row-btn" onClick={onOpen}>
        <KindIcon kind={it.kind} />
        <span className="grow">{it.title}</span>
        <span className="muted row-tags">{it.tags.slice(0, 2).join(", ")}</span>
        <span className="muted">{ago(it.opened || it.updated)}</span>
        {right}
      </button>
    </li>
  );
}
