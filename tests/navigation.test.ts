import { describe, expect, it } from "vitest";

import { DemoAdb, makeDemoRides } from "../src/adb/demo";
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

  it("downloads a GPX for the on-screen ride without any list scrolling", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    // Newest ride is already at the top of a freshly-opened list.
    const files = await app.downloadGpx(new Set(["Sat Jun 13 2026 at 14:22"]));
    expect(files).toHaveLength(1);
    expect(demo.listScrolls).toBe(0); // no scroll-to-top round trip
  });

  it("downloads a GPX for an off-screen ride by scrolling toward it, not to the top", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);
    // Oldest ride is far down the list; reaching it needs a few DOWN scrolls only.
    const files = await app.downloadGpx(new Set(["Sun May 17 2026 at 12:29"]));
    expect(files).toHaveLength(1);
    expect(demo.listScrolls).toBeGreaterThan(0);
    expect(demo.listScrolls).toBeLessThanOrEqual(4); // bounded, no top-reset round-trip
  });

  it("does not re-scroll to the top between two consecutive GPX downloads", async () => {
    const demo = new DemoAdb();
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);

    // First download walks down to the oldest ride, leaving the list near the bottom.
    await app.downloadGpx(new Set(["Sun May 17 2026 at 12:29"]));
    const afterFirst = demo.listScrolls;

    // Second download of a ride near the bottom needs almost no extra scrolling,
    // because we did not bounce back to the top in between.
    await app.downloadGpx(new Set(["Tue May 19 2026 at 18:50"]));
    expect(demo.listScrolls - afterFirst).toBeLessThanOrEqual(1);
  });
});

describe("fast far-scrolling (fling coarse→fine)", () => {
  it("reaches a ride deep in a long list with far fewer dumps than the normal drag", async () => {
    const rides = makeDemoRides(120);
    const oldest = rides[rides.length - 1].key;

    const slow = new DemoAdb({ rides: makeDemoRides(120) });
    const slowApp = await BeelineApp.create(slow, PROFILES.normal, instant);
    const slowDetails = await slowApp.processTargets(new Set([oldest]), false);

    const quick = new DemoAdb({ rides: makeDemoRides(120) });
    const quickApp = await BeelineApp.create(quick, PROFILES.fast, instant);
    const quickDetails = await quickApp.processTargets(new Set([oldest]), false);

    // Both land on the exact ride…
    expect(slowDetails.map((d) => d.key)).toEqual([oldest]);
    expect(quickDetails.map((d) => d.key)).toEqual([oldest]);
    // …but flinging serves dramatically fewer (expensive) uiautomator dumps.
    expect(quick.uiDumps).toBeLessThan(slow.uiDumps / 2);
  });

  it("lands exactly on a mid-list target despite coasting past it (overshoot recovery)", async () => {
    const rides = makeDemoRides(120);
    const target = rides[90].key; // deep enough that a fling will overshoot it

    const demo = new DemoAdb({ rides: makeDemoRides(120) });
    const app = await BeelineApp.create(demo, PROFILES.turbo, instant);
    const missing: string[] = [];
    const details = await app.processTargets(
      new Set([target]),
      false,
      async () => false,
      () => {},
      (keys) => missing.push(...keys),
    );

    expect(details.map((d) => d.key)).toEqual([target]); // exact landing
    expect(missing).toEqual([]); // a coasted-past present ride is never flagged deleted
  });

  it("still detects a deleted ride while fast-scrolling", async () => {
    const rides = makeDemoRides(120);
    const gone = rides[80].key;

    const demo = new DemoAdb({ rides: makeDemoRides(120) });
    demo.removeRide(gone); // user deleted it on the phone since we last saw it
    const app = await BeelineApp.create(demo, PROFILES.fast, instant);
    const missing: string[] = [];
    const details = await app.processTargets(
      new Set([gone]),
      false,
      async () => false,
      () => {},
      (keys) => missing.push(...keys),
    );

    expect(details).toHaveLength(0);
    expect(missing).toEqual([gone]); // bracketed-but-absent → correctly marked deleted
  });
});

describe("resilient navigation (recovers from missed swipes)", () => {
  it("recovers when an UP swipe fails to register instead of reversing downward", async () => {
    const rides = makeDemoRides(120);
    const oldest = rides[rides.length - 1].key;
    const target = rides[60].key; // sits ABOVE the bottom — reaching it needs UP scrolls

    // PROFILES.normal takes one controlled drag per step, so a single missed swipe
    // fully stalls that step — exactly the condition that used to be misread as
    // "top reached", after which the old code scrolled DOWN forever and gave up.
    const demo = new DemoAdb({ rides: makeDemoRides(120) });
    const app = await BeelineApp.create(demo, PROFILES.normal, instant);

    // Walk down to the oldest ride first so the list is parked near the bottom and
    // the next target lies strictly above the current view.
    await app.processTargets(new Set([oldest]), false);

    demo.missNextSwipes(1); // the first UP gesture toward the target silently fails
    const missing: string[] = [];
    const details = await app.processTargets(
      new Set([target]),
      false,
      async () => false,
      () => {},
      (keys) => missing.push(...keys),
    );

    expect(details.map((d) => d.key)).toEqual([target]); // found despite the missed swipe
    expect(missing).toEqual([]); // never wrongly declared deleted
  });

  it("recovers when a whole coarse fling step fails to register (fast profile)", async () => {
    const rides = makeDemoRides(120);
    const oldest = rides[rides.length - 1].key;

    // fast chains coarse_swipes_per_dump (3) flings per step; missing all three
    // stalls the step. The fix retries with a reliable drag rather than declaring
    // the end of the list, so the descent still reaches the very oldest ride.
    const demo = new DemoAdb({ rides: makeDemoRides(120) });
    const app = await BeelineApp.create(demo, PROFILES.fast, instant);

    demo.missNextSwipes(PROFILES.fast.coarse_swipes_per_dump); // whole first step misses
    const missing: string[] = [];
    const details = await app.processTargets(
      new Set([oldest]),
      false,
      async () => false,
      () => {},
      (keys) => missing.push(...keys),
    );

    expect(details.map((d) => d.key)).toEqual([oldest]); // reached the very bottom
    expect(missing).toEqual([]);
  });
});
