import { useEffect, useState } from "react";
import { call } from "../api";
import { useApp, useCall, usePrimary } from "../state";
import { Button, Field, Switch, ErrorState, Loading, IconButton, ITrash } from "@archival/ui";
import { LiquidMark } from "../components/Marks";
import { bytes } from "../util";
import { openUrl, pickPaths, reveal } from "../platform";

type Stats = { root: string; items: number; inbox: number; snapshots: number; object_bytes: number; trash: number };
type Account = { account: { login: string; name: string | null; email: string; avatar_url: string | null }; default: boolean; token: boolean };

export function Settings() {
  const { theme, setTheme, nav } = useApp();
  usePrimary(null, []);
  const sections = ["vault", "appearance", "accounts", "run", "assistant", "agents", "about"];
  return (
    <div className="view pad settings">
      <h1 className="view-title">settings</h1>
      <nav className="settings-nav" aria-label="settings sections">
        {sections.map((s) => <a key={s} href={`#s-${s}`} onClick={(e) => { e.preventDefault(); document.getElementById(`s-${s}`)?.scrollIntoView({ behavior: "smooth" }); }}>{s}</a>)}
      </nav>
      <VaultSection />
      <section id="s-appearance" className="set">
        <h2>appearance</h2>
        <div className="seg" role="radiogroup" aria-label="theme">
          {(["system", "dark", "light"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} onClick={() => setTheme(t)}>{t === "dark" ? "chrome" : t === "light" ? "print" : "system"}</button>
          ))}
        </div>
        <p className="muted small">chrome is liquid metal on near-black. print is ink on paper.</p>
      </section>
      <Accounts />
      <RunSection />
      <Assistant />
      <Agents />
      <section id="s-about" className="set about">
        <LiquidMark size={140} />
        <div>
          <h2>archival</h2>
          <p className="muted">a gk labs tool.</p>
          <About />
          <Button size="small" variant="ghost" onClick={() => nav({ view: "trash" })}>open trash</Button>
        </div>
      </section>
    </div>
  );
}

function About() {
  const { data } = useCall<{ version: string; os: string; arch: string }>("app.info");
  return data ? <p className="muted small">version {data.version} · {data.os} {data.arch}</p> : null;
}

function VaultSection() {
  const { fail, toast, bump } = useApp();
  const stats = useCall<Stats>("vault.info");
  const settings = useCall<Record<string, any>>("settings.get");
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => { if (settings.data) setDays(settings.data["trash.retention_days"] ?? 30); }, [settings.data]);
  return (
    <section id="s-vault" className="set">
      <h2>vault</h2>
      {stats.loading && !stats.data && <Loading lines={2} />}
      {!!stats.error && <ErrorState error={stats.error} onRetry={stats.reload} />}
      {stats.data && (
        <>
          <p><span className="mono">{stats.data.root}</span></p>
          <p className="muted small">{stats.data.items} items · {stats.data.snapshots} snapshots · {bytes(stats.data.object_bytes)} of history · {stats.data.trash} in trash</p>
          <div className="row gap wrap">
            <Button size="small" onClick={() => reveal(stats.data!.root)}>show in folder</Button>
            <Button size="small" onClick={async () => {
              const p = (await pickPaths({ directory: true, title: "pick or create a vault folder" }))?.[0] ?? prompt("vault folder path");
              if (!p) return;
              try { await call("vault.switch", { root: p }); toast(`using the vault at ${p}`); bump(); stats.reload(); } catch (e) { fail(e); }
            }}>use another vault</Button>
            <Button size="small" variant="ghost" onClick={async () => { try { const r = await call<{ added: number; removed: number }>("vault.rebuild"); toast(`index rebuilt: ${r.added} added, ${r.removed} removed`); bump(); } catch (e) { fail(e); } }}>rebuild index</Button>
          </div>
        </>
      )}
      {days != null && (
        <Field label="keep trash for (days)">
          <input className="input narrow" type="number" min={1} max={365} value={days} onChange={(e) => setDays(+e.target.value)} onBlur={() => call("settings.set", { key: "trash.retention_days", value: days }).catch(fail)} />
        </Field>
      )}
    </section>
  );
}

function Accounts() {
  const { fail, toast } = useApp();
  const acc = useCall<Account[]>("github.accounts");
  const dev = useCall<{ available: boolean }>("github.device_available");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{ user_code: string; verification_uri: string; device_code: string; interval: number } | null>(null);
  const add = async () => {
    setBusy(true);
    try { const a = await call<{ login: string }>("github.add_token", { token }); setToken(""); toast(`signed in as ${a.login}`); acc.reload(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!device) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await call<any>("github.device_poll", { device_code: device.device_code });
        if (!alive) return;
        if (r.account) { toast(`signed in as ${r.account.login}`); setDevice(null); acc.reload(); return; }
        setTimeout(tick, Math.max(5, device.interval) * 1000);
      } catch (e) { fail(e); setDevice(null); }
    };
    const h = setTimeout(tick, Math.max(5, device.interval) * 1000);
    return () => { alive = false; clearTimeout(h); };
  }, [device?.device_code]);
  return (
    <section id="s-accounts" className="set">
      <h2>accounts</h2>
      {!!acc.error && <ErrorState error={acc.error} onRetry={acc.reload} />}
      {acc.data?.length ? (
        <ul className="rows">
          {acc.data.map((a) => (
            <li key={a.account.login}>
              <div className="row-btn">
                {a.account.avatar_url ? <img className="avatar" src={a.account.avatar_url} alt="" /> : null}
                <span className="grow"><span>{a.account.login}</span><span className="muted small block">commits as {a.account.name ?? a.account.login} &lt;{a.account.email}&gt;{a.token ? "" : " · token missing, sign in again"}</span></span>
                {a.default ? <span className="tag">default</span> : <Button size="small" variant="ghost" onClick={() => call("github.set_default", { login: a.account.login }).then(acc.reload).catch(fail)}>make default</Button>}
                <IconButton label={`sign out ${a.account.login}`} onClick={() => call("github.remove", { login: a.account.login }).then(acc.reload).catch(fail)}><ITrash size={15} /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted">no github accounts yet. you need one to publish repos and open pull requests.</p>}
      {device ? (
        <div className="note">
          enter <b className="mono code-big">{device.user_code}</b> at <button className="link-btn" onClick={() => openUrl(device.verification_uri)}>{device.verification_uri}</button>. this page updates when you approve.
        </div>
      ) : (
        <form className="row gap wrap" onSubmit={(e) => { e.preventDefault(); if (token.trim()) add(); }}>
          <Field label="github token (repo, gist and read:user scopes)" hint="saved in the os keychain">
            <input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_…" />
          </Field>
          <div className="row gap end">
            <Button type="submit" disabled={!token.trim() || busy}>{busy ? "checking" : "sign in"}</Button>
            {dev.data?.available && <Button variant="ghost" onClick={async () => { try { setDevice(await call("github.device_start")); } catch (e) { fail(e); } }}>sign in with a code</Button>}
            <Button variant="ghost" onClick={() => openUrl("https://github.com/settings/tokens/new?scopes=repo,gist,read:user&description=archival")}>make a token</Button>
          </div>
        </form>
      )}
    </section>
  );
}

function RunSection() {
  const { fail } = useApp();
  const s = useCall<Record<string, any>>("settings.get");
  if (!s.data) return null;
  return (
    <section id="s-run" className="set">
      <h2>run</h2>
      <p className="muted small">imported code always shows its commands before the first run. missing toolchains are fetched by mise into the vault, never the system.</p>
      <Switch label="container runs have network by default" checked={s.data["run.container_network"] ?? true} onChange={(v) => call("settings.set", { key: "run.container_network", value: v }).then(s.reload).catch(fail)} />
    </section>
  );
}

function Assistant() {
  const { fail, toast } = useApp();
  const st = useCall<{ enabled: boolean; base_url: string | null; model: string | null; key: boolean }>("assistant.status");
  const [base, setBase] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  useEffect(() => { if (st.data) { setBase(st.data.base_url ?? ""); setModel(st.data.model ?? ""); } }, [st.data]);
  if (!st.data) return null;
  return (
    <section id="s-assistant" className="set">
      <h2>assistant</h2>
      <p className="muted small">off by default. when on, it suggests commit messages and pull request descriptions. bring your own provider: any openai-compatible chat completions endpoint.</p>
      <Switch label="assistant on" checked={st.data.enabled} onChange={async (v) => {
        try {
          if (v) await call("assistant.configure", { base_url: base || undefined, model: model || undefined });
          else await call("assistant.disable");
          st.reload();
        } catch (e) { fail(e); }
      }} />
      {st.data.enabled && (
        <form className="form" onSubmit={async (e) => { e.preventDefault(); try { await call("assistant.configure", { base_url: base, model, key: key || undefined }); setKey(""); toast("assistant saved"); st.reload(); } catch (er) { fail(er); } }}>
          <Field label="endpoint"><input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1" /></Field>
          <Field label="model"><input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model name" /></Field>
          <Field label={st.data.key ? "api key (saved, enter to replace)" : "api key"} hint="saved in the os keychain"><input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></Field>
          <Button type="submit" size="small">save</Button>
        </form>
      )}
    </section>
  );
}

function Agents() {
  const { toast } = useApp();
  const { data } = useCall<{ command: string; args: string[]; config: any; add_command: string; tools: string[] }>("mcp.info");
  if (!data) return null;
  const json = JSON.stringify(data.config, null, 2);
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); toast("copied"); } catch { toast("couldn't copy. select the text instead", "error"); } };
  return (
    <section id="s-agents" className="set">
      <h2>agents</h2>
      <p className="muted small">archival runs an mcp server so coding agents can search, read and write the vault. every agent write is snapshotted first, so you can undo it from the item's history.</p>
      <Field label="add to an agent that reads mcp json config">
        <pre className="cmds">{json}</pre>
      </Field>
      <div className="row gap wrap">
        <Button size="small" onClick={() => copy(json)}>copy config</Button>
        <Button size="small" variant="ghost" onClick={() => copy(`${data.command} ${data.args.join(" ")}`)}>copy command</Button>
      </div>
      <p className="muted small">tools: {data.tools.join(", ")}</p>
    </section>
  );
}
