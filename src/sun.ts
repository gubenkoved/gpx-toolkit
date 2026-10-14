/**
 * GPX Toolkit — where the sun is: its altitude at a place and instant, and the
 * sunrise / sunset / darkness that follow from it.
 *
 * The low-precision solar position (the Astronomical Almanac's, good to about a minute
 * of time at sunrise) is plenty to shade a chart's night and say how much of a ride is
 * in the dark. Rise and set are found by scanning the altitude minute by minute rather
 * than solved in closed form, so a polar day (no set) or polar night (no rise) needs no
 * special case: the scan simply finds no crossing.
 */

const D2R = Math.PI / 180;
const MIN_MS = 60_000;

/** The sun's upper limb on the horizon, refraction included: sunrise and sunset. */
export const SUN_HORIZON_DEG = -0.833;
/** Civil twilight ends (and night begins) with the sun this far below the horizon. */
export const CIVIL_TWILIGHT_DEG = -6;

/** The sun's altitude above the horizon (degrees) at `lat`/`lon` at instant `ms`. */
export function sunAltitude(lat: number, lon: number, ms: number): number {
  const d = ms / 86_400_000 - 10_957.5; // days since J2000.0 (2000-01-01 12:00 UTC)
  const g = (357.529 + 0.98560028 * d) * D2R; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude (deg)
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * D2R; // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const gmst = 18.697374558 + 24.06570982441908 * d; // hours
  const ha = (gmst * 15 + lon) * D2R - ra;
  const phi = lat * D2R;
  return (
    Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)) /
    D2R
  );
}

/** Sunrises and sunsets in [fromMs, toMs), to the minute (both empty under a polar
 *  day or night). */
export function sunEvents(
  lat: number,
  lon: number,
  fromMs: number,
  toMs: number,
): { rises: number[]; sets: number[] } {
  const rises: number[] = [];
  const sets: number[] = [];
  let up = sunAltitude(lat, lon, fromMs) >= SUN_HORIZON_DEG;
  for (let t = fromMs + MIN_MS; t < toMs; t += MIN_MS) {
    const now = sunAltitude(lat, lon, t) >= SUN_HORIZON_DEG;
    if (now !== up) (now ? rises : sets).push(t);
    up = now;
  }
  return { rises, sets };
}

/** How long (seconds) the sun is down between `fromMs` and `toMs`, to the minute. */
export function darkSeconds(lat: number, lon: number, fromMs: number, toMs: number): number {
  let dark = 0;
  for (let t = fromMs; t < toMs; t += MIN_MS)
    if (sunAltitude(lat, lon, t + MIN_MS / 2) < SUN_HORIZON_DEG)
      dark += Math.min(MIN_MS, toMs - t);
  return dark / 1000;
}
