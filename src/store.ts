/**
 * Local persistent state: which rides we know about and their Strava status.
 *
 * Port of `beeline_uploader.store` (Python). The phone is authoritative, but
 * caching lets us list rides quickly and avoid re-opening every ride on each run.
 *
 * Storage: browser LocalStorage under a single key. The serialized shape is
 * IDENTICAL to the Python tool's `rides.json` ({ updated_at, rides: { key: {...} } }),
 * so files exported here import into the Python tool and vice-versa.
 */

import { rideMonth, type StravaStatus } from "./parsing";

export const STORAGE_KEY = "beeline-toolkit-state";
/** Pre-rename key; migrated into STORAGE_KEY on first load so users keep their cache. */
export const LEGACY_STORAGE_KEY = "beeline_uploader.rides";

/** Default cap on the number of points kept for a rough track. */
export const DEFAULT_TRACK_MAX_POINTS = 100;
const TRACK_MIN_POINTS = 20;
const TRACK_MAX_POINTS = 500;

function clampTrackPoints(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TRACK_MAX_POINTS;
  return Math.max(TRACK_MIN_POINTS, Math.min(TRACK_MAX_POINTS, Math.round(n)));
}

export interface Settings {
  /** Max points kept when simplifying a downloaded GPX into a rough track. */
  trackMaxPoints: number;
}

function defaultSettings(): Settings {
  return { trackMaxPoints: DEFAULT_TRACK_MAX_POINTS };
}

// UI chrome labels that must never be stored as a ride title.
const BAD_TITLES = new Set(["Heatmap", "Journeys", "Settings", "Ride"]);

function nowIso(): string {
  // ISO-8601 with seconds precision and a timezone offset, mirroring Python's
  // datetime.now(timezone.utc).isoformat(timespec="seconds").
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export interface RideRecord {
  key: string;
  title: string;
  distance: string;
  duration: string;
  strava_status: StravaStatus;
  stats: Record<string, string>;
  /** Rough encoded-polyline sketch of the route (see track.ts). Empty when unknown. */
  track: string;
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
    distance: "",
    duration: "",
    strava_status: "unknown",
    stats: {},
    track: "",
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
  distance?: string;
  duration?: string;
  strava_status?: StravaStatus;
  stats?: Record<string, string>;
  track?: string;
}

export class Store {
  rides: Map<string, RideRecord> = new Map();
  settings: Settings = defaultSettings();

  constructor(private readonly storage: Storage = window.localStorage) {}

  static load(storage: Storage = window.localStorage): Store {
    const store = new Store(storage);
    let raw = storage.getItem(STORAGE_KEY);
    let migrated = false;
    if (!raw) {
      // One-time migration from the pre-rename key so existing users keep their data.
      raw = storage.getItem(LEGACY_STORAGE_KEY);
      migrated = raw !== null;
    }
    if (raw) {
      try {
        store.ingest(JSON.parse(raw));
      } catch {
        /* corrupt cache — start fresh */
      }
    }
    if (migrated) {
      store.save(); // persist under the new key
      storage.removeItem(LEGACY_STORAGE_KEY);
    }
    return store;
  }

  /** Merge a persisted payload (from storage or an imported file) into memory. */
  private ingest(data: unknown): void {
    const settings = (data as Partial<Persisted>)?.settings;
    if (settings && typeof settings === "object" && "trackMaxPoints" in settings) {
      this.settings.trackMaxPoints = clampTrackPoints(Number(settings.trackMaxPoints));
    }
    const rides = (data as Partial<Persisted>)?.rides;
    if (!rides || typeof rides !== "object") return;
    for (const [key, raw] of Object.entries(rides as Record<string, Partial<RideRecord>>)) {
      const rec: RideRecord = { ...blankRecord(key), ...raw, key };
      if (BAD_TITLES.has(rec.title)) rec.title = ""; // scrub stale mis-parsed titles
      if (!rec.stats || typeof rec.stats !== "object") rec.stats = {};
      if (typeof rec.track !== "string") rec.track = "";
      rec.deleted = rec.deleted === true; // coerce missing/odd values to a real boolean
      this.rides.set(key, rec);
    }
  }

  private serialize(): Persisted {
    const rides: Record<string, RideRecord> = {};
    for (const [k, v] of this.rides) rides[k] = v;
    return { updated_at: nowIso(), settings: { ...this.settings }, rides };
  }

  save(): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
  }

  upsert(key: string, fields: UpsertFields = {}): RideRecord {
    const rec = this.rides.get(key) ?? blankRecord(key);
    if (fields.title) rec.title = fields.title;
    if (fields.distance) rec.distance = fields.distance;
    if (fields.duration) rec.duration = fields.duration;
    if (fields.stats && Object.keys(fields.stats).length) {
      rec.stats = { ...rec.stats, ...fields.stats };
    }
    if (fields.track) rec.track = fields.track;
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

  /** Update the rough-track point cap and persist. Returns the clamped value. */
  setTrackMaxPoints(n: number): number {
    this.settings.trackMaxPoints = clampTrackPoints(n);
    this.save();
    return this.settings.trackMaxPoints;
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
