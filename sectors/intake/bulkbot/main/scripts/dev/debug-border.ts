import sharp from 'sharp';
import { ensureImage } from '../lib/images';
import { borderScore } from '../../src/vision/quad';
import type { Quad } from '../../src/vision/homography';
const file = await ensureImage('https://images.pokemontcg.io/base1/58.png');
const { data, info } = await sharp(file!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
// place the card image unscaled onto a dark canvas
const W = info.width + 80, H = info.height + 80;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { rgba[i * 4] = 40; rgba[i * 4 + 1] = 40; rgba[i * 4 + 2] = 40; rgba[i * 4 + 3] = 255; }
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  const s = (y * info.width + x) * 4, d = ((y + 40) * W + x + 40) * 4, a = data[s + 3] / 255;
  for (let c = 0; c < 3; c++) rgba[d + c] = data[s + c] * a + 40 * (1 - a);
}
const q: Quad = [{ x: 40, y: 40 }, { x: 40 + info.width, y: 40 }, { x: 40 + info.width, y: 40 + info.height }, { x: 40, y: 40 + info.height }];
console.log('size', info.width, info.height, 'border score of true quad', borderScore(rgba, W, H, q).toFixed(3));
// print a horizontal profile through the middle-left border
const y = 40 + Math.round(info.height / 2);
console.log('row profile x=36..60:', Array.from({ length: 25 }, (_, i) => { const o = (y * W + 36 + i) * 4; return `${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}`; }).join(' | '));
