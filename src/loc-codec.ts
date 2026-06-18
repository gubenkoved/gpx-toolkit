/**
 * Columnar codec for a month of location-history records.
 *
 * A chunk is a struct-of-arrays: every field becomes its own column, sorted by time,
 * with the high-volume columns (time, coordinates) delta + zig-zag + varint encoded
 * via the shared `varint.ts` primitive. Struct-of-arrays + deltas compress far better
 * under gzip than an array of row objects, because adjacent values in a column are
 * highly correlated (monotonic timestamps, neighbouring coordinates).
 *
 * The encoded buffer is: `[uint32 headerLen][header JSON][binary body]`. The header is
 * plain JSON describing the chunk (counts, bbox, time span, the placeId dictionary) so
 * a chunk stays observable — you can read its shape without decoding the body. The
 * store gzips this buffer; this module is gzip-agnostic and fully lossless for the
 * things that matter (coordinates at E7, timestamps at ms, ids, enums). A few derived
 * scalars (distance, accuracy, altitude, speed, probability) are quantized to compact
 * integers, which is well below any meaningful display precision.
 */

import type { AccClass, ActType, FixSource, LocKind, LocRecord, VisitType } from "./loc-model";
import { ByteReader, ByteWriter } from "./varint";

/** Coordinate precision: E7 integers (7 decimals) — lossless vs Google's own coords. */
const COORD_FACTOR = 1e7;

// Enum orderings — index is the on-disk value. APPEND ONLY (never reorder/remove), so
// older chunks keep decoding correctly.
const KINDS: LocKind[] = ["path", "visit", "move", "fix"];
const ACC_CLASSES: AccClass[] = ["exact", "fine", "coarse", "broad", "derived", "approx"];
const VISIT_TYPES: VisitType[] = [
  "HOME",
  "WORK",
  "INFERRED_HOME",
  "INFERRED_WORK",
  "SEARCHED_ADDRESS",
  "ALIASED_LOCATION",
  "UNKNOWN",
];
const ACT_TYPES: ActType[] = [
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
];
const FIX_SOURCES: FixSource[] = ["GPS", "WIFI", "WIFI_ONLY", "CELL", "UNKNOWN"];

const idx = <T>(arr: T[], v: T | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const i = arr.indexOf(v);
  return i < 0 ? fallback : i;
};

/** Plain-JSON header describing a chunk — readable without decoding the body. */
export interface ChunkHeader {
  /** Codec format version. */
  v: number;
  /** Month key, "YYYY-MM". */
  month: string;
  /** Record count. */
  n: number;
  /** Earliest / latest timestamp in the chunk, epoch ms. */
  tMin: number;
  tMax: number;
  /** Bounding box of all primary points: [minLat, minLon, maxLat, maxLon]. */
  bbox: [number, number, number, number];
  /** Per-kind counts. */
  kinds: Record<LocKind, number>;
  /** Per-accuracy-class counts. */
  accClasses: Partial<Record<AccClass, number>>;
  /** Per-source-id counts (sourceId → count). */
  sources: Record<number, number>;
  /** Unique placeIds referenced by visits, dictionary-encoded in the body. */
  placeDict: string[];
}

const EMPTY_BBOX: [number, number, number, number] = [0, 0, 0, 0];

/** Write a sparse numeric column: count, then (recordIndexDelta, value) pairs. */
function writeSparse(
  w: ByteWriter,
  n: number,
  get: (i: number) => number | undefined,
  signed: boolean,
): void {
  const present: number[] = [];
  for (let i = 0; i < n; i++) if (get(i) !== undefined) present.push(i);
  w.uvarint(present.length);
  let prevIdx = 0;
  for (const i of present) {
    w.uvarint(i - prevIdx);
    prevIdx = i;
    const val = get(i) as number;
    if (signed) w.svarint(val);
    else w.uvarint(val);
  }
}

/** Read a sparse numeric column written by `writeSparse` into `out[index] = value`. */
function readSparse(
  r: ByteReader,
  signed: boolean,
  apply: (i: number, v: number) => void,
): void {
  const m = r.uvarint();
  let idxCur = 0;
  for (let k = 0; k < m; k++) {
    idxCur += r.uvarint();
    const v = signed ? r.svarint() : r.uvarint();
    apply(idxCur, v);
  }
}

/**
 * Encode a month's records (any order — they are sorted by time here) into the
 * length-prefixed `[header][body]` chunk buffer. Pass the per-source counts so the
 * header can carry them for quick filtering.
 */
export function encodeChunk(month: string, recordsIn: LocRecord[]): Uint8Array {
  const records = [...recordsIn].sort((a, b) => a.t - b.t);
  const n = records.length;

  // Header tallies.
  const kinds: Record<LocKind, number> = { path: 0, visit: 0, move: 0, fix: 0 };
  const accClasses: Partial<Record<AccClass, number>> = {};
  const sources: Record<number, number> = {};
  let tMin = Infinity;
  let tMax = -Infinity;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  const placeDict: string[] = [];
  const placeIndex = new Map<string, number>();
  for (const r of records) {
    kinds[r.kind]++;
    accClasses[r.accClass] = (accClasses[r.accClass] ?? 0) + 1;
    sources[r.sourceId] = (sources[r.sourceId] ?? 0) + 1;
    if (r.t < tMin) tMin = r.t;
    if (r.t > tMax) tMax = r.t;
    if (r.lat < minLat) minLat = r.lat;
    if (r.lat > maxLat) maxLat = r.lat;
    if (r.lon < minLon) minLon = r.lon;
    if (r.lon > maxLon) maxLon = r.lon;
    if (r.placeId !== undefined && !placeIndex.has(r.placeId)) {
      placeIndex.set(r.placeId, placeDict.length);
      placeDict.push(r.placeId);
    }
  }

  const header: ChunkHeader = {
    v: 1,
    month,
    n,
    tMin: n ? tMin : 0,
    tMax: n ? tMax : 0,
    bbox: n ? [minLat, minLon, maxLat, maxLon] : EMPTY_BBOX,
    kinds,
    accClasses,
    sources,
    placeDict,
  };

  const w = new ByteWriter(Math.max(64, n * 8));

  // Required columns.
  for (const r of records) w.byte(idx(KINDS, r.kind, 0));
  for (const r of records) w.byte(idx(ACC_CLASSES, r.accClass, ACC_CLASSES.length - 1));
  for (const r of records) w.uvarint(r.sourceId);
  let prevT = 0;
  for (const r of records) {
    w.svarint(r.t - prevT);
    prevT = r.t;
  }
  let prevLat = 0;
  for (const r of records) {
    const e = Math.round(r.lat * COORD_FACTOR);
    w.svarint(e - prevLat);
    prevLat = e;
  }
  let prevLon = 0;
  for (const r of records) {
    const e = Math.round(r.lon * COORD_FACTOR);
    w.svarint(e - prevLon);
    prevLon = e;
  }

  // Sparse optional columns (order must match decode).
  writeSparse(
    w,
    n,
    (i) => (records[i].endT !== undefined ? records[i].endT! - records[i].t : undefined),
    true,
  );
  writeSparse(
    w,
    n,
    (i) =>
      records[i].lat2 !== undefined
        ? Math.round(records[i].lat2! * COORD_FACTOR) -
          Math.round(records[i].lat * COORD_FACTOR)
        : undefined,
    true,
  );
  writeSparse(
    w,
    n,
    (i) =>
      records[i].lon2 !== undefined
        ? Math.round(records[i].lon2! * COORD_FACTOR) -
          Math.round(records[i].lon * COORD_FACTOR)
        : undefined,
    true,
  );
  writeSparse(
    w,
    n,
    (i) =>
      records[i].distanceM !== undefined ? Math.round(records[i].distanceM!) : undefined,
    false,
  );
  writeSparse(
    w,
    n,
    (i) => (records[i].accM !== undefined ? Math.round(records[i].accM!) : undefined),
    false,
  );
  writeSparse(
    w,
    n,
    (i) => (records[i].altM !== undefined ? Math.round(records[i].altM!) : undefined),
    true,
  );
  writeSparse(
    w,
    n,
    (i) => (records[i].speed !== undefined ? Math.round(records[i].speed! * 100) : undefined),
    false,
  );
  writeSparse(
    w,
    n,
    (i) => (records[i].prob !== undefined ? Math.round(records[i].prob! * 255) : undefined),
    false,
  );
  writeSparse(
    w,
    n,
    (i) =>
      records[i].actType !== undefined
        ? idx(ACT_TYPES, records[i].actType, ACT_TYPES.length - 1)
        : undefined,
    false,
  );
  writeSparse(
    w,
    n,
    (i) =>
      records[i].semanticType !== undefined
        ? idx(VISIT_TYPES, records[i].semanticType, VISIT_TYPES.length - 1)
        : undefined,
    false,
  );
  writeSparse(
    w,
    n,
    (i) =>
      records[i].fixSource !== undefined
        ? idx(FIX_SOURCES, records[i].fixSource, FIX_SOURCES.length - 1)
        : undefined,
    false,
  );
  writeSparse(
    w,
    n,
    (i) =>
      records[i].placeId !== undefined ? placeIndex.get(records[i].placeId!)! : undefined,
    false,
  );

  const body = w.bytes();
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.length + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  out.set(body, 4 + headerBytes.length);
  return out;
}

/** Read just the header of a chunk buffer without decoding the body. */
export function decodeHeader(buf: Uint8Array): ChunkHeader {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = dv.getUint32(0, true);
  const json = new TextDecoder().decode(buf.subarray(4, 4 + headerLen));
  return JSON.parse(json) as ChunkHeader;
}

/** Decode a chunk buffer back into its header and the full record list. */
export function decodeChunk(buf: Uint8Array): { header: ChunkHeader; records: LocRecord[] } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = dv.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(buf.subarray(4, 4 + headerLen)),
  ) as ChunkHeader;
  const n = header.n;
  const r = new ByteReader(buf.subarray(4 + headerLen));

  const recs: LocRecord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    recs[i] = {
      kind: KINDS[r.byte()] ?? "path",
      sourceId: 0,
      t: 0,
      lat: 0,
      lon: 0,
      accClass: "approx",
    };
  }
  for (let i = 0; i < n; i++) recs[i].accClass = ACC_CLASSES[r.byte()] ?? "approx";
  for (let i = 0; i < n; i++) recs[i].sourceId = r.uvarint();
  let prevT = 0;
  for (let i = 0; i < n; i++) {
    prevT += r.svarint();
    recs[i].t = prevT;
  }
  let prevLat = 0;
  for (let i = 0; i < n; i++) {
    prevLat += r.svarint();
    recs[i].lat = prevLat / COORD_FACTOR;
  }
  let prevLon = 0;
  for (let i = 0; i < n; i++) {
    prevLon += r.svarint();
    recs[i].lon = prevLon / COORD_FACTOR;
  }

  // Sparse optionals — same order as encode.
  readSparse(r, true, (i, v) => {
    recs[i].endT = recs[i].t + v;
  });
  readSparse(r, true, (i, v) => {
    recs[i].lat2 = (Math.round(recs[i].lat * COORD_FACTOR) + v) / COORD_FACTOR;
  });
  readSparse(r, true, (i, v) => {
    recs[i].lon2 = (Math.round(recs[i].lon * COORD_FACTOR) + v) / COORD_FACTOR;
  });
  readSparse(r, false, (i, v) => {
    recs[i].distanceM = v;
  });
  readSparse(r, false, (i, v) => {
    recs[i].accM = v;
  });
  readSparse(r, true, (i, v) => {
    recs[i].altM = v;
  });
  readSparse(r, false, (i, v) => {
    recs[i].speed = v / 100;
  });
  readSparse(r, false, (i, v) => {
    recs[i].prob = v / 255;
  });
  readSparse(r, false, (i, v) => {
    recs[i].actType = ACT_TYPES[v] ?? "UNKNOWN_ACTIVITY_TYPE";
  });
  readSparse(r, false, (i, v) => {
    recs[i].semanticType = VISIT_TYPES[v] ?? "UNKNOWN";
  });
  readSparse(r, false, (i, v) => {
    recs[i].fixSource = FIX_SOURCES[v] ?? "UNKNOWN";
  });
  readSparse(r, false, (i, v) => {
    recs[i].placeId = header.placeDict[v];
  });

  return { header, records: recs };
}
