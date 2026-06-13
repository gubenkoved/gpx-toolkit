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
import { Controller, type AppState } from "./controller";
import { autoGranularity, bucketRide, compareRideKeysDesc, parseDurationSec, type Granularity } from "./parsing";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, Store } from "./store";
import { decodePolyline } from "./track";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

// --------------------------------------------------------------------------- //
// Controller wiring (demo by default; "Connect phone" switches to WebUSB)
// --------------------------------------------------------------------------- //
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

let controller!: Controller;
let isDemo = true;
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
  const c = new Controller(async () => new DemoAdb({ latencyMs: 110 }), new Store(memoryStorage()));
  activate(c, true);
  try {
    await c.connect();
  } catch {
    /* demo connect never fails */
  }
}

async function goReal(): Promise<void> {
  let serial = "";
  const transport = async (): Promise<AdbDevice> => {
    const device = await WebUsbAdb.connect();
    serial = device.deviceSerial;
    return device;
  };
  const c = new Controller(transport, Store.load());
  activate(c, false);
  try {
    await c.connect();
    rememberReal(serial);
    toast(`Connected: ${controller.state().device}`);
  } catch (err) {
    toast(err instanceof AdbError ? err.message : String(err), true);
    void goDemo(); // keep the app usable
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
  const c = new Controller(transport, Store.load());
  activate(c, false);
  try {
    await c.connect();
    rememberReal(serial);
    toast(`Reconnected: ${controller.state().device}`);
  } catch {
    // Device not plugged in / not authorized this session — quietly use demo.
    void goDemo();
  }
}

async function leaveReal(): Promise<void> {
  forgetReal(); // stop auto-reconnecting on future loads
  await goDemo();
}


// --------------------------------------------------------------------------- //
// UI state
// --------------------------------------------------------------------------- //
let STATE: AppState = {
  rides: [],
  jobs: { current: null, current_keys: [], queue: [], history: [], active_keys: [], busy: false },
  speed: "normal",
  settings: { trackMaxPoints: 100 },
  connected: false,
  device: "",
};
let ACTIVE = new Set<string>(); // keys queued or running
let RUNNING = new Set<string>(); // keys in the currently running task
const selected = new Set<string>();
const openMonths = new Set<string>();
const openYears = new Set<string>();
const openStats = new Set<string>();
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
    }).addTo(map);
    const line = L.polyline(pts, { color: "#fc5200", weight: 3 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [12, 12] });
    // The container was sized by CSS only after insertion; nudge Leaflet to re-measure.
    setTimeout(() => map.invalidateSize(), 0);
    mapRegistry.set(host.dataset.map!, map);
  });
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

  // Per bucket we track distance (always) and the subset that also has a moving
  // time (only "checked" rides whose detail was fetched). Speed is distance-weighted:
  // bucketSpeed = Σ km(with time) / Σ hours — so a short fast ride can't skew it.
  const byM = new Map<
    string,
    { label: string; short: string; km: number; n: number; spKm: number; spSec: number; spN: number }
  >();
  for (const r of rides) {
    const km = parseKm(r.distance);
    const [bkey, label, short] = bucketRide(r.key, gran);
    if (!byM.has(bkey)) byM.set(bkey, { label, short, km: 0, n: 0, spKm: 0, spSec: 0, spN: 0 });
    const e = byM.get(bkey)!;
    e.km += km;
    e.n += 1;
    const sec = parseDurationSec((r.stats && r.stats["Moving time"]) || "");
    if (sec > 0) {
      // Prefer the detail's own distance value when present; fall back to the list one.
      e.spKm += parseKm((r.stats && r.stats["Distance"]) || r.distance);
      e.spSec += sec;
      e.spN += 1;
    }
  }
  const items = [...byM.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const bucketSpeed = (e: { spKm: number; spSec: number }): number =>
    e.spSec > 0 ? e.spKm / (e.spSec / 3600) : 0;

  if (statMetric === "speed") {
    renderSpeed(gran, items, bucketSpeed, rides.length);
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
): void {
  ($(".sp-title") as HTMLElement).textContent = `Average speed per ${gran}`;

  // Overall distance-weighted average across every checked ride.
  const totSpKm = items.reduce((s, [, e]) => s + e.spKm, 0);
  const totSpSec = items.reduce((s, [, e]) => s + e.spSec, 0);
  const ridesWithSpeed = items.reduce((s, [, e]) => s + e.spN, 0);
  const overall = totSpSec > 0 ? totSpKm / (totSpSec / 3600) : 0;
  const speeds = items.filter(([, e]) => e.spN > 0).map(([, e]) => bucketSpeed(e));
  const fastest = speeds.length ? Math.max(...speeds) : 0;
  const slowest = speeds.length ? Math.min(...speeds) : 0;
  const maxSpeed = Math.max(1, ...speeds);

  // Subtle warning: speed only covers rides we've "checked" (detail fetched).
  const note = $("#spNote");
  const missing = rideCount - ridesWithSpeed;
  if (missing > 0) {
    note.textContent =
      `Speed uses ${ridesWithSpeed} of ${rideCount} rides — Check the rest to include their moving time.`;
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
      <span class="cval">${Math.round(v)}</span>
      <div class="bar" style="height:${h}px"></div>
      <span class="clab">${e.short}</span>
    </div>`;
    })
    .join("");
}

function renderConn(): void {
  const el = $("#connState");
  const connectBtn = $<HTMLButtonElement>("#btnConnect");
  const disconnectBtn = $<HTMLButtonElement>("#btnDisconnect");
  const notice = $("#demoNotice");
  if (isDemo) {
    el.textContent = "demo";
    el.className = "cstate demo";
    connectBtn.style.display = "";
    disconnectBtn.style.display = "none";
    notice.classList.remove("hidden");
  } else if (STATE.connected) {
    el.textContent = STATE.device || "connected";
    el.className = "cstate on";
    connectBtn.style.display = "none";
    disconnectBtn.style.display = "";
    notice.classList.add("hidden");
  } else {
    el.textContent = "not connected";
    el.className = "cstate off";
    connectBtn.style.display = "";
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
  if (tp && document.activeElement !== tp) tp.value = String(STATE.settings.trackMaxPoints);

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
          <button class="small ghost" data-act="status-year" data-y="${year}">Check all</button>
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
            <button class="small ghost" data-act="status-month" data-m="${mkey}">Check</button>
            <button class="small" data-act="upload-month" data-m="${mkey}">Upload pending to Strava</button>
          </span>
        </div>
        <div class="rows ${isOpen ? "open" : ""}"></div>`;
      ybody.appendChild(box);
      setChecked(box.querySelector(".selall"), mSel);

      const rowsEl = box.querySelector(".rows")!;
      for (const r of m.rides) {
        const so = openStats.has(r.key);
        const el = document.createElement("div");
        el.className = "rrow" + (r.deleted ? " deleted" : "");
        el.dataset.key = r.key;
        el.innerHTML = `
          <input type="checkbox" class="chk" data-key="${r.key}" ${selected.has(r.key) ? "checked" : ""}>
          <div class="rmain">
            <div class="rtitle"><span class="rname"><span class="rtitle-text">${r.title || "Ride"}</span>${r.location ? `<span class="rtitle-loc">${r.location}</span>` : ""}</span> ${badge(r.status)} ${r.deleted ? deletedBadge() : ""} ${queueBadge(r.key)}</div>
            <div class="rmeta">${r.key} · ${r.distance || "?"} · ${r.duration || "?"}
              <a href="#" data-stats="${r.key}">${so ? "hide" : "details"}</a></div>
            <div class="stats ${so ? "open" : ""}" id="st-${esc(r.key)}">${fmtStats(r.stats)}</div>
            ${so ? trackBlock(r.key, r.track) : ""}
          </div>
          <div class="rbtns">
            <button class="small ghost" data-act="status-one" data-key="${r.key}">Check</button>
            <button class="small ghost" data-act="gpx-one" data-key="${r.key}">GPX</button>
            <button class="small" data-act="upload-one" data-key="${r.key}">Upload to Strava</button>
          </div>`;
        rowsEl.appendChild(el);
      }
    }
  }
  renderJob();
  mountMaps();
  lastSig = stateSig();
}

function renderJob(): void {
  const jobs = STATE.jobs;
  const cur = jobs.current;
  const queued = (jobs.queue || []).length;
  const busy = !!cur || queued > 0;
  $("#job").classList.toggle("show", busy);
  document.body.classList.toggle("job-active", busy);
  if (cur) $("#jobMsg").textContent = `${cur.kind}: ${cur.message || "working\u2026"}`;
  else if (busy) $("#jobMsg").textContent = "queued\u2026";
  const qc = $("#qcount");
  qc.textContent = queued ? `${queued} queued` : "";
  qc.style.display = queued ? "" : "none";
  ($("#btnClear") as HTMLElement).style.display = queued ? "" : "none";
  renderError(jobs);
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
function saveGpxFile(file: { filename: string; bytes: Uint8Array }): void {
  const copy = new Uint8Array(file.bytes); // own the buffer for the Blob
  const blob = new Blob([copy], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename.endsWith(".gpx") ? file.filename : `${file.filename}.gpx`;
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
  if (!confirm("Erase all locally stored rides, settings, and the remembered phone? This cannot be undone and returns the app to demo mode. Nothing on your phone is deleted.")) {
    return;
  }
  controller.reset(); // clear the active controller's cache + job queue
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
  forgetReal(); // stop auto-reconnecting to the phone on future loads
  await goDemo(); // rebuild a fresh demo controller with empty storage
  toast("Local data cleared.");
}

// --------------------------------------------------------------------------- //
// Events
// --------------------------------------------------------------------------- //
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target && target.tagName === "INPUT") return; // checkboxes handled on 'change'
  const t = (target.closest("button, a, .mhead, .yhead") as HTMLElement) || target;

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
  if (t.id === "btnDisconnect") return void leaveReal();
  if (t.id === "btnImport") return void ($("#importFile") as HTMLInputElement).click();
  if (t.id === "btnExport") return exportRides();
  if (t.id === "btnReset") return void resetEverything();
  if (t.id === "btnScan") return doScan();
  if (t.id === "btnCancel") return run(() => controller.cancel(null));
  if (t.id === "btnClear") return run(() => controller.clear());
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
  if (act === "upload-one") return run(() => controller.upload([t.dataset.key!]));
  if (act === "status-month") return run(() => controller.status(keysOfMonth(t.dataset.m!)));
  if (act === "upload-month") {
    const keys = pendingOfMonth(t.dataset.m!);
    if (!keys.length) return toast("No known pending rides this month. Check first.");
    return run(() => controller.upload(keys));
  }
  if (act === "status-year") return run(() => controller.status(keysOfYear(t.dataset.y!)));
  if (act === "upload-year") {
    const keys = pendingOfYear(t.dataset.y!);
    if (!keys.length) return toast("No known pending rides this year. Check first.");
    return run(() => controller.upload(keys));
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
  if (!target.closest("button, a, input, .stats, .rmap, .rmapnote, .rmaphint")) {
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
    if (Number.isFinite(v)) run(() => controller.setTrackMaxPoints(v));
  }
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

// Warn before leaving while phone work is in progress — closing/reloading the tab
// kills the in-browser worker, abandoning the running task and anything queued.
window.addEventListener("beforeunload", (e) => {
  const jobs = controller?.state().jobs;
  if (jobs?.busy) {
    e.preventDefault();
    e.returnValue = ""; // required for Chromium to show the native confirm dialog
  }
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

// Boot: silently reconnect a remembered phone (no prompt), else demo mode.
if (wantsReal()) void tryAutoReconnect();
else void goDemo();
