import { describe, expect, it } from "vitest";

import type { LatLon } from "../src/track";
import {
  linearRegression,
  segmentRide,
  type SegmentOpts,
  speedCapIndices,
} from "../src/windspeed";

// A straight run, `k` points, 0.02° apart along one axis (~2.22 km/hop), `dtSec`
// per hop (default 300s → ~26.6 km/h, well above the stop threshold).
function run(opts: {
  axis: "north" | "south" | "east";
  k: number;
  startLat?: number;
  startLon?: number;
  startTimeMs?: number;
  dtSec?: number;
}): { points: LatLon[]; times: number[] } {
  const { axis, k, startLat = 52, startLon = 4, startTimeMs = 0, dtSec = 300 } = opts;
  const points: LatLon[] = [];
  const times: number[] = [];
  for (let i = 0; i < k; i++) {
    const d = 0.02 * i;
    const lat = axis === "north" ? startLat + d : axis === "south" ? startLat - d : startLat;
    const lon = axis === "east" ? startLon + d : startLon;
    points.push([lat, lon]);
    times.push(startTimeMs + i * dtSec * 1000);
  }
  return { points, times };
}

const OPTS: SegmentOpts = { stopKmh: 1 };

describe("segmentRide", () => {
  it("keeps a straight ride as one segment with the given along-wind", () => {
    const { points, times } = run({ axis: "north", k: 5 });
    const along = points.map(() => 5);
    const eles = points.map(() => null);
    const segs = segmentRide(points, times, eles, along, OPTS, "u1");
    expect(segs.length).toBe(1);
    expect(segs[0].avgAlongKmh).toBeCloseTo(5, 5);
    expect(segs[0].avgSpeedKmh).toBeGreaterThan(20);
    expect(segs[0].distanceKm).toBeGreaterThan(0.3);
  });

  it("splits an out-and-back into opposite-sign segments at the U-turn", () => {
    // North to a peak, then straight back south — one contiguous point list.
    const points: LatLon[] = [
      [52.0, 4.0],
      [52.02, 4.0],
      [52.04, 4.0],
      [52.06, 4.0], // peak
      [52.04, 4.0],
      [52.02, 4.0],
      [52.0, 4.0],
    ];
    const times = points.map((_, i) => i * 300 * 1000);
    // Tailwind on the way out (+5), headwind on the way back (−5).
    const along = [5, 5, 5, -5, -5, -5, -5];
    const eles = points.map(() => null);
    const segs = segmentRide(points, times, eles, along, OPTS, "u1");
    expect(segs.length).toBe(2);
    expect(segs[0].avgAlongKmh).toBeCloseTo(5, 5);
    expect(segs[1].avgAlongKmh).toBeCloseTo(-5, 5);
  });

  it("splits on a 90° turn", () => {
    const points: LatLon[] = [
      [52.0, 4.0],
      [52.02, 4.0],
      [52.04, 4.0], // heading north
      [52.04, 4.02],
      [52.04, 4.04], // heading east
    ];
    const times = points.map((_, i) => i * 300 * 1000);
    const along = points.map(() => 3);
    const eles = points.map(() => null);
    const segs = segmentRide(points, times, eles, along, OPTS, "u1");
    expect(segs.length).toBe(2);
  });

  it("splits on a stop and excludes the stopped hop from moving time", () => {
    // North, a zero-distance (stopped) hop, then north again.
    const points: LatLon[] = [
      [52.0, 4.0],
      [52.02, 4.0],
      [52.04, 4.0],
      [52.04, 4.0], // duplicate → stopped hop
      [52.06, 4.0],
      [52.08, 4.0],
    ];
    const times = points.map((_, i) => i * 300 * 1000);
    const along = points.map(() => 4);
    const eles = points.map(() => null);
    const segs = segmentRide(points, times, eles, along, OPTS, "u1");
    expect(segs.length).toBe(2);
    // First segment is hops 0→1 and 1→2 only (600s); the stop is not folded in.
    expect(segs[0].movingSec).toBeCloseTo(600, 5);
  });

  it("computes net grade from elevation, and NaN when elevation is unknown", () => {
    const { points, times } = run({ axis: "north", k: 5 });
    const along = points.map(() => 0);
    // ~8.88 km total over a +100 m climb → ~+1.1% grade.
    const climb = [0, 25, 50, 75, 100];
    const up = segmentRide(points, times, climb, along, OPTS, "u1");
    expect(up[0].netGradePct).toBeGreaterThan(0.8);
    const flat = segmentRide(points, times, [10, 10, 10, 10, 10], along, OPTS, "u1");
    expect(flat[0].netGradePct).toBeCloseTo(0, 5);
    const unknown = segmentRide(points, times, points.map(() => null), along, OPTS, "u1");
    expect(Number.isNaN(unknown[0].netGradePct)).toBe(true);
  });

  it("returns nothing for a too-short or malformed ride", () => {
    expect(segmentRide([[52, 4]], [0], [null], [0], OPTS, "u1")).toEqual([]);
    const { points, times } = run({ axis: "north", k: 4 });
    // Mismatched array lengths → defensive empty.
    expect(segmentRide(points, times, [null], [0], OPTS, "u1")).toEqual([]);
  });
});

describe("linearRegression", () => {
  it("recovers a known slope and intercept exactly", () => {
    const xs = [-2, -1, 0, 1, 2];
    const ys = xs.map((x) => 2 + 0.4 * x);
    const r = linearRegression(xs, ys);
    expect(r.slope).toBeCloseTo(0.4, 6);
    expect(r.intercept).toBeCloseTo(2, 6);
    expect(r.r2).toBeCloseTo(1, 6);
    expect(r.n).toBe(5);
  });

  it("lets weights pull the fit toward a heavily-weighted point", () => {
    const xs = [0, 10, 10];
    const ys = [0, 10, 0];
    const even = linearRegression(xs, ys);
    const weighted = linearRegression(xs, ys, [1, 1000, 1]);
    expect(weighted.slope).toBeGreaterThan(even.slope);
  });

  it("degrades gracefully with fewer than two points or no x-variance", () => {
    expect(linearRegression([], [])).toEqual({ slope: 0, intercept: 0, r2: 0, n: 0 });
    expect(linearRegression([5], [3])).toEqual({ slope: 0, intercept: 3, r2: 0, n: 1 });
    const flat = linearRegression([2, 2, 2], [1, 2, 3]);
    expect(flat.slope).toBe(0);
    expect(flat.intercept).toBeCloseTo(2, 6);
  });
});

describe("speedCapIndices", () => {
  it("drops only segments above the cap, keeping both slow and fast believable ones", () => {
    const speeds = [8, 18, 22, 26, 160];
    const keep = speedCapIndices(speeds, 50);
    expect(keep).toEqual([0, 1, 2, 3]); // the 160 km/h glitch is gone; 8 km/h kept
  });

  it("preserves the slope by removing only the impossible point", () => {
    // y = 2 + 0.5x for believable points, plus one GPS-glitch fast point.
    const xs = [-2, -1, 0, 1, 2, 0];
    const ys = [1, 1.5, 2, 2.5, 3, 160];
    const keep = speedCapIndices(ys, 50); // drops only ys[5] = 160
    const reg = linearRegression(
      keep.map((i) => xs[i]),
      keep.map((i) => ys[i]),
    );
    expect(keep).not.toContain(5);
    expect(reg.slope).toBeCloseTo(0.5, 4);
    expect(reg.intercept).toBeCloseTo(2, 4);
  });

  it("keeps everything when the cap is 0 or non-positive", () => {
    const speeds = [10, 20, 30, 200];
    expect(speedCapIndices(speeds, 0)).toEqual([0, 1, 2, 3]);
    expect(speedCapIndices(speeds, -5)).toEqual([0, 1, 2, 3]);
  });
});
