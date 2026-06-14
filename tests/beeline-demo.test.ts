import { describe, expect, it, vi } from "vitest";
import { mapBeelineRide } from "../src/beeline-api";
import { DEMO_BEELINE_EMAIL, demoBeelineDeps } from "../src/beeline-demo";
import { BeelineRideSource } from "../src/beeline-source";
import { Controller } from "../src/controller";
import { memoryBackend } from "../src/kv";
import { Store } from "../src/store";

describe("beeline demo", () => {
  it("serves a mappable, varied ride history", async () => {
    const deps = demoBeelineDeps();
    const rides = await deps.api.fetchRides({
      idToken: "x",
      uid: "x",
      email: DEMO_BEELINE_EMAIL,
      expiresAt: Date.now() + 1000,
    });
    const ids = Object.keys(rides);
    expect(ids.length).toBeGreaterThanOrEqual(10);

    // Every ride maps cleanly (real start time + decodable polyline).
    const statuses = new Set<string>();
    for (const id of ids) {
      const m = mapBeelineRide(id, rides[id], "Beeline (demo)");
      expect(m).not.toBeNull();
      expect(m?.fields.track).toBeTruthy();
      statuses.add(m?.fields.strava_status ?? "");
    }
    // The demo deliberately mixes uploaded + pending so uploads are demonstrable.
    expect(statuses.has("uploaded")).toBe(true);
    expect(statuses.has("pending")).toBe(true);
  });

  it("drives the full source: download then concurrent upload to completion", async () => {
    const store = new Store(memoryBackend());
    const c = new Controller(
      () =>
        BeelineRideSource.create(
          DEMO_BEELINE_EMAIL,
          "demo",
          () => 4,
          // Instant sleep so the test doesn't wait on the demo's paced polling.
          { ...demoBeelineDeps(), sleep: async () => {} },
        ),
      store,
    );
    await c.connect();
    expect(c.state().device).toBe(`Beeline (${DEMO_BEELINE_EMAIL})`);

    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });
    const pendingBefore = store.pending().length;
    expect(pendingBefore).toBeGreaterThan(0);

    c.upload(store.pending().map((r) => r.key));
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    expect(store.pending().length).toBe(0);
  });
});
