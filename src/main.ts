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
  rideShortLabel,
  trimmedSpeed,
} from "./parsing";
import { computeStats, type PeriodRecord } from "./stats";
import "leaflet.heat";
import { drawWindSpeedChart } from "./windchart";
import {
  linearRegression,
  segmentRide,
  type SegmentOpts,
  speedCapIndices,
  type WindSeg,
} from "./windspeed";
import { DEMO_BEELINE_EMAIL, demoBeelineDeps } from "./beeline-demo";
import { BeelineError } from "./beeline-api";
import { BeelineRideSource, type BeelineSourceDeps } from "./beeline-source";
import { GpxRideSource } from "./gpx-source";
import { GpxCache } from "./gpxcache";
import {
  idbBackend,
  idbBlobBackend,
  idbLocationBlobBackend,
  idbWindBlobBackend,
  memoryBackend,
} from "./kv";
import { parseLocationHistory } from "./loc-parse";
import { LocationHistoryStore } from "./loc-store";
import {
  closeTimelineHelp,
  collapseTimeline,
  initTimelineView,
  isTimelineExpanded,
  isTimelineHelpOpen,
  leaveTimelineView,
  mountTimelineView,
  resetTimelineData,
} from "./timeline-view";
import { createLocate, type Locate } from "./locate";
import type { SourceFactory } from "./source";
import { type RideSource, STORAGE_KEY, Store } from "./store";
import { decodePolyline } from "./track";
import { WindCache } from "./windcache";
import {
  closeRideMap,
  enableRideMapWind,
  fetchRideMapFull,
  initRideMap,
  openRideMap,
  refreshOpenRideMapWind,
  setRideMapColor,
  setRideMapProfileAxis,
  setRideMapProfileMetric,
  toggleRideMapProfile,
  toggleRideMapWind,
} from "./ridemap";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

// --------------------------------------------------------------------------- //
// Controller wiring (Beeline cloud account, with an account-free demo)
// --------------------------------------------------------------------------- //

/** Durable ride-cache storage. One IndexedDB connection shared by every controller. */
const storageBackend = idbBackend();
/** Durable binary backend for the compressed full-GPX cache (own `gpx` object store). */
const gpxBlobBackend = idbBlobBackend();
const windBlobBackend = idbWindBlobBackend();
/** Durable binary backend for imported Google Location History (own `location-history`
 *  object store — separate bucket, independently droppable). */
const locationBlobBackend = idbLocationBlobBackend();
/** Surface a background-write failure (e.g. quota exceeded) to the user. */
const onStorageError = (message: string): void => pushError("Storage error", message);

let controller!: Controller;
// Starts false so the first paint matches the offline boot; activate() sets the
// real value once a controller is wired up. `isDemo` is the Beeline simulated account.
let isDemo = false;
let unsubscribe: (() => void) | null = null;
let unsubscribeGpx: (() => void) | null = null;

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

// First-launch onboarding: show the Sources dialog (with the welcome intro) exactly
// ONCE — on the first-ever launch — then never auto-open it again. Set when first
// shown so a returning user lands straight in the app.
const WELCOMED_KEY = "gpx_toolkit.welcomed";
const hasBeenWelcomed = (): boolean => {
  try {
    return localStorage.getItem(WELCOMED_KEY) === "1";
  } catch {
    return false;
  }
};
const markWelcomed = (): void => {
  try {
    localStorage.setItem(WELCOMED_KEY, "1");
  } catch {
    /* non-fatal */
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

function activate(next: Controller, demo: boolean): void {
  if (unsubscribe) unsubscribe();
  if (unsubscribeGpx) unsubscribeGpx();
  controller = next;
  isDemo = demo;
  unsubscribe = controller.onChange(applyState);
  unsubscribeGpx = controller.onGpx(saveGpxFile);
  applyState();
}

// -- sources dialog ---------------------------------------------------------

// A cloud action deferred until the user (re)authenticates to Beeline. Set when a
// signed-out Beeline session triggers something needing the account (Re-sync,
// upload); run once sign-in succeeds, then cleared.
let afterBeelineSignIn: (() => void) | null = null;

/**
 * Show the Sources dialog (connect/manage data sources), prefilling the remembered
 * Beeline email if any. In `reauth` mode it focuses the Beeline sign-in (the user
 * already has a profile and just needs to re-enter the password — which a password
 * manager can inject). In `welcome` mode it leads with the onboarding intro.
 */
function showSources(opts: { reauth?: boolean; welcome?: boolean } = {}): void {
  const picker = document.getElementById("srcPick");
  if (!picker) return;
  const reauth = opts.reauth === true;
  picker.classList.toggle("reauth", reauth);
  picker.classList.toggle("welcome", opts.welcome === true);

  const email = rememberedEmail();
  const emailInput = document.getElementById("beelineEmail") as HTMLInputElement | null;
  if (email && emailInput && !emailInput.value) emailInput.value = email;

  const sub = picker.querySelector(".srcpick-sub");
  if (sub) {
    sub.textContent = reauth
      ? "Sign in to your Beeline account to sync."
      : "Connect the sources your rides come from. They all live together in one library.";
  }
  renderSources();

  setBeelineError("");
  picker.classList.remove("hidden");
  if (reauth) {
    const pass = document.getElementById("beelinePass") as HTMLInputElement | null;
    pass?.focus();
  }
}

function hideSources(): void {
  const picker = document.getElementById("srcPick");
  picker?.classList.add("hidden");
  picker?.classList.remove("reauth", "welcome");
  // Dismissing the prompt abandons any action that was waiting on sign-in.
  afterBeelineSignIn = null;
}

/** Open the Settings dialog, syncing each control to the persisted setting. */
function showSettings(): void {
  const modal = document.getElementById("settingsModal");
  if (!modal) return;
  const thresh = STATE.settings.movingThresholdKmh;
  const slider = document.getElementById("setMovingThresh") as HTMLInputElement | null;
  if (slider) slider.value = String(thresh);
  const out = document.getElementById("setMovingThreshOut") as HTMLOutputElement | null;
  if (out) out.value = `${thresh} km/h`;
  modal.classList.remove("hidden");
}

function hideSettings(): void {
  document.getElementById("settingsModal")?.classList.add("hidden");
}

function setBeelineError(message: string): void {
  const el = document.getElementById("beelineErr");
  if (el) el.textContent = message;
}

/**
 * Populate the Beeline card in the Sources dialog from the live connection state:
 * when connected (or demo) it shows "Connected as …" + the per-source actions
 * (Pull from Beeline / Disconnect); otherwise the sign-in form. Driven by the
 * Controller's state, so it stays correct as the connection changes while open.
 */
function renderSources(): void {
  const card = document.getElementById("srcBeeline");
  if (!card) return;
  const connected = STATE.connected || isDemo;
  card.classList.toggle("connected", connected);
  const status = document.getElementById("beelineStatus");
  if (status) {
    status.textContent = connected
      ? isDemo
        ? "Connected — demo account"
        : `Connected — ${STATE.device || "Beeline account"}`
      : "";
  }
}

/**
 * Run an action that needs a live Beeline connection. When signed out (the offline,
 * cached-rides state — we never store the password), defer the action and open the
 * Sources dialog focused on sign-in so a password manager can inject it; the action
 * runs once sign-in succeeds. When already connected (or in the demo) it runs now.
 */
function withBeelineAccess(action: () => void): void {
  if (!STATE.connected && !isDemo) {
    afterBeelineSignIn = action;
    showSources({ reauth: true });
    return;
  }
  action();
}

/**
 * Run a per-ride mutation (rename / delete) with exactly the access its source needs.
 * A Beeline-backed ride is changed on the cloud account, so it goes through the
 * re-auth gate (a signed-out user is asked to sign in first); a local source (an
 * imported GPX) is changed entirely in the browser, so it runs straight away and must
 * NEVER trip the Beeline sign-in prompt. Gate on the ride's own source, not a global
 * mode, so a GPX ride behaves the same whether or not Beeline is also connected.
 */
function withRideAccess(source: RideSource, action: () => void): void {
  if (source === "beeline") withBeelineAccess(action);
  else action();
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

/**
 * Run a full-track GPX download for the given rides. When EVERY requested ride is
 * already in the on-disk GPX cache, the bytes are served locally — so we skip both
 * the export-gateway consent and the Beeline re-auth prompt and run straight away
 * (a genuine offline re-save). Otherwise at least one ride must be fetched, so we
 * gate on consent + a live connection as before.
 */
function saveFullGpx(keys: string[]): void {
  const cached = controller.gpxCachedKeys();
  const allCached = keys.length > 0 && keys.every((k) => cached.has(k));
  if (allCached) {
    run(() => controller.downloadGpx(keys, "", "full"));
    return;
  }
  withGpxRelayConsent(() =>
    withBeelineAccess(() => run(() => controller.downloadGpx(keys, "", "full"))),
  );
}

/**
 * Fetch the full-track GPX for the given rides into the local cache WITHOUT saving
 * any file (pre-warms offline use + each ride's real time/elevation map). Always a
 * cloud fetch, so it gates on the export-gateway consent + a live Beeline
 * connection. Rides already cached need no fetch — when every requested ride is
 * already cached we just say so instead of spinning up an empty sweep.
 */
function fetchFullGpx(keys: string[]): void {
  if (!keys.length) return;
  const cached = controller.gpxCachedKeys();
  const missing = keys.filter((k) => !cached.has(k));
  if (!missing.length) {
    toast(
      keys.length === 1
        ? "Full GPX already cached for this ride."
        : "Full GPX already cached for all selected rides.",
    );
    return;
  }
  withGpxRelayConsent(() =>
    withBeelineAccess(() => run(() => controller.fetchFullGpx(missing))),
  );
}

/**
 * Explicitly resolve historical wind for the given rides (the deliberate user
 * action — per-ride or over a selection). Cache-first per cell, so already-resolved
 * or overlapping rides cost little or nothing; one coalesced background job covers
 * all of them. No Beeline account or gateway needed — Open-Meteo is keyless and
 * CORS-friendly. `force` re-resolves rides that already have wind.
 */
function resolveWindFor(keys: string[], force = false): void {
  if (!keys.length) return;
  const n = controller.resolveWind(keys, force);
  if (n === 0) {
    toast(
      force
        ? "Nothing to resolve."
        : keys.length === 1
          ? "Wind is already resolved for this ride."
          : "Wind is already resolved for all selected rides.",
    );
    return;
  }
  toast(
    n === 1 ? "Resolving wind for 1 ride…" : `Resolving wind for ${n} rides…`,
  );
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
 * Feedback hook for the source's silent session renewal. The Beeline id token lives
 * ~1h; the source renews it transparently from the refresh token when it nears expiry
 * or is rejected mid-action, so a long batch never breaks. We only surface the failure
 * case: when the refresh token itself is rejected (revoked / signed out elsewhere) we
 * drop the connection so the next account action re-prompts for the password via
 * `withBeelineAccess`. A successful renewal is intentionally silent.
 */
function beelineRenewDeps(c: Controller): BeelineSourceDeps {
  return {
    onRenew: (phase) => {
      if (phase === "renewing") {
        toast("Renewing Beeline session…");
        return;
      }
      if (phase !== "failed") return;
      void c.disconnect();
      pushError(
        "Beeline session expired",
        "Your Beeline session couldn't be renewed automatically. Sign in again to continue uploading or syncing — your cached rides stay on screen.",
      );
    },
  };
}

/**
 * Beeline demo: a simulated cloud account exercising the Beeline mechanics —
 * one-shot history download and server-side Strava uploads observed by polling.
 */
async function goDemoBeeline(): Promise<void> {
  const store = new Store(memoryBackend());
  const factory = beelineSourceFactory(DEMO_BEELINE_EMAIL, "demo", store, demoBeelineDeps());
  const gpxCache = GpxCache.memory();
  const gpxData = GpxCache.memory();
  const c = new Controller(factory, store, gpxCache, gpxData);
  c.registerSource(new GpxRideSource(gpxData, () => store.settings.trackPointsPerKm));
  activate(c, true);
  try {
    await c.connect();
    toast("Demo (Beeline) — a simulated cloud account. Open Sources to leave.");
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
  const c = await getRealController();
  activate(c, false); // show cached rides immediately
  try {
    // Connect with a fresh factory carrying these credentials (registers the Beeline
    // source onto the shared controller alongside any imported GPX rides).
    await c.connect(beelineSourceFactory(email, password, c.store, beelineRenewDeps(c)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBeelineError(msg);
    // A credentials rejection (wrong email/password) is the user's to fix right here
    // in the form — show the inline message only. Don't remember the (possibly wrong)
    // email as the connected profile, and don't push the "you're offline, showing
    // cached rides" card, which would be misleading. A real network/outage failure,
    // by contrast, keeps cached rides on screen and explains the stale state.
    const isAuthRejection = err instanceof BeelineError && err.kind === "expired";
    if (!isAuthRejection) {
      rememberProfile("beeline", email);
      pushError(
        "Can't reach your Beeline account",
        `${msg}\n\nShowing your last downloaded rides. Use “Change source” to sign in again and re-sync once you're back online.`,
      );
    }
    return false;
  }
  rememberProfile("beeline", email);
  // Capture any action that was waiting on sign-in BEFORE hideSources() clears it.
  const pending = afterBeelineSignIn;
  hideSources();
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
 * Open the app over the unified cache without a live account connection (e.g. on
 * reload — we never store the password, so we can't silently re-sign-in). The GPX
 * source is already registered, so imported rides remain usable; any action needing
 * the Beeline account (Pull from Beeline, upload) prompts for the password via
 * `withBeelineAccess`.
 */
async function openApp(): Promise<void> {
  const c = await getRealController();
  activate(c, false);
  // Load the location-history catalog in the background; refresh once ready so the
  // Timeline tab and the Data-menu storage breakdown reflect any imported data.
  void ensureLocStore().then(() => {
    if (activeView === "timeline") mountTimelineView();
    render();
  });
}

/** Pull the whole ride history from the connected Beeline account (the one
 *  Beeline-specific data action). Prompts for sign-in first when signed out. */
function pullFromBeeline(): void {
  withBeelineAccess(() => run(() => controller.scan("all", null)));
}

// --------------------------------------------------------------------------- //
// Shared multi-source controller (Beeline account + imported GPX coexist)
// --------------------------------------------------------------------------- //

/** The one persistent, real (non-demo) controller. Holds the unified ride cache and
 *  a source registry: the GPX import source is always registered; Beeline connects
 *  on sign-in. Reused across sign-in/out so imported rides + cache survive. */
let realController: Controller | null = null;

/** Unified ride-state key — all sources' rides coexist here (each tagged `source`). */
const UNIFIED_STORAGE_KEY = `${STORAGE_KEY}:all`;
/**
 * GPX blob namespaces — kept physically separate (Android's data-vs-cache split):
 *  - `cache`: re-fetchable full-GPX downloads (Beeline). Safe to flush; re-downloads.
 *  - `data` : imported GPX originals — the ONLY copy, primary state. Never flushed by
 *             a cache clear; removed only on ride delete or a full reset.
 * Keys within each carry the cross-source ride uid.
 */
const GPX_CACHE_PREFIX = "cache";
const GPX_DATA_PREFIX = "data";

/** Build (once) the shared real controller with the GPX source pre-registered. */
async function getRealController(): Promise<Controller> {
  if (realController) return realController;
  const store = await Store.load(storageBackend, onStorageError, UNIFIED_STORAGE_KEY);
  // Two physically separate GPX blob stores: a re-fetchable cache (Beeline) and the
  // imported-GPX data vault (primary state). A cache flush can only touch the former.
  const gpxCache = await GpxCache.load(gpxBlobBackend, GPX_CACHE_PREFIX, onStorageError);
  const gpxData = await GpxCache.load(gpxBlobBackend, GPX_DATA_PREFIX, onStorageError);
  const windCache = await WindCache.load(windBlobBackend, onStorageError);
  const c = new Controller(
    async () => {
      throw new Error("Not signed in — sign in to Beeline to sync.");
    },
    store,
    gpxCache,
    gpxData,
    windCache,
  );
  c.registerSource(new GpxRideSource(gpxData, () => store.settings.trackPointsPerKm));
  realController = c;
  return c;
}

/**
 * Import user-supplied GPX files (and/or .zip bundles) into the unified cache. Adds
 * `gpx`-source rides that coexist with Beeline's; never needs an account.
 */
function importGpxFiles(files: File[]): void {
  if (!files.length) return;
  void getRealController().then((c) => {
    if (controller !== c) activate(c, false);
    hideSources();
    run(() => c.importGpx(files));
  });
}

/** Open the hidden GPX file picker (multi-select .gpx / .zip). */
function openGpxFilePicker(): void {
  const input = document.getElementById("gpxFile") as HTMLInputElement | null;
  input?.click();
}

/** Choose the GPX source from the Sources dialog: ensure the app is active and
 *  prompt for files to import. */
function goGpx(): void {
  void getRealController().then((c) => {
    if (controller !== c) activate(c, false);
    openGpxFilePicker();
  });
}

// --------------------------------------------------------------------------- //
// Location History (Timeline) — its own storage bucket, separate from rides
// --------------------------------------------------------------------------- //

/** App-global location-history store (lazy-loaded; separate from any controller). */
let locStore: LocationHistoryStore | null = null;
let locLoading: Promise<LocationHistoryStore> | null = null;

/** Load (once) the location-history store and hydrate its catalog. */
function ensureLocStore(): Promise<LocationHistoryStore> {
  if (locStore) return Promise.resolve(locStore);
  if (!locLoading) {
    locLoading = LocationHistoryStore.load(locationBlobBackend).then((s) => {
      locStore = s;
      return s;
    });
  }
  return locLoading;
}

/** Open the hidden Location-History file picker (single .json export). */
function openLocFilePicker(): void {
  (document.getElementById("locFile") as HTMLInputElement | null)?.click();
}

/**
 * Import a Google Location History export: parse it into the normalized record
 * stream, persist it month-chunked into the dedicated store, and refresh the view.
 * Runs off the main paint via a microtask; surfaces parse/format errors as a toast.
 */
async function importLocationHistory(file: File): Promise<void> {
  const store = await ensureLocStore();
  toast(`Reading ${file.name}\u2026`);
  try {
    const text = await file.text();
    const doc = JSON.parse(text) as unknown;
    const imp = parseLocationHistory(doc, { importedAt: Date.now() });
    if (imp.records.length === 0) {
      toast("No usable location records found in that file.", true);
      return;
    }
    await store.addImport(imp.records, imp.sources);
    if (imp.profile) await store.setProfile(imp.profile);
    const skipped = imp.skipped ? ` (${imp.skipped} unreadable points skipped)` : "";
    toast(`Imported ${imp.records.length.toLocaleString()} location records${skipped}.`);
    resetTimelineData();
    if (activeView === "timeline") mountTimelineView();
    render(); // refresh storage breakdown in the Data menu
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not read that file.";
    pushError("Location History import failed", msg);
    toast(msg, true);
  }
}

/**
 * Drop ALL imported location history — its own bucket only. Rides, Beeline data,
 * imported GPX, wind cache and settings are untouched (and conversely, a GPX/wind
 * flush never touches this). Mirrors the cache-flush confirm/toast pattern.
 */
async function dropLocationHistory(): Promise<void> {
  openMenu = null; // close the Data menu we were invoked from
  const store = await ensureLocStore();
  if (store.isEmpty()) {
    toast("No location history to clear.");
    return;
  }
  const months = store.months().length;
  if (
    !confirm(
      `Delete all imported Location History (${fmtBytes(store.totalBytes())} across ${months} ` +
        `month${months === 1 ? "" : "s"})? Your rides, Beeline data and settings are kept.`,
    )
  ) {
    return;
  }
  await store.clear();
  toast("Location history cleared.");
  resetTimelineData();
  if (activeView === "timeline") mountTimelineView();
  render();
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
    movingThresholdKmh: 1,
  },
  connected: false,
  device: "",
  sources: [],
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
const SOURCE_VALUES: ReadonlyArray<Filters["source"]> = ["all", "beeline", "gpx"];

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
    if (TRI_VALUES.includes(o.cached as TriState)) f.cached = o.cached!;
    if (TRI_VALUES.includes(o.wind as TriState)) f.wind = o.wind!;
    if (TRI_VALUES.includes(o.destination as TriState)) f.destination = o.destination!;
    if (TRI_VALUES.includes(o.named as TriState)) f.named = o.named!;
    if (DELETED_VALUES.includes(o.deleted as Filters["deleted"])) f.deleted = o.deleted!;
    if (SOURCE_VALUES.includes(o.source as Filters["source"])) f.source = o.source!;
    if (typeof o.device === "string") f.device = o.device;
    f.distMin = sanitizeBound(o.distMin);
    f.distMax = sanitizeBound(o.distMax);
    f.windMin = sanitizeBound(o.windMin);
    f.windMax = sanitizeBound(o.windMax);
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
// Which menu is open, if any: a ride key for a per-ride overflow button, or "state"
// for the consolidated header actions menu. Kept at module scope (like openStats/
// selected) so it survives the frequent re-renders the job ticker triggers.
let openMenu: string | null = null;
// Whether the queue panel's "Up next" list is expanded. Module-scope so it
// survives the frequent re-renders the job ticker triggers; starts open so the
// pending work is visible by default.
let queueExpanded = true;
// Whether the user has minimized the live job pill to its small handle. Module-
// scope so it survives the job ticker's re-renders; auto-resets when work ends so
// the next batch shows itself rather than staying hidden silently.
let jobHidden = false;
let statGran: Granularity | "auto" = "auto";
let statMetric: "distance" | "speed" = "distance";
// Persistent error stack. Every error — failed jobs AND standalone connection/
// import/storage errors — is shown as its own card and only disappears when the
// user dismisses it (or, for a job, when that job is re-run and succeeds). We track
// dismissed/already-flashed ids by string so the two error sources share one model.
const dismissedErrIds = new Set<string>();
const shownErrIds = new Set<string>();
// Error cards the user has expanded ("Details"). Kept at module scope so the
// expansion survives the frequent re-renders the job ticker triggers — otherwise
// renderError() rebuilds the stack from scratch and the open panel collapses.
const expandedErrIds = new Set<string>();
interface PushedError {
  id: string;
  title: string;
  full: string;
  ts: number;
}
const pushedErrors: PushedError[] = [];
let errSeq = 0;
let lastSig = "";
/** Tracks the per-ride wind-resolved state applied to the DOM, so a weather-only
 *  change can be detected and patched in place (see applyState/applyWeatherUpdate). */
let lastWeatherSig = "";

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
type ViewName = "explore" | "map" | "stats" | "analytics" | "timeline";
const VIEW_KEY = "beeline_uploader.view";
const readView = (): ViewName => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "map" || v === "stats" || v === "analytics" || v === "timeline"
      ? v
      : "explore";
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
function trackBlock(key: string, track: string, source: RideSource): string {
  // Beeline rides carry the FULL route polyline from the download (the map is the
  // real track, no caveat); an imported GPX ride's displayed line is a simplified
  // sketch of its original, so it gets the "rough approximation" note.
  const rough = source !== "beeline";
  if (!track) {
    return `<div class="rmaphint">No route available for this ride.</div>`;
  }
  return (
    `<div class="rmapwrap">` +
    `<div class="rmap" data-map="${esc(key)}" data-track="${esc(key)}"></div>` +
    `<button class="map-expand rmap-expand" data-expand="${escHtml(key)}" aria-label="Expand route" title="Open this route full-screen (Esc to exit)">` +
    `<svg class="mi mi-expand" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
    `</button>` +
    `</div>` +
    (rough ? `<div class="rmapnote">Rough approximation only — not the full GPX.</div>` : "")
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
    trackBlock(r.key, r.track, r.source)
  );
}

/** (Re)create Leaflet maps for every visible track container after a render.
 *
 * `render()` rebuilds the whole list DOM (`#months` innerHTML wipe) on every
 * list-relevant state change — including each ride starting/finishing during a
 * bulk job, which ticks the status/queue panel. A naive teardown-then-recreate
 * would destroy and remount every mini-map's Leaflet instance on each of those
 * ticks, reloading its tiles → a visible flicker. So instead we RE-ADOPT each
 * already-mounted map: when a fresh `.rmap` placeholder appears for a key we
 * already have a live map for, we move the existing (fully-rendered) Leaflet
 * container into the new slot rather than rebuilding it. Only maps whose ride is
 * no longer present are torn down. */
function mountMaps(): void {
  // Snapshot the current placeholders up front: we mutate the DOM (replaceWith)
  // while iterating, and a static array won't re-visit the elements we swap in.
  const hosts = [...document.querySelectorAll<HTMLElement>(".rmap")];
  const wanted = new Set(hosts.map((h) => h.dataset.map!));

  for (const host of hosts) {
    const key = host.dataset.map!;
    const existing = mapRegistry.get(key);
    if (existing) {
      const el = existing.getContainer();
      if (el === host) continue; // already mounted on this exact node
      // Re-adopt the live map: swap the freshly-rendered placeholder for the
      // existing Leaflet container (its tiles/line/zoom are intact), then nudge
      // Leaflet to re-measure in case the slot's size changed. No flicker.
      host.replaceWith(el);
      existing.invalidateSize();
      continue;
    }
    const ride = STATE.rides.find((r) => esc(r.key) === key);
    if (!ride?.track) continue;
    let pts: [number, number][];
    try {
      pts = decodePolyline(ride.track);
    } catch {
      continue;
    }
    if (pts.length < 2) continue;
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
    mapRegistry.set(key, map);
  }

  // Tear down only maps whose ride is no longer shown (collapsed group, filtered
  // out, deleted) — never the ones we just re-adopted above.
  for (const [k, map] of mapRegistry) {
    if (!wanted.has(k)) {
      map.remove();
      mapRegistry.delete(k);
    }
  }
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
type RangeView = "map" | "stats" | "analytics";
const DAY_MS = 86_400_000;
// Selection is stored as day-start timestamps (local 00:00) for both edges; the
// slider works in whole-day INDICES (0…N) so stepping is exact and DST-safe, and
// the "to" edge always covers its whole day when filtering (see ridesInRange).
let mapRange: DateRange | null = null;
let mapRangeBounds: DateRange | null = null;
let statsRange: DateRange | null = null;
let statsRangeBounds: DateRange | null = null;
let analyticsRange: DateRange | null = null;
let analyticsRangeBounds: DateRange | null = null;

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
  } else if (which === "stats") {
    statsRange = bounds ? reconcileRange(statsRange, statsRangeBounds, bounds) : null;
    statsRangeBounds = bounds;
  } else {
    analyticsRange = bounds
      ? reconcileRange(analyticsRange, analyticsRangeBounds, bounds)
      : null;
    analyticsRangeBounds = bounds;
  }
}

const rangeOf = (which: RangeView): DateRange | null =>
  which === "map" ? mapRange : which === "stats" ? statsRange : analyticsRange;
const boundsOf = (which: RangeView): DateRange | null =>
  which === "map" ? mapRangeBounds : which === "stats" ? statsRangeBounds : analyticsRangeBounds;
/** The DOM id of a view's range-slider host. Ids follow the `${which}Filter`
 *  convention (mapFilter / statsFilter / analyticsFilter). */
const filterHostId = (which: RangeView): string => `${which}Filter`;

/** Store a new selection for a view. */
function assignRange(which: RangeView, next: DateRange): void {
  if (which === "map") mapRange = next;
  else if (which === "stats") statsRange = next;
  else analyticsRange = next;
}

/** Re-mount a view after its range changed (no re-fit during live drags). */
function remountRange(which: RangeView, fit: boolean): void {
  if (which === "map") mountAllRidesMap({ fit });
  else if (which === "stats") mountStatsView({ fit });
  else void mountAnalyticsView({ fit });
}

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
  const host = document.getElementById(filterHostId(which));
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
  const host = document.getElementById(filterHostId(which));
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
  assignRange(which, next);
  updateRangeLabels(which);
  remountRange(which, false);
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
    assignRange(which, next);
    updateRangeLabels(which);
    remountRange(which, false);
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
  assignRange(which, fullRange(bounds));
  remountRange(which, true);
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

// "Locate me" on the all-rides map: drop a live marker at the device position so the
// user can see where they are against their rides.
const mapLocate: Locate = createLocate({
  getMap: () => allRidesMap,
  button: document.getElementById("btnMapLocate"),
  onError: (msg) => toast(msg, true),
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
  const isAnalytics = activeView === "analytics";
  const isTimeline = activeView === "timeline";
  document
    .getElementById("exploreView")
    ?.classList.toggle("hidden", isMap || isStats || isAnalytics || isTimeline);
  document.getElementById("mapView")?.classList.toggle("hidden", !isMap);
  document.getElementById("statsView")?.classList.toggle("hidden", !isStats);
  document.getElementById("analyticsView")?.classList.toggle("hidden", !isAnalytics);
  document.getElementById("timelineView")?.classList.toggle("hidden", !isTimeline);
  if (!isMap && document.body.classList.contains("map-expanded")) setMapExpanded(false);
  if (!isStats && document.body.classList.contains("heat-expanded")) setHeatExpanded(false);
  if (!isMap && mapAreaSelect.isArmed()) mapAreaSelect.setMode(false);
  if (!isStats && heatAreaSelect.isArmed()) heatAreaSelect.setMode(false);
  // Stop watching the device position when its map leaves the screen.
  if (!isMap && mapLocate.isActive()) mapLocate.setActive(false);
  if (!isStats && heatLocate.isActive()) heatLocate.setActive(false);
  if (!isTimeline) leaveTimelineView();
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

// "Locate me" on the route-frequency heatmap (same control as the Map view).
const heatLocate: Locate = createLocate({
  getMap: () => freqHeatMap,
  button: document.getElementById("btnHeatLocate"),
  onError: (msg) => toast(msg, true),
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

// --------------------------------------------------------------------------- //
// Analytics view — wind vs speed. Each resolved ride is chopped into roughly-
// straight, moving segments (one heading, no stops); each segment is one scatter
// point of along-track wind (X: ← headwind / tailwind →) against average speed
// (Y). A distance-weighted regression turns the cloud into three numbers: your
// still-air speed (intercept), how much a km/h of tailwind buys you (slope), and
// how much of your speed the wind explains (R²).
//
// Segments are memoized per ride (filter-free) so the date slider and the
// Flat-only toggle re-filter synchronously — no IndexedDB re-reads on every drag
// frame, which matters at a power user's thousands of rides. The cache key folds in
// the ride's wind-resolved timestamp AND whether its full GPX is cached, so either
// re-resolving the wind or fetching the full track transparently invalidates the
// memoized segments.
//
// Speed is only trustworthy from a ride's FULL recorded GPX (real per-point
// timestamps). Rides without it fall back to evenly-spaced synthetic times, which
// would make per-segment speed a fiction — so the chart uses ONLY full-GPX rides and
// tells the user how many are waiting on a download.
// --------------------------------------------------------------------------- //
/** A ride's memoized segments plus why it may contribute none. */
type RideSegEntry = {
  segs: WindSeg[];
  /** ok = full timed GPX, segments usable; needgpx = resolved but no full timed
   *  track (speed would be synthetic); skip = no usable wind (noData / unaligned). */
  status: "ok" | "needgpx" | "skip";
};
const segCacheByUid = new Map<string, RideSegEntry>();
let analyticsSeq = 0;
/** True while an analytics sweep is in flight. Lets a passive re-render coalesce into
 *  a single post-run rerun instead of aborting + restarting the live sweep. */
let analyticsRunning = false;
/** A state change asked the analytics view to refresh while a sweep was running; the
 *  running sweep fires exactly one rerun when it finishes (if still on the tab). */
let analyticsRerunQueued = false;
/** |net grade| above this (percent) means a segment isn't "flat". */
const FLAT_GRADE_PCT = 1.5;

/** Memo key for a ride's segments: uid + wind version + full-GPX presence, so a
 *  re-resolve or a full-GPX fetch busts it. */
function segKey(r: RideView): string {
  return `${r.key}::${controller.weatherFetchedAt(r.key)}::${r.gpx_cached ? "g" : "_"}`;
}

/** The non-deleted rides within the current analytics date selection. */
function analyticsVisibleRides(): RideView[] {
  const visible = analyticsRange ? ridesInRange(STATE.rides, analyticsRange) : STATE.rides;
  return visible.filter((r) => !r.deleted);
}

/** Current max-speed cap (km/h) from the slider (20..80), defaulting to 50. Segments
 *  whose average speed exceeds this are dropped as GPS glitches. */
function analyticsMaxSpeed(): number {
  const el = document.getElementById("maxSpeed") as HTMLInputElement | null;
  const v = el ? parseInt(el.value, 10) : 50;
  return Number.isFinite(v) ? Math.max(20, Math.min(80, v)) : 50;
}

/** Render the analytics empty/blocked state, adapting message + CTA to whether the
 *  blocker is unresolved wind or missing full GPX. */
function renderAnalyticsEmpty(kind: "wind" | "gpx", n: number): void {
  const el = document.getElementById("analyticsEmpty");
  if (!el) return;
  if (kind === "wind") {
    el.innerHTML =
      "See how much the wind speeds you up or slows you down. This needs rides with " +
      "<b>resolved wind</b> — once some are resolved, each roughly-straight stretch of a " +
      "ride becomes a point: headwind on the left, tailwind on the right, your speed up the " +
      'side. <button type="button" class="linkbtn" id="analyticsResolveEmpty">' +
      "Resolve wind for these rides</button>";
  } else {
    el.innerHTML =
      `Wind is resolved, but charting speed needs each ride's <b>full GPX</b> (real ` +
      `timestamps). Without it, a segment's speed would be guessed from evenly-spaced ` +
      `points rather than your real pace, so ${n === 1 ? "this ride is" : `these ${n} rides are`} ` +
      `left out. <button type="button" class="linkbtn" id="analyticsFetchGpxEmpty">` +
      `Fetch full GPX for these rides</button>`;
  }
}

/** Show each analytics action button only when it can act on rides in range, with
 *  the affected count in its label. Resolve wind appears only while some in-range
 *  ride is unresolved AND resolvable (a ride with no route track can't have wind
 *  sampled, so counting it would promise an action that does nothing). Fetch full
 *  GPX only while some Beeline ride lacks its full track (gpx-source rides already
 *  carry theirs, so they never count). */
function syncAnalyticsActions(inRange: RideView[]): void {
  const unresolved = inRange.filter((r) => !r.wind_resolved && !!r.track).length;
  const needGpx = inRange.filter((r) => r.source !== "gpx" && !r.gpx_cached).length;
  const resolveBtn = document.getElementById("analyticsResolve");
  if (resolveBtn) {
    resolveBtn.style.display = unresolved === 0 ? "none" : "";
    resolveBtn.textContent =
      unresolved === 1 ? "Resolve wind for 1 ride" : `Resolve wind for ${unresolved} rides`;
  }
  const gpxBtn = document.getElementById("analyticsFetchGpx");
  if (gpxBtn) {
    gpxBtn.style.display = needGpx === 0 ? "none" : "";
    gpxBtn.textContent =
      needGpx === 1 ? "Fetch full GPX for 1 ride" : `Fetch full GPX for ${needGpx} rides`;
  }
}

/** Show (or clear) a calm centred message over the chart area without changing the
 *  page layout — used while analysing and when a date range has nothing to plot, so
 *  dragging the slider never collapses the cards/controls/slider out of view. Pass a
 *  0..1 `progress` to add a determinate bar (for the analysing sweep). */
function showChartMessage(text: string | null, progress?: number, detail?: string): void {
  const el = document.getElementById("analyticsChartMsg");
  if (!el) return;
  if (text) {
    if (progress !== undefined) {
      // Determinate (analysing) state: a FIXED-WIDTH card so it never resizes as the
      // ride label / count change. A stable header line holds the width; the changing
      // ride + count sit on an ellipsized detail line beneath, then the bar.
      const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
      el.innerHTML =
        `<span class="cm-card"><b class="cm-head">${text}</b>` +
        (detail ? `<span class="cm-detail">${detail}</span>` : "") +
        `<div class="chart-msg-bar"><i style="width:${pct}%"></i></div></span>`;
    } else {
      el.innerHTML = `<span>${text}</span>`;
    }
    el.style.display = "flex";
  } else {
    el.style.display = "none";
    el.textContent = "";
  }
}

/** Yield to the browser so a just-set overlay actually paints before more blocking
 *  work. Two rAFs guarantees a committed frame across engines. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Blank the scatter canvas (used when a range has no points to draw). */
function clearChart(): void {
  const canvas = document.getElementById("windSpeedChart") as HTMLCanvasElement | null;
  const ctx = canvas?.getContext("2d");
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function mountAnalyticsView(opts: { fit?: boolean } = {}): Promise<void> {
  // The heavy work — segmenting each ride — is cached per ride and INDEPENDENT of the
  // date range, so only one sweep ever runs and it's never restarted midway. A
  // re-entrant call while a sweep is running (a date-slider drag, a settings change, a
  // background job ticking ride state) just asks for ONE refresh afterwards instead of
  // superseding the sweep — so the progress counter never resets to 0 or drops its
  // total. Once the sweep has cached everything, later calls find nothing pending and
  // re-aggregate instantly, so the slider updates the plot live.
  if (analyticsRunning) {
    analyticsRerunQueued = true;
    return;
  }
  const my = ++analyticsSeq;
  analyticsRunning = true;
  try {
    await runAnalyticsView(my, opts);
  } finally {
    analyticsRunning = false;
    // Apply the latest range/settings once the sweep is done (only if still on tab).
    if (analyticsRerunQueued && activeView === "analytics") {
      analyticsRerunQueued = false;
      void mountAnalyticsView();
    }
  }
}

async function runAnalyticsView(my: number, _opts: { fit?: boolean } = {}): Promise<void> {
  refreshRange("analytics");
  const inRange = analyticsVisibleRides();
  const resolved = inRange.filter((r) => r.wind_resolved);

  const empty = document.getElementById("analyticsEmpty");
  const body = document.getElementById("analyticsBody");
  syncRangeControl("analytics");

  // Cold first run — nothing resolved anywhere yet → the full onboarding guide. No
  // slider interaction happens in this state, so a full swap is fine here.
  const anyResolvedEver = STATE.rides.some((r) => !r.deleted && r.wind_resolved);
  if (!anyResolvedEver) {
    renderAnalyticsEmpty("wind", 0);
    empty?.classList.remove("hidden");
    body?.classList.add("hidden");
    return;
  }

  // Working mode: keep the whole body (cards, controls, date slider, chart) mounted so
  // dragging the slider never collapses the layout. Every "nothing to plot here" state
  // is shown as a calm overlay on the chart instead of swapping the page out.
  empty?.classList.add("hidden");
  body?.classList.remove("hidden");
  syncAnalyticsActions(inRange);

  const opts: SegmentOpts = { stopKmh: STATE.settings.movingThresholdKmh };
  // Segmenting a ride is independent of the date range, so analyse the WHOLE resolved
  // library (not just the in-range slice) and cache it. That keeps the progress total
  // stable while the date slider moves — the slider only re-filters which cached rides
  // are plotted, it never restarts the sweep or drops the count. Only rides not already
  // memoized cost anything; re-renders after the first sweep are instant.
  const allResolved = STATE.rides.filter((r) => !r.deleted && r.wind_resolved);
  // Sweep newest-first (the list's canonical order) so progress reads as a sensible
  // march through time rather than the store's arbitrary order.
  const pending = allResolved
    .filter((r) => !segCacheByUid.has(segKey(r)))
    .sort((a, b) => compareRideKeysDesc(a.key, b.key));
  // Compute (and memoize) segments for each pending ride. Bail if a newer mount
  // (e.g. a date-slider drag) superseded this one while we awaited. One ride that
  // fails to load (corrupt cache, decode error) is skipped, never fatal — otherwise
  // a single bad ride in a large library would blank the whole chart.
  let done = 0;
  let lastPaint = 0;
  const sweepStart = performance.now();
  for (const r of pending) {
    const key = segKey(r);
    let entry: RideSegEntry;
    try {
      const s = await controller.windSamples(r.key);
      if (my !== analyticsSeq) return;
      if (!s) entry = { segs: [], status: "skip" };
      else if (!s.realTimes) entry = { segs: [], status: "needgpx" };
      else
        entry = {
          segs: segmentRide(s.points, s.times, s.eles, s.along, opts, r.key),
          status: "ok",
        };
    } catch (err) {
      console.error(`analytics: skipping ${r.key} —`, err);
      entry = { segs: [], status: "skip" };
    }
    if (my !== analyticsSeq) return;
    segCacheByUid.set(key, entry);
    done++;
    // Reveal the progress overlay only once a sweep has clearly run past a short delay,
    // then refresh it on a ~100ms budget so it ticks smoothly and names the ride in
    // flight. A download resolves rides one at a time, each firing a 1-ride top-up sweep
    // that finishes well under the delay — so it never flashes the overlay over the
    // existing chart. Big initial / re-segmentation sweeps cross the delay and show
    // smooth progress as before.
    const now = performance.now();
    if (now - sweepStart >= 200 && (now - lastPaint >= 100 || done === pending.length)) {
      lastPaint = now;
      const label = rideShortLabel(r.key);
      showChartMessage(
        "Analysing rides…",
        done / pending.length,
        `${label ? `${label} · ` : ""}${done} / ${pending.length}`,
      );
      await nextPaint();
      if (my !== analyticsSeq) return;
    }
  }
  if (my !== analyticsSeq) return;

  const flatOnly =
    (document.getElementById("flatOnly") as HTMLInputElement | null)?.checked ?? false;
  let usableRides = 0;
  let needGpxRides = 0;
  let skippedRides = 0;
  const segs: WindSeg[] = [];
  for (const r of resolved) {
    const entry = segCacheByUid.get(segKey(r));
    if (!entry) continue;
    if (entry.status === "needgpx") needGpxRides++;
    if (entry.status === "skip") skippedRides++;
    if (entry.status !== "ok") continue; // skip / needgpx contribute no segments
    usableRides++;
    for (const seg of entry.segs) {
      if (flatOnly) {
        if (!Number.isFinite(seg.netGradePct)) continue; // unknown grade → exclude
        if (Math.abs(seg.netGradePct) > FLAT_GRADE_PCT) continue; // hilly → exclude
      }
      segs.push(seg);
    }
  }

  // Drop physically-impossible segments: a bike can't average 100+ km/h, so anything
  // above the Max-speed cap is a GPS glitch. Unlike trimming the fast/slow tails by
  // speed, this leaves every believable headwind AND tailwind point in place, so the
  // wind slope isn't flattened — only bad data is removed. Dropped points are hidden
  // so the axes auto-scale to the real cloud.
  const maxSpeed = analyticsMaxSpeed();
  const out = document.getElementById("maxSpeedOut") as HTMLOutputElement | null;
  if (out) out.value = `${maxSpeed} km/h`;
  const keep = speedCapIndices(
    segs.map((s) => s.avgSpeedKmh),
    maxSpeed,
  );
  const shown = keep.map((i) => segs[i]);
  const trimmed = segs.length - shown.length;

  const xs = shown.map((s) => s.avgAlongKmh);
  const ys = shown.map((s) => s.avgSpeedKmh);
  const w = shown.map((s) => s.distanceKm);
  const reg = linearRegression(xs, ys, w);

  const cards = document.getElementById("analyticsCards");
  if (cards) {
    const has = shown.length > 0;
    cards.innerHTML = [
      statCard(has ? `${reg.intercept.toFixed(1)} km/h` : "—", "still-air speed"),
      statCard(
        has ? `${reg.slope >= 0 ? "+" : ""}${reg.slope.toFixed(2)}` : "—",
        "km/h per km/h of tailwind",
      ),
      statCard(has ? reg.r2.toFixed(2) : "—", "R² (wind explains)"),
      statCard(String(shown.length), shown.length === 1 ? "segment" : "segments"),
    ].join("");
  }
  const note = document.getElementById("analyticsNote");
  if (note) {
    // Only count rides that could actually be resolved (a trackless ride has no
    // route to sample wind along, so it's never "not yet resolved" — it's
    // unresolvable, and listing it would contradict the hidden Resolve button).
    const unresolved = inRange.filter((r) => !r.wind_resolved && !!r.track).length;
    note.textContent =
      ` ${usableRides} ride${usableRides === 1 ? "" : "s"} analysed` +
      (needGpxRides ? ` · ${needGpxRides} need full GPX` : "") +
      (unresolved ? ` · ${unresolved} not yet wind-resolved` : "") +
      (skippedRides ? ` · ${skippedRides} skipped` : "") +
      (flatOnly ? " · flat segments only" : "") +
      (trimmed ? ` · ${trimmed} over ${maxSpeed} km/h dropped` : "");
  }
  const canvas = document.getElementById("windSpeedChart") as HTMLCanvasElement | null;
  if (shown.length === 0) {
    // Stay in the working layout; explain the gap with a calm overlay instead.
    clearChart();
    showChartMessage(
      resolved.length === 0
        ? "No wind-resolved rides in this date range."
        : needGpxRides > 0
          ? `${needGpxRides} ride${needGpxRides === 1 ? "" : "s"} in this range need full GPX for speed.`
          : "No segments match the current filters.",
    );
  } else {
    showChartMessage(null);
    if (canvas) drawWindSpeedChart(canvas, shown, reg);
  }
}

// --------------------------------------------------------------------------- //
// Timeline (Google Location History) view lives in ./timeline-view.ts — an isolated
// map-centric experience (dwell heatmap, area-select "when was I here", day replay
// with a time slider). main.ts only owns import/drop and wires the module's deps.
// --------------------------------------------------------------------------- //

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
 * Inline SVG for the "Push to Strava" action — an up-arrow into a tray, drawn
 * with strokes (matching the app's other line icons) so it reads as "send/upload"
 * at a glance. Shown only when the button collapses to icon-only on narrow screens
 * (the text label carries the meaning on wider ones); `currentColor` inherits
 * the accent button's text colour. Inline SVG, never a Unicode glyph.
 */
const UPLOAD_ICON =
  '<svg class="mi mi-upl" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>';

function queueBadge(key: string): string {
  if (RUNNING.has(key)) return `<span class="badge working">working</span>`;
  if (ACTIVE.has(key)) return `<span class="badge queued">queued</span>`;
  return "";
}
/** The inner HTML of a ride's title row (`.rtitle`): source marker, name + location,
 *  and the status badges. One canonical builder so the full-list render and the
 *  lightweight in-place wind-badge update (applyWeatherUpdate) stay identical. */
function rtitleHtml(r: RideView, multiSource: boolean): string {
  return (
    sourceMark(r.source, multiSource) +
    `<span class="rname"><span class="rtitle-text">${r.title || "Ride"}</span>` +
    `${r.location ? `<span class="rtitle-loc">${r.location}</span>` : ""}</span> ` +
    `${r.source !== "gpx" && r.gpx_cached ? cachedBadge() : ""} ` +
    `${r.wind_resolved ? windBadge() : ""} ` +
    `${r.deleted ? deletedBadge() : ""} ${queueBadge(r.key)}`
  );
}
function deletedBadge(): string {
  return `<span class="badge deleted" title="This ride is no longer in your Beeline account — it was deleted in the Beeline app.">deleted</span>`;
}
/**
 * Subtle marker for a ride whose FULL recorded GPX is cached locally (real
 * per-point time + elevation), so its map/profile work offline and a save is
 * instant. Rendered as a small dot + "GPX" so it reads as a quiet
 * "ready offline" hint, not another loud status pill.
 */
function cachedBadge(): string {
  return `<span class="badge cached" title="Full recorded GPX is cached locally (real time + elevation) — its map and profile work offline and saving is instant.">GPX</span>`;
}
/**
 * A tiny, icon-only marker for a ride that has had its historical wind resolved
 * (head/tailwind available on its big map). Just a small breeze glyph so it reads as
 * a quiet "wind ready" hint at a glance — the detail lives in the tooltip and the
 * map itself. Pairs with the Wind filter chip for finding resolved/unresolved rides.
 */
function windBadge(): string {
  return (
    `<span class="badge wind" title="Historical wind resolved — open this ride's map and choose “Show wind” for head/tailwind colouring.">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M4 9h10a2.5 2.5 0 1 0-2.5-2.5"/><path d="M4 15h6a2.5 2.5 0 1 1-2.5 2.5"/></svg>` +
    `</span>`
  );
}
/**
 * A tiny, icon-only marker for a ride's source, shown at the START of its title so
 * the origin (Beeline cloud account vs an imported GPX file) is readable at a glance
 * without opening a filter. Rendered ONLY when the library actually mixes sources —
 * a single-source list needs no per-ride marker, so it stays clean. Icon-only (the
 * source name lives in the tooltip) so it costs almost no width; a subtle source
 * tint plus the cloud/file shape make the two instantly distinguishable.
 */
function sourceMark(source: RideSource, multiSource: boolean): string {
  if (!multiSource) return "";
  if (source === "gpx") {
    return (
      `<span class="src-mark src-gpx" title="Imported from a GPX file">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M18 21H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8l5 5v11a1 1 0 0 1-1 1z"/></svg>` +
      `</span>`
    );
  }
  return (
    `<span class="src-mark src-beeline" title="From your Beeline account">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.5 8.5 4 4 0 0 0 7 19z"/></svg>` +
    `</span>`
  );
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
/**
 * A source-agnostic riding-volume bar for a group header: the group's distance as a
 * fraction of the busiest sibling group (`maxKm`). Replaces the old Strava
 * upload-progress bar so the indicator means something for ANY ride library — glance
 * down the year/month list to see where the big riding was. Always rendered (even
 * empty) so the fixed-width column keeps every sibling row's meta aligned.
 */
function volumeBar(km: number, maxKm: number): string {
  const pct = maxKm > 0 && km > 0 ? Math.max(3, Math.round((km / maxKm) * 100)) : 0;
  const fill = pct > 0 ? `<i class="vol" style="width:${pct}%"></i>` : "";
  return `<span class="bars" title="${fmtKm(km)} ridden">${fill}</span>`;
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

/** The Strava-status chip cycles through these in order on each click; "all" is the
 *  neutral (any) state. Kept in sync with `STATUS_CHIP_LABEL`. */
const STATUS_CYCLE: Filters["status"][] = ["all", "not-uploaded", "processing", "uploaded"];
/** Self-labeling text for the Strava-status chip (it can't use the tri-state ✓/✕). */
const STATUS_CHIP_LABEL: Record<Filters["status"], string> = {
  all: "Strava: any",
  "not-uploaded": "Strava: not uploaded",
  processing: "Strava: processing",
  uploaded: "Strava: uploaded",
};

/** The Source chip cycles through these on each click; "all" is the neutral (any)
 *  state. Kept in sync with `SOURCE_CHIP_LABEL`. */
const SOURCE_CYCLE: Filters["source"][] = ["all", "beeline", "gpx"];
/** Self-labeling text for the Source chip (a 3-way pick, not a tri-state ✓/✕). */
const SOURCE_CHIP_LABEL: Record<Filters["source"], string> = {
  all: "Source: any",
  beeline: "Source: Beeline",
  gpx: "Source: GPX",
};

/** Reflect the filter state in the bar: device options, chip labels, active classes. */
function syncFilterBar(allRides: AppState["rides"]): void {
  // Source chip (any / Beeline / GPX). Only shown once rides from more than one
  // source coexist — with a single source there's nothing to narrow.
  const sourceKinds = new Set(allRides.map((r) => r.source));
  const multiSource = sourceKinds.size > 1;
  const sourceChip = document.getElementById("fSource");
  if (sourceChip) {
    sourceChip.classList.toggle("hidden", !multiSource);
    sourceChip.dataset.state = filters.source;
    sourceChip.textContent = SOURCE_CHIP_LABEL[filters.source];
    sourceChip.classList.toggle("on", filters.source !== "all");
  }
  if (!multiSource && filters.source !== "all") {
    // Drop a now-meaningless source filter so a hidden control can't keep rides hidden.
    filters.source = "all";
    saveFilters();
  }

  // Tri-state chips: glyph + active styling reflect the current state.
  const chip = (id: string, label: string, state: string, yes: string): void => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.state = state;
    el.textContent =
      state === "any" ? `${label}: any` : `${label} ${state === yes ? "✓" : "✕"}`;
    el.classList.toggle("on", state !== "any");
  };
  chip("fGps", "Route", filters.gps, "yes");
  chip("fCached", "Full GPX", filters.cached, "yes");
  chip("fWind", "Wind", filters.wind, "yes");
  chip("fDestination", "Destination", filters.destination, "yes");
  chip("fNamed", "Named", filters.named, "yes");
  chip("fDeleted", "Deleted", filters.deleted, "only");

  // Strava upload status is a 4-state cycle (any → not uploaded → processing →
  // uploaded), so it can't use the tri-state ✓/✗ helper — render its current state as
  // the chip's own label. Same pill, same accent-when-active as its peers, so it reads
  // as one of the click-through filters rather than a segmented control.
  const statusEl = document.getElementById("fStatus");
  if (statusEl) {
    statusEl.dataset.state = filters.status;
    statusEl.textContent = STATUS_CHIP_LABEL[filters.status];
    statusEl.classList.toggle("on", filters.status !== "all");
  }

  // Beeline-centric dimensions: Strava upload status, route-preview presence, full-
  // GPX caching, synthesized-name and remote deletion are concepts that only exist
  // for Beeline rides — a GPX import always carries its full track, takes its filename
  // as its name, and is never deleted out from under us. So these controls can only
  // ever narrow a Beeline library: show them only when Beeline rides are present, and
  // neutralize any active one so a hidden control can't keep rides hidden. (Destination
  // is NOT here — it now applies to both sources: Beeline rides route to a place, and a
  // GPX ride's destination is user-editable, so the chip stays available either way.)
  const hasBeeline = allRides.some((r) => r.source === "beeline");

  const statusChip = document.getElementById("fStatus");
  if (statusChip) statusChip.classList.toggle("hidden", !hasBeeline);
  if (!hasBeeline && filters.status !== "all") {
    filters.status = "all";
    saveFilters();
  }

  for (const [id, key] of [
    ["fGps", "gps"],
    ["fCached", "cached"],
    ["fNamed", "named"],
    ["fDeleted", "deleted"],
  ] as const) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", !hasBeeline);
    if (!hasBeeline && filters[key] !== "any") {
      filters[key] = "any";
      saveFilters();
    }
  }

  // Wind chip: appears only once the library has DIVERSITY on this dimension — some
  // rides with wind resolved AND some without — since with no such split there's
  // nothing to narrow. Gated on the real signal (not a flag), like the Source chip.
  const someWind = allRides.some((r) => r.wind_resolved);
  const someNoWind = allRides.some((r) => !r.wind_resolved);
  const windDiverse = someWind && someNoWind;
  const windChip = document.getElementById("fWind");
  if (windChip) windChip.classList.toggle("hidden", !windDiverse);
  if (!windDiverse && filters.wind !== "any") {
    filters.wind = "any";
    saveFilters();
  }

  // Wind speed min/max range: a contextual companion to the Wind chip, shown ONLY
  // while filtering to resolved-wind rides ("Wind ✓"). When that's not the case the
  // bounds are meaningless, so hide the inputs and drop any active bound so a hidden
  // control can't keep rides filtered.
  const windRangeOn = windDiverse && filters.wind === "yes";
  document.getElementById("fWindRange")?.classList.toggle("hidden", !windRangeOn);
  if (!windRangeOn && (filters.windMin !== null || filters.windMax !== null)) {
    filters.windMin = null;
    filters.windMax = null;
    saveFilters();
  }
  const wMin = $<HTMLInputElement>("#fWindMin");
  const wMax = $<HTMLInputElement>("#fWindMax");
  if (wMin && document.activeElement !== wMin)
    wMin.value = filters.windMin === null ? "" : String(filters.windMin);
  if (wMax && document.activeElement !== wMax)
    wMax.value = filters.windMax === null ? "" : String(filters.windMax);

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
  if (which === "status") {
    const i = STATUS_CYCLE.indexOf(filters.status);
    filters.status = STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
  } else if (which === "source") {
    const i = SOURCE_CYCLE.indexOf(filters.source);
    filters.source = SOURCE_CYCLE[(i + 1) % SOURCE_CYCLE.length];
  } else if (which === "gps") filters.gps = nextTri(filters.gps);
  else if (which === "cached") filters.cached = nextTri(filters.cached);
  else if (which === "wind") filters.wind = nextTri(filters.wind);
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
  filters.cached = "any";
  filters.wind = "any";
  filters.windMin = null;
  filters.windMax = null;
  filters.destination = "any";
  filters.named = "any";
  filters.deleted = "any";
  filters.source = "all";
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
  const sourceBtn = $<HTMLButtonElement>("#btnSource");
  const scanBtn = document.getElementById("btnScan") as HTMLButtonElement | null;

  sourceBtn.style.display = "";

  // Does the user actually use Beeline? — connected now, the demo, has Beeline rides
  // cached, or previously chose the Beeline profile. ONLY then do we surface the
  // Beeline-account chrome (the connection state + the whole-history "Re-sync"), so a
  // pure-GPX user isn't nagged by a red "not signed in" banner and a sync button that
  // has nothing to sync. "Change source" stays visible as the way in to Beeline.
  const usesBeeline =
    isDemo ||
    STATE.connected ||
    STATE.rides.some((r) => r.source === "beeline") ||
    rememberedProfile() === "beeline";

  if (isDemo) {
    el.textContent = "demo · Beeline";
    el.className = "cstate demo";
    el.style.display = "";
    // No dedicated "Exit demo" button: the always-visible "Change source" already
    // leads out of the demo (picking any source replaces it), so a second exit
    // affordance would just be header clutter.
  } else if (STATE.connected) {
    el.textContent = STATE.device || "connected";
    el.className = "cstate on";
    el.style.display = "";
    // No "Sign out" button: the password is never stored, so a plain page refresh
    // already drops account access (back to offline cached rides), and "Change
    // source" leads out — a dedicated sign-out would just be header clutter.
  } else if (usesBeeline) {
    // Showing cached Beeline rides without a live account — flag it in red so the
    // "stale, can't sync right now" state is unmistakable. No dedicated "Sign in"
    // button: "Pull from Beeline" already routes through the re-auth gate
    // (withBeelineAccess), so clicking it signs in (via the password manager) and
    // then pulls in one step — a separate sign-in affordance would be redundant.
    // Name the source so the state is clear once several sources can coexist.
    el.textContent = "Beeline: offline — not signed in";
    el.className = "cstate err";
    el.style.display = "";
  } else {
    // Pure-GPX (or empty): no Beeline footprint, so no account chrome at all — the
    // connection state and Re-sync would be meaningless noise here.
    el.style.display = "none";
  }

  // The whole-history "Re-sync" pull is a Beeline-account action; hide it entirely
  // for non-Beeline users (GPX rides come from import, not a sync).
  if (scanBtn) scanBtn.style.display = usesBeeline ? "" : "none";

  // The one Beeline scan action pulls the whole history at once: "Pull from Beeline".
  const scanLabel = document.getElementById("scanLabel");
  if (scanLabel) scanLabel.textContent = "Pull from Beeline";

  // Keep the Sources dialog's Beeline card in step with the live connection.
  renderSources();
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
    // Light onboarding: one line on the model (a library fed by sources), then the
    // two ways in as plain buttons + a demo link. Kept minimal on purpose.
    emptyEl.innerHTML =
      `<div class="onb">` +
      `<h2 class="onb-title">Your ride library is empty</h2>` +
      `<p class="onb-lede">Fill it from a <b>source</b> — your Beeline account or your own GPX files.</p>` +
      `<div class="onb-cta">` +
      `<button class="primary small" id="emptyConnect">Connect Beeline</button>` +
      `<button class="ghost small" id="emptyAddGpx">Add GPX files…</button>` +
      `</div>` +
      `<p class="onb-foot">Just exploring? <a href="#" id="emptyDemo">Try the demo</a>.</p>` +
      `</div>`;
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

  const del = rides.filter((r) => r.deleted).length;
  // Strava upload is a Beeline-only capability; only surface its chrome (the "Push all"
  // button, the Strava-status filter) when at least one ride can actually be pushed.
  // A pure-GPX library never sees Strava UI it can't use.
  const hasUploadable = allRides.some((r) => r.can_upload);
  // Whether to mark each ride's source: only worth it once the library mixes sources.
  const multiSource = new Set(allRides.map((r) => r.source)).size > 1;
  const shown = filtersActive(filters)
    ? `${rides.length} of ${allRides.length} rides`
    : `${rides.length} rides`;
  const nSel = selected.size;
  // The "N selected" suffix doubles as a one-click "Clear selection" affordance.
  // Everything interpolated here is static text or a number, so innerHTML is safe.
  // Upload totals (uploaded / pending) are intentionally NOT shown here — they're
  // low-importance noise in the header; the Strava-status filter lets the user drill
  // into exactly those subsets on demand.
  $("#totals").innerHTML =
    `${shown}` +
    (del ? ` · ${del} deleted` : "") +
    (nSel
      ? ` · <button class="selchip" id="selClear" title="Clear selection">${nSel} selected <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`
      : "");

  // Batch actions apply to the current selection — they live in the consolidated
  // ⋯ menu's "Selected" group, which is shown only when something is selected, so
  // the buttons inside are always actionable (no per-item disabled/count needed).
  // "Push selected to Strava" only applies to upload-capable (Beeline) rides; hide it
  // when the selection has none (e.g. a GPX-only pick), so the menu never offers an
  // action that would silently skip everything chosen.
  const selUploadBtn = document.getElementById("btnUploadSel") as HTMLButtonElement | null;
  if (selUploadBtn) {
    const selHasUploadable = [...selected].some(
      (k) => allRides.find((r) => r.key === k)?.can_upload,
    );
    selUploadBtn.style.display = selHasUploadable ? "" : "none";
  }
  // The whole "Push all to Strava" menu item + the Strava-status filter are
  // Beeline-only; hide them when no ride can be pushed (a pure-GPX library).
  const uploadAllBtn = document.getElementById("btnUploadPending") as HTMLButtonElement | null;
  if (uploadAllBtn) uploadAllBtn.style.display = hasUploadable ? "" : "none";
  document.getElementById("fStatus")?.classList.toggle("hidden", !hasUploadable);
  // The selected-ride section only makes sense with a selection — hide the whole
  // group (label + actions) when nothing is selected, and stamp its label with the
  // count (the only place the count now lives in this menu).
  const selGroup = document.getElementById("selGroup");
  if (selGroup) selGroup.classList.toggle("hidden", nSel === 0);
  const selGroupLabel = document.getElementById("selGroupLabel");
  if (selGroupLabel) selGroupLabel.textContent = nSel ? `Selected (${nSel})` : "Selected";

  // Data-menu storage breakdown: spell out the cache-vs-data split so it's obvious
  // what each row holds, and inline a small "Clear" button on the re-fetchable caches
  // (the imported-GPX vault is your data — no inline clear). This menu is the single
  // home for the local-storage breakdown (the header no longer repeats it).
  const storageInfo = document.getElementById("storageInfo");
  if (storageInfo) {
    const stateBytes = controller.stateBytes();
    const cacheCount = controller.gpxCacheCount();
    const dataCount = controller.gpxDataCount();
    const windCount = controller.windCacheCount();
    // Two distinct groups so it's obvious what's safe to clear: YOUR DATA (rides,
    // settings, imported GPX — no clear button, losing it loses real data) vs.
    // re-fetchable CACHES (downloads + wind — each with an inline Clear). A subheading
    // separates them. Grid cells: label · size (right-aligned) · clear-or-blank.
    const row = (label: string, size: string, clear?: string) =>
      `<span class="ms-row">` +
      `<span class="ms-label">${label}</span>` +
      `<span class="ms-size">${size}</span>` +
      `<span class="ms-act">` +
      (clear
        ? clear === "location"
          ? `<button class="ms-clear" data-clear="location" title="Delete imported Location History — your only local copy">Drop</button>`
          : `<button class="ms-clear" data-clear="${clear}" title="Clear ${label.toLowerCase()} — it's re-fetchable">Clear</button>`
        : "") +
      `</span></span>`;
    const sub = (text: string) => `<span class="ms-sub">${text}</span>`;
    const rows: string[] = [row("Rides & settings", fmtBytes(stateBytes))];
    if (dataCount) rows.push(row("Imported GPX", fmtBytes(controller.gpxDataBytes())));
    // Imported Location History — its own bucket, separately droppable. Shown as YOUR
    // DATA (no auto-clear) but with an explicit Drop, since it's irreplaceable locally.
    if (locStore && !locStore.isEmpty()) {
      rows.push(row("Location History", fmtBytes(locStore.totalBytes()), "location"));
    }
    // The cache group only appears when something is actually cached.
    if (cacheCount || windCount) {
      rows.push(sub("Caches"));
      if (cacheCount)
        rows.push(row("Beeline tracks", fmtBytes(controller.gpxCacheBytes()), "gpx"));
      if (windCount) rows.push(row("Wind cache", fmtBytes(controller.windCacheBytes()), "wind"));
    }
    storageInfo.innerHTML = rows.join("");
    storageInfo.classList.toggle("hidden", rows.length === 0);
  }

  const allSelState = (keys: string[]): boolean | null => {
    const sel = keys.filter((k) => selected.has(k)).length;
    return sel === 0 ? false : sel === keys.length ? true : null;
  };

  const root = $("#months");
  root.innerHTML = "";
  // Busiest-group distances, so the volume bars read as "relative to my biggest
  // year / month". Years compare against years, months against all months.
  const groupKm = (rs: AppState["rides"]) => rs.reduce((s, r) => s + (r.distance_km ?? 0), 0);
  const maxYearKm = Math.max(
    0,
    ...years.map(([, ym]) => groupKm(ym.flatMap(([, m]) => m.rides))),
  );
  const maxMonthKm = Math.max(
    0,
    ...years.flatMap(([, ym]) => ym.map(([, m]) => groupKm(m.rides))),
  );
  for (const [year, ymonths] of years) {
    const yKeys = ymonths.flatMap(([, m]) => m.rides.map((r) => r.key));
    const yRides = ymonths.flatMap(([, m]) => m.rides);
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
        ${volumeBar(ykm, maxYearKm)}
        <span class="ymeta">${yRides.length} rides · ${fmtKm(ykm)}</span>
      </div>
      <div class="ybody" ${yOpen ? "" : 'style="display:none"'}></div>`;
    root.appendChild(ybox);
    setChecked(ybox.querySelector(".selall"), ySel);

    const ybody = ybox.querySelector(".ybody")!;
    for (const [mkey, m] of ymonths) {
      m.rides.sort((a, b) => compareRideKeysDesc(a.key, b.key));
      const mkm = m.rides.reduce((s, r) => s + (r.distance_km ?? 0), 0);
      const isOpen = openMonths.has(mkey);
      const mKeys = m.rides.map((r) => r.key);
      const mSel = allSelState(mKeys);
      // A per-ride "⋮" menu drops downward and would be clipped by the month box's
      // `overflow: hidden` (kept for rounded-corner clipping). Let just the month that
      // owns the open menu show overflow so the dropdown is fully visible.
      const menuHere =
        !!openMenu && openMenu.startsWith("ovr-r:") && mKeys.includes(openMenu.slice(6));

      const box = document.createElement("div");
      box.className = menuHere ? "month menu-open" : "month";
      box.innerHTML = `
        <div class="mhead" data-m="${mkey}">
          <span class="caret${isOpen ? " open" : ""}" aria-hidden="true"></span>
          <input type="checkbox" class="selall" data-selmonth="${mkey}" ${mSel === true ? "checked" : ""}>
          <span class="mtitle">${m.label}</span>
          ${volumeBar(mkm, maxMonthKm)}
          <span class="mmeta">${m.rides.length} rides · ${fmtKm(mkm)}</span>
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
            <div class="rtitle">${rtitleHtml(r, multiSource)}</div>
            <div class="rmeta">${r.date_key} · ${summaryDistance} · ${summaryDuration}
              <a href="#" data-stats="${r.key}">${so ? "hide" : "details"}</a></div>
            ${so ? detailsBlock(r) : ""}
          </div>
          <div class="rbtns${openMenu === `ovr-r:${r.key}` ? " open" : ""}">
            ${r.can_upload ? `<button class="small accent" data-act="upload-one" data-key="${r.key}"${r.status === "uploaded" ? ' disabled title="Already uploaded to Strava"' : ' title="Push to Strava (via Beeline)"'}>${UPLOAD_ICON}<span class="btn-label">Push to Strava</span></button>` : ""}
            <button class="small ghost ovr" data-splitmenu="ovr-r:${r.key}" aria-haspopup="true" aria-expanded="${openMenu === `ovr-r:${r.key}`}" title="More ride actions">${KEBAB_ICON}</button>
            <span class="ovr-items">
              <button class="small ghost" data-act="gpx-save-one" data-key="${r.key}" title="Save the route-only GPX (the stored shape — no timestamps or elevation; instant, works offline)">Save route GPX</button>
              <button class="small ghost" data-act="gpx-save-full-one" data-key="${r.key}" title="Download the full recorded GPX (real timestamps + elevation) and save it to disk">Save full GPX</button>
              <button class="small ghost" data-act="gpx-fetch-one" data-key="${r.key}" title="${r.gpx_cached ? "Full GPX is cached — fetch again to refresh it (no file saved)" : "Fetch the full recorded GPX into the local cache without saving a file (pre-warms offline use + the map)"}">${r.gpx_cached ? "Fetch full GPX ✓" : "Fetch full GPX"}</button>
              <button class="small ghost" data-act="resolve-wind-one" data-key="${r.key}" title="${controller.hasResolvedWind(r.key) ? "Historical wind is resolved — open the map and choose Show wind, or resolve again to refresh" : "Resolve historical wind (from Open-Meteo) for this ride — colours its big map by head/tailwind"}">${controller.hasResolvedWind(r.key) ? "Resolve wind ✓" : "Resolve wind"}</button>
              ${r.deleted ? "" : `<button class="small ghost" data-act="rename-one" data-key="${r.key}" title="Rename this ride">Rename…</button>`}
              ${r.deleted || r.source !== "gpx" ? "" : `<button class="small ghost" data-act="destination-one" data-key="${r.key}" title="Set or edit this ride's destination (the place it went to)">${r.location.trim() ? "Edit destination…" : "Set destination…"}</button>`}
              ${r.deleted ? "" : `<button class="small danger" data-act="delete-one" data-key="${r.key}" title="Delete this ride">Delete…</button>`}
            </span>
          </div>`;
        rowsEl.appendChild(el);
      }
    }
  }
  renderJob();
  if (activeView === "map") mountAllRidesMap();
  else if (activeView === "stats") mountStatsView();
  // The wrapper coalesces a re-entrant call into one post-sweep refresh, so a passive
  // re-render (a background job ticking ride state) never restarts a live sweep.
  else if (activeView === "analytics") void mountAnalyticsView();
  else if (activeView === "timeline") mountTimelineView();
  else mountMaps();
  // The consolidated actions menu lives in static markup (not rebuilt here), so
  // sync its open state from the shared `openMenu` flag.
  const stateSplit = document.getElementById("stateMenu")?.closest(".split");
  stateSplit?.classList.toggle("open", openMenu === "state");
  // First paint is done with real state — drop the boot guard that kept the static
  // header's Beeline connection chrome hidden, so it never flashed in then out.
  document.body.classList.remove("booting");
  lastSig = stateSig();
  lastWeatherSig = weatherSig();
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

  // Minimized handle: keep it a tiny pill, but convey the NATURE of the work and the
  // PROGRESS, not just a bare count. Show the current verb ("Resolving wind") + a
  // done/total when the running task reports progress, and turn the spinner into a
  // determinate ring that fills as work completes (falls back to the indeterminate
  // spinner when no progress is known, e.g. a scan).
  const handleText = $("#jobHandleText");
  const handleSpin = $("#jobHandle .spin") as HTMLElement;
  const verb = cur ? TASK_VERB[cur.kind] || cur.kind : "Working";
  const hp = cur?.progress;
  if (hp && hp.total > 0) {
    handleSpin.classList.add("det");
    handleSpin.style.setProperty("--p", String(hp.done / hp.total));
    handleText.textContent = `${verb} · ${hp.done}/${hp.total}`;
  } else {
    handleSpin.classList.remove("det");
    handleSpin.style.removeProperty("--p");
    handleText.textContent = total
      ? `${verb} · ${total} ride${total === 1 ? "" : "s"}`
      : `${verb}\u2026`;
  }

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
  "fetch-weather": "Resolving wind",
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
    if (expandedErrIds.has(c.id)) full.classList.add("show");
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

// Batch select acts only on rides that pass the active filters — the same
// visible set the list shows and the header checkbox's checked/indeterminate
// state is derived from. Sourcing from the full STATE.rides would silently
// select hidden rides the user can't see.
const keysOfMonth = (m: string): string[] =>
  visibleRides(filters, STATE.rides)
    .filter((r) => r.month_key === m)
    .map((r) => r.key);
const keysOfYear = (y: string): string[] =>
  visibleRides(filters, STATE.rides)
    .filter((r) => (r.month_key || "").slice(0, 4) === y)
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
  // Exclude the verbose, fast-changing job fields (message/progress/history) from the
  // render signature: they tick on every `report()` during a job and would otherwise
  // trigger a full render() — which remounts the Leaflet maps and makes them flicker.
  // The job BAR is refreshed separately every tick (renderJob); the LIST only depends
  // on WHICH rides are queued/running (active_keys/current_keys), so include just those.
  const { jobs, rides, ...rest } = STATE;
  const jobsSig =
    [...(jobs.active_keys ?? [])].sort().join(",") +
    ";" +
    [...(jobs.current ? jobs.current_keys ?? [] : [])].sort().join(",");
  // Strip the per-ride WEATHER fields too — during a bulk wind resolve they update
  // one ride at a time, and including them would rebuild the whole list (remounting
  // maps) on every resolved ride. Weather changes are applied in place by
  // applyWeatherUpdate instead (toggling the small wind badge), no list rebuild.
  const ridesSig = JSON.stringify(rides.map(({ wind_resolved, wind_speed_kmh, ...r }) => r));
  return (
    JSON.stringify(rest) +
    "#" +
    ridesSig +
    "#" +
    jobsSig +
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

/** Signature of just the per-ride wind-resolved state, so a weather-only change can
 *  be applied in place (badges) without a full, map-remounting list rebuild. */
function weatherSig(): string {
  return STATE.rides.map((r) => (r.wind_resolved ? "1" : "0")).join("");
}

/** Re-read controller state and re-render if anything visible changed. */
function applyState(): void {
  STATE = controller.state();
  // Keep the open big-map wind overlay live as resolution lands, even when the main
  // list signature hasn't changed (the per-point overlay isn't part of STATE).
  refreshOpenRideMapWind();
  // Always refresh the lightweight job bar (it ticks on every job `report`), but only
  // run the full, map-remounting render() when list-relevant state actually changed —
  // so job progress updates never flicker the maps.
  renderJob();
  if (stateSig() !== lastSig) {
    render();
    return;
  }
  // Structure unchanged — apply any weather-only change (a ride resolved its wind) in
  // place, without rebuilding the list (which would remount + flicker the maps).
  const wsig = weatherSig();
  if (wsig !== lastWeatherSig) {
    lastWeatherSig = wsig;
    applyWeatherUpdate();
  }
}

/** Apply a weather-only state change without a full list rebuild: toggle the wind
 *  badge on each visible ride row in place (so mounted maps survive) and refresh the
 *  filter bar (the Wind chip/range gate on resolved-wind diversity). If a wind-based
 *  filter is active the visible SET depends on weather, so fall back to a full render. */
function applyWeatherUpdate(): void {
  if (filters.wind !== "any" || filters.windMin !== null || filters.windMax !== null) {
    render();
    return;
  }
  const multiSource = new Set(STATE.rides.map((r) => r.source)).size > 1;
  for (const r of STATE.rides) {
    const titleEl = document.querySelector<HTMLElement>(
      `.rrow[data-key="${(window.CSS?.escape ?? cssEscape)(r.key)}"] .rtitle`,
    );
    if (!titleEl) continue; // off-screen / collapsed group
    const next = rtitleHtml(r, multiSource);
    if (titleEl.innerHTML !== next) titleEl.innerHTML = next;
  }
  syncFilterBar(STATE.rides);
}

/** Minimal CSS.escape fallback for environments without it (older jsdom in tests). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

/** Run a controller action, surfacing errors to a persistent error card. */
function run(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    pushError("Action failed", err instanceof Error ? err.message : String(err));
  }
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
  a.download = "gpx-toolkit-state.json";
  a.click();
  URL.revokeObjectURL(url);
}

/** Export all state (rides, settings, GPX cache, wind cache) into a single ZIP file. */
async function exportAll(): Promise<void> {
  try {
    const meta = {
      app: {
        version: __APP_VERSION__,
        commit: __APP_COMMIT__,
        build_date: __APP_BUILD_DATE__,
      },
    };
    toast("Building full backup…");
    const zipBytes = await controller.exportAllZip(meta);
    const now = new Date();
    const yyyymmdd = now.toISOString().slice(0, 10);
    const filename = `${yyyymmdd}-gpx-toolkit-backup.zip`;
    saveGpxFile({
      filename: filename,
      downloadName: filename,
      bytes: zipBytes,
      mime: "application/zip",
    });
    toast("Full backup exported.");
  } catch (err) {
    console.error("[exportAll] failed", err);
    pushError("Backup export failed", err instanceof Error ? err.message : String(err));
  }
}

/** Trigger a browser "Save As" for a downloaded ride file (GPX, or a ZIP bundle). */
function saveGpxFile(file: {
  filename: string;
  downloadName: string;
  bytes: Uint8Array;
  mime?: string;
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
  const blob = new Blob([copy], { type: file.mime || "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Prefer the sort-friendly "YYYY-MM-DD HH-MM - <title>.gpx" name; fall back to
  // the device-stable filename if a download name wasn't computed. A name that
  // already carries an extension (e.g. a ".zip" bundle) is used as-is; otherwise
  // default to ".gpx".
  const name = file.downloadName || file.filename;
  a.download = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
}

function importRides(file: File): void {
  const isZip = file.name.endsWith(".zip") || file.type === "application/zip";
  const reader = new FileReader();

  reader.onload = async () => {
    try {
      if (isZip) {
        // Import ZIP backup.
        const arrayBuf = reader.result as ArrayBuffer;
        toast("Importing full backup…");
        const result = await controller.importAllZip(arrayBuf);
        const msg = `Imported — ${result.ridesImported} ride${result.ridesImported === 1 ? "" : "s"}, ` +
          `${result.gpxCacheImported} cached GPX${result.gpxCacheImported === 1 ? "" : "s"}, ` +
          `${result.gpxDataImported} imported GPX${result.gpxDataImported === 1 ? "" : "s"}, ` +
          `${result.windImported} wind cache entries.`;
        toast(msg);
      } else {
        // Import JSON state file (rides + settings, no caches).
        const n = controller.importJson(String(reader.result));
        toast(`Imported — ${n} new ride${n === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      const e = err as Error;
      console.error("[importRides] import failed", {
        error: e,
        name: e?.name,
        message: e?.message,
        isZip,
        controllerReady: controller != null,
        isDemo,
        file: { name: file.name, size: file.size, type: file.type },
        resultLength: typeof reader.result === "string" ? reader.result.length : (reader.result instanceof ArrayBuffer ? reader.result.byteLength : null),
      });
      const label = e?.name ? `${e.name} — ${e.message}` : e?.message;
      pushError("Import failed", e?.stack || label || "unknown import error");
    }
  };

  reader.onerror = () => {
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

  if (isZip) {
    reader.readAsArrayBuffer(file);
  } else {
    reader.readAsText(file);
  }
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
  // The location-history bucket is separate from the controller's stores, so a full
  // reset must clear it explicitly to be complete (a per-domain drop never does this).
  await ensureLocStore().then((s) => s.clear());
  forgetProfile(); // forget the chosen source so the dialog leads next time
  await openApp(); // rebuild a fresh controller over the now-empty cache
  showSources({ welcome: true }); // start fresh: let the user reconnect a source
  toast("Local data cleared.");
}

/**
 * Flush only the re-fetchable GPX **download cache** (Beeline full-GPX), leaving
 * rides, settings AND imported GPX files intact. The cache can grow large (one
 * gzipped GPX per downloaded ride); this reclaims that space, and cached rides are
 * simply re-downloaded next time. Imported GPX originals live in a separate data
 * store and are never touched here.
 */
async function flushGpxCache(): Promise<void> {
  openMenu = null; // close the Data menu we were invoked from
  const n = controller.gpxCacheCount();
  if (n === 0) {
    toast("No cached downloads to clear.");
    return;
  }
  if (
    !confirm(
      `Clear ${n} cached GPX download${n === 1 ? "" : "s"} (${fmtBytes(
        controller.gpxCacheBytes(),
      )})? Your rides, settings and imported GPX files are kept; cached rides are re-downloaded from Beeline next time you save them.`,
    )
  ) {
    return;
  }
  await controller.flushGpxCache();
  toast("Beeline tracks cleared.");
}

/** Clear the global historical-wind cache (re-fetched from Open-Meteo on demand). */
async function flushWindCache(): Promise<void> {
  openMenu = null; // close the Data menu we were invoked from
  const n = controller.windCacheCount();
  if (n === 0) {
    toast("No cached wind data to clear.");
    return;
  }
  if (
    !confirm(
      `Clear cached historical wind (${fmtBytes(
        controller.windCacheBytes(),
      )})? Your rides and settings are kept; wind is re-fetched from Open-Meteo next time you open a ride.`,
    )
  ) {
    return;
  }
  await controller.flushWindCache();
  toast("Wind cache cleared.");
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target && target.tagName === "INPUT") return; // checkboxes handled on 'change'
  const t = (target.closest("button, a, .mhead, .yhead") as HTMLElement) || target;

  // Sources dialog actions (modal): handle before anything else.
  if (t.id === "btnDemoBeeline") {
    hideSources();
    return void goDemoBeeline();
  }
  if (t.id === "btnBeelinePull") {
    return pullFromBeeline();
  }
  if (t.id === "btnBeelineDisconnect") {
    return void controller.disconnect();
  }
  if (t.id === "btnGpxSource") {
    return goGpx();
  }
  if (t.id === "btnPickClose") {
    hideSources();
    return;
  }
  // Click on the dialog backdrop (outside the card) dismisses it.
  if (target.id === "srcPick") {
    hideSources();
    return;
  }

  // Analytics view: resolve historical wind for every ride in the current date
  // range, so the wind-vs-speed scatter has points to plot.
  if (t.id === "analyticsResolve" || t.id === "analyticsResolveEmpty") {
    const keys = analyticsVisibleRides().map((r) => r.key);
    return resolveWindFor(keys);
  }
  // Analytics view: fetch the full recorded GPX (real timestamps) for the rides in
  // range — speed is only trustworthy from a full timed track.
  if (t.id === "analyticsFetchGpx" || t.id === "analyticsFetchGpxEmpty") {
    const keys = analyticsVisibleRides().map((r) => r.key);
    return fetchFullGpx(keys);
  }

  // Full-screen single-ride route map: open from a mini-map's expand button, close
  // from its bar button or by clicking the backdrop outside the canvas.
  if (t.dataset?.expand) {
    return openRideMap(t.dataset.expand);
  }
  if (t.id === "btnRideMapFull") {
    return fetchRideMapFull();
  }
  if (t.id === "btnRideMapWind") {
    return toggleRideMapWind();
  }
  if (t.dataset?.color && t.closest("#rideMapColor")) {
    // Wind is the seg's 4th pillar — selecting it resolves/enables wind colouring;
    // any other mode turns wind colouring off and hides its summary line.
    if (t.dataset.color === "wind") return enableRideMapWind();
    document.getElementById("rideMapWind")?.classList.add("hidden");
    return setRideMapColor(t.dataset.color as "none" | "height" | "speed");
  }
  if (t.dataset?.profile && t.closest("#rideMapProfileMetric")) {
    return setRideMapProfileMetric(t.dataset.profile as "elevation" | "speed");
  }
  if (t.dataset?.axis && t.closest("#rideMapProfileAxis")) {
    return setRideMapProfileAxis(t.dataset.axis as "distance" | "time");
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
  // The consolidated actions menu's entries live inside `.split`, so the outside-click
  // guard below skips them — dismiss the open menu here once one of its items is picked.
  if (openMenu === "state" && target.closest("#stateMenu")) {
    openMenu = null;
    render();
    // fall through so the click still triggers the chosen action
  }
  if (openMenu !== null && !target.closest(".split, .rbtns.open")) {
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
  if (t.id === "btnMapLocate") {
    mapLocate.setActive(!mapLocate.isActive());
    return;
  }
  if (t.id === "btnHeatLocate") {
    heatLocate.setActive(!heatLocate.isActive());
    return;
  }
  if (t.dataset?.rangereset) {
    resetRange(t.dataset.rangereset as RangeView);
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
  if (t.id === "emptyAddGpx") {
    e.preventDefault();
    openGpxFilePicker();
    return;
  }
  if (t.id === "emptyConnect") {
    e.preventDefault();
    showSources();
    return;
  }
  if (t.id === "emptyDemo") {
    e.preventDefault();
    hideSources();
    return void goDemoBeeline();
  }
  // Generic "connect a source" affordance used by the secondary empty states (Map
  // side panel, Stats) — opens the Sources dialog so every empty view leads to the
  // same place to fill the library.
  if (t.dataset?.act === "open-sources") {
    e.preventDefault();
    showSources();
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
  if (t.id === "btnSource") return showSources();
  if (t.id === "btnSettings") return showSettings();
  if (t.id === "btnSettingsClose") return hideSettings();
  // Click on the Settings backdrop (outside the card) dismisses it.
  if (target.id === "settingsModal") return hideSettings();
  if (t.id === "btnImport") return void ($("#importFile") as HTMLInputElement).click();
  if (t.id === "btnExport") return exportRides();
  if (t.id === "btnExportAll") return void exportAll();
  if (t.dataset?.clear === "gpx") return void flushGpxCache();
  if (t.dataset?.clear === "wind") return void flushWindCache();
  if (t.dataset?.clear === "location") return void dropLocationHistory();
  if (t.id === "btnReset") return void resetEverything();
  if (t.id === "btnScan") return pullFromBeeline();
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
    const open = card?.querySelector(".errfull")?.classList.toggle("show");
    // Remember the expand state so the next job-ticker re-render doesn't collapse it.
    if (card?.dataset.id) {
      if (open) expandedErrIds.add(card.dataset.id);
      else expandedErrIds.delete(card.dataset.id);
    }
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
    return saveFullGpx([...selected]);
  }
  if (t.id === "btnGpxFetchSel") {
    openMenu = null;
    if (!selected.size) return toast("Select some rides first.");
    return fetchFullGpx([...selected]);
  }
  if (t.id === "btnResolveWindSel") {
    openMenu = null;
    if (!selected.size) return toast("Select some rides first.");
    return resolveWindFor([...selected]);
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
        title: "Push all to Strava?",
        body: `This will push ${keys.length} pending ride${
          keys.length === 1 ? "" : "s"
        } to Strava. Already-uploaded rides are skipped.`,
        confirmLabel: "Push all",
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
    return saveFullGpx([key]);
  }
  if (act === "gpx-fetch-one") {
    openMenu = null;
    return fetchFullGpx([t.dataset.key!]);
  }
  if (act === "resolve-wind-one") {
    openMenu = null;
    return resolveWindFor([t.dataset.key!], controller.hasResolvedWind(t.dataset.key!));
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
      withRideAccess(ride.source, () => run(() => controller.rename(key, newName)));
    })();
    return;
  }
  if (act === "destination-one") {
    const key = t.dataset.key!;
    openMenu = null;
    render();
    const ride = STATE.rides.find((r) => r.key === key);
    if (!ride || ride.source !== "gpx") return;
    void (async () => {
      // `location` carries the leading ", " separator; prompt with the bare place.
      const current = ride.location.replace(/^[\s,]+/, "");
      const next = await promptDialog({
        title: current ? "Edit destination" : "Set destination",
        body: `Where did ${rideShortLabel(key) || key} go? Leave blank to clear it.`,
        value: current,
        confirmLabel: "Save",
      });
      if (next === null) return; // cancelled
      if (next.trim() === current) return; // unchanged
      run(() => controller.setDestination(key, next));
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
      const label = `“${ride.title || "Ride"}” (${rideShortLabel(key) || key})`;
      const body =
        ride.source === "beeline"
          ? `Permanently delete ${label} from your Beeline account? This can't be undone. ` +
            `It stays listed here, marked as deleted.`
          : `Delete the imported ride ${label}? This removes its GPX from this browser and ` +
            `can't be undone. It stays listed here, marked as deleted.`;
      const ok = await confirmDialog({
        title: "Delete ride?",
        body,
        confirmLabel: "Delete",
      });
      if (ok) withRideAccess(ride.source, () => run(() => controller.deleteRide(key)));
    })();
    return;
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
  const settingsM = document.getElementById("settingsModal");
  if (settingsM && !settingsM.classList.contains("hidden")) {
    hideSettings();
    return;
  }
  const confirmM = document.getElementById("confirmModal");
  if (confirmM && !confirmM.classList.contains("hidden")) {
    closeConfirm(false);
    return;
  }
  const picker = document.getElementById("srcPick");
  if (picker && !picker.classList.contains("hidden")) {
    hideSources();
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

// Keep the wind-vs-speed canvas crisp on resize. Reuses the per-ride segment memo,
// so a redraw is cheap (no IndexedDB reads).
let analyticsResizeRaf = 0;
window.addEventListener("resize", () => {
  if (activeView !== "analytics") return;
  if (analyticsResizeRaf) cancelAnimationFrame(analyticsResizeRaf);
  analyticsResizeRaf = requestAnimationFrame(() => {
    analyticsResizeRaf = 0;
    void mountAnalyticsView({ fit: false });
  });
});

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
  if (cb.id === "gpxFile" && cb.files && cb.files.length) {
    importGpxFiles([...cb.files]);
    cb.value = "";
  }
  if (cb.id === "locFile" && cb.files && cb.files[0]) {
    void importLocationHistory(cb.files[0]);
    cb.value = "";
  }
  if (cb.id === "flatOnly") {
    void mountAnalyticsView();
  }
});

// Drag the selected range window (between the two thumbs) to slide it as a whole.
document.addEventListener("pointerdown", (e) => {
  const win = (e.target as HTMLElement).closest?.<HTMLElement>(".rf-window");
  const which = win?.dataset.rangewin;
  if (win && (which === "map" || which === "stats" || which === "analytics"))
    onWindowDrag(which, win, e);
});

// Drag-and-drop GPX import: dropping .gpx files (or .zip bundles of them) anywhere
// on the app imports them as gpx-source rides. We only intercept drags that
// actually carry files so normal in-page dragging is untouched.
function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
document.addEventListener("dragover", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  document.body.classList.add("dragging-files");
});
document.addEventListener("dragleave", (e) => {
  // Only clear when the pointer actually leaves the window (relatedTarget null).
  if (!e.relatedTarget) document.body.classList.remove("dragging-files");
});
document.addEventListener("drop", (e) => {
  document.body.classList.remove("dragging-files");
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  const dropped = [...(e.dataTransfer?.files ?? [])];
  const gpx = dropped.filter((f) => /\.(gpx|zip)$/i.test(f.name));
  const loc = dropped.filter((f) => /\.json$/i.test(f.name));
  if (gpx.length) importGpxFiles(gpx);
  if (loc.length) void importLocationHistory(loc[0]);
  if (!gpx.length && !loc.length && dropped.length)
    toast("Drop .gpx files / a .zip bundle, or a Location History .json.", true);
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
  if (el.id === "fWindMin" || el.id === "fWindMax") {
    const v = el.value.trim() === "" ? null : Number(el.value);
    const kmh = v !== null && Number.isFinite(v) && v >= 0 ? v : null;
    if (el.id === "fWindMin") filters.windMin = kmh;
    else filters.windMax = kmh;
    saveFilters();
    applyState();
    return;
  }
  if (el.dataset.range === "map" || el.dataset.range === "stats" || el.dataset.range === "analytics") {
    onRangeInput(el.dataset.range as RangeView, el);
    return;
  }
  if (el.id === "heatRadius") {
    const v = parseInt(el.value, 10) || 12;
    ($("#heatRadiusOut") as HTMLOutputElement).value = String(v);
    run(() => controller.setHeatRadius(v));
    return;
  }
  if (el.id === "maxSpeed") {
    ($("#maxSpeedOut") as HTMLOutputElement).value = `${parseInt(el.value, 10) || 0} km/h`;
    void mountAnalyticsView();
    return;
  }
  if (el.id === "setMovingThresh") {
    // Cheap live label only — persisting (whole-blob save) + re-rendering on every
    // drag tick made the slider crawl. The actual setting is committed once on
    // `change` (slider release); nothing recomputes live here anyway (the moving-avg
    // chip lives on the ride map, which isn't open while this popup is).
    const v = Number(el.value);
    const thresh = Number.isFinite(v) ? v : 1;
    ($("#setMovingThreshOut") as HTMLOutputElement).value = `${thresh} km/h`;
    return;
  }
  if (el.id !== "trimSlow" && el.id !== "trimFast") return;
  const slow = parseInt($<HTMLInputElement>("#trimSlow").value, 10) || 0;
  const fast = parseInt($<HTMLInputElement>("#trimFast").value, 10) || 0;
  ($("#trimSlowOut") as HTMLOutputElement).value = `${slow}%`;
  ($("#trimFastOut") as HTMLOutputElement).value = `${fast}%`;
  run(() => controller.setSpeedTrim(slow, fast));
});

// Commit the moving-speed threshold once when the slider is released (`change`),
// not on every `input` tick — see the live-label handler above. This is the single
// whole-blob save + re-render for the whole drag.
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id !== "setMovingThresh") return;
  const v = Number(el.value);
  const thresh = Number.isFinite(v) ? v : 1;
  run(() => controller.setMovingThreshold(thresh));
});

// Wire the full-screen ride map into the app: it reaches the rest of the app only
// through this seam (the live controller + state, the toast channel, HTML escaping,
// the re-auth gates and the OSM credit), so it never imports the entry module. This
// also binds the profile strip's pointer events (its host persists across opens).
initRideMap({
  getController: () => controller,
  getState: () => STATE,
  toast,
  esc,
  withBeelineAccess,
  withGpxRelayConsent,
  osmAttribution: OSM_ATTRIBUTION,
});

initTimelineView({
  getStore: () => locStore,
  ensureStore: ensureLocStore,
  toast,
  esc: escHtml, // the real HTML escaper — NOT `esc`, which slugifies (spaces → "_")
  fmtBytes,
  osmAttribution: OSM_ATTRIBUTION,
  onImport: openLocFilePicker,
  onDrop: () => void dropLocationHistory(),
});

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
  if (isTimelineHelpOpen()) closeTimelineHelp();
  else if (isTimelineExpanded()) collapseTimeline();
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

// Boot: open the app over the unified cache (all sources' rides coexist; we never
// store the password, so a connected account isn't silently restored). On the
// first-ever launch we open the Sources dialog with the welcome intro to explain
// where rides come from; afterwards the app just opens to its library.
void openApp().then(() => {
  if (!hasBeenWelcomed()) {
    markWelcomed();
    showSources({ welcome: true });
  }
});
