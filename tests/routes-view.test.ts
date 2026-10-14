import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryBackend } from "../src/kv";
import { newRoute, RouteStore } from "../src/routes";
import {
  initRoutesView,
  leaveRoutesView,
  mountRoutesView,
  resetRoutesView,
} from "../src/routes-view";
import type { CellDayWind, Dataset } from "../src/weather";

vi.mock("../src/tz", async (orig) => ({
  ...(await orig<typeof import("../src/tz")>()),
  browserZone: () => "UTC",
  loadTz: async () => {},
  zoneForPoint: () => "UTC",
}));

afterEach(() => {
  leaveRoutesView();
  resetRoutesView(); // the view keeps its open route and store between mounts
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function loadMarkup(): void {
  const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
}

/** The Routes view on a saved, imported route, its weather answered by hand. */
async function openRouteView() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom has no canvas: a 2D context whose every call is a no-op is enough here.
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : () => ({})),
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  loadMarkup();
  const store = new RouteStore(memoryBackend());
  await store.load();
  const r = newRoute("straight");
  r.name = "Coast loop";
  r.imported = true;
  const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [
    52.3 + i * 0.01,
    4.85 + i * 0.01,
  ]);
  r.waypoints = [line[0], line[line.length - 1]];
  r.legs = [{ points: line, eles: line.map(() => 0), snapped: true }];
  await store.put(r);
  localStorage.setItem("gpx_toolkit.routes.open", r.id);

  type Answer = { dataset: Dataset; entries: CellDayWind[]; models: string[] };
  const answers: ((v: Answer) => void)[] = [];
  const routeWeather = vi.fn(
    (_p: unknown, _d: unknown, onStage?: (msg: string) => void) =>
      new Promise<Answer>((res) => {
        onStage?.("Fetching the forecast for 24 spots along the route…");
        answers.push(res);
      }),
  );
  initRoutesView({
    getStore: async () => store,
    routeWeather,
    forecastModels: [],
    toast: vi.fn(),
    saveText: vi.fn(),
    searchPlaces: async () => [],
    homePoint: () => null,
  });
  mountRoutesView();
  return { store, r, routeWeather, answers };
}

describe("routes view", () => {
  it("waits for the forecast in flight instead of asking it again", async () => {
    const { routeWeather, answers } = await openRouteView();
    await vi.waitFor(() => expect(routeWeather).toHaveBeenCalledTimes(1));
    const banner = document.getElementById("rtBanner")!;
    expect(banner.classList.contains("hidden")).toBe(false);

    // Stepping the day within the forecast window asks for the very same cell-days.
    document.querySelector<HTMLElement>('[data-rt="day-next"]')!.click();
    document.querySelector<HTMLElement>('[data-rt="day-prev"]')!.click();
    await Promise.resolve();
    expect(routeWeather).toHaveBeenCalledTimes(1);

    // The one answer lands: the banner and the "fetching" note go.
    answers[0]({ dataset: { id: "forecast" } as Dataset, entries: [], models: [] });
    await vi.waitFor(() => expect(banner.classList.contains("hidden")).toBe(true));
    expect(document.getElementById("rtNote")?.textContent).not.toMatch(/Fetching/);
  });

  it("duplicates the open route and switches to the copy", async () => {
    const { store, r, routeWeather } = await openRouteView();
    await vi.waitFor(() => expect(routeWeather).toHaveBeenCalledTimes(1));
    document.querySelector<HTMLElement>('[data-rt="copy"]')!.click();
    await vi.waitFor(() =>
      expect(localStorage.getItem("gpx_toolkit.routes.open")).not.toBe(r.id),
    );
    expect(store.count).toBe(2);
    const copy = store.get(localStorage.getItem("gpx_toolkit.routes.open")!)!;
    expect(copy.name).toBe("Coast loop (copy)");
    expect((document.getElementById("rtName") as HTMLInputElement).value).toBe(copy.name);
    expect(store.get(r.id)?.legs).toEqual(copy.legs);
  });
});
