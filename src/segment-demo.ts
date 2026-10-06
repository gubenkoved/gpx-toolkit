/**
 * GPX Toolkit — the Wind vs speed segmentation explainer.
 *
 * A small synthetic ride (straights, a gentle bend, a jittery slow stretch, a stop,
 * a hairpin) chopped by the REAL `segmentRide()` with the user's current look-ahead
 * and turn tolerance, drawn as an inline SVG: every kept segment gets its own colour
 * and end dots, stretches that fell out (too short, stopped, turning) stay as the
 * faint underlying track. It re-renders live as the sliders move, so the knobs
 * explain themselves — no prose about "heading deviation" needed. Pure: no DOM.
 */

import type { LatLon } from "./track";
import { type SegmentOpts, segmentRide } from "./windspeed";

const LAT0 = 52;
const LON0 = 4;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

interface DemoTrack {
  points: LatLon[];
  times: number[];
}

/** Deterministic pseudo-random (so the jitter stretch is the same every render). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

let cached: DemoTrack | null = null;

/** The synthetic ride, built once: ~2.6 km of varied riding at realistic paces. */
export function demoTrack(): DemoTrack {
  if (cached) return cached;
  const rnd = lcg(7);
  const points: LatLon[] = [];
  const times: number[] = [];
  let x = 0; // metres east
  let y = 0; // metres north
  let t = Date.UTC(2026, 5, 1, 9, 0, 0);
  let heading = 90; // degrees from north, clockwise
  const push = (): void => {
    points.push([LAT0 + y / M_PER_DEG_LAT, LON0 + x / M_PER_DEG_LON]);
    times.push(t);
  };
  /** Advance `metres` along `heading`, `step` m per point, at `kmh`, with optional
   *  lateral jitter (GPS noise) of ±`jitter` m and a steady heading drift per step. */
  const go = (metres: number, kmh: number, step: number, jitter = 0, driftDeg = 0): void => {
    const n = Math.max(1, Math.round(metres / step));
    for (let i = 0; i < n; i++) {
      heading += driftDeg;
      const rad = (heading * Math.PI) / 180;
      x += Math.sin(rad) * step;
      y += Math.cos(rad) * step;
      if (jitter) {
        x += (rnd() - 0.5) * 2 * jitter * Math.cos(rad);
        y -= (rnd() - 0.5) * 2 * jitter * Math.sin(rad);
      }
      t += (step / (kmh / 3.6)) * 1000;
      push();
    }
  };
  push();
  // A loop that reads as a ride: a long straight, a fast bend, a jittery slow path
  // through a park, a stop at the lights, a hairpin, then home.
  go(760, 27, 10); // long straight east (top edge)
  go(140, 17, 10, 0, 6.4); // 90° bend to the south
  go(360, 24, 10); // straight south (right edge)
  go(140, 16, 10, 0, 6.4); // 90° bend to the west
  go(260, 7, 2, 2.5); // slow, dense, jittery stretch (gravel path)
  for (let i = 0; i < 5; i++) {
    t += 12_000; // a 60 s stop at the lights
    push();
  }
  go(380, 25, 10); // straight west again
  go(110, 11, 6, 0, 10); // hairpin: 180° back to the east
  go(330, 26, 10); // straight east
  go(140, 17, 10, 0, -6.4); // 90° bend to the north
  go(330, 24, 10); // up the left edge, back toward the start
  cached = { points, times };
  return cached;
}

/** Segment colours, cycled so neighbours never share one. */
const SEG_COLORS = ["var(--accent)", "var(--blue)", "var(--green)", "var(--amber)"];

/** Chop the demo ride with `opts` and return the explainer SVG + a caption. */
export function segmentDemo(opts: SegmentOpts): { svg: string; caption: string } {
  const { points, times } = demoTrack();
  const n = points.length;
  const eles = new Array<number | null>(n).fill(null);
  const along = new Array<number | null>(n).fill(5);
  const cross = new Array<number | null>(n).fill(0);
  const segs = segmentRide(points, times, eles, along, cross, opts, "demo");

  // Equirectangular projection into the viewBox, padded, aspect preserved.
  const W = 360;
  const H = 150;
  const PAD = 10;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const xy = points.map(([lat, lon]) => {
    const px = (lon - LON0) * M_PER_DEG_LON;
    const py = (lat - LAT0) * M_PER_DEG_LAT;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    return [px, py];
  });
  const scale = Math.min(
    (W - 2 * PAD) / (maxX - minX || 1),
    (H - 2 * PAD) / (maxY - minY || 1),
  );
  const ox = PAD + (W - 2 * PAD - (maxX - minX) * scale) / 2;
  const oy = PAD + (H - 2 * PAD - (maxY - minY) * scale) / 2;
  const sx = (px: number): string => (ox + (px - minX) * scale).toFixed(1);
  const sy = (py: number): string => (H - oy - (py - minY) * scale).toFixed(1);
  const poly = (from: number, to: number): string =>
    xy
      .slice(from, to + 1)
      .map(([px, py]) => `${sx(px)},${sy(py)}`)
      .join(" ");

  let body = `<polyline class="sd-track" points="${poly(0, n - 1)}"/>`;
  segs.forEach((s, i) => {
    const color = SEG_COLORS[i % SEG_COLORS.length];
    body += `<polyline class="sd-seg" stroke="${color}" points="${poly(s.startIdx, s.endIdx)}"/>`;
    const [ax, ay] = xy[s.startIdx];
    const [bx, by] = xy[s.endIdx];
    body += `<circle class="sd-end" cx="${sx(ax)}" cy="${sy(ay)}" r="3"/>`;
    body += `<circle class="sd-end" cx="${sx(bx)}" cy="${sy(by)}" r="3"/>`;
  });
  const kept = segs.reduce((acc, s) => acc + s.distanceKm, 0);
  const total = (() => {
    let km = 0;
    for (let i = 1; i < n; i++) {
      const [ax, ay] = xy[i - 1];
      const [bx, by] = xy[i];
      km += Math.hypot(bx - ax, by - ay) / 1000;
    }
    return km;
  })();
  const pct = total > 0 ? Math.round((kept / total) * 100) : 0;
  const caption =
    `${segs.length} segment${segs.length === 1 ? "" : "s"} from this sample ride · ` +
    `${pct}% of its distance kept — the rest fell out as turns, a stop, or stretches ` +
    `too short to count.`;
  const svg =
    `<svg viewBox="0 0 ${W} ${H}" class="sd-svg" role="img" ` +
    `aria-label="How the current settings chop a sample ride into segments">${body}</svg>`;
  return { svg, caption };
}
