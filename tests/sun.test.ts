import { describe, expect, it } from "vitest";
import { darkSeconds, sunAltitude, sunEvents } from "../src/sun";

const AMS = [52.37, 4.9] as const;
const TROMSO = [69.65, 18.96] as const;
const day = (iso: string): [number, number] => {
  const from = Date.parse(`${iso}T00:00:00Z`);
  return [from, from + 86_400_000];
};
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
/** Minutes between two "HH:MM" clock readings. */
const apart = (a: string, b: string): number => {
  const m = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return Math.abs(m(a) - m(b));
};

describe("sun", () => {
  it("rises and sets in Amsterdam within a couple of minutes of the almanac", () => {
    // Almanac (UTC): 21 Dec 2026 07:48 / 15:29; 21 Jun 2026 03:18 / 20:06.
    const dec = sunEvents(...AMS, ...day("2026-12-21"));
    expect(dec.rises).toHaveLength(1);
    expect(dec.sets).toHaveLength(1);
    expect(apart(hm(dec.rises[0]), "07:48")).toBeLessThanOrEqual(2);
    expect(apart(hm(dec.sets[0]), "15:29")).toBeLessThanOrEqual(2);
    const jun = sunEvents(...AMS, ...day("2026-06-21"));
    expect(apart(hm(jun.rises[0]), "03:18")).toBeLessThanOrEqual(2);
    expect(apart(hm(jun.sets[0]), "20:06")).toBeLessThanOrEqual(2);
  });

  it("finds no rise or set under a polar day or night", () => {
    expect(sunEvents(...TROMSO, ...day("2026-06-21"))).toEqual({ rises: [], sets: [] });
    expect(sunEvents(...TROMSO, ...day("2026-12-21"))).toEqual({ rises: [], sets: [] });
    expect(sunAltitude(...TROMSO, Date.parse("2026-06-21T00:00:00Z"))).toBeGreaterThan(0);
    expect(sunAltitude(...TROMSO, Date.parse("2026-12-21T12:00:00Z"))).toBeLessThan(0);
  });

  it("counts the dark part of a ride", () => {
    const [from] = day("2026-10-15");
    // Noon to 14:00 UTC: all daylight; 15:46 to 17:46: the hour after the 16:46 sunset.
    expect(darkSeconds(...AMS, from + 12 * 3600_000, from + 14 * 3600_000)).toBe(0);
    const evening = darkSeconds(...AMS, from + 15.77 * 3600_000, from + 17.77 * 3600_000);
    expect(Math.abs(evening - 3600)).toBeLessThanOrEqual(180);
  });
});
