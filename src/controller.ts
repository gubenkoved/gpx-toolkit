/**
 * In-browser controller — the backend-free equivalent of the Python `server.Backend`.
 *
 * Holds the Store, the JobQueue, the speed profile, and a lazily-created
 * `BeelineApp` bound to a connected `AdbDevice`. Exposes the same operations the
 * old HTTP API did (state / scan / status / upload / cancel / clear / settings),
 * but as direct method calls. Instead of the UI polling `/api/state`, the
 * controller emits a "change" event whenever anything moves, and the UI re-renders.
 */

import { AdbError } from "./adb/types";
import {
  DEFAULT_PROFILE,
  type GpxFile,
  gpxDownloadName,
  gpxFilename,
  PROFILES,
} from "./beeline";
import { JobQueue, type JobsSnapshot, type Report, type Task } from "./jobs";
import {
  parseDurationSec,
  parseKm,
  parseKmh,
  parseMeters,
  type RideDetail,
  rideDatetime,
  rideMonth,
  rideShortLabel,
  sinceFromPreset,
} from "./parsing";
import type { RideSource, SourceFactory } from "./source";
import { monthKey, monthLabel, type Settings, type Store, type UpsertFields } from "./store";
import { encodedTrackToGpx, gpxToRoughTrack } from "./track";

export interface RideView {
  key: string;
  title: string;
  /** Extra location suffix gathered at check time (e.g. ", Amstelveen"); "" when none. */
  location: string;
  distance: string;
  duration: string;
  status: string;
  stats: Record<string, string>;
  track: string;
  /** Lat/lon points read from the downloaded GPX (0 when none captured). */
  track_src_points: number;
  /** Points kept in the rough track after simplification (0 when none). */
  track_points: number;
  /** Length of the source GPX track in kilometres (0 when unknown). */
  track_km: number;
  /** Size of the downloaded GPX file in bytes (0 when unknown). */
  track_bytes: number;
  // -- Normalized numeric figures (the single source of truth for all maths) --
  // Parsed ONCE here, at the boundary, from the localized phone strings via the
  // canonical locale-aware parsers in ./parsing — so "13,5km" (comma-decimal)
  // and "13.5km" yield the same 13.5. Downstream code (filters, rollups, stats,
  // display) must read these numbers and never re-parse the raw strings.
  /** Best reported distance in km: detail "Distance" → summary → measured track. 0 when unknown. */
  distance_km: number;
  /** Average speed in km/h from the detail stats; 0 when unknown. */
  avg_speed_kmh: number;
  /** Max speed in km/h from the detail stats; 0 when unknown. */
  max_speed_kmh: number;
  /** Moving time in whole seconds; 0 when unknown. */
  moving_sec: number;
  /** Elapsed time in whole seconds; 0 when unknown. */
  elapsed_sec: number;
  /** Elevation gain in metres; 0 when unknown. */
  elevation_gain_m: number;
  /** Elevation loss in metres; 0 when unknown. */
  elevation_loss_m: number;
  /** Phone model this ride was last scanned from ("" when never recorded). */
  device_model: string;
  month_key: string;
  month_label: string;
  uploaded_at: string;
  deleted: boolean;
  deleted_at: string;
}

export interface AppState {
  rides: RideView[];
  jobs: JobsSnapshot;
  speed: string;
  settings: Settings;
  connected: boolean;
  device: string;
}

export type Transport = SourceFactory;

/** A pulled GPX file handed to the UI for download. */
export type GpxListener = (file: GpxFile) => void;

export class Controller {
  readonly store: Store;
  readonly jobs: JobQueue;
  speed: string = DEFAULT_PROFILE;

  private source: RideSource | null = null;
  private deviceLabel = "";
  private readonly listeners = new Set<() => void>();
  private readonly gpxListeners = new Set<GpxListener>();

  constructor(
    private readonly sourceFactory: SourceFactory,
    store: Store,
  ) {
    this.store = store;
    this.jobs = new JobQueue(
      (task, report) => this.runTask(task, report),
      () => this.notify(),
    );
  }

  // -- change notification ----------------------------------------------

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Subscribe to pulled GPX files (for triggering a browser download). */
  onGpx(fn: GpxListener): () => void {
    this.gpxListeners.add(fn);
    return () => this.gpxListeners.delete(fn);
  }

  private emitGpx(file: GpxFile): void {
    for (const fn of this.gpxListeners) fn(file);
  }

  // -- connection --------------------------------------------------------

  get connected(): boolean {
    return this.source !== null;
  }

  async connect(): Promise<void> {
    if (this.source) return;
    const source = await this.sourceFactory();
    source.setTiming(PROFILES[this.speed]);
    this.source = source;
    this.deviceLabel = source.label();
    this.notify();
  }

  async disconnect(): Promise<void> {
    if (this.source) {
      await this.source.close();
    }
    this.source = null;
    this.deviceLabel = "";
    this.notify();
  }

  setSpeed(name: string): string {
    if (name in PROFILES) {
      this.speed = name;
      this.source?.setTiming(PROFILES[name]);
    }
    return this.speed;
  }

  /** The connected source, or throw if nothing is connected. */
  private sourceFor(): RideSource {
    if (!this.source) {
      throw new AdbError("No device connected — click Connect first.");
    }
    return this.source;
  }

  /**
   * Per-ride attribution stamped onto every record we write while connected, so
   * the cache records which source (and, for ADB, which phone) the info came from.
   * Empty fields are omitted so they never overwrite a known value.
   */
  private deviceFields(): UpsertFields {
    return this.source ? this.source.deviceFields() : {};
  }

  // -- state for the UI --------------------------------------------------

  state(): AppState {
    const records = [...this.store.rides.values()].sort((a, b) => a.key.localeCompare(b.key));
    const rides: RideView[] = records.map((r) => {
      // Split the fuller checked title into the scan name + colored location suffix.
      const base = r.title_base;
      const full = r.title;
      const hasSuffix = base !== "" && full.startsWith(base) && full.length > base.length;
      const stats = r.stats;
      // Normalize every numeric figure here, once, via the canonical locale-aware
      // parsers — this is the boundary where localized phone strings become the
      // numbers the rest of the app computes and displays from.
      const reportedKm = parseKm(stats?.Distance || r.distance || "");
      const distance_km = reportedKm > 0 ? reportedKm : r.track_km > 0 ? r.track_km : 0;
      return {
        key: r.key,
        title: hasSuffix ? base : full,
        location: hasSuffix ? full.slice(base.length) : "",
        distance: r.distance,
        duration: r.duration,
        status: r.strava_status,
        stats,
        track: r.track,
        track_src_points: r.track_src_points,
        track_points: r.track_points,
        track_km: r.track_km,
        track_bytes: r.track_bytes,
        distance_km,
        avg_speed_kmh: parseKmh(stats?.["Average speed"] || ""),
        max_speed_kmh: parseKmh(stats?.["Max speed"] || ""),
        moving_sec: parseDurationSec(stats?.["Moving time"] || ""),
        elapsed_sec: parseDurationSec(stats?.["Elapsed time"] || ""),
        elevation_gain_m: parseMeters(stats?.["Elevation gain"] || ""),
        elevation_loss_m: parseMeters(stats?.["Elevation loss"] || ""),
        device_model: r.device_model,
        month_key: monthKey(r),
        month_label: monthLabel(r),
        uploaded_at: r.uploaded_at,
        deleted: r.deleted,
        deleted_at: r.deleted_at,
      };
    });
    return {
      rides,
      jobs: this.jobs.snapshot(),
      speed: this.speed,
      settings: { ...this.store.settings },
      connected: this.connected,
      device: this.deviceLabel,
    };
  }

  // -- task dispatch (runs on the queue worker) --------------------------

  private async runTask(task: Task, report: Report): Promise<void> {
    if (task.kind === "scan") await this.doScan(task, report);
    else if (task.kind === "status") await this.doTargets(task, report, false);
    else if (task.kind === "upload") await this.doTargets(task, report, true);
    else if (task.kind === "download-gpx") await this.doDownloadGpx(task, report);
  }

  private async doScan(task: Task, report: Report): Promise<void> {
    const preset = (task.payload.preset as string) ?? "all";
    const days = (task.payload.days as number | null) ?? null;
    const since = sinceFromPreset(preset, days);
    const label = preset !== "custom" ? preset : `last ${days}d`;
    const source = this.sourceFor();
    let cancelled = false;
    const rep = (msg: string): boolean => {
      const c = report(msg);
      if (c) cancelled = true;
      return c;
    };
    rep(`scanning (${label})…`);
    const seen = new Set<string>();
    const { cards, complete } = await source.enumerateCatalog(rep, since, (fresh) => {
      // Persist and surface each page of rides the moment they are found.
      for (const c of fresh) {
        seen.add(c.key);
        this.store.upsert(c.key, {
          ...this.deviceFields(),
          title_base: c.title,
          distance: c.distance,
          duration: c.duration,
          // A source may already know the full record at scan time (Beeline fetches
          // track + stats + Strava status in one request); merge those when present.
          ...(c.fields ?? {}),
        });
      }
      this.store.save();
      this.notify();
    });
    // A scan reads the COMPLETE list for its window, so any ride we knew about
    // within that window but did not see has been deleted on the phone. Only
    // reconcile when the scan both ran to completion AND was verified to have read
    // the real Journeys list end-to-end (`complete`). A cancelled scan is partial,
    // and an incomplete scan means the phone may have drifted to another app/screen
    // mid-pass — in either case treating unseen rides as deleted would be wrong.
    let removed = 0;
    if (!cancelled && complete) {
      for (const r of this.store.rides.values()) {
        if (r.deleted || seen.has(r.key)) continue;
        const dt = rideDatetime(r.key);
        if (dt === null) continue; // can't place it in the window — leave it be
        if (since !== null && dt < since) continue; // outside the scanned window
        if (this.store.markDeleted(r.key)) removed++;
      }
      if (removed) {
        this.store.save();
        this.notify();
      }
    }
    const suffix = removed ? `, ${removed} deleted` : "";
    report(`scan done (${label}): ${cards.length} rides${suffix}`);
  }

  private async doTargets(task: Task, report: Report, doUpload: boolean): Promise<void> {
    const source = this.sourceFor();
    let uploaded = 0;
    let removed = 0;
    const failures: string[] = [];
    // Seed live progress so the queue panel shows "0 of N" the moment work starts;
    // each processed ride bumps `done` below.
    task.progress = { done: 0, total: task.keys.length };
    const details = await source.processTargets(
      new Set(task.keys),
      doUpload,
      (msg) => report(msg),
      (d) => {
        // Persist and surface each ride's status the moment it is read/uploaded.
        this.persistDetail(d);
        if (d.stravaStatus === "uploaded") uploaded++;
        if (task.progress) task.progress.done++;
      },
      (missing) => {
        // Searched the whole list and never found these → deleted on the phone.
        for (const key of missing) if (this.store.markDeleted(key)) removed++;
        if (removed) {
          this.store.save();
          this.notify();
        }
      },
      (key, reason) => {
        // One ride threw mid-sweep: it was isolated and skipped so the rest still
        // ran. Collect it and surface every failure as one persistent error below.
        failures.push(`${rideShortLabel(key) || key}: ${reason}`);
        if (task.progress) task.progress.done++;
      },
    );
    const suffix = removed ? `, ${removed} deleted` : "";
    if (doUpload)
      report(`done: ${uploaded} now on Strava (${details.length} processed)${suffix}`);
    else report(`checked ${details.length} rides${suffix}`);

    if (failures.length) {
      // Fail the task so the UI shows a persistent, acknowledgeable error with full
      // per-ride detail — not a status message that just blinks past. The rides that
      // did succeed are already persisted above; this only reports the ones that didn't.
      const verb = doUpload ? "upload" : "check";
      const header = `${failures.length} of ${task.keys.length} ride${
        task.keys.length === 1 ? "" : "s"
      } failed to ${verb} (${details.length} succeeded):`;
      throw new Error([header, ...failures.map((f) => `  • ${f}`)].join("\n"));
    }
  }

  /**
   * Persist a freshly read ride detail (title, Strava status, stats) and surface it.
   * Backfills the one-line summary fields (distance/duration) from the detail when
   * the list scan never captured them, so the summary, distance chart and KPIs all
   * agree with the expanded detail instead of showing "?".
   */
  private persistDetail(d: RideDetail): void {
    const cur = this.store.rides.get(d.key);
    const fields: UpsertFields = {
      ...this.deviceFields(),
      title: d.title,
      strava_status: d.stravaStatus,
      stats: d.stats,
    };
    if (!cur?.distance && d.stats.Distance) fields.distance = d.stats.Distance;
    if (!cur?.duration) {
      const dur = d.stats["Elapsed time"] || d.stats["Moving time"];
      if (dur) fields.duration = dur;
    }
    this.store.upsert(d.key, fields);
    this.store.save();
    this.notify();
  }

  private async doDownloadGpx(task: Task, report: Report): Promise<void> {
    // Two modes: preview-only (default) just stores the rough track for the mini-map;
    // save mode additionally hands the full GPX to the UI to write to disk.
    const saveToDisk = task.payload.saveToDisk === true;
    let removed = 0;
    let succeeded = 0;
    const failures: string[] = [];
    // Seed live progress so the queue panel shows "0 of N" while the sweep runs.
    task.progress = { done: 0, total: task.keys.length };

    // Rides that already carry their FULL route in the cache (Beeline-sourced) can
    // be exported entirely locally — no device, no network, no sign-in. Split those
    // out and synthesize their GPX from the stored track; only the rest need the
    // source. This is why GPX export works in Beeline's offline, cached-rides mode.
    const remote: string[] = [];
    for (const key of task.keys) {
      const rec = this.store.rides.get(key);
      if (rec && rec.source === "beeline" && rec.track) {
        const title = rec.title || rec.title_base || "";
        const xml = encodedTrackToGpx(rec.track, title || rideShortLabel(key) || key);
        if (xml) {
          if (saveToDisk) {
            this.emitGpx({
              key,
              filename: gpxFilename(key),
              downloadName: gpxDownloadName(key, title),
              bytes: new TextEncoder().encode(xml),
            });
          }
          succeeded++;
        } else {
          failures.push(`${rideShortLabel(key) || key}: no route track to export`);
        }
        if (task.progress) task.progress.done++;
      } else {
        remote.push(key);
      }
    }

    // Only touch the source for rides that still need a real download (ADB pulls the
    // GPX off the phone; rides without a cached full track). When every requested
    // ride was handled locally, we never call sourceFor() — so no spurious
    // "No device connected" in a source-less mode.
    if (remote.length) {
      const source = this.sourceFor();
      const files = await source.downloadGpx(
        new Set(remote),
        (msg) => report(msg),
        (file) => {
          // Keep only a rough, compressed sketch of the route — never the full GPX.
          const rough = gpxToRoughTrack(file.bytes, this.store.settings.trackPointsPerKm);
          if (rough.polyline) {
            this.store.upsert(file.key, {
              ...this.deviceFields(),
              track: rough.polyline,
              track_src_points: rough.srcPoints,
              track_points: rough.keptPoints,
              track_km: rough.km,
              track_bytes: file.bytes.length,
            });
            this.store.save();
            this.notify();
          } else {
            // We pulled the file but couldn't read a GPS track out of it. Don't store a
            // bogus empty track; record it so the task surfaces a real, persistent error.
            failures.push(`${file.key}: couldn't extract a GPS track from the downloaded GPX`);
          }
          // Only hand the full file to the UI when the user actually asked to save it.
          if (saveToDisk) this.emitGpx(file);
          if (task.progress) task.progress.done++;
        },
        (missing) => {
          for (const key of missing) if (this.store.markDeleted(key)) removed++;
          if (removed) {
            this.store.save();
            this.notify();
          }
        },
        (key, reason) => failures.push(`${key}: ${reason}`),
        // Capture the ride's detail read during the export so a GPX download on a
        // ride we never opened still records its title/stats/Strava status.
        (detail) => this.persistDetail(detail),
      );
      succeeded += files.length;
    }

    const suffix = removed ? `, ${removed} deleted` : "";
    const noun = saveToDisk ? "GPX file" : "preview";
    report(`downloaded ${succeeded} ${noun}${succeeded === 1 ? "" : "s"}${suffix}`);

    if (failures.length) {
      // Fail the task so the UI shows a persistent, acknowledgeable error with full
      // per-ride detail under "Details" — not a status message that just blinks past.
      const header = `${failures.length} of ${task.keys.length} GPX download${
        task.keys.length === 1 ? "" : "s"
      } failed (${succeeded} succeeded):`;
      throw new Error([header, ...failures.map((f) => `  • ${f}`)].join("\n"));
    }
  }

  // -- enqueue helpers / API surface ------------------------------------

  scan(preset: string, days: number | null): TaskSnapshotResult {
    const label = preset !== "custom" ? preset : `last ${days}d`;
    return this.jobs.submit("scan", { label, payload: { preset, days } });
  }

  status(keys: string[], label = ""): TaskSnapshotResult {
    return this.jobs.submit("status", { label: label || `${keys.length} rides`, keys });
  }

  upload(keys: string[], label = ""): TaskSnapshotResult {
    // Never re-upload a ride that's already on Strava: filter out uploaded keys at the
    // single choke point every caller funnels through (per-ride, selection, month, year,
    // all-pending), so no UI path can submit a duplicate upload.
    const fresh = keys.filter((k) => this.store.rides.get(k)?.strava_status !== "uploaded");
    return this.jobs.submit("upload", {
      label: label || `${fresh.length} rides`,
      keys: fresh,
    });
  }

  /**
   * Download GPX for the given rides. By default this is *preview-only*: it stores a
   * rough track for the mini-map and never touches the disk. Pass `saveToDisk = true`
   * to also hand the full GPX file to the UI to write out.
   */
  downloadGpx(keys: string[], saveToDisk = false, label = ""): TaskSnapshotResult {
    return this.jobs.submit("download-gpx", {
      label: label || `${keys.length} rides`,
      keys,
      payload: { saveToDisk },
    });
  }

  /** Update the rough-track density (points/km, persisted). Returns the clamped value. */
  setTrackPointsPerKm(n: number): number {
    const v = this.store.setTrackPointsPerKm(n);
    this.notify();
    return v;
  }

  /** Update the average-speed outlier trim (slow/fast %, persisted). Returns the clamped pair. */
  setSpeedTrim(slowPct: number, fastPct: number): { slowPct: number; fastPct: number } {
    const v = this.store.setSpeedTrim(slowPct, fastPct);
    this.notify();
    return v;
  }

  /** Update the heatmap glow radius (px, persisted). Returns the clamped value. */
  setHeatRadius(n: number): number {
    const v = this.store.setHeatRadius(n);
    this.notify();
    return v;
  }

  /** Update how many Beeline uploads run at once (persisted). Returns the clamped value. */
  setBeelineUploadConcurrency(n: number): number {
    const v = this.store.setBeelineUploadConcurrency(n);
    this.notify();
    return v;
  }

  cancel(id: number | null): void {
    if (id === null) this.jobs.cancelAll();
    else this.jobs.cancel(id);
  }

  clear(): number {
    return this.jobs.clear();
  }

  /**
   * Wipe all local state: cancel/clear the job queue and empty the ride cache.
   * Destroys browser-side data only; nothing on the phone is affected.
   */
  reset(): void {
    this.jobs.cancelAll();
    this.jobs.clear();
    this.store.clear();
    this.notify();
  }

  // -- import / export ---------------------------------------------------

  /** Force any pending debounced cache write out now (e.g. before the page unloads). */
  flush(): Promise<void> {
    return this.store.flush();
  }

  exportJson(): string {
    return this.store.exportJson();
  }

  importJson(text: string): number {
    const n = this.store.importJson(text);
    this.notify();
    return n;
  }

  /** Byte size of the locally persisted state, for a human-readable size hint. */
  stateBytes(): number {
    return this.store.byteSize();
  }
}

// `submit` returns a task snapshot; alias keeps the surface readable.
type TaskSnapshotResult = ReturnType<JobQueue["submit"]>;

export { rideMonth };
