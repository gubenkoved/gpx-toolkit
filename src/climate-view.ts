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
import { createLocate, type Locate } from "./locate";
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
  /** Transient bottom toast; `err` lengthens + styles it as an error. */
  toast: (msg: string, err?: boolean) => void;
  /** OSM tile attribution credit string. */
  osmAttribution: string;
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
    };
    if (typeof p.lat === "number" && typeof p.lon === "number") {
      picked = { lat: p.lat, lon: p.lon };
    }
    if (typeof p.endYear === "number") endYear = clampYear(p.endYear);
    if (typeof p.startYear === "number") startYear = Math.min(endYear, clampYear(p.startYear));
    if (endYear - startYear + 1 > MAX_SPAN_YEARS) startYear = endYear - (MAX_SPAN_YEARS - 1);
    hour = typeof p.hour === "number" && p.hour >= 0 && p.hour <= 23 ? p.hour : "all";
    // Single-month focus; migrate the old multi-select array to its first entry.
    const m = typeof p.selectedMonth === "number" ? p.selectedMonth : p.months?.[0];
    selectedMonth = typeof m === "number" && m >= 1 && m <= 12 ? m : null;
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
  ensureMap();
  if (picked && days.length === 0 && !loading) {
    void fetchPoint({ fit: true });
  } else {
    renderAll({ fit: false });
  }
}

export function leaveClimateView(): void {
  if (document.body.classList.contains("climate-expanded")) setExpanded(false);
  if (locate?.isActive()) locate.setActive(false);
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
    picked = { lat: e.latlng.lat, lon: e.latlng.lng };
    savePrefs();
    void fetchPoint({ fit: false });
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
    days = res.days;
    samples = flattenSamples(days, cellInfo.lon);
    loading = false;
    setBanner("");
    renderAll({ fit: opts.fit });
  } catch (e) {
    if (token !== loadToken) return;
    loading = false;
    setBanner("");
    deps.toast(`Couldn't load wind history: ${(e as Error)?.message ?? e}`, true);
    renderAll({ fit: false });
  }
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
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //
function onClick(e: Event): void {
  const t = (e.target as HTMLElement)?.closest("[data-cl]") as HTMLElement | null;
  if (!t) return;
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
    el.style.setProperty("--cl-fill", String(v / 24));
    updateHourLabel();
    renderPanels();
    drawMapMarker();
  } else if (el.id === "clYearLo" || el.id === "clYearHi") {
    readYearInputs(el.id);
    updateYearUI();
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

/** Persist + refetch when the year window settles (thumb release or window drag end). */
function commitYears(): void {
  savePrefs();
  void fetchPoint({ fit: false });
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
  const usablePx = track.getBoundingClientRect().width - 15; // track width minus one thumb
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
  if (el) el.style.setProperty("--cl-fill", String(Number(el.value) / 24));
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
    `Hour<input type="range" id="clHour" min="0" max="24" step="1" value="${hv}">` +
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
    `<div class="rf-track">${inp("lo", startYear, "Start year")}${inp("hi", endYear, "End year")}` +
    `<div class="rf-window" id="clYearWin" aria-hidden="true"></div></div>` +
    `<span class="rf-edge" id="clYearTo">${endYear}</span>` +
    `</div>`
  );
}

function renderPanels(): void {
  const side = document.getElementById("clSide");
  if (!side) return;
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
  side.innerHTML =
    summaryHtml(rose) +
    `<section class="cl-sec"><h3 class="cl-h">Wind rose` +
    `<span class="cl-sub">${roseSub} · ${hourLabel()}</span></h3>` +
    `<div class="cl-rose">${roseSvg(rose, BIG_ROSE_SIZE, { labels: true, hover: true })}` +
    `<div class="cl-rose-tip hidden" id="clRoseTip"></div></div>` +
    legendHtml(rose) +
    `</section>` +
    `<section class="cl-sec"><h3 class="cl-h">By month` +
    `<span class="cl-sub">${selectedMonth ? "click again for all" : "click one to focus"}</span></h3>` +
    `<div class="cl-multi">${monthly
      .map((r, i) => miniRoseHtml(r, i + 1))
      .join("")}</div></section>` +
    `<section class="cl-sec"><h3 class="cl-h">Direction by month` +
    `<span class="cl-sub">how often wind comes from each way</span></h3>` +
    heatmapHtml(monthly) +
    `</section>`;
}

function summaryHtml(rose: WindRose): string {
  const prevail = COMPASS_16[Math.round(rose.meanVector.fromDeg / 22.5) % 16];
  // Directional steadiness: the resultant (vector-mean) speed as a fraction of the
  // scalar-mean speed. ~100% = wind almost always from one way; low = very variable.
  // Far more telling than "calm" (sub-1 km/h hours are vanishingly rare).
  const steadiness =
    rose.meanSpeedKmh > 0
      ? Math.round((rose.meanVector.speedKmh / rose.meanSpeedKmh) * 100)
      : 0;
  const monthTxt = selectedMonth ? MONTH_ABBR[selectedMonth - 1] : "all months";
  const card = (val: string, label: string, title = ""): string =>
    `<div class="cl-card"${title ? ` title="${title}"` : ""}><b>${val}</b><span>${label}</span></div>`;
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
    card(`${rose.n.toLocaleString()}`, "hours (filter)") +
    `</div>` +
    `<div class="cl-prov">ERA5 25 km${coords ? ` · ${coords}` : ""} · ${span} · ` +
    `${hourLabel()} · ${monthTxt}</div>` +
    `<div class="cl-prov cl-prov-2">${prov2}</div>`
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
  opts: { labels: boolean; hover?: boolean },
): string {
  const cx = size / 2;
  const cy = size / 2;
  const pad = opts.labels ? 22 : 4;
  const rMax = size / 2 - pad;
  const calmR = Math.max(opts.labels ? 14 : 4, rMax * 0.12);
  const maxCount = roseMaxSector(rose) || 1;
  const scale = (count: number): number => calmR + (rMax - calmR) * (count / maxCount);

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
    `${roseSvg(rose, 72, { labels: false })}` +
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

  // The exact point you clicked, with a white casing so it reads on any basemap.
  L.circleMarker([picked.lat, picked.lon], {
    radius: 5,
    color: "#fff",
    weight: 2,
    fillColor: ACCENT,
    fillOpacity: 1,
    interactive: false,
  }).addTo(markerLayer);
}
