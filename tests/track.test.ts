import { describe, expect, it } from "vitest";

import {
  decodePolyline,
  encodePolyline,
  extractTrack,
  gpxToRoughPolyline,
  simplify,
  type LatLon,
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

describe("gpxToRoughPolyline", () => {
  it("produces a compact, decodable polyline", () => {
    const bytes = new TextEncoder().encode(GPX);
    const encoded = gpxToRoughPolyline(bytes, 100);
    expect(encoded.length).toBeGreaterThan(0);
    const decoded = decodePolyline(encoded);
    expect(decoded.length).toBeGreaterThanOrEqual(2);
    expect(decoded[0][0]).toBeCloseTo(52.37, 4);
  });

  it("returns empty string when there is no usable track", () => {
    expect(gpxToRoughPolyline(new TextEncoder().encode("<gpx></gpx>"), 100)).toBe("");
  });
});
