import { useApp } from "../state";
import { IconButton, IX } from "@archival/ui";

export function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : undefined}>
          <span className="grow">{t.text}</span>
          {t.action && <button className="btn small" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          <IconButton label="dismiss" onClick={() => dismiss(t.id)}><IX size={14} /></IconButton>
        </div>
      ))}
    </div>
  );
}
