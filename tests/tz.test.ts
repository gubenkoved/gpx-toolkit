import { describe, expect, it } from "vitest";

import {
  browserZone,
  formatOffset,
  loadTz,
  localTime,
  offsetMinutes,
  zoneCity,
  zoneForPoint,
} from "../src/tz";

// A fixed summer instant: 2026-06-13 14:22:00 UTC.
const SUMMER = Date.parse("2026-06-13T14:22:00Z");
// A fixed winter instant: 2026-01-13 14:22:00 UTC.
const WINTER = Date.parse("2026-01-13T14:22:00Z");

describe("tz — local wall-clock from an instant + zone", () => {
  it("renders the ride-local key in the ride's own zone", () => {
    // Amsterdam is CEST (+2) in June, Tokyo is +9, UTC is +0.
    expect(localTime(SUMMER, "Europe/Amsterdam").key).toBe("Sat Jun 13 2026 at 16:22");
    expect(localTime(SUMMER, "Asia/Tokyo").key).toBe("Sat Jun 13 2026 at 23:22");
    expect(localTime(SUMMER, "UTC").key).toBe("Sat Jun 13 2026 at 14:22");
  });

  it("exposes the local hour (for the default time-of-day name)", () => {
    expect(localTime(SUMMER, "Europe/Amsterdam").hour).toBe(16);
    expect(localTime(SUMMER, "Asia/Tokyo").hour).toBe(23);
    expect(localTime(SUMMER, "UTC").hour).toBe(14);
  });

  it("computes DST-correct offsets from the browser's current Intl DB", () => {
    // Amsterdam: CEST (+120) in summer, CET (+60) in winter — DST handled by Intl,
    // not the (static) tz-lookup table.
    expect(offsetMinutes(SUMMER, "Europe/Amsterdam")).toBe(120);
    expect(offsetMinutes(WINTER, "Europe/Amsterdam")).toBe(60);
    expect(offsetMinutes(SUMMER, "Asia/Tokyo")).toBe(540);
    expect(offsetMinutes(SUMMER, "UTC")).toBe(0);
  });

  it("falls back to the browser zone for an empty IANA name", () => {
    expect(localTime(SUMMER, "").key).toBe(localTime(SUMMER, browserZone()).key);
  });
});

describe("tz — display helpers", () => {
  it("formats a UTC offset unambiguously", () => {
    expect(formatOffset(0)).toBe("UTC");
    expect(formatOffset(120)).toBe("UTC+2");
    expect(formatOffset(-300)).toBe("UTC-5");
    expect(formatOffset(-330)).toBe("UTC-5:30");
    expect(formatOffset(345)).toBe("UTC+5:45");
  });

  it("derives a human city from an IANA zone", () => {
    expect(zoneCity("Europe/Amsterdam")).toBe("Amsterdam");
    expect(zoneCity("America/New_York")).toBe("New York");
    expect(zoneCity("")).toBe("");
  });
});

describe("tz — coordinate → IANA zone (lazy tz-lookup)", () => {
  it("resolves known coordinates once loaded", async () => {
    await loadTz();
    expect(zoneForPoint(52.37, 4.9)).toBe("Europe/Amsterdam");
    expect(zoneForPoint(35.68, 139.69)).toBe("Asia/Tokyo");
    // Out-of-range / NaN are treated as unknown, never throw.
    expect(zoneForPoint(Number.NaN, 0)).toBe("");
  });
});
