/**
 * Explore-list filters: pure predicates that narrow the cached rides before the
 * UI groups them. Deliberately side-effect-free (no DOM, no device) so the logic
 * is unit-testable in isolation — the wiring + chip rendering lives in main.ts.
 *
 * Every dimension is combined with AND; a filter at its neutral value ("all" /
 * "any" / null bound) is a no-op.
 */

import { isSynthesizedRideName } from "./beeline-api";
import type { RideView } from "./controller";

export type TriState = "any" | "yes" | "no";

export interface Filters {
  /** Strava upload status. "other" = processing/unknown (neither pending nor uploaded). */
  status: "all" | "pending" | "uploaded" | "other";
  /** Route-preview (encoded track) presence. */
  gps: TriState;
  /** Checked-details (stats) presence. */
  details: TriState;
  /** Routed-destination presence (Beeline rides that navigated somewhere). */
  destination: TriState;
  /** Real user-given name vs the auto time-of-day fallback ("Morning ride"). */
  named: TriState;
  /** Deletion: only deleted, hide deleted, or don't care. */
  deleted: "any" | "only" | "none";
  /** Source device: "all", "__none__" (no device recorded), or a device model name. */
  device: string;
  /** Inclusive distance bounds in km; null means unbounded on that side. */
  distMin: number | null;
  distMax: number | null;
}

/** A fresh, fully-neutral filter set (shows every ride). */
export function emptyFilters(): Filters {
  return {
    status: "all",
    gps: "any",
    details: "any",
    destination: "any",
    named: "any",
    deleted: "any",
    device: "all",
    distMin: null,
    distMax: null,
  };
}

/**
 * Best-effort distance in km for a ride. Reads the normalized `distance_km`
 * computed once at the boundary (controller.state()) via the canonical
 * locale-aware parser — never re-parses the raw string here, so a comma-decimal
 * "13,5km" filters as 13.5, not 135.
 */
export function rideKm(r: RideView): number {
  return r.distance_km;
}

/** True when at least one dimension narrows the list (drives Clear + totals hint). */
export function filtersActive(f: Filters): boolean {
  return (
    f.status !== "all" ||
    f.gps !== "any" ||
    f.details !== "any" ||
    f.destination !== "any" ||
    f.named !== "any" ||
    f.deleted !== "any" ||
    f.device !== "all" ||
    f.distMin !== null ||
    f.distMax !== null
  );
}

/** Does a ride pass every active filter? (AND across all dimensions.) */
export function matchesFilters(f: Filters, r: RideView): boolean {
  // Strava upload status. "pending" mirrors the totals' "upload pending" count
  // (a deleted ride is never pending work); "other" = processing/unknown.
  if (f.status === "pending" && !(r.status === "pending" && !r.deleted)) return false;
  if (f.status === "uploaded" && r.status !== "uploaded") return false;
  if (f.status === "other" && (r.status === "pending" || r.status === "uploaded"))
    return false;

  // Route-preview presence.
  const hasGps = r.track.length > 0;
  if (f.gps === "yes" && !hasGps) return false;
  if (f.gps === "no" && hasGps) return false;

  // Checked-details presence.
  const hasDetails = !!r.stats && Object.keys(r.stats).length > 0;
  if (f.details === "yes" && !hasDetails) return false;
  if (f.details === "no" && hasDetails) return false;

  // Routed-destination presence. The location suffix is set only when the ride
  // navigated to a place, so it doubles as the "has destination" signal.
  const hasDestination = r.location.trim().length > 0;
  if (f.destination === "yes" && !hasDestination) return false;
  if (f.destination === "no" && hasDestination) return false;

  // Real user-given name vs the synthesized time-of-day fallback. A ride is "named"
  // when its title is non-empty AND not one of our auto "<time> ride" names.
  const hasName = r.title.trim().length > 0 && !isSynthesizedRideName(r.title);
  if (f.named === "yes" && !hasName) return false;
  if (f.named === "no" && hasName) return false;

  // Deletion.
  if (f.deleted === "only" && !r.deleted) return false;
  if (f.deleted === "none" && r.deleted) return false;

  // Source device the ride was scanned from.
  if (f.device === "__none__" && r.device_model) return false;
  if (f.device !== "all" && f.device !== "__none__" && r.device_model !== f.device)
    return false;

  // Distance band (km). A ride with no parseable distance counts as 0, so it
  // drops out once a lower bound is set but survives an upper-only bound.
  if (f.distMin !== null || f.distMax !== null) {
    const km = rideKm(r);
    if (f.distMin !== null && km < f.distMin) return false;
    if (f.distMax !== null && km > f.distMax) return false;
  }
  return true;
}

/** Apply the active filters to a ride list (identity when nothing is filtered). */
export function visibleRides(f: Filters, rides: RideView[]): RideView[] {
  return filtersActive(f) ? rides.filter((r) => matchesFilters(f, r)) : rides;
}
