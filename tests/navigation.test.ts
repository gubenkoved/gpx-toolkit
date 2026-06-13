import { describe, expect, it } from "vitest";

import { DemoAdb } from "../src/adb/demo";
import { BeelineApp, PROFILES } from "../src/beeline";

const instant = async (): Promise<void> => {};

describe("position-aware navigation", () => {
  it("does NOT scroll the list to check a ride already on screen", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    // Newest ride sits at the top of a freshly-opened list — already visible.
    const details = await app.processTargets(new Set(["Sat Jun 13 2026 at 14:22"]), false);
    expect(details[0].stravaStatus).toBe("pending");
    expect(demo.listScrolls).toBe(0); // zero wasteful scrolling
  });

  it("scrolls directionally toward an off-screen target instead of resetting to top", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    // Oldest ride is far down the list; reaching it needs a few DOWN scrolls only.
    const details = await app.processTargets(new Set(["Sun May 17 2026 at 12:29"]), false);
    expect(details[0].key).toBe("Sun May 17 2026 at 12:29");
    expect(demo.listScrolls).toBeGreaterThan(0);
    expect(demo.listScrolls).toBeLessThanOrEqual(4); // bounded, no top-reset round-trip
  });

  it("starts from the current position on a second pass (no re-scroll to top)", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);

    // First pass: walk down to the oldest ride, leaving the list near the bottom.
    await app.processTargets(new Set(["Sun May 17 2026 at 12:29"]), false);
    const afterFirst = demo.listScrolls;

    // Second pass on a ride near the bottom: needs almost no extra list scrolling,
    // because we did not bounce back to the top in between.
    await app.processTargets(new Set(["Tue May 19 2026 at 18:50"]), false);
    expect(demo.listScrolls - afterFirst).toBeLessThanOrEqual(1);
  });

  it("terminates (no infinite loop) when a requested ride no longer exists", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    const details = await app.processTargets(new Set(["Mon Jan 1 2001 at 00:00"]), false);
    expect(details).toHaveLength(0); // nothing found, but it returned cleanly
  });

  it("recovers when a ride-detail sheet is already open (does not false-flag missing)", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);

    // Leave the app on an *unrevealed* ride-detail sheet — its upload buttons are
    // below the fold, so only the stats/Options identify it as a detail.
    const cards = await app.listCards();
    await app.openCard(cards[0]);

    const missing: string[] = [];
    const details = await app.processTargets(
      new Set(["Sun May 17 2026 at 12:29"]), // a *different*, still-present ride
      false,
      async () => false,
      () => {},
      (keys) => missing.push(...keys),
    );

    expect(missing).toEqual([]); // the open detail must not cause a false "deleted"
    expect(details.map((d) => d.key)).toEqual(["Sun May 17 2026 at 12:29"]);
  });
});
