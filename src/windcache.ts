/**
 * Global cache of historical wind, keyed by (dataset, grid-cell, day).
 *
 * Wind at a place and time is *universal* — it doesn't belong to any one ride — so
 * this cache is GLOBAL (no per-profile namespace): resolving the wind for one ride
 * populates grid cells that ANY other ride crossing the same area on the same day
 * reuses for free. Combined with Open-Meteo's pricing (one location for up to 14
 * days is a single API call), this is what keeps the feature within the free tier:
 * repeated routes cost zero further calls.
 *
 * Decoupled from the main ride-state blob and the GPX cache on purpose: the wind
 * bytes live in their own `wind` IndexedDB object store (see kv.ts), so flushing the
 * wind cache never touches rides, settings, or imported GPX originals. It's a
 * re-fetchable CACHE tier — anything cleared is simply re-downloaded.
 *
 * Layout in the blob store:
 *   - `${dataset}::${latIdx}:${lonIdx}::${dayISO}` → gzipped JSON of one CellDayWind.
 *   - `__windindex` → UTF-8 JSON `{ key: compressedByteLength }`.
 *
 * The index is hydrated once at load() and kept in memory, so `has`/`missingKeys`/
 * `totalBytes` are O(1) and we NEVER read every payload to answer them (the whole
 * point at the thousands-of-cells scale).
 */

import { gunzip, gzip } from "./gzip";
import type { BlobStore } from "./kv";
import { memoryBlobBackend } from "./kv";
import { type CellDayWind, cellDayKey } from "./weather";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Compare two Uint8Arrays for byte-for-byte equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Storage-format version for a single cached cell-day entry. */
export const WIND_ENTRY_VERSION = 1;

const INDEX_KEY = "__windindex";

/** Serialize one cell-day entry to gzipped, versioned JSON (full float precision). */
export async function encodeCellDay(entry: CellDayWind): Promise<Uint8Array> {
  const json = JSON.stringify({ ...entry, v: WIND_ENTRY_VERSION });
  return gzip(encoder.encode(json));
}

/**
 * Inflate a cached entry back to a `CellDayWind`. Returns null when the bytes are
 * corrupt or written by an unknown (newer) version we can't safely read — the
 * caller then treats it as a miss and re-fetches.
 */
export async function decodeCellDay(bytes: Uint8Array): Promise<CellDayWind | null> {
  try {
    const raw = JSON.parse(decoder.decode(await gunzip(bytes))) as unknown;
    return migrateEntry(raw);
  } catch {
    return null;
  }
}

/** Bring a parsed entry up to the current version, or null to discard (re-fetch). */
function migrateEntry(raw: unknown): CellDayWind | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as { v?: unknown }).v;
  if (v === WIND_ENTRY_VERSION) return raw as CellDayWind;
  // Future entry-shape migrations slot in here (e.g. if (v === 1) return upgrade(raw)).
  // A missing/newer/unknown version is discarded rather than guessed at.
  return null;
}

export class WindCache {
  /** key → compressed (on-disk) byte length, for size + presence without reads. */
  private index = new Map<string, number>();

  /**
   * @param blob durable binary backend (IndexedDB `wind` store in production).
   * @param onError surfaced when a background write fails (e.g. quota exceeded).
   */
  constructor(
    private readonly blob: BlobStore,
    private readonly onError?: (message: string) => void,
  ) {}

  /** An ephemeral in-memory cache (demo/tests, or a Controller with no durable backend). */
  static memory(): WindCache {
    return new WindCache(memoryBlobBackend());
  }

  /** Build a cache and hydrate its size index from storage (payloads are not read). */
  static async load(blob: BlobStore, onError?: (message: string) => void): Promise<WindCache> {
    const cache = new WindCache(blob, onError);
    try {
      const raw = await blob.get(INDEX_KEY);
      if (raw) {
        const obj = JSON.parse(decoder.decode(raw)) as Record<string, number>;
        for (const [k, n] of Object.entries(obj)) {
          if (typeof n === "number" && Number.isFinite(n) && n >= 0) cache.index.set(k, n);
        }
      }
    } catch {
      /* missing or corrupt index — start empty (payloads, if any, are orphaned) */
    }
    return cache;
  }

  /** True when a cell-day (including a negative `noData` sentinel) is cached. */
  has(key: string): boolean {
    return this.index.has(key);
  }

  /** Of the given cell-day keys, those NOT present in the cache (the real gaps). */
  missingKeys(keys: Iterable<string>): string[] {
    const out: string[] = [];
    for (const k of keys) if (!this.index.has(k)) out.push(k);
    return out;
  }

  /** Total compressed (on-disk) size of the cache in bytes. */
  totalBytes(): number {
    let sum = 0;
    for (const n of this.index.values()) sum += n;
    return sum;
  }

  /** Number of cached cell-day entries. */
  get count(): number {
    return this.index.size;
  }

  /** The cached wind for one cell-day, or null when not cached / corrupt. */
  async get(key: string): Promise<CellDayWind | null> {
    if (!this.index.has(key)) return null;
    try {
      const gz = await this.blob.get(key);
      if (!gz) return null;
      return await decodeCellDay(gz);
    } catch {
      return null;
    }
  }

  /**
   * Store many cell-day entries at once (one fetch typically yields several cells ×
   * days). A failed write — most likely a full disk/quota — is surfaced via
   * `onError` and skipped, leaving the rest of the cache intact.
   */
  async putMany(entries: CellDayWind[]): Promise<void> {
    let wrote = false;
    for (const entry of entries) {
      const key = cellDayKey(entry.dataset, entry.latIdx, entry.lonIdx, entry.dayISO);
      try {
        const gz = await encodeCellDay(entry);
        await this.blob.set(key, gz);
        this.index.set(key, gz.length);
        wrote = true;
      } catch (err) {
        const full = err instanceof DOMException && err.name === "QuotaExceededError";
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // The wind itself was already computed from the fetched data — only the
        // local CACHE write failed, so this is a non-fatal "couldn't save for next
        // time" warning, not a wind-resolution failure. Surface the real cause so
        // it's actionable (quota vs. a missing store vs. private-mode block) rather
        // than a bare "failed".
        this.onError?.(
          full
            ? "Wind resolved, but couldn't be cached locally: storage is full. Free space or clear caches to keep it for next time."
            : `Wind resolved, but couldn't be cached locally (it'll be re-fetched next time). Reason: ${detail}`,
        );
        return; // a write failure here will recur for the rest — stop, don't spam
      }
    }
    if (wrote) await this.persistIndex();
  }

  /** Wipe the entire wind cache (every payload + the index record). */
  async flush(): Promise<void> {
    const keys = [...this.index.keys()];
    this.index.clear();
    try {
      await Promise.all(keys.map((k) => this.blob.del(k)));
      await this.blob.del(INDEX_KEY);
    } catch {
      /* storage unavailable — non-fatal, the in-memory index is already cleared */
    }
  }

  /** Rebuild the in-memory index from persistent storage (after importing blobs). */
  async reload(): Promise<void> {
    this.index.clear();
    try {
      const raw = await this.blob.get(INDEX_KEY);
      if (raw) {
        const obj = JSON.parse(decoder.decode(raw)) as Record<string, number>;
        for (const [k, n] of Object.entries(obj)) {
          if (typeof n === "number" && Number.isFinite(n) && n >= 0) this.index.set(k, n);
        }
      }
    } catch {
      /* missing or corrupt index — start empty */
    }
  }

  /** Export all cached blobs as {key, compressedBytes} for backup. */
  async getAllBlobs(): Promise<Array<{ key: string; bytes: Uint8Array }>> {
    const result: Array<{ key: string; bytes: Uint8Array }> = [];
    for (const key of this.index.keys()) {
      const bytes = await this.blob.get(key);
      if (bytes) {
        result.push({ key, bytes });
      }
    }
    return result;
  }

  /** Import a blob (already gzipped) for a cell-day key. Returns true if written (or updated). */
  async setBlob(key: string, compressedBytes: Uint8Array): Promise<boolean> {
    try {
      const stored = await this.blob.get(key);
      // Only write if missing or bytes differ (idempotent import)
      if (
        stored &&
        stored.length === compressedBytes.length &&
        bytesEqual(stored, compressedBytes)
      ) {
        return false; // no change
      }
      await this.blob.set(key, compressedBytes);
      this.index.set(key, compressedBytes.length);
      await this.persistIndex();
      return true; // written/updated
    } catch {
      this.onError?.("Failed to import wind cache.");
      return false;
    }
  }

  private persistIndex(): Promise<void> {
    const obj: Record<string, number> = {};
    for (const [k, n] of this.index) obj[k] = n;
    return this.blob.set(INDEX_KEY, encoder.encode(JSON.stringify(obj)));
  }
}
