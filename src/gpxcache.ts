/**
 * Persistent, compressed cache of full-track GPX files.
 *
 * The full recorded GPX (real per-point time + elevation) is expensive to fetch —
 * a server-side render plus a ~500 KB download, paced to one ride per second. Once
 * a user has downloaded it we keep it, gzipped, in its own IndexedDB object store
 * so a later save/bundle of the same ride is instant and works fully offline, and a
 * year-bundle only fetches the rides it doesn't already hold.
 *
 * Decoupled from the main ride-state blob on purpose: the GPX bytes live in a
 * separate `gpx` object store (see kv.ts `BlobStore`), so the user can flush this
 * cache without touching their rides/settings, and the main state blob — re-
 * serialized on every save — never bloats with megabytes of GPX.
 *
 * Layout in the blob store (all keys namespaced by `prefix` so the Beeline account
 * and demo keep separate, non-colliding caches):
 *   - `${prefix}::ride::${rideKey}` → gzipped GPX bytes, one per ride.
 *   - `${prefix}::__index`          → UTF-8 JSON `{ rideKey: compressedByteLength }`.
 *
 * The index is hydrated once at load() and kept in memory, so `has`/`cachedKeys`/
 * `totalBytes` are O(1) and we NEVER read every payload to answer them (the whole
 * point at the thousands-of-rides scale).
 */

import { gunzip, gzip } from "./gzip";
import type { BlobStore } from "./kv";
import { memoryBlobBackend } from "./kv";

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

export class GpxCache {
  /** rideKey → compressed (on-disk) byte length, for size + presence without reads. */
  private index = new Map<string, number>();

  /**
   * @param blob durable binary backend (IndexedDB `gpx` store in production).
   * @param prefix per-profile namespace for this cache's keys.
   * @param onError surfaced when a background write fails (e.g. quota exceeded).
   */
  constructor(
    private readonly blob: BlobStore,
    private readonly prefix: string,
    private readonly onError?: (message: string) => void,
  ) {}

  private rideKeyFor(rideKey: string): string {
    return `${this.prefix}::ride::${rideKey}`;
  }

  private get indexKey(): string {
    return `${this.prefix}::__index`;
  }

  /** An ephemeral in-memory cache (demo/tests, or a Controller with no durable backend). */
  static memory(): GpxCache {
    return new GpxCache(memoryBlobBackend(), "memory");
  }

  /** Build a cache and hydrate its size index from storage (payloads are not read). */
  static async load(
    blob: BlobStore,
    prefix: string,
    onError?: (message: string) => void,
  ): Promise<GpxCache> {
    const cache = new GpxCache(blob, prefix, onError);
    try {
      const raw = await blob.get(cache.indexKey);
      if (raw) {
        const obj = JSON.parse(decoder.decode(raw)) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) cache.index.set(k, v);
        }
      }
    } catch {
      /* missing or corrupt index — start empty (payloads, if any, are orphaned) */
    }
    return cache;
  }

  /** True when a full GPX for this ride is cached. */
  has(rideKey: string): boolean {
    return this.index.has(rideKey);
  }

  /** The set of ride keys with a cached full GPX. */
  cachedKeys(): Set<string> {
    return new Set(this.index.keys());
  }

  /** Total compressed (on-disk) size of the cache in bytes. */
  totalBytes(): number {
    let sum = 0;
    for (const n of this.index.values()) sum += n;
    return sum;
  }

  /** Number of rides with a cached full GPX. */
  get count(): number {
    return this.index.size;
  }

  /**
   * Store a ride's full GPX, gzipped. Returns true on success. A failed write —
   * most likely a full disk/quota — is surfaced via `onError` and returns false,
   * leaving the cache (and the download) otherwise intact.
   */
  async put(rideKey: string, rawBytes: Uint8Array): Promise<boolean> {
    try {
      const gz = await gzip(rawBytes);
      await this.blob.set(this.rideKeyFor(rideKey), gz);
      this.index.set(rideKey, gz.length);
      await this.persistIndex();
      return true;
    } catch (err) {
      const full = err instanceof DOMException && err.name === "QuotaExceededError";
      this.onError?.(
        full
          ? "Storage full — the GPX could not be cached locally."
          : "Failed to cache the GPX locally.",
      );
      return false;
    }
  }

  /** The cached full GPX for a ride (decompressed), or null when not cached. */
  async get(rideKey: string): Promise<Uint8Array | null> {
    try {
      const gz = await this.blob.get(this.rideKeyFor(rideKey));
      if (!gz) return null;
      return await gunzip(gz);
    } catch {
      return null;
    }
  }

  /** Drop one ride's cached GPX. */
  async delete(rideKey: string): Promise<void> {
    if (!this.index.has(rideKey)) return;
    this.index.delete(rideKey);
    try {
      await this.blob.del(this.rideKeyFor(rideKey));
      await this.persistIndex();
    } catch {
      /* storage unavailable — the in-memory index already dropped it */
    }
  }

  /** Wipe this profile's entire GPX cache (every payload + the index record). */
  async clear(): Promise<void> {
    const keys = [...this.index.keys()];
    this.index.clear();
    try {
      await Promise.all(keys.map((k) => this.blob.del(this.rideKeyFor(k))));
      await this.blob.del(this.indexKey);
    } catch {
      /* storage unavailable — non-fatal, the in-memory index is already cleared */
    }
  }

  /** Rebuild the in-memory index from persistent storage (after importing blobs). */
  async reload(): Promise<void> {
    this.index.clear();
    try {
      const raw = await this.blob.get(this.indexKey);
      if (raw) {
        const obj = JSON.parse(decoder.decode(raw)) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) this.index.set(k, v);
        }
      }
    } catch {
      /* missing or corrupt index — start empty */
    }
  }

  /** Export all cached blobs as {rideKey, compressedBytes} for backup. */
  async getAllBlobs(): Promise<Array<{ key: string; bytes: Uint8Array }>> {
    const result: Array<{ key: string; bytes: Uint8Array }> = [];
    for (const rideKey of this.index.keys()) {
      const bytes = await this.blob.get(this.rideKeyFor(rideKey));
      if (bytes) {
        result.push({ key: rideKey, bytes });
      }
    }
    return result;
  }

  /** Import a blob (already gzipped) for a ride. Returns true if written (or updated). */
  async setBlob(rideKey: string, compressedBytes: Uint8Array): Promise<boolean> {
    try {
      const stored = await this.blob.get(this.rideKeyFor(rideKey));
      // Only write if missing or bytes differ (idempotent import)
      if (
        stored &&
        stored.length === compressedBytes.length &&
        bytesEqual(stored, compressedBytes)
      ) {
        return false; // no change
      }
      await this.blob.set(this.rideKeyFor(rideKey), compressedBytes);
      this.index.set(rideKey, compressedBytes.length);
      await this.persistIndex();
      return true; // written/updated
    } catch {
      this.onError?.("Failed to import cached GPX.");
      return false;
    }
  }

  private persistIndex(): Promise<void> {
    const obj: Record<string, number> = {};
    for (const [k, v] of this.index) obj[k] = v;
    return this.blob.set(this.indexKey, encoder.encode(JSON.stringify(obj)));
  }
}
