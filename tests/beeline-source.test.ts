import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BeelineSession, RawBeelineRide } from "../src/beeline-api";
import { BeelineError } from "../src/beeline-api";
import type { BeelineApi } from "../src/beeline-source";
import { BeelineRideSource } from "../src/beeline-source";
import { Controller } from "../src/controller";
import { memoryBackend } from "../src/kv";
import { beelineRideKey } from "../src/parsing";
import { Store } from "../src/store";

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
    if (!raw || !raw.polyline) throw new Error("ride has no recorded track to export");
    // A tiny full GPX with real per-point ele + time so extractFullTrack has data.
    const start = raw.start ?? 0;
    const gpx =
      `<gpx version="1.1" creator="Beeline"><trk><trkseg>` +
      `<trkpt lat="52.0" lon="5.0"><ele>10</ele><time>${new Date(start).toISOString()}</time></trkpt>` +
      `<trkpt lat="52.001" lon="5.0"><ele>12</ele><time>${new Date(start + 10000).toISOString()}</time></trkpt>` +
      `</trkseg></trk></gpx>`;
    return new TextEncoder().encode(gpx);
  }
}

const fakeSignIn = async (email: string): Promise<BeelineSession> => ({
  idToken: "fake-token",
  uid: "fake-uid",
  email,
  expiresAt: Date.now() + 3_600_000,
});

function makeController(api: FakeBeelineApi): Controller {
  const store = new Store(memoryBackend());
  return new Controller(
    () =>
      BeelineRideSource.create("rider@example.com", "secret", () => 4, {
        api,
        signIn: fakeSignIn,
        sleep: async () => {},
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
