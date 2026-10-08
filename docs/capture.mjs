// Regenerates the README screenshots from the demo library.
//
// Usage:
//   npm run dev                         # in another terminal (note the printed port)
//   npm install --no-save playwright    # one-off, not added to package.json
//   npx playwright install chromium
//   APP_URL=http://localhost:5173/ node docs/capture.mjs [name…]
//
// Pass shot names (e.g. `map forecast`) to capture only those. The map, weather and
// wind shots need network access to OpenStreetMap tiles and Open-Meteo.
//
// The Beeline demo fills the library once per browser context; the desktop shots then
// run in order on one page, so the wind and full tracks fetched for one shot are
// reused by the next.
import { chromium } from 'playwright';

const url = process.env.APP_URL ?? 'http://localhost:5173/';
const only = new Set(process.argv.slice(2));

// A point well inside the finest regional forecast models (HARMONIE, ICON-D2…).
const AMSTERDAM = 'lat=52.370216&lon=4.895168';

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const SHOTS = [
  { name: 'explore', file: 'docs/screenshot-explore.png', context: DESKTOP, run: async () => {} },
  { name: 'phone', file: 'docs/screenshot-phone.png', context: PHONE, run: async () => {} },
  {
    name: 'map',
    file: 'docs/screenshot-map.jpg',
    context: DESKTOP,
    run: async (page) => {
      await showView(page, 'map');
      await zoomToBusiest(page, '#allRidesMap');
    },
  },
  {
    name: 'stats',
    file: 'docs/screenshot-stats.jpg',
    context: DESKTOP,
    run: async (page) => {
      await showView(page, 'stats');
      await zoomToBusiest(page, '#freqHeatMap');
    },
  },
  {
    name: 'ride',
    file: 'docs/screenshot-ride.jpg',
    context: DESKTOP,
    run: async (page) => {
      await showView(page, 'explore');
      await page.locator('#rideList .rrow').first().click({ position: { x: 360, y: 20 } });
      await page.locator('#rideList .rmap-expand').first().click();
      await page.click('#btnRideMapFull');
      await page.waitForSelector('#rmtGraph:not(.hidden)', { timeout: 60000 });
      await page.click('#rideMapColor [data-color="speed"]');
      await page.click('#btnRideMapWeather');
      await page.waitForFunction(
        () => {
          const readout = document.getElementById('rideMapWeather');
          return readout && !readout.classList.contains('hidden') && !/resolving/i.test(readout.textContent);
        },
        null,
        { timeout: 120000 },
      );
      // The "Full track loaded" tick clears itself after a moment.
      await page.waitForFunction(() => !document.getElementById('rideMapStatus')?.textContent, null, { timeout: 15000 }).catch(() => {});
      await settleTiles(page);
    },
    after: (page) => page.keyboard.press('Escape'),
  },
  {
    name: 'wind-speed',
    file: 'docs/screenshot-wind-speed.png',
    context: DESKTOP,
    run: async (page) => {
      await showView(page, 'analytics');
      for (const prep of ['#analyticsResolveEmpty', '#analyticsFetchGpx', '#analyticsResolve']) {
        if (await page.locator(prep).isVisible()) {
          await page.click(prep);
          await waitForJobs(page, 300000);
        }
      }
      await page.click('#analyticsRun');
      await page.waitForSelector('#analyticsBody:not(.hidden) canvas', { timeout: 60000 });
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'forecast',
    file: 'docs/screenshot-forecast.jpg',
    context: DESKTOP,
    run: async (page) => {
      await page.evaluate((q) => (location.hash = `#/forecast?${q}`), AMSTERDAM);
      await page.waitForSelector('#forecastCharts canvas', { timeout: 120000 });
      // Models that come back empty are swapped out and fetched again.
      await page.waitForTimeout(4000);
      await settleTiles(page);
      // Hover the middle of the chart: the legend and the map show that hour.
      const box = await page.locator('#forecastCharts').boundingBox();
      await page.mouse.move(box.x + box.width * 0.55, box.y + Math.min(box.height, 600) * 0.4);
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'wind-rose',
    file: 'docs/screenshot-wind-rose.jpg',
    context: DESKTOP,
    run: async (page) => {
      await page.evaluate((q) => (location.hash = `#/wind-rose?${q}`), AMSTERDAM);
      await page.waitForSelector('#clSide svg', { timeout: 300000 });
      await page.waitForSelector('#clBanner.hidden', { state: 'attached', timeout: 300000 });
      await settleTiles(page);
    },
  },
].filter((s) => only.size === 0 || only.has(s.name));

/** Start the Beeline demo from the first-launch dialog and pull its rides. */
async function openDemoLibrary(page) {
  await page.goto(url, { waitUntil: 'load' });
  await page.click('#btnDemoBeeline');
  await page.click('#btnScan');
  await page.waitForFunction(() => /[1-9]\d* rides?/.test(document.body.innerText), null, { timeout: 30000 });
  await waitForJobs(page, 30000);
}

/** Wait until the activity strip and the toast have gone. */
async function waitForJobs(page, timeout) {
  await page.waitForTimeout(800);
  await page.waitForFunction(() => !document.querySelector('#job.show, #jobHandle.show'), null, { timeout });
  await page.waitForFunction(() => document.getElementById('toast')?.style.display !== 'block', null, { timeout: 30000 });
}

async function showView(page, view) {
  await page.locator(`.navlink[data-view="${view}"]`).first().click();
  await page.waitForTimeout(1500);
  await settleTiles(page);
}

/** Wait for every visible map tile to finish loading. */
async function settleTiles(page) {
  await page
    .waitForFunction(() => [...document.querySelectorAll('img.leaflet-tile')].every((t) => t.complete), null, { timeout: 30000 })
    .catch(() => console.warn('  map tiles still loading'));
  await page.waitForTimeout(800);
}

/**
 * Zoom a Leaflet map in on its busiest patch of drawn tracks (the demo rides loop
 * around three cities, so the fitted view shows three dots), then centre it.
 * Tracks and heat are painted on overlay canvases, so the patch is found by
 * counting painted pixels.
 */
async function zoomToBusiest(page, mapSel) {
  const busiest = () =>
    page.evaluate((sel) => {
      const host = document.querySelector(sel);
      const box = host.getBoundingClientRect();
      const pts = [];
      for (const c of host.querySelectorAll('.leaflet-overlay-pane canvas')) {
        const r = c.getBoundingClientRect();
        const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        for (let y = 0; y < height; y += 3) {
          for (let x = 0; x < width; x += 3) {
            if (data[(y * width + x) * 4 + 3] < 60) continue;
            const px = r.left + (x * r.width) / width;
            const py = r.top + (y * r.height) / height;
            if (px > box.left && py > box.top && px < box.right && py < box.bottom) pts.push([px, py]);
          }
        }
      }
      if (!pts.length) return null;
      const cell = 48;
      const counts = new Map();
      for (const [x, y] of pts) {
        const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const [cx, cy] = best.split(',').map((n) => (Number(n) + 0.5) * cell);
      const reach = Math.min(box.width, box.height) * 0.2;
      const near = pts.filter(([x, y]) => Math.hypot(x - cx, y - cy) < reach);
      const xs = near.map((p) => p[0]);
      const ys = near.map((p) => p[1]);
      return {
        x: xs.reduce((a, b) => a + b, 0) / xs.length,
        y: ys.reduce((a, b) => a + b, 0) / ys.length,
        span: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
        size: Math.min(box.width, box.height),
        center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      };
    }, mapSel);

  for (let i = 0; i < 10; i++) {
    const c = await busiest();
    if (!c || c.span > c.size * 0.3) break;
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(900);
  }
  const c = await busiest();
  if (c) {
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.center.x, c.center.y, { steps: 12 });
    await page.mouse.up();
  }
  await page.mouse.move(0, 0);
  await settleTiles(page);
}

// A failed shot doesn't stop the rest: what the page looked like is saved under
// .tmp/capture/ and the script exits non-zero at the end.
let failed = 0;
const browser = await chromium.launch();
for (const context of [DESKTOP, PHONE]) {
  const shots = SHOTS.filter((s) => s.context === context);
  if (!shots.length) continue;
  const ctx = await browser.newContext({ ...context, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await openDemoLibrary(page);
  for (const shot of shots) {
    try {
      await shot.run(page);
      await page.screenshot({ path: shot.file, ...(shot.file.endsWith('.jpg') ? { quality: 85 } : {}) });
      console.log(`Saved ${shot.file}`);
    } catch (err) {
      failed++;
      const debug = `.tmp/capture/${shot.name}-failed.png`;
      await page.screenshot({ path: debug }).catch(() => {});
      console.error(`Failed ${shot.name}: ${err.message.split('\n')[0]} (page saved to ${debug})`);
    }
    await shot.after?.(page);
  }
  await ctx.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;
