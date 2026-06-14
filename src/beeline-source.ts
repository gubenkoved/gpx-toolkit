/**
 * Beeline cloud-account ride source.
 *
 * Implements the `RideSource` seam over the Beeline backend client
 * ([beeline-api.ts](./beeline-api.ts)). Where the ADB source drives the phone UI
 * one ride at a time, this fetches the whole ride history — tracks, stats and
 * Strava status included — in a single request, so a "scan" persists everything
 * at once and check/preview become near-instant reads off the cached snapshot.
 *
 * The three data methods synthesize the same `RideCard` / `RideDetail` / `GpxFile`
 * shapes the ADB path produces, so the Controller's scan / check / upload / GPX
 * orchestration (queueing, persistence, deletion reconciliation, error reporting)
 * is identical regardless of source.
 *
 * The backend calls are injected (`BeelineApi`) so tests can drive the full source
 * with an in-memory fake — no network, no real account.
 */

import { realSleep, type Sleep } from "./adb/types";
import {
  type CatalogResult,
  type GpxFile,
  gpxDownloadName,
  gpxFilename,
  type Progress,
} from "./beeline";
import {
  type BeelineSession,
  fetchRides,
  fetchStravaActivity,
  isTerminalStatus,
  mapBeelineRide,
  type RawBeelineRide,
  signIn,
  stravaStatusOf,
  uploadRideToStrava,
} from "./beeline-api";
import { type RideCard, type RideDetail, rideDatetime, rideShortLabel } from "./parsing";
import type { RideSource } from "./source";
import type { UpsertFields } from "./store";
import { encodedTrackToGpx } from "./track";

/** The backend surface the source depends on — injectable so tests use a fake. */
export interface BeelineApi {
  fetchRides(session: BeelineSession): Promise<Record<string, RawBeelineRide>>;
  uploadRideToStrava(session: BeelineSession, pushId: string): Promise<void>;
  fetchStravaActivity(
    session: BeelineSession,
    pushId: string,
  ): Promise<RawBeelineRide["strava_activity"]>;
}

const realApi: BeelineApi = { fetchRides, uploadRideToStrava, fetchStravaActivity };

/** Optional dependency overrides (used by tests to avoid the network). */
export interface BeelineSourceDeps {
  api?: BeelineApi;
  signIn?: (email: string, password: string) => Promise<BeelineSession>;
  sleep?: Sleep;
}

/** How long to poll a single ride's Strava upload before giving up (seconds). */
const UPLOAD_POLL_ATTEMPTS = 30;
const UPLOAD_POLL_INTERVAL_S = 1;

export class BeelineRideSource implements RideSource {
  readonly kind = "beeline";

  /** Last fetched rides, keyed by ride key → {pushId, raw record}. */
  private byKey = new Map<string, { pushId: string; raw: RawBeelineRide }>();

  private constructor(
    private session: BeelineSession,
    private readonly concurrency: () => number,
    private readonly api: BeelineApi,
    private readonly sleep: Sleep,
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
    );
  }

  label(): string {
    return `Beeline (${this.session.email})`;
  }

  deviceFields(): UpsertFields {
    // source_id is per-ride (the push-id) and comes from each mapped record; here
    // we only stamp the constant attribution shared by every Beeline ride.
    return { source: "beeline", device_model: this.label() };
  }

  setTiming(): void {
    /* no UI pacing for an HTTP source */
  }

  /** Fetch the whole history and rebuild the key→record index. Returns the cards. */
  private async refresh(since: Date | null): Promise<RideCard[]> {
    const rides = await this.api.fetchRides(this.session);
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
        distance: mapped.fields.distance ?? "",
        duration: mapped.fields.duration ?? "",
        tapY: 0,
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
    const fields = mapped?.fields;
    return {
      key,
      title: fields?.title_base ?? "",
      stats: fields?.stats ?? {},
      stravaStatus: fields?.strava_status ?? "unknown",
      stravaTap: null,
    };
  }

  async processTargets(
    keys: Set<string>,
    doUpload: boolean,
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
        if (doUpload && stravaStatusOf(raw) === "pending") {
          raw = await this.uploadOne(entry.pushId, raw, name, rep);
        } else {
          await rep(`checked: ${name} — ${stravaStatusOf(raw)}`);
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
    // Checks are instant snapshot reads, so a single worker is plenty.
    const poolSize = doUpload ? Math.max(1, this.concurrency()) : 1;
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
    await this.api.uploadRideToStrava(this.session, pushId);
    let current = raw;
    for (let i = 0; i < UPLOAD_POLL_ATTEMPTS; i++) {
      const act = await this.api.fetchStravaActivity(this.session, pushId);
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
    onFail: (key: string, reason: string) => void = () => {},
    onDetail: (detail: RideDetail) => void = () => {},
  ): Promise<GpxFile[]> {
    if (this.byKey.size === 0) await this.refresh(null);

    const results: GpxFile[] = [];
    const missing: string[] = [];
    for (const key of keys) {
      const entry = this.byKey.get(key);
      const name = rideShortLabel(key) || key;
      if (!entry) {
        missing.push(key);
        continue;
      }
      if (await progress(`building GPX: ${name}…`)) break;
      // Record the ride's detail too, mirroring the ADB GPX flow.
      onDetail(this.detailFor(key, entry.raw));
      const file = synthesizeGpx(key, entry.raw, this.detailFor(key, entry.raw).title);
      if (!file) {
        onFail(key, "ride has no route track to export");
        continue;
      }
      results.push(file);
      onGpx(file);
    }
    if (missing.length) onMissing(missing);
    return results;
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
