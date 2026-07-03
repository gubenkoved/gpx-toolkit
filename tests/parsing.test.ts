import { describe, expect, it } from "vitest";

import {
  autoGranularity,
  bucketRide,
  compareRideKeysDesc,
  compareRidesByDateDesc,
  parseDurationSec,
  rideLabel,
  rideMonth,
  sinceFromPreset,
  timeOfDayNameFromHour,
} from "../src/parsing";

describe("date helpers", () => {
  it("rideMonth", () => {
    expect(rideMonth("Sat Jun 13 2026 at 14:22")).toEqual(["2026-06", "June 2026"]);
    expect(rideMonth("Tue Jun 9 2026 at 18:29")).toEqual(["2026-06", "June 2026"]);
    expect(rideMonth("garbage")).toEqual(["0000-00", "Unknown"]);
  });

  it("parseDurationSec handles H:MM:SS, MM:SS and garbage", () => {
    expect(parseDurationSec("1:07:42")).toBe(4062);
    expect(parseDurationSec("59:30")).toBe(3570);
    expect(parseDurationSec("0:00")).toBe(0);
    expect(parseDurationSec("")).toBe(0);
    expect(parseDurationSec("garbage")).toBe(0);
    expect(parseDurationSec("12.5km")).toBe(0);
  });

  it("bucketRide groups by day/week/month/year", () => {
    const key = "Sat Jun 13 2026 at 14:22"; // a Saturday
    expect(bucketRide(key, "day")).toEqual(["2026-06-13", "Jun 13, 2026", "Jun 13"]);
    expect(bucketRide(key, "month")).toEqual(["2026-06", "June 2026", "Jun '26"]);
    expect(bucketRide(key, "year")).toEqual(["2026", "2026", "2026"]);
    // Week is Monday-anchored: Sat Jun 13 -> week of Mon Jun 8.
    expect(bucketRide(key, "week")).toEqual(["2026-06-08", "Week of Jun 8, 2026", "Jun 8"]);
  });

  it("bucketRide collapses unparseable keys into a trailing Unknown bucket", () => {
    const [sortKey, label] = bucketRide("garbage", "day");
    expect(label).toBe("Unknown");
    expect(sortKey > "2026-06-13").toBe(true); // sorts after real dates
  });

  it("autoGranularity picks resolution from the date span", () => {
    const day = (k: string): { key: string } => ({ key: k });
    // ~2 weeks -> day
    expect(
      autoGranularity([day("Mon Jun 1 2026 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("day");
    // ~2 months -> week
    expect(
      autoGranularity([day("Wed Apr 15 2026 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("week");
    // ~1.5 years -> month
    expect(
      autoGranularity([day("Sun Jan 1 2025 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("month");
    // ~5 years -> year
    expect(
      autoGranularity([day("Mon Jan 1 2021 at 10:00"), day("Sat Jun 13 2026 at 14:22")]),
    ).toBe("year");
    // no parseable dates -> month
    expect(autoGranularity([day("garbage")])).toBe("month");
  });

  it("rideLabel is name-driven with the reference date, never the uid", () => {
    const date = "Sat Jun 13 2026 at 14:22";
    // Name + reference date → "Name (short date)".
    expect(rideLabel("Béthune loop", date)).toBe("Béthune loop (Jun 13, 2026, 14:22)");
    // Name only (unparseable/empty date) → just the name.
    expect(rideLabel("Béthune loop", "")).toBe("Béthune loop");
    expect(rideLabel("Béthune loop", "gpx::sha256:deadbeef")).toBe("Béthune loop");
    // No name → the date alone …
    expect(rideLabel("", date)).toBe("Jun 13, 2026, 14:22");
    // … and with neither, a generic word — NEVER a uid/hash.
    expect(rideLabel("", "")).toBe("ride");
    expect(rideLabel("  ", "")).toBe("ride");
  });

  it("sinceFromPreset", () => {
    expect(sinceFromPreset("all")).toBeNull();
    const today = sinceFromPreset("today")!;
    expect(today.getHours()).toBe(0);
    expect(today.getMinutes()).toBe(0);
    const week = sinceFromPreset("week")!;
    expect(Math.abs(Date.now() - week.getTime() - 7 * 86400_000)).toBeLessThan(5000);
    const custom = sinceFromPreset("custom", 3)!;
    expect(Math.abs(Date.now() - custom.getTime() - 3 * 86400_000)).toBeLessThan(5000);
    expect(sinceFromPreset("custom")).toBeNull();
  });

  it("compareRideKeysDesc orders chronologically, not lexically", () => {
    // Real keys from the app — raw-string sort would mis-order these (weekday
    // prefix, "3" vs "13", and same-day rides by time).
    const keys = [
      "Wed Jun 3 2026 at 10:39",
      "Sat Jun 13 2026 at 14:22",
      "Sun Jun 7 2026 at 20:08",
      "Wed Jun 3 2026 at 19:04",
      "Tue Jun 9 2026 at 18:29",
      "Sun Jun 7 2026 at 13:28",
      "Tue Jun 9 2026 at 10:10",
    ];
    const sorted = [...keys].sort(compareRideKeysDesc);
    expect(sorted).toEqual([
      "Sat Jun 13 2026 at 14:22",
      "Tue Jun 9 2026 at 18:29",
      "Tue Jun 9 2026 at 10:10",
      "Sun Jun 7 2026 at 20:08",
      "Sun Jun 7 2026 at 13:28",
      "Wed Jun 3 2026 at 19:04",
      "Wed Jun 3 2026 at 10:39",
    ]);
  });

  it("compareRidesByDateDesc breaks reference-date ties by name (A→Z)", () => {
    const same = "Sat Jun 13 2026 at 14:22";
    const rides = [
      { date_key: same, title: "Charlie" },
      { date_key: "Sat Jun 13 2026 at 09:00", title: "Earlybird" },
      { date_key: same, title: "alpha" }, // lower-case → case-insensitive tie-break
      { date_key: same, title: "Bravo" },
    ];
    const sorted = [...rides].sort(compareRidesByDateDesc).map((r) => r.title);
    // Newest reference date first; within the shared 14:22 minute, names sort A→Z.
    expect(sorted).toEqual(["alpha", "Bravo", "Charlie", "Earlybird"]);
  });

  it("compareRidesByDateDesc sorts by the true INSTANT across timezones", () => {
    // Two rides whose wall-clocks would mis-order them: an 23:00 ride in Tokyo
    // (14:00 UTC) actually PRECEDES a 20:00 ride in Amsterdam (18:00 UTC). Sorting by
    // the datetime string alone would put 23:00 first; the epoch fixes it.
    const tokyo = {
      date_key: "Sat Jun 13 2026 at 23:00",
      title: "Tokyo",
      start_epoch: Date.parse("2026-06-13T14:00:00Z"),
    };
    const amsterdam = {
      date_key: "Sat Jun 13 2026 at 20:00",
      title: "Amsterdam",
      start_epoch: Date.parse("2026-06-13T18:00:00Z"),
    };
    const sorted = [tokyo, amsterdam].sort(compareRidesByDateDesc).map((r) => r.title);
    expect(sorted).toEqual(["Amsterdam", "Tokyo"]); // later instant first
  });

  it("timeOfDayNameFromHour maps an hour to a Strava-style name", () => {
    expect(timeOfDayNameFromHour(3)).toBe("Night ride");
    expect(timeOfDayNameFromHour(8)).toBe("Morning ride");
    expect(timeOfDayNameFromHour(14)).toBe("Afternoon ride");
    expect(timeOfDayNameFromHour(19)).toBe("Evening ride");
    expect(timeOfDayNameFromHour(23)).toBe("Night ride");
  });
});
