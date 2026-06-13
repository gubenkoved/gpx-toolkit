/**
 * DemoAdb — a stateful in-memory fake `AdbDevice`.
 *
 * It renders valid Beeline `uiautomator` XML (list + detail screens) and reacts to
 * taps/swipes/back, so the ENTIRE app — parsing, orchestration, jobs, UI — runs
 * end-to-end in the browser with no phone attached. This backs both the phone-free
 * demo mode and the integration tests.
 *
 * Layout note: bounds are chosen so the real `parsing` rules pick titles/stats/
 * buttons correctly (column-aligned titles, value-above-label stats, topmost
 * action = Strava). Geometry assumes a 1080×2400 screen, matching `Geometry`.
 */

import { AdbError, type AdbDevice, type Size } from "./types";
import { DETAIL_STAT_LABELS } from "../parsing";

interface DemoRide {
  key: string;
  title: string;
  distance: string;
  duration: string;
  stats: Record<string, string>;
  status: "pending" | "processing" | "uploaded";
}

const VISIBLE = 6;
const PITCH = 260;
const BASE0 = 360;

function bnd(l: number, t: number, r: number, b: number): string {
  return `[${l},${t}][${r},${b}]`;
}

function node(text: string, bounds: string): string {
  return `<node text="${escapeXml(text)}" bounds="${bounds}" />`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build a believable set of demo rides, newest first. */
function makeRides(): DemoRide[] {
  const seeds: Array<[string, string, string, string]> = [
    ["Sat Jun 13 2026 at 14:22", "Afternoon ride", "22.6km", "1:37:52"],
    ["Fri Jun 12 2026 at 09:10", "Morning commute", "8.4km", "0:31:20"],
    ["Wed Jun 10 2026 at 18:02", "Evening loop", "15.1km", "0:54:11"],
    ["Tue Jun 9 2026 at 18:29", "River path", "19.8km", "1:12:03"],
    ["Sun Jun 7 2026 at 11:45", "Sunday long ride", "41.2km", "2:18:40"],
    ["Sat Jun 6 2026 at 15:30", "Hill repeats", "12.0km", "0:48:55"],
    ["Thu Jun 4 2026 at 07:50", "Sunrise spin", "10.3km", "0:36:12"],
    ["Mon Jun 1 2026 at 19:05", "After work", "14.7km", "0:52:30"],
    ["Sat May 30 2026 at 10:20", "Coastal route", "33.5km", "1:54:09"],
    ["Wed May 27 2026 at 17:40", "Quick blast", "7.1km", "0:24:48"],
    ["Sun May 24 2026 at 12:00", "Forest trail", "26.9km", "1:41:33"],
    ["Fri May 22 2026 at 08:15", "Commute in", "8.6km", "0:29:57"],
    ["Tue May 19 2026 at 18:50", "Tempo ride", "18.2km", "0:58:22"],
    ["Sun May 17 2026 at 12:29", "Lakeside", "22.2km", "2:15:26"],
  ];
  return seeds.map(([key, title, distance, duration], i) => ({
    key,
    title,
    distance,
    duration,
    status: i < 9 ? "pending" : "uploaded",
    stats: {
      Distance: distance,
      "Average speed": "20.0km/h",
      "Max speed": "57.0km/h",
      "Moving time": duration,
      "Elapsed time": duration,
      "Elevation gain": "25m",
      "Elevation loss": "34m",
    },
  }));
}

const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Build `count` synthetic rides, newest-first, spaced a few days apart back from
 * mid-2026. Used by tests that need a list long enough to exercise the coarse
 * far-scroll phase (the built-in {@link makeRides} set is intentionally short).
 */
export function makeDemoRides(count: number): DemoRide[] {
  const start = new Date(2026, 5, 13, 14, 22, 0, 0); // newest ride
  const rides: DemoRide[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() - i * 3); // every ~3 days back in time
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const key =
      `${WEEKDAY_ABBR[d.getDay()]} ${MONTH_ABBR[d.getMonth()]} ${d.getDate()} ` +
      `${d.getFullYear()} at ${hh}:${mm}`;
    rides.push({
      key,
      title: `Ride ${i + 1}`,
      distance: "10.0km",
      duration: "0:40:00",
      status: "pending",
      stats: {
        Distance: "10.0km",
        "Average speed": "20.0km/h",
        "Max speed": "40.0km/h",
        "Moving time": "0:40:00",
        "Elapsed time": "0:40:00",
        "Elevation gain": "10m",
        "Elevation loss": "10m",
      },
    });
  }
  return rides;
}

type DemoView = "list" | "detail" | "options" | "share" | "downloading" | "saf";

export class DemoAdb implements AdbDevice {
  private readonly size: Size;
  private rides: DemoRide[];
  private view: DemoView = "list";
  private offset = 0;
  private detailIndex = -1;
  private revealed = false;
  private uploadPolls = 0;
  /** /sdcard/Download contents — filename → bytes (populated by the GPX export flow). */
  private readonly downloads = new Map<string, Uint8Array>();
  /** Remaining "Downloading GPX route" reads before the save dialog appears. */
  private downloadTicks = 0;
  /** Number of swipes performed while on the Journeys list (test/diagnostic hook). */
  listScrolls = 0;
  /** Number of uiautomator dumps served — the dominant real-device cost (test hook). */
  uiDumps = 0;
  /** Remaining list swipes to silently swallow — simulates flings that fail to register. */
  private missSwipes = 0;

  constructor(opts: { rides?: DemoRide[]; size?: Size; latencyMs?: number } = {}) {
    this.size = opts.size ?? { width: 1080, height: 2400 };
    this.rides = opts.rides ?? makeRides();
    this.latencyMs = opts.latencyMs ?? 0;
  }

  private readonly latencyMs: number;

  /** Test hook: simulate the user deleting a ride in the Beeline app. */
  removeRide(key: string): void {
    this.rides = this.rides.filter((r) => r.key !== key);
    this.view = "list";
    this.detailIndex = -1;
    this.revealed = false;
  }

  /**
   * Test hook: make the next `n` Journeys-list swipes do nothing (the gesture is
   * still counted, but the list does not move) — reproduces a flaky touch/fling
   * that fails to register, which navigation must recover from rather than treat
   * as the end of the list.
   */
  missNextSwipes(n: number): void {
    this.missSwipes = n;
  }

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async model(): Promise<string> {
    await this.tick();
    return "Demo Pixel (no phone)";
  }

  async screenSize(): Promise<Size> {
    await this.tick();
    return this.size;
  }

  async currentFocus(): Promise<string> {
    await this.tick();
    return "mCurrentFocus=Window{0 u0 co.beeline/co.beeline.MainActivity}";
  }

  async isPackageInstalled(): Promise<boolean> {
    await this.tick();
    return true;
  }

  async uiDump(): Promise<string> {
    await this.tick();
    this.uiDumps++;
    if (this.view === "options") return this.renderOptions();
    if (this.view === "share") return this.renderShare();
    if (this.view === "downloading") {
      if (this.downloadTicks > 0) {
        this.downloadTicks--;
        return this.renderDownloading();
      }
      this.view = "saf"; // export finished → the system save dialog appears
    }
    if (this.view === "saf") return this.renderSaf();
    if (this.view === "detail" && this.detailIndex >= 0) {
      // Flip processing → uploaded once a detail has been re-read post-upload.
      const ride = this.rides[this.detailIndex];
      if (ride.status === "processing") {
        if (this.uploadPolls > 0) this.uploadPolls--;
        else ride.status = "uploaded";
      }
      return this.renderDetail(ride);
    }
    return this.renderList();
  }

  async tap(x: number, y: number): Promise<void> {
    await this.tick();
    // GPX export sub-flow screens are handled first (their controls can sit in the
    // bottom-nav band, so they must take precedence over the Journeys-tab check).
    if (this.view === "options") {
      if (y >= 632 && y <= 769) this.view = "share"; // "Share/download" row
      return;
    }
    if (this.view === "share") {
      if (y >= 343 && y <= 469 && x < 300) {
        this.view = "detail"; // Back
      } else if (y >= 537 && y <= 674) {
        this.view = "downloading"; // "Share/download ridden route"
        this.downloadTicks = 2;
      }
      return;
    }
    if (this.view === "downloading") {
      if (x >= 820 && y >= 1251 && y <= 1377) this.view = "detail"; // Cancel
      return;
    }
    if (this.view === "saf") {
      if (x >= 700 && y >= 1980 && y <= 2080) {
        this.writeGpx(); // Save → file lands in /sdcard/Download
        this.view = "detail";
      }
      return;
    }
    if (this.view !== "detail" && y > this.size.height * 0.9) {
      // bottom-nav "Journeys" tab → land on the list. A ride-detail bottom-sheet
      // covers the nav bar, so while it's open a tap down here hits the sheet, not
      // the tab — only Back dismisses a detail (mirrors the real device).
      this.view = "list";
      this.detailIndex = -1;
      this.revealed = false;
      return;
    }
    if (this.view === "list") {
      const s = Math.round((y - (BASE0 + 71)) / PITCH);
      const idx = this.offset + s;
      if (s >= 0 && s < VISIBLE && idx >= 0 && idx < this.rides.length) {
        this.detailIndex = idx;
        this.view = "detail";
        this.revealed = false;
      }
      return;
    }
    // detail view: "Options" button (top-right) opens the journey options dialog.
    if (x >= 700 && y >= 151 && y <= 277) {
      this.view = "options";
      return;
    }
    // detail view: Strava button tap (only meaningful once revealed).
    if (this.revealed && this.detailIndex >= 0 && y >= 1800 && y <= 1900) {
      const ride = this.rides[this.detailIndex];
      if (ride.status === "pending") {
        ride.status = "processing";
        this.uploadPolls = 1; // one "processing" read, then "uploaded".
      }
    }
  }

  async swipe(
    _x1: number,
    y1: number,
    _x2: number,
    y2: number,
    duration = 300,
  ): Promise<void> {
    await this.tick();
    if (this.view === "list") {
      this.listScrolls++;
      if (this.missSwipes > 0) {
        this.missSwipes--; // simulate a missed gesture: counted, but no movement
        return;
      }
      // A quick flick (short duration) carries momentum and coasts several rows
      // further than a slow controlled drag; its reach scales with travel. The
      // slow drag keeps its original fixed 5-row step so existing behaviour and
      // tests are unchanged.
      const frac = Math.abs(y1 - y2) / this.size.height;
      const step = duration <= 150 ? Math.max(6, Math.round(frac * 18)) : 5;
      const maxOffset = Math.max(0, this.rides.length - VISIBLE);
      if (y1 > y2) this.offset = Math.min(this.offset + step, maxOffset); // scroll down
      else this.offset = Math.max(this.offset - step, 0); // scroll up
    } else if (this.view === "detail" && y1 > y2) {
      this.revealed = true; // reveal the bottom-sheet action buttons
    }
  }

  async back(): Promise<void> {
    await this.tick();
    if (this.view === "detail") {
      this.view = "list";
      this.detailIndex = -1;
      this.revealed = false;
    }
  }

  async launch(): Promise<void> {
    await this.tick();
    this.view = "list";
  }

  async shell(command: string): Promise<string> {
    await this.tick();
    // Rename our export to its stable app-driven name (rm -f dst && mv src dst).
    if (/\bmv\b/.test(command)) {
      const args = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      if (args.length >= 2) {
        const src = args[args.length - 2].split("/").pop()!;
        const dst = args[args.length - 1].split("/").pop()!;
        const bytes = this.downloads.get(src);
        if (bytes) {
          this.downloads.delete(src);
          this.downloads.set(dst, bytes);
        }
      }
      return "";
    }
    // Recursive .gpx inventory used by the GPX-export detection diff. Every fake
    // download lives in /sdcard/Download; report each as an absolute path.
    if (/\bfind\b/.test(command) && /\.gpx/i.test(command)) {
      const lines = [...this.downloads.keys()].map((n) => `/sdcard/Download/${n}`);
      return lines.join("\n") + (lines.length ? "\n" : "");
    }
    // mtimes for the newest-of-several tiebreak: emit increasing values in arg order.
    if (/\bstat\b/.test(command)) {
      const args = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      return args.map((p, i) => `${1000 + i} ${p}`).join("\n") + (args.length ? "\n" : "");
    }
    if (/\bls\b/.test(command) && command.includes("/sdcard/Download")) {
      return [...this.downloads.keys()].join("\n") + (this.downloads.size ? "\n" : "");
    }
    return "";
  }

  async readFile(remotePath: string): Promise<Uint8Array> {
    await this.tick();
    const name = remotePath.split("/").pop() ?? remotePath;
    const bytes = this.downloads.get(name);
    if (!bytes) throw new AdbError(`no such file on device: ${remotePath}`);
    return bytes;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  // -- GPX export --------------------------------------------------------

  /** Write a synthetic GPX for the open ride into the fake Downloads folder. */
  private writeGpx(): void {
    if (this.detailIndex < 0) return;
    const ride = this.rides[this.detailIndex];
    const name = `Beeline ${ride.title} (${this.detailIndex}).gpx`;
    this.downloads.set(name, new TextEncoder().encode(synthGpx(ride)));
  }

  // -- rendering ---------------------------------------------------------

  private renderList(): string {
    const parts: string[] = [
      node("Journeys", bnd(42, 214, 308, 291)),
      node("Heatmap", bnd(816, 231, 996, 282)),
    ];
    const page = this.rides.slice(this.offset, this.offset + VISIBLE);
    page.forEach((ride, s) => {
      const base = BASE0 + s * PITCH;
      parts.push(node(ride.title, bnd(240, base, 720, base + 44)));
      parts.push(node(ride.key, bnd(240, base + 50, 760, base + 92)));
      parts.push(node(ride.duration, bnd(288, base + 98, 429, base + 142)));
      parts.push(node(ride.distance, bnd(524, base + 98, 670, base + 142)));
    });
    return wrap(parts);
  }

  private renderDetail(ride: DemoRide): string {
    const parts: string[] = [
      node("Options", bnd(846, 190, 996, 239)),
      node(`${ride.title}, Demo City`, bnd(120, 300, 820, 360)),
      node(ride.key, bnd(120, 380, 780, 430)),
    ];
    DETAIL_STAT_LABELS.forEach((label, j) => {
      const valueTop = 470 + j * 120;
      const value = ride.stats[label] ?? "—";
      parts.push(node(value, bnd(120, valueTop, 420, valueTop + 45)));
      parts.push(node(label, bnd(120, valueTop + 50, 420, valueTop + 95)));
    });
    if (this.revealed) {
      const stravaText =
        ride.status === "pending"
          ? "Upload to"
          : ride.status === "processing"
            ? "upload processing"
            : "View on";
      parts.push(node(stravaText, bnd(120, 1800, 960, 1900))); // Strava (topmost)
      parts.push(node("Upload to", bnd(120, 1950, 960, 2050))); // komoot (below)
    }
    return wrap(parts);
  }

  private renderOptions(): string {
    return wrap([
      node("Journey options", bnd(364, 377, 716, 435)),
      node("Rename", bnd(158, 539, 996, 588)),
      node("Share/download", bnd(158, 676, 957, 725)),
      node("Delete journey", bnd(158, 813, 996, 862)),
    ]);
  }

  private renderShare(): string {
    return wrap([
      node("Back", bnd(123, 382, 219, 431)),
      node("Share/download", bnd(361, 377, 719, 435)),
      node("Share/download ridden route", bnd(158, 581, 996, 630)),
    ]);
  }

  private renderDownloading(): string {
    return wrap([
      node("Downloading GPX route", bnd(84, 1284, 822, 1342)),
      node("Cancel", bnd(864, 1251, 996, 1377)),
      node("4%", bnd(84, 1380, 200, 1438)),
    ]);
  }

  private renderSaf(): string {
    const ride = this.detailIndex >= 0 ? this.rides[this.detailIndex] : null;
    const fname = ride ? `Beeline ${ride.title}.gpx` : "route.gpx";
    return wrap([
      node("Downloads", bnd(189, 196, 464, 273)),
      node(fname, bnd(84, 800, 900, 870)),
      node("Cancel", bnd(520, 1980, 700, 2050)),
      node("Save", bnd(820, 1980, 1010, 2050)),
    ]);
  }
}

/** A small but valid GPX track that exercises trkpt parsing + simplification. */
function synthGpx(ride: DemoRide): string {
  const N = 64;
  const lat0 = 52.37;
  const lon0 = 4.9;
  const pts: string[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const lat = lat0 + 0.03 * t + 0.004 * Math.sin(t * Math.PI * 6);
    const lon = lon0 + 0.05 * t + 0.004 * Math.cos(t * Math.PI * 5);
    pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<gpx version="1.1" creator="Beeline"><trk><name>${escapeXml(ride.title)}</name>` +
    `<trkseg>${pts.join("")}</trkseg></trk></gpx>`
  );
}

function wrap(parts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${parts.join("")}</hierarchy>`;
}
