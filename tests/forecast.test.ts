import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORECAST_METRICS,
  DEFAULT_FORECAST_MODEL_IDS,
  FORECAST_HISTORY_HOURS,
  type ForecastModel,
  type HourlyForecast,
  mergeForecastHistory,
  OpenMeteoForecastAdapter,
  parseOpenMeteoForecast,
  sliceForecastWindow,
  toggleModelGroupSelection,
} from "../src/forecast";
import {
  chartWidthForHours,
  compassFrom,
  convertWindSpeed,
  directionConsensus,
  forecastChartHeight,
  forecastComparisonDetails,
  forecastComparisonHeight,
  forecastLaneAtY,
  forecastLaneReadouts,
  forecastModelColor,
  hasForecastValueAt,
  hourIndexAtX,
  hourTimeAtX,
  nonOverlappingAxisLabels,
  sharedForecastScales,
  sharedForecastTimeline,
  unwrapDirections,
  windTravelDeg,
} from "../src/forecast-chart";

const models: ForecastModel[] = [
  {
    id: "knmi_harmonie_arome_netherlands",
    provider: "KNMI",
    label: "HARMONIE",
    resolution: "2 km",
    nativeHours: 1,
    updateHours: 1,
    horizonDays: 3,
  },
  {
    id: "ecmwf_ifs",
    provider: "ECMWF",
    label: "IFS",
    resolution: "9 km",
    nativeHours: 1,
    updateHours: 6,
    horizonDays: 15,
  },
];

describe("Open-Meteo forecast parsing", () => {
  it("splits suffixed model fields and preserves missing values", () => {
    const json = {
      latitude: 52.37,
      longitude: 4.9,
      hourly: {
        time: [1_700_000_000, 1_700_003_600],
        wind_speed_10m_knmi_harmonie_arome_netherlands: [10, 11],
        wind_direction_10m_knmi_harmonie_arome_netherlands: [350, 10],
        wind_gusts_10m_knmi_harmonie_arome_netherlands: [18, null],
        precipitation_knmi_harmonie_arome_netherlands: [0, 0.2],
        temperature_2m_knmi_harmonie_arome_netherlands: [14, 15],
        pressure_msl_knmi_harmonie_arome_netherlands: [1012, 1011],
        cloud_cover_knmi_harmonie_arome_netherlands: [40, 80],
        wind_speed_10m_ecmwf_ifs: [9, 10],
        wind_direction_10m_ecmwf_ifs: [340, 5],
      },
    };
    const batch = parseOpenMeteoForecast(
      json,
      { lat: 52.37, lon: 4.9, label: "Amsterdam" },
      models,
      48,
      1000,
    );
    expect(batch.forecasts).toHaveLength(2);
    expect(batch.forecasts[0].times).toEqual([1_700_000_000_000, 1_700_003_600_000]);
    expect(batch.forecasts[0].windGustKmh).toEqual([18, null]);
    expect(batch.forecasts[0].cloudCoverPct).toEqual([40, 80]);
    expect(batch.forecasts[0].freshUntil).toBe(3_601_000);
    expect(batch.forecasts[1].freshUntil).toBe(3_601_000);
    expect(batch.forecasts[1].precipitationMm).toEqual([null, null]);
  });

  it("creates a negative result when usable wind is absent", () => {
    const batch = parseOpenMeteoForecast(
      { hourly: { time: [1_700_000_000] } },
      { lat: 0, lon: 0, label: "Ocean" },
      [models[0]],
      24,
      0,
    );
    expect(batch.forecasts[0].noData).toBe(true);
  });

  it("coalesces identical in-flight model requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      await gate;
      return new Response(
        JSON.stringify({
          latitude: 1,
          longitude: 2,
          hourly: { time: [1_700_000_000], wind_speed_10m: [10], wind_direction_10m: [90] },
        }),
        { status: 200 },
      );
    });
    const adapter = new OpenMeteoForecastAdapter({
      fetch: fetchMock as typeof fetch,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    const point = { lat: 1, lon: 2, label: "Point" };
    const a = adapter.fetchForecast(point, ["ecmwf_ifs"], 24);
    const b = adapter.fetchForecast(point, ["ecmwf_ifs"], 24);
    release();
    expect(await a).toEqual(await b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("forecast_hours")).toBe("24");
    expect(url.searchParams.get("past_hours")).toBe(String(FORECAST_HISTORY_HOURS));
  });

  it("fills missing past hours from cache without extending the future", () => {
    const now = 1_700_000_000_000;
    const hour = 3_600_000;
    const row = (
      times: number[],
      speeds: Array<number | null>,
      fetchedAt: number,
    ): HourlyForecast => ({
      modelId: "ecmwf_ifs",
      point: { lat: 52, lon: 5, label: "Point" },
      gridLat: 52,
      gridLon: 5,
      times,
      windSpeedKmh: speeds,
      windDirectionDeg: speeds.map(() => 180),
      windGustKmh: speeds.map(() => null),
      precipitationMm: speeds.map(() => null),
      temperatureC: speeds.map(() => null),
      pressureHpa: speeds.map(() => null),
      cloudCoverPct: speeds.map(() => null),
      fetchedAt,
      freshUntil: fetchedAt + hour,
      requestedHours: 24,
    });
    const cached = row([now - 25 * hour, now - hour, now, now + 2 * hour], [5, 7, 8, 99], 1);
    const latest = row([now - hour, now, now + hour], [null, 10, 11], 2);

    const merged = mergeForecastHistory(latest, cached, now);
    expect(merged.times).toEqual([now - hour, now, now + hour]);
    expect(merged.windSpeedKmh).toEqual([7, 10, 11]);
    expect(merged.fetchedAt).toBe(2);

    const long = row(
      [now - hour, now, now + hour, now + 72 * hour, now + 73 * hour],
      [7, 10, 11, 20, 21],
      3,
    );
    const windowed = sliceForecastWindow(long, now - hour, now + 72 * hour);
    expect(windowed.times).toEqual([now - hour, now, now + hour]);
    expect(windowed.windSpeedKmh).toEqual([7, 10, 11]);
    expect(windowed.windDirectionDeg).toHaveLength(3);
    expect(long.times).toHaveLength(5);
  });

  it("bisects a rejected batch and preserves supported models", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requested = new URL(String(input)).searchParams.get("models") ?? "";
      if (requested.includes(",") || requested === "ecmwf_ifs025") {
        return new Response("unsupported model", { status: 400 });
      }
      return new Response(
        JSON.stringify({
          latitude: 52.37,
          longitude: 4.9,
          hourly: {
            time: [1_700_000_000],
            wind_speed_10m: [12],
            wind_direction_10m: [270],
          },
        }),
        { status: 200 },
      );
    });
    const adapter = new OpenMeteoForecastAdapter({
      fetch: fetchMock as typeof fetch,
      now: () => 1000,
      sleep: () => Promise.resolve(),
    });

    const batch = await adapter.fetchForecast(
      { lat: 52.37, lon: 4.9, label: "Amsterdam" },
      ["ecmwf_ifs", "ecmwf_ifs025"],
      72,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(batch.forecasts.find((item) => item.modelId === "ecmwf_ifs")?.noData).toBeFalsy();
    const unavailable = batch.forecasts.find((item) => item.modelId === "ecmwf_ifs025");
    expect(unavailable?.noData).toBe(true);
    expect(unavailable?.requestedHours).toBe(72);
  });
});

describe("forecast chart geometry", () => {
  it("toggles whole model groups while retaining catalog order", () => {
    const all = ["knmi-a", "knmi-b", "ecmwf-a", "dwd-a"];
    const knmi = ["knmi-a", "knmi-b"];

    expect(toggleModelGroupSelection(all, knmi, all)).toEqual(["ecmwf-a", "dwd-a"]);
    expect(toggleModelGroupSelection(all, knmi, ["knmi-a", "dwd-a"])).toEqual([
      "knmi-a",
      "knmi-b",
      "dwd-a",
    ]);
    expect(toggleModelGroupSelection(all, knmi, ["ecmwf-a", "dwd-a"])).toEqual(all);
    expect(DEFAULT_FORECAST_MODEL_IDS).toHaveLength(5);
  });

  it("uses meteorological from-direction and a clamped hourly cursor", () => {
    expect(windTravelDeg(350)).toBe(170);
    expect(compassFrom(359)).toBe("N");
    expect(compassFrom(90)).toBe("E");
    expect(hourIndexAtX(-100, 1000, 72)).toBe(0);
    expect(hourIndexAtX(5000, 1000, 72)).toBe(71);
    expect(forecastModelColor("ecmwf_ifs")).toBe(forecastModelColor("ecmwf_ifs"));
    expect(forecastModelColor("ecmwf_ifs")).not.toBe(forecastModelColor("icon_eu"));
  });

  it("keeps direction consensus continuous across north and measures model spread", () => {
    expect(unwrapDirections([350, 355, 2, 8, null, 12])).toEqual([
      350,
      355,
      362,
      368,
      null,
      372,
    ]);
    const consensus = directionConsensus([
      [350, 355, 2],
      [10, 5, 358],
    ]);
    expect(consensus.mean[0]).toBeCloseTo(0);
    expect(consensus.mean[1]).toBeCloseTo(0);
    expect(consensus.mean[2]).toBeCloseTo(0);
    expect(consensus.low[0]).toBeCloseTo(-10);
    expect(consensus.high[0]).toBeCloseTo(10);
    expect(consensus.rows[0][0]).toBeCloseTo(-10);
    expect(consensus.rows[1][0]).toBeCloseTo(10);
  });

  it("keeps long ranges bounded but hourly-addressable", () => {
    expect(chartWidthForHours(72, 900)).toBe(900);
    expect(chartWidthForHours(360, 900)).toBe(1864);
  });

  it("keeps hour labels clear of higher-priority day labels", () => {
    const beforeDay = { text: "19", start: 350, end: 362 };
    const afterMidnight = { text: "01", start: 404, end: 416 };
    expect(
      nonOverlappingAxisLabels(
        [{ text: "Mon 21", start: 400, end: 438 }],
        [beforeDay, afterMidnight],
      ),
    ).toEqual([beforeDay]);
  });

  it("converts wind units and collapses the chart to selected lanes", () => {
    expect(convertWindSpeed(36, "ms")).toBeCloseTo(10);
    expect(convertWindSpeed(18.52, "kn")).toBeCloseTo(10);
    expect(convertWindSpeed(36, "kmh")).toBe(36);
    expect(forecastChartHeight(new Set(["precipitation"]))).toBeLessThan(
      forecastChartHeight(new Set(["windSpeed", "precipitation", "temperature"])),
    );
  });

  it("gives the combined comparison chart a substantial responsive height", () => {
    expect(forecastComparisonHeight(600)).toBe(420);
    expect(forecastComparisonHeight(900)).toBe(576);
    expect(forecastComparisonHeight(1400)).toBe(680);
    expect(forecastLaneAtY(200, new Set(["windSpeed"]), 500)).toBe("wind");
    expect(forecastLaneAtY(495, new Set(["windSpeed"]), 500)).toBeNull();
  });

  it("identifies the hovered metric lane and ignores labels and gaps", () => {
    const metrics = new Set(DEFAULT_FORECAST_METRICS);
    expect(forecastLaneAtY(10, metrics)).toBeNull();
    expect(forecastLaneAtY(30, metrics)).toBe("wind");
    expect(forecastLaneAtY(98, metrics)).toBeNull();
    expect(forecastLaneAtY(115, metrics)).toBe("direction");
    expect(forecastLaneAtY(190, metrics)).toBe("rain");
    expect(forecastLaneAtY(240, metrics)).toBe("temp");
    expect(forecastLaneAtY(295, metrics)).toBe("pressure");
    expect(forecastLaneAtY(30, new Set(["windDirection"]))).toBe("direction");
    expect(forecastLaneAtY(30, new Set(["temperature"]))).toBe("temp");
  });

  it("formats hovered values beside their chart lanes", () => {
    const row: HourlyForecast = {
      modelId: "knmi_harmonie_arome_netherlands",
      point: { lat: 52, lon: 5, label: "Point" },
      gridLat: 52,
      gridLon: 5,
      times: [1_700_000_000_000],
      windSpeedKmh: [36],
      windGustKmh: [54],
      windDirectionDeg: [288],
      precipitationMm: [0.2],
      temperatureC: [8.4],
      pressureHpa: [1012.4],
      cloudCoverPct: [76],
      fetchedAt: 0,
      freshUntil: 1,
      requestedHours: 1,
    };

    expect(
      forecastLaneReadouts(row, 0, {
        metrics: new Set(DEFAULT_FORECAST_METRICS),
        speedUnit: "ms",
      }),
    ).toEqual({
      wind: "Wind 10.0 m/s · Gust 15.0 m/s · From WNW (288°)",
      rain: "Precip 0.2 mm",
      temperature: "Temperature 8.4 °C",
      pressure: "Pressure 1012 hPa · Cloud 76%",
    });
    expect(hasForecastValueAt(row, 0, new Set(["windSpeed"]))).toBe(true);
    expect(
      sharedForecastScales([row], {
        metrics: new Set(DEFAULT_FORECAST_METRICS),
        speedUnit: "kmh",
      }),
    ).toMatchObject({ windMax: 60, rainMax: 1.2 });
    expect(
      hasForecastValueAt(
        { ...row, windSpeedKmh: [null], windGustKmh: [null], windDirectionDeg: [null] },
        0,
        new Set(["windSpeed", "windGust", "windDirection"]),
      ),
    ).toBe(false);
  });

  it("formats comparison summaries and keeps missing models in source order", () => {
    const time = 1_700_000_000_000;
    const row = (
      modelId: string,
      windSpeedKmh: number | null,
      windDirectionDeg: number | null,
    ): HourlyForecast => ({
      modelId,
      point: { lat: 52, lon: 5, label: "Point" },
      gridLat: 52,
      gridLon: 5,
      times: [time],
      windSpeedKmh: [windSpeedKmh],
      windGustKmh: [windSpeedKmh == null ? null : windSpeedKmh + 18],
      windDirectionDeg: [windDirectionDeg],
      precipitationMm: [null],
      temperatureC: [null],
      pressureHpa: [null],
      cloudCoverPct: [null],
      fetchedAt: 0,
      freshUntil: 1,
      requestedHours: 1,
    });
    const details = forecastComparisonDetails(
      [row("a", 36, 350), row("b", 18, 10), row("c", null, null)],
      time,
      "wind",
      {
        metrics: new Set(["windSpeed", "windGust", "windDirection"]),
        speedUnit: "ms",
        modelLabels: new Map([
          ["a", "KNMI · A"],
          ["b", "ECMWF · B"],
          ["c", "DWD · C"],
        ]),
      },
    );

    expect(details.summary).toBe(
      "Wind 5.0–10.0 m/s · median 7.5 · Gust 10.0–15.0 m/s · median 12.5 · From N · ±10°",
    );
    expect(details.models.map(({ label, value }) => ({ label, value }))).toEqual([
      {
        label: "KNMI · A",
        value: "Wind 10.0 m/s · Gust 15.0 m/s · From N (350°)",
      },
      {
        label: "ECMWF · B",
        value: "Wind 5.0 m/s · Gust 10.0 m/s · From N (10°)",
      },
      { label: "DWD · C", value: "No data" },
    ]);
    expect(details.columns).toEqual([
      { label: "Wind m/s", summary: "5.0–10.0 (7.5)" },
      { label: "Gust m/s", summary: "10.0–15.0 (12.5)" },
      { label: "From", summary: "N ±10°" },
    ]);
    expect(details.models.map(({ cells }) => cells)).toEqual([
      ["10.0", "15.0", "N 350°"],
      ["5.0", "10.0", "N 10°"],
      ["—", "—", "—"],
    ]);
    expect(
      forecastComparisonDetails([row("a", 36, 350), row("b", 18, 10)], time, "direction", {
        metrics: new Set(["windSpeed", "windGust", "windDirection"]),
        speedUnit: "ms",
      }).title,
    ).toBe("Wind");

    const temperatures = [19.6, 18.2, 19.7].map((value, index) => ({
      ...row(String(index), null, null),
      temperatureC: [value],
    }));
    const temp = forecastComparisonDetails(temperatures, time, "temp", {
      metrics: new Set(["temperature"]),
      speedUnit: "kmh",
    });
    expect(temp.title).toBe("Temperature");
    expect(temp.columns).toEqual([{ label: "°C", summary: "18.2–19.7 (19.6)" }]);
    expect(temp.models.map(({ cells }) => cells)).toEqual([["19.6"], ["18.2"], ["19.7"]]);
  });

  it("aligns short regional rows to the shared global time axis", () => {
    const start = 1_700_000_000_000;
    const regional = parseOpenMeteoForecast(
      {
        hourly: {
          time: [start / 1000, start / 1000 + 3600],
          wind_speed_10m: [10, 11],
          wind_direction_10m: [90, 90],
        },
      },
      { lat: 52, lon: 5, label: "Point" },
      [models[0]],
      48,
      0,
    ).forecasts[0];
    const global = {
      ...regional,
      modelId: "ecmwf_ifs",
      times: [start, start + 24 * 3_600_000],
    };
    const timeline = sharedForecastTimeline([regional, global]);

    expect(timeline).toEqual({
      startMs: start,
      endMs: start + 24 * 3_600_000,
      hours: 25,
    });
    expect(hourTimeAtX(58, 1058, timeline)).toBe(start);
    expect(hourTimeAtX(1046, 1058, timeline)).toBe(start + 24 * 3_600_000);
  });
});
