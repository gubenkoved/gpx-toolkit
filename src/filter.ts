/**
 * Explore-list filters: pure predicates that narrow the cached rides before the
 * UI groups them. Deliberately side-effect-free (no DOM, no device) so the logic
 * is unit-testable in isolation — the wiring + chip rendering lives in main.ts.
 *
 * Every dimension is combined with AND; a filter at its neutral value ("all" /
 * "any" / null bound) is a no-op.
 */

import type { RideView } from "./controller";
import { isSynthesizedRideName, rideDatetime } from "./parsing";
import { tagKey } from "./tags";

export type TriState = "any" | "yes" | "no";

export interface Filters {
  /** Strava upload status. "not-uploaded" = pending/unknown (eligible to upload),
   *  "processing" = an upload is mid-flight, "uploaded" = on Strava. */
  status: "all" | "uploaded" | "processing" | "not-uploaded";
  /** Route-preview (encoded track) presence. */
  gps: TriState;
  /** Full recorded GPX present in the local cache (real time + elevation). */
  cached: TriState;
  /** Historical wind resolved (Open-Meteo summary cached) for the ride. */
  wind: TriState;
  /** Inclusive average-wind-speed bounds in km/h (only meaningful with `wind: "yes"`);
   *  null means unbounded on that side. */
  windMin: number | null;
  windMax: number | null;
  /** Routed-destination presence (a ride that navigated/was tagged with a place). */
  destination: TriState;
  /** Real user-given name vs the auto time-of-day fallback ("Morning ride"). */
  named: TriState;
  /** Deletion: only deleted, hide deleted, or don't care. */
  deleted: "any" | "only" | "none";
  /** Which backend a ride came from: "all", or a specific source kind. */
  source: "all" | "beeline" | "gpx";
  /** Source device: "all", "__none__" (no device recorded), or a device model name. */
  device: string;
  /** Inclusive distance bounds in km; null means unbounded on that side. */
  distMin: number | null;
  distMax: number | null;
  /** Inclusive ingestion-date bounds as local `"YYYY-MM-DD"` day strings (the day a
   *  ride entered the library, per `RideView.ingested_at`); null = unbounded on that
   *  side. The `from` day is taken from its local 00:00:00.000, the `to` day through
   *  its local 23:59:59.999, so both picked days are fully included. */
  ingestedFrom: string | null;
  ingestedTo: string | null;
  /** Inclusive ride-date bounds as local `"YYYY-MM-DD"` day strings — the ride's OWN
   *  reference date (the `date_key` Explore sorts/buckets on), independent of when it
   *  was added to the library; null = unbounded on that side. The `from` day is taken
   *  from its local 00:00:00.000, the `to` day through its local 23:59:59.999, so both
   *  picked days are fully included. */
  rideFrom: string | null;
  rideTo: string | null;
  /** Selected tags, as lowercase comparison keys (see tags.ts). OR semantics: a ride
   *  passes when it carries ANY selected tag. Empty = no-op. */
  tags: string[];
  /** Special "untagged" pseudo-tag: when true, rides with NO tags pass too (OR-combined
   *  with `tags`). Lets the Tags filter isolate the un-tagged rides. */
  untagged: boolean;
}

/** A fresh, fully-neutral filter set (shows every ride). */
export function emptyFilters(): Filters {
  return {
    status: "all",
    gps: "any",
    cached: "any",
    wind: "any",
    windMin: null,
    windMax: null,
    destination: "any",
    named: "any",
    deleted: "any",
    source: "all",
    device: "all",
    distMin: null,
    distMax: null,
    ingestedFrom: null,
    ingestedTo: null,
    rideFrom: null,
    rideTo: null,
    tags: [],
    untagged: false,
  };
}

/**
 * Best-effort distance in km for a ride. Reads the normalized `distance_km`
 * computed once on the ingestion path (so a comma-decimal "13,5km" filters as
 * 13.5, not 135); a ride with no captured distance counts as 0.
 */
export function rideKm(r: RideView): number {
  return r.distance_km ?? 0;
}

/** Parse a `"YYYY-MM-DD"` day string into [year, month0, day], or null if malformed. */
function parseDay(day: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

/** Local-time epoch ms at the very start of a `"YYYY-MM-DD"` day (00:00:00.000). */
function dayStartMs(day: string): number | null {
  const p = parseDay(day);
  if (!p) return null;
  return new Date(p[0], p[1], p[2], 0, 0, 0, 0).getTime();
}

/** Local-time epoch ms at the very end of a `"YYYY-MM-DD"` day (23:59:59.999), so a
 *  ride ingested any time on the picked day is included. */
function dayEndMs(day: string): number | null {
  const p = parseDay(day);
  if (!p) return null;
  return new Date(p[0], p[1], p[2], 23, 59, 59, 999).getTime();
}

/** True when at least one dimension narrows the list (drives Clear + totals hint). */
export function filtersActive(f: Filters): boolean {
  return filterActiveCount(f) > 0;
}

/**
 * How many filter dimensions are currently narrowing the list (0 = neutral).
 * Distance counts once (min and/or max share the one "Distance" field group), so
 * the number matches the count of active controls a user sees in the bar. Drives
 * the mobile "Filters" toggle badge; `filtersActive` is just the `> 0` case, so
 * this stays the single source of truth for "is anything filtered".
 */
export function filterActiveCount(f: Filters): number {
  let n = 0;
  if (f.status !== "all") n++;
  if (f.gps !== "any") n++;
  if (f.cached !== "any") n++;
  if (f.wind !== "any") n++;
  if (f.windMin !== null || f.windMax !== null) n++;
  if (f.destination !== "any") n++;
  if (f.named !== "any") n++;
  if (f.deleted !== "any") n++;
  if (f.source !== "all") n++;
  if (f.device !== "all") n++;
  if (f.distMin !== null || f.distMax !== null) n++;
  if (f.ingestedFrom !== null || f.ingestedTo !== null) n++;
  if (f.rideFrom !== null || f.rideTo !== null) n++;
  if (f.tags.length > 0 || f.untagged) n++;
  return n;
}

/**
 * The binary toggle filter dimensions — each surfaced as a single tri-state chip
 * ("any" / yes / no) whose predicate splits the library in two. Distinct from the
 * range / multi-value dimensions (status, source, device, distance, dates, tags).
 */
export type ToggleDim = "gps" | "cached" | "wind" | "destination" | "named" | "deleted";

/**
 * The canonical "does this ride satisfy the positive side of the dimension?" test for
 * each toggle dimension. The SINGLE source of truth, shared by `matchesFilters` (to
 * actually filter) and `discriminatingDims` (to decide whether a chip can narrow
 * anything) — so the two can never drift apart.
 */
export const togglePredicate: Record<ToggleDim, (r: RideView) => boolean> = {
  // Route-preview (lightweight stored polyline) present.
  gps: (r) => r.track.length > 0,
  // Full recorded GPX cached locally (real time + elevation) — distinct from the
  // lightweight route preview `gps` checks.
  cached: (r) => r.gpx_cached,
  // Historical wind resolved (Open-Meteo summary cached) for the ride.
  wind: (r) => r.wind_resolved,
  // Routed-destination present (navigated/tagged with a place). The location suffix
  // doubles as the "has destination" signal.
  destination: (r) => r.location.trim().length > 0,
  // Real user-given name vs the synthesized "<time> ride" fallback.
  named: (r) => r.title.trim().length > 0 && !isSynthesizedRideName(r.title),
  // Removed from the remote account (Beeline) — never true for a local GPX import.
  deleted: (r) => r.deleted,
};

/**
 * Which toggle dimensions can actually narrow this ride list — i.e. the library is
 * SPLIT on them: at least one ride matches the predicate AND at least one doesn't.
 * A dimension where every ride shares one value (all have a route, none are deleted,
 * …) is a guaranteed no-op, so the UI hides its chip. Pure + DOM-free so the gating
 * is unit-testable; main.ts maps the returned set to chip visibility.
 */
export function discriminatingDims(rides: RideView[]): Set<ToggleDim> {
  const out = new Set<ToggleDim>();
  for (const dim of Object.keys(togglePredicate) as ToggleDim[]) {
    const pass = togglePredicate[dim];
    if (rides.some(pass) && rides.some((r) => !pass(r))) out.add(dim);
  }
  return out;
}

/** Does a ride pass every active filter? (AND across all dimensions.) */
export function matchesFilters(f: Filters, r: RideView): boolean {
  // Strava upload status. The three concrete buckets partition every ride:
  // "uploaded" (on Strava), "processing" (an upload is mid-flight), and
  // "not-uploaded" (everything else — pending/unknown — i.e. eligible to upload).
  // Deletion is orthogonal here; the separate `deleted` dimension handles it.
  if (f.status === "uploaded" && r.status !== "uploaded") return false;
  if (f.status === "processing" && r.status !== "processing") return false;
  if (f.status === "not-uploaded" && (r.status === "uploaded" || r.status === "processing"))
    return false;

  // Route-preview presence.
  const hasGps = togglePredicate.gps(r);
  if (f.gps === "yes" && !hasGps) return false;
  if (f.gps === "no" && hasGps) return false;

  // Full recorded GPX cached locally (real time + elevation) — distinct from the
  // lightweight route preview the `gps` dimension checks.
  if (f.cached === "yes" && !togglePredicate.cached(r)) return false;
  if (f.cached === "no" && togglePredicate.cached(r)) return false;

  // Historical wind resolved (Open-Meteo summary cached) for the ride.
  if (f.wind === "yes" && !togglePredicate.wind(r)) return false;
  if (f.wind === "no" && togglePredicate.wind(r)) return false;

  // Average-wind-speed band (km/h). Only resolved rides carry a wind speed, so any
  // bound excludes unresolved (and no-data) rides outright — mirroring how the
  // distance band treats a missing distance.
  if (f.windMin !== null || f.windMax !== null) {
    const ws = r.wind_speed_kmh;
    if (ws == null) return false;
    if (f.windMin !== null && ws < f.windMin) return false;
    if (f.windMax !== null && ws > f.windMax) return false;
  }

  // Routed-destination presence. The location suffix is set only when the ride
  // navigated to a place (Beeline) or was tagged with one (imported GPX), so it
  // doubles as the "has destination" signal.
  const hasDestination = togglePredicate.destination(r);
  if (f.destination === "yes" && !hasDestination) return false;
  if (f.destination === "no" && hasDestination) return false;

  // Real user-given name vs the synthesized time-of-day fallback. A ride is "named"
  // when its title is non-empty AND not one of our auto "<time> ride" names.
  const hasName = togglePredicate.named(r);
  if (f.named === "yes" && !hasName) return false;
  if (f.named === "no" && hasName) return false;

  // Deletion.
  if (f.deleted === "only" && !togglePredicate.deleted(r)) return false;
  if (f.deleted === "none" && togglePredicate.deleted(r)) return false;

  // Which backend the ride came from.
  if (f.source !== "all" && r.source !== f.source) return false;

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

  // Ingestion-date band (the day the ride entered the library). The `from` day is
  // included from its local 00:00:00.000, the `to` day through its local
  // 23:59:59.999, so both picked days are fully inside the range. A ride with no
  // recorded ingestion date (legacy import, empty `ingested_at`) can't satisfy a
  // known range, so it drops out once either bound is set.
  if (f.ingestedFrom !== null || f.ingestedTo !== null) {
    if (!r.ingested_at) return false;
    const t = Date.parse(r.ingested_at);
    if (Number.isNaN(t)) return false;
    if (f.ingestedFrom !== null) {
      const fromMs = dayStartMs(f.ingestedFrom);
      if (fromMs !== null && t < fromMs) return false;
    }
    if (f.ingestedTo !== null) {
      const toMs = dayEndMs(f.ingestedTo);
      if (toMs !== null && t > toMs) return false;
    }
  }

  // Ride-date band (the ride's OWN reference date — the `date_key` Explore sorts on,
  // not the ingestion date above). Same inclusive-day semantics as the ingestion band.
  // A ride whose date_key can't be parsed (shouldn't happen, but be safe) can't satisfy
  // a known range, so it drops out once either bound is set.
  if (f.rideFrom !== null || f.rideTo !== null) {
    const rd = rideDatetime(r.date_key);
    if (!rd) return false;
    const t = rd.getTime();
    if (f.rideFrom !== null) {
      const fromMs = dayStartMs(f.rideFrom);
      if (fromMs !== null && t < fromMs) return false;
    }
    if (f.rideTo !== null) {
      const toMs = dayEndMs(f.rideTo);
      if (toMs !== null && t > toMs) return false;
    }
  }

  // Tags (OR): once any tag (or the "untagged" pseudo-tag) is selected, a ride must
  // satisfy at least one of them — carry a selected tag, or be untagged when that's
  // chosen. Compared by lowercase key so casing never matters.
  if (f.tags.length > 0 || f.untagged) {
    const keys = r.tags.map(tagKey).filter((k) => k);
    const matchUntagged = f.untagged && keys.length === 0;
    const matchTag = f.tags.some((t) => keys.includes(t));
    if (!matchUntagged && !matchTag) return false;
  }
  return true;
}

/** Apply the active filters to a ride list (identity when nothing is filtered). */
export function visibleRides(f: Filters, rides: RideView[]): RideView[] {
  return filtersActive(f) ? rides.filter((r) => matchesFilters(f, r)) : rides;
}
