import { describe, expect, it } from "vitest";

import type { RideView } from "../src/controller";
import {
  discriminatingDims,
  emptyFilters,
  type Filters,
  filterActiveCount,
  filtersActive,
  matchesFilters,
  rideKm,
  type ToggleDim,
  togglePredicate,
  visibleRides,
} from "../src/filter";

/**
 * Build a RideView with sensible defaults; override only what a test cares about.
 * Metrics are normalized numbers (null = unknown) — the parsing/migration boundary
 * is exercised by parsing.test and store.test, so filter tests deal in numbers.
 */
function ride(over: Partial<RideView> = {}): RideView {
  return {
    key: "beeline::Sat Jun 13 2026 at 14:22",
    date_key: "Sat Jun 13 2026 at 14:22",
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
    source: "beeline",
    can_upload: true,
    month_key: "2026-06",
    month_label: "June 2026",
    ingested_at: "2026-06-14T09:30:00+00:00",
    uploaded_at: "",
    deleted: false,
    deleted_at: "",
    gpx_cached: false,
    wind_resolved: false,
    wind_speed_kmh: null,
    tags: [],
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
    expect(filtersActive(f({ destination: "no" }))).toBe(true);
    expect(filtersActive(f({ deleted: "only" }))).toBe(true);
    expect(filtersActive(f({ device: "Pixel 10 Pro" }))).toBe(true);
    expect(filtersActive(f({ distMin: 5 }))).toBe(true);
    expect(filtersActive(f({ distMax: 50 }))).toBe(true);
    expect(filtersActive(f({ tags: ["commute"] }))).toBe(true);
  });
});

describe("filterActiveCount", () => {
  it("is 0 for a neutral filter set", () => {
    expect(filterActiveCount(emptyFilters())).toBe(0);
  });

  it("counts one per narrowed dimension", () => {
    expect(filterActiveCount(f({ status: "uploaded" }))).toBe(1);
    expect(filterActiveCount(f({ status: "uploaded", gps: "yes" }))).toBe(2);
    expect(
      filterActiveCount(f({ status: "uploaded", gps: "yes", device: "Pixel 10 Pro" })),
    ).toBe(3);
  });

  it("counts distance once whether one or both bounds are set", () => {
    expect(filterActiveCount(f({ distMin: 5 }))).toBe(1);
    expect(filterActiveCount(f({ distMax: 50 }))).toBe(1);
    expect(filterActiveCount(f({ distMin: 5, distMax: 50 }))).toBe(1);
  });

  it("counts the tags dimension once when any tag is selected", () => {
    expect(filterActiveCount(f({ tags: [] }))).toBe(0);
    expect(filterActiveCount(f({ tags: ["commute"] }))).toBe(1);
    expect(filterActiveCount(f({ tags: ["commute", "gravel"] }))).toBe(1);
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
    expect(matchesFilters(f({ status: "processing" }), ride({ status: "pending" }))).toBe(
      false,
    );
    expect(matchesFilters(f({ status: "processing" }), ride({ status: "uploaded" }))).toBe(
      false,
    );
  });

  it("not-uploaded is everything still eligible to upload (pending/unknown)", () => {
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "pending" }))).toBe(
      true,
    );
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "unknown" }))).toBe(
      true,
    );
    expect(
      matchesFilters(
        f({ status: "not-uploaded" }),
        ride({ status: "pending", deleted: true }),
      ),
    ).toBe(true);
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "uploaded" }))).toBe(
      false,
    );
    expect(matchesFilters(f({ status: "not-uploaded" }), ride({ status: "processing" }))).toBe(
      false,
    );
  });
});

describe("matchesFilters — gps / cached tri-states", () => {
  it("gps yes/no keys off track presence", () => {
    expect(matchesFilters(f({ gps: "yes" }), ride({ track: "abc" }))).toBe(true);
    expect(matchesFilters(f({ gps: "yes" }), ride({ track: "" }))).toBe(false);
    expect(matchesFilters(f({ gps: "no" }), ride({ track: "" }))).toBe(true);
    expect(matchesFilters(f({ gps: "no" }), ride({ track: "abc" }))).toBe(false);
  });

  it("cached yes/no keys off the full-GPX cache flag, independent of track presence", () => {
    // A ride can carry the lightweight route (track) yet NOT have the full GPX cached.
    expect(
      matchesFilters(f({ cached: "yes" }), ride({ track: "abc", gpx_cached: true })),
    ).toBe(true);
    expect(
      matchesFilters(f({ cached: "yes" }), ride({ track: "abc", gpx_cached: false })),
    ).toBe(false);
    expect(
      matchesFilters(f({ cached: "no" }), ride({ track: "abc", gpx_cached: false })),
    ).toBe(true);
    expect(matchesFilters(f({ cached: "no" }), ride({ track: "abc", gpx_cached: true }))).toBe(
      false,
    );
  });

  it("wind yes/no keys off the resolved-wind flag", () => {
    expect(matchesFilters(f({ wind: "yes" }), ride({ wind_resolved: true }))).toBe(true);
    expect(matchesFilters(f({ wind: "yes" }), ride({ wind_resolved: false }))).toBe(false);
    expect(matchesFilters(f({ wind: "no" }), ride({ wind_resolved: false }))).toBe(true);
    expect(matchesFilters(f({ wind: "no" }), ride({ wind_resolved: true }))).toBe(false);
    // Neutral: passes either way.
    expect(matchesFilters(f({ wind: "any" }), ride({ wind_resolved: false }))).toBe(true);
  });

  it("wind speed bounds keep only resolved rides within the km/h range", () => {
    const windy = ride({ wind_resolved: true, wind_speed_kmh: 25 });
    const calm = ride({ wind_resolved: true, wind_speed_kmh: 8 });
    const unresolved = ride({ wind_resolved: false, wind_speed_kmh: null });
    // Min bound.
    expect(matchesFilters(f({ windMin: 15 }), windy)).toBe(true);
    expect(matchesFilters(f({ windMin: 15 }), calm)).toBe(false);
    // Max bound.
    expect(matchesFilters(f({ windMax: 15 }), calm)).toBe(true);
    expect(matchesFilters(f({ windMax: 15 }), windy)).toBe(false);
    // Both bounds (a band).
    expect(matchesFilters(f({ windMin: 10, windMax: 30 }), windy)).toBe(true);
    // Any bound excludes a ride with no resolved wind speed.
    expect(matchesFilters(f({ windMin: 5 }), unresolved)).toBe(false);
    expect(matchesFilters(f({ windMax: 50 }), unresolved)).toBe(false);
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

describe("matchesFilters — ingestion-date band", () => {
  // Build an ISO instant for a given LOCAL wall-clock time, so the day-boundary
  // edges are exact regardless of the machine timezone (the filter bounds are
  // local-day too).
  const at = (y: number, mo: number, d: number, hh = 12, mm = 0, ss = 0, ms = 0): string =>
    new Date(y, mo - 1, d, hh, mm, ss, ms).toISOString();

  it("includes rides ingested within an inclusive from–to day range", () => {
    const r = ride({ ingested_at: at(2026, 6, 15) });
    expect(matchesFilters(f({ ingestedFrom: "2026-06-10", ingestedTo: "2026-06-20" }), r)).toBe(
      true,
    );
    expect(matchesFilters(f({ ingestedFrom: "2026-06-16" }), r)).toBe(false);
    expect(matchesFilters(f({ ingestedTo: "2026-06-14" }), r)).toBe(false);
  });

  it("includes the very start of the from day and the very end of the to day", () => {
    const start = ride({ ingested_at: at(2026, 6, 10, 0, 0, 0, 0) });
    const end = ride({ ingested_at: at(2026, 6, 20, 23, 59, 59, 999) });
    expect(matchesFilters(f({ ingestedFrom: "2026-06-10" }), start)).toBe(true);
    expect(matchesFilters(f({ ingestedTo: "2026-06-20" }), end)).toBe(true);
  });

  it("excludes an instant just before the from day and just after the to day", () => {
    const justBefore = ride({ ingested_at: at(2026, 6, 9, 23, 59, 59, 999) });
    const justAfter = ride({ ingested_at: at(2026, 6, 21, 0, 0, 0, 0) });
    expect(matchesFilters(f({ ingestedFrom: "2026-06-10" }), justBefore)).toBe(false);
    expect(matchesFilters(f({ ingestedTo: "2026-06-20" }), justAfter)).toBe(false);
  });

  it("drops legacy rides with no ingestion date once a bound is set, keeps them when neutral", () => {
    const legacy = ride({ ingested_at: "" });
    expect(matchesFilters(f({ ingestedFrom: "2026-06-10" }), legacy)).toBe(false);
    expect(matchesFilters(f({ ingestedTo: "2026-06-20" }), legacy)).toBe(false);
    expect(matchesFilters(f({}), legacy)).toBe(true);
  });

  it("counts the ingestion band as a single active dimension", () => {
    expect(filterActiveCount(f({ ingestedFrom: "2026-06-10" }))).toBe(1);
    expect(
      filterActiveCount(f({ ingestedFrom: "2026-06-10", ingestedTo: "2026-06-20" })),
    ).toBe(1);
    expect(filtersActive(f({ ingestedTo: "2026-06-20" }))).toBe(true);
  });
});

describe("matchesFilters — ride-date band", () => {
  // Ride keys carry a LOCAL wall-clock datetime ("Wed Jun 17 2026 at 08:05"), so the
  // filter's local-day bounds line up exactly with the parsed reference date.
  it("includes rides whose own date falls within an inclusive from–to day range", () => {
    const r = ride({ date_key: "Wed Jun 17 2026 at 08:05" });
    expect(matchesFilters(f({ rideFrom: "2026-06-10", rideTo: "2026-06-20" }), r)).toBe(true);
    expect(matchesFilters(f({ rideFrom: "2026-06-18" }), r)).toBe(false);
    expect(matchesFilters(f({ rideTo: "2026-06-16" }), r)).toBe(false);
  });

  it("includes the very start of the from day and the very end of the to day", () => {
    const start = ride({ date_key: "Wed Jun 10 2026 at 00:00" });
    const end = ride({ date_key: "Sat Jun 20 2026 at 23:59" });
    expect(matchesFilters(f({ rideFrom: "2026-06-10" }), start)).toBe(true);
    expect(matchesFilters(f({ rideTo: "2026-06-20" }), end)).toBe(true);
  });

  it("excludes a ride dated just before the from day or just after the to day", () => {
    const before = ride({ date_key: "Tue Jun 9 2026 at 23:59" });
    const after = ride({ date_key: "Sun Jun 21 2026 at 00:00" });
    expect(matchesFilters(f({ rideFrom: "2026-06-10" }), before)).toBe(false);
    expect(matchesFilters(f({ rideTo: "2026-06-20" }), after)).toBe(false);
  });

  it("drops a ride with an unparseable date_key once a bound is set, keeps it when neutral", () => {
    const bad = ride({ date_key: "gpx::sha256:deadbeef" });
    expect(matchesFilters(f({ rideFrom: "2026-06-10" }), bad)).toBe(false);
    expect(matchesFilters(f({ rideTo: "2026-06-20" }), bad)).toBe(false);
    expect(matchesFilters(f({}), bad)).toBe(true);
  });

  it("filters on the ride's own date independently of its ingestion date", () => {
    // Ridden Jun 17 but added Jun 14 — a ride-date window that excludes Jun 17 drops it
    // even though its ingestion date is inside the same window.
    const r = ride({ date_key: "Wed Jun 17 2026 at 08:05", ingested_at: "2026-06-14T09:30:00Z" });
    expect(matchesFilters(f({ rideTo: "2026-06-15" }), r)).toBe(false);
    expect(matchesFilters(f({ ingestedTo: "2026-06-15" }), r)).toBe(true);
  });

  it("counts the ride-date band as a single active dimension", () => {
    expect(filterActiveCount(f({ rideFrom: "2026-06-10" }))).toBe(1);
    expect(filterActiveCount(f({ rideFrom: "2026-06-10", rideTo: "2026-06-20" }))).toBe(1);
    expect(filtersActive(f({ rideTo: "2026-06-20" }))).toBe(true);
  });
});

describe("matchesFilters — tags (OR)", () => {
  it("keeps a ride that carries ANY selected tag", () => {
    const r = ride({ tags: ["Commute", "Gravel"] });
    expect(matchesFilters(f({ tags: ["commute"] }), r)).toBe(true);
    expect(matchesFilters(f({ tags: ["gravel"] }), r)).toBe(true);
    // OR: matches as long as one selected tag is present, even if another isn't.
    expect(matchesFilters(f({ tags: ["gravel", "road trip"] }), r)).toBe(true);
  });

  it("drops a ride with none of the selected tags", () => {
    const r = ride({ tags: ["Commute"] });
    expect(matchesFilters(f({ tags: ["gravel"] }), r)).toBe(false);
    expect(matchesFilters(f({ tags: ["gravel", "road trip"] }), r)).toBe(false);
    expect(matchesFilters(f({ tags: ["commute"] }), ride({ tags: [] }))).toBe(false);
  });

  it("matches case-insensitively (ride casing vs selected key)", () => {
    expect(matchesFilters(f({ tags: ["commute"] }), ride({ tags: ["COMMUTE"] }))).toBe(true);
    expect(matchesFilters(f({ tags: ["road trip"] }), ride({ tags: ["Road Trip"] }))).toBe(
      true,
    );
  });

  it("is a no-op when no tag is selected", () => {
    expect(matchesFilters(f({ tags: [] }), ride({ tags: [] }))).toBe(true);
    expect(matchesFilters(f({ tags: [] }), ride({ tags: ["Commute"] }))).toBe(true);
  });
});

describe("matchesFilters — untagged pseudo-tag", () => {
  it("keeps only rides with no tags when 'untagged' is selected alone", () => {
    expect(matchesFilters(f({ untagged: true }), ride({ tags: [] }))).toBe(true);
    expect(matchesFilters(f({ untagged: true }), ride({ tags: ["Commute"] }))).toBe(false);
  });

  it("treats whitespace-only tags as untagged", () => {
    expect(matchesFilters(f({ untagged: true }), ride({ tags: ["  "] }))).toBe(true);
  });

  it("ORs with real tags — an untagged ride OR one carrying a selected tag passes", () => {
    const filter = f({ tags: ["gravel"], untagged: true });
    expect(matchesFilters(filter, ride({ tags: [] }))).toBe(true); // untagged
    expect(matchesFilters(filter, ride({ tags: ["Gravel"] }))).toBe(true); // selected tag
    expect(matchesFilters(filter, ride({ tags: ["Commute"] }))).toBe(false); // neither
  });

  it("counts as the one Tags dimension and marks the set active", () => {
    expect(filterActiveCount(f({ untagged: true }))).toBe(1);
    expect(filterActiveCount(f({ tags: ["commute"], untagged: true }))).toBe(1);
    expect(filtersActive(f({ untagged: true }))).toBe(true);
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

describe("togglePredicate / discriminatingDims", () => {
  // One ride that satisfies the positive side of each toggle dimension, and one that
  // doesn't, so we can assert the shared predicate and the matchesFilters wiring agree.
  const matching: Record<ToggleDim, Partial<RideView>> = {
    gps: { track: "xy" },
    cached: { gpx_cached: true },
    wind: { wind_resolved: true },
    destination: { location: "Cafe" },
    named: { title: "Coffee loop" },
    deleted: { deleted: true },
  };
  const notMatching: Record<ToggleDim, Partial<RideView>> = {
    gps: { track: "" },
    cached: { gpx_cached: false },
    wind: { wind_resolved: false },
    destination: { location: "  " }, // whitespace-only = no destination
    named: { title: "Morning ride" }, // synthesized time-of-day fallback
    deleted: { deleted: false },
  };
  const dims = Object.keys(matching) as ToggleDim[];

  it("predicate is true for the matching ride and false for the non-matching one", () => {
    for (const dim of dims) {
      expect(togglePredicate[dim](ride(matching[dim]))).toBe(true);
      expect(togglePredicate[dim](ride(notMatching[dim]))).toBe(false);
    }
  });

  it("shared predicate agrees with matchesFilters for every toggle dimension", () => {
    // The chip's positive ("yes"/"only") side keeps exactly the predicate-true ride and
    // drops the predicate-false one; the negative ("no"/"none") side is the mirror. This
    // is the guard against the shared predicate drifting from the filter logic.
    const pos: Record<ToggleDim, Partial<Filters>> = {
      gps: { gps: "yes" },
      cached: { cached: "yes" },
      wind: { wind: "yes" },
      destination: { destination: "yes" },
      named: { named: "yes" },
      deleted: { deleted: "only" },
    };
    const neg: Record<ToggleDim, Partial<Filters>> = {
      gps: { gps: "no" },
      cached: { cached: "no" },
      wind: { wind: "no" },
      destination: { destination: "no" },
      named: { named: "no" },
      deleted: { deleted: "none" },
    };
    for (const dim of dims) {
      const yes = ride(matching[dim]);
      const no = ride(notMatching[dim]);
      expect(matchesFilters(f(pos[dim]), yes)).toBe(true);
      expect(matchesFilters(f(pos[dim]), no)).toBe(false);
      expect(matchesFilters(f(neg[dim]), yes)).toBe(false);
      expect(matchesFilters(f(neg[dim]), no)).toBe(true);
    }
  });

  it("is empty for an empty library", () => {
    expect(discriminatingDims([]).size).toBe(0);
  });

  it("excludes every dimension when the whole library shares one value", () => {
    // All rides have a route but otherwise share defaults (no full GPX, no wind, no
    // destination, synthesized name, not deleted) → uniform on every dimension.
    const uniform = [ride({ track: "xy" }), ride({ track: "ab" }), ride({ track: "cd" })];
    expect(discriminatingDims(uniform).size).toBe(0);
  });

  it("includes only the dimensions the library is actually split on", () => {
    const split = [
      ride({ track: "xy", gpx_cached: true, deleted: false }),
      ride({ track: "", gpx_cached: true, deleted: true }),
    ];
    // gps: one has a track, one doesn't → split. deleted: one each → split.
    // cached: both cached → NOT split. wind/destination/named: both uniform.
    expect([...discriminatingDims(split)].sort()).toEqual(["deleted", "gps"]);
  });

  it("GPX-only library: drops Route/Full GPX/Deleted, keeps Named when names vary", () => {
    // Imported GPX rides each carry their full track (route + cached) and are never
    // deleted; some get a real name, some keep the synthesized fallback.
    const gpx = [
      ride({ source: "gpx", track: "xy", gpx_cached: true, title: "Coffee loop" }),
      ride({ source: "gpx", track: "ab", gpx_cached: true, title: "Morning ride" }),
    ];
    const d = discriminatingDims(gpx);
    expect(d.has("gps")).toBe(false);
    expect(d.has("cached")).toBe(false);
    expect(d.has("deleted")).toBe(false);
    expect(d.has("named")).toBe(true);
  });
});
