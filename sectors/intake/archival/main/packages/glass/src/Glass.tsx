import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { displacementMap, supportsLens } from "./lens";

let uid = 0;

/** the svg filter for one lens size. the backdrop is flattened onto the canvas colour first,
 * otherwise translucent glass turns grey. */
export function LensFilter({ id, w, h, base }: { id: string; w: number; h: number; base: string }) {
  const map = useMemo(() => (w > 0 && h > 0 ? displacementMap(Math.round(w), Math.round(h)) : ""), [w, h]);
  if (!map) return null;
  const pass = (scale: number, keep: "r" | "g" | "b", out: string) => {
    const m = { r: "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0", g: "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0", b: "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" }[keep];
    return (
      <>
        <feDisplacementMap in="flat" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="G" result={`${out}d`} />
        <feColorMatrix in={`${out}d`} type="matrix" values={m} result={out} />
      </>
    );
  };
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id={id} x="0" y="0" width={w} height={h} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feFlood floodColor={base} result="base" />
        <feComposite in="SourceGraphic" in2="base" operator="over" result="flat" />
        <feImage href={map} x="0" y="0" width={w} height={h} preserveAspectRatio="none" result="map" />
        {pass(30, "r", "rr")}
        {pass(27, "g", "gg")}
        {pass(24, "b", "bb")}
        <feBlend in="rr" in2="gg" mode="screen" result="rg" />
        <feBlend in="rg" in2="bb" mode="screen" />
      </filter>
    </svg>
  );
}

export type Tab = { id: string; label: string; icon?: ReactNode; badge?: number };

/**
 * the dock: a tablist on glass with a lens that slides to the active tab. the lens can be
 * dragged between tabs; pressing lifts it.
 */
export function Dock({ tabs, value, onChange, right, label = "views" }: { tabs: Tab[]; value: string; onChange: (id: string) => void; right?: ReactNode; label?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<{ left: number; width: number }[]>([]);
  const [drag, setDrag] = useState<{ x: number; startX: number; startLeft: number } | null>(null);
  const [pressed, setPressed] = useState(false);
  const lens = useMemo(() => supportsLens(), []);
  const fid = useMemo(() => `lens-${++uid}`, []);
  const [base, setBase] = useState("#1a1a1f");

  const measure = () => {
    const list = listRef.current;
    if (!list) return;
    const lr = list.getBoundingClientRect();
    setRects(Array.from(list.querySelectorAll<HTMLElement>("[role=tab]")).map((t) => {
      const r = t.getBoundingClientRect();
      return { left: r.left - lr.left, width: r.width };
    }));
    setBase(getComputedStyle(document.documentElement).getPropertyValue("--glass").trim() || "#1a1a1f");
  };
  useLayoutEffect(measure, [tabs.length, tabs.map((t) => t.label + (t.badge ?? "")).join()]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (listRef.current) ro.observe(listRef.current);
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);

  const idx = tabs.findIndex((t) => t.id === value);
  const cur = idx >= 0 ? rects[idx] : undefined;
  const left = drag ? drag.startLeft + (drag.x - drag.startX) : cur?.left ?? 0;
  const width = cur?.width ?? 0;
  const h = 40;

  const nearest = (x: number) => {
    let best = 0, bd = Infinity;
    rects.forEach((r, i) => {
      const d = Math.abs(r.left + r.width / 2 - (x + width / 2));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    let n = idx;
    if (k === "ArrowRight") n = (idx + 1) % tabs.length;
    else if (k === "ArrowLeft") n = (idx - 1 + tabs.length) % tabs.length;
    else if (k === "Home") n = 0;
    else if (k === "End") n = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[n].id);
    listRef.current?.querySelectorAll<HTMLElement>("[role=tab]")[n]?.focus();
  };

  return (
    <nav className="dock glass" aria-label={label}>
      {lens && width > 0 && <LensFilter id={fid} w={width} h={h} base={base} />}
      <div className="dock-tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKey}>
        {width > 0 && (
          <div
            className={`dock-lens ${lens ? "refract" : "frost"} ${drag ? "dragging" : ""} ${pressed ? "pressed" : ""}`}
            style={{ transform: `translateX(${left}px) scale(${pressed ? 1.15 : 1})`, width, height: h, ...(lens ? { backdropFilter: `url(#${fid})`, WebkitBackdropFilter: `url(#${fid})` } : {}) }}
            aria-hidden="true"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              setPressed(true);
              setDrag({ x: e.clientX, startX: e.clientX, startLeft: cur?.left ?? 0 });
            }}
            onPointerMove={(e) => drag && setDrag({ ...drag, x: e.clientX })}
            onPointerUp={() => {
              setPressed(false);
              if (drag) {
                const moved = Math.abs(drag.x - drag.startX) > 4;
                const n = nearest(left);
                setDrag(null);
                if (moved) onChange(tabs[n].id);
              }
            }}
            onPointerCancel={() => { setPressed(false); setDrag(null); }}
          />
        )}
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={t.id === value}
            tabIndex={t.id === value || (idx < 0 && t === tabs[0]) ? 0 : -1}
            className="dock-tab"
            onPointerDown={() => t.id === value && setPressed(true)}
            onPointerUp={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            onClick={() => onChange(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
            {!!t.badge && <span className="dock-badge" aria-label={`${t.badge} waiting`}>{t.badge}</span>}
          </button>
        ))}
      </div>
      {right && <div className="dock-right">{right}</div>}
    </nav>
  );
}
