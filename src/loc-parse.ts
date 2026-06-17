/**
 * Google Location History parser — turns a raw export document into the normalized
 * `LocImport` (a flat, time-ordered stream of `LocRecord`s plus rich provenance and
 * Google's precomputed profile).
 *
 * Only the **on-device Timeline** export is implemented for the first cut — that is
 * the format current Google phones produce (`semanticSegments` + `rawSignals` +
 * `userLocationProfile`), and the one we profiled exhaustively (see the plan). The
 * two legacy Takeout shapes are detected and rejected with a friendly message so a
 * future importer can slot in without reshaping callers.
 *
 * Field names here are pinned to the REAL export, not assumed: coordinates arrive as
 * `"52.5200°, 13.4050°"` strings on segments but as a capital-`LatLng` on raw fixes;
 * `timelinePath` points carry no timezone-offset field (we read the offset embedded
 * in their own ISO string). Anything we cannot parse is counted in `skipped` rather
 * than throwing, so one malformed point never loses an entire import.
 */

import type {
  AccClass,
  ActType,
  FixSource,
  LocImport,
  LocKind,
  LocProfile,
  LocRecord,
  LocSource,
  LocSourceDef,
  VisitType,
} from "./loc-model";

/** Which export shape a document is. `null` when it matches none we recognize. */
export type DetectedFormat = "on-device" | "records" | "semantic" | null;

/**
 * Classify a parsed export document by its top-level shape. Cheap structural sniff —
 * no deep validation; the chosen parser does the real work.
 */
export function detectFormat(doc: unknown): DetectedFormat {
  if (!doc || typeof doc !== "object") return null;
  const o = doc as Record<string, unknown>;
  if (Array.isArray(o.semanticSegments) || Array.isArray(o.rawSignals)) return "on-device";
  if (Array.isArray(o.locations)) return "records";
  if (Array.isArray(o.timelineObjects)) return "semantic";
  return null;
}

/**
 * Parse a Google coordinate string into `[lat, lon]` decimal degrees, or `null` when
 * it is not a usable pair. Handles the on-device `"52.5200°, 13.4050°"` form: strip
 * the degree marks, split on the comma, then parse each half. Google always emits
 * dot-decimal coordinates, so we deliberately do NOT route this through the locale
 * number parser (which treats a comma as a possible decimal separator) — the comma
 * here is the lat/lon separator.
 */
export function parseLatLng(s: unknown): [number, number] | null {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(/°/g, "").trim();
  const parts = cleaned.split(",");
  if (parts.length !== 2) return null;
  const lat = Number.parseFloat(parts[0].trim());
  const lon = Number.parseFloat(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

/** Parse an ISO-8601 timestamp to epoch ms, or `null` when unusable. */
function parseTime(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Bucket a real accuracy in metres into its trust class. */
function accClassForMeters(m: number): AccClass {
  if (m < 10) return "exact";
  if (m < 50) return "fine";
  if (m < 200) return "coarse";
  return "broad";
}

const VISIT_TYPES = new Set<string>([
  "HOME",
  "WORK",
  "INFERRED_HOME",
  "INFERRED_WORK",
  "SEARCHED_ADDRESS",
  "ALIASED_LOCATION",
  "UNKNOWN",
]);
const ACT_TYPES = new Set<string>([
  "CYCLING",
  "WALKING",
  "RUNNING",
  "IN_PASSENGER_VEHICLE",
  "IN_VEHICLE",
  "IN_BUS",
  "IN_TRAIN",
  "IN_SUBWAY",
  "IN_TRAM",
  "IN_FERRY",
  "MOTORCYCLING",
  "FLYING",
  "SKIING",
  "SAILING",
  "UNKNOWN_ACTIVITY_TYPE",
]);
const FIX_SOURCES = new Set<string>(["GPS", "WIFI", "WIFI_ONLY", "CELL", "UNKNOWN"]);

function asVisitType(s: unknown): VisitType {
  return typeof s === "string" && VISIT_TYPES.has(s) ? (s as VisitType) : "UNKNOWN";
}
function asActType(s: unknown): ActType {
  return typeof s === "string" && ACT_TYPES.has(s) ? (s as ActType) : "UNKNOWN_ACTIVITY_TYPE";
}
function asFixSource(s: unknown): FixSource {
  return typeof s === "string" && FIX_SOURCES.has(s) ? (s as FixSource) : "UNKNOWN";
}

/** Options for an import (mostly to keep tests deterministic). */
export interface ParseOptions {
  /** When this import ran, epoch ms. Defaults to `Date.now()`. */
  importedAt?: number;
  /** Stable id for this import batch. Defaults to `loc-${importedAt}`. */
  importId?: string;
}

/**
 * Allocates one `LocSourceDef` per distinct Google origin in an import, so records
 * can reference a compact `sourceId`. For the on-device format there is no device id
 * and a single import, so origins are the only thing that distinguishes sources.
 */
class SourceRegistry {
  private readonly defs: LocSourceDef[] = [];
  private readonly byOrigin = new Map<LocSource, number>();

  constructor(
    private readonly format: LocSourceDef["format"],
    private readonly importId: string,
    private readonly importedAt: number,
  ) {}

  /** Id for a given Google origin, creating its def on first use. */
  idFor(origin: LocSource, label: string): number {
    const existing = this.byOrigin.get(origin);
    if (existing !== undefined) return existing;
    const id = this.defs.length;
    this.defs.push({
      id,
      format: this.format,
      origin,
      importId: this.importId,
      importedAt: this.importedAt,
      label,
      count: 0,
    });
    this.byOrigin.set(origin, id);
    return id;
  }

  /** Count one record against a source id. */
  tally(id: number): void {
    const def = this.defs[id];
    if (def) def.count = (def.count ?? 0) + 1;
  }

  /** The defs that were actually used, in id order. */
  list(): LocSourceDef[] {
    return this.defs;
  }
}

/**
 * Parse an on-device Timeline export. Walks `semanticSegments` (paths, visits,
 * activities) and the recent `rawSignals.position` fixes into one normalized stream,
 * and lifts Google's `userLocationProfile` into a `LocProfile`. `timelineMemory`
 * segments and `wifiScan` raw signals are intentionally ignored (low value / privacy).
 */
export function parseOnDevice(doc: unknown, opts: ParseOptions = {}): LocImport {
  const importedAt = opts.importedAt ?? Date.now();
  const importId = opts.importId ?? `loc-${importedAt}`;
  const reg = new SourceRegistry("on-device", importId, importedAt);

  const records: LocRecord[] = [];
  const counts: Record<LocKind, number> = { path: 0, visit: 0, move: 0, fix: 0 };
  let skipped = 0;

  const push = (rec: LocRecord): void => {
    records.push(rec);
    counts[rec.kind]++;
    reg.tally(rec.sourceId);
  };

  const o = (doc ?? {}) as Record<string, unknown>;
  const segments = Array.isArray(o.semanticSegments) ? o.semanticSegments : [];
  const pathSrc = reg.idFor("seg.path", "Path samples");
  const visitSrc = reg.idFor("seg.visit", "Place visits");
  const moveSrc = reg.idFor("seg.activity", "Activity segments");

  for (const segRaw of segments) {
    if (!segRaw || typeof segRaw !== "object") continue;
    const seg = segRaw as Record<string, unknown>;
    const segStart = parseTime(seg.startTime);
    const segEnd = parseTime(seg.endTime);

    // -- timelinePath: a list of sparse breadcrumb samples ---------------------
    if (Array.isArray(seg.timelinePath)) {
      for (const ptRaw of seg.timelinePath) {
        const pt = (ptRaw ?? {}) as Record<string, unknown>;
        const ll = parseLatLng(pt.point);
        const t = parseTime(pt.time);
        if (!ll || t === null) {
          skipped++;
          continue;
        }
        push({ kind: "path", sourceId: pathSrc, t, lat: ll[0], lon: ll[1], accClass: "approx" });
      }
      continue;
    }

    // -- visit: a stay at an inferred place ------------------------------------
    if (seg.visit && typeof seg.visit === "object") {
      const visit = seg.visit as Record<string, unknown>;
      const cand = (visit.topCandidate ?? {}) as Record<string, unknown>;
      const place = (cand.placeLocation ?? {}) as Record<string, unknown>;
      const ll = parseLatLng(place.latLng);
      if (!ll || segStart === null) {
        skipped++;
        continue;
      }
      push({
        kind: "visit",
        sourceId: visitSrc,
        t: segStart,
        endT: segEnd ?? undefined,
        lat: ll[0],
        lon: ll[1],
        accClass: "derived",
        semanticType: asVisitType(cand.semanticType),
        placeId: typeof cand.placeId === "string" ? cand.placeId : undefined,
        prob: typeof cand.probability === "number" ? cand.probability : undefined,
      });
      continue;
    }

    // -- activity: a travel segment (start → end, distance, mode) ---------------
    if (seg.activity && typeof seg.activity === "object") {
      const act = seg.activity as Record<string, unknown>;
      const start = (act.start ?? {}) as Record<string, unknown>;
      const end = (act.end ?? {}) as Record<string, unknown>;
      const cand = (act.topCandidate ?? {}) as Record<string, unknown>;
      const a = parseLatLng(start.latLng);
      const b = parseLatLng(end.latLng);
      if (!a || segStart === null) {
        skipped++;
        continue;
      }
      push({
        kind: "move",
        sourceId: moveSrc,
        t: segStart,
        endT: segEnd ?? undefined,
        lat: a[0],
        lon: a[1],
        lat2: b ? b[0] : undefined,
        lon2: b ? b[1] : undefined,
        accClass: "derived",
        actType: asActType(cand.type),
        distanceM: typeof act.distanceMeters === "number" ? act.distanceMeters : undefined,
        prob: typeof cand.probability === "number" ? cand.probability : undefined,
      });
      continue;
    }

    // timelineMemory and any unknown segment shape are ignored (not skipped — they
    // are not point data we can place on the map).
  }

  // -- rawSignals.position: recent, real-accuracy fixes ------------------------
  const signals = Array.isArray(o.rawSignals) ? o.rawSignals : [];
  let fixSrc = -1;
  for (const sigRaw of signals) {
    if (!sigRaw || typeof sigRaw !== "object") continue;
    const sig = sigRaw as Record<string, unknown>;
    if (!sig.position || typeof sig.position !== "object") continue; // skip activityRecord/wifiScan
    const pos = sig.position as Record<string, unknown>;
    const ll = parseLatLng(pos.LatLng ?? pos.latLng);
    const t = parseTime(pos.timestamp);
    if (!ll || t === null) {
      skipped++;
      continue;
    }
    if (fixSrc < 0) fixSrc = reg.idFor("raw.position", "On-device fixes");
    const accM = typeof pos.accuracyMeters === "number" ? pos.accuracyMeters : undefined;
    push({
      kind: "fix",
      sourceId: fixSrc,
      t,
      lat: ll[0],
      lon: ll[1],
      accClass: accM !== undefined ? accClassForMeters(accM) : "approx",
      accM,
      altM: typeof pos.altitudeMeters === "number" ? pos.altitudeMeters : undefined,
      speed: typeof pos.speedMetersPerSecond === "number" ? pos.speedMetersPerSecond : undefined,
      fixSource: asFixSource(pos.source),
    });
  }

  records.sort((x, y) => x.t - y.t);

  return {
    records,
    sources: reg.list(),
    profile: parseProfile(o.userLocationProfile),
    counts,
    skipped,
  };
}

/** Lift Google's precomputed `userLocationProfile` into a `LocProfile`, or `null`. */
function parseProfile(raw: unknown): LocProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;

  const frequentPlaces = (Array.isArray(p.frequentPlaces) ? p.frequentPlaces : [])
    .map((fpRaw) => {
      const fp = (fpRaw ?? {}) as Record<string, unknown>;
      const ll = parseLatLng(fp.placeLocation);
      if (!ll) return null;
      return {
        placeId: typeof fp.placeId === "string" ? fp.placeId : "",
        lat: ll[0],
        lon: ll[1],
        label: typeof fp.label === "string" ? fp.label : undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const frequentTrips = (Array.isArray(p.frequentTrips) ? p.frequentTrips : [])
    .map((ftRaw) => {
      const ft = (ftRaw ?? {}) as Record<string, unknown>;
      const modes = (Array.isArray(ft.modeDistribution) ? ft.modeDistribution : [])
        .map((mRaw) => {
          const m = (mRaw ?? {}) as Record<string, unknown>;
          if (typeof m.mode !== "string" || typeof m.rate !== "number") return null;
          return { mode: m.mode, rate: m.rate };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return {
        waypointPlaceIds: (Array.isArray(ft.waypointIds) ? ft.waypointIds : []).filter(
          (w): w is string => typeof w === "string",
        ),
        modes,
        startMinuteOfWeek: typeof ft.startTimeMinutes === "number" ? ft.startTimeMinutes : 0,
        endMinuteOfWeek: typeof ft.endTimeMinutes === "number" ? ft.endTimeMinutes : 0,
        durationMinutes: typeof ft.durationMinutes === "number" ? ft.durationMinutes : 0,
        confidence: typeof ft.confidence === "number" ? ft.confidence : 0,
        commuteDirection:
          typeof ft.commuteDirection === "string" ? ft.commuteDirection : undefined,
      };
    });

  const persona = (p.persona ?? {}) as Record<string, unknown>;
  const travelModeAffinities = (
    Array.isArray(persona.travelModeAffinities) ? persona.travelModeAffinities : []
  )
    .map((aRaw) => {
      const a = (aRaw ?? {}) as Record<string, unknown>;
      if (typeof a.mode !== "string" || typeof a.affinity !== "number") return null;
      return { mode: a.mode, affinity: a.affinity };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return { frequentPlaces, frequentTrips, travelModeAffinities };
}

/**
 * Parse any supported export. Dispatches on the detected format; legacy formats are
 * recognized but rejected with a friendly message until their importers land.
 */
export function parseLocationHistory(doc: unknown, opts: ParseOptions = {}): LocImport {
  const fmt = detectFormat(doc);
  switch (fmt) {
    case "on-device":
      return parseOnDevice(doc, opts);
    case "records":
      throw new Error(
        "This looks like a legacy Records.json export, which isn't supported yet. " +
          "Please use the on-device Timeline export from your phone's Google Maps app.",
      );
    case "semantic":
      throw new Error(
        "This looks like a legacy Semantic Location History export, which isn't " +
          "supported yet. Please use the on-device Timeline export from Google Maps.",
      );
    default:
      throw new Error(
        "Unrecognized file — expected a Google Location History Timeline export " +
          "(a JSON file with a \u201csemanticSegments\u201d list).",
      );
  }
}
