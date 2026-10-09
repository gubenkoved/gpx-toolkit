/**
 * GPX Toolkit — bike routing for the route planner.
 *
 * Snaps one planner leg (waypoint → waypoint) onto the path network with the public
 * BRouter server (brouter.de, OpenStreetMap data, CORS-enabled, no key). BRouter is
 * built for bikes: its profiles weigh cycleways, surfaces and traffic, which is what
 * "follow the bike paths" needs. The planner routes leg by leg, so moving one
 * waypoint re-routes only its two neighbouring legs.
 *
 * "Straight" is the no-network profile: the leg is the straight line between its
 * waypoints (for a ferry, a track the map lacks, or when the server is down).
 * Everything here is pure except `routeLeg`, which takes an injected `fetch`.
 */

import type { LatLon } from "./track";

/** How a leg follows the ground: a BRouter profile, or a straight line. */
export type RouteProfile = "trekking" | "safety" | "fastbike" | "straight";

/** The profiles in picker order, with their user-facing names. */
export const ROUTE_PROFILES: readonly { id: RouteProfile; label: string; title: string }[] = [
  {
    id: "trekking",
    label: "Bike paths",
    title: "Prefer cycleways and quiet roads (BRouter trekking profile)",
  },
  {
    id: "safety",
    label: "Quiet",
    title: "Avoid traffic wherever possible, even at a detour (BRouter safety profile)",
  },
  {
    id: "fastbike",
    label: "Fast",
    title: "Smooth, direct roads for a road bike (BRouter fastbike profile)",
  },
  {
    id: "straight",
    label: "Straight",
    title: "Straight lines between the points, no routing",
  },
];

export function isRouteProfile(v: unknown): v is RouteProfile {
  return ROUTE_PROFILES.some((p) => p.id === v);
}

/** One routed leg: its geometry, per-point elevation, and whether it follows paths. */
export interface RoutedLeg {
  points: LatLon[];
  /** Metres per point; null where the router gave none (always for straight legs). */
  eles: (number | null)[];
  /** False for a straight line (the profile, or a fallback after a routing error). */
  snapped: boolean;
  /** A straight stand-in drawn while the leg's routing request runs (never saved). */
  pending?: boolean;
}

/** Raised when the router can't produce a leg (unreachable point, server down…). */
export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

const BROUTER = "https://brouter.de/brouter";

/** The straight leg between two points (no network). */
export function straightLeg(from: LatLon, to: LatLon): RoutedLeg {
  return { points: [from, to], eles: [null, null], snapped: false };
}

/** BRouter request URL for one leg. `lonlats` is lon,lat order, `|`-separated. */
export function brouterUrl(from: LatLon, to: LatLon, profile: RouteProfile): string {
  const ll = (p: LatLon): string => `${p[1].toFixed(6)},${p[0].toFixed(6)}`;
  return `${BROUTER}?lonlats=${ll(from)}|${ll(to)}&profile=${profile}&alternativeidx=0&format=geojson`;
}

/** Parse BRouter's GeoJSON answer into a leg; throws when it carries no line. */
export function parseBrouterGeojson(json: unknown): RoutedLeg {
  const feature = (json as { features?: { geometry?: { coordinates?: unknown } }[] })
    ?.features?.[0];
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new RoutingError("The router returned no route");
  }
  const points: LatLon[] = [];
  const eles: (number | null)[] = [];
  for (const c of coords as unknown[]) {
    if (!Array.isArray(c)) continue;
    const [lon, lat, ele] = c as number[];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push([lat, lon]);
    eles.push(Number.isFinite(ele) ? ele : null);
  }
  if (points.length < 2) throw new RoutingError("The router returned no route");
  return { points, eles, snapped: true };
}

/**
 * Route one leg. A straight profile never touches the network. BRouter answers
 * errors as plain text ("from-position not mapped in existing datafile"), which is
 * surfaced as the RoutingError message so the planner can say why it fell back.
 */
export async function routeLeg(
  from: LatLon,
  to: LatLon,
  profile: RouteProfile,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<RoutedLeg> {
  if (profile === "straight") return straightLeg(from, to);
  let resp: Response;
  try {
    resp = await fetchFn(brouterUrl(from, to, profile), { signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new RoutingError("The routing server can't be reached");
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).trim().split("\n")[0];
    throw new RoutingError(text || `The routing server answered ${resp.status}`);
  }
  return parseBrouterGeojson(await resp.json());
}
