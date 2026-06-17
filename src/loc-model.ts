/**
 * Location-history data model — ONE normalized record for every Google Timeline
 * data source, plus the precomputed profile Google ships alongside it.
 *
 * The export mixes four physically different shapes (a GPS path sample, an inferred
 * place visit, a travel segment, a raw on-device fix), but the map / heatmap /
 * timeline want to treat them as a single time-ordered stream. So every source
 * collapses into a `LocRecord` that ALWAYS carries the common head — kind, time,
 * location, an accuracy *class*, and its provenance — with kind-specific fields
 * kept as optionals for observability and insights.
 *
 * Two deliberate choices driven by the real data (see repo memory / plan):
 *  - Accuracy is a *class*, not just metres: only `raw.position` fixes carry a real
 *    `accuracyMeters`; path samples and inferred visit/activity centroids have none.
 *    A class ('approx'/'derived'/…) lets every record state its trust level anyway.
 *  - Provenance is never flattened away: a true GPS fix and a Google-inferred
 *    home-visit centroid render and aggregate very differently. Rather than inline
 *    the origin/device/import on every record (redundant across ~160k records), each
 *    record carries a compact `sourceId` that dereferences a rich `LocSourceDef` in
 *    the catalog — one shared dictionary entry per distinct provenance.
 */

/** The four record shapes, discriminating a `LocRecord`. */
export type LocKind =
  | "path" // a `timelinePath` sample (sparse breadcrumb)
  | "visit" // a stay at an inferred place (has dwell span)
  | "move" // a travel/`activity` segment (start→end, distance, mode)
  | "fix"; // a `rawSignals.position` reading (recent, real accuracy)

/** Where a record came from in the Google export (source correlation). */
export type LocSource = "seg.path" | "seg.visit" | "seg.activity" | "raw.position";

/**
 * Accuracy bucket. Numeric buckets describe a real `accuracyMeters`; the two
 * non-numeric classes describe data with no native accuracy at all.
 */
export type AccClass =
  | "exact" // < 10 m   (typically a GPS fix)
  | "fine" // 10–50 m
  | "coarse" // 50–200 m
  | "broad" // > 200 m
  | "derived" // an inferred visit/activity centroid — no native accuracy
  | "approx"; // a path sample — source carries no accuracy

/** Google `visit.topCandidate.semanticType` values seen in the on-device export. */
export type VisitType =
  | "HOME"
  | "WORK"
  | "INFERRED_HOME"
  | "INFERRED_WORK"
  | "SEARCHED_ADDRESS"
  | "ALIASED_LOCATION"
  | "UNKNOWN";

/** Google `activity.topCandidate.type` values seen in the on-device export. */
export type ActType =
  | "CYCLING"
  | "WALKING"
  | "RUNNING"
  | "IN_PASSENGER_VEHICLE"
  | "IN_VEHICLE"
  | "IN_BUS"
  | "IN_TRAIN"
  | "IN_SUBWAY"
  | "IN_TRAM"
  | "IN_FERRY"
  | "MOTORCYCLING"
  | "FLYING"
  | "SKIING"
  | "SAILING"
  | "UNKNOWN_ACTIVITY_TYPE";

/** Source of a raw `position` fix. */
export type FixSource = "GPS" | "WIFI" | "WIFI_ONLY" | "CELL" | "UNKNOWN";

/** Which Google export shape a record was parsed from. */
export type LocFormat = "on-device" | "records" | "semantic";

/**
 * Rich provenance for a group of records, stored once in the catalog and referenced
 * by `LocRecord.sourceId`. One entry per distinct (format × origin × device × import)
 * combination, so the per-record cost is a single small integer.
 *
 * This is the source-correlation key: it folds the Google structure a record came
 * from (`origin`), the device that produced it (when the format carries one), and
 * which import batch it arrived in — all dereferenced from one id. Extensible: new
 * provenance facets (OS, app version, …) extend this without touching the record
 * schema or the storage codec.
 */
export interface LocSourceDef {
  /** Short id referenced by `LocRecord.sourceId`. */
  id: number;
  /** Which Google export produced these records. */
  format: LocFormat;
  /** The Google structure the records came from. */
  origin: LocSource;
  /** Source device, when the export format identifies one (legacy `Records.json`). */
  device?: { tag?: number; name?: string; platform?: string };
  /** Which import batch/file these records arrived in. */
  importId?: string;
  /** When that import ran, epoch ms. */
  importedAt?: number;
  /** Human label for legends/filters, e.g. "Pixel 7 · paths". */
  label?: string;
  /** Records attributed to this source (for UI legend/filtering). */
  count?: number;
}

/**
 * One normalized location record. The first block is always present; the rest are
 * kind-specific and absent otherwise. Coordinates are decimal degrees; timestamps
 * are epoch milliseconds.
 */
export interface LocRecord {
  kind: LocKind;
  /** Dictionary key into the catalog's `LocSourceDef[]` — full provenance. */
  sourceId: number;
  /** Instant (path/fix) or span START (visit/move), epoch ms. */
  t: number;
  /** Span END for visit/move, epoch ms. */
  endT?: number;
  /** Primary point: the sample, the place centroid, the fix, or a move's start. */
  lat: number;
  lon: number;
  /** A move's END point. */
  lat2?: number;
  lon2?: number;
  /** Always set; how much to trust `lat`/`lon`. */
  accClass: AccClass;
  /** Real accuracy in metres when the source provides it (fixes only). */
  accM?: number;

  // -- visit -----------------------------------------------------------------
  semanticType?: VisitType;
  placeId?: string;

  // -- move ------------------------------------------------------------------
  actType?: ActType;
  distanceM?: number;

  // -- visit/move confidence -------------------------------------------------
  /** Google's confidence for the visit/move classification, 0–1. */
  prob?: number;

  // -- fix -------------------------------------------------------------------
  altM?: number;
  /** Ground speed, metres per second. */
  speed?: number;
  fixSource?: FixSource;
}

/** A place Google flags as frequently visited (precomputed). */
export interface FrequentPlace {
  placeId: string;
  lat: number;
  lon: number;
  /** "HOME" / "WORK" when Google labelled it. */
  label?: string;
}

/** A recurring trip Google detected (precomputed commute pattern). */
export interface FrequentTrip {
  waypointPlaceIds: string[];
  /** Dominant travel modes with their rate (0–1). */
  modes: { mode: string; rate: number }[];
  /** Minute-of-week the trip typically starts (Mon 00:00 = 0). */
  startMinuteOfWeek: number;
  /** Minute-of-week the trip typically ends. */
  endMinuteOfWeek: number;
  durationMinutes: number;
  confidence: number;
  /** "COMMUTE_DIRECTION_HOME_TO_WORK" / "..._WORK_TO_HOME" when applicable. */
  commuteDirection?: string;
}

/** Google's precomputed profile (frequent places/trips + travel persona). */
export interface LocProfile {
  frequentPlaces: FrequentPlace[];
  frequentTrips: FrequentTrip[];
  /** Travel-mode affinities (mode → 0–1 share). */
  travelModeAffinities: { mode: string; affinity: number }[];
}

/** The result of parsing one Google export. */
export interface LocImport {
  records: LocRecord[];
  /** Rich provenance defs; `LocRecord.sourceId` indexes by `id`. */
  sources: LocSourceDef[];
  profile: LocProfile | null;
  /** Per-kind tallies, for an import summary / sanity check. */
  counts: Record<LocKind, number>;
  /** Records skipped because a coordinate or time could not be parsed. */
  skipped: number;
}
