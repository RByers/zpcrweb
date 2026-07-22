import { describe, it, expect } from "vitest";
import { parseZpcr, deltaBaseline, subtractSeries } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("deltaBaseline", () => {
  it("subtracts the first value by default so the baseline becomes 0", () => {
    expect(deltaBaseline([10, 12, 15])).toEqual([0, 2, 5]);
  });

  it("supports an explicit baseline index", () => {
    expect(deltaBaseline([10, 12, 15], 1)).toEqual([-2, 0, 3]);
  });

  it("handles empty and single-element inputs", () => {
    expect(deltaBaseline([])).toEqual([]);
    expect(deltaBaseline([42])).toEqual([0]);
  });

  it("does not mutate the input", () => {
    const input = [10, 12, 15];
    deltaBaseline(input);
    expect(input).toEqual([10, 12, 15]);
  });

  it("produces the expected ΔRFU for the A3/channel-2 amplification curve", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 2 }).find((c) => c.wellLabel === "A3")!;
    const delta = deltaBaseline(curve.mean);
    expect(delta[0]).toBe(0);
    // last cycle mean ~6852.1 minus first ~4288.7 ≈ 2563
    expect(delta[44]).toBeCloseTo(6852.1 - 4288.7, 0);
  });
});

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
