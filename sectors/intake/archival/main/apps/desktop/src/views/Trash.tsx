import { call } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Button, Empty, ErrorState, Loading } from "@archival/ui";
import { ago } from "../util";

type T = { id: string; original_path: string; title: string; trashed_at: number; is_item: boolean };

export function Trash() {
  const { fail, toast, bump } = useApp();
  const { data, error, loading, reload } = useCall<T[]>("trash.list");
  const days = useCall<Record<string, any>>("settings.get");
  usePrimary(null, []);
  if (loading && !data) return <div className="view pad"><Loading /></div>;
  if (error) return <div className="view pad"><ErrorState error={error} onRetry={reload} /></div>;
  const keep = days.data?.["trash.retention_days"] ?? 30;
  return (
    <div className="view pad">
      <h1 className="view-title">trash</h1>
      <p className="muted lede">things stay here for {keep} days, then they're removed for good.</p>
      {!data?.length ? <Empty title="trash is empty" /> : (
        <ul className="rows">
          {data.map((t) => (
            <li key={t.id}>
              <div className="row-btn">
                <span className="grow"><span>{t.title}</span><span className="muted small block mono">{t.original_path}</span></span>
                <span className="muted small">{ago(t.trashed_at)}</span>
                <Button size="small" onClick={async () => { try { const r = await call<{ path: string }>("trash.restore", { id: t.id }); toast(`restored to ${r.path}`); reload(); bump(); } catch (e) { fail(e); } }}>restore</Button>
                <Button size="small" variant="danger" onClick={async () => { if (!confirm(`delete ${t.title} for good? this can't be undone.`)) return; try { await call("trash.purge", { id: t.id }); reload(); } catch (e) { fail(e); } }}>delete for good</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
