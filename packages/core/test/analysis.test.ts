import { describe, it, expect } from "vitest";
import { parseZpcr, subtractSeries, baselineCorrectCurve } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("subtractSeries", () => {
  it("subtracts element-wise", () => {
    expect(subtractSeries([10, 20, 30], [1, 2, 3])).toEqual([9, 18, 27]);
  });

  it("treats missing baseline entries as 0 and matches the length of a", () => {
    expect(subtractSeries([10, 20, 30], [1, 2])).toEqual([9, 18, 30]);
  });

  it("does not mutate inputs", () => {
    const a = [5, 6];
    const b = [1, 1];
    subtractSeries(a, b);
    expect(a).toEqual([5, 6]);
    expect(b).toEqual([1, 1]);
  });
});

describe("baselineCorrectCurve", () => {
  // Flat baseline (cycles 1-9) then an exponential rise plateauing by cycle 25.
  const cycles = Array.from({ length: 30 }, (_, i) => i + 1);
  const values = cycles.map((c) => (c <= 9 ? 100 : Math.min(5000, 100 + 5 * 2 ** (c - 9))));

  it("reports near-zero noise for a manually-pinned flat region", () => {
    const result = baselineCorrectCurve(cycles, values, "RawBaseLineSubtracted", {
      beginCycle: 1,
      endCycle: 9,
    });
    expect(result.noise).toBeCloseTo(0, 6);
  });

  it("flags a real rise as amplified with a large positive ΔRFU", () => {
    const result = baselineCorrectCurve(cycles, values, "RawBaseLineSubtracted", {
      beginCycle: 1,
      endCycle: 9,
    });
    expect(result.amplified).toBe(true);
    expect(result.deltaRfu).toBeGreaterThan(1000);
    // Baseline-subtracted: the flat region should sit near zero.
    expect(result.correctedValues[0]).toBeCloseTo(0, 3);
  });

  it("does not flag a flat, noisy curve as amplified", () => {
    const flat = cycles.map((_, i) => (i % 2 === 0 ? 99 : 101));
    const result = baselineCorrectCurve(cycles, flat, "RawBaseLineSubtracted");
    expect(result.amplified).toBe(false);
  });

  it("honors a manual baseline region override", () => {
    const result = baselineCorrectCurve(cycles, values, "RawBaseLineSubtracted", {
      beginCycle: 1,
      endCycle: 5,
    });
    expect(result.baselineRegion).toEqual({ beginCycle: 1, endCycle: 5 });
  });

  it("computes ΔRFU from raw values (no subtraction) in Raw mode", () => {
    const result = baselineCorrectCurve(cycles, values, "Raw", { beginCycle: 1, endCycle: 9 });
    expect(result.correctedValues).toEqual(values);
    // Endpoint (5000) minus the mean of the flat baseline region (100).
    expect(result.deltaRfu).toBeCloseTo(4900, 6);
  });
});

describe("darkCurves", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("returns one curve per channel, aligned with cycles", () => {
    const dark = zpcr.darkCurves();
    expect(dark).toHaveLength(6);
    for (const d of dark) {
      expect(d.cycles).toHaveLength(45);
      expect(d.mean).toHaveLength(45);
    }
  });

  it("carries the sane DARKDATA background values", () => {
    const dark = zpcr.darkCurves();
    // channel 0 dark mean at cycle 1 ≈ 2125 (see plateread DARKDATA fix)
    expect(dark[0]!.mean[0]).toBeCloseTo(2125.2, 0);
    for (const d of dark) {
      expect(d.min[0]!).toBeLessThanOrEqual(d.mean[0]!);
      expect(d.max[0]!).toBeGreaterThanOrEqual(d.mean[0]!);
    }
  });
});
