/**
 * End-to-end recognition benchmark on synthetic camera captures.
 * For N random catalog cards: render the card's large image into a random phone-camera scene,
 * then run the real pipeline (detect -> refine -> warp -> embed -> project -> search).
 *   npx tsx scripts/dev/eval-recognition.ts [N] [--oracle]
 * --oracle warps with the ground-truth corners (isolates recognition from detection).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { deserializeProjection } from '../../src/shared/projection';
import { MODEL_H, MODEL_W } from '../../src/shared/preprocess';
import type { CardRecord, IndexManifest } from '../../src/shared/types';
import { VectorIndex } from '../../src/recognition/vindex';
import { portraitQuad, warpQuad, type Quad, type RgbaImage } from '../../src/vision/homography';
import { detectCard } from '../../src/vision/quad';
import { refineQuad } from '../../src/vision/refine';
import { ensureImage } from '../lib/images';
import { mapLimit } from '../lib/http';
import { loadTf } from '../lib/tf';
import { renderScene, rnd, toSmallRgba } from './scene';

const N = Number(process.argv[2] ?? 300);
const ORACLE = process.argv.includes('--oracle');
const NO_ALTS = process.argv.includes('--no-alts');
const ROOT = process.cwd();
const DATA = join(ROOT, 'public', 'data');

function blur(img: RgbaImage, sigma: number): RgbaImage {
  if (sigma < 0.3) return img;
  const r = Math.ceil(sigma * 2);
  const k: number[] = [];
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    s += v;
  }
  const kn = k.map((v) => v / s);
  const { width: w, height: h, data } = img;
  const tmp = new Float32Array(w * h * 4);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += data[(y * w + Math.min(w - 1, Math.max(0, x + i))) * 4 + c] * kn[i + r];
        tmp[(y * w + x) * 4 + c] = a;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += tmp[(Math.min(h - 1, Math.max(0, y + i)) * w + x) * 4 + c] * kn[i + r];
        out[(y * w + x) * 4 + c] = a;
      }
      out[(y * w + x) * 4 + 3] = 255;
    }
  return { data: out, width: w, height: h };
}

async function main() {
  const cards = new Map<string, CardRecord>();
  for (const f of await readdir(join(DATA, 'cards'))) for (const c of JSON.parse(await readFile(join(DATA, 'cards', f), 'utf8')) as CardRecord[]) cards.set(c.id, c);
  const m = JSON.parse(await readFile(join(DATA, 'index', 'manifest.json'), 'utf8')) as IndexManifest;
  const ids = JSON.parse(await readFile(join(DATA, 'index', m.ids), 'utf8')) as string[];
  const q = new Int8Array((await readFile(join(DATA, 'index', m.vectors))).buffer.slice(0));
  const sc = new Float32Array((await readFile(join(DATA, 'index', m.scales))).buffer.slice(0));
  const proj = deserializeProjection(await readFile(join(ROOT, 'public', 'models', 'cardnet-v1', 'projection.bin')));
  const index = new VectorIndex(ids, q, sc, m.dims, proj);
  const { tf, loadGraphModel } = await loadTf();
  const model = await loadGraphModel(join(ROOT, 'public', 'models', 'cardnet-v1', 'model.json'));

  // random sample with a large image available
  const pool = ids.filter((id) => cards.get(id)?.imgLarge);
  const picks: string[] = [];
  while (picks.length < N && pool.length) picks.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  const files = await mapLimit(picks, 12, async (id) => ensureImage(cards.get(id)!.imgLarge!).catch(() => null));

  let detected = 0;
  let top1 = 0;
  let top1Art = 0;
  let top3 = 0;
  let top10 = 0;
  let n = 0;
  const margins: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < picks.length; i++) {
    const file = files[i];
    if (!file) continue;
    const truth = picks[i];
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cardImg: RgbaImage = { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
    const scene = renderScene(cardImg, 720, 960);
    const img = blur(scene.img, rnd() * 1.4);
    n++;
    let quads: Quad[];
    if (ORACLE) quads = [scene.quad];
    else {
      const small = toSmallRgba(img, 240);
      const det = detectCard(small.g, small.w, small.h);
      if (!det) continue;
      const up = (q: Quad) => refineQuad(img, portraitQuad(q).map((p) => ({ x: p.x * small.s, y: p.y * small.s })) as Quad);
      quads = [up(det.quad), ...(NO_ALTS ? [] : (det.alternates ?? []).map(up))];
    }
    detected++;
    const run = async (quad: Quad) => {
      const warped = warpQuad(img, quad, MODEL_W, MODEL_H, undefined, 2);
      const rgb = new Float32Array(MODEL_W * MODEL_H * 3);
      for (let k = 0; k < MODEL_W * MODEL_H; k++) {
        rgb[k * 3] = warped.data[k * 4];
        rgb[k * 3 + 1] = warped.data[k * 4 + 1];
        rgb[k * 3 + 2] = warped.data[k * 4 + 2];
      }
      const out = tf.tidy(() => {
        const r = model.execute(tf.tensor4d(rgb, [1, MODEL_H, MODEL_W, 3]));
        return (Array.isArray(r) ? r[0] : r) as ReturnType<typeof tf.zeros>;
      });
      const feat = (await out.data()) as Float32Array;
      out.dispose();
      return index.search(index.embed(feat), 10);
    };
    let hits = await run(quads[0]);
    // weak match: the crop is probably wrong; let recognition verify the detector's alternates
    for (const alt of quads.slice(1)) {
      if (hits[0].score >= 0.55) break;
      const h2 = await run(alt);
      if (h2[0].score > hits[0].score) hits = h2;
    }
    const rank = hits.findIndex((h) => h.id === truth);
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 3) top3++;
    if (rank >= 0) top10++;
    const tc = cards.get(truth)!;
    const pc = cards.get(hits[0].id);
    const artEq = rank === 0 || (pc && pc.name === tc.name && index.similarity(truth, hits[0].id) > 0.93);
    if (artEq) top1Art++;
    if (rank === 0 && hits[1]) margins.push(hits[0].score - hits[1].score);
    if (process.env.VERBOSE && rank !== 0)
      console.log(`miss ${truth} (${tc.name}) -> ${hits[0].id} (${pc?.name}) ${hits[0].score.toFixed(3)}; truth rank ${rank} sim ${index.similarity(truth, hits[0].id).toFixed(3)}`);
  }
  const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
  console.log(`queries ${n}${ORACLE ? ' (oracle corners)' : ''}  detected ${pct(detected)}`);
  console.log(`top1 ${pct(top1)}  top1(same-art ok) ${pct(top1Art)}  top3 ${pct(top3)}  top10 ${pct(top10)}`);
  margins.sort((a, b) => a - b);
  console.log(`median margin when correct ${margins[Math.floor(margins.length / 2)]?.toFixed(3)}  ${((Date.now() - t0) / n).toFixed(0)} ms/query`);
}

main();
