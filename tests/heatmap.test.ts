import { describe, expect, it } from "vitest";

import {
  buildHeatPoints,
  densifyTrack,
  metresPerPixel,
  spacingForZoom,
  type HeatPoint,
} from "../src/heatmap";
import type { RideTrack } from "../src/mapview";
import type { LatLon } from "../src/track";

describe("densifyTrack", () => {
  it("keeps the original endpoints", () => {
    const pts: LatLon[] = [
      [52.0, 4.0],
      [52.01, 4.0],
    ];
    const dense = densifyTrack(pts, 50);
    expect(dense[0]).toEqual([52.0, 4.0]);
    expect(dense[dense.length - 1]).toEqual([52.01, 4.0]);
  });

  it("interpolates points roughly spacingM apart along a segment", () => {
    // ~1.11 km north (0.01° latitude). At 100 m spacing that's ~11 steps.
    const pts: LatLon[] = [
      [52.0, 4.0],
      [52.01, 4.0],
    ];
    const dense = densifyTrack(pts, 100);
    expect(dense.length).toBeGreaterThanOrEqual(10);
    expect(dense.length).toBeLessThanOrEqual(13);
    // Points should be monotonically increasing in latitude (evenly spread).
    for (let i = 1; i < dense.length; i++) {
      expect(dense[i][0]).toBeGreaterThan(dense[i - 1][0]);
    }
  });

  it("returns tracks shorter than two points unchanged", () => {
    expect(densifyTrack([], 50)).toEqual([]);
    expect(densifyTrack([[1, 2]], 50)).toEqual([[1, 2]]);
  });

  it("does not blow up on a zero/negative spacing", () => {
    const pts: LatLon[] = [
      [0, 0],
      [0, 1],
    ];
    expect(densifyTrack(pts, 0)).toEqual(pts);
  });
});

describe("buildHeatPoints", () => {
  const track = (key: string, points: LatLon[]): RideTrack => ({ key, title: key, points });

  it("emits weighted [lat, lon, weight] samples for every track", () => {
    const tracks = [track("a", [[52.0, 4.0], [52.005, 4.0]])];
    const pts = buildHeatPoints(tracks, 100, 1);
    expect(pts.length).toBeGreaterThan(1);
    for (const p of pts as HeatPoint[]) {
      expect(p).toHaveLength(3);
      expect(p[2]).toBe(1);
    }
  });

  it("accumulates more samples where two rides overlap the same corridor", () => {
    const corridor: LatLon[] = [
      [52.0, 4.0],
      [52.02, 4.0],
    ];
    const elsewhere: LatLon[] = [
      [48.0, 2.0],
      [48.001, 2.0],
    ];
    const onceRidden = buildHeatPoints([track("a", corridor), track("b", elsewhere)], 50);
    const twiceRidden = buildHeatPoints([track("a", corridor), track("b", corridor)], 50);
    // Two passes over the same corridor yield strictly more samples there, which
    // is what makes a frequently-ridden stretch glow hotter than a one-off.
    const near = (p: HeatPoint) => Math.abs(p[0] - 52.01) < 0.02 && Math.abs(p[1] - 4.0) < 0.01;
    const onceCount = (onceRidden as HeatPoint[]).filter(near).length;
    const twiceCount = (twiceRidden as HeatPoint[]).filter(near).length;
    expect(twiceCount).toBeGreaterThan(onceCount);
  });

  it("returns nothing for an empty track list", () => {
    expect(buildHeatPoints([])).toEqual([]);
  });

  it("emits no points when every segment is outside the bounds", () => {
    const here: LatLon = [52.0, 4.0];
    const alsoHere: LatLon = [52.01, 4.0];
    // A box on the other side of the planet — nothing intersects it.
    const elsewhere = { minLat: -10, minLon: -10, maxLat: -9, maxLon: -9 };
    expect(buildHeatPoints([track("a", [here, alsoHere])], 50, 1, elsewhere)).toEqual([]);
  });

  it("keeps a segment that merely crosses the viewport (both endpoints outside)", () => {
    // Endpoints sit west and east of a central box; the segment crosses it.
    const west: LatLon = [52.0, 3.0];
    const east: LatLon = [52.0, 5.0];
    const box = { minLat: 51.9, minLon: 3.9, maxLat: 52.1, maxLon: 4.1 };
    expect(buildHeatPoints([track("a", [west, east])], 50, 1, box).length).toBeGreaterThan(0);
  });

  it("scales sample weight so callers can keep glow energy constant", () => {
    const pts = buildHeatPoints([track("a", [[52.0, 4.0], [52.005, 4.0]])], 50, 0.25);
    for (const p of pts as HeatPoint[]) expect(p[2]).toBe(0.25);
  });
});

describe("metresPerPixel", () => {
  it("matches the known web-Mercator equatorial resolution at zoom 0", () => {
    // ~156543 m/px at the equator, zoom 0 (256-px world tile).
    expect(metresPerPixel(0, 0)).toBeCloseTo(156543.03392, 2);
  });

  it("halves with each zoom level", () => {
    const z4 = metresPerPixel(4, 0);
    const z5 = metresPerPixel(5, 0);
    expect(z5).toBeCloseTo(z4 / 2, 6);
  });

  it("shrinks toward the poles by cos(lat)", () => {
    const eq = metresPerPixel(10, 0);
    const lat60 = metresPerPixel(10, 60);
    // cos(60°) = 0.5, so resolution should roughly halve.
    expect(lat60).toBeCloseTo(eq * 0.5, 6);
  });
});

describe("spacingForZoom", () => {
  it("clamps to the 30 m ceiling when zoomed far out", () => {
    // Very low zoom → huge m/px → spacing pinned to the ceiling.
    expect(spacingForZoom(2, 52, 6)).toBe(30);
  });

  it("clamps to the 1 m floor when zoomed far in", () => {
    // Very high zoom + a tiny target gap → sub-metre spacing → pinned to the floor.
    expect(spacingForZoom(19, 52, 1)).toBe(1);
  });

  it("tracks zoom between the bounds so points stay merged", () => {
    // At a mid zoom the spacing should sit strictly inside the clamp range and
    // grow as we zoom out (coarser) vs. zoom in (finer).
    const coarser = spacingForZoom(13, 52, 6);
    const finer = spacingForZoom(16, 52, 6);
    expect(finer).toBeLessThan(coarser);
    expect(coarser).toBeLessThanOrEqual(30);
    expect(finer).toBeGreaterThanOrEqual(1);
  });

  it("scales spacing with the target pixel gap", () => {
    // A larger target pixel gap (thicker glow) permits coarser geographic spacing.
    const thin = spacingForZoom(14, 52, 4);
    const thick = spacingForZoom(14, 52, 12);
    expect(thick).toBeGreaterThanOrEqual(thin);
  });
});
