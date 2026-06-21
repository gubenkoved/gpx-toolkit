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
  alongColor,
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
/** Slider top (percent): the Max-grade knob at this value means "off — keep any grade".
 *  Below it, segments steeper than the set value (or with unknown grade) are dropped. */
export const MAX_GRADE_OFF = 20;

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

/** Current min-speed floor (km/h) from the slider (0..40), defaulting to 0 (off).
 *  Above 0, segments slower than this are dropped — near-stops add noise, not signal. */
function analyticsMinSpeed(): number {
  const el = document.getElementById("minSpeed") as HTMLInputElement | null;
  const v = el ? parseInt(el.value, 10) : 0;
  return Number.isFinite(v) ? Math.max(0, Math.min(40, v)) : 0;
}

/** Label for the Min-speed slider's `<output>`: `any` at 0, else `≥N km/h`. Shared by
 *  the live render and the boot/restore path so wording can't drift. */
export function minSpeedLabel(kmh: number): string {
  return kmh <= 0 ? "any" : `≥${kmh} km/h`;
}

/** Current max-grade cap (percent) from the slider (0.5..MAX_GRADE_OFF). At the top it's
 *  `any` (no grade filter); below it, segments steeper than `pct` — or with unknown grade
 *  — are dropped, generalising the old binary "Flat segments only" preset. */
function analyticsMaxGrade(): { pct: number; any: boolean } {
  const el = document.getElementById("maxGrade") as HTMLInputElement | null;
  const v = el ? parseFloat(el.value) : MAX_GRADE_OFF;
  const pct = Number.isFinite(v) ? Math.max(0.5, Math.min(MAX_GRADE_OFF, v)) : MAX_GRADE_OFF;
  return { pct, any: pct >= MAX_GRADE_OFF };
}

/** Current min-grade floor (percent |grade|) from the slider (0..MAX_GRADE_OFF),
 *  defaulting to 0 (off). Above 0, segments flatter than `pct` — or with unknown grade
 *  — are dropped; pairs with the max-grade cap to keep only a band of steepness. */
function analyticsMinGrade(): { pct: number; any: boolean } {
  const el = document.getElementById("minGrade") as HTMLInputElement | null;
  const v = el ? parseFloat(el.value) : 0;
  const pct = Number.isFinite(v) ? Math.max(0, Math.min(MAX_GRADE_OFF, v)) : 0;
  return { pct, any: pct <= 0 };
}

/** Label for the Max-grade slider's `<output>`: `any` at the top, else `≤N.N%`. Always
 *  one decimal so the width doesn't jump between integer and half steps as the slider
 *  moves. Shared by the live render and the boot/restore path so wording can't drift. */
export function maxGradeLabel(pct: number): string {
  return pct >= MAX_GRADE_OFF ? "any" : `≤${pct.toFixed(1)}%`;
}

/** Label for the Min-grade slider's `<output>`: `any` at 0, else `≥N.N%`. One decimal,
 *  like `maxGradeLabel`, so the width doesn't jump as the slider moves. */
export function minGradeLabel(pct: number): string {
  return pct <= 0 ? "any" : `≥${pct.toFixed(1)}%`;
}

/** How the analysed-rides note describes the grade-band drop, depending on which
 *  bound(s) are active: only-max "over X% grade", only-min "under Y% grade", both
 *  "outside Y–X% grade". (Unknown-grade segments are folded into the same count.) */
function gradeDropLabel(
  max: { pct: number; any: boolean },
  min: { pct: number; any: boolean },
): string {
  if (!max.any && !min.any) return `outside ${min.pct.toFixed(1)}–${max.pct.toFixed(1)}% grade`;
  if (!min.any) return `under ${min.pct.toFixed(1)}% grade`;
  return `over ${max.pct.toFixed(1)}% grade`;
}

/** Whether the wind dimension is signed (head/tailwind, plotted on a 0-centred axis)
 *  or a one-sided magnitude (crosswind). */
type WindDim = "along" | "cross";
/** What colours the dots: nothing, head/tailwind, or crosswind magnitude. */
type ColorBy = "none" | WindDim;

/** Read the active button of a `.seg` segmented control by its `data-*` attribute,
 *  falling back to `def` when the control is absent. */
function activeSeg<T extends string>(id: string, attr: string, def: T): T {
  const btn = document.querySelector<HTMLElement>(`#${id} button.active[data-${attr}]`);
  const v = btn?.dataset[attr];
  return (v as T) ?? def;
}

/** The wind dimension plotted on the X axis (head/tailwind by default). */
function analyticsXAxis(): WindDim {
  return activeSeg<WindDim>("analyticsXAxis", "xaxis", "along");
}

/** The dimension dots are coloured by (off by default). */
function analyticsColorBy(): ColorBy {
  return activeSeg<ColorBy>("analyticsColorBy", "colorby", "none");
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

/** Show/hide + fill the colour legend below the chart, matching the active "Colour by"
 *  dimension. Hidden when colouring is off. For crosswind it's a calm→strong strip
 *  (azure→red) scaled to the strongest |cross| in view; for head/tailwind a diverging
 *  strip (headwind-red ← calm → tailwind-green) scaled to the strongest |along|. */
function renderColorLegend(mode: ColorBy, maxKmh: number): void {
  const el = document.getElementById("crosswindLegend");
  if (!el) return;
  if (mode === "none") {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const N = 6;
  const stops: string[] = [];
  let cap: string;
  let lo: string;
  let hi: string;
  if (mode === "cross") {
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      stops.push(`${crossColor(t * maxKmh, maxKmh)} ${Math.round(t * 100)}%`);
    }
    cap = "crosswind";
    lo = "0";
    hi = `${maxKmh} km/h`;
  } else {
    // Diverging: full headwind (−max, red) on the left → calm (grey) → full tailwind
    // (+max, green) on the right.
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      stops.push(`${alongColor((t * 2 - 1) * maxKmh, maxKmh)} ${Math.round(t * 100)}%`);
    }
    cap = "head/tailwind";
    lo = `−${maxKmh}`;
    hi = `+${maxKmh} km/h`;
  }
  el.classList.remove("hidden");
  el.innerHTML =
    `<span class="cw-cap">${cap}</span>` +
    `<span class="cw-end">${lo}</span>` +
    `<span class="cw-bar" style="background:linear-gradient(90deg, ${stops.join(", ")})"></span>` +
    `<span class="cw-end">${hi}</span>`;
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

/** Labels for the two wind-dependent KPI cards (intercept + slope), adapted to which
 *  wind dimension is on the X axis. Shared by the live render and the placeholder so
 *  the wording can't drift. "Still-air" / "calm-air" name the X=0 condition (no wind
 *  along the axis); the slope names a km/h of that axis' wind. */
function kpiLabels(x: WindDim): { intercept: string; slope: string } {
  return x === "cross"
    ? { intercept: "calm-air speed", slope: "km/h per km/h of crosswind" }
    : { intercept: "still-air speed", slope: "km/h per km/h of tailwind" };
}

/** Blank the KPI cards to placeholders (used while the confirm gate is shown — no
 *  analysis has run yet, so there are no numbers to report). */
function setAnalyticsCardsPlaceholder(): void {
  const cards = document.getElementById("analyticsCards");
  if (!cards) return;
  const lab = kpiLabels(analyticsXAxis());
  cards.innerHTML = [
    statNum({ value: "—", label: lab.intercept }),
    statNum({ value: "—", label: lab.slope }),
    statNum({ value: "—", label: "R² (wind explains)" }),
    statNum({ value: "—", label: "segments" }),
  ].join("");
}

/** Context-aware gating of the "Colour by" segmented control: the option whose
 *  dimension is already on the X axis is meaningless (you'd colour by the axis you're
 *  plotting), so it's hidden. If that option was the active one, fall the colour over
 *  to the OTHER wind dimension so flipping X keeps a useful cross-dimension view alive
 *  rather than silently going monochrome. Returns nothing; mutates the DOM. */
export function syncColorByGating(): void {
  const x = analyticsXAxis();
  const seg = document.getElementById("analyticsColorBy");
  if (!seg) return;
  const opposite: WindDim = x === "along" ? "cross" : "along";
  for (const btn of seg.querySelectorAll<HTMLElement>("button[data-colorby]")) {
    const dim = btn.dataset.colorby;
    const clash = dim === x; // colouring by the axis dimension
    btn.classList.toggle("hidden", clash);
    if (clash && btn.classList.contains("active")) {
      // The hidden option was selected — move the selection to the opposite dimension.
      btn.classList.remove("active");
      const next = seg.querySelector<HTMLElement>(`button[data-colorby="${opposite}"]`);
      next?.classList.add("active");
    }
  }
}

/** The confirm-to-run gate: a centred card stating exactly how many rides the current
 *  window will analyse (it live-updates as the slider moves) plus the "Analyse" button
 *  that arms the sweep. When some rides in range still need wind resolved or full GPX
 *  fetched, those actions live here too — right where the user is already looking — so
 *  there's no separate button row cluttering the view. Shown until the user opts in. */
function renderAnalyticsGate(rideCount: number, unresolved: number, needGpx: number): void {
  const el = document.getElementById("analyticsChartMsg");
  if (!el) return;
  const ridesWord = rideCount === 1 ? "ride" : "rides";
  // Prep actions appear only when they can act on rides in range, with the affected
  // count in the label. They reuse the delegated #analyticsResolve / #analyticsFetchGpx
  // handlers (no per-render wiring), so the IDs must stay stable.
  const actions: string[] = [];
  if (unresolved) {
    actions.push(
      `<button type="button" class="ghost small" id="analyticsResolve">` +
        `Resolve wind for ${unresolved} ${unresolved === 1 ? "ride" : "rides"}</button>`,
    );
  }
  if (needGpx) {
    actions.push(
      `<button type="button" class="ghost small" id="analyticsFetchGpx">` +
        `Fetch full GPX for ${needGpx} ${needGpx === 1 ? "ride" : "rides"}</button>`,
    );
  }
  el.innerHTML =
    `<span class="cm-card cm-gate">` +
    `<b class="cm-head">Analyse wind vs speed</b>` +
    `<span class="cm-detail"><b>${rideCount}</b> ${ridesWord} in the selected date window</span>` +
    `<button type="button" class="primary small cm-go" id="analyticsRun"${
      rideCount === 0 ? " disabled" : ""
    }>Analyse ${rideCount} ${ridesWord}</button>` +
    (actions.length
      ? `<span class="cm-detail cm-or">or first prepare the data:</span>` +
        `<span class="cm-actions">${actions.join("")}</span>`
      : "") +
    `</span>`;
  el.style.display = "flex";
  document.getElementById("analyticsRun")?.addEventListener("click", () => {
    analyticsArmed = true;
    void mountWindSpeedView();
  });
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

  const grade = analyticsMaxGrade();
  const minGrade = analyticsMinGrade();
  const minSpeed = analyticsMinSpeed();
  const cw = analyticsCrosswind();
  let usableRides = 0;
  let needGpxRides = 0;
  let untimedRides = 0;
  let skippedRides = 0;
  let crossFiltered = 0;
  let gradeFiltered = 0;
  let speedMinFiltered = 0;
  const segs: WindSeg[] = [];
  // Whether either grade bound is active — if so, segments with unknown grade are
  // dropped too, since we can't place them in the band.
  const gradeBounded = !grade.any || !minGrade.any;
  for (const r of resolved) {
    const entry = segCacheByUid.get(segKey(r));
    if (!entry) continue;
    // A `needgpx` ride lacks the per-point timestamps speed needs. The remedy differs
    // by source: a Beeline ride can still DOWNLOAD its full timed GPX, but a GPX-source
    // ride imported from an untimed file already IS the GPX — there's nothing to fetch,
    // it just has no `<time>`. Count them apart so the note doesn't tell you to fetch
    // something that can't be fetched.
    if (entry.status === "needgpx") {
      if (r.source === "gpx") untimedRides++;
      else needGpxRides++;
    }
    if (entry.status === "skip") skippedRides++;
    if (entry.status !== "ok") continue;
    usableRides++;
    for (const seg of entry.segs) {
      // Grade band filter (on |net grade|): once either bound is set, drop segments
      // steeper than Max grade, flatter than Min grade, or with unknown grade. At the
      // extremes ("any") each bound is off, so the pair acts as a steepness band.
      if (gradeBounded) {
        const g = Math.abs(seg.netGradePct);
        if (
          !Number.isFinite(seg.netGradePct) ||
          (!grade.any && g > grade.pct) ||
          (!minGrade.any && g < minGrade.pct)
        ) {
          gradeFiltered++;
          continue;
        }
      }
      // Min-speed filter: above 0, drop crawling/near-stop stretches (noise, not wind
      // signal). The Max-speed cap is applied as a post-step below.
      if (minSpeed > 0 && seg.avgSpeedKmh < minSpeed) {
        speedMinFiltered++;
        continue;
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

  // Reflect the grade knobs into their outputs + accent fill (cheap post-filters, like
  // the speed pair below).
  const gradeOut = document.getElementById("maxGradeOut") as HTMLOutputElement | null;
  if (gradeOut) gradeOut.value = maxGradeLabel(grade.pct);
  const gradeEl = document.getElementById("maxGrade") as HTMLInputElement | null;
  if (gradeEl) setSliderFill(gradeEl);
  const minGradeOut = document.getElementById("minGradeOut") as HTMLOutputElement | null;
  if (minGradeOut) minGradeOut.value = minGradeLabel(minGrade.pct);
  const minGradeEl = document.getElementById("minGrade") as HTMLInputElement | null;
  if (minGradeEl) setSliderFill(minGradeEl);

  // Drop physically-impossible segments above the Max-speed cap (GPS glitches).
  const maxSpeed = analyticsMaxSpeed();
  const out = document.getElementById("maxSpeedOut") as HTMLOutputElement | null;
  if (out) out.value = `${maxSpeed} km/h`;
  const maxEl = document.getElementById("maxSpeed") as HTMLInputElement | null;
  if (maxEl) setSliderFill(maxEl);
  const minSpeedOut = document.getElementById("minSpeedOut") as HTMLOutputElement | null;
  if (minSpeedOut) minSpeedOut.value = minSpeedLabel(minSpeed);
  const minSpeedEl = document.getElementById("minSpeed") as HTMLInputElement | null;
  if (minSpeedEl) setSliderFill(minSpeedEl);
  const keep = speedCapIndices(
    segs.map((s) => s.avgSpeedKmh),
    maxSpeed,
  );
  const shown = keep.map((i) => segs[i]);
  const trimmed = segs.length - shown.length;

  // Keep the "Colour by" options in step with the X axis (the X dimension can't be a
  // colour), then read both. X picks the plotted wind dimension; head/tailwind stays
  // 0-centred (signed), crosswind is a one-sided magnitude.
  syncColorByGating();
  const xAxis = analyticsXAxis();
  const xSigned = xAxis === "along";
  const xValue = (s: WindSeg): number =>
    xAxis === "cross" ? Math.abs(s.avgCrossKmh) : s.avgAlongKmh;

  const xs = shown.map(xValue);
  const ys = shown.map((s) => s.avgSpeedKmh);
  const w = shown.map((s) => s.distanceKm);
  const reg = linearRegression(xs, ys, w);

  // Dot colouring: tint each dot by the chosen wind dimension's magnitude, on a ramp
  // normalised to the strongest value in view (floored so a near-still chart doesn't
  // exaggerate tiny winds). The legend mirrors the same scale.
  const colorBy = analyticsColorBy();
  let crossMax = 0;
  let alongMax = 0;
  for (const s of shown) {
    crossMax = Math.max(crossMax, Math.abs(s.avgCrossKmh));
    alongMax = Math.max(alongMax, Math.abs(s.avgAlongKmh));
  }
  crossMax = Math.max(5, Math.ceil(crossMax));
  alongMax = Math.max(5, Math.ceil(alongMax));
  const legendMax = colorBy === "cross" ? crossMax : alongMax;
  renderColorLegend(colorBy, legendMax);
  const dotColor =
    colorBy === "cross"
      ? (s: WindSeg) => crossColor(Math.abs(s.avgCrossKmh), crossMax)
      : colorBy === "along"
        ? (s: WindSeg) => alongColor(s.avgAlongKmh, alongMax)
        : undefined;

  const cards = document.getElementById("analyticsCards");
  if (cards) {
    const has = shown.length > 0;
    const lab = kpiLabels(xAxis);
    cards.innerHTML = [
      statNum({
        value: has ? `${reg.intercept.toFixed(1)} km/h` : "—",
        label: lab.intercept,
      }),
      statNum({
        value: has ? `${reg.slope >= 0 ? "+" : ""}${reg.slope.toFixed(2)}` : "—",
        label: lab.slope,
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
      (untimedRides ? ` · ${untimedRides} GPX without timestamps` : "") +
      (unresolved ? ` · ${unresolved} not yet wind-resolved` : "") +
      (skippedRides ? ` · ${skippedRides} skipped` : "") +
      (gradeFiltered ? ` · ${gradeFiltered} ${gradeDropLabel(grade, minGrade)} dropped` : "") +
      (speedMinFiltered ? ` · ${speedMinFiltered} under ${minSpeed} km/h dropped` : "") +
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
          : untimedRides > 0
            ? `${untimedRides} ride${untimedRides === 1 ? "" : "s"} here have GPX without timestamps, so speed can't be measured.`
            : "No segments match the current filters.",
    );
  } else {
    showChartMessage(null);
    if (canvas) {
      chartLayout = drawWindSpeedChart(canvas, shown, reg, {
        dotColor,
        xValue,
        xSigned,
        xCaption: xSigned
          ? "← headwind        tailwind →   (km/h)"
          : "crosswind →   (km/h)",
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
