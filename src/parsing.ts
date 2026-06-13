/**
 * Parsing of Beeline `uiautomator` XML dumps into structured data.
 *
 * Faithful port of `beeline_uploader.parsing` (Python). Two screens matter:
 * - the Journeys *list* (cards with title / datetime / duration / distance)
 * - the ride *detail* bottom-sheet (stats + the Strava/komoot upload buttons)
 */

// Stat labels shown on the ride-detail sheet (value sits directly above each label).
export const DETAIL_STAT_LABELS = [
  "Distance",
  "Average speed",
  "Max speed",
  "Moving time",
  "Elapsed time",
  "Elevation gain",
  "Elevation loss",
] as const;

// A ride's datetime line, e.g. "Sat Jun 13 2026 at 14:22" — used as the unique key.
const DATETIME_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Za-z]+\s+\d{1,2}\s+\d{4}\s+at\s+\d{2}:\d{2}$/;
const DISTANCE_RE = /^[\d.,]+\s*km$/;
const DURATION_RE = /^(\d+:)?\d{1,2}:\d{2}$/;

// Strava/komoot button label states.
const STRAVA_PENDING = "Upload to";
const STRAVA_PROCESSING = "upload processing";
const STRAVA_UPLOADED = "View on";
const ACTION_LABELS = new Set([STRAVA_PENDING, STRAVA_PROCESSING, STRAVA_UPLOADED]);

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function boundsCx(b: Bounds): number {
  return Math.floor((b.left + b.right) / 2);
}

export function boundsCy(b: Bounds): number {
  return Math.floor((b.top + b.bottom) / 2);
}

const BOUNDS_RE = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;

export function parseBounds(value: string): Bounds | null {
  const m = BOUNDS_RE.exec(value || "");
  if (!m) return null;
  return {
    left: Number(m[1]),
    top: Number(m[2]),
    right: Number(m[3]),
    bottom: Number(m[4]),
  };
}

interface TextNode {
  text: string;
  bounds: Bounds;
}

function textNodes(xml: string): TextNode[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const nodes: TextNode[] = [];
  for (const n of Array.from(doc.getElementsByTagName("node"))) {
    const text = (n.getAttribute("text") || "").trim();
    if (!text) continue;
    const b = parseBounds(n.getAttribute("bounds") || "");
    if (b === null) continue;
    nodes.push({ text, bounds: b });
  }
  return nodes;
}

// --- Journeys list ------------------------------------------------------------

export interface RideCard {
  key: string; // the datetime string, unique per ride
  title: string;
  distance: string;
  duration: string;
  tapY: number; // vertical centre to tap to open this ride
}

export function parseJourneysList(xml: string): RideCard[] {
  const nodes = textNodes(xml);
  nodes.sort((a, b) => a.bounds.top - b.bounds.top);

  const cards: RideCard[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!DATETIME_RE.test(node.text)) continue;
    const dt = node.text;

    // Title: the text node directly above the datetime, in the SAME column.
    // We require horizontal overlap + close left edge so stray nodes like the
    // top-right "Heatmap" header button or the month header aren't picked.
    let title = "";
    for (let j = i - 1; j >= 0; j--) {
      const cand = nodes[j];
      const gap = node.bounds.top - cand.bounds.bottom;
      if (gap > 90) break;
      if (gap < 0 || DATETIME_RE.test(cand.text)) continue;
      const overlaps =
        cand.bounds.left < node.bounds.right && cand.bounds.right > node.bounds.left;
      const aligned = Math.abs(cand.bounds.left - node.bounds.left) <= 60;
      if (overlaps && aligned) {
        title = cand.text;
        break;
      }
    }

    // Duration & distance: the two stat nodes just below the datetime.
    let duration = "";
    let distance = "";
    for (let j = i + 1; j < nodes.length; j++) {
      const cand = nodes[j];
      if (cand.bounds.top - node.bounds.bottom > 160) break;
      if (DURATION_RE.test(cand.text) && !duration) duration = cand.text;
      else if (DISTANCE_RE.test(cand.text) && !distance) distance = cand.text;
    }

    cards.push({
      key: dt,
      title,
      distance,
      duration,
      tapY: boundsCy(node.bounds),
    });
  }
  return cards;
}

// --- Ride detail --------------------------------------------------------------

export type StravaStatus = "pending" | "processing" | "uploaded" | "unknown";

export interface RideDetail {
  key: string; // datetime string
  title: string;
  stats: Record<string, string>;
  stravaStatus: StravaStatus;
  stravaTap: Bounds | null;
}

export function parseRideDetail(xml: string): RideDetail {
  const nodes = textNodes(xml);
  const detail: RideDetail = {
    key: "",
    title: "",
    stats: {},
    stravaStatus: "unknown",
    stravaTap: null,
  };

  // datetime / title.
  for (const node of nodes) {
    if (DATETIME_RE.test(node.text)) {
      detail.key = node.text;
      break;
    }
  }
  if (nodes.length) {
    // Title is the topmost non-datetime text (the heading "<Name>, <City>"),
    // skipping the top app-bar "Options" control which renders above it.
    for (const node of [...nodes].sort((a, b) => a.bounds.top - b.bounds.top)) {
      if (!DATETIME_RE.test(node.text) && !TITLE_SKIP.has(node.text)) {
        detail.title = node.text;
        break;
      }
    }
  }

  // Stats: each value node sits directly above its label node.
  detail.stats = pairStats(nodes);

  // Action buttons: the topmost of the action labels is Strava.
  const actionNodes = nodes.filter((n) => ACTION_LABELS.has(n.text));
  actionNodes.sort((a, b) => a.bounds.top - b.bounds.top);
  if (actionNodes.length) {
    const strava = actionNodes[0];
    detail.stravaTap = strava.bounds;
    detail.stravaStatus = (
      {
        [STRAVA_PENDING]: "pending",
        [STRAVA_PROCESSING]: "processing",
        [STRAVA_UPLOADED]: "uploaded",
      } as Record<string, StravaStatus>
    )[strava.text] ?? "unknown";
  }
  return detail;
}

function pairStats(nodes: TextNode[]): Record<string, string> {
  const labels = new Set<string>(DETAIL_STAT_LABELS);
  const stats: Record<string, string> = {};
  for (const label of nodes) {
    if (!labels.has(label.text)) continue;
    let best: TextNode | null = null;
    let bestGap = 1e9;
    for (const value of nodes) {
      if (value === label || labels.has(value.text)) continue;
      const gap = label.bounds.top - value.bounds.bottom;
      if (gap < 0 || gap > 120) continue;
      // require horizontal overlap with the label
      if (value.bounds.right < label.bounds.left || value.bounds.left > label.bounds.right) {
        continue;
      }
      if (gap < bestGap) {
        bestGap = gap;
        best = value;
      }
    }
    if (best !== null) stats[label.text] = best.text;
  }
  return stats;
}

export function hasActionButtons(xml: string): boolean {
  return textNodes(xml).some((n) => ACTION_LABELS.has(n.text));
}

/**
 * True when a ride-detail bottom-sheet is on screen — even before it's been
 * swiped up to reveal the Strava/komoot buttons. A freshly opened detail has its
 * action buttons below the fold, so `hasActionButtons` alone misses it; we instead
 * key off the detail's stat labels (Distance / Average speed / Moving time / …),
 * which the Journeys *list* never shows. Two or more such labels means we're
 * looking at a detail, not the list. (Action buttons still count, for the revealed
 * case where the sheet may have scrolled past the stats.)
 */
export function isRideDetail(xml: string): boolean {
  const nodes = textNodes(xml);
  if (nodes.some((n) => ACTION_LABELS.has(n.text))) return true;
  const statLabels = new Set<string>(DETAIL_STAT_LABELS);
  let count = 0;
  for (const n of nodes) {
    if (statLabels.has(n.text) && ++count >= 2) return true;
  }
  return false;
}

// --- GPX export flow ----------------------------------------------------------
// Locators for the native "Options → Share/download → download GPX" path. Each
// returns the tappable Bounds (or null) so automation can drive the export screens
// the same way on a real device and the demo.

// Chrome labels that must never be chosen as a ride-detail title.
const TITLE_SKIP = new Set<string>(["Options"]);

/** First text node whose trimmed text matches `matcher` (string = exact, else regex). */
export function findNodeByText(xml: string, matcher: string | RegExp): Bounds | null {
  const test =
    typeof matcher === "string" ? (t: string) => t === matcher : (t: string) => matcher.test(t);
  for (const n of textNodes(xml)) {
    if (test(n.text)) return n.bounds;
  }
  return null;
}

/** The top-right "Options" control on the ride-detail sheet. */
export function findOptionsButton(xml: string): Bounds | null {
  return findNodeByText(xml, "Options");
}

/** The "Share/download" row in the Journey-options dialog. */
export function findShareDownloadRow(xml: string): Bounds | null {
  return findNodeByText(xml, "Share/download");
}

/** The "Share/download ridden route" action that triggers the GPX export. */
export function findRiddenRouteRow(xml: string): Bounds | null {
  return findNodeByText(xml, /ridden route/i);
}

/** True while the "Downloading GPX route" progress screen is showing. */
export function isDownloadingGpx(xml: string): boolean {
  return textNodes(xml).some((n) => /downloading gpx/i.test(n.text));
}

/** The system save dialog's "Save" button (DocumentsUI). */
export function findSaveButton(xml: string): Bounds | null {
  return findNodeByText(xml, /^save$/i);
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

/** Parse a ride key like 'Sat Jun 13 2026 at 14:22' into a Date (local), or null. */
export function rideDatetime(key: string): Date | null {
  const m = KEY_RE.exec(key);
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
 * Short, human date for a ride key, e.g. 'Jun 13, 14:22'. Used to disambiguate
 * rides that share a title in progress/status messages. Returns '' if the key
 * can't be parsed (the caller can fall back to the raw key).
 */
export function rideShortLabel(key: string): string {
  const dt = rideDatetime(key);
  if (dt === null) return "";
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${MONTHS[dt.getMonth()].slice(0, 3)} ${dt.getDate()}, ${hh}:${mm}`;
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
    return [sortKey, `Week of ${sAbbr} ${s.getDate()}, ${s.getFullYear()}`, `${sAbbr} ${s.getDate()}`];
  }
  // day
  const sortKey = `${y}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  return [sortKey, `${monAbbr} ${dt.getDate()}, ${y}`, `${monAbbr} ${dt.getDate()}`];
}

/**
 * Parse a Beeline duration string ("H:MM:SS" or "MM:SS") into whole seconds.
 * Returns 0 for empty/garbage input so callers can treat "no data" as zero time.
 */
export function parseDurationSec(s: string): number {
  if (!DURATION_RE.test((s || "").trim())) return 0;
  const parts = s.trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
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
  if (!isFinite(min) || !isFinite(max)) return "month";
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
