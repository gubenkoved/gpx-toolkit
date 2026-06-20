/**
 * GPX Toolkit — analytics (GoatCounter).
 *
 * A deliberately tiny, privacy-friendly usage signal: "is this app used, and which
 * features?". GoatCounter is cookieless and stores no personal data — we only ever
 * send a synthetic path (a view name) or an event name, never ride data, GPS, emails
 * or tokens. The counter script itself is embedded in `index.html`; this module is
 * just the thin, fail-soft seam the app calls into.
 *
 * Two primitives, both no-ops until `gc.zgo.at/count.js` has loaded (and on
 * localhost, which the script ignores) — so they're safe to call from anywhere and
 * never throw:
 *   - `trackView(name)`  → a synthetic page-view, e.g. "/map" (per-view usage)
 *   - `trackEvent(name)` → a named event, e.g. "gpx-import" (key actions)
 */

interface GoatCounter {
  count?: (vars: { path: string; title?: string; event?: boolean }) => void;
}

function gc(): GoatCounter | undefined {
  return (globalThis as { goatcounter?: GoatCounter }).goatcounter;
}

/** Count a synthetic page-view for an SPA view (path like "/stats"). Fail-soft. */
export function trackView(name: string): void {
  try {
    gc()?.count?.({ path: `/${name}`, event: false });
  } catch {
    /* counter not loaded / blocked — analytics is never load-bearing */
  }
}

/** Count a named action event (e.g. "gpx-import", "strava-upload"). Fail-soft. */
export function trackEvent(name: string): void {
  try {
    gc()?.count?.({ path: name, event: true });
  } catch {
    /* counter not loaded / blocked — analytics is never load-bearing */
  }
}
