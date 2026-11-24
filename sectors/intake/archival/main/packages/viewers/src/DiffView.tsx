export type DiffLine = { origin: string; old: number | null; new: number | null; text: string };
export type Hunk = { header: string; lines: DiffLine[] };
export type FileDiff = { path: string; status: string; binary: boolean; hunks: Hunk[] };

/** unified diff. changed lines arrive in the line colour and settle into their state colour. */
export function DiffView({ diff }: { diff: FileDiff[] }) {
  if (!diff.length) return <p className="muted" style={{ padding: 16 }}>no changes in this file.</p>;
  return (
    <div className="diff" role="region" aria-label="changes">
      {diff.map((f) => (
        <section key={f.path} className="diff-file">
          <header className="diff-head mono">
            <span>{f.path}</span>
            <span className="muted">{f.status}</span>
          </header>
          {f.binary && <p className="muted" style={{ padding: "8px 12px" }}>binary file changed</p>}
          {f.hunks.map((h, i) => (
            <div key={i} className="diff-hunk">
              <div className="diff-hh mono muted">{h.header}</div>
              {h.lines.map((l, j) => (
                <div key={j} className={`diff-line ${l.origin === "+" ? "add" : l.origin === "-" ? "del" : ""}`} style={{ animationDelay: `${Math.min(j, 30) * 6}ms` }}>
                  <span className="ln">{l.old ?? ""}</span>
                  <span className="ln">{l.new ?? ""}</span>
                  <span className="sig" aria-hidden="true">{l.origin === " " ? "" : l.origin}</span>
                  <span className="sr-only">{l.origin === "+" ? "added" : l.origin === "-" ? "removed" : ""}</span>
                  <code>{l.text || " "}</code>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
