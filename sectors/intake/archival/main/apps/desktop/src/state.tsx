import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { call, type Item, type Job } from "./api";
import { errText } from "@archival/ui";

export type View = "shelf" | "files" | "run" | "git" | "connectors" | "inbox" | "settings" | "trash";
export type Route = { view: View; itemId?: string; path?: string };

export type Primary = { label: string; onClick: () => void; disabled?: boolean; busy?: boolean; href?: string; shine?: number; chip?: boolean } | null;

type Toast = { id: number; text: string; kind: "info" | "error"; action?: { label: string; run: () => void } };

type Ctx = {
  route: Route;
  nav: (r: Partial<Route> & { view?: View }) => void;
  item: Item | null;
  setItem: (i: Item | null) => void;
  version: number;
  bump: () => void;
  toast: (text: string, kind?: "info" | "error", action?: Toast["action"]) => void;
  fail: (e: unknown) => void;
  toasts: Toast[];
  dismiss: (id: number) => void;
  jobs: Job[];
  track: (jobId: string, onDone?: (j: Job) => void) => void;
  theme: "system" | "dark" | "light";
  setTheme: (t: "system" | "dark" | "light") => void;
  inspector: boolean;
  setInspector: (v: boolean) => void;
  sidebar: boolean;
  setSidebar: (v: boolean) => void;
  primary: Primary;
  setPrimary: (p: Primary) => void;
  palette: boolean;
  setPalette: (v: boolean) => void;
  syncTick: number;
};

const C = createContext<Ctx | null>(null);

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => load("archival.route", { view: "shelf" } as Route));
  const [item, setItem] = useState<Item | null>(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [theme, setThemeS] = useState<"system" | "dark" | "light">(() => load("archival.theme", "system"));
  const [inspector, setInspectorS] = useState<boolean>(() => load("archival.inspector", false));
  const [sidebar, setSidebar] = useState<boolean>(() => (typeof window !== "undefined" ? window.innerWidth > 760 : true));
  const [primary, setPrimary] = useState<Primary>(null);
  const [palette, setPalette] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const watchers = useRef(new Map<string, (j: Job) => void>());
  const tid = useRef(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((text: string, kind: "info" | "error" = "info", action?: Toast["action"]) => {
    const id = ++tid.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind, action }]);
    setTimeout(() => dismiss(id), kind === "error" ? 9000 : 4500);
  }, [dismiss]);
  const fail = useCallback((e: unknown) => toast(errText(e), "error"), [toast]);

  const nav = useCallback((r: Partial<Route>) => {
    setRoute((cur) => {
      const next = { ...cur, ...r } as Route;
      save("archival.route", next);
      return next;
    });
    if (window.innerWidth <= 760) setSidebar(false);
  }, []);

  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    save("archival.theme", theme);
  }, [theme]);

  // keep the selected item in sync with the route
  useEffect(() => {
    if (!route.itemId) {
      setItem(null);
      return;
    }
    call<Item>("item.get", { id: route.itemId }).then(setItem).catch(() => {
      setItem(null);
      nav({ itemId: undefined, path: undefined });
    });
  }, [route.itemId, version]);

  // job polling, only while something is running
  const track = useCallback((jobId: string, onDone?: (j: Job) => void) => {
    if (onDone) watchers.current.set(jobId, onDone);
    setJobs((js) => (js.some((j) => j.id === jobId) ? js : [...js, { id: jobId, kind: "", label: "working", done: 0, total: 0, status: "running", error: null, result: null, steps: [], started: Date.now() }]));
  }, []);
  const running = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const tick = async () => {
      try {
        const all = await call<Job[]>("jobs.list");
        if (!alive) return;
        setJobs((prev) => {
          const mine = new Set(prev.map((p) => p.id));
          const next = all.filter((j) => mine.has(j.id));
          for (const j of next) {
            const was = prev.find((p) => p.id === j.id);
            if (was?.status === "running" && j.status !== "running") {
              const cb = watchers.current.get(j.id);
              watchers.current.delete(j.id);
              if (j.status === "error") toast(j.error ?? "that didn't work", "error");
              cb?.(j);
              setSyncTick((t) => t + 1);
              setTimeout(bump, 0);
              setTimeout(() => call("jobs.dismiss", { id: j.id }).catch(() => {}), 4000);
            }
          }
          return next.filter((j) => j.status === "running" || Date.now() - j.started < 60000);
        });
      } catch {}
    };
    const h = setInterval(tick, 350);
    tick();
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  const value = useMemo<Ctx>(
    () => ({
      route, nav, item, setItem, version, bump, toast, fail, toasts, dismiss, jobs, track,
      theme, setTheme: setThemeS,
      inspector, setInspector: (v: boolean) => { setInspectorS(v); save("archival.inspector", v); },
      sidebar, setSidebar, primary, setPrimary, palette, setPalette, syncTick,
    }),
    [route, item, version, toasts, jobs, theme, inspector, sidebar, primary, palette, syncTick],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(C);
  if (!c) throw new Error("no app context");
  return c;
}

/** fetch with loading / error / reload. refetches when the app version bumps. */
export function useCall<T>(method: string | null, params: Record<string, unknown> = {}, deps: unknown[] = []) {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!method);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!method) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    call<T>(method, params)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [method, version, n, ...deps]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}

/** a view declares its one primary action; the dock renders it */
export function usePrimary(p: Primary | undefined, deps: unknown[]) {
  const { setPrimary } = useApp();
  useEffect(() => {
    // undefined = a child view owns the primary action right now
    if (p !== undefined) setPrimary(p);
  }, deps);
  useEffect(() => () => setPrimary(null), []);
}
