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

  it("scrubs known bad titles on load", async () => {
    map.set(STORAGE_KEY, blob({ "beeline::k": { key: "k", title: "Heatmap" } }));
    expect(byKey(await Store.load(backend), "k")!.title).toBe("");
  });

  it("scrubs stat-shaped titles persisted by an earlier parsing bug", async () => {
    // The old detail parser could store a stat value as the title when the heading
    // scrolled off-screen during a Check (e.g. "20,0km/h"). Loading must clear it
    // so a re-scan/check reseeds a real title.
    map.set(
      STORAGE_KEY,
      blob({ "beeline::k": { key: "k", title: "20,0km/h", title_base: "209m" } }),
    );
    const rec = byKey(await Store.load(backend), "k")!;
    expect(rec.title).toBe("");
    expect(rec.title_base).toBe("");
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

  it("scrubs known bad title_base on load", async () => {
    map.set(STORAGE_KEY, blob({ "beeline::k": { key: "k", title_base: "Journeys" } }));
    expect(byKey(await Store.load(backend), "k")!.title_base).toBe("");
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
});
