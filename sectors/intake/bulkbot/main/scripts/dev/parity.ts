/** Checks that TF.js (Node) reproduces the Keras reference output stored in parity.json. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTf } from '../lib/tf';

const dir = join(process.cwd(), 'public', 'models', 'cardnet-v1');
const { tf, loadGraphModel, native } = await loadTf();
const model = await loadGraphModel(join(dir, 'model.json'));
const H = 320;
const W = 224;
const x = new Float32Array(H * W * 3);
for (let h = 0; h < H; h++) for (let w = 0; w < W; w++) for (let c = 0; c < 3; c++) x[(h * W + w) * 3 + c] = (h * 7 + w * 13 + c * 29) % 256;
const t0 = performance.now();
const out = model.execute(tf.tensor4d(x, [1, H, W, 3]));
const y = (await (Array.isArray(out) ? out[0] : out).data()) as Float32Array;
const ref = JSON.parse(readFileSync(join(dir, 'parity.json'), 'utf8')) as { first16: number[]; sum: number };
let sum = 0;
for (const v of y) sum += v;
let maxd = 0;
ref.first16.forEach((r, i) => (maxd = Math.max(maxd, Math.abs(r - y[i]))));
console.log(`native=${native} ${(performance.now() - t0).toFixed(0)}ms dim=${y.length} sum=${sum.toFixed(3)} (ref ${ref.sum.toFixed(3)}) max|diff| first16=${maxd.toExponential(2)}`);
if (maxd > 5e-3 || Math.abs(sum - ref.sum) > 0.05 * Math.abs(ref.sum)) {
  console.error('PARITY FAILED');
  process.exit(1);
}
console.log('parity OK');
