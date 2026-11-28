// Scans the clip, then exercises export (CSV + Mass Entry), variant switching, collection.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [clip, outDir] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4173/#scan');
await page.waitForFunction(() => /^[3-9] cards/.test(document.querySelector('.tray .total span')?.textContent ?? ''), null, { timeout: 180000 });
// pause the scanner so the clip doesn't keep adding cards
await page.click('button[aria-label="Pause scanning"]');
await page.click('.tabbar button:nth-child(2)');
await page.waitForTimeout(500);
// variant switch on the SV Pikachu
await page.click('.item:has-text("151")');
await page.waitForTimeout(500);
const before = await page.textContent('.price-cell.main b');
await page.click('.chip:has-text("Reverse")');
await page.waitForTimeout(300);
const after = await page.textContent('.price-cell.main b');
await page.click('.chip:has-text("LP")');
await page.waitForTimeout(300);
const lp = await page.textContent('.price-cell.main b');
console.log(`SV Pikachu price normal ${before} -> reverse ${after} -> reverse LP ${lp}`);
await page.click('button:has-text("Add to collection")');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// export
await page.click('button[aria-label="Export"]');
const [csv] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download CSV")')]);
const csvText = readFileSync(await csv.path(), 'utf8');
console.log('CSV:', csv.suggestedFilename(), '\n' + csvText.split('\r\n').slice(0, 4).join('\n'));
await page.click('button[aria-label="Export"]');
const [mass] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("TCGplayer Mass Entry")')]);
console.log('Mass Entry:\n' + readFileSync(await mass.path(), 'utf8'));
// collection
await page.click('.tabbar button:nth-child(3)');
await page.waitForTimeout(500);
console.log('collection:', (await page.textContent('.page-head .sub'))?.trim(), '|', (await page.$$eval('.set-row', (r) => r.map((x) => x.textContent?.replace(/\s+/g, ' ').trim()))).join(' ; '));
await page.screenshot({ path: `${outDir}/s7-collection.png` });
console.log('page errors:', errors);
await browser.close();
