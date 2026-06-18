import { describe, expect, it, vi } from "vitest";

import { Controller } from "../src/controller";
import { memoryBackend } from "../src/kv";
import { beelineRideKey, rideUid } from "../src/parsing";
import { Store } from "../src/store";
import { encodePolyline, type LatLon } from "../src/track";
import type { WeatherDeps } from "../src/weather";
import { WindCache } from "../src/windcache";

/**
 * A fake Open-Meteo that answers any multi-coordinate request from the URL: one
 * location per requested coordinate, each a full day of south wind (FROM 180°) at
 * 10 km/h. Counts calls so we can assert the global cache prevents refetches.
 */
function fakeWeather(): { deps: WeatherDeps; calls: () => number } {
  let calls = 0;
  const fetchFn = (input: string | URL | Request): Promise<Response> => {
    calls++;
    const url = new URL(String(input));
    const lats = url.searchParams.get("latitude")!.split(",");
    const lons = url.searchParams.get("longitude")!.split(",");
    const start = url.searchParams.get("start_date") ?? "2020-06-13";
    const end = url.searchParams.get("end_date") ?? start;
    const days = dayRange(start, end);
    const time: string[] = [];
    for (const d of days)
      for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, "0")}:00`);
    const n = time.length;
    const locations = lats.map((lat, i) => ({
      latitude: Number(lat),
      longitude: Number(lons[i]),
      utc_offset_seconds: 0,
      hourly: {
        time,
        wind_speed_10m: new Array(n).fill(10),
        wind_direction_10m: new Array(n).fill(180),
        wind_gusts_10m: new Array(n).fill(15),
      },
    }));
    const body = JSON.stringify(locations.length === 1 ? locations[0] : locations);
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  return {
    deps: {
      fetch: fetchFn as typeof fetch,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
    },
    calls: () => calls,
  };
}

function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (
    let t = Date.parse(`${start}T00:00:00Z`);
    t <= Date.parse(`${end}T00:00:00Z`);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function addRide(store: Store, lat0: number, lon0: number): string {
  const startMs = Date.UTC(2020, 5, 13, 8, 0, 0); // old → reanalysis archive, not "recent"
  const dateKey = beelineRideKey(startMs);
  const uid = rideUid("gpx", dateKey);
  const points: LatLon[] = [
    [lat0, lon0],
    [lat0 + 0.05, lon0],
    [lat0 + 0.1, lon0], // heading due north
  ];
  store.upsert(uid, {
    source: "gpx",
    track: encodePolyline(points),
    distance_km: 11,
    elapsed_sec: 1800,
  });
  return uid;
}

function makeController(store: Store, deps: WeatherDeps): Controller {
  return new Controller(
    async () => {
      throw new Error("no source");
    },
    store,
    undefined,
    undefined,
    WindCache.memory(),
    deps,
  );
}

describe("Controller historical wind", () => {
  it("resolves a ride's wind and summarizes a tailwind when riding into it", async () => {
    const store = new Store(memoryBackend());
    const uid = addRide(store, 52.0, 13.0);
    const weather = fakeWeather();
    const c = makeController(store, weather.deps);

    c.resolveWind([uid]);
    await vi.waitFor(() => expect(c.getRideWind(uid)).not.toBeNull(), { timeout: 5000 });

    const w = c.getRideWind(uid)!;
    expect(w.noData).toBeFalsy();
    expect(w.pctTailwind).toBe(1); // south wind, riding north → all tailwind
    expect(w.avgAlongKmh).toBeGreaterThan(8);
    expect(w.prevailingFromDeg).toBeCloseTo(180, 0);
    expect(w.dataset).toBe("cerra"); // Europe + 2020 → finest archive first
    expect(c.windCacheCount()).toBeGreaterThan(0);

    const overlay = c.getRideWindOverlay(uid)!;
    expect(overlay.points.length).toBe(3);
    expect(overlay.winds[0]?.alongKmh).toBeGreaterThan(8);
  });

  it("reuses the global cache so a second overlapping ride needs no fetch", async () => {
    const store = new Store(memoryBackend());
    const weather = fakeWeather();
    const c = makeController(store, weather.deps);

    const uidA = addRide(store, 52.0, 13.0);
    c.resolveWind([uidA]);
    await vi.waitFor(() => expect(c.getRideWind(uidA)).not.toBeNull(), { timeout: 5000 });
    const afterA = weather.calls();
    expect(afterA).toBeGreaterThan(0);

    // A second ride over the same cells on the same day resolves from cache only.
    const uidB = rideUid("gpx", beelineRideKey(Date.UTC(2020, 5, 13, 8, 30, 0)));
    store.upsert(uidB, {
      source: "gpx",
      track: encodePolyline([
        [52.02, 13.0],
        [52.06, 13.0],
        [52.09, 13.0],
      ]),
      distance_km: 9,
      elapsed_sec: 1500,
    });
    c.resolveWind([uidB]);
    await vi.waitFor(() => expect(c.getRideWind(uidB)).not.toBeNull(), { timeout: 5000 });
    expect(weather.calls()).toBe(afterA); // no additional network calls
  });

  it("showCachedWind never hits the network for an unresolved ride", async () => {
    const store = new Store(memoryBackend());
    const uid = addRide(store, 52.0, 13.0);
    const weather = fakeWeather();
    const c = makeController(store, weather.deps);

    c.showCachedWind(uid); // display-only: must not resolve anything
    await new Promise((r) => setTimeout(r, 20));
    expect(weather.calls()).toBe(0);
    expect(c.getRideWind(uid)).toBeNull();
    expect(c.hasResolvedWind(uid)).toBe(false);
  });

  it("Stop cancels a bulk resolve mid-way, preserving the rides already resolved", async () => {
    const store = new Store(memoryBackend());
    // Distinct rides (distinct times + far-apart cells → a fetch each, in order).
    const uids: string[] = [];
    for (let k = 0; k < 6; k++) {
      const startMs = Date.UTC(2020, 5, 13, 8 + k, 0, 0);
      const uid = rideUid("gpx", beelineRideKey(startMs));
      const lat = 50 + k; // far apart → separate cells, separate requests
      store.upsert(uid, {
        source: "gpx",
        track: encodePolyline([
          [lat, 13.0],
          [lat + 0.05, 13.0],
          [lat + 0.1, 13.0],
        ]),
        distance_km: 11,
        elapsed_sec: 1800,
      });
      uids.push(uid);
    }

    // Cancel after the 2nd network fetch completes — so ~2 rides resolve, the rest don't.
    const weather = fakeWeather();
    let fetches = 0;
    const baseFetch = weather.deps.fetch;
    const c = makeController(store, {
      ...weather.deps,
      fetch: (async (input: string | URL | Request) => {
        const resp = await baseFetch(input);
        if (++fetches === 2) c.cancel(null); // press Stop
        return resp;
      }) as typeof fetch,
    });

    c.resolveWind(uids);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const resolved = uids.filter((u) => c.hasResolvedWind(u));
    const unresolved = uids.filter((u) => !c.hasResolvedWind(u));
    // Stopped mid-way: some resolved (and persisted), some not.
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.length).toBeLessThan(uids.length);
    expect(unresolved.length).toBeGreaterThan(0);
    // The resolved ones carry a real, persisted summary (progress preserved).
    for (const u of resolved) expect(c.getRideWind(u)?.noData).toBeFalsy();
    // The unresolved ones are NOT stuck "in flight" — they can be resolved again.
    expect(c.isResolvingWind(unresolved[0])).toBe(false);
  });
});
