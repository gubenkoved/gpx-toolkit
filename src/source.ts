/**
 * Ride-source abstraction — the seam the Controller drives to obtain ride data
 * and act on Strava, without knowing which backend answers.
 *
 * The Controller owns the job queue, the Store, deletion reconciliation and all
 * progress/error handling; a `RideSource` only answers "how do I obtain ride data
 * and act on Strava". The single implementation today is `BeelineRideSource`
 * (see beeline-source.ts), which talks to the Beeline cloud backend; a demo fake
 * backs the account-free demo. The seam keeps the orchestration backend-agnostic.
 *
 * This module also hosts the small set of shared, backend-neutral types and
 * helpers the seam and its implementations exchange (GPX file/naming, the catalog
 * result, the progress callback, and the injectable sleep used for pacing/tests).
 */

import { type RideCard, type RideDetail, rideDatetime } from "./parsing";
import type { UpsertFields } from "./store";
import type { FullTrack } from "./track";

/** Which backend a source talks to (mirrors RideRecord.source). */
export type SourceKind = "beeline";

// -- shared, backend-neutral seam types --------------------------------------

/** A GPX file produced for one ride. */
export interface GpxFile {
  key: string;
  filename: string;
  /** Sort-friendly name for the browser download (see `gpxDownloadName`). */
  downloadName: string;
  bytes: Uint8Array;
}

/** Per-ride outcome of a GPX export. */
export type GpxExport = { ok: true; file: GpxFile } | { ok: false; reason: string };

/**
 * Which GPX a download produces:
 * - `light` — the lightweight, shape-only file synthesized from the stored route
 *   polyline (no timestamps/elevation; instant, local, no network).
 * - `full`  — the genuine recorded track fetched from the backend on demand, with
 *   real per-point `<time>` and `<ele>` (richer, but a network round-trip per ride).
 */
export type GpxMode = "light" | "full";

/** Result of a catalogue scan. `complete` is true only when the ride list was
 *  read end-to-end — the precondition for trusting that an in-window ride we knew
 *  about but didn't see has been deleted. A scan cut short by the user reports
 *  `complete: false`, so callers must NOT reconcile deletions from it. */
export interface CatalogResult {
  cards: RideCard[];
  complete: boolean;
}

// A callback the long-running passes call to report progress and check for cancel.
// It receives a short status message; returning true asks the operation to stop.
export type Progress = (msg: string) => boolean | Promise<boolean>;

/** Sleep helper used for pacing; injectable so tests can make it instant. */
export type Sleep = (seconds: number) => Promise<void>;

export const realSleep: Sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));

/**
 * A deterministic, collision-free GPX filename derived from a ride's (unique)
 * datetime key, so two rides that share a title never clobber each other.
 */
export function gpxFilename(key: string): string {
  const slug = key.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Beeline-${slug || "ride"}.gpx`;
}

/**
 * A human-friendly, sort-friendly name to offer in the browser's "Save As".
 * Leads with an ISO-ish `YYYY-MM-DD HH-MM` stamp so saved files sort
 * chronologically, then appends the ride's own title. Colons are rendered as `-`
 * (illegal in filenames), and any path separators / control chars in the title
 * are stripped. Falls back to a stamp-only name when the title is empty, and to
 * the device filename when the key can't be parsed into a date.
 */
export function gpxDownloadName(key: string, title: string): string {
  const dt = rideDatetime(key);
  if (dt === null) return gpxFilename(key);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())} ` +
    `${p2(dt.getHours())}-${p2(dt.getMinutes())}`;
  // Strip path separators and control chars; collapse runs of whitespace.
  const clean = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strips C0 control chars (\x00-\x1f) so they can't land in a filename.
    .replace(/[/\\<>:"|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? `${stamp} - ${clean}.gpx` : `${stamp}.gpx`;
}

// -- the seam ----------------------------------------------------------------

/**
 * Everything the Controller needs from a ride backend. The data methods stream
 * results via callbacks so the Controller's scan / check / upload / GPX
 * orchestration stays identical regardless of backend.
 */
export interface RideSource {
  /** Which backend this is. */
  readonly kind: SourceKind;

  /** Human label for the connection (shown in the UI, e.g. "Pixel 10 Pro" / "Beeline (a@b)"). */
  label(): string;

  /**
   * Per-ride attribution merged into every upsert the Controller makes for this
   * source — carries `source`/`source_id` plus any device identity. Empty fields
   * are omitted so they never clobber known values.
   */
  deviceFields(): UpsertFields;

  /** Discover rides in the time window, streaming pages via `onCards`. */
  enumerateCatalog(
    progress?: Progress,
    since?: Date | null,
    onCards?: (cards: RideCard[]) => void,
  ): Promise<CatalogResult>;

  /** Upload the given pending rides to Strava, streaming each result via `onDetail`. */
  processTargets(
    keys: Set<string>,
    progress?: Progress,
    onDetail?: (detail: RideDetail) => void,
    onMissing?: (keys: string[]) => void,
    onError?: (key: string, reason: string) => void,
  ): Promise<RideDetail[]>;

  /** Obtain a GPX file per ride, streaming each via `onGpx`. The `mode` selects the
   *  lightweight stored-shape export or the full recorded track (see `GpxMode`).
   *  `onFail`'s `retryable` is true when the failure was a transient/unreachable
   *  export gateway (vs. a genuine "ride has no track") — letting the caller decide
   *  to degrade gracefully. */
  downloadGpx(
    keys: Set<string>,
    progress?: Progress,
    onGpx?: (file: GpxFile) => void,
    onMissing?: (keys: string[]) => void,
    onFail?: (key: string, reason: string, retryable?: boolean) => void,
    onDetail?: (detail: RideDetail) => void,
    mode?: GpxMode,
  ): Promise<GpxFile[]>;

  /** Fetch one ride's FULL recorded track (real per-point time + elevation) on
   *  demand. Throws when the ride has no recorded points to export. */
  fetchFullTrack(key: string, progress?: Progress): Promise<FullTrack>;

  /** Rename a ride on the backend; resolves to the updated detail. */
  renameRide(key: string, newTitle: string, progress?: Progress): Promise<RideDetail>;

  /** Permanently delete a ride on the backend. */
  deleteRide(key: string, progress?: Progress): Promise<void>;

  /** Release the underlying connection (clears the session). */
  close(): Promise<void>;
}

/** A factory the Controller calls on connect to obtain its (already-connected) source. */
export type SourceFactory = () => Promise<RideSource>;
