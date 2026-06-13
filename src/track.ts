/**
 * Rough, lightweight ride tracks.
 *
 * We never keep the full GPX — only a heavily reduced sketch of the route so the
 * app can show an approximate shape on a map. A pulled GPX is parsed to lat/lon
 * points, simplified (Douglas–Peucker) down to a small cap, then stored as a
 * Google-style encoded polyline string (a few hundred bytes at most).
 *
 * This is intentionally a SHAPE ONLY: no elevation, no timestamps, and the point
 * count is deliberately tiny. The displayed track is an approximation.
 */

export type LatLon = [number, number]; // [lat, lon]

/** Parse `<trkpt>`/`<rtept>` lat/lon pairs out of a GPX document. */
export function extractTrack(gpx: string): LatLon[] {
  const doc = new DOMParser().parseFromString(gpx, "text/xml");
  let pts = Array.from(doc.getElementsByTagName("trkpt"));
  if (pts.length === 0) pts = Array.from(doc.getElementsByTagName("rtept"));
  const out: LatLon[] = [];
  for (const p of pts) {
    const lat = Number(p.getAttribute("lat"));
    const lon = Number(p.getAttribute("lon"));
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
  }
  return out;
}

/** Perpendicular distance from point `p` to the segment `a`–`b` (planar approx). */
function segDistance(p: LatLon, a: LatLon, b: LatLon): number {
  const [py, px] = p;
  const [ay, ax] = a;
  const [by, bx] = b;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const tc = Math.max(0, Math.min(1, t));
  const cx = ax + tc * dx;
  const cy = ay + tc * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Douglas–Peucker simplification with an epsilon (in degrees). */
function douglasPeucker(points: LatLon[], epsilon: number): LatLon[] {
  if (points.length < 3) return points.slice();
  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = segDistance(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon) return [points[0], points[end]];
  const left = douglasPeucker(points.slice(0, index + 1), epsilon);
  const right = douglasPeucker(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

/**
 * Reduce a track to at most `maxPoints` by ramping Douglas–Peucker epsilon until
 * the cap is met. `maxPoints` is clamped to a sane minimum.
 */
export function simplify(points: LatLon[], maxPoints: number): LatLon[] {
  const cap = Math.max(2, Math.floor(maxPoints));
  if (points.length <= cap) return points.slice();
  let epsilon = 1e-5; // ~1m
  let result = points;
  for (let i = 0; i < 40 && result.length > cap; i++) {
    result = douglasPeucker(points, epsilon);
    epsilon *= 1.6;
  }
  if (result.length > cap) {
    // Fallback: evenly sample down to the cap.
    const step = (result.length - 1) / (cap - 1);
    const sampled: LatLon[] = [];
    for (let i = 0; i < cap; i++) sampled.push(result[Math.round(i * step)]);
    result = sampled;
  }
  return result;
}

// --- Google encoded polyline (precision 5) ----------------------------------

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/** Encode lat/lon points as a Google polyline string. */
export function encodePolyline(points: LatLon[], precision = 5): string {
  const factor = Math.pow(10, precision);
  let lastLat = 0;
  let lastLon = 0;
  let out = "";
  for (const [lat, lon] of points) {
    const latE = Math.round(lat * factor);
    const lonE = Math.round(lon * factor);
    out += encodeSigned(latE - lastLat);
    out += encodeSigned(lonE - lastLon);
    lastLat = latE;
    lastLon = lonE;
  }
  return out;
}

/** Decode a Google polyline string back into lat/lon points. */
export function decodePolyline(encoded: string, precision = 5): LatLon[] {
  const factor = Math.pow(10, precision);
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

/**
 * Full pipeline: GPX bytes → rough encoded polyline. Returns "" when the GPX has
 * no usable track (so callers can simply skip storing a track).
 */
export function gpxToRoughPolyline(bytes: Uint8Array, maxPoints: number): string {
  const text = new TextDecoder().decode(bytes);
  const pts = extractTrack(text);
  if (pts.length < 2) return "";
  return encodePolyline(simplify(pts, maxPoints));
}
