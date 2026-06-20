/**
 * In-browser controller — the backend-free equivalent of the Python `server.Backend`.
 *
 * Holds the Store, the JobQueue, and a lazily-connected `RideSource` (the Beeline
 * cloud account). Exposes the same operations the old HTTP API did (state / scan /
 * status / upload / cancel / clear / settings), but as direct method calls. Instead
 * of the UI polling `/api/state`, the controller emits a "change" event whenever
 * anything moves, and the UI re-renders.
 */

import { GpxCache } from "./gpxcache";
import { JobQueue, type JobsSnapshot, type Report, type Task } from "./jobs";
import {
  type RideDetail,
  type RideMetrics,
  rideDatetime,
  rideMonth,
  rideShortLabel,
  rideUid,
  sinceFromPreset,
  splitUid,
  uidDateKey,
} from "./parsing";
import {
  type GpxFile,
  type GpxMode,
  gpxDownloadName,
  gpxFilename,
  type RideSource as RideSourceApi,
  type SourceFactory,
  type SourceKind,
} from "./source";
import {
  monthKey,
  monthLabel,
  type RideRecord,
  type RideSource,
  type Settings,
  type Store,
  type UpsertFields,
} from "./store";
import {
  decodePolyline,
  encodedTrackToGpx,
  extractFullTrack,
  type FullTrack,
  gpxToRoughTrack,
  hasTimes,
  type LatLon,
} from "./track";
import {
  type CellDayWind,
  cellDayKey,
  computeRidePoints,
  type Dataset,
  type DatasetId,
  datasetById,
  OpenMeteo,
  type PointWind,
  pickDatasets,
  quantizeCell,
  type RideWind,
  sampleGridCells,
  summarize,
  type WeatherDeps,
} from "./weather";
import { WindCache } from "./windcache";
import { buildZip, unzip, type ZipEntry } from "./zip";

/** Largest number of grid cells to probe per ride (caps request cost). */
const MAX_WIND_CELLS = 24;

/** Real side-effects for the Open-Meteo client (overridden in tests). */
function defaultWeatherDeps(): WeatherDeps {
  return {
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** ISO-8601 (seconds) timestamp, mirroring the Store's `nowIso`. */
function nowIsoLocal(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Unique UTC calendar days ("YYYY-MM-DD") spanned by a set of epoch-ms times, sorted. */
function uniqueUtcDays(times: number[]): string[] {
  const days = new Set<string>();
  for (const t of times)
    if (Number.isFinite(t)) days.add(new Date(t).toISOString().slice(0, 10));
  return [...days].sort();
}

/** ERA5 reanalysis lags real time by ~5 days; the climatology view ends a touch
 *  earlier so the most-recent days never come back empty. */
const POINT_WIND_LAG_DAYS = 6;
/** Earliest year the point-wind climatology will pull (ERA5 reaches back further,
 *  but this keeps the slider domain and any single fetch sane). */
const POINT_WIND_MIN_YEAR = 1950;
/** Widest year window pulled in one `getPointWind` call (bounds the request count). */
const POINT_WIND_MAX_SPAN = 20;

/** Every UTC calendar day ("YYYY-MM-DD") from `startMs` to `endMs` inclusive. */
function utcDaysBetween(startMs: number, endMs: number): string[] {
  const out: string[] = [];
  const first = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  for (let t = first; t <= endMs; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Fill null gaps in a per-point time series by linear interpolation between known
 *  anchors (ends clamped to the nearest known value), so every point gets an instant. */
function fillTimes(times: (number | null)[]): number[] {
  const n = times.length;
  const out = new Array<number>(n);
  let prevI = -1;
  let prevV = Number.NaN;
  for (let i = 0; i < n; i++) {
    const v = times[i];
    if (v != null && Number.isFinite(v)) {
      if (prevI >= 0 && i - prevI > 1) {
        for (let j = prevI + 1; j < i; j++) {
          out[j] = prevV + ((v - prevV) * (j - prevI)) / (i - prevI);
        }
      } else if (prevI < 0) {
        for (let j = 0; j < i; j++) out[j] = v; // clamp leading nulls
      }
      out[i] = v;
      prevI = i;
      prevV = v;
    }
  }
  for (let j = prevI + 1; j < n; j++) out[j] = prevV; // clamp trailing nulls
  return out;
}

export interface RideView extends RideMetrics {
  key: string;
  /** The bare datetime portion of `key` (for date/month labels). `key` is the
   *  cross-source uid `${source}::${datetime}`; this is the parseable datetime. */
  date_key: string;
  title: string;
  /** Extra location suffix gathered at check time (e.g. ", Amstelveen"); "" when none. */
  location: string;
  status: string;
  track: string;
  /** Lat/lon points read from the downloaded GPX (0 when none captured). */
  track_src_points: number;
  /** Points kept in the rough track after simplification (0 when none). */
  track_points: number;
  /** Length of the source GPX track in kilometres (0 when unknown). */
  track_km: number;
  /** Size of the downloaded GPX file in bytes (0 when unknown). */
  track_bytes: number;
  // The normalized numeric metrics (distance_km, moving_sec, avg_speed_kmh, …;
  // null = unknown) are inherited from RideMetrics. They are the single source of
  // truth for all maths and display — parsed once on the ingestion path, never
  // re-derived from a raw string here. `distance_km` additionally falls back to the
  // measured track length when no reported distance was captured (see state()).
  /** Source label this ride was last scanned from ("" when never recorded). */
  device_model: string;
  /** Which backend this ride came from ("beeline" | "gpx"). Drives the source
   *  filter, the per-ride source badge, and action gating. */
  source: RideSource;
  /** True when this ride's source can push it to Strava (Beeline only). Gates the
   *  per-row Upload action and Strava status chrome. */
  can_upload: boolean;
  month_key: string;
  month_label: string;
  uploaded_at: string;
  deleted: boolean;
  deleted_at: string;
  /** True when the full recorded GPX for this ride is cached on disk (see GpxCache). */
  gpx_cached: boolean;
  /** True when historical wind has been resolved for this ride (summary persisted).
   *  Drives the Wind filter chip (which only appears once rides differ on this). */
  wind_resolved: boolean;
  /** Average wind speed (km/h) for the ride when resolved (null otherwise) — the
   *  number the Wind speed min/max filter bounds against. */
  wind_speed_kmh: number | null;
  /** User-assigned tags (case-insensitive; see tags.ts). Empty when untagged. */
  tags: string[];
}

export interface AppState {
  rides: RideView[];
  jobs: JobsSnapshot;
  settings: Settings;
  connected: boolean;
  device: string;
  /** Which sources are currently connected/registered (drives picker + capability UI). */
  sources: SourceKind[];
}

export type Transport = SourceFactory;

/** A pulled GPX file handed to the UI for download. */
export type GpxListener = (file: GpxFile) => void;

/** The uids of rides just brought in by a successful GPX import. */
export type ImportedListener = (uids: string[]) => void;

export class Controller {
  readonly store: Store;
  readonly jobs: JobQueue;

  /**
   * Connected sources, keyed by kind. Rides from every registered source coexist in
   * one Store (tagged by `source`); actions are dispatched per ride to that ride's
   * source. The Beeline source is connected lazily via `sourceFactory` (it needs
   * sign-in); stateless sources like GPX import are added via `registerSource`.
   */
  private readonly sources = new Map<SourceKind, RideSourceApi>();
  /** The kind connected via `sourceFactory` (Beeline). Drives the legacy `connected`
   *  flag + header label; null when signed out. */
  private primaryKind: SourceKind | null = null;
  private deviceLabel = "";
  private readonly listeners = new Set<() => void>();
  private readonly gpxListeners = new Set<GpxListener>();
  private readonly importedListeners = new Set<ImportedListener>();
  /**
   * Full recorded tracks (real per-point time + elevation), fetched on demand and
   * kept in memory for THIS SESSION ONLY — never persisted. They are ~500 KB each,
   * so caching them across reloads would bloat IndexedDB at the thousands-of-rides
   * scale; a revisit simply re-fetches.
   */
  private readonly fullTracks = new Map<string, FullTrack>();

  /**
   * Per-point wind for a ride, computed at render time from the global wind cache
   * and kept in memory for THIS SESSION ONLY — never persisted (the heavy arrays
   * would bloat the state blob). The small derived summary IS persisted on the ride
   * record (`weather_blob`); these are rebuilt from the cache on demand.
   */
  private readonly rideWinds = new Map<string, (PointWind | null)[]>();
  /** The track geometry each ride's winds were computed on (so the map colours the
   *  exact same points). Parallel to `rideWinds`, session-only. */
  private readonly rideWindGeom = new Map<string, LatLon[]>();
  /** Rides whose wind is currently being resolved (cache recompute or a fetch job),
   *  so a re-render doesn't kick off duplicate work. */
  private readonly windBusy = new Set<string>();
  private readonly windClient: OpenMeteo;

  constructor(
    private readonly sourceFactory: SourceFactory,
    store: Store,
    /**
     * Re-fetchable **cache**: full-GPX downloads for sources that can re-produce them
     * on demand (Beeline's cloud). Safe to flush to reclaim space — anything cleared
     * is simply re-downloaded. Defaults to an ephemeral in-memory one (demo/tests).
     */
    private readonly gpxCache: GpxCache = GpxCache.memory(),
    /**
     * Primary **data**: the original bytes of GPX rides imported from local files —
     * the ONLY copy, not re-fetchable from anywhere. Kept strictly separate from the
     * cache (Android's data-vs-cache split) so a cache flush can NEVER delete it; it
     * goes only when the ride is deleted or on a full reset. Defaults to in-memory.
     */
    private readonly gpxData: GpxCache = GpxCache.memory(),
    /**
     * Global, re-fetchable cache of historical wind keyed by (dataset, grid-cell,
     * day). Shared across every ride — resolving one ride populates cells others
     * reuse for free. Defaults to an ephemeral in-memory one (demo/tests).
     */
    private readonly windCache: WindCache = WindCache.memory(),
    /** Injectable Open-Meteo side-effects (fetch/now/sleep) for tests. */
    weatherDeps: WeatherDeps = defaultWeatherDeps(),
  ) {
    this.store = store;
    this.windClient = new OpenMeteo(weatherDeps);
    this.jobs = new JobQueue(
      (task, report) => this.runTask(task, report),
      () => this.notify(),
    );
  }

  /**
   * The persistent blob store that holds (or should hold) a ride's full GPX, chosen
   * by source: an imported `gpx` ride's original is primary **data** (the gpxData
   * vault — not re-fetchable), while every other source's full GPX is a re-fetchable
   * **cache** entry. Routing every per-ride read/write through here is what keeps
   * imported originals out of the flushable cache.
   */
  private blobFor(uid: string): GpxCache {
    return splitUid(uid).source === "gpx" ? this.gpxData : this.gpxCache;
  }

  // -- change notification ----------------------------------------------

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Subscribe to pulled GPX files (for triggering a browser download). */
  onGpx(fn: GpxListener): () => void {
    this.gpxListeners.add(fn);
    return () => this.gpxListeners.delete(fn);
  }

  private emitGpx(file: GpxFile): void {
    for (const fn of this.gpxListeners) fn(file);
  }

  /** Subscribe to the uids of rides just imported from GPX (for suggesting tags). */
  onImported(fn: ImportedListener): () => void {
    this.importedListeners.add(fn);
    return () => this.importedListeners.delete(fn);
  }

  private emitImported(uids: string[]): void {
    for (const fn of this.importedListeners) fn(uids);
  }

  /**
   * Build a route-only ("light") GPX file for one ride synthesized from its cached
   * polyline — no network, no timestamps/elevation. Returns the file, or null when
   * the ride has no usable cached route. Shared by the light export path and the
   * full-export fallback (when the export gateway is unreachable but we still hold
   * the route).
   */
  private buildCachedLightGpx(uid: string): GpxFile | null {
    const rec = this.store.rides.get(uid);
    if (!rec?.track) return null;
    const title = rec.title || rec.title_base || "";
    const xml = encodedTrackToGpx(rec.track, title || rideShortLabel(rec.key) || rec.key);
    if (!xml) return null;
    return {
      key: uid,
      filename: gpxFilename(uid),
      downloadName: gpxDownloadName(uid, title),
      bytes: new TextEncoder().encode(xml),
    };
  }

  /**
   * Build a FULL GPX file for one ride from the on-disk gzip cache (real per-point
   * time + elevation), or null when it isn't cached. Also rehydrates the in-memory
   * full track so the ride's map shows real data offline. No network — this is the
   * reuse path that lets a re-download/bundle skip re-fetching already-saved rides.
   */
  private async buildCachedFullGpx(uid: string): Promise<GpxFile | null> {
    const bytes = await this.blobFor(uid).get(uid);
    if (!bytes) return null;
    const rec = this.store.rides.get(uid);
    const title = rec ? rec.title || rec.title_base || "" : "";
    if (!this.fullTracks.has(uid)) {
      try {
        this.fullTracks.set(uid, extractFullTrack(new TextDecoder().decode(bytes)));
      } catch {
        // A corrupt cached GPX still downloads fine; only the map upgrade is skipped.
      }
    }
    return {
      key: uid,
      filename: gpxFilename(uid),
      downloadName: gpxDownloadName(uid, title),
      bytes,
    };
  }

  /** The in-memory full track for a ride, or null when not fetched this session. */
  getFullTrack(key: string): FullTrack | null {
    return this.fullTracks.get(key) ?? null;
  }

  /**
   * Rehydrate a ride's FULL recorded track from the persistent GPX cache into the
   * session map, if it's cached and not already loaded. No network — this is what
   * lets the offline map/profile show real time + elevation after a reload (the
   * gzipped GPX survives in IndexedDB even though the parsed in-memory track does
   * not). Returns the track, or null when the ride isn't cached or won't parse.
   */
  async loadCachedFullTrack(key: string): Promise<FullTrack | null> {
    const existing = this.fullTracks.get(key);
    if (existing) return existing;
    const bytes = await this.blobFor(key).get(key);
    if (!bytes) return null;
    try {
      const ft = extractFullTrack(new TextDecoder().decode(bytes));
      this.fullTracks.set(key, ft);
      this.notify();
      return ft;
    } catch {
      return null; // corrupt cached GPX — leave it to a fresh fetch
    }
  }

  /**
   * Fetch (or return the cached) FULL recorded track for one ride — the real ~1 Hz
   * trace with per-point time + elevation. Interactive (not queued): the UI awaits
   * it to upgrade a ride's map. Checks the session map, then the persistent GPX
   * cache (so it works offline), and only then hits the source. Throws when the
   * ride has no recorded track or — when nothing is cached — the source isn't connected.
   */
  async fetchFullTrack(uid: string): Promise<FullTrack> {
    const cached = this.fullTracks.get(uid);
    if (cached) return cached;
    const fromCache = await this.loadCachedFullTrack(uid);
    if (fromCache) return fromCache;
    const { source: kind, dateKey } = splitUid(uid);
    const source = this.requireSource(kind as SourceKind);
    const { track, bytes } = await source.fetchFullTrack(dateKey);
    this.fullTracks.set(uid, track);
    // Persist the full GPX (gzipped) + a rough display track so this interactive
    // fetch survives a reload exactly like the queued download path — otherwise the
    // ride keeps showing as un-cached and offers to fetch again. Best-effort cache
    // write (quota errors surface via the cache's own onError); bytes are read-only.
    void this.blobFor(uid)
      .put(uid, bytes)
      .then((ok) => {
        if (ok) this.notify();
      });
    const rough = gpxToRoughTrack(bytes, this.store.settings.trackPointsPerKm);
    if (rough.polyline) {
      this.store.upsert(uid, {
        ...this.deviceFieldsFor(kind as SourceKind),
        track: rough.polyline,
        track_src_points: rough.srcPoints,
        track_points: rough.keptPoints,
        track_km: rough.km,
        track_bytes: bytes.length,
      });
      this.store.save();
    }
    this.notify();
    return track;
  }

  /**
   * Replace the tag list on one or more rides (the caller passes an already
   * normalized + deduped list per ride; see tags.ts). Local-only metadata, so this
   * is interactive (no JobQueue) and never touches a source. Persists + notifies
   * once if anything changed.
   */
  setRideTags(uids: string[], tagsFor: (uid: string) => string[]): void {
    let changed = false;
    for (const uid of uids) {
      if (this.store.setTags(uid, tagsFor(uid))) changed = true;
    }
    if (changed) {
      this.store.save();
      this.notify();
    }
  }

  /**
   * Per-point samples aligned for wind-vs-speed analytics, or null when the ride's
   * wind isn't resolved (or its track and wind no longer line up). Cache-only —
   * never networks: it reuses this session's per-point wind, recomputing it from the
   * wind cache when needed. `along[i]` is PointWind.alongKmh (+ tailwind, − headwind,
   * already projected onto the heading); `eles[i]` is null when the wind was computed
   * on the rough display polyline (no elevation) rather than the full recorded track.
   * `realTimes` is true only when the FULL recorded track (genuine per-point
   * timestamps) backed the samples — false when times were synthesized from the
   * ride's start + elapsed duration, which makes per-segment speed unreliable.
   */
  async windSamples(key: string): Promise<{
    points: LatLon[];
    times: number[];
    eles: (number | null)[];
    along: (number | null)[];
    cross: (number | null)[];
    realTimes: boolean;
  } | null> {
    const uid = this.normalizeUid(key);
    const rec = this.store.rides.get(uid);
    if (!rec?.weather_fetched_at) return null; // never resolved
    if (!this.rideWinds.has(uid)) await this.recomputeCachedWind(uid, rec); // cache-only
    const winds = this.rideWinds.get(uid);
    if (!winds || winds.length === 0) return null; // noData, or cache was flushed
    const pt = await this.ridePointsAndTimes(uid, rec);
    if (!pt || pt.points.length < 2) return null;
    // The wind was computed on a specific point set; if a different track has since
    // entered memory the indices wouldn't line up — drop the ride rather than risk
    // pairing a point with the wrong wind.
    if (winds.length !== pt.points.length) return null;
    const ft = this.getFullTrack(uid) ?? (await this.loadCachedFullTrack(uid));
    // The full recorded track backs the samples only when it lines up point-for-point
    // with what wind was computed on; then its real timestamps + elevation are valid.
    const usedFull = !!ft && ft.points.length === pt.points.length;
    const eles = usedFull ? ft!.eles : pt.points.map(() => null);
    const realTimes = usedFull && hasTimes(ft!);
    const along = winds.map((w) => (w ? w.alongKmh : null));
    const cross = winds.map((w) => (w ? w.crossKmh : null));
    return { points: pt.points, times: pt.times, eles, along, cross, realTimes };
  }

  /** How many of the given rides have their wind resolved (cheap record-flag read). */
  resolvedWindCount(keys: string[]): number {
    let n = 0;
    for (const k of keys) if (this.hasResolvedWind(k)) n++;
    return n;
  }

  /** When a ride's wind was last resolved (ISO-ish local string), or "" if never.
   *  A cheap plain-field read — useful as a cache-busting version token, since it
   *  changes whenever the ride is re-resolved. */
  weatherFetchedAt(key: string): string {
    return this.store.rides.get(this.normalizeUid(key))?.weather_fetched_at ?? "";
  }

  // -- historical wind ---------------------------------------------------

  /** The persisted wind summary for a ride (provenance + averages), or null. */
  getRideWind(key: string): RideWind | null {
    const rec = this.store.rides.get(this.normalizeUid(key));
    if (!rec?.weather_blob) return null;
    try {
      return JSON.parse(rec.weather_blob) as RideWind;
    } catch {
      return null;
    }
  }

  /** This session's per-point wind for a ride (recomputed from cache), or null when
   *  not yet resolved. Aligned to the ride's track points; nulls where unresolved. */
  getRideWindPoints(key: string): (PointWind | null)[] | null {
    return this.rideWinds.get(this.normalizeUid(key)) ?? null;
  }

  /** The wind overlay for a ride: the geometry plus the per-point wind computed on
   *  it (so the map colours the exact same points), or null until resolved. */
  getRideWindOverlay(key: string): { points: LatLon[]; winds: (PointWind | null)[] } | null {
    const uid = this.normalizeUid(key);
    const winds = this.rideWinds.get(uid);
    const points = this.rideWindGeom.get(uid);
    if (!winds || !points) return null;
    return { points, winds };
  }

  /**
   * Draw a ride's wind from the cache if it was ALREADY resolved — never any
   * network. Safe to call on every ride-detail render: it only recomputes the
   * per-point overlay for rides that already carry a persisted summary. Actually
   * *resolving* (fetching) wind is an explicit user action — see `resolveWind`.
   */
  showCachedWind(key: string): void {
    const uid = this.normalizeUid(key);
    if (this.rideWinds.has(uid) || this.windBusy.has(uid)) return;
    const rec = this.store.rides.get(uid);
    if (!rec?.weather_blob) return; // never resolved → wait for the explicit action
    void this.recomputeCachedWind(uid, rec);
  }

  /** True when an explicit wind resolution is queued/running for this ride. */
  isResolvingWind(key: string): boolean {
    return this.windBusy.has(this.normalizeUid(key));
  }

  /** True when a ride has had its wind resolved (cached summary persisted). */
  hasResolvedWind(key: string): boolean {
    return !!this.store.rides.get(this.normalizeUid(key))?.weather_fetched_at;
  }

  /**
   * Explicitly resolve historical wind for one or more rides (the networked action,
   * triggered by a user — per-ride or over a selection). Cache-first per cell, so
   * already-resolved or overlapping rides cost little or nothing; all keys ride one
   * coalesced `fetch-weather` job. Rides without a track are skipped. Returns the
   * number actually queued. Pass `force` to re-resolve already-cached rides.
   */
  resolveWind(keys: string[], force = false): number {
    const uids = keys
      .map((k) => this.normalizeUid(k))
      .filter((uid) => {
        const rec = this.store.rides.get(uid);
        if (!rec?.track) return false;
        if (this.windBusy.has(uid)) return false;
        if (!force && rec.weather_fetched_at) return false; // already resolved
        return true;
      });
    if (uids.length === 0) return 0;
    for (const uid of uids) this.windBusy.add(uid);
    const first = rideShortLabel(uidDateKey(uids[0])) || uids[0];
    this.jobs.submit("fetch-weather", {
      label:
        uids.length === 1
          ? `Resolving wind for ${first}`
          : `Resolving wind for ${uids.length} rides`,
      keys: uids,
      payload: { force },
    });
    return uids.length;
  }

  /** Total compressed size of the global wind cache, for the settings size hint. */
  windCacheBytes(): number {
    return this.windCache.totalBytes();
  }

  /** Number of cached (cell, day) wind entries. */
  windCacheCount(): number {
    return this.windCache.count;
  }

  /** Flush the global wind cache (re-fetchable). Clears this session's per-point
   *  wind too so maps re-resolve; persisted summaries stay until a ride re-resolves. */
  async flushWindCache(): Promise<void> {
    await this.windCache.flush();
    this.rideWinds.clear();
    this.rideWindGeom.clear();
    this.notify();
  }

  /**
   * Pull historical wind for a single point over an inclusive [startYear, endYear]
   * window from the ERA5 reanalysis — the only model spanning decades, so the grid
   * stays consistent across the whole period. Powers the Windalytics climatology view.
   *
   * One archive request per calendar year that isn't already fully cached (each
   * returns the whole year as hourly arrays); everything lands in the shared wind
   * cache, so re-opening a point — or sliding the year window — only fetches the new
   * years. The window is clamped to [1950, this year] and capped at 20 years. Returns
   * the grid cell that served the point and every cached cell-day in range, oldest
   * first, for the view to aggregate entirely in memory.
   */
  async getPointWind(
    lat: number,
    lon: number,
    startYear: number,
    endYear: number,
    onStage?: (msg: string) => void,
  ): Promise<{ cell: { lat: number; lon: number; gridKm: number }; days: CellDayWind[] }> {
    const dataset = datasetById("era5");
    const cell = quantizeCell(lat, lon, dataset);
    const nowYear = new Date().getUTCFullYear();
    const hi = Math.min(nowYear, Math.round(endYear));
    let lo = Math.max(POINT_WIND_MIN_YEAR, Math.round(startYear));
    if (lo > hi) lo = hi;
    if (hi - lo + 1 > POINT_WIND_MAX_SPAN) lo = hi - (POINT_WIND_MAX_SPAN - 1);
    // ERA5 lags real time by several days; the current year ends a touch earlier.
    const endMs = Math.min(
      Date.now() - POINT_WIND_LAG_DAYS * 86_400_000,
      Date.UTC(hi, 11, 31),
    );
    const startMs = Date.UTC(lo, 0, 1);

    const out: CellDayWind[] = [];
    const keyFor = (d: string): string => cellDayKey(dataset.id, cell.latIdx, cell.lonIdx, d);

    for (let y = lo; y <= hi; y++) {
      const chunkStart = Math.max(startMs, Date.UTC(y, 0, 1));
      const chunkEnd = Math.min(endMs, Date.UTC(y, 11, 31));
      if (chunkEnd < chunkStart) continue;
      const chunkDays = utcDaysBetween(chunkStart, chunkEnd);
      if (chunkDays.length === 0) continue;

      const missing = chunkDays.some((d) => !this.windCache.has(keyFor(d)));
      if (missing) {
        onStage?.(`Fetching ${y} wind from Open-Meteo · ERA5…`);
        const entries = await this.windClient.fetchWindMulti(
          dataset,
          [cell],
          chunkDays,
          onStage,
        );
        await this.windCache.putMany(entries);
        for (const e of entries) out.push(e);
      } else {
        for (const d of chunkDays) {
          const e = await this.windCache.get(keyFor(d));
          if (e) out.push(e);
        }
      }
    }
    return { cell: { lat: cell.lat, lon: cell.lon, gridKm: dataset.gridKm }, days: out };
  }

  /** Recompute a ride's per-point wind from the cache for display — no network. If
   *  the cache was flushed since it was resolved, the overlay simply stays absent
   *  (the summary badge still shows); the user can re-resolve to redraw it. */
  private async recomputeCachedWind(uid: string, rec: RideRecord): Promise<void> {
    try {
      const summary = JSON.parse(rec.weather_blob!) as RideWind;
      if (summary.noData) {
        this.rideWinds.set(uid, []);
        this.rideWindGeom.set(uid, []);
        this.notify();
        return;
      }
      if (await this.tryComputeFromCache(uid, rec, datasetById(summary.dataset))) {
        this.notify();
      }
    } catch {
      /* corrupt summary — leave it; an explicit re-resolve will fix it */
    }
  }

  /** Job runner: resolve wind for each ride, releasing the busy flag as it goes.
   *  Cancellation-aware: `report()` returns true once Stop is pressed, so we finish
   *  the ride in flight, then stop — every ride resolved so far is already persisted
   *  (resolveRideWind saves per ride), so progress is preserved and nothing is lost.
   *  The remaining rides' busy flags are released so they can be resolved again later. */
  private async doFetchWeather(task: Task, report: Report): Promise<void> {
    const uids = task.keys;
    const force = task.payload.force === true;
    task.progress = { done: 0, total: uids.length };
    let i = 0;
    for (; i < uids.length; i++) {
      const uid = uids[i];
      const rec = this.store.rides.get(uid);
      const label = rec ? rideShortLabel(rec.key) || rec.key : uid;
      // Cancellation is checked BETWEEN rides (one ride ≈ one quick request). `report`
      // returns true once Stop is pressed; bail before starting this ride's network
      // work. Everything resolved so far is already persisted (resolveRideWind saves
      // per ride), so progress is preserved and nothing is lost.
      if (report(`Resolving wind for ${label}…`)) break;
      try {
        await this.resolveRideWind(uid, report, force);
      } catch (err) {
        report(`Wind lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      } finally {
        this.windBusy.delete(uid);
        if (task.progress) task.progress.done++;
      }
    }
    // Stopped early — free the busy flag on this ride and every one we never got to,
    // so the user can resolve them later (and a re-render doesn't think they're still
    // in flight).
    for (; i < uids.length; i++) this.windBusy.delete(uids[i]);
  }

  /**
   * Resolve one ride's wind: sample the track into grid cells, fetch only the cells
   * the global cache is missing (one multi-coordinate request per dataset), then
   * compute per-point head/tailwind and persist the small summary. Tries the
   * finest dataset for the ride's place/era first and falls back down the chain.
   */
  private async resolveRideWind(uid: string, report: Report, force = false): Promise<void> {
    const rec = this.store.rides.get(uid);
    if (!rec) return;
    report(`Reading track for ${rideShortLabel(rec.key) || rec.key}…`);
    const pt = await this.ridePointsAndTimes(uid, rec);
    if (!pt || pt.points.length < 2) {
      this.markRideWindEmpty(uid, "era5");
      return;
    }
    const { points, times } = pt;
    const startMs = times.find((t) => Number.isFinite(t)) ?? Date.now();
    const candidates = pickDatasets(points[0][0], points[0][1], startMs, Date.now());
    const days = uniqueUtcDays(times);

    // Cell-days fetched this run, kept in memory so the result is computed from them
    // directly — independent of whether the persistent cache write succeeds.
    const freshEntries = new Map<string, CellDayWind>();

    for (const dataset of candidates) {
      const cells = sampleGridCells(points, dataset, MAX_WIND_CELLS);
      report(
        `Sampling ${cells.length} wind cell${cells.length === 1 ? "" : "s"} along the route…`,
      );
      // A forced refresh re-fetches every cell; otherwise only the cache gaps.
      const missingCells = force
        ? cells
        : cells.filter((c) =>
            days.some(
              (d) => !this.windCache.has(cellDayKey(dataset.id, c.latIdx, c.lonIdx, d)),
            ),
          );
      if (missingCells.length > 0) {
        report(
          `Fetching wind from Open-Meteo · ${dataset.label} · ` +
            `${missingCells.length} of ${cells.length} cell${cells.length === 1 ? "" : "s"} ` +
            `(${days.length} day${days.length === 1 ? "" : "s"})…`,
        );
        const entries = await this.windClient.fetchWindMulti(
          dataset,
          missingCells,
          days,
          report,
        );
        // Compute from the data we JUST fetched (merged with any cache hits) so the
        // result NEVER depends on the cache write succeeding — caching is only an
        // optimization for next time. A failed write degrades to "re-fetch later",
        // not "no wind at all". Persisting is best-effort and fire-and-forget.
        for (const e of entries)
          freshEntries.set(cellDayKey(e.dataset, e.latIdx, e.lonIdx, e.dayISO), e);
        void this.windCache.putMany(entries);
      } else {
        report(`Wind already cached (${dataset.label}) — drawing…`);
      }
      const { lookup, centers } = await this.buildLookup(dataset, cells, days, freshEntries);
      const pw = computeRidePoints(points, times, lookup, dataset);
      if (pw.some((p) => p != null)) {
        this.rideWinds.set(uid, pw);
        this.rideWindGeom.set(uid, points);
        const summary = summarize(pw, { dataset, cells: centers, fetchedAt: nowIsoLocal() });
        this.store.upsert(uid, {
          weather_blob: JSON.stringify(summary),
          weather_fetched_at: summary.fetchedAt,
          weather_speed_kmh: summary.avgSpeedKmh,
        });
        this.store.save();
        return;
      }
      report(`${dataset.label} returned no wind here — trying a coarser model…`);
    }
    // Every candidate came back empty (recency lag, ocean, data gap).
    this.markRideWindEmpty(uid, candidates[0]?.id ?? "era5");
  }

  /** Cache-only recompute (no network). Returns false when the cache lacks a needed
   *  cell-day (e.g. it was flushed), so the caller falls back to a fetch job. */
  private async tryComputeFromCache(
    uid: string,
    rec: RideRecord,
    dataset: Dataset,
  ): Promise<boolean> {
    const pt = await this.ridePointsAndTimes(uid, rec);
    if (!pt || pt.points.length < 2) {
      this.rideWinds.set(uid, []);
      this.rideWindGeom.set(uid, []);
      return true;
    }
    const cells = sampleGridCells(pt.points, dataset, MAX_WIND_CELLS);
    const days = uniqueUtcDays(pt.times);
    const needed = cells.flatMap((c) =>
      days.map((d) => cellDayKey(dataset.id, c.latIdx, c.lonIdx, d)),
    );
    if (this.windCache.missingKeys(needed).length > 0) return false;
    const { lookup } = await this.buildLookup(dataset, cells, days);
    this.rideWinds.set(uid, computeRidePoints(pt.points, pt.times, lookup, dataset));
    this.rideWindGeom.set(uid, pt.points);
    return true;
  }

  /** Build a cell-day lookup for a ride, preferring in-memory `fresh` entries (just
   *  fetched this run) and falling back to the persistent cache. Decoupling the
   *  result from the cache write is what keeps wind working when caching fails. */
  private async buildLookup(
    dataset: Dataset,
    cells: { latIdx: number; lonIdx: number }[],
    days: string[],
    fresh?: Map<string, CellDayWind>,
  ): Promise<{
    lookup: (latIdx: number, lonIdx: number, day: string) => CellDayWind | null;
    centers: { lat: number; lon: number }[];
  }> {
    const map = new Map<string, CellDayWind>();
    const centers: { lat: number; lon: number }[] = [];
    for (const c of cells) {
      for (const day of days) {
        const key = cellDayKey(dataset.id, c.latIdx, c.lonIdx, day);
        const entry = fresh?.get(key) ?? (await this.windCache.get(key));
        if (entry) {
          map.set(key, entry);
          if (!entry.noData) centers.push({ lat: entry.cellLat, lon: entry.cellLon });
        }
      }
    }
    const lookup = (latIdx: number, lonIdx: number, day: string): CellDayWind | null =>
      map.get(cellDayKey(dataset.id, latIdx, lonIdx, day)) ?? null;
    return { lookup, centers };
  }

  /** Record that a ride has no resolvable wind (negative cache) so it isn't retried. */
  private markRideWindEmpty(uid: string, dataset: DatasetId): void {
    this.rideWinds.set(uid, []);
    this.rideWindGeom.set(uid, []);
    const ds = datasetById(dataset);
    const summary: RideWind = {
      fetchedAt: nowIsoLocal(),
      dataset,
      datasetLabel: ds.label,
      gridKm: ds.gridKm,
      cellCount: 0,
      usedForecast: ds.forecast,
      cells: [],
      avgAlongKmh: 0,
      pctTailwind: 0,
      prevailingFromDeg: 0,
      avgSpeedKmh: 0,
      avgGustKmh: 0,
      noData: true,
    };
    this.store.upsert(uid, {
      weather_blob: JSON.stringify(summary),
      weather_fetched_at: summary.fetchedAt,
      weather_speed_kmh: 0,
    });
    this.store.save();
  }

  /**
   * The ride's track points and per-point epoch-ms times for wind sampling. Prefers
   * the FULL recorded track (real per-point times) when it's already in memory or
   * the GPX cache; otherwise falls back to the rough polyline with times synthesized
   * from the ride's start + elapsed duration (so it works without a GPX download).
   */
  private async ridePointsAndTimes(
    uid: string,
    rec: RideRecord,
  ): Promise<{ points: LatLon[]; times: number[] } | null> {
    let ft = this.getFullTrack(uid);
    if (!ft) ft = await this.loadCachedFullTrack(uid);
    if (ft && ft.points.length >= 2 && hasTimes(ft)) {
      return { points: ft.points, times: fillTimes(ft.times) };
    }
    if (!rec.track) return null;
    let points: LatLon[];
    try {
      points = decodePolyline(rec.track);
    } catch {
      return null;
    }
    if (points.length < 2) return null;
    const start = rideDatetime(rec.key);
    const startMs = start ? start.getTime() : Date.now();
    const elapsedSec =
      rec.elapsed_sec ??
      rec.moving_sec ??
      (rec.distance_km && rec.avg_speed_kmh
        ? (rec.distance_km / rec.avg_speed_kmh) * 3600
        : 3600);
    const times = new Array<number>(points.length);
    for (let i = 0; i < points.length; i++) {
      times[i] = startMs + (elapsedSec * 1000 * i) / (points.length - 1);
    }
    return { points, times };
  }

  // -- connection / source registry --------------------------------------

  /** True when the Beeline source (connected via `sourceFactory`) is signed in. */
  get connected(): boolean {
    return this.primaryKind !== null;
  }

  /** Connect the Beeline source and register it for dispatch. Uses the given factory
   *  when provided (sign-in supplies fresh credentials), else the constructor one. */
  async connect(factory?: SourceFactory): Promise<void> {
    if (this.primaryKind !== null) return;
    const source = await (factory ?? this.sourceFactory)();
    this.sources.set(source.kind, source);
    this.primaryKind = source.kind;
    this.deviceLabel = source.label();
    this.notify();
  }

  async disconnect(): Promise<void> {
    if (this.primaryKind !== null) {
      const source = this.sources.get(this.primaryKind);
      if (source) await source.close();
      this.sources.delete(this.primaryKind);
    }
    this.primaryKind = null;
    this.deviceLabel = "";
    this.notify();
  }

  /** Register an additional, already-connected source (e.g. the stateless GPX
   *  import source). Its rides coexist with every other source's in one Store. */
  registerSource(source: RideSourceApi): void {
    this.sources.set(source.kind, source);
    this.notify();
  }

  /** True when a source of the given kind is currently registered. */
  hasSource(kind: SourceKind): boolean {
    return this.sources.has(kind);
  }

  /** The registered source for a kind, or throw a clear, source-specific error. */
  private requireSource(kind: SourceKind): RideSourceApi {
    const source = this.sources.get(kind);
    if (!source) {
      throw new Error(
        kind === "beeline" ? "Not connected — sign in first." : `No ${kind} source available.`,
      );
    }
    return source;
  }

  /**
   * Per-ride attribution stamped onto every record we write for a given source, so
   * the cache records which source the info came from. Empty fields are omitted so
   * they never overwrite a known value.
   */
  private deviceFieldsFor(kind: SourceKind): UpsertFields {
    return this.sources.get(kind)?.deviceFields() ?? {};
  }

  /** Whether a ride from this source can be pushed to Strava (capability, not
   *  connection — the action itself re-auths if needed). */
  private canUpload(source: RideSource): boolean {
    return this.sources.get(source)?.capabilities.upload ?? source === "beeline";
  }

  /** Group ride uids by their source kind, mapping each to its bare datetime key
   *  (the per-source namespace the seam speaks). */
  private groupBySource(uids: string[]): Map<SourceKind, string[]> {
    const groups = new Map<SourceKind, string[]>();
    for (const uid of uids) {
      const { source, dateKey } = splitUid(uid);
      const kind = source as SourceKind;
      const list = groups.get(kind) ?? [];
      list.push(dateKey);
      groups.set(kind, list);
    }
    return groups;
  }

  /** Normalize an incoming ride identity: a bare datetime key (legacy / single-source
   *  callers) is treated as a Beeline uid; a real uid passes through. */
  private normalizeUid(key: string): string {
    return key.includes("::") ? key : rideUid("beeline", key);
  }

  // -- state for the UI --------------------------------------------------

  state(): AppState {
    const records = [...this.store.rides.values()].sort((a, b) => a.key.localeCompare(b.key));
    const rides: RideView[] = records.map((r) => {
      // The cross-source identity is the (source, datetime) uid; `r.key` is the bare
      // datetime kept for date/month bucketing.
      const uid = rideUid(r.source, r.key);
      // Split the fuller checked title into the scan name + colored location suffix.
      const base = r.title_base;
      const full = r.title;
      const hasSuffix = base !== "" && full.startsWith(base) && full.length > base.length;
      // The metrics are already normalized numbers on the record; copy them as-is.
      // Distance additionally falls back to the measured track length when no
      // reported distance was ever captured, so a GPX-only ride still shows a size.
      const distance_km =
        r.distance_km != null && r.distance_km > 0
          ? r.distance_km
          : r.track_km > 0
            ? r.track_km
            : null;
      return {
        key: uid,
        date_key: r.key,
        title: hasSuffix ? base : full,
        location: hasSuffix ? full.slice(base.length) : "",
        status: r.strava_status,
        track: r.track,
        track_src_points: r.track_src_points,
        track_points: r.track_points,
        track_km: r.track_km,
        track_bytes: r.track_bytes,
        distance_km,
        moving_sec: r.moving_sec,
        elapsed_sec: r.elapsed_sec,
        avg_speed_kmh: r.avg_speed_kmh,
        max_speed_kmh: r.max_speed_kmh,
        elevation_gain_m: r.elevation_gain_m,
        elevation_loss_m: r.elevation_loss_m,
        device_model: r.device_model,
        source: r.source,
        can_upload: this.canUpload(r.source),
        month_key: monthKey(r),
        month_label: monthLabel(r),
        uploaded_at: r.uploaded_at,
        deleted: r.deleted,
        deleted_at: r.deleted_at,
        // Full GPX present locally — in the cache (Beeline) OR the data vault (import).
        gpx_cached: this.blobFor(uid).has(uid),
        // Historical wind resolved (summary persisted) — gates the Wind filter chip.
        wind_resolved: !!r.weather_fetched_at,
        wind_speed_kmh:
          typeof r.weather_speed_kmh === "number" && r.weather_speed_kmh > 0
            ? r.weather_speed_kmh
            : null,
        tags: [...(r.tags ?? [])],
      };
    });
    return {
      rides,
      jobs: this.jobs.snapshot(),
      settings: { ...this.store.settings },
      connected: this.connected,
      device: this.deviceLabel,
      sources: [...this.sources.keys()],
    };
  }

  // -- task dispatch (runs on the queue worker) --------------------------

  private async runTask(task: Task, report: Report): Promise<void> {
    if (task.kind === "scan") await this.doScan(task, report);
    else if (task.kind === "import") await this.doImport(task, report);
    else if (task.kind === "upload") await this.doUpload(task, report);
    else if (task.kind === "download-gpx") await this.doDownloadGpx(task, report);
    else if (task.kind === "rename") await this.doRename(task, report);
    else if (task.kind === "delete") await this.doDelete(task, report);
    else if (task.kind === "fetch-weather") await this.doFetchWeather(task, report);
  }

  private async doScan(task: Task, report: Report): Promise<void> {
    const preset = (task.payload.preset as string) ?? "all";
    const days = (task.payload.days as number | null) ?? null;
    const since = sinceFromPreset(preset, days);
    const label = preset !== "custom" ? preset : `last ${days}d`;
    // Scanning is a Beeline concept (enumerate the cloud account); the GPX source
    // is populated by import, not scan.
    const kind: SourceKind = "beeline";
    const source = this.requireSource(kind);
    let cancelled = false;
    const rep = (msg: string): boolean => {
      const c = report(msg);
      if (c) cancelled = true;
      return c;
    };
    rep(`scanning (${label})…`);
    const seen = new Set<string>();
    const { cards, complete } = await source.enumerateCatalog(rep, since, (fresh) => {
      // Persist and surface each page of rides the moment they are found.
      for (const c of fresh) {
        const uid = rideUid(kind, c.key);
        seen.add(uid);
        this.store.upsert(uid, {
          ...this.deviceFieldsFor(kind),
          title_base: c.title,
          distance_km: c.distance_km,
          elapsed_sec: c.elapsed_sec,
          // A source may already know the full record at scan time (Beeline fetches
          // track + stats + Strava status in one request); merge those when present.
          ...(c.fields ?? {}),
        });
      }
      this.store.save();
      this.notify();
    });
    // A scan reads the COMPLETE list for its window, so any ride we knew about
    // within that window but did not see has been deleted from the source. Only
    // reconcile when the scan both ran to completion AND was verified to have read
    // the list end-to-end (`complete`). A cancelled scan is partial, and an
    // incomplete scan is unreliable — in either case treating unseen rides as
    // deleted would be wrong. Only THIS source's rides are reconciled — a Beeline
    // scan must never tombstone an imported GPX ride.
    let removed = 0;
    if (!cancelled && complete) {
      for (const r of this.store.rides.values()) {
        if (r.source !== kind) continue;
        const uid = rideUid(r.source, r.key);
        if (r.deleted || seen.has(uid)) continue;
        const dt = rideDatetime(r.key);
        if (dt === null) continue; // can't place it in the window — leave it be
        if (since !== null && dt < since) continue; // outside the scanned window
        if (this.store.markDeleted(uid)) removed++;
      }
      if (removed) {
        this.store.save();
        this.notify();
      }
    }
    const suffix = removed ? `, ${removed} deleted` : "";
    report(`scan done (${label}): ${cards.length} rides${suffix}`);
  }

  /**
   * Import user-supplied GPX files into the cache as `gpx`-source rides. Streams
   * each parsed ride into the Store as it's read (mirrors a scan's persistence),
   * but never reconciles deletions — an import only ADDS rides. The original GPX
   * bytes are stashed in the GPX cache by the source so a later full export / map
   * upgrade is served locally.
   */
  private async doImport(task: Task, report: Report): Promise<void> {
    const kind: SourceKind = "gpx";
    const source = this.requireSource(kind);
    if (!source.importFiles) throw new Error("This source does not support importing files.");
    const files = (task.payload.files as File[]) ?? [];
    task.progress = { done: 0, total: files.length };
    let added = 0;
    const importedUids: string[] = [];
    const result = await source.importFiles(
      files,
      (card) => {
        const uid = rideUid(kind, card.key);
        this.store.upsert(uid, {
          ...this.deviceFieldsFor(kind),
          title_base: card.title,
          distance_km: card.distance_km,
          elapsed_sec: card.elapsed_sec,
          ...(card.fields ?? {}),
        });
        this.store.save();
        this.notify();
        importedUids.push(uid);
        added++;
        if (task.progress) task.progress.done++;
      },
      (msg) => report(msg),
    );
    const skipped = result.skipped ?? [];
    const suffix = skipped.length ? `, ${skipped.length} skipped` : "";
    report(`imported ${added} ride${added === 1 ? "" : "s"}${suffix}`);
    // Tell the UI which rides came in so it can offer to tag them — emit BEFORE the
    // skipped-files throw so a partial import still surfaces the suggestion.
    if (importedUids.length) this.emitImported(importedUids);
    if (skipped.length) {
      const header = `${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped:`;
      throw new Error([header, ...skipped.map((s) => `  • ${s}`)].join("\n"));
    }
  }

  private async doUpload(task: Task, report: Report): Promise<void> {
    let uploaded = 0;
    let removed = 0;
    let processed = 0;
    const failures: string[] = [];
    // Seed live progress so the queue panel shows "0 of N" the moment work starts.
    task.progress = { done: 0, total: task.keys.length };

    // Group the selected rides by source. Only upload-capable sources (Beeline) run;
    // rides from any other source are reported as skipped so a mixed selection does
    // the right thing instead of silently dropping or erroring on GPX rides.
    const groups = this.groupBySource(task.keys);
    const skipped: string[] = [];
    for (const [kind, dateKeys] of groups) {
      const source = this.sources.get(kind);
      if (!source?.capabilities.upload) {
        for (const dk of dateKeys) skipped.push(rideShortLabel(dk) || dk);
        if (task.progress) task.progress.done += dateKeys.length;
        continue;
      }
      const details = await source.processTargets(
        new Set(dateKeys),
        (msg) => report(msg),
        (d) => {
          // Persist and surface each ride's status the moment it is read/uploaded.
          this.persistDetail(d, kind);
          if (d.stravaStatus === "uploaded") uploaded++;
          if (task.progress) task.progress.done++;
        },
        (missing) => {
          // Searched the whole list and never found these → deleted from the source.
          for (const dk of missing) if (this.store.markDeleted(rideUid(kind, dk))) removed++;
          if (removed) {
            this.store.save();
            this.notify();
          }
        },
        (dk, reason) => {
          // One ride threw mid-sweep: it was isolated and skipped so the rest still
          // ran. Collect it and surface every failure as one persistent error below.
          failures.push(`${rideShortLabel(dk) || dk}: ${reason}`);
          if (task.progress) task.progress.done++;
        },
      );
      processed += details.length;
    }

    const delSuffix = removed ? `, ${removed} deleted` : "";
    const skipSuffix = skipped.length
      ? `, ${skipped.length} skipped (only Beeline rides upload to Strava)`
      : "";
    report(
      `done: ${uploaded} now on Strava (${processed} processed)${delSuffix}${skipSuffix}`,
    );

    if (failures.length) {
      // Fail the task so the UI shows a persistent, acknowledgeable error with full
      // per-ride detail — not a status message that just blinks past. The rides that
      // did succeed are already persisted above; this only reports the ones that didn't.
      const header = `${failures.length} of ${task.keys.length} ride${
        task.keys.length === 1 ? "" : "s"
      } failed to upload (${processed} succeeded):`;
      throw new Error([header, ...failures.map((f) => `  • ${f}`)].join("\n"));
    }
  }

  /**
   * Persist a freshly read ride detail (title, Strava status, metrics) and surface
   * it. The detail's normalized numbers flow straight in via upsert, which only
   * overwrites a metric when the new figure is known — so a Check fills in the
   * fuller stats without clobbering anything an earlier pass already captured.
   * `kind` is the source the detail came from, used to build the cross-source uid.
   *
   * The detail's `title` is the BASE name (no place suffix), so it is written to
   * `title_base` — NOT the display `title`. Writing it to `title` would overwrite
   * the stored "base, place" title and silently drop the ride's destination suffix
   * until a full re-sync rebuilt it (the bug this guards against).
   */
  private persistDetail(d: RideDetail, kind: SourceKind): void {
    this.store.upsert(rideUid(kind, d.key), {
      ...this.deviceFieldsFor(kind),
      title_base: d.title,
      strava_status: d.stravaStatus,
      ...d.metrics,
    });
    this.store.save();
    this.notify();
  }

  private async doDownloadGpx(task: Task, report: Report): Promise<void> {
    // Export each ride's route as a GPX file handed to the UI to write to disk.
    let removed = 0;
    let succeeded = 0;
    const failures: string[] = [];
    // Rides whose full export was unreachable but that carry a cached route, so we
    // can still hand the user a route-only GPX instead of failing outright.
    const degraded: string[] = [];
    const mode: GpxMode = (task.payload.mode as GpxMode) ?? "light";
    // Whether the produced files are handed to the browser to save. When false
    // (the "Fetch full GPX" action), the full sweep still runs — fetching, parsing
    // the real track into the session map, and caching the gzipped GPX — but NO file
    // is written to disk. This pre-warms the offline cache for the selected rides
    // without spawning a download. Only meaningful in full mode (light GPX is
    // synthesized locally and has nothing to cache).
    const save = task.payload.save !== false;
    // Seed live progress so the queue panel shows "0 of N" while the sweep runs.
    task.progress = { done: 0, total: task.keys.length };

    // Accumulate every produced file here instead of emitting them one-by-one. A
    // single file is delivered as a plain GPX; more than one is bundled into a
    // single .zip below — browsers throttle and silently DROP rapid programmatic
    // downloads, so firing one `<a download>` per ride loses most of a large
    // selection (e.g. a whole year). One archive is one reliable download.
    // In fetch-only (save === false) mode nothing is delivered, so we never retain
    // bytes here — important at the thousands-of-rides scale.
    const bundle: GpxFile[] = [];

    // In LIGHT mode, rides that already carry their route in the cache can be
    // exported entirely locally — no device, no network, no sign-in — regardless of
    // source. Split those out and synthesize their GPX from the stored track; only
    // the rest need a source. In FULL mode every ride must be fetched from the cloud
    // render, EXCEPT rides whose full GPX we already downloaded once and cached on
    // disk (Beeline) or stored at import (GPX) — those are served straight from the
    // gzip cache (instant, offline), so only the rest hit a source.
    const remote: string[] = [];
    if (mode === "full") {
      for (const uid of task.keys) {
        // Fetch-only: a ride already cached locally needs no work at all — count it
        // done without reading/gunzipping the blob.
        if (!save && this.blobFor(uid).has(uid)) {
          succeeded++;
          if (task.progress) task.progress.done++;
          continue;
        }
        const file = save ? await this.buildCachedFullGpx(uid) : null;
        if (file) {
          bundle.push(file);
          succeeded++;
          if (task.progress) task.progress.done++;
        } else {
          remote.push(uid);
        }
      }
    } else {
      for (const uid of task.keys) {
        const rec = this.store.rides.get(uid);
        if (rec?.track) {
          const file = this.buildCachedLightGpx(uid);
          if (file) {
            bundle.push(file);
            succeeded++;
          } else {
            failures.push(
              `${rideShortLabel(uidDateKey(uid)) || uid}: no route track to export`,
            );
          }
          if (task.progress) task.progress.done++;
        } else {
          remote.push(uid);
        }
      }
    }

    // Only touch a source for rides that still need a real download (rides without a
    // cached full track). Group the remainder by source so each ride is fetched from
    // its own backend; when every requested ride was handled locally, no source is
    // touched — so no spurious "Not connected" in an offline mode.
    if (remote.length) {
      for (const [kind, dateKeys] of this.groupBySource(remote)) {
        const source = this.requireSource(kind);
        const files = await source.downloadGpx(
          new Set(dateKeys),
          (msg) => report(msg),
          (file) => {
            const uid = rideUid(kind, file.key);
            // Keep only a rough, compressed sketch of the route in the cache — never the
            // full GPX. In full mode we ALSO parse the real track into the in-memory
            // session cache so the ride's map can use its real time + elevation at once.
            if (mode === "full") {
              try {
                this.fullTracks.set(
                  uid,
                  extractFullTrack(new TextDecoder().decode(file.bytes)),
                );
              } catch {
                // A malformed GPX shouldn't sink the download; the rough sketch below
                // still drives the display map.
              }
              // Persist the full GPX (gzipped) so a later save/bundle of this ride is
              // instant and works offline. Fire-and-forget: caching is best-effort and
              // must never delay or fail the download itself (quota errors surface via
              // the cache's own onError). The bytes are only read, never mutated. A
              // remote download is always a re-fetchable source, so this is the cache.
              void this.blobFor(uid)
                .put(uid, file.bytes)
                .then((ok) => {
                  if (ok) this.notify();
                });
            }
            const rough = gpxToRoughTrack(file.bytes, this.store.settings.trackPointsPerKm);
            if (rough.polyline) {
              this.store.upsert(uid, {
                ...this.deviceFieldsFor(kind),
                track: rough.polyline,
                track_src_points: rough.srcPoints,
                track_points: rough.keptPoints,
                track_km: rough.km,
                track_bytes: file.bytes.length,
              });
              this.store.save();
              this.notify();
            } else {
              // We pulled the file but couldn't read a GPS track out of it. Don't store a
              // bogus empty track; record it so the task surfaces a real, persistent error.
              failures.push(
                `${rideShortLabel(file.key) || file.key}: couldn't extract a GPS track from the downloaded GPX`,
              );
            }
            // Only retain bytes for delivery when actually saving; fetch-only has
            // already cached them above and discards the bytes here. Re-key the file
            // to its cross-source uid so the bundle's identities are uniform.
            if (save) bundle.push({ ...file, key: uid });
            if (task.progress) task.progress.done++;
          },
          (missing) => {
            for (const dk of missing) if (this.store.markDeleted(rideUid(kind, dk))) removed++;
            if (removed) {
              this.store.save();
              this.notify();
            }
          },
          (dk, reason, retryable) => {
            // When the full export gateway is unreachable but the ride still carries a
            // cached route, hand the user a route-only GPX instead of failing — so a
            // gateway outage mid-batch never breaks the download. Genuine "no track"
            // failures (not retryable) stay real errors. Skipped in fetch-only mode:
            // there's no file to hand over and a route-only sketch is nothing to cache,
            // so an unreachable full export is reported as a real failure instead.
            if (save && mode === "full" && retryable) {
              const fallback = this.buildCachedLightGpx(rideUid(kind, dk));
              if (fallback) {
                bundle.push(fallback);
                succeeded++;
                degraded.push(rideShortLabel(dk) || dk);
                if (task.progress) task.progress.done++;
                return;
              }
            }
            failures.push(`${rideShortLabel(dk) || dk}: ${reason}`);
          },
          // Capture the ride's detail read during the export so a GPX download on a
          // ride we never opened still records its title/stats/Strava status.
          (detail) => this.persistDetail(detail, kind),
          mode,
        );
        succeeded += files.length;
      }
    }

    // Deliver the produced files. One file → a plain GPX (unchanged behaviour); more
    // than one → a single ZIP so the browser reliably saves the whole batch. In
    // fetch-only mode nothing is delivered — the rides are now cached.
    let bundled = false;
    if (save && bundle.length === 1) {
      this.emitGpx(bundle[0]);
    } else if (save && bundle.length > 1) {
      const zipBytes = await buildZip(
        bundle.map((f) => ({ name: f.downloadName, bytes: f.bytes })),
      );
      const name = this.bundleZipName(bundle, mode);
      this.emitGpx({
        key: bundle[0].key,
        filename: name,
        downloadName: name,
        bytes: zipBytes,
        mime: "application/zip",
      });
      bundled = true;
    }

    const suffix = removed ? `, ${removed} deleted` : "";
    // Surface any graceful degradation (full track unreachable → route-only) in the
    // completion status so the user knows those files lack real time/elevation.
    const degradedNote = degraded.length
      ? ` — ${degraded.length} saved as route-only (export gateway unreachable; no real time/elevation)`
      : "";
    const bundleNote = bundled ? " (bundled into one .zip)" : "";
    report(
      save
        ? `exported ${succeeded} GPX file${succeeded === 1 ? "" : "s"}${bundleNote}${suffix}${degradedNote}`
        : `fetched & cached ${succeeded} full GPX${succeeded === 1 ? "" : "s"}${suffix}`,
    );

    if (failures.length) {
      // Fail the task so the UI shows a persistent, acknowledgeable error with full
      // per-ride detail under "Details" — not a status message that just blinks past.
      const verb = save ? "GPX download" : "GPX fetch";
      const header = `${failures.length} of ${task.keys.length} ${verb}${
        task.keys.length === 1 ? "" : "s"
      } failed (${succeeded} succeeded):`;
      throw new Error([header, ...failures.map((f) => `  • ${f}`)].join("\n"));
    }
  }

  /**
   * Name a multi-ride ZIP bundle: `Routes 2026-01-03 to 2026-12-28 (123).zip`
   * (or `GPX …` in full mode). The date range is derived from the rides in the
   * bundle so the file is self-describing and sorts chronologically; it collapses
   * to a single date when every ride falls on the same day.
   */
  private bundleZipName(files: GpxFile[], mode: GpxMode): string {
    const kind = mode === "full" ? "GPX" : "Routes";
    const dates = files
      .map((f) => rideDatetime(uidDateKey(f.key)))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    const p2 = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    let range = "";
    if (dates.length) {
      const lo = iso(dates[0]);
      const hi = iso(dates[dates.length - 1]);
      range = lo === hi ? ` ${lo}` : ` ${lo} to ${hi}`;
    }
    return `${kind}${range} (${files.length}).zip`;
  }

  /**
   * Rename a ride on its source, then mirror the new name locally. The source is
   * the authority (Beeline's ride node; a GPX ride renames in place); we only update
   * the cache once the write succeeds. The fuller `title` keeps any location suffix
   * the ride already carried, so only the user-facing name part changes.
   */
  private async doRename(task: Task, report: Report): Promise<void> {
    const uid = task.keys[0];
    const newTitle = ((task.payload.title as string) ?? "").trim();
    if (!uid) return;
    const { source: kind, dateKey } = splitUid(uid);
    const source = this.requireSource(kind as SourceKind);
    const detail = await source.renameRide(dateKey, newTitle, (msg) => report(msg));
    // Preserve any ", <place>" suffix the existing title carried beyond the base.
    const rec = this.store.rides.get(uid);
    const suffix =
      rec?.title.startsWith(rec.title_base) && rec.title.length > rec.title_base.length
        ? rec.title.slice(rec.title_base.length)
        : "";
    this.store.upsert(uid, {
      ...this.deviceFieldsFor(kind as SourceKind),
      title_base: detail.title,
      title: detail.title + suffix,
    });
    this.store.save();
    this.notify();
    report(`renamed to “${detail.title}”`);
  }

  /**
   * Delete a ride on the backend, then keep it locally as a tombstone (the existing
   * `deleted`/`deleted_at` state) rather than dropping it — so the row stays visible
   * as “deleted” and a later complete scan won't resurrect it (it's gone upstream).
   */
  private async doDelete(task: Task, report: Report): Promise<void> {
    const uid = task.keys[0];
    if (!uid) return;
    const { source: kind, dateKey } = splitUid(uid);
    const source = this.requireSource(kind as SourceKind);
    await source.deleteRide(dateKey, (msg) => report(msg));
    this.store.markDeleted(uid);
    this.store.save();
    this.notify();
    report(`deleted ${rideShortLabel(dateKey) || dateKey}`);
  }

  // -- enqueue helpers / API surface ------------------------------------

  scan(preset: string, days: number | null): TaskSnapshotResult {
    const label = preset !== "custom" ? preset : `last ${days}d`;
    return this.jobs.submit("scan", { label, payload: { preset, days } });
  }

  /** Import user-supplied GPX files (and/or .zip bundles of them) as `gpx`-source
   *  rides. One queued pass; never coalesced. */
  importGpx(files: File[], label = ""): TaskSnapshotResult {
    return this.jobs.submit("import", {
      label: label || `${files.length} file${files.length === 1 ? "" : "s"}`,
      payload: { files },
    });
  }

  upload(keys: string[], label = ""): TaskSnapshotResult {
    // Never re-upload a ride that's already on Strava: filter out uploaded keys at the
    // single choke point every caller funnels through (per-ride, selection, month, year,
    // all-pending), so no UI path can submit a duplicate upload. Bare datetime keys
    // (legacy callers) are normalized to a Beeline uid.
    const fresh = keys
      .map((k) => this.normalizeUid(k))
      .filter((uid) => this.store.rides.get(uid)?.strava_status !== "uploaded");
    return this.jobs.submit("upload", {
      label: label || `${fresh.length} rides`,
      keys: fresh,
    });
  }

  /** Export each given ride's route as a GPX file handed to the UI to write to disk.
   *  `mode` selects the lightweight stored-shape GPX (default, local) or the full
   *  recorded track fetched from the cloud (see `GpxMode`). */
  downloadGpx(keys: string[], label = "", mode: GpxMode = "light"): TaskSnapshotResult {
    const uids = keys.map((k) => this.normalizeUid(k));
    return this.jobs.submit("download-gpx", {
      label: label || `${uids.length} rides`,
      keys: uids,
      payload: { mode, save: true },
    });
  }

  /**
   * Fetch the FULL recorded GPX for the given rides and cache it locally WITHOUT
   * saving any file to disk. Same queued cloud sweep as a full download (it also
   * rehydrates each ride's real time/elevation map track), minus the delivery — so
   * the user can pre-warm the offline cache for a selection in one go. Rides already
   * cached are skipped. Runs as its own sweep: the `save:false` payload keeps it from
   * coalescing with a real save-download (see JobQueue).
   */
  fetchFullGpx(keys: string[], label = ""): TaskSnapshotResult {
    const uids = keys.map((k) => this.normalizeUid(k));
    return this.jobs.submit("download-gpx", {
      label: label || `${uids.length} rides`,
      keys: uids,
      payload: { mode: "full", save: false },
    });
  }

  /** Rename a ride (on its source, then locally). One ride per task; not coalesced. */
  rename(key: string, newTitle: string): TaskSnapshotResult {
    const uid = this.normalizeUid(key);
    return this.jobs.submit("rename", {
      label: rideShortLabel(uidDateKey(uid)) || uid,
      keys: [uid],
      payload: { title: newTitle },
    });
  }

  /** Delete a ride (on its source, then tombstoned locally). One ride per task. */
  deleteRide(key: string): TaskSnapshotResult {
    const uid = this.normalizeUid(key);
    return this.jobs.submit("delete", {
      label: rideShortLabel(uidDateKey(uid)) || uid,
      keys: [uid],
    });
  }

  /**
   * Set (or clear) an imported GPX ride's destination — stored as the title's
   * location suffix ("<name>, <place>"), mirroring the shape Beeline uses for a
   * routed destination so the Destination filter and the title-row suffix work
   * identically across sources. This is purely-local metadata with no backend, so
   * (unlike rename) it writes the Store directly rather than queueing a task.
   * GPX-only: Beeline destinations are read-only cloud data, so a non-GPX ride is a
   * no-op. Pass "" to clear the destination.
   */
  setDestination(key: string, destination: string): void {
    const uid = this.normalizeUid(key);
    const rec = this.store.rides.get(uid);
    if (rec?.source !== "gpx") return;
    const base = rec.title_base || rec.title;
    const place = destination.trim();
    this.store.upsert(uid, {
      title_base: base,
      title: place ? `${base}, ${place}` : base,
    });
    this.store.save();
    this.notify();
  }

  /** Update the rough-track density (points/km, persisted). Returns the clamped value. */
  setTrackPointsPerKm(n: number): number {
    const v = this.store.setTrackPointsPerKm(n);
    this.notify();
    return v;
  }

  /** Update the average-speed outlier trim (slow/fast %, persisted). Returns the clamped pair. */
  setSpeedTrim(slowPct: number, fastPct: number): { slowPct: number; fastPct: number } {
    const v = this.store.setSpeedTrim(slowPct, fastPct);
    this.notify();
    return v;
  }

  /** Update the heatmap glow radius (px, persisted). Returns the clamped value. */
  setHeatRadius(n: number): number {
    const v = this.store.setHeatRadius(n);
    this.notify();
    return v;
  }

  /** Update how many Beeline uploads run at once (persisted). Returns the clamped value. */
  setBeelineUploadConcurrency(n: number): number {
    const v = this.store.setBeelineUploadConcurrency(n);
    this.notify();
    return v;
  }

  /** Update the moving/stopped speed threshold (km/h, persisted). Returns the clamped value. */
  setMovingThreshold(n: number): number {
    const v = this.store.setMovingThreshold(n);
    this.notify();
    return v;
  }

  /** Toggle whether a successful GPX import offers to tag the new rides (persisted). */
  setSuggestTagsAfterImport(on: boolean): boolean {
    const v = this.store.setSuggestTagsAfterImport(on);
    this.notify();
    return v;
  }

  cancel(id: number | null): void {
    if (id === null) this.jobs.cancelAll();
    else this.jobs.cancel(id);
  }

  clear(): number {
    return this.jobs.clear();
  }

  /**
   * Wipe all local state: cancel/clear the job queue and empty the ride cache. Also
   * flushes BOTH GPX stores — the re-fetchable cache AND the imported-GPX data vault
   * (a reset is "erase everything local", the nuclear option). Destroys browser-side
   * data only; nothing in your Beeline account is affected.
   */
  reset(): void {
    this.jobs.cancelAll();
    this.jobs.clear();
    this.store.clear();
    void this.gpxCache.clear();
    void this.gpxData.clear();
    void this.windCache.flush();
    this.rideWinds.clear();
    this.rideWindGeom.clear();
    this.notify();
  }

  /**
   * Flush ONLY the re-fetchable GPX **cache** (Beeline downloads), leaving rides,
   * settings, AND the imported-GPX data vault intact. Separate from `reset()` so the
   * user can reclaim the (potentially large) cache without losing ride history; and
   * separate from the data vault so an imported GPX's only copy is never touched by a
   * cache flush.
   */
  async flushGpxCache(): Promise<void> {
    await this.gpxCache.clear();
    this.notify();
  }

  /** Total on-disk (compressed) size of the re-fetchable GPX cache, in bytes. */
  gpxCacheBytes(): number {
    return this.gpxCache.totalBytes();
  }

  /** Number of rides with a cached (re-fetchable) full GPX. */
  gpxCacheCount(): number {
    return this.gpxCache.count;
  }

  /** Total on-disk (compressed) size of the imported-GPX data vault, in bytes. */
  gpxDataBytes(): number {
    return this.gpxData.totalBytes();
  }

  /** Number of imported GPX rides whose original is stored in the data vault. */
  gpxDataCount(): number {
    return this.gpxData.count;
  }

  /** The set of ride uids whose full GPX is present locally — in EITHER the cache
   *  (Beeline) or the data vault (imported). This is availability, not provenance,
   *  so callers deciding "can I serve this without a fetch?" see both. */
  gpxCachedKeys(): Set<string> {
    return new Set([...this.gpxCache.cachedKeys(), ...this.gpxData.cachedKeys()]);
  }

  // -- import / export ---------------------------------------------------

  /** Force any pending debounced cache write out now (e.g. before the page unloads). */
  flush(): Promise<void> {
    return this.store.flush();
  }

  exportJson(meta?: Record<string, unknown>): string {
    return this.store.exportJson(meta);
  }

  importJson(text: string): number {
    const n = this.store.importJson(text);
    this.notify();
    return n;
  }

  /**
   * Export ALL state and caches into a single ZIP file: ride records + settings
   * (state.json) plus all cached GPX blobs (beeline cache + imported-GPX data vault)
   * and wind cache entries, each stored verbatim (already gzip-compressed). Returns
   * the ZIP as raw bytes.
   *
   * Throws if any IndexedDB read fails or if ZIP building fails.
   */
  async exportAllZip(meta?: Record<string, unknown>): Promise<Uint8Array> {
    // 1. Build manifest metadata.
    const manifest = {
      schema: 1,
      created_at: new Date().toISOString(),
      app: meta?.app || {},
      stores: {
        state: 1,
        gpx_cache: 0,
        gpx_data: 0,
        wind: 0,
      },
    };

    const zipEntries: ZipEntry[] = [];

    // 2. Export the main state (ride records + settings).
    const stateJson = this.store.exportJson(meta);
    zipEntries.push({ name: "state.json", bytes: new TextEncoder().encode(stateJson) });

    // 3. Export cached GPX (Beeline downloads) using the public getAllBlobs() method.
    const cacheBlobs = await this.gpxCache.getAllBlobs();
    for (const { key, bytes } of cacheBlobs) {
      zipEntries.push({ name: `gpx/cache/${key}.gz`, bytes });
      manifest.stores.gpx_cache++;
    }

    // 4. Export data vault GPX (imported files) — same structure, different prefix.
    const dataBlobs = await this.gpxData.getAllBlobs();
    for (const { key, bytes } of dataBlobs) {
      zipEntries.push({ name: `gpx/data/${key}.gz`, bytes });
      manifest.stores.gpx_data++;
    }

    // 5. Export wind cache (global, shared across all profiles).
    const windBlobs = await this.windCache.getAllBlobs();
    for (const { key, bytes } of windBlobs) {
      zipEntries.push({ name: `wind/${key}.gz`, bytes });
      manifest.stores.wind++;
    }

    // 6. Prepend manifest and build the ZIP.
    const manifestJson = JSON.stringify(manifest, null, 2);
    zipEntries.unshift({
      name: "manifest.json",
      bytes: new TextEncoder().encode(manifestJson),
    });

    return buildZip(zipEntries);
  }

  /**
   * Import all state and caches from a ZIP file. Merges ride records (via the
   * existing store.importJson logic), and restores cached GPX + wind blobs. Policy:
   * skip blobs that already exist (byte-for-byte identical); write missing or
   * differing blobs; do not overwrite intact caches on schema mismatch (import
   * fails cleanly). Returns counts of items restored.
   *
   * Throws a descriptive error if the ZIP is malformed, state.json is unreadable,
   * or the schema is unmigratable. If a single blob write fails, the error is
   * logged but does not abort the import (other blobs are written). Returns
   * ridesImported (0 on schema mismatch) and counts of GPX/wind blobs restored.
   */
  async importAllZip(bytesOrBlob: Uint8Array | ArrayBuffer | Blob): Promise<{
    ridesImported: number;
    gpxCacheImported: number;
    gpxDataImported: number;
    windImported: number;
  }> {
    // Convert various input types to Uint8Array.
    let bytes: Uint8Array;
    if (bytesOrBlob instanceof Blob) {
      bytes = new Uint8Array(await bytesOrBlob.arrayBuffer());
    } else if (bytesOrBlob instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytesOrBlob);
    } else {
      bytes = bytesOrBlob;
    }

    // Unzip and extract entries.
    const zipEntries = await unzip(bytes);

    // Build a Map for easy lookup by name.
    const zipMap = new Map<string, Uint8Array>();
    for (const entry of zipEntries) {
      zipMap.set(entry.name, entry.bytes);
    }

    if (!zipMap.has("state.json")) {
      throw new Error("ZIP missing state.json — not a valid backup");
    }

    // Try to import the state. If it fails (bad schema), abort blob writes.
    let ridesImported = 0;
    try {
      const stateJson = new TextDecoder().decode(zipMap.get("state.json")!);
      ridesImported = this.store.importJson(stateJson);
      this.notify();
    } catch (err) {
      // Schema mismatch or corrupt JSON — surface the error.
      throw new Error(
        `Failed to import state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Restore GPX cache blobs (best-effort — skip failures, log them).
    let gpxCacheImported = 0;
    for (const entry of zipEntries) {
      if (entry.name.startsWith("gpx/cache/") && entry.name.endsWith(".gz")) {
        const key = entry.name.slice("gpx/cache/".length, -".gz".length);
        const imported = await this.gpxCache.setBlob(key, entry.bytes);
        if (imported) gpxCacheImported++;
      }
    }

    // Restore GPX data vault blobs.
    let gpxDataImported = 0;
    for (const entry of zipEntries) {
      if (entry.name.startsWith("gpx/data/") && entry.name.endsWith(".gz")) {
        const key = entry.name.slice("gpx/data/".length, -".gz".length);
        const imported = await this.gpxData.setBlob(key, entry.bytes);
        if (imported) gpxDataImported++;
      }
    }

    // Restore wind cache blobs.
    let windImported = 0;
    for (const entry of zipEntries) {
      if (entry.name.startsWith("wind/") && entry.name.endsWith(".gz")) {
        const key = entry.name.slice("wind/".length, -".gz".length);
        const imported = await this.windCache.setBlob(key, entry.bytes);
        if (imported) windImported++;
      }
    }

    // Rebuild the cache indexes to reflect the new/imported entries.
    await Promise.all([
      this.gpxCache.reload(),
      this.gpxData.reload(),
      this.windCache.reload(),
    ]);

    return { ridesImported, gpxCacheImported, gpxDataImported, windImported };
  }

  /** Byte size of the locally persisted state, for a human-readable size hint. */
  stateBytes(): number {
    return this.store.byteSize();
  }
}

// `submit` returns a task snapshot; alias keeps the surface readable.
type TaskSnapshotResult = ReturnType<JobQueue["submit"]>;

export { rideMonth };
