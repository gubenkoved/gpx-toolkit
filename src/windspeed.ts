// --------------------------------------------------------------------------- //
// Wind-vs-speed analytics: chop a ride into roughly-straight, moving segments and
// fit a distance-weighted line of average speed against along-track wind.
//
// The crux of the feature: a whole ride's average along-wind cancels to ~0 on an
// out-and-back (the headwind leg and the tailwind leg net out), hiding the very
// effect we want to see. Splitting each ride into stretches that hold one heading
// keeps the headwind and tailwind legs as separate points, so the wind's push/drag
// on speed becomes visible — and the regression slope quantifies it.
//
// `along[i]` is already PointWind.alongKmh (the wind projected onto the rider's
// heading; + tailwind, − headwind), so this file never re-projects wind — it only
// distance-weights what weather.ts already computed. Pure (no DOM); the chart and
// the Flat-only filter live elsewhere.
// --------------------------------------------------------------------------- //
import { cumulativeKm, type LatLon } from "./track";
import { bearingDeg } from "./weather";

/** Tuning for chopping a ride into roughly-straight, moving segments. */
export interface SegmentOpts {
  /** Start a new segment once the heading deviates more than this from the
   *  segment's start bearing (degrees). Default 35. */
  turnDeg?: number;
  /** Drop segments shorter than this (km). Default 0.3. */
  minKm?: number;
  /** Drop segments with less moving time than this (seconds). Default 20. */
  minSec?: number;
  /** Hops at or below this speed (km/h) count as "stopped": they end the current
   *  segment and are excluded from its moving time. Default 1 (= movingThresholdKmh). */
  stopKmh?: number;
}

/** One roughly-straight, moving stretch of a ride: a single scatter point. */
export interface WindSeg {
  uid: string;
  /** Moving-average speed over the segment (km/h). */
  avgSpeedKmh: number;
  /** Distance-weighted along-track wind over the segment (km/h; + tail, − head). */
  avgAlongKmh: number;
  distanceKm: number;
  movingSec: number;
  /** Net grade over the segment as a percent ((endEle − startEle) / distance). NaN
   *  when elevation was unknown for the segment's endpoints (so the Flat-only filter
   *  can tell "flat" from "unknown"). */
  netGradePct: number;
}

/** Smallest signed angle a − b in degrees, in (−180, 180]. */
function angleDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/**
 * Chop a ride into roughly-straight, moving segments. A segment ends on a heading
 * turn beyond `turnDeg`, on a stopped hop (≤ `stopKmh`), or on a data gap (a null
 * time or null wind sample). Stopped hops and gaps are excluded from the segment,
 * never folded into its moving time.
 *
 * `netGradePct` is left UNfiltered here on purpose: the caller filters on it (Flat
 * segments only) so the per-ride segment list can be memoized once and re-filtered
 * synchronously as the toggle/date-slider changes, without re-reading the track.
 */
export function segmentRide(
  points: LatLon[],
  times: number[],
  eles: (number | null)[],
  along: (number | null)[],
  opts: SegmentOpts,
  uid: string,
): WindSeg[] {
  const turnDeg = opts.turnDeg ?? 35;
  const minKm = opts.minKm ?? 0.3;
  const minSec = opts.minSec ?? 20;
  const stopKmh = opts.stopKmh ?? 1;
  const n = points.length;
  if (n < 2 || times.length !== n || along.length !== n) return [];
  const cum = cumulativeKm(points); // cum[i] = km from start to point i

  const out: WindSeg[] = [];
  // Accumulators for the open segment.
  let segKm = 0;
  let segSec = 0;
  let segAlongKm = 0; // Σ along·hopKm (the distance-weighted numerator)
  let refBrg: number | null = null;
  let startEle: number | null = null;
  let endEle: number | null = null;

  const flush = (): void => {
    if (segKm >= minKm && segSec >= minSec) {
      const distM = segKm * 1000;
      const grade =
        startEle != null && endEle != null && distM > 0
          ? ((endEle - startEle) / distM) * 100
          : Number.NaN;
      out.push({
        uid,
        avgSpeedKmh: segKm / (segSec / 3600),
        avgAlongKmh: segAlongKm / segKm,
        distanceKm: segKm,
        movingSec: segSec,
        netGradePct: grade,
      });
    }
    segKm = 0;
    segSec = 0;
    segAlongKm = 0;
    refBrg = null;
    startEle = null;
    endEle = null;
  };

  for (let i = 0; i < n - 1; i++) {
    const t0 = times[i];
    const t1 = times[i + 1];
    const a = along[i];
    const dtSec = (t1 - t0) / 1000;
    const hopKm = cum[i + 1] - cum[i];

    // Data gap (no time progression or no wind here) → close the segment, skip hop.
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || dtSec <= 0 || a == null) {
      flush();
      continue;
    }
    const speedKmh = hopKm / (dtSec / 3600);
    // Stopped hop → ends the segment and is excluded from it.
    if (speedKmh <= stopKmh) {
      flush();
      continue;
    }
    const brg = bearingDeg(points[i], points[i + 1]);
    // Heading turn beyond tolerance → start a fresh segment AT this hop.
    if (refBrg != null && Math.abs(angleDiff(brg, refBrg)) > turnDeg) {
      flush();
    }
    if (refBrg == null) {
      refBrg = brg;
      startEle = eles[i] ?? null;
    }
    segKm += hopKm;
    segSec += dtSec;
    segAlongKm += a * hopKm;
    if (eles[i + 1] != null) endEle = eles[i + 1];
    if (startEle == null && eles[i] != null) startEle = eles[i];
  }
  flush();
  return out;
}

/**
 * Weighted least-squares line y = slope·x + intercept, with a weighted R². Weights
 * default to 1 (ordinary least squares). For this feature x = along-track wind, y =
 * average speed, weight = segment distance — so a long steady stretch counts for
 * more than a brief one. Degenerate inputs (n < 2, zero weight, zero x-variance)
 * return a flat line at the mean rather than NaNs.
 */
export function linearRegression(
  xs: number[],
  ys: number[],
  weights?: number[],
): { slope: number; intercept: number; r2: number; n: number } {
  const n = xs.length;
  if (n < 2) {
    const meanY = n === 1 ? ys[0] : 0;
    return { slope: 0, intercept: meanY, r2: 0, n };
  }
  const w = weights ?? xs.map(() => 1);
  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i];
    swx += w[i] * xs[i];
    swy += w[i] * ys[i];
  }
  if (sw <= 0) return { slope: 0, intercept: 0, r2: 0, n };
  const mx = swx / sw;
  const my = swy / sw;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += w[i] * dx * dx;
    sxy += w[i] * dx * dy;
    syy += w[i] * dy * dy;
  }
  if (sxx <= 0) return { slope: 0, intercept: my, r2: 0, n };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept, r2, n };
}

/**
 * Indices (ascending) of the segments to KEEP after dropping those whose average
 * speed exceeds `maxKmh` — a physical plausibility cap, not a statistical trim. GPS
 * glitches manifest as impossibly fast segments (a bike doesn't average 100+ km/h),
 * so capping removes exactly those bad points while leaving every believable
 * headwind AND tailwind segment in place. Crucially this does NOT flatten the
 * wind-vs-speed slope the way trimming the fast/slow tails by speed would, because
 * it only discards values no real ride could produce. `maxKmh <= 0` keeps all.
 */
export function speedCapIndices(speeds: number[], maxKmh: number): number[] {
  const keep: number[] = [];
  for (let i = 0; i < speeds.length; i++) {
    if (maxKmh <= 0 || speeds[i] <= maxKmh) keep.push(i);
  }
  return keep;
}
