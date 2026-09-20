/** Pure forecast-chart geometry plus DPR-aware small-multiple canvas rendering. */

import {
  DEFAULT_FORECAST_METRICS,
  type ForecastMetric,
  type ForecastSpeedUnit,
  type HourlyForecast,
} from "./forecast";

export interface ForecastScales {
  windMax: number;
  rainMax: number;
  tempMin: number;
  tempMax: number;
  pressureMin: number;
  pressureMax: number;
}

export interface ForecastTimeline {
  startMs: number;
  endMs: number;
  hours: number;
}

export interface ForecastChartOptions {
  metrics: ReadonlySet<ForecastMetric>;
  speedUnit: ForecastSpeedUnit;
  focusedLane?: ForecastChartLane | null;
  focusedModelId?: string | null;
  modelLabels?: ReadonlyMap<string, string>;
  showModelTracks?: boolean;
  cursorDetails?: "inline" | "external";
}

export type ForecastChartLane = "wind" | "direction" | "rain" | "temp" | "pressure";

interface ForecastChartLayout {
  height: number;
  top: number;
  bottom: number;
  wind?: readonly [number, number];
  direction?: readonly [number, number];
  rain?: readonly [number, number];
  temp?: readonly [number, number];
  pressure?: readonly [number, number];
}

const HOUR_MS = 3_600_000;
const PLOT_LEFT = 58;
const PLOT_RIGHT = 12;

export function speedUnitLabel(unit: ForecastSpeedUnit): string {
  if (unit === "ms") return "m/s";
  if (unit === "kn") return "kn";
  return "km/h";
}

export function convertWindSpeed(kmh: number, unit: ForecastSpeedUnit): number {
  if (unit === "ms") return kmh / 3.6;
  if (unit === "kn") return kmh / 1.852;
  return kmh;
}

function chartLayout(
  metrics: ReadonlySet<ForecastMetric>,
  targetHeight?: number,
): ForecastChartLayout {
  const layout: ForecastChartLayout = { height: 38, top: 24, bottom: 24 };
  let y = 24;
  const add = (key: ForecastChartLane, enabled: boolean, height: number): void => {
    if (!enabled) return;
    layout[key] = [y, y + height];
    y += height + 16;
  };
  add("wind", metrics.has("windSpeed") || metrics.has("windGust"), 70);
  add("direction", metrics.has("windDirection"), 52);
  add("rain", metrics.has("precipitation"), 30);
  add("temp", metrics.has("temperature"), 38);
  add("pressure", metrics.has("pressure") || metrics.has("cloudCover"), 38);
  const lanes = [
    layout.wind,
    layout.direction,
    layout.rain,
    layout.temp,
    layout.pressure,
  ].filter((lane): lane is readonly [number, number] => !!lane);
  if (lanes.length) {
    layout.top = lanes[0][0];
    layout.bottom = lanes.at(-1)![1];
    layout.height = layout.bottom + 10;
  }
  if (targetHeight && targetHeight > layout.height && lanes.length) {
    const baseTop = layout.top;
    const baseSpan = Math.max(1, layout.bottom - baseTop);
    const targetBottom = targetHeight - 14;
    const scale = (targetBottom - baseTop) / baseSpan;
    for (const lane of ["wind", "direction", "rain", "temp", "pressure"] as const) {
      const bounds = layout[lane];
      if (!bounds) continue;
      layout[lane] = [
        baseTop + (bounds[0] - baseTop) * scale,
        baseTop + (bounds[1] - baseTop) * scale,
      ];
    }
    layout.bottom = targetBottom;
    layout.height = targetHeight;
  }
  return layout;
}

export function forecastChartHeight(metrics: ReadonlySet<ForecastMetric>): number {
  return chartLayout(metrics).height;
}

/** A comparison is the primary analytical canvas, not another compact model row. */
export function forecastComparisonHeight(viewportHeight: number): number {
  return Math.max(420, Math.min(680, Math.round(viewportHeight * 0.64)));
}

/** Return the metric lane under a canvas-local y coordinate. */
export function forecastLaneAtY(
  y: number,
  metrics: ReadonlySet<ForecastMetric>,
  chartHeight?: number,
): ForecastChartLane | null {
  const layout = chartLayout(metrics, chartHeight);
  for (const lane of ["wind", "direction", "rain", "temp", "pressure"] as const) {
    const bounds = layout[lane];
    if (bounds && y >= bounds[0] && y <= bounds[1]) return lane;
  }
  return null;
}

export function windTravelDeg(fromDeg: number): number {
  return (fromDeg + 180) % 360;
}

function shortestDirectionDelta(value: number, reference: number): number {
  return ((value - reference + 540) % 360) - 180;
}

/** Keep north crossings continuous while retaining the same meteorological angle. */
export function unwrapDirections(values: Array<number | null>): Array<number | null> {
  let previous: number | null = null;
  return values.map((value) => {
    if (value == null) return null;
    const next = previous == null ? value : previous + shortestDirectionDelta(value, previous);
    previous = next;
    return next;
  });
}

function directionDomain(values: Array<number | null>): [number, number] {
  const present = values.filter((value): value is number => value != null);
  if (!present.length) return [0, 360];
  const low = Math.min(...present);
  const high = Math.max(...present);
  const padding = Math.max(12, (high - low) * 0.18);
  return [low - padding, high + padding];
}

function directionTick(value: number): string {
  return `${((Math.round(value) % 360) + 360) % 360}°`;
}

function drawDirectionArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  fromDeg: number,
  color: string,
): void {
  const rad = (windTravelDeg(fromDeg) * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const px = -uy;
  const py = ux;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - ux * 6, y - uy * 6);
  ctx.lineTo(x + ux * 3, y + uy * 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + ux * 8, y + uy * 8);
  ctx.lineTo(x + ux * 2 + px * 3.5, y + uy * 2 + py * 3.5);
  ctx.lineTo(x + ux * 2 - px * 3.5, y + uy * 2 - py * 3.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

interface DirectionConsensus {
  mean: Array<number | null>;
  low: Array<number | null>;
  high: Array<number | null>;
  rows: Array<Array<number | null>>;
}

/** Circular mean and angular spread, aligned to a continuous heading through time. */
export function directionConsensus(rows: Array<Array<number | null>>): DirectionConsensus {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const rawMean = Array.from({ length: count }, (_, index) => {
    const values = rows.flatMap((row) => (row[index] == null ? [] : [row[index]!]));
    if (!values.length) return null;
    const sin = values.reduce((sum, value) => sum + Math.sin((value * Math.PI) / 180), 0);
    const cos = values.reduce((sum, value) => sum + Math.cos((value * Math.PI) / 180), 0);
    return ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
  });
  const mean = unwrapDirections(rawMean);
  const spread = rawMean.map((center, index) =>
    center == null
      ? null
      : Math.max(
          0,
          ...rows.flatMap((row) =>
            row[index] == null ? [] : [Math.abs(shortestDirectionDelta(row[index]!, center))],
          ),
        ),
  );
  return {
    mean,
    low: mean.map((value, index) => (value == null ? null : value - spread[index]!)),
    high: mean.map((value, index) => (value == null ? null : value + spread[index]!)),
    rows: rows.map((row) =>
      row.map((value, index) =>
        value == null || mean[index] == null
          ? null
          : mean[index]! + shortestDirectionDelta(value, rawMean[index]!),
      ),
    ),
  };
}

export function compassFrom(deg: number): string {
  const labels = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  return labels[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export interface ForecastLaneReadouts {
  wind?: string;
  rain?: string;
  temperature?: string;
  pressure?: string;
}

export function hasForecastValueAt(
  forecast: HourlyForecast,
  index: number,
  metrics: ReadonlySet<ForecastMetric>,
): boolean {
  const values: Record<ForecastMetric, Array<number | null>> = {
    windSpeed: forecast.windSpeedKmh,
    windGust: forecast.windGustKmh,
    windDirection: forecast.windDirectionDeg,
    precipitation: forecast.precipitationMm,
    temperature: forecast.temperatureC,
    pressure: forecast.pressureHpa,
    cloudCover: forecast.cloudCoverPct,
  };
  return [...metrics].some((metric) => values[metric][index] != null);
}

/** Compact, lane-local values used by the chart cursor and its accessible readout. */
export function forecastLaneReadouts(
  forecast: HourlyForecast,
  index: number,
  options: ForecastChartOptions,
): ForecastLaneReadouts {
  const at = (values: Array<number | null>): number | null => values[index] ?? null;
  const speed = (value: number | null): string =>
    value == null
      ? "—"
      : `${convertWindSpeed(value, options.speedUnit).toFixed(options.speedUnit === "kmh" ? 0 : 1)} ${speedUnitLabel(options.speedUnit)}`;
  const result: ForecastLaneReadouts = {};
  const wind: string[] = [];
  if (options.metrics.has("windSpeed")) wind.push(`Wind ${speed(at(forecast.windSpeedKmh))}`);
  if (options.metrics.has("windGust")) wind.push(`Gust ${speed(at(forecast.windGustKmh))}`);
  if (options.metrics.has("windDirection")) {
    const direction = at(forecast.windDirectionDeg);
    wind.push(
      direction == null
        ? "Direction —"
        : `From ${compassFrom(direction)} (${Math.round(direction)}°)`,
    );
  }
  if (wind.length) result.wind = wind.join(" · ");
  if (options.metrics.has("precipitation")) {
    const value = at(forecast.precipitationMm);
    result.rain = `Precip ${value == null ? "—" : `${value.toFixed(1)} mm`}`;
  }
  if (options.metrics.has("temperature")) {
    const value = at(forecast.temperatureC);
    result.temperature = `Temperature ${value == null ? "—" : `${value.toFixed(1)} °C`}`;
  }
  const pressure: string[] = [];
  if (options.metrics.has("pressure")) {
    const value = at(forecast.pressureHpa);
    pressure.push(`Pressure ${value == null ? "—" : `${value.toFixed(0)} hPa`}`);
  }
  if (options.metrics.has("cloudCover")) {
    const value = at(forecast.cloudCoverPct);
    pressure.push(`Cloud ${value == null ? "—" : `${value.toFixed(0)}%`}`);
  }
  if (pressure.length) result.pressure = pressure.join(" · ");
  return result;
}

export function chartWidthForHours(hours: number, viewport: number): number {
  const pxPerHour = hours <= 72 ? 10 : hours <= 168 ? 7 : 5;
  return Math.max(viewport, hours * pxPerHour + 64);
}

export function nonOverlappingAxisLabels<T extends { start: number; end: number }>(
  reserved: readonly T[],
  candidates: readonly T[],
  gap = 6,
): T[] {
  const occupied = [...reserved];
  const visible: T[] = [];
  for (const label of candidates) {
    const overlaps = occupied.some(
      (other) => label.start < other.end + gap && label.end + gap > other.start,
    );
    if (overlaps) continue;
    occupied.push(label);
    visible.push(label);
  }
  return visible;
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  times: number[],
  x: (index: number) => number,
  width: number,
  layout: ForecastChartLayout,
  timeZone: string,
  text: string,
  muted: string,
  gridStrong: string,
): void {
  const weekdayFmt = new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short" });
  const dayFmt = new Intl.DateTimeFormat(undefined, { timeZone, day: "numeric" });
  const hourFmt = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "2-digit",
    hour12: false,
  });
  const dayFont = "600 10px Ubuntu, system-ui, sans-serif";
  const hourFont = "9px Ubuntu, system-ui, sans-serif";
  interface AxisLabel {
    text: string;
    x: number;
    start: number;
    end: number;
  }
  const axisLabel = (value: string, preferredX: number, font: string): AxisLabel => {
    ctx.font = font;
    const labelWidth = Math.ceil(ctx.measureText(value).width);
    const labelX = Math.max(PLOT_LEFT, Math.min(width - PLOT_RIGHT - labelWidth, preferredX));
    return { text: value, x: labelX, start: labelX, end: labelX + labelWidth };
  };
  let lastDay = "";
  const dayLabels: AxisLabel[] = [];
  const hourLabels: AxisLabel[] = [];
  const boundaries: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const day = `${weekdayFmt.format(times[i])} ${dayFmt.format(times[i])}`;
    if (day !== lastDay) {
      boundaries.push(x(i));
      dayLabels.push(axisLabel(day, x(i) + 5, dayFont));
      lastDay = day;
    } else if (i % 6 === 0) {
      hourLabels.push(axisLabel(hourFmt.format(times[i]), x(i) + 3, hourFont));
    }
  }

  ctx.save();
  for (let i = 0; i < boundaries.length; i++) {
    if (i % 2 === 0) continue;
    const end = boundaries[i + 1] ?? width - PLOT_RIGHT;
    ctx.fillStyle = "rgba(255,255,255,.025)";
    ctx.fillRect(boundaries[i], 0, Math.max(0, end - boundaries[i]), 19);
  }
  ctx.strokeStyle = gridStrong;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.58;
  for (const boundary of boundaries) {
    ctx.beginPath();
    ctx.moveTo(boundary + 0.5, 0);
    ctx.lineTo(boundary + 0.5, layout.bottom);
    ctx.stroke();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = dayFont;
  ctx.fillStyle = text;
  ctx.globalAlpha = 0.86;
  for (const label of dayLabels) ctx.fillText(label.text, label.x, 10);
  ctx.font = hourFont;
  ctx.fillStyle = muted;
  ctx.globalAlpha = 0.72;
  for (const label of nonOverlappingAxisLabels(dayLabels, hourLabels, 9)) {
    ctx.fillText(label.text, label.x, 10);
  }
  ctx.restore();
}

export function hourIndexAtX(x: number, width: number, count: number): number {
  if (count <= 1) return 0;
  const t = Math.max(
    0,
    Math.min(1, (x - PLOT_LEFT) / Math.max(1, width - PLOT_LEFT - PLOT_RIGHT)),
  );
  return Math.round(t * (count - 1));
}

export function sharedForecastTimeline(series: HourlyForecast[]): ForecastTimeline {
  const starts = series.flatMap((item) => (item.times.length ? [item.times[0]] : []));
  const ends = series.flatMap((item) => (item.times.length ? [item.times.at(-1)!] : []));
  const startMs = starts.length ? Math.min(...starts) : 0;
  const endMs = ends.length ? Math.max(...ends) : startMs;
  return {
    startMs,
    endMs,
    hours: Math.max(1, Math.round((endMs - startMs) / HOUR_MS) + 1),
  };
}

/** Convert a canvas x-coordinate to the nearest hour on the shared time axis. */
export function hourTimeAtX(x: number, width: number, timeline: ForecastTimeline): number {
  const index = hourIndexAtX(x, width, timeline.hours);
  return Math.min(timeline.endMs, timeline.startMs + index * HOUR_MS);
}

const finite = (values: Array<number | null>): number[] =>
  values.filter((v): v is number => v != null);

function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const stop = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(
    (candidate) => candidate >= normalized,
  );
  return (stop ?? 10) * magnitude;
}

export function sharedForecastScales(
  series: HourlyForecast[],
  options: ForecastChartOptions = {
    metrics: new Set(DEFAULT_FORECAST_METRICS),
    speedUnit: "kmh",
  },
): ForecastScales {
  const all = <K extends keyof HourlyForecast>(key: K): number[] =>
    series.flatMap((s) => finite(s[key] as Array<number | null>));
  const wind = [
    ...(options.metrics.has("windSpeed") ? all("windSpeedKmh") : []),
    ...(options.metrics.has("windGust") ? all("windGustKmh") : []),
  ].map((value) => convertWindSpeed(value, options.speedUnit));
  const rain = all("precipitationMm");
  const temp = all("temperatureC");
  const pressure = all("pressureHpa");
  const range = (values: number[], fallback: [number, number]): [number, number] => {
    if (!values.length) return fallback;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? [min - 1, max + 1] : [min, max];
  };
  const [tempMin, tempMax] = range(temp, [0, 1]);
  const [pressureMin, pressureMax] = range(pressure, [1000, 1010]);
  return {
    windMax: niceCeiling(Math.max(convertWindSpeed(10, options.speedUnit), ...wind) * 1.08),
    rainMax: niceCeiling(Math.max(1, ...rain) * 1.08),
    tempMin,
    tempMax,
    pressureMin,
    pressureMax,
  };
}

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function line(
  ctx: CanvasRenderingContext2D,
  values: Array<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
  color: string,
  dash: number[] = [],
  width = 1.7,
): void {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  let open = false;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value == null) {
      open = false;
      continue;
    }
    if (open) ctx.lineTo(x(i), y(value));
    else {
      ctx.moveTo(x(i), y(value));
      open = true;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawForecastRow(
  canvas: HTMLCanvasElement,
  forecast: HourlyForecast,
  scales: ForecastScales,
  timeline: ForecastTimeline,
  selectedTimeMs: number | null,
  timeZone: string,
  options: ForecastChartOptions,
): void {
  const w = canvas.clientWidth || 900;
  const layout = chartLayout(options.metrics);
  const h = canvas.clientHeight || layout.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const text = css("--text", "#e8edf2");
  const muted = css("--muted", "#8a97a6");
  const grid = css("--line", "#2a3340");
  const gridStrong = css("--line-strong", "#3a4655");
  const accent = css("--accent", "#fc5200");
  const left = PLOT_LEFT;
  const right = PLOT_RIGHT;
  const plotW = Math.max(1, w - left - right);
  const n = forecast.times.length;
  const xAtTime = (timeMs: number): number =>
    left +
    ((timeMs - timeline.startMs) / Math.max(1, timeline.endMs - timeline.startMs)) * plotW;
  const x = (i: number): number => xAtTime(forecast.times[i]);
  const sy = (
    value: number,
    min: number,
    max: number,
    lane: readonly [number, number],
  ): number => lane[1] - ((value - min) / Math.max(1e-6, max - min)) * (lane[1] - lane[0]);
  const directionLine = layout.direction ? unwrapDirections(forecast.windDirectionDeg) : null;
  const [directionMin, directionMax] = directionDomain(directionLine ?? []);

  const focusedBounds = options.focusedLane ? layout[options.focusedLane] : undefined;
  if (focusedBounds) {
    const laneTint: Record<ForecastChartLane, string> = {
      wind: "rgba(252, 82, 0, .045)",
      direction: "rgba(170, 190, 210, .055)",
      rain: "rgba(66, 165, 245, .045)",
      temp: "rgba(239, 108, 108, .045)",
      pressure: "rgba(114, 183, 210, .045)",
    };
    ctx.fillStyle = laneTint[options.focusedLane!];
    ctx.fillRect(left, focusedBounds[0] - 3, plotW, focusedBounds[1] - focusedBounds[0] + 6);
  }

  const ticks = (min: number, max: number): number[] => [min, (min + max) / 2, max];
  const decimals = (span: number, smallThreshold: number): number =>
    span < smallThreshold ? 1 : 0;
  const drawScale = (
    unit: string,
    lane: readonly [number, number],
    min: number,
    max: number,
    digits: number,
    format: (value: number) => string = (value) => value.toFixed(digits),
  ): void => {
    ctx.save();
    ctx.font = "10px Ubuntu, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const value of ticks(min, max)) {
      const y = sy(value, min, max, lane);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(w - right, y + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = text;
      ctx.globalAlpha = 0.72;
      ctx.textAlign = "right";
      ctx.fillText(format(value), left - 5, y);
      ctx.globalAlpha = 1;
    }
    ctx.font = "9px Ubuntu, system-ui, sans-serif";
    ctx.fillStyle = muted;
    ctx.textAlign = "left";
    ctx.fillText(unit, 3, (lane[0] + lane[1]) / 2);
    ctx.restore();
  };
  if (layout.wind) {
    drawScale(
      speedUnitLabel(options.speedUnit),
      layout.wind,
      0,
      scales.windMax,
      decimals(scales.windMax, 20),
    );
  }
  if (layout.direction)
    drawScale("from", layout.direction, directionMin, directionMax, 0, directionTick);
  if (layout.rain) {
    drawScale("mm", layout.rain, 0, scales.rainMax, decimals(scales.rainMax, 4));
  }
  if (layout.temp) {
    drawScale(
      "°C",
      layout.temp,
      scales.tempMin,
      scales.tempMax,
      decimals(scales.tempMax - scales.tempMin, 4),
    );
  }
  if (layout.pressure) {
    const hasPressure = options.metrics.has("pressure");
    const min = hasPressure ? scales.pressureMin : 0;
    const max = hasPressure ? scales.pressureMax : 100;
    drawScale(
      hasPressure ? "hPa" : "%",
      layout.pressure,
      min,
      max,
      hasPressure ? decimals(max - min, 2) : 0,
    );
  }
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (const lane of [
    layout.wind,
    layout.direction,
    layout.rain,
    layout.temp,
    layout.pressure,
  ]) {
    if (!lane) continue;
    ctx.beginPath();
    ctx.moveTo(left, lane[1] + 4.5);
    ctx.lineTo(w - right, lane[1] + 4.5);
    ctx.stroke();
  }

  // Day boundaries are deliberately stronger than the subordinate hourly labels.
  drawTimeAxis(ctx, forecast.times, x, w, layout, timeZone, text, muted, gridStrong);

  const hourWidth = plotW / Math.max(1, timeline.hours - 1);

  // Cloud cover is a background intensity in the pressure lane.
  if (layout.pressure && options.metrics.has("cloudCover")) {
    for (let i = 0; i < n; i++) {
      const cloud = forecast.cloudCoverPct[i];
      if (cloud == null) continue;
      const x0 = Math.max(left, x(i) - hourWidth / 2);
      const x1 = Math.min(w - right, x(i) + hourWidth / 2);
      ctx.fillStyle = `rgba(155, 176, 196, ${0.03 + (cloud / 100) * 0.24})`;
      ctx.fillRect(x0, layout.pressure[0], x1 - x0, layout.pressure[1] - layout.pressure[0]);
    }
  }

  // Rain bars.
  if (layout.rain && options.metrics.has("precipitation")) {
    ctx.fillStyle = "rgba(66, 165, 245, .65)";
    const barW = Math.max(1, hourWidth - 1);
    for (let i = 0; i < n; i++) {
      const value = forecast.precipitationMm[i];
      if (value == null) continue;
      const y = sy(value, 0, scales.rainMax, layout.rain);
      ctx.fillRect(x(i) - barW / 2, y, barW, layout.rain[1] - y);
    }
  }

  if (layout.wind && options.metrics.has("windGust")) {
    line(
      ctx,
      forecast.windGustKmh,
      x,
      (v) => sy(convertWindSpeed(v, options.speedUnit), 0, scales.windMax, layout.wind!),
      "#f5a45d",
      [4, 3],
    );
  }
  if (layout.wind && options.metrics.has("windSpeed")) {
    line(
      ctx,
      forecast.windSpeedKmh,
      x,
      (v) => sy(convertWindSpeed(v, options.speedUnit), 0, scales.windMax, layout.wind!),
      accent,
    );
  }
  if (layout.temp && options.metrics.has("temperature")) {
    line(
      ctx,
      forecast.temperatureC,
      x,
      (v) => sy(v, scales.tempMin, scales.tempMax, layout.temp!),
      "#ef6c6c",
    );
  }
  if (layout.pressure && options.metrics.has("pressure")) {
    line(
      ctx,
      forecast.pressureHpa,
      x,
      (v) => sy(v, scales.pressureMin, scales.pressureMax, layout.pressure!),
      "#72b7d2",
    );
  }

  // The direction lane follows the heading continuously across north crossings.
  if (layout.direction && directionLine) {
    line(
      ctx,
      directionLine,
      x,
      (value) => sy(value, directionMin, directionMax, layout.direction!),
      "#9bb0c4",
      [],
      1.5,
    );
    const arrowEvery = n <= 72 ? 3 : n <= 168 ? 6 : 12;
    for (let i = 0; i < n; i += arrowEvery) {
      const from = forecast.windDirectionDeg[i];
      const value = directionLine[i];
      if (from == null || value == null) continue;
      drawDirectionArrow(
        ctx,
        x(i),
        sy(value, directionMin, directionMax, layout.direction),
        from,
        text,
      );
    }
  }

  // Keep the same metric visually active down the entire model stack. This is
  // deliberately applied after the data so inactive lanes recede together,
  // while the cursor and focused values remain crisp on top.
  if (focusedBounds && options.focusedLane) {
    for (const laneName of ["wind", "direction", "rain", "temp", "pressure"] as const) {
      const bounds = layout[laneName];
      if (!bounds || laneName === options.focusedLane) continue;
      ctx.fillStyle = "rgba(6, 8, 12, .28)";
      ctx.fillRect(left, bounds[0] - 3, plotW, bounds[1] - bounds[0] + 6);
    }
    const laneBorder: Record<ForecastChartLane, string> = {
      wind: "rgba(252, 82, 0, .28)",
      direction: "rgba(155, 176, 196, .32)",
      rain: "rgba(66, 165, 245, .28)",
      temp: "rgba(239, 108, 108, .28)",
      pressure: "rgba(114, 183, 210, .28)",
    };
    ctx.strokeStyle = laneBorder[options.focusedLane];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, focusedBounds[0] - 3.5);
    ctx.lineTo(w - right, focusedBounds[0] - 3.5);
    ctx.moveTo(left, focusedBounds[1] + 3.5);
    ctx.lineTo(w - right, focusedBounds[1] + 3.5);
    ctx.stroke();
  }

  const now = Date.now();
  if (n > 1 && now >= timeline.startMs && now <= timeline.endMs) {
    ctx.strokeStyle = "rgba(252,82,0,.8)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xAtTime(now) + 0.5, layout.top);
    ctx.lineTo(xAtTime(now) + 0.5, layout.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (selectedTimeMs != null) {
    const selectedX = xAtTime(selectedTimeMs);
    ctx.strokeStyle = "rgba(255,255,255,.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(selectedX + 0.5, 0);
    ctx.lineTo(selectedX + 0.5, layout.bottom);
    ctx.stroke();

    const host = canvas.closest<HTMLElement>(".fc-charts");
    const header = canvas
      .closest<HTMLElement>(".fc-model-row")
      ?.querySelector<HTMLElement>("header");
    const canvasRect = canvas.getBoundingClientRect();
    const visibleLeft = Math.max(
      left + 2,
      header ? header.getBoundingClientRect().right - canvasRect.left + 4 : left + 2,
    );
    const visibleRight = Math.min(
      w - right,
      host ? host.getBoundingClientRect().right - canvasRect.left - 4 : w - right,
    );
    const drawBadge = (label: string, centerY: number, border: string): void => {
      ctx.font = "600 11px Ubuntu, system-ui, sans-serif";
      const width = Math.ceil(ctx.measureText(label).width) + 14;
      const height = 21;
      const roomRight = visibleRight - selectedX - 8;
      const roomLeft = selectedX - visibleLeft - 8;
      const preferred =
        roomRight >= width || roomRight >= roomLeft ? selectedX + 8 : selectedX - width - 8;
      const bx = Math.max(visibleLeft, Math.min(visibleRight - width, preferred));
      const by = Math.max(1, Math.min(h - height - 1, centerY - height / 2));
      ctx.fillStyle = "rgba(11, 13, 17, .94)";
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, width, height, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + 7, by + height / 2 + 0.5);
    };
    const drawDot = (
      value: number | null,
      y: (value: number) => number,
      color: string,
    ): void => {
      if (value == null) return;
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(11, 13, 17, .9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(selectedX, y(value), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    const index = forecast.times.indexOf(selectedTimeMs);
    if (index < 0 || !hasForecastValueAt(forecast, index, options.metrics)) {
      const firstLane =
        layout.wind ?? layout.direction ?? layout.rain ?? layout.temp ?? layout.pressure;
      if (firstLane)
        drawBadge("No forecast for this hour", (firstLane[0] + firstLane[1]) / 2, muted);
      return;
    }

    const readouts = forecastLaneReadouts(forecast, index, options);
    if (layout.wind && (!options.focusedLane || options.focusedLane === "wind")) {
      if (options.metrics.has("windSpeed")) {
        drawDot(
          forecast.windSpeedKmh[index],
          (value) =>
            sy(convertWindSpeed(value, options.speedUnit), 0, scales.windMax, layout.wind!),
          accent,
        );
      }
      if (options.metrics.has("windGust")) {
        drawDot(
          forecast.windGustKmh[index],
          (value) =>
            sy(convertWindSpeed(value, options.speedUnit), 0, scales.windMax, layout.wind!),
          "#f5a45d",
        );
      }
      const windValues = readouts.wind?.split(" · From ")[0];
      if (windValues) drawBadge(windValues, (layout.wind[0] + layout.wind[1]) / 2, accent);
    }
    if (layout.direction && (!options.focusedLane || options.focusedLane === "direction")) {
      const from = forecast.windDirectionDeg[index];
      const value = directionLine?.[index];
      if (from != null && value != null) {
        drawDirectionArrow(
          ctx,
          selectedX,
          sy(value, directionMin, directionMax, layout.direction),
          from,
          text,
        );
        drawBadge(
          `From ${compassFrom(from)} (${Math.round(from)}°)`,
          (layout.direction[0] + layout.direction[1]) / 2,
          "#9bb0c4",
        );
      }
    }
    if (
      layout.rain &&
      readouts.rain &&
      (!options.focusedLane || options.focusedLane === "rain")
    ) {
      drawDot(
        forecast.precipitationMm[index],
        (value) => sy(value, 0, scales.rainMax, layout.rain!),
        "#42a5f5",
      );
      drawBadge(readouts.rain, (layout.rain[0] + layout.rain[1]) / 2, "#42a5f5");
    }
    if (
      layout.temp &&
      readouts.temperature &&
      (!options.focusedLane || options.focusedLane === "temp")
    ) {
      drawDot(
        forecast.temperatureC[index],
        (value) => sy(value, scales.tempMin, scales.tempMax, layout.temp!),
        "#ef6c6c",
      );
      drawBadge(readouts.temperature, (layout.temp[0] + layout.temp[1]) / 2, "#ef6c6c");
    }
    if (
      layout.pressure &&
      readouts.pressure &&
      (!options.focusedLane || options.focusedLane === "pressure")
    ) {
      if (options.metrics.has("pressure")) {
        drawDot(
          forecast.pressureHpa[index],
          (value) => sy(value, scales.pressureMin, scales.pressureMax, layout.pressure!),
          "#72b7d2",
        );
      }
      drawBadge(readouts.pressure, (layout.pressure[0] + layout.pressure[1]) / 2, "#72b7d2");
    }
  }
}

/** Stable color used for the same model in the combined chart and its legend. */
export function forecastModelColor(modelId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < modelId.length; i++) {
    hash ^= modelId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 72% 64%)`;
}

type ForecastSeriesKey =
  | "windSpeedKmh"
  | "windDirectionDeg"
  | "windGustKmh"
  | "precipitationMm"
  | "temperatureC"
  | "pressureHpa"
  | "cloudCoverPct";

interface ComparisonStats {
  low: Array<number | null>;
  high: Array<number | null>;
  median: Array<number | null>;
}

export interface ForecastComparisonModelDetail {
  modelId: string;
  label: string;
  value: string;
  cells: string[];
}

export interface ForecastComparisonColumn {
  label: string;
  summary: string;
}

export interface ForecastComparisonDetails {
  lane: ForecastChartLane;
  summary: string;
  title: string;
  columns: ForecastComparisonColumn[];
  models: ForecastComparisonModelDetail[];
}

function comparisonStats(rows: Array<Array<number | null>>): ComparisonStats {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const low: Array<number | null> = [];
  const high: Array<number | null> = [];
  const median: Array<number | null> = [];
  for (let i = 0; i < count; i++) {
    const values = rows
      .flatMap((row) => (row[i] == null ? [] : [row[i]!]))
      .sort((a, b) => a - b);
    low.push(values[0] ?? null);
    high.push(values.at(-1) ?? null);
    median.push(
      values.length
        ? values.length % 2
          ? values[(values.length - 1) / 2]
          : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
        : null,
    );
  }
  return { low, high, median };
}

/** Textual comparison details shared by the inline canvas badge and touch sheet. */
export function forecastComparisonDetails(
  forecasts: HourlyForecast[],
  selectedTimeMs: number,
  lane: ForecastChartLane,
  options: ForecastChartOptions,
): ForecastComparisonDetails {
  const detailLane = lane === "direction" ? "wind" : lane;
  const indexes = forecasts.map(
    (forecast) => new Map(forecast.times.map((time, index) => [time, index])),
  );
  const at = (key: ForecastSeriesKey): Array<number | null> =>
    forecasts.map((forecast, forecastIndex) => {
      const index = indexes[forecastIndex].get(selectedTimeMs);
      const value = index == null ? null : forecast[key][index];
      return value == null
        ? null
        : key === "windSpeedKmh" || key === "windGustKmh"
          ? convertWindSpeed(value, options.speedUnit)
          : value;
    });
  const formatRange = (values: Array<number | null>, digits: number, unit: string): string => {
    const available = values
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b);
    if (!available.length) return `— ${unit}`;
    const low = available[0].toFixed(digits);
    const high = available.at(-1)!.toFixed(digits);
    const middle =
      available.length % 2
        ? available[(available.length - 1) / 2]
        : (available[available.length / 2 - 1] + available[available.length / 2]) / 2;
    return `${low === high ? low : `${low}–${high}`} ${unit} · median ${middle.toFixed(digits)}`;
  };
  const compactRange = (values: Array<number | null>, digits: number): string => {
    const available = values
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b);
    if (!available.length) return "—";
    const low = available[0].toFixed(digits);
    const high = available.at(-1)!.toFixed(digits);
    const middle =
      available.length % 2
        ? available[(available.length - 1) / 2]
        : (available[available.length / 2 - 1] + available[available.length / 2]) / 2;
    return `${low === high ? low : `${low}–${high}`} (${middle.toFixed(digits)})`;
  };
  const columns: ForecastComparisonColumn[] = [];
  const columnValues: string[][] = [];
  const addNumericColumn = (
    label: string,
    values: Array<number | null>,
    digits: number,
  ): void => {
    columns.push({ label, summary: compactRange(values, digits) });
    columnValues.push(values.map((value) => (value == null ? "—" : value.toFixed(digits))));
  };

  const labels: string[] = [];
  if (detailLane === "wind") {
    const digits = options.speedUnit === "kmh" ? 0 : 1;
    if (options.metrics.has("windSpeed")) {
      const values = at("windSpeedKmh");
      labels.push(`Wind ${formatRange(values, digits, speedUnitLabel(options.speedUnit))}`);
      addNumericColumn(`Wind ${speedUnitLabel(options.speedUnit)}`, values, digits);
    }
    if (options.metrics.has("windGust")) {
      const values = at("windGustKmh");
      labels.push(`Gust ${formatRange(values, digits, speedUnitLabel(options.speedUnit))}`);
      addNumericColumn(`Gust ${speedUnitLabel(options.speedUnit)}`, values, digits);
    }
    if (options.metrics.has("windDirection")) {
      const values = at("windDirectionDeg");
      const directions = values.filter((value): value is number => value != null);
      if (!directions.length) {
        labels.push("Direction —");
        columns.push({ label: "From", summary: "—" });
      } else {
        const sin = directions.reduce(
          (sum, value) => sum + Math.sin((value * Math.PI) / 180),
          0,
        );
        const cos = directions.reduce(
          (sum, value) => sum + Math.cos((value * Math.PI) / 180),
          0,
        );
        const mean = ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
        const spread = Math.max(
          ...directions.map((value) => Math.abs(((value - mean + 540) % 360) - 180)),
        );
        labels.push(`From ${compassFrom(mean)} · ±${spread.toFixed(0)}°`);
        columns.push({
          label: "From",
          summary: `${compassFrom(mean)} ±${spread.toFixed(0)}°`,
        });
      }
      columnValues.push(
        values.map((value) =>
          value == null ? "—" : `${compassFrom(value)} ${Math.round(value)}°`,
        ),
      );
    }
  } else if (detailLane === "rain") {
    const values = at("precipitationMm");
    labels.push(`Precip ${formatRange(values, 1, "mm")}`);
    addNumericColumn("mm", values, 1);
  } else if (detailLane === "temp") {
    const values = at("temperatureC");
    labels.push(`Temperature ${formatRange(values, 1, "°C")}`);
    addNumericColumn("°C", values, 1);
  } else {
    if (options.metrics.has("pressure")) {
      const values = at("pressureHpa");
      labels.push(`Pressure ${formatRange(values, 0, "hPa")}`);
      addNumericColumn("hPa", values, 0);
    }
    if (options.metrics.has("cloudCover")) {
      const values = at("cloudCoverPct");
      labels.push(`Cloud ${formatRange(values, 0, "%")}`);
      addNumericColumn("Cloud %", values, 0);
    }
  }

  const readoutKey: keyof ForecastLaneReadouts =
    detailLane === "wind"
      ? "wind"
      : detailLane === "rain"
        ? "rain"
        : detailLane === "temp"
          ? "temperature"
          : "pressure";
  const laneMetrics: Record<ForecastChartLane, ReadonlySet<ForecastMetric>> = {
    wind: new Set(["windSpeed", "windGust", "windDirection"]),
    direction: new Set(["windSpeed", "windGust", "windDirection"]),
    rain: new Set(["precipitation"]),
    temp: new Set(["temperature"]),
    pressure: new Set(["pressure", "cloudCover"]),
  };
  return {
    lane: detailLane,
    summary: labels.join(" · "),
    title:
      detailLane === "pressure" && !options.metrics.has("pressure")
        ? "Cloud cover"
        : { wind: "Wind", rain: "Precipitation", temp: "Temperature", pressure: "Pressure" }[
            detailLane
          ],
    columns,
    models: forecasts.map((forecast, forecastIndex) => {
      const index = indexes[forecastIndex].get(selectedTimeMs);
      const hasValue =
        index != null &&
        hasForecastValueAt(
          forecast,
          index,
          new Set(
            [...laneMetrics[detailLane]].filter((metric) => options.metrics.has(metric)),
          ),
        );
      return {
        modelId: forecast.modelId,
        label: options.modelLabels?.get(forecast.modelId) ?? forecast.modelId,
        cells: columnValues.map((values) => values[forecastIndex]),
        value:
          index == null || !hasValue
            ? "No data"
            : (forecastLaneReadouts(forecast, index, options)[readoutKey] ?? "No data"),
      };
    }),
  };
}

function comparisonBand(
  ctx: CanvasRenderingContext2D,
  low: Array<number | null>,
  high: Array<number | null>,
  x: (index: number) => number,
  y: (value: number) => number,
  color: string,
): void {
  let start = 0;
  while (start < low.length) {
    while (start < low.length && (low[start] == null || high[start] == null)) start++;
    if (start >= low.length) break;
    let end = start;
    while (end + 1 < low.length && low[end + 1] != null && high[end + 1] != null) end++;
    ctx.beginPath();
    ctx.moveTo(x(start), y(high[start]!));
    for (let i = start + 1; i <= end; i++) ctx.lineTo(x(i), y(high[i]!));
    for (let i = end; i >= start; i--) ctx.lineTo(x(i), y(low[i]!));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    start = end + 1;
  }
}

/** Render all selected models on one canvas, with min/max bands and median lines. */
export function drawForecastComparison(
  canvas: HTMLCanvasElement,
  forecasts: HourlyForecast[],
  scales: ForecastScales,
  timeline: ForecastTimeline,
  selectedTimeMs: number | null,
  timeZone: string,
  options: ForecastChartOptions,
): void {
  const w = canvas.clientWidth || 900;
  const compactLayout = chartLayout(options.metrics);
  const h = canvas.clientHeight || compactLayout.height;
  const layout = chartLayout(options.metrics, h);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const text = css("--text", "#e8edf2");
  const muted = css("--muted", "#8a97a6");
  const grid = css("--line", "#2a3340");
  const gridStrong = css("--line-strong", "#3a4655");
  const accent = css("--accent", "#fc5200");
  const left = PLOT_LEFT;
  const right = PLOT_RIGHT;
  const plotW = Math.max(1, w - left - right);
  const times = Array.from(
    { length: timeline.hours },
    (_, index) => timeline.startMs + index * HOUR_MS,
  );
  const x = (index: number): number =>
    left + (index / Math.max(1, timeline.hours - 1)) * plotW;
  const xAtTime = (time: number): number =>
    left +
    ((time - timeline.startMs) / Math.max(1, timeline.endMs - timeline.startMs)) * plotW;
  const sy = (
    value: number,
    min: number,
    max: number,
    lane: readonly [number, number],
  ): number => lane[1] - ((value - min) / Math.max(1e-6, max - min)) * (lane[1] - lane[0]);
  const indexes = forecasts.map(
    (forecast) => new Map(forecast.times.map((time, index) => [time, index])),
  );
  const aligned = (
    key: ForecastSeriesKey,
    transform: (value: number) => number = (value) => value,
  ): Array<Array<number | null>> =>
    forecasts.map((forecast, forecastIndex) =>
      times.map((time) => {
        const index = indexes[forecastIndex].get(time);
        const value = index == null ? null : forecast[key][index];
        return value == null ? null : transform(value);
      }),
    );
  const directions = layout.direction ? directionConsensus(aligned("windDirectionDeg")) : null;
  const [directionMin, directionMax] = directionDomain(
    directions ? [...directions.low, ...directions.high] : [],
  );

  const focusedBounds = options.focusedLane ? layout[options.focusedLane] : undefined;
  if (focusedBounds) {
    ctx.fillStyle = "rgba(255, 255, 255, .025)";
    ctx.fillRect(left, focusedBounds[0] - 3, plotW, focusedBounds[1] - focusedBounds[0] + 6);
  }

  const ticks = (min: number, max: number, lane: readonly [number, number]): number[] => {
    const laneHeight = lane[1] - lane[0];
    const count = laneHeight >= 220 ? 7 : laneHeight >= 120 ? 5 : 3;
    return Array.from(
      { length: count },
      (_, index) => min + ((max - min) * index) / (count - 1),
    );
  };
  const decimals = (span: number, smallThreshold: number): number =>
    span < smallThreshold ? 1 : 0;
  const drawScale = (
    unit: string,
    lane: readonly [number, number],
    min: number,
    max: number,
    digits: number,
    format: (value: number) => string = (value) => value.toFixed(digits),
  ): void => {
    ctx.save();
    ctx.font = "10px Ubuntu, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const value of ticks(min, max, lane)) {
      const y = sy(value, min, max, lane);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(w - right, y + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = text;
      ctx.textAlign = "right";
      ctx.fillText(format(value), left - 5, y);
    }
    ctx.globalAlpha = 1;
    ctx.font = "9px Ubuntu, system-ui, sans-serif";
    ctx.fillStyle = muted;
    ctx.textAlign = "left";
    ctx.fillText(unit, 3, (lane[0] + lane[1]) / 2);
    ctx.restore();
  };
  if (layout.wind) {
    drawScale(
      speedUnitLabel(options.speedUnit),
      layout.wind,
      0,
      scales.windMax,
      decimals(scales.windMax, 20),
    );
  }
  if (layout.direction)
    drawScale("from", layout.direction, directionMin, directionMax, 0, directionTick);
  if (layout.rain)
    drawScale("mm", layout.rain, 0, scales.rainMax, decimals(scales.rainMax, 4));
  if (layout.temp)
    drawScale(
      "°C",
      layout.temp,
      scales.tempMin,
      scales.tempMax,
      decimals(scales.tempMax - scales.tempMin, 4),
    );
  if (layout.pressure) {
    const pressure = options.metrics.has("pressure");
    drawScale(
      pressure ? "hPa" : "%",
      layout.pressure,
      pressure ? scales.pressureMin : 0,
      pressure ? scales.pressureMax : 100,
      pressure ? decimals(scales.pressureMax - scales.pressureMin, 2) : 0,
    );
  }

  drawTimeAxis(ctx, times, x, w, layout, timeZone, text, muted, gridStrong);

  const colors = forecasts.map((forecast) => forecastModelColor(forecast.modelId));
  const drawCollection = (
    rows: Array<Array<number | null>>,
    lane: readonly [number, number],
    min: number,
    max: number,
    bandColor: string,
    medianColor: string,
    dash: number[] = [],
  ): ComparisonStats => {
    const stats = comparisonStats(rows);
    comparisonBand(
      ctx,
      stats.low,
      stats.high,
      x,
      (value) => sy(value, min, max, lane),
      bandColor,
    );
    const ordered = rows.map((row, index) => ({ row, index }));
    if (options.focusedModelId) {
      ordered.sort(
        (a, b) =>
          Number(forecasts[a.index].modelId === options.focusedModelId) -
          Number(forecasts[b.index].modelId === options.focusedModelId),
      );
    }
    const visibleRows = options.showModelTracks
      ? ordered
      : ordered.filter(({ index }) => forecasts[index].modelId === options.focusedModelId);
    for (const { row, index } of visibleRows) {
      const focused = forecasts[index].modelId === options.focusedModelId;
      ctx.globalAlpha = options.focusedModelId ? (focused ? 1 : 0.13) : 0.68;
      line(
        ctx,
        row,
        x,
        (value) => sy(value, min, max, lane),
        colors[index],
        dash,
        focused ? 2.8 : 1.05,
      );
    }
    ctx.globalAlpha = options.focusedModelId ? 0.3 : 1;
    line(ctx, stats.median, x, (value) => sy(value, min, max, lane), medianColor, dash, 2.15);
    ctx.globalAlpha = 1;
    return stats;
  };
  const stats = new Map<ForecastSeriesKey, ComparisonStats>();
  if (layout.pressure && options.metrics.has("cloudCover")) {
    const rows = aligned("cloudCoverPct");
    const cloud = comparisonStats(rows);
    stats.set("cloudCoverPct", cloud);
    if (options.metrics.has("pressure")) {
      const hourWidth = plotW / Math.max(1, timeline.hours - 1);
      for (let i = 0; i < times.length; i++) {
        const value = cloud.median[i];
        if (value == null) continue;
        ctx.fillStyle = `rgba(155, 176, 196, ${0.025 + (value / 100) * 0.18})`;
        ctx.fillRect(
          Math.max(left, x(i) - hourWidth / 2),
          layout.pressure[0],
          Math.min(w - right, x(i) + hourWidth / 2) - Math.max(left, x(i) - hourWidth / 2),
          layout.pressure[1] - layout.pressure[0],
        );
      }
    } else {
      stats.set(
        "cloudCoverPct",
        drawCollection(rows, layout.pressure, 0, 100, "rgba(155,176,196,.14)", "#9bb0c4"),
      );
    }
  }
  if (layout.wind && options.metrics.has("windGust")) {
    const rows = aligned("windGustKmh", (value) => convertWindSpeed(value, options.speedUnit));
    stats.set(
      "windGustKmh",
      drawCollection(
        rows,
        layout.wind,
        0,
        scales.windMax,
        "rgba(245,164,93,.10)",
        "#f5a45d",
        [4, 3],
      ),
    );
  }
  if (layout.wind && options.metrics.has("windSpeed")) {
    const speedRows = aligned("windSpeedKmh", (value) =>
      convertWindSpeed(value, options.speedUnit),
    );
    stats.set(
      "windSpeedKmh",
      drawCollection(speedRows, layout.wind, 0, scales.windMax, "rgba(252,82,0,.12)", accent),
    );
  }
  if (layout.rain && options.metrics.has("precipitation")) {
    const rows = aligned("precipitationMm");
    stats.set(
      "precipitationMm",
      drawCollection(rows, layout.rain, 0, scales.rainMax, "rgba(66,165,245,.14)", "#42a5f5"),
    );
  }
  if (layout.temp && options.metrics.has("temperature")) {
    const rows = aligned("temperatureC");
    stats.set(
      "temperatureC",
      drawCollection(
        rows,
        layout.temp,
        scales.tempMin,
        scales.tempMax,
        "rgba(239,108,108,.13)",
        "#ef6c6c",
      ),
    );
  }
  if (layout.pressure && options.metrics.has("pressure")) {
    const rows = aligned("pressureHpa");
    stats.set(
      "pressureHpa",
      drawCollection(
        rows,
        layout.pressure,
        scales.pressureMin,
        scales.pressureMax,
        "rgba(114,183,210,.13)",
        "#72b7d2",
      ),
    );
  }

  if (layout.direction && directions) {
    comparisonBand(
      ctx,
      directions.low,
      directions.high,
      x,
      (value) => sy(value, directionMin, directionMax, layout.direction!),
      "rgba(155,176,196,.13)",
    );
    const ordered = directions.rows.map((row, index) => ({ row, index }));
    if (options.focusedModelId)
      ordered.sort(
        (a, b) =>
          Number(forecasts[a.index].modelId === options.focusedModelId) -
          Number(forecasts[b.index].modelId === options.focusedModelId),
      );
    const visibleRows = options.showModelTracks
      ? ordered
      : ordered.filter(({ index }) => forecasts[index].modelId === options.focusedModelId);
    for (const { row, index } of visibleRows) {
      const focused = forecasts[index].modelId === options.focusedModelId;
      ctx.globalAlpha = options.focusedModelId ? (focused ? 1 : 0.13) : 0.58;
      line(
        ctx,
        row,
        x,
        (value) => sy(value, directionMin, directionMax, layout.direction!),
        colors[index],
        [],
        focused ? 2.5 : 1,
      );
    }
    ctx.globalAlpha = 1;
    line(
      ctx,
      directions.mean,
      x,
      (value) => sy(value, directionMin, directionMax, layout.direction!),
      "#b8c9d9",
      [],
      1.9,
    );
    const arrowEvery = timeline.hours <= 96 ? 4 : timeline.hours <= 192 ? 8 : 12;
    for (let i = 0; i < times.length; i += arrowEvery) {
      const from = directions.mean[i];
      if (from == null) continue;
      drawDirectionArrow(
        ctx,
        x(i),
        sy(from, directionMin, directionMax, layout.direction),
        from,
        text,
      );
    }
  }

  for (const lane of [
    layout.wind,
    layout.direction,
    layout.rain,
    layout.temp,
    layout.pressure,
  ]) {
    if (!lane) continue;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(left, lane[1] + 4.5);
    ctx.lineTo(w - right, lane[1] + 4.5);
    ctx.stroke();
  }
  if (focusedBounds && options.focusedLane) {
    for (const laneName of ["wind", "direction", "rain", "temp", "pressure"] as const) {
      const bounds = layout[laneName];
      if (!bounds || laneName === options.focusedLane) continue;
      ctx.fillStyle = "rgba(6, 8, 12, .25)";
      ctx.fillRect(left, bounds[0] - 3, plotW, bounds[1] - bounds[0] + 6);
    }
  }

  const now = Date.now();
  if (now >= timeline.startMs && now <= timeline.endMs) {
    ctx.strokeStyle = "rgba(252,82,0,.8)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xAtTime(now) + 0.5, layout.top);
    ctx.lineTo(xAtTime(now) + 0.5, layout.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (selectedTimeMs == null) return;
  const selectedX = xAtTime(selectedTimeMs);
  ctx.strokeStyle = "rgba(255,255,255,.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(selectedX + 0.5, 0);
  ctx.lineTo(selectedX + 0.5, layout.bottom);
  ctx.stroke();
  const selectedIndex = Math.round((selectedTimeMs - timeline.startMs) / HOUR_MS);
  if (selectedIndex < 0 || selectedIndex >= times.length || !options.focusedLane) return;

  const at = (key: ForecastSeriesKey): Array<number | null> => {
    return forecasts.map((forecast, forecastIndex) => {
      const index = indexes[forecastIndex].get(selectedTimeMs);
      const value = index == null ? null : forecast[key][index];
      return value == null
        ? null
        : key === "windSpeedKmh" || key === "windGustKmh"
          ? convertWindSpeed(value, options.speedUnit)
          : value;
    });
  };
  const details = forecastComparisonDetails(
    forecasts,
    selectedTimeMs,
    options.focusedLane,
    options,
  );
  const bounds = layout[options.focusedLane];
  if (!bounds || !details.summary) return;
  if (options.cursorDetails !== "external") {
    const laneColor: Record<ForecastChartLane, string> = {
      wind: accent,
      direction: "#9bb0c4",
      rain: "#42a5f5",
      temp: "#ef6c6c",
      pressure: "#72b7d2",
    };
    const modelRows = details.models
      .filter((row) => row.value !== "No data")
      .map((row) => ({
        color: forecastModelColor(row.modelId),
        name: row.label,
        cells: row.cells,
      }));
    const rowHeight = 17;
    const badgeHeight = 70 + modelRows.length * rowHeight;
    const host = canvas.closest<HTMLElement>(".fc-charts");
    const rect = canvas.getBoundingClientRect();
    const visibleLeft = Math.max(
      left + 2,
      host ? host.getBoundingClientRect().left - rect.left + 4 : left,
    );
    const visibleRight = Math.min(
      w - right,
      host ? host.getBoundingClientRect().right - rect.left - 4 : w - right,
    );
    const badgeWidth = Math.min(
      plotW - 8,
      details.columns.length > 2 ? 460 : 370,
      Math.max(1, visibleRight - visibleLeft),
    );
    const preferred =
      visibleRight - selectedX >= badgeWidth + 8 ? selectedX + 8 : selectedX - badgeWidth - 8;
    const bx = Math.max(visibleLeft, Math.min(visibleRight - badgeWidth, preferred));
    const by = Math.max(
      3,
      Math.min(h - badgeHeight - 4, (bounds[0] + bounds[1] - badgeHeight) / 2),
    );
    ctx.fillStyle = "rgba(11,13,17,.95)";
    ctx.strokeStyle = laneColor[options.focusedLane];
    ctx.beginPath();
    ctx.roundRect(bx, by, badgeWidth, badgeHeight, 5);
    ctx.fill();
    ctx.stroke();
    const innerLeft = bx + 9;
    const innerWidth = badgeWidth - 18;
    const nameWidth = Math.min(170, Math.max(110, innerWidth * 0.42));
    const columnWidth = (innerWidth - nameWidth) / details.columns.length;
    const columnRight = (index: number): number =>
      innerLeft + nameWidth + (index + 1) * columnWidth;
    const date = new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(selectedTimeMs);
    ctx.fillStyle = text;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "600 11px Ubuntu, system-ui, sans-serif";
    ctx.fillText(`${date} · ${details.title}`, innerLeft, by + 14, innerWidth);
    ctx.font = "9px Ubuntu, system-ui, sans-serif";
    ctx.fillStyle = muted;
    ctx.fillText("MODEL", innerLeft + 9, by + 37, nameWidth - 12);
    ctx.textAlign = "right";
    details.columns.forEach((column, index) => {
      ctx.fillText(
        column.label.toUpperCase(),
        columnRight(index) - 2,
        by + 37,
        columnWidth - 6,
      );
    });
    ctx.font = "600 10px Ubuntu, system-ui, sans-serif";
    ctx.fillStyle = text;
    ctx.textAlign = "left";
    ctx.fillText("Range (median)", innerLeft + 9, by + 55, nameWidth - 12);
    ctx.textAlign = "right";
    details.columns.forEach((column, index) => {
      ctx.fillText(column.summary, columnRight(index) - 2, by + 55, columnWidth - 6);
    });
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.beginPath();
    ctx.moveTo(innerLeft, by + 65.5);
    ctx.lineTo(innerLeft + innerWidth, by + 65.5);
    ctx.stroke();
    ctx.font = "10px Ubuntu, system-ui, sans-serif";
    modelRows.forEach((row, index) => {
      const cy = by + 75 + index * rowHeight;
      ctx.fillStyle = row.color;
      ctx.beginPath();
      ctx.arc(innerLeft + 2, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = muted;
      ctx.textAlign = "left";
      ctx.fillText(row.name, innerLeft + 10, cy, nameWidth - 12);
      ctx.fillStyle = text;
      ctx.textAlign = "right";
      row.cells.forEach((cell, cellIndex) => {
        ctx.fillText(cell, columnRight(cellIndex) - 2, cy, columnWidth - 6);
      });
    });
  }

  const dotKey: ForecastSeriesKey | null =
    options.focusedLane === "wind"
      ? options.metrics.has("windSpeed")
        ? "windSpeedKmh"
        : options.metrics.has("windGust")
          ? "windGustKmh"
          : null
      : options.focusedLane === "direction"
        ? null
        : options.focusedLane === "rain"
          ? "precipitationMm"
          : options.focusedLane === "temp"
            ? "temperatureC"
            : options.metrics.has("pressure")
              ? "pressureHpa"
              : options.metrics.has("cloudCover")
                ? "cloudCoverPct"
                : null;
  if (!dotKey) return;
  const dotValues = at(dotKey);
  const domain: [number, number] =
    dotKey === "windSpeedKmh" || dotKey === "windGustKmh"
      ? [0, scales.windMax]
      : dotKey === "precipitationMm"
        ? [0, scales.rainMax]
        : dotKey === "temperatureC"
          ? [scales.tempMin, scales.tempMax]
          : dotKey === "pressureHpa"
            ? [scales.pressureMin, scales.pressureMax]
            : [0, 100];
  dotValues.forEach((value, index) => {
    if (value == null) return;
    ctx.fillStyle = colors[index];
    ctx.strokeStyle = "rgba(11,13,17,.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(selectedX, sy(value, domain[0], domain[1], bounds), 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}
