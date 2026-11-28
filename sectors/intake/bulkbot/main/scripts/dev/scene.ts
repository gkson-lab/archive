// Synthetic "phone camera" scene renderer for offline benchmarks.
import sharp from 'sharp';
import { ensureImage } from '../lib/images';
import { homography, invert3, type Pt, type Quad, type RgbaImage } from '../../src/vision/homography';

let seed = Number(process.env.SEED ?? 42);
export const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
export const range = (a: number, b: number) => a + (b - a) * rnd();

export async function loadRgba(url: string): Promise<RgbaImage> {
  const file = await ensureImage(url);
  if (!file) throw new Error(`missing ${url}`);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

function makeBackground(W: number, H: number): Uint8ClampedArray {
  const img = new Uint8ClampedArray(W * H * 4);
  const r0 = rnd();
  const kind = r0 < 0.4 ? 0 : r0 < 0.65 ? 1 : r0 < 0.8 ? 2 : 3;
  const base = [range(20, 200), range(20, 200), range(20, 200)];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let v = 0;
      if (kind === 1) v = 25 * Math.sin(x / range(3, 9) + Math.sin(y / 40) * 3); // wood-ish grain
      if (kind === 2) v = ((x >> 5) + (y >> 5)) % 2 ? 30 : -30; // tiles/playmat pattern
      if (kind === 3) v = (rnd() - 0.5) * 60; // noisy fabric
      for (let c = 0; c < 3; c++) img[o + c] = base[c] + v + (rnd() - 0.5) * 12;
      img[o + 3] = 255;
    }
  }
  // a few clutter lines/rectangles (other objects on the table)
  for (let k = 0; k < 3; k++) {
    const x0 = range(0, W);
    const y0 = range(0, H);
    const x1 = x0 + range(-W / 2, W / 2);
    const y1 = y0 + range(-H / 2, H / 2);
    const col = [range(0, 255), range(0, 255), range(0, 255)];
    const th = range(1, 4);
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let t = 0; t < len; t++) {
      const x = Math.round(x0 + ((x1 - x0) * t) / len);
      const y = Math.round(y0 + ((y1 - y0) * t) / len);
      for (let d = 0; d < th; d++) {
        const yy = y + d;
        if (x < 0 || yy < 0 || x >= W || yy >= H) continue;
        const o = (yy * W + x) * 4;
        img[o] = col[0];
        img[o + 1] = col[1];
        img[o + 2] = col[2];
      }
    }
  }
  return img;
}

export function renderScene(card: RgbaImage, W: number, H: number) {
  const bg = makeBackground(W, H);
  let corners: Pt[] = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    const cardH = range(0.32, 0.8) * H;
    const cardW = cardH * (63 / 88);
    const rot = range(-0.6, 0.6);
    const cx = W / 2 + range(-0.18, 0.18) * W;
    const cy = H / 2 + range(-0.15, 0.15) * H;
    corners = [
      { x: -cardW / 2, y: -cardH / 2 },
      { x: cardW / 2, y: -cardH / 2 },
      { x: cardW / 2, y: cardH / 2 },
      { x: -cardW / 2, y: cardH / 2 },
    ].map((p) => ({
      x: cx + p.x * Math.cos(rot) - p.y * Math.sin(rot) + range(-0.05, 0.05) * cardW,
      y: cy + p.x * Math.sin(rot) + p.y * Math.cos(rot) + range(-0.05, 0.05) * cardH,
    }));
    if (corners.every((c) => c.x > W * 0.03 && c.x < W * 0.97 && c.y > H * 0.03 && c.y < H * 0.97)) break;
  }
  const quad = corners as Quad;
  const src: Quad = [
    { x: 0, y: 0 },
    { x: card.width, y: 0 },
    { x: card.width, y: card.height },
    { x: 0, y: card.height },
  ];
  const Hm = invert3(homography(src, quad)); // frame -> card
  const light = { gx: range(-0.4, 0.4), gy: range(-0.4, 0.4), gain: range(0.6, 1.25) };
  const glare = rnd() < 0.5 ? { x: range(0, W), y: range(0, H), r: range(20, 90), a: range(0.3, 0.8) } : null;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const w = Hm[6] * (x + 0.5) + Hm[7] * (y + 0.5) + Hm[8];
      const u = (Hm[0] * (x + 0.5) + Hm[1] * (y + 0.5) + Hm[2]) / w;
      const v = (Hm[3] * (x + 0.5) + Hm[4] * (y + 0.5) + Hm[5]) / w;
      let r = bg[o];
      let g = bg[o + 1];
      let b = bg[o + 2];
      if (u >= 0 && v >= 0 && u < card.width && v < card.height) {
        const i = ((v | 0) * card.width + (u | 0)) * 4;
        const a = card.data[i + 3] / 255;
        r = card.data[i] * a + r * (1 - a);
        g = card.data[i + 1] * a + g * (1 - a);
        b = card.data[i + 2] * a + b * (1 - a);
      }
      const shade = light.gain * (1 + light.gx * (x / W - 0.5) + light.gy * (y / H - 0.5));
      let add = 0;
      if (glare) {
        const d = Math.hypot(x - glare.x, y - glare.y) / glare.r;
        if (d < 1) add = 255 * glare.a * (1 - d * d);
      }
      const n = (rnd() - 0.5) * 10;
      out[o] = r * shade + add + n;
      out[o + 1] = g * shade + add + n;
      out[o + 2] = b * shade + add + n;
      out[o + 3] = 255;
    }
  }
  return { img: { data: out, width: W, height: H } as RgbaImage, quad };
}

export function toSmallRgba(img: RgbaImage, targetW: number) {
  const s = img.width / targetW;
  const w = targetW;
  const h = Math.round(img.height / s);
  const g = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(y * s); yy < Math.floor((y + 1) * s); yy++) {
        for (let xx = Math.floor(x * s); xx < Math.floor((x + 1) * s); xx++) {
          const o = (yy * img.width + xx) * 4;
          acc[0] += img.data[o];
          acc[1] += img.data[o + 1];
          acc[2] += img.data[o + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      g[o] = acc[0] / Math.max(1, n);
      g[o + 1] = acc[1] / Math.max(1, n);
      g[o + 2] = acc[2] / Math.max(1, n);
      g[o + 3] = 255;
    }
  }
  return { g, w, h, s };
}

