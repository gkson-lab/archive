// Sub-pixel corner refinement on the full-resolution frame.
// The detector runs on a small frame; here each side is re-fitted on the large image by
// searching for the strongest luminance step along the side normal, then the corners are
// re-computed as intersections of the fitted lines.
import type { Pt, Quad, RgbaImage } from './homography';

function lum(img: RgbaImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (x < 0) x = 0;
  else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0;
  else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = (y0 * w + x0) * 4;
  const j = i + w * 4;
  const l = (k: number) => 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
  return (l(i) * (1 - fx) + l(i + 4) * fx) * (1 - fy) + (l(j) * (1 - fx) + l(j + 4) * fx) * fy;
}

interface FitLine {
  px: number;
  py: number;
  dx: number;
  dy: number;
}

function fitLine(points: Pt[]): FitLine | null {
  if (points.length < 4) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta) };
}

function lineDist(l: FitLine, p: Pt) {
  return Math.abs((p.x - l.px) * l.dy - (p.y - l.py) * l.dx);
}

function intersectLines(a: FitLine, b: FitLine): Pt | null {
  const det = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det;
  return { x: a.px + a.dx * t, y: a.py + a.dy * t };
}

/** Refines `quad` (in `img` pixel coords). Returns the refined quad, or the input if refinement is unreliable. */
export function refineQuad(img: RgbaImage, quad: Quad, samplesPerSide = 28): Quad {
  const lines: (FitLine | null)[] = [];
  for (let k = 0; k < 4; k++) {
    const p = quad[k];
    const q = quad[(k + 1) % 4];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 20) return quad;
    const tx = (q.x - p.x) / len;
    const ty = (q.y - p.y) / len;
    const nx = -ty;
    const ny = tx;
    const R = Math.max(5, Math.round(len * 0.025));
    const pts: Pt[] = [];
    for (let i = 0; i < samplesPerSide; i++) {
      const t = 0.12 + (0.76 * (i + 0.5)) / samplesPerSide;
      const cx = p.x + (q.x - p.x) * t;
      const cy = p.y + (q.y - p.y) * t;
      // luminance profile across the edge, smoothed along the edge direction
      const prof: number[] = [];
      for (let o = -R - 1; o <= R + 1; o++) {
        let v = 0;
        for (let a = -2; a <= 2; a++) v += lum(img, cx + nx * o + tx * a, cy + ny * o + ty * a);
        prof.push(v / 5);
      }
      let bestO = 0;
      let bestG = 0;
      for (let o = 1; o < prof.length - 1; o++) {
        const g = Math.abs(prof[o + 1] - prof[o - 1]);
        if (g > bestG) {
          bestG = g;
          bestO = o;
        }
      }
      if (bestG < 10) continue;
      // parabolic sub-pixel peak
      const g0 = Math.abs(prof[bestO] - prof[bestO - 2 >= 0 ? bestO - 2 : 0]);
      const g2 = Math.abs(prof[Math.min(prof.length - 1, bestO + 2)] - prof[bestO]);
      const denom = g0 - 2 * bestG + g2;
      const sub = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (g0 - g2)) / denom)) : 0;
      const off = bestO - R - 1 + sub;
      pts.push({ x: cx + nx * off, y: cy + ny * off });
    }
    let line = fitLine(pts);
    if (line) {
      // one round of outlier rejection
      const inl = pts.filter((pt) => lineDist(line!, pt) < 2.5);
      if (inl.length >= Math.max(6, pts.length * 0.4)) line = fitLine(inl);
      else line = null;
    }
    lines.push(line);
  }
  const out: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const prevSide = lines[(k + 3) % 4];
    const side = lines[k];
    if (!prevSide || !side) return quad;
    const c = intersectLines(prevSide, side);
    if (!c) return quad;
    // refuse wild jumps
    if (Math.hypot(c.x - quad[k].x, c.y - quad[k].y) > 0.08 * Math.hypot(quad[2].x - quad[0].x, quad[2].y - quad[0].y)) return quad;
    out.push(c);
  }
  return out as Quad;
}
