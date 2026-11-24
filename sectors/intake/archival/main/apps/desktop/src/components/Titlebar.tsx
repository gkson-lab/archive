import { useEffect, useState } from "react";
import { useApp } from "../state";
import { IconButton, ISearch, ISettings, IPanel, ISidebar, ISun, IMoon, IRefresh, Ring, Kbd } from "@archival/ui";
import { GkMark } from "./Marks";
import { mod } from "../platform";

export function Titlebar() {
  const { route, nav, item, setPalette, theme, setTheme, inspector, setInspector, sidebar, setSidebar, jobs, syncTick } = useApp();
  const crumbs = route.path ? route.path.split("/") : [];
  const running = jobs.filter((j) => j.status === "running");
  const progress = running.length ? running.reduce((a, j) => a + (j.total ? j.done / j.total : 0), 0) / running.length : 0;
  const [spin, setSpin] = useState(0);
  useEffect(() => { if (syncTick) setSpin((s) => s + 1); }, [syncTick]);
  const dark = theme === "dark" || (theme === "system" && !window.matchMedia("(prefers-color-scheme: light)").matches);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-left" data-tauri-drag-region>
        <IconButton label={sidebar ? "hide vault tree" : "show vault tree"} aria-pressed={sidebar} onClick={() => setSidebar(!sidebar)}>
          <ISidebar />
        </IconButton>
        <button className="tb-mark" onClick={() => nav({ view: "shelf", itemId: undefined, path: undefined })} aria-label="shelf">
          <GkMark size={18} />
        </button>
        <nav className="crumbs" aria-label="location">
          <button className="crumb root" onClick={() => nav({ view: "shelf", itemId: undefined, path: undefined })}>archival</button>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join("/");
            const last = i === crumbs.length - 1;
            return (
              <span key={p} className="crumb-wrap">
                <span className="sep" aria-hidden="true">/</span>
                {last ? <span className="crumb cur" aria-current="page">{c}</span> : (
                  <button className="crumb" onClick={() => (i === 0 ? nav({ view: c === "inbox" ? "inbox" : "files", path: undefined, itemId: undefined }) : nav({ view: "files", path: p, itemId: item?.id }))}>{c}</button>
                )}
              </span>
            );
          })}
          {!crumbs.length && route.view !== "shelf" && (<><span className="sep">/</span><span className="crumb cur">{route.view}</span></>)}
        </nav>
      </div>
      <div className="tb-right">
        <button className="tb-search" onClick={() => setPalette(true)} aria-label="search and commands">
          <ISearch size={14} />
          <span>search</span>
          <Kbd>{mod}</Kbd><Kbd>k</Kbd>
        </button>
        <span className="tb-activity" aria-live="polite">
          {running.length ? (
            <span className="tb-job" title={running.map((j) => j.label).join(", ")}>
              <Ring value={progress} chrome />
              <span className="tb-job-label">{running[0].total ? `${running[0].done} of ${running[0].total}` : running[0].label}</span>
            </span>
          ) : (
            <span key={spin} className={`tb-sync ${spin ? "turn" : ""}`} aria-label="idle"><IRefresh size={14} /></span>
          )}
        </span>
        <IconButton label={dark ? "print theme" : "chrome theme"} onClick={() => setTheme(dark ? "light" : "dark")}>
          {dark ? <ISun /> : <IMoon />}
        </IconButton>
        <IconButton label={inspector ? "hide inspector" : "show inspector"} aria-pressed={inspector} onClick={() => setInspector(!inspector)}>
          <IPanel />
        </IconButton>
        <IconButton label="settings" onClick={() => nav({ view: "settings" })}>
          <ISettings />
        </IconButton>
      </div>
    </header>
  );
}
