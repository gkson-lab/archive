import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { IX } from "./icons";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "small" | "normal";
  shine?: number;
};

/** buttons. only one `primary` per view: it's the one thing that matters there. */
export function Button({ variant = "secondary", size = "normal", shine, className = "", children, ...rest }: BtnProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!shine || !ref.current) return;
    const el = ref.current;
    el.classList.remove("shining");
    void el.offsetWidth;
    el.classList.add("shining");
    const t = setTimeout(() => el.classList.remove("shining"), 400);
    return () => clearTimeout(t);
  }, [shine]);
  const cls = ["btn", variant !== "secondary" ? variant : "", size === "small" ? "small" : "", className].filter(Boolean).join(" ");
  return (
    <button ref={ref} type="button" className={cls} {...rest}>
      {variant === "primary" && <span className="shine" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/** chrome lettering. data-text feeds the oil rim and chrome layers. */
export function ChromeText({ children, as: Tag = "span", className = "" }: { children: string; as?: any; className?: string }) {
  return (
    <Tag className={`chrome-text ${className}`} data-text={children}>
      {children}
    </Tag>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title = "that didn't work", error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <h3>{title}</h3>
      <p className="err-detail">{errText(error)}</p>
      {onRetry && <Button onClick={onRetry}>try again</Button>}
    </div>
  );
}

export function Loading({ lines = 3, label = "loading" }: { lines?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-label={label} style={{ display: "grid", gap: 10, padding: "20px 0" }}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${88 - i * 17}%` }} />
      ))}
    </div>
  );
}

export function Ring({ value, chrome }: { value: number; chrome?: boolean }) {
  const p = Math.max(0, Math.min(1, value));
  return <span className={`ring ${chrome ? "chrome" : ""}`} style={{ ["--p" as any]: p }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} />;
}

export function Dialog({ title, onClose, children, footer, label }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input, textarea, select, button:not([data-close])");
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && el) {
        const f = Array.from(el.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]:not([tabindex='-1'])")).filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog glass" role="dialog" aria-modal="true" aria-label={label ?? title}>
        <header>
          <h2>{title}</h2>
          <IconButton label="close" data-close onClick={onClose}>
            <IX />
          </IconButton>
        </header>
        {children}
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function errText(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function useMounted() {
  const [m, set] = useState(false);
  useEffect(() => set(true), []);
  return m;
}
