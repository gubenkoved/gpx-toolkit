/**
 * UI entry point — ported from the Python app's `web/index.html` inline script.
 *
 * The render functions and DOM event handling are kept faithful to the original
 * SPA (same `STATE = { rides, jobs, speed }` model, same markup). The only change
 * is the data layer: instead of `fetch('/api/…')` + 1.5s polling, the UI talks to
 * an in-browser `Controller` and re-renders on its change events.
 */

import "./style.css";
import "leaflet/dist/leaflet.css";

import L from "leaflet";

import { DemoAdb } from "./adb/demo";
import { AdbError, type AdbDevice } from "./adb/types";
import { WebUsbAdb } from "./adb/webusb";
import { Controller, type AppState, type RideView } from "./controller";
import { ridesWithTracks, nearestRides, dateRange, filterRidesByRange, type DateRange, type PixelPoint, type ProjectedTrack, type RideTrack } from "./mapview";
import { autoGranularity, bucketRide, compareRideKeysDesc, parseDurationSec, rideShortLabel, trimmedSpeed, type Granularity } from "./parsing";
import { computeStats, type PeriodRecord } from "./stats";
import { buildHeatPoints } from "./heatmap";
import "leaflet.heat";
import { idbBackend, memoryBackend } from "./kv";
import { Store } from "./store";
import { decodePolyline } from "./track";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

// --------------------------------------------------------------------------- //
// Controller wiring (demo by default; "Connect phone" switches to WebUSB)
// --------------------------------------------------------------------------- //

/** Durable ride-cache storage. One IndexedDB connection shared by every controller. */
const storageBackend = idbBackend();
/** Surface a background-write failure (e.g. quota exceeded) to the user. */
const onStorageError = (message: string): void => toast(message, true);

let controller!: Controller;
// Starts false so the first paint matches the offline boot; activate() sets the
// real value once a controller is wired up.
let isDemo = false;
let unsubscribe: (() => void) | null = null;
let unsubscribeGpx: (() => void) | null = null;

// Remember, across visits, that the user chose a real phone (and which one) so we
// can silently reconnect on load using the browser's persisted WebUSB permission.
const MODE_KEY = "beeline_uploader.mode";
const SERIAL_KEY = "beeline_uploader.serial";
const rememberReal = (serial: string): void => {
  try {
    localStorage.setItem(MODE_KEY, "real");
    if (serial) localStorage.setItem(SERIAL_KEY, serial);
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
};
const forgetReal = (): void => {
  try {
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(SERIAL_KEY);
  } catch {
    /* non-fatal */
  }
};
const wantsReal = (): boolean => {
  try {
    return localStorage.getItem(MODE_KEY) === "real";
  } catch {
    return false;
  }
};
const rememberedSerial = (): string | undefined => {
  try {
    return localStorage.getItem(SERIAL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

function activate(next: Controller, demo: boolean): void {
  if (unsubscribe) unsubscribe();
  if (unsubscribeGpx) unsubscribeGpx();
  controller = next;
  isDemo = demo;
  unsubscribe = controller.onChange(applyState);
  unsubscribeGpx = controller.onGpx(saveGpxFile);
  applyState();
}

async function goDemo(): Promise<void> {
  const c = new Controller(async () => new DemoAdb({ latencyMs: 110 }), new Store(memoryBackend()));
  activate(c, true);
  try {
    await c.connect();
    toast("Demo mode — exploring with a simulated phone. Click Exit demo to leave.");
  } catch {
    /* demo connect never fails */
  }
}

/**
 * Offline mode: show the user's real, persisted rides from LocalStorage without a
 * phone. Viewing works; any device action (scan/check/upload/GPX) fails gracefully
 * with "No device connected". This is the default when there's no remembered phone
 * or a remembered phone isn't reachable — we never silently drop into demo anymore.
 */
async function goOffline(): Promise<void> {
  const transport = async (): Promise<AdbDevice> => {
    throw new AdbError("No device connected — click Connect phone first.");
  };
  const c = new Controller(transport, await Store.load(storageBackend, onStorageError));
  activate(c, false);
}

async function goReal(): Promise<void> {
  let serial = "";
  const transport = async (): Promise<AdbDevice> => {
    const device = await WebUsbAdb.connect();
    serial = device.deviceSerial;
    return device;
  };
  const c = new Controller(transport, await Store.load(storageBackend, onStorageError));
  activate(c, false);
  try {
    await c.connect();
    rememberReal(serial);
    toast(`Connected: ${controller.state().device}`);
  } catch (err) {
    toast(err instanceof AdbError ? err.message : String(err), true);
    void goOffline(); // keep the app usable, showing stored rides
  }
}

/**
 * Silently re-establish a previously-authorized phone on load (no prompt, no error
 * toasts). Falls back to demo mode if the device isn't currently reachable.
 */
async function tryAutoReconnect(): Promise<void> {
  let serial = "";
  const transport = async (): Promise<AdbDevice> => {
    const reconnected = await WebUsbAdb.tryReconnect(rememberedSerial());
    if (!reconnected) throw new AdbError("remembered device not available");
    serial = reconnected.deviceSerial;
    return reconnected;
  };
  const c = new Controller(transport, await Store.load(storageBackend, onStorageError));
  activate(c, false);
  try {
    await c.connect();
    rememberReal(serial);
    toast(`Reconnected: ${controller.state().device}`);
  } catch {
    // Device not plugged in / not authorized this session — show stored rides offline.
    void goOffline();
  }
}

async function leaveReal(): Promise<void> {
  forgetReal(); // stop auto-reconnecting on future loads
  await goOffline(); // keep showing the user's stored rides, just without a phone
}


// --------------------------------------------------------------------------- //
// UI state
// --------------------------------------------------------------------------- //
let STATE: AppState = {
  rides: [],
  jobs: { current: null, current_keys: [], queue: [], history: [], active_keys: [], busy: false },
  speed: "normal",
  settings: { trackPointsPerKm: 10, speedTrimSlowPct: 0, speedTrimFastPct: 0 },
  connected: false,
  device: "",
};
let ACTIVE = new Set<string>(); // keys queued or running
let RUNNING = new Set<string>(); // keys in the currently running task
const selected = new Set<string>();
const openMonths = new Set<string>();
const openYears = new Set<string>();
const openStats = new Set<string>();
// Which GPX split-button menu is open, if any: a ride key for a per-ride button or
// "sel" for the selection toolbar. Kept at module scope (like openStats/selected) so
// it survives the frequent re-renders the job ticker triggers.
let openMenu: string | null = null;
// Whether the queue panel's "Up next" list is expanded. Module-scope so it
// survives the frequent re-renders the job ticker triggers; starts open so the
// pending work is visible by default.
let queueExpanded = true;
// Whether the user has minimized the live job pill to its small handle. Module-
// scope so it survives the job ticker's re-renders; auto-resets when work ends so
// the next batch shows itself rather than staying hidden silently.
let jobHidden = false;
let preset = "month";
let statGran: Granularity | "auto" = "auto";
let statMetric: "distance" | "speed" = "distance";
let dismissedErrId = 0;
let lastErrShownId = 0;
let lastSig = "";

const yearOf = (mkey: string): string => (mkey || "").slice(0, 4);
function setChecked(el: HTMLInputElement | null, on: boolean | null): void {
  if (el) el.indeterminate = on === null;
}
function esc(s: string): string {
  return (s || "").replace(/[^a-zA-Z0-9]/g, "_");
}
/** Escape text/attribute values for safe interpolation into innerHTML. */
function escHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --------------------------------------------------------------------------- //
// Top-level view ("Explore" = the rides list/stats; "Map" = all-rides heatmap).
// Remembered across reloads; defaults to Explore on first run.
// --------------------------------------------------------------------------- //
type ViewName = "explore" | "map" | "stats";
const VIEW_KEY = "beeline_uploader.view";
const readView = (): ViewName => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "map" || v === "stats" ? v : "explore";
  } catch {
    return "explore";
  }
};
let activeView: ViewName = readView();

// --------------------------------------------------------------------------- //
// Rough-track mini-map (Leaflet). The stored track is a heavily simplified
// polyline — an APPROXIMATION of the route, never the full GPX.
// --------------------------------------------------------------------------- //
const mapRegistry = new Map<string, L.Map>();

/** Markup for a ride's mini-map + its "rough approximation" caption. */
function trackBlock(key: string, track: string): string {
  if (!track) {
    // Details are open but we have no route yet — point the user at the GPX button.
    return `<div class="rmaphint">No map yet — press <b>GPX</b> to download this ride and draw a rough route.</div>`;
  }
  return (
    `<div class="rmap" data-map="${esc(key)}" data-track="${esc(key)}"></div>` +
    `<div class="rmapnote">Rough approximation only — not the full GPX.</div>`
  );
}

/**
 * Expanded-details body for an open ride. When a ride has never been Checked its
 * `stats` are empty, so instead of an empty bordered grid we show a clear prompt
 * telling the user to press Check.
 */
function detailsBlock(key: string, stats: Record<string, string> | undefined, track: string): string {
  const hasStats = !!stats && Object.keys(stats).length > 0;
  if (!hasStats) {
    const checking = RUNNING.has(key) || ACTIVE.has(key);
    const msg = checking
      ? `Checking… loading this ride's stats and route.`
      : `No details yet — press <b>Check</b> to load this ride's stats and route.`;
    return `<div class="rdetailhint">${msg}</div>`;
  }
  return `<div class="stats open" id="st-${esc(key)}">${fmtStats(stats)}</div>` + trackBlock(key, track);
}

/** (Re)create Leaflet maps for every visible track container after a render. */
function mountMaps(): void {
  // Tear down any maps whose container no longer exists (collapsed/replaced DOM).
  for (const [k, map] of mapRegistry) {
    if (!document.body.contains(map.getContainer())) {
      map.remove();
      mapRegistry.delete(k);
    }
  }
  document.querySelectorAll<HTMLElement>(".rmap").forEach((host) => {
    if (mapRegistry.has(host.dataset.map!) && mapRegistry.get(host.dataset.map!)!.getContainer() === host) {
      return; // already mounted on this exact node
    }
    const ride = STATE.rides.find((r) => esc(r.key) === host.dataset.map);
    if (!ride || !ride.track) return;
    let pts: [number, number][];
    try {
      pts = decodePolyline(ride.track);
    } catch {
      return;
    }
    if (pts.length < 2) return;
    const map = L.map(host, {
      attributionControl: true,
      zoomControl: false,
      fadeAnimation: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
      className: "rmap-tiles",
    }).addTo(map);
    // White casing underneath + colored line on top so the track stays legible
    // over OSM's own orange/red roads and POIs.
    L.polyline(pts, { color: "#ffffff", weight: 6, opacity: 0.9 }).addTo(map);
    const line = L.polyline(pts, { color: "#fc5200", weight: 3 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [12, 12] });
    // The container was sized by CSS only after insertion; nudge Leaflet to re-measure.
    setTimeout(() => map.invalidateSize(), 0);
    mapRegistry.set(host.dataset.map!, map);
  });
}

// --------------------------------------------------------------------------- //
// All-rides heatmap ("Map" view). One interactive Leaflet map draws every
// downloaded track as a translucent line, so stretches you ride often stack up
// brighter. Hovering a track (or an area where several overlap) highlights the
// matching rides and lists them in the side panel; clicking jumps to that ride's
// details in the Explore view. Only rides with a downloaded route can be drawn;
// the side panel still lists the rest, flagged, so nothing is silently hidden.
// --------------------------------------------------------------------------- //
const HOVER_PX = 8; // how close (in screen px) the cursor must be to "hit" a track
const BASE_TRACK = { color: "#ff5a1f", weight: 3.5, opacity: 0.62, lineJoin: "round", lineCap: "round" } as const;
const HOT_TRACK = { color: "#ffe066", weight: 6, opacity: 1 } as const;

let allRidesMap: L.Map | null = null;
let allRidesLayer: L.LayerGroup | null = null;
const trackLines = new Map<string, L.Polyline>();
let currentTracks: RideTrack[] = [];
let currentMissing = 0;
let projectedTracks: ProjectedTrack[] = [];
let hotKeys: string[] = []; // rides under the cursor right now (ephemeral)
let pinnedKeys: string[] = []; // rides matched by the last click (persist until next click)
let lastCursor: PixelPoint | null = null;
let hoverRaf = 0;
let lastTrackSig = "";

const sameKeys = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

// --------------------------------------------------------------------------- //
// Time-range filter shared by the Map and Stats views. Each view has its own,
// independent dual-handle date slider (so narrowing the map doesn't move the
// stats range and vice-versa). The selection is SESSION-ONLY — it resets to the
// full span on reload — so we just hold it in module state, never persisted.
//   *Bounds* = the full day-snapped span of all dated rides (slider min/max).
//   *Range*  = the user's current selection within those bounds.
// Rides with an unparseable date are never hidden (see filterRidesByRange).
// --------------------------------------------------------------------------- //
type RangeView = "map" | "stats";
const DAY_MS = 86_400_000;
// Selection is stored as day-start timestamps (local 00:00) for both edges; the
// slider works in whole-day INDICES (0…N) so stepping is exact and DST-safe, and
// the "to" edge always covers its whole day when filtering (see ridesInRange).
let mapRange: DateRange | null = null;
let mapRangeBounds: DateRange | null = null;
let statsRange: DateRange | null = null;
let statsRangeBounds: DateRange | null = null;

const startOfDayMs = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const endOfDayMs = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
/** Local midnight `n` days after `ms` — uses the calendar, so it's DST-safe. */
const addDays = (ms: number, n: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
/** Number of whole days spanned by the bounds (slider max index). */
const dayCount = (bounds: DateRange): number =>
  Math.round((startOfDayMs(bounds.maxMs) - startOfDayMs(bounds.minMs)) / DAY_MS);
/** Whole-day index (0-based) of a timestamp within the bounds. */
const dayIndex = (bounds: DateRange, ms: number): number =>
  Math.round((startOfDayMs(ms) - startOfDayMs(bounds.minMs)) / DAY_MS);

/** The full selection (both edges at day-start) covering an entire bounds span. */
const fullRange = (bounds: DateRange): DateRange => ({ minMs: startOfDayMs(bounds.minMs), maxMs: startOfDayMs(bounds.maxMs) });

/** Keep only rides within a day-granular selection (the end day is fully included). */
const ridesInRange = (rides: RideView[], sel: DateRange): RideView[] =>
  filterRidesByRange(rides, sel.minMs, endOfDayMs(sel.maxMs));

/**
 * Reconcile a remembered selection with a freshly computed full span. First time
 * (no prior selection) the slider spans everything. Afterwards, a handle that sat
 * exactly on an old extreme is kept pinned to the new extreme (so newly-scanned
 * rides extend the visible window instead of being filtered out); any other handle
 * is just clamped into the new bounds. Edges are kept on day-start boundaries.
 */
function reconcileRange(sel: DateRange | null, oldBounds: DateRange | null, bounds: DateRange): DateRange {
  const lo = startOfDayMs(bounds.minMs);
  const hi = startOfDayMs(bounds.maxMs);
  if (!sel || !oldBounds) return { minMs: lo, maxMs: hi };
  const oldHi = startOfDayMs(oldBounds.maxMs);
  let from = sel.minMs <= startOfDayMs(oldBounds.minMs) ? lo : startOfDayMs(sel.minMs);
  let to = sel.maxMs >= oldHi ? hi : startOfDayMs(sel.maxMs);
  from = Math.min(Math.max(from, lo), hi);
  to = Math.min(Math.max(to, lo), hi);
  if (from > to) return { minMs: lo, maxMs: hi };
  return { minMs: from, maxMs: to };
}

/** Recompute a view's bounds from the current rides and reconcile its selection. */
function refreshRange(which: RangeView): void {
  const bounds = dateRange(STATE.rides);
  if (which === "map") {
    mapRange = bounds ? reconcileRange(mapRange, mapRangeBounds, bounds) : null;
    mapRangeBounds = bounds;
  } else {
    statsRange = bounds ? reconcileRange(statsRange, statsRangeBounds, bounds) : null;
    statsRangeBounds = bounds;
  }
}

const rangeOf = (which: RangeView): DateRange | null => (which === "map" ? mapRange : statsRange);
const boundsOf = (which: RangeView): DateRange | null => (which === "map" ? mapRangeBounds : statsRangeBounds);

/** Compact local day label for a slider edge, e.g. "Jun 1, 2026". */
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Markup for one view's dual-range date slider (two overlaid day-index inputs). */
function rangeControlHtml(which: RangeView, bounds: DateRange, sel: DateRange): string {
  const n = dayCount(bounds);
  const dis = n <= 0 ? " disabled" : ""; // single day → nothing to slide
  const input = (edge: "lo" | "hi", idx: number): string =>
    `<input type="range" class="rf-${edge}" id="${which}${edge === "lo" ? "Lo" : "Hi"}" ` +
    `data-range="${which}" data-edge="${edge}" min="0" max="${n}" step="1" value="${idx}"${dis} ` +
    `aria-label="${edge === "lo" ? "Earliest" : "Latest"} date">`;
  return (
    `<span class="rf-edge" id="${which}From"></span>` +
    `<div class="rf-track">${input("lo", dayIndex(bounds, sel.minMs))}${input("hi", dayIndex(bounds, sel.maxMs))}</div>` +
    `<span class="rf-edge" id="${which}To"></span>` +
    `<button class="rf-reset" data-rangereset="${which}" title="Show every date">All</button>`
  );
}

/** Refresh the edge date labels and the accent range-fill for a view. */
function updateRangeLabels(which: RangeView): void {
  const sel = rangeOf(which);
  const bounds = boundsOf(which);
  if (!sel) return;
  const from = document.getElementById(`${which}From`);
  const to = document.getElementById(`${which}To`);
  if (from) from.textContent = fmtDay(sel.minMs);
  if (to) to.textContent = fmtDay(sel.maxMs);
  // Paint the selected span: percentages of the day axis drive the track ::after.
  const host = document.getElementById(which === "map" ? "mapFilter" : "statsFilter");
  const track = host?.querySelector<HTMLElement>(".rf-track");
  if (track && bounds) {
    const n = dayCount(bounds);
    const lo = n > 0 ? dayIndex(bounds, sel.minMs) / n : 0;
    const hi = n > 0 ? dayIndex(bounds, sel.maxMs) / n : 1;
    track.style.setProperty("--rf-lo", String(lo));
    track.style.setProperty("--rf-hi", String(hi));
    track.classList.toggle("rf-empty", n <= 0); // single day → nothing to fill
  }
}

/**
 * Reflect a view's range state in its slider control. The slider DOM is only
 * rebuilt when the underlying span changes (tracked via `data-bounds`), never
 * mid-drag — so dragging a handle just updates values + labels in place.
 */
function syncRangeControl(which: RangeView): void {
  const host = document.getElementById(which === "map" ? "mapFilter" : "statsFilter");
  if (!host) return;
  const bounds = boundsOf(which);
  const sel = rangeOf(which);
  if (!bounds || !sel) {
    host.classList.add("hidden");
    host.innerHTML = "";
    host.dataset.bounds = "";
    return;
  }
  host.classList.remove("hidden");
  const boundsKey = `${bounds.minMs}-${bounds.maxMs}`;
  if (host.dataset.bounds !== boundsKey) {
    host.dataset.bounds = boundsKey;
    host.innerHTML = rangeControlHtml(which, bounds, sel);
  } else {
    const lo = document.getElementById(`${which}Lo`) as HTMLInputElement | null;
    const hi = document.getElementById(`${which}Hi`) as HTMLInputElement | null;
    if (lo) lo.value = String(dayIndex(bounds, sel.minMs));
    if (hi) hi.value = String(dayIndex(bounds, sel.maxMs));
  }
  updateRangeLabels(which);
}

/** Live drag of either handle: clamp so from ≤ to, store, relabel, redraw (no refit). */
function onRangeInput(which: RangeView, el: HTMLInputElement): void {
  const bounds = boundsOf(which);
  if (!bounds) return;
  const lo = document.getElementById(`${which}Lo`) as HTMLInputElement | null;
  const hi = document.getElementById(`${which}Hi`) as HTMLInputElement | null;
  if (!lo || !hi) return;
  let loIdx = Number(lo.value);
  let hiIdx = Number(hi.value);
  if (el.dataset.edge === "lo" && loIdx > hiIdx) {
    loIdx = hiIdx;
    lo.value = String(loIdx);
  } else if (el.dataset.edge === "hi" && hiIdx < loIdx) {
    hiIdx = loIdx;
    hi.value = String(hiIdx);
  }
  const next: DateRange = { minMs: addDays(bounds.minMs, loIdx), maxMs: addDays(bounds.minMs, hiIdx) };
  if (which === "map") mapRange = next;
  else statsRange = next;
  updateRangeLabels(which);
  if (which === "map") mountAllRidesMap({ fit: false });
  else mountStatsView({ fit: false });
}

/** Reset a view's selection back to its full span and re-frame the map. */
function resetRange(which: RangeView): void {
  const bounds = boundsOf(which);
  if (!bounds) return;
  if (which === "map") {
    mapRange = fullRange(bounds);
    mountAllRidesMap({ fit: true });
  } else {
    statsRange = fullRange(bounds);
    mountStatsView({ fit: true });
  }
}


/** Recompute each track's pixel polyline for the current map view (for hit-testing). */
function reprojectTracks(): void {
  if (!allRidesMap) return;
  projectedTracks = currentTracks.map((t) => ({
    key: t.key,
    pts: t.points.map(([lat, lon]) => {
      const p = allRidesMap!.latLngToContainerPoint([lat, lon]);
      return { x: p.x, y: p.y };
    }),
  }));
}

/**
 * Repaint track + side-panel emphasis from the current hover and pinned sets.
 * Pinned rides (matched by the last click) stay highlighted even with no cursor;
 * hovered rides are highlighted on top, transiently.
 */
function paintEmphasis(): void {
  const emphasized = new Set<string>([...pinnedKeys, ...hotKeys]);
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
    el.classList.toggle("pinned", !!k && pinnedKeys.includes(k));
  });
  const cnt = document.getElementById("msCount");
  if (cnt) cnt.textContent = hotKeys.length ? `${hotKeys.length} under cursor` : "";
  const host = allRidesMap?.getContainer();
  if (host) host.style.cursor = hotKeys.length ? "pointer" : "";
}

/** Set the hover (cursor) emphasis; pinned rides stay highlighted regardless. */
function setHot(keys: string[]): void {
  if (sameKeys(keys, hotKeys)) return;
  hotKeys = keys;
  paintEmphasis();
}

/** Pin the rides matched by a click (empty clears the pin); refresh the side panel. */
function setPinned(keys: string[]): void {
  pinnedKeys = keys;
  refreshMapSide();
}

/** Re-render the side panel for the current tracks and re-apply emphasis. */
function refreshMapSide(): void {
  renderMapSide(currentTracks, currentMissing);
  paintEmphasis();
}

function onMapMove(e: L.LeafletMouseEvent): void {
  lastCursor = { x: e.containerPoint.x, y: e.containerPoint.y };
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    if (lastCursor) setHot(nearestRides(projectedTracks, lastCursor, HOVER_PX));
  });
}

function onMapClick(e: L.LeafletMouseEvent): void {
  const keys = nearestRides(projectedTracks, { x: e.containerPoint.x, y: e.containerPoint.y }, HOVER_PX);
  // First click pins the matched ride(s) into the side panel (keeping map context);
  // a second click on a matched entry opens it in Explore. A miss clears the pin.
  setPinned(keys);
}

/** Switch to the Explore view and reveal a specific ride's details. */
function openRideInExplore(key: string): void {
  const ride = STATE.rides.find((r) => r.key === key);
  if (!ride) return;
  openYears.delete("c" + yearOf(ride.month_key)); // a year is open when NOT collapsed
  openMonths.add(ride.month_key);
  openStats.add(key);
  setView("explore");
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll<HTMLElement>(".rrow")) {
      if (el.dataset.key === key) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      }
    }
  });
}

/** Compact distance label for a ride: prefer the measured route length, fall back to the summary. */
function rideKmText(r: RideView): string {
  if (r.track_km > 0) return fmtKm(r.track_km);
  const km = parseKm((r.stats && r.stats["Distance"]) || r.distance || "");
  return km > 0 ? fmtKm(km) : "—";
}

/** Average-speed label for a ride, as reported by Beeline (em dash when unknown). */
function rideSpeedText(r: RideView): string {
  return (r.stats && r.stats["Average speed"]) || "—";
}

/** Build the side panel: every non-deleted ride, with the ones on the map clickable. */
function renderMapSide(tracks: RideTrack[], missing: number): void {
  const side = document.getElementById("mapSide");
  if (!side) return;
  const haveKeys = new Set(tracks.map((t) => t.key));
  const live = STATE.rides.filter((r) => !r.deleted);
  const inRange = mapRange ? ridesInRange(live, mapRange) : live;
  const hidden = live.length - inRange.length;
  const rides = inRange.slice().sort((a, b) => compareRideKeysDesc(a.key, b.key));
  if (live.length === 0) {
    side.innerHTML =
      `<div class="ms-empty">No rides yet. Press <b>Scan</b> in the Explore tab to read your phone, ` +
      `then <b>GPX</b> on a ride to download its route and see it here.</div>`;
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
    ? `${tracks.length} on map · ${missing} without a route — press <b>GPX</b> to add them`
    : `${tracks.length} on map`;
  const hiddenNote = hidden ? `<div class="ms-hidden">${hidden} hidden by the date filter</div>` : "";
  side.innerHTML =
    `<div class="ms-head"><h2>All rides</h2><span class="ms-count" id="msCount"></span></div>` +
    renderMatched() +
    `<div class="ms-sub">${sub}</div>${hiddenNote}<div class="ms-list">${items}</div>`;
}

/**
 * The "Matched" block: rides hit by the last click on the map, each with quick stats
 * (date · distance · avg speed). Clicking an entry opens it in the Explore view.
 */
function renderMatched(): string {
  if (!pinnedKeys.length) return "";
  const matched = pinnedKeys
    .map((k) => STATE.rides.find((r) => r.key === k && !r.deleted))
    .filter((r): r is RideView => !!r);
  if (!matched.length) return "";
  const cards = matched
    .map((r) => {
      const when = escHtml(rideShortLabel(r.key) || r.key);
      const name = escHtml((r.title || "Ride") + (r.location || ""));
      const km = escHtml(rideKmText(r));
      const spd = escHtml(rideSpeedText(r));
      return (
        `<div class="ms-item matched" data-key="${escHtml(r.key)}">` +
        `<div class="ms-line"><span class="ms-when">${when}</span><span class="ms-name">${name}</span></div>` +
        `<div class="ms-stats"><span>${km}</span><span>${spd}</span></div>` +
        `</div>`
      );
    })
    .join("");
  const noun = matched.length === 1 ? "ride" : "rides";
  return (
    `<div class="ms-matched">` +
    `<div class="ms-mhead"><h3>Matched · ${matched.length} ${noun}</h3>` +
    `<button class="ms-clear" id="msClear" title="Clear the selection">Clear</button></div>` +
    `<div class="ms-mhint">Click a ride below to open it in Explore.</div>` +
    `<div class="ms-list">${cards}</div></div>`
  );
}


/** (Re)draw the all-rides map for the current state; lazily creates the map. */
function mountAllRidesMap(opts: { fit?: boolean } = {}): void {
  const host = document.getElementById("allRidesMap");
  if (!host) return;
  refreshRange("map");
  const visible = mapRange ? ridesInRange(STATE.rides, mapRange) : STATE.rides;
  const { tracks, missing } = ridesWithTracks(visible);
  currentTracks = tracks;
  currentMissing = missing;

  if (!allRidesMap) {
    allRidesMap = L.map(host, { attributionControl: true, zoomControl: true, fadeAnimation: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
      className: "map-tiles",
    }).addTo(allRidesMap);
    allRidesLayer = L.layerGroup().addTo(allRidesMap);
    allRidesMap.setView([20, 0], 2); // sane default until the first track is drawn
    allRidesMap.on("mousemove", onMapMove);
    allRidesMap.on("mouseout", () => setHot([]));
    allRidesMap.on("click", onMapClick);
    allRidesMap.on("moveend zoomend", reprojectTracks);
  }

  const sig = tracks.map((t) => t.key).join("|");
  if (sig !== lastTrackSig) {
    lastTrackSig = sig;
    hotKeys = [];
    allRidesLayer!.clearLayers();
    trackLines.clear();
    const all: L.LatLngExpression[] = [];
    for (const t of tracks) {
      const line = L.polyline(t.points as L.LatLngExpression[], { ...BASE_TRACK, className: "track-line" }).addTo(allRidesLayer!);
      trackLines.set(t.key, line);
      for (const p of t.points) all.push(p as L.LatLngExpression);
    }
    // Drop any pinned rides whose track is no longer drawn (e.g. deleted/re-scanned).
    pinnedKeys = pinnedKeys.filter((k) => trackLines.has(k));
    if (all.length && opts.fit !== false) allRidesMap.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
  }
  renderMapSide(tracks, missing);
  syncRangeControl("map");
  paintEmphasis();
  // The container is only correctly sized once its view becomes visible.
  setTimeout(() => {
    allRidesMap!.invalidateSize();
    reprojectTracks();
  }, 0);
}

/** Reflect the active view in the DOM (visibility, tab state, scan bar). */
function applyView(): void {
  const isMap = activeView === "map";
  const isStats = activeView === "stats";
  document.getElementById("exploreView")?.classList.toggle("hidden", isMap || isStats);
  document.getElementById("mapView")?.classList.toggle("hidden", !isMap);
  document.getElementById("statsView")?.classList.toggle("hidden", !isStats);
  document.getElementById("scanbar")?.classList.toggle("hidden", isMap || isStats);
  if (!isMap && document.body.classList.contains("map-expanded")) setMapExpanded(false);
  document
    .querySelectorAll<HTMLButtonElement>("#viewTabs .vtab")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === activeView));
}

/** Switch the active view, persist the choice, and re-render. */
function setView(v: ViewName): void {
  if (v === activeView) return;
  activeView = v;
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
  applyView();
  render();
}

/** Toggle the Map view between inline and full-screen; resize Leaflet to match. */
function setMapExpanded(on: boolean): void {
  document.body.classList.toggle("map-expanded", on);
  const btn = document.getElementById("btnMapExpand");
  if (btn) btn.textContent = on ? "⤡ Exit full screen" : "⤢ Expand";
  // The container changed size; let Leaflet re-measure and re-fit the hit-test grid.
  requestAnimationFrame(() => {
    allRidesMap?.invalidateSize();
    reprojectTracks();
  });
}


// --------------------------------------------------------------------------- //
// Stats view — lifetime totals, distance records and a route-frequency heatmap.
// Totals/records come from the cheap per-ride scalars (computeStats); the heatmap
// resamples every track to evenly-spaced points so often-ridden corridors glow
// far brighter than the Map view's translucent line stacking ever could.
// --------------------------------------------------------------------------- //
let freqHeatMap: L.Map | null = null;
let freqHeatLayer: L.Layer | null = null;
let lastHeatSig = "";

/** Whole hours-and-minutes label for a duration, e.g. "12h 30m" or "45m". */
function fmtDuration(totalSec: number): string {
  const mins = Math.round(totalSec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Compact metres/kilometres label for an elevation total. */
function fmtElevation(m: number): string {
  return m >= 1000 ? (m / 1000).toFixed(1) + "k m" : Math.round(m) + " m";
}

/** One totals/record card: a big value, a label, and an optional sub-line. */
function statCard(value: string, label: string, sub = ""): string {
  const subHtml = sub ? `<span class="sc-sub">${escHtml(sub)}</span>` : "";
  return (
    `<div class="stat-card"><b class="sc-val">${escHtml(value)}</b>` +
    `<span class="sc-label">${escHtml(label)}</span>${subHtml}</div>`
  );
}

/** Record card for a best period (muted placeholder when there's no data). */
function periodCard(rec: PeriodRecord | null, label: string): string {
  if (!rec) return statCard("—", label);
  return statCard(fmtKm(rec.km), label, `${rec.label} · ${rec.count} ride${rec.count === 1 ? "" : "s"}`);
}

/** Render the Stats view: totals, records and the route-frequency heatmap. */
function mountStatsView(opts: { fit?: boolean } = {}): void {
  const live = STATE.rides.filter((r) => !r.deleted);
  document.getElementById("statsEmpty")?.classList.toggle("hidden", live.length > 0);
  document.getElementById("statsBody")?.classList.toggle("hidden", live.length === 0);
  if (live.length === 0) {
    syncRangeControl("stats");
    return;
  }

  refreshRange("stats");
  const visible = statsRange ? ridesInRange(STATE.rides, statsRange) : STATE.rides;
  const hidden = live.length - visible.filter((r) => !r.deleted).length;

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
      ? statCard(fmtKm(s.biggestRide.km), "biggest ride", rideShortLabel(s.biggestRide.key) || s.biggestRide.key)
      : statCard("—", "biggest ride");
    records.innerHTML = [
      biggest,
      periodCard(s.bestDay, "best day"),
      periodCard(s.bestWeek, "best week"),
      periodCard(s.bestMonth, "best month"),
    ].join("");
  }
  syncRangeControl("stats");
  mountFreqHeatmap(visible, hidden, opts.fit !== false);
}

/** (Re)draw the route-frequency heatmap for the given rides; lazily creates the map. */
function mountFreqHeatmap(rides: RideView[], hidden: number, fit: boolean): void {
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
    freqHeatMap = L.map(host, { attributionControl: true, zoomControl: true, fadeAnimation: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
      className: "map-tiles",
    }).addTo(freqHeatMap);
    freqHeatMap.setView([20, 0], 2); // sane default until the first track is drawn
  }

  const sig = tracks.map((t) => t.key).join("|");
  if (sig !== lastHeatSig) {
    lastHeatSig = sig;
    if (freqHeatLayer) {
      freqHeatMap.removeLayer(freqHeatLayer);
      freqHeatLayer = null;
    }
    const pts = buildHeatPoints(tracks);
    if (pts.length) {
      freqHeatLayer = L.heatLayer(pts as [number, number, number][], {
        radius: 12,
        blur: 14,
        minOpacity: 0.25,
        gradient: { 0.0: "#1e3a8a", 0.4: "#22d3ee", 0.7: "#facc15", 1.0: "#f97316" },
      }).addTo(freqHeatMap);
      const all = tracks.flatMap((t) => t.points) as L.LatLngExpression[];
      if (all.length && fit) freqHeatMap.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
    }
  }
  // The container is only correctly sized once its view becomes visible.
  setTimeout(() => freqHeatMap!.invalidateSize(), 0);
}


// --------------------------------------------------------------------------- //
// Small render helpers (ported verbatim)
// --------------------------------------------------------------------------- //
function badge(s: string): string {
  const label =
    ({ pending: "upload pending", uploaded: "uploaded", processing: "working", unknown: "\u2014" } as Record<string, string>)[
      s
    ] || s;
  return `<span class="badge ${s}">${label}</span>`;
}
function queueBadge(key: string): string {
  if (RUNNING.has(key)) return `<span class="badge working">working</span>`;
  if (ACTIVE.has(key)) return `<span class="badge queued">queued</span>`;
  return "";
}
function deletedBadge(): string {
  return `<span class="badge deleted" title="This ride is no longer on your phone — it was deleted in the Beeline app.">deleted</span>`;
}
/** Marks a ride whose rough route preview is already downloaded and ready to draw. */
function gpsBadge(): string {
  return `<span class="badge gps" title="Route preview available — expand details to see the map.">gps</span>`;
}
/**
 * GPX split button: a primary "Preview" action (download a rough route, no file) plus
 * a caret that reveals the secondary "Save .gpx file" action. `scope` identifies which
 * menu is open (a ride key, or "sel" for the selection toolbar); `key` is forwarded on
 * the per-ride actions so the click handler knows which ride to act on.
 */
function gpxSplit(scope: string, key: string): string {
  const open = openMenu === scope;
  const dataKey = key ? ` data-key="${key}"` : "";
  return (
    `<span class="split${open ? " open" : ""}">` +
    `<button class="small ghost" data-act="gpx-one"${dataKey} title="Download a rough route preview (no file saved)">Preview</button>` +
    `<button class="small ghost caret" data-splitmenu="${scope}" aria-haspopup="true" aria-expanded="${open}" title="More GPX options">▾</button>` +
    `<span class="splitmenu"><button class="small ghost" data-act="gpx-save-one"${dataKey} title="Download the full GPX and save it to disk">Save .gpx file</button></span>` +
    `</span>`
  );
}
/**
 * Check split button: a primary "Check new" action (read details only for rides that have
 * never been detailed) plus a caret revealing "Check all" (re-read every ride). `scope`
 * identifies which menu is open; `newAct`/`allAct` are the data-act values and `dataAttr`
 * (e.g. ` data-m="2026-06"`) is forwarded so the handler knows which month/year to act on.
 */
function checkSplit(scope: string, newAct: string, allAct: string, dataAttr: string): string {
  const open = openMenu === scope;
  return (
    `<span class="split${open ? " open" : ""}">` +
    `<button class="small ghost" data-act="${newAct}"${dataAttr} title="Check only rides that have never had their details read">Check new</button>` +
    `<button class="small ghost caret" data-splitmenu="${scope}" aria-haspopup="true" aria-expanded="${open}" title="More check options">▾</button>` +
    `<span class="splitmenu"><button class="small ghost" data-act="${allAct}"${dataAttr} title="Re-check every ride, even ones already detailed">Check all</button></span>` +
    `</span>`
  );
}
function fmtStats(st: Record<string, string> | undefined): string {
  const order = ["Distance", "Average speed", "Max speed", "Moving time", "Elapsed time", "Elevation gain", "Elevation loss"];
  return order
    .filter((k) => st && st[k] != null)
    .map((k) => `<div>${k}<br><b>${st![k]}</b></div>`)
    .join("");
}
function bars(up: number, pe: number, total: number): string {
  if (!total) return "";
  const u = Math.round((up / total) * 100);
  const p = Math.round((pe / total) * 100);
  return `<span class="bars"><i class="up" style="width:${u}%"></i><i class="pe" style="width:${p}%"></i></span>`;
}
function parseKm(s: string): number {
  const m = (s || "").match(/([\d.,]+)\s*km/i);
  if (!m) return 0;
  return parseFloat(m[1].replace(/,/g, "")) || 0;
}
function fmtKm(v: number): string {
  return v >= 1000 ? (v / 1000).toFixed(1) + "k km" : Math.round(v) + " km";
}
function fmtSpeed(v: number): string {
  return v.toFixed(1) + " km/h";
}

/** Push persisted trim percentages into the sliders/outputs (skip a slider being dragged). */
function syncTrimControls(): void {
  const slow = $<HTMLInputElement>("#trimSlow");
  const fast = $<HTMLInputElement>("#trimFast");
  if (slow && document.activeElement !== slow) {
    slow.value = String(STATE.settings.speedTrimSlowPct);
  }
  if (fast && document.activeElement !== fast) {
    fast.value = String(STATE.settings.speedTrimFastPct);
  }
  ($("#trimSlowOut") as HTMLOutputElement).value = `${STATE.settings.speedTrimSlowPct}%`;
  ($("#trimFastOut") as HTMLOutputElement).value = `${STATE.settings.speedTrimFastPct}%`;
}

function renderStats(rides: AppState["rides"]): void {
  const panel = $("#statsPanel");
  if (!rides.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const gran: Granularity = statGran === "auto" ? autoGranularity(rides) : statGran;
  document
    .querySelectorAll<HTMLButtonElement>("#statGran button")
    .forEach((b) => b.classList.toggle("active", b.dataset.gran === statGran));
  document
    .querySelectorAll<HTMLButtonElement>("#statMetric button")
    .forEach((b) => b.classList.toggle("active", b.dataset.metric === statMetric));

  // Outlier-trim sliders belong to the speed view only.
  $("#spTrim").classList.toggle("hidden", statMetric !== "speed");
  syncTrimControls();

  // Per bucket we track distance (always) and the subset that also has a moving
  // time (only "checked" rides whose detail was fetched). Speed is distance-weighted
  // and the per-ride (km, sec) pairs are kept so outlier trimming can run by distance.
  const byM = new Map<
    string,
    {
      label: string;
      short: string;
      km: number;
      n: number;
      spKm: number;
      spSec: number;
      spN: number;
      rides: { km: number; sec: number }[];
    }
  >();
  for (const r of rides) {
    const km = parseKm(r.distance);
    const [bkey, label, short] = bucketRide(r.key, gran);
    if (!byM.has(bkey)) byM.set(bkey, { label, short, km: 0, n: 0, spKm: 0, spSec: 0, spN: 0, rides: [] });
    const e = byM.get(bkey)!;
    e.km += km;
    e.n += 1;
    const sec = parseDurationSec((r.stats && r.stats["Moving time"]) || "");
    if (sec > 0) {
      // Prefer the detail's own distance value when present; fall back to the list one.
      const spKm = parseKm((r.stats && r.stats["Distance"]) || r.distance);
      e.spKm += spKm;
      e.spSec += sec;
      e.spN += 1;
      e.rides.push({ km: spKm, sec });
    }
  }
  const items = [...byM.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const slowPct = STATE.settings.speedTrimSlowPct;
  const fastPct = STATE.settings.speedTrimFastPct;
  const bucketSpeed = (e: StatBucket): number => trimmedSpeed(e.rides, slowPct, fastPct);

  if (statMetric === "speed") {
    renderSpeed(gran, items, bucketSpeed, rides.length, slowPct, fastPct);
  } else {
    renderDistance(gran, items, rides.length);
  }
}

type StatBucket = {
  label: string;
  short: string;
  km: number;
  n: number;
  spKm: number;
  spSec: number;
  spN: number;
  rides: { km: number; sec: number }[];
};

function renderDistance(gran: Granularity, items: [string, StatBucket][], rideCount: number): void {
  ($(".sp-title") as HTMLElement).textContent = `Distance per ${gran}`;
  $("#spNote").classList.add("hidden");

  const totalKm = items.reduce((s, [, e]) => s + e.km, 0);
  const buckets = items.length;
  const maxKm = Math.max(1, ...items.map(([, e]) => e.km));

  $("#spKpis").innerHTML = [
    `<div class="kpi"><b>${fmtKm(totalKm)}</b><span>total</span></div>`,
    `<div class="kpi"><b>${rideCount}</b><span>rides</span></div>`,
    `<div class="kpi"><b>${fmtKm(totalKm / buckets)}</b><span>avg / ${gran}</span></div>`,
    `<div class="kpi"><b>${(totalKm / rideCount).toFixed(1)} km</b><span>avg / ride</span></div>`,
  ].join("");

  $("#chart").innerHTML = items
    .map(([, e]) => {
      const h = Math.round((e.km / maxKm) * 96);
      return `<div class="col" title="${e.label}: ${e.km.toFixed(1)} km over ${e.n} rides">
      <span class="cval">${Math.round(e.km)}</span>
      <div class="bar" style="height:${h}px"></div>
      <span class="clab">${e.short}</span>
    </div>`;
    })
    .join("");
}

function renderSpeed(
  gran: Granularity,
  items: [string, StatBucket][],
  bucketSpeed: (e: StatBucket) => number,
  rideCount: number,
  slowPct: number,
  fastPct: number,
): void {
  ($(".sp-title") as HTMLElement).textContent = `Average speed per ${gran}`;

  // Headline average: pool every checked ride and trim by distance across the whole
  // set, so one slow/fast ride anywhere is excluded (not just within its bucket).
  const allRides = items.flatMap(([, e]) => e.rides);
  const ridesWithSpeed = allRides.length;
  const overall = trimmedSpeed(allRides, slowPct, fastPct);
  const speeds = items.filter(([, e]) => e.spN > 0).map(([, e]) => bucketSpeed(e));
  const fastest = speeds.length ? Math.max(...speeds) : 0;
  const slowest = speeds.length ? Math.min(...speeds) : 0;
  const maxSpeed = Math.max(1, ...speeds);

  // Subtle warning: speed only covers rides we've "checked" (detail fetched).
  const note = $("#spNote");
  const missing = rideCount - ridesWithSpeed;
  const trimmed = slowPct > 0 || fastPct > 0;
  const notes: string[] = [];
  if (missing > 0) {
    notes.push(
      `Speed uses ${ridesWithSpeed} of ${rideCount} rides — Check the rest to include their moving time.`,
    );
  }
  if (trimmed) {
    notes.push(`Excluding slowest ${slowPct}% and fastest ${fastPct}% of distance.`);
  }
  if (notes.length) {
    note.textContent = notes.join(" ");
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }

  $("#spKpis").innerHTML = [
    `<div class="kpi"><b>${fmtSpeed(overall)}</b><span>avg speed</span></div>`,
    `<div class="kpi"><b>${ridesWithSpeed}</b><span>rides w/ data</span></div>`,
    `<div class="kpi"><b>${fmtSpeed(fastest)}</b><span>fastest ${gran}</span></div>`,
    `<div class="kpi"><b>${fmtSpeed(slowest)}</b><span>slowest ${gran}</span></div>`,
  ].join("");

  $("#chart").innerHTML = items
    .map(([, e]) => {
      const v = bucketSpeed(e);
      if (e.spN === 0) {
        return `<div class="col" title="${e.label}: no speed data">
      <span class="cval">—</span>
      <div class="bar empty" style="height:2px"></div>
      <span class="clab">${e.short}</span>
    </div>`;
      }
      const h = Math.round((v / maxSpeed) * 96);
      return `<div class="col" title="${e.label}: ${v.toFixed(1)} km/h over ${e.spN} rides">
      <span class="cval">${v.toFixed(1)}</span>
      <div class="bar" style="height:${h}px"></div>
      <span class="clab">${e.short}</span>
    </div>`;
    })
    .join("");
}

function renderConn(): void {
  const el = $("#connState");
  const connectBtn = $<HTMLButtonElement>("#btnConnect");
  const demoBtn = $<HTMLButtonElement>("#btnDemo");
  const disconnectBtn = $<HTMLButtonElement>("#btnDisconnect");
  const notice = $("#demoNotice");
  // The Demo button only pops (accent outline) in offline mode where it's the
  // primary call to action; everywhere else it's a quiet ghost button.
  demoBtn.classList.remove("ghost", "accent");
  if (isDemo) {
    el.textContent = "demo";
    el.className = "cstate demo";
    connectBtn.style.display = "";
    demoBtn.classList.add("ghost");
    demoBtn.style.display = "none";
    // Reuse the disconnect slot as an explicit way out of demo, back to offline.
    disconnectBtn.textContent = "Exit demo";
    disconnectBtn.style.display = "";
    notice.classList.remove("hidden");
  } else if (STATE.connected) {
    el.textContent = STATE.device || "connected";
    el.className = "cstate on";
    connectBtn.style.display = "none";
    demoBtn.classList.add("ghost");
    demoBtn.style.display = "none";
    disconnectBtn.textContent = "Disconnect";
    disconnectBtn.style.display = "";
    notice.classList.add("hidden");
  } else {
    // Offline: no phone, but we still show the user's stored rides. Offer both
    // "Connect phone" and a gently highlighted "Demo" entry.
    el.textContent = "not connected";
    el.className = "cstate off";
    connectBtn.style.display = "";
    demoBtn.classList.add("accent");
    demoBtn.style.display = "";
    disconnectBtn.style.display = "none";
    notice.classList.add("hidden");
  }
}

function render(): void {
  renderConn();
  const rides = STATE.rides;
  const jobs = STATE.jobs;
  ACTIVE = new Set(jobs.active_keys || []);
  RUNNING = new Set(jobs.current ? jobs.current_keys || [] : []);
  ($("#empty") as HTMLElement).style.display = rides.length ? "none" : "block";
  renderStats(rides);

  const byMonth = new Map<string, { label: string; rides: AppState["rides"] }>();
  for (const r of rides) {
    if (!byMonth.has(r.month_key)) byMonth.set(r.month_key, { label: r.month_label, rides: [] });
    byMonth.get(r.month_key)!.rides.push(r);
  }
  const months = [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const byYear = new Map<string, Array<[string, { label: string; rides: AppState["rides"] }]>>();
  for (const [mkey, m] of months) {
    const y = yearOf(mkey);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push([mkey, m]);
  }
  const years = [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const up = rides.filter((r) => r.status === "uploaded").length;
  const pe = rides.filter((r) => r.status === "pending" && !r.deleted).length;
  const del = rides.filter((r) => r.deleted).length;
  $("#totals").textContent =
    `${rides.length} rides · ${up} uploaded · ${pe} upload pending` +
    (del ? ` · ${del} deleted` : "") +
    (selected.size ? ` · ${selected.size} selected` : "");

  if (STATE.speed) {
    document
      .querySelectorAll<HTMLButtonElement>("#speeds button")
      .forEach((b) => b.classList.toggle("active", b.dataset.speed === STATE.speed));
  }

  const tp = $<HTMLInputElement>("#trackPoints");
  if (tp && document.activeElement !== tp) tp.value = String(STATE.settings.trackPointsPerKm);

  const allSelState = (keys: string[]): boolean | null => {
    const sel = keys.filter((k) => selected.has(k)).length;
    return sel === 0 ? false : sel === keys.length ? true : null;
  };

  const root = $("#months");
  root.innerHTML = "";
  for (const [year, ymonths] of years) {
    const yKeys = ymonths.flatMap(([, m]) => m.rides.map((r) => r.key));
    const yRides = ymonths.flatMap(([, m]) => m.rides);
    const yup = yRides.filter((r) => r.status === "uploaded").length;
    const ype = yRides.filter((r) => r.status === "pending" && !r.deleted).length;
    const ykm = yRides.reduce((s, r) => s + parseKm(r.distance), 0);
    const yOpen = !openYears.has("c" + year);
    const ySel = allSelState(yKeys);

    const ybox = document.createElement("div");
    ybox.className = "year";
    ybox.innerHTML = `
      <div class="yhead" data-y="${year}">
        <span class="caret">${yOpen ? "▾" : "▸"}</span>
        <input type="checkbox" class="selall" data-selyear="${year}" ${ySel === true ? "checked" : ""}>
        <span class="ytitle">${year}</span>
        ${bars(yup, ype, yRides.length)}
        <span class="ymeta">${yRides.length} rides · ${fmtKm(ykm)} · ${yup} up · ${ype} upload pending</span>
        <span class="yactions">
          ${checkSplit("check-y:" + year, "status-year-new", "status-year", ` data-y="${year}"`)}
          <button class="small ghost" data-act="gpx-year-missing" data-y="${year}" title="Download rough route previews for rides that don't have one yet">Preview routes</button>
          <button class="small" data-act="upload-year" data-y="${year}">Upload pending to Strava</button>
        </span>
      </div>
      <div class="ybody" ${yOpen ? "" : 'style="display:none"'}></div>`;
    root.appendChild(ybox);
    setChecked(ybox.querySelector(".selall"), ySel);

    const ybody = ybox.querySelector(".ybody")!;
    for (const [mkey, m] of ymonths) {
      m.rides.sort((a, b) => compareRideKeysDesc(a.key, b.key));
      const mup = m.rides.filter((r) => r.status === "uploaded").length;
      const mpe = m.rides.filter((r) => r.status === "pending" && !r.deleted).length;
      const mkm = m.rides.reduce((s, r) => s + parseKm(r.distance), 0);
      const isOpen = openMonths.has(mkey);
      const mKeys = m.rides.map((r) => r.key);
      const mSel = allSelState(mKeys);

      const box = document.createElement("div");
      box.className = "month";
      box.innerHTML = `
        <div class="mhead" data-m="${mkey}">
          <span class="caret">${isOpen ? "▾" : "▸"}</span>
          <input type="checkbox" class="selall" data-selmonth="${mkey}" ${mSel === true ? "checked" : ""}>
          <span class="mtitle">${m.label}</span>
          ${bars(mup, mpe, m.rides.length)}
          <span class="mmeta">${m.rides.length} rides · ${fmtKm(mkm)} · ${mup} up · ${mpe} upload pending</span>
          <span class="mactions">
            ${checkSplit("check-m:" + mkey, "status-month-new", "status-month", ` data-m="${mkey}"`)}
            <button class="small ghost" data-act="gpx-month-missing" data-m="${mkey}" title="Download rough route previews for rides that don't have one yet">Preview routes</button>
            <button class="small" data-act="upload-month" data-m="${mkey}">Upload pending to Strava</button>
          </span>
        </div>
        <div class="rows ${isOpen ? "open" : ""}"></div>`;
      ybody.appendChild(box);
      setChecked(box.querySelector(".selall"), mSel);

      const rowsEl = box.querySelector(".rows")!;
      for (const r of m.rides) {
        const so = openStats.has(r.key);
        // Fall back to checked detail stats when the list scan never captured the
        // summary figures, so a Checked ride shows real numbers instead of "?".
        const summaryDistance = r.distance || (r.stats && r.stats["Distance"]) || "?";
        const summaryDuration =
          r.duration || (r.stats && (r.stats["Elapsed time"] || r.stats["Moving time"])) || "?";
        const el = document.createElement("div");
        el.className = "rrow" + (r.deleted ? " deleted" : "");
        el.dataset.key = r.key;
        el.innerHTML = `
          <input type="checkbox" class="chk" data-key="${r.key}" ${selected.has(r.key) ? "checked" : ""}>
          <div class="rmain">
            <div class="rtitle"><span class="rname"><span class="rtitle-text">${r.title || "Ride"}</span>${r.location ? `<span class="rtitle-loc">${r.location}</span>` : ""}</span> ${badge(r.status)} ${r.track ? gpsBadge() : ""} ${r.deleted ? deletedBadge() : ""} ${queueBadge(r.key)}</div>
            <div class="rmeta">${r.key} · ${summaryDistance} · ${summaryDuration}
              <a href="#" data-stats="${r.key}">${so ? "hide" : "details"}</a></div>
            ${so ? detailsBlock(r.key, r.stats, r.track) : ""}
          </div>
          <div class="rbtns">
            <button class="small ghost" data-act="status-one" data-key="${r.key}">Check</button>
            ${gpxSplit(r.key, r.key)}
            <button class="small accent" data-act="upload-one" data-key="${r.key}">Upload to Strava</button>
          </div>`;
        rowsEl.appendChild(el);
      }
    }
  }
  renderJob();
  if (activeView === "map") mountAllRidesMap();
  else if (activeView === "stats") mountStatsView();
  else mountMaps();
  // The selection toolbar's GPX split button lives in static markup (not rebuilt
  // here), so sync its open state from the shared `openMenu` flag.
  const selSplit = document.getElementById("gpxSelMenu")?.closest(".split");
  selSplit?.classList.toggle("open", openMenu === "sel");
  lastSig = stateSig();
}

function renderJob(): void {
  const jobs = STATE.jobs;
  const cur = jobs.current;
  const queue = jobs.queue || [];
  // A month/year "Check" is ONE task carrying many ride keys, so counting tasks
  // would show "1 queued" for a 12-ride batch. Count the actual rides subject to
  // the operation instead (running + waiting, deduped via active_keys). Scans have
  // no ride keys, so each pending/running scan counts as a single item.
  const queuedTasks = queue.length;
  const rideCount = new Set(jobs.active_keys || []).size;
  const scanCount = [cur, ...queue].filter((t) => t && t.kind === "scan").length;
  const total = rideCount + scanCount;
  const busy = !!cur || queuedTasks > 0;
  if (!busy) jobHidden = false; // a finished batch clears the hide so the next one reappears
  $("#job").classList.toggle("show", busy && !jobHidden);
  $("#jobHandle").classList.toggle("show", busy && jobHidden);
  document.body.classList.toggle("job-active", busy);

  // -- current activity: what is being done right now -----------------------
  const titleEl = $("#jobTitle");
  const msgEl = $("#jobMsg");
  const bar = $("#jobBar") as HTMLElement;
  if (cur) {
    titleEl.textContent = taskTitle(cur);
    msgEl.textContent = cur.message || "working\u2026";
    const p = cur.progress;
    if (p && p.total > 0) {
      bar.style.display = "";
      ($("#jobBarFill") as HTMLElement).style.width = `${Math.round((p.done / p.total) * 100)}%`;
    } else {
      bar.style.display = "none";
    }
  } else if (busy) {
    titleEl.textContent = "Starting\u2026";
    msgEl.textContent = "waiting for the next item\u2026";
    bar.style.display = "none";
  } else {
    bar.style.display = "none";
  }

  // -- queued-ride count badge ----------------------------------------------
  const qc = $("#qcount");
  qc.textContent = total ? `${total} ride${total === 1 ? "" : "s"} queued` : "";
  qc.style.display = total ? "" : "none";

  // Minimized handle mirrors the count (or the live verb when nothing is queued).
  $("#jobHandleText").textContent = total ? `${total} ride${total === 1 ? "" : "s"}` : "Working\u2026";

  // -- the rest of the queue: what is to be done ----------------------------
  const toggle = $("#btnQueueToggle") as HTMLElement;
  toggle.style.display = queuedTasks ? "" : "none";
  toggle.textContent = `Up next (${queuedTasks})`;
  toggle.setAttribute("aria-expanded", String(queueExpanded));
  const list = $("#jobList");
  const showList = queueExpanded && queuedTasks > 0;
  list.classList.toggle("show", showList);
  list.innerHTML = showList ? queue.map(queueItemHtml).join("") : "";

  // Clear only drops not-yet-started tasks, so keep its visibility tied to the queue.
  ($("#btnClear") as HTMLElement).style.display = queuedTasks ? "" : "none";
  renderError(jobs);
}

// Human verb for each task kind, used in the queue panel ("Checking", "Uploading"…).
const TASK_VERB: Record<string, string> = {
  scan: "Scanning",
  status: "Checking",
  upload: "Uploading",
  "download-gpx": "Downloading GPX",
};

type JobTask = NonNullable<AppState["jobs"]["current"]>;

/** One-line description of a task: verb + what it acts on (a ride count, or the
 *  scan window). The running task also shows live "done of total" progress. */
function taskTitle(t: JobTask): string {
  const verb = TASK_VERB[t.kind] || t.kind;
  if (t.kind === "scan") return t.label ? `${verb} ${t.label}` : verb;
  const p = t.progress;
  if (p && p.total > 0) return `${verb} ${p.done} of ${p.total} ride${p.total === 1 ? "" : "s"}`;
  return `${verb} ${t.count} ride${t.count === 1 ? "" : "s"}`;
}

/** A waiting-queue row: verb + count, with a per-item remove button. */
function queueItemHtml(t: JobTask): string {
  const verb = TASK_VERB[t.kind] || t.kind;
  const desc = t.kind === "scan" ? (t.label ? `${verb} ${t.label}` : verb) : `${verb} ${t.count} ride${t.count === 1 ? "" : "s"}`;
  return `<div class="job-item">
    <span class="ji-dot"></span>
    <span class="ji-text">${escHtml(desc)}</span>
    <button class="ji-x" data-cancel="${t.id}" title="Remove from queue" aria-label="Remove from queue">\u00d7</button>
  </div>`;
}


function shortError(text: string): string {
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim()) || text;
  return line.trim();
}

function renderError(jobs: AppState["jobs"]): void {
  const all = [...(jobs.history || [])];
  if (jobs.current) all.push(jobs.current);
  const errored = all.filter((t) => t.status === "error" && t.error);
  errored.sort((a, b) => b.id - a.id);
  const latest = errored[0];

  const bar = $("#errbar");
  if (!latest || latest.id <= dismissedErrId) {
    bar.classList.remove("show");
    return;
  }
  bar.classList.add("show");
  $("#errTitle").textContent = `${latest.kind} failed${latest.label ? " — " + latest.label : ""}`;
  $("#errMsg").textContent = shortError(latest.error);
  bar.dataset.id = String(latest.id);
  bar.dataset.full = latest.error;

  if (latest.id > lastErrShownId) {
    lastErrShownId = latest.id;
    toast(shortError(latest.error), true);
  }
}

const keysOfMonth = (m: string): string[] => STATE.rides.filter((r) => r.month_key === m).map((r) => r.key);
const pendingOfMonth = (m: string): string[] =>
  STATE.rides.filter((r) => r.month_key === m && r.status === "pending" && !r.deleted).map((r) => r.key);
const keysOfYear = (y: string): string[] =>
  STATE.rides.filter((r) => (r.month_key || "").slice(0, 4) === y).map((r) => r.key);
const pendingOfYear = (y: string): string[] =>
  STATE.rides
    .filter((r) => (r.month_key || "").slice(0, 4) === y && r.status === "pending" && !r.deleted)
    .map((r) => r.key);

// A ride is "never checked" until its detail sheet has been opened, which is the
// only thing that fills `stats` (a scan sets just title/distance/duration).
const isUnchecked = (r: AppState["rides"][number]): boolean => !r.deleted && Object.keys(r.stats).length === 0;
const uncheckedOfMonth = (m: string): string[] =>
  STATE.rides.filter((r) => r.month_key === m && isUnchecked(r)).map((r) => r.key);
const uncheckedOfYear = (y: string): string[] =>
  STATE.rides.filter((r) => (r.month_key || "").slice(0, 4) === y && isUnchecked(r)).map((r) => r.key);

// A ride is "missing a preview" until a GPX download has stored its rough track.
const hasNoPreview = (r: AppState["rides"][number]): boolean => !r.deleted && !r.track;
const missingPreviewOfMonth = (m: string): string[] =>
  STATE.rides.filter((r) => r.month_key === m && hasNoPreview(r)).map((r) => r.key);
const missingPreviewOfYear = (y: string): string[] =>
  STATE.rides.filter((r) => (r.month_key || "").slice(0, 4) === y && hasNoPreview(r)).map((r) => r.key);

function toggleGroup(keys: string[]): void {
  const allSel = keys.length > 0 && keys.every((k) => selected.has(k));
  for (const k of keys) allSel ? selected.delete(k) : selected.add(k);
  render();
}

function toast(msg: string, err = false): void {
  const t = $<HTMLElement & { _t?: number }>("#toast");
  t.textContent = msg;
  t.classList.toggle("err", !!err);
  t.style.display = "block";
  clearTimeout(t._t);
  // Errors stay put until the next toast replaces them (or the user reads the
  // persistent error bar and dismisses it) — they must never just blink past.
  if (!err) t._t = window.setTimeout(() => (t.style.display = "none"), 4000);
}

function stateSig(): string {
  return (
    JSON.stringify(STATE) +
    "|" +
    [...selected].sort().join(",") +
    "|" +
    [...openMonths].sort().join(",") +
    "|" +
    [...openYears].sort().join(",") +
    "|" +
    [...openStats].sort().join(",")
  );
}

/** Re-read controller state and re-render if anything visible changed. */
function applyState(): void {
  STATE = controller.state();
  if (stateSig() === lastSig) return;
  render();
}

/** Run a controller action, surfacing AdbError to a toast. */
function run(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    toast(err instanceof AdbError ? err.message : String(err), true);
  }
}

function doScan(): void {
  const days = parseInt(($("#days") as HTMLInputElement).value, 10);
  if (days > 0) return run(() => controller.scan("custom", days));
  run(() => controller.scan(preset, null));
}

// --------------------------------------------------------------------------- //
// Import / export
// --------------------------------------------------------------------------- //
function exportRides(): void {
  const blob = new Blob([controller.exportJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "beeline-toolkit-state.json";
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser "Save As" for a GPX file pulled off the phone. */
function saveGpxFile(file: { filename: string; downloadName: string; bytes: Uint8Array }): void {
  // Demo GPX bytes are synthetic, and saving them would pop a browser "Save As"
  // dialog for every ride (especially with "ask where to save each file" on),
  // which makes the demo/test flow unusable. The route is already drawn on the
  // map from the stored track, so just acknowledge it instead of downloading.
  if (isDemo) {
    toast(`Demo: skipped saving ${file.downloadName} (no real GPX in demo mode).`);
    return;
  }
  const copy = new Uint8Array(file.bytes); // own the buffer for the Blob
  const blob = new Blob([copy], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Prefer the sort-friendly "YYYY-MM-DD HH-MM - <title>.gpx" name; fall back to
  // the device-stable filename if a download name wasn't computed.
  const name = file.downloadName || file.filename;
  a.download = name.endsWith(".gpx") ? name : `${name}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
}

function importRides(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const n = controller.importJson(String(reader.result));
      toast(`Imported — ${n} new ride${n === 1 ? "" : "s"}.`);
    } catch (err) {
      toast("Import failed: " + (err as Error).message, true);
    }
  };
  reader.readAsText(file);
}

/**
 * Erase every trace of local state: the ride cache + settings, the queued jobs,
 * and the remembered phone — then fall back to demo mode. Browser-only; the
 * phone is never touched. Guarded by a single confirm().
 */
async function resetEverything(): Promise<void> {
  if (!confirm("Erase all locally stored rides, settings, and the remembered phone? This cannot be undone and returns the app to offline mode. Nothing on your phone is deleted.")) {
    return;
  }
  controller.reset(); // clear the active controller's cache (IndexedDB) + job queue
  forgetReal(); // stop auto-reconnecting to the phone on future loads
  await goOffline(); // rebuild a fresh controller over the now-empty cache
  toast("Local data cleared.");
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target && target.tagName === "INPUT") return; // checkboxes handled on 'change'
  const t = (target.closest("button, a, .mhead, .yhead") as HTMLElement) || target;

  // Split-button: toggle its dropdown. Any click outside an open menu closes it.
  if (t.dataset && t.dataset.splitmenu) {
    openMenu = openMenu === t.dataset.splitmenu ? null : t.dataset.splitmenu;
    render();
    return;
  }
  if (openMenu !== null && !target.closest(".split")) {
    openMenu = null;
    render();
    // fall through so this same click can still trigger whatever it landed on
  }

  if (t.dataset && t.dataset.view) {
    setView(t.dataset.view as ViewName);
    return;
  }
  if (t.id === "btnMapExpand") {
    setMapExpanded(!document.body.classList.contains("map-expanded"));
    return;
  }
  if (t.dataset && t.dataset.rangereset) {
    resetRange(t.dataset.rangereset as RangeView);
    return;
  }
  if (t.dataset && t.dataset.preset) {
    preset = t.dataset.preset;
    ($("#days") as HTMLInputElement).value = "";
    syncDaysField();
    document
      .querySelectorAll<HTMLButtonElement>("#presets button")
      .forEach((b) => b.classList.toggle("active", b.dataset.preset === preset));
    return;
  }
  if (t.dataset && t.dataset.gran) {
    statGran = t.dataset.gran as Granularity | "auto";
    document
      .querySelectorAll<HTMLButtonElement>("#statGran button")
      .forEach((b) => b.classList.toggle("active", b.dataset.gran === statGran));
    render();
    return;
  }
  if (t.dataset && t.dataset.metric) {
    statMetric = t.dataset.metric as "distance" | "speed";
    document
      .querySelectorAll<HTMLButtonElement>("#statMetric button")
      .forEach((b) => b.classList.toggle("active", b.dataset.metric === statMetric));
    render();
    return;
  }
  if (t.dataset && t.dataset.speed) {
    document
      .querySelectorAll<HTMLButtonElement>("#speeds button")
      .forEach((b) => b.classList.toggle("active", b.dataset.speed === t.dataset.speed));
    run(() => controller.setSpeed(t.dataset.speed!));
    applyState();
    return;
  }
  if (t.id === "btnConnect") return void goReal();
  if (t.id === "btnDemo") return void goDemo();
  // The disconnect slot doubles as "Exit demo": from demo just drop to offline,
  // from a real device also forget it so we don't auto-reconnect next load.
  if (t.id === "btnDisconnect") return void (isDemo ? goOffline() : leaveReal());
  if (t.id === "btnImport") return void ($("#importFile") as HTMLInputElement).click();
  if (t.id === "btnExport") return exportRides();
  if (t.id === "btnReset") return void resetEverything();
  if (t.id === "btnScan") return doScan();
  if (t.id === "btnCancel") return run(() => controller.cancel(null));
  if (t.id === "btnClear") return run(() => controller.clear());
  if (t.id === "btnQueueToggle") {
    queueExpanded = !queueExpanded;
    renderJob();
    return;
  }
  if (t.id === "btnJobHide") {
    jobHidden = true;
    renderJob();
    return;
  }
  if (t.id === "jobHandle") {
    jobHidden = false;
    renderJob();
    return;
  }
  if (t.dataset && t.dataset.cancel) {
    return run(() => controller.cancel(parseInt(t.dataset.cancel!, 10)));
  }
  if (t.id === "errDismiss") {
    dismissedErrId = parseInt($("#errbar").dataset.id || "0", 10);
    $("#errbar").classList.remove("show");
    $("#errFull").classList.remove("show");
    return;
  }
  if (t.id === "errDetails") {
    const pre = $("#errFull");
    pre.textContent = $("#errbar").dataset.full || "";
    pre.classList.toggle("show");
    return;
  }
  if (t.id === "btnStatusSel") {
    if (!selected.size) return toast("Select some rides first.");
    return run(() => controller.status([...selected]));
  }
  if (t.id === "btnGpxSel") {
    if (!selected.size) return toast("Select some rides first.");
    return run(() => controller.downloadGpx([...selected]));
  }
  if (t.id === "btnGpxSaveSel") {
    openMenu = null;
    if (!selected.size) return toast("Select some rides first.");
    return run(() => controller.downloadGpx([...selected], true));
  }
  if (t.id === "btnUploadSel") {
    if (!selected.size) return toast("Select some rides first.");
    return run(() => controller.upload([...selected]));
  }
  if (t.id === "btnUploadPending") {
    const keys = STATE.rides.filter((r) => r.status === "pending" && !r.deleted).map((r) => r.key);
    if (!keys.length) return toast("No known pending rides. Check status first.");
    return run(() => controller.upload(keys));
  }

  const act = t.dataset && t.dataset.act;
  if (act === "status-one") return run(() => controller.status([t.dataset.key!]));
  if (act === "gpx-one") return run(() => controller.downloadGpx([t.dataset.key!]));
  if (act === "gpx-save-one") {
    openMenu = null;
    return run(() => controller.downloadGpx([t.dataset.key!], true));
  }
  if (act === "upload-one") return run(() => controller.upload([t.dataset.key!]));
  if (act === "status-month") {
    openMenu = null;
    return run(() => controller.status(keysOfMonth(t.dataset.m!)));
  }
  if (act === "status-month-new") {
    const keys = uncheckedOfMonth(t.dataset.m!);
    if (!keys.length) return toast("All rides this month are already checked.");
    return run(() => controller.status(keys));
  }
  if (act === "upload-month") {
    const keys = pendingOfMonth(t.dataset.m!);
    if (!keys.length) return toast("No known pending rides this month. Check first.");
    return run(() => controller.upload(keys));
  }
  if (act === "gpx-month-missing") {
    const keys = missingPreviewOfMonth(t.dataset.m!);
    if (!keys.length) return toast("All rides this month already have a preview.");
    return run(() => controller.downloadGpx(keys));
  }
  if (act === "status-year") {
    openMenu = null;
    return run(() => controller.status(keysOfYear(t.dataset.y!)));
  }
  if (act === "status-year-new") {
    const keys = uncheckedOfYear(t.dataset.y!);
    if (!keys.length) return toast("All rides this year are already checked.");
    return run(() => controller.status(keys));
  }
  if (act === "upload-year") {
    const keys = pendingOfYear(t.dataset.y!);
    if (!keys.length) return toast("No known pending rides this year. Check first.");
    return run(() => controller.upload(keys));
  }
  if (act === "gpx-year-missing") {
    const keys = missingPreviewOfYear(t.dataset.y!);
    if (!keys.length) return toast("All rides this year already have a preview.");
    return run(() => controller.downloadGpx(keys));
  }

  if (t.dataset && t.dataset.stats) {
    e.preventDefault();
    const k = t.dataset.stats;
    openStats.has(k) ? openStats.delete(k) : openStats.add(k);
    render();
    return;
  }

  // Clicking anywhere on a ride tile toggles its details — except on the
  // interactive bits (buttons, links, checkbox) or inside the already-open
  // details/map area, so the user can interact with those without collapsing.
  if (!target.closest("button, a, input, .stats, .rmap, .rmapnote, .rmaphint, .rdetailhint")) {
    const rrow = target.closest(".rrow") as HTMLElement | null;
    if (rrow && rrow.dataset.key) {
      const k = rrow.dataset.key;
      openStats.has(k) ? openStats.delete(k) : openStats.add(k);
      render();
      return;
    }
  }

  const yhead = t.classList && t.classList.contains("yhead") ? t : t.closest && (t.closest(".yhead") as HTMLElement | null);
  if (yhead) {
    const c = "c" + yhead.dataset.y;
    openYears.has(c) ? openYears.delete(c) : openYears.add(c);
    render();
    return;
  }

  const mhead = t.classList && t.classList.contains("mhead") ? t : t.closest && (t.closest(".mhead") as HTMLElement | null);
  if (mhead) {
    const m = mhead.dataset.m!;
    openMonths.has(m) ? openMonths.delete(m) : openMonths.add(m);
    render();
  }
});

// Escape closes an open split-button menu (GPX or Check).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu !== null) {
    openMenu = null;
    render();
  }
});

document.addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (cb.classList && cb.classList.contains("chk")) {
    cb.checked ? selected.add(cb.dataset.key!) : selected.delete(cb.dataset.key!);
    render();
    return;
  }
  if (cb.dataset && cb.dataset.selmonth) {
    toggleGroup(keysOfMonth(cb.dataset.selmonth));
    return;
  }
  if (cb.dataset && cb.dataset.selyear) {
    toggleGroup(keysOfYear(cb.dataset.selyear));
    return;
  }
  if (cb.id === "importFile" && cb.files && cb.files[0]) {
    importRides(cb.files[0]);
    cb.value = "";
  }
  if (cb.id === "trackPoints") {
    const v = parseInt(cb.value, 10);
    if (Number.isFinite(v)) run(() => controller.setTrackPointsPerKm(v));
  }
});

// Live outlier-trim sliders: update labels and recompute the speed view as they move.
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.range === "map" || el.dataset.range === "stats") {
    onRangeInput(el.dataset.range as RangeView, el);
    return;
  }
  if (el.id !== "trimSlow" && el.id !== "trimFast") return;
  const slow = parseInt($<HTMLInputElement>("#trimSlow").value, 10) || 0;
  const fast = parseInt($<HTMLInputElement>("#trimFast").value, 10) || 0;
  ($("#trimSlowOut") as HTMLOutputElement).value = `${slow}%`;
  ($("#trimFastOut") as HTMLOutputElement).value = `${fast}%`;
  run(() => controller.setSpeedTrim(slow, fast));
});

/** Keep the custom "last N days" pill in sync: highlight when set, grow to fit. */
function syncDaysField(): void {
  const input = $("#days") as HTMLInputElement;
  const pill = $("#customDays");
  const v = input.value;
  pill.classList.toggle("set", v.length > 0);
  // Auto-size: "n" placeholder width up to the digits actually typed.
  input.style.width = `${Math.max(1, v.length || 1) + 1.2}ch`;
  if (v) document.querySelectorAll<HTMLButtonElement>("#presets button").forEach((b) => b.classList.remove("active"));
}

$("#days").addEventListener("input", syncDaysField);
syncDaysField();

// Map view side panel: hovering an entry highlights its track; clicking opens the
// ride in the Explore view. no-track entries carry no data-key, so they're inert.
const mapSideEl = document.getElementById("mapSide");
if (mapSideEl) {
  mapSideEl.addEventListener("mouseover", (e) => {
    const item = (e.target as HTMLElement).closest(".ms-item") as HTMLElement | null;
    if (item?.dataset.key) setHot([item.dataset.key]);
  });
  mapSideEl.addEventListener("mouseleave", () => setHot([]));
  mapSideEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ms-clear")) {
      setPinned([]);
      return;
    }
    const item = target.closest(".ms-item") as HTMLElement | null;
    if (item?.dataset.key) openRideInExplore(item.dataset.key);
  });
}

// Warn before leaving while phone work is in progress — closing/reloading the tab
// kills the in-browser worker, abandoning the running task and anything queued.
window.addEventListener("beforeunload", (e) => {
  const jobs = controller?.state().jobs;
  if (jobs?.busy) {
    e.preventDefault();
    e.returnValue = ""; // required for Chromium to show the native confirm dialog
  }
});

// Esc leaves the full-screen map.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("map-expanded")) setMapExpanded(false);
});

/** Show the build version in the header; hover reveals commit + build date. */
function showVersion(): void {
  const el = document.getElementById("appVer");
  if (!el) return;
  const hasCommit = __APP_COMMIT__ && __APP_COMMIT__ !== "unknown";
  el.textContent = `v${__APP_VERSION__}${hasCommit ? `+${__APP_COMMIT__}` : ""}`;
  el.title = `commit ${__APP_COMMIT__} · built ${__APP_BUILD_DATE__}`;
}
showVersion();

// Reflect the remembered view before the first render so the right tab is shown.
applyView();

// Ask the browser to keep our IndexedDB ride cache durable (best-effort; a no-op
// where unsupported or already granted). Not awaited — it never blocks boot.
void navigator.storage?.persist?.();

// Cache writes are debounced, so force the latest one out when the tab is hidden
// or unloaded — "hidden" (tab switch / close on mobile) is the most reliable last
// chance to persist, and the IndexedDB write started here completes in the background.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void controller?.flush();
});
window.addEventListener("pagehide", () => void controller?.flush());

// Boot: silently reconnect a remembered phone (no prompt), else offline (stored rides).
if (wantsReal()) void tryAutoReconnect();
else void goOffline();
