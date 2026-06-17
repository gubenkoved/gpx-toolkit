/**
 * Timeline view — an isolated, map-centric experience over imported Google Location
 * History. Extracted into its own module (like `ridemap.ts`) so `main.ts` stays a
 * thin shell: this owns the whole subsystem and talks to the app only through an
 * injected `TimelineDeps` seam.
 *
 * Two cohesive modes share one Leaflet map:
 *  - **Overview** — a dwell-time heatmap of every place you've spent time ("where I
 *    spend time"), with the same rubber-band area-select the Map/Stats views use.
 *    Drawing a box answers "when was I here?" — a side list of the days you visited
 *    that area, newest first. A date-range filter scopes the heatmap.
 *  - **Day** — one day's movement plotted on the map (path + visit/stop markers),
 *    with a time slider that scrubs a marker along the day so you can replay where
 *    you were at any moment. The side panel is that day's chronological timeline.
 *
 * Reuses the app's shared vocabulary rather than inventing: `createAreaSelect` for
 * the box gesture, the dark basemap treatment, the icon-only `.map-expand`/
 * `.map-select` buttons, the pseudo-fullscreen body-class pattern, and leaflet.heat.
 */

import L from "leaflet";
import "leaflet.heat";

import { type AreaSelect, createAreaSelect } from "./areaselect";
import type { RideTrack } from "./mapview";
import type { LocRecord, VisitType } from "./loc-model";
import { type LocationHistoryStore, monthKey } from "./loc-store";
import {
  buildDaySamples,
  type DaySample,
  dayKeyOf,
  type DayPeriod,
  groupConsecutiveDays,
  groupVisitsByDay,
  type LatLonBox,
  posAt,
  selectionStats,
  visitsBox,
} from "./timeline-geo";

// --------------------------------------------------------------------------- //
// Dependency seam — injected by main.ts at startup (see initTimelineView).
// --------------------------------------------------------------------------- //
export interface TimelineDeps {
  /** The location-history store, or null while it's still loading. */
  getStore: () => LocationHistoryStore | null;
  /** Ensure the store is loaded (resolves once its catalog is hydrated). */
  ensureStore: () => Promise<LocationHistoryStore>;
  /** Transient bottom toast; `err` lengthens + styles it as an error. */
  toast: (msg: string, err?: boolean) => void;
  /** HTML-escape a string for safe interpolation into innerHTML. */
  esc: (s: string) => string;
  /** Human-readable byte size. */
  fmtBytes: (n: number) => string;
  /** OSM tile attribution credit string. */
  osmAttribution: string;
  /** Open the Location-History file picker (import flow lives in main.ts). */
  onImport: () => void;
  /** Drop all imported location history (confirm + clear lives in main.ts). */
  onDrop: () => void;
}

let deps: TimelineDeps;

// --------------------------------------------------------------------------- //
// Module state
// --------------------------------------------------------------------------- //
type Mode = "overview" | "day";

let map: L.Map | null = null;
let heatLayer: L.Layer | null = null;
let dayLayer: L.LayerGroup | null = null;
let scrubMarker: L.CircleMarker | null = null;
let areaSelect: AreaSelect | null = null;
let wired = false;

/** Overview: transient overlay drawing one day's footprint while its row is hovered. */
let hoverLayer: L.LayerGroup | null = null;
/** The day key currently previewed (guards the async load against a moved-on hover). */
let hoverDay: string | null = null;
/** Day mode: transient marker pinning the event whose rail row is hovered. */
let evHoverLayer: L.LayerGroup | null = null;
/** Decoded month chunks, cached so hovering sibling days doesn't re-decode the month. */
const monthRecCache = new Map<string, LocRecord[]>();

let mode: Mode = "overview";

/** All visits across the whole history, loaded once for the heatmap + area-select. */
let visits: LocRecord[] = [];
let visitsLoaded = false;
let visitsLoading: Promise<void> | null = null;
/** Sorted distinct day keys (UTC "YYYY-MM-DD") that have at least one visit. */
let visitDays: string[] = [];

/** Overview: the date-range filter [fromMs, toMs], or null for the whole history. */
let overviewRange: [number, number] | null = null;
/** Overview: the days matched by the current area selection, newest first. */
let selectedDays: { day: string; visits: LocRecord[]; dwellSec: number }[] = [];
/** Overview: bbox of the matched visits, drawn as a rectangle so the region is visible. */
let selectedBox: LatLonBox | null = null;
/** Overview: drill-down filter — show only this year's days within the selection. */
let selectedYear: number | null = null;
/** Overview: which consecutive-day periods are expanded (keyed by startDay). */
let expandedPeriods = new Set<string>();
/** Map overlay holding the selection rectangle + matched-visit dots. */
let selLayer: L.LayerGroup | null = null;

/** User-tweakable heatmap look, persisted across reloads (see HEAT_PREFS_KEY). */
const HEAT_PREFS_KEY = "gpx-toolkit.timeline.heat";
interface HeatPrefs {
  /** Glow radius in px (smaller = tighter/more precise, larger = smoother blobs). */
  radius: number;
  /** Hours of dwell that map to full intensity (lower = shorter stays show up too). */
  dwellH: number;
}
let heatPrefs: HeatPrefs = loadHeatPrefs();

function loadHeatPrefs(): HeatPrefs {
  const def: HeatPrefs = { radius: 22, dwellH: 6 };
  try {
    const raw = localStorage.getItem(HEAT_PREFS_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw) as Partial<HeatPrefs>;
    return {
      radius: clamp(typeof p.radius === "number" ? p.radius : def.radius, 8, 44),
      dwellH: clamp(typeof p.dwellH === "number" ? p.dwellH : def.dwellH, 0.5, 24),
    };
  } catch {
    return def;
  }
}

function saveHeatPrefs(): void {
  try {
    localStorage.setItem(HEAT_PREFS_KEY, JSON.stringify(heatPrefs));
  } catch {
    /* private mode — non-fatal */
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const DAY_MS = 864e5;
/** UTC midnight of the day containing `ms` (matches `dayKeyOf`'s UTC bucketing). */
function dayStartUTC(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Day mode: the active day (UTC "YYYY-MM-DD"). */
let dayKey: string | null = null;
let dayRecords: LocRecord[] = [];
let daySamples: DaySample[] = [];
let scrubT = 0;

/**
 * Times can be read either in UTC (how the instants are stored) or in the **local
 * time of the area** the day happened in. We have no timezone database (backend-free,
 * dependency-light), so the area offset is derived from the day's longitude
 * (`round(lon / 15)` hours) — a dependency-free approximation that ignores DST and
 * zone politics (so it can be ~1h off), but turns a UTC readout into the roughly-local
 * clock you actually lived. The choice persists across reloads; `dayOffsetMin` is
 * recomputed per opened day from its records.
 */
const TZ_AREA_KEY = "gpx-toolkit.timeline.tzArea";
let tzArea = loadTzArea();
let dayOffsetMin = 0;

function loadTzArea(): boolean {
  try {
    return localStorage.getItem(TZ_AREA_KEY) === "1";
  } catch {
    return false;
  }
}

function saveTzArea(): void {
  try {
    localStorage.setItem(TZ_AREA_KEY, tzArea ? "1" : "0");
  } catch {
    /* private mode — non-fatal */
  }
}

/** Whole-hour offset (in minutes) for a day's area, from its median longitude. */
function areaOffsetMin(recs: LocRecord[]): number {
  const lons = recs.map((r) => r.lon).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!lons.length) return 0;
  const med = lons[Math.floor(lons.length / 2)];
  return Math.round(med / 15) * 60;
}


// --------------------------------------------------------------------------- //
// Inline SVG icons — 16px, stroke: currentColor, so they inherit the button's text
// colour and stay crisp at any DPI (no Unicode glyphs). Shared by the text buttons.
// --------------------------------------------------------------------------- //
const SVG = (body: string): string =>
  `<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = {
  /** Upload tray with an up arrow — import a file. */
  import: SVG('<path d="M12 15V3"/><path d="m8 7 4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>'),
  /** Plus in a circle — add more. */
  add: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  /** Trash can — drop/delete. */
  trash: SVG('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>'),
  /** Back arrow — return to the overview/heatmap. */
  back: SVG('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  /** Chevron left — previous day. */
  chevLeft: SVG('<path d="m15 18-6-6 6-6"/>'),
  /** Chevron right — next day. */
  chevRight: SVG('<path d="m9 18 6-6-6-6"/>'),
  /** Calendar — open a day picker. */
  calendar: SVG('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  /** Phone with an up arrow — export from your phone. */
  phone: SVG('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M12 7v6M9.5 9 12 6.5 14.5 9"/>'),
} as const;

// --------------------------------------------------------------------------- //
// Init + lifecycle
// --------------------------------------------------------------------------- //

/** Wire the Timeline view: store deps and bind delegated events once. */
export function initTimelineView(d: TimelineDeps): void {
  deps = d;
  const root = document.getElementById("timelineView");
  if (root && !wired) {
    wired = true;
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    // Hovering a day row in the selection panel sketches that day on the overview map;
    // moving off any day row (onto blank panel or the map) clears it. One delegated
    // listener on the stable root covers every (re-rendered) row.
    root.addEventListener("pointerover", onHover);
    document
      .getElementById("btnTlExpand")
      ?.addEventListener("click", () => setExpanded(!document.body.classList.contains("tl-expanded")));
    // Arm/disarm the rubber-band area-select. The gesture itself is owned by
    // `areaSelect` (created lazily in ensureMap); this just toggles it, mirroring
    // how the Map/Stats views wire btnMapSelect/btnHeatSelect in main.ts.
    document.getElementById("btnTlSelect")?.addEventListener("click", () => {
      ensureMap();
      if (areaSelect) areaSelect.setMode(!areaSelect.isArmed());
    });
    document.getElementById("btnTlHelp")?.addEventListener("click", () => toggleHelp());
  }
}

/** Mount/refresh the Timeline view (called from the render dispatch). */
export function mountTimelineView(): void {
  if (!deps) return; // not yet wired (boot/HMR order) — re-mounts after init
  const empty = document.getElementById("timelineEmpty");
  const body = document.getElementById("timelineBody");
  if (!empty || !body) return;

  const store = deps.getStore();
  if (!store) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    empty.innerHTML = "Loading your location history\u2026";
    void deps.ensureStore().then(() => {
      if (isActive()) mountTimelineView();
    });
    return;
  }

  if (store.isEmpty()) {
    body.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.innerHTML =
      `<p><b>Timeline</b> brings your <b>Google Location History</b> into the app \u2014 ` +
      `see where you spend your time, find when you were somewhere, and replay any day. ` +
      `It stays <b>entirely on your device</b>, in its own storage you can drop any time.</p>` +
      `<p class="src-hint">It lives <b>on your phone</b> \u2014 export it from the Google Maps app, ` +
      `then bring the <code>.json</code> here.</p>` +
      `<div class="tl-empty-actions">` +
      `<button type="button" class="primary tl-btn" data-tl="import">${ICONS.import}Import Location History</button>` +
      `<button type="button" class="ghost small tl-btn" data-tl="help-open">${ICONS.phone}How to export from your phone</button>` +
      `</div>`;
    return;
  }

  empty.classList.add("hidden");
  body.classList.remove("hidden");

  ensureMap();
  if (!visitsLoaded) {
    showLoading(true);
    void loadVisits(store).then(() => {
      showLoading(false);
      if (isActive()) renderActiveMode({ fit: true });
    });
  }
  renderActiveMode();
}

/** Show/hide a small "building your map" cue while the month chunks decode. */
function showLoading(on: boolean): void {
  const banner = document.getElementById("tlBanner");
  if (!banner) return;
  if (on && mode === "overview") {
    banner.textContent = "Building your map\u2026";
    banner.classList.remove("hidden");
  } else if (!on) {
    banner.classList.add("hidden");
  }
}

/** Called when leaving the Timeline view: collapse fullscreen + disarm select. */
export function leaveTimelineView(): void {
  if (document.body.classList.contains("tl-expanded")) setExpanded(false);
  if (areaSelect?.isArmed()) areaSelect.setMode(false);
  clearDayPreview();
  clearEventHighlight();
  closeCalendar();
  toggleHelp(false);
}

/**
 * Invalidate cached data after an import or drop. Clears the visits cache and any
 * selection, returns to the overview, and re-mounts so the next render reloads.
 */
export function resetTimelineData(): void {
  if (!deps) return;
  visits = [];
  visitDays = [];
  visitsLoaded = false;
  visitsLoading = null;
  selectedDays = [];
  selectedBox = null;
  selectedYear = null;
  expandedPeriods = new Set();
  monthRecCache.clear();
  clearDayPreview();
  if (selLayer && map) {
    map.removeLayer(selLayer);
    selLayer = null;
  }
  overviewRange = null;
  mode = "overview";
  dayKey = null;
  dayRecords = [];
  daySamples = [];
  if (isActive()) mountTimelineView();
}

/** True while the Timeline map is in pseudo-fullscreen (for the Esc handler). */
export function isTimelineExpanded(): boolean {
  return document.body.classList.contains("tl-expanded");
}

/** Collapse Timeline fullscreen (Esc handler in main.ts). */
export function collapseTimeline(): void {
  setExpanded(false);
}

/** True while the export-guide overlay is open (for the Esc handler). */
export function isTimelineHelpOpen(): boolean {
  const p = document.getElementById("tlHelp");
  return !!p && !p.classList.contains("hidden");
}

/** Close the export-guide overlay (Esc handler in main.ts). */
export function closeTimelineHelp(): void {
  toggleHelp(false);
}

/** Whether the Timeline view is the active one (its container is visible). */
function isActive(): boolean {
  const v = document.getElementById("timelineView");
  return !!v && !v.classList.contains("hidden");
}

// --------------------------------------------------------------------------- //
// Map creation (lazy, once) — dark basemap + area-select, like the Map view.
// --------------------------------------------------------------------------- //
function ensureMap(): void {
  const host = document.getElementById("timelineMap");
  if (!host || map) {
    if (map) setTimeout(() => map!.invalidateSize(), 0);
    return;
  }
  map = L.map(host, {
    attributionControl: true,
    zoomControl: true,
    fadeAnimation: false,
    preferCanvas: true,
  });
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: deps.osmAttribution,
    className: "map-tiles",
  }).addTo(map);
  map.setView([20, 0], 2);
  dayLayer = L.layerGroup().addTo(map);

  // Area-select over visits, reusing the shared gesture. Each visit is a one-point
  // "track" keyed by its start instant; box/click hit-testing handles single points.
  areaSelect = createAreaSelect({
    getMap: () => map,
    getTracks: () => visitsAsTracks(),
    button: document.getElementById("btnTlSelect"),
    onSelect: (keys) => onAreaSelect(keys),
    clickPx: 10,
    idleLabel: "Find when you were in an area",
    armedLabel: "Cancel area selection",
  });
  areaSelect.attach();
  setTimeout(() => map!.invalidateSize(), 0);
}

/** Visits as single-point tracks for the area-select gesture (key = start instant). */
function visitsAsTracks(): RideTrack[] {
  const src = mode === "overview" ? visitsInRange() : [];
  return src.map((v) => ({ key: String(v.t), title: "", points: [[v.lat, v.lon]] }));
}

// --------------------------------------------------------------------------- //
// Data loading
// --------------------------------------------------------------------------- //
async function loadVisits(store: LocationHistoryStore): Promise<void> {
  if (visitsLoaded) return;
  if (visitsLoading) return visitsLoading;
  visitsLoading = (async () => {
    const all: LocRecord[] = [];
    for (const mk of store.months()) {
      const recs = await store.getMonth(mk);
      for (const r of recs) if (r.kind === "visit") all.push(r);
    }
    all.sort((a, b) => a.t - b.t);
    visits = all;
    visitDays = [...new Set(all.map((v) => dayKeyOf(v.t)))].sort();
    visitsLoaded = true;
  })();
  return visitsLoading;
}

/** Visits within the active overview date-range filter (all when unfiltered). */
function visitsInRange(): LocRecord[] {
  if (!overviewRange) return visits;
  const [lo, hi] = overviewRange;
  return visits.filter((v) => v.t >= lo && v.t <= hi);
}

// --------------------------------------------------------------------------- //
// Mode dispatch
// --------------------------------------------------------------------------- //
function renderActiveMode(opts: { fit?: boolean } = {}): void {
  if (mode === "day") renderDay(opts);
  else renderOverview(opts);
}

// --------------------------------------------------------------------------- //
// OVERVIEW mode — dwell heatmap + area-select "when was I here"
// --------------------------------------------------------------------------- //

const HEAT_GRADIENT = { 0.0: "#1e3a8a", 0.4: "#22d3ee", 0.7: "#facc15", 1.0: "#f97316" };

function renderOverview(opts: { fit?: boolean } = {}): void {
  // Keep the "building your map" cue visible while the first decode runs.
  if (visitsLoaded) document.getElementById("tlBanner")?.classList.add("hidden");
  clearDayLayer();
  buildHeat();
  drawSelectionRect(); // re-show the selected region (e.g. on return from a day)
  if (opts.fit) fitToVisits();
  renderOverviewBar();
  renderOverviewSide();
  setTimeout(() => map?.invalidateSize(), 0);
}

function buildHeat(): void {
  if (!map) return;
  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }
  // Intensity = each visit's dwell in HOURS (raw, unclamped); leaflet.heat sums the
  // overlapping points and normalizes against `max`. Setting max to the "Full glow at"
  // hours makes that slider a real control: a place reaches full colour once its
  // accumulated dwell hits `dwellH` hours, so raising it dims lightly-visited spots
  // while long-stay anchors stay lit. (The old code pre-clamped each point to <=1 and
  // used max:1, so dense clusters saturated regardless of the slider — it did nothing.)
  const dwellOf = (v: LocRecord) => (v.endT ? v.endT - v.t : 0.25 * 3.6e6) / 3.6e6;
  const visible = visitsInRange();
  const pts: [number, number, number][] = visible.map((v) => [
    v.lat,
    v.lon,
    Math.max(0.02, dwellOf(v)),
  ]);
  if (!pts.length) return;
  // Normalize against the VISIBLE data, not the whole history. leaflet.heat lights a
  // place by its *accumulated* dwell vs `max`, and the full-history view stacks every
  // year's visits at the same spot — so a single-year filter strips that stacking and
  // the same `max` washes the year out ("all not that bright"). Scale `max` down by the
  // share of total dwell currently shown so each filtered view normalizes to itself;
  // unfiltered the share is 1, so this is a no-op for the whole-history view.
  const totalDwell = visits.reduce((s, v) => s + dwellOf(v), 0);
  const visibleDwell = visible.reduce((s, v) => s + dwellOf(v), 0);
  const shownFrac = totalDwell > 0 ? visibleDwell / totalDwell : 1;
  const effMax = Math.max(0.25, heatPrefs.dwellH * shownFrac);
  heatLayer = L.heatLayer(pts, {
    radius: heatPrefs.radius,
    blur: Math.round(heatPrefs.radius * 0.8),
    // A low floor (not 0.35) is essential: leaflet.heat draws every point at
    // alpha = max(dwell/max, minOpacity), so a high floor pins short visits bright and
    // makes the "Full glow at" threshold invisible. Keep it low so dwell actually shows.
    minOpacity: 0.12,
    max: effMax,
    gradient: HEAT_GRADIENT,
  }).addTo(map);
}

/**
 * Frame the map on where the dwell actually is, not the full extent. A few flights
 * or trips abroad would otherwise blow the bounds out to the whole globe; instead we
 * trim the outer ~4% of visits on each axis (a percentile box) so the view lands on
 * your real activity area(s) while still spanning multiple homes. Falls back to the
 * full bounds when there are too few points to trim meaningfully.
 */
function fitToVisits(): void {
  const src = visitsInRange();
  if (!map || !src.length) return;
  const bounds =
    src.length >= 25 ? trimmedBounds(src, 0.04) : src.map((v) => [v.lat, v.lon] as L.LatLngExpression);
  map.fitBounds(L.latLngBounds(bounds), { padding: [28, 28] });
}

/** A percentile-trimmed lat/lon box: drops the outer `q` fraction on each axis. */
function trimmedBounds(src: LocRecord[], q: number): L.LatLngExpression[] {
  const lats = src.map((v) => v.lat).sort((a, b) => a - b);
  const lons = src.map((v) => v.lon).sort((a, b) => a - b);
  const at = (arr: number[], f: number): number => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * arr.length)))];
  return [
    [at(lats, q), at(lons, q)],
    [at(lats, 1 - q), at(lons, 1 - q)],
  ];
}

function onAreaSelect(keys: string[]): void {
  if (mode !== "overview") return;
  const want = new Set(keys);
  const chosen = visitsInRange().filter((v) => want.has(String(v.t)));
  selectedYear = null; // a fresh selection resets any year drill-down
  if (!chosen.length) {
    clearSelection();
    return;
  }
  selectedDays = groupVisitsByDay(chosen);
  selectedBox = visitsBox(chosen);
  expandNewestVisible(); // open the most recent stay so its days show without a click
  drawSelectionRect();
  renderOverviewSide();
}

/**
 * Open the most recent **visible** stay (and only it), collapsing the rest. Called
 * whenever the set of periods changes — a fresh area selection or a year drill-down —
 * so the panel always shows something without a click. Deliberately NOT called from the
 * render path, so a user collapsing the last open stay stays collapsed.
 */
function expandNewestVisible(): void {
  const visible = selectedYear
    ? selectedDays.filter((d) => Number(d.day.slice(0, 4)) === selectedYear)
    : selectedDays;
  const periods = groupConsecutiveDays(visible);
  expandedPeriods = new Set(periods.length ? [periods[0].startDay] : []);
}

/** Draw (or redraw) the selection region rectangle on the map. */
function drawSelectionRect(): void {
  if (!map) return;
  if (selLayer) {
    map.removeLayer(selLayer);
    selLayer = null;
  }
  if (!selectedBox) return;
  selLayer = L.layerGroup().addTo(map);
  L.rectangle(
    [
      [selectedBox.minLat, selectedBox.minLon],
      [selectedBox.maxLat, selectedBox.maxLon],
    ],
    { color: "#f97316", weight: 1.5, dashArray: "5 4", fill: true, fillOpacity: 0.06, interactive: false },
  ).addTo(selLayer);
}

// --------------------------------------------------------------------------- //
// Day-row hover preview — sketch one day's footprint on the overview map
// --------------------------------------------------------------------------- //

/** Load + cache a day's records (filtered from its month chunk), time-ordered. */
async function dayRecordsFor(day: string): Promise<LocRecord[]> {
  const store = deps.getStore();
  if (!store) return [];
  const mk = monthKey(Date.parse(`${day}T00:00:00Z`));
  let recs = monthRecCache.get(mk);
  if (!recs) {
    recs = await store.getMonth(mk);
    monthRecCache.set(mk, recs);
  }
  return recs.filter((r) => dayKeyOf(r.t) === day).sort((a, b) => a.t - b.t);
}

/**
 * Preview a day on the overview map while its side-panel row is hovered: a quick
 * highlight of that day's footprint (movement trail + visit dots) over the heatmap,
 * so you can get a sense of the day without leaving the overview. Async (loads the
 * month chunk, cached) and guarded so a moved-on hover never draws a stale day.
 */
async function previewDay(day: string): Promise<void> {
  if (mode !== "overview" || !map) return;
  hoverDay = day;
  const recs = await dayRecordsFor(day);
  if (hoverDay !== day || mode !== "overview" || !map) return; // hover moved on meanwhile
  drawDayPreview(recs);
}

/** Draw the hovered day's trail + visit markers on a transient overlay (top of heat). */
function drawDayPreview(recs: LocRecord[]): void {
  clearDayPreview(false);
  if (!map || !recs.length) return;
  hoverLayer = L.layerGroup().addTo(map);
  // Time-ordered position trail (path breadcrumbs + visit/move points; moves add their
  // end point too) — a white casing under an orange line so it reads over the basemap.
  const pts = recs.flatMap((r) =>
    r.lat2 !== undefined && r.lon2 !== undefined
      ? ([
          [r.lat, r.lon],
          [r.lat2, r.lon2],
        ] as [number, number][])
      : ([[r.lat, r.lon]] as [number, number][]),
  );
  if (pts.length >= 2) {
    L.polyline(pts, { color: "#fff", weight: 4.5, opacity: 0.5, interactive: false }).addTo(hoverLayer);
    L.polyline(pts, { color: "#f97316", weight: 2.5, opacity: 0.95, interactive: false }).addTo(hoverLayer);
  }
  // Visit stops as cased dots, coloured for home/work like the day-replay markers.
  for (const v of recs.filter((r) => r.kind === "visit")) {
    L.circleMarker([v.lat, v.lon], {
      radius: 6,
      color: "#fff",
      weight: 2,
      fillColor: VISIT_COLORS[v.semanticType ?? "UNKNOWN"] ?? "#f97316",
      fillOpacity: 1,
      interactive: false,
    }).addTo(hoverLayer);
  }
}

/** Remove the day-hover overlay. Pass `resetDay=false` to keep the in-flight guard. */
function clearDayPreview(resetDay = true): void {
  if (resetDay) hoverDay = null;
  if (hoverLayer && map) {
    map.removeLayer(hoverLayer);
    hoverLayer = null;
  }
}

/** Clear the current area selection (rectangle + side list + drill-down). */
function clearSelection(): void {
  clearDayPreview();
  selectedDays = [];
  selectedBox = null;
  selectedYear = null;
  expandedPeriods = new Set();
  if (selLayer && map) {
    map.removeLayer(selLayer);
    selLayer = null;
  }
  renderOverviewSide();
}

function renderOverviewBar(): void {
  const bar = document.getElementById("tlBar");
  if (!bar) return;
  bar.innerHTML = heatControlsHtml() + jumpDateHtml() + rangeSliderHtml();
  wireRangeWindow();
  updateRangeUI();
}

/** Live heatmap tweaks: glow spread (precision) + the dwell that means "full glow". */
function heatControlsHtml(): string {
  return (
    `<div class="tl-tweaks">` +
    `<label class="tl-tweak" title="How tightly the glow hugs each place \u2014 smaller is more precise/pinpoint, larger blends nearby places into smooth blobs">` +
    `Spread <input type="range" id="tlHeatRadius" min="8" max="44" step="2" value="${heatPrefs.radius}" /></label>` +
    `<label class="tl-tweak" title="A place reaches full brightness once you've spent at least this long there \u2014 lower shows short stops too, higher highlights only your long stays">` +
    `Full glow at <input type="range" id="tlHeatDwell" min="1" max="24" step="1" value="${heatPrefs.dwellH}" />` +
    `<output id="tlHeatDwellOut">${heatPrefs.dwellH}h</output></label>` +
    `</div>`
  );
}

/** Apply a live heat tweak from a slider without rebuilding the bar (keeps drag focus). */
function tweakHeat(which: "radius" | "dwellH", value: number): void {
  heatPrefs[which] = value;
  saveHeatPrefs();
  if (which === "dwellH") {
    const out = document.getElementById("tlHeatDwellOut");
    if (out) out.textContent = `${value}h`;
  }
  buildHeat();
}

/** A "jump to a day" trigger → opens the custom calendar popover (day replay). */
function jumpDateHtml(): string {
  if (!visitDays.length) return "";
  return (
    `<button class="tl-calbtn tl-jump" data-tl="open-cal" data-cal="jump" ` +
    `aria-label="Open a specific day's replay" ` +
    `title="Open a specific day's replay">${ICONS.calendar}<span>Open day</span></button>`
  );
}

// --------------------------------------------------------------------------- //
// Custom day-picker calendar — a styled popover replacing the unstylable native
// `<input type="date">` picker. Reused by the overview "Open day" trigger and the
// day-bar date control; bounded to the imported day range. Picking opens that day's
// replay.
// --------------------------------------------------------------------------- //
const CAL_DOW = ["M", "T", "W", "T", "F", "S", "S"];
/** Open calendar state: which trigger, the month on view, and the anchor element. */
let calState: { target: "jump" | "date"; year: number; month: number; anchor: HTMLElement } | null = null;
let calOutside: ((e: PointerEvent) => void) | null = null;
let calKeydown: ((e: KeyboardEvent) => void) | null = null;

/** ISO "YYYY-MM-DD" for a year + 0-based month + day. */
function isoDay(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Compact "Mon D, YYYY" label for a "YYYY-MM-DD" day key. */
function calBtnLabel(day: string): string {
  return fmtRangeDay(Date.parse(`${day}T00:00:00Z`));
}

function openCalendar(target: "jump" | "date", anchor: HTMLElement): void {
  if (!visitDays.length) return;
  // Base the visible month on the current day (day bar) or the latest day (overview).
  const base = (target === "date" && dayKey) || visitDays[visitDays.length - 1];
  const [y, m] = base.split("-").map(Number);
  calState = { target, year: y, month: m - 1, anchor };
  renderCalendar();
  // Defer wiring the dismiss listeners so the opening click doesn't immediately close it.
  setTimeout(() => {
    if (!calState) return;
    calOutside = (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("#tlCal") && !t.closest('[data-tl="open-cal"]')) closeCalendar();
    };
    calKeydown = (e) => {
      if (e.key === "Escape" && calState) {
        e.stopPropagation();
        closeCalendar();
      }
    };
    document.addEventListener("pointerdown", calOutside, true);
    document.addEventListener("keydown", calKeydown, true);
  }, 0);
}

function closeCalendar(): void {
  calState = null;
  document.getElementById("tlCal")?.remove();
  if (calOutside) document.removeEventListener("pointerdown", calOutside, true);
  if (calKeydown) document.removeEventListener("keydown", calKeydown, true);
  calOutside = calKeydown = null;
}

/** Build/refresh the calendar popover for the month in `calState` and position it. */
function renderCalendar(): void {
  if (!calState) return;
  const { year, month, anchor } = calState;
  const minDay = visitDays[0];
  const maxDay = visitDays[visitDays.length - 1];
  const curMonth = `${year}-${String(month + 1).padStart(2, "0")}`;
  const prevOff = curMonth <= minDay.slice(0, 7);
  const nextOff = curMonth >= maxDay.slice(0, 7);
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const firstDow = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);

  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<span class="tl-cal-cell empty"></span>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoDay(year, month, d);
    const out = iso < minDay || iso > maxDay;
    const sel = calState.target === "date" && iso === dayKey;
    const cls = `tl-cal-cell${sel ? " sel" : ""}${iso === today ? " today" : ""}`;
    cells += out
      ? `<span class="tl-cal-cell out">${d}</span>`
      : `<button class="${cls}" data-tl="cal-pick" data-day="${iso}">${d}</button>`;
  }

  let pop = document.getElementById("tlCal");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "tlCal";
    pop.className = "tl-cal";
    document.getElementById("timelineView")?.appendChild(pop);
  }
  pop.innerHTML =
    `<div class="tl-cal-head">` +
    `<span class="tl-cal-month">${deps.esc(monthLabel)}</span>` +
    `<span class="tl-cal-nav">` +
    `<button class="tl-cal-arrow" data-tl="cal-nav" data-dir="-1" ${prevOff ? "disabled" : ""} aria-label="Previous month">${ICONS.chevLeft}</button>` +
    `<button class="tl-cal-arrow" data-tl="cal-nav" data-dir="1" ${nextOff ? "disabled" : ""} aria-label="Next month">${ICONS.chevRight}</button>` +
    `</span></div>` +
    `<div class="tl-cal-grid tl-cal-dow">${CAL_DOW.map((d) => `<span class="tl-cal-cell dow">${d}</span>`).join("")}</div>` +
    `<div class="tl-cal-grid">${cells}</div>`;

  // Position above the trigger (the bar sits low); clamp within the viewport.
  pop.style.visibility = "hidden";
  pop.style.left = "0px";
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = a.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = a.top - h - 8;
  if (top < 8) top = a.bottom + 8; // not enough room above → drop below
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = "visible";
}

/** Shift the visible calendar month by `dir` (±1), then re-render in place. */
function navCalendar(dir: number): void {
  if (!calState) return;
  const d = new Date(Date.UTC(calState.year, calState.month + dir, 1));
  calState.year = d.getUTCFullYear();
  calState.month = d.getUTCMonth();
  renderCalendar();
}

// --------------------------------------------------------------------------- //
// Date-range slider — a dual-thumb window over the whole history with a draggable
// middle (slide a fixed-size window), reusing the app's shared `.rf-*` slider look
// (Map/Stats). It writes `overviewRange`, the same filter the heatmap & area-select
// already read, so sliding ebbs the dwell heat through time in place.
// --------------------------------------------------------------------------- //
interface RangeBounds {
  /** UTC midnight of the first day with data. */
  lo: number;
  /** Number of whole days spanned (0 → a single-day history, no slider). */
  n: number;
}

/** Full day-span of the loaded history, or null when there's nothing to slide. */
function rangeBounds(): RangeBounds | null {
  if (!visits.length) return null;
  const lo = dayStartUTC(visits[0].t);
  const hi = dayStartUTC(visits[visits.length - 1].t);
  return { lo, n: Math.round((hi - lo) / DAY_MS) };
}

/** Current selection as day indices into the bounds (whole span when unfiltered). */
function rangeIndices(b: RangeBounds): { loIdx: number; hiIdx: number } {
  const sel = overviewRange ?? [b.lo, b.lo + b.n * DAY_MS + (DAY_MS - 1)];
  const idx = (ms: number) => clamp(Math.round((dayStartUTC(ms) - b.lo) / DAY_MS), 0, b.n);
  return { loIdx: idx(sel[0]), hiIdx: idx(sel[1]) };
}

/** Compact UTC day label for a slider edge, e.g. "Jun 1, 2026". */
function fmtRangeDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The dual-range date slider (two overlaid day-index inputs + a draggable window). */
function rangeSliderHtml(): string {
  const b = rangeBounds();
  if (!b || b.n <= 0) return ""; // single day of data — nothing to slide
  const { loIdx, hiIdx } = rangeIndices(b);
  const input = (edge: "lo" | "hi", idx: number): string =>
    `<input type="range" class="rf-${edge}" id="tlRange${edge === "lo" ? "Lo" : "Hi"}" ` +
    `min="0" max="${b.n}" step="1" value="${idx}" ` +
    `aria-label="${edge === "lo" ? "Earliest" : "Latest"} date">`;
  return (
    `<div class="range-filter tl-range">` +
    `<span class="rf-edge" id="tlRangeFrom"></span>` +
    `<div class="rf-track">${input("lo", loIdx)}${input("hi", hiIdx)}` +
    `<div class="rf-window" id="tlRangeWin" aria-hidden="true" ` +
    `title="Drag to slide this time window across your history"></div></div>` +
    `<span class="rf-edge" id="tlRangeTo"></span>` +
    `<button class="rf-reset" data-tl="range-reset" title="Show your whole history">All</button>` +
    `</div>`
  );
}

/** Refresh the slider's edge labels + accent fill from the live input values. */
function updateRangeUI(): void {
  const b = rangeBounds();
  const lo = document.getElementById("tlRangeLo") as HTMLInputElement | null;
  const hi = document.getElementById("tlRangeHi") as HTMLInputElement | null;
  if (!b || !lo || !hi) return;
  const loIdx = Number(lo.value);
  const hiIdx = Number(hi.value);
  const from = document.getElementById("tlRangeFrom");
  const to = document.getElementById("tlRangeTo");
  if (from) from.textContent = fmtRangeDay(b.lo + loIdx * DAY_MS);
  if (to) to.textContent = fmtRangeDay(b.lo + hiIdx * DAY_MS);
  const track = document.querySelector<HTMLElement>("#tlBar .rf-track");
  if (track && b.n > 0) {
    track.style.setProperty("--rf-lo", String(loIdx / b.n));
    track.style.setProperty("--rf-hi", String(hiIdx / b.n));
  }
}

/** Apply slider day-indices to `overviewRange` and redraw the heat (no bar rebuild). */
function applyRange(loIdx: number, hiIdx: number, fit: boolean): void {
  const b = rangeBounds();
  if (!b) return;
  // The whole span maps back to "unfiltered" so `visitsInRange()` stays a no-op.
  overviewRange =
    loIdx <= 0 && hiIdx >= b.n
      ? null
      : [b.lo + loIdx * DAY_MS, b.lo + hiIdx * DAY_MS + (DAY_MS - 1)];
  buildHeat();
  drawSelectionRect();
  if (fit) fitToVisits();
  updateRangeUI();
}

/** Attach the window-drag handler to the freshly rendered slider window. */
function wireRangeWindow(): void {
  const win = document.getElementById("tlRangeWin");
  win?.addEventListener("pointerdown", (e) => onRangeWindowDrag(win, e as PointerEvent));
}

/**
 * Drag the window between the thumbs to slide the whole selection without resizing
 * it — both edges move by the same whole-day delta, clamped within bounds. Mirrors
 * the Map/Stats `onWindowDrag`; uses pointer capture so it tracks past the edges.
 */
function onRangeWindowDrag(win: HTMLElement, e: PointerEvent): void {
  const b = rangeBounds();
  const track = win.parentElement;
  const lo = document.getElementById("tlRangeLo") as HTMLInputElement | null;
  const hi = document.getElementById("tlRangeHi") as HTMLInputElement | null;
  if (!b || !track || !lo || !hi || b.n <= 0) return;
  const usablePx = track.getBoundingClientRect().width - 15; // track width minus one thumb
  if (usablePx <= 0) return;

  const startX = e.clientX;
  const startLo = Number(lo.value);
  const span = Number(hi.value) - startLo; // held constant for the whole drag
  win.classList.add("dragging");
  try {
    win.setPointerCapture(e.pointerId);
  } catch {
    /* older engines may reject capture; mouse drag still works without it */
  }

  const move = (ev: PointerEvent): void => {
    const dIdx = Math.round(((ev.clientX - startX) / usablePx) * b.n);
    const newLo = Math.max(0, Math.min(startLo + dIdx, b.n - span));
    lo.value = String(newLo);
    hi.value = String(newLo + span);
    applyRange(newLo, newLo + span, false);
    ev.preventDefault();
  };
  const endDrag = (): void => {
    win.classList.remove("dragging");
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", endDrag);
    win.removeEventListener("pointercancel", endDrag);
  };
  win.addEventListener("pointermove", move);
  win.addEventListener("pointerup", endDrag);
  win.addEventListener("pointercancel", endDrag);
  e.preventDefault();
}

/** Live drag of either thumb: clamp so from ≤ to, then redraw heat (no bar rebuild). */
function onRangeInput(): void {
  const lo = document.getElementById("tlRangeLo") as HTMLInputElement | null;
  const hi = document.getElementById("tlRangeHi") as HTMLInputElement | null;
  if (!lo || !hi) return;
  let loIdx = Number(lo.value);
  let hiIdx = Number(hi.value);
  if (loIdx > hiIdx) {
    // Whichever thumb crossed gets pinned to the other so the window never inverts.
    if (document.activeElement === lo) hiIdx = loIdx;
    else loIdx = hiIdx;
    lo.value = String(loIdx);
    hi.value = String(hiIdx);
  }
  applyRange(loIdx, hiIdx, false);
}

/** Reset the slider to the whole history and re-frame the map. */
function resetRange(): void {
  const b = rangeBounds();
  if (!b) return;
  const lo = document.getElementById("tlRangeLo") as HTMLInputElement | null;
  const hi = document.getElementById("tlRangeHi") as HTMLInputElement | null;
  if (lo) lo.value = "0";
  if (hi) hi.value = String(b.n);
  applyRange(0, b.n, true);
}

function renderOverviewSide(): void {
  const side = document.getElementById("tlSide");
  if (!side) return;

  if (selectedDays.length) {
    renderSelectionSide(side);
    return;
  }

  // No selection: a short orientation + import/drop affordances.
  const store = deps.getStore();
  const n = store ? store.totalRecords() : 0;
  const v = visitsLoaded ? visits.length : null;
  side.innerHTML =
    `<div class="tl-side-head"><h2>Where you spend time</h2></div>` +
    `<div class="tl-side-sub">The heatmap glows brightest where you've spent the most ` +
    `time. Use the <b>Select area</b> tool (top-right) to draw a box and find ` +
    `<b>when you were there</b> \u2014 then open any day to replay it on the map.</div>` +
    `<div class="tl-facts">` +
    `<div class="tl-fact"><b>${n.toLocaleString()}</b><span>records</span></div>` +
    (v !== null ? `<div class="tl-fact"><b>${v.toLocaleString()}</b><span>visits</span></div>` : "") +
    (store ? `<div class="tl-fact"><b>${deps.fmtBytes(store.totalBytes())}</b><span>on disk</span></div>` : "") +
    `</div>` +
    `<div class="tl-side-actions">` +
    `<button type="button" class="ghost small tl-btn" data-tl="import">${ICONS.add}Add more history</button>` +
    `<button type="button" class="ghost small danger tl-btn" data-tl="drop">${ICONS.trash}Drop location history</button>` +
    `</div>`;
}

/**
 * The "when you were here" panel for an area selection. Leads with a temporal headline
 * (first/last/span), then a clickable per-year histogram so you can tell at a glance
 * WHEN you frequented the area and drill the day list down to a single year, then the
 * day rows themselves (each opens that day's replay).
 */
function renderSelectionSide(side: HTMLElement): void {
  const stats = selectionStats(selectedDays);
  if (!stats) return;
  const { totalDays, totalVisits, totalDwellSec, firstDay, lastDay, perYear } = stats;

  // Per-year histogram (the drill-down index), newest year first.
  const years = [...perYear.keys()].sort((a, b) => b - a);
  const maxYear = Math.max(...perYear.values());
  const histRows = years
    .map((y) => {
      const c = perYear.get(y)!;
      const pct = Math.max(6, Math.round((c / maxYear) * 100));
      const active = selectedYear === y ? " active" : "";
      return (
        `<button class="tl-hist-row${active}" data-tl="sel-year" data-year="${y}" ` +
        `title="${c} day${c === 1 ? "" : "s"} in ${y} \u2014 click to show just ${y}">` +
        `<span class="tl-hist-yr">${y}</span>` +
        `<span class="tl-hist-bar"><span class="tl-hist-fill" style="width:${pct}%"></span></span>` +
        `<span class="tl-hist-n">${c}</span></button>`
      );
    })
    .join("");

  // Days narrowed to the drilled-down year, then grouped into consecutive periods.
  const visibleDays = selectedYear
    ? selectedDays.filter((d) => Number(d.day.slice(0, 4)) === selectedYear)
    : selectedDays;
  const periods = groupConsecutiveDays(visibleDays);
  const periodsHtml = periods.map(renderPeriod).join("");

  const span =
    firstDay.slice(0, 7) === lastDay.slice(0, 7)
      ? monthYear(firstDay)
      : `${monthYear(firstDay)} \u2013 ${monthYear(lastDay)}`;
  const yearsSpan = years.length > 1 ? ` across ${years.length} years` : "";
  const periodsNote =
    periods.length > 1
      ? `<div class="tl-side-hint">${periods.length} separate stays \u00b7 click one to see its days</div>`
      : "";
  const drillNote = selectedYear
    ? `<div class="tl-drill"><b>${selectedYear}</b> only \u00b7 ` +
      `<button class="linkbtn" data-tl="sel-year-clear">show all years</button></div>`
    : "";

  side.innerHTML =
    `<div class="tl-side-head"><h2>When you were here</h2>` +
    `<button class="ms-clear" data-tl="clear-sel" title="Clear the selection">Clear</button></div>` +
    `<div class="tl-side-sub">${deps.esc(span)} \u00b7 ${totalDays.toLocaleString()} day${totalDays === 1 ? "" : "s"}${yearsSpan} \u00b7 ` +
    `${totalVisits.toLocaleString()} visit${totalVisits === 1 ? "" : "s"}` +
    (totalDwellSec ? ` \u00b7 ${fmtDur(totalDwellSec)} here` : "") +
    `</div>` +
    (years.length > 1 ? `<div class="tl-hist" role="group" aria-label="Visits by year">${histRows}</div>` : "") +
    drillNote +
    periodsNote +
    `<div class="tl-period-list">${periodsHtml}</div>`;
}

/** Cap on day rows rendered inside one expanded period (a long stay can be huge). */
const MAX_PERIOD_DAYS = 60;

/**
 * Render one consecutive-day **period** ("stay") as a collapsible card. A multi-day
 * period shows a range header (click to expand its day rows); a single-day period is
 * itself the day and opens the replay directly. The most recent period starts expanded.
 */
function renderPeriod(p: DayPeriod): string {
  const single = p.dayCount === 1;
  const open = expandedPeriods.has(p.startDay);
  const range = deps.esc(periodRangeLabel(p.startDay, p.endDay));
  const dwell = p.totalDwellSec ? ` \u00b7 ${fmtDur(p.totalDwellSec)}` : "";

  if (single) {
    // The period IS one day — make the header replay it directly (no expand step).
    const d = p.days[0];
    const types = visitTypeSummary(d);
    return (
      `<div class="tl-period">` +
      `<button class="tl-period-head solo" data-tl="enter-day" data-day="${d.day}" title="Replay this day">` +
      `<span class="tl-period-main"><span class="tl-period-range">${range}</span>` +
      `<span class="tl-period-meta">${d.visits.length} visit${d.visits.length === 1 ? "" : "s"}${dwell}` +
      (types ? ` \u00b7 ${deps.esc(types)}` : "") +
      `</span></span><span class="tl-period-go">\u203a</span></button></div>`
    );
  }

  const shown = p.days.slice(0, MAX_PERIOD_DAYS);
  const dayRows = open ? shown.map(renderDayRow).join("") : "";
  const more =
    open && p.days.length > MAX_PERIOD_DAYS
      ? `<div class="tl-side-more">+${(p.days.length - MAX_PERIOD_DAYS).toLocaleString()} more days in this stay</div>`
      : "";
  const gapNote = p.spanDays > p.dayCount ? ` over ${p.spanDays} days` : "";
  return (
    `<div class="tl-period">` +
    `<button class="tl-period-head${open ? " open" : ""}" data-tl="toggle-period" data-start="${p.startDay}" ` +
    `aria-expanded="${open ? "true" : "false"}" title="${open ? "Collapse" : "Expand"} this stay">` +
    `<span class="tl-period-chev"></span>` +
    `<span class="tl-period-main"><span class="tl-period-range">${range}</span>` +
    `<span class="tl-period-meta">${p.dayCount} day${p.dayCount === 1 ? "" : "s"}${gapNote}${dwell}</span></span>` +
    `</button>` +
    (open ? `<div class="tl-period-days">${dayRows}${more}</div>` : "") +
    `</div>`
  );
}

/** One day inside an expanded period (replayable). */
function renderDayRow(d: { day: string; visits: LocRecord[]; dwellSec: number }): string {
  const types = visitTypeSummary(d);
  return (
    `<div class="tl-day-row" data-tl="enter-day" data-day="${d.day}" title="Replay this day">` +
    `<div class="tl-day-when">${deps.esc(dayLabelKey(d.day))}</div>` +
    `<div class="tl-day-meta">${d.visits.length} visit${d.visits.length === 1 ? "" : "s"}` +
    (d.dwellSec ? ` \u00b7 ${fmtDur(d.dwellSec)}` : "") +
    (types ? ` \u00b7 ${deps.esc(types)}` : "") +
    `</div></div>`
  );
}

/** Up to three distinct place-type labels for a day (e.g. "Home, Work"). */
function visitTypeSummary(d: { visits: LocRecord[] }): string {
  return [...new Set(d.visits.map((v) => placeLabel(v.semanticType)))]
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
}

// --------------------------------------------------------------------------- //
// DAY mode — one day's movement + a time slider that scrubs position
// --------------------------------------------------------------------------- //
const VISIT_COLORS: Partial<Record<VisitType, string>> = {
  HOME: "#34d399",
  INFERRED_HOME: "#34d399",
  WORK: "#60a5fa",
  INFERRED_WORK: "#60a5fa",
};

/** Timeline-rail colour for a day event, by visit place or travel mode. */
function eventColor(r: LocRecord): string {
  if (r.kind === "visit") return VISIT_COLORS[r.semanticType ?? "UNKNOWN"] ?? "#34d399";
  switch (r.actType) {
    case "WALKING":
    case "RUNNING":
      return "#60a5fa"; // on foot — blue
    case "CYCLING":
      return "#fb923c"; // bike — orange
    case "IN_PASSENGER_VEHICLE":
    case "IN_VEHICLE":
    case "MOTORCYCLING":
      return "#22d3ee"; // road vehicle — cyan
    case "IN_BUS":
    case "IN_TRAIN":
    case "IN_SUBWAY":
    case "IN_TRAM":
    case "IN_FERRY":
      return "#a78bfa"; // transit — violet
    case "FLYING":
      return "#f472b6"; // flight — pink
    default:
      return "#94a3b8"; // unknown movement — slate
  }
}

async function enterDay(day: string): Promise<void> {
  const store = deps.getStore();
  if (!store) return;
  clearDayPreview(); // drop any overview hover overlay before switching to day mode
  mode = "day";
  dayKey = day;
  if (areaSelect?.isArmed()) areaSelect.setMode(false);
  const recs = await store.getMonth(monthKey(Date.parse(`${day}T00:00:00Z`)));
  dayRecords = recs.filter((r) => dayKeyOf(r.t) === day).sort((a, b) => a.t - b.t);
  dayOffsetMin = areaOffsetMin(dayRecords);
  daySamples = buildDaySamples(dayRecords);
  scrubT = daySamples.length ? daySamples[0].t : Date.parse(`${day}T00:00:00Z`);
  if (isActive()) renderDay({ fit: true });
}

function renderDay(opts: { fit?: boolean } = {}): void {
  if (!map) return;
  clearHeat();
  clearDayLayer();
  // Hide the overview selection rectangle while replaying a day (renderOverview
  // redraws it on return). Keeps the day map uncluttered.
  if (selLayer) {
    map.removeLayer(selLayer);
    selLayer = null;
  }

  const path = dayRecords.filter((r) => r.kind === "path");
  const dayVisits = dayRecords.filter((r) => r.kind === "visit");
  const moves = dayRecords.filter((r) => r.kind === "move");

  // The day's path as a single orange line (the recorded breadcrumb trail).
  if (path.length >= 2) {
    L.polyline(path.map((p) => [p.lat, p.lon] as L.LatLngExpression), {
      color: "#f97316",
      weight: 3,
      opacity: 0.85,
    }).addTo(dayLayer!);
  }
  // Activity connectors. Google gives an activity as only a start+end point (no
  // route), so a straight A→B line implies a path we don't actually have. Where the
  // breadcrumb trail already covers the activity's time window, that orange line IS
  // the real route — so we draw nothing. We only draw a faint dashed straight line
  // for activities with NO breadcrumb coverage (e.g. a flight or an untracked drive),
  // where it's honestly the only thing we know — and label it as approximate.
  for (const m of moves) {
    if (m.lat2 === undefined || m.lon2 === undefined) continue;
    const end = m.endT ?? m.t;
    const covered = path.some((p) => p.t >= m.t && p.t <= end);
    if (covered) continue;
    L.polyline(
      [
        [m.lat, m.lon],
        [m.lat2, m.lon2],
      ],
      { color: eventColor(m), weight: 2, opacity: 0.55, dashArray: "3 6" },
    )
      .addTo(dayLayer!)
      .bindTooltip(
        `${moveLabel(m.actType)} \u00b7 approximate route (start \u2192 end only)`,
        { className: "tl-tip", direction: "top", offset: [0, -4], opacity: 1 },
      );
  }
  // Visit markers (stops), sized a little by dwell, coloured for home/work.
  for (const v of dayVisits) {
    const dwellH = v.endT ? (v.endT - v.t) / 3.6e6 : 0;
    const r = Math.max(5, Math.min(12, 5 + dwellH));
    L.circleMarker([v.lat, v.lon], {
      radius: r,
      color: VISIT_COLORS[v.semanticType ?? "UNKNOWN"] ?? "#cbd5e1",
      weight: 2,
      fillColor: VISIT_COLORS[v.semanticType ?? "UNKNOWN"] ?? "#64748b",
      fillOpacity: 0.5,
    })
      .addTo(dayLayer!)
      .bindTooltip(
        `${placeLabel(v.semanticType) || "Visit"} \u00b7 ${timeLabel(v.t)}` +
          (v.endT ? `\u2013${timeLabel(v.endT)} (${fmtDur((v.endT - v.t) / 1000)})` : ""),
        { className: "tl-tip", direction: "top", offset: [0, -r], opacity: 1 },
      );
  }

  if (opts.fit) {
    const pts: L.LatLngExpression[] = dayRecords.flatMap((r) =>
      r.lat2 !== undefined && r.lon2 !== undefined
        ? [
            [r.lat, r.lon],
            [r.lat2, r.lon2],
          ]
        : [[r.lat, r.lon]],
    );
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }

  drawScrub();
  renderDayBar();
  renderDaySide();
  document.getElementById("tlBanner")?.classList.remove("hidden");
  setTimeout(() => map?.invalidateSize(), 0);
}

function drawScrub(): void {
  if (!map) return;
  const pos = posAt(daySamples, scrubT);
  if (scrubMarker) {
    scrubMarker.remove();
    scrubMarker = null;
  }
  if (!pos) return;
  scrubMarker = L.circleMarker(pos, {
    radius: 8,
    color: "#fff",
    weight: 3,
    fillColor: "#f97316",
    fillOpacity: 1,
  }).addTo(map);
  const banner = document.getElementById("tlBanner");
  if (banner) banner.innerHTML = `<b>${deps.esc(scrubDayLabel())}</b> \u00b7 ${timeLabel(scrubT)} \u00b7 ${deps.esc(contextAt(scrubT))}`;
  highlightActiveEvent();
}

/**
 * Mark the rail event the scrubber is currently in/just-past as active, so the map
 * marker and the day timeline stay in sync. Toggles a class on the existing rows
 * (no re-render) and keeps the active row in view.
 */
function highlightActiveEvent(): void {
  const rows = document.querySelectorAll<HTMLElement>("#tlSide .tl-ev");
  let active: HTMLElement | null = null;
  rows.forEach((row) => {
    const t = Number(row.dataset.t);
    // The active event is the latest one that has started at or before the scrubber.
    if (Number.isFinite(t) && t <= scrubT) active = row;
  });
  rows.forEach((row) => row.classList.toggle("now", row === active));
  if (active) (active as HTMLElement).scrollIntoView({ block: "nearest" });
}

function renderDayBar(): void {
  const bar = document.getElementById("tlBar");
  if (!bar || !daySamples.length) {
    if (bar) bar.innerHTML = "";
    return;
  }
  const lo = daySamples[0].t;
  const hi = daySamples[daySamples.length - 1].t;
  const idx = visitDays.indexOf(dayKey ?? "");
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < visitDays.length - 1;
  bar.innerHTML =
    `<button class="ghost small tl-btn" data-tl="overview" title="Back to the heatmap">${ICONS.back}Overview</button>` +
    `<button class="tl-step" data-tl="prev-day" ${hasPrev ? "" : "disabled"} title="Previous day with data" aria-label="Previous day">${ICONS.chevLeft}</button>` +
    `<button class="tl-calbtn tl-date" data-tl="open-cal" data-cal="date" title="Jump to a day">${ICONS.calendar}<span>${deps.esc(calBtnLabel(dayKey!))}</span></button>` +
    `<button class="tl-step" data-tl="next-day" ${hasNext ? "" : "disabled"} title="Next day with data" aria-label="Next day">${ICONS.chevRight}</button>` +
    `<input type="range" class="tl-scrub" id="tlScrub" min="${lo}" max="${hi}" step="60000" value="${scrubT}" ` +
    `title="Drag to replay the day" />` +
    `<span class="tl-clock">${timeLabel(scrubT)}${dayDeltaMarker(scrubT)}</span>` +
    tzToggleHtml();
}

/** A compact UTC↔area-local time toggle for the day bar. */
function tzToggleHtml(): string {
  const offH = dayOffsetMin / 60;
  const offStr = `UTC${offH >= 0 ? "+" : "\u2212"}${Math.abs(offH)}`;
  const label = tzArea ? "Local" : "UTC";
  const title = tzArea
    ? `Showing approximate local time for this area (${offStr}). Click for UTC.`
    : `Showing UTC. Click for approximate local time in this area (${offStr}).`;
  return (
    `<button class="tl-tz${tzArea ? " on" : ""}" data-tl="tz" title="${title}" ` +
    `aria-pressed="${tzArea ? "true" : "false"}">${label}</button>`
  );
}

/** Day-panel header: a "back to overview" breadcrumb sitting right above the day title,
 *  close to where the user is reading the rail (the bottom bar's Overview is far away). */
function dayHeadHtml(): string {
  return (
    `<div class="tl-side-head tl-day-head">` +
    `<button class="tl-back" data-tl="overview" title="Back to the overview">${ICONS.back}<span>Overview</span></button>` +
    `<h2>${deps.esc(dayLabelKey(dayKey!))}</h2></div>`
  );
}

function renderDaySide(): void {
  const side = document.getElementById("tlSide");
  if (!side) return;
  if (!dayRecords.length) {
    side.innerHTML =
      dayHeadHtml() +
      `<div class="tl-side-sub">No location data recorded on this day.</div>`;
    return;
  }
  // Chronological timeline: visits and activities on one color-coded rail. Each event
  // is a node on the rail (coloured by place / travel mode); clicking scrubs to it.
  const events = dayRecords
    .filter((r) => r.kind === "visit" || r.kind === "move")
    .map((r) => {
      const color = eventColor(r);
      if (r.kind === "visit") {
        const label = placeLabel(r.semanticType) || "Visit";
        const dur = r.endT ? ` \u00b7 ${fmtDur((r.endT - r.t) / 1000)}` : "";
        return (
          `<div class="tl-ev" data-tl="scrub" data-t="${r.t}" style="--ev:${color}">` +
          `<span class="tl-ev-time">${timeLabel(r.t)}${dayDeltaMarker(r.t)}</span>` +
          `<span class="tl-ev-what"><b>${deps.esc(label)}</b>${dur}</span></div>`
        );
      }
      const dist = r.distanceM ? ` \u00b7 ${fmtKm(r.distanceM)}` : "";
      return (
        `<div class="tl-ev" data-tl="scrub" data-t="${r.t}" style="--ev:${color}">` +
        `<span class="tl-ev-time">${timeLabel(r.t)}${dayDeltaMarker(r.t)}</span>` +
        `<span class="tl-ev-what">${deps.esc(moveLabel(r.actType))}${dist}</span></div>`
      );
    })
    .join("");
  side.innerHTML =
    dayHeadHtml() +
    `<div class="tl-side-sub">${dayRecords.length} records \u2014 click an entry to jump the slider there.</div>` +
    `<div class="tl-ev-list">${events || '<div class="tl-side-sub">Only path breadcrumbs on this day.</div>'}</div>`;
}

/** What was happening at instant `t`: a visit place, an activity, or moving. */
function contextAt(t: number): string {
  for (const r of dayRecords) {
    if (r.kind === "visit" && r.endT && t >= r.t && t <= r.endT)
      return `at ${placeLabel(r.semanticType) || "a place"}`;
    if (r.kind === "move" && r.endT && t >= r.t && t <= r.endT) return moveLabel(r.actType);
  }
  return "moving";
}

// --------------------------------------------------------------------------- //
// Event handling (delegated on #timelineView)
// --------------------------------------------------------------------------- //

/** Delegated hover: preview the day under the pointer; clear when off any day row. */
function onHover(e: Event): void {
  const target = e.target as HTMLElement;
  if (mode === "day") {
    // Day mode: hovering a rail event pins its spot on the map.
    const ev = target.closest<HTMLElement>(".tl-ev");
    if (ev) highlightEventOnMap(Number(ev.dataset.t));
    else clearEventHighlight();
    return;
  }
  if (target.closest("#tlCal")) return; // calendar cells carry data-day too — ignore
  const el = target.closest<HTMLElement>("[data-day]");
  const day = el?.dataset.day ?? null;
  if (day === hoverDay) return;
  if (day) void previewDay(day);
  else clearDayPreview();
}

/** Pin the hovered rail event on the day map: a pulsing ringed marker at its spot. */
function highlightEventOnMap(t: number): void {
  if (!map || !Number.isFinite(t)) return;
  const rec = dayRecords.find((r) => r.t === t && (r.kind === "visit" || r.kind === "move"));
  if (!rec) return;
  clearEventHighlight();
  evHoverLayer = L.layerGroup().addTo(map);
  // A soft outer halo + a solid cored dot in the event's own colour, so the spot
  // reads even over the orange route line. Non-interactive so it never eats clicks.
  L.circleMarker([rec.lat, rec.lon], {
    radius: 15,
    color: eventColor(rec),
    weight: 0,
    fillColor: eventColor(rec),
    fillOpacity: 0.22,
    interactive: false,
  }).addTo(evHoverLayer);
  L.circleMarker([rec.lat, rec.lon], {
    radius: 7,
    color: "#fff",
    weight: 2.5,
    fillColor: eventColor(rec),
    fillOpacity: 1,
    interactive: false,
  }).addTo(evHoverLayer);
}

/** Remove the rail-hover highlight marker. */
function clearEventHighlight(): void {
  if (evHoverLayer && map) {
    map.removeLayer(evHoverLayer);
    evHoverLayer = null;
  }
}

function onClick(e: Event): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tl]");
  if (!el) return;
  const act = el.dataset.tl;
  switch (act) {
    case "import":
      toggleHelp(false); // close the guide if it was open
      deps.onImport();
      break;
    case "help-close":
      // The X closes the floating overlay; in the inline (empty-state) guide it
      // returns to the import call-to-action instead.
      if (document.querySelector(".tl-help-inline")) mountTimelineView();
      else toggleHelp(false);
      break;
    case "help-open":
      showHelpInEmpty();
      break;
    case "help-back":
      mountTimelineView(); // re-render the empty state's import CTA
      break;
    case "drop":
      deps.onDrop();
      break;
    case "clear-sel":
      clearSelection();
      break;
    case "sel-year":
      if (el.dataset.year) {
        const y = Number(el.dataset.year);
        selectedYear = selectedYear === y ? null : y; // toggle the drill-down
        expandNewestVisible(); // the visible period set changed — open its newest stay
        renderOverviewSide();
      }
      break;
    case "sel-year-clear":
      selectedYear = null;
      expandNewestVisible();
      renderOverviewSide();
      break;
    case "toggle-period":
      if (el.dataset.start) {
        const k = el.dataset.start;
        // Accordion: open at most one stay at a time so the panel stays compact.
        if (expandedPeriods.has(k)) expandedPeriods.clear();
        else expandedPeriods = new Set([k]);
        renderOverviewSide();
      }
      break;
    case "range-reset":
      resetRange();
      break;
    case "open-cal":
      openCalendar(el.dataset.cal === "date" ? "date" : "jump", el);
      break;
    case "cal-nav":
      navCalendar(Number(el.dataset.dir));
      break;
    case "cal-pick":
      if (el.dataset.day) {
        const day = el.dataset.day;
        closeCalendar();
        void enterDay(day);
      }
      break;
    case "tz":
      // Flip UTC ↔ area-local and refresh the time readouts in place (no map rebuild).
      tzArea = !tzArea;
      saveTzArea();
      renderDayBar();
      renderDaySide();
      drawScrub();
      break;
    case "enter-day":
      if (el.dataset.day) void enterDay(el.dataset.day);
      break;
    case "overview":
      mode = "overview";
      dayKey = null;
      renderOverview();
      break;
    case "prev-day":
      stepDay(-1);
      break;
    case "next-day":
      stepDay(1);
      break;
    case "scrub":
      if (el.dataset.t) {
        scrubT = Number(el.dataset.t);
        syncScrubInput();
        drawScrub();
      }
      break;
  }
}

function onInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  if (el.id === "tlScrub") {
    scrubT = Number(el.value);
    drawScrub();
    const clock = document.querySelector<HTMLElement>(".tl-clock");
    if (clock) clock.innerHTML = timeLabel(scrubT) + dayDeltaMarker(scrubT);
  } else if (el.id === "tlHeatRadius") {
    tweakHeat("radius", Number(el.value));
  } else if (el.id === "tlHeatDwell") {
    tweakHeat("dwellH", Number(el.value));
  } else if (el.id === "tlRangeLo" || el.id === "tlRangeHi") {
    onRangeInput();
  }
}

function stepDay(dir: -1 | 1): void {
  const idx = visitDays.indexOf(dayKey ?? "");
  if (idx < 0) return;
  const next = visitDays[idx + dir];
  if (next) void enterDay(next);
}

function syncScrubInput(): void {
  const slider = document.getElementById("tlScrub") as HTMLInputElement | null;
  if (slider) slider.value = String(scrubT);
}

// --------------------------------------------------------------------------- //
// Fullscreen (pseudo, via a body class — same pattern as Map/Stats)
// --------------------------------------------------------------------------- //
function setExpanded(on: boolean): void {
  document.body.classList.toggle("tl-expanded", on);
  document.getElementById("btnTlExpand")?.setAttribute("aria-pressed", on ? "true" : "false");
  requestAnimationFrame(() => map?.invalidateSize());
}

// --------------------------------------------------------------------------- //
// "How to export" help overlay — guides the user through getting their Location
// History off their phone. Toggled by the floating "?" button; fills lazily.
// --------------------------------------------------------------------------- //
function toggleHelp(force?: boolean): void {
  const panel = document.getElementById("tlHelp");
  const btn = document.getElementById("btnTlHelp");
  if (!panel) return;
  const show = force ?? panel.classList.contains("hidden");
  if (show && !panel.dataset.filled) {
    panel.innerHTML = helpHtml();
    panel.dataset.filled = "1";
  }
  panel.classList.toggle("hidden", !show);
  btn?.setAttribute("aria-expanded", show ? "true" : "false");
  btn?.classList.toggle("active", show);
}

/** Render the export guide inline in the empty state (the map overlay isn't mounted
 *  there). A back affordance returns to the empty state's import call-to-action. */
function showHelpInEmpty(): void {
  const empty = document.getElementById("timelineEmpty");
  if (!empty) return;
  empty.innerHTML =
    `<div class="tl-help tl-help-inline">${helpHtml()}` +
    `<button type="button" class="ghost small tl-btn" data-tl="help-back">${ICONS.back}Back</button></div>`;
}

/** Markup for the export-guide overlay. Menu names vary by app version, so we lead
 *  with the canonical path and tell the user what label to hunt for. */
function helpHtml(): string {
  const step = (n: number, html: string): string =>
    `<li><span class="tl-help-n">${n}</span><span>${html}</span></li>`;
  return (
    `<div class="tl-help-head">` +
    `<h3>${ICONS.phone}Add your Location History</h3>` +
    `<button class="tl-help-x" data-tl="help-close" aria-label="Close" title="Close">` +
    `<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>` +
    `</button></div>` +
    `<p class="tl-help-sub">Google keeps your timeline <b>on your phone</b> now. Export it there, ` +
    `move the file to this device, then import it \u2014 it never leaves your device after that.</p>` +
    `<ol class="tl-help-steps">` +
    step(1, `Open the <b>Google Maps</b> app on your phone.`) +
    step(2, `Tap your <b>profile picture</b> (top-right) \u2192 <b>Your Timeline</b>.`) +
    step(3, `Open the <b>\u22ee</b> menu \u2192 <b>Location &amp; privacy settings</b>.`) +
    step(4, `Find <b>Export Timeline data</b> and save the <code>.json</code> file.`) +
    step(5, `Send it to this device (Drive, email, cable\u2026), then <b>import</b> it below.`) +
    `</ol>` +
    `<p class="tl-help-note">Menu labels differ a little by app version \u2014 look for ` +
    `\u201c<b>Export Timeline</b>\u201d. On iPhone the path is the same in the Maps app.</p>` +
    `<button type="button" class="primary tl-btn tl-help-import" data-tl="import">${ICONS.import}Import Location History</button>`
  );
}

// --------------------------------------------------------------------------- //
// Layer helpers
// --------------------------------------------------------------------------- //
function clearHeat(): void {
  if (heatLayer && map) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }
}
function clearDayLayer(): void {
  dayLayer?.clearLayers();
  if (scrubMarker) {
    scrubMarker.remove();
    scrubMarker = null;
  }
  clearEventHighlight();
}

// --------------------------------------------------------------------------- //
// Pure helpers
// --------------------------------------------------------------------------- //

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Mon YYYY" for a "YYYY-MM-DD" day key (UTC). */
function monthYear(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Compact label for a period's date range. Collapses shared parts:
 *  - same day      → "Jun 27, 2023"
 *  - same month    → "Jun 8–27, 2023"
 *  - same year     → "Jun 8 – Jul 2, 2023"
 *  - cross-year    → "Dec 28, 2022 – Jan 3, 2023"
 */
function periodRangeLabel(start: string, end: string): string {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (start === end) return `${MONTHS[sm - 1]} ${sd}, ${sy}`;
  if (sy === ey && sm === em) return `${MONTHS[sm - 1]} ${sd}\u2013${ed}, ${sy}`;
  if (sy === ey) return `${MONTHS[sm - 1]} ${sd} \u2013 ${MONTHS[em - 1]} ${ed}, ${sy}`;
  return `${MONTHS[sm - 1]} ${sd}, ${sy} \u2013 ${MONTHS[em - 1]} ${ed}, ${ey}`;
}

/** "Weekday, Mon D, YYYY" for a "YYYY-MM-DD" day key (UTC). */
function dayLabelKey(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Shift an instant into the active display zone (UTC, or the day's area-local). */
function displayMs(ms: number): number {
  return tzArea ? ms + dayOffsetMin * 60000 : ms;
}

/**
 * The weekday/date label for the day the scrubber is *currently* in, in the active
 * display zone — so in area-local mode the banner's bold date visibly rolls to the
 * previous/next day as the scrubber crosses local midnight (the clearest feedback that
 * the offset pushed this moment onto another calendar day). In UTC mode this is always
 * the replay day, so the banner is unchanged.
 */
function scrubDayLabel(): string {
  const localDay = new Date(displayMs(scrubT)).toISOString().slice(0, 10);
  return dayLabelKey(localDay);
}

/** "HH:MM" (24h) for an epoch-ms instant, in the active display zone. */
function timeLabel(ms: number): string {
  return new Date(displayMs(ms)).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

/**
 * A tiny "±Nd" marker when an event's area-local time lands on a different calendar
 * day than the (UTC-bucketed) day being replayed — so a time that wraps past local
 * midnight reads unambiguously instead of looking out of order. Empty in UTC mode.
 */
function dayDeltaMarker(ms: number): string {
  if (!tzArea || !dayKey) return "";
  const localDay = new Date(displayMs(ms)).toISOString().slice(0, 10);
  if (localDay === dayKey) return "";
  const sign = localDay < dayKey ? "\u22121" : "+1";
  return `<sup class="tl-ev-dd" title="${localDay}">${sign}d</sup>`;
}

/** Whole hours/minutes label for a duration, e.g. "2h 05m" / "45m". */
function fmtDur(totalSec: number): string {
  const mins = Math.round(totalSec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Compact distance label from metres. */
function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** Human label for a visit's semantic type ("" for the noisy UNKNOWN bucket). */
function placeLabel(t: VisitType | undefined): string {
  switch (t) {
    case "HOME":
    case "INFERRED_HOME":
      return "Home";
    case "WORK":
    case "INFERRED_WORK":
      return "Work";
    case "SEARCHED_ADDRESS":
      return "Searched place";
    case "ALIASED_LOCATION":
      return "Saved place";
    default:
      return "";
  }
}

/** Title-case a Google activity enum, e.g. IN_PASSENGER_VEHICLE → "Passenger vehicle". */
function moveLabel(t: string | undefined): string {
  if (!t || t === "UNKNOWN_ACTIVITY_TYPE") return "Travelling";
  const s = t.replace(/^IN_/, "").replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
