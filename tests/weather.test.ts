import { describe, expect, it } from "vitest";
import type { LatLon } from "../src/track";
import {
  alongTrackComponentKmh,
  bearingDeg,
  type CellDayWind,
  cellBounds,
  cellDayKey,
  computeRidePoints,
  crossTrackComponentKmh,
  type Dataset,
  OpenMeteo,
  parseRetryAfter,
  pickDatasets,
  quantizeCell,
  sampleGridCells,
  summarize,
  windAtMs,
} from "../src/weather";

// A tiny controllable clock: sleep() advances time synchronously so rate-limiter
// spacing is deterministic without real timers.
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

const ERA5: Dataset = {
  id: "era5",
  label: "ERA5 25 km",
  gridDeg: 0.25,
  gridKm: 25,
  endpoint: "https://archive-api.open-meteo.com/v1/archive",
  models: "era5",
  forecast: false,
};

/** Build a fake Open-Meteo location with 24 hourly samples for one UTC day. */
function makeLoc(
  lat: number,
  lon: number,
  dayISO: string,
  speed: number | (number | null)[],
  dir: number | (number | null)[],
  gust = 0,
) {
  const time: string[] = [];
  const speeds: (number | null)[] = [];
  const dirs: (number | null)[] = [];
  const gusts: (number | null)[] = [];
  for (let h = 0; h < 24; h++) {
    time.push(`${dayISO}T${String(h).padStart(2, "0")}:00`);
    speeds.push(Array.isArray(speed) ? speed[h] : speed);
    dirs.push(Array.isArray(dir) ? dir[h] : dir);
    gusts.push(gust);
  }
  return {
    latitude: lat,
    longitude: lon,
    utc_offset_seconds: 0,
    hourly: { time, wind_speed_10m: speeds, wind_direction_10m: dirs, wind_gusts_10m: gusts },
  };
}

describe("wind math", () => {
  it("bearingDeg: cardinal directions", () => {
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(0, 1); // north
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(90, 1); // east
    expect(bearingDeg([1, 0], [0, 0])).toBeCloseTo(180, 1); // south
    expect(bearingDeg([0, 1], [0, 0])).toBeCloseTo(270, 1); // west
  });

  it("alongTrackComponentKmh: south wind riding north is a full tailwind", () => {
    expect(alongTrackComponentKmh(180, 10, 0)).toBeCloseTo(10, 6); // tailwind +
    expect(alongTrackComponentKmh(0, 10, 0)).toBeCloseTo(-10, 6); // headwind −
    expect(alongTrackComponentKmh(90, 10, 0)).toBeCloseTo(0, 6); // crosswind
    expect(alongTrackComponentKmh(135, 10, 0)).toBeCloseTo(7.0711, 3); // quartering tail
  });

  it("crossTrackComponentKmh: side winds are full cross, head/tail are zero cross", () => {
    expect(crossTrackComponentKmh(90, 10, 0)).toBeCloseTo(-10, 6); // from east, riding N
    expect(crossTrackComponentKmh(270, 10, 0)).toBeCloseTo(10, 6); // from west, riding N
    expect(crossTrackComponentKmh(180, 10, 0)).toBeCloseTo(0, 6); // pure tailwind
    expect(crossTrackComponentKmh(0, 10, 0)).toBeCloseTo(0, 6); // pure headwind
    expect(crossTrackComponentKmh(135, 10, 0)).toBeCloseTo(-7.0711, 3); // quartering
  });

  it("cellBounds: square centered on the cell, sized by gridKm", () => {
    const [[s, w], [n, e]] = cellBounds(52, 13, 25);
    expect((n + s) / 2).toBeCloseTo(52, 6);
    expect((e + w) / 2).toBeCloseTo(13, 6);
    // ~25 km tall → ~0.2246° of latitude.
    expect(n - s).toBeCloseTo(25 / 111.32, 4);
    // Longitude span is widened by 1/cos(lat), so it exceeds the latitude span.
    expect(e - w).toBeGreaterThan(n - s);
  });
});

describe("grid sampling", () => {
  it("quantizeCell snaps to the dataset grid", () => {
    const c = quantizeCell(52.34, 13.06, ERA5);
    expect(c.latIdx).toBe(Math.round(52.34 / 0.25));
    expect(c.lonIdx).toBe(Math.round(13.06 / 0.25));
    expect(c.lat).toBeCloseTo(c.latIdx * 0.25, 6);
  });

  it("same road maps to the same cell key", () => {
    const a = quantizeCell(52.5, 13.4, ERA5);
    const b = quantizeCell(52.51, 13.41, ERA5); // < one cell away
    expect(cellDayKey("era5", a.latIdx, a.lonIdx, "2026-06-13")).toBe(
      cellDayKey("era5", b.latIdx, b.lonIdx, "2026-06-13"),
    );
  });

  it("sampleGridCells dedupes to the grid and respects the cap", () => {
    const pts: LatLon[] = [];
    for (let i = 0; i < 100; i++) pts.push([52 + i * 0.3, 13]); // every 0.3° → distinct cells
    const all = sampleGridCells(pts, ERA5, 1000);
    expect(all.length).toBeGreaterThan(50);
    const capped = sampleGridCells(pts, ERA5, 10);
    expect(capped.length).toBe(10);
  });

  it("sampleGridCells collapses a tight cluster to one cell", () => {
    const pts: LatLon[] = [
      [52.5, 13.4],
      [52.51, 13.41],
      [52.49, 13.39],
    ];
    expect(sampleGridCells(pts, ERA5, 24).length).toBe(1);
  });
});

describe("windAtMs interpolation", () => {
  const entry = (
    speed: number | (number | null)[],
    dir: number | (number | null)[],
  ): CellDayWind => {
    const loc = makeLoc(52, 13, "2026-06-13", speed, dir, 0);
    return {
      dataset: "era5",
      latIdx: 0,
      lonIdx: 0,
      cellLat: 52,
      cellLon: 13,
      gridKm: 25,
      dayISO: "2026-06-13",
      step: 24,
      hourly: {
        wind_speed_10m: loc.hourly.wind_speed_10m,
        wind_direction_10m: loc.hourly.wind_direction_10m,
        wind_gusts_10m: loc.hourly.wind_gusts_10m,
      },
    };
  };

  it("interpolates direction across the 360→0 wrap without swinging through 180", () => {
    const dirs = new Array(24).fill(0);
    dirs[0] = 350;
    dirs[1] = 10;
    const w = windAtMs(entry(10, dirs), Date.parse("2026-06-13T00:30:00Z"));
    expect(w).not.toBeNull();
    // Halfway between 350° and 10° is 0°, not 180°.
    const d = w!.fromDeg;
    expect(Math.min(d, 360 - d)).toBeLessThan(1);
    expect(w!.speedKmh).toBeCloseTo(9.85, 1);
  });

  it("returns null when both bracketing samples are missing", () => {
    const dirs = new Array(24).fill(null);
    const speeds = new Array(24).fill(null);
    expect(windAtMs(entry(speeds, dirs), Date.parse("2026-06-13T05:00:00Z"))).toBeNull();
  });
});

describe("computeRidePoints + summarize", () => {
  const cell: CellDayWind = {
    dataset: "era5",
    latIdx: Math.round(52 / 0.25),
    lonIdx: Math.round(13 / 0.25),
    cellLat: 52,
    cellLon: 13,
    gridKm: 25,
    dayISO: "2026-06-13",
    step: 24,
    hourly: {
      wind_speed_10m: new Array(24).fill(10),
      wind_direction_10m: new Array(24).fill(180), // wind from the south
      wind_gusts_10m: new Array(24).fill(15),
    },
  };
  const lookup = (latIdx: number, lonIdx: number, day: string) =>
    latIdx === cell.latIdx && lonIdx === cell.lonIdx && day === "2026-06-13" ? cell : null;

  it("riding north into a south wind yields a tailwind summary", () => {
    const pts: LatLon[] = [
      [52.0, 13.0],
      [52.05, 13.0],
      [52.1, 13.0],
    ];
    const t0 = Date.parse("2026-06-13T08:00:00Z");
    const times = [t0, t0 + 60_000, t0 + 120_000];
    const pw = computeRidePoints(pts, times, lookup, ERA5);
    expect(pw[0]?.alongKmh).toBeCloseTo(10, 1);
    const s = summarize(pw, {
      dataset: ERA5,
      cells: [{ lat: 52, lon: 13 }],
      fetchedAt: "now",
    });
    expect(s.avgAlongKmh).toBeGreaterThan(8);
    expect(s.pctTailwind).toBe(1);
    expect(s.prevailingFromDeg).toBeCloseTo(180, 0);
    expect(s.noData).toBeUndefined();
  });

  it("summarize marks noData when nothing resolved", () => {
    const s = summarize([null, null], {
      dataset: ERA5,
      cells: [],
      fetchedAt: "now",
    });
    expect(s.noData).toBe(true);
  });

  it("fills gaps where a point's own cell has no data (no bare white segments)", () => {
    // Two points sit in `cell`; a middle one sits in an UNFETCHED cell (lookup miss),
    // which previously left a null → a white gap on the map. It should now borrow the
    // nearest resolved wind, so every point is coloured.
    const pts: LatLon[] = [
      [52.0, 13.0], // in cell
      [52.0, 20.0], // far away → different (unfetched) cell → would be null
      [52.1, 13.0], // in cell
    ];
    const t0 = Date.parse("2026-06-13T08:00:00Z");
    const times = [t0, t0 + 60_000, t0 + 120_000];
    const pw = computeRidePoints(pts, times, lookup, ERA5);
    expect(pw.every((p) => p != null)).toBe(true);
    // The filled middle point carries a real wind sample (south wind, 10 km/h).
    expect(pw[1]?.speedKmh).toBeCloseTo(10, 1);
    expect(pw[1]?.fromDeg).toBeCloseTo(180, 0);
  });
});

describe("pickDatasets", () => {
  const now = Date.UTC(2026, 5, 16);
  it("uses the live forecast for very recent rides", () => {
    const ids = pickDatasets(52, 13, Date.UTC(2026, 5, 14), now).map((d) => d.id);
    expect(ids).toEqual(["forecast"]);
  });
  it("prefers CERRA→IFS→ERA5 in Europe before 2021", () => {
    const ids = pickDatasets(52, 13, Date.UTC(2019, 5, 1), now).map((d) => d.id);
    expect(ids).toEqual(["cerra", "ecmwf_ifs", "era5"]);
  });
  it("drops CERRA outside Europe", () => {
    const ids = pickDatasets(40, -100, Date.UTC(2019, 5, 1), now).map((d) => d.id);
    expect(ids).toEqual(["ecmwf_ifs", "era5"]);
  });
  it("falls back to ERA5 only for old non-European rides", () => {
    const ids = pickDatasets(40, -100, Date.UTC(1990, 5, 1), now).map((d) => d.id);
    expect(ids).toEqual(["era5"]);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("3", 0)).toBe(3000);
  });
  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-06-16T00:00:00Z");
    expect(parseRetryAfter("Tue, 16 Jun 2026 00:00:05 GMT", now)).toBe(5000);
  });
  it("returns null for junk / missing", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });
});

describe("OpenMeteo client", () => {
  const okResponse = (locations: unknown[]) =>
    new Response(JSON.stringify(locations.length === 1 ? locations[0] : locations), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("builds one multi-coordinate request and parses per cell+day", async () => {
    const clock = fakeClock();
    const urls: string[] = [];
    const fetchFn = (url: string | URL | Request) => {
      urls.push(String(url));
      return Promise.resolve(
        okResponse([
          makeLoc(52, 13, "2026-06-13", 10, 180, 15),
          makeLoc(52.25, 13, "2026-06-13", 20, 90, 25),
        ]),
      );
    };
    const om = new OpenMeteo({ fetch: fetchFn as typeof fetch, ...clock });
    const cells = [
      { latIdx: 208, lonIdx: 52, lat: 52, lon: 13 },
      { latIdx: 209, lonIdx: 52, lat: 52.25, lon: 13 },
    ];
    const entries = await om.fetchWindMulti(ERA5, cells, ["2026-06-13"]);
    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(urls[0])).toContain("latitude=52.0000,52.2500");
    expect(urls[0]).toContain("models=era5");
    expect(urls[0]).toContain("wind_speed_10m");
    expect(entries).toHaveLength(2);
    expect(entries[0].hourly.wind_direction_10m?.[0]).toBe(180);
    expect(entries[1].hourly.wind_speed_10m?.[0]).toBe(20);
  });

  it("emits a negative-cache entry for a cell with no wind", async () => {
    const clock = fakeClock();
    const fetchFn = () =>
      Promise.resolve(
        okResponse([
          makeLoc(52, 13, "2026-06-13", new Array(24).fill(null), new Array(24).fill(null)),
        ]),
      );
    const om = new OpenMeteo({ fetch: fetchFn as typeof fetch, ...clock });
    const entries = await om.fetchWindMulti(
      ERA5,
      [{ latIdx: 208, lonIdx: 52, lat: 52, lon: 13 }],
      ["2026-06-13"],
    );
    expect(entries[0].noData).toBe(true);
  });

  it("spaces consecutive requests by at least minSpacingMs", async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const fetchFn = () => {
      times.push(clock.now());
      return Promise.resolve(okResponse([makeLoc(52, 13, "2026-06-13", 10, 180)]));
    };
    const om = new OpenMeteo(
      { fetch: fetchFn as typeof fetch, ...clock },
      { minSpacingMs: 200 },
    );
    const cells = [{ latIdx: 208, lonIdx: 52, lat: 52, lon: 13 }];
    for (let i = 0; i < 4; i++) await om.fetchWindMulti(ERA5, cells, ["2026-06-13"]);
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(200);
  });

  it("retries on 429, honoring Retry-After, then succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;
    const slept: number[] = [];
    const baseSleep = clock.sleep;
    const sleep = (ms: number) => {
      slept.push(ms);
      return baseSleep(ms);
    };
    const fetchFn = () => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(
          new Response("", { status: 429, headers: { "retry-after": "2" } }),
        );
      }
      return Promise.resolve(okResponse([makeLoc(52, 13, "2026-06-13", 10, 180)]));
    };
    const om = new OpenMeteo({ fetch: fetchFn as typeof fetch, now: clock.now, sleep });
    const entries = await om.fetchWindMulti(
      ERA5,
      [{ latIdx: 208, lonIdx: 52, lat: 52, lon: 13 }],
      ["2026-06-13"],
    );
    expect(calls).toBe(2);
    expect(slept).toContain(2000); // waited out the Retry-After
    expect(entries[0].hourly.wind_speed_10m?.[0]).toBe(10);
  });
});
