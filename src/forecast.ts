/** Provider-neutral live forecast domain plus the first Open-Meteo adapter. */

export interface ForecastPoint {
  lat: number;
  lon: number;
  label: string;
  /** Stable geocoder id when the point came from search. */
  placeId?: string;
}

export type ForecastSpeedUnit = "ms" | "kmh" | "kn";
export type ForecastPresentation = "graph" | "compare" | "textual";
export type ForecastCompareStyle = "consensus" | "models";

/** Rolling history shown before the current hour when a provider or cache can supply it. */
export const FORECAST_HISTORY_HOURS = 24;
export const FORECAST_REFRESH_INTERVAL_MS = 3_600_000;

export type ForecastMetric =
  | "windSpeed"
  | "windGust"
  | "windDirection"
  | "precipitation"
  | "temperature"
  | "pressure"
  | "cloudCover";

export const DEFAULT_FORECAST_METRICS: readonly ForecastMetric[] = [
  "windSpeed",
  "windGust",
  "windDirection",
  "precipitation",
  "temperature",
  "pressure",
  "cloudCover",
];

export interface ForecastModel {
  id: string;
  provider: string;
  label: string;
  resolution: string;
  nativeHours: number;
  updateHours: number;
  horizonDays: number;
}

export interface HourlyForecast {
  modelId: string;
  point: ForecastPoint;
  gridLat: number;
  gridLon: number;
  times: number[];
  windSpeedKmh: Array<number | null>;
  windDirectionDeg: Array<number | null>;
  windGustKmh: Array<number | null>;
  precipitationMm: Array<number | null>;
  temperatureC: Array<number | null>;
  pressureHpa: Array<number | null>;
  cloudCoverPct: Array<number | null>;
  fetchedAt: number;
  freshUntil: number;
  requestedHours: number;
  noData?: boolean;
}

export interface ForecastBatch {
  point: ForecastPoint;
  forecasts: HourlyForecast[];
}

export interface LocationResult extends ForecastPoint {
  country?: string;
  admin1?: string;
  timezone?: string;
}

export interface ForecastProviderAdapter {
  readonly id: string;
  readonly models: readonly ForecastModel[];
  searchLocations(query: string, signal?: AbortSignal): Promise<LocationResult[]>;
  fetchForecast(
    point: ForecastPoint,
    modelIds: string[],
    hours: number,
    signal?: AbortSignal,
  ): Promise<ForecastBatch>;
}

/** Diverse, high-value defaults for Europe/NL, with one global model for wider coverage. */
export const DEFAULT_FORECAST_MODEL_IDS: readonly string[] = [
  "knmi_harmonie_arome_netherlands",
  "dmi_harmonie_arome_europe",
  "ecmwf_ifs",
  "icon_eu",
  "ncep_gfs_global",
];

/** Toggle a provider/model group while retaining catalog order. */
export function toggleModelGroupSelection(
  allModelIds: readonly string[],
  groupModelIds: readonly string[],
  selectedModelIds: readonly string[],
): string[] {
  const selected = new Set(selectedModelIds);
  const clearGroup = groupModelIds.every((id) => selected.has(id));
  for (const id of groupModelIds) {
    if (clearGroup) selected.delete(id);
    else selected.add(id);
  }
  return allModelIds.filter((id) => selected.has(id));
}

const FORECAST_SERIES_KEYS = [
  "windSpeedKmh",
  "windDirectionDeg",
  "windGustKmh",
  "precipitationMm",
  "temperatureC",
  "pressureHpa",
  "cloudCoverPct",
] as const;

/**
 * Prefer the latest provider response, filling only absent/null historical values from the
 * previous cached run. Cached data never extends the future side of a regional model.
 */
export function mergeForecastHistory(
  latest: HourlyForecast,
  cached: HourlyForecast | null | undefined,
  now: number,
  historyHours = FORECAST_HISTORY_HOURS,
): HourlyForecast {
  if (!cached || cached.modelId !== latest.modelId || historyHours <= 0) return latest;
  const cutoff = now - historyHours * 3_600_000;
  const latestIndexes = new Map(latest.times.map((time, index) => [time, index]));
  const cachedIndexes = new Map(cached.times.map((time, index) => [time, index]));
  const times = [
    ...new Set([
      ...latest.times,
      ...cached.times.filter((time) => time >= cutoff && time < now),
    ]),
  ].sort((a, b) => a - b);
  const merged = { ...latest, times } as HourlyForecast;
  for (const key of FORECAST_SERIES_KEYS) {
    merged[key] = times.map((time) => {
      const latestIndex = latestIndexes.get(time);
      const latestValue = latestIndex == null ? null : latest[key][latestIndex];
      if (latestValue != null || time >= now) return latestValue ?? null;
      const cachedIndex = cachedIndexes.get(time);
      return cachedIndex == null ? null : (cached[key][cachedIndex] ?? null);
    });
  }
  const hasWind = merged.windSpeedKmh.some((value) => value != null);
  const hasDirection = merged.windDirectionDeg.some((value) => value != null);
  if (hasWind && hasDirection) delete merged.noData;
  else merged.noData = true;
  return merged;
}

/** Return a display-only interval while leaving the longer cached forecast untouched. */
export function sliceForecastWindow(
  forecast: HourlyForecast,
  startInclusive: number,
  endExclusive: number,
): HourlyForecast {
  const from = forecast.times.findIndex((time) => time >= startInclusive);
  if (from < 0) {
    const empty = { ...forecast, times: [] } as HourlyForecast;
    for (const key of FORECAST_SERIES_KEYS) empty[key] = [];
    return empty;
  }
  let to = from;
  while (to < forecast.times.length && forecast.times[to] < endExclusive) to++;
  const sliced = { ...forecast, times: forecast.times.slice(from, to) } as HourlyForecast;
  for (const key of FORECAST_SERIES_KEYS) sliced[key] = forecast[key].slice(from, to);
  return sliced;
}

const m = (
  id: string,
  provider: string,
  label: string,
  resolution: string,
  nativeHours: number,
  updateHours: number,
  horizonDays: number,
): ForecastModel => ({
  id,
  provider,
  label,
  resolution,
  nativeHours,
  updateHours,
  horizonDays,
});

/** Native deterministic Forecast API products. Seamless and ensemble products are excluded. */
export const OPEN_METEO_MODELS: readonly ForecastModel[] = [
  m(
    "knmi_harmonie_arome_netherlands",
    "KNMI",
    "HARMONIE AROME Netherlands",
    "2 km",
    1,
    1,
    2.5,
  ),
  m("knmi_harmonie_arome_europe", "KNMI", "HARMONIE AROME Europe", "5.5 km", 1, 1, 3),
  m("dmi_harmonie_arome_europe", "DMI", "HARMONIE AROME Europe", "2 km", 1, 3, 2.5),
  m("ecmwf_ifs", "ECMWF", "IFS HRES", "9 km", 1, 6, 15),
  m("ecmwf_ifs025", "ECMWF", "IFS Open Data", "25 km", 3, 6, 15),
  m("ecmwf_aifs025_single", "ECMWF", "AIFS Single", "28 km", 6, 6, 15),
  m("icon_eu", "DWD", "ICON EU", "7 km", 1, 3, 7.5),
  m("icon_global", "DWD", "ICON Global", "11 km", 1, 3, 7.5),
  m("icon_d2", "DWD", "ICON D2", "2 km", 1, 3, 2),
  m("ncep_gfs_global", "NOAA", "GFS Global", "11–25 km", 1, 6, 16),
  m("ncep_gfs_graphcast025", "NOAA", "GraphCast GFS", "25 km", 6, 6, 10),
  m("ncep_aigfs025", "NOAA", "AIGFS", "25 km", 6, 6, 15),
  m("ncep_hrrr_conus", "NOAA", "HRRR CONUS", "3 km", 1, 1, 2),
  m("ncep_nbm_conus", "NOAA", "NBM CONUS", "3 km", 1, 1, 11),
  m("ncep_nam_conus", "NOAA", "NAM CONUS", "5 km", 1, 6, 3.5),
  m("meteofrance_arpege_europe", "Météo-France", "ARPEGE Europe", "10 km", 1, 1, 4),
  m("meteofrance_arpege_world", "Météo-France", "ARPEGE World", "25 km", 1, 1, 4),
  m("meteofrance_arome_france", "Météo-France", "AROME France", "2.5 km", 1, 1, 2),
  m("meteofrance_arome_france_hd", "Météo-France", "AROME France HD", "1.3 km", 1, 1, 2),
  m(
    "ukmo_global_deterministic_10km",
    "UK Met Office",
    "Global Deterministic",
    "10 km",
    1,
    6,
    7,
  ),
  m("ukmo_uk_deterministic_2km", "UK Met Office", "UK Deterministic", "2 km", 1, 1, 2),
  m("cmc_gem_gdps", "Environment Canada", "GEM Global", "15 km", 3, 12, 10),
  m("cmc_gem_rdps", "Environment Canada", "GEM Regional", "10 km", 1, 6, 3.5),
  m("cmc_gem_hrdps", "Environment Canada", "HRDPS", "2.5 km", 1, 6, 2),
  m("cmc_gem_hrdps_west", "Environment Canada", "HRDPS West", "2.5 km", 1, 6, 2),
  m("jma_gsm", "JMA", "GSM", "55 km", 6, 6, 11),
  m("jma_msm", "JMA", "MSM", "5 km", 1, 3, 3.5),
  m("kma_gdps", "KMA", "GDPS", "13 km", 3, 6, 12),
  m("kma_ldps", "KMA", "LDPS", "1.5 km", 1, 6, 2),
  m("bom_access_global", "BOM", "ACCESS Global", "15 km", 3, 6, 10),
  m("cma_grapes_global", "CMA", "GRAPES Global", "15 km", 3, 6, 10),
  m("metno_nordic", "MET Norway", "Nordic", "1 km", 1, 1, 2.5),
  m("meteoswiss_icon_ch1", "MeteoSwiss", "ICON CH1", "1 km", 1, 3, 1.5),
  m("meteoswiss_icon_ch2", "MeteoSwiss", "ICON CH2", "2 km", 1, 6, 5),
  m("geosphere_arome_austria", "GeoSphere Austria", "AROME Austria", "2.5 km", 1, 3, 2.5),
  m("italia_meteo_arpae_icon_2i", "ItaliaMeteo", "ICON 2I", "2 km", 1, 12, 5),
  m("chmi_aladin_central_europe_2km", "CHMI", "ALADIN Central Europe", "2 km", 1, 6, 3),
  m("chmi_aladin_cz_1km", "CHMI", "ALADIN Czechia", "1 km", 1, 6, 2),
];

const VARS = [
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "precipitation",
  "temperature_2m",
  "pressure_msl",
  "cloud_cover",
] as const;

type OpenMeteoJson = {
  error?: boolean;
  reason?: string;
  latitude?: number;
  longitude?: number;
  hourly?: Record<string, unknown>;
};

export interface ForecastFetchDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

class ForecastHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ForecastHttpError";
  }
}

const defaultDeps = (): ForecastFetchDeps => ({
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

function numericArray(value: unknown, n: number): Array<number | null> {
  const src = Array.isArray(value) ? value : [];
  return Array.from({ length: n }, (_, i) => {
    const v = src[i];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
}

function modelValues(hourly: Record<string, unknown>, base: string, modelId: string): unknown {
  return hourly[`${base}_${modelId}`] ?? hourly[base];
}

/** Parse one Open-Meteo multi-model response into one normalized entry per requested model. */
export function parseOpenMeteoForecast(
  json: unknown,
  point: ForecastPoint,
  models: ForecastModel[],
  hours: number,
  now: number,
): ForecastBatch {
  if (!json || typeof json !== "object")
    throw new Error("Forecast API returned invalid JSON.");
  const raw = json as OpenMeteoJson;
  if (raw.error) throw new Error(raw.reason || "Forecast API error.");
  const hourly = raw.hourly && typeof raw.hourly === "object" ? raw.hourly : {};
  const rawTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const times = rawTimes
    .map((value) =>
      typeof value === "number"
        ? value * 1000
        : typeof value === "string"
          ? Date.parse(value.endsWith("Z") ? value : `${value}Z`)
          : Number.NaN,
    )
    .filter(Number.isFinite);
  const n = times.length;
  const forecasts = models.map((model) => {
    const speed = numericArray(modelValues(hourly, VARS[0], model.id), n);
    const direction = numericArray(modelValues(hourly, VARS[1], model.id), n);
    const noData = !speed.some((v) => v != null) || !direction.some((v) => v != null);
    return {
      modelId: model.id,
      point,
      gridLat: typeof raw.latitude === "number" ? raw.latitude : point.lat,
      gridLon: typeof raw.longitude === "number" ? raw.longitude : point.lon,
      times,
      windSpeedKmh: speed,
      windDirectionDeg: direction,
      windGustKmh: numericArray(modelValues(hourly, VARS[2], model.id), n),
      precipitationMm: numericArray(modelValues(hourly, VARS[3], model.id), n),
      temperatureC: numericArray(modelValues(hourly, VARS[4], model.id), n),
      pressureHpa: numericArray(modelValues(hourly, VARS[5], model.id), n),
      cloudCoverPct: numericArray(modelValues(hourly, VARS[6], model.id), n),
      fetchedAt: now,
      freshUntil: now + FORECAST_REFRESH_INTERVAL_MS,
      requestedHours: hours,
      ...(noData ? { noData: true } : {}),
    } satisfies HourlyForecast;
  });
  return { point, forecasts };
}

export class OpenMeteoForecastAdapter implements ForecastProviderAdapter {
  readonly id = "open-meteo";
  readonly models = OPEN_METEO_MODELS;
  private inFlight = new Map<string, Promise<ForecastBatch>>();

  constructor(private readonly deps: ForecastFetchDeps = defaultDeps()) {}

  async searchLocations(query: string, signal?: AbortSignal): Promise<LocationResult[]> {
    const p = new URLSearchParams({ name: query.trim(), count: "8", language: "en" });
    const response = await this.request(
      `https://geocoding-api.open-meteo.com/v1/search?${p}`,
      signal,
    );
    if (!response.ok) throw new Error(`Location search responded ${response.status}.`);
    const json = (await response.json()) as { results?: Array<Record<string, unknown>> };
    return (json.results ?? []).flatMap((r) => {
      if (typeof r.latitude !== "number" || typeof r.longitude !== "number") return [];
      const name = String(r.name ?? "Location");
      const admin1 = typeof r.admin1 === "string" && r.admin1 !== name ? r.admin1 : undefined;
      const country = typeof r.country === "string" ? r.country : undefined;
      return [
        {
          lat: r.latitude,
          lon: r.longitude,
          label: [name, admin1, country].filter(Boolean).join(", "),
          placeId: r.id == null ? undefined : String(r.id),
          admin1,
          country,
          timezone: typeof r.timezone === "string" ? r.timezone : undefined,
        },
      ];
    });
  }

  fetchForecast(
    point: ForecastPoint,
    modelIds: string[],
    hours: number,
    signal?: AbortSignal,
  ): Promise<ForecastBatch> {
    const ids = [...new Set(modelIds)].filter((id) => this.models.some((m) => m.id === id));
    if (ids.length === 0) return Promise.resolve({ point, forecasts: [] });
    const key = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}:${hours}:${ids.sort().join(",")}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.fetchWithFallback(point, ids, hours, signal).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async fetchWithFallback(
    point: ForecastPoint,
    ids: string[],
    hours: number,
    signal?: AbortSignal,
  ): Promise<ForecastBatch> {
    try {
      return await this.fetchBatch(point, ids, hours, signal);
    } catch (error) {
      if (signal?.aborted || !(error instanceof ForecastHttpError) || error.status !== 400) {
        throw error;
      }
      if (ids.length === 1) {
        const model = this.models.find((candidate) => candidate.id === ids[0])!;
        return parseOpenMeteoForecast(
          { latitude: point.lat, longitude: point.lon, hourly: { time: [] } },
          point,
          [model],
          hours,
          this.deps.now(),
        );
      }
      const mid = Math.ceil(ids.length / 2);
      const [a, b] = await Promise.all([
        this.fetchWithFallback(point, ids.slice(0, mid), hours, signal),
        this.fetchWithFallback(point, ids.slice(mid), hours, signal),
      ]);
      return { point, forecasts: [...a.forecasts, ...b.forecasts] };
    }
  }

  private async fetchBatch(
    point: ForecastPoint,
    ids: string[],
    hours: number,
    signal?: AbortSignal,
  ): Promise<ForecastBatch> {
    const p = new URLSearchParams({
      latitude: point.lat.toFixed(5),
      longitude: point.lon.toFixed(5),
      hourly: VARS.join(","),
      models: ids.join(","),
      forecast_hours: String(hours),
      past_hours: String(FORECAST_HISTORY_HOURS),
      timezone: "GMT",
      timeformat: "unixtime",
      wind_speed_unit: "kmh",
    });
    const response = await this.request(`https://api.open-meteo.com/v1/forecast?${p}`, signal);
    if (!response.ok) {
      throw new ForecastHttpError(
        `Forecast API responded ${response.status}.`,
        response.status,
      );
    }
    const models = ids.map((id) => this.models.find((model) => model.id === id)!);
    return parseOpenMeteoForecast(
      await response.json(),
      point,
      models,
      hours,
      this.deps.now(),
    );
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const response = await this.deps.fetch(url, { signal });
      if (response.status !== 429 && response.status < 500) return response;
      if (++attempt > 4) return response;
      const retry = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retry)
        ? retry * 1000
        : Math.min(1000 * 2 ** (attempt - 1), 30_000);
      await this.deps.sleep(wait);
    }
  }
}
