import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_TRACK_MAX_POINTS, LEGACY_STORAGE_KEY, STORAGE_KEY, Store } from "../src/store";

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

describe("Store", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memStorage();
  });

  it("upserts and persists, then reloads", () => {
    const s = Store.load(storage);
    s.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      distance: "22.6km",
      duration: "1:37:52",
    });
    s.save();

    const reloaded = Store.load(storage);
    const rec = reloaded.rides.get("Sat Jun 13 2026 at 14:22")!;
    expect(rec.title).toBe("Afternoon ride");
    expect(rec.distance).toBe("22.6km");
    expect(rec.strava_status).toBe("unknown");
  });

  it("stamps uploaded_at only on the transition to uploaded", () => {
    const s = Store.load(storage);
    s.upsert("k", { strava_status: "pending" });
    expect(s.rides.get("k")!.uploaded_at).toBe("");
    s.upsert("k", { strava_status: "uploaded" });
    const at = s.rides.get("k")!.uploaded_at;
    expect(at).not.toBe("");
    s.upsert("k", { strava_status: "uploaded" }); // no second stamp
    expect(s.rides.get("k")!.uploaded_at).toBe(at);
  });

  it("scrubs known bad titles on load", () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title: "Heatmap" } } }),
    );
    expect(Store.load(storage).rides.get("k")!.title).toBe("");
  });

  it("export shape matches the Python rides.json (updated_at + rides map)", () => {
    const s = Store.load(storage);
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

  it("imports a Python-produced rides.json and merges", () => {
    const s = Store.load(storage);
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

  it("migrates the legacy storage key to the new one", () => {
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ updated_at: "x", rides: { k: { key: "k", title: "Legacy ride" } } }),
    );
    const s = Store.load(storage);
    expect(s.rides.get("k")!.title).toBe("Legacy ride");
    // The data now lives under the new key, and the legacy key is cleared.
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(Store.load(storage).rides.get("k")!.title).toBe("Legacy ride");
  });

  it("defaults, clamps, and round-trips the track-detail setting", () => {
    const s = Store.load(storage);
    expect(s.settings.trackMaxPoints).toBe(DEFAULT_TRACK_MAX_POINTS);
    expect(s.setTrackMaxPoints(5)).toBe(20); // clamped up to the minimum
    expect(s.setTrackMaxPoints(9999)).toBe(500); // clamped down to the maximum
    s.setTrackMaxPoints(150);
    expect(Store.load(storage).settings.trackMaxPoints).toBe(150);
  });

  it("persists a per-ride rough track", () => {
    const s = Store.load(storage);
    s.upsert("k", { track: "abc123" });
    s.save();
    expect(Store.load(storage).rides.get("k")!.track).toBe("abc123");
  });
});
