import { describe, expect, it } from "vitest";

import {
  decodePolyline,
  encodePolyline,
  extractFullTrack,
  extractTrack,
  filledTimes,
  fullTrackSpeedsKmh,
  fullTrackSummary,
  gpxToRoughTrack,
  hasElevation,
  hasTimes,
  type LatLon,
  movingAverage,
  simplify,
  stoppedRanges,
  stableStoppedRanges,
  trackLengthKm,
} from "../src/track";

const GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
  <trkpt lat="52.370000" lon="4.900000"></trkpt>
  <trkpt lat="52.371000" lon="4.901000"></trkpt>
  <trkpt lat="52.372000" lon="4.902500"></trkpt>
  <trkpt lat="52.373000" lon="4.904000"></trkpt>
</trkseg></trk></gpx>`;

describe("extractTrack", () => {
  it("reads trkpt lat/lon pairs", () => {
    const pts = extractTrack(GPX);
    expect(pts.length).toBe(4);
    expect(pts[0]).toEqual([52.37, 4.9]);
  });

  it("falls back to rtept when there is no track", () => {
    const rte = `<gpx><rte><rtept lat="1" lon="2"></rtept><rtept lat="3" lon="4"></rtept></rte></gpx>`;
    expect(extractTrack(rte)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns nothing for a GPX without points", () => {
    expect(extractTrack("<gpx></gpx>")).toEqual([]);
  });
});

const FULL_GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="Beeline"><trk><trkseg>
  <trkpt lat="52.000000" lon="5.000000"><ele>10</ele><time>2026-06-13T12:00:00.000Z</time></trkpt>
  <trkpt lat="52.001000" lon="5.000000"><ele>12.5</ele><time>2026-06-13T12:00:10.000Z</time></trkpt>
  <trkpt lat="52.002000" lon="5.000000"><ele>15</ele><time>2026-06-13T12:00:20.000Z</time></trkpt>
</trkseg></trk></gpx>`;

describe("extractFullTrack", () => {
  it("reads lat/lon plus per-point elevation and time", () => {
    const ft = extractFullTrack(FULL_GPX);
    expect(ft.points).toEqual([
      [52, 5],
      [52.001, 5],
      [52.002, 5],
    ]);
    expect(ft.eles).toEqual([10, 12.5, 15]);
    expect(ft.times[0]).toBe(Date.parse("2026-06-13T12:00:00.000Z"));
    expect(ft.times[2]).toBe(Date.parse("2026-06-13T12:00:20.000Z"));
    expect(hasElevation(ft)).toBe(true);
    expect(hasTimes(ft)).toBe(true);
  });

  it("tolerates points missing ele/time (records null for them)", () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"></trkpt>
      <trkpt lat="3" lon="4"><ele>7</ele></trkpt>
    </trkseg></trk></gpx>`;
    const ft = extractFullTrack(gpx);
    expect(ft.points).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(ft.eles).toEqual([null, 7]);
    expect(ft.times).toEqual([null, null]);
    expect(hasElevation(ft)).toBe(false); // only one real elevation
    expect(hasTimes(ft)).toBe(false);
  });
});

describe("fullTrackSpeedsKmh", () => {
  it("derives per-point speed from times + geometry", () => {
    const ft = extractFullTrack(FULL_GPX);
    const speeds = fullTrackSpeedsKmh(ft);
    expect(speeds).toHaveLength(3);
    // ~111.2 m over 10 s ≈ 40 km/h between each consecutive pair.
    expect(speeds[0]).toBeGreaterThan(38);
    expect(speeds[0]).toBeLessThan(42);
    // Final point repeats the previous speed (no trailing gap).
    expect(speeds[2]).toBeCloseTo(speeds[1] as number, 6);
  });

  it("returns nulls where timestamps are missing", () => {
    const ft = extractFullTrack(
      `<gpx><trk><trkseg>
        <trkpt lat="1" lon="2"></trkpt>
        <trkpt lat="1.001" lon="2"></trkpt>
      </trkseg></trk></gpx>`,
    );
    expect(fullTrackSpeedsKmh(ft)).toEqual([null, null]);
  });
});

describe("fullTrackSummary", () => {
  it("derives the full-track-only headline stats", () => {
    const ft = extractFullTrack(FULL_GPX);
    const s = fullTrackSummary(ft);
    expect(s.points).toBe(3);
    expect(s.distanceKm).toBeGreaterThan(0);
    // Monotonic climb 10→12.5→15 → +5 m gain, 0 loss.
    expect(s.gainM).toBeCloseTo(5, 6);
    expect(s.lossM).toBeCloseTo(0, 6);
    // 20 s recording span.
    expect(s.recordedSec).toBeCloseTo(20, 6);
    expect(s.maxKmh).toBeGreaterThan(0);
    expect(s.avgKmh).toBeGreaterThan(0);
    // Every hop is moving (~40 km/h), so moving time/speed match the overall figures.
    expect(s.movingSec).toBeCloseTo(20, 6);
    expect(s.movingAvgKmh).toBeCloseTo(s.avgKmh as number, 6);
  });

  it("leaves elevation/time fields null when the track lacks them", () => {
    const ft = extractFullTrack(
      `<gpx><trk><trkseg>
        <trkpt lat="1" lon="2"></trkpt>
        <trkpt lat="1.001" lon="2"></trkpt>
      </trkseg></trk></gpx>`,
    );
    const s = fullTrackSummary(ft);
    expect(s.points).toBe(2);
    expect(s.gainM).toBeNull();
    expect(s.lossM).toBeNull();
    expect(s.recordedSec).toBeNull();
    expect(s.maxKmh).toBeNull();
    expect(s.avgKmh).toBeNull();
    expect(s.movingSec).toBeNull();
    expect(s.movingAvgKmh).toBeNull();
  });
});

// A track that rides for a while, then sits parked (same position, clock advancing),
// to exercise the moving-time / moving-average-speed split.
function trackWithStop(): string {
  const pts: string[] = [];
  let t = 0;
  const push = (lat: number) => {
    const iso = new Date(t * 1000).toISOString();
    pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="5.000000"><time>${iso}</time></trkpt>`);
    t += 10;
  };
  // Moving: 21 points 0.001° apart every 10 s ≈ 40 km/h (200 s of riding).
  for (let i = 0; i < 21; i++) push(52 + i * 0.001);
  // Stopped: 25 points at the final position, clock still advancing (240 s parked).
  for (let i = 0; i < 25; i++) push(52.02);
  return `<gpx version="1.1"><trk><trkseg>${pts.join("")}</trkseg></trk></gpx>`;
}

describe("fullTrackSummary moving speed", () => {
  it("excludes stopped time so the moving average beats the overall average", () => {
    const ft = extractFullTrack(trackWithStop());
    const s = fullTrackSummary(ft);
    expect(s.recordedSec).toBeCloseTo(450, 6);
    expect(s.movingSec).not.toBeNull();
    expect(s.movingAvgKmh).not.toBeNull();
    // Moving time drops the long park, so it's well under the full recording span.
    expect(s.movingSec as number).toBeLessThan(s.recordedSec as number);
    // The moving average reflects the ~40 km/h riding, far above the stop-diluted overall.
    expect(s.movingAvgKmh as number).toBeGreaterThan(30);
    expect(s.movingAvgKmh as number).toBeGreaterThan(s.avgKmh as number);
  });

  it("counts a hop as moving relative to the configured threshold", () => {
    const ft = extractFullTrack(trackWithStop());
    // A threshold above the riding speed marks the whole track stopped.
    const strict = fullTrackSummary(ft, 50);
    expect(strict.movingSec).toBeNull();
    expect(strict.movingAvgKmh).toBeNull();
    // A zero threshold keeps every timed hop, so moving == overall.
    const lax = fullTrackSummary(ft, 0);
    expect(lax.movingSec).toBeCloseTo(lax.recordedSec as number, 6);
    expect(lax.movingAvgKmh).toBeCloseTo(lax.avgKmh as number, 6);
  });
});

describe("movingAverage", () => {
  it("smooths over a window and skips null gaps", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 1)).toEqual([1.5, 2, 3, 4, 4.5]);
    expect(movingAverage([2, null, 4], 1)).toEqual([2, 3, 4]);
    expect(movingAverage([null, null], 1)).toEqual([null, null]);
  });
});

describe("stoppedRanges", () => {
  it("returns contiguous hop runs below the threshold (ignoring the trailing point)", () => {
    // Hops:        [0]=5  [1]=0.5 [2]=0.2 [3]=8  [4]=0.1 (repeat, ignored)
    const speeds = [5, 0.5, 0.2, 8, 0.1];
    // Below 1 km/h: hops 1,2 (contiguous) — hop 4 is the repeated last point, ignored.
    expect(stoppedRanges(speeds, 1)).toEqual([[1, 2]]);
  });

  it("treats null (untimed) hops as moving, splitting runs", () => {
    const speeds = [0.2, null, 0.3, 9];
    // The null breaks the run, so [0,0] then [2,2] (hop 3 carries the ignored tail).
    expect(stoppedRanges(speeds, 1)).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it("finds nothing at a zero threshold (a real standstill never reads negative)", () => {
    expect(stoppedRanges([0, 0, 0, 5], 0)).toEqual([]);
  });

  it("closes an open run at the last real hop", () => {
    // All but the trailing repeat are stopped → one run over hops 0..1.
    expect(stoppedRanges([0.1, 0.2, 0.2], 1)).toEqual([[0, 1]]);
  });
});

describe("stableStoppedRanges", () => {
  // A FullTrack whose only relevant field here is `times` (seconds → ms); geometry is
  // filler since stableStoppedRanges weights runs by real hop durations, not distance.
  const ftAtSeconds = (secs: number[]) => ({
    points: secs.map((_, i) => [i * 0.001, 0] as LatLon),
    eles: secs.map(() => null),
    times: secs.map((s) => s * 1000),
  });

  it("drops a stop shorter than the minimum duration (flicker)", () => {
    const speeds = [5, 0, 0, 5, 5]; // raw stop at hops 1–2 (2 s at 1 s/hop)
    const ft = ftAtSeconds([0, 1, 2, 3, 4]);
    expect(stableStoppedRanges(ft, 1, speeds, 5, 5)).toEqual([]); // 2 s < 5 s → gone
    expect(stableStoppedRanges(ft, 1, speeds, 1, 5)).toEqual([[1, 2]]); // kept at 1 s floor
  });

  it("merges two stops separated by a brief moving blip", () => {
    const speeds = [5, 0, 0, 5, 5, 0, 0, 5, 5]; // raw stops at hops 1–2 and 5–6
    const ft = ftAtSeconds([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // Moving gap (hops 3–4) is 2 s: < 5 s merges into one stop, ≥ its own length keeps it.
    expect(stableStoppedRanges(ft, 1, speeds, 1, 5)).toEqual([[1, 6]]);
    // A tiny merge window leaves them separate.
    expect(stableStoppedRanges(ft, 1, speeds, 1, 1)).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it("weights runs by real seconds, not hop count", () => {
    const speeds = [5, 0, 5]; // one stopped hop (index 1)
    // That single hop spans 59 s, so it survives a 10 s minimum a hop-count rule would drop.
    const ft = ftAtSeconds([0, 1, 60]);
    expect(stableStoppedRanges(ft, 1, speeds, 10, 10)).toEqual([[1, 1]]);
  });

  it("returns nothing when no hop is below the threshold", () => {
    const speeds = [9, 9, 9, 9];
    const ft = ftAtSeconds([0, 1, 2, 3]);
    expect(stableStoppedRanges(ft, 1, speeds)).toEqual([]);
  });
});

describe("filledTimes", () => {
  it("linearly interpolates internal gaps and holds the ends constant", () => {
    expect(filledTimes([null, 100, null, 400, null])).toEqual([100, 100, 250, 400, 400]);
  });

  it("falls back to the index when no timestamps exist", () => {
    expect(filledTimes([null, null, null])).toEqual([0, 1, 2]);
  });
});

describe("simplify", () => {
  it("reduces the point count to the cap", () => {
    const pts: LatLon[] = [];
    for (let i = 0; i < 500; i++) pts.push([52 + i * 0.001, 4 + Math.sin(i / 10) * 0.01]);
    const out = simplify(pts, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.length).toBeGreaterThan(1);
    // endpoints are preserved
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("keeps a track already under the cap unchanged", () => {
    const pts: LatLon[] = [
      [1, 1],
      [2, 2],
    ];
    expect(simplify(pts, 100)).toEqual(pts);
  });
});

describe("encode/decode polyline", () => {
  it("round-trips within precision tolerance", () => {
    const pts: LatLon[] = [
      [52.37, 4.9],
      [52.371, 4.9011],
      [52.3725, 4.9026],
    ];
    const decoded = decodePolyline(encodePolyline(pts));
    expect(decoded.length).toBe(pts.length);
    for (let i = 0; i < pts.length; i++) {
      expect(decoded[i][0]).toBeCloseTo(pts[i][0], 4);
      expect(decoded[i][1]).toBeCloseTo(pts[i][1], 4);
    }
  });
});

describe("trackLengthKm", () => {
  it("sums consecutive great-circle hops", () => {
    // ~1.11 km per 0.01° of latitude.
    const km = trackLengthKm([
      [52.0, 4.0],
      [52.01, 4.0],
      [52.02, 4.0],
    ]);
    expect(km).toBeGreaterThan(2.1);
    expect(km).toBeLessThan(2.3);
  });

  it("is zero for fewer than two points", () => {
    expect(trackLengthKm([])).toBe(0);
    expect(trackLengthKm([[1, 1]])).toBe(0);
  });
});

describe("gpxToRoughTrack", () => {
  it("produces a compact, decodable polyline with capture metadata", () => {
    const bytes = new TextEncoder().encode(GPX);
    const rough = gpxToRoughTrack(bytes, 10);
    expect(rough.polyline.length).toBeGreaterThan(0);
    expect(rough.srcPoints).toBe(4);
    expect(rough.keptPoints).toBeGreaterThanOrEqual(2);
    expect(rough.km).toBeGreaterThan(0);
    const decoded = decodePolyline(rough.polyline);
    expect(decoded.length).toBe(rough.keptPoints);
    expect(decoded[0][0]).toBeCloseTo(52.37, 4);
  });

  it("keeps more points at a higher density", () => {
    const pts: LatLon[] = [];
    for (let i = 0; i < 400; i++) pts.push([52 + i * 0.001, 4 + Math.sin(i / 8) * 0.01]);
    const gpx =
      `<gpx><trk><trkseg>` +
      pts.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join("") +
      `</trkseg></trk></gpx>`;
    const bytes = new TextEncoder().encode(gpx);
    const coarse = gpxToRoughTrack(bytes, 2);
    const fine = gpxToRoughTrack(bytes, 20);
    expect(fine.keptPoints).toBeGreaterThanOrEqual(coarse.keptPoints);
    // Endpoints are always preserved.
    const decoded = decodePolyline(coarse.polyline);
    expect(decoded[0][0]).toBeCloseTo(pts[0][0], 4);
    expect(decoded[decoded.length - 1][0]).toBeCloseTo(pts[pts.length - 1][0], 4);
  });

  it("returns an empty polyline when there is no usable track", () => {
    const rough = gpxToRoughTrack(new TextEncoder().encode("<gpx></gpx>"), 10);
    expect(rough.polyline).toBe("");
    expect(rough.keptPoints).toBe(0);
    expect(rough.km).toBe(0);
  });
});
