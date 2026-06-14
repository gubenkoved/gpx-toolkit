/**
 * Ride-source abstraction — the seam that lets the Controller drive either the
 * legacy phone (ADB UI automation) or a Beeline cloud account behind one API.
 *
 * The Controller owns the job queue, the Store, deletion reconciliation and all
 * progress/error handling; a `RideSource` only answers "how do I obtain ride data
 * and act on Strava". The interface deliberately mirrors the three long-running
 * `BeelineApp` methods the Controller already called (enumerate / process / GPX),
 * so the ADB path is a thin pass-through and nothing in the orchestration changed.
 *
 * Implementations:
 *  - `AdbRideSource`    — wraps a `BeelineApp` over a connected `AdbDevice` (legacy).
 *  - `BeelineRideSource`— talks to the Beeline backend (see beeline-source.ts).
 *  - demo/test fakes    — `DemoAdb` (via AdbRideSource) and `DemoBeelineSource`.
 */

import type { AdbDevice, Sleep } from "./adb/types";
import {
  BeelineApp,
  type CatalogResult,
  type GpxFile,
  type Progress,
  type Timing,
} from "./beeline";
import type { RideCard, RideDetail } from "./parsing";
import type { RideSource as RideSourceKind, UpsertFields } from "./store";

/** Which backend a source talks to (mirrors RideRecord.source, minus the legacy ""). */
export type SourceKind = Exclude<RideSourceKind, "">;

/**
 * Everything the Controller needs from a ride backend. The three data methods have
 * the exact shape of the corresponding `BeelineApp` methods, so the Controller's
 * scan / check / upload / GPX orchestration is identical across sources.
 */
export interface RideSource {
  /** Which backend this is. */
  readonly kind: SourceKind;

  /** Human label for the connection (shown in the UI, e.g. "Pixel 10 Pro" / "Beeline (a@b)"). */
  label(): string;

  /**
   * Per-ride attribution merged into every upsert the Controller makes for this
   * source — carries `source`/`source_id` plus any device identity. Empty fields
   * are omitted so they never clobber known values.
   */
  deviceFields(): UpsertFields;

  /** Apply a timing profile. ADB-only; a no-op for sources without UI pacing. */
  setTiming(timing: Timing): void;

  /** Discover rides in the time window, streaming pages via `onCards`. */
  enumerateCatalog(
    progress?: Progress,
    since?: Date | null,
    onCards?: (cards: RideCard[]) => void,
  ): Promise<CatalogResult>;

  /** Check (and optionally upload) the given rides, streaming each result via `onDetail`. */
  processTargets(
    keys: Set<string>,
    doUpload: boolean,
    progress?: Progress,
    onDetail?: (detail: RideDetail) => void,
    onMissing?: (keys: string[]) => void,
    onError?: (key: string, reason: string) => void,
  ): Promise<RideDetail[]>;

  /** Obtain a GPX file per ride, streaming each via `onGpx`. */
  downloadGpx(
    keys: Set<string>,
    progress?: Progress,
    onGpx?: (file: GpxFile) => void,
    onMissing?: (keys: string[]) => void,
    onFail?: (key: string, reason: string) => void,
    onDetail?: (detail: RideDetail) => void,
  ): Promise<GpxFile[]>;

  /** Release the underlying connection (closes the ADB device / clears the session). */
  close(): Promise<void>;
}

/** A factory the Controller calls on connect to obtain its (already-connected) source. */
export type SourceFactory = () => Promise<RideSource>;

/**
 * Legacy ride source: drives the Beeline Android app over ADB via `BeelineApp`.
 * A faithful pass-through — every data method delegates straight to the app, so
 * the long-standing UI-automation behaviour is byte-for-byte unchanged.
 */
export class AdbRideSource implements RideSource {
  readonly kind = "adb";

  private constructor(
    private readonly device: AdbDevice,
    private readonly app: BeelineApp,
    private readonly model: string,
    private readonly serial: string,
  ) {}

  /** Connect: build the `BeelineApp` (reads screen geometry) and read device identity. */
  static async create(
    device: AdbDevice,
    timing: Timing,
    sleep: Sleep,
  ): Promise<AdbRideSource> {
    const app = await BeelineApp.create(device, timing, sleep);
    let model = "device";
    try {
      model = await device.model();
    } catch {
      /* keep the generic fallback */
    }
    let serial = "";
    try {
      serial = await device.serial();
    } catch {
      /* serial unknown — non-fatal */
    }
    return new AdbRideSource(device, app, model, serial);
  }

  label(): string {
    return this.model && this.model !== "device" ? this.model : "device";
  }

  deviceFields(): UpsertFields {
    const fields: UpsertFields = { source: "adb" };
    if (this.model && this.model !== "device") fields.device_model = this.model;
    if (this.serial) fields.device_serial = this.serial;
    return fields;
  }

  setTiming(timing: Timing): void {
    this.app.timing = timing;
  }

  enumerateCatalog(
    progress?: Progress,
    since?: Date | null,
    onCards?: (cards: RideCard[]) => void,
  ): Promise<CatalogResult> {
    return this.app.enumerateCatalog(progress, since ?? null, onCards);
  }

  processTargets(
    keys: Set<string>,
    doUpload: boolean,
    progress?: Progress,
    onDetail?: (detail: RideDetail) => void,
    onMissing?: (keys: string[]) => void,
    onError?: (key: string, reason: string) => void,
  ): Promise<RideDetail[]> {
    return this.app.processTargets(keys, doUpload, progress, onDetail, onMissing, onError);
  }

  downloadGpx(
    keys: Set<string>,
    progress?: Progress,
    onGpx?: (file: GpxFile) => void,
    onMissing?: (keys: string[]) => void,
    onFail?: (key: string, reason: string) => void,
    onDetail?: (detail: RideDetail) => void,
  ): Promise<GpxFile[]> {
    return this.app.downloadGpx(keys, progress, onGpx, onMissing, onFail, onDetail);
  }

  close(): Promise<void> {
    return this.device.close();
  }
}
