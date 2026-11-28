// End-to-end check in headless Chromium with a fake camera clip (Y4M).
//   npx vite preview --port 4173 &  node scripts/dev/e2e-scan.mjs <clip.y4m> <outdir> [seconds]
import { createRequire } from 'node:module';
// the pre-installed Playwright resolves through NODE_PATH, which only require() honors
const { chromium } = createRequire(import.meta.url)('playwright');
const [clip, outDir, secs = '16'] = process.argv.slice(2);
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const browser = await chromium.launch({
  proxy,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, permissions: ['camera'], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (t.includes('[bulkbot]')) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`, m.text()); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto('http://localhost:4173/?debug#scan');
// wait for model + index to be ready (status pill stops saying Downloading/Loading)
await page.waitForFunction(() => !document.querySelector('.status-pill')?.textContent?.match(/Downloading|Loading/), null, { timeout: 180000 });
console.log(`vision ready after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const tReady = Date.now();
let shot = 0;
while (Date.now() - tReady < Number(secs) * 1000) {
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${outDir}/scan-${shot++}.png` });
  const pill = await page.textContent('.status-pill').catch(() => '');
  const total = await page.textContent('.tray .total').catch(() => '');
  console.log(`t+${((Date.now() - tReady) / 1000).toFixed(0)}s pill="${pill}" tray="${total}"`);
}
if (await page.$('.sheet')) { console.log('choices sheet open:', await page.$$eval('.choice b', (e) => e.map((x) => x.textContent))); await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
await page.click('.tabbar button:nth-child(2)');
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/session.png` });
const rows = await page.$$eval('.item .main b', (els) => els.map((e) => e.textContent));
console.log('session rows:', rows);
console.log(logs.filter((l) => !l.includes('Download the React DevTools')).slice(-25).join('\n'));
await browser.close();
