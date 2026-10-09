/**
 * UI entry point — ported from the Python app's `web/index.html` inline script.
 *
 * The render functions and DOM event handling are kept faithful to the original
 * SPA (same `STATE = { rides, jobs }` model, same markup). The only change is the
 * data layer: instead of `fetch('/api/…')` + 1.5s polling, the UI talks to an
 * in-browser `Controller` and re-renders on its change events.
 */

// The app's type: Ubuntu (self-hosted, so every machine renders the same) and Ubuntu
// Mono for figures; `--font` / `--mono` in style.css name them first.
import "@fontsource/ubuntu/400.css";
import "@fontsource/ubuntu/500.css";
import "@fontsource/ubuntu/700.css";
import "@fontsource/ubuntu-mono/400.css";
import "@fontsource/ubuntu-mono/700.css";
import "leaflet/dist/leaflet.css";
import "./style.css";

import L from "leaflet";

import { activeView, setActiveView, type ViewName } from "./app-state";
import { type AppState, Controller, type RideView } from "./controller";
import { initExploreView, renderMatchedCards, rideTimesTitle, rideWhen } from "./explore-view";
import { filterActiveCount, filtersActive, visibleRides } from "./filter";
import {
  clearFilters,
  cycleChip,
  filters,
  initFilterState,
  isFilterPanelOpen,
  openIngestionPicker,
  openRidePicker,
  saveFilters,
  setFilterPanel,
  syncFilterBar,
  toggleTagsFilter,
} from "./filter-state";
import {
  fmtBytes,
  fmtDurationExact,
  fmtElevation,
  fmtKm,
  fmtKmDetail,
  fmtSpeed,
} from "./format";
import {
  dismissError,
  hideJob,
  initJobsView,
  pushError,
  renderJob,
  showJob,
  toggleErrorDetails,
  toggleQueue,
} from "./jobs-view";
import { OSM_ATTRIBUTION } from "./map-core";
import {
  initMapView,
  mapAreaSelect,
  mapLocate,
  mountMapView,
  setHot,
  setMapExpanded,
  setSelected,
} from "./map-view";
import {
  autoGranularity,
  beelineRideKey,
  bucketRide,
  compareRidesByDateDesc,
  type Granularity,
  rideDatetime,
  rideShortLabel,
  trimmedSpeed,
} from "./parsing";
import {
  applyRangePreset,
  closeRangePresets,
  initRangeView,
  onRangeInput,
  onWindowDrag,
  type RangeView,
  rangeOf,
  rangeWindowLabel,
  refreshRange,
  resetRange,
  ridesInRange,
  syncRangeControl,
} from "./range-view";
import { setSliderFill } from "./slider";
import {
  hideSettings,
  hideSources,
  initSourcesView,
  renderSources,
  setBeelineError,
  showSettings,
  showSources,
} from "./sources-view";
import {
  clearHeatHover,
  clearHeatSelection,
  heatAreaSelect,
  heatLocate,
  initStatsView,
  mountStatsView,
  setHeatExpanded,
  setHeatRadiusPreview,
  showHeatHover,
} from "./stats-view";
import {
  addTagModalTag,
  closeTagModal,
  cycleTagChip,
  initTagModal,
  openTagModal,
  saveTagModal,
} from "./tag-modal";
import "leaflet.heat";
import { trackEvent, trackView } from "./analytics";
import { BeelineError } from "./beeline-api";
import { DEMO_BEELINE_EMAIL, demoBeelineDeps } from "./beeline-demo";
import { BeelineRideSource, type BeelineSourceDeps } from "./beeline-source";
import {
  climatePoint,
  collapseClimate,
  initClimateView,
  isClimateExpanded,
  leaveClimateView,
  mountClimateView,
  setClimateRoutePoint,
} from "./climate-view";
import {
  closeConfirm,
  confirmDialog,
  consentDialog,
  initConfirm,
  promptDialog,
} from "./confirm";
import { OpenMeteoForecastAdapter } from "./forecast";
import { ForecastStore } from "./forecast-store";
import {
  forecastPoint,
  initForecastView,
  leaveForecastView,
  mountForecastView,
  resetForecastViewData,
  setForecastRoutePoint,
} from "./forecast-view";
import { GpxRideSource } from "./gpx-source";
import { GpxCache } from "./gpxcache";
import { decorateIcons, icon } from "./icons";
import { runInSlices } from "./idle";
import {
  idbBackend,
  idbBlobBackend,
  idbForecastBlobBackend,
  idbLocationBlobBackend,
  idbWindBlobBackend,
  memoryBackend,
} from "./kv";
import { parseLocationHistory } from "./loc-parse";
import { LocationHistoryStore } from "./loc-store";
import { effect, signal } from "./reactive";
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
  toggleRideMapChrome,
  toggleRideMapProfile,
  toggleRideMapProfileStops,
  toggleRideMapWeather,
} from "./ridemap";
import {
  parseRoute,
  type Route,
  type RoutePoint,
  validRoutePoint,
  writeRoute,
} from "./router";
import { RouteStore } from "./routes";
import {
  initRoutesView,
  leaveRoutesView,
  mountRoutesView,
  resetRoutesView,
} from "./routes-view";
import { initSegSliding } from "./seg";
import { initShell, lastWeatherView, setViewSubtitle, syncShell } from "./shell";
import type { SourceFactory } from "./source";
import { type RideSource, STORAGE_KEY, Store } from "./store";
import { initTheme } from "./theme";
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
import { decodePolyline } from "./track";
import { escHtml, initCollapse } from "./ui";
import { WindCache } from "./windcache";
import {
  initWindSpeedView,
  mountWindSpeedView,
  renderSegmentDemo,
  SEG_TUNE_DEFAULTS,
  syncColorByGating,
  toggleSegmentDemo,
  windSpeedVisibleRides,
} from "./windspeed-view";
import { buildZip, unzip } from "./zip";

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
const forecastBlobBackend = idbForecastBlobBackend();
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
let unsubscribeImported: (() => void) | null = null;

// Wind/Speed tab preferences persist across reloads (unlike the Map/Stats date
// ranges, which are session-only): the chosen date window + the two chart filters
// (flat-only, max-speed), so a user's analysis scope survives a refresh.
const ANALYTICS_PREFS_KEY = "beeline_uploader.analytics";

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
  if (unsubscribeImported) unsubscribeImported();
  controller = next;
  isDemo = demo;
  unsubscribe = controller.onChange(applyState);
  unsubscribeGpx = controller.onGpx(saveGpxFile);
  unsubscribeImported = controller.onImported(suggestTagsForImport);
  applyState();
}

// -- sources dialog ---------------------------------------------------------

// A cloud action deferred until the user (re)authenticates to Beeline. Set when a
// signed-out Beeline session triggers something needing the account (Re-sync,
// upload); run once sign-in succeeds, then cleared. The Sources/Settings dialogs
// themselves live in ./sources-view; on dismissal they call back to clear this.
let afterBeelineSignIn: (() => void) | null = null;

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
  // No start toast: the activity card already names the job and its progress.
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
  trackEvent("demo");
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
  trackEvent("beeline-connect");
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
    if (activeView() === "timeline") mountTimelineView();
    render();
  });
  void ensureForecastStore().then(() => {
    if (activeView() === "forecast") void mountForecastView();
    render();
  });
}

/** Pull the whole ride history from the connected Beeline account (the one
 *  Beeline-specific data action). Prompts for sign-in first when signed out. */
function pullFromBeeline(): void {
  trackEvent("beeline-pull");
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
  trackEvent("gpx-import");
  void getRealController().then((c) => {
    if (controller !== c) activate(c, false);
    hideSources();
    run(() => c.importGpx(files));
  });
}

/**
 * After a GPX import lands, offer to tag the just-imported rides (opening the
 * existing tag modal pre-targeted at them). Gated on the persisted
 * `suggestTagsAfterImport` setting; the dialog's "Don't ask again" simply flips that
 * same setting off (kept in lockstep with the Settings toggle). Fired from the
 * controller's `onImported` signal with the new rides' uids.
 */
function suggestTagsForImport(uids: string[]): void {
  if (!uids.length || !STATE.settings.suggestTagsAfterImport) return;
  const n = uids.length;
  void consentDialog({
    title: `Tag your imported ride${n === 1 ? "" : "s"}?`,
    body:
      `Imported ${n} ride${n === 1 ? "" : "s"}. Want to add tags now so they're easy to ` +
      "find and filter later? You can always tag rides afterwards from the list — and " +
      "turn this prompt off in Settings.",
    confirmLabel: `Tag ${n === 1 ? "ride" : "rides"}`,
    checkLabel: "Don't ask again after importing",
    checked: false,
  }).then(({ ok, dontAsk }) => {
    if (dontAsk) run(() => controller.setSuggestTagsAfterImport(false));
    if (ok) openTagModal(uids);
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

/** The saved routes: their own blob on the key/value store, never mixed into rides. */
let routeStore: RouteStore | null = null;
async function ensureRouteStore(): Promise<RouteStore> {
  if (!routeStore) {
    const s = new RouteStore(storageBackend);
    await s.load();
    routeStore ??= s;
  }
  return routeStore;
}

/** Live forecasts use their own cache/preferences bucket and never touch ride state. */
let forecastStore: ForecastStore | null = null;
let forecastLoading: Promise<ForecastStore> | null = null;

function ensureForecastStore(): Promise<ForecastStore> {
  if (forecastStore) return Promise.resolve(forecastStore);
  if (!forecastLoading) {
    forecastLoading = ForecastStore.load(forecastBlobBackend, onStorageError).then((value) => {
      forecastStore = value;
      return value;
    });
  }
  return forecastLoading;
}

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
    trackEvent("location-import");
    resetTimelineData();
    if (activeView() === "timeline") mountTimelineView();
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
  if (activeView() === "timeline") mountTimelineView();
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
    suggestTagsAfterImport: true,
  },
  connected: false,
  device: "",
  sources: [],
};
let ACTIVE = new Set<string>(); // keys queued or running
let RUNNING = new Set<string>(); // keys in the currently running task
const selected = new Set<string>();
// The selection survives a reload / a closed tab: it is the user's work (forty rides
// hand-picked for a wind job) and nothing should drop it but the user. Restored
// before the library loads; keys that no longer exist are pruned once rides arrive
// (renderSelectionBar), never while the library is still empty.
const SELECTION_KEY = "gpx_toolkit.selection";
try {
  const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "[]");
  if (Array.isArray(saved)) for (const k of saved) if (typeof k === "string") selected.add(k);
} catch {
  /* non-fatal */
}
// The range hint names the modifier the platform actually uses.
if (/Mac|iPhone|iPad/.test(navigator.platform)) {
  const hint = document.getElementById("selHint");
  if (hint) hint.textContent = hint.textContent?.replace("Ctrl", "⌘") ?? "";
}
let selectionSaved = "";
let selectionSaveTimer: ReturnType<typeof setTimeout> | null = null;
function persistSelection(): void {
  if (selectionSaveTimer) return;
  selectionSaveTimer = setTimeout(() => {
    selectionSaveTimer = null;
    const json = JSON.stringify([...selected]);
    if (json === selectionSaved) return;
    selectionSaved = json;
    try {
      localStorage.setItem(SELECTION_KEY, json);
    } catch {
      /* non-fatal */
    }
  }, 250);
}
/** The last ride the user clicked (its checkbox, or Ctrl-click on its row): the
 *  anchor a Shift-click extends from. */
let selAnchor: string | null = null;
/** Ride keys in the order the list shows them: years ↓, months ↓, newest first. */
function listOrderKeys(): string[] {
  return visibleRides(filters, STATE.rides)
    .slice()
    .sort((a, b) => b.month_key.localeCompare(a.month_key) || compareRidesByDateDesc(a, b))
    .map((r) => r.key);
}
/** Shift-click: set every ride between the anchor and `toKey` (inclusive, list
 *  order) to `on`. Without an anchor the clicked ride becomes it. */
function selectRange(toKey: string, on: boolean): void {
  const order = listOrderKeys();
  const j = order.indexOf(toKey);
  if (j < 0) return;
  const i = selAnchor ? order.indexOf(selAnchor) : -1;
  if (i < 0) selAnchor = toKey;
  const [a, b] = i < 0 ? [j, j] : [Math.min(i, j), Math.max(i, j)];
  for (let k = a; k <= b; k++) on ? selected.add(order[k]) : selected.delete(order[k]);
  applySelection();
}
const openMonths = new Set<string>();
const openYears = new Set<string>();

// -- Explore layout: contents + continuous list on wide screens -------------------
// From 1100px the year / month tree on the left is a table of contents and the pane
// on the right lists EVERY ride continuously, with a rule at each month and a heavier
// one at each year. Clicking a month scrolls the list there; a scroll-spy marks the
// month in view. Narrower screens keep the rides inside their (open) month box. The
// decision is made per render, and the signature includes it so a resize across the
// breakpoint — or a chart-width change that moves the Auto granularity — re-renders.
const EXPLORE_SPLIT = "(min-width: 1100px)";
function exploreSplit(): boolean {
  return !!window.matchMedia?.(EXPLORE_SPLIT).matches;
}
/** How many bars the Explore chart can hold at ~22px a slot (12…120). */
function chartBuckets(): number {
  const el = document.getElementById("chart");
  const w = el?.clientWidth || document.getElementById("statsPanel")?.clientWidth || 1000;
  return Math.max(12, Math.min(120, Math.floor(w / 22)));
}
/** Scroll the continuous list to a month / year heading (split layout). Builds the
 *  month it lands on first; a far target is jumped to (gliding across thousands of
 *  rows is a blur, and months rendered on the way would move the target), a near
 *  one glides. Either way the heading is checked once the scroll ends and nudged
 *  to the line if a late layout moved it. */
function scrollToGroup(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  treeClickAt = performance.now();
  const m = el.dataset.m ?? el.nextElementSibling?.getAttribute("data-m");
  if (m) buildMonthNow(m);
  const top = el.getBoundingClientRect().top;
  const far = Math.abs(top - GROUP_LINE) > window.innerHeight * 2;
  el.scrollIntoView({ behavior: far ? "auto" : "smooth", block: "start" });
  settleGroup(el);
}
/** Where a group heading rests after a scroll-to (its scroll-margin-top). */
const GROUP_LINE = 64;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
function settleGroup(el: HTMLElement): void {
  if (settleTimer) clearTimeout(settleTimer);
  const check = (): void => {
    settleTimer = null;
    document.body.removeEventListener("scrollend", check);
    if (!el.isConnected) return;
    const d = el.getBoundingClientRect().top - GROUP_LINE;
    const atEnd =
      document.body.scrollTop + document.body.clientHeight >= document.body.scrollHeight - 2;
    if (Math.abs(d) > 1 && !(atEnd && d < 0)) document.body.scrollTop += d;
  };
  document.body.addEventListener("scrollend", check, { once: true });
  settleTimer = setTimeout(check, 700); // browsers without scrollend
}

// -- Scroll anchoring -----------------------------------------------------------
// A render wipes and rebuilds the list, which would leave the page wherever the
// browser clamped the scroll position mid-rebuild — the list visibly jumping under
// the user. So before a rebuild (or leaving Explore) we note which month sits at the
// reading line and where, build that month first, and put it back at the same pixel.
// Idle slices then fill the months above and below; their placeholder heights come
// from measured rows, so they barely change when built.
type ListAnchor = { m: string; top: number };
let listAnchor: ListAnchor | null = null;
/** Set by navigation: the next render restores the saved anchor instead of
 *  re-reading one from a list that another view scrolled away from. */
let keepAnchor = false;
/** The reading line: just under the top bar + the sticky month heading. */
const READ_LINE = 130;
function exploreVisible(): boolean {
  return (
    activeView() === "explore" &&
    !document.getElementById("exploreView")?.classList.contains("hidden")
  );
}
function anchorSections(): HTMLElement[] {
  return exploreSplit()
    ? [...document.querySelectorAll<HTMLElement>("#rideList .rp-month")]
    : [...document.querySelectorAll<HTMLElement>("#months .month")];
}
function sectionKey(sec: HTMLElement): string | undefined {
  return sec.dataset.m ?? sec.querySelector<HTMLElement>(".mhead")?.dataset.m;
}
function captureListAnchor(): void {
  if (!exploreVisible()) return;
  if (document.body.scrollTop <= 0) {
    listAnchor = null;
    return;
  }
  for (const sec of anchorSections()) {
    const rect = sec.getBoundingClientRect();
    if (rect.bottom <= READ_LINE) continue;
    const m = sectionKey(sec);
    listAnchor = m ? { m, top: rect.top } : null;
    return;
  }
  listAnchor = null;
}
function restoreListAnchor(): void {
  if (!listAnchor || !exploreVisible()) return;
  const sec = anchorSections().find((s) => sectionKey(s) === listAnchor?.m);
  if (!sec) return;
  const delta = sec.getBoundingClientRect().top - listAnchor.top;
  if (Math.abs(delta) >= 1) document.body.scrollTop += delta;
}

/** Mark the tree row of the month currently in view, and keep it visible in the
 *  (independently scrolling) tree. Cheap: a handful of rect reads per frame. */
let spyRaf = 0;
/** When the user last clicked in the tree — the spy leaves the tree alone for a
 *  moment afterwards so the row they clicked doesn't slide out from under the pointer. */
let treeClickAt = 0;
function exploreSpy(): void {
  if (activeView() !== "explore" || !exploreSplit()) return;
  const secs = document.querySelectorAll<HTMLElement>("#rideList .rp-month");
  if (!secs.length) return;
  const line = READ_LINE;
  let cur: HTMLElement = secs[0];
  for (const sec of secs) {
    if (sec.getBoundingClientRect().top <= line) cur = sec;
    else break;
  }
  // The section in view is laid out: refresh the row measurement from it, and if
  // it changed, correct every placeholder still waiting.
  if (measureRowHeights()) applyPlaceholderHeights();
  // Scrolled to the very end: the last month can never reach the line, so it wins.
  const scroller = document.body;
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    cur = secs[secs.length - 1];
  }
  const key = cur.dataset.m;
  let row: HTMLElement | null = null;
  for (const box of document.querySelectorAll<HTMLElement>("#months .month")) {
    const on = box.querySelector<HTMLElement>(".mhead")?.dataset.m === key;
    box.classList.toggle("cur", on);
    if (on) row = box;
  }
  const tree = document.getElementById("months");
  if (!row || !tree) return;
  // Keep the current month visible in the tree — unless the pointer is in the tree
  // (the user is reading or about to click it) or they just clicked there.
  if (tree.matches(":hover") || performance.now() - treeClickAt < 1200) return;
  const top = row.offsetTop - tree.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top < tree.scrollTop + 8) tree.scrollTop = Math.max(0, top - 8);
  else if (bottom > tree.scrollTop + tree.clientHeight - 8)
    tree.scrollTop = bottom - tree.clientHeight + 8;
}
// `<body>` is the page's scroll container (full-height body, hidden horizontal
// overflow), so its scroll events never reach `window` — listen on both.
const onPageScroll = (): void => {
  if (spyRaf) return;
  spyRaf = requestAnimationFrame(() => {
    spyRaf = 0;
    exploreSpy();
  });
};
window.addEventListener("scroll", onPageScroll, { passive: true });
document.body.addEventListener("scroll", onPageScroll, { passive: true });
const openStats = new Set<string>();

// Which menu is open, if any: a ride key for a per-ride overflow button, or "state"
// for the consolidated header actions menu. Kept at module scope (like openStats/
// selected) so it survives the frequent re-renders the job ticker triggers.
let openMenu: string | null = null;
// Stats granularity + metric toggles as signals: an effect keeps each segmented
// control's `.active` highlight in sync (one place, replacing the active-class
// loops that were otherwise duplicated in renderStats and the click handler).
const statGran = signal<Granularity | "auto">("auto");
const statMetric = signal<"distance" | "speed">("distance");
effect(() => {
  const g = statGran();
  for (const b of document.querySelectorAll<HTMLButtonElement>("#statGran button")) {
    b.classList.toggle("active", b.dataset.gran === g);
  }
});
effect(() => {
  const m = statMetric();
  for (const b of document.querySelectorAll<HTMLButtonElement>("#statMetric button")) {
    b.classList.toggle("active", b.dataset.metric === m);
  }
});
let lastSig = "";
/** Which rides are queued / running, applied to the DOM in place (rings + `.busy`). */
let lastJobsSig = "";
function jobsSig(): string {
  const { jobs } = STATE;
  return (
    [...(jobs.active_keys ?? [])].sort().join(",") +
    ";" +
    [...(jobs.current ? (jobs.current_keys ?? []) : [])].sort().join(",")
  );
}

// -- Chunked list build ---------------------------------------------------------
// With thousands of rides the right pane is built in slices: the screenful at the
// reading line synchronously, the rest in idle slices of ~12ms so the page never
// blocks. Each pending month's build is keyed, so navigation can build just the
// month it is about to show (buildMonthNow) instead of flushing everything. A render
// cancels any pending slices.
let listBuildCancel: (() => void) | null = null;
const pendingBuilds = new Map<string, () => void>();
function runPending(m: string): void {
  const f = pendingBuilds.get(m);
  if (!f) return;
  pendingBuilds.delete(m);
  f();
}
function scheduleListBuild(order: string[]): void {
  listBuildCancel?.();
  listBuildCancel = runInSlices(order, runPending, {
    onDone: () => {
      listBuildCancel = null;
      exploreSpy();
    },
  });
}
/** Build one month's rows now (a scroll-to needs its target's real rows). */
function buildMonthNow(m: string): void {
  runPending(m);
}
/** Build every pending month now. */
function flushListBuild(): void {
  for (const m of [...pendingBuilds.keys()]) runPending(m);
  listBuildCancel?.();
  listBuildCancel = null;
}
/** The first N rows of the pane are built synchronously (one screenful). */
const SYNC_ROWS = 60;
/** Height of a two-line ride row / a month heading, measured from the rows that are
 *  built (defaults until the first measurement) — placeholders for the months built
 *  later use these so the scrollbar and the scroll position stay honest. */
let rowHeightPx = 61;
let headHeightPx = 40;
/** Each month section of the current list → its ride count (for placeholder heights). */
const sectionRows = new Map<HTMLElement, number>();
/** Measure a row + heading from the section at the reading line — the one that is
 *  laid out (content-visibility skips the rest). True when the numbers changed. */
function measureRowHeights(): boolean {
  let sec: HTMLElement | null = null;
  for (const s of document.querySelectorAll<HTMLElement>("#rideList .rp-month")) {
    if (s.getBoundingClientRect().bottom > READ_LINE) {
      sec = s;
      break;
    }
  }
  const row = sec?.querySelector<HTMLElement>(".rrow:not(:has(.rdetails))");
  const head = sec?.querySelector<HTMLElement>(".rp-head");
  const rh = row?.offsetHeight ?? 0;
  const hh = head?.offsetHeight ?? 0;
  if (!(rh > 0 && hh > 0) || (rh === rowHeightPx && hh === headHeightPx)) return false;
  rowHeightPx = rh;
  headHeightPx = hh;
  return true;
}
/** Honest heights for the months not built yet, from the measured rows, so the
 *  scrollbar is right and nothing shifts when a slice lands. The intrinsic size
 *  stays on every section: an off-screen month skips layout entirely
 *  (content-visibility) and would otherwise snap from a stock guess to its real
 *  height the moment it scrolls into view. */
function applyPlaceholderHeights(): void {
  for (const [sec, n] of sectionRows) {
    const h = n * rowHeightPx + headHeightPx;
    sec.style.containIntrinsicSize = `auto ${h}px`;
    if (!sec.querySelector(".rrow")) sec.style.minHeight = `${h}px`;
  }
}

/** `.rrow[data-key]` lookup. */
function rowEl(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.rrow[data-key="${(window.CSS?.escape ?? cssEscape)(key)}"]`,
  );
}
/** Tracks the per-ride wind-resolved state applied to the DOM, so a weather-only
 *  change can be detected and patched in place (see applyState/applyWeatherUpdate). */
let lastWeatherSig = "";

const yearOf = (mkey: string): string => (mkey || "").slice(0, 4);
/** A group checkbox's tri-state: `true` checked, `false` clear, `null` indeterminate. */
function setChecked(el: HTMLInputElement | null, on: boolean | null): void {
  if (!el) return;
  el.checked = on === true;
  el.indeterminate = on === null;
}
function esc(s: string): string {
  return (s || "").replace(/[^a-zA-Z0-9]/g, "_");
}

// --------------------------------------------------------------------------- //
// Top-level view ("Explore" = the rides list/stats; "Map" = all-rides heatmap).
// Remembered across reloads; defaults to Explore on first run.
// --------------------------------------------------------------------------- //
// View routing (the active-view signal + its persistence) now lives in ./app-state.

// --------------------------------------------------------------------------- //
// Rough-track mini-map (Leaflet). The stored track is a heavily simplified
// polyline — an APPROXIMATION of the route, never the full GPX.
// --------------------------------------------------------------------------- //

// OSM tile-usage credit + the shared interactive-basemap factory live in ./map-core,
// reused by the Map view, the Stats heatmap and (via injected deps) the Timeline and
// Wind-rose maps so every big map shares one look.
const mapRegistry = new Map<string, L.Map>();

/** Markup for a ride's mini-map + its caption. */
function trackBlock(key: string, track: string): string {
  if (!track) {
    return `<div class="rmaphint">No route available for this ride.</div>`;
  }
  return (
    `<div class="rmapwrap">` +
    `<div class="rmap" data-map="${esc(key)}" data-track="${esc(key)}"></div>` +
    `<button class="iconbtn map-expand rmap-expand" data-expand="${escHtml(key)}" aria-label="Expand route" title="Open this route full-screen (Esc to exit)">` +
    `<svg class="mi mi-expand" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
    `</button>` +
    `</div>`
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

/** The ride's tag pills for its meta line (empty string when untagged). */
function rideTagsHtml(r: RideView): string {
  if (!r.tags.length) return "";
  const pills = r.tags.map((t) => `<span class="rtag">${escHtml(t)}</span>`).join("");
  return `<div class="rtags">${pills}</div>`;
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

// Persisted Wind/Speed preferences (see ANALYTICS_PREFS_KEY). The date window is
// stored as raw edge timestamps and re-applied (clamped to the live bounds) on the
// first range computation after load; the two chart filters are mirrored straight
// into their DOM controls at boot.
type AnalyticsPrefs = {
  rangeMin: number | null;
  rangeMax: number | null;
  /** Net-grade (steepness) magnitude band kept (percent |grade|); null = no bound on
   *  that side. Once either bound is set, unknown-grade segments are dropped too. */
  gMin: number | null;
  gMax: number | null;
  /** Average-speed band kept (km/h); null = no bound. A blank max means no GPS-glitch
   *  cap; the default max is 50. */
  sMin: number | null;
  sMax: number | null;
  /** Wind dimension on the X axis: head/tailwind (along-track) or crosswind. */
  xAxis: "along" | "cross";
  /** Which dimension tints the dots (or none). */
  colorBy: "none" | "along" | "cross";
  /** Crosswind band filter (km/h); null = no bound on that side. */
  cwMin: number | null;
  cwMax: number | null;
  /** Headwind band filter (km/h); null = no bound on that side. */
  hwMin: number | null;
  hwMax: number | null;
  /** Tailwind band filter (km/h); null = no bound on that side. */
  twMin: number | null;
  twMax: number | null;
  /** Segment-length band filter (metres); null = no bound. Default min 300. */
  lenMin: number | null;
  lenMax: number | null;
  // Segment-geometry tuning (mirrors the sliders; see windspeed-view).
  lookAheadM: number;
  turnDeg: number;
};
function loadAnalyticsPrefs(): AnalyticsPrefs {
  const def: AnalyticsPrefs = {
    rangeMin: null,
    rangeMax: null,
    gMin: null,
    gMax: null,
    sMin: null,
    sMax: 50,
    xAxis: "along",
    colorBy: "none",
    cwMin: null,
    cwMax: null,
    hwMin: null,
    hwMax: null,
    twMin: null,
    twMax: null,
    lenMin: 300,
    lenMax: null,
    ...SEG_TUNE_DEFAULTS,
  };
  try {
    const raw = localStorage.getItem(ANALYTICS_PREFS_KEY);
    if (!raw) return def;
    const o = JSON.parse(raw) as Partial<AnalyticsPrefs>;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
      Math.max(lo, Math.min(hi, num(v) ?? d));
    return {
      rangeMin: num(o.rangeMin),
      rangeMax: num(o.rangeMax),
      gMin: num(o.gMin),
      gMax: num(o.gMax),
      sMin: num(o.sMin),
      // `"key" in o` distinguishes a user-cleared bound (stored null → keep null) from
      // an absent key (→ the non-null default), so clearing the cap/min isn't undone.
      sMax: "sMax" in o ? num(o.sMax) : 50,
      lenMin: "lenMin" in o ? num(o.lenMin) : 300,
      lenMax: num(o.lenMax),
      xAxis: o.xAxis === "cross" ? "cross" : "along",
      colorBy: o.colorBy === "along" || o.colorBy === "cross" ? o.colorBy : "none",
      cwMin: num(o.cwMin),
      cwMax: num(o.cwMax),
      hwMin: num(o.hwMin),
      hwMax: num(o.hwMax),
      twMin: num(o.twMin),
      twMax: num(o.twMax),
      lookAheadM: clamp(o.lookAheadM, 0, 50, SEG_TUNE_DEFAULTS.lookAheadM),
      turnDeg: clamp(o.turnDeg, 5, 120, SEG_TUNE_DEFAULTS.turnDeg),
    };
  } catch {
    return def; // malformed JSON / storage disabled — fall back to neutral
  }
}
/** Persist the current Wind/Speed window + chart filters (non-fatal if unavailable). */
function saveAnalyticsPrefs(): void {
  try {
    const readNum = (id: string): number | null => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      const v = el && el.value.trim() !== "" ? Number(el.value) : null;
      return v != null && Number.isFinite(v) && v >= 0 ? v : null;
    };
    const segVal = (id: string, d: number): number => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      const v = el ? parseInt(el.value, 10) : d;
      return Number.isFinite(v) ? v : d;
    };
    const activeSeg = (id: string, attr: string): string | undefined =>
      document.querySelector<HTMLElement>(`#${id} button.active[data-${attr}]`)?.dataset[attr];
    const prefs: AnalyticsPrefs = {
      rangeMin: rangeOf("analytics")?.minMs ?? null,
      rangeMax: rangeOf("analytics")?.maxMs ?? null,
      gMin: readNum("gMin"),
      gMax: readNum("gMax"),
      sMin: readNum("sMin"),
      sMax: readNum("sMax"),
      xAxis: activeSeg("analyticsXAxis", "xaxis") === "cross" ? "cross" : "along",
      colorBy: ((): AnalyticsPrefs["colorBy"] => {
        const v = activeSeg("analyticsColorBy", "colorby");
        return v === "along" || v === "cross" ? v : "none";
      })(),
      cwMin: readNum("cwMin"),
      cwMax: readNum("cwMax"),
      hwMin: readNum("hwMin"),
      hwMax: readNum("hwMax"),
      twMin: readNum("twMin"),
      twMax: readNum("twMax"),
      lenMin: readNum("lenMin"),
      lenMax: readNum("lenMax"),
      lookAheadM: segVal("segLookAhead", SEG_TUNE_DEFAULTS.lookAheadM),
      turnDeg: segVal("segTurn", SEG_TUNE_DEFAULTS.turnDeg),
    };
    localStorage.setItem(ANALYTICS_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
}
/** Format a segment-tuning slider's value for its `<output>` (unit per id). */
function segTuneLabel(id: string, value: number): string {
  return id === "segTurn" ? `${value}°` : `${value} m`;
}
/** Write segment-tuning values into their sliders + outputs (shared by restore-on-boot
 *  and the Reset button), keeping each `.uslider` accent fill in sync. */
function setSegTuneDom(v: { lookAheadM: number; turnDeg: number }): void {
  for (const [id, value] of [
    ["segLookAhead", v.lookAheadM],
    ["segTurn", v.turnDeg],
  ] as const) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.value = String(value);
      setSliderFill(el);
    }
    const out = document.getElementById(`${id}Out`) as HTMLOutputElement | null;
    if (out) out.value = segTuneLabel(id, value);
  }
}
/** Mirror the saved chart filters into their DOM controls (called once at boot). */
function applyAnalyticsPrefsToDom(): void {
  const p = loadAnalyticsPrefs();
  const setBand = (id: string, v: number | null): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = v != null ? String(v) : "";
  };
  setBand("gMin", p.gMin);
  setBand("gMax", p.gMax);
  setBand("sMin", p.sMin);
  setBand("sMax", p.sMax);
  setBand("lenMin", p.lenMin);
  setBand("lenMax", p.lenMax);
  // Mirror the saved X-axis + colour-by selections into their segmented controls, then
  // gate the colour options against the X dimension.
  setActiveSeg("analyticsXAxis", "xaxis", p.xAxis);
  setActiveSeg("analyticsColorBy", "colorby", p.colorBy);
  syncColorByGating();
  const cwMin = document.getElementById("cwMin") as HTMLInputElement | null;
  if (cwMin) cwMin.value = p.cwMin != null ? String(p.cwMin) : "";
  const cwMax = document.getElementById("cwMax") as HTMLInputElement | null;
  if (cwMax) cwMax.value = p.cwMax != null ? String(p.cwMax) : "";
  const hwMin = document.getElementById("hwMin") as HTMLInputElement | null;
  if (hwMin) hwMin.value = p.hwMin != null ? String(p.hwMin) : "";
  const hwMax = document.getElementById("hwMax") as HTMLInputElement | null;
  if (hwMax) hwMax.value = p.hwMax != null ? String(p.hwMax) : "";
  const twMin = document.getElementById("twMin") as HTMLInputElement | null;
  if (twMin) twMin.value = p.twMin != null ? String(p.twMin) : "";
  const twMax = document.getElementById("twMax") as HTMLInputElement | null;
  if (twMax) twMax.value = p.twMax != null ? String(p.twMax) : "";
  setSegTuneDom(p);
}
/** Set the active button of a `.seg` segmented control to the one whose `data-*` value
 *  matches `value` (clearing the others). */
function setActiveSeg(id: string, attr: string, value: string): void {
  const seg = document.getElementById(id);
  if (!seg) return;
  for (const btn of seg.querySelectorAll<HTMLElement>(`button[data-${attr}]`)) {
    btn.classList.toggle("active", btn.dataset[attr] === value);
  }
}

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
  const ride = STATE.rides.find((r) => r.key === key);
  if (ride) buildMonthNow(ride.month_key);
  else flushListBuild();
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

/** Reflect the active view in the DOM (visibility, tab state, scan bar). */
function applyView(): void {
  const isMap = activeView() === "map";
  const isStats = activeView() === "stats";
  const isAnalytics = activeView() === "analytics";
  const isClimate = activeView() === "climate";
  const isForecast = activeView() === "forecast";
  const isTimeline = activeView() === "timeline";
  const isRoutes = activeView() === "routes";
  document
    .getElementById("exploreView")
    ?.classList.toggle(
      "hidden",
      isMap || isStats || isAnalytics || isClimate || isForecast || isTimeline || isRoutes,
    );
  document.getElementById("mapView")?.classList.toggle("hidden", !isMap);
  document.getElementById("statsView")?.classList.toggle("hidden", !isStats);
  document.getElementById("analyticsView")?.classList.toggle("hidden", !isAnalytics);
  document.getElementById("climateView")?.classList.toggle("hidden", !isClimate);
  document.getElementById("forecastView")?.classList.toggle("hidden", !isForecast);
  document.getElementById("timelineView")?.classList.toggle("hidden", !isTimeline);
  document.getElementById("routesView")?.classList.toggle("hidden", !isRoutes);
  if (!isMap && document.body.classList.contains("map-expanded")) setMapExpanded(false);
  if (!isStats && document.body.classList.contains("heat-expanded")) setHeatExpanded(false);
  if (!isMap && mapAreaSelect.isArmed()) mapAreaSelect.setMode(false);
  if (!isStats && heatAreaSelect.isArmed()) heatAreaSelect.setMode(false);
  // Stop watching the device position when its map leaves the screen.
  if (!isMap && mapLocate.isActive()) mapLocate.setActive(false);
  if (!isStats && heatLocate.isActive()) heatLocate.setActive(false);
  if (!isClimate) leaveClimateView();
  if (!isForecast) leaveForecastView();
  if (!isTimeline) leaveTimelineView();
  if (!isRoutes) leaveRoutesView();
  // The subtitle belongs to the view: Explore writes its ride count on render, the
  // Wind rose its dataset line on mount; every other view shows none.
  if (activeView() !== "explore" && !isClimate) setViewSubtitle("");
  syncShell();
}

function routeForView(view: ViewName): Route {
  if (view === "forecast") {
    const point = forecastPoint();
    return { view, point: point && validRoutePoint(point) ? point : undefined };
  }
  if (view === "climate") {
    const point = climatePoint();
    return { view, point: point && validRoutePoint(point) ? point : undefined };
  }
  return { view };
}

function onRoutedPointChange(view: "forecast" | "climate", point: RoutePoint): void {
  if (activeView() === view && validRoutePoint(point)) writeRoute({ view, point }, "replace");
}

/** Apply Back/Forward, pasted links and manual edits to the hash. */
function applyHashRoute(): void {
  const route = parseRoute(window.location.hash);
  const target = route ?? routeForView(activeView());
  if (target.view === "forecast") setForecastRoutePoint(target.point ?? null);
  if (target.view === "climate") setClimateRoutePoint(target.point ?? null);
  writeRoute(target, "replace"); // normalize invalid routes and coordinate precision
  captureListAnchor(); // where the Explore list was, to land there on return
  if (!setActiveView(target.view)) return;
  keepAnchor = true;
  applyView();
  render();
  trackView(target.view);
}

/** Switch the active view, persist the choice, and add a browser history entry. */
function setView(v: ViewName): void {
  captureListAnchor(); // where the Explore list was, to land there on return
  if (!setActiveView(v)) return;
  keepAnchor = true;
  writeRoute(routeForView(v), "push");
  applyView();
  render();
  trackView(v); // privacy-friendly per-view usage signal (GoatCounter)
}

/**
 * Whether the Stats figures are a narrowed subset — either the date slider is below
 * the full span or the global ride filters are active — and if so a compact label.
 * Returns "" when neither narrows, so the header flag stays hidden.
 */
function statsFilteredFlag(): string {
  const filtersOn = filterActiveCount(filters) > 0;
  const label = rangeWindowLabel("stats");
  if (!label && !filtersOn) return "";
  if (!label) return "filtered";
  return `filtered · ${label}`;
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
 * Per-ride queue-state badge: "working" while a task runs, "queued" while pending.
 */
/** Class + tooltip for a ride's status ring (`.rring`): spinning while a job works
 *  on it, dotted while it waits. The element is created once per row and only its
 *  class flips (applyJobUpdate), so the spin animation never restarts. */
function ringAttrs(key: string): string {
  if (RUNNING.has(key)) return `class="rring working" title="Working on this ride…"`;
  if (ACTIVE.has(key)) return `class="rring queued" title="Queued — waiting its turn"`;
  return `class="rring"`;
}
/** The inner HTML of a ride's title row (`.rtitle`): source marker, name + location,
 *  and the status badges. One canonical builder so the full-list render and the
 *  lightweight in-place wind-badge update (applyWeatherUpdate) stay identical. */
/** A ride row's meta line: when · distance · duration (checked detail stats fill in
 *  for rides the list scan never captured, so a Checked ride shows numbers, not "?"). */
function rmetaHtml(r: RideView): string {
  const distance =
    r.distance_km != null && r.distance_km > 0 ? fmtKmDetail(r.distance_km) : "?";
  const duration =
    r.elapsed_sec != null
      ? fmtDurationExact(r.elapsed_sec)
      : r.moving_sec != null
        ? fmtDurationExact(r.moving_sec)
        : "?";
  // The zone tag "(UTC+1 · London)" is its own span: phones fold it away (the
  // title tooltip keeps the full breakdown).
  const when = rideWhen(r);
  const cut = when.indexOf(" (");
  const day = cut > 0 ? when.slice(0, cut) : when;
  const zone = cut > 0 ? `<span class="rmeta-tz">${escHtml(when.slice(cut))}</span>` : "";
  return `${escHtml(day)}${zone} · ${distance} · ${duration}`;
}

/** The per-ride ⋯ menu entries — built only when that menu opens (see syncOpenMenu). */
function rideMenuHtml(r: RideView): string {
  return `              ${r.can_upload ? `<button class="small ghost" data-act="upload-one" data-key="${r.key}"${r.status === "uploaded" ? ' disabled title="Already uploaded to Strava"' : ' title="Push this ride to Strava (via Beeline)"'}>${icon("upload")}Push to Strava</button>` : ""}
              ${r.strava_activity_id ? `<button class="small ghost" data-act="strava-open-one" data-key="${r.key}" title="Open this ride on Strava in a new tab">${icon("external")}Show in Strava</button>` : ""}
              <button class="small ghost" data-act="gpx-save-one" data-key="${r.key}" title="Save the route-only GPX (the stored shape — no timestamps or elevation; instant, works offline)">${icon("download")}Save route GPX</button>
              <button class="small ghost" data-act="gpx-save-full-one" data-key="${r.key}" title="Download the full recorded GPX (real timestamps + elevation) and save it to disk">${icon("download")}Save full GPX</button>
              <button class="small ghost" data-act="gpx-fetch-one" data-key="${r.key}" title="${r.gpx_cached ? "Full GPX is cached — fetch again to refresh it (no file saved)" : "Fetch the full recorded GPX into the local cache without saving a file (pre-warms offline use + the map)"}">${icon("cloudDown")}${r.gpx_cached ? "Fetch full GPX ✓" : "Fetch full GPX"}</button>
              <button class="small ghost" data-act="resolve-wind-one" data-key="${r.key}" title="${controller.hasResolvedWind(r.key) ? "Historical wind is resolved — open the map and choose Show wind, or resolve again to refresh" : "Resolve historical wind (from Open-Meteo) for this ride — colours its big map by head/tailwind"}">${icon("wind")}${controller.hasResolvedWind(r.key) ? "Resolve wind ✓" : "Resolve wind"}</button>
              <button class="small ghost" data-act="tags-one" data-key="${r.key}" title="Add or remove tags for this ride">${icon("tag")}Tags…</button>
              ${r.deleted ? "" : `<button class="small ghost" data-act="rename-one" data-key="${r.key}" title="Rename this ride">${icon("pencil")}Rename…</button>`}
              ${r.deleted || r.source !== "gpx" ? "" : `<button class="small ghost" data-act="destination-one" data-key="${r.key}" title="Set or edit this ride's destination (the place it went to)">${icon("pin")}${r.location.trim() ? "Edit destination…" : "Set destination…"}</button>`}
              ${r.deleted ? "" : `<button class="small danger" data-act="delete-one" data-key="${r.key}" title="Delete this ride">${icon("trash")}Delete…</button>`}
              ${r.deleted ? `<button class="small danger" data-act="drop-one" data-key="${r.key}" title="Permanently remove this deleted ride (and its stored GPX) from this device">${icon("trash")}Drop from library</button>` : ""}`;
}

function rtitleHtml(r: RideView, multiSource: boolean): string {
  return (
    sourceMark(r.source, multiSource) +
    `<span class="rname"><span class="rtitle-text">${r.title || "Ride"}</span>` +
    `${r.location ? `<span class="rtitle-loc">${r.location}</span>` : ""}</span> ` +
    `${rideTagsHtml(r)}` +
    `${r.source !== "gpx" && r.gpx_cached ? cachedBadge() : ""} ` +
    `${r.wind_resolved ? windBadge() : ""} ` +
    `${r.deleted ? deletedBadge() : ""} `
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

/** Push persisted trim percentages into the sliders/outputs (skip a slider being dragged). */
function syncTrimControls(): void {
  const slow = $<HTMLInputElement>("#trimSlow");
  const fast = $<HTMLInputElement>("#trimFast");
  const slowPct = trimSlowPct();
  const fastPct = trimFastPct();
  if (document.activeElement !== slow) slow.value = String(slowPct);
  if (document.activeElement !== fast) fast.value = String(fastPct);
  setSliderFill(slow);
  setSliderFill(fast);
  ($("#trimSlowOut") as HTMLOutputElement).value = `${slowPct}%`;
  ($("#trimFastOut") as HTMLOutputElement).value = `${fastPct}%`;
}

/** Trim percentages being dragged (null = the persisted settings). The sliders'
 *  `input` ticks redraw only the chart with these; the store is written once on
 *  `change`, which then runs the one full render for the whole drag. */
let liveTrim: { slow: number; fast: number } | null = null;
const trimSlowPct = (): number => liveTrim?.slow ?? STATE.settings.speedTrimSlowPct;
const trimFastPct = (): number => liveTrim?.fast ?? STATE.settings.speedTrimFastPct;

function renderStats(rides: AppState["rides"]): void {
  const panel = $("#statsPanel");
  if (!rides.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const g = statGran();
  const gran: Granularity =
    g === "auto"
      ? autoGranularity(
          rides.map((r) => ({ key: r.date_key })),
          chartBuckets(),
        )
      : g;

  // Outlier-trim sliders belong to the speed view only.
  $("#spTrim").classList.toggle("hidden", statMetric() !== "speed");
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
    const [bkey, label, short] = bucketRide(r.date_key, gran);
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
  // A time axis must not skip quiet periods: fill every day / week / month / year
  // between the first and last ride with an empty bucket, so gaps show as gaps
  // (and the per-period averages divide by the real number of periods).
  fillEmptyBuckets(byM, rides, gran);
  const items = [...byM.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const slowPct = trimSlowPct();
  const fastPct = trimFastPct();
  const bucketSpeed = (e: StatBucket): number => trimmedSpeed(e.rides, slowPct, fastPct);

  if (statMetric() === "speed") {
    renderSpeed(gran, items, bucketSpeed, rides.length, slowPct, fastPct);
  } else {
    renderDistance(gran, items, rides.length);
  }
}

/** Add zero buckets for the periods between the earliest and latest ride. */
function fillEmptyBuckets(
  byM: Map<string, StatBucket>,
  rides: ReadonlyArray<{ date_key: string }>,
  gran: Granularity,
): void {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rides) {
    const t = rideDatetime(r.date_key)?.getTime();
    if (t == null) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  const step = (d: Date): void => {
    if (gran === "day") d.setDate(d.getDate() + 1);
    else if (gran === "week") d.setDate(d.getDate() + 7);
    else if (gran === "month") d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
  };
  const d = new Date(min);
  d.setHours(12, 0, 0, 0); // noon: DST shifts can't push a step across a day boundary
  // Month / year steps start from the 1st, so a first ride on the 31st can't make
  // `setMonth` overflow past a short month and skip it.
  if (gran === "month" || gran === "year") d.setDate(1);
  if (gran === "year") d.setMonth(0);
  for (let guard = 0; d.getTime() <= max && guard < 20000; guard++) {
    const [bkey, label, short] = bucketRide(beelineRideKey(d.getTime()), gran);
    if (!byM.has(bkey))
      byM.set(bkey, { label, short, km: 0, n: 0, spKm: 0, spSec: 0, spN: 0, rides: [] });
    step(d);
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

  setChartDensity(items.length);
  $("#chart").innerHTML = items
    .map(([, e], i) => {
      const h = Math.round((e.km / maxKm) * CHART_BAR_PX);
      return `<div class="col${labelClass(i, items.length)}" title="${e.label}: ${e.km.toFixed(1)} km over ${e.n} rides">
      <span class="cval">${Math.round(e.km)}</span>
      <div class="bar" style="height:${h}px"></div>
      <span class="clab">${e.short}</span>
    </div>`;
    })
    .join("");
}

/** Tallest bar in the Explore chart, px. */
const CHART_BAR_PX = 118;

/** Crowded charts (many days/weeks) drop the per-bar values (CSS, `.dense`). */
function setChartDensity(buckets: number): void {
  $("#chart").classList.toggle("dense", buckets > 20);
}

/** Label every Nth bar so the axis stays legible: at most ~14 labels, the first
 *  always, the last whenever it doesn't collide with the previous labelled bar. */
function labelClass(index: number, count: number): string {
  const every = Math.max(1, Math.ceil(count / 14));
  const labelled = index % every === 0 || (index === count - 1 && (count - 1) % every >= 2);
  return labelled ? "" : " nolab";
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

  setChartDensity(items.length);
  $("#chart").innerHTML = items
    .map(([, e], i) => {
      const v = bucketSpeed(e);
      const cls = `col${labelClass(i, items.length)}`;
      if (e.spN === 0) {
        return `<div class="${cls}" title="${e.label}: no speed data">
      <span class="cval">—</span>
      <div class="bar empty" style="height:2px"></div>
      <span class="clab">${e.short}</span>
    </div>`;
      }
      const h = Math.round((v / maxSpeed) * CHART_BAR_PX);
      return `<div class="${cls}" title="${e.label}: ${v.toFixed(1)} km/h over ${e.spN} rides">
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

  // The state is a caption under the Sources label (dot + short text); the full
  // story goes in the title. Grey, never red: signed-out is the designed resting
  // state — the password is deliberately not stored, and "Pull from Beeline" signs
  // you in on demand.
  let conn: "on" | "demo" | "off" | "none" = "none";
  if (isDemo) {
    conn = "demo";
    el.textContent = "Beeline · demo";
    el.title = "A simulated Beeline account. Open Sources to leave the demo.";
  } else if (STATE.connected) {
    conn = "on";
    el.textContent = "Beeline · connected";
    el.title = STATE.device ? `Connected as ${STATE.device}` : "Connected to Beeline";
  } else if (usesBeeline) {
    // Cached Beeline rides without a live account. No dedicated "Sign in" button:
    // "Pull from Beeline" routes through the re-auth gate (withBeelineAccess), so
    // clicking it signs in (via the password manager) and pulls in one step.
    conn = "off";
    el.textContent = "Beeline · offline";
    el.title =
      "Showing cached Beeline rides — not signed in. Pull from Beeline signs you in and syncs.";
  } else {
    // Pure-GPX (or empty): no Beeline footprint, so no account caption at all.
    el.title = "";
  }
  el.className = `cstate ${conn === "none" ? "off" : conn}`;
  el.style.display = conn === "none" ? "none" : "";
  el.setAttribute("aria-label", el.title || el.textContent || "");
  sourceBtn.dataset.conn = conn;

  // The whole-history "Re-sync" pull is a Beeline-account action; hide it entirely
  // for non-Beeline users (GPX rides come from import, not a sync).
  if (scanBtn) scanBtn.style.display = usesBeeline ? "" : "none";

  // The one Beeline scan action pulls the whole history at once: "Pull from Beeline".
  const scanLabel = document.getElementById("scanLabel");
  if (scanLabel) scanLabel.textContent = "Pull from Beeline";

  // Keep the Sources dialog's Beeline card in step with the live connection.
  renderSources();
}

/** The top-bar selection toolbar: shown while anything is selected; every batch
 *  action states the subset it will act on and hides when that subset is empty. */
/** The Actions menu (below 1700px the batch actions fold into it). */
function setSelMenu(open: boolean): void {
  const bar = document.getElementById("selBar");
  if (!bar) return;
  bar.classList.toggle("menu-open", open);
  document.getElementById("selMore")?.setAttribute("aria-expanded", String(open));
}
// Capture phase: the menu closes on any click — after the action's own handler has
// the click (closing only hides the menu; the target is still the action button).
document.addEventListener(
  "click",
  (e) => {
    const t = e.target as HTMLElement;
    if (t.closest?.("#selMore")) {
      setSelMenu(!document.getElementById("selBar")?.classList.contains("menu-open"));
      return;
    }
    if (document.getElementById("selBar")?.classList.contains("menu-open")) {
      setTimeout(() => setSelMenu(false), 0);
    }
  },
  true,
);

function renderSelectionBar(allRides: AppState["rides"]): void {
  const byKey = new Map(allRides.map((r) => [r.key, r]));
  // Keys that no longer resolve (a replaced library, dropped tombstones) go — but only
  // once rides exist: while the store is still loading, every key would look stale.
  if (allRides.length) for (const k of selected) if (!byKey.has(k)) selected.delete(k);
  persistSelection();
  const nSel = allRides.length ? selected.size : 0;
  document.getElementById("selBar")?.classList.toggle("hidden", nSel === 0);
  document.body.classList.toggle("has-sel", nSel > 0);
  const label = document.getElementById("selGroupLabel");
  if (label) label.textContent = `${nSel} selected`;
  // One ride picked: say how to get the rest quickly (pointer devices only, via CSS).
  document.getElementById("selHint")?.classList.toggle("hidden", nSel !== 1);
  if (nSel === 0) {
    setSelMenu(false);
    return;
  }
  const selRides = [...selected].map((k) => byKey.get(k)).filter((r): r is RideView => !!r);
  const setSelAction = (id: string, count: number, text: string): void => {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) return;
    btn.style.display = count ? "" : "none";
    const span = btn.querySelector<HTMLElement>(":scope > .btn-label");
    if (span) span.textContent = text;
    btn.title = text; // the label folds to the icon on narrow bars
  };
  // Push: only upload-capable rides not already on Strava — "Push 3 rides to Strava"
  // under "5 selected" makes the 2 skipped rides self-evident.
  const pushable = selRides.filter((r) => r.can_upload && r.status !== "uploaded").length;
  setSelAction(
    "btnUploadSel",
    pushable,
    pushable === 1 ? "Push 1 ride to Strava" : `Push ${pushable} rides to Strava`,
  );
  const toFetch = selRides.filter((r) => !r.gpx_cached).length;
  setSelAction(
    "btnGpxFetchSel",
    toFetch,
    toFetch === 1 ? "Fetch full GPX for 1 ride" : `Fetch full GPX for ${toFetch} rides`,
  );
  const toWind = selRides.filter((r) => r.track && !controller.hasResolvedWind(r.key)).length;
  setSelAction(
    "btnResolveWindSel",
    toWind,
    toWind === 1 ? "Resolve wind for 1 ride" : `Resolve wind for ${toWind} rides`,
  );
  const live = selRides.filter((r) => !r.deleted).length;
  setSelAction("btnDeleteSel", live, live === 1 ? "Delete 1 ride" : `Delete ${live} rides`);
}

function render(): void {
  listBuildCancel?.(); // cancel any pending list slices — this render rebuilds everything
  listBuildCancel = null;
  if (!keepAnchor) captureListAnchor();
  keepAnchor = false;
  renderConn();
  const allRides = STATE.rides;
  const rides = visibleRides(filters, allRides);
  const jobs = STATE.jobs;
  ACTIVE = new Set(jobs.active_keys || []);
  RUNNING = new Set(jobs.current ? jobs.current_keys || [] : []);

  // Filter button: only useful once there are rides to narrow.
  document.querySelector(".filterwrap")?.classList.toggle("hidden", allRides.length === 0);
  if (allRides.length === 0 && isFilterPanelOpen()) setFilterPanel(false);
  syncFilterBar(allRides);

  // Empty state: distinguish "no rides at all" from "filters hid everything".
  const emptyEl = $("#empty") as HTMLElement;
  if (allRides.length === 0) {
    emptyEl.style.display = ""; // the stylesheet's centred .pane-empty
    // Light onboarding: one line on the model (a library fed by sources), then the
    // two ways in as plain buttons + a demo link. Kept minimal on purpose.
    emptyEl.innerHTML =
      `<div class="onb">` +
      `<h2 class="onb-title">Your ride library is empty</h2>` +
      `<p class="onb-lede">Fill it from a <b>source</b> — your Beeline account or your own GPX files.</p>` +
      `<div class="onb-cta">` +
      `<button class="primary small" id="emptyConnect">${icon("login")}Connect Beeline</button>` +
      `<button class="ghost small" id="emptyAddGpx">${icon("folder")}Add GPX files…</button>` +
      `</div>` +
      `<p class="onb-foot">Just exploring? <a href="#" id="emptyDemo">Try the demo</a>.</p>` +
      `</div>`;
  } else if (rides.length === 0) {
    emptyEl.style.display = "";
    emptyEl.innerHTML =
      '<div class="onb">No rides match the current filters. <a href="#" id="emptyClear">Clear filters</a></div>';
  } else {
    emptyEl.style.display = "none";
  }
  // The inline stats panel reflects the active filters, like the group rows below —
  // narrowing the library narrows its chart + KPIs too (empty when filters hide all).
  renderStats(rides);

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
  // The library's size sits in the top bar's subtitle, beside the view title.
  if (activeView() === "explore") setViewSubtitle(`${shown}${del ? ` · ${del} deleted` : ""}`);
  renderSelectionBar(allRides);
  // The global "Drop deleted" purges every tombstone — show it only when at least one
  // deleted ride exists anywhere, and stamp the count into its label.
  const dropAllBtn = document.getElementById("btnDropDeleted") as HTMLButtonElement | null;
  if (dropAllBtn) {
    const delAll = allRides.filter((r) => r.deleted).length;
    dropAllBtn.style.display = delAll ? "" : "none";
    dropAllBtn.textContent = `Drop ${delAll} deleted`;
  }
  // The Strava-status filter is Beeline-only; hide it when no ride can be pushed
  // (a pure-GPX library).
  document.getElementById("fStatus")?.classList.toggle("hidden", !hasUploadable);
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
    const forecastCount = forecastStore?.count ?? 0;
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
    if (cacheCount || windCount || forecastCount) {
      rows.push(sub("Caches"));
      if (cacheCount)
        rows.push(row("Beeline tracks", fmtBytes(controller.gpxCacheBytes()), "gpx"));
      if (windCount)
        rows.push(row("Wind cache", fmtBytes(controller.windCacheBytes()), "wind"));
      if (forecastCount)
        rows.push(
          row("Forecast cache", fmtBytes(forecastStore?.totalBytes() ?? 0), "forecast"),
        );
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
  const split = exploreSplit();
  const pane = $("#rideList");
  pane.innerHTML = "";
  $("#exploreSplit").classList.toggle("split", split);
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
  /** Build the rows of one month into `rowsEl` (shared by the sync + idle slices). */
  const buildRows = (rowsEl: Element, list: RideView[]): void => {
    for (const r of list) {
      const so = openStats.has(r.key);
      // Fall back to checked detail stats when the list scan never captured the
      // summary figures, so a Checked ride shows real numbers instead of "?".
      const el = document.createElement("div");
      el.className = `rrow${r.deleted ? " deleted" : ""}${selected.has(r.key) ? " sel" : ""}${RUNNING.has(r.key) ? " busy" : ""}`;
      el.dataset.key = r.key;
      el.innerHTML = `
        <input type="checkbox" class="chk" data-key="${r.key}" ${selected.has(r.key) ? "checked" : ""} title="Select · Shift+click selects the range from the last pick">
        <div class="rmain">
          <div class="rtitle"><span class="rtitle-main">${rtitleHtml(r, multiSource)}</span><span ${ringAttrs(r.key)} aria-hidden="true"></span></div>
          <div class="rmeta" title="${escHtml(rideTimesTitle(r))}">${rmetaHtml(r)}</div>
          ${so ? `<div class="rdetails">${detailsBlock(r)}</div>` : ""}
        </div>
        <div class="rbtns${openMenu === `ovr-r:${r.key}` ? " open" : ""}">
          <button class="small ghost ovr" data-splitmenu="ovr-r:${r.key}" aria-haspopup="true" aria-expanded="${openMenu === `ovr-r:${r.key}`}" title="More ride actions">${KEBAB_ICON}</button>
          <span class="ovr-items">${openMenu === `ovr-r:${r.key}` ? rideMenuHtml(r) : ""}</span>
        </div>`;
      rowsEl.appendChild(el);
    }
  };
  // Split layout: the month at the reading line (the anchor) and those after it are
  // built first, synchronously, up to one screenful; the rest wait for idle slices —
  // months below the screen in order, then the ones above it nearest-first.
  const deferredBelow: string[] = [];
  const deferredAbove: string[] = [];
  pendingBuilds.clear();
  sectionRows.clear();
  const anchorM = split && listAnchor && byMonth.has(listAnchor.m) ? listAnchor.m : null;
  let reached = anchorM === null;
  let builtSync = 0;
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
        <input type="checkbox" class="selall" data-selyear="${year}">
        <span class="ytitle">${year}</span>
        ${volumeBar(ykm, maxYearKm)}
        <span class="ymeta">${yRides.length} rides · ${fmtKm(ykm)}</span>
      </div>
      <div class="ybody" ${yOpen ? "" : 'style="display:none"'}></div>`;
    root.appendChild(ybox);
    setChecked(ybox.querySelector(".selall"), ySel);
    if (split) {
      const yh = document.createElement("div");
      yh.className = "rp-year";
      yh.dataset.y = String(year);
      yh.innerHTML = `<b>${year}</b><span class="mmeta">${yRides.length} rides · ${fmtKm(ykm)}</span>`;
      pane.appendChild(yh);
    }

    const ybody = ybox.querySelector(".ybody")!;
    for (const [mkey, m] of ymonths) {
      m.rides.sort(compareRidesByDateDesc);
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
      box.className = `month${isOpen ? " open" : ""}${menuHere ? " menu-open" : ""}`;
      box.innerHTML = `
        <div class="mhead" data-m="${mkey}">
          <span class="caret${isOpen ? " open" : ""}" aria-hidden="true"></span>
          <input type="checkbox" class="selall" data-selmonth="${mkey}">
          <span class="mtitle">${m.label}</span>
          ${volumeBar(mkm, maxMonthKm)}
          <span class="mmeta">${m.rides.length} rides · ${fmtKm(mkm)}</span>
        </div>
        ${split ? "" : `<div class="rows ${isOpen ? "open" : ""}"></div>`}`;
      ybody.appendChild(box);
      setChecked(box.querySelector(".selall"), mSel);

      // Split layout: every month's rows go into the continuous right pane under a
      // sticky month heading. Otherwise the rows live inside the month box,
      // shown/hidden by `.rows.open`.
      let rowsEl: Element;
      if (split) {
        const sec = document.createElement("section");
        sec.className = "rp-month";
        sec.dataset.m = mkey;
        sec.innerHTML =
          `<div class="rp-head"><b>${m.label}</b><span class="mmeta">${m.rides.length} rides · ${fmtKm(mkm)}</span></div>` +
          `<div class="rows open"></div>`;
        pane.appendChild(sec);
        rowsEl = sec.querySelector(".rows")!;
      } else {
        rowsEl = box.querySelector(".rows")!;
      }
      if (split) {
        if (mkey === anchorM) reached = true;
        const sec = rowsEl.closest<HTMLElement>(".rp-month")!;
        sectionRows.set(sec, m.rides.length);
        if (reached && builtSync < SYNC_ROWS) {
          buildRows(rowsEl, m.rides);
          builtSync += m.rides.length;
        } else {
          const el = rowsEl;
          (reached ? deferredBelow : deferredAbove).push(mkey);
          pendingBuilds.set(mkey, () => {
            // A month above the viewport that is laid out (near enough to render)
            // changes height as its placeholder becomes rows — keep the page still.
            const above = sec.getBoundingClientRect().bottom < 0;
            const h0 = above ? sec.offsetHeight : 0;
            buildRows(el, m.rides);
            sec.style.minHeight = "";
            if (above) {
              const d = sec.offsetHeight - h0;
              if (d) document.body.scrollTop += d;
            }
          });
        }
      } else if (isOpen) {
        buildRows(rowsEl, m.rides); // closed months' rows are hidden anyway — skip them
      }
    }
  }
  if (split) {
    applyPlaceholderHeights();
    restoreListAnchor();
    // The anchor month is in view now, so its rows measure — if that corrects the
    // placeholders, the anchor moves and is put back once more.
    if (measureRowHeights()) {
      applyPlaceholderHeights();
      restoreListAnchor();
    }
  } else {
    restoreListAnchor();
  }
  scheduleListBuild([...deferredBelow, ...deferredAbove.reverse()]);
  if (split) exploreSpy();
  renderJob();
  if (activeView() === "map") mountMapView();
  else if (activeView() === "stats") mountStatsView();
  // The wrapper coalesces a re-entrant call into one post-sweep refresh, so a passive
  // re-render (a background job ticking ride state) never restarts a live sweep.
  else if (activeView() === "analytics") void mountWindSpeedView();
  else if (activeView() === "climate") mountClimateView();
  else if (activeView() === "forecast") void mountForecastView();
  else if (activeView() === "timeline") mountTimelineView();
  else if (activeView() === "routes") mountRoutesView();
  else mountMaps();
  // The consolidated actions menu lives in static markup (not rebuilt here), so
  // sync its open state from the shared `openMenu` flag.
  syncOpenMenu();
  // First paint is done with real state — drop the boot guard that kept the static
  // header's Beeline connection chrome hidden, so it never flashed in then out.
  document.body.classList.remove("booting");
  lastSig = stateSig();
  lastRowSigs = rowSigs();
  lastJobsSig = jobsSig();
  lastWeatherSig = weatherSig();
  lastWeatherByKey = new Map(STATE.rides.map((r) => [r.key, !!r.wind_resolved]));
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
  applySelection();
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

// Styled confirm/prompt/consent dialogs live in ./confirm (initConfirm wires their
// own listeners; the app's global keydown still calls the imported closeConfirm).

function stateSig(): string {
  // STRUCTURE only: which rides are listed, in which groups, and everything that
  // shapes the list around them. A ride's own fields (title, status, cached GPX…)
  // are diffed per row instead (rowSigs → applyRowUpdates), so a job completing one
  // ride never rebuilds 2,000 rows. Jobs (rings) and weather (badges) are patched
  // in place too. Never serialise the `track` polyline.
  const { jobs, rides, ...rest } = STATE;
  void jobs;
  const vis = visibleRides(filters, rides);
  const structure = vis
    .map((r) => `${r.key}|${r.month_key}|${r.deleted ? 1 : 0}|${r.distance_km ?? ""}`)
    .join(";");
  let deleted = 0;
  const sources = new Set<string>();
  for (const r of rides) {
    if (r.deleted) deleted++;
    sources.add(r.source);
  }
  return (
    JSON.stringify(rest) +
    "#" +
    structure +
    `#${deleted}#${sources.size}` +
    "|" +
    [...selected].sort().join(",") +
    "|" +
    [...openMonths].sort().join(",") +
    "|" +
    [...openYears].sort().join(",") +
    "|" +
    [...openStats].sort().join(",") +
    "|" +
    JSON.stringify(filters) +
    `|${exploreSplit() ? "split" : "stack"}:${chartBuckets()}`
  );
}
/** Per-ride row signature: everything a row shows except the structural bits above,
 *  the polyline and the weather flag (each handled by its own in-place patch). */
function rowSigs(): Map<string, string> {
  return new Map(
    STATE.rides.map((r) => {
      const { track, wind_resolved, wind_speed_kmh, ...x } = r;
      void track;
      void wind_resolved;
      void wind_speed_kmh;
      return [r.key, JSON.stringify(x)];
    }),
  );
}
let lastRowSigs = new Map<string, string>();
/** Patch the rows whose own fields changed (title, status, cached-GPX badge, meta)
 *  without rebuilding the list. A changed ride whose details block is open falls back
 *  to a full render (the block is bespoke). */
function applyRowUpdates(): void {
  const next = rowSigs();
  const multiSource = new Set(STATE.rides.map((r) => r.source)).size > 1;
  let touched = 0;
  for (const r of STATE.rides) {
    if (lastRowSigs.get(r.key) === next.get(r.key)) continue;
    if (openStats.has(r.key)) {
      lastRowSigs = next;
      render();
      return;
    }
    const row = rowEl(r.key);
    if (!row) continue; // not built yet / off the list
    const main = row.querySelector<HTMLElement>(".rtitle-main");
    const html = rtitleHtml(r, multiSource);
    if (main && main.innerHTML !== html) main.innerHTML = html;
    const meta = row.querySelector<HTMLElement>(".rmeta");
    if (meta) {
      const m = rmetaHtml(r);
      if (meta.innerHTML !== m) meta.innerHTML = m;
      meta.title = rideTimesTitle(r);
    }
    row.classList.toggle("deleted", !!r.deleted);
    touched++;
  }
  lastRowSigs = next;
  if (touched) {
    // The toolbar's subset counts ("Fetch full GPX for N rides") follow the rows.
    if (selected.size) renderSelectionBar(STATE.rides);
    syncFilterBar(STATE.rides);
  }
}

/** Signature of just the per-ride wind-resolved state, so a weather-only change can
 *  be applied in place (badges) without a full, map-remounting list rebuild. */
function weatherSig(): string {
  return STATE.rides.map((r) => (r.wind_resolved ? "1" : "0")).join("");
}

/** Re-read controller state and re-render if anything visible changed. */
// A burst of store notifications (a sync upserting hundreds of rides, a job
// reporting per item) must not render the 2,000-row list once per notification:
// the state snapshot is taken immediately, the paint is coalesced to one per frame.
let applyRaf = 0;
function applyState(): void {
  if (applyRaf) return;
  applyRaf = requestAnimationFrame(() => {
    applyRaf = 0;
    const t0 = performance.now();
    STATE = controller.state();
    performance.measure("ui:snapshot", { start: t0 });
    paintState();
  });
}
/** Time a paint-path step (User Timing: visible in DevTools and to the perf harness). */
function timed<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    performance.measure(name, { start: t0 });
  }
}
function paintState(): void {
  // Keep the open big-map wind overlay live as resolution lands, even when the main
  // list signature hasn't changed (the per-point overlay isn't part of STATE).
  refreshOpenRideMapWind();
  // Always refresh the lightweight job bar (it ticks on every job `report`), but only
  // run the full, map-remounting render() when list-relevant state actually changed —
  // so job progress updates never flicker the maps.
  renderJob();
  if (timed("ui:sig", stateSig) !== lastSig) {
    timed("ui:render", render);
    return;
  }
  // A ride's own fields changed (a fetch landed, a status came back) — patch its row.
  timed("ui:rows", applyRowUpdates);
  // Which rides a job touches changes on every item — patch the rings in place.
  const js = jobsSig();
  if (js !== lastJobsSig) {
    lastJobsSig = js;
    timed("ui:jobs", applyJobUpdate);
  }
  // Structure unchanged — apply any weather-only change (a ride resolved its wind) in
  // place, without rebuilding the list (which would remount + flicker the maps).
  const wsig = timed("ui:wsig", weatherSig);
  if (wsig !== lastWeatherSig) {
    lastWeatherSig = wsig;
    timed("ui:weather", applyWeatherUpdate);
  }
}

/** Apply a queued / running change in place: the ring in each affected title and
 *  the row's `.busy` sweep — no list rebuild (2,000 rows per job tick is a freeze). */
function applyJobUpdate(): void {
  const jobs = STATE.jobs;
  const nextActive = new Set(jobs.active_keys || []);
  const nextRunning = new Set(jobs.current ? jobs.current_keys || [] : []);
  const touched = new Set([...ACTIVE, ...RUNNING, ...nextActive, ...nextRunning]);
  ACTIVE = nextActive;
  RUNNING = nextRunning;
  if (!touched.size) return;
  const multiSource = new Set(STATE.rides.map((r) => r.source)).size > 1;
  const byKey = new Map(STATE.rides.map((r) => [r.key, r]));
  void multiSource;
  for (const key of touched) {
    const row = byKey.has(key) ? rowEl(key) : null;
    if (!row) continue;
    row.classList.toggle("busy", RUNNING.has(key));
    const ring = row.querySelector<HTMLElement>(".rring");
    if (!ring) continue;
    const cls = RUNNING.has(key)
      ? "rring working"
      : ACTIVE.has(key)
        ? "rring queued"
        : "rring";
    // Same class → leave it alone: re-setting it would restart the spin animation.
    if (ring.className !== cls) {
      ring.className = cls;
      ring.title = RUNNING.has(key)
        ? "Working on this ride…"
        : ACTIVE.has(key)
          ? "Queued — waiting its turn"
          : "";
    }
  }
}

/** Open / close a ride's details in place: the block is inserted into (or removed
 *  from) its row, its mini-map mounted, and the render signature updated — never a
 *  list rebuild, which would scroll the page out from under the click. */
function toggleRowDetails(key: string): void {
  const open = !openStats.has(key);
  open ? openStats.add(key) : openStats.delete(key);
  const row = rowEl(key);
  const r = STATE.rides.find((x) => x.key === key);
  const main = row?.querySelector<HTMLElement>(":scope > .rmain");
  if (!row || !r || !main) {
    render();
    return;
  }
  main.querySelector(":scope > .rdetails")?.remove();
  if (open) {
    const box = document.createElement("div");
    box.className = "rdetails";
    box.innerHTML = detailsBlock(r);
    main.appendChild(box);
  }
  mountMaps();
  lastSig = stateSig(); // openStats is part of the signature — keep it current
}

/** Apply a selection change in place: row stripes + checkboxes, the group
 *  checkboxes' tri-state, and the top-bar toolbar — never a list rebuild. */
let selectionRaf = 0;
function applySelection(): void {
  if (selectionRaf) return;
  selectionRaf = requestAnimationFrame(() => {
    selectionRaf = 0;
    timed("ui:selection", applySelectionNow);
  });
}
function applySelectionNow(): void {
  for (const row of document.querySelectorAll<HTMLElement>(".rrow")) {
    const on = selected.has(row.dataset.key ?? "");
    row.classList.toggle("sel", on);
    const cb = row.querySelector<HTMLInputElement>("input.chk");
    if (cb && cb.checked !== on) cb.checked = on;
  }
  const vis = visibleRides(filters, STATE.rides);
  const byMonth = new Map<string, string[]>();
  const byYear = new Map<string, string[]>();
  for (const r of vis) {
    const m = r.month_key || "";
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r.key);
    const y = m.slice(0, 4);
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(r.key);
  }
  const state = (keys: string[]): boolean | null => {
    const n = keys.filter((k) => selected.has(k)).length;
    return n === 0 ? false : n === keys.length ? true : null;
  };
  for (const cb of document.querySelectorAll<HTMLInputElement>(".selall[data-selmonth]"))
    setChecked(cb, state(byMonth.get(cb.dataset.selmonth!) ?? []));
  for (const cb of document.querySelectorAll<HTMLInputElement>(".selall[data-selyear]"))
    setChecked(cb, state(byYear.get(cb.dataset.selyear!) ?? []));
  renderSelectionBar(STATE.rides);
  lastSig = stateSig(); // the selection is part of the signature — keep it current
}

/** Open / close the ⋯ menus in place. The per-ride menu's eight entries are built
 *  only when it opens (2,000 rows × 8 buttons was most of the list's HTML). */
function syncOpenMenu(): void {
  document
    .getElementById("stateMenu")
    ?.closest(".split")
    ?.classList.toggle("open", openMenu === "state");
  const key = openMenu?.startsWith("ovr-r:") ? openMenu.slice(6) : null;
  for (const b of document.querySelectorAll<HTMLElement>(".rbtns.open")) {
    const row = b.closest<HTMLElement>(".rrow");
    if (row?.dataset.key === key) continue;
    b.classList.remove("open");
    b.querySelector(".ovr")?.setAttribute("aria-expanded", "false");
    const items = b.querySelector(".ovr-items");
    if (items) items.innerHTML = "";
    row?.closest(".month")?.classList.remove("menu-open");
  }
  if (!key) return;
  const row = rowEl(key);
  const b = row?.querySelector<HTMLElement>(".rbtns");
  if (!row || !b || b.classList.contains("open")) return;
  const r = STATE.rides.find((x) => x.key === key);
  const items = b.querySelector(".ovr-items");
  if (!r || !items) return;
  items.innerHTML = rideMenuHtml(r);
  b.classList.add("open");
  b.querySelector(".ovr")?.setAttribute("aria-expanded", "true");
  row.closest(".month")?.classList.add("menu-open");
}

/** Apply a weather-only state change without a full list rebuild: toggle the wind
 *  badge on each visible ride row in place (so mounted maps survive) and refresh the
 *  filter bar (the Wind chip/range gate on resolved-wind diversity). If a wind-based
 *  filter is active the visible SET depends on weather, so fall back to a full render. */
let lastWeatherByKey = new Map<string, boolean>();
function applyWeatherUpdate(): void {
  if (filters.wind !== "any" || filters.windMin !== null || filters.windMax !== null) {
    render();
    return;
  }
  // Only the rides whose resolved flag flipped get their title re-rendered: during a
  // bulk resolve that is one or two rows per tick, not a 2,000-row sweep.
  const multiSource = new Set(STATE.rides.map((r) => r.source)).size > 1;
  const next = new Map<string, boolean>();
  for (const r of STATE.rides) {
    const on = !!r.wind_resolved;
    next.set(r.key, on);
    if (lastWeatherByKey.get(r.key) === on) continue;
    const main = rowEl(r.key)?.querySelector<HTMLElement>(".rtitle-main");
    if (!main) continue; // not built yet / off the list
    const html = rtitleHtml(r, multiSource);
    if (main.innerHTML !== html) main.innerHTML = html;
  }
  lastWeatherByKey = next;
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

/**
 * Permanently drop already-deleted rides (the explicit purge behind every "Drop
 * deleted" affordance — per-ride, selection, and global). Confirms with a count,
 * runs the local-only hard delete (record + stored GPX blob), prunes the dropped
 * keys from the live selection, and re-renders. No-op (with a toast) when nothing
 * deleted is in range, so a stray click never opens an empty dialog.
 */
async function dropDeletedKeys(keys: string[]): Promise<void> {
  if (!keys.length) return void toast("No deleted rides to drop.");
  const ok = await confirmDialog({
    title: "Drop deleted?",
    body:
      `Permanently remove ${keys.length} deleted ride${keys.length === 1 ? "" : "s"} from ` +
      `this device? This clears the local record and any stored GPX, and can't be undone.`,
    confirmLabel: "Drop",
  });
  if (!ok) return;
  try {
    const n = await controller.dropDeleted(keys);
    for (const k of keys) selected.delete(k);
    render();
    toast(`Dropped ${n} deleted ride${n === 1 ? "" : "s"}.`);
  } catch (err) {
    pushError("Drop failed", err instanceof Error ? err.message : String(err));
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
    const baseZip = await controller.exportAllZip(meta);
    const entries = await unzip(baseZip);
    const forecastBlobs = await (await ensureForecastStore()).getAllBlobs();
    for (const item of forecastBlobs) {
      entries.push({
        name: `forecast/${encodeURIComponent(item.key)}.bin`,
        bytes: item.bytes,
      });
    }
    entries.push({
      name: "routes.json",
      bytes: new TextEncoder().encode((await ensureRouteStore()).exportJson()),
    });
    const zipBytes = await buildZip(entries);
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
        const zipEntries = await unzip(new Uint8Array(arrayBuf));
        const forecastEntries = zipEntries
          .filter((entry) => entry.name.startsWith("forecast/") && entry.name.endsWith(".bin"))
          .map((entry) => ({
            key: decodeURIComponent(entry.name.slice("forecast/".length, -".bin".length)),
            bytes: entry.bytes,
          }));
        const forecastImported = await (await ensureForecastStore()).importBlobs(
          forecastEntries,
        );
        const routesEntry = zipEntries.find((entry) => entry.name === "routes.json");
        const routesImported = routesEntry
          ? await (await ensureRouteStore()).importJson(
              new TextDecoder().decode(routesEntry.bytes),
            )
          : 0;
        if (routesImported) resetRoutesView();
        const msg =
          `Imported — ${result.ridesImported} ride${result.ridesImported === 1 ? "" : "s"}, ` +
          `${result.gpxCacheImported} cached GPX${result.gpxCacheImported === 1 ? "" : "s"}, ` +
          `${result.gpxDataImported} imported GPX${result.gpxDataImported === 1 ? "" : "s"}, ` +
          `${result.windImported} wind cache entries, ` +
          `${forecastImported} forecast entries` +
          (routesImported
            ? `, ${routesImported} planned route${routesImported === 1 ? "" : "s"}.`
            : ".");
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
        resultLength:
          typeof reader.result === "string"
            ? reader.result.length
            : reader.result instanceof ArrayBuffer
              ? reader.result.byteLength
              : null,
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
  await ensureForecastStore().then((s) => s.clearAll());
  resetForecastViewData(true);
  await ensureRouteStore().then((s) => s.clear());
  resetRoutesView();
  setActiveView("explore");
  writeRoute({ view: "explore" }, "replace");
  applyView();
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

/** Clear live forecast/geocoding payloads while preserving locations and preferences. */
async function flushForecastCache(): Promise<void> {
  openMenu = null;
  const cache = await ensureForecastStore();
  if (cache.count === 0) {
    toast("No cached forecasts to clear.");
    return;
  }
  if (
    !confirm(
      `Clear cached forecasts (${fmtBytes(cache.totalBytes())})? Pinned and recent locations are kept.`,
    )
  ) {
    return;
  }
  await cache.flushCache();
  resetForecastViewData();
  render();
  toast("Forecast cache cleared.");
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //

// Simple `id → action` click routes, split into the two ordering regions of the
// dispatcher: `early` runs BEFORE the menu / filter-panel outside-click guards
// (modal + ride-map controls, which should ignore those guards), `late` runs AFTER
// them (so e.g. opening the map full-screen still closes a stray open menu first).
// Only pure, single-`return` id cases live here — anything with `data-*`/`closest`
// matching, fall-through, `preventDefault`, or async confirm stays in the chain.
const earlyClickActions: Record<string, () => void> = {
  btnDemoBeeline: () => {
    hideSources();
    void goDemoBeeline();
  },
  btnBeelinePull: () => pullFromBeeline(),
  btnBeelineDisconnect: () => void controller.disconnect(),
  btnGpxSource: () => goGpx(),
  btnPickClose: () => hideSources(),
  btnRideMapFull: () => fetchRideMapFull(),
  btnRideMapWeather: () => toggleRideMapWeather(),
  btnRideMapCollapse: () => toggleRideMapChrome(),
  btnRideMapProfileStops: () => toggleRideMapProfileStops(),
  btnRideMapProfile: () => toggleRideMapProfile(),
  btnRideMapClose: () => closeRideMap(),
};
const lateClickActions: Record<string, () => void> = {
  btnMapExpand: () => setMapExpanded(!document.body.classList.contains("map-expanded")),
  btnHeatExpand: () => setHeatExpanded(!document.body.classList.contains("heat-expanded")),
  btnMapSelect: () => mapAreaSelect.setMode(!mapAreaSelect.isArmed()),
  btnHeatSelect: () => heatAreaSelect.setMode(!heatAreaSelect.isArmed()),
  btnMapLocate: () => mapLocate.setActive(!mapLocate.isActive()),
  btnHeatLocate: () => heatLocate.setActive(!heatLocate.isActive()),
  fToggle: () => setFilterPanel(!isFilterPanelOpen()),
  fClose: () => setFilterPanel(false),
  fTags: () => toggleTagsFilter(),
  btnSource: () => showSources(),
  btnSettings: () => showSettings(),
  btnSettingsClose: () => hideSettings(),
  segDemoToggle: () => toggleSegmentDemo(),
  btnImport: () => void ($("#importFile") as HTMLInputElement).click(),
  btnExport: () => exportRides(),
  btnExportAll: () => void exportAll(),
  btnReset: () => void resetEverything(),
  btnScan: () => pullFromBeeline(),
  btnCancel: () => run(() => controller.cancel(null)),
  btnClear: () => run(() => controller.clear()),
  btnQueueToggle: () => toggleQueue(),
  btnJobHide: () => hideJob(),
  jobHandle: () => showJob(),
  selClear: () => {
    selected.clear();
    applySelection();
  },
};

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target?.classList?.contains("chk")) {
    // A ride checkbox: the browser has already flipped it; `change` records the single
    // ride. Shift extends its new state over the range from the anchor; a plain click
    // becomes the anchor.
    const cb = target as HTMLInputElement;
    const key = cb.dataset.key ?? "";
    if (e.shiftKey && selAnchor && selAnchor !== key) selectRange(key, cb.checked);
    else selAnchor = key;
    return;
  }
  if (target && target.tagName === "INPUT") return; // checkboxes handled on 'change'
  const t = (target.closest("button, a, .mhead, .yhead") as HTMLElement) || target;

  // The quick-ranges dropdown (fused to each slider's "All") dismisses on any click
  // that lands outside it. Runs before the early returns below so it closes reliably;
  // a click on the caret/menu itself is inside `.rf-presets`, so it's spared here and
  // handled by the toggle/apply branches instead.
  if (!target.closest(".rf-presets")) closeRangePresets();

  // Simple modal / ride-map controls that must ignore the menu/panel guards below.
  const early = earlyClickActions[t.id];
  if (early) return early();

  // Analytics view: resolve historical wind for every ride in the current date
  // range, so the wind-vs-speed scatter has points to plot.
  if (t.id === "analyticsResolve" || t.id === "analyticsResolveEmpty") {
    const keys = windSpeedVisibleRides().map((r) => r.key);
    return resolveWindFor(keys);
  }
  // Analytics view: fetch the full recorded GPX (real timestamps) for the rides in
  // range — speed is only trustworthy from a full timed track.
  if (t.id === "analyticsFetchGpx" || t.id === "analyticsFetchGpxEmpty") {
    const keys = windSpeedVisibleRides().map((r) => r.key);
    return fetchFullGpx(keys);
  }
  // Analytics view: restore the segment-geometry knobs to their defaults.
  if (t.id === "segReset") {
    setSegTuneDom(SEG_TUNE_DEFAULTS);
    saveAnalyticsPrefs();
    void mountWindSpeedView();
    return;
  }
  // Analytics view: pick the wind dimension plotted on the X axis. Flipping X can make
  // the active colour dimension invalid (you can't colour by the axis you're on), so
  // re-gate the colour options before the cheap redraw (no re-sweep).
  if (t.dataset?.xaxis && t.closest("#analyticsXAxis")) {
    setActiveSeg("analyticsXAxis", "xaxis", t.dataset.xaxis);
    syncColorByGating();
    saveAnalyticsPrefs();
    void mountWindSpeedView();
    return;
  }
  // Analytics view: pick the dimension that tints the dots (cheap redraw). Ignore the
  // hidden (X-matching) option.
  if (t.dataset?.colorby && t.closest("#analyticsColorBy")) {
    if (!t.classList.contains("hidden")) {
      setActiveSeg("analyticsColorBy", "colorby", t.dataset.colorby);
      saveAnalyticsPrefs();
      void mountWindSpeedView();
    }
    return;
  }

  // Full-screen single-ride route map: open from a mini-map's expand button, close
  // from its bar button or by clicking the backdrop outside the canvas.
  if (t.dataset?.expand) {
    return openRideMap(t.dataset.expand);
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

  // Split-button: toggle its dropdown. Any click outside an open menu closes it.
  if (t.dataset?.splitmenu) {
    openMenu = openMenu === t.dataset.splitmenu ? null : t.dataset.splitmenu;
    syncOpenMenu();
    return;
  }
  // Picking any real action from an open mobile "⋯" overflow menu dismisses it
  // (the subsequent dispatch re-renders with the menu closed). The nested Check/
  // GPX split buttons live inside `.split`, so the generic guard below would skip
  // them — close here so every entry behaves the same.
  if (openMenu?.startsWith("ovr-") && t.dataset?.act) {
    openMenu = null;
    syncOpenMenu();
  }
  // The consolidated actions menu's entries live inside `.split`, so the outside-click
  // guard below skips them — dismiss the open menu here once one of its items is picked.
  if (openMenu === "state" && target.closest("#stateMenu")) {
    openMenu = null;
    syncOpenMenu();
    // fall through so the click still triggers the chosen action
  }
  if (openMenu !== null && !target.closest(".split, .rbtns.open")) {
    openMenu = null;
    syncOpenMenu();
    // fall through so this same click can still trigger whatever it landed on
  }
  // The global filter panel closes on any click outside it. Its chips, fields and
  // Tags section all live inside `#filterPanel`, and the `#fToggle` button toggles it
  // below, so neither closes it here. Falls through so the same click still does its job.
  if (isFilterPanelOpen() && !target.closest("#filterPanel, #fToggle")) {
    setFilterPanel(false);
  }

  // Simple id-keyed routes that run after the guards (so a stray open menu / panel
  // is dismissed first). Structural (`data-*`/`closest`) cases stay in the chain below.
  const late = lateClickActions[t.id];
  if (late) return late();

  if (t.dataset?.view) {
    setView(t.dataset.view as ViewName);
    return;
  }
  if (t.dataset?.group === "weather") {
    setView(lastWeatherView());
    return;
  }
  if (t.dataset?.rangereset) {
    closeRangePresets();
    resetRange(t.dataset.rangereset as RangeView);
    return;
  }
  if (t.dataset?.rangepresets) {
    // Toggle the quick-ranges dropdown fused to this slider's "All".
    const wrap = t.closest<HTMLElement>(".rf-presets");
    const willOpen = !!wrap && !wrap.classList.contains("open");
    closeRangePresets();
    if (wrap && willOpen) {
      wrap.classList.add("open");
      t.setAttribute("aria-expanded", "true");
    }
    return;
  }
  if (t.dataset?.rangepreset) {
    applyRangePreset(
      (t.dataset.rangewhich as RangeView) ?? "map",
      t.dataset.rangepreset as "week" | "month" | "year",
    );
    closeRangePresets();
    return;
  }
  // The header "Filters" button summons the global ride-filter panel (a desktop
  // dropdown / mobile bottom sheet). It floats over content, so no view re-render is
  // needed — flip the panel directly (syncFilterBar keeps its chips in step). It +
  // its close button live in `lateClickActions`. The date-range triggers open the
  // shared styled date-picker constrained so the two bounds can't cross.
  if (t.dataset?.fchip) {
    cycleChip(t.dataset.fchip);
    saveFilters();
    applyState();
    return;
  }
  const ingTrigger = t.closest<HTMLElement>("#fIngFrom, #fIngTo");
  if (ingTrigger) {
    openIngestionPicker(ingTrigger.id === "fIngFrom" ? "from" : "to", ingTrigger);
    return;
  }
  // Ridden (ride-date) range: same shared picker, constrained on the ride's own date.
  const rideTrigger = t.closest<HTMLElement>("#fRideFrom, #fRideTo");
  if (rideTrigger) {
    openRidePicker(rideTrigger.id === "fRideFrom" ? "from" : "to", rideTrigger);
    return;
  }
  // The Tags chip (`fTags`, in `lateClickActions`) toggles its in-panel multi-select
  // section; each tag chip ORs that tag in/out of the filter; the Clear row empties it.
  // The section stays open through tag toggles so several can be picked in one go.
  const ftagOpt = t.closest<HTMLElement>(".ftag-opt");
  if (ftagOpt?.dataset.ftagUntagged) {
    filters.untagged = !filters.untagged;
    saveFilters();
    applyState();
    return;
  }
  if (ftagOpt?.dataset.ftagKey) {
    const key = ftagOpt.dataset.ftagKey;
    filters.tags = filters.tags.includes(key)
      ? filters.tags.filter((k) => k !== key)
      : [...filters.tags, key];
    saveFilters();
    applyState();
    return;
  }
  if (t.closest(".ftag-clear")) {
    filters.tags = [];
    filters.untagged = false;
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
  // The chart's own controls redraw only the chart — never the ride list.
  if (t.dataset?.gran) {
    statGran.set(t.dataset.gran as Granularity | "auto");
    renderStats(visibleRides(filters, STATE.rides));
    return;
  }
  if (t.dataset?.metric) {
    statMetric.set(t.dataset.metric as "distance" | "speed");
    renderStats(visibleRides(filters, STATE.rides));
    return;
  }
  if (t.dataset?.clear === "gpx") return void flushGpxCache();
  if (t.dataset?.clear === "wind") return void flushWindCache();
  if (t.dataset?.clear === "forecast") return void flushForecastCache();
  if (t.dataset?.clear === "location") return void dropLocationHistory();
  if (t.dataset?.cancel) {
    return run(() => controller.cancel(parseInt(t.dataset.cancel!, 10)));
  }
  if (t.dataset && "errDismiss" in t.dataset) {
    const card = t.closest(".errcard") as HTMLElement | null;
    if (card?.dataset.id) dismissError(card.dataset.id);
    return;
  }
  if (t.dataset && "errDetails" in t.dataset) {
    const card = t.closest(".errcard") as HTMLElement | null;
    if (card?.dataset.id) toggleErrorDetails(card.dataset.id);
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
  if (t.id === "btnTagSel") {
    openMenu = null;
    if (!selected.size) return toast("Select some rides first.");
    openTagModal([...selected]);
    return;
  }
  if (t.id === "btnUploadSel") {
    if (!selected.size) return toast("Select some rides first.");
    const keys = [...selected].filter(
      (k) => STATE.rides.find((r) => r.key === k)?.status !== "uploaded",
    );
    if (!keys.length) return toast("All selected rides are already uploaded to Strava.");
    trackEvent("strava-upload");
    return withBeelineAccess(() => run(() => controller.upload(keys)));
  }
  if (t.id === "btnDeleteSel") {
    openMenu = null;
    if (!selected.size) return toast("Select some rides first.");
    const keys = [...selected].filter((k) => !STATE.rides.find((r) => r.key === k)?.deleted);
    if (!keys.length) return toast("No live rides selected to delete.");
    const rides = keys
      .map((k) => STATE.rides.find((r) => r.key === k))
      .filter(Boolean) as RideView[];
    const b = rides.filter((r) => r.source === "beeline").length;
    const g = rides.filter((r) => r.source === "gpx").length;
    const n = keys.length;
    const tail = `This can't be undone. They stay listed here, marked as deleted.`;
    const body =
      g === 0
        ? `Permanently delete ${n} ride${n === 1 ? "" : "s"} from your Beeline account? ${tail}`
        : b === 0
          ? `Delete ${n} imported ride${n === 1 ? "" : "s"}? This removes their GPX from this ` +
            `browser and can't be undone. They stay listed here, marked as deleted.`
          : `Delete ${n} rides? ${b} from your Beeline account and ${g} imported (their GPX ` +
            `removed from this browser). ${tail}`;
    void (async () => {
      const ok = await confirmDialog({
        title: "Delete selected?",
        body,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      const gate = b > 0 ? withBeelineAccess : (fn: () => void) => fn();
      gate(() => run(() => controller.deleteRides(keys)));
    })();
    return;
  }
  if (t.id === "btnDropDeleted") {
    openMenu = null;
    void dropDeletedKeys(STATE.rides.filter((r) => r.deleted).map((r) => r.key));
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
  if (act === "tags-one") {
    openMenu = null;
    render();
    openTagModal([t.dataset.key!]);
    return;
  }
  if (act === "upload-one") {
    const ride = STATE.rides.find((r) => r.key === t.dataset.key);
    openMenu = null;
    render();
    if (ride && ride.status === "uploaded") return toast("Already uploaded to Strava.");
    trackEvent("strava-upload");
    return withBeelineAccess(() => run(() => controller.upload([t.dataset.key!])));
  }
  if (act === "strava-open-one") {
    const ride = STATE.rides.find((r) => r.key === t.dataset.key);
    openMenu = null;
    render();
    if (!ride?.strava_activity_id) return;
    trackEvent("strava-open");
    window.open(
      `https://www.strava.com/activities/${ride.strava_activity_id}`,
      "_blank",
      "noopener",
    );
    return;
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
    if (ride?.source !== "gpx") return;
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
  if (act === "drop-one") {
    openMenu = null;
    void dropDeletedKeys([t.dataset.key!]);
    return;
  }

  // Clicking anywhere on a ride tile toggles its details — except on the
  // interactive bits (buttons, links, checkbox) or inside the already-open
  // details/map area, so the user can interact with those without collapsing.
  if (!target.closest("button, a, input, .stats, .rmap, .rmaphint, .rdetailhint")) {
    const rrow = target.closest(".rrow") as HTMLElement | null;
    if (rrow?.dataset.key) {
      const k = rrow.dataset.key;
      // Shift-click a row: select the range from the anchor (file-manager idiom);
      // Ctrl/⌘-click: toggle just this ride. A plain click opens the details.
      if (e.shiftKey) {
        selectRange(k, true);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        selected.has(k) ? selected.delete(k) : selected.add(k);
        selAnchor = k;
        applySelection();
        return;
      }
      toggleRowDetails(k);
      return;
    }
  }

  // A group checkbox (`.selall`) sits inside the header row; its click selects the
  // group (handled on `change`) and must not also navigate / toggle the group.
  if (t.tagName === "INPUT") return;
  const yhead = t.classList?.contains("yhead")
    ? t
    : t.closest && (t.closest(".yhead") as HTMLElement | null);
  if (yhead) {
    // Split layout: the year row navigates (its caret still collapses the tree).
    if (exploreSplit() && !target.closest(".caret")) {
      scrollToGroup(`.rp-year[data-y="${CSS.escape(yhead.dataset.y!)}"]`);
      return;
    }
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
    if (exploreSplit()) {
      scrollToGroup(`.rp-month[data-m="${CSS.escape(m)}"]`);
      return;
    }
    openMonths.has(m) ? openMonths.delete(m) : openMonths.add(m);
    render();
  }
});

// Shift-click selects a range of rows — not a run of text.
document.addEventListener("mousedown", (e) => {
  if (e.shiftKey && (e.target as HTMLElement).closest?.(".rrow")) e.preventDefault();
});

// Explore re-renders when a resize crosses the split breakpoint or moves the chart's
// Auto granularity (both are part of the render signature, so this is cheap when
// nothing changed).
let exploreResizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("resize", () => {
  if (activeView() !== "explore") return;
  if (exploreResizeTimer) clearTimeout(exploreResizeTimer);
  exploreResizeTimer = setTimeout(() => {
    exploreResizeTimer = null;
    render();
  }, 150);
});

// Escape closes an open split-button menu (GPX or Check), or the source picker.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.getElementById("selBar")?.classList.contains("menu-open")) {
    setSelMenu(false);
    return;
  }
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
  if (isFilterPanelOpen()) {
    setFilterPanel(false);
    return;
  }
  const tagM = document.getElementById("tagModal");
  if (tagM && !tagM.classList.contains("hidden")) {
    closeTagModal();
    return;
  }
  const picker = document.getElementById("srcPick");
  if (picker && !picker.classList.contains("hidden")) {
    hideSources();
    return;
  }
  if (openMenu !== null) {
    openMenu = null;
    syncOpenMenu();
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
  if (activeView() !== "analytics") return;
  if (analyticsResizeRaf) cancelAnimationFrame(analyticsResizeRaf);
  analyticsResizeRaf = requestAnimationFrame(() => {
    analyticsResizeRaf = 0;
    void mountWindSpeedView({ fit: false });
  });
});

// Styled confirm/prompt/consent dialogs (./confirm) wire their own listeners.
initConfirm();

// Backdrop-click dismissal: a click that lands on a modal's own backdrop element
// (not a child) closes it. One canonical wiring so every modal dismisses the same
// way and the checks don't clutter the global click dispatcher — each modal keeps
// its own teardown via the passed close callback.
function dismissOnBackdrop(id: string, close: () => void): void {
  document.getElementById(id)?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
}
dismissOnBackdrop("srcPick", hideSources);
dismissOnBackdrop("settingsModal", hideSettings);
dismissOnBackdrop("rideMapModal", closeRideMap);
dismissOnBackdrop("tagModal", closeTagModal);

// Tag-assign modal: Save / Cancel, the add form creates a tag chip, and clicking a
// chip cycles its tri-state (backdrop-click cancels via dismissOnBackdrop above).
document.getElementById("tagModalSave")?.addEventListener("click", () => saveTagModal());
document.getElementById("tagModalCancel")?.addEventListener("click", () => closeTagModal());
document.getElementById("tagModalAdd")?.addEventListener("submit", (e) => {
  e.preventDefault();
  addTagModalTag();
});
document.getElementById("tagModalChips")?.addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>(".tagmodal-chip");
  if (chip?.dataset.tagidx !== undefined) cycleTagChip(Number(chip.dataset.tagidx));
});

document.addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (cb.classList?.contains("chk")) {
    cb.checked ? selected.add(cb.dataset.key!) : selected.delete(cb.dataset.key!);
    applySelection();
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
  // Segment-geometry knobs re-chop every ride, so (unlike the cheap max-speed
  // post-filter) they commit on `change` (slider release) — never mid-drag — and
  // re-sweep with the existing progress overlay.
  if (cb.id === "segLookAhead" || cb.id === "segTurn") {
    saveAnalyticsPrefs();
    void mountWindSpeedView();
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
  // Keep every unified single-thumb slider's accent fill in sync as it's dragged
  // (one place for all of them — Stats / Wind-Speed / Timeline / Settings / Climate).
  if (el.classList?.contains("uslider")) setSliderFill(el);
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
  if (
    el.dataset.range === "map" ||
    el.dataset.range === "stats" ||
    el.dataset.range === "analytics"
  ) {
    onRangeInput(el.dataset.range as RangeView, el);
    return;
  }
  if (el.id === "heatRadius") {
    // Live preview only (a cheap redraw of the existing layer); the setting is
    // committed on `change` — see the rule in the change handler below.
    const v = parseInt(el.value, 10) || 12;
    ($("#heatRadiusOut") as HTMLOutputElement).value = String(v);
    setHeatRadiusPreview(v);
    return;
  }
  // Grade / speed / crosswind / headwind / tailwind band filters: cheap post-filters
  // (each precomputed per segment), so they re-render live as typed.
  if (
    el.id === "gMin" ||
    el.id === "gMax" ||
    el.id === "sMin" ||
    el.id === "sMax" ||
    el.id === "lenMin" ||
    el.id === "lenMax" ||
    el.id === "cwMin" ||
    el.id === "cwMax" ||
    el.id === "hwMin" ||
    el.id === "hwMax" ||
    el.id === "twMin" ||
    el.id === "twMax"
  ) {
    saveAnalyticsPrefs();
    void mountWindSpeedView();
    return;
  }
  if (el.id === "segLookAhead" || el.id === "segTurn") {
    // Live label + explainer while dragging; the re-sweeping recompute commits on `change`.
    const out = document.getElementById(`${el.id}Out`) as HTMLOutputElement | null;
    if (out) out.value = segTuneLabel(el.id, parseInt(el.value, 10) || 0);
    renderSegmentDemo();
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
  // Live preview: redraw only the chart with the dragged values. Writing the store
  // here re-rendered the whole ride list on every tick and froze the page.
  const slow = parseInt($<HTMLInputElement>("#trimSlow").value, 10) || 0;
  const fast = parseInt($<HTMLInputElement>("#trimFast").value, 10) || 0;
  liveTrim = { slow, fast };
  renderStats(visibleRides(filters, STATE.rides));
});

// Commit the moving-speed threshold once when the slider is released (`change`),
// not on every `input` tick — see the live-label handler above. This is the single
// whole-blob save + re-render for the whole drag.
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  // RULE (portal-wide): a slider's `input` ticks only preview — cheap, visual, local.
  // The store write + the one full render happen here, once, on release.
  if (el.id === "trimSlow" || el.id === "trimFast") {
    const slow = parseInt($<HTMLInputElement>("#trimSlow").value, 10) || 0;
    const fast = parseInt($<HTMLInputElement>("#trimFast").value, 10) || 0;
    liveTrim = null;
    run(() => controller.setSpeedTrim(slow, fast));
    return;
  }
  if (el.id === "heatRadius") {
    const v = parseInt(el.value, 10) || 12;
    setHeatRadiusPreview(null);
    run(() => controller.setHeatRadius(v));
    return;
  }
  if (el.id === "setSuggestTags") {
    run(() => controller.setSuggestTagsAfterImport(el.checked));
    return;
  }
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
  esc: escHtml, // the ride map interpolates text into HTML (never ids)
  withBeelineAccess,
  withGpxRelayConsent,
  osmAttribution: OSM_ATTRIBUTION,
});

// Collapsible panels: the Explore chart, the Stats totals band and the Forecast
// legend fold away (remembered) so a big screen's room goes to the data.
initCollapse(
  document.getElementById("spCollapse"),
  document.getElementById("statsPanel"),
  "gpx_toolkit.collapse.explore_chart",
  { open: "Collapse the chart", closed: "Expand the chart" },
  "collapsed",
  () => render(), // the chart measures its width when it draws
);
initCollapse(
  document.getElementById("statsKpisCollapse"),
  document.getElementById("statsKpis"),
  "gpx_toolkit.collapse.stats_totals",
  { open: "Compact the totals and records", closed: "Expand the totals and records" },
);
initCollapse(
  document.getElementById("forecastLegendToggle"),
  document.getElementById("forecastView"),
  "gpx_toolkit.collapse.forecast_legend",
  { open: "Hide the legend", closed: "Show the legend" },
  "legend-collapsed",
);

initRangeView({
  getRides: () => STATE.rides,
  remount: (which, fit) => {
    if (which === "map") mountMapView({ fit });
    else if (which === "stats") mountStatsView({ fit });
    else void mountWindSpeedView({ fit });
  },
  onAnalyticsChange: saveAnalyticsPrefs,
  // The remembered Wind/Speed window (raw edge timestamps), adopted on first refresh.
  initialAnalyticsRange: (() => {
    const p = loadAnalyticsPrefs();
    return p.rangeMin !== null && p.rangeMax !== null
      ? { minMs: p.rangeMin, maxMs: p.rangeMax }
      : null;
  })(),
});

initJobsView({ getJobs: () => STATE.jobs, toast });
initFilterState({ getRides: () => STATE.rides, onChange: applyState });
initExploreView({ getRides: () => STATE.rides });
initTagModal({
  getRides: () => STATE.rides,
  setRideTags: (uids, tagsFor) => controller.setRideTags(uids, tagsFor),
});
initSourcesView({
  getState: () => STATE,
  isDemo: () => isDemo,
  rememberedEmail,
  onDismiss: () => {
    afterBeelineSignIn = null;
  },
});

const forecastProvider = new OpenMeteoForecastAdapter();

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

initClimateView({
  getPointWind: (lat, lon, startYear, endYear, onStage) =>
    controller.getPointWind(lat, lon, startYear, endYear, onStage),
  cachedYears: (lat, lon) => controller.cachedWindYears(lat, lon),
  toast,
  osmAttribution: OSM_ATTRIBUTION,
  onPointChange: (point) => onRoutedPointChange("climate", point),
});

initForecastView({
  provider: forecastProvider,
  ensureStore: ensureForecastStore,
  toast,
  esc: escHtml,
  onPointChange: (point) => onRoutedPointChange("forecast", point),
});

initRoutesView({
  getStore: ensureRouteStore,
  routeWeather: (points, days, onStage, models) =>
    controller.routeWeather(points, days, onStage, models),
  forecastModels: forecastProvider.models,
  searchPlaces: (query, signal) => forecastProvider.searchLocations(query, signal),
  homePoint: () => {
    const latest = STATE.rides
      .filter((r) => !r.deleted && r.track)
      .sort(compareRidesByDateDesc)[0];
    const start = latest ? decodePolyline(latest.track)[0] : undefined;
    if (start) return start;
    const fp = forecastPoint();
    return fp ? [fp.lat, fp.lon] : null;
  },
  toast,
  saveText: (filename, text, mime) =>
    saveGpxFile({
      filename,
      downloadName: filename,
      bytes: new TextEncoder().encode(text),
      mime,
    }),
});

initWindSpeedView({
  getRides: () => STATE.rides,
  ridesInRange,
  applyFilters: (rides) => visibleRides(filters, rides),
  analyticsRange: () => rangeOf("analytics"),
  movingThresholdKmh: () => STATE.settings.movingThresholdKmh,
  weatherFetchedAt: (key) => controller.weatherFetchedAt(key),
  windSamples: (key) => controller.windSamples(key),
  refreshRange: () => refreshRange("analytics"),
  syncRangeControl: () => syncRangeControl("analytics"),
  openRide: (key) => openRideInExplore(key),
});
// Restore the remembered Wind/Speed chart filters into their controls (the date
// window is re-applied lazily once the rides' bounds are known, in refreshRange).
applyAnalyticsPrefsToDom();

initMapView({
  getRides: () => STATE.rides,
  ridesInRange,
  applyFilters: (rides) => visibleRides(filters, rides),
  mapRange: () => rangeOf("map"),
  refreshRange: () => refreshRange("map"),
  syncRangeControl: () => syncRangeControl("map"),
  renderSelectedCards: (keys) => renderMatchedCards(keys),
  toast,
});

initStatsView({
  getRides: () => STATE.rides,
  ridesInRange,
  applyFilters: (rides) => visibleRides(filters, rides),
  statsRange: () => rangeOf("stats"),
  refreshRange: () => refreshRange("stats"),
  syncRangeControl: () => syncRangeControl("stats"),
  filteredFlag: statsFilteredFlag,
  renderSelectedCards: (keys) => renderMatchedCards(keys),
  heatRadius: () => STATE.settings.heatRadius,
  toast,
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
      clearHeatSelection();
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
  if (isClimateExpanded()) collapseClimate();
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

// A shared route wins over the remembered view and point before the first render.
const initialRoute = parseRoute(window.location.hash);
if (initialRoute) {
  setActiveView(initialRoute.view);
  if (initialRoute.view === "forecast") setForecastRoutePoint(initialRoute.point ?? null);
  if (initialRoute.view === "climate") setClimateRoutePoint(initialRoute.point ?? null);
  writeRoute(initialRoute, "replace");
} else {
  writeRoute(routeForView(activeView()), "replace");
}
window.addEventListener("hashchange", applyHashRoute);
decorateIcons();
initTheme();
initShell();
initSegSliding();
window.addEventListener("themechange", () => {
  applyView();
  render();
});
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

// Keep the floating job strip clear of browser chrome that overlays the
// bottom of the layout viewport — chiefly Chrome on Android's retractable
// address bar (and the on-screen keyboard). The visual viewport shrinks from the
// bottom when that chrome is shown; we publish that gap as `--vv-bottom` so the
// pill's `bottom` can lift by exactly that much (see .job in CSS).
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
