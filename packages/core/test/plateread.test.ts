import { describe, it, expect } from "vitest";
import { decodePlateReadDetail, parseZpcr } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("plateread decoding", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("decodes 45 reads, each a 6 x 9 x 12 well table plus 6 dark records", () => {
    expect(zpcr.reads).toHaveLength(45);
    for (const read of zpcr.reads) {
      expect(read.wells).toHaveLength(6);
      for (const channel of read.wells) {
        expect(channel).toHaveLength(9);
        for (const row of channel) expect(row).toHaveLength(12);
      }
      expect(read.dark).toHaveLength(6);
    }
  });

  it("decodes DARKDATA as sane background readings (correct offset)", () => {
    // Guards the DARKDATA offset: reading 4 bytes early yields the int32 count (24) as the
    // first float. Correct records have mean≈1880–2130 with min<=mean<=max and small std.
    const dark = zpcr.reads[0]!.dark;
    expect(dark[0]!.mean).toBeCloseTo(2125.2, 0);
    for (const d of dark) {
      expect(d.mean).toBeGreaterThan(1000);
      expect(d.min).toBeLessThanOrEqual(d.mean);
      expect(d.max).toBeGreaterThanOrEqual(d.mean);
      expect(d.std).toBeGreaterThan(0);
      expect(d.std).toBeLessThan(100);
    }
  });

  it("reads cycle numbers 1..45 in ascending order", () => {
    expect(zpcr.reads.map((r) => r.cycle)).toEqual(
      Array.from({ length: 45 }, (_, i) => i + 1),
    );
  });

  it("decodes the amplifying well 3A / channel 2 (verified ground truth)", () => {
    const first = zpcr.reads[0]!;
    const last = zpcr.reads[44]!;
    // well 3A = row A (0), col 3 (index 2)
    expect(first.wells[2]![0]![2]!.mean).toBeCloseTo(4288.7, 0);
    expect(last.wells[2]![0]![2]!.mean).toBeCloseTo(6852.1, 0);
  });

  it("keeps a non-amplifying channel/well flat across the run", () => {
    const first = zpcr.reads[0]!.wells[0]![0]![2]!.mean;
    const last = zpcr.reads[44]!.wells[0]![0]![2]!.mean;
    // channel 0 negative on 3A barely moves (~3212 -> ~3290 per the doc)
    expect(Math.abs(last - first)).toBeLessThan(150);
  });

  it("populates the reference row (row 8) with real readings", () => {
    const ref = zpcr.reads[0]!.wells[0]![8]![0]!;
    expect(ref.mean).toBeGreaterThan(0);
  });

  it("exposes block temperature and timestamp from the header", () => {
    const last = zpcr.reads[44]!;
    // BLOCKTEMP (big-endian, from the descriptor dictionary) ≈ 60 °C — the plate read
    // happens at the 60 °C step, not the 95 °C denature.
    expect(last.blockTempC).toBeCloseTo(59.99, 1);
    expect(last.timestamp).toBe("Tue, 21 Jul 2026 06:22:23 GMT");
  });

});

describe("PlateRead.fields — the format-neutral header table", () => {
  const zpcr = parseZpcr(readSampleBytes());
  const read = zpcr.reads[0]!;

  it("exposes the whole descriptor dictionary as key/value pairs, with ICFF provenance", () => {
    const detail = decodePlateReadDetail(zpcr.archive.bytes(read.fileName));
    expect(read.fields.map((f) => f.name)).toEqual(detail.fields.map((f) => f.name));
    expect(read.fields.every((f) => f.binary !== undefined)).toBe(true);
    const cycle = read.fields.find((f) => f.name === "CYCLE")!;
    expect(cycle.value).toBe(String(read.cycle));
    expect(cycle.binary!.offset).toBeGreaterThan(0);
  });

  it("renders untyped values by their decoded meaning: °C, text, byte counts", () => {
    const value = (name: string) => read.fields.find((f) => f.name === name)?.value;
    // A temperature reads as a temperature, not as the int32 reinterpretation of its bytes,
    // and is rounded for display (the raw float32 prints as 59.9900016784668).
    expect(value("BLOCKTEMP")).toBe(`${Number(read.blockTempC!.toFixed(2))} °C`);
    expect(value("BLOCKTEMP")).toMatch(/^\d+(\.\d{1,2})? °C$/);
    expect(value("DATETIME")).toBe(read.timestamp);
    // The bulk float arrays have no scalar value — their offsets, in `binary`, are the point.
    expect(value("WELLDATA")).toMatch(/^«\d+ B»$/);
  });

  it("reports the backing binary file, which a .pcrd-origin read has no equivalent of", () => {
    expect(read.binaryFile!.size).toBe(zpcr.archive.bytes(read.fileName).length);
    expect(read.binaryFile!.versionWords).toHaveLength(3);
  });
});

describe("decodePlateReadDetail", () => {
  it("decodes version words + fields from a real .Plateread", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const bytes = zpcr.archive.bytes(zpcr.reads[0]!.fileName);
    const detail = decodePlateReadDetail(bytes);
    expect(detail.versionWords).toHaveLength(3);
    expect(detail.fields.length).toBeGreaterThan(0);
  });

  it("degrades gracefully (no throw) on buffers too short to be a real .Plateread", () => {
    // Callers hand it whatever bytes they have; a buffer with no ICFF footer must degrade
    // rather than throw.
    expect(decodePlateReadDetail(new Uint8Array(0))).toEqual({
      size: 0,
      versionWords: [],
      fields: [],
    });
    expect(decodePlateReadDetail(new Uint8Array(11))).toEqual({
      size: 11,
      versionWords: [],
      fields: [],
    });
  });
});
