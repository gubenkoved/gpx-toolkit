/**
 * Historical wind: Open-Meteo client, grid sampling, and head/tailwind math.
 *
 * The feature paints each ride's track by how much the wind helped or fought the
 * rider, and shows where the wind blew FROM at each point, at that time. Two facts
 * shape the whole design:
 *
 *  - **Time is free, space costs calls.** One Open-Meteo request for a location
 *    returns the whole day as hourly arrays, so the wind changing *during* a ride
 *    costs nothing extra — we interpolate the hourly timeline to each track point's
 *    exact instant. Only sampling *different places* needs more data, and Open-Meteo
 *    takes many coordinates in a single HTTP request.
 *  - **Sample no finer than the model grid.** Each dataset has a real spatial
 *    resolution (CERRA ~5 km, ECMWF-IFS ~9 km, ERA5 ~25 km); probing finer returns
 *    identical numbers. So we snap the track to grid cells and dedupe — the cell
 *    count (not the track length) bounds the request cost.
 *
 * Everything here is pure/deterministic except `OpenMeteo`, which performs the
 * rate-limited, retrying HTTP fetch (injected `fetch`/`now`/`sleep` for tests). The
 * cacheable unit is one (dataset, grid-cell, UTC-day) — see windcache.ts. Wind data
 * is by Open-Meteo.com (CC-BY 4.0).
 */

import type { LatLon } from "./track";

// --------------------------------------------------------------------------- //
// Datasets
// --------------------------------------------------------------------------- //

/** Which reanalysis / forecast model a cached cell-day came from. */
export type DatasetId = "cerra" | "ecmwf_ifs" | "era5" | "forecast";

/** A weather model: its grid resolution, the endpoint, and how to address it. */
export interface Dataset {
  id: DatasetId;
  /** Human label for the provenance badge, e.g. "CERRA 5 km". */
  label: string;
  /** Grid step in degrees used to quantize coordinates into cells (≈ the model grid). */
  gridDeg: number;
  /** Nominal cell size in km, for drawing the coverage footprint. */
  gridKm: number;
  /** Open-Meteo host + path. */
  endpoint: string;
  /** Archive `models=` value (omitted for the live-forecast fallback). */
  models?: string;
  /** True for the live-forecast endpoint (uses past_days instead of start/end dates). */
  forecast: boolean;
}

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

const DATASETS: Record<DatasetId, Dataset> = {
  cerra: {
    id: "cerra",
    label: "CERRA 5 km",
    gridDeg: 0.05,
    gridKm: 5,
    endpoint: ARCHIVE,
    models: "cerra",
    forecast: false,
  },
  ecmwf_ifs: {
    id: "ecmwf_ifs",
    label: "ECMWF IFS 9 km",
    gridDeg: 0.1,
    gridKm: 9,
    endpoint: ARCHIVE,
    models: "ecmwf_ifs",
    forecast: false,
  },
  era5: {
    id: "era5",
    label: "ERA5 25 km",
    gridDeg: 0.25,
    gridKm: 25,
    endpoint: ARCHIVE,
    models: "era5",
    forecast: false,
  },
  forecast: {
    id: "forecast",
    label: "Live forecast 11 km",
    gridDeg: 0.1,
    gridKm: 11,
    endpoint: FORECAST,
    forecast: true,
  },
};

/** Wind variables we request (kept ≤10 so a request stays a single API call). */
const WIND_VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"] as const;

/** The archive (ERA5/ERA5-Land) lags real time by ~5 days; newer rides use forecast. */
const ARCHIVE_LAG_DAYS = 5;
/** CERRA's European reanalysis covers up to the end of June 2021. */
const CERRA_END_MS = Date.UTC(2021, 5, 30);
/** ECMWF IFS high-res analysis is archived from 2017. */
const IFS_START_YEAR = 2017;

/** Rough bounding box of CERRA's European domain (lat/lon degrees). */
function inEurope(lat: number, lon: number): boolean {
  return lat >= 20 && lat <= 75 && lon >= -25 && lon <= 45;
}

/** The dataset descriptor for a stored id (e.g. to redraw a cached ride's footprints). */
export function datasetById(id: DatasetId): Dataset {
  return DATASETS[id];
}

/**
 * Ordered list of candidate datasets for a ride, finest first. The caller resolves
 * cells against the first candidate that actually returns wind and falls back down
 * the list otherwise (e.g. a CERRA gap → IFS → ERA5).
 */
export function pickDatasets(
  lat: number,
  lon: number,
  dateMs: number,
  nowMs: number,
): Dataset[] {
  const ageDays = (nowMs - dateMs) / 86_400_000;
  // Too recent for the reanalysis archive — only the live forecast has it.
  if (ageDays < ARCHIVE_LAG_DAYS) return [DATASETS.forecast];

  const year = new Date(dateMs).getUTCFullYear();
  const out: Dataset[] = [];
  if (inEurope(lat, lon) && dateMs <= CERRA_END_MS) out.push(DATASETS.cerra);
  if (year >= IFS_START_YEAR) out.push(DATASETS.ecmwf_ifs);
  out.push(DATASETS.era5);
  return out;
}

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

/** A grid cell: its quantized integer indices plus the cell-center coordinate. */
export interface Cell {
  latIdx: number;
  lonIdx: number;
  /** Cell-center latitude (the request coordinate; refined to the served center). */
  lat: number;
  lon: number;
}

/**
 * One (dataset, grid-cell, UTC-day) of hourly wind — the cacheable unit. Stored at
 * full precision (see windcache.ts). `hourly` is an OPEN variable→array map so extra
 * variables (100 m wind, temperature…) can be added later without a format change.
 */
export interface CellDayWind {
  /** Storage-format version (set by the cache encoder). */
  v?: number;
  dataset: DatasetId;
  /** Quantized request-grid indices (the cache key — deterministic per cell). */
  latIdx: number;
  lonIdx: number;
  /** Grid-center actually returned by Open-Meteo (for the footprint + nearest-cell). */
  cellLat: number;
  cellLon: number;
  /** Nominal cell size in km (for the footprint square). */
  gridKm: number;
  /** UTC calendar day this entry covers, "YYYY-MM-DD". */
  dayISO: string;
  /** Number of hourly samples (24 for a full day). */
  step: number;
  /** variable → per-hour values (null where a sample was missing). */
  hourly: Record<string, (number | null)[]>;
  /** Negative-cache sentinel: the model has no wind for this cell-day (don't refetch). */
  noData?: boolean;
}

/** Instantaneous wind at one track point, plus its along-track component. */
export interface PointWind {
  /** Meteorological direction the wind blows FROM (0=N, 90=E), degrees. */
  fromDeg: number;
  speedKmh: number;
  gustKmh: number;
  /** Along-track component (km/h): positive = tailwind, negative = headwind. */
  alongKmh: number;
  /** The rider's travel bearing here (0=N, clockwise), so the UI can show the wind
   *  RELATIVE to movement (e.g. a dial where "up" is the direction of travel). */
  headingDeg: number;
  /** Grid-center of the cell that served this point (for the footprint hover). */
  cellLat: number;
  cellLon: number;
}

/** Small per-ride derived summary stored on the ride record (no per-point arrays). */
export interface RideWind {
  fetchedAt: string;
  dataset: DatasetId;
  datasetLabel: string;
  gridKm: number;
  cellCount: number;
  usedForecast: boolean;
  /** Grid-center coords of the cells used (to draw footprints without a recompute). */
  cells: { lat: number; lon: number }[];
  /** Mean along-track component (km/h): + tailwind-dominant, − headwind-dominant. */
  avgAlongKmh: number;
  /** Fraction of points with a tailwind component (0..1). */
  pctTailwind: number;
  /** Prevailing wind FROM-direction across the ride (speed-weighted), degrees. */
  prevailingFromDeg: number;
  avgSpeedKmh: number;
  avgGustKmh: number;
  /** True when no wind could be resolved for this ride (negative cache). */
  noData?: boolean;
}

// --------------------------------------------------------------------------- //
// Grid sampling
// --------------------------------------------------------------------------- //

/** Snap a coordinate to a dataset's grid, returning the indices + cell center. */
export function quantizeCell(lat: number, lon: number, dataset: Dataset): Cell {
  const latIdx = Math.round(lat / dataset.gridDeg);
  const lonIdx = Math.round(lon / dataset.gridDeg);
  return { latIdx, lonIdx, lat: latIdx * dataset.gridDeg, lon: lonIdx * dataset.gridDeg };
}

/** Canonical cache key for one (dataset, cell, day). */
export function cellDayKey(
  dataset: DatasetId,
  latIdx: number,
  lonIdx: number,
  dayISO: string,
): string {
  return `${dataset}::${latIdx}:${lonIdx}::${dayISO}`;
}

/**
 * The lat/lon square one grid cell covers, centered on its grid-center, as
 * `[[south, west], [north, east]]`. Longitude degrees are widened by 1/cos(lat) so
 * the footprint is the right ground size at any latitude.
 */
export function cellBounds(
  cellLat: number,
  cellLon: number,
  gridKm: number,
): [LatLon, LatLon] {
  const halfLat = gridKm / 2 / 111.32;
  const halfLon = halfLat / Math.max(0.01, Math.cos((cellLat * Math.PI) / 180));
  return [
    [cellLat - halfLat, cellLon - halfLon],
    [cellLat + halfLat, cellLon + halfLon],
  ];
}

/**
 * Unique grid cells a track passes through, in order, deduped to the dataset grid
 * and capped. When the cap is exceeded the cells are evenly subsampled so coverage
 * still spans the whole route. This cell count — not the point count — bounds the
 * request cost.
 */
export function sampleGridCells(points: LatLon[], dataset: Dataset, cap: number): Cell[] {
  const seen = new Set<string>();
  const cells: Cell[] = [];
  for (const [lat, lon] of points) {
    const c = quantizeCell(lat, lon, dataset);
    const k = `${c.latIdx}:${c.lonIdx}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cells.push(c);
  }
  if (cells.length <= cap) return cells;
  const out: Cell[] = [];
  const stride = (cells.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) out.push(cells[Math.round(i * stride)]);
  return out;
}

// --------------------------------------------------------------------------- //
// Wind math
// --------------------------------------------------------------------------- //

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Initial bearing (degrees, 0=N clockwise) from point `a` to point `b`. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = a[0] * D2R;
  const φ2 = b[0] * D2R;
  const dλ = (b[1] - a[1]) * D2R;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/**
 * Along-track wind component in km/h for a rider heading `bearing` while the wind
 * blows FROM `fromDeg` at `speed`. Positive = tailwind (helps), negative = headwind.
 *
 * Derivation: a wind from due south (180°) while riding due north (0°) is a pure
 * tailwind → `-speed·cos(180−0) = -speed·(−1) = +speed`.
 */
export function alongTrackComponentKmh(
  fromDeg: number,
  speed: number,
  bearing: number,
): number {
  return -speed * Math.cos((fromDeg - bearing) * D2R);
}

/** Hourly wind for one cell, sampled at exact epoch-ms instants (UTC-day based). */
function sampleMsForHour(dayISO: string, hour: number): number {
  return Date.parse(`${dayISO}T00:00:00Z`) + hour * 3_600_000;
}

interface WindSample {
  fromDeg: number;
  speedKmh: number;
  gustKmh: number;
}

/**
 * Interpolate a cell's hourly wind to an exact instant. Speed+direction are
 * interpolated as a VECTOR (polar→Cartesian→polar) so a wrap like 350°→010° blends
 * correctly instead of swinging through 180°. Returns null when the bracketing
 * samples are missing. Clamps to the day's ends.
 */
export function windAtMs(entry: CellDayWind, tMs: number): WindSample | null {
  const speeds = entry.hourly.wind_speed_10m;
  const dirs = entry.hourly.wind_direction_10m;
  const gusts = entry.hourly.wind_gusts_10m;
  if (!speeds || !dirs) return null;
  const n = entry.step;
  const first = sampleMsForHour(entry.dayISO, 0);
  const hourF = Math.min(Math.max((tMs - first) / 3_600_000, 0), n - 1);
  const i0 = Math.floor(hourF);
  const i1 = Math.min(i0 + 1, n - 1);
  const frac = hourF - i0;

  const a = vecAt(speeds, dirs, gusts, i0);
  const b = vecAt(speeds, dirs, gusts, i1);
  if (!a && !b) return null;
  if (!a) return sampleFromVec(b!);
  if (!b) return sampleFromVec(a);
  return sampleFromVec({
    fx: a.fx + (b.fx - a.fx) * frac,
    fy: a.fy + (b.fy - a.fy) * frac,
    gust: lerpNullable(a.gust, b.gust, frac),
  });
}

interface Vec {
  fx: number;
  fy: number;
  gust: number | null;
}

function vecAt(
  speeds: (number | null)[],
  dirs: (number | null)[],
  gusts: (number | null)[] | undefined,
  i: number,
): Vec | null {
  const s = speeds[i];
  const d = dirs[i];
  if (s == null || d == null) return null;
  return {
    fx: s * Math.cos(d * D2R),
    fy: s * Math.sin(d * D2R),
    gust: gusts ? (gusts[i] ?? null) : null,
  };
}

function sampleFromVec(v: { fx: number; fy: number; gust: number | null }): WindSample {
  const speedKmh = Math.hypot(v.fx, v.fy);
  const fromDeg = (Math.atan2(v.fy, v.fx) * R2D + 360) % 360;
  return { fromDeg, speedKmh, gustKmh: v.gust ?? speedKmh };
}

function lerpNullable(a: number | null, b: number | null, frac: number): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * frac;
}

/** A decoded-cell lookup: returns the cached wind for a cell on a UTC day, or null. */
export type CellLookup = (
  latIdx: number,
  lonIdx: number,
  dayISO: string,
) => CellDayWind | null;

/**
 * Compute per-point wind along a track (render-time only — never persisted). For
 * each point: find its grid cell + UTC day, interpolate that cell's hourly wind to
 * the point's instant, and combine with the heading to the next point to get the
 * along-track head/tailwind component. Points with no resolvable wind are null.
 */
export function computeRidePoints(
  points: LatLon[],
  pointTimesMs: number[],
  lookup: CellLookup,
  dataset: Dataset,
): (PointWind | null)[] {
  const n = points.length;
  const out: (PointWind | null)[] = new Array(n).fill(null);
  // The wind SAMPLE (direction/speed/gust) at each point, before projecting onto the
  // local heading. Kept separately so we can fill gaps (points whose own cell had no
  // data — e.g. the track crosses water) from the nearest resolved sample.
  const sample: ({
    fromDeg: number;
    speedKmh: number;
    gustKmh: number;
    cellLat: number;
    cellLon: number;
  } | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const tMs = pointTimesMs[i];
    if (!Number.isFinite(tMs)) continue;
    const c = quantizeCell(points[i][0], points[i][1], dataset);
    const dayISO = new Date(tMs).toISOString().slice(0, 10);
    const entry = lookup(c.latIdx, c.lonIdx, dayISO);
    if (!entry || entry.noData) continue;
    const w = windAtMs(entry, tMs);
    if (!w) continue;
    sample[i] = {
      fromDeg: w.fromDeg,
      speedKmh: w.speedKmh,
      gustKmh: w.gustKmh,
      cellLat: entry.cellLat,
      cellLon: entry.cellLon,
    };
  }
  // Fill gaps: any point with no sample borrows the nearest resolved one (by index —
  // i.e. along-track distance). At grid scale the wind field is ~uniform, so this is
  // accurate; it keeps the route colouring continuous instead of leaving bare white
  // casing where a single cell (often over water) had no data. If NOTHING resolved,
  // every entry stays null and the caller treats the ride as no-data.
  const filled = fillNearest(sample);
  for (let i = 0; i < n; i++) {
    const s = filled[i];
    if (!s) continue;
    const bearing = bearingDeg(points[i], points[Math.min(i + 1, n - 1)]);
    out[i] = {
      fromDeg: s.fromDeg,
      speedKmh: s.speedKmh,
      gustKmh: s.gustKmh,
      alongKmh: alongTrackComponentKmh(s.fromDeg, s.speedKmh, bearing),
      headingDeg: bearing,
      cellLat: s.cellLat,
      cellLon: s.cellLon,
    };
  }
  return out;
}

/** Fill null gaps in a per-point series by copying the nearest non-null entry (ties
 *  go to the earlier one). Returns a new array; all-null input is returned as-is. */
function fillNearest<T>(arr: (T | null)[]): (T | null)[] {
  const n = arr.length;
  const out = arr.slice();
  // Index of the nearest non-null at or before each position (forward pass)…
  const prev = new Array<number>(n).fill(-1);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (arr[i] != null) last = i;
    prev[i] = last;
  }
  // …and at or after each position (backward pass); pick whichever is closer.
  let next = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (arr[i] != null) next = i;
    if (arr[i] == null) {
      const p = prev[i];
      const useNext = p < 0 || (next >= 0 && next - i < i - p);
      const src = useNext ? next : p;
      if (src >= 0) out[i] = arr[src];
    }
  }
  return out;
}

/** Reduce per-point wind to the small persisted summary (provenance + averages). */
export function summarize(
  pts: (PointWind | null)[],
  meta: { dataset: Dataset; cells: { lat: number; lon: number }[]; fetchedAt: string },
): RideWind {
  const real = pts.filter((p): p is PointWind => p != null);
  const base: RideWind = {
    fetchedAt: meta.fetchedAt,
    dataset: meta.dataset.id,
    datasetLabel: meta.dataset.label,
    gridKm: meta.dataset.gridKm,
    cellCount: meta.cells.length,
    usedForecast: meta.dataset.forecast,
    cells: meta.cells,
    avgAlongKmh: 0,
    pctTailwind: 0,
    prevailingFromDeg: 0,
    avgSpeedKmh: 0,
    avgGustKmh: 0,
  };
  if (real.length === 0) return { ...base, noData: true };

  let along = 0;
  let tail = 0;
  let speed = 0;
  let gust = 0;
  let fx = 0;
  let fy = 0;
  for (const p of real) {
    along += p.alongKmh;
    if (p.alongKmh > 0) tail++;
    speed += p.speedKmh;
    gust += p.gustKmh;
    fx += p.speedKmh * Math.cos(p.fromDeg * D2R);
    fy += p.speedKmh * Math.sin(p.fromDeg * D2R);
  }
  const n = real.length;
  return {
    ...base,
    avgAlongKmh: along / n,
    pctTailwind: tail / n,
    prevailingFromDeg: (Math.atan2(fy, fx) * R2D + 360) % 360,
    avgSpeedKmh: speed / n,
    avgGustKmh: gust / n,
  };
}

// --------------------------------------------------------------------------- //
// Open-Meteo client (rate-limited, retrying)
// --------------------------------------------------------------------------- //

/** Injectable side-effects so the client is fully testable with a fake clock. */
export interface WeatherDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface OpenMeteoOptions {
  /** Minimum spacing between request starts (ms). Default 200 → ≤5/s. */
  minSpacingMs?: number;
  /** Rolling 60 s request cap (well under the 600/min free limit). Default 300. */
  maxPerMin?: number;
  /** Max retries on 429 / 5xx before giving up. Default 4. */
  maxRetries?: number;
  /** Base backoff (ms) for exponential retry. Default 1000. */
  baseBackoffMs?: number;
  /** Backoff ceiling (ms). Default 30000. */
  maxBackoffMs?: number;
}

/** Raised when Open-Meteo returns an error status we won't retry (e.g. 400). */
export class WeatherError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WeatherError";
  }
}

export class OpenMeteo {
  private readonly minSpacingMs: number;
  private readonly maxPerMin: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  /** Serializes the rate-limit gate so spacing holds across concurrent callers. */
  private gateChain: Promise<void> = Promise.resolve();
  private lastStartMs: number | null = null;
  private recent: number[] = [];

  constructor(
    private readonly deps: WeatherDeps,
    opts: OpenMeteoOptions = {},
  ) {
    this.minSpacingMs = opts.minSpacingMs ?? 200;
    this.maxPerMin = opts.maxPerMin ?? 300;
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  /**
   * Fetch wind for several cells over a span of UTC days in ONE HTTP request
   * (multi-coordinate). Returns one entry per (cell, day) — including `noData`
   * sentinels for cells the model can't serve — so the caller can cache negatives
   * too. `onStage` reports throttle/backoff so the UI can show honest progress.
   */
  async fetchWindMulti(
    dataset: Dataset,
    cells: Cell[],
    days: string[],
    onStage?: (msg: string) => void,
  ): Promise<CellDayWind[]> {
    if (cells.length === 0 || days.length === 0) return [];
    const url = this.buildUrl(dataset, cells, days);
    const resp = await this.request(url, onStage);
    if (!resp.ok) {
      throw new WeatherError(`Open-Meteo responded ${resp.status}`, resp.status);
    }
    const json = (await resp.json()) as unknown;
    return this.parse(dataset, cells, days, json);
  }

  // -- URL + parsing --------------------------------------------------------

  private buildUrl(dataset: Dataset, cells: Cell[], days: string[]): string {
    const sorted = [...days].sort();
    const p = new URLSearchParams();
    p.set("latitude", cells.map((c) => c.lat.toFixed(4)).join(","));
    p.set("longitude", cells.map((c) => c.lon.toFixed(4)).join(","));
    p.set("hourly", WIND_VARS.join(","));
    p.set("wind_speed_unit", "kmh");
    p.set("timezone", "GMT"); // UTC days → deterministic cache keys
    if (dataset.forecast) {
      const nowMs = this.deps.now();
      const oldest = Date.parse(`${sorted[0]}T00:00:00Z`);
      const pastDays = Math.min(92, Math.max(1, Math.ceil((nowMs - oldest) / 86_400_000) + 1));
      p.set("past_days", String(pastDays));
      p.set("forecast_days", "1");
    } else {
      p.set("start_date", sorted[0]);
      p.set("end_date", sorted[sorted.length - 1]);
      if (dataset.models) p.set("models", dataset.models);
    }
    return `${dataset.endpoint}?${p.toString()}`;
  }

  /** Normalize the response (single object or array) and split into cell-days. */
  private parse(
    dataset: Dataset,
    cells: Cell[],
    days: string[],
    json: unknown,
  ): CellDayWind[] {
    if (json && typeof json === "object" && (json as { error?: unknown }).error) {
      const reason = String((json as { reason?: unknown }).reason ?? "unknown error");
      throw new WeatherError(`Open-Meteo error: ${reason}`, 400);
    }
    const locations = Array.isArray(json) ? json : [json];
    const wanted = new Set(days);
    const out: CellDayWind[] = [];

    for (let j = 0; j < cells.length; j++) {
      const cell = cells[j];
      const loc = locations[j] as OpenMeteoLocation | undefined;
      const grouped = groupByDay(loc);
      for (const dayISO of days) {
        const hours = grouped.get(dayISO);
        if (!hours || !hasAnyWind(hours)) {
          out.push(negativeEntry(dataset, cell, dayISO, loc));
          continue;
        }
        out.push({
          dataset: dataset.id,
          latIdx: cell.latIdx,
          lonIdx: cell.lonIdx,
          cellLat: loc?.latitude ?? cell.lat,
          cellLon: loc?.longitude ?? cell.lon,
          gridKm: dataset.gridKm,
          dayISO,
          step: hours.speed.length,
          hourly: {
            wind_speed_10m: hours.speed,
            wind_direction_10m: hours.dir,
            wind_gusts_10m: hours.gust,
          },
        });
      }
    }
    void wanted;
    return out;
  }

  // -- rate limiting + retry ------------------------------------------------

  private async request(url: string, onStage?: (msg: string) => void): Promise<Response> {
    let attempt = 0;
    for (;;) {
      await this.gate();
      const resp = await this.deps.fetch(url);
      if (resp.status !== 429 && resp.status < 500) return resp;
      attempt++;
      if (attempt > this.maxRetries) return resp;
      const wait = this.backoffMs(attempt, resp.headers.get("retry-after"));
      onStage?.(`Weather API busy — retrying in ${Math.round(wait / 1000)}s…`);
      await this.deps.sleep(wait);
    }
  }

  /** Wait out the rate limiter (min spacing + rolling per-minute cap). */
  private gate(): Promise<void> {
    const run = this.gateChain.then(async () => {
      const now = this.deps.now();
      this.recent = this.recent.filter((t) => now - t < 60_000);
      let wait = 0;
      if (this.lastStartMs != null)
        wait = Math.max(wait, this.minSpacingMs - (now - this.lastStartMs));
      if (this.recent.length >= this.maxPerMin) {
        wait = Math.max(wait, 60_000 - (now - this.recent[0]));
      }
      if (wait > 0) await this.deps.sleep(wait);
      const started = this.deps.now();
      this.lastStartMs = started;
      this.recent.push(started);
    });
    this.gateChain = run.catch(() => undefined);
    return run;
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    const fromHeader = parseRetryAfter(retryAfter, this.deps.now());
    if (fromHeader != null) return fromHeader;
    const base = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
    return base + Math.random() * base * 0.2; // jitter
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) to ms-from-now. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return null;
}

// -- response helpers -------------------------------------------------------

interface OpenMeteoLocation {
  latitude?: number;
  longitude?: number;
  hourly?: {
    time?: string[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    wind_gusts_10m?: (number | null)[];
  };
}

interface DayHours {
  speed: (number | null)[];
  dir: (number | null)[];
  gust: (number | null)[];
}

/** Bucket a location's flat hourly arrays into per-UTC-day slices keyed "YYYY-MM-DD". */
function groupByDay(loc: OpenMeteoLocation | undefined): Map<string, DayHours> {
  const out = new Map<string, DayHours>();
  const h = loc?.hourly;
  const times = h?.time;
  if (!h || !times) return out;
  for (let i = 0; i < times.length; i++) {
    const day = times[i].slice(0, 10);
    let bucket = out.get(day);
    if (!bucket) {
      bucket = { speed: [], dir: [], gust: [] };
      out.set(day, bucket);
    }
    bucket.speed.push(h.wind_speed_10m?.[i] ?? null);
    bucket.dir.push(h.wind_direction_10m?.[i] ?? null);
    bucket.gust.push(h.wind_gusts_10m?.[i] ?? null);
  }
  return out;
}

function hasAnyWind(h: DayHours): boolean {
  return h.speed.some((v) => v != null) && h.dir.some((v) => v != null);
}

function negativeEntry(
  dataset: Dataset,
  cell: Cell,
  dayISO: string,
  loc: OpenMeteoLocation | undefined,
): CellDayWind {
  return {
    dataset: dataset.id,
    latIdx: cell.latIdx,
    lonIdx: cell.lonIdx,
    cellLat: loc?.latitude ?? cell.lat,
    cellLon: loc?.longitude ?? cell.lon,
    gridKm: dataset.gridKm,
    dayISO,
    step: 0,
    hourly: {},
    noData: true,
  };
}
