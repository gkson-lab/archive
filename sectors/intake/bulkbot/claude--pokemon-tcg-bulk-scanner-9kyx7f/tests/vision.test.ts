// Detector + warp regression test on a fully synthetic scene (no network, no model).
import { describe, expect, it } from 'vitest';
import { homography, invert3, quadDelta, warpQuad, type Quad } from '../src/vision/homography';
import { detectCard } from '../src/vision/quad';
import { refineQuad } from '../src/vision/refine';
import { cardSignature, resizeRgbaToRgbFloat, signatureSimilarity } from '../src/shared/preprocess';

/** A fake card: yellow border, colorful "art" and text-like stripes. */
function fakeCard(w = 245, h = 342) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const border = x < 10 || y < 10 || x >= w - 10 || y >= h - 10;
      const art = y > 40 && y < 170 && x > 18 && x < w - 18;
      const text = y > 190 && y < 300 && x > 18 && x < w - 18 && Math.floor(y / 9) % 2 === 0 && (x * 7 + y) % 23 > 6;
      const [r, g, b] = border ? [240, 205, 30] : art ? [80 + ((x * 3) % 120), 60 + ((y * 5) % 140), 150 - ((x + y) % 90)] : text ? [40, 40, 40] : [235, 228, 210];
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  return { data: d, width: w, height: h };
}

function scene(card: ReturnType<typeof fakeCard>, W: number, H: number, quad: Quad) {
  const Hm = invert3(homography([{ x: 0, y: 0 }, { x: card.width, y: 0 }, { x: card.width, y: card.height }, { x: 0, y: card.height }], quad));
  const out = new Uint8ClampedArray(W * H * 4);
  const SS = 3; // supersample like a real lens (no staircase edges)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const w = Hm[6] * px + Hm[7] * py + Hm[8];
          const u = (Hm[0] * px + Hm[1] * py + Hm[2]) / w;
          const v = (Hm[3] * px + Hm[4] * py + Hm[5]) / w;
          const grain = 14 * Math.sin(px / 5 + Math.sin(py / 40) * 3);
          let c = [70 + grain, 48 + grain, 32 + grain];
          if (u >= 0 && v >= 0 && u < card.width && v < card.height) {
            const i = ((v | 0) * card.width + (u | 0)) * 4;
            c = [card.data[i], card.data[i + 1], card.data[i + 2]];
          }
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
        }
      out[o] = acc[0] / (SS * SS);
      out[o + 1] = acc[1] / (SS * SS);
      out[o + 2] = acc[2] / (SS * SS);
      out[o + 3] = 255;
    }
  return { data: out, width: W, height: H };
}

describe('card detector', () => {
  const card = fakeCard();
  const W = 240;
  const H = 320;
  const truth: Quad = [
    { x: 62, y: 58 },
    { x: 186, y: 70 },
    { x: 176, y: 250 },
    { x: 48, y: 236 },
  ];
  const img = scene(card, W, H, truth);

  it('finds a tilted card on a wood-grain table', () => {
    const det = detectCard(img.data, W, H);
    expect(det).not.toBeNull();
    expect(quadDelta(det!.quad, truth)).toBeLessThan(4);
  });

  it('refines corners to about a pixel', () => {
    const det = detectCard(img.data, W, H)!;
    const refined = refineQuad(img, det.quad);
    expect(quadDelta(refined, truth)).toBeLessThan(2);
  });

  it('warps the card upright and the signature matches the original', () => {
    const det = detectCard(img.data, W, H)!;
    const warped = warpQuad(img, refineQuad(img, det.quad), 112, 160, undefined, 2);
    const a = resizeRgbaToRgbFloat(warped.data, 112, 160, 112, 160);
    const b = resizeRgbaToRgbFloat(card.data, card.width, card.height, 112, 160);
    expect(signatureSimilarity(cardSignature(a, 112, 160), cardSignature(b, 112, 160))).toBeGreaterThan(0.9);
  });

  it('returns nothing for an empty table', () => {
    const empty = scene({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, W, H, [
      { x: -10, y: -10 },
      { x: -9, y: -10 },
      { x: -9, y: -9 },
      { x: -10, y: -9 },
    ]);
    const det = detectCard(empty.data, W, H);
    expect(det === null || det.score < 0.12).toBe(true);
  });
});
