import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

export function Markdown({ source, onLink }: { source: string; onLink?: (href: string) => void }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }) as string), [source]);
  return (
    <article
      className="prose"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a && onLink) {
          e.preventDefault();
          onLink(a.getAttribute("href") || "");
        }
      }}
    />
  );
}

/** images and svgs: wheel or buttons to zoom, drag to pan, fit resets */
export function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const [z, setZ] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  return (
    <div className="image-viewer">
      <div className="iv-tools">
        <button className="btn small ghost" onClick={() => setZ((v) => Math.max(0.1, v / 1.25))} aria-label="zoom out">−</button>
        <span className="mono muted">{Math.round(z * 100)}%</span>
        <button className="btn small ghost" onClick={() => setZ((v) => Math.min(16, v * 1.25))} aria-label="zoom in">+</button>
        <button className="btn small ghost" onClick={() => { setZ(1); setPan({ x: 0, y: 0 }); }}>fit</button>
      </div>
      <div
        className="iv-stage"
        onWheel={(e) => { if (e.ctrlKey || e.metaKey || e.altKey) { e.preventDefault(); setZ((v) => Math.min(16, Math.max(0.1, v * (e.deltaY < 0 ? 1.1 : 0.9)))); } }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; }}
        onPointerMove={(e) => drag.current && setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y })}
        onPointerUp={() => (drag.current = null)}
      >
        <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${z})` }} />
      </div>
    </div>
  );
}

/** before / after slider for two versions of a design */
export function CompareView({ before, after, labels = ["before", "after"] }: { before: string; after: string; labels?: [string, string] }) {
  const [x, setX] = useState(50);
  return (
    <div className="compare">
      <div className="compare-stage">
        <img src={after} alt={labels[1]} />
        <div className="compare-before" style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }}>
          <img src={before} alt={labels[0]} />
        </div>
        <div className="compare-line" style={{ left: `${x}%` }} aria-hidden="true" />
      </div>
      <label className="compare-range">
        <span className="muted">{labels[0]}</span>
        <input type="range" min={0} max={100} value={x} onChange={(e) => setX(+e.target.value)} aria-label="compare position" />
        <span className="muted">{labels[1]}</span>
      </label>
    </div>
  );
}

type Tok = { path: string; value: string; type?: string };

function flatten(obj: any, prefix: string[] = [], out: Tok[] = []): Tok[] {
  if (obj && typeof obj === "object") {
    if ("$value" in obj || "value" in obj && typeof obj.value !== "object") {
      out.push({ path: prefix.join("."), value: String(obj.$value ?? obj.value), type: obj.$type ?? obj.type });
      return out;
    }
    for (const [k, v] of Object.entries(obj)) if (!k.startsWith("$")) flatten(v, [...prefix, k], out);
  } else if (typeof obj === "string" || typeof obj === "number") {
    out.push({ path: prefix.join("."), value: String(obj) });
  }
  return out;
}

const isColor = (v: string) => /^#([0-9a-f]{3,8})$/i.test(v) || /^(rgb|hsl|oklch|color)\(/i.test(v);

export function TokensTable({ json }: { json: string }) {
  const rows = useMemo(() => {
    try { return flatten(JSON.parse(json)); } catch { return null; }
  }, [json]);
  if (!rows) return <p className="muted">this json couldn't be read as design tokens.</p>;
  return (
    <table className="tokens">
      <thead><tr><th scope="col">token</th><th scope="col">value</th><th scope="col">type</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.path}>
            <td className="mono">{r.path}</td>
            <td>
              <span className="tok-val">
                {isColor(r.value) && <span className="swatch" style={{ background: r.value }} aria-hidden="true" />}
                <span className="mono">{r.value}</span>
              </span>
            </td>
            <td className="muted">{r.type ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** pdf pages rendered lazily to canvas */
export function PdfViewer({ data }: { data: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let doc: any;
    (async () => {
      try {
        const pdfjs: any = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        doc = await pdfjs.getDocument({ data: data.slice() }).promise;
        if (cancelled) return;
        setPages(doc.numPages);
        const el = host.current!;
        el.innerHTML = "";
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const c = e.target as HTMLCanvasElement;
            if (c.dataset.done) continue;
            c.dataset.done = "1";
            io.unobserve(c);
            doc.getPage(+c.dataset.page!).then((pg: any) => {
              const vp = pg.getViewport({ scale: 1.5 });
              c.width = vp.width; c.height = vp.height;
              c.style.aspectRatio = `${vp.width} / ${vp.height}`;
              pg.render({ canvasContext: c.getContext("2d"), viewport: vp, canvas: c });
            });
          }
        }, { root: el.parentElement, rootMargin: "400px" });
        for (let i = 1; i <= doc.numPages; i++) {
          const c = document.createElement("canvas");
          c.dataset.page = String(i);
          c.setAttribute("role", "img");
          c.setAttribute("aria-label", `page ${i}`);
          el.appendChild(c);
          io.observe(c);
        }
      } catch (e: any) {
        setErr(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; doc?.destroy?.(); };
  }, [data]);
  if (err) return <p className="muted">couldn't open this pdf: {err}</p>;
  return (
    <div className="pdf">
      {pages > 0 && <p className="muted pdf-count">{pages} page{pages === 1 ? "" : "s"}</p>}
      <div ref={host} className="pdf-pages" />
    </div>
  );
}

export function MediaViewer({ src, mime }: { src: string; mime: string }) {
  if (mime.startsWith("video/")) return <video className="media" src={src} controls preload="metadata" />;
  if (mime.startsWith("audio/")) return <audio className="media" src={src} controls preload="metadata" />;
  return null;
}

/** html files preview in a locked-down frame: scripts only, no same-origin access */
export function HtmlPreview({ html, title }: { html: string; title: string }) {
  return <iframe className="html-preview" title={title} sandbox="allow-scripts" srcDoc={html} />;
}

export type LinkData = { url: string; title?: string; description?: string; thumbnail?: string | null; fetched?: string };

export function LinkCard({ link, thumbSrc, onOpen }: { link: LinkData; thumbSrc?: string; onOpen: (url: string) => void }) {
  let host = link.url;
  try { host = new URL(link.url).host; } catch {}
  return (
    <div className="link-card">
      {thumbSrc && <img src={thumbSrc} alt="" className="link-thumb" />}
      <div className="link-body">
        <p className="muted mono">{host}</p>
        <h2>{(link.title ?? host).toLowerCase()}</h2>
        {link.description && <p>{link.description}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <a className="btn" href={link.url} onClick={(e) => { e.preventDefault(); onOpen(link.url); }}>open {host}</a>
          {link.fetched && <span className="muted" style={{ alignSelf: "center" }}>saved {new Date(link.fetched).toLocaleDateString()}</span>}
        </div>
      </div>
    </div>
  );
}
