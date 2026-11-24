import { useEffect, useState } from "react";

/** true when the user asked for less motion. read in js too, not just css. */
export function useReducedMotion(): boolean {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, set] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => set(q.matches);
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** animate a number toward a target (used for counts ticking down after a commit) */
export function useTicker(target: number, ms = 280): number {
  const [v, setV] = useState(target);
  useEffect(() => {
    if (prefersReducedMotion() || v === target) {
      setV(target);
      return;
    }
    const from = v;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}
