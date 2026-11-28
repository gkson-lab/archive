// Loads the app online once, then reloads offline: shell, catalog, model, index and search must still work.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4173/#settings');
await page.waitForFunction(() => document.body.textContent.includes('Model ready') && document.body.textContent.includes('cards indexed'), null, { timeout: 180000 });
await page.waitForTimeout(8000); // let the service worker take control and cache OCR assets
console.log('online load OK; sw controlled:', await page.evaluate(() => !!navigator.serviceWorker.controller));
await ctx.setOffline(true);
await page.reload();
await page.waitForFunction(() => document.body.textContent.includes('Model ready') && document.body.textContent.includes('cards indexed'), null, { timeout: 60000 });
const status = await page.$$eval('.setting .lbl', (els) => els.slice(-6).map((e) => e.textContent));
console.log('offline reload OK:', status.filter((s) => /Card|Model|Text/.test(s)).join(' | '));
await page.click('.tabbar button:nth-child(4)');
await page.fill('.search-box input', 'pikachu 58/102');
await page.waitForTimeout(800);
const ocrOk = await page.click('.tabbar button:nth-child(5)').then(() => page.waitForFunction(() => /Text reader ready|OCR unavailable/.test(document.body.textContent), null, { timeout: 60000 })).then(() => page.evaluate(() => document.body.textContent.match(/Text reader ready|OCR unavailable[^·]*/)?.[0])).catch(() => 'timeout');
console.log('offline OCR:', ocrOk);
console.log('offline search:', await page.$$eval('.item .main b', (els) => els.slice(0, 3).map((e) => e.textContent)));
console.log('page errors:', errors);
await browser.close();
