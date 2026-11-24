import { useEffect, useRef } from "react";

export type MenuItem = { label: string; run: () => void; danger?: boolean };

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const b = Array.from(ref.current?.querySelectorAll<HTMLElement>("button") ?? []);
        const i = b.indexOf(document.activeElement as HTMLElement);
        b[(i + (e.key === "ArrowDown" ? 1 : -1) + b.length) % b.length]?.focus();
      }
    };
    setTimeout(() => window.addEventListener("mousedown", off), 0);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", off); window.removeEventListener("keydown", key); };
  }, []);
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - items.length * 40 - 16);
  return (
    <div ref={ref} className="menu" role="menu" style={{ left, top }}>
      {items.map((i) => (
        <button key={i.label} role="menuitem" className={i.danger ? "danger" : ""} onClick={() => { onClose(); i.run(); }}>
          {i.label}
        </button>
      ))}
    </div>
  );
}
