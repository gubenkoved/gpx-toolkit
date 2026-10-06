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

/**
 * A responsive loader over a pane (`.map-main`, `.freq-main`, …) while heavy work
 * is sliced through idle callbacks: a ring + one line of text, removed with
 * `text = null`. The pane must be `position: relative`. Better a visible loader
 * than a frozen page — see src/idle.ts.
 */
const loaderHide = new WeakMap<HTMLElement, number>();
export function paneLoader(host: HTMLElement | null, text: string | null): void {
  if (!host) return;
  const pending = loaderHide.get(host);
  if (pending) {
    clearTimeout(pending);
    loaderHide.delete(host);
  }
  let el = host.querySelector<HTMLElement>(":scope > .pane-loader");
  if (text === null) {
    // Hide after a short grace: a build that immediately follows (a fit → moveend
    // rebuild) reuses the element, so the ring keeps spinning instead of restarting.
    if (el)
      loaderHide.set(
        host,
        window.setTimeout(() => el?.remove(), 160),
      );
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "pane-loader";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML = `<span class="spin"></span><span class="pane-loader-text"></span>`;
    host.appendChild(el);
  }
  const t = el.querySelector<HTMLElement>(".pane-loader-text");
  if (t && t.textContent !== text) t.textContent = text;
}

/**
 * Wire a panel's collapse chevron: the button toggles `cls` on `target`, mirrors the
 * state on `aria-expanded` + its title, remembers it under `key`, and reports each
 * change. The chevron glyph is injected once. Returns the current collapsed state.
 */
export function initCollapse(
  btn: HTMLElement | null,
  target: HTMLElement | null,
  key: string,
  titles: { open: string; closed: string },
  cls = "collapsed",
  onChange?: (collapsed: boolean) => void,
): boolean {
  if (!btn || !target) return false;
  if (!btn.querySelector("svg")) {
    btn.insertAdjacentHTML(
      "afterbegin",
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 15 6-6 6 6"/></svg>',
    );
  }
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(key) === "1";
  } catch {
    /* non-fatal */
  }
  const apply = (): void => {
    target.classList.toggle(cls, collapsed);
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.title = collapsed ? titles.closed : titles.open;
    btn.setAttribute("aria-label", collapsed ? titles.closed : titles.open);
  };
  apply();
  btn.addEventListener("click", () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem(key, collapsed ? "1" : "0");
    } catch {
      /* non-fatal */
    }
    apply();
    onChange?.(collapsed);
  });
  return collapsed;
}
