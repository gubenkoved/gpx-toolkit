/**
 * Full-screen single-ride route map (opened from a ride's mini-map).
 *
 * Extracted verbatim from `main.ts` to keep that entry file focused on app shell,
 * rendering and wiring. This module owns one cohesive subsystem: the big interactive
 * Leaflet map for a single ride — route colouring (plain / by elevation / by speed /
 * by head-tailwind), the elevation/speed profile with distance-or-time x-axis, the
 * hover readout + wind dial, and the on-demand "fetch full recorded track" flow.
 *
 * It depends on the rest of the app only through an injected `RideMapDeps` seam
 * (`initRideMap`), so it never imports the entry module: the orchestration bits it
 * needs — the live `Controller`, the current `AppState`, the toast channel, HTML
 * escaping, the Beeline/relay re-auth gates and the OSM attribution string — are
 * passed in. `main.ts` wires those once at startup and calls the exported handlers
 * (`openRideMap`, `closeRideMap`, …) from its central event dispatch.
 */

import L from "leaflet";

import type { AppState, Controller } from "./controller";
import { rideDatetime, rideShortLabel } from "./parsing";
import {
  cumulativeKm,
  decodePolyline,
  type FullTrack,
  filledTimes,
  fullTrackSummary,
  hasElevation,
  hasTimes,
  smoothedSpeedsKmh,
  stableStoppedRanges,
} from "./track";
import { cellBounds, type PointWind } from "./weather";

// --------------------------------------------------------------------------- //
// Dependency seam — injected by main.ts at startup (see initRideMap).
// --------------------------------------------------------------------------- //
export interface RideMapDeps {
  /** The live controller (read fresh each call — it's reassigned on source switch). */
  getController: () => Controller;
  /** The current app state (read fresh each call — reassigned on every render). */
  getState: () => AppState;
  /** Transient bottom toast; `err` lengthens + styles it as an error. */
  toast: (msg: string, err?: boolean) => void;
  /** HTML-escape a string for safe interpolation into innerHTML. */
  esc: (s: string) => string;
  /** Run an action behind a live Beeline connection (may pop the re-auth picker). */
  withBeelineAccess: (action: () => void) => void;
  /** Run an action behind the GPX-relay consent gate (when an export gateway is set). */
  withGpxRelayConsent: (action: () => void) => void;
  /** The OSM tile attribution credit string. */
  osmAttribution: string;
}

let deps: RideMapDeps;

/** Wire the ride map into the app: store its dependencies and bind the persistent
 *  profile strip's pointer events (the host lives in the DOM across opens). */
export function initRideMap(d: RideMapDeps): void {
  deps = d;
  // Elevation profile ↔ route map sync: hovering the full-screen ride map's profile
  // strip lights up the matching point on the route above it (and the readout). The
  // host persists in the DOM across opens, so wire it once; the SVG inside is
  // re-rendered per ride but pointer events still bubble to the host.
  const profile = document.getElementById("rideMapProfile");
  if (profile) {
    profile.addEventListener("pointermove", onRideProfileHover);
    // A tap (pointerdown without a move) must also place the dot, and on touch the
    // first event of a drag is pointerdown — bind it so scrubbing starts immediately.
    profile.addEventListener("pointerdown", onRideProfileHover);
    profile.addEventListener("pointerleave", clearRideTrackPoint);
  }
}

// Thin accessors/wrappers so the (verbatim) ride-map code below reads unchanged.
const getController = (): Controller => deps.getController();
const getState = (): AppState => deps.getState();
const toast = (msg: string, err = false): void => deps.toast(msg, err);
const esc = (s: string): string => deps.esc(s);
const withBeelineAccess = (action: () => void): void => deps.withBeelineAccess(action);
const withGpxRelayConsent = (action: () => void): void => deps.withGpxRelayConsent(action);

/** 8-point compass label for a FROM-direction (degrees). */
function compass8(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Colour each track segment by its along-track wind: green tailwind → red headwind. */
function drawWindColoredTrack(
  group: L.LayerGroup,
  points: [number, number][],
  winds: (PointWind | null)[],
): void {
  for (let i = 0; i < points.length - 1; i++) {
    const w = winds[i];
    if (!w) continue;
    L.polyline([points[i], points[i + 1]], {
      color: windColor(w.alongKmh),
      weight: 4,
      opacity: 0.95,
      interactive: false,
    }).addTo(group);
  }
}

/** Place a handful of downwind arrows along the route (decimated to avoid clutter). */
function drawWindArrows(
  group: L.LayerGroup,
  points: [number, number][],
  winds: (PointWind | null)[],
  count = 9,
): void {
  const step = Math.max(1, Math.floor(points.length / count));
  for (let i = 0; i < points.length; i += step) {
    const w = winds[i];
    if (!w) continue;
    // Arrow points the way the wind blows (downwind = from-direction + 180°).
    const toDeg = (w.fromDeg + 180) % 360;
    L.marker(points[i], {
      icon: windArrowIcon(toDeg),
      interactive: false,
      keyboard: false,
    }).addTo(group);
  }
}

/** A wind-direction marker, rotated to a compass bearing, as a Leaflet divIcon.
 *  ITERATION: finalist #4 — double chevron (» airflow), larger with a dark casing.
 *  Drawn twice: a thick dark underlay (the outline) + the white chevrons on top. */
function windArrowIcon(bearingDeg: number): L.DivIcon {
  const rot = `transform:rotate(${bearingDeg.toFixed(0)}deg)`;
  const chevrons = `<path d="M7 12.5 L12 7 L17 12.5"/><path d="M7 17 L12 11.5 L17 17"/>`;
  const html =
    `<span class="wind-arrow wa-pick" style="${rot}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<g class="wa-casing" fill="none" stroke-linecap="round" stroke-linejoin="round">${chevrons}</g>` +
    `<g class="wa-stroke" fill="none" stroke-linecap="round" stroke-linejoin="round">${chevrons}</g>` +
    `</svg></span>`;
  return L.divIcon({
    html,
    className: "wind-arrow-icon",
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}

/** Diverging colour for an along-track component: +tailwind green, −headwind red. */
function windColor(alongKmh: number): string {
  const t = Math.max(-1, Math.min(1, alongKmh / 15)); // saturate at ±15 km/h
  if (t >= 0) return hexLerp("#cdbf3e", "#37c06a", t); // neutral → green
  return hexLerp("#cdbf3e", "#e23b3b", -t); // neutral → red
}

/** Linear interpolate two #rrggbb colours. */
function hexLerp(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// --------------------------------------------------------------------------- //
// Full-screen single-ride route map (opened from a ride's mini-map). Shows the
// one track big and interactive; hovering the track reports how far into the ride
// that point is. By default Beeline gives us only the route geometry (lat/lon),
// so the time is an EVEN-PACE ESTIMATE (cumulative-distance fraction × elapsed
// time) — rendered with a "~" and an "estimated" note. The user can fetch the
// FULL recorded track on demand (real per-point time + elevation); once loaded
// the hover readout, route colouring and elevation profile use those real values
// and the "~" estimate disclaimer is dropped.
// --------------------------------------------------------------------------- //
let rideMapBig: L.Map | null = null;
/** Layer group holding the route line(s) — one orange line, or recoloured segments. */
let rideMapLineLayer: L.LayerGroup | null = null;
/** Observes the open ride-map bar's width to re-evaluate the icon-collapse on resize. */
let rideMapBarObserver: ResizeObserver | null = null;
let rideMapMarker: L.CircleMarker | null = null;
/** The ride key currently open in the full-screen map (null when closed). */
let rideMapKey: string | null = null;
/** How the route line is coloured: plain, by elevation, by speed, or by head/tailwind. */
let rideMapColorMode: "none" | "height" | "speed" | "wind" = "none";
/** Whether the elevation profile panel is shown (when a full track is loaded). */
let rideMapProfileShown = true;
/** Which metric the profile graphs: elevation vs distance, or speed vs distance.
 *  Falls back to whichever is available when the chosen one has no data. */
let rideMapProfileMetric: "elevation" | "speed" = "elevation";
/** The profile's x-axis: along-track distance, or recorded time (only when the full
 *  track carries timestamps). Time stretches idle stretches out so stops read true. */
let rideMapProfileAxis: "distance" | "time" = "distance";
/** Cached hover state for the open ride map, recomputed on pan/zoom/resize. */
let rideHover: {
  pts: [number, number][];
  cum: number[]; // cumulative km at each point
  totalKm: number;
  elapsedSec: number;
  startMs: number | null;
  px: L.Point[]; // track points projected to container pixels (cache)
  /** The full recorded track, when fetched — enables real time + elevation. */
  full: FullTrack | null;
  /** Smoothed per-point speed (km/h) when a full track with timestamps is loaded. */
  speeds: (number | null)[] | null;
  /** viewBox x (0..1000) per point under the current axis mode; set by the profile
   *  render and reused for cursor↔distance mapping. Null until the profile draws. */
  axisX: number[] | null;
} | null = null;

/** Seconds → "H:MM:SS" / "M:SS" for the hover readout. */
function fmtSecsShort(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

/**
 * Set a ride-map bar button's text label without clobbering its leading icon: writes
 * to the `.lbl` span (added for the icon-collapse) when present, else falls back to
 * the button's own text. Lets the icon survive every dynamic relabel (Fetch →
 * Fetching…, Resolve wind → Wind: on, Hide ↔ Show profile, …).
 */
function setRmbLabel(btn: HTMLElement | null, text: string): void {
  if (!btn) return;
  const lbl = btn.querySelector<HTMLElement>(".lbl");
  if (lbl) lbl.textContent = text;
  else btn.textContent = text;
}

/**
 * Write an inline status message into the ride-map bar (`#rideMapStatus`). This is
 * the in-context feedback channel for the full-screen map, where the bottom toast
 * is easy to miss — an error here stays put next to the "Fetch full track" button
 * until the next action. `kind` controls styling; "" clears it.
 */
function setRideMapStatus(msg: string, kind: "info" | "" = ""): void {
  const el = document.getElementById("rideMapStatus");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("busy", kind === "info");
}

/** Min/max of the finite entries in a (possibly null-holed) numeric series. */
function finiteRange(values: (number | null)[]): { lo: number; hi: number } | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : null;
}

/** Map a normalized value t∈[0,1] to a blue→green→red heat colour (low→high). */
function heatColor(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  return `hsl(${Math.round((1 - c) * 240)}, 82%, 55%)`;
}

/** Re-project the open track to container pixels (after a pan / zoom / resize). */
function reprojectRideHover(): void {
  if (!rideMapBig || !rideHover) return;
  rideHover.px = rideHover.pts.map((p) => rideMapBig!.latLngToContainerPoint(p));
}

/** Draw (or redraw) the route line for the open ride, honouring the colour mode.
 *  Plain orange unless a full track is loaded AND a height/speed mode is active,
 *  in which case the route is split into colour-graded segments. */
function drawRideLine(): void {
  if (!rideMapBig || !rideHover) return;
  if (rideMapLineLayer) {
    rideMapLineLayer.remove();
    rideMapLineLayer = null;
  }
  const layer = L.layerGroup().addTo(rideMapBig);
  rideMapLineLayer = layer;
  const pts = rideHover.pts;
  // White casing underneath for legibility over the basemap.
  L.polyline(pts, { color: "#ffffff", weight: 7, opacity: 0.9 }).addTo(layer);

  // Wind mode draws an entirely separate overlay (head/tailwind colouring + downwind
  // arrows + the grid-cell footprints the data covers), computed on the wind sample
  // geometry — see drawRideWindOverlay. Falls back to the plain route until resolved.
  if (rideMapColorMode === "wind") {
    const drawn = drawRideWindOverlay(layer);
    if (!drawn) L.polyline(pts, { color: "#fc5200", weight: 4 }).addTo(layer);
    drawEndpointMarkers(layer, pts);
    return;
  }

  const full = rideHover.full;
  const values =
    rideMapColorMode === "height"
      ? (full?.eles ?? null)
      : rideMapColorMode === "speed"
        ? rideHover.speeds
        : null;
  const range = values ? finiteRange(values) : null;
  if (rideMapColorMode === "none" || !full || !values || !range) {
    L.polyline(pts, { color: "#fc5200", weight: 4 }).addTo(layer);
    drawEndpointMarkers(layer, pts);
    return;
  }
  const span = range.hi - range.lo || 1;
  // Cap the number of drawn segments so a multi-thousand-point track stays snappy;
  // the colour gradient reads smoothly at a few hundred segments.
  const maxSeg = 500;
  const stride = Math.max(1, Math.floor((pts.length - 1) / maxSeg));
  for (let i = stride; i < pts.length; i += stride) {
    const seg = pts.slice(i - stride, i + 1);
    const v = values[Math.min(i, values.length - 1)];
    const t = v == null ? 0.5 : (v - range.lo) / span;
    L.polyline(seg, { color: heatColor(t), weight: 4, opacity: 0.95 }).addTo(layer);
  }
  drawEndpointMarkers(layer, pts);
}

/**
 * Draw the persistent start (green) and finish (red) markers for the open route —
 * green/red is the universal "begin here / ended here" convention (matching the
 * orange hover dot's circle style). Added last so they sit above the route line;
 * each carries a hover tooltip. On a loop ride the finish overlaps the start, which
 * is expected. The markers live on the route layer, so they're cleared and redrawn
 * together with the line on a colour-mode change.
 */
function drawEndpointMarkers(layer: L.LayerGroup, pts: [number, number][]): void {
  if (pts.length < 2) return;
  L.circleMarker(pts[0], {
    radius: 6,
    color: "#ffffff",
    weight: 2,
    fillColor: "#2ec27e",
    fillOpacity: 1,
  })
    .bindTooltip("Start", { direction: "top" })
    .addTo(layer);
  L.circleMarker(pts[pts.length - 1], {
    radius: 6,
    color: "#ffffff",
    weight: 2,
    fillColor: "#ff5a5a",
    fillOpacity: 1,
  })
    .bindTooltip("Finish", { direction: "top" })
    .addTo(layer);
}

/**
 * Draw the head/tailwind wind overlay on the big ride map: the grid-cell footprint
 * squares the data came from, the route recoloured green (tailwind) → red (headwind)
 * by along-track component, and downwind arrows. Uses the controller's resolved
 * overlay geometry (the wind sample points), so it's self-consistent. Returns false
 * when wind isn't resolved yet (caller draws the plain route instead).
 */
function drawRideWindOverlay(layer: L.LayerGroup): boolean {
  if (!rideMapKey) return false;
  const overlay = getController().getRideWindOverlay(rideMapKey);
  if (!overlay || overlay.points.length < 2 || !overlay.winds.some((w) => w)) return false;
  const summary = getController().getRideWind(rideMapKey);
  if (summary && !summary.noData) {
    for (const c of summary.cells) {
      L.rectangle(cellBounds(c.lat, c.lon, summary.gridKm), {
        className: "wind-cell",
        color: "#7fd4ff",
        weight: 1,
        opacity: 0.4,
        fillOpacity: 0.05,
        interactive: false,
      }).addTo(layer);
    }
  }
  drawWindColoredTrack(layer, overlay.points, overlay.winds);
  drawWindArrows(layer, overlay.points, overlay.winds, 12);
  return true;
}

/** Which profile metrics have real data for the open track (drives the toggle). */
function profileMetricsAvailable(): { elevation: boolean; speed: boolean } {
  const full = rideHover?.full ?? null;
  return {
    elevation: !!full && hasElevation(full),
    speed: !!(rideHover?.speeds && finiteRange(rideHover.speeds)),
  };
}

/** The metric the profile will actually draw: the chosen one when it has data,
 *  else whichever is available, else null (nothing to show). */
function effectiveProfileMetric(): "elevation" | "speed" | null {
  const a = profileMetricsAvailable();
  if (rideMapProfileMetric === "speed" && a.speed) return "speed";
  if (rideMapProfileMetric === "elevation" && a.elevation) return "elevation";
  if (a.elevation) return "elevation";
  if (a.speed) return "speed";
  return null;
}

/** Render the elevation/speed profile below the map from the full track, against a
 *  distance or time x-axis, with grey bands over the stretches detected as stopped. */
function renderRideProfile(): void {
  const host = document.getElementById("rideMapProfile");
  if (!host) return;
  const full = rideHover?.full ?? null;
  const metric = effectiveProfileMetric();
  if (!rideMapProfileShown || !full || !metric) {
    host.classList.add("hidden");
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = "";
    return;
  }
  host.classList.remove("hidden");
  host.setAttribute("aria-hidden", "false");

  const cum = rideHover!.cum;
  // Elevation vs speed differ only in the source array, axis unit and label; the
  // x-axis (distance or time) and the cursor sync are identical, so they share this body.
  const speed = metric === "speed";
  const values = speed ? (rideHover!.speeds ?? []) : full.eles;
  const unit = speed ? "km/h" : "m";
  const range = finiteRange(values);
  if (!range) {
    host.innerHTML = `<div class="rp-empty">No ${speed ? "speed" : "elevation"} data in this track.</div>`;
    return;
  }
  const W = 1000;
  const H = 120;
  const padX = 4;
  const padTop = 8;
  const padBot = 18;
  const innerW = W - 2 * padX;
  const totalKm = rideHover!.totalKm || 1;

  // The recorded times (gaps interpolated) drive the time axis AND the stop-band
  // tooltips; null when the track has no timestamps (then only distance is offered).
  const times = hasTimes(full) ? filledTimes(full.times) : null;
  const useTime = rideMapProfileAxis === "time" && times != null;

  // Per-point viewBox x under the active axis. Both cum and times are non-decreasing,
  // so axisX is monotonic — the cursor sync (below) inverts it back to distance.
  const axisX = new Array<number>(cum.length);
  if (useTime && times) {
    const t0 = times[0];
    const tSpan = times[times.length - 1] - t0 || 1;
    for (let i = 0; i < cum.length; i++) axisX[i] = padX + ((times[i] - t0) / tSpan) * innerW;
  } else {
    for (let i = 0; i < cum.length; i++) axisX[i] = padX + (cum[i] / totalKm) * innerW;
  }
  rideHover!.axisX = axisX;

  // Anchor a speed profile's fill at zero so the height reads as absolute speed;
  // elevation keeps its own min so modest hills aren't flattened against the floor.
  const lo = speed ? Math.min(0, range.lo) : range.lo;
  const vSpan = range.hi - lo || 1;
  const yOf = (v: number) => padTop + (1 - (v - lo) / vSpan) * (H - padTop - padBot);
  // Bands over the stretches we classified as not moving (same threshold as the
  // moving-avg figure). Drawn in the BACKGROUND (behind the area + line, so the orange
  // profile stays the foreground) as a faint cool fill topped by a crisp cool rule — a
  // stop reads as a quietly marked "paused" region that's legible even where the speed
  // line flatlines at zero. A stopped hop run [s, e] spans points s … e+1, so its x runs
  // axisX[s] → axisX[e+1]; a min width keeps a brief stop visible on the distance axis
  // (where idle time barely advances), while the time axis shows its true duration.
  const bandTop = padTop;
  const bandH = H - padTop - padBot;
  const minBandW = 4;
  let stops = "";
  const speeds = rideHover!.speeds;
  if (speeds && full) {
    for (const [s, e] of stableStoppedRanges(
      full,
      getState().settings.movingThresholdKmh,
      speeds,
    )) {
      let x1 = axisX[s];
      let x2 = axisX[Math.min(e + 1, axisX.length - 1)];
      if (x2 - x1 < minBandW) {
        const mid = (x1 + x2) / 2;
        x1 = Math.max(padX, mid - minBandW / 2);
        x2 = Math.min(W - padX, mid + minBandW / 2);
      }
      const tip = times
        ? `stopped ${fmtSecsShort((times[Math.min(e + 1, times.length - 1)] - times[s]) / 1000)}`
        : "stopped";
      const xs = x1.toFixed(1);
      const ws = Math.max(0, x2 - x1).toFixed(1);
      const topY = (bandTop + 0.5).toFixed(1);
      stops +=
        `<rect class="rp-stop" x="${xs}" y="${bandTop}" width="${ws}" height="${bandH}">` +
        `<title>${tip}</title></rect>` +
        `<line class="rp-stop-top" x1="${xs}" y1="${topY}" x2="${(x1 + Math.max(0, x2 - x1)).toFixed(1)}" y2="${topY}"/>`;
    }
  }

  // Build the area + line path over points that carry a value.
  let line = "";
  let firstX = padX;
  let lastX = padX;
  let started = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const x = axisX[i];
    const y = yOf(v);
    if (!started) {
      firstX = x;
      line = `M${x.toFixed(1)},${y.toFixed(1)}`;
      started = true;
    } else {
      line += ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    lastX = x;
  }
  const baseY = (H - padBot).toFixed(1);
  const area = `${line} L${lastX.toFixed(1)},${baseY} L${firstX.toFixed(1)},${baseY} Z`;
  const fmt = (v: number) => (speed ? v.toFixed(0) : Math.round(v).toString());
  // Bottom-right: the axis's full extent, so distance vs time reads at a glance.
  const extentLabel = useTime
    ? fmtSecsShort((times![times!.length - 1] - times![0]) / 1000)
    : `${totalKm.toFixed(1)} km`;
  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
    `aria-label="${speed ? "Speed" : "Elevation"} profile vs ${useTime ? "time" : "distance"}">` +
    // Stop bands sit in the BACKGROUND (behind the area + line) so the orange profile
    // always reads as the foreground (see `.rp-stop` / `.rp-stop-top`).
    stops +
    `<path class="rp-area" d="${area}"/>` +
    `<path class="rp-line" d="${line}"/>` +
    `<line class="rp-cursor" id="rpCursor" x1="0" y1="${padTop}" x2="0" y2="${baseY}" style="display:none"/>` +
    `<text class="rp-axis" x="${padX}" y="12">${fmt(range.hi)} ${unit}</text>` +
    `<text class="rp-axis" x="${padX}" y="${H - 5}">${fmt(lo)} ${unit}</text>` +
    `<text class="rp-axis" x="${W - padX}" y="${H - 5}" text-anchor="end">${extentLabel}</text>` +
    `</svg>`;
}

/** Map an along-track distance (km) to its viewBox x under the active profile axis,
 *  by interpolating the per-point `axisX` the profile laid down. Works for both the
 *  distance axis (linear) and the time axis (idle stretches widened), so the cursor
 *  lands on the same x the line was drawn at. */
function profileXForKm(km: number): number {
  const padX = 4;
  const axisX = rideHover?.axisX;
  const cum = rideHover?.cum;
  if (!axisX || !cum || cum.length === 0) return padX;
  const n = cum.length;
  if (km <= cum[0]) return axisX[0];
  if (km >= cum[n - 1]) return axisX[n - 1];
  let i = 1;
  while (i < n - 1 && cum[i] < km) i++;
  const seg = cum[i] - cum[i - 1];
  const f = seg > 0 ? (km - cum[i - 1]) / seg : 0;
  return axisX[i - 1] + f * (axisX[i] - axisX[i - 1]);
}

/** Inverse of `profileXForKm`: a viewBox x (0..1000) back to along-track distance (km),
 *  so a hover/scrub on the profile resolves to the right point on the route. */
function profileKmForX(xView: number): number {
  const axisX = rideHover?.axisX;
  const cum = rideHover?.cum;
  if (!axisX || !cum || cum.length === 0) return 0;
  const n = cum.length;
  if (xView <= axisX[0]) return cum[0];
  if (xView >= axisX[n - 1]) return cum[n - 1];
  let i = 1;
  while (i < n - 1 && axisX[i] < xView) i++;
  const seg = axisX[i] - axisX[i - 1];
  const f = seg > 0 ? (xView - axisX[i - 1]) / seg : 0;
  return cum[i - 1] + f * (cum[i] - cum[i - 1]);
}

/** Move the elevation-profile cursor to a given along-track distance (km). */
function moveProfileCursor(km: number | null): void {
  const cursor = document.getElementById("rpCursor");
  if (!cursor || !rideHover) return;
  if (km == null) {
    cursor.style.display = "none";
    return;
  }
  const x = profileXForKm(km);
  cursor.setAttribute("x1", x.toFixed(1));
  cursor.setAttribute("x2", x.toFixed(1));
  cursor.style.display = "";
}

/**
 * Render the persistent full-track summary strip — the headline stats fetching the
 * recorded trace unlocks beyond the polyline (point count, measured distance, real
 * elevation gain/loss, recording span, peak/avg speed). Shown only once a full track
 * is loaded; hidden (and emptied) otherwise. Each chip is dropped when its datum is
 * absent, so a track without `<ele>`/`<time>` shows only what's real.
 */
function renderRideSummary(): void {
  const host = document.getElementById("rideMapSummary");
  if (!host) return;
  const full = rideHover?.full ?? null;
  if (!full) {
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  const s = fullTrackSummary(full, getState().settings.movingThresholdKmh);
  const chip = (label: string, value: string) =>
    `<span class="rms-chip"><b>${value}</b> ${label}</span>`;
  const chips: string[] = [
    chip("recorded points", s.points.toLocaleString()),
    chip("measured", `${s.distanceKm.toFixed(2)} km`),
  ];
  if (s.gainM != null && s.lossM != null) {
    chips.push(chip("elevation", `↑${Math.round(s.gainM)} m ↓${Math.round(s.lossM)} m`));
  }
  if (s.recordedSec != null) chips.push(chip("recording time", fmtSecsShort(s.recordedSec)));
  if (s.maxKmh != null) chips.push(chip("max speed", `${s.maxKmh.toFixed(1)} km/h`));
  if (s.avgKmh != null) chips.push(chip("avg speed", `${s.avgKmh.toFixed(1)} km/h`));
  if (s.movingAvgKmh != null)
    chips.push(chip("moving avg", `${s.movingAvgKmh.toFixed(1)} km/h`));
  // Subtle hint: how much of the recording was spent stopped (idling), excluded from
  // the moving average. Shown only when it's a meaningful pause (≥ 1 min), so GPS
  // jitter doesn't add noise.
  if (s.recordedSec != null && s.movingSec != null) {
    const stoppedSec = s.recordedSec - s.movingSec;
    if (stoppedSec >= 60) {
      chips.push(
        `<span class="rms-chip subtle" title="Time stopped below ${getState().settings.movingThresholdKmh} km/h — excluded from the moving average"><b>${fmtSecsShort(stoppedSec)}</b> not moving</span>`,
      );
    }
  }
  host.innerHTML = chips.join("");
  host.classList.remove("hidden");
}

/** Handle a hover over the big ride map: find the nearest point along the track,
 *  move the marker there, and report distance + time into the ride. With a full
 *  track loaded the time/elevation are REAL (read from the nearest recorded point);
 *  otherwise the time is an even-pace estimate (rendered with a "~"). */
function onRideMapHover(e: L.LeafletMouseEvent): void {
  updateRideHoverAt(e.containerPoint, 28);
}

/**
 * Light up the nearest along-track point to a container-pixel position — the shared
 * core of the desktop hover AND the mobile tap (Leaflet `mousemove` never fires on
 * touch, so a tap drives this instead). Clears when the position is farther than
 * `maxDistPx` from the route, so an off-route tap/hover dismisses the marker. The
 * tap path passes a larger radius than a mouse hover since a fingertip is coarser.
 */
function updateRideHoverAt(cur: L.Point, maxDistPx: number): void {
  if (!rideMapBig || !rideHover) return;
  const px = rideHover.px;
  let best = Number.POSITIVE_INFINITY;
  let bestKm = 0;
  let bestIdx = 0;
  let bestLatLng: [number, number] | null = null;
  for (let i = 1; i < px.length; i++) {
    const a = px[i - 1];
    const b = px[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((cur.x - a.x) * dx + (cur.y - a.y) * dy) / len2));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const d = Math.hypot(cur.x - cx, cur.y - cy);
    if (d < best) {
      best = d;
      bestKm = rideHover.cum[i - 1] + t * (rideHover.cum[i] - rideHover.cum[i - 1]);
      bestIdx = t < 0.5 ? i - 1 : i;
      const la = rideHover.pts[i - 1];
      const lb = rideHover.pts[i];
      bestLatLng = [la[0] + t * (lb[0] - la[0]), la[1] + t * (lb[1] - la[1])];
    }
  }
  if (best > maxDistPx || !bestLatLng) {
    clearRideTrackPoint();
    return;
  }
  showRideTrackPoint(bestLatLng, bestIdx, bestKm);
}

/** Clear the hover marker, readout and profile cursor (pointer left the track). */
function clearRideTrackPoint(): void {
  // Clear the text but KEEP the persistent dial element (just hide it), so its CSS
  // transitions survive between hovers instead of resetting on a recreated node.
  if (hoverTextEl) hoverTextEl.textContent = "";
  windDialEl?.classList.add("hidden");
  rideMapMarker?.remove();
  rideMapMarker = null;
  moveProfileCursor(null);
}

/**
 * Light up one along-track position everywhere at once: drop/move the route marker
 * at the interpolated lat/lng, write the distance/time/elevation/speed readout, and
 * move the elevation-profile cursor to the matching distance. Shared by BOTH the
 * map-hover and the profile-hover paths so hovering either surface highlights the
 * same point on the other. `idx` is the nearest recorded-point index (for real
 * time/elevation/speed), `km` the cumulative distance into the ride.
 */
function showRideTrackPoint(latLng: [number, number], idx: number, km: number): void {
  if (!rideMapBig || !rideHover) return;
  const out = document.getElementById("rideMapHover");
  if (!rideMapMarker) {
    rideMapMarker = L.circleMarker(latLng, {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: "#fc5200",
      fillOpacity: 1,
      interactive: false, // let taps pass through to the map (mobile tap-to-place)
    }).addTo(rideMapBig);
  } else {
    rideMapMarker.setLatLng(latLng);
  }

  const full = rideHover.full;
  const parts = [`${full ? "" : "~"}${km.toFixed(2)} km`];
  if (full && hasTimes(full) && rideHover.startMs !== null) {
    // Real recorded time at the nearest point — no estimate.
    const tMs = full.times[idx];
    if (tMs != null) {
      const intoSec = (tMs - rideHover.startMs) / 1000;
      if (intoSec >= 0) parts.push(`${fmtSecsShort(intoSec)} in`);
      const clock = new Date(tMs);
      const p2 = (n: number) => String(n).padStart(2, "0");
      parts.push(`${p2(clock.getHours())}:${p2(clock.getMinutes())}`);
    }
    const ele = full.eles[idx];
    if (ele != null) parts.push(`${Math.round(ele)} m`);
    const spd = rideHover.speeds?.[idx];
    if (spd != null) parts.push(`${spd.toFixed(1)} km/h`);
  } else if (rideHover.elapsedSec > 0) {
    // Even-pace estimate from total elapsed time.
    const frac = rideHover.totalKm > 0 ? km / rideHover.totalKm : 0;
    parts.push(`~${fmtSecsShort(frac * rideHover.elapsedSec)} in`);
    if (rideHover.startMs !== null) {
      const clock = new Date(rideHover.startMs + frac * rideHover.elapsedSec * 1000);
      const p2 = (n: number) => String(n).padStart(2, "0");
      parts.push(`~${p2(clock.getHours())}:${p2(clock.getMinutes())}`);
    }
  }
  if (out) {
    // Keep the text and the wind dial as PERSISTENT child elements (never recreated)
    // so the dial's rotation + colour animate smoothly via CSS as you scrub the route,
    // instead of snapping on each rebuilt node.
    const els = ensureHoverEls(out);
    els.text.textContent = parts.join(" · ");
    const w = windProjectionAt(latLng);
    if (w) {
      updateWindDial(els.dial, w);
      els.dial.classList.remove("hidden");
    } else {
      els.dial.classList.add("hidden");
    }
  }
  moveProfileCursor(km);
}

/** Persistent children of the hover readout: the text run + the wind dial. Rebuilt
 *  only when the readout container is replaced (e.g. the map reopened). */
let hoverTextEl: HTMLElement | null = null;
let windDialEl: HTMLElement | null = null;

function ensureHoverEls(out: HTMLElement): { text: HTMLElement; dial: HTMLElement } {
  if (!hoverTextEl || hoverTextEl.parentElement !== out || !windDialEl) {
    out.textContent = "";
    hoverTextEl = document.createElement("span");
    hoverTextEl.className = "rmh-text";
    windDialEl = buildWindDial();
    out.append(hoverTextEl, windDialEl);
  }
  return { text: hoverTextEl, dial: windDialEl };
}

/**
 * Build the wind dial: a tiny compass where "up" is YOUR direction of travel (a fixed
 * muted marker), and a coloured arrow rotates to show where the wind pushes RELATIVE
 * to your movement — straight up = pure tailwind, straight down = pure headwind,
 * sideways = crosswind. Drawn once; `updateWindDial` spins + tints it on each hover.
 */
function buildWindDial(): HTMLElement {
  const dial = document.createElement("span");
  dial.className = "rmh-dial hidden";
  dial.innerHTML =
    `<svg viewBox="0 0 24 24" aria-hidden="true">` +
    `<circle class="rd-ring" cx="12" cy="12" r="10"/>` +
    // Fixed "forward" tick at the top = your direction of travel.
    `<path class="rd-fwd" d="M12 1.5 L13.6 4.2 L10.4 4.2 Z"/>` +
    // The rotating wind arrow (points up = tailwind by default).
    `<g class="rd-arrow"><path d="M12 17.5 L12 7 M9 10 L12 6.5 L15 10"/></g>` +
    `</svg>` +
    `<b class="rd-val">0</b><i>km/h</i>`;
  return dial;
}

/** Spin + tint the wind dial to the relative wind at a hovered point. */
function updateWindDial(dial: HTMLElement, w: PointWind): void {
  // Direction the wind blows TOWARD, expressed in the rider's frame (0 = forward).
  const relFlow = (((w.fromDeg + 180 - w.headingDeg) % 360) + 360) % 360;
  const along = Math.abs(w.alongKmh);
  const cross = along < 1.5;
  const value = cross ? Math.round(w.speedKmh) : Math.round(along);
  dial.style.setProperty("--wind", windColor(w.alongKmh));
  const arrow = dial.querySelector<SVGElement>(".rd-arrow");
  if (arrow) arrow.style.transform = `rotate(${relFlow.toFixed(0)}deg)`;
  const val = dial.querySelector(".rd-val");
  if (val) val.textContent = String(value);
  dial.title =
    `${cross ? "Crosswind" : w.alongKmh > 0 ? "Tailwind" : "Headwind"} ` +
    `${value} km/h (along your heading) · wind ${Math.round(w.speedKmh)} km/h from ` +
    `${compass8(w.fromDeg)} · gust ${Math.round(w.gustKmh)} km/h. Up = your direction of travel.`;
}

/** The nearest resolved wind sample to a lat/lng on the open ride, or null when wind
 *  isn't resolved. A linear nearest-point scan (point count is bounded) so it's cheap
 *  on every hover and robust even if the wind geometry differs from the hover track. */
function windProjectionAt(latLng: [number, number]): PointWind | null {
  if (!rideMapKey) return null;
  const overlay = getController().getRideWindOverlay(rideMapKey);
  if (!overlay) return null;
  const { points, winds } = overlay;
  let best = Number.POSITIVE_INFINITY;
  let bestW: PointWind | null = null;
  for (let i = 0; i < points.length; i++) {
    const w = winds[i];
    if (!w) continue;
    const dlat = points[i][0] - latLng[0];
    const dlon = points[i][1] - latLng[1];
    const d = dlat * dlat + dlon * dlon;
    if (d < best) {
      best = d;
      bestW = w;
    }
  }
  return bestW;
}

/**
 * Resolve an along-track distance (km) to its interpolated lat/lng and nearest
 * recorded-point index — the inverse of the map hover's pixel search. Used to light
 * up the route when the elevation profile is hovered.
 */
function trackPointAtKm(km: number): { latLng: [number, number]; idx: number } | null {
  if (!rideHover || rideHover.pts.length < 2) return null;
  const { cum, pts } = rideHover;
  const target = Math.max(0, Math.min(km, rideHover.totalKm));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const segLen = cum[i] - cum[i - 1];
  const t = segLen > 0 ? (target - cum[i - 1]) / segLen : 0;
  const a = pts[i - 1];
  const b = pts[i];
  return {
    latLng: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
    idx: t < 0.5 ? i - 1 : i,
  };
}

/**
 * Hover over the elevation profile → sync the route map. Maps the cursor's X to an
 * along-track distance (through the SAME padding the profile path uses) and lights
 * up that point on the map + readout via `showRideTrackPoint`.
 */
function onRideProfileHover(e: PointerEvent): void {
  if (!rideHover) return;
  const svg = (e.currentTarget as HTMLElement).querySelector("svg");
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0) return;
  // Convert the pointer to a viewBox x, then back through the profile's own axis
  // mapping (distance- or time-based) so the lit point matches where the cursor sits.
  const W = 1000;
  const xView = ((e.clientX - rect.left) / rect.width) * W;
  const km = profileKmForX(xView);
  const at = trackPointAtKm(km);
  if (at) showRideTrackPoint(at.latLng, at.idx, km);
}

/** Show/hide the full-track controls in the bar to match the loaded state. */
function syncRideMapControls(): void {
  const ride = rideMapKey ? getState().rides.find((r) => r.key === rideMapKey) : null;
  const full = rideMapKey ? getController().getFullTrack(rideMapKey) : null;
  const fetchBtn = document.getElementById("btnRideMapFull") as HTMLButtonElement | null;
  const colorSeg = document.getElementById("rideMapColor");
  const profileBtn = document.getElementById("btnRideMapProfile") as HTMLButtonElement | null;
  const metricSeg = document.getElementById("rideMapProfileMetric");
  const axisSeg = document.getElementById("rideMapProfileAxis");
  const est = document.getElementById("rideMapEst");
  const hasTime = (ride?.elapsed_sec || ride?.moving_sec || 0) > 0;

  // The standalone Wind action is the fallback for rides with NO full GPX (no
  // advanced controls): it works off the rough polyline + synthesized times. Once a
  // full track is loaded Wind becomes the 4th pillar in the colour seg, so this
  // button hides and the seg owns wind. Its label tracks the lifecycle: Resolve →
  // Resolving… → toggle on/off.
  const windBtn = document.getElementById("btnRideMapWind") as HTMLButtonElement | null;
  if (windBtn && rideMapKey) {
    const resolving = getController().isResolvingWind(rideMapKey);
    const resolved = getController().hasResolvedWind(rideMapKey);
    const on = rideMapColorMode === "wind";
    windBtn.classList.toggle("hidden", !ride?.track || !!full);
    windBtn.disabled = resolving;
    windBtn.classList.toggle("active", on);
    windBtn.setAttribute("aria-pressed", String(on));
    setRmbLabel(
      windBtn,
      resolving
        ? "Resolving wind…"
        : !resolved
          ? "Resolve wind"
          : on
            ? "Wind: on"
            : "Show wind",
    );
  }

  if (full) {
    fetchBtn?.classList.add("hidden");
    colorSeg?.classList.remove("hidden");
    // The profile + its toggle make sense once the track carries elevation OR
    // (timestamps →) speed; the metric seg only appears when BOTH are available,
    // since with one metric there's nothing to switch to.
    const avail = profileMetricsAvailable();
    const showProfileBtn = avail.elevation || avail.speed;
    profileBtn?.classList.toggle("hidden", !showProfileBtn);
    est?.classList.add("hidden"); // real time now — no estimate disclaimer
    setRideMapStatus(""); // loaded — clear any prior fetching/error note
    // Reflect the colour-mode selection.
    colorSeg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === rideMapColorMode);
    });
    // Wind is the 4th colour pillar once a full track is loaded; show its resolve
    // lifecycle on the seg button (disabled + "Wind…" while the networked lookup runs).
    const windSegBtn = colorSeg?.querySelector<HTMLButtonElement>('button[data-color="wind"]');
    if (windSegBtn && rideMapKey) {
      const resolving = getController().isResolvingWind(rideMapKey);
      windSegBtn.disabled = resolving;
      setRmbLabel(windSegBtn, resolving ? "Wind…" : "Wind");
    }
    if (profileBtn) {
      const shown = rideMapProfileShown && showProfileBtn;
      setRmbLabel(profileBtn, shown ? "Hide profile" : "Show profile");
      profileBtn.setAttribute("aria-pressed", String(shown));
    }
    // Profile-metric segmented control: visible only with both metrics + profile open.
    const showMetricSeg = avail.elevation && avail.speed && rideMapProfileShown;
    metricSeg?.classList.toggle("hidden", !showMetricSeg);
    const eff = effectiveProfileMetric();
    metricSeg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.profile === eff);
    });
    // Profile x-axis control: a distance↔time switch, offered only when the track
    // carries timestamps (else time is meaningless) and the profile is open.
    const showAxisSeg = !!full && hasTimes(full) && rideMapProfileShown;
    axisSeg?.classList.toggle("hidden", !showAxisSeg);
    axisSeg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.axis === rideMapProfileAxis);
    });
  } else {
    if (fetchBtn) {
      fetchBtn.classList.remove("hidden");
      fetchBtn.disabled = false;
      setRmbLabel(fetchBtn, "Fetch full track");
    }
    colorSeg?.classList.add("hidden");
    profileBtn?.classList.add("hidden");
    metricSeg?.classList.add("hidden");
    axisSeg?.classList.add("hidden");
    est?.classList.toggle("hidden", !hasTime);
  }
  syncRideMapBarCompact();
}

/**
 * Fold the ride-map bar's controls to icon-only when the row would otherwise overflow
 * its width (the honest "not enough space" test, since the map is full-screen at every
 * viewport). Synchronous (one forced reflow on a single row), so no flicker is painted.
 *
 * `allowExpand` makes the two callers asymmetric on purpose:
 *  - a genuine width change (the ResizeObserver) passes `true` → fully re-evaluate, so
 *    widening the window relaxes back to labels;
 *  - a CONTENT change (controls shown/hidden, e.g. toggling the profile) passes `false`
 *    → it may only collapse further, never expand. Otherwise hiding the profile frees
 *    the metric/axis segs' width and the still-visible controls would jarringly unfold
 *    from icons back to labels mid-session.
 */
function syncRideMapBarCompact(allowExpand = false): void {
  const bar = document.querySelector<HTMLElement>(".ridemap-bar");
  const tools = document.querySelector<HTMLElement>(".ridemap-tools");
  if (!bar || !tools) return;
  if (allowExpand) bar.classList.remove("compact");
  // Measure the TOOLS cluster, not the whole bar: the cluster is the bar's overflow
  // valve (it scrolls horizontally as a last resort, with the title capped and Close
  // pinned), so the bar itself no longer reports overflow even when the controls don't
  // fit. The cluster's own scrollWidth > clientWidth is the honest "not enough room"
  // signal — fold to icon-only first; only the extreme-narrow case then scrolls. A
  // small slack avoids toggling on a sub-pixel overshoot.
  if (tools.scrollWidth > tools.clientWidth + 1) bar.classList.add("compact");
}

/** Build the hover/line/profile state for the open ride from its display track and
 *  (when available) the in-memory full recorded track, then draw everything. */
function buildRideMapState(): void {
  const key = rideMapKey;
  if (!rideMapBig || !key) return;
  const ride = getState().rides.find((r) => r.key === key);
  if (!ride) return;
  const full = getController().getFullTrack(key);
  let pts: [number, number][];
  if (full && full.points.length >= 2) {
    pts = full.points;
  } else {
    try {
      pts = decodePolyline(ride.track);
    } catch {
      return;
    }
  }
  if (pts.length < 2) return;
  const cum = cumulativeKm(pts);
  const speeds = full && hasTimes(full) ? smoothedSpeedsKmh(full) : null;
  rideHover = {
    pts,
    cum,
    totalKm: cum[cum.length - 1],
    elapsedSec: ride.elapsed_sec || ride.moving_sec || 0,
    startMs: rideDatetime(ride.key)?.getTime() ?? null,
    px: [],
    full: full && full.points.length >= 2 ? full : null,
    speeds,
    axisX: null,
  };
  rideMapMarker = null;
  drawRideLine();
  renderRideProfile();
  renderRideSummary();
  renderRideMapWind();
  syncRideMapControls();
  setTimeout(() => {
    rideMapBig?.invalidateSize();
    reprojectRideHover();
  }, 0);
}

/** Open the full-screen route map for one ride. */
export function openRideMap(key: string): void {
  const ride = getState().rides.find((r) => r.key === key);
  if (!ride?.track && !getController().getFullTrack(key)) return;

  const modal = document.getElementById("rideMapModal");
  const host = document.getElementById("rideMapBig");
  if (!modal || !host) return;

  rideMapKey = key;
  rideMapColorMode = "none";
  rideMapProfileMetric = "elevation";
  rideMapProfileAxis = "distance";
  setRideMapStatus("");
  // If this ride's wind was resolved earlier, recompute its overlay from the cache
  // (no network) so the "Show wind" toggle paints instantly; never auto-fetches.
  getController().showCachedWind(key);

  // Title: the ride's name + location, then its short date.
  const name = (ride?.title || "Ride") + (ride?.location || "");
  const when = rideShortLabel(key) || key;
  const titleEl = document.getElementById("rideMapTitle");
  if (titleEl) titleEl.textContent = `${name} · ${when}`;
  const hoverEl = document.getElementById("rideMapHover");
  if (hoverEl) hoverEl.textContent = "";

  modal.classList.remove("hidden");
  document.body.classList.add("ridemap-open");

  // Re-evaluate the bar's icon-collapse whenever its width changes (window resize),
  // not just on control changes. One observer for the modal's lifetime.
  const bar = modal.querySelector<HTMLElement>(".ridemap-bar");
  if (bar && "ResizeObserver" in window) {
    rideMapBarObserver?.disconnect();
    rideMapBarObserver = new ResizeObserver(() => syncRideMapBarCompact(true));
    rideMapBarObserver.observe(bar);
  }

  // Build (or rebuild) the map fresh each open — cheap, and avoids stale layers.
  if (rideMapBig) {
    rideMapBig.remove();
    rideMapBig = null;
  }
  rideMapLineLayer = null;
  const map = L.map(host, { attributionControl: true, zoomControl: true });
  map.attributionControl.setPrefix(false); // compact credit, no "Leaflet" flag
  rideMapBig = map;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: deps.osmAttribution,
    className: "rmap-tiles",
  }).addTo(map);

  buildRideMapState();
  if (rideHover) {
    map.fitBounds(L.latLngBounds(rideHover.pts), { padding: [24, 24] });
  }

  // If the full GPX is cached (real time + elevation) but not yet parsed into this
  // session, rehydrate it from the cache — no network — so the offline map shows the
  // full UX (profile, real speed/elevation) automatically instead of offering "Fetch
  // full track" for data we already hold. Async: the initial build above already drew
  // the route, this just upgrades it in place once the cache read resolves.
  if (ride?.gpx_cached && !getController().getFullTrack(key)) {
    void getController()
      .loadCachedFullTrack(key)
      .then((ft) => {
        if (ft && rideMapKey === key && rideMapBig) {
          buildRideMapState();
          if (rideHover) {
            rideMapBig.fitBounds(L.latLngBounds(rideHover.pts), { padding: [24, 24] });
          }
        }
      });
  }

  map.on("move zoom resize zoomend moveend", reprojectRideHover);
  map.on("mousemove", onRideMapHover);
  map.on("mouseout", clearRideTrackPoint);
  // Touch has no hover: a tap on (or near) the route places and syncs the dot the
  // same way a desktop hover does. Leaflet fires `click` for both mouse and touch,
  // so this is the mobile entry point for "show & sync the marker". A generous
  // radius accommodates an imprecise fingertip; a tap well off the route clears it.
  map.on("click", (e: L.LeafletMouseEvent) => updateRideHoverAt(e.containerPoint, 44));
}

/** Fetch the open ride's full recorded track, then upgrade the map in place. On
 *  failure the error is shown BOTH inline in the map bar (so it's visible in the
 *  full-screen view, where the bottom toast is easy to miss) and as a toast, and
 *  the button is re-enabled so the user can retry. */
export function fetchRideMapFull(): void {
  const key = rideMapKey;
  if (!key) return;
  const fetchBtn = document.getElementById("btnRideMapFull") as HTMLButtonElement | null;
  // Gate on consent (when an export gateway is configured) first, then on a live
  // connection (may pop the re-auth picker in offline mode); only show the
  // "downloading…" busy state once the fetch actually starts, so a cancelled
  // re-auth or declined consent doesn't leave the button stuck spinning.
  withGpxRelayConsent(() =>
    withBeelineAccess(() => {
      if (rideMapKey !== key) return; // user moved on while signing in
      if (fetchBtn) {
        fetchBtn.disabled = true;
        setRmbLabel(fetchBtn, "Fetching…");
      }
      setRideMapStatus("Downloading the full recorded track…", "info");
      getController()
        .fetchFullTrack(key)
        .then(() => {
          // The user may have closed or switched rides while it loaded.
          if (rideMapKey === key && rideMapBig) {
            buildRideMapState();
            if (rideHover) {
              rideMapBig.fitBounds(L.latLngBounds(rideHover.pts), { padding: [24, 24] });
            }
          }
          setRideMapStatus("");
          toast("Full track loaded — time, elevation and speed are now real.");
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Don't fold the (often long) error into the cramped map bar — clear the
          // "downloading…" note and let the toast (which paints above the full-screen
          // map) carry the reason. The button flipping to "Retry full track" is the
          // persistent, in-context signal that it failed.
          if (rideMapKey === key) {
            setRideMapStatus("");
            if (fetchBtn) {
              fetchBtn.disabled = false;
              setRmbLabel(fetchBtn, "Retry full track");
            }
          }
          toast(`Couldn't fetch the full track: ${msg}`, true);
        });
    }),
  );
}

/** Switch the route-colouring mode (plain / by elevation / by speed). */
export function setRideMapColor(mode: "none" | "height" | "speed"): void {
  rideMapColorMode = mode;
  drawRideLine();
  syncRideMapControls();
}

/**
 * Enable wind colouring on the open ride (select semantics — no toggle-off, since
 * this backs the colour seg's Wind pillar where picking another mode switches away).
 * Wind is NEVER fetched automatically; selecting it is the deliberate trigger: when
 * the ride has no resolved wind yet it kicks off the (networked) resolution and
 * paints as soon as it lands, otherwise it recomputes the overlay from cache.
 */
export function enableRideMapWind(): void {
  const key = rideMapKey;
  if (!key || rideMapColorMode === "wind") return;
  rideMapColorMode = "wind";
  if (!getController().hasResolvedWind(key) && !getController().isResolvingWind(key)) {
    const n = getController().resolveWind([key]);
    if (n === 0) toast("This ride has no track to resolve wind for.");
  } else {
    getController().showCachedWind(key); // recompute the overlay from cache if needed
  }
  drawRideLine();
  syncRideMapControls();
  renderRideMapWind();
}

/**
 * The standalone Wind button's action (the no-full-GPX fallback). A true toggle:
 * turns wind colouring back off when it's already on (data stays cached), else
 * enables it via `enableRideMapWind`.
 */
export function toggleRideMapWind(): void {
  if (!rideMapKey) return;
  if (rideMapColorMode === "wind") {
    // Toggle the wind colouring back off (leaves the data cached).
    setRideMapColor("none");
    renderRideMapWind();
    return;
  }
  enableRideMapWind();
}

/**
 * Wind summary line under the big-map bar: prevailing direction, average wind, the
 * tailwind share, and the data provenance (model + cells + Open-Meteo credit). Shows
 * a quiet "resolving" hint while the explicit lookup runs, and an honest note when
 * no historical wind is available. Visible only while wind colouring is active.
 */
function renderRideMapWind(): void {
  const host = document.getElementById("rideMapWind");
  if (!host) return;
  const key = rideMapKey;
  if (!key || rideMapColorMode !== "wind") {
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  host.classList.remove("hidden");
  const w = getController().getRideWind(key);
  if (!w) {
    host.innerHTML = getController().isResolvingWind(key)
      ? `<span class="windbadge-pending">Resolving historical wind from Open-Meteo…</span>`
      : `<span class="windbadge-pending">Resolving historical wind…</span>`;
    return;
  }
  if (w.noData) {
    host.innerHTML = `<span class="windbadge-none">No historical wind available for this ride (it may be too recent — the reanalysis archive lags a few days).</span>`;
    return;
  }
  const assist = w.avgAlongKmh >= 0 ? "tailwind" : "headwind";
  const toDeg = (w.prevailingFromDeg + 180) % 360;
  const arrow =
    `<span class="wind-arrow wind-arrow-badge" style="transform:rotate(${toDeg.toFixed(0)}deg)">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<path d="M12 3 L12 21 M12 3 L7 9 M12 3 L17 9" fill="none" stroke="currentColor" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  host.innerHTML =
    arrow +
    `<span class="wind-main">Wind from <b>${compass8(w.prevailingFromDeg)}</b> · ` +
    `${Math.round(w.avgSpeedKmh)} km/h · ${Math.round(w.pctTailwind * 100)}% tailwind · ` +
    `avg ${assist} ${Math.abs(w.avgAlongKmh).toFixed(1)} km/h · gust ${Math.round(w.avgGustKmh)} km/h</span>` +
    `<span class="wind-prov">${esc(w.datasetLabel)} · ${w.cellCount} cell${w.cellCount === 1 ? "" : "s"} · ` +
    `hourly · green = tailwind, red = headwind · ` +
    `<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Weather by Open-Meteo</a></span>`;
}

/** Toggle the elevation profile panel, re-measuring the map afterwards. */
export function toggleRideMapProfile(): void {
  rideMapProfileShown = !rideMapProfileShown;
  renderRideProfile();
  syncRideMapControls();
  setTimeout(() => {
    rideMapBig?.invalidateSize();
    reprojectRideHover();
  }, 0);
}

/** Switch the profile metric (elevation vs speed), redrawing the graph in place. */
export function setRideMapProfileMetric(metric: "elevation" | "speed"): void {
  rideMapProfileMetric = metric;
  renderRideProfile();
  syncRideMapControls();
}

/** Switch the profile x-axis (distance vs time), redrawing the graph in place. */
export function setRideMapProfileAxis(axis: "distance" | "time"): void {
  rideMapProfileAxis = axis;
  renderRideProfile();
  syncRideMapControls();
}

/** Close the full-screen route map and release its Leaflet instance. */
export function closeRideMap(): void {
  const modal = document.getElementById("rideMapModal");
  modal?.classList.add("hidden");
  document.body.classList.remove("ridemap-open");
  rideMapBarObserver?.disconnect();
  rideMapBarObserver = null;
  if (rideMapBig) {
    rideMapBig.remove();
    rideMapBig = null;
  }
  rideMapLineLayer = null;
  rideMapMarker = null;
  rideHover = null;
  rideMapKey = null;
  hoverTextEl = null;
  windDialEl = null;
  setRideMapStatus("");
  document.getElementById("rideMapSummary")?.classList.add("hidden");
  document.getElementById("rideMapWind")?.classList.add("hidden");
}

/** Redraw the open big map's wind overlay + summary while wind colouring is active
 *  (called on every controller change so a resolving job paints when it completes). */
export function refreshOpenRideMapWind(): void {
  if (!rideMapBig || !rideMapKey || rideMapColorMode !== "wind") return;
  drawRideLine();
  syncRideMapControls();
  renderRideMapWind();
}
