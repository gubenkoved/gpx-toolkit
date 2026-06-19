/**
 * GPX Toolkit — Map view (`#mapView`).
 *
 * One interactive Leaflet map draws every downloaded track as a translucent line, so
 * stretches ridden often stack up brighter. Clicking a track selects the nearest ride;
 * the "Select area" toggle drags a rectangle to select every ride crossing it in one
 * shot (cheap even at thousands of tracks, unlike a per-frame hover scan). Selected
 * rides are highlighted and listed in the side panel, where clicking one opens it in
 * the Explore view. Only rides with a downloaded route can be drawn; the side panel
 * still lists the rest, flagged, so nothing is silently hidden.
 *
 * Self-contained behind a `MapViewDeps` seam — the shared date-range control, the live
 * ride list and the canonical "Selected" card renderer (shared with the Stats heatmap)
 * are injected as lazy closures, the same pattern as the other view modules. The
 * cross-view hop (opening a ride in Explore) stays in `main.ts`; this module only emits
 * the side-panel rows it acts on.
 */

import L from "leaflet";
import { type AreaSelect, createAreaSelect } from "./areaselect";
import type { RideView } from "./controller";
import { createLocate, type Locate } from "./locate";
import { CLICK_PX, createInteractiveMap, HOT_TRACK, makeExpandToggle } from "./map-core";
import { type DateRange, type RideTrack, ridesWithTracks } from "./mapview";
import { compareRideKeysDesc, rideShortLabel } from "./parsing";
import { escHtml } from "./ui";

/** What the view needs from the app (injected once via `initMapView`). */
export interface MapViewDeps {
  /** The live (deleted-included) ride list. */
  getRides(): RideView[];
  /** Filter rides to a date selection (the app's shared range helper). */
  ridesInRange(rides: RideView[], range: DateRange): RideView[];
  /** The current Map date selection, or null for the full span. */
  mapRange(): DateRange | null;
  /** Sync the shared date-range control's bounds for this view. */
  refreshRange(): void;
  /** (Re)mount the shared date-range slider for this view. */
  syncRangeControl(): void;
  /** Render the canonical "Selected" cards block for the given keys (shared with Stats). */
  renderSelectedCards(keys: string[]): string;
  /** Surface a non-fatal error to the user. */
  toast(msg: string, isError?: boolean): void;
}

let deps!: MapViewDeps;

const BASE_TRACK = {
  color: "#ff5a1f",
  weight: 3.5,
  opacity: 0.62,
  lineJoin: "round",
  lineCap: "round",
} as const;

let allRidesMap: L.Map | null = null;
let allRidesLayer: L.LayerGroup | null = null;
// Whether the all-rides map has been framed at least once. Background data updates
// must NOT re-fit (that resets the user's pan/zoom mid-interaction); we frame only
// on the first draw and on an explicit reset/reframe (see mountMapView's `fit`).
let mapFitted = false;
const trackLines = new Map<string, L.Polyline>();
let currentTracks: RideTrack[] = [];
let currentMissing = 0;
let hotKeys: string[] = []; // ride highlighted by hovering its side-panel row (ephemeral)
let selectedKeys: string[] = []; // rides selected by a click or area-drag (persist until next selection)
let lastTrackSig = "";

const sameKeys = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** Wire the view's dependencies. Call once at startup. */
export function initMapView(d: MapViewDeps): void {
  deps = d;
}

/**
 * Repaint track + side-panel emphasis from the current selection and hover sets.
 * Selected rides (from a click or area-drag) stay highlighted; the ride whose
 * side-panel row is hovered is highlighted on top, transiently.
 */
function paintEmphasis(): void {
  const emphasized = new Set<string>([...selectedKeys, ...hotKeys]);
  for (const [key, pl] of trackLines) {
    if (emphasized.has(key)) {
      pl.setStyle(HOT_TRACK);
      pl.bringToFront();
    } else {
      pl.setStyle(BASE_TRACK);
    }
  }
  document.querySelectorAll<HTMLElement>("#mapSide .ms-item").forEach((el) => {
    const k = el.dataset.key;
    el.classList.toggle("hot", !!k && hotKeys.includes(k));
    el.classList.toggle("pinned", !!k && selectedKeys.includes(k));
  });
  const cnt = document.getElementById("msCount");
  if (cnt) cnt.textContent = selectedKeys.length ? `${selectedKeys.length} selected` : "";
}

/** Set the side-panel hover emphasis; selected rides stay highlighted regardless. */
export function setHot(keys: string[]): void {
  if (sameKeys(keys, hotKeys)) return;
  hotKeys = keys;
  paintEmphasis();
}

/** Replace the selection (empty clears it); refresh the side panel. */
export function setSelected(keys: string[]): void {
  selectedKeys = keys;
  refreshMapSide();
}

/** Re-render the side panel for the current tracks and re-apply emphasis. */
function refreshMapSide(): void {
  renderMapSide(currentTracks, currentMissing);
  paintEmphasis();
}

// The Map view's area-select gesture: a box-drag selects every ride crossing it,
// a click selects the nearest one. Selection drives the side panel + track emphasis.
export const mapAreaSelect: AreaSelect = createAreaSelect({
  getMap: () => allRidesMap,
  getTracks: () => currentTracks,
  button: document.getElementById("btnMapSelect"),
  onSelect: (keys) => setSelected(keys),
  clickPx: CLICK_PX,
});

// "Locate me" on the all-rides map: drop a live marker at the device position so the
// user can see where they are against their rides.
export const mapLocate: Locate = createLocate({
  getMap: () => allRidesMap,
  button: document.getElementById("btnMapLocate"),
  onError: (msg) => deps.toast(msg, true),
});

/** Toggle the Map view between inline and full-screen; resize Leaflet to match. */
export const setMapExpanded = makeExpandToggle(
  "map-expanded",
  "btnMapExpand",
  () => allRidesMap,
);

/** Build the side panel: every non-deleted ride, with the ones on the map clickable. */
function renderMapSide(tracks: RideTrack[], missing: number): void {
  const side = document.getElementById("mapSide");
  if (!side) return;
  const haveKeys = new Set(tracks.map((t) => t.key));
  const live = deps.getRides().filter((r) => !r.deleted);
  const range = deps.mapRange();
  const inRange = range ? deps.ridesInRange(live, range) : live;
  const hidden = live.length - inRange.length;
  const rides = inRange.slice().sort((a, b) => compareRideKeysDesc(a.key, b.key));
  if (live.length === 0) {
    side.innerHTML =
      `<div class="ms-empty">No rides on the map yet. ` +
      `<button type="button" class="linkbtn" data-act="open-sources">Connect a source</button> ` +
      `to fill your library, then your routes show up here.</div>`;
    return;
  }
  const items = rides
    .map((r) => {
      const when = escHtml(rideShortLabel(r.key) || r.key);
      const name = escHtml((r.title || "Ride") + (r.location || ""));
      if (!haveKeys.has(r.key)) {
        return (
          `<div class="ms-item no-track"><span class="ms-when">${when}</span>` +
          `<span class="ms-name">${name}</span><span class="ms-flag">no route</span></div>`
        );
      }
      return (
        `<div class="ms-item" data-key="${escHtml(r.key)}"><span class="ms-when">${when}</span>` +
        `<span class="ms-name">${name}</span></div>`
      );
    })
    .join("");
  const sub = missing
    ? `${tracks.length} on map · ${missing} without a route`
    : `${tracks.length} on map`;
  const hiddenNote = hidden
    ? `<div class="ms-hidden">${hidden} hidden by the date filter</div>`
    : "";
  side.innerHTML =
    `<div class="ms-head"><h2>All rides</h2><span class="ms-count" id="msCount"></span></div>` +
    deps.renderSelectedCards(selectedKeys) +
    `<div class="ms-sub">${sub}</div>${hiddenNote}<div class="ms-list">${items}</div>`;
}

/** (Re)draw the all-rides map for the current state; lazily creates the map. */
export function mountMapView(opts: { fit?: boolean } = {}): void {
  const host = document.getElementById("allRidesMap");
  if (!host) return;
  deps.refreshRange();
  const range = deps.mapRange();
  const rides = deps.getRides();
  const visible = range ? deps.ridesInRange(rides, range) : rides;
  const { tracks, missing } = ridesWithTracks(visible);
  currentTracks = tracks;
  currentMissing = missing;

  if (!allRidesMap) {
    // preferCanvas: render every track onto one <canvas> instead of one SVG <path>
    // per ride — at thousands of overlapping tracks the SVG DOM is the bottleneck.
    // The translucent strokes still blend on canvas, so the "ridden more = brighter"
    // look is preserved and pan/zoom stays smooth at scale.
    allRidesMap = createInteractiveMap(host, { preferCanvas: true });
    allRidesLayer = L.layerGroup().addTo(allRidesMap);
    mapAreaSelect.attach();
  }

  const sig = tracks.map((t) => t.key).join("|");
  if (sig !== lastTrackSig) {
    lastTrackSig = sig;
    hotKeys = [];
    allRidesLayer!.clearLayers();
    trackLines.clear();
    const all: L.LatLngExpression[] = [];
    for (const t of tracks) {
      const line = L.polyline(t.points as L.LatLngExpression[], {
        ...BASE_TRACK,
        className: "track-line",
      }).addTo(allRidesLayer!);
      trackLines.set(t.key, line);
      for (const p of t.points) all.push(p as L.LatLngExpression);
    }
    // Drop any selected rides whose track is no longer drawn (e.g. deleted/re-scanned).
    selectedKeys = selectedKeys.filter((k) => trackLines.has(k));
    // Frame the tracks only when explicitly asked (fit:true) or on the first draw
    // (fit undefined, not yet framed). A background data update (fit undefined,
    // already framed) refreshes the lines but leaves the user's pan/zoom alone.
    const shouldFit = opts.fit === true || (opts.fit === undefined && !mapFitted);
    if (all.length && shouldFit) {
      allRidesMap.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
      mapFitted = true;
    }
  }
  renderMapSide(tracks, missing);
  deps.syncRangeControl();
  paintEmphasis();
  // The container is only correctly sized once its view becomes visible.
  setTimeout(() => {
    allRidesMap!.invalidateSize();
  }, 0);
}
