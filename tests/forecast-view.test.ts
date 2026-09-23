import { afterEach, describe, expect, it, vi } from "vitest";

import type { ForecastModel, HourlyForecast } from "../src/forecast";
import { ForecastStore } from "../src/forecast-store";
import {
  initForecastView,
  leaveForecastView,
  mountForecastView,
  resetForecastViewData,
} from "../src/forecast-view";
import { memoryBlobBackend } from "../src/kv";

vi.mock("../src/map-core", () => ({
  createInteractiveMap: vi.fn(),
  createLocationPointIcon: vi.fn(),
}));
vi.mock("../src/tz", () => ({
  browserZone: () => "UTC",
  loadTz: async () => {},
  zoneForPoint: () => "UTC",
}));
vi.mock("../src/forecast-chart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/forecast-chart")>();
  return { ...actual, drawForecastComparison: vi.fn(), drawForecastRow: vi.fn() };
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-21T08:00:00Z");
const model: ForecastModel = {
  id: "ecmwf_ifs",
  provider: "ECMWF",
  label: "IFS HRES",
  resolution: "9 km",
  nativeHours: 1,
  updateHours: 6,
  horizonDays: 15,
};

function pointer(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
  });
  return event;
}

function forecastAt(
  forecastModel: ForecastModel,
  point: HourlyForecast["point"],
  fetchedAt: number,
  requestedHours = 72,
): HourlyForecast {
  const times = [NOW, NOW + HOUR];
  const numbers = times.map(() => 12);
  return {
    modelId: forecastModel.id,
    point,
    gridLat: point.lat,
    gridLon: point.lon,
    times,
    windSpeedKmh: numbers,
    windDirectionDeg: numbers.map(() => 315),
    windGustKmh: numbers.map(() => 24),
    precipitationMm: numbers.map(() => 0),
    temperatureC: numbers.map(() => 17),
    pressureHpa: numbers.map(() => 1030),
    cloudCoverPct: numbers.map(() => 90),
    fetchedAt,
    // Deliberately preserve the old six-hour policy in fixtures: the view must use fetchedAt.
    freshUntil: fetchedAt + 6 * HOUR,
    requestedHours,
  };
}

function forecastTimerMarkup(): void {
  document.body.innerHTML =
    `<div id="forecastView"><small id="forecastStatus"></small>` +
    `<time id="forecastFetchedAt" hidden><span class="fc-fetched-prefix">Updated </span><span id="forecastFetchedAge"></span></time>` +
    `<button id="forecastRefresh">Refresh</button></div>`;
}

describe("forecast presentation view", () => {
  afterEach(() => {
    leaveForecastView();
    resetForecastViewData(true);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("steps touch details, remembers resized height, and labels only real day changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 760px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: window.ResizeObserver,
    });
    HTMLElement.prototype.setPointerCapture = vi.fn();
    document.body.innerHTML =
      `<div id="forecastView"><button id="forecastSettingsOpen" aria-expanded="false">Settings</button>` +
      `<div id="forecastSettingsModal" class="hidden"><button id="forecastSettingsClose">Close</button>` +
      `<div id="forecastSpeedUnit"><button data-speed-unit="ms">m/s</button><button data-speed-unit="kmh">km/h</button></div>` +
      `<fieldset id="forecastMetricList"><input type="checkbox" data-forecast-metric="windSpeed" checked></fieldset>` +
      `<div id="forecastModelsList"></div></div>` +
      `<div id="forecastPresentation"><button data-presentation="textual">Table</button></div>` +
      `<div id="forecastReadout"></div><div id="forecastLegend"></div>` +
      `<div id="forecastCharts"></div><section id="forecastCompareDetail" class="hidden"></section></div>`;

    const store = await ForecastStore.load(memoryBlobBackend());
    const point = { lat: 52.37, lon: 4.9, label: "Amsterdam" };
    await store.setPrefs({ lastPoint: point });
    const times = Array.from({ length: 20 }, (_, index) => NOW + index * HOUR);
    const numbers = times.map(() => 12);
    const forecast: HourlyForecast = {
      modelId: model.id,
      point,
      gridLat: point.lat,
      gridLon: point.lon,
      times,
      windSpeedKmh: numbers,
      windDirectionDeg: numbers.map(() => 315),
      windGustKmh: numbers.map(() => 24),
      precipitationMm: numbers.map(() => 0),
      temperatureC: numbers.map(() => 17),
      pressureHpa: numbers.map(() => 1030),
      cloudCoverPct: numbers.map(() => 90),
      fetchedAt: NOW,
      freshUntil: NOW + HOUR,
      requestedHours: 72,
    };
    await store.putForecast(forecast);
    initForecastView({
      provider: {
        id: "test",
        models: [model],
        searchLocations: async () => [],
        fetchForecast: async () => ({ point, forecasts: [forecast] }),
      },
      ensureStore: async () => store,
      toast: vi.fn(),
      esc: (value) => value,
    });
    await mountForecastView();

    const settings = document.getElementById("forecastSettingsModal")!;
    document.getElementById("forecastSettingsOpen")!.click();
    expect(settings.classList.contains("hidden")).toBe(false);
    expect(document.activeElement?.id).toBe("forecastSettingsClose");
    expect(
      document.getElementById("forecastSettingsOpen")?.getAttribute("aria-expanded"),
    ).toBe("true");
    document.querySelector<HTMLButtonElement>("[data-speed-unit='ms']")!.click();
    expect(
      document.querySelector("[data-speed-unit='ms']")?.classList.contains("active"),
    ).toBe(true);
    settings.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(settings.classList.contains("hidden")).toBe(true);
    expect(document.activeElement?.id).toBe("forecastSettingsOpen");
    document.getElementById("forecastSettingsOpen")!.click();
    settings.click();
    expect(settings.classList.contains("hidden")).toBe(true);

    const canvas = document.querySelector<HTMLCanvasElement>(".fc-compare-canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 620,
      height: 300,
    } as DOMRect);
    canvas.dispatchEvent(pointer("pointerdown", 58, 50));
    canvas.dispatchEvent(pointer("pointerup", 58, 50));
    const sheet = document.getElementById("forecastCompareDetail")!;
    expect(sheet.classList.contains("hidden")).toBe(false);
    const stepGroup = sheet.querySelector(".fc-detail-step-group");
    expect(stepGroup?.querySelectorAll("button")).toHaveLength(2);
    expect(stepGroup?.querySelectorAll("button svg")).toHaveLength(2);
    expect(sheet.querySelector(".fc-detail-title b")?.textContent).toBe("Wind");
    expect(
      [...sheet.querySelectorAll(".fc-detail-models thead th")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["Model", "Wind m/s", "Gust m/s", "From"]);
    expect(
      sheet.querySelector(".fc-detail-models tbody tr:last-child")?.textContent,
    ).not.toContain("Wind ");
    expect(
      document.getElementById("forecastCompareDetailPrev")?.hasAttribute("disabled"),
    ).toBe(true);

    const next = document.getElementById("forecastCompareDetailNext") as HTMLButtonElement;
    next.focus();
    const list = sheet.querySelector<HTMLElement>(".fc-detail-models")!;
    list.scrollTop = 17;
    next.click();
    expect(sheet.querySelector(".fc-detail-title small")?.textContent).toContain("09:00");
    expect(document.activeElement?.id).toBe("forecastCompareDetailNext");
    expect(sheet.querySelector<HTMLElement>(".fc-detail-models")?.scrollTop).toBe(17);
    for (let hour = 0; hour < 18; hour++) {
      (document.getElementById("forecastCompareDetailNext") as HTMLButtonElement).click();
    }
    expect(
      document.getElementById("forecastCompareDetailNext")?.hasAttribute("disabled"),
    ).toBe(true);
    (document.getElementById("forecastCompareDetailPrev") as HTMLButtonElement).click();
    expect(
      document.getElementById("forecastCompareDetailNext")?.hasAttribute("disabled"),
    ).toBe(false);

    vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue({ height: 300 } as DOMRect);
    const handle = document.getElementById("forecastCompareDetailResize")!;
    handle.dispatchEvent(pointer("pointerdown", 0, 250));
    handle.dispatchEvent(pointer("pointermove", 0, 150));
    handle.dispatchEvent(pointer("pointerup", 0, 150));
    expect(sheet.style.height).toBe("400px");
    expect(store.prefs().compareDetailHeightPx).toBe(400);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    window.dispatchEvent(new Event("resize"));
    expect(sheet.style.height).toBe("255px");

    document.querySelector<HTMLButtonElement>("[data-presentation='textual']")!.click();
    const headings = [...document.querySelectorAll(".fc-hour-heading")];
    expect(headings).toHaveLength(20);
    expect(headings[0].querySelector("b")?.textContent).toBe("Mon 21");
    expect(headings[6].querySelector("b")).toBeNull();
    expect(headings[16].querySelector("b")?.textContent).toBe("Tue 22");
    const compact = document.querySelector(".fc-model-compact")!;
    expect(compact.querySelector("b")?.textContent).toBe("ECMWF");
    expect(compact.textContent).toBe("ECMWF IFS HRES");
  });

  it("shows the oldest fetch age and refreshes at the one-hour boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    forecastTimerMarkup();

    const store = await ForecastStore.load(memoryBlobBackend());
    const point = { lat: 52.37, lon: 4.9, label: "Amsterdam" };
    await store.setPrefs({ lastPoint: point });
    await store.putForecast(forecastAt(model, point, NOW - 59 * 60_000));
    const fetchForecast = vi.fn(
      async (requestedPoint: typeof point, ids: string[], requestedHours: number) => ({
        point: requestedPoint,
        forecasts: ids.map(() => forecastAt(model, point, Date.now(), requestedHours)),
      }),
    );
    initForecastView({
      provider: {
        id: "test",
        models: [model],
        searchLocations: async () => [],
        fetchForecast,
      },
      ensureStore: async () => store,
      toast: vi.fn(),
      esc: (value) => value,
    });

    await mountForecastView();
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(document.getElementById("forecastFetchedAt")?.textContent).toBe("Updated 59m ago");
    expect(document.getElementById("forecastFetchedAt")?.getAttribute("datetime")).toBe(
      new Date(NOW - 59 * 60_000).toISOString(),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetchForecast).toHaveBeenCalledTimes(1));
    expect(fetchForecast.mock.calls[0][1]).toEqual([model.id]);
    expect(document.getElementById("forecastFetchedAt")?.textContent).toBe("Updated just now");
  });

  it("refreshes only stale models and keeps the oldest remaining age visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    forecastTimerMarkup();

    const recentModel: ForecastModel = {
      ...model,
      id: "icon_eu",
      provider: "DWD",
      label: "ICON EU",
      updateHours: 3,
    };
    const store = await ForecastStore.load(memoryBlobBackend());
    const point = { lat: 52.37, lon: 4.9, label: "Amsterdam" };
    await store.setPrefs({ lastPoint: point, selectedModels: [model.id, recentModel.id] });
    await store.putForecast(forecastAt(model, point, NOW - 61 * 60_000));
    await store.putForecast(forecastAt(recentModel, point, NOW - 10 * 60_000));
    const fetchForecast = vi.fn(
      async (requestedPoint: typeof point, ids: string[], requestedHours: number) => ({
        point: requestedPoint,
        forecasts: ids.map(() => forecastAt(model, point, Date.now(), requestedHours)),
      }),
    );
    initForecastView({
      provider: {
        id: "test",
        models: [model, recentModel],
        searchLocations: async () => [],
        fetchForecast,
      },
      ensureStore: async () => store,
      toast: vi.fn(),
      esc: (value) => value,
    });

    await mountForecastView();
    expect(fetchForecast).toHaveBeenCalledTimes(1);
    expect(fetchForecast.mock.calls[0][1]).toEqual([model.id]);
    expect(document.getElementById("forecastFetchedAt")?.textContent).toBe("Updated 10m ago");
    expect(document.getElementById("forecastStatus")?.textContent).not.toContain(
      "oldest update",
    );
  });

  it("keeps the stale timestamp on failure, retries after five minutes, and stops on leave", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    forecastTimerMarkup();

    const store = await ForecastStore.load(memoryBlobBackend());
    const point = { lat: 52.37, lon: 4.9, label: "Amsterdam" };
    await store.setPrefs({ lastPoint: point });
    await store.putForecast(forecastAt(model, point, NOW - 61 * 60_000));
    const fetchForecast = vi.fn(async () => {
      throw new Error("temporary failure");
    });
    initForecastView({
      provider: {
        id: "test",
        models: [model],
        searchLocations: async () => [],
        fetchForecast,
      },
      ensureStore: async () => store,
      toast: vi.fn(),
      esc: (value) => value,
    });

    await mountForecastView();
    expect(fetchForecast).toHaveBeenCalledTimes(1);
    expect(document.getElementById("forecastFetchedAt")?.textContent).toBe("Updated 1h ago");

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(fetchForecast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fetchForecast).toHaveBeenCalledTimes(2));

    leaveForecastView();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchForecast).toHaveBeenCalledTimes(2);
  });

  it("keeps stale cached data offline and refreshes immediately after reconnecting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let online = false;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
    forecastTimerMarkup();

    const store = await ForecastStore.load(memoryBlobBackend());
    const point = { lat: 52.37, lon: 4.9, label: "Amsterdam" };
    await store.setPrefs({ lastPoint: point });
    await store.putForecast(forecastAt(model, point, NOW - 61 * 60_000));
    const fetchForecast = vi.fn(
      async (requestedPoint: typeof point, ids: string[], requestedHours: number) => ({
        point: requestedPoint,
        forecasts: ids.map(() => forecastAt(model, point, Date.now(), requestedHours)),
      }),
    );
    initForecastView({
      provider: {
        id: "test",
        models: [model],
        searchLocations: async () => [],
        fetchForecast,
      },
      ensureStore: async () => store,
      toast: vi.fn(),
      esc: (value) => value,
    });

    await mountForecastView();
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(document.getElementById("forecastStatus")?.textContent).toContain("Offline");
    expect(document.getElementById("forecastFetchedAt")?.textContent).toBe("Updated 1h ago");

    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(fetchForecast).toHaveBeenCalledTimes(1));
    expect(document.getElementById("forecastFetchedAt")?.textContent).toBe("Updated just now");
  });
});
