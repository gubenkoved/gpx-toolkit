import { describe, expect, it } from "vitest";

import { DemoAdb } from "../src/adb/demo";
import { BeelineApp, DOWNLOAD_DIR, gpxFilename, PROFILES } from "../src/beeline";

const instant = async (): Promise<void> => {};

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
});
