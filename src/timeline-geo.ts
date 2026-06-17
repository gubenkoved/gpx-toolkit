/**
 * Pure, DOM-free geometry/time helpers for the Timeline view's day replay.
 *
 * Kept out of `timeline-view.ts` (which is Leaflet/DOM-heavy) so the day-scrub maths
 * — building a time-ordered position track for a day and interpolating where you were
 * at any instant — can be unit-tested without a browser, the same way `mapview.ts`
 * and `heatmap.ts` keep their geometry testable.
 */

import type { LocRecord } from "./loc-model";
import type { LatLon } from "./track";

/** One time-stamped position along a day. */
export interface DaySample {
  t: number;
  lat: number;
  lon: number;
}

/** UTC "YYYY-MM-DD" for an epoch-ms instant. */
export function dayKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build a time-sorted list of position samples for a day's records, used to
 * interpolate the scrub marker. A visit contributes two stationary samples (its
 * start and end at the place centroid); a move contributes its start and end points;
 * a path/fix contributes one sample. Together they form a continuous position track.
 */
export function buildDaySamples(recs: LocRecord[]): DaySample[] {
  const out: DaySample[] = [];
  for (const r of recs) {
    if (r.kind === "visit") {
      out.push({ t: r.t, lat: r.lat, lon: r.lon });
      if (r.endT) out.push({ t: r.endT, lat: r.lat, lon: r.lon });
    } else if (r.kind === "move") {
      out.push({ t: r.t, lat: r.lat, lon: r.lon });
      if (r.endT && r.lat2 !== undefined && r.lon2 !== undefined)
        out.push({ t: r.endT, lat: r.lat2, lon: r.lon2 });
    } else {
      out.push({ t: r.t, lat: r.lat, lon: r.lon });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Linear-interpolated `[lat, lon]` at instant `t` along the sorted `samples`, or
 * null when there are none. Clamps to the first/last sample outside the range.
 */
export function posAt(samples: DaySample[], t: number): LatLon | null {
  if (!samples.length) return null;
  if (t <= samples[0].t) return [samples[0].lat, samples[0].lon];
  const last = samples[samples.length - 1];
  if (t >= last.t) return [last.lat, last.lon];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  return [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
}
// --------------------------------------------------------------------------- //
// Area-selection "when was I here" aggregation (pure)
// --------------------------------------------------------------------------- //

/** One day within an area selection: its visits + total dwell, day key "YYYY-MM-DD". */
export interface SelectedDay {
  day: string;
  visits: LocRecord[];
  dwellSec: number;
}

/** A lat/lon rectangle (the bbox of the matched visits). */
export interface LatLonBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/**
 * Group the area-selected visits into per-day buckets (newest day first), with each
 * day's visits time-sorted and its dwell computed as the **union of visit intervals
 * clipped to that calendar day**. The union is essential: Google records nested /
 * overlapping visits (a broad place plus a finer place over the same minutes), and a
 * single visit can span midnight \u2014 both would otherwise double-count and push a day's
 * "dwell" past 24h. Clipping to the day and merging intervals gives the true "time
 * present" that day (\u2264 24h). This is the core of the "when you were here" answer.
 */
export function groupVisitsByDay(matched: LocRecord[]): SelectedDay[] {
  const byDay = new Map<string, LocRecord[]>();
  for (const v of matched) {
    const d = dayKeyOf(v.t);
    const list = byDay.get(d);
    if (list) list.push(v);
    else byDay.set(d, [v]);
  }
  return [...byDay.entries()]
    .map(([day, vs]) => ({
      day,
      visits: vs.sort((a, b) => a.t - b.t),
      dwellSec: unionDwellSec(vs, day),
    }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

/**
 * "Time present" for one calendar day from a set of visits: clip each visit's
 * [start, end] to the day's UTC bounds, then sum the union of those intervals (so
 * overlapping/nested visits count once, and a stay spilling past midnight only counts
 * its part within the day). Returns seconds, always \u2264 86400.
 */
function unionDwellSec(visits: LocRecord[], day: string): number {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const dayEnd = dayStart + 864e5;
  const intervals: Array<[number, number]> = [];
  for (const v of visits) {
    const a = Math.max(v.t, dayStart);
    const b = Math.min(v.endT ?? v.t, dayEnd);
    if (b > a) intervals.push([a, b]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [a, b] of intervals) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return Math.round(total / 1000);
}

/** The lat/lon bounding box of a set of visits, or null when empty. */
export function visitsBox(matched: LocRecord[]): LatLonBox | null {
  if (!matched.length) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const v of matched) {
    if (v.lat < minLat) minLat = v.lat;
    if (v.lat > maxLat) maxLat = v.lat;
    if (v.lon < minLon) minLon = v.lon;
    if (v.lon > maxLon) maxLon = v.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

/** Headline stats for a selection: span, totals, and the per-year day distribution. */
export interface SelectionStats {
  totalDays: number;
  totalVisits: number;
  totalDwellSec: number;
  firstDay: string;
  lastDay: string;
  /** Day count per calendar year, for the drill-down histogram. */
  perYear: Map<number, number>;
}

/** Summarize grouped selected days into the temporal headline + per-year histogram. */
export function selectionStats(days: SelectedDay[]): SelectionStats | null {
  if (!days.length) return null;
  const perYear = new Map<number, number>();
  let totalVisits = 0;
  let totalDwellSec = 0;
  for (const d of days) {
    const y = Number(d.day.slice(0, 4));
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
    totalVisits += d.visits.length;
    totalDwellSec += d.dwellSec;
  }
  // days is newest-first, so last element is the earliest day.
  return {
    totalDays: days.length,
    totalVisits,
    totalDwellSec,
    firstDay: days[days.length - 1].day,
    lastDay: days[0].day,
    perYear,
  };
}

/** Calendar days from day `a` to day `b` (both "YYYY-MM-DD"); b − a (can be negative). */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 864e5);
}

/** A run of (near-)consecutive days you were in the area \u2014 a single "stay". */
export interface DayPeriod {
  /** Earliest day in the run, "YYYY-MM-DD". */
  startDay: string;
  /** Latest day in the run, "YYYY-MM-DD". */
  endDay: string;
  /** The run's days, NEWEST first (ready to render). */
  days: SelectedDay[];
  /** Number of days with data in the run. */
  dayCount: number;
  /** Calendar span end\u2212start+1 (\u2265 dayCount; larger when bridged gaps exist). */
  spanDays: number;
  totalVisits: number;
  totalDwellSec: number;
}

/**
 * Collapse a flat list of selected days into consecutive **periods** ("stays"), so a
 * scattered scroll of days reads as a handful of trips. Days within `maxGapDays`
 * missing days of each other join one period (default 1 \u2014 a single data-less day
 * doesn't split a stay). Returns periods NEWEST first, each with its days newest first.
 */
export function groupConsecutiveDays(days: SelectedDay[], maxGapDays = 1): DayPeriod[] {
  if (!days.length) return [];
  // Sort ascending to walk chronologically, then emit newest-first at the end.
  const asc = [...days].sort((a, b) => (a.day < b.day ? -1 : 1));
  const runs: SelectedDay[][] = [];
  let cur: SelectedDay[] = [asc[0]];
  for (let i = 1; i < asc.length; i++) {
    const gap = daysBetween(asc[i - 1].day, asc[i].day);
    if (gap <= maxGapDays + 1) cur.push(asc[i]);
    else {
      runs.push(cur);
      cur = [asc[i]];
    }
  }
  runs.push(cur);
  return runs
    .map((run) => {
      const startDay = run[0].day;
      const endDay = run[run.length - 1].day;
      return {
        startDay,
        endDay,
        days: [...run].reverse(), // newest first within the period
        dayCount: run.length,
        spanDays: daysBetween(startDay, endDay) + 1,
        totalVisits: run.reduce((s, d) => s + d.visits.length, 0),
        totalDwellSec: run.reduce((s, d) => s + d.dwellSec, 0),
      };
    })
    .reverse(); // newest period first
}
