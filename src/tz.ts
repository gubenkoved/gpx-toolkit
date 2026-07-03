/**
 * Ride timezone helpers — turn a ride's LOCATION into its IANA zone, and its fixed
 * start INSTANT (epoch ms) into a ride-LOCAL wall-clock, hour, and UTC offset.
 *
 * A ride's identity is its push-id / content-hash; the *displayed* time is a pure
 * derivation from the immutable start instant rendered in the ride's OWN zone, so it
 * reads the same forever no matter where the viewer currently is (moving timezones
 * can never shift it — the whole point of Phase 2).
 *
 * `tz-lookup` (lat/lon → IANA name) is loaded LAZILY (dynamic import) so its ~70 KB
 * boundary table never weighs down the initial bundle — it's pulled in only when we
 * first resolve a zone (during a scan/import, already async). Crucially the OFFSET /
 * DST is computed by the browser's OWN, always-current `Intl` database from that
 * name, so daylight-saving stays correct even though the boundary table is a static
 * 2019 snapshot; only rare border changes are stale.
 */

let tzlookupFn: ((lat: number, lon: number) => string) | null = null;
let tzLoad: Promise<void> | null = null;

/** Load the tz-lookup table once (idempotent, cached). Safe to await repeatedly. */
export async function loadTz(): Promise<void> {
  if (tzlookupFn) return;
  if (!tzLoad) {
    tzLoad = import("tz-lookup")
      .then((m) => {
        tzlookupFn = (m.default ?? (m as unknown)) as (lat: number, lon: number) => string;
      })
      .catch(() => {
        /* offline / chunk load failed — callers fall back to the browser zone */
      });
  }
  await tzLoad;
}

/**
 * The IANA zone for a coordinate, or "" when unknown. Requires `loadTz()` to have
 * resolved first (otherwise "" — the caller falls back to the browser zone).
 * tz-lookup throws for NaN / out-of-range input, which we treat as unknown.
 */
export function zoneForPoint(lat: number, lon: number): string {
  if (!tzlookupFn || !Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  try {
    return tzlookupFn(lat, lon) || "";
  } catch {
    return "";
  }
}

/** The viewer's current browser IANA zone (e.g. "Europe/Amsterdam"; "UTC" fallback).
 *  Memoized: it's read per-ride on every list render and never changes within a
 *  session (a travel/OS zone change is picked up on the next reload). */
let cachedBrowserZone: string | null = null;
export function browserZone(): string {
  if (cachedBrowserZone) return cachedBrowserZone;
  try {
    cachedBrowserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    cachedBrowserZone = "UTC";
  }
  return cachedBrowserZone;
}

/** A ride's local wall-clock derived from its start instant + zone. */
export interface LocalTime {
  /** Ride-local key, e.g. "Wed Jun 3 2026 at 19:04" — parseable by `rideDatetime`. */
  key: string;
  /** Hour of day 0..23 in the zone (drives the default time-of-day ride name). */
  hour: number;
  /** UTC offset in minutes at that instant (e.g. +120 for CEST). */
  offsetMin: number;
}

// One Intl formatter per zone (formatters are costly to build; cheap to reuse).
const KEY_FMT = new Map<string, Intl.DateTimeFormat>();
const OFF_FMT = new Map<string, Intl.DateTimeFormat>();

function keyFormatter(zone: string): Intl.DateTimeFormat {
  let f = KEY_FMT.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    KEY_FMT.set(zone, f);
  }
  return f;
}

function offsetFormatter(zone: string): Intl.DateTimeFormat {
  let f = OFF_FMT.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    OFF_FMT.set(zone, f);
  }
  return f;
}

/**
 * UTC offset (minutes) of `iana` at the given instant — computed by the browser's
 * current Intl DB (so DST-correct). Reconstructs the zone's wall-clock as if it were
 * UTC and subtracts the true instant.
 */
export function offsetMinutes(epochMs: number, iana: string): number {
  const zone = iana || browserZone();
  const p = offsetFormatter(zone).formatToParts(new Date(epochMs));
  const v = (t: string): number => Number(p.find((x) => x.type === t)?.value ?? "0");
  const asUTC = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour") % 24, v("minute"), v("second"));
  return Math.round((asUTC - epochMs) / 60000);
}

/**
 * The ride-local wall-clock, hour and offset for a start instant in a zone. Falls
 * back to the browser zone when `iana` is "" (unknown location).
 */
export function localTime(epochMs: number, iana: string): LocalTime {
  const zone = iana || browserZone();
  const parts = keyFormatter(zone).formatToParts(new Date(epochMs));
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "";
  const day = String(Number(get("day"))); // "3", not "03" — matches rideDatetime's parser
  const hh = String(Number(get("hour")) % 24).padStart(2, "0");
  const mm = get("minute").padStart(2, "0");
  const key = `${get("weekday")} ${get("month")} ${day} ${get("year")} at ${hh}:${mm}`;
  return { key, hour: Number(hh), offsetMin: offsetMinutes(epochMs, zone) };
}

/** A compact, unambiguous UTC-offset label: "UTC", "UTC+2", "UTC-5:30". */
export function formatOffset(offsetMin: number): string {
  if (!offsetMin) return "UTC";
  const sign = offsetMin > 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `UTC${sign}${h}:${String(m).padStart(2, "0")}` : `UTC${sign}${h}`;
}

/** A human city from an IANA zone: last path segment, underscores → spaces
 *  ("Europe/Amsterdam" → "Amsterdam", "America/New_York" → "New York"). */
export function zoneCity(iana: string): string {
  if (!iana) return "";
  const seg = iana.split("/").pop() ?? iana;
  return seg.replace(/_/g, " ");
}
