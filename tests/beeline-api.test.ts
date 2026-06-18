import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  type BeelineSession,
  deleteRide,
  exportRideGpx,
  gunzip,
  isTerminalStatus,
  mapBeelineRide,
  type RawBeelineRide,
  renameRide,
  stravaStatusOf,
} from "../src/beeline-api";
import { beelineRideKey, rideDatetime } from "../src/parsing";
import { decodePolyline } from "../src/track";

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "beeline",
      "rides-sample.json",
    ),
    "utf-8",
  ),
) as Record<string, RawBeelineRide>;

const LABEL = "Beeline (rider@example.com)";

// Mirror of the source's (unexported) time-of-day naming, so title assertions
// stay correct regardless of the machine's timezone.
function timeOfDayName(startMs: number): string {
  const h = new Date(startMs).getHours();
  if (h < 5) return "Night ride";
  if (h < 12) return "Morning ride";
  if (h < 17) return "Afternoon ride";
  if (h < 21) return "Evening ride";
  return "Night ride";
}

// Push-ids of the representative fixture rides (synthetic — see how the fixture
// is generated; no real tracks or addresses).
const UPLOADED = "demo-uploaded-0001"; // availableOnStrava, has polyline + elevation
const PENDING = "demo-pending-0002"; // no strava_activity, zero distance
const FAILED = "demo-failed-0003"; // uploadFailed
const PROCESSING = "demo-processing-0004"; // startedUploading
const NO_POLYLINE = "demo-notrack-0005"; // availableOnStrava, no polyline

describe("mapBeelineRide", () => {
  it("maps a full uploaded ride into canonical fields + a decodable track", () => {
    const m = mapBeelineRide(UPLOADED, FIXTURE[UPLOADED], LABEL);
    expect(m).not.toBeNull();
    if (!m) return;
    const f = m.fields;

    // Source attribution.
    expect(f.source).toBe("beeline");
    expect(f.source_id).toBe(UPLOADED);
    expect(f.device_model).toBe(LABEL);
    expect(f.strava_status).toBe("uploaded");

    // Metrics: Beeline's SI units converted straight into the app's normalized
    // numbers (metres→km, m/s→km/h, ms→seconds), no localized strings.
    expect(f.distance_km).toBeCloseTo(42.0, 2);
    expect(f.avg_speed_kmh).toBeCloseTo(25.2, 1);
    expect(f.max_speed_kmh).toBeCloseTo(41.4, 1);
    expect(f.moving_sec).toBe(6000);
    expect(f.elapsed_sec).toBe(6600);
    expect(f.elevation_gain_m).toBeCloseTo(320);
    expect(f.elevation_loss_m).toBeCloseTo(305);

    // Title: a time-of-day base name plus the routed destination as a location
    // suffix (Beeline stores no title, so we synthesize one). TZ-robust: the base
    // is the expected time-of-day name, the full title carries the destination.
    expect(f.title_base).toBe(timeOfDayName(FIXTURE[UPLOADED].start as number));
    expect(f.title).toBe(`${f.title_base}, Old Harbour Cafe`);

    // Track: the FULL inline polyline is stored verbatim (no simplification), so
    // it decodes to exactly the source points and matches the original string.
    expect(f.track).toBe(FIXTURE[UPLOADED].polyline);
    const decoded = decodePolyline(f.track ?? "");
    expect(decoded.length).toBeGreaterThan(2);
    expect(f.track_src_points).toBe(decoded.length);
    expect(f.track_points).toBe(decoded.length);
    expect(f.track_km ?? 0).toBeGreaterThan(0);
  });

  it("prefers the user-set ride name over a synthesized one (keeping the place suffix)", () => {
    // A ride the user named in the Beeline app, with a routed destination.
    const named: RawBeelineRide = {
      ...FIXTURE[PROCESSING],
      name: "Let's go sailing",
    };
    const m = mapBeelineRide("named-ride", named, LABEL);
    expect(m?.fields.title_base).toBe("Let's go sailing");
    // The destination place is still appended as the gray location suffix.
    expect(m?.fields.title).toBe("Let's go sailing, Tech Campus");
  });

  it("ignores a blank user name and falls back to the time-of-day name", () => {
    const blank: RawBeelineRide = { ...FIXTURE[PENDING], name: "   " };
    const m = mapBeelineRide("blank-name", blank, LABEL);
    expect(m?.fields.title_base).toBe(timeOfDayName(FIXTURE[PENDING].start as number));
  });

  it("treats a never-uploaded ride as pending and omits zero metrics", () => {
    const m = mapBeelineRide(PENDING, FIXTURE[PENDING], LABEL);
    expect(m?.fields.strava_status).toBe("pending");
    // Zero distance/speed must not produce bogus 0-valued metrics.
    expect(m?.fields.distance_km).toBeUndefined();
    expect(m?.fields.avg_speed_kmh).toBeUndefined();
    expect(m?.fields.max_speed_kmh).toBeUndefined();
    // It still has a usable track.
    expect(m?.fields.track).toBeTruthy();
    // No routed destination → just the time-of-day name, no location suffix.
    const base = timeOfDayName(FIXTURE[PENDING].start as number);
    expect(m?.fields.title_base).toBe(base);
    expect(m?.fields.title).toBe(base);
  });

  it("gives every ride a time-of-day name so none render as a bare 'Ride'", () => {
    for (const id of Object.keys(FIXTURE)) {
      const m = mapBeelineRide(id, FIXTURE[id], LABEL);
      const base = m?.fields.title_base ?? "";
      // Always a non-empty Strava-style name, and always a prefix of the full title.
      expect(base).toMatch(/^(Morning|Afternoon|Evening|Night) ride$/);
      expect(m?.fields.title?.startsWith(base)).toBe(true);
    }
  });

  it("treats a failed upload as pending (retryable)", () => {
    const m = mapBeelineRide(FAILED, FIXTURE[FAILED], LABEL);
    expect(m?.fields.strava_status).toBe("pending");
  });

  it("reports an in-flight upload as processing", () => {
    const m = mapBeelineRide(PROCESSING, FIXTURE[PROCESSING], LABEL);
    expect(m?.fields.strava_status).toBe("processing");
    expect(m?.fields.distance_km).toBeCloseTo(11.0);
  });

  it("handles an uploaded ride with no polyline (no track, still uploaded)", () => {
    const m = mapBeelineRide(NO_POLYLINE, FIXTURE[NO_POLYLINE], LABEL);
    expect(m?.fields.strava_status).toBe("uploaded");
    expect(m?.fields.track).toBeUndefined();
    expect(m?.fields.track_points).toBeUndefined();
  });

  it("derives a date key that round-trips through rideDatetime", () => {
    for (const id of Object.keys(FIXTURE)) {
      const m = mapBeelineRide(id, FIXTURE[id], LABEL);
      expect(m).not.toBeNull();
      if (!m) continue;
      const dt = rideDatetime(m.key);
      expect(dt).not.toBeNull();
      // Re-deriving the key from the parsed instant is stable.
      expect(beelineRideKey(dt!.getTime())).toBe(m.key);
    }
  });

  it("returns null when the ride has no start time", () => {
    expect(mapBeelineRide("x", {}, LABEL)).toBeNull();
    expect(mapBeelineRide("x", { start: Number.NaN }, LABEL)).toBeNull();
  });
});

describe("beelineRideKey", () => {
  it("formats an instant as a parseable ride key in local wall-clock time", () => {
    const start = FIXTURE[PROCESSING].start as number;
    const key = beelineRideKey(start);
    const dt = new Date(start);
    // The key carries the local wall-clock numbers (matching rideDatetime's local rebuild).
    const parsed = rideDatetime(key);
    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(dt.getFullYear());
    expect(parsed?.getMonth()).toBe(dt.getMonth());
    expect(parsed?.getDate()).toBe(dt.getDate());
    expect(parsed?.getHours()).toBe(dt.getHours());
    expect(parsed?.getMinutes()).toBe(dt.getMinutes());
  });

  it("returns '' for a non-finite instant", () => {
    expect(beelineRideKey(Number.NaN)).toBe("");
  });
});

describe("stravaStatusOf", () => {
  const cases: Array<[string, RawBeelineRide, string]> = [
    ["no activity → pending", {}, "pending"],
    [
      "availableOnStrava → uploaded",
      { strava_activity: { stravaUploadStatus: { status: "availableOnStrava" } } },
      "uploaded",
    ],
    [
      "finishedUploading → uploaded",
      { strava_activity: { stravaUploadStatus: { status: "finishedUploading" } } },
      "uploaded",
    ],
    [
      "startedUploading → processing",
      { strava_activity: { stravaUploadStatus: { status: "startedUploading" } } },
      "processing",
    ],
    [
      "uploadFailed → pending",
      { strava_activity: { stravaUploadStatus: { status: "uploadFailed" } } },
      "pending",
    ],
    [
      "unknown status with id → uploaded",
      { strava_activity: { id: 123, stravaUploadStatus: { status: "weird" } } },
      "uploaded",
    ],
    [
      "unknown status without id → pending",
      { strava_activity: { stravaUploadStatus: { status: "weird" } } },
      "pending",
    ],
  ];
  for (const [name, ride, expected] of cases) {
    it(name, () => {
      expect(stravaStatusOf(ride)).toBe(expected);
    });
  }

  it("isTerminalStatus: processing is non-terminal, others terminal", () => {
    expect(isTerminalStatus("processing")).toBe(false);
    expect(isTerminalStatus("uploaded")).toBe(true);
    expect(isTerminalStatus("pending")).toBe(true);
  });
});

describe("renameRide / deleteRide (RTDB writes)", () => {
  const SESSION: BeelineSession = {
    idToken: "tok/+=en", // contains chars that MUST be URL-encoded in the query
    uid: "uid123",
    email: "rider@example.com",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
  };

  it("renames via a PATCH that merges {name} into the ride node", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ name: "Sunday spin" }), { status: 200 });
    });
    vi.stubGlobal("fetch", stub);
    try {
      await renameRide(SESSION, "-PushId123", "Sunday spin");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(init.method).toBe("PATCH");
    expect(url).toContain("/rides/uid123/-PushId123.json");
    // The auth token (with /+= ) must be URL-encoded into the query string.
    expect(url).toContain(`auth=${encodeURIComponent(SESSION.idToken)}`);
    expect(JSON.parse(init.body as string)).toEqual({ name: "Sunday spin" });
  });

  it("deletes via a DELETE that clears the whole ride node (no body)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("null", { status: 200 });
    });
    vi.stubGlobal("fetch", stub);
    try {
      await deleteRide(SESSION, "-PushId123");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("/rides/uid123/-PushId123.json");
    expect(url).toContain(`auth=${encodeURIComponent(SESSION.idToken)}`);
    expect(init.body).toBeUndefined();
  });

  it("surfaces a Beeline error when the write fails", async () => {
    const stub = vi.fn(async () => new Response("permission denied", { status: 401 }));
    vi.stubGlobal("fetch", stub);
    try {
      await expect(deleteRide(SESSION, "-PushId123")).rejects.toThrow(/HTTP 401/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("gunzip", () => {
  it("decompresses gzip bytes", async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from("hello gpx")));
    expect(new TextDecoder().decode(await gunzip(gz))).toBe("hello gpx");
  });

  it("passes through bytes that aren't gzipped", async () => {
    const plain = new TextEncoder().encode("<gpx/>");
    expect(await gunzip(plain)).toEqual(plain);
  });
});

describe("exportRideGpx (full cloud track)", () => {
  const SESSION: BeelineSession = {
    idToken: "tok/+=en", // chars that MUST be URL-encoded where used in a URL
    uid: "uid123",
    email: "rider@example.com",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
  };

  it("calls exportRide, then downloads + gunzips the storage object", async () => {
    const gpx = `<gpx creator="Beeline"><trk><trkseg><trkpt lat="1" lon="2"><ele>3</ele></trkpt></trkseg></trk></gpx>`;
    const gz = new Uint8Array(gzipSync(Buffer.from(gpx)));
    const path = "ride-gpx-export/uid123/-Ride1.gpx.gz";
    const calls: { url: string; init: RequestInit }[] = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/exportRide")) {
        return new Response(JSON.stringify({ result: path }), { status: 200 });
      }
      return new Response(gz, { status: 200 });
    });
    vi.stubGlobal("fetch", stub);
    try {
      const bytes = await exportRideGpx(SESSION, "-Ride1");
      expect(new TextDecoder().decode(bytes)).toBe(gpx);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls).toHaveLength(2);
    // 1) POST exportRide with a Bearer token + the rideId payload.
    expect(calls[0].url).toContain("/exportRide");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SESSION.idToken}`,
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      data: { rideId: "-Ride1" },
    });
    // 2) GET the storage object: URL-encoded path, alt=media, Firebase auth header.
    expect(calls[1].url).toContain("firebasestorage.googleapis.com");
    expect(calls[1].url).toContain(encodeURIComponent(path));
    expect(calls[1].url).toContain("alt=media");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe(
      `Firebase ${SESSION.idToken}`,
    );
  });

  it("maps a NOT_FOUND export to a clear 'no recorded track' error", async () => {
    const stub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              status: "NOT_FOUND",
              message: "Unable to export ride due lack of ride points",
            },
          }),
          { status: 404 },
        ),
    );
    vi.stubGlobal("fetch", stub);
    try {
      await expect(exportRideGpx(SESSION, "-Ride1")).rejects.toThrow(/no recorded track/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
