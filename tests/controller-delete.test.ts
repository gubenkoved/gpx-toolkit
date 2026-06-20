/**
 * `Controller.deleteRides` — the bulk sibling of `deleteRide` behind the "Delete
 * selected" selection action. Verifies one queued sweep tombstones every selected
 * ride and dispatches each to its OWN source (a mixed Beeline + GPX selection is
 * fine), keying each by that source's bare key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Controller } from "../src/controller";
import { memoryBackend } from "../src/kv";
import { rideUid, splitUid } from "../src/parsing";
import type { RideSource } from "../src/source";
import { Store } from "../src/store";

describe("Controller.deleteRides", () => {
  let store: Store;
  let controller: Controller;
  let deleted: string[];

  const BEELINE_DT = "Sat Jun 13 2026 at 14:22";
  const GPX_DT = "Sun Jun 14 2026 at 09:05";
  const beelineUid = rideUid("beeline", BEELINE_DT);
  // A GPX ride's uid is content-addressed (a hash), NOT `gpx::<datetime>`.
  const gpxUid = "gpx::sha256:00112233445566778899aabbccddeeff";

  function fakeSource(kind: "beeline" | "gpx"): RideSource {
    return {
      kind,
      capabilities: { upload: kind === "beeline", import: kind === "gpx" },
      async deleteRide(key: string) {
        deleted.push(`${kind}:${key}`);
      },
    } as unknown as RideSource;
  }

  beforeEach(async () => {
    store = await Store.load(memoryBackend());
    deleted = [];
    const factory = async () => {
      throw new Error("factory not used in deleteRides tests");
    };
    controller = new Controller(factory, store);
    controller.registerSource(fakeSource("beeline"));
    controller.registerSource(fakeSource("gpx"));

    store.upsert(BEELINE_DT, { title: "Beeline ride", source: "beeline" });
    store.upsert(gpxUid, { key: GPX_DT, title: "Imported ride", source: "gpx" });
  });

  it("tombstones every selected ride across mixed sources in one sweep", async () => {
    expect(store.rides.get(beelineUid)?.deleted).toBe(false);
    expect(store.rides.get(gpxUid)?.deleted).toBe(false);

    controller.deleteRides([beelineUid, gpxUid]);
    await vi.waitFor(() => expect(controller.state().jobs.busy).toBe(false), {
      timeout: 5000,
    });

    // Both rides are tombstoned locally (kept as deleted rows, not dropped).
    expect(store.rides.get(beelineUid)?.deleted).toBe(true);
    expect(store.rides.get(gpxUid)?.deleted).toBe(true);

    // Each ride was dispatched to its own source with that source's bare key.
    expect(deleted).toHaveLength(2);
    expect(deleted).toContain(`beeline:${BEELINE_DT}`);
    expect(deleted).toContain(`gpx:${splitUid(gpxUid).dateKey}`);
  });
});
