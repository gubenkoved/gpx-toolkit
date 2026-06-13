// Regenerates docs/screenshot.png from the live demo-mode UI.
//
// Usage:
//   npm run dev                         # in another terminal (note the printed port)
//   npm install --no-save playwright    # one-off, not added to package.json
//   npx playwright install chromium
//   APP_URL=http://localhost:5173/ node docs/capture.mjs
//
// It scans the full "All" range so the chart, KPIs, and ride groups are populated,
// then clips the shot to the content height.
import { chromium } from 'playwright';

const url = process.env.APP_URL ?? 'http://localhost:5174/';
const out = process.env.OUT ?? 'docs/screenshot.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });

// Let the app finish wiring up demo mode before driving it.
await page.waitForTimeout(1500);
await page.click('button[data-preset="all"]');
await page.waitForSelector('button[data-preset="all"].active');

const rideCount = async () =>
  page.evaluate(() => {
    const m = (document.querySelector('.totals')?.textContent ?? '').match(/(\d+)\s+rides?/);
    return m ? Number(m[1]) : 0;
  });

// Scanning right after load can race the controller init; retry until rides land.
for (let attempt = 0; attempt < 6 && (await rideCount()) === 0; attempt++) {
  await page.click('#btnScan');
  await page.waitForFunction(() => /[1-9]\d*\s+rides?/.test(document.querySelector('.totals')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
}

// Wait for the scan progress toast to clear.
await page.waitForFunction(() => !document.body.innerText.includes('scan:'), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);

console.log('rides after scan:', await rideCount());

// Clip to the actual content height so there is no trailing empty space.
const contentHeight = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1280, height: Math.min(contentHeight + 24, 4000) } });
await browser.close();
console.log(`Saved ${out}`);
