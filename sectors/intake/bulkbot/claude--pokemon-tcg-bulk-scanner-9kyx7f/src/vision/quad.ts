// Full-frame card detector: finds the card's four edges anywhere in the frame, at any angle,
// distance or (moderate) tilt, without the user lining it up with a guide.
//
// Pipeline (all on a ~320px grayscale frame, a few ms in a worker):
//   blur -> Sobel -> non-max suppression -> hysteresis edges
//   -> gradient-directed Hough transform -> peak lines
//   -> pairs of near-parallel lines -> quads from two roughly perpendicular pairs
//   -> score by edge support along each side, card aspect ratio, size, centering, tracking.
import { orderQuad, quadArea, quadDelta, type Pt, type Quad } from './homography';

export const CARD_ASPECT = 63 / 88; // 0.716

export interface Detection {
  quad: Quad;
  score: number;
  /** fraction of each side (top, right, bottom, left) backed by real edge pixels */
  support: number[];
  aspect: number;
  areaFrac: number;
  /** border-band evidence in [0,1] */
  border: number;
  /** next-best distinct candidates (recognition can verify them when the first crop matches poorly) */
  alternates?: Quad[];
}

export interface DetectOptions {
  minAreaFrac?: number;
  maxAreaFrac?: number;
  prev?: Quad | null;
}

interface Line {
  theta: number;
  rho: number;
  votes: number;
  c: number;
  s: number;
}

interface Edges {
  mask: Uint8Array; // 1 where edge
  dir: Float32Array; // gradient angle in [0, PI)
  w: number;
  h: number;
  /** per-pixel "not the table" probability (0..1) from a background color model, if reliable */
  fg?: Float32Array;
}

/**
 * Background color model: the frame border is (almost always) table, mat or hand. Pixels are scored
 * by how far their color is from it, with chroma weighted over brightness so wood grain, fabric
 * weave and lighting gradients look like "table" while the card stands out.
 */
export function foregroundMap(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Float32Array | undefined {
  const bw = Math.max(3, Math.round(Math.min(w, h) * 0.06));
  const L: number[] = [];
  const C1: number[] = [];
  const C2: number[] = [];
  const push = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    L.push((r + g + b) / 3);
    C1.push(r - g);
    C2.push((r + g) / 2 - b);
  };
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < bw; x += 2) push(x, y);
    for (let x = w - bw; x < w; x += 2) push(x, y);
  }
  for (let x = bw; x < w - bw; x += 2) {
    for (let y = 0; y < bw; y += 2) push(x, y);
    for (let y = h - bw; y < h; y += 2) push(x, y);
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const stat = (a: number[], floor: number) => {
    const m = med(a);
    const mad = med(a.map((v) => Math.abs(v - m)));
    return { m, s: Math.max(floor, 1.4826 * mad) };
  };
  const sl = stat(L, 18);
  const s1 = stat(C1, 7);
  const s2 = stat(C2, 7);
  // a very busy border (cluttered desk, multicolor playmat) makes the model meaningless
  if (s1.s > 40 || s2.s > 40) return undefined;
  const fg = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const dl = ((r + g + b) / 3 - sl.m) / sl.s;
    const d1 = (r - g - s1.m) / s1.s;
    const d2 = ((r + g) / 2 - b - s2.m) / s2.s;
    const d = Math.sqrt(0.35 * dl * dl + d1 * d1 + d2 * d2);
    fg[i] = Math.min(1, Math.max(0, (d - 2) / 4));
  }
  return fg;
}

const THETA_BINS = 180;
const COS = new Float32Array(THETA_BINS);
const SIN = new Float32Array(THETA_BINS);
for (let i = 0; i < THETA_BINS; i++) {
  COS[i] = Math.cos((i * Math.PI) / THETA_BINS);
  SIN[i] = Math.sin((i * Math.PI) / THETA_BINS);
}

export function computeEdges(gray: Uint8Array | Uint8ClampedArray | Float32Array, w: number, h: number): Edges {
  // 5-tap binomial blur, separable
  const tmp = new Float32Array(w * h);
  const bl = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x < 2 ? 0 : x - 2;
      const xm1 = x < 1 ? 0 : x - 1;
      const xp1 = x >= w - 1 ? w - 1 : x + 1;
      const xp2 = x >= w - 2 ? w - 1 : x + 2;
      tmp[r + x] = (gray[r + xm2] + 4 * gray[r + xm1] + 6 * gray[r + x] + 4 * gray[r + xp1] + gray[r + xp2]) / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym2 = (y < 2 ? 0 : y - 2) * w;
    const ym1 = (y < 1 ? 0 : y - 1) * w;
    const yp1 = (y >= h - 1 ? h - 1 : y + 1) * w;
    const yp2 = (y >= h - 2 ? h - 1 : y + 2) * w;
    const r = y * w;
    for (let x = 0; x < w; x++) {
      bl[r + x] = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[r + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) / 16;
    }
  }
  const mag = new Float32Array(w * h);
  const gxs = new Float32Array(w * h);
  const gys = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = bl[i - w + 1] + 2 * bl[i + 1] + bl[i + w + 1] - bl[i - w - 1] - 2 * bl[i - 1] - bl[i + w - 1];
      const gy = bl[i + w - 1] + 2 * bl[i + w] + bl[i + w + 1] - bl[i - w - 1] - 2 * bl[i - w] - bl[i - w + 1];
      gxs[i] = gx;
      gys[i] = gy;
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  // non-max suppression along the gradient direction
  const nms = new Float32Array(w * h);
  const hist = new Uint32Array(256);
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < 8) continue;
      const ax = Math.abs(gxs[i]);
      const ay = Math.abs(gys[i]);
      let a: number;
      let b: number;
      if (ay * 2.4142 < ax) {
        a = mag[i - 1];
        b = mag[i + 1];
      } else if (ax * 2.4142 < ay) {
        a = mag[i - w];
        b = mag[i + w];
      } else if (gxs[i] * gys[i] > 0) {
        a = mag[i - w - 1];
        b = mag[i + w + 1];
      } else {
        a = mag[i - w + 1];
        b = mag[i + w - 1];
      }
      if (m >= a && m > b) {
        nms[i] = m;
        hist[Math.min(255, m >> 2)]++;
        count++;
      }
    }
  }
  // adaptive hysteresis thresholds from the magnitude distribution
  let acc = 0;
  let hiBin = 255;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= count * 0.7) {
      hiBin = b;
      break;
    }
  }
  const hi = Math.max(24, hiBin * 4);
  const lo = hi * 0.45;
  const mask = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (nms[i] >= hi && !mask[i]) {
      mask[i] = 1;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        const jx = j % w;
        for (let dy = -w; dy <= w; dy += w) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = j + dy + dx;
            if (k < 0 || k >= w * h || mask[k]) continue;
            const kx = k % w;
            if (Math.abs(kx - jx) > 1) continue;
            if (nms[k] >= lo) {
              mask[k] = 1;
              stack.push(k);
            }
          }
        }
      }
    }
  }
  const dir = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    let a = Math.atan2(gys[i], gxs[i]);
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    dir[i] = a;
  }
  return { mask, dir, w, h };
}

function houghLines(e: Edges, maxLines: number, minVotes: number): Line[] {
  const { w, h, mask, dir } = e;
  const diag = Math.ceil(Math.hypot(w, h));
  const R = 2 * diag + 1;
  const acc = new Float32Array(THETA_BINS * R);
  // gradient directions are noisy (aliasing, blur, rounded corners): vote over +-5 degrees, tapered
  const spread = 5;
  const taper = [1, 0.9, 0.75, 0.55, 0.38, 0.22];
  // users point the camera at the card: votes near the frame center count more than far background
  const cx = w / 2;
  const cy = h / 2;
  const sig2 = (0.55 * Math.hypot(w, h)) ** 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let cw = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / sig2);
      if (e.fg) {
        // edges that separate "table" from "not table" count; texture inside the table barely does
        const a = dir[i];
        const nx = Math.round(Math.cos(a) * 2);
        const ny = Math.round(Math.sin(a) * 2);
        const x1 = Math.min(w - 1, Math.max(0, x + nx));
        const y1 = Math.min(h - 1, Math.max(0, y + ny));
        const x2 = Math.min(w - 1, Math.max(0, x - nx));
        const y2 = Math.min(h - 1, Math.max(0, y - ny));
        cw *= 0.12 + 0.88 * Math.abs(e.fg[y1 * w + x1] - e.fg[y2 * w + x2]);
      }
      const tb = Math.round((dir[i] / Math.PI) * THETA_BINS);
      for (let d = -spread; d <= spread; d++) {
        let t = tb + d;
        if (t < 0) t += THETA_BINS;
        else if (t >= THETA_BINS) t -= THETA_BINS;
        // the vote uses the (possibly wrapped) bin's own angle, so rho is consistent per bin
        const r = Math.round(x * COS[t] + y * SIN[t]) + diag;
        acc[t * R + r] += cw * taper[d < 0 ? -d : d];
      }
    }
  }
  // peak picking with non-maximum suppression
  const peaks: Line[] = [];
  const TW = 4;
  const RW = 6;
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 0; r < R; r++) {
      const v = acc[t * R + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -TW; dt <= TW && isMax; dt++) {
        let tt = t + dt;
        let rr0 = r;
        if (tt < 0) {
          tt += THETA_BINS;
          rr0 = 2 * diag - r;
        } else if (tt >= THETA_BINS) {
          tt -= THETA_BINS;
          rr0 = 2 * diag - r;
        }
        for (let dr = -RW; dr <= RW; dr++) {
          const rr = rr0 + dr;
          if (rr < 0 || rr >= R || (dt === 0 && dr === 0)) continue;
          const o = acc[tt * R + rr];
          if (o > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      const theta = (t * Math.PI) / THETA_BINS;
      peaks.push({ theta, rho: r - diag, votes: v, c: Math.cos(theta), s: Math.sin(theta) });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  // orientation diversity: a grid-patterned mat must not crowd out the card's own (rotated) edges
  const perBucket = new Map<number, number>();
  const out: Line[] = [];
  for (const p of peaks) {
    const bucket = Math.floor(((p.theta * 180) / Math.PI + 5) / 10) % 18;
    const n = perBucket.get(bucket) ?? 0;
    if (n >= 7) continue;
    perBucket.set(bucket, n + 1);
    out.push(p);
    if (out.length >= maxLines) break;
  }
  return out;
}

function intersect(a: Line, b: Line): Pt | null {
  const det = a.c * b.s - a.s * b.c;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.rho * b.s - b.rho * a.s) / det, y: (a.c * b.rho - b.c * a.rho) / det };
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

/** Fraction of points along segment p->q that sit on an edge pixel oriented like the segment. */
function sideSupport(e: Edges, p: Pt, q: Pt, t0 = 0.1, t1 = 0.9): number {
  const { w, h, mask, dir } = e;
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  const K = Math.max(12, Math.min(40, Math.round(len / 4)));
  const nx = -(q.y - p.y) / len;
  const ny = (q.x - p.x) / len;
  let normal = Math.atan2(ny, nx);
  if (normal < 0) normal += Math.PI;
  if (normal >= Math.PI) normal -= Math.PI;
  let hits = 0;
  for (let k = 0; k < K; k++) {
    const t = t0 + ((t1 - t0) * (k + 0.5)) / K; // default skips the rounded corners
    const cx = p.x + (q.x - p.x) * t;
    const cy = p.y + (q.y - p.y) * t;
    let found = false;
    for (let o = -2; o <= 2 && !found; o++) {
      const x = Math.round(cx + nx * o);
      const y = Math.round(cy + ny * o);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (mask[i] && angleDiff(dir[i], normal) < 0.35) found = true;
    }
    if (found) hits++;
  }
  return hits / K;
}

/** How much a color looks like a card border: yellow/gold (most eras) or silver (Scarlet & Violet onward). */
export function borderColorPrior(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const v = mx / 255;
  const sat = mx ? (mx - mn) / mx : 0;
  let hue = 0;
  if (mx !== mn) {
    if (mx === r) hue = (60 * (g - b)) / (mx - mn);
    else if (mx === g) hue = 120 + (60 * (b - r)) / (mx - mn);
    else hue = 240 + (60 * (r - g)) / (mx - mn);
    if (hue < 0) hue += 360;
  }
  if (sat > 0.3 && v > 0.3 && hue >= 30 && hue <= 68) return 1; // yellow / gold
  if (sat < 0.2 && v > 0.45) return 0.85; // silver / light gray
  if (sat > 0.22 && v > 0.22 && hue >= 18 && hue <= 78) return 0.6; // yellow under warm or dim light
  if (sat < 0.3 && v > 0.35) return 0.45; // silver under tinted light
  return 0.1;
}

/**
 * Card border cue: just inside a real card's outer edge there is a narrow band of nearly uniform
 * yellow or silver (the border) that differs from what is just outside. The artwork window
 * (inside = artwork) and rectangles made of table/background lines (inside = table) fail it.
 */
export function borderScore(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, quad: Quad): number {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const sides = [0, 1, 2, 3].map((k) => Math.hypot(quad[(k + 1) % 4].x - quad[k].x, quad[(k + 1) % 4].y - quad[k].y));
  const short = Math.min((sides[0] + sides[2]) / 2, (sides[1] + sides[3]) / 2);
  const sample = (x: number, y: number): [number, number, number] => {
    const xi = Math.max(0, Math.min(w - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(h - 1, Math.round(y)));
    const o = (yi * w + xi) * 4;
    return [rgba[o], rgba[o + 1], rgba[o + 2]];
  };
  const cd = (u: number[], v: number[]) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
  const median = (arr: number[]) => arr.sort((x, y) => x - y)[arr.length >> 1];
  const scores: number[] = [];
  for (let k = 0; k < 4; k++) {
    const p = quad[k];
    const q = quad[(k + 1) % 4];
    const len = sides[k];
    let nx = -(q.y - p.y) / len;
    let ny = (q.x - p.x) / len;
    if ((cx - (p.x + q.x) / 2) * nx + (cy - (p.y + q.y) / 2) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const N = 16;
    const ins: number[][] = [];
    const outs: number[][] = [];
    const din = Math.max(1.2, 0.016 * short);
    const dout = Math.max(2, 0.04 * short);
    for (let i = 0; i < N; i++) {
      const t = 0.15 + (0.7 * (i + 0.5)) / N;
      const bx = p.x + (q.x - p.x) * t;
      const by = p.y + (q.y - p.y) * t;
      ins.push(sample(bx + nx * din, by + ny * din));
      outs.push(sample(bx - nx * dout, by - ny * dout));
    }
    const local = median(ins.slice(1).map((v, i) => cd(v, ins[i])));
    const contrast = median(ins.map((v, i) => cd(v, outs[i])));
    const mr = median(ins.map((v) => v[0]));
    const mg = median(ins.map((v) => v[1]));
    const mb = median(ins.map((v) => v[2]));
    const prior = borderColorPrior(mr, mg, mb);
    const uni = Math.max(0, Math.min(1, 1 - (local - 8) / 40));
    const con = Math.max(0, Math.min(1, contrast / 35));
    scores.push(prior * uni * (0.3 + 0.7 * con));
  }
  const m = scores.reduce((x, y) => x + y, 0) / 4;
  return 0.5 * m + 0.5 * Math.min(...scores);
}

/** Detects the most card-like quadrilateral in a small RGBA frame. */
export function detectCard(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, opts: DetectOptions = {}): Detection | null {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  const fg = foregroundMap(rgba, w, h);
  if (fg) {
    // dark card on a dark table has little brightness contrast but plenty of color contrast
    for (let i = 0; i < w * h; i++) gray[i] = 0.45 * gray[i] + 140 * fg[i];
  }
  const edges = computeEdges(gray, w, h);
  edges.fg = fg;
  return detectFromEdges(edges, rgba, opts);
}

export function detectFromEdges(edges: Edges, rgba: Uint8Array | Uint8ClampedArray, opts: DetectOptions = {}): Detection | null {
  const { w, h } = edges;
  const frameArea = w * h;
  const minArea = (opts.minAreaFrac ?? 0.05) * frameArea;
  const maxArea = (opts.maxAreaFrac ?? 0.97) * frameArea;
  const minSide = Math.sqrt(minArea * CARD_ASPECT);
  const lines = houghLines(edges, 36, Math.max(8, minSide * 0.25));
  if (lines.length < 4) return null;

  // near-parallel pairs, separated by at least a short card side
  const pairs: [Line, Line, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (angleDiff(a.theta, b.theta) > 0.3) continue;
      // put b in a's theta frame to compare rho
      const sameFrame = Math.abs(a.theta - b.theta) < Math.PI / 2;
      const sep = Math.abs(a.rho - (sameFrame ? b.rho : -b.rho));
      if (sep < minSide * 0.7) continue;
      pairs.push([a, b, (a.theta + (sameFrame ? b.theta : b.theta + (b.theta < a.theta ? Math.PI : -Math.PI))) / 2]);
    }
  }
  const cands: Detection[] = [];
  const cxF = w / 2;
  const cyF = h / 2;
  const halfDiag = Math.hypot(w, h) / 2;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [a1, a2, ta] = pairs[i];
      const [b1, b2, tb] = pairs[j];
      const ortho = Math.abs(angleDiff(ta, tb) - Math.PI / 2);
      if (ortho > 0.5) continue;
      if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
      const p = [intersect(a1, b1), intersect(a1, b2), intersect(a2, b2), intersect(a2, b1)];
      if (p.some((x) => !x)) continue;
      const pts = p as Pt[];
      const margin = 0.03;
      if (pts.some((q) => q.x < -w * margin || q.y < -h * margin || q.x > w * (1 + margin) || q.y > h * (1 + margin))) continue;
      const quad = orderQuad(pts);
      const area = quadArea(quad);
      if (area < minArea || area > maxArea) continue;
      const s = [0, 1, 2, 3].map((k) => Math.hypot(quad[(k + 1) % 4].x - quad[k].x, quad[(k + 1) % 4].y - quad[k].y));
      if (Math.min(s[0], s[2]) / Math.max(s[0], s[2]) < 0.6 || Math.min(s[1], s[3]) / Math.max(s[1], s[3]) < 0.6) continue;
      const horiz = (s[0] + s[2]) / 2;
      const vert = (s[1] + s[3]) / 2;
      const aspect = Math.min(horiz, vert) / Math.max(horiz, vert);
      if (aspect < 0.52 || aspect > 0.93) continue;
      // convexity
      let sign = 0;
      let convex = true;
      for (let k = 0; k < 4; k++) {
        const o = quad[k];
        const n1 = quad[(k + 1) % 4];
        const n2 = quad[(k + 2) % 4];
        const cr = (n1.x - o.x) * (n2.y - n1.y) - (n1.y - o.y) * (n2.x - n1.x);
        if (sign === 0) sign = Math.sign(cr);
        else if (Math.sign(cr) !== sign) convex = false;
      }
      if (!convex) continue;
      const support = [0, 1, 2, 3].map((k) => sideSupport(edges, quad[k], quad[(k + 1) % 4]));
      const minS = Math.min(...support);
      const meanS = support.reduce((x, y) => x + y, 0) / 4;
      if (minS < 0.3 || meanS < 0.5) continue;
      // A card's edges stop at its corners; wood grain, tiles or a table edge keep going.
      let ext = 0;
      for (let k = 0; k < 4; k++) {
        const a = quad[k];
        const b = quad[(k + 1) % 4];
        ext += sideSupport(edges, a, b, 1.06, 1.3) + sideSupport(edges, a, b, -0.3, -0.06);
      }
      ext /= 8;
      const areaFrac = area / frameArea;
      const cx = quad.reduce((acc, q) => acc + q.x, 0) / 4;
      const cy = quad.reduce((acc, q) => acc + q.y, 0) / 4;
      const centerPrior = 1 - 0.45 * (Math.hypot(cx - cxF, cy - cyF) / halfDiag);
      const aspectPrior = Math.exp(-(((aspect - CARD_ASPECT) / 0.09) ** 2));
      let score = meanS * (0.6 + 0.4 * minS) * (0.55 + 0.45 * aspectPrior) * (0.6 + 0.4 * Math.sqrt(areaFrac)) * centerPrior * (1 - 0.75 * ext);
      if (opts.prev) score *= 1 + 0.35 * Math.exp(-quadDelta(opts.prev, quad) / (0.04 * halfDiag * 2));
      cands.push({ quad, score, support, aspect, areaFrac, border: 0 });
    }
  }
  // second pass: border-band evidence for the strongest geometric candidates only
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 60);
  for (const c of top) {
    c.border = borderScore(rgba, w, h, c.quad);
    c.score *= 0.15 + 0.85 * c.border;
    if (edges.fg) c.score *= 0.3 + 0.7 * regionContrast(edges.fg, w, h, c.quad);
  }
  top.sort((a, b) => b.score - a.score);
  let best: Detection | null = top[0] ?? null;
  if (!best) return null;
  // Nested candidates: the artwork window or a partial rectangle (3 card sides + art edge) sits
  // inside the real card. Prefer an enclosing candidate that also looks like a card border.
  for (const c of top.slice(1, 25)) {
    if (c.areaFrac <= best.areaFrac * 1.03 || c.areaFrac > best.areaFrac * 3.2) continue;
    if (c.border < 0.35 || c.border < best.border * 0.6) continue;
    if (!best.quad.every((p) => insideQuad(c.quad, p, 0.02 * Math.sqrt(c.areaFrac * w * h)))) continue;
    if (c.score < best.score * 0.35) continue;
    best = c;
  }
  const diag = Math.hypot(w, h);
  const alts: Quad[] = [];
  for (const c of top) {
    if (alts.length >= 3) break;
    if (c === best || c.score < best.score * 0.15) continue;
    if (quadDelta(c.quad, best.quad) < 0.03 * diag || alts.some((a) => quadDelta(a, c.quad) < 0.03 * diag)) continue;
    alts.push(c.quad);
  }
  return { ...best, alternates: alts };
}

/** Mean foreground inside the quad minus just outside it: high for a card on a table. */
function regionContrast(fg: Float32Array, w: number, h: number, q: Quad): number {
  const at = (u: number, v: number) => {
    // bilinear point inside the quad from (u,v) in [0,1]^2, extrapolates outside
    const x = (1 - v) * ((1 - u) * q[0].x + u * q[1].x) + v * ((1 - u) * q[3].x + u * q[2].x);
    const y = (1 - v) * ((1 - u) * q[0].y + u * q[1].y) + v * ((1 - u) * q[3].y + u * q[2].y);
    const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    return fg[yi * w + xi];
  };
  let inside = 0;
  let ni = 0;
  for (let i = 1; i < 8; i++) {
    for (let j = 1; j < 10; j++) {
      inside += at(i / 8, j / 10);
      ni++;
    }
  }
  let outside = 0;
  let no = 0;
  for (let k = 0; k < 24; k++) {
    const t = (k + 0.5) / 24;
    outside += at(t, -0.07) + at(t, 1.07) + at(-0.09, t) + at(1.09, t);
    no += 4;
  }
  return Math.max(0, Math.min(1, (inside / ni - outside / no) / 0.45));
}

function insideQuad(q: Quad, p: Pt, tol: number): boolean {
  for (let k = 0; k < 4; k++) {
    const a = q[k];
    const b = q[(k + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (cross / len < -tol) return false; // clockwise quad: inside has non-negative cross
  }
  return true;
}
