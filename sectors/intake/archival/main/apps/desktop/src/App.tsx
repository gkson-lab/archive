import { useEffect, useState } from "react";
import { call, inApp } from "./api";
import { AppProvider, useApp, useCall, type View } from "./state";
import { Dock } from "@archival/glass";
import { Button, Dialog, Field, IFolder, IPlay, IGit, IPlug } from "@archival/ui";
import { Titlebar } from "./components/Titlebar";
import { Tree } from "./components/Tree";
import { Inspector } from "./components/Inspector";
import { Palette } from "./components/Palette";
import { Toasts } from "./components/Toasts";
import { Shelf } from "./views/Shelf";
import { Files } from "./views/Files";
import { Run } from "./views/Run";
import { Git } from "./views/Git";
import { Connectors } from "./views/Connectors";
import { Inbox } from "./views/Inbox";
import { Settings } from "./views/Settings";
import { Trash } from "./views/Trash";
import { FirstRun } from "./views/FirstRun";
import { onNativeDrop, pickPaths, isMac } from "./platform";
import { ingestPaths, ingestUrl, ingestFiles } from "./ingest";

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

type Ask = null | { kind: "new"; dir: string } | { kind: "paste" } | { kind: "url" } | { kind: "path" };

function Shell() {
  const app = useApp();
  const { route, nav, primary, palette, setPalette, inspector, sidebar, setSidebar, bump } = app;
  const [ask, setAsk] = useState<Ask>(null);
  const [nativeOver, setNativeOver] = useState<string | null>(null);
  const stats = useCall<{ items: number; inbox: number }>("vault.info");
  const [skipped, setSkipped] = useState(() => { try { return localStorage.getItem("archival.firstrun") === "done"; } catch { return false; } });

  // opened from the cli with `archival open <item>`
  useEffect(() => {
    if (!inApp) return;
    if (isMac) document.documentElement.classList.add("mac");
    call<{ open: string | null }>("app.launch").then((r) => r.open && nav({ view: "files", itemId: r.open, path: undefined })).catch(() => {});
  }, []);

  // global keys: palette, views
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const m = e.metaKey || e.ctrlKey;
      if (m && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(!palette); }
      else if (m && e.key === "1") { e.preventDefault(); nav({ view: "files" }); }
      else if (m && e.key === "2") { e.preventDefault(); nav({ view: "run" }); }
      else if (m && e.key === "3") { e.preventDefault(); nav({ view: "git" }); }
      else if (m && e.key === "4") { e.preventDefault(); nav({ view: "connectors" }); }
      else if (m && e.key === ",") { e.preventDefault(); nav({ view: "settings" }); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [palette]);

  // files dropped from the os: land them on the folder under the pointer
  useEffect(() => {
    let un: () => void = () => {};
    const at = (pos: { x: number; y: number }) => (document.elementFromPoint(pos.x, pos.y)?.closest("[data-drop-path]") as HTMLElement | null)?.dataset.dropPath ?? null;
    onNativeDrop(
      (paths, pos) => ingestPaths(paths, at(pos), app),
      (pos) => setNativeOver(pos ? at(pos) ?? "" : null),
    ).then((u) => (un = u));
    return () => un();
  }, []);
  useEffect(() => {
    document.querySelectorAll(".tree-row.native-drop").forEach((el) => el.classList.remove("native-drop"));
    if (nativeOver) document.querySelectorAll(`.tree-row[data-drop-path="${CSS.escape(nativeOver)}"]`).forEach((el) => el.classList.add("native-drop"));
  }, [nativeOver]);

  // browser drops outside the tree go to the inbox
  const onDrop = (e: React.DragEvent) => {
    if ((e.target as HTMLElement).closest("[data-drop-path]")) return;
    e.preventDefault();
    const f = Array.from(e.dataTransfer.files);
    if (f.length) ingestFiles(f, null, app);
  };

  const showFirst = !skipped && stats.data && stats.data.items === 0;
  const tabs = [
    { id: "files", label: "files", icon: <IFolder size={16} />, badge: stats.data?.inbox || undefined },
    { id: "run", label: "run", icon: <IPlay size={16} /> },
    { id: "git", label: "git", icon: <IGit size={16} /> },
    { id: "connectors", label: "connectors", icon: <IPlug size={16} /> },
  ];
  const tabValue = route.view === "inbox" ? "files" : route.view;

  return (
    <div className={`app ${sidebar ? "with-tree" : ""} ${inspector ? "with-insp" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <a className="skip" href="#main">skip to content</a>
      <Titlebar />
      <div className="body">
        {sidebar && (
          <aside className="side" aria-label="vault tree">
            <div className="side-head">
              <span className="muted small">vault</span>
              <Button size="small" variant="ghost" onClick={async () => { const p = await pickPaths({ directory: true, multiple: true }); if (p) ingestPaths(p, null, app); else setAsk({ kind: "path" }); }}>add</Button>
            </div>
            <Tree onNew={(dir) => setAsk({ kind: "new", dir })} />
            <div className="side-foot">
              <button className="link-btn" onClick={() => nav({ view: "trash" })}>trash</button>
            </div>
          </aside>
        )}
        {sidebar && <div className="side-scrim" onClick={() => setSidebar(false)} aria-hidden="true" />}
        <main id="main" className="main" tabIndex={-1}>
          {showFirst ? <FirstRun onSkip={() => { setSkipped(true); try { localStorage.setItem("archival.firstrun", "done"); } catch {} }} /> : <ViewSwitch view={route.view} />}
        </main>
        {inspector && <Inspector />}
      </div>
      <Dock
        tabs={tabs}
        value={tabValue}
        onChange={(id) => nav({ view: id as View })}
        right={primary ? (
          primary.chip ? (
            <a className="btn chip" href={primary.href ?? "#"} onClick={(e) => { e.preventDefault(); primary.onClick(); }}>{primary.label}</a>
          ) : (
            <Button variant="primary" onClick={primary.onClick} disabled={primary.disabled} aria-busy={primary.busy} shine={primary.shine}>{primary.label}</Button>
          )
        ) : null}
      />
      {palette && <Palette onNewFile={() => setAsk({ kind: "new", dir: route.path?.split("/").length && route.path.split("/").length > 1 ? route.path.split("/").slice(0, 2).join("/") : "snippets" })} onPaste={() => setAsk({ kind: "paste" })} onUrl={() => setAsk({ kind: "url" })} onPath={() => setAsk({ kind: "path" })} />}
      {ask?.kind === "new" && <NewFile dir={ask.dir} onClose={() => setAsk(null)} onDone={(p, itemId) => { setAsk(null); bump(); nav({ view: "files", path: p, itemId }); }} />}
      {ask?.kind === "paste" && <PasteSnippet onClose={() => setAsk(null)} />}
      {ask?.kind === "url" && <AskOne title="save a url" label="url" placeholder="https://" onClose={() => setAsk(null)} onSubmit={(v) => { setAsk(null); ingestUrl(v, app); }} />}
      {ask?.kind === "path" && <AskOne title="add a folder" label="folder or file path" placeholder="/home/you/code/project" onClose={() => setAsk(null)} onSubmit={(v) => { setAsk(null); ingestPaths([v], null, app); }} />}
      <Toasts />
    </div>
  );
}

function ViewSwitch({ view }: { view: View }) {
  switch (view) {
    case "shelf": return <Shelf />;
    case "files": return <Files />;
    case "run": return <Run />;
    case "git": return <Git />;
    case "connectors": return <Connectors />;
    case "inbox": return <Inbox />;
    case "settings": return <Settings />;
    case "trash": return <Trash />;
  }
}

function AskOne({ title, label, placeholder, onClose, onSubmit }: { title: string; label: string; placeholder: string; onClose: () => void; onSubmit: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <Dialog title={title} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>cancel</Button><Button onClick={() => v.trim() && onSubmit(v.trim())} disabled={!v.trim()}>add</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()); }}>
        <Field label={label}><input className="input mono" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} /></Field>
      </form>
    </Dialog>
  );
}

function NewFile({ dir, onClose, onDone }: { dir: string; onClose: () => void; onDone: (path: string, itemId?: string) => void }) {
  const { fail } = useApp();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState(false);
  const create = async () => {
    const n = name.trim().replace(/^\/+/, "");
    if (!n) return;
    const p = `${dir}/${n}`;
    try {
      if (folder) await call("file.create_dir", { path: p });
      else await call("file.write", { path: p, text: "" });
      const parts = p.split("/");
      const root = parts.slice(0, 2).join("/");
      const items = await call<{ id: string; path: string }[]>("items.list", { category: parts[0] });
      onDone(p, items.find((i) => i.path === root)?.id);
    } catch (e) { fail(e); }
  };
  return (
    <Dialog title={folder ? "new folder" : "new file"} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>cancel</Button><Button onClick={create} disabled={!name.trim()}>create</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); create(); }} className="form">
        <Field label={`name, inside ${dir}/`}><input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={folder ? "my-project" : "notes.md"} /></Field>
        <div className="seg" role="radiogroup" aria-label="type">
          <button type="button" role="radio" aria-checked={!folder} onClick={() => setFolder(false)}>file</button>
          <button type="button" role="radio" aria-checked={folder} onClick={() => setFolder(true)}>folder</button>
        </div>
      </form>
    </Dialog>
  );
}

function PasteSnippet({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  useEffect(() => { navigator.clipboard?.readText?.().then((t) => t && setText(t)).catch(() => {}); }, []);
  const save = async () => {
    try {
      const r = await call<{ item: { id: string; path: string; title: string } }>("ingest.text", { title, text });
      app.toast(`${r.item.title} saved to the inbox`);
      app.bump();
      app.nav({ view: "files", itemId: r.item.id, path: r.item.path });
      onClose();
    } catch (e) { app.fail(e); }
  };
  return (
    <Dialog title="save a snippet" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>cancel</Button><Button onClick={save} disabled={!text.trim()}>save</Button></>}>
      <Field label="title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="pasted" /></Field>
      <Field label="text (the file type is guessed)"><textarea className="textarea mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} /></Field>
    </Dialog>
  );
}
