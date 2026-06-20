import type { WindSeg } from "./windspeed";

/** The fitted line + quality, as produced by `linearRegression`. */
export interface ChartReg {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

/**
 * "Nice" axis ticks covering [min, max] in roughly `target` steps, snapped to a
 * 1/2/5 × 10ⁿ grid so labels read cleanly. Returns `[min]` for a degenerate range.
 */
export function niceTicks(min: number, max: number, target = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/** Linear map from a value domain to a pixel range. */
export function makeScale(
  dMin: number,
  dMax: number,
  pMin: number,
  pMax: number,
): (v: number) => number {
  const span = dMax - dMin || 1;
  return (v: number): number => pMin + ((v - dMin) / span) * (pMax - pMin);
}

/** Read a CSS custom property off :root, with a fallback so tests/SSR don't crash. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Optional drawing tweaks for the scatter. */
export interface ChartOpts {
  /** Per-dot fill colour (e.g. crosswind-tinted); falls back to the flat accent. */
  dotColor?: (seg: WindSeg) => string;
}

/**
 * Draw the wind-vs-speed scatter + regression on a canvas. X = along-track (true)
 * wind, 0-centred so the two halves read as mirror images (← headwind / tailwind →);
 * Y = average moving speed. Each dot is a segment, sized by its distance and (when
 * `opts.dotColor` is given) tinted by its crosswind. The headwind half is tinted
 * faint red and the tailwind half faint green, matching the ride map's wind
 * colouring. DPR-aware so it stays crisp on retina + after a resize.
 */
export function drawWindSpeedChart(
  canvas: HTMLCanvasElement,
  segs: WindSeg[],
  reg: ChartReg,
  opts: ChartOpts = {},
): void {
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 360;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const colText = cssVar("--text", "#e8edf2");
  const colMuted = cssVar("--muted", "#8a97a6");
  const colLine = cssVar("--line", "#2a3340");
  const colAccent = cssVar("--accent", "#f97316");

  const m = { l: 50, r: 16, t: 16, b: 36 };
  const x0 = m.l;
  const x1 = cssW - m.r;
  const y0 = cssH - m.b;
  const y1 = m.t;

  // Domains. X symmetric around 0 so headwind/tailwind read as mirror halves.
  let maxAbsX = 1;
  let maxY = 1;
  for (const s of segs) {
    maxAbsX = Math.max(maxAbsX, Math.abs(s.avgAlongKmh));
    maxY = Math.max(maxY, s.avgSpeedKmh);
  }
  maxAbsX = Math.ceil(maxAbsX * 1.1);
  maxY = Math.ceil(maxY * 1.1);
  const sx = makeScale(-maxAbsX, maxAbsX, x0, x1);
  const sy = makeScale(0, maxY, y0, y1);

  // Head/tail tinted halves.
  const mid = sx(0);
  ctx.fillStyle = "rgba(239,68,68,0.06)"; // headwind (left)
  ctx.fillRect(x0, y1, mid - x0, y0 - y1);
  ctx.fillStyle = "rgba(34,197,94,0.06)"; // tailwind (right)
  ctx.fillRect(mid, y1, x1 - mid, y0 - y1);

  // Gridlines + tick labels.
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = colLine;
  ctx.lineWidth = 1;
  ctx.fillStyle = colMuted;
  ctx.textAlign = "center";
  for (const t of niceTicks(-maxAbsX, maxAbsX)) {
    const px = sx(t);
    ctx.globalAlpha = t === 0 ? 0 : 1; // the 0-line is drawn separately (dashed)
    ctx.beginPath();
    ctx.moveTo(px, y1);
    ctx.lineTo(px, y0);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(String(t), px, y0 + 14);
  }
  ctx.textAlign = "right";
  for (const t of niceTicks(0, maxY)) {
    const py = sy(t);
    ctx.beginPath();
    ctx.moveTo(x0, py);
    ctx.lineTo(x1, py);
    ctx.stroke();
    ctx.fillText(String(t), x0 - 8, py);
  }

  // 0-wind reference (dashed).
  ctx.strokeStyle = colMuted;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(mid, y1);
  ctx.lineTo(mid, y0);
  ctx.stroke();
  ctx.setLineDash([]);

  // Axes (L-shape).
  ctx.strokeStyle = colLine;
  ctx.beginPath();
  ctx.moveTo(x0, y1);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x1, y0);
  ctx.stroke();

  // Scatter — radius by sqrt(distance), clamped 2..7 px. Kept calm (low alpha) so
  // the regression line reads on top of the cloud rather than blending into it. When
  // a per-dot colour is given (crosswind tint) each dot is filled individually at a
  // slightly higher alpha so the hue reads.
  const { dotColor } = opts;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y1, x1 - x0, y0 - y1);
  ctx.clip();
  ctx.globalAlpha = dotColor ? 0.8 : 0.38;
  if (!dotColor) ctx.fillStyle = colAccent;
  for (const s of segs) {
    const r = Math.max(2, Math.min(7, Math.sqrt(s.distanceKm) * 1.6));
    if (dotColor) ctx.fillStyle = dotColor(s);
    ctx.beginPath();
    ctx.arc(sx(s.avgAlongKmh), sy(s.avgSpeedKmh), r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Regression line across the X domain. A thin dark casing lifts it off the
  // same-hue scatter just enough to read, without the heavy halo of a bright outline.
  if (reg.n >= 2) {
    const yL = reg.intercept + reg.slope * -maxAbsX;
    const yR = reg.intercept + reg.slope * maxAbsX;
    const xa = sx(-maxAbsX);
    const xb = sx(maxAbsX);
    const ya = sy(yL);
    const yb = sy(yR);
    ctx.lineCap = "round";
    // Subtle dark casing for separation.
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.stroke();
    // Accent core.
    ctx.strokeStyle = colAccent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.stroke();
    ctx.lineCap = "butt";
  }
  ctx.restore();

  // Axis captions.
  ctx.fillStyle = colMuted;
  ctx.textAlign = "center";
  // Sit the caption on its baseline just inside the bottom edge — with the tick
  // labels' "middle" baseline it was clipped in half.
  ctx.textBaseline = "alphabetic";
  ctx.fillText("← headwind        tailwind →   (km/h)", (x0 + x1) / 2, cssH - 5);
  ctx.save();
  ctx.translate(12, (y0 + y1) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "middle";
  ctx.fillStyle = colText;
  ctx.fillText("avg moving speed (km/h)", 0, 0);
  ctx.restore();
}
