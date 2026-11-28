// Runs the same strip crop + Tesseract settings as the app on a card image, prints raw text + parse.
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { parseCardNumbers, parseRegulationMark, parseSetCode } from '../../src/shared/numbers';
const file = process.argv[2];
const meta = await sharp(file).metadata();
const W = meta.width!, H = meta.height!;
const strip = { x0: 0.03, y0: 0.875, x1: 0.97, y1: 0.98 };
const region = { left: Math.round(W * strip.x0), top: Math.round(H * strip.y0), width: Math.round(W * (strip.x1 - strip.x0)), height: Math.round(H * (strip.y1 - strip.y0)) };
const png = await sharp(file).extract(region).resize({ width: 960 }).grayscale().normalize().resize({ width: 1920 }).png().toBuffer();
await sharp(png).toFile('/tmp/claude-0/strip.png');
const worker = await Tesseract.createWorker('eng', 1, { langPath: 'node_modules/@tesseract.js-data/eng/4.0.0_best_int', gzip: true });
for (const psm of ['11', '6']) {
  await worker.setParameters({ tessedit_pageseg_mode: psm as never });
  const t0 = Date.now();
  const r = await worker.recognize(png);
  console.log(`psm ${psm} (${Date.now() - t0}ms):`, JSON.stringify(r.data.text));
  console.log('  numbers', parseCardNumbers(r.data.text), 'reg', parseRegulationMark(r.data.text), 'code', parseSetCode(r.data.text));
}
await worker.terminate();
