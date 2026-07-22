import { describe, it, expect } from "vitest";
import { parseZpcr, deltaBaseline } from "../src/index.js";
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
