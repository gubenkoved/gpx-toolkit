import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  detectFormat,
  parseLatLng,
  parseLocationHistory,
  parseOnDevice,
} from "../src/loc-parse";

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "location",
      "on-device-sample.json",
    ),
    "utf-8",
  ),
) as unknown;

const OPTS = { importedAt: 1_700_000_000_000, importId: "test-import" } as const;

describe("parseLatLng", () => {
  it("parses the on-device \u201clat\u00b0, lon\u00b0\u201d form", () => {
    expect(parseLatLng("51.5403834\u00b0, 46.0242612\u00b0")).toEqual([51.5403834, 46.0242612]);
  });

  it("parses a plain comma-separated pair without degree marks", () => {
    expect(parseLatLng("52.28, 4.83")).toEqual([52.28, 4.83]);
  });

  it("never treats the comma as a decimal separator (lat/lon split, dot-decimal)", () => {
    // "13,5" must NOT become 13.5 — the comma is the lat/lon separator.
    expect(parseLatLng("13,5")).toEqual([13, 5]);
  });

  it("rejects malformed, out-of-range, and non-string input", () => {
    expect(parseLatLng("garbage")).toBeNull();
    expect(parseLatLng("1, 2, 3")).toBeNull();
    expect(parseLatLng("100.0, 0.0")).toBeNull(); // lat out of range
    expect(parseLatLng("0.0, 200.0")).toBeNull(); // lon out of range
    expect(parseLatLng(42)).toBeNull();
    expect(parseLatLng(null)).toBeNull();
  });
});

describe("detectFormat", () => {
  it("recognizes the on-device Timeline export", () => {
    expect(detectFormat(FIXTURE)).toBe("on-device");
    expect(detectFormat({ semanticSegments: [] })).toBe("on-device");
    expect(detectFormat({ rawSignals: [] })).toBe("on-device");
  });

  it("recognizes legacy shapes and unknowns", () => {
    expect(detectFormat({ locations: [] })).toBe("records");
    expect(detectFormat({ timelineObjects: [] })).toBe("semantic");
    expect(detectFormat({ nope: true })).toBeNull();
    expect(detectFormat(null)).toBeNull();
  });
});

describe("parseOnDevice", () => {
  const imp = parseOnDevice(FIXTURE, OPTS);

  it("captures every record kind in one time-ordered stream", () => {
    expect(imp.counts.path).toBe(2); // two timelinePath samples
    expect(imp.counts.visit).toBe(2); // WORK + HOME
    expect(imp.counts.move).toBe(3); // three activity segments
    expect(imp.counts.fix).toBe(2); // two rawSignals.position fixes
    // records are sorted ascending by time
    const times = imp.records.map((r) => r.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("ignores timelineMemory, activityRecord and wifiScan (privacy)", () => {
    // No record should carry a Wi-Fi MAC or come from a memory/activityRecord shape.
    expect(imp.records.every((r) => r.kind === "path" || r.kind === "visit" || r.kind === "move" || r.kind === "fix")).toBe(true);
    // 2 path + 2 visit + 3 move + 2 fix = 9 total; nothing leaked from wifiScan.
    expect(imp.records.length).toBe(9);
  });

  it("parses a visit with dwell, semanticType and placeId", () => {
    const work = imp.records.find((r) => r.kind === "visit" && r.semanticType === "WORK");
    expect(work).toBeDefined();
    expect(work!.lat).toBeCloseTo(51.5417992, 6);
    expect(work!.lon).toBeCloseTo(46.019505, 6);
    expect(work!.placeId).toBe("ChIJ1QEIXMnHFEERPgXQzOFHOzM");
    expect(work!.accClass).toBe("derived");
    // dwell span present
    expect(work!.endT! - work!.t).toBeGreaterThan(0);
  });

  it("parses an activity with start/end, distance and mode", () => {
    const move = imp.records.find((r) => r.kind === "move" && r.actType === "IN_PASSENGER_VEHICLE");
    expect(move).toBeDefined();
    expect(move!.distanceM).toBeCloseTo(35309.296875, 3);
    expect(move!.lat2).toBeDefined();
    expect(move!.lon2).toBeDefined();
    expect(move!.accClass).toBe("derived");
  });

  it("parses a raw fix with accuracy class, altitude, speed and source", () => {
    const fix = imp.records.find((r) => r.kind === "fix" && r.fixSource === "WIFI");
    expect(fix).toBeDefined();
    expect(fix!.accM).toBe(19);
    expect(fix!.accClass).toBe("fine"); // 10–50 m
    expect(fix!.altM).toBe(41.5);
    expect(fix!.speed).toBe(0);
  });

  it("buckets a 10–50m fix as 'fine'", () => {
    const gps = imp.records.find((r) => r.kind === "fix" && r.fixSource === "WIFI_ONLY");
    expect(gps).toBeDefined();
    expect(gps!.accM).toBe(17);
    expect(gps!.accClass).toBe("fine");
  });

  it("builds a source dictionary; every record references a real def", () => {
    // on-device has no device id; sources differ only by Google origin.
    const origins = imp.sources.map((s) => s.origin).sort();
    expect(origins).toEqual(["raw.position", "seg.activity", "seg.path", "seg.visit"]);
    expect(imp.sources.every((s) => s.format === "on-device")).toBe(true);
    expect(imp.sources.every((s) => s.importId === "test-import")).toBe(true);
    expect(imp.sources.every((s) => s.device === undefined)).toBe(true);
    // sourceId is a valid index into sources for every record
    for (const r of imp.records) {
      expect(imp.sources[r.sourceId]).toBeDefined();
    }
    // counts on the defs sum to the record total
    const sum = imp.sources.reduce((a, s) => a + (s.count ?? 0), 0);
    expect(sum).toBe(imp.records.length);
  });

  it("lifts Google's precomputed profile", () => {
    expect(imp.profile).not.toBeNull();
    const p = imp.profile!;
    expect(p.frequentPlaces.length).toBe(10);
    const home = p.frequentPlaces.find((fp) => fp.label === "HOME");
    expect(home).toBeDefined();
    expect(home!.lat).toBeCloseTo(52.2828123, 6);
    expect(p.frequentTrips.length).toBeGreaterThan(0);
    // start/endTimeMinutes are minute-of-week, preserved verbatim
    const hometowork = p.frequentTrips.find(
      (t) => t.commuteDirection === "COMMUTE_DIRECTION_HOME_TO_WORK",
    );
    expect(hometowork).toBeDefined();
    expect(hometowork!.startMinuteOfWeek).toBe(600);
    expect(p.travelModeAffinities[0].mode).toBe("CYCLING");
    expect(p.travelModeAffinities[0].affinity).toBeCloseTo(0.672, 3);
  });

  it("counts unparseable points as skipped rather than throwing", () => {
    const bad = {
      semanticSegments: [
        {
          startTime: "2020-01-01T00:00:00.000Z",
          endTime: "2020-01-01T01:00:00.000Z",
          timelinePath: [
            { point: "garbage", time: "2020-01-01T00:10:00.000Z" },
            { point: "52.0\u00b0, 4.0\u00b0", time: "not-a-time" },
            { point: "52.1\u00b0, 4.1\u00b0", time: "2020-01-01T00:20:00.000Z" },
          ],
        },
      ],
    };
    const r = parseOnDevice(bad, OPTS);
    expect(r.counts.path).toBe(1);
    expect(r.skipped).toBe(2);
  });
});

describe("parseLocationHistory dispatch", () => {
  it("parses an on-device document", () => {
    const imp = parseLocationHistory(FIXTURE, OPTS);
    expect(imp.records.length).toBeGreaterThan(0);
  });

  it("rejects legacy and unknown formats with a friendly error", () => {
    expect(() => parseLocationHistory({ locations: [] })).toThrow(/Records\.json/);
    expect(() => parseLocationHistory({ timelineObjects: [] })).toThrow(/Semantic/);
    expect(() => parseLocationHistory({ nope: true })).toThrow(/Unrecognized/);
  });
});
