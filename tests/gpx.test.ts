import { describe, expect, it } from "vitest";

import { DemoAdb } from "../src/adb/demo";
import type { AdbDevice, Size } from "../src/adb/types";
import { BeelineApp, DOWNLOAD_DIR, gpxFilename, PROFILES } from "../src/beeline";
import { findOptionsButton } from "../src/parsing";

const instant = async (): Promise<void> => {};

/**
 * Wraps a DemoAdb to emulate the real Android layout where `/sdcard` is a symlink
 * to `/storage/emulated/0`. `readlink -f /sdcard` resolves it, and any command or
 * path using the real root is translated back to `/sdcard` for the inner fake (and
 * results translated forward), so the export must work via the resolved root.
 */
const REAL_ROOT = "/storage/emulated/0";
class SymlinkedSdcardAdb implements AdbDevice {
  constructor(private readonly inner: DemoAdb) {}
  model(): Promise<string> {
    return this.inner.model();
  }
  screenSize(): Promise<Size> {
    return this.inner.screenSize();
  }
  currentFocus(): Promise<string> {
    return this.inner.currentFocus();
  }
  isPackageInstalled(): Promise<boolean> {
    return this.inner.isPackageInstalled();
  }
  uiDump(): Promise<string> {
    return this.inner.uiDump();
  }
  tap(x: number, y: number): Promise<void> {
    return this.inner.tap(x, y);
  }
  swipe(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    return this.inner.swipe(x1, y1, x2, y2);
  }
  back(): Promise<void> {
    return this.inner.back();
  }
  launch(): Promise<void> {
    return this.inner.launch();
  }
  async shell(command: string): Promise<string> {
    if (/readlink\s+-f\s+\/sdcard/.test(command)) return `${REAL_ROOT}\n`;
    const inward = command.split(REAL_ROOT).join("/sdcard");
    const out = await this.inner.shell(inward);
    return out.split("/sdcard").join(REAL_ROOT);
  }
  readFile(remotePath: string): Promise<Uint8Array> {
    return this.inner.readFile(remotePath.split(REAL_ROOT).join("/sdcard"));
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Emulates Android's SAF "Save" de-duplication: when a file already exists, the
 * new export is named "ride.gpx (1)", "ride.gpx (2)", … with the counter AFTER
 * the extension. The export flow must still detect that file, which only works if
 * the `find` matches the " (N)" suffix (a plain `*.gpx` glob would miss it).
 *
 * UI is delegated to an inner DemoAdb; this wrapper owns a tiny glob-aware FS,
 * pre-seeded with a colliding "ride.gpx" so any new export must dedup.
 */
const DL = "/sdcard/Download";
class SafDedupAdb implements AdbDevice {
  private fs = new Map<string, Uint8Array>([[`${DL}/ride.gpx`, new TextEncoder().encode("seed")]]);
  private imported = new Set<string>();
  private counter = 0;
  constructor(private readonly inner: DemoAdb) {}
  model(): Promise<string> {
    return this.inner.model();
  }
  screenSize(): Promise<Size> {
    return this.inner.screenSize();
  }
  currentFocus(): Promise<string> {
    return this.inner.currentFocus();
  }
  isPackageInstalled(): Promise<boolean> {
    return this.inner.isPackageInstalled();
  }
  uiDump(): Promise<string> {
    return this.inner.uiDump();
  }
  tap(x: number, y: number): Promise<void> {
    return this.inner.tap(x, y);
  }
  swipe(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    return this.inner.swipe(x1, y1, x2, y2);
  }
  back(): Promise<void> {
    return this.inner.back();
  }
  launch(): Promise<void> {
    return this.inner.launch();
  }

  /** Pull any GPX the inner demo just "saved" into our FS under a SAF-deduped name. */
  private async syncFromInner(): Promise<void> {
    const listing = await this.inner.shell(`ls -1 ${DL}`);
    for (const name of listing.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (!name.toLowerCase().endsWith(".gpx") || this.imported.has(name)) continue;
      this.imported.add(name);
      const bytes = await this.inner.readFile(`${DL}/${name}`);
      this.fs.set(`${DL}/ride.gpx (${++this.counter})`, bytes); // dedup suffix after extension
    }
  }

  async shell(command: string): Promise<string> {
    if (/\breadlink\b/.test(command)) return "/sdcard\n";
    if (/\bfind\b/.test(command) && /\.gpx/i.test(command)) {
      await this.syncFromInner();
      const matchSuffix = command.includes("*.gpx (*)");
      const hits = [...this.fs.keys()].filter(
        (p) => p.toLowerCase().endsWith(".gpx") || (matchSuffix && /\.gpx \(\d+\)$/.test(p)),
      );
      return hits.join("\n") + (hits.length ? "\n" : "");
    }
    if (/\bstat\b/.test(command)) {
      const args = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      return args.map((p, i) => `${1000 + i} ${p}`).join("\n") + (args.length ? "\n" : "");
    }
    if (/\bmv\b/.test(command)) {
      const args = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const [src, dst] = [args[args.length - 2], args[args.length - 1]];
      const bytes = this.fs.get(src);
      if (bytes) {
        this.fs.delete(src);
        this.fs.set(dst, bytes);
      }
      return "";
    }
    if (/\bls\b/.test(command)) {
      return [...this.fs.keys()].map((p) => p.split("/").pop()).join("\n") + "\n";
    }
    return "";
  }
  readFile(remotePath: string): Promise<Uint8Array> {
    const bytes = this.fs.get(remotePath);
    if (!bytes) throw new Error(`no such file: ${remotePath}`);
    return Promise.resolve(bytes);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

describe("gpxFilename", () => {
  it("derives a stable, slugified name from the ride key", () => {
    expect(gpxFilename("Sat Jun 13 2026 at 14:22")).toBe("Beeline-Sat-Jun-13-2026-at-14-22.gpx");
  });

  it("maps different rides to different names and the same ride to one name", () => {
    const a = gpxFilename("Sat Jun 13 2026 at 14:22");
    const b = gpxFilename("Fri Jun 12 2026 at 09:10");
    expect(a).not.toBe(b);
    expect(gpxFilename("Sat Jun 13 2026 at 14:22")).toBe(a);
  });
});

describe("downloadGpx (export flow)", () => {
  it("pulls a GPX under an app-driven name regardless of Beeline's filename", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    const key = "Sat Jun 13 2026 at 14:22";

    const files = await app.downloadGpx(new Set([key]));
    expect(files).toHaveLength(1);
    expect(files[0].key).toBe(key);
    expect(files[0].filename).toBe(gpxFilename(key));
    expect(files[0].bytes.byteLength).toBeGreaterThan(0);
  });

  it("does not accumulate colliding files when the same ride is exported twice", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    const key = "Sat Jun 13 2026 at 14:22";

    await app.downloadGpx(new Set([key]));
    await app.downloadGpx(new Set([key]));

    // Exactly one stable file remains on the device for this ride.
    const listing = await demo.shell(`ls -1 ${DOWNLOAD_DIR}`);
    const names = listing.split("\n").filter((n) => n.trim().toLowerCase().endsWith(".gpx"));
    expect(names).toEqual([gpxFilename(key)]);
  });

  it("finds the export when /sdcard is a symlink to /storage/emulated/0", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(new SymlinkedSdcardAdb(demo), PROFILES.normal, instant);
    const key = "Sat Jun 13 2026 at 14:22";

    const files = await app.downloadGpx(new Set([key]));
    expect(files).toHaveLength(1);
    expect(files[0].key).toBe(key);
    expect(files[0].filename).toBe(gpxFilename(key));
    expect(files[0].bytes.byteLength).toBeGreaterThan(0);
  });

  it("detects a SAF-deduplicated export named 'ride.gpx (N)'", async () => {
    const app = await BeelineApp.create(new SafDedupAdb(new DemoAdb()), PROFILES.normal, instant);
    const key = "Sat Jun 13 2026 at 14:22";

    const files = await app.downloadGpx(new Set([key]));
    expect(files).toHaveLength(1);
    expect(files[0].key).toBe(key);
    expect(files[0].filename).toBe(gpxFilename(key));
    expect(files[0].bytes.byteLength).toBeGreaterThan(0);
  });

  it("reveals Options after reading the detail scrolls it off-screen", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    const key = "Sat Jun 13 2026 at 14:22";

    // Reading the detail swipes the sheet up to expose the action buttons, which
    // hides the top-right "Options" header — the exact condition that used to make
    // the export fail with "could not find Options".
    await app.openJourneys();
    const card = (await app.listCards()).find((c) => c.key === key)!;
    await app.openCard(card);
    await app.readDetail();
    expect(findOptionsButton(await demo.uiDump())).toBeNull();

    // revealOptions must scroll it back into view, and the full export succeeds.
    expect(await app.revealOptions()).not.toBeNull();
    await app.closeDetail();

    const files = await app.downloadGpx(new Set([key]));
    expect(files).toHaveLength(1);
    expect(files[0].key).toBe(key);
    expect(files[0].filename).toBe(gpxFilename(key));
    expect(files[0].bytes.byteLength).toBeGreaterThan(0);
  });
});
