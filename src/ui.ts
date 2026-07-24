/**
 * GPX Toolkit — UI helpers (the render-layer design vocabulary).
 *
 * Pure, dependency-free builders for the shared design-language components. Each
 * helper is a `(opts) => string` that emits the *one* canonical markup + classes
 * for a component, so reuse is a function call (not copy-paste) and a CSS rename
 * touches a single place. Inputs are HTML-escaped here — safe by default; callers
 * pass raw text.
 *
 * Keep this module a leaf: no app state, no controller, no DOM access — just
 * strings. That lets it be imported anywhere (including the isolated climate /
 * timeline view modules) and unit-tested in isolation. See `src/ui.test`-style
 * snapshot tests in `tests/ui.test.ts`.
 */

/**
 * Advance `current` to the next value in a fixed cyclic order, wrapping past the
 * end. When `current` isn't in `order` (shouldn't happen) it lands on the first
 * entry. One canonical "click cycles through these states" helper so the several
 * tri-/n-state chips (Strava status, source, the yes/no/any presence filters, the
 * on/off/mixed tag chips) never re-implement the modulo dance.
 */
export function cycleThrough<T>(order: readonly T[], current: T): T {
  const i = order.indexOf(current);
  return order[(i + 1) % order.length];
}

/** Escape text / attribute values for safe interpolation into innerHTML. */
export function escHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface StatNumOpts {
  /** The large value, e.g. "219 km" or "ENE". */
  value: string;
  /** The small upper-cased label beneath the accent underline. */
  label: string;
  /** Optional muted sub-line under the label. */
  sub?: string;
  /** Optional hover title on the card. */
  title?: string;
  /** Compact variant for narrow side panels (smaller numeral). */
  small?: boolean;
}

/**
 * A single "stat numeral": a large value over a short accent underline and a small
 * tracked-out label, with an optional sub-line. Used for the lifetime totals /
 * records (Stats) and the wind-rose summary (`small`). One canonical markup so the
 * two surfaces can never drift apart again.
 */
export function statNum(o: StatNumOpts): string {
  const cls = o.small ? "stat-num stat-num--sm" : "stat-num";
  const title = o.title ? ` title="${escHtml(o.title)}"` : "";
  const sub = o.sub ? `<span class="stat-num-s">${escHtml(o.sub)}</span>` : "";
  return (
    `<div class="${cls}"${title}>` +
    `<b class="stat-num-v">${escHtml(o.value)}</b>` +
    `<span class="stat-num-l">${escHtml(o.label)}</span>${sub}</div>`
  );
}
