/**
 * Beeline cloud-account ride source.
 *
 * Implements the `RideSource` seam over the Beeline backend client
 * ([beeline-api.ts](./beeline-api.ts)). It fetches the whole ride history —
 * tracks, stats and Strava status included — in a single request, so a "scan"
 * persists everything at once and check/preview become near-instant reads off
 * the cached snapshot.
 *
 * The three data methods synthesize the `RideCard` / `RideDetail` / `GpxFile`
 * shapes the seam exchanges, so the Controller's scan / check / upload / GPX
 * orchestration (queueing, persistence, deletion reconciliation, error reporting)
 * is driven uniformly through the `RideSource` interface.
 *
 * The backend calls are injected (`BeelineApi`) so tests can drive the full source
 * with an in-memory fake — no network, no real account.
 */

import {
  BeelineError,
  type BeelineSession,
  deleteRide,
  exportRideGpx,
  fetchRides,
  fetchStravaActivity,
  isTerminalStatus,
  mapBeelineRide,
  type RawBeelineRide,
  refreshSession,
  renameRide,
  signIn,
  stravaStatusOf,
  uploadRideToStrava,
} from "./beeline-api";
import {
  blankMetrics,
  type RideCard,
  type RideDetail,
  type RideMetrics,
  rideDatetime,
  rideShortLabel,
} from "./parsing";
import {
  type CatalogResult,
  type GpxFile,
  type GpxMode,
  gpxDownloadName,
  gpxFilename,
  type Progress,
  type RideSource,
  realSleep,
  type Sleep,
} from "./source";
import type { UpsertFields } from "./store";
import { encodedTrackToGpx, extractFullTrack, type FullTrack } from "./track";

/** The backend surface the source depends on — injectable so tests use a fake. */
export interface BeelineApi {
  fetchRides(session: BeelineSession): Promise<Record<string, RawBeelineRide>>;
  uploadRideToStrava(session: BeelineSession, pushId: string): Promise<void>;
  fetchStravaActivity(
    session: BeelineSession,
    pushId: string,
  ): Promise<RawBeelineRide["strava_activity"]>;
  renameRide(session: BeelineSession, pushId: string, newName: string): Promise<void>;
  deleteRide(session: BeelineSession, pushId: string): Promise<void>;
  /** Fetch one ride's full recorded GPX (decompressed bytes) from the cloud. */
  exportRideGpx(session: BeelineSession, pushId: string): Promise<Uint8Array>;
  /** Renew an expired/near-expiry session via its refresh token (no password). */
  refreshSession(session: BeelineSession): Promise<BeelineSession>;
}

const realApi: BeelineApi = {
  fetchRides,
  uploadRideToStrava,
  fetchStravaActivity,
  renameRide,
  deleteRide,
  exportRideGpx,
  refreshSession,
};

/** Phase of a silent session renewal, surfaced so the UI can give feedback. */
export type RenewPhase = "renewing" | "renewed" | "failed";

/** Optional dependency overrides (used by tests to avoid the network). */
export interface BeelineSourceDeps {
  api?: BeelineApi;
  signIn?: (email: string, password: string) => Promise<BeelineSession>;
  sleep?: Sleep;
  /** Called as the source silently renews its session, so the app can show feedback. */
  onRenew?: (phase: RenewPhase) => void;
}

/** How long before a token's hard expiry to renew it proactively (ms). */
const RENEW_MARGIN_MS = 120_000;

/** How long to poll a single ride's Strava upload before giving up (seconds). */
const UPLOAD_POLL_ATTEMPTS = 30;
const UPLOAD_POLL_INTERVAL_S = 1;

/**
 * Minimum spacing between full-GPX cloud exports (seconds). Each export is a real
 * server-side render + a ~500 KB storage download, so a batch is paced to at most
 * one ride per second — a deliberate, gentle ceiling on the load a client puts on
 * the Beeline backend, even when the user selects a whole year at once.
 */
const FULL_GPX_MIN_INTERVAL_S = 1;

export class BeelineRideSource implements RideSource {
  readonly kind = "beeline";

  /** Beeline rides can be uploaded to Strava (server-side), but are fetched from
   *  the cloud account, not imported from local files. */
  readonly capabilities = { upload: true, import: false };

  /** Last fetched rides, keyed by ride key → {pushId, raw record}. */
  private byKey = new Map<string, { pushId: string; raw: RawBeelineRide }>();

  private constructor(
    private session: BeelineSession,
    private readonly concurrency: () => number,
    private readonly api: BeelineApi,
    private readonly sleep: Sleep,
    private readonly onRenew: (phase: RenewPhase) => void,
  ) {}

  /**
   * Sign in and return a connected source. `concurrency` is read lazily so the
   * source always uses the user's current setting.
   */
  static async create(
    email: string,
    password: string,
    concurrency: () => number,
    deps: BeelineSourceDeps = {},
  ): Promise<BeelineRideSource> {
    const session = await (deps.signIn ?? signIn)(email, password);
    return new BeelineRideSource(
      session,
      concurrency,
      deps.api ?? realApi,
      deps.sleep ?? realSleep,
      deps.onRenew ?? (() => {}),
    );
  }

  /**
   * Run a backend call against a guaranteed-fresh session, renewing silently via the
   * refresh token when needed. Two triggers: PROACTIVE — if the token is within
   * `RENEW_MARGIN_MS` of expiry, renew before the call so a long batch never sends a
   * dead token; REACTIVE — if the call still fails with an `expired` error (the token
   * was rejected early), renew once and retry. When the refresh itself fails the error
   * surfaces as kind `expired` so the app can fall back to a full password sign-in.
   */
  private async withFreshSession<T>(fn: (s: BeelineSession) => Promise<T>): Promise<T> {
    if (Date.now() > this.session.expiresAt - RENEW_MARGIN_MS) {
      await this.renew();
    }
    try {
      return await fn(this.session);
    } catch (err) {
      if (!(err instanceof BeelineError && err.kind === "expired")) throw err;
      // Token rejected before our proactive window — renew once and retry.
      await this.renew();
      return fn(this.session);
    }
  }

  /** Replace the session with a freshly renewed one, reporting phases for feedback. */
  private async renew(): Promise<void> {
    this.onRenew("renewing");
    try {
      this.session = await this.api.refreshSession(this.session);
    } catch (err) {
      this.onRenew("failed");
      if (err instanceof BeelineError && err.kind === "expired") throw err;
      throw new BeelineError(
        `couldn't renew Beeline session: ${err instanceof Error ? err.message : String(err)}`,
        "expired",
      );
    }
    this.onRenew("renewed");
  }

  label(): string {
    return `Beeline (${this.session.email})`;
  }

  deviceFields(): UpsertFields {
    // source_id is per-ride (the push-id) and comes from each mapped record; here
    // we only stamp the constant attribution shared by every Beeline ride.
    return { source: "beeline", device_model: this.label() };
  }

  /** Fetch the whole history and rebuild the key→record index. Returns the cards. */
  private async refresh(since: Date | null): Promise<RideCard[]> {
    const rides = await this.withFreshSession((s) => this.api.fetchRides(s));
    this.byKey.clear();
    const cards: RideCard[] = [];
    for (const [pushId, raw] of Object.entries(rides)) {
      const mapped = mapBeelineRide(pushId, raw, this.label());
      if (!mapped) continue;
      this.byKey.set(mapped.key, { pushId, raw });
      if (since) {
        const dt = rideDatetime(mapped.key);
        if (!dt || dt < since) continue; // outside the requested window
      }
      cards.push({
        key: mapped.key,
        title: mapped.fields.title_base ?? "",
        distance_km: mapped.fields.distance_km ?? null,
        elapsed_sec: mapped.fields.elapsed_sec ?? null,
        fields: mapped.fields,
      });
    }
    return cards;
  }

  async enumerateCatalog(
    progress: Progress = () => false,
    since: Date | null = null,
    onCards: (cards: RideCard[]) => void = () => {},
  ): Promise<CatalogResult> {
    if (await progress("downloading rides from Beeline…"))
      return { cards: [], complete: false };
    const cards = await this.refresh(since);
    if (await progress(`mapping ${cards.length} rides…`)) return { cards, complete: false };
    onCards(cards);
    // We always read the COMPLETE history in one request, so unseen-but-known rides
    // within the window can be safely reconciled as deleted by the Controller.
    return { cards, complete: true };
  }

  /** Build a RideDetail (the Controller's per-ride persistence unit) from a record. */
  private detailFor(key: string, raw: RawBeelineRide): RideDetail {
    const mapped = mapBeelineRide(key, raw, this.label());
    const f = mapped?.fields;
    const metrics: RideMetrics = f
      ? {
          distance_km: f.distance_km ?? null,
          moving_sec: f.moving_sec ?? null,
          elapsed_sec: f.elapsed_sec ?? null,
          avg_speed_kmh: f.avg_speed_kmh ?? null,
          max_speed_kmh: f.max_speed_kmh ?? null,
          elevation_gain_m: f.elevation_gain_m ?? null,
          elevation_loss_m: f.elevation_loss_m ?? null,
        }
      : blankMetrics();
    return {
      key,
      title: f?.title_base ?? "",
      metrics,
      stravaStatus: f?.strava_status ?? "unknown",
    };
  }

  async processTargets(
    keys: Set<string>,
    progress: Progress = () => false,
    onDetail: (detail: RideDetail) => void = () => {},
    onMissing: (keys: string[]) => void = () => {},
    onError: (key: string, reason: string) => void = () => {},
  ): Promise<RideDetail[]> {
    if (await progress("refreshing rides from Beeline…")) return [];
    await this.refresh(null);

    // Split requested keys into found vs. vanished (deleted on the server).
    const found: string[] = [];
    const missing: string[] = [];
    for (const key of keys) {
      if (this.byKey.has(key)) found.push(key);
      else missing.push(key);
    }
    if (missing.length) onMissing(missing);

    const results: RideDetail[] = [];
    let cancelled = false;
    const rep: Progress = async (msg) => {
      const stop = await progress(msg);
      if (stop) cancelled = true;
      return stop;
    };

    const handle = async (key: string): Promise<void> => {
      const entry = this.byKey.get(key);
      if (!entry) return;
      const name = rideShortLabel(key) || key;
      try {
        let raw = entry.raw;
        if (stravaStatusOf(raw) === "pending") {
          raw = await this.uploadOne(entry.pushId, raw, name, rep);
        } else {
          await rep(`skipping ${name} — already ${stravaStatusOf(raw)}`);
        }
        const detail = this.detailFor(key, raw);
        results.push(detail);
        onDetail(detail);
      } catch (err) {
        onError(key, err instanceof Error ? err.message : String(err));
      }
    };

    // Beeline uploads are independent network calls, so run them through a bounded
    // pool (uploads can be slow; concurrency is the whole point of this source).
    const poolSize = Math.max(1, this.concurrency());
    await runPool(found, poolSize, handle, () => cancelled);
    return results;
  }

  /** Trigger one Strava upload and poll its status node to a terminal state. */
  private async uploadOne(
    pushId: string,
    raw: RawBeelineRide,
    name: string,
    progress: Progress,
  ): Promise<RawBeelineRide> {
    await progress(`uploading to Strava: ${name}…`);
    await this.withFreshSession((s) => this.api.uploadRideToStrava(s, pushId));
    let current = raw;
    for (let i = 0; i < UPLOAD_POLL_ATTEMPTS; i++) {
      const act = await this.withFreshSession((s) => this.api.fetchStravaActivity(s, pushId));
      current = { ...current, strava_activity: act };
      if (isTerminalStatus(stravaStatusOf(current))) break;
      if (await progress(`waiting for Strava: ${name}…`)) break;
      await this.sleep(UPLOAD_POLL_INTERVAL_S);
    }
    return current;
  }

  async downloadGpx(
    keys: Set<string>,
    progress: Progress = () => false,
    onGpx: (file: GpxFile) => void = () => {},
    onMissing: (keys: string[]) => void = () => {},
    onFail: (key: string, reason: string, retryable?: boolean) => void = () => {},
    onDetail: (detail: RideDetail) => void = () => {},
    mode: GpxMode = "light",
  ): Promise<GpxFile[]> {
    if (this.byKey.size === 0) await this.refresh(null);

    // Split requested keys into found vs. vanished (deleted on the server).
    const found: string[] = [];
    const missing: string[] = [];
    for (const key of keys) {
      if (this.byKey.has(key)) found.push(key);
      else missing.push(key);
    }
    if (missing.length) onMissing(missing);

    const results: GpxFile[] = [];
    let cancelled = false;
    const rep: Progress = async (msg) => {
      const stop = await progress(msg);
      if (stop) cancelled = true;
      return stop;
    };

    if (mode === "full") {
      // Full mode: fetch each ride's real recorded track from the cloud. Each one is
      // a server-side render + a ~500 KB download, so we DON'T fan these out — they
      // run sequentially, paced to at most one export per second, to keep a gentle,
      // deliberate ceiling on the load a client puts on the Beeline backend (a
      // year's worth of selected rides would otherwise hammer it). The pacing holds
      // out only the *remainder* of the 1 s window after each export, so a slow
      // render that already took ≥1 s adds no extra wait.
      for (let i = 0; i < found.length; i++) {
        if (cancelled) break;
        const key = found[i];
        const entry = this.byKey.get(key);
        if (!entry) continue;
        const name = rideShortLabel(key) || key;
        const detail = this.detailFor(key, entry.raw);
        onDetail(detail);
        if (await rep(`downloading full GPX: ${name}…`)) break;
        const startedAt = Date.now();
        try {
          const bytes = await this.withFreshSession((s) =>
            this.api.exportRideGpx(s, entry.pushId),
          );
          const file: GpxFile = {
            key,
            filename: gpxFilename(key),
            downloadName: gpxDownloadName(key, detail.title),
            bytes,
          };
          results.push(file);
          onGpx(file);
        } catch (err) {
          // `unreachable` failures (gateway/network down) are retryable, so the
          // Controller can degrade to a route-only GPX instead of hard-failing.
          const retryable = err instanceof BeelineError && err.kind === "unreachable";
          onFail(key, err instanceof Error ? err.message : String(err), retryable);
        }
        // Pace the next ride: wait out the rest of the 1 s window (skip after the
        // last ride and once cancelled).
        if (i < found.length - 1 && !cancelled) {
          const elapsedS = (Date.now() - startedAt) / 1000;
          const remaining = FULL_GPX_MIN_INTERVAL_S - elapsedS;
          if (remaining > 0) await this.sleep(remaining);
        }
      }
      return results;
    }

    // Light mode: synthesize a shape-only GPX from the cached polyline. Instant and
    // entirely local, so a simple sequential pass is plenty.
    for (const key of found) {
      const entry = this.byKey.get(key);
      if (!entry) continue;
      const name = rideShortLabel(key) || key;
      if (await rep(`building GPX: ${name}…`)) break;
      const detail = this.detailFor(key, entry.raw);
      onDetail(detail);
      const file = synthesizeGpx(key, entry.raw, detail.title);
      if (!file) {
        onFail(key, "ride has no route track to export");
        continue;
      }
      results.push(file);
      onGpx(file);
    }
    return results;
  }

  async fetchFullTrack(
    key: string,
    progress: Progress = () => false,
  ): Promise<{ track: FullTrack; bytes: Uint8Array }> {
    const name = rideShortLabel(key) || key;
    await progress(`downloading full track: ${name}…`);
    const pushId = await this.resolvePushId(key);
    const bytes = await this.withFreshSession((s) => this.api.exportRideGpx(s, pushId));
    return { track: extractFullTrack(new TextDecoder().decode(bytes)), bytes };
  }

  /**
   * Resolve a ride key to its backend push-id, refreshing the index first when the
   * source is cold (e.g. after an offline re-auth, before any scan this session).
   * Throws when the ride is unknown to the backend (already deleted there).
   */
  private async resolvePushId(key: string): Promise<string> {
    if (this.byKey.size === 0) await this.refresh(null);
    let entry = this.byKey.get(key);
    if (!entry) {
      // Re-read once in case our cached index is simply stale.
      await this.refresh(null);
      entry = this.byKey.get(key);
    }
    if (!entry) throw new Error(`ride not found on Beeline: ${rideShortLabel(key) || key}`);
    return entry.pushId;
  }

  async renameRide(
    key: string,
    newTitle: string,
    progress: Progress = () => false,
  ): Promise<RideDetail> {
    const name = rideShortLabel(key) || key;
    await progress(`renaming ${name}…`);
    const pushId = await this.resolvePushId(key);
    await this.withFreshSession((s) => this.api.renameRide(s, pushId, newTitle));
    // Reflect the new name in the cached record so re-reads (and the returned
    // detail) carry it without a full refresh.
    const entry = this.byKey.get(key);
    if (entry) {
      entry.raw = { ...entry.raw, name: newTitle };
      this.byKey.set(key, entry);
    }
    return this.detailFor(key, entry?.raw ?? { name: newTitle });
  }

  async deleteRide(key: string, progress: Progress = () => false): Promise<void> {
    const name = rideShortLabel(key) || key;
    await progress(`deleting ${name}…`);
    const pushId = await this.resolvePushId(key);
    await this.withFreshSession((s) => this.api.deleteRide(s, pushId));
    this.byKey.delete(key);
  }

  async close(): Promise<void> {
    this.byKey.clear();
  }
}

/**
 * Run `worker` over `items` with at most `size` in flight at once, stopping early
 * (no new work started) once `shouldStop` returns true. Errors are the worker's
 * own responsibility — it must not reject, so one bad item can't sink the pool.
 */
async function runPool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      await worker(item);
    }
  };
  const workers = Array.from({ length: Math.min(size, items.length) }, runner);
  await Promise.all(workers);
}

/**
 * Build a minimal GPX file from a Beeline ride's inline polyline. Uses the FULL
 * decoded track (not the simplified preview) so a saved file keeps the route's real
 * shape. Returns null when the ride has no usable polyline.
 */
function synthesizeGpx(key: string, raw: RawBeelineRide, title: string): GpxFile | null {
  if (!raw.polyline) return null;
  const name = title || rideShortLabel(key) || key;
  const xml = encodedTrackToGpx(raw.polyline, name);
  if (!xml) return null;
  return {
    key,
    filename: gpxFilename(key),
    downloadName: gpxDownloadName(key, title),
    bytes: new TextEncoder().encode(xml),
  };
}
