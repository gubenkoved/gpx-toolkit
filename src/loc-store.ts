/**
 * Persistent store for imported Google Location History.
 *
 * Modelled on `GpxCache` but tuned for a single, large, time-ordered dataset: records
 * are grouped into per-month chunks (`YYYY-MM`), each gzipped columnar-encoded (see
 * loc-codec.ts), so a day-scrub or range query loads only the months it touches rather
 * than the whole 11-year history. An in-memory index of per-month chunk headers keeps
 * size/extent/kind queries O(months) with no payload reads, and a separate catalog blob
 * holds the global extent + the rich `LocSourceDef[]` provenance table.
 *
 * This lives in its OWN IndexedDB object store (`location-history`, see kv.ts), wholly
 * separate from rides, the GPX cache and the wind cache. Importing never rewrites the
 * ride-state blob, and `clear()` drops ONLY this store — the separate, independently
 * droppable bucket the Timeline feature requires.
 *
 * Keys in the blob store:
 *   - `loc::month::YYYY-MM` → gzipped columnar chunk for that month.
 *   - `loc::__catalog`      → UTF-8 JSON `LocCatalog` (extent, sources, per-month headers).
 */

import { gunzip, gzip } from "./gzip";
import { decodeChunk, decodeHeader, encodeChunk } from "./loc-codec";
import type { LocKind, LocProfile, LocRecord, LocSourceDef } from "./loc-model";
import type { BlobStore } from "./kv";
import { memoryBlobBackend } from "./kv";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MONTH_PREFIX = "loc::month::";
const CATALOG_KEY = "loc::__catalog";

/** Lightweight per-month summary kept in the catalog (mirrors the chunk header). */
export interface MonthSummary {
  month: string;
  /** Compressed (on-disk) byte length of the chunk. */
  bytes: number;
  n: number;
  tMin: number;
  tMax: number;
  bbox: [number, number, number, number];
  kinds: Record<LocKind, number>;
}

/** Global catalog: overall extent, provenance defs, and per-month summaries. */
export interface LocCatalog {
  v: number;
  /** Rich provenance — `LocRecord.sourceId` indexes by `id`. */
  sources: LocSourceDef[];
  /** Per-month summaries, keyed by "YYYY-MM". */
  months: Record<string, MonthSummary>;
  /** Google's precomputed profile from the most recent import, when present. */
  profile?: LocProfile | null;
}

/** The month key ("YYYY-MM") a timestamp falls in, in UTC. */
export function monthKey(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function emptyCatalog(): LocCatalog {
  return { v: 1, sources: [], months: {} };
}

export class LocationHistoryStore {
  private catalog: LocCatalog = emptyCatalog();

  constructor(private readonly blob: BlobStore) {}

  /** An ephemeral in-memory store (demo/tests). */
  static memory(): LocationHistoryStore {
    return new LocationHistoryStore(memoryBlobBackend());
  }

  /** Build a store and hydrate its catalog from storage (chunks are not read). */
  static async load(blob: BlobStore): Promise<LocationHistoryStore> {
    const store = new LocationHistoryStore(blob);
    await store.reload();
    return store;
  }

  /** Re-read the catalog from storage. */
  async reload(): Promise<void> {
    this.catalog = emptyCatalog();
    try {
      const raw = await this.blob.get(CATALOG_KEY);
      if (raw) {
        const parsed = JSON.parse(decoder.decode(raw)) as LocCatalog;
        if (parsed && typeof parsed === "object" && parsed.months) {
          this.catalog = {
            v: parsed.v ?? 1,
            sources: Array.isArray(parsed.sources) ? parsed.sources : [],
            months: parsed.months ?? {},
            profile: parsed.profile ?? null,
          };
        }
      }
    } catch {
      /* missing or corrupt catalog — start empty (any chunks are orphaned) */
    }
  }

  /** True when nothing has been imported. */
  isEmpty(): boolean {
    return Object.keys(this.catalog.months).length === 0;
  }

  /** The months present, sorted ascending. */
  months(): string[] {
    return Object.keys(this.catalog.months).sort();
  }

  /** Months overlapping an inclusive [fromMs, toMs] range, sorted ascending. */
  monthsInRange(fromMs: number, toMs: number): string[] {
    const lo = monthKey(fromMs);
    const hi = monthKey(toMs);
    return this.months().filter((m) => m >= lo && m <= hi);
  }

  /** The current catalog (extent, sources, per-month summaries). */
  getCatalog(): LocCatalog {
    return this.catalog;
  }

  /** The provenance defs. */
  sources(): LocSourceDef[] {
    return this.catalog.sources;
  }

  /** Google's precomputed profile (frequent places/trips, persona), or null. */
  getProfile(): LocProfile | null {
    return this.catalog.profile ?? null;
  }

  /** Store Google's precomputed profile (replaces any previous). */
  async setProfile(profile: LocProfile | null): Promise<void> {
    this.catalog.profile = profile;
    await this.persistCatalog();
  }

  /** Total record count across all months. */
  totalRecords(): number {
    let sum = 0;
    for (const m of Object.values(this.catalog.months)) sum += m.n;
    return sum;
  }

  /** Total compressed (on-disk) size across all months, bytes. */
  totalBytes(): number {
    let sum = 0;
    for (const m of Object.values(this.catalog.months)) sum += m.bytes;
    return sum;
  }

  /** Overall [minLat, minLon, maxLat, maxLon] across all months, or null when empty. */
  bounds(): [number, number, number, number] | null {
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    let any = false;
    for (const m of Object.values(this.catalog.months)) {
      if (m.n === 0) continue;
      any = true;
      if (m.bbox[0] < minLat) minLat = m.bbox[0];
      if (m.bbox[1] < minLon) minLon = m.bbox[1];
      if (m.bbox[2] > maxLat) maxLat = m.bbox[2];
      if (m.bbox[3] > maxLon) maxLon = m.bbox[3];
    }
    return any ? [minLat, minLon, maxLat, maxLon] : null;
  }

  /** Overall [tMin, tMax] epoch ms across all months, or null when empty. */
  timeRange(): [number, number] | null {
    let tMin = Infinity;
    let tMax = -Infinity;
    let any = false;
    for (const m of Object.values(this.catalog.months)) {
      if (m.n === 0) continue;
      any = true;
      if (m.tMin < tMin) tMin = m.tMin;
      if (m.tMax > tMax) tMax = m.tMax;
    }
    return any ? [tMin, tMax] : null;
  }

  /** Replace (or create) a month's chunk with exactly these records. */
  async putMonth(month: string, records: LocRecord[]): Promise<void> {
    const buf = encodeChunk(month, records);
    const gz = await gzip(buf);
    await this.blob.set(MONTH_PREFIX + month, gz);
    const header = decodeHeader(buf);
    this.catalog.months[month] = {
      month,
      bytes: gz.length,
      n: header.n,
      tMin: header.tMin,
      tMax: header.tMax,
      bbox: header.bbox,
      kinds: header.kinds,
    };
    await this.persistCatalog();
  }

  /** Decode and return one month's records, or [] when absent. */
  async getMonth(month: string): Promise<LocRecord[]> {
    if (!this.catalog.months[month]) return [];
    try {
      const gz = await this.blob.get(MONTH_PREFIX + month);
      if (!gz) return [];
      const buf = await gunzip(gz);
      return decodeChunk(buf).records;
    } catch {
      return [];
    }
  }

  /**
   * Import a parsed export: bucket records by month, merge each month's source defs,
   * and write per-month chunks. Records already present for a month are merged with
   * the new ones (re-importing the same export is idempotent-ish by time+kind).
   */
  async addImport(records: LocRecord[], sources: LocSourceDef[]): Promise<void> {
    // Remap incoming sourceIds onto catalog-global ids (stable across imports).
    const remap = this.mergeSources(sources);
    const byMonth = new Map<string, LocRecord[]>();
    for (const r of records) {
      const mapped: LocRecord = { ...r, sourceId: remap.get(r.sourceId) ?? r.sourceId };
      const mk = monthKey(mapped.t);
      const list = byMonth.get(mk);
      if (list) list.push(mapped);
      else byMonth.set(mk, [mapped]);
    }
    for (const [mk, incoming] of byMonth) {
      const existing = await this.getMonth(mk);
      await this.putMonth(mk, existing.concat(incoming));
    }
    await this.persistCatalog();
  }

  /**
   * Merge incoming source defs into the catalog, returning a map from each incoming
   * `id` to the catalog-global id. Defs are de-duplicated by their identity facets
   * (format/origin/device/import) so re-imports don't multiply sources.
   */
  private mergeSources(incoming: LocSourceDef[]): Map<number, number> {
    const remap = new Map<number, number>();
    const sig = (d: LocSourceDef): string =>
      `${d.format}|${d.origin}|${d.device?.tag ?? ""}|${d.device?.name ?? ""}|${d.importId ?? ""}`;
    const existingBySig = new Map<string, LocSourceDef>();
    for (const d of this.catalog.sources) existingBySig.set(sig(d), d);
    for (const d of incoming) {
      const s = sig(d);
      const hit = existingBySig.get(s);
      if (hit) {
        remap.set(d.id, hit.id);
      } else {
        const newId = this.catalog.sources.length;
        const def: LocSourceDef = { ...d, id: newId };
        this.catalog.sources.push(def);
        existingBySig.set(s, def);
        remap.set(d.id, newId);
      }
    }
    return remap;
  }

  /** Drop ONLY the location-history store (every month chunk + the catalog). */
  async clear(): Promise<void> {
    const months = Object.keys(this.catalog.months);
    this.catalog = emptyCatalog();
    try {
      await Promise.all(months.map((m) => this.blob.del(MONTH_PREFIX + m)));
      await this.blob.del(CATALOG_KEY);
    } catch {
      /* storage unavailable — the in-memory catalog is already cleared */
    }
  }

  private persistCatalog(): Promise<void> {
    return this.blob.set(CATALOG_KEY, encoder.encode(JSON.stringify(this.catalog)));
  }
}
