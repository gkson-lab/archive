// Compares the in-browser embedding (WebGL) against the Keras reference (parity.json).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const ref = JSON.parse(readFileSync('public/models/cardnet-v1/parity.json', 'utf8'));
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto('http://localhost:4173/?debug#settings');
await page.waitForFunction(() => window.bulkbotDebug && document.body.textContent.includes('Model ready'), null, { timeout: 120000 });
const res = await page.evaluate(async () => {
  const { embed, tf } = window.bulkbotDebug;
  const H = 320, W = 224;
  const x = new Float32Array(H * W * 3);
  for (let h = 0; h < H; h++) for (let w = 0; w < W; w++) for (let c = 0; c < 3; c++) x[(h * W + w) * 3 + c] = (h * 7 + w * 13 + c * 29) % 256;
  const y = await embed(x);
  let sum = 0; for (const v of y) sum += v;
  return { backend: tf.getBackend(), f32: tf.env().getBool('WEBGL_RENDER_FLOAT32_ENABLED'), sum, first16: Array.from(y.slice(0, 16)) };
});
let maxd = 0; ref.first16.forEach((r, i) => (maxd = Math.max(maxd, Math.abs(r - res.first16[i]))));
console.log(`backend=${res.backend} float32=${res.f32} sum=${res.sum.toFixed(3)} ref=${ref.sum.toFixed(3)} max|diff|=${maxd.toExponential(2)}`);
await browser.close();
