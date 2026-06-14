import { describe, expect, it } from "vitest";

import type { RideView } from "../src/controller";
import {
  emptyFilters,
  type Filters,
  filtersActive,
  matchesFilters,
  rideKm,
  visibleRides,
} from "../src/filter";
import { parseDurationSec, parseKm, parseKmh, parseMeters } from "../src/parsing";

/**
 * Build a RideView with sensible defaults; override only what a test cares about.
 * The normalized numeric fields are derived from the (possibly overridden) string
 * fields via the canonical locale-aware parsers — exactly as controller.state()
 * does — so tests stay string-based while exercising the real number path. An
 * explicit numeric override in `over` still wins.
 */
function ride(over: Partial<RideView> = {}): RideView {
  const base: RideView = {
    key: "Sat Jun 13 2026 at 14:22",
    title: "Morning ride",
    location: "",
    distance: "20 km",
    duration: "1h 00m",
    status: "pending",
    stats: {},
    track: "",
    track_src_points: 0,
    track_points: 0,
    track_km: 0,
    track_bytes: 0,
    distance_km: 0,
    avg_speed_kmh: 0,
    max_speed_kmh: 0,
    moving_sec: 0,
    elapsed_sec: 0,
    elevation_gain_m: 0,
    elevation_loss_m: 0,
    device_model: "Pixel 10 Pro",
    month_key: "2026-06",
    month_label: "June 2026",
    uploaded_at: "",
    deleted: false,
    deleted_at: "",
    ...over,
  };
  const st = base.stats;
  const reportedKm = parseKm(st?.Distance || base.distance || "");
  return {
    ...base,
    distance_km:
      over.distance_km ??
      (reportedKm > 0 ? reportedKm : base.track_km > 0 ? base.track_km : 0),
    avg_speed_kmh: over.avg_speed_kmh ?? parseKmh(st?.["Average speed"] || ""),
    max_speed_kmh: over.max_speed_kmh ?? parseKmh(st?.["Max speed"] || ""),
    moving_sec: over.moving_sec ?? parseDurationSec(st?.["Moving time"] || ""),
    elapsed_sec: over.elapsed_sec ?? parseDurationSec(st?.["Elapsed time"] || ""),
    elevation_gain_m: over.elevation_gain_m ?? parseMeters(st?.["Elevation gain"] || ""),
    elevation_loss_m: over.elevation_loss_m ?? parseMeters(st?.["Elevation loss"] || ""),
  };
}

/** Filters with a single dimension overridden from neutral. */
function f(over: Partial<Filters>): Filters {
  return { ...emptyFilters(), ...over };
}

describe("rideKm (normalized distance)", () => {
  it("reads the locale-normalized distance, never a blind comma strip", () => {
    // The whole point of the fix: a comma-decimal "13,5km" is 13.5 km, not 135.
    expect(rideKm(ride({ distance: "13,5km" }))).toBeCloseTo(13.5);
    expect(rideKm(ride({ distance: "42.5 km" }))).toBeCloseTo(42.5);
    expect(rideKm(ride({ distance: "no distance", stats: {} }))).toBe(0);
  });

  it("prefers the checked detail Distance, then the summary, then the measured track", () => {
    // Detail "Distance" is the authoritative checked figure → preferred over summary.
    expect(rideKm(ride({ distance: "12 km", stats: { Distance: "99 km" } }))).toBeCloseTo(99);
    expect(rideKm(ride({ distance: "", stats: { Distance: "31 km" } }))).toBeCloseTo(31);
    // No text distance at all → fall back to the measured track length.
    expect(rideKm(ride({ distance: "", stats: {}, track_km: 17.2 }))).toBeCloseTo(17.2);
    expect(rideKm(ride({ distance: "", stats: {} }))).toBe(0);
  });

  it("filters comma-decimal rides by distance band correctly (no 10x inflation)", () => {
    const r = ride({ distance: "13,5km" });
    // 13.5 km sits inside [10,20] and outside [50,∞) — the pre-fix 135 would flip both.
    expect(matchesFilters(f({ distMin: 10, distMax: 20 }), r)).toBe(true);
    expect(matchesFilters(f({ distMin: 50 }), r)).toBe(false);
  });
});

describe("filtersActive", () => {
  it("is false for a neutral filter set", () => {
    expect(filtersActive(emptyFilters())).toBe(false);
  });

  it("is true once any dimension is narrowed", () => {
    expect(filtersActive(f({ status: "uploaded" }))).toBe(true);
    expect(filtersActive(f({ gps: "yes" }))).toBe(true);
    expect(filtersActive(f({ details: "no" }))).toBe(true);
    expect(filtersActive(f({ deleted: "only" }))).toBe(true);
    expect(filtersActive(f({ device: "Pixel 10 Pro" }))).toBe(true);
    expect(filtersActive(f({ distMin: 5 }))).toBe(true);
    expect(filtersActive(f({ distMax: 50 }))).toBe(true);
  });
});

describe("matchesFilters — status", () => {
  it("pending excludes uploaded and deleted-pending rides", () => {
    expect(matchesFilters(f({ status: "pending" }), ride({ status: "pending" }))).toBe(true);
    expect(matchesFilters(f({ status: "pending" }), ride({ status: "uploaded" }))).toBe(false);
    expect(
      matchesFilters(f({ status: "pending" }), ride({ status: "pending", deleted: true })),
    ).toBe(false);
  });

  it("uploaded keeps only uploaded rides", () => {
    expect(matchesFilters(f({ status: "uploaded" }), ride({ status: "uploaded" }))).toBe(true);
    expect(matchesFilters(f({ status: "uploaded" }), ride({ status: "pending" }))).toBe(false);
  });

  it("other is everything that is neither pending nor uploaded", () => {
    expect(matchesFilters(f({ status: "other" }), ride({ status: "processing" }))).toBe(true);
    expect(matchesFilters(f({ status: "other" }), ride({ status: "unknown" }))).toBe(true);
    expect(matchesFilters(f({ status: "other" }), ride({ status: "pending" }))).toBe(false);
    expect(matchesFilters(f({ status: "other" }), ride({ status: "uploaded" }))).toBe(false);
  });
});

describe("matchesFilters — gps / details tri-states", () => {
  it("gps yes/no keys off track presence", () => {
    expect(matchesFilters(f({ gps: "yes" }), ride({ track: "abc" }))).toBe(true);
    expect(matchesFilters(f({ gps: "yes" }), ride({ track: "" }))).toBe(false);
    expect(matchesFilters(f({ gps: "no" }), ride({ track: "" }))).toBe(true);
    expect(matchesFilters(f({ gps: "no" }), ride({ track: "abc" }))).toBe(false);
  });

  it("details yes/no keys off the presence of checked stats", () => {
    expect(matchesFilters(f({ details: "yes" }), ride({ stats: { Distance: "20 km" } }))).toBe(
      true,
    );
    expect(matchesFilters(f({ details: "yes" }), ride({ stats: {} }))).toBe(false);
    expect(matchesFilters(f({ details: "no" }), ride({ stats: {} }))).toBe(true);
    expect(matchesFilters(f({ details: "no" }), ride({ stats: { Distance: "20 km" } }))).toBe(
      false,
    );
  });

  it("destination yes/no keys off the location (routed-destination) suffix", () => {
    expect(
      matchesFilters(f({ destination: "yes" }), ride({ location: ", Strand IJburg" })),
    ).toBe(true);
    expect(matchesFilters(f({ destination: "yes" }), ride({ location: "" }))).toBe(false);
    expect(matchesFilters(f({ destination: "no" }), ride({ location: "" }))).toBe(true);
    expect(
      matchesFilters(f({ destination: "no" }), ride({ location: ", Springharbor" })),
    ).toBe(false);
    // Whitespace-only location counts as "no destination".
    expect(matchesFilters(f({ destination: "yes" }), ride({ location: "   " }))).toBe(false);
  });

  it("named yes/no keys off a real title vs the auto time-of-day name", () => {
    // Real user-given names are "named".
    expect(matchesFilters(f({ named: "yes" }), ride({ title: "Let's go sailing" }))).toBe(
      true,
    );
    expect(matchesFilters(f({ named: "no" }), ride({ title: "Let's go sailing" }))).toBe(
      false,
    );
    // The synthesized time-of-day names do NOT qualify as named.
    for (const auto of ["Morning ride", "Afternoon ride", "Evening ride", "Night ride"]) {
      expect(matchesFilters(f({ named: "yes" }), ride({ title: auto }))).toBe(false);
      expect(matchesFilters(f({ named: "no" }), ride({ title: auto }))).toBe(true);
    }
    // An empty title is unnamed.
    expect(matchesFilters(f({ named: "yes" }), ride({ title: "" }))).toBe(false);
    expect(matchesFilters(f({ named: "no" }), ride({ title: "" }))).toBe(true);
  });
});

describe("matchesFilters — deleted", () => {
  it("only keeps deleted rides; none hides them", () => {
    expect(matchesFilters(f({ deleted: "only" }), ride({ deleted: true }))).toBe(true);
    expect(matchesFilters(f({ deleted: "only" }), ride({ deleted: false }))).toBe(false);
    expect(matchesFilters(f({ deleted: "none" }), ride({ deleted: false }))).toBe(true);
    expect(matchesFilters(f({ deleted: "none" }), ride({ deleted: true }))).toBe(false);
  });
});

describe("matchesFilters — device", () => {
  it("matches a specific device model exactly", () => {
    expect(
      matchesFilters(f({ device: "Pixel 10 Pro" }), ride({ device_model: "Pixel 10 Pro" })),
    ).toBe(true);
    expect(
      matchesFilters(f({ device: "Pixel 10 Pro" }), ride({ device_model: "Galaxy S25" })),
    ).toBe(false);
  });

  it("__none__ matches only rides with no recorded device", () => {
    expect(matchesFilters(f({ device: "__none__" }), ride({ device_model: "" }))).toBe(true);
    expect(
      matchesFilters(f({ device: "__none__" }), ride({ device_model: "Pixel 10 Pro" })),
    ).toBe(false);
  });
});

describe("matchesFilters — distance band", () => {
  it("applies inclusive min/max bounds in km", () => {
    expect(matchesFilters(f({ distMin: 10 }), ride({ distance: "20 km" }))).toBe(true);
    expect(matchesFilters(f({ distMin: 25 }), ride({ distance: "20 km" }))).toBe(false);
    expect(matchesFilters(f({ distMax: 25 }), ride({ distance: "20 km" }))).toBe(true);
    expect(matchesFilters(f({ distMax: 15 }), ride({ distance: "20 km" }))).toBe(false);
    expect(matchesFilters(f({ distMin: 10, distMax: 30 }), ride({ distance: "20 km" }))).toBe(
      true,
    );
  });

  it("treats an unknown distance as 0 — dropped by a min bound, kept by a max-only bound", () => {
    const unknown = ride({ distance: "", stats: {} });
    expect(matchesFilters(f({ distMin: 1 }), unknown)).toBe(false);
    expect(matchesFilters(f({ distMax: 50 }), unknown)).toBe(true);
  });
});

describe("visibleRides", () => {
  const rides = [
    ride({
      key: "a",
      status: "uploaded",
      track: "xy",
      stats: { Distance: "40 km" },
      distance: "40 km",
      device_model: "Pixel 10 Pro",
    }),
    ride({
      key: "b",
      status: "pending",
      track: "",
      stats: {},
      distance: "5 km",
      device_model: "Galaxy S25",
    }),
    ride({
      key: "c",
      status: "pending",
      track: "xy",
      stats: { Distance: "20 km" },
      distance: "20 km",
      deleted: true,
      device_model: "",
    }),
  ];

  it("returns the same array reference when no filter is active", () => {
    expect(visibleRides(emptyFilters(), rides)).toBe(rides);
  });

  it("combines dimensions with AND", () => {
    // pending + has GPS → only the deleted ride 'c' has both, but status pending
    // excludes deleted-pending, so nothing matches.
    expect(
      visibleRides(f({ status: "pending", gps: "yes" }), rides).map((r) => r.key),
    ).toEqual([]);
    // has GPS + not deleted → only 'a'.
    expect(visibleRides(f({ gps: "yes", deleted: "none" }), rides).map((r) => r.key)).toEqual([
      "a",
    ]);
    // distance ≥ 10 → 'a' (40) and 'c' (20).
    expect(visibleRides(f({ distMin: 10 }), rides).map((r) => r.key)).toEqual(["a", "c"]);
    // device __none__ → only 'c'.
    expect(visibleRides(f({ device: "__none__" }), rides).map((r) => r.key)).toEqual(["c"]);
  });
});
