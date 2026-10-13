/**
 * Rough, lightweight ride tracks.
 *
 * We never keep the full GPX — only a heavily reduced sketch of the route so the
 * app can show an approximate shape on a map. A pulled GPX is parsed to lat/lon
 * points, simplified (Douglas–Peucker) down to a small cap, then stored as a
 * Google-style encoded polyline string (a few hundred bytes at most).
 *
 * This is intentionally a SHAPE ONLY: no elevation, no timestamps, and the point
 * count is deliberately tiny. The displayed track is an approximation.
 */

export type LatLon = [number, number]; // [lat, lon]

/**
 * Collect elements by local tag name, tolerant of a default XML namespace. Real-
 * world GPX files almost always declare `xmlns="http://www.topografix.com/GPX/1/1"`,
 * and some parsers (notably jsdom) won't match a default-namespaced `<trkpt>` via
 * `getElementsByTagName`. Fall back to a namespace-wildcard lookup so namespaced
 * and bare GPX both yield their points — ingestion correctness must not hinge on
 * whether the file declared a namespace.
 */
function byTag(doc: Document, tag: string): Element[] {
  const direct = doc.getElementsByTagName(tag);
  if (direct.length > 0) return Array.from(direct);
  return Array.from(doc.getElementsByTagNameNS("*", tag));
}

/** Parse `<trkpt>`/`<rtept>` lat/lon pairs out of a GPX document. */
export function extractTrack(gpx: string): LatLon[] {
  const doc = new DOMParser().parseFromString(gpx, "text/xml");
  let pts = byTag(doc, "trkpt");
  if (pts.length === 0) pts = byTag(doc, "rtept");
  const out: LatLon[] = [];
  for (const p of pts) {
    const lat = Number(p.getAttribute("lat"));
    const lon = Number(p.getAttribute("lon"));
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
  }
  return out;
}

/**
 * A FULL recorded track: route geometry plus per-point elevation and timestamp.
 *
 * Unlike the rough display polyline (shape only), this is the genuine ~1 Hz trace
 * the Beeline cloud renders on demand (see `extractFullTrack`). `eles[i]`/`times[i]`
 * are null when that point lacked the datum, so callers must tolerate gaps.
 */
export interface FullTrack {
  points: LatLon[];
  /** Elevation in metres per point (null when the point had no `<ele>`). */
  eles: (number | null)[];
  /** Epoch milliseconds per point (null when the point had no `<time>`). */
  times: (number | null)[];
}

/**
 * Parse a full GPX track — `<trkpt>` lat/lon plus each point's optional `<ele>`
 * (metres) and `<time>` (ISO-8601 → epoch ms). Falls back to `<rtept>` when there
 * are no track points. Points with an unparseable lat/lon are skipped entirely.
 */
export function extractFullTrack(gpx: string): FullTrack {
  const doc = new DOMParser().parseFromString(gpx, "text/xml");
  let nodes = byTag(doc, "trkpt");
  if (nodes.length === 0) nodes = byTag(doc, "rtept");
  const childText = (p: Element, tag: string): string | null => {
    let el = p.getElementsByTagName(tag)[0];
    if (!el) el = p.getElementsByTagNameNS("*", tag)[0];
    return el ? (el.textContent ?? null) : null;
  };
  const points: LatLon[] = [];
  const eles: (number | null)[] = [];
  const times: (number | null)[] = [];
  for (const p of nodes) {
    const lat = Number(p.getAttribute("lat"));
    const lon = Number(p.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push([lat, lon]);
    const eleText = childText(p, "ele");
    const ele = eleText != null ? Number(eleText) : Number.NaN;
    eles.push(Number.isFinite(ele) ? ele : null);
    const timeText = childText(p, "time");
    const t = timeText != null ? Date.parse(timeText) : Number.NaN;
    times.push(Number.isFinite(t) ? t : null);
  }
  return { points, eles, times };
}

/** True when at least two points carry a real `<ele>` (an elevation profile exists). */
export function hasElevation(ft: FullTrack): boolean {
  return ft.eles.filter((e) => e != null).length >= 2;
}

/** True when at least two points carry a real `<time>` (real time attribution exists). */
export function hasTimes(ft: FullTrack): boolean {
  return ft.times.filter((t) => t != null).length >= 2;
}

/**
 * Per-point speed in km/h derived from a full track's timestamps + geometry. Each
 * point's speed measures the hop to the NEXT point (Δdistance / Δtime); the final
 * point repeats the previous value so the series has no trailing gap. Entries are
 * null where either endpoint lacked a timestamp or time didn't advance.
 */
export function fullTrackSpeedsKmh(ft: FullTrack): (number | null)[] {
  const n = ft.points.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const t0 = ft.times[i - 1];
    const t1 = ft.times[i];
    if (t0 == null || t1 == null) continue;
    const dtH = (t1 - t0) / 3_600_000; // ms → hours
    if (dtH <= 0) continue;
    out[i - 1] = haversineKm(ft.points[i - 1], ft.points[i]) / dtH;
  }
  if (n >= 2 && out[n - 1] == null) out[n - 1] = out[n - 2];
  return out;
}

/**
 * Baseline time window (seconds) over which `smoothedSpeedsKmh` measures NET
 * displacement. A single ~1 Hz hop is far too short to denoise a standstill (see
 * `smoothedSpeedsKmh`); roughly ten seconds is long enough that GPS wander cancels
 * out yet short enough to still track real acceleration. Trade-off: peak speed
 * becomes the fastest speed *sustained* over this window (a lone 1-hop GPS spike no
 * longer inflates it) and tight curves read slightly slow (chord vs. arc).
 */
export const SPEED_WINDOW_SEC = 10;

/**
 * GPS horizontal-noise floor in metres, subtracted (in quadrature) from each window's
 * net displacement before deriving speed. A consumer-grade fix is uncertain by several
 * metres, and the displacement between two fixes by ≈√2× that — so a net move under this
 * floor is indistinguishable from a standstill and must read as zero, not as speed. We
 * subtract it softly (`√(d² − floor²)`) rather than hard-clipping: a true ride's long
 * chord is barely touched (110 m → ~109 m) while a parked cluster's few-metre wander
 * collapses to 0. This is what finally pulls a stationary stretch BELOW the 1 km/h stop
 * threshold so it's excluded from moving time — a plain window left ~4 km/h of residual
 * jitter, which still counted as "moving". Cost: genuine motion slower than ≈`floor`
 * over a `SPEED_WINDOW_SEC` window (a sub-walking-pace crawl) also reads as stopped.
 */
export const GPS_NOISE_FLOOR_M = 12;

/**
 * Per-point speed in km/h that is robust to a stationary GPS jitter — the reason a
 * parked bike used to read several km/h.
 *
 * The naive per-hop speed (`fullTrackSpeedsKmh`) divides each consecutive hop's
 * haversine distance by its time delta. That distance is ALWAYS positive regardless
 * of direction, so ±5–10 m of GPS noise over a 1–2 s ~1 Hz hop computes as several
 * km/h even when standing still — and a moving-average of an always-positive series
 * can never bring it back to zero. Instead, for each point we measure the **net
 * straight-line displacement** between the two timestamped points that straddle it
 * by at least `windowSec` (grown outward, kept time-balanced around the point), shave
 * off the `GPS_NOISE_FLOOR_M` noise floor (in quadrature), then divide by the real
 * elapsed time. Over a stop the start/end of the window sit on top of each other and
 * the residual wander is below the noise floor, so the speed collapses to zero; while
 * genuinely moving the chord ≈ the path and dwarfs the floor, so true speed survives.
 *
 * This is the single denoised series the app consumes for peak/moving speed, the
 * stop split and the profile colours — it replaces the old
 * `movingAverage(fullTrackSpeedsKmh(ft), 3)`. Entries are null only where the point
 * itself has no timestamp or no timed neighbour exists to form a baseline.
 */
export function smoothedSpeedsKmh(
  ft: FullTrack,
  windowSec: number = SPEED_WINDOW_SEC,
): (number | null)[] {
  const n = ft.points.length;
  const out: (number | null)[] = new Array(n).fill(null);
  const t = ft.times;
  const targetMs = Math.max(0, windowSec) * 1000;
  const floorKm = GPS_NOISE_FLOOR_M / 1000;
  const prevTimed = (idx: number): number => {
    let j = idx - 1;
    while (j >= 0 && t[j] == null) j--;
    return j; // -1 when none
  };
  const nextTimed = (idx: number): number => {
    let j = idx + 1;
    while (j < n && t[j] == null) j++;
    return j; // n when none
  };
  for (let i = 0; i < n; i++) {
    const ti = t[i];
    if (ti == null) continue;
    let lo = i;
    let hi = i;
    // Grow the window outward until its real time span reaches the baseline, keeping
    // it balanced around point i by always extending whichever side is closer in time.
    while ((t[hi] as number) - (t[lo] as number) < targetMs) {
      const pl = prevTimed(lo);
      const nh = nextTimed(hi);
      const canLo = pl >= 0;
      const canHi = nh < n;
      if (!canLo && !canHi) break; // window is the whole track; use what we have
      const lowGap = ti - (t[lo] as number);
      const highGap = (t[hi] as number) - ti;
      if (canLo && (!canHi || lowGap <= highGap)) lo = pl;
      else hi = nh;
    }
    const dtH = ((t[hi] as number) - (t[lo] as number)) / 3_600_000;
    if (dtH <= 0) continue; // no timed neighbour to form a baseline
    const chordKm = haversineKm(ft.points[lo], ft.points[hi]);
    // Subtract the GPS noise floor in quadrature: motion under the floor → 0.
    const movedKm = chordKm > floorKm ? Math.sqrt(chordKm * chordKm - floorKm * floorKm) : 0;
    out[i] = movedKm / dtH;
  }
  return out;
}

/**
 * Centered moving average over a numeric series that tolerates null gaps (nulls are
 * skipped, and a window with no real values stays null). `radius` is the number of
 * neighbours on each side. Used to tame noisy ~1 Hz GPS speed before colouring.
 */
export function movingAverage(values: (number | null)[], radius: number): (number | null)[] {
  const r = Math.max(0, Math.floor(radius));
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - r; j <= i + r; j++) {
      const v = values[j];
      if (j >= 0 && j < values.length && v != null) {
        sum += v;
        count++;
      }
    }
    if (count > 0) out[i] = sum / count;
  }
  return out;
}

/**
 * Default "stopped" threshold (km/h): a hop whose smoothed speed is below this is
 * treated as not moving, so it's excluded from moving time / moving average speed.
 * User-tunable (see `Settings.movingThresholdKmh`); 1 km/h means only a near-total
 * standstill counts as stopped.
 */
export const DEFAULT_MOVING_THRESHOLD_KMH = 1;

/**
 * Elevation change below this (m) is sensor noise, not climbing. Recorded altitude
 * (GPS or barometric, ~1 Hz) jitters by a metre or two every sample; summing raw
 * deltas turns that into hundreds of metres of fake climb on a flat ride (Beeline's
 * own figures read ~5× high). User-tunable (`Settings.elevationNoiseM`).
 */
export const DEFAULT_ELEVATION_NOISE_M = 4;

/**
 * Climb and descent (m) along a recorded elevation series, resilient to sensor noise:
 *
 *  1. a running median of 5 removes single-sample spikes (one bad fix would otherwise
 *     count twice — up and back down);
 *  2. a hysteresis band of `noiseM`: a rise or fall is counted only once the series has
 *     moved `noiseM` from the last turning point, and then in full — so a real climb
 *     keeps its height while jitter around it adds nothing.
 *
 * `noiseM` ≤ 0 is the raw sum of deltas (no filtering). Null with fewer than two
 * known points.
 */
export function elevationChange(
  eles: readonly (number | null)[],
  noiseM: number = DEFAULT_ELEVATION_NOISE_M,
): { gain: number; loss: number } | null {
  const known = eles.filter((e): e is number => e != null && Number.isFinite(e));
  if (known.length < 2) return null;
  let gain = 0;
  let loss = 0;
  if (noiseM <= 0) {
    for (let i = 1; i < known.length; i++) {
      const d = known[i] - known[i - 1];
      if (d > 0) gain += d;
      else loss -= d;
    }
    return { gain, loss };
  }
  const n = known.length;
  const smooth = new Array<number>(n);
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    // Symmetric, shrinking at the ends: a one-sided window there would flatten a
    // track's first and last climb into its neighbours' median.
    const r = Math.min(2, i, n - 1 - i);
    win.length = 0;
    for (let j = i - r; j <= i + r; j++) win.push(known[j]);
    win.sort((a, b) => a - b);
    smooth[i] = win[r];
  }
  let ref = smooth[0];
  for (const e of smooth) {
    if (e - ref >= noiseM) {
      gain += e - ref;
      ref = e;
    } else if (ref - e >= noiseM) {
      loss += ref - e;
      ref = e;
    }
  }
  return { gain, loss };
}

/** Rich, full-track-only stats — what fetching the recorded trace unlocks beyond
 *  the downsampled polyline. Fields are null when the track lacks the inputs. */
export interface FullTrackSummary {
  /** Number of recorded GPS points. */
  points: number;
  /** Total distance measured along the recorded track (km). */
  distanceKm: number;
  /** Cumulative ascent / descent in metres (from per-point `<ele>`); null without elevation. */
  gainM: number | null;
  lossM: number | null;
  /** Wall-clock recording span in seconds (last − first timestamp); null without times. */
  recordedSec: number | null;
  /** Peak / average speed in km/h derived from the per-point timestamps; null without times. */
  maxKmh: number | null;
  avgKmh: number | null;
  /** Seconds spent actually moving (hops at/above the stop threshold); null without times. */
  movingSec: number | null;
  /** Average speed over only the moving hops (km/h); null without times or no moving hop. */
  movingAvgKmh: number | null;
}

/**
 * Summarize a full recorded track into the headline stats it uniquely provides —
 * point count, measured distance, real elevation gain/loss, recording span and
 * peak/average speed. Elevation and time-based fields fall back to null when the
 * track carries no `<ele>` / `<time>`, so callers render only what's real.
 *
 * `movingThresholdKmh` is the smoothed-speed floor below which a hop counts as
 * stopped: such hops are dropped from `movingSec` / `movingAvgKmh`, so the moving
 * average reflects only time actually spent riding (idling at lights, pausing for
 * a photo, etc. are excluded).
 */
export function fullTrackSummary(
  ft: FullTrack,
  movingThresholdKmh: number = DEFAULT_MOVING_THRESHOLD_KMH,
  elevationNoiseM: number = DEFAULT_ELEVATION_NOISE_M,
): FullTrackSummary {
  const distanceKm = trackLengthKm(ft.points);

  // Noise-filtered (see `elevationChange`): raw deltas overstate climb several-fold.
  const change = hasElevation(ft) ? elevationChange(ft.eles, elevationNoiseM) : null;
  const gainM: number | null = change ? change.gain : null;
  const lossM: number | null = change ? change.loss : null;

  let recordedSec: number | null = null;
  let maxKmh: number | null = null;
  let avgKmh: number | null = null;
  let movingSec: number | null = null;
  let movingAvgKmh: number | null = null;
  if (hasTimes(ft)) {
    const times = ft.times.filter((t): t is number => t != null);
    const span = (times[times.length - 1] - times[0]) / 1000;
    recordedSec = span > 0 ? span : null;
    // Peak speed from the denoised per-point series (raw ~1 Hz GPS is noisy and reads
    // several km/h while parked; `smoothedSpeedsKmh` measures net displacement instead).
    const speeds = smoothedSpeedsKmh(ft);
    let max = 0;
    for (const s of speeds) if (s != null && s > max) max = s;
    maxKmh = max > 0 ? max : null;
    if (recordedSec) avgKmh = distanceKm / (recordedSec / 3600);

    // Moving time/speed: a hop counts as MOVING unless it sits inside a *stable* stop
    // (see `stableStoppedRanges` — brief sub-threshold flicker is smoothed out so the
    // split doesn't fragment into slivers). `speeds[i]` aligns with the hop point i → i+1.
    const stops = stableStoppedRanges(ft, movingThresholdKmh, speeds);
    const stoppedHop = new Uint8Array(Math.max(0, ft.points.length - 1));
    for (const [s, e] of stops) for (let i = s; i <= e; i++) stoppedHop[i] = 1;
    let movingKm = 0;
    let movingSecAcc = 0;
    for (let i = 0; i < ft.points.length - 1; i++) {
      if (stoppedHop[i]) continue;
      const t0 = ft.times[i];
      const t1 = ft.times[i + 1];
      if (t0 == null || t1 == null) continue;
      const dtSec = (t1 - t0) / 1000;
      if (dtSec <= 0) continue;
      movingKm += haversineKm(ft.points[i], ft.points[i + 1]);
      movingSecAcc += dtSec;
    }
    if (movingSecAcc > 0) {
      movingSec = movingSecAcc;
      movingAvgKmh = movingKm / (movingSecAcc / 3600);
    }
  }

  return {
    points: ft.points.length,
    distanceKm,
    gainM,
    lossM,
    recordedSec,
    maxKmh,
    avgKmh,
    movingSec,
    movingAvgKmh,
  };
}

/**
 * RAW contiguous runs of "not moving", as inclusive **hop** index ranges `[start, end]`.
 * A hop `i` (the segment from point `i` to `i+1`) counts as stopped when its smoothed
 * speed is known and below `thresholdKmh`. This is the unsmoothed primitive — it crosses
 * the threshold hop-by-hop, so noisy ~1 Hz GPS fragments it; callers wanting a stable
 * split use `stableStoppedRanges`, which builds on this. `speeds` is the denoised
 * per-point series (`smoothedSpeedsKmh`); its final entry carries no onward hop, so it's
 * ignored. A range `[s, e]` spans points
 * `s … e+1` (so its distance is `cum[s]…cum[e+1]` and its time `times[s]…times[e+1]`).
 */
export function stoppedRanges(
  speeds: (number | null)[],
  thresholdKmh: number,
): Array<[number, number]> {
  const threshold = Math.max(0, thresholdKmh);
  const ranges: Array<[number, number]> = [];
  const lastHop = speeds.length - 1; // the last point has no onward hop
  let start = -1;
  for (let i = 0; i < lastHop; i++) {
    const sp = speeds[i];
    const stopped = sp != null && sp < threshold;
    if (stopped && start < 0) start = i;
    else if (!stopped && start >= 0) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, lastHop - 1]);
  return ranges;
}

/**
 * A stop shorter than this many seconds is treated as flicker (ignored), and a moving
 * blip shorter than this between two stops is absorbed into the surrounding stop. This
 * smooths the moving/stopped split so noisy ~1 Hz GPS doesn't shatter it into slivers.
 */
export const STOP_STABILITY_SEC = 10;

/**
 * STABLE stopped hop-ranges — `stoppedRanges` (raw per-hop threshold crossings) cleaned
 * up so brief noise doesn't fragment the result, by two passes over the real recorded
 * durations: (1) merge stops separated by only a sub-`minMoveSec` moving blip into one
 * stop, then (2) drop stops shorter than `minStopSec`. A hop with no timestamp counts as
 * 0 s, so it can't sustain a stop on its own. `smoothedSpeeds` defaults to the same
 * displacement-window series the summary uses (`smoothedSpeedsKmh`) — pass the
 * already-computed series to avoid recomputing it. This is the single source of truth
 * for "where did the ride stop",
 * shared by `fullTrackSummary` (moving time/speed) and the profile's grey bands, so the
 * two always agree. Returns inclusive hop ranges `[s, e]` (hop i = point i → i+1).
 */
export function stableStoppedRanges(
  ft: FullTrack,
  thresholdKmh: number,
  smoothedSpeeds: (number | null)[] = smoothedSpeedsKmh(ft),
  minStopSec: number = STOP_STABILITY_SEC,
  minMoveSec: number = STOP_STABILITY_SEC,
): Array<[number, number]> {
  const raw = stoppedRanges(smoothedSpeeds, thresholdKmh);
  if (raw.length === 0) return [];
  const hopSec = (i: number): number => {
    const t0 = ft.times[i];
    const t1 = ft.times[i + 1];
    return t0 != null && t1 != null && t1 > t0 ? (t1 - t0) / 1000 : 0;
  };
  const spanSec = (s: number, e: number): number => {
    let acc = 0;
    for (let i = s; i <= e; i++) acc += hopSec(i);
    return acc;
  };
  // 1. Merge stops separated by only a brief moving blip into one continuous stop.
  const merged: Array<[number, number]> = [[raw[0][0], raw[0][1]]];
  for (let k = 1; k < raw.length; k++) {
    const prev = merged[merged.length - 1];
    const [cs, ce] = raw[k];
    if (spanSec(prev[1] + 1, cs - 1) < minMoveSec) prev[1] = ce;
    else merged.push([cs, ce]);
  }
  // 2. Drop stops too short to be real (flicker below the duration floor).
  return merged.filter(([s, e]) => spanSec(s, e) >= minStopSec);
}

/**
 * Per-point epoch-ms with internal `null` gaps linearly interpolated and the ends
 * held constant, so the series is dense and non-decreasing — what a time x-axis needs
 * to position every point even when a few `<time>` tags were missing. When the track
 * carries no timestamps at all it falls back to the point index (callers gate the time
 * axis on `hasTimes`, so that branch is only a safety net).
 */
export function filledTimes(times: (number | null)[]): number[] {
  const n = times.length;
  const out = new Array<number>(n);
  let lastKnown = -1;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (t == null) continue;
    if (lastKnown < 0) {
      for (let j = 0; j < i; j++) out[j] = t; // back-fill the leading gap
    } else {
      const t0 = times[lastKnown] as number;
      for (let j = lastKnown + 1; j < i; j++) {
        out[j] = t0 + ((t - t0) * (j - lastKnown)) / (i - lastKnown);
      }
    }
    out[i] = t;
    lastKnown = i;
  }
  if (lastKnown < 0) {
    for (let i = 0; i < n; i++) out[i] = i; // no times at all
  } else {
    const tail = times[lastKnown] as number;
    for (let j = lastKnown + 1; j < n; j++) out[j] = tail; // forward-fill the trailing gap
  }
  return out;
}

/** Great-circle distance between two lat/lon points, in kilometres (haversine). */
function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371; // mean Earth radius (km)
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a track in kilometres (sum of consecutive great-circle hops). */
export function trackLengthKm(points: LatLon[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return km;
}

/**
 * Cumulative distance (km) at each point: `out[i]` is the along-track distance from
 * the start up to `points[i]` (so `out[0] === 0` and `out[last]` is the total).
 * Lets callers map a point/segment to "how far into the ride" in one pass.
 */
export function cumulativeKm(points: LatLon[]): number[] {
  const out = new Array<number>(points.length);
  out[0] = 0;
  for (let i = 1; i < points.length; i++)
    out[i] = out[i - 1] + haversineKm(points[i - 1], points[i]);
  return out;
}

/** Perpendicular distance from point `p` to the segment `a`–`b` (planar approx). */
function segDistance(p: LatLon, a: LatLon, b: LatLon): number {
  const [py, px] = p;
  const [ay, ax] = a;
  const [by, bx] = b;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const tc = Math.max(0, Math.min(1, t));
  const cx = ax + tc * dx;
  const cy = ay + tc * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Douglas–Peucker simplification with an epsilon (in degrees). */
function douglasPeucker(points: LatLon[], epsilon: number): LatLon[] {
  if (points.length < 3) return points.slice();
  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = segDistance(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon) return [points[0], points[end]];
  const left = douglasPeucker(points.slice(0, index + 1), epsilon);
  const right = douglasPeucker(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

/**
 * Reduce a track to at most `maxPoints` by ramping Douglas–Peucker epsilon until
 * the cap is met. `maxPoints` is clamped to a sane minimum.
 */
export function simplify(points: LatLon[], maxPoints: number): LatLon[] {
  const cap = Math.max(2, Math.floor(maxPoints));
  if (points.length <= cap) return points.slice();
  let epsilon = 1e-5; // ~1m
  let result = points;
  for (let i = 0; i < 40 && result.length > cap; i++) {
    result = douglasPeucker(points, epsilon);
    epsilon *= 1.6;
  }
  if (result.length > cap) {
    // Fallback: evenly sample down to the cap.
    const step = (result.length - 1) / (cap - 1);
    const sampled: LatLon[] = [];
    for (let i = 0; i < cap; i++) sampled.push(result[Math.round(i * step)]);
    result = sampled;
  }
  return result;
}

// --- Google encoded polyline (precision 5) ----------------------------------

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/** Encode lat/lon points as a Google polyline string. */
export function encodePolyline(points: LatLon[], precision = 5): string {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let out = "";
  for (const [lat, lon] of points) {
    const latE = Math.round(lat * factor);
    const lonE = Math.round(lon * factor);
    out += encodeSigned(latE - lastLat);
    out += encodeSigned(lonE - lastLon);
    lastLat = latE;
    lastLon = lonE;
  }
  return out;
}

/** Decode a Google polyline string back into lat/lon points. */
export function decodePolyline(encoded: string, precision = 5): LatLon[] {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

/**
 * Build a minimal GPX 1.1 document (a single named `<trk>`) from an encoded
 * polyline, or null when it has fewer than two points. This is a SHAPE-only export
 * (no timestamps/elevation) — used to save a ride's stored route to disk without
 * any device or network, since the full track already lives in the cache.
 */
export function encodedTrackToGpx(encoded: string, name: string): string | null {
  const pts = decodePolyline(encoded);
  if (pts.length < 2) return null;
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const trkpts = pts.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<gpx version="1.1" creator="GPX Toolkit" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<trk><name>${esc(name)}</name><trkseg>${trkpts}</trkseg></trk></gpx>`
  );
}

/** Metadata about a GPX captured into a rough track. */
export interface RoughTrack {
  /** Google-style encoded polyline of the simplified route. "" when no usable track. */
  polyline: string;
  /** Number of lat/lon points read from the source GPX. */
  srcPoints: number;
  /** Number of points kept after simplification. */
  keptPoints: number;
  /** Computed length of the source track, in kilometres. */
  km: number;
}

/**
 * Full pipeline: GPX bytes → rough encoded polyline + capture metadata.
 *
 * The kept-point target scales with the track's length (`pointsPerKm`), so a long
 * ride keeps proportionally more shape than a short one. Endpoints are always
 * preserved (see `simplify`). `polyline` is "" when the GPX has no usable track,
 * so callers can simply skip storing a track.
 */
export function gpxToRoughTrack(bytes: Uint8Array, pointsPerKm: number): RoughTrack {
  const text = new TextDecoder().decode(bytes);
  const pts = extractTrack(text);
  if (pts.length < 2) {
    return { polyline: "", srcPoints: pts.length, keptPoints: 0, km: 0 };
  }
  const km = trackLengthKm(pts);
  const target = Math.max(2, Math.round(pointsPerKm * km));
  const kept = simplify(pts, target);
  return {
    polyline: encodePolyline(kept),
    srcPoints: pts.length,
    keptPoints: kept.length,
    km,
  };
}
