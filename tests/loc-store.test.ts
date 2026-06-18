import { describe, expect, it } from "vitest";

import { memoryBlobBackend } from "../src/kv";
import type { LocRecord, LocSourceDef } from "../src/loc-model";
import { LocationHistoryStore, monthKey } from "../src/loc-store";

function recordsAcrossMonths(): LocRecord[] {
  return [
    {
      kind: "path",
      sourceId: 0,
      t: Date.parse("2020-09-15T12:00:00Z"),
      lat: 51.5,
      lon: 46.0,
      accClass: "approx",
    },
    {
      kind: "visit",
      sourceId: 1,
      t: Date.parse("2020-09-15T13:00:00Z"),
      endT: Date.parse("2020-09-15T18:00:00Z"),
      lat: 51.54,
      lon: 46.02,
      accClass: "derived",
      semanticType: "HOME",
    },
    {
      kind: "move",
      sourceId: 2,
      t: Date.parse("2020-10-02T08:00:00Z"),
      endT: Date.parse("2020-10-02T08:30:00Z"),
      lat: 52.0,
      lon: 4.8,
      lat2: 52.1,
      lon2: 4.9,
      accClass: "derived",
      actType: "CYCLING",
      distanceM: 5000,
    },
    {
      kind: "fix",
      sourceId: 3,
      t: Date.parse("2021-01-20T09:00:00Z"),
      lat: 52.28,
      lon: 4.83,
      accClass: "fine",
      accM: 12,
      fixSource: "GPS",
    },
  ];
}

function sources(): LocSourceDef[] {
  return [
    { id: 0, format: "on-device", origin: "seg.path", importId: "imp1" },
    { id: 1, format: "on-device", origin: "seg.visit", importId: "imp1" },
    { id: 2, format: "on-device", origin: "seg.activity", importId: "imp1" },
    { id: 3, format: "on-device", origin: "raw.position", importId: "imp1" },
  ];
}

describe("monthKey", () => {
  it("buckets a timestamp into its UTC YYYY-MM", () => {
    expect(monthKey(Date.parse("2020-09-15T12:00:00Z"))).toBe("2020-09");
    expect(monthKey(Date.parse("2021-01-01T00:00:00Z"))).toBe("2021-01");
  });
});

describe("LocationHistoryStore", () => {
  it("imports records, buckets by month, and reports extent", async () => {
    const store = LocationHistoryStore.memory();
    await store.addImport(recordsAcrossMonths(), sources());

    expect(store.isEmpty()).toBe(false);
    expect(store.months()).toEqual(["2020-09", "2020-10", "2021-01"]);
    expect(store.totalRecords()).toBe(4);
    expect(store.totalBytes()).toBeGreaterThan(0);

    const range = store.timeRange()!;
    expect(range[0]).toBe(Date.parse("2020-09-15T12:00:00Z"));
    expect(range[1]).toBe(Date.parse("2021-01-20T09:00:00Z"));

    const bounds = store.bounds()!;
    expect(bounds[0]).toBeCloseTo(51.5, 4); // minLat
    expect(bounds[2]).toBeCloseTo(52.28, 4); // maxLat
  });

  it("round-trips a month's records through storage", async () => {
    const store = LocationHistoryStore.memory();
    await store.addImport(recordsAcrossMonths(), sources());

    const sep = await store.getMonth("2020-09");
    expect(sep.length).toBe(2);
    const visit = sep.find((r) => r.kind === "visit")!;
    expect(visit.semanticType).toBe("HOME");
    expect(visit.lat).toBeCloseTo(51.54, 7);

    const empty = await store.getMonth("1999-01");
    expect(empty).toEqual([]);
  });

  it("filters months by range", async () => {
    const store = LocationHistoryStore.memory();
    await store.addImport(recordsAcrossMonths(), sources());
    expect(
      store.monthsInRange(
        Date.parse("2020-10-01T00:00:00Z"),
        Date.parse("2021-12-31T00:00:00Z"),
      ),
    ).toEqual(["2020-10", "2021-01"]);
  });

  it("persists a catalog that reload() restores", async () => {
    const backend = memoryBlobBackend();
    const store = await LocationHistoryStore.load(backend);
    await store.addImport(recordsAcrossMonths(), sources());

    const reopened = await LocationHistoryStore.load(backend);
    expect(reopened.months()).toEqual(["2020-09", "2020-10", "2021-01"]);
    expect(reopened.totalRecords()).toBe(4);
    expect(reopened.sources().length).toBe(4);
    const sep = await reopened.getMonth("2020-09");
    expect(sep.length).toBe(2);
  });

  it("merges sources across imports without duplicating identical provenance", async () => {
    const store = LocationHistoryStore.memory();
    await store.addImport(recordsAcrossMonths(), sources());
    // Re-import the same provenance defs — must NOT grow the source table.
    await store.addImport(
      [
        {
          kind: "path",
          sourceId: 0,
          t: Date.parse("2020-09-16T12:00:00Z"),
          lat: 51.6,
          lon: 46.1,
          accClass: "approx",
        },
      ],
      [{ id: 0, format: "on-device", origin: "seg.path", importId: "imp1" }],
    );
    expect(store.sources().length).toBe(4);
    expect(store.totalRecords()).toBe(5);
  });

  it("clear() empties only this store (catalog + chunks gone)", async () => {
    const backend = memoryBlobBackend();
    const store = await LocationHistoryStore.load(backend);
    await store.addImport(recordsAcrossMonths(), sources());
    expect(store.isEmpty()).toBe(false);

    await store.clear();
    expect(store.isEmpty()).toBe(true);
    expect(store.months()).toEqual([]);
    expect(await store.getMonth("2020-09")).toEqual([]);

    // A fresh load from the same backend sees nothing either.
    const reopened = await LocationHistoryStore.load(backend);
    expect(reopened.isEmpty()).toBe(true);
  });
});
