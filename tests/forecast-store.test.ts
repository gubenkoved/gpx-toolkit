import { describe, expect, it } from "vitest";
import type { HourlyForecast, LocationResult } from "../src/forecast";
import { ForecastStore, forecastCacheKey } from "../src/forecast-store";
import { memoryBlobBackend } from "../src/kv";

const entry = (fetchedAt = 1000): HourlyForecast => ({
  modelId: "ecmwf_ifs",
  point: { lat: 52.3701, lon: 4.9001, label: "Amsterdam" },
  gridLat: 52.37,
  gridLon: 4.9,
  times: [Date.now() + 3_600_000, Date.now() + 7_200_000],
  windSpeedKmh: [10, 11],
  windDirectionDeg: [180, 190],
  windGustKmh: [18, 19],
  precipitationMm: [0, 0.2],
  temperatureC: [14, 15],
  pressureHpa: [1012, 1011],
  cloudCoverPct: [30, 40],
  fetchedAt,
  freshUntil: fetchedAt + 3_600_000,
  requestedHours: 48,
});

describe("ForecastStore", () => {
  it("defaults new and incomplete preferences to compare without overriding saved graph", async () => {
    const fresh = ForecastStore.memory();
    expect(fresh.prefs().presentation).toBe("compare");
    expect(fresh.prefs().compareDetailHeightPx).toBeNull();

    const graphBackend = memoryBlobBackend();
    const graphStore = await ForecastStore.load(graphBackend);
    await graphStore.setPrefs({ presentation: "graph" });
    expect((await ForecastStore.load(graphBackend)).prefs().presentation).toBe("graph");

    const incompleteBackend = memoryBlobBackend();
    await incompleteBackend.set(
      "forecast::__catalog",
      new TextEncoder().encode(
        JSON.stringify({ v: 1, entries: {}, geo: {}, prefs: { days: 3 } }),
      ),
    );
    expect((await ForecastStore.load(incompleteBackend)).prefs().presentation).toBe("compare");
  });

  it("round-trips compressed forecasts and reuses the 0.001 degree point bucket", async () => {
    const backend = memoryBlobBackend();
    const store = await ForecastStore.load(backend);
    await store.putForecast(entry());
    const restored = await store.getForecast(
      { lat: 52.3704, lon: 4.9004, label: "Nearby" },
      "ecmwf_ifs",
    );
    expect(restored?.windSpeedKmh).toEqual([10, 11]);
    expect(store.count).toBe(1);
    expect(store.totalBytes()).toBeGreaterThan(0);
  });

  it("keeps five search recents and maintains separate favorites", async () => {
    const store = ForecastStore.memory();
    for (let i = 0; i < 7; i++) {
      const place: LocationResult = {
        lat: 50 + i,
        lon: 4,
        label: `Place ${i}`,
        placeId: String(i),
      };
      await store.addRecent(place);
    }
    const pin = { lat: 52, lon: 5, label: "Pin" };
    expect(await store.toggleFavorite(pin)).toBe(true);
    expect(store.prefs().recent).toHaveLength(5);
    expect(store.prefs().recent[0].label).toBe("Place 6");
    expect(store.prefs().favorites).toEqual([pin]);
    expect(await store.toggleFavorite(pin)).toBe(false);
  });

  it("renames pinned coordinates everywhere the saved location is shown", async () => {
    const store = ForecastStore.memory();
    const point: LocationResult = {
      lat: 52.3701,
      lon: 4.9001,
      label: "52.3701, 4.9001",
      placeId: "coordinate-pin",
    };
    await store.addRecent(point);
    await store.toggleFavorite(point);

    expect((await store.renameFavorite(point, "Home"))?.label).toBe("Home");
    expect(store.prefs().favorites[0]?.label).toBe("Home");
    expect(store.prefs().recent[0]?.label).toBe("Home");
    expect(store.prefs().lastPoint?.label).toBe("Home");
    expect(await store.renameFavorite(point, "   ")).toBeNull();
  });

  it("flushes re-fetchable payloads without losing preferences", async () => {
    const store = ForecastStore.memory();
    const pin = { lat: 52, lon: 5, label: "Pin" };
    await store.putForecast(entry());
    await store.putGeocode("Amsterdam", [{ ...pin, placeId: "1" }]);
    await store.toggleFavorite(pin);
    await store.flushCache();
    expect(store.count).toBe(0);
    expect(store.prefs().favorites).toEqual([pin]);
    expect(await store.getForecast(entry().point, "ecmwf_ifs")).toBeNull();
  });

  it("persists display units and independently selected variables", async () => {
    const backend = memoryBlobBackend();
    const store = await ForecastStore.load(backend);
    await store.setPrefs({
      speedUnit: "ms",
      presentation: "textual",
      compareDetailHeightPx: 420,
      metrics: ["temperature", "precipitation"],
      hiddenCompareModels: ["ecmwf_ifs"],
      compareStyle: "models",
    });

    const restored = await ForecastStore.load(backend);
    expect(restored.prefs().speedUnit).toBe("ms");
    expect(restored.prefs().presentation).toBe("textual");
    expect(restored.prefs().compareDetailHeightPx).toBe(420);
    expect(restored.prefs().metrics).toEqual(["temperature", "precipitation"]);
    expect(restored.prefs().hiddenCompareModels).toEqual(["ecmwf_ifs"]);
    expect(restored.prefs().compareStyle).toBe("models");
  });

  it("falls back from an unsupported presentation and invalid detail height", async () => {
    const backend = memoryBlobBackend();
    await backend.set(
      "forecast::__catalog",
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          entries: {},
          geo: {},
          prefs: {
            lastPoint: null,
            days: 3,
            recent: [],
            favorites: [],
            selectedModels: null,
            speedUnit: "kmh",
            presentation: "table",
            compareDetailHeightPx: -10,
            metrics: ["windSpeed"],
          },
        }),
      ),
    );

    const prefs = (await ForecastStore.load(backend)).prefs();
    expect(prefs.presentation).toBe("compare");
    expect(prefs.compareDetailHeightPx).toBeNull();
    expect(prefs.compareStyle).toBe("consensus");
  });

  it("keeps fresh negative probes across reloads", async () => {
    const backend = memoryBlobBackend();
    const store = await ForecastStore.load(backend);
    const now = Date.now();
    await store.putForecast({
      ...entry(now),
      times: [],
      windSpeedKmh: [],
      windDirectionDeg: [],
      windGustKmh: [],
      precipitationMm: [],
      temperatureC: [],
      pressureHpa: [],
      cloudCoverPct: [],
      freshUntil: now + 3_600_000,
      noData: true,
    });

    const restored = await ForecastStore.load(backend);
    expect((await restored.getForecast(entry().point, "ecmwf_ifs"))?.noData).toBe(true);
  });

  it("discards corrupt cached payloads and their catalog entries", async () => {
    const backend = memoryBlobBackend();
    const store = await ForecastStore.load(backend);
    const value = entry();
    await store.putForecast(value);
    const key = `forecast::entry::${forecastCacheKey(value.point, value.modelId)}`;
    await backend.set(key, new Uint8Array([1, 2, 3]));

    expect(await store.getForecast(value.point, value.modelId)).toBeNull();
    expect(store.count).toBe(0);
  });
});
