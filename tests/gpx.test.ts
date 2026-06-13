import { describe, expect, it } from "vitest";

import { DemoAdb } from "../src/adb/demo";
import type { AdbDevice, Size } from "../src/adb/types";
import { BeelineApp, DOWNLOAD_DIR, gpxFilename, PROFILES } from "../src/beeline";

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
});
