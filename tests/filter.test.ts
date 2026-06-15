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

/**
 * Build a RideView with sensible defaults; override only what a test cares about.
 * Metrics are normalized numbers (null = unknown) — the parsing/migration boundary
 * is exercised by parsing.test and store.test, so filter tests deal in numbers.
 */
function ride(over: Partial<RideView> = {}): RideView {
  return {
    key: "Sat Jun 13 2026 at 14:22",
    title: "Morning ride",
    location: "",
    status: "pending",
    track: "",
    track_src_points: 0,
    track_points: 0,
    track_km: 0,
    track_bytes: 0,
    distance_km: null,
    moving_sec: null,
    elapsed_sec: null,
    avg_speed_kmh: null,
    max_speed_kmh: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    device_model: "Pixel 10 Pro",
    month_key: "2026-06",
    month_label: "June 2026",
    uploaded_at: "",
    deleted: false,
    deleted_at: "",
    ...over,
  };
}

/** Filters with a single dimension overridden from neutral. */
function f(over: Partial<Filters>): Filters {
  return { ...emptyFilters(), ...over };
}

describe("rideKm (normalized distance)", () => {
  it("reads the normalized distance_km directly", () => {
    expect(rideKm(ride({ distance_km: 13.5 }))).toBeCloseTo(13.5);
    expect(rideKm(ride({ distance_km: 42.5 }))).toBeCloseTo(42.5);
    expect(rideKm(ride({ distance_km: null }))).toBe(0);
  });

  it("filters by distance band correctly", () => {
    const r = ride({ distance_km: 13.5 });
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
  it("uploaded keeps only uploaded rides", () => {
    expect(matchesFilters(f({ status: "uploaded" }), ride({ status: "uploaded" }))).toBe(true);
    expect(matchesFilters(f({ status: "uploaded" }), ride({ status: "pending" }))).toBe(false);
    expect(matchesFilters(f({ status: "uploaded" }), ride({ status: "processing" }))).toBe(
      false,
    );
  });

  it("processing keeps only mid-flight uploads", () => {
    expect(matchesFilters(f({ status: "processing" }), ride({ status: "processing" }))).toBe(
      true,
    );
    expect(matchesFilters(f({ status: "processing" }), ride({ status: "pending" }))).toBe(false);
    expect(matchesFilters(f({ status: "processing" }), ride({ status: "uploaded" }))).toBe(
      false,
    );
  });

  it("not-uploaded is everything still eligible to upload (pending/unknown)", () => {
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "pending" }))).toBe(true);
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "unknown" }))).toBe(true);
    expect(
      matchesFilters(f({ status: "not-uploaded" }), ride({ status: "pending", deleted: true })),
    ).toBe(true);
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "uploaded" }))).toBe(
      false,
    );
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "processing" }))).toBe(
      false,
    );
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
    expect(matchesFilters(f({ details: "yes" }), ride({ avg_speed_kmh: 20 }))).toBe(true);
    expect(matchesFilters(f({ details: "yes" }), ride({}))).toBe(false);
    expect(matchesFilters(f({ details: "no" }), ride({}))).toBe(true);
    expect(matchesFilters(f({ details: "no" }), ride({ avg_speed_kmh: 20 }))).toBe(false);
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
    expect(matchesFilters(f({ distMin: 10 }), ride({ distance_km: 20 }))).toBe(true);
    expect(matchesFilters(f({ distMin: 25 }), ride({ distance_km: 20 }))).toBe(false);
    expect(matchesFilters(f({ distMax: 25 }), ride({ distance_km: 20 }))).toBe(true);
    expect(matchesFilters(f({ distMax: 15 }), ride({ distance_km: 20 }))).toBe(false);
    expect(matchesFilters(f({ distMin: 10, distMax: 30 }), ride({ distance_km: 20 }))).toBe(
      true,
    );
  });

  it("treats an unknown distance as 0 — dropped by a min bound, kept by a max-only bound", () => {
    const unknown = ride({ distance_km: null });
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
      avg_speed_kmh: 22,
      distance_km: 40,
      device_model: "Pixel 10 Pro",
    }),
    ride({
      key: "b",
      status: "pending",
      track: "",
      distance_km: 5,
      device_model: "Galaxy S25",
    }),
    ride({
      key: "c",
      status: "pending",
      track: "xy",
      avg_speed_kmh: 18,
      distance_km: 20,
      deleted: true,
      device_model: "",
    }),
  ];

  it("returns the same array reference when no filter is active", () => {
    expect(visibleRides(emptyFilters(), rides)).toBe(rides);
  });

  it("combines dimensions with AND", () => {
    // not-uploaded + has GPS → 'a' is uploaded (out), 'b' has no track (out),
    // 'c' is pending (still eligible, deletion is orthogonal) with a track → only 'c'.
    expect(
      visibleRides(f({ status: "not-uploaded", gps: "yes" }), rides).map((r) => r.key),
    ).toEqual(["c"]);
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
