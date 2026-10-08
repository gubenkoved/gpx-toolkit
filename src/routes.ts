/**
 * GPX Toolkit — the route Library: planned and imported routes.
 *
 * A route is a ride you haven't ridden: a shape with no dates, timestamps or
 * telemetry. Two kinds share one model:
 *  - **planned**: waypoints (start, any vias, finish) joined by legs, each leg routed
 *    with the route's profile (routing.ts) — the planner edits these;
 *  - **imported**: a GPX file's track, kept as one fixed leg between its first and
 *    last point (its geometry isn't re-routable).
 *
 * The Library lives in its own versioned blob (`gpx-toolkit-routes:all`) on the app's
 * key/value store, separate from the ride state, so routes never mix into ride
 * filters, stats or the ride backup; Export All carries it as `routes.json`. Leg
 * geometry is stored as an encoded polyline plus rounded elevations, so a long route
 * stays a few kilobytes.
 */

import type { KeyValueStore } from "./kv";
import { isRouteProfile, type RoutedLeg, type RouteProfile } from "./routing";
import {
  cumulativeKm,
  decodePolyline,
  encodePolyline,
  extractFullTrack,
  type LatLon,
} from "./track";

// --------------------------------------------------------------------------- //
// Model
// --------------------------------------------------------------------------- //

export interface PlannedRoute {
  /** Stable id (`route-<time36><rand>`), never shown. */
  id: string;
  name: string;
  /** Epoch ms. */
  created: number;
  updated: number;
  /** How new and moved legs are routed. */
  profile: RouteProfile;
  /** Start, vias, finish. A saved route has at least two. */
  waypoints: LatLon[];
  /** `legs[i]` joins `waypoints[i]` → `waypoints[i + 1]`. */
  legs: RoutedLeg[];
  /** True for a route imported from a GPX file: one fixed leg, not re-routable. */
  imported?: boolean;
}

/** The whole route as one line: legs joined, the shared junction points deduped. */
export interface RouteTrack {
  points: LatLon[];
  eles: (number | null)[];
  /** Cumulative km at each point. */
  cum: number[];
}

/** A fresh, empty route (no waypoints yet). */
export function newRoute(profile: RouteProfile, now = Date.now()): PlannedRoute {
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return {
    id: `route-${now.toString(36)}${rand}`,
    name: "",
    created: now,
    updated: now,
    profile,
    waypoints: [],
    legs: [],
  };
}

/** Join a route's legs into one line. */
export function routeTrack(route: PlannedRoute): RouteTrack {
  const points: LatLon[] = [];
  const eles: (number | null)[] = [];
  route.legs.forEach((leg, i) => {
    const from = i === 0 ? 0 : 1; // each leg starts where the previous one ended
    for (let j = from; j < leg.points.length; j++) {
      points.push(leg.points[j]);
      eles.push(leg.eles[j] ?? null);
    }
  });
  return { points, eles, cum: points.length ? cumulativeKm(points) : [] };
}

/** Climb and descent (m) along an elevation series, ignoring sub-`noiseM` wiggles
 *  (a hysteresis band, so DEM jitter on the flat doesn't add up to fake climbing).
 *  Null when fewer than two points carry an elevation. */
export function climbM(
  eles: (number | null)[],
  noiseM = 3,
): { ascent: number; descent: number } | null {
  const known = eles.filter((e): e is number => e != null);
  if (known.length < 2) return null;
  let ascent = 0;
  let descent = 0;
  let ref = known[0];
  for (const e of known) {
    if (e - ref >= noiseM) {
      ascent += e - ref;
      ref = e;
    } else if (ref - e >= noiseM) {
      descent += ref - e;
      ref = e;
    }
  }
  return { ascent, descent };
}

/** Distance and climb for a route card or the planner header. */
export function routeStats(route: PlannedRoute): {
  distanceKm: number;
  ascentM: number | null;
  descentM: number | null;
} {
  const t = routeTrack(route);
  const climb = climbM(t.eles);
  return {
    distanceKm: t.cum.length ? t.cum[t.cum.length - 1] : 0,
    ascentM: climb ? climb.ascent : null,
    descentM: climb ? climb.descent : null,
  };
}

/** A route's display name: its own, else a dated "Route Oct 8" label. */
export function routeLabel(route: PlannedRoute): string {
  if (route.name.trim()) return route.name.trim();
  const d = new Date(route.created);
  return `Route ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// --------------------------------------------------------------------------- //
// GPX in / out
// --------------------------------------------------------------------------- //

const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A GPX 1.1 track of the route (with elevation where known), named after it. */
export function routeToGpx(route: PlannedRoute): string {
  const t = routeTrack(route);
  const pts = t.points
    .map(([lat, lon], i) => {
      const e = t.eles[i];
      return `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${
        e != null ? `<ele>${e.toFixed(1)}</ele>` : ""
      }</trkpt>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="GPX Toolkit" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `<metadata><name>${xmlEsc(routeLabel(route))}</name></metadata>\n` +
    `<trk><name>${xmlEsc(routeLabel(route))}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`
  );
}

/** Drop points closer than `minM` to the last kept one (keeps the last point), so a
 *  1 Hz recording becomes a lean route without bending its shape. */
export function thinTrack(
  points: LatLon[],
  eles: (number | null)[],
  minM: number,
): { points: LatLon[]; eles: (number | null)[] } {
  if (points.length <= 2) return { points: points.slice(), eles: eles.slice() };
  const cum = cumulativeKm(points);
  const outP: LatLon[] = [points[0]];
  const outE: (number | null)[] = [eles[0] ?? null];
  let lastKm = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if ((cum[i] - lastKm) * 1000 < minM) continue;
    outP.push(points[i]);
    outE.push(eles[i] ?? null);
    lastKm = cum[i];
  }
  outP.push(points[points.length - 1]);
  outE.push(eles[points.length - 1] ?? null);
  return { points: outP, eles: outE };
}

/**
 * An imported route from a GPX file's track (or route points): one fixed leg, thinned
 * to ~15 m spacing, elevation kept. Timestamps are dropped on purpose: a library
 * route is a shape, not a ride. Null when the file has fewer than two points.
 */
export function routeFromGpx(
  xml: string,
  name: string,
  now = Date.now(),
): PlannedRoute | null {
  const ft = extractFullTrack(xml);
  if (ft.points.length < 2) return null;
  const thin = thinTrack(ft.points, ft.eles, 15);
  const route = newRoute("straight", now);
  route.name = name;
  route.imported = true;
  route.waypoints = [thin.points[0], thin.points[thin.points.length - 1]];
  route.legs = [{ points: thin.points, eles: thin.eles, snapped: true }];
  return route;
}

// --------------------------------------------------------------------------- //
// Persistence
// --------------------------------------------------------------------------- //

const STORE_KEY = "gpx-toolkit-routes:all";
const SCHEMA = 1;

interface StoredLeg {
  /** Encoded polyline (precision 5). */
  p: string;
  /** Elevation per point, whole metres (null unknown). */
  e: (number | null)[];
  s: boolean;
}
interface StoredRoute {
  id: string;
  name: string;
  created: number;
  updated: number;
  profile: RouteProfile;
  waypoints: LatLon[];
  legs: StoredLeg[];
  imported?: boolean;
}
interface StoredLibrary {
  schema: number;
  routes: StoredRoute[];
}

function encodeRoute(r: PlannedRoute): StoredRoute {
  return {
    id: r.id,
    name: r.name,
    created: r.created,
    updated: r.updated,
    profile: r.profile,
    waypoints: r.waypoints.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)] as LatLon),
    legs: r.legs.map((l) => ({
      p: encodePolyline(l.points),
      e: l.eles.map((e) => (e == null ? null : Math.round(e))),
      s: l.snapped,
    })),
    ...(r.imported ? { imported: true } : {}),
  };
}

function decodeRoute(s: StoredRoute): PlannedRoute | null {
  if (!s || typeof s.id !== "string" || !Array.isArray(s.waypoints) || !Array.isArray(s.legs))
    return null;
  const legs: RoutedLeg[] = s.legs.map((l) => {
    const points = decodePolyline(String(l.p ?? ""));
    const e = Array.isArray(l.e) ? l.e : [];
    return {
      points,
      eles: points.map((_, i) => (typeof e[i] === "number" ? e[i] : null)),
      snapped: !!l.s,
    };
  });
  return {
    id: s.id,
    name: typeof s.name === "string" ? s.name : "",
    created: Number(s.created) || 0,
    updated: Number(s.updated) || 0,
    profile: isRouteProfile(s.profile) ? s.profile : "trekking",
    waypoints: s.waypoints.filter(
      (w): w is LatLon => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]),
    ),
    legs,
    ...(s.imported ? { imported: true } : {}),
  };
}

/** Parse a stored/exported library blob; tolerant of junk (returns what decodes). */
export function parseLibrary(text: string): PlannedRoute[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const routes = (raw as StoredLibrary)?.routes;
  if (!Array.isArray(routes)) return [];
  return routes.map(decodeRoute).filter((r): r is PlannedRoute => r != null);
}

/** The Library: every saved route, in memory, written through to the key/value store. */
export class RouteStore {
  private routes = new Map<string, PlannedRoute>();
  private loaded = false;

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const text = await this.kv.get(STORE_KEY).catch(() => null);
    this.routes = new Map(text ? parseLibrary(text).map((r) => [r.id, r]) : []);
    this.loaded = true;
  }

  /** Newest-edited first. */
  all(): PlannedRoute[] {
    return [...this.routes.values()].sort((a, b) => b.updated - a.updated);
  }

  get(id: string): PlannedRoute | null {
    return this.routes.get(id) ?? null;
  }

  get count(): number {
    return this.routes.size;
  }

  async put(route: PlannedRoute): Promise<void> {
    this.routes.set(route.id, route);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    if (this.routes.delete(id)) await this.save();
  }

  async clear(): Promise<void> {
    this.routes.clear();
    await this.kv.del(STORE_KEY);
  }

  /** The whole library as JSON (the stored format), for Export All. */
  exportJson(): string {
    const lib: StoredLibrary = { schema: SCHEMA, routes: this.all().map(encodeRoute) };
    return JSON.stringify(lib);
  }

  /** Merge an exported library: new ids are added, a known id keeps the newer edit.
   *  Returns how many routes were added or updated. */
  async importJson(text: string): Promise<number> {
    let n = 0;
    for (const r of parseLibrary(text)) {
      const have = this.routes.get(r.id);
      if (have && have.updated >= r.updated) continue;
      this.routes.set(r.id, r);
      n++;
    }
    if (n) await this.save();
    return n;
  }

  private save(): Promise<void> {
    return this.kv.set(STORE_KEY, this.exportJson());
  }
}
