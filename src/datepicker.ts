/**
 * Shared styled date-picker popover — a small month calendar that floats above (or
 * below) a trigger button, replacing the unstylable native `<input type="date">`.
 *
 * One canonical implementation for every day-picker in the app: the Timeline view's
 * "jump to a day" control (a sparse set of days that actually have data) and the
 * Explore filter panel's ingestion-date from/to pickers (a continuous min..max
 * range). The popover owns its own DOM, positioning, and dismissal listeners, so a
 * caller just hands it an anchor + bounds + an `onPick` callback.
 *
 * Only one picker is open at a time (a single shared popover). Days are plain
 * `"YYYY-MM-DD"` strings throughout (timezone-free calendar days).
 */

const DOW = ["M", "T", "W", "T", "F", "S", "S"];

export interface DatePickerIcons {
  /** Inline SVG for the previous-month arrow. */
  chevLeft: string;
  /** Inline SVG for the next-month arrow. */
  chevRight: string;
  /** Inline SVG for the "clear this date" button (only used when `onClear` is given). */
  clear?: string;
}

export interface DatePickerOptions {
  /** The trigger element to position the popover against. */
  anchor: HTMLElement;
  /** Element to append the popover (and mobile backdrop) into. */
  parent: HTMLElement;
  /** Currently-selected day (`"YYYY-MM-DD"`), highlighted; opens on its month. */
  value?: string | null;
  /** Earliest selectable day (`"YYYY-MM-DD"`); days before it are disabled. */
  min?: string | null;
  /** Latest selectable day (`"YYYY-MM-DD"`); days after it are disabled. */
  max?: string | null;
  /** Optional sparse allow-list: when given, only these days are selectable (others
   *  are shown disabled) — for the Timeline's "days with data". Omit for a plain
   *  continuous min..max range. */
  allowedDays?: Set<string>;
  /** HTML escaper (injected so this module stays DOM-vocabulary-only). */
  esc: (s: string) => string;
  /** Chevron icons for the month nav. */
  icons: DatePickerIcons;
  /** Viewport width (px) at/below which the popover becomes a centered modal with a
   *  backdrop instead of being anchored to the trigger (default 768). */
  modalBelow?: number;
  /** Called with the picked `"YYYY-MM-DD"` day; the popover closes first. */
  onPick: (day: string) => void;
  /** Optional: clears just this bound (not the whole filter set). When provided AND the
   *  picker opened with a `value`, a small clear button appears beside the month nav;
   *  clicking it closes the popover and invokes this. */
  onClear?: () => void;
}

/** ISO `"YYYY-MM-DD"` for a year + 0-based month + day. */
function isoDay(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Zoom level of the picker: pick a day, a month (of a year), or a year (of a decade).
 *  Clicking the header label zooms OUT (days→months→years); picking a cell zooms back IN. */
type DpView = "days" | "months" | "years";

interface OpenState {
  opts: DatePickerOptions;
  year: number;
  month: number; // 0-based
  view: DpView;
}

let state: OpenState | null = null;
let outside: ((e: PointerEvent) => void) | null = null;
let keydown: ((e: KeyboardEvent) => void) | null = null;

/** Open (or replace) the shared date-picker against `opts.anchor`. */
export function openDatePicker(opts: DatePickerOptions): void {
  // Base the visible month on the selected value, else the max bound, else today.
  const base = opts.value || opts.max || new Date().toISOString().slice(0, 10);
  const [y, m] = base.split("-").map(Number);
  state = { opts, year: y, month: m - 1, view: "days" };
  render();
  // Defer wiring dismiss listeners so the opening click doesn't immediately close it.
  setTimeout(() => {
    if (!state) return;
    outside = (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("#dpPop") && t !== state?.opts.anchor && !state?.opts.anchor.contains(t))
        closeDatePicker();
    };
    keydown = (e) => {
      if (e.key === "Escape" && state) {
        e.stopPropagation();
        closeDatePicker();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown, true);
  }, 0);
}

/** Close the shared date-picker (no-op when nothing is open). */
export function closeDatePicker(): void {
  state = null;
  document.getElementById("dpPop")?.remove();
  document.getElementById("dpBack")?.remove();
  if (outside) document.removeEventListener("pointerdown", outside, true);
  if (keydown) document.removeEventListener("keydown", keydown, true);
  outside = keydown = null;
}

/** Shift the visible period by `dir` (±1) within the [min,max] bounds, re-render.
 *  The unit depends on the zoom level: a month in days view, a year in months view,
 *  a decade in years view. */
function navStep(dir: number): void {
  if (!state) return;
  if (state.view === "days") {
    const d = new Date(Date.UTC(state.year, state.month + dir, 1));
    state.year = d.getUTCFullYear();
    state.month = d.getUTCMonth();
  } else if (state.view === "months") {
    state.year += dir;
  } else {
    state.year += dir * 10;
  }
  render();
}

/** Zoom out one level (day grid → month grid → year grid). No-op past the top. */
function zoomOut(): void {
  if (!state) return;
  if (state.view === "days") state.view = "months";
  else if (state.view === "months") state.view = "years";
  render();
}

/** True below the modal breakpoint — render centered over a backdrop, not anchored. */
function isModal(o: DatePickerOptions): boolean {
  return window.matchMedia(`(max-width: ${o.modalBelow ?? 768}px)`).matches;
}

/** Build the head + grid HTML for the day view (pick a day in the visible month). */
function buildDays(): { head: string; grid: string } {
  const { opts, year, month } = state!;
  const minDay = opts.min ?? null;
  const maxDay = opts.max ?? null;
  const curMonth = `${year}-${String(month + 1).padStart(2, "0")}`;
  const prevOff = minDay != null && curMonth <= minDay.slice(0, 7);
  const nextOff = maxDay != null && curMonth >= maxDay.slice(0, 7);
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const firstDow = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);

  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<span class="dp-cell empty"></span>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoDay(year, month, d);
    const outOfRange = (minDay != null && iso < minDay) || (maxDay != null && iso > maxDay);
    const disallowed = opts.allowedDays != null && !opts.allowedDays.has(iso);
    const out = outOfRange || disallowed;
    const sel = iso === opts.value;
    const cls = `dp-cell${sel ? " sel" : ""}${iso === today ? " today" : ""}`;
    cells += out
      ? `<span class="dp-cell out">${d}</span>`
      : `<button class="${cls}" data-dp="pick" data-day="${iso}">${d}</button>`;
  }
  const head = headHtml(opts.esc(monthLabel), "months", "Pick a month", prevOff, nextOff);
  const grid =
    `<div class="dp-grid dp-dow">${DOW.map((d) => `<span class="dp-cell dow">${d}</span>`).join("")}</div>` +
    `<div class="dp-grid">${cells}</div>`;
  return { head, grid };
}

/** Build the head + grid HTML for the month view (pick a month in the visible year). */
function buildMonths(): { head: string; grid: string } {
  const { opts, year } = state!;
  const minDay = opts.min ?? null;
  const maxDay = opts.max ?? null;
  const minYear = minDay != null ? Number(minDay.slice(0, 4)) : null;
  const maxYear = maxDay != null ? Number(maxDay.slice(0, 4)) : null;
  const prevOff = minYear != null && year <= minYear;
  const nextOff = maxYear != null && year >= maxYear;
  const selMonth = opts.value && Number(opts.value.slice(0, 4)) === year ? Number(opts.value.slice(5, 7)) - 1 : -1;
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();

  let cells = "";
  for (let m0 = 0; m0 < 12; m0++) {
    // A month is selectable when any of its days fall within [min,max].
    const monthStart = isoDay(year, m0, 1);
    const monthEnd = isoDay(year, m0, new Date(Date.UTC(year, m0 + 1, 0)).getUTCDate());
    const out = (minDay != null && monthEnd < minDay) || (maxDay != null && monthStart > maxDay);
    const label = new Date(Date.UTC(year, m0, 1)).toLocaleDateString(undefined, {
      month: "short",
      timeZone: "UTC",
    });
    const sel = m0 === selMonth;
    const isNow = year === curY && m0 === curM;
    const cls = `dp-cell dp-myc${sel ? " sel" : ""}${isNow ? " today" : ""}`;
    cells += out
      ? `<span class="dp-cell dp-myc out">${opts.esc(label)}</span>`
      : `<button class="${cls}" data-dp="month" data-m0="${m0}">${opts.esc(label)}</button>`;
  }
  const head = headHtml(String(year), "years", "Pick a year", prevOff, nextOff);
  return { head, grid: `<div class="dp-mygrid">${cells}</div>` };
}

/** Build the head + grid HTML for the year view (pick a year in the visible decade). */
function buildYears(): { head: string; grid: string } {
  const { opts, year } = state!;
  const minDay = opts.min ?? null;
  const maxDay = opts.max ?? null;
  const minYear = minDay != null ? Number(minDay.slice(0, 4)) : null;
  const maxYear = maxDay != null ? Number(maxDay.slice(0, 4)) : null;
  const decadeStart = Math.floor(year / 10) * 10;
  const start = decadeStart - 1; // one pad year on each side → a 12-cell grid
  const prevOff = minYear != null && start <= minYear;
  const nextOff = maxYear != null && start + 11 >= maxYear;
  const selYear = opts.value ? Number(opts.value.slice(0, 4)) : -1;
  const curY = new Date().getFullYear();

  let cells = "";
  for (let i = 0; i < 12; i++) {
    const y = start + i;
    const out = (minYear != null && y < minYear) || (maxYear != null && y > maxYear);
    const sel = y === selYear;
    const isNow = y === curY;
    const muted = y < decadeStart || y > decadeStart + 9; // pad years dim slightly
    const cls = `dp-cell dp-myc${sel ? " sel" : ""}${isNow ? " today" : ""}${muted ? " dp-pad" : ""}`;
    cells += out
      ? `<span class="dp-cell dp-myc out${muted ? " dp-pad" : ""}">${y}</span>`
      : `<button class="${cls}" data-dp="year" data-y="${y}">${y}</button>`;
  }
  const head = headHtml(`${decadeStart}\u2013${decadeStart + 9}`, null, "", prevOff, nextOff);
  return { head, grid: `<div class="dp-mygrid">${cells}</div>` };
}

/** Header markup shared by every view: a (optionally zoomable) title + prev/next nav.
 *  `zoomTo` null renders a plain, non-zoomable title (the top-level year view). */
function headHtml(
  title: string,
  zoomTo: DpView | null,
  zoomLabel: string,
  prevOff: boolean,
  nextOff: boolean,
): string {
  const o = state!.opts;
  const titleEl =
    zoomTo != null
      ? `<button class="dp-month dp-zoom" data-dp="zoom" aria-label="${zoomLabel}" title="${zoomLabel}">${title}</button>`
      : `<span class="dp-month">${title}</span>`;
  // A clear-this-bound button, shown only when this picker can clear AND currently
  // holds a value — lets the user drop just this date without touching other filters.
  const clearEl =
    o.onClear && o.value && o.icons.clear
      ? `<button class="dp-arrow dp-clear" data-dp="clear" aria-label="Clear date" title="Clear date">${o.icons.clear}</button>`
      : "";
  return (
    `<div class="dp-head">${titleEl}<span class="dp-nav">` +
    clearEl +
    `<button class="dp-arrow" data-dp="nav" data-dir="-1" ${prevOff ? "disabled" : ""} aria-label="Previous">${o.icons.chevLeft}</button>` +
    `<button class="dp-arrow" data-dp="nav" data-dir="1" ${nextOff ? "disabled" : ""} aria-label="Next">${o.icons.chevRight}</button>` +
    `</span></div>`
  );
}

/** Build/refresh the popover for the current view in `state` and position it. */
function render(): void {
  if (!state) return;
  const { opts, view } = state;
  const built = view === "days" ? buildDays() : view === "months" ? buildMonths() : buildYears();

  let pop = document.getElementById("dpPop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "dpPop";
    pop.className = "dp";
    pop.addEventListener("click", onPopClick);
    opts.parent.appendChild(pop);
  }
  pop.innerHTML = built.head + built.grid;

  // Phones: a centered modal over a backdrop (CSS centers it); clear any inline
  // coords left from a desktop render so they don't fight the centering rule.
  if (isModal(opts)) {
    pop.classList.add("dp--modal");
    pop.style.left = pop.style.top = "";
    pop.style.visibility = "visible";
    if (!document.getElementById("dpBack")) {
      const back = document.createElement("div");
      back.id = "dpBack";
      back.className = "dp-back";
      back.addEventListener("pointerdown", () => closeDatePicker());
      opts.parent.appendChild(back);
    }
    return;
  }
  pop.classList.remove("dp--modal");
  document.getElementById("dpBack")?.remove();

  // Desktop: position above the trigger; clamp within the viewport; drop below when
  // there isn't room above.
  pop.style.visibility = "hidden";
  pop.style.left = "0px";
  const a = opts.anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
  let top = a.top - h - 8;
  if (top < 8) top = a.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = "visible";
}

/** Delegated click handler for the popover (zoom out, period nav, month/year/day pick). */
function onPopClick(e: Event): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-dp]");
  if (!el || !state) return;
  // Keep the click inside the picker: nav/zoom re-render (`pop.innerHTML = …`), which
  // DETACHES the clicked button before the event reaches the app's document-level
  // click handler — there a now-orphaned target reads as "outside the filter panel"
  // and would close the panel (and this picker) out from under the navigation. Stop
  // propagation so picker-internal clicks never reach that handler.
  e.stopPropagation();
  const kind = el.dataset.dp;
  if (kind === "nav") {
    navStep(Number(el.dataset.dir));
  } else if (kind === "zoom") {
    zoomOut();
  } else if (kind === "clear") {
    // Drop just this bound; the popover closes first, like a pick.
    const cb = state.opts.onClear;
    closeDatePicker();
    cb?.();
  } else if (kind === "month") {
    // Zoom back in to the picked month's day grid.
    state.month = Number(el.dataset.m0);
    state.view = "days";
    render();
  } else if (kind === "year") {
    // Zoom in from the year grid to that year's month grid.
    state.year = Number(el.dataset.y);
    state.view = "months";
    render();
  } else if (kind === "pick" && el.dataset.day) {
    const day = el.dataset.day;
    const cb = state.opts.onPick;
    closeDatePicker();
    cb(day);
  }
}
