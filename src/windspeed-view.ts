/**
 * GPX Toolkit — Wind/Speed view (the wind-vs-speed scatter).
 *
 * Extracted from `main.ts`. For every roughly-straight stretch of a wind-resolved
 * ride it plots a point — headwind→left, tailwind→right, speed up the side — and
 * fits a line: the intercept is your still-air speed, the slope how much a km/h of
 * tailwind helps. Speed is only trustworthy from a ride's FULL recorded GPX (real
 * per-point timestamps), so rides without it are counted but left out. The heavy
 * per-ride segmentation only runs for the rides inside the selected date window —
 * and only after the user presses "Analyse" (a once-per-session confirm gate, so we
 * never auto-sweep a big history on entering the tab) — then it's cached so
 * re-filtering (slider / flat-only / max-speed) stays instant.
 *
 * Self-contained behind a `WindSpeedDeps` seam (the controller, live ride list and
 * the shared date-range control are injected as lazy closures); it imports the pure
 * helpers (windspeed maths, the chart renderer, formatters) directly.
 */

import { activeView } from "./app-state";
import type { RideView } from "./controller";
import { fmtKm, fmtKmDetail, fmtSpeed } from "./format";
import type { DateRange } from "./mapview";
import { compareRidesByDateDesc, rideShortLabel } from "./parsing";
import { setSliderFill } from "./slider";
import type { LatLon } from "./track";
import { escHtml, statNum } from "./ui";
import {
  type ChartLayout,
  drawDotHighlights,
  drawWindSpeedChart,
  nearestDot,
} from "./windchart";
import {
  crossColor,
  linearRegression,
  type SegmentOpts,
  segmentRide,
  speedCapIndices,
  type WindSeg,
} from "./windspeed";

/** What the view needs from the app (injected once via `initWindSpeedView`). */
export interface WindSpeedDeps {
  /** The live (possibly-deleted-included) ride list. */
  getRides(): RideView[];
  /** Filter rides to a date selection (the app's shared range helper). */
  ridesInRange(rides: RideView[], range: DateRange): RideView[];
  /** Apply the app's global ride filters (the shared `visibleRides`). */
  applyFilters(rides: RideView[]): RideView[];
  /** The current Wind/Speed date selection, or null for the full span. */
  analyticsRange(): DateRange | null;
  /** Speed under which a moment counts as stopped (settings). */
  movingThresholdKmh(): number;
  /** A ride's wind-resolution version stamp (busts the segment cache). */
  weatherFetchedAt(key: string): string;
  /** Wind samples + the point/time series for a ride (null when unresolved). */
  windSamples(key: string): Promise<{
    points: LatLon[];
    times: number[];
    eles: (number | null)[];
    along: (number | null)[];
    cross: (number | null)[];
    realTimes: boolean;
  } | null>;
  /** Sync the shared date-range control's bounds for this view. */
  refreshRange(): void;
  /** (Re)mount the shared date-range slider for this view. */
  syncRangeControl(): void;
  /** Open a ride (by its key) in the Explore view — the target of a selected dot. */
  openRide(key: string): void;
}

/** A ride's memoized segments plus why it may contribute none. */
type RideSegEntry = {
  segs: WindSeg[];
  /** ok = full timed GPX, segments usable; needgpx = resolved but no full timed
   *  track (speed would be synthetic); skip = no usable wind (noData / unaligned). */
  status: "ok" | "needgpx" | "skip";
};

let deps!: WindSpeedDeps;

const segCacheByUid = new Map<string, RideSegEntry>();
let analyticsSeq = 0;
/** True while an analytics sweep is in flight. Lets a passive re-render coalesce into
 *  a single post-run rerun instead of aborting + restarting the live sweep. */
let analyticsRunning = false;
/** A state change asked the view to refresh while a sweep was running; the running
 *  sweep fires exactly one rerun when it finishes (if still on the tab). */
let analyticsRerunQueued = false;
/** Confirm-to-run gate: the user must press "Analyse" once per session to start the
 *  (possibly heavy) sweep — we never auto-analyse on entering the tab. Resets on
 *  reload; once armed the view runs live (slider / filter changes re-sweep). */
let analyticsArmed = false;
/** |net grade| above this (percent) means a segment isn't "flat". */
const FLAT_GRADE_PCT = 1.5;

// -- Dot ↔ ride discovery -------------------------------------------------- //
// The last drawn scatter's hit-test geometry, plus which segment the user has
// selected (pinned, by tap/click) and which one they're hovering (desktop only). A
// dot already knows its ride (`WindSeg.uid` is the ride key), so selecting one lets us
// name the ride, ring all its sibling segments, and jump to it. Highlights paint on a
// cheap overlay canvas so the base scatter is never redrawn for hover.
let chartLayout: ChartLayout = { dots: [] };
let selectedSeg: WindSeg | null = null;
let hoverSeg: WindSeg | null = null;
let interactionWired = false;
/** px slack added to a dot's radius when hit-testing: tight for a mouse, generous for
 *  a finger. */
const HOVER_SLACK = 10;
const TAP_SLACK = 16;

/** True on devices with a precise hover-capable pointer (mouse/trackpad). Touch gets
 *  tap-to-select only — no hover ring/tooltip that a finger can't drive. */
function canHover(): boolean {
  return window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false;
}

/** Wire the view's dependencies. Call once at startup. */
export function initWindSpeedView(d: WindSpeedDeps): void {
  deps = d;
  wireChartInteraction();
}

/** Memo key for a ride's segments: uid + wind version + full-GPX presence, so a
 *  re-resolve or a full-GPX fetch busts it. The segment-geometry tuning (look-ahead /
 *  turn / min-length) also changes the chopper's output, so its signature is folded
 *  in — a knob change yields fresh cache entries and reverting reuses the old ones. */
function segKey(r: RideView): string {
  const t = segmentTuning();
  return (
    `${r.key}::${deps.weatherFetchedAt(r.key)}::${r.gpx_cached ? "g" : "_"}` +
    `::la${t.lookAheadM}t${t.turnDeg}m${t.minLenM}`
  );
}

/** The non-deleted rides within the current Wind/Speed date selection. */
export function windSpeedVisibleRides(): RideView[] {
  const range = deps.analyticsRange();
  const rides = deps.getRides();
  const visible = deps.applyFilters(range ? deps.ridesInRange(rides, range) : rides);
  return visible.filter((r) => !r.deleted);
}

/** Current max-speed cap (km/h) from the slider (20..80), defaulting to 50. Segments
 *  whose average speed exceeds this are dropped as GPS glitches. */
function analyticsMaxSpeed(): number {
  const el = document.getElementById("maxSpeed") as HTMLInputElement | null;
  const v = el ? parseInt(el.value, 10) : 50;
  return Number.isFinite(v) ? Math.max(20, Math.min(80, v)) : 50;
}

/** Whether to tint each scatter dot by its crosswind magnitude (the toggle). */
function analyticsColorByCross(): boolean {
  return (
    (document.getElementById("colorByCross") as HTMLInputElement | null)?.checked ?? false
  );
}

/** The crosswind-magnitude band to keep (km/h), read from the min/max inputs. A blank
 *  side means "no bound"; values are clamped non-negative and ordered low≤high. */
function analyticsCrosswind(): { min: number; max: number } {
  const read = (id: string): number | null => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    const v = el && el.value.trim() !== "" ? Number(el.value) : null;
    return v != null && Number.isFinite(v) && v >= 0 ? v : null;
  };
  let min = read("cwMin") ?? 0;
  let max = read("cwMax") ?? Number.POSITIVE_INFINITY;
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

/** Compact label for a crosswind band, for the analysed-rides note. */
function crosswindLabel(cw: { min: number; max: number }): string {
  const hasMax = Number.isFinite(cw.max);
  if (cw.min > 0 && hasMax) return `${cw.min}–${cw.max} km/h`;
  if (hasMax) return `≤${cw.max} km/h`;
  if (cw.min > 0) return `≥${cw.min} km/h`;
  return "any";
}

/** Show/hide + fill the crosswind colour legend: a calm→strong gradient strip scaled
 *  to the strongest crosswind in view, with 0 and max end-labels. Visible only when
 *  the "Colour by crosswind" toggle is on. */
function renderCrosswindLegend(on: boolean, maxKmh: number): void {
  const el = document.getElementById("crosswindLegend");
  if (!el) return;
  if (!on) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const stops: string[] = [];
  const N = 6;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    stops.push(`${crossColor(t * maxKmh, maxKmh)} ${Math.round(t * 100)}%`);
  }
  el.classList.remove("hidden");
  el.innerHTML =
    `<span class="cw-cap">crosswind</span>` +
    `<span class="cw-end">0</span>` +
    `<span class="cw-bar" style="background:linear-gradient(90deg, ${stops.join(", ")})"></span>` +
    `<span class="cw-end">${maxKmh} km/h</span>`;
}

/** Default segment-geometry tuning (also the values the Reset button restores). */
export const SEG_TUNE_DEFAULTS = { lookAheadM: 15, turnDeg: 35, minLenM: 300 };

/** Read + clamp the segment-geometry knobs from their sliders. These feed BOTH the
 *  chopper (`SegmentOpts`) and the segment-cache key, so they must be read in one
 *  canonical place. Unlike the max-speed / flat-only post-filters, changing any of
 *  these re-runs the per-ride segmentation (the cache key changes). */
function segmentTuning(): { lookAheadM: number; turnDeg: number; minLenM: number } {
  const read = (id: string, lo: number, hi: number, def: number): number => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    const v = el ? parseInt(el.value, 10) : def;
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
  };
  return {
    lookAheadM: read("segLookAhead", 0, 50, SEG_TUNE_DEFAULTS.lookAheadM),
    turnDeg: read("segTurn", 15, 120, SEG_TUNE_DEFAULTS.turnDeg),
    minLenM: read("segMinLen", 50, 2000, SEG_TUNE_DEFAULTS.minLenM),
  };
}

/** Render the empty/blocked state, adapting message + CTA to whether the blocker is
 *  unresolved wind or missing full GPX. */
function renderAnalyticsEmpty(kind: "wind" | "gpx", n: number): void {
  const el = document.getElementById("analyticsEmpty");
  if (!el) return;
  if (kind === "wind") {
    el.innerHTML =
      "See how much the wind speeds you up or slows you down. This needs rides with " +
      "<b>resolved wind</b> — once some are resolved, each roughly-straight stretch of a " +
      "ride becomes a point: headwind on the left, tailwind on the right, your speed up the " +
      'side. <button type="button" class="linkbtn" id="analyticsResolveEmpty">' +
      "Resolve wind for these rides</button>";
  } else {
    el.innerHTML =
      `Wind is resolved, but charting speed needs each ride's <b>full GPX</b> (real ` +
      `timestamps). Without it, a segment's speed would be guessed from evenly-spaced ` +
      `points rather than your real pace, so ${n === 1 ? "this ride is" : `these ${n} rides are`} ` +
      `left out. <button type="button" class="linkbtn" id="analyticsFetchGpxEmpty">` +
      `Fetch full GPX for these rides</button>`;
  }
}

/** Blank the KPI cards to placeholders (used while the confirm gate is shown — no
 *  analysis has run yet, so there are no numbers to report). */
function setAnalyticsCardsPlaceholder(): void {
  const cards = document.getElementById("analyticsCards");
  if (!cards) return;
  cards.innerHTML = [
    statNum({ value: "—", label: "still-air speed" }),
    statNum({ value: "—", label: "km/h per km/h of tailwind" }),
    statNum({ value: "—", label: "R² (wind explains)" }),
    statNum({ value: "—", label: "segments" }),
  ].join("");
}

/** The confirm-to-run gate: a centred card stating exactly how many rides the current
 *  window will analyse (it live-updates as the slider moves) plus an "Analyse" button
 *  that arms the sweep. Shown until the user opts in (once per session). */
function renderAnalyticsGate(rideCount: number, unresolved: number, needGpx: number): void {
  const el = document.getElementById("analyticsChartMsg");
  if (!el) return;
  const ridesWord = rideCount === 1 ? "ride" : "rides";
  const hints: string[] = [];
  if (needGpx) hints.push(`${needGpx} need full GPX for speed`);
  if (unresolved) hints.push(`${unresolved} not yet wind-resolved`);
  el.innerHTML =
    `<span class="cm-card cm-gate">` +
    `<b class="cm-head">Analyse wind vs speed</b>` +
    `<span class="cm-detail"><b>${rideCount}</b> ${ridesWord} in the selected date window</span>` +
    (hints.length ? `<span class="cm-detail">${hints.join(" · ")}</span>` : "") +
    `<button type="button" class="primary small cm-go" id="analyticsRun"${
      rideCount === 0 ? " disabled" : ""
    }>Analyse ${rideCount} ${ridesWord}</button>` +
    `</span>`;
  el.style.display = "flex";
  document.getElementById("analyticsRun")?.addEventListener("click", () => {
    analyticsArmed = true;
    void mountWindSpeedView();
  });
}

/** Show each action button only when it can act on rides in range, with the affected
 *  count in its label. */
function syncAnalyticsActions(inRange: RideView[]): void {
  const unresolved = inRange.filter((r) => !r.wind_resolved && !!r.track).length;
  const needGpx = inRange.filter((r) => r.source !== "gpx" && !r.gpx_cached).length;
  const resolveBtn = document.getElementById("analyticsResolve");
  if (resolveBtn) {
    resolveBtn.style.display = unresolved === 0 ? "none" : "";
    resolveBtn.textContent =
      unresolved === 1 ? "Resolve wind for 1 ride" : `Resolve wind for ${unresolved} rides`;
  }
  const gpxBtn = document.getElementById("analyticsFetchGpx");
  if (gpxBtn) {
    gpxBtn.style.display = needGpx === 0 ? "none" : "";
    gpxBtn.textContent =
      needGpx === 1 ? "Fetch full GPX for 1 ride" : `Fetch full GPX for ${needGpx} rides`;
  }
}

/** Show (or clear) a calm centred message over the chart area without changing the
 *  page layout. Pass a 0..1 `progress` to add a determinate bar (analysing sweep). */
function showChartMessage(text: string | null, progress?: number, detail?: string): void {
  const el = document.getElementById("analyticsChartMsg");
  if (!el) return;
  if (text) {
    if (progress !== undefined) {
      const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
      el.innerHTML =
        `<span class="cm-card"><b class="cm-head">${text}</b>` +
        (detail ? `<span class="cm-detail">${detail}</span>` : "") +
        `<div class="chart-msg-bar"><i style="width:${pct}%"></i></div></span>`;
    } else {
      el.innerHTML = `<span>${text}</span>`;
    }
    el.style.display = "flex";
  } else {
    el.style.display = "none";
    el.textContent = "";
  }
}

/** Yield to the browser so a just-set overlay actually paints before more blocking
 *  work. Two rAFs guarantees a committed frame across engines. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Blank the scatter canvas (used when a range has no points to draw). Also drops any
 *  dot selection + its highlight/card, since there are no dots to point at. */
function clearChart(): void {
  const canvas = document.getElementById("windSpeedChart") as HTMLCanvasElement | null;
  const ctx = canvas?.getContext("2d");
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  chartLayout = { dots: [] };
  clearSegSelection();
}

/** Entry point: (re)render the Wind/Speed view, coalescing reruns during a sweep. */
export async function mountWindSpeedView(opts: { fit?: boolean } = {}): Promise<void> {
  if (analyticsRunning) {
    analyticsRerunQueued = true;
    return;
  }
  const my = ++analyticsSeq;
  analyticsRunning = true;
  try {
    await runAnalyticsView(my, opts);
  } finally {
    analyticsRunning = false;
    if (analyticsRerunQueued && activeView() === "analytics") {
      analyticsRerunQueued = false;
      void mountWindSpeedView();
    }
  }
}

async function runAnalyticsView(my: number, _opts: { fit?: boolean } = {}): Promise<void> {
  deps.refreshRange();
  const inRange = windSpeedVisibleRides();
  const resolved = inRange.filter((r) => r.wind_resolved);

  const empty = document.getElementById("analyticsEmpty");
  const body = document.getElementById("analyticsBody");
  deps.syncRangeControl();

  // Cold first run — nothing resolved anywhere yet → the full onboarding guide.
  const anyResolvedEver = deps.getRides().some((r) => !r.deleted && r.wind_resolved);
  if (!anyResolvedEver) {
    renderAnalyticsEmpty("wind", 0);
    empty?.classList.remove("hidden");
    body?.classList.add("hidden");
    return;
  }

  empty?.classList.add("hidden");
  body?.classList.remove("hidden");
  syncAnalyticsActions(inRange);

  // Confirm-to-run gate: never auto-sweep. Until the user presses "Analyse" once this
  // session, show a card naming exactly how many rides the current window will
  // analyse — it live-updates as the date slider moves, and nothing computes yet.
  if (!analyticsArmed) {
    const unresolved = inRange.filter((r) => !r.wind_resolved && !!r.track).length;
    const needGpx = inRange.filter((r) => r.source !== "gpx" && !r.gpx_cached).length;
    renderAnalyticsGate(resolved.length, unresolved, needGpx);
    clearChart();
    setAnalyticsCardsPlaceholder();
    const noteEl = document.getElementById("analyticsNote");
    if (noteEl) noteEl.textContent = "";
    return;
  }

  const tune = segmentTuning();
  const opts: SegmentOpts = {
    stopKmh: deps.movingThresholdKmh(),
    lookAheadM: tune.lookAheadM,
    turnDeg: tune.turnDeg,
    minKm: tune.minLenM / 1000,
  };
  // Sweep only the wind-resolved rides inside the selected window (not the whole
  // dataset) — the date slicer scopes the work, so a narrow window stays cheap.
  const pending = resolved
    .filter((r) => !segCacheByUid.has(segKey(r)))
    .sort(compareRidesByDateDesc);
  let done = 0;
  let lastPaint = 0;
  const sweepStart = performance.now();
  for (const r of pending) {
    const key = segKey(r);
    let entry: RideSegEntry;
    try {
      const s = await deps.windSamples(r.key);
      if (my !== analyticsSeq) return;
      if (!s) entry = { segs: [], status: "skip" };
      else if (!s.realTimes) entry = { segs: [], status: "needgpx" };
      else
        entry = {
          segs: segmentRide(s.points, s.times, s.eles, s.along, s.cross, opts, r.key),
          status: "ok",
        };
    } catch (err) {
      console.error(`analytics: skipping ${r.key} —`, err);
      entry = { segs: [], status: "skip" };
    }
    if (my !== analyticsSeq) return;
    segCacheByUid.set(key, entry);
    done++;
    const now = performance.now();
    if (now - sweepStart >= 200 && (now - lastPaint >= 100 || done === pending.length)) {
      lastPaint = now;
      const label = rideShortLabel(r.date_key);
      showChartMessage(
        "Analysing rides…",
        done / pending.length,
        `${label ? `${label} · ` : ""}${done} / ${pending.length}`,
      );
      await nextPaint();
      if (my !== analyticsSeq) return;
    }
  }
  if (my !== analyticsSeq) return;

  const flatOnly =
    (document.getElementById("flatOnly") as HTMLInputElement | null)?.checked ?? false;
  const cw = analyticsCrosswind();
  let usableRides = 0;
  let needGpxRides = 0;
  let skippedRides = 0;
  let crossFiltered = 0;
  const segs: WindSeg[] = [];
  for (const r of resolved) {
    const entry = segCacheByUid.get(segKey(r));
    if (!entry) continue;
    if (entry.status === "needgpx") needGpxRides++;
    if (entry.status === "skip") skippedRides++;
    if (entry.status !== "ok") continue;
    usableRides++;
    for (const seg of entry.segs) {
      if (flatOnly) {
        if (!Number.isFinite(seg.netGradePct)) continue;
        if (Math.abs(seg.netGradePct) > FLAT_GRADE_PCT) continue;
      }
      // Crosswind band filter (on |cross| magnitude): drop side-windy or too-calm
      // stretches per the min/max inputs.
      const mag = Math.abs(seg.avgCrossKmh);
      if (mag < cw.min || mag > cw.max) {
        crossFiltered++;
        continue;
      }
      segs.push(seg);
    }
  }

  // Drop physically-impossible segments above the Max-speed cap (GPS glitches).
  const maxSpeed = analyticsMaxSpeed();
  const out = document.getElementById("maxSpeedOut") as HTMLOutputElement | null;
  if (out) out.value = `${maxSpeed} km/h`;
  const maxEl = document.getElementById("maxSpeed") as HTMLInputElement | null;
  if (maxEl) setSliderFill(maxEl);
  const keep = speedCapIndices(
    segs.map((s) => s.avgSpeedKmh),
    maxSpeed,
  );
  const shown = keep.map((i) => segs[i]);
  const trimmed = segs.length - shown.length;

  const xs = shown.map((s) => s.avgAlongKmh);
  const ys = shown.map((s) => s.avgSpeedKmh);
  const w = shown.map((s) => s.distanceKm);
  const reg = linearRegression(xs, ys, w);

  // Crosswind colouring: tint each dot by its |cross| when the toggle is on, on a
  // ramp normalised to the strongest crosswind in view (floored so a near-still chart
  // doesn't exaggerate tiny side-winds). The legend mirrors the same scale.
  const colorByCross = analyticsColorByCross();
  let crossMax = 0;
  for (const s of shown) crossMax = Math.max(crossMax, Math.abs(s.avgCrossKmh));
  crossMax = Math.max(5, Math.ceil(crossMax));
  renderCrosswindLegend(colorByCross, crossMax);

  const cards = document.getElementById("analyticsCards");
  if (cards) {
    const has = shown.length > 0;
    cards.innerHTML = [
      statNum({
        value: has ? `${reg.intercept.toFixed(1)} km/h` : "—",
        label: "still-air speed",
      }),
      statNum({
        value: has ? `${reg.slope >= 0 ? "+" : ""}${reg.slope.toFixed(2)}` : "—",
        label: "km/h per km/h of tailwind",
      }),
      statNum({ value: has ? reg.r2.toFixed(2) : "—", label: "R² (wind explains)" }),
      statNum({
        value: String(shown.length),
        label: shown.length === 1 ? "segment" : "segments",
      }),
    ].join("");
  }
  const note = document.getElementById("analyticsNote");
  if (note) {
    const unresolved = inRange.filter((r) => !r.wind_resolved && !!r.track).length;
    note.textContent =
      ` ${usableRides} ride${usableRides === 1 ? "" : "s"} analysed` +
      (needGpxRides ? ` · ${needGpxRides} need full GPX` : "") +
      (unresolved ? ` · ${unresolved} not yet wind-resolved` : "") +
      (skippedRides ? ` · ${skippedRides} skipped` : "") +
      (flatOnly ? " · flat segments only" : "") +
      (trimmed ? ` · ${trimmed} over ${maxSpeed} km/h dropped` : "") +
      (crossFiltered ? ` · ${crossFiltered} outside crosswind ${crosswindLabel(cw)}` : "");
  }
  const canvas = document.getElementById("windSpeedChart") as HTMLCanvasElement | null;
  if (shown.length === 0) {
    clearChart();
    showChartMessage(
      resolved.length === 0
        ? "No wind-resolved rides in this date range."
        : needGpxRides > 0
          ? `${needGpxRides} ride${needGpxRides === 1 ? "" : "s"} in this range need full GPX for speed.`
          : "No segments match the current filters.",
    );
  } else {
    showChartMessage(null);
    if (canvas) {
      chartLayout = drawWindSpeedChart(canvas, shown, reg, {
        dotColor: colorByCross
          ? (s) => crossColor(Math.abs(s.avgCrossKmh), crossMax)
          : undefined,
      });
      reconcileSegSelection(shown);
      applyDotHighlights();
    }
  }
}

// -- Dot interaction: hover readout + tap-to-select \u2192 ride ------------------ //

/** Find the ride a segment belongs to (its uid IS the ride key). */
function rideForSeg(seg: WindSeg): RideView | null {
  return deps.getRides().find((r) => r.key === seg.uid) ?? null;
}

/** Compact one-line stats for a segment: wind it met, its crosswind, speed, length and
 *  grade. Shared by the hover tooltip and the selected card so they read identically. */
function segStatsText(seg: WindSeg): string {
  const along = seg.avgAlongKmh;
  const wind =
    along >= 0
      ? `tailwind ${along.toFixed(1)} km/h`
      : `headwind ${(-along).toFixed(1)} km/h`;
  const cross = `cross ${Math.abs(seg.avgCrossKmh).toFixed(1)}`;
  const speed = `${fmtSpeed(seg.avgSpeedKmh)} avg`;
  const dist = fmtKmDetail(seg.distanceKm);
  const parts = [wind, cross, speed, dist];
  if (Number.isFinite(seg.netGradePct)) {
    parts.push(`${seg.netGradePct >= 0 ? "+" : ""}${seg.netGradePct.toFixed(1)}% grade`);
  }
  return parts.join(" · ");
}

/** Clear any pinned dot selection and hide its card. Highlights are re-applied by the
 *  caller (or fall away on the next redraw). */
function clearSegSelection(): void {
  selectedSeg = null;
  const card = document.getElementById("analyticsSelected");
  if (card) {
    card.classList.add("hidden");
    card.innerHTML = "";
  }
}

/** Drop the selection if its segment is no longer among the drawn dots (filtered out,
 *  or the cache was rebuilt). Segment objects are reused across cheap re-filters, so a
 *  reference check is enough. */
function reconcileSegSelection(shown: WindSeg[]): void {
  if (selectedSeg && !shown.includes(selectedSeg)) clearSegSelection();
}

/** Paint the highlight overlay for the current hover/selection. The hovered dot (if
 *  any) takes the bright focus ring; otherwise the pinned one does, and either way all
 *  of that ride's sibling dots get a soft ring. */
function applyDotHighlights(): void {
  const overlay = document.getElementById("windSpeedHover") as HTMLCanvasElement | null;
  if (!overlay) return;
  const focusSeg = hoverSeg ?? selectedSeg;
  drawDotHighlights(overlay, chartLayout.dots, focusSeg?.uid ?? null, focusSeg);
}

/** Render (and reveal) the selected-segment card below the chart: the segment's stats
 *  plus the ride it belongs to as a clickable `.ms-item` that opens it in Explore. */
function renderSelectedCard(seg: WindSeg): void {
  const card = document.getElementById("analyticsSelected");
  if (!card) return;
  const ride = rideForSeg(seg);
  if (!ride) {
    clearSegSelection();
    return;
  }
  const when = escHtml(rideShortLabel(ride.date_key));
  const name = escHtml((ride.title || "Ride") + (ride.location || ""));
  const km = escHtml(ride.track_km > 0 ? fmtKm(ride.track_km) : "—");
  const spd = escHtml(ride.avg_speed_kmh && ride.avg_speed_kmh > 0 ? fmtSpeed(ride.avg_speed_kmh) : "—");
  card.innerHTML =
    `<div class="ms-mhead"><h3>Selected segment</h3>` +
    `<button class="ms-clear" title="Clear the selection">Clear</button></div>` +
    `<div class="ms-seg">${escHtml(segStatsText(seg))}</div>` +
    `<div class="ms-mhint">Open the ride this segment came from:</div>` +
    `<div class="ms-list"><div class="ms-item matched" data-key="${escHtml(ride.key)}" title="${name}">` +
    `<div class="ms-name">${name}</div>` +
    `<div class="ms-meta"><span class="ms-when">${when}</span>` +
    `<span class="ms-figs"><span class="ms-km">${km}</span><span class="ms-spd">${spd}</span></span></div>` +
    `</div></div>`;
  card.classList.remove("hidden");
}

/** Place + fill the hover tooltip near the pointer, clamped inside the chart box. */
function showTip(seg: WindSeg, px: number, py: number, boxW: number, boxH: number): void {
  const tip = document.getElementById("windSpeedTip");
  if (!tip) return;
  const ride = rideForSeg(seg);
  const name = ride ? (ride.title || "Ride") + (ride.location || "") : "Ride";
  const label = ride ? rideShortLabel(ride.date_key) : "ride";
  tip.innerHTML =
    `<b class="tip-name">${escHtml(name)}</b>` +
    `<span class="tip-when">${escHtml(label)}</span>` +
    `<span class="tip-seg">${escHtml(segStatsText(seg))}</span>`;
  tip.classList.remove("hidden");
  // Measure after content is set so the clamp uses the real size.
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = px + 14;
  let top = py + 14;
  if (left + w > boxW) left = px - w - 14;
  if (top + h > boxH) top = py - h - 14;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, top)}px`;
}

/** Hide the hover tooltip. */
function hideTip(): void {
  document.getElementById("windSpeedTip")?.classList.add("hidden");
}

/** Wire pointer interaction on the scatter canvas, once. Hover (precise pointers only)
 *  rings + describes the dot under the cursor; a click/tap pins the nearest dot \u2014
 *  showing its card and ringing all of that ride's segments \u2014 and clicking the card's
 *  ride opens it in Explore. */
function wireChartInteraction(): void {
  if (interactionWired) return;
  const canvas = document.getElementById("windSpeedChart") as HTMLCanvasElement | null;
  const card = document.getElementById("analyticsSelected");
  if (!canvas || !card) return;
  interactionWired = true;

  const at = (e: PointerEvent | MouseEvent): { x: number; y: number; w: number; h: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
  };

  canvas.addEventListener("pointermove", (e) => {
    if (!canHover()) return; // touch: tap-to-select only
    const p = at(e);
    const hit = nearestDot(chartLayout.dots, p.x, p.y, HOVER_SLACK);
    hoverSeg = hit?.seg ?? null;
    applyDotHighlights();
    if (hit) showTip(hit.seg, p.x, p.y, p.w, p.h);
    else hideTip();
  });
  canvas.addEventListener("pointerleave", () => {
    hoverSeg = null;
    hideTip();
    applyDotHighlights();
  });
  canvas.addEventListener("click", (e) => {
    const p = at(e);
    const hit = nearestDot(chartLayout.dots, p.x, p.y, TAP_SLACK);
    if (hit) {
      selectedSeg = hit.seg;
      renderSelectedCard(hit.seg);
    } else {
      clearSegSelection();
    }
    applyDotHighlights();
  });

  card.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ms-clear")) {
      clearSegSelection();
      applyDotHighlights();
      return;
    }
    const item = target.closest(".ms-item") as HTMLElement | null;
    if (item?.dataset.key) deps.openRide(item.dataset.key);
  });
}
