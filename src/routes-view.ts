/**
 * GPX Toolkit — the Routes view (`#routesView`): routes you might ride one day,
 * a planner to draw them, and a simulator that rides them through the weather.
 *
 * Two screens in one view:
 *  - **the list** — every saved route (planned or imported from GPX) as a card with
 *    its shape; "New route" and "Import GPX" lead in;
 *  - **a route** — the map and a side panel. Planning: click the map to set the
 *    start, then the finish (each click after that extends the route); drag a point
 *    to move it, click the line to add a via there, right-click (or ×) to drop one.
 *    Each leg follows the paths with the chosen BRouter profile (routing.ts), legs
 *    are re-routed only when their ends move, and edits save as you go. Simulating:
 *    pick a departure day and time — the wind along the route at the moment you'd
 *    reach each stretch sets your speed there (route-sim.ts), the line is coloured
 *    head/tailwind, arrows show where the wind blows, and a strip charts the ride
 *    time for every departure of the day. The weather is fetched once per route and
 *    day range, so dragging the departure re-simulates in memory, instantly.
 *
 * Departure times are wall-clock times at the route's start (its time zone via
 * tz.ts). Behind a `RoutesViewDeps` seam: the route store, the controller's
 * `routeWeather`, toasts and the file save are injected.
 */

import L from "leaflet";
import { confirmDialog } from "./confirm";
import { openDatePicker } from "./datepicker";
import type { LocationResult } from "./forecast";
import { fmtDuration, fmtElevation, fmtKmDetail, fmtSpeed } from "./format";
import { extractGpxName } from "./gpx-source";
import { icon } from "./icons";
import { createInteractiveMap } from "./map-core";
import {
  buildCourse,
  type Course,
  type Departure,
  effectiveSpeedModel,
  readSpeedFit,
  readSpeedPrefs,
  type SimResult,
  type SpeedModel,
  saveSpeedPrefs,
  simulate,
  sweepDepartures,
  type WeatherAt,
  weatherFromCells,
} from "./route-sim";
import {
  newRoute,
  type PlannedRoute,
  type RouteStore,
  routeFromGpx,
  routeLabel,
  routeStats,
  routeToGpx,
  routeTrack,
} from "./routes";
import {
  isRouteProfile,
  ROUTE_PROFILES,
  type RoutedLeg,
  type RouteProfile,
  RoutingError,
  routeLeg,
  straightLeg,
} from "./routing";
import { setSliderFill } from "./slider";
import type { LatLon } from "./track";
import { browserZone, loadTz, offsetMinutes, zoneForPoint } from "./tz";
import { escHtml, statNum } from "./ui";
import { type CellDayWind, type Dataset, FORECAST_HORIZON_DAYS } from "./weather";
import { alongColor } from "./windspeed";

export interface RoutesViewDeps {
  /** The saved routes (loaded on first use). */
  getStore(): Promise<RouteStore>;
  /** Hourly weather of the grid cells along a line for the given UTC days. */
  routeWeather(
    points: LatLon[],
    days: string[],
    onStage?: (msg: string) => void,
  ): Promise<{ dataset: Dataset; entries: CellDayWind[] }>;
  toast(msg: string, err?: boolean): void;
  /** Save a text file (a route's GPX) to disk. */
  saveText(filename: string, text: string, mime: string): void;
  /** Place search (the Forecast view's geocoder). */
  searchPlaces(query: string, signal?: AbortSignal): Promise<LocationResult[]>;
  /** Where a first route should open: where you ride (or last looked at the weather). */
  homePoint(): LatLon | null;
}

let deps: RoutesViewDeps;
let store: RouteStore | null = null;

// -- view state -------------------------------------------------------------- //

const OPEN_KEY = "gpx_toolkit.routes.open";
const PROFILE_KEY = "gpx_toolkit.routes.profile";
const DAY_MS = 86_400_000;
/** Departure slider step and the sweep's spacing (minutes). */
const TIME_STEP_MIN = 15;
const SWEEP_STEP_MIN = 30;

/** The open route (null = the list). A new route lives here unsaved until it has a
 *  start and a finish. */
let route: PlannedRoute | null = null;
let mounted = false;

/** Routed legs by `profile|from|to`, so moving one point re-routes two legs only and
 *  undoing a drag costs nothing. Session-only. */
const legCache = new Map<string, RoutedLeg>();
/** Bumped on every edit; a routing or weather answer for an older edit is dropped. */
let editSeq = 0;
let routingBusy = 0;

// Simulation inputs + outputs.
let course: Course | null = null;
let weather: { key: string; dataset: Dataset; at: WeatherAt } | null = null;
let weatherSeq = 0;
let weatherBusy = false;
let weatherError = "";
/** Departure: a day at the route's start ("YYYY-MM-DD") + minutes after midnight. */
let departDay = "";
let departMin = 9 * 60;
let zone = "";
let sim: SimResult | null = null;
let sweep: Departure[] = [];
let sweepKey = "";

// Map.
let map: L.Map | null = null;
let renderer: L.Canvas | null = null;
let lineLayer: L.LayerGroup | null = null;
let hitLayer: L.LayerGroup | null = null;
let markerLayer: L.LayerGroup | null = null;
let arrowLayer: L.LayerGroup | null = null;
let hoverMarker: L.CircleMarker | null = null;
/** The coloured per-step lines, parallel to `course.steps` (restyled per simulation). */
let stepLines: L.Polyline[] = [];

const $ = (id: string): HTMLElement | null => document.getElementById(id);

// --------------------------------------------------------------------------- //
// Lifecycle
// --------------------------------------------------------------------------- //

export function initRoutesView(d: RoutesViewDeps): void {
  deps = d;
  const root = $("routesView");
  if (!root) return;
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  $("routeFile")?.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) void importFiles(files);
  });
  const sweepCanvas = $("rtSweep") as HTMLCanvasElement | null;
  sweepCanvas?.addEventListener("pointerdown", (e) => {
    sweepCanvas.setPointerCapture(e.pointerId);
    pickFromSweep(e);
  });
  sweepCanvas?.addEventListener("pointermove", (e) => {
    if (sweepCanvas.hasPointerCapture(e.pointerId)) pickFromSweep(e);
  });
  window.addEventListener("resize", () => {
    if (mounted && route) drawSweep();
  });
}

export function mountRoutesView(): void {
  if (!deps) return;
  // The app re-mounts the active view on every state change (a job ticking, rides
  // syncing); nothing here depends on ride state, so only a theme change matters.
  if (mounted) {
    drawSweep();
    return;
  }
  mounted = true;
  void (async () => {
    store ??= await deps.getStore();
    if (!mounted) return;
    if (!route) {
      const id = readPref(OPEN_KEY);
      const saved = id ? store.get(id) : null;
      if (saved) {
        openRoute(saved);
        return;
      }
    }
    render();
  })();
}

export function leaveRoutesView(): void {
  mounted = false;
  closeRouteIfEmpty();
}

/** Forget the cached routes (after a reset or a backup import). */
export function resetRoutesView(): void {
  route = null;
  store = null;
  weather = null;
  course = null;
  writePref(OPEN_KEY, "");
  clearMapLayers();
  if (mounted) {
    mounted = false;
    mountRoutesView();
  }
}

function render(): void {
  const listEl = $("rtList");
  const planEl = $("rtPlan");
  listEl?.classList.toggle("hidden", !!route);
  planEl?.classList.toggle("hidden", !route);
  if (route) {
    ensureMap();
    renderSide();
    drawRoute();
    renderSim();
  } else {
    renderList();
  }
}

// --------------------------------------------------------------------------- //
// The list
// --------------------------------------------------------------------------- //

function renderList(): void {
  const el = $("rtList");
  if (!el || !store) return;
  const routes = store.all();
  const head =
    `<div class="rt-list-head">` +
    `<div class="rt-list-intro"><b>Routes you might ride one day.</b> Plan one on the map or ` +
    `import a GPX file, then pick a departure to see how the wind would treat you.</div>` +
    `<div class="rt-list-acts">` +
    `<button class="small" data-rt="new">${icon("plus")}New route</button>` +
    `<button class="small ghost" data-rt="import">${icon("import")}Import GPX</button>` +
    `</div></div>`;
  const cards = routes.length
    ? `<div class="rt-grid">${routes.map(routeCard).join("")}</div>`
    : `<div class="rt-empty">No routes yet. <b>New route</b> opens the planner; ` +
      `<b>Import GPX</b> adds a route someone shared or you drew elsewhere.</div>`;
  el.innerHTML = head + cards;
}

function routeCard(r: PlannedRoute): string {
  const s = routeStats(r);
  const kind = r.imported
    ? "Imported"
    : (ROUTE_PROFILES.find((p) => p.id === r.profile)?.label ?? "");
  const edited = new Date(r.updated).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const climb = s.ascentM != null ? ` · ↑ ${fmtElevation(s.ascentM)}` : "";
  return (
    `<button type="button" class="rt-card" data-route="${escHtml(r.id)}">` +
    `${routeShapeSvg(r)}` +
    `<span class="rt-card-body"><span class="rt-card-name">${escHtml(routeLabel(r))}</span>` +
    `<span class="rt-card-meta">${fmtKmDetail(s.distanceKm)}${climb} · ${escHtml(kind)}</span>` +
    `<span class="rt-card-when">Edited ${escHtml(edited)}</span></span></button>`
  );
}

/** A small, static sketch of a route's shape (no map, no tiles). */
function routeShapeSvg(r: PlannedRoute): string {
  const pts = routeTrack(r).points;
  if (pts.length < 2) return `<svg class="rt-shape" viewBox="0 0 64 64"></svg>`;
  const midLat = (pts[0][0] * Math.PI) / 180;
  const kx = Math.cos(midLat);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lat, lon] of pts) {
    const x = lon * kx;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, lat);
    maxY = Math.max(maxY, lat);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 6;
  const sc = (64 - 2 * pad) / span;
  const ox = pad + (64 - 2 * pad - (maxX - minX) * sc) / 2;
  const oy = pad + (64 - 2 * pad - (maxY - minY) * sc) / 2;
  const step = Math.max(1, Math.floor(pts.length / 200));
  let d = "";
  for (let i = 0; i < pts.length; i += step) {
    const [lat, lon] = pts[i];
    d += `${i ? "L" : "M"}${(ox + (lon * kx - minX) * sc).toFixed(1)} ${(oy + (maxY - lat) * sc).toFixed(1)}`;
  }
  const [elat, elon] = pts[pts.length - 1];
  d += `L${(ox + (elon * kx - minX) * sc).toFixed(1)} ${(oy + (maxY - elat) * sc).toFixed(1)}`;
  return `<svg class="rt-shape" viewBox="0 0 64 64" aria-hidden="true"><path d="${d}"/></svg>`;
}

async function importFiles(files: File[]): Promise<void> {
  store ??= await deps.getStore();
  const added: PlannedRoute[] = [];
  const failed: string[] = [];
  for (const f of files) {
    try {
      const text = await f.text();
      const name = extractGpxName(text) || f.name.replace(/\.gpx$/i, "");
      const r = routeFromGpx(text, name);
      if (!r) {
        failed.push(f.name);
        continue;
      }
      await store.put(r);
      added.push(r);
    } catch {
      failed.push(f.name);
    }
  }
  if (added.length)
    deps.toast(
      added.length === 1
        ? `Added "${routeLabel(added[0])}" to your routes.`
        : `Added ${added.length} routes.`,
    );
  if (failed.length)
    deps.toast(
      `No track found in ${failed.slice(0, 2).join(", ")}${failed.length > 2 ? ` (+${failed.length - 2} more)` : ""}.`,
      true,
    );
  if (added.length === 1) openRoute(added[0]);
  else if (mounted) render();
}

// --------------------------------------------------------------------------- //
// Opening / closing a route
// --------------------------------------------------------------------------- //

function openRoute(r: PlannedRoute): void {
  route = r;
  writePref(OPEN_KEY, r.id);
  weather = null;
  sim = null;
  sweep = [];
  sweepKey = "";
  weatherError = "";
  if (!departDay) departDay = dayInZone(Date.now(), browserZone());
  render();
  fitRoute();
  void onGeometryChanged();
}

function startNewRoute(): void {
  const saved = readPref(PROFILE_KEY);
  openRoute(newRoute(isRouteProfile(saved) ? saved : "trekking"));
}

/** Leave a route; an unsaved new one (fewer than two points) is simply dropped. */
function closeRouteIfEmpty(): void {
  if (route && route.waypoints.length < 2 && !store?.get(route.id)) {
    route = null;
    writePref(OPEN_KEY, "");
  }
}

function backToList(): void {
  route = null;
  writePref(OPEN_KEY, "");
  clearMapLayers();
  render();
}

async function saveRoute(): Promise<void> {
  if (!route || route.waypoints.length < 2 || !store) return;
  route.updated = Date.now();
  try {
    await store.put(route);
  } catch (err) {
    deps.toast(`Couldn't save the route: ${(err as Error)?.message ?? err}`, true);
  }
}

async function deleteRoute(): Promise<void> {
  if (!route) return;
  const r = route;
  const ok = await confirmDialog({
    title: "Delete route?",
    body: `“${routeLabel(r)}” is removed from your routes on this device.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  await store?.remove(r.id);
  deps.toast(`Deleted "${routeLabel(r)}".`);
  backToList();
}

function exportGpx(): void {
  if (!route || route.waypoints.length < 2) return;
  const name =
    routeLabel(route)
      .replace(/[\\/:*?"<>|]+/g, " ")
      .trim() || "route";
  deps.saveText(`${name}.gpx`, routeToGpx(route), "application/gpx+xml");
}

// --------------------------------------------------------------------------- //
// Editing
// --------------------------------------------------------------------------- //

const legKey = (profile: RouteProfile, a: LatLon, b: LatLon): string =>
  `${profile}|${a[0].toFixed(6)},${a[1].toFixed(6)}|${b[0].toFixed(6)},${b[1].toFixed(6)}`;

function editable(): boolean {
  return !!route && !route.imported;
}

function addWaypoint(p: LatLon, at?: number): void {
  if (!route || !editable()) return;
  const i = at ?? route.waypoints.length;
  route.waypoints.splice(i, 0, p);
  void rebuildLegs();
}

function moveWaypoint(i: number, p: LatLon): void {
  if (!route || !editable()) return;
  route.waypoints[i] = p;
  void rebuildLegs();
}

function removeWaypoint(i: number): void {
  if (!route || !editable()) return;
  route.waypoints.splice(i, 1);
  void rebuildLegs();
}

function reverseRoute(): void {
  if (!route) return;
  route.waypoints.reverse();
  if (route.imported) {
    route.legs = route.legs
      .map((l) => ({
        ...l,
        points: l.points.slice().reverse(),
        eles: l.eles.slice().reverse(),
      }))
      .reverse();
    void saveRoute();
    void onGeometryChanged();
    renderSide();
    drawRoute();
    return;
  }
  void rebuildLegs();
}

function setProfile(p: RouteProfile): void {
  if (!route || !editable() || route.profile === p) return;
  route.profile = p;
  writePref(PROFILE_KEY, p);
  void rebuildLegs();
}

/**
 * Re-derive the legs from the waypoints: cached legs are reused, the rest are drawn
 * straight (dashed) at once and then routed, two at a time. A routing failure keeps
 * that leg straight and says why. Saves and re-simulates once every leg is in.
 */
async function rebuildLegs(): Promise<void> {
  if (!route) return;
  const r = route;
  const my = ++editSeq;
  // The old simulation belongs to the old line: draw plain until the new one rides.
  sim = null;
  weatherSeq++;
  const pending: number[] = [];
  r.legs = [];
  for (let i = 0; i + 1 < r.waypoints.length; i++) {
    const a = r.waypoints[i];
    const b = r.waypoints[i + 1];
    const cached = legCache.get(legKey(r.profile, a, b));
    if (cached) r.legs.push(cached);
    else {
      r.legs.push({ ...straightLeg(a, b), pending: true });
      pending.push(i);
    }
  }
  renderSide();
  drawRoute();
  if (r.waypoints.length >= 2 && !pending.length) {
    await saveRoute();
    void onGeometryChanged();
    return;
  }
  if (!pending.length) {
    void onGeometryChanged();
    return;
  }
  routingBusy++;
  setBanner(
    `Following the paths for ${pending.length} leg${pending.length === 1 ? "" : "s"}…`,
    true,
  );
  const errors: string[] = [];
  const work = pending.slice();
  const worker = async (): Promise<void> => {
    for (let i = work.shift(); i !== undefined; i = work.shift()) {
      const a = r.waypoints[i];
      const b = r.waypoints[i + 1];
      const key = legKey(r.profile, a, b);
      let leg: RoutedLeg;
      try {
        leg = await routeLeg(a, b, r.profile, fetch);
        legCache.set(key, leg);
      } catch (err) {
        errors.push(err instanceof RoutingError ? err.message : String(err));
        leg = straightLeg(a, b);
      }
      if (my !== editSeq || route !== r) return;
      r.legs[i] = leg;
      drawRoute();
    }
  };
  try {
    await Promise.all([worker(), worker()]);
  } finally {
    routingBusy--;
  }
  if (my !== editSeq || route !== r) return;
  setBanner("");
  if (errors.length)
    deps.toast(
      `Couldn't follow the paths for ${errors.length} leg${errors.length === 1 ? "" : "s"} — ` +
        `kept a straight line (${errors[0]}).`,
      true,
    );
  renderSide();
  drawRoute();
  await saveRoute();
  void onGeometryChanged();
}

// --------------------------------------------------------------------------- //
// Weather + simulation
// --------------------------------------------------------------------------- //

/** Minutes → the departure instant at the route's start (DST-correct). */
function departureMs(day: string, minutes: number): number {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - offsetMinutes(guess, zone) * 60_000;
  const off2 = offsetMinutes(t, zone);
  t = guess - off2 * 60_000;
  return t;
}

/** "YYYY-MM-DD" of an instant in a zone. */
function dayInZone(ms: number, z: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: z || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

function fmtClock(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: zone || undefined,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toTimeString().slice(0, 5);
  }
}

function fmtDayLabel(day: string): string {
  const today = dayInZone(Date.now(), zone);
  if (day === today) return "Today";
  if (day === shiftDay(today, 1)) return "Tomorrow";
  const [y, m, d] = day.split("-").map(Number);
  const sameYear = y === Number(today.slice(0, 4));
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** The last day the forecast covers (at the route's start). */
function lastForecastDay(): string {
  return shiftDay(dayInZone(Date.now(), zone), FORECAST_HORIZON_DAYS - 1);
}

/** The UTC days the weather fetch needs: the whole forecast window when the departure
 *  is in it (switching days is then free), else the departure day and the next. */
function weatherDays(): string[] {
  const today = dayInZone(Date.now(), zone);
  const inForecast = departDay >= shiftDay(today, -4);
  const fromDay = inForecast ? shiftDay(today, -1) : departDay;
  const toDay = inForecast ? lastForecastDay() : shiftDay(departDay, 1);
  const from = departureMs(fromDay, 0);
  const to = departureMs(toDay, 24 * 60) + DAY_MS / 2; // a long ride runs past midnight
  const out: string[] = [];
  for (let t = Date.parse(new Date(from).toISOString().slice(0, 10)); t <= to; t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out.slice(0, FORECAST_HORIZON_DAYS + 3);
}

/** The route's line changed (or opened): re-cut the course, then fetch the weather. */
async function onGeometryChanged(): Promise<void> {
  if (!route) return;
  const t = routeTrack(route);
  course = t.points.length >= 2 ? buildCourse(t.points) : null;
  if (t.points.length >= 2) {
    await loadTz();
    zone = zoneForPoint(t.points[0][0], t.points[0][1]) || browserZone();
  }
  stepLines = [];
  weather = null;
  sim = null;
  sweepKey = "";
  drawRoute();
  renderSide();
  await ensureWeather();
}

async function ensureWeather(): Promise<void> {
  if (!route || !course?.steps.length) {
    sim = null;
    renderSim();
    return;
  }
  const t = routeTrack(route);
  const days = weatherDays();
  const key = `${route.id}|${t.points.length}|${t.cum[t.cum.length - 1].toFixed(3)}|${days[0]}|${days[days.length - 1]}`;
  if (weather?.key === key) {
    runSim();
    return;
  }
  const my = ++weatherSeq;
  const c = course;
  weatherBusy = true;
  weatherError = "";
  renderSim();
  try {
    const res = await deps.routeWeather(t.points, days, (msg) => {
      if (my === weatherSeq) setBanner(msg, true);
    });
    if (my !== weatherSeq || c !== course) return;
    weather = { key, dataset: res.dataset, at: weatherFromCells(c, res.entries) };
  } catch (err) {
    if (my !== weatherSeq) return;
    weather = null;
    weatherError = err instanceof Error ? err.message : String(err);
  } finally {
    if (my === weatherSeq) {
      weatherBusy = false;
      if (!routingBusy) setBanner("");
    }
  }
  sweepKey = "";
  runSim();
}

function speedModel(): SpeedModel {
  return effectiveSpeedModel(readSpeedPrefs(), readSpeedFit());
}

/** Re-simulate the chosen departure (and the day's sweep when its inputs changed). */
function runSim(): void {
  if (!route || !course || !weather) {
    sim = null;
    renderSim();
    return;
  }
  const model = speedModel();
  sim = simulate(course, departureMs(departDay, departMin), model, weather.at);
  const key = `${weather.key}|${departDay}|${model.calmKmh}|${model.slope}`;
  if (key !== sweepKey) {
    sweepKey = key;
    const starts: number[] = [];
    for (let m = 0; m < 24 * 60; m += SWEEP_STEP_MIN) starts.push(departureMs(departDay, m));
    sweep = sweepDepartures(course, starts, model, weather.at);
  }
  renderSim();
  colourRoute();
}

// --------------------------------------------------------------------------- //
// Side panel
// --------------------------------------------------------------------------- //

function renderSide(): void {
  const side = $("rtSide");
  if (!side || !route) return;
  if (!side.dataset.built) {
    side.dataset.built = "1";
    side.innerHTML = sideSkeleton();
  }
  const r = route;
  const name = $("rtName") as HTMLInputElement | null;
  if (name && document.activeElement !== name) name.value = r.name;
  if (name) name.placeholder = routeLabel(r);
  const s = routeStats(r);
  const statsEl = $("rtStats");
  if (statsEl)
    statsEl.textContent =
      r.waypoints.length >= 2
        ? `${fmtKmDetail(s.distanceKm)}${s.ascentM != null ? ` · ↑ ${fmtElevation(s.ascentM)} ↓ ${fmtElevation(s.descentM ?? 0)}` : ""}`
        : "";
  const prof = $("rtProfile");
  prof?.classList.toggle("hidden", !!r.imported);
  $("rtFindWrap")?.classList.toggle("hidden", !!r.imported);
  prof?.querySelectorAll<HTMLButtonElement>("button[data-profile]").forEach((b) => {
    b.classList.toggle("active", b.dataset.profile === r.profile);
  });
  const wps = $("rtWps");
  if (wps) wps.innerHTML = r.imported ? "" : r.waypoints.map(waypointRow).join("");
  const hint = $("rtHint");
  if (hint) {
    hint.innerHTML = r.imported
      ? "Imported from a GPX file — its line is kept as recorded."
      : r.waypoints.length === 0
        ? "<b>Click the map</b> where the ride starts."
        : r.waypoints.length === 1
          ? "Now <b>click where it ends</b> — the route follows the paths."
          : "Click the map to extend · drag a point to move it · click the line to add a via · right-click a point to drop it.";
  }
  for (const id of ["rtReverse", "rtExport", "rtDelete"]) {
    const b = $(id) as HTMLButtonElement | null;
    if (b) b.disabled = r.waypoints.length < 2;
  }
  const del = $("rtDelete") as HTMLButtonElement | null;
  if (del) del.disabled = !store?.get(r.id);
  renderSpeed();
}

function sideSkeleton(): string {
  const profiles = ROUTE_PROFILES.map(
    (p) =>
      `<button type="button" data-profile="${p.id}" title="${escHtml(p.title)}">${escHtml(p.label)}</button>`,
  ).join("");
  return (
    `<div class="rt-head">` +
    `<button type="button" class="small ghost rt-back" data-rt="back" title="Back to all routes">${icon("back")}Routes</button>` +
    `<input class="rt-name" id="rtName" type="text" maxlength="120" aria-label="Route name" />` +
    `</div>` +
    `<section class="rt-sec">` +
    `<h3 class="cl-h">Route <span class="cl-sub" id="rtStats"></span></h3>` +
    `<div class="rt-find" id="rtFindWrap">` +
    `<input type="search" id="rtFind" placeholder="Find a place on the map…" aria-label="Find a place" autocomplete="off" />` +
    `<div class="rt-find-results" id="rtFindResults"></div></div>` +
    `<div class="seg rt-profile" id="rtProfile" role="group" aria-label="Routing">${profiles}</div>` +
    `<ol class="rt-wps" id="rtWps"></ol>` +
    `<p class="cl-hint rt-hint" id="rtHint"></p>` +
    `<div class="rt-acts">` +
    `<button type="button" class="small ghost" id="rtReverse" data-rt="reverse">${icon("swap")}Reverse</button>` +
    `<button type="button" class="small ghost" id="rtExport" data-rt="export">${icon("download")}GPX</button>` +
    `<button type="button" class="small ghost danger" id="rtDelete" data-rt="delete">${icon("trash")}Delete</button>` +
    `</div></section>` +
    `<section class="rt-sec">` +
    `<h3 class="cl-h">Ride it <span class="cl-sub" id="rtWxSrc"></span></h3>` +
    `<div class="rt-depart">` +
    `<button type="button" class="small ghost rt-daynav" data-rt="day-prev" aria-label="Previous day" title="Previous day">${icon("chevLeft")}</button>` +
    `<button type="button" class="small rt-day" id="rtDay" data-rt="day" title="Pick the departure day">${icon("calendar")}<span id="rtDayText"></span></button>` +
    `<button type="button" class="small ghost rt-daynav" data-rt="day-next" aria-label="Next day" title="Next day">${icon("chevRight")}</button>` +
    `<output class="rt-time" id="rtTimeOut"></output>` +
    `</div>` +
    `<input type="range" class="uslider rt-time-slider" id="rtTime" min="0" max="${24 * 60 - TIME_STEP_MIN}" step="${TIME_STEP_MIN}" aria-label="Departure time" />` +
    `<div class="rt-sweep"><canvas id="rtSweep" aria-label="Ride time for each departure of the day"></canvas></div>` +
    `<div class="rt-sweep-read" id="rtSweepRead"></div>` +
    `<div class="cl-cards rt-cards" id="rtCards"></div>` +
    `<p class="cl-prov" id="rtNote"></p>` +
    `</section>` +
    `<section class="rt-sec">` +
    `<h3 class="cl-h">Your speed</h3>` +
    `<div class="rt-speed">` +
    `<label class="rt-field"><span>Still-air moving speed</span><input type="number" id="rtCalm" min="5" max="60" step="0.5" inputmode="decimal" /><span class="rt-unit">km/h</span></label>` +
    `<label class="rt-field" title="How much each km/h of tailwind adds to your speed (and a headwind takes away)"><span>Tailwind factor</span><input type="number" id="rtSlope" min="0" max="1.5" step="0.05" inputmode="decimal" /><span class="rt-unit">km/h per km/h</span></label>` +
    `</div>` +
    `<p class="cl-hint rt-speed-src"><span id="rtSpeedSrc"></span> ` +
    `<button type="button" class="linkbtn" id="rtSpeedReset" data-rt="speed-reset" hidden></button></p>` +
    `</section>`
  );
}

function waypointRow(p: LatLon, i: number): string {
  if (!route) return "";
  const n = route.waypoints.length;
  const role = i === 0 ? "Start" : i === n - 1 && n > 1 ? "Finish" : `Via ${i}`;
  const mark = i === 0 ? "A" : i === n - 1 && n > 1 ? "B" : String(i);
  const cls = i === 0 ? "start" : i === n - 1 && n > 1 ? "end" : "via";
  return (
    `<li class="rt-wp-row"><span class="rt-wp rt-wp--${cls}">${mark}</span>` +
    `<span class="rt-wp-name">${role}</span>` +
    `<span class="rt-wp-at">${p[0].toFixed(4)}, ${p[1].toFixed(4)}</span>` +
    `<button type="button" class="ms-clear" data-wp-remove="${i}" aria-label="Remove ${role}" title="Remove ${role}">${icon("x")}</button></li>`
  );
}

function renderSpeed(): void {
  const prefs = readSpeedPrefs();
  const fit = readSpeedFit();
  const model = effectiveSpeedModel(prefs, fit);
  const calm = $("rtCalm") as HTMLInputElement | null;
  const slope = $("rtSlope") as HTMLInputElement | null;
  if (calm && document.activeElement !== calm) calm.value = String(+model.calmKmh.toFixed(1));
  if (slope && document.activeElement !== slope) slope.value = String(+model.slope.toFixed(2));
  const src = $("rtSpeedSrc");
  if (!src) return;
  const fitLine = fit
    ? `Your Wind vs speed fit: ${fit.calmKmh.toFixed(1)} km/h still air, ${fit.slope >= 0 ? "+" : ""}${fit.slope.toFixed(2)} per km/h of tailwind (${fit.segments} segments, R² ${fit.r2.toFixed(2)}).`
    : "Run <b>Wind vs speed</b> on your rides to measure your own tailwind factor.";
  src.innerHTML =
    `${fitLine} A tailwind of 10 km/h makes you ${fmtSpeed(Math.max(0, model.calmKmh + model.slope * 10))}, ` +
    `a headwind of 10 km/h ${fmtSpeed(Math.max(0, model.calmKmh - model.slope * 10))}.`;
  // A static button (only its label and visibility change), so a click that blurs a
  // just-edited field — which re-renders this hint — still lands on it.
  const reset = $("rtSpeedReset");
  if (reset) {
    reset.hidden = prefs.calmKmh == null && prefs.slope == null;
    reset.textContent = fit ? "Use my fit" : "Reset";
  }
}

function renderSim(): void {
  if (!route) return;
  const dayText = $("rtDayText");
  if (dayText) dayText.textContent = departDay ? fmtDayLabel(departDay) : "";
  const slider = $("rtTime") as HTMLInputElement | null;
  if (slider && Number(slider.value) !== departMin) slider.value = String(departMin);
  if (slider) setSliderFill(slider);
  const out = $("rtTimeOut");
  if (out) out.textContent = departDay ? fmtClock(departureMs(departDay, departMin)) : "";
  const next = document.querySelector<HTMLButtonElement>('[data-rt="day-next"]');
  if (next) next.disabled = departDay >= lastForecastDay();

  const src = $("rtWxSrc");
  if (src)
    src.textContent = weather
      ? weather.dataset.forecast
        ? "Live forecast"
        : `${weather.dataset.label} history`
      : "";
  const cards = $("rtCards");
  const note = $("rtNote");
  const read = $("rtSweepRead");
  const ready = route.waypoints.length >= 2 && !!course?.steps.length;
  if (!ready) {
    if (cards) cards.innerHTML = "";
    if (note)
      note.textContent = "Set a start and a finish to ride the route through the weather.";
    if (read) read.textContent = "";
    drawSweep();
    return;
  }
  if (!sim) {
    if (cards) cards.innerHTML = "";
    if (note)
      note.textContent = weatherBusy
        ? "Fetching the weather along the route…"
        : weatherError
          ? `No weather for this route: ${weatherError}.`
          : "";
    if (read) read.textContent = "";
    drawSweep();
    return;
  }
  const s = sim;
  const effect = s.durationSec - s.calmSec;
  const effMin = Math.round(effect / 60);
  const rain =
    s.wetShare == null
      ? "—"
      : s.wetShare < 0.02
        ? "Dry"
        : `${Math.round(s.wetShare * 100)}% wet`;
  if (cards)
    cards.innerHTML = [
      statNum({
        value: fmtDuration(s.durationSec),
        label: "ride time",
        small: true,
        title: "Moving time, no stops",
      }),
      statNum({ value: fmtClock(s.endMs), label: "arrive", small: true }),
      statNum({
        value:
          effMin === 0 ? "±0m" : `${effMin > 0 ? "+" : "−"}${fmtDuration(Math.abs(effect))}`,
        label: "wind effect",
        sub: `${fmtDuration(s.calmSec)} in still air`,
        small: true,
      }),
      statNum({ value: fmtSpeed(s.avgSpeedKmh), label: "avg speed", small: true }),
      statNum({
        value: `${Math.round(s.headShare * 100)}%`,
        label: "headwind",
        sub: `tailwind ${Math.round(s.tailShare * 100)}%`,
        title: "Share of the distance into a headwind / with a tailwind (over 3 km/h)",
        small: true,
      }),
      statNum({
        value: rain,
        label: "rain",
        sub: s.avgTempC != null ? `${Math.round(s.avgTempC)} °C` : undefined,
        small: true,
      }),
    ].join("");
  if (note) {
    const parts: string[] = [];
    if (s.maxGustKmh != null && s.maxGustKmh >= 30)
      parts.push(`Gusts up to ${Math.round(s.maxGustKmh)} km/h.`);
    if (s.coverage < 0.98)
      parts.push(
        s.coverage === 0
          ? "No weather for this departure yet (the forecast reaches 16 days ahead) — ridden in still air."
          : `No weather for ${Math.round((1 - s.coverage) * 100)}% of the ride — those km are ridden in still air.`,
      );
    parts.push("The badges point where the wind blows, with its speed in km/h.");
    parts.push(
      `Times at the start's local time${zone && zone !== browserZone() ? ` (${zone})` : ""}. Weather by Open-Meteo.com.`,
    );
    note.textContent = parts.join(" ");
  }
  if (read) read.innerHTML = sweepSummary();
  drawSweep();
}

function sweepSummary(): string {
  const known = sweep.filter((d) => d.coverage > 0.5);
  if (!known.length || !sim) return "Ride time for each departure of the day";
  const best = known.reduce((a, b) => (b.durationSec < a.durationSec ? b : a));
  const worst = known.reduce((a, b) => (b.durationSec > a.durationSec ? b : a));
  const spread = Math.round((worst.durationSec - best.durationSec) / 60);
  return (
    `Ride time by departure · fastest <b>${fmtClock(best.startMs)}</b> (${fmtDuration(best.durationSec)})` +
    (spread >= 2 ? `, slowest ${fmtClock(worst.startMs)} (+${spread} min)` : "")
  );
}

/** The departure strip: one bar per half hour (height = ride time, colour = average
 *  head/tailwind), the chosen departure marked. Colours read from tokens now. */
function drawSweep(): void {
  const cv = $("rtSweep") as HTMLCanvasElement | null;
  if (!cv) return;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
  if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(cv);
  const muted = css.getPropertyValue("--muted").trim() || "#888";
  const line = css.getPropertyValue("--line").trim() || "#333";
  const accent = css.getPropertyValue("--accent").trim() || "#fc5200";
  const top = 4;
  const base = h - 14;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, base + 0.5);
  ctx.lineTo(w, base + 0.5);
  ctx.stroke();
  ctx.fillStyle = muted;
  ctx.font = "10px Ubuntu, sans-serif";
  ctx.textBaseline = "bottom";
  for (const hr of [0, 6, 12, 18]) {
    const x = (hr / 24) * w;
    ctx.textAlign = hr === 0 ? "left" : "center";
    ctx.fillText(`${String(hr).padStart(2, "0")}:00`, x + (hr === 0 ? 1 : 0), h);
  }
  const known = sweep.filter((d) => d.coverage > 0.5);
  if (known.length) {
    let lo = Math.min(...known.map((d) => d.durationSec));
    let hi = Math.max(...known.map((d) => d.durationSec));
    if (hi - lo < 300) {
      const mid = (hi + lo) / 2;
      lo = mid - 150;
      hi = mid + 150;
    }
    const maxAlong = Math.max(5, ...known.map((d) => Math.abs(d.avgAlongKmh)));
    const bw = w / sweep.length;
    sweep.forEach((d, i) => {
      if (d.coverage <= 0.5) return;
      // Bars grow from a floor so the shortest ride still shows; taller = slower.
      const f = 0.2 + (0.8 * (d.durationSec - lo)) / (hi - lo);
      const bh = f * (base - top);
      ctx.fillStyle = alongColor(d.avgAlongKmh, maxAlong);
      ctx.fillRect(i * bw + 1, base - bh, Math.max(1, bw - 2), bh);
    });
  }
  if (route && route.waypoints.length >= 2) {
    const x = (departMin / (24 * 60)) * w;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top - 2);
    ctx.lineTo(x, base);
    ctx.stroke();
  }
}

function pickFromSweep(e: PointerEvent): void {
  const cv = e.currentTarget as HTMLCanvasElement;
  const rect = cv.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const m = Math.min(
    24 * 60 - TIME_STEP_MIN,
    Math.round((f * 24 * 60) / TIME_STEP_MIN) * TIME_STEP_MIN,
  );
  if (m === departMin) return;
  departMin = m;
  runSim();
}

// --------------------------------------------------------------------------- //
// Map
// --------------------------------------------------------------------------- //

function ensureMap(): void {
  const host = $("rtMap");
  if (!host) return;
  if (map) {
    setTimeout(() => map?.invalidateSize(), 0);
    return;
  }
  map = createInteractiveMap(host);
  // A double click would drop two waypoints, so it doesn't zoom here.
  map.doubleClickZoom.disable();
  renderer = L.canvas({ padding: 0.3, tolerance: 6 });
  lineLayer = L.layerGroup().addTo(map);
  arrowLayer = L.layerGroup().addTo(map);
  hitLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("click", (e: L.LeafletMouseEvent) => {
    if (!route || !editable()) return;
    addWaypoint([e.latlng.lat, e.latlng.lng]);
  });
  map.on("mousemove", (e: L.LeafletMouseEvent) => showHover(e.latlng));
  map.on("mouseout", () => showHover(null));
  // Badges that would cover a waypoint depend on the zoom: re-place them.
  map.on("zoomend", () => colourRoute());
  setTimeout(() => map?.invalidateSize(), 0);
}

function clearMapLayers(): void {
  lineLayer?.clearLayers();
  hitLayer?.clearLayers();
  markerLayer?.clearLayers();
  arrowLayer?.clearLayers();
  stepLines = [];
  showHover(null);
}

function fitRoute(): void {
  if (!map || !route) return;
  const pts = routeTrack(route).points;
  const all = pts.length ? pts : route.waypoints;
  if (all.length >= 2)
    map.fitBounds(L.latLngBounds(all.map((p) => L.latLng(p[0], p[1]))), { padding: [30, 30] });
  else if (all.length === 1) map.setView(all[0], 13);
  else {
    // A new route opens where your last route starts, else where you ride.
    const last = store?.all().find((r) => r.waypoints.length);
    const home = last?.waypoints[0] ?? deps.homePoint();
    if (home) map.setView(home, 12);
  }
}

/** Draw the line (plain while there's no simulation, wind-coloured once there is),
 *  the hit lines for inserting vias, and the waypoint markers. */
function drawRoute(): void {
  if (!map || !route || !lineLayer || !hitLayer || !markerLayer) return;
  lineLayer.clearLayers();
  hitLayer.clearLayers();
  markerLayer.clearLayers();
  arrowLayer?.clearLayers();
  stepLines = [];
  const r = route;
  // Casing + line per leg; a leg still being routed is dashed.
  r.legs.forEach((leg, i) => {
    const ll = leg.points.map((p) => L.latLng(p[0], p[1]));
    const pending = leg.pending;
    L.polyline(ll, {
      renderer: renderer!,
      color: "#fff",
      weight: 7,
      opacity: 0.85,
      interactive: false,
    }).addTo(lineLayer!);
    if (!sim || pending)
      L.polyline(ll, {
        renderer: renderer!,
        color: "#fc5200",
        weight: 4,
        opacity: 1,
        dashArray: pending || !leg.snapped ? "6 7" : undefined,
        interactive: false,
      }).addTo(lineLayer!);
    if (editable()) {
      const hit = L.polyline(ll, {
        renderer: renderer!,
        color: "#000",
        weight: 18,
        opacity: 0,
        bubblingMouseEvents: false,
      });
      hit.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        addWaypoint([e.latlng.lat, e.latlng.lng], i + 1);
      });
      hit.addTo(hitLayer!);
    }
  });
  if (sim && course) {
    // One short line per course step, restyled by colourRoute() as the sim changes.
    const t = routeTrack(r);
    let j = 0;
    for (const step of course.steps) {
      const from = step.km;
      const to = step.km + step.lenKm;
      const seg: L.LatLng[] = [];
      while (j < t.cum.length - 1 && t.cum[j + 1] < from) j++;
      let k = j;
      seg.push(L.latLng(...interp(t, from)));
      while (k < t.cum.length && t.cum[k] < to) {
        if (t.cum[k] > from) seg.push(L.latLng(t.points[k][0], t.points[k][1]));
        k++;
      }
      seg.push(L.latLng(...interp(t, to)));
      stepLines.push(
        L.polyline(seg, {
          renderer: renderer!,
          color: "#888",
          weight: 4,
          opacity: 1,
          interactive: false,
        }).addTo(lineLayer),
      );
    }
    colourRoute();
  }
  // Markers: A, numbered vias, B. Imported routes show their ends, fixed.
  const n = r.waypoints.length;
  r.waypoints.forEach((p, i) => {
    if (r.imported && i > 0 && i < n - 1) return;
    const cls = i === 0 ? "start" : i === n - 1 && n > 1 ? "end" : "via";
    const mark = i === 0 ? "A" : i === n - 1 && n > 1 ? "B" : String(i);
    const m = L.marker(L.latLng(p[0], p[1]), {
      draggable: editable(),
      autoPan: true,
      icon: L.divIcon({
        className: "rt-wp-marker",
        html: `<span class="rt-wp rt-wp--${cls}">${mark}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
      title: editable() ? "Drag to move · right-click to remove" : "",
    });
    m.on("dragend", () => {
      const ll = m.getLatLng();
      moveWaypoint(i, [ll.lat, ll.lng]);
    });
    m.on("contextmenu", (e: L.LeafletMouseEvent) => {
      L.DomEvent.preventDefault(e.originalEvent);
      removeWaypoint(i);
    });
    m.on("click", (e: L.LeafletMouseEvent) => L.DomEvent.stopPropagation(e));
    m.addTo(markerLayer!);
  });
}

function interp(t: { points: LatLon[]; cum: number[] }, km: number): [number, number] {
  let i = 0;
  while (i < t.cum.length - 2 && t.cum[i + 1] < km) i++;
  const span = t.cum[i + 1] - t.cum[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (km - t.cum[i]) / span)) : 0;
  const a = t.points[i];
  const b = t.points[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Colour each step by its head/tailwind and drop wind arrows along the route. */
function colourRoute(): void {
  if (!sim || !course || !map) return;
  if (stepLines.length !== course.steps.length) {
    drawRoute(); // first simulation of this geometry: build the step lines
    return;
  }
  const maxAlong = Math.max(8, ...sim.steps.map((s) => Math.abs(s.along)));
  sim.steps.forEach((s, i) => {
    stepLines[i].setStyle({ color: alongColor(s.along, maxAlong) });
  });
  // Wind badges: a glass pill with a neutral arrow (where the wind blows TO) and its
  // speed, so they read as labels over the coloured line rather than part of it.
  arrowLayer?.clearLayers();
  const every = Math.max(1, Math.round(course.steps.length / 10));
  for (let i = Math.floor(every / 2); i < course.steps.length; i += every) {
    const st = sim.steps[i];
    const cs = course.steps[i];
    if (!st.wx || nearWaypoint(cs.lat, cs.lon)) continue;
    const travel = (st.wx.fromDeg + 180) % 360;
    L.marker(L.latLng(cs.lat, cs.lon), {
      interactive: false,
      keyboard: false,
      zIndexOffset: -1000, // waypoint markers stay on top
      icon: L.divIcon({
        className: "rt-wind",
        html:
          `<span class="rt-wind-badge"><svg viewBox="0 0 24 24" style="transform:rotate(${travel.toFixed(0)}deg)">` +
          `<path d="M12 20V4M6 10l6-6 6 6"/></svg>${Math.round(st.wx.speedKmh)}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    }).addTo(arrowLayer!);
  }
}

/** True within ~25 px of a waypoint marker at the current zoom (a badge there would
 *  cover it). */
function nearWaypoint(lat: number, lon: number): boolean {
  if (!map || !route) return false;
  const p = map.latLngToContainerPoint(L.latLng(lat, lon));
  return route.waypoints.some((w) => {
    const q = map!.latLngToContainerPoint(L.latLng(w[0], w[1]));
    return (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < 25 * 25;
  });
}

/** Hover readout: where on the route, when you'd be there, the wind and your speed. */
function showHover(at: L.LatLng | null): void {
  const pill = $("rtReadout");
  if (!pill) return;
  if (!at || !map || !sim || !course) {
    pill.classList.add("hidden");
    hoverMarker?.remove();
    hoverMarker = null;
    return;
  }
  const p = map.latLngToContainerPoint(at);
  let best = -1;
  let bestD = 22 * 22;
  course.steps.forEach((s, i) => {
    const q = map!.latLngToContainerPoint(L.latLng(s.lat, s.lon));
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0) {
    pill.classList.add("hidden");
    hoverMarker?.remove();
    hoverMarker = null;
    return;
  }
  const s = sim.steps[best];
  const cs = course.steps[best];
  const wind = s.wx
    ? Math.abs(s.along) < 3
      ? `${Math.round(s.wx.speedKmh)} km/h crosswind`
      : `${Math.round(Math.abs(s.along))} km/h ${s.along < 0 ? "headwind" : "tailwind"}`
    : "no weather";
  pill.innerHTML =
    `<span class="fc-when">km ${cs.km.toFixed(1)} · ${fmtClock(s.tMs)}</span>` +
    `<span>${escHtml(wind)} · <b>${fmtSpeed(s.speedKmh)}</b></span>`;
  pill.classList.remove("hidden");
  if (!hoverMarker)
    hoverMarker = L.circleMarker(L.latLng(cs.lat, cs.lon), {
      renderer: renderer!,
      radius: 6,
      color: "#fff",
      weight: 2,
      fillColor: "#fc5200",
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  else hoverMarker.setLatLng(L.latLng(cs.lat, cs.lon));
}

function setBanner(text: string, busy = false): void {
  const el = $("rtBanner");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  el.classList.toggle("busy", busy && !!text);
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //

function onClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const card = t.closest<HTMLElement>("[data-route]");
  if (card?.dataset.route && store) {
    const r = store.get(card.dataset.route);
    if (r) openRoute(r);
    return;
  }
  const place = t.closest<HTMLElement>("[data-place]");
  if (place?.dataset.place) {
    const [lat, lon] = place.dataset.place.split(",").map(Number);
    map?.setView([lat, lon], 13);
    const input = $("rtFind") as HTMLInputElement | null;
    if (input) input.value = "";
    showPlaces([]);
    return;
  }
  const remove = t.closest<HTMLElement>("[data-wp-remove]");
  if (remove) {
    removeWaypoint(Number(remove.dataset.wpRemove));
    return;
  }
  const prof = t.closest<HTMLElement>("[data-profile]");
  if (prof?.dataset.profile && isRouteProfile(prof.dataset.profile)) {
    setProfile(prof.dataset.profile);
    return;
  }
  const act = t.closest<HTMLElement>("[data-rt]")?.dataset.rt;
  if (!act) return;
  switch (act) {
    case "new":
      startNewRoute();
      break;
    case "import":
      $("routeFile")?.click();
      break;
    case "back":
      closeRouteIfEmpty();
      backToList();
      break;
    case "reverse":
      reverseRoute();
      break;
    case "export":
      exportGpx();
      break;
    case "delete":
      void deleteRoute();
      break;
    case "day-prev":
    case "day-next":
      setDepartDay(shiftDay(departDay, act === "day-prev" ? -1 : 1));
      break;
    case "day": {
      const anchor = t.closest<HTMLElement>("[data-rt]")!;
      openDatePicker({
        anchor,
        parent: document.body,
        value: departDay,
        min: "1990-01-01",
        max: lastForecastDay(),
        esc: escHtml,
        icons: { chevLeft: icon("chevLeft"), chevRight: icon("chevRight") },
        onPick: (day) => setDepartDay(day),
      });
      break;
    }
    case "speed-reset":
      saveSpeedPrefs({ calmKmh: null, slope: null });
      renderSpeed();
      runSim();
      break;
  }
}

function setDepartDay(day: string): void {
  const max = lastForecastDay();
  departDay = day > max ? max : day;
  renderSim();
  void ensureWeather();
}

function onInput(e: Event): void {
  const t = e.target as HTMLInputElement;
  if (t.id === "rtTime") {
    departMin = Number(t.value);
    runSim();
  } else if (t.id === "rtFind") {
    findPlaces(t.value);
  }
}

// -- place search (recentres the map; the route is still drawn by clicking) -- //

let findTimer = 0;
let findAbort: AbortController | null = null;

function findPlaces(query: string): void {
  clearTimeout(findTimer);
  findAbort?.abort();
  const q = query.trim();
  if (q.length < 2) {
    showPlaces([]);
    return;
  }
  findTimer = window.setTimeout(async () => {
    findAbort = new AbortController();
    try {
      showPlaces(await deps.searchPlaces(q, findAbort.signal));
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") showPlaces([]);
    }
  }, 300);
}

function showPlaces(results: LocationResult[]): void {
  const el = $("rtFindResults");
  if (!el) return;
  el.innerHTML = results
    .slice(0, 6)
    .map(
      (r) =>
        `<button type="button" class="rt-place" data-place="${r.lat},${r.lon}">${icon("pin")}` +
        `<span>${escHtml(r.label)}</span></button>`,
    )
    .join("");
}

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement;
  if (t.id === "rtName" && route) {
    route.name = t.value.trim();
    void saveRoute();
    renderSide();
    return;
  }
  if (t.id === "rtCalm" || t.id === "rtSlope") {
    const v = Number(t.value);
    const prefs = readSpeedPrefs();
    if (t.id === "rtCalm") prefs.calmKmh = Number.isFinite(v) && v >= 5 && v <= 60 ? v : null;
    else
      prefs.slope =
        t.value.trim() !== "" && Number.isFinite(v) && v >= 0 && v <= 1.5 ? v : null;
    saveSpeedPrefs(prefs);
    renderSpeed();
    runSim();
  }
}

// --------------------------------------------------------------------------- //
// Prefs
// --------------------------------------------------------------------------- //

function readPref(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writePref(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}
