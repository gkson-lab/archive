import { useEffect, useMemo, useState } from "react";
import { call, type RepoStatus, type FileStatus } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Button, Empty, ErrorState, Loading, Switch, Ring, useTicker, ICommit, IBranch, IHistory, ISpark } from "@archival/ui";
import { DiffView, CodeEditor, type FileDiff } from "@archival/viewers";
import { ago, extOf } from "../util";
import { openUrl } from "../platform";

type Tab = "changes" | "history" | "pr" | "publish";
type Branch = { name: string; current: boolean; remote: boolean };
type Event = { type: "snapshot" | "commit"; time: number; id: string; title: string; detail: string; source?: string };
type PR = { number: number; title: string; html_url: string; state: string; draft: boolean; head: string; base: string };

export function Git() {
  const { item } = useApp();
  if (!item) return <div className="view pad"><h1 className="view-title">git</h1><Empty title="pick a project">choose something in the tree to see its changes and history.</Empty></div>;
  if (!item.is_dir) return <div className="view pad"><h1 className="view-title">git</h1><Empty title="single files don't have git">move it into a project folder to track it with git. snapshots in the inspector still keep its history.</Empty></div>;
  return <GitItem key={item.id} />;
}

function GitItem() {
  const app = useApp();
  const { item, fail, toast, bump } = app;
  const id = item!.id;
  const st = useCall<RepoStatus>("git.status", { item_id: id }, [id]);
  const ai = useCall<{ enabled: boolean }>("assistant.status");
  const [tab, setTab] = useState<Tab>("changes");
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [shine, setShine] = useState(0);
  const [prDone, setPrDone] = useState<PR | null>(null);
  const changed = st.data?.files.length ?? 0;
  const shown = useTicker(changed);
  const accounts = useCall<any[]>("github.accounts");

  const act = async (name: string, f: () => Promise<void>) => {
    setBusy(name);
    try { await f(); } catch (e) { fail(e); } finally { setBusy(null); st.reload(); }
  };
  const ship = () => act("ship", async () => {
    const r = await call<{ commit: string; pushed: string | null }>("git.ship", { item_id: id, message: msg });
    setMsg("");
    setShine((s) => s + 1);
    toast(r.pushed ? `committed and pushed ${r.pushed}` : "committed. add a remote or publish to push");
    bump();
  });

  const s = st.data;
  const hasRemote = !!s?.remotes.length;
  const isGithub = !!item!.remote?.includes("github.com");
  const onBranch = s?.branch ?? "";

  let primary: Parameters<typeof usePrimary>[0] = null;
  const childOwns = tab === "publish" || (isGithub && tab === "pr" && !prDone);
  if (prDone) primary = { label: `pr #${prDone.number} open`, onClick: () => openUrl(prDone.html_url), chip: true };
  else if (s && !s.is_repo) primary = undefined;
  else if (s?.merging) primary = { label: "finish merge", onClick: () => act("commit", async () => { await call("git.commit", { item_id: id, message: msg || `merge ${s.upstream ?? "remote"}` }); toast("merge finished"); }), disabled: s.files.some((f) => f.conflicted) };
  else if (childOwns) primary = undefined;
  else if (changed > 0 && tab === "changes") primary = { label: busy === "ship" ? "committing" : hasRemote ? "commit & push" : "commit", onClick: ship, disabled: !msg.trim() || !!busy, busy: busy === "ship", shine };
  else if (s && s.ahead > 0) primary = { label: "push", onClick: () => act("push", async () => { await call("git.push", { item_id: id }); toast("pushed"); }), busy: busy === "push" };
  else if (isGithub && changed === 0) primary = { label: "open pr", onClick: () => setTab("pr") };
  usePrimary(primary, [primary?.label, primary?.disabled, msg, busy, shine, tab, prDone?.number]);

  useEffect(() => {
    if (!sel && s?.files.length) setSel({ path: s.files[0].path, staged: !!s.files[0].staged && !s.files[0].unstaged });
    if (sel && s && !s.files.some((f) => f.path === sel.path)) setSel(s.files[0] ? { path: s.files[0].path, staged: false } : null);
  }, [s?.files.map((f) => f.path).join()]);

  if (st.loading && !s) return <div className="view pad"><Loading /></div>;
  if (st.error) return <div className="view pad"><ErrorState error={st.error} onRetry={st.reload} /></div>;
  if (!s) return null;
  if (!s.is_repo) return <Publish hasAccount={!!accounts.data?.length} />;

  const conflicted = s.files.filter((f) => f.conflicted);
  const staged = s.files.filter((f) => f.staged && !f.conflicted);
  const unstaged = s.files.filter((f) => (f.unstaged || f.untracked) && !f.conflicted);

  return (
    <div className="view git-view">
      <div className="git-head">
        <h1 className="view-title sm">{item!.title.toLowerCase()}</h1>
        <Branches itemId={id} current={onBranch} onChange={st.reload} />
        <span className="muted small">{s.upstream ? `${s.ahead} ahead · ${s.behind} behind ${s.upstream}` : hasRemote ? "not pushed yet" : "no remote"}</span>
        <span className="grow" />
        {hasRemote && <Button size="small" onClick={() => act("pull", async () => { const r = await call<{ outcome: string; conflicts: string[] }>("git.pull", { item_id: id }); toast(r.outcome === "conflicts" ? `${r.conflicts.length} conflicts to resolve` : r.outcome.replace("-", " ")); })} disabled={!!busy}>{busy === "pull" ? "pulling" : "pull"}</Button>}
        <div className="seg" role="tablist" aria-label="git">
          <button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}><ICommit size={14} /> changes <span className="count">{shown}</span></button>
          <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}><IHistory size={14} /> history</button>
          {isGithub && <button role="tab" aria-selected={tab === "pr"} onClick={() => setTab("pr")}><IBranch size={14} /> pull request</button>}
        </div>
      </div>

      {tab === "changes" && (
        changed === 0 ? (
          <div className="pad"><Empty title="nothing to commit">{s.ahead ? `${s.ahead} commit${s.ahead === 1 ? "" : "s"} waiting to be pushed.` : "the working tree matches the last commit."}</Empty></div>
        ) : (
          <div className="git-grid">
            <aside className="git-files" aria-label="changed files">
              {conflicted.length > 0 && <FileGroup title="conflicted" files={conflicted} sel={sel} onSel={setSel} kind="conflict" />}
              <FileGroup title="staged" files={staged} sel={sel} onSel={setSel} kind="staged" action={(f) => call("git.unstage", { item_id: id, paths: [f.path] }).then(st.reload).catch(fail)} all={staged.length ? () => call("git.unstage", { item_id: id, paths: staged.map((f) => f.path) }).then(st.reload).catch(fail) : undefined} />
              <FileGroup title="not staged" files={unstaged} sel={sel} onSel={setSel} kind="unstaged" action={(f) => call("git.stage", { item_id: id, paths: [f.path] }).then(st.reload).catch(fail)} all={unstaged.length ? () => call("git.stage_all", { item_id: id }).then(st.reload).catch(fail) : undefined} />
              <form className="commit-box" onSubmit={(e) => { e.preventDefault(); if (msg.trim()) ship(); }}>
                <label className="field">
                  <span>commit message</span>
                  <textarea className="textarea" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="what changed, in a few words" rows={3}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && msg.trim()) { e.preventDefault(); ship(); } }} />
                </label>
                {ai.data?.enabled && (
                  <Button size="small" variant="ghost" disabled={!!busy} onClick={() => act("ai", async () => { const r = await call<{ message: string }>("assistant.commit_message", { item_id: id }); setMsg(r.message); })}>
                    <ISpark size={14} /> {busy === "ai" ? "writing" : "suggest a message"}
                  </Button>
                )}
                <p className="muted small">{hasRemote ? "commit & push stages everything and pushes to " + s.remotes[0].name : "stages everything and commits locally"}</p>
              </form>
            </aside>
            <section className="git-diff" aria-label="diff">
              {sel && (conflicted.some((c) => c.path === sel.path) ? <Conflict itemId={id} path={sel.path} onDone={st.reload} /> : <Diff itemId={id} path={sel.path} staged={sel.staged} />)}
            </section>
          </div>
        )
      )}
      {tab === "history" && <History itemId={id} />}
      {tab === "pr" && <PrForm itemId={id} branch={onBranch} onDone={(pr) => { setPrDone(pr); toast(`opened pr #${pr.number}`); }} />}
      {conflicted.length > 0 && tab === "changes" && (
        <div className="pad-x"><Button size="small" variant="danger" onClick={() => act("abort", async () => { await call("git.abort_merge", { item_id: id }); toast("merge abandoned"); })}>abandon merge</Button></div>
      )}
      {!hasRemote && tab !== "publish" && <div className="pad-x muted small git-foot">not linked to a remote yet. <button className="link-btn" onClick={() => setTab("publish")}>publish to github</button></div>}
      {tab === "publish" && <Publish hasAccount={!!accounts.data?.length} />}
    </div>
  );
}

function FileGroup({ title, files, sel, onSel, kind, action, all }: { title: string; files: FileStatus[]; sel: { path: string; staged: boolean } | null; onSel: (s: { path: string; staged: boolean }) => void; kind: "staged" | "unstaged" | "conflict"; action?: (f: FileStatus) => void; all?: () => void }) {
  if (!files.length) return null;
  return (
    <div className="fgroup">
      <div className="row between"><h3 className="row-h">{title} <span className="muted">{files.length}</span></h3>{all && <button className="link-btn" onClick={all}>{kind === "staged" ? "unstage all" : "stage all"}</button>}</div>
      <ul className="rows tight">
        {files.map((f) => {
          const status = kind === "staged" ? f.staged : f.untracked ? "new" : f.unstaged || "conflict";
          return (
            <li key={f.path + kind}>
              <div className={`row-btn ${sel?.path === f.path && sel.staged === (kind === "staged") ? "on" : ""}`}>
                <button className="grow file-pick" onClick={() => onSel({ path: f.path, staged: kind === "staged" })}>
                  <span className={`st st-${status}`} aria-label={status}>{status[0]}</span>
                  <span className="mono ell">{f.path}</span>
                </button>
                {action && <button className="link-btn" onClick={() => action(f)}>{kind === "staged" ? "unstage" : "stage"}</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Diff({ itemId, path, staged }: { itemId: string; path: string; staged: boolean }) {
  const { data, error, loading, reload } = useCall<FileDiff[]>("git.diff", { item_id: itemId, path, staged }, [path, staged]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return <DiffView key={path + staged} diff={data ?? []} />;
}

function Conflict({ itemId, path, onDone }: { itemId: string; path: string; onDone: () => void }) {
  const { fail, toast } = useApp();
  const { data, error, loading } = useCall<{ base: string | null; ours: string | null; theirs: string | null }>("git.conflict", { item_id: itemId, path }, [path]);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => { if (data) setResult(data.ours ?? data.theirs ?? ""); }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} />;
  const ext = extOf(path);
  return (
    <div className="conflict">
      <div className="three">
        {(["base", "ours", "theirs"] as const).map((k) => (
          <div key={k} className="pane">
            <div className="row between"><h3 className="row-h">{k === "ours" ? "yours" : k === "theirs" ? "incoming" : "original"}</h3>{k !== "base" && <button className="link-btn" onClick={() => setResult(data?.[k] ?? "")}>use this</button>}</div>
            <pre className="mono pane-text">{data?.[k] ?? "(file didn't exist)"}</pre>
          </div>
        ))}
      </div>
      <h3 className="row-h">result</h3>
      <div className="result-ed"><CodeEditor value={result ?? ""} ext={ext} onChange={setResult} label="resolved file" /></div>
      <Button onClick={async () => { try { await call("git.resolve", { item_id: itemId, path, content: result ?? "" }); toast(`${path} resolved`); onDone(); } catch (e) { fail(e); } }}>mark resolved</Button>
    </div>
  );
}

function Branches({ itemId, current, onChange }: { itemId: string; current: string; onChange: () => void }) {
  const { fail, toast } = useApp();
  const { data, reload } = useCall<Branch[]>("git.branches", { item_id: itemId }, [itemId, current]);
  const local = (data ?? []).filter((b) => !b.remote);
  const remote = (data ?? []).filter((b) => b.remote && !local.some((l) => b.name.endsWith("/" + l.name)));
  return (
    <label className="branch">
      <IBranch size={14} />
      <span className="sr-only">branch</span>
      <select className="select small" value={current} onChange={async (e) => {
        const v = e.target.value;
        try {
          if (v === "__new") {
            const name = prompt("new branch name");
            if (!name) return;
            await call("git.checkout", { item_id: itemId, name, create: true });
          } else await call("git.checkout", { item_id: itemId, name: v.replace(/^origin\//, ""), create: false });
          toast(`on ${v === "__new" ? "the new branch" : v}`);
          reload(); onChange();
        } catch (er) { fail(er); }
      }}>
        {!current && <option value="">no branch</option>}
        {local.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        {remote.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        <option value="__new">new branch…</option>
      </select>
    </label>
  );
}

function History({ itemId }: { itemId: string }) {
  const { data, error, loading, reload } = useCall<Event[]>("history", { item_id: itemId }, [itemId]);
  if (loading && !data) return <div className="pad"><Loading /></div>;
  if (error) return <div className="pad"><ErrorState error={error} onRetry={reload} /></div>;
  if (!data?.length) return <div className="pad"><Empty title="no history yet">commits and snapshots show up here as one timeline.</Empty></div>;
  return (
    <ol className="timeline pad">
      {data.map((e) => (
        <li key={e.type + e.id} className={`tl ${e.type}`}>
          <span className="tl-dot" aria-hidden="true" />
          <div>
            <div>{e.title || "(no message)"}</div>
            <div className="muted small">{e.type === "commit" ? "commit" : `snapshot · ${e.source}`} · {e.detail} · {ago(e.time)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PrForm({ itemId, branch, onDone }: { itemId: string; branch: string; onDone: (pr: PR) => void }) {
  const { fail } = useApp();
  const tpl = useCall<{ template: string | null }>("github.pr_template", { item_id: itemId }, [itemId]);
  const draftQ = useCall<{ title: string; body: string; base: string } | null>("github.pr_draft_get", { item_id: itemId }, [itemId]);
  const existing = useCall<PR[]>("github.prs", { item_id: itemId }, [itemId, branch]);
  const branches = useCall<Branch[]>("git.branches", { item_id: itemId }, [itemId]);
  const ai = useCall<{ enabled: boolean }>("assistant.status");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [asDraft, setAsDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded || tpl.loading || draftQ.loading) return;
    if (draftQ.data) { setTitle(draftQ.data.title); setBody(draftQ.data.body); setBase(draftQ.data.base); }
    else if (tpl.data?.template) setBody(tpl.data.template);
    setLoaded(true);
  }, [tpl.loading, draftQ.loading]);
  // keep a draft so an unsent pr shows up on the shelf
  useEffect(() => {
    if (!loaded || (!title && !body)) return;
    const h = setTimeout(() => call("github.pr_draft_save", { item_id: itemId, title, body, base, head: branch }).catch(() => {}), 500);
    return () => clearTimeout(h);
  }, [title, body, base]);
  const baseOptions = useMemo(() => Array.from(new Set((branches.data ?? []).map((b) => b.name.replace(/^origin\//, "")))), [branches.data]);
  const send = async () => {
    setBusy(true);
    try {
      const pr = await call<PR>("github.open_pr", { item_id: itemId, title, body, base: base || undefined, draft: asDraft });
      onDone(pr);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  usePrimary({ label: busy ? "opening" : "open pr", onClick: send, disabled: !title.trim() || busy, busy }, [title, body, base, asDraft, busy]);
  return (
    <div className="pr-form pad">
      {!!existing.data?.length && (
        <div className="note">
          already open for {branch}: {existing.data.map((p) => <button key={p.number} className="link-btn" onClick={() => openUrl(p.html_url)}>#{p.number} {p.title}</button>)}
        </div>
      )}
      <label className="field"><span>title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="what this change does" /></label>
      <div className="row gap wrap">
        <label className="field grow"><span>into</span>
          <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
            <option value="">default branch</option>
            {baseOptions.filter((b) => b !== branch).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <div className="field"><span>from</span><span className="mono pr-head">{branch}</span></div>
      </div>
      <label className="field"><span>description {tpl.data?.template ? "(from the repo's template)" : ""}</span><textarea className="textarea" rows={10} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <div className="row gap wrap">
        <Switch label="open as draft" checked={asDraft} onChange={setAsDraft} />
        {ai.data?.enabled && <Button size="small" variant="ghost" onClick={async () => { try { const r = await call<{ body: string }>("assistant.pr_description", { item_id: itemId }); setBody(r.body); } catch (e) { fail(e); } }}><ISpark size={14} /> write a description</Button>}
      </div>
      <p className="muted small">if you're on the default branch, archival moves your commits to a new branch named after the title first.</p>
    </div>
  );
}

/** not a repo yet: track with git, then publish. two steps, shown as progress. */
function Publish({ hasAccount }: { hasAccount: boolean }) {
  const app = useApp();
  const { item, fail, toast, nav, track, jobs } = app;
  const [name, setName] = useState(item!.title.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""));
  const [priv, setPriv] = useState(true);
  const [desc, setDesc] = useState("");
  const [job, setJob] = useState<string | null>(null);
  const j = jobs.find((x) => x.id === job);
  const publish = async () => {
    try {
      const r = await call<{ job: string }>("github.publish", { item_id: item!.id, name, private: priv, description: desc });
      setJob(r.job);
      track(r.job, (done) => { if (done.status === "done") { toast(`published ${done.result?.repo?.full_name ?? name}`); } });
    } catch (e) { fail(e); }
  };
  usePrimary(hasAccount ? { label: j?.status === "running" ? "publishing" : "publish to github", onClick: publish, disabled: !name.trim() || j?.status === "running", busy: j?.status === "running" } : { label: "sign in to github", onClick: () => nav({ view: "settings" }) }, [hasAccount, name, priv, desc, j?.status]);
  const steps = j?.steps?.length ? j.steps : ["prepare git", "first commit", "create repo on github", "push"];
  const done = j ? j.done : 0;
  return (
    <div className="view pad publish">
      <h1 className="view-title">{item!.title.toLowerCase()}</h1>
      <p className="muted">not tracked with git yet. publish it as a new github repo in one go, or just start tracking locally.</p>
      <div className="publish-grid">
        <div className="publish-form">
          <label className="field"><span>repo name</span><input className="input mono" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>description (optional)</span><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <Switch label="private" checked={priv} onChange={setPriv} />
          <Button size="small" onClick={async () => { try { await call("git.init", { item_id: item!.id }); toast("tracking with git on main"); app.bump(); } catch (e) { fail(e); } }}>just track with git</Button>
        </div>
        <ol className="steps" aria-label="publish steps">
          {steps.map((s, i) => (
            <li key={s} className={i < done ? "done" : i === done && j?.status === "running" ? "now" : ""}>
              {i === done && j?.status === "running" ? <Ring value={0.5} chrome /> : <span className="step-n">{i < done ? "✓" : i + 1}</span>}
              <span>{s}</span>
            </li>
          ))}
          <li className="muted small">{j?.status === "running" ? `${steps.length - done} step${steps.length - done === 1 ? "" : "s"} left` : j?.status === "error" ? j.error : `${steps.length} steps`}</li>
        </ol>
      </div>
    </div>
  );
}
