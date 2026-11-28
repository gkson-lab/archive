/// <reference lib="webworker" />
// Runs the card detector off the main thread so the camera preview and UI stay at 60fps.
import type { Quad } from '../vision/homography';
import { detectCard, type Detection } from '../vision/quad';

export interface DetectRequest {
  id: number;
  w: number;
  h: number;
  rgba: ArrayBuffer;
  prev: Quad | null;
}

export interface DetectResponse {
  id: number;
  det: Detection | null;
  ms: number;
  /** returned for reuse */
  rgba: ArrayBuffer;
  /** mean luminance of the frame (for "too dark" hints) */
  luma: number;
  /** variance of Laplacian in the card area: higher = sharper */
  sharpness: number;
}

function sharpnessOf(rgba: Uint8ClampedArray, w: number, h: number, det: Detection | null): number {
  if (!det) return 0;
  const xs = det.quad.map((p) => p.x);
  const ys = det.quad.map((p) => p.y);
  const x0 = Math.max(1, Math.floor(Math.min(...xs) + 4));
  const x1 = Math.min(w - 2, Math.ceil(Math.max(...xs) - 4));
  const y0 = Math.max(1, Math.floor(Math.min(...ys) + 4));
  const y1 = Math.min(h - 2, Math.ceil(Math.max(...ys) - 4));
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const L = (i: number) => rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4;
      const lap = 4 * L(i) - L(i - 4) - L(i + 4) - L(i - w * 4) - L(i + w * 4);
      sum += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

self.onmessage = (ev: MessageEvent<DetectRequest>) => {
  const { id, w, h, rgba, prev } = ev.data;
  const t0 = performance.now();
  const px = new Uint8ClampedArray(rgba);
  let det: Detection | null = null;
  try {
    det = detectCard(px, w, h, { prev });
  } catch {
    det = null;
  }
  let luma = 0;
  for (let i = 0; i < px.length; i += 64) luma += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  luma /= px.length / 64;
  const sharpness = sharpnessOf(px, w, h, det);
  const res: DetectResponse = { id, det, ms: performance.now() - t0, rgba, luma, sharpness };
  (self as unknown as Worker).postMessage(res, [rgba]);
};
