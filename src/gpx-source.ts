/**
 * The pure-GPX ride source: user-supplied `.gpx` files (and `.zip` bundles of them)
 * become rides that coexist with every other source's in one Store.
 *
 * Unlike the Beeline source, this one talks to no backend — everything is derived
 * locally from the file the user hands us:
 *   - metrics (distance / elevation / speed / elapsed) come from the recorded track
 *     (`fullTrackSummary`); `moving_sec` is left unknown (a GPX carries no notion of
 *     "moving" vs "stopped" without a heuristic we deliberately don't apply yet).
 *   - the start instant (and thus the ride key) is the first `<time>` in the track,
 *     else a `YYYY-MM-DD[ HH-MM]` prefix in the filename, else the file's modified
 *     time.
 *   - the title is the GPX's own `<name>`/`<desc>`, else a name parsed from the
 *     filename, else a Strava-style time-of-day fallback ("Morning ride").
 *
 * It has NO upload capability (Strava upload is a Beeline server-side feature), so
 * its `capabilities.upload` is false and the UI never offers Upload on a GPX ride.
 *
 * The original GPX bytes are stashed (gzipped) in the shared GPX cache under the
 * ride's cross-source uid, so the full-track map and a "Save full GPX" export are
 * served locally and offline — the same cache the Controller reads from.
 */

import type { GpxCache } from "./gpxcache";
import {
  beelineRideKey,
  blankMetrics,
  type RideCard,
  type RideDetail,
  rideUid,
  timeOfDayName,
} from "./parsing";
import type {
  CatalogResult,
  GpxFile,
  GpxMode,
  ImportResult,
  Progress,
  RideSource,
} from "./source";
import { gpxDownloadName, gpxFilename } from "./source";
import { extractFullTrack, fullTrackSummary, gpxToRoughTrack } from "./track";
import { crc32, unzip } from "./zip";

const decoder = new TextDecoder();

/** A GPX payload to import, already extracted from any enclosing `.zip`. */
interface RawGpx {
  filename: string;
  bytes: Uint8Array;
  /** The source File's last-modified instant (ms) — the final start-time fallback. */
  lastModified: number;
}

export class GpxRideSource implements RideSource {
  readonly kind = "gpx";

  /** Imported from local files, never uploaded to Strava (that's a Beeline feature). */
  readonly capabilities = { upload: false, import: true };

  /** Session copy of each imported original, keyed by datetime key — the seam's
   *  per-source namespace. Backs `fetchFullTrack`/`downloadGpx` without re-reading
   *  the gzip store; the persistent copy lives in the `gpxData` vault under the uid. */
  private readonly originals = new Map<string, Uint8Array>();

  /**
   * @param gpxData the imported-GPX **data vault** (NOT the re-fetchable cache): the
   *        only persistent home of an imported ride's original bytes. The Controller
   *        reads the same instance, and a cache flush never touches it.
   * @param pointsPerKm rough-track density, read lazily so it tracks the user setting.
   */
  constructor(
    private readonly gpxData: GpxCache,
    private readonly pointsPerKm: () => number,
  ) {}

  label(): string {
    return "GPX files";
  }

  deviceFields() {
    return { source: "gpx" as const, device_model: "GPX files" };
  }

  /** GPX rides are added by import, never enumerated — nothing to scan. */
  async enumerateCatalog(): Promise<CatalogResult> {
    return { cards: [], complete: false };
  }

  async importFiles(
    files: File[],
    onCard: (card: RideCard) => void,
    progress?: Progress,
  ): Promise<ImportResult> {
    const skipped: string[] = [];
    // Expand any .zip bundles into their .gpx members first, so a folder export and
    // loose files import identically.
    const gpx: RawGpx[] = [];
    for (const f of files) {
      const name = f.name;
      const lower = name.toLowerCase();
      try {
        if (lower.endsWith(".zip")) {
          const entries = await unzip(await fileBytes(f));
          const inner = entries.filter((e) => e.name.toLowerCase().endsWith(".gpx"));
          if (inner.length === 0) {
            skipped.push(`${name}: no .gpx files inside`);
            continue;
          }
          for (const e of inner) {
            gpx.push({
              filename: baseName(e.name),
              bytes: e.bytes,
              lastModified: f.lastModified,
            });
          }
        } else if (lower.endsWith(".gpx")) {
          gpx.push({
            filename: name,
            bytes: await fileBytes(f),
            lastModified: f.lastModified,
          });
        } else {
          skipped.push(`${name}: not a .gpx or .zip file`);
        }
      } catch (err) {
        skipped.push(`${name}: ${errMessage(err)}`);
      }
    }

    let done = 0;
    for (const g of gpx) {
      if (await progress?.(`importing ${g.filename} (${++done}/${gpx.length})…`)) break;
      try {
        const card = await this.importOne(g);
        if (card) onCard(card);
        else skipped.push(`${g.filename}: no GPS track points`);
      } catch (err) {
        skipped.push(`${g.filename}: ${errMessage(err)}`);
      }
    }
    return { skipped };
  }

  /** Parse one GPX into a RideCard, caching its original bytes for later full export. */
  private async importOne(g: RawGpx): Promise<RideCard | null> {
    const xml = decoder.decode(g.bytes);
    const ft = extractFullTrack(xml);
    if (ft.points.length === 0) return null;
    const summary = fullTrackSummary(ft);

    // Start instant: first recorded <time> → filename date → file mtime.
    const firstTime = ft.times.find((t): t is number => t != null) ?? null;
    const fromName = parseGpxFilename(g.filename);
    const startMs = firstTime ?? fromName.startMs ?? g.lastModified;
    const dateKey = beelineRideKey(startMs);
    if (!dateKey) return null;

    // Content-addressed identity: distinct files become distinct rides regardless of
    // their start minute (route GPX with no <time>, all falling back to a shared file
    // mtime, would otherwise collapse into one ride), and re-importing the same bytes
    // is idempotent (same id → updates the same ride). The display datetime stays in
    // `key` for all sort/bucket/stats; identity is purely the storage handle.
    const identity = await contentId(g.bytes);

    // Title: GPX's own name/desc → a name parsed from the filename → time-of-day.
    const base = extractGpxName(xml) || fromName.name || timeOfDayName(startMs);
    const place = fromName.place;
    const fullTitle = place ? `${base}, ${place}` : base;

    const rough = gpxToRoughTrack(g.bytes, this.pointsPerKm());
    const distance_km = summary.distanceKm > 0 ? summary.distanceKm : null;
    const elapsed_sec = summary.recordedSec;

    // Persist the original (gzipped) under the ride's cross-source uid in the data
    // vault so the full-track map + "Save full GPX" work locally/offline, and keep a
    // session copy. This is the ride's ONLY copy — primary data, never the cache.
    // Both are keyed by the content identity (the uid suffix), not the datetime.
    this.originals.set(identity, g.bytes);
    await this.gpxData.put(rideUid(this.kind, identity), g.bytes);

    return {
      key: dateKey,
      identity,
      title: base,
      distance_km,
      elapsed_sec,
      fields: {
        ...blankMetrics(),
        key: dateKey,
        source: this.kind,
        source_id: identity,
        title: fullTitle,
        title_base: base,
        distance_km,
        elapsed_sec,
        avg_speed_kmh: summary.avgKmh,
        max_speed_kmh: summary.maxKmh,
        elevation_gain_m: summary.gainM,
        elevation_loss_m: summary.lossM,
        track: rough.polyline,
        track_src_points: rough.srcPoints,
        track_points: rough.keptPoints,
        track_km: rough.km,
        track_bytes: g.bytes.length,
      },
    };
  }

  /** GPX rides never upload to Strava — a no-op so a mixed bulk action skips them. */
  async processTargets(): Promise<RideDetail[]> {
    return [];
  }

  /**
   * Hand back each ride's GPX. A GPX ride's "full" and "light" file is simply its
   * original recorded track (already a real GPX), served from the session/disk
   * cache. In practice the Controller serves these locally (the ride carries a
   * track / its original is cached), so this is a rarely-exercised fallback.
   */
  async downloadGpx(
    keys: Set<string>,
    _progress?: Progress,
    onGpx?: (file: GpxFile) => void,
    onMissing?: (keys: string[]) => void,
    onFail?: (key: string, reason: string, retryable?: boolean) => void,
    _onDetail?: (detail: RideDetail) => void,
    _mode?: GpxMode,
  ): Promise<GpxFile[]> {
    const out: GpxFile[] = [];
    const missing: string[] = [];
    for (const key of keys) {
      const bytes = await this.bytesFor(key);
      if (!bytes) {
        onFail?.(key, "the imported GPX is no longer in the cache", false);
        missing.push(key);
        continue;
      }
      const uid = rideUid(this.kind, key);
      const file: GpxFile = {
        key,
        filename: gpxFilename(uid),
        downloadName: gpxDownloadName(uid, ""),
        bytes,
      };
      out.push(file);
      onGpx?.(file);
    }
    if (missing.length) onMissing?.([]); // nothing to reconcile — these aren't deletions
    return out;
  }

  async fetchFullTrack(key: string) {
    const bytes = await this.bytesFor(key);
    if (!bytes) throw new Error("the imported GPX is no longer in the cache");
    return { track: extractFullTrack(decoder.decode(bytes)), bytes };
  }

  /** Rename happens locally — there's no backend; the Controller mirrors the result
   *  into the Store. Blank metrics so the upsert never clobbers known figures. */
  async renameRide(key: string, newTitle: string): Promise<RideDetail> {
    return { key, title: newTitle, metrics: blankMetrics(), stravaStatus: "unknown" };
  }

  /** Drop the imported original; the Controller tombstones the record. */
  async deleteRide(key: string): Promise<void> {
    this.originals.delete(key);
    await this.gpxData.delete(rideUid(this.kind, key));
  }

  async close(): Promise<void> {
    this.originals.clear();
  }

  /** Imported original bytes for a ride key: session copy first, then the disk cache. */
  private async bytesFor(key: string): Promise<Uint8Array | null> {
    return this.originals.get(key) ?? (await this.gpxData.get(rideUid(this.kind, key)));
  }
}

// -- filename / GPX metadata helpers -----------------------------------------

/** Read a File's bytes. Prefers the modern `Blob.arrayBuffer()` (all evergreen
 *  browsers) and falls back to `FileReader` for environments that lack it (notably
 *  the jsdom used in tests). */
async function fileBytes(f: File): Promise<Uint8Array> {
  if (typeof f.arrayBuffer === "function") return new Uint8Array(await f.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsArrayBuffer(f);
  });
}

/** The final path segment of a (possibly nested) zip entry name. */
function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** A short, human reason from a thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A content-addressed identity for an imported GPX — `sha256:<32 hex>`, the first
 * 128 bits of the bytes' SHA-256. Same bytes → same id (idempotent re-import);
 * different bytes → different id, with no realistic collision at any ride count, so
 * two distinct files never overwrite one another in the Store. 128 bits is far past
 * the point of birthday concerns (≈1e-18 at a billion rides).
 *
 * Falls back to `crc32:<hex>-<len>` only where SubtleCrypto is unavailable (which
 * no evergreen browser nor Node ≥20 is) — still keyed on content, just weaker.
 */
async function contentId(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // Copy into a fresh ArrayBuffer-backed view so the digest input is a plain
    // BufferSource (the source bytes may be a subarray over a SharedArrayBuffer).
    const digest = await subtle.digest("SHA-256", new Uint8Array(bytes));
    const hex = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return `sha256:${hex.slice(0, 32)}`;
  }
  return `crc32:${crc32(bytes).toString(16)}-${bytes.length}`;
}


interface FilenameMeta {
  /** Start instant parsed from a leading `YYYY-MM-DD[ HH-MM]`, else null. */
  startMs: number | null;
  /** Ride name parsed from the filename (after any date prefix, before `, place`). */
  name: string;
  /** Trailing `, place` location suffix from the filename, else "". */
  place: string;
}

const FILENAME_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ _tT](\d{2})[-:.](\d{2}))?\s*[-–—]?\s*(.*)$/;

/**
 * Parse a convention-named GPX filename like `2026-06-13 Morning ride, Amsterdam`
 * or `2026-06-13 14-22 Evening ride`. A leading ISO date (optionally with an
 * `HH-MM`/`HH:MM` time) seeds the start instant; the remainder is the ride name,
 * with a trailing `, place` split off as the location suffix. With no date prefix
 * the whole stem is treated as the name.
 */
export function parseGpxFilename(filename: string): FilenameMeta {
  const stem = filename.replace(/\.gpx$/i, "").trim();
  const m = FILENAME_DATE_RE.exec(stem);
  if (!m) return { startMs: null, ...splitNamePlace(stem) };
  const [, y, mo, d, hh, mm, rest] = m;
  const dt = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    hh ? Number(hh) : 12,
    mm ? Number(mm) : 0,
    0,
    0,
  );
  const startMs = Number.isNaN(dt.getTime()) ? null : dt.getTime();
  return { startMs, ...splitNamePlace(rest.trim()) };
}

/** Split a `name, place` string into its name and trailing place suffix. */
function splitNamePlace(s: string): { name: string; place: string } {
  const i = s.lastIndexOf(", ");
  if (i > 0) return { name: s.slice(0, i).trim(), place: s.slice(i + 2).trim() };
  return { name: s.trim(), place: "" };
}

/**
 * The ride name carried inside a GPX: the track's `<name>`, else the document
 * `<metadata><name>`, else either's `<desc>`. Returns "" when the GPX names nothing.
 */
export function extractGpxName(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  // Namespace-tolerant first-child-text lookup (real GPX declares a default xmlns
  // some parsers won't match via getElementsByTagName — see track.ts byTag).
  const firstByTag = (parent: Element | Document, tag: string): Element | undefined =>
    parent.getElementsByTagName(tag)[0] ?? parent.getElementsByTagNameNS("*", tag)[0];
  const text = (tag: string, parent?: Element): string => {
    const root: Element | Document = parent ?? doc;
    return firstByTag(root, tag)?.textContent?.trim() ?? "";
  };
  const trk = firstByTag(doc, "trk");
  const metadata = firstByTag(doc, "metadata");
  return (
    (trk && text("name", trk)) ||
    (metadata && text("name", metadata)) ||
    (trk && text("desc", trk)) ||
    (metadata && text("desc", metadata)) ||
    ""
  );
}
