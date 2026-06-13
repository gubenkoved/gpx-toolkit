/**
 * WebUSB ADB transport — the real device implementation of `AdbDevice`.
 *
 * Uses Tango (ya-webadb) v2: WebUSB permission → claim the ADB interface →
 * authenticate (RSA handshake, may show the on-device "Allow USB debugging?"
 * prompt) → an `Adb` client. All shell commands go through the legacy `shell:`
 * service (none-protocol) so binary output is not newline-mangled — matching how
 * the Python wrapper shells out to `adb shell ...`.
 *
 * Requirements: a Chromium browser, a secure context (HTTPS or localhost), and
 * NO local `adb` server running (it would hold the USB interface).
 *
 * NOTE: connection/auth is implemented but NOT yet exercised against a real
 * device per the current task constraints — the demo transport backs all dev
 * and testing. The code path is ready for the first live run.
 */

import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";

import { AdbError, shellQuote, type AdbDevice, type Size } from "./types";

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class WebUsbAdb implements AdbDevice {
  private constructor(
    private readonly adb: Adb,
    private readonly serial: string,
  ) {}

  /** Run the WebUSB permission + authentication flow and return a connected device. */
  static async connect(): Promise<WebUsbAdb> {
    const manager = WebUsbAdb.manager();
    let device: AdbDaemonWebUsbDevice | undefined;
    try {
      device = await manager.requestDevice();
    } catch (err) {
      throw new AdbError("USB permission request failed: " + (err as Error).message);
    }
    if (!device) {
      throw new AdbError("No device selected.");
    }
    return WebUsbAdb.authenticate(device);
  }

  /**
   * Reconnect to a previously-authorized device WITHOUT prompting — the browser
   * persists WebUSB permission grants, so `getDevices()` returns them on a later
   * visit (no user gesture required). Returns null when there is no remembered
   * device or it is not currently reachable, so the caller can fall back to demo.
   *
   * `preferSerial` picks a specific remembered device when several are authorized.
   */
  static async tryReconnect(preferSerial?: string): Promise<WebUsbAdb | null> {
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager) return null;
    let devices: AdbDaemonWebUsbDevice[];
    try {
      devices = await manager.getDevices(); // already-permitted devices only
    } catch {
      return null;
    }
    if (!devices.length) return null;
    const device = (preferSerial && devices.find((d) => d.serial === preferSerial)) || devices[0];
    try {
      return await WebUsbAdb.authenticate(device);
    } catch {
      return null; // device unplugged / busy / auth declined → caller stays in demo
    }
  }

  private static manager(): AdbDaemonWebUsbDeviceManager {
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager) {
      throw new AdbError(
        "WebUSB is not available. Use a Chromium browser over HTTPS or localhost.",
      );
    }
    return manager;
  }

  private static async authenticate(device: AdbDaemonWebUsbDevice): Promise<WebUsbAdb> {
    try {
      const connection = await device.connect();
      const credentialStore = new AdbWebCredentialStore("beeline-uploader-web");
      const transport = await AdbDaemonTransport.authenticate({
        serial: device.serial,
        connection,
        credentialStore,
      });
      return new WebUsbAdb(new Adb(transport), device.serial);
    } catch (err) {
      if (err instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
        throw new AdbError(
          "Device is busy. Stop any local adb server (adb kill-server) or other app using it, then retry.",
        );
      }
      throw new AdbError("Connection failed: " + (err as Error).message);
    }
  }

  // -- shell helpers -----------------------------------------------------

  private async runRaw(command: string): Promise<Uint8Array> {
    const process = await this.adb.subprocess.noneProtocol.spawn(command);
    const chunks: Uint8Array[] = [];
    const reader = process.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    await process.exited;
    return concatChunks(chunks);
  }

  private async runText(command: string): Promise<string> {
    return new TextDecoder().decode(await this.runRaw(command));
  }

  // -- AdbDevice ---------------------------------------------------------

  async model(): Promise<string> {
    return (await this.runText("getprop ro.product.model")).trim();
  }

  async screenSize(): Promise<Size> {
    const out = (await this.runText("wm size")).trim();
    const m = out.match(/(\d+)x(\d+)/);
    if (!m) throw new AdbError(`could not parse screen size from: ${JSON.stringify(out)}`);
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  async currentFocus(): Promise<string> {
    const out = await this.runText("dumpsys window");
    for (const line of out.split("\n")) {
      if (line.includes("mCurrentFocus")) return line.trim();
    }
    return "";
  }

  async isPackageInstalled(pkg: string): Promise<boolean> {
    const out = await this.runText(`pm list packages ${pkg}`);
    return out.split("\n").some((line) => line.trim() === `package:${pkg}`);
  }

  async uiDump(): Promise<string> {
    // uiautomator writes to a file on the device; read it back via cat.
    await this.runText("uiautomator dump /sdcard/window_dump.xml");
    return this.runText("cat /sdcard/window_dump.xml");
  }

  async tap(x: number, y: number): Promise<void> {
    await this.runText(`input tap ${Math.trunc(x)} ${Math.trunc(y)}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 350): Promise<void> {
    await this.runText(
      `input swipe ${Math.trunc(x1)} ${Math.trunc(y1)} ${Math.trunc(x2)} ${Math.trunc(y2)} ${Math.trunc(ms)}`,
    );
  }

  async back(): Promise<void> {
    await this.runText("input keyevent KEYCODE_BACK");
  }

  async launch(pkg: string): Promise<void> {
    await this.runText(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  }

  async shell(command: string): Promise<string> {
    return this.runText(command);
  }

  async readFile(remotePath: string): Promise<Uint8Array> {
    // Stream the file's raw bytes via `cat`; none-protocol keeps binary intact.
    return this.runRaw(`cat ${shellQuote(remotePath)}`);
  }

  async close(): Promise<void> {
    try {
      await this.adb.close();
    } catch {
      /* ignore */
    }
  }

  get deviceSerial(): string {
    return this.serial;
  }
}
