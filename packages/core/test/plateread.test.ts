import { describe, it, expect } from "vitest";
import { decodePlateReadDetail, parseZpcr } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("plateread decoding", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("decodes 45 reads, each with 648 wells and 6 dark records", () => {
    expect(zpcr.reads).toHaveLength(45);
    for (const read of zpcr.reads) {
      expect(read.wells).toHaveLength(648);
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
    expect(first.get(2, 0, 2).mean).toBeCloseTo(4288.7, 0);
    expect(last.get(2, 0, 2).mean).toBeCloseTo(6852.1, 0);
  });

  it("keeps a non-amplifying channel/well flat across the run", () => {
    const first = zpcr.reads[0]!.get(0, 0, 2).mean;
    const last = zpcr.reads[44]!.get(0, 0, 2).mean;
    // channel 0 negative on 3A barely moves (~3212 -> ~3290 per the doc)
    expect(Math.abs(last - first)).toBeLessThan(150);
  });

  it("populates the reference row (row 8) with real readings", () => {
    const ref = zpcr.reads[0]!.get(0, 8, 0);
    expect(ref.mean).toBeGreaterThan(0);
  });

  it("exposes block temperature and timestamp from the header", () => {
    const last = zpcr.reads[44]!;
    // BLOCKTEMP (big-endian, from the descriptor dictionary) ≈ 60 °C — the plate read
    // happens at the 60 °C step, not the 95 °C denature.
    expect(last.blockTempC).toBeCloseTo(59.99, 1);
    expect(last.timestamp).toBe("Tue, 21 Jul 2026 06:22:23 GMT");
  });

  it("rejects out-of-range coordinates", () => {
    const read = zpcr.reads[0]!;
    expect(() => read.get(6, 0, 0)).toThrow(/channel/);
    expect(() => read.get(0, 9, 0)).toThrow(/row/);
    expect(() => read.get(0, 0, 12)).toThrow(/col/);
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
    // A .pcrd-derived PlateRead has no binary archive entry at all — DecodedPlateread.tsx
    // calls this with an empty buffer in that case, so it must never throw.
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
