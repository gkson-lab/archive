import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@archival/ui";

/** run status. pulses (inside its own canvas) only while a process is starting; solid when ready. */
export function StatusDot({ status }: { status: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = 14 * dpr;
    c.height = 14 * dpr;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const color =
      status === "ready" ? css.getPropertyValue("--add") :
      status === "failed" ? css.getPropertyValue("--del") :
      status === "starting" ? css.getPropertyValue("--warn") : css.getPropertyValue("--muted");
    let raf = 0;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, 14, 14);
      if (status === "starting" && !prefersReducedMotion()) {
        const k = (Math.sin(t / 260) + 1) / 2;
        ctx.globalAlpha = 0.25 * (1 - k);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(7, 7, 4 + k * 3, 0, Math.PI * 2); ctx.fill();
        raf = requestAnimationFrame(draw);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(7, 7, 4, 0, Math.PI * 2); ctx.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [status]);
  return <canvas ref={ref} style={{ width: 14, height: 14 }} role="img" aria-label={status} />;
}
