import { describe, expect, it } from "vitest";

import type { LocRecord } from "../src/loc-model";
import {
  buildDaySamples,
  dayKeyOf,
  daysBetween,
  groupConsecutiveDays,
  groupVisitsByDay,
  posAt,
  selectionStats,
  visitsBox,
} from "../src/timeline-geo";

const T = (iso: string): number => Date.parse(iso);

function visit(t: string, lat: number, lon: number, dwellH = 1): LocRecord {
  return {
    kind: "visit",
    sourceId: 0,
    t: T(t),
    endT: T(t) + dwellH * 3.6e6,
    lat,
    lon,
    accClass: "derived",
  };
}

describe("dayKeyOf", () => {
  it("returns the UTC YYYY-MM-DD for an instant", () => {
    expect(dayKeyOf(T("2024-06-13T14:22:00Z"))).toBe("2024-06-13");
    expect(dayKeyOf(T("2024-06-13T23:59:59Z"))).toBe("2024-06-13");
    expect(dayKeyOf(T("2024-06-14T00:00:00Z"))).toBe("2024-06-14");
  });
});

describe("buildDaySamples", () => {
  it("expands visits and moves into time-sorted endpoint samples", () => {
    const recs: LocRecord[] = [
      // out of order on purpose; result must be sorted by time
      {
        kind: "move",
        sourceId: 0,
        t: T("2024-06-13T09:00:00Z"),
        endT: T("2024-06-13T09:30:00Z"),
        lat: 52.0,
        lon: 4.0,
        lat2: 52.1,
        lon2: 4.1,
        accClass: "derived",
      },
      {
        kind: "visit",
        sourceId: 1,
        t: T("2024-06-13T08:00:00Z"),
        endT: T("2024-06-13T08:45:00Z"),
        lat: 51.9,
        lon: 3.9,
        accClass: "derived",
      },
      {
        kind: "path",
        sourceId: 2,
        t: T("2024-06-13T10:00:00Z"),
        lat: 52.2,
        lon: 4.2,
        accClass: "approx",
      },
    ];
    const s = buildDaySamples(recs);
    // visit → 2 samples, move → 2 samples, path → 1 = 5
    expect(s.length).toBe(5);
    expect(s.map((x) => x.t)).toEqual([...s.map((x) => x.t)].sort((a, b) => a - b));
    // first sample is the visit start
    expect(s[0]).toEqual({ t: T("2024-06-13T08:00:00Z"), lat: 51.9, lon: 3.9 });
    // move contributes its end point
    expect(s).toContainEqual({ t: T("2024-06-13T09:30:00Z"), lat: 52.1, lon: 4.1 });
  });
});

describe("posAt", () => {
  const samples = [
    { t: 0, lat: 0, lon: 0 },
    { t: 100, lat: 10, lon: 20 },
    { t: 200, lat: 10, lon: 20 }, // a stationary stretch (a visit)
  ];

  it("clamps before the first and after the last sample", () => {
    expect(posAt(samples, -50)).toEqual([0, 0]);
    expect(posAt(samples, 999)).toEqual([10, 20]);
  });

  it("interpolates linearly between two samples", () => {
    expect(posAt(samples, 50)).toEqual([5, 10]);
    expect(posAt(samples, 25)).toEqual([2.5, 5]);
  });

  it("holds position across a stationary stretch", () => {
    expect(posAt(samples, 150)).toEqual([10, 20]);
  });

  it("returns null when there are no samples", () => {
    expect(posAt([], 100)).toBeNull();
  });

  it("lands exactly on a sample's own time", () => {
    expect(posAt(samples, 100)).toEqual([10, 20]);
  });
});

describe("groupVisitsByDay (area-select 'when was I here')", () => {
  it("buckets matched visits into newest-first days with summed dwell", () => {
    const matched = [
      visit("2020-06-13T09:00:00Z", 52.0, 4.0, 2),
      visit("2020-06-13T15:00:00Z", 52.0, 4.0, 1),
      visit("2024-03-02T10:00:00Z", 52.0, 4.0, 3),
    ];
    const days = groupVisitsByDay(matched);
    expect(days.map((d) => d.day)).toEqual(["2024-03-02", "2020-06-13"]); // newest first
    const old = days.find((d) => d.day === "2020-06-13")!;
    expect(old.visits.length).toBe(2);
    expect(old.dwellSec).toBe(3 * 3600); // 2h + 1h
    // within a day, visits stay time-sorted
    expect(old.visits[0].t).toBeLessThan(old.visits[1].t);
  });

  it("returns [] for no matches", () => {
    expect(groupVisitsByDay([])).toEqual([]);
  });

  it("dedupes overlapping/nested visits (union, not sum) so a day never exceeds 24h", () => {
    const days = groupVisitsByDay([
      // two nested visits over the SAME 8h window (a place + a finer place)
      visit("2026-01-04T07:00:00Z", 52, 4, 8),
      visit("2026-01-04T07:00:00Z", 52.01, 4.01, 8),
      // a separate 2h block earlier
      visit("2026-01-04T04:00:00Z", 52, 4, 2),
    ]);
    // union = 2h + 8h = 10h, NOT 18h
    expect(days[0].dwellSec).toBe(10 * 3600);
  });

  it("clips a midnight-spanning visit to each day (no >24h dumping)", () => {
    const days = groupVisitsByDay([
      // 18:00 Jan 4 → 10:00 Jan 5 (16h), all attributed to its start day but clipped
      visit("2026-01-04T18:00:00Z", 52, 4, 16),
    ]);
    const jan4 = days.find((d) => d.day === "2026-01-04")!;
    // only the 18:00→24:00 portion (6h) falls within Jan 4
    expect(jan4.dwellSec).toBe(6 * 3600);
    expect(jan4.dwellSec).toBeLessThanOrEqual(86400);
  });
});

describe("visitsBox", () => {
  it("computes the bounding box of matched visits", () => {
    const box = visitsBox([
      visit("2020-01-01T00:00:00Z", 52.0, 4.0),
      visit("2020-01-02T00:00:00Z", 51.5, 4.9),
      visit("2020-01-03T00:00:00Z", 52.3, 3.8),
    ])!;
    expect(box.minLat).toBeCloseTo(51.5, 6);
    expect(box.maxLat).toBeCloseTo(52.3, 6);
    expect(box.minLon).toBeCloseTo(3.8, 6);
    expect(box.maxLon).toBeCloseTo(4.9, 6);
  });

  it("returns null when empty", () => {
    expect(visitsBox([])).toBeNull();
  });
});

describe("selectionStats", () => {
  it("summarizes span, totals and the per-year distribution", () => {
    const days = groupVisitsByDay([
      visit("2018-05-10T09:00:00Z", 52, 4, 2),
      visit("2018-09-20T09:00:00Z", 52, 4, 1),
      visit("2018-11-02T09:00:00Z", 52, 4, 1),
      visit("2023-01-15T09:00:00Z", 52, 4, 4),
      visit("2024-06-30T09:00:00Z", 52, 4, 1),
    ]);
    const s = selectionStats(days)!;
    expect(s.totalDays).toBe(5);
    expect(s.totalVisits).toBe(5);
    expect(s.firstDay).toBe("2018-05-10");
    expect(s.lastDay).toBe("2024-06-30");
    expect(s.perYear.get(2018)).toBe(3);
    expect(s.perYear.get(2023)).toBe(1);
    expect(s.perYear.get(2024)).toBe(1);
    expect(s.totalDwellSec).toBe((2 + 1 + 1 + 4 + 1) * 3600);
  });

  it("returns null for an empty selection", () => {
    expect(selectionStats([])).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts calendar days between two day keys", () => {
    expect(daysBetween("2023-06-08", "2023-06-09")).toBe(1);
    expect(daysBetween("2023-06-08", "2023-06-27")).toBe(19);
    expect(daysBetween("2022-12-31", "2023-01-01")).toBe(1); // year boundary
    expect(daysBetween("2023-06-09", "2023-06-08")).toBe(-1);
  });
});

describe("groupConsecutiveDays", () => {
  it("merges consecutive days (and single-day gaps) into one period", () => {
    const days = groupVisitsByDay([
      visit("2023-06-08T09:00:00Z", 52, 4, 2),
      visit("2023-06-09T09:00:00Z", 52, 4, 1),
      // 2023-06-10 missing (1-day gap, still one stay by default)
      visit("2023-06-11T09:00:00Z", 52, 4, 3),
    ]);
    const periods = groupConsecutiveDays(days);
    expect(periods.length).toBe(1);
    expect(periods[0].startDay).toBe("2023-06-08");
    expect(periods[0].endDay).toBe("2023-06-11");
    expect(periods[0].dayCount).toBe(3);
    expect(periods[0].spanDays).toBe(4); // 8→11 inclusive
    expect(periods[0].totalDwellSec).toBe(6 * 3600);
    // days within the period are newest-first
    expect(periods[0].days[0].day).toBe("2023-06-11");
  });

  it("splits into separate periods across a real gap, newest period first", () => {
    const days = groupVisitsByDay([
      visit("2019-08-01T09:00:00Z", 52, 4, 1),
      visit("2019-08-02T09:00:00Z", 52, 4, 1),
      visit("2024-03-10T09:00:00Z", 52, 4, 1),
    ]);
    const periods = groupConsecutiveDays(days);
    expect(periods.length).toBe(2);
    expect(periods[0].startDay).toBe("2024-03-10"); // newest period first
    expect(periods[1].startDay).toBe("2019-08-01");
    expect(periods[1].dayCount).toBe(2);
  });

  it("respects a custom gap tolerance", () => {
    const days = groupVisitsByDay([
      visit("2023-01-01T09:00:00Z", 52, 4),
      // 3-day gap
      visit("2023-01-05T09:00:00Z", 52, 4),
    ]);
    expect(groupConsecutiveDays(days, 1).length).toBe(2); // default: split
    expect(groupConsecutiveDays(days, 5).length).toBe(1); // tolerant: one stay
  });

  it("returns [] for no days", () => {
    expect(groupConsecutiveDays([])).toEqual([]);
  });
});
