/**
 * Ride data types and helpers: normalized metrics and ride-key/date utilities.
 *
 * Metrics arrive as numbers straight from each source (the Beeline cloud API's SI
 * fields, a GPX track's measured geometry) and are stored as normalized numbers —
 * `null` means the figure was never read for a ride, distinct from a real zero.
 */

// --- ride cards ---------------------------------------------------------------

export interface RideCard {
  key: string; // the datetime string, unique per ride
  title: string;
  /**
   * Storage identity for this ride (the uid suffix). When omitted, the identity is
   * the `key` itself — the Beeline source's datetime IS its identity. The GPX source
   * sets a CONTENT id here so two distinct files that share a start minute stay
   * distinct rides, and re-importing the same file is idempotent (same id → same
   * ride). `key` remains the display datetime regardless, for sort/bucket/stats.
   */
  identity?: string;
  /** Distance in km; null when absent. */
  distance_km: number | null;
  /** Elapsed time in whole seconds; null when absent. */
  elapsed_sec: number | null;
  /**
   * Richer fields the source already knows at scan time — the Beeline source
   * fetches full records (track, stats, Strava status) in one request, so it can
   * persist everything from the scan rather than via later passes.
   */
  fields?: import("./store").UpsertFields;
}

export type StravaStatus = "pending" | "processing" | "uploaded" | "unknown";

/**
 * Normalized numeric ride metrics — the single source of truth for every figure
 * the app computes or displays. Populated straight from each source's numbers (the
 * Beeline API's SI fields, a GPX track's measured geometry). `null` means the
 * figure was never read for this ride — distinct from a real zero.
 */
export interface RideMetrics {
  /** Distance in kilometres. */
  distance_km: number | null;
  /** Moving time in whole seconds. */
  moving_sec: number | null;
  /** Elapsed (total) time in whole seconds. */
  elapsed_sec: number | null;
  /** Average speed in km/h. */
  avg_speed_kmh: number | null;
  /** Max speed in km/h. */
  max_speed_kmh: number | null;
  /** Elevation gain in metres. */
  elevation_gain_m: number | null;
  /** Elevation loss in metres. */
  elevation_loss_m: number | null;
}

/** A fresh RideMetrics with every figure unknown (null). */
export function blankMetrics(): RideMetrics {
  return {
    distance_km: null,
    moving_sec: null,
    elapsed_sec: null,
    avg_speed_kmh: null,
    max_speed_kmh: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
  };
}

export interface RideDetail {
  key: string; // datetime string
  title: string;
  metrics: RideMetrics;
  stravaStatus: StravaStatus;
  /** Strava activity id when known (Beeline-only); enables a "Show in Strava" link. */
  stravaActivityId?: number;
}

// --- ride identity (multi-source) --------------------------------------------

/**
 * A ride's stable, cross-source identity. The datetime `key` alone is NOT unique
 * once rides from several sources coexist (e.g. importing a Beeline ride's own
 * exported GPX yields the same minute), so the canonical map / cache / UI identity
 * is the (source, datetime) pair encoded as `${source}::${dateKey}`. The datetime
 * is kept verbatim as the suffix so it round-trips, and a record's own `key` stays
 * a plain parseable datetime for all date/month bucketing.
 *
 * The seam (RideSource) still speaks bare datetime keys in each source's own
 * namespace; only the Store, the GPX cache and the Controller (which spans
 * sources) work in uids, translating at the boundary.
 */
export function rideUid(source: string, dateKey: string): string {
  return `${source}::${dateKey}`;
}

/**
 * Split a ride uid back into its source + datetime parts. Tolerates a legacy bare
 * datetime key (no `::`) by treating it as a Beeline ride, so pre-multi-source data
 * and any datetime-only call site keep working unchanged.
 */
export function splitUid(uid: string): { source: string; dateKey: string } {
  const i = uid.indexOf("::");
  if (i === -1) return { source: "beeline", dateKey: uid };
  return { source: uid.slice(0, i), dateKey: uid.slice(i + 2) };
}

/** The datetime portion of a ride uid (or the key itself when it's already bare). */
export function uidDateKey(uid: string): string {
  return splitUid(uid).dateKey;
}

/**
 * A Strava-style time-of-day ride name from a start instant (local wall-clock).
 * Used as the fallback title for a ride that carries no real user-given name — the
 * Beeline backend stores no title (the app generates one client-side), and an
 * imported GPX may lack a `<name>`. Mirrors the naming Strava applies to uploaded
 * activities so titles read naturally.
 */
export function timeOfDayName(startMs: number): string {
  return timeOfDayNameFromHour(new Date(startMs).getHours());
}

/**
 * The time-of-day ride name for a given hour-of-day (0..23). Split out from
 * `timeOfDayName` so callers can pass the ride's LOCAL hour (from its own timezone)
 * rather than the browser's — a ride done at 8am in Tokyo is a "Morning ride" even
 * when viewed from Amsterdam. Keeping one generator keeps naming consistent.
 */
export function timeOfDayNameFromHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5) return "Night ride";
  if (h < 12) return "Morning ride";
  if (h < 17) return "Afternoon ride";
  if (h < 21) return "Evening ride";
  return "Night ride";
}

/**
 * True when `name` is one of our auto-generated time-of-day fallback names (see
 * `timeOfDayName`) rather than a real, user-given ride title. Kept next to the
 * generator so the two stay in lockstep — used to filter "named" rides.
 */
export function isSynthesizedRideName(name: string): boolean {
  return /^(Morning|Afternoon|Evening|Night) ride$/.test(name.trim());
}

// --- date helpers -------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_ABBR: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const KEY_RE = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})\s+at\s+(\d{2}):(\d{2})$/;

/** Parse a ride key like 'Sat Jun 13 2026 at 14:22' into a Date (local), or null.
 *  Tolerates a cross-source uid (`beeline::Sat Jun 13 …`) by parsing the datetime
 *  portion, so every date/bucket helper built on it accepts uids and bare keys. */
export function rideDatetime(key: string): Date | null {
  const m = KEY_RE.exec(uidDateKey(key));
  if (!m) return null;
  const month = MONTH_ABBR[m[1]];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const dt = new Date(year, month, day, hh, mm, 0, 0);
  if (dt.getFullYear() !== year || dt.getMonth() !== month || dt.getDate() !== day) {
    return null;
  }
  return dt;
}

// Weekday/month abbreviations for building a ride key from an instant. Index
// order matches Date.getDay()/getMonth(), and the month abbreviations are exactly
// the keys of MONTH_ABBR so beelineRideKey() round-trips through rideDatetime().
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBR_LIST = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Build a ride key (e.g. "Wed Jun 3 2026 at 19:04") from an epoch-millis instant,
 * the inverse of `rideDatetime`. Used by the Beeline source, whose rides carry a
 * `start` timestamp. The instant is read in the browser's LOCAL timezone —
 * matching how `rideDatetime` rebuilds a local Date — so the key round-trips and
 * all month/stats bucketing agrees.
 * Returns "" when the timestamp is not a finite number.
 */
export function beelineRideKey(startMs: number): string {
  if (!Number.isFinite(startMs)) return "";
  const dt = new Date(startMs);
  const wd = WEEKDAY_ABBR[dt.getDay()];
  const mon = MONTH_ABBR_LIST[dt.getMonth()];
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${wd} ${mon} ${dt.getDate()} ${dt.getFullYear()} at ${hh}:${mm}`;
}

/**
 * Chronological comparator for ride keys, newest first. Ride keys look like
 * "Wed Jun 3 2026 at 19:04"; comparing those as raw strings is NOT chronological
 * (weekday prefix, "3" vs "13", text month), so we compare parsed datetimes.
 * Unparseable keys fall back to a stable string compare and sort last.
 */
export function compareRideKeysDesc(a: string, b: string): number {
  const da = rideDatetime(a);
  const db = rideDatetime(b);
  if (da && db) return db.getTime() - da.getTime();
  if (da) return -1;
  if (db) return 1;
  return b.localeCompare(a);
}

/**
 * Sort comparator for rides: newest **reference date** first, with the ride **name**
 * (A→Z, case-insensitive) as the tie-breaker for rides that share a reference minute
 * — common for imported GPX files that fall back to the same upload instant, where a
 * date-only sort would otherwise be arbitrary. Reads `date_key` (the reference date),
 * never the uid; an absent name sorts as "".
 */
export function compareRidesByDateDesc(
  a: { date_key: string; title?: string; start_epoch?: number },
  b: { date_key: string; title?: string; start_epoch?: number },
): number {
  // Prefer the true INSTANT (start epoch) when both rides carry one: comparing
  // wall-clock strings across timezones is not chronological (a 23:00 ride in Tokyo
  // actually precedes a 20:00 ride in Amsterdam). Fall back to the datetime key when
  // an epoch is missing (legacy records, or a timeless imported GPX).
  const ea = a.start_epoch;
  const eb = b.start_epoch;
  if (ea && eb && ea !== eb) return eb - ea;
  const byDate = compareRideKeysDesc(a.date_key, b.date_key);
  if (byDate !== 0) return byDate;
  return (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" });
}

/**
 * Short, human date for a ride key, e.g. 'Jun 13, 2026, 14:22'. Used to
 * disambiguate rides that share a title in progress/status messages and the map
 * side panel. Returns '' if the key can't be parsed (the caller can fall back to
 * the raw key).
 */
export function rideShortLabel(key: string): string {
  const dt = rideDatetime(key);
  if (dt === null) return "";
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${MONTHS[dt.getMonth()].slice(0, 3)} ${dt.getDate()}, ${dt.getFullYear()}, ${hh}:${mm}`;
}

/**
 * A user-facing ride label: the ride's NAME with its reference date in parens,
 * e.g. "Béthune loop (Jun 13, 2026, 14:22)". The name drives the label (for an
 * imported GPX it's filename-/`<name>`-derived and user-editable); the reference
 * date is secondary context. Degrades to just the name, or just the date, or the
 * generic "ride" — but NEVER the uid/identity (a content hash must never surface).
 * `dateKey` is the ride's reference datetime (`date_key`/`rec.key`), not the uid.
 */
export function rideLabel(name: string, dateKey: string): string {
  const n = (name || "").trim();
  const when = rideShortLabel(dateKey);
  if (n && when) return `${n} (${when})`;
  return n || when || "ride";
}

/** Return [sortKey 'YYYY-MM', label 'Month YYYY'] for a ride key. */
export function rideMonth(key: string): [string, string] {
  const dt = rideDatetime(key);
  if (dt === null) return ["0000-00", "Unknown"];
  const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
  return [ym, `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`];
}

/** Time granularities the stats chart can bucket rides into. */
export type Granularity = "day" | "week" | "month" | "year";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Monday-anchored start-of-week (local) for a date. */
function startOfWeek(dt: Date): Date {
  const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d;
}

/**
 * Bucket a ride key into a chart column at the given granularity, returning
 * [sortKey, label, shortLabel]:
 *   - sortKey   sorts chronologically as a plain string.
 *   - label     full human label (tooltips).
 *   - shortLabel compact axis tick.
 * Unparseable keys fall into a single trailing "Unknown" bucket.
 */
export function bucketRide(key: string, gran: Granularity): [string, string, string] {
  const dt = rideDatetime(key);
  if (dt === null) return ["9999", "Unknown", "?"];
  const y = dt.getFullYear();
  const mon = MONTHS[dt.getMonth()];
  const monAbbr = mon.slice(0, 3);
  if (gran === "year") {
    return [`${y}`, `${y}`, `${y}`];
  }
  if (gran === "month") {
    return [`${y}-${pad2(dt.getMonth() + 1)}`, `${mon} ${y}`, `${monAbbr} '${pad2(y % 100)}`];
  }
  if (gran === "week") {
    const s = startOfWeek(dt);
    const sortKey = `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-${pad2(s.getDate())}`;
    const sAbbr = MONTHS[s.getMonth()].slice(0, 3);
    return [
      sortKey,
      `Week of ${sAbbr} ${s.getDate()}, ${s.getFullYear()}`,
      `${sAbbr} ${s.getDate()}`,
    ];
  }
  // day
  const sortKey = `${y}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  return [sortKey, `${monAbbr} ${dt.getDate()}, ${y}`, `${monAbbr} ${dt.getDate()}`];
}

/**
 * Distance-weighted average speed (km/h) over a set of rides, after fractionally
 * trimming the slowest `slowPct`% and fastest `fastPct`% of total DISTANCE.
 *
 * Rides are sorted by speed and laid out along a cumulative-distance axis; only
 * the km that fall inside the kept window [low, high] count. A ride straddling a
 * cut boundary contributes a fraction of its km AND seconds (so its speed is
 * preserved), which makes ride count irrelevant — a single ride simply keeps its
 * own speed. Returns 0 when there is no usable distance or `slowPct + fastPct >= 100`.
 */
export function trimmedSpeed(
  rides: ReadonlyArray<{ km: number; sec: number }>,
  slowPct: number,
  fastPct: number,
): number {
  const usable = rides.filter((r) => r.km > 0 && r.sec > 0);
  const total = usable.reduce((s, r) => s + r.km, 0);
  if (total <= 0) return 0;
  const low = (Math.max(0, slowPct) / 100) * total;
  const high = total - (Math.max(0, fastPct) / 100) * total;
  if (high <= low) return 0;

  const sorted = [...usable].sort((a, b) => a.km / a.sec - b.km / b.sec);
  let cursor = 0;
  let keptKm = 0;
  let keptSec = 0;
  for (const r of sorted) {
    const start = cursor;
    const end = cursor + r.km;
    cursor = end;
    const lo = Math.max(start, low);
    const hi = Math.min(end, high);
    if (hi <= lo) continue;
    const frac = (hi - lo) / r.km; // share of THIS ride inside the kept window
    keptKm += r.km * frac;
    keptSec += r.sec * frac;
  }
  return keptSec > 0 ? keptKm / (keptSec / 3600) : 0;
}

/**
 * Pick a sensible chart granularity from the span of ride dates so the chart
 * never collapses to a single lonely bar. Thresholds (on the min→max span):
 * ≤ 21 days → day, ≤ 120 days → week, ≤ ~3 years → month, otherwise year.
 */
export function autoGranularity(rides: ReadonlyArray<{ key: string }>): Granularity {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rides) {
    const dt = rideDatetime(r.key);
    if (dt === null) continue;
    const t = dt.getTime();
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "month";
  const days = (max - min) / 86_400_000;
  if (days <= 21) return "day";
  if (days <= 120) return "week";
  if (days <= 1100) return "month";
  return "year";
}

/**
 * Translate a scan preset into a cutoff Date (or null for 'all').
 * Presets: all | today | week | month | year | custom (uses `days`).
 * Intervals are rolling from now; 'today' is since local midnight.
 */
export function sinceFromPreset(preset: string, days: number | null = null): Date | null {
  const now = new Date();
  const p = (preset || "all").toLowerCase();
  if (p === "all") return null;
  if (p === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * 86400_000);
  if (p === "week") return daysAgo(7);
  if (p === "month") return daysAgo(30);
  if (p === "year") return daysAgo(365);
  if (p === "custom" && days) return daysAgo(Number(days));
  return null;
}
