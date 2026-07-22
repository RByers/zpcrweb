import { describe, it, expect } from "vitest";
import { parseZpcr, popcount } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("RunInfo.xml metadata", () => {
  const { metadata } = parseZpcr(readSampleBytes());

  it("parses the grid dimensions", () => {
    expect(metadata.numberPlateColumns).toBe(12);
    expect(metadata.numberPlateRows).toBe(8);
    expect(metadata.numberReferenceRows).toBe(1);
    expect(metadata.rowsIncludingReference).toBe(9);
  });

  it("derives channel count from the scan mask", () => {
    expect(metadata.scanMask).toBe(63);
    expect(metadata.channelCount).toBe(6);
  });

  it("parses run identity fields", () => {
    expect(metadata.blockDescription).toBe('"96FX"');
    expect(metadata.baseSerialNumber).toBe("CT019138");
    expect(metadata.identifier).toMatch(/^[0-9A-F-]{36}$/i);
  });

  it("parses the run start time into a valid Date", () => {
    expect(metadata.runStartTime).toBe("Tue, 21 Jul 2026 05:18:16 GMT");
    expect(metadata.runStartDate).toBeInstanceOf(Date);
    expect(Number.isNaN(metadata.runStartDate!.getTime())).toBe(false);
  });

  it("exposes the full raw key/value map", () => {
    expect(metadata.raw["FanControlOnTemperature"]).toBe("40");
    // Self-closing <Value /> entries decode to empty strings.
    expect(metadata.raw["SampleId"]).toBe("");
  });
});

describe("popcount", () => {
  it("counts set bits", () => {
    expect(popcount(0)).toBe(0);
    expect(popcount(63)).toBe(6);
    expect(popcount(1)).toBe(1);
    expect(popcount(0b101010)).toBe(3);
  });
});
