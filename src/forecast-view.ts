/** Map/search-driven live forecast comparison view. */

import L from "leaflet";
import {
  DEFAULT_FORECAST_METRICS,
  DEFAULT_FORECAST_MODEL_IDS,
  FORECAST_HISTORY_HOURS,
  FORECAST_REFRESH_INTERVAL_MS,
  type ForecastCompareStyle,
  type ForecastMetric,
  type ForecastModel,
  type ForecastPoint,
  type ForecastPresentation,
  type ForecastProviderAdapter,
  type ForecastSpeedUnit,
  type HourlyForecast,
  type LocationResult,
  mergeForecastHistory,
  sliceForecastWindow,
  toggleModelGroupSelection,
} from "./forecast";
import {
  chartWidthForHours,
  compassFrom,
  convertWindSpeed,
  drawForecastComparison,
  drawForecastRow,
  type ForecastChartLane,
  type ForecastChartOptions,
  forecastChartHeight,
  forecastComparisonDetails,
  forecastComparisonHeight,
  forecastLaneAtY,
  forecastLaneReadouts,
  forecastModelColor,
  hasForecastValueAt,
  hourTimeAtX,
  sharedForecastScales,
  sharedForecastTimeline,
  speedUnitLabel,
  windTravelDeg,
} from "./forecast-chart";
import type { ForecastStore } from "./forecast-store";
import { createInteractiveMap, createLocationPointIcon } from "./map-core";
import { type RoutePoint, sameRoutePoint } from "./router";
import { browserZone, loadTz, zoneForPoint } from "./tz";

export interface ForecastViewDeps {
  provider: ForecastProviderAdapter;
  ensureStore: () => Promise<ForecastStore>;
  toast: (message: string, error?: boolean) => void;
  esc: (value: string) => string;
  onPointChange?: (point: RoutePoint) => void;
}

let deps: ForecastViewDeps;
let store: ForecastStore | null = null;
let map: L.Map | null = null;
let marker: L.Marker | null = null;
let point: ForecastPoint | null = null;
let days: 1 | 3 | 7 | 10 | 15 = 3;
let selectedModels: string[] | null = null;
let hiddenCompareModels = new Set<string>();
let compareStyle: ForecastCompareStyle = "consensus";
let speedUnit: ForecastSpeedUnit = "kmh";
let presentation: ForecastPresentation = "compare";
let tableMetric: ForecastMetric = "windSpeed";
let compareDetailHeightPx: number | null = null;
let metrics: ForecastMetric[] = [...DEFAULT_FORECAST_METRICS];
const forecasts = new Map<string, HourlyForecast>();
const displayForecastCache = new Map<
  string,
  {
    source: HourlyForecast;
    startMs: number;
    endMs: number;
    value: HourlyForecast;
  }
>();
let loading = false;
let locating = false;
let status = "Pick a point or search for a place.";
let selectedTime: number | null = null;
let selectedTableModel: string | null = null;
let focusedLane: ForecastChartLane | null = null;
let selectionSource: "hover" | "touch" | "keyboard" | null = null;
let zone = browserZone();
let mounted = false;
let ready = false;
let mountToken = 0;
let selectionToken = 0;
let routePoint: RoutePoint | null = null;
let wired = false;
let loadToken = 0;
let locateToken = 0;
let loadAbort: AbortController | null = null;
let searchAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let forecastAgeTimer: ReturnType<typeof setInterval> | null = null;
let forecastRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let forecastNowTimer: ReturnType<typeof setTimeout> | null = null;
let searchResults: LocationResult[] = [];
let searchOpen = false;
let locationPickerOpen = false;
let searching = false;
let renameMode: "new" | "existing" | null = null;
let hoveredCompareModel: string | null = null;
let compareTrackClickTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;
let rowObserver: IntersectionObserver | null = null;
let renderedPresentation: ForecastPresentation | null = null;
let touchChartGesture: {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
} | null = null;
let detailResize: {
  pointerId: number;
  startY: number;
  startHeight: number;
  originalHeight: number | null;
} | null = null;

const TOUCH_TAP_SLOP = 8;
const DETAIL_MIN_HEIGHT = 180;
const DETAIL_MAX_VIEWPORT_SHARE = 0.85;
const FORECAST_AGE_UPDATE_MS = 60_000;
const FORECAST_RETRY_INTERVAL_MS = 5 * 60_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function canHover(): boolean {
  return window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false;
}

function clearChartSelection(): void {
  selectedTime = null;
  selectedTableModel = null;
  focusedLane = null;
  selectionSource = null;
  touchChartGesture = null;
}

function formatCoord(value: number): string {
  return value.toFixed(4);
}

function rawPoint(lat: number, lon: number, label?: string): ForecastPoint {
  return { lat, lon, label: label || `${formatCoord(lat)}, ${formatCoord(lon)}` };
}

export function initForecastView(d: ForecastViewDeps): void {
  deps = d;
  if (wired) return;
  wired = true;
  const root = $("forecastView");
  root?.addEventListener("click", onClick);
  root?.addEventListener("change", onChange);
  const settingsModal = $("forecastSettingsModal");
  settingsModal?.addEventListener("click", (event) => {
    if (event.target === settingsModal) setForecastSettingsOpen(false);
  });
  settingsModal?.addEventListener("keydown", onForecastSettingsKeydown);
  $("forecastSearch")?.addEventListener("input", onSearchInput);
  $("forecastSearch")?.addEventListener("keydown", onSearchKeydown);
  $("forecastSearch")?.addEventListener("focus", () => {
    searchOpen = true;
    renderSearchResults();
  });
  $("forecastSearchResults")?.addEventListener("keydown", onSearchResultsKeydown);
  $("forecastRenameForm")?.addEventListener("submit", onRenameSubmit);
  $("forecastRenameInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  });
  $("forecastCompareLegend")?.addEventListener("pointerover", onCompareLegendOver);
  $("forecastCompareLegend")?.addEventListener("pointerout", onCompareLegendOut);
  $("forecastCompareLegend")?.addEventListener("dblclick", onCompareLegendDoubleClick);
  document.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest(".fc-controls, .fc-map-search")) return;
    if (!locationPickerOpen) return;
    locationPickerOpen = false;
    searchOpen = false;
    renderToolbar();
    renderSearchResults();
  });
  $("forecastCharts")?.addEventListener("pointermove", onChartPointerMove);
  $("forecastCharts")?.addEventListener("pointerdown", onChartPointerDown);
  $("forecastCharts")?.addEventListener("pointerup", onChartPointerUp);
  $("forecastCharts")?.addEventListener("pointercancel", cancelTouchChartGesture);
  $("forecastCharts")?.addEventListener("pointerleave", () => {
    if (selectionSource !== "hover") return;
    selectedTime = null;
    focusedLane = null;
    selectionSource = null;
    redrawCharts();
    renderReadout();
  });
  $("forecastCharts")?.addEventListener("keydown", onChartKeydown);
  const detailSheet = $("forecastCompareDetail");
  detailSheet?.addEventListener("pointerdown", onDetailResizeStart);
  detailSheet?.addEventListener("pointermove", onDetailResizeMove);
  detailSheet?.addEventListener("pointerup", onDetailResizeEnd);
  detailSheet?.addEventListener("pointercancel", onDetailResizeEnd);
  detailSheet?.addEventListener("keydown", onDetailResizeKeydown);
  window.addEventListener("resize", applyDetailHeight);
  window.visualViewport?.addEventListener("resize", applyDetailHeight);
  window.addEventListener("focus", () => {
    if (!mounted) return;
    scheduleForecastNowMarker();
    void refreshForecast(false);
  });
  window.addEventListener("online", () => {
    if (mounted) void refreshForecast(false);
  });
  resizeObserver = new ResizeObserver(() => {
    if (mounted) renderCharts();
  });
  const charts = $("forecastCharts");
  if (charts) resizeObserver.observe(charts);
}

export async function mountForecastView(): Promise<void> {
  if (!deps) return;
  if (mounted) {
    if (ready) {
      ensureMap();
      renderAll();
    }
    return;
  }
  mounted = true;
  const token = ++mountToken;
  store = await deps.ensureStore();
  if (!mounted || token !== mountToken) return;
  const prefs = store.prefs();
  days = prefs.days;
  selectedModels = prefs.selectedModels;
  hiddenCompareModels = new Set(prefs.hiddenCompareModels);
  compareStyle = prefs.compareStyle;
  speedUnit = prefs.speedUnit;
  presentation = prefs.presentation;
  tableMetric = prefs.tableMetric;
  compareDetailHeightPx = prefs.compareDetailHeightPx;
  metrics = prefs.metrics;
  await loadTz();
  if (!mounted || token !== mountToken) return;
  point = routePoint ? pointForRoute(routePoint) : (point ?? prefs.lastPoint);
  ready = true;
  startForecastAgeTimer();
  ensureMap();
  if (point) {
    zone = zoneForPoint(point.lat, point.lon) || browserZone();
    placeMarker(point, true);
    deps.onPointChange?.(point);
    if (routePoint && !sameRoutePoint(prefs.lastPoint, point)) {
      void store.setPrefs({ lastPoint: point });
    }
    await refreshForecast(false);
  } else {
    renderAll();
  }
}

export function leaveForecastView(): void {
  mounted = false;
  ready = false;
  stopForecastTimers();
  mountToken += 1;
  selectionToken += 1;
  loadToken += 1;
  setForecastSettingsOpen(false, false);
  locateToken += 1;
  locating = false;
  locationPickerOpen = false;
  searchOpen = false;
  searching = false;
  searchAbort?.abort();
  loadAbort?.abort();
  loading = false;
  clearChartSelection();
  hoveredCompareModel = null;
  if (compareTrackClickTimer) clearTimeout(compareTrackClickTimer);
  compareTrackClickTimer = null;
  if (searchTimer) clearTimeout(searchTimer);
}

function pointForRoute(next: RoutePoint): ForecastPoint {
  const prefs = store?.prefs();
  const saved = [prefs?.lastPoint, ...(prefs?.favorites ?? []), ...(prefs?.recent ?? [])].find(
    (item) => item && sameRoutePoint(item, next),
  );
  return saved ?? rawPoint(next.lat, next.lon);
}

/** A route point wins over saved preferences, including while the store is loading. */
export function setForecastRoutePoint(next: RoutePoint | null): void {
  routePoint = next;
  if (!ready) return;
  const target = next ? pointForRoute(next) : store?.prefs().lastPoint;
  if (!target || sameRoutePoint(point, target)) {
    if (point) deps.onPointChange?.(point);
    return;
  }
  void choosePoint(target, true, false);
}

export function forecastPoint(): RoutePoint | null {
  return point;
}

function setForecastSettingsOpen(open: boolean, restoreFocus = true): void {
  const modal = $("forecastSettingsModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !open);
  $("forecastSettingsOpen")?.setAttribute("aria-expanded", String(open));
  if (open) $("forecastSettingsClose")?.focus();
  else if (restoreFocus) $("forecastSettingsOpen")?.focus();
}

function onForecastSettingsKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setForecastSettingsOpen(false);
    return;
  }
  if (event.key !== "Tab") return;
  const modal = $("forecastSettingsModal");
  if (!modal) return;
  const focusable = [...modal.querySelectorAll<HTMLElement>("button, input, summary")].filter(
    (item) => !item.hasAttribute("disabled") && item.getClientRects().length > 0,
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function resetForecastViewData(fullReset = false): void {
  clearForecastRefreshTimer();
  locateToken += 1;
  locating = false;
  forecasts.clear();
  displayForecastCache.clear();
  searchResults = [];
  locationPickerOpen = false;
  searchOpen = false;
  searching = false;
  if (fullReset) {
    routePoint = null;
    selectionToken += 1;
    loadToken += 1;
    loadAbort?.abort();
    point = null;
    renameMode = null;
    days = 3;
    selectedModels = null;
    hiddenCompareModels = new Set();
    compareStyle = "consensus";
    speedUnit = "kmh";
    presentation = "compare";
    tableMetric = "windSpeed";
    compareDetailHeightPx = null;
    metrics = [...DEFAULT_FORECAST_METRICS];
    clearChartSelection();
    marker?.remove();
    marker = null;
    map?.setView([52.2, 5.3], 7);
    status = "Pick a point or search for a place.";
  } else {
    status = "Forecast cache cleared. Refresh to download it again.";
  }
  renderAll();
}

function ensureMap(): void {
  const host = $("forecastMap");
  if (!host || map) {
    requestAnimationFrame(() => map?.invalidateSize());
    return;
  }
  map = createInteractiveMap(host);
  map.setView([52.2, 5.3], 7);
  map.on("click", (event: L.LeafletMouseEvent) => {
    void choosePoint(rawPoint(event.latlng.lat, event.latlng.lng), false, false);
  });
  requestAnimationFrame(() => map?.invalidateSize());
}

function placeMarker(next: ForecastPoint, fit: boolean): void {
  if (!map) return;
  const latlng = L.latLng(next.lat, next.lon);
  if (!marker) {
    marker = L.marker(latlng, {
      draggable: true,
      icon: createLocationPointIcon(),
      title: "Forecast location — drag to move",
    }).addTo(map);
    marker.on("dragend", () => {
      const pos = marker!.getLatLng();
      void choosePoint(rawPoint(pos.lat, pos.lng), false, false);
    });
  } else marker.setLatLng(latlng);
  if (fit) map.setView(latlng, Math.max(map.getZoom(), 10));
}

async function choosePoint(
  next: ForecastPoint,
  fit: boolean,
  addRecent: boolean,
): Promise<void> {
  const token = ++selectionToken;
  routePoint = next;
  loadToken += 1;
  loadAbort?.abort();
  clearForecastRefreshTimer();
  point = next;
  renameMode = null;
  forecasts.clear();
  displayForecastCache.clear();
  clearChartSelection();
  searchResults = [];
  locationPickerOpen = false;
  searchOpen = false;
  searching = false;
  status = "Loading forecast…";
  const search = $("forecastSearch") as HTMLInputElement | null;
  if (search) search.value = "";
  zone = zoneForPoint(next.lat, next.lon) || browserZone();
  placeMarker(next, fit);
  deps.onPointChange?.(next);
  renderToolbar();
  renderSearchResults();
  if (!store) store = await deps.ensureStore();
  if (token !== selectionToken || !mounted) return;
  if (addRecent) await store.addRecent(next as LocationResult);
  else await store.setPrefs({ lastPoint: next });
  if (token !== selectionToken || !mounted) return;
  await refreshForecast(false);
}

function candidateIds(): string[] {
  return selectedModels ?? recommendedModelIds();
}

function recommendedModelIds(): string[] {
  const allIds = deps.provider.models.map((model) => model.id);
  const available = new Set(allIds);
  const preferred = DEFAULT_FORECAST_MODEL_IDS.filter((id) => available.has(id));
  return [...preferred, ...allIds.filter((id) => !preferred.includes(id))].slice(0, 5);
}

function ageLabel(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function selectedForecastEntries(): HourlyForecast[] {
  return candidateIds().flatMap((id) => {
    const item = forecasts.get(id);
    return item && Number.isFinite(item.fetchedAt) ? [item] : [];
  });
}

function oldestSelectedForecastFetchedAt(): number | null {
  const entries = selectedForecastEntries();
  return entries.length ? Math.min(...entries.map((item) => item.fetchedAt)) : null;
}

function forecastIsStale(item: HourlyForecast, now = Date.now()): boolean {
  return (
    !Number.isFinite(item.fetchedAt) || item.fetchedAt + FORECAST_REFRESH_INTERVAL_MS <= now
  );
}

function clearForecastRefreshTimer(): void {
  if (forecastRefreshTimer) clearTimeout(forecastRefreshTimer);
  forecastRefreshTimer = null;
}

function scheduleForecastRefresh(): void {
  clearForecastRefreshTimer();
  if (!mounted || !point) return;
  const fetchedAt = oldestSelectedForecastFetchedAt();
  if (fetchedAt == null) return;
  const delay = Math.max(0, fetchedAt + FORECAST_REFRESH_INTERVAL_MS - Date.now());
  forecastRefreshTimer = setTimeout(() => {
    forecastRefreshTimer = null;
    if (mounted) void refreshForecast(false);
  }, delay);
}

function scheduleForecastRetry(): void {
  clearForecastRefreshTimer();
  if (!mounted || !point || !navigator.onLine) return;
  forecastRefreshTimer = setTimeout(() => {
    forecastRefreshTimer = null;
    if (mounted) void refreshForecast(false);
  }, FORECAST_RETRY_INTERVAL_MS);
}

function startForecastAgeTimer(): void {
  if (forecastAgeTimer) clearInterval(forecastAgeTimer);
  forecastAgeTimer = setInterval(() => {
    if (mounted) renderFetchedAt();
  }, FORECAST_AGE_UPDATE_MS);
  scheduleForecastNowMarker();
}

function stopForecastTimers(): void {
  clearForecastRefreshTimer();
  if (forecastAgeTimer) clearInterval(forecastAgeTimer);
  forecastAgeTimer = null;
  if (forecastNowTimer) clearTimeout(forecastNowTimer);
  forecastNowTimer = null;
}

function cachedStatus(prefix = "Cached"): string {
  const shown = visibleForecasts();
  if (!shown.length) return `${prefix} · no usable cached forecast`;
  return `${prefix} · ${shown.length} model${shown.length === 1 ? "" : "s"}`;
}

async function refreshForecast(force: boolean): Promise<void> {
  if (!point || !store) return;
  clearForecastRefreshTimer();
  const token = ++loadToken;
  loadAbort?.abort();
  loadAbort = new AbortController();
  const now = Date.now();
  const hours = days * 24;
  const ids = candidateIds();
  if (!ids.length) {
    loading = false;
    status = "No forecast models selected.";
    renderAll();
    return;
  }
  const cached = await Promise.all(ids.map((id) => store!.getForecast(point!, id)));
  if (token !== loadToken || !mounted) return;
  const need: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = cached[i];
    if (item) forecasts.set(ids[i], item);
    // requestedHours records the attempted horizon as well as the returned tail.
    // Regional products legitimately end before a 10/15-day global comparison;
    // treating that honest short tail as a cache miss would re-request it on every visit.
    const covers = !!item && item.requestedHours >= hours;
    if (force || !item || forecastIsStale(item, now) || !covers) need.push(ids[i]);
  }
  renderAll();
  if (!need.length) {
    status = cachedStatus("Up to date");
    renderToolbar();
    scheduleForecastRefresh();
    return;
  }
  if (!navigator.onLine) {
    status = cachedStatus("Offline");
    renderToolbar();
    return;
  }
  loading = true;
  const cachedCount = visibleForecasts().length;
  status = `Updating ${need.length} model${need.length === 1 ? "" : "s"}…${cachedCount ? ` · showing ${cachedCount} cached` : ""}`;
  renderToolbar();
  try {
    const result = await deps.provider.fetchForecast(point, need, hours, loadAbort.signal);
    if (token !== loadToken) return;
    for (const item of result.forecasts) {
      const merged = mergeForecastHistory(
        item,
        forecasts.get(item.modelId),
        now,
        FORECAST_HISTORY_HOURS,
      );
      forecasts.set(item.modelId, merged);
      await store.putForecast(merged);
    }
    const available = visibleForecasts();
    status = available.length
      ? cachedStatus("Updated")
      : "No forecast models returned wind data for this point.";
    const shouldRetry = need.some((id) => {
      const item = forecasts.get(id);
      return !item || forecastIsStale(item) || item.requestedHours < hours;
    });
    if (shouldRetry) scheduleForecastRetry();
    else scheduleForecastRefresh();
  } catch (error) {
    if (token !== loadToken || !mounted || (error as Error).name === "AbortError") return;
    const stale = visibleForecasts().length;
    status = stale
      ? cachedStatus(navigator.onLine ? "Refresh failed" : "Offline")
      : navigator.onLine
        ? "Forecast unavailable."
        : "Offline · no cached forecast";
    scheduleForecastRetry();
    deps.toast(error instanceof Error ? error.message : "Forecast request failed.", true);
  } finally {
    if (token === loadToken) {
      loading = false;
      renderAll();
    }
  }
}

function visibleForecasts(): HourlyForecast[] {
  const ids = candidateIds();
  const hourMs = 3_600_000;
  const currentHour = Math.floor(Date.now() / hourMs) * hourMs;
  const startMs = currentHour - FORECAST_HISTORY_HOURS * hourMs;
  const endMs = currentHour + days * 24 * hourMs;
  return ids.flatMap((id) => {
    const item = forecasts.get(id);
    if (!item || item.noData) return [];
    const cached = displayForecastCache.get(id);
    if (cached?.source === item && cached.startMs === startMs && cached.endMs === endMs) {
      return cached.value.times.length ? [cached.value] : [];
    }
    const value = sliceForecastWindow(item, startMs, endMs);
    displayForecastCache.set(id, { source: item, startMs, endMs, value });
    return value.times.length ? [value] : [];
  });
}

function visibleCompareForecasts(): HourlyForecast[] {
  return visibleForecasts().filter((item) => !hiddenCompareModels.has(item.modelId));
}

function modelFor(id: string): ForecastModel {
  return deps.provider.models.find((model) => model.id === id)!;
}

function chartOptions(): ForecastChartOptions {
  return {
    metrics: new Set(metrics),
    speedUnit,
    focusedLane,
    focusedModelId: presentation === "compare" ? hoveredCompareModel : null,
    showModelTracks: compareStyle === "models",
    cursorDetails:
      presentation === "compare" && selectionSource === "touch" ? "external" : "inline",
    modelLabels: new Map(
      deps.provider.models.map((model) => [model.id, `${model.provider} · ${model.label}`]),
    ),
  };
}

function renderAll(): void {
  renderToolbar();
  renderSearchResults();
  renderModelPicker();
  renderDisplayOptions();
  renderCharts();
}

function renderFetchedAt(): void {
  const time = $("forecastFetchedAt") as HTMLTimeElement | null;
  if (!time) return;
  const fetchedAt = oldestSelectedForecastFetchedAt();
  time.toggleAttribute("hidden", fetchedAt == null);
  if (fetchedAt == null) {
    time.removeAttribute("datetime");
    time.removeAttribute("title");
    time.removeAttribute("aria-label");
    const age = $("forecastFetchedAge");
    if (age) age.textContent = "";
    return;
  }
  const relative = ageLabel(fetchedAt);
  const exact = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(fetchedAt);
  time.dateTime = new Date(fetchedAt).toISOString();
  time.title = `Oldest selected forecast fetched ${exact}`;
  time.setAttribute("aria-label", `Forecast last fetched ${relative}, at ${exact}`);
  const age = $("forecastFetchedAge");
  if (age) age.textContent = relative;
}

function renderToolbar(): void {
  const label = $("forecastPointLabel");
  if (label) label.textContent = point?.label ?? "No point selected";
  const stat = $("forecastStatus");
  if (stat) stat.textContent = status;
  renderFetchedAt();
  const refresh = $("forecastRefresh");
  refresh?.toggleAttribute("disabled", !point || loading);
  refresh?.classList.toggle("loading", loading);
  refresh?.setAttribute("aria-label", loading ? "Refreshing forecast" : "Refresh forecast");
  const locate = $("forecastLocate");
  if (locate) {
    const locateLabel = locating ? "Locating your position…" : "Use my current location";
    locate.toggleAttribute("disabled", locating);
    locate.classList.toggle("locating", locating);
    locate.setAttribute("aria-busy", locating ? "true" : "false");
    locate.setAttribute("aria-label", locateLabel);
    locate.setAttribute("title", locateLabel);
  }
  const searchToggle = $("forecastSearchToggle");
  if (searchToggle) {
    searchToggle.classList.toggle("active", locationPickerOpen);
    searchToggle.setAttribute("aria-expanded", locationPickerOpen ? "true" : "false");
    searchToggle.setAttribute(
      "aria-label",
      locationPickerOpen ? "Close location search" : "Search locations",
    );
    searchToggle.setAttribute(
      "title",
      locationPickerOpen ? "Close location search" : "Search locations",
    );
  }
  $("forecastLocationPicker")?.toggleAttribute("hidden", !locationPickerOpen);
  const star = $("forecastPin");
  const favorite = !!point && !!store?.isFavorite(point);
  if (star) {
    star.toggleAttribute("disabled", !point);
    star.classList.toggle("active", favorite);
    star.setAttribute("aria-pressed", favorite ? "true" : "false");
    star.setAttribute("aria-label", favorite ? "Unpin this location" : "Pin this location");
    star.setAttribute("title", favorite ? "Unpin this location" : "Pin this location");
  }
  $("forecastPointTitle")?.toggleAttribute("hidden", !!renameMode);
  $("forecastRenameForm")?.toggleAttribute("hidden", !renameMode);
  $("forecastRename")?.toggleAttribute("hidden", !favorite || !!renameMode);
  document.querySelectorAll<HTMLButtonElement>("#forecastRange button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.days) === days);
  });
}

function renderModelPicker(): void {
  const host = $("forecastModelsList");
  if (!host) return;
  const checked = new Set(candidateIds());
  const available = new Set(
    [...forecasts.values()].filter((f) => !f.noData).map((f) => f.modelId),
  );
  const grouped = new Map<string, ForecastModel[]>();
  for (const model of deps.provider.models) {
    const list = grouped.get(model.provider) ?? [];
    list.push(model);
    grouped.set(model.provider, list);
  }
  host.innerHTML = [...grouped]
    .map(([provider, models]) => {
      const selectedCount = models.filter((model) => checked.has(model.id)).length;
      const state =
        selectedCount === 0 ? "none" : selectedCount === models.length ? "all" : "mixed";
      const nextAction = state === "all" ? "Clear" : "Select";
      return (
        `<fieldset><legend><button type="button" class="fc-model-group ${state}" ` +
        `data-model-group="${deps.esc(provider)}" aria-pressed="${state === "mixed" ? "mixed" : state === "all"}" ` +
        `title="${nextAction} all ${deps.esc(provider)} models"><i aria-hidden="true"></i>` +
        `<span>${deps.esc(provider)}</span><small>${selectedCount}/${models.length}</small></button></legend>` +
        models
          .map(
            (model) =>
              `<label class="fc-model-opt ${available.has(model.id) ? "available" : ""}">` +
              `<input type="checkbox" data-model="${model.id}" ${checked.has(model.id) ? "checked" : ""}>` +
              `<span>${deps.esc(model.label)} <small>${deps.esc(model.resolution)} · ${model.nativeHours}h native · ${model.horizonDays}d</small></span></label>`,
          )
          .join("") +
        `</fieldset>`
      );
    })
    .join("");
  const count = $("forecastModelCount");
  if (count) count.textContent = `${visibleForecasts().length} shown`;
  const recommended = new Set(recommendedModelIds());
  const isRecommended =
    checked.size === recommended.size && [...checked].every((id) => recommended.has(id));
  const presets: Array<[string, boolean]> = [
    ["forecastModelsRecommended", isRecommended],
    ["forecastModelsReset", checked.size === deps.provider.models.length],
    ["forecastModelsClear", checked.size === 0],
  ];
  for (const [id, active] of presets) {
    const button = $(id);
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function renderDisplayOptions(): void {
  document
    .querySelectorAll<HTMLButtonElement>("#forecastSpeedUnit button[data-speed-unit]")
    .forEach((button) => {
      button.classList.toggle("active", button.dataset.speedUnit === speedUnit);
      button.setAttribute(
        "aria-pressed",
        button.dataset.speedUnit === speedUnit ? "true" : "false",
      );
    });
  document
    .querySelectorAll<HTMLButtonElement>("#forecastPresentation button[data-presentation]")
    .forEach((button) => {
      button.classList.toggle("active", button.dataset.presentation === presentation);
      button.setAttribute(
        "aria-pressed",
        button.dataset.presentation === presentation ? "true" : "false",
      );
    });
  const enabled = new Set(metrics);
  document
    .querySelectorAll<HTMLInputElement>("#forecastMetricList input[data-forecast-metric]")
    .forEach((input) => {
      input.checked = enabled.has(input.dataset.forecastMetric as ForecastMetric);
    });
  document
    .querySelectorAll<HTMLElement>("#forecastLegend [data-forecast-metric]")
    .forEach((item) => {
      item.classList.toggle(
        "hidden",
        !enabled.has(item.dataset.forecastMetric as ForecastMetric),
      );
    });
  const comparisonLegend = $("forecastCompareLegend");
  if (comparisonLegend) {
    const shown = visibleForecasts();
    const hiddenCount = shown.filter((item) => hiddenCompareModels.has(item.modelId)).length;
    comparisonLegend.classList.toggle("hidden", presentation !== "compare" || !shown.length);
    comparisonLegend.innerHTML =
      `<span class="fc-compare-style" role="group" aria-label="Comparison detail"><button type="button" data-compare-style="consensus" class="${compareStyle === "consensus" ? "active" : ""}" aria-pressed="${compareStyle === "consensus"}" aria-label="Consensus — model minimum–maximum range with bold median" title="Model minimum–maximum range with a bold median">Consensus</button><button type="button" data-compare-style="models" class="${compareStyle === "models" ? "active" : ""}" aria-pressed="${compareStyle === "models"}">All lines</button></span>` +
      shown
        .map((item) => {
          const model = modelFor(item.modelId);
          const active = !hiddenCompareModels.has(item.modelId);
          const focused = active && hoveredCompareModel === item.modelId;
          const color = forecastModelColor(item.modelId);
          return `<button type="button" class="fc-track-toggle${active ? " active" : ""}${focused ? " focused" : ""}" style="--model-color:${color}" data-compare-model="${deps.esc(item.modelId)}" aria-pressed="${active}" title="${active ? "Hide" : "Show"} ${deps.esc(`${model.provider} ${model.label}`)}; double-click to isolate"><i></i><span>${deps.esc(model.provider)} · ${deps.esc(model.label)}</span></button>`;
        })
        .join("") +
      (hiddenCount
        ? `<button type="button" class="fc-tracks-reset" id="forecastCompareShowAll">Show all</button>`
        : "");
  }
  renderTableControls();
}

const FORECAST_HOUR_MS = 3_600_000;
const TABLE_HOUR_WIDTH = 80;

function updateTableNowMarker(now = Date.now()): void {
  const host = $("forecastCharts");
  if (!host || presentation !== "textual") return;
  const currentHour = Math.floor(now / FORECAST_HOUR_MS) * FORECAST_HOUR_MS;
  const progress = Math.max(0, Math.min(1, (now - currentHour) / FORECAST_HOUR_MS));
  const remaining = Math.max(1, currentHour + FORECAST_HOUR_MS - now);
  host.style.setProperty("--fc-now-progress", progress.toFixed(6));
  host.style.setProperty("--fc-now-duration", `${remaining}ms`);
  host.querySelectorAll<HTMLElement>("[data-time].current").forEach((cell) => {
    cell.classList.remove("current");
  });
  // Restart the CSS animation from the exact wall-clock position after a render or wake.
  void host.offsetWidth;
  host.querySelectorAll<HTMLElement>(`[data-time="${currentHour}"]`).forEach((cell) => {
    cell.classList.add("current");
  });
}

function scheduleForecastNowMarker(): void {
  if (forecastNowTimer) clearTimeout(forecastNowTimer);
  forecastNowTimer = null;
  if (!mounted) return;
  const now = Date.now();
  updateTableNowMarker(now);
  const delay = FORECAST_HOUR_MS - (now % FORECAST_HOUR_MS) + 50;
  forecastNowTimer = setTimeout(() => scheduleForecastNowMarker(), delay);
}

function tableMetricOptions(): ForecastMetric[] {
  const enabled = new Set(metrics);
  const options: ForecastMetric[] = [];
  if (enabled.has("windSpeed")) options.push("windSpeed");
  else if (enabled.has("windGust")) options.push("windGust");
  for (const metric of DEFAULT_FORECAST_METRICS) {
    if (metric === "windSpeed" || metric === "windGust" || !enabled.has(metric)) continue;
    options.push(metric);
  }
  return options;
}

function activeTableMetric(): ForecastMetric {
  const options = tableMetricOptions();
  if (!options.includes(tableMetric) && options[0]) tableMetric = options[0];
  return tableMetric;
}

function tableMetricLabel(metric: ForecastMetric): string {
  if (metric === "windSpeed") return metrics.includes("windGust") ? "Wind + gust" : "Wind";
  if (metric === "windGust") return "Gusts";
  if (metric === "windDirection") return "Direction";
  if (metric === "precipitation") return "Rain";
  if (metric === "temperature") return "Temperature";
  if (metric === "pressure") return "Pressure";
  return "Cloud";
}

function tableMetricUnit(metric: ForecastMetric): string {
  if (metric === "windSpeed")
    return metrics.includes("windGust")
      ? `${speedUnitLabel(speedUnit)} · gust shown smaller`
      : speedUnitLabel(speedUnit);
  if (metric === "windGust") return speedUnitLabel(speedUnit);
  if (metric === "windDirection") return "from · degrees";
  if (metric === "precipitation") return "mm";
  if (metric === "temperature") return "°C";
  if (metric === "pressure") return "hPa";
  return "%";
}

function tableMetricShortUnit(metric: ForecastMetric): string {
  if (metric === "windSpeed" || metric === "windGust") return speedUnitLabel(speedUnit);
  if (metric === "windDirection") return "°";
  if (metric === "precipitation") return "mm";
  if (metric === "temperature") return "°C";
  if (metric === "pressure") return "hPa";
  return "%";
}

function tableMetricIcon(metric: ForecastMetric): string {
  const paths: Record<ForecastMetric, string> = {
    windSpeed: '<path d="M3 7h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 17h7"/>',
    windGust: '<path d="M3 7h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 17h7"/>',
    windDirection: '<path d="m12 3 4 9-4-2-4 2 4-9Z"/><path d="M12 10v11"/>',
    precipitation: '<path d="M12 3s-5 5.7-5 10a5 5 0 0 0 10 0c0-4.3-5-10-5-10Z"/>',
    temperature: '<path d="M10 14.8V5a2 2 0 1 1 4 0v9.8a4 4 0 1 1-4 0Z"/><path d="M12 11v6"/>',
    pressure:
      '<circle cx="12" cy="13" r="8"/><path d="m12 13 4-4M7 18l-1.5 1.5M17 18l1.5 1.5"/>',
    cloudCover: '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.7A3.2 3.2 0 0 0 7 18Z"/>',
  };
  return `<svg class="mi fc-table-metric-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[metric]}</svg>`;
}

function renderTableControls(): void {
  const host = $("forecastTableControls");
  if (!host) return;
  const options = tableMetricOptions();
  const shown = presentation === "textual" && options.length > 0;
  host.classList.toggle("hidden", !shown);
  if (!shown) {
    host.innerHTML = "";
    return;
  }
  const metric = activeTableMetric();
  host.innerHTML =
    `<b>Measure</b>` +
    (options.length > 1
      ? `<span class="seg" role="group" aria-label="Table measure">${options
          .map((option) => {
            const label = tableMetricLabel(option);
            return `<button type="button" data-table-metric="${option}" class="${option === metric ? "active" : ""}" aria-pressed="${option === metric}" aria-label="${deps.esc(label)}" title="${deps.esc(label)}">${tableMetricIcon(option)}<span>${deps.esc(label)}</span></button>`;
          })
          .join("")}</span>`
      : `<span class="fc-table-measure">${deps.esc(tableMetricLabel(metric))}</span>`) +
    `<small aria-label="${deps.esc(tableMetricUnit(metric))}"><span class="fc-table-unit-wide">${deps.esc(tableMetricUnit(metric))}</span><span class="fc-table-unit-narrow">${deps.esc(tableMetricShortUnit(metric))}</span></small>`;
}

function modelHeader(model: ForecastModel, stale: boolean): string {
  const name = `${model.provider} ${model.label}`;
  const selected = selectedTableModel === model.id;
  return (
    `<header title="${deps.esc(name)}"><b>${deps.esc(model.provider)}</b><span>${deps.esc(model.label)}</span>` +
    `<small>${deps.esc(model.resolution)} · ${model.nativeHours}h native${stale ? " · stale" : ""}</small>` +
    `<span class="fc-model-compact" title="${deps.esc(name)}"><span class="fc-model-compact-text"><b>${deps.esc(model.provider)}</b> ${deps.esc(model.label)}</span></span>` +
    (presentation === "textual"
      ? `<button type="button" class="fc-model-reveal" data-table-model="${deps.esc(model.id)}" aria-pressed="${selected}" aria-label="${selected ? "Hide" : "Show"} details for ${deps.esc(name)}" title="${deps.esc(name)}"><svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg></button>`
      : "") +
    `</header>`
  );
}

function hourlyTable(
  item: HourlyForecast,
  timeline: ReturnType<typeof sharedForecastTimeline>,
  metric: ForecastMetric,
): string {
  const indexes = new Map(item.times.map((time, index) => [time, index]));
  const wind = (value: number | null | undefined): string =>
    value == null
      ? "—"
      : convertWindSpeed(value, speedUnit).toFixed(speedUnit === "kmh" ? 0 : 1);
  const value = (itemValue: number | null | undefined, digits = 0): string =>
    itemValue == null ? "—" : itemValue.toFixed(digits);
  const cellValue = (index: number): string | null => {
    if (metric === "windSpeed") {
      const average = item.windSpeedKmh[index];
      const gust = metrics.includes("windGust") ? item.windGustKmh[index] : null;
      if (average == null && gust == null) return null;
      return (
        `<span class="fc-hour-primary wind">${wind(average)}</span>` +
        (gust == null ? "" : `<span class="fc-hour-secondary gust">gust ${wind(gust)}</span>`)
      );
    }
    if (metric === "windGust") {
      const gust = item.windGustKmh[index];
      return gust == null ? null : `<span class="fc-hour-primary gust">${wind(gust)}</span>`;
    }
    if (metric === "windDirection") {
      const direction = item.windDirectionDeg[index];
      return direction == null
        ? null
        : `<span class="fc-hour-primary direction"><i style="--direction:${windTravelDeg(direction)}deg">↑</i>${compassFrom(direction)}</span><span class="fc-hour-secondary">${Math.round(direction)}°</span>`;
    }
    if (metric === "precipitation") {
      const rain = item.precipitationMm[index];
      return rain == null
        ? null
        : `<span class="fc-hour-primary rain">${value(rain, 1)}</span>`;
    }
    if (metric === "temperature") {
      const temperature = item.temperatureC[index];
      return temperature == null
        ? null
        : `<span class="fc-hour-primary temp">${value(temperature, 1)}</span>`;
    }
    if (metric === "pressure") {
      const pressure = item.pressureHpa[index];
      return pressure == null
        ? null
        : `<span class="fc-hour-primary pressure">${value(pressure)}</span>`;
    }
    const cloud = item.cloudCoverPct[index];
    return cloud == null ? null : `<span class="fc-hour-primary cloud">${value(cloud)}</span>`;
  };
  const currentHour = Math.floor(Date.now() / FORECAST_HOUR_MS) * FORECAST_HOUR_MS;
  const cells: string[] = [];
  for (let offset = 0; offset < timeline.hours; offset++) {
    const time = timeline.startMs + offset * FORECAST_HOUR_MS;
    const index = indexes.get(time) ?? -1;
    const content = index >= 0 ? cellValue(index) : null;
    const available = content != null;
    const classes = [
      "fc-hour-cell",
      available ? "" : "empty",
      time === currentHour ? "current" : "",
      time === selectedTime ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    cells.push(
      `<div class="${classes}" role="cell" data-time="${time}">${content ?? `<span class="fc-hour-empty">No data</span>`}</div>`,
    );
  }
  const width = Math.max(TABLE_HOUR_WIDTH, timeline.hours * TABLE_HOUR_WIDTH);
  return `<div class="fc-hourly-grid" role="row" style="width:${width}px;grid-template-columns:repeat(${timeline.hours},${TABLE_HOUR_WIDTH}px)">${cells.join("")}</div>`;
}

function hourlyTableHeading(timeline: ReturnType<typeof sharedForecastTimeline>): string {
  const weekdayFmt = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: "short",
  });
  const dayFmt = new Intl.DateTimeFormat(undefined, { timeZone: zone, day: "numeric" });
  const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const hourFmt = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const currentHour = Math.floor(Date.now() / FORECAST_HOUR_MS) * FORECAST_HOUR_MS;
  let previousDay = "";
  const cells: string[] = [];
  for (let offset = 0; offset < timeline.hours; offset++) {
    const time = timeline.startMs + offset * FORECAST_HOUR_MS;
    const dayKey = dayKeyFmt.format(time);
    const day =
      dayKey !== previousDay ? `${weekdayFmt.format(time)} ${dayFmt.format(time)}` : "";
    previousDay = dayKey;
    const classes = [
      "fc-hour-heading",
      time === currentHour ? "current" : "",
      time === selectedTime ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    cells.push(
      `<div class="${classes}" role="columnheader" data-time="${time}" title="${deps.esc(`${weekdayFmt.format(time)} ${dayFmt.format(time)}, ${hourFmt.format(time)}`)}">${day ? `<b>${deps.esc(day)}</b>` : ""}<span>${deps.esc(hourFmt.format(time))}</span></div>`,
    );
  }
  const width = Math.max(TABLE_HOUR_WIDTH, timeline.hours * TABLE_HOUR_WIDTH);
  return (
    `<div class="fc-hourly-heading-row" role="row"><div class="fc-hourly-corner" role="columnheader">Local time</div>` +
    `<div class="fc-hourly-grid fc-hourly-headings" style="width:${width}px;grid-template-columns:repeat(${timeline.hours},${TABLE_HOUR_WIDTH}px)">${cells.join("")}</div></div>`
  );
}

function updateTableSelection(): void {
  const host = $("forecastCharts");
  if (!host) return;
  host.querySelectorAll("[data-time].selected").forEach((cell) => {
    cell.classList.remove("selected");
  });
  if (selectedTime == null) return;
  host.querySelectorAll(`[data-time="${selectedTime}"]`).forEach((cell) => {
    cell.classList.add("selected");
  });
}

function renderCharts(): void {
  const host = $("forecastCharts");
  if (!host) return;
  const shown = visibleForecasts();
  if (!point || !shown.length || !metrics.length) {
    const empty = !point
      ? "Pick a point on the map or search for a location to compare forecasts."
      : !metrics.length
        ? "Choose at least one displayed variable."
        : status;
    host.innerHTML = `<div class="stats-empty">${deps.esc(empty)}</div>`;
    renderReadout();
    return;
  }
  const options = chartOptions();
  const timeline = sharedForecastTimeline(shown);
  const isTable = presentation === "textual";
  const isCompare = presentation === "compare";
  const selectedTableMetric = isTable ? activeTableMetric() : null;
  const compared = isCompare ? visibleCompareForecasts() : shown;
  const width = chartWidthForHours(
    timeline.hours,
    Math.max(620, host.clientWidth - (isCompare ? 0 : 190)),
  );
  const height = isCompare
    ? forecastComparisonHeight(window.innerHeight)
    : forecastChartHeight(options.metrics);
  const oldScroll = host.scrollLeft;
  const oldScrollTop = host.scrollTop;
  const presentationChanged = renderedPresentation !== presentation;
  renderedPresentation = presentation;
  rowObserver?.disconnect();
  host.classList.toggle("textual-mode", isTable);
  host.classList.toggle("compare-mode", isCompare);
  host.setAttribute("role", isTable ? "table" : "application");
  host.setAttribute(
    "aria-label",
    isTable
      ? `Hourly ${tableMetricLabel(selectedTableMetric!)} comparison table`
      : isCompare
        ? "Combined forecast model spread chart"
        : "Forecast model comparison",
  );
  $("forecastLegend")?.classList.toggle("table-hidden", isTable);
  const rows = shown
    .map((item) => {
      const model = modelFor(item.modelId);
      const stale = forecastIsStale(item);
      return (
        `<article class="fc-model-row" data-model-row="${model.id}">` +
        modelHeader(model, stale) +
        (isTable
          ? hourlyTable(item, timeline, selectedTableMetric!)
          : `<canvas style="width:${width}px;height:${height}px" aria-label="Hourly forecast from ${deps.esc(model.provider)} ${deps.esc(model.label)}"></canvas>`) +
        `</article>`
      );
    })
    .join("");
  host.innerHTML = isTable
    ? hourlyTableHeading(timeline) + rows
    : isCompare
      ? compared.length
        ? `<canvas class="fc-compare-canvas" style="width:${width}px;height:${height}px" aria-label="Combined hourly forecast from ${compared.length} enabled models"></canvas>`
        : `<div class="fc-compare-empty" style="height:${height}px">All model tracks are hidden. Enable one in the legend above.</div>`
      : rows;
  if (isTable && presentationChanged) {
    const nowIndex = Math.max(
      0,
      Math.min(
        timeline.hours - 1,
        Math.floor((Date.now() - timeline.startMs) / FORECAST_HOUR_MS),
      ),
    );
    host.scrollLeft = Math.max(0, nowIndex * TABLE_HOUR_WIDTH - 40);
  } else {
    host.scrollLeft = presentationChanged ? 0 : oldScroll;
  }
  host.scrollTop = oldScrollTop;
  if (isTable) {
    updateTableNowMarker();
    renderReadout();
    return;
  }
  const scales = sharedForecastScales(shown, options);
  if (isCompare) {
    const canvas = host.querySelector<HTMLCanvasElement>(".fc-compare-canvas");
    if (canvas) {
      drawForecastComparison(
        canvas,
        compared,
        sharedForecastScales(compared, options),
        timeline,
        selectedTime,
        zone,
        options,
      );
      canvas.dataset.drawn = "1";
    }
    renderReadout();
    return;
  }
  const drawRow = (row: Element): void => {
    const modelId = (row as HTMLElement).dataset.modelRow;
    const item = modelId ? forecasts.get(modelId) : null;
    const canvas = row.querySelector<HTMLCanvasElement>("canvas");
    if (!item || !canvas) return;
    drawForecastRow(canvas, item, scales, timeline, selectedTime, zone, options);
    canvas.dataset.drawn = "1";
  };
  if (typeof IntersectionObserver === "function") {
    rowObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) drawRow(entry.target);
      },
      { root: host, rootMargin: "300px 0px" },
    );
    host.querySelectorAll(".fc-model-row").forEach((row) => {
      rowObserver?.observe(row);
    });
  } else {
    host.querySelectorAll(".fc-model-row").forEach(drawRow);
  }
  renderReadout();
}

/** Redraw only rows that have been painted; the observer paints newly visible rows. */
function redrawCharts(): void {
  const host = $("forecastCharts");
  const shown = visibleForecasts();
  if (!host || !shown.length || !metrics.length) return;
  if (presentation === "textual") {
    updateTableSelection();
    return;
  }
  const options = chartOptions();
  const scales = sharedForecastScales(shown, options);
  const timeline = sharedForecastTimeline(shown);
  if (presentation === "compare") {
    const compared = visibleCompareForecasts();
    const canvas = host.querySelector<HTMLCanvasElement>('.fc-compare-canvas[data-drawn="1"]');
    if (canvas && compared.length)
      drawForecastComparison(
        canvas,
        compared,
        sharedForecastScales(compared, options),
        timeline,
        selectedTime,
        zone,
        options,
      );
    return;
  }
  for (const item of shown) {
    const canvas = host.querySelector<HTMLCanvasElement>(
      `[data-model-row="${item.modelId}"] canvas[data-drawn="1"]`,
    );
    if (canvas) drawForecastRow(canvas, item, scales, timeline, selectedTime, zone, options);
  }
}

function isMobileDetail(): boolean {
  return window.matchMedia?.("(max-width: 760px)").matches ?? window.innerWidth <= 760;
}

function detailHeightBounds(): { min: number; max: number } {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const max = Math.max(1, Math.floor(viewportHeight * DETAIL_MAX_VIEWPORT_SHARE));
  return { min: Math.min(DETAIL_MIN_HEIGHT, max), max };
}

function clampDetailHeight(height: number): number {
  const { min, max } = detailHeightBounds();
  return Math.max(min, Math.min(max, Math.round(height)));
}

function applyDetailHeight(): void {
  const sheet = $("forecastCompareDetail");
  if (!sheet) return;
  const resized = isMobileDetail() && compareDetailHeightPx != null;
  sheet.classList.toggle("resized", resized);
  sheet.style.height = resized ? `${clampDetailHeight(compareDetailHeightPx!)}px` : "";
}

function onDetailResizeStart(event: PointerEvent): void {
  const handle = (event.target as HTMLElement).closest<HTMLElement>(
    ".fc-detail-resize-handle",
  );
  const sheet = $("forecastCompareDetail");
  if (!handle || !sheet || !isMobileDetail() || sheet.classList.contains("hidden")) return;
  detailResize = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: sheet.getBoundingClientRect().height,
    originalHeight: compareDetailHeightPx,
  };
  handle.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onDetailResizeMove(event: PointerEvent): void {
  if (!detailResize || detailResize.pointerId !== event.pointerId) return;
  compareDetailHeightPx = clampDetailHeight(
    detailResize.startHeight + detailResize.startY - event.clientY,
  );
  applyDetailHeight();
}

function onDetailResizeEnd(event: PointerEvent): void {
  if (!detailResize || detailResize.pointerId !== event.pointerId) return;
  if (event.type === "pointercancel") {
    compareDetailHeightPx = detailResize.originalHeight;
    applyDetailHeight();
  } else if (compareDetailHeightPx != null) {
    void store?.setPrefs({ compareDetailHeightPx });
  }
  detailResize = null;
}

function onDetailResizeKeydown(event: KeyboardEvent): void {
  if (!(event.target as HTMLElement).classList.contains("fc-detail-resize-handle")) return;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const sheet = $("forecastCompareDetail");
  if (!sheet || !isMobileDetail()) return;
  compareDetailHeightPx = clampDetailHeight(
    sheet.getBoundingClientRect().height + (event.key === "ArrowUp" ? 40 : -40),
  );
  applyDetailHeight();
  void store?.setPrefs({ compareDetailHeightPx });
  event.preventDefault();
}

function stepCompareDetailHour(step: -1 | 1): void {
  if (selectedTime == null || !focusedLane || selectionSource !== "touch") return;
  const timeline = sharedForecastTimeline(visibleForecasts());
  const next = Math.max(
    timeline.startMs,
    Math.min(timeline.endMs, selectedTime + step * FORECAST_HOUR_MS),
  );
  if (next === selectedTime) return;
  selectedTime = next;
  redrawCharts();
  renderReadout();
}

function renderCompareDetailSheet(): void {
  const sheet = $("forecastCompareDetail");
  const compared = visibleCompareForecasts();
  if (
    !sheet ||
    presentation !== "compare" ||
    selectionSource !== "touch" ||
    selectedTime == null ||
    !focusedLane ||
    !compared.length
  ) {
    detailResize = null;
    sheet?.classList.add("hidden");
    if (sheet) sheet.innerHTML = "";
    return;
  }
  const previousScroll = sheet.querySelector<HTMLElement>(".fc-detail-models")?.scrollTop ?? 0;
  const focusedId = sheet.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).id
    : "";
  const details = forecastComparisonDetails(
    compared,
    selectedTime,
    focusedLane,
    chartOptions(),
  );
  const date = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(selectedTime);
  const timeline = sharedForecastTimeline(visibleForecasts());
  sheet.innerHTML =
    `<div class="fc-detail-inner"><button type="button" class="fc-detail-resize-handle" id="forecastCompareDetailResize" aria-label="Drag or use up and down arrows to resize forecast details"></button><header><div class="fc-detail-title"><small>${deps.esc(date)}</small>` +
    `<b>${deps.esc(details.title)}</b></div><div class="fc-detail-actions">` +
    `<span class="seg fc-detail-step-group" role="group" aria-label="Forecast hour">` +
    `<button type="button" class="fc-detail-step" id="forecastCompareDetailPrev" data-detail-step="-1" aria-label="Previous hour"${selectedTime <= timeline.startMs ? " disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>` +
    `<button type="button" class="fc-detail-step" id="forecastCompareDetailNext" data-detail-step="1" aria-label="Next hour"${selectedTime >= timeline.endMs ? " disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button></span>` +
    `<button type="button" id="forecastCompareDetailClose" aria-label="Close forecast details"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></header>` +
    `<div class="fc-detail-models"><table><thead><tr><th scope="col">Model</th>${details.columns.map((column) => `<th scope="col">${deps.esc(column.label)}</th>`).join("")}</tr></thead><tbody>` +
    `<tr class="fc-detail-summary"><th scope="row">Range (median)</th>${details.columns.map((column) => `<td>${deps.esc(column.summary)}</td>`).join("")}</tr>` +
    details.models
      .map(
        (row) =>
          `<tr><th scope="row"><span class="fc-detail-model-name"><i style="--model-color:${forecastModelColor(row.modelId)}"></i>` +
          `<span>${deps.esc(row.label)}</span></span></th>${row.cells.map((cell) => `<td>${deps.esc(cell)}</td>`).join("")}</tr>`,
      )
      .join("") +
    `</tbody></table></div></div>`;
  sheet.classList.remove("hidden");
  applyDetailHeight();
  const modelList = sheet.querySelector<HTMLElement>(".fc-detail-models");
  if (modelList) modelList.scrollTop = previousScroll;
  if (focusedId) {
    const focusTarget = sheet.querySelector<HTMLElement>(`#${focusedId}`);
    if (focusTarget instanceof HTMLButtonElement && focusTarget.disabled) {
      const otherId =
        focusedId === "forecastCompareDetailPrev"
          ? "forecastCompareDetailNext"
          : "forecastCompareDetailPrev";
      sheet.querySelector<HTMLElement>(`#${otherId}`)?.focus({ preventScroll: true });
    } else {
      focusTarget?.focus({ preventScroll: true });
    }
  }
}

function renderReadout(): void {
  const host = $("forecastReadout");
  if (!host) return;
  const shown = presentation === "compare" ? visibleCompareForecasts() : visibleForecasts();
  renderCompareDetailSheet();
  if (!metrics.length) {
    host.textContent = "Choose one or more displayed variables.";
    return;
  }
  if (presentation === "textual") {
    const selectedItem = selectedTableModel
      ? shown.find((item) => item.modelId === selectedTableModel)
      : null;
    if (selectedItem) {
      const model = modelFor(selectedItem.modelId);
      const cadence = model.nativeHours === 1 ? "hourly" : `${model.nativeHours}-hour`;
      host.innerHTML =
        `<b>${deps.esc(`${model.provider} · ${model.label}`)}</b>` +
        `<span>${deps.esc(`${model.resolution} grid · ${cadence} native data · ${model.horizonDays}-day horizon${forecastIsStale(selectedItem) ? " · stale" : ""}`)}</span>`;
      return;
    }
    selectedTableModel = null;
    const guidance = canHover()
      ? "Choose one measure above, then scan across models and hours; hover or click a column to align it."
      : "Choose one measure above, then scan across models and hours; tap a column to align it.";
    if (selectedTime == null || selectionSource === "hover") {
      host.textContent = guidance;
      return;
    }
    const date = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(selectedTime);
    const options = chartOptions();
    const announcement = shown
      .map((item) => {
        const model = modelFor(item.modelId);
        const index = item.times.indexOf(selectedTime!);
        const values =
          index < 0 || !hasForecastValueAt(item, index, options.metrics)
            ? ["No forecast for this hour"]
            : Object.values(forecastLaneReadouts(item, index, options));
        return `${model.provider} ${model.label}: ${values.join("; ")}`;
      })
      .join(". ");
    host.innerHTML =
      `<b>${deps.esc(date)}</b><span>Showing ${deps.esc(tableMetricLabel(activeTableMetric()))} across models; choose another measure above or use ←/→ to step through hours.</span>` +
      `<span class="fc-a11y-values">${deps.esc(announcement)}</span>`;
    return;
  }
  if (presentation === "compare" && selectionSource === "touch") {
    host.textContent =
      compareStyle === "consensus"
        ? "Consensus shows the median and model range; tap the chart for details."
        : "All model lines are visible; tap the chart for details.";
    return;
  }
  if (selectedTime == null || !shown.length) {
    host.textContent =
      presentation === "compare"
        ? canHover()
          ? compareStyle === "consensus"
            ? "Consensus shows the median and min–max band; hover a model above to reveal its line."
            : "All model lines are visible; hover a model above to emphasize it."
          : compareStyle === "consensus"
            ? "Consensus shows the median and model range; tap the chart for details."
            : "All model lines are visible; tap the chart for details."
        : "Hover a chart or use ←/→ while the chart stack is focused; values appear beside the cursor in every model row.";
    return;
  }
  const at = selectedTime;
  const date = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  const options = chartOptions();
  const announcement = shown
    .map((item) => {
      const model = modelFor(item.modelId);
      const index = item.times.indexOf(at);
      const values =
        index < 0 || !hasForecastValueAt(item, index, options.metrics)
          ? ["No forecast for this hour"]
          : Object.values(forecastLaneReadouts(item, index, options));
      return `${model.provider} ${model.label}: ${values.join("; ")}`;
    })
    .join(". ");
  host.innerHTML =
    `<b>${deps.esc(date)}</b><span>${presentation === "compare" ? "The focused band shows model spread and median." : "Values are labelled at the cursor in every model row."}</span>` +
    `<span class="fc-a11y-values">${deps.esc(announcement)}</span>`;
}

function updateChartSelection(event: PointerEvent, source: "hover" | "touch"): void {
  const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-time]");
  if (cell?.dataset.time) {
    if (source === "touch") return;
    focusedLane = null;
    const nextTime = Number(cell.dataset.time);
    if (selectedTime === nextTime && selectionSource === source) return;
    selectedTime = nextTime;
    selectionSource = source;
    updateTableSelection();
    renderReadout();
    return;
  }
  const canvas = (event.target as HTMLElement).closest("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    if (focusedLane) {
      focusedLane = null;
      redrawCharts();
    }
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const shown = visibleForecasts();
  if (!shown.length) return;
  const nextTime = hourTimeAtX(
    event.clientX - rect.left,
    rect.width,
    sharedForecastTimeline(shown),
  );
  const scaledLane = forecastLaneAtY(
    event.clientY - rect.top,
    new Set(metrics),
    presentation === "compare" ? rect.height : undefined,
  );
  if (source === "touch" && !scaledLane) return;
  if (selectedTime === nextTime && focusedLane === scaledLane && selectionSource === source)
    return;
  selectedTime = nextTime;
  focusedLane = scaledLane;
  selectionSource = source;
  redrawCharts();
  renderReadout();
}

function onChartPointerMove(event: PointerEvent): void {
  if (event.pointerType === "mouse") {
    if (canHover()) updateChartSelection(event, "hover");
    return;
  }
  if (!touchChartGesture || touchChartGesture.pointerId !== event.pointerId) return;
  if (
    Math.hypot(
      event.clientX - touchChartGesture.startX,
      event.clientY - touchChartGesture.startY,
    ) > TOUCH_TAP_SLOP
  )
    touchChartGesture.moved = true;
}

function onChartPointerDown(event: PointerEvent): void {
  if (event.pointerType === "mouse" || presentation === "textual") return;
  if (!(event.target as HTMLElement).closest("canvas")) return;
  touchChartGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
}

function onChartPointerUp(event: PointerEvent): void {
  if (!touchChartGesture || touchChartGesture.pointerId !== event.pointerId) return;
  const gesture = touchChartGesture;
  touchChartGesture = null;
  if (gesture.moved) return;
  updateChartSelection(event, "touch");
}

function cancelTouchChartGesture(): void {
  touchChartGesture = null;
}

function onChartKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && selectionSource === "touch") {
    clearChartSelection();
    redrawCharts();
    renderReadout();
    event.preventDefault();
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const shown = visibleForecasts();
  if (!shown.length) return;
  const timeline = sharedForecastTimeline(shown);
  const step = event.key === "ArrowRight" ? 3_600_000 : -3_600_000;
  const initial =
    presentation === "textual" || presentation === "compare"
      ? Math.max(
          timeline.startMs,
          Math.min(
            timeline.endMs,
            Math.floor(Date.now() / FORECAST_HOUR_MS) * FORECAST_HOUR_MS,
          ),
        )
      : timeline.startMs;
  selectedTableModel = null;
  selectedTime = Math.max(
    timeline.startMs,
    Math.min(timeline.endMs, (selectedTime ?? initial) + step),
  );
  selectionSource = "keyboard";
  event.preventDefault();
  redrawCharts();
  renderReadout();
}

function onSearchInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value.trim();
  searchOpen = true;
  if (searchTimer) clearTimeout(searchTimer);
  searchAbort?.abort();
  searchResults = [];
  searching = value.length >= 2;
  renderSearchResults();
  if (value.length < 2) {
    return;
  }
  searchTimer = setTimeout(() => void runSearch(value), 320);
}

async function runSearch(query: string): Promise<void> {
  if (!store) store = await deps.ensureStore();
  const cached = await store.getGeocode(query);
  if (cached) {
    if (($("forecastSearch") as HTMLInputElement | null)?.value.trim() !== query) return;
    searchResults = cached;
    searching = false;
    renderSearchResults();
    return;
  }
  searchAbort = new AbortController();
  try {
    const results = await deps.provider.searchLocations(query, searchAbort.signal);
    if (($("forecastSearch") as HTMLInputElement | null)?.value.trim() !== query) return;
    searchResults = results;
    searching = false;
    await store.putGeocode(query, results);
    renderSearchResults();
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      searching = false;
      renderSearchResults();
      deps.toast("Location search failed.", true);
    }
  }
}

function renderSearchResults(): void {
  const host = $("forecastSearchResults");
  if (!host) return;
  if (!searchOpen) {
    host.classList.add("hidden");
    return;
  }
  const query = ($("forecastSearch") as HTMLInputElement | null)?.value.trim() ?? "";
  if (query.length >= 2) {
    host.innerHTML = searching
      ? `<div class="fc-search-message">Searching…</div>`
      : searchResults.length
        ? `<div class="fc-search-section"><b>Results</b>${searchResults
            .map(
              (result, index) =>
                `<button type="button" role="option" data-search-index="${index}"><span>${deps.esc(result.label)}</span></button>`,
            )
            .join("")}</div>`
        : `<div class="fc-search-message">No matching locations.</div>`;
  } else {
    const prefs = store?.prefs();
    const favorites = prefs?.favorites ?? [];
    const recent = (prefs?.recent ?? []).filter((item) => !store?.isFavorite(item));
    const placeButton = (item: ForecastPoint, recentPlace: boolean) =>
      `<button type="button" role="option" data-place="1" ${recentPlace ? 'data-recent="1"' : ""} ` +
      `data-lat="${item.lat}" data-lon="${item.lon}" data-place-id="${deps.esc(item.placeId ?? "")}" ` +
      `data-label="${deps.esc(item.label)}">` +
      `<span>${deps.esc(item.label)}</span><small>${recentPlace ? "Recent" : "Pinned ★"}</small></button>`;
    host.innerHTML =
      (favorites.length
        ? `<div class="fc-search-section"><b>Pinned</b>${favorites.map((item) => placeButton(item, false)).join("")}</div>`
        : "") +
        (recent.length
          ? `<div class="fc-search-section"><b>Recent</b>${recent.map((item) => placeButton(item, true)).join("")}</div>`
          : "") || `<div class="fc-search-message">Start typing a place or postcode.</div>`;
  }
  host.classList.remove("hidden");
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    locationPickerOpen = false;
    searchOpen = false;
    renderToolbar();
    renderSearchResults();
    $("forecastSearchToggle")?.focus();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    $("forecastSearchResults")?.querySelector<HTMLButtonElement>("button")?.focus();
  }
}

function onSearchResultsKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    locationPickerOpen = false;
    searchOpen = false;
    renderToolbar();
    renderSearchResults();
    $("forecastSearchToggle")?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [
    ...$("forecastSearchResults")!.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "ArrowDown" ? current + 1 : current - 1;
  event.preventDefault();
  if (next < 0) $("forecastSearch")?.focus();
  else buttons[Math.min(next, buttons.length - 1)]?.focus();
}

function pointFromButton(button: HTMLElement): ForecastPoint | null {
  const lat = Number(button.dataset.lat);
  const lon = Number(button.dataset.lon);
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? {
        ...rawPoint(lat, lon, button.dataset.label || undefined),
        ...(button.dataset.placeId ? { placeId: button.dataset.placeId } : {}),
      }
    : null;
}

function isGenericPointName(value: ForecastPoint): boolean {
  return (
    value.label === `${formatCoord(value.lat)}, ${formatCoord(value.lon)}` ||
    value.label === "My location"
  );
}

function beginRename(mode: "new" | "existing"): void {
  if (!point) return;
  renameMode = mode;
  renderToolbar();
  requestAnimationFrame(() => {
    const input = $("forecastRenameInput") as HTMLInputElement | null;
    if (!input || !point) return;
    input.value = mode === "new" && isGenericPointName(point) ? "" : point.label;
    input.focus();
    input.select();
  });
}

function cancelRename(): void {
  renameMode = null;
  renderToolbar();
  $("forecastPin")?.focus();
}

async function onRenameSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!point || !store || !renameMode) return;
  const input = $("forecastRenameInput") as HTMLInputElement | null;
  const label = input?.value.trim() ?? "";
  if (!label) {
    input?.focus();
    return;
  }
  const renamed = { ...point, label };
  if (renameMode === "new") {
    await store.toggleFavorite(renamed);
    await store.setPrefs({ lastPoint: renamed });
  } else {
    await store.renameFavorite(point, label);
  }
  point = renamed;
  renameMode = null;
  renderAll();
  $("forecastRename")?.focus();
}

function saveCompareTrackVisibility(): void {
  void store?.setPrefs({ hiddenCompareModels: [...hiddenCompareModels] });
  renderDisplayOptions();
  renderCharts();
}

function toggleCompareTrack(modelId: string): void {
  if (hiddenCompareModels.has(modelId)) hiddenCompareModels.delete(modelId);
  else hiddenCompareModels.add(modelId);
  hoveredCompareModel = null;
  saveCompareTrackVisibility();
}

function onCompareLegendOver(event: PointerEvent): void {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-compare-model]",
  );
  if (!button?.dataset.compareModel || hiddenCompareModels.has(button.dataset.compareModel))
    return;
  if (hoveredCompareModel === button.dataset.compareModel) return;
  hoveredCompareModel = button.dataset.compareModel;
  button.classList.add("focused");
  redrawCharts();
}

function onCompareLegendOut(event: PointerEvent): void {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-compare-model]",
  );
  if (!button || button.contains(event.relatedTarget as Node | null)) return;
  button.classList.remove("focused");
  if (hoveredCompareModel !== button.dataset.compareModel) return;
  hoveredCompareModel = null;
  redrawCharts();
}

function onCompareLegendDoubleClick(event: MouseEvent): void {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-compare-model]",
  );
  const modelId = button?.dataset.compareModel;
  if (!modelId) return;
  event.preventDefault();
  if (compareTrackClickTimer) clearTimeout(compareTrackClickTimer);
  compareTrackClickTimer = null;
  hiddenCompareModels = new Set(
    visibleForecasts().flatMap((item) => (item.modelId === modelId ? [] : [item.modelId])),
  );
  hoveredCompareModel = modelId;
  saveCompareTrackVisibility();
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const tableCell = target.closest<HTMLElement>("[data-time]");
  if (presentation === "textual" && tableCell?.dataset.time) {
    selectedTime = Number(tableCell.dataset.time);
    selectedTableModel = null;
    focusedLane = null;
    selectionSource = "touch";
    updateTableSelection();
    renderReadout();
    return;
  }
  const button = target.closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.dataset.tableModel) {
    selectedTableModel =
      selectedTableModel === button.dataset.tableModel ? null : button.dataset.tableModel;
    document.querySelectorAll<HTMLButtonElement>("[data-table-model]").forEach((item) => {
      const selected = item.dataset.tableModel === selectedTableModel;
      const model = modelFor(item.dataset.tableModel!);
      item.setAttribute("aria-pressed", String(selected));
      item.setAttribute(
        "aria-label",
        `${selected ? "Hide" : "Show"} details for ${model.provider} ${model.label}`,
      );
    });
    renderReadout();
    return;
  }
  if (button.id === "forecastSettingsOpen") {
    setForecastSettingsOpen(true);
    return;
  }
  if (button.id === "forecastSettingsClose") {
    setForecastSettingsOpen(false);
    return;
  }
  if (button.dataset.days) {
    days = Number(button.dataset.days) as typeof days;
    clearChartSelection();
    void store?.setPrefs({ days });
    void refreshForecast(false);
    return;
  }
  if (button.dataset.speedUnit) {
    speedUnit = button.dataset.speedUnit as ForecastSpeedUnit;
    void store?.setPrefs({ speedUnit });
    renderAll();
    return;
  }
  if (button.dataset.presentation) {
    presentation = button.dataset.presentation as ForecastPresentation;
    clearChartSelection();
    hoveredCompareModel = null;
    void store?.setPrefs({ presentation });
    renderAll();
    return;
  }
  if (button.dataset.tableMetric) {
    tableMetric = button.dataset.tableMetric as ForecastMetric;
    void store?.setPrefs({ tableMetric });
    renderDisplayOptions();
    renderCharts();
    return;
  }
  if (button.id === "forecastRefresh") return void refreshForecast(true);
  if (button.dataset.detailStep === "-1" || button.dataset.detailStep === "1") {
    stepCompareDetailHour(Number(button.dataset.detailStep) as -1 | 1);
    return;
  }
  if (button.id === "forecastCompareDetailClose") {
    clearChartSelection();
    redrawCharts();
    renderReadout();
    $("forecastCharts")?.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.modelGroup) {
    const allIds = deps.provider.models.map((model) => model.id);
    const groupIds = deps.provider.models
      .filter((model) => model.provider === button.dataset.modelGroup)
      .map((model) => model.id);
    selectedModels = toggleModelGroupSelection(allIds, groupIds, candidateIds());
    void store?.setPrefs({ selectedModels });
    renderModelPicker();
    void refreshForecast(false);
    return;
  }
  if (button.id === "forecastSearchToggle") {
    locationPickerOpen = !locationPickerOpen;
    searchOpen = locationPickerOpen;
    renderToolbar();
    renderSearchResults();
    if (locationPickerOpen) requestAnimationFrame(() => $("forecastSearch")?.focus());
    return;
  }
  if (button.id === "forecastSearchClose") {
    locationPickerOpen = false;
    searchOpen = false;
    renderToolbar();
    renderSearchResults();
    $("forecastSearchToggle")?.focus();
    return;
  }
  if (button.id === "forecastModelsRecommended") {
    selectedModels = null;
    void store?.setPrefs({ selectedModels });
    renderModelPicker();
    void refreshForecast(false);
    return;
  }
  if (button.id === "forecastModelsReset") {
    selectedModels = deps.provider.models.map((model) => model.id);
    void store?.setPrefs({ selectedModels });
    renderModelPicker();
    void refreshForecast(false);
    return;
  }
  if (button.id === "forecastModelsClear") {
    selectedModels = [];
    void store?.setPrefs({ selectedModels });
    renderModelPicker();
    void refreshForecast(false);
    return;
  }
  if (button.dataset.compareStyle) {
    compareStyle = button.dataset.compareStyle as ForecastCompareStyle;
    hoveredCompareModel = null;
    void store?.setPrefs({ compareStyle });
    renderDisplayOptions();
    redrawCharts();
    renderReadout();
    return;
  }
  if (button.dataset.compareModel) {
    const modelId = button.dataset.compareModel;
    if (compareTrackClickTimer) clearTimeout(compareTrackClickTimer);
    compareTrackClickTimer = setTimeout(() => {
      compareTrackClickTimer = null;
      toggleCompareTrack(modelId);
    }, 320);
    return;
  }
  if (button.id === "forecastCompareShowAll") {
    hiddenCompareModels.clear();
    hoveredCompareModel = null;
    saveCompareTrackVisibility();
    return;
  }
  if (button.id === "forecastRename") {
    beginRename("existing");
    return;
  }
  if (button.id === "forecastRenameCancel") {
    cancelRename();
    return;
  }
  if (button.id === "forecastPin" && point && store) {
    if (!store.isFavorite(point) && isGenericPointName(point)) {
      beginRename("new");
      return;
    }
    renameMode = null;
    void store.toggleFavorite(point).then(() => renderAll());
    return;
  }
  if (button.id === "forecastLocate") {
    if (locating) return;
    if (!("geolocation" in navigator)) {
      deps.toast("This browser can't share your location.", true);
      return;
    }
    const token = ++locateToken;
    locationPickerOpen = false;
    searchOpen = false;
    locating = true;
    renderToolbar();
    renderSearchResults();
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (token !== locateToken) return;
        locating = false;
        renderToolbar();
        void choosePoint(
          rawPoint(position.coords.latitude, position.coords.longitude, "My location"),
          true,
          false,
        );
      },
      () => {
        if (token !== locateToken) return;
        locating = false;
        renderToolbar();
        deps.toast("Could not get your location.", true);
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
    return;
  }
  if (button.dataset.searchIndex) {
    const result = searchResults[Number(button.dataset.searchIndex)];
    if (result) {
      searchResults = [];
      locationPickerOpen = false;
      searchOpen = false;
      renderSearchResults();
      void choosePoint(result, true, true);
    }
    return;
  }
  if (button.dataset.place) {
    const next = pointFromButton(button);
    if (next) {
      locationPickerOpen = false;
      searchOpen = false;
      renderSearchResults();
      void choosePoint(next, true, !!button.dataset.recent);
    }
  }
}

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.dataset.forecastMetric) {
    metrics = [
      ...document.querySelectorAll<HTMLInputElement>(
        "#forecastMetricList input[data-forecast-metric]:checked",
      ),
    ].map((item) => item.dataset.forecastMetric as ForecastMetric);
    const tableOptions = tableMetricOptions();
    if (!tableOptions.includes(tableMetric) && tableOptions[0]) tableMetric = tableOptions[0];
    clearChartSelection();
    void store?.setPrefs({ metrics, tableMetric });
    renderAll();
    return;
  }
  if (!input.dataset.model) return;
  const checked = [
    ...document.querySelectorAll<HTMLInputElement>(
      "#forecastModelsList input[data-model]:checked",
    ),
  ].map((item) => item.dataset.model!);
  selectedModels = checked;
  void store?.setPrefs({ selectedModels });
  renderModelPicker();
  void refreshForecast(false);
}
