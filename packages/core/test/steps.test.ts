import { describe, it, expect } from "vitest";
import { parseZpcr } from "../src/index.js";
import { readMultistepBytes, readSampleBytes } from "./sample.js";

describe("protocol steps (multi-PLATEREAD)", () => {
  const zpcr = parseZpcr(readMultistepBytes());

  it("reads STEP from each plateread", () => {
    // Protocol has two PLATEREAD blocks: STEP 2 (2 reads) then STEP 4 (8 reads).
    expect(zpcr.reads.map((r) => r.step)).toEqual([2, 2, 4, 4, 4, 4, 4, 4, 4, 4]);
  });

  it("reports the distinct steps in order with counts", () => {
    expect(zpcr.steps()).toEqual([
      { step: 2, readCount: 2 },
      { step: 4, readCount: 8 },
    ]);
  });

  it("filters curves to a single step", () => {
    const stepA = zpcr.curves({ step: 2, channel: 0 });
    const stepB = zpcr.curves({ step: 4, channel: 0 });
    expect(stepA[0]!.cycles).toEqual([1, 2]);
    expect(stepB[0]!.cycles).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("filters dark curves to a single step", () => {
    expect(zpcr.darkCurves(2)[0]!.cycles).toHaveLength(2);
    expect(zpcr.darkCurves(4)[0]!.cycles).toHaveLength(8);
  });
});

describe("single-step protocol", () => {
  it("reports exactly one step for the 45-cycle sample", () => {
    const zpcr = parseZpcr(readSampleBytes());
    expect(zpcr.steps()).toHaveLength(1);
    expect(zpcr.steps()[0]!.readCount).toBe(45);
  });
});

describe("channel mask", () => {
  it("offers only the scanned channels (CHANNELMASK 0x81 → C1 only)", () => {
    const zpcr = parseZpcr(readMultistepBytes());
    expect(zpcr.reads[0]!.channelMask).toBe(129);
    expect(zpcr.channels()).toEqual([0]);
    expect(zpcr.metadata.channelCount).toBe(1);
  });

  it("offers all six channels for a full scan (CHANNELMASK 0x3F)", () => {
    const zpcr = parseZpcr(readSampleBytes());
    expect(zpcr.reads[0]!.channelMask).toBe(63);
    expect(zpcr.channels()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
