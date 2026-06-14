import { describe, expect, it, vi } from "vitest";

import { DemoAdb } from "../src/adb/demo";
import type { AdbDevice, Size } from "../src/adb/types";
import { BeelineApp, PROFILES } from "../src/beeline";
import { Controller } from "../src/controller";
import { memoryBackend } from "../src/kv";
import { AdbRideSource } from "../src/source";
import { Store } from "../src/store";

const instant = async (): Promise<void> => {};

/**
 * Wraps a real DemoAdb but makes reading ONE specific ride's detail screen throw,
 * simulating a mid-sweep failure on a single ride (a flaky read, a layout the
 * parser chokes on, etc.). The detail screen is identified by the failing ride's
 * title plus a stat label that only appears on the detail (never on the list), so
 * the journeys list and every other ride keep working normally.
 */
class FailOnRideAdb implements AdbDevice {
  constructor(
    private readonly inner: DemoAdb,
    private readonly failTitle: string,
  ) {}
  model(): Promise<string> {
    return this.inner.model();
  }
  serial(): Promise<string> {
    return this.inner.serial();
  }
  screenSize(): Promise<Size> {
    return this.inner.screenSize();
  }
  currentFocus(): Promise<string> {
    return this.inner.currentFocus();
  }
  isPackageInstalled(_pkg: string): Promise<boolean> {
    return this.inner.isPackageInstalled();
  }
  async uiDump(): Promise<string> {
    const xml = await this.inner.uiDump();
    // "Average speed" is a detail-only stat label; combined with the failing ride's
    // title it pinpoints exactly that ride's detail sheet without touching the list.
    if (xml.includes(this.failTitle) && xml.includes("Average speed")) {
      throw new Error("simulated detail read failure");
    }
    return xml;
  }
  tap(x: number, y: number): Promise<void> {
    return this.inner.tap(x, y);
  }
  swipe(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    return this.inner.swipe(x1, y1, x2, y2);
  }
  back(): Promise<void> {
    return this.inner.back();
  }
  launch(_pkg: string): Promise<void> {
    return this.inner.launch();
  }
  shell(command: string): Promise<string> {
    return this.inner.shell(command);
  }
  readFile(remotePath: string): Promise<Uint8Array> {
    return this.inner.readFile(remotePath);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

function makeController(device: AdbDevice): Controller {
  return new Controller(
    () => AdbRideSource.create(device, PROFILES.normal, async () => {}),
    new Store(memoryBackend()),
  );
}

const GOOD = "Sat Jun 13 2026 at 14:22"; // "Afternoon ride"
const BAD = "Fri Jun 12 2026 at 09:10"; // "Morning commute"

describe("a single ride's error is isolated mid-sweep", () => {
  it("processTargets keeps going past a throwing ride and reports it via onError", async () => {
    const app = await BeelineApp.create(
      new FailOnRideAdb(new DemoAdb(), "Morning commute"),
      PROFILES.normal,
      instant,
    );

    const failed: Array<{ key: string; reason: string }> = [];
    const details = await app.processTargets(
      new Set([GOOD, BAD]),
      true,
      undefined,
      undefined,
      undefined,
      (k, reason) => failed.push({ key: k, reason }),
    );

    // The good ride was still processed despite the other one throwing.
    expect(details.map((d) => d.key)).toContain(GOOD);
    expect(details.map((d) => d.key)).not.toContain(BAD);
    // The bad ride is reported as a failure, not silently dropped.
    expect(failed).toHaveLength(1);
    expect(failed[0].key).toBe(BAD);
    expect(failed[0].reason).toContain("simulated detail read failure");
  });

  it("fails the upload task with per-ride detail while still uploading the others", async () => {
    const c = makeController(new FailOnRideAdb(new DemoAdb(), "Morning commute"));
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    c.upload([GOOD, BAD]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    // The good ride made it onto Strava even though its batch-mate failed.
    const good = c.state().rides.find((r) => r.key === GOOD);
    expect(good?.status).toBe("uploaded");

    // The task ends in an acknowledgeable error naming the failed ride.
    const task = c.state().jobs.history.find((t) => t.kind === "upload");
    expect(task).toBeDefined();
    expect(task!.status).toBe("error");
    expect(task!.error).toContain("Jun 12");
    expect(task!.error).toContain("simulated detail read failure");
  });
});
