/**
 * Async key/value persistence backend for the ride cache.
 *
 * The Store keeps rides in memory (the source of truth); this is only the durable
 * layer behind its load()/save()/clear(). It holds one serialized JSON blob under
 * a single key, but the interface is deliberately minimal so the same Store works
 * against IndexedDB (production) or an in-memory Map (demo + tests).
 *
 * Why IndexedDB and not LocalStorage: LocalStorage caps an origin at ~5 MB, and
 * the cache (rough GPS tracks included) can grow past that. IndexedDB shares the
 * much larger per-origin disk quota. There is NO automatic migration — users move
 * data across the boundary with the existing JSON export/import.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * Binary sibling of `KeyValueStore` for storing raw bytes (compressed GPX) without
 * a base64 round-trip. `keys()` lets a cache enumerate what it holds — used to
 * rebuild/repair the size index. IndexedDB stores `Uint8Array` directly via
 * structured clone; the in-memory backend just keeps the arrays.
 */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * In-memory backend for demo mode and tests. Its operations mutate the backing
 * Map synchronously (the returned promise is already resolved), so a save()
 * followed by a load() observes the write without awaiting a tick. Pass a shared
 * Map to persist across multiple Store.load() calls.
 */
export function memoryBackend(map: Map<string, string> = new Map()): KeyValueStore {
  return {
    get: (k) => Promise.resolve(map.has(k) ? map.get(k)! : null),
    set: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    del: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
  };
}

/**
 * In-memory binary backend for demo mode and tests. Like `memoryBackend` but holds
 * `Uint8Array` values; pass a shared Map to persist across reloads in a test.
 */
export function memoryBlobBackend(map: Map<string, Uint8Array> = new Map()): BlobStore {
  return {
    get: (k) => Promise.resolve(map.has(k) ? map.get(k)! : null),
    set: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    del: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...map.keys()]),
  };
}

// The IndexedDB database name. Renamed from "beeline-toolkit" to match the product
// ("GPX Toolkit"). We deliberately do NOT migrate the old database — a rename simply
// starts a fresh DB; any data in the old one is left untouched (re-syncable from the
// source / re-importable).
const DB_NAME = "gpx-toolkit";
const STORE_NAME = "kv";
/** Object store holding the compressed full-GPX cache (binary, one blob per ride). */
const GPX_STORE_NAME = "gpx";
/** Object store holding the compressed historical-wind cache (binary, one blob per
 *  dataset/grid-cell/day). Global (not per-profile) — wind is universal, so every
 *  profile shares it for maximum reuse. */
const WIND_STORE_NAME = "wind";
/** Object store holding the imported Google Location History (binary, one gzipped
 *  columnar blob per month + a catalog). Its OWN bucket, separate from rides/GPX/wind,
 *  so it can be dropped independently and never bloats the ride-state blob. */
const LOCATION_STORE_NAME = "location-history";
// v2 adds the `gpx` object store alongside the original `kv` store.
// v3 adds the `wind` object store for the global historical-wind cache.
// v4 adds the `location-history` object store for imported Google Location History.
const DB_VERSION = 4;

/** Every object store this app expects. `onupgradeneeded` creates whichever are
 *  missing, so a forced upgrade always converges to the full, current schema. */
const ALL_STORES = [STORE_NAME, GPX_STORE_NAME, WIND_STORE_NAME, LOCATION_STORE_NAME];

/**
 * The version we open at. Normally `DB_VERSION`, but `dbWithStore` raises it to force
 * an upgrade when a connection turns out to be missing a store (e.g. an on-disk DB
 * left at v3 without `wind` by an interrupted upgrade, or a stale connection a same-
 * version reopen can't repair). Opening at a higher version is the only guaranteed
 * way to re-run `onupgradeneeded` and create the missing store.
 */
let runtimeVersion = DB_VERSION;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, runtimeVersion);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Idempotent: create only the stores that don't exist yet, so this is safe at
      // any version jump (v2→v3, or a forced v3→v4 self-heal) and never throws on a
      // store that's already present.
      for (const name of ALL_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    // A version upgrade (e.g. v2→v3 adding the `wind` store) is BLOCKED while an
    // older connection to this DB is still open in another tab — or lingering from a
    // dev-server hot-reload. Without surfacing it, that reads as a silent "store not
    // found" later. Reject with a clear, actionable message instead.
    req.onblocked = () =>
      reject(
        new Error(
          "Database upgrade blocked — another tab has this app open at an older version. " +
            "Close other tabs of this app (or fully reload) and try again.",
        ),
      );
    req.onsuccess = () => {
      const database = req.result;
      // Keep the runtime version in sync with what's actually on disk (it may be
      // higher than DB_VERSION after a forced self-heal upgrade), so the NEXT open
      // doesn't request a lower version and throw a VersionError.
      if (database.version > runtimeVersion) runtimeVersion = database.version;
      // If ANOTHER tab later requests a newer version, close this connection so we
      // don't block its upgrade (and drop the cached promise so the next call re-opens
      // at the new version). Standard IndexedDB hygiene for a long-lived SPA.
      database.onversionchange = () => {
        database.close();
        dbPromise = null;
      };
      resolve(database);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

// One shared connection for every backend in the page, so the `kv` and `gpx`
// stores ride on a single open DB (and a single onupgradeneeded that creates both).
let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

/**
 * Get a DB connection GUARANTEED to contain `storeName`. A connection can be missing
 * a store for several reasons — a stale connection cached from before a version bump
 * (the dev server's HMR is the classic case), or an on-disk DB left at the current
 * version without a store after an interrupted/blocked upgrade. A same-version reopen
 * can't fix the latter (no `onupgradeneeded` fires when the version matches), so we
 * FORCE an upgrade by reopening at `version + 1`; the idempotent `onupgradeneeded`
 * then creates whatever is missing. This self-heals without the user clearing data.
 */
async function dbWithStore(storeName: string): Promise<IDBDatabase> {
  let database = await db();
  if (database.objectStoreNames.contains(storeName)) return database;
  // Force an upgrade: bump past the on-disk version so onupgradeneeded re-runs.
  runtimeVersion = database.version + 1;
  try {
    database.close();
  } catch {
    /* already closing — ignore */
  }
  dbPromise = null;
  database = await db();
  return database;
}

function runOn<T>(
  storeName: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return dbWithStore(storeName).then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const tx = database.transaction(storeName, mode);
        const request = op(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      }),
  );
}

/** Durable IndexedDB-backed store (production): one object store, one blob per key. */
export function idbBackend(): KeyValueStore {
  return {
    get: (k) =>
      runOn<unknown>(STORE_NAME, "readonly", (s) => s.get(k)).then((v) =>
        v == null ? null : String(v),
      ),
    set: (k, v) => runOn(STORE_NAME, "readwrite", (s) => s.put(v, k)).then(() => undefined),
    del: (k) => runOn(STORE_NAME, "readwrite", (s) => s.delete(k)).then(() => undefined),
  };
}

/**
 * Durable IndexedDB-backed binary store (production) for the compressed GPX cache.
 * Shares the same DB connection as `idbBackend` but lives in its own `gpx` object
 * store, so clearing the GPX cache never touches the main ride-state blob.
 */
export function idbBlobBackend(): BlobStore {
  return idbBlobBackendFor(GPX_STORE_NAME);
}

/**
 * Durable IndexedDB-backed binary store for the global historical-wind cache. Lives
 * in its own `wind` object store on the shared DB connection, so flushing the wind
 * cache never touches rides or the GPX cache.
 */
export function idbWindBlobBackend(): BlobStore {
  return idbBlobBackendFor(WIND_STORE_NAME);
}

/**
 * Durable IndexedDB-backed binary store for imported Google Location History. Lives
 * in its OWN `location-history` object store on the shared DB connection, so dropping
 * location history never touches rides, the GPX cache or the wind cache (and vice
 * versa). This is the separate storage bucket the Timeline feature requires.
 */
export function idbLocationBlobBackend(): BlobStore {
  return idbBlobBackendFor(LOCATION_STORE_NAME);
}

/** Build a binary backend over one named object store (shared DB connection). */
function idbBlobBackendFor(storeName: string): BlobStore {
  const toBytes = (v: unknown): Uint8Array | null => {
    if (v == null) return null;
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  };
  return {
    get: (k) => runOn<unknown>(storeName, "readonly", (s) => s.get(k)).then(toBytes),
    set: (k, v) => runOn(storeName, "readwrite", (s) => s.put(v, k)).then(() => undefined),
    del: (k) => runOn(storeName, "readwrite", (s) => s.delete(k)).then(() => undefined),
    keys: () =>
      runOn<IDBValidKey[]>(storeName, "readonly", (s) => s.getAllKeys()).then((ks) =>
        ks.map((k) => String(k)),
      ),
  };
}
