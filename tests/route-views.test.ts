import { afterEach, describe, expect, it, vi } from "vitest";
import {
  climatePoint,
  initClimateView,
  leaveClimateView,
  mountClimateView,
  setClimateRoutePoint,
} from "../src/climate-view";
import type { ForecastModel, ForecastPoint } from "../src/forecast";
import { ForecastStore } from "../src/forecast-store";
import {
  forecastPoint,
  initForecastView,
  leaveForecastView,
  mountForecastView,
  setForecastRoutePoint,
} from "../src/forecast-view";
import { memoryBlobBackend } from "../src/kv";

vi.mock("../src/tz", () => ({
  browserZone: () => "UTC",
  loadTz: async () => {},
  zoneForPoint: () => "UTC",
}));

const model: ForecastModel = {
  id: "test",
  provider: "Test",
  label: "Test",
  resolution: "1 km",
  nativeHours: 1,
  updateHours: 1,
  horizonDays: 3,
};

afterEach(() => {
  leaveForecastView();
  leaveClimateView();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("routed view points", () => {
  it("opens a forecast link ahead of the saved point and follows a later route change", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const store = await ForecastStore.load(memoryBlobBackend());
    await store.setPrefs({ lastPoint: { lat: 52.37, lon: 4.9, label: "Amsterdam" } });
    let rejectOld!: (error: Error) => void;
    const old = new Promise<never>((_resolve, reject) => {
      rejectOld = reject;
    });
    const fetchForecast = vi.fn((point: ForecastPoint) =>
      point.lat === 48.8566 ? old : Promise.resolve({ point, forecasts: [] }),
    );
    const onPointChange = vi.fn();
    const toast = vi.fn();
    initForecastView({
      provider: {
        id: "test",
        models: [model],
        searchLocations: async () => [],
        fetchForecast,
      },
      ensureStore: async () => store,
      toast,
      esc: (value) => value,
      onPointChange,
    });
    setForecastRoutePoint({ lat: 48.8566, lon: 2.3522 });
    const mounting = mountForecastView();
    await vi.waitFor(() => expect(fetchForecast).toHaveBeenCalledTimes(1));
    expect(forecastPoint()).toMatchObject({ lat: 48.8566, lon: 2.3522 });
    expect(fetchForecast).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 48.8566, lon: 2.3522 }),
      expect.any(Array),
      expect.any(Number),
      expect.any(AbortSignal),
    );
    setForecastRoutePoint({ lat: 51.5072, lon: -0.1276 });
    await vi.waitFor(() => expect(fetchForecast).toHaveBeenCalledTimes(2));
    rejectOld(new Error("old request failed"));
    await mounting;
    expect(forecastPoint()).toMatchObject({ lat: 51.5072, lon: -0.1276 });
    expect(onPointChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ lat: 51.5072, lon: -0.1276 }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("ignores a stale wind result after a new routed point is selected", async () => {
    let rejectOld!: (error: Error) => void;
    const old = new Promise<never>((_resolve, reject) => {
      rejectOld = reject;
    });
    const fresh = { cell: { lat: 51, lon: 5, gridKm: 25 }, days: [] };
    const toast = vi.fn();
    const getPointWind = vi.fn((lat: number) => (lat === 52 ? old : Promise.resolve(fresh)));
    initClimateView({ getPointWind, toast, osmAttribution: "" });
    setClimateRoutePoint({ lat: 52, lon: 4 });
    mountClimateView();
    setClimateRoutePoint({ lat: 51, lon: 5 });
    await vi.waitFor(() => expect(getPointWind).toHaveBeenCalledTimes(2));
    rejectOld(new Error("old request failed"));
    await Promise.resolve();
    expect(climatePoint()).toEqual({ lat: 51, lon: 5 });
    expect(toast).not.toHaveBeenCalled();
  });
});
