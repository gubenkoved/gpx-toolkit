import { describe, expect, it, vi } from "vitest";

import { Controller } from "../src/controller";
import { GpxRideSource } from "../src/gpx-source";
import { GpxCache } from "../src/gpxcache";
import { memoryBackend } from "../src/kv";
import { beelineRideKey, type RideCard, rideDatetime } from "../src/parsing";
import { Store } from "../src/store";
import { localTime } from "../src/tz";
import { buildZip } from "../src/zip";

/** A tiny GPX with two timed, elevated points and an optional <name>. */
function gpx(opts: { name?: string; times?: boolean } = {}): string {
  const { name, times = true } = opts;
  const pt = (lat: number, lon: number, ele: number, iso: string) =>
    `<trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele>${times ? `<time>${iso}</time>` : ""}</trkpt>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    // A real-world default namespace — exercises the namespace-robust extraction.
    `<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">` +
    (name ? `<metadata><name>${name}</name></metadata>` : "") +
    `<trk><trkseg>` +
    pt(52.0, 5.0, 10, "2026-06-13T14:22:00Z") +
    pt(52.01, 5.0, 20, "2026-06-13T14:32:00Z") +
    `</trkseg></trk></gpx>`
  );
}

function gpxFile(content: string, name: string, lastModified = Date.now()): File {
  return new File([content], name, { type: "application/gpx+xml", lastModified });
}

function makeSource(): { source: GpxRideSource; cache: GpxCache } {
  const cache = GpxCache.memory();
  return { source: new GpxRideSource(cache, () => 20), cache };
}

describe("GpxRideSource", () => {
  it("declares the right identity + capabilities (import yes, upload no)", () => {
    const { source } = makeSource();
    expect(source.kind).toBe("gpx");
    expect(source.capabilities).toEqual({ upload: false, import: true });
    expect(source.label()).toBe("GPX files");
    expect(source.deviceFields()).toMatchObject({ source: "gpx", device_model: "GPX files" });
  });

  it("enumerateCatalog is a no-op (GPX rides come from import, not scan)", async () => {
    const { source } = makeSource();
    expect(await source.enumerateCatalog()).toEqual({ cards: [], complete: false });
  });

  it("imports a GPX with <time>: key from first timestamp, name from <name>, metrics from track", async () => {
    const { source } = makeSource();
    const cards: RideCard[] = [];
    const { skipped } = await source.importFiles(
      [gpxFile(gpx({ name: "Morning loop" }), "ride.gpx")],
      (c) => cards.push(c),
    );
    expect(skipped).toEqual([]);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    // The display key is the ride-LOCAL wall-clock of the first <time> instant,
    // rendered in the timezone resolved from the track's first point (not the
    // browser's). `start_epoch` carries the authoritative UTC instant.
    const instant = Date.parse("2026-06-13T14:22:00Z");
    const tz = card.fields?.tz as string;
    expect(tz).toBeTruthy();
    expect(card.key).toBe(localTime(instant, tz).key);
    expect(card.fields?.start_epoch).toBe(instant);
    expect(card.title).toBe("Morning loop");
    expect(card.distance_km).toBeGreaterThan(0);
    expect(card.elapsed_sec).toBe(600); // 10 minutes between the two points
    expect(card.fields?.source).toBe("gpx");
    // Identity is content-addressed (SHA-256 of the bytes), distinct from the
    // display datetime in `key`; `source_id` mirrors it.
    expect(card.identity).toMatch(/^sha256:[0-9a-f]+$/);
    expect(card.fields?.source_id).toBe(card.identity);
    expect(card.fields?.moving_sec ?? null).toBeNull(); // deliberately not derived
    expect(card.fields?.track).toBeTruthy();
  });

  it("falls back to a filename date + name when the GPX has no <time> or <name>", async () => {
    const { source } = makeSource();
    const cards: RideCard[] = [];
    await source.importFiles(
      [gpxFile(gpx({ times: false }), "2026-06-13 Evening ride, Utrecht.gpx")],
      (c) => cards.push(c),
    );
    expect(cards).toHaveLength(1);
    // Noon default for a date-only filename, in local time.
    const expected = beelineRideKey(new Date(2026, 5, 13, 12, 0, 0, 0).getTime());
    expect(cards[0].key).toBe(expected);
    expect(cards[0].title).toBe("Evening ride");
    expect(cards[0].fields?.title).toBe("Evening ride, Utrecht");
  });

  it("imports the .gpx members of a .zip bundle", async () => {
    const { source } = makeSource();
    const zip = await buildZip([
      { name: "a.gpx", bytes: new TextEncoder().encode(gpx({ name: "Ride A" })) },
      { name: "nested/b.gpx", bytes: new TextEncoder().encode(gpx({ name: "Ride B" })) },
      { name: "readme.txt", bytes: new TextEncoder().encode("ignore me") },
    ]);
    const cards: RideCard[] = [];
    const { skipped } = await source.importFiles(
      [new File([zip as BlobPart], "bundle.zip", { type: "application/zip" })],
      (c) => cards.push(c),
    );
    expect(skipped).toEqual([]);
    expect(cards.map((c) => c.title).sort()).toEqual(["Ride A", "Ride B"]);
  });

  it("reports a skip for a file with no GPS track points", async () => {
    const { source } = makeSource();
    const empty = `<?xml version="1.0"?><gpx><trk><trkseg></trkseg></trk></gpx>`;
    const cards: RideCard[] = [];
    const { skipped } = await source.importFiles([gpxFile(empty, "blank.gpx")], (c) =>
      cards.push(c),
    );
    expect(cards).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("blank.gpx");
  });

  it("serves the original bytes for full export + a parsed full track, then deletes them", async () => {
    const { source } = makeSource();
    const cards: RideCard[] = [];
    await source.importFiles([gpxFile(gpx({ name: "Loop" }), "ride.gpx")], (c) =>
      cards.push(c),
    );
    // The source addresses rides by their content identity (the uid suffix), which
    // the Controller hands back via splitUid — not the display datetime in `key`.
    const key = cards[0].identity!;

    const files = await source.downloadGpx(new Set([key]));
    expect(files).toHaveLength(1);
    expect(new TextDecoder().decode(files[0].bytes)).toContain("<trkpt");

    const { track: ft } = await source.fetchFullTrack(key);
    expect(ft.points.length).toBe(2);
    expect(ft.times[0]).not.toBeNull();

    await source.deleteRide(key);
    const missing: string[] = [];
    await source.downloadGpx(new Set([key]), undefined, undefined, undefined, (k) =>
      missing.push(k),
    );
    expect(missing).toEqual([key]);
  });

  it("renames locally and never uploads (processTargets is a no-op)", async () => {
    const { source } = makeSource();
    const detail = await source.renameRide("Sat Jun 13 2026 at 14:22", "New name");
    expect(detail.title).toBe("New name");
    expect(detail.stravaStatus).toBe("unknown");
    expect(await source.processTargets()).toEqual([]);
  });

  it("keeps every file a distinct ride when start minutes collide (no <time>, shared mtime)", async () => {
    const { source } = makeSource();
    // Five DISTINCT route-style GPX files: no <time>, no date in the filename → each
    // falls back to the SAME file mtime, so their minute-resolution display keys are
    // identical. Content-addressed identity keeps them five separate rides anyway.
    const mtime = Date.parse("2026-06-13T14:22:33Z");
    const cards: RideCard[] = [];
    const { skipped } = await source.importFiles(
      [
        gpxFile(gpx({ name: "A", times: false }), "a.gpx", mtime),
        gpxFile(gpx({ name: "B", times: false }), "b.gpx", mtime),
        gpxFile(gpx({ name: "C", times: false }), "c.gpx", mtime),
        gpxFile(gpx({ name: "D", times: false }), "d.gpx", mtime),
        gpxFile(gpx({ name: "E", times: false }), "e.gpx", mtime),
      ],
      (c) => cards.push(c),
    );
    expect(skipped).toEqual([]);
    expect(cards).toHaveLength(5);
    // The display datetime is allowed to repeat (same minute) — it's display only …
    expect(new Set(cards.map((c) => c.key)).size).toBe(1);
    // … but every ride has a UNIQUE content identity, so none overwrites another.
    expect(new Set(cards.map((c) => c.identity)).size).toBe(5);
  });

  it("is idempotent: re-importing identical bytes yields the same identity", async () => {
    const { source } = makeSource();
    const bytes = gpx({ name: "Same ride" });
    const a: RideCard[] = [];
    const b: RideCard[] = [];
    await source.importFiles([gpxFile(bytes, "first.gpx")], (c) => a.push(c));
    await source.importFiles([gpxFile(bytes, "second.gpx")], (c) => b.push(c));
    // Same content → same identity → the Store upsert updates one ride, never dupes.
    expect(a[0].identity).toBe(b[0].identity);
  });

  it("reference date falls back to the upload instant when the GPX has no time info", async () => {
    const { source } = makeSource();
    const before = Date.now();
    const cards: RideCard[] = [];
    // No <time> codes, and a filename with no date → only the upload instant remains.
    await source.importFiles([gpxFile(gpx({ name: "Timeless", times: false }), "loop.gpx")], (c) =>
      cards.push(c),
    );
    const dt = rideDatetime(cards[0].key);
    expect(dt).not.toBeNull(); // a real reference date, not a content hash
    // Within a couple of minutes of "now" (the key is minute-resolution).
    expect(Math.abs(dt!.getTime() - before)).toBeLessThan(120_000);
  });
});

describe("Controller + GpxRideSource (multi-source coexistence)", () => {
  function makeController(): { c: Controller; cache: GpxCache; data: GpxCache; store: Store } {
    const store = new Store(memoryBackend());
    const cache = GpxCache.memory();
    const data = GpxCache.memory();
    const c = new Controller(
      async () => {
        throw new Error("no beeline in this test");
      },
      store,
      cache,
      data,
    );
    c.registerSource(new GpxRideSource(data, () => store.settings.trackPointsPerKm));
    return { c, cache, data, store };
  }

  it("imports GPX into the unified store as gpx-source rides (source + can_upload surfaced)", async () => {
    const { c } = makeController();
    c.importGpx([gpxFile(gpx({ name: "Imported ride" }), "ride.gpx")]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const rides = c.state().rides;
    expect(rides).toHaveLength(1);
    expect(rides[0].source).toBe("gpx");
    expect(rides[0].can_upload).toBe(false);
    expect(rides[0].title).toBe("Imported ride");
    // The uid is content-addressed; the datetime lives in date_key, not the uid.
    expect(rides[0].key).toMatch(/^gpx::sha256:[0-9a-f]+$/);
    expect(rideDatetime(rides[0].date_key)).not.toBeNull();
  });

  it("emits onImported with the new ride uids after a successful import", async () => {
    const { c } = makeController();
    const seen: string[][] = [];
    c.onImported((uids) => seen.push(uids));
    c.importGpx([
      gpxFile(gpx({ name: "Ride one" }), "one.gpx"),
      gpxFile(gpx({ name: "Ride two" }), "two.gpx", Date.parse("2026-07-01T09:00:00Z")),
    ]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    expect(seen).toHaveLength(1);
    const uids = seen[0];
    expect(uids).toHaveLength(2);
    // The emitted uids match the rides now in the store.
    const stored = new Set(c.state().rides.map((r) => r.key));
    for (const uid of uids) expect(stored.has(uid)).toBe(true);
  });

  it("suggestTagsAfterImport defaults on and toggles + persists", () => {
    const { c, store } = makeController();
    expect(c.state().settings.suggestTagsAfterImport).toBe(true);
    expect(c.setSuggestTagsAfterImport(false)).toBe(false);
    expect(c.state().settings.suggestTagsAfterImport).toBe(false);
    expect(store.settings.suggestTagsAfterImport).toBe(false);
  });

  it("upload over a GPX-only selection uploads nothing and reports it as skipped", async () => {
    const { c } = makeController();
    c.importGpx([gpxFile(gpx({ name: "Imported ride" }), "ride.gpx")]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const uid = c.state().rides[0].key;
    c.upload([uid]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // The GPX ride is untouched (never uploaded) and the task didn't error out.
    expect(c.state().rides[0].status).toBe("unknown");
    expect(c.state().jobs.current).toBeNull();
  });

  it("keeps imported GPX as DATA: a cache flush never deletes it", async () => {
    const { c, cache, data } = makeController();
    c.importGpx([gpxFile(gpx({ name: "Imported ride" }), "ride.gpx")]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const uid = c.state().rides[0].key;
    // The original lives in the DATA vault, not the re-fetchable cache.
    expect(data.has(uid)).toBe(true);
    expect(cache.has(uid)).toBe(false);
    // Accounting separates the two: no reclaimable cache, but imported data present.
    expect(c.gpxCacheCount()).toBe(0);
    expect(c.gpxDataCount()).toBe(1);
    // The ride reports its full GPX as available (served from the data vault).
    expect(c.state().rides[0].gpx_cached).toBe(true);

    // Flushing the download cache must leave the imported original — and its full
    // track availability — completely intact.
    await c.flushGpxCache();
    expect(data.has(uid)).toBe(true);
    expect(c.gpxDataCount()).toBe(1);
    expect(c.state().rides[0].gpx_cached).toBe(true);
    const ft = await c.fetchFullTrack(uid);
    expect(ft.points.length).toBe(2);
  });
});
