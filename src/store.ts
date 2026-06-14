/**
 * Local persistent state: which rides we know about and their Strava status.
 *
 * Port of `beeline_uploader.store` (Python). The phone is authoritative, but
 * caching lets us list rides quickly and avoid re-opening every ride on each run.
 *
 * Storage: a single serialized blob under one key in a KeyValueStore (IndexedDB
 * in production, an in-memory Map in demo/tests). The serialized shape is
 * IDENTICAL to the Python tool's `rides.json` ({ updated_at, rides: { key: {...} } }),
 * so files exported here import into the Python tool and vice-versa.
 */

import type { KeyValueStore } from "./kv";
import { looksLikeStat, rideMonth, type StravaStatus } from "./parsing";

/** Key under which the single serialized cache blob is stored in the backend. */
export const STORAGE_KEY = "beeline-toolkit-state";

/** Default rough-track density: points kept per kilometre of route. */
export const DEFAULT_TRACK_POINTS_PER_KM = 20;
const TRACK_MIN_POINTS_PER_KM = 1;
const TRACK_MAX_POINTS_PER_KM = 100;

function clampPointsPerKm(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TRACK_POINTS_PER_KM;
  return Math.max(TRACK_MIN_POINTS_PER_KM, Math.min(TRACK_MAX_POINTS_PER_KM, Math.round(n)));
}

/** Largest share of distance trimmable from a single (slow or fast) end of the speed view. */
export const SPEED_TRIM_MAX_PCT = 45;

/** Clamp one end's trim percentage into [0, SPEED_TRIM_MAX_PCT] (0 = no trimming). */
function clampTrimPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(SPEED_TRIM_MAX_PCT, Math.round(n)));
}

/** Default heatmap glow radius (px): the visual "thickness" of a rendered track. */
export const DEFAULT_HEAT_RADIUS = 12;
const HEAT_RADIUS_MIN = 6;
const HEAT_RADIUS_MAX = 30;

/** Clamp the heatmap glow radius into [HEAT_RADIUS_MIN, HEAT_RADIUS_MAX] px. */
function clampHeatRadius(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HEAT_RADIUS;
  return Math.max(HEAT_RADIUS_MIN, Math.min(HEAT_RADIUS_MAX, Math.round(n)));
}

export interface Settings {
  /** Points kept per kilometre when simplifying a downloaded GPX into a rough track. */
  trackPointsPerKm: number;
  /** Share of slowest distance (%) to drop from the average-speed view. */
  speedTrimSlowPct: number;
  /** Share of fastest distance (%) to drop from the average-speed view. */
  speedTrimFastPct: number;
  /** Heatmap glow radius (px) — how thick each track renders on the route-frequency map. */
  heatRadius: number;
}

function defaultSettings(): Settings {
  return {
    trackPointsPerKm: DEFAULT_TRACK_POINTS_PER_KM,
    speedTrimSlowPct: 0,
    speedTrimFastPct: 0,
    heatRadius: DEFAULT_HEAT_RADIUS,
  };
}

// UI chrome labels that must never be stored as a ride title.
const BAD_TITLES = new Set(["Heatmap", "Journeys", "Settings", "Ride"]);

/**
 * How long save() waits before writing, coalescing a burst of mutations (a slider
 * drag, a page of freshly-scanned rides) into a single durable write. Kept small
 * so at most this much work is ever at risk if the tab vanishes without a flush().
 */
const SAVE_DEBOUNCE_MS = 400;

function nowIso(): string {
  // ISO-8601 with seconds precision and a timezone offset, mirroring Python's
  // datetime.now(timezone.utc).isoformat(timespec="seconds").
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export interface RideRecord {
  key: string;
  /** Richest title seen (the detail-sheet heading, e.g. "Morning ride, Amstelveen"). */
  title: string;
  /** Short list-card name (e.g. "Morning ride"); the prefix of the fuller `title`. */
  title_base: string;
  distance: string;
  duration: string;
  strava_status: StravaStatus;
  stats: Record<string, string>;
  /** Rough encoded-polyline sketch of the route (see track.ts). Empty when unknown. */
  track: string;
  /** Lat/lon points read from the downloaded GPX (0 when unknown). */
  track_src_points: number;
  /** Points kept in the rough track after simplification (0 when unknown). */
  track_points: number;
  /** Length of the source GPX track in kilometres (0 when unknown). */
  track_km: number;
  /** Size of the downloaded GPX file in bytes (0 when unknown). */
  track_bytes: number;
  /** Model of the phone this ride was last read from (e.g. "Pixel 10 Pro"). Empty when unknown. */
  device_model: string;
  /** USB serial of the phone this ride was last read from. Empty when unknown. */
  device_serial: string;
  last_seen: string;
  uploaded_at: string;
  /** True when the ride was known locally but has since vanished from the phone. */
  deleted: boolean;
  deleted_at: string;
}

function blankRecord(key: string): RideRecord {
  return {
    key,
    title: "",
    title_base: "",
    distance: "",
    duration: "",
    strava_status: "unknown",
    stats: {},
    track: "",
    track_src_points: 0,
    track_points: 0,
    track_km: 0,
    track_bytes: 0,
    device_model: "",
    device_serial: "",
    last_seen: "",
    uploaded_at: "",
    deleted: false,
    deleted_at: "",
  };
}

export function monthKey(rec: RideRecord): string {
  return rideMonth(rec.key)[0];
}

export function monthLabel(rec: RideRecord): string {
  return rideMonth(rec.key)[1];
}

interface Persisted {
  updated_at: string;
  settings: Settings;
  rides: Record<string, RideRecord>;
}

export interface UpsertFields {
  title?: string;
  title_base?: string;
  distance?: string;
  duration?: string;
  strava_status?: StravaStatus;
  stats?: Record<string, string>;
  track?: string;
  track_src_points?: number;
  track_points?: number;
  track_km?: number;
  track_bytes?: number;
  device_model?: string;
  device_serial?: string;
}

export class Store {
  rides: Map<string, RideRecord> = new Map();
  settings: Settings = defaultSettings();

  /** Pending-write state for the debounced write-back (see save()/flush()). */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /**
   * @param backend durable key/value store (IndexedDB in production).
   * @param onError surfaced when a background write fails (e.g. quota exceeded).
   */
  constructor(
    private readonly backend: KeyValueStore,
    private readonly onError?: (message: string) => void,
  ) {}

  static async load(
    backend: KeyValueStore,
    onError?: (message: string) => void,
  ): Promise<Store> {
    const store = new Store(backend, onError);
    let raw: string | null = null;
    try {
      raw = await backend.get(STORAGE_KEY);
    } catch {
      /* storage unavailable — start empty */
    }
    if (raw) {
      try {
        store.ingest(JSON.parse(raw));
      } catch {
        /* corrupt cache — start fresh */
      }
    }
    return store;
  }

  /** Merge a persisted payload (from storage or an imported file) into memory. */
  private ingest(data: unknown): void {
    const settings = (data as Partial<Persisted>)?.settings;
    if (settings && typeof settings === "object") {
      if ("trackPointsPerKm" in settings) {
        this.settings.trackPointsPerKm = clampPointsPerKm(Number(settings.trackPointsPerKm));
      }
      if ("speedTrimSlowPct" in settings) {
        this.settings.speedTrimSlowPct = clampTrimPct(Number(settings.speedTrimSlowPct));
      }
      if ("speedTrimFastPct" in settings) {
        this.settings.speedTrimFastPct = clampTrimPct(Number(settings.speedTrimFastPct));
      }
      if ("heatRadius" in settings) {
        this.settings.heatRadius = clampHeatRadius(Number(settings.heatRadius));
      }
    }
    const rides = (data as Partial<Persisted>)?.rides;
    if (!rides || typeof rides !== "object") return;
    for (const [key, raw] of Object.entries(rides as Record<string, Partial<RideRecord>>)) {
      const rec: RideRecord = { ...blankRecord(key), ...raw, key };
      // Scrub stale mis-parsed titles: UI chrome (Heatmap/Journeys/…) and stat
      // values/labels (e.g. "20,0km/h" captured when the detail heading scrolled
      // off-screen during a Check). Clearing lets the next scan/check reseed a
      // correct title instead of persisting the bad one forever.
      if (BAD_TITLES.has(rec.title) || looksLikeStat(rec.title)) rec.title = "";
      if (BAD_TITLES.has(rec.title_base) || looksLikeStat(rec.title_base)) rec.title_base = "";
      if (!rec.stats || typeof rec.stats !== "object") rec.stats = {};
      if (typeof rec.track !== "string") rec.track = "";
      rec.track_src_points = Number(rec.track_src_points) || 0;
      rec.track_points = Number(rec.track_points) || 0;
      rec.track_km = Number(rec.track_km) || 0;
      rec.track_bytes = Number(rec.track_bytes) || 0;
      if (typeof rec.device_model !== "string") rec.device_model = "";
      if (typeof rec.device_serial !== "string") rec.device_serial = "";
      rec.deleted = rec.deleted === true; // coerce missing/odd values to a real boolean
      this.rides.set(key, rec);
    }
  }

  private serialize(): Persisted {
    const rides: Record<string, RideRecord> = {};
    for (const [k, v] of this.rides) rides[k] = v;
    return { updated_at: nowIso(), settings: { ...this.settings }, rides };
  }

  /**
   * Persist the in-memory cache. The Map is already the source of truth, so this
   * never blocks the UI: it marks the cache dirty and schedules a single debounced
   * background write, coalescing rapid bursts (slider drags, scan pages) into one.
   * Use flush() to force the pending write out immediately (e.g. before unload).
   */
  save(): void {
    this.dirty = true;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writePending();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Force any pending debounced write to happen now; resolves once it settles (or
   * immediately if nothing is pending). Call before the page unloads so the last
   * mutation isn't lost in the debounce window.
   */
  flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    return this.writePending();
  }

  /**
   * Serialize and write the cache if dirty. Serialization is deferred to here (not
   * to each save() call) so a coalesced burst also pays the JSON cost only once. A
   * failed write — most likely a full disk/quota — is surfaced via `onError`.
   */
  private writePending(): Promise<void> {
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    const payload = JSON.stringify(this.serialize());
    return this.backend.set(STORAGE_KEY, payload).catch((err: unknown) => {
      const full = err instanceof DOMException && err.name === "QuotaExceededError";
      this.onError?.(
        full
          ? "Storage full — some ride data could not be saved locally."
          : "Failed to save ride data locally.",
      );
    });
  }

  upsert(key: string, fields: UpsertFields = {}): RideRecord {
    const rec = this.rides.get(key) ?? blankRecord(key);
    if (fields.title) rec.title = fields.title;
    if (fields.title_base) {
      rec.title_base = fields.title_base;
      // Seed the display title from the scan name until a fuller one is checked.
      if (!rec.title) rec.title = fields.title_base;
    }
    if (fields.distance) rec.distance = fields.distance;
    if (fields.duration) rec.duration = fields.duration;
    if (fields.stats && Object.keys(fields.stats).length) {
      rec.stats = { ...rec.stats, ...fields.stats };
    }
    if (fields.track) rec.track = fields.track;
    if (fields.track_src_points != null) rec.track_src_points = fields.track_src_points;
    if (fields.track_points != null) rec.track_points = fields.track_points;
    if (fields.track_km != null) rec.track_km = fields.track_km;
    if (fields.track_bytes != null) rec.track_bytes = fields.track_bytes;
    if (fields.device_model) rec.device_model = fields.device_model;
    if (fields.device_serial) rec.device_serial = fields.device_serial;
    if (fields.strava_status && fields.strava_status !== "unknown") {
      if (fields.strava_status === "uploaded" && rec.strava_status !== "uploaded") {
        rec.uploaded_at = nowIso();
      }
      rec.strava_status = fields.strava_status;
    }
    // Seeing a ride again means it is NOT deleted (clear any stale flag).
    rec.deleted = false;
    rec.deleted_at = "";
    rec.last_seen = nowIso();
    this.rides.set(key, rec);
    return rec;
  }

  /**
   * Flag a known ride as deleted on the phone. No-op for unknown keys or rides
   * already flagged (so `deleted_at` records the first time we noticed). Returns
   * true when this call newly flagged the ride.
   */
  markDeleted(key: string): boolean {
    const rec = this.rides.get(key);
    if (!rec || rec.deleted) return false;
    rec.deleted = true;
    rec.deleted_at = nowIso();
    this.rides.set(key, rec);
    return true;
  }

  pending(): RideRecord[] {
    return [...this.rides.values()].filter((r) => r.strava_status === "pending" && !r.deleted);
  }

  /** Update the rough-track density (points/km) and persist. Returns the clamped value. */
  setTrackPointsPerKm(n: number): number {
    this.settings.trackPointsPerKm = clampPointsPerKm(n);
    this.save();
    return this.settings.trackPointsPerKm;
  }

  /** Update the average-speed outlier trim (slow/fast %) and persist. Returns the clamped pair. */
  setSpeedTrim(slowPct: number, fastPct: number): { slowPct: number; fastPct: number } {
    this.settings.speedTrimSlowPct = clampTrimPct(slowPct);
    this.settings.speedTrimFastPct = clampTrimPct(fastPct);
    this.save();
    return {
      slowPct: this.settings.speedTrimSlowPct,
      fastPct: this.settings.speedTrimFastPct,
    };
  }

  /** Update the heatmap glow radius (px) and persist. Returns the clamped value. */
  setHeatRadius(n: number): number {
    this.settings.heatRadius = clampHeatRadius(n);
    this.save();
    return this.settings.heatRadius;
  }

  /**
   * Wipe all cached rides and restore default settings, removing the persisted
   * payload from storage. Local browser state only — this never touches the phone.
   */
  clear(): void {
    this.rides.clear();
    this.settings = defaultSettings();
    // Drop any pending debounced write so it can't resurrect the just-cleared data.
    this.dirty = false;
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.backend.del(STORAGE_KEY).catch(() => {
      /* storage unavailable — non-fatal, the in-memory state is already cleared */
    });
  }

  // -- import / export ---------------------------------------------------

  /** Serialized JSON identical to the Python tool's rides.json (for download). */
  exportJson(): string {
    return JSON.stringify(this.serialize(), null, 2);
  }

  /** Merge an exported/Python rides.json into the store and persist. Returns count merged. */
  importJson(text: string): number {
    const before = this.rides.size;
    this.ingest(JSON.parse(text));
    this.save();
    return this.rides.size - before;
  }
}
