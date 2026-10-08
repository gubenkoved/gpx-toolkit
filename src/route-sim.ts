/**
 * GPX Toolkit — ride simulation: how the wind would treat you on a route.
 *
 * The route is cut into short steps (a "course"); riding it from a departure instant
 * walks the steps in order, and at each one reads the wind where and WHEN the rider
 * gets there, projects it onto the step's heading (weather.ts' along-track maths:
 * + tailwind, − headwind) and turns it into a speed with the rider's speed model:
 *
 *     speed = calm-air speed + slope × along-track wind
 *
 * — the same line the Wind vs speed view fits from your own rides (its intercept and
 * slope), saved by `saveSpeedFit`. Time spent on a step decides when the next one is
 * reached, so a slow headwind stretch pushes the rest of the ride later into the day.
 *
 * Everything is pure and in memory: the weather is fetched once per route (all the
 * forecast days at once), so moving the departure time just re-runs `simulate` and
 * the whole-day sweep (`sweepDepartures`) costs a few milliseconds.
 */

import { cumulativeKm, type LatLon } from "./track";
import {
  alongTrackComponentKmh,
  bearingDeg,
  type CellDayWind,
  crossTrackComponentKmh,
  weatherAtMs,
  windAtMs,
} from "./weather";

// --------------------------------------------------------------------------- //
// Speed model
// --------------------------------------------------------------------------- //

/** speed = calmKmh + slope × along-track wind (km/h, + tailwind). */
export interface SpeedModel {
  calmKmh: number;
  slope: number;
}

/** A speed model fitted by the Wind vs speed view, with how good the fit was. */
export interface SpeedFit extends SpeedModel {
  r2: number;
  segments: number;
  /** Epoch ms of the fit. */
  fittedAt: number;
}

/** Used until you set your own: a relaxed touring pace that gains ~2 km/h from a
 *  10 km/h tailwind. */
export const DEFAULT_SPEED_MODEL: SpeedModel = { calmKmh: 22, slope: 0.2 };

const FIT_KEY = "gpx_toolkit.speed_fit";
const MODEL_KEY = "gpx_toolkit.route_speed";

/** What the rider set in the simulator: the expected still-air moving speed and,
 *  optionally, their own tailwind factor (null = follow the Wind vs speed fit). */
export interface SpeedPrefs {
  calmKmh: number | null;
  slope: number | null;
}

export function readSpeedPrefs(): SpeedPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(MODEL_KEY) || "null") as SpeedPrefs | null;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    return { calmKmh: num(raw?.calmKmh), slope: num(raw?.slope) };
  } catch {
    return { calmKmh: null, slope: null };
  }
}

export function saveSpeedPrefs(p: SpeedPrefs): void {
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify(p));
  } catch {
    /* non-fatal */
  }
}

/** The model a simulation rides with: each field is the rider's own value, else the
 *  Wind vs speed fit, else the default. */
export function effectiveSpeedModel(prefs: SpeedPrefs, fit: SpeedFit | null): SpeedModel {
  return {
    calmKmh: prefs.calmKmh ?? fit?.calmKmh ?? DEFAULT_SPEED_MODEL.calmKmh,
    slope: prefs.slope ?? fit?.slope ?? DEFAULT_SPEED_MODEL.slope,
  };
}

/** The last head/tailwind fit the Wind vs speed view produced, or null. */
export function readSpeedFit(): SpeedFit | null {
  try {
    const raw = JSON.parse(localStorage.getItem(FIT_KEY) || "null") as SpeedFit | null;
    if (
      raw &&
      Number.isFinite(raw.calmKmh) &&
      Number.isFinite(raw.slope) &&
      raw.calmKmh > 0 &&
      Number.isFinite(raw.segments)
    )
      return raw;
  } catch {
    /* storage blocked or junk — no fit */
  }
  return null;
}

/** Remember the Wind vs speed fit so the route simulator can ride with it. */
export function saveSpeedFit(fit: SpeedFit): void {
  try {
    localStorage.setItem(FIT_KEY, JSON.stringify(fit));
  } catch {
    /* non-fatal */
  }
}

/** Speed for an along-track wind, kept physical: a linear fit would otherwise stall
 *  (or reverse) in a gale and run away downwind. */
export function speedFor(model: SpeedModel, alongKmh: number): number {
  const v = model.calmKmh + model.slope * alongKmh;
  const floor = Math.max(4, model.calmKmh * 0.3);
  return Math.min(model.calmKmh * 1.8, Math.max(floor, v));
}

// --------------------------------------------------------------------------- //
// Course
// --------------------------------------------------------------------------- //

/** One step of the course: where it is (its middle), how long, which way. */
export interface CourseStep {
  lat: number;
  lon: number;
  /** Km from the start to the step's beginning. */
  km: number;
  lenKm: number;
  /** Travel bearing over the step, degrees (0 = N, clockwise). */
  bearing: number;
}

export interface Course {
  steps: CourseStep[];
  totalKm: number;
}

/** Cut a route line into ~`stepKm` steps (the last one shorter). */
export function buildCourse(points: LatLon[], stepKm = 0.25): Course {
  if (points.length < 2) return { steps: [], totalKm: 0 };
  const cum = cumulativeKm(points);
  const total = cum[cum.length - 1];
  if (!(total > 0)) return { steps: [], totalKm: 0 };
  // Position at a distance along the line; `seg` walks forward with monotone queries.
  let seg = 0;
  const at = (d: number): LatLon => {
    while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg];
    const f = span > 0 ? Math.min(1, Math.max(0, (d - cum[seg]) / span)) : 0;
    const a = points[seg];
    const b = points[seg + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const n = Math.max(1, Math.ceil(total / stepKm));
  const len = total / n;
  const steps: CourseStep[] = [];
  let prev = at(0);
  for (let i = 0; i < n; i++) {
    const d0 = i * len;
    const mid = at(d0 + len / 2);
    const end = at(Math.min(total, d0 + len));
    steps.push({
      lat: mid[0],
      lon: mid[1],
      km: d0,
      lenKm: len,
      bearing: bearingDeg(prev, end),
    });
    prev = end;
  }
  return { steps, totalKm: total };
}

// --------------------------------------------------------------------------- //
// Weather along the course
// --------------------------------------------------------------------------- //

export interface StepWeather {
  /** Direction the wind blows FROM, degrees. */
  fromDeg: number;
  speedKmh: number;
  gustKmh: number;
  rainMm: number | null;
  tempC: number | null;
}

/** Weather for course step `i` at instant `tMs`, or null when none is known. */
export type WeatherAt = (i: number, tMs: number) => StepWeather | null;

const dayOf = (tMs: number): string => new Date(tMs).toISOString().slice(0, 10);

/**
 * A `WeatherAt` over fetched cell-days: each step reads the nearest grid cell that
 * has data (the cells were sampled along the route, so nearest is its own cell or a
 * neighbour when the sample was capped), interpolated to the instant.
 */
export function weatherFromCells(course: Course, entries: CellDayWind[]): WeatherAt {
  const cells = new Map<
    string,
    { lat: number; lon: number; days: Map<string, CellDayWind> }
  >();
  for (const e of entries) {
    if (e.noData) continue;
    const k = `${e.latIdx}:${e.lonIdx}`;
    let c = cells.get(k);
    if (!c) {
      c = { lat: e.cellLat, lon: e.cellLon, days: new Map() };
      cells.set(k, c);
    }
    c.days.set(e.dayISO, e);
  }
  const list = [...cells.values()];
  const stepCell = course.steps.map((s) => {
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    const kx = Math.cos((s.lat * Math.PI) / 180);
    list.forEach((c, j) => {
      const d = (c.lat - s.lat) ** 2 + ((c.lon - s.lon) * kx) ** 2;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    });
    return best;
  });
  return (i, tMs) => {
    const c = list[stepCell[i]];
    const e = c?.days.get(dayOf(tMs));
    if (!e) return null;
    const w = windAtMs(e, tMs);
    if (!w) return null;
    const wx = weatherAtMs(e, tMs);
    return {
      fromDeg: w.fromDeg,
      speedKmh: w.speedKmh,
      gustKmh: w.gustKmh,
      rainMm: wx?.rainMm ?? null,
      tempC: wx?.tempC ?? null,
    };
  };
}

// --------------------------------------------------------------------------- //
// Simulation
// --------------------------------------------------------------------------- //

/** The rider on one course step. */
export interface SimStep {
  /** Instant the rider starts the step. */
  tMs: number;
  /** Along-track wind, km/h (+ tailwind, − headwind); 0 when unknown. */
  along: number;
  /** Side wind magnitude, km/h. */
  cross: number;
  speedKmh: number;
  /** Null when no weather was known for the step (ridden at calm-air speed). */
  wx: StepWeather | null;
}

export interface SimResult {
  steps: SimStep[];
  startMs: number;
  endMs: number;
  durationSec: number;
  /** The same ride in still air — the baseline for "the wind costs you N min". */
  calmSec: number;
  distanceKm: number;
  avgSpeedKmh: number;
  /** Distance-weighted along-track wind (km/h, + tailwind). */
  avgAlongKmh: number;
  /** Share of the distance into a headwind / with a tailwind stronger than 3 km/h. */
  headShare: number;
  tailShare: number;
  maxGustKmh: number | null;
  /** Share of riding time in rain (≥ 0.1 mm that hour); null when rain is unknown. */
  wetShare: number | null;
  maxRainMmH: number | null;
  avgTempC: number | null;
  /** Share of the distance with known wind (1 = the whole route). */
  coverage: number;
}

/** Wind under this (km/h, along-track) counts as neither head- nor tailwind. */
const NEUTRAL_KMH = 3;

/** Ride the course from `startMs` with `model` through the weather. */
export function simulate(
  course: Course,
  startMs: number,
  model: SpeedModel,
  weatherAt: WeatherAt,
): SimResult {
  const steps: SimStep[] = [];
  let t = startMs;
  let alongKm = 0;
  let headKm = 0;
  let tailKm = 0;
  let knownKm = 0;
  let maxGust: number | null = null;
  let wetSec = 0;
  let rainSec = 0;
  let maxRain: number | null = null;
  let tempSum = 0;
  let tempSec = 0;
  course.steps.forEach((s, i) => {
    const wx = weatherAt(i, t);
    const along = wx ? alongTrackComponentKmh(wx.fromDeg, wx.speedKmh, s.bearing) : 0;
    const cross = wx
      ? Math.abs(crossTrackComponentKmh(wx.fromDeg, wx.speedKmh, s.bearing))
      : 0;
    const speed = speedFor(model, along);
    const sec = (s.lenKm / speed) * 3600;
    steps.push({ tMs: t, along, cross, speedKmh: speed, wx });
    if (wx) {
      knownKm += s.lenKm;
      alongKm += along * s.lenKm;
      if (along <= -NEUTRAL_KMH) headKm += s.lenKm;
      else if (along >= NEUTRAL_KMH) tailKm += s.lenKm;
      maxGust = Math.max(maxGust ?? 0, wx.gustKmh);
      if (wx.rainMm != null) {
        rainSec += sec;
        if (wx.rainMm >= 0.1) wetSec += sec;
        maxRain = Math.max(maxRain ?? 0, wx.rainMm);
      }
      if (wx.tempC != null) {
        tempSum += wx.tempC * sec;
        tempSec += sec;
      }
    }
    t += sec * 1000;
  });
  const dist = course.totalKm;
  const durationSec = (t - startMs) / 1000;
  return {
    steps,
    startMs,
    endMs: t,
    durationSec,
    calmSec: dist > 0 ? (dist / speedFor(model, 0)) * 3600 : 0,
    distanceKm: dist,
    avgSpeedKmh: durationSec > 0 ? dist / (durationSec / 3600) : 0,
    avgAlongKmh: knownKm > 0 ? alongKm / knownKm : 0,
    headShare: dist > 0 ? headKm / dist : 0,
    tailShare: dist > 0 ? tailKm / dist : 0,
    maxGustKmh: maxGust,
    wetShare: rainSec > 0 ? wetSec / rainSec : null,
    maxRainMmH: maxRain,
    avgTempC: tempSec > 0 ? tempSum / tempSec : null,
    coverage: dist > 0 ? knownKm / dist : 0,
  };
}

/** One departure of a sweep: when, how long, and what the wind did. */
export interface Departure {
  startMs: number;
  durationSec: number;
  avgAlongKmh: number;
  wetShare: number | null;
  coverage: number;
}

/** Simulate every departure in `starts` (e.g. each half hour of a day). */
export function sweepDepartures(
  course: Course,
  starts: number[],
  model: SpeedModel,
  weatherAt: WeatherAt,
): Departure[] {
  return starts.map((startMs) => {
    const r = simulate(course, startMs, model, weatherAt);
    return {
      startMs,
      durationSec: r.durationSec,
      avgAlongKmh: r.avgAlongKmh,
      wetShare: r.wetShare,
      coverage: r.coverage,
    };
  });
}
