import { describe, expect, it, vi } from "vitest";

import { DemoAdb } from "../src/adb/demo";
import type { AdbDevice, Size } from "../src/adb/types";
import { BeelineApp, PROFILES } from "../src/beeline";
import { Controller } from "../src/controller";
import { Store } from "../src/store";

const instant = async (): Promise<void> => {};

function memStorage(): Storage {
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

/**
 * Wraps a real DemoAdb but hides the "Options" button on the ride-detail screen,
 * so the native GPX export flow can open a ride but never reach the export menu —
 * exactly the kind of mid-flow breakage the user hit ("could not find …").
 */
class NoOptionsAdb implements AdbDevice {
  constructor(private readonly inner: DemoAdb) {}
  model(): Promise<string> {
    return this.inner.model();
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
    // Drop any node line exposing the Options button so findOptionsButton fails.
    return xml
      .split("\n")
      .filter((line) => !/text="Options"/.test(line))
      .join("\n");
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
  return new Controller(async () => device, new Store(memStorage()), async () => {});
}

describe("downloadGpx surfaces mid-flow export failures", () => {
  it("reports the failing ride via onFail instead of silently skipping it", async () => {
    const app = await BeelineApp.create(new NoOptionsAdb(new DemoAdb()), PROFILES.normal, instant);
    const key = "Sat Jun 13 2026 at 14:22";

    const failed: Array<{ key: string; reason: string }> = [];
    const files = await app.downloadGpx(
      new Set([key]),
      undefined,
      undefined,
      undefined,
      (k, reason) => failed.push({ key: k, reason }),
    );

    expect(files).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].key).toBe(key);
    expect(failed[0].reason).toContain("could not find Options");
  });

  it("fails the download-gpx task with per-ride detail so the UI can surface it", async () => {
    const c = makeController(new NoOptionsAdb(new DemoAdb()));
    await c.connect();
    c.scan("all", null);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const key = "Sat Jun 13 2026 at 14:22";
    c.downloadGpx([key]);
    await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false), { timeout: 5000 });

    const errored = c.state().jobs.history.find((t) => t.kind === "download-gpx");
    expect(errored).toBeDefined();
    expect(errored!.status).toBe("error");
    expect(errored!.error).toContain(key);
    expect(errored!.error).toContain("could not find Options");
  });
});
