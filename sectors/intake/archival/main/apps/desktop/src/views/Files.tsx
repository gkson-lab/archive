import { useEffect, useMemo, useRef, useState } from "react";
import { call, b64ToBytes, type Item, type TreeEntry, type RepoStatus } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Button, Loading, ErrorState, Empty } from "@archival/ui";
import { CodeEditor, Markdown, ImageViewer, PdfViewer, MediaViewer, HtmlPreview, TokensTable, LinkCard, type LinkData } from "@archival/viewers";
import { KindIcon } from "../components/KindIcon";
import { ago, bytes, extOf, baseName, KIND_CATEGORY } from "../util";
import { openUrl, openPath } from "../platform";
import { ItemRow } from "./Shelf";

type FileContent = { path: string; size: number; mime: string; ext: string; text: string | null; binary: boolean; too_large: boolean };

export function Files() {
  const { route, item } = useApp();
  const path = route.path;
  if (!path) return <Overview />;
  const depth = path.split("/").length;
  if (depth === 1) return <Category cat={path} />;
  if (item && item.path === path && item.is_dir) return <ItemOverview item={item} />;
  return <PathView path={path} />;
}

function Overview() {
  const { nav } = useApp();
  const { data, error, loading, reload } = useCall<Item[]>("items.list");
  usePrimary(null, []);
  if (loading && !data) return <div className="view pad"><Loading /></div>;
  if (error) return <div className="view pad"><ErrorState error={error} onRetry={reload} /></div>;
  const groups = ["projects", "docs", "designs", "snippets", "assets", "links"];
  return (
    <div className="view pad">
      <h1 className="view-title">files</h1>
      {data?.length === 0 && <Empty title="nothing filed yet">drop a folder on the tree, or press add in the dock.</Empty>}
      {groups.map((g) => {
        const list = (data ?? []).filter((i) => i.path.split("/")[0] === g);
        if (!list.length) return null;
        return (
          <section key={g} className="group">
            <h2 className="row-h"><button className="link-btn plain" onClick={() => nav({ view: "files", path: g, itemId: undefined })}>{g}</button> <span className="muted">{list.length}</span></h2>
            <ul className="rows">{list.slice(0, 8).map((it) => <ItemRow key={it.id} it={it} onOpen={() => nav({ view: "files", itemId: it.id, path: it.path })} />)}</ul>
          </section>
        );
      })}
    </div>
  );
}

function Category({ cat }: { cat: string }) {
  const { nav } = useApp();
  const { data, error, loading, reload } = useCall<Item[]>("items.list", { category: cat }, [cat]);
  usePrimary(null, [cat]);
  if (loading && !data) return <div className="view pad"><Loading /></div>;
  if (error) return <div className="view pad"><ErrorState error={error} onRetry={reload} /></div>;
  return (
    <div className="view pad">
      <h1 className="view-title">{cat}</h1>
      {data?.length === 0 ? <Empty title={`no ${cat} yet`}>drag something onto “{cat}” in the tree to file it here.</Empty> : (
        <ul className="rows">{data!.map((it) => <ItemRow key={it.id} it={it} onOpen={() => nav({ view: "files", itemId: it.id, path: it.path })} />)}</ul>
      )}
    </div>
  );
}

function useItemPrimary(item: Item | null, dirty: { save: () => void } | null) {
  const app = useApp();
  // the save callback changes every keystroke; keep it in a ref so the dock doesn't re-render in a loop
  const saveRef = useRef<(() => void) | undefined>(undefined);
  saveRef.current = dirty?.save;
  const { nav, bump, fail, toast } = app;
  const [git, setGit] = useState<RepoStatus | null>(null);
  useEffect(() => {
    setGit(null);
    if (item?.is_dir) call<RepoStatus>("git.status", { item_id: item.id }).then(setGit).catch(() => {});
  }, [item?.id, app.version]);
  const fileIt = async () => {
    if (!item) return;
    try {
      const it = await call<Item>("item.file", { id: item.id });
      toast(`filed in ${it.path.split("/")[0]}`);
      nav({ itemId: it.id, path: it.path });
      bump();
    } catch (e) { fail(e); }
  };
  let p: Parameters<typeof usePrimary>[0] = null;
  if (dirty) p = { label: "save", onClick: () => saveRef.current?.() };
  else if (item?.path.startsWith("inbox/")) p = { label: `file it in ${KIND_CATEGORY[item.kind]}`, onClick: fileIt };
  else if (item && git?.is_repo && git.files.length) p = { label: "commit & push", onClick: () => nav({ view: "git" }) };
  else if (item?.kind === "project") p = { label: "run", onClick: () => nav({ view: "run" }) };
  usePrimary(p, [p?.label, item?.id, !!dirty, item?.path]);
}

function ItemOverview({ item }: { item: Item }) {
  const { nav } = useApp();
  const tree = useCall<TreeEntry[]>("tree.list", { path: item.path }, [item.path]);
  const readme = tree.data?.find((e) => /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name));
  const link = tree.data?.find((e) => e.name === "link.json");
  const images = tree.data?.filter((e) => ["png", "jpg", "jpeg", "webp", "svg", "gif"].includes(e.ext)) ?? [];
  const frames = tree.data?.find((e) => e.name === "frames" && e.is_dir);
  useItemPrimary(item, null);
  useEffect(() => { call("item.opened", { id: item.id }).catch(() => {}); }, [item.id]);

  return (
    <div className="view pad">
      <header className="item-head">
        <h1 className="view-title">{item.title.toLowerCase()}</h1>
        <p className="muted item-meta"><KindIcon kind={item.kind} size={14} /> {item.kind} · from {item.origin_connector} · changed {ago(item.updated)}{item.tags.length ? ` · ${item.tags.join(", ")}` : ""}</p>
        <div className="row gap wrap">
          {item.kind === "project" && <Button size="small" onClick={() => nav({ view: "run" })}>run</Button>}
          <Button size="small" onClick={() => nav({ view: "git" })}>git</Button>
        </div>
      </header>
      {tree.loading && !tree.data && <Loading />}
      {!!tree.error && <ErrorState error={tree.error} onRetry={tree.reload} />}
      {link && <LinkPreview path={link.path} dir={item.path} />}
      {!link && images.length > 0 && <Gallery dir={item.path} images={images} framesDir={frames?.path} />}
      {readme && <ReadmeBlock path={readme.path} />}
      {tree.data && !readme && !link && (
        <section className="group">
          <h2 className="row-h">files <span className="muted">{tree.data.length}</span></h2>
          <DirList entries={tree.data} itemId={item.id} />
        </section>
      )}
      {tree.data && readme && (
        <details className="group">
          <summary className="row-h">all files <span className="muted">{tree.data.length}</span></summary>
          <DirList entries={tree.data} itemId={item.id} />
        </details>
      )}
    </div>
  );
}

function DirList({ entries, itemId }: { entries: TreeEntry[]; itemId?: string }) {
  const { nav } = useApp();
  if (!entries.length) return <p className="muted">this folder is empty.</p>;
  return (
    <ul className="rows">
      {entries.map((e) => (
        <li key={e.path}>
          <button className="row-btn" onClick={() => nav({ view: "files", path: e.path, itemId })}>
            <KindIcon kind={e.is_dir ? "dir" : "file"} />
            <span className="grow">{e.name}</span>
            {!e.is_dir && <span className="muted">{bytes(e.size)}</span>}
            <span className="muted">{ago(e.modified)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReadmeBlock({ path }: { path: string }) {
  const { data } = useCall<FileContent>("file.read", { path }, [path]);
  if (!data?.text) return null;
  return extOf(path) === "txt" || !extOf(path) ? <pre className="readme-txt">{data.text}</pre> : <Markdown source={data.text} onLink={(h) => /^https?:/.test(h) && openUrl(h)} />;
}

function useDataUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let u: string | null = null;
    call<{ mime: string; data: string }>("file.read_base64", { path })
      .then((r) => {
        u = URL.createObjectURL(new Blob([b64ToBytes(r.data) as BlobPart], { type: r.mime }));
        setUrl(u);
      })
      .catch(() => setUrl(null));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [path]);
  return url;
}

function LinkPreview({ path, dir }: { path: string; dir: string }) {
  const { data } = useCall<FileContent>("file.read", { path }, [path]);
  const link = useMemo<LinkData | null>(() => { try { return data?.text ? JSON.parse(data.text) : null; } catch { return null; } }, [data?.text]);
  const thumb = useDataUrl(link?.thumbnail ? `${dir}/${link.thumbnail}` : null);
  if (!link) return null;
  return <LinkCard link={link} thumbSrc={thumb ?? undefined} onOpen={openUrl} />;
}

function Gallery({ dir, images, framesDir }: { dir: string; images: TreeEntry[]; framesDir?: string }) {
  const frames = useCall<TreeEntry[]>(framesDir ? "tree.list" : null, { path: framesDir }, [framesDir]);
  const all = [...images, ...(frames.data ?? [])];
  const { nav } = useApp();
  const first = useDataUrl(all[0]?.path ?? null);
  if (!all.length) return null;
  void dir;
  return (
    <section className="gallery">
      {first && <button className="gal-main" onClick={() => nav({ view: "files", path: all[0].path })}><img src={first} alt={all[0].name} /></button>}
      {all.length > 1 && (
        <ul className="rows">
          {all.slice(1).map((e) => (
            <li key={e.path}><button className="row-btn" onClick={() => nav({ view: "files", path: e.path })}><KindIcon kind="design" /><span className="grow">{e.name}</span><span className="muted">{bytes(e.size)}</span></button></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PathView({ path }: { path: string }) {
  const tree = useCall<TreeEntry[]>("tree.list", { path }, [path]);
  const isDir = !!tree.data;
  const notDir = !!tree.error;
  const { item } = useApp();
  if (tree.loading && !tree.data && !tree.error) return <div className="view pad"><Loading /></div>;
  if (isDir) {
    return <DirView path={path} entries={tree.data!} itemId={item?.id} />;
  }
  if (notDir) return <FileView key={path} path={path} />;
  return null;
}

function DirView({ path, entries, itemId }: { path: string; entries: TreeEntry[]; itemId?: string }) {
  const { item } = useApp();
  useItemPrimary(item, null);
  return (
    <div className="view pad">
      <h1 className="view-title">{baseName(path)}</h1>
      <DirList entries={entries} itemId={itemId} />
    </div>
  );
}

type Mode = "read" | "edit";

function FileView({ path }: { path: string }) {
  const app = useApp();
  const { item, fail, toast, bump } = app;
  const { data, error, loading, reload } = useCall<FileContent>("file.read", { path }, [path]);
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ext = extOf(path);
  const previewable = ["md", "markdown", "html", "htm", "svg"].includes(ext) || (ext === "json" && !!data?.text && /"\$value"|"\$type"/.test(data.text));
  const [mode, setMode] = useState<Mode>("read");
  // pick the default once the file has loaded: preview for markdown, html, svg and tokens
  useEffect(() => { if (data) setMode(previewable ? "read" : "edit"); }, [data?.path, previewable]);
  useEffect(() => { setText(null); }, [path, data?.text]);
  const dirty = text != null && text !== data?.text;
  const save = async () => {
    if (text == null) return;
    setSaving(true);
    try {
      await call("file.write", { path, text });
      toast(`saved ${baseName(path)}`);
      await reload();
      setText(null);
      bump();
    } catch (e) { fail(e); }
    finally { setSaving(false); }
  };
  useItemPrimary(item, dirty ? { save } : null);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loading && !data) return <div className="view pad"><Loading /></div>;
  if (error) return <div className="view pad"><ErrorState error={error} onRetry={reload} /></div>;
  if (!data) return null;

  const current = text ?? data.text ?? "";
  return (
    <div className="view file-view">
      <div className="file-bar">
        <span className="mono file-name">{baseName(path)}{dirty && <span className="dirty" aria-label="unsaved changes"> ●</span>}</span>
        <span className="muted">{bytes(data.size)}</span>
        <span className="grow" />
        {data.text != null && previewable && (
          <div className="seg" role="group" aria-label="view mode">
            <button aria-pressed={mode === "read"} onClick={() => setMode("read")}>{ext === "json" ? "tokens" : "preview"}</button>
            <button aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>edit</button>
          </div>
        )}
        {dirty && <Button size="small" variant="ghost" onClick={() => setText(null)} disabled={saving}>discard</Button>}
      </div>
      <div className="file-body">
        {data.text != null ? (
          mode === "read" && previewable ? (
            ext === "md" || ext === "markdown" ? <div className="pad-x"><Markdown source={current} onLink={(h) => /^https?:/.test(h) && openUrl(h)} /></div> :
            ext === "json" ? <div className="pad-x"><TokensTable json={current} /></div> :
            ext === "svg" ? <SvgView text={current} name={baseName(path)} /> :
            <div className="pad-x fill"><HtmlPreview html={current} title={baseName(path)} /></div>
          ) : (
            <CodeEditor value={current} ext={ext} onChange={setText} onSave={save} label={`editing ${baseName(path)}`} />
          )
        ) : (
          <BinaryView path={path} data={data} />
        )}
      </div>
    </div>
  );
}

function SvgView({ text, name }: { text: string; name: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([text], { type: "image/svg+xml" })), [text]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <div className="pad-x fill"><ImageViewer src={url} alt={name} /></div>;
}

function BinaryView({ path, data }: { path: string; data: FileContent }) {
  const [bytesData, setBytes] = useState<Uint8Array | null>(null);
  const [mime, setMime] = useState(data.mime);
  const [err, setErr] = useState<unknown>(null);
  const kind = data.mime.startsWith("image/") ? "image" : data.mime === "application/pdf" || data.ext === "pdf" ? "pdf" : data.mime.startsWith("video/") || data.mime.startsWith("audio/") ? "media" : "other";
  useEffect(() => {
    if (kind === "other") return;
    call<{ mime: string; data: string }>("file.read_base64", { path }).then((r) => { setBytes(b64ToBytes(r.data)); setMime(r.mime); }).catch(setErr);
  }, [path]);
  const url = useMemo(() => (bytesData && kind !== "pdf" ? URL.createObjectURL(new Blob([bytesData as BlobPart], { type: mime })) : null), [bytesData]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (err) return <div className="pad-x"><ErrorState error={err} /></div>;
  if (kind === "other") {
    return (
      <div className="pad-x">
        <Empty title="no preview for this file" action={<Button onClick={async () => { const r = await call<{ path: string }>("file.abs", { path }); openPath(r.path); }}>open with the default app</Button>}>
          {data.mime} · {bytes(data.size)}
        </Empty>
      </div>
    );
  }
  if (!bytesData) return <div className="pad-x"><Loading /></div>;
  if (kind === "pdf") return <div className="pad-x scroll"><PdfViewer data={bytesData} /></div>;
  if (kind === "image") return <div className="pad-x fill"><ImageViewer src={url!} alt={baseName(path)} /></div>;
  return <div className="pad-x"><MediaViewer src={url!} mime={mime} /></div>;
}
