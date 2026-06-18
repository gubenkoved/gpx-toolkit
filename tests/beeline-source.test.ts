import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BeelineSession, RawBeelineRide } from "../src/beeline-api";
import { BeelineError } from "../src/beeline-api";
import type { BeelineApi } from "../src/beeline-source";
import { BeelineRideSource } from "../src/beeline-source";
import { Controller } from "../src/controller";
import { GpxCache } from "../src/gpxcache";
import { memoryBackend, memoryBlobBackend } from "../src/kv";
import { beelineRideKey as rawRideKey, rideUid } from "../src/parsing";
import type { Sleep } from "../src/source";
import { Store } from "../src/store";

// In these tests a ride "key" is the cross-source uid the Store, GPX cache and
// Controller all work in (`beeline::<datetime>`). `beelineRideKey` is shadowed to
// return that uid so every lookup + dispatch uses the canonical identity.
const beelineRideKey = (startMs: number): string => rideUid("beeline", rawRideKey(startMs));

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "beeline",
      "rides-sample.json",
    ),
    "utf-8",
  ),
) as Record<string, RawBeelineRide>;

const UPLOADED = "demo-uploaded-0001";
const PENDING = "demo-pending-0002";

/** In-memory Beeline backend: serves the fixture and simulates an upload completing. */
class FakeBeelineApi implements BeelineApi {
  uploadCalls: string[] = [];
  renameCalls: { pushId: string; name: string }[] = [];
  deleteCalls: string[] = [];
  exportCalls: string[] = [];
  refreshCalls = 0;
  /** When set, the next `refreshSession` rejects with this error (revoked token). */
  refreshFails: BeelineError | null = null;
  constructor(public rides: Record<string, RawBeelineRide>) {}

  async fetchRides(): Promise<Record<string, RawBeelineRide>> {
    return structuredClone(this.rides);
  }
  async uploadRideToStrava(_s: BeelineSession, pushId: string): Promise<void> {
    this.uploadCalls.push(pushId);
    this.rides[pushId] = {
      ...this.rides[pushId],
      strava_activity: { stravaUploadStatus: { status: "startedUploading" } },
    };
  }
  async fetchStravaActivity(
    _s: BeelineSession,
    pushId: string,
  ): Promise<RawBeelineRide["strava_activity"]> {
    // Upload completes on the first poll.
    const act = {
      id: 999,
      upload_id: 1234,
      stravaUploadStatus: { status: "availableOnStrava" },
    };
    this.rides[pushId] = { ...this.rides[pushId], strava_activity: act };
    return act;
  }
  async renameRide(_s: BeelineSession, pushId: string, name: string): Promise<void> {
    this.renameCalls.push({ pushId, name });
    if (!this.rides[pushId]) throw new Error("no such ride");
    this.rides[pushId] = { ...this.rides[pushId], name };
  }
  async deleteRide(_s: BeelineSession, pushId: string): Promise<void> {
    this.deleteCalls.push(pushId);
    if (!this.rides[pushId]) throw new Error("no such ride");
    delete this.rides[pushId];
  }
  async exportRideGpx(_s: BeelineSession, pushId: string): Promise<Uint8Array> {
    this.exportCalls.push(pushId);
    const raw = this.rides[pushId];
    if (!raw?.polyline) throw new Error("ride has no recorded track to export");
    // A tiny full GPX with real per-point ele + time so extractFullTrack has data.
    const start = raw.start ?? 0;
    const gpx =
      `<gpx version="1.1" creator="Beeline"><trk><trkseg>` +
      `<trkpt lat="52.0" lon="5.0"><ele>10</ele><time>${new Date(start).toISOString()}</time></trkpt>` +
      `<trkpt lat="52.001" lon="5.0"><ele>12</ele><time>${new Date(start + 10000).toISOString()}</time></trkpt>` +
      `</trkseg></trk></gpx>`;
    return new TextEncoder().encode(gpx);
  }
  async refreshSession(session: BeelineSession): Promise<BeelineSession> {
    this.refreshCalls++;
    if (this.refreshFails) throw this.refreshFails;
    return {
      ...session,
      idToken: `renewed-${this.refreshCalls}`,
      expiresAt: Date.now() + 3_600_000,
    };
  }
}

const fakeSignIn = async (email: string): Promise<BeelineSession> => ({
  idToken: "fake-token",
  uid: "fake-uid",
  email,
  refreshToken: "fake-refresh",
  expiresAt: Date.now() + 3_600_000,
});

function makeController(api: FakeBeelineApi, sleep: Sleep = async () => {}): Controller {
  const store = new Store(memoryBackend());
  return new Controller(
    () =>
      BeelineRideSource.create("rider@example.com", "secret", () => 4, {
        api,
        signIn: fakeSignIn,
        sleep,
      }),
    store,
  );
}

describe("Controller + BeelineRideSource (no network)", () => {
  it("downloads the whole history in one scan, persisting tracks + status + source", async () => {
    const c = makeController(new FakeBeelineApi(structuredClone(FIXTURE)));
    await c.connect();
    expect(c.state().device).toBe("Beeline (rider@example.com)");

    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // Every fixture ride landed.
    expect(c.store.rides.size).toBe(Object.keys(FIXTURE).length);

    const uploaded = c.store.rides.get(beelineRideKey(FIXTURE[UPLOADED].start as number))!;
    expect(uploaded.source).toBe("beeline");
    expect(uploaded.source_id).toBe(UPLOADED);
    expect(uploaded.device_model).toBe("Beeline (rider@example.com)");
    expect(uploaded.strava_status).toBe("uploaded");
    expect(uploaded.distance_km).toBeCloseTo(42.0, 2);
    expect(uploaded.track).toBeTruthy();
    expect(uploaded.track_points).toBeGreaterThanOrEqual(2);

    const pending = c.store.rides.get(beelineRideKey(FIXTURE[PENDING].start as number))!;
    expect(pending.strava_status).toBe("pending");
    expect(pending.source_id).toBe(PENDING);
  });

  it("uploads a pending ride via the cloud function and reflects the new status", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[PENDING].start as number);
    c.upload([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    expect(api.uploadCalls).toContain(PENDING);
    expect(c.store.rides.get(key)?.strava_status).toBe("uploaded");
  });

  it("synthesizes a saveable GPX file from the inline polyline", async () => {
    const c = makeController(new FakeBeelineApi(structuredClone(FIXTURE)));
    const files: Uint8Array[] = [];
    c.onGpx((f) => files.push(f.bytes));
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    c.downloadGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    expect(files.length).toBe(1);
    const gpx = new TextDecoder().decode(files[0]);
    expect(gpx).toContain("<gpx");
    expect(gpx).toContain("<trkpt ");
  });

  it("bundles a multi-ride download into a single .zip instead of N files", async () => {
    const c = makeController(new FakeBeelineApi(structuredClone(FIXTURE)));
    const files: { downloadName: string; bytes: Uint8Array; mime?: string }[] = [];
    c.onGpx((f) => files.push(f));
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // Every Beeline ride that carries a cached route can be exported locally (light).
    const keys = [...c.store.rides.entries()]
      .filter(([, r]) => r.source === "beeline" && r.track)
      .map(([k]) => k);
    expect(keys.length).toBeGreaterThan(1);

    c.downloadGpx(keys);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // Exactly ONE download, and it's a ZIP — not one <a download> click per ride.
    expect(files.length).toBe(1);
    expect(files[0].mime).toBe("application/zip");
    expect(files[0].downloadName.endsWith(".zip")).toBe(true);
    // Local-file-header magic "PK\x03\x04" proves it's a real ZIP container.
    expect([...files[0].bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("reflects server-side changes to a ride on the next re-sync", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[PENDING].start as number);
    expect(c.store.rides.get(key)?.strava_status).toBe("pending");

    // The ride changes on the server: it gets real metrics and is now on Strava.
    api.rides[PENDING] = {
      ...api.rides[PENDING],
      totalDistance: 5000,
      averageSpeed: 5,
      strava_activity: {
        id: 42,
        upload_id: 7,
        stravaUploadStatus: { status: "availableOnStrava" },
      },
    };

    // Re-sync (the "Re-sync" button just re-scans the whole history).
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const rec = c.store.rides.get(key)!;
    expect(rec.strava_status).toBe("uploaded");
    expect(rec.distance_km).toBeCloseTo(5.0, 2);
    expect(rec.avg_speed_kmh).toBeCloseTo(18.0, 1);
    expect(rec.deleted).toBe(false);
  });

  it("marks a server-removed ride deleted but keeps its track and data", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const before = c.store.rides.get(key)!;
    expect(before.deleted).toBe(false);
    const keptTrack = before.track;
    const keptDistance = before.distance_km;
    expect(keptTrack).toBeTruthy();

    // The ride is removed from the account.
    delete api.rides[UPLOADED];

    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const after = c.store.rides.get(key);
    // Still present locally, flagged deleted, with its track + data intact.
    expect(after).toBeDefined();
    expect(after?.deleted).toBe(true);
    expect(after?.deleted_at).toBeTruthy();
    expect(after?.track).toBe(keptTrack);
    expect(after?.distance_km).toBe(keptDistance);
    expect(after?.source_id).toBe(UPLOADED);
  });

  it("un-marks a previously-removed ride if it reappears on the server", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const restore = structuredClone(api.rides[UPLOADED]);

    // Remove, re-sync → deleted.
    delete api.rides[UPLOADED];
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });
    expect(c.store.rides.get(key)?.deleted).toBe(true);

    // Reappears, re-sync → un-deleted.
    api.rides[UPLOADED] = restore;
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });
    const rec = c.store.rides.get(key)!;
    expect(rec.deleted).toBe(false);
    expect(rec.deleted_at).toBe("");
  });

  it("saves GPX from the cached track with no connected source (offline mode)", async () => {
    // A store pre-populated with a Beeline ride that already carries its full track,
    // exactly like the offline, cached-rides state after a reload (not signed in).
    const store = new Store(memoryBackend());
    const key = "Wed Jun 3 2026 at 19:04";
    store.upsert(key, {
      source: "beeline",
      source_id: "-abc",
      title: "Evening ride, Springharbor",
      // A short but valid encoded polyline (two points) → exportable GPX.
      track: "_p~iF~ps|U_ulLnnqC",
      track_points: 2,
    });

    // A source-less controller: connecting would throw, just like offline Beeline.
    // The GPX export keys off the *record's* source, so it never needs the source.
    const c = new Controller(async () => {
      throw new Error("Not signed in — sign in to Beeline to sync.");
    }, store);

    const files: { downloadName: string; bytes: Uint8Array }[] = [];
    c.onGpx((f) => files.push(f));

    c.downloadGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // No "No device connected" error, and a real GPX was produced from the cache.
    const task = c.state().jobs.history.find((t) => t.kind === "download-gpx");
    expect(task?.status).toBe("done");
    expect(files.length).toBe(1);
    const gpx = new TextDecoder().decode(files[0].bytes);
    expect(gpx).toContain("<gpx");
    expect(gpx).toContain("<trkpt ");
    expect(gpx).toContain("Evening ride, Springharbor");
  });

  it("downloads the FULL GPX from the cloud in full mode and caches the full track", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const files: { bytes: Uint8Array }[] = [];
    c.onGpx((f) => files.push(f));

    // Full mode must hit the cloud export even though the ride already has a cached track.
    c.downloadGpx([key], "", "full");
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    expect(api.exportCalls).toContain(UPLOADED);
    expect(files.length).toBe(1);
    const gpx = new TextDecoder().decode(files[0].bytes);
    expect(gpx).toContain("<ele>");
    expect(gpx).toContain("<time>");
    // The full track (with real timestamps) is cached in memory for the session.
    const ft = c.getFullTrack(key);
    expect(ft).not.toBeNull();
    expect(ft?.times.every((t) => t != null)).toBe(true);
    expect(ft?.eles.every((e) => e != null)).toBe(true);
  });

  it("fetchFullGpx caches the full GPX without emitting a file to save", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const files: { bytes: Uint8Array }[] = [];
    c.onGpx((f) => files.push(f));

    c.fetchFullGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // It hit the cloud export and cached the result, but NO file was handed to the saver.
    expect(api.exportCalls).toContain(UPLOADED);
    expect(files.length).toBe(0);
    expect(c.gpxCachedKeys().has(key)).toBe(true);
    expect(c.gpxCacheCount()).toBe(1);
    expect(c.gpxCacheBytes()).toBeGreaterThan(0);
    // The real recorded track is also rehydrated into the session map.
    expect(c.getFullTrack(key)).not.toBeNull();

    // A second fetch is a no-op fetch (already cached) — no new export call.
    const before = api.exportCalls.length;
    c.fetchFullGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });
    expect(api.exportCalls.length).toBe(before);
  });

  it("rehydrates the full track from the GPX cache offline after a reload", async () => {
    // Shared backends survive the "reload": a second Controller built over them sees
    // what the first persisted (mirrors IndexedDB across a page refresh).
    const stateMap = new Map<string, string>();
    const blobMap = new Map<string, Uint8Array>();
    const PREFIX = "beeline-acct";

    // 1) Connected session: scan, then fetch+cache the full GPX for one ride.
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const storeA = await Store.load(memoryBackend(stateMap));
    const cacheA = await GpxCache.load(memoryBlobBackend(blobMap), PREFIX);
    const a = new Controller(
      () =>
        BeelineRideSource.create("rider@example.com", "secret", () => 4, {
          api,
          signIn: fakeSignIn,
          sleep: async () => {},
        }),
      storeA,
      cacheA,
    );
    await a.connect();
    a.scan("all", null);
    await vi.waitFor(() => expect(a.state().jobs.busy).toBe(false), { timeout: 5000 });
    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    a.fetchFullGpx([key]);
    await vi.waitFor(() => expect(a.state().jobs.busy).toBe(false), { timeout: 5000 });
    expect(a.gpxCachedKeys().has(key)).toBe(true);

    // 2) "Reload" offline: a fresh Controller whose source throws (not signed in),
    // over the SAME persisted state + GPX cache.
    const storeB = await Store.load(memoryBackend(stateMap));
    const cacheB = await GpxCache.load(memoryBlobBackend(blobMap), PREFIX);
    const b = new Controller(
      async () => {
        throw new Error("Not signed in — sign in to Beeline to sync.");
      },
      storeB,
      cacheB,
    );

    // The parsed track isn't in memory yet (only the gzipped bytes survived)…
    expect(b.getFullTrack(key)).toBeNull();
    expect(b.gpxCachedKeys().has(key)).toBe(true);

    // …but it rehydrates from the cache with NO source/network, so the offline map
    // gets the real recorded track instead of offering "Fetch full track".
    const ft = await b.loadCachedFullTrack(key);
    expect(ft).not.toBeNull();
    expect(ft?.points.length).toBeGreaterThanOrEqual(2);
    expect(b.getFullTrack(key)).not.toBeNull();

    // fetchFullTrack also serves from the cache offline (never touches the source).
    await expect(b.fetchFullTrack(key)).resolves.toBe(ft);
  });

  it("paces full-GPX exports to at most one ride per second", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const sleeps: number[] = [];
    const c = makeController(api, async (s) => {
      sleeps.push(s);
    });
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // Three rides that all carry a polyline (so the cloud export succeeds for each).
    const keys = [
      beelineRideKey(FIXTURE["demo-uploaded-0001"].start as number),
      beelineRideKey(FIXTURE["demo-pending-0002"].start as number),
      beelineRideKey(FIXTURE["demo-processing-0004"].start as number),
    ];
    c.downloadGpx(keys, "", "full");
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // All three were exported from the cloud…
    expect(api.exportCalls.length).toBe(3);
    // …and pacing held between them: one ~1 s wait per gap (N-1), none after the last.
    expect(sleeps.length).toBe(2);
    for (const s of sleeps) expect(s).toBeGreaterThan(0);
    expect(sleeps.every((s) => s <= 1)).toBe(true);
  });

  it("falls back to a route-only GPX when the full export gateway is unreachable", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    // The cloud export is unreachable — a retryable failure the app degrades around.
    api.exportRideGpx = async (_s: BeelineSession, pushId: string) => {
      api.exportCalls.push(pushId);
      throw new BeelineError("GPX export gateway unavailable (HTTP 503)", "unreachable");
    };
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const files: { bytes: Uint8Array }[] = [];
    c.onGpx((f) => files.push(f));

    c.downloadGpx([key], "", "full");
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // The task SUCCEEDED (degraded), not failed, and a route-only GPX was emitted
    // from the cached track instead.
    const task = c.state().jobs.history.find((t) => t.kind === "download-gpx");
    expect(task?.status).toBe("done");
    expect(api.exportCalls).toContain(UPLOADED);
    expect(files.length).toBe(1);
    const gpx = new TextDecoder().decode(files[0].bytes);
    expect(gpx).toContain("<trkpt ");
    // It's the shape-only synth — no real per-point time/elevation, and it is NOT
    // cached as a full track (the map must not claim real timestamps).
    expect(gpx).not.toContain("<time>");
    expect(gpx).not.toContain("<ele>");
    expect(c.getFullTrack(key)).toBeNull();
  });

  it("does NOT fall back for a genuine no-track failure (stays a real error)", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    // A non-retryable failure: the ride genuinely has no recorded track to export.
    api.exportRideGpx = async (_s: BeelineSession, pushId: string) => {
      api.exportCalls.push(pushId);
      throw new BeelineError("ride has no recorded track to export", "no-track");
    };
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const files: { bytes: Uint8Array }[] = [];
    c.onGpx((f) => files.push(f));

    c.downloadGpx([key], "", "full");
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // No silent route-only fallback — the task fails so the user sees the real reason.
    const task = c.state().jobs.history.find((t) => t.kind === "download-gpx");
    expect(task?.status).toBe("error");
    expect(files.length).toBe(0);
  });

  it("fetchFullTrack returns the parsed track and caches it (one fetch on revisit)", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const ft = await c.fetchFullTrack(key);
    expect(ft.points.length).toBeGreaterThanOrEqual(2);
    expect(ft.eles[0]).toBe(10);
    expect(api.exportCalls).toEqual([UPLOADED]);

    // The fetched GPX is cached on disk + the ride record reflects it, so a reload
    // shows the ride as cached instead of offering to fetch again. The cache write
    // is fire-and-forget (gzip), so wait for it to settle like the live UI does.
    await vi.waitFor(() =>
      expect(c.state().rides.find((r) => r.key === key)?.gpx_cached).toBe(true),
    );

    // A second call is served from the in-memory cache — no extra cloud fetch.
    await c.fetchFullTrack(key);
    expect(api.exportCalls).toEqual([UPLOADED]);
  });

  it("renames a ride on the backend and mirrors the new name locally (keeping its place suffix)", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const before = c.store.rides.get(key)!;
    const suffix = before.title.slice(before.title_base.length); // ", <place>"

    c.rename(key, "Sunday spin");
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // The backend was asked to rename the right push-id…
    expect(api.renameCalls).toEqual([{ pushId: UPLOADED, name: "Sunday spin" }]);
    expect(api.rides[UPLOADED].name).toBe("Sunday spin");
    // …and the local record reflects the new base name while keeping the location suffix.
    const after = c.store.rides.get(key)!;
    expect(after.title_base).toBe("Sunday spin");
    expect(after.title).toBe(`Sunday spin${suffix}`);
    expect(after.deleted).toBe(false);
  });

  it("keeps a ride's destination suffix after a GPX download (persistDetail bug)", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    const files: { downloadName: string; bytes: Uint8Array; mime?: string }[] = [];
    c.onGpx((f) => files.push(f));
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // The uploaded fixture navigated to a named place, so its title carries a
    // reverse-geocoded destination suffix beyond the base name.
    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const before = c.store.rides.get(key)!;
    expect(before.title).toBe(`${before.title_base}, Old Harbour Cafe`);
    expect(before.title.length).toBeGreaterThan(before.title_base.length);

    // Downloading the GPX reads each ride's detail and persists it. The detail's
    // base title must NOT clobber the stored "base, place" title.
    c.downloadGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const updated = c.store.rides.get(key)!;
    expect(updated.title).toBe(before.title); // destination suffix preserved
    expect(updated.title_base).toBe(before.title_base);
  });

  it("renames even when cold (no prior scan this session) by refreshing first", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect(); // connected but byKey is empty — like an offline re-auth

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    c.rename(key, "Cold rename");
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    expect(api.renameCalls).toEqual([{ pushId: UPLOADED, name: "Cold rename" }]);
    expect(c.store.rides.get(key)?.title_base).toBe("Cold rename");
  });

  it("deletes a ride on the backend but keeps it locally as a tombstone", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = beelineRideKey(FIXTURE[UPLOADED].start as number);
    const before = c.store.rides.get(key)!;
    const keptTrack = before.track;
    expect(before.deleted).toBe(false);

    c.deleteRide(key);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // Gone from the account…
    expect(api.deleteCalls).toEqual([UPLOADED]);
    expect(api.rides[UPLOADED]).toBeUndefined();
    // …but still present locally, flagged deleted, with its data intact.
    const after = c.store.rides.get(key);
    expect(after).toBeDefined();
    expect(after?.deleted).toBe(true);
    expect(after?.deleted_at).toBeTruthy();
    expect(after?.track).toBe(keptTrack);
    expect(after?.source_id).toBe(UPLOADED);
  });

  it("fails the delete task (without tombstoning) when the ride is unknown to the backend", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const c = makeController(api);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // A key that was never on the server.
    const ghost = "Mon Jan 1 2001 at 00:00";
    c.deleteRide(ghost);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    expect(api.deleteCalls).toEqual([]); // never reached the write
    const task = c.state().jobs.history.find((t) => t.kind === "delete");
    expect(task?.status).toBe("error");
  });
});

describe("BeelineRideSource session renewal", () => {
  /** A sign-in that mints a session already (or nearly) past expiry, forcing a renew. */
  const expiredSignIn = async (email: string): Promise<BeelineSession> => ({
    idToken: "stale-token",
    uid: "fake-uid",
    email,
    refreshToken: "fake-refresh",
    expiresAt: Date.now() - 1, // already expired → proactive renew on first call
  });

  it("proactively renews the token before a call when it is near expiry", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const phases: string[] = [];
    const source = await BeelineRideSource.create("rider@example.com", "secret", () => 4, {
      api,
      signIn: expiredSignIn,
      sleep: async () => {},
      onRenew: (p) => phases.push(p),
    });

    const result = await source.enumerateCatalog();

    // The stale token was renewed BEFORE the fetch even tried, and the fetch worked.
    expect(api.refreshCalls).toBe(1);
    expect(phases).toEqual(["renewing", "renewed"]);
    expect(result.complete).toBe(true);
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it("reactively renews once and retries when a call is rejected as expired", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    const phases: string[] = [];
    // The token looks fresh (no proactive renew), but the backend rejects it once.
    let firstCall = true;
    const realFetch = api.fetchRides.bind(api);
    api.fetchRides = async () => {
      if (firstCall) {
        firstCall = false;
        throw new BeelineError("HTTP 401 token expired", "expired", 401);
      }
      return realFetch();
    };
    const source = await BeelineRideSource.create("rider@example.com", "secret", () => 4, {
      api,
      signIn: fakeSignIn, // fresh, far-from-expiry session
      sleep: async () => {},
      onRenew: (p) => phases.push(p),
    });

    const result = await source.enumerateCatalog();

    // One renew triggered by the 401, then the retried fetch succeeded.
    expect(api.refreshCalls).toBe(1);
    expect(phases).toEqual(["renewing", "renewed"]);
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it("reports failure and surfaces an expired error when the refresh token is rejected", async () => {
    const api = new FakeBeelineApi(structuredClone(FIXTURE));
    // The refresh token itself is dead (revoked / signed out elsewhere).
    api.refreshFails = new BeelineError("HTTP 400 token revoked", "expired", 400);
    const phases: string[] = [];
    const source = await BeelineRideSource.create("rider@example.com", "secret", () => 4, {
      api,
      signIn: expiredSignIn, // forces a proactive renew, which then fails
      sleep: async () => {},
      onRenew: (p) => phases.push(p),
    });

    await expect(source.enumerateCatalog()).rejects.toMatchObject({ kind: "expired" });
    expect(phases).toEqual(["renewing", "failed"]);
  });
});
