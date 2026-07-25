import { describe, it, expect } from "vitest";
import { decodePlateReadDetail, parseZpcr } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

function firstPlateread(): Uint8Array {
  const zpcr = parseZpcr(readSampleBytes());
  const name = zpcr.reads[44]!.fileName; // Read00045
  return zpcr.archive.bytes(name);
}

describe("ICFF index decode", () => {
  const detail = decodePlateReadDetail(firstPlateread());
  const by = new Map(detail.fields.map((f) => [f.name, f]));

  it("reads the big-endian version words", () => {
    expect(detail.versionWords).toEqual([1, 2, 0]);
  });

  it("decodes the full field set, located via the footer (not a name scan)", () => {
    expect(detail.fields).toHaveLength(42);
    for (const n of ["CYCLE", "BLOCKTEMP", "WELLDATA", "DARKDATA", "FILEPATH", "DATETIME"]) {
      expect(by.has(n)).toBe(true);
    }
    // The first field's real name is PRFILEVERSION; the ICFF magic immediately precedes it
    // in the file, which a name-anchored scan (the old approach) mistook for part of the name.
    expect(detail.fields[0]!.name).toBe("PRFILEVERSION");
    expect(by.has("ICFFPRFILEVERSION")).toBe(false);
  });

  it("locates the arrays at the documented offsets", () => {
    expect(by.get("WELLDATA")!.offset).toBe(0x1a4);
    expect(by.get("WELLDATA")!.length).toBe(10372); // int32 count + 648×16 data
    expect(by.get("DARKDATA")!.offset).toBe(0x2a28);
    expect(by.get("DARKDATA")!.length).toBe(100); // count + 6×16
  });

  it("decodes big-endian scalar values that match the protocol/RunInfo", () => {
    expect(by.get("CYCLE")!.int).toBe(45);
    expect(by.get("BLOCKTEMP")!.float).toBeCloseTo(59.99, 1);
    expect(by.get("SAMPLETEMP")!.float).toBeCloseTo(60.0, 1);
    expect(by.get("LIDTEMP")!.float).toBeCloseTo(105.1, 0); // HOTLID 105
    expect(by.get("CHANNELMASK")!.int).toBe(63);
    expect(by.get("NUMBERCOLUMNS")!.int).toBe(12);
    expect(by.get("NUMBERROWS")!.int).toBe(9); // 8 sample rows + 1 reference row
    // LED currents = LEDDACValsCal 92,97,76,123,185,161
    expect(by.get("LEDCURRENT01")!.int).toBe(92);
    expect(by.get("LEDCURRENT06")!.int).toBe(161);
  });

  it("decodes string fields", () => {
    expect(by.get("DATETIME")!.text).toBe("Tue, 21 Jul 2026 06:22:23 GMT");
    expect(by.get("HEADSERIALNUMBER")!.text).toBe("785BR13647");
    expect(by.get("FILEPATH")!.text).toContain("Read00045");
  });
});
