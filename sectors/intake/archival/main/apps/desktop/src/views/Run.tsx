import { useCallback, useEffect, useMemo, useState } from "react";
import { call, type RunInfo } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Button, Dialog, Empty, ErrorState, Loading, Switch, IconButton, IRefresh, IExternal, ITerminal, IX } from "@archival/ui";
import { Terminal, OutputTerminal } from "../components/Terminal";
import { StatusDot } from "../components/StatusDot";
import { openUrl } from "../platform";
import { runWasm } from "../wasm";

type Candidate = { label: string; command: string; setup: string | null; tool: string | null; source: string };
type Tool = { tool: string; installed: boolean; version: string | null; via_mise: boolean };
type Detection = { candidates: Candidate[]; tools: Tool[]; container: { engine: string | null; image: string; from_devcontainer: boolean } | null; wasm: string | null; mise: boolean };
type DetectResult = { detection: Detection; saved: { command: string | null; setup: string | null; mode: string | null }; trusted: boolean; origin: string };

export function Run() {
  const { item, route } = useApp();
  if (!item) return <NoItem />;
  return <RunItem key={item.id + (route.itemId ?? "")} />;
}

function NoItem() {
  const { nav, fail } = useApp();
  const runs = useCall<RunInfo[]>("run.list");
  const [term, setTerm] = useState<string | null>(null);
  usePrimary({ label: "open a terminal", onClick: async () => { try { const r = await call<RunInfo>("run.terminal", { cols: 100, rows: 30 }); setTerm(r.id); } catch (e) { fail(e); } } }, []);
  return (
    <div className="view pad run-view">
      <h1 className="view-title">run</h1>
      {term ? <div className="term-wrap tall"><Terminal runId={term} interactive /></div> : (
        <Empty title="pick a project to run">choose one in the tree. archival works out how to run it.</Empty>
      )}
      {!!runs.data?.length && (
        <section className="group">
          <h2 className="row-h">running</h2>
          <ul className="rows">
            {runs.data.map((r) => (
              <li key={r.id}><button className="row-btn" onClick={() => r.item_id && nav({ itemId: r.item_id })}><StatusDot status={r.status} /><span className="grow mono">{r.label}</span><span className="muted">{r.status}</span></button></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RunItem() {
  const app = useApp();
  const { item, fail, bump } = app;
  const det = useCall<DetectResult>("run.detect", { item_id: item!.id }, [item!.id]);
  const runs = useCall<RunInfo[]>("run.list");
  const mine = useMemo(() => (runs.data ?? []).filter((r) => r.item_id === item!.id), [runs.data, item!.id]);
  const [active, setActive] = useState<string | null>(null);
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [command, setCommand] = useState("");
  const [custom, setCustom] = useState(false);
  const [mode, setMode] = useState<"local" | "container" | "wasm">("local");
  const [setup, setSetup] = useState(false);
  const [network, setNetwork] = useState(true);
  const [env, setEnv] = useState("");
  const [confirm, setConfirm] = useState<{ commands: string[]; mode: string; cwd: string } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [wasmFeed, setWasmFeed] = useState<null | ((w: (s: string) => void) => () => void)>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!det.data) return;
    const d = det.data;
    const saved = d.saved.command;
    setCommand(saved ?? d.detection.candidates[0]?.command ?? "");
    setCustom(!!saved && !d.detection.candidates.some((c) => c.command === saved));
    setMode(((d.saved.mode as any) ?? "local") === "container" ? "container" : "local");
  }, [det.data]);
  useEffect(() => {
    if (active || !mine.length) return;
    const live = [...mine].reverse().find((r) => r.ended == null) ?? mine[mine.length - 1];
    setActive(live.id);
  }, [mine.length]);
  useEffect(() => {
    if (info?.ports.length && preview == null) setPreview(info.ports[0]);
  }, [info?.ports.join()]);

  const candidate = det.data?.detection.candidates.find((c) => c.command === command);
  const setupCmd = candidate?.setup ?? det.data?.saved.setup ?? null;
  const running = info && info.ended == null && !info.interactive;

  const parseEnv = () => Object.fromEntries(env.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

  const start = useCallback(async (ok = false) => {
    if (!item) return;
    if (mode === "wasm") {
      const lang = det.data?.detection.wasm as "js" | "python";
      try {
        const f = await call<{ text: string }>("file.read", { path: item.path });
        setActive(null);
        setWasmFeed(() => (write: (s: string) => void) => {
          write(`\x1b[2m${lang} · running in webassembly, no files touched\x1b[0m\r\n`);
          const r = runWasm(lang, f.text, (s, err) => write(err ? `\x1b[31m${s}\x1b[0m` : s), (code) => write(`\r\n\x1b[2mexited ${code}\x1b[0m\r\n`));
          return () => r.stop();
        });
      } catch (e) { fail(e); }
      return;
    }
    if (!command.trim()) return;
    setStarting(true);
    try {
      const r = await call<any>("run.start", { item_id: item.id, command, mode, with_setup: setup, setup: setupCmd, confirm: ok, no_network: !network, env: parseEnv(), cols: 100, rows: 30, ports: info?.ports ?? [] });
      if (r.needs_confirm) { setConfirm(r); return; }
      setConfirm(null);
      setWasmFeed(null);
      setActive(r.id);
      setPreview(null);
      runs.reload();
      if (ok) bump();
    } catch (e) { fail(e); }
    finally { setStarting(false); }
  }, [item?.id, command, mode, setup, setupCmd, network, env, det.data]);

  const stop = async () => {
    if (!active) return;
    try { await call("run.stop", { run_id: active }); runs.reload(); } catch (e) { fail(e); }
  };
  const terminal = async () => {
    try { const r = await call<RunInfo>("run.terminal", { item_id: item!.id, cols: 100, rows: 30 }); setActive(r.id); setWasmFeed(null); runs.reload(); } catch (e) { fail(e); }
  };

  usePrimary(running ? { label: "stop", onClick: stop } : { label: starting ? "starting" : "run", onClick: () => start(false), disabled: starting || (mode !== "wasm" && !command.trim()), busy: starting }, [running, starting, command, mode, setup, network, env, active]);

  if (det.loading && !det.data) return <div className="view pad"><Loading /></div>;
  if (det.error) return <div className="view pad"><ErrorState error={det.error} onRetry={det.reload} /></div>;
  const d = det.data!.detection;
  const missing = d.tools.filter((t) => !t.installed);

  return (
    <div className="view run-view">
      <div className="run-grid">
        <section className="run-setup" aria-label="how to run">
          <h1 className="view-title sm">{item!.title.toLowerCase()}</h1>
          <div className="seg" role="radiogroup" aria-label="run mode">
            <button role="radio" aria-checked={mode === "local"} onClick={() => setMode("local")}>local</button>
            <button role="radio" aria-checked={mode === "container"} onClick={() => setMode("container")} disabled={!d.container}>container</button>
            {d.wasm && <button role="radio" aria-checked={mode === "wasm"} onClick={() => setMode("wasm")}>wasm</button>}
          </div>
          {mode !== "wasm" && (
            <fieldset className="cands">
              <legend className="muted">command</legend>
              {d.candidates.length === 0 && <p className="muted">couldn't find how to run this. type a command.</p>}
              {d.candidates.map((c) => (
                <label key={c.command} className={`cand ${!custom && command === c.command ? "on" : ""}`}>
                  <input type="radio" name="cmd" checked={!custom && command === c.command} onChange={() => { setCustom(false); setCommand(c.command); }} />
                  <span className="mono">{c.command}</span>
                  <span className="muted small">{c.source}</span>
                </label>
              ))}
              <label className={`cand ${custom ? "on" : ""}`}>
                <input type="radio" name="cmd" checked={custom} onChange={() => { setCustom(true); }} />
                <input className="input mono" placeholder="another command" value={custom ? command : ""} onFocus={() => setCustom(true)} onChange={(e) => { setCustom(true); setCommand(e.target.value); }} aria-label="custom command" />
              </label>
            </fieldset>
          )}
          {mode !== "wasm" && setupCmd && <Switch label={`install first: ${setupCmd}`} checked={setup} onChange={setSetup} />}
          {mode === "local" && missing.length > 0 && (
            <p className="note">
              {missing.map((t) => t.tool).join(", ")} {missing.length === 1 ? "isn't" : "aren't"} installed.{" "}
              {d.mise ? "archival will fetch a pinned version with mise into the vault, not the system." : "install it, or install mise and archival fetches a pinned version per project."}
            </p>
          )}
          {mode === "container" && d.container && (
            <p className="muted small">{d.container.engine ? `${d.container.engine} · ${d.container.image}` : "needs docker or podman"}{d.container.from_devcontainer ? " · from devcontainer.json" : ""}</p>
          )}
          <details className="more">
            <summary>more</summary>
            <label className="field"><span>environment (KEY=value, one per line)</span><textarea className="textarea mono" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="PORT=3000" /></label>
            {mode === "container" && <Switch label="allow network in the container" checked={network} onChange={setNetwork} />}
            <Button size="small" onClick={terminal}><ITerminal size={14} /> open a terminal here</Button>
          </details>
        </section>

        <section className="run-out" aria-label="output">
          {(mine.length > 0 || wasmFeed) && (
            <div className="run-tabs" role="tablist" aria-label="runs">
              {mine.map((r) => (
                <div key={r.id} className={`run-tab ${active === r.id && !wasmFeed ? "on" : ""}`}>
                  <button role="tab" aria-selected={active === r.id && !wasmFeed} onClick={() => { setActive(r.id); setWasmFeed(null); }}>
                    <StatusDot status={r.id === active && info ? info.status : r.status} /> <span className="mono">{r.label}</span>
                  </button>
                  {r.ended != null && <IconButton label="close" onClick={async () => { await call("run.remove", { run_id: r.id }).catch(() => {}); if (active === r.id) setActive(null); runs.reload(); }}><IX size={12} /></IconButton>}
                </div>
              ))}
              {wasmFeed && <div className="run-tab on"><button role="tab" aria-selected>wasm</button></div>}
            </div>
          )}
          <div className={`run-body ${preview != null && info?.ports.length ? "split" : ""}`}>
            <div className="term-wrap">
              {wasmFeed ? <OutputTerminal feed={wasmFeed} /> : active ? <Terminal key={active} runId={active} interactive={!!mine.find((r) => r.id === active)?.interactive} onInfo={setInfo} /> : (
                <div className="term-empty"><p className="muted">press run. output shows up here{d.candidates[0] ? `, starting with ${command || d.candidates[0].command}` : ""}.</p></div>
              )}
            </div>
            {preview != null && !!info?.ports.length && (
              <div className="preview">
                <div className="preview-bar">
                  <select className="select small" value={preview} onChange={(e) => setPreview(+e.target.value)} aria-label="port">
                    {info.ports.map((p) => <option key={p} value={p}>localhost:{p}</option>)}
                  </select>
                  <span className="grow" />
                  <IconButton label="reload preview" onClick={() => setFrameKey((k) => k + 1)}><IRefresh size={14} /></IconButton>
                  <IconButton label="open in browser" onClick={() => openUrl(`http://localhost:${preview}`)}><IExternal size={14} /></IconButton>
                  <IconButton label="close preview" onClick={() => setPreview(null)}><IX size={14} /></IconButton>
                </div>
                <iframe key={frameKey} title="preview" src={`http://localhost:${preview}`} className="preview-frame" />
              </div>
            )}
          </div>
        </section>
      </div>

      {confirm && (
        <Dialog
          title="run this for the first time?"
          onClose={() => setConfirm(null)}
          footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>cancel</Button><Button onClick={() => start(true)}>run it</Button></>}
        >
          <p className="muted">this came from {det.data!.origin}. archival never runs imported code on its own. it will run, in {confirm.cwd}:</p>
          <pre className="cmds">{confirm.commands.join("\n")}</pre>
          <p className="muted small">mode: {confirm.mode}. you won't be asked again for this item.</p>
        </Dialog>
      )}
    </div>
  );
}
