import { describe, expect, it, vi } from "vitest";

import { DemoAdb } from "../src/adb/demo";
import type { AdbDevice } from "../src/adb/types";
import { PROFILES } from "../src/beeline";
import { Controller } from "../src/controller";
import { memoryBackend } from "../src/kv";
import { AdbRideSource } from "../src/source";
import { Store } from "../src/store";

function makeController(device: AdbDevice): Controller {
  // near-instant sleep so polling/scroll waits don't slow the suite
  return new Controller(
    () => AdbRideSource.create(device, PROFILES.normal, async () => {}),
    new Store(memoryBackend()),
  );
}

describe("Controller + DemoAdb (real orchestration, no phone)", () => {
  it("scans the catalog into the store", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const rides = c.state().rides;
    expect(rides.length).toBeGreaterThanOrEqual(14);
    const first = rides.find((r) => r.key === "Sat Jun 13 2026 at 14:22")!;
    expect(first.title).toBe("Afternoon ride");
    expect(first.distance).toBe("22.6km");
  });

  it("stamps the source phone (model + serial) onto rides it reads", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = "Sat Jun 13 2026 at 14:22";
    // The scan stamps the connected phone's identity onto each ride it writes.
    const scanned = c.store.rides.get(key)!;
    expect(scanned.device_model).toBe("Demo Pixel (no phone)");
    expect(scanned.device_serial).toBe("demo-serial");

    // A detail Check re-stamps the same identity alongside the read stats.
    c.status([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));
    const checked = c.store.rides.get(key)!;
    expect(checked.device_model).toBe("Demo Pixel (no phone)");
    expect(checked.device_serial).toBe("demo-serial");
  });

  it("checks a ride's status (reads detail without uploading)", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    c.status(["Sat Jun 13 2026 at 14:22"]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));
    const rec = c.state().rides.find((r) => r.key === "Sat Jun 13 2026 at 14:22")!;
    expect(rec.status).toBe("pending");
    expect(rec.stats["Average speed"]).toBe("20.0km/h");
  });

  it("backfills the summary distance/duration from detail stats on Check", async () => {
    const device = new DemoAdb();
    const store = new Store(memoryBackend());
    const c = new Controller(
      () => AdbRideSource.create(device, PROFILES.normal, async () => {}),
      store,
    );
    await c.connect();

    // Simulate a ride the list scan recorded WITHOUT distance/duration (the card
    // parse missed them), so the one-line summary would otherwise show "?".
    const key = "Sat Jun 13 2026 at 14:22";
    store.upsert(key, { title_base: "Afternoon ride" });
    let r = c.state().rides.find((v) => v.key === key)!;
    expect(r.distance).toBe("");
    expect(r.duration).toBe("");

    c.status([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    r = c.state().rides.find((v) => v.key === key)!;
    // Check reads the detail and backfills the empty summary fields from its stats.
    expect(r.distance).toBe("22.6km");
    expect(r.duration).toBe(r.stats["Elapsed time"]);
  });

  it("captures the ride detail while downloading GPX for a never-opened ride", async () => {
    const device = new DemoAdb();
    const store = new Store(memoryBackend());
    const c = new Controller(
      () => AdbRideSource.create(device, PROFILES.normal, async () => {}),
      store,
    );
    await c.connect();

    // A ride the list scan recorded with only its base title — no detail loaded yet
    // (no stats, no Strava status, no distance/duration on the summary line).
    const key = "Sat Jun 13 2026 at 14:22";
    store.upsert(key, { title_base: "Afternoon ride" });
    let r = c.state().rides.find((v) => v.key === key)!;
    expect(r.distance).toBe("");
    expect(r.duration).toBe("");
    expect(r.status).toBe("unknown");
    expect(Object.keys(r.stats)).toHaveLength(0);

    c.downloadGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    r = c.state().rides.find((v) => v.key === key)!;
    // The GPX track was captured…
    expect(r.track).not.toBe("");
    expect(r.track_points).toBeGreaterThan(0);
    // …AND the detail was read on the way: stats, status and summary fields too.
    expect(r.stats["Average speed"]).toBe("20.0km/h");
    expect(r.status).toBe("pending");
    expect(r.distance).toBe("22.6km");
    expect(r.duration).toBe(r.stats["Elapsed time"]);
  });

  it("keeps the scan name and splits the check-time location suffix", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    const key = "Sat Jun 13 2026 at 14:22";
    // After scan only: short name, no location suffix.
    let r = c.state().rides.find((v) => v.key === key)!;
    expect(r.title).toBe("Afternoon ride");
    expect(r.location).toBe("");

    // After check: the detail heading adds ", Demo City", surfaced as a separate suffix.
    c.status([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));
    r = c.state().rides.find((v) => v.key === key)!;
    expect(r.title).toBe("Afternoon ride");
    expect(r.location).toBe(", Demo City");
  });

  it("uploads a pending ride and reflects it as uploaded", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    const key = "Sat Jun 13 2026 at 14:22";
    c.upload([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const rec = c.state().rides.find((r) => r.key === key)!;
    expect(rec.status).toBe("uploaded");
    expect(rec.uploaded_at).not.toBe("");
  });

  it("skips rides already uploaded to Strava (never re-uploads)", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    const key = "Sat Jun 13 2026 at 14:22";
    // Pretend it's already on Strava (as a prior upload/Check would have recorded).
    c.store.upsert(key, { strava_status: "uploaded" });

    // The upload is filtered down to nothing before it can reach the queue.
    const snap = c.upload([key]);
    expect(snap.count).toBe(0);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));
    expect(c.state().rides.find((r) => r.key === key)!.status).toBe("uploaded");
  });

  it("coalesces multiple upload clicks into one pass and uploads all", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    const keys = [
      "Sat Jun 13 2026 at 14:22",
      "Fri Jun 12 2026 at 09:10",
      "Wed Jun 10 2026 at 18:02",
    ];
    for (const k of keys) c.upload([k]); // rapid successive clicks
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 8000 });

    const rides = c.state().rides;
    for (const k of keys) {
      expect(rides.find((r) => r.key === k)!.status).toBe("uploaded");
    }
  });

  it("does not hang on a ride key that no longer exists", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    // A key that is not in the catalog must terminate the pass, not loop forever.
    c.status(["Mon Jan 1 2001 at 00:00"]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 8000 });

    const last = c.state().jobs.history[0];
    expect(last.status).toBe("done"); // completed cleanly, no error/hang
    // Real rides are untouched by the failed lookup.
    expect(c.state().rides.length).toBeGreaterThanOrEqual(14);
  });

  it("surfaces rides incrementally during a scan (as they are found)", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();

    const counts: number[] = [];
    const off = c.onChange(() => counts.push(c.state().rides.length));
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });
    off();

    const final = c.state().rides.length;
    // There was at least one change where not all rides were known yet — i.e. the
    // store grew progressively rather than appearing all at once at the end.
    expect(counts.some((n) => n > 0 && n < final)).toBe(true);
    expect(counts[counts.length - 1]).toBe(final);
  });

  it("marks a ride deleted when a Check can't find it on the phone", async () => {
    const demo = new DemoAdb();
    const c = makeController(demo);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    const key = "Sat Jun 6 2026 at 15:30"; // a mid-list ride we know about
    expect(c.state().rides.find((r) => r.key === key)).toBeDefined();

    demo.removeRide(key); // user deletes it in the Beeline app
    c.status([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 8000 });

    const rec = c.state().rides.find((r) => r.key === key)!;
    expect(rec.deleted).toBe(true);
    expect(rec.deleted_at).not.toBe("");
  });

  it("marks vanished rides deleted after a completed scan, and un-deletes on reappearance", async () => {
    const demo = new DemoAdb();
    const c = makeController(demo);
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false));

    const key = "Sun Jun 7 2026 at 11:45";
    demo.removeRide(key);
    c.scan("all", null); // full sweep no longer sees it
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });
    expect(c.state().rides.find((r) => r.key === key)!.deleted).toBe(true);

    // It is NOT counted as pending anymore.
    const pendingKeys = c
      .state()
      .rides.filter((r) => r.status === "pending" && !r.deleted)
      .map((r) => r.key);
    expect(pendingKeys).not.toContain(key);
  });

  it("never marks rides deleted from a scan when the phone drifted to another app", async () => {
    const demo = new DemoAdb();
    const c = makeController(demo);
    await c.connect();
    c.scan("all", null); // a good first scan populates the store
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const before = c.state().rides.map((r) => r.key);
    expect(before.length).toBeGreaterThan(0);

    demo.leaveApp(); // user touches the phone → it drifts off Beeline mid-session
    c.scan("all", null); // this scan sees nothing because we're not on the list
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // The scan was incomplete (we couldn't confirm we were on the Journeys list), so
    // NOT A SINGLE ride may be flagged deleted despite none being seen this pass.
    const deleted = c
      .state()
      .rides.filter((r) => r.deleted)
      .map((r) => r.key);
    expect(deleted).toEqual([]);
  });

  it("downloads a GPX, emits the file, and stores a rough track", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const files: { filename: string; bytes: Uint8Array }[] = [];
    const off = c.onGpx((f) => files.push(f));

    const key = "Sat Jun 13 2026 at 14:22";
    c.downloadGpx([key], true); // save mode: also hand the full file to the UI
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 8000 });
    off();

    expect(files.length).toBe(1);
    expect(files[0].filename.toLowerCase()).toContain(".gpx");
    expect(files[0].bytes.byteLength).toBeGreaterThan(0);

    const rec = c.state().rides.find((r) => r.key === key)!;
    expect(rec.track.length).toBeGreaterThan(0); // a rough track was stored
  });

  it("preview-only download stores a track but emits no file", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const files: { filename: string; bytes: Uint8Array }[] = [];
    const off = c.onGpx((f) => files.push(f));

    const key = "Sat Jun 13 2026 at 14:22";
    c.downloadGpx([key]); // default: preview only, no disk save
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 8000 });
    off();

    expect(files.length).toBe(0); // nothing handed to the UI to save
    const rec = c.state().rides.find((r) => r.key === key)!;
    expect(rec.track.length).toBeGreaterThan(0); // but the preview track was stored
  });

  it("honours the track-detail density when simplifying", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    c.setTrackPointsPerKm(1);
    const keyA = "Sat Jun 13 2026 at 14:22";
    c.downloadGpx([keyA]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 8000 });
    const coarse = c.state().rides.find((r) => r.key === keyA)!.track;

    c.setTrackPointsPerKm(100);
    const keyB = "Fri Jun 12 2026 at 09:10";
    c.downloadGpx([keyB]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 8000 });
    const fine = c.state().rides.find((r) => r.key === keyB)!.track;

    // Same synthetic source shape; a higher density keeps at least as many points.
    expect(fine.length).toBeGreaterThanOrEqual(coarse.length);
  });

  it("reset() empties the ride cache and clears the queue", async () => {
    const c = makeController(new DemoAdb());
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });
    expect(c.state().rides.length).toBeGreaterThan(0);

    let notified = 0;
    const off = c.onChange(() => notified++);
    c.reset();
    off();

    expect(notified).toBeGreaterThan(0);
    expect(c.state().rides.length).toBe(0);
    expect(c.state().jobs.busy).toBe(false);
    expect(c.state().jobs.queue.length).toBe(0);
  });

  it("normalizes comma-decimal stats into numeric RideView fields (no 10x inflation)", () => {
    // A ride captured from a comma-decimal locale phone (the YAL-style device): the
    // raw strings use ',' as the decimal separator. controller.state() must parse
    // them ONCE, at the boundary, into the numeric fields the rest of the app uses.
    const store = new Store(memoryBackend());
    const c = new Controller(
      () => AdbRideSource.create(new DemoAdb(), PROFILES.normal, async () => {}),
      store,
    );
    const key = "Fri May 30 2025 at 08:45";
    store.upsert(key, {
      title_base: "Morning ride",
      distance: "13,5km",
      stats: {
        Distance: "13,5km",
        "Average speed": "20,0km/h",
        "Max speed": "33,4km/h",
        "Moving time": "0:40:30",
        "Elapsed time": "0:45:00",
        "Elevation gain": "209m",
        "Elevation loss": "215m",
      },
    });

    const r = c.state().rides.find((v) => v.key === key)!;
    // 13,5km is 13.5 km — emphatically NOT 135.
    expect(r.distance_km).toBeCloseTo(13.5);
    expect(r.avg_speed_kmh).toBeCloseTo(20.0);
    expect(r.max_speed_kmh).toBeCloseTo(33.4);
    expect(r.moving_sec).toBe(40 * 60 + 30);
    expect(r.elapsed_sec).toBe(45 * 60);
    expect(r.elevation_gain_m).toBeCloseTo(209);
    expect(r.elevation_loss_m).toBeCloseTo(215);
  });

  it("parses a period-decimal phone to the same numbers as a comma-decimal one", () => {
    // Both separators must yield identical numbers — the canonical parser is the
    // single source of truth regardless of the source phone's locale.
    const store = new Store(memoryBackend());
    const c = new Controller(
      () => AdbRideSource.create(new DemoAdb(), PROFILES.normal, async () => {}),
      store,
    );
    store.upsert("comma", {
      distance: "13,5km",
      stats: { Distance: "13,5km", "Average speed": "20,0km/h" },
    });
    store.upsert("period", {
      distance: "13.5km",
      stats: { Distance: "13.5km", "Average speed": "20.0km/h" },
    });

    const rides = c.state().rides;
    const comma = rides.find((r) => r.key === "comma")!;
    const period = rides.find((r) => r.key === "period")!;
    expect(comma.distance_km).toBeCloseTo(period.distance_km);
    expect(comma.distance_km).toBeCloseTo(13.5);
    expect(comma.avg_speed_kmh).toBeCloseTo(period.avg_speed_kmh);
    expect(comma.avg_speed_kmh).toBeCloseTo(20.0);
  });
});
