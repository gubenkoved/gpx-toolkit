import { describe, expect, it } from "vitest";

import { decodeChunk, decodeHeader, encodeChunk } from "../src/loc-codec";
import type { LocRecord } from "../src/loc-model";

function sample(): LocRecord[] {
  return [
    { kind: "path", sourceId: 0, t: 1_600_000_000_000, lat: 51.5403834, lon: 46.0242612, accClass: "approx" },
    { kind: "path", sourceId: 0, t: 1_600_000_180_000, lat: 51.5420614, lon: 46.019781, accClass: "approx" },
    {
      kind: "visit",
      sourceId: 1,
      t: 1_600_000_200_000,
      endT: 1_600_010_000_000,
      lat: 51.5417992,
      lon: 46.019505,
      accClass: "derived",
      semanticType: "WORK",
      placeId: "ChIJ1QEIXMnHFEERPgXQzOFHOzM",
      prob: 0.64,
    },
    {
      kind: "move",
      sourceId: 2,
      t: 1_600_010_000_000,
      endT: 1_600_012_000_000,
      lat: 51.5414384,
      lon: 46.0210043,
      lat2: 51.5096942,
      lon2: 45.9915304,
      accClass: "derived",
      actType: "CYCLING",
      distanceM: 4076,
      prob: 0.9,
    },
    {
      kind: "fix",
      sourceId: 3,
      t: 1_600_020_000_000,
      lat: 52.2887728,
      lon: 4.8390689,
      accClass: "fine",
      accM: 19,
      altM: 41,
      speed: 3.2,
      fixSource: "WIFI",
    },
  ];
}

describe("loc-codec round-trip", () => {
  it("preserves coordinates losslessly at E7 and timestamps exactly", () => {
    const recs = sample();
    const { records } = decodeChunk(encodeChunk("2020-09", recs));
    expect(records.length).toBe(recs.length);
    for (let i = 0; i < recs.length; i++) {
      const a = recs[i];
      // records come back sorted by time; our sample is already sorted.
      const b = records[i];
      expect(b.t).toBe(a.t);
      expect(b.lat).toBeCloseTo(a.lat, 7);
      expect(b.lon).toBeCloseTo(a.lon, 7);
      expect(b.kind).toBe(a.kind);
      expect(b.sourceId).toBe(a.sourceId);
      expect(b.accClass).toBe(a.accClass);
    }
  });

  it("preserves kind-specific optionals (dwell, end point, mode, place, fix detail)", () => {
    const recs = sample();
    const { records } = decodeChunk(encodeChunk("2020-09", recs));
    const visit = records.find((r) => r.kind === "visit")!;
    expect(visit.endT).toBe(recs[2].endT);
    expect(visit.semanticType).toBe("WORK");
    expect(visit.placeId).toBe("ChIJ1QEIXMnHFEERPgXQzOFHOzM");
    expect(visit.prob).toBeCloseTo(0.64, 2);

    const move = records.find((r) => r.kind === "move")!;
    expect(move.lat2).toBeCloseTo(51.5096942, 7);
    expect(move.lon2).toBeCloseTo(45.9915304, 7);
    expect(move.actType).toBe("CYCLING");
    expect(move.distanceM).toBe(4076);

    const fix = records.find((r) => r.kind === "fix")!;
    expect(fix.accM).toBe(19);
    expect(fix.altM).toBe(41);
    expect(fix.speed).toBeCloseTo(3.2, 2);
    expect(fix.fixSource).toBe("WIFI");
  });

  it("exposes an observable header without decoding the body", () => {
    const buf = encodeChunk("2020-09", sample());
    const h = decodeHeader(buf);
    expect(h.month).toBe("2020-09");
    expect(h.n).toBe(5);
    expect(h.kinds).toEqual({ path: 2, visit: 1, move: 1, fix: 1 });
    expect(h.sources).toEqual({ 0: 2, 1: 1, 2: 1, 3: 1 });
    expect(h.placeDict).toContain("ChIJ1QEIXMnHFEERPgXQzOFHOzM");
    expect(h.bbox[0]).toBeLessThanOrEqual(h.bbox[2]);
    expect(h.bbox[1]).toBeLessThanOrEqual(h.bbox[3]);
  });

  it("sorts records by time on encode", () => {
    const recs = sample().slice().reverse();
    const { records } = decodeChunk(encodeChunk("2020-09", recs));
    const times = records.map((r) => r.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("handles an empty month", () => {
    const buf = encodeChunk("2020-09", []);
    const { header, records } = decodeChunk(buf);
    expect(header.n).toBe(0);
    expect(records).toEqual([]);
  });

  it("handles negative coordinates and large flight distances", () => {
    const recs: LocRecord[] = [
      { kind: "move", sourceId: 0, t: 1, lat: -27.8, lon: -74.1, lat2: 67.6, lon2: 99.2, accClass: "derived", actType: "FLYING", distanceM: 8_243_326 },
    ];
    const { records } = decodeChunk(encodeChunk("2020-09", recs));
    expect(records[0].lat).toBeCloseTo(-27.8, 7);
    expect(records[0].lon).toBeCloseTo(-74.1, 7);
    expect(records[0].lat2).toBeCloseTo(67.6, 7);
    expect(records[0].distanceM).toBe(8_243_326);
  });
});
