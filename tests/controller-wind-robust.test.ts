import { describe, expect, it, vi } from "vitest";

import { Controller } from "../src/controller";
import type { BlobStore } from "../src/kv";
import { beelineRideKey, rideUid } from "../src/parsing";
import { Store } from "../src/store";
import { memoryBackend } from "../src/kv";
import { encodePolyline, type LatLon } from "../src/track";
import type { WeatherDeps } from "../src/weather";
import { WindCache } from "../src/windcache";

function fakeWeather(): WeatherDeps {
  const fetchFn = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const lats = url.searchParams.get("latitude")!.split(",");
    const lons = url.searchParams.get("longitude")!.split(",");
    const start = url.searchParams.get("start_date") ?? "2020-06-13";
    const time: string[] = [];
    for (let h = 0; h < 24; h++) time.push(`${start}T${String(h).padStart(2, "0")}:00`);
    const locations = lats.map((lat, i) => ({
      latitude: Number(lat),
      longitude: Number(lons[i]),
      utc_offset_seconds: 0,
      hourly: {
        time,
        wind_speed_10m: new Array(24).fill(10),
        wind_direction_10m: new Array(24).fill(180),
        wind_gusts_10m: new Array(24).fill(15),
      },
    }));
    return Promise.resolve(new Response(JSON.stringify(locations.length === 1 ? locations[0] : locations)));
  };
  return { fetch: fetchFn as typeof fetch, now: () => Date.now(), sleep: () => Promise.resolve() };
}

/** A blob backend whose writes always fail (simulates a broken/blocked IndexedDB). */
function brokenBlobBackend(): BlobStore {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.reject(new DOMException("nope", "NotFoundError")),
    del: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  };
}

describe("wind resolution is robust to cache-write failure", () => {
  it("still produces wind when the cache write fails", async () => {
    const store = new Store(memoryBackend());
    const dateKey = beelineRideKey(Date.UTC(2020, 5, 13, 8, 0, 0));
    const uid = rideUid("gpx", dateKey);
    const points: LatLon[] = [
      [52.0, 13.0],
      [52.05, 13.0],
      [52.1, 13.0],
    ];
    store.upsert(uid, { source: "gpx", track: encodePolyline(points), distance_km: 11, elapsed_sec: 1800 });

    const errors: string[] = [];
    const windCache = await WindCache.load(brokenBlobBackend(), (m) => errors.push(m));
    const c = new Controller(async () => { throw new Error("no source"); }, store, undefined, undefined, windCache, fakeWeather());

    c.resolveWind([uid]);
    await vi.waitFor(() => expect(c.getRideWind(uid)).not.toBeNull(), { timeout: 5000 });

    const w = c.getRideWind(uid)!;
    expect(w.noData).toBeFalsy(); // wind STILL resolved despite the cache failing
    expect(w.pctTailwind).toBe(1);
    // The user got an actionable, detailed warning (not a bare "failed").
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("NotFoundError");
  });
});
