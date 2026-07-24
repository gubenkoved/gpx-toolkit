/**
 * GPX Toolkit — shared ride-display helpers + the "Selected rides" card list.
 *
 * The read-only rendering shared across surfaces: a ride's compact "when" (with a
 * zone tag when it differs from the viewer's), its time-breakdown tooltip, and the
 * `renderMatchedCards` block that lists rides picked on the Map view's side panel or
 * the Stats heatmap (each opens in Explore on click). Pure `(ride) => string`
 * builders over the shared format/tz vocabulary; the only app coupling is reading
 * the live ride list through an injected `getRides`.
 */

import type { RideView } from "./controller";
import { fmtKm, fmtSpeed } from "./format";
import { compareRidesByDateDesc, rideShortLabel } from "./parsing";
import { browserZone, formatOffset, localTime, offsetMinutes, zoneCity } from "./tz";
import { escHtml } from "./ui";

export interface ExploreViewDeps {
  /** The live unified ride list (used to resolve selected keys to rides). */
  getRides: () => RideView[];
}

let deps: ExploreViewDeps;
export function initExploreView(d: ExploreViewDeps): void {
  deps = d;
}

/**
 * A ride's zone tag ("+02:00 · Amsterdam") when it differs from the viewer's, else
 * empty. Distinguishes IANA zones, not just the offset: a ride sharing your current
 * offset but in another zone (Paris vs Amsterdam in summer), or your own zone across
 * a DST boundary, is still named so a time is never silently read as "wherever I am
 * now". A ride in your actual zone stays bare; an undated/zone-less ride has nothing
 * to disambiguate.
 */
function rideZoneTag(r: RideView): string {
  if (!r.start_epoch || !r.tz || r.tz === browserZone()) return "";
  return `${formatOffset(offsetMinutes(r.start_epoch, r.tz))} · ${zoneCity(r.tz)}`;
}

/** A ride's compact "when": the datetime, plus its zone tag in parens when the ride
 *  is in a different zone than the viewer. `short` picks the abbreviated date. */
export function rideWhen(r: RideView, short = false): string {
  const when = short ? rideShortLabel(r.date_key) : r.date_key;
  const tag = rideZoneTag(r);
  return tag ? `${when} (${tag})` : when;
}

/** Plain-text breakdown of a ride's time (ride-local + your local time) for a
 *  compact time's `title` tooltip. Empty unless the ride is in a different zone than
 *  the viewer (a same-zone time needs no breakdown). */
export function rideTimesTitle(r: RideView): string {
  if (!r.start_epoch || !r.tz || r.tz === browserZone()) return "";
  const rideOff = offsetMinutes(r.start_epoch, r.tz);
  const curOff = offsetMinutes(r.start_epoch, browserZone());
  const lines = [`Ride time: ${r.date_key} (${formatOffset(rideOff)} · ${zoneCity(r.tz)})`];
  if (rideOff !== curOff) {
    lines.push(
      `Your time: ${localTime(r.start_epoch, browserZone()).key} (${formatOffset(curOff)} · current)`,
    );
  }
  return lines.join("\n");
}

/** Compact distance label for a ride: prefer the measured route length, fall back to the normalized summary. */
function rideKmText(r: RideView): string {
  if (r.track_km > 0) return fmtKm(r.track_km);
  const d = r.distance_km ?? 0;
  return d > 0 ? fmtKm(d) : "—";
}

/** Average-speed label for a ride, formatted canonically (em dash when unknown). */
function rideSpeedText(r: RideView): string {
  const v = r.avg_speed_kmh ?? 0;
  return v > 0 ? fmtSpeed(v) : "—";
}

/**
 * The "Selected" block: rides chosen by a click or an area-drag, each with quick
 * stats (date · distance · avg speed). Shared by the Map view's side panel and the
 * Stats view's heatmap; clicking an entry opens it in the Explore view.
 */
export function renderMatchedCards(keys: string[]): string {
  const rides = deps.getRides();
  const matched = keys
    .map((k) => rides.find((r) => r.key === k && !r.deleted))
    .filter((r): r is RideView => !!r)
    .sort(compareRidesByDateDesc);
  if (!matched.length) return "";
  const cards = matched
    .map((r) => {
      const when = escHtml(rideWhen(r, true));
      const name = escHtml((r.title || "Ride") + (r.location || ""));
      const km = escHtml(rideKmText(r));
      const spd = escHtml(rideSpeedText(r));
      return (
        `<div class="ms-item matched" data-key="${escHtml(r.key)}" title="${name}">` +
        `<div class="ms-name">${name}</div>` +
        `<div class="ms-meta"><span class="ms-when" title="${escHtml(rideTimesTitle(r))}">${when}</span>` +
        `<span class="ms-figs"><span class="ms-km">${km}</span><span class="ms-spd">${spd}</span></span></div>` +
        `</div>`
      );
    })
    .join("");
  const noun = matched.length === 1 ? "ride" : "rides";
  return (
    `<div class="ms-matched">` +
    `<div class="ms-mhead"><h3>Selected · ${matched.length} ${noun}</h3>` +
    `<button class="ms-clear" title="Clear the selection">Clear</button></div>` +
    `<div class="ms-mhint">Click a ride below to open it in Explore.</div>` +
    `<div class="ms-list">${cards}</div></div>`
  );
}
