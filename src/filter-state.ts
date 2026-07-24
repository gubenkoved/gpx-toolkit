/**
 * GPX Toolkit — Explore-list filter model + filter bar/panel.
 *
 * The live, AND-combined filters applied to the cached rides before grouping (they
 * never touch a source — just narrow what Explore shows), their persistence, the
 * filter bar rendering (chips, date-pickers, tag popover) and the global filter
 * panel chrome (desktop dropdown / mobile bottom sheet). The predicates themselves
 * are the pure, unit-tested core in `./filter`; this module owns the mutable state
 * and its DOM.
 *
 * The `filters` object is an exported singleton — the rest of the app reads it via
 * `visibleRides(filters, …)` (an ordinary shared reference) and the click handlers
 * mutate its fields directly, then call `saveFilters()` + the injected `onChange`.
 * The module reads rides through `getRides` and re-renders the app via `onChange`,
 * never importing app state directly.
 */

import type { AppState, RideView } from "./controller";
import { closeDatePicker, openDatePicker } from "./datepicker";
import {
  discriminatingDims,
  emptyFilters,
  type Filters,
  filterActiveCount,
  filtersActive,
  type ToggleDim,
  type TriState,
} from "./filter";
import { rideDatetime } from "./parsing";
import { collectTags, tagKey } from "./tags";
import { cycleThrough, escHtml } from "./ui";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const FILTERS_KEY = "beeline_uploader.filters";

export interface FilterStateDeps {
  /** The live unified ride list (drives chip gating, tag cloud, date extents). */
  getRides: () => RideView[];
  /** Re-render the app after a filter mutation (the app's `applyState`). */
  onChange: () => void;
}

let deps: FilterStateDeps;
export function initFilterState(d: FilterStateDeps): void {
  deps = d;
  initFilterPanel();
}

const STATUS_VALUES: ReadonlyArray<Filters["status"]> = [
  "all",
  "uploaded",
  "processing",
  "not-uploaded",
];
const TRI_VALUES: ReadonlyArray<TriState> = ["any", "yes", "no"];
const DELETED_VALUES: ReadonlyArray<Filters["deleted"]> = ["any", "only", "none"];
const SOURCE_VALUES: ReadonlyArray<Filters["source"]> = ["all", "beeline", "gpx"];

/** A finite, non-negative number or null (for the distance bounds). */
function sanitizeBound(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Accept only a well-formed `"YYYY-MM-DD"` day string (else null), so malformed
 *  storage for the ingestion-date filter falls back to neutral. */
function sanitizeDay(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * Load the persisted filters, sanitizing every field against its allowed values
 * so old or malformed storage falls back to neutral rather than corrupting the
 * bar. The device string passes through — syncFilterBar already resets it to
 * "all" if that device is no longer present in the cache.
 */
function loadFilters(): Filters {
  const f = emptyFilters();
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return f;
    const o = JSON.parse(raw) as Partial<Filters>;
    if (STATUS_VALUES.includes(o.status as Filters["status"])) f.status = o.status!;
    if (TRI_VALUES.includes(o.gps as TriState)) f.gps = o.gps!;
    if (TRI_VALUES.includes(o.cached as TriState)) f.cached = o.cached!;
    if (TRI_VALUES.includes(o.wind as TriState)) f.wind = o.wind!;
    if (TRI_VALUES.includes(o.destination as TriState)) f.destination = o.destination!;
    if (TRI_VALUES.includes(o.named as TriState)) f.named = o.named!;
    if (DELETED_VALUES.includes(o.deleted as Filters["deleted"])) f.deleted = o.deleted!;
    if (SOURCE_VALUES.includes(o.source as Filters["source"])) f.source = o.source!;
    if (typeof o.device === "string") f.device = o.device;
    f.distMin = sanitizeBound(o.distMin);
    f.distMax = sanitizeBound(o.distMax);
    f.windMin = sanitizeBound(o.windMin);
    f.windMax = sanitizeBound(o.windMax);
    f.ingestedFrom = sanitizeDay(o.ingestedFrom);
    f.ingestedTo = sanitizeDay(o.ingestedTo);
    f.rideFrom = sanitizeDay(o.rideFrom);
    f.rideTo = sanitizeDay(o.rideTo);
    if (Array.isArray(o.tags)) {
      // Persisted as lowercase comparison keys; re-normalize + dedupe defensively.
      const seen = new Set<string>();
      for (const t of o.tags) {
        if (typeof t !== "string") continue;
        const k = tagKey(t);
        if (k && !seen.has(k)) seen.add(k);
      }
      f.tags = [...seen];
    }
    if (typeof o.untagged === "boolean") f.untagged = o.untagged;
  } catch {
    /* malformed JSON / storage disabled — fall back to neutral */
  }
  return f;
}

/** Persist the current filters (non-fatal if storage is unavailable). */
export function saveFilters(): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* private mode / storage disabled — non-fatal */
  }
}

// -- ingestion-date filter pickers -----------------------------------------
// The Added (ingestion-date) filter reuses the shared styled date-picker popover
// (the same one the Timeline view uses). Two triggers — earliest ("from") and
// latest ("to") — each open the picker constrained so the two bounds can't cross.
const DP_CHEV_LEFT =
  '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6"/></svg>';
const DP_CHEV_RIGHT =
  '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>';
// "Clear this date" glyph — an eraser, distinct from the panel's plain Close ✕.
const DP_CLEAR =
  '<svg class="bi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>';

/** Local `"YYYY-MM-DD"` for an ISO instant (the ingestion-date filter works in
 *  local days, matching the picker and `matchesFilters`). Null if unparseable. */
function localDay(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today as a local `"YYYY-MM-DD"`. */
function todayDay(): string {
  return localDay(new Date().toISOString())!;
}

/** A short, human label for a `"YYYY-MM-DD"` filter bound (e.g. "Jun 14, 2026"). */
function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Earliest ingestion day across the library (or today if none recorded). The
 *  selectable range runs from there up to today. */
function earliestIngestionDay(): string {
  let min: string | null = null;
  for (const r of deps.getRides()) {
    const day = localDay(r.ingested_at);
    if (day && (min === null || day < min)) min = day;
  }
  return min ?? todayDay();
}

/** Open the shared date-picker for one ingestion-date bound, keeping from ≤ to. */
export function openIngestionPicker(which: "from" | "to", anchor: HTMLElement): void {
  const earliest = earliestIngestionDay();
  const today = todayDay();
  // Constrain each side against the other so the two bounds can never cross.
  const min = which === "to" ? (filters.ingestedFrom ?? earliest) : earliest;
  const max = which === "from" ? (filters.ingestedTo ?? today) : today;
  openDatePicker({
    anchor,
    parent: document.getElementById("filterPanel") ?? document.body,
    value: which === "from" ? filters.ingestedFrom : filters.ingestedTo,
    min,
    max,
    esc: escHtml,
    icons: { chevLeft: DP_CHEV_LEFT, chevRight: DP_CHEV_RIGHT, clear: DP_CLEAR },
    onPick: (day) => {
      if (which === "from") {
        filters.ingestedFrom = day;
        if (filters.ingestedTo && filters.ingestedTo < day) filters.ingestedTo = day;
      } else {
        filters.ingestedTo = day;
        if (filters.ingestedFrom && filters.ingestedFrom > day) filters.ingestedFrom = day;
      }
      saveFilters();
      deps.onChange();
    },
    onClear: () => {
      if (which === "from") filters.ingestedFrom = null;
      else filters.ingestedTo = null;
      saveFilters();
      deps.onChange();
    },
  });
}

// -- ride-date filter pickers ----------------------------------------------
// The Ridden (ride-date) filter mirrors the Added one but works on each ride's OWN
// reference date (its `date_key`, what Explore sorts/buckets on) rather than its
// ingestion instant. Same shared picker, same from ≤ to constraint.

/** Local `"YYYY-MM-DD"` for a ride's reference `date_key`, or null if unparseable. */
function rideDay(dateKey: string): string | null {
  const d = rideDatetime(dateKey);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Earliest / latest ride reference day across the library, as local `"YYYY-MM-DD"`.
 *  Falls back to today when no ride has a parseable date. The selectable picker range
 *  runs between these two (clamped today-inclusive so a future-dated ride still fits). */
function rideDayExtent(): { earliest: string; latest: string } {
  let min: string | null = null;
  let max: string | null = null;
  for (const r of deps.getRides()) {
    const day = rideDay(r.date_key);
    if (!day) continue;
    if (min === null || day < min) min = day;
    if (max === null || day > max) max = day;
  }
  const today = todayDay();
  return {
    earliest: min ?? today,
    latest: max && max > today ? max : today,
  };
}

/** Open the shared date-picker for one ride-date bound, keeping from ≤ to. */
export function openRidePicker(which: "from" | "to", anchor: HTMLElement): void {
  const { earliest, latest } = rideDayExtent();
  // Constrain each side against the other so the two bounds can never cross.
  const min = which === "to" ? (filters.rideFrom ?? earliest) : earliest;
  const max = which === "from" ? (filters.rideTo ?? latest) : latest;
  openDatePicker({
    anchor,
    parent: document.getElementById("filterPanel") ?? document.body,
    value: which === "from" ? filters.rideFrom : filters.rideTo,
    min,
    max,
    esc: escHtml,
    icons: { chevLeft: DP_CHEV_LEFT, chevRight: DP_CHEV_RIGHT, clear: DP_CLEAR },
    onPick: (day) => {
      if (which === "from") {
        filters.rideFrom = day;
        if (filters.rideTo && filters.rideTo < day) filters.rideTo = day;
      } else {
        filters.rideTo = day;
        if (filters.rideFrom && filters.rideFrom > day) filters.rideFrom = day;
      }
      saveFilters();
      deps.onChange();
    },
    onClear: () => {
      if (which === "from") filters.rideFrom = null;
      else filters.rideTo = null;
      saveFilters();
      deps.onChange();
    },
  });
}

/** The live, AND-combined Explore filters. An exported singleton: the rest of the
 *  app reads it via `visibleRides(filters, …)` and mutates its fields in place. */
export const filters: Filters = loadFilters();

// Whether the Tags filter's in-panel multi-select popover is open.
let tagsFilterOpen = false;
// Whether the global ride-filter panel (the header funnel button's dropdown / mobile
// bottom sheet) is open. Module-scope so it survives re-renders; stays open while
// toggling chips, closes on outside click / Esc.
let filterPanelOpen = false;

/** The Strava-status chip cycles through these on each click ("all" = any). */
const STATUS_CYCLE: Filters["status"][] = ["all", "not-uploaded", "processing", "uploaded"];
/** Self-labeling text for the Strava-status chip (it can't use the tri-state ✓/✕). */
const STATUS_CHIP_LABEL: Record<Filters["status"], string> = {
  all: "Strava: any",
  "not-uploaded": "Strava: not uploaded",
  processing: "Strava: processing",
  uploaded: "Strava: uploaded",
};

/** The Source chip cycles through these on each click; "all" is the neutral (any)
 *  state. Kept in sync with `SOURCE_CHIP_LABEL`. */
const SOURCE_CYCLE: Filters["source"][] = ["all", "beeline", "gpx"];
/** Self-labeling text for the Source chip (a 3-way pick, not a tri-state ✓/✕). */
const SOURCE_CHIP_LABEL: Record<Filters["source"], string> = {
  all: "Source: any",
  beeline: "Source: Beeline",
  gpx: "Source: GPX",
};

/** Reflect the filter state in the bar: device options, chip labels, active classes. */
export function syncFilterBar(allRides: AppState["rides"]): void {
  // Source chip (any / Beeline / GPX). Only shown once rides from more than one
  // source coexist — with a single source there's nothing to narrow.
  const sourceKinds = new Set(allRides.map((r) => r.source));
  const multiSource = sourceKinds.size > 1;
  const sourceChip = document.getElementById("fSource");
  if (sourceChip) {
    sourceChip.classList.toggle("hidden", !multiSource);
    sourceChip.dataset.state = filters.source;
    sourceChip.textContent = SOURCE_CHIP_LABEL[filters.source];
    sourceChip.classList.toggle("on", filters.source !== "all");
  }
  if (!multiSource && filters.source !== "all") {
    // Drop a now-meaningless source filter so a hidden control can't keep rides hidden.
    filters.source = "all";
    saveFilters();
  }

  // Tri-state chips: glyph + active styling reflect the current state.
  const chip = (id: string, label: string, state: string, yes: string): void => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.state = state;
    el.textContent =
      state === "any" ? `${label}: any` : `${label} ${state === yes ? "✓" : "✕"}`;
    el.classList.toggle("on", state !== "any");
  };
  chip("fGps", "Route", filters.gps, "yes");
  chip("fCached", "Full GPX", filters.cached, "yes");
  chip("fWind", "Wind", filters.wind, "yes");
  chip("fDestination", "Destination", filters.destination, "yes");
  chip("fNamed", "Named", filters.named, "yes");
  chip("fDeleted", "Deleted", filters.deleted, "only");

  // Strava upload status is a 4-state cycle (any → not uploaded → processing →
  // uploaded), so it can't use the tri-state ✓/✗ helper — render its current state as
  // the chip's own label. Same pill, same accent-when-active as its peers, so it reads
  // as one of the click-through filters rather than a segmented control.
  const statusEl = document.getElementById("fStatus");
  if (statusEl) {
    statusEl.dataset.state = filters.status;
    statusEl.textContent = STATUS_CHIP_LABEL[filters.status];
    statusEl.classList.toggle("on", filters.status !== "all");
  }

  // Strava upload status is Beeline-only — a GPX import has no Strava relationship —
  // so the chip shows only when Beeline rides are present; neutralize any active one
  // so a hidden control can't keep rides hidden.
  const hasBeeline = allRides.some((r) => r.source === "beeline");
  const statusChip = document.getElementById("fStatus");
  if (statusChip) statusChip.classList.toggle("hidden", !hasBeeline);
  if (!hasBeeline && filters.status !== "all") {
    filters.status = "all";
    saveFilters();
  }

  // Binary toggle chips: a chip can only ever narrow the list when the library is
  // actually SPLIT on its dimension — some rides match the predicate AND some don't
  // (`discriminatingDims`, the pure + tested core in filter.ts). When every ride
  // shares one value (all have a route, all carry Full GPX, none are deleted, …) the
  // chip can't partition anything, so hide it and neutralize any active one so a
  // hidden control can't keep rides hidden. Gated purely on this real signal — not a
  // source/mode flag — so e.g. a GPX-only library (every ride carries its full track,
  // is never deleted) naturally drops the Route/Full GPX/Deleted chips, while Named
  // still appears if some imported names are real and some synthesized.
  const diverse = discriminatingDims(allRides);
  const gateDiverse = (id: string, key: ToggleDim): boolean => {
    const ok = diverse.has(key);
    document.getElementById(id)?.classList.toggle("hidden", !ok);
    if (!ok && filters[key] !== "any") {
      filters[key] = "any";
      saveFilters();
    }
    return ok;
  };
  gateDiverse("fGps", "gps");
  gateDiverse("fCached", "cached");
  gateDiverse("fDestination", "destination");
  gateDiverse("fNamed", "named");
  gateDiverse("fDeleted", "deleted");
  const windDiverse = gateDiverse("fWind", "wind");

  // Wind speed min/max range: a contextual companion to the Wind chip, shown ONLY
  // while filtering to resolved-wind rides ("Wind ✓"). When that's not the case the
  // bounds are meaningless, so hide the inputs and drop any active bound so a hidden
  // control can't keep rides filtered.
  const windRangeOn = windDiverse && filters.wind === "yes";
  document.getElementById("fWindRange")?.classList.toggle("hidden", !windRangeOn);
  if (!windRangeOn && (filters.windMin !== null || filters.windMax !== null)) {
    filters.windMin = null;
    filters.windMax = null;
    saveFilters();
  }
  const wMin = $<HTMLInputElement>("#fWindMin");
  const wMax = $<HTMLInputElement>("#fWindMax");
  if (wMin && document.activeElement !== wMin)
    wMin.value = filters.windMin === null ? "" : String(filters.windMin);
  if (wMax && document.activeElement !== wMax)
    wMax.value = filters.windMax === null ? "" : String(filters.windMax);

  // Distance inputs (don't clobber the field being typed into).
  const min = $<HTMLInputElement>("#fDistMin");
  const max = $<HTMLInputElement>("#fDistMax");
  if (min && document.activeElement !== min)
    min.value = filters.distMin === null ? "" : String(filters.distMin);
  if (max && document.activeElement !== max)
    max.value = filters.distMax === null ? "" : String(filters.distMax);

  // Added (ingestion-date) triggers — show the chosen day or the "from"/"to"
  // placeholder, and light the field when either bound is set.
  const ingFrom = document.getElementById("fIngFrom");
  const ingTo = document.getElementById("fIngTo");
  if (ingFrom) {
    ingFrom.textContent = filters.ingestedFrom ? dayLabel(filters.ingestedFrom) : "from";
    ingFrom.classList.toggle("placeholder", !filters.ingestedFrom);
  }
  if (ingTo) {
    ingTo.textContent = filters.ingestedTo ? dayLabel(filters.ingestedTo) : "to";
    ingTo.classList.toggle("placeholder", !filters.ingestedTo);
  }

  // Ridden (ride-date) triggers — same label/placeholder treatment as the Added field.
  const rideFromBtn = document.getElementById("fRideFrom");
  const rideToBtn = document.getElementById("fRideTo");
  if (rideFromBtn) {
    rideFromBtn.textContent = filters.rideFrom ? dayLabel(filters.rideFrom) : "from";
    rideFromBtn.classList.toggle("placeholder", !filters.rideFrom);
  }
  if (rideToBtn) {
    rideToBtn.textContent = filters.rideTo ? dayLabel(filters.rideTo) : "to";
    rideToBtn.classList.toggle("placeholder", !filters.rideTo);
  }

  // Tags filter: a single chip opening a multi-select popover (OR). Shown only once
  // some ride is tagged; gated on the real signal like the Source/Wind chips. Any
  // selected tag that no longer exists in the library is pruned so a hidden/absent
  // tag can't keep rides hidden.
  const allTags = collectTags(allRides);
  const tagKeys = new Set(allTags.map(tagKey));
  if (allRides.length > 0 && filters.tags.some((t) => !tagKeys.has(t))) {
    filters.tags = filters.tags.filter((t) => tagKeys.has(t));
    saveFilters();
  }
  // "Untagged" is offered (and can stay active) only when some ride actually has no
  // tags — otherwise it would narrow to nothing; drop a now-meaningless one like a tag.
  const someUntagged = allRides.some((r) => !r.tags.some((t) => tagKey(t)));
  if (allRides.length > 0 && filters.untagged && !someUntagged) {
    filters.untagged = false;
    saveFilters();
  }
  const tagsWrap = document.getElementById("fTagsWrap");
  if (tagsWrap) {
    tagsWrap.classList.toggle("hidden", allTags.length === 0);
    tagsWrap.classList.toggle("open", tagsFilterOpen && allTags.length > 0);
  }
  if (allTags.length === 0 && tagsFilterOpen) tagsFilterOpen = false;
  const tagsChip = document.getElementById("fTags");
  if (tagsChip) {
    const n = filters.tags.length + (filters.untagged ? 1 : 0);
    tagsChip.textContent = n === 0 ? "Tags: any" : `Tags: ${n}`;
    tagsChip.classList.toggle("on", n > 0);
    tagsChip.setAttribute("aria-expanded", String(tagsFilterOpen));
  }
  renderTagsFilterPopover(allTags, someUntagged);

  // Clear button visibility.
  $("#fClear").classList.toggle("hidden", !filtersActive(filters));

  // Header "Filters" button: badge the count of active dimensions so a closed panel
  // still signals that filtering is on, and accent the button to match.
  const n = filterActiveCount(filters);
  const count = document.getElementById("fCount");
  if (count) {
    count.textContent = String(n);
    count.toggleAttribute("hidden", n === 0);
  }
  document.getElementById("fToggle")?.classList.toggle("on", n > 0);
}

/** Render the Tags filter popover: a leading "Untagged" pseudo-tag (when some ride has
 *  no tags), one toggle chip per existing tag (`.on` when selected), plus a Clear row
 *  when any is active. Visibility tracks `tagsFilterOpen`. */
function renderTagsFilterPopover(allTags: string[], someUntagged: boolean): void {
  const pop = document.getElementById("fTagsPop");
  if (!pop) return;
  pop.classList.toggle("hidden", !tagsFilterOpen);
  if (!tagsFilterOpen) {
    pop.innerHTML = "";
    return;
  }
  const selected = new Set(filters.tags);
  // "Untagged" leads the cloud (italic, to read as a special option, not a real tag).
  const untagged = someUntagged
    ? `<button type="button" class="ftag-opt ftag-special${
        filters.untagged ? " on" : ""
      }" data-ftag-untagged="1"><span class="ftag-check"></span><span class="ftag-name">Untagged</span></button>`
    : "";
  const rows = allTags
    .map((t) => {
      const on = selected.has(tagKey(t));
      return `<button type="button" class="ftag-opt${on ? " on" : ""}" data-ftag-key="${escHtml(
        tagKey(t),
      )}"><span class="ftag-check"></span><span class="ftag-name">${escHtml(t)}</span></button>`;
    })
    .join("");
  const clear =
    filters.tags.length || filters.untagged
      ? `<button type="button" class="ftag-clear" data-ftag-clear="1">Clear tags</button>`
      : "";
  pop.innerHTML = untagged + rows + clear;
}

/** Whether the global ride-filter panel is currently open. */
export function isFilterPanelOpen(): boolean {
  return filterPanelOpen;
}

/** Toggle the Tags filter's in-panel multi-select section, then repaint the bar. */
export function toggleTagsFilter(): void {
  tagsFilterOpen = !tagsFilterOpen;
  syncFilterBar(deps.getRides());
}

/** Open or close the global ride-filter panel (the header funnel dropdown / mobile
 *  bottom sheet). Closing also collapses the nested Tags popover. */
export function setFilterPanel(open: boolean): void {
  filterPanelOpen = open;
  const panel = document.getElementById("filterPanel");
  const scrim = document.getElementById("filterScrim");
  const btn = document.getElementById("fToggle");
  panel?.classList.toggle("hidden", !open);
  panel?.classList.toggle("open", open);
  scrim?.classList.toggle("hidden", !open);
  btn?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) positionFilterPanel();
  if (!open) tagsFilterOpen = false;
  // The ingestion-date picker lives inside the panel — dismiss it when the panel closes.
  if (!open) closeDatePicker();
  // Reflect the chip/labels/Tags-popover state for the new visibility.
  syncFilterBar(deps.getRides());
}

/** Anchor the (body-level, fixed) filter panel under the Filters button on desktop;
 *  on mobile the CSS bottom-sheet rules own its position, so clear the inline anchors.
 *  Re-run on open and on window resize/scroll while open. */
function positionFilterPanel(): void {
  const panel = document.getElementById("filterPanel");
  const btn = document.getElementById("fToggle");
  if (!panel || !btn) return;
  if (window.matchMedia("(max-width: 768px)").matches) {
    panel.style.top = panel.style.right = panel.style.left = "";
    return;
  }
  const r = btn.getBoundingClientRect();
  panel.style.top = `${Math.round(r.bottom + 8)}px`;
  panel.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  panel.style.left = "auto";
}

/** Move the filter panel to <body> and add its tap-to-close scrim. The header carries
 *  `backdrop-filter`, which makes it the containing block for `position: fixed`
 *  descendants — leaving the panel inside it pins the mobile bottom sheet to the header
 *  box (top of the page) instead of the viewport. Relocating to <body> fixes that and
 *  lets the same element be a desktop dropdown (JS-anchored) or a mobile sheet (CSS). */
function initFilterPanel(): void {
  const panel = document.getElementById("filterPanel");
  if (!panel || panel.parentElement === document.body) return;
  document.body.appendChild(panel);
  if (!document.getElementById("filterScrim")) {
    const scrim = document.createElement("div");
    scrim.id = "filterScrim";
    scrim.className = "filter-scrim hidden";
    document.body.appendChild(scrim);
  }
  const reflow = (): void => {
    if (filterPanelOpen) positionFilterPanel();
  };
  window.addEventListener("resize", reflow);
  window.addEventListener("scroll", reflow, true);
}

/** Advance a tri-state chip one step on click. */
export function cycleChip(which: string): void {
  const nextTri = (s: TriState): TriState => cycleThrough(["any", "yes", "no"], s);
  if (which === "status") {
    filters.status = cycleThrough(STATUS_CYCLE, filters.status);
  } else if (which === "source") {
    filters.source = cycleThrough(SOURCE_CYCLE, filters.source);
  } else if (which === "gps") filters.gps = nextTri(filters.gps);
  else if (which === "cached") filters.cached = nextTri(filters.cached);
  else if (which === "wind") filters.wind = nextTri(filters.wind);
  else if (which === "destination") filters.destination = nextTri(filters.destination);
  else if (which === "named") filters.named = nextTri(filters.named);
  else if (which === "deleted") {
    filters.deleted = cycleThrough(["any", "only", "none"], filters.deleted);
  }
}

/** Reset every filter to its neutral (show-all) value. */
export function clearFilters(): void {
  filters.status = "all";
  filters.gps = "any";
  filters.cached = "any";
  filters.wind = "any";
  filters.windMin = null;
  filters.windMax = null;
  filters.destination = "any";
  filters.named = "any";
  filters.deleted = "any";
  filters.source = "all";
  filters.device = "all";
  filters.distMin = null;
  filters.distMax = null;
  filters.ingestedFrom = null;
  filters.ingestedTo = null;
  filters.rideFrom = null;
  filters.rideTo = null;
  filters.tags = [];
  filters.untagged = false;
}
