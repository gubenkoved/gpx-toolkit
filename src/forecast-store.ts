/** Separate, compressed IndexedDB-backed storage for live forecasts and locations. */

import {
  DEFAULT_FORECAST_METRICS,
  type ForecastCompareStyle,
  type ForecastMetric,
  type ForecastPoint,
  type ForecastPresentation,
  type ForecastSpeedUnit,
  type HourlyForecast,
  type LocationResult,
} from "./forecast";
import { gunzip, gzip } from "./gzip";
import type { BlobStore } from "./kv";
import { memoryBlobBackend } from "./kv";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CATALOG_KEY = "forecast::__catalog";
const ENTRY_PREFIX = "forecast::entry::";
const GEO_PREFIX = "forecast::geo::";
const VERSION = 1;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_GEO = 50;
const GEO_TTL = 7 * 86_400_000;

interface CacheMeta {
  bytes: number;
  fetchedAt: number;
  freshUntil: number;
  endMs: number;
  requestedHours: number;
  accessedAt: number;
}

interface GeoMeta {
  bytes: number;
  fetchedAt: number;
  accessedAt: number;
}

export interface ForecastPrefs {
  lastPoint: ForecastPoint | null;
  days: 1 | 3 | 7 | 10 | 15;
  recent: LocationResult[];
  favorites: ForecastPoint[];
  selectedModels: string[] | null;
  hiddenCompareModels: string[];
  compareStyle: ForecastCompareStyle;
  speedUnit: ForecastSpeedUnit;
  presentation: ForecastPresentation;
  tableMetric: ForecastMetric;
  compareDetailHeightPx: number | null;
  metrics: ForecastMetric[];
}

interface Catalog {
  v: number;
  entries: Record<string, CacheMeta>;
  geo: Record<string, GeoMeta>;
  prefs: ForecastPrefs;
}

const emptyPrefs = (): ForecastPrefs => ({
  lastPoint: null,
  days: 3,
  recent: [],
  favorites: [],
  selectedModels: null,
  hiddenCompareModels: [],
  compareStyle: "consensus",
  speedUnit: "kmh",
  presentation: "compare",
  tableMetric: "windSpeed",
  compareDetailHeightPx: null,
  metrics: [...DEFAULT_FORECAST_METRICS],
});

const emptyCatalog = (): Catalog => ({
  v: VERSION,
  entries: {},
  geo: {},
  prefs: emptyPrefs(),
});

function pointKey(point: ForecastPoint): string {
  return `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`;
}

export function forecastCacheKey(point: ForecastPoint, modelId: string): string {
  return `${pointKey(point)}::${modelId}`;
}

function payloadKey(key: string): string {
  return `${ENTRY_PREFIX}${key}`;
}

function geoPayloadKey(query: string): string {
  return `${GEO_PREFIX}${encodeURIComponent(query)}`;
}

function sanePoint(value: unknown): value is ForecastPoint {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<ForecastPoint>;
  return typeof p.lat === "number" && typeof p.lon === "number" && typeof p.label === "string";
}

const FORECAST_METRICS = new Set<string>(DEFAULT_FORECAST_METRICS);

function saneMetrics(value: unknown): ForecastMetric[] {
  if (!Array.isArray(value)) return [...DEFAULT_FORECAST_METRICS];
  return [
    ...new Set(
      value.filter((metric): metric is ForecastMetric => FORECAST_METRICS.has(metric)),
    ),
  ];
}

export class ForecastStore {
  private catalog: Catalog = emptyCatalog();

  constructor(
    private readonly blob: BlobStore,
    private readonly onError?: (message: string) => void,
  ) {}

  static memory(): ForecastStore {
    return new ForecastStore(memoryBlobBackend());
  }

  static async load(
    blob: BlobStore,
    onError?: (message: string) => void,
  ): Promise<ForecastStore> {
    const store = new ForecastStore(blob, onError);
    await store.reload();
    return store;
  }

  async reload(): Promise<void> {
    this.catalog = emptyCatalog();
    try {
      const raw = await this.blob.get(CATALOG_KEY);
      if (!raw) return;
      const parsed = JSON.parse(decoder.decode(raw)) as Partial<Catalog>;
      if (parsed.v !== VERSION) return;
      const prefs = parsed.prefs ?? emptyPrefs();
      this.catalog = {
        v: VERSION,
        entries: parsed.entries ?? {},
        geo: parsed.geo ?? {},
        prefs: {
          lastPoint: sanePoint(prefs.lastPoint) ? prefs.lastPoint : null,
          days: [1, 3, 7, 10, 15].includes(prefs.days) ? prefs.days : 3,
          recent: Array.isArray(prefs.recent)
            ? prefs.recent.filter(sanePoint).slice(0, 5)
            : [],
          favorites: Array.isArray(prefs.favorites) ? prefs.favorites.filter(sanePoint) : [],
          selectedModels: Array.isArray(prefs.selectedModels)
            ? prefs.selectedModels.filter((v): v is string => typeof v === "string")
            : null,
          hiddenCompareModels: Array.isArray(prefs.hiddenCompareModels)
            ? prefs.hiddenCompareModels.filter((v): v is string => typeof v === "string")
            : [],
          compareStyle: prefs.compareStyle === "models" ? "models" : "consensus",
          speedUnit:
            prefs.speedUnit === "ms" || prefs.speedUnit === "kn" ? prefs.speedUnit : "kmh",
          presentation:
            prefs.presentation === "graph" ||
            prefs.presentation === "compare" ||
            prefs.presentation === "textual"
              ? prefs.presentation
              : "compare",
          tableMetric: FORECAST_METRICS.has(prefs.tableMetric)
            ? prefs.tableMetric
            : "windSpeed",
          compareDetailHeightPx:
            typeof prefs.compareDetailHeightPx === "number" &&
            Number.isFinite(prefs.compareDetailHeightPx) &&
            prefs.compareDetailHeightPx > 0
              ? prefs.compareDetailHeightPx
              : null,
          metrics: saneMetrics(prefs.metrics),
        },
      };
      await this.pruneExpired(Date.now());
    } catch {
      this.catalog = emptyCatalog();
    }
  }

  prefs(): ForecastPrefs {
    return structuredClone(this.catalog.prefs);
  }

  async setPrefs(patch: Partial<ForecastPrefs>): Promise<void> {
    this.catalog.prefs = { ...this.catalog.prefs, ...patch };
    await this.persistCatalog();
  }

  async addRecent(point: LocationResult): Promise<void> {
    const identity = (p: ForecastPoint): string => p.placeId || pointKey(p);
    this.catalog.prefs.recent = [
      point,
      ...this.catalog.prefs.recent.filter((p) => identity(p) !== identity(point)),
    ].slice(0, 5);
    this.catalog.prefs.lastPoint = point;
    await this.persistCatalog();
  }

  isFavorite(point: ForecastPoint): boolean {
    const key = pointKey(point);
    return this.catalog.prefs.favorites.some((p) => pointKey(p) === key);
  }

  async toggleFavorite(point: ForecastPoint): Promise<boolean> {
    const key = pointKey(point);
    const found = this.catalog.prefs.favorites.some((p) => pointKey(p) === key);
    this.catalog.prefs.favorites = found
      ? this.catalog.prefs.favorites.filter((p) => pointKey(p) !== key)
      : [point, ...this.catalog.prefs.favorites];
    await this.persistCatalog();
    return !found;
  }

  async renameFavorite(point: ForecastPoint, label: string): Promise<ForecastPoint | null> {
    const name = label.trim();
    if (!name) return null;
    const key = pointKey(point);
    const favorite = this.catalog.prefs.favorites.find((item) => pointKey(item) === key);
    if (!favorite) return null;
    const renamed = { ...favorite, label: name };
    this.catalog.prefs.favorites = this.catalog.prefs.favorites.map((item) =>
      pointKey(item) === key ? renamed : item,
    );
    this.catalog.prefs.recent = this.catalog.prefs.recent.map((item) =>
      pointKey(item) === key ? { ...item, label: name } : item,
    );
    if (this.catalog.prefs.lastPoint && pointKey(this.catalog.prefs.lastPoint) === key) {
      this.catalog.prefs.lastPoint = { ...this.catalog.prefs.lastPoint, label: name };
    }
    await this.persistCatalog();
    return renamed;
  }

  async getForecast(point: ForecastPoint, modelId: string): Promise<HourlyForecast | null> {
    const key = forecastCacheKey(point, modelId);
    const meta = this.catalog.entries[key];
    if (!meta) return null;
    try {
      const raw = await this.blob.get(payloadKey(key));
      if (!raw) {
        await this.discardForecast(key);
        return null;
      }
      const value = JSON.parse(decoder.decode(await gunzip(raw))) as HourlyForecast & {
        v?: number;
      };
      if (value.v !== VERSION || value.modelId !== modelId || !Array.isArray(value.times)) {
        await this.discardForecast(key);
        return null;
      }
      meta.accessedAt = Date.now();
      return value;
    } catch {
      await this.discardForecast(key);
      return null;
    }
  }

  async putForecast(entry: HourlyForecast): Promise<void> {
    const key = forecastCacheKey(entry.point, entry.modelId);
    try {
      const bytes = await gzip(encoder.encode(JSON.stringify({ ...entry, v: VERSION })));
      await this.blob.set(payloadKey(key), bytes);
      this.catalog.entries[key] = {
        bytes: bytes.length,
        fetchedAt: entry.fetchedAt,
        freshUntil: entry.freshUntil,
        // A negative probe has no timestamps, but is still valuable until its
        // freshness deadline; otherwise startup pruning would immediately erase it.
        endMs: entry.times.at(-1) ?? entry.freshUntil,
        requestedHours: entry.requestedHours,
        accessedAt: Date.now(),
      };
      await this.enforceLimit();
      await this.persistCatalog();
    } catch (error) {
      const quota = error instanceof DOMException && error.name === "QuotaExceededError";
      this.onError?.(quota ? "Forecast cache is full." : "Failed to cache forecast data.");
    }
  }

  async getGeocode(query: string): Promise<LocationResult[] | null> {
    const q = query.trim().toLocaleLowerCase();
    const meta = this.catalog.geo[q];
    if (!meta || Date.now() - meta.fetchedAt > GEO_TTL) return null;
    try {
      const raw = await this.blob.get(geoPayloadKey(q));
      if (!raw) return null;
      meta.accessedAt = Date.now();
      const values = JSON.parse(decoder.decode(await gunzip(raw))) as unknown;
      return Array.isArray(values) ? values.filter(sanePoint) : null;
    } catch {
      return null;
    }
  }

  async putGeocode(query: string, results: LocationResult[]): Promise<void> {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return;
    try {
      const bytes = await gzip(encoder.encode(JSON.stringify(results)));
      await this.blob.set(geoPayloadKey(q), bytes);
      this.catalog.geo[q] = {
        bytes: bytes.length,
        fetchedAt: Date.now(),
        accessedAt: Date.now(),
      };
      const old = Object.entries(this.catalog.geo).sort(
        (a, b) => b[1].accessedAt - a[1].accessedAt,
      );
      for (const [key] of old.slice(MAX_GEO)) {
        delete this.catalog.geo[key];
        await this.blob.del(geoPayloadKey(key));
      }
      await this.persistCatalog();
    } catch {
      /* search caching is opportunistic */
    }
  }

  get count(): number {
    return Object.keys(this.catalog.entries).length + Object.keys(this.catalog.geo).length;
  }

  totalBytes(): number {
    return [...Object.values(this.catalog.entries), ...Object.values(this.catalog.geo)].reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
  }

  async flushCache(): Promise<void> {
    await Promise.all([
      ...Object.keys(this.catalog.entries).map((key) => this.blob.del(payloadKey(key))),
      ...Object.keys(this.catalog.geo).map((key) => this.blob.del(geoPayloadKey(key))),
    ]);
    this.catalog.entries = {};
    this.catalog.geo = {};
    await this.persistCatalog();
  }

  async clearAll(): Promise<void> {
    await this.flushCache();
    this.catalog = emptyCatalog();
    await this.blob.del(CATALOG_KEY);
  }

  async getAllBlobs(): Promise<Array<{ key: string; bytes: Uint8Array }>> {
    const out: Array<{ key: string; bytes: Uint8Array }> = [];
    for (const key of await this.blob.keys()) {
      if (key !== CATALOG_KEY && !key.startsWith(ENTRY_PREFIX) && !key.startsWith(GEO_PREFIX))
        continue;
      const bytes = await this.blob.get(key);
      if (bytes) out.push({ key, bytes });
    }
    return out;
  }

  async importBlobs(blobs: Array<{ key: string; bytes: Uint8Array }>): Promise<number> {
    let incoming: Catalog | null = null;
    const catalogBlob = blobs.find((item) => item.key === CATALOG_KEY);
    if (catalogBlob) {
      try {
        const parsed = JSON.parse(decoder.decode(catalogBlob.bytes)) as Catalog;
        if (parsed.v === VERSION) incoming = parsed;
      } catch {
        /* optional forecast data must never invalidate the main backup */
      }
    }
    let n = 0;
    for (const item of blobs) {
      if (item.key === CATALOG_KEY) continue;
      if (!item.key.startsWith(ENTRY_PREFIX) && !item.key.startsWith(GEO_PREFIX)) continue;
      if (item.key.startsWith(ENTRY_PREFIX)) {
        const key = item.key.slice(ENTRY_PREFIX.length);
        const next = incoming?.entries?.[key];
        const current = this.catalog.entries[key];
        if (!next || (current && current.fetchedAt >= next.fetchedAt)) continue;
      } else {
        const key = decodeURIComponent(item.key.slice(GEO_PREFIX.length));
        const next = incoming?.geo?.[key];
        const current = this.catalog.geo[key];
        if (!next || (current && current.fetchedAt >= next.fetchedAt)) continue;
      }
      await this.blob.set(item.key, item.bytes);
      n++;
    }
    if (incoming) {
      const favorites = [...this.catalog.prefs.favorites];
      for (const favorite of incoming.prefs?.favorites ?? []) {
        if (!favorites.some((p) => pointKey(p) === pointKey(favorite)))
          favorites.push(favorite);
      }
      const recent = [...(incoming.prefs?.recent ?? []), ...this.catalog.prefs.recent]
        .filter((value, i, all) => all.findIndex((p) => pointKey(p) === pointKey(value)) === i)
        .slice(0, 5);
      for (const [key, meta] of Object.entries(incoming.entries ?? {})) {
        const current = this.catalog.entries[key];
        if (!current || meta.fetchedAt > current.fetchedAt) this.catalog.entries[key] = meta;
      }
      for (const [key, meta] of Object.entries(incoming.geo ?? {})) {
        const current = this.catalog.geo[key];
        if (!current || meta.fetchedAt > current.fetchedAt) this.catalog.geo[key] = meta;
      }
      this.catalog.prefs = { ...this.catalog.prefs, favorites, recent };
      await this.persistCatalog();
    }
    await this.pruneExpired(Date.now());
    return n;
  }

  private async pruneExpired(now: number): Promise<void> {
    let changed = false;
    for (const [key, meta] of Object.entries(this.catalog.entries)) {
      if (meta.endMs >= now - 3_600_000) continue;
      delete this.catalog.entries[key];
      await this.blob.del(payloadKey(key));
      changed = true;
    }
    for (const [key, meta] of Object.entries(this.catalog.geo)) {
      if (now - meta.fetchedAt <= GEO_TTL) continue;
      delete this.catalog.geo[key];
      await this.blob.del(geoPayloadKey(key));
      changed = true;
    }
    if (changed) await this.persistCatalog();
  }

  private async enforceLimit(): Promise<void> {
    let bytes = this.totalBytes();
    if (bytes <= MAX_BYTES) return;
    const old = Object.entries(this.catalog.entries).sort(
      (a, b) => a[1].accessedAt - b[1].accessedAt,
    );
    for (const [key, meta] of old) {
      if (bytes <= MAX_BYTES) break;
      delete this.catalog.entries[key];
      bytes -= meta.bytes;
      await this.blob.del(payloadKey(key));
    }
  }

  private async discardForecast(key: string): Promise<void> {
    delete this.catalog.entries[key];
    try {
      await this.blob.del(payloadKey(key));
      await this.persistCatalog();
    } catch {
      this.onError?.("Failed to discard corrupt forecast data.");
    }
  }

  private persistCatalog(): Promise<void> {
    return this.blob.set(CATALOG_KEY, encoder.encode(JSON.stringify(this.catalog)));
  }
}
