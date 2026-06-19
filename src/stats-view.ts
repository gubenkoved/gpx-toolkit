/**
 * GPX Toolkit — Stats view (`#statsView`).
 *
 * Lifetime totals, distance records and a route-frequency heatmap. Totals/records come
 * from the cheap per-ride scalars (`computeStats`); the heatmap resamples every track to
 * evenly-spaced points so often-ridden corridors glow far brighter than the Map view's
 * translucent line-stacking ever could. To stay responsive at a power user's thousands of
 * tracks the heat layer densifies only the visible viewport and rebuilds on pan/zoom,
 * caching the track set so a thickness tweak or a re-pan doesn't re-scan.
 *
 * Self-contained behind a `StatsViewDeps` seam — the shared date-range control, the live
 * ride list, the filtered-window flag and the canonical "Selected" card renderer (shared
 * with the Map view) are injected as lazy closures, the same pattern as the other view
 * modules. The interactive basemap + expand toggle come from `./map-core`, so the heatmap
 * and the Map view share one look and one full-screen behaviour.
 */

import L from "leaflet";
import "leaflet.heat";
import { type AreaSelect, createAreaSelect } from "./areaselect";
import type { RideView } from "./controller";
import { fmtDuration, fmtElevation, fmtKm } from "./format";
import { BASE_SPACING_M, buildHeatPoints, type HeatBounds, spacingForZoom } from "./heatmap";
import { createLocate, type Locate } from "./locate";
import { CLICK_PX, createInteractiveMap, HOT_TRACK, makeExpandToggle } from "./map-core";
import { type DateRange, type RideTrack, ridesWithTracks } from "./mapview";
import { rideShortLabel } from "./parsing";
import { computeStats, type PeriodRecord } from "./stats";
import { statNum } from "./ui";

/** What the view needs from the app (injected once via `initStatsView`). */
export interface StatsViewDeps {
  /** The live (deleted-included) ride list. */
  getRides(): RideView[];
  /** Filter rides to a date selection (the app's shared range helper). */
  ridesInRange(rides: RideView[], range: DateRange): RideView[];
  /** The current Stats date selection, or null for the full span. */
  statsRange(): DateRange | null;
  /** Sync the shared date-range control's bounds for this view. */
  refreshRange(): void;
  /** (Re)mount the shared date-range slider for this view. */
  syncRangeControl(): void;
  /** A compact "filtered · …" flag when the Stats slider is narrowed (else ""). */
  filteredFlag(): string;
  /** Render the canonical "Selected" cards block for the given keys (shared with the Map view). */
  renderSelectedCards(keys: string[]): string;
  /** Current heat glow radius (settings). */
  heatRadius(): number;
  /** Surface a non-fatal error to the user. */
  toast(msg: string, isError?: boolean): void;
}

let deps!: StatsViewDeps;

let freqHeatMap: L.Map | null = null;
let freqHeatLayer: L.Layer | null = null;
// Whether the heatmap has been framed at least once. Like the Map view, background
// data updates must NOT re-fit; we frame only on the first draw and on an explicit
// reset/reframe (see mountFreqHeatmap's `fit`).
let heatFitted = false;
let lastHeatSig = "";
/** Track-set signature: when this changes we re-scan and re-fit; view changes alone don't. */
let lastHeatDataSig = "";
/** Tracks behind the current heat layer, kept so a pan/zoom can rebuild without a re-scan. */
let lastHeatTracks: RideTrack[] = [];
/** Rides selected on the heatmap by a click or area-drag (independent of the Map view's). */
let heatSelectedKeys: string[] = [];
/** Transient bright overlay drawn while hovering a heatmap "Selected" card (the heat
 *  layer draws no per-ride lines, so we add one to echo the Map view's hover emphasis). */
let heatHoverLine: L.Polyline | null = null;

/** Wire the view's dependencies. Call once at startup. */
export function initStatsView(d: StatsViewDeps): void {
  deps = d;
}

/** Toggle the Stats heatmap between inline and full-screen; resize Leaflet to match. */
export const setHeatExpanded = makeExpandToggle(
  "heat-expanded",
  "btnHeatExpand",
  () => freqHeatMap,
);

/** Remove the heatmap's hover overlay line, if any. */
export function clearHeatHover(): void {
  if (heatHoverLine) {
    heatHoverLine.remove();
    heatHoverLine = null;
  }
}

/** Clear the heatmap's ride selection and re-render its "Selected" list. */
export function clearHeatSelection(): void {
  heatSelectedKeys = [];
  renderHeatMatched();
}

/** Draw (or move) the hover overlay to the given ride's track on the heatmap. */
export function showHeatHover(key: string): void {
  clearHeatHover();
  if (!freqHeatMap) return;
  const track = lastHeatTracks.find((t) => t.key === key);
  if (!track) return;
  heatHoverLine = L.polyline(track.points as L.LatLngExpression[], {
    ...HOT_TRACK,
    interactive: false,
  }).addTo(freqHeatMap);
}

/** Render the heatmap's "Selected" list, dropping any keys whose track is no longer drawn. */
export function renderHeatMatched(): void {
  const box = document.getElementById("heatMatched");
  if (!box) return;
  const drawn = new Set(lastHeatTracks.map((t) => t.key));
  heatSelectedKeys = heatSelectedKeys.filter((k) => drawn.has(k));
  clearHeatHover();
  const cards = deps.renderSelectedCards(heatSelectedKeys);
  box.innerHTML =
    cards ||
    `<div class="ms-empty">Drag a rectangle on the heatmap with the <b>Select area</b> ` +
      `tool — or click near a route — to list the rides passing through it here.</div>`;
}

// The Stats heatmap's area-select gesture: a box-drag selects every ride crossing
// it, a click the nearest. Selection drives the matching list below the heatmap.
export const heatAreaSelect: AreaSelect = createAreaSelect({
  getMap: () => freqHeatMap,
  getTracks: () => lastHeatTracks,
  button: document.getElementById("btnHeatSelect"),
  onSelect: (keys) => {
    heatSelectedKeys = keys;
    renderHeatMatched();
  },
  clickPx: CLICK_PX,
});

// "Locate me" on the route-frequency heatmap (same control as the Map view).
export const heatLocate: Locate = createLocate({
  getMap: () => freqHeatMap,
  button: document.getElementById("btnHeatLocate"),
  onError: (msg) => deps.toast(msg, true),
});

/** On-screen pixel gap we aim to keep between heat points; half the glow radius keeps them merged. */
function freqHeatSpacing(radius: number): number {
  if (!freqHeatMap) return BASE_SPACING_M;
  const zoom = freqHeatMap.getZoom();
  const lat = freqHeatMap.getCenter().lat;
  return spacingForZoom(zoom, lat, radius / 2);
}

/** Current padded viewport as heat bounds, so off-screen track segments are culled. */
function freqHeatBounds(): HeatBounds | undefined {
  if (!freqHeatMap) return undefined;
  // Pad beyond the view so a small pan before the next rebuild doesn't reveal gaps.
  const b = freqHeatMap.getBounds().pad(0.3);
  return {
    minLat: b.getSouth(),
    minLon: b.getWest(),
    maxLat: b.getNorth(),
    maxLon: b.getEast(),
  };
}

/**
 * Cache key for the heat layer: a finer spacing at high zoom only renders the
 * visible slice, so the key must include both the zoom *and* the viewport (a pan
 * exposes different segments) alongside the track set.
 */
function freqHeatSig(tracks: ReadonlyArray<RideTrack>): string {
  if (!freqHeatMap) return `0#${tracks.map((t) => t.key).join("|")}`;
  const zoom = Math.round(freqHeatMap.getZoom());
  const c = freqHeatMap.getCenter();
  // Center to ~3 decimals (~100 m) is enough to detect a meaningful pan.
  const view = `${zoom}@${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
  return `${view}#${tracks.map((t) => t.key).join("|")}`;
}

/** (Re)build the heat layer from `lastHeatTracks` for the current zoom/viewport. */
function buildFreqHeatLayer(): void {
  if (!freqHeatMap) return;
  if (freqHeatLayer) {
    freqHeatMap.removeLayer(freqHeatLayer);
    freqHeatLayer = null;
  }
  const radius = deps.heatRadius();
  const spacing = freqHeatSpacing(radius);
  // Scale weight by spacing so a finer (zoomed-in) resample deposits the same glow
  // energy per metre as the 30 m baseline — denser points must not over-saturate.
  const weight = spacing / BASE_SPACING_M;
  const pts = buildHeatPoints(lastHeatTracks, spacing, weight, freqHeatBounds());
  if (pts.length) {
    freqHeatLayer = L.heatLayer(pts as [number, number, number][], {
      radius,
      blur: radius + 2,
      minOpacity: 0.25,
      gradient: { 0.0: "#1e3a8a", 0.4: "#22d3ee", 0.7: "#facc15", 1.0: "#f97316" },
    }).addTo(freqHeatMap);
  }
}

/** Re-render the cached heat layer after a pan/zoom, without re-scanning rides. */
function redrawFreqHeatmap(): void {
  if (!freqHeatMap) return;
  const sig = freqHeatSig(lastHeatTracks);
  if (sig === lastHeatSig) return; // same view & tracks — nothing to rebuild
  lastHeatSig = sig;
  buildFreqHeatLayer();
}

/** One totals/record card: a big value, a label, and an optional sub-line. */
function statCard(value: string, label: string, sub = ""): string {
  return statNum({ value, label, sub: sub || undefined });
}

/** Record card for a best period (muted placeholder when there's no data). */
function periodCard(rec: PeriodRecord | null, label: string): string {
  if (!rec) return statCard("—", label);
  return statCard(
    fmtKm(rec.km),
    label,
    `${rec.label} · ${rec.count} ride${rec.count === 1 ? "" : "s"}`,
  );
}

/** Render the Stats view: totals, records and the route-frequency heatmap. */
export function mountStatsView(opts: { fit?: boolean } = {}): void {
  const live = deps.getRides().filter((r) => !r.deleted);
  document.getElementById("statsEmpty")?.classList.toggle("hidden", live.length > 0);
  document.getElementById("statsBody")?.classList.toggle("hidden", live.length === 0);
  if (live.length === 0) {
    deps.syncRangeControl();
    return;
  }

  deps.refreshRange();
  const range = deps.statsRange();
  const rides = deps.getRides();
  const visible = range ? deps.ridesInRange(rides, range) : rides;
  const hidden = live.length - visible.filter((r) => !r.deleted).length;

  // When the date slider is narrowed below the full span, the totals/records are
  // a filtered subset — flag both section headers so it's never mistaken for the
  // lifetime figure. Empty string (not filtered) hides the flag via :empty.
  const flag = deps.filteredFlag();
  const totalsFlag = document.getElementById("totalsFlag");
  const recordsFlag = document.getElementById("recordsFlag");
  if (totalsFlag) totalsFlag.textContent = flag;
  if (recordsFlag) recordsFlag.textContent = flag;

  const s = computeStats(visible);
  const totals = document.getElementById("statsTotals");
  if (totals) {
    totals.innerHTML = [
      statCard(fmtKm(s.totalKm), "total distance"),
      statCard(fmtDuration(s.totalMovingSec), "moving time"),
      statCard(fmtElevation(s.totalElevationM), "elevation gain"),
      statCard(String(s.rideCount), s.rideCount === 1 ? "ride" : "rides"),
    ].join("");
  }
  const records = document.getElementById("statsRecords");
  if (records) {
    const biggest = s.biggestRide
      ? statCard(
          fmtKm(s.biggestRide.km),
          "biggest ride",
          rideShortLabel(s.biggestRide.key) || s.biggestRide.key,
        )
      : statCard("—", "biggest ride");
    records.innerHTML = [
      biggest,
      periodCard(s.bestDay, "best day"),
      periodCard(s.bestWeek, "best week"),
      periodCard(s.bestMonth, "best month"),
    ].join("");
  }
  deps.syncRangeControl();
  syncHeatControl();
  mountFreqHeatmap(visible, hidden, opts.fit);
}

function syncHeatControl(): void {
  const slider = document.getElementById("heatRadius") as HTMLInputElement | null;
  const out = document.getElementById("heatRadiusOut") as HTMLOutputElement | null;
  const radius = deps.heatRadius();
  if (slider && document.activeElement !== slider) {
    slider.value = String(radius);
  }
  if (out) out.value = String(radius);
}

/** (Re)draw the route-frequency heatmap for the given rides; lazily creates the map. */
function mountFreqHeatmap(rides: RideView[], hidden: number, fit?: boolean): void {
  const host = document.getElementById("freqHeatMap");
  if (!host) return;
  const { tracks, missing } = ridesWithTracks(rides);
  const note = document.getElementById("statsHeatNote");
  if (note) {
    const base = tracks.length
      ? ` ${tracks.length} route${tracks.length === 1 ? "" : "s"}` +
        (missing ? ` · ${missing} without a downloaded route` : "")
      : " no downloaded routes yet — press GPX on a ride in Explore";
    note.textContent = base + (hidden ? ` · ${hidden} hidden by the date filter` : "");
  }

  if (!freqHeatMap) {
    freqHeatMap = createInteractiveMap(host);
    // Heat-point spacing is geographic but the glow radius is in pixels, so zooming
    // in spreads the points until they bead. Rebuild after each pan/zoom so spacing
    // re-adapts and only the visible slice is densified (moveend covers both).
    freqHeatMap.on("moveend", () => redrawFreqHeatmap());
    heatAreaSelect.attach();
  }

  const radius = deps.heatRadius();
  const blur = radius + 2;
  const dataSig = tracks.map((t) => t.key).join("|");
  if (dataSig !== lastHeatDataSig) {
    lastHeatDataSig = dataSig;
    lastHeatTracks = tracks;
    const all = tracks.flatMap((t) => t.points) as L.LatLngExpression[];
    // Frame first so the layer (and its cache key) reflect the final viewport; the
    // moveend fitBounds fires then finds the sig unchanged and skips a rebuild.
    // Frame only when explicitly asked (fit:true) or on the first draw (fit
    // undefined, not yet framed) — a background data update refreshes the heat
    // layer but leaves the user's pan/zoom alone.
    const shouldFit = fit === true || (fit === undefined && !heatFitted);
    if (all.length && shouldFit) {
      freqHeatMap.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
      heatFitted = true;
    }
    lastHeatSig = freqHeatSig(tracks);
    buildFreqHeatLayer();
  } else if (freqHeatLayer) {
    // Track set unchanged — a thickness tweak only needs the layer's radius/blur
    // updated in place, avoiding a full point rebuild or a bounds re-fit.
    (freqHeatLayer as L.HeatLayer).setOptions({ radius, blur });
  }
  // The container is only correctly sized once its view becomes visible.
  setTimeout(() => freqHeatMap!.invalidateSize(), 0);
  // Re-render the selection list, pruning any rides whose track is no longer drawn.
  renderHeatMatched();
}
