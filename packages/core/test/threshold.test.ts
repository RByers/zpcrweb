import { describe, it, expect } from "vitest";
import {
  autoThreshold,
  baselineNoise,
  baselineRegion,
  computeCq,
  isAmplified,
  parseZpcr,
  resolveThreshold,
  subtractBaseline,
} from "../src/index.js";
import { readSampleBytes } from "./sample.js";

function sigmoid(cycles: number[], onset: number, amplitude = 5000): number[] {
  return cycles.map((c) => 100 + amplitude / (1 + Math.exp(-(c - onset) * 0.5)));
}

describe("baselineNoise", () => {
  it("is zero for a perfectly flat region", () => {
    expect(baselineNoise([1, 2, 3, 4, 5], [10, 10, 10, 10, 10], { beginCycle: 1, endCycle: 5 })).toBe(0);
  });

  it("ignores a smooth trend the baseline fit missed, but not the scatter on top of it", () => {
    // A settling transient (a decaying ramp) plus a fixed ±1 jitter. A standard deviation would be
    // dominated by the ramp; successive differences see only the jitter, which is the point.
    const cycles = Array.from({ length: 20 }, (_, i) => i + 1);
    const values = cycles.map((c, i) => 60 * Math.exp(-(c - 1) / 4) + (i % 2 === 0 ? 1 : -1));
    const noise = baselineNoise(cycles, values, { beginCycle: 1, endCycle: 20 });
    expect(noise).toBeGreaterThan(0.5);
    expect(noise).toBeLessThan(3);
  });

  it("returns 0 when no cycle falls within the region", () => {
    expect(baselineNoise([1, 2, 3], [10, 20, 30], { beginCycle: 100, endCycle: 200 })).toBe(0);
  });

  it("computes a small residual noise on the real B3/channel-0 baseline region", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const region = { beginCycle: 3, endCycle: 20 };
    const corrected = subtractBaseline(curve.cycles, curve.mean, region, "LinearBaseLineNormalized");
    const noise = baselineNoise(curve.cycles, corrected, region);
    expect(noise).toBeGreaterThan(0);
    expect(noise).toBeLessThan(15);
  });
});

describe("autoThreshold", () => {
  it("is multiplier x the median of the noise estimates", () => {
    expect(autoThreshold([1, 2, 3], { multiplier: 3 })).toBeCloseTo(6, 6);
  });

  it("uses the default multiplier of 20", () => {
    expect(autoThreshold([10])).toBeCloseTo(200, 6);
  });

  it("follows the median, not one unusual well", () => {
    expect(autoThreshold([1, 1, 1, 1, 500], { multiplier: 1 })).toBeCloseTo(1, 6);
  });

  it("returns 0 when given no estimates", () => {
    expect(autoThreshold([])).toBe(0);
  });
});

describe("resolveThreshold", () => {
  it("uses the manual override when given, skipping auto entirely", () => {
    expect(resolveThreshold([1000, 2000, 3000], { overrideValue: 38.7 })).toBe(38.7);
  });

  it("falls back to autoThreshold when no override is given", () => {
    expect(resolveThreshold([1, 2, 3], { auto: { multiplier: 3 } })).toBeCloseTo(6, 6);
  });
});

describe("isAmplified", () => {
  it("is true when the total rise is well above the noise multiple", () => {
    expect(isAmplified([0, 0, 5000], 10)).toBe(true);
  });

  it("is false for a flat well whose rise is just noise", () => {
    expect(isAmplified([0, 5, -3, 2], 10)).toBe(false);
  });

  it("is false for an empty curve", () => {
    expect(isAmplified([], 10)).toBe(false);
  });
});

describe("computeCq", () => {
  const cycles = [1, 2, 3, 4, 5];

  it("interpolates linearly between the two bracketing cycles", () => {
    // Deliberately exponential data: a log interpolation would give log2(6) ≈ 2.585, and the
    // measured rule gives the linear answer instead (`threshold.md` §1.2).
    const values = cycles.map((c) => 2 ** c);
    expect(computeCq(cycles, values, 6)).toBeCloseTo(2.5, 9);
  });

  it("puts the abscissa on the cycle number, with no half-cycle offset", () => {
    expect(computeCq(cycles, [0, 0, 0, 10, 20], 5)).toBeCloseTo(3.5, 9);
  });

  it("reports no Cq when the threshold is outside the curve's range", () => {
    expect(computeCq(cycles, [50, 60, 70, 80, 90], 10)).toBeNull(); // starts above
    expect(computeCq(cycles, [1, 2, 3, 4, 5], 1000)).toBeNull(); // never reaches
    expect(computeCq([], [], 10)).toBeNull();
  });

  it("still reports a crossing that falls back below the threshold", () => {
    // The reference does: a pure-noise well that pokes above the threshold once and then declines
    // for 30 cycles is reported with a Cq (`threshold.md` §1.4's B4).
    expect(computeCq(cycles, [0, 0, 0, 50, 1], 10)).toBeCloseTo(3.2, 9);
  });

  it("ignores a crossing inside the settling cycles the baseline excludes", () => {
    // Recorded from well F1 of `20230829_135443_CT019138_SINGLE_STEP_.zpcr`: a well that never
    // amplifies, whose raw trace decays steeply over the first cycles. The baseline is fitted from
    // cycle 3 on, so cycles 1–2 are extrapolations of a line told not to model them — and here
    // they straddle the threshold, which was the only crossing on the curve and gave it a Cq of
    // 1.32.
    const f1 = [55.0, 63.9, 53.2, 27.9, 15.3, 7.3, 11.4, 7.6, 1.6, 2.8];
    const c = Array.from({ length: f1.length }, (_, i) => i + 1);
    expect(computeCq(c, f1, 57.87)).toBeNull();
    // The range test is taken over the same analysed cycles, so the excluded peak can't even make
    // the threshold look reachable.
    expect(Math.max(...f1)).toBeGreaterThan(57.87);
  });

  it("reports a crossing from cycle 3 onward normally", () => {
    const c = [1, 2, 3, 4, 5, 6];
    expect(computeCq(c, [0, 0, 0, 0, 10, 20], 5)).toBeCloseTo(4.5, 9);
  });

  it("prefers the crossing followed by the longest increasing run", () => {
    // An early noise spike over a low threshold, then the real rise: the spike's run is 0, the
    // rise's is 2, so the rise wins.
    const c = [1, 2, 3, 4, 5, 6, 7, 8];
    const cq = computeCq(c, [0, 12, 4, -2, 3, 40, 400, 4000], 10)!;
    expect(cq).toBeGreaterThan(5);
    expect(cq).toBeLessThanOrEqual(6);
  });

  it("takes the later crossing when two runs tie", () => {
    const c = [1, 2, 3, 4, 5, 6];
    // Two identical single-step excursions; the later one wins.
    expect(computeCq(c, [0, 20, 0, 0, 20, 0], 10)!).toBeGreaterThan(4);
  });

  it("ignores a crossing whose local slope is negligible", () => {
    // A curve lying flat along the threshold produces no Cq rather than an arbitrary one.
    const c = [1, 2, 3, 4];
    expect(computeCq(c, [10 - 1e-9, 10, 10, 10], 10)).toBeNull();
  });

  it("produces a plausible Cq on the real B3/channel-0 curve end to end", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const curve = zpcr.curves({ channel: 0 }).find((c) => c.wellLabel === "B3")!;
    const region = baselineRegion(curve.cycles, null);
    const corrected = subtractBaseline(curve.cycles, curve.mean, region, "LinearBaseLineNormalized");
    const threshold = autoThreshold([baselineNoise(curve.cycles, corrected, region)]);
    const cq = computeCq(curve.cycles, corrected, threshold)!;
    expect(cq).not.toBeNull();
    expect(cq).toBeGreaterThan(10);
    expect(cq).toBeLessThan(45);
  });

  it("finds the crossing on a clean sigmoid, ahead of the curve's midpoint", () => {
    const c = Array.from({ length: 40 }, (_, i) => i + 1);
    const cq = computeCq(c, sigmoid(c, 25), 200)!;
    expect(cq).toBeGreaterThan(10);
    expect(cq).toBeLessThan(25);
  });
});
