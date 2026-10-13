import { describe, expect, it } from "vitest";
import {
  buildCourse,
  DESCENT_CAP_KMH,
  effectiveSpeedModel,
  hillSpeed,
  simulate,
  speedFor,
  sweepDepartures,
  type WeatherAt,
  weatherFromCells,
} from "../src/route-sim";
import type { LatLon } from "../src/track";
import type { CellDayWind } from "../src/weather";

// Due north for ~11 km.
const NORTH: LatLon[] = [
  [52.0, 4.0],
  [52.1, 4.0],
];
const MODEL = { calmKmh: 20, slope: 0.2 };
const T0 = Date.UTC(2026, 9, 10, 8);

const steady =
  (fromDeg: number, speedKmh: number): WeatherAt =>
  () => ({ fromDeg, speedKmh, gustKmh: speedKmh, rainMm: 0, tempC: 12 });

describe("route simulation", () => {
  it("cuts the line into even steps heading the right way", () => {
    const c = buildCourse(NORTH, [], 0.25);
    expect(c.totalKm).toBeCloseTo(11.12, 1);
    expect(c.steps.length).toBe(Math.ceil(c.totalKm / 0.25));
    expect(c.steps[0].bearing).toBeCloseTo(0, 3);
    expect(c.steps.reduce((a, s) => a + s.lenKm, 0)).toBeCloseTo(c.totalKm, 6);
  });

  it("is slower into a headwind and faster with a tailwind", () => {
    const c = buildCourse(NORTH);
    const calm = simulate(c, T0, MODEL, () => null);
    expect(calm.durationSec).toBeCloseTo(calm.calmSec, 3);
    expect(calm.coverage).toBe(0);
    // Wind FROM the north is a headwind riding north: 20 − 0.2·10 = 18 km/h.
    const head = simulate(c, T0, MODEL, steady(0, 10));
    expect(head.avgSpeedKmh).toBeCloseTo(18, 6);
    expect(head.headShare).toBeCloseTo(1, 6);
    expect(head.durationSec).toBeGreaterThan(head.calmSec);
    const tail = simulate(c, T0, MODEL, steady(180, 10));
    expect(tail.avgSpeedKmh).toBeCloseTo(22, 6);
    expect(tail.wetShare).toBe(0);
    expect(tail.rainMm).toBe(0);
    expect(calm.rainMm).toBeNull();
    // 2 mm/h all the way: the rain ridden through is 2 mm per hour in the saddle.
    const wet = simulate(c, T0, MODEL, () => ({
      fromDeg: 0,
      speedKmh: 0,
      gustKmh: 0,
      rainMm: 2,
      tempC: 12,
    }));
    expect(wet.wetShare).toBe(1);
    expect(wet.rainMm).toBeCloseTo((2 * wet.durationSec) / 3600, 6);
    expect(tail.avgTempC).toBeCloseTo(12, 6);
    expect(tail.endMs).toBeCloseTo(T0 + tail.durationSec * 1000, 0);
  });

  it("keeps speed physical in a gale", () => {
    expect(speedFor(MODEL, -200)).toBe(6);
    expect(speedFor(MODEL, 200)).toBe(36);
  });

  it("follows the rider's own speed, then the fit, then the default", () => {
    const fit = { calmKmh: 25, slope: 0.25, r2: 0.4, segments: 300, fittedAt: 0 };
    expect(
      effectiveSpeedModel({ calmKmh: 27, slope: null, hills: false, massKg: 85 }, fit),
    ).toEqual({ calmKmh: 27, slope: 0.25 });
    expect(
      effectiveSpeedModel({ calmKmh: null, slope: null, hills: true, massKg: 90 }, null),
    ).toEqual({ calmKmh: 22, slope: 0.2, massKg: 90 });
  });

  it("reads the wind where and when the rider gets there", () => {
    const c = buildCourse(NORTH);
    // One cell, one day: calm until 09:00 UTC, then a 30 km/h northerly.
    const speeds = Array.from({ length: 24 }, (_, h) => (h < 9 ? 0 : 30));
    const entry: CellDayWind = {
      dataset: "forecast",
      latIdx: 520,
      lonIdx: 40,
      cellLat: 52.0,
      cellLon: 4.0,
      gridKm: 11,
      dayISO: "2026-10-10",
      step: 24,
      hourly: {
        wind_speed_10m: speeds,
        wind_direction_10m: speeds.map(() => 0),
        wind_gusts_10m: speeds,
      },
    };
    const at = weatherFromCells(c, [entry]);
    const early = simulate(c, Date.UTC(2026, 9, 10, 6), MODEL, at);
    const late = simulate(c, Date.UTC(2026, 9, 10, 12), MODEL, at);
    expect(early.coverage).toBe(1);
    expect(late.durationSec).toBeGreaterThan(early.durationSec);
    // A different day has no data: ridden in still air.
    expect(simulate(c, Date.UTC(2026, 9, 11, 6), MODEL, at).coverage).toBe(0);

    const sweep = sweepDepartures(
      c,
      [Date.UTC(2026, 9, 10, 6), Date.UTC(2026, 9, 10, 12)],
      MODEL,
      at,
    );
    expect(sweep.map((d) => d.durationSec)).toEqual([early.durationSec, late.durationSec]);
  });

  it("replays the flat effort on a grade: slower up, faster down, capped", () => {
    expect(hillSpeed(22, 0, 85)).toBe(22);
    const up5 = hillSpeed(22, 5, 85);
    expect(up5).toBeGreaterThan(7);
    expect(up5).toBeLessThan(13);
    expect(hillSpeed(22, 5, 110)).toBeLessThan(up5); // heavier climbs slower
    const down3 = hillSpeed(22, -3, 85);
    expect(down3).toBeGreaterThan(30);
    expect(hillSpeed(22, -15, 85)).toBe(DESCENT_CAP_KMH);
    expect(hillSpeed(22, 20, 85)).toBeGreaterThanOrEqual(4);
  });

  it("grades each step from the line's elevation and rides the hills", () => {
    // 100 m of climb over ~11 km: a ~0.9% grade, the same on every step.
    const c = buildCourse(NORTH, [0, 100]);
    expect(c.steps[3].gradePct).toBeCloseTo(0.9, 1);
    expect(buildCourse(NORTH, [0, null]).steps[0].gradePct).toBeNull();
    const flat = simulate(c, T0, MODEL, steady(0, 10));
    const hilly = simulate(c, T0, { ...MODEL, massKg: 85 }, steady(0, 10));
    expect(flat.flatSec).toBeCloseTo(flat.durationSec, 3);
    expect(hilly.durationSec).toBeGreaterThan(flat.durationSec);
    expect(hilly.flatSec).toBeCloseTo(flat.durationSec, 3); // same wind, no hills
    expect(hilly.calmSec).toBeGreaterThan(flat.calmSec); // still air, same hills
  });
});
