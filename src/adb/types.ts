/**
 * Device-agnostic ADB primitive interface.
 *
 * Everything above this line (parsing, orchestration, jobs, UI) talks only to
 * `AdbDevice`, never to a concrete transport. Today the real implementation is
 * `WebUsbAdb` (Tango over WebUSB); a `DemoAdb` fake backs the phone-free demo
 * and the tests. A future HTTP-proxy transport would just implement this same
 * interface — nothing else would change.
 *
 * Mirrors the surface of the Python `beeline_uploader.adb.Adb` wrapper, but every
 * method is async because WebUSB is inherently asynchronous.
 */

export class AdbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbError";
  }
}

export interface Size {
  width: number;
  height: number;
}

export interface AdbDevice {
  /** Human-friendly device model (e.g. "Pixel 10 Pro"). */
  model(): Promise<string>;
  /** Physical screen size, used to derive tap/scroll geometry. */
  screenSize(): Promise<Size>;
  /** The current foreground window descriptor (for app-focus checks). */
  currentFocus(): Promise<string>;
  /** Whether `package` is installed on the device. */
  isPackageInstalled(pkg: string): Promise<boolean>;
  /** Dump the current UI hierarchy and return the XML text. */
  uiDump(): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms?: number): Promise<void>;
  back(): Promise<void>;
  launch(pkg: string): Promise<void>;
  /** Run an arbitrary `adb shell` command and return its stdout text. */
  shell(command: string): Promise<string>;
  /** Read a file off the device and return its raw bytes (e.g. a pulled GPX). */
  readFile(remotePath: string): Promise<Uint8Array>;
  /** Release the device/connection (no-op for fakes). */
  close(): Promise<void>;
}

/**
 * Single-quote a string for safe use inside an `adb shell` command line.
 * Android's shell is POSIX-ish: wrap in single quotes and escape embedded quotes
 * as '\''. Essential because pulled GPX filenames contain spaces.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Sleep helper used by the orchestration layer; injectable for fast tests. */
export type Sleep = (seconds: number) => Promise<void>;

export const realSleep: Sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
