/**
 * `Controller.dropDeleted` — the explicit, user-driven hard delete of already
 * tombstoned rides. Verifies it removes only `deleted` records (never a live ride),
 * clears each dropped ride's full-GPX blob, and reports the count.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Controller } from "../src/controller";
import { GpxCache } from "../src/gpxcache";
import { memoryBackend } from "../src/kv";
import { rideUid } from "../src/parsing";
import { Store } from "../src/store";
import { WindCache } from "../src/windcache";

describe("Controller.dropDeleted", () => {
  let store: Store;
  let gpxCache: GpxCache;
  let gpxData: GpxCache;
  let controller: Controller;

  const LIVE = "Sat Jun 13 2026 at 14:22";
  const DEAD = "Sun Jun 14 2026 at 09:05";
  const liveUid = rideUid("beeline", LIVE);
  const deadUid = rideUid("beeline", DEAD);

  beforeEach(async () => {
    store = await Store.load(memoryBackend());
    gpxCache = GpxCache.memory();
    gpxData = GpxCache.memory();
    const factory = async () => {
      throw new Error("factory not used in dropDeleted tests");
    };
    controller = new Controller(factory, store, gpxCache, gpxData, WindCache.memory());

    store.upsert(LIVE, { title: "Live ride", source: "beeline" });
    store.upsert(DEAD, { title: "Dead ride", source: "beeline" });
    store.markDeleted(deadUid);
    // The deleted ride still has a cached full-GPX blob that the drop must clear.
    await gpxCache.put(deadUid, new TextEncoder().encode("<gpx/>"));
  });

  it("drops only deleted rides, clears their blob, and returns the count", async () => {
    expect(gpxCache.has(deadUid)).toBe(true);

    const dropped = await controller.dropDeleted();

    expect(dropped).toBe(1);
    expect(store.rides.get(deadUid)).toBeUndefined();
    expect(store.rides.get(liveUid)?.title).toBe("Live ride"); // live ride untouched
    expect(gpxCache.has(deadUid)).toBe(false); // blob purged
  });

  it("never hard-deletes a live ride, even when explicitly named", async () => {
    const dropped = await controller.dropDeleted([LIVE]);

    expect(dropped).toBe(0);
    expect(store.rides.get(liveUid)?.title).toBe("Live ride");
    // The deleted ride is still present (it wasn't in the requested subset).
    expect(store.rides.get(deadUid)?.deleted).toBe(true);
  });

  it("drops a named subset of deleted rides", async () => {
    const dropped = await controller.dropDeleted([DEAD]);

    expect(dropped).toBe(1);
    expect(store.rides.get(deadUid)).toBeUndefined();
    expect(store.rides.get(liveUid)?.title).toBe("Live ride");
  });
});
