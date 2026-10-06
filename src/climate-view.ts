/**
 * Windalytics — point wind climatology. An isolated, map-centric view (built like
 * `timeline-view.ts`) that talks to the app only through an injected `ClimateDeps`
 * seam. Click a point on the map and it pulls many years of ERA5 reanalysis wind for
 * that spot (cached in the shared wind cache) and mines it into:
 *
 *  - a **wind rose** — where the wind blows FROM, by 16 compass sectors × speed bins;
 *  - **monthly small-multiples** — twelve mini-roses that reveal the seasonal shift;
 *  - a **month × direction heatmap** — frequency as a calendar-of-directions grid;
 *  - the **analysed ERA5 cell** outlined on the map at the picked point.
 *
 * The heavy fetch happens once per point + year-range. The time-of-day slider and the
 * month filter are then pure in-memory re-aggregations (see `windrose.ts`), so the
 * rose morphs instantly as you drag the hour. Local time is approximated from
 * longitude (the cache stays UTC). Wind data is by Open-Meteo.com (CC-BY 4.0).
 */

import L from "leaflet";
import { icon } from "./icons";
import { createLocate, type Locate } from "./locate";
import { createLocationPointIcon } from "./map-core";
import { type RoutePoint, sameRoutePoint, validRoutePoint } from "./router";
import { setViewSubtitle } from "./shell";
import { setSliderFill } from "./slider";
import { statNum } from "./ui";
import type { CellDayWind } from "./weather";
import { cellBounds } from "./weather";
import {
  COMPASS_16,
  flattenSamples,
  monthlyRoses,
  roseFromSamples,
  roseMaxSector,
  SPEED_BIN_LABELS,
  sectorFractions,
  type WindRose,
  type WindSample,
} from "./windrose";

// --------------------------------------------------------------------------- //
// Dependency seam — injected by main.ts at startup (see initClimateView).
// --------------------------------------------------------------------------- //
export interface ClimateDeps {
  /** Fetch ERA5 wind for a point over an inclusive [startYear, endYear] window
   *  (cached); reports progress. */
  getPointWind: (
    lat: number,
    lon: number,
    startYear: number,
    endYear: number,
    onStage?: (msg: string) => void,
  ) => Promise<{ cell: { lat: number; lon: number; gridKm: number }; days: CellDayWind[] }>;
  /** Which ERA5 years are fully cached on disk for the cell serving a point (a
   *  synchronous index probe) — paints the slider's loaded bands and decides which
   *  windows need no network. */
  cachedYears: (lat: number, lon: number) => number[];
  /** Transient bottom toast; `err` lengthens + styles it as an error. */
  toast: (msg: string, err?: boolean) => void;
  /** OSM tile attribution credit string. */
  osmAttribution: string;
  onPointChange?: (point: RoutePoint) => void;
}

let deps: ClimateDeps;

// --------------------------------------------------------------------------- //
// Module state
// --------------------------------------------------------------------------- //
const ACCENT = "#e8883a";
/** Sequential speed-bin palette (calm → strong), parallel to windrose SPEED_BINS. */
const SPEED_COLORS = ["#3a86c8", "#4ea3a0", "#7cc05a", "#e3c04a", "#e0883c", "#d6453d"];
const MONTH_ABBR = [
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

let map: L.Map | null = null;
let markerLayer: L.LayerGroup | null = null;
let locate: Locate | null = null;
let wired = false;
let mounted = false;

/** The user-picked coordinate (where they clicked), or null until they pick one. */
let picked: { lat: number; lon: number } | null = null;
/** The ERA5 grid cell that actually served the point (for the footprint + arrow). */
let cellInfo: { lat: number; lon: number; gridKm: number } | null = null;
/** Raw cached cell-days for the current point + range. */
let days: CellDayWind[] = [];
/** Flattened local-time samples derived from `days` (the aggregation input). */
let samples: WindSample[] = [];
/** The rose currently drawn big (for the hover readout). */
let bigRose: WindRose | null = null;
let loading = false;
/** Bumped on each fetch so a superseded in-flight request discards its result. */
let loadToken = 0;
/** Per-year cell-days held in memory for the current cell — the pool the year window
 *  re-aggregates from while dragging, without touching the cache or the network. */
let yearDays = new Map<number, CellDayWind[]>();
/** Years fully present in the on-disk wind cache for the current cell. */
let cachedYears = new Set<number>();
/** Bumped per point/fetch so a superseded background warm-up stops. */
let warmToken = 0;
/** A frozen rose to compare the live one against: where and when it was taken, plus
 *  its monthly small-multiples (ghosted over the live ones). It survives a point
 *  change — that is how two places compare — and a reload (persisted in prefs). */
interface Pinned {
  rose: WindRose;
  monthly: WindRose[];
  point: { lat: number; lon: number };
  cell: { lat: number; lon: number; gridKm: number } | null;
  startYear: number;
  endYear: number;
  hour: number | "all";
  month: number | null;
}
let pinned: Pinned | null = null;

// -- Settings (persisted) --------------------------------------------------- //
/** Earliest ERA5 year the window slider exposes. */
const MIN_YEAR = 1950;
/** Widest window we let the user pull in one go (keeps the fetch bounded). */
const MAX_SPAN_YEARS = 20;
const NOW_YEAR = new Date().getUTCFullYear();
/** Inclusive [startYear, endYear] window of history to pool. Default: last 5 years. */
let startYear = NOW_YEAR - 4;
let endYear = NOW_YEAR;
/** Selected local hour-of-day (0–23), or "all" for the whole-day climatology. */
let hour: number | "all" = "all";
/** Selected month (1–12) to focus the main rose on, or null for all months. */
let selectedMonth: number | null = null;

/** Clamp a year into the slider domain. */
function clampYear(y: number): number {
  return Math.max(MIN_YEAR, Math.min(NOW_YEAR, Math.round(y)));
}

const PREFS_KEY = "gpx-toolkit.climate";

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as {
      lat?: number;
      lon?: number;
      startYear?: number;
      endYear?: number;
      hour?: number;
      selectedMonth?: number;
      months?: number[];
      pinned?: Pinned;
    };
    if (
      typeof p.lat === "number" &&
      typeof p.lon === "number" &&
      validRoutePoint(p as RoutePoint)
    ) {
      picked = { lat: p.lat, lon: p.lon };
    }
    if (typeof p.endYear === "number") endYear = clampYear(p.endYear);
    if (typeof p.startYear === "number") startYear = Math.min(endYear, clampYear(p.startYear));
    if (endYear - startYear + 1 > MAX_SPAN_YEARS) startYear = endYear - (MAX_SPAN_YEARS - 1);
    hour = typeof p.hour === "number" && p.hour >= 0 && p.hour <= 23 ? p.hour : "all";
    // Single-month focus; migrate the old multi-select array to its first entry.
    const m = typeof p.selectedMonth === "number" ? p.selectedMonth : p.months?.[0];
    selectedMonth = typeof m === "number" && m >= 1 && m <= 12 ? m : null;
    const pin = p.pinned;
    if (
      pin &&
      Array.isArray(pin.rose?.counts) &&
      pin.rose.counts.length === 16 &&
      Array.isArray(pin.monthly) &&
      pin.monthly.length === 12 &&
      pin.point &&
      validRoutePoint(pin.point)
    ) {
      pinned = pin;
    }
  } catch {
    /* private mode / corrupt — ignore */
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        lat: picked?.lat,
        lon: picked?.lon,
        startYear,
        endYear,
        hour: hour === "all" ? -1 : hour,
        selectedMonth,
        pinned: pinned ?? undefined,
      }),
    );
  } catch {
    /* non-fatal */
  }
}

loadPrefs();

// --------------------------------------------------------------------------- //
// Lifecycle (wired from main.ts)
// --------------------------------------------------------------------------- //
export function initClimateView(d: ClimateDeps): void {
  deps = d;
  const root = document.getElementById("climateView");
  if (root && !wired) {
    wired = true;
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("pointermove", onRoseHover);
    root.addEventListener("pointerleave", clearRoseHover);
    document
      .getElementById("btnClExpand")
      ?.addEventListener("click", () =>
        setExpanded(!document.body.classList.contains("climate-expanded")),
      );
    locate = createLocate({
      getMap: () => map,
      button: document.getElementById("btnClLocate"),
      onError: (msg) => deps.toast(msg, true),
    });
    document
      .getElementById("btnClLocate")
      ?.addEventListener("click", () => locate?.setActive(!locate.isActive()));
  }
}

export function mountClimateView(): void {
  if (!deps) return; // not yet wired (boot/HMR order)
  mounted = true;
  ensureMap();
  if (picked) deps.onPointChange?.(picked);
  if (picked && days.length === 0 && !loading) {
    void fetchPoint({ fit: true });
  } else {
    renderAll({ fit: false });
  }
}

export function leaveClimateView(): void {
  mounted = false;
  loadToken += 1;
  loading = false;
  setViewSubtitle("");
  if (document.body.classList.contains("climate-expanded")) setExpanded(false);
  if (locate?.isActive()) locate.setActive(false);
}

/** Apply a linked point before the view mounts, or move the live view to it. */
export function setClimateRoutePoint(next: RoutePoint | null): void {
  if (!next || sameRoutePoint(picked, next)) return;
  picked = next;
  loadToken += 1;
  loading = false;
  cellInfo = null;
  days = [];
  samples = [];
  yearDays = new Map();
  cachedYears = new Set();
  warmToken += 1;
  savePrefs();
  if (!mounted) return;
  map?.setView([next.lat, next.lon], Math.max(map.getZoom(), 7));
  renderAll({ fit: false });
  void fetchPoint({ fit: false });
}

export function climatePoint(): RoutePoint | null {
  return picked;
}

/** True while the climatology map is in pseudo-fullscreen (for the Esc handler). */
export function isClimateExpanded(): boolean {
  return document.body.classList.contains("climate-expanded");
}

/** Collapse climatology fullscreen (Esc handler in main.ts). */
export function collapseClimate(): void {
  setExpanded(false);
}

function setExpanded(on: boolean): void {
  document.body.classList.toggle("climate-expanded", on);
  document.getElementById("btnClExpand")?.setAttribute("aria-pressed", on ? "true" : "false");
  setTimeout(() => map?.invalidateSize(), 0);
}

// --------------------------------------------------------------------------- //
// Map (lazy, once) — dark basemap, click to pick a point.
// --------------------------------------------------------------------------- //
function ensureMap(): void {
  const host = document.getElementById("climateMap");
  if (!host || map) {
    if (map) setTimeout(() => map!.invalidateSize(), 0);
    return;
  }
  map = L.map(host, {
    attributionControl: true,
    zoomControl: true,
    fadeAnimation: false,
  });
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: deps.osmAttribution,
    className: "map-tiles",
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.setView(picked ? [picked.lat, picked.lon] : [30, 0], picked ? 7 : 2);
  map.on("click", (e: L.LeafletMouseEvent) => {
    setClimateRoutePoint({ lat: e.latlng.lat, lon: e.latlng.lng });
    if (picked) deps.onPointChange?.(picked);
  });
  setTimeout(() => map!.invalidateSize(), 0);
}

// --------------------------------------------------------------------------- //
// Fetch + aggregate
// --------------------------------------------------------------------------- //
async function fetchPoint(opts: { fit: boolean }): Promise<void> {
  if (!picked || !deps) return;
  const token = ++loadToken;
  loading = true;
  drawMapMarker();
  setBanner("Reading wind history from Open-Meteo · ERA5…");
  try {
    const res = await deps.getPointWind(picked.lat, picked.lon, startYear, endYear, (m) => {
      if (token === loadToken) setBanner(m);
    });
    if (token !== loadToken) return; // a newer pick/refetch superseded this one
    cellInfo = res.cell;
    storeYearDays(res.days);
    cachedYears = new Set(deps.cachedYears(picked.lat, picked.lon));
    rebuildWindow();
    loading = false;
    setBanner("");
    renderAll({ fit: opts.fit });
    void warmCachedYears();
  } catch (e) {
    if (token !== loadToken) return;
    loading = false;
    setBanner("");
    deps.toast(`Couldn't load wind history: ${(e as Error)?.message ?? e}`, true);
    renderAll({ fit: false });
  }
}

/** File fetched cell-days into the per-year pool. A year that comes back again
 *  (a window re-fetched because a neighbour was missing) REPLACES its entry, so
 *  the pool never holds a day twice. */
function storeYearDays(list: CellDayWind[]): void {
  const byYear = new Map<number, CellDayWind[]>();
  for (const d of list) {
    const y = Number(d.dayISO.slice(0, 4));
    let arr = byYear.get(y);
    if (!arr) {
      arr = [];
      byYear.set(y, arr);
    }
    arr.push(d);
  }
  for (const [y, arr] of byYear) yearDays.set(y, arr);
}

/** True when every year of the current window is already in memory. */
function windowInMemory(): boolean {
  for (let y = startYear; y <= endYear; y++) if (!yearDays.has(y)) return false;
  return true;
}

/** Re-pool `days` + `samples` for [startYear, endYear] from the in-memory years. */
function rebuildWindow(): void {
  const pool: CellDayWind[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const arr = yearDays.get(y);
    if (arr) pool.push(...arr);
  }
  days = pool;
  samples = cellInfo ? flattenSamples(days, cellInfo.lon) : [];
}

/** Pull every other cached year for this cell into memory in the background,
 *  nearest the window first, so dragging the window over loaded history
 *  re-aggregates instantly. Cache reads only — a year qualifies only when it is
 *  fully cached, so this never hits the network. */
async function warmCachedYears(): Promise<void> {
  if (!picked) return;
  const mine = ++warmToken;
  const point = picked;
  const distance = (y: number): number =>
    y < startYear ? startYear - y : y > endYear ? y - endYear : 0;
  const todo = [...cachedYears]
    .filter((y) => !yearDays.has(y))
    .sort((a, b) => distance(a) - distance(b));
  for (const y of todo) {
    if (mine !== warmToken) return;
    try {
      const res = await deps.getPointWind(point.lat, point.lon, y, y);
      if (mine !== warmToken) return;
      storeYearDays(res.days);
    } catch {
      return; // the next explicit window change reports its own error
    }
    paintYearRail();
  }
}

/** While the window is being dragged: re-aggregate instantly when every year in
 *  it is already in memory; otherwise the rail hint says what a release will load. */
let previewRaf = 0;
function previewWindow(): void {
  if (!picked || !windowInMemory() || previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0;
    rebuildWindow();
    renderPanels();
    drawMapMarker();
  });
}

/** "2019–2023 · 08:00 · Jul" — a window + hour + month, for the comparison. */
function whenLabel(s: {
  startYear: number;
  endYear: number;
  hour: number | "all";
  month: number | null;
}): string {
  const h = s.hour === "all" ? "All day" : `${String(s.hour).padStart(2, "0")}:00`;
  const m = s.month ? MONTH_ABBR[s.month - 1] : "all months";
  return `${s.startYear}–${s.endYear} · ${h} · ${m}`;
}
const placeLabel = (p: { lat: number; lon: number }): string =>
  `${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°`;
const sameCell = (
  a: { lat: number; lon: number } | null,
  b: { lat: number; lon: number } | null,
): boolean => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
/** The pinned snapshot describes the same ERA5 cell the live rose is drawn from. */
function pinnedSamePlace(): boolean {
  return !!pinned && (sameRoutePoint(picked, pinned.point) || sameCell(cellInfo, pinned.cell));
}

/** Freeze the live rose (and its twelve monthly roses) with where + when it came from. */
function makeSnapshot(): Pinned | null {
  if (!picked || samples.length === 0) return null;
  return {
    rose: currentRose(),
    monthly: monthlyRoses(samples, hour),
    point: { lat: picked.lat, lon: picked.lon },
    cell: cellInfo ? { ...cellInfo } : null,
    startYear,
    endYear,
    hour,
    month: selectedMonth,
  };
}

/** Swap sides: the live rose becomes the pin, and the view moves to the pinned
 *  place + window (in memory when it is the same cell, else a fetch — cached). */
function swapPinned(): void {
  if (!pinned) return;
  const next = makeSnapshot();
  if (!next) return;
  const target = pinned;
  // Decide "same place" against the OLD pin, before the live rose replaces it.
  const samePlace = sameRoutePoint(picked, target.point) || sameCell(cellInfo, target.cell);
  pinned = next;
  startYear = target.startYear;
  endYear = target.endYear;
  hour = target.hour;
  selectedMonth = target.month;
  picked = { lat: target.point.lat, lon: target.point.lon };
  savePrefs();
  deps.onPointChange?.(picked);
  loadToken += 1;
  loading = false;
  warmToken += 1;
  if (!samePlace) {
    cellInfo = null;
    days = [];
    samples = [];
    yearDays = new Map();
    cachedYears = new Set();
    map?.setView([picked.lat, picked.lon], Math.max(map.getZoom(), 7));
  }
  if (samePlace && windowInMemory()) {
    rebuildWindow();
    renderAll({ fit: false });
    void warmCachedYears();
    return;
  }
  renderAll({ fit: false });
  void fetchPoint({ fit: false });
}

/** The rose for the current hour + month filter (instant; no refetch). */
function currentRose(): WindRose {
  return roseFromSamples(samples, {
    hour,
    months: selectedMonth ? new Set([selectedMonth]) : undefined,
  });
}

function setBanner(msg: string): void {
  const b = document.getElementById("clBanner");
  if (!b) return;
  b.textContent = msg;
  b.classList.toggle("hidden", msg === "");
  b.classList.toggle("busy", msg !== ""); // the banner only ever says what is loading
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //
function onClick(e: Event): void {
  const t = (e.target as HTMLElement)?.closest("[data-cl]") as HTMLElement | null;
  if (!t) return;
  if (t.dataset.cl === "pin") {
    pinned = makeSnapshot();
    savePrefs();
    renderAll({ fit: false });
    return;
  }
  if (t.dataset.cl === "unpin") {
    pinned = null;
    savePrefs();
    renderAll({ fit: false });
    return;
  }
  if (t.dataset.cl === "swap") {
    swapPinned();
    return;
  }
  if (t.dataset.cl !== "month") return;
  const m = Number(t.dataset.m);
  // Click a month's mini-rose to focus it; click the focused one again for all months.
  selectedMonth = selectedMonth === m ? null : m;
  savePrefs();
  renderPanels();
  drawMapMarker();
}

function onInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  if (el.id === "clHour") {
    const v = Number(el.value);
    hour = v >= 24 ? "all" : v;
    setSliderFill(el);
    updateHourLabel();
    renderPanels();
    drawMapMarker();
  } else if (el.id === "clYearLo" || el.id === "clYearHi") {
    readYearInputs(el.id);
    updateYearUI();
    previewWindow();
  }
}

function onChange(e: Event): void {
  const el = e.target as HTMLInputElement;
  if (el.id === "clHour") {
    savePrefs();
  } else if (el.id === "clYearLo" || el.id === "clYearHi") {
    commitYears();
  }
}

/** Read the two year thumbs into startYear/endYear, keeping from ≤ to and span ≤ max. */
function readYearInputs(activeId: string): void {
  const lo = document.getElementById("clYearLo") as HTMLInputElement | null;
  const hi = document.getElementById("clYearHi") as HTMLInputElement | null;
  if (!lo || !hi) return;
  let loY = MIN_YEAR + Number(lo.value);
  let hiY = MIN_YEAR + Number(hi.value);
  if (loY > hiY) {
    // Whichever thumb crossed pins to the other so the window never inverts.
    if (activeId === "clYearLo") hiY = loY;
    else loY = hiY;
  }
  if (hiY - loY + 1 > MAX_SPAN_YEARS) {
    if (activeId === "clYearLo") loY = hiY - (MAX_SPAN_YEARS - 1);
    else hiY = loY + (MAX_SPAN_YEARS - 1);
  }
  startYear = loY;
  endYear = hiY;
  lo.value = String(startYear - MIN_YEAR);
  hi.value = String(endYear - MIN_YEAR);
}

/** Persist when the year window settles (thumb release or window drag end); a
 *  window already in memory just re-aggregates, anything else refetches. */
function commitYears(): void {
  savePrefs();
  if (picked && windowInMemory()) {
    rebuildWindow();
    renderAll({ fit: false });
    return;
  }
  void fetchPoint({ fit: false });
}

/** Paint the loaded-history bands under the year window (cached on disk vs. in
 *  memory) and the hint saying what releasing the window would load. */
function paintYearRail(): void {
  const host = document.getElementById("clYearRuns");
  const hint = document.getElementById("clYearHint");
  if (!host || !hint) return;
  const span = NOW_YEAR - MIN_YEAR || 1;
  // Year y owns the half-step either side of its thumb position on the rail.
  const pct = (idx: number): number => Math.max(0, Math.min(100, (idx / span) * 100));
  let html = "";
  let runStart = -1;
  let runKind = "";
  const flush = (end: number): void => {
    if (runStart < 0 || !runKind) return;
    const left = pct(runStart - MIN_YEAR - 0.5);
    const width = pct(end - MIN_YEAR + 0.5) - left;
    const what =
      runKind === "ready"
        ? "loaded — drag the window over it for instant updates"
        : "cached — loads without network";
    html +=
      `<i class="rf-run rf-run-${runKind}" style="left:${left.toFixed(2)}%;` +
      `width:${width.toFixed(2)}%" title="${runStart}–${end}: ${what}"></i>`;
  };
  for (let y = MIN_YEAR; y <= NOW_YEAR; y++) {
    const kind = yearDays.has(y) ? "ready" : cachedYears.has(y) ? "cached" : "";
    if (kind !== runKind) {
      flush(y - 1);
      runStart = y;
      runKind = kind;
    }
  }
  flush(NOW_YEAR);
  host.innerHTML = html;

  if (!picked) {
    hint.textContent = "";
    hint.classList.remove("pending");
    return;
  }
  const missing: number[] = [];
  for (let y = startYear; y <= endYear; y++) if (!yearDays.has(y)) missing.push(y);
  if (missing.length === 0) {
    hint.textContent = pinned
      ? "Comparing · move the window, or pick another spot on the map"
      : "Drag the window · updates live";
    hint.classList.remove("pending");
    return;
  }
  const fromCache = missing.filter((y) => cachedYears.has(y)).length;
  const net = missing.length - fromCache;
  const yrs = (n: number): string => `${n} year${n === 1 ? "" : "s"}`;
  hint.textContent =
    net > 0
      ? `Release to fetch ${yrs(net)} from Open-Meteo${fromCache ? ` (+${fromCache} cached)` : ""}`
      : `Release to load ${yrs(missing.length)} from the cache`;
  hint.classList.add("pending");
}

/** Refresh the year slider's edge labels + accent fill from startYear/endYear. */
function updateYearUI(): void {
  const total = NOW_YEAR - MIN_YEAR || 1;
  const track = document.querySelector<HTMLElement>("#clBar .cl-years .rf-track");
  if (track) {
    track.style.setProperty("--rf-lo", String((startYear - MIN_YEAR) / total));
    track.style.setProperty("--rf-hi", String((endYear - MIN_YEAR) / total));
  }
  const from = document.getElementById("clYearFrom");
  const to = document.getElementById("clYearTo");
  if (from) from.textContent = String(startYear);
  if (to) to.textContent = String(endYear);
  paintYearRail();
}

/** Wire the draggable middle of the year window (slide the whole span at once). */
function wireYearWindow(): void {
  const win = document.getElementById("clYearWin");
  win?.addEventListener("pointerdown", (e) => onYearWindowDrag(win, e as PointerEvent));
}

/** Drag the window between the thumbs to slide the year span without resizing it. */
function onYearWindowDrag(win: HTMLElement, e: PointerEvent): void {
  const track = win.parentElement;
  const lo = document.getElementById("clYearLo") as HTMLInputElement | null;
  const hi = document.getElementById("clYearHi") as HTMLInputElement | null;
  const total = NOW_YEAR - MIN_YEAR;
  if (!track || !lo || !hi || total <= 0) return;
  const usablePx = track.getBoundingClientRect().width - 16; // track width minus one thumb (--rf-thumb)
  if (usablePx <= 0) return;
  const startX = e.clientX;
  const startLo = startYear - MIN_YEAR;
  const span = endYear - startYear; // held constant for the whole drag
  win.classList.add("dragging");
  try {
    win.setPointerCapture(e.pointerId);
  } catch {
    /* older engines may reject capture; mouse drag still works */
  }
  const move = (ev: PointerEvent): void => {
    const dIdx = Math.round(((ev.clientX - startX) / usablePx) * total);
    const newLo = Math.max(0, Math.min(startLo + dIdx, total - span));
    startYear = MIN_YEAR + newLo;
    endYear = startYear + span;
    lo.value = String(newLo);
    hi.value = String(newLo + span);
    updateYearUI();
    previewWindow();
    ev.preventDefault();
  };
  const endDrag = (): void => {
    win.classList.remove("dragging");
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", endDrag);
    win.removeEventListener("pointercancel", endDrag);
    commitYears();
  };
  win.addEventListener("pointermove", move);
  win.addEventListener("pointerup", endDrag);
  win.addEventListener("pointercancel", endDrag);
  e.preventDefault();
}

function updateHourLabel(): void {
  const out = document.getElementById("clHourOut");
  if (out) out.textContent = hourLabel();
}

/** Drive the hour slider's left accent fill (0..1), so its track matches the rf one. */
function updateHourFill(): void {
  const el = document.getElementById("clHour") as HTMLInputElement | null;
  if (el) setSliderFill(el);
}

function hourLabel(): string {
  return hour === "all" ? "All day" : `${String(hour).padStart(2, "0")}:00`;
}

// --------------------------------------------------------------------------- //
// Render
// --------------------------------------------------------------------------- //
function renderAll(opts: { fit: boolean }): void {
  renderControls();
  renderPanels();
  drawMapMarker();
  if (opts.fit && map && cellInfo) {
    map.fitBounds(cellBounds(cellInfo.lat, cellInfo.lon, cellInfo.gridKm * 6));
  }
}

function renderControls(): void {
  const bar = document.getElementById("clBar");
  if (!bar) return;
  const hv = hour === "all" ? 24 : hour;
  bar.innerHTML =
    yearSliderHtml() +
    `<label class="cl-ctl" title="Sample only this local hour each day (drag past the end for the whole day)">` +
    `Hour<input type="range" class="uslider" id="clHour" min="0" max="24" step="1" value="${hv}">` +
    `<output id="clHourOut">${hourLabel()}</output></label>`;
  wireYearWindow();
  updateYearUI();
  updateHourFill();
}

/** The dual-thumb year window (two overlaid inputs + a draggable middle), reusing the
 *  app's shared `.rf-*` slider look. Domain is MIN_YEAR..this year; span ≤ MAX_SPAN. */
function yearSliderHtml(): string {
  const total = NOW_YEAR - MIN_YEAR;
  const inp = (edge: "lo" | "hi", year: number, label: string): string =>
    `<input type="range" class="rf-${edge}" id="clYear${edge === "lo" ? "Lo" : "Hi"}" ` +
    `min="0" max="${total}" step="1" value="${year - MIN_YEAR}" aria-label="${label}">`;
  return (
    `<div class="range-filter cl-years" ` +
    `title="Drag the thumbs to choose a span (max ${MAX_SPAN_YEARS} yr), or the middle to slide it">` +
    `<span class="rf-edge" id="clYearFrom">${startYear}</span>` +
    `<div class="rf-track"><div class="rf-cached" id="clYearRuns" aria-hidden="true"></div>` +
    `${inp("lo", startYear, "Start year")}${inp("hi", endYear, "End year")}` +
    `<div class="rf-window" id="clYearWin" aria-hidden="true"></div></div>` +
    `<span class="rf-edge" id="clYearTo">${endYear}</span>` +
    `</div>` +
    `<div class="cl-year-meta"><span class="cl-year-hint" id="clYearHint"></span></div>`
  );
}

function renderPanels(): void {
  const side = document.getElementById("clSide");
  if (!side) return;
  setViewSubtitle(picked && cellInfo ? subtitleText() : "");
  if (!picked) {
    side.innerHTML =
      `<div class="cl-hint"><b>Pick a point.</b> Click anywhere on the map to pull ` +
      `years of historical wind for that spot and see where the wind blows from — ` +
      `by hour, by month, across the seasons.</div>`;
    return;
  }
  if (loading && samples.length === 0) {
    side.innerHTML = `<div class="cl-hint">Reading wind history…</div>`;
    return;
  }
  const rose = currentRose();
  if (rose.n === 0) {
    side.innerHTML =
      `<div class="cl-hint">No wind data for this point and filter. ` +
      `Try a different spot, hour, or month — or widen the year range.</div>`;
    return;
  }

  const monthly = monthlyRoses(samples, hour);
  const roseSub = selectedMonth ? MONTH_ABBR[selectedMonth - 1] : "all months";
  bigRose = rose;
  const pinBtn = pinned
    ? ""
    : `<button type="button" class="small ghost cl-pinbtn" data-cl="pin" ` +
      `title="Freeze this rose, then move the window — or pick another spot on the map — to compare against it">` +
      `${icon("tack")}Pin to compare</button>`;
  side.innerHTML =
    summaryHtml(rose) +
    `<section class="cl-sec"><div class="cl-head"><h3 class="cl-h">Wind rose` +
    `<span class="cl-sub">${roseSub} · ${hourLabel()}</span></h3>${pinBtn}</div>` +
    `<div class="cl-rose">${roseSvg(rose, BIG_ROSE_SIZE, { labels: true, hover: true, ghost: pinned?.rose })}` +
    `<div class="cl-rose-tip hidden" id="clRoseTip"></div></div>` +
    legendHtml(rose) +
    compareHtml(rose) +
    `</section>` +
    `<section class="cl-sec"><h3 class="cl-h">By month` +
    `<span class="cl-sub">${selectedMonth ? "click again for all" : "click one to focus"}</span></h3>` +
    `<div class="cl-multi">${monthly
      .map((r, i) => miniRoseHtml(r, i + 1))
      .join("")}</div></section>` +
    `<section class="cl-sec"><h3 class="cl-h">Direction by month` +
    `<span class="cl-sub">share of hours per direction</span></h3>` +
    heatmapHtml(monthly) +
    `</section>`;
}

/** Prevailing sector + directional steadiness of a rose. Steadiness is the
 *  resultant (vector-mean) speed as a fraction of the scalar-mean speed: ~100% =
 *  wind almost always from one way; low = very variable. Far more telling than
 *  "calm" (sub-1 km/h hours are vanishingly rare). */
function roseStats(rose: WindRose): { prevail: string; steadiness: number } {
  const prevail = COMPASS_16[Math.round(rose.meanVector.fromDeg / 22.5) % 16];
  const steadiness =
    rose.meanSpeedKmh > 0
      ? Math.round((rose.meanVector.speedKmh / rose.meanSpeedKmh) * 100)
      : 0;
  return { prevail, steadiness };
}

/** Top-bar subtitle: dataset · cell · the years actually pooled. */
function subtitleText(): string {
  const st = datasetStats();
  const coords = cellInfo ? `${cellInfo.lat.toFixed(2)}°, ${cellInfo.lon.toFixed(2)}°` : "";
  const span = st.hours > 0 ? `${st.minY}–${st.maxY}` : `${startYear}–${endYear}`;
  return `ERA5 25 km${coords ? ` · ${coords}` : ""} · ${span}`;
}

/** The comparison card under the rose: pinned vs live, side by side, with the
 *  differences spelled out — where, when, prevailing direction, mean speed,
 *  steadiness, calm share. Swap trades sides; × drops the pin. */
function compareHtml(rose: WindRose): string {
  if (!pinned || !picked) return "";
  const a = roseStats(pinned.rose);
  const b = roseStats(rose);
  const samePlace = pinnedSamePlace();
  const pinWhen = whenLabel(pinned);
  const nowWhen = whenLabel({ startYear, endYear, hour, month: selectedMonth });
  const sameWhen = pinWhen === nowWhen;
  const kind = samePlace ? "periods" : sameWhen ? "places" : "places &amp; periods";
  const same = (what: string): string =>
    `<td colspan="2" class="cl-cmp-same">same ${what}</td>`;
  const delta = (d: number, digits: number, unit = ""): string => {
    const r = Number(d.toFixed(digits));
    if (r === 0) return `<i class="cl-cmp-d zero">±0</i>`;
    return `<i class="cl-cmp-d">${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(digits)}${unit}</i>`;
  };
  const row = (label: string, pin: string, now: string, d = ""): string =>
    `<tr><th scope="row">${label}</th><td>${pin}</td><td>${now}${d}</td></tr>`;
  const calm = (r: WindRose): number => (r.n > 0 ? (r.calm / r.n) * 100 : 0);
  return (
    `<div class="cl-cmp"><div class="cl-cmp-head"><b>${icon("tack")}Comparing ${kind}</b>` +
    `<button type="button" class="small ghost" data-cl="swap" title="Trade sides: pin the live rose and move the view to the pinned place and window">${icon("swap")}Swap</button>` +
    `<button type="button" class="cl-pinned-x" data-cl="unpin" aria-label="Unpin" title="Unpin">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>` +
    `<table class="cl-cmp-t"><thead><tr><td></td>` +
    `<th scope="col"><i class="cl-sw-pin"></i>Pinned</th><th scope="col"><i class="cl-sw-now"></i>Now</th></tr></thead><tbody>` +
    `<tr><th scope="row">Where</th>${samePlace ? same("spot") : `<td>${placeLabel(pinned.point)}</td><td>${placeLabel(picked)}</td>`}</tr>` +
    `<tr><th scope="row">When</th>${sameWhen ? same("window") : `<td>${pinWhen}</td><td>${nowWhen}</td>`}</tr>` +
    row("From", a.prevail, b.prevail) +
    row(
      "Mean",
      `${pinned.rose.meanSpeedKmh.toFixed(1)} km/h`,
      `${rose.meanSpeedKmh.toFixed(1)} km/h`,
      delta(rose.meanSpeedKmh - pinned.rose.meanSpeedKmh, 1),
    ) +
    row(
      "Steady",
      `${a.steadiness}%`,
      `${b.steadiness}%`,
      delta(b.steadiness - a.steadiness, 0, " pts"),
    ) +
    row(
      "Calm",
      `${calm(pinned.rose).toFixed(1)}%`,
      `${calm(rose).toFixed(1)}%`,
      delta(calm(rose) - calm(pinned.rose), 1, " pts"),
    ) +
    `</tbody></table></div>`
  );
}

function summaryHtml(rose: WindRose): string {
  const { prevail, steadiness } = roseStats(rose);
  const card = (val: string, label: string, title = ""): string =>
    statNum({ value: val, label, title: title || undefined, small: true });
  const st = datasetStats();
  const coords = cellInfo ? `${cellInfo.lat.toFixed(2)}°, ${cellInfo.lon.toFixed(2)}°` : "";
  const span = st.hours > 0 ? `${st.minY}–${st.maxY}` : `${startYear}–${endYear}`;
  const prov2 =
    `${compact(st.hours)} h over ${st.good.toLocaleString()} days` +
    (st.noData > 0 ? ` · ${st.noData} no-data` : "");
  return (
    `<div class="cl-cards">` +
    card(`${prevail}`, "prevailing from") +
    card(`${rose.meanSpeedKmh.toFixed(1)}`, "mean km/h") +
    card(
      `${steadiness}%`,
      "steadiness",
      "How consistently the wind comes from one direction — 100% = always the same way, low = variable.",
    ) +
    card(`${rose.n.toLocaleString()}`, "hours sampled") +
    `</div>` +
    // Dataset · cell · years live in the top bar's subtitle — repeated here only where
    // that subtitle is hidden (phones; see .cl-prov-dup). Hour + month head the rose.
    `<div class="cl-prov"><span class="cl-prov-dup">ERA5 25 km${coords ? ` · ${coords}` : ""} · ${span} · </span>${prov2}</div>`
  );
}

/** Whole-dataset counts for the provenance line (independent of the hour/month filter). */
function datasetStats(): {
  good: number;
  noData: number;
  hours: number;
  minY: number;
  maxY: number;
} {
  let good = 0;
  let noData = 0;
  for (const d of days) {
    if (d.noData) noData++;
    else good++;
  }
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    if (s.year < minY) minY = s.year;
    if (s.year > maxY) maxY = s.year;
  }
  return { good, noData, hours: samples.length, minY, maxY };
}

/** Compact integer formatting: 4380 → "4.4k", 43800 → "44k". */
function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

function legendHtml(rose: WindRose): string {
  const calmPct = rose.n > 0 ? Math.round((rose.calm / rose.n) * 100) : 0;
  const swatches = SPEED_BIN_LABELS.map(
    (lbl, b) =>
      `<span class="cl-leg"><i style="background:${SPEED_COLORS[b]}"></i>${lbl}</span>`,
  ).join("");
  return (
    `<div class="cl-legend"><span class="cl-leg-t">km/h</span>${swatches}` +
    `<span class="cl-leg cl-leg-calm"><i></i>calm ${calmPct}%</span></div>`
  );
}

// -- SVG wind rose ---------------------------------------------------------- //
function polar(cx: number, cy: number, r: number, aDeg: number): [number, number] {
  const a = (aDeg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

/** An annular sector (wedge) path from radius r0..r1 over angles a0..a1 (deg from N). */
function wedge(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string {
  const [x0o, y0o] = polar(cx, cy, r1, a0);
  const [x1o, y1o] = polar(cx, cy, r1, a1);
  const [x1i, y1i] = polar(cx, cy, r0, a1);
  const [x0i, y0i] = polar(cx, cy, r0, a0);
  const f = (n: number): string => n.toFixed(2);
  return (
    `M${f(x0o)} ${f(y0o)} A${f(r1)} ${f(r1)} 0 0 1 ${f(x1o)} ${f(y1o)} ` +
    `L${f(x1i)} ${f(y1i)} A${f(r0)} ${f(r0)} 0 0 0 ${f(x0i)} ${f(y0i)} Z`
  );
}

const BIG_ROSE_SIZE = 280;

function roseSvg(
  rose: WindRose,
  size: number,
  opts: { labels: boolean; hover?: boolean; ghost?: WindRose; ghostMini?: boolean },
): string {
  const cx = size / 2;
  const cy = size / 2;
  const pad = opts.labels ? 22 : 4;
  const rMax = size / 2 - pad;
  const calmR = Math.max(opts.labels ? 14 : 4, rMax * 0.12);
  // Radius scales with a sector's share of hours. Alone, that is count/maxCount;
  // with a ghost rose both share the larger of the two peak shares, so a 5-year
  // window compares fairly against a pinned 20-year one.
  const share = (r: WindRose, count: number): number => (r.n > 0 ? count / r.n : 0);
  const ghost = opts.ghost;
  const peak =
    Math.max(
      share(rose, roseMaxSector(rose)),
      ghost ? share(ghost, roseMaxSector(ghost)) : 0,
    ) || 1;
  const scaleOf = (r: WindRose, count: number): number =>
    calmR + (rMax - calmR) * (share(r, count) / peak);
  const scale = (count: number): number => scaleOf(rose, count);

  let rings = "";
  if (opts.labels) {
    for (const frac of [1 / 3, 2 / 3, 1]) {
      rings += `<circle cx="${cx}" cy="${cy}" r="${(calmR + (rMax - calmR) * frac).toFixed(
        1,
      )}" class="cl-ring"/>`;
    }
  }

  let wedges = "";
  for (let i = 0; i < 16; i++) {
    const aCenter = i * 22.5;
    const a0 = aCenter - 9;
    const a1 = aCenter + 9;
    let cum = 0;
    for (let b = 0; b < rose.counts[i].length; b++) {
      const c = rose.counts[i][b];
      if (c <= 0) continue;
      const r0 = scale(cum);
      const r1 = scale(cum + c);
      cum += c;
      wedges += `<path d="${wedge(cx, cy, r0, r1, a0, a1)}" fill="${SPEED_COLORS[b]}"/>`;
    }
  }
  let ghostPaths = "";
  if (ghost) {
    for (let i = 0; i < 16; i++) {
      let total = 0;
      for (const c of ghost.counts[i]) total += c;
      if (total <= 0) continue;
      const aCenter = i * 22.5;
      const d = wedge(cx, cy, calmR, scaleOf(ghost, total), aCenter - 9, aCenter + 9);
      ghostPaths += `<path d="${d}" class="cl-ghost${opts.ghostMini ? " cl-ghost-mini" : ""}"/>`;
    }
  }

  let labels = "";
  if (opts.labels) {
    const card: [string, number][] = [
      ["N", 0],
      ["E", 90],
      ["S", 180],
      ["W", 270],
    ];
    for (const [lbl, deg] of card) {
      const [lx, ly] = polar(cx, cy, rMax + 11, deg);
      labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(
        1,
      )}" class="cl-card-lbl" text-anchor="middle" dominant-baseline="middle">${lbl}</text>`;
    }
  }

  return (
    `<svg viewBox="0 0 ${size} ${size}" class="cl-rose-svg" ` +
    `width="${size}" height="${size}" aria-hidden="true">` +
    rings +
    `<circle cx="${cx}" cy="${cy}" r="${calmR.toFixed(1)}" class="cl-calm"/>` +
    wedges +
    ghostPaths +
    (opts.hover ? `<g class="cl-rose-hov"></g>` : "") +
    labels +
    `</svg>`
  );
}

// -- Hover readout on the big rose: highlight the sector + show its speed mix -- //
/** Map the cursor onto a rose sector, highlight it, and show a per-speed tooltip. */
function onRoseHover(e: Event): void {
  if (!bigRose) return;
  const pe = e as PointerEvent;
  const svg = document.querySelector<SVGSVGElement>("#clSide .cl-rose svg.cl-rose-svg");
  const tip = document.getElementById("clRoseTip");
  const hov = svg?.querySelector<SVGGElement>(".cl-rose-hov");
  if (!svg || !tip || !hov) return;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return;

  // Map the cursor into the SVG's viewBox (it renders responsively, so rescale).
  const size = BIG_ROSE_SIZE;
  const scale = size / rect.width;
  const x = (pe.clientX - rect.left) * scale;
  const y = (pe.clientY - rect.top) * scale;
  const c = size / 2;
  const dx = x - c;
  const dy = y - c;
  const r = Math.hypot(dx, dy);
  const rMax = size / 2 - 22;
  const calmR = Math.max(14, rMax * 0.12);
  // Outside the rose disc (in the calm hub or past the rim) → no sector.
  if (r < calmR - 2 || r > rMax + 3) {
    clearRoseHover();
    return;
  }
  const ang = (Math.atan2(dx, -dy) * (180 / Math.PI) + 360) % 360;
  const sector = ((Math.round(ang / 22.5) % 16) + 16) % 16;

  hov.innerHTML = `<path class="cl-rose-hi" d="${wedge(
    c,
    c,
    calmR,
    rMax,
    sector * 22.5 - 11.25,
    sector * 22.5 + 11.25,
  )}"/>`;
  tip.innerHTML = roseTipHtml(bigRose, sector);
  tip.classList.remove("hidden");

  // Place the tooltip beside the cursor, flipping to the left on the right half so it
  // never spills out of the panel.
  const wrap = svg.parentElement as HTMLElement;
  const wr = wrap.getBoundingClientRect();
  const tx = pe.clientX - wr.left;
  const ty = pe.clientY - wr.top;
  const onRight = tx > wr.width / 2;
  tip.style.left = onRight ? "auto" : `${tx + 14}px`;
  tip.style.right = onRight ? `${wr.width - tx + 14}px` : "auto";
  tip.style.top = `${ty}px`;
}

function clearRoseHover(): void {
  const hov = document.querySelector("#clSide .cl-rose-hov");
  if (hov) hov.innerHTML = "";
  document.getElementById("clRoseTip")?.classList.add("hidden");
}

/** Tooltip body for one sector: direction, how often, and the speed-bin mix. */
function roseTipHtml(rose: WindRose, sector: number): string {
  const counts = rose.counts[sector];
  let secTotal = 0;
  for (const v of counts) secTotal += v;
  const freq = rose.total > 0 ? (secTotal / rose.total) * 100 : 0;
  const mids = [2.5, 7.5, 12.5, 17.5, 25, 35];
  let wsum = 0;
  for (let b = 0; b < counts.length; b++) wsum += counts[b] * mids[b];
  const mean = secTotal > 0 ? wsum / secTotal : 0;
  const rows = SPEED_BIN_LABELS.map((lbl, b) => {
    if (counts[b] <= 0) return "";
    const pct = secTotal > 0 ? Math.round((counts[b] / secTotal) * 100) : 0;
    return (
      `<div class="cl-tip-row"><i style="background:${SPEED_COLORS[b]}"></i>` +
      `<span class="cl-tip-bl">${lbl}</span><span class="cl-tip-bv">${pct}%</span></div>`
    );
  }).join("");
  return (
    `<div class="cl-tip-h">${COMPASS_16[sector]} · ${sector * 22.5}°</div>` +
    `<div class="cl-tip-sub">${freq.toFixed(1)}% of hours · mean ~${mean.toFixed(0)} km/h</div>` +
    (rows
      ? `<div class="cl-tip-bars">${rows}</div>`
      : `<div class="cl-tip-sub">no wind here</div>`)
  );
}

function miniRoseHtml(rose: WindRose, monthNum: number): string {
  const label = MONTH_ABBR[monthNum - 1];
  const empty = rose.total === 0 ? " cl-mini-empty" : "";
  const on = selectedMonth === monthNum;
  const title = on
    ? `${label}: focused — click again to show all months`
    : `Focus the wind rose on ${label}`;
  return (
    `<button type="button" class="cl-mini${empty}${on ? " cl-mini-sel" : ""}" ` +
    `data-cl="month" data-m="${monthNum}" aria-pressed="${on}" title="${title}">` +
    `${roseSvg(rose, 72, { labels: false, ghost: pinned?.monthly[monthNum - 1], ghostMini: true })}` +
    `<span class="cl-mini-cap">${label}<small>${compact(rose.n)}</small></span></button>`
  );
}

// -- SVG month × direction heatmap ------------------------------------------ //
function heatmapHtml(monthly: WindRose[]): string {
  const fr = monthly.map(sectorFractions);
  let maxF = 0;
  for (const row of fr) for (const v of row) if (v > maxF) maxF = v;
  if (maxF <= 0) maxF = 1;
  const cell = 15;
  const labelW = 30;
  const topH = 14;
  const w = labelW + 16 * cell;
  const h = topH + 12 * cell;
  let rects = "";
  for (let m = 0; m < 12; m++) {
    for (let d = 0; d < 16; d++) {
      const a = fr[m][d] / maxF;
      if (a <= 0.001) continue;
      const x = labelW + d * cell;
      const y = topH + m * cell;
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${ACCENT}" fill-opacity="${a.toFixed(
        3,
      )}"><title>${MONTH_ABBR[m]} · ${COMPASS_16[d]} · ${Math.round(
        fr[m][d] * 100,
      )}%</title></rect>`;
    }
  }
  let colLbl = "";
  for (const [lbl, d] of [
    ["N", 0],
    ["E", 4],
    ["S", 8],
    ["W", 12],
  ] as [string, number][]) {
    colLbl += `<text x="${labelW + d * cell + cell / 2}" y="${topH - 4}" class="cl-hm-lbl" text-anchor="middle">${lbl}</text>`;
  }
  let rowLbl = "";
  for (let m = 0; m < 12; m++) {
    rowLbl += `<text x="${labelW - 4}" y="${topH + m * cell + cell / 2}" class="cl-hm-lbl" text-anchor="end" dominant-baseline="middle">${MONTH_ABBR[m]}</text>`;
  }
  return (
    `<div class="cl-heat"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
    `class="cl-heat-svg" aria-hidden="true">${colLbl}${rowLbl}${rects}</svg></div>`
  );
}

// -- Map marker: the analysed grid cell + the picked point ----------------- //
function drawMapMarker(): void {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  if (!picked) return;

  // The ERA5 cell the wind is sampled from — outlined with the same subtle, dashed
  // language as the ride map's wind-cell footprint (kept in the accent colour). (No
  // prevailing-direction arrow: the full wind rose already shows that, in detail.)
  if (cellInfo) {
    L.rectangle(cellBounds(cellInfo.lat, cellInfo.lon, cellInfo.gridKm), {
      color: ACCENT,
      weight: 1,
      opacity: 0.6,
      dashArray: "5 4",
      fillColor: ACCENT,
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(markerLayer);
  }

  // The pinned place, when it is a different one: its cell and a hollow dashed
  // marker in the compare colour, labelled so the two never get confused.
  if (pinned && !pinnedSamePlace()) {
    const cmp =
      getComputedStyle(document.documentElement).getPropertyValue("--cmp").trim() || "#dfe6f1";
    if (pinned.cell) {
      L.rectangle(cellBounds(pinned.cell.lat, pinned.cell.lon, pinned.cell.gridKm), {
        color: cmp,
        weight: 1,
        opacity: 0.55,
        dashArray: "3 4",
        fill: false,
        interactive: false,
      }).addTo(markerLayer);
    }
    L.marker([pinned.point.lat, pinned.point.lon], {
      icon: L.divIcon({
        html: '<span class="cl-pin-dot" aria-hidden="true"></span>',
        className: "cl-pin-marker",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      interactive: false,
      keyboard: false,
    })
      .bindTooltip("Pinned", {
        permanent: true,
        direction: "right",
        offset: [10, 0],
        className: "cl-pin-tip",
      })
      .addTo(markerLayer);
  }

  // The exact point the user picked: the same shared analysis-point marker used
  // by Forecast. The ERA5 cell outline remains specific to this view.
  L.marker([picked.lat, picked.lon], {
    icon: createLocationPointIcon(),
    interactive: false,
    keyboard: false,
  }).addTo(markerLayer);
}
