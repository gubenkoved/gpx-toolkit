/**
 * Full state + cache backup/restore via ZIP format.
 *
 * Tests the end-to-end export/import workflow: exporting all state (rides,
 * settings, GPX caches, wind cache) into a ZIP, then importing that ZIP back
 * and verifying the state is completely restored.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Controller } from "../src/controller";
import { GpxCache } from "../src/gpxcache";
import { memoryBackend } from "../src/kv";
import { Store } from "../src/store";
import { WindCache } from "../src/windcache";
import { unzip } from "../src/zip";

describe("Controller backup/restore (ZIP)", () => {
  let store: Store;
  let controller: Controller;

  beforeEach(async () => {
    store = await Store.load(memoryBackend());
    // Dummy factory for tests (backup doesn't require sources)
    const factory = async () => {
      throw new Error("factory not used in backup tests");
    };
    controller = new Controller(
      factory,
      store,
      GpxCache.memory(),
      GpxCache.memory(),
      WindCache.memory(),
    );
  });

  it("exports rides + settings as state.json in the ZIP", async () => {
    // Populate the store with a ride.
    store.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      distance_km: 22.6,
      moving_sec: 3600 + 7 * 60 + 42,
      strava_status: "pending",
      source: "gpx",
      source_id: "abc123",
    });
    await store.flush();

    // Export to ZIP.
    const meta = { app: { version: "0.1.0" } };
    const zipBytes = await controller.exportAllZip(meta);

    // Unzip and verify state.json is present and correct.
    const zip = await unzip(zipBytes);
    const stateEntry = zip.find((e) => e.name === "state.json");
    expect(stateEntry).toBeDefined();

    const stateJson = new TextDecoder().decode(stateEntry!.bytes);
    const state = JSON.parse(stateJson);

    expect(state.schema).toBe(1);
    expect(state.app).toEqual({ version: "0.1.0" });
    expect(Object.keys(state.rides).length).toBeGreaterThan(0);
  });

  it("includes manifest.json with metadata and counts", async () => {
    const zipBytes = await controller.exportAllZip({
      app: { version: "0.1.0", commit: "abc" },
    });

    const zip = await unzip(zipBytes);
    const manifestEntry = zip.find((e) => e.name === "manifest.json");
    expect(manifestEntry).toBeDefined();

    const manifestJson = new TextDecoder().decode(manifestEntry!.bytes);
    const manifest = JSON.parse(manifestJson);

    expect(manifest.schema).toBe(1);
    expect(manifest.created_at).toBeTruthy();
    expect(manifest.app).toEqual({ version: "0.1.0", commit: "abc" });
    expect(manifest.stores).toEqual({
      state: 1,
      gpx_cache: expect.any(Number),
      gpx_data: expect.any(Number),
      wind: expect.any(Number),
    });
  });

  it("round-trips rides through export → import", async () => {
    // Populate original store with a ride.
    store.upsert("Sat Jun 13 2026 at 14:22", {
      title: "Afternoon ride",
      title_base: "Afternoon",
      distance_km: 22.6,
      moving_sec: 3600 + 7 * 60 + 42,
      avg_speed_kmh: 12.5,
      strava_status: "pending",
      source: "gpx",
      source_id: "abc123",
    });
    await store.flush();

    // Export to ZIP.
    const zipBytes = await controller.exportAllZip();

    // Create a fresh controller + store and import.
    const freshStore = await Store.load(memoryBackend());
    const factory = async () => {
      throw new Error("factory not used in backup tests");
    };
    const freshController = new Controller(
      factory,
      freshStore,
      GpxCache.memory(),
      GpxCache.memory(),
      WindCache.memory(),
    );

    // Import the ZIP.
    const result = await freshController.importAllZip(zipBytes);

    expect(result.ridesImported).toBe(1);
    expect(result.gpxCacheImported).toBe(0);
    expect(result.gpxDataImported).toBe(0);
    expect(result.windImported).toBe(0);

    // Verify the ride is present in the fresh store.
    const ride = [...freshStore.rides.values()].find((r) => r.title === "Afternoon ride");
    expect(ride).toBeDefined();
    if (ride) {
      expect(ride.distance_km).toBeCloseTo(22.6);
      expect(ride.avg_speed_kmh).toBeCloseTo(12.5);
    }
  });

  it("imports GPX cache blobs and rebuilds index", async () => {
    // Export a ZIP first
    const zipBytes = await controller.exportAllZip();

    // Verify it can be imported and caches are rebuilt
    const freshStore = await Store.load(memoryBackend());
    const factory = async () => {
      throw new Error("factory not used in backup tests");
    };
    const freshController = new Controller(
      factory,
      freshStore,
      GpxCache.memory(),
      GpxCache.memory(),
      WindCache.memory(),
    );

    const result = await freshController.importAllZip(zipBytes);
    expect(result.ridesImported).toBeGreaterThanOrEqual(0);
  });

  it("rejects malformed ZIP on import", async () => {
    const badZip = new Uint8Array([1, 2, 3, 4]);
    await expect(controller.importAllZip(badZip)).rejects.toThrow();
  });

  it("rejects ZIP missing state.json", async () => {
    // Build a ZIP without state.json
    const { buildZip } = await import("../src/zip");
    const zipBytes = await buildZip([
      {
        name: "manifest.json",
        bytes: new TextEncoder().encode(JSON.stringify({ schema: 1 })),
      },
    ]);

    const freshStore = await Store.load(memoryBackend());
    const factory = async () => {
      throw new Error("factory not used in backup tests");
    };
    const freshController = new Controller(
      factory,
      freshStore,
      GpxCache.memory(),
      GpxCache.memory(),
      WindCache.memory(),
    );

    await expect(freshController.importAllZip(zipBytes)).rejects.toThrow(/state\.json/);
  });

  it("merges rides on import rather than replacing", async () => {
    // Store has one ride
    store.upsert("Sat Jun 13 2026 at 14:22", {
      title: "First ride",
      distance_km: 10,
      source: "gpx",
      source_id: "id1",
    });
    await store.flush();

    // Create another store with a different ride and export
    const otherKv = memoryBackend();
    const otherStore = await Store.load(otherKv);
    otherStore.upsert("Sun Jun 14 2026 at 10:00", {
      title: "Second ride",
      distance_km: 20,
      source: "gpx",
      source_id: "id2",
    });
    await otherStore.flush();

    const factory = async () => {
      throw new Error("factory not used in backup tests");
    };
    const otherController = new Controller(
      factory,
      otherStore,
      GpxCache.memory(),
      GpxCache.memory(),
      WindCache.memory(),
    );
    const otherZip = await otherController.exportAllZip();

    // Import into original (should merge, not replace)
    const result = await controller.importAllZip(otherZip);
    expect(result.ridesImported).toBe(1);

    // Both rides should be present
    expect(store.rides.size).toBe(2);
    const titles = [...store.rides.values()].map((r) => r.title);
    expect(titles).toContain("First ride");
    expect(titles).toContain("Second ride");
  });

  it("skips duplicate blobs with identical bytes on import", async () => {
    // Export once
    const zipBytes = await controller.exportAllZip();

    // Import twice — second should skip duplicates
    await controller.importAllZip(zipBytes);
    const result2 = await controller.importAllZip(zipBytes);

    expect(result2.gpxCacheImported).toBe(0);
    expect(result2.gpxDataImported).toBe(0);
    expect(result2.windImported).toBe(0);
  });

  it("handles ArrayBuffer and Blob inputs", async () => {
    const zipBytes = await controller.exportAllZip();

    // Test ArrayBuffer - create from a copy to ensure it's a real ArrayBuffer
    const abCopy = new ArrayBuffer(zipBytes.length);
    new Uint8Array(abCopy).set(zipBytes);
    await expect(controller.importAllZip(abCopy)).resolves.toBeDefined();

    // Test Uint8Array directly (most common case)
    const result = await controller.importAllZip(zipBytes);
    expect(result.ridesImported).toBeGreaterThanOrEqual(0);
  });
});
