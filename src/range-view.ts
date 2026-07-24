/**
 * GPX Toolkit — the shared date-range slider (Map / Stats / Wind-Speed windows).
 *
 * One parameterized implementation drives all three dual-thumb date sliders (keyed
 * by `RangeView`): the whole-library **bounds** (day-snapped min/max of all dated
 * rides) and the user's current **selection** within them. Selections are stored as
 * local day-start timestamps and the slider works in whole-day INDICES so stepping
 * is exact and DST-safe; the "to" edge always covers its whole day when filtering.
 *
 * The module is a leaf over an injected seam: it reads rides via `getRides`, re-mounts
 * the affected view via `remount`, and (for the Wind-Speed window, which persists across
 * reloads) calls `onAnalyticsChange` so main can save it into the analytics prefs. The
 * remembered analytics window is handed in at `init` and adopted on the first refresh.
 */

import type { RideView } from "./controller";
import { type DateRange, dateRange, filterRidesByRange } from "./mapview";

// Bounds vs. range:
//   *Bounds* = the full day-snapped span of all dated rides (slider min/max).
//   *Range*  = the user's current selection within those bounds.
// Rides with an unparseable date are never hidden (see filterRidesByRange).
export type RangeView = "map" | "stats" | "analytics";

export interface RangeViewDeps {
  /** The live unified ride list (its date span drives the bounds). */
  getRides: () => RideView[];
  /** Re-mount the given view after its range changed (no re-fit during live drags). */
  remount: (which: RangeView, fit: boolean) => void;
  /** Persist the Wind/Speed window (it's remembered across reloads, unlike Map/Stats). */
  onAnalyticsChange: () => void;
  /** The remembered Wind/Speed window from prefs, adopted on the first refresh. */
  initialAnalyticsRange: DateRange | null;
}

let deps: RangeViewDeps;
export function initRangeView(d: RangeViewDeps): void {
  deps = d;
  savedAnalyticsRange = d.initialAnalyticsRange;
}

const DAY_MS = 86_400_000;

// The double-headed arrow glyph on each slider's "All" reset. Matches the Timeline
// bar's `ICONS.allRange` so all four date-range sliders read as one control.
const ALL_RANGE_ICON =
  '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/></svg>';

// Per-view range state: the current selection (`sel`) and the last-seen bounds of
// the whole library (`bounds`), used to reconcile the selection when rides are
// added/removed. One record keyed by view, so the accessors below are a single lookup.
type RangeState = { sel: DateRange | null; bounds: DateRange | null };
const ranges: Record<RangeView, RangeState> = {
  map: { sel: null, bounds: null },
  stats: { sel: null, bounds: null },
  analytics: { sel: null, bounds: null },
};

// The remembered date window, adopted on the first range computation after load
// (then cleared so later refreshes reconcile normally). Seeded by `init`.
let savedAnalyticsRange: DateRange | null = null;

const startOfDayMs = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const endOfDayMs = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
/** Local midnight `n` days after `ms` — uses the calendar, so it's DST-safe. */
const addDays = (ms: number, n: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
/** Number of whole days spanned by the bounds (slider max index). */
const dayCount = (bounds: DateRange): number =>
  Math.round((startOfDayMs(bounds.maxMs) - startOfDayMs(bounds.minMs)) / DAY_MS);
/** Whole-day index (0-based) of a timestamp within the bounds. */
const dayIndex = (bounds: DateRange, ms: number): number =>
  Math.round((startOfDayMs(ms) - startOfDayMs(bounds.minMs)) / DAY_MS);

/** The full selection (both edges at day-start) covering an entire bounds span. */
const fullRange = (bounds: DateRange): DateRange => ({
  minMs: startOfDayMs(bounds.minMs),
  maxMs: startOfDayMs(bounds.maxMs),
});

/** Keep only rides within a day-granular selection (the end day is fully included). */
export const ridesInRange = (rides: RideView[], sel: DateRange): RideView[] =>
  filterRidesByRange(rides, sel.minMs, endOfDayMs(sel.maxMs));

/**
 * Reconcile a remembered selection with a freshly computed full span. First time
 * (no prior selection) the slider spans everything. Afterwards, a handle that sat
 * exactly on an old extreme is kept pinned to the new extreme (so newly-scanned
 * rides extend the visible window instead of being filtered out); any other handle
 * is just clamped into the new bounds. Edges are kept on day-start boundaries.
 */
function reconcileRange(
  sel: DateRange | null,
  oldBounds: DateRange | null,
  bounds: DateRange,
): DateRange {
  const lo = startOfDayMs(bounds.minMs);
  const hi = startOfDayMs(bounds.maxMs);
  if (!sel || !oldBounds) return { minMs: lo, maxMs: hi };
  const oldHi = startOfDayMs(oldBounds.maxMs);
  let from = sel.minMs <= startOfDayMs(oldBounds.minMs) ? lo : startOfDayMs(sel.minMs);
  let to = sel.maxMs >= oldHi ? hi : startOfDayMs(sel.maxMs);
  from = Math.min(Math.max(from, lo), hi);
  to = Math.min(Math.max(to, lo), hi);
  if (from > to) return { minMs: lo, maxMs: hi };
  return { minMs: from, maxMs: to };
}

/** Recompute a view's bounds from the current rides and reconcile its selection. */
export function refreshRange(which: RangeView): void {
  const bounds = dateRange(deps.getRides());
  const st = ranges[which];
  if (which === "analytics" && st.sel === null && savedAnalyticsRange && bounds) {
    // First computation after load: adopt the remembered window, clamped into the
    // live bounds (not via reconcileRange, which would discard a selection when there
    // were no prior bounds). One-shot — clear it so later refreshes reconcile.
    st.sel = clampRangeToBounds(savedAnalyticsRange, bounds);
    savedAnalyticsRange = null;
  } else {
    st.sel = bounds ? reconcileRange(st.sel, st.bounds, bounds) : null;
  }
  st.bounds = bounds;
}

/** Clamp a remembered selection to day-start boundaries within the live bounds. */
function clampRangeToBounds(sel: DateRange, bounds: DateRange): DateRange {
  const lo = startOfDayMs(bounds.minMs);
  const hi = startOfDayMs(bounds.maxMs);
  let from = Math.min(Math.max(startOfDayMs(sel.minMs), lo), hi);
  let to = Math.min(Math.max(startOfDayMs(sel.maxMs), lo), hi);
  if (from > to) {
    from = lo;
    to = hi;
  }
  return { minMs: from, maxMs: to };
}

export const rangeOf = (which: RangeView): DateRange | null => ranges[which].sel;
const boundsOf = (which: RangeView): DateRange | null => ranges[which].bounds;

/**
 * A compact "Jun 1, 2026 – Jun 5, 2026" label for a view's selection when it's
 * narrower than the full span, else `null` (the caller shows nothing / just its
 * own filter flag). Encapsulates the day-index math so callers don't touch internals.
 */
export function rangeWindowLabel(which: RangeView): string | null {
  const bounds = boundsOf(which);
  const sel = rangeOf(which);
  const narrowed =
    !!bounds &&
    !!sel &&
    dayCount(bounds) > 0 &&
    (dayIndex(bounds, sel.minMs) > 0 || dayIndex(bounds, sel.maxMs) < dayCount(bounds));
  if (!narrowed || !sel) return null;
  return `${fmtDay(sel.minMs)} – ${fmtDay(sel.maxMs)}`;
}
/** The DOM id of a view's range-slider host. Ids follow the `${which}Filter`
 *  convention (mapFilter / statsFilter / analyticsFilter). */
const filterHostId = (which: RangeView): string => `${which}Filter`;

/** Store a new selection for a view. */
function assignRange(which: RangeView, next: DateRange): void {
  ranges[which].sel = next;
  // Wind/Speed window is remembered across reloads.
  if (which === "analytics") deps.onAnalyticsChange();
}

/** Re-mount a view after its range changed (no re-fit during live drags). */
function remountRange(which: RangeView, fit: boolean): void {
  deps.remount(which, fit);
}

/** Compact local day label for a slider edge, e.g. "Jun 1, 2026". */
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Markup for one view's dual-range date slider (two overlaid day-index inputs). */
function rangeControlHtml(which: RangeView, bounds: DateRange, sel: DateRange): string {
  const n = dayCount(bounds);
  const dis = n <= 0 ? " disabled" : ""; // single day → nothing to slide
  const input = (edge: "lo" | "hi", idx: number): string =>
    `<input type="range" class="rf-${edge}" id="${which}${edge === "lo" ? "Lo" : "Hi"}" ` +
    `data-range="${which}" data-edge="${edge}" min="0" max="${n}" step="1" value="${idx}"${dis} ` +
    `aria-label="${edge === "lo" ? "Earliest" : "Latest"} date">`;
  return (
    `<span class="rf-edge" id="${which}From"></span>` +
    `<div class="rf-track">${input("lo", dayIndex(bounds, sel.minMs))}${input("hi", dayIndex(bounds, sel.maxMs))}` +
    `<div class="rf-window" data-rangewin="${which}" aria-hidden="true" title="Drag to move the selected dates"></div></div>` +
    `<span class="rf-edge" id="${which}To"></span>` +
    // The "All" reset is fused with a caret that drops quick relative windows
    // (last week / month / year), each ending at the latest ride in the span.
    `<span class="rf-presets">` +
    `<button class="rf-reset" data-rangereset="${which}" title="Show every date">${ALL_RANGE_ICON}<span>All</span></button>` +
    `<button class="rf-caret" data-rangepresets="${which}" aria-haspopup="true" aria-expanded="false" ` +
    `aria-label="Quick date ranges" title="Quick date ranges"></button>` +
    `<div class="splitmenu" role="menu">` +
    `<button data-rangepreset="week" data-rangewhich="${which}" role="menuitem">Last week</button>` +
    `<button data-rangepreset="month" data-rangewhich="${which}" role="menuitem">Last month</button>` +
    `<button data-rangepreset="year" data-rangewhich="${which}" role="menuitem">Last year</button>` +
    `</div></span>`
  );
}

/** Refresh the edge date labels and the accent range-fill for a view. */
function updateRangeLabels(which: RangeView): void {
  const sel = rangeOf(which);
  const bounds = boundsOf(which);
  if (!sel) return;
  const from = document.getElementById(`${which}From`);
  const to = document.getElementById(`${which}To`);
  if (from) from.textContent = fmtDay(sel.minMs);
  if (to) to.textContent = fmtDay(sel.maxMs);
  // Paint the selected span: percentages of the day axis drive the track ::after.
  const host = document.getElementById(filterHostId(which));
  const track = host?.querySelector<HTMLElement>(".rf-track");
  if (track && bounds) {
    const n = dayCount(bounds);
    const lo = n > 0 ? dayIndex(bounds, sel.minMs) / n : 0;
    const hi = n > 0 ? dayIndex(bounds, sel.maxMs) / n : 1;
    track.style.setProperty("--rf-lo", String(lo));
    track.style.setProperty("--rf-hi", String(hi));
    track.classList.toggle("rf-empty", n <= 0); // single day → nothing to fill
  }
}

/**
 * Reflect a view's range state in its slider control. The slider DOM is only
 * rebuilt when the underlying span changes (tracked via `data-bounds`), never
 * mid-drag — so dragging a handle just updates values + labels in place.
 */
export function syncRangeControl(which: RangeView): void {
  const host = document.getElementById(filterHostId(which));
  if (!host) return;
  const bounds = boundsOf(which);
  const sel = rangeOf(which);
  if (!bounds || !sel) {
    host.classList.add("hidden");
    host.innerHTML = "";
    host.dataset.bounds = "";
    return;
  }
  host.classList.remove("hidden");
  const boundsKey = `${bounds.minMs}-${bounds.maxMs}`;
  if (host.dataset.bounds !== boundsKey) {
    host.dataset.bounds = boundsKey;
    host.innerHTML = rangeControlHtml(which, bounds, sel);
  } else {
    const lo = document.getElementById(`${which}Lo`) as HTMLInputElement | null;
    const hi = document.getElementById(`${which}Hi`) as HTMLInputElement | null;
    if (lo) lo.value = String(dayIndex(bounds, sel.minMs));
    if (hi) hi.value = String(dayIndex(bounds, sel.maxMs));
  }
  updateRangeLabels(which);
}

/** Live drag of either handle: clamp so from ≤ to, store, relabel, redraw (no refit). */
export function onRangeInput(which: RangeView, el: HTMLInputElement): void {
  const bounds = boundsOf(which);
  if (!bounds) return;
  const lo = document.getElementById(`${which}Lo`) as HTMLInputElement | null;
  const hi = document.getElementById(`${which}Hi`) as HTMLInputElement | null;
  if (!lo || !hi) return;
  let loIdx = Number(lo.value);
  let hiIdx = Number(hi.value);
  if (el.dataset.edge === "lo" && loIdx > hiIdx) {
    loIdx = hiIdx;
    lo.value = String(loIdx);
  } else if (el.dataset.edge === "hi" && hiIdx < loIdx) {
    hiIdx = loIdx;
    hi.value = String(hiIdx);
  }
  const next: DateRange = {
    minMs: addDays(bounds.minMs, loIdx),
    maxMs: addDays(bounds.minMs, hiIdx),
  };
  assignRange(which, next);
  updateRangeLabels(which);
  remountRange(which, false);
}

/**
 * Drag the selected window (the span between the two thumbs) to slide the whole
 * selection without resizing it — both edges move by the same whole-day delta,
 * clamped so the fixed-size window stays within bounds. Uses pointer capture so
 * the drag keeps tracking past the slider edges (and works on touch).
 */
export function onWindowDrag(which: RangeView, win: HTMLElement, e: PointerEvent): void {
  const bounds = boundsOf(which);
  const track = win.parentElement;
  const lo = document.getElementById(`${which}Lo`) as HTMLInputElement | null;
  const hi = document.getElementById(`${which}Hi`) as HTMLInputElement | null;
  if (!bounds || !track || !lo || !hi) return;
  const n = dayCount(bounds);
  const usablePx = track.getBoundingClientRect().width - 15; // track width minus one thumb
  if (n <= 0 || usablePx <= 0) return;

  const startX = e.clientX;
  const startLo = Number(lo.value);
  const span = Number(hi.value) - startLo; // held constant for the whole drag
  win.classList.add("dragging");
  try {
    win.setPointerCapture(e.pointerId);
  } catch {
    // Older engines may reject capture; mouse drag still works without it.
  }

  const move = (ev: PointerEvent): void => {
    const dIdx = Math.round(((ev.clientX - startX) / usablePx) * n);
    const newLo = Math.max(0, Math.min(startLo + dIdx, n - span));
    lo.value = String(newLo);
    hi.value = String(newLo + span);
    const next: DateRange = {
      minMs: addDays(bounds.minMs, newLo),
      maxMs: addDays(bounds.minMs, newLo + span),
    };
    assignRange(which, next);
    updateRangeLabels(which);
    remountRange(which, false);
    ev.preventDefault();
  };
  const end = (): void => {
    win.classList.remove("dragging");
    win.removeEventListener("pointermove", move);
    win.removeEventListener("pointerup", end);
    win.removeEventListener("pointercancel", end);
  };
  win.addEventListener("pointermove", move);
  win.addEventListener("pointerup", end);
  win.addEventListener("pointercancel", end);
  e.preventDefault();
}

/** Reset a view's selection back to its full span and re-frame the map. */
export function resetRange(which: RangeView): void {
  const bounds = boundsOf(which);
  if (!bounds) return;
  assignRange(which, fullRange(bounds));
  remountRange(which, true);
}

/**
 * Apply a quick relative window ending at the latest ride in the span — "last week"
 * (7 days), "last month" (one calendar month) or "last year" (one calendar year),
 * clamped to the loaded bounds so a short history just resolves to "all".
 */
export function applyRangePreset(which: RangeView, kind: "week" | "month" | "year"): void {
  const bounds = boundsOf(which);
  if (!bounds) return;
  const to = startOfDayMs(bounds.maxMs);
  const start = new Date(to); // step back from the most recent day
  if (kind === "week") start.setDate(start.getDate() - 7);
  else if (kind === "month") start.setMonth(start.getMonth() - 1);
  else start.setFullYear(start.getFullYear() - 1);
  const from = Math.max(startOfDayMs(start.getTime()), startOfDayMs(bounds.minMs));
  assignRange(which, { minMs: from, maxMs: to });
  remountRange(which, true);
}

/** Close any open "quick ranges" dropdown (the caret menu beside "All"). */
export function closeRangePresets(): void {
  document.querySelectorAll<HTMLElement>(".rf-presets.open").forEach((el) => {
    el.classList.remove("open");
    el.querySelector(".rf-caret")?.setAttribute("aria-expanded", "false");
  });
}
