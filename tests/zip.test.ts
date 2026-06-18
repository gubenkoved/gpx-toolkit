import { describe, expect, it } from "vitest";

import { buildZip, crc32, rawDeflate } from "../src/zip";

// -- helpers -----------------------------------------------------------------

/** Inflate a raw DEFLATE stream (the test runner's Node has `deflate-raw`). */
async function rawInflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  bytes: Uint8Array;
}

/**
 * Minimal ZIP reader: walk the local file headers and inflate/store each entry.
 * Enough to prove `buildZip` produced a valid, readable archive.
 */
async function readZip(zip: Uint8Array): Promise<ParsedEntry[]> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const dec = new TextDecoder();
  const out: ParsedEntry[] = [];
  let pos = 0;
  while (pos + 4 <= zip.length && dv.getUint32(pos, true) === 0x04034b50) {
    const method = dv.getUint16(pos + 8, true);
    const crc = dv.getUint32(pos + 14, true);
    const compSize = dv.getUint32(pos + 18, true);
    const nameLen = dv.getUint16(pos + 26, true);
    const extraLen = dv.getUint16(pos + 28, true);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = dec.decode(zip.subarray(nameStart, nameStart + nameLen));
    const raw = zip.subarray(dataStart, dataStart + compSize);
    const bytes = method === 8 ? await rawInflate(raw) : raw.slice();
    out.push({ name, method, crc, bytes });
    pos = dataStart + compSize;
  }
  return out;
}

/** Locate the End Of Central Directory record and read the entry count. */
function eocdEntryCount(zip: Uint8Array): number {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let p = zip.length - 22; p >= 0; p--) {
    if (dv.getUint32(p, true) === 0x06054b50) return dv.getUint16(p + 10, true);
  }
  throw new Error("no EOCD record found");
}

const enc = (s: string) => new TextEncoder().encode(s);

// -- tests -------------------------------------------------------------------

describe("crc32", () => {
  it("matches the known CRC-32 of a reference string", () => {
    // CRC-32 of "The quick brown fox jumps over the lazy dog" is 0x414FA339.
    expect(crc32(enc("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("rawDeflate", () => {
  it("round-trips through raw inflate", async () => {
    const data = enc("hello hello hello hello world world world");
    const deflated = await rawDeflate(data);
    expect(Array.from(await rawInflate(deflated))).toEqual(Array.from(data));
  });
});

describe("buildZip", () => {
  it("round-trips multiple entries with correct bytes and CRCs", async () => {
    const entries = [
      { name: "a.gpx", bytes: enc("<gpx>".repeat(50)) }, // compressible → deflate
      { name: "b.gpx", bytes: enc("xyz") }, // tiny → stored
      { name: "c.gpx", bytes: enc('<trkpt lat="1" lon="2"/>'.repeat(40)) },
    ];
    const zip = await buildZip(entries);
    const parsed = await readZip(zip);

    expect(parsed.map((e) => e.name)).toEqual(["a.gpx", "b.gpx", "c.gpx"]);
    for (let i = 0; i < entries.length; i++) {
      expect(Array.from(parsed[i].bytes)).toEqual(Array.from(entries[i].bytes));
      expect(parsed[i].crc).toBe(crc32(entries[i].bytes));
    }
    // The tiny entry can't be shrunk, so it must be stored, not deflated.
    expect(parsed[1].method).toBe(0);
  });

  it("records the entry count in the EOCD", async () => {
    const zip = await buildZip([
      { name: "x.gpx", bytes: enc("one") },
      { name: "y.gpx", bytes: enc("two") },
    ]);
    expect(eocdEntryCount(zip)).toBe(2);
  });

  it("disambiguates duplicate names", async () => {
    const zip = await buildZip([
      { name: "ride.gpx", bytes: enc("first") },
      { name: "ride.gpx", bytes: enc("second") },
      { name: "ride.gpx", bytes: enc("third") },
    ]);
    const parsed = await readZip(zip);
    expect(parsed.map((e) => e.name)).toEqual(["ride.gpx", "ride (2).gpx", "ride (3).gpx"]);
    expect(Array.from(parsed[0].bytes)).toEqual(Array.from(enc("first")));
    expect(Array.from(parsed[2].bytes)).toEqual(Array.from(enc("third")));
  });

  it("handles an empty-byte entry", async () => {
    const zip = await buildZip([{ name: "empty.gpx", bytes: new Uint8Array() }]);
    const parsed = await readZip(zip);
    expect(parsed[0].method).toBe(0);
    expect(parsed[0].bytes.length).toBe(0);
    expect(parsed[0].crc).toBe(0);
  });
});
