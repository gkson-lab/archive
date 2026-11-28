// Perspective math: 4-point homography, inversion and image warping (no OpenCV needed).

export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt]; // tl, tr, br, bl
export type Mat3 = Float64Array; // row-major 3x3

/** Solves the 8x8 system for the homography mapping src[i] -> dst[i]. */
export function homography(src: Quad, dst: Quad): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return Float64Array.from([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return Float64Array.from([
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ]);
}

export function apply(m: Mat3, x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Warps the region of `src` bounded by `quad` (tl,tr,br,bl in src pixels) into an upright
 * outW x outH RGBA image. `region` optionally restricts output to a sub-rectangle given in
 * normalized card coordinates (e.g. just the bottom strip), at full output resolution.
 */
export function warpQuad(
  src: RgbaImage,
  quad: Quad,
  outW: number,
  outH: number,
  region: { x0: number; y0: number; x1: number; y1: number } = { x0: 0, y0: 0, x1: 1, y1: 1 },
  supersample = 1,
): RgbaImage {
  const fullW = outW / (region.x1 - region.x0);
  const fullH = outH / (region.y1 - region.y0);
  const dstQuad: Quad = [
    { x: 0, y: 0 },
    { x: fullW, y: 0 },
    { x: fullW, y: fullH },
    { x: 0, y: fullH },
  ];
  const Hinv = homography(dstQuad, quad); // maps output coords -> source coords
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  const ox = region.x0 * fullW;
  const oy = region.y0 * fullH;
  const ss = Math.max(1, supersample | 0);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = ox + x + (sx + 0.5) / ss;
          const py = oy + y + (sy + 0.5) / ss;
          const w = Hinv[6] * px + Hinv[7] * py + Hinv[8];
          let u = (Hinv[0] * px + Hinv[1] * py + Hinv[2]) / w - 0.5;
          let v = (Hinv[3] * px + Hinv[4] * py + Hinv[5]) / w - 0.5;
          if (u < 0) u = 0;
          else if (u > sw - 1.001) u = sw - 1.001;
          if (v < 0) v = 0;
          else if (v > sh - 1.001) v = sh - 1.001;
          const x0 = u | 0;
          const y0 = v | 0;
          const fx = u - x0;
          const fy = v - y0;
          const i00 = (y0 * sw + x0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + sw * 4;
          const i11 = i01 + 4;
          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;
          r += sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
          g += sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
          b += sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        }
      }
      const o = (y * outW + x) * 4;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Orders 4 points as tl, tr, br, bl (by angle around the centroid, starting top-left). */
export function orderQuad(pts: Pt[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // sorted is clockwise in image coords starting from the most "left-up" angle region; rotate so tl = min(x+y)
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    if (p.x + p.y < best) {
      best = p.x + p.y;
      start = i;
    }
  });
  const q = [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]) as Quad;
  return q;
}

/**
 * Makes the quad portrait: if its first edge (tl->tr) is the long side, rotate the
 * labels by one so the card is read upright-portrait (landscape-held cards still work).
 */
export function portraitQuad(q: Quad): Quad {
  const top = dist(q[0], q[1]);
  const left = dist(q[0], q[3]);
  if (top > left * 1.05) return [q[3], q[0], q[1], q[2]];
  return q;
}

/** Rotates labels 180°, for cards seen upside down. */
export function flipQuad(q: Quad): Quad {
  return [q[2], q[3], q[0], q[1]];
}

/** Mean corner displacement between two quads, in pixels. */
export function quadDelta(a: Quad, b: Quad): number {
  let d = 0;
  for (let i = 0; i < 4; i++) d += dist(a[i], b[i]);
  return d / 4;
}
