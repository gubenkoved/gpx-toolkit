/**
 * UI entry point — ported from the Python app's `web/index.html` inline script.
 *
 * The render functions and DOM event handling are kept faithful to the original
 * SPA (same `STATE = { rides, jobs }` model, same markup). The only change is the
 * data layer: instead of `fetch('/api/…')` + 1.5s polling, the UI talks to an
 * in-browser `Controller` and re-renders on its change events.
 */

import "leaflet/dist/leaflet.css";
import "./style.css";

import L from "leaflet";

import { type AreaSelect, createAreaSelect } from "./areaselect";
import { type AppState, Controller, type RideView } from "./controller";
import {
  emptyFilters,
  type Filters,
  filterActiveCount,
  filtersActive,
  type TriState,
  visibleRides,
} from "./filter";
import { BASE_SPACING_M, buildHeatPoints, type HeatBounds, spacingForZoom } from "./heatmap";
import {
  type DateRange,
  dateRange,
  filterRidesByRange,
  type RideTrack,
  ridesWithTracks,
} from "./mapview";
import {
  autoGranularity,
  bucketRide,
  compareRideKeysDesc,
  type Granularity,
  rideDatetime,
  rideShortLabel,
  trimmedSpeed,
} from "./parsing";
import { computeStats, type PeriodRecord } from "./stats";
import "leaflet.heat";
import { DEMO_BEELINE_EMAIL, demoBeelineDeps } from "./beeline-demo";
import { BeelineRideSource, type BeelineSourceDeps } from "./beeline-source";
import { idbBackend, memoryBackend } from "./kv";
import type { SourceFactory } from "./source";
import { Store } from "./store";
import {
  cumulativeKm,
  decodePolyline,
  type FullTrack,
  fullTrackSpeedsKmh,
  fullTrackSummary,
  hasElevation,
  hasTimes,
  movingAverage,
} from "./track";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

// --------------------------------------------------------------------------- //
// Controller wiring (Beeline cloud account, with an account-free demo)
// --------------------------------------------------------------------------- //

/** Durable ride-cache storage. One IndexedDB connection shared by every controller. */
const storageBackend = idbBackend();
/** Surface a background-write failure (e.g. quota exceeded) to the user. */
const onStorageError = (message: string): void => pushError("Storage error", message);

let controller!: Controller;
// Starts false so the first paint matches the offline boot; activate() sets the
// real value once a controller is wired up.
let isDemo = false;
// Which data source is active. Drives the streamlined Beeline chrome (via the
// body[data-src] attribute) and the "Source" switcher. "offline" = no source yet.
let currentSource: SourceKind = "offline";
let unsubscribe: (() => void) | null = null;
let unsubscribeGpx: (() => void) | null = null;

type SourceKind = "beeline" | "offline";

/** True when the active source is a Beeline account (real or demo). */
const beelineMode = (): boolean => currentSource === "beeline";

/** IndexedDB key for the Beeline account profile. */
const BEELINE_STORAGE_KEY = "beeline-toolkit-state:beeline";

const FILTERS_KEY = "beeline_uploader.filters";

// Which data source the user last chose. Demo/offline aren't persisted. Beeline
// can't auto-sign-in (we never store the password), so a remembered Beeline
// profile just re-opens the picker with the email prefilled.
const PROFILE_KEY = "beeline_uploader.profile";
const BEELINE_EMAIL_KEY = "beeline_uploader.beeline_email";
const rememberProfile = (profile: "beeline", email = ""): void => {
  try {
    localStorage.setItem(PROFILE_KEY, profile);
    if (profile === "beeline" && email) localStorage.setItem(BEELINE_EMAIL_KEY, email);
  } catch {
    /* non-fatal */
  }
};
const forgetProfile = (): void => {
  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* non-fatal */
  }
};
const rememberedProfile = (): string | null => {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
};
const rememberedEmail = (): string => {
  try {
    return localStorage.getItem(BEELINE_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
};

// One-time consent for routing the full-GPX download through the external export
// gateway (see infra/gpx-relay). Only relevant when a relay URL is configured at
// build time; remembered per device so we don't re-prompt every download.
const GPX_RELAY_CONSENT_KEY = "beeline_uploader.gpx_relay_consent";
const relayConsentGiven = (): boolean => {
  try {
    return localStorage.getItem(GPX_RELAY_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
};
const rememberRelayConsent = (): void => {
  try {
    localStorage.setItem(GPX_RELAY_CONSENT_KEY, "1");
  } catch {
    /* non-fatal */
  }
};

function activate(next: Controller, demo: boolean, source: SourceKind): void {
  if (unsubscribe) unsubscribe();
  if (unsubscribeGpx) unsubscribeGpx();
  controller = next;
  isDemo = demo;
  currentSource = source;
  document.body.dataset.src = source;
  placeScanButton(source === "beeline");
  unsubscribe = controller.onChange(applyState);
  unsubscribeGpx = controller.onGpx(saveGpxFile);
  applyState();
}

/**
 * In Beeline mode the scan bar's only live control is "Re-sync", so giving it a
 * whole second header row is wasteful — hoist Re-sync up into the header's
 * connection cluster and let the body[data-src="beeline"] CSS drop the now-empty
 * bar. Any other source puts it back in the scan bar in its original slot (just
 * before the trailing spacer).
 */
function placeScanButton(beeline: boolean): void {
  const btn = document.getElementById("btnScan");
  if (!btn) return;
  if (beeline) {
    document.querySelector(".conn")?.prepend(btn);
  } else {
    const bar = document.getElementById("scanbar");
    const spacer = bar?.querySelector(".spacer");
    if (bar && spacer) bar.insertBefore(btn, spacer);
  }
}

// -- source picker ----------------------------------------------------------

// A cloud action deferred until the user (re)authenticates to Beeline. Set when a
// signed-out Beeline session triggers something needing the account (Re-sync,
// upload); run once sign-in succeeds, then cleared.
let afterBeelineSignIn: (() => void) | null = null;

/**
 * Show the data-source picker, prefilling the remembered Beeline email if any.
 * In `reauth` mode it presents ONLY the Beeline sign-in (the user already has a
 * profile and just needs to re-enter the password — which a password manager can
 * inject), with focused copy and the password field focused.
 */
function showPicker(opts: { reauth?: boolean } = {}): void {
  const picker = document.getElementById("srcPick");
  if (!picker) return;
  const reauth = opts.reauth === true;
  picker.classList.toggle("reauth", reauth);

  const email = rememberedEmail();
  const emailInput = document.getElementById("beelineEmail") as HTMLInputElement | null;
  if (email && emailInput && !emailInput.value) emailInput.value = email;

  const sub = picker.querySelector(".srcpick-sub");
  if (sub) {
    sub.textContent = reauth
      ? "Sign in to your Beeline account to sync."
      : "Choose where your rides come from.";
  }

  setBeelineError("");
  picker.classList.remove("hidden");
  if (reauth) {
    const pass = document.getElementById("beelinePass") as HTMLInputElement | null;
    pass?.focus();
  }
}

function hidePicker(): void {
  const picker = document.getElementById("srcPick");
  picker?.classList.add("hidden");
  picker?.classList.remove("reauth");
  // Dismissing the prompt abandons any action that was waiting on sign-in.
  afterBeelineSignIn = null;
}

function setBeelineError(message: string): void {
  const el = document.getElementById("beelineErr");
  if (el) el.textContent = message;
}

/**
 * Run a cloud action that needs a live Beeline connection. When the Beeline
 * account is the active source but we're signed out (the offline, cached-rides
 * state — we never store the password), defer the action and prompt for the
 * password so a password manager can inject it; the action runs once sign-in
 * succeeds. In every other case (connected, demo, or a non-Beeline source) it
 * runs immediately.
 */
function withBeelineAccess(action: () => void): void {
  if (beelineMode() && !STATE.connected && !isDemo) {
    afterBeelineSignIn = action;
    showPicker({ reauth: true });
    return;
  }
  action();
}

/**
 * Gate a full-track GPX action behind one-time consent when an export gateway is
 * configured at build time. The full recorded track can't be fetched directly in
 * the browser (a CORS limit on Beeline's storage redirect), so a deployment routes
 * it through a small external gateway; we explain that once and remember the choice
 * per device. With no gateway configured (dev / direct builds) or once consent is
 * stored, the action runs straight away.
 */
function withGpxRelayConsent(action: () => void): void {
  if (!__GPX_RELAY_URL__ || relayConsentGiven()) {
    action();
    return;
  }
  void consentDialog({
    title: "Fetch the full track via the export gateway?",
    body:
      "The full recorded track (real per-point timestamps and elevation) can't be " +
      "downloaded directly in the browser — Beeline's storage redirect drops the CORS " +
      "header the browser needs. With your go-ahead, this download is routed through " +
      "the app's small export gateway, which fetches the file server-side and hands it " +
      "back.\n\n" +
      "Sent to the gateway: your current Beeline sign-in token and the ride id. " +
      "Never sent or stored: your password. The gateway keeps nothing — it just relays " +
      "the file.\n\n" +
      "If the gateway is ever unreachable, the app falls back to a route-only GPX " +
      "(no real time or elevation).",
    confirmLabel: "Use the gateway",
    checkLabel: "Don't ask again on this device",
    checked: true,
  }).then(({ ok, dontAsk }) => {
    if (!ok) return;
    if (dontAsk) rememberRelayConsent();
    action();
  });
}

/** Build a ride source from a device getter (closure captures serial, etc.). */
function beelineSourceFactory(
  email: string,
  password: string,
  store: Store,
  deps?: BeelineSourceDeps,
): SourceFactory {
  return () =>
    BeelineRideSource.create(
      email,
      password,
      () => store.settings.beelineUploadConcurrency,
      deps,
    );
}

/**
 * Beeline demo: a simulated cloud account exercising the Beeline mechanics —
 * one-shot history download and server-side Strava uploads observed by polling.
 */
async function goDemoBeeline(): Promise<void> {
  const store = new Store(memoryBackend());
  const factory = beelineSourceFactory(DEMO_BEELINE_EMAIL, "demo", store, demoBeelineDeps());
  const c = new Controller(factory, store);
  activate(c, true, "beeline");
  try {
    await c.connect();
    toast("Demo (Beeline) — a simulated cloud account. Click Change source to leave.");
  } catch {
    /* demo connect never fails */
  }
}

/**
 * Sign in to a real Beeline account and download the whole ride history. The
 * password is used once for sign-in and never stored; only the email is remembered
 * (to prefill the picker next time).
 *
 * Autonomy: we `activate` the controller (showing whatever Beeline rides are
 * already cached) BEFORE attempting sign-in, so a failure to reach the account
 * leaves the app fully usable on the last downloaded data instead of blank.
 */
async function goBeeline(email: string, password: string): Promise<boolean> {
  const store = await Store.load(storageBackend, onStorageError, BEELINE_STORAGE_KEY);
  const c = new Controller(beelineSourceFactory(email, password, store), store);
  activate(c, false, "beeline"); // show cached rides immediately
  try {
    await c.connect(); // signs in; throws on bad credentials / no network
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBeelineError(msg);
    // Remember the profile so a reload returns here, and surface a clear,
    // dismissable error — but keep the cached rides on screen (autonomy).
    rememberProfile("beeline", email);
    pushError(
      "Can't reach your Beeline account",
      `${msg}\n\nShowing your last downloaded rides. Use “Change source” to sign in again and re-sync once you're back online.`,
    );
    return false;
  }
  rememberProfile("beeline", email);
  // Capture any action that was waiting on sign-in BEFORE hidePicker() clears it.
  const pending = afterBeelineSignIn;
  hidePicker();
  toast(`Signed in: ${controller.state().device}`);
  if (pending) {
    // The user triggered sign-in by doing something (Re-sync, upload) — run it now
    // against the freshly connected controller instead of a blanket re-sync.
    pending();
  } else {
    // A plain sign-in (from the full picker): pull the history so the user lands
    // on a populated app.
    controller.scan("all", null);
  }
  return true;
}

/**
 * Beeline, offline: show the cached Beeline rides without an account connection
 * (e.g. on reload — we never store the password, so we can't silently re-sign-in).
 * The source is a stub that errors if used; any action needing the account
 * (Re-sync, upload) prompts for the password first via `withBeelineAccess`.
 */
async function goBeelineOffline(): Promise<void> {
  const store = await Store.load(storageBackend, onStorageError, BEELINE_STORAGE_KEY);
  const factory: SourceFactory = async () => {
    throw new Error("Not signed in — sign in to Beeline to sync.");
  };
  const c = new Controller(factory, store);
  activate(c, false, "beeline");
}

// --------------------------------------------------------------------------- //
// UI state
// --------------------------------------------------------------------------- //
let STATE: AppState = {
  rides: [],
  jobs: {
    current: null,
    current_keys: [],
    queue: [],
    history: [],
    active_keys: [],
    busy: false,
  },
  settings: {
    trackPointsPerKm: 20,
    speedTrimSlowPct: 0,
    speedTrimFastPct: 0,
    heatRadius: 12,
    beelineUploadConcurrency: 4,
  },
  connected: false,
  device: "",
};
let ACTIVE = new Set<string>(); // keys queued or running
let RUNNING = new Set<string>(); // keys in the currently running task
const selected = new Set<string>();
const openMonths = new Set<string>();
const openYears = new Set<string>();
const openStats = new Set<string>();

// -- Explore list filters -------------------------------------------------
// Live, AND-combined filters applied to the cached rides before grouping. They
// never touch the source — just narrow what the Explore list shows. Kept at module
// scope (like `selected`/`openStats`) so they survive the frequent re-renders the
// job ticker triggers; folded into `stateSig()` so a change re-renders the list.
// The predicates themselves live in ./filter (pure + unit-tested).
// Persisted across reloads (like the chosen view/mode) so a user's narrowing
// survives a refresh; loadFilters sanitizes every field so stale/garbage storage
// can never corrupt the bar.
const STATUS_VALUES: ReadonlyArray<Filters["status"]> = [
  "all",
  "uploaded",
  "processing",
  "not-uploaded",
];
const TRI_VALUES: ReadonlyArray<TriState> = ["any", "yes", "no"];
const DELETED_VALUES: ReadonlyArray<Filters["deleted"]> = ["any", "only", "none"];

/** A finite, non-negative number or null (for the distance bounds). */
function sanitizeBound(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Load the persisted filters, sanitizing every field against its allowed values
 * so old or malformed storage falls back to neutral rather than corrupting the
 * bar. The device string passes through — syncFilterBar already resets it to
 * "all" if that device is no longer present in the cache.
 */
function loadFilters(): Filters {
  const f = emptyFilters();
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return f;
    const o = JSON.parse(raw) as Partial<Filters>;
    if (STATUS_VALUES.includes(o.status as Filters["status"])) f.status = o.status!;
    if (TRI_VALUES.includes(o.gps as TriState)) f.gps = o.gps!;
    if (TRI_VALUES.includes(o.details as TriState)) f.details = o.details!;
    if (TRI_VALUES.includes(o.destination as TriState)) f.destination = o.destination!;
    if (TRI_VALUES.includes(o.named as TriState)) f.named = o.named!;
    if (DELETED_VALUES.includes(o.deleted as Filters["deleted"])) f.deleted = o.deleted!;
    if (typeof o.device === "string") f.device = o.device;
    f.distMin = sanitizeBound(o.distMin);
    f.distMax = sanitizeBound(o.distMax);
  } catch {
    /* malformed JSON / storage disabled — fall back to neutral */
  }
  return f;
}

/** Persist the current filters (non-fatal if storage is unavailable). */
function saveFilters(): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
}

const filters: Filters = loadFilters();
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
// Persistent error stack. Every error — failed jobs AND standalone connection/
// import/storage errors — is shown as its own card and only disappears when the
// user dismisses it (or, for a job, when that job is re-run and succeeds). We track
// dismissed/already-flashed ids by string so the two error sources share one model.
const dismissedErrIds = new Set<string>();
const shownErrIds = new Set<string>();
interface PushedError {
  id: string;
  title: string;
  full: string;
  ts: number;
}
const pushedErrors: PushedError[] = [];
let errSeq = 0;
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
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

// OSM's tile usage policy requires a visible "© OpenStreetMap contributors"
// credit wherever the tiles are shown. One canonical string, reused by every
// tile layer. The big interactive maps render it as a compact Leaflet control
// (with setPrefix(false) to drop the "Leaflet" flag); the per-ride mini-maps
// omit the control entirely and rely on the page-level header credit instead, so
// the badge doesn't repeat on every little card.
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

const mapRegistry = new Map<string, L.Map>();

/** Markup for a ride's mini-map + its caption. */
function trackBlock(key: string, track: string): string {
  // Beeline rides carry the FULL route polyline from the download, so there's no
  // GPX to fetch and no "rough approximation" caveat — the map is the real track.
  const beeline = beelineMode();
  if (!track) {
    if (beeline) {
      return `<div class="rmaphint">No route recorded for this ride.</div>`;
    }
    // Details are open but we have no route yet — point the user at the GPX button.
    return `<div class="rmaphint">No map yet — press <b>GPX</b> to download this ride and draw a rough route.</div>`;
  }
  return (
    `<div class="rmapwrap">` +
    `<div class="rmap" data-map="${esc(key)}" data-track="${esc(key)}"></div>` +
    `<button class="map-expand rmap-expand" data-expand="${escHtml(key)}" aria-label="Expand route" title="Open this route full-screen (Esc to exit)">` +
    `<svg class="mi mi-expand" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
    `</button>` +
    `</div>` +
    (beeline ? "" : `<div class="rmapnote">Rough approximation only — not the full GPX.</div>`)
  );
}

/**
 * Expanded-details body for an open ride. A ride with no stats has none recorded
 * yet — almost always because it's still in progress (the device hasn't finished
 * and synced the ride), so instead of an empty grid we say so.
 */
function detailsBlock(r: RideView): string {
  const hasStats =
    r.avg_speed_kmh != null ||
    r.max_speed_kmh != null ||
    r.moving_sec != null ||
    r.elevation_gain_m != null ||
    r.elevation_loss_m != null ||
    r.distance_km != null;
  if (!hasStats) {
    const checking = RUNNING.has(r.key) || ACTIVE.has(r.key);
    const msg = checking
      ? `Loading this ride's stats and route…`
      : `No stats for this ride yet — it may still be in progress. Stats and route appear once the ride finishes and syncs (re-sync to refresh).`;
    return `<div class="rdetailhint">${msg}</div>`;
  }
  return (
    `<div class="stats open" id="st-${esc(r.key)}">${fmtStats(r)}</div>` +
    trackBlock(r.key, r.track)
  );
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
    if (
      mapRegistry.has(host.dataset.map!) &&
      mapRegistry.get(host.dataset.map!)!.getContainer() === host
    ) {
      return; // already mounted on this exact node
    }
    const ride = STATE.rides.find((r) => esc(r.key) === host.dataset.map);
    if (!ride?.track) return;
    let pts: [number, number][];
    try {
      pts = decodePolyline(ride.track);
    } catch {
      return;
    }
    if (pts.length < 2) return;
    const map = L.map(host, {
      // Mini-maps drop the per-map credit (the header carries the page-level one)
      // so the badge doesn't repeat on every ride card.
      attributionControl: false,
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
let rideMapMarker: L.CircleMarker | null = null;
/** The ride key currently open in the full-screen map (null when closed). */
let rideMapKey: string | null = null;
/** How the route line is coloured: plain, by elevation, or by speed. */
let rideMapColorMode: "none" | "height" | "speed" = "none";
/** Whether the elevation profile panel is shown (when a full track is loaded). */
let rideMapProfileShown = true;
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
}

/** Render the elevation-vs-distance profile below the map from the full track. */
function renderRideProfile(): void {
  const host = document.getElementById("rideMapProfile");
  if (!host) return;
  const full = rideHover?.full ?? null;
  if (!rideMapProfileShown || !full || !hasElevation(full)) {
    host.classList.add("hidden");
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = "";
    return;
  }
  host.classList.remove("hidden");
  host.setAttribute("aria-hidden", "false");

  const cum = rideHover!.cum;
  const eles = full.eles;
  const range = finiteRange(eles);
  if (!range) {
    host.innerHTML = `<div class="rp-empty">No elevation data in this track.</div>`;
    return;
  }
  const W = 1000;
  const H = 120;
  const padX = 4;
  const padTop = 8;
  const padBot = 18;
  const totalKm = rideHover!.totalKm || 1;
  const eSpan = range.hi - range.lo || 1;
  const xOf = (km: number) => padX + (km / totalKm) * (W - 2 * padX);
  const yOf = (e: number) => padTop + (1 - (e - range.lo) / eSpan) * (H - padTop - padBot);

  // Build the area + line path over points that carry an elevation.
  let line = "";
  let firstX = padX;
  let lastX = padX;
  let started = false;
  for (let i = 0; i < eles.length; i++) {
    const e = eles[i];
    if (e == null) continue;
    const x = xOf(cum[i]);
    const y = yOf(e);
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
  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
    `aria-label="Elevation profile">` +
    `<path class="rp-area" d="${area}"/>` +
    `<path class="rp-line" d="${line}"/>` +
    `<line class="rp-cursor" id="rpCursor" x1="0" y1="${padTop}" x2="0" y2="${baseY}" style="display:none"/>` +
    `<text class="rp-axis" x="${padX}" y="12">${Math.round(range.hi)} m</text>` +
    `<text class="rp-axis" x="${padX}" y="${H - 5}">${Math.round(range.lo)} m</text>` +
    `</svg>`;
}

/** Move the elevation-profile cursor to a given along-track distance (km). */
function moveProfileCursor(km: number | null): void {
  const cursor = document.getElementById("rpCursor");
  if (!cursor || !rideHover) return;
  if (km == null) {
    cursor.style.display = "none";
    return;
  }
  const W = 1000;
  const padX = 4;
  const x = padX + (km / (rideHover.totalKm || 1)) * (W - 2 * padX);
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
  const s = fullTrackSummary(full);
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
  host.innerHTML = chips.join("");
  host.classList.remove("hidden");
}

/** Handle a hover over the big ride map: find the nearest point along the track,
 *  move the marker there, and report distance + time into the ride. With a full
 *  track loaded the time/elevation are REAL (read from the nearest recorded point);
 *  otherwise the time is an even-pace estimate (rendered with a "~"). */
function onRideMapHover(e: L.LeafletMouseEvent): void {
  const out = document.getElementById("rideMapHover");
  if (!rideMapBig || !rideHover || !out) return;
  const cur = e.containerPoint;
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
  if (best > 28 || !bestLatLng) {
    clearRideTrackPoint();
    return;
  }
  showRideTrackPoint(bestLatLng, bestIdx, bestKm);
}

/** Clear the hover marker, readout and profile cursor (pointer left the track). */
function clearRideTrackPoint(): void {
  const out = document.getElementById("rideMapHover");
  if (out) out.textContent = "";
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
  if (out) out.textContent = parts.join(" · ");
  moveProfileCursor(km);
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
  // The profile path maps padX..(W-padX) viewBox units to 0..totalKm, so convert
  // the cursor's fractional X through the same padding to line up with the line.
  const W = 1000;
  const padX = 4;
  const xView = ((e.clientX - rect.left) / rect.width) * W;
  const frac = Math.max(0, Math.min(1, (xView - padX) / (W - 2 * padX)));
  const km = frac * rideHover.totalKm;
  const at = trackPointAtKm(km);
  if (at) showRideTrackPoint(at.latLng, at.idx, km);
}

/** Show/hide the full-track controls in the bar to match the loaded state. */
function syncRideMapControls(): void {
  const ride = rideMapKey ? STATE.rides.find((r) => r.key === rideMapKey) : null;
  const full = rideMapKey ? controller.getFullTrack(rideMapKey) : null;
  const fetchBtn = document.getElementById("btnRideMapFull") as HTMLButtonElement | null;
  const colorSeg = document.getElementById("rideMapColor");
  const profileBtn = document.getElementById("btnRideMapProfile") as HTMLButtonElement | null;
  const est = document.getElementById("rideMapEst");
  const hasTime = (ride?.elapsed_sec || ride?.moving_sec || 0) > 0;

  if (full) {
    fetchBtn?.classList.add("hidden");
    colorSeg?.classList.remove("hidden");
    // The elevation profile + its toggle only make sense with real elevation.
    const showProfileBtn = hasElevation(full);
    profileBtn?.classList.toggle("hidden", !showProfileBtn);
    est?.classList.add("hidden"); // real time now — no estimate disclaimer
    setRideMapStatus(""); // loaded — clear any prior fetching/error note
    // Reflect the colour-mode selection.
    colorSeg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === rideMapColorMode);
    });
    if (profileBtn) {
      const shown = rideMapProfileShown && showProfileBtn;
      profileBtn.textContent = shown ? "Hide profile" : "Show profile";
      profileBtn.setAttribute("aria-pressed", String(shown));
    }
  } else {
    if (fetchBtn) {
      fetchBtn.classList.remove("hidden");
      fetchBtn.disabled = false;
      fetchBtn.textContent = "Fetch full track";
    }
    colorSeg?.classList.add("hidden");
    profileBtn?.classList.add("hidden");
    est?.classList.toggle("hidden", !hasTime);
  }
}

/** Build the hover/line/profile state for the open ride from its display track and
 *  (when available) the in-memory full recorded track, then draw everything. */
function buildRideMapState(): void {
  const key = rideMapKey;
  if (!rideMapBig || !key) return;
  const ride = STATE.rides.find((r) => r.key === key);
  if (!ride) return;
  const full = controller.getFullTrack(key);
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
  const speeds = full && hasTimes(full) ? movingAverage(fullTrackSpeedsKmh(full), 3) : null;
  rideHover = {
    pts,
    cum,
    totalKm: cum[cum.length - 1],
    elapsedSec: ride.elapsed_sec || ride.moving_sec || 0,
    startMs: rideDatetime(ride.key)?.getTime() ?? null,
    px: [],
    full: full && full.points.length >= 2 ? full : null,
    speeds,
  };
  rideMapMarker = null;
  drawRideLine();
  renderRideProfile();
  renderRideSummary();
  syncRideMapControls();
  setTimeout(() => {
    rideMapBig?.invalidateSize();
    reprojectRideHover();
  }, 0);
}

/** Open the full-screen route map for one ride. */
function openRideMap(key: string): void {
  const ride = STATE.rides.find((r) => r.key === key);
  if (!ride?.track && !controller.getFullTrack(key)) return;

  const modal = document.getElementById("rideMapModal");
  const host = document.getElementById("rideMapBig");
  if (!modal || !host) return;

  rideMapKey = key;
  rideMapColorMode = "none";
  setRideMapStatus("");

  // Title: the ride's name + location, then its short date.
  const name = (ride?.title || "Ride") + (ride?.location || "");
  const when = rideShortLabel(key) || key;
  const titleEl = document.getElementById("rideMapTitle");
  if (titleEl) titleEl.textContent = `${name} · ${when}`;
  const hoverEl = document.getElementById("rideMapHover");
  if (hoverEl) hoverEl.textContent = "";

  modal.classList.remove("hidden");
  document.body.classList.add("ridemap-open");

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
    attribution: OSM_ATTRIBUTION,
    className: "rmap-tiles",
  }).addTo(map);

  buildRideMapState();
  if (rideHover) {
    map.fitBounds(L.latLngBounds(rideHover.pts), { padding: [24, 24] });
  }

  map.on("move zoom resize zoomend moveend", reprojectRideHover);
  map.on("mousemove", onRideMapHover);
  map.on("mouseout", clearRideTrackPoint);
}

/** Fetch the open ride's full recorded track, then upgrade the map in place. On
 *  failure the error is shown BOTH inline in the map bar (so it's visible in the
 *  full-screen view, where the bottom toast is easy to miss) and as a toast, and
 *  the button is re-enabled so the user can retry. */
function fetchRideMapFull(): void {
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
        fetchBtn.textContent = "Fetching…";
      }
      setRideMapStatus("Downloading the full recorded track…", "info");
      controller
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
              fetchBtn.textContent = "Retry full track";
            }
          }
          toast(`Couldn't fetch the full track: ${msg}`, true);
        });
    }),
  );
}

/** Switch the route-colouring mode (plain / by elevation / by speed). */
function setRideMapColor(mode: "none" | "height" | "speed"): void {
  rideMapColorMode = mode;
  drawRideLine();
  syncRideMapControls();
}

/** Toggle the elevation profile panel, re-measuring the map afterwards. */
function toggleRideMapProfile(): void {
  rideMapProfileShown = !rideMapProfileShown;
  renderRideProfile();
  syncRideMapControls();
  setTimeout(() => {
    rideMapBig?.invalidateSize();
    reprojectRideHover();
  }, 0);
}

/** Close the full-screen route map and release its Leaflet instance. */
function closeRideMap(): void {
  const modal = document.getElementById("rideMapModal");
  modal?.classList.add("hidden");
  document.body.classList.remove("ridemap-open");
  if (rideMapBig) {
    rideMapBig.remove();
    rideMapBig = null;
  }
  rideMapLineLayer = null;
  rideMapMarker = null;
  rideHover = null;
  rideMapKey = null;
  setRideMapStatus("");
  document.getElementById("rideMapSummary")?.classList.add("hidden");
}

// --------------------------------------------------------------------------- //
// All-rides heatmap ("Map" view). One interactive Leaflet map draws every
// downloaded track as a translucent line, so stretches you ride often stack up
// brighter. Clicking a track selects that ride; the "Select area" toggle lets you
// drag a rectangle to select every ride passing through it in one shot (cheap even
// with thousands of tracks, unlike a per-frame hover scan). Selected rides are
// highlighted and listed in the side panel, where clicking one opens it in the
// Explore view. Only rides with a downloaded route can be drawn; the side panel
// still lists the rest, flagged, so nothing is silently hidden.
// --------------------------------------------------------------------------- //
// How close (in screen px) a click must land to "hit" a track. A fingertip is far
// less precise than a mouse, so coarse (touch) pointers get a much larger radius.
const CLICK_PX =
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 22 : 8;
const BASE_TRACK = {
  color: "#ff5a1f",
  weight: 3.5,
  opacity: 0.62,
  lineJoin: "round",
  lineCap: "round",
} as const;
const HOT_TRACK = { color: "#ffe066", weight: 6, opacity: 1 } as const;

let allRidesMap: L.Map | null = null;
let allRidesLayer: L.LayerGroup | null = null;
// Whether the all-rides map has been framed at least once. Background data updates
// must NOT re-fit (that resets the user's pan/zoom mid-interaction); we frame only
// on the first draw and on an explicit reset/reframe (see mountAllRidesMap's `fit`).
let mapFitted = false;
const trackLines = new Map<string, L.Polyline>();
let currentTracks: RideTrack[] = [];
let currentMissing = 0;
let hotKeys: string[] = []; // ride highlighted by hovering its side-panel row (ephemeral)
let selectedKeys: string[] = []; // rides selected by a click or area-drag (persist until next selection)
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
const fullRange = (bounds: DateRange): DateRange => ({
  minMs: startOfDayMs(bounds.minMs),
  maxMs: startOfDayMs(bounds.maxMs),
});

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
function reconcileRange(
  sel: DateRange | null,
  oldBounds: DateRange | null,
  bounds: DateRange,
): DateRange {
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

const rangeOf = (which: RangeView): DateRange | null =>
  which === "map" ? mapRange : statsRange;
const boundsOf = (which: RangeView): DateRange | null =>
  which === "map" ? mapRangeBounds : statsRangeBounds;

/** Compact local day label for a slider edge, e.g. "Jun 1, 2026". */
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
    `<div class="rf-track">${input("lo", dayIndex(bounds, sel.minMs))}${input("hi", dayIndex(bounds, sel.maxMs))}` +
    `<div class="rf-window" data-rangewin="${which}" aria-hidden="true" title="Drag to move the selected dates"></div></div>` +
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
  const next: DateRange = {
    minMs: addDays(bounds.minMs, loIdx),
    maxMs: addDays(bounds.minMs, hiIdx),
  };
  if (which === "map") mapRange = next;
  else statsRange = next;
  updateRangeLabels(which);
  if (which === "map") mountAllRidesMap({ fit: false });
  else mountStatsView({ fit: false });
}

/**
 * Drag the selected window (the span between the two thumbs) to slide the whole
 * selection without resizing it — both edges move by the same whole-day delta,
 * clamped so the fixed-size window stays within bounds. Uses pointer capture so
 * the drag keeps tracking past the slider edges (and works on touch).
 */
function onWindowDrag(which: RangeView, win: HTMLElement, e: PointerEvent): void {
  const bounds = boundsOf(which);
  const track = win.parentElement;
  const lo = document.getElementById(`${which}Lo`) as HTMLInputElement | null;
  const hi = document.getElementById(`${which}Hi`) as HTMLInputElement | null;
  if (!bounds || !track || !lo || !hi) return;
  const n = dayCount(bounds);
  const usablePx = track.getBoundingClientRect().width - 15; // track width minus one thumb
  if (n <= 0 || usablePx <= 0) return;

  const startX = e.clientX;
  const startLo = Number(lo.value);
  const span = Number(hi.value) - startLo; // held constant for the whole drag
  win.classList.add("dragging");
  try {
    win.setPointerCapture(e.pointerId);
  } catch {
    // Older engines may reject capture; mouse drag still works without it.
  }

  const move = (ev: PointerEvent): void => {
    const dIdx = Math.round(((ev.clientX - startX) / usablePx) * n);
    const newLo = Math.max(0, Math.min(startLo + dIdx, n - span));
    lo.value = String(newLo);
    hi.value = String(newLo + span);
    const next: DateRange = {
      minMs: addDays(bounds.minMs, newLo),
      maxMs: addDays(bounds.minMs, newLo + span),
    };
    if (which === "map") mapRange = next;
    else statsRange = next;
    updateRangeLabels(which);
    if (which === "map") mountAllRidesMap({ fit: false });
    else mountStatsView({ fit: false });
    ev.preventDefault();
  };
  const end = (): void => {
    win.classList.remove("dragging");
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", end);
    win.removeEventListener("pointercancel", end);
  };
  win.addEventListener("pointermove", move);
  win.addEventListener("pointerup", end);
  win.addEventListener("pointercancel", end);
  e.preventDefault();
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
function setHot(keys: string[]): void {
  if (sameKeys(keys, hotKeys)) return;
  hotKeys = keys;
  paintEmphasis();
}

/** Replace the selection (empty clears it); refresh the side panel. */
function setSelected(keys: string[]): void {
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
const mapAreaSelect: AreaSelect = createAreaSelect({
  getMap: () => allRidesMap,
  getTracks: () => currentTracks,
  button: document.getElementById("btnMapSelect"),
  onSelect: (keys) => setSelected(keys),
  clickPx: CLICK_PX,
});

/** Switch to the Explore view and reveal a specific ride's details. */
function openRideInExplore(key: string): void {
  const ride = STATE.rides.find((r) => r.key === key);
  if (!ride) return;
  openYears.delete(`c${yearOf(ride.month_key)}`); // a year is open when NOT collapsed
  openMonths.add(ride.month_key);
  openStats.add(key);
  setView("explore");
  flashRowIntoView(key);
}

/**
 * Scroll a ride row into view and pulse it. Desktop lands on the first frame, but
 * mobile is fragile: the just-opened detail block mounts a Leaflet mini-map a tick
 * later (invalidateSize on a 0ms timeout) and the mobile URL bar reflows the
 * viewport, so a single scroll lands in the wrong place and the 1.2s flash can
 * finish before the row settles. So we re-scroll over several ticks to correct for
 * the late layout shifts and only start the flash on the final settle pass — that
 * way the blink is reliably seen wherever the row comes to rest.
 */
function flashRowIntoView(key: string): void {
  const find = (): HTMLElement | null => {
    for (const el of document.querySelectorAll<HTMLElement>(".rrow")) {
      if (el.dataset.key === key) return el;
    }
    return null;
  };
  // Instant (not smooth) re-scrolls: two smooth animations fired a few hundred ms
  // apart fight each other on mobile and cancel out. A hard jump on each corrective
  // pass is what actually lands reliably across devices.
  const settleAt = [0, 120, 360]; // ms; the last pass owns the flash
  settleAt.forEach((delay, i) => {
    const run = (): void => {
      const el = find();
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      if (i === settleAt.length - 1) {
        // Restart the pulse so the eye lands on the ride we jumped to.
        el.classList.remove("flash");
        void el.offsetWidth; // reflow to retrigger the animation if re-targeted
        el.classList.add("flash");
        el.addEventListener("animationend", () => el.classList.remove("flash"), {
          once: true,
        });
      }
    };
    if (delay === 0) requestAnimationFrame(run);
    else setTimeout(run, delay);
  });
}

/** Compact distance label for a ride: prefer the measured route length, fall back to the normalized summary. */
function rideKmText(r: RideView): string {
  if (r.track_km > 0) return fmtKm(r.track_km);
  const d = r.distance_km ?? 0;
  return d > 0 ? fmtKm(d) : "—";
}

/** Average-speed label for a ride, formatted canonically (em dash when unknown). */
function rideSpeedText(r: RideView): string {
  const v = r.avg_speed_kmh ?? 0;
  return v > 0 ? fmtSpeed(v) : "—";
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
      `<div class="ms-empty">No rides yet. Sign in to your <b>Beeline</b> account to load them, ` +
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
    ? `${tracks.length} on map · ${missing} without a route`
    : `${tracks.length} on map`;
  const hiddenNote = hidden
    ? `<div class="ms-hidden">${hidden} hidden by the date filter</div>`
    : "";
  side.innerHTML =
    `<div class="ms-head"><h2>All rides</h2><span class="ms-count" id="msCount"></span></div>` +
    renderMatched() +
    `<div class="ms-sub">${sub}</div>${hiddenNote}<div class="ms-list">${items}</div>`;
}

/**
 * The "Selected" block: rides chosen by a click or an area-drag, each with quick
 * stats (date · distance · avg speed). Shared by the Map view's side panel and the
 * Stats view's heatmap; clicking an entry opens it in the Explore view.
 */
function renderMatchedCards(keys: string[]): string {
  const matched = keys
    .map((k) => STATE.rides.find((r) => r.key === k && !r.deleted))
    .filter((r): r is RideView => !!r)
    .sort((a, b) => compareRideKeysDesc(a.key, b.key));
  if (!matched.length) return "";
  const cards = matched
    .map((r) => {
      const when = escHtml(rideShortLabel(r.key) || r.key);
      const name = escHtml((r.title || "Ride") + (r.location || ""));
      const km = escHtml(rideKmText(r));
      const spd = escHtml(rideSpeedText(r));
      return (
        `<div class="ms-item matched" data-key="${escHtml(r.key)}" title="${name}">` +
        `<div class="ms-name">${name}</div>` +
        `<div class="ms-meta"><span class="ms-when">${when}</span>` +
        `<span class="ms-figs"><span class="ms-km">${km}</span><span class="ms-spd">${spd}</span></span></div>` +
        `</div>`
      );
    })
    .join("");
  const noun = matched.length === 1 ? "ride" : "rides";
  return (
    `<div class="ms-matched">` +
    `<div class="ms-mhead"><h3>Selected · ${matched.length} ${noun}</h3>` +
    `<button class="ms-clear" title="Clear the selection">Clear</button></div>` +
    `<div class="ms-mhint">Click a ride below to open it in Explore.</div>` +
    `<div class="ms-list">${cards}</div></div>`
  );
}

/** The Map side panel's "Selected" block for the current click/area selection. */
function renderMatched(): string {
  return renderMatchedCards(selectedKeys);
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
    allRidesMap = L.map(host, {
      attributionControl: true,
      zoomControl: true,
      fadeAnimation: false,
      // Render every track onto one <canvas> instead of one SVG <path> per ride:
      // at thousands of overlapping tracks the SVG DOM is the bottleneck. The
      // translucent strokes still blend on canvas, so the "ridden more = brighter"
      // heatmap look is preserved, and pan/zoom stays smooth at scale.
      preferCanvas: true,
    });
    allRidesMap.attributionControl.setPrefix(false); // compact credit, no "Leaflet" flag
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
      className: "map-tiles",
    }).addTo(allRidesMap);
    allRidesLayer = L.layerGroup().addTo(allRidesMap);
    allRidesMap.setView([20, 0], 2); // sane default until the first track is drawn
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
  syncRangeControl("map");
  paintEmphasis();
  // The container is only correctly sized once its view becomes visible.
  setTimeout(() => {
    allRidesMap!.invalidateSize();
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
  if (!isStats && document.body.classList.contains("heat-expanded")) setHeatExpanded(false);
  if (!isMap && mapAreaSelect.isArmed()) mapAreaSelect.setMode(false);
  if (!isStats && heatAreaSelect.isArmed()) heatAreaSelect.setMode(false);
  document.querySelectorAll<HTMLButtonElement>("#viewTabs .vtab").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === activeView);
  });
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
  // The button is icon-only (maximize ↔ minimize swaps via CSS on aria-pressed).
  document.getElementById("btnMapExpand")?.setAttribute("aria-pressed", on ? "true" : "false");
  // The container changed size; let Leaflet re-measure to match.
  requestAnimationFrame(() => {
    allRidesMap?.invalidateSize();
  });
}

/** Toggle the Stats heatmap between inline and full-screen; resize Leaflet to match. */
function setHeatExpanded(on: boolean): void {
  document.body.classList.toggle("heat-expanded", on);
  document
    .getElementById("btnHeatExpand")
    ?.setAttribute("aria-pressed", on ? "true" : "false");
  requestAnimationFrame(() => {
    freqHeatMap?.invalidateSize();
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

/** Remove the heatmap's hover overlay line, if any. */
function clearHeatHover(): void {
  if (heatHoverLine) {
    heatHoverLine.remove();
    heatHoverLine = null;
  }
}

/** Draw (or move) the hover overlay to the given ride's track on the heatmap. */
function showHeatHover(key: string): void {
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
function renderHeatMatched(): void {
  const box = document.getElementById("heatMatched");
  if (!box) return;
  const drawn = new Set(lastHeatTracks.map((t) => t.key));
  heatSelectedKeys = heatSelectedKeys.filter((k) => drawn.has(k));
  clearHeatHover();
  const cards = renderMatchedCards(heatSelectedKeys);
  box.innerHTML =
    cards ||
    `<div class="ms-empty">Drag a rectangle on the heatmap with the <b>Select area</b> ` +
      `tool — or click near a route — to list the rides passing through it here.</div>`;
}

// The Stats heatmap's area-select gesture: a box-drag selects every ride crossing
// it, a click the nearest. Selection drives the matching list below the heatmap.
const heatAreaSelect: AreaSelect = createAreaSelect({
  getMap: () => freqHeatMap,
  getTracks: () => lastHeatTracks,
  button: document.getElementById("btnHeatSelect"),
  onSelect: (keys) => {
    heatSelectedKeys = keys;
    renderHeatMatched();
  },
  clickPx: CLICK_PX,
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
  const radius = STATE.settings.heatRadius;
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

/** Whole hours-and-minutes label for a duration, e.g. "12h 30m" or "45m". */
function fmtDuration(totalSec: number): string {
  const mins = Math.round(totalSec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Exact "H:MM:SS" / "M:SS" for the per-ride detail grid (preserves seconds). */
function fmtDurationExact(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Compact metres/kilometres label for an elevation total. */
function fmtElevation(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}k m` : `${Math.round(m)} m`;
}

/** Human-readable size for the locally stored state (MB, with a KB step for tiny payloads). */
function fmtBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} B`;
  const mb = kb / 1024;
  if (mb < 0.1) return `${Math.round(kb)} KB`;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
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
  return statCard(
    fmtKm(rec.km),
    label,
    `${rec.label} · ${rec.count} ride${rec.count === 1 ? "" : "s"}`,
  );
}

/** Render the Stats view: totals, records and the route-frequency heatmap. */
/**
 * Whether the Stats date slider is narrowed below the full span, and if so a
 * compact label for the selected window (e.g. "filtered · Jan 1 – Mar 1, 2026").
 * Returns "" when the full span is selected so the header flag stays hidden.
 */
function statsFilteredFlag(): string {
  const bounds = boundsOf("stats");
  const sel = rangeOf("stats");
  if (!bounds || !sel) return "";
  const n = dayCount(bounds);
  if (n <= 0) return "";
  const narrowed = dayIndex(bounds, sel.minMs) > 0 || dayIndex(bounds, sel.maxMs) < n;
  if (!narrowed) return "";
  return `filtered · ${fmtDay(sel.minMs)} – ${fmtDay(sel.maxMs)}`;
}

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

  // When the date slider is narrowed below the full span, the totals/records are
  // a filtered subset — flag both section headers so it's never mistaken for the
  // lifetime figure. Empty string (not filtered) hides the flag via :empty.
  const flag = statsFilteredFlag();
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
  syncRangeControl("stats");
  syncHeatControl();
  mountFreqHeatmap(visible, hidden, opts.fit);
}

/** Push the persisted heatmap thickness into its slider/output (skip while dragging). */
function syncHeatControl(): void {
  const slider = document.getElementById("heatRadius") as HTMLInputElement | null;
  const out = document.getElementById("heatRadiusOut") as HTMLOutputElement | null;
  if (slider && document.activeElement !== slider) {
    slider.value = String(STATE.settings.heatRadius);
  }
  if (out) out.value = String(STATE.settings.heatRadius);
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
    freqHeatMap = L.map(host, {
      attributionControl: true,
      zoomControl: true,
      fadeAnimation: false,
    });
    freqHeatMap.attributionControl.setPrefix(false); // compact credit, no "Leaflet" flag
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
      className: "map-tiles",
    }).addTo(freqHeatMap);
    freqHeatMap.setView([20, 0], 2); // sane default until the first track is drawn
    // Heat-point spacing is geographic but the glow radius is in pixels, so zooming
    // in spreads the points until they bead. Rebuild after each pan/zoom so spacing
    // re-adapts and only the visible slice is densified (moveend covers both).
    freqHeatMap.on("moveend", () => redrawFreqHeatmap());
    heatAreaSelect.attach();
  }

  const radius = STATE.settings.heatRadius;
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

// --------------------------------------------------------------------------- //
// Small render helpers (ported verbatim)
// --------------------------------------------------------------------------- //

/**
 * Inline SVG for the "⋯" overflow (kebab) toggle — three stacked dots drawn as
 * filled circles so it renders crisply at any DPI, unlike the Unicode glyph.
 * `currentColor` lets it inherit the button's muted text colour.
 */
const KEBAB_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';

/**
 * Inline SVG for the "Upload to Strava" action — an up-arrow into a tray, drawn
 * with strokes (matching the app's other line icons) so it reads as "upload" at
 * a glance. Shown only when the button collapses to icon-only on narrow screens
 * (the text label carries the meaning on wider ones); `currentColor` inherits
 * the accent button's text colour. Inline SVG, never a Unicode glyph.
 */
const UPLOAD_ICON =
  '<svg class="mi mi-upl" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>';

function badge(s: string): string {
  const label =
    (
      {
        pending: "upload pending",
        uploaded: "uploaded",
        processing: "working",
        unknown: "\u2014",
      } as Record<string, string>
    )[s] || s;
  return `<span class="badge ${s}">${label}</span>`;
}
function queueBadge(key: string): string {
  if (RUNNING.has(key)) return `<span class="badge working">working</span>`;
  if (ACTIVE.has(key)) return `<span class="badge queued">queued</span>`;
  return "";
}
function deletedBadge(): string {
  return `<span class="badge deleted" title="This ride is no longer in your Beeline account — it was deleted in the Beeline app.">deleted</span>`;
}
/**
 * Marks a ride whose rough route preview is already downloaded and ready to draw.
 * In Beeline mode every ride carries its track, so the badge is usually constant
 * (the GPS filter still finds the rare track-less one-offs).
 */
function gpsBadge(): string {
  return `<span class="badge gps" title="Route preview available — expand details to see the map.">gps</span>`;
}
function fmtStats(r: RideView): string {
  // Render the detail grid from the NORMALIZED numbers so a comma-decimal source
  // ("20,0km/h") reads identically to a dot one ("20.0 km/h"). Each row appears
  // only when its figure is known (non-null).
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: number | null, fmt: (n: number) => string): void => {
    if (value != null) rows.push([label, fmt(value)]);
  };
  add("Distance", r.distance_km, fmtKmDetail);
  add("Average speed", r.avg_speed_kmh, fmtSpeed);
  add("Max speed", r.max_speed_kmh, fmtSpeed);
  add("Moving time", r.moving_sec, fmtDurationExact);
  add("Elapsed time", r.elapsed_sec, fmtDurationExact);
  add("Elevation gain", r.elevation_gain_m, fmtElevation);
  add("Elevation loss", r.elevation_loss_m, fmtElevation);
  return rows
    .map(
      ([k, v]) =>
        `<div class="stat"><span class="k">${k}</span><span class="v">${escHtml(v)}</span></div>`,
    )
    .join("");
}
function bars(up: number, pe: number, total: number): string {
  if (!total) return "";
  const u = Math.round((up / total) * 100);
  const p = Math.round((pe / total) * 100);
  return `<span class="bars"><i class="up" style="width:${u}%"></i><i class="pe" style="width:${p}%"></i></span>`;
}
function fmtKm(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k km` : `${Math.round(v)} km`;
}
/** Distance with one decimal (detail grid / row meta), e.g. "13.5 km". */
function fmtKmDetail(v: number): string {
  return `${v.toFixed(1)} km`;
}
function fmtSpeed(v: number): string {
  return `${v.toFixed(1)} km/h`;
}

// -- filter bar (predicates live in ./filter) -----------------------------

/** Reflect the filter state in the bar: device options, chip labels, active classes. */
function syncFilterBar(allRides: AppState["rides"]): void {
  // Status segment.
  document.querySelectorAll<HTMLButtonElement>("#fStatus button").forEach((b) => {
    b.classList.toggle("active", b.dataset.fstatus === filters.status);
  });

  // Tri-state chips: glyph + active styling reflect the current state.
  const chip = (id: string, label: string, state: string, yes: string): void => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.state = state;
    el.textContent =
      state === "any" ? `${label}: any` : `${label} ${state === yes ? "✓" : "✕"}`;
    el.classList.toggle("on", state !== "any");
  };
  chip("fGps", "GPS", filters.gps, "yes");
  chip("fDetails", "Details", filters.details, "yes");
  chip("fDestination", "Destination", filters.destination, "yes");
  chip("fNamed", "Named", filters.named, "yes");
  chip("fDeleted", "Deleted", filters.deleted, "only");

  // Source dropdown: rebuild options from the distinct devices present.
  const sel = $<HTMLSelectElement>("#fDevice");
  if (sel) {
    const models = [...new Set(allRides.map((r) => r.device_model).filter(Boolean))].sort();
    const hasMissing = allRides.some((r) => !r.device_model);
    const want =
      `<option value="all">All</option>` +
      models.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("") +
      (hasMissing ? `<option value="__none__">(no device)</option>` : "");
    if (sel.dataset.opts !== want) {
      sel.dataset.opts = want;
      sel.innerHTML = want;
    }
    // Selected value may have vanished (e.g. cache cleared) — fall back to All.
    const valid =
      filters.device === "all" ||
      models.includes(filters.device) ||
      (filters.device === "__none__" && hasMissing);
    if (!valid) filters.device = "all";
    sel.value = filters.device;
    // Mirror the chips: a non-"All" device turns the pill accent-orange so an
    // active Source filter reads as active like the rest of the bar.
    sel.closest(".fdevice")?.classList.toggle("on", filters.device !== "all");
  }

  // Distance inputs (don't clobber the field being typed into).
  const min = $<HTMLInputElement>("#fDistMin");
  const max = $<HTMLInputElement>("#fDistMax");
  if (min && document.activeElement !== min)
    min.value = filters.distMin === null ? "" : String(filters.distMin);
  if (max && document.activeElement !== max)
    max.value = filters.distMax === null ? "" : String(filters.distMax);

  // Clear button visibility.
  $("#fClear").classList.toggle("hidden", !filtersActive(filters));

  // Mobile "Filters" toggle: badge the count of active dimensions so a collapsed
  // bar still signals that filtering is on, and accent the toggle to match.
  const n = filterActiveCount(filters);
  const count = document.getElementById("fCount");
  if (count) {
    count.textContent = String(n);
    count.toggleAttribute("hidden", n === 0);
  }
  document.getElementById("fToggle")?.classList.toggle("on", n > 0);
}

/** Advance a tri-state chip one step on click. */
function cycleChip(which: string): void {
  const nextTri = (s: TriState): TriState =>
    s === "any" ? "yes" : s === "yes" ? "no" : "any";
  if (which === "gps") filters.gps = nextTri(filters.gps);
  else if (which === "details") filters.details = nextTri(filters.details);
  else if (which === "destination") filters.destination = nextTri(filters.destination);
  else if (which === "named") filters.named = nextTri(filters.named);
  else if (which === "deleted") {
    filters.deleted =
      filters.deleted === "any" ? "only" : filters.deleted === "only" ? "none" : "any";
  }
}

/** Reset every filter to its neutral (show-all) value. */
function clearFilters(): void {
  filters.status = "all";
  filters.gps = "any";
  filters.details = "any";
  filters.destination = "any";
  filters.named = "any";
  filters.deleted = "any";
  filters.device = "all";
  filters.distMin = null;
  filters.distMax = null;
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
  document.querySelectorAll<HTMLButtonElement>("#statGran button").forEach((b) => {
    b.classList.toggle("active", b.dataset.gran === statGran);
  });
  document.querySelectorAll<HTMLButtonElement>("#statMetric button").forEach((b) => {
    b.classList.toggle("active", b.dataset.metric === statMetric);
  });

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
    const km = r.distance_km ?? 0;
    const [bkey, label, short] = bucketRide(r.key, gran);
    if (!byM.has(bkey))
      byM.set(bkey, { label, short, km: 0, n: 0, spKm: 0, spSec: 0, spN: 0, rides: [] });
    const e = byM.get(bkey)!;
    e.km += km;
    e.n += 1;
    const sec = r.moving_sec ?? 0;
    if (sec > 0) {
      // Distance for the speed calc uses the same normalized figure.
      const spKm = r.distance_km ?? 0;
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

function renderDistance(
  gran: Granularity,
  items: [string, StatBucket][],
  rideCount: number,
): void {
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
  const disconnectBtn = $<HTMLButtonElement>("#btnDisconnect");
  const sourceBtn = $<HTMLButtonElement>("#btnSource");

  sourceBtn.style.display = "";

  const beeline = currentSource === "beeline";

  if (isDemo) {
    el.textContent = "demo · Beeline";
    el.className = "cstate demo";
    // No dedicated "Exit demo" button: the always-visible "Change source" already
    // leads out of the demo (picking any source replaces it), so a second exit
    // affordance would just be header clutter.
    disconnectBtn.style.display = "none";
  } else if (STATE.connected) {
    el.textContent = STATE.device || "connected";
    el.className = "cstate on";
    // No "Sign out" button: the password is never stored, so a plain page refresh
    // already drops account access (back to offline cached rides), and "Change
    // source" leads out — a dedicated sign-out would just be header clutter.
    disconnectBtn.style.display = "none";
  } else if (beeline) {
    // Showing cached Beeline rides without a live account — flag it in red so the
    // "stale, can't sync right now" state is unmistakable, and offer a way back in.
    el.textContent = "offline — not signed in";
    el.className = "cstate err";
    disconnectBtn.textContent = "Sign in";
    disconnectBtn.style.display = "";
  } else {
    el.textContent = "not connected";
    el.className = "cstate off";
    disconnectBtn.style.display = "none";
  }

  // In Beeline mode the one action pulls the whole history at once: "Re-sync".
  const scanLabel = document.getElementById("scanLabel");
  if (scanLabel) scanLabel.textContent = beeline ? "Re-sync" : "Scan";
}

function render(): void {
  renderConn();
  const allRides = STATE.rides;
  const rides = visibleRides(filters, allRides);
  const jobs = STATE.jobs;
  ACTIVE = new Set(jobs.active_keys || []);
  RUNNING = new Set(jobs.current ? jobs.current_keys || [] : []);

  // Filter bar: only useful once there are rides to narrow.
  $("#filterbar").classList.toggle("hidden", allRides.length === 0);
  syncFilterBar(allRides);

  // Empty state: distinguish "no rides at all" from "filters hid everything".
  const emptyEl = $("#empty") as HTMLElement;
  if (allRides.length === 0) {
    emptyEl.style.display = "block";
    emptyEl.innerHTML = "Sign in to your <b>Beeline</b> account to load your rides.";
  } else if (rides.length === 0) {
    emptyEl.style.display = "block";
    emptyEl.innerHTML =
      'No rides match the current filters. <a href="#" id="emptyClear">Clear filters</a>';
  } else {
    emptyEl.style.display = "none";
  }
  // The inline stats panel always reflects the full (unfiltered) dataset.
  renderStats(allRides);

  const byMonth = new Map<string, { label: string; rides: AppState["rides"] }>();
  for (const r of rides) {
    if (!byMonth.has(r.month_key))
      byMonth.set(r.month_key, { label: r.month_label, rides: [] });
    byMonth.get(r.month_key)!.rides.push(r);
  }
  const months = [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const byYear = new Map<
    string,
    Array<[string, { label: string; rides: AppState["rides"] }]>
  >();
  for (const [mkey, m] of months) {
    const y = yearOf(mkey);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push([mkey, m]);
  }
  const years = [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const up = rides.filter((r) => r.status === "uploaded").length;
  const pe = rides.filter((r) => r.status === "pending" && !r.deleted).length;
  const del = rides.filter((r) => r.deleted).length;
  const shown = filtersActive(filters)
    ? `${rides.length} of ${allRides.length} rides`
    : `${rides.length} rides`;
  const nSel = selected.size;
  // The "N selected" suffix doubles as a one-click "Clear selection" affordance.
  // Everything interpolated here is static text or a number, so innerHTML is safe.
  $("#totals").innerHTML =
    `${shown} · ${up} uploaded · ${pe} upload pending` +
    (del ? ` · ${del} deleted` : "") +
    (nSel
      ? ` · <button class="selchip" id="selClear" title="Clear selection">${nSel} selected <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`
      : "");

  // Batch actions apply to the current selection — disable + count-label them so
  // "nothing to do" is obvious instead of a button that just toasts on click. The
  // actions live behind one dropdown (Save .gpx + Upload), so the caret is disabled
  // too when empty.
  const selBtns: Array<[string, string]> = [
    ["btnGpxSaveSel", "Save .gpx files"],
    ["btnGpxSaveSelFull", "Save full .gpx files"],
    ["btnUploadSel", "Upload selected to Strava"],
  ];
  for (const [id, base] of selBtns) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (!b) continue;
    b.disabled = nSel === 0;
    b.textContent = nSel ? `${base} (${nSel})` : base;
  }
  // The selection actions live behind one labelled dropdown; without a fused primary
  // button the caret would read as a lone icon, so promote it to a standalone
  // `.menubtn` (the style the "Data" button uses).
  const selCaret = document.querySelector<HTMLButtonElement>('[data-splitmenu="sel"]');
  if (selCaret) {
    selCaret.disabled = nSel === 0;
    selCaret.classList.remove("caret");
    selCaret.classList.add("menubtn");
    selCaret.textContent = nSel ? `Selected ride actions (${nSel})` : "Selected ride actions";
  }
  // The whole selected-ride actions cluster only makes sense with a selection —
  // hide it entirely when nothing is selected rather than showing disabled "Check
  // selected"/"Selected ride actions" controls that can't do anything yet.
  const selCluster = document.getElementById("selSplit");
  if (selCluster) selCluster.style.display = nSel ? "" : "none";

  const sizeEl = $("#stateSize");
  if (sizeEl) sizeEl.textContent = fmtBytes(controller.stateBytes());

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
    const ykm = yRides.reduce((s, r) => s + (r.distance_km ?? 0), 0);
    const yOpen = !openYears.has(`c${year}`);
    const ySel = allSelState(yKeys);

    const ybox = document.createElement("div");
    ybox.className = "year";
    ybox.innerHTML = `
      <div class="yhead" data-y="${year}">
        <span class="caret${yOpen ? " open" : ""}" aria-hidden="true"></span>
        <input type="checkbox" class="selall" data-selyear="${year}" ${ySel === true ? "checked" : ""}>
        <span class="ytitle">${year}</span>
        ${bars(yup, ype, yRides.length)}
        <span class="ymeta">${yRides.length} rides · ${fmtKm(ykm)} · ${yup} up · ${ype} upload pending</span>
        <span class="yactions${openMenu === `ovr-y:${year}` ? " open" : ""}">
          <button class="small ghost ovr" data-splitmenu="ovr-y:${year}" aria-haspopup="true" aria-expanded="${openMenu === `ovr-y:${year}`}" title="Actions for ${year}">${KEBAB_ICON}</button>
          <span class="ovr-items">
            <button class="small" data-act="upload-year" data-y="${year}">Upload pending to Strava</button>
          </span>
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
      const mkm = m.rides.reduce((s, r) => s + (r.distance_km ?? 0), 0);
      const isOpen = openMonths.has(mkey);
      const mKeys = m.rides.map((r) => r.key);
      const mSel = allSelState(mKeys);

      const box = document.createElement("div");
      box.className = "month";
      box.innerHTML = `
        <div class="mhead" data-m="${mkey}">
          <span class="caret${isOpen ? " open" : ""}" aria-hidden="true"></span>
          <input type="checkbox" class="selall" data-selmonth="${mkey}" ${mSel === true ? "checked" : ""}>
          <span class="mtitle">${m.label}</span>
          ${bars(mup, mpe, m.rides.length)}
          <span class="mmeta">${m.rides.length} rides · ${fmtKm(mkm)} · ${mup} up · ${mpe} upload pending</span>
          <span class="mactions${openMenu === `ovr-m:${mkey}` ? " open" : ""}">
            <button class="small ghost ovr" data-splitmenu="ovr-m:${mkey}" aria-haspopup="true" aria-expanded="${openMenu === `ovr-m:${mkey}`}" title="Actions for ${m.label}">${KEBAB_ICON}</button>
            <span class="ovr-items">
              <button class="small" data-act="upload-month" data-m="${mkey}">Upload pending to Strava</button>
            </span>
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
        const summaryDistance =
          r.distance_km != null && r.distance_km > 0 ? fmtKmDetail(r.distance_km) : "?";
        const summaryDuration =
          r.elapsed_sec != null
            ? fmtDurationExact(r.elapsed_sec)
            : r.moving_sec != null
              ? fmtDurationExact(r.moving_sec)
              : "?";
        const el = document.createElement("div");
        el.className = `rrow${r.deleted ? " deleted" : ""}${selected.has(r.key) ? " sel" : ""}`;
        el.dataset.key = r.key;
        el.innerHTML = `
          <input type="checkbox" class="chk" data-key="${r.key}" ${selected.has(r.key) ? "checked" : ""}>
          <div class="rmain">
            <div class="rtitle"><span class="rname"><span class="rtitle-text">${r.title || "Ride"}</span>${r.location ? `<span class="rtitle-loc">${r.location}</span>` : ""}</span> ${badge(r.status)} ${!beelineMode() && r.track ? gpsBadge() : ""} ${r.deleted ? deletedBadge() : ""} ${queueBadge(r.key)}</div>
            <div class="rmeta">${r.key} · ${summaryDistance} · ${summaryDuration}
              <a href="#" data-stats="${r.key}">${so ? "hide" : "details"}</a></div>
            ${so ? detailsBlock(r) : ""}
          </div>
          <div class="rbtns${openMenu === `ovr-r:${r.key}` ? " open" : ""}">
            <button class="small accent" data-act="upload-one" data-key="${r.key}"${r.status === "uploaded" ? ' disabled title="Already uploaded to Strava"' : ' title="Upload to Strava"'}>${UPLOAD_ICON}<span class="btn-label">Upload to Strava</span></button>
            <button class="small ghost ovr" data-splitmenu="ovr-r:${r.key}" aria-haspopup="true" aria-expanded="${openMenu === `ovr-r:${r.key}`}" title="More ride actions">${KEBAB_ICON}</button>
            <span class="ovr-items">
              <button class="small ghost" data-act="gpx-save-one" data-key="${r.key}" title="Save the lightweight route-only GPX (shape only, instant)">Save .gpx (route)</button>
              <button class="small ghost" data-act="gpx-save-full-one" data-key="${r.key}" title="Download the full recorded GPX (real timestamps + elevation) and save it">Save full .gpx</button>
              ${r.deleted ? "" : `<button class="small ghost" data-act="rename-one" data-key="${r.key}" title="Rename this ride on Beeline">Rename…</button>`}
              ${r.deleted ? "" : `<button class="small danger" data-act="delete-one" data-key="${r.key}" title="Delete this ride from Beeline">Delete…</button>`}
            </span>
          </div>`;
        rowsEl.appendChild(el);
      }
    }
  }
  renderJob();
  if (activeView === "map") mountAllRidesMap();
  else if (activeView === "stats") mountStatsView();
  else mountMaps();
  // The selection toolbar's split button lives in static markup (not rebuilt
  // here), so sync its open state from the shared `openMenu` flag.
  const selSplit = document.getElementById("selMenu")?.closest(".split");
  selSplit?.classList.toggle("open", openMenu === "sel");
  const stateSplit = document.getElementById("stateMenu")?.closest(".split");
  stateSplit?.classList.toggle("open", openMenu === "state");
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
      ($("#jobBarFill") as HTMLElement).style.width =
        `${Math.round((p.done / p.total) * 100)}%`;
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
  $("#jobHandleText").textContent = total
    ? `${total} ride${total === 1 ? "" : "s"}`
    : "Working\u2026";

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
  if (p && p.total > 0)
    return `${verb} ${p.done} of ${p.total} ride${p.total === 1 ? "" : "s"}`;
  return `${verb} ${t.count} ride${t.count === 1 ? "" : "s"}`;
}

/** A waiting-queue row: verb + count, with a per-item remove button. */
function queueItemHtml(t: JobTask): string {
  const verb = TASK_VERB[t.kind] || t.kind;
  const desc =
    t.kind === "scan"
      ? t.label
        ? `${verb} ${t.label}`
        : verb
      : `${verb} ${t.count} ride${t.count === 1 ? "" : "s"}`;
  return `<div class="job-item">
    <span class="ji-dot"></span>
    <span class="ji-text">${escHtml(desc)}</span>
    <button class="ji-x" data-cancel="${t.id}" title="Remove from queue" aria-label="Remove from queue">\u00d7</button>
  </div>`;
}

function shortError(text: string): string {
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim()) || text;
  // The full error is "header:\n  • per-ride detail" — when we show only this first
  // line as a summary (toast / collapsed card), the trailing colon promises detail
  // that isn't shown here, so drop it. The full text keeps the colon + bullets.
  return line.trim().replace(/:$/, "");
}

function renderError(jobs: AppState["jobs"]): void {
  const stack = $("#errstack");

  // Combine the two error sources into one newest-first list, dropping any the user
  // has already dismissed. Job errors are keyed by task id; standalone errors carry
  // their own push id. Both expose a wall-clock `ts` so they interleave by recency.
  type ErrCard = { id: string; title: string; full: string; ts: number };
  const cards: ErrCard[] = [];
  const all = [...(jobs.history || [])];
  if (jobs.current) all.push(jobs.current);
  for (const t of all) {
    if (t.status !== "error" || !t.error) continue;
    cards.push({
      id: `job-${t.id}`,
      title: `${t.kind} failed${t.label ? ` — ${t.label}` : ""}`,
      full: t.error,
      ts: (t.finished_at ?? 0) * 1000,
    });
  }
  for (const p of pushedErrors) {
    cards.push({ id: p.id, title: p.title, full: p.full, ts: p.ts });
  }
  const visible = cards.filter((c) => !dismissedErrIds.has(c.id)).sort((a, b) => b.ts - a.ts);

  // Rebuild the stack from scratch each render; building via DOM (not innerHTML)
  // keeps user-supplied error text from being interpreted as markup.
  stack.textContent = "";
  for (const c of visible) {
    const card = document.createElement("div");
    card.className = "errcard";
    card.dataset.id = c.id;

    const bar = document.createElement("div");
    bar.className = "errbar show";

    const ico = document.createElement("span");
    ico.className = "ico";
    ico.textContent = "⚠";

    const etext = document.createElement("div");
    etext.className = "etext";
    const title = document.createElement("b");
    title.textContent = c.title;
    const msg = document.createElement("span");
    msg.textContent = shortError(c.full);
    etext.append(title, msg);

    const details = document.createElement("button");
    details.className = "small ghost";
    details.dataset.errDetails = "";
    details.textContent = "Details";

    const dismiss = document.createElement("button");
    dismiss.className = "small ghost";
    dismiss.dataset.errDismiss = "";
    dismiss.textContent = "Dismiss";

    bar.append(ico, etext, details, dismiss);

    const full = document.createElement("pre");
    full.className = "errfull";
    full.textContent = c.full;

    card.append(bar, full);
    stack.append(card);
  }

  // Flash the newest error as a toast the first time we see it, for immediacy — the
  // persistent card is the durable record, so the flash may safely fade.
  const newest = visible[0];
  if (newest && !shownErrIds.has(newest.id)) {
    shownErrIds.add(newest.id);
    toast(shortError(newest.full), true);
  }
}

/**
 * Record a standalone error (connection, import, storage…) that lives outside the
 * job queue, so it persists in the error stack until the user dismisses it instead
 * of vanishing with the next status toast.
 */
function pushError(title: string, full: string): void {
  pushedErrors.push({ id: `push-${++errSeq}`, title, full, ts: Date.now() });
  renderError(STATE.jobs);
}

const keysOfMonth = (m: string): string[] =>
  STATE.rides.filter((r) => r.month_key === m).map((r) => r.key);
const pendingOfMonth = (m: string): string[] =>
  STATE.rides
    .filter((r) => r.month_key === m && r.status === "pending" && !r.deleted)
    .map((r) => r.key);
const keysOfYear = (y: string): string[] =>
  STATE.rides.filter((r) => (r.month_key || "").slice(0, 4) === y).map((r) => r.key);
const pendingOfYear = (y: string): string[] =>
  STATE.rides
    .filter(
      (r) => (r.month_key || "").slice(0, 4) === y && r.status === "pending" && !r.deleted,
    )
    .map((r) => r.key);

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
  // Error toasts linger longer (so they don't blink past) but must still clear on
  // their own — the persistent, dismissable error card at the top is the durable
  // record, so the transient toast can safely fade. Non-errors fade quickly.
  t._t = window.setTimeout(() => (t.style.display = "none"), err ? 8000 : 4000);
}

/** Hide the transient toast immediately (e.g. the user tapped it). */
function dismissToast(): void {
  const t = $<HTMLElement & { _t?: number }>("#toast");
  clearTimeout(t._t);
  t.style.display = "none";
}

// Resolver for the currently-open styled confirm/prompt dialog (null when closed).
let confirmResolve: ((value: boolean | string | null) => void) | null = null;
// True while the open dialog is a prompt (collects text) rather than a yes/no.
let confirmIsPrompt = false;

/**
 * Show the styled confirmation modal (a themed replacement for window.confirm)
 * and resolve to whether the user confirmed. Reuses the app's modal vocabulary so
 * high-stakes actions get a clear, on-brand "are you sure" instead of the
 * browser's native popup. Only one dialog is open at a time.
 */
function confirmDialog(opts: {
  title: string;
  body: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const modal = document.getElementById("confirmModal");
  if (!modal) return Promise.resolve(true);
  confirmResolve?.(false); // abandon any prior pending dialog
  confirmIsPrompt = false;
  $("#confirmInput").classList.add("hidden");
  $("#confirmCheck").classList.add("hidden");
  $("#confirmTitle").textContent = opts.title;
  $("#confirmBody").textContent = opts.body;
  $("#confirmOk").textContent = opts.confirmLabel ?? "Confirm";
  modal.classList.remove("hidden");
  $<HTMLButtonElement>("#confirmOk").focus();
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve as (v: boolean | string | null) => void;
  });
}

/**
 * One-time consent prompt before routing a full-GPX download through the external
 * export gateway. Reuses the confirm modal — plus its checkbox row — so it matches
 * the app's dialog vocabulary. Resolves to whether the user agreed and whether they
 * ticked "don't ask again".
 */
function consentDialog(opts: {
  title: string;
  body: string;
  confirmLabel?: string;
  checkLabel: string;
  checked?: boolean;
}): Promise<{ ok: boolean; dontAsk: boolean }> {
  const modal = document.getElementById("confirmModal");
  if (!modal) return Promise.resolve({ ok: true, dontAsk: false });
  confirmResolve?.(false); // abandon any prior pending dialog
  confirmIsPrompt = false;
  $("#confirmInput").classList.add("hidden");
  $("#confirmCheck").classList.remove("hidden");
  $("#confirmCheckLabel").textContent = opts.checkLabel;
  $<HTMLInputElement>("#confirmCheckBox").checked = opts.checked ?? true;
  $("#confirmTitle").textContent = opts.title;
  $("#confirmBody").textContent = opts.body;
  $("#confirmOk").textContent = opts.confirmLabel ?? "Continue";
  modal.classList.remove("hidden");
  $<HTMLButtonElement>("#confirmOk").focus();
  return new Promise<{ ok: boolean; dontAsk: boolean }>((resolve) => {
    confirmResolve = ((ok) => {
      const dontAsk = $<HTMLInputElement>("#confirmCheckBox").checked;
      resolve({ ok: ok === true, dontAsk });
    }) as (v: boolean | string | null) => void;
  });
}

/**
 * Like `confirmDialog`, but with a single text field — a themed replacement for
 * window.prompt. Resolves to the (trimmed) entered string, or null when cancelled.
 * Pre-fills `value` and selects it so the common "tweak then accept" is one gesture.
 */
function promptDialog(opts: {
  title: string;
  body: string;
  value?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  const modal = document.getElementById("confirmModal");
  if (!modal) return Promise.resolve(null);
  confirmResolve?.(false); // abandon any prior pending dialog
  confirmIsPrompt = true;
  $("#confirmCheck").classList.add("hidden");
  $("#confirmTitle").textContent = opts.title;
  $("#confirmBody").textContent = opts.body;
  $("#confirmOk").textContent = opts.confirmLabel ?? "Save";
  const input = $<HTMLInputElement>("#confirmInput");
  input.classList.remove("hidden");
  input.value = opts.value ?? "";
  modal.classList.remove("hidden");
  input.focus();
  input.select();
  return new Promise<string | null>((resolve) => {
    confirmResolve = resolve as (v: boolean | string | null) => void;
  });
}

/** Close the confirm/prompt modal and settle its promise with the user's choice. */
function closeConfirm(ok: boolean): void {
  document.getElementById("confirmModal")?.classList.add("hidden");
  document.getElementById("confirmCheck")?.classList.add("hidden");
  const resolve = confirmResolve;
  const isPrompt = confirmIsPrompt;
  confirmResolve = null;
  confirmIsPrompt = false;
  if (!resolve) return;
  if (isPrompt) {
    const value = $<HTMLInputElement>("#confirmInput").value.trim();
    resolve(ok ? value : null);
  } else {
    resolve(ok);
  }
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
    [...openStats].sort().join(",") +
    "|" +
    JSON.stringify(filters)
  );
}

/** Re-read controller state and re-render if anything visible changed. */
function applyState(): void {
  STATE = controller.state();
  if (stateSig() === lastSig) return;
  render();
}

/** Run a controller action, surfacing errors to a persistent error card. */
function run(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    pushError("Action failed", err instanceof Error ? err.message : String(err));
  }
}

function doScan(): void {
  // Beeline has no time-window scan — "Re-sync" always pulls the whole history.
  // When signed out (cached-rides mode), this prompts for the password first, then
  // runs the sync once authenticated (see withBeelineAccess).
  if (beelineMode()) {
    withBeelineAccess(() => run(() => controller.scan("all", null)));
    return;
  }
  const days = parseInt(($("#days") as HTMLInputElement).value, 10);
  if (days > 0) {
    run(() => controller.scan("custom", days));
    return;
  }
  run(() => controller.scan(preset, null));
}

// --------------------------------------------------------------------------- //
// Import / export
// --------------------------------------------------------------------------- //
function exportRides(): void {
  // Stamp the producing build into the downloaded file (the persisted cache never
  // carries this) so an exported state records which app version wrote it.
  const meta = {
    app: {
      version: __APP_VERSION__,
      commit: __APP_COMMIT__,
      build_date: __APP_BUILD_DATE__,
    },
  };
  const blob = new Blob([controller.exportJson(meta)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "beeline-toolkit-state.json";
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser "Save As" for a GPX file of one ride's route. */
function saveGpxFile(file: {
  filename: string;
  downloadName: string;
  bytes: Uint8Array;
}): void {
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
      const e = err as Error;
      // Log full context to devtools — the toast is space-constrained, so dump the
      // whole error (with its stack) plus the state that most often explains a
      // failure here: whether a controller was even wired up yet (imports during
      // the boot/mode-switch window hit an undefined controller), the mode, and
      // the file we tried to read.
      console.error("[importRides] import failed", {
        error: e,
        name: e?.name,
        message: e?.message,
        controllerReady: controller != null,
        isDemo,
        file: { name: file.name, size: file.size, type: file.type },
        resultLength: typeof reader.result === "string" ? reader.result.length : null,
      });
      const label = e?.name ? `${e.name} — ${e.message}` : e?.message;
      pushError("Import failed", e?.stack || label || "unknown import error");
    }
  };
  reader.onerror = () => {
    // A failed *read* (vs. parse) would otherwise be silent — no onload, no catch.
    console.error("[importRides] file read failed", {
      error: reader.error,
      name: reader.error?.name,
      message: reader.error?.message,
      file: { name: file.name, size: file.size, type: file.type },
    });
    pushError(
      "Couldn't read file",
      `${file.name}: ${reader.error?.message ?? "unknown read error"}`,
    );
  };
  reader.readAsText(file);
}

/**
 * Erase every trace of local state: the ride cache + settings and the queued
 * jobs — then return to the source picker. Browser-only; nothing in your Beeline
 * account is touched. Guarded by a single confirm().
 */
async function resetEverything(): Promise<void> {
  if (
    !confirm(
      "Erase all locally stored rides and settings? This cannot be undone and returns you to the source-selection screen.",
    )
  ) {
    return;
  }
  controller.reset(); // clear the active controller's cache (IndexedDB) + job queue
  forgetProfile(); // forget the chosen source so the picker leads next time
  await goBeelineOffline(); // rebuild a fresh controller over the now-empty cache
  showPicker(); // start fresh: let the user pick a source again
  toast("Local data cleared.");
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target && target.tagName === "INPUT") return; // checkboxes handled on 'change'
  const t = (target.closest("button, a, .mhead, .yhead") as HTMLElement) || target;

  // Source picker actions (modal): handle before anything else.
  if (t.id === "btnDemoBeeline") {
    hidePicker();
    return void goDemoBeeline();
  }
  if (t.id === "btnPickDismiss") {
    hidePicker();
    return;
  }
  if (t.id === "btnPickClose") {
    hidePicker();
    return;
  }
  // Click on the picker backdrop (outside the card) dismisses it.
  if (target.id === "srcPick") {
    hidePicker();
    return;
  }

  // Full-screen single-ride route map: open from a mini-map's expand button, close
  // from its bar button or by clicking the backdrop outside the canvas.
  if (t.dataset?.expand) {
    return openRideMap(t.dataset.expand);
  }
  if (t.id === "btnRideMapFull") {
    return fetchRideMapFull();
  }
  if (t.dataset?.color && t.closest("#rideMapColor")) {
    return setRideMapColor(t.dataset.color as "none" | "height" | "speed");
  }
  if (t.id === "btnRideMapProfile") {
    return toggleRideMapProfile();
  }
  if (t.id === "btnRideMapClose" || target.id === "rideMapModal") {
    return closeRideMap();
  }

  // Split-button: toggle its dropdown. Any click outside an open menu closes it.
  if (t.dataset?.splitmenu) {
    openMenu = openMenu === t.dataset.splitmenu ? null : t.dataset.splitmenu;
    render();
    return;
  }
  // Picking any real action from an open mobile "⋯" overflow menu dismisses it
  // (the subsequent dispatch re-renders with the menu closed). The nested Check/
  // GPX split buttons live inside `.split`, so the generic guard below would skip
  // them — close here so every entry behaves the same.
  if (openMenu?.startsWith("ovr-") && t.dataset?.act) {
    openMenu = null;
  }
  // The Data and Selected menus' entries live inside `.split`, so the outside-click
  // guard below skips them — dismiss the open menu here once one of its items is picked.
  if ((openMenu === "state" || openMenu === "sel") && target.closest("#stateMenu, #selMenu")) {
    openMenu = null;
    render();
    // fall through so the click still triggers the chosen action
  }
  if (
    openMenu !== null &&
    !target.closest(".split, .yactions.open, .mactions.open, .rbtns.open")
  ) {
    openMenu = null;
    render();
    // fall through so this same click can still trigger whatever it landed on
  }

  if (t.dataset?.view) {
    setView(t.dataset.view as ViewName);
    return;
  }
  if (t.id === "btnMapExpand") {
    setMapExpanded(!document.body.classList.contains("map-expanded"));
    return;
  }
  if (t.id === "btnHeatExpand") {
    setHeatExpanded(!document.body.classList.contains("heat-expanded"));
    return;
  }
  if (t.id === "btnMapSelect") {
    mapAreaSelect.setMode(!mapAreaSelect.isArmed());
    return;
  }
  if (t.id === "btnHeatSelect") {
    heatAreaSelect.setMode(!heatAreaSelect.isArmed());
    return;
  }
  if (t.dataset?.rangereset) {
    resetRange(t.dataset.rangereset as RangeView);
    return;
  }
  if (t.dataset?.fstatus) {
    filters.status = t.dataset.fstatus as Filters["status"];
    saveFilters();
    applyState();
    return;
  }
  // Mobile: the "Filters" toggle expands/collapses the otherwise space-hungry
  // filter bar. Ephemeral view state, so flip the class directly (the filter bar
  // is static markup that syncFilterBar mutates in place, never rebuilds) rather
  // than routing through render().
  if (t.id === "fToggle") {
    const open = document.getElementById("filterbar")?.classList.toggle("open");
    t.setAttribute("aria-expanded", open ? "true" : "false");
    return;
  }
  if (t.dataset?.fchip) {
    cycleChip(t.dataset.fchip);
    saveFilters();
    applyState();
    return;
  }
  if (t.id === "fClear" || t.id === "emptyClear") {
    e.preventDefault();
    clearFilters();
    saveFilters();
    applyState();
    return;
  }
  if (t.dataset?.preset) {
    preset = t.dataset.preset;
    ($("#days") as HTMLInputElement).value = "";
    syncDaysField();
    document.querySelectorAll<HTMLButtonElement>("#presets button").forEach((b) => {
      b.classList.toggle("active", b.dataset.preset === preset);
    });
    return;
  }
  if (t.dataset?.gran) {
    statGran = t.dataset.gran as Granularity | "auto";
    document.querySelectorAll<HTMLButtonElement>("#statGran button").forEach((b) => {
      b.classList.toggle("active", b.dataset.gran === statGran);
    });
    render();
    return;
  }
  if (t.dataset?.metric) {
    statMetric = t.dataset.metric as "distance" | "speed";
    document.querySelectorAll<HTMLButtonElement>("#statMetric button").forEach((b) => {
      b.classList.toggle("active", b.dataset.metric === statMetric);
    });
    render();
    return;
  }
  if (t.id === "btnSource") return showPicker();
  // The disconnect slot only shows for an offline Beeline session, where it's a
  // "Sign in" shortcut to the focused re-auth prompt (connected/demo hide it; the
  // password is never stored so there's no "Sign out" — refresh/"Change source"
  // handle leaving).
  if (t.id === "btnDisconnect") return showPicker({ reauth: true });
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
  if (t.dataset?.cancel) {
    return run(() => controller.cancel(parseInt(t.dataset.cancel!, 10)));
  }
  if (t.dataset && "errDismiss" in t.dataset) {
    const card = t.closest(".errcard") as HTMLElement | null;
    if (card?.dataset.id) dismissedErrIds.add(card.dataset.id);
    renderError(STATE.jobs);
    return;
  }
  if (t.dataset && "errDetails" in t.dataset) {
    const card = t.closest(".errcard") as HTMLElement | null;
    card?.querySelector(".errfull")?.classList.toggle("show");
    return;
  }
  if (t.id === "selClear") {
    selected.clear();
    render();
    return;
  }
  if (t.id === "btnGpxSaveSel") {
    openMenu = null;
    if (!selected.size) return toast("Select some rides first.");
    return run(() => controller.downloadGpx([...selected]));
  }
  if (t.id === "btnGpxSaveSelFull") {
    openMenu = null;
    if (!selected.size) return toast("Select some rides first.");
    const keys = [...selected];
    return withGpxRelayConsent(() =>
      withBeelineAccess(() => run(() => controller.downloadGpx(keys, "", "full"))),
    );
  }
  if (t.id === "btnUploadSel") {
    if (!selected.size) return toast("Select some rides first.");
    const keys = [...selected].filter(
      (k) => STATE.rides.find((r) => r.key === k)?.status !== "uploaded",
    );
    if (!keys.length) return toast("All selected rides are already uploaded to Strava.");
    return withBeelineAccess(() => run(() => controller.upload(keys)));
  }
  if (t.id === "btnUploadPending") {
    const keys = STATE.rides
      .filter((r) => r.status === "pending" && !r.deleted)
      .map((r) => r.key);
    if (!keys.length) return toast("No known pending rides.");
    void (async () => {
      const ok = await confirmDialog({
        title: "Upload all to Strava?",
        body: `This will upload ${keys.length} pending ride${
          keys.length === 1 ? "" : "s"
        } to Strava. Already-uploaded rides are skipped.`,
        confirmLabel: "Upload all",
      });
      if (ok) withBeelineAccess(() => run(() => controller.upload(keys)));
    })();
    return;
  }

  const act = t.dataset?.act;
  if (act === "gpx-save-one") {
    openMenu = null;
    return run(() => controller.downloadGpx([t.dataset.key!]));
  }
  if (act === "gpx-save-full-one") {
    openMenu = null;
    const key = t.dataset.key!;
    return withGpxRelayConsent(() =>
      withBeelineAccess(() => run(() => controller.downloadGpx([key], "", "full"))),
    );
  }
  if (act === "upload-one") {
    const ride = STATE.rides.find((r) => r.key === t.dataset.key);
    if (ride && ride.status === "uploaded") return toast("Already uploaded to Strava.");
    return withBeelineAccess(() => run(() => controller.upload([t.dataset.key!])));
  }
  if (act === "rename-one") {
    const key = t.dataset.key!;
    openMenu = null;
    render();
    const ride = STATE.rides.find((r) => r.key === key);
    if (!ride) return;
    void (async () => {
      const newName = await promptDialog({
        title: "Rename ride",
        body: `New name for ${rideShortLabel(key) || key}:`,
        value: ride.title || "",
        confirmLabel: "Rename",
      });
      if (newName === null) return; // cancelled
      if (newName === "") return toast("Ride name can't be empty.", true);
      if (newName === (ride.title || "")) return; // unchanged
      withBeelineAccess(() => run(() => controller.rename(key, newName)));
    })();
    return;
  }
  if (act === "delete-one") {
    const key = t.dataset.key!;
    openMenu = null;
    render();
    const ride = STATE.rides.find((r) => r.key === key);
    if (!ride) return;
    void (async () => {
      const ok = await confirmDialog({
        title: "Delete ride?",
        body:
          `Permanently delete “${ride.title || "Ride"}” (${rideShortLabel(key) || key}) ` +
          `from your Beeline account? This can't be undone. It stays listed here, marked as deleted.`,
        confirmLabel: "Delete",
      });
      if (ok) withBeelineAccess(() => run(() => controller.deleteRide(key)));
    })();
    return;
  }
  if (act === "upload-month") {
    const keys = pendingOfMonth(t.dataset.m!);
    if (!keys.length) return toast("No known pending rides this month.");
    return withBeelineAccess(() => run(() => controller.upload(keys)));
  }
  if (act === "upload-year") {
    const keys = pendingOfYear(t.dataset.y!);
    if (!keys.length) return toast("No known pending rides this year.");
    return withBeelineAccess(() => run(() => controller.upload(keys)));
  }

  if (t.dataset?.stats) {
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
    if (rrow?.dataset.key) {
      const k = rrow.dataset.key;
      openStats.has(k) ? openStats.delete(k) : openStats.add(k);
      render();
      return;
    }
  }

  const yhead = t.classList?.contains("yhead")
    ? t
    : t.closest && (t.closest(".yhead") as HTMLElement | null);
  if (yhead) {
    const c = `c${yhead.dataset.y}`;
    openYears.has(c) ? openYears.delete(c) : openYears.add(c);
    render();
    return;
  }

  const mhead = t.classList?.contains("mhead")
    ? t
    : t.closest && (t.closest(".mhead") as HTMLElement | null);
  if (mhead) {
    const m = mhead.dataset.m!;
    openMonths.has(m) ? openMonths.delete(m) : openMonths.add(m);
    render();
  }
});

// Escape closes an open split-button menu (GPX or Check), or the source picker.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const confirmM = document.getElementById("confirmModal");
  if (confirmM && !confirmM.classList.contains("hidden")) {
    closeConfirm(false);
    return;
  }
  const picker = document.getElementById("srcPick");
  if (picker && !picker.classList.contains("hidden")) {
    hidePicker();
    return;
  }
  if (openMenu !== null) {
    openMenu = null;
    render();
  }
});

// Beeline sign-in form in the source picker.
document.getElementById("beelineForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = ($("#beelineEmail") as HTMLInputElement).value.trim();
  const password = ($("#beelinePass") as HTMLInputElement).value;
  if (!email || !password) {
    setBeelineError("Enter your Beeline email and password.");
    return;
  }
  const btn = $<HTMLButtonElement>("#btnBeelineSignIn");
  btn.disabled = true;
  setBeelineError("");
  void goBeeline(email, password).finally(() => {
    btn.disabled = false;
    // Clear the password field whether or not sign-in succeeded.
    ($("#beelinePass") as HTMLInputElement).value = "";
  });
});

// Tap the toast to dismiss it immediately (handy for the longer-lived error toast).
document.getElementById("toast")?.addEventListener("click", dismissToast);

// Styled confirm dialog: OK / Cancel, and a backdrop click counts as cancel.
document.getElementById("confirmOk")?.addEventListener("click", () => closeConfirm(true));
document.getElementById("confirmCancel")?.addEventListener("click", () => closeConfirm(false));
document.getElementById("confirmModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeConfirm(false);
});
// Enter in the prompt input accepts (Escape is handled by the global keydown).
document.getElementById("confirmInput")?.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") {
    e.preventDefault();
    closeConfirm(true);
  }
});

document.addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (cb.classList?.contains("chk")) {
    cb.checked ? selected.add(cb.dataset.key!) : selected.delete(cb.dataset.key!);
    render();
    return;
  }
  if (cb.dataset?.selmonth) {
    toggleGroup(keysOfMonth(cb.dataset.selmonth));
    return;
  }
  if (cb.dataset?.selyear) {
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
  if (cb.id === "fDevice") {
    filters.device = cb.value;
    saveFilters();
    applyState();
  }
});

// Drag the selected range window (between the two thumbs) to slide it as a whole.
document.addEventListener("pointerdown", (e) => {
  const win = (e.target as HTMLElement).closest?.<HTMLElement>(".rf-window");
  const which = win?.dataset.rangewin;
  if (win && (which === "map" || which === "stats")) onWindowDrag(which, win, e);
});

// Live outlier-trim sliders: update labels and recompute the speed view as they move.
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "fDistMin" || el.id === "fDistMax") {
    const v = el.value.trim() === "" ? null : Number(el.value);
    const km = v !== null && Number.isFinite(v) && v >= 0 ? v : null;
    if (el.id === "fDistMin") filters.distMin = km;
    else filters.distMax = km;
    saveFilters();
    applyState();
    return;
  }
  if (el.dataset.range === "map" || el.dataset.range === "stats") {
    onRangeInput(el.dataset.range as RangeView, el);
    return;
  }
  if (el.id === "heatRadius") {
    const v = parseInt(el.value, 10) || 12;
    ($("#heatRadiusOut") as HTMLOutputElement).value = String(v);
    run(() => controller.setHeatRadius(v));
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
  if (v)
    document.querySelectorAll<HTMLButtonElement>("#presets button").forEach((b) => {
      b.classList.remove("active");
    });
}

$("#days").addEventListener("input", syncDaysField);
syncDaysField();

// Elevation profile ↔ route map sync: hovering the full-screen ride map's profile
// strip lights up the matching point on the route above it (and the readout). The
// host persists in the DOM across opens, so wire it once here; the SVG inside is
// re-rendered per ride but pointer events still bubble to the host.
const rideProfileEl = document.getElementById("rideMapProfile");
if (rideProfileEl) {
  rideProfileEl.addEventListener("pointermove", onRideProfileHover);
  rideProfileEl.addEventListener("pointerleave", clearRideTrackPoint);
}

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
      setSelected([]);
      return;
    }
    const item = target.closest(".ms-item") as HTMLElement | null;
    if (item?.dataset.key) openRideInExplore(item.dataset.key);
  });
}

// The heatmap's "Selected" list: hover a ride to trace its route on the heatmap,
// click to open it in Explore, or Clear to drop the selection.
const heatMatchedEl = document.getElementById("heatMatched");
if (heatMatchedEl) {
  heatMatchedEl.addEventListener("mouseover", (e) => {
    const item = (e.target as HTMLElement).closest(".ms-item") as HTMLElement | null;
    if (item?.dataset.key) showHeatHover(item.dataset.key);
  });
  heatMatchedEl.addEventListener("mouseleave", () => clearHeatHover());
  heatMatchedEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ms-clear")) {
      heatSelectedKeys = [];
      renderHeatMatched();
      return;
    }
    const item = target.closest(".ms-item") as HTMLElement | null;
    if (item?.dataset.key) openRideInExplore(item.dataset.key);
  });
}

// Warn before leaving while a sync/upload is in progress — closing/reloading the tab
// kills the in-browser worker, abandoning the running task and anything queued.
window.addEventListener("beforeunload", (e) => {
  const jobs = controller?.state().jobs;
  if (jobs?.busy) {
    e.preventDefault();
    e.returnValue = ""; // required for Chromium to show the native confirm dialog
  }
});

// Esc leaves the full-screen map or heatmap.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("rideMapModal")?.classList.contains("hidden")) {
    closeRideMap();
    return;
  }
  if (document.body.classList.contains("map-expanded")) setMapExpanded(false);
  if (document.body.classList.contains("heat-expanded")) setHeatExpanded(false);
});

/** Show the build version in the header + source picker; hover reveals commit + build date. */
function showVersion(): void {
  const hasCommit = __APP_COMMIT__ && __APP_COMMIT__ !== "unknown";
  const label = `v${__APP_VERSION__}${hasCommit ? `+${__APP_COMMIT__}` : ""}`;
  const title = `commit ${__APP_COMMIT__} · built ${__APP_BUILD_DATE__}`;
  for (const id of ["appVer", "pickVer"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = label;
    el.title = title;
  }
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

// Keep the floating job pill/handle clear of browser chrome that overlays the
// bottom of the layout viewport — chiefly Chrome on Android's retractable
// address bar (and the on-screen keyboard). The visual viewport shrinks from the
// bottom when that chrome is shown; we publish that gap as `--vv-bottom` so the
// pill's `bottom` can lift by exactly that much (see .job / .job-handle in CSS).
function trackViewportInset(): void {
  const vv = window.visualViewport;
  if (!vv) return; // unsupported: CSS falls back to env(safe-area-inset-bottom)
  const update = () => {
    const gap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    document.documentElement.style.setProperty("--vv-bottom", `${Math.round(gap)}px`);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}
trackViewportInset();

// Boot: pick the right starting mode. Either way we open over the cached Beeline
// rides (we never store the password, so we can't silently re-sign-in):
//  - A remembered Beeline account lands straight on its cached rides;
//    "Change source"/"Re-sync" lead to sign-in.
//  - Otherwise (no profile) we also show the source picker on top.
void goBeelineOffline().then(() => {
  if (rememberedProfile() !== "beeline") showPicker();
});
