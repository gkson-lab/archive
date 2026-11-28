// Renders a deployed copy and reports what a visitor sees (deployment smoke test).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'] });
for (const url of process.argv.slice(2)) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(6000);
  const boot = await page.$eval('#boot', (e) => e.textContent?.trim()).catch(() => null);
  const pill = await page.$eval('.status-pill', (e) => e.textContent?.trim()).catch(() => null);
  const tabs = await page.$$eval('.tabbar button', (b) => b.length);
  console.log(`${url}\n  boot overlay: ${boot ?? '(gone)'}\n  status: ${pill ?? '-'}\n  tab bar buttons: ${tabs}`);
  await ctx.close();
}
await browser.close();
