/**
 * Demo data + fake backend for the Beeline (cloud account) source.
 *
 * Where `DemoAdb` simulates the phone's UI-scraping mechanics, this simulates the
 * Beeline *cloud* mechanics so the demo faithfully shows how that source behaves:
 *  - one-shot history download (a single delayed `fetchRides`, not a per-ride scroll),
 *  - Strava uploads that run server-side and are observed by polling a status node,
 *  - several pending rides so concurrent uploads are visible.
 *
 * It implements the exact `BeelineApi` the real source depends on, so the whole
 * app — Controller, jobs, UI — runs end-to-end with no network and no account.
 * Tracks are synthesized as encoded polylines so the map/heatmap look populated.
 */

import type { BeelineSession, RawBeelineRide } from "./beeline-api";
import type { BeelineApi, BeelineSourceDeps } from "./beeline-source";
import { encodePolyline, type LatLon, trackLengthKm } from "./track";

const DEMO_EMAIL = "demo@beeline.app";

/** Small deterministic PRNG (mulberry32) so the demo dataset is stable across loads. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Anchor points (lat/lon) the demo rides loop around. Deliberately a few neutral,
 * well-mapped cities unrelated to any real user — the demo ships publicly, so it
 * must not hint at anyone's home/riding area. The tracks themselves are synthetic
 * loops generated around these anchors (no real GPS).
 */
const ANCHORS: LatLon[] = [
  [51.507, -0.128], // London
  [53.4808, -2.2426], // Manchester
  [51.4545, -2.5879], // Bristol
];

/** Build a wiggly closed-ish route of `n` points around an anchor. */
function makeTrack(anchor: LatLon, n: number, rnd: () => number): LatLon[] {
  const [lat0, lon0] = anchor;
  const pts: LatLon[] = [];
  // A noisy loop: walk an angle around the anchor with a varying radius.
  const baseR = 0.01 + rnd() * 0.03; // ~1–4 km radius
  let heading = rnd() * Math.PI * 2;
  let lat = lat0;
  let lon = lon0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = baseR * (0.6 + 0.4 * Math.sin(t * Math.PI)); // bulge out then back
    heading += (rnd() - 0.5) * 0.6; // gentle meander
    lat = lat0 + Math.sin(t * Math.PI * 2) * r + Math.cos(heading) * 0.0015;
    lon = lon0 + Math.cos(t * Math.PI * 2) * r * 1.6 + Math.sin(heading) * 0.0015;
    pts.push([lat, lon]);
  }
  return pts;
}

/** City for each anchor, used as the demo destination locality (the gray suffix). */
const ANCHOR_CITY = ["London", "Manchester", "Bristol"];

interface DemoSeed {
  /** Days before "now" the ride started. */
  daysAgo: number;
  /** Minutes-of-day start time. */
  startMin: number;
  anchor: number;
  points: number;
  avgKmh: number;
  /** Strava state: uploaded, pending (never uploaded), or processing (in-flight). */
  state: "uploaded" | "pending" | "processing";
  /**
   * Optional routed destination. `"poi"` attaches a named place (becomes the
   * gray location suffix), `"city"` attaches just the anchor city, and omitting it
   * leaves the ride with no destination (a free ride) — mirroring real data, where
   * only some rides navigated somewhere.
   */
  dest?: "poi" | "city";
}

/** A named POI per anchor for `dest: "poi"` demo rides. */
const ANCHOR_POI = ["Riverside Park", "Canal Loop", "Harbour Café"];

// A believable history spread across recent weeks: mostly on Strava, a handful
// pending (so an "Upload all pending" shows real concurrency), one mid-upload.
const SEEDS: DemoSeed[] = [
  {
    daysAgo: 1,
    startMin: 14 * 60 + 22,
    anchor: 0,
    points: 70,
    avgKmh: 21.5,
    state: "pending",
    dest: "poi",
  },
  {
    daysAgo: 1,
    startMin: 8 * 60 + 5,
    anchor: 1,
    points: 40,
    avgKmh: 18.2,
    state: "pending",
    dest: "city",
  },
  { daysAgo: 3, startMin: 18 * 60 + 2, anchor: 2, points: 55, avgKmh: 24.1, state: "pending" },
  {
    daysAgo: 4,
    startMin: 18 * 60 + 29,
    anchor: 0,
    points: 60,
    avgKmh: 19.7,
    state: "processing",
    dest: "city",
  },
  {
    daysAgo: 6,
    startMin: 11 * 60 + 45,
    anchor: 1,
    points: 95,
    avgKmh: 22.8,
    state: "uploaded",
    dest: "poi",
  },
  {
    daysAgo: 7,
    startMin: 15 * 60 + 30,
    anchor: 2,
    points: 48,
    avgKmh: 20.0,
    state: "uploaded",
  },
  {
    daysAgo: 9,
    startMin: 7 * 60 + 50,
    anchor: 0,
    points: 44,
    avgKmh: 17.4,
    state: "uploaded",
  },
  {
    daysAgo: 12,
    startMin: 19 * 60 + 5,
    anchor: 1,
    points: 58,
    avgKmh: 23.3,
    state: "uploaded",
    dest: "city",
  },
  {
    daysAgo: 15,
    startMin: 10 * 60 + 20,
    anchor: 2,
    points: 110,
    avgKmh: 25.6,
    state: "uploaded",
  },
  {
    daysAgo: 18,
    startMin: 9 * 60 + 15,
    anchor: 0,
    points: 52,
    avgKmh: 18.9,
    state: "uploaded",
  },
  {
    daysAgo: 22,
    startMin: 16 * 60 + 40,
    anchor: 1,
    points: 66,
    avgKmh: 21.1,
    state: "uploaded",
  },
  {
    daysAgo: 27,
    startMin: 8 * 60 + 30,
    anchor: 2,
    points: 38,
    avgKmh: 16.8,
    state: "pending",
  },
  {
    daysAgo: 33,
    startMin: 13 * 60 + 12,
    anchor: 0,
    points: 84,
    avgKmh: 24.7,
    state: "uploaded",
    dest: "poi",
  },
  {
    daysAgo: 41,
    startMin: 17 * 60 + 48,
    anchor: 1,
    points: 72,
    avgKmh: 22.0,
    state: "uploaded",
  },
];

const MS_PER_DAY = 86_400_000;
const MS_PER_MIN = 60_000;
const KMH_TO_MPS = 1 / 3.6;

/** Build the demo ride history keyed by synthetic push-id. */
function buildDemoRides(now: number): Record<string, RawBeelineRide> {
  const rnd = mulberry32(0xbee11e);
  const rides: Record<string, RawBeelineRide> = {};
  SEEDS.forEach((seed, i) => {
    const pts = makeTrack(ANCHORS[seed.anchor], seed.points, rnd);
    const km = trackLengthKm(pts);
    const start =
      now - seed.daysAgo * MS_PER_DAY - (now % MS_PER_DAY) + seed.startMin * MS_PER_MIN;
    const avgMps = seed.avgKmh * KMH_TO_MPS;
    const movingMs = avgMps > 0 ? Math.round((km * 1000) / avgMps) * 1000 : 0;
    const raw: RawBeelineRide = {
      polyline: encodePolyline(pts),
      totalDistance: km * 1000,
      averageSpeed: avgMps,
      topSpeed: avgMps * 1.5,
      movingTime: movingMs,
      duration: Math.round(movingMs * 1.12),
      start,
      end: start + Math.round(movingMs * 1.12),
      totalElevationGain: Math.round(km * (6 + rnd() * 10)),
      totalElevationLoss: Math.round(km * (6 + rnd() * 10)),
    };
    // Attach a routed destination for some rides (others are free rides), so the
    // demo shows the gray location suffix on titles just like real data.
    if (seed.dest === "poi") {
      raw.destination = {
        address: { name: ANCHOR_POI[seed.anchor], locality: ANCHOR_CITY[seed.anchor] },
      };
    } else if (seed.dest === "city") {
      raw.destination = { address: { locality: ANCHOR_CITY[seed.anchor] } };
    }
    if (seed.state === "uploaded") {
      raw.strava_activity = {
        id: 10_000_000 + i,
        upload_id: 20_000_000 + i,
        stravaUploadStatus: { status: "availableOnStrava", timestamp: start + 3_600_000 },
      };
    } else if (seed.state === "processing") {
      raw.strava_activity = {
        stravaUploadStatus: { status: "startedUploading", timestamp: now },
      };
    }
    rides[`demo-${String(i).padStart(3, "0")}`] = raw;
  });
  return rides;
}

/**
 * Stateful in-memory Beeline backend for demo mode. Adds small latencies so the UI
 * shows the real cloud rhythm: a brief "downloading…" on scan, and uploads that
 * progress through startedUploading → availableOnStrava across a couple of polls.
 */
class DemoBeelineApi implements BeelineApi {
  private rides: Record<string, RawBeelineRide>;
  /** Remaining polls before a just-triggered upload reports done (per push-id). */
  private uploadCountdown = new Map<string, number>();

  constructor(now: number) {
    this.rides = buildDemoRides(now);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fetchRides(): Promise<Record<string, RawBeelineRide>> {
    await this.delay(600); // simulate the one-shot history download
    return structuredClone(this.rides);
  }

  async uploadRideToStrava(_s: BeelineSession, pushId: string): Promise<void> {
    await this.delay(250);
    this.rides[pushId] = {
      ...this.rides[pushId],
      strava_activity: {
        stravaUploadStatus: { status: "startedUploading", timestamp: Date.now() },
      },
    };
    // Complete after a couple of status polls so concurrency is observable.
    this.uploadCountdown.set(pushId, 2);
  }

  async fetchStravaActivity(
    _s: BeelineSession,
    pushId: string,
  ): Promise<RawBeelineRide["strava_activity"]> {
    await this.delay(150);
    const left = (this.uploadCountdown.get(pushId) ?? 0) - 1;
    this.uploadCountdown.set(pushId, left);
    if (left <= 0) {
      const act = {
        id: 11_000_000 + Number(pushId.replace(/\D/g, "")),
        upload_id: 21_000_000,
        stravaUploadStatus: { status: "availableOnStrava", timestamp: Date.now() },
      };
      this.rides[pushId] = { ...this.rides[pushId], strava_activity: act };
      return act;
    }
    return this.rides[pushId].strava_activity;
  }
}

/** Fake sign-in for demo mode — returns a throwaway session instantly. */
async function demoSignIn(email: string): Promise<BeelineSession> {
  return {
    idToken: "demo-token",
    uid: "demo-uid",
    email: email || DEMO_EMAIL,
    expiresAt: Date.now() + 3_600_000,
  };
}

/**
 * Dependencies that turn `BeelineRideSource` into a self-contained demo: a fake
 * sign-in, the stateful demo backend, and a short real sleep so upload polling is
 * visibly paced (not instant).
 */
export function demoBeelineDeps(): Required<
  Pick<BeelineSourceDeps, "api" | "signIn" | "sleep">
> {
  return {
    api: new DemoBeelineApi(Date.now()),
    signIn: demoSignIn,
    sleep: (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 400)),
  };
}

/** The email shown for the demo Beeline account. */
export const DEMO_BEELINE_EMAIL = DEMO_EMAIL;
