// Runs detect -> refine -> warp -> embed -> search on one frame of a Y4M clip (debugging aid).
import { openSync, readSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { deserializeProjection } from '../../src/shared/projection';
import { MODEL_H, MODEL_W } from '../../src/shared/preprocess';
import type { IndexManifest } from '../../src/shared/types';
import { VectorIndex } from '../../src/recognition/vindex';
import { portraitQuad, warpQuad, type Quad } from '../../src/vision/homography';
import { detectCard } from '../../src/vision/quad';
import { refineQuad } from '../../src/vision/refine';
import { loadTf } from '../lib/tf';
import { toSmallRgba } from './scene';

const [clip, frameNo, out] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
const fd = openSync(clip, 'r');
const head = Buffer.alloc(200);
readSync(fd, head, 0, 200, 0);
const hl = head.indexOf(10);
const hdr = head.subarray(0, hl).toString();
const W = Number(/W(\d+)/.exec(hdr)![1]);
const H = Number(/H(\d+)/.exec(hdr)![1]);
const fsize = 6 + W * H * 1.5;
const buf = Buffer.alloc(W * H * 1.5);
readSync(fd, buf, 0, buf.length, hl + 1 + frameNo * fsize + 6);
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const Y = buf[y * W + x];
    const U = buf[W * H + (y >> 1) * (W >> 1) + (x >> 1)] - 128;
    const V = buf[W * H * 1.25 + (y >> 1) * (W >> 1) + (x >> 1)] - 128;
    const o = (y * W + x) * 4;
    rgba[o] = Y + 1.402 * V;
    rgba[o + 1] = Y - 0.344 * U - 0.714 * V;
    rgba[o + 2] = Y + 1.772 * U;
    rgba[o + 3] = 255;
  }
const img = { data: rgba, width: W, height: H };
const small = toSmallRgba(img, 240);
const det = detectCard(small.g, small.w, small.h);
if (!det) throw new Error('no card');
const q = refineQuad(img, portraitQuad(det.quad).map((p) => ({ x: p.x * small.s, y: p.y * small.s })) as Quad);
console.log('quad', q.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' '), 'border', det.border.toFixed(2));
const warped = warpQuad(img, q, MODEL_W, MODEL_H, undefined, 2);
await sharp(Buffer.from(warped.data), { raw: { width: MODEL_W, height: MODEL_H, channels: 4 } }).png().toFile(out);
const rgb = new Float32Array(MODEL_W * MODEL_H * 3);
for (let k = 0; k < MODEL_W * MODEL_H; k++) for (let c = 0; c < 3; c++) rgb[k * 3 + c] = warped.data[k * 4 + c];
const DATA = join(process.cwd(), 'public', 'data');
const m = JSON.parse(readFileSync(join(DATA, 'index', 'manifest.json'), 'utf8')) as IndexManifest;
const ids = JSON.parse(readFileSync(join(DATA, 'index', m.ids), 'utf8')) as string[];
const index = new VectorIndex(ids, new Int8Array(readFileSync(join(DATA, 'index', m.vectors)).buffer.slice(0)), new Float32Array(readFileSync(join(DATA, 'index', m.scales)).buffer.slice(0)), m.dims, deserializeProjection(readFileSync(join(process.cwd(), 'public/models/cardnet-v1/projection.bin'))));
const { tf, loadGraphModel } = await loadTf();
const model = await loadGraphModel(join(process.cwd(), 'public/models/cardnet-v1/model.json'));
const o = model.execute(tf.tensor4d(rgb, [1, MODEL_H, MODEL_W, 3]));
const feat = (await (Array.isArray(o) ? o[0] : o).data()) as Float32Array;
console.log(index.search(index.embed(feat), 5).map((h) => `${h.id}:${h.score.toFixed(3)}`).join('  '));
void readdirSync;
// draw main + alternate quads for inspection
if (process.env.DRAW) {
  const vis = new Uint8ClampedArray(rgba);
  const draw = (qq: Quad, col: number[]) => {
    for (let k = 0; k < 4; k++) {
      const a = qq[k], b = qq[(k + 1) % 4];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
      for (let i = 0; i <= n; i++) {
        const x = Math.round(a.x + ((b.x - a.x) * i) / n), y = Math.round(a.y + ((b.y - a.y) * i) / n);
        for (let d = -2; d <= 2; d++) { if (x + d < 0 || x + d >= W || y < 0 || y >= H) continue; const o2 = (y * W + x + d) * 4; vis[o2] = col[0]; vis[o2 + 1] = col[1]; vis[o2 + 2] = col[2]; }
      }
    }
  };
  draw(q, [255, 0, 255]);
  (det.alternates ?? []).forEach((a, i) => draw(a.map((p) => ({ x: p.x * small.s, y: p.y * small.s })) as Quad, [[0, 255, 0], [0, 200, 255], [255, 255, 0]][i]));
  await sharp(Buffer.from(vis), { raw: { width: W, height: H, channels: 4 } }).resize(360).png().toFile(process.env.DRAW);
}
