/**
 * Local persistent state: the rides we know about plus user settings.
 *
 * Storage: a single serialized JSON blob under one key in a KeyValueStore (IndexedDB
 * in production, an in-memory Map in demo/tests). The blob is **versioned** (`schema`)
 * so its shape can evolve safely — see `SCHEMA_VERSION` / `migrate()`. Ride metrics
 * are NORMALIZED numbers (distance_km, moving_sec, …; null = unknown), parsed once on
 * the ingestion boundary, never localized strings.
 *
 * Extending the format (keep these the single source of truth):
 *  - **A new setting** → add ONE entry to `SETTINGS_SPEC`; its default, the `Settings`
 *    type, and load-time sanitation all derive from it.
 *  - **A new ride field** → add it to `RideRecord` + `blankRecord`; ingest's spread
 *    picks it up, and unknown fields written by a newer build round-trip untouched.
 *  - **A new source** → it's already source-agnostic: rides key by uid `${source}::…`
 *    and carry a `source` tag; no format change needed.
 *  - **A breaking shape change** → bump `SCHEMA_VERSION` and add a `migrate()` case.
 */

import type { KeyValueStore } from "./kv";
import {
  type RideMetrics,
  rideDatetime,
  rideMonth,
  rideUid,
  type StravaStatus,
  splitUid,
} from "./parsing";
import { DEFAULT_MOVING_THRESHOLD_KMH } from "./track";

/** Key under which the single serialized state blob is stored in the backend. */
export const STORAGE_KEY = "gpx-toolkit-state";

/**
 * Format version of the persisted blob. Bump on any BREAKING shape change, and add a
 * matching `migrate()` case. v1 is the first explicitly-versioned format; earlier,
 * unversioned blobs are intentionally discarded (clean slate) rather than guessed.
 * v2 re-keys Beeline rides by their stable push-id (was: local-time datetime).
 * v3 adds per-ride `start_epoch` + `tz` (ride-local time); the fields default via
 * `blankRecord`, so the upgrade is a version bump only.
 */
export const SCHEMA_VERSION = 3;

/** Where a ride's data originated: the Beeline cloud account, or imported GPX files. */
export type RideSource = "beeline" | "gpx";

/** UTF-8 byte length of a string (so multi-byte ride titles count their real size). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Normalize a ride identity to the map's cross-source uid form. A value already
 *  carrying a `source::` prefix passes through; a bare datetime key (legacy /
 *  single-source caller) is treated as a Beeline ride. Keeps the map consistently
 *  uid-keyed no matter which caller (controller passes uids, older callers/tests
 *  pass bare keys) and matches the re-keying ingest does on load. */
function toUid(key: string): string {
  return key.includes("::") ? key : rideUid("beeline", key);
}

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
const HEAT_RADIUS_MIN = 2;
const HEAT_RADIUS_MAX = 30;

/** Clamp the heatmap glow radius into [HEAT_RADIUS_MIN, HEAT_RADIUS_MAX] px. */
function clampHeatRadius(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HEAT_RADIUS;
  return Math.max(HEAT_RADIUS_MIN, Math.min(HEAT_RADIUS_MAX, Math.round(n)));
}

/** Default number of Beeline Strava uploads to run concurrently. */
export const DEFAULT_BEELINE_CONCURRENCY = 4;
const BEELINE_CONCURRENCY_MIN = 1;
const BEELINE_CONCURRENCY_MAX = 8;

/** Clamp the Beeline upload concurrency into [MIN, MAX]. */
function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BEELINE_CONCURRENCY;
  return Math.max(BEELINE_CONCURRENCY_MIN, Math.min(BEELINE_CONCURRENCY_MAX, Math.round(n)));
}

/** Largest "stopped" threshold (km/h) the user can set before everything reads as moving. */
export const MOVING_THRESHOLD_MAX_KMH = 5;

/** Clamp the moving/stopped speed threshold into [0, MOVING_THRESHOLD_MAX_KMH] km/h
 *  (fractional allowed, rounded to one decimal). */
function clampMovingThreshold(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MOVING_THRESHOLD_KMH;
  const clamped = Math.max(0, Math.min(MOVING_THRESHOLD_MAX_KMH, n));
  return Math.round(clamped * 10) / 10;
}

/**
 * One persisted, user-tunable setting: its default and a `clamp` that sanitizes an
 * untrusted loaded value back into range. Declaring settings here (rather than as a
 * hand-maintained interface + defaults + per-field load branches) keeps the three in
 * lockstep — adding a setting is ONE entry, and `Settings`/`defaultSettings`/ingest
 * all derive from it, so they can never drift.
 */
interface SettingSpec<T> {
  readonly default: T;
  readonly clamp: (raw: unknown) => T;
}

const SETTINGS_SPEC = {
  /** Points kept per kilometre when simplifying a downloaded GPX into a rough track. */
  trackPointsPerKm: {
    default: DEFAULT_TRACK_POINTS_PER_KM,
    clamp: (v: unknown) => clampPointsPerKm(Number(v)),
  },
  /** Share of slowest distance (%) to drop from the average-speed view. */
  speedTrimSlowPct: { default: 0, clamp: (v: unknown) => clampTrimPct(Number(v)) },
  /** Share of fastest distance (%) to drop from the average-speed view. */
  speedTrimFastPct: { default: 0, clamp: (v: unknown) => clampTrimPct(Number(v)) },
  /** Heatmap glow radius (px) — how thick each track renders on the route-frequency map. */
  heatRadius: {
    default: DEFAULT_HEAT_RADIUS,
    clamp: (v: unknown) => clampHeatRadius(Number(v)),
  },
  /** How many Beeline Strava uploads run at once. */
  beelineUploadConcurrency: {
    default: DEFAULT_BEELINE_CONCURRENCY,
    clamp: (v: unknown) => clampConcurrency(Number(v)),
  },
  /** Smoothed speed (km/h) below which a hop counts as stopped (excluded from moving avg). */
  movingThresholdKmh: {
    default: DEFAULT_MOVING_THRESHOLD_KMH,
    clamp: (v: unknown) => clampMovingThreshold(Number(v)),
  },
  /** Offer to tag the just-imported rides after a successful GPX import. */
  suggestTagsAfterImport: { default: true, clamp: (v: unknown) => v === true },
} satisfies Record<string, SettingSpec<unknown>>;

/** The user-settings shape, derived from `SETTINGS_SPEC` (each field's type is its
 *  clamp's return type) so the interface can't drift from the loader. */
export type Settings = {
  -readonly [K in keyof typeof SETTINGS_SPEC]: ReturnType<(typeof SETTINGS_SPEC)[K]["clamp"]>;
};

const SETTING_KEYS = Object.keys(SETTINGS_SPEC) as (keyof Settings)[];

function defaultSettings(): Settings {
  const s = {} as Record<string, unknown>;
  for (const key of SETTING_KEYS) s[key] = SETTINGS_SPEC[key].default;
  return s as Settings;
}

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

/**
 * One ride's persisted record. Embeds the normalized `RideMetrics` numbers plus
 * identity, display, route-sketch and Strava bookkeeping. To extend: add a field
 * here AND its default to `blankRecord` — ingest's `{...blankRecord, ...raw}` spread
 * then loads it, and (because the spread preserves unknown keys) a field written by a
 * newer build survives a round-trip through an older one untouched. Source-specific
 * bookkeeping (e.g. `strava_status`/`uploaded_at`) lives flat with a clear prefix.
 */
export interface RideRecord extends RideMetrics {
  key: string;
  /** Fullest title, incl. any location suffix (e.g. "Morning ride, Amstelveen"). */
  title: string;
  /** Short list-card name (e.g. "Morning ride"); the prefix of the fuller `title`. */
  title_base: string;
  strava_status: StravaStatus;
  /** Strava activity id once the ride is on Strava (Beeline reports it). Lets us link
   *  out to strava.com/activities/<id>. Beeline-only; absent until known/uploaded. */
  strava_activity_id?: number;
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
  /** Source label this ride was last read from (e.g. "Beeline (a@b)"). Empty when unknown. */
  device_model: string;
  /** Where this ride came from: the Beeline cloud account, or imported GPX files. */
  source: RideSource;
  /** Source-native id: the Beeline push-id, or an imported GPX's content hash. */
  source_id: string;
  /** Ride start as an epoch-ms INSTANT (UTC). Authoritative for chronological sort
   *  and for rendering the ride-local wall-clock in the ride's own zone. 0 when
   *  unknown (legacy records, or a timeless imported GPX). */
  start_epoch: number;
  /** IANA timezone the ride happened in (e.g. "Europe/Amsterdam"), resolved once at
   *  ingest from the ride's start coordinate. "" when unknown → display falls back to
   *  the viewer's current browser zone. */
  tz: string;
  last_seen: string;
  /** ISO-8601 time the ride first entered the local library. Set once on the very
   *  first upsert and never overwritten by later syncs/checks. Empty for legacy
   *  records written before this field existed (ingest date unknown). */
  ingested_at: string;
  /** ISO-8601 time the ride first reached "uploaded" on Strava. Set once on that
   *  status transition and never re-stamped. Beeline-only: GPX rides can't upload
   *  to Strava, so theirs stays empty for good. Empty until (and unless) uploaded. */
  uploaded_at: string;
  /** True when the ride was known locally but has since vanished from the source. */
  deleted: boolean;
  deleted_at: string;
  /** JSON-encoded `RideWind` summary (provenance + averages) once wind is resolved.
   *  The heavy per-cell hourly arrays live in the separate global wind cache, never
   *  here — this keeps the re-serialized state blob small. Empty until resolved. */
  weather_blob?: string;
  /** ISO-8601 time the wind summary was resolved (presence = cached, skip refetch). */
  weather_fetched_at?: string;
  /** Denormalized average wind speed (km/h) from the summary, for cheap filtering
   *  without re-parsing `weather_blob` per render. 0 when resolved-but-no-data. */
  weather_speed_kmh?: number;
  /** User-assigned tags (case-insensitive; see tags.ts). Empty when untagged. The
   *  stored strings keep their first-seen display casing; comparison is by lowercase
   *  key. Optional so legacy records (written before tags existed) load as []. */
  tags?: string[];
}

/**
 * A fresh, empty record for a ride uid (`${source}::${datetime}`). The record's
 * own `key` stays a bare parseable datetime and `source` is taken from the uid, so
 * date bucketing and per-source routing both work. Tolerates a legacy bare
 * datetime (treated as a Beeline ride) via `splitUid`.
 */
function blankRecord(uid: string): RideRecord {
  const { source, dateKey } = splitUid(uid);
  return {
    key: dateKey,
    title: "",
    title_base: "",
    strava_status: "unknown",
    distance_km: null,
    moving_sec: null,
    elapsed_sec: null,
    avg_speed_kmh: null,
    max_speed_kmh: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    track: "",
    track_src_points: 0,
    track_points: 0,
    track_km: 0,
    track_bytes: 0,
    device_model: "",
    source: source as RideSource,
    source_id: "",
    start_epoch: 0,
    tz: "",
    last_seen: "",
    ingested_at: "",
    uploaded_at: "",
    deleted: false,
    deleted_at: "",
    weather_blob: "",
    weather_fetched_at: "",
    weather_speed_kmh: 0,
    tags: [],
  };
}

/** The numeric metric fields carried on a persisted record. */
const METRIC_KEYS: ReadonlyArray<keyof RideMetrics> = [
  "distance_km",
  "moving_sec",
  "elapsed_sec",
  "avg_speed_kmh",
  "max_speed_kmh",
  "elevation_gain_m",
  "elevation_loss_m",
];

/** Read a persisted record's normalized metric numbers, treating any non-positive or
 *  non-finite value as unknown (null). Metrics are already normalized on the
 *  ingestion boundary, so this is a plain numeric read — no string parsing. */
function metricsFromRecord(raw: Record<string, unknown>): RideMetrics {
  const out = {} as Record<keyof RideMetrics, number | null>;
  for (const k of METRIC_KEYS) {
    const v = raw[k];
    out[k] = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  }
  return out as RideMetrics;
}

export function monthKey(rec: RideRecord): string {
  return rideMonth(rec.key)[0];
}

export function monthLabel(rec: RideRecord): string {
  return rideMonth(rec.key)[1];
}

interface Persisted {
  /** Format version of this blob (see SCHEMA_VERSION / migrate). */
  schema: number;
  updated_at: string;
  settings: Settings;
  rides: Record<string, RideRecord>;
}

/**
 * Bring a parsed persisted blob up to the CURRENT schema, or return null to discard
 * it (start fresh). The single place that knows about old shapes:
 *  - current version → use as-is.
 *  - an older version → a `case` upgrades it step-by-step, re-entering migrate() until
 *    it reaches the current shape (e.g. v1 → v2 re-keys Beeline rides by push-id).
 *  - missing / newer / unknown → discard. An unversioned legacy blob, or one written
 *    by a newer build we can't safely read, is dropped rather than guessed at.
 */
function migrate(data: unknown): Persisted | null {
  if (!data || typeof data !== "object") return null;
  const schema = (data as { schema?: unknown }).schema;
  if (schema === SCHEMA_VERSION) return data as Persisted;
  // Older versions upgrade step-by-step, re-entering migrate() until current.
  if (schema === 1) return migrate(upgradeV1toV2(data as Persisted));
  if (schema === 2) return migrate(upgradeV2toV3(data as Persisted));
  // missing / newer / unknown → discard.
  return null;
}

/**
 * v2 → v3: introduce per-ride `start_epoch` + `tz` (ride-local time). Both are purely
 * additive with safe defaults (`0` / `""`) supplied by `blankRecord` during ingest,
 * so existing records simply gain the fields; Beeline rides get their real values on
 * the next sync (from `raw.start` + location). This is a version bump only.
 */
function upgradeV2toV3(data: Persisted): Persisted {
  return { ...data, schema: SCHEMA_VERSION };
}

/**
 * v1 → v2: re-key Beeline rides by their stable backend push-id (stored as
 * `source_id`) instead of their local-time start datetime.
 *
 * v1 identified a Beeline ride by `beeline::<datetime>`, but that datetime is
 * rendered in the browser's LOCAL timezone — so moving timezones re-keyed every
 * ride, tombstoning the originals and re-fetching duplicates. v2 keys by the
 * push-id (timezone-invariant). Here we migrate existing data: every Beeline
 * record that carries a push-id moves from `beeline::<datetime>` to
 * `beeline::<pushId>`, COLLAPSING the tombstoned-old + live-duplicate pair a tz
 * move may have created into a single ride. Each record's display datetime lives
 * on in its `key`. GPX rides (content-addressed) and any Beeline record lacking a
 * push-id are left untouched.
 */
function upgradeV1toV2(data: Persisted): Persisted {
  const oldRides = (data.rides ?? {}) as unknown as Record<string, RideRecord>;
  const next: Record<string, RideRecord> = {};
  for (const [uid, rec] of Object.entries(oldRides)) {
    const { source, dateKey } = splitUid(uid);
    const pushId = typeof rec.source_id === "string" ? rec.source_id : "";
    // Only re-key Beeline rides that (a) carry a push-id and (b) are still keyed by a
    // datetime (the v1 shape). Everything else passes through unchanged.
    const rekey = source === "beeline" && pushId !== "" && rideDatetime(dateKey) != null;
    const newUid = rekey ? rideUid("beeline", pushId) : uid;
    const existing = next[newUid];
    next[newUid] = existing ? mergeDuplicateRecords(existing, rec) : rec;
  }
  // Return a v2 blob; migrate() re-enters and runs the v2 → v3 step next.
  return { ...data, schema: 2, rides: next };
}

/**
 * Pick the survivor when two v1 records collapse onto one push-id (the tombstoned
 * original + its post-tz-move duplicate). Prefer a live record over a deleted one,
 * then the richer one (has a route track), then the more recently seen. The result
 * stays deleted only when BOTH inputs were deleted — otherwise the ride genuinely
 * still exists and is resurrected as live.
 */
function mergeDuplicateRecords(a: RideRecord, b: RideRecord): RideRecord {
  const score = (r: RideRecord): number =>
    (r.deleted ? 0 : 4) + (r.track ? 2 : 0) + (r.last_seen ? 1 : 0);
  const sa = score(a);
  const sb = score(b);
  const winner = sb !== sa ? (sb > sa ? b : a) : (b.last_seen ?? "") > (a.last_seen ?? "") ? b : a;
  const bothDeleted = a.deleted === true && b.deleted === true;
  return { ...winner, deleted: bothDeleted, deleted_at: bothDeleted ? winner.deleted_at : "" };
}

export interface UpsertFields extends Partial<RideMetrics> {
  /** The ride's reference datetime (`record.key`) — its display/sort date, NOT its
   *  identity. Set on first import for content-addressed uids (GPX), whose uid
   *  suffix is a content hash; stamped once and preserved across idempotent
   *  re-imports. Beeline omits it (its uid suffix already IS the datetime). */
  key?: string;
  title?: string;
  title_base?: string;
  strava_status?: StravaStatus;
  strava_activity_id?: number;
  track?: string;
  track_src_points?: number;
  track_points?: number;
  track_km?: number;
  track_bytes?: number;
  device_model?: string;
  source?: RideSource;
  source_id?: string;
  /** Ride start instant (epoch ms). Authoritative — when present it lets `upsert`
   *  refresh the display `key` (see below), unlike a set-once GPX upload instant. */
  start_epoch?: number;
  /** Resolved IANA timezone for the ride's location. */
  tz?: string;
  /** Resolved wind summary (JSON `RideWind`); set together with `weather_fetched_at`. */
  weather_blob?: string;
  weather_fetched_at?: string;
  weather_speed_kmh?: number;
}

export class Store {
  rides: Map<string, RideRecord> = new Map();
  settings: Settings = defaultSettings();

  /** Pending-write state for the debounced write-back (see save()/flush()). */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /** Byte size of the last serialized payload, surfaced to the UI as a size hint.
   * Cached so reads (byteSize()) stay O(1) on every render — never re-serialized
   * per frame. Refreshed only on the rare, costly events: load, write, import, clear. */
  private cachedBytes = 0;

  /**
   * @param backend durable key/value store (IndexedDB in production).
   * @param onError surfaced when a background write fails (e.g. quota exceeded).
   * @param storageKey backend key for this profile's blob (lets the Beeline
   *        account and demo keep separate, non-colliding caches). Defaults to the
   *        legacy key so existing single-profile data keeps loading unchanged.
   */
  constructor(
    private readonly backend: KeyValueStore,
    private readonly onError?: (message: string) => void,
    private readonly storageKey: string = STORAGE_KEY,
  ) {
    // Seed the size hint for stores built directly (e.g. demo mode); Store.load()
    // refreshes again after ingesting any persisted payload.
    this.refreshSize();
  }

  static async load(
    backend: KeyValueStore,
    onError?: (message: string) => void,
    storageKey: string = STORAGE_KEY,
  ): Promise<Store> {
    const store = new Store(backend, onError, storageKey);
    let raw: string | null = null;
    try {
      raw = await backend.get(storageKey);
    } catch {
      /* storage unavailable — start empty */
    }
    if (raw) {
      try {
        const migrated = migrate(JSON.parse(raw));
        if (migrated) store.ingest(migrated);
      } catch {
        /* corrupt cache — start fresh */
      }
    }
    store.refreshSize();
    return store;
  }

  /** Merge a (current-schema) persisted payload into memory. */
  private ingest(data: Persisted): void {
    const rawSettings = data.settings as Record<string, unknown> | undefined;
    if (rawSettings && typeof rawSettings === "object") {
      const settings = this.settings as Record<string, unknown>;
      for (const key of SETTING_KEYS) {
        if (key in rawSettings) settings[key] = SETTINGS_SPEC[key].clamp(rawSettings[key]);
      }
    }
    const rides = data.rides;
    if (!rides || typeof rides !== "object") return;
    let backfilledIngested = false;
    for (const [uid, raw] of Object.entries(
      rides as unknown as Record<string, Record<string, unknown>>,
    )) {
      // The map keys by the ride uid. For a datetime uid (Beeline, and legacy GPX)
      // the suffix IS the display key, so derive it from the uid — authoritative
      // even if a stored value got corrupted. For a content-addressed uid (GPX,
      // `gpx::sha256:…`) the suffix is a hash, so the datetime lives in the stored
      // record — trust `raw.key` there. `source` always comes from the uid. The
      // `...raw` spread carries through any unknown fields a newer build wrote.
      const { source, dateKey } = splitUid(uid);
      const uidIsDatetime = rideDatetime(dateKey) != null;
      const key =
        uidIsDatetime || typeof raw.key !== "string" || !raw.key
          ? dateKey
          : (raw.key as string);
      const rec: RideRecord = {
        ...blankRecord(uid),
        ...(raw as Partial<RideRecord>),
        key,
        source: source as RideSource,
      };
      Object.assign(rec, metricsFromRecord(raw));
      if (typeof rec.track !== "string") rec.track = "";
      rec.track_src_points = Number(rec.track_src_points) || 0;
      rec.track_points = Number(rec.track_points) || 0;
      rec.track_km = Number(rec.track_km) || 0;
      rec.track_bytes = Number(rec.track_bytes) || 0;
      if (typeof rec.device_model !== "string") rec.device_model = "";
      if (typeof rec.source_id !== "string") rec.source_id = "";
      rec.start_epoch = Number(rec.start_epoch) || 0;
      if (typeof rec.tz !== "string") rec.tz = "";
      rec.deleted = rec.deleted === true; // coerce missing/odd values to a real boolean
      // Rollout backfill: legacy records predate ingestion-date tracking and have an
      // empty `ingested_at`. The true moment is unknowable, so stamp "now" once on
      // first load after the feature shipped — guaranteeing every ride has a defined
      // ingestion date (so the Added filter never silently drops them). Persisted
      // below so the stamp is stable instead of re-minted on each reload.
      if (!rec.ingested_at) {
        rec.ingested_at = nowIso();
        backfilledIngested = true;
      }
      this.rides.set(uid, rec);
    }
    // Persist the one-time backfill so the stamped dates stick across reloads.
    if (backfilledIngested) this.save();
  }

  private serialize(): Persisted {
    const rides: Record<string, RideRecord> = {};
    for (const [k, v] of this.rides) rides[k] = v;
    return {
      schema: SCHEMA_VERSION,
      updated_at: nowIso(),
      settings: { ...this.settings },
      rides,
    };
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
    this.cachedBytes = byteLength(payload);
    return this.backend.set(this.storageKey, payload).catch((err: unknown) => {
      const full = err instanceof DOMException && err.name === "QuotaExceededError";
      this.onError?.(
        full
          ? "Storage full — some ride data could not be saved locally."
          : "Failed to save ride data locally.",
      );
    });
  }

  upsert(key: string, fields: UpsertFields = {}): RideRecord {
    const uid = toUid(key);
    const existed = this.rides.has(uid);
    const rec = this.rides.get(uid) ?? blankRecord(uid);
    // Reference date (display datetime) for content-addressed (GPX) uids, whose
    // suffix is a hash. Stamped ONCE on first import and never overwritten by an
    // idempotent re-import (same bytes → same uid) — like `ingested_at` — so a
    // timeless GPX whose date initialized to the upload instant stays stable.
    // Beeline omits `key` (its uid suffix already is the datetime).
    //
    // EXCEPTION: a caller that supplies an authoritative `start_epoch` (Beeline's
    // real start, or a GPX's recorded `<time>`) MAY refresh the display key even for
    // an existing record — the ride-local wall-clock is a deterministic function of
    // that fixed instant + location, so recomputing it is safe and lets a re-sync
    // repair a legacy browser-timezone key. A timeless GPX omits `start_epoch`, so it
    // still stamps once.
    if (fields.key && (!existed || fields.start_epoch)) rec.key = fields.key;
    if (fields.title) rec.title = fields.title;    if (fields.title_base) {
      rec.title_base = fields.title_base;
      // Seed the display title from the scan name until a fuller one is checked.
      if (!rec.title) rec.title = fields.title_base;
    }
    // Numeric metrics: only overwrite when the incoming figure is known (non-null),
    // so a later partial update (e.g. a list scan that only knows distance) never
    // clears a richer value an earlier Check already captured.
    if (fields.distance_km != null) rec.distance_km = fields.distance_km;
    if (fields.moving_sec != null) rec.moving_sec = fields.moving_sec;
    if (fields.elapsed_sec != null) rec.elapsed_sec = fields.elapsed_sec;
    if (fields.avg_speed_kmh != null) rec.avg_speed_kmh = fields.avg_speed_kmh;
    if (fields.max_speed_kmh != null) rec.max_speed_kmh = fields.max_speed_kmh;
    if (fields.elevation_gain_m != null) rec.elevation_gain_m = fields.elevation_gain_m;
    if (fields.elevation_loss_m != null) rec.elevation_loss_m = fields.elevation_loss_m;
    if (fields.track) rec.track = fields.track;
    if (fields.track_src_points != null) rec.track_src_points = fields.track_src_points;
    if (fields.track_points != null) rec.track_points = fields.track_points;
    if (fields.track_km != null) rec.track_km = fields.track_km;
    if (fields.track_bytes != null) rec.track_bytes = fields.track_bytes;
    if (fields.device_model) rec.device_model = fields.device_model;
    if (fields.source) rec.source = fields.source;
    if (fields.source_id) rec.source_id = fields.source_id;
    // The start instant is authoritative and stable — always take a provided value.
    if (fields.start_epoch) rec.start_epoch = fields.start_epoch;
    // A resolved zone updates the record; an empty string never clears a known one.
    if (fields.tz) rec.tz = fields.tz;
    // Wind summary is set as a unit; an empty string explicitly clears a stale one
    // (e.g. a forced refresh), so use `!== undefined` rather than a truthy check.
    if (fields.weather_blob !== undefined) {
      rec.weather_blob = fields.weather_blob;
      rec.weather_fetched_at = fields.weather_fetched_at ?? nowIso();
      rec.weather_speed_kmh = fields.weather_speed_kmh ?? 0;
    }
    if (fields.strava_status && fields.strava_status !== "unknown") {
      if (fields.strava_status === "uploaded" && rec.strava_status !== "uploaded") {
        rec.uploaded_at = nowIso();
      }
      rec.strava_status = fields.strava_status;
    }
    // Strava activity id, once Beeline reports it; never clear a known id with an
    // absent one (a later partial scan may not carry it).
    if (fields.strava_activity_id != null) rec.strava_activity_id = fields.strava_activity_id;
    // Seeing a ride again means it is NOT deleted (clear any stale flag).
    rec.deleted = false;
    rec.deleted_at = "";
    // Stamp the library ingest date once, the first time the ride is seen, and
    // never overwrite it on later syncs/checks (mirrors uploaded_at/deleted_at).
    if (!rec.ingested_at) rec.ingested_at = nowIso();
    rec.last_seen = nowIso();
    this.rides.set(uid, rec);
    return rec;
  }

  /**
   * Flag a known ride as deleted in the source. No-op for unknown keys or rides
   * already flagged (so `deleted_at` records the first time we noticed). Returns
   * true when this call newly flagged the ride.
   */
  markDeleted(key: string): boolean {
    const rec = this.rides.get(toUid(key));
    if (!rec || rec.deleted) return false;
    rec.deleted = true;
    rec.deleted_at = nowIso();
    this.rides.set(toUid(key), rec);
    return true;
  }

  /**
   * Permanently drop one ride record from the in-memory map (hard delete). Unlike
   * `markDeleted` (a tombstone), this removes the record entirely — the caller is
   * responsible for persisting (`save`) and for cleaning up any out-of-band blobs
   * (the full-GPX cache). Returns true when a record was actually removed.
   */
  remove(key: string): boolean {
    return this.rides.delete(toUid(key));
  }

  /**
   * Replace a known ride's tag list (the caller passes an already normalized +
   * deduped list; see tags.ts). Unlike `upsert`, this touches ONLY the tags — it
   * never clears the deleted flag or bumps `last_seen`, so tagging a ride (even a
   * deleted one) has no side effects. No-op for unknown keys. Returns true when the
   * list actually changed.
   */
  setTags(key: string, tags: string[]): boolean {
    const uid = toUid(key);
    const rec = this.rides.get(uid);
    if (!rec) return false;
    const next = [...tags];
    const prev = rec.tags ?? [];
    if (prev.length === next.length && prev.every((t, i) => t === next[i])) return false;
    rec.tags = next;
    this.rides.set(uid, rec);
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

  /** Update the Beeline upload concurrency and persist. Returns the clamped value. */
  setBeelineUploadConcurrency(n: number): number {
    this.settings.beelineUploadConcurrency = clampConcurrency(n);
    this.save();
    return this.settings.beelineUploadConcurrency;
  }

  /** Update the moving/stopped speed threshold (km/h) and persist. Returns the clamped value. */
  setMovingThreshold(n: number): number {
    this.settings.movingThresholdKmh = clampMovingThreshold(n);
    this.save();
    return this.settings.movingThresholdKmh;
  }

  /** Toggle the "offer to tag after GPX import" suggestion and persist. Returns the new value. */
  setSuggestTagsAfterImport(on: boolean): boolean {
    this.settings.suggestTagsAfterImport = on === true;
    this.save();
    return this.settings.suggestTagsAfterImport;
  }

  /**
   * Wipe all cached rides and restore default settings, removing the persisted
   * payload from storage. Local browser state only — this never touches the source.
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
    void this.backend.del(this.storageKey).catch(() => {
      /* storage unavailable — non-fatal, the in-memory state is already cleared */
    });
    this.refreshSize();
  }

  /** Recompute the cached payload size from the current in-memory state. */
  private refreshSize(): void {
    this.cachedBytes = byteLength(JSON.stringify(this.serialize()));
  }

  /** Byte size of the persisted payload (UTF-8), for a human-readable size hint. */
  byteSize(): number {
    return this.cachedBytes;
  }

  // -- import / export ---------------------------------------------------

  /**
   * Serialized JSON of the whole cache (settings + rides) for download. An optional
   * `meta` object is merged at the top of the file — the UI passes the app
   * version/commit/build so an exported state records which build produced it. The
   * persisted IndexedDB blob never carries `meta`; it lives only in the download.
   */
  exportJson(meta?: Record<string, unknown>): string {
    return JSON.stringify({ ...meta, ...this.serialize() }, null, 2);
  }

  /** Merge an exported state JSON into the store and persist. Returns count merged.
   *  A blob that isn't the current schema is rejected (nothing merged) — exports
   *  carry their `schema`, so a current export round-trips and a foreign/old file
   *  is cleanly ignored rather than half-imported. */
  importJson(text: string): number {
    const migrated = migrate(JSON.parse(text));
    if (!migrated) return 0;
    const before = this.rides.size;
    this.ingest(migrated);
    this.save();
    this.refreshSize();
    return this.rides.size - before;
  }
}
