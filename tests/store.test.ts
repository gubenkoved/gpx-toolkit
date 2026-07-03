import { beforeEach, describe, expect, it } from "vitest";

import { type KeyValueStore, memoryBackend } from "../src/kv";
import { rideUid } from "../src/parsing";
import {
  DEFAULT_TRACK_POINTS_PER_KM,
  MOVING_THRESHOLD_MAX_KMH,
  SCHEMA_VERSION,
  STORAGE_KEY,
  Store,
} from "../src/store";
import { DEFAULT_MOVING_THRESHOLD_KMH } from "../src/track";

/** A current-schema persisted blob wrapping the given ride records (keyed by uid). */
function blob(rides: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({ schema: SCHEMA_VERSION, updated_at: "x", rides });
}

/** Look a record up by its datetime key. The map is keyed by the cross-source uid
 *  (`${source}::${datetime}`), but a record's own `key` stays the bare datetime. */
function byKey(s: Store, key: string) {
  return s.rides.get(rideUid("beeline", key));
}

describe("Store", () => {
  let map: Map<string, string>;
  let backend: KeyValueStore;
  beforeEach(() => {
    map = new Map<string, string>();
    backend = memoryBackend(map);
  });

  it("upserts and persists, then reloads", async () => {
    const s = await Store.load(backend);
    s.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      distance_km: 22.6,
      elapsed_sec: 5872,
    });
    s.save();
    await s.flush();

    const reloaded = await Store.load(backend);
    const rec = byKey(reloaded, "Sat Jun 13 2026 at 14:22")!;
    expect(rec.title).toBe("Afternoon ride");
    expect(rec.distance_km).toBeCloseTo(22.6);
    expect(rec.elapsed_sec).toBe(5872);
    expect(rec.strava_status).toBe("unknown");
  });

  it("stamps uploaded_at only on the transition to uploaded", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { strava_status: "pending" });
    expect(byKey(s, "k")!.uploaded_at).toBe("");
    s.upsert("k", { strava_status: "uploaded" });
    const at = byKey(s, "k")!.uploaded_at;
    expect(at).not.toBe("");
    s.upsert("k", { strava_status: "uploaded" }); // no second stamp
    expect(byKey(s, "k")!.uploaded_at).toBe(at);
  });

  it("stamps ingested_at once on first upsert and never overwrites it", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { title_base: "Morning ride" });
    const at = byKey(s, "k")!.ingested_at;
    expect(at).not.toBe(""); // stamped the first time the ride is seen
    s.upsert("k", { distance_km: 12.3 }); // a later sync/check
    expect(byKey(s, "k")!.ingested_at).toBe(at); // unchanged

    s.save();
    await s.flush();
    const reloaded = await Store.load(backend);
    expect(byKey(reloaded, "k")!.ingested_at).toBe(at); // persists across reload
  });

  it("stamps the reference date (key) once on first import, stable across re-import", async () => {
    const s = await Store.load(backend);
    const uid = rideUid("gpx", "sha256:deadbeefcafe"); // content-addressed GPX uid
    // First import stamps the reference date (display datetime) on the record.
    s.upsert(uid, { source: "gpx", key: "Mon Jun 1 2026 at 08:05", title_base: "Loop" });
    expect(s.rides.get(uid)!.key).toBe("Mon Jun 1 2026 at 08:05");
    // An idempotent re-import (same content uid) with a DIFFERENT reference date
    // (e.g. a fresh upload instant) must NOT move the original — set-once, like
    // ingested_at. Other fields still update.
    s.upsert(uid, { key: "Sat Jun 20 2026 at 10:00", title: "Renamed loop" });
    expect(s.rides.get(uid)!.key).toBe("Mon Jun 1 2026 at 08:05"); // unchanged
    expect(s.rides.get(uid)!.title).toBe("Renamed loop"); // updated
  });

  it("backfills ingested_at for a legacy record missing it (rollout)", async () => {
    map.set(STORAGE_KEY, blob({ "beeline::k": { key: "k", title: "Old ride" } }));
    const stamped = byKey(await Store.load(backend), "k")!.ingested_at;
    // Legacy records predate ingestion-date tracking; the store stamps "now" once on
    // load so every ride has a defined ingestion date (else the Added filter would
    // silently drop them). The exact value is unknowable, so just assert it's set.
    expect(stamped).not.toBe("");
    expect(Number.isNaN(Date.parse(stamped))).toBe(false);
  });

  it("round-trips the source identity (device_model)", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { device_model: "Beeline (rider@example.com)" });
    s.save();
    await s.flush();

    const reloaded = await Store.load(backend);
    const rec = byKey(reloaded, "k")!;
    expect(rec.device_model).toBe("Beeline (rider@example.com)");
  });

  it("defaults the device fields to empty for records without them", async () => {
    map.set(STORAGE_KEY, blob({ "beeline::k": { key: "k", title: "Ride" } }));
    const rec = byKey(await Store.load(backend), "k")!;
    expect(rec.device_model).toBe("");
  });

  it("seeds the display title from the scan name, then keeps the fuller checked title", async () => {
    const s = await Store.load(backend);
    // Scan writes only the short list name.
    s.upsert("k", { title_base: "Morning ride" });
    expect(byKey(s, "k")!.title_base).toBe("Morning ride");
    expect(byKey(s, "k")!.title).toBe("Morning ride"); // seeded so it renders before check

    // Check writes the fuller heading; the short name is preserved separately.
    s.upsert("k", { title: "Morning ride, Amstelveen" });
    expect(byKey(s, "k")!.title).toBe("Morning ride, Amstelveen");
    expect(byKey(s, "k")!.title_base).toBe("Morning ride");

    // A later scan must not clobber the fuller checked title.
    s.upsert("k", { title_base: "Morning ride" });
    expect(byKey(s, "k")!.title).toBe("Morning ride, Amstelveen");
  });

  it("export shape carries the schema version + updated_at + rides map", async () => {
    const s = await Store.load(backend);
    s.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      strava_status: "uploaded",
    });
    const parsed = JSON.parse(s.exportJson());
    expect(parsed.schema).toBe(SCHEMA_VERSION);
    expect(typeof parsed.updated_at).toBe("string");
    expect(Object.keys(parsed.rides)).toContain("beeline::Sat Jun 13 2026 at 14:22");
    const rec = parsed.rides["beeline::Sat Jun 13 2026 at 14:22"];
    expect(rec).toMatchObject({
      key: "Sat Jun 13 2026 at 14:22",
      title: "Afternoon ride",
      strava_status: "uploaded",
    });
    expect(rec).toHaveProperty("uploaded_at");
    expect(rec).toHaveProperty("last_seen");
  });

  it("round-trips an exported state file through import (schema-gated)", async () => {
    const s = await Store.load(backend);
    s.upsert("existing", { title: "Old" });
    s.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      distance_km: 22.6,
      avg_speed_kmh: 20.0,
      moving_sec: 1 * 3600 + 7 * 60 + 42,
      elapsed_sec: 1 * 3600 + 37 * 60 + 52,
      elevation_gain_m: 25,
      strava_status: "uploaded",
    });
    const exported = s.exportJson();

    const fresh = await Store.load(memoryBackend());
    expect(fresh.importJson(exported)).toBe(2);
    const rec = byKey(fresh, "Sat Jun 13 2026 at 14:22")!;
    expect(rec.strava_status).toBe("uploaded");
    expect(rec.distance_km).toBeCloseTo(22.6);
    expect(rec.avg_speed_kmh).toBeCloseTo(20.0);
    expect(rec.moving_sec).toBe(1 * 3600 + 7 * 60 + 42);
    expect(rec.elevation_gain_m).toBeCloseTo(25);
    expect(byKey(fresh, "existing")).toBeDefined();
  });

  it("rejects an unversioned or wrong-schema blob (clean slate, no half-load)", async () => {
    // A pre-versioning blob (no `schema`) is discarded on load, not guessed at.
    map.set(
      STORAGE_KEY,
      JSON.stringify({
        updated_at: "x",
        rides: { "beeline::k": { key: "k", title: "Ride" } },
      }),
    );
    expect((await Store.load(backend)).rides.size).toBe(0);

    // And importing one merges nothing rather than half-loading it.
    const s = await Store.load(memoryBackend());
    expect(
      s.importJson(
        JSON.stringify({ schema: 999, rides: { "beeline::k": { key: "k", title: "Ride" } } }),
      ),
    ).toBe(0);
    expect(s.rides.size).toBe(0);
  });

  it("v1→v2 migrates Beeline rides to push-id uids and collapses tz-move duplicates", async () => {
    // A v1 blob: the same real ride appears TWICE — the tombstoned original (old
    // timezone) and the live duplicate a timezone move produced — plus a GPX ride
    // and a push-id-less legacy Beeline ride that must pass through untouched.
    map.set(
      STORAGE_KEY,
      JSON.stringify({
        schema: 1,
        updated_at: "x",
        rides: {
          "beeline::Wed Jun 3 2026 at 19:04": {
            key: "Wed Jun 3 2026 at 19:04",
            source: "beeline",
            source_id: "demo-uploaded-0001",
            title: "Evening ride",
            track: "old-track",
            deleted: true,
            deleted_at: "2026-07-01T00:00:00.000Z",
            last_seen: "2026-06-30T00:00:00.000Z",
          },
          "beeline::Thu Jun 4 2026 at 00:04": {
            key: "Thu Jun 4 2026 at 00:04",
            source: "beeline",
            source_id: "demo-uploaded-0001",
            title: "Evening ride",
            track: "live-track",
            deleted: false,
            last_seen: "2026-07-02T00:00:00.000Z",
          },
          "gpx::sha256:deadbeef": {
            key: "Mon Jun 1 2026 at 08:05",
            source: "gpx",
            source_id: "sha256:deadbeef",
            title: "Loop",
          },
          "beeline::Fri Jun 5 2026 at 09:00": {
            key: "Fri Jun 5 2026 at 09:00",
            source: "beeline",
            source_id: "",
            title: "Legacy",
          },
        },
      }),
    );
    const s = await Store.load(backend);

    // The pair collapsed onto ONE push-id uid, resurrected LIVE, keeping the richer
    // (live) record's data + display datetime.
    const merged = s.rides.get(rideUid("beeline", "demo-uploaded-0001"));
    expect(merged).toBeDefined();
    expect(merged!.deleted).toBe(false);
    expect(merged!.track).toBe("live-track");
    expect(merged!.key).toBe("Thu Jun 4 2026 at 00:04");
    // The old datetime-keyed uids are gone.
    expect(s.rides.has("beeline::Wed Jun 3 2026 at 19:04")).toBe(false);
    expect(s.rides.has("beeline::Thu Jun 4 2026 at 00:04")).toBe(false);

    // GPX (content-addressed) + push-id-less Beeline records are untouched.
    expect(s.rides.get(rideUid("gpx", "sha256:deadbeef"))!.title).toBe("Loop");
    expect(s.rides.get(rideUid("beeline", "Fri Jun 5 2026 at 09:00"))!.title).toBe("Legacy");

    // Persisted at the current schema so the migration runs only once.
    await s.flush();
    expect(JSON.parse(map.get(STORAGE_KEY)!).schema).toBe(SCHEMA_VERSION);
  });

  it("defaults, clamps, and round-trips the track-detail setting", async () => {
    const s = await Store.load(backend);
    expect(s.settings.trackPointsPerKm).toBe(DEFAULT_TRACK_POINTS_PER_KM);
    expect(s.setTrackPointsPerKm(0)).toBe(1); // clamped up to the minimum
    expect(s.setTrackPointsPerKm(9999)).toBe(100); // clamped down to the maximum
    s.setTrackPointsPerKm(25);
    await s.flush();
    expect((await Store.load(backend)).settings.trackPointsPerKm).toBe(25);
  });

  it("defaults, clamps, and round-trips the moving-speed threshold", async () => {
    const s = await Store.load(backend);
    expect(s.settings.movingThresholdKmh).toBe(DEFAULT_MOVING_THRESHOLD_KMH);
    expect(s.setMovingThreshold(-5)).toBe(0); // clamped up to the floor
    expect(s.setMovingThreshold(9999)).toBe(MOVING_THRESHOLD_MAX_KMH); // clamped to the ceiling
    expect(s.setMovingThreshold(2.5)).toBe(2.5); // fractional kept
    await s.flush();
    expect((await Store.load(backend)).settings.movingThresholdKmh).toBe(2.5);
  });

  it("defaults on and round-trips the suggest-tags-after-import toggle", async () => {
    const s = await Store.load(backend);
    expect(s.settings.suggestTagsAfterImport).toBe(true);
    expect(s.setSuggestTagsAfterImport(false)).toBe(false);
    await s.flush();
    expect((await Store.load(backend)).settings.suggestTagsAfterImport).toBe(false);
  });

  it("persists a per-ride rough track", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { track: "abc123" });
    s.save();
    await s.flush();
    expect(byKey(await Store.load(backend), "k")!.track).toBe("abc123");
  });

  it("persists per-ride GPX capture metadata", async () => {
    const s = await Store.load(backend);
    s.upsert("k", {
      track: "abc123",
      track_src_points: 1432,
      track_points: 87,
      track_km: 12.3,
      track_bytes: 24576,
    });
    s.save();
    await s.flush();
    const rec = byKey(await Store.load(backend), "k")!;
    expect(rec.track_src_points).toBe(1432);
    expect(rec.track_points).toBe(87);
    expect(rec.track_km).toBe(12.3);
    expect(rec.track_bytes).toBe(24576);
  });

  it("clear() wipes rides, restores default settings, and removes the stored blob", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { title: "Ride" });
    s.setTrackPointsPerKm(30);
    s.save();
    await s.flush();
    expect(map.get(STORAGE_KEY)).not.toBeUndefined();

    s.clear();

    expect(s.rides.size).toBe(0);
    expect(s.settings.trackPointsPerKm).toBe(DEFAULT_TRACK_POINTS_PER_KM);
    expect(map.has(STORAGE_KEY)).toBe(false);
    // A fresh load now starts empty.
    expect((await Store.load(backend)).rides.size).toBe(0);
  });

  it("byteSize tracks the persisted payload: grows with rides, shrinks on clear", async () => {
    const s = await Store.load(backend);
    const empty = s.byteSize();
    expect(empty).toBeGreaterThan(0); // the serialized envelope is never zero bytes

    s.upsert("Sat Jun 13 2026 at 14:22", { title: "Afternoon ride", distance_km: 22.6 });
    s.save();
    await s.flush();
    const withRide = s.byteSize();
    expect(withRide).toBeGreaterThan(empty);

    // Importing more rides keeps the size in step without an explicit save/flush.
    s.importJson(blob({ "beeline::k2": { key: "k2", title: "Another" } }));
    expect(s.byteSize()).toBeGreaterThan(withRide);

    s.clear();
    expect(s.byteSize()).toBe(empty);
  });

  it("defaults tags to [] for legacy records written before tags existed", async () => {
    map.set(STORAGE_KEY, blob({ "beeline::k": { key: "k", title: "Ride" } }));
    expect(byKey(await Store.load(backend), "k")!.tags).toEqual([]);
  });

  it("setTags replaces and persists a ride's tag list", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { title: "Ride" });
    expect(s.setTags(rideUid("beeline", "k"), ["Commute", "Gravel"])).toBe(true);
    s.save();
    await s.flush();
    expect(byKey(await Store.load(backend), "k")!.tags).toEqual(["Commute", "Gravel"]);

    // Replacing with a new list overwrites; an empty list clears.
    const s2 = await Store.load(backend);
    s2.setTags(rideUid("beeline", "k"), []);
    expect(byKey(s2, "k")!.tags).toEqual([]);
  });

  it("setTags returns false (no change) when the list is identical, and no-ops unknown keys", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { title: "Ride" });
    s.setTags(rideUid("beeline", "k"), ["Commute"]);
    expect(s.setTags(rideUid("beeline", "k"), ["Commute"])).toBe(false);
    expect(s.setTags(rideUid("beeline", "missing"), ["Commute"])).toBe(false);
  });

  it("setTags never resurrects a deleted ride (no side effects beyond tags)", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { title: "Ride" });
    s.markDeleted(rideUid("beeline", "k"));
    expect(byKey(s, "k")!.deleted).toBe(true);
    s.setTags(rideUid("beeline", "k"), ["Commute"]);
    // Tagging must not clear the deleted flag the way upsert (seeing a ride) does.
    expect(byKey(s, "k")!.deleted).toBe(true);
    expect(byKey(s, "k")!.tags).toEqual(["Commute"]);
  });

  it("remove() hard-deletes a record and reports whether one existed", async () => {
    const s = await Store.load(backend);
    s.upsert("a", { title: "Ride A" });
    s.upsert("b", { title: "Ride B" });

    // Removes the named record, leaves the other intact, returns true.
    expect(s.remove(rideUid("beeline", "a"))).toBe(true);
    expect(byKey(s, "a")).toBeUndefined();
    expect(byKey(s, "b")!.title).toBe("Ride B");

    // Removing an unknown (or already-removed) key is a no-op returning false.
    expect(s.remove(rideUid("beeline", "a"))).toBe(false);
    expect(s.remove(rideUid("beeline", "missing"))).toBe(false);
  });
});
