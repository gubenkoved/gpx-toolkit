import { describe, expect, it } from "vitest";

import { computeStats, type StatsRide } from "../src/stats";

/** Build a StatsRide with sane defaults so each test only sets what it cares about. */
function ride(partial: Partial<StatsRide> & { key: string }): StatsRide {
  return {
    distance_km: null,
    moving_sec: null,
    elevation_gain_m: null,
    track_km: 0,
    deleted: false,
    ...partial,
  };
}

describe("computeStats totals", () => {
  it("sums distance, moving time and elevation across rides", () => {
    const rides = [
      ride({
        key: "Mon Jun 1 2026 at 08:00",
        distance_km: 10,
        moving_sec: 1800,
        elevation_gain_m: 100,
      }),
      ride({
        key: "Tue Jun 2 2026 at 08:00",
        distance_km: 20,
        moving_sec: 3600,
        elevation_gain_m: 200,
      }),
    ];
    const s = computeStats(rides);
    expect(s.rideCount).toBe(2);
    expect(s.totalKm).toBeCloseTo(30);
    expect(s.totalMovingSec).toBe(5400);
    expect(s.totalElevationM).toBeCloseTo(300);
  });

  it("falls back to the measured track_km when no reported distance", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance_km: 10 }),
      ride({ key: "Tue Jun 2 2026 at 08:00", distance_km: 5 }),
      ride({ key: "Wed Jun 3 2026 at 08:00", track_km: 7 }),
    ];
    expect(computeStats(rides).totalKm).toBeCloseTo(22);
  });

  it("ignores deleted rides entirely", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance_km: 10 }),
      ride({ key: "Tue Jun 2 2026 at 08:00", distance_km: 99, deleted: true }),
    ];
    const s = computeStats(rides);
    expect(s.rideCount).toBe(1);
    expect(s.totalKm).toBeCloseTo(10);
  });

  it("returns empty-safe zeros and nulls for no rides", () => {
    const s = computeStats([]);
    expect(s).toEqual({
      rideCount: 0,
      totalKm: 0,
      totalMovingSec: 0,
      totalElevationM: 0,
      biggestRide: null,
      bestDay: null,
      bestWeek: null,
      bestMonth: null,
    });
  });
});

describe("computeStats records", () => {
  it("picks the single biggest ride by distance", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance_km: 10 }),
      ride({ key: "Tue Jun 2 2026 at 08:00", distance_km: 42 }),
      ride({ key: "Wed Jun 3 2026 at 08:00", distance_km: 30 }),
    ];
    const s = computeStats(rides);
    expect(s.biggestRide).toEqual({ key: "Tue Jun 2 2026 at 08:00", km: 42 });
  });

  it("sums distance per day and reports the best day", () => {
    const rides = [
      ride({ key: "Mon Jun 1 2026 at 08:00", distance_km: 10 }),
      ride({ key: "Mon Jun 1 2026 at 18:00", distance_km: 15 }), // same day → 25 km
      ride({ key: "Tue Jun 2 2026 at 08:00", distance_km: 20 }),
    ];
    const s = computeStats(rides);
    expect(s.bestDay?.km).toBeCloseTo(25);
    expect(s.bestDay?.count).toBe(2);
  });

  it("aggregates a Monday-anchored week and a calendar month", () => {
    // Jun 8 2026 is a Monday; Jun 8 and Jun 14 fall in the same week.
    const rides = [
      ride({ key: "Mon Jun 8 2026 at 08:00", distance_km: 10 }),
      ride({ key: "Sun Jun 14 2026 at 08:00", distance_km: 12 }),
      ride({ key: "Mon Jun 22 2026 at 08:00", distance_km: 5 }),
    ];
    const s = computeStats(rides);
    expect(s.bestWeek?.km).toBeCloseTo(22); // the Jun 8–14 week
    expect(s.bestWeek?.count).toBe(2);
    expect(s.bestMonth?.km).toBeCloseTo(27); // all three are in June 2026
    expect(s.bestMonth?.count).toBe(3);
  });
});
