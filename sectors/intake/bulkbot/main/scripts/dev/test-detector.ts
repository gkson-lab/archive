/**
 * Synthetic benchmark for the card detector + corner refinement.
 * Renders real card scans into random "phone camera" scenes (random pose, tilt, scale,
 * background clutter, lighting gradient, glare, blur, noise) and measures corner error.
 *   npx tsx scripts/dev/test-detector.ts [trials]
 */
import sharp from 'sharp';
import type { Quad } from '../../src/vision/homography';
import { loadRgba, renderScene, toSmallRgba } from './scene';
import { detectCard } from '../../src/vision/quad';
import { refineQuad } from '../../src/vision/refine';

const URLS = [
  'https://images.pokemontcg.io/base1/4.png',
  'https://images.pokemontcg.io/base1/58.png',
  'https://images.pokemontcg.io/sv3pt5/25.png',
  'https://images.pokemontcg.io/swsh7/215.png',
  'https://images.pokemontcg.io/sm12/1.png',
  'https://images.pokemontcg.io/xy1/1.png',
  'https://images.pokemontcg.io/ex1/1.png',
  'https://images.pokemontcg.io/dp1/1.png',
  'https://images.pokemontcg.io/bw1/1.png',
  'https://images.pokemontcg.io/sv1/198.png',
  'https://images.pokemontcg.io/swsh4/25.png',
  'https://images.pokemontcg.io/neo1/9.png',
];

function cornerError(a: Quad, b: Quad) {
  // compare with any cyclic rotation (labels may start at another corner)
  let best = Infinity;
  for (let r = 0; r < 4; r++) {
    let e = 0;
    for (let k = 0; k < 4; k++) e += Math.hypot(a[k].x - b[(k + r) % 4].x, a[k].y - b[(k + r) % 4].y);
    best = Math.min(best, e / 4);
  }
  return best;
}

async function main() {
  const trials = Number(process.argv[2] ?? 60);
  const cards = await Promise.all(URLS.map(loadRgba));
  const W = 720;
  const H = 960;
  let found = 0;
  let good = 0;
  let goodRefined = 0;
  let tDetect = 0;
  let tRefine = 0;
  const errs: number[] = [];
  const errsR: number[] = [];
  for (let t = 0; t < trials; t++) {
    const card = cards[t % cards.length];
    const { img, quad } = renderScene(card, W, H);
    const small = toSmallRgba(img, 240);
    const t0 = performance.now();
    const det = detectCard(small.g, small.w, small.h);
    tDetect += performance.now() - t0;
    const cardH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    if (!det) continue;
    found++;
    const coarse = det.quad.map((p) => ({ x: p.x * small.s, y: p.y * small.s })) as Quad;
    const e = cornerError(coarse, quad) / cardH;
    errs.push(e);
    if (e < 0.03) good++;
    if (process.env.VERBOSE) {
      const { quadArea } = await import('../../src/vision/homography');
      console.log(`t${t} err ${(100 * e).toFixed(1)}% areaRatio ${(quadArea(coarse) / quadArea(quad)).toFixed(3)} support ${det.support.map((x) => x.toFixed(2)).join(',')} border ${det.border.toFixed(2)}`);
    }
    if (process.env.DUMP && t < Number(process.env.DUMP)) {
      const vis = new Uint8ClampedArray(img.data);
      const draw = (q: Quad, col: number[]) => {
        for (let k = 0; k < 4; k++) {
          const a = q[k];
          const b = q[(k + 1) % 4];
          const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
          for (let i = 0; i <= n; i++) {
            const x = Math.round(a.x + ((b.x - a.x) * i) / n);
            const y = Math.round(a.y + ((b.y - a.y) * i) / n);
            for (let d = -1; d <= 1; d++) {
              if (x + d < 0 || y < 0 || x + d >= W || y >= H) continue;
              const o = (y * W + x + d) * 4;
              vis[o] = col[0];
              vis[o + 1] = col[1];
              vis[o + 2] = col[2];
            }
          }
        }
      };
      draw(quad, [0, 255, 0]);
      draw(coarse, [255, 0, 255]);
      await sharp(Buffer.from(vis), { raw: { width: W, height: H, channels: 4 } }).resize(360).png().toFile(`${process.env.DUMP_DIR ?? '.'}/scene-${t}.png`);
    }
    const t1 = performance.now();
    const refined = refineQuad(img, coarse);
    tRefine += performance.now() - t1;
    const er = cornerError(refined, quad) / cardH;
    errsR.push(er);
    if (er < 0.015) goodRefined++;
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? NaN;
  console.log(`trials ${trials}  detected ${found} (${((100 * found) / trials).toFixed(0)}%)`);
  console.log(`coarse  <3% err: ${good}  median err ${(100 * med(errs)).toFixed(2)}% of card height`);
  console.log(`refined <1.5% err: ${goodRefined}  median err ${(100 * med(errsR)).toFixed(2)}%`);
  console.log(`avg detect ${(tDetect / trials).toFixed(1)} ms @240px, refine ${(tRefine / Math.max(1, found)).toFixed(1)} ms @${W}px`);
}

main();
