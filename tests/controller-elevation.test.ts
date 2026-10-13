/**
 * Climb re-derived from a ride's cached full track: noise-filtered, it replaces a
 * source's own (noisy) figure, survives a re-sync, and follows the noise setting.
 */

import { describe, expect, it, vi } from "vitest";
import { Controller } from "../src/controller";
import { GpxCache } from "../src/gpxcache";
import { memoryBackend } from "../src/kv";
import { rideUid } from "../src/parsing";
import { Store } from "../src/store";

/** A flat ride with ±1.5 m altitude jitter, then one real 30 m climb. */
function noisyGpx(): Uint8Array {
  let pts = "";
  for (let i = 0; i < 1200; i++) {
    const base = i < 900 ? 10 : 10 + (i - 900) * 0.1; // flat, then +30 m
    const ele = base + Math.sin(i * 1.7) * 1.5 + Math.sin(i * 0.37) * 0.6;
    const t = new Date(Date.UTC(2026, 9, 12, 17, 0, i)).toISOString();
    pts += `<trkpt lat="${(52 + i * 1e-4).toFixed(5)}" lon="4.9"><ele>${ele.toFixed(2)}</ele><time>${t}</time></trkpt>`;
  }
  return new TextEncoder().encode(
    `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts}</trkseg></trk></gpx>`,
  );
}

describe("Controller elevation from the cached track", () => {
  it("replaces the source's figure, keeps it over a re-sync, and follows the setting", async () => {
    const store = await Store.load(memoryBackend());
    const gpxCache = GpxCache.memory();
    const controller = new Controller(
      async () => {
        throw new Error("no source needed");
      },
      store,
      gpxCache,
      GpxCache.memory(),
    );
    const key = "Mon Oct 12 2026 at 19:08";
    const uid = rideUid("beeline", key);
    store.upsert(key, { title: "Evening ride", source: "beeline", elevation_gain_m: 260 });
    await gpxCache.put(uid, noisyGpx());

    const idle = () =>
      vi.waitFor(() => expect(controller.state().jobs.busy).toBe(false), { timeout: 5000 });
    controller.recomputeElevation();
    await idle();
    const filtered = store.rides.get(uid)!;
    expect(filtered.elevation_src).toBe("track");
    expect(filtered.elevation_gain_m).toBeGreaterThan(25);
    expect(filtered.elevation_gain_m).toBeLessThan(40);

    // A Beeline re-sync reports its own figure again: the track's stays.
    store.upsert(key, { elevation_gain_m: 262 });
    expect(store.rides.get(uid)!.elevation_gain_m).toBe(filtered.elevation_gain_m);

    // The raw sum (filter off) is the noisy one the source showed.
    controller.setElevationNoise(0);
    await idle();
    expect(store.rides.get(uid)!.elevation_gain_m).toBeGreaterThan(300);
  });
});
