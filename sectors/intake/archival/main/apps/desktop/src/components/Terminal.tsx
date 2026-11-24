import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, b64ToBytes, type RunInfo } from "../api";

function theme() {
  const c = getComputedStyle(document.documentElement);
  const v = (n: string) => c.getPropertyValue(n).trim();
  return { background: v("--canvas"), foreground: v("--text"), cursor: v("--text"), cursorAccent: v("--canvas"), selectionBackground: "rgba(127,127,140,0.35)", black: v("--canvas"), brightBlack: v("--muted"), green: v("--add"), red: v("--del"), yellow: v("--warn"), blue: v("--accent"), white: v("--text") };
}

/** a pty-backed terminal: polls the run's output and forwards keystrokes */
export function Terminal({ runId, onInfo, interactive }: { runId: string; onInfo?: (i: RunInfo) => void; interactive: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onInfo);
  cb.current = onInfo;
  useEffect(() => {
    const term = new XTerm({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: false,
      convertEol: false,
      scrollback: 8000,
      theme: theme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    try { fit.fit(); } catch {}
    let since = 0;
    let alive = true;
    let ended = false;
    let timer: any;
    const poll = async () => {
      if (!alive) return;
      try {
        const r = await call<{ info: RunInfo; next: number; data: string }>("run.read", { run_id: runId, since });
        since = r.next;
        if (r.data) term.write(b64ToBytes(r.data));
        cb.current?.(r.info);
        ended = r.info.ended != null;
        timer = setTimeout(poll, r.data ? 40 : ended ? 1200 : 160);
      } catch {
        timer = setTimeout(poll, 1500);
      }
    };
    poll();
    const sub = term.onData((d) => { if (interactive || !ended) call("run.write", { run_id: runId, data: d }).catch(() => {}); });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        call("run.resize", { run_id: runId, cols: term.cols, rows: term.rows }).catch(() => {});
      } catch {}
    });
    ro.observe(host.current!);
    const mo = new MutationObserver(() => { term.options.theme = theme(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (interactive) term.focus();
    return () => {
      alive = false;
      clearTimeout(timer);
      sub.dispose();
      ro.disconnect();
      mo.disconnect();
      term.dispose();
    };
  }, [runId]);
  return <div className="terminal" ref={host} role="region" aria-label="terminal output" />;
}

/** a terminal that only shows text written by the app (wasm runs) */
export function OutputTerminal({ feed }: { feed: (write: (s: string) => void) => () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new XTerm({ fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace', fontSize: 13, convertEol: true, theme: theme(), disableStdin: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    try { fit.fit(); } catch {}
    const stop = feed((s) => term.write(s));
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host.current!);
    return () => { stop(); ro.disconnect(); term.dispose(); };
  }, [feed]);
  return <div className="terminal" ref={host} role="region" aria-label="output" />;
}
