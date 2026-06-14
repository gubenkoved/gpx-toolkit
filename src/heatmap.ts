/**
 * Frequency-heatmap geometry — pure, DOM-free helpers for the "Stats" view map.
 *
 * The all-rides Map view draws each route as a translucent line, so frequency
 * only reads as faint stacking. To show *how often* a stretch is ridden far more
 * clearly, we resample every track to evenly-spaced points and feed those to a
 * heat layer: a corridor ridden daily accumulates many more points per metre than
 * a one-off, so it glows while rare routes stay dim — independent of how densely
 * the original polyline happened to be sampled.
 *
 * Like the rest of the map code this is shape-only (no timestamps/elevation); it
 * just turns line geometry into weighted points the renderer can sum.
 */

import type { RideTrack } from "./mapview";
import type { LatLon } from "./track";

/** A weighted heat sample: [lat, lon, intensity]. */
export type HeatPoint = [number, number, number];

/** Great-circle distance between two lat/lon points, in metres (haversine). */
function haversineM(a: LatLon, b: LatLon): number {
  const R = 6_371_000; // mean Earth radius (m)
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Web-Mercator ground resolution: metres covered by one screen pixel at a given
 * zoom and latitude. The classic OSM/Google formula — 156543.03392 m/px is the
 * equatorial resolution at zoom 0 (a 256-px world tile); it shrinks by 2^zoom and
 * by cos(lat) toward the poles.
 */
export function metresPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** Bounds for adaptive heat-point spacing (metres). */
const SPACING_FLOOR_M = 1; // safe to oversample finely: rendering is culled to the viewport
const SPACING_CEIL_M = 30; // matches the original fixed spacing when zoomed far out

/** Baseline spacing (m) the glow was tuned at; weight scales by spacing/this so a
 *  finer (zoomed-in) resample deposits the same energy per metre as the 30 m default. */
export const BASE_SPACING_M = 30;

/**
 * Pick a geographic point spacing (metres) so that, at the current zoom/latitude,
 * consecutive heat points land roughly `targetPx` pixels apart on screen. Keeping
 * the on-screen gap well under the glow radius is what stops the heat layer from
 * breaking into visible beads when you zoom in: the spacing tracks the map instead
 * of staying a fixed 30 m. Clamped to [SPACING_FLOOR_M, SPACING_CEIL_M].
 */
export function spacingForZoom(zoom: number, lat: number, targetPx: number): number {
  const metres = metresPerPixel(zoom, lat) * targetPx;
  return Math.max(SPACING_FLOOR_M, Math.min(SPACING_CEIL_M, metres));
}

/**
 * Resample a polyline to points roughly `spacingM` metres apart, so density is
 * proportional to distance rather than to the original vertex count. The first
 * and last vertices are always kept; long segments get evenly interpolated
 * in-between points. Tracks with fewer than two points are returned unchanged.
 */
export function densifyTrack(points: LatLon[], spacingM: number): LatLon[] {
  if (points.length < 2 || spacingM <= 0) return points.slice();
  const out: LatLon[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = haversineM(a, b);
    const steps = Math.max(1, Math.floor(dist / spacingM));
    // Emit interior points (j = 1..steps-1) then the segment end at j = steps.
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** A lat/lon viewport rectangle used to cull heat points to what's on screen. */
export interface HeatBounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** True when point `p` falls inside the bounds rectangle (inclusive). */
function pointInBounds(p: LatLon, b: HeatBounds): boolean {
  return p[0] >= b.minLat && p[0] <= b.maxLat && p[1] >= b.minLon && p[1] <= b.maxLon;
}

/**
 * True when segment `a`–`b` could be visible in `bounds` — a cheap bounding-box
 * overlap test (catches segments that merely cross the view, not just those with
 * an endpoint inside it). Used to skip densifying off-screen track segments.
 */
function segIntersectsBounds(a: LatLon, b: LatLon, bounds: HeatBounds): boolean {
  const segMinLat = Math.min(a[0], b[0]);
  const segMaxLat = Math.max(a[0], b[0]);
  const segMinLon = Math.min(a[1], b[1]);
  const segMaxLon = Math.max(a[1], b[1]);
  return !(
    segMaxLat < bounds.minLat ||
    segMinLat > bounds.maxLat ||
    segMaxLon < bounds.minLon ||
    segMinLon > bounds.maxLon
  );
}

/**
 * Flatten every ride track into evenly-spaced, weighted heat points. Each emitted
 * sample carries the same `weight`, so the renderer's per-area sum reflects how
 * many passes (and thus how frequently) a stretch was ridden.
 *
 * When `bounds` is given, only segments that could appear in that viewport are
 * densified. This is what lets the caller pick a very fine `spacingM` at high zoom
 * (so the glow stays continuous instead of beading) without exploding the point
 * count across every off-screen kilometre of track.
 */
export function buildHeatPoints(
  tracks: ReadonlyArray<RideTrack>,
  spacingM = BASE_SPACING_M,
  weight = 1,
  bounds?: HeatBounds,
): HeatPoint[] {
  const out: HeatPoint[] = [];
  const step = spacingM > 0 ? spacingM : BASE_SPACING_M;
  for (const t of tracks) {
    const pts = t.points;
    if (pts.length < 2) {
      if (pts.length === 1 && (!bounds || pointInBounds(pts[0], bounds))) {
        out.push([pts[0][0], pts[0][1], weight]);
      }
      continue;
    }
    let segStarted = false; // have we emitted the start vertex of the current run?
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (bounds && !segIntersectsBounds(a, b, bounds)) {
        segStarted = false; // a gap in visibility — next kept segment re-emits its start
        continue;
      }
      if (!segStarted) {
        out.push([a[0], a[1], weight]);
        segStarted = true;
      }
      const steps = Math.max(1, Math.floor(haversineM(a, b) / step));
      for (let j = 1; j <= steps; j++) {
        const tt = j / steps;
        out.push([a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt, weight]);
      }
    }
  }
  return out;
}
