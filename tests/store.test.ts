import { beforeEach, describe, expect, it } from "vitest";

import { memoryBackend, type KeyValueStore } from "../src/kv";
import { DEFAULT_TRACK_POINTS_PER_KM, STORAGE_KEY, Store } from "../src/store";

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
      distance: "22.6km",
      duration: "1:37:52",
    });
    s.save();
    await s.flush();

    const reloaded = await Store.load(backend);
    const rec = reloaded.rides.get("Sat Jun 13 2026 at 14:22")!;
    expect(rec.title).toBe("Afternoon ride");
    expect(rec.distance).toBe("22.6km");
    expect(rec.strava_status).toBe("unknown");
  });

  it("stamps uploaded_at only on the transition to uploaded", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { strava_status: "pending" });
    expect(s.rides.get("k")!.uploaded_at).toBe("");
    s.upsert("k", { strava_status: "uploaded" });
    const at = s.rides.get("k")!.uploaded_at;
    expect(at).not.toBe("");
    s.upsert("k", { strava_status: "uploaded" }); // no second stamp
    expect(s.rides.get("k")!.uploaded_at).toBe(at);
  });

  it("scrubs known bad titles on load", async () => {
    map.set(
      STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title: "Heatmap" } } }),
    );
    expect((await Store.load(backend)).rides.get("k")!.title).toBe("");
  });

  it("scrubs stat-shaped titles persisted by an earlier parsing bug", async () => {
    // The old detail parser could store a stat value as the title when the heading
    // scrolled off-screen during a Check (e.g. "20,0km/h"). Loading must clear it
    // so a re-scan/check reseeds a real title.
    map.set(
      STORAGE_KEY,
      JSON.stringify({
        updated_at: "x",
        rides: { k: { key: "k", title: "20,0km/h", title_base: "209m" } },
      }),
    );
    const rec = (await Store.load(backend)).rides.get("k")!;
    expect(rec.title).toBe("");
    expect(rec.title_base).toBe("");
  });

  it("round-trips the source-phone identity (model + serial)", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { device_model: "Pixel 10 Pro", device_serial: "ABC123" });
    s.save();
    await s.flush();

    const reloaded = await Store.load(backend);
    const rec = reloaded.rides.get("k")!;
    expect(rec.device_model).toBe("Pixel 10 Pro");
    expect(rec.device_serial).toBe("ABC123");
  });

  it("defaults the device fields to empty for legacy records without them", async () => {
    map.set(
      STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title: "Ride" } } }),
    );
    const rec = (await Store.load(backend)).rides.get("k")!;
    expect(rec.device_model).toBe("");
    expect(rec.device_serial).toBe("");
  });

  it("seeds the display title from the scan name, then keeps the fuller checked title", async () => {
    const s = await Store.load(backend);
    // Scan writes only the short list name.
    s.upsert("k", { title_base: "Morning ride" });
    expect(s.rides.get("k")!.title_base).toBe("Morning ride");
    expect(s.rides.get("k")!.title).toBe("Morning ride"); // seeded so it renders before check

    // Check writes the fuller heading; the short name is preserved separately.
    s.upsert("k", { title: "Morning ride, Amstelveen" });
    expect(s.rides.get("k")!.title).toBe("Morning ride, Amstelveen");
    expect(s.rides.get("k")!.title_base).toBe("Morning ride");

    // A later scan must not clobber the fuller checked title.
    s.upsert("k", { title_base: "Morning ride" });
    expect(s.rides.get("k")!.title).toBe("Morning ride, Amstelveen");
  });

  it("scrubs known bad title_base on load", async () => {
    map.set(
      STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title_base: "Journeys" } } }),
    );
    expect((await Store.load(backend)).rides.get("k")!.title_base).toBe("");
  });

  it("export shape matches the Python rides.json (updated_at + rides map)", async () => {
    const s = await Store.load(backend);
    s.upsert("Sat Jun 13 2026 at 14:22", { title: "Afternoon ride", strava_status: "uploaded" });
    const parsed = JSON.parse(s.exportJson());
    expect(typeof parsed.updated_at).toBe("string");
    expect(Object.keys(parsed.rides)).toContain("Sat Jun 13 2026 at 14:22");
    const rec = parsed.rides["Sat Jun 13 2026 at 14:22"];
    expect(rec).toMatchObject({
      key: "Sat Jun 13 2026 at 14:22",
      title: "Afternoon ride",
      strava_status: "uploaded",
    });
    expect(rec).toHaveProperty("uploaded_at");
    expect(rec).toHaveProperty("last_seen");
  });

  it("imports a Python-produced rides.json and merges", async () => {
    const s = await Store.load(backend);
    s.upsert("existing", { title: "Old" });
    const python = JSON.stringify({
      updated_at: "2026-06-13T20:30:45+00:00",
      rides: {
        "Sat Jun 13 2026 at 14:22": {
          key: "Sat Jun 13 2026 at 14:22",
          title: "Afternoon ride",
          distance: "22.6km",
          duration: "1:37:52",
          strava_status: "uploaded",
          stats: { Distance: "22.6km" },
          last_seen: "2026-06-13T20:30:45+00:00",
          uploaded_at: "2026-06-13T19:15:22+00:00",
        },
      },
    });
    const n = s.importJson(python);
    expect(n).toBe(1);
    expect(s.rides.get("Sat Jun 13 2026 at 14:22")!.strava_status).toBe("uploaded");
    expect(s.rides.get("existing")).toBeDefined();
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

  it("persists a per-ride rough track", async () => {
    const s = await Store.load(backend);
    s.upsert("k", { track: "abc123" });
    s.save();
    await s.flush();
    expect((await Store.load(backend)).rides.get("k")!.track).toBe("abc123");
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
    const rec = (await Store.load(backend)).rides.get("k")!;
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
});
